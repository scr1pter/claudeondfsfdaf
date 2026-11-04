"""Pure source checks; no app, Bun, browser, provider or private gold access."""
import ast
import hashlib
import json
from pathlib import Path
import unittest

import headless_profile as variant

ROOT = Path(__file__).parent


class SourceContract(unittest.TestCase):
    def test_original_requirements_remain_byte_identical(self):
        original = json.loads((ROOT / "original-contract.json").read_text())
        self.assertEqual(hashlib.sha256((ROOT / "instrument/BUILD_SPEC.md").read_bytes()).hexdigest(), original["taskSha256"])

    def test_fifty_real_groups_and_four_prerequisites(self):
        tree = ast.parse((ROOT / "evaluate.py").read_text())
        groups = [node.decorator_list[0].args[0].value for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.decorator_list and isinstance(node.decorator_list[0], ast.Call)
            and getattr(node.decorator_list[0].func, "id", None) == "group"]
        original = json.loads((ROOT / "original-contract.json").read_text())
        self.assertEqual(groups, original["businessGroups"])
        self.assertEqual(len(set(groups)), 50)
        self.assertEqual(json.loads((ROOT / "task.json").read_text())["expectedTotalChecks"], 54)

    def test_only_four_role_instructions_changed(self):
        before, after = variant.BASE_PROFILE, variant.PROFILE
        self.assertEqual({k: v for k, v in before.items() if k != "instructions"}, {k: v for k, v in after.items() if k != "instructions"})
        changed = {role for role in before["instructions"] if before["instructions"][role] != after["instructions"][role]}
        self.assertEqual(changed, set(variant.CHANGED_ROLES))
        self.assertEqual(after["nativeAutonomousIdentities"], 7)
        self.assertEqual(after["maxDepth"], 2)
        self.assertIn("frontend_worker", after["childLifetimeSlots"])
        self.assertTrue(all(text.startswith(variant.COMMON) for text in after["instructions"].values()))

    def test_no_reference_in_seed_or_public_evaluator(self):
        seed = ROOT / "instrument/seed"
        self.assertEqual(set(path.name for path in seed.iterdir()), {"app.mjs", "cli.mjs", "sdk.mjs", "sdk.d.mts", "package.json"})
        self.assertIn("NOT_IMPLEMENTED", (seed / "app.mjs").read_text())
        evaluator = (ROOT / "evaluate.py").read_text()
        self.assertNotIn("headless-gold-private", evaluator)
        self.assertNotIn("openai", evaluator.lower())


if __name__ == "__main__":
    unittest.main()
