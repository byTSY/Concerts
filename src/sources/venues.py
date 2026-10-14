"""Pages programme des salles du catalogue : lecteur universel (version 1.12.0).

Une salle donne l'adresse de sa page programme ; read_venue y cherche les concerts par plusieurs
méthodes et garde la meilleure, au sens du contrôle de src/venue_check.py :
1. fiches de la page : données schema.org Event (JSON-LD) que beaucoup de sites publient pour
   les moteurs de recherche ;
2. cartes de la page : un concert par lien interne (/agenda/<x>, /evenement/<x>…, au moins 3
   liens frères) ; la carte d'un lien est le plus grand bloc qui ne contient aucun autre de ces
   liens ; on y lit la date, l'heure et le titre (texte le plus proche du nom du lien) ;
3. agenda des sites WordPress « The Events Calendar » (une requête à leur API publique) ;
4. pages de concert : ouverture des liens trouvés en 2 pour y lire les fiches de chaque concert ;
5. page d'accueil donnée au lieu de la page programme : suivi des liens « agenda »,
   « programmation », « concerts »…
Concerts lus entre aujourd'hui et un an. Une salle dont la lecture ne passe pas le contrôle ne
donne aucun concert (journal, puis message à l'admin par la tâche commune).

Politesse : robots.txt respecté, User-Agent identifiable, pause entre deux pages d'un même site,
5 Mo au plus par page.
"""
import html as htmllib
import ipaddress
import json
import re
import signal
import socket
import threading
import time
import unicodedata
from collections import defaultdict
from datetime import date, timedelta
from contextlib import contextmanager
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

from . import htmltree
from ..util import SESSION, log

HEADERS = {"User-Agent": "concerts-paris/1.0 (usage personnel; +https://github.com/byTSY/Concerts)"}
ROBOTS_AGENT = "concerts-paris"
PAUSE = 1.5             # secondes entre deux pages d'un même site
MAX_PAGE = 5 * 1024 * 1024  # page lue au plus (octets)
MAX_DETAIL_PAGES = 40   # pages de concert ouvertes au plus par salle
DETAIL_GIVE_UP = 3      # pages de concert sans fiche d'affilée avant abandon
MAX_AGENDA_LINKS = 3    # liens « agenda » suivis depuis une page d'accueil
MIN_GROUP = 3           # liens frères au moins pour former une liste de concerts
HORIZON_DAYS = 366
MAX_REDIRECTS = 5
MAX_ROBOTS = 512 * 1024    # robots.txt lu au plus (octets)
READ_SECONDS = 40          # durée de lecture d'une page au plus
VENUE_SECONDS = 180        # durée de lecture d'une salle au plus (toutes méthodes)
MAX_CARD_TEXT = 3000       # texte d'une carte au plus (caractères) : au-delà, bloc trop large
MAX_GROUPS = 12            # groupes de liens examinés au plus par page
MAX_LINKS = 3000           # liens internes examinés au plus par page
MAX_CLIMB = 40             # niveaux de blocs remontés au plus autour d'un lien
SOURCE_SECONDS = 15 * 60   # durée totale de la source « Sites des salles » (traitement du lundi)
SAFE_HOST = re.compile(r"^[a-z0-9.-]+(:\d+)?$")  # hôte sans caractère ambigu (barre oblique inverse, espace, « @ »)
STRUCTURED = {"fiches de la page", "pages de concert", "agenda WordPress"}   # données publiées par le site

LD_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)
EVENT_TYPES = {"event", "musicevent", "festival", "theaterevent", "danceevent", "comedyevent"}

# Pages qui ne sont pas des concerts (archives, pagination, catégories, compte, fichiers…)
SKIP_PATH = re.compile(
    r"/(archives?|page|pages|tag|tags|categor\w*|eventcat|event-category|search|recherche|contact|panier|cart|"
    r"checkout|login|connexion|compte|account|newsletter|mentions[\w-]*|cgv|cgu|faq|feed|rss|wp-\w+|"
    r"privacy|confidentialite|cookies?|presse|press|partenaires?|equipe|team|recrutement|jobs?|"
    r"infos?-pratiques|acces|privatisation)(/|$)|\.(jpe?g|png|gif|pdf|webp|svg|ics|zip|mp3|mp4)$", re.I)
# Page programme : dernier dossier de l'adresse ou libellé du lien (« agenda », « programmation »…)
AGENDA_HINT = re.compile(r"(agenda|programmation|programme|concerts?|evenements?|events?|calendrier|billetterie|"
                         r"saison|a.venir)([ -][a-z0-9-]+)?")

