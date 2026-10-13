"""Fichiers de la fiche publique /partage : concerts répartis par début d'identifiant."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import publish


class ShareFiles(unittest.TestCase):
    def test_shards_cover_every_concert_and_drop_stale_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            share = Path(tmp) / "share"
            share.mkdir()
            (share / "zz.json").write_text("[]", encoding="utf-8")       # ancien fichier
            out = [{"id": i, "title": i} for i in ("ab12cd34ef56", "ab99", "c0ffee000000")]
            with mock.patch.object(publish, "SHARE", share):
                self.assertEqual(publish.build_share(out), 2)
            self.assertEqual(sorted(p.name for p in share.iterdir()), ["ab.json", "c0.json"])
            ids = [e["id"] for p in share.iterdir() for e in json.loads(p.read_text(encoding="utf-8"))]
            self.assertEqual(sorted(ids), sorted(e["id"] for e in out))


if __name__ == "__main__":
    unittest.main()


class VenueMatching(unittest.TestCase):
    def test_longest_name_wins_and_unsafe_links_dropped(self):
        from src import match
        from src.sources import venues
        m = match.VenueMatcher({"venues": [{"id": "elysee", "name": "Elysée", "aliases": []},
                                           {"id": "elysee-montmartre", "name": "Élysée Montmartre", "aliases": []}]})
        self.assertEqual(m.canonical("ELYSEE MONTMARTRE - Paris")[0], "elysee-montmartre")
        self.assertEqual(m.canonical("Théâtre de l'Elysée")[0], "elysee")
        self.assertIsNone(venues._web("javascript:alert(1)"))
        self.assertEqual(venues._web("https://salle.fr/a"), "https://salle.fr/a")
        self.assertEqual(venues._web("/agenda/x", "https://salle.fr/programme"), "https://salle.fr/agenda/x")
        self.assertIsNone(venues._web("javascript:alert(1)", "https://salle.fr/"))

    def test_comedy_and_theatre_left_out_of_the_catalogue(self):
        from src import match
        venues = match.VenueMatcher({"venues": []})
        base = {"date": "2099-01-01", "venue": "Salle"}
        events = [dict(base, id="c1", genre="Comedy"), dict(base, id="c2", genre="Theatre"),
                  dict(base, id="c3", genre="Children's Theatre"), dict(base, id="c4", genre="Théâtre, Humour"),
                  dict(base, id="k1", genre="Rock, Pop / Rock"), dict(base, id="k2", genre=None),
                  dict(base, id="k3", genre="Jazz / Blues")]
        self.assertEqual([e["id"] for e in match.prepare(events, venues)], ["k1", "k2", "k3"])

    def test_oversized_page_is_not_read(self):
        from src.sources import venues

        class Big:
            headers, encoding = {}, "utf-8"
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def iter_content(self, size): return iter([b"x" * size] * 200)  # 13 Mo
        with mock.patch.object(venues.SESSION, "get", lambda *a, **k: Big()):
            self.assertIsNone(venues._read("https://salle.fr/"))
