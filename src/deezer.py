"""Extraction des favoris Deezer, score d'affinité par artiste, artistes similaires."""
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from .util import ARTICLES, CACHE, DATA, get_json, load_json, log, norm, save_json, today_iso

API = "https://api.deezer.com"
PAUSE = 0.12  # Deezer tolère c. 50 requêtes par 5 secondes
# Artistes génériques des compilations : pas de vrais artistes, à ne pas suivre
IGNORED = {"various artists", "artistes divers", "multi interpretes", "verschiedene interpreten"}


def _call(url, params=None):
    """Appel Deezer avec gestion du dépassement de quota (erreur code 4)."""
    for _ in range(4):
        data = get_json(url, params=params, pause=PAUSE)
        if isinstance(data, dict) and "error" in data:
            err = data["error"]
            if err.get("code") == 4:  # quota dépassé
                time.sleep(6)
                continue
            log(f"  Deezer : {err.get('type')} {err.get('message')} ({url})")
            return None
        return data
    return None


def _paginate(path):
    """Parcourt toutes les pages d'une liste Deezer."""
    url, params, items = f"{API}{path}", {"limit": 100}, []
    while url:
        data = _call(url, params)
        if not data:
            break
        items.extend(data.get("data", []))
        url, params = data.get("next"), None
    return items


def refresh_artists(settings):
    """Recalcule la liste d'artistes à partir des favoris et l'ajoute à l'historique."""
    uid = settings["deezer_user_id"]
    sc = settings["scoring"]
    log(f"Deezer : lecture du profil {uid}")

    profile = _call(f"{API}/user/{uid}")
    if not profile or "id" not in profile:
        raise SystemExit("Profil Deezer introuvable ou privé : vérifiez deezer_user_id et la visibilité du profil.")

    counts = defaultdict(lambda: {"favorite": False, "albums": 0, "tracks": 0, "playlists": 0})
    meta = {}
    added = {}  # date du like le plus récent (favori, album, titre ou ajout en playlist), horodatage Deezer

    def note_added(aid, item):
        ts = item.get("time_add")
        if aid and isinstance(ts, (int, float)) and ts > added.get(aid, 0):
            added[aid] = ts

    def remember(artist):
        if artist and artist.get("id") and norm(artist.get("name")) not in IGNORED:
            aid = str(artist["id"])
            meta.setdefault(aid, {"name": artist.get("name", ""), "link": artist.get("link"),
                                  "picture": artist.get("picture_medium")})
            if not meta[aid].get("picture") and artist.get("picture_medium"):
                meta[aid]["picture"] = artist["picture_medium"]
            return aid
        return None

    favs = _paginate(f"/user/{uid}/artists")
    for a in favs:
        aid = remember(a)
        note_added(aid, a)
        if aid:
            counts[aid]["favorite"] = True
    log(f"  {len(favs)} artistes favoris")

    albums = _paginate(f"/user/{uid}/albums")
    for al in albums:
        aid = remember(al.get("artist"))
        note_added(aid, al)
        if aid:
            counts[aid]["albums"] += 1
    log(f"  {len(albums)} albums likés")

    tracks = _paginate(f"/user/{uid}/tracks")
    for t in tracks:
        aid = remember(t.get("artist"))
        note_added(aid, t)
        if aid:
            counts[aid]["tracks"] += 1
    log(f"  {len(tracks)} titres likés")

    if settings.get("include_own_playlists"):
        playlists = _paginate(f"/user/{uid}/playlists")
        own = [p for p in playlists
               if str((p.get("creator") or {}).get("id")) == str(uid) and not p.get("is_loved_track")]
        n = 0
        for p in own:
            for t in _paginate(f"/playlist/{p['id']}/tracks"):
                aid = remember(t.get("artist"))
                note_added(aid, t)
                if aid:
                    counts[aid]["playlists"] += 1
                    n += 1
        log(f"  {len(own)} playlists personnelles, {n} titres")

    previous = load_json(DATA / "artists.json", {})
    today = today_iso()
    result = {}

    for aid, c in counts.items():
        score = (sc["favorite_artist"] * c["favorite"] + sc["liked_album"] * c["albums"]
                 + sc["liked_track"] * c["tracks"] + sc["playlist_track"] * c["playlists"])
        tier = 1 if score >= sc["tier1_min"] else 2 if score >= sc["tier2_min"] else 3
        old = previous.get(aid, {})
        result[aid] = {
            "id": aid,
            "name": meta[aid]["name"],
            "key": norm(meta[aid]["name"]),
            "link": meta[aid].get("link") or f"https://www.deezer.com/artist/{aid}",
            "picture": meta[aid].get("picture"),
            "score": round(score, 2),
            "tier": tier,
            "sources": c,
            "first_seen": old.get("first_seen", today),
            "added": (datetime.fromtimestamp(added[aid], timezone.utc).date().isoformat()
                      if aid in added else old.get("added")),
            "last_seen": today,
            "still_liked": True,
        }

    # Les artistes retirés de vos favoris restent dans la liste, signalés comme tels
    for aid, old in previous.items():
        if aid not in result and norm(old.get("name")) not in IGNORED:
            old["still_liked"] = False
            result[aid] = old

    new = [a for a in result.values() if a["first_seen"] == today and a["still_liked"]]
    log(f"  {len(result)} artistes au total, dont {len(new)} nouveaux cette semaine")
    save_json(DATA / "artists.json", result)
    return result


# --- Recherche et artistes similaires, avec cache ------------------------------

def search_artist(name, cache):
    """Identifiant Deezer d'un nom d'artiste (correspondance exacte du nom normalisé)."""
    key = norm(name)
    if key in cache:
        return cache[key]
    data = _call(f"{API}/search/artist", {"q": name, "limit": 10})
    found = None
    if data:
        bare = ARTICLES.sub("", key)
        exact = [a for a in data.get("data", []) if ARTICLES.sub("", norm(a.get("name"))) == bare]
        if exact:
            best = max(exact, key=lambda a: a.get("nb_fan", 0))
            found = {"id": str(best["id"]), "name": best["name"], "link": best.get("link"),
                     "picture": best.get("picture_medium"), "fans": best.get("nb_fan", 0)}
    cache[key] = found
    return found


def related(artist_id, cache, refresh_days):
    """Liste des identifiants d'artistes similaires selon Deezer."""
    entry = cache.get(str(artist_id))
    limit_date = (date.today() - timedelta(days=refresh_days)).isoformat()
    if entry and entry.get("fetched", "") >= limit_date:
        return entry["ids"]
    data = _call(f"{API}/artist/{artist_id}/related", {"limit": 50})
    ids = [str(a["id"]) for a in (data or {}).get("data", [])]
    names = {str(a["id"]): a.get("name") for a in (data or {}).get("data", [])}
    cache[str(artist_id)] = {"fetched": today_iso(), "ids": ids, "names": names}
    return ids


def load_caches():
    return (load_json(CACHE / "search.json", {}), load_json(CACHE / "related.json", {}))


def save_caches(search_cache, related_cache):
    save_json(CACHE / "search.json", search_cache)
    save_json(CACHE / "related.json", related_cache)
