"""Interrupted invocation accounting against a synthetic funded controller."""
from unittest.mock import patch
import unittest

import runner
import test_runner


class InterruptedAttemptUsageTests(unittest.TestCase):
    def test_first_invocation_that_spends_then_throws_retains_settled_per_attempt_cost(self):
        episode = test_runner.Episode()
        def interrupted(*_args):
            episode.controller.spend(amount=0.0497882, calls=2)
            raise TimeoutError("synthetic monitor timeout")
        result = episode.run(run_agent=interrupted)
        self.assertEqual(result["stopReason"], "coordinator_review_required")
        self.assertEqual(result["failureType"], "TimeoutError")
        self.assertEqual(result["providerRequests"], 2)
        self.assertAlmostEqual(result["measuredUsd"], 0.0497882)
        attempt = result["attempts"][0]
        self.assertEqual(attempt["usageAtStart"], {"providerRequests": 0, "measuredUsd": 0})
        self.assertEqual(attempt["usageThroughClosure"]["providerRequests"], 2)
        self.assertEqual(attempt["incrementalUsage"]["providerRequests"], 2)
        self.assertAlmostEqual(attempt["incrementalUsage"]["measuredUsd"], 0.0497882)
        self.assertEqual(attempt["invocationStatus"], "interrupted")
        self.assertEqual(attempt["invocationFailureType"], "TimeoutError")
        self.assertEqual(attempt["agentTelemetryStatus"], "incomplete")
        self.assertNotIn("agent", attempt)
        self.assertNotIn("usage", attempt)
        self.assertEqual(episode.snapshots, [0])
        self.assertTrue(result["settlementComplete"])

    def test_completed_first_attempt_and_interrupted_repair_keep_29_and_2_separate(self):
        episode = test_runner.Episode([test_runner.gate("product_failure")])
        def agent(prompt, session, timeout, calls, index, token, cap, before):
            if index == 0:
                episode.controller.spend(amount=0.7455959, calls=29)
                return {"exitCode": 0, "timedOut": False, "wallMs": 100, "sessionID": "ses_synthetic",
                        "observedSessionCount": 1, "workerCalls": 0}
            self.assertEqual(session, "ses_synthetic")
            episode.controller.spend(amount=0.0497882, calls=2)
            raise TimeoutError("synthetic monitor timeout after admission")
        result = episode.run(run_agent=agent)
        first, repair = result["attempts"]
        self.assertEqual(result["providerRequests"], 31)
        self.assertAlmostEqual(result["measuredUsd"], 0.7953841)
        self.assertEqual(first["usage"]["providerRequests"], 29)
        self.assertEqual(first["incrementalUsage"]["providerRequests"], 29)
        self.assertAlmostEqual(first["incrementalUsage"]["measuredUsd"], 0.7455959)
        self.assertEqual(repair["usageAtStart"]["providerRequests"], 29)
        self.assertEqual(repair["usageThroughClosure"]["providerRequests"], 31)
        self.assertEqual(repair["incrementalUsage"]["providerRequests"], 2)
        self.assertAlmostEqual(repair["incrementalUsage"]["measuredUsd"], 0.0497882)
        self.assertEqual(repair["usageAccountingStatus"], "settled_through_owned_scope_closure")
        self.assertEqual(episode.gate_calls, [0])
        self.assertEqual(episode.snapshots, [0, 1])
        self.assertEqual(sum(route == "/control" for route, _ in episode.controller.calls), 1)
        self.assertEqual(sum(route == "/disarm" for route, _ in episode.controller.calls), 1)

    def test_failed_closure_leaves_interrupted_attempt_usage_unknown_never_zero(self):
        episode = test_runner.Episode()
        original = episode.controller
        def controller(route, body=None):
            if route == "/disarm":
                raise runner.StudyError("synthetic closure transport loss")
            return original(route, body)
        def interrupted(*_args):
            original.spend(amount=0.05, calls=2)
            raise TimeoutError("synthetic monitor timeout")
        result = episode.run(run_agent=interrupted, controller=controller)
        attempt = result["attempts"][0]
        self.assertEqual(result["stopReason"], "closure_review_required")
        self.assertFalse(result["settlementComplete"])
        self.assertIsNone(attempt["usageThroughClosure"])
        self.assertIsNone(attempt["incrementalUsage"])
        self.assertEqual(attempt["usageAccountingStatus"], "unknown_owned_scope_closure_unconfirmed")
        self.assertNotIn("measuredUsd", result)

    def test_completed_attempts_keep_existing_cumulative_usage_and_add_true_incremental_usage(self):
        episode = test_runner.Episode([test_runner.gate("product_failure"), test_runner.gate()])
        result = episode.run()
        first, repair = result["attempts"]
        self.assertEqual(result["stopReason"], "passed")
        self.assertEqual(first["usage"]["providerRequests"], 1)
        self.assertEqual(repair["usage"]["providerRequests"], 2)
        self.assertEqual(repair["usageAtStart"]["providerRequests"], 1)
        self.assertEqual(repair["incrementalUsage"]["providerRequests"], 1)
        self.assertAlmostEqual(repair["incrementalUsage"]["measuredUsd"], 0.1)
        self.assertEqual(first["invocationStatus"], "returned")
        self.assertEqual(first["agentTelemetryStatus"], "returned_runtime_result")
        self.assertNotIn("usageThroughClosure", first)

    def test_failed_repair_closure_keeps_the_first_attempt_known_and_the_repair_unknown(self):
        episode = test_runner.Episode([test_runner.gate("product_failure")])
        original_controller = episode.controller
        original_agent = episode.agent
        def controller(route, body=None):
            if route == "/disarm":
                raise runner.StudyError("synthetic closure uncertainty")
            return original_controller(route, body)
        def agent(*args):
            if args[4] == 0:
                return original_agent(*args)
            original_controller.spend(amount=0.05, calls=2)
            raise TimeoutError()
        result = episode.run(run_agent=agent, controller=controller)
        first, repair = result["attempts"]
        self.assertEqual(first["incrementalUsage"]["providerRequests"], 1)
        self.assertAlmostEqual(first["incrementalUsage"]["measuredUsd"], 0.1)
        self.assertIsNone(repair["incrementalUsage"])
        self.assertIsNone(repair["usageThroughClosure"])
        self.assertEqual(result["stopReason"], "closure_review_required")

    def test_interrupted_wall_time_is_observed_including_snapshot_cleanup_not_guessed(self):
        episode = test_runner.Episode()
        def interrupted(*_args):
            episode.controller.spend(amount=0.01, calls=1)
            raise TimeoutError()
        with patch.object(runner.time, "monotonic", side_effect=[100.0, 102.25]), patch.object(runner.time, "time", return_value=1_700_000_000.0):
            result = episode.run(run_agent=interrupted)
        attempt = result["attempts"][0]
        self.assertEqual(attempt["observedInvocationWallMs"], 2250)
        self.assertEqual(attempt["invocationStartedAtUnixMs"], 1_700_000_000_000)
        self.assertIn("source_snapshot_including_cleanup", attempt["observedInvocationWallScope"])
        self.assertIn("excludes_final_controller_closure", attempt["observedInvocationWallScope"])
        self.assertEqual(result["agentWallMs"], 0)

    def test_returned_agent_timeout_keeps_its_process_stop_type_and_settled_usage(self):
        episode = test_runner.Episode()
        original = episode.agent
        def timed_out(*args):
            return {**original(*args), "timedOut": True}
        result = episode.run(run_agent=timed_out)
        self.assertEqual(result["stopReason"], "agent_fatal_or_timeout")
        self.assertEqual(result["attempts"][0]["invocationStatus"], "returned")
        self.assertEqual(result["attempts"][0]["agentTelemetryStatus"], "incomplete")
        self.assertEqual(result["attempts"][0]["incrementalUsage"]["providerRequests"], 1)
        self.assertEqual(len(result["attempts"]), 1)


if __name__ == "__main__":
    unittest.main()
