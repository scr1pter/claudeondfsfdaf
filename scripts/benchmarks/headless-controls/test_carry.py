"""Synthetic carry-phase status controls; no service, credential or provider."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "matched-headless-stage"))
from funding_profiles import CARRY_PHASE, CARRY_PLAN, CARRY_PLAN_SHA256
from native_team_policy import PolicyError
from owned_team_witness import financial_headroom, healthy


def state(vector=0.0, codex=0.0, reserved=0.0, calls=None):
    plan = CARRY_PLAN
    calls = int(vector > 0 or codex > 0 or reserved > 0) if calls is None else calls
    measured = plan["historicalKnownMeasuredUsd"] + vector + codex
    result = {"limitUsd": 55.309095, "phaseID": CARRY_PHASE, "phasePlanSha256": CARRY_PLAN_SHA256,
        "halted": None, "measuredUsd": measured, "reservedUsd": reserved, "active": int(reserved > 0),
        "attempts": 1419 + calls, "batchCallsRemaining": 0, "historicalLiabilityUsd": 7.177765,
        "carriedUnresolvedRequestCount": 2, "historicalUncertaintyRemains": True, "allHistoricalAdmissionsSettled": False,
        "carriedUnsettled": copy.deepcopy(plan["carriedUnsettled"]), "historicalKnownMeasuredUsd": 31.1626864,
        "originalHistoricalKnownMeasuredUsd": 29.579095, "historicalAttempts": 1419, "historicalLatestAdmittedSeq": 1419,
        "remainingAdditionalExposureUsd": 16.9686436, "allCurrentRoundAdmissionsSettled": reserved == 0,
        "newRoundLimitUsd": 20, "newRoundMeasuredUsd": 1.5835914 + vector + codex, "newRoundReservedUsd": reserved,
        "newRoundExposureUsd": 1.5835914 + vector + codex + reserved + 1.447765,
        "newRoundAttempts": 79 + calls, "currentPhaseAttempts": calls,
        "cumulativeUpperExposureUsd": measured + reserved + 7.177765,
        "remainingAdmissionUsd": 55.309095 - measured - reserved - 7.177765, "actors": {}}
    for actor, baseline in plan["historicalActorMeasuredUsd"].items():
        amount = baseline + (vector if actor == "foundry-vector" else codex if actor == "foundry-codex" else 0)
        hold = sum(row["reservedUsd"] for row in plan["carriedUnsettled"] if row["actor"] == actor)
        pending = reserved if actor == "foundry-codex" else 0
        result["actors"][actor] = {"limitUsd": plan["actorLimitsUsd"][actor], "measuredUsd": amount,
            "reservedUsd": pending, "historicalLiabilityUsd": hold, "upperExposureUsd": amount + pending + hold}
    return result


class CarryControls(unittest.TestCase):
    def test_idle_current_phase_keeps_both_liabilities_and_original_spend(self):
        original = state()
        self.assertIs(healthy(original, idle=True, funding_profile=CARRY_PHASE), original)
        self.assertEqual(original, state())
        for actor in ("foundry-vector", "foundry-codex"):
            global_left, actor_left = financial_headroom(original, actor, CARRY_PHASE)
            self.assertAlmostEqual(global_left, 16.9686436)
            self.assertGreaterEqual(actor_left, global_left)

    def test_earlier_spend_or_either_unknown_cannot_be_dropped_or_relabelled(self):
        mutations = [lambda s: s.update(phaseID="other"), lambda s: s.update(phasePlanSha256="0" * 64),
            lambda s: s.update(limitUsd=56), lambda s: s.update(newRoundLimitUsd=21),
            lambda s: s.update(halted="unknown"), lambda s: s.update(carriedUnresolvedRequestCount=1),
            lambda s: s.update(carriedUnresolvedRequestCount=True), lambda s: s.update(carriedUnsettled=[]),
            lambda s: s["carriedUnsettled"][0].update(reservedUsd=0), lambda s: s["carriedUnsettled"][1].update(reservedUsd=0),
            lambda s: s.update(historicalLiabilityUsd=5.73), lambda s: s.update(allHistoricalAdmissionsSettled=True),
            lambda s: s.update(historicalUncertaintyRemains=False), lambda s: s.update(historicalKnownMeasuredUsd=29.579095),
            lambda s: s.update(originalHistoricalKnownMeasuredUsd=31.1626864), lambda s: s.update(newRoundMeasuredUsd=0),
            lambda s: s.update(newRoundExposureUsd=1.5835914), lambda s: s.update(remainingAdditionalExposureUsd=20),
            lambda s: s.update(currentPhaseAttempts=-1), lambda s: s.update(newRoundAttempts=0),
            lambda s: s.update(active=True), lambda s: s.update(remainingAdmissionUsd=20),
            lambda s: s["actors"]["foundry-codex"].update(historicalLiabilityUsd=5.73),
            lambda s: s["actors"]["foundry-vector"].update(limitUsd=40),
            lambda s: s["actors"]["diagnostics"].update(measuredUsd=0)]
        for mutate in mutations:
            value = state()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(PolicyError):
                healthy(value, funding_profile=CARRY_PHASE)

    def test_current_reservations_and_total_20_exposure_remain_binding(self):
        current = state(vector=3, codex=2, reserved=1)
        healthy(current, funding_profile=CARRY_PHASE)
        self.assertAlmostEqual(financial_headroom(current, "foundry-codex", CARRY_PHASE)[0], 10.9686436)
        with self.assertRaises(PolicyError):
            healthy(current, idle=True, funding_profile=CARRY_PHASE)
        with self.assertRaises(PolicyError):
            healthy(state(vector=16.968644), funding_profile=CARRY_PHASE)

    def test_history_cannot_rewind_and_idle_does_not_claim_all_history_settled(self):
        before = state(vector=1, calls=3)
        after = state(vector=2, calls=4)
        healthy(after, before=before, idle=True, funding_profile=CARRY_PHASE)
        self.assertFalse(after["allHistoricalAdmissionsSettled"])
        with self.assertRaises(PolicyError):
            healthy(before, before=after, funding_profile=CARRY_PHASE)
        after["allCurrentRoundAdmissionsSettled"] = False
        with self.assertRaises(PolicyError):
            healthy(after, idle=True, funding_profile=CARRY_PHASE)


if __name__ == "__main__":
    unittest.main()
