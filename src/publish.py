"""Écrit les fichiers lus par le site : concerts, artistes, salles, informations de mise à jour."""
from collections import defaultdict
from datetime import datetime, timezone

from .util import DATA, SITE_DATA, log, save_json, today_iso

KEEP = ("id", "title", "date", "time", "venue", "venue_favorite", "address", "city", "price", "on_sale",
        "status", "genre", "image", "links", "artists", "description")
KEEP_OTHER = ("id", "title", "date", "time", "venue", "venue_favorite", "price", "on_sale", "status", "genre",
              "links", "artists")


def build(events, artists, source_status, initial=False, hidden=frozenset()):
    """events : concerts déjà passés par history.update (id stable, kind, first_seen, badge)."""
    today = today_iso()
    out, venues = [], defaultdict(lambda: {"total": 0, "known": 0, "discovery": 0, "favorite": False})
    for ev in events:
        kind = ev["kind"]
        v = venues[ev["venue"]]
        v["total"] += 1
        v["favorite"] = v["favorite"] or ev.get("venue_favorite", False)

        # Concerts hors de votre liste : champs réduits, pour garder un fichier léger
        item = {k: ev.get(k) for k in (KEEP if kind != "other" else KEEP_OTHER)}
        item.update(kind=kind, first_seen=ev["first_seen"], badge=ev["badge"])
        if kind == "known":
            v["known"] += 1
            item["tier"] = ev["matched"][0]["tier"]
            item["matched"] = [{"name": m["name"], "tier": m["tier"], "via": m["via"],
                                "link": (artists.get(m["id"]) or {}).get("link")} for m in ev["matched"]]
        elif kind == "discovery":
            v["discovery"] += 1
            item["discovery"] = ev["discovery"]
        out.append(item)

    out.sort(key=lambda e: (e["date"], e.get("time") or ""))
    save_json(DATA / "events.json", [e for e in out if e["kind"] != "other"])
    save_json(SITE_DATA / "events.json", out)

    venue_list = [{"name": n, **s} for n, s in venues.items()]
    venue_list.sort(key=lambda v: (-(v["known"] + v["discovery"]), -v["total"], v["name"]))
    save_json(SITE_DATA / "venues.json", venue_list)

    site_artists = sorted(
        ({**{k: a.get(k) for k in ("name", "link", "picture", "score", "tier", "tier_auto", "first_seen", "added", "still_liked",
                                "sources")},
          "hidden": a["id"] in hidden}
         for a in artists.values()),
        key=lambda a: (-a["score"], a["name"].lower()))
    save_json(SITE_DATA / "artists.json", site_artists)

    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "sources": source_status,
        "counts": {
            "artists": len(artists),
            "new_artists": sum(1 for a in artists.values() if a.get("first_seen") == today),
            "concerts": len(out),
            "known": sum(1 for e in out if e["kind"] == "known"),
            "discovery": sum(1 for e in out if e["kind"] == "discovery"),
            "new_announcements": sum(1 for e in out if e["badge"] == "annonce"),
            "new_in_list": sum(1 for e in out if e["badge"] == "liste"),
        },
        "initial": initial,
    }
    save_json(SITE_DATA / "meta.json", meta)
    c = meta["counts"]
    log(f"Site : {c['concerts']} concerts dont {c['known']} de vos artistes et {c['discovery']} découvertes ; "
        f"{c['new_announcements']} nouvelles annonces, {c['new_in_list']} nouveaux dans votre liste")
