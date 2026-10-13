"""Pages programme des salles du catalogue, lues via leurs données structurées schema.org.

Beaucoup de sites de salles intègrent des balises JSON-LD de type Event pour les moteurs
de recherche. Quand c'est le cas, renseigner la page programme (agenda_url) de la salle dans
le catalogue suffit.
Sinon la page ne renvoie rien et le script passe à la suivante, sans erreur.
"""
import json
import re
from urllib.parse import urljoin

from ..util import SESSION, log

LD_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)
EVENT_TYPES = {"event", "musicevent", "festival", "theaterevent"}


def _walk(node):
    if isinstance(node, list):
        for x in node:
            yield from _walk(x)
    elif isinstance(node, dict):
        types = node.get("@type")
        types = [types] if isinstance(types, str) else (types or [])
        if any(str(t).lower() in EVENT_TYPES for t in types):
            yield node
        for k in ("@graph", "itemListElement", "item", "subEvent", "event"):
            if k in node:
                yield from _walk(node[k])


def _names(value):
    if not value:
        return []
    value = value if isinstance(value, list) else [value]
    return [v.get("name") if isinstance(v, dict) else str(v) for v in value if v]


MAX_PAGE = 5 * 1024 * 1024  # page programme lue au plus (octets)


def _web(value, base=None):
    """Adresse http(s) seulement (la page d'une salle proposée par un membre n'est pas sûre) ;
    une adresse relative (« /agenda/x ») est complétée par celle de la page programme."""
    if not isinstance(value, str) or not value.strip():
        return None
    full = urljoin(base, value.strip()) if base else value.strip()
    return full if full.lower().startswith(("https://", "http://")) else None


def _read(url):
    """Texte de la page, ou None si elle dépasse MAX_PAGE (lecture interrompue)."""
    with SESSION.get(url, timeout=30, stream=True) as r:
        if int(r.headers.get("content-length") or 0) > MAX_PAGE:
            return None
        chunks, size = [], 0
        for chunk in r.iter_content(65536):
            size += len(chunk)
            if size > MAX_PAGE:
                return None
            chunks.append(chunk)
        return b"".join(chunks).decode(r.encoding or "utf-8", errors="replace")


def fetch(venues_cfg):
    """venues_cfg : catalogue commun des salles (catalog.load)."""
    events = []
    for v in venues_cfg.get("venues", []):
        url = (v.get("agenda_url") or "").strip()
        if not url:
            continue
        try:
            html = _read(url)
            if html is None:
                log(f"  {v['name']} : page programme trop lourde, ignorée")
                continue
        except Exception as exc:  # noqa: BLE001
            log(f"  {v['name']} : page inaccessible ({exc.__class__.__name__})")
            continue
        found = 0
        for block in LD_RE.findall(html):
            try:
                data = json.loads(block.strip())
            except ValueError:
                continue
            for ev in _walk(data):
                start = str(ev.get("startDate") or "")
                if len(start) < 10:
                    continue
                offers = ev.get("offers") or {}
                offers = offers[0] if isinstance(offers, list) and offers else offers
                price = offers.get("price") if isinstance(offers, dict) else None
                image = ev.get("image")
                image = image[0] if isinstance(image, list) and image else image
                image = image.get("url") if isinstance(image, dict) else image
                performers = [n for n in _names(ev.get("performer")) if n]
                events.append({
                    "source": f"Site {v['name']}",
                    "source_id": _web(ev.get("url"), url) or f"{v['name']}-{start}",
                    "title": ev.get("name"),
                    "date": start[:10],
                    "time": start[11:16] or None,
                    "venue": v["name"],
                    "address": None,
                    "city": "Paris",
                    "lat": None,
                    "lon": None,
                    "url": _web(ev.get("url"), url) or url,
                    "on_sale": None,
                    "price": f"{price} €" if price not in (None, "", 0, "0") else None,
                    "status": None,
                    "artists": performers,
                    "genre": None,
                    "image": _web(image, url),
                    "title_only": not performers,
                })
                found += 1
        log(f"  {v['name']} : {found} événements lus sur le site")
    return events
