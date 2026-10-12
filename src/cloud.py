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
import sqlite3

import requests

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

class RemoteD1:
    def __init__(self, account, database, token):
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
        self.session = requests.Session()
        self.session.headers["authorization"] = f"Bearer {token}"
        self.label = "D1 (Cloudflare)"

    def query(self, sql, params=()):
        r = self.session.post(self.url, json={"sql": sql, "params": list(params)}, timeout=60)
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
        self.label = f"SQLite local ({path.relative_to(DATA.parent)})"

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
