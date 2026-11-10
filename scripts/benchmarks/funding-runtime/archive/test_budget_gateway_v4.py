"""Offline v4 phase controls. Synthetic journals only; no provider/key calls."""
import json
import math
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch

import budget_gateway_v2 as v2
import budget_gateway_v3 as v3
import budget_gateway_v4 as v4

USAGE = {"input_tokens": 100, "output_tokens": 10,
         "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 100}}
ACTUAL = v3.price(USAGE)
ORIGINAL_LIMITS = {"diagnostics": 8.0, "saas-vector": 20.0, "saas-codex": 20.0}


def settle_one(budget, actor):
    token = budget.arm(actor, "synthetic-phase-control", 2)["requestToken"]
    admission = budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
    budget.settle(admission["seq"], {"usage": USAGE, "measuredUsd": ACTUAL, "serviceTier": "default"})
    budget.disarm(token)
    return admission


def history(directory):
    budget = v3.Budget(directory)
    for actor in v4.OLD_ACTORS:
        settle_one(budget, actor)
    old = {actor: budget.actor_spent[actor] for actor in v4.OLD_ACTORS}
    limits = {"diagnostics": 48 - 40 - old["saas-vector"] - old["saas-codex"],
              "saas-vector": old["saas-vector"], "saas-codex": old["saas-codex"],
              "foundry-vector": 20.0, "foundry-codex": 20.0}
    plan = {"kind": "foundry-phase-allocation-v1", "phaseID": "synthetic-foundry-control",
            "authorizedStudyMaximumUsd": 48.0, "historicalSequence": budget.seq,
            "historicalMeasuredUsd": budget.spent, "historicalActorMeasuredUsd": old,
            "actorLimitsUsd": limits, "prefix": {}}
    for name in ("receipts.jsonl", "admissions-v2.jsonl"):
        data = (Path(directory) / name).read_bytes()
        plan["prefix"][name] = {"count": len(data.splitlines()), "sha256": v3.file_hash(data)}
    return plan


def approved(plan):
    # This patches the pinned approval for synthetic fixtures; production has
    # no flag or caller argument capable of changing its approved digest.
    return patch.object(v4, "APPROVED_PLAN_SHA256", v3.file_hash(v4.canonical(plan)))


class PhaseTests(unittest.TestCase):
    def tearDown(self):
        self.assertEqual(v2.ACTOR_LIMITS, ORIGINAL_LIMITS)
        self.assertIs(v2.ACTOR_LIMITS, v3.ACTOR_LIMITS)

    def test_pinned_real_plan_and_transport_preserve_reviewed_limits(self):
        plan = v4.load_plan(Path(v4.__file__).with_name("phase-plan-foundry-v1.json"))
        self.assertEqual(plan["prefix"]["receipts.jsonl"]["count"], 135)
        self.assertEqual(plan["prefix"]["admissions-v2.jsonl"]["count"], 101)
        self.assertEqual(plan["actorLimitsUsd"]["foundry-vector"], 20)
        self.assertEqual(plan["actorLimitsUsd"]["foundry-codex"], 20)
        self.assertAlmostEqual(sum(plan["actorLimitsUsd"].values()), 48)
        self.assertEqual(plan["historicalMeasuredUsd"], 2.9437681)
        self.assertIs(v4.prepare, v3.prepare)
        self.assertIs(v4.handler, v3.handler)
        self.assertIs(v4.price, v3.price)
        self.assertEqual(v2.ACTOR_LIMITS, ORIGINAL_LIMITS)

    def test_altered_plan_cannot_mutate_shared_policy(self):
        plan = v4.load_plan(Path(v4.__file__).with_name("phase-plan-foundry-v1.json"))
        plan["actorLimitsUsd"]["foundry-vector"] = 21
        with self.assertRaises(ValueError), v4.phase_limits(plan):
            self.fail("altered policy entered")

    def test_context_restores_shared_map_on_error_and_budget_cannot_escape(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan):
                with self.assertRaises(RuntimeError), v4.phase_limits(plan):
                    budget = v4.Budget(root, plan)
                    self.assertIs(v2.ACTOR_LIMITS, v3.ACTOR_LIMITS)
                    raise RuntimeError("synthetic context failure")
                with self.assertRaises(ValueError):
                    budget.status()

    def test_transition_records_durable_audit_without_reset_or_rewrite(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            before = {name: (Path(root) / name).read_bytes() for name in (*plan["prefix"], "status.json")}
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                self.assertAlmostEqual(budget.spent, 3 * ACTUAL)
                self.assertEqual(budget.seq, 3)
                for actor in v4.NEW_ACTORS:
                    self.assertEqual(budget.actor_spent[actor], 0)
                    self.assertEqual(budget.status()["actors"][actor]["limitUsd"], 20)
                for actor in v4.OLD_ACTORS[1:]:
                    self.assertEqual(budget.status()["actors"][actor]["limitUsd"], budget.actor_spent[actor])
                self.assertEqual(before, {name: (Path(root) / name).read_bytes() for name in before})
                audit = json.loads((Path(root) / v4.ALLOCATION_FILE).read_bytes())
                self.assertTrue(audit["historicalAmountsRetained"])
                self.assertTrue(audit["historicalActorsRetained"])
                self.assertEqual(audit["ownerStudyMaximumUnchanged"], 48)

    def test_sealed_old_actors_cannot_spend_and_new_actors_each_reserve_twenty(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                for actor in v4.OLD_ACTORS[1:]:
                    token = budget.arm(actor, "sealed", 1)["requestToken"]
                    with self.assertRaises(v4.AdmissionError):
                        budget.admit(token, .0001, {})
                for actor in v4.NEW_ACTORS:
                    token = budget.arm(actor, "fresh", 1)["requestToken"]
                    budget.admit(token, 20, {})
                self.assertEqual(budget.reserved, 40)
                self.assertLessEqual(budget.spent + budget.reserved, 48)

    def test_new_actor_cap_and_global_cap_include_reservations(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                first = budget.arm("foundry-vector", "fresh", 3)["requestToken"]
                with self.assertRaises(v4.AdmissionError):
                    budget.admit(first, 20.01, {})
                budget.admit(first, 20, {})
                # No additional reservation fits this actor; temporary holds
                # must not bypass the cap (avoid the real 60-second wait).
                with patch.object(v2.time, "monotonic", side_effect=[0, 61]), self.assertRaises(v4.AdmissionError):
                    budget.admit(first, .01, {})
                second = budget.arm("foundry-codex", "fresh2", 1)["requestToken"]
                budget.admit(second, 20, {})
                diag = budget.arm("diagnostics", "diagnostic", 1)["requestToken"]
                with self.assertRaises(v4.AdmissionError):
                    budget.admit(diag, 8, {})
                self.assertEqual(budget.reserved, 40)

    def test_restart_accepts_later_rows_and_preserves_prefix_and_all_costs(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                allocation = (Path(root) / v4.ALLOCATION_FILE).read_bytes()
                for actor in v4.NEW_ACTORS:
                    settle_one(budget, actor)
                original = {name: (Path(root) / name).read_bytes() for name in plan["prefix"]}
                resumed = v4.Budget(root, plan)
                self.assertEqual(resumed.seq, 5)
                self.assertAlmostEqual(resumed.spent, 5 * ACTUAL)
                self.assertEqual(resumed.actor_spent["foundry-vector"], ACTUAL)
                self.assertEqual(resumed.actor_spent["foundry-codex"], ACTUAL)
                self.assertEqual(original, {name: (Path(root) / name).read_bytes() for name in original})
                self.assertEqual(allocation, (Path(root) / v4.ALLOCATION_FILE).read_bytes())
                audit = v3.audit_ledger(root)
                self.assertEqual(audit["receiptCount"], 5)
                self.assertEqual(audit["verifiedProviderPrices"], 5)

    def test_prefix_tamper_truncation_and_partial_row_are_rejected(self):
        for mode in ("tamper", "truncate", "partial"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                plan = history(root)
                file = Path(root) / "receipts.jsonl"
                data = file.read_bytes()
                file.write_bytes(data.replace(b'"default"', b'"standard"', 1) if mode == "tamper" else data.splitlines(keepends=True)[0] if mode == "truncate" else data + b'{"unfinished":')
                with approved(plan), v4.phase_limits(plan), self.assertRaises(ValueError):
                    v4.Budget(root, plan)
                self.assertFalse((Path(root) / v4.ALLOCATION_FILE).exists())

    def test_full_price_validation_cannot_be_bypassed_by_matching_prefix_hash(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            file = Path(root) / "receipts.jsonl"
            data = file.read_bytes().replace(b'"output_tokens": 10', b'"output_tokens": 20', 1)
            file.write_bytes(data)
            plan["prefix"]["receipts.jsonl"]["sha256"] = v3.file_hash(data)
            with approved(plan), v4.phase_limits(plan), self.assertRaisesRegex(ValueError, "usage/rate/cost"):
                v4.Budget(root, plan)

    def test_later_history_requires_existing_valid_phase_audit(self):
        for mode in ("missing", "altered"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                plan = history(root)
                with approved(plan), v4.phase_limits(plan):
                    budget = v4.Budget(root, plan)
                    settle_one(budget, "foundry-vector")
                    file = Path(root) / v4.ALLOCATION_FILE
                    if mode == "missing":
                        file.unlink()
                    else:
                        audit = json.loads(file.read_bytes()); audit["ownerStudyMaximumUnchanged"] = 49
                        file.write_bytes(v4.canonical(audit))
                    with self.assertRaises(ValueError):
                        v4.Budget(root, plan)

    def test_unresolved_reservation_cannot_be_released_on_restart(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                token = budget.arm("foundry-vector", "pending", 1)["requestToken"]
                budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
                with self.assertRaisesRegex(ValueError, "unmatched durable admission"):
                    v4.Budget(root, plan, True, "must not release pending provider reservation")

    def test_phase_fsync_failure_prevents_allocation_success(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan), patch.object(v4.os, "fsync", side_effect=OSError(28, "synthetic disk fault")), self.assertRaises(OSError):
                v4.Budget(root, plan)
            self.assertFalse((Path(root) / v4.ALLOCATION_FILE).exists())

    def test_status_stays_pure_with_phase_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            with approved(plan), v4.phase_limits(plan):
                budget = v4.Budget(root, plan)
                with patch.object(Path, "write_text", side_effect=AssertionError("status must not write")), patch.object(v4.os, "replace", side_effect=AssertionError("status must not replace")):
                    status = budget.status()
                self.assertEqual(status["historicalPhaseBoundary"], 3)
                self.assertEqual(status["active"], 0)
                self.assertEqual(status["reservedUsd"], 0)

    @unittest.skipUnless(os.name == "nt", "Windows startup socket ownership")
    def test_occupied_port_refuses_before_budget_or_key_prompt(self):
        with tempfile.TemporaryDirectory() as root, socket.socket() as occupied:
            plan = history(root)
            file = Path(root) / "plan.json"; file.write_bytes(v4.canonical(plan))
            (Path(root) / "owner-budget.json").write_text(json.dumps({"authorizedStudyMaximumUsd": 48}))
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0)); occupied.listen()
            argv = ["budget_gateway_v4.py", "--directory", root, "--phase-plan", str(file), "--port", str(occupied.getsockname()[1])]
            with approved(plan), patch("sys.argv", argv), patch.object(v4.getpass, "getpass") as prompt, patch.object(v4, "Budget") as budget, self.assertRaises(OSError):
                v4.main()
            prompt.assert_not_called(); budget.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows main lifecycle and lock")
    def test_main_keeps_phase_policy_until_active_handler_settles_and_joins(self):
        ready, started, closing, release, settled, finished = [threading.Event() for _ in range(6)]
        servers, errors, socket_timeouts = [], [], []

        class OneRequestServer(v4.OwnedHTTPServer):
            def serve_forever(self):
                servers.append(self)
                ready.set()
                self.handle_request()
                closing.set()

        def synthetic_handler(budget, _unused_synthetic_key, _controller):
            class SettlingHandler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    try:
                        socket_timeouts.append(self.connection.gettimeout())
                        token = budget.arm("foundry-vector", "synthetic-shutdown", 1)["requestToken"]
                        admission = budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
                        started.set()
                        if not release.wait(5):
                            raise TimeoutError("synthetic shutdown settlement was not released")
                        if v2.ACTOR_LIMITS != budget.phase_plan["actorLimitsUsd"]:
                            raise AssertionError("phase policy restored before handler settlement")
                        budget.settle(admission["seq"], {"usage": USAGE, "measuredUsd": ACTUAL, "serviceTier": "default"})
                        budget.disarm(token)
                        settled.set()
                        self.send_response(200)
                        self.send_header("Content-Length", "2")
                        self.end_headers()
                        self.wfile.write(b"ok")
                    except BaseException as error:
                        errors.append(error)
            return SettlingHandler

        with tempfile.TemporaryDirectory() as root:
            plan = history(root)
            file = Path(root) / "plan.json"; file.write_bytes(v4.canonical(plan))
            (Path(root) / "owner-budget.json").write_text(json.dumps({"authorizedStudyMaximumUsd": 48}))
            (Path(root) / "gateway-config.json").write_text(json.dumps({"localToken": "synthetic-controller-only"}))
            argv = ["budget_gateway_v4.py", "--directory", root, "--phase-plan", str(file), "--port", "0"]

            def run_main():
                try:
                    v4.main()
                except BaseException as error:
                    errors.append(error)
                finally:
                    finished.set()

            with approved(plan), patch("sys.argv", argv), patch.object(v4, "OwnedHTTPServer", OneRequestServer), patch.object(v4, "handler", synthetic_handler), patch.object(v4.getpass, "getpass", return_value="synthetic-not-an-api-key"):
                thread = threading.Thread(target=run_main)
                thread.start()
                client = None
                try:
                    self.assertTrue(ready.wait(5), errors)
                    client = socket.create_connection(servers[0].server_address, timeout=5)
                    client.sendall(b"POST /synthetic HTTP/1.0\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
                    self.assertTrue(started.wait(5), errors)
                    self.assertTrue(closing.wait(5), errors)
                    self.assertFalse(finished.is_set(), "main must join the accepted handler")
                    self.assertEqual(v2.ACTOR_LIMITS, plan["actorLimitsUsd"])
                    self.assertFalse(settled.is_set())
                    release.set()
                    while client.recv(4096):
                        pass
                finally:
                    release.set()
                    if client:
                        client.close()
                    thread.join(7)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertTrue(settled.is_set())
                self.assertTrue(finished.is_set())
                self.assertEqual(socket_timeouts, [v4.LOCAL_RPC_TIMEOUT_SECONDS])
                self.assertEqual(v2.ACTOR_LIMITS, ORIGINAL_LIMITS)
                # Audit the new row under the reviewed phase map after main
                # has demonstrably restored the original process policy.
                with v4.phase_limits(plan):
                    self.assertEqual(v3.audit_ledger(root)["receiptCount"], 4)


if __name__ == "__main__":
    unittest.main()
