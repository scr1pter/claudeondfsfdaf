"""Known-good and deliberately faulty transcripts; no application runtime execution."""
import ast
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluator"))
sys.path.insert(0, str(ROOT / "tools"))
from oracle import InstrumentFailure, ProductFailure, canonical_digest, loopback_origin, manifest, message, outbox_matches, portable_bytes, provider_consistent, receipt_matches, stable, verdict
from freeze_v1 import freeze, preview


def valid_message(status="delivered", attempts=2):
    return {"id": "message-1", "ticketId": "t-101", "body": "A synthetic reply", "status": status,
            "delivery": {"idempotencyKey": "stable-key-1", "attempts": attempts,
                         "receiptId": "receipt-1" if status == "delivered" else None,
                         "lastError": "Unknown response" if status == "retryable" else None,
                         "cancelRequested": status == "cancelled"}}


def valid_state(attempts=2):
    envelope = {"idempotencyKey": "stable-key-1", "messageId": "message-1", "ticketId": "t-101", "body": "A synthetic reply"}
    return {"receipts": [{**envelope, "id": "receipt-1"}], "cancellations": [], "held": [], "plans": [], "cancelPlans": [],
            "attempts": [{"seq": index + 1, "key": envelope["idempotencyKey"], "message_id": envelope["messageId"], "envelope": deepcopy(envelope)} for index in range(attempts)]}


class TranscriptControls(unittest.TestCase):
    def test_good_accepted_replay(self):
        receipt_matches(valid_message(), valid_state())

    def test_duplicate_provider_effect_same_key_rejected(self):
        state = valid_state()
        state["receipts"].append({**state["receipts"][0], "id": "receipt-duplicate"})
        with self.assertRaises(ProductFailure): provider_consistent(state)

    def test_rotating_key_same_message_rejected(self):
        state = valid_state()
        state["receipts"].append({**state["receipts"][0], "id": "receipt-duplicate", "idempotencyKey": "fresh-key"})
        with self.assertRaises(ProductFailure): provider_consistent(state)

    def test_fabricated_receipt_rejected(self):
        value = valid_message()
        value["delivery"]["receiptId"] = "made-up-receipt"
        with self.assertRaises(ProductFailure): receipt_matches(value, valid_state())

    def test_mutated_accepted_body_rejected(self):
        state = valid_state()
        state["receipts"][0]["body"] = "A different body"
        with self.assertRaises(ProductFailure): receipt_matches(valid_message(), state)

    def test_missing_wire_attempt_rejected(self):
        with self.assertRaises(ProductFailure): receipt_matches(valid_message(attempts=1), valid_state())

    def test_replay_key_rotation_rejected(self):
        state = valid_state()
        state["attempts"][1]["key"] = "rotated-key"
        state["attempts"][1]["envelope"]["idempotencyKey"] = "rotated-key"
        with self.assertRaises(ProductFailure): receipt_matches(valid_message(), state)

    def test_wire_payload_mutation_rejected(self):
        state = valid_state()
        state["attempts"][0]["envelope"]["body"] = "A mutated first attempt"
        with self.assertRaises(ProductFailure): receipt_matches(valid_message(), state)

    def test_attempt_log_envelope_disagreement_rejected(self):
        state = valid_state()
        state["attempts"][0]["key"] = "wrong-log-key"
        with self.assertRaises(ProductFailure): provider_consistent(state)

    def test_decreasing_attempts_rejected(self):
        with self.assertRaises(ProductFailure): stable(valid_message("retryable", 2), valid_message("queued", 1))

    def test_good_retry_preserves_envelope(self):
        stable(valid_message("queued", 0), valid_message("retryable", 1))
        stable(valid_message("retryable", 1), valid_message("delivered", 2))

    def test_mutated_admitted_body_rejected(self):
        after = valid_message()
        after["body"] = "Edited after admission"
        with self.assertRaises(ProductFailure): stable(valid_message("queued", 0), after)

    def test_false_delivery_without_receipt_rejected(self):
        value = valid_message()
        value["delivery"]["receiptId"] = None
        with self.assertRaises(ProductFailure): message(value)

    def test_retryable_without_error_rejected(self):
        value = valid_message("retryable")
        value["delivery"]["lastError"] = "   "
        with self.assertRaises(ProductFailure): message(value)

    def test_cancelled_with_receipt_rejected(self):
        value = valid_message("cancelled")
        value["delivery"]["receiptId"] = "receipt-1"
        with self.assertRaises(ProductFailure): message(value)

    def test_boolean_attempt_count_rejected(self):
        value = valid_message()
        value["delivery"]["attempts"] = True
        with self.assertRaises(ProductFailure): message(value)

    def test_missing_required_metadata_rejected(self):
        for key in ("receiptId", "lastError", "cancelRequested"):
            value = valid_message()
            del value["delivery"][key]
            with self.assertRaises(ProductFailure): message(value)

    def test_good_cancelled_transcript(self):
        state = valid_state(1)
        state["receipts"] = []
        state["cancellations"] = ["stable-key-1"]
        provider_consistent(state)
        message(valid_message("cancelled", 1))

    def test_acceptance_and_tombstone_collision_rejected(self):
        state = valid_state()
        state["cancellations"] = ["stable-key-1"]
        with self.assertRaises(ProductFailure): provider_consistent(state)

    def test_good_outbox_membership(self):
        outbox_matches([valid_message()], ["message-1"])

    def test_duplicate_outbox_membership_rejected(self):
        with self.assertRaises(ProductFailure): outbox_matches([valid_message(), valid_message()], ["message-1"])

    def test_missing_admitted_work_rejected(self):
        with self.assertRaises(ProductFailure): outbox_matches([], ["message-1"])

    def test_exact_loopback_origin_accepted(self):
        self.assertEqual(loopback_origin("http://127.0.0.1:4124/"), "http://127.0.0.1:4124")

    def test_external_and_credentialed_origins_rejected(self):
        for origin in ("https://127.0.0.1:4124", "http://localhost:4124", "http://example.test:4124", "http://127.0.0.1:4124/path", "http://user:pass@127.0.0.1:4124", "http://127.0.0.1:4124?token=x", "http://127.0.0.1:4124#x", "http://127.0.0.1:0"):
            with self.assertRaises(ProductFailure): loopback_origin(origin)


