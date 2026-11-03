"""Pure continuation controls; no gateway, private inputs, native CLI or browser."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import codex_arm as continuation

TEAM = Path(__file__).resolve().parents[1] / "matched-agentic-study"
sys.path.insert(0, str(TEAM))
import heavy_runner
from native_team_policy import PolicyError
from owned_team_witness import healthy, OwnedSupervisor
import paired_runner
from test_heavy_runner import HeavyAdapter, HeavyMeter
from test_heavy_funding_profile import state as funding_state


def baseline():
    value = funding_state()
    value.update(attempts=1189, measuredUsd=27.0914679, batchCallsRemaining=0)
    value["actors"]["foundry-vector"]["measuredUsd"] = 17.6761006
    return value


def original_fixture():
    """Labelled synthetic metadata, never the private original plan/artifact."""
    plan = {"sourceRevision": continuation.SOURCE, "sourceDirty": False, "order": ["vector", "codex"],
            "maxCalls": 300, "maxSeconds": 7200, "softUsd": 13.84808545,
            "profileSha256": "synthetic-profile", "fundingPhase": heavy_runner.FUNDING.phase,
            "fundingAuthorizationPlanSha256": heavy_runner.FUNDING.plan_sha256,
            "label": "synthetic-continuation", "task": {}}
    closure = {"settlementComplete": True, "usageAccountingStatus": "settled_and_receipts_reconciled",
               "runtimeQuiesced": True, "providerRequests": 300,
               "transcripts": {"complete": True, "sessionCount": 7}}
    vector = {"runtime": "vector", "providerRequests": 300, "measuredUsd": 6.7876388,
              "functionalVerdict": "product_failure", "nativeAuditVerdict": "review_required",
              "reviewRequired": True, "settlementComplete": True,
              "stopReason": "admission_policy_or_state_failure", "closure": copy.deepcopy(closure),
              "attempts": [{"index": index, "artifact": {"fileCount": 39,
                  "manifestSha256": continuation.SNAPSHOT_SHA, "protectedViolations": []},
                  "process": {"ownedTreeQuiesced": True}} for index in (1, 2)]}
    summary = {"kind": "heavy-native-team-pair-result-v1", "planSha256": continuation.ORIGINAL_PLAN_SHA,
        "sourceRevision": plan["sourceRevision"], "profileSha256": plan["profileSha256"],
        "fundingPhase": plan["fundingPhase"], "fundingAuthorizationPlanSha256": plan["fundingAuthorizationPlanSha256"],
        "pairCompleted": False, "productGateMet": False, "qualityComparisonMet": False,
        "efficiencyClaimMet": False, "allChargesRetained": True, "historicalAmountsReset": False,
        "arms": {"vector": vector, "codex": {"runtime": "codex", "notRun": True,
            "stopReason": "not_run_after_prior_arm_review", "functionalVerdict": "not_run", "nativeAuditVerdict": "not_run"}}}
    return plan, summary, closure


class ContinuationMeter(HeavyMeter):
    """Synthetic in-memory ledger exercising the real supervisor/coordinate code."""
    def __init__(self):
        super().__init__()
        self.spent["foundry-vector"] = 17.6761006

    def __call__(self, route, body=None):
        value = super().__call__(route, body)
        if route != "/control":
            value.update(attempts=1189 + self.calls,
                         measuredUsd=27.0914679 + sum(row["measuredUsd"] for row in self.receipts))
        return value

    def forward(self, wire):
        super().forward(wire)
        self.receipts[-1]["seq"] = 1189 + self.calls


class ContinuationTests(unittest.TestCase):
    def test_exact_original_stopped_outcome_is_accepted_without_waiving_flags(self):
        plan, summary, closure = original_fixture()
        continuation.validate_original(plan, summary, closure)
        self.assertTrue(summary["arms"]["vector"]["reviewRequired"])
        self.assertFalse(summary["pairCompleted"])

    def test_changed_bounds_or_source_are_rejected(self):
        for field, changed in (("sourceRevision", "other"), ("sourceDirty", True), ("maxCalls", 301),
                               ("maxSeconds", 7201), ("softUsd", 20), ("order", ["codex", "vector"])):
            plan, summary, closure = original_fixture()
            plan[field] = changed
            with self.subTest(field=field), self.assertRaises(continuation.ContinuationError):
                continuation.validate_original(plan, summary, closure)

    def test_already_attempted_codex_and_relabelled_pair_are_rejected(self):
        for field in ("attempted", "pairCompleted", "productGateMet", "efficiencyClaimMet", "qualityComparisonMet"):
            plan, summary, closure = original_fixture()
            if field == "attempted":
                summary["arms"]["codex"]["providerRequests"] = 1
            else:
                summary[field] = True
            with self.subTest(field=field), self.assertRaises(continuation.ContinuationError):
                continuation.validate_original(plan, summary, closure)

    def test_unknown_vector_closure_or_changed_snapshot_is_rejected(self):
        for field in ("runtimeQuiesced", "settlementComplete", "transcripts", "usageAccountingStatus", "snapshot"):
            plan, summary, closure = original_fixture()
            if field == "snapshot":
                summary["arms"]["vector"]["attempts"][1]["artifact"]["manifestSha256"] = "other"
            else:
                closure[field] = False
                summary["arms"]["vector"]["closure"] = closure
            with self.subTest(field=field), self.assertRaises(continuation.ContinuationError):
                continuation.validate_original(plan, summary, closure)

    def test_exact_idle_funding_and_floating_point_roundoff_pass(self):
        value = baseline()
        value["measuredUsd"] -= 0.00000000000001
        self.assertIs(continuation.validate_baseline(value, healthy, heavy_runner.FUNDING.phase), value)

    def test_any_new_call_or_billed_codex_usage_is_rejected(self):
        for field in ("attempts", "measuredUsd", "foundry-codex", "foundry-vector"):
            value = baseline()
            if field in value:
                value[field] += 1 if field == "attempts" else .000001
            else:
                value["actors"][field]["measuredUsd"] += .000001
                value["measuredUsd"] += .000001
            with self.subTest(field=field), self.assertRaises((PolicyError, continuation.ContinuationError)):
                continuation.validate_baseline(value, healthy, heavy_runner.FUNDING.phase)

    def test_halt_open_scope_reservation_and_unknown_phase_fail_closed(self):
        for field, changed in (("halted", "stop"), ("batchCallsRemaining", 1), ("active", 1),
                               ("reservedUsd", .1), ("phaseID", "other")):
            value = baseline(); value[field] = changed
            with self.subTest(field=field), self.assertRaises((PolicyError, continuation.ContinuationError)):
                continuation.validate_baseline(value, healthy, heavy_runner.FUNDING.phase)

    def test_actor_reclassification_with_same_global_total_is_rejected(self):
        value = baseline()
        value["actors"]["foundry-vector"]["measuredUsd"] -= .000001
        value["actors"]["foundry-codex"]["measuredUsd"] += .000001
        with self.assertRaisesRegex(continuation.ContinuationError, "actor history changed"):
            continuation.validate_baseline(value, healthy, heavy_runner.FUNDING.phase)

    def test_controller_allows_only_one_original_codex_admission(self):
        meter = ContinuationMeter()
        controller = continuation.CodexOnlyController(meter, healthy, heavy_runner.FUNDING.phase, "synthetic-continuation-codex")
        for actor, count, label in (("foundry-vector", 300, controller.label),
                                    ("foundry-codex", 301, controller.label), ("foundry-codex", 300, "other")):
            with self.assertRaises(continuation.ContinuationError):
                controller("/control", {"actor": actor, "calls": count, "label": label})
        body = {"actor": "foundry-codex", "calls": 300, "label": controller.label}
        controller("/control", body)
        with self.assertRaises(continuation.ContinuationError):
            controller("/control", body)
        self.assertEqual([body["actor"] for route, body in meter.controls if route == "/control"], ["foundry-codex"])

    def test_ambiguous_admission_cannot_be_retried(self):
        calls = []
        def broken(route, body=None):
            calls.append(route)
            if route == "/status":
                return baseline()
            raise OSError("synthetic ambiguous mutation")
        controller = continuation.CodexOnlyController(broken, healthy, heavy_runner.FUNDING.phase, "synthetic-codex")
        body = {"actor": "foundry-codex", "calls": 300, "label": controller.label}
        with self.assertRaises(OSError): controller("/control", body)
        with self.assertRaises(continuation.ContinuationError): controller("/control", body)
        self.assertEqual(calls.count("/control"), 1)

    def test_funding_drift_after_preflight_blocks_the_actual_admission(self):
        meter = ContinuationMeter()
        controller = continuation.CodexOnlyController(meter, healthy, heavy_runner.FUNDING.phase, "synthetic-codex")
        controller("/status")
        meter.calls = 1
        with self.assertRaisesRegex(continuation.ContinuationError, "funding changed"):
            controller("/control", {"actor": "foundry-codex", "calls": 300, "label": controller.label})
        self.assertFalse(controller.admission_attempted)
        self.assertFalse(any(route == "/control" for route, _body in meter.controls))

    def test_new_plan_tampering_fails_before_import_or_private_capability(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "plan.json"; path.write_text("{}")
            with self.assertRaisesRegex(continuation.ContinuationError, "original pair plan"):
                continuation.original_inputs(SimpleNamespace(original_plan=path))

    def test_real_coordinate_dispatches_codex_only_and_preserves_vector_review(self):
        with tempfile.TemporaryDirectory() as root:
            plan, summary, closure = original_fixture()
            meter = ContinuationMeter()
            controller = continuation.CodexOnlyController(meter, healthy, heavy_runner.FUNDING.phase, "synthetic-continuation-codex")
            adapter = HeavyAdapter("codex", meter, verdicts=("product_failure", "passed"))
            supervisor = OwnedSupervisor(controller, lambda: meter.receipts, Path(root),
                quiesced=lambda: adapter.quiesced, funding_profile=heavy_runner.FUNDING.phase)
            supervisor.used.add("vector")
            saved = []
            result = continuation.run_codex({}, plan, summary, supervisor=supervisor, adapter=adapter,
                common=paired_runner.common_helpers(TEAM.parent / "agentic-study"), team=paired_runner,
                profile=heavy_runner.PROFILE, check_frozen=lambda: None, persist=lambda value: saved.append(copy.deepcopy(value)))
            self.assertEqual(result["arms"]["vector"], summary["arms"]["vector"])
            self.assertTrue(result["arms"]["vector"]["reviewRequired"])
            self.assertFalse(result["pairCompleted"])
            self.assertFalse(result["efficiencyClaimMet"])
            self.assertFalse(result["qualityComparisonMet"])
            self.assertFalse(result["vectorRerun"])
            self.assertEqual(result["arms"]["codex"]["providerRequests"], 14)
            self.assertEqual(result["arms"]["codex"]["functionalVerdict"], "passed")
            self.assertEqual(len(adapter.invocations), 2)
            self.assertEqual([body["actor"] for route, body in meter.controls if route == "/control"], ["foundry-codex"])
            self.assertEqual(adapter.arm.max_calls, 300)
            self.assertEqual(adapter.arm.soft_usd, 13.84808545)
            self.assertEqual(adapter.arm.profile.max_depth, 2)
            self.assertTrue(saved)

    def overlay_fixture(self, root):
        path = root / "overlay"; path.mkdir()
        (path / "instrument").mkdir()
        (path / "instrument/browser-eval.cjs").write_text("labelled synthetic browser helper v2")
        (path / "instrument/BUILD_SPEC.md").write_text("labelled synthetic unchanged prompt")
        (path / "task.json").write_text("{}")
        (path / "provenance.json").write_text('{"kind":"synthetic-original-provenance"}')
        base = continuation.manifest(path)
        base["instrument/browser-eval.cjs"] = "synthetic-old-hash"
        (path / "overlay-provenance.json").write_text(json.dumps({"kind": "foundry-navigation-overlay-v2",
            "baseTaskRevision": "8ce4af881b98aaef2d73979073910f5a538c4f31",
            "originalTaskManifestSha256": continuation.digest(base)}))
        for name in ("helper.diff", "project-navigation-control.cjs", "test_overlay.py", "OVERLAY.md", ".gitattributes"):
            (path / name).write_text("labelled synthetic overlay metadata")
        files = continuation.manifest(path)
        reviewed = root / "reviewed-overlay.json"; reviewed.write_text(json.dumps(files))
        return SimpleNamespace(evaluation_overlay=path, overlay_manifest=reviewed,
            expected_overlay_sha=continuation.digest(files)), {"taskFiles": base}

    def test_explicit_reviewed_overlay_preserves_prompt_and_contract(self):
        with tempfile.TemporaryDirectory() as root:
            options, original = self.overlay_fixture(Path(root))
            result = continuation.evaluation_overlay(options, original)
            self.assertEqual(result["changedFiles"], ["instrument/browser-eval.cjs"])
            self.assertTrue(result["promptSeedAndTaskContractUnchanged"])
            self.assertTrue(result["originalEvaluationRetained"])

    def test_overlay_is_optional_but_partial_inputs_are_forbidden(self):
        options = SimpleNamespace(evaluation_overlay=None, overlay_manifest=None, expected_overlay_sha=None)
        self.assertIsNone(continuation.evaluation_overlay(options, {}))
        options.evaluation_overlay = Path("missing")
        with self.assertRaisesRegex(continuation.ContinuationError, "explicit together"):
            continuation.evaluation_overlay(options, {})

    def test_overlay_file_change_after_review_fails(self):
        with tempfile.TemporaryDirectory() as root:
            options, original = self.overlay_fixture(Path(root))
            (options.evaluation_overlay / "instrument/browser-eval.cjs").write_text("later mutation")
            with self.assertRaisesRegex(continuation.ContinuationError, "overlay files changed"):
                continuation.evaluation_overlay(options, original)

    def test_even_reviewed_prompt_or_wrapper_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            options, original = self.overlay_fixture(Path(root))
            (options.evaluation_overlay / "instrument/BUILD_SPEC.md").write_text("changed task")
            files = continuation.manifest(options.evaluation_overlay)
            options.overlay_manifest.write_text(json.dumps(files)); options.expected_overlay_sha = continuation.digest(files)
            with self.assertRaisesRegex(continuation.ContinuationError, "prompt, seed, wrapper"):
                continuation.evaluation_overlay(options, original)

    def test_wrong_overlay_base_or_manifest_digest_fails(self):
        with tempfile.TemporaryDirectory() as root:
            options, original = self.overlay_fixture(Path(root))
            options.expected_overlay_sha = "0" * 64
            with self.assertRaisesRegex(continuation.ContinuationError, "manifest digest changed"):
                continuation.evaluation_overlay(options, original)
            files = continuation.manifest(options.evaluation_overlay)
            options.expected_overlay_sha = continuation.digest(files)
            original["taskFiles"]["task.json"] = "different-base"
            with self.assertRaises(continuation.ContinuationError):
                continuation.evaluation_overlay(options, original)


if __name__ == "__main__":
    unittest.main()
