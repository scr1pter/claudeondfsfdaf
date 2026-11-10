"""Free, temporary synthetic ledgers only; no key, live config or provider."""
import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import budget_gateway_v6 as v6

USAGE = {"input_tokens": 100, "output_tokens": 10,
         "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 100}}
ACTUAL = v6.v3.price(USAGE)
ORIGINAL_LIMITS, ORIGINAL_CAP = dict(v6.v2.ACTOR_LIMITS), v6.v2.STUDY_LIMIT
FIXTURE_ROOTS = {}


def metadata():
    return {"model": v6.v3.MODEL, "requestSha256": "1" * 64, "requestBytes": 100,
            "requestedMaxOutputTokens": 32000, "maxOutputTokens": 32000,
            "requestedReasoningEffort": "high", "cacheKeySha256": "2" * 64,
            "toolsSha256": "3" * 64, "inputItemSha256": ["4" * 64],
            "rates": copy.deepcopy(v6.v3.RATES), "sources": list(v6.v3.SOURCES)}


def write_rows(path, values):
    path.write_bytes(b"".join(v6.canonical(item) + b"\n" for item in values))


def history(root):
    root.mkdir()
    admissions, receipts, amounts, spent = [], [], {a: 0.0 for a in v6.ACTORS + v6.OLD_ACTORS}, 0.0
    for seq, actor in enumerate(("diagnostics", *v6.ACTORS), 1):
        admission = {**metadata(), "seq": seq, "actor": actor, "label": "synthetic-historical",
                     "batchSha256": "5" * 64, "reservedUsd": 1.0, "startedUtc": "2026-11-01T00:00:00Z"}
        admissions.append(admission)
        spent += ACTUAL
        amounts[actor] += ACTUAL
        receipts.append({**admission, "usage": copy.deepcopy(USAGE), "measuredUsd": ACTUAL,
                         "serviceTier": "default", "cumulativeMeasuredUsd": spent})
    carried = {**metadata(), "seq": 4, "actor": "foundry-codex", "label": "synthetic-interrupted",
               "batchSha256": "6" * 64, "reservedUsd": 5.73, "startedUtc": "2026-11-01T00:00:01Z"}
    admissions.append(carried)
    write_rows(root / "admissions-v2.jsonl", admissions)
    write_rows(root / "receipts.jsonl", receipts)
    (root / "status.json").write_bytes(v6.canonical({"measuredUsd": spent, "active": 1, "reservedUsd": 5.73}))
    (root / "phase-allocation-v5.json").write_bytes(v6.canonical({"phasePlanSha256": "a" * 64}))
    (root / "gateway-v2.lock").write_bytes(b"0")
    plan = {"kind": "owner-approved-additional-20-phase-v1", "phaseID": v6.PHASE,
            "authorizedAdditionalUsd": 20, "historicalKnownMeasuredUsd": spent,
            "historicalLatestAdmittedSeq": 4, "historicalSettledThroughSeq": 3,
            "historicalActorMeasuredUsd": amounts,
            "carriedUnsettled": {"seq": 4, "actor": "foundry-codex", "reservedUsd": 5.73,
                                  "requestSha256": carried["requestSha256"],
                                  "admissionCanonicalSha256": v6.sha(v6.canonical(carried))},
            "cumulativeUpperExposureLimitUsd": spent + 5.73 + 20,
            "actorLimitsUsd": {actor: amount + (5.73 if actor == "foundry-codex" else 0) +
                               (20 if actor in v6.ACTORS else 0) for actor, amount in amounts.items()},
            "historicalFiles": {}, "historicalRowCounts": {"admissions": 4, "receipts": 3},
            "previousPhasePlanSha256": "a" * 64, "historicalPricingRates": copy.deepcopy(v6.v3.RATES),
            "noOldLiabilityReleased": True, "allHistoricalAdmissionsSettled": False}
    FIXTURE_ROOTS[id(plan)] = root
    return refresh(root, plan)


def refresh(root, plan):
    plan["historicalFiles"] = {name: v6.sha((root / name).read_bytes()) for name in v6.HISTORICAL_FILES}
    return plan


@contextmanager
def approved(plan):
    # Production has no runtime approval override. Only this synthetic process
    # patches the source digest to a temporary test authorization.
    root = FIXTURE_ROOTS[id(plan)]
    with patch.object(v6, "APPROVED_PLAN_SHA256", v6.sha(v6.canonical(plan))), \
            patch.object(v6, "APPROVED_LEDGER_DIRECTORY_SHA256", v6.location_digest(root.parent / "new")), \
            patch.object(v6, "APPROVED_HISTORICAL_DIRECTORY_SHA256", v6.location_digest(root)):
        yield


def settle_one(budget, actor="foundry-vector", reserve=1.0, usage=USAGE):
    token = budget.arm(actor, "synthetic-additional-round", 1)["requestToken"]
    item = budget.admit(token, reserve, metadata())
    budget.settle(item["seq"], {"usage": copy.deepcopy(usage), "measuredUsd": v6.v3.price(usage), "serviceTier": "default"})
    budget.disarm(token)
    return item


class ContinuationTests(unittest.TestCase):
    def tearDown(self):
        self.assertEqual(v6.v2.ACTOR_LIMITS, ORIGINAL_LIMITS)
        self.assertIs(v6.v2.ACTOR_LIMITS, v6.v3.ACTOR_LIMITS)
        self.assertEqual(v6.v2.STUDY_LIMIT, ORIGINAL_CAP)
        self.assertEqual(v6.v3.STUDY_LIMIT, ORIGINAL_CAP)

    def test_production_plan_pins_raw_and_compact_algorithms(self):
        path = Path(v6.__file__).parent / "approved-phase-plan.json"
        plan = v6.load_plan(path)
        self.assertEqual(v6.sha(path.read_bytes()), "19ee7dbe02ff9e5d3ab2d8e41c1da1f738d1977f879a4a4be284947c793b1255")
        self.assertEqual(v6.sha(v6.canonical(plan)), "b91f3cfdd0738299f44ffa23e9a8850ca5751665a521859cf5c1fc2507ee0d5d")
        self.assertEqual(plan["historicalLatestAdmittedSeq"], 1340)
        self.assertEqual(plan["historicalKnownMeasuredUsd"], 29.579095)
        self.assertEqual(plan["cumulativeUpperExposureLimitUsd"], 55.309095)

    def test_changed_owner_allowance_or_carried_record_is_not_approval(self):
        original = v6.load_plan(Path(v6.__file__).parent / "approved-phase-plan.json")
        for field in ("authorizedAdditionalUsd", "historicalLatestAdmittedSeq", "historicalKnownMeasuredUsd"):
            plan = copy.deepcopy(original)
            plan[field] += 1
            with self.subTest(field=field), self.assertRaises(ValueError):
                v6.validate_plan(plan)

    def test_bootstrap_retains_old_unknown_without_fake_receipt_and_global_sequence(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            before = {p.name: p.read_bytes() for p in old.iterdir()}
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                initial = budget.status()
                self.assertEqual((initial["attempts"], initial["active"], initial["reservedUsd"]), (4, 0, 0))
                self.assertEqual(initial["historicalLiabilityUsd"], 5.73)
                self.assertFalse(initial["allHistoricalAdmissionsSettled"])
                self.assertEqual(initial["newRoundMeasuredUsd"], 0)
                self.assertAlmostEqual(initial["remainingAdmissionUsd"], 20)
                self.assertEqual(settle_one(budget)["seq"], 5)
                self.assertNotIn(4, budget.settled)
                self.assertAlmostEqual(budget.status()["newRoundMeasuredUsd"], ACTUAL)
                self.assertEqual(budget.status()["actors"]["foundry-codex"]["historicalLiabilityUsd"], 5.73)
                self.assertEqual(budget.status()["historicalLedgerSha256"], plan["historicalFiles"])
                self.assertEqual(before, {name: (old / name).read_bytes() for name in before})
                self.assertTrue((old / v6.PLACEMENT_FILE).is_file())
                self.assertEqual(v6.rows(new, "receipts.jsonl")[0]["seq"], 5)
                self.assertEqual(v6.rows(new, "admissions-v2.jsonl")[0]["seq"], 5)

    def test_20_is_shared_not_ten_each_and_old_hold_is_not_spendable(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                first = budget.arm("foundry-vector", "synthetic-first", 2)["requestToken"]
                second = budget.arm("foundry-codex", "synthetic-second", 2)["requestToken"]
                budget.admit(first, 11, metadata())
                with self.assertRaises(v6.v2.AdmissionError):
                    budget.admit(second, 9.01, metadata())
                budget.admit(second, 8.99, metadata())
                status = budget.status()
                self.assertAlmostEqual(status["newRoundReservedUsd"], 19.99)
                self.assertAlmostEqual(status["historicalLiabilityUsd"], 5.73)
                self.assertLessEqual(status["cumulativeUpperExposureUsd"], status["limitUsd"])
                with self.assertRaises(v6.v2.AdmissionError):
                    budget.admit(first, .02, metadata())

    def test_both_actor_spending_and_all_helpers_share_the_20_ceiling(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            usage = {"input_tokens": 1_000_000, "output_tokens": 0,
                     "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 1_000_000}}
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                for actor in ("foundry-vector", "foundry-codex", "foundry-vector"):
                    settle_one(budget, actor, 5, usage)
                token = budget.arm("foundry-codex", "synthetic-final", 1)["requestToken"]
                budget.admit(token, 4.99, metadata())
                status = budget.status()
                self.assertAlmostEqual(status["newRoundMeasuredUsd"], 15)
                self.assertAlmostEqual(status["remainingAdmissionUsd"], .01)
                self.assertAlmostEqual(status["cumulativeUpperExposureUsd"], plan["historicalKnownMeasuredUsd"] + 5.73 + 19.99)
                for actor in v6.OLD_ACTORS:
                    with self.assertRaises(v6.v2.AdmissionError):
                        budget.arm(actor, "sealed-old-actor", 1)

    def test_clean_restart_retains_real_costs_cumulative_floors_and_anchor(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                settle_one(budget)
                anchor = (new / v6.ANCHOR_FILE).read_bytes()
                before = {p.name: p.read_bytes() for p in new.iterdir()}
                resumed = v6.Budget(new, old, plan)
                self.assertEqual(resumed.seq, 5)
                self.assertAlmostEqual(resumed.status()["newRoundMeasuredUsd"], ACTUAL)
                self.assertEqual(before, {p.name: p.read_bytes() for p in new.iterdir()})
                self.assertEqual(anchor, (new / v6.ANCHOR_FILE).read_bytes())

    def test_no_old_call_settlement_or_duplicate_current_credit(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                row = settle_one(budget)
                before = budget.status()
                result = {"usage": USAGE, "measuredUsd": ACTUAL, "serviceTier": "default"}
                self.assertFalse(budget.settle(row["seq"], result))
                with self.assertRaises(ValueError):
                    budget.settle(plan["carriedUnsettled"]["seq"], result)
                self.assertEqual(before, budget.status())

    def test_unsupported_request_metadata_is_rejected_before_admission(self):
        mutations = [lambda m: m.update(extra="not-approved"), lambda m: m.update(requestedReasoningEffort="low"),
                     lambda m: m.update(model="other"), lambda m: m.update(requestBytes=True),
                     lambda m: m.update(maxOutputTokens=0), lambda m: m.update(cacheKeySha256="bad")]
        for mutate in mutations:
            with tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    token = budget.arm("foundry-vector", "synthetic-invalid", 1)["requestToken"]
                    item = metadata()
                    mutate(item)
                    with self.assertRaises(ValueError):
                        budget.admit(token, 1, item)
                    self.assertEqual(budget.seq, 4)
                    self.assertEqual(v6.rows(new, "admissions-v2.jsonl"), [])

    def test_new_missing_or_unknown_receipt_never_becomes_another_carry_exception(self):
        for mode in ("missing", "unknown"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    token = budget.arm("foundry-vector", "synthetic-interrupted-new", 2)["requestToken"]
                    item = budget.admit(token, 1, metadata())
                    if mode == "unknown":
                        budget.settle(item["seq"], {"measuredUsd": None, "failureKind": "SyntheticTransportFailure"})
                        self.assertEqual(budget.reserved, 1)
                        self.assertIsNotNone(budget.halted)
                    with self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)

    def test_untrusted_settlement_metadata_halts_and_keeps_reservation(self):
        for mutation in (lambda x: x.update(actor="foundry-codex"), lambda x: x.update(measuredUsd=0),
                         lambda x: x.update(serviceTier="priority")):
            with tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    token = budget.arm("foundry-vector", "synthetic-bad-receipt", 2)["requestToken"]
                    item = budget.admit(token, 1, metadata())
                    result = {"usage": copy.deepcopy(USAGE), "measuredUsd": ACTUAL, "serviceTier": "default"}
                    mutation(result)
                    with self.assertRaises(ValueError):
                        budget.settle(item["seq"], result)
                    self.assertEqual(budget.reserved, 1)
                    with self.assertRaises(v6.v2.AdmissionError):
                        budget.admit(token, 1, metadata())

    def test_historical_file_changes_rejected_without_creating_new_round(self):
        for name in v6.HISTORICAL_FILES:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                (old / name).write_bytes((old / name).read_bytes() + b" ")
                with approved(plan), v6.phase_limits(plan), self.assertRaises(ValueError):
                    v6.Budget(new, old, plan)
                self.assertFalse(new.exists())

    def test_v3_historical_price_rules_still_reject_even_with_reapproved_fixture_hashes(self):
        mutations = [lambda x: x.update(measuredUsd=True), lambda x: x.update(measuredUsd=-1),
                     lambda x: x.update(reservedUsd=0), lambda x: x.update(model="other"),
                     lambda x: x.update(serviceTier="priority"), lambda x: x.update(cumulativeMeasuredUsd=0),
                     lambda x: x.update(usage={}), lambda x: x.update(rates={}),
                     lambda x: x.update(seq=2), lambda x: x.update(actor="unapproved")]
        for mutate in mutations:
            with tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                records = v6.rows(old, "receipts.jsonl")
                mutate(records[0])
                write_rows(old / "receipts.jsonl", records)
                refresh(old, plan)
                with approved(plan), v6.phase_limits(plan), self.assertRaises((ValueError, TypeError)):
                    v6.Budget(new, old, plan)
                self.assertFalse(new.exists())

    def test_extra_historical_admission_cannot_join_the_single_approved_unknown(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            records = v6.rows(old, "admissions-v2.jsonl")
            extra = {**records[-1], "seq": 5}
            write_rows(old / "admissions-v2.jsonl", records + [extra])
            plan["historicalRowCounts"]["admissions"] += 1
            refresh(old, plan)
            with approved(plan), v6.phase_limits(plan), self.assertRaisesRegex(ValueError, "unmatched"):
                v6.Budget(new, old, plan)

    def test_changed_carried_metadata_rejected_despite_updated_file_hash(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            records = v6.rows(old, "admissions-v2.jsonl")
            records[-1]["requestSha256"] = "f" * 64
            write_rows(old / "admissions-v2.jsonl", records)
            refresh(old, plan)
            with approved(plan), v6.phase_limits(plan), self.assertRaisesRegex(ValueError, "carried admission"):
                v6.Budget(new, old, plan)

    def test_new_journal_gap_duplicate_metadata_or_partial_line_is_refused(self):
        for mode in ("gap", "duplicate", "unknown", "partial"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    settle_one(budget)
                    path = new / "admissions-v2.jsonl"
                    records = v6.rows(new, path.name)
                    if mode == "gap":
                        records[0]["seq"] += 1
                    if mode == "duplicate":
                        records.append(records[0])
                    if mode == "unknown":
                        records[0]["unapproved"] = True
                    write_rows(path, records)
                    if mode == "partial":
                        path.write_bytes(path.read_bytes() + b"{")
                    with self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)

    def test_changed_or_missing_phase_anchor_and_ambiguous_snapshot_are_refused(self):
        for mode in ("missing", "anchor", "active", "actor", "halt", "phase"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    settle_one(budget)
                    if mode == "missing":
                        (new / v6.ANCHOR_FILE).unlink()
                    elif mode == "anchor":
                        record = json.loads((new / v6.ANCHOR_FILE).read_bytes())
                        record["historicalLiabilityNotReleased"] = False
                        (new / v6.ANCHOR_FILE).write_bytes(v6.canonical(record))
                    else:
                        record = json.loads((new / "status.json").read_bytes())
                        if mode == "active": record["active"] = 1
                        if mode == "actor": record["actors"]["foundry-vector"]["measuredUsd"] = 0
                        if mode == "halt": record["halted"] = "uncertain"
                        if mode == "phase": record["phasePlanSha256"] = "f" * 64
                        (new / "status.json").write_bytes(v6.canonical(record))
                    with self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)

    def test_policy_cannot_escape_context_and_status_reads_are_pure(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan):
                with v6.phase_limits(plan):
                    budget = v6.Budget(new, old, plan)
                    with patch.object(Path, "read_bytes", side_effect=AssertionError("status did filesystem I/O")):
                        self.assertEqual(budget.status()["newRoundAttempts"], 0)
                with self.assertRaises(ValueError):
                    budget.status()

    def test_fsync_uncertainty_prevents_new_admission_and_restart(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                token = budget.arm("foundry-vector", "synthetic-fsync", 2)["requestToken"]
                with patch.object(v6.os, "fsync", side_effect=OSError("synthetic fsync failure")), self.assertRaises(OSError):
                    budget.admit(token, 1, metadata())
                self.assertIsNotNone(budget.halted)
                with self.assertRaises(v6.v2.AdmissionError):
                    budget.admit(token, 1, metadata())
                with self.assertRaises(ValueError):
                    v6.Budget(new, old, plan)

    def test_no_nested_or_same_ledger_directory(self):
        with tempfile.TemporaryDirectory() as parent:
            old = Path(parent) / "old"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                for new in (old, old / "nested", old.parent):
                    with self.subTest(new=new), self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)

    def test_transport_retains_model_reasoning_capacity_and_full_image_bound(self):
        self.assertIs(v6.v4.handler, v6.v3.handler)
        body = {"model": v6.v3.MODEL, "reasoning": {"effort": "high"}, "max_output_tokens": 32000,
                "input": [{"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA=="}]}]}
        wire, bound = v6.v3.prepare(body)
        self.assertEqual(bound, 5.73)
        self.assertEqual(json.loads(wire)["reasoning"]["effort"], "high")
        self.assertEqual(json.loads(wire)["max_output_tokens"], 32000)
        self.assertFalse(json.loads(wire)["store"])

    def test_all_current_financial_components_exist_before_any_key_or_arm(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                self.assertTrue(all((new / name).is_file() for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json")))
                self.assertEqual((new / "admissions-v2.jsonl").read_bytes(), b"")
                self.assertEqual((new / "receipts.jsonl").read_bytes(), b"")
                self.assertEqual(budget.status()["newRoundAttempts"], 0)
                self.assertEqual(json.loads((new / "status.json").read_bytes())["newRoundMeasuredUsd"], 0)

    def test_deleting_all_current_journals_cannot_reset_spend_under_retained_anchors(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                settle_one(budget)
                placement, anchor = (old / v6.PLACEMENT_FILE).read_bytes(), (new / v6.ANCHOR_FILE).read_bytes()
                for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json"):
                    (new / name).unlink()
                with self.assertRaisesRegex(ValueError, "financial inventory"):
                    v6.Budget(new, old, plan)
                self.assertEqual((old / v6.PLACEMENT_FILE).read_bytes(), placement)
                self.assertEqual((new / v6.ANCHOR_FILE).read_bytes(), anchor)

    def test_individual_missing_components_or_marker_fail_closed(self):
        for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json", v6.ANCHOR_FILE, v6.PLACEMENT_FILE):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    v6.Budget(new, old, plan)
                    ((old if name == v6.PLACEMENT_FILE else new) / name).unlink()
                    with self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)

    def test_other_locations_do_not_create_a_second_allowance(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                v6.Budget(new, old, plan)
                alternate = new.parent / "alternate"
                with self.assertRaisesRegex(ValueError, "placement"):
                    v6.Budget(alternate, old, plan)
                self.assertFalse(alternate.exists())
                # Even a separately re-pinned test location cannot reuse the
                # original historical placement authority for another root.
                with patch.object(v6, "APPROVED_LEDGER_DIRECTORY_SHA256", v6.location_digest(alternate)):
                    with self.assertRaisesRegex(ValueError, "placement"):
                        v6.Budget(alternate, old, plan)

    def test_copied_historical_directory_is_not_an_alternate_authority(self):
        import shutil
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            alternate = old.parent / "copied-old"
            shutil.copytree(old, alternate)
            with approved(plan), v6.phase_limits(plan), self.assertRaisesRegex(ValueError, "placement"):
                v6.Budget(new, alternate, plan)
            self.assertFalse(new.exists())

    def test_partial_bootstrap_marker_or_anchor_is_never_silently_repaired(self):
        for where in ("marker", "anchor"):
            with self.subTest(where=where), tempfile.TemporaryDirectory() as parent:
                old, new = Path(parent) / "old", Path(parent) / "new"
                plan = history(old)
                with approved(plan), v6.phase_limits(plan):
                    v6.Budget(new, old, plan)
                    path = old / v6.PLACEMENT_FILE if where == "marker" else new / v6.ANCHOR_FILE
                    path.write_bytes(b"{")
                    with self.assertRaises(ValueError):
                        v6.Budget(new, old, plan)
                    self.assertEqual(path.read_bytes(), b"{")

    def test_initial_snapshot_failure_stops_bootstrap(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                with patch.object(v6.Budget, "publish_snapshot", return_value=False), self.assertRaisesRegex(ValueError, "initial current-round snapshot"):
                    v6.Budget(new, old, plan)
                with self.assertRaisesRegex(ValueError, "financial inventory"):
                    v6.Budget(new, old, plan)

    def test_original_plan_caller_and_status_results_cannot_mutate_budget_authority(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            with approved(plan), v6.phase_limits(plan):
                budget = v6.Budget(new, old, plan)
                plan["carriedUnsettled"]["reservedUsd"] = 0
                status = budget.status()
                status["historicalLedgerSha256"]["receipts.jsonl"] = "f" * 64
                self.assertEqual(budget.status()["historicalLiabilityUsd"], 5.73)
                self.assertNotEqual(budget.status()["historicalLedgerSha256"]["receipts.jsonl"], "f" * 64)

    def test_racing_same_target_bootstraps_only_one_claim(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            barrier, results = threading.Barrier(2), []
            real_open = Path.open
            def gated_open(path, *args, **kwargs):
                if path.name == v6.PLACEMENT_FILE and args and args[0] == "xb":
                    barrier.wait(timeout=5)
                return real_open(path, *args, **kwargs)
            def bootstrap():
                try:
                    results.append(v6.Budget(new, old, plan))
                except (ValueError, OSError) as error:
                    results.append(error)
            with approved(plan), v6.phase_limits(plan), patch.object(Path, "open", gated_open):
                threads = [threading.Thread(target=bootstrap) for _ in range(2)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(timeout=10)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(sum(isinstance(x, v6.Budget) for x in results), 1)
                self.assertEqual(sum(isinstance(x, (ValueError, OSError)) for x in results), 1)
                self.assertEqual(v6.Budget(new, old, plan).status()["newRoundAttempts"], 0)

    def test_racing_different_targets_cannot_gain_second_allowance(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            alternate = new.parent / "alternate"
            plan, results = history(old), []
            def bootstrap(target):
                try: results.append(v6.Budget(target, old, plan))
                except (ValueError, OSError) as error: results.append(error)
            with approved(plan), v6.phase_limits(plan):
                threads = [threading.Thread(target=bootstrap, args=(target,)) for target in (new, alternate)]
                for thread in threads: thread.start()
                for thread in threads: thread.join(timeout=10)
                self.assertFalse(any(thread.is_alive() for thread in threads))
                self.assertEqual(sum(isinstance(x, v6.Budget) for x in results), 1)
                self.assertFalse(alternate.exists())

    @unittest.skipUnless(os.name == "nt", "Windows owned socket and process lock")
    def test_occupied_socket_precedes_budget_config_or_key_entry(self):
        with tempfile.TemporaryDirectory() as parent, socket.socket() as occupied:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            artifact = old.parent / "phase.json"
            artifact.write_bytes(v6.canonical(plan))
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            argv = ["v6", "--directory", str(new), "--historical-directory", str(old), "--phase-plan", str(artifact),
                    "--controller-config", str(old.parent / "must-not-read-controller.json"), "--port", str(occupied.getsockname()[1])]
            with approved(plan), patch.object(v6, "APPROVED_PLAN_FILE_SHA256", v6.sha(artifact.read_bytes())), \
                    patch("sys.argv", argv), patch.object(v6, "Budget") as budget, patch.object(v6.getpass, "getpass") as prompt, \
                    self.assertRaises(OSError) as failure:
                v6.main()
            self.assertEqual(getattr(failure.exception, "winerror", None), 10048)
            budget.assert_not_called()
            prompt.assert_not_called()
            self.assertFalse(new.exists())

    @unittest.skipUnless(os.name == "nt", "Windows owned socket and process lock")
    def test_masked_prompt_failure_closes_owned_socket_and_preserves_preexisting_history(self):
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            before = {p.name: p.read_bytes() for p in old.iterdir()}
            artifact, config = old.parent / "phase.json", old.parent / "controller.json"
            artifact.write_bytes(v6.canonical(plan))
            config.write_bytes(v6.canonical({"localToken": "synthetic-controller-capability-only"}))
            servers = []
            class RecordingServer(v6.v4.OwnedHTTPServer):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    servers.append(self)
            argv = ["v6", "--directory", str(new), "--historical-directory", str(old), "--phase-plan", str(artifact),
                    "--controller-config", str(config), "--port", "0"]
            with approved(plan), patch.object(v6, "APPROVED_PLAN_FILE_SHA256", v6.sha(artifact.read_bytes())), \
                    patch("sys.argv", argv), patch.object(v6.v4, "OwnedHTTPServer", RecordingServer), \
                    patch.object(v6.getpass, "getpass", side_effect=RuntimeError("synthetic cancelled key prompt")) as prompt, \
                    self.assertRaises(RuntimeError):
                v6.main()
            prompt.assert_called_once()
            self.assertEqual(len(servers), 1)
            self.assertEqual(servers[0].socket.fileno(), -1)
            self.assertIs(servers[0].RequestHandlerClass, v6.v4.UnarmedHandler)
            self.assertEqual(before, {name: (old / name).read_bytes() for name in before})

    @unittest.skipUnless(os.name == "nt", "Windows owned socket and process lock")
    def test_process_lock_contention_precedes_socket_or_key(self):
        import msvcrt
        with tempfile.TemporaryDirectory() as parent:
            old, new = Path(parent) / "old", Path(parent) / "new"
            plan = history(old)
            artifact = old.parent / "phase.json"
            artifact.write_bytes(v6.canonical(plan))
            argv = ["v6", "--directory", str(new), "--historical-directory", str(old), "--phase-plan", str(artifact),
                    "--controller-config", str(old.parent / "must-not-read-controller.json"), "--port", "0"]
            with (old / "gateway-v2.lock").open("r+b") as locked:
                msvcrt.locking(locked.fileno(), msvcrt.LK_NBLCK, 1)
                with approved(plan), patch.object(v6, "APPROVED_PLAN_FILE_SHA256", v6.sha(artifact.read_bytes())), \
                        patch("sys.argv", argv), patch.object(v6.v4, "OwnedHTTPServer") as server, \
                        patch.object(v6.getpass, "getpass") as prompt, self.assertRaises(OSError):
                    v6.main()
                server.assert_not_called()
                prompt.assert_not_called()

    def test_raw_plan_bytes_are_not_interchangeable_with_equal_json(self):
        source = (Path(v6.__file__).parent / "approved-phase-plan.json").read_bytes()
        with tempfile.TemporaryDirectory() as parent:
            altered = Path(parent) / "phase.json"
            altered.write_bytes(source + b" ")
            with self.assertRaisesRegex(ValueError, "raw bytes"):
                v6.load_plan(altered)


if __name__ == "__main__":
    unittest.main()
