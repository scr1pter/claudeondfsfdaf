"""Free contract/normalization controls. No app, Bun, browser or model runs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("heavy_foundry_evaluation", ROOT / "evaluate.py")
evaluate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(evaluate)


def completed_report():
    api, browser = evaluate.inventory()
    checks = [{"name": name, "status": "passed"} for name in api]
    next(item for item in checks if item["name"] == "sessions_password_storage")["facts"] = {"postStopPasswordVerification": True}
    return {"kind": "foundry-independent-evaluation", "modelCalls": 0,
            "build": {name: {"exitCode": 0, "timedOut": False} for name in ("typecheck", "build")},
            "startup": {"status": "passed"}, "sourceIntegrityStatus": "unchanged", "applicationSourceUnchanged": True,
            "api": checks, "apiPassed": 32, "apiTotal": 32,
            "browser": {"process": {"exitCode": 0, "timedOut": False}, "results": {
                "checks": [{"name": name, "status": "passed"} for name in browser],
                "summary": {"passed": 40, "failed": 0, "notRun": 0}}},
            "functionalGatePassed": True, "browserGatePassed": True, "fullGatePassed": True}


class AdapterTests(unittest.TestCase):
    def test_all_original_instrument_files_remain_byte_identical(self):
        provenance = json.loads((ROOT / "provenance.json").read_text())
        self.assertEqual(len(provenance["copiedFiles"]), 18)
        for name, expected in provenance["copiedFiles"].items():
            self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), expected, name)
        dependency = provenance["adapterOwnedProcessDependency"]
        self.assertEqual(hashlib.sha256((ROOT / dependency["copy"]).read_bytes()).hexdigest(), dependency["sha256"])

    def test_real_scaffold_is_original_five_files_with_no_implementation(self):
        task = json.loads((ROOT / "task.json").read_text())
        seed = ROOT / task["seedDirectory"]
        self.assertEqual({file.name for file in seed.iterdir()}, {".gitignore", "bun.lock", "package.json", "tsconfig.json"})
        self.assertEqual(task["workspacePromptFile"], "BUILD_SPEC.md")
        self.assertEqual(hashlib.sha256((ROOT / task["promptFile"]).read_bytes()).hexdigest(), "62c42361ffec2b6cf91ef3ef5fb49706503aa05ff420ecf315e270904467c35a")
        self.assertEqual(task["expectedTotalChecks"], 32 + 40 + 4)

    def test_complete_original_report_formats_all_72_original_and_four_prerequisites(self):
        original = completed_report()
        before = copy.deepcopy(original)
        result = evaluate.normalize(original, {"exitCode": 0, "timedOut": False})
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(len(result["checks"]), 76)
        self.assertEqual(len({row["name"] for row in result["checks"]}), 76)
        self.assertEqual(sum(row["category"] == "api" for row in result["checks"]), 32)
        self.assertEqual(sum(row["category"] == "browser" for row in result["checks"]), 40)
        self.assertEqual(sum(row["category"] == "prerequisite" for row in result["checks"]), 4)
        self.assertEqual(result["sourceUnchanged"], True)
        self.assertEqual(original, before)

    def test_failed_api_check_and_charge_independent_product_failure_are_retained(self):
        original = completed_report()
        row = next(item for item in original["api"] if item["name"] == "tenant_boundary")
        row.update(status="failed", reason="foreign tenant access was accepted")
        original.update(apiPassed=31, functionalGatePassed=False, fullGatePassed=False)
        result = evaluate.normalize(original, {"exitCode": 1, "timedOut": False})
        self.assertEqual(result["verdict"], "product_failure")
        self.assertEqual(result["apiPassed"], 31)
        failed = next(row for row in result["checks"] if row["name"] == "api:tenant_boundary")
        self.assertEqual(failed["status"], "failed")
        self.assertIn("foreign tenant", failed["error"])

    def test_browser_failed_and_not_run_checks_never_become_passed(self):
        original = completed_report()
        original["browser"]["results"]["checks"][0].update(status="failed", reason="signup failed")
        original["browser"]["results"]["checks"][1].update(status="not_run", reason="prerequisite failed")
        original["browser"]["results"]["summary"] = {"passed": 38, "failed": 1, "notRun": 1}
        original["browser"]["process"]["exitCode"] = 1
        original.update(browserGatePassed=False, fullGatePassed=False)
        result = evaluate.normalize(original, {"exitCode": 1, "timedOut": False})
        self.assertEqual(result["verdict"], "product_failure")
        self.assertEqual(result["browserPassed"], 38)
        self.assertEqual(sum(row["category"] == "browser" and row["status"] == "not_run" for row in result["checks"]), 1)

    def test_missing_application_preserves_72_not_run_checks_and_explicit_failed_prerequisites(self):
        original = completed_report()
        original["build"]["typecheck"]["exitCode"] = 1
        original["build"]["build"]["exitCode"] = 1
        original.pop("startup")
        for row in original["api"]:
            row["status"] = "not_run"
        original.update(apiPassed=0, functionalGatePassed=False, browserGatePassed=False, fullGatePassed=False)
        original["browser"] = {"status": "not_run"}
        result = evaluate.normalize(original, {"exitCode": 1, "timedOut": False})
        self.assertEqual(result["verdict"], "product_failure")
        self.assertEqual(sum(row["category"] in ("api", "browser") and row["status"] == "not_run" for row in result["checks"]), 72)
        self.assertEqual(sum(row["category"] == "prerequisite" and row["status"] == "failed" for row in result["checks"]), 3)

    def test_missing_duplicate_or_extra_original_inventory_requires_review(self):
        for mutate in (lambda raw: raw["api"].pop(),
                       lambda raw: raw["api"].__setitem__(0, copy.deepcopy(raw["api"][1])),
                       lambda raw: raw["browser"]["results"]["checks"].pop(),
                       lambda raw: raw["browser"]["results"]["checks"].append({"name": "unfrozen-check", "status": "passed"})):
            original = completed_report()
            mutate(original)
            self.assertEqual(evaluate.normalize(original, {"exitCode": 0, "timedOut": False})["verdict"], "instrument_failure")

    def test_forged_gate_count_or_exit_and_missing_crypto_evidence_never_pass(self):
        for mutate, code in ((lambda raw: raw.update(fullGatePassed=False), 0),
                             (lambda raw: raw.update(apiPassed=31), 0),
                             (lambda raw: raw["browser"]["results"]["summary"].update(passed=39), 0),
                             (lambda raw: raw["api"][1].update(facts={}), 0),
                             (lambda raw: None, 1)):
            original = completed_report()
            mutate(original)
            self.assertEqual(evaluate.normalize(original, {"exitCode": code, "timedOut": False})["verdict"], "instrument_failure")

    def test_unknown_or_changed_source_remains_manual_review(self):
        for status, unchanged in (("not_assessed", None), ("modified", False)):
            original = completed_report()
            original.update(sourceIntegrityStatus=status, applicationSourceUnchanged=unchanged, fullGatePassed=False)
            result = evaluate.normalize(original, {"exitCode": 1, "timedOut": False})
            self.assertEqual(result["verdict"], "instrument_failure")
            self.assertFalse(result["sourceUnchanged"])

    def test_unknown_original_process_or_browser_termination_cannot_pass(self):
        for process in ({"exitCode": 2, "timedOut": False}, {"exitCode": 0, "timedOut": True}):
            self.assertEqual(evaluate.normalize(completed_report(), process)["verdict"], "instrument_failure")
        original = completed_report()
        original["browser"]["process"].update(timedOut=True)
        self.assertEqual(evaluate.normalize(original, {"exitCode": 0, "timedOut": False})["verdict"], "instrument_failure")


if __name__ == "__main__":
    unittest.main()
