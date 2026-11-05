"""Pure controls only: no Bun, app, browser, network, provider or credential use."""
import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest

import evaluate


class InventoryControls(unittest.TestCase):
    def test_fixed_inventory_and_actual_group_implementations(self):
        self.assertEqual(len(evaluate.API_GROUPS), 28)
        self.assertEqual(len(set(evaluate.API_GROUPS)), 28)
        self.assertEqual(len(evaluate.BROWSER_CHECKS), 32)
        self.assertEqual(len(set(evaluate.BROWSER_CHECKS)), 32)
        self.assertEqual(len(evaluate.new_report()["checks"]), 64)
        self.assertTrue(all(callable(getattr(evaluate.Suite, name, None)) for name in evaluate.API_GROUPS))
        source = (evaluate.ROOT / "browser-eval.cjs").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r'await check\("([^"\n]+)"', source), list(evaluate.BROWSER_CHECKS))

    def test_empty_seed_has_no_implementation(self):
        seed = evaluate.ROOT / "seed"
        names = {p.relative_to(seed).as_posix() for p in seed.rglob("*") if p.is_file()}
        self.assertEqual(names, {"package.json", "tsconfig.json", "bun.lock", ".gitignore", "UI_CONTRACT.md"})
        self.assertEqual((seed / "UI_CONTRACT.md").read_bytes(), (evaluate.ROOT / "UI_CONTRACT.md").read_bytes())
        package = json.loads((seed / "package.json").read_text())
        self.assertEqual(package["scripts"]["start"], "bun server/index.ts")
        self.assertFalse((seed / "server/index.ts").exists())
        self.assertFalse((seed / "src").exists())
        self.assertFalse((seed / "index.html").exists())


class GateControls(unittest.TestCase):
    def complete(self):
        report = evaluate.new_report()
        for row in report["checks"]:
            row["status"] = "passed"
        report["sourceIntegrityStatus"] = "unchanged"
        return report

    def test_labelled_synthetic_complete_report(self):
        report = evaluate.finalize(self.complete())
        self.assertEqual(report["verdict"], "passed")
        self.assertEqual(report["summary"]["api"]["passed"], 28)
        self.assertEqual(report["summary"]["browser"]["passed"], 32)
        # This checks gate arithmetic, not an application's correctness.

    def test_every_required_row_is_required(self):
        for index in range(64):
            for status in ("failed", "not_run"):
                report = self.complete()
                report["checks"][index]["status"] = status
                self.assertNotEqual(evaluate.finalize(report)["verdict"], "passed", (index, status))

    def test_inventory_mutations_fail_closed(self):
        modifications = [lambda rows: rows.pop(), lambda rows: rows.append(copy.deepcopy(rows[0])),
                         lambda rows: rows[0].update(name="prerequisite:made-up"),
                         lambda rows: rows[0].update(category="api"), lambda rows: rows[0].update(status="skipped"),
                         lambda rows: rows[0].update(status=True), lambda rows: rows.__setitem__(0, None),
                         lambda rows: rows.__setitem__(0, copy.deepcopy(rows[1]))]
        for modification in modifications:
            report = self.complete(); modification(report["checks"])
            self.assertEqual(evaluate.finalize(report)["verdict"], "instrument_failure")

    def test_source_unknown_modified_and_contradiction_fail(self):
        for integrity in ("not_assessed", "modified", "unexpected"):
            report = self.complete(); report["sourceIntegrityStatus"] = integrity
            self.assertEqual(evaluate.finalize(report)["verdict"], "instrument_failure")
        report = self.complete(); report["instrumentError"] = "browser crashed"
        self.assertEqual(evaluate.finalize(report)["verdict"], "instrument_failure")

    def test_failed_prerequisites_leave_no_application_passes(self):
        report = evaluate.new_report(); report["sourceIntegrityStatus"] = "unchanged"
        for row in report["checks"]:
            if row["category"] == "prerequisite":
                row["status"] = "passed" if row["name"].endswith(":source_integrity") else "failed"
        report = evaluate.finalize(report)
        self.assertEqual(report["verdict"], "product_failure")
        self.assertEqual(report["summary"]["api"], {"failed": 0, "not_run": 28, "passed": 0})
        self.assertEqual(report["summary"]["browser"], {"failed": 0, "not_run": 32, "passed": 0})


