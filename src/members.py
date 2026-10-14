"""Données des membres côté traitement : seul module qui lit ou écrit les tables personnelles
de D1 et le préfixe R2 users/<id>/. Chaque requête porte sur un membre désigné par son
identifiant ; les journaux ne citent que cet identifiant et des compteurs."""
import json
import time
from datetime import datetime, timedelta, timezone

from .cloud import CloudError
from .util import log

FILES = ("artists", "overlay", "history", "meta")
MEMBER_ID = r"^u_[a-z0-9]{8}$"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_in(seconds):
    """Heure UTC dans seconds secondes, au format de now_iso (comparaisons de textes en SQL)."""
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


# Erreurs passagères : nouvel essai automatique du calcul, espacé (1 h, 3 h, 8 h, 24 h), puis
# plus rien avant le traitement du lundi. Les autres erreurs attendent une action (membre, admin).
TRANSIENT = {"quota", "spotify_unavailable", "deezer_unavailable", "internal"}
RETRY_DELAYS_H = (1, 3, 8, 24)


# --- Membres et sources ------------------------------------------------------------

_SELECT = ("SELECT u.id, u.role, u.status, u.activated_at, s.provider, s.provider_user_id, s.status AS source_status, "
           "s.last_sync_at, s.last_sync_status, s.sync_requested_at, s.retry_at, s.retry_count, s.library_read_at "
           "FROM users u JOIN music_sources s ON s.user_id = u.id ")


def active(db):
    """Membres calculés chaque semaine : statut active, error ou computing, source reliée."""
    return db.query(_SELECT + "WHERE u.status IN ('active', 'error', 'computing') AND s.status = 'connected' "
                    "ORDER BY u.invited_at")


def pending(db, now=None):
    """Membres qui attendent un calcul : arrivée, changement de source, « Synchroniser
    maintenant » ou relance par l'admin (demande postérieure au dernier calcul), ou nouvel essai
    automatique arrivé à échéance après une erreur passagère (retry_at)."""
    return db.query(_SELECT + "WHERE u.status IN ('active', 'error', 'computing') AND s.status = 'connected' "
                    "AND (u.status = 'computing' OR s.sync_requested_at > COALESCE(s.last_sync_at, '') "
                    "OR (s.retry_at IS NOT NULL AND s.retry_at <= ?)) "
                    "ORDER BY s.sync_requested_at", [now or now_iso()])


def explicit_request(m):
    """Calcul demandé (arrivée, membre, admin) depuis le dernier calcul : lecture complète."""
    return m.get("status") == "computing" or (m.get("sync_requested_at") or "") > (m.get("last_sync_at") or "")


def by_ids(db, ids):
    """Membres désignés (relance manuelle), s'ils peuvent être calculés."""
    rows = active(db)
    return [m for m in rows if m["id"] in set(ids)]


def still_current(db, user_id, provider, provider_user_id):
    """Le membre existe toujours, avec la même source et un statut calculable (il a pu être
    supprimé, suspendu ou changer de source pendant le calcul)."""
    return bool(db.query(
        "SELECT 1 FROM users u JOIN music_sources s ON s.user_id = u.id WHERE u.id = ? "
        "AND u.status IN ('active', 'error', 'computing') AND s.status = 'connected' "
        "AND s.provider = ? AND s.provider_user_id = ?", [user_id, provider, str(provider_user_id)]))


def delete_files(store, user_id):
    assert user_id.startswith("u_")
    for key in store.list(f"users/{user_id}/"):
        store.delete(key)


def last_collection(db):
    """Fin de la dernière collecte réussie (tâche commune), ou None."""
    rows = db.query("SELECT MAX(ended_at) AS t FROM runs WHERE kind = 'weekly' AND sources IS NOT NULL AND status = 'ok'")
    return rows[0]["t"] if rows else None


