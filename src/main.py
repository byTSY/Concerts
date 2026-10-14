"""Traitement des concerts, en deux tâches (spécification, section 8).

  python -m src.main                       tâche commune puis tâche membres (essai complet)
  python -m src.main common                tâche commune : sources, salles, dédoublonnage,
                                           historique commun, publication commune
  python -m src.main members               tâche membres : chaque membre actif, à partir de la
                                           dernière collecte
  python -m src.main members --pending     membres qui attendent un calcul (arrivée,
                                           « Synchroniser maintenant », relance par l'admin) ;
                                           lancé aussi toutes les 2 heures, au cas où le site
                                           n'aurait pas pu lancer le calcul
  python -m src.main --member <id>          ce membre (plus ceux qui attendent un calcul)
  python -m src.main promote               publie la collecte préparée (après l'envoi sur GitHub)
  python -m src.main newsletter            newsletter du lundi à chaque membre abonné (SMTP)
  python -m src.main newsletter --test-member <id>   essai pour ce seul membre
  python -m src.main notify                envoie les notifications en attente (e-mails, SMTP)
  python -m src.main venue-check [--venue <id>]   vérifie les salles proposées (page programme lue
                                           et contrôlée) : ajoutées au catalogue si la lecture
                                           réussit, sinon laissées à l'admin (version 1.12.0)

La dernière collecte (concerts dédoublonnés, sans champ personnel) est conservée dans R2
(common/collected.json) : la tâche membres et le calcul d'un seul membre la relisent. La tâche
commune la prépare (collected.next.json) ; elle n'est publiée qu'une fois les données communes
envoyées sur GitHub, pour que les identifiants des concerts concordent.
Si un calcul de membre trouve une collecte de plus de 7 jours (traitement complet du lundi
annulé, par exemple), il refait d'abord la tâche commune, puis calcule tous les membres.
Une erreur chez un membre le passe en statut error et le traitement continue. Erreur passagère
(quota Spotify, service indisponible) : nouvel essai automatique espacé (members.next_retry) ;
quota Spotify : Spotify en pause jusqu'à l'heure indiquée par Spotify (aucun appel d'ici là).
Traitement complet relancé dans la journée : la bibliothèque Spotify lue depuis moins de
LIBRARY_REUSE_HOURS heures est réutilisée (quota Spotify commun à tous les membres).
Salle ajoutée au catalogue (vérification automatique ou admin) : la relance de sécurité refait la
collecte complète dès que la précédente a plus de 6 heures (src/venue_check.py, full_run_due).
"""
import argparse
import copy
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone

from . import catalog, cloud, discover, history, match, members, newsletter, notify, publish, venue_check
from .library import deezer as deezer_library, spotify as spotify_library
from .library.base import SourceError
from .sources import bandsintown, dice, offi, qfap, ticketmaster, venues as venue_pages
from .util import ROOT, load_yaml, log, norm

COLLECTED = "common/collected.json"
COLLECTED_NEXT = "common/collected.next.json"
STALE_DAYS = 7
LIBRARIES = {"deezer": deezer_library.read, "spotify": spotify_library.read}
LIBRARY_REUSE_HOURS = 20
QUOTA_PAUSE_DEFAULT_S = 3600   # quota sans Retry-After lisible


def send_notifications(db):
    """Envoie la file d'e-mails ; un incident d'envoi n'arrête jamais le traitement (les
    résultats calculés doivent encore être enregistrés sur GitHub)."""
    try:
        notify.send_pending(db)
    except Exception as exc:  # noqa: BLE001
        log(f"Notifications : envoi interrompu ({exc.__class__.__name__}), nouvel essai au prochain passage")


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
    # Sites des salles en dernier : leur lecture est contrôlée face aux concerts des billetteries
    broken, readable = [], []
    events += run_source("Sites des salles", status, venue_pages.fetch, venues_cfg, events, broken, readable)
    record_venue_reads(db, broken, readable)

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
    store.put_json(COLLECTED_NEXT, collected)
    members.end_run(db, run_id, "ok", status)
    log(f"Collecte préparée : {len(events)} concerts ({store.label})")
    return collected


def promote(store):
    """Publie la collecte préparée par la tâche commune, une fois les données communes envoyées."""
    collected = store.get_json(COLLECTED_NEXT)
    if collected is None:
        log("Aucune collecte à publier")
        return
    store.put_json(COLLECTED, collected)
    store.delete(COLLECTED_NEXT)
    log(f"Collecte publiée : {len(collected['events'])} concerts")


def collection_is_stale(db):
    last = members.last_collection(db)
    if not last:
        return True
    try:
        when = datetime.fromisoformat(last)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - when > timedelta(days=STALE_DAYS)


