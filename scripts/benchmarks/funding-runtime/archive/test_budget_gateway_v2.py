import json
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from budget_gateway_v2 import ACTOR_LIMITS, Budget, CONTEXT, MODEL, OUTPUT, AdmissionError, prepare, price, handler


class BudgetTests(unittest.TestCase):
    def usage(self, inputs=12000, output=200, reads=4000, writes=7000):
        return {"input_tokens": inputs, "output_tokens": output, "input_tokens_details": {"cached_tokens": reads, "cache_write_tokens": writes}}

    def test_actual_short_and_long_context_rates(self):
        self.assertAlmostEqual(price(self.usage()), .0219)
        self.assertAlmostEqual(price(self.usage(300000, 1000, 100000, 190000)), 1.025)

    def test_missing_usage_and_unadmitted_lifetimes_are_unknown(self):
        for usage in ({}, None, {**self.usage(), "input_tokens_details": {"cached_tokens": 0}}, {**self.usage(), "input_tokens_details": {"cached_tokens": 4000, "cache_write_tokens": 7000, "cache_write_tokens_details": {"ttl_12h_tokens": 100, "ttl_30m_tokens": 6900}}}):
            with self.subTest(usage=usage), self.assertRaises(ValueError):
                price(usage)

    def test_preserves_helper_cap_and_limits_larger_output(self):
        for requested, expected in ((512, 512), (64000, OUTPUT)):
            wire, reserve = prepare({"model": MODEL, "input": "hello", "max_output_tokens": requested})
            self.assertEqual(json.loads(wire)["max_output_tokens"], expected)
            self.assertGreater(reserve, expected * 15 / 1000000)

    def test_screenshots_reserve_model_context_not_compressed_bytes(self):
        _, reserve = prepare({"model": MODEL, "input": [{"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,eA=="}]}]})
        self.assertAlmostEqual(reserve, (CONTEXT * 5 + OUTPUT * 15) / 1000000)

    def test_refuses_external_services_hidden_context_and_12h(self):
        for patch in ({"model": "other"}, {"service_tier": "fast"}, {"previous_response_id": "x"}, {"context_management": [{"type": "compaction"}]}, {"tools": [{"type": "web_search"}]}, {"input": [{"type": "item_reference", "id": "x"}]}, {"input": [{"type": "input_image", "image_url": "https://example.invalid/x"}]}, {"prompt_cache_options": {"ttl": "12h"}}):
            with self.subTest(patch=patch), self.assertRaises(AdmissionError):
                prepare({"model": MODEL, "input": "hello", **patch})

    def test_concurrent_helpers_reserve_and_settle_against_same_actor(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            first = budget.admit(token, 6, {})
            second = budget.admit(token, 6, {})
            self.assertEqual(len(budget.pending), 2)
            self.assertAlmostEqual(budget.actor_reserved["saas-vector"], 12)
            budget.settle(first["seq"], {"measuredUsd": .03})
            budget.settle(second["seq"], {"measuredUsd": .04})
            self.assertAlmostEqual(budget.spent, .07)
            self.assertAlmostEqual(budget.actor_spent["saas-vector"], .07)
            self.assertAlmostEqual(budget.reserved, 0)

    def test_temporary_reservation_pressure_waits_instead_of_false_failure(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            first = budget.admit(token, 12, {})
            entered = threading.Event()
            finished = threading.Event()
            received = []
            def helper():
                entered.set()
                received.append(budget.admit(token, 12, {}))
                finished.set()
            thread = threading.Thread(target=helper, daemon=True)
            thread.start()
            self.assertTrue(entered.wait(1))
            budget.settle(first["seq"], {"measuredUsd": .03})
            self.assertTrue(finished.wait(2))
            budget.settle(received[0]["seq"], {"measuredUsd": .02})
            thread.join(1)
            self.assertAlmostEqual(budget.spent, .05)

    def test_disarm_and_rearm_cannot_reattribute_old_attempt(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            vector = budget.arm("saas-vector", "first", 100)["requestToken"]
            first = budget.admit(vector, 6, {})
            budget.disarm(vector)
            codex = budget.arm("saas-codex", "second", 100)["requestToken"]
            second = budget.admit(codex, 6, {})
            with self.assertRaises(AdmissionError):
                budget.admit(vector, 1, {})
            budget.settle(first["seq"], {"measuredUsd": .03})
            self.assertFalse(budget.settle(first["seq"], {"measuredUsd": .03}))
            budget.settle(second["seq"], {"measuredUsd": .04})
            self.assertAlmostEqual(budget.actor_spent["saas-vector"], .03)
            self.assertAlmostEqual(budget.actor_spent["saas-codex"], .04)
            receipts = [json.loads(row) for row in (Path(root) / "receipts.jsonl").read_text().splitlines()]
            self.assertEqual([row["label"] for row in receipts], ["first", "second"])

    def test_unknown_receipt_retains_reservation_and_halts(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            attempt = budget.admit(token, 6, {})
            budget.settle(attempt["seq"], {"measuredUsd": None})
            self.assertEqual(budget.reserved, 6)
            with self.assertRaises(AdmissionError):
                budget.admit(token, 1, {})
            with self.assertRaises(ValueError):
                Budget(root)

    def test_crash_admission_is_not_silently_refunded(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            budget.admit(token, 6, {})
            with self.assertRaises(ValueError):
                Budget(root)

    def test_resume_legacy_receipts_without_resetting_or_repricing(self):
        with tempfile.TemporaryDirectory() as root:
            receipts = [{"seq": seq, "measuredUsd": .01, "label": "old", "rates": {"input": 999}} for seq in range(1, 35)]
            (Path(root) / "receipts.jsonl").write_text("\n".join(json.dumps(row) for row in receipts) + "\n")
            (Path(root) / "status.json").write_text(json.dumps({"active": 0, "reservedUsd": 0, "attempts": 34, "measuredUsd": .34}))
            budget = Budget(root)
            self.assertAlmostEqual(budget.spent, .34)
            self.assertAlmostEqual(budget.actor_spent["diagnostics"], .34)
            token = budget.arm("saas-vector", "new", 100)["requestToken"]
            self.assertEqual(budget.admit(token, 6, {})["seq"], 35)

    def test_actor_and_study_caps_include_all_prior_costs(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            for actor, amount in (("saas-vector", 19), ("saas-codex", 19), ("diagnostics", 7)):
                token = budget.arm(actor, actor, 100)["requestToken"]
                attempt = budget.admit(token, amount, {})
                budget.settle(attempt["seq"], {"measuredUsd": amount})
            self.assertAlmostEqual(budget.spent, 45)
            token = budget.arm("saas-vector", "again", 100)["requestToken"]
            with self.assertRaises(AdmissionError):
                budget.admit(token, 2, {})
            self.assertAlmostEqual(sum(ACTOR_LIMITS.values()), 48)

    def test_admission_fsync_failure_halts_before_any_more_admissions(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            with patch("budget_gateway_v2.os.fsync", side_effect=OSError("synthetic disk fault")), self.assertRaises(OSError):
                budget.admit(token, 6, {})
            self.assertTrue(budget.persistence_failed)
            with self.assertRaises(AdmissionError):
                budget.admit(token, 1, {})

    def test_receipt_fsync_failure_retains_reservation_and_never_retries_append(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            attempt = budget.admit(token, 6, {})
            with patch("budget_gateway_v2.os.fsync", side_effect=OSError("synthetic disk fault")), self.assertRaises(OSError):
                budget.settle(attempt["seq"], {"measuredUsd": .03})
            self.assertAlmostEqual(budget.reserved, 6)
            self.assertAlmostEqual(budget.spent, 0)
            self.assertIn(attempt["seq"], budget.pending)
            self.assertFalse(budget.settle(attempt["seq"], {"measuredUsd": .03}))
            self.assertEqual(len((Path(root) / "receipts.jsonl").read_text().splitlines()), 1)
            with self.assertRaises(AdmissionError):
                budget.admit(token, 1, {})

    def test_status_replace_failure_also_latches_halt(self):
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "build", 100)["requestToken"]
            with patch("budget_gateway_v2.os.replace", side_effect=OSError("synthetic rename fault")), self.assertRaises(OSError):
                budget.admit(token, 6, {})
            self.assertAlmostEqual(budget.reserved, 6)
            self.assertTrue(budget.persistence_failed)
            with self.assertRaises(AdmissionError):
                budget.admit(token, 1, {})

    def test_real_http_terminal_settles_before_socket_eof_and_next_call_succeeds(self):
        tail = threading.Event()
        counter = {"calls": 0}
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                counter["calls"] += 1
                number = counter["calls"]
                payload = ("data: " + json.dumps({"type": "response.completed", "response": {"id": "synthetic-" + str(number), "status": "completed", "service_tier": "default", "usage": {"input_tokens": 100, "output_tokens": 10, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 100}}}}) + "\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload) + 1))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()
                if number == 1:
                    tail.wait(5)
                self.wfile.write(b"\n")
                self.wfile.flush()
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory() as root:
            budget = Budget(root)
            token = budget.arm("saas-vector", "tail-race", 100)["requestToken"]
            gateway = ThreadingHTTPServer(("127.0.0.1", 0), handler(budget, "synthetic-provider-key", "synthetic-controller", lambda: http.client.HTTPConnection("127.0.0.1", upstream.server_port, timeout=5)))
            gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
            gateway_thread.start()
            first = http.client.HTTPConnection("127.0.0.1", gateway.server_port, timeout=5)
            second = http.client.HTTPConnection("127.0.0.1", gateway.server_port, timeout=5)
            try:
                body = json.dumps({"model": MODEL, "input": "synthetic", "stream": True})
                headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
                first.request("POST", "/v1/responses", body=body, headers=headers)
                response = first.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b"response.completed", response.readline())
                self.assertAlmostEqual(budget.spent, .00035)
                self.assertEqual(len(budget.pending), 0)
                self.assertFalse(tail.is_set())
                second.request("POST", "/v1/responses", body=body, headers=headers)
                reply = second.getresponse()
                self.assertEqual(reply.status, 200)
                reply.read()
                self.assertAlmostEqual(budget.spent, .0007)
                self.assertEqual(counter["calls"], 2)
            finally:
                tail.set()
                first.close()
                second.close()
                gateway.shutdown()
                gateway.server_close()
        upstream.shutdown()
        upstream.server_close()


if __name__ == "__main__":
    unittest.main()
