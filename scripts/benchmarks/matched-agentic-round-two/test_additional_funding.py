"""Additional-round financial controls; scripted callbacks, no paid/provider runtime."""
import copy
import tempfile
from pathlib import Path
import unittest

from funding_profiles import (ADDITIONAL_PHASE, ADDITIONAL_PLAN_SHA256, ADDITIONAL_ACTOR_BASELINES,
                              ADDITIONAL_ACTOR_CAPS, ADDITIONAL_LIABILITIES, ADDITIONAL_HISTORY_HASHES,
                              ADDITIONAL_REQUEST_SHA256, funding_policy)
from native_team_policy import PolicyError
from owned_team_witness import healthy, financial_headroom, OwnedSupervisor
from paired_runner import affordability
from role_graph import HEAVY_ROLES, HEAVY_ROLE_PARENTS
from test_owned_witness import native_fixture, body, headers


def state(vector=0.0, codex=0.0, reserved=0.0, actor="foundry-codex", calls=None):
    spent = vector + codex
    calls = int(spent > 0 or reserved > 0) if calls is None else calls
    value = {"limitUsd": 55.309095, "phaseID": ADDITIONAL_PHASE, "phasePlanSha256": ADDITIONAL_PLAN_SHA256,
        "halted": None, "measuredUsd": 29.579095 + spent, "reservedUsd": reserved,
        "active": int(reserved > 0), "attempts": 1340 + calls, "batchCallsRemaining": 0,
        "historicalLiabilityUsd": 5.73, "carriedUnresolvedRequestCount": 1,
        "historicalUncertaintyRemains": True, "allHistoricalAdmissionsSettled": False,
        "historicalKnownMeasuredUsd": 29.579095, "historicalAttempts": 1340,
        "historicalLatestAdmittedSeq": 1340, "historicalLedgerSha256": dict(ADDITIONAL_HISTORY_HASHES),
        "carriedUnresolvedRequestSha256": ADDITIONAL_REQUEST_SHA256,
        "newRoundLimitUsd": 20, "newRoundMeasuredUsd": spent, "newRoundReservedUsd": reserved,
        "newRoundAttempts": calls, "cumulativeUpperExposureUsd": 35.309095 + spent + reserved,
        "remainingAdmissionUsd": 20 - spent - reserved, "actors": {}}
    for name, baseline in ADDITIONAL_ACTOR_BASELINES.items():
        measured = baseline + (vector if name == "foundry-vector" else codex if name == "foundry-codex" else 0)
        held = ADDITIONAL_LIABILITIES.get(name, 0)
        pending = reserved if name == actor else 0
        value["actors"][name] = {"limitUsd": ADDITIONAL_ACTOR_CAPS[name], "measuredUsd": measured,
            "reservedUsd": pending, "historicalLiabilityUsd": held, "upperExposureUsd": measured + pending + held}
    return value


class Controller:
    def __init__(self, initial=None):
        self.value = state() if initial is None else initial
        self.calls, self.receipts = [], []

    def __call__(self, path, payload=None):
        self.calls.append(path)
        if path == "/control":
            self.value["batchCallsRemaining"] = payload["calls"]
            return {"requestToken": "synthetic-local-current-round-token"}
        if path == "/disarm":
            self.value["batchCallsRemaining"] = 0
        return copy.deepcopy(self.value)


