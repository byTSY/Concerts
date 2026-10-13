"""Tâche membres (spécification, étape 2) : deux membres donnent deux univers distincts, et un
profil privé passe son membre en erreur sans interrompre les autres."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import cloud, main, members
from src.library.base import SourceError, build, new_counts

SETTINGS = {
    "scoring": {"favorite_artist": 5, "liked_album": 2, "liked_track": 1, "playlist_track": 0.25,
                "top_artist": 3, "tier1_min": 5, "tier2_min": 2},
    "discovery": {"max_new_lookups": 0},
    "r2_bucket_max_mb": 50, "r2_member_file_max_mb": 5,
}
NOW = "2026-10-12T00:00:00+00:00"


def library(names):
    """Fausse bibliothèque : artistes favoris donnés par leur nom."""
    def read(_uid, settings, previous):
        counts, meta = {}, {}
        for i, n in enumerate(names):
            aid = f"{abs(hash(n)) % 10**6}"
            counts[aid] = {**new_counts(), "favorite": True}
            meta[aid] = {"name": n, "link": f"https://www.deezer.com/artist/{aid}"}
        return build(counts, meta, {}, previous, settings, "deezer")
    return read


def concert(cid, artist, venue_id=None):
    return {"id": cid, "title": artist, "date": "2026-12-01", "time": "20:00", "venue": "Salle",
            "venue_id": venue_id, "venue_key": "salle", "artists": [artist], "source_keys": [f"TM:{cid}"],
            "badge": None, "first_seen": "2026-10-05", "merged_ids": [cid], "links": []}


class MembersRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = cloud.LocalD1(Path(self.tmp.name) / "t.db")
        with mock.patch.object(cloud, "MIGRATIONS", Path(__file__).resolve().parent.parent / "migrations"):
            cloud.migrate(self.db)
        self.store = cloud.LocalR2(Path(self.tmp.name) / "r2")
        for uid, deezer_id in (("u_aaaaaaaa", "111"), ("u_bbbbbbbb", "222"), ("u_cccccccc", "333")):
            self.db.query("INSERT INTO users (id, email, first_name, status, invited_at) VALUES (?, ?, ?, 'active', ?)",
                          [uid, f"{uid}@test.fr", uid, NOW])
            self.db.query("INSERT INTO music_sources (user_id, provider, provider_user_id, status) "
                          "VALUES (?, 'deezer', ?, 'connected')", [uid, deezer_id])
        self.db.query("INSERT INTO venues (id, name, status) VALUES ('salle', 'Salle', 'approved')")
        self.db.query("INSERT INTO venue_favorites (user_id, venue_id, added_at) VALUES ('u_bbbbbbbb', 'salle', ?)", [NOW])
        self.collected = {"initial": False, "kept_ids": ["c1", "c2", "c3"],
                          "events": [concert("c1", "Alpha"), concert("c2", "Beta", "salle"), concert("c3", "Gamma")]}

    def tearDown(self):
        self.db.conn.close()
        self.tmp.cleanup()

    def run_all(self):
        libs = {"111": library(["Alpha"]), "222": library(["Beta"])}

        def read(uid, settings, previous):
            if uid not in libs:
                raise SourceError("private_profile")
            return libs[uid](uid, settings, previous)

        with mock.patch.dict(main.LIBRARIES, {"deezer": read}), \
                mock.patch.object(main.discover, "score_events", lambda ev, *a, **k: ev), \
                mock.patch.object(main, "log"), mock.patch.object(main.history, "log"), \
                mock.patch.object(main.publish, "log"):
            return main.run_members(SETTINGS, self.db, self.store, members.active(self.db), self.collected)

    def test_distinct_universes_and_isolated_error(self):
        failures = self.run_all()
        self.assertEqual(failures, 1)
        a = members.read(self.store, "u_aaaaaaaa", "overlay")
        b = members.read(self.store, "u_bbbbbbbb", "overlay")
        self.assertEqual(set(a), {"c1"})                      # Alpha seulement
        self.assertEqual(set(b), {"c2"})                      # Beta seulement, salle favorite
        self.assertTrue(b["c2"].get("venue_favorite"))
        self.assertNotIn("venue_favorite", a.get("c1", {}))
        # Le membre au profil privé : statut error, code enregistré, aucun fichier
        status = {r["id"]: r["status"] for r in self.db.query("SELECT id, status FROM users")}
        self.assertEqual(status, {"u_aaaaaaaa": "active", "u_bbbbbbbb": "active", "u_cccccccc": "error"})
        self.assertEqual(self.store.list("users/u_cccccccc/"), [])
        runs = {r["user_id"]: (r["status"], r["error_code"]) for r in self.db.query("SELECT * FROM member_runs")}
        self.assertEqual(runs["u_cccccccc"], ("error", "private_profile"))
        self.assertEqual(runs["u_aaaaaaaa"], ("ok", None))

    def test_member_deleted_during_computation(self):
        """Membre supprimé pendant son calcul : rien n'est réécrit, le traitement continue."""
        db = self.db
        alpha = library(["Alpha"])

        def read(uid, settings, previous):
            if uid == "111":
                db.query("DELETE FROM users WHERE id = 'u_aaaaaaaa'")
            if uid == "333":
                raise SourceError("private_profile")
            return alpha(uid, settings, previous) if uid == "111" else library(["Beta"])(uid, settings, previous)

        self.store.put_json("users/u_aaaaaaaa/meta.json", {"ancien": True})
        with mock.patch.dict(main.LIBRARIES, {"deezer": read}),                 mock.patch.object(main.discover, "score_events", lambda ev, *a, **k: ev),                 mock.patch.object(main, "log"), mock.patch.object(main.history, "log"),                 mock.patch.object(main.publish, "log"):
            main.run_members(SETTINGS, db, self.store, members.active(db), self.collected)
        self.assertEqual(self.store.list("users/u_aaaaaaaa/"), [])         # rien ne réapparaît
        self.assertEqual(set(members.read(self.store, "u_bbbbbbbb", "overlay")), {"c2"})  # B calculé
        self.assertEqual(db.query("SELECT status FROM runs")[0]["status"], "1 erreur(s)")

    def test_pending_selection(self):
        self.assertEqual(members.pending(self.db), [])
        self.db.query("UPDATE music_sources SET sync_requested_at = ? WHERE user_id = 'u_bbbbbbbb'", [NOW])
        self.assertEqual([m["id"] for m in members.pending(self.db)], ["u_bbbbbbbb"])
        self.run_all()
        self.assertEqual(members.pending(self.db), [])        # calcul fait après la demande

    def test_safety_net_without_pending_member_does_nothing(self):
        """Relance des 2 heures sans membre en attente : ni calcul, ni traitement enregistré,
        même avec une collecte périmée."""
        with mock.patch.object(main.cloud, "d1", lambda **k: self.db),                 mock.patch.object(main.cloud, "r2", lambda **k: self.store),                 mock.patch.object(main, "common") as full, mock.patch.object(main, "log"),                 mock.patch("sys.argv", ["src.main", "members", "--pending"]):
            main.main()
        full.assert_not_called()
        self.assertEqual(self.db.query("SELECT COUNT(*) AS n FROM runs")[0]["n"], 0)


if __name__ == "__main__":
    unittest.main()