# Libellés de carte qui ne désignent pas un concert : la carte est lue (contrôle) mais écartée
NOT_CONCERT = {"club", "soiree", "soirees", "party", "dj", "dj set", "dj sets", "cabaret", "atelier", "ateliers",
               "theatre", "humour", "stand-up", "stand up", "comedie", "conference", "rencontre", "projection",
               "cinema", "brunch", "marche", "exposition", "expo", "jeune public", "visite", "karaoke"}
# Libellés qui ne sont jamais un titre de concert
GENERIC_TITLES = {"concert", "concerts", "jazz", "rock", "pop", "rap", "hip-hop", "hip hop", "rap hip-hop",
                  "rap, hip-hop", "hip-hop / rap", "electro", "electronique", "alternatif", "musique", "musiques",
                  "festival", "live", "soul", "funk", "blues", "metal", "punk", "world", "chanson", "classique",
                  "folk", "reggae", "concert & festival", "spectacle", "evenement", "evenements", "dernieres places",
                  "programmation", "agenda", "a l affiche", "complet", "gratuit"}
NOISE = re.compile(
    r"^(\+? ?infos?|\+ d.?infos?|en savoir plus|plus d.?infos?|r[ée]server|r[ée]servation|billets?|billetterie|"
    r"acheter|tickets?|book( now)?|buy|more|voir( plus)?|d[ée]tails?|lire la suite|d[ée]couvrir|complet|"
    r"[ée]puis[ée].*|annul[ée]e?|sold ?out|gratuit|free|nouveau|new|[àa] venir|prochainement|report[ée]e?|"
    r"derni[èe]res? places?|non disponible.*|\d+([.,]\d+)? ?€.*|[\W\d_]+|.)$", re.I)
WEEKDAY = re.compile(r"^(lun|mar|mer|jeu|ven|sam|dim|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$")
STOP_WORDS = {"le", "la", "les", "de", "du", "des", "the", "and", "et", "en", "au", "aux", "un", "une", "of",
              "feat", "ft", "with", "avec", "presente", "presents", "live", "concert", "paris", "www", "http",
              "https", "html", "php", "fr", "en", "agenda", "evenement", "event", "events", "programmation"}

MONTHS = {"janvier": 1, "janv": 1, "jan": 1, "january": 1, "fevrier": 2, "fevr": 2, "fev": 2, "feb": 2,
          "february": 2, "mars": 3, "mar": 3, "march": 3, "avril": 4, "avr": 4, "apr": 4, "april": 4, "mai": 5,
          "may": 5, "juin": 6, "jun": 6, "june": 6, "juillet": 7, "juil": 7, "jul": 7, "july": 7, "aout": 8,
          "aug": 8, "august": 8, "septembre": 9, "sept": 9, "sep": 9, "september": 9, "octobre": 10, "oct": 10,
          "october": 10, "novembre": 11, "nov": 11, "november": 11, "decembre": 12, "dec": 12, "december": 12}
_MON = "|".join(sorted(MONTHS, key=len, reverse=True))
_SEP = r"[\s\-–―—.,/|:]{0,6}"
DATE_DAY_MONTH = re.compile(r"\b(\d{1,2})(?:er|st|nd|rd|th)?" + _SEP + r"(" + _MON + r")\b\.?"
                            r"(?:" + _SEP + r"(?:[a-z]{3,5}\.?\s*)?(20\d\d))?")
