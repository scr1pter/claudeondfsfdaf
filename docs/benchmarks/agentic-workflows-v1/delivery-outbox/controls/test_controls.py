"""Known-good and deliberately faulty transcripts; no application runtime execution."""
import ast
import http.client
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluator"))
sys.path.insert(0, str(ROOT / "tools"))
from oracle import InstrumentFailure, ProductFailure, canonical_digest, loopback_origin, manifest, message, outbox_matches, page_request_denials, portable_bytes, provider_consistent, receipt_matches, runtime_projection, stable, verdict
from freeze_v1 import check, freeze, git_bytes, preview


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

    def test_unicode_body_limit_counts_codepoints_and_preserves_text(self):
        body = " \n" + "🙂" * 1996 + "\n "
        value = {**valid_message(), "body": body, "status": "draft", "delivery": None}
        self.assertEqual(message(value)["body"], body)
        with self.assertRaises(ProductFailure): message({**value, "body": "🙂" * 2001})

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

    def test_good_too_late_cancellation_has_no_wording_constraint(self):
        value = valid_message()
        value["delivery"].update(cancelRequested=True, lastError="Provider receipt precedes your request.")
        message(value)

    def test_too_late_cancellation_without_explanation_rejected(self):
        value = valid_message()
        value["delivery"]["cancelRequested"] = True
        with self.assertRaises(ProductFailure): message(value)

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

    def test_task_lifecycle_matches_manifest(self):
        marker = ROOT / "FREEZE-v1.json"
        if marker.exists():
            record = json.loads(marker.read_text(encoding="utf-8"))
            self.assertEqual(record["status"], "frozen")
            self.assertEqual(record["taskFileSha256"], preview(ROOT)["taskFileSha256"])
        else:
            self.assertIn(json.loads((ROOT / "task.json").read_text())["status"], ("draft-not-approved-for-paid-use", "pending-independent-freeze"))

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
                      "runtimeValidationPassed": True, "validationEvidenceSha256": "b" * 64, "runtimeProjectionSha256": canonical_digest(runtime_projection(root))}
            result = freeze(root, "a" * 40, record)
            self.assertEqual(result["status"], "frozen")
            self.assertEqual(result["taskFileSha256"], preview(root)["taskFileSha256"])
            with self.assertRaises(InstrumentFailure): freeze(root, "a" * 40, record)

    def test_freeze_check_rejects_missing_manifest_and_later_tamper(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-freeze-check-") as folder:
            root = Path(folder)
            with self.assertRaises(InstrumentFailure): check(root)
            (root / "synthetic.txt").write_bytes(b"synthetic\n")
            record = {"candidateFrozen": True, "candidateRef": "a" * 40, "independentTaskReviewed": True,
                      "runtimeValidationPassed": True, "validationEvidenceSha256": "b" * 64, "runtimeProjectionSha256": canonical_digest(runtime_projection(root))}
            freeze(root, "a" * 40, record)
            self.assertEqual(check(root)["status"], "verified")
            (root / "synthetic.txt").write_bytes(b"changed\n")
            with self.assertRaises(InstrumentFailure): check(root)

    def test_git_filter_byte_difference_is_rejected_without_execution(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-git-filter-") as folder:
            root = Path(folder).resolve()
            (root / "synthetic.txt").write_bytes(b"synthetic\n")
            answers = [SimpleNamespace(returncode=0, stdout=(str(root) + "\n").encode()),
                       SimpleNamespace(returncode=0, stdout=b"filtered-hash\n"),
                       SimpleNamespace(returncode=0, stdout=b"different-raw-hash\n")]
            with patch("freeze_v1.subprocess.run", side_effect=answers):
                with self.assertRaises(InstrumentFailure): git_bytes(root, ["synthetic.txt"], "filters")

    def test_actual_git_index_byte_comparison_control_without_execution(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-git-index-") as folder:
            root = Path(folder).resolve()
            (root / "synthetic.txt").write_bytes(b"synthetic\n")
            answers = [SimpleNamespace(returncode=0, stdout=(str(root) + "\n").encode()), SimpleNamespace(returncode=0, stdout=b"synthetic\n")]
            with patch("freeze_v1.subprocess.run", side_effect=answers):
                self.assertTrue(git_bytes(root, ["synthetic.txt"], "index")["physicalEqualsGitBytes"])

    def test_runtime_projection_is_bound_to_executable_contract(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-runtime-projection-") as folder:
            root = Path(folder)
            (root / "evaluator").mkdir()
            (root / "evaluator/check.py").write_bytes(b"first\n")
            before = runtime_projection(root)
            (root / "README.md").write_bytes(b"Metadata documentation\n")
            self.assertEqual(before, runtime_projection(root))
            (root / "evaluator/check.py").write_bytes(b"changed\n")
            self.assertNotEqual(before, runtime_projection(root))

    def test_freeze_rejects_stale_runtime_projection(self):
        with tempfile.TemporaryDirectory(prefix="outbox-pure-stale-evidence-") as folder:
            root = Path(folder)
            record = {"candidateFrozen": True, "candidateRef": "a" * 40, "independentTaskReviewed": True,
                      "runtimeValidationPassed": True, "validationEvidenceSha256": "b" * 64, "runtimeProjectionSha256": "c" * 64}
            with self.assertRaises(InstrumentFailure): freeze(root, "a" * 40, record)
            self.assertFalse((root / "FREEZE-v1.json").exists())

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

    def test_browser_environment_excludes_capabilities(self):
        from browser_driver import browser_environment
        value = browser_environment({"SystemRoot": "C:/Windows", "USERPROFILE": "C:/Synthetic", "BENCH_API_KEY": "synthetic-only", "OPENAI_API_KEY": "synthetic-only", "BUN_OPTIONS": "untrusted", "NODE_OPTIONS": "untrusted"})
        self.assertEqual(value, {"SystemRoot": "C:/Windows", "USERPROFILE": "C:/Synthetic"})

    @unittest.skipUnless(os.name == "nt", "Windows native path metadata control")
    def test_native_browser_paths_ignore_virtual_evaluation_home(self):
        from browser_driver import browser_environment
        virtual = r"C:\Synthetic\VirtualBenchmarkHome"
        with patch.dict(os.environ, {key: virtual for key in ("USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP")}):
            value = browser_environment()
        self.assertEqual(set(value), {"SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"})
        self.assertTrue(all(virtual not in item for item in value.values()))

    def test_proxy_only_background_noise_is_not_an_app_fault(self):
        self.assertEqual(page_request_denials({"blockedRequests": [{"origin": "https://background.invalid", "kind": "proxy-connect"}, {"origin": "http://background.invalid", "kind": "proxy"}]}), [])

    def test_actual_page_route_denial_remains_a_fault(self):
        denied = {"origin": "http://outside.invalid", "kind": "fetch"}
        self.assertEqual(page_request_denials({"blockedRequests": [{"origin": "https://background.invalid", "kind": "proxy-connect"}, denied]}), [denied])

    def test_owned_short_browser_cleanup_preserves_evidence(self):
        from browser_checks import Browser
        with tempfile.TemporaryDirectory(prefix="outbox-pure-profile-") as folder:
            root = Path(folder).resolve()
            work = root / "work"
            work.mkdir()
            parent = root / "outbox-browser-synthetic"
            profile = parent / "run"
            (profile / "screenshots").mkdir(parents=True)
            (profile / "screenshots/evidence.png").write_bytes(b"synthetic-not-an-image")
            profile.with_suffix(".stderr.log").write_bytes(b"synthetic log\n")
            browser = Browser.__new__(Browser)
            browser.temp_root, browser.profile_parent, browser.profile_output, browser.app, browser.owned_profile = root, parent, profile, SimpleNamespace(work=work), True
            browser.cleanup_profile()
            self.assertFalse(parent.exists())
            self.assertEqual((work / "browser-screenshots/evidence.png").read_bytes(), b"synthetic-not-an-image")
            self.assertEqual((work / "browser-driver.stderr.log").read_bytes(), b"synthetic log\n")

    def test_browser_cleanup_rejects_unowned_target(self):
        from browser_checks import Browser
        with tempfile.TemporaryDirectory(prefix="outbox-pure-profile-guard-") as folder:
            root = Path(folder).resolve()
            profile = root / "user-data"
            profile.mkdir()
            browser = Browser.__new__(Browser)
            browser.temp_root, browser.profile_parent, browser.profile_output, browser.app, browser.owned_profile = root, profile, profile / "run", SimpleNamespace(work=root), True
            with self.assertRaises(InstrumentFailure): browser.cleanup_profile()
            self.assertTrue(profile.exists())

    def test_preexisting_prefix_directory_is_not_owned(self):
        from browser_checks import Browser
        with tempfile.TemporaryDirectory(prefix="outbox-pure-existing-profile-") as folder:
            root = Path(folder).resolve()
            parent = root / "outbox-browser-preexisting"
            parent.mkdir()
            browser = Browser.__new__(Browser)
            browser.temp_root, browser.profile_parent, browser.profile_output, browser.app, browser.owned_profile = root, parent, parent / "run", SimpleNamespace(work=root), False
            browser.cleanup_profile()
            self.assertTrue(parent.exists())

    def test_owned_browser_cleanup_retries_observed_file_lock(self):
        import shutil
        from browser_checks import Browser
        with tempfile.TemporaryDirectory(prefix="outbox-pure-profile-lock-") as folder:
            root = Path(folder).resolve()
            parent, work = root / "outbox-browser-owned", root / "work"
            parent.mkdir()
            work.mkdir()
            browser = Browser.__new__(Browser)
            browser.temp_root, browser.profile_parent, browser.profile_output, browser.app, browser.owned_profile = root, parent, parent / "run", SimpleNamespace(work=work), True
            remove = shutil.rmtree
            calls = []
            def locked_once(path):
                calls.append(path)
                if len(calls) == 1: raise PermissionError("Synthetic transient owned-file lock")
                remove(path)
            with patch("browser_checks.shutil.rmtree", side_effect=locked_once), patch("browser_checks.time.sleep"):
                browser.cleanup_profile()
            self.assertEqual(len(calls), 2)
            self.assertFalse(parent.exists())

    def test_maximum_resource_id_gets_valid_admission_id(self):
        from runtime import App
        app = App.__new__(App)
        captured = []
        def api(path, method, body, expected):
            captured.append(body["requestId"])
            return {"message": valid_message("queued", 0)}
        app.api = api
        app.send("x" * 80)
        self.assertLessEqual(len(captured[0]), 80)
        self.assertTrue(captured[0])

    def test_overlap_barrier_fires_after_request_write(self):
        from email.message import Message
        import threading
        from runtime import request
        event = threading.Event()
        calls = []
        class Response:
            status = 200
            headers = Message()
            headers["Content-Type"] = "application/json"
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _size): return b"{}"
        class Connection:
            def request(self, *_args, **_kwargs):
                self.assert_event_unset = not event.is_set()
                calls.append("written")
            def getresponse(self):
                if not event.is_set(): raise AssertionError("Barrier fired before request write")
                calls.append("response")
                return Response()
            def close(self): calls.append("closed")
        connection = Connection()
        with patch("runtime.http.client.HTTPConnection", return_value=connection):
            self.assertEqual(request("http://127.0.0.1:4124", "/api/outbox/drain", "POST", {}, sent_event=event), (200, {}))
        self.assertTrue(connection.assert_event_unset)
        self.assertEqual(calls, ["written", "response", "closed"])

    def test_dead_app_provider_disconnect_is_product_failure(self):
        from runtime import App
        app = App.__new__(App)
        app.provider, app.process = "http://127.0.0.1:4124", SimpleNamespace(poll=lambda: 7, returncode=7)
        with patch("runtime.request", side_effect=OSError("Synthetic disconnect")):
            with self.assertRaises(ProductFailure): app.control("/control/state")

    def test_live_app_provider_control_fault_is_instrument_failure(self):
        from runtime import App
        app = App.__new__(App)
        app.provider, app.process = "http://127.0.0.1:4124", SimpleNamespace(poll=lambda: None)
        with patch("runtime.request", side_effect=OSError("Synthetic disconnect")):
            with self.assertRaises(InstrumentFailure): app.control("/control/state")

    def test_malformed_and_truncated_app_http_is_product_failure(self):
        from runtime import App
        app = App.__new__(App)
        app.origin = "http://127.0.0.1:4123"
        for failure in (http.client.IncompleteRead(b"synthetic", 20), http.client.BadStatusLine("synthetic invalid status")):
            with patch("runtime.request", side_effect=failure):
                with self.assertRaises(ProductFailure): app.api("/api/tickets")

    def test_truncated_trusted_driver_http_is_instrument_failure(self):
        from browser_checks import Browser
        browser = Browser.__new__(Browser)
        browser.driver = SimpleNamespace(metadata={"endpoint": "http://127.0.0.1:4124"}, token="synthetic-local-token-only")
        with patch("browser_checks.request", side_effect=http.client.IncompleteRead(b"synthetic", 20)):
            with self.assertRaises(InstrumentFailure): browser.action({"action": "observe"})

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
