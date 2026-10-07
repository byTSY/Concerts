"""Fonctions communes : normalisation des noms, appels HTTP, lecture et écriture JSON."""
import json
import math
import re
import time
import unicodedata
from datetime import date
from pathlib import Path

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
SITE_DATA = ROOT / "site" / "data"

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "concerts-paris/1.0 (usage personnel)"


def log(msg):
    print(msg, flush=True)


def today_iso():
    return date.today().isoformat()


def norm(text):
    """Nom comparable : sans accents, minuscules, ponctuation retirée, 'the' initial retiré."""
    if not text:
        return ""
    # Apostrophes en espace avant la translittération, sinon « d’une » devient « dune »
    s = re.sub(r"['’‘`´]", " ", str(text))
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^the ", "", s)
    return s


ARTICLES = re.compile(r"^(le|la|les|l)\s+")


def norm_venue(text):
    return ARTICLES.sub("", norm(text))


def load_yaml(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_json(path, default):
    path = Path(path)
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=False)


def get_json(url, params=None, pause=0.0, retries=3, timeout=30):
    """GET avec quelques tentatives. Renvoie le JSON, ou None en cas d'échec définitif."""
    for attempt in range(retries):
        try:
            r = SESSION.get(url, params=params, timeout=timeout)
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code >= 400:
                log(f"  HTTP {r.status_code} sur {r.url[:120]}")
                return None
            if pause:
                time.sleep(pause)
            return r.json()
        except (requests.RequestException, ValueError) as exc:
            log(f"  Erreur réseau ({exc.__class__.__name__}), nouvelle tentative")
            time.sleep(2 * (attempt + 1))
    return None


def distance_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
