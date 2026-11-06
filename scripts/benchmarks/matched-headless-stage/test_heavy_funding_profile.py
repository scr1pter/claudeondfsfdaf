"""Pure approved-allocation controls; no real controller/configuration/ledger."""
import copy
import unittest

from funding_profiles import BASELINE_PHASE, HEAVY_PHASE, HEAVY_PLAN_SHA256, funding_policy
from native_team_policy import PolicyError
from owned_team_witness import healthy


def state():
    return {"limitUsd": 48, "phaseID": HEAVY_PHASE, "phasePlanSha256": HEAVY_PLAN_SHA256, "halted": None,
            "measuredUsd": 20.3038291, "reservedUsd": 0, "active": 0, "attempts": 889,
            "actors": {"foundry-vector": {"limitUsd": 24.73654725, "measuredUsd": 10.8884618, "reservedUsd": 0},
                       "foundry-codex": {"limitUsd": 20.31968465, "measuredUsd": 6.4715992, "reservedUsd": 0},
                       "synthetic-sealed-history": {"limitUsd": 2.9437681, "measuredUsd": 2.9437681, "reservedUsd": 0}}}


class HeavyFundingProfileTests(unittest.TestCase):
    def test_accumulated_receipt_roundoff_preserves_floor_but_material_rewind_fails(self):
        observed = state()
        observed["measuredUsd"] = 20.303829099999998
        observed["actors"]["foundry-vector"]["measuredUsd"] = 10.888461799999998
        observed["actors"]["foundry-codex"]["measuredUsd"] = 6.471599199999997
        observed["actors"]["synthetic-sealed-history"]["measuredUsd"] = 2.9437680999999995
        self.assertIs(healthy(observed, idle=True, funding_profile=HEAVY_PHASE), observed)
        for actor in (None, "foundry-vector", "foundry-codex"):
            changed = copy.deepcopy(observed)
            target = changed if actor is None else changed["actors"][actor]
            target["measuredUsd"] -= 0.000001
            reason = "global funding state invalid" if actor is None else "heavy actor history rewound"
            with self.subTest(actor=actor), self.assertRaisesRegex(PolicyError, reason):
                healthy(changed, idle=True, funding_profile=HEAVY_PHASE)

    def test_exact_approved_phase_retains_every_prior_charge_and_equal_remaining_allocations(self):
        approved = healthy(state(), idle=True, funding_profile=HEAVY_PHASE)
        remaining = [approved["actors"][actor]["limitUsd"] - approved["actors"][actor]["measuredUsd"] for actor in ("foundry-vector", "foundry-codex")]
        self.assertAlmostEqual(remaining[0], 13.84808545)
        self.assertAlmostEqual(remaining[0], remaining[1])
        self.assertAlmostEqual(sum(remaining), 48 - approved["measuredUsd"])

    def test_default_old_phase_cannot_silently_accept_new_allocation(self):
        with self.assertRaises(PolicyError):
            healthy(state())
        self.assertEqual(funding_policy().phase, BASELINE_PHASE)
        self.assertEqual(funding_policy().actor_cap("foundry-vector"), 20)
        self.assertEqual(funding_policy().actor_cap("foundry-codex"), 20)

    def test_heavy_phase_cannot_accept_old_policy_or_arbitrary_profile(self):
        changed = state(); changed["phaseID"] = BASELINE_PHASE
        with self.assertRaises(PolicyError):
            healthy(changed, funding_profile=HEAVY_PHASE)
        with self.assertRaises(PolicyError):
            funding_policy("unapproved-larger-study")

    def test_plan_hash_and_exact_caps_cannot_expand(self):
        for field in ("plan", "vector", "codex", "global"):
            with self.subTest(field=field):
                changed = state()
                if field == "plan": changed["phasePlanSha256"] = "0" * 64
                if field == "vector": changed["actors"]["foundry-vector"]["limitUsd"] += 0.01
                if field == "codex": changed["actors"]["foundry-codex"]["limitUsd"] += 0.01
                if field == "global": changed["limitUsd"] = 49
                with self.assertRaises(PolicyError):
                    healthy(changed, funding_profile=HEAVY_PHASE)

    def test_sealed_historical_actors_cannot_receive_new_budget_or_lose_charges(self):
        for field, value in (("limitUsd", 3), ("reservedUsd", 0.01), ("measuredUsd", 2.9)):
            with self.subTest(field=field):
                changed = state(); changed["actors"]["synthetic-sealed-history"][field] = value
                with self.assertRaises(PolicyError):
                    healthy(changed, funding_profile=HEAVY_PHASE)

    def test_request_and_actor_histories_cannot_rewind(self):
        for field in ("attempts", "measuredUsd", "vector", "codex"):
            with self.subTest(field=field):
                changed = state()
                if field == "attempts": changed["attempts"] = 888
                if field == "measuredUsd": changed["measuredUsd"] = 20.30
                if field == "vector": changed["actors"]["foundry-vector"]["measuredUsd"] -= 0.01
                if field == "codex": changed["actors"]["foundry-codex"]["measuredUsd"] -= 0.01
                with self.assertRaises(PolicyError):
                    healthy(changed, funding_profile=HEAVY_PHASE)

    def test_global_and_actor_totals_must_reconcile(self):
        changed = copy.deepcopy(state()); changed["measuredUsd"] += 0.01
        with self.assertRaises(PolicyError):
            healthy(changed, funding_profile=HEAVY_PHASE)


if __name__ == "__main__":
    unittest.main()
