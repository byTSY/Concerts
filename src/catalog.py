"""Catalogue commun des salles (table venues de D1) : nom canonique, alias, page programme,
exclusion. Les salles favorites de chaque membre y renvoient par l'identifiant."""
import json

from .members import now_iso
from .util import log, norm_venue


def venue_id(name):
    """Identifiant stable d'une salle : nom normalisé, sans article, mots reliés par des tirets."""
    return norm_venue(name).replace(" ", "-")


def load(db):
    """Salles approuvées, au format de match.VenueMatcher et de sources.venues :
    {"venues": [{id, name, aliases, agenda_url}], "excluded": [{id, name, aliases}]}."""
    rows = db.query("SELECT id, name, aliases, agenda_url, excluded FROM venues WHERE status = 'approved' ORDER BY name")
    out = {"venues": [], "excluded": []}
    for r in rows:
        item = {"id": r["id"], "name": r["name"], "aliases": json.loads(r["aliases"] or "[]"),
                "agenda_url": r["agenda_url"] or ""}
        out["excluded" if r["excluded"] else "venues"].append(item)
    log(f"Catalogue des salles : {len(out['venues'])} salles, {len(out['excluded'])} exclues")
    return out


def import_yaml(db, cfg):
    """Reprise de config/venues.yaml : salles favorites et exclues, approuvées d'office.
    Renvoie les identifiants des salles favorites."""
    now = now_iso()
    favorites, seen = [], {}
    for excluded, items in ((0, cfg.get("favorites") or []), (1, cfg.get("excluded") or [])):
        for v in items:
            v = {"name": v} if isinstance(v, str) else v
            vid = venue_id(v["name"])
            if not vid or vid in seen:
                raise SystemExit(f"Salle « {v['name']} » : identifiant vide ou déjà pris par « {seen.get(vid)} »")
            seen[vid] = v["name"]
            db.query(
                "INSERT INTO venues (id, name, aliases, agenda_url, excluded, status, proposed_at, reviewed_at) "
                "VALUES (?, ?, ?, ?, ?, 'approved', ?, ?) "
                "ON CONFLICT (id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, "
                "agenda_url = excluded.agenda_url, excluded = excluded.excluded, status = 'approved'",
                [vid, v["name"], json.dumps(v.get("aliases") or [], ensure_ascii=False),
                 (v.get("agenda_url") or "").strip() or None, excluded, now, now])
            if not excluded:
                favorites.append(vid)
    return favorites
