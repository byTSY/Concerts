"""Garde-fou de volume R2 : rien n'est écrit au-delà des plafonds de config/settings.yaml."""
import tempfile
import unittest
from pathlib import Path

from src import cloud, members

SETTINGS = {"r2_bucket_max_mb": 1, "r2_member_file_max_mb": 0.5}
UID = "u_aaaaaaaa"


class Quota(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = cloud.LocalR2(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_under_limits(self):
        total = members.check_quota(self.store, UID, {"meta": {"a": "x" * 1000}}, SETTINGS)
        self.assertLess(total, 2000)

    def test_file_too_large(self):
        with self.assertRaises(members.QuotaError):
            members.check_quota(self.store, UID, {"artists": "x" * 600_000}, SETTINGS)

    def test_bucket_full_counts_other_members(self):
        self.store.put_json("users/u_bbbbbbbb/artists.json", "x" * 450_000)
        self.store.put_json("users/u_cccccccc/artists.json", "x" * 450_000)
        with self.assertRaises(members.QuotaError):
            members.check_quota(self.store, UID, {"artists": "x" * 200_000}, SETTINGS)

    def test_replaced_files_not_counted_twice(self):
        self.store.put_json(f"users/{UID}/artists.json", "x" * 450_000)
        self.store.put_json("users/u_bbbbbbbb/artists.json", "x" * 450_000)
        # Le fichier du membre est remplacé : son ancienne taille ne compte plus
        members.check_quota(self.store, UID, {"artists": "x" * 450_000}, SETTINGS)


if __name__ == "__main__":
    unittest.main()
