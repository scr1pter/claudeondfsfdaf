"""Free transport and manual missing-arm controls; no CLI, provider or gateway."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

import runner
import test_runner
from test_runner import FakeController, status


class Response:
    def __init__(self, data=b'{"ok":true}', code=200):
        self.data = data
        self.status = code

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, _bound):
        return self.data


class StatusTransportTests(unittest.TestCase):
    def test_status_retries_one_transport_failure_then_succeeds_with_fixed_timeouts(self):
        for error in (TimeoutError("synthetic-secret"), OSError("synthetic-secret"), urllib.error.URLError("synthetic-secret")):
            controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller-secret")
            with self.subTest(error=type(error).__name__), patch.object(controller.opener, "open", side_effect=[error, Response()]) as opened:
                self.assertEqual(controller("/status"), {"ok": True})
                self.assertEqual(opened.call_count, 2)
                self.assertTrue(all(call.kwargs == {"timeout": 10} for call in opened.call_args_list))
                self.assertTrue(all(call.args[0].get_method() == "GET" for call in opened.call_args_list))

    def test_repeated_status_transport_failure_stops_after_two_attempts_without_error_payload(self):
        controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller-secret")
        with patch.object(controller.opener, "open", side_effect=TimeoutError("synthetic-secret")) as opened:
            with self.assertRaises(runner.StudyError) as failure:
                controller("/status")
        self.assertEqual(opened.call_count, 2)
        self.assertIn("/status", str(failure.exception))
        self.assertNotIn("synthetic-secret", str(failure.exception))
        self.assertNotIn(controller.token, str(failure.exception))

    def test_mutations_and_non_status_routes_never_retry_transport_errors(self):
        for route, body in (("/control", {"calls": 1}), ("/disarm", {"requestToken": "local-run-synthetic"}), ("/status", {})):
            controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller")
            with self.subTest(route=route, body=body), patch.object(controller.opener, "open", side_effect=TimeoutError()) as opened:
                with self.assertRaises(runner.StudyError):
                    controller(route, body)
                self.assertEqual(opened.call_count, 1)

    def test_http_error_non200_malformed_and_oversized_responses_never_retry(self):
        cases = [urllib.error.HTTPError("http://127.0.0.1:23130/status", 503, "synthetic-secret", {}, None),
                 Response(code=503), Response(b"{"), Response(b"x" * 1_048_577)]
        for response in cases:
            controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller")
            outcome = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
            with self.subTest(response=type(response).__name__), patch.object(controller.opener, "open", **outcome) as opened:
                with self.assertRaises(runner.StudyError):
                    controller("/status")
                self.assertEqual(opened.call_count, 1)

    def test_valid_json_with_invalid_policy_is_not_retried(self):
        controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller")
        invalid = {**status(), "limitUsd": 49}
        with patch.object(controller.opener, "open", return_value=Response(json.dumps(invalid).encode())) as opened:
            with self.assertRaises(runner.StudyError):
                runner.healthy(controller("/status"))
            self.assertEqual(opened.call_count, 1)

    def test_status_read_timeout_can_retry_but_a_second_malformed_body_cannot(self):
        failed = Response()
        with patch.object(failed, "read", side_effect=TimeoutError()):
            controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller")
            with patch.object(controller.opener, "open", side_effect=[failed, Response(b"{")]) as opened:
                with self.assertRaises(runner.StudyError):
                    controller("/status")
                self.assertEqual(opened.call_count, 2)


class ManualContinuationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "source").mkdir()
        self.task_dir = self.root / "task"
        self.task_dir.mkdir()
        test_runner.FreezeAndPlanTests.task(self, self.task_dir)
        for name in ("bun", "node", "codex", "chrome"):
            (self.root / name).write_bytes(name.encode())
        (self.root / "playwright").mkdir()
        (self.root / "playwright/package.json").write_text('{"version":"1.59.1"}')
        (self.root / "driver").mkdir()
        (self.root / "driver/proxy.cjs").write_text("// exact-origin synthetic fence")
        self.argv = ["--vector-root", str(self.root / "source"), "--codex-bin", str(self.root / "codex"),
                     "--bun", str(self.root / "bun"), "--node", str(self.root / "node"), "--study-dir", str(self.root / "study"),
                     "--task-dir", str(self.task_dir), "--out", str(self.root / "new-output"), "--label", "manual-missing",
                     "--chrome", str(self.root / "chrome"), "--playwright-module", str(self.root / "playwright"),
                     "--browser-driver-root", str(self.root / "driver"), "--app-port", "8088"]
        self.previous = self.root / "previous-pair"
        (self.previous / "codex").mkdir(parents=True)
        prior_options = runner.parser().parse_args(self.argv)
        prior_options.order = "codex,vector"
        prior_options.run = True
        with patch.object(runner, "source_revision", return_value=("a" * 40, False)):
            self.prior = runner.build_plan(prior_options)
        self.final = copy.deepcopy(status())
        self.final["attempts"] += 1
        self.final["measuredUsd"] += 0.1
        self.final["actors"]["foundry-codex"]["measuredUsd"] += 0.1
        self.run = {"runtime": "codex", "actor": "foundry-codex", "label": "original-pair-codex", "attempts": [{"index": 0}],
                    "stopReason": "coordinator_review_required", "settlementComplete": True,
                    "tokenClosure": "scoped_disarm_acknowledged_and_settled", "before": status(), "finalStatus": self.final,
                    "providerRequests": 1, "measuredUsd": 0.1}
        self.summary = {"kind": "paired-agentic-study-results-v1", "model": runner.MODEL, "reasoning": "high",
                        "arms": {"codex": self.run}, "historicalAmountsReset": False, "automaticNextPair": False}
        self.write_records()
        self.options = runner.parser().parse_args(self.argv + ["--order", "vector", "--continue-from", str(self.previous)])

    def write_records(self):
        runner.save(self.previous / "plan.json", self.prior)
        runner.save(self.previous / "summary.json", self.summary)
        runner.save(self.previous / "codex/run.json", self.run)

    def plan(self, revision="a" * 40, dirty=False):
        with patch.object(runner, "source_revision", return_value=(revision, dirty)):
            return runner.build_plan(self.options)

    def test_free_continuation_plan_preserves_lineage_and_does_not_read_a_credential_or_rpc(self):
        output = io.StringIO()
        with patch.object(runner, "source_revision", return_value=("a" * 40, False)), \
                patch.object(runner, "Controller", side_effect=AssertionError("No RPC")), contextlib.redirect_stdout(output):
            self.assertEqual(runner.main(self.argv + ["--order", "vector", "--continue-from", str(self.previous)]), 0)
        plan = json.loads(output.getvalue())
        lineage = plan["continuation"]
        self.assertEqual(plan["order"], ["vector"])
        self.assertEqual(lineage["completedRuntime"], "codex")
        self.assertEqual(lineage["missingRuntime"], "vector")
        self.assertEqual(lineage["previousStopReason"], "coordinator_review_required")
        self.assertFalse(lineage["historicalAmountsReset"])
        self.assertFalse(lineage["automaticContinuation"])
        self.assertFalse(self.options.out.exists())
        self.assertFalse((self.root / "study").exists())

    def test_single_order_requires_continuation_and_paired_order_cannot_continue(self):
        for order, previous in (("vector", None), ("vector,codex", self.previous)):
            self.options.order, self.options.continue_from = order, previous
            with self.subTest(order=order), self.assertRaises(runner.StudyError):
                self.plan()

    def test_existing_or_partial_requested_runtime_cannot_be_rerun(self):
        self.summary["arms"]["vector"] = copy.deepcopy(self.run)
        self.write_records()
        with self.assertRaises(runner.StudyError):
            self.plan()
        del self.summary["arms"]["vector"]
        self.write_records()
        (self.previous / "vector").mkdir()
        with self.assertRaises(runner.StudyError):
            self.plan()

    def test_changed_or_dirty_product_source_is_rejected(self):
        for revision, dirty in (("b" * 40, False), ("a" * 40, True)):
            with self.subTest(revision=revision, dirty=dirty), self.assertRaises(runner.StudyError):
                self.plan(revision, dirty)

    def test_tool_or_browser_pin_changes_are_rejected(self):
        for relative in ("bun", "codex", "chrome", "playwright/package.json", "driver/proxy.cjs"):
            file = self.root / relative
            original = file.read_bytes()
            file.write_bytes(b'{"version":"changed"}' if relative.endswith("package.json") else b"changed")
            with self.subTest(path=relative), self.assertRaises(runner.StudyError):
                self.plan()
            file.write_bytes(original)

    def test_missing_pins_or_invalid_task_inventory_are_rejected(self):
        for field in ("model", "reasoning", "autonomousAgentsPerRuntime", "toolSha256", "browserDriverFiles", "runnerFiles", "taskFiles", "taskSha256"):
            original = self.prior.pop(field)
            self.write_records()
            with self.subTest(field=field), self.assertRaises(runner.StudyError):
                self.plan()
            self.prior[field] = original
        self.write_records()

    def test_task_change_requires_exact_explicit_old_sha_and_preserves_public_inputs(self):
        (self.task_dir / "evaluate.py").write_text("# reviewed corrected instrument")
        with self.assertRaises(runner.StudyError):
            self.plan()
        self.options.previous_task_sha = "b" * 64
        with self.assertRaises(runner.StudyError):
            self.plan()
        self.options.previous_task_sha = self.prior["taskSha256"]
        self.assertTrue(self.plan()["continuation"]["instrumentChanged"])
        (self.task_dir / "TASK.md").write_text("Different product requirement")
        with self.assertRaises(runner.StudyError):
            self.plan()

    def test_missing_or_ambiguous_settlement_is_rejected(self):
        changes = [{"settlementComplete": False}, {"tokenClosure": "unknown"}, {"closureFailureType": "TimeoutError"},
                   {"finalStatus": {**self.final, "active": 1}}, {"finalStatus": {**self.final, "batchCallsRemaining": 1}}]
        original = copy.deepcopy(self.run)
        for change in changes:
            self.run.clear()
            self.run.update(copy.deepcopy(original))
            self.run.update(change)
            self.write_records()
            with self.subTest(change=list(change)), self.assertRaises(runner.StudyError):
                self.plan()

    def test_summary_arm_mismatch_is_rejected(self):
        runner.save(self.previous / "codex/run.json", {**self.run, "stopReason": "different"})
        with self.assertRaises(runner.StudyError):
            self.plan()

    def test_missing_records_nonpaired_lineage_and_inconsistent_settled_usage_are_rejected(self):
        original = copy.deepcopy(self.prior)
        self.prior["order"] = ["codex"]
        self.write_records()
        with self.assertRaises(runner.StudyError):
            self.plan()
        self.prior = original
        self.run["providerRequests"] = 2
        self.write_records()
        with self.assertRaises(runner.StudyError):
            self.plan()
        self.run["providerRequests"] = 1
        self.write_records()
        (self.previous / "summary.json").unlink()
        with self.assertRaises(runner.StudyError):
            self.plan()

    def test_original_records_are_frozen_and_prior_ledger_cannot_be_rewound(self):
        plan = self.plan()
        runner.check_continuation(plan, self.final)
        with self.assertRaises(runner.StudyError):
            runner.check_continuation(plan, status())
        changed_actor = copy.deepcopy(self.final)
        changed_actor["actors"]["foundry-vector"]["measuredUsd"] -= 0.1
        with self.assertRaises(runner.StudyError):
            runner.check_continuation(plan, changed_actor)
        runner.save(self.previous / "summary.json", {**self.summary, "note": "changed after plan"})
        with self.assertRaises(runner.StudyError):
            runner.check_continuation(plan)

    def test_continuation_requires_new_output_outside_old_source_and_task_trees(self):
        for output in (self.previous, self.previous / "nested", self.root / "source/new", self.task_dir / "new"):
            self.options.out = output
            with self.subTest(output=output.name), self.assertRaises(runner.StudyError):
                self.plan()

    def test_explicit_run_invokes_only_missing_arm_and_records_original_outcome(self):
        plan = self.plan()
        study = self.root / "study"
        study.mkdir()
        runner.save(study / "gateway-config.json", {"localToken": "synthetic-controller"})
        controller = FakeController()
        controller.state = copy.deepcopy(self.final)
        result = {"stopReason": "passed", "settlementComplete": True, "providerRequests": 0, "measuredUsd": 0}
        argv = self.argv + ["--order", "vector", "--continue-from", str(self.previous), "--expected-source", "a" * 40,
                            "--expected-task-sha", plan["taskSha256"], "--run"]
        with patch.object(runner, "source_revision", return_value=("a" * 40, False)), \
                patch.object(runner, "Controller", return_value=controller), \
                patch.object(runner, "perform_arm", return_value=result) as arm, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(argv), 0)
        self.assertEqual(arm.call_count, 1)
        self.assertEqual(arm.call_args.args[3], "vector")
        saved = json.loads((self.options.out / "summary.json").read_text())
        self.assertEqual(set(saved["arms"]), {"vector"})
        self.assertEqual(saved["continuation"]["previousStopReason"], "coordinator_review_required")
        self.assertEqual(saved["continuation"]["completedRuntime"], "codex")
        self.assertFalse(saved["historicalAmountsReset"])


if __name__ == "__main__":
    unittest.main()
