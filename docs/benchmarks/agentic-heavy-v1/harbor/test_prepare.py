import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("harbor_prepare", ROOT / "prepare.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationControls(unittest.TestCase):
    def test_exact_empty_scaffold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = module.prepare(root / "app", root / "manifest.json")
            self.assertEqual(result, {"fileCount": 6, "applicationImplementationSeeded": False})
            expected = set(module.SEED_FILES) | {"BUILD_SPEC.md"}
            self.assertEqual({path.name for path in (root / "app").iterdir()}, expected)
            self.assertFalse((root / "app/server").exists())
            self.assertFalse((root / "app/src").exists())
            saved = json.loads((root / "manifest.json").read_text())
            self.assertEqual(set(saved["files"]), expected)
            self.assertFalse(saved["applicationImplementationSeeded"])

    def test_preserve_existing_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); app = root / "app"; app.mkdir()
            (app / "keep.txt").write_text("keep")
            with self.assertRaisesRegex(ValueError, "new or empty"):
                module.prepare(app, root / "manifest.json")
            self.assertEqual((app / "keep.txt").read_text(), "keep")

    def test_no_manifest_inside_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                module.prepare(root / "app", root / "app/manifest.json")

    def test_inventory_matches_task(self):
        task = json.loads((ROOT / "task.json").read_text())
        self.assertEqual(task["workspacePromptFile"], "BUILD_SPEC.md")
        self.assertEqual(task["expectedTotalChecks"], task["expectedApiGroups"] + task["expectedBrowserChecks"] + task["expectedPrerequisiteChecks"])
        self.assertEqual(task["generatedDirectories"], ["dist"])
        self.assertNotIn("gold", task["seedDirectory"])


if __name__ == "__main__":
    unittest.main()
