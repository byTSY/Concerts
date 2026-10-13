"""Découvertes : grandes salles exclues (config/venues.yaml, version 1.4.0)."""
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from src import discover

SETTINGS = {"discovery": {"min_score": 0.25, "max_new_lookups": 10, "related_refresh_days": 90,
                          "favorite_venue_bonus": 0.1}}

# Libellés relevés dans site/data/events.json le 13 octobre 2026
BIG = ["ACCOR ARENA", "Accor Arena", "ZENITH PARIS - LA VILLETTE", "Le Zénith Paris – La Villette",
       "Zénith Paris La Villette", "Zénith Paris - La Villette", "PLENITUDE ARENA", "Plenitude Arena",
       "STADE DE FRANCE", "Stade de France", "AccorHotels Arena", "Paris La Défense Arena", "Zénith de Paris"]
NOT_BIG = ["L'Accord Parfait", "ADIDAS ARENA", "Adidas Arena", "La Cigale", "Bercy Village", "Le Trianon",
           "Petit Bain", "Stade Charléty"]


def concert(cid, venue, artists, matched=None):
    ev = {"id": cid, "title": artists[0], "date": "2026-12-01", "venue": venue, "artists": artists,
          "source_keys": [f"TM:{cid}"]}
    if matched:
        ev["matched"] = matched
    return ev


class BigVenues(unittest.TestCase):
    def test_spellings_from_the_catalogue(self):
        venues = discover.big_venues()
        for name in BIG:
            self.assertIsNotNone(venues.canonical(name), name)
        for name in NOT_BIG:
            self.assertIsNone(venues.canonical(name), name)

    def test_missing_file_excludes_nothing(self):
        self.assertIsNone(discover.big_venues(Path("absent.yaml")).canonical("Accor Arena"))

    def test_malformed_entries_never_break_the_run(self):
        """Entrée sans nom, alias vides, simple texte, YAML invalide : aucun calcul arrêté."""
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(discover, "log"):
            path = Path(tmp) / "venues.yaml"
            path.write_text(textwrap.dedent("""\
                discovery_excluded:
                  - aliases: [X]
                  - name: Accor Arena
                    aliases:
                  - Stade de France
                  - 42
                """), encoding="utf-8")
            venues = discover.big_venues(path)
            self.assertIsNotNone(venues.canonical("ACCOR ARENA"))
            self.assertIsNotNone(venues.canonical("Stade de France"))
            path.write_text(textwrap.dedent("""\
                discovery_excluded: [Accor Arena
                  - : :
                """), encoding="utf-8")
            self.assertIsNone(discover.big_venues(path).canonical("Accor Arena"))
            path.write_text("- juste une liste", encoding="utf-8")
            self.assertIsNone(discover.big_venues(path).canonical("Accor Arena"))
            path.write_text(textwrap.dedent("""\
                discovery_excluded:
                  - name: Stade de France
                    aliases: [~, '', Saint-Denis Stade]
                """), encoding="utf-8")
            venues = discover.big_venues(path)
            self.assertIsNone(venues.canonical("Salle None"))               # alias vide ignoré
            self.assertIsNotNone(venues.canonical("Saint-Denis Stade"))


class ScoreEvents(unittest.TestCase):
    """Artiste inconnu « Nouveau », proche de « Mien » (votre artiste de niveau 1)."""

    def run_score(self, events):
        mine = {"10": {"id": "10", "name": "Mien", "tier": 1, "score": 9}}
        found = {"nouveau": {"id": "20", "name": "Nouveau"}, "mien bis": {"id": "10", "name": "Mien"}}
        with mock.patch.object(discover.deezer, "load_caches", return_value=({}, {})), \
                mock.patch.object(discover.deezer, "save_caches"), \
                mock.patch.object(discover.deezer, "search_artist", side_effect=lambda n, c: found.get(n.lower())), \
                mock.patch.object(discover.deezer, "related", side_effect=lambda aid, c, d: ["10"] if aid == "20" else []), \
                mock.patch.object(discover, "log"):
            return {ev["id"]: ev for ev in discover.score_events(events, mine, SETTINGS)}

    def test_discovery_kept_in_small_venue_and_dropped_in_big_one(self):
        out = self.run_score([concert("c1", "La Cigale", ["Nouveau"]),
                              concert("c2", "ZENITH PARIS - LA VILLETTE", ["Nouveau"]),
                              concert("c3", "ADIDAS ARENA", ["Nouveau"])])
        self.assertEqual(out["c1"]["discovery"]["artist"], "Nouveau")
        self.assertNotIn("discovery", out["c2"])
        self.assertEqual(out["c3"]["discovery"]["artist"], "Nouveau")   # Adidas Arena gardée

    def test_your_artists_stay_in_big_venues(self):
        known = [{"id": "10", "name": "Mien", "tier": 1, "via": "nom"}]
        out = self.run_score([concert("c4", "ACCOR ARENA", ["Mien"], matched=known),
                              concert("c5", "PLENITUDE ARENA", ["Mien bis"])])  # autre libellé
        self.assertEqual(out["c4"]["matched"], known)                     # pas touché
        self.assertEqual(out["c5"]["matched"][0]["name"], "Mien")         # rapproché, pas écarté
        self.assertNotIn("discovery", out["c5"])


if __name__ == "__main__":
    unittest.main()