def mark_common_redone():
    """Signale au workflow que la tâche membres a refait la collecte : seule cette situation
    autorise sa publication en fin de tâche (sinon un fichier préparé par une tâche commune
    dont l'envoi sur GitHub a échoué serait publié)."""
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("redid_common=true\n")


def record_venue_reads(db, broken, readable):
    """État de lecture des pages programme (venues.check_status) ; message à l'admin seulement
    quand une page lisible devient illisible (pas chaque semaine pour une page jamais lue). Un
    incident ici n'arrête pas la collecte."""
    try:
        stamp = members.now_iso()
        for vid in readable:
            db.query("UPDATE venues SET check_status = 'ok', checked_at = ? WHERE id = ? AND status = 'approved'", [stamp, vid])
        for v in broken:
            summary = json.dumps({"method": None, "url": v["url"], "reasons": v["reasons"], "stats": {}, "sample": []},
                                 ensure_ascii=False)
            db.query("UPDATE venues SET check_status = 'failed', check_summary = ?, checked_at = ? "
                     "WHERE id = ? AND status = 'approved'", [summary, stamp, v["id"]])
            if v.get("was") != "failed":
                notify.queue(db, "venue_broken", to_admin=True, payload=v, dedupe=f"venue_broken:{v['id']}:{stamp}")
    except Exception as exc:  # noqa: BLE001
        log(f"Salles : état de lecture non enregistré ({exc.__class__.__name__})")


def launch_full_run():
    """Demande au workflow « Vérification des salles » de lancer un traitement complet (salle
    ajoutée au catalogue) ; sans workflow, la relance de sécurité s'en chargera."""
    out = os.environ.get("GITHUB_OUTPUT")
    log("Salle ajoutée : traitement complet demandé" if out else "Salle ajoutée : traitement complet à lancer")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("launch_full=true\n")


class MemberGone(Exception):
    """Membre supprimé, suspendu ou passé à une autre source pendant son calcul."""


# --- Tâche membres -----------------------------------------------------------------------

def library_is_fresh(m, kind):
    """Traitement complet (pas une demande du membre) et bibliothèque Spotify lue depuis moins de
    LIBRARY_REUSE_HOURS heures : la lecture précédente est réutilisée."""
    if kind != "weekly" or m.get("provider") != "spotify" or members.explicit_request(m) or not m.get("library_read_at"):
        return False
    try:
        read_at = datetime.fromisoformat(m["library_read_at"])
    except ValueError:
        return False
    return datetime.now(timezone.utc) - read_at < timedelta(hours=LIBRARY_REUSE_HOURS)


def compute_member(m, collected, settings, db, store, budget, excluded=None, reuse_library=False, spotify_paused=False):
    """Calcule un membre : source, préférences, rapprochement, découvertes, historique, R2.
    reuse_library : liste d'artistes du calcul précédent, sans appel à la source.
    Renvoie {"library_read": bool, "counts": compteurs, "token_lost": bool}."""
    uid = m["id"]
    read_library = LIBRARIES.get(m["provider"])
    if not read_library:
        raise SourceError("unsupported_provider", m["provider"])
    previous = members.read(store, uid, "artists", {})
    source = None
    if reuse_library and previous:
        log("  Bibliothèque lue il y a moins de 20 heures : réutilisée")
        artists = copy.deepcopy(previous)
    elif spotify_paused and m["provider"] == "spotify":
        raise SourceError("quota", "Spotify en pause")
    else:
        # Deezer : n° du profil public ; Spotify : jeton du membre (chiffré en D1)
        source = members.SpotifyAccess(db, uid) if m["provider"] == "spotify" else m["provider_user_id"]
        artists = read_library(source, settings, previous)
    artists, hidden, hidden_keys = apply_prefs(artists, members.prefs(db, uid))

    events = copy.deepcopy(collected["events"])
    events = match.mark_favorites(events, members.favorite_venues(db, uid))
    events = match.match_known(events, match.ArtistIndex(artists))
    events = discover.score_events(events, artists, settings, hidden_keys, budget, excluded)

    member_history = members.read(store, uid, "history")
    new_history = history.update_member(events, member_history, set(collected["kept_ids"]))
    files = publish.build_member(events, {**artists, **hidden}, member_initial=member_history is None)
    files["history"] = new_history
    # Le membre a pu être supprimé ou changer de source pendant le calcul : rien n'est écrit
    if not members.still_current(db, uid, m["provider"], m["provider_user_id"]):
        members.delete_files(store, uid)
        raise MemberGone()
    total = members.check_quota(store, uid, files, settings)
    for name, value in files.items():
        members.write(store, uid, name, value)
    log(f"  Stockage R2 : {total / 1048576:.1f} Mo sur {settings['r2_bucket_max_mb']} Mo autorisés")
    return {"library_read": source is not None and m["provider"] == "spotify",
            "counts": files["meta"]["counts"],
            "token_lost": bool(getattr(source, "lost", False))}


