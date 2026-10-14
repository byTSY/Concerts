"""Lecteur universel des pages programme et vérification des salles proposées (version 1.12.0).

Pages HTML synthétiques reprenant les structures observées sur les sites de salles parisiennes
(octobre 2026) : date dans le lien (Framer), date hors du lien (WordPress), date dans l'adresse,
fiches seulement sur les pages de concert (Drupal), API WordPress « The Events Calendar »,
page d'accueil donnée à la place du programme. Aucun appel réseau.
"""
import json
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from src import cloud, main, venue_check
from src.sources import venues

TODAY = date.today()
MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
NAMES = ["Alex Cameron", "Sacha Gordon", "Apollone", "The Bones of JR Jones", "Myrath", "King Woman"]
BASE = "https://salle.example.fr"


def day(n):
    return TODAY + timedelta(days=n)


def fr(d):
    return f"{d.day} {MONTHS_FR[d.month - 1]} {d.year}"


def slug(name):
    return "-".join(venues.fold(name).replace(".", "").split())


def page(body):
    return f"<!doctype html><html><head><title>Agenda</title></head><body><nav><a href='/'>Accueil</a>" \
           f"<a href='/contact'>Contact</a></nav>{body}</body></html>"


def framer_cards(names=NAMES, labels=None):
    """Carte entièrement dans le lien : « 23 oct. 2026 | Alex Cameron | concert | +infos »."""
    labels = labels or ["concert"] * len(names)
    return page("".join(
        f"<a href='./agenda/{slug(n)}'><div><p>{fr(day(3 + i))}</p><p>{n}</p><p>{labels[i]}</p><p>+infos</p></div></a>"
        for i, n in enumerate(names)))


def wordpress_cards(names=NAMES):
    """Date hors du lien, dans le bloc de la carte ; genre et bouton à côté du titre."""
    return page("<div class='grid'>" + "".join(
        f"<article class='card'><div class='date'><span>{day(5 + i).day:02d}</span><span>―</span>"
        f"<span>{['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'][day(5 + i).month - 1]} {day(5 + i).year}</span></div>"
        f"<p>Rock</p><h3><a href='{BASE}/programmation/{slug(n)}/'>{n}</a></h3>"
        f"<span>20h30</span><a href='{BASE}/programmation/{slug(n)}/'>En savoir plus</a></article>"
        for i, n in enumerate(names)) + "</div>")


def event_ld(name, d, url, extra=None):
    return json.dumps({"@context": "https://schema.org", "@type": "Event", "name": name,
                       "startDate": f"{d.isoformat()}T19:30:00+01:00", "url": url, **(extra or {})})


class FakeSite:
    """fetch_page simulé : {adresse: html}, adresse inconnue = page inaccessible."""

    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def __call__(self, url):
        self.calls.append(url)
        if url not in self.pages:
            raise venues.PageError("page inaccessible (HTTP 404)")
        return self.pages[url]


class Dates(unittest.TestCase):
    def test_french_and_english_formats(self):
        ref = date(2026, 10, 14)
        self.assertEqual(venues.find_date("23 oct. 2026 | Alex Cameron", ref), date(2026, 10, 23))
        self.assertEqual(venues.find_date("mercredi | Mer. | 14 | octobre | Oct. | 2026", ref), date(2026, 10, 14))
        self.assertEqual(venues.find_date("06 ― novembre 2026 Pitchfork", ref), date(2026, 11, 6))
        self.assertEqual(venues.find_date("jeudi 1er janvier", ref), date(2027, 1, 1))     # année suivante
        self.assertEqual(venues.find_date("Ven. 31.10 I 23h>05h", ref), date(2026, 10, 31))
        self.assertEqual(venues.find_date("Oct 16, 2026", ref), date(2026, 10, 16))
        self.assertEqual(venues.find_date("2026-11-05T20:00", ref), date(2026, 11, 5))
        self.assertIsNone(venues.find_date("Billetterie et infos pratiques", ref))

    def test_tuesday_is_not_march_and_prices_are_not_dates(self):
        ref = date(2026, 10, 14)
        self.assertEqual(venues.find_date("Mar. 21 oct. | Alex Cameron", ref), date(2026, 10, 21))
        self.assertEqual(venues.find_date("mar 21 octobre 2026", ref), date(2026, 10, 21))
        self.assertIsNone(venues.find_date("Tarif 15.10 €", ref))
        self.assertIsNone(venues.find_date("12 sept.", ref))          # sans année et passée : archives

    def test_times(self):
        self.assertEqual(venues.find_time("• 19:30 | 23:30"), "19:30")
        self.assertEqual(venues.find_time("ouverture 20h"), "20:00")
        self.assertEqual(venues.find_time("20h30 > 05h"), "20:30")
        self.assertIsNone(venues.find_time("Places : 25 €"))

    def test_title_closest_to_link_name(self):
        parts = ["23 oct. 2026", "TADAM", "cabaret", "+infos"]
        self.assertEqual(venues.title_of(parts, "https://x.fr/agenda/tadam-2"), "TADAM")
        parts = ["Rock", "Café de la Danse", "HONNE", "à partir de 28 €"]
        self.assertEqual(venues.title_of(parts, "https://x.fr/event/honne-2/"), "HONNE")
        self.assertEqual(venues.category_of(["16 oct.", "Prime Time Party", "club"]), "club")


