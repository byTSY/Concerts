"""Accès à Cloudflare D1 (base SQL) et R2 (fichiers), avec un équivalent local pour les essais.

D1 : API REST Cloudflare (/d1/database/{id}/query) si CF_ACCOUNT_ID, D1_DATABASE_ID et
CF_D1_API_TOKEN sont définis ; sinon base SQLite locale data/local/concerts.db (même schéma).
R2 : API compatible S3 (boto3) si R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY et R2_BUCKET sont
définis ; sinon dossier local data/local/r2/.

Dans GitHub Actions, l'équivalent local est refusé : un secret manquant arrête le traitement
au lieu d'écrire des résultats qui ne seraient vus par personne.
"""
import json
import os
import re
import sqlite3
import time

import requests
from urllib3.exceptions import NewConnectionError

from .util import DATA, log

LOCAL = DATA / "local"
MIGRATIONS = DATA.parent / "migrations"


class CloudError(RuntimeError):
    pass


def _env(*names):
    values = [os.environ.get(n) for n in names]
    return values if all(values) else None


def _local_allowed(what, remote_only=False):
    if remote_only:
        raise CloudError(f"{what} : variables Cloudflare absentes ou incomplètes (copie locale refusée)")
    if os.environ.get("GITHUB_ACTIONS"):
        raise CloudError(f"{what} : secrets Cloudflare absents dans GitHub Actions")


# --- D1 -------------------------------------------------------------------------

# Lecture : première instruction SELECT (ou WITH … SELECT), sans écriture dans la requête
_READ = re.compile(r"^\s*(select|with)\b", re.I)
_WRITE_WORDS = re.compile(r"\b(insert|update|delete|replace|create|alter|drop)\b", re.I)


def _is_read(sql):
    return bool(_READ.match(sql)) and not _WRITE_WORDS.search(sql)


def _not_sent(exc):
    """Vrai si la requête n'a pas pu partir : délai de connexion, ou connexion impossible
    (nom introuvable, refus) avant tout envoi. Une connexion coupée en cours de réponse ne
    compte pas : la requête a pu être exécutée."""
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return True
    if not isinstance(exc, requests.exceptions.ConnectionError):
        return False
    inner = exc.args[0] if exc.args else None           # MaxRetryError de urllib3, en général
    reason = getattr(inner, "reason", inner)
    return isinstance(reason, NewConnectionError) or isinstance(inner, NewConnectionError)


class RemoteD1:
    """Une connexion neuve par requête : pas de connexion gardée ouverte, que Cloudflare peut
    fermer pendant une longue pause (lecture Spotify d'un grand membre, c. 9 min), ce qui
    faisait échouer la requête suivante après 60 s (ReadTimeout). Nouvel essai automatique
    d'une lecture après une erreur réseau ; d'une écriture, seulement si elle n'a pas pu partir."""

    ATTEMPTS = 3
    PAUSES = (2, 5)          # secondes entre deux essais
    TIMEOUT = (10, 60)       # connexion, réponse

    def __init__(self, account, database, token):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
        self.headers = {"authorization": f"Bearer {token}", "connection": "close"}
        self.label = "D1 (Cloudflare)"

    def _post(self, sql, params):
        read = _is_read(sql)
        for attempt in range(self.ATTEMPTS):
            try:
                return requests.post(self.url, json={"sql": sql, "params": list(params)},
                                     headers=self.headers, timeout=self.TIMEOUT)
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout,
                    requests.exceptions.ChunkedEncodingError) as exc:
                retry = read or _not_sent(exc)
                if not retry or attempt == self.ATTEMPTS - 1:
                    kind = "lecture" if read else "écriture"
                    raise CloudError(f"D1 : {kind} impossible après {attempt + 1} essai(s) "
                                     f"({exc.__class__.__name__})") from exc
                log(f"D1 : {exc.__class__.__name__}, nouvel essai dans {self.PAUSES[attempt]} s")
                time.sleep(self.PAUSES[attempt])

    def query(self, sql, params=()):
        r = self._post(sql, params)
        # Lecture : erreur passagère de Cloudflare (429, 5xx), nouvel essai ; écriture : jamais
        # (elle a pu être exécutée)
        for pause in self.PAUSES if _is_read(sql) else ():
            if r.status_code not in (429, 500, 502, 503, 504):
                break
            log(f"D1 : HTTP {r.status_code}, nouvel essai dans {pause} s")
            time.sleep(pause)
            r = self._post(sql, params)
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code >= 400 or not data.get("success"):
            errors = "; ".join(e.get("message", "") for e in data.get("errors", [])) or f"HTTP {r.status_code}"
            raise CloudError(f"D1 : {errors}")
        return data["result"][-1].get("results", []) if data.get("result") else []

    def script(self, sql):
        """Plusieurs instructions sans paramètres (schéma)."""
        self.query(sql)


