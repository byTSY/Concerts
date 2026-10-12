"""Catalogue commun des salles (table venues de D1) : nom canonique, alias, page programme,
exclusion. Les salles favorites de chaque membre y renvoient par l'identifiant."""
import json


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