class BrowserEvidenceControls(unittest.TestCase):
    def browser(self):
        return {"kind": "harbor-browser-v1", "checks": [{"name": name, "status": "passed"} for name in evaluate.BROWSER_CHECKS],
                "summary": {"failed": 0, "not_run": 0, "passed": 32}}

    def test_labelled_complete_synthetic_browser(self):
        self.assertEqual(len(evaluate.validate_browser(self.browser(), {"exitCode": 0, "timedOut": False})), 32)

    def test_bad_summary_missing_duplicate_extra_status_exit_timeout_rejected(self):
        modifications = [lambda raw: raw["summary"].update(passed=31), lambda raw: raw["checks"].pop(),
                         lambda raw: raw["checks"].append(copy.deepcopy(raw["checks"][0])),
                         lambda raw: raw["checks"][0].update(name=raw["checks"][1]["name"]),
                         lambda raw: raw["checks"][0].update(status="skipped"), lambda raw: raw.update(kind="other")]
        for modification in modifications:
            raw = self.browser(); modification(raw)
            with self.assertRaises(AssertionError):
                evaluate.validate_browser(raw, {"exitCode": 0, "timedOut": False})
        for process in ({"exitCode": 1, "timedOut": False}, {"exitCode": 2, "timedOut": False}, {"exitCode": 0, "timedOut": True}):
            with self.assertRaises(AssertionError):
                evaluate.validate_browser(self.browser(), process)

    def test_incomplete_browser_is_product_failure_only_with_consistent_evidence(self):
        raw = self.browser(); raw["checks"][0]["status"] = "failed"
        raw["summary"] = {"failed": 1, "not_run": 0, "passed": 31}
        self.assertEqual(evaluate.validate_browser(raw, {"exitCode": 1, "timedOut": False})[0]["status"], "failed")


class SourceControls(unittest.TestCase):
    def declaration(self, app):
        return {"root": str(app), "output": str(app / "dist"), "public": str(app / "public"), "inputs": [str(app / "index.html")]}

    def test_reserved_dist_layout_accepts_only_canonical_separate_output(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory).resolve()
            declaration = self.declaration(app)
            self.assertEqual(evaluate.validate_layout(app, declaration), declaration)
            mutations = [lambda raw: raw.update(root=str(app / "dist")), lambda raw: raw.update(output=str(app)),
                         lambda raw: raw.update(public=str(app / "dist")), lambda raw: raw.update(inputs=[str(app / "dist/input.html")]),
                         lambda raw: raw.update(inputs=[str(app.parent / "outside.html")]), lambda raw: raw.update(inputs=[]),
                         lambda raw: raw.update(inputs=[str(app)]), lambda raw: raw.update(output=str(app.parent / "dist")),
                         lambda raw: raw.update(unrecognized=True)]
            for mutation in mutations:
                raw = self.declaration(app); mutation(raw)
                with self.assertRaises(AssertionError):
                    evaluate.validate_layout(app, raw)

    def test_output_symlink_is_rejected_but_dependency_symlink_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); app = root / "app"; app.mkdir(); elsewhere = root / "elsewhere"; elsewhere.mkdir()
            try:
                (app / "dist").symlink_to(elsewhere, target_is_directory=True)
                (app / "node_modules").symlink_to(elsewhere, target_is_directory=True)
            except OSError as error:
                self.skipTest("platform cannot create test directory symlinks: " + str(error))
            with self.assertRaises(AssertionError):
                evaluate.validate_layout(app, self.declaration(app))
            self.assertEqual(evaluate.source_manifest(app), {})

    def test_authored_changes_are_detected_and_only_declared_outputs_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory).resolve()
            (app / "src").mkdir(); (app / "src/main.ts").write_text("source")
            (app / "dist").mkdir(); (app / "node_modules").mkdir(); (app / ".git").mkdir()
            original = evaluate.source_manifest(app)
            self.assertEqual(original, {"src/main.ts": hashlib.sha256(b"source").hexdigest()})
            (app / "dist/built.js").write_text("generated"); (app / "node_modules/tool.js").write_text("dependency")
            self.assertEqual(evaluate.source_manifest(app), original)
            (app / "src/generated-looking.js").write_text("authored")
            self.assertNotEqual(evaluate.source_manifest(app), original)
            (app / "src/main.ts").write_text("changed")
            self.assertNotEqual(evaluate.source_manifest(app)["src/main.ts"], original["src/main.ts"])


if __name__ == "__main__":
    unittest.main()
