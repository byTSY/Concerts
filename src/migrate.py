"""Reprise de l'existant (spécification, section 14).

  python -m src.migrate schema                                   crée ou met à jour les tables D1
  python -m src.migrate import --email <e-mail> --first-name <prénom>
  python -m src.migrate verify --email <e-mail>

« import » crée le compte admin (source Deezer de config/settings.yaml), reprend
config/artist_prefs.yaml (masqués, niveaux, ★ privés), config/venues.yaml (catalogue approuvé,
salles favorites de l'admin), puis data/artists.json, la partie personnelle de site/data/events.json
et de data/concerts.json dans R2.

Garde-fous, contrôlés avant toute écriture : fichiers du dépôt à jour (git pull fait, aucune
modification locale), fichiers encore au format d'avant la reprise, et compte admin absent de D1.
Si le compte existe déjà (reprise interrompue, ou relancée avant la bascule), --force remplace
ses préférences, ★ et salles favorites par celles du dépôt : à ne jamais faire après la bascule,
les changements faits depuis le nouveau site seraient perdus.

« verify » compare D1 et R2 aux fichiers du dépôt : listes d'identifiants (artistes, concerts
retenus, ★, salles) et, concert par concert, ce que le site affichera pour l'admin.
"""
import argparse
import subprocess
import sys

from . import catalog, cloud, deezer, members
from .history import kind_of
from .publish import ARTIST_FIELDS
from .util import DATA, ROOT, SITE_DATA, load_json, load_yaml, log, norm


def _repo():
    return {
        "settings": load_yaml(ROOT / "config" / "settings.yaml"),
        "prefs": load_yaml(ROOT / "config" / "artist_prefs.yaml"),
        "venues": load_yaml(ROOT / "config" / "venues.yaml"),
        "artists": load_json(DATA / "artists.json", {}),
        "events": load_json(SITE_DATA / "events.json", []),
        "concerts": load_json(DATA / "concerts.json", {"concerts": []}),
        "meta": load_json(SITE_DATA / "meta.json", {}),
    }


def _overlay(events):
    """Partie personnelle de site/data/events.json, au format de users/<id>/overlay.json."""
    out = {}
    for ev in events:
        item = {}
        if ev["kind"] == "known":
            item = {"kind": "known", "tier": ev["tier"], "matched": ev["matched"]}
        elif ev["kind"] == "discovery":
            item = {"kind": "discovery", "discovery": ev["discovery"]}
        if ev.get("badge") == "liste":
            item["badge"] = "liste"
        if ev.get("venue_favorite"):
            item["venue_favorite"] = True
        if item:
            out[ev["id"]] = item
    return out


def _history(concerts):
    return {
        "baseline_date": concerts.get("baseline_date"),
        "concerts": {c["id"]: {"list_since": c["list_since"], "list_baseline": bool(c.get("list_baseline"))}
                     for c in concerts["concerts"] if c.get("list_since")},
    }


def _artists(artists):
    return {aid: {**{k: a[k] for k in ARTIST_FIELDS if k in a}, "provider": "deezer", "deezer_id": aid}
            for aid, a in artists.items()}


def _git(*args):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def _check_repo_fresh():
    """Le dépôt local doit refléter la dernière version publiée : sinon des ★ ou préférences
    enregistrés depuis le site (commits sur main) manqueraient à la reprise."""
    if _git("rev-parse", "--git-dir") is None:
        raise SystemExit("Dossier hors dépôt git : impossible de vérifier que les fichiers sont à jour "
                         "(--no-git-check pour un essai local).")
    if _git("fetch", "--quiet", "origin") is None:
        raise SystemExit("Impossible de joindre GitHub (git fetch) : fraîcheur du dépôt non vérifiable.")
    behind = _git("rev-list", "--count", "HEAD..origin/main")
    if behind and behind != "0":
        raise SystemExit(f"Le dépôt local a {behind} commit(s) de retard sur origin/main : "
                         "récupérez-les (git pull origin main) avant la reprise.")
    dirty = _git("status", "--porcelain", "--", "config", "data", "site/data")
    if dirty:
        raise SystemExit("Fichiers de données modifiés localement :\n" + dirty)


