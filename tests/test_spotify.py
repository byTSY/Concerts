"""Source Spotify (spécification, étape 4) : lecture de la bibliothèque, rapprochement Deezer,
jeton chiffré et renouvelé, révocation isolée, quota (Retry-After). Spotify est simulé."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import cloud, main, members
from src.library import spotify
from src.library.base import SourceError

KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="  # même clé de test que tests/functions.test.mjs
ENV = {"TOKEN_ENC_KEY": KEY, "SPOTIFY_CLIENT_ID": "client-test", "SPOTIFY_CLIENT_SECRET": "secret-client-test"}
SETTINGS = {
    "include_own_playlists": True,
    "scoring": {"favorite_artist": 5, "liked_album": 2, "liked_track": 1, "playlist_track": 0.25,
                "top_artist": 3, "tier1_min": 5, "tier2_min": 2},
    "discovery": {"max_new_lookups": 0},
    "r2_bucket_max_mb": 50, "r2_member_file_max_mb": 5,
}
API = spotify.API


def artist(sid, name, images=None):
    return {"id": sid, "name": name, "external_urls": {"spotify": f"https://open.spotify.com/artist/{sid}"},
            **({"images": images} if images else {})}


class Response:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self.body, self.headers = status, body or {}, headers or {}

    def json(self):
        return self.body


class FakeSpotify:
    """Bibliothèque simulée : Alpha suivi et très écouté, Beta en album (inconnu de Deezer),
    Gamma en titre liké et dans une playlist du membre ; une playlist d'un autre est ignorée."""

    def __init__(self, token_response=None, routes=None):
        self.token_response = token_response or Response(200, {"access_token": "ACCES-SECRET"})
        self.calls, self.posts = [], []
        alpha = artist("spA", "Alpha", [{"url": "big", "width": 640}, {"url": "mid", "width": 300}])
        self.routes = routes or {
            f"{API}/me": Response(200, {"id": "moi", "display_name": "Moi"}),
            f"{API}/me/following": Response(200, {"artists": {"items": [alpha], "next": None}}),
            f"{API}/me/albums": Response(200, {"items": [{"added_at": "2026-01-02T10:00:00Z",
                                                          "album": {"artists": [artist("spB", "Beta")]}}],
                                               "next": f"{API}/me/albums?page=2"}),
            f"{API}/me/albums?page=2": Response(200, {"items": [], "next": None}),
            f"{API}/me/tracks": Response(200, {"items": [
                {"added_at": "2026-03-04T10:00:00Z", "track": {"artists": [artist("spC", "Gamma"), artist("spA", "Alpha")]}},
                {"added_at": "2026-03-05T10:00:00Z", "track": {"artists": [artist("spV", "Various Artists")]}}], "next": None}),
            f"{API}/me/playlists": Response(200, {"items": [
                {"id": "pl1", "owner": {"id": "moi"}}, {"id": "pl2", "owner": {"id": "autre"}}], "next": None}),
            f"{API}/playlists/pl1/items": Response(200, {"items": [
                {"added_at": "2026-05-01T00:00:00Z", "item": {"type": "track", "artists": [artist("spC", "Gamma")]}},
                {"item": {"type": "episode", "artists": []}}], "next": None}),
            f"{API}/me/top/artists": Response(200, {"items": [alpha]}),
        }

    def post(self, url, data=None, auth=None, timeout=None):
        self.posts.append(data)
        return self.token_response

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(url)
        return self.routes.get(url, Response(404))


