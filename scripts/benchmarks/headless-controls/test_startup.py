"""Startup versus actual-call admission; all status and identities synthetic.

No socket, native runtime, key, controller service or provider is used. Actual
OwnedArm.enter is the unchanged before-upstream conservative reservation gate.
"""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "matched-headless-stage"))
from funding_profiles import CARRY_PHASE
import heavy_runner
from native_registry import NativeRegistry
from native_team_policy import MODEL, PolicyError
from owned_team_witness import OwnedSupervisor, reservation_bound
from paired_runner import FULL_RESERVATION_USD, affordability, coordinate_team_arm
from test_owned_witness import body, headers, native_fixture
from test_carry import state


class Controller:
    def __init__(self, initial):
        self.value = initial
        self.routes = []

    def __call__(self, route, value=None):
        self.routes.append(route)
        if route == "/control":
            self.value["batchCallsRemaining"] = value["calls"]
            return {"requestToken": "synthetic-startup-only-token"}
        if route == "/disarm":
            self.value["batchCallsRemaining"] = 0
        return copy.deepcopy(self.value)


class StartupControls(unittest.TestCase):
    def limited(self, remaining=1.5):
        return state(vector=16.9686436 - remaining)

    def registry(self, root, runtime):
        if runtime == "codex":
            registry = native_fixture(root)
            registry.max_depth = 2
            return registry, headers()
        root.mkdir()
        database = root / "vector.db"
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-root", None, None, "build",
                json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"}), None))
        connection.close()
        return NativeRegistry("vector", root, database, "ses-root", "openai", max_depth=2), {"X-Session-Id": "ses-root"}

    def test_default_requires_maximum_but_explicit_per_request_is_symmetric(self):
        for runtime in ("vector", "codex"):
            value = self.limited()
            before = copy.deepcopy(value)
            self.assertFalse(affordability(value, runtime, CARRY_PHASE)["affordable"])
            result = affordability(value, runtime, CARRY_PHASE, startup_mode="per-request")
            self.assertTrue(result["affordable"])
            self.assertEqual(result["startupAffordabilityMode"], "per-request")
            self.assertTrue(result["startupMaximumRequestCheckDeferred"])
            self.assertFalse(result["startupReservesMoney"])
            self.assertEqual(result["maximumRequestReservationBoundUsd"], 5.73)
            self.assertEqual(result["requiredFullQualityReservationUsd"], 5.73)
            self.assertEqual(value, before)

    def test_headless_coordinator_uses_explicit_mode_before_prepare_without_spending(self):
        for runtime in ("vector", "codex"):
            for mode in ("maximum-request", "per-request"):
                prepared = []
                def prepare():
                    prepared.append(True)
                    raise RuntimeError("synthetic prepare boundary; no runtime launched")
                controller = Controller(self.limited())
                result = coordinate_team_arm(supervisor=SimpleNamespace(controller=controller, funding_profile=CARRY_PHASE),
                    runtime=runtime, label="synthetic-startup", adapter=SimpleNamespace(prepare=prepare),
                    task={"expectedBrowserChecks": 0}, common=None, check_frozen=lambda: None,
                    persist=lambda value: None, profile=heavy_runner.PROFILE, startup_mode=mode)
                self.assertEqual(bool(prepared), mode == "per-request")
                self.assertNotIn("/control", controller.routes)
                self.assertEqual(result["preflight"]["startupAffordabilityMode"], mode)

    def test_opt_in_does_not_apply_to_ui_or_non_seven_role_profile(self):
        for task, profile in (({"expectedBrowserChecks": 1}, heavy_runner.PROFILE),
                              ({"expectedBrowserChecks": 0}, {**heavy_runner.PROFILE, "nativeAutonomousIdentities": 4})):
            with self.assertRaises(PolicyError):
                coordinate_team_arm(supervisor=None, runtime="codex", label="synthetic-startup", adapter=None,
                    task=task, common=None, check_frozen=lambda: None, persist=lambda value: None,
                    profile=profile, startup_mode="per-request")

    def test_real_gate_admits_adequate_text_without_reducing_model_or_output(self):
        for runtime in ("vector", "codex"):
            with self.subTest(runtime=runtime), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                registry, request_headers = self.registry(root / "home", runtime)
                controller = Controller(self.limited())
                supervisor = OwnedSupervisor(controller, lambda: [], root / "out", quiesced=lambda: True,
                                             funding_profile=CARRY_PHASE)
                self.assertTrue(affordability(controller.value, runtime, CARRY_PHASE, "per-request")["affordable"])
                arm = supervisor.begin(runtime, "synthetic-startup", registry, heavy_runner.PROFILE["childLifetimeSlots"],
                    role_parents=heavy_runner.PROFILE["roleParents"], soft_usd=13.84808545)
                before = copy.deepcopy(controller.value)
                wire, entry = arm.enter(body(), request_headers, lambda: False)
                request = json.loads(wire)
                bound = reservation_bound(request, wire)
                self.assertLess(bound, 1.5)
                self.assertGreater(bound, 0)
                self.assertEqual(request["model"], MODEL)
                self.assertEqual(request["reasoning"]["effort"], "high")
                self.assertEqual(request["max_output_tokens"], 32000)
                self.assertEqual(controller.value, before)
                self.assertEqual(len(arm.requests), 1)
                self.assertFalse(entry["upstreamTerminal"])
                self.assertEqual(controller.routes.count("/control"), 1)

    def test_insufficient_text_and_full_image_bounds_refused_before_any_provider(self):
        for runtime in ("vector", "codex"):
            for image in (False, True):
                with self.subTest(runtime=runtime, image=image), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder)
                    registry, request_headers = self.registry(root / "home", runtime)
                    controller = Controller(self.limited())
                    supervisor = OwnedSupervisor(controller, lambda: [], root / "out", quiesced=lambda: True,
                                                 funding_profile=CARRY_PHASE)
                    arm = supervisor.begin(runtime, "synthetic-startup", registry, heavy_runner.PROFILE["childLifetimeSlots"],
                        role_parents=heavy_runner.PROFILE["roleParents"], soft_usd=13.84808545)
                    request = body()
                    request["input"][1]["content"] = ([{"type": "input_image", "image_url": "data:image/png;base64,synthetic"}]
                                                       if image else "x" * 300000)
                    _, wire, bound = arm.validated_request(request, request_headers)
                    self.assertGreater(bound, 1.5)
                    if image:
                        self.assertEqual(bound, FULL_RESERVATION_USD)
                    provider_calls = []
                    with self.assertRaises(PolicyError):
                        wire, _ = arm.enter(request, request_headers, lambda: False)
                        provider_calls.append(wire)
                    self.assertEqual(provider_calls, [])
                    self.assertEqual(arm.requests, [])
                    self.assertEqual(controller.value["historicalLiabilityUsd"], 7.177765)

    def test_no_zero_negative_nan_or_unreviewed_startup_headroom(self):
        for runtime in ("vector", "codex"):
            zero = self.limited(0)
            zero["remainingAdmissionUsd"] = 0
            self.assertFalse(affordability(zero, runtime, CARRY_PHASE, "per-request")["affordable"])
            with self.assertRaises(PolicyError):
                affordability(self.limited(-0.000000001), runtime, CARRY_PHASE, "per-request")
            unknown = self.limited()
            unknown["measuredUsd"] = float("nan")
            with self.assertRaises(PolicyError):
                affordability(unknown, runtime, CARRY_PHASE, "per-request")
            with self.assertRaises(PolicyError):
                affordability(self.limited(), runtime, CARRY_PHASE, "unreviewed")


if __name__ == "__main__":
    unittest.main()
