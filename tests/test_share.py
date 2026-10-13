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
