"""Traitement hebdomadaire : Deezer, sources de concerts, rapprochement, découvertes, site."""
import os

from . import deezer, discover, history, match, publish
from .sources import bandsintown, offi, qfap, ticketmaster, venues as venue_pages
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


def apply_prefs(artists):
    """Préférences de config/artist_prefs.yaml : niveaux imposés, puis artistes masqués retirés
    de votre liste. Renvoie (artistes actifs, artistes masqués, noms masqués normalisés)."""
    prefs = load_yaml(ROOT / "config" / "artist_prefs.yaml")
    levels = {norm(n): int(t) for n, t in (prefs.get("levels") or {}).items() if n and str(t) in {"1", "2", "3"}}
    changed = 0
    for a in artists.values():
        a["tier_auto"] = a.get("tier_auto", a["tier"]) if a.get("tier_forced") else a["tier"]
        forced = levels.get(norm(a["name"]))
        a["tier"] = forced or a["tier_auto"]
        a["tier_forced"] = bool(forced)
        changed += bool(forced)
    if levels:
        log(f"  {changed} niveaux imposés")

    names = prefs.get("hidden") or []
    keys = {norm(n) for n in names if n}
    hidden = {i: a for i, a in artists.items() if norm(a["name"]) in keys}
    active = {i: a for i, a in artists.items() if i not in hidden}
    unknown = keys - {norm(a["name"]) for a in hidden.values()}
    if keys:
        log(f"  {len(hidden)} artistes de votre liste masqués"
            + (f" ; hors de votre liste, masqués des découvertes : {', '.join(sorted(unknown))}" if unknown else ""))
    return active, hidden, keys


def main():
    settings = load_yaml(ROOT / "config" / "settings.yaml")
    venues_cfg = load_yaml(ROOT / "config" / "venues.yaml")

    artists = deezer.refresh_artists(settings)
    artists, hidden, hidden_keys = apply_prefs(artists)

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
    events += run_source("Sites des salles", status, venue_pages.fetch, venues_cfg)

    vm = match.VenueMatcher(venues_cfg)
    events = match.prepare(events, vm)
    events = match.match_known(events, match.ArtistIndex(artists))
    events = match.dedupe(events)
    events = discover.score_events(events, artists, settings, hidden_keys)

    events, initial = history.update(events)
    publish.build(events, {**artists, **hidden}, status, initial, hidden=set(hidden))


if __name__ == "__main__":
    main()