class Cards(unittest.TestCase):
    def test_framer_cards_inside_links(self):
        events = venues.from_cards(framer_cards(), BASE + "/")
        self.assertEqual([e["title"] for e in events], NAMES)
        self.assertEqual([e["date"] for e in events], [day(3 + i) for i in range(len(NAMES))])

    def test_date_outside_the_link_stays_with_its_card(self):
        events = venues.from_cards(wordpress_cards(), BASE + "/")
        self.assertEqual([(e["title"], e["date"], e["time"]) for e in events],
                         [(n, day(5 + i), "20:30") for i, n in enumerate(NAMES)])

    def test_date_in_link_address_wins(self):
        d = day(20)
        html = page("".join(f"<div><a href='/evenement/{slug(n)}_{(d + timedelta(days=i)).isoformat()}'>"
                            f"<h2>{n}</h2><p>Réserver</p></a><p>{fr(day(1))}</p></div>" for i, n in enumerate(NAMES)))
        events = venues.from_cards(html, BASE + "/")
        self.assertEqual([e["date"] for e in events], [d + timedelta(days=i) for i in range(len(NAMES))])

    def test_list_items_without_closing_tags(self):
        # <li> sans </li> (HTML5 valide) : chaque élément reste une carte distincte
        html = page("<ul>" + "".join(f"<li><span>{fr(day(3 + i))}</span> <a href='/agenda/{slug(n)}'>{n}</a>"
                                     for i, n in enumerate(NAMES)) + "</ul>")
        events = venues.from_cards(html, BASE + "/")
        self.assertEqual([(e["title"], e["date"]) for e in events], [(n, day(3 + i)) for i, n in enumerate(NAMES)])

    def test_large_page_read_quickly(self):
        # Liens d'un même dossier répartis dans de grandes sections : pas de lecture quadratique
        filler = "<p>" + "texte " * 4000 + "</p>"
        html = page("".join(f"<section>{filler}<a href='/agenda/{slug(n)}-{i}'>{n}</a>{filler}</section>"
                            for i, n in enumerate(NAMES * 20)))
        started = time.monotonic()
        venues.from_cards(html, BASE + "/")
        self.assertLess(time.monotonic() - started, 10)

    def test_navigation_archives_and_other_sites_ignored(self):
        html = framer_cards() + page("<a href='/agenda/archives'>Archives 2025</a><a href='https://autre.fr/agenda/x'>x</a>"
                                     "<a href='/agenda/page/2'>Suivant</a>")
        urls = {e["url"] for e in venues.from_cards(html, BASE + "/")}
        self.assertTrue(all("/agenda/" in u and "archives" not in u and "page/2" not in u for u in urls))
        self.assertEqual(len(urls), len(NAMES))