class SpotifyLibrary(unittest.TestCase):
    def setUp(self):
        patches = [mock.patch.dict(os.environ, ENV), mock.patch.object(spotify, "log", self.log),
                   mock.patch.object(spotify.time, "sleep", self.sleep),
                   mock.patch.object(spotify.deezer, "load_caches", lambda: ({}, {})),
                   mock.patch.object(spotify.deezer, "save_caches", lambda *a: None),
                   mock.patch.object(spotify.deezer, "search_artist", self.search)]
        self.logs, self.slept = [], []
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.access = mock.Mock(user_id="u_aaaaaaaa")
        self.access.token.return_value = spotify.encrypt("u_aaaaaaaa", "RAFRAICHISSEMENT-SECRET")

    def log(self, msg):
        self.logs.append(msg)

    def sleep(self, seconds):
        self.slept.append(seconds)

    @staticmethod
    def search(name, cache):
        return {"Alpha": {"id": "100", "name": "Alpha", "picture": "dz"}, "Gamma": {"id": "300", "name": "Gamma"}}.get(name)

    def read(self, fake, previous=None):
        with mock.patch.object(spotify.requests, "Session", lambda: fake):
            return spotify.read(self.access, SETTINGS, previous or {})

    def test_library_and_deezer_matching(self):
        fake = FakeSpotify()
        result = self.read(fake)
        self.assertEqual(set(result), {"100", "sp:spB", "300"})          # Beta non rapproché de Deezer
        alpha, beta, gamma = result["100"], result["sp:spB"], result["300"]
        self.assertEqual(alpha["sources"], {"favorite": True, "albums": 0, "tracks": 0, "playlists": 0, "top": 2})
        self.assertEqual(alpha["score"], 5 + 2 * 3)
        self.assertEqual((alpha["deezer_id"], alpha["spotify_id"], alpha["provider"]), ("100", "spA", "spotify"))
        self.assertEqual(alpha["link"], "https://open.spotify.com/artist/spA")
        self.assertEqual(alpha["picture"], "mid")
        self.assertNotIn("deezer_id", beta)
        self.assertEqual((beta["sources"]["albums"], beta["added"]), (1, "2026-01-02"))
        self.assertEqual((gamma["sources"]["tracks"], gamma["sources"]["playlists"], gamma["added"]), (1, 1, "2026-05-01"))
        self.assertNotIn(f"{API}/playlists/pl2/items", fake.calls)       # playlist d'un autre membre
        self.assertEqual(fake.posts[0]["refresh_token"], "RAFRAICHISSEMENT-SECRET")
        self.assertTrue(any("1 non rapprochés" in line for line in self.logs))
        # Journaux : ni jeton, ni nom d'artiste, ni identifiant Spotify
        text = "\n".join(self.logs)
        for secret in ("SECRET", "Alpha", "Gamma", "spA", "pl1"):
            self.assertNotIn(secret, text)

    def test_previous_unmatched_entry_replaced_once_matched(self):
        seen = {"first_seen": "2026-01-01", "last_seen": "2026-10-05", "still_liked": True}
        previous = {"sp:spA": {"id": "sp:spA", "name": "Alpha", "spotify_id": "spA", "score": 5, "tier": 1, **seen},
                    "sp:old": {"id": "sp:old", "name": "Ancien", "spotify_id": "old", "score": 1, "tier": 3, **seen}}
        result = self.read(FakeSpotify(), previous)
        self.assertNotIn("sp:spA", result)                                  # devenu « 100 »
        self.assertEqual(result["100"]["first_seen"], "2026-01-01")         # date d'apparition gardée
        self.assertFalse(result["sp:old"]["still_liked"])                  # retiré de la bibliothèque

    def test_new_refresh_token_replaces_old_one_encrypted(self):
        self.read(FakeSpotify(Response(200, {"access_token": "ACCES-SECRET", "refresh_token": "NOUVEAU-SECRET"})))
        saved = self.access.replace.call_args[0][0]
        self.assertNotIn("NOUVEAU", saved)
        self.assertEqual(spotify.decrypt("u_aaaaaaaa", saved), "NOUVEAU-SECRET")

    def test_revoked_not_allowlisted_and_key_errors(self):
        with self.assertRaises(SourceError) as ctx:
            self.read(FakeSpotify(Response(400, {"error": "invalid_grant"})))
        self.assertEqual(ctx.exception.code, "revoked")
        with self.assertRaises(SourceError) as ctx:
            self.read(FakeSpotify(routes={f"{API}/me": Response(403, {"error": {"status": 403}})}))
        self.assertEqual(ctx.exception.code, "not_allowlisted")
        # Clé changée : pas une révocation (le jeton est gardé)
        with mock.patch.dict(os.environ, {"TOKEN_ENC_KEY": "AQ" * 22}), self.assertRaises(SourceError) as ctx:
            self.read(FakeSpotify())
        self.assertEqual(ctx.exception.code, "token_key")

    def test_retry_after_respected_then_quota(self):
        fake = FakeSpotify()
        ok = fake.routes[f"{API}/me"]
        answers = [Response(429, headers={"Retry-After": "7"}), ok]
        fake.routes = dict(fake.routes)
        original_get = fake.get

        def get(url, **kw):
            if url == f"{API}/me" and answers:
                fake.calls.append(url)
                return answers.pop(0)
            return original_get(url, **kw)
        fake.get = get
        self.read(fake)
        self.assertIn(8, self.slept)                                        # Retry-After + 1 s
        with self.assertRaises(SourceError) as ctx:
            self.read(FakeSpotify(routes={f"{API}/me": Response(429, headers={"Retry-After": "3600"})}))
        self.assertEqual(ctx.exception.code, "quota")

    def test_decrypts_token_sealed_by_pages_functions(self):
        # Échantillon chiffré par functions/_lib/tokens.js avec la même clé
        sealed = "v1.Ygwb8cE6TUCG5OJP.PH7ydZVP8tuHqtz6cuf6qjkRwOGtahBBJPOAzBs5VPI"
        self.assertEqual(spotify.decrypt("u_aaaaaaaa", sealed), "jeton-de-test-js")
        with self.assertRaises(SourceError):
            spotify.decrypt("u_bbbbbbbb", sealed)


