"""Données des membres côté traitement : seul module qui lit ou écrit les tables personnelles
de D1 et le préfixe R2 users/<id>/. Chaque requête porte sur un membre désigné par son
identifiant ; les journaux ne citent que cet identifiant et des compteurs."""
import json
from datetime import datetime, timezone

FILES = ("artists", "overlay", "history", "meta")
MEMBER_ID = r"^u_[a-z0-9]{8}$"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --- Membres et sources ------------------------------------------------------------

_SELECT = ("SELECT u.id, u.role, u.status, s.provider, s.provider_user_id, s.status AS source_status, "
           "s.last_sync_at, s.sync_requested_at "
           "FROM users u JOIN music_sources s ON s.user_id = u.id ")


def active(db):
    """Membres calculés chaque semaine : statut active, error ou computing, source reliée."""
    return db.query(_SELECT + "WHERE u.status IN ('active', 'error', 'computing') AND s.status = 'connected' "
                    "ORDER BY u.invited_at")


def pending(db):
    """Membres qui attendent un calcul : arrivée, changement de source, « Synchroniser
    maintenant » ou relance par l'admin (demande postérieure au dernier calcul)."""
    return db.query(_SELECT + "WHERE u.status IN ('active', 'error', 'computing') AND s.status = 'connected' "
                    "AND (u.status = 'computing' OR s.sync_requested_at > COALESCE(s.last_sync_at, '')) "
                    "ORDER BY s.sync_requested_at")


def by_ids(db, ids):
    """Membres désignés (relance manuelle), s'ils peuvent être calculés."""
    rows = active(db)
    return [m for m in rows if m["id"] in set(ids)]


def record_sync(db, user_id, ok, error_code=None):
    now = now_iso()
    db.query("UPDATE music_sources SET last_sync_at = ?, last_sync_status = ? WHERE user_id = ?",
             [now, "ok" if ok else (error_code or "error"), user_id])
    if ok:
        db.query("UPDATE users SET status = 'active', error_message = NULL, "
                 "activated_at = COALESCE(activated_at, ?) WHERE id = ? AND status IN ('computing', 'error', 'active')",
                 [now, user_id])
    else:
        db.query("UPDATE users SET status = 'error', error_message = ? WHERE id = ? "
                 "AND status IN ('computing', 'error', 'active')", [error_code or "error", user_id])


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


def stars(db, user_id):
    return db.query("SELECT concert_id, label, status, visibility FROM stars WHERE user_id = ?", [user_id])


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
