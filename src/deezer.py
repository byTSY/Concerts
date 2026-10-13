"""API Deezer commune : appels avec gestion du quota, recherche d'artistes et artistes similaires
(caches communs à tous les membres). La lecture du profil d'un membre est dans src/library/deezer.py."""
import time
from datetime import date, timedelta

from .util import ARTICLES, CACHE, get_json, load_json, log, norm, redact, save_json, today_iso

API = "https://api.deezer.com"
PAUSE = 0.12  # Deezer tolère c. 50 requêtes par 5 secondes


def _call(url, params=None, with_errors=False):
    """Appel Deezer avec gestion du dépassement de quota (erreur code 4).

    Renvoie None si Deezer ne répond pas (réseau, quota toujours dépassé) ; pour une erreur
    renvoyée par Deezer (profil introuvable, privé…), None aussi, ou {"error": …} si
    with_errors : l'appelant distingue alors une panne d'un refus."""
    for _ in range(4):
        data = get_json(url, params=params, pause=PAUSE)
        if isinstance(data, dict) and "error" in data:
            err = data["error"]
            if err.get("code") == 4:  # quota dépassé
                time.sleep(6)
                continue
            log(f"  Deezer : {err.get('type')} {err.get('message')} ({redact(url)})")
            return {"error": err} if with_errors else None
        return data
    return None


def search_artist(name, cache):
    """Identifiant Deezer d'un nom d'artiste (correspondance exacte du nom normalisé)."""
    key = norm(name)
    if key in cache:
        return cache[key]
    data = _call(f"{API}/search/artist", {"q": name, "limit": 10})
    if data is None:
        return None  # Deezer ne répond pas : pas de mise en cache, nouvel essai au prochain calcul
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
