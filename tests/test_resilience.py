"""Version 1.9.0 : quota Spotify (pause, nouvel essai automatique), bibliothèque réutilisée dans
la journée, notifications par e-mail (file D1, rédaction, envoi), jeton renouvelé enregistré."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import cloud, main, members, notify
from src.library.base import SourceError, build, new_counts

from tests.test_members_run import NOW, SETTINGS, concert


def library(name):
    def read(_source, settings, previous):
        counts = {"1": {**new_counts(), "favorite": True}}
        meta = {"1": {"name": name, "link": "https://www.deezer.com/artist/1"}}
        return build(counts, meta, {}, previous, settings, "spotify")
    return read


class FakeSMTP:
    def __init__(self):
        self.sent = []

    def send_message(self, msg):
        self.sent.append(msg)

    def quit(self):
        pass


class Resilience(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = cloud.LocalD1(Path(self.tmp.name) / "t.db")
        with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"), \
                mock.patch.object(cloud, "log"):
            cloud.migrate(self.db)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        self.db.query("INSERT INTO users (id, email, first_name, role, status, invited_at) VALUES "
                      "('u_admin000', 'admin@test.fr', 'Admin', 'admin', 'active', ?)", [NOW])
        for uid in ("u_aaaaaaaa", "u_bbbbbbbb"):
            self.db.query("INSERT INTO users (id, email, first_name, status, invited_at) VALUES (?, ?, ?, 'computing', ?)",
                          [uid, f"{uid}@test.fr", uid[-1].upper(), NOW])
            self.db.query("INSERT INTO music_sources (user_id, provider, provider_user_id, status, sync_requested_at, "
                          "refresh_token_enc) VALUES (?, 'spotify', ?, 'connected', ?, 'v1.x.y')", [uid, uid, NOW])
        self.collected = {"initial": False, "kept_ids": ["c1"], "events": [concert("c1", "Alpha")]}

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def run(self, result=None):  # noqa: D401  journaux muets pendant les tests
        with mock.patch.object(main, "log"), mock.patch.object(members, "log"), mock.patch.object(main.history, "log"), \
                mock.patch.object(main.publish, "log"), mock.patch.object(notify, "log"):
            return super().run(result)

    def compute(self, read, selection=None, kind="member"):
        with mock.patch.dict(main.LIBRARIES, {"spotify": read}), \
                mock.patch.object(main.discover, "score_events", lambda ev, *a, **k: ev):
            return main.run_members(SETTINGS, self.db, self.store, selection or members.pending(self.db),
                                    self.collected, kind)

    def source(self, uid):
        return self.db.query("SELECT * FROM music_sources WHERE user_id = ?", [uid])[0]

    def notifications(self):
        return [(r["kind"], r["user_id"], r["to_admin"]) for r in self.db.query("SELECT * FROM notifications ORDER BY id")]

    def test_quota_pauses_spotify_and_schedules_retry_without_calling_again(self):
        calls = []

        def read(source, settings, previous):
            calls.append(source.user_id)
            raise SourceError("quota", "Retry-After 68167 s", retry_after=68167)

        failures = self.compute(read)
        self.assertEqual(failures, 2)
        self.assertEqual(calls, ["u_aaaaaaaa"])          # le second membre n'appelle pas Spotify
        pause = members.service_pause(self.db, "spotify")
        self.assertIsNotNone(pause)
        for uid in ("u_aaaaaaaa", "u_bbbbbbbb"):
            src = self.source(uid)
            self.assertEqual(src["last_sync_status"], "quota")
            self.assertEqual(src["retry_at"], pause)      # nouvel essai à la fin de la pause, pas avant
            self.assertEqual(src["retry_count"], 1)
        self.assertIn(("spotify_paused", None, 1), self.notifications())
        # Pas encore à échéance : plus en attente ; à échéance : de nouveau en attente
        self.assertEqual(members.pending(self.db), [])
        self.assertEqual({m["id"] for m in members.pending(self.db, now="2099-01-01T00:00:00+00:00")},
                         {"u_aaaaaaaa", "u_bbbbbbbb"})

    def test_retry_delays_then_stop_and_success_resets(self):
        self.assertEqual(members.next_retry("private_profile", 0), (None, 0))
        at, n = members.next_retry("spotify_unavailable", 0)
        self.assertTrue(at and n == 1)
        self.assertEqual(members.next_retry("quota", 4), (None, 4))       # 4 essais au plus
        self.compute(library("Alpha"))
        src = self.source("u_aaaaaaaa")
        self.assertEqual((src["retry_at"], src["retry_count"], src["last_sync_status"]), (None, 0, "ok"))
        self.assertIsNotNone(src["library_read_at"])

    def test_first_results_mail_to_member_once(self):
        self.compute(library("Alpha"))
        self.assertIn(("results_ready", "u_aaaaaaaa", 0), self.notifications())
        payload = json.loads(self.db.query("SELECT payload FROM notifications WHERE kind = 'results_ready' LIMIT 1")[0]["payload"])
        self.assertEqual(payload["known"], 1)
        self.db.query("UPDATE music_sources SET sync_requested_at = '2099-01-01T00:00:00+00:00'")
        self.compute(library("Alpha"))                    # membre déjà activé : pas de second message
        self.assertEqual([k for k, *_ in self.notifications()].count("results_ready"), 2)  # un par membre

    def test_member_and_admin_errors_notified_once(self):
        def read(source, settings, previous):
            raise SourceError("revoked" if source.user_id == "u_aaaaaaaa" else "not_allowlisted")

        self.compute(read)
        self.assertIn(("source_action", "u_aaaaaaaa", 0), self.notifications())
        self.assertIn(("calc_error", "u_bbbbbbbb", 1), self.notifications())
        self.db.query("UPDATE music_sources SET sync_requested_at = '2099-01-01T00:00:00+00:00', status = 'connected'")
        self.compute(read)                                # même erreur : pas de nouveau message
        self.assertEqual(len(self.notifications()), 2)

    def test_full_run_reuses_recent_spotify_library(self):
        self.compute(library("Alpha"))                    # lecture : library_read_at renseigné
        calls = []

        def read(source, settings, previous):
            calls.append(1)
            return library("Alpha")(source, settings, previous)

        self.compute(read, selection=members.active(self.db), kind="weekly")
        self.assertEqual(calls, [])                       # traitement complet : bibliothèque réutilisée
        self.assertEqual(set(members.read(self.store, "u_aaaaaaaa", "overlay")), {"c1"})
        # Demande du membre : lecture complète
        self.db.query("UPDATE music_sources SET sync_requested_at = '2099-01-01T00:00:00+00:00' WHERE user_id = 'u_aaaaaaaa'")
        self.compute(read, selection=members.active(self.db), kind="weekly")
        self.assertEqual(len(calls), 1)

    def test_paused_spotify_still_reuses_recent_library(self):
        self.compute(library("Alpha"))
        members.set_service_pause(self.db, "spotify", "2099-01-01T00:00:00+00:00", "quota")
        failures = self.compute(lambda *a: self.fail("appel Spotify pendant la pause"),
                                selection=members.active(self.db), kind="weekly")
        self.assertEqual(failures, 0)

    def test_success_after_transient_error_mails_member_already_active(self):
        self.compute(library("Alpha"))                    # premiers résultats
        self.db.query("UPDATE music_sources SET last_sync_status = 'quota', retry_at = '2000-01-01T00:00:00+00:00'")
        self.compute(library("Alpha"))                    # nouvel essai réussi : « à jour »
        ready = self.db.query("SELECT dedupe_key FROM notifications WHERE kind = 'results_ready' AND user_id = 'u_aaaaaaaa'")
        self.assertEqual(len(ready), 2)

    def test_pause_without_previous_library_does_not_call_spotify(self):
        self.db.query("UPDATE music_sources SET library_read_at = ?", [members.now_iso()])
        members.set_service_pause(self.db, "spotify", "2099-01-01T00:00:00+00:00", "quota")
        failures = self.compute(lambda *a: self.fail("appel Spotify pendant la pause"),
                                selection=members.active(self.db), kind="weekly")
        self.assertEqual(failures, 2)
        self.assertEqual(self.source("u_aaaaaaaa")["retry_at"], "2099-01-01T00:00:00+00:00")

    def test_send_pending_renders_and_marks_sent(self):
        self.db.query("INSERT INTO problem_reports (user_id, message, context, created_at) VALUES ('u_aaaaaaaa', 'rien', '{}', ?)", [NOW])
        notify.queue(self.db, "problem_report", "u_aaaaaaaa", to_admin=True,
                     payload={"message": "Je ne vois aucun concert", "context": {"ecran": "calendar"}}, dedupe="problem:1")
        notify.queue(self.db, "problem_report", "u_aaaaaaaa", to_admin=True, payload={}, dedupe="problem:1")  # doublon
        notify.queue(self.db, "results_ready", "u_bbbbbbbb", payload={"known": 3, "discovery": 2})
        smtp = FakeSMTP()
        cfg = {"sender": "concerts@test.fr", "site": "https://site.test"}
        with mock.patch.object(notify, "connect", return_value=smtp):
            self.assertEqual(notify.send_pending(self.db, cfg), 2)
            self.assertEqual(notify.send_pending(self.db, cfg), 0)   # déjà envoyés
        admin_mail, member_mail = smtp.sent
        self.assertEqual(admin_mail["To"], "admin@test.fr")
        self.assertEqual(admin_mail["Reply-To"], "u_aaaaaaaa@test.fr")  # réponse directe au membre
        self.assertIn("Je ne vois aucun concert", admin_mail.get_content())
        self.assertEqual(member_mail["To"], "u_bbbbbbbb@test.fr")
        self.assertIn("3 concert(s)", member_mail.get_content())
        self.assertIn("https://site.test/", member_mail.get_content())

    def test_failed_send_is_retried_then_abandoned(self):
        notify.queue(self.db, "member_login", "u_aaaaaaaa", to_admin=True, payload={"first": True})
        broken = mock.Mock(side_effect=OSError("réseau"))
        cfg = {"sender": "concerts@test.fr", "site": "https://site.test"}
        with mock.patch.object(notify, "connect", broken):
            for _ in range(notify.MAX_ATTEMPTS + 2):
                notify.send_pending(self.db, cfg)
        row = self.db.query("SELECT attempts, sent_at FROM notifications")[0]
        self.assertEqual((row["attempts"], row["sent_at"]), (notify.MAX_ATTEMPTS, None))

    def test_every_kind_renders(self):
        user = {"first_name": "Alice", "pseudo": None, "email": "a@test.fr", "status": "active"}
        for kind in ("member_joined", "member_login", "source_connected", "spotify_request", "problem_report",
                     "calc_error", "spotify_paused", "results_ready", "source_action", "spotify_ready"):
            subject, text = notify.render({"kind": kind, "payload": json.dumps({"until": NOW, "code": "revoked"})}, user, "https://s")
            self.assertTrue(subject and text, kind)
            self.assertNotIn("—", subject + text)
        self.assertIsNone(notify.render({"kind": "inconnu", "payload": "{}"}, user, "https://s"))


class TokenReplace(unittest.TestCase):
    """Jeton renouvelé par Spotify : écriture refaite après une erreur réseau, vérifiée."""

    def test_write_retried_after_network_error(self):
        db = mock.Mock()
        state = {"token": "ancien", "fail": 1}

        def query(sql, params=()):
            if sql.startswith("UPDATE"):
                if state["fail"]:
                    state["fail"] -= 1
                    raise cloud.CloudError("D1 : écriture impossible")
                if state["token"] == params[2]:
                    state["token"] = params[0]
                return []
            return [{"refresh_token_enc": state["token"]}]

        db.query.side_effect = query
        access = members.SpotifyAccess(db, "u_aaaaaaaa")
        access.read = "ancien"
        with mock.patch.object(members.time, "sleep"), mock.patch.object(members, "log"):
            self.assertTrue(access.replace("nouveau"))
        self.assertEqual(state["token"], "nouveau")
        self.assertFalse(access.lost)

    def test_write_impossible_reported(self):
        db = mock.Mock()
        db.query.side_effect = cloud.CloudError("D1 : écriture impossible")
        access = members.SpotifyAccess(db, "u_aaaaaaaa")
        access.read = "ancien"
        with mock.patch.object(members.time, "sleep"), mock.patch.object(members, "log"):
            self.assertFalse(access.replace("nouveau"))
        self.assertTrue(access.lost)


if __name__ == "__main__":
    unittest.main()
