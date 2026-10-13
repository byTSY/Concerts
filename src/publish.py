"""Fichiers lus par le site.

Communs (site/data/, dans le dépôt) : tous les concerts sans aucun champ personnel, salles
observées, état des sources. Personnels (users/<id>/ dans R2, servis par /api/me/*) : artistes
du membre, concerts retenus pour lui (overlay), compteurs du bandeau.
"""
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone

from .history import kind_of
from .util import SITE_DATA, log, save_json, today_iso

COMMON = ("id", "title", "date", "time", "venue", "venue_id", "address", "city", "price", "on_sale",
          "status", "genre", "image", "links", "artists", "description", "first_seen", "badge")
# Champs propres à un membre, jamais dans les fichiers communs ni dans la collecte (R2 common/)
PERSONAL = ("matched", "discovery", "venue_favorite", "kind", "list_since", "list_badge")
ARTIST_FIELDS = ("id", "name", "key", "link", "picture", "score", "tier", "sources", "first_seen", "added",
                 "last_seen", "still_liked", "provider", "deezer_id", "spotify_id")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="minutes")


SHARE = SITE_DATA / "share"


def build_share(out):
    """Concerts répartis en petits fichiers selon les deux premiers caractères de leur
    identifiant (site/data/share/<xx>.json, c. 20 concerts chacun) : la fiche publique /partage
    n'en lit qu'un, au lieu de tout events.json (limite de 10 ms de calcul par requête)."""
    groups = defaultdict(list)
    for e in out:
        groups[e["id"][:2]].append(e)
    SHARE.mkdir(parents=True, exist_ok=True)
    for prefix, items in groups.items():
        (SHARE / f"{prefix}.json").write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for path in SHARE.glob("*.json"):
        if path.stem not in groups:
            path.unlink()
    return len(groups)


def build_common(events, source_status, initial=False):
    """events : concerts passés par history.update_common (id stable, first_seen, badge « annonce »)."""
    out = sorted(({k: ev.get(k) for k in COMMON} for ev in events), key=lambda e: (e["date"], e.get("time") or ""))
    save_json(SITE_DATA / "events.json", out)
    build_share(out)

    totals = Counter(e["venue"] for e in out)
    ids = {e["venue"]: e["venue_id"] for e in out if e.get("venue_id")}
    venues = [{"name": n, "venue_id": ids.get(n), "total": t} for n, t in totals.items()]
    venues.sort(key=lambda v: (-v["total"], v["name"]))
    save_json(SITE_DATA / "venues.json", venues)

    meta = {
        "generated_at": _now(),
        "sources": source_status,
        "counts": {"concerts": len(out), "new_announcements": sum(1 for e in out if e["badge"] == "annonce")},
        "initial": initial,
    }
    save_json(SITE_DATA / "meta.json", meta)
    log(f"Site : {len(out)} concerts, {meta['counts']['new_announcements']} nouvelles annonces")
    return meta


def overlay_entry(ev, artists):
    """Ce que le concert est pour le membre : genre de rapprochement, niveau, artistes, badge
    « liste », salle favorite. None si le concert ne le concerne pas."""
    kind = kind_of(ev)
    item = {}
    if kind == "known":
        item = {"kind": "known", "tier": ev["matched"][0]["tier"],
                "matched": [{"name": m["name"], "tier": m["tier"], "via": m["via"],
                             "link": (artists.get(m["id"]) or {}).get("link")} for m in ev["matched"]]}
    elif kind == "discovery":
        item = {"kind": "discovery", "discovery": ev["discovery"]}
    if ev.get("list_badge"):
        item["badge"] = ev["list_badge"]
    if ev.get("venue_favorite"):
        item["venue_favorite"] = True
    return item or None


def build_member(events, artists, member_initial=False):
    """Fichiers personnels d'un membre : {"artists": ..., "overlay": ..., "meta": ...}.
    events : concerts passés par history.update_member ; artists : toute sa liste, masqués compris."""
    today = today_iso()
    overlay = {}
    for ev in events:
        item = overlay_entry(ev, artists)
        if item:
            overlay[ev["id"]] = item
    kinds = Counter(i.get("kind") for i in overlay.values())
    meta = {
        "generated_at": _now(),
        "initial": member_initial,
        "counts": {
            "artists": len(artists),
            "new_artists": sum(1 for a in artists.values() if a.get("first_seen") == today),
            "known": kinds["known"],
            "discovery": kinds["discovery"],
            "new_in_list": sum(1 for i in overlay.values() if i.get("badge") == "liste"),
        },
    }
    # Niveau calculé à partir des likes ; le niveau imposé reste dans les préférences (D1)
    stored = {aid: {**{k: a[k] for k in ARTIST_FIELDS if k in a}, "tier": a.get("tier_auto", a["tier"])}
              for aid, a in artists.items()}
    c = meta["counts"]
    log(f"  Membre : {c['known']} concerts de ses artistes, {c['discovery']} découvertes, "
        f"{c['new_in_list']} nouveaux dans sa liste")
    return {"artists": stored, "overlay": overlay, "meta": meta}
