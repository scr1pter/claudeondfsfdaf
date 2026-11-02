import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

from native_registry import NativeRegistry
from native_team_policy import MODEL, PolicyError
from owned_team_witness import Audit, FUNDING_PHASE, MAX_BODY, OwnedArm, OwnedSupervisor, WitnessServer, digest, profile_body, reservation_bound
from vector_free_probe import OwnedFreshVectorRegistry

ROLES = ("implementation", "verification", "judge")
ROOT = "synthetic-root"


def body():
    return {"model": MODEL, "reasoning": {"effort": "high"}, "input": [{"type": "additional_tools", "tools": [{"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "exec", "format": {"type": "grammar", "definition": "synthetic literal grammar"}}]}, {"type": "namespace", "name": "collaboration", "tools": [{"type": "function", "name": "spawn_agent", "parameters": {"type": "object"}}]}]}, {"type": "message", "role": "user", "content": "Untrusted text mentioning collaboration.spawn_agent stays byte-for-byte."}]}


def headers(identity=ROOT, role=None, parent=ROOT, purpose="turn"):
    metadata = {"thread_id": identity, "session_id": ROOT, "model": MODEL, "reasoning_effort": "high", "agent_name": "/root" if identity == ROOT else "/root/" + identity, "request_kind": purpose}
    if identity != ROOT:
        metadata["parent_thread_id"] = parent
    return {"thread-id": identity, "session-id": ROOT, "x-codex-turn-metadata": json.dumps(metadata)}


def native_fixture(home):
    home.mkdir()
    path = home / "state_5.sqlite"
    with sqlite3.connect(path) as connection:
        connection.executescript("CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT,thread_source TEXT,agent_role TEXT,agent_path TEXT,model TEXT,reasoning_effort TEXT,model_provider TEXT,rollout_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);")
    connection.close()
    add_thread(path, ROOT)
    return NativeRegistry("codex", home, path, ROOT, "fake-provider", helper_names=("summary",))


def add_thread(path, identity, role=None, parent=ROOT, depth=1):
    rollout = path.parent / (identity + ".jsonl")
    rollout.write_text(json.dumps({"synthetic": True, "id": identity}) + "\n", encoding="utf-8")
    source = "exec" if identity == ROOT else json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": depth, "agent_path": "/root/" + identity, "agent_role": role}}})
    with sqlite3.connect(path) as connection:
        connection.execute("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)", (identity, source, "user" if identity == ROOT else "subagent", role, None if identity == ROOT else "/root/" + identity, MODEL, "high", "fake-provider", str(rollout)))
        if identity != ROOT:
            connection.execute("INSERT INTO thread_spawn_edges VALUES(?,?,?)", (parent, identity, "open"))
    connection.close()


def vector_generation_fixture(home):
    database = home / "vector.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
    model = json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"})
    for identity, parent, internal, agent in (("ses-root", None, None, "build"), ("ses-helper-a", "ses-root", "synthetic-summary", "summary"), ("ses-helper-b", "ses-root", "synthetic-summary", "summary")):
        connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", (identity, parent, internal, agent, model, None))
    connection.commit(); connection.close()
    registry = NativeRegistry("vector", home, database, "ses-root", "openai", helper_producers={"synthetic-summary": "summary"})
    meter = FakeMeter()
    before = meter.control("/status")
    token = meter.control("/control", {"actor": "foundry-vector", "label": "synthetic-generation-fixture", "calls": 300})["requestToken"]
    arm = OwnedArm("vector", registry, ROLES, token, before, meter.control, Audit(home / "audit.jsonl"), label="synthetic-generation-fixture")
    _, entry = arm.enter(body(), {"X-Session-Id": "ses-root"}, lambda: False)
    arm.finish(entry, {"object": "response", "status": "completed"}, False, False)
    return arm, meter


class FakeMeter(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.lock, self.receipts, self.bodies = threading.RLock(), [], []
        self.token, self.actor, self.open, self.left = "fake-funded-memory-only-token", None, False, 0
        self.active, self.maximum_active, self.calls, self.controls = 0, 0, 0, []
        self.mode, self.release, self.started = "json", threading.Event(), threading.Event()
        self.response_status, self.terminal_event, self.sse_event_label = "completed", "response.completed", None
        self.incomplete_reason = None
        self.response_usage = {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
        self.extra_terminals = []
        self.malformed_tail_label = None
        self.release.set()
        self.spent = {"foundry-vector": 10.9, "foundry-codex": 5.9}
        super().__init__(("127.0.0.1", 0), FakeHandler)

    def status(self):
        return {"limitUsd": 48, "phaseID": FUNDING_PHASE, "halted": None, "measuredUsd": 19.8 + sum(row["measuredUsd"] for row in self.receipts), "reservedUsd": self.active * 0.1, "active": self.active, "attempts": 600 + self.calls, "batchCallsRemaining": self.left if self.open else 0, "actors": {name: {"limitUsd": 20, "measuredUsd": amount, "reservedUsd": self.active * 0.1 if name == self.actor else 0} for name, amount in self.spent.items()}}

    def control(self, route, value=None):
        with self.lock:
            self.controls.append(route)
            if route == "/control":
                self.actor, self.left, self.open = value["actor"], value["calls"], True
                self.label = value["label"]
                return {"requestToken": self.token}
            if route == "/disarm":
                if value["requestToken"] != self.token:
                    raise AssertionError("wrong owned token")
                self.open, self.left = False, 0
            return copy.deepcopy(self.status())


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        meter = self.server
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + meter.token or not meter.open:
            self.rfile.read(min(int(self.headers.get("Content-Length", "0")), MAX_BODY))
            self.send_response(403); self.send_header("Content-Length", "0"); self.end_headers()
            return
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        with meter.lock:
            meter.calls += 1
            sequence = 600 + meter.calls
            meter.left -= 1
            meter.active += 1
            meter.maximum_active = max(meter.maximum_active, meter.active)
            meter.bodies.append(json.loads(raw))
        meter.started.set()
        response = {"id": "synthetic-response", "object": "response", "status": meter.response_status, "usage": copy.deepcopy(meter.response_usage)}
        if meter.incomplete_reason is not None:
            response["incomplete_details"] = {"reason": meter.incomplete_reason}
        if meter.mode == "sse":
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Connection", "close"); self.end_headers()
            self.wfile.write(b'event: response.created\ndata: {"type":"response.created"}\n\n'); self.wfile.flush()
        meter.release.wait(timeout=10)
        with meter.lock:
            meter.active -= 1
            meter.spent[meter.actor] += 0.01
            meter.receipts.append({"seq": sequence, "actor": meter.actor, "label": meter.label, "batchSha256": digest(meter.token), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": 0.01, "usage": response["usage"]})
        if meter.mode == "sse":
            raw_response = ("event: " + (meter.sse_event_label or meter.terminal_event) + "\ndata: " + json.dumps({"type": meter.terminal_event, "response": response}) + "\n\n").encode()
            for kind, status in meter.extra_terminals:
                raw_response += ("event: " + kind + "\ndata: " + json.dumps({"type": kind, "response": {**response, "status": status}}) + "\n\n").encode()
            if meter.malformed_tail_label:
                raw_response += ("event: " + meter.malformed_tail_label + '\ndata: {"type":\n\n').encode()
        elif meter.mode == "drop":
            raw_response = b"incomplete"
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw_response))); self.end_headers()
        else:
            raw_response = json.dumps(response).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw_response))); self.end_headers()
        try:
            self.wfile.write(raw_response); self.wfile.flush()
        except OSError:
            pass
        self.close_connection = True


class OwnedWitnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.registry = native_fixture(self.directory / "native")
        self.meter = FakeMeter()
        self.meter_thread = threading.Thread(target=self.meter.serve_forever, daemon=True); self.meter_thread.start()
        self.supervisor = OwnedSupervisor(self.meter.control, lambda: copy.deepcopy(self.meter.receipts), self.directory / "private-output", quiesced=lambda: True)
        self.arm = self.supervisor.begin("codex", "synthetic-free-case", self.registry, ROLES)
        self.witness = WitnessServer(("127.0.0.1", 0), self.meter.server_address, self.arm)
        self.witness_thread = threading.Thread(target=self.witness.serve_forever, daemon=True); self.witness_thread.start()

    def tearDown(self):
        self.meter.release.set()
        self.arm.latch("test_cleanup")
        self.witness.shutdown(); self.witness.server_close(); self.witness_thread.join(timeout=5)
        self.meter.shutdown(); self.meter.server_close(); self.meter_thread.join(timeout=5)
        self.temp.cleanup()

    def request(self, payload=None, identity=ROOT, path="/v1/responses", token=None, method="POST", extra=None, purpose="turn"):
        connection = http.client.HTTPConnection("127.0.0.1", self.witness.server_port, timeout=10)
        request_headers = {"Authorization": "Bearer " + (token or self.arm._alias), **headers(identity, purpose=purpose), **(extra or {})}
        content = json.dumps(body() if payload is None else payload) if path == "/v1/responses" and method == "POST" else None
        connection.request(method, path, body=content, headers=request_headers)
        response = connection.getresponse()
        status, raw = response.status, response.read()
        connection.close()
        return status, raw

    def test_alias_cannot_authenticate_direct_meter_and_control_is_separate(self):
        binding = self.witness.cli_binding()
        self.assertEqual(binding["requestToken"], self.arm._alias)
        self.assertNotIn(self.arm._funded_token, json.dumps(binding))
        self.assertNotIn(self.arm._owner, json.dumps(binding))
        connection = http.client.HTTPConnection(*self.meter.server_address, timeout=5)
        connection.request("POST", "/v1/responses", body="{}", headers={"Authorization": "Bearer " + self.arm._alias})
        response = connection.getresponse(); self.assertEqual(response.status, 403); response.read(); connection.close()
        self.assertEqual(self.request(path="/owner/status", method="GET")[0], 403)
        self.assertEqual(self.request(path="/control")[0], 403)
        self.assertEqual(self.request(path="/owner/stop", token="wrong-control")[0], 403)
        status, raw = self.request(path="/owner/status", method="GET", token=self.arm._owner)
        self.assertEqual(status, 200)
        for value in (self.arm._funded_token, self.arm._alias, self.arm._owner):
            self.assertNotIn(value, raw.decode())
        self.assertFalse(self.arm.failure)
        self.assertEqual(self.meter.calls, 0)

    def test_root_child_helper_all_receipts_and_private_transcripts_reconcile(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        add_thread(self.registry.database, "worker-b", "verification")
        add_thread(self.registry.database, "judge-a", "judge")
        for identity in (ROOT, "worker-a", "worker-b", "judge-a", "worker-a"):
            self.assertEqual(self.request(identity=identity)[0], 200)
        self.assertEqual(self.request(purpose="summary")[0], 200)
        self.assertEqual(len(self.arm.slots), 3)
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["settlementComplete"])
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 6)
        self.assertAlmostEqual(result["measuredUsd"], 0.06)
        self.assertEqual(result["transcripts"]["sessionCount"], 4)
        self.assertEqual(self.meter.maximum_active, 1)
        audit = self.arm.audit.path.read_text(encoding="utf-8")
        self.assertNotIn(self.meter.token, audit)
        self.assertNotIn(self.arm._alias, audit)
        self.assertNotIn(ROOT, audit)
        records = [json.loads(line) for line in audit.splitlines()]
        self.assertEqual(sum(row["type"] == "receipt_registered" for row in records), 6)
        self.assertEqual(sum(row["type"] == "receipt_registered" and row["helper"] for row in records), 1)
        for index, row in enumerate(records):
            self.assertEqual(row["sequence"], index + 1)
            self.assertEqual(row["previousSha256"], digest(records[index - 1]) if index else None)

    def test_child_filter_preserves_grammar_and_message_content(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        original = body()
        self.assertEqual(self.request(original, "worker-a")[0], 200)
        forwarded = self.meter.bodies[0]
        self.assertEqual(forwarded["input"][0]["tools"], original["input"][0]["tools"][:1])
        self.assertEqual(forwarded["input"][1], original["input"][1])
        self.assertEqual(forwarded["max_output_tokens"], 32000)

    def test_concurrent_duplicate_lifetime_slot_latches_after_single_forward(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        add_thread(self.registry.database, "replacement", "implementation")
        self.meter.release.clear()
        results = []
        first = threading.Thread(target=lambda: results.append(self.request(identity="worker-a")[0])); first.start()
        self.assertTrue(self.meter.started.wait(3))
        second = threading.Thread(target=lambda: results.append(self.request(identity="replacement")[0])); second.start()
        time.sleep(0.1)
        self.meter.release.set()
        first.join(5); second.join(5)
        self.assertEqual(sorted(results), [200, 400])
        self.assertEqual(self.meter.calls, 1)
        self.assertTrue(self.arm.failure)
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.meter.calls, 1)
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["settlementComplete"])
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["transcripts"]["sessionCount"], 3)

    def test_unknown_identity_and_changed_profile_refuse_before_upstream(self):
        self.assertEqual(self.request(identity="not-persisted")[0], 400)
        self.assertTrue(self.arm.failure)
        self.assertEqual(self.meter.calls, 0)
        self.assertEqual(self.request()[0], 400)

    def test_changed_effort_latches_before_any_forward(self):
        payload = body()
        payload["reasoning"]["effort"] = "medium"
        self.assertEqual(self.request(payload)[0], 400)
        self.assertEqual(self.meter.calls, 0)
        self.assertTrue(self.arm.failure)

    def test_explicit_different_child_verbosity_refuses_before_upstream(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        payload = body()
        payload["text"] = {"verbosity": "high"}
        self.assertEqual(self.request(payload, identity="worker-a")[0], 400)
        self.assertEqual(self.meter.calls, 0)

    def test_explicit_different_helper_summary_refuses_before_upstream(self):
        self.assertEqual(self.request()[0], 200)
        payload = body()
        payload["reasoning"]["summary"] = "concise"
        self.assertEqual(self.request(payload, purpose="summary")[0], 400)
        self.assertEqual(self.meter.calls, 1)

    def test_queued_client_cancel_stops_queue_without_forwarding_it(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        self.meter.release.clear()
        results = []
        active = threading.Thread(target=lambda: results.append(self.request()[0])); active.start()
        self.assertTrue(self.meter.started.wait(3))
        queued = http.client.HTTPConnection("127.0.0.1", self.witness.server_port, timeout=5)
        queued.request("POST", "/v1/responses", body=json.dumps(body()), headers={"Authorization": "Bearer " + self.arm._alias, **headers("worker-a")})
        deadline = time.monotonic() + 3
        while self.arm.status()["queuedRequests"] == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.arm.status()["queuedRequests"], 1)
        queued.close()
        deadline = time.monotonic() + 3
        while not self.arm.failure and time.monotonic() < deadline:
            time.sleep(0.01)
        self.meter.release.set(); active.join(5)
        self.assertEqual(self.meter.calls, 1)
        self.assertEqual(self.arm.failure, "queued_client_cancelled")
        self.assertEqual(self.arm.status()["queuedRequests"], 0)

    def test_failed_disarm_retains_token_and_is_not_automatically_retried(self):
        calls = []
        def uncertain(route, value=None):
            calls.append(route)
            if route == "/disarm":
                raise OSError("synthetic uncertain mutation")
            return self.meter.control(route, value)
        self.supervisor.controller = uncertain
        first = self.supervisor.close(timeout=0.1)
        second = self.supervisor.close(timeout=0.1)
        self.assertFalse(first["settlementComplete"])
        self.assertFalse(second["settlementComplete"])
        self.assertEqual(calls.count("/disarm"), 1)
        self.assertEqual(self.arm._funded_token, self.meter.token)

    def test_nested_native_identity_refused_before_upstream(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        add_thread(self.registry.database, "nested", "verification", parent="worker-a", depth=2)
        connection = http.client.HTTPConnection("127.0.0.1", self.witness.server_port, timeout=5)
        connection.request("POST", "/v1/responses", body=json.dumps(body()), headers={"Authorization": "Bearer " + self.arm._alias, **headers("nested", parent="worker-a")})
        response = connection.getresponse(); self.assertEqual(response.status, 400); response.read(); connection.close()
        self.assertEqual(self.meter.calls, 0)

    def test_summary_first_unapproved_child_refused_before_upstream(self):
        add_thread(self.registry.database, "unapproved", "unapproved-role")
        self.assertEqual(self.request(identity="unapproved", purpose="summary")[0], 400)
        self.assertEqual(self.meter.calls, 0)

    def test_summary_first_approved_child_registers_and_reuses_same_slot(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        self.assertEqual(self.request(identity="worker-a", purpose="summary")[0], 200)
        self.assertEqual(self.arm.slots, {"implementation": "worker-a"})
        self.assertIn("worker-a", self.arm.admitted_ids)
        self.assertEqual(self.request(identity="worker-a")[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 2)
        self.assertAlmostEqual(result["measuredUsd"], 0.02)

    def test_summary_first_root_registers_and_preserves_lead_tools(self):
        self.assertEqual(self.request(purpose="summary")[0], 200)
        self.assertEqual(self.arm.admitted_ids, {ROOT})
        self.assertEqual(self.meter.bodies[0]["input"][0]["tools"], body()["input"][0]["tools"])
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 2)

    def test_summary_first_replacement_child_cannot_bypass_lifetime_slot(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        add_thread(self.registry.database, "replacement", "implementation")
        self.assertEqual(self.request(identity="worker-a")[0], 200)
        self.assertEqual(self.request(identity="replacement", purpose="summary")[0], 400)
        self.assertEqual(self.meter.calls, 1)

    def test_summary_first_nested_child_cannot_bypass_depth(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        add_thread(self.registry.database, "nested", "verification", parent="worker-a", depth=2)
        self.assertEqual(self.request(identity="worker-a")[0], 200)
        connection = http.client.HTTPConnection("127.0.0.1", self.witness.server_port, timeout=5)
        connection.request("POST", "/v1/responses", body=json.dumps(body()), headers={"Authorization": "Bearer " + self.arm._alias, **headers("nested", parent="worker-a", purpose="summary")})
        response = connection.getresponse(); self.assertEqual(response.status, 400); response.read(); connection.close()
        self.assertEqual(self.meter.calls, 1)

    def test_summary_for_already_admitted_child_keeps_its_slot_and_counts_charge(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        self.assertEqual(self.request(identity="worker-a")[0], 200)
        self.assertEqual(self.request(identity="worker-a", purpose="summary")[0], 200)
        self.assertEqual(self.arm.slots, {"implementation": "worker-a"})
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(result["providerRequests"], 2)
        self.assertAlmostEqual(result["measuredUsd"], 0.02)

    def test_oversized_body_and_audit_failure_latch(self):
        self.assertEqual(self.request(extra={"Content-Length": str(MAX_BODY + 1)})[0], 400)
        self.assertEqual(self.meter.calls, 0)
        self.assertTrue(self.arm.failure)

    def test_audit_failure_prevents_forward_and_cannot_clear(self):
        def fail(_row):
            raise OSError("synthetic audit disk failure")
        self.arm.audit.append = fail
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.arm.failure, "audit_unavailable")
        self.assertEqual(self.meter.calls, 0)
        self.assertEqual(self.request()[0], 400)

    def test_stream_client_cancel_is_drained_and_receipt_retained(self):
        self.meter.mode = "sse"
        self.meter.release.clear()
        connection = http.client.HTTPConnection("127.0.0.1", self.witness.server_port, timeout=5)
        connection.request("POST", "/v1/responses", body=json.dumps(body()), headers={"Authorization": "Bearer " + self.arm._alias, **headers()})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertTrue(response.fp.readline())
        response.close(); connection.close()
        time.sleep(0.05)
        self.meter.release.set()
        deadline = time.monotonic() + 3
        while self.arm.forwarding and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.arm.forwarding)
        self.assertEqual(len(self.meter.receipts), 1)
        self.assertTrue(self.arm.requests[0]["upstreamTerminal"])
        self.assertTrue(self.arm.failure)
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["settlementComplete"])
        self.assertEqual(result["providerRequests"], 1)
        self.assertTrue(result["reviewRequired"])

    def test_missing_terminal_is_not_retried_and_charges_still_retained(self):
        self.meter.mode = "drop"
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertEqual(self.meter.calls, 1)
        self.assertTrue(result["settlementComplete"])
        self.assertTrue(result["reviewRequired"])
        self.assertAlmostEqual(result["measuredUsd"], 0.01)

    def terminal_case(self, mode, status, event="response.completed", review=True):
        self.meter.mode, self.meter.response_status, self.meter.terminal_event = mode, status, event
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertEqual(self.meter.calls, 1)
        self.assertTrue(result["settlementComplete"])
        self.assertEqual(result["providerRequests"], 1)
        self.assertAlmostEqual(result["measuredUsd"], 0.01)
        self.assertTrue(self.arm.requests[0]["upstreamTerminal"])
        self.assertEqual(result["reviewRequired"], review)
        self.assertEqual(self.supervisor.failed, review)
        return result

    def test_raw_completed_terminal_is_accepted(self):
        self.terminal_case("json", "completed", review=False)

    def test_sse_completed_terminal_is_accepted(self):
        self.terminal_case("sse", "completed", review=False)

    def test_sse_done_terminal_is_accepted(self):
        self.terminal_case("sse", "completed", "response.done", review=False)

    def test_sse_done_event_with_failed_status_requires_review(self):
        self.terminal_case("sse", "failed", "response.done")

    def test_sse_done_event_with_incomplete_status_requires_review(self):
        self.terminal_case("sse", "incomplete", "response.done")

    def test_raw_failed_terminal_retains_charge_and_requires_review(self):
        self.terminal_case("json", "failed")

    def test_raw_incomplete_terminal_retains_charge_and_requires_review(self):
        self.terminal_case("json", "incomplete")

    def test_raw_nonterminal_status_is_not_completion(self):
        self.terminal_case("json", "in_progress")

    def test_sse_failed_terminal_retains_charge_and_requires_review(self):
        self.terminal_case("sse", "failed", "response.failed")

    def test_sse_incomplete_terminal_retains_charge_and_requires_review(self):
        self.terminal_case("sse", "incomplete", "response.incomplete")

    def test_sse_completed_event_with_failed_status_requires_review(self):
        self.terminal_case("sse", "failed", "response.completed")

    def test_sse_completed_event_with_incomplete_status_requires_review(self):
        self.terminal_case("sse", "incomplete", "response.completed")

    def test_sse_failed_event_with_completed_status_requires_review(self):
        self.terminal_case("sse", "completed", "response.failed")

    def test_sse_incomplete_event_with_completed_status_requires_review(self):
        self.terminal_case("sse", "completed", "response.incomplete")

    def test_sse_event_label_and_data_type_must_agree(self):
        self.meter.sse_event_label = "response.failed"
        self.terminal_case("sse", "completed", "response.completed")

    def test_later_completed_terminal_cannot_clear_failed_terminal(self):
        self.meter.extra_terminals = [("response.completed", "completed")]
        self.terminal_case("sse", "failed", "response.failed")

    def test_completed_then_malformed_failed_terminal_requires_review(self):
        self.meter.malformed_tail_label = "response.failed"
        self.terminal_case("sse", "completed")

    def test_completed_then_malformed_completed_terminal_requires_review(self):
        self.meter.malformed_tail_label = "response.completed"
        self.terminal_case("sse", "completed")

    def test_completed_then_malformed_done_terminal_requires_review(self):
        self.meter.malformed_tail_label = "response.done"
        self.terminal_case("sse", "completed")

    def test_completed_then_malformed_incomplete_terminal_requires_review(self):
        self.meter.malformed_tail_label = "response.incomplete"
        self.terminal_case("sse", "completed")

    def test_completed_then_malformed_error_signal_requires_review(self):
        self.meter.malformed_tail_label = "error"
        self.terminal_case("sse", "completed")

    def test_malformed_nonterminal_heartbeat_does_not_undo_completion(self):
        self.meter.malformed_tail_label = "heartbeat"
        self.terminal_case("sse", "completed", review=False)

    def configure_known_length_incomplete(self, mode="sse"):
        self.meter.mode, self.meter.response_status, self.meter.terminal_event = mode, "incomplete", "response.incomplete"
        self.meter.incomplete_reason = "max_output_tokens"
        self.meter.response_usage = {"input_tokens": 11, "output_tokens": 32000, "total_tokens": 32011, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 100}}

    def test_known_length_incomplete_allows_same_identity_continuation_and_bills_both(self):
        self.configure_known_length_incomplete()
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.terminal_event, self.meter.incomplete_reason = "completed", "response.completed", None
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertIsNone(self.arm.failure)
        self.assertTrue(result["settlementComplete"])
        self.assertEqual(result["providerRequests"], 2)
        self.assertAlmostEqual(result["measuredUsd"], 0.02)
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["nonfatalReviewObservationCount"], 1)

    def test_unresolved_known_length_raw_incomplete_is_nonfatal_but_closure_review(self):
        self.configure_known_length_incomplete("json")
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertIsNone(self.arm.failure)
        self.assertTrue(result["reviewRequired"])
        self.assertTrue(self.supervisor.failed)
        self.assertEqual(result["providerRequests"], 1)
        self.assertAlmostEqual(result["measuredUsd"], 0.01)

    def test_unknown_length_usage_remains_fatal(self):
        self.configure_known_length_incomplete()
        self.meter.response_usage.pop("input_tokens_details")
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.terminal_event, self.meter.incomplete_reason = "completed", "response.completed", None
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.meter.calls, 1)

    def test_known_length_continuation_never_clears_a_failed_terminal(self):
        self.configure_known_length_incomplete()
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.terminal_event, self.meter.incomplete_reason = "failed", "response.failed", None
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.terminal_event = "completed", "response.completed"
        self.assertEqual(self.request()[0], 400)
        result = self.supervisor.close(timeout=2)
        self.assertEqual(result["providerRequests"], 2)
        self.assertTrue(result["reviewRequired"])
        self.assertIsNotNone(self.arm.failure)

    def test_known_length_reason_does_not_excuse_status_event_contradiction(self):
        self.configure_known_length_incomplete()
        self.meter.terminal_event = "response.completed"
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.incomplete_reason = "completed", None
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.meter.calls, 1)

    def test_known_length_continuation_keeps_total_call_bound(self):
        self.arm.max_calls = 1
        self.configure_known_length_incomplete()
        self.assertEqual(self.request()[0], 200)
        self.meter.response_status, self.meter.terminal_event, self.meter.incomplete_reason = "completed", "response.completed", None
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.meter.calls, 1)

    def test_missing_receipt_preserves_unknown_closure_and_memory_token(self):
        self.assertEqual(self.request()[0], 200)
        self.supervisor.receipts = lambda: []
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["settlementComplete"])
        self.assertIsNone(result["measuredUsd"])
        self.assertAlmostEqual(result["controllerUsageThroughClosure"]["measuredUsd"], 0.01)
        self.assertEqual(result["usageAccountingStatus"], "settled_totals_pending_receipt_join")
        self.assertEqual(self.arm._funded_token, self.meter.token)
        self.assertIs(self.supervisor.active, self.arm)
        with self.assertRaises(PolicyError):
            self.supervisor.begin("vector", "forbidden-next", self.registry, ROLES)

    def test_receipt_wrong_owned_label_requires_review_with_known_totals(self):
        self.assertEqual(self.request()[0], 200)
        self.meter.receipts[0]["label"] = "wrong-owned-label"
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["reviewRequired"])
        self.assertFalse(result["settlementComplete"])
        self.assertAlmostEqual(result["controllerUsageThroughClosure"]["measuredUsd"], 0.01)

    def test_unconfirmed_descendant_quiescence_keeps_charges_but_requires_review(self):
        self.assertEqual(self.request()[0], 200)
        self.supervisor.quiesced = lambda: False
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["settlementComplete"])
        self.assertTrue(result["reviewRequired"])
        self.assertAlmostEqual(result["measuredUsd"], 0.01)
        self.assertEqual(self.request()[0], 403)
        self.assertTrue(self.supervisor.failed)

    def test_failure_during_transcript_collection_cannot_finalize_clean(self):
        self.assertEqual(self.request()[0], 200)
        started, release = threading.Event(), threading.Event()
        original = self.registry.collect
        def blocked(destination):
            started.set()
            self.assertTrue(release.wait(3))
            return original(destination)
        self.registry.collect = blocked
        results = []
        closer = threading.Thread(target=lambda: results.append(self.supervisor.close(timeout=2)))
        closer.start()
        self.assertTrue(started.wait(3))
        try:
            self.assertEqual(self.request(path="/owner/stop", token=self.arm._owner)[0], 200)
        finally:
            release.set()
        closer.join(5)
        self.assertFalse(closer.is_alive())
        self.assertTrue(results[0]["settlementComplete"])
        self.assertTrue(results[0]["reviewRequired"])
        self.assertEqual(results[0]["stopReason"], "owner_requested_stop")
        self.assertTrue(self.supervisor.failed)
        next_registry = NativeRegistry("vector", self.directory, self.directory / "future-vector.db", "ses-future", "openai")
        with self.assertRaises(PolicyError):
            self.supervisor.begin("vector", "forbidden-next", next_registry, ROLES)

    def test_close_waits_for_accepted_handler_barrier(self):
        self.assertTrue(self.arm.begin_handler())
        results = []
        closer = threading.Thread(target=lambda: results.append(self.supervisor.close(timeout=2)))
        closer.start()
        deadline = time.monotonic() + 2
        while not self.arm.closing and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.arm.closing)
        self.assertTrue(closer.is_alive())
        self.assertEqual(self.arm.status()["acceptedHandlers"], 1)
        self.arm.end_handler()
        closer.join(5)
        self.assertFalse(closer.is_alive())
        self.assertFalse(results[0]["reviewRequired"])
        self.assertEqual(self.arm.status()["acceptedHandlers"], 0)

    def test_close_drains_queued_handlers_and_retains_active_charge(self):
        add_thread(self.registry.database, "worker-a", "implementation")
        self.meter.release.clear()
        responses, closures = [], []
        active = threading.Thread(target=lambda: responses.append(self.request()[0])); active.start()
        self.assertTrue(self.meter.started.wait(3))
        queued = threading.Thread(target=lambda: responses.append(self.request(identity="worker-a")[0])); queued.start()
        deadline = time.monotonic() + 3
        while not self.arm.queue and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(self.arm.queue), 1)
        closer = threading.Thread(target=lambda: closures.append(self.supervisor.close(timeout=3))); closer.start()
        deadline = time.monotonic() + 3
        while not self.arm.closing and time.monotonic() < deadline:
            time.sleep(0.01)
        self.meter.release.set()
        active.join(5); queued.join(5); closer.join(5)
        self.assertFalse(closer.is_alive())
        self.assertEqual(sorted(responses), [200, 400])
        self.assertEqual(self.meter.calls, 1)
        self.assertTrue(closures[0]["reviewRequired"])
        self.assertEqual(closures[0]["providerRequests"], 1)
        self.assertEqual(self.arm.status()["acceptedHandlers"], 0)
        self.assertEqual(self.arm.status()["queuedRequests"], 0)

    def test_retired_owner_stop_cannot_latch_after_clean_final_state(self):
        self.assertEqual(self.request()[0], 200)
        result = self.supervisor.close(timeout=2)
        self.assertFalse(result["reviewRequired"])
        self.assertEqual(self.request(path="/owner/stop", token=self.arm._owner)[0], 409)
        self.assertIsNone(self.arm.failure)
        self.assertFalse(self.supervisor.failed)

    def test_incomplete_transcript_coverage_requires_review_with_known_charges(self):
        self.assertEqual(self.request()[0], 200)
        self.registry.collect = lambda _destination: {"complete": False}
        result = self.supervisor.close(timeout=2)
        self.assertTrue(result["settlementComplete"])
        self.assertTrue(result["reviewRequired"])
        self.assertAlmostEqual(result["measuredUsd"], 0.01)

    def test_single_call_reservation_headroom_not_output_reduction(self):
        self.meter.spent["foundry-codex"] = 17
        payload = body()
        payload["input"].append({"type": "message", "role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,synthetic"}]})
        self.assertEqual(self.request(payload)[0], 400)
        self.assertEqual(self.meter.calls, 0)
        self.assertTrue(self.arm.failure)

    def test_only_one_formal_repair_and_no_cap_expansion(self):
        self.supervisor.repair()
        with self.assertRaises(PolicyError):
            self.supervisor.repair()
        self.assertEqual(self.request(path="/control", token=self.arm._owner)[0], 403)


