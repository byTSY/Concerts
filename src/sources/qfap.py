"""Que faire à Paris (open data de la Ville de Paris), sans clé.

Les fiches ne structurent pas les noms d'artistes : le rapprochement se fait sur le titre,
cette source sert donc uniquement à retrouver vos artistes, pas aux découvertes.
Les noms de champs sont lus de façon tolérante, le jeu de données pouvant évoluer.
"""
import html
import re

from ..util import get_json, log, norm, today_iso

EXPORT = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/exports/json"


def _first(rec, *keys):
    for k in keys:
        if rec.get(k):
            return rec[k]
    return None


def _plain(text):
    """Texte brut : le champ prix contient parfois du HTML."""
    if not text:
        return None
    s = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(text)))).strip()
    return s or None


def fetch(settings):
    today = today_iso()
    data = get_json(EXPORT, params={"where": f"date_end >= date'{today}'"}, timeout=120)
    if data is None:
        data = get_json(EXPORT, timeout=120)
    if not isinstance(data, list):
        log("  Que faire à Paris : jeu de données indisponible")
        return []

    events = []
    for rec in data:
        tags = norm(" ".join(str(rec.get(k) or "") for k in ("qfap_tags", "tags", "category")))
        if "concert" not in tags:
            continue
        start = str(_first(rec, "date_start") or "")[:10]
        end = str(_first(rec, "date_end") or "")[:10]
        if not start or (end and end < today):
            continue
        if start < today:
            start = today
        hour = str(_first(rec, "date_start") or "")[11:16]
        geo = rec.get("lat_lon") or {}
        price_type = rec.get("price_type")
        events.append({
            "source": "Que faire à Paris",
            "source_id": str(_first(rec, "id", "event_id") or ""),
            "title": rec.get("title"),
            "date": start,
            "time": hour if hour not in ("", "00:00") else None,  # minuit : horaire non renseigné
            "venue": _first(rec, "address_name", "place_name"),
            "address": _first(rec, "address_street"),
            "city": _first(rec, "address_city") or "Paris",
            "lat": geo.get("lat") if isinstance(geo, dict) else None,
            "lon": geo.get("lon") if isinstance(geo, dict) else None,
            "url": _first(rec, "access_link", "url"),
            "on_sale": None,
            "price": "Gratuit" if norm(price_type) == "gratuit" else _plain(rec.get("price_detail")),
            "status": None,
            "artists": [],
            "genre": None,
            "image": _first(rec, "cover_url"),
            "title_only": True,
            "description": rec.get("lead_text"),
        })
    log(f"  Que faire à Paris : {len(events)} concerts")
    return events
