"""Newsletter du lundi (version 1.5.0) : contenu par membre, envoi unique, abonnement."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import cloud, members, newsletter

TODAY = "2026-10-19"
NOW = "2026-10-12T00:00:00+00:00"
CFG = {"host": "smtp.test", "port": 587, "user": "envoi@test.fr", "password": "x", "sender": "envoi@test.fr",
       "site": "https://site.test"}


def ev(cid, day, title, badge=None, venue="La Cigale"):
    return {"id": cid, "date": day, "time": "20:00", "title": title, "venue": venue, "badge": badge}


EVENTS = [
    ev("a1", "2026-11-20", "Razorlight", badge="annonce"),          # annonce, votre artiste
    ev("a2", "2026-10-25", "Vieux concert"),                          # votre artiste, sous 30 jours
    ev("a3", "2026-10-30", "Liste"),                                  # nouveau dans votre liste
    ev("d1", "2026-10-28", "Découverte", venue="Petit Bain"),         # découverte sous 30 jours
    ev("d2", "2027-01-10", "Trop loin"),                              # découverte au-delà de 30 jours
    ev("o1", "2026-10-22", "Autre", badge="annonce"),                 # annonce hors de votre liste
    ev("p1", "2026-09-01", "Passé"),                                  # passé
]
OVERLAY = {
    "a1": {"kind": "known", "tier": 1, "matched": [{"name": "Razorlight", "tier": 1}]},
    "a2": {"kind": "known", "tier": 2, "matched": [{"name": "Vieux", "tier": 2}]},
    "a3": {"kind": "known", "tier": 3, "matched": [{"name": "Liste", "tier": 3}], "badge": "liste"},
    "d1": {"kind": "discovery", "discovery": {"artist": "Nouveau <b>", "score": 0.8, "close_to": ["Mien"]}},
    "d2": {"kind": "discovery", "discovery": {"artist": "Loin", "score": 0.9, "close_to": []}},
}


class Sections(unittest.TestCase):
    def test_three_sections(self):
        announced, recommended, going = newsletter.sections(EVENTS, OVERLAY, ["a1", "p1", "zz"], TODAY)
        self.assertEqual([e["id"] for e, _ in announced], ["a3", "a1"])     # par date
        self.assertEqual([e["id"] for e, _ in recommended], ["a2", "d1"])   # 30 jours, hors annoncés
        self.assertEqual([e["id"] for e, _ in going], ["a1"])               # à venir seulement

    def test_recommendations_capped_by_relevance(self):
        events = [ev(f"x{i:02d}", "2026-10-25", f"D{i}") for i in range(20)] + [ev("k", "2026-11-15", "K")]
        overlay = {f"x{i:02d}": {"kind": "discovery", "discovery": {"artist": f"D{i}", "score": i / 20}} for i in range(20)}
        overlay["k"] = {"kind": "known", "tier": 3, "matched": [{"name": "K", "tier": 3}]}
        _, recommended, _ = newsletter.sections(events, overlay, [], TODAY)
        ids = [e["id"] for e, _ in recommended]
        self.assertEqual(len(ids), 15)
        self.assertIn("k", ids)                       # vos artistes d'abord
        self.assertNotIn("x00", ids)                  # découvertes les moins proches écartées

    def test_email_escaped_and_links(self):
        announced, recommended, going = newsletter.sections(EVENTS, OVERLAY, ["a1"], TODAY)
        subject, text, html = newsletter.build_email("Léa <x>", announced, recommended, going,
                                                     "https://site.test", "https://site.test/partage/desabonnement/T")
        self.assertIn("2 annonces", subject)
        self.assertIn("Léa &lt;x&gt;", html)
        self.assertIn("Nouveau &lt;b&gt;", html)
        self.assertNotIn("<b>", html.replace("<body", ""))
        self.assertIn("https://site.test/partage/a1", html)
        self.assertIn("desabonnement/T", text)
        self.assertIn("jeudi 22 octobre".split()[0], newsletter.day_label("2026-10-22"))
        self.assertEqual(newsletter.day_label("2026-11-01"), "dimanche 1er novembre")

    def test_nothing_to_say_sends_nothing(self):
        self.assertIsNone(newsletter.build_email("Léa", [], [], [], "https://s", "https://s/u"))


class Sending(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = cloud.LocalD1(Path(self.tmp.name) / "t.db")
        with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"), \
                mock.patch.object(cloud, "log"):
            cloud.migrate(self.db)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        rows = [("u_aaaaaaaa", "active", 1), ("u_bbbbbbbb", "active", 0), ("u_cccccccc", "suspended", 1),
                ("u_dddddddd", "active", 1)]
        for uid, status, nl in rows:
            self.db.query("INSERT INTO users (id, email, first_name, status, invited_at, newsletter) VALUES (?, ?, ?, ?, ?, ?)",
                          [uid, f"{uid}@test.fr", uid, status, NOW, nl])
            members.write(self.store, uid, "overlay", OVERLAY if uid != "u_dddddddd" else {})
        self.db.query("INSERT INTO stars (user_id, concert_id, status, created_at, updated_at) VALUES "
                      "('u_aaaaaaaa', 'a1', 'going', ?, ?)", [NOW, NOW])
        self.smtp = mock.MagicMock()
        patch = mock.patch.object(newsletter, "connect", return_value=self.smtp)
        patch.start()
        self.addCleanup(patch.stop)
        logp = mock.patch.object(newsletter, "log")
        logp.start()
        self.addCleanup(logp.stop)

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def test_only_subscribed_active_members_once_a_day(self):
        sent = newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY)
        self.assertEqual(sent, 1)                                  # B désabonné, C suspendu, D sans contenu
        msg = self.smtp.send_message.call_args.args[0]
        self.assertEqual(msg["To"], "u_aaaaaaaa@test.fr")
        token = self.db.query("SELECT newsletter_token FROM users WHERE id = 'u_aaaaaaaa'")[0]["newsletter_token"]
        self.assertEqual(msg["List-Unsubscribe"], f"<https://site.test/partage/desabonnement/{token}>")
        self.assertEqual(msg["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")
        self.assertIn("Vos prochains concerts", msg.get_body(("html",)).get_content())
        # Nouveau lancement le même jour : rien de plus
        self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY), 0)
        self.assertEqual(self.smtp.send_message.call_count, 1)
        # Lundi suivant : jeton conservé
        newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, "2026-10-26")
        self.assertEqual(self.db.query("SELECT newsletter_token FROM users WHERE id = 'u_aaaaaaaa'")[0]["newsletter_token"], token)

    def test_one_failure_does_not_stop_the_others(self):
        self.db.query("UPDATE users SET newsletter = 1 WHERE id = 'u_bbbbbbbb'")
        self.smtp.send_message.side_effect = [RuntimeError("refusé"), None]
        self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY), 1)
        failed = self.db.query("SELECT newsletter_sent_at FROM users WHERE id = 'u_aaaaaaaa'")[0]["newsletter_sent_at"]
        self.assertIsNone(failed)                                  # nouvel essai possible

    def test_rerun_the_next_day_sends_nothing(self):
        newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY)
        self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, "2026-10-20"), 0)
        self.assertEqual(self.smtp.send_message.call_count, 1)

    def test_connection_failure_stops_cleanly(self):
        self.db.query("UPDATE users SET newsletter = 1 WHERE id = 'u_bbbbbbbb'")
        with mock.patch.object(newsletter, "connect", side_effect=OSError("injoignable")) as connect:
            self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY), 0)
        self.assertEqual(connect.call_count, 1)                    # pas un essai par membre

    def test_lost_connection_retried_once_with_a_new_one(self):
        import smtplib
        self.smtp.send_message.side_effect = [smtplib.SMTPServerDisconnected("coupé"), None]
        self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY), 1)
        self.assertEqual(self.smtp.send_message.call_count, 2)

    def test_missing_migration_does_not_fail_the_run(self):
        self.db.conn.executescript("DROP INDEX users_newsletter_token; ALTER TABLE users DROP COLUMN newsletter_sent_at;")
        self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, CFG, TODAY), 0)

    def test_without_smtp_settings_nothing_happens(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(newsletter.send_all(self.db, self.store, {"events": EVENTS}, None, TODAY), 0)
        self.smtp.send_message.assert_not_called()


if __name__ == "__main__":
    unittest.main()