class Check(unittest.TestCase):
    def events(self, titles=NAMES, urls=None, start=3):
        urls = urls or [f"{BASE}/agenda/{slug(t)}" for t in titles]
        return [{"title": t, "date": day(start + i), "url": u, "card": True} for i, (t, u) in enumerate(zip(titles, urls))]

    def test_good_reading_passes(self):
        got = venue_check.check(self.events())
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["stats"]["upcoming"], len(NAMES))
        self.assertEqual(len(got["sample"]), venue_check.SAMPLE)

    def test_too_few_concerts(self):
        self.assertFalse(venue_check.check(self.events(NAMES[:2]))["ok"])

    def test_titles_shifted_by_one_card_are_refused(self):
        # Titre de la carte voisine : les liens ne correspondent plus aux titres (cas réel corrigé)
        shifted = self.events(NAMES[1:] + NAMES[:1], urls=[f"{BASE}/agenda/{slug(t)}" for t in NAMES])
        got = venue_check.check(shifted)
        self.assertFalse(got["ok"])
        self.assertTrue(any("sans rapport" in r for r in got["reasons"]))

    def test_genre_instead_of_title_is_refused(self):
        titles = ["Jazz", "Rock", "Concert", "Jazz", "Pop", "Blues"]
        got = venue_check.check(self.events(titles, urls=[f"{BASE}/agenda/{slug(n)}" for n in NAMES]))
        self.assertFalse(got["ok"])

    def test_archives_are_refused(self):
        past = [{"title": n, "date": day(-30 - i), "url": f"{BASE}/agenda/{slug(n)}"} for i, n in enumerate(NAMES)]
        self.assertFalse(venue_check.check(past + self.events(NAMES[:3]))["ok"])

    def test_only_club_nights_are_not_a_concert_venue(self):
        events = [dict(e, category="club") for e in self.events()]
        self.assertFalse(venue_check.check(events)["ok"])

    def test_structured_data_without_links_passes(self):
        # Fiches schema.org sans adresse propre, ou adresses numériques : pas de règle titre / lien
        events = [{"title": n, "date": day(3 + i), "url": f"{BASE}/event/{1000 + i}"} for i, n in enumerate(NAMES)]
        self.assertTrue(venue_check.check(events)["ok"])

    def test_disagreement_with_ticketing_sources(self):
        reference = [(day(40 + i).isoformat(), f"Autre groupe {i}") for i in range(6)] + \
                    [(day(3 + i).isoformat(), f"Groupe inconnu {i}") for i in range(6)]
        got = venue_check.check(self.events(), reference)
        self.assertFalse(got["ok"])
        agreeing = [(day(3 + i).isoformat(), n) for i, n in enumerate(NAMES)]
        self.assertTrue(venue_check.check(self.events(), agreeing)["ok"])
        self.assertEqual(venue_check.check(self.events(), agreeing)["stats"]["agreement"], 1.0)


class ReadVenue(unittest.TestCase):
    def read(self, pages, url):
        site = FakeSite(pages)
        with mock.patch.object(venues, "fetch_page", site), mock.patch.object(venues, "PAUSE", 0):
            return venues.read_venue(url), site

    def test_cards_of_the_programme_page(self):
        got, _ = self.read({BASE + "/": framer_cards()}, BASE + "/")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["method"], "cartes de la page")

    def test_listing_without_dates_then_concert_pages(self):
        # Liste sans date lisible ; chaque page de concert porte sa fiche schema.org (cas Bal Chavaux)
        listing = page("".join(f"<a href='/agenda/{slug(n)}'>{n}</a>" for n in NAMES))
        pages = {BASE + "/agenda": listing}
        for i, n in enumerate(NAMES):
            url = f"{BASE}/agenda/{slug(n)}"
            pages[url] = f"<html><script type='application/ld+json'>{event_ld(n, day(4 + i), url)}</script><h1>{n}</h1></html>"
        got, _ = self.read(pages, BASE + "/agenda")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["method"], "pages de concert")
        self.assertEqual([e["time"] for e in got["events"]], ["19:30"] * len(NAMES))

    def test_concert_pages_without_data_are_abandoned_quickly(self):
        listing = page("".join(f"<a href='/agenda/{slug(n)}'>{n}</a>" for n in NAMES))
        pages = {BASE + "/agenda": listing, **{f"{BASE}/agenda/{slug(n)}": "<html><h1>x</h1></html>" for n in NAMES}}
        got, site = self.read(pages, BASE + "/agenda")
        self.assertFalse(got["ok"])
        opened = [u for u in site.calls if "/agenda/" in u]
        self.assertEqual(len(opened), venues.DETAIL_GIVE_UP)

    def test_homepage_leads_to_the_programme(self):
        home = page("<a href='/la-salle'>La salle</a><a href='/programmation'>Programmation</a>")
        got, _ = self.read({BASE + "/": home, BASE + "/programmation": wordpress_cards()}, BASE + "/")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["url"], BASE + "/programmation")

    def test_wordpress_events_calendar(self):
        api = json.dumps({"events": [{"title": n, "start_date": f"{day(6 + i).isoformat()} 20:00:00",
                                      "url": f"{BASE}/event/{slug(n)}/"} for i, n in enumerate(NAMES)]})
        pages = {BASE + "/agenda": page("<p>Chargement…</p>"),
                 f"{BASE}/wp-json/tribe/events/v1/events?per_page=50&start_date={TODAY.isoformat()}": api}
        got, _ = self.read(pages, BASE + "/agenda")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["method"], "agenda WordPress")

    def test_unreadable_page(self):
        got, _ = self.read({}, BASE + "/agenda")
        self.assertFalse(got["ok"])
        self.assertIn("HTTP 404", got["reasons"][0])

    def test_json_ld_on_the_programme_page(self):
        blocks = "".join(f"<script type='application/ld+json'>{event_ld(n, day(2 + i), f'{BASE}/c/{slug(n)}', {'performer': {'@type': 'MusicGroup', 'name': n}})}</script>"
                         for i, n in enumerate(NAMES))
        got, _ = self.read({BASE + "/agenda": page(blocks)}, BASE + "/agenda")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertEqual(got["method"], "fiches de la page")
        self.assertEqual(got["events"][0]["artists"], [NAMES[0]])


