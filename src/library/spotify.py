"""Bibliothèque d'un membre sur Spotify (spécification, sections 6.3 à 6.5).

Accès : jeton de rafraîchissement du membre, chiffré en D1 (AES-GCM, clé TOKEN_ENC_KEY partagée
avec les fonctions Pages, functions/_lib/tokens.js) ; un jeton d'accès (1 h) est demandé à
chaque calcul et n'est jamais stocké. Si Spotify renvoie un nouveau jeton de rafraîchissement,
il remplace l'ancien. Réponse invalid_grant (accès retiré par le membre, jeton expiré au bout de
180 jours) : SourceError("revoked"), la source passe en statut revoked.

Lecture (points d'accès ouverts en mode développement) : artistes suivis, albums sauvegardés,
titres likés, titres des playlists du membre (possédées ou collaboratives), artistes les plus
écoutés (long et moyen terme). Respect de Retry-After sur 429 ; pause entre les appels (quota
commun avec la fiche de partage).

Les découvertes reposent sur les artistes similaires de Deezer : chaque artiste Spotify est
rapproché d'un artiste Deezer (deezer.search_artist, cache commun). Rapproché : identifié par
son id Deezer, l'id Spotify est gardé (lien d'écoute). Sinon : identifiant sp:<id>, utile au
rapprochement des concerts par nom, pas aux découvertes.

Journaux : identifiant du membre (par l'appelant), compteurs, codes HTTP ; jamais de jeton, de
nom d'artiste ni d'identifiant Spotify.
"""
import base64
import os
import re
import time
from collections import defaultdict
from datetime import datetime

import requests

from .. import deezer
from ..util import log, norm
from .base import IGNORED, SourceError, build, new_counts

API = "https://api.spotify.com/v1"
TOKEN_URL = "https://accounts.spotify.com/api/token"
PAUSE = 0.15            # entre deux appels réussis (quota commun à tous les membres et au partage)
MAX_RETRY_AFTER = 120   # au-delà, le calcul du membre s'arrête (quota) et reprendra plus tard
TOP_RANGES = ("long_term", "medium_term")


# --- Chiffrement du jeton de rafraîchissement (même format que functions/_lib/tokens.js) ------

