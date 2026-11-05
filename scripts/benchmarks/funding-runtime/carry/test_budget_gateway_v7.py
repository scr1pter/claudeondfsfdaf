"""Temporary synthetic history; no live ledgers, credentials or paid requests."""
import copy
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import budget_gateway_v7 as v7
import test_budget_gateway_v6 as old_tests

v6 = v7.v6
USAGE, ACTUAL = old_tests.USAGE, old_tests.ACTUAL
metadata, write_rows = old_tests.metadata, old_tests.write_rows


def fixture(parent):
    original, previous, current, placement = (parent / x for x in ("old", "new", "carry", "placement.json"))
    old_plan = old_tests.history(original)
    with old_tests.approved(old_plan), v6.phase_limits(old_plan):
        budget = v6.Budget(previous, original, old_plan)
        old_tests.settle_one(budget)
        token = budget.arm("foundry-codex", "synthetic-remote-eof", 1)["requestToken"]
        unknown = budget.admit(token, 1.447765, metadata())
        budget.settle(unknown["seq"], {"measuredUsd": None, "failureKind": "RemoteDisconnected"})
        budget.disarm(token)
    (previous / "gateway-v6.lock").write_bytes(b"0")
    receipt = v6.rows(previous, "receipts.jsonl")[-1]
    first = {**old_plan["carriedUnsettled"], "receiptCanonicalSha256": None}
    second = {k: unknown[k] for k in ("seq", "actor", "reservedUsd", "requestSha256")}
    second.update(admissionCanonicalSha256=v7.sha(v7.canonical(unknown)), receiptCanonicalSha256=v7.sha(v7.canonical(receipt)))
    amounts = dict(old_plan["historicalActorMeasuredUsd"])
    amounts["foundry-vector"] += ACTUAL
    plan = {"kind": "reviewed-conservative-carry-v1", "phaseID": v7.PHASE, "authorizedAdditionalUsd": 20,
            "originalHistoricalKnownMeasuredUsd": old_plan["historicalKnownMeasuredUsd"],
            "historicalKnownMeasuredUsd": old_plan["historicalKnownMeasuredUsd"] + ACTUAL,
            "previousRoundKnownMeasuredUsd": ACTUAL, "historicalLatestAdmittedSeq": unknown["seq"],
            "historicalActorMeasuredUsd": amounts, "carriedUnsettled": [first, second], "historicalLiabilityUsd": 7.177765,
            "remainingAdditionalExposureUsd": 20 - ACTUAL - 1.447765,
            "cumulativeUpperExposureLimitUsd": old_plan["cumulativeUpperExposureLimitUsd"],
            "actorLimitsUsd": old_plan["actorLimitsUsd"], "originalPhasePlanSha256": v7.sha(v7.canonical(old_plan)),
            "previousPhaseFiles": {n: v7.sha((previous / n).read_bytes()) for n in v7.PREVIOUS_FILES},
            "previousPlacementSha256": v7.sha((original / v6.PLACEMENT_FILE).read_bytes()),
            "previousPhaseRowCounts": {"admissions": 2, "receipts": 2}, "historicalPricingRates": copy.deepcopy(v7.v3.RATES),
            "noLiabilityReleased": True, "allHistoricalAdmissionsSettled": False}
    return original, previous, current, placement, old_plan, plan


@contextmanager
def approved(item):
    original, previous, current, placement, old_plan, plan = item
    with ExitStack() as stack:
        stack.enter_context(old_tests.approved(old_plan))
        for key, value in {"APPROVED_PLAN_SHA256": v7.sha(v7.canonical(plan)),
                "APPROVED_DIRECTORY_SHA256": v7.location_digest(current),
                "APPROVED_PREVIOUS_DIRECTORY_SHA256": v7.location_digest(previous),
                "APPROVED_ORIGINAL_DIRECTORY_SHA256": v7.location_digest(original),
                "APPROVED_PLACEMENT_SHA256": v7.location_digest(placement)}.items():
            stack.enter_context(patch.object(v7, key, value))
        # Only the original authorization document is synthetic. All production
        # history, receipt repricing and two-liability validation still execute.
        stack.enter_context(patch.object(v6, "load_plan", return_value=copy.deepcopy(old_plan)))
        stack.enter_context(v7.phase_limits(plan))
        yield


def construct(item):
    original, previous, current, placement, _, plan = item
    return v7.Budget(current, original, previous, placement, plan)


def settle_one(budget, actor="foundry-vector"):
    token = budget.arm(actor, "synthetic-next-work", 1)["requestToken"]
    attempt = budget.admit(token, 1, metadata())
    budget.settle(attempt["seq"], {"usage": copy.deepcopy(USAGE), "measuredUsd": ACTUAL, "serviceTier": "default"})
    budget.disarm(token)
    return attempt