def notify_result(db, m, code, info, today):
    """Messages après le calcul d'un membre : résultats prêts (premier calcul, ou nouvel essai
    réussi après une erreur passagère, annoncé sur le site), action attendue du membre (source à
    reconnecter) ou de l'admin, au premier calcul qui trouve l'erreur."""
    uid = m["id"]
    try:
        if code is None:
            recovered = m.get("last_sync_status") in members.TRANSIENT
            if not m.get("activated_at") or recovered:
                counts = (info or {}).get("counts") or {}
                notify.queue(db, "results_ready", uid, payload={"known": counts.get("known", 0),
                                                                 "discovery": counts.get("discovery", 0)},
                             dedupe=f"ready:{uid}" if not m.get("activated_at") else f"ready:{uid}:{today}")
            if (info or {}).get("token_lost"):
                notify.queue(db, "calc_error", uid, to_admin=True, payload={"code": "token_lost"},
                             dedupe=f"calc:{uid}:token_lost:{today}")
            return
        if code == m.get("last_sync_status"):
            return  # déjà signalé au calcul précédent
        if code in notify.MEMBER_ERRORS:
            notify.queue(db, "source_action", uid, payload={"code": code}, dedupe=f"source:{uid}:{code}:{today}")
        if code in notify.ADMIN_ERRORS:
            notify.queue(db, "calc_error", uid, to_admin=True, payload={"code": code}, dedupe=f"calc:{uid}:{code}:{today}")
    except Exception as exc:  # noqa: BLE001  une notification manquée n'arrête pas le traitement
        log(f"  Notification non enregistrée ({exc.__class__.__name__})")


def run_members(settings, db, store, selection, collected=None, kind="weekly"):
    collected = collected or store.get_json(COLLECTED)
    if not collected:
        raise SystemExit("Aucune collecte enregistrée (common/collected.json) : lancez d'abord la tâche commune.")
    run_id = members.start_run(db, kind)
    budget = {"left": settings["discovery"]["max_new_lookups"]}
    excluded = discover.big_venues()  # grandes salles, lues une fois pour tous les membres
    try:
        spotify_pause = members.service_pause(db, "spotify")
    except Exception as exc:  # noqa: BLE001  table absente (migration 0011 non appliquée)
        log(f"Pause Spotify illisible ({exc.__class__.__name__})")
        spotify_pause = None
    if spotify_pause:
        log(f"Spotify en pause (quota) jusqu'à {spotify_pause} : membres Spotify reportés")
    today = members.now_iso()[:10]
    failures, paused = 0, 0
    log(f"Tâche membres : {len(selection)} membre(s)")
    for m in selection:
        uid, started, started_at = m["id"], time.monotonic(), members.now_iso()
        log(f"Membre {uid} ({m['provider']})")
        code, info = None, None
        reuse = library_is_fresh(m, kind)
        try:
            info = compute_member(m, collected, settings, db, store, budget, excluded, reuse_library=reuse,
                                  spotify_paused=bool(spotify_pause))
        except MemberGone:
            log(f"  Membre {uid} : supprimé ou modifié pendant le calcul, résultats non enregistrés")
            continue
        except SourceError as exc:
            if exc.code == "superseded":  # reconnecté pendant le calcul : le calcul demandé suivra
                log(f"  Membre {uid} : reconnecté pendant le calcul, résultats non enregistrés")
                continue
            code = exc.code
            if code == "quota" and m["provider"] == "spotify" and not spotify_pause:
                # Quota du compte développeur : plus aucun appel Spotify avant l'heure indiquée
                spotify_pause = members.iso_in(max(int(exc.retry_after or QUOTA_PAUSE_DEFAULT_S), 60))
                try:
                    if members.set_service_pause(db, "spotify", spotify_pause, "quota"):
                        notify.queue(db, "spotify_paused", to_admin=True, payload={"until": spotify_pause},
                                     dedupe=f"pause:spotify:{spotify_pause[:13]}")
                except Exception as e:  # noqa: BLE001
                    log(f"  Pause Spotify non enregistrée ({e.__class__.__name__})")
                log(f"  Spotify en pause jusqu'à {spotify_pause}")
            if code == "quota":
                paused += 1
        except members.QuotaError as exc:
            log(f"  Stockage : {exc}")
            code = "storage_quota"
        except Exception as exc:  # noqa: BLE001  une erreur chez un membre n'arrête pas les autres
            log(f"  Erreur interne ({exc.__class__.__name__})")
            code = "internal"
        retry = members.next_retry(code, m.get("retry_count") or 0,
                                   spotify_pause if m["provider"] == "spotify" else None) if code else (None, 0)
        try:
            members.record_sync(db, uid, ok=code is None, error_code=code, started_at=started_at, retry=retry,
                                library_read=bool(info and info["library_read"]))
            members.record_member_run(db, run_id, uid, m["provider"], code is None, code, time.monotonic() - started)
        except Exception as exc:  # noqa: BLE001  membre supprimé entre-temps (clé étrangère)
            log(f"  Suivi du membre {uid} non enregistré ({exc.__class__.__name__})")
        notify_result(db, m, code, info, today)
        log(f"  Membre {uid} : {'calcul terminé' if code is None else f'erreur {code}'}"
            + (f", nouvel essai automatique vers {retry[0]}" if code and retry[0] else ""))
        failures += code is not None
    members.end_run(db, run_id, "ok" if not failures else f"{failures} erreur(s)")
    log(f"Tâche membres terminée : {len(selection) - failures} calcul(s) réussi(s), {failures} en erreur"
        + (f" (dont {paused} reporté(s) : quota Spotify)" if paused else ""))
    return failures