class RevokedMemberIsolated(unittest.TestCase):
    """Révocation chez Spotify : la source passe en revoked (jeton effacé) sans bloquer les autres."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = cloud.LocalD1(Path(self.tmp.name) / "t.db")
        self.addCleanup(self.db.conn.close)
        with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"):
            cloud.migrate(self.db)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        now = "2026-10-12T00:00:00+00:00"
        for uid in ("u_aaaaaaaa", "u_bbbbbbbb"):
            self.db.query("INSERT INTO users (id, email, first_name, status, invited_at) VALUES (?, ?, ?, 'active', ?)",
                          [uid, f"{uid}@test.fr", uid, now])
        with mock.patch.dict(os.environ, ENV):
            sealed = spotify.encrypt("u_aaaaaaaa", "RAFRAICHISSEMENT-SECRET")
        self.db.query("INSERT INTO music_sources (user_id, provider, provider_user_id, status, refresh_token_enc) "
                      "VALUES ('u_aaaaaaaa', 'spotify', 'moi', 'connected', ?)", [sealed])
        self.db.query("INSERT INTO music_sources (user_id, provider, provider_user_id, status) "
                      "VALUES ('u_bbbbbbbb', 'deezer', '222', 'connected')")

    def test_revoked_member_does_not_block_others(self):
        def deezer_read(uid, settings, previous):
            return {}
        fake = FakeSpotify(Response(400, {"error": "invalid_grant"}))
        collected = {"initial": False, "kept_ids": [], "events": []}
        with mock.patch.dict(os.environ, ENV), mock.patch.object(spotify.requests, "Session", lambda: fake), \
                mock.patch.dict(main.LIBRARIES, {"deezer": deezer_read}), \
                mock.patch.object(main.discover, "score_events", lambda ev, *a, **k: ev), \
                mock.patch.object(spotify, "log"), mock.patch.object(main, "log"), \
                mock.patch.object(main.history, "log"), mock.patch.object(main.publish, "log"):
            failures = main.run_members(SETTINGS, self.db, self.store, members.active(self.db), collected)
        self.assertEqual(failures, 1)
        src = self.db.query("SELECT status, refresh_token_enc, last_sync_status FROM music_sources WHERE user_id = 'u_aaaaaaaa'")[0]
        self.assertEqual((src["status"], src["refresh_token_enc"], src["last_sync_status"]), ("revoked", None, "revoked"))
        status = {r["id"]: r["status"] for r in self.db.query("SELECT id, status FROM users")}
        self.assertEqual(status, {"u_aaaaaaaa": "error", "u_bbbbbbbb": "active"})
        # La semaine suivante, la source révoquée n'est plus lue
        self.assertEqual([m["id"] for m in members.active(self.db)], ["u_bbbbbbbb"])
        dump = json.dumps([self.db.query("SELECT * FROM music_sources"), self.store.sizes()])
        self.assertNotIn("SECRET", dump)

    def test_reconnected_during_computation_keeps_new_token(self):
        """invalid_grant reçu alors que le membre vient de se reconnecter : son nouveau jeton est
        gardé, rien n'est enregistré pour ce calcul (le calcul demandé suivra)."""
        db = self.db

        class Reconnect(FakeSpotify):
            def post(self, url, data=None, auth=None, timeout=None):
                db.query("UPDATE music_sources SET refresh_token_enc = 'v1.nouveau.jeton', sync_requested_at = '2099-01-01' "
                         "WHERE user_id = 'u_aaaaaaaa'")
                db.query("UPDATE users SET status = 'computing' WHERE id = 'u_aaaaaaaa'")
                return Response(400, {"error": "invalid_grant"})

        collected = {"initial": False, "kept_ids": [], "events": []}
        with mock.patch.dict(os.environ, ENV), mock.patch.object(spotify.requests, "Session", lambda: Reconnect()),                 mock.patch.dict(main.LIBRARIES, {"deezer": lambda *a: {}}),                 mock.patch.object(main.discover, "score_events", lambda ev, *a, **k: ev),                 mock.patch.object(spotify, "log"), mock.patch.object(main, "log"),                 mock.patch.object(main.history, "log"), mock.patch.object(main.publish, "log"):
            main.run_members(SETTINGS, db, self.store, members.active(db), collected)
        src = db.query("SELECT status, refresh_token_enc FROM music_sources WHERE user_id = 'u_aaaaaaaa'")[0]
        self.assertEqual((src["status"], src["refresh_token_enc"]), ("connected", "v1.nouveau.jeton"))
        self.assertEqual(db.query("SELECT status FROM users WHERE id = 'u_aaaaaaaa'")[0]["status"], "computing")
        self.assertEqual([m["id"] for m in members.pending(db)], ["u_aaaaaaaa"])


if __name__ == "__main__":
    unittest.main()
