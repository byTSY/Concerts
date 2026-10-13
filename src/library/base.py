"""Bibliothèque musicale d'un membre, quelle que soit sa source (Deezer, Spotify) : structure
commune par artiste, calcul du score et du niveau, suivi d'une semaine à l'autre."""
from datetime import datetime, timezone

from ..util import norm, today_iso

# Artistes génériques des compilations : pas de vrais artistes, à ne pas suivre
IGNORED = {"various artists", "artistes divers", "multi interpretes", "verschiedene interpreten"}


class SourceError(Exception):
    """Erreur propre à la source d'un membre ; le traitement passe au membre suivant.

    Codes : private_profile, not_found, revoked, not_allowlisted, quota, spotify_unavailable,
    deezer_unavailable, token_key (clé de chiffrement absente ou changée), spotify_unconfigured."""

    def __init__(self, code, detail=""):
        super().__init__(f"{code}{f' ({detail})' if detail else ''}")
        self.code = code


def new_counts():
    return {"favorite": False, "albums": 0, "tracks": 0, "playlists": 0, "top": 0}


def build(counts, meta, added, previous, settings, provider):
    """Liste d'artistes du membre.

    counts : {id: compteurs (new_counts)} ; meta : {id: {name, link, picture}} ;
    added : {id: horodatage du like le plus récent} ; previous : liste du calcul précédent.
    Un artiste retiré des favoris reste suivi, signalé still_liked = False."""
    sc = settings["scoring"]
    today = today_iso()
    result = {}
    for aid, c in counts.items():
        score = (sc["favorite_artist"] * c["favorite"] + sc["liked_album"] * c["albums"]
                 + sc["liked_track"] * c["tracks"] + sc["playlist_track"] * c["playlists"]
                 + sc.get("top_artist", 0) * c.get("top", 0))
        tier = 1 if score >= sc["tier1_min"] else 2 if score >= sc["tier2_min"] else 3
        old = previous.get(aid, {})
        result[aid] = {
            "id": aid,
            "name": meta[aid]["name"],
            "key": norm(meta[aid]["name"]),
            "link": meta[aid].get("link"),
            "picture": meta[aid].get("picture"),
            "score": round(score, 2),
            "tier": tier,
            "sources": c,
            "first_seen": old.get("first_seen", today),
            "added": (datetime.fromtimestamp(added[aid], timezone.utc).date().isoformat()
                      if aid in added else old.get("added")),
            "last_seen": today,
            "still_liked": True,
            "provider": provider,
            **{k: meta[aid][k] for k in ("deezer_id", "spotify_id") if meta[aid].get(k)},
        }

    for aid, old in previous.items():
        if aid not in result and norm(old.get("name")) not in IGNORED:
            result[aid] = {**old, "still_liked": False}
    return result
