"""Free browser provisioning and posthoc-review state-machine controls."""
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import runner
import test_continuation
import test_runner


class BrowserPolicyTests(unittest.TestCase):
    def options(self, root, mode="shared-client"):
        return SimpleNamespace(browser_access_mode=mode, node=root / "node", bun=root / "bun", chrome=root / "chrome",
                               playwright_module=root / "playwright", browser_driver_root=root / "driver")

    def test_shared_mode_removes_library_paths_from_both_cli_profiles_but_keeps_common_client(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            options = self.options(root)
            base = {**{name: "must-not-reach-cli" for name in runner.BROWSER_LIBRARY_ENV},
                    **{name.lower(): "must-not-reach-cli" for name in runner.BROWSER_LIBRARY_ENV},
                    "BROWSER_DRIVER_CLIENT": "reviewed-client", "BROWSER_DRIVER_ENDPOINT": "http://127.0.0.1:1234",
                    "BENCH_BROWSER_TOKEN": "synthetic-browser-capability"}
            for runtime in ("vector", "codex"):
                home = root / runtime
                home.mkdir()
                profile = runner.vector_environment(base, home, "http://127.0.0.1:23130", "local-run-synthetic") if runtime == "vector" else {**base, "BENCH_API_KEY": "local-run-synthetic"}
                configured = runner.cli_browser_environment(profile, options)
                self.assertFalse(runner.BROWSER_LIBRARY_ENV & {name.upper() for name in configured}, runtime)
                self.assertEqual(configured["NODE_EXE"], str(options.node))
                for name in ("BROWSER_DRIVER_CLIENT", "BROWSER_DRIVER_ENDPOINT", "BENCH_BROWSER_TOKEN"):
                    self.assertEqual(configured[name], base[name])

    def test_legacy_mode_reproduces_original_library_environment(self):
        root = Path("synthetic-tools")
        options = self.options(root, "legacy-library-env")
        base = {"HOME": "isolated", "BROWSER_DRIVER_CLIENT": "reviewed-client"}
        expected = {**base, "NODE_EXE": str(options.node), "PLAYWRIGHT_MODULE": str(options.playwright_module),
                    "VECTOR_BENCH_PLAYWRIGHT_MODULE": str(options.playwright_module), "CHROME_PATH": str(options.chrome),
                    "VECTOR_BENCH_CHROME": str(options.chrome)}
        self.assertEqual(runner.cli_browser_environment(base, options), expected)

    def test_evaluator_and_owned_driver_retain_explicit_frozen_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            options = self.options(root)
            env = runner.evaluator_environment(root / "evaluation-home", root / "app", options)
            self.assertEqual(env["VECTOR_BENCH_PLAYWRIGHT_MODULE"], str(options.playwright_module))
            self.assertEqual(env["VECTOR_BENCH_CHROME"], str(options.chrome))
            self.assertEqual(env["VECTOR_BENCH_BROWSER_PROXY"], str(options.browser_driver_root / "proxy.cjs"))
            driver = runner.BrowserDriver(node=options.node, root=options.browser_driver_root, playwright=options.playwright_module,
                                          chrome=options.chrome, output=root / "driver-output", origin="http://127.0.0.1:8088")
            self.assertEqual(driver.playwright, options.playwright_module)
            self.assertEqual(driver.chrome, options.chrome)

    def test_legacy_prompt_matches_original_9295ab9_byte_snapshots(self):
        options = self.options(Path("tools"), "legacy-library-env")
        # Independently captured from the original perform_arm prompt AST before refactoring.
        for configured, expected in ((False, "e1e407d8a2d11ebb1f8118ae6c9b6506f97ac8051897f2610bbbfd010bc96f82"),
                                     (True, "8913e6cce8bbf34ee7ba67b8171a3bacd205f41844cf355921f3fcaf117dafb5")):
            options.browser_driver_root = Path("driver") if configured else None
            actual = runner.task_prompt({"additionalPrompt": "synthetic task note"}, options)
            self.assertEqual(hashlib.sha256(actual.encode()).hexdigest(), expected)

    def test_shared_prompt_requires_client_and_prohibits_raw_browser_and_profiles(self):
        prompt = runner.task_prompt({"additionalPrompt": "synthetic task note"}, self.options(Path("tools")))
        self.assertIn("use only the supplied common browser client", prompt)
        self.assertIn("Do not import Playwright", prompt)
        self.assertIn("Chrome/Chromium yourself", prompt)
        self.assertIn("attach existing browser profiles", prompt)
        self.assertIn("BROWSER_DRIVER_CLIENT", prompt)
        self.assertNotIn("PLAYWRIGHT_MODULE and CHROME_PATH", prompt)
        self.assertIn("synthetic task note", prompt)

    def continuation_fixture(self):
        fixture = test_continuation.ManualContinuationTests(methodName="runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        return fixture

    def test_new_plans_default_shared_with_unchanged_model_agent_and_caps(self):
        fixture = self.continuation_fixture()
        plan = fixture.plan()
        self.assertEqual(plan["browserAccessMode"], "shared-client")
        self.assertEqual(plan["model"], runner.MODEL)
        self.assertEqual(plan["reasoning"], "high")
        self.assertEqual(plan["autonomousAgentsPerRuntime"], 1)
        self.assertEqual(plan["studyHardCapUsd"], 48)
        self.assertEqual(plan["actorHardCapUsd"], 20)
        self.assertEqual(plan["outputCeiling"], 32000)

    def test_previous_plans_without_a_browser_mode_require_explicit_legacy(self):
        fixture = self.continuation_fixture()
        fixture.prior.pop("browserAccessMode")
        fixture.prior.pop("browserAccessPolicy")
        fixture.write_records()
        with self.assertRaisesRegex(runner.StudyError, "explicit legacy-library-env"):
            fixture.plan()
        fixture.options.browser_access_mode = "legacy-library-env"
        plan = fixture.plan()
        self.assertEqual(plan["continuation"]["previousBrowserAccessMode"], "legacy-library-env")
        self.assertEqual(plan["browserAccessMode"], "legacy-library-env")

    def test_continuation_cannot_change_an_explicit_shared_mode_to_legacy(self):
        fixture = self.continuation_fixture()
        fixture.options.browser_access_mode = "legacy-library-env"
        with self.assertRaises(runner.StudyError):
            fixture.plan()

    def test_shared_paid_plan_requires_owned_browser_paths_before_any_execution(self):
        fixture = self.continuation_fixture()
        fixture.options.run = True
        fixture.options.chrome = None
        with self.assertRaisesRegex(runner.StudyError, "owned browser driver"):
            fixture.plan()

    def audited_episode(self, audit, mode="shared-client"):
        episode = test_runner.Episode([test_runner.gate("product_failure"), test_runner.gate()])
        original = episode.agent
        def agent(*args):
            return {**original(*args), "browserAccessAudit": audit}
        return episode, episode.run(run_agent=agent, browser_access_mode=mode)

    def test_browser_review_stops_after_completed_agent_without_another_paid_step(self):
        episode, result = self.audited_episode({"status": "review_required", "requiresManualReview": True})
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertEqual(result["reviewReason"], "browser_access_audit")
        self.assertEqual(len(episode.agent_calls), 1)
        self.assertEqual(episode.snapshots, [0])
        self.assertEqual(episode.gate_calls, [0])
        self.assertEqual(result["attempts"][0]["gateVerdict"], "product_failure")
        self.assertTrue(result["settlementComplete"])
        self.assertAlmostEqual(result["measuredUsd"], 0.1)
        self.assertEqual(sum(route == "/control" for route, _ in episode.controller.calls), 1)
        self.assertEqual(sum(route == "/disarm" for route, _ in episode.controller.calls), 1)

    def test_missing_audit_in_shared_mode_requires_review(self):
        episode, result = self.audited_episode(None)
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertEqual(len(episode.agent_calls), 1)
        self.assertEqual(episode.gate_calls, [0])

    def test_audit_review_preserves_a_passing_free_gate_without_another_model_attempt(self):
        episode = test_runner.Episode([test_runner.gate()])
        original = episode.agent
        def agent(*args):
            return {**original(*args), "browserAccessAudit": {"requiresManualReview": True}}
        result = episode.run(run_agent=agent, browser_access_mode="shared-client")
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertEqual(result["attempts"][0]["gateVerdict"], "passed")
        self.assertEqual(episode.gate_calls, [0])
        self.assertEqual(len(episode.agent_calls), 1)

    def test_core_worker_checks_take_precedence_after_free_gate_even_when_audit_needs_review(self):
        episode = test_runner.Episode()
        episode.worker_calls = 1
        original = episode.agent
        def agent(*args):
            return {**original(*args), "browserAccessAudit": {"requiresManualReview": True}}
        result = episode.run(run_agent=agent, browser_access_mode="shared-client")
        self.assertEqual(result["stopReason"], "single_agent_or_session_violation")
        self.assertEqual(episode.gate_calls, [0])
        self.assertEqual(len(episode.agent_calls), 1)

    def test_clear_shared_client_metadata_allows_the_original_same_session_policy(self):
        episode, result = self.audited_episode({"status": "no_clear_bypass_observed", "requiresManualReview": False})
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(len(episode.agent_calls), 2)
        self.assertEqual(episode.agent_calls[1]["session"], "ses_synthetic")

    def test_informational_coverage_unknowns_do_not_automatically_block_a_normal_repair(self):
        episode, result = self.audited_episode({"status": "no_clear_bypass_observed", "requiresManualReview": False,
                                               "counts": {"unknownObservations": 3, "informationalUnknownObservations": 3}})
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(len(episode.agent_calls), 2)

    def test_legacy_observations_do_not_retroactively_change_old_execution_policy(self):
        episode, result = self.audited_episode({"status": "direct_browser_reference_observed", "requiresManualReview": True}, "legacy-library-env")
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(len(episode.agent_calls), 2)


if __name__ == "__main__":
    unittest.main()
