"""Bandsintown : dates à venir de vos artistes, filtrées sur la zone parisienne.

Nécessite un identifiant d'application (variable BANDSINTOWN_APP_ID), délivré par
Bandsintown sur demande. Sans identifiant, cette source est simplement ignorée.
Les premières parties (lineup) alimentent aussi les découvertes.
"""
from urllib.parse import quote

from ..util import distance_km, get_json, log, norm

URL = "https://rest.bandsintown.com/artists/{name}/events"


def fetch(settings, app_id, artists):
    zone = settings["zone"]
    ranked = sorted((a for a in artists.values() if a.get("still_liked", True)),
                    key=lambda a: -a["score"])[: settings["bandsintown_max_artists"]]
    events = []
    for a in ranked:
        name = quote(a["name"].replace("/", "%2F"), safe="")
        data = get_json(URL.format(name=name), params={"app_id": app_id, "date": "upcoming"}, pause=0.2)
        if not isinstance(data, list):
            continue
        for ev in data:
            v = ev.get("venue") or {}
            try:
                lat, lon = float(v.get("latitude")), float(v.get("longitude"))
                near = distance_km(zone["lat"], zone["lon"], lat, lon) <= zone["radius_km"]
            except (TypeError, ValueError):
                lat = lon = None
                near = norm(v.get("city")) == "paris"
            if not near:
                continue
            dt = ev.get("datetime") or ""
            offers = ev.get("offers") or []
            lineup = [x for x in (ev.get("lineup") or []) if x]
            if a["name"] not in lineup:
                lineup.insert(0, a["name"])
            events.append({
                "source": "Bandsintown",
                "source_id": str(ev.get("id")),
                "title": ev.get("title") or " + ".join(lineup),
                "date": dt[:10] or None,
                "time": dt[11:16] or None,
                "venue": v.get("name"),
                "address": v.get("street_address"),
                "city": v.get("city"),
                "lat": lat,
                "lon": lon,
                "url": (offers[0].get("url") if offers else None) or ev.get("url"),
                "on_sale": ev.get("on_sale_datetime") or None,
                "price": None,
                "status": (offers[0].get("status") if offers else None),
                "artists": lineup,
                "genre": None,
                "image": None,
                "title_only": False,
            })
    log(f"  Bandsintown : {len(events)} dates à Paris pour {len(ranked)} artistes interrogés")
    return events
