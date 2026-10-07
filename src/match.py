"""Salles, dédoublonnage entre sources et rapprochement avec votre liste d'artistes."""
import hashlib
import re
from collections import defaultdict

from .util import norm, norm_venue, today_iso

SOURCE_PRIORITY = {"Ticketmaster": 0, "Bandsintown": 2, "Que faire à Paris": 3, "Offi": 4}
MIN_TITLE_KEY = 4  # longueur minimale d'un nom pour un rapprochement sur le titre seul

# Rapprochement sur le titre seul (sources sans programmation détaillée) :
# - les hommages et reprises ne comptent pas (c'est la musique de l'artiste, pas l'artiste) ;
# - un nom d'un seul mot significatif doit former à lui seul un segment du titre
#   (« Niska », « Avishai Cohen trio »), pas une partie d'un nom plus long (« Michel Alibo ») ;
# - un nom de plusieurs mots est accepté n'importe où dans le titre.
TRIBUTE_RE = re.compile(
    r"\b(tribute|hommage|homage|the music of|the world of|musiques? de|experience|plays|joue|jouent|chante|chantent|"
    r"raconte|celebre|revisite|songbook|show|legacy|heritage|story|symphonique|symphonic|symphonie|films?|"
    r"candlelight|loves?|spirit of)\b")
SEGMENT_RE = re.compile(
    r"\s[-–—:|/]\s|\s{2,}|[:+,&•|/()\[\]]|\s(?:et|and|x|feat|ft|with|avec|invite|invitent|presente)\s", re.I)
GENERIC = {"trio", "quartet", "quartette", "quintet", "quintette", "sextet", "septet", "octet", "duo", "band",
           "live", "orchestra", "orchestral", "en", "concert", "tour", "tournee", "acoustique", "acoustic",
           "unplugged", "solo", "friends", "showcase", "release", "party", "nouvel", "album", "club", "dj", "set"}


def title_names(title):
    """Noms d'artistes plausibles tirés d'un titre (sources sans programmation détaillée) :
    « Guinga et Yamandu Costa » donne « Guinga » et « Yamandu Costa », « Avishai Cohen trio »
    donne « Avishai Cohen trio » puis « Avishai Cohen ». Rien pour un hommage ou une reprise."""
    if TRIBUTE_RE.search(norm(title)):
        return []
    out = []
    for seg in SEGMENT_RE.split(title or ""):
        words = (seg or "").split()
        # Segment complet d'abord (« Lowdown Brass Band »), puis sans mots génériques ni nombres
        clean = [w for w in words if norm(w) not in GENERIC and not norm(w).isdigit()]
        for name in (" ".join(words), " ".join(clean)):
            name = name.strip(" -–—.!?'’")
            if len(norm(name)) >= 3 and name not in out:
                out.append(name)
    return out


def significant_words(key):
    return [w for w in key.split() if len(w) >= 3]


def title_segments(title):
    """Segments normalisés du titre, débarrassés des mots génériques et des années.

    Chaque segment est aussi proposé sans ses nombres (« Oasis Live '27 » donne « oasis »),
    sans les perdre pour les noms qui en contiennent (« French 79 »).
    """
    out = set()
    for seg in SEGMENT_RE.split(title or ""):
        words = [w for w in norm(seg).split() if w not in GENERIC and not re.fullmatch(r"(19|20)\d\d", w)]
        for variant in (words, [w for w in words if not w.isdigit()]):
            if variant:
                out.add(" ".join(variant))
    return out


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
        normed = norm(title)
        if TRIBUTE_RE.search(normed):
            return []
        words = normed.split()
        segments = None
        found = {}
        for n in range(1, 6):
            for i in range(len(words) - n + 1):
                key = " ".join(words[i:i + n])
                if len(key) < MIN_TITLE_KEY or key not in self.by_key:
                    continue
                if len(significant_words(key)) < 2:
                    segments = segments if segments is not None else title_segments(title)
                    if key not in segments:
                        continue
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


def _identities(group):
    """Ce qui reconnaît le concert d'une salle à l'autre : artistes rapprochés, premier artiste,
    titre complet (pas tronqué : « Kiosque en fête au square X » et « ... au square Y » diffèrent)."""
    out = set()
    for ev in group:
        out |= {"a" + m["id"] for m in ev.get("matched") or []}
        if ev.get("artists"):
            out.add("n" + norm(ev["artists"][0]))
        out.add("n" + norm(ev.get("title") or ""))
    out.discard("n")
    return out


# Mots trop courants pour rapprocher deux salles (« Église Saint-Sulpice » et « Église Saint-Eustache »)
VENUE_STOP = {"salle", "grande", "petite", "petit", "grand", "paris", "theatre", "eglise", "saint", "sainte",
              "temple", "club", "cafe", "studio", "maison", "espace", "centre", "musique", "musiques", "music",
              "auditorium", "cathedrale", "basilique", "chapelle", "conservatoire", "square", "jardin", "parc",
              "place", "scene", "live", "bar", "cave", "caveau", "jazz", "arena", "hall", "palais", "opera",
              "institut", "musee", "fondation", "philharmonie", "cite", "pavillon", "kiosque", "bibliotheque",
              "municipal", "municipale"}


def _venue_words(key):
    return {w for w in key.split() if len(w) >= 4 and w not in VENUE_STOP}


def _same_venue(a, b):
    """Deux libellés d'une même salle : identiques, l'un contenu dans l'autre, ou un mot distinctif commun."""
    if a == b or (a and b and (f" {a} " in f" {b} " or f" {b} " in f" {a} ")):
        return True
    return bool(_venue_words(a) & _venue_words(b))


def _minutes(group):
    out = set()
    for ev in group:
        t = ev.get("time") or ""
        if len(t) >= 5 and t[:5] != "00:00":
            out.add(int(t[:2]) * 60 + int(t[3:5]))
    return out


def _close_times(a, b):
    ta, tb = _minutes(a), _minutes(b)
    return not ta or not tb or any(abs(x - y) <= 60 for x in ta for y in tb)


def dedupe(events):
    """Fusionne un même concert vu par plusieurs sources.

    1. Même date, même salle (libellé normalisé), même artiste ou titre.
    2. Puis, le même jour, les groupes qui partagent un artiste ou un titre et dont les
       salles sont deux libellés d'un même lieu (« SUPERSONIC » et « Supersonic Club »),
       sauf si leurs horaires diffèrent de plus d'une heure.
    """
    groups = defaultdict(list)
    for ev in events:
        groups[(ev["date"], ev["venue_key"], _identity(ev))].append(ev)

    keys = list(groups)
    parent = {k: k for k in keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    by_date = defaultdict(list)
    for k in keys:
        by_date[k[0]].append((k, _identities(groups[k])))
    for items in by_date.values():
        for i, (ka, ida) in enumerate(items):
            for kb, idb in items[i + 1:]:
                if (ka[1] != kb[1] and ida & idb and _same_venue(ka[1], kb[1])
                        and _close_times(groups[ka], groups[kb])):
                    parent[find(kb)] = find(ka)

    clusters = defaultdict(list)
    for k in keys:
        clusters[find(k)].append(k)

    merged = []
    for root, members in clusters.items():
        group = [ev for k in members for ev in groups[k]]
        key = min(members)
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