class Politeness(unittest.TestCase):
    def setUp(self):
        venues._robots.clear()
        patcher = mock.patch.object(venues, "_public", lambda url: "interne" not in url)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_redirect_to_an_internal_address_is_refused(self):
        class Moved:
            status_code, headers, encoding = 302, {"location": "http://interne.local/admin"}, "utf-8"
            def __enter__(self): return self
            def __exit__(self, *a): return False
        venues._robots["https://salle.example.fr"] = None
        with mock.patch.object(venues.SESSION, "get", lambda *a, **k: Moved()), mock.patch.object(venues, "PAUSE", 0):
            with self.assertRaises(venues.PageError) as err:
                venues.fetch_page(BASE + "/agenda")
        self.assertIn("non publique", str(err.exception))


    def test_robots_txt_forbids_reading(self):
        class Robots:
            status_code, headers, encoding = 200, {"content-type": "text/plain"}, "utf-8"
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def iter_content(self, size): return iter([b"User-agent: *\nDisallow: /agenda\n"])
        with mock.patch.object(venues.SESSION, "get", lambda *a, **k: Robots()), mock.patch.object(venues, "PAUSE", 0):
            with self.assertRaises(venues.PageError) as err:
                venues.fetch_page(BASE + "/agenda")
        self.assertIn("robots.txt", str(err.exception))

    def test_http_error_is_an_unreadable_page(self):
        class Missing:
            status_code, headers, encoding = 404, {}, "utf-8"
            text = ""
            def __enter__(self): return self
            def __exit__(self, *a): return False
        with mock.patch.object(venues.SESSION, "get", lambda *a, **k: Missing()), mock.patch.object(venues, "PAUSE", 0):
            with self.assertRaises(venues.PageError):
                venues.fetch_page(BASE + "/agenda")