class InstrumentControls(unittest.TestCase):
    def setUp(self):
        self.inventory = json.loads((ROOT / "inventory.json").read_text(encoding="utf-8"))["checks"]
        self.rows = [{"name": row["name"], "status": "passed"} for row in self.inventory]

    def test_complete_passed_report(self):
        self.assertEqual(verdict(self.rows, self.inventory), "passed")

    def test_known_product_fault_report(self):
        self.rows[0]["status"] = "failed"
        self.assertEqual(verdict(self.rows, self.inventory), "product_failure")

    def test_incomplete_inventory_is_instrument_failure(self):
        self.assertEqual(verdict(self.rows[:-1], self.inventory), "instrument_failure")

    def test_duplicate_inventory_is_instrument_failure(self):
        self.rows[-1]["name"] = self.rows[0]["name"]
        self.assertEqual(verdict(self.rows, self.inventory), "instrument_failure")

    def test_modified_source_is_instrument_failure(self):
        self.assertEqual(verdict(self.rows, self.inventory, unchanged=False), "instrument_failure")

    def test_all_skipped_is_not_product_failure(self):
        for row in self.rows: row["status"] = "not_run"
        self.assertEqual(verdict(self.rows, self.inventory), "instrument_failure")

    def test_infrastructure_fault_overrides_product_fault(self):
        self.rows[0]["status"] = "failed"
        self.assertEqual(verdict(self.rows, self.inventory, infrastructure_error="browser unavailable"), "instrument_failure")

    def test_generated_exclusion_is_exact(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-manifest-") as folder:
            root = Path(folder)
            (root / "dist").mkdir()
            (root / "dist/generated.txt").write_text("generated\n", encoding="utf-8")
            (root / "nested/dist").mkdir(parents=True)
            (root / "nested/dist/authored.txt").write_text("authored\n", encoding="utf-8")
            first = manifest(root)
            self.assertEqual(list(first), ["nested/dist/authored.txt"])
            (root / "nested/dist/authored.txt").write_text("changed\n", encoding="utf-8")
            self.assertNotEqual(first, manifest(root))

    def test_lf_bytes_required(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-lf-") as folder:
            path = Path(folder) / "text.txt"
            path.write_bytes(b"portable\n")
            self.assertEqual(portable_bytes(path), b"portable\n")
            path.write_bytes(b"nonportable\r\n")
            with self.assertRaises(InstrumentFailure): portable_bytes(path)

    def test_preview_is_read_only_and_reproducible(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-preview-") as folder:
            root = Path(folder)
            (root / "z.txt").write_bytes(b"z\n")
            (root / "a.txt").write_bytes(b"a\n")
            before = manifest(root)
            first = preview(root)
            self.assertEqual(first, preview(root))
            self.assertEqual(first["taskSha256"], canonical_digest(before))
            self.assertEqual(before, manifest(root))
            self.assertEqual(first["status"], "draft-preview-not-a-freeze")

    def test_actual_task_has_no_freeze(self):
        self.assertFalse((ROOT / "FREEZE-v1.json").exists())
        self.assertEqual(json.loads((ROOT / "task.json").read_text())["status"], "draft-not-approved-for-paid-use")

    def test_freeze_requires_candidate_and_runtime_evidence(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-freeze-guard-") as folder:
            root = Path(folder)
            (root / "synthetic.txt").write_bytes(b"synthetic\n")
            for reference, record in ((None, {}), ("a" * 40, {}), ("a" * 40, {"candidateFrozen": True, "candidateRef": "a" * 40, "independentTaskReviewed": True})):
                with self.assertRaises(InstrumentFailure): freeze(root, reference, record)
            self.assertFalse((root / "FREEZE-v1.json").exists())

    def test_synthetic_freeze_is_versioned_and_non_overwriting(self):
        # This temporary one-file fixture is not the benchmark task.
        with tempfile.TemporaryDirectory(prefix="outbox-pure-synthetic-freeze-") as folder:
            root = Path(folder)
            (root / "synthetic.txt").write_bytes(b"synthetic\n")
            record = {"candidateFrozen": True, "candidateRef": "a" * 40, "independentTaskReviewed": True,
                      "runtimeValidationPassed": True, "validationEvidenceSha256": "b" * 64}
            result = freeze(root, "a" * 40, record)
            self.assertEqual(result["status"], "frozen")
            self.assertEqual(result["taskFileSha256"], preview(root)["taskFileSha256"])
            with self.assertRaises(InstrumentFailure): freeze(root, "a" * 40, record)

    def test_rejected_output_is_never_written(self):
        from evaluate import run
        with tempfile.TemporaryDirectory(prefix="outbox-pure-rejected-output-") as folder:
            root = Path(folder)
            app = root / "app"
            app.mkdir()
            options = SimpleNamespace(task=ROOT, app=app, out=app, bun=root / "missing-bun", node=root / "missing-node")
            with redirect_stdout(io.StringIO()): self.assertEqual(run(options), 2)
            self.assertEqual(list(app.iterdir()), [])

    def test_python_sources_parse_without_execution(self):
        for path in ROOT.rglob("*.py"):
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    def test_descriptor_and_inventory_match_shared_runner(self):
        import api_checks
        import browser_checks
        descriptor = json.loads((ROOT / "task.json").read_text(encoding="utf-8"))
        self.assertEqual((len(api_checks.CHECKS), len(browser_checks.CHECKS)), (18, 8))
        self.assertEqual((descriptor["expectedApiGroups"], descriptor["expectedBrowserChecks"]), (18, 8))
        self.assertEqual(len({row["name"] for row in self.inventory}), 26)
        self.assertEqual([row["kind"] for row in self.inventory], ["api"] * 18 + ["browser"] * 8)
        self.assertEqual(set(descriptor["environment"]), {"PORT", "DATA_DIR"})
        self.assertEqual(descriptor["environment"]["PORT"], "4123")
        for argument in descriptor["evaluatorCommand"]:
            argument.format_map({name: "placeholder" for name in ("app", "out", "bun", "node", "task", "python")})
        for name in descriptor["protectedFiles"]:
            self.assertTrue((ROOT / "seed" / name).is_file(), name)

    def test_all_authored_task_files_use_portable_lf(self):
        for name in manifest(ROOT, generated=("FREEZE-v1.json",)):
            portable_bytes(ROOT / name)


if __name__ == "__main__":
    unittest.main()
