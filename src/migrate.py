"""Schéma de la base D1 : applique les fichiers migrations/*.sql pas encore appliqués.

  python -m src.migrate schema            sur Cloudflare (variables CF_ACCOUNT_ID, D1_DATABASE_ID, CF_D1_API_TOKEN)
  python -m src.migrate schema --local    sur la copie locale data/local/concerts.db

La reprise de l'existant (spécification, section 14) a eu lieu le 12 octobre 2026 ; son code
est dans l'historique git (commit 84685a1).
"""
import argparse

from . import cloud


def main():
    parser = argparse.ArgumentParser(prog="python -m src.migrate", description="Schéma de la base D1")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sch = sub.add_parser("schema")
    sch.add_argument("--local", action="store_true", help="copie locale (data/local/), sans Cloudflare")
    args = parser.parse_args()
    cloud.migrate(cloud.d1(remote_only=not args.local))


if __name__ == "__main__":
    main()
