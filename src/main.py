"""Traitement des concerts, en deux tâches (spécification, section 8).

  python -m src.main                       tâche commune puis tâche membres (essai complet)
  python -m src.main common                tâche commune : sources, salles, dédoublonnage,
                                           historique commun, publication commune
  python -m src.main members               tâche membres : chaque membre actif, à partir de la
                                           dernière collecte
  python -m src.main members --pending     membres qui attendent un calcul (arrivée,
                                           « Synchroniser maintenant », relance par l'admin)
  python -m src.main members --member <id> ce membre (plus ceux qui attendent un calcul)

La dernière collecte (concerts dédoublonnés, sans champ personnel) est conservée dans R2
(common/collected.json) : la tâche membres et le calcul d'un seul membre la relisent.
Une erreur chez un membre le passe en statut error et le traitement continue.
"""
import argparse
import copy
import os
import re
import time

from . import catalog, cloud, discover, history, match, members, publish
from .library import deezer as deezer_library
from .library.base import SourceError
from .sources import bandsintown, dice, offi, qfap, ticketmaster, venues as venue_pages
from .util import ROOT, load_yaml, log, norm

COLLECTED = "common/collected.json"
LIBRARIES = {"deezer": deezer_library.read}


def run_source(label, status, fn, *args):
    try:
        events = fn(*args)
        status[label] = f"{len(events)} événements"
        return events
    except Exception as exc:  # une source en panne ne bloque pas les autres
        log(f"  {label} : échec ({exc.__class__.__name__}: {exc})")
        status[label] = "échec"
        return []


def apply_prefs(artists, prefs):
    """Préférences du membre (members.prefs) : niveaux imposés, puis artistes masqués retirés
    de sa liste. Renvoie (artistes actifs, artistes masqués, noms masqués normalisés)."""
    levels = prefs["levels"]
    changed = 0
    for a in artists.values():
        a["tier_auto"] = a.get("tier_auto", a["tier"]) if a.get("tier_forced") else a["tier"]
        forced = levels.get(norm(a["name"]))
        a["tier"] = forced or a["tier_auto"]
        a["tier_forced"] = bool(forced)
        changed += bool(forced)
    if levels:
        log(f"  {changed} niveaux imposés")

    keys = set(prefs["hidden"])
    hidden = {i: a for i, a in artists.items() if norm(a["name"]) in keys}
    active = {i: a for i, a in artists.items() if i not in hidden}
    if keys:
        log(f"  {len(hidden)} artistes de la liste masqués, {len(keys) - len(hidden)} autres masqués des découvertes")
    return active, hidden, keys


# --- Tâche commune ---------------------------------------------------------------------

def union_artists(store, member_list):
    """Artistes de tous les membres (dernier calcul de chacun), par identifiant : sert au
    dédoublonnage et à Bandsintown, sans rien publier de personnel."""
    union = {}
    for m in member_list:
        for aid, a in (members.read(store, m["id"], "artists", {}) or {}).items():
            if aid not in union or a.get("score", 0) > union[aid].get("score", 0):
                union[aid] = a
    return union


def common(settings, db, store):
    run_id = members.start_run(db, "weekly")
    venues_cfg = catalog.load(db)
    member_list = members.active(db)
    union = union_artists(store, member_list)
    log(f"Membres : {len(member_list)} à calculer, {len(union)} artistes au total")

    log("Sources de concerts")
    status, events = {}, []
    tm_key = os.environ.get("TICKETMASTER_API_KEY")
    bit_id = os.environ.get("BANDSINTOWN_APP_ID")
    if tm_key:
        events += run_source("Ticketmaster", status, ticketmaster.fetch, settings, tm_key)
    else:
        status["Ticketmaster"] = "ignorée (clé absente)"
    if bit_id:
        # Artistes de niveaux 1 et 2 de tous les membres (plafond bandsintown_max_artists)
        wanted = {i: a for i, a in union.items() if a.get("tier", 3) <= 2 and a.get("still_liked", True)}
        events += run_source("Bandsintown", status, bandsintown.fetch, settings, bit_id, wanted)
    else:
        status["Bandsintown"] = "ignorée (identifiant absent)"
    events += run_source("Que faire à Paris", status, qfap.fetch, settings)
    events += run_source("Offi", status, offi.fetch, settings)
    events += run_source("Dice", status, dice.fetch, settings)
    events += run_source("Sites des salles", status, venue_pages.fetch, venues_cfg)

    events = match.prepare(events, match.VenueMatcher(venues_cfg))
    # Dédoublonnage : un même concert vu par plusieurs sources est reconnu grâce aux artistes
    # de l'ensemble des membres ; le rapprochement propre à chaque membre est refait ensuite
    events = match.match_known(events, match.ArtistIndex(union))
    events = match.dedupe(events)
    for ev in events:
        ev.pop("matched", None)

    followed = members.all_star_ids(db)
    for m in member_list:
        followed |= set((members.read(store, m["id"], "history") or {}).get("concerts", {}))
    events, initial, kept_ids = history.update_common(events, followed)
    publish.build_common(events, status, initial)

    collected = {"initial": initial, "kept_ids": sorted(kept_ids),
                 "events": [{k: v for k, v in ev.items() if k not in publish.PERSONAL} for ev in events]}
    store.put_json(COLLECTED, collected)
    members.end_run(db, run_id, "ok", status)
    log(f"Collecte enregistrée : {len(events)} concerts ({store.label})")
    return collected


