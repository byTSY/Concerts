"""Numéro de version : même valeur dans VERSION, le pied de page du site et le journal."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Version(unittest.TestCase):
    def test_version_is_consistent(self):
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        page = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
        self.assertEqual(re.search(r'id="app-version">([^<]+)<', page).group(1), version)
        self.assertIn(f"## {version} ", (ROOT / "CHANGELOG.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