class SpotifyAccess:
    """Jeton de rafraîchissement Spotify du membre, chiffré (src/library/spotify.py le
    déchiffre) ; remplacé quand Spotify en renvoie un nouveau."""

    def __init__(self, db, user_id):
        self.db, self.user_id = db, user_id
        self.read = None   # jeton lu au début du calcul
        self.lost = False  # jeton renouvelé par Spotify mais non enregistré (admin prévenu)

    def token(self):
        rows = self.db.query("SELECT refresh_token_enc FROM music_sources WHERE user_id = ? AND provider = 'spotify'",
                             [self.user_id])
        self.read = rows[0]["refresh_token_enc"] if rows else None
        return self.read

    def replace(self, token_enc, pauses=(2, 5, 15)):
        """Nouveau jeton renvoyé par Spotify : l'ancien peut ne plus servir, l'écriture doit donc
        aboutir. Seulement si le membre ne s'est pas reconnecté entre-temps (nouveau jeton déjà
        enregistré). Mise à jour conditionnelle, sans risque à refaire après une erreur réseau,
        vérifiée par une relecture. Renvoie False si le jeton n'a pas pu être enregistré."""
        old = self.read
        for attempt in range(len(pauses) + 1):
            try:
                self.db.query("UPDATE music_sources SET refresh_token_enc = ? WHERE user_id = ? AND provider = 'spotify' "
                              "AND refresh_token_enc = ?", [token_enc, self.user_id, old])
                rows = self.db.query("SELECT refresh_token_enc FROM music_sources WHERE user_id = ? AND provider = 'spotify'",
                                     [self.user_id])
                current = rows[0]["refresh_token_enc"] if rows else None
                if current != old:  # enregistré, ou membre reconnecté entre-temps
                    self.read = current
                    return True
            except CloudError as exc:
                log(f"  Spotify : jeton renouvelé non enregistré ({exc.__class__.__name__}), nouvel essai")
            if attempt < len(pauses):
                time.sleep(pauses[attempt])
        self.read = token_enc   # gardé pour la suite du calcul
        self.lost = True
        log("  Spotify : ATTENTION, jeton renouvelé non enregistré en base")
        return False

    def revoke(self):
        """Accès retiré ou expiré : jeton effacé et source en revoked, sauf si le membre s'est
        reconnecté pendant le calcul. Renvoie False dans ce cas."""
        rows = self.db.query("UPDATE music_sources SET status = 'revoked', refresh_token_enc = NULL "
                             "WHERE user_id = ? AND provider = 'spotify' AND refresh_token_enc = ? RETURNING user_id",
                             [self.user_id, self.read])
        return bool(rows)


def next_retry(error_code, retry_count, not_before=None):
    """(retry_at, retry_count) après un calcul en erreur : nouvel essai automatique pour une
    erreur passagère, pas avant not_before (fin de pause du service) ; (None, retry_count) au-delà
    de 4 essais ou pour une erreur qui attend une action."""
    if error_code not in TRANSIENT or retry_count >= len(RETRY_DELAYS_H):
        return None, retry_count
    at = iso_in(RETRY_DELAYS_H[retry_count] * 3600)
    if not_before and not_before > at:
        at = not_before
    return at, retry_count + 1


def record_sync(db, user_id, ok, error_code=None, started_at=None, retry=(None, 0), library_read=False):
    """last_sync_at reçoit l'heure de début du calcul : une demande faite pendant le calcul
    (« Synchroniser maintenant », « Recalculer ») reste en attente, le calcul ayant lu la
    bibliothèque avant elle. retry : (retry_at, retry_count) de next_retry, remis à zéro après un
    calcul réussi. library_read : bibliothèque Spotify lue pendant ce calcul."""
    now = now_iso()
    retry_at, retry_count = (None, 0) if ok else retry
    db.query("UPDATE music_sources SET last_sync_at = ?, last_sync_status = ?, retry_at = ?, retry_count = ?, "
             "library_read_at = CASE WHEN ? THEN ? ELSE library_read_at END WHERE user_id = ?",
             [started_at or now, "ok" if ok else (error_code or "error"), retry_at, retry_count,
              1 if library_read else 0, started_at or now, user_id])
    if ok:
        db.query("UPDATE users SET status = 'active', error_message = NULL, "
                 "activated_at = COALESCE(activated_at, ?) WHERE id = ? AND status IN ('computing', 'error', 'active')",
                 [now, user_id])
    else:
        db.query("UPDATE users SET status = 'error', error_message = ? WHERE id = ? "
                 "AND status IN ('computing', 'error', 'active')", [error_code or "error", user_id])


# --- Pause d'un service extérieur (quota Spotify) ---------------------------------------

