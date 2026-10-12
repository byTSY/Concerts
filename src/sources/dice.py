"""Dice (dice.fm) : concerts vendus sur Dice à Paris, lus sur les pages publiques, sans clé.

Le robots.txt de Dice n'interdit que son API interne (/api/) : on lit uniquement les pages web.
1. Les pages « Paris » (concerts, soirées, DJ) révèlent les salles actives sur Dice ; elles ne
   montrent que les prochains jours, d'où l'étape suivante.
2. La page de chaque salle liste tous ses concerts à venir (données schema.org) : c'est la source.
La liste des salles est conservée dans data/cache/dice_venues.json et s'enrichit chaque semaine.
Pause de 3 secondes entre deux pages, User-Agent identifiable, comme pour offi.fr.
"""
import html as htmllib
import json
import re
import time
from datetime import date, timedelta

from ..util import CACHE, SESSION, load_json, log, save_json

BASE = "https://dice.fm"
BROWSE = BASE + "/browse/paris-5b23e8a0e63cc224a4c36a2d"
HEADERS = {"User-Agent": "concerts-paris/1.0 (usage personnel; +https://github.com/byTSY/Concerts)"}
PAUSE = 3
VENUES_PATH = CACHE / "dice_venues.json"
WEEKLY_PAGES = ["/music/gig", "/music/party", "/music/dj"]
MAX_NEW_VENUES = 40  # salles nouvelles résolues par semaine (une page de concert chacune)

NEXT_RE = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
LD_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)

_last = [0.0]


def _get(url):
    """Page HTML, avec la pause entre deux requêtes ; None en cas d'échec."""
    wait = PAUSE - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    try:
        r = SESSION.get(url, headers=HEADERS, timeout=30)
    except Exception as exc:  # noqa: BLE001
        log(f"  Dice : {url} inaccessible ({exc.__class__.__name__})")
        return None
    finally:
        _last[0] = time.time()
    if r.status_code >= 400:
        log(f"  Dice : HTTP {r.status_code} sur {url}")
        return None
    return r.text


def _next_data(page):
    m = NEXT_RE.search(page or "")
    return json.loads(m.group(1))["props"]["pageProps"] if m else {}


def _ld(page):
    out = []
    for block in LD_RE.findall(page or ""):
        try:
            out.append(json.loads(block))
        except ValueError:
            continue
    return out


def browse_venues(paths):
    """Salles vues sur les pages « Paris » : {identifiant Dice: (nom, identifiant d'un de ses concerts)}."""
    venues, filters = {}, []
    for path in paths:
        props = _next_data(_get(BROWSE + path))
        filters = filters or [f["activateLink"] for f in props.get("secondaryFilters", [])]
        for ev in props.get("events", []):
            for v in ev.get("venues", []):
                if (v.get("city") or {}).get("name") == "Paris" or "Paris" in (v.get("address") or ""):
                    venues.setdefault(str(v["id"]), (v.get("name", "").strip(), ev["id"]))
    return venues, filters


def resolve_venue(event_id):
    """Adresse de la page d'une salle, lue sur la page d'un de ses concerts."""
    for d in _ld(_get(f"{BASE}/event/{event_id}")):
        loc = d.get("location") if isinstance(d, dict) else None
        if isinstance(loc, dict) and str(loc.get("url", "")).startswith(BASE + "/venue/"):
            return loc["url"]
    return None


def venue_events(url, horizon):
    """Concerts à venir d'une salle (données schema.org de la page)."""
    events = []
    for d in _ld(_get(url)):
        if not (isinstance(d, dict) and d.get("@type") == "Place"):
            continue
        venue = htmllib.unescape(d.get("name", "")).strip()
        addr = d.get("address")
        address = (addr.get("streetAddress") if isinstance(addr, dict) else addr or "").replace(", France", "")
        for ev in d.get("event") or []:
            start = str(ev.get("startDate") or "")
            if len(start) < 10 or start[:10] > horizon or "Cancelled" in str(ev.get("eventStatus")):
                continue
            eid = str(ev.get("url", "")).rstrip("/").rsplit("/", 1)[-1]
            events.append({
                "source": "Dice",
                "source_id": eid,
                "title": htmllib.unescape(ev.get("name", "")).strip(),
                "date": start[:10],
                "time": start[11:16] or None,
                "venue": venue,
                "address": address or None,
                "city": "Paris",
                "url": f"{BASE}/event/{eid}",
                "price": None,
                "status": None,
                "artists": [],
                "genre": None,
                "title_only": True,
            })
    return events


def fetch(settings, discover_all=False):
    """discover_all : parcourt aussi les 160 pages par genre (premier passage, c. 8 minutes)."""
    horizon = (date.today() + timedelta(days=31 * settings["horizon_months"])).isoformat()
    known = load_json(VENUES_PATH, {})
    seen, filters = browse_venues(WEEKLY_PAGES)
    if discover_all:
        more, _ = browse_venues([f.replace("/browse/paris-5b23e8a0e63cc224a4c36a2d", "") for f in filters])
        for k, v in more.items():
            seen.setdefault(k, v)

    new = [(vid, name, eid) for vid, (name, eid) in seen.items() if vid not in known]
    for vid, name, eid in new[:MAX_NEW_VENUES]:
        url = resolve_venue(eid)
        if url:
            known[vid] = {"name": name, "url": url}
    save_json(VENUES_PATH, known)

    events, seen_ids = [], set()
    for vid, v in known.items():
        for ev in venue_events(v["url"], horizon):
            if ev["source_id"] not in seen_ids:
                seen_ids.add(ev["source_id"])
                events.append(ev)
    log(f"  Dice : {len(events)} concerts dans {len(known)} salles"
        + (f" ({len(new)} salles nouvelles, {min(len(new), MAX_NEW_VENUES)} ajoutées)" if new else ""))
    return events
