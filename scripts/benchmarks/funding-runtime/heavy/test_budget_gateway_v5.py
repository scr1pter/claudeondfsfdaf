"""Synthetic journals only. No live ledger, configuration, server or key."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import budget_gateway_v5 as v5
import test_budget_gateway_v4 as old


def history(root):
    previous = old.history(root)
    with old.approved(previous), v5.v4.phase_limits(previous):
        budget = v5.v4.Budget(root, previous)
        for actor in v5.ACTORS:
            old.settle_one(budget, actor)
        historical = dict(budget.actor_spent)
        remaining = (48 - budget.spent) / 2
        prior = Path(root) / v5.v4.ALLOCATION_FILE
        return {"kind": "synthetic-equal-remainder-control", "phaseID": v5.PHASE,
                "authorizedStudyMaximumUsd": 48, "historicalSequence": budget.seq,
                "historicalMeasuredUsd": budget.spent, "historicalActorMeasuredUsd": historical,
                "actorLimitsUsd": {actor: amount + remaining if actor in v5.ACTORS else amount for actor, amount in historical.items()},
                "remainingPerRuntimeUsd": remaining,
                "previousPhasePlanSha256": json.loads(prior.read_bytes())["phasePlanSha256"],
                "previousAllocationSha256": v5.v3.file_hash(prior.read_bytes()),
                "prefix": {name: {"count": len((Path(root) / name).read_bytes().splitlines()),
                                   "sha256": v5.v3.file_hash((Path(root) / name).read_bytes())}
                           for name in ("receipts.jsonl", "admissions-v2.jsonl")}}


def approved(plan):
    # Fixtures replace only the approval digest in this test process. Production
    # has no CLI/config parameter that can replace its source-pinned approval.
    return patch.object(v5, "APPROVED_PLAN_SHA256", v5.v3.file_hash(v5.canonical(plan)))


class RemainderTests(unittest.TestCase):
    def tearDown(self):
        self.assertEqual(v5.v2.ACTOR_LIMITS, old.ORIGINAL_LIMITS)
        self.assertIs(v5.v2.ACTOR_LIMITS, v5.v3.ACTOR_LIMITS)

    def test_real_plan_keeps_48_history_and_exact_equal_remaining_allowances(self):
        plan = v5.load_plan(Path(v5.__file__).parents[1] / "heavy-phase-plan.json")
        self.assertEqual(plan["historicalSequence"], 889)
        self.assertEqual(plan["historicalMeasuredUsd"], 20.3038291)
        self.assertEqual(plan["actorLimitsUsd"]["foundry-vector"], 24.73654725)
        self.assertEqual(plan["actorLimitsUsd"]["foundry-codex"], 20.31968465)
        self.assertAlmostEqual(math.fsum(plan["actorLimitsUsd"].values()), 48)
        for actor in v5.ACTORS:
            self.assertAlmostEqual(plan["actorLimitsUsd"][actor] - plan["historicalActorMeasuredUsd"][actor], 13.84808545)
        self.assertIs(v5.v4.handler, v5.v3.handler)
        self.assertIs(v5.v4.prepare, v5.v3.prepare)
        self.assertIs(v5.v4.price, v5.v3.price)

    def test_changed_cap_or_history_is_not_a_new_authorization(self):
        original = v5.load_plan(Path(v5.__file__).parents[1] / "heavy-phase-plan.json")
        for field in ("authorizedStudyMaximumUsd", "historicalSequence", "historicalMeasuredUsd"):
            plan = copy.deepcopy(original)
            plan[field] += 1
            with self.subTest(field=field), self.assertRaises(ValueError):
                v5.validate_plan(plan)
        plan = copy.deepcopy(original)
        plan["actorLimitsUsd"]["foundry-vector"] += 1
        with self.assertRaises(ValueError), v5.phase_limits(plan):
            self.fail("changed allocation admitted")

    def test_context_restores_policy_and_budget_cannot_escape_it(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan):
                with self.assertRaises(RuntimeError), v5.phase_limits(plan):
                    budget = v5.Budget(root, plan)
                    raise RuntimeError("synthetic failure")
                with self.assertRaises(ValueError):
                    budget.status()

    def test_transition_does_not_rewrite_history_snapshot_or_previous_audit(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            names = (*plan["prefix"], "status.json", v5.v4.ALLOCATION_FILE)
            before = {name: (Path(root) / name).read_bytes() for name in names}
            with approved(plan), v5.phase_limits(plan):
                budget = v5.Budget(root, plan)
                self.assertEqual(budget.seq, 5)
                self.assertAlmostEqual(budget.spent, 5 * old.ACTUAL)
                self.assertEqual(before, {name: (Path(root) / name).read_bytes() for name in names})
                status = budget.status()
                self.assertEqual(status["phaseID"], v5.PHASE)
                self.assertEqual(status["phasePlanSha256"], v5.APPROVED_PLAN_SHA256)
                self.assertEqual(status["batchCallsRemaining"], 0)
                self.assertTrue((Path(root) / v5.ALLOCATION_FILE).is_file())

    def test_sealed_actors_cannot_arm_and_reservations_obey_remaining_cap(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v5.phase_limits(plan):
                budget = v5.Budget(root, plan)
                for actor in v5.v4.OLD_ACTORS:
                    with self.assertRaises(v5.v2.AdmissionError):
                        budget.arm(actor, "sealed", 1)
                token = budget.arm(v5.ACTORS[0], "synthetic-heavy", 2)["requestToken"]
                with self.assertRaises(v5.v2.AdmissionError):
                    budget.admit(token, plan["remainingPerRuntimeUsd"] + .01, {})
                budget.admit(token, plan["remainingPerRuntimeUsd"], {})
                self.assertAlmostEqual(budget.reserved, plan["remainingPerRuntimeUsd"])
                self.assertLessEqual(budget.spent + budget.reserved, 48)

    def test_unsettled_admission_never_releases_on_restart(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v5.phase_limits(plan):
                budget = v5.Budget(root, plan)
                token = budget.arm(v5.ACTORS[0], "pending", 1)["requestToken"]
                budget.admit(token, 1, {"model": v5.v3.MODEL, "rates": v5.v3.RATES})
                with self.assertRaisesRegex(ValueError, "unmatched durable admission"):
                    v5.Budget(root, plan)

    def test_later_settlement_restart_keeps_every_price_sequence_and_prefix(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v5.phase_limits(plan):
                budget = v5.Budget(root, plan)
                audit = (Path(root) / v5.ALLOCATION_FILE).read_bytes()
                for actor in v5.ACTORS:
                    old.settle_one(budget, actor)
                before = {name: (Path(root) / name).read_bytes() for name in plan["prefix"]}
                resumed = v5.Budget(root, plan)
                self.assertEqual(resumed.seq, 7)
                self.assertAlmostEqual(resumed.spent, 7 * old.ACTUAL)
                self.assertEqual(before, {name: (Path(root) / name).read_bytes() for name in before})
                self.assertEqual(audit, (Path(root) / v5.ALLOCATION_FILE).read_bytes())
                self.assertEqual(v5.v3.audit_ledger(root)["verifiedProviderPrices"], 7)

    def test_missing_or_changed_allocation_after_later_history_is_refused(self):
        for mode in ("missing", "changed"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                plan = history(root)
                with approved(plan), v5.phase_limits(plan):
                    budget = v5.Budget(root, plan)
                    old.settle_one(budget, v5.ACTORS[0])
                    path = Path(root) / v5.ALLOCATION_FILE
                    if mode == "missing":
                        path.unlink()
                    else:
                        value = json.loads(path.read_bytes())
                        value["ownerStudyMaximumUnchanged"] = 49
                        path.write_bytes(v5.canonical(value))
                    with self.assertRaises(ValueError):
                        v5.Budget(root, plan)

    def test_tampered_truncated_or_partial_prefix_never_creates_allocation(self):
        for mode in ("tampered", "truncated", "partial"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                plan = history(root)
                path = Path(root) / "receipts.jsonl"
                data = path.read_bytes()
                path.write_bytes(data.replace(b'"default"', b'"standard"', 1) if mode == "tampered"
                                 else data.splitlines(keepends=True)[0] if mode == "truncated" else data + b'{')
                with approved(plan), v5.phase_limits(plan), self.assertRaises(ValueError):
                    v5.Budget(root, plan)
                self.assertFalse((Path(root) / v5.ALLOCATION_FILE).exists())

    def test_changed_prior_durable_allocation_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            (Path(root) / v5.v4.ALLOCATION_FILE).write_text('{}')
            with approved(plan), v5.phase_limits(plan), self.assertRaises(ValueError):
                v5.Budget(root, plan)


if __name__ == "__main__":
    unittest.main()
