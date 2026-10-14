"""Cas relevés par les audits de la version 1.12.0 : données publiées gardées pour une salle du
catalogue, nom proche d'une salle existante, fenêtre du lundi, état de lecture hebdomadaire,
adresses ambiguës, tableaux HTML sans balises de fin, doublons avec les billetteries,
redirections, retrait d'une salle ajoutée automatiquement."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from src import cloud, main, match, venue_check
from src.sources import htmltree, venues
from tests.test_venues import BASE, NAMES, FakeSite, day, event_ld, framer_cards, page, slug


def local_db(tmp):
    db = cloud.LocalD1(Path(tmp) / "t.db")
    with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"):
        cloud.migrate(db)
    return db


class StructuredDataKept(unittest.TestCase):
    def test_two_schema_org_concerts_beside_club_cards(self):
        # Salle du catalogue : 2 fiches schema.org et 5 cartes « Club » ; aucune méthode ne passe
        # le contrôle, les 2 concerts publiés par le site restent pris
        blocks = "".join(f"<script type='application/ld+json'>{event_ld(n, day(2 + i), f'{BASE}/c/{slug(n)}')}</script>"
                         for i, n in enumerate(NAMES[:2]))
        html = framer_cards(NAMES[:5], labels=["Club"] * 5).replace("</body>", blocks + "</body>")
        cfg = {"venues": [{"id": "salle", "name": "Salle", "aliases": [], "agenda_url": BASE + "/"}]}
        failures, readable = [], []
        with mock.patch.object(venues, "fetch_page", FakeSite({BASE + "/": html})), mock.patch.object(venues, "PAUSE", 0):
            events = venues.fetch(cfg, [], failures, readable)
        self.assertEqual(sorted(e["title"] for e in events), sorted(NAMES[:2]))
        self.assertEqual((failures, readable), ([], ["salle"]))


class Overlap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = local_db(self.tmp.name)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        self.db.query("INSERT INTO venues (id, name, aliases, status) VALUES ('olympia', 'Olympia', '[]', 'approved')")
        self.db.query("INSERT INTO venues (id, name, aliases, agenda_url, status, proposed_at, check_status) VALUES "
                      "('olympia-bruno-coquatrix', 'L''Olympia Bruno Coquatrix', '[]', ?, 'pending', '2026-10-14T10:00:00+00:00', 'running')",
                      [BASE + "/"])

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def test_readable_page_but_name_close_to_a_catalogue_venue_goes_to_the_admin(self):
        with mock.patch.object(venues, "fetch_page", FakeSite({BASE + "/": framer_cards()})), mock.patch.object(venues, "PAUSE", 0):
            self.assertEqual(venue_check.run(self.db, self.store, main.COLLECTED), 0)
        row = self.db.query("SELECT status, check_status, check_summary FROM venues WHERE id = 'olympia-bruno-coquatrix'")[0]
        self.assertEqual((row["status"], row["check_status"]), ("pending", "ok"))
        self.assertEqual(json.loads(row["check_summary"])["review"], ["Olympia"])
        self.assertEqual([r["kind"] for r in self.db.query("SELECT kind FROM notifications")], ["venue_needs_review"])


class Schedule(unittest.TestCase):
    def test_no_full_run_from_sunday_evening_to_monday_morning(self):
        sunday = datetime(2026, 10, 18, tzinfo=timezone.utc)
        self.assertFalse(venue_check.monday_window(sunday.replace(hour=19)))
        self.assertTrue(venue_check.monday_window(sunday.replace(hour=20)))
        self.assertTrue(venue_check.monday_window((sunday + timedelta(days=1)).replace(hour=4, minute=30)))
        self.assertFalse(venue_check.monday_window((sunday + timedelta(days=1)).replace(hour=9)))

    def test_removing_an_auto_added_venue_triggers_a_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = local_db(tmp)
            now = datetime(2026, 10, 14, 15, 0, tzinfo=timezone.utc)
            db.query("INSERT INTO runs (kind, started_at, ended_at, status, sources) VALUES ('weekly', ?, ?, 'ok', '{}')",
                     [(now - timedelta(hours=9)).isoformat(timespec="seconds"), (now - timedelta(hours=8)).isoformat(timespec="seconds")])
            db.query("INSERT INTO venues (id, name, status, auto_approved, reviewed_at) VALUES ('x', 'Salle X', 'rejected', 1, ?)",
                     [(now - timedelta(hours=1)).isoformat(timespec="seconds")])
            self.assertTrue(venue_check.full_run_due(db, now))
            db.query("UPDATE venues SET auto_approved = 0")
            self.assertFalse(venue_check.full_run_due(db, now))      # refus d'une simple proposition
            db.conn.close()


class WeeklyState(unittest.TestCase):
    def test_admin_told_once_when_a_readable_page_becomes_unreadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = local_db(tmp)
            db.query("INSERT INTO venues (id, name, status, check_status) VALUES ('a', 'Salle A', 'approved', 'ok')")
            db.query("INSERT INTO venues (id, name, status, check_status) VALUES ('b', 'Salle B', 'approved', 'failed')")
            db.query("INSERT INTO venues (id, name, status, check_status) VALUES ('c', 'Salle C', 'approved', 'failed')")
            broken = [{"id": "a", "name": "Salle A", "url": BASE, "reasons": ["x"], "was": "ok"},
                      {"id": "b", "name": "Salle B", "url": BASE, "reasons": ["x"], "was": "failed"}]
            main.record_venue_reads(db, broken, ["c"])
            states = {r["id"]: r["check_status"] for r in db.query("SELECT id, check_status FROM venues")}
            self.assertEqual(states, {"a": "failed", "b": "failed", "c": "ok"})
            self.assertEqual([json.loads(r["payload"])["id"] for r in db.query("SELECT payload FROM notifications")], ["a"])
            db.conn.close()

    def test_unreadable_venue_is_read_quickly(self):
        listing = page("".join(f"<a href='/agenda/{slug(n)}'>{n}</a>" for n in NAMES))
        site = FakeSite({BASE + "/agenda": listing})
        cfg = {"venues": [{"id": "s", "name": "S", "aliases": [], "agenda_url": BASE + "/agenda", "check_status": "failed"}]}
        with mock.patch.object(venues, "fetch_page", site), mock.patch.object(venues, "PAUSE", 0):
            venues.fetch(cfg, [], [])
        self.assertFalse([u for u in site.calls if "/agenda/" in u])   # aucune page de concert ouverte


class Addresses(unittest.TestCase):
    def test_ambiguous_host_is_refused_without_resolution(self):
        venues._public_hosts.clear()
        with mock.patch.object(venues.socket, "getaddrinfo", side_effect=AssertionError("résolution inattendue")):
            self.assertFalse(venues._public("http://127.0.0.1\\@exemple.fr/"))
            self.assertFalse(venues._public("http://exemple.fr x/"))
        venues._public_hosts.clear()

    def test_links_resolved_against_the_final_address(self):
        moved = venues.Page(framer_cards())
        moved.url = "https://www.autre-domaine.fr/"
        with mock.patch.object(venues, "fetch_page", lambda url: moved), mock.patch.object(venues, "PAUSE", 0):
            got = venues.read_venue(BASE + "/")
        self.assertTrue(got["ok"], got["reasons"])
        self.assertTrue(all(e["url"].startswith("https://www.autre-domaine.fr/agenda/") for e in got["events"]))


class Tables(unittest.TestCase):
    def test_rows_and_cells_without_end_tags(self):
        root = htmltree.parse("<table><tr><td>A<td>B<tr><td>C<td>D</table>")
        rows = [n for n in root._walk() if isinstance(n, htmltree.Node) and n.tag == "tr"]
        self.assertEqual([r.texts() for r in rows], [["A", "B"], ["C", "D"]])

    def test_nested_lists_kept(self):
        root = htmltree.parse("<ul><li>A<ul><li>A1<li>A2</ul><li>B</ul>")
        outer = [n for n in root.children[0].children if isinstance(n, htmltree.Node)]
        self.assertEqual([li.texts() for li in outer], [["A", "A1", "A2"], ["B"]])


class TimeLimit(unittest.TestCase):
    @unittest.skipUnless(hasattr(venues.signal, "setitimer"), "alarme indisponible (Windows) : vérifiée sur GitHub Actions")
    def test_slow_reading_is_interrupted(self):
        def endless(url):
            while True:
                pass
        with mock.patch.object(venues, "fetch_page", endless), mock.patch.object(venues, "VENUE_SECONDS", -19.5):
            got = venues.read_venue(BASE + "/")
        self.assertEqual(got["reasons"], ["lecture trop longue, interrompue"])


class Duplicates(unittest.TestCase):
    def test_site_title_merged_with_the_ticketing_event(self):
        base = {"date": "2026-10-23", "venue": "Bus Palladium", "venue_key": "bus palladium", "time": None}
        events = [dict(base, source="Ticketmaster", source_id="tm1", title="Alex Cameron", artists=["Alex Cameron"],
                       url="https://tm/1", title_only=False),
                  dict(base, source="Site Bus Palladium", source_id="s1", title="Alex Cameron + Josh Da Costa",
                       artists=[], url="https://bp/1", title_only=True),
                  dict(base, source="Site Bus Palladium", source_id="s2", title="Sacha Gordon", artists=[],
                       url="https://bp/2", title_only=True)]
        merged = match.dedupe(events)
        self.assertEqual(len(merged), 2)
        alex = next(e for e in merged if "Alex Cameron" in e["title"])
        self.assertEqual({l["source"] for l in alex["links"]}, {"Ticketmaster", "Site Bus Palladium"})


if __name__ == "__main__":
    unittest.main()