def _b64decode(text):
    text = str(text).replace("+", "-").replace("/", "_")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _b64encode(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _cipher():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # dépendance des seuls membres Spotify

    try:
        key = _b64decode(os.environ.get("TOKEN_ENC_KEY", ""))
    except ValueError:
        key = b""
    if len(key) != 32:
        raise SourceError("token_key", "TOKEN_ENC_KEY absente ou invalide")
    return AESGCM(key)


def encrypt(user_id, token):
    iv = os.urandom(12)
    sealed = _cipher().encrypt(iv, token.encode(), user_id.encode())
    return f"v1.{_b64encode(iv)}.{_b64encode(sealed)}"


def decrypt(user_id, value):
    from cryptography.exceptions import InvalidTag

    parts = str(value or "").split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise SourceError("token_key", "jeton chiffré illisible")
    try:
        return _cipher().decrypt(_b64decode(parts[1]), _b64decode(parts[2]), user_id.encode()).decode()
    except (InvalidTag, ValueError):
        # Clé changée ou jeton d'un autre membre : pas une révocation, le jeton est gardé
        raise SourceError("token_key", "jeton indéchiffrable avec la clé actuelle") from None


# --- Appels Spotify -------------------------------------------------------------------------

def _path(url):
    """Adresse sans identifiant Spotify ni paramètre (journaux)."""
    path = str(url).split("?", 1)[0].replace(API, "")
    return re.sub(r"/(playlists|artists|albums|tracks|users)/[^/]+", r"/\1/…", path)


class Client:
    """Appels à l'API Web pour un membre. access : members.SpotifyAccess (jeton chiffré en D1)."""

    def __init__(self, access):
        self.access = access
        self.client_id = os.environ.get("SPOTIFY_CLIENT_ID")
        self.client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
        if not self.client_id or not self.client_secret:
            raise SourceError("spotify_unconfigured", "SPOTIFY_CLIENT_ID ou SPOTIFY_CLIENT_SECRET absent")
        self.session = requests.Session()
        self.token = None
        self.calls = 0

    def _refresh(self):
        enc = self.access.token()
        if not enc:
            raise SourceError("revoked", "aucun jeton enregistré")
        refresh = decrypt(self.access.user_id, enc)
        for attempt in range(4):
            try:
                r = self.session.post(TOKEN_URL, data={"grant_type": "refresh_token", "refresh_token": refresh},
                                      auth=(self.client_id, self.client_secret), timeout=30)
            except requests.RequestException as exc:
                log(f"  Spotify : erreur réseau ({exc.__class__.__name__}), nouvelle tentative")
                time.sleep(3 * (attempt + 1))
                continue
            self.calls += 1
            if r.status_code == 200:
                data = r.json()
                self.token = data["access_token"]
                if data.get("refresh_token") and data["refresh_token"] != refresh:
                    self.access.replace(encrypt(self.access.user_id, data["refresh_token"]))
                    log("  Spotify : jeton de rafraîchissement renouvelé")
                return
            error = ""
            try:
                error = r.json().get("error", "")
            except ValueError:
                pass
            if r.status_code == 400 and error == "invalid_grant":
                # Source passée en revoked (le membre voit « Reconnecter Spotify ») ; si le membre
                # s'est reconnecté pendant le calcul, son nouveau jeton est gardé
                if not self.access.revoke():
                    raise SourceError("superseded", "reconnecté pendant le calcul")
                raise SourceError("revoked", "accès retiré ou expiré")
            if r.status_code == 429 or r.status_code >= 500:
                self._wait(r, attempt)
                continue
            raise SourceError("spotify_unavailable", f"jeton refusé (HTTP {r.status_code} {error})".strip())
        raise SourceError("spotify_unavailable", "jeton indisponible")

    def _wait(self, r, attempt):
        wait = 5 * (attempt + 1)
        if r.status_code == 429:
            try:
                wait = int(r.headers.get("Retry-After", wait))
            except ValueError:
                pass
            if wait > MAX_RETRY_AFTER:
                raise SourceError("quota", f"Retry-After {wait} s")
            log(f"  Spotify : quota, pause de {wait} s")
        time.sleep(wait + 1)

    def get(self, url, params=None, forbidden_ok=False):
        """JSON de la réponse ; None pour 404 (ou 403 si forbidden_ok)."""
        renewed = False
        for attempt in range(5):
            if not self.token:
                self._refresh()
            try:
                r = self.session.get(url, params=params, headers={"authorization": f"Bearer {self.token}"}, timeout=30)
            except requests.RequestException as exc:
                log(f"  Spotify : erreur réseau ({exc.__class__.__name__}), nouvelle tentative")
                time.sleep(3 * (attempt + 1))
                continue
            self.calls += 1
            if r.status_code == 401 and not renewed:   # jeton d'accès expiré pendant la lecture
                self.token, renewed = None, True
                continue
            if r.status_code == 429 or r.status_code >= 500:
                self._wait(r, attempt)
                continue
            if r.status_code == 403:
                if forbidden_ok:
                    return None
                # Compte absent de User Management (ou retiré par l'admin)
                raise SourceError("not_allowlisted", f"HTTP 403 sur {_path(url)}")
            if r.status_code == 404:
                return None
            if r.status_code >= 400:
                raise SourceError("spotify_unavailable", f"HTTP {r.status_code} sur {_path(url)}")
            time.sleep(PAUSE)
            return r.json()
        raise SourceError("spotify_unavailable", f"pas de réponse sur {_path(url)}")

    def pages(self, url, params=None, key=None, forbidden_ok=False):
        """Tous les éléments d'une liste paginée (next) ; key : bloc de la réponse qui porte la
        liste (« artists » pour les artistes suivis, à curseur). None si la liste est refusée."""
        items = []
        data = self.get(url, params, forbidden_ok)
        if data is None:
            return None if forbidden_ok else items
        while data:
            block = data.get(key, {}) if key else data
            items.extend(i for i in block.get("items", []) if i)
            nxt = block.get("next")
            data = self.get(nxt, forbidden_ok=forbidden_ok) if nxt else None
        return items


# --- Lecture de la bibliothèque ---------------------------------------------------------------

def _timestamp(iso):
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _picture(images):
    """Image d'environ 300 px (la liste Spotify va de la plus grande à la plus petite)."""
    images = [i for i in images or [] if i.get("url")]
    if not images:
        return None
    return min(images, key=lambda i: abs((i.get("width") or 300) - 300))["url"]


def read(access, settings, previous):
    """Liste d'artistes du membre (library.base.build) à partir de sa bibliothèque Spotify."""
    sp = Client(access)
    log("  Spotify : lecture de la bibliothèque")
    me = sp.get(f"{API}/me")
    if not me or not me.get("id"):
        raise SourceError("spotify_unavailable", "profil illisible")

    counts = defaultdict(new_counts)
    meta = {}
    added = {}

    def remember(artist):
        """Identifiant Spotify de l'artiste, ou None (artiste générique, titre local)."""
        if not artist or not artist.get("id") or norm(artist.get("name")) in IGNORED:
            return None
        sid = str(artist["id"])
        entry = meta.setdefault(sid, {"name": artist.get("name", ""), "spotify_id": sid,
                                      "link": (artist.get("external_urls") or {}).get("spotify")
                                      or f"https://open.spotify.com/artist/{sid}",
                                      "picture": None})
        if not entry["picture"]:
            entry["picture"] = _picture(artist.get("images"))
        return sid

    def note_added(sid, when):
        ts = _timestamp(when) if when else None
        if sid and ts and ts > added.get(sid, 0):
            added[sid] = ts

    def main_artist(obj):
        """Artiste principal d'un album ou d'un titre (comme Deezer, qui n'en donne qu'un)."""
        return remember(((obj or {}).get("artists") or [None])[0])

    followed = sp.pages(f"{API}/me/following", {"type": "artist", "limit": 50}, key="artists")
    for a in followed:
        sid = remember(a)
        if sid:
            counts[sid]["favorite"] = True

    albums = sp.pages(f"{API}/me/albums", {"limit": 50})
    for entry in albums:
        sid = main_artist(entry.get("album"))
        if sid:
            counts[sid]["albums"] += 1
            note_added(sid, entry.get("added_at"))

    tracks = sp.pages(f"{API}/me/tracks", {"limit": 50})
    for entry in tracks:
        sid = main_artist(entry.get("track"))
        if sid:
            counts[sid]["tracks"] += 1
            note_added(sid, entry.get("added_at"))
    log(f"  {len(followed)} artistes suivis, {len(albums)} albums sauvegardés, {len(tracks)} titres likés")

    if settings.get("include_own_playlists"):
        playlists = sp.pages(f"{API}/me/playlists", {"limit": 50})
        own = [p for p in playlists if (p.get("owner") or {}).get("id") == me["id"] or p.get("collaborative")]
        n, read_ok = 0, 0
        for p in own:
            items = sp.pages(f"{API}/playlists/{p['id']}/items", {"limit": 50}, forbidden_ok=True)
            if items is None:
                continue
            read_ok += 1
            for entry in items:
                # Champ « item » depuis février 2026 (« track » auparavant) ; épisodes et titres locaux ignorés
                obj = entry.get("item") or entry.get("track") or {}
                if obj.get("type", "track") != "track" or entry.get("is_local"):
                    continue
                sid = main_artist(obj)
                if sid:
                    counts[sid]["playlists"] += 1
                    note_added(sid, entry.get("added_at"))
                    n += 1
        log(f"  {len(own)} playlists personnelles ({read_ok} lisibles), {n} titres")

    tops = 0
    for time_range in TOP_RANGES:
        data = sp.get(f"{API}/me/top/artists", {"time_range": time_range, "limit": 50}) or {}
        for a in data.get("items", []):
            sid = remember(a)
            if sid:
                counts[sid]["top"] += 1
                tops += 1
    log(f"  {tops} entrées parmi les artistes les plus écoutés ; {sp.calls} appels Spotify")

    by_id, by_meta, by_added, unmatched, postponed = _to_deezer(counts, meta, added, settings.get("spotify_max_deezer_lookups", 1500))
    log(f"  Rapprochement Deezer : {len(counts) - unmatched} artistes rapprochés, {unmatched} non rapprochés"
        + (f" (dont {postponed} reportés au prochain calcul)" if postponed else ""))
    if len(counts) >= 20 and unmatched > len(counts) / 2:
        log("  Attention : plus de la moitié des artistes non rapprochés de Deezer (Deezer indisponible ?)")

    # Artiste dont l'identifiant a changé depuis le calcul précédent (sp:<id> rapproché de Deezer
    # depuis, par exemple) : l'ancienne entrée passe sous le nouvel identifiant (date de première
    # apparition gardée) au lieu de rester en double
    new_id = {m["spotify_id"]: aid for aid, m in by_meta.items()}
    moved = {}
    for k, v in previous.items():
        target = new_id.get(v.get("spotify_id"))
        if target and target != k and target not in previous:
            moved.setdefault(target, v)
    kept = {k: v for k, v in previous.items() if new_id.get(v.get("spotify_id"), k) == k}
    previous = {**kept, **moved}
    result = build(by_id, by_meta, by_added, previous, settings, "spotify")
    new = sum(1 for a in result.values() if a["first_seen"] == a["last_seen"] and a["still_liked"])
    log(f"  {len(result)} artistes au total, dont {new} nouveaux")
    return result


def _to_deezer(counts, meta, added, max_lookups):
    """Regroupe les artistes Spotify par artiste Deezer (cache commun de recherche) ; les autres
    gardent l'identifiant sp:<id>. Au plus max_lookups recherches nouvelles par calcul (première
    lecture d'une grande bibliothèque) : les suivantes attendent le prochain calcul, artistes les
    mieux notés d'abord. Renvoie (compteurs, fiches, dates, non rapprochés, reportés)."""
    search_cache, related_cache = deezer.load_caches()
    by_id, by_meta, by_added, unmatched, postponed = {}, {}, {}, 0, 0
    lookups = 0
    weight = lambda c: (c["favorite"], c.get("top", 0), c["albums"], c["tracks"], c["playlists"])  # noqa: E731
    for sid, c in sorted(counts.items(), key=lambda kv: weight(kv[1]), reverse=True):
        if norm(meta[sid]["name"]) in search_cache:
            found = search_cache[norm(meta[sid]["name"])]
        elif lookups < max_lookups:
            lookups += 1
            found = deezer.search_artist(meta[sid]["name"], search_cache)
        else:
            found, postponed = None, postponed + 1
        aid = str(found["id"]) if found else f"sp:{sid}"
        unmatched += not found
        if aid in by_id:  # deux fiches Spotify pour un même artiste Deezer
            merged = by_id[aid]
            merged["favorite"] = merged["favorite"] or c["favorite"]
            for k in ("albums", "tracks", "playlists", "top"):
                merged[k] += c.get(k, 0)
        else:
            by_id[aid] = dict(c)
            by_meta[aid] = {**meta[sid], **({"deezer_id": aid} if found else {})}
            if found and not by_meta[aid].get("picture"):
                by_meta[aid]["picture"] = found.get("picture")
        if sid in added and added[sid] > by_added.get(aid, 0):
            by_added[aid] = added[sid]
    deezer.save_caches(search_cache, related_cache)
    return by_id, by_meta, by_added, unmatched, postponed