class AdditionalFinancialControls(unittest.TestCase):
    def test_idle_current_round_keeps_protected_old_hold(self):
        original = state()
        self.assertIs(healthy(original, idle=True, funding_profile=ADDITIONAL_PHASE), original)
        self.assertEqual(original, state())
        self.assertEqual(funding_policy(ADDITIONAL_PHASE).repair_threshold_usd, 13.84808545)
        for actor in ("foundry-vector", "foundry-codex"):
            global_left, actor_left = financial_headroom(original, actor, ADDITIONAL_PHASE)
            self.assertAlmostEqual(global_left, 20)
            self.assertAlmostEqual(actor_left, 20)

    def test_forged_round_history_amounts_anchors_and_waivers_are_rejected(self):
        mutations = [lambda s: s.update(limitUsd=56), lambda s: s.update(phaseID="old"),
            lambda s: s.update(phasePlanSha256="0" * 64), lambda s: s.update(halted="unknown"),
            lambda s: s.update(historicalLiabilityUsd=0), lambda s: s.update(carriedUnresolvedRequestCount=0),
            lambda s: s.update(carriedUnresolvedRequestCount=True), lambda s: s.update(historicalUncertaintyRemains=False),
            lambda s: s.update(allHistoricalAdmissionsSettled=True), lambda s: s.update(historicalKnownMeasuredUsd=29),
            lambda s: s.update(historicalAttempts=1339), lambda s: s.update(historicalLatestAdmittedSeq=1339),
            lambda s: s.update(historicalLedgerSha256={}), lambda s: s.update(carriedUnresolvedRequestSha256="0" * 64),
            lambda s: s.update(newRoundLimitUsd=21), lambda s: s.update(newRoundMeasuredUsd=-1),
            lambda s: s.update(newRoundMeasuredUsd=float("nan")), lambda s: s.update(newRoundReservedUsd=1),
            lambda s: s.update(attempts=1339), lambda s: s.update(newRoundAttempts=True),
            lambda s: s.update(newRoundAttempts=1), lambda s: s.update(active=-1),
            lambda s: s.update(cumulativeUpperExposureUsd=29.579095), lambda s: s.update(remainingAdmissionUsd=25),
            lambda s: s["actors"]["foundry-codex"].update(historicalLiabilityUsd=0),
            lambda s: s["actors"]["foundry-vector"].update(limitUsd=40),
            lambda s: s["actors"]["diagnostics"].update(limitUsd=1),
            lambda s: s["actors"]["foundry-vector"].update(measuredUsd=17),
            lambda s: s["actors"]["foundry-codex"].update(upperExposureUsd=8.9592263)]
        for mutate in mutations:
            value = state()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(PolicyError):
                healthy(value, funding_profile=ADDITIONAL_PHASE)

    def test_current_reservation_and_shared_20_limit_are_binding(self):
        live = state(reserved=5.73)
        healthy(live, funding_profile=ADDITIONAL_PHASE)
        with self.assertRaises(PolicyError):
            healthy(live, idle=True, funding_profile=ADDITIONAL_PHASE)
        with self.assertRaises(PolicyError):
            healthy(state(vector=10, codex=5, reserved=5.73), funding_profile=ADDITIONAL_PHASE)
        small = state(vector=10, codex=9)
        healthy(small, idle=True, funding_profile=ADDITIONAL_PHASE)
        self.assertAlmostEqual(financial_headroom(small, "foundry-codex", ADDITIONAL_PHASE)[0], 1)
        self.assertFalse(affordability(small, "codex", ADDITIONAL_PHASE)["affordable"])

    def test_round_and_actor_counters_cannot_rewind(self):
        before = state(vector=1, codex=1, calls=2)
        for after in [state(vector=.9, codex=1.1, calls=3), state(vector=1, codex=.9, calls=3),
                      state(vector=1, codex=1, calls=1)]:
            with self.subTest(after=after), self.assertRaises(PolicyError):
                healthy(after, before, funding_profile=ADDITIONAL_PHASE)

    def test_real_supervisor_rejects_forged_state_before_control_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = native_fixture(home / "home")
            registry.max_depth = 2
            changed = state(); changed["historicalLiabilityUsd"] = 0
            controller = Controller(changed)
            supervisor = OwnedSupervisor(controller, lambda: [], home / "out", quiesced=lambda: True,
                                         funding_profile=ADDITIONAL_PHASE)
            with self.assertRaises(PolicyError):
                supervisor.begin("codex", "synthetic-additional", registry, HEAVY_ROLES,
                                 role_parents=HEAVY_ROLE_PARENTS, soft_usd=13.84808545)
            self.assertNotIn("/control", controller.calls)

    def test_native_identity_and_new_seq_receipt_join_close_only_new_owned_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            registry = native_fixture(home / "home")
            registry.max_depth = 2
            controller = Controller()
            supervisor = OwnedSupervisor(controller, lambda: controller.receipts, home / "out", quiesced=lambda: True,
                                         funding_profile=ADDITIONAL_PHASE)
            arm = supervisor.begin("codex", "synthetic-additional", registry, HEAVY_ROLES,
                                   role_parents=HEAVY_ROLE_PARENTS, soft_usd=13.84808545)
            wire, entry = arm.enter(body(), headers(), lambda: False)
            controller.value = state(codex=.01, calls=1)
            controller.value["batchCallsRemaining"] = 299
            controller.receipts = [{"seq": 1341, "actor": "foundry-codex", "label": arm.label,
                "batchSha256": arm.batch_digest, "requestSha256": entry["requestSha256"], "measuredUsd": .01}]
            arm.finish(entry, {"object": "response", "status": "completed", "usage": {"input_tokens": 1,
                "output_tokens": 1, "total_tokens": 2}}, False, False)
            result = supervisor.close(timeout=1)
            self.assertTrue(result["settlementComplete"])
            self.assertEqual(result["providerRequests"], 1)
            self.assertAlmostEqual(result["measuredUsd"], .01)
            self.assertEqual(result["settlementScope"], "current_owned_arm_only")
            self.assertTrue(result["historicalUncertaintyRemains"])
            self.assertFalse(result["allHistoricalAdmissionsSettled"])
            self.assertEqual(result["historicalLiabilityUsd"], 5.73)
            self.assertEqual(controller.value["historicalLiabilityUsd"], 5.73)
            self.assertTrue(arm.retired)


if __name__ == "__main__":
    unittest.main()