# Mois puis jour (« Oct 16 ») : sans « mar », qui abrège aussi mardi (« Mar. 21 oct. »)
_MON_FIRST = "|".join(sorted((m for m in MONTHS if m != "mar"), key=len, reverse=True))
DATE_MONTH_DAY = re.compile(r"\b(" + _MON_FIRST + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s*(20\d\d)?")
# « 16/10 », « 31.10.2026 » ; pas un prix (« 15.10 € », « 12,50 »)
DATE_NUMERIC = re.compile(r"(?<![\d.,€$])\b(\d{1,2})[./](\d{1,2})(?:[./](20\d\d|\d\d))?\b(?!\s*(?:€|eur|\$|[.,]\d))")
DATE_ISO = re.compile(r"(20\d\d)-(\d\d)-(\d\d)")
TIME_RE = re.compile(r"\b([01]?\d|2[0-3]) ?(?:h ?([0-5]\d)?|:([0-5]\d))\b")

_last_hit = {}   # hôte -> heure de la dernière page lue
_robots = {}     # origine -> RobotFileParser, ou None (tout autorisé)
_public_hosts = {}  # hôte -> vrai si toutes ses adresses sont publiques
_deadline = [None]  # heure limite de lecture de la salle en cours (time.monotonic)


class PageError(Exception):
    """Page illisible : inaccessible, refusée par robots.txt, trop lourde ou en erreur HTTP."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class _Timeout(BaseException):
    """Durée de lecture de la salle dépassée (alarme) ; BaseException : jamais confondue avec
    une page en erreur par les « except Exception » de la lecture."""


@contextmanager
def _time_limit(seconds):
    """Interrompt le bloc après seconds secondes (lecture réseau ou calcul compris), là où une
    alarme est possible (Linux, fil principal : GitHub Actions) ; ailleurs, seuls les contrôles
    entre deux pages et pendant la lecture s'appliquent."""
    usable = hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread()
    if not usable:
        yield
        return

    def ring(_signum, _frame):
        raise _Timeout()
    previous = signal.signal(signal.SIGALRM, ring)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class Page(str):
    """Texte d'une page, avec l'adresse finale après redirections (base des liens relatifs)."""
    url = None


class _Redirect(Exception):
    def __init__(self, location):
        super().__init__(location)
        self.location = location


# --- Lecture des pages ------------------------------------------------------------------

def fold(text):
    """Texte comparable : sans accents, minuscules."""
    return unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode().lower()


def words(text):
    """Mots significatifs d'un texte ou d'une adresse (au moins 2 caractères, sans mots outils)."""
    return {w for w in re.split(r"[^a-z0-9]+", fold(text)) if len(w) > 1 and w not in STOP_WORDS and not w.isdigit()}


def _web(value, base=None):
    """Adresse http(s) seulement (la page d'une salle proposée par un membre n'est pas sûre) ;
    une adresse relative (« /agenda/x ») est complétée par celle de la page programme."""
    if not isinstance(value, str) or not value.strip():
        return None
    full = urljoin(base, value.strip()) if base else value.strip()
    return full if full.lower().startswith(("https://", "http://")) else None


def _host(url):
    return urlparse(url).netloc.lower().removeprefix("www.")


def _origin(url):
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def _public(url):
    """Vrai si l'hôte de l'adresse ne désigne que des adresses publiques (pas de réseau interne,
    ni par son nom, ni après une redirection)."""
    netloc = urlparse(url).netloc.lower()
    host = (urlparse(url).hostname or "").lower()
    if not host or not SAFE_HOST.match(netloc):
        return False
    if host not in _public_hosts:
        try:
            infos = socket.getaddrinfo(host, None)
            ips = {ipaddress.ip_address(i[4][0].split("%")[0]) for i in infos}
            _public_hosts[host] = bool(ips) and all(ip.is_global for ip in ips)
        except (OSError, ValueError):
            _public_hosts[host] = False
    return _public_hosts[host]


def _wait(url):
    host = _host(url)
    delay = PAUSE - (time.time() - _last_hit.get(host, 0.0))
    if delay > 0:
        time.sleep(delay)
    _last_hit[host] = time.time()


def _read(url, limit=MAX_PAGE, content_type=None):
    """Texte d'une réponse, sans suivre les redirections (_Redirect, chacune est vérifiée par
    _get) ; None si elle dépasse limit octets ou READ_SECONDS secondes. PageError si la réponse
    est en erreur (status). content_type : liste complétée du type de contenu reçu."""
    started = time.monotonic()
    with SESSION.get(url, headers=HEADERS, timeout=(10, 20), stream=True, allow_redirects=False) as r:
        status = getattr(r, "status_code", 200)
        location = r.headers.get("location")
        if status in (301, 302, 303, 307, 308) and location:
            raise _Redirect(location)
        if status >= 400:
            raise PageError(f"page inaccessible (HTTP {status})", status)
        if content_type is not None:
            content_type.append(r.headers.get("content-type") or "")
        if int(r.headers.get("content-length") or 0) > limit:
            return None
        chunks, size = [], 0
        for chunk in r.iter_content(8192):
            size += len(chunk)
            if size > limit or time.monotonic() - started > READ_SECONDS:
                return None
            chunks.append(chunk)
        # Sans jeu de caractères annoncé, requests suppose ISO-8859-1 : UTF-8 est bien plus courant
        declared = "charset" in (r.headers.get("content-type") or "").lower()
        encoding = (r.encoding if declared else None) or "utf-8"
        return b"".join(chunks).decode(encoding, errors="replace")


def _get(url, limit=MAX_PAGE, robots=True, content_type=None):
    """Page lue en suivant au plus MAX_REDIRECTS redirections, chaque étape vérifiée : http(s),
    adresse publique, robots.txt du site (robots=True), pause entre deux pages, durée de la salle."""
    for _ in range(MAX_REDIRECTS + 1):
        if not _web(url):
            raise PageError("adresse invalide")
        if _deadline[0] is not None and time.monotonic() > _deadline[0]:
            raise PageError("durée de lecture de la salle dépassée")
        if not _public(url):
            raise PageError("adresse introuvable ou non publique")
        if robots and not _robots_ok(url):
            raise PageError("lecture interdite par le site (robots.txt)")
        _wait(url)
        try:
            text = _read(url, limit, content_type)
        except _Redirect as moved:
            url = urljoin(url, moved.location)
            continue
        except PageError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise PageError(f"page inaccessible ({exc.__class__.__name__})") from exc
        if text is None:
            raise PageError("page trop lourde ou trop lente")
        page = Page(text)
        page.url = url
        return page
    raise PageError("trop de redirections")


def _robots_ok(url):
    """robots.txt du site : absent (404), tout est permis ; refusé (401, 403) ou en panne (5xx),
    rien ne l'est ; injoignable, tout est permis (la page elle-même échouera sans doute)."""
    origin = _origin(url)
    if origin not in _robots:
        rules = RobotFileParser()
        try:
            kind = []
            text = _get(origin + "/robots.txt", MAX_ROBOTS, robots=False, content_type=kind)
            if "html" in (kind[0] if kind else "").lower():
                rules = None            # page d'erreur déguisée : pas de règles
            else:
                rules.parse(text.splitlines())
        except PageError as exc:
            if exc.status in (401, 403) or (exc.status or 0) >= 500:
                rules.disallow_all = True
            else:
                rules = None
        _robots[origin] = rules
    rules = _robots[origin]
    return rules is None or rules.can_fetch(ROBOTS_AGENT, url)


def fetch_page(url):
    """Page d'un site de salle (voir _get) ; PageError si illisible."""
    return _get(url)


# --- Dates, heures, titres ----------------------------------------------------------------

def _make_date(year, month, day, today):
    try:
        if year is None:
            # Sans année : la prochaine occurrence (« 12 janvier » lu en octobre = l'an prochain) ;
            # plus de 10 mois plus tard, c'est plutôt une date passée (archives) : écartée
            for y in (today.year, today.year + 1):
                try:
                    d = date(y, month, day)
                except ValueError:      # 29 février
                    continue
                if d >= today - timedelta(days=1):
                    return d if (d - today).days <= 300 else None
            return None
        year = int(year)
        return date(year + 2000 if year < 100 else year, month, day)
    except ValueError:
        return None


def find_date(text, today=None):
    """Première date du texte : ISO, « 23 oct. 2026 », « jeudi 16 octobre », « Oct 16 », « 16/10 »."""
    today = today or date.today()
    t = fold(str(text).replace("€", " eur "))   # le symbole disparaîtrait au repli ASCII
    candidates = []
    for m in DATE_ISO.finditer(t):
        candidates.append((m.start(), _make_date(m[1], int(m[2]), int(m[3]), today)))
        break
    m = DATE_DAY_MONTH.search(t)
    if m:
        candidates.append((m.start(), _make_date(m[3], MONTHS[m[2]], int(m[1]), today)))
    m = DATE_MONTH_DAY.search(t)
    if m:
        candidates.append((m.start(), _make_date(m[3], MONTHS[m[1]], int(m[2]), today)))
    m = DATE_NUMERIC.search(t)
    if m and 1 <= int(m[2]) <= 12:
        candidates.append((m.start(), _make_date(m[3], int(m[2]), int(m[1]), today)))
    found = sorted((pos, d) for pos, d in candidates if d)
    return found[0][1] if found else None


def _clock(start):
    """Heure d'une date ISO (« 2026-10-30T19:30:00+01:00 ») ; minuit = heure non donnée."""
    t = start[11:16]
    return t if re.fullmatch(r"\d\d:\d\d", t) and t != "00:00" else None


def find_time(text):
    """Première heure du texte (« 20h30 », « 20h », « 19:30 ») au format HH:MM, ou None."""
    for m in TIME_RE.finditer(fold(text)):
        minutes = m[2] or m[3] or "00"
        return f"{int(m[1]):02d}:{minutes}"
    return None


def _is_meta(part):
    """Morceau de carte qui n'est pas un titre : date, jour, mois, heure, bouton, prix…"""
    f = fold(part).strip(" .:-–|•")
    if not f or NOISE.match(part.strip()) or WEEKDAY.match(f) or f in MONTHS:
        return True
    if re.fullmatch(r"[\d\s:h\-–―/.•|>]+", f):
        return True
    if f in GENERIC_TITLES or f in NOT_CONCERT:
        return True
    return len(part) < 30 and find_date(part) is not None


def title_of(parts, url=""):
    """Titre d'une carte : le morceau de texte le plus proche du nom du lien (« alex-cameron »
    pour « Alex Cameron »), sinon le premier morceau qui n'est pas une date, un bouton ou un genre."""
    keep = list(dict.fromkeys(p for p in parts if not _is_meta(p)))
    if not keep:
        return None
    slug = words(urlparse(url).path.rstrip("/").rsplit("/", 1)[-1])
    if slug:
        def closeness(p):
            w = words(p)
            return (len(w & slug) / max(1, len(w | slug)), -abs(len(p) - 40))
        best = max(keep, key=closeness)
        if words(best) & slug:
            return best[:200]
    return keep[0][:200]


def category_of(parts):
    """Libellé de carte qui ne désigne pas un concert (club, cabaret, atelier…), ou None."""
    for p in parts:
        f = fold(p).strip(" .:-–|•")
        if f in NOT_CONCERT:
            return f
    return None


# --- Méthode 1 : fiches schema.org de la page -----------------------------------------------

def _walk(node):
    if isinstance(node, list):
        for x in node:
            yield from _walk(x)
    elif isinstance(node, dict):
        types = node.get("@type")
        types = [types] if isinstance(types, str) else (types or [])
        if any(str(t).lower() in EVENT_TYPES for t in types):
            yield node
        for k in ("@graph", "itemListElement", "item", "subEvent", "event", "events"):
            if k in node:
                yield from _walk(node[k])


def _names(value):
    if not value:
        return []
    value = value if isinstance(value, list) else [value]
    return [v.get("name") if isinstance(v, dict) else str(v) for v in value if v]


def from_json_ld(page, base):
    out = []
    for block in LD_RE.findall(page):
        try:
            found = list(_walk(json.loads(block.strip())))
        except (ValueError, RecursionError):   # bloc invalide ou imbriqué à l'excès
            continue
        for ev in found:
            try:
                event = _ld_event(ev, base)
                if event:
                    event["page"] = base        # page lue : lien de secours sans adresse propre
                    out.append(event)
            except (TypeError, AttributeError, ValueError):   # fiche mal formée : ignorée
                continue
    return out


def _ld_event(ev, base):
    """Fiche schema.org Event -> événement lu, ou None sans date de début exploitable."""
    start = str(ev.get("startDate") or "")
    m = DATE_ISO.match(start)
    if not m:
        return None
    day = date(int(m[1]), int(m[2]), int(m[3]))
    offers = ev.get("offers") or {}
    offers = offers[0] if isinstance(offers, list) and offers else offers
    price = offers.get("price") if isinstance(offers, dict) else None
    image = ev.get("image")
    image = image[0] if isinstance(image, list) and image else image
    image = image.get("url") if isinstance(image, dict) else image
    place = ev.get("location") or {}
    place = place[0] if isinstance(place, list) and place else place
    address = place.get("address") if isinstance(place, dict) else None
    city = address.get("addressLocality") if isinstance(address, dict) else None
    keywords = ev.get("keywords")
    return {
        "title": htmllib.unescape(str(ev.get("name") or "")).strip()[:200] or None,
        "date": day,
        "time": _clock(start),
        "url": _web(ev.get("url"), base) if isinstance(ev.get("url"), str) else None,
        "artists": [htmllib.unescape(str(n)).strip() for n in _names(ev.get("performer")) if isinstance(n, str) and n],
        "price": f"{price} €" if isinstance(price, (int, float, str)) and price not in ("", 0, "0") else None,
        "image": _web(image, base) if isinstance(image, str) else None,
        "city": str(city).strip().title() if isinstance(city, str) and city.strip() else None,
        "genre": keywords if isinstance(keywords, str) and len(keywords) < 60 else None,
        "category": None,
    }


# --- Méthode 2 : cartes de la page ---------------------------------------------------------

def _internal(href, base):
    """Adresse absolue d'un lien interne qui peut mener à un concert, ou None."""
    url = _web(htmllib.unescape(href or "").strip(), base)
    if not url:
        return None
    p = urlparse(url)
    url = urlunparse(p._replace(fragment=""))
    path = p.path.rstrip("/")
    if (_host(url) != _host(base) or not path or ":" in path or SKIP_PATH.search(path)
            or re.search(r"[?&](lang|ical|outlook|share|replytocom)=", url)):
        return None
    if url.rstrip("/") == base.rstrip("/"):
        return None
    return url


def link_groups(root, base):
    """{dossier: [adresses]} des liens internes regroupés par dossier parent (« /agenda »),
    groupes d'au moins MIN_GROUP liens ; et {adresse: [balises <a>]}."""
    anchors = defaultdict(list)
    for a in root.links():
        url = _internal(a.attrs.get("href"), base)
        if url:
            anchors[url].append(a)
    groups = defaultdict(list)
    for url in anchors:
        groups[urlparse(url).path.rstrip("/").rsplit("/", 1)[0]].append(url)
    return {k: v for k, v in groups.items() if len(v) >= MIN_GROUP}, anchors


def _clean(parts):
    return [s for s in (re.sub(r"\s+", " ", p).strip() for p in parts) if s]


def from_cards(page, base, root=None):
    root = root or htmltree.parse(page)
    groups, anchors = link_groups(root, base)
    if sum(len(v) for v in anchors.values()) > MAX_LINKS:
        return []
    sizes = htmltree.text_sizes(root)
    today = date.today()
    best = []
    # Les plus grands groupes d'abord, MAX_GROUPS au plus (menus, pieds de page : petits groupes)
    for urls in sorted(groups.values(), key=len, reverse=True)[:MAX_GROUPS]:
        # Pour chaque bloc : adresses du groupe qu'il contient (la carte d'un lien n'en a qu'une)
        inside = defaultdict(set)
        for url in urls:
            for a in anchors[url]:
                node, level = a, 0
                while node is not None and level <= MAX_CLIMB:
                    inside[id(node)].add(url)
                    node, level = node.parent, level + 1
        found, seen = [], set()
        for url in urls:
            card = anchors[url][0]
            # Carte : on remonte tant que le bloc parent ne contient que ce lien et reste de taille
            # raisonnable (un bloc très long n'est plus une carte, et coûterait cher à lire)
            while (card.parent is not None and card.parent.tag != "root" and len(inside[id(card.parent)]) == 1
                   and sizes.get(id(card.parent), 0) <= MAX_CARD_TEXT):
                card = card.parent
            if sizes.get(id(card), 0) > MAX_CARD_TEXT:
                continue
            parts = _clean(card.texts())
            text = " | ".join(parts)
            m = DATE_ISO.search(urlparse(url).path)   # date dans l'adresse du lien : la plus sûre
            day = _make_date(m[1], int(m[2]), int(m[3]), today) if m else find_date(text, today)
            if not day or (url, day) in seen:
                continue
            seen.add((url, day))
            image = next((_web(n.attrs.get("src") or n.attrs.get("data-src"), base)
                          for n in [card] + [c for c in card._walk() if isinstance(c, htmltree.Node)]
                          if n.tag == "img" and (n.attrs.get("src") or n.attrs.get("data-src"))), None)
            found.append({"title": title_of(parts, url), "date": day, "time": find_time(text), "url": url,
                          "artists": [], "price": None, "image": image, "city": None, "genre": None,
                          "category": category_of(parts), "card": True})
        if len(found) > len(best):
            best = found
    return best


# --- Méthode 3 : agenda WordPress « The Events Calendar » -----------------------------------

def from_wordpress(base):
    url = f"{_origin(base)}/wp-json/tribe/events/v1/events?per_page=50&start_date={date.today().isoformat()}"
    try:
        data = json.loads(fetch_page(url))
    except (PageError, ValueError, RecursionError):
        return []
    events = data.get("events") if isinstance(data, dict) else None
    out = []
    for ev in events if isinstance(events, list) else []:
        try:
            start = str(ev.get("start_date") or "")
            m = DATE_ISO.match(start)
            if not m:
                continue
            image = ev.get("image")
            out.append({
                "title": re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", str(ev.get("title") or "")))).strip()[:200] or None,
                "date": date(int(m[1]), int(m[2]), int(m[3])),
                "time": _clock(start),
                "url": _web(ev.get("url")) if isinstance(ev.get("url"), str) else None, "page": base,
                "artists": [], "price": None,
                "image": _web(image.get("url")) if isinstance(image, dict) and isinstance(image.get("url"), str) else None,
                "city": None, "genre": None, "category": None,
            })
        except (TypeError, AttributeError, ValueError):   # entrée mal formée : ignorée
            continue
    return out


# --- Méthode 4 : pages de concert ------------------------------------------------------------

def from_detail_pages(root, base):
    groups, _ = link_groups(root, base)
    if not groups:
        return []
    urls = max(groups.values(), key=len)[:MAX_DETAIL_PAGES]
    out, misses = [], 0
    for url in urls:
        try:
            events = from_json_ld(fetch_page(url), url)
        except PageError:
            events = []
        if not events:
            misses += 1
            if not out and misses >= DETAIL_GIVE_UP:
                break
            continue
        # Une page de concert peut citer d'autres concerts : on garde le sien
        own = [e for e in events if (e["url"] or url).rstrip("/") == url.rstrip("/")]
        out.extend(own or events[:1])
    return out


# --- Lecture d'une salle ---------------------------------------------------------------------

def agenda_links(root, base):
    """Liens internes qui ressemblent à une page programme (page d'accueil donnée par erreur)."""
    out = []
    for a in root.links():
        url = _internal(a.attrs.get("href"), base)
        if not url or url in out:
            continue
        # Dernier dossier de l'adresse (« /fr/programmation ») ou libellé du lien (« Agenda ») ; pas
        # les pages de concert (« /agenda/alex-cameron »)
        last = fold(urlparse(url).path.rstrip("/").rsplit("/", 1)[-1])
        label = fold(" ".join(a.texts())).strip()
        if AGENDA_HINT.fullmatch(last) or (len(label) <= 30 and AGENDA_HINT.fullmatch(re.sub(r"^(l'|la |le |les |nos |notre )", "", label))):
            out.append(url)
    return out[:MAX_AGENDA_LINKS]


def read_venue(url, reference=None, quick=False):
    """Concerts de la page programme d'une salle, en VENUE_SECONDS secondes au plus.

    reference : concerts de la salle déjà connus par les billetteries [(date ISO, titre)], pour le
    contrôle. quick : salle déjà illisible la semaine précédente, méthodes rapides seulement (ni
    pages de concert, ni recherche de la page programme). Renvoie {"ok", "method", "url", "events"
    (lus, concerts et autres), "structured" (concerts des données publiées par le site), "reasons",
    "stats", "sample"}.
    """
    _deadline[0] = time.monotonic() + VENUE_SECONDS
    try:
        with _time_limit(VENUE_SECONDS + 20):
            return _read_venue(url, reference, follow=True, quick=quick)
    except _Timeout:
        return {"ok": False, "method": "aucune", "url": url, "events": [], "structured": [],
                "reasons": ["lecture trop longue, interrompue"],
                "stats": {"upcoming": 0, "concerts": 0, "past": 0, "agreement": None}, "sample": []}
    finally:
        _deadline[0] = None


def _read_venue(url, reference, follow, quick):
    from ..venue_check import check   # import local : venue_check importe ce module

    def result(method, events, page_url):
        verdict = check(events, reference)
        return {"method": method, "url": page_url, "events": events, **verdict}

    try:
        page = fetch_page(url)
    except PageError as exc:
        return {**result("aucune", [], url), "ok": False, "reasons": [str(exc)], "structured": []}
    url = getattr(page, "url", None) or url    # adresse finale (redirections)
    root = htmltree.parse(page)

    best = result("aucune", [], url)
    structured = []   # concerts des données publiées par le site (salle déjà au catalogue)

    def better(candidate):
        nonlocal structured
        if candidate["method"] in STRUCTURED and len(candidate["events"]) > len(structured):
            structured = candidate["events"]
        return (candidate["ok"], candidate["stats"]["upcoming"]) > (best["ok"], best["stats"]["upcoming"])

    for method, run in (("fiches de la page", lambda: from_json_ld(page, url)),
                        ("cartes de la page", lambda: from_cards(page, url, root)),
                        ("agenda WordPress", lambda: from_wordpress(url))):
        candidate = result(method, run(), url)
        if better(candidate):
            best = candidate
        if best["ok"] and best["stats"]["upcoming"] >= 5:
            return {**best, "structured": structured}
    if not best["ok"] and not quick:
        candidate = result("pages de concert", from_detail_pages(root, url), url)
        if better(candidate):
            best = candidate
    if not best["ok"] and follow and not quick:
        for link in agenda_links(root, url):
            candidate = _read_venue(link, reference, follow=False, quick=False)
            if len(candidate.get("structured") or []) > len(structured):
                structured = candidate["structured"]
            if better(candidate):
                best = candidate
            if best["ok"]:
                break
    return {**best, "structured": structured}


def to_events(venue_name, events):
    """Concerts au format des sources (catalogue commun) ; cartes « club », « atelier »… écartées."""
    today, horizon = date.today(), date.today() + timedelta(days=HORIZON_DAYS)
    out = []
    for ev in events:
        if ev.get("category") or not ev.get("title") or not (today <= ev["date"] <= horizon):
            continue
        out.append({
            "source": f"Site {venue_name}",
            "source_id": ev.get("url") or f"{venue_name}-{ev['date'].isoformat()}-{ev['title'][:40]}",
            "title": ev["title"],
            "date": ev["date"].isoformat(),
            "time": ev.get("time"),
            "venue": venue_name,
            "address": None,
            "city": ev.get("city") or "Paris",
            "lat": None,
            "lon": None,
            "url": ev.get("url") or ev.get("page"),
            "on_sale": None,
            "price": ev.get("price"),
            "status": None,
            "artists": ev.get("artists") or [],
            "genre": ev.get("genre"),
            "image": ev.get("image"),
            "title_only": not ev.get("artists"),
        })
    return out


def reference_for(venue, events):
    """Concerts déjà connus de la salle dans une liste d'événements des billetteries :
    [(date ISO, titre)] (rapprochement par nom de salle et autres noms, comme match.VenueMatcher)."""
    from ..match import VenueMatcher
    matcher = VenueMatcher({"venues": [{"id": venue.get("id"), "name": venue["name"],
                                        "aliases": venue.get("aliases") or []}]})
    return [(e["date"], e.get("title") or "") for e in events or []
            if e.get("date") and not str(e.get("source", "")).startswith("Site ") and matcher.canonical(e.get("venue") or "")]


def fetch(venues_cfg, others=None, failures=None, readable=None):
    """venues_cfg : catalogue commun des salles (catalog.load). others : concerts déjà lus par les
    autres sources (contrôle). failures : liste complétée des salles dont la lecture a échoué.
    readable : liste complétée des salles lues (état enregistré par la tâche commune).
    Une salle déjà illisible la semaine précédente (check_status failed) est lue par les méthodes
    rapides seulement ; la source entière dure SOURCE_SECONDS au plus."""
    events = []
    started = time.monotonic()
    for v in venues_cfg.get("venues", []):
        url = (v.get("agenda_url") or "").strip()
        if not url:
            continue
        if time.monotonic() - started > SOURCE_SECONDS:
            log(f"  {v['name']} : non lue (durée de la source dépassée)")
            continue
        try:
            got = read_venue(url, reference_for(v, others), quick=v.get("check_status") == "failed")
        except Exception as exc:  # noqa: BLE001  une salle en panne n'arrête pas les autres
            got = {"ok": False, "reasons": [f"erreur de lecture ({exc.__class__.__name__})"], "events": [],
                   "method": "aucune", "structured": []}
        found = to_events(v["name"], got["events"]) if got["ok"] else []
        method = got.get("method")
        # Salle déjà au catalogue : les concerts de ses données publiées (schema.org, WordPress)
        # restent pris même si le contrôle, fait pour l'ajout d'une salle, échoue (une ou deux
        # dates seulement, ou cartes « club » plus nombreuses)
        if not got["ok"] and to_events(v["name"], got.get("structured") or []):
            found, method = to_events(v["name"], got["structured"]), "données publiées par le site"
        if not found and not got["ok"]:
            log(f"  {v['name']} : lecture refusée ({'; '.join(got['reasons'])})")
            if failures is not None:
                failures.append({"id": v.get("id"), "name": v["name"], "url": url, "reasons": got["reasons"],
                                 "was": v.get("check_status")})
            continue
        if readable is not None:
            readable.append(v.get("id"))
        log(f"  {v['name']} : {len(found)} concerts ({method})")
        events += found
    return events
