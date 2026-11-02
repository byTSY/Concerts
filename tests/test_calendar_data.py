"""Données de l'ajout au calendrier (version 1.16.0) : source de l'horaire gardée à la fusion,
adresse reprise d'une autre source de la même salle."""
import unittest

from src import match, publish


class TimeSource(unittest.TestCase):
    def test_source_of_the_kept_time(self):
        base = {"date": "2026-11-20", "venue": "La Maroquinerie", "venue_key": "la maroquinerie", "artists": ["Eliah"],
                "title": "Eliah", "title_only": False}
        events = [dict(base, source="Ticketmaster", source_id="tm1", url="https://tm/1", time=None),
                  dict(base, source="Dice", source_id="d1", url="https://dice/1", time="19:30")]
        merged = match.dedupe(events)
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0]["time"], merged[0]["time_source"]), ("19:30", "Dice"))

    def test_no_time_no_source(self):
        ev = {"date": "2026-11-20", "venue": "Salle", "venue_key": "salle", "artists": [], "title": "X", "title_only": True,
              "source": "Offi", "source_id": "o1", "url": "https://offi/1", "time": None}
        self.assertIsNone(match.dedupe([ev])[0]["time_source"])


class Addresses(unittest.TestCase):
    def test_same_venue_only(self):
        out = [
            {"venue": "Salle Gaveau", "venue_id": None, "address": "45 rue La Boétie", "city": "Paris"},
            {"venue": "Salle Gaveau", "venue_id": None, "address": "45 rue La Boétie", "city": "Paris"},
            {"venue": "salle gaveau", "venue_id": None, "address": None, "city": None},
            {"venue": "Gaveau", "venue_id": None, "address": None, "city": None},  # libellé seulement proche : rien
            {"venue": "Le Trabendo", "venue_id": "v_tr", "address": None, "city": None},
            {"venue": "LE TRABENDO (Parc de la Villette)", "venue_id": "v_tr", "address": "211 av. Jean Jaurès", "city": "Paris"},
        ]
        self.assertEqual(publish.fill_addresses(out), 2)
        self.assertEqual((out[2]["address"], out[2]["city"]), ("45 rue La Boétie", "Paris"))
        self.assertIsNone(out[3]["address"])
        self.assertEqual(out[4]["address"], "211 av. Jean Jaurès")

    def test_same_name_other_city(self):
        out = [
            {"venue": "Salle des fêtes", "venue_id": None, "address": "1 rue A", "city": "Paris"},
            {"venue": "Salle des fêtes", "venue_id": None, "address": "2 rue B", "city": "Montreuil"},
            {"venue": "Salle des fêtes", "venue_id": None, "address": None, "city": "Montreuil"},
            {"venue": "Salle des fêtes", "venue_id": None, "address": None, "city": None},  # deux villes : rien
            {"venue": "Salle des fêtes", "venue_id": None, "address": None, "city": "Vincennes"},
        ]
        self.assertEqual(publish.fill_addresses(out), 1)
        self.assertEqual(out[2]["address"], "2 rue B")
        self.assertIsNone(out[3]["address"])
        self.assertIsNone(out[4]["address"])


if __name__ == "__main__":
    unittest.main()
