"""L'Officiel des spectacles (offi.fr) : programme des concerts, lu page par page, sans clé.

Une fiche peut annoncer plusieurs dates : elle donne un concert par date.
Seuls le titre, la salle, le genre, le prix, les dates et le lien vers la fiche sont conservés.
Les fiches ne structurent pas les noms d'artistes : comme pour Que faire à Paris, le
rapprochement se fait sur le titre et la source ne sert pas aux découvertes.
"""
import html as htmllib
import re
import time
from datetime import date, timedelta

from ..util import SESSION, log

URL = "https://www.offi.fr/concerts/programme.html"
HEADERS = {"User-Agent": "concerts-paris/1.0 (usage personnel; +https://github.com/byTSY/Concerts)"}
PAUSE = 3          # secondes entre deux pages
MAX_PAGES = 400    # garde-fou si la pagination n'est pas lisible
RETRIES = 3        # nouvelles tentatives sur une page refusée (503, 429), attente croissante
MAX_FAILED = 3     # pages en échec d'affilée avant abandon

MONTHS = {m: i for i, m in enumerate(
    ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout",
     "septembre", "octobre", "novembre", "decembre"], 1)}
NOT_GENRE = {"choix de la redaction", "reservation"}

BLOCK_RE = re.compile(r'(?=<div id="minifiche_\d+")')
DATE_RE = re.compile(r"(\d{1,2})(?:er)?\s+([a-zéèêûô]+)\.?(?:\s+(\d{4}))?\s*:\s*(\d{1,2})h(\d{2})?", re.I)


def _fold(s):
    return (s.lower().replace("é", "e").replace("è", "e").replace("ê", "e")
            .replace("û", "u").replace("ô", "o").replace("à", "a"))


def _text(fragment):
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def _decode(content):
    # Les pages se déclarent en UTF-8 mais sont servies en Windows-1252
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp1252", errors="replace")


def _dates(block):
    """Toutes les dates de la fiche, sous forme (AAAA-MM-JJ, HH:MM)."""
    anchor = re.search(r'itemprop="startDate"\s+content="(\d{4})-(\d{2})', block)
    if not anchor:
        return []
    year, prev_month = int(anchor.group(1)), int(anchor.group(2))
    start = block.find('itemprop="eventStatus"')
    text = _text(block[start:]) if start >= 0 else ""
    out = []
    for day, month, yr, hh, mm in DATE_RE.findall(text):
        month_n = MONTHS.get(_fold(month))
        if not month_n:
            continue
        if yr:
            year = int(yr)
        elif month_n < prev_month:  # passage à l'année suivante sans année affichée
            year += 1
        prev_month = month_n
        try:
            d = date(year, month_n, int(day))
        except ValueError:
            continue
        out.append((d.isoformat(), f"{int(hh):02d}:{mm or '00'}"))
    return out


def _parse(block):
    fid = re.search(r'id="minifiche_(\d+)"', block).group(1)
    name = re.search(r'itemprop="name">([^<]*)<', block)
    link = re.search(r'itemprop="url" href="([^"]+)"', block)
    venue = re.search(r'class="event-place[^"]*">\s*<a[^>]*>(.*?)</a>', block, re.S)
    tags = [_text(t) for t in re.findall(r'class="has-border item-info">(.*?)</span>', block, re.S)]
    price = next((t for t in tags if "€" in t or _fold(t) == "gratuit"), None)
    genres = [t for t in tags if t != price and _fold(t) not in NOT_GENRE]
    return {
        "id": fid,
        "title": htmllib.unescape(name.group(1)).strip() if name else None,
        "venue": _text(venue.group(1)) if venue else None,
        "genre": ", ".join(genres) or None,
        "price": price,
        "url": link.group(1) if link else None,
        "dates": _dates(block),
    }


def _last_page(page):
    nums = [int(n) for n in re.findall(r"programme\.html\?npage=(\d+)", page)]
    return max(nums) if nums else 1


def _get(n):
    """Une page du programme, ou None après plusieurs refus du serveur."""
    for attempt in range(RETRIES + 1):
        try:
            r = SESSION.get(URL, params={"npage": n} if n > 1 else None, headers=HEADERS, timeout=30)
            if r.status_code < 400:
                return _decode(r.content)
            status = f"HTTP {r.status_code}"
            if r.status_code not in (429, 500, 502, 503, 504):
                break
        except Exception as exc:  # noqa: BLE001
            status = exc.__class__.__name__
        if attempt < RETRIES:
            time.sleep(30 * (attempt + 1))
    log(f"  Offi : page {n} ignorée ({status})")
    return None


def fetch(settings, first_page=1):
    horizon = (date.today() + timedelta(days=31 * settings["horizon_months"])).isoformat()
    events, seen = [], set()
    last, n, failed, skipped = None, first_page, 0, 0
    while n <= (last or MAX_PAGES):
        if n > first_page:
            time.sleep(PAUSE)
        page = _get(n)
        if page is None:
            failed += 1
            skipped += 1
            if failed >= MAX_FAILED:
                log(f"  Offi : {failed} pages en échec d'affilée, arrêt à la page {n}")
                break
            n += 1
            continue
        failed = 0
        if last is None:
            last = min(_last_page(page), MAX_PAGES)
        blocks = BLOCK_RE.split(page)[1:]
        if not blocks:
            break
        firsts = []
        for block in blocks:
            fiche = _parse(block)
            if fiche["dates"]:
                firsts.append(fiche["dates"][0][0])
            for day, hour in fiche["dates"]:
                sid = f"{fiche['id']}-{day}T{hour}"
                if sid in seen or day > horizon:
                    continue
                seen.add(sid)
                events.append({
                    "source": "Offi",
                    "source_id": sid,
                    "title": fiche["title"],
                    "date": day,
                    "time": hour,
                    "venue": fiche["venue"],
                    "url": fiche["url"],
                    "price": fiche["price"],
                    "genre": fiche["genre"],
                    "artists": [],
                    "title_only": True,
                })
        if firsts and min(firsts) > horizon:  # le programme est trié par date
            break
        n += 1
    pages = (min(n, last) if last else n) - first_page + 1
    log(f"  Offi : {len(events)} concerts sur {pages} pages" + (f", dont {skipped} ignorées" if skipped else ""))
    return events