# --- Tâche membres -----------------------------------------------------------------------

def compute_member(m, collected, settings, db, store, budget):
    """Calcule un membre : source, préférences, rapprochement, découvertes, historique, R2."""
    uid = m["id"]
    read_library = LIBRARIES.get(m["provider"])
    if not read_library:
        raise SourceError("unsupported_provider", m["provider"])
    previous = members.read(store, uid, "artists", {})
    artists = read_library(m["provider_user_id"], settings, previous)
    artists, hidden, hidden_keys = apply_prefs(artists, members.prefs(db, uid))

    events = copy.deepcopy(collected["events"])
    events = match.mark_favorites(events, members.favorite_venues(db, uid))
    events = match.match_known(events, match.ArtistIndex(artists))
    events = discover.score_events(events, artists, settings, hidden_keys, budget)

    member_history = members.read(store, uid, "history")
    new_history = history.update_member(events, member_history, set(collected["kept_ids"]))
    files = publish.build_member(events, {**artists, **hidden}, member_initial=member_history is None)
    files["history"] = new_history
    total = members.check_quota(store, uid, files, settings)
    for name, value in files.items():
        members.write(store, uid, name, value)
    log(f"  Stockage R2 : {total / 1048576:.1f} Mo sur {settings['r2_bucket_max_mb']} Mo autorisés")


def run_members(settings, db, store, selection, collected=None, kind="weekly"):
    collected = collected or store.get_json(COLLECTED)
    if not collected:
        raise SystemExit("Aucune collecte enregistrée (common/collected.json) : lancez d'abord la tâche commune.")
    run_id = members.start_run(db, kind)
    budget = {"left": settings["discovery"]["max_new_lookups"]}
    failures = 0
    log(f"Tâche membres : {len(selection)} membre(s)")
    for m in selection:
        uid, started = m["id"], time.monotonic()
        log(f"Membre {uid} ({m['provider']})")
        code = None
        try:
            compute_member(m, collected, settings, db, store, budget)
        except SourceError as exc:
            code = exc.code
        except members.QuotaError as exc:
            log(f"  Stockage : {exc}")
            code = "storage_quota"
        except Exception as exc:  # noqa: BLE001  une erreur chez un membre n'arrête pas les autres
            log(f"  Erreur interne ({exc.__class__.__name__})")
            code = "internal"
        members.record_sync(db, uid, ok=code is None, error_code=code)
        members.record_member_run(db, run_id, uid, m["provider"], code is None, code, time.monotonic() - started)
        log(f"  Membre {uid} : {'calcul terminé' if code is None else f'erreur {code}'}")
        failures += code is not None
    members.end_run(db, run_id, "ok" if not failures else f"{failures} erreur(s)")
    log(f"Tâche membres terminée : {len(selection) - failures} calcul(s) réussi(s), {failures} en erreur")
    return failures


def main():
    parser = argparse.ArgumentParser(prog="python -m src.main", description="Traitement des concerts")
    parser.add_argument("task", nargs="?", choices=("common", "members"), help="tâche seule (défaut : les deux)")
    parser.add_argument("--member", action="append", default=[], help="identifiant d'un membre à calculer")
    parser.add_argument("--pending", action="store_true", help="membres qui attendent un calcul")
    args = parser.parse_args()
    for uid in args.member:
        if not re.fullmatch(members.MEMBER_ID, uid):
            raise SystemExit("Identifiant de membre invalide (u_ suivi de 8 caractères)")

    settings = load_yaml(ROOT / "config" / "settings.yaml")
    db, store = cloud.d1(), cloud.r2()
    log(f"Données des membres : {db.label}, {store.label}")

    collected = None
    if args.task in (None, "common"):
        collected = common(settings, db, store)
    if args.task in (None, "members"):
        if args.member or args.pending:
            selection = members.by_ids(db, args.member) if args.member else []
            seen = {m["id"] for m in selection}
            selection += [m for m in members.pending(db) if m["id"] not in seen]
            kind = "member"
        else:
            selection, kind = members.active(db), "weekly"
        run_members(settings, db, store, selection, collected, kind)


if __name__ == "__main__":
    main()
