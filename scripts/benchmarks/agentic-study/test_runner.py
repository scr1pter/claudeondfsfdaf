"""Offline runner controls: synthetic state and injected I/O, never provider calls."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runner


def status():
    return {"limitUsd": 48, "phaseID": runner.PHASE, "measuredUsd": 11.2319408,
            "reservedUsd": 0, "attempts": 449, "active": 0, "halted": None, "batchCallsRemaining": 0,
            "actors": {"foundry-vector": {"limitUsd": 20, "measuredUsd": 6.4792501, "reservedUsd": 0},
                       "foundry-codex": {"limitUsd": 20, "measuredUsd": 1.8089226, "reservedUsd": 0}}}


def gate(verdict="passed", checks=2):
    return {"verdict": verdict, "sourceUnchanged": True,
            "checks": [{"name": "contract-" + str(i), "status": "failed" if verdict == "product_failure" and i == 0 else "passed",
                        "expected": "public contract holds", "actual": "failed" if verdict == "product_failure" else "passed"}
                       for i in range(checks)]}


class FakeController:
    def __init__(self):
        self.state = status()
        self.calls = []
        self.active_actor = None
        self.token = "local-run-synthetic"

    def __call__(self, route, body=None):
        self.calls.append((route, copy.deepcopy(body)))
        if route == "/control":
            self.active_actor = body["actor"]
            self.state["batchCallsRemaining"] = body["calls"]
            return {"requestToken": self.token, "status": copy.deepcopy(self.state)}
        if route == "/disarm":
            if body != {"requestToken": self.token}:
                raise AssertionError("Wrong or blanket disarm")
            self.state["batchCallsRemaining"] = 0
        return copy.deepcopy(self.state)

    def spend(self, amount=0.1, calls=1):
        self.state["attempts"] += calls
        self.state["measuredUsd"] += amount
        self.state["actors"][self.active_actor]["measuredUsd"] += amount
        self.state["batchCallsRemaining"] -= calls


class Episode:
    def __init__(self, reports=None):
        self.controller = FakeController()
        self.reports = reports or [gate()]
        self.agent_calls = []
        self.gate_calls = []
        self.saved = []
        self.snapshots = []
        self.protected = False
        self.agent_error = None
        self.worker_calls = 0
        self.session_after_repair = "ses_synthetic"

    def agent(self, prompt, session, timeout, calls, index, token, cap, before):
        self.agent_calls.append({"prompt": prompt, "session": session, "timeout": timeout, "calls": calls, "index": index, "token": token, "cap": cap})
        self.controller.spend()
        if self.agent_error:
            raise self.agent_error
        return {"exitCode": 0, "timedOut": False, "wallMs": 100, "sessionID": self.session_after_repair if index else "ses_synthetic",
                "observedSessionCount": 1, "workerCalls": self.worker_calls}

    def evaluate(self, index):
        self.gate_calls.append(index)
        return {"report": self.reports[index]}

    def preserve(self, index):
        self.snapshots.append(index)
        return {"files": {"server.ts": "synthetic-hash"}, "protectedViolations": ["tests/smoke.test.ts"] if self.protected else []}

    def run(self, **changes):
        args = {"runtime": "vector", "label": "synthetic-case-vector", "prompt": "Complete TASK.md", "task": {"expectedApiGroups": 2},
                "controller": self.controller, "run_agent": self.agent, "evaluate": self.evaluate, "preserve": self.preserve,
                "check_frozen": lambda: None, "persist": lambda value: self.saved.append(copy.deepcopy(value)),
                "settled": lambda: self.controller("/status")}
        args.update(changes)
        return runner.coordinate_arm(**args)


class BudgetAndEpisodeTests(unittest.TestCase):
    def test_nonzero_historical_spending_is_carried_forward(self):
        episode = Episode()
        result = episode.run()
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(result["before"]["attempts"], 449)
        self.assertEqual(result["before"]["measuredUsd"], 11.2319408)
        self.assertEqual(result["providerRequests"], 1)
        self.assertAlmostEqual(result["measuredUsd"], 0.1)
        self.assertAlmostEqual(result["finalStatus"]["actors"]["foundry-vector"]["measuredUsd"], 6.5792501)

    def test_one_hard_product_failure_repairs_in_same_session_with_fixed_cap(self):
        episode = Episode([gate("product_failure"), gate()])
        result = episode.run()
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(len(result["attempts"]), 2)
        self.assertIsNone(episode.agent_calls[0]["session"])
        self.assertEqual(episode.agent_calls[1]["session"], "ses_synthetic")
        self.assertEqual([call["cap"] for call in episode.agent_calls], [3, 3])
        self.assertEqual([call["calls"] for call in episode.agent_calls], [300, 299])
        self.assertIn("contract-0", episode.agent_calls[1]["prompt"])
        self.assertEqual(sum(route == "/control" for route, _ in episode.controller.calls), 1)

    def test_second_product_failure_stops_without_third_attempt(self):
        episode = Episode([gate("product_failure"), gate("product_failure")])
        result = episode.run()
        self.assertEqual(result["stopReason"], "repair_limit")
        self.assertEqual(len(episode.agent_calls), 2)
        self.assertAlmostEqual(result["measuredUsd"], 0.2)

    def test_instrument_failure_never_becomes_paid_feedback(self):
        episode = Episode([{"verdict": "instrument_failure"}])
        result = episode.run()
        self.assertEqual(result["stopReason"], "instrument_failure")
        self.assertEqual(len(episode.agent_calls), 1)
        self.assertTrue(result["settlementComplete"])

    def test_protected_file_violation_is_preserved_without_repair_or_evaluation(self):
        episode = Episode()
        episode.protected = True
        result = episode.run()
        self.assertEqual(result["stopReason"], "protected_file_violation")
        self.assertEqual(episode.gate_calls, [])
        self.assertEqual(episode.snapshots, [0])
        self.assertEqual(len(episode.agent_calls), 1)

    def test_agent_failure_still_snapshots_disarms_and_counts_charge(self):
        episode = Episode()
        episode.agent_error = RuntimeError("synthetic launch failure")
        result = episode.run()
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertEqual(episode.snapshots, [0])
        self.assertTrue(result["settlementComplete"])
        self.assertAlmostEqual(result["measuredUsd"], 0.1)
        self.assertNotIn(episode.controller.token, json.dumps(result))

    def test_only_the_captured_token_is_disarmed(self):
        episode = Episode()
        episode.run()
        disarms = [body for route, body in episode.controller.calls if route == "/disarm"]
        self.assertEqual(disarms, [{"requestToken": episode.controller.token}])

    def test_ambiguous_arm_is_not_retried_or_blanket_disarmed(self):
        episode = Episode()
        original = episode.controller
        calls = []
        def ambiguous(route, body=None):
            calls.append(route)
            if route == "/control":
                original(route, body)
                raise runner.StudyError("synthetic response loss")
            return original(route, body)
        result = episode.run(controller=ambiguous)
        self.assertFalse(result["settlementComplete"])
        self.assertEqual(calls.count("/control"), 1)
        self.assertNotIn("/disarm", calls)
        self.assertEqual(episode.agent_calls, [])

    def test_existing_open_batch_prevents_new_funding(self):
        episode = Episode()
        episode.controller.state["batchCallsRemaining"] = 5
        result = episode.run()
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertFalse(any(route == "/control" for route, _ in episode.controller.calls))

    def test_rewound_history_is_rejected_before_arm(self):
        for field, value in [("attempts", 448), ("measuredUsd", 11.0), ("limitUsd", 49)]:
            episode = Episode()
            episode.controller.state[field] = value
            result = episode.run()
            self.assertEqual(result["stopReason"], "coordinator_review_required")
            self.assertFalse(any(route == "/control" for route, _ in episode.controller.calls))

    def test_live_status_cannot_rewind_the_current_case_while_preserving_the_old_minimum(self):
        before = status()
        before["attempts"] = 500
        before["measuredUsd"] = 12
        before["actors"]["foundry-vector"]["measuredUsd"] = 7
        after = status()
        with self.assertRaises(runner.StudyError):
            runner.usage_delta(before, after, "foundry-vector", require_idle=False)

    def test_cumulative_actor_limit_is_not_treated_as_a_fresh_budget(self):
        episode = Episode()
        episode.controller.state["actors"]["foundry-vector"]["measuredUsd"] = 19
        result = episode.run()
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertFalse(any(route == "/control" for route, _ in episode.controller.calls))

    def test_new_session_on_repair_stops_the_case(self):
        episode = Episode([gate("product_failure"), gate()])
        episode.session_after_repair = "ses_unrelated"
        result = episode.run()
        self.assertEqual(result["stopReason"], "session_continuity_violation")
        self.assertTrue(result["settlementComplete"])

    def test_worker_call_invalidates_the_single_agent_case(self):
        episode = Episode()
        episode.worker_calls = 1
        self.assertEqual(episode.run()["stopReason"], "single_agent_or_session_violation")

    def test_changed_freeze_closes_the_owned_scope_without_model_retry(self):
        episode = Episode()
        count = 0
        def frozen():
            nonlocal count
            count += 1
            if count == 2:
                raise runner.StudyError("synthetic changed evaluator")
        result = episode.run(check_frozen=frozen)
        self.assertEqual(episode.agent_calls, [])
        self.assertTrue(result["settlementComplete"])
        self.assertEqual(result["providerRequests"], 0)

    def test_soft_threshold_stops_before_another_repair(self):
        episode = Episode([gate("product_failure"), gate()])
        result = episode.run(soft_cap=0.05)
        self.assertEqual(result["stopReason"], "case_stop_threshold")
        self.assertEqual(len(episode.agent_calls), 1)
        self.assertAlmostEqual(result["measuredUsd"], 0.1)

    def test_drain_failure_is_not_reported_settled(self):
        episode = Episode()
        original = episode.controller
        def fail_close(route, body=None):
            if route == "/disarm":
                raise runner.StudyError("synthetic transport failure")
            return original(route, body)
        result = episode.run(controller=fail_close)
        self.assertEqual(result["stopReason"], "closure_review_required")
        self.assertFalse(result["settlementComplete"])


class GateTests(unittest.TestCase):
    def test_evaluator_exit_and_verdict_must_agree(self):
        for code, verdict in [(1, "passed"), (0, "product_failure"), (2, "passed")]:
            result = runner.checked_evaluation({"exitCode": code, "timedOut": False}, gate(verdict), True)
            self.assertEqual(result["verdict"], "instrument_failure")
        for code, verdict in [(0, "passed"), (1, "product_failure")]:
            report = gate(verdict)
            self.assertIs(runner.checked_evaluation({"exitCode": code, "timedOut": False}, report, True), report)

    def test_evaluator_timeout_or_authored_source_mutation_cannot_pass(self):
        self.assertEqual(runner.checked_evaluation({"exitCode": 0, "timedOut": True}, gate(), True)["verdict"], "instrument_failure")
        self.assertEqual(runner.checked_evaluation({"exitCode": 0, "timedOut": False}, gate(), False)["verdict"], "instrument_failure")

    def test_missing_partial_or_contradictory_gate_is_not_repair_feedback(self):
        reports = [None, {}, {"verdict": "passed"}, gate("instrument_failure"),
                   {**gate(), "sourceUnchanged": False}, {**gate(), "checks": [{"name": "only-one", "status": "passed"}]},
                   {**gate(), "checks": [{"name": "same", "status": "passed"}, {"name": "same", "status": "passed"}]},
                   {**gate(), "checks": [{"name": "a", "status": "failed"}, {"name": "b", "status": "passed"}]},
                   {**gate("product_failure"), "checks": [{"name": "a", "status": "not_run"}, {"name": "b", "status": "not_run"}]}]
        for report in reports:
            self.assertEqual(runner.gate_feedback(report, {"expectedApiGroups": 2}), ("instrument_failure", None))

    def test_feedback_contains_observations_not_hidden_or_raw_feedback(self):
        report = gate("product_failure")
        report["feedback"] = "hidden evaluator implementation must not be included"
        report["checks"][0]["error"] = "Bearer synthetic-secret"
        verdict, feedback = runner.gate_feedback(report, {"expectedApiGroups": 2})
        self.assertEqual(verdict, "product_failure")
        self.assertNotIn(report["feedback"], feedback)
        self.assertNotIn("synthetic-secret", feedback)
        self.assertIn("<redacted>", feedback)


class TransportAndProfileTests(unittest.TestCase):
    def test_loopback_only_base_rejects_remote_dns_credentials_and_parameters(self):
        self.assertEqual(runner.validate_base("http://127.0.0.1:23130/"), "http://127.0.0.1:23130")
        for base in ["https://example.invalid", "http://localhost:23130", "http://127.0.0.1:23130/v1", "http://127.0.0.1:23130?x=1", "http://user:secret@127.0.0.1:23130", "http://127.0.0.1:not-a-port"]:
            with self.assertRaises(runner.StudyError):
                runner.validate_base(base)

    def test_controller_forbids_blanket_disarm_before_any_http(self):
        controller = runner.Controller("http://127.0.0.1:23130", "synthetic-controller")
        with patch.object(controller.opener, "open", side_effect=AssertionError("HTTP must not be attempted")):
            with self.assertRaises(runner.StudyError):
                controller("/disarm", {})

    def test_redirects_are_not_followed(self):
        self.assertIsNone(runner.NoRedirect().redirect_request(None, None, 302, None, None, "https://example.invalid"))

    def test_environment_excludes_inherited_credentials_and_uses_isolated_homes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(runner.os.environ, {"OPENAI_API_KEY": "synthetic-parent-secret", "SENTRY_AUTH_TOKEN": "synthetic"}):
                env = runner.isolated_environment(root / "home", root / "app", root / "bun", root / "node")
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("SENTRY_AUTH_TOKEN", env)
            self.assertEqual(env["HOME"], str(root / "home"))
            self.assertEqual(env["VECTOR_EXPERIMENTAL_NATIVE_LLM"], "false")

    def test_vector_profile_preserves_session_cache_and_exact_prices_and_worker_denials(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            env = runner.vector_environment({}, home, "http://127.0.0.1:23130", "local-run-synthetic")
            config = json.loads(env["VECTOR_CONFIG_CONTENT"])
            provider = config["provider"]["openai"]
            self.assertTrue(provider["options"]["promptCacheBreakpoints"])
            self.assertNotIn("setCacheKey", provider["options"])
            model = provider["models"][runner.MODEL]
            self.assertEqual(model["limit"], {"context": 1050000, "output": 32000})
            self.assertEqual(model["options"]["reasoningEffort"], "high")
            self.assertFalse(model["options"]["nativePatch"])
            self.assertNotIn("cost", model)
            self.assertTrue(all(config["permission"][name] == "deny" for name in runner.WORKERS))
            catalog = json.loads(Path(env["VECTOR_MODELS_PATH"]).read_text(encoding="utf-8"))
            self.assertEqual(catalog["openai"]["models"][runner.MODEL]["cost"]["tiers"][0]["tier"]["size"], 272000)
            self.assertNotIn("local-run-synthetic", Path(env["VECTOR_MODELS_PATH"]).read_text(encoding="utf-8"))

    def test_evaluator_gets_only_explicit_browser_paths_without_runtime_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            options = type("Options", (), {"bun": root / "bun", "node": root / "node", "chrome": root / "chrome", "playwright_module": root / "playwright", "browser_driver_root": root / "browser-driver"})()
            with patch.dict(runner.os.environ, {"BENCH_BROWSER_TOKEN": "synthetic-browser-capability", "BENCH_API_KEY": "local-run-synthetic"}):
                env = runner.evaluator_environment(root / "evaluation-home", root / "app", options)
            self.assertEqual(env["VECTOR_BENCH_BROWSER_PROXY"], str(root / "browser-driver" / "proxy.cjs"))
            self.assertEqual(env["VECTOR_BENCH_PLAYWRIGHT_MODULE"], str(root / "playwright"))
            self.assertEqual(env["VECTOR_BENCH_CHROME"], str(root / "chrome"))
            self.assertNotIn("BENCH_BROWSER_TOKEN", env)
            self.assertNotIn("BENCH_API_KEY", env)

    def test_commands_use_same_high_model_and_preserve_resume_session(self):
        options = type("Options", (), {"bun": Path("bun"), "node": Path("node"), "codex_bin": Path("codex"), "vector_root": Path("source"), "provider_base": "http://127.0.0.1:23130"})()
        vector = runner.agent_command("vector", options, Path("app"), "prompt", "ses_same", 299, 3)
        codex = runner.agent_command("codex", options, Path("app"), "prompt", "thread_same", 299, 3)
        self.assertIn("openai/" + runner.MODEL, vector)
        self.assertEqual(vector[vector.index("--variant") + 1], "high")
        self.assertEqual(vector[vector.index("--max-cost") + 1], "3")
        self.assertEqual(vector[vector.index("--session") + 1], "ses_same")
        self.assertIn(runner.MODEL, codex)
        self.assertIn('model_reasoning_effort="high"', codex)
        self.assertIn('agents.max_threads=1', codex)
        self.assertEqual(codex[-3:], ["resume", "thread_same", "prompt"])

    def test_event_metadata_deduplicates_primary_sessions_without_copying_tool_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "agent.jsonl"
            rows = [{"sessionID": "ses_same"}, {"type": "tool_use", "sessionID": "ses_same", "part": {"tool": "terminal", "input": {"secret": "never-export"}}}]
            file.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            result = runner.event_metadata(file, "vector")
            self.assertEqual(result["observedSessionCount"], 1)
            self.assertEqual(result["toolsUsed"], ["terminal"])
            self.assertNotIn("never-export", json.dumps(result))


class FreezeAndPlanTests(unittest.TestCase):
    def task(self, root):
        (root / "seed").mkdir()
        (root / "seed" / "public.test.ts").write_text("public assertion", encoding="utf-8")
        (root / "TASK.md").write_text("Complete the synthetic workflow task.", encoding="utf-8")
        (root / "evaluate.py").write_text("# frozen synthetic instrument", encoding="utf-8")
        task = {"promptFile": "TASK.md", "seedDirectory": "seed", "evaluatorCommand": ["{python}", "{task}/evaluate.py", "--app", "{app}"], "protectedFiles": ["public.test.ts"], "expectedApiGroups": 2}
        (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
        return task

    def test_source_manifest_excludes_generated_caches_but_tracks_authored_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.task(root)
            before = runner.manifest(root)
            (root / "__pycache__").mkdir()
            (root / "__pycache__" / "test.pyc").write_bytes(b"generated")
            self.assertEqual(before, runner.manifest(root))
            (root / "evaluate.py").write_text("# changed instrument", encoding="utf-8")
            self.assertNotEqual(before, runner.manifest(root))

    def test_nested_build_dist_and_coverage_sources_are_never_generically_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["server/build/helper.ts", "server/dist/routes.ts", "server/coverage/check.ts", "dist/result.js"]:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("authored", encoding="utf-8")
            self.assertEqual(len(runner.manifest(root)), 4)
            declared = runner.manifest(root, ["dist"])
            self.assertEqual(len(declared), 3)
            self.assertIn("server/build/helper.ts", declared)
            self.assertNotIn("dist/result.js", declared)

    def test_declared_generated_directory_cannot_hide_seed_or_protected_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = self.task(root)
            for generated in [["."], ["../outside"], ["public.test.ts"]]:
                task["generatedDirectories"] = generated
                (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
                with self.assertRaises(runner.StudyError):
                    runner.load_task(root)

    def test_task_cannot_escape_or_add_unreviewed_command_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = self.task(root)
            self.assertEqual(runner.load_task(root), task)
            task["evaluatorCommand"] = ["{owner_secret}"]
            (root / "task.json").write_text(json.dumps(task), encoding="utf-8")
            with self.assertRaises(runner.StudyError):
                runner.load_task(root)
            with self.assertRaises(runner.StudyError):
                runner.inside(root, "../outside")

    def test_default_plan_never_reads_study_config_or_creates_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "task"
            task_dir.mkdir()
            self.task(task_dir)
            for name in ("bun", "node", "codex"):
                (root / name).write_bytes(name.encode())
            argv = ["--vector-root", str(root), "--codex-bin", str(root / "codex"), "--bun", str(root / "bun"),
                    "--node", str(root / "node"), "--study-dir", str(root / "does-not-exist"),
                    "--task-dir", str(task_dir), "--out", str(root / "new-output"), "--label", "synthetic-plan"]
            output = io.StringIO()
            with patch.object(runner, "source_revision", return_value=("a" * 40, False)), patch.object(runner, "Controller", side_effect=AssertionError("No RPC in plan")), contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(argv), 0)
            plan = json.loads(output.getvalue())
            self.assertFalse(plan["paidExecutionRequested"])
            self.assertFalse(plan["controllerOrProviderCredentialFilesReadByPlan"])
            self.assertFalse((root / "new-output").exists())

    def test_plan_pins_browser_proxy_chrome_and_playwright_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_dir = root / "task"
            task_dir.mkdir()
            self.task(task_dir)
            for name in ("bun", "node", "codex", "chrome"):
                (root / name).write_bytes(name.encode())
            (root / "playwright").mkdir()
            (root / "playwright" / "package.json").write_text('{"version":"1.59.1"}', encoding="utf-8")
            (root / "browser-driver").mkdir()
            (root / "browser-driver" / "proxy.cjs").write_text("// frozen exact-origin proxy", encoding="utf-8")
            options = runner.parser().parse_args(["--vector-root", str(root), "--codex-bin", str(root / "codex"), "--bun", str(root / "bun"),
                "--node", str(root / "node"), "--study-dir", str(root / "study"), "--task-dir", str(task_dir), "--out", str(root / "out"),
                "--label", "synthetic-pins", "--chrome", str(root / "chrome"), "--playwright-module", str(root / "playwright"),
                "--browser-driver-root", str(root / "browser-driver")])
            with patch.object(runner, "source_revision", return_value=("a" * 40, False)):
                before = runner.build_plan(options)
                (root / "chrome").write_bytes(b"changed chrome")
                after = runner.build_plan(options)
            self.assertEqual(before["playwrightVersion"], "1.59.1")
            self.assertIn("proxy.cjs", before["browserDriverFiles"])
            self.assertNotEqual(before["toolSha256"]["chrome"], after["toolSha256"]["chrome"])
            self.assertEqual(before["toolSha256"]["playwright-package"], after["toolSha256"]["playwright-package"])


if __name__ == "__main__":
    unittest.main()
