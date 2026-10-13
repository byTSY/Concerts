"""Client D1 distant : connexion neuve par requête, nouvel essai après une connexion coupée
(version 1.2.1 ; calcul d'un grand membre Spotify en erreur ReadTimeout après 9 min sans requête)."""
import unittest
from unittest import mock

import requests
from urllib3.exceptions import ConnectTimeoutError, MaxRetryError, NewConnectionError, ProtocolError

from src import cloud


def ok(rows):
    r = mock.Mock(status_code=200)
    r.json.return_value = {"success": True, "result": [{"results": rows}]}
    return r


def dropped():
    """Connexion gardée ouverte puis fermée par le serveur : coupure en cours de réponse."""
    return requests.exceptions.ConnectionError(ProtocolError("Connection aborted.", ConnectionResetError(104)))


def refused():
    """Connexion impossible avant tout envoi."""
    reason = NewConnectionError(None, "Failed to establish a new connection: [Errno 111] Connection refused")
    return requests.exceptions.ConnectionError(MaxRetryError(None, "/query", reason))


class RemoteD1Retry(unittest.TestCase):
    def setUp(self):
        self.db = cloud.RemoteD1("compte", "base", "jeton")
        sleep = mock.patch.object(cloud.time, "sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def post(self, *effects):
        p = mock.patch.object(cloud.requests, "post", side_effect=list(effects))
        self.addCleanup(p.stop)
        return p.start()

    def test_fresh_connection_for_every_query(self):
        post = self.post(ok([]), ok([]))
        self.db.query("SELECT 1")
        self.db.query("UPDATE users SET status = 'active' WHERE id = ?", ["u_1"])
        self.assertEqual(post.call_count, 2)
        for call in post.call_args_list:
            self.assertEqual(call.kwargs["headers"]["connection"], "close")
            self.assertEqual(call.kwargs["timeout"], (10, 60))
        self.assertFalse(hasattr(self.db, "session"))  # aucune connexion partagée

    def test_read_retried_after_dropped_connection_or_read_timeout(self):
        post = self.post(dropped(), requests.exceptions.ReadTimeout("60 s"), ok([{"n": 1}]))
        self.assertEqual(self.db.query("SELECT artist_key FROM artist_prefs WHERE user_id = ?", ["u_1"]), [{"n": 1}])
        self.assertEqual(post.call_count, 3)

    def test_read_gives_up_after_three_attempts(self):
        post = self.post(*[requests.exceptions.ReadTimeout("60 s")] * 3)
        with self.assertRaises(cloud.CloudError) as ctx:
            self.db.query("SELECT 1")
        self.assertIn("lecture", str(ctx.exception))
        self.assertEqual(post.call_count, 3)

    def test_write_not_retried_once_it_may_have_been_sent(self):
        for error in (dropped(), requests.exceptions.ReadTimeout("60 s")):
            with self.subTest(error=error.__class__.__name__), \
                    mock.patch.object(cloud.requests, "post", side_effect=[error, ok([])]) as post:
                with self.assertRaises(cloud.CloudError) as ctx:
                    self.db.query("INSERT INTO member_runs (run_id, user_id) VALUES (?, ?)", [1, "u_1"])
                self.assertIn("écriture", str(ctx.exception))
                self.assertEqual(post.call_count, 1)  # rien d'écrit en double

    def test_write_retried_when_it_could_not_leave(self):
        post = self.post(requests.exceptions.ConnectTimeout("10 s"), refused(), ok([]))
        self.db.query("UPDATE music_sources SET last_sync_at = ? WHERE user_id = ?", ["2026-10-13", "u_1"])
        self.assertEqual(post.call_count, 3)

    def test_real_exception_shapes(self):
        """Formes levées par requests 2.x : ConnectTimeout(MaxRetryError(ConnectTimeoutError)),
        ConnectionError(MaxRetryError(NewConnectionError)) ; SSL et proxy : pas de nouvel essai."""
        timeout = requests.exceptions.ConnectTimeout(MaxRetryError(None, "/q", ConnectTimeoutError(None, "délai")))
        self.assertTrue(cloud._not_sent(timeout))
        self.assertTrue(cloud._not_sent(refused()))
        self.assertFalse(cloud._not_sent(dropped()))
        self.assertFalse(cloud._not_sent(requests.exceptions.SSLError("ssl")))
        self.assertFalse(cloud._not_sent(requests.exceptions.ProxyError("proxy")))
        self.assertFalse(cloud._not_sent(requests.exceptions.ReadTimeout("60 s")))

    def test_truncated_response_and_server_errors(self):
        busy = mock.Mock(status_code=503)
        busy.json.return_value = {"success": False, "errors": [{"message": "busy"}]}
        post = self.post(requests.exceptions.ChunkedEncodingError("tronqué"), busy, ok([{"n": 2}]))
        self.assertEqual(self.db.query("SELECT 2"), [{"n": 2}])  # lecture : réessayée
        self.assertEqual(post.call_count, 3)
        post = self.post(busy, ok([]))
        with self.assertRaises(cloud.CloudError):
            self.db.query("DELETE FROM oauth_states WHERE expires_at < ?", ["x"])  # écriture : jamais
        self.assertEqual(post.call_count, 1)

    def test_select_with_write_keyword_counts_as_write(self):
        self.assertTrue(cloud._is_read("  select id from users"))
        self.assertTrue(cloud._is_read("WITH x AS (SELECT 1) SELECT * FROM x"))
        self.assertTrue(cloud._is_read("SELECT updated_at FROM stars"))  # « updated_at » n'est pas UPDATE
        self.assertFalse(cloud._is_read("INSERT INTO runs (kind) VALUES ('weekly') RETURNING id"))
        self.assertFalse(cloud._is_read("WITH x AS (SELECT 1) DELETE FROM runs"))


if __name__ == "__main__":
    unittest.main()
