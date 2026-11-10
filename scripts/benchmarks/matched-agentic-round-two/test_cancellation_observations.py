"""Pure cancellation admission/terminal controls; no runtime or provider calls."""
import tempfile
from pathlib import Path
import unittest

from native_team_policy import PolicyError
from owned_team_witness import Audit, OwnedArm, QueuedClientCancelled, known_completed_usage
from test_owned_witness import FakeMeter, ROOT, ROLES, add_thread, body, headers, native_fixture


def terminal():
    return {"object": "response", "status": "completed", "usage": {"input_tokens": 5, "output_tokens": 3,
        "total_tokens": 8, "input_tokens_details": {"cached_tokens": 1, "cache_write_tokens": 2,
            "cache_write_tokens_details": {"ttl_12h_tokens": 0, "ttl_30m_tokens": 2}},
        "output_tokens_details": {"reasoning_tokens": 1}}}


class CancellationObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.registry = native_fixture(self.root / "native")
        self.meter = FakeMeter()
        before = self.meter.control("/status")
        token = self.meter.control("/control", {"actor": "foundry-codex", "label": "synthetic-cancel-control", "calls": 300})["requestToken"]
        self.arm = OwnedArm("codex", self.registry, ROLES, token, before, self.meter.control,
            Audit(self.root / "audit.jsonl"), label="synthetic-cancel-control")

    def tearDown(self):
        self.meter.server_close()
        self.temp.cleanup()

    def entry(self):
        return self.arm.enter(body(), headers(), lambda: False)[1]

    def test_valid_usage_with_every_priced_category_is_known(self):
        self.assertTrue(known_completed_usage(terminal()))

    def test_incomplete_or_inconsistent_pricing_schema_is_unknown(self):
        mutations = [
            ("usage", None), ("usage.input_tokens", True), ("usage.input_tokens", 1.5),
            ("usage.input_tokens", -1), ("usage.input_tokens", 1050001),
            ("usage.output_tokens", 32001), ("usage.total_tokens", 7), ("usage.total_tokens", True),
            ("usage.input_tokens_details", None), ("usage.input_tokens_details.cached_tokens", None),
            ("usage.input_tokens_details.cache_write_tokens", None), ("usage.input_tokens_details.cached_tokens", 5),
            ("usage.input_tokens_details.cache_write_tokens_details", None),
            ("usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens", 1),
            ("usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens", False),
            ("usage.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens", 1),
            ("usage.input_tokens_details.cache_write_tokens_details.unknown_ttl", 0),
            ("usage.output_tokens_details", None), ("usage.output_tokens_details.reasoning_tokens", 4),
            ("usage.output_tokens_details.reasoning_tokens", True), ("status", "failed"),
            ("error", {"message": "synthetic failure"}),
        ]
        for path, value in mutations:
            changed = terminal(); target = changed
            keys = path.split(".")
            for key in keys[:-1]: target = target[key]
            target[keys[-1]] = value
            with self.subTest(path=path, value=value): self.assertFalse(known_completed_usage(changed))

    def test_clean_written_terminal_eof_is_normal_not_a_cancellation(self):
        self.arm.finish(self.entry(), terminal(), True, False, event="response.completed",
            delivery={"terminalFrameWritten": True, "upstreamEof": True, "unambiguousTail": True})
        self.assertIsNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews, [])
        self.assertIn("normal_post_terminal_client_eof", self.arm.audit.path.read_text())

    def test_known_completed_drain_allows_current_arm_but_requires_manual_closure(self):
        self.arm.finish(self.entry(), terminal(), True, False, event="response.completed",
            delivery={"terminalFrameWritten": False, "upstreamEof": True, "unambiguousTail": True})
        self.assertIsNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews[0]["reason"], "known_completed_client_cancellation")
        self.assertFalse(self.arm.nonfatal_reviews[0]["automaticReplay"])
        self.assertEqual(len(self.arm.requests), 1)
        self.entry()
        self.assertEqual(len(self.arm.requests), 2)

    def test_unknown_usage_is_not_excused_by_socket_write_or_completed_status(self):
        value = terminal(); del value["usage"]["input_tokens_details"]["cache_write_tokens"]
        self.arm.finish(self.entry(), value, True, False, event="response.completed",
            delivery={"terminalFrameWritten": True, "upstreamEof": True, "unambiguousTail": True})
        self.assertIsNotNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews, [])

    def test_unknown_eof_is_not_a_known_completed_drain(self):
        self.arm.finish(self.entry(), terminal(), True, False, event="response.completed",
            delivery={"terminalFrameWritten": False, "upstreamEof": False, "unambiguousTail": True})
        self.assertIsNotNone(self.arm.failure)

    def test_upstream_transport_failure_remains_fatal_with_a_terminal(self):
        self.arm.finish(self.entry(), terminal(), True, True, event="response.completed",
            delivery={"terminalFrameWritten": True, "upstreamEof": True, "unambiguousTail": True})
        self.assertEqual(self.arm.failure, "upstream_or_terminal_unknown")

    def test_contradictory_or_malformed_terminal_remains_fatal(self):
        self.arm.finish(self.entry(), terminal(), True, False, issue="multiple_upstream_terminals", event="response.completed",
            delivery={"terminalFrameWritten": True, "upstreamEof": True, "unambiguousTail": True})
        self.assertEqual(self.arm.failure, "multiple_upstream_terminals")

    def test_ambiguous_tail_is_fatal_even_without_client_disconnect(self):
        self.arm.finish(self.entry(), terminal(), False, False, event="response.completed",
            delivery={"terminalFrameWritten": True, "upstreamEof": True, "unambiguousTail": False})
        self.assertEqual(self.arm.failure, "upstream_trailing_event_unknown")

    def test_unforwarded_cancel_preserves_native_lifetime_slot_and_has_zerocharge(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        self.arm.admitted_ids.add(ROOT)
        self.arm.forwarding = True
        with self.assertRaises(QueuedClientCancelled):
            self.arm.enter(body(), headers("worker-a"), lambda: True)
        self.assertIsNone(self.arm.failure)
        self.assertEqual(self.arm.requests, [])
        self.assertEqual(self.meter.calls, 0)
        self.assertEqual(self.arm.slots["implementation"], "worker-a")
        self.assertEqual(self.arm.nonfatal_reviews[0]["measuredUsd"], 0)
        self.assertEqual(len(self.arm.queue), 0)
        add_thread(self.registry.database, "replacement", "implementation")
        with self.assertRaises(PolicyError): self.arm.enter(body(), headers("replacement"), lambda: True)
        self.assertIsNotNone(self.arm.failure)
        self.assertEqual(self.arm.slots["implementation"], "worker-a")

    def test_cancelled_unknown_native_identity_is_still_a_policy_failure(self):
        self.arm.forwarding = True
        with self.assertRaises(PolicyError): self.arm.enter(body(), headers("unknown"), lambda: True)
        self.assertIsNotNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews, [])

    def test_cancelled_wrong_model_is_still_a_policy_failure(self):
        self.arm.forwarding = True
        payload = body(); payload["model"] = "synthetic-wrong-model"
        with self.assertRaises(PolicyError): self.arm.enter(payload, headers(), lambda: True)
        self.assertIsNotNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews, [])

    def test_cancel_does_not_waive_deadline_or_preserve_unfunded_new_roles(self):
        self.arm.forwarding, self.arm.deadline = True, 0
        with self.assertRaises(PolicyError): self.arm.enter(body(), headers(), lambda: True)
        self.assertIsNotNone(self.arm.failure)
        self.assertEqual(self.arm.nonfatal_reviews, [])


if __name__ == "__main__":
    unittest.main()