def _check_old_format(repo):
    """La reprise lit les champs personnels des fichiers d'avant : après un premier traitement
    au nouveau format, ils n'existent plus."""
    if repo["events"] and "kind" not in repo["events"][0]:
        raise SystemExit("site/data/events.json est déjà au nouveau format : reprise impossible depuis ce fichier.")
    if repo["concerts"]["concerts"] and "list_since" not in repo["concerts"]["concerts"][0]:
        raise SystemExit("data/concerts.json est déjà au nouveau format : reprise impossible depuis ce fichier.")
    if not repo["artists"]:
        raise SystemExit("data/artists.json absent ou vide : reprise impossible.")


def cmd_schema(args):
    cloud.migrate(cloud.d1(remote_only=not args.local))


def cmd_import(args):
    # Tous les contrôles avant la première écriture
    if not args.no_git_check:
        _check_repo_fresh()
    repo = _repo()
    _check_old_format(repo)
    overlay = _overlay(repo["events"])
    history = _history(repo["concerts"])
    db, store = cloud.d1(remote_only=not args.local), cloud.r2(remote_only=not args.local)
    log(f"Cible : {db.label}, {store.label}")
    cloud.migrate(db)
    existing = db.query("SELECT id FROM users WHERE email = ?", [args.email.strip().lower()])
    if existing and not args.force:
        raise SystemExit(f"Le compte {args.email} existe déjà dans {db.label}. Relancer la reprise remplacerait "
                         "ses préférences et ★ par ceux du dépôt : ajoutez --force seulement si le nouveau site "
                         "n'est pas encore en service.")
    deezer_id = repo["settings"]["deezer_user_id"]
    profile = deezer._call(f"{deezer.API}/user/{deezer_id}") or {}

    uid = members.upsert_admin(db, args.email, args.first_name)
    members.set_deezer_source(db, uid, deezer_id, profile.get("name"))
    p = repo["prefs"]
    n_prefs = members.replace_prefs(db, uid, p.get("hidden") or [], p.get("levels") or {})
    n_stars = members.replace_stars(db, uid, p.get("starred") or {})
    favorites = catalog.import_yaml(db, repo["venues"])
    members.replace_favorite_venues(db, uid, favorites)
    log(f"D1 ({db.label}) : membre {uid}, {n_prefs} préférences, {n_stars} ★, {len(favorites)} salles favorites")

    meta = repo["meta"]
    files = {
        "artists": _artists(repo["artists"]),
        "overlay": overlay,
        "history": history,
        "meta": {
            "generated_at": meta.get("generated_at"),
            "initial": False,
            "counts": {k: (meta.get("counts") or {}).get(k, 0)
                       for k in ("artists", "new_artists", "known", "discovery", "new_in_list")},
        },
    }
    members.check_quota(store, uid, files, repo["settings"])
    for name, value in files.items():
        members.write(store, uid, name, value)
        log(f"R2 ({store.label}) : {name}.json, {members.dumps_size(value) // 1024} Ko")
    db.query("UPDATE music_sources SET last_sync_at = ?, last_sync_status = 'ok' WHERE user_id = ?",
             [meta.get("generated_at"), uid])
    log(f"Reprise terminée. Vérifiez avec : python -m src.migrate verify --email {args.email}")


def _merge(events, overlay):
    """Ce que le site affichera pour le membre : même fusion que site/app.js (mergeOverlay)."""
    out = {}
    for ev in events:
        o = overlay.get(ev["id"], {})
        out[ev["id"]] = {
            "kind": o.get("kind", "other"),
            "tier": o.get("tier"),
            "matched": [m["name"] for m in o.get("matched", [])],
            "discovery": (o.get("discovery") or {}).get("artist"),
            "badge": ev.get("badge") if ev.get("badge") == "annonce" else o.get("badge"),
            "venue_favorite": bool(o.get("venue_favorite")),
        }
    return out


