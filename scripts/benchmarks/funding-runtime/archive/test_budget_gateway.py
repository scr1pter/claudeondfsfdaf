import json
from pathlib import Path
import tempfile
import unittest

from budget_gateway import Budget, MODEL, OUTPUT_CAP, prepare, price


class GatewayTests(unittest.TestCase):
    def usage(self, **details):
        return {"input_tokens": 12000, "output_tokens": 200, "output_tokens_details": {"reasoning_tokens": 50}, "input_tokens_details": {"cached_tokens": 4000, "cache_write_tokens": 7000, **details}}

    def test_mixed_ttl_disjoint_cost_and_inclusive_reasoning(self):
        self.assertAlmostEqual(price(self.usage(cache_write_tokens_details={"ttl_30m_tokens": 3000, "ttl_12h_tokens": 4000})), 0.0319)

    def test_default_write_cost(self):
        self.assertAlmostEqual(price(self.usage()), 0.0219)

    def test_explicit_zero_is_known(self):
        self.assertEqual(price({"input_tokens": 0, "output_tokens": 0, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}}), 0)

    def test_missing_usage_is_not_free(self):
        for usage in (None, {}, {"input_tokens": 0}, {**self.usage(), "input_tokens_details": {"cached_tokens": 4000}}, {**self.usage(), "output_tokens": -1}, {**self.usage(), "output_tokens": float("nan")}):
            with self.subTest(usage=usage), self.assertRaises(ValueError):
                price(usage)

    def test_invalid_cache_breakdown_rejected(self):
        with self.assertRaises(ValueError):
            price(self.usage(cache_write_tokens_details={"ttl_30m_tokens": 3000, "ttl_12h_tokens": 3000}))
        with self.assertRaises(ValueError):
            price(self.usage(cached_tokens=6000))

    def test_prepare_enforces_shared_output_ceiling_and_standard_tier(self):
        wire, reserve = prepare({"model": MODEL, "input": "reply OK", "max_output_tokens": 32000})
        body = json.loads(wire)
        self.assertEqual(body["max_output_tokens"], OUTPUT_CAP)
        self.assertEqual(body["service_tier"], "default")
        self.assertFalse(body["store"])
        self.assertGreater(reserve, OUTPUT_CAP * 10 / 1_000_000)

    def test_title_ceiling_is_not_expanded(self):
        wire, _ = prepare({"model": MODEL, "input": "title", "max_output_tokens": 512})
        self.assertEqual(json.loads(wire)["max_output_tokens"], 512)

    def test_unsupported_billing_context_and_hosted_tools_rejected(self):
        for patch in ({"model": "different"}, {"service_tier": "priority"}, {"previous_response_id": "r"}, {"prompt": "saved"}, {"tools": [{"type": "web_search"}]}, {"input": [{"type": "input_image", "image_url": "https://example.invalid/x"}]}, {"prompt_cache_options": {"ttl": "12h"}}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                prepare({"model": MODEL, "input": "reply OK", **patch})

    def test_budget_reserves_before_call_and_settles_measured_usage(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root, 5)
            with self.assertRaises(ValueError):
                budget.admit(.5)
            budget.arm("pair-1", 2)
            self.assertEqual(budget.admit(.5), (1, "pair-1"))
            self.assertEqual(json.loads((Path(root) / "status.json").read_text())["reservedUsd"], .5)
            with self.assertRaises(ValueError):
                budget.admit(.5)
            budget.settle({"measuredUsd": .02}, .5)
            self.assertAlmostEqual(budget.spent, .02)
            self.assertEqual(budget.admit(.5), (2, "pair-1"))
            budget.settle({"measuredUsd": .03}, .5)
            with self.assertRaises(ValueError):
                budget.admit(.5)
            self.assertAlmostEqual(budget.spent, .05)
            self.assertAlmostEqual(budget.reserved, 0)

    def test_missing_receipt_halts_and_keeps_reservation(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root, 5)
            budget.arm("pair-1", 2)
            budget.admit(.5)
            budget.settle({"measuredUsd": None}, .5)
            self.assertAlmostEqual(budget.reserved, .5)
            with self.assertRaises(ValueError):
                budget.admit(.5)
            with self.assertRaises(ValueError):
                budget.arm("pair-2", 2)

    def test_admission_refuses_over_budget_and_restart_reset(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root, 5)
            budget.arm("pair-1", 2)
            with self.assertRaises(ValueError):
                budget.admit(5.01)
            with self.assertRaises(ValueError):
                Budget(root, 5)

    def test_disarm_during_active_call_blocks_late_requests(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root, 5)
            budget.arm("pair-1", 6)
            budget.admit(.5)
            self.assertEqual(budget.disarm()["batchCallsRemaining"], 0)
            budget.settle({"measuredUsd": .02}, .5)
            with self.assertRaises(ValueError):
                budget.admit(.5)

    def test_stored_references_rejected(self):
        with self.assertRaises(ValueError):
            prepare({"model": MODEL, "input": [{"type": "item_reference", "id": "saved"}]})


if __name__ == "__main__":
    unittest.main()