def main():
    parser = argparse.ArgumentParser(prog="python -m src.main", description="Traitement des concerts")
    parser.add_argument("task", nargs="?", choices=("common", "members", "promote", "newsletter", "notify", "venue-check"),
                        help="tâche seule (défaut : les deux, ou members avec --member / --pending)")
    parser.add_argument("--member", action="append", default=[], help="identifiant d'un membre à calculer")
    parser.add_argument("--pending", action="store_true", help="membres qui attendent un calcul")
    parser.add_argument("--test-member", default="", help="newsletter : essai pour ce seul membre")
    parser.add_argument("--venue", action="append", default=[], help="venue-check : salle à vérifier (identifiant)")
    args = parser.parse_args()
    for uid in args.member + ([args.test_member] if args.test_member else []):
        if not re.fullmatch(members.MEMBER_ID, uid):
            raise SystemExit("Identifiant de membre invalide (u_ suivi de 8 caractères)")

    settings = load_yaml(ROOT / "config" / "settings.yaml")
    db, store = cloud.d1(), cloud.r2()
    log(f"Données des membres : {db.label}, {store.label}")

    if args.task == "promote":
        promote(store)
        return
    if args.task == "notify":
        notify.send_pending(db)   # tâche à part : une erreur doit apparaître dans GitHub Actions
        return
    if args.task == "venue-check":
        if venue_check.run(db, store, COLLECTED, args.venue) and venue_check.full_run_due(db):
            launch_full_run()
        send_notifications(db)
        return
    if args.task == "newsletter":
        newsletter.send_all(db, store, store.get_json(COLLECTED), test_member=args.test_member or None)
        return
    targeted = bool(args.member or args.pending)
    task = args.task or ("members" if targeted else None)

    collected = None
    if task in (None, "common"):
        collected = common(settings, db, store)
        if task is None:
            promote(store)  # essai complet en local : pas d'envoi sur GitHub à attendre
    if task in (None, "members"):
        # Relance de sécurité (toutes les 2 heures) : salle ajoutée au catalogue depuis la dernière
        # collecte, traitement complet ; sinon rien à faire si aucun membre n'attend, et aucun
        # traitement enregistré
        new_venue = targeted and args.pending and not args.member and venue_check.full_run_due(db)
        if targeted and args.pending and not new_venue and not members.pending(db):
            log("Aucun membre en attente de calcul")
            send_notifications(db)  # messages que le site n'a pas pu faire envoyer
            return
        if targeted and (collection_is_stale(db) or new_venue):
            log("Salle ajoutée au catalogue : traitement complet" if new_venue
                else f"Collecte de plus de {STALE_DAYS} jours : traitement complet")
            collected = common(settings, db, store)
            mark_common_redone()
            targeted = False
        if targeted:
            waiting = members.pending(db)
            selection = members.by_ids(db, args.member) if args.member else []
            if args.pending:
                # Lancement par le site (relais compris) : un membre calculé entre-temps n'est pas
                # recalculé (le relais peut arriver après la fin d'un calcul long)
                ready = {m["id"] for m in waiting}
                for m in selection:
                    if m["id"] not in ready:
                        log(f"Membre {m['id']} : plus en attente (calcul déjà fait), ignoré")
                selection = [m for m in selection if m["id"] in ready]
            seen = {m["id"] for m in selection}
            selection += [m for m in waiting if m["id"] not in seen]
            if not selection:
                log("Aucun membre en attente de calcul")
                send_notifications(db)
                return
            kind = "member"
        else:
            selection, kind = members.active(db), "weekly"
        run_members(settings, db, store, selection, collected, kind)
        send_notifications(db)


if __name__ == "__main__":
    main()
