"""Traitement hebdomadaire : Deezer, sources de concerts, rapprochement, découvertes, site."""
import os

from . import deezer, discover, history, match, publish
from .sources import bandsintown, offi, qfap, ticketmaster, venues as venue_pages
from .util import ROOT, load_yaml, log


def run_source(label, status, fn, *args):
    try:
        events = fn(*args)
        status[label] = f"{len(events)} événements"
        return events
    except Exception as exc:  # une source en panne ne bloque pas les autres
        log(f"  {label} : échec ({exc.__class__.__name__}: {exc})")
        status[label] = "échec"
        return []


def main():
    settings = load_yaml(ROOT / "config" / "settings.yaml")
    venues_cfg = load_yaml(ROOT / "config" / "venues.yaml")

    artists = deezer.refresh_artists(settings)

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
    events = discover.score_events(events, artists, settings)

    events, initial = history.update(events)
    publish.build(events, artists, status, initial)


if __name__ == "__main__":
    main()
