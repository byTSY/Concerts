"""Données des membres côté traitement : seul module qui lit ou écrit les tables personnelles
de D1 et le préfixe R2 users/<id>/. Chaque requête porte sur un membre désigné par son
identifiant ; les journaux ne citent que cet identifiant et des compteurs."""
import json
import secrets
import string
from datetime import datetime, timezone

from .util import norm

FILES = ("artists", "overlay", "history", "meta")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id():
    alphabet = string.ascii_lowercase + string.digits
    return "u_" + "".join(secrets.choice(alphabet) for _ in range(8))


# --- Membres et sources ------------------------------------------------------------

def active(db):
    """Membres à calculer : statut active ou error, avec leur source musicale."""
    return db.query(
        "SELECT u.id, u.role, u.status, s.provider, s.provider_user_id, s.status AS source_status "
        "FROM users u JOIN music_sources s ON s.user_id = u.id "
        "WHERE u.status IN ('active', 'error') ORDER BY u.invited_at")


def record_sync(db, user_id, ok, error_code=None):
    now = now_iso()
    db.query("UPDATE music_sources SET last_sync_at = ?, last_sync_status = ? WHERE user_id = ?",
             [now, "ok" if ok else (error_code or "error"), user_id])
    if ok:
        db.query("UPDATE users SET status = 'active', error_message = NULL, "
                 "activated_at = COALESCE(activated_at, ?) WHERE id = ? AND status IN ('computing', 'error', 'active')",
                 [now, user_id])
    else:
        db.query("UPDATE users SET status = 'error', error_message = ? WHERE id = ? AND status <> 'suspended'",
                 [error_code or "error", user_id])


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


# --- Reprise de l'existant (src/migrate.py) ----------------------------------------------

def upsert_admin(db, email, first_name):
    """Crée le compte admin s'il n'existe pas ; renvoie son identifiant."""
    email = email.strip().lower()
    row = db.query("SELECT id FROM users WHERE email = ?", [email])
    if row:
        db.query("UPDATE users SET role = 'admin', first_name = ? WHERE id = ?", [first_name, row[0]["id"]])
        return row[0]["id"]
    uid = new_id()
    now = now_iso()
    db.query("INSERT INTO users (id, email, first_name, role, status, invited_at, activated_at) "
             "VALUES (?, ?, ?, 'admin', 'active', ?, ?)", [uid, email, first_name, now, now])
    return uid


def set_deezer_source(db, user_id, deezer_id, name=None):
    db.query("INSERT INTO music_sources (user_id, provider, provider_user_id, provider_name, status, connected_at) "
             "VALUES (?, 'deezer', ?, ?, 'connected', ?) "
             "ON CONFLICT (user_id) DO UPDATE SET provider = 'deezer', provider_user_id = excluded.provider_user_id, "
             "provider_name = excluded.provider_name, status = 'connected', refresh_token_enc = NULL, scopes = NULL",
             [user_id, str(deezer_id), name, now_iso()])


def replace_prefs(db, user_id, hidden_names, levels):
    """Remplace toutes les préférences du membre (reprise de config/artist_prefs.yaml)."""
    rows = {}
    for name in hidden_names:
        if norm(name):
            rows.setdefault(norm(name), {"name": name, "hidden": 1, "level": None})["hidden"] = 1
    for name, level in levels.items():
        if norm(name) and str(level) in {"1", "2", "3"}:
            rows.setdefault(norm(name), {"name": name, "hidden": 0, "level": None})["level"] = int(level)
    db.query("DELETE FROM artist_prefs WHERE user_id = ?", [user_id])
    now = now_iso()
    for key, r in rows.items():
        db.query("INSERT INTO artist_prefs (user_id, artist_key, artist_name, hidden, level, updated_at) "
                 "VALUES (?, ?, ?, ?, ?, ?)", [user_id, key, r["name"], r["hidden"], r["level"], now])
    return len(rows)


def replace_stars(db, user_id, starred):
    """starred : {identifiant du concert: libellé} ; ★ privés, statut « intéressé »."""
    db.query("DELETE FROM stars WHERE user_id = ?", [user_id])
    now = now_iso()
    for cid, label in starred.items():
        db.query("INSERT INTO stars (user_id, concert_id, label, status, visibility, created_at, updated_at) "
                 "VALUES (?, ?, ?, 'interested', 'private', ?, ?)", [user_id, str(cid), label or "", now, now])
    return len(starred)


def replace_favorite_venues(db, user_id, venue_ids):
    db.query("DELETE FROM venue_favorites WHERE user_id = ?", [user_id])
    now = now_iso()
    for vid in venue_ids:
        db.query("INSERT INTO venue_favorites (user_id, venue_id, added_at) VALUES (?, ?, ?)", [user_id, vid, now])
    return len(venue_ids)


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
