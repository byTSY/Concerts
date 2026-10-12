"""Traitement hebdomadaire : sources de concerts, rapprochement, découvertes, publication.

Étape 1 du passage multi-membres : le traitement lit le membre admin dans D1 (profil Deezer,
préférences, salles favorites), écrit ses résultats dans R2 (users/<id>/) et publie dans le
dépôt les seules données communes. La boucle sur tous les membres vient à l'étape 2.
"""
import os

from . import catalog, cloud, deezer, discover, history, match, members, publish
from .sources import bandsintown, dice, offi, qfap, ticketmaster, venues as venue_pages
from .util import ROOT, load_yaml, log, norm


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


def main():
    settings = load_yaml(ROOT / "config" / "settings.yaml")
    db, store = cloud.d1(), cloud.r2()
    log(f"Données des membres : {db.label}, {store.label}")
    venues_cfg = catalog.load(db)

    admins = [m for m in members.active(db) if m["role"] == "admin" and m["provider"] == "deezer"]
    if not admins:
        raise SystemExit("Aucun membre admin actif avec une source Deezer dans D1 : lancez d'abord la reprise "
                         "(python -m src.migrate import).")
    member = admins[0]
    uid = member["id"]
    log(f"Membre {uid} : lecture de la source Deezer")
    previous = members.read(store, uid, "artists", {})
    artists = deezer.refresh_artists(member["provider_user_id"], settings, previous)
    artists, hidden, hidden_keys = apply_prefs(artists, members.prefs(db, uid))

    log("Sources de concerts")
    status, events = {}, []
    tm_key = os.environ.get("TICKETMASTER_API_KEY")
    bit_id = os.environ.get("BANDSINTOWN_APP_ID")

    if tm_key:
        events += run_source("Ticketmaster", status, ticketmaster.fetch, settings, tm_key)
    else:
        status["Ticketmaster"] = "ignorée (clé absente)"
    if bit_id:
        events += run_source("Bandsintown", status, bandsintown.fetch, settings, bit_id, artists)
    else:
        status["Bandsintown"] = "ignorée (identifiant absent)"
    events += run_source("Que faire à Paris", status, qfap.fetch, settings)
    events += run_source("Offi", status, offi.fetch, settings)
    events += run_source("Dice", status, dice.fetch, settings)
    events += run_source("Sites des salles", status, venue_pages.fetch, venues_cfg)

    events = match.prepare(events, match.VenueMatcher(venues_cfg))
    events = match.mark_favorites(events, members.favorite_venues(db, uid))
    # Le dédoublonnage s'appuie encore sur les artistes rapprochés du membre (comme avant la
    # reprise) ; il passera dans l'étape commune à l'étape 2
    events = match.match_known(events, match.ArtistIndex(artists))
    events = match.dedupe(events)
    events = discover.score_events(events, artists, settings, hidden_keys)

    member_history = members.read(store, uid, "history")
    followed = set((member_history or {}).get("concerts", {})) | {s["concert_id"] for s in members.stars(db, uid)}
    events, initial, kept_ids = history.update_common(events, followed)
    publish.build_common(events, status, initial)

    new_history = history.update_member(events, member_history, kept_ids)
    files = publish.build_member(events, {**artists, **hidden}, member_initial=member_history is None)
    files["history"] = new_history
    total = members.check_quota(store, uid, files, settings)
    for name, value in files.items():
        members.write(store, uid, name, value)
    log(f"Stockage R2 : {total / 1048576:.1f} Mo sur {settings['r2_bucket_max_mb']} Mo autorisés")
    members.record_sync(db, uid, ok=True)
    log(f"Membre {uid} : résultats enregistrés ({store.label})")


if __name__ == "__main__":
    main()
