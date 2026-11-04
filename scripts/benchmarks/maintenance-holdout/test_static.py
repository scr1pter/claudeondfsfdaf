"""Source-only contract checks; no process, app server, provider or Bun."""
import ast
import hashlib
import json
from pathlib import Path
import unittest

import evaluate

ROOT = Path(__file__).resolve().parent


class StaticControls(unittest.TestCase):
    def test_exact_preregistered_fifty_plus_four_inventory(self):
        inventory = json.loads((ROOT / "CHECK-INVENTORY.json").read_bytes())
        self.assertEqual([name for name, _ in evaluate.GROUPS], inventory["business"])
        self.assertEqual(len(set(inventory["business"])), 50)
        self.assertEqual(len(set(inventory["prerequisite"])), 4)
        self.assertEqual(inventory["expectedTotal"], 54)

    def test_no_provider_cloud_or_runtime_side_effect_at_import(self):
        tree = ast.parse((ROOT / "evaluate.py").read_bytes())
        imported = [alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names]
        self.assertNotIn("openai", imported)
        self.assertNotIn("anthropic", imported)
        self.assertNotIn("requests", imported)
        self.assertEqual(len(evaluate.GROUPS), 50)

    def test_complete_legacy_fixture_is_nonempty_and_immutable_bytes(self):
        fixture = json.loads(evaluate.LEGACY_BYTES)
        self.assertEqual(fixture["version"], 1)
        self.assertEqual(len(fixture["accounts"]), 1)
        self.assertEqual(len(fixture["usage"]), 1)
        self.assertEqual(fixture["accounts"][0]["id"], fixture["usage"][0]["accountId"])
        self.assertEqual(fixture["usage"][0]["units"], 120)

    def test_checksum_canonicalization_covers_nested_objects_unicode_and_order(self):
        one = {"z": [{"b": "é", "a": 1}], "a": 2}
        two = {"a": 2, "z": [{"a": 1, "b": "é"}]}
        self.assertEqual(evaluate.canonical(one), evaluate.canonical(two))
        self.assertIn("é".encode(), evaluate.canonical(one))
        self.assertNotEqual(hashlib.sha256(evaluate.canonical(one)).digest(), hashlib.sha256(evaluate.canonical({"a": 2, "z": []})).digest())

    def test_requirement_and_evaluator_syntax_exist_before_private_reference(self):
        self.assertIn("maintenance", (ROOT / "instrument/BUILD_SPEC.md").read_text().lower())
        ast.parse((ROOT / "evaluate.py").read_bytes())
        self.assertFalse((ROOT / "gold").exists())
        self.assertFalse((ROOT / "reference").exists())


if __name__ == "__main__":
    unittest.main()
