"""Découvertes : artistes absents de votre liste, notés selon leur proximité avec vos goûts.

Deux signaux tirés des « artistes similaires » de Deezer :
- les similaires de l'artiste inconnu qui figurent dans votre liste ;
- vos artistes (niveaux 1 et 2) qui citent l'artiste inconnu parmi leurs similaires.
"""
from collections import defaultdict

from . import deezer
from .match import title_names
from .util import log, norm

TIER_WEIGHT = {1: 1.0, 2: 0.6, 3: 0.3}
REVERSE_POOL = 300  # nombre de vos artistes dont on lit les similaires


def _reverse_index(artists, related_cache, refresh_days):
    pool = sorted((a for a in artists.values() if a["tier"] <= 2), key=lambda a: -a["score"])[:REVERSE_POOL]
    weight, names = defaultdict(float), defaultdict(list)
    for a in pool:
        for rid in deezer.related(a["id"], related_cache, refresh_days):
            weight[rid] += TIER_WEIGHT[a["tier"]]
            names[rid].append((TIER_WEIGHT[a["tier"]], a["name"]))
    return weight, names


def score_events(events, artists, settings, hidden_keys=frozenset()):
    """artists : votre liste sans les artistes masqués ; hidden_keys : leurs noms normalisés,
    pour ne pas les proposer en découverte."""
    cfg = settings["discovery"]
    search_cache, related_cache = deezer.load_caches()
    log("Découvertes : lecture des artistes similaires de votre liste")
    rev_weight, rev_names = _reverse_index(artists, related_cache, cfg["related_refresh_days"])

    # Noms à analyser : les artistes fournis par la source ; à défaut, pour L'Officiel des
    # spectacles dont les titres sont presque toujours des noms d'artistes, le titre lui-même
    def names_of(ev):
        if ev.get("artists"):
            return ev["artists"][:4]
        if any(k.startswith("Offi:") for k in ev.get("source_keys", [])):
            return title_names(ev.get("title"))[:4]
        return []

    candidates = [ev for ev in events if not ev.get("matched") and names_of(ev)]
    candidates.sort(key=lambda ev: (not ev.get("venue_favorite"), ev["date"]))

    lookups, scored = 0, 0
    for ev in candidates:
        best = None
        for name in names_of(ev):
            cached = norm(name) in search_cache
            if not cached and lookups >= cfg["max_new_lookups"]:
                continue
            found = deezer.search_artist(name, search_cache)
            lookups += 0 if cached else 1
            if not found or norm(name) in hidden_keys or norm(found["name"]) in hidden_keys:
                continue

            # Artiste déjà dans votre liste sous un autre libellé : c'est un concert connu
            mine = artists.get(found["id"])
            if mine:
                ev["matched"] = [{"id": mine["id"], "name": mine["name"], "tier": mine["tier"], "via": "deezer"}]
                best = None
                break

            fwd = [artists[r] for r in deezer.related(found["id"], related_cache, cfg["related_refresh_days"])
                   if r in artists]
            raw = sum(TIER_WEIGHT[a["tier"]] for a in fwd) + rev_weight.get(found["id"], 0.0)
            if raw <= 0:
                continue
            proximity = min(1.0, raw / 3.0)
            if ev.get("venue_favorite"):
                proximity = min(1.0, proximity + cfg["favorite_venue_bonus"])

            close = sorted({(TIER_WEIGHT[a["tier"]], a["name"]) for a in fwd} | set(rev_names.get(found["id"], [])),
                           reverse=True)
            close_names = []
            for _, n in close:
                if n not in close_names:
                    close_names.append(n)
            if not best or proximity > best["score"]:
                best = {"score": round(proximity, 2), "artist": found["name"], "link": found.get("link"),
                        "picture": found.get("picture"), "fans": found.get("fans"), "close_to": close_names[:4]}
        if best and best["score"] >= cfg["min_score"]:
            ev["discovery"] = best
            scored += 1

    deezer.save_caches(search_cache, related_cache)
    log(f"  {lookups} nouveaux artistes analysés, {scored} découvertes retenues")
    return events
