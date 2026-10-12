"""Bibliothèque d'un membre sur Deezer : lecture du profil public par son n°, sans identifiant
ni mot de passe Deezer (artistes favoris, albums et titres likés, playlists créées par le
membre). Le profil doit être public."""
from collections import defaultdict

from .. import deezer as api
from ..util import log, norm
from .base import IGNORED, SourceError, build, new_counts


def _all(path, first=None):
    """Toutes les pages d'une liste Deezer ; une page illisible arrête la lecture du membre
    (sinon sa liste serait incomplète sans que personne ne le sache)."""
    url, params, items = f"{api.API}{path}", {"limit": 100}, []
    data = first
    while url:
        if data is None:
            data = api._call(url, params)
            if data is None:
                raise SourceError("deezer_unavailable", "page illisible")
        items.extend(data.get("data", []))
        url, params, data = data.get("next"), None, None
    return items


def profile(uid):
    """Profil et première page d'artistes favoris ; SourceError si introuvable, privé, ou si
    Deezer ne répond pas (deezer_unavailable : nouvel essai au calcul suivant)."""
    p = api._call(f"{api.API}/user/{uid}", with_errors=True)
    if p is None:
        raise SourceError("deezer_unavailable")
    if "error" in p:
        raise SourceError("not_found" if p["error"].get("code") == 800 else "deezer_unavailable")
    if "id" not in p:
        raise SourceError("not_found")
    favs = api._call(f"{api.API}/user/{uid}/artists", {"limit": 100}, with_errors=True)
    if favs is None:
        raise SourceError("deezer_unavailable")
    if "error" in favs:
        raise SourceError("private_profile")
    return p, favs


def read(uid, settings, previous):
    """Liste d'artistes du membre (library.base.build) à partir de son profil Deezer."""
    log("  Deezer : lecture du profil")
    _, first = profile(uid)

    counts = defaultdict(new_counts)
    meta = {}
    added = {}  # date du like le plus récent (favori, album, titre ou ajout en playlist)

    def note_added(aid, item):
        ts = item.get("time_add")
        if aid and isinstance(ts, (int, float)) and ts > added.get(aid, 0):
            added[aid] = ts

    def remember(artist):
        if artist and artist.get("id") and norm(artist.get("name")) not in IGNORED:
            aid = str(artist["id"])
            meta.setdefault(aid, {"name": artist.get("name", ""),
                                  "link": artist.get("link") or f"https://www.deezer.com/artist/{aid}",
                                  "picture": artist.get("picture_medium"), "deezer_id": aid})
            if not meta[aid].get("picture") and artist.get("picture_medium"):
                meta[aid]["picture"] = artist["picture_medium"]
            return aid
        return None

    favs = _all(f"/user/{uid}/artists", first)
    for a in favs:
        aid = remember(a)
        note_added(aid, a)
        if aid:
            counts[aid]["favorite"] = True

    albums = _all(f"/user/{uid}/albums")
    for al in albums:
        aid = remember(al.get("artist"))
        note_added(aid, al)
        if aid:
            counts[aid]["albums"] += 1

    tracks = _all(f"/user/{uid}/tracks")
    for t in tracks:
        aid = remember(t.get("artist"))
        note_added(aid, t)
        if aid:
            counts[aid]["tracks"] += 1
    log(f"  {len(favs)} artistes favoris, {len(albums)} albums likés, {len(tracks)} titres likés")

    if settings.get("include_own_playlists"):
        playlists = _all(f"/user/{uid}/playlists")
        own = [p for p in playlists
               if str((p.get("creator") or {}).get("id")) == str(uid) and not p.get("is_loved_track")]
        n = 0
        for p in own:
            for t in _all(f"/playlist/{p['id']}/tracks"):
                aid = remember(t.get("artist"))
                note_added(aid, t)
                if aid:
                    counts[aid]["playlists"] += 1
                    n += 1
        log(f"  {len(own)} playlists personnelles, {n} titres")

    result = build(counts, meta, added, previous, settings, "deezer")
    new = sum(1 for a in result.values() if a["first_seen"] == a["last_seen"] and a["still_liked"])
    log(f"  {len(result)} artistes au total, dont {new} nouveaux")
    return result
