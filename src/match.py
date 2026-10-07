"""Salles, dédoublonnage entre sources et rapprochement avec votre liste d'artistes."""
import hashlib
from collections import defaultdict

from .util import norm, norm_venue, today_iso

SOURCE_PRIORITY = {"Ticketmaster": 0, "Bandsintown": 2, "Que faire à Paris": 3, "Offi": 4}
MIN_TITLE_KEY = 4  # longueur minimale d'un nom pour un rapprochement sur le titre seul


class VenueMatcher:
    def __init__(self, cfg):
        self.favorites = self._build(cfg.get("favorites", []))
        self.excluded = self._build(cfg.get("excluded", []))

    @staticmethod
    def _build(items):
        out = []
        for v in items:
            v = {"name": v} if isinstance(v, str) else v
            keys = {norm_venue(v["name"])} | {norm_venue(a) for a in v.get("aliases", [])}
            out.append((v["name"], [k for k in keys if k]))
        return out

    @staticmethod
    def _find(table, venue):
        nv = f" {norm_venue(venue)} "
        for canon, keys in table:
            if any(f" {k} " in nv for k in keys):
                return canon
        return None

    def favorite(self, venue):
        return self._find(self.favorites, venue)

    def is_excluded(self, venue):
        return self._find(self.excluded, venue) is not None


def prepare(events, venues):
    """Écarte les événements passés ou exclus et rattache les salles favorites."""
    today = today_iso()
    out = []
    for ev in events:
        if not ev.get("date") or ev["date"] < today or not ev.get("venue"):
            continue
        if venues.is_excluded(ev["venue"]):
            continue
        if (ev.get("status") or "").lower() in {"cancelled", "canceled"}:
            continue
        fav = venues.favorite(ev["venue"])
        ev["venue_favorite"] = bool(fav)
        if fav:
            ev["venue"] = fav
        ev["venue_key"] = norm_venue(ev["venue"])
        out.append(ev)
    return out


class ArtistIndex:
    def __init__(self, artists):
        self.by_key = {}
        self.by_id = artists
        for a in artists.values():
            k = a.get("key") or norm(a["name"])
            if k and (k not in self.by_key or a["score"] > self.by_key[k]["score"]):
                self.by_key[k] = a

    def exact(self, name):
        return self.by_key.get(norm(name))

    def in_title(self, title):
        words = norm(title).split()
        found = {}
        for n in range(1, 6):
            for i in range(len(words) - n + 1):
                key = " ".join(words[i:i + n])
                if len(key) >= MIN_TITLE_KEY and key in self.by_key:
                    found[key] = self.by_key[key]
        return list(found.values())


def match_known(events, index):
    for ev in events:
        matched = {}
        for name in ev.get("artists") or []:
            a = index.exact(name)
            if a:
                matched[a["id"]] = {"id": a["id"], "name": a["name"], "tier": a["tier"], "via": "artiste"}
        for a in index.in_title(ev.get("title") or ""):
            matched.setdefault(a["id"], {"id": a["id"], "name": a["name"], "tier": a["tier"], "via": "titre"})
        ev["matched"] = sorted(matched.values(), key=lambda m: m["tier"])
    return events


def _priority(ev):
    return SOURCE_PRIORITY.get(ev["source"], 1)


def _identity(ev):
    if ev.get("matched"):
        return "a" + ev["matched"][0]["id"]
    first = (ev.get("artists") or [ev.get("title") or ""])[0]
    return "n" + norm(first)[:24]


def dedupe(events):
    """Fusionne un même concert vu par plusieurs sources."""
    groups = defaultdict(list)
    for ev in events:
        groups[(ev["date"], ev["venue_key"], _identity(ev))].append(ev)

    merged = []
    for key, group in groups.items():
        group.sort(key=_priority)
        base = dict(group[0])
        links, artists, seen_urls = [], [], set()
        matched = {m["id"]: m for m in base.get("matched", [])}
        for ev in group:
            for field in ("time", "address", "price", "on_sale", "image", "genre", "status", "description"):
                if not base.get(field) and ev.get(field):
                    base[field] = ev[field]
            if ev.get("url") and ev["url"] not in seen_urls:
                links.append({"source": ev["source"], "url": ev["url"]})
                seen_urls.add(ev["url"])
            for a in ev.get("artists") or []:
                if a not in artists:
                    artists.append(a)
            for m in ev.get("matched", []):
                matched.setdefault(m["id"], m)
        base["artists"] = artists
        base["links"] = links
        base["matched"] = sorted(matched.values(), key=lambda m: m["tier"])
        base["title_only"] = all(ev.get("title_only") for ev in group)
        # Identifiants des sources : servent à retrouver le concert d'une semaine à l'autre
        base["source_keys"] = sorted({f"{ev['source']}:{ev.get('source_id') or ev.get('url') or ''}" for ev in group})
        base["id"] = hashlib.sha1("|".join(key).encode()).hexdigest()[:12]
        merged.append(base)
    return merged