class RegistryAndStartupTests(unittest.TestCase):
    def test_known_vector_generation_helper_has_a_fixed_lifetime_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            arm, meter = vector_generation_fixture(Path(directory))
            try:
                payload = {"model": MODEL, "reasoning": {"effort": "high"}, "input": []}
                for _ in range(2):
                    _, entry = arm.enter(payload, {"X-Session-Id": "ses-helper-a"}, lambda: False)
                    self.assertEqual(entry["identityKind"], "helper")
                    arm.finish(entry, {"object": "response", "status": "completed"}, False, False)
                self.assertEqual(arm.slots, {})
                self.assertEqual(arm.admitted_ids, {"ses-root"})
                self.assertEqual(arm.helper_slots, {"synthetic-summary": "ses-helper-a"})
                with self.assertRaisesRegex(PolicyError, "lifetime helper"):
                    arm.enter(payload, {"X-Session-Id": "ses-helper-b"}, lambda: False)
            finally:
                meter.server_close()

    def test_known_vector_generation_helper_cannot_acquire_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            arm, meter = vector_generation_fixture(Path(directory))
            try:
                with self.assertRaisesRegex(PolicyError, "may not have tools"):
                    arm.enter(body(), {"X-Session-Id": "ses-helper-a"}, lambda: False)
                self.assertEqual(arm.helper_slots, {})
            finally:
                meter.server_close()

    def test_vector_tool_using_internal_review_is_not_extra_helper_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            database = home / "vector.db"
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
            model = json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"})
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-root", None, None, "build", model, None))
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-review", "ses-root", "review", "review", model, None))
            connection.commit(); connection.close()
            registry = NativeRegistry("vector", home, database, "ses-root", "openai", helper_names=("review",))
            meter = FakeMeter()
            try:
                before = meter.control("/status")
                token = meter.control("/control", {"actor": "foundry-vector", "label": "synthetic-vector-review", "calls": 300})["requestToken"]
                arm = OwnedArm("vector", registry, ROLES, token, before, meter.control, Audit(home / "audit.jsonl"), label="synthetic-vector-review")
                with self.assertRaises(PolicyError):
                    arm.enter(body(), {"X-Session-Id": "ses-review", "x-parent-session-id": "ses-root"}, lambda: False)
            finally:
                meter.server_close()

    def test_free_vector_bootstrap_requires_unique_owned_native_root(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            database = home / "vector.db"
            model = json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"})
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-root", None, None, "build", model, None))
            connection.commit(); connection.close()
            registry = OwnedFreshVectorRegistry(home)
            self.assertEqual(registry.resolve({"X-Session-Id": "ses-root"})["role"], "lead")
            connection = sqlite3.connect(database)
            connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-second", None, None, "build", model, None))
            connection.commit(); connection.close()
            with self.assertRaises(PolicyError):
                OwnedFreshVectorRegistry(home).resolve({"X-Session-Id": "ses-root"})

    def test_vector_source_schema_reader_static_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            database = home / "vector.db"
            model = json.dumps({"id": MODEL, "providerID": "openai", "variant": "high"})
            record = {"subagent": {"agent": "implementation", "parentSessionID": "ses-root", "model": {"modelID": MODEL, "providerID": "openai", "variant": "high"}}}
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE session(id TEXT,parent_id TEXT,internal TEXT,agent TEXT,model TEXT,metadata TEXT)")
                connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-root", None, None, "build", model, None))
                connection.execute("INSERT INTO session VALUES(?,?,?,?,?,?)", ("ses-child", "ses-root", None, "implementation", None, json.dumps(record)))
            connection.close()
            registry = NativeRegistry("vector", home, database, "ses-root", "openai")
            root = registry.resolve({"X-Session-Id": "ses-root"})
            child = registry.resolve({"X-Session-Id": "ses-child", "x-parent-session-id": "ses-root"})
            self.assertEqual(root["purpose"], "root_or_helper")
            self.assertEqual(child["role"], "implementation")
            self.assertEqual(child["depth"], 1)
            with self.assertRaises(PolicyError):
                registry.resolve({"X-Session-Id": "ses-child", "x-parent-session-id": "other-arm"})

    def test_partial_or_existing_audit_refuses_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audit.jsonl"
            path.write_text('{"partial":', encoding="utf-8")
            with self.assertRaises(FileExistsError):
                Audit(path)


class GenerationPinTests(unittest.TestCase):
    def test_output_is_the_unchanged_common_ceiling(self):
        for requested, expected in ((None, 32000), (64000, 32000), (32000, 32000), (512, 512)):
            with self.subTest(requested=requested):
                payload = body()
                if requested is not None:
                    payload["max_output_tokens"] = requested
                self.assertEqual(profile_body(payload, False)["max_output_tokens"], expected)
    def test_root_child_missing_generation_pins_get_reviewed_defaults(self):
        for child in (False, True):
            with self.subTest(child=child):
                payload = body()
                original = copy.deepcopy(payload)
                normalized = profile_body(payload, child)
                self.assertEqual(normalized["reasoning"]["summary"], "auto")
                self.assertEqual(normalized["text"]["verbosity"], "low")
                self.assertEqual(payload, original)

    def test_explicit_different_generation_pins_rejected_for_root_child(self):
        for child in (False, True):
            for field, value in (("summary", "concise"), ("summary", None), ("verbosity", "medium"), ("verbosity", "high"), ("verbosity", None)):
                with self.subTest(child=child, field=field, value=value):
                    payload = body()
                    if field == "summary":
                        payload["reasoning"]["summary"] = value
                    else:
                        payload["text"] = {"verbosity": value}
                    with self.assertRaises(PolicyError):
                        profile_body(payload, child)

    def test_pins_preserve_structured_output_format_and_custom_grammar(self):
        payload = body()
        payload["text"] = {"format": {"type": "json_schema", "name": "synthetic", "schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]}}}
        normalized = profile_body(payload, True)
        self.assertEqual(normalized["text"]["format"], payload["text"]["format"])
        self.assertEqual(normalized["input"][0]["tools"][0], payload["input"][0]["tools"][0])

    def test_configuration_updates_receive_and_preserve_same_pins(self):
        payload = body()
        update = {"type": "configuration_update", "reasoning": {"effort": "high"}, "text": {"format": {"type": "json_object"}}}
        payload["input"].append(update)
        normalized = profile_body(payload, False)["input"][-1]
        self.assertEqual(normalized["reasoning"]["summary"], "auto")
        self.assertEqual(normalized["text"], {"format": {"type": "json_object"}, "verbosity": "low"})
        update["reasoning"]["summary"] = "concise"
        with self.assertRaises(PolicyError):
            profile_body(payload, False)


@unittest.skipUnless(os.environ.get("VECTOR_BENCH_METER_SOURCE"), "explicit reviewed source directory required; no live configuration is read")
class ActualMeterSourceTests(unittest.TestCase):
    def reviewed_module(self):
        source = Path(os.environ["VECTOR_BENCH_METER_SOURCE"]).resolve()
        spec = importlib.util.spec_from_file_location("isolated_free_meter_v2", source / "budget_gateway_v2.py")
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(source))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        return module

    def test_actual_handler_receipt_fingerprint_and_reserve_against_loopback_stub(self):
        module = self.reviewed_module()
        class ProviderStub(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                if self.headers.get("Authorization") != "Bearer literal-fake-provider-key":
                    self.send_error(403); return
                self.rfile.read(int(self.headers["Content-Length"]))
                response = {"id": "synthetic-provider-response", "object": "response", "status": "completed", "usage": {"input_tokens": 10, "output_tokens": 2, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
                raw = json.dumps(response).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
        with tempfile.TemporaryDirectory() as directory:
            provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderStub)
            provider_thread = threading.Thread(target=provider.serve_forever, daemon=True); provider_thread.start()
            budget = module.Budget(Path(directory))
            armed = budget.arm("saas-codex", "synthetic-offline-handler-proof", 2)
            handler = module.handler(budget, "literal-fake-provider-key", "literal-fake-controller", upstream_factory=lambda: http.client.HTTPConnection(*provider.server_address, timeout=5))
            meter = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            meter_thread = threading.Thread(target=meter.serve_forever, daemon=True); meter_thread.start()
            try:
                payload = body()
                payload["input"][1]["content"] += " Unicode π remains UTF-8."
                normalized = profile_body(payload, False)
                wire = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode()
                connection = http.client.HTTPConnection(*meter.server_address, timeout=5)
                connection.request("POST", "/v1/responses", body=wire, headers={"Authorization": "Bearer " + armed["requestToken"], "Content-Type": "application/json"})
                response = connection.getresponse(); self.assertEqual(response.status, 200); response.read(); connection.close()
                deadline = time.monotonic() + 3
                while budget.pending and time.monotonic() < deadline:
                    time.sleep(0.01)
                rows = [json.loads(line) for line in (Path(directory) / "receipts.jsonl").read_text().splitlines()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["requestSha256"], hashlib.sha256(wire).hexdigest())
                self.assertEqual(rows[0]["batchSha256"], digest(armed["requestToken"]))
                self.assertEqual(rows[0]["seq"], 1)
                self.assertEqual(rows[0]["label"], "synthetic-offline-handler-proof")
                self.assertAlmostEqual(rows[0]["reservedUsd"], reservation_bound(normalized, wire))
                self.assertAlmostEqual(rows[0]["measuredUsd"], 0.00004)
            finally:
                meter.shutdown(); meter.server_close(); meter_thread.join(5)
                provider.shutdown(); provider.server_close(); provider_thread.join(5)

    def assert_actual_unknown_usage_stops_closure(self, supplied_usage):
        module = self.reviewed_module()
        class ProviderStub(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                value = {"id": "synthetic-unknown-usage", "object": "response", "status": "completed"}
                if supplied_usage is not None:
                    value["usage"] = supplied_usage
                raw = json.dumps(value).encode()
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = native_fixture(root / "native")
            budget = module.Budget(root / "synthetic-meter-ledger")
            provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderStub)
            provider_thread = threading.Thread(target=provider.serve_forever, daemon=True); provider_thread.start()
            actual = ThreadingHTTPServer(("127.0.0.1", 0), module.handler(budget, "literal-fake-provider-key", "literal-fake-controller", upstream_factory=lambda: http.client.HTTPConnection(*provider.server_address, timeout=5)))
            actual_thread = threading.Thread(target=actual.serve_forever, daemon=True); actual_thread.start()
            def mapped_status():
                state = budget.status()
                actor = state["actors"]["saas-codex"]
                # Synthetic historical prefix/actor names only. The actual
                # handler, admission, usage validation and settlement are intact.
                return {"limitUsd": state["limitUsd"], "phaseID": FUNDING_PHASE, "halted": state["halted"], "measuredUsd": 19.8 + state["measuredUsd"], "reservedUsd": state["reservedUsd"], "active": state["active"], "attempts": 449 + state["attempts"], "batchCallsRemaining": state["batchCallsRemaining"], "actors": {"foundry-vector": {"limitUsd": 20, "measuredUsd": 10.9, "reservedUsd": 0}, "foundry-codex": {"limitUsd": 20, "measuredUsd": 5.9 + actor["measuredUsd"], "reservedUsd": actor["reservedUsd"]}}}
            def controller(route, value=None):
                if route == "/control":
                    return budget.arm("saas-codex", value["label"], value["calls"])
                if route == "/disarm":
                    budget.disarm(value["requestToken"])
                return mapped_status()
            def receipts():
                path = root / "synthetic-meter-ledger" / "receipts.jsonl"
                return [{**row, "actor": "foundry-codex", "seq": 449 + row["seq"]} for row in map(json.loads, path.read_text().splitlines())] if path.exists() else []
            supervisor = OwnedSupervisor(controller, receipts, root / "private-output", quiesced=lambda: True)
            arm = supervisor.begin("codex", "synthetic-unknown-usage", registry, ROLES)
            witness = WitnessServer(("127.0.0.1", 0), actual.server_address, arm)
            witness_thread = threading.Thread(target=witness.serve_forever, daemon=True); witness_thread.start()
            try:
                connection = http.client.HTTPConnection(*witness.server_address, timeout=5)
                connection.request("POST", "/v1/responses", body=json.dumps(body()), headers={"Authorization": "Bearer " + arm._alias, **headers()})
                response = connection.getresponse(); self.assertEqual(response.status, 200); response.read(); connection.close()
                result = supervisor.close(timeout=1)
                rows = receipts()
                self.assertEqual(len(rows), 1)
                self.assertIsNone(rows[0]["measuredUsd"])
                self.assertIsNotNone(budget.halted)
                self.assertGreater(budget.reserved, 0)
                self.assertFalse(result["settlementComplete"])
                self.assertTrue(result["reviewRequired"])
                self.assertIsNone(result["measuredUsd"])
                self.assertTrue(supervisor.failed)
            finally:
                witness.shutdown(); witness.server_close(); witness_thread.join(5)
                actual.shutdown(); actual.server_close(); actual_thread.join(5)
                provider.shutdown(); provider.server_close(); provider_thread.join(5)

    def test_actual_handler_missing_usage_halts_and_closes_for_review(self):
        self.assert_actual_unknown_usage_stops_closure(None)

    def test_actual_handler_invalid_usage_halts_and_closes_for_review(self):
        self.assert_actual_unknown_usage_stops_closure({"input_tokens": 10, "output_tokens": 2, "input_tokens_details": {"cached_tokens": "invalid", "cache_write_tokens": 0}})


if __name__ == "__main__":
    unittest.main()
