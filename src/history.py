"""Base complète des concerts (data/concerts.json) et date d'apparition de chacun.

Chaque concert garde un identifiant stable d'une semaine à l'autre, retrouvé par les
identifiants de ses sources : un concert qui entre dans votre liste (nouvel artiste liké,
nouvelle découverte) n'est donc pas pris pour une nouvelle annonce.

Au premier passage, tous les concerts forment la « base initiale » : aucun badge.
Ensuite, deux badges, valables 7 jours :
- « annonce » : concert apparu dans les sources depuis la base initiale ;
- « liste »   : concert déjà connu qui vient d'entrer dans votre liste.
Les concerts passés sont retirés de la base ; un concert à venir absent des sources une
semaine y reste (champ last_seen), pour ne pas réapparaître ensuite comme une annonce.
"""
from datetime import date, timedelta

from .util import DATA, load_json, log, save_json, today_iso

PATH = DATA / "concerts.json"
BADGE_DAYS = 7
STORED = ("title", "date", "time", "venue", "genre", "price", "links")


def kind_of(ev):
    if ev.get("matched"):
        return "known"
    if ev.get("discovery"):
        return "discovery"
    return "other"


def update(events):
    """Attribue id, first_seen et badge à chaque concert, puis enregistre la base."""
    today = today_iso()
    limit = (date.today() - timedelta(days=BADGE_DAYS - 1)).isoformat()
    db = load_json(PATH, None)
    initial = db is None
    previous = {} if initial else {c["id"]: c for c in db["concerts"]}
    by_key = {k: c["id"] for c in previous.values() for k in c.get("source_keys", [])}

    records, used = [], set()
    for ev in events:
        known_ids = {by_key[k] for k in ev.get("source_keys", []) if k in by_key}
        prev = min((previous[i] for i in known_ids), key=lambda c: c["first_seen"], default=None)
        cid = prev["id"] if prev and prev["id"] not in used else ev["id"]
        while cid in used:  # collision improbable entre deux concerts distincts
            cid += "x"
        used.add(cid)

        kind = kind_of(ev)
        in_list = kind != "other"
        if prev:
            first_seen, baseline = prev["first_seen"], prev["baseline"]
            if in_list and prev.get("list_since"):
                list_since, list_baseline = prev["list_since"], prev.get("list_baseline", False)
            else:
                list_since, list_baseline = (today, False) if in_list else (None, False)
        else:
            first_seen, baseline = today, initial
            list_since, list_baseline = (today, initial) if in_list else (None, False)

        badge = None
        if not baseline and first_seen >= limit:
            badge = "annonce"
        elif in_list and not list_baseline and list_since and list_since >= limit:
            badge = "liste"

        ev.update(id=cid, kind=kind, first_seen=first_seen, list_since=list_since, badge=badge)
        records.append({
            "id": cid, **{k: ev.get(k) for k in STORED}, "kind": kind,
            "first_seen": first_seen, "baseline": baseline,
            "list_since": list_since, "list_baseline": list_baseline,
            "last_seen": today,
            "source_keys": sorted(set(ev.get("source_keys", [])) | set((prev or {}).get("source_keys", []))),
        })

    # Concerts à venir absents cette semaine (source en panne, fiche retirée) : conservés,
    # pour ne pas les compter comme nouvelles annonces s'ils réapparaissent
    current = {k for r in records for k in r["source_keys"]}
    for c in previous.values():
        if c["date"] >= today and c["id"] not in used and not current & set(c.get("source_keys", [])):
            records.append(c)

    records.sort(key=lambda c: (c["date"], c.get("time") or "", c["id"]))
    save_json(PATH, {"baseline_date": today if initial else db["baseline_date"], "concerts": records})
    counts = {b: sum(1 for ev in events if ev["badge"] == b) for b in ("annonce", "liste")}
    if initial:
        log(f"Base des concerts : {len(records)} concerts enregistrés comme base initiale, sans badge")
    else:
        log(f"Base des concerts : {len(records)} concerts, {counts['annonce']} nouvelles annonces, "
            f"{counts['liste']} nouveaux dans votre liste")
    return events, initial