def service_pause(db, service):
    """Fin de la pause en cours du service (texte ISO), ou None."""
    rows = db.query("SELECT until FROM service_pauses WHERE service = ? AND until > ?", [service, now_iso()])
    return rows[0]["until"] if rows else None


def set_service_pause(db, service, until, reason):
    """Pause du service jusqu'à until (jamais raccourcie). Renvoie vrai si la pause est nouvelle
    ou prolongée."""
    rows = db.query("INSERT INTO service_pauses (service, until, reason, created_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (service) DO UPDATE SET until = excluded.until, reason = excluded.reason, "
                    "created_at = excluded.created_at WHERE excluded.until > service_pauses.until RETURNING service",
                    [service, until, reason, now_iso()])
    return bool(rows)


# --- Traitements (runs, member_runs) : identifiants, statuts et codes d'erreur seulement ----

def start_run(db, kind):
    rows = db.query("INSERT INTO runs (kind, started_at, status) VALUES (?, ?, 'running') RETURNING id",
                    [kind, now_iso()])
    return rows[0]["id"]


def end_run(db, run_id, status, sources=None):
    db.query("UPDATE runs SET ended_at = ?, status = ?, sources = COALESCE(?, sources) WHERE id = ?",
             [now_iso(), status, json.dumps(sources, ensure_ascii=False) if sources is not None else None, run_id])


def record_member_run(db, run_id, user_id, provider, ok, error_code, duration_s):
    db.query("INSERT OR REPLACE INTO member_runs (run_id, user_id, provider, status, error_code, duration_s) "
             "VALUES (?, ?, ?, ?, ?, ?)",
             [run_id, user_id, provider, "ok" if ok else "error", error_code, round(duration_s, 1)])


# --- Préférences et salles favorites ---------------------------------------------------

def prefs(db, user_id):
    """{"hidden": {clé: nom}, "levels": {clé: niveau}} ; clés = noms normalisés."""
    rows = db.query("SELECT artist_key, artist_name, hidden, level FROM artist_prefs WHERE user_id = ?", [user_id])
    return {
        "hidden": {r["artist_key"]: r["artist_name"] for r in rows if r["hidden"]},
        "levels": {r["artist_key"]: int(r["level"]) for r in rows if r["level"] in (1, 2, 3)},
    }


def favorite_venues(db, user_id):
    return {r["venue_id"] for r in db.query("SELECT venue_id FROM venue_favorites WHERE user_id = ?", [user_id])}


def all_star_ids(db):
    """Concerts mis de côté par au moins un membre (choix de l'identifiant lors d'une fusion)."""
    return {r["concert_id"] for r in db.query("SELECT DISTINCT concert_id FROM stars")}


# --- Résultats calculés (R2) -------------------------------------------------------------

def _key(user_id, name):
    assert name in FILES and user_id.startswith("u_")
    return f"users/{user_id}/{name}.json"


def read(store, user_id, name, default=None):
    return store.get_json(_key(user_id, name), default)


def write(store, user_id, name, value):
    store.put_json(_key(user_id, name), value)


class QuotaError(RuntimeError):
    pass


def check_quota(store, user_id, files, settings):
    """Garde-fou de volume R2 (offre gratuite : 10 Go pour tout le compte), vérifié avant
    d'écrire les fichiers d'un membre : chaque fichier sous r2_member_file_max_mb, et le
    compartiment, une fois ces fichiers remplacés, sous r2_bucket_max_mb. Rien n'est écrit
    en cas de dépassement. Renvoie le volume prévu, en octets."""
    file_max = settings["r2_member_file_max_mb"] * 1024 * 1024
    bucket_max = settings["r2_bucket_max_mb"] * 1024 * 1024
    new = {_key(user_id, name): dumps_size(value) for name, value in files.items()}
    for key, size in new.items():
        if size > file_max:
            raise QuotaError(f"{key.rsplit('/', 1)[-1]} : {size / 1048576:.1f} Mo, au-delà du plafond de "
                             f"{settings['r2_member_file_max_mb']} Mo par fichier")
    current = store.sizes()
    total = sum(n for k, n in current.items() if k not in new) + sum(new.values())
    if total > bucket_max:
        raise QuotaError(f"stockage prévu {total / 1048576:.1f} Mo, au-delà du plafond de "
                         f"{settings['r2_bucket_max_mb']} Mo")
    return total


def dumps_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
