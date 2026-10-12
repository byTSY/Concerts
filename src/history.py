"""Base des concerts : date d'apparition (commune) et date d'entrée dans la liste (par membre).

Partie commune, data/concerts.json : chaque concert garde un identifiant stable d'une semaine
à l'autre, retrouvé par les identifiants de ses sources, et sa date d'apparition (first_seen).
Au premier passage, tous les concerts forment la « base initiale » : aucun badge. Ensuite, le
badge « annonce » (7 jours) signale un concert apparu dans les sources depuis la base initiale.
Les concerts passés sont retirés ; un concert à venir absent des sources une semaine y reste
(champ last_seen), pour ne pas réapparaître ensuite comme une annonce.

Partie membre, users/<id>/history.json (R2) : pour chaque concert de sa liste, la date
d'entrée (list_since). Le badge « liste » (7 jours) signale un concert déjà connu qui vient
d'entrer dans la liste du membre (nouvel artiste liké, nouvelle découverte). Au premier calcul
d'un membre, sa liste forme sa base initiale : aucun badge « liste » ce jour-là.
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


def _limit():
    return (date.today() - timedelta(days=BADGE_DAYS - 1)).isoformat()


def _combine(prevs, followed):
    """Historique commun d'un concert qui réunit plusieurs fiches de la base (fusion entre
    sources) : la plus ancienne apparition, et l'identifiant de la fiche la plus ancienne, de
    préférence une fiche suivie par un membre (dans sa liste ou mise de côté), sinon le concert
    changerait d'identifiant pour lui."""
    if not prevs:
        return None
    out = dict(min(prevs, key=lambda c: (c["first_seen"], c["id"] not in followed, c["id"])))
    first = min(c["first_seen"] for c in prevs)
    out["first_seen"] = first
    out["baseline"] = any(c["baseline"] for c in prevs if c["first_seen"] == first)
    out["source_keys"] = sorted({k for c in prevs for k in c.get("source_keys", [])})
    return out


def update_common(events, followed=frozenset()):
    """Attribue id, first_seen et badge « annonce » à chaque concert, puis enregistre la base
    commune. Chaque concert reçoit aussi merged_ids : les identifiants des fiches de la base
    qu'il reprend, pour retrouver l'historique des membres. followed : identifiants suivis par
    les membres (historique de leur liste, ★), sans autre usage que le choix de l'identifiant
    lors d'une fusion. Renvoie (events, initial, kept_ids)."""
    today = today_iso()
    limit = _limit()
    db = load_json(PATH, None)
    initial = db is None
    previous = {} if initial else {c["id"]: c for c in db["concerts"]}
    by_key = {k: c["id"] for c in previous.values() for k in c.get("source_keys", [])}

    records, used = [], set()
    for ev in events:
        known_ids = sorted({by_key[k] for k in ev.get("source_keys", []) if k in by_key})
        prev = _combine([previous[i] for i in known_ids], followed)
        cid = prev["id"] if prev and prev["id"] not in used else ev["id"]
        while cid in used:  # collision improbable entre deux concerts distincts
            cid += "x"
        used.add(cid)

        if prev:
            first_seen, baseline = prev["first_seen"], prev["baseline"]
        else:
            first_seen, baseline = today, initial
        badge = "annonce" if not baseline and first_seen >= limit else None

        ev.update(id=cid, first_seen=first_seen, badge=badge, merged_ids=known_ids)
        records.append({
            "id": cid, **{k: ev.get(k) for k in STORED},
            "first_seen": first_seen, "baseline": baseline, "last_seen": today,
            "source_keys": sorted(set(ev.get("source_keys", [])) | set((prev or {}).get("source_keys", []))),
        })

    # Concerts à venir absents cette semaine (source en panne, fiche retirée) : conservés,
    # pour ne pas les compter comme nouvelles annonces s'ils réapparaissent
    current = {k for r in records for k in r["source_keys"]}
    for c in previous.values():
        if c["date"] >= today and c["id"] not in used and not current & set(c.get("source_keys", [])):
            records.append({k: c.get(k) for k in ("id", *STORED, "first_seen", "baseline", "last_seen", "source_keys")})

    records.sort(key=lambda c: (c["date"], c.get("time") or "", c["id"]))
    save_json(PATH, {"baseline_date": today if initial else db["baseline_date"], "concerts": records})
    n = sum(1 for ev in events if ev["badge"] == "annonce")
    if initial:
        log(f"Base des concerts : {len(records)} concerts enregistrés comme base initiale, sans badge")
    else:
        log(f"Base des concerts : {len(records)} concerts, {n} nouvelles annonces")
    return events, initial, {r["id"] for r in records}


def update_member(events, member_history, kept_ids):
    """Date d'entrée dans la liste et badge « liste » pour un membre.

    events : concerts passés par update_common, avec le kind du membre (kind_of) ;
    member_history : contenu de users/<id>/history.json, None au premier calcul ;
    kept_ids : identifiants de la base commune (concerts à venir encore suivis).
    Pose ev["list_badge"] et renvoie le nouvel historique du membre."""
    today = today_iso()
    limit = _limit()
    initial = member_history is None
    previous = {} if initial else member_history.get("concerts", {})

    concerts, present = {}, set()
    for ev in events:
        present.add(ev["id"])
        ev["list_badge"] = None
        if kind_of(ev) == "other":
            continue  # sorti de la liste : une nouvelle entrée sera datée du jour
        prevs = [previous[i] for i in [ev["id"], *ev.get("merged_ids", [])] if i in previous]
        if prevs:
            since = min(p["list_since"] for p in prevs)
            entry = {"list_since": since,
                     "list_baseline": any(p.get("list_baseline") for p in prevs if p["list_since"] == since)}
        else:
            entry = {"list_since": today, "list_baseline": initial}
        concerts[ev["id"]] = entry
        if not ev.get("badge") and not entry["list_baseline"] and entry["list_since"] >= limit:
            ev["list_badge"] = "liste"

    # Concerts à venir absents des sources cette semaine : l'entrée est gardée avec le concert
    for cid, entry in previous.items():
        if cid not in present and cid in kept_ids:
            concerts[cid] = entry

    n = sum(1 for ev in events if ev["list_badge"])
    log(f"  Liste du membre : {len(concerts)} concerts" + (" (base initiale du membre)" if initial else f", {n} nouveaux"))
    return {"baseline_date": today if initial else member_history.get("baseline_date", today), "concerts": concerts}
