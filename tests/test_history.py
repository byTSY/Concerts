"""Non-régression : l'historique séparé (commun + membre) donne, pour un seul membre, les mêmes
identifiants, dates et badges que l'historique d'avant la reprise.

    python -m unittest discover -s tests -t .
"""
import copy
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from src import history
from tests import legacy_history


def fake_date(day):
    class FakeDate(date):
        @classmethod
        def today(cls):
            return date.fromisoformat(day)
    return FakeDate


def ev(eid, keys, day="2026-12-01", kind="other"):
    e = {"id": eid, "title": eid, "date": day, "time": "20:00", "venue": "V", "genre": None, "price": None,
         "links": [], "source_keys": keys}
    if kind == "known":
        e["matched"] = [{"id": "1", "name": "A", "tier": 1, "via": "artiste"}]
    if kind == "discovery":
        e["discovery"] = {"artist": "B", "score": 0.5}
    return e


# Trois semaines : base initiale, puis nouvelles annonces, entrées et sorties de liste, fusion de
# deux fiches, concert absent une semaine puis revenu
WEEKS = [
    ("2026-10-05", [
        ev("a1", ["S:1"], kind="known"),
        ev("b1", ["S:2"]),
        ev("c1", ["S:3"], kind="discovery"),
        ev("d1", ["T:4"]),
        ev("e1", ["S:5"], kind="known"),
        ev("m1", ["S:6"]),
        ev("m2", ["T:6"], kind="known"),
    ]),
    ("2026-10-12", [
        ev("a1", ["S:1"], kind="known"),
        ev("b1", ["S:2"], kind="known"),           # entre dans la liste
        ev("c1", ["S:3"]),                         # sort de la liste
        ev("n1", ["S:7"], kind="known"),           # nouvelle annonce dans la liste
        ev("n2", ["S:8"]),                         # nouvelle annonce hors liste
        ev("zz", ["S:6", "T:6"], kind="known"),    # fusion de m1 et m2
        # d1 et e1 absents cette semaine
    ]),
    ("2026-10-19", [
        ev("a1", ["S:1"], kind="known"),
        ev("b1", ["S:2"], kind="known"),
        ev("c1", ["S:3"], kind="discovery"),       # revient dans la liste
        ev("d1", ["T:4"], kind="known"),           # revient, et entre dans la liste
        ev("e1", ["S:5"], kind="known"),           # revient
        ev("n1", ["S:7"], kind="known"),
        ev("n2", ["S:8"], kind="known"),
        ev("zz", ["S:6", "T:6"], kind="known"),
    ]),
]


class HistoryRegression(unittest.TestCase):
    def test_same_ids_dates_and_badges(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_path, new_path = Path(tmp, "old.json"), Path(tmp, "new.json")
            member = None
            for day, events in WEEKS:
                with mock.patch.object(legacy_history, "PATH", old_path), \
                        mock.patch.object(legacy_history, "today_iso", lambda d=day: d), \
                        mock.patch.object(legacy_history, "date", fake_date(day)):
                    old_events, _ = legacy_history.update(copy.deepcopy(events))
                old_db = legacy_history.load_json(old_path, None)

                with mock.patch.object(history, "PATH", new_path), \
                        mock.patch.object(history, "today_iso", lambda d=day: d), \
                        mock.patch.object(history, "date", fake_date(day)):
                    followed = set((member or {}).get("concerts", {}))
                    new_events, _, kept = history.update_common(copy.deepcopy(events), followed)
                    member = history.update_member(new_events, member, kept)

                for o, n in zip(old_events, new_events):
                    with self.subTest(day=day, concert=o["id"]):
                        self.assertEqual(o["id"], n["id"])
                        self.assertEqual(o["first_seen"], n["first_seen"])
                        self.assertEqual(o["badge"], n["badge"] or n["list_badge"])
                        self.assertEqual(o["list_since"], (member["concerts"].get(n["id"]) or {}).get("list_since"))
                # Concerts gardés hors des sources : même liste, même date d'entrée dans la liste
                self.assertEqual({c["id"] for c in old_db["concerts"]}, kept)
                self.assertEqual({c["id"]: c["list_since"] for c in old_db["concerts"] if c.get("list_since")},
                                 {i: c["list_since"] for i, c in member["concerts"].items()})
                # Aucun champ personnel dans la base commune
                new_db = history.load_json(new_path, None)
                self.assertFalse({"kind", "list_since", "list_baseline"} & {k for c in new_db["concerts"] for k in c})


if __name__ == "__main__":
    unittest.main()