class CarryTests(unittest.TestCase):
    def test_production_plan_has_exact_cap_and_two_real_liabilities(self):
        plan = v7.load_plan(Path(v7.__file__).parent / "approved-phase-plan.json")
        self.assertEqual(plan["historicalKnownMeasuredUsd"], 31.1626864)
        self.assertEqual(plan["historicalLatestAdmittedSeq"], 1419)
        self.assertEqual(plan["remainingAdditionalExposureUsd"], 16.9686436)
        self.assertEqual(plan["historicalLiabilityUsd"], 7.177765)
        self.assertEqual(plan["cumulativeUpperExposureLimitUsd"], 55.309095)

    def test_bootstrap_conserves_both_histories_and_costs_and_sequence(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            before = [{p.name: p.read_bytes() for p in root.iterdir()} for root in item[:2]]
            with approved(item):
                budget = construct(item)
                state = budget.status()
                self.assertEqual(state["historicalLiabilityUsd"], 7.177765)
                self.assertEqual(state["carriedUnresolvedRequestCount"], 2)
                self.assertFalse(state["allHistoricalAdmissionsSettled"])
                self.assertTrue(state["allCurrentRoundAdmissionsSettled"])
                self.assertAlmostEqual(state["newRoundMeasuredUsd"], ACTUAL)
                self.assertAlmostEqual(state["remainingAdmissionUsd"], 20 - ACTUAL - 1.447765)
                self.assertEqual(settle_one(budget)["seq"], 7)
                self.assertAlmostEqual(budget.status()["newRoundMeasuredUsd"], 2 * ACTUAL)
                self.assertEqual(before, [{p.name: p.read_bytes() for p in root.iterdir()} for root in item[:2]])

    def test_clean_restart_has_no_reset_refund_or_status_write(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                budget = construct(item)
                settle_one(budget)
                before = {p.name: p.read_bytes() for p in item[2].iterdir()}
                resumed = construct(item)
                self.assertEqual(resumed.seq, 7)
                self.assertAlmostEqual(resumed.status()["newRoundMeasuredUsd"], 2 * ACTUAL)
                self.assertEqual(before, {p.name: p.read_bytes() for p in item[2].iterdir()})

    def test_no_historical_settlement_or_duplicate_credit(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                budget = construct(item)
                for seq in (4, 5, 6):
                    with self.assertRaises(ValueError):
                        budget.settle(seq, {"measuredUsd": 0})
                attempt = settle_one(budget)
                state = budget.status()
                self.assertFalse(budget.settle(attempt["seq"], {"measuredUsd": 0}))
                self.assertEqual(budget.status(), state)

    def test_both_holds_are_unspendable_and_remainder_shared(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                budget = construct(item)
                one = budget.arm("foundry-vector", "synthetic-first", 2)["requestToken"]
                two = budget.arm("foundry-codex", "synthetic-second", 2)["requestToken"]
                budget.admit(one, 11, metadata())
                budget.admit(two, 7.5, metadata())
                with self.assertRaises(v7.v2.AdmissionError):
                    budget.admit(one, .1, metadata())
                state = budget.status()
                self.assertAlmostEqual(state["newRoundExposureUsd"], ACTUAL + 18.5 + 1.447765)
                self.assertLessEqual(state["cumulativeUpperExposureUsd"], state["limitUsd"])
                for actor in v7.OLD_ACTORS:
                    with self.assertRaises(v7.v2.AdmissionError):
                        budget.arm(actor, "synthetic-sealed", 1)

    def test_next_missing_or_unknown_receipt_is_not_automatically_carried(self):
        for mode in ("missing", "unknown"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                item = fixture(Path(folder))
                with approved(item):
                    budget = construct(item)
                    token = budget.arm("foundry-vector", "synthetic-uncertain", 2)["requestToken"]
                    attempt = budget.admit(token, 1, metadata())
                    if mode == "unknown":
                        budget.settle(attempt["seq"], {"measuredUsd": None, "failureKind": "RemoteDisconnected"})
                        self.assertEqual(budget.reserved, 1)
                        with self.assertRaises(v7.v2.AdmissionError):
                            budget.arm("foundry-vector", "synthetic-refused", 1)
                    with self.assertRaises(ValueError):
                        construct(item)

    def test_tampered_either_history_fails_without_current_bootstrap(self):
        for history in (0, 1):
            for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json"):
                with self.subTest(history=history, name=name), tempfile.TemporaryDirectory() as folder:
                    item = fixture(Path(folder))
                    with approved(item):
                        path = item[history] / name
                        path.write_bytes(path.read_bytes() + b" ")
                        with self.assertRaises(ValueError):
                            construct(item)
                        self.assertFalse(item[2].exists())

    def test_current_journal_or_snapshot_deletion_cannot_reset_spending(self):
        for names in (("admissions-v2.jsonl",), ("receipts.jsonl",), ("status.json",),
                      ("admissions-v2.jsonl", "receipts.jsonl", "status.json")):
            with self.subTest(names=names), tempfile.TemporaryDirectory() as folder:
                item = fixture(Path(folder))
                with approved(item):
                    budget = construct(item)
                    settle_one(budget)
                    for name in names:
                        (item[2] / name).unlink()
                    with self.assertRaisesRegex(ValueError, "financial inventory"):
                        construct(item)

    def test_marker_anchor_deletion_or_edit_fails(self):
        for mode in ("marker-delete", "marker-edit", "anchor-delete", "anchor-edit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                item = fixture(Path(folder))
                with approved(item):
                    construct(item)
                    target = item[3] if mode.startswith("marker") else item[2] / v7.ANCHOR_FILE
                    if mode.endswith("delete"):
                        target.unlink()
                    elif mode.startswith("marker"):
                        data = json.loads(target.read_bytes())
                        data["bootstrapID"] = "0" * 64
                        target.write_bytes(v7.canonical(data))
                    else:
                        target.write_bytes(target.read_bytes() + b" ")
                    with self.assertRaises(ValueError):
                        construct(item)

    def test_alternate_directory_cannot_gain_second_allowance(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                construct(item)
                with self.assertRaisesRegex(ValueError, "placement differs"):
                    v7.Budget(item[2].parent / "alternate", item[0], item[1], item[3], item[5])

    def test_raw_plan_bytes_and_unapproved_fields_fail(self):
        source = Path(v7.__file__).parent / "approved-phase-plan.json"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "plan.json"
            path.write_bytes(source.read_bytes() + b" ")
            with self.assertRaisesRegex(ValueError, "raw bytes"):
                v7.load_plan(path)
        plan = json.loads(source.read_bytes())
        for field in ("authorizedAdditionalUsd", "historicalKnownMeasuredUsd", "remainingAdditionalExposureUsd"):
            altered = copy.deepcopy(plan)
            altered[field] += 1
            with self.assertRaises(ValueError):
                v7.validate_plan(altered)

    def test_mutated_returned_status_does_not_change_authority(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                budget = construct(item)
                state = budget.status()
                state["carriedUnsettled"][0]["reservedUsd"] = 0
                self.assertEqual(budget.status()["historicalLiabilityUsd"], 7.177765)

    def test_untrusted_settlement_retains_reservation(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            with approved(item):
                budget = construct(item)
                token = budget.arm("foundry-vector", "synthetic-bad-price", 1)["requestToken"]
                attempt = budget.admit(token, 1, metadata())
                with self.assertRaises(ValueError):
                    budget.settle(attempt["seq"], {"measuredUsd": 0, "usage": USAGE})
                self.assertEqual(budget.reserved, 1)
                self.assertIsNotNone(budget.halted)

    def test_racing_bootstrap_only_one_durable_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            item = fixture(Path(folder))
            barrier, result = threading.Barrier(2), []
            real_open = Path.open
            def gated(path, *args, **kwargs):
                if path == item[3] and args and args[0] == "xb":
                    barrier.wait(timeout=5)
                return real_open(path, *args, **kwargs)
            def bootstrap():
                try:
                    result.append(construct(item))
                except (ValueError, OSError) as error:
                    result.append(error)
            with approved(item), patch.object(Path, "open", gated):
                threads = [threading.Thread(target=bootstrap) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=10)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(sum(isinstance(x, v7.Budget) for x in result), 1)
                self.assertEqual(sum(isinstance(x, (ValueError, OSError)) for x in result), 1)

    @unittest.skipUnless(os.name == "nt", "Windows owned socket and process locks")
    def test_occupied_port_precedes_budget_config_and_key(self):
        with tempfile.TemporaryDirectory() as folder, socket.socket() as occupied:
            item = fixture(Path(folder))
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            plan_file = Path(folder) / "plan.json"
            plan_file.write_bytes(v7.canonical(item[5]))
            argv = ["v7", "--directory", str(item[2]), "--original-directory", str(item[0]),
                    "--previous-directory", str(item[1]), "--placement-file", str(item[3]), "--phase-plan", str(plan_file),
                    "--controller-config", str(Path(folder) / "must-not-read.json"), "--port", str(occupied.getsockname()[1])]
            with approved(item), patch.object(v7, "APPROVED_PLAN_FILE_SHA256", v7.sha(plan_file.read_bytes())), \
                    patch("sys.argv", argv), patch.object(v7, "Budget") as budget, \
                    patch.object(v7.getpass, "getpass") as prompt, self.assertRaises(OSError):
                v7.main()
            budget.assert_not_called()
            prompt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