def cmd_verify(args):
    repo = _repo()
    db, store = cloud.d1(remote_only=not args.local), cloud.r2(remote_only=not args.local)
    log(f"Cible : {db.label}, {store.label}")
    row = db.query("SELECT id FROM users WHERE email = ?", [args.email.strip().lower()])
    if not row:
        raise SystemExit(f"Aucun membre {args.email} dans {db.label}")
    uid = row[0]["id"]
    gaps = []

    def check(label, expected, actual):
        if expected == actual:
            log(f"  OK      {label}")
            return
        if isinstance(expected, (set, dict)):
            exp, act = set(expected), set(actual)
            extra = sorted(act - exp)[:5]
            missing = sorted(exp - act)[:5]
            diff = [k for k in exp & act if isinstance(expected, dict) and expected[k] != actual[k]][:5]
            detail = f"absents {missing}, en trop {extra}" + (f", différents {diff}" if diff else "")
        else:
            detail = f"attendu {expected!r}, obtenu {actual!r}"
        gaps.append(label)
        log(f"  ÉCART   {label} : {detail}")

    p = repo["prefs"]
    prefs = members.prefs(db, uid)
    check("artistes masqués", {norm(n) for n in p.get("hidden") or []}, set(prefs["hidden"]))
    check("niveaux imposés", {norm(n): int(t) for n, t in (p.get("levels") or {}).items()}, prefs["levels"])
    stars = {s["concert_id"]: s["label"] for s in members.stars(db, uid)}
    check("★ (identifiants et libellés)", {str(k): v for k, v in (p.get("starred") or {}).items()}, stars)
    check("salles favorites", {catalog.venue_id(v["name"]) for v in repo["venues"].get("favorites") or []},
          members.favorite_venues(db, uid))

    artists = members.read(store, uid, "artists", {})
    check("artistes (identifiants)", set(repo["artists"]), set(artists))
    check("artistes (niveaux calculés)", {i: a["tier"] for i, a in repo["artists"].items()},
          {i: a["tier"] for i, a in artists.items()})
    overlay = members.read(store, uid, "overlay", {})
    for kind in ("known", "discovery"):
        check(f"concerts retenus, {kind}", {e["id"] for e in repo["events"] if e["kind"] == kind},
              {i for i, o in overlay.items() if o.get("kind") == kind})
    check("badges « liste »", {e["id"] for e in repo["events"] if e.get("badge") == "liste"},
          {i for i, o in overlay.items() if o.get("badge") == "liste"})
    check("concerts en salle favorite", {e["id"] for e in repo["events"] if e.get("venue_favorite")},
          {i for i, o in overlay.items() if o.get("venue_favorite")})
    hist = members.read(store, uid, "history", {})
    check("historique de la liste (list_since)",
          {c["id"]: c["list_since"] for c in repo["concerts"]["concerts"] if c.get("list_since")},
          {i: h["list_since"] for i, h in (hist.get("concerts") or {}).items()})

    # Concert par concert : affichage d'avant (fichier publié) et d'après (fichier commun + overlay)
    before = {e["id"]: {"kind": e["kind"], "tier": e.get("tier"),
                        "matched": [m["name"] for m in e.get("matched") or []],
                        "discovery": (e.get("discovery") or {}).get("artist"),
                        "badge": e.get("badge"), "venue_favorite": bool(e.get("venue_favorite"))}
              for e in repo["events"]}
    check("affichage concert par concert", before, _merge(repo["events"], overlay))
    check("cohérence du genre de concert", {e["id"]: e["kind"] for e in repo["events"]},
          {e["id"]: kind_of({"matched": e.get("matched"), "discovery": e.get("discovery")}) for e in repo["events"]})

    if gaps:
        log(f"Vérification : {len(gaps)} écart(s)")
        sys.exit(1)
    log("Vérification : aucun écart")


def main():
    parser = argparse.ArgumentParser(prog="python -m src.migrate", description="Reprise de l'existant")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sch = sub.add_parser("schema")
    imp = sub.add_parser("import")
    imp.add_argument("--email", required=True)
    imp.add_argument("--first-name", required=True)
    imp.add_argument("--force", action="store_true", help="remplacer les données d'un compte admin déjà importé")
    imp.add_argument("--no-git-check", action="store_true", help="essai local hors dépôt git")
    ver = sub.add_parser("verify")
    ver.add_argument("--email", required=True)
    for p in (sch, imp, ver):
        p.add_argument("--local", action="store_true", help="essai sur la copie locale (data/local/), sans Cloudflare")
    args = parser.parse_args()
    {"schema": cmd_schema, "import": cmd_import, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    main()
