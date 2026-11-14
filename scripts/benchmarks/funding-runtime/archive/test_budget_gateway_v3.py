"""Offline v3 storage/recovery tests. No provider calls or real key/config."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import socket
from pathlib import Path
import tempfile
import unittest
import warnings
from unittest.mock import patch

import budget_gateway_v2 as v2
import budget_gateway_v3 as v3

USAGE = {"input_tokens": 100, "output_tokens": 10,
         "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 100}}
ACTUAL = v3.price(USAGE)


def settle_one(budget, actor="diagnostics"):
    token = budget.arm(actor, "synthetic-storage-control", 2)["requestToken"]
    admission = budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
    budget.settle(admission["seq"], {"usage": USAGE, "measuredUsd": ACTUAL, "serviceTier": "default"})
    budget.disarm(token)
    return token, admission


class StorageTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows startup and owned socket")
    def test_occupied_port_fails_before_budget_recovery_or_key_prompt(self):
        with tempfile.TemporaryDirectory() as root, socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            (Path(root) / "owner-budget.json").write_text(json.dumps({"authorizedStudyMaximumUsd": 48}))
            argv = ["budget_gateway_v3.py", "--directory", root, "--port", str(occupied.getsockname()[1])]
            with patch("sys.argv", argv), patch.object(v3.getpass, "getpass") as prompt, patch.object(v3, "Budget") as budget, self.assertRaises(OSError) as failure:
                v3.main()
            self.assertEqual(getattr(failure.exception, "winerror", None), 10048)
            prompt.assert_not_called()
            budget.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows startup and owned socket")
    def test_prompt_failure_closes_prebound_socket_and_retains_placeholder_handler(self):
        servers = []
        class RecordingServer(v3.OwnedHTTPServer):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                servers.append(self)
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "owner-budget.json").write_text(json.dumps({"authorizedStudyMaximumUsd": 48}))
            (directory / "gateway-config.json").write_text(json.dumps({"localToken": "synthetic-controller-only"}))
            argv = ["budget_gateway_v3.py", "--directory", root, "--port", "0"]
            with warnings.catch_warnings(), patch("sys.argv", argv), patch.object(v3, "OwnedHTTPServer", RecordingServer), patch.object(v3.getpass, "getpass", side_effect=RuntimeError("synthetic prompt failure")) as prompt, self.assertRaises(RuntimeError):
                v3.main()
            prompt.assert_called_once()
            self.assertEqual(len(servers), 1)
            self.assertEqual(servers[0].socket.fileno(), -1)
            self.assertIs(servers[0].RequestHandlerClass, v3.UnarmedHandler)
            self.assertFalse((directory / "status.json").exists())

    def test_transport_prices_caps_and_actor_policy_are_reused_unchanged(self):
        self.assertIs(v3.prepare, v2.prepare)
        self.assertIs(v3.price, v2.price)
        self.assertIs(v3.handler, v2.handler)
        self.assertEqual(v3.ACTOR_LIMITS, {"diagnostics": 8, "saas-vector": 20, "saas-codex": 20})
        self.assertEqual(v3.STUDY_LIMIT, 48)

    def test_status_is_pure_even_when_snapshot_replace_or_write_would_fail(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            with patch("budget_gateway_v3.os.replace", side_effect=AssertionError("status must not replace")), patch.object(Path, "write_text", side_effect=AssertionError("status must not write")):
                self.assertEqual(budget.status()["attempts"], 0)
                self.assertEqual(budget.status()["active"], 0)
            self.assertFalse((Path(root) / "status.json").exists())

    def test_snapshot_failure_warns_without_halting_or_losing_durable_receipts(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            with patch("budget_gateway_v3.os.replace", side_effect=PermissionError(13, "synthetic sharing violation")), patch("budget_gateway_v3.time.sleep"):
                settle_one(budget)
            self.assertFalse(budget.persistence_failed)
            self.assertIsNone(budget.halted)
            self.assertEqual(budget.status()["snapshotWarning"]["errno"], 13)
            self.assertAlmostEqual(budget.spent, ACTUAL)
            self.assertEqual(v3.audit_ledger(root)["receiptCount"], 1)
            self.assertTrue(budget.publish_snapshot())
            self.assertIsNone(budget.snapshot_warning)

    @unittest.skipUnless(os.name == "nt", "real Windows sharing control")
    def test_real_windows_reader_denied_delete_does_not_halt_v3(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            budget.publish_snapshot()
            file = Path(root) / "status.json"
            before = file.read_bytes()
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
            kernel.CreateFileW.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.CreateFileW(str(file), 0x80000000, 0x1 | 0x2, None, 3, 0, None)
            if handle == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                self.assertFalse(budget.publish_snapshot())
                self.assertEqual(budget.snapshot_warning["winerror"], 5)
                self.assertFalse(budget.persistence_failed)
                settle_one(budget)
                self.assertEqual(budget.status()["active"], 0)
                self.assertIsNone(budget.halted)
                self.assertEqual(file.read_bytes(), before)
            finally:
                kernel.CloseHandle(handle)
            self.assertTrue(budget.publish_snapshot())

    def test_admission_fsync_failure_halts_before_forwarding(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            token = budget.arm("diagnostics", "fsync-failure", 2)["requestToken"]
            with patch("budget_gateway_v3.os.fsync", side_effect=OSError(28, "synthetic disk fault")), self.assertRaises(OSError):
                budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
            self.assertTrue(budget.persistence_failed)
            self.assertEqual(budget.persistence_detail["errno"], 28)
            with self.assertRaises(v3.AdmissionError):
                budget.admit(token, 1, {})
            with self.assertRaises(ValueError):
                v3.Budget(root, True, "must not recover an unresolved admission")

    def test_receipt_fsync_failure_keeps_holds_and_does_not_retry_append(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            token = budget.arm("diagnostics", "receipt-failure", 2)["requestToken"]
            admission = budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})
            with patch("budget_gateway_v3.os.fsync", side_effect=OSError(28, "synthetic disk fault")), self.assertRaises(OSError):
                budget.settle(admission["seq"], {"usage": USAGE, "measuredUsd": ACTUAL})
            self.assertEqual(budget.reserved, 1)
            self.assertEqual(budget.spent, 0)
            self.assertIn(admission["seq"], budget.pending)
            self.assertFalse(budget.settle(admission["seq"], {"usage": USAGE, "measuredUsd": ACTUAL}))
            self.assertEqual(len((Path(root) / "receipts.jsonl").read_text().splitlines()), 1)

    def test_closed_diagnostic_console_cannot_undo_a_journal_halt(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            token = budget.arm("diagnostics", "closed-console", 1)["requestToken"]
            with patch("budget_gateway_v3.os.fsync", side_effect=OSError(28, "synthetic disk fault")), patch("builtins.print", side_effect=BrokenPipeError("synthetic closed console")), self.assertRaises(OSError):
                budget.admit(token, 1, {})
            self.assertTrue(budget.persistence_failed)
            self.assertEqual(budget.persistence_detail["errno"], 28)
            with self.assertRaises(v3.AdmissionError):
                budget.admit(token, .1, {})

    def test_explicit_recovery_audits_preserves_costs_and_does_not_clear_old_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            budget = v3.Budget(root)
            settle_one(budget, "saas-vector")
            status = budget.status()
            status["halted"] = v3.V2_PERSISTENCE_HALT
            (directory / "status.json").write_text(json.dumps(status))
            before = {name: (directory / name).read_bytes() for name in ("status.json", "admissions-v2.jsonl", "receipts.jsonl")}
            with self.assertRaises(ValueError):
                v3.Budget(root)
            recovered = v3.Budget(root, True, "reviewed Windows snapshot sharing failure with reconciled journals")
            self.assertAlmostEqual(recovered.spent, ACTUAL)
            self.assertAlmostEqual(recovered.actor_spent["saas-vector"], ACTUAL)
            self.assertEqual(recovered.seq, 1)
            self.assertIsNone(recovered.halted)
            self.assertEqual(before, {name: (directory / name).read_bytes() for name in before})
            audits = list(directory.glob("recovery-audit-v3-*.json"))
            self.assertEqual(len(audits), 1)
            audit = json.loads(audits[0].read_text())
            self.assertTrue(audit["exactJournalBytesFsynced"])
            self.assertEqual(audit["journalSha256"]["receipts.jsonl"], hashlib.sha256(before["receipts.jsonl"]).hexdigest())
            token = recovered.arm("diagnostics", "after-recovery", 1)["requestToken"]
            self.assertEqual(recovered.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})["seq"], 2)

    def test_recovery_refuses_unknown_receipt_wrong_price_or_unknown_halt(self):
        for case in ("unknown", "wrong-price", "unknown-halt"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                budget = v3.Budget(root)
                settle_one(budget)
                if case == "unknown-halt":
                    status = budget.status(); status["halted"] = "operator disabled spending"
                    (directory / "status.json").write_text(json.dumps(status))
                else:
                    receipt = json.loads((directory / "receipts.jsonl").read_text())
                    receipt["measuredUsd"] = None if case == "unknown" else .9
                    (directory / "receipts.jsonl").write_text(json.dumps(receipt) + "\n")
                with self.assertRaises(ValueError):
                    v3.Budget(root, True, "reviewed but invalid ledger must not recover")

    def test_recovery_fsync_failure_does_not_create_success_audit(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root); settle_one(budget)
            with patch("budget_gateway_v3.os.fsync", side_effect=OSError(28, "synthetic")), self.assertRaises(OSError):
                v3.Budget(root, True, "recovery cannot skip journal fsync failure")
            self.assertEqual(list(Path(root).glob("recovery-audit-v3-*.json")), [])

    def test_legacy_34_receipts_are_kept_and_next_admission_is_35(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            rows = [{"seq": seq, "model": v3.MODEL, "rates": v3.RATES, "usage": USAGE, "reservedUsd": 1,
                     "measuredUsd": ACTUAL, "cumulativeMeasuredUsd": seq * ACTUAL} for seq in range(1, 35)]
            (directory / "receipts.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
            (directory / "status.json").write_text(json.dumps({"active": 0, "reservedUsd": 0, "attempts": 34, "measuredUsd": 34 * ACTUAL}))
            budget = v3.Budget(root)
            token = budget.arm("diagnostics", "new", 1)["requestToken"]
            self.assertEqual(budget.admit(token, 1, {"model": v3.MODEL, "rates": v3.RATES})["seq"], 35)
            self.assertAlmostEqual(budget.spent, 34 * ACTUAL)

    def test_missing_or_mismatched_admission_and_partial_journal_refuse_recovery(self):
        for case in ("mismatch", "missing", "partial"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as root:
                directory = Path(root)
                budget = v3.Budget(root); settle_one(budget)
                file = directory / "admissions-v2.jsonl"
                if case == "mismatch":
                    admission = json.loads(file.read_text()); admission["actor"] = "saas-vector"
                    file.write_text(json.dumps(admission) + "\n")
                elif case == "missing":
                    file.write_text("")
                else:
                    file.write_text('{"unfinished":')
                with self.assertRaises(ValueError):
                    v3.Budget(root, True, "malformed ledger must not be recovered")

    def test_tokens_remain_immutable_and_reservations_still_enforce_phase_caps(self):
        with tempfile.TemporaryDirectory() as root:
            budget = v3.Budget(root)
            first = budget.arm("saas-vector", "first", 2)["requestToken"]
            second = budget.arm("saas-codex", "second", 2)["requestToken"]
            admitted = budget.admit(first, 19, {})
            self.assertEqual(admitted["actor"], "saas-vector")
            budget.settle(admitted["seq"], {"measuredUsd": 19})
            with self.assertRaises(v3.AdmissionError):
                budget.admit(first, 2, {})
            self.assertEqual(budget.admit(second, 19, {})["actor"], "saas-codex")
            budget.disarm(first)
            with self.assertRaises(v3.AdmissionError):
                budget.admit(first, .1, {})


if __name__ == "__main__":
    unittest.main()
