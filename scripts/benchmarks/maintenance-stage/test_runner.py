"""Pure prospective controls; no process, listener, provider, key or Bun."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import runner
import adapter_smoke


def qualified():
    root = Path(__file__).resolve().parent.parent / "maintenance-holdout"
    inventory = json.loads((root / "CHECK-INVENTORY.json").read_bytes())
    def normalized(passes):
        rows = [{"name": name, "category": "api", "status": "passed" if index < passes else "failed"}
                for index, name in enumerate(inventory["business"])]
        rows += [{"name": name, "category": "prerequisite", "status": "passed"} for name in inventory["prerequisite"]]
        return {"verdict": "passed" if passes == 50 else "product_failure", "sourceIntegrityStatus": "unchanged", "checks": rows,
            "summary": {category: {status: sum(row["category"] == category and row["status"] == status for row in rows)
                for status in ("passed", "failed", "not_run")} for category in ("api", "browser", "prerequisite")}}
    controls = []
    for name in inventory["negativeControls"]:
        target = runner.NEGATIVE_TARGETS[name]
        rows = [{"name": key, "scope": "business", "passed": key != target} for key in inventory["business"]]
        rows += [{"name": key, "scope": "prerequisite", "passed": True} for key in inventory["prerequisite"]]
        raw = {"kind": "ledgerdesk-maintenance-gate-v1", "mode": "bun-qualification", "passed": False,
            "checks": rows, "checksTotal": 54, "checksPassed": 53, "businessTotal": 50, "businessPassed": 49,
            "prerequisitesTotal": 4, "prerequisitesPassed": 4, "sourceUnchanged": True}
        controls.append({"name": name, "target": target, "rejected": True, "prerequisitesPassed": 4,
                         "allIndependentRowsRetained": True, "report": raw})
    return {"kind": "maintenance-runtime-qualification-v1", "status": "runtime_qualified", "runtimeQualified": True,
        "modelCalls": 0, "expectedChecks": runner.COUNTS, "positiveReference": normalized(50), "workingSeed": normalized(12),
        "actualSeedBusinessPasses": 12, "seedZeroRequired": False, "damagedReferenceControls": controls,
        "originalRequirementsUnchanged": True, "privateReferenceOutsideTaskRoot": True}


class ProspectiveControls(unittest.TestCase):
    def test_unfrozen_candidate_refuses_before_any_instrument_or_controller_import(self):
        with patch.object(runner, "CANDIDATE", "UNFROZEN"), patch.object(runner, "bootstrap") as bootstrap, self.assertRaisesRegex(ValueError, "UNFROZEN"):
            runner.build_plan(SimpleNamespace(startup_affordability_mode="per-request"))
        bootstrap.assert_not_called()

    def test_startup_mode_must_be_explicit_per_request(self):
        options = SimpleNamespace(startup_affordability_mode="maximum-request")
        with self.assertRaisesRegex(ValueError, "per-request"):
            runner.build_plan(options)
        parser = runner.parser()
        action = next(action for action in parser._actions if action.dest == "startup_affordability_mode")
        self.assertTrue(action.required)
        self.assertEqual(tuple(action.choices), ("per-request",))

    def test_complete_fifty_four_with_actual_working_seed_and_all_mutant_rows_passes(self):
        proof = qualified()
        before = copy.deepcopy(proof)
        runner.validate_qualification(proof)
        self.assertEqual(proof, before)

    def test_seed_cannot_be_faked_zero_or_lose_any_prerequisite(self):
        for mode in ("zero", "wrong-count", "missing-prerequisite", "zero-required"):
            proof = qualified()
            if mode == "zero":
                for row in proof["workingSeed"]["checks"]:
                    if row["category"] == "api":
                        row["status"] = "failed"
                proof["workingSeed"]["summary"]["api"].update(passed=0, failed=50)
                proof["actualSeedBusinessPasses"] = 0
            elif mode == "wrong-count":
                proof["actualSeedBusinessPasses"] = 13
            elif mode == "zero-required":
                proof["seedZeroRequired"] = True
            else:
                proof["workingSeed"]["checks"][-1]["status"] = "failed"
                proof["workingSeed"]["summary"]["prerequisite"].update(passed=3, failed=1)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                runner.validate_qualification(proof)

    def test_mutants_require_complete_consistent_rows_and_specific_business_failure(self):
        changes = [lambda p: p["damagedReferenceControls"].pop(),
            lambda p: p["damagedReferenceControls"][0].update(rejected=False),
            lambda p: p["damagedReferenceControls"][0].update(target="different-business-failure"),
            lambda p: p["damagedReferenceControls"][0].update(prerequisitesPassed=3),
            lambda p: p["damagedReferenceControls"][0].update(allIndependentRowsRetained=False),
            lambda p: p["damagedReferenceControls"][0]["report"].update(sourceUnchanged=False),
            lambda p: p["damagedReferenceControls"][0]["report"].update(checksPassed=54),
            lambda p: p["damagedReferenceControls"][0]["report"]["checks"].pop(),
            lambda p: next(row for row in p["damagedReferenceControls"][0]["report"]["checks"]
                           if row["name"] == p["damagedReferenceControls"][0]["target"]).update(passed=True),
            lambda p: p["damagedReferenceControls"][0]["report"]["checks"][-1].update(passed=False),
            lambda p: p["damagedReferenceControls"][0]["report"]["checks"][1].update(name="unknown"),
            lambda p: p["damagedReferenceControls"][0]["report"]["checks"][1].update(passed="true")]
        for change in changes:
            proof = qualified()
            change(proof)
            with self.subTest(change=change), self.assertRaises(ValueError):
                runner.validate_qualification(proof)

    def test_positive_missing_gate_or_model_calls_are_not_qualification(self):
        for change in (lambda p: p.update(modelCalls=1), lambda p: p.update(modelCalls=False),
                lambda p: p["positiveReference"]["checks"].pop(), lambda p: p.update(runtimeQualified=False)):
            proof = qualified()
            change(proof)
            with self.assertRaises(ValueError):
                runner.validate_qualification(proof)

    def test_failure_probe_is_once_per_native_lead_and_does_not_replace_later_tools(self):
        class Base:
            def __init__(self, output):
                self.output = output
            def next_calls(self, adapter, native, tools):
                return ["unchanged-native-script"]
        smoke = SimpleNamespace(execution_call=lambda runtime, tools, command: {"runtime": runtime, "command": command})
        meter = adapter_smoke.FailureProbeMeter(Base, smoke, "synthetic-no-listener")
        for runtime in ("codex", "vector"):
            adapter = SimpleNamespace(runtime=runtime, smoke_invocation=1)
            native = {"id": runtime + "-synthetic-root", "role": "lead"}
            call = meter.next_calls(adapter, native, [])[0]
            self.assertEqual(call["runtime"], runtime)
            self.assertIn("exit 7", call["command"])
            self.assertEqual(meter.next_calls(adapter, native, []), ["unchanged-native-script"])
            adapter.smoke_invocation = 2
            self.assertEqual(meter.next_calls(adapter, native, []), ["unchanged-native-script"])
        worker = {"id": "synthetic-child", "role": "qa_specialist"}
        self.assertEqual(meter.next_calls(SimpleNamespace(runtime="vector", smoke_invocation=1), worker, []), ["unchanged-native-script"])

    def test_deliberate_failure_requires_actual_ordered_integer_seven_record(self):
        valid = {"command": "Write-Output 'intentional-known-nonzero-fixture'; exit 7", "status": "failed",
                 "exitCode": 7, "started": 1, "ended": 2}
        self.assertTrue(adapter_smoke.intentional_failure_observed([valid]))
        for update in ({"exitCode": 0}, {"exitCode": True}, {"exitCode": 1}, {"status": "running"},
                       {"started": None}, {"ended": None}, {"ended": 0}, {"command": "different failure; exit 7"}):
            with self.subTest(update=update):
                self.assertFalse(adapter_smoke.intentional_failure_observed([{**valid, **update}]))


if __name__ == "__main__":
    unittest.main()
