"""Ticketmaster Discovery API : tous les concerts de la zone, mois par mois.

Clé gratuite sur https://developer.ticketmaster.com (variable TICKETMASTER_API_KEY).
L'API limite la pagination à 1 000 résultats par requête, d'où le découpage par mois.
"""
from datetime import date, timedelta

from ..util import get_json, log

URL = "https://app.ticketmaster.com/discovery/v2/events.json"


def _month_windows(months):
    start = date.today()
    for _ in range(months):
        end = start + timedelta(days=31)
        yield start, end
        start = end


def _price(ev):
    ranges = ev.get("priceRanges") or []
    if not ranges:
        return None
    lo = min(r.get("min", 0) for r in ranges)
    hi = max(r.get("max", 0) for r in ranges)
    cur = ranges[0].get("currency", "EUR")
    sym = "€" if cur == "EUR" else cur
    return f"{lo:.0f} {sym}" if lo == hi else f"{lo:.0f}-{hi:.0f} {sym}"


def _image(ev):
    imgs = [i for i in ev.get("images") or [] if i.get("ratio") == "16_9"]
    imgs.sort(key=lambda i: i.get("width", 0))
    return next((i["url"] for i in imgs if i.get("width", 0) >= 600), imgs[-1]["url"] if imgs else None)


def fetch(settings, api_key):
    zone = settings["zone"]
    events = []
    for start, end in _month_windows(settings["horizon_months"]):
        page = 0
        while True:
            data = get_json(URL, params={
                "apikey": api_key,
                "classificationName": "music",
                "latlong": f"{zone['lat']},{zone['lon']}",
                "radius": zone["radius_km"],
                "unit": "km",
                "startDateTime": f"{start.isoformat()}T00:00:00Z",
                "endDateTime": f"{end.isoformat()}T00:00:00Z",
                "size": 200,
                "page": page,
                "sort": "date,asc",
                "locale": "*",
            }, pause=0.25)
            if not data:
                break
            for ev in (data.get("_embedded") or {}).get("events", []):
                venue = ((ev.get("_embedded") or {}).get("venues") or [{}])[0]
                start_info = (ev.get("dates") or {}).get("start") or {}
                cls = (ev.get("classifications") or [{}])[0]
                attractions = [a.get("name") for a in (ev.get("_embedded") or {}).get("attractions", []) if a.get("name")]
                loc = venue.get("location") or {}
                events.append({
                    "source": "Ticketmaster",
                    "source_id": ev.get("id"),
                    "title": ev.get("name"),
                    "date": start_info.get("localDate"),
                    "time": (start_info.get("localTime") or "")[:5] or None,
                    "venue": venue.get("name"),
                    "address": (venue.get("address") or {}).get("line1"),
                    "city": (venue.get("city") or {}).get("name"),
                    "lat": float(loc["latitude"]) if loc.get("latitude") else None,
                    "lon": float(loc["longitude"]) if loc.get("longitude") else None,
                    "url": ev.get("url"),
                    "on_sale": ((ev.get("sales") or {}).get("public") or {}).get("startDateTime"),
                    "price": _price(ev),
                    "status": ((ev.get("dates") or {}).get("status") or {}).get("code"),
                    "artists": attractions,
                    "genre": ((cls.get("genre") or {}).get("name") or "").replace("Undefined", "") or None,
                    "image": _image(ev),
                    "title_only": not attractions,
                })
            info = data.get("page") or {}
            page += 1
            if page >= info.get("totalPages", 0) or page * 200 >= 1000:
                break
    log(f"  Ticketmaster : {len(events)} événements")
    return events