class PublicAddresses(unittest.TestCase):
    def setUp(self):
        venues._public_hosts.clear()
        self.addCleanup(venues._public_hosts.clear)

    def resolve(self, ip):
        return mock.patch.object(venues.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", (ip, 0))])

    def test_names_resolving_to_internal_addresses_are_refused(self):
        for ip in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1"):
            venues._public_hosts.clear()
            with self.resolve(ip):
                self.assertFalse(venues._public("https://intranet.example.fr/"), ip)
        venues._public_hosts.clear()
        with self.resolve("151.101.1.1"):
            self.assertTrue(venues._public("https://salle.example.fr/"))


class WeeklyFetch(unittest.TestCase):
    def test_non_concert_cards_left_out_and_failures_reported(self):
        labels = ["concert", "club", "concert", "cabaret", "concert", "concert"]
        pages = {BASE + "/": framer_cards(labels=labels)}
        cfg = {"venues": [{"id": "salle-test", "name": "Salle Test", "aliases": [], "agenda_url": BASE + "/"},
                          {"id": "salle-muette", "name": "Salle Muette", "aliases": [], "agenda_url": BASE + "/vide"}]}
        failures = []
        with mock.patch.object(venues, "fetch_page", FakeSite(pages)), mock.patch.object(venues, "PAUSE", 0):
            events = venues.fetch(cfg, [], failures)
        self.assertEqual([e["title"] for e in events], [n for n, l in zip(NAMES, labels) if l == "concert"])
        self.assertTrue(all(e["source"] == "Site Salle Test" and e["title_only"] for e in events))
        self.assertEqual([f["id"] for f in failures], ["salle-muette"])

    def test_catalogue_venue_with_two_dates_keeps_its_schema_org_concerts(self):
        blocks = "".join(f"<script type='application/ld+json'>{event_ld(n, day(2 + i), f'{BASE}/c/{slug(n)}')}</script>"
                         for i, n in enumerate(NAMES[:2]))
        cfg = {"venues": [{"id": "petite-salle", "name": "Petite Salle", "aliases": [], "agenda_url": BASE + "/agenda"}]}
        failures = []
        with mock.patch.object(venues, "fetch_page", FakeSite({BASE + "/agenda": page(blocks)})), mock.patch.object(venues, "PAUSE", 0):
            events = venues.fetch(cfg, [], failures)
        self.assertEqual(len(events), 2)
        self.assertEqual(failures, [])


class VenueCheckTask(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = cloud.LocalD1(Path(self.tmp.name) / "t.db")
        with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"):
            cloud.migrate(self.db)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        self.db.query("INSERT INTO users (id, email, first_name, status, invited_at) VALUES ('u_aaaaaaaa', 'a@test.fr', 'Frederic', 'active', '2026-10-01T00:00:00+00:00')")
        for vid, url in (("salle-lisible", BASE + "/"), ("salle-muette", BASE + "/vide")):
            self.db.query("INSERT INTO venues (id, name, aliases, agenda_url, status, proposed_by, proposed_at, check_status) "
                          "VALUES (?, ?, '[]', ?, 'pending', 'u_aaaaaaaa', '2026-10-14T16:27:00+00:00', 'running')",
                          [vid, vid.replace("-", " ").title(), url])

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def run_check(self):
        with mock.patch.object(venues, "fetch_page", FakeSite({BASE + "/": framer_cards()})), mock.patch.object(venues, "PAUSE", 0):
            return venue_check.run(self.db, self.store, main.COLLECTED)

    def test_readable_venue_added_unreadable_left_to_admin(self):
        self.assertEqual(self.run_check(), 1)
        rows = {r["id"]: r for r in self.db.query("SELECT * FROM venues")}
        self.assertEqual((rows["salle-lisible"]["status"], rows["salle-lisible"]["auto_approved"], rows["salle-lisible"]["check_status"]),
                         ("approved", 1, "ok"))
        self.assertEqual((rows["salle-muette"]["status"], rows["salle-muette"]["check_status"]), ("pending", "failed"))
        self.assertTrue(json.loads(rows["salle-muette"]["check_summary"])["reasons"])
        kinds = sorted(r["kind"] for r in self.db.query("SELECT kind FROM notifications WHERE to_admin = 1"))
        self.assertEqual(kinds, ["venue_added", "venue_check_failed"])
        added = json.loads(self.db.query("SELECT payload FROM notifications WHERE kind = 'venue_added'")[0]["payload"])
        self.assertEqual(added["proposer"], "Frederic")
        self.assertEqual(len(added["sample"]), venue_check.SAMPLE)

    def test_admin_decision_during_the_check_wins(self):
        self.db.query("UPDATE venues SET status = 'rejected' WHERE id = 'salle-lisible'")
        self.db.query("UPDATE venues SET check_status = NULL WHERE id = 'salle-muette'")
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.db.query("SELECT status FROM venues WHERE id = 'salle-lisible'")[0]["status"], "rejected")

    def test_full_run_after_an_addition_at_most_every_six_hours(self):
        now = datetime(2026, 10, 14, 15, 0, tzinfo=timezone.utc)   # mercredi
        def run(ended):
            self.db.query("DELETE FROM runs")
            self.db.query("INSERT INTO runs (kind, started_at, ended_at, status, sources) VALUES ('weekly', ?, ?, 'ok', '{}')",
                          [(ended - timedelta(minutes=20)).isoformat(timespec="seconds"), ended.isoformat(timespec="seconds")])
        self.db.query("UPDATE venues SET status = 'approved', reviewed_at = ? WHERE id = 'salle-lisible'",
                      [(now - timedelta(minutes=1)).isoformat(timespec="seconds")])
        run(now - timedelta(hours=7))
        self.assertTrue(venue_check.full_run_due(self.db, now))
        run(now - timedelta(hours=2))
        self.assertFalse(venue_check.full_run_due(self.db, now))           # collecte trop récente
        run(now - timedelta(hours=7))
        self.assertFalse(venue_check.full_run_due(self.db, datetime(2026, 10, 19, 6, 0, tzinfo=timezone.utc)))  # lundi matin
        self.db.query("UPDATE venues SET reviewed_at = '2026-10-01T00:00:00+00:00'")
        self.assertFalse(venue_check.full_run_due(self.db, now))           # rien d'ajouté depuis
        # Collecte relancée il y a 3 h mais en échec : pas de nouvel essai toutes les 2 heures
        self.db.query("UPDATE venues SET reviewed_at = ? WHERE id = 'salle-lisible'",
                      [(now - timedelta(hours=8)).isoformat(timespec="seconds")])
        run(now - timedelta(hours=9))
        self.db.query("INSERT INTO runs (kind, started_at, status) VALUES ('weekly', ?, 'error')",
                      [(now - timedelta(hours=3)).isoformat(timespec="seconds")])
        self.assertFalse(venue_check.full_run_due(self.db, now))


if __name__ == "__main__":
    unittest.main()
