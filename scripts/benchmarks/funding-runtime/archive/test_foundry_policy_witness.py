"""Pure/offline HTTP policy tests. All upstreams are synthetic loopback servers."""
import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import foundry_policy_witness as policy


def function(name):
    return {"type": "function", "name": name, "description": "Preserve this description exactly",
            "parameters": {"type": "object", "properties": {"task": {"type": "string", "description": "collaboration.spawn_agent"}}}}


def request():
    return {"model": policy.MODEL, "reasoning": {"effort": "high", "summary": "auto"}, "text": {"verbosity": "low"},
            "prompt_cache_key": "synthetic-session", "prompt_cache_options": {"mode": "implicit", "ttl": "30m"},
            "max_output_tokens": 32000, "stream": True,
            "tools": [function("read"), function("task"), function("task_manage"), function("exec_command")],
            "input": [{"type": "additional_tools", "tools": [
                {"type": "namespace", "name": "collaboration", "description": "unchanged unless removed", "tools": [function("spawn_agent"), function("send_message")]},
                {"type": "namespace", "name": "functions", "tools": [function("exec"), function("wait"), function("followup_task")]},
                {"type": "custom", "name": "apply_patch", "format": {"type": "grammar", "syntax": "lark", "definition": "task: /.+/"}}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Never edit user text: collaboration.spawn_agent and task", "prompt_cache_breakpoint": {"mode": "explicit", "ttl": "30m"}}]}]}


class PolicyTests(unittest.TestCase):
    def test_filters_only_definition_containers_preserving_order_schemas_text_and_cache(self):
        body = request(); original = copy.deepcopy(body)
        output, audit = policy.apply_policy(body)
        self.assertEqual(body, original)
        self.assertEqual([x["name"] for x in output["tools"]], ["read", "exec_command"])
        self.assertEqual([x["name"] for x in output["input"][0]["tools"]], ["functions", "apply_patch"])
        self.assertEqual([x["name"] for x in output["input"][0]["tools"][0]["tools"]], ["exec", "wait"])
        self.assertEqual(output["tools"][0], original["tools"][0])
        self.assertEqual(output["input"][1], original["input"][1])
        self.assertEqual(output["input"][0]["tools"][-1], original["input"][0]["tools"][-1])
        for key in body.keys() - {"tools", "input"}:
            self.assertEqual(output[key], body[key])
        self.assertEqual(audit["removedCount"], 5)
        self.assertEqual(audit["toolNamesAfter"], ["read", "exec_command", "functions.exec", "functions.wait", "apply_patch"])
        self.assertNotIn("synthetic-session", json.dumps(audit))
        self.assertNotIn("Never edit user text", json.dumps(audit))

    def test_wire_kind_audit_is_metadata_only_and_never_rewrites_body(self):
        for kind in ("text", "grammar", "not-a-known-kind"):
            body = request()
            body["store"] = False
            body["tools"] = [{"type": "namespace", "name": "functions", "tools": [
                {"type": "custom", "name": "apply_patch", "description": "private-description",
                 "format": {"type": kind, "definition": "private-grammar"}}, function("bash")]}]
            body["input"] = []
            original = copy.deepcopy(body)
            output, audit = policy.apply_policy(body)
            self.assertEqual(output, original)
            self.assertEqual(body, original)
            self.assertFalse(audit["store"])
            self.assertEqual(audit["toolWireKindsAfter"], [
                {"name": "functions.apply_patch", "type": "custom", "formatType": kind if kind in ("text", "grammar") else "unknown"},
                {"name": "functions.bash", "type": "function"}])
            self.assertNotIn("private-description", json.dumps(audit))
            self.assertNotIn("private-grammar", json.dumps(audit))
        output, audit = policy.apply_policy(request())
        self.assertIsNone(audit["store"])
        self.assertFalse(any(policy.blocked(entry["name"]) for entry in audit["toolWireKindsAfter"]))

    def test_research_and_escalation_workers_are_not_offered_for_single_agent_case(self):
        body = request()
        body["tools"] += [function("research"), function("escalate"),
            {"type": "namespace", "name": "research", "tools": [function("run")]}]
        original = copy.deepcopy(body)
        output, audit = policy.apply_policy(body)
        self.assertEqual(body, original)
        self.assertEqual([x["name"] for x in output["tools"]], ["read", "exec_command"])
        self.assertNotIn("research", audit["toolNamesAfter"])
        self.assertNotIn("escalate", audit["toolNamesAfter"])
        self.assertNotIn("research.run", audit["toolNamesAfter"])
        self.assertEqual(audit["policyVersion"], "single-agent-no-workers-v2")
        self.assertEqual(output["input"][1], original["input"][1])

    def test_requires_exact_model_high_and_rejects_pro_modes(self):
        cases = [{"model": "gpt-6.1-sol-pro"}, {"model": "other"}, {"reasoning": {"effort": "medium"}},
                 {"reasoning": {}}, {"reasoning": None}, {"mode": "pro"}, {"model_mode": "Pro"},
                 {"reasoning": {"effort": "high", "mode": "pro"}}, {"pro": True}]
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(policy.PolicyError):
                policy.apply_policy({**request(), **changed})

    def test_configuration_updates_cannot_change_effort_or_hide_unknown_schema(self):
        for item in ({"type": "configuration_update", "reasoning": {"effort": "medium"}},
                     {"type": "configuration_update", "config": {"reasoning": {"effort": "high"}}},
                     {"type": "configuration_update", "reasoning": {"effort": "high"}, "model": "other"}):
            with self.subTest(item=item), self.assertRaises(policy.PolicyError):
                policy.apply_policy({**request(), "input": [item]})
        item = {"type": "configuration_update", "reasoning": {"effort": "high"}}
        self.assertEqual(policy.apply_policy({**request(), "input": [item]})[0]["input"], [item])

    def test_unknown_tool_schemas_fail_closed_without_searching_user_data(self):
        for tools in (None, {}, [{"type": "unknown", "name": "read"}], [{"type": "function"}], [{"type": "namespace", "name": "functions", "tools": {}}]):
            with self.subTest(tools=tools), self.assertRaises(policy.PolicyError):
                policy.apply_policy({**request(), "tools": tools})
        body = request(); body["input"] = [{"type": "message", "content": {"tools": [{"type": "unknown"}]}}]
        self.assertEqual(policy.apply_policy(body)[0]["input"], body["input"])

    def test_fully_qualified_management_names_and_collaboration_namespaces_are_removed(self):
        body = request(); body["tools"] = [function("functions.spawn_agent"), function("other.collaboration.start"), function("bash"), function("clock.sleep")]
        self.assertEqual([x["name"] for x in policy.apply_policy(body)[0]["tools"]], ["bash", "clock.sleep"])

    def test_offline_http_rejects_before_upstream_and_passes_tokens_controls_and_stream_unchanged(self):
        captured = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self): self.respond()
            def do_POST(self): self.respond()
            def respond(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                captured.append((self.command, self.path, self.headers.get("Authorization"), data))
                wire = b'data: {"synthetic":true}\n\n' if self.path == "/v1/responses" else b'{"synthetic":true}'
                self.send_response(200); self.send_header("Content-Length", str(len(wire)))
                self.send_header("Content-Type", "text/event-stream" if self.path == "/v1/responses" else "application/json")
                self.end_headers(); self.wfile.write(wire)
        with tempfile.TemporaryDirectory() as root, ThreadingHTTPServer(("127.0.0.1", 0), Upstream) as upstream:
            thread = threading.Thread(target=upstream.serve_forever, daemon=True); thread.start()
            with policy.Server(("127.0.0.1", 0), upstream.server_port, Path(root) / "audit.jsonl") as witness:
                worker = threading.Thread(target=witness.serve_forever, daemon=True); worker.start()
                def post(path, body):
                    connection = http.client.HTTPConnection("127.0.0.1", witness.server_port, timeout=3)
                    connection.request("POST", path, json.dumps(body), {"Authorization": "Bearer synthetic-token"})
                    response = connection.getresponse(); value = (response.status, response.read()); connection.close(); return value
                self.assertEqual(post("/v1/responses", {**request(), "reasoning": {"effort": "medium"}})[0], 400)
                self.assertEqual(captured, [])
                self.assertEqual(post("/v1/responses", request()), (200, b'data: {"synthetic":true}\n\n'))
                self.assertEqual(captured[-1][2], "Bearer synthetic-token")
                self.assertEqual(json.loads(captured[-1][3]), policy.apply_policy(request())[0])
                control = {"actor": "foundry-vector", "calls": 500, "label": "synthetic"}
                self.assertEqual(post("/control", control)[0], 200)
                self.assertEqual(json.loads(captured[-1][3]), control)
                self.assertEqual(post("/disarm", {"requestToken": "synthetic-scoped"})[0], 200)
                self.assertEqual(json.loads(captured[-1][3]), {"requestToken": "synthetic-scoped"})
                connection = http.client.HTTPConnection("127.0.0.1", witness.server_port, timeout=3)
                connection.request("GET", "/status", headers={"Authorization": "Bearer synthetic-controller"})
                response = connection.getresponse(); self.assertEqual(response.status, 200); response.read(); connection.close()
                self.assertEqual(captured[-1][:3], ("GET", "/status", "Bearer synthetic-controller"))
                log = (Path(root) / "audit.jsonl").read_text()
                self.assertNotIn("Bearer", log); self.assertNotIn("synthetic-token", log); self.assertNotIn("synthetic-session", log)
                count = len(captured)
                with patch.object(witness, "record", side_effect=OSError("synthetic audit failure")):
                    self.assertEqual(post("/v1/responses", request())[0], 503)
                self.assertEqual(len(captured), count)
                witness.shutdown(); worker.join()
            upstream.shutdown(); thread.join()


if __name__ == "__main__":
    unittest.main()