class LocalD1:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")  # comme D1
        self.label = f"SQLite local ({path.relative_to(DATA.parent) if path.is_relative_to(DATA.parent) else path})"

    def query(self, sql, params=()):
        cur = self.conn.execute(sql, tuple(params))
        rows = [dict(r) for r in cur.fetchall()]
        self.conn.commit()
        return rows

    def script(self, sql):
        self.conn.executescript(sql)
        self.conn.commit()


def d1(remote_only=False):
    cfg = _env("CF_ACCOUNT_ID", "D1_DATABASE_ID", "CF_D1_API_TOKEN")
    if cfg:
        return RemoteD1(*cfg)
    _local_allowed("D1", remote_only)
    return LocalD1(LOCAL / "concerts.db")


def migrate(db):
    """Applique les fichiers migrations/*.sql pas encore appliqués, dans l'ordre."""
    db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    done = {r["name"] for r in db.query("SELECT name FROM schema_migrations")}
    applied = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.name in done:
            continue
        db.script(path.read_text(encoding="utf-8"))
        db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))", [path.name])
        applied.append(path.name)
    log(f"{db.label} : {len(applied)} migration(s) appliquée(s)" + (f" ({', '.join(applied)})" if applied else ""))
    return applied


# --- R2 -------------------------------------------------------------------------

class RemoteR2:
    def __init__(self, account, key_id, secret, bucket):
        import boto3  # dépendance chargée seulement si R2 est configuré

        self.s3 = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                               aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="auto")
        self.bucket = bucket
        self.label = f"R2 ({bucket})"

    def get_json(self, key, default=None):
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            return default
        return json.loads(obj["Body"].read())

    def put_json(self, key, value):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType="application/json; charset=utf-8")

    def sizes(self, prefix=""):
        """{clé: taille en octets} des objets du compartiment."""
        out, token = {}, None
        while True:
            args = {"Bucket": self.bucket, "Prefix": prefix, **({"ContinuationToken": token} if token else {})}
            page = self.s3.list_objects_v2(**args)
            out.update({o["Key"]: o["Size"] for o in page.get("Contents", [])})
            if not page.get("IsTruncated"):
                return out
            token = page["NextContinuationToken"]

    def list(self, prefix):
        return sorted(self.sizes(prefix))

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)


class LocalR2:
    def __init__(self, root):
        self.root = root
        self.label = f"dossier local ({root.relative_to(DATA.parent) if root.is_relative_to(DATA.parent) else root})"

    def _path(self, key):
        return self.root.joinpath(*key.split("/"))

    def get_json(self, key, default=None):
        path = self._path(key)
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def put_json(self, key, value):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    def sizes(self, prefix=""):
        if not self.root.exists():
            return {}
        files = ((p.relative_to(self.root).as_posix(), p.stat().st_size) for p in self.root.rglob("*") if p.is_file())
        return {k: n for k, n in files if k.startswith(prefix)}

    def list(self, prefix):
        return sorted(self.sizes(prefix))

    def delete(self, key):
        self._path(key).unlink(missing_ok=True)


def r2(remote_only=False):
    cfg = _env("CF_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    if cfg:
        return RemoteR2(*cfg)
    _local_allowed("R2", remote_only)
    return LocalR2(LOCAL / "r2")
