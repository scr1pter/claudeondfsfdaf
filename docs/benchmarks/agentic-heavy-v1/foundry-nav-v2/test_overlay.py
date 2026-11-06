"""Pure source/freeze controls; no browser, app, Bun or provider calls."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest

from materialize import materialize

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / "foundry"


class OverlayTests(unittest.TestCase):
    def test_materialization_restores_only_hash_proven_newlines_and_refuses_other_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / "fixture.txt"
            file.write_bytes(b"one\r\ntwo\r\n")
            expected = hashlib.sha256(b"one\ntwo\n").hexdigest()
            record = {"copiedFiles": {"fixture.txt": {"overlaySha256": expected}}}
            (root / "overlay-provenance.json").write_text(json.dumps(record))
            self.assertEqual(materialize(root), ["fixture.txt"])
            self.assertEqual(file.read_bytes(), b"one\ntwo\n")
            self.assertEqual(materialize(root), [])
            file.write_bytes(b"different source\n")
            with self.assertRaises(ValueError):
                materialize(root)
            self.assertEqual(file.read_bytes(), b"different source\n")

    def test_materialization_refuses_paths_outside_the_overlay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "overlay-provenance.json").write_text(json.dumps({"copiedFiles": {"../outside.txt": {"overlaySha256": "0" * 64}}}))
            with self.assertRaises(ValueError):
                materialize(root)

    def test_exact_copy_changes_only_the_project_navigation_helper_file(self):
        record = json.loads((ROOT / "overlay-provenance.json").read_text())
        changed = []
        self.assertEqual(set(record["copiedFiles"]), set(record["originalTaskManifest"]))
        for name, item in record["copiedFiles"].items():
            # The recorded original is the actual paid-plan byte manifest. A
            # fresh Windows checkout can change historical text-file endings.
            self.assertEqual(record["originalTaskManifest"][name], item["originalSha256"], name)
            overlay_hash = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            self.assertEqual(overlay_hash, item["overlaySha256"], name)
            self.assertEqual(item["originalSha256"] == overlay_hash, item["byteIdentical"], name)
            if item["originalSha256"] != overlay_hash:
                changed.append(name)
        self.assertEqual(changed, ["instrument/browser-eval.cjs"])

    def test_all_40_browser_checks_remain_identical_and_in_order(self):
        checks = lambda path: re.findall(r'await check\("([^"\n]+)"', path.read_text())
        old, new = checks(BASE / "instrument/browser-eval.cjs"), checks(ROOT / "instrument/browser-eval.cjs")
        self.assertEqual(len(new), 40)
        self.assertEqual(len(set(new)), 40)
        self.assertEqual(old, new)
        self.assertEqual((ROOT / "instrument/evaluate.py").read_bytes(), (BASE / "instrument/evaluate.py").read_bytes())

    def test_prompt_seed_wrapper_and_command_contract_are_byte_identical(self):
        for name in ("task.json", "evaluate.py", "owned_process.py", "instrument/BUILD_SPEC.md",
                     "instrument/seed/.gitignore", "instrument/seed/bun.lock", "instrument/seed/package.json", "instrument/seed/tsconfig.json"):
            self.assertEqual((ROOT / name).read_bytes(), (BASE / name).read_bytes(), name)

    def test_recorded_helper_diff_matches_the_only_permitted_source_change(self):
        record = json.loads((ROOT / "overlay-provenance.json").read_text())
        self.assertEqual(record["changedFiles"], ["instrument/browser-eval.cjs"])
        self.assertEqual(hashlib.sha256((ROOT / record["helperDiffFile"]).read_bytes()).hexdigest(), record["helperDiffSha256"])
        source = (ROOT / "instrument/browser-eval.cjs").read_text()
        self.assertIn('const back = namedAction(target, "All projects")', source)
        self.assertIn('await opener.click({ timeout: budget() })', source)
        self.assertIn('name: "New task", exact: true', source)
        self.assertFalse(record["seedPromptContractChanged"])
        self.assertFalse(record["priorOriginalFailuresRewritten"])


if __name__ == "__main__":
    unittest.main()
