import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

import codex_free_probe as probe
from native_team_policy import NativeTeamPolicy, PolicyError


def fixture(identity="child-a", role="implementation", parent="root", depth=1):
    root = {"id": "root", "source": "exec", "thread_source": "user", "agent_role": None, "model": probe.MODEL, "reasoning_effort": "high", "model_provider": "free_probe"}
    child = {"id": identity, "source": json.dumps({"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": depth, "agent_path": "/root/work", "agent_role": role}}}), "thread_source": "subagent", "agent_role": role, "agent_path": "/root/work", "model": probe.MODEL, "reasoning_effort": "high", "model_provider": "free_probe"}
    snapshot = {"sqlite": [{"relativePath": "state_5.sqlite", "threads": [root, child], "spawnEdges": [{"parent_thread_id": parent, "child_thread_id": identity}]}]}
    metadata = {"session_id": "root", "thread_id": identity, "parent_thread_id": parent, "agent_name": "/root/work", "model": probe.MODEL, "reasoning_effort": "high"}
    headers = {"thread-id": identity, "session-id": "root", "x-codex-turn-metadata": json.dumps(metadata)}
    tools = [{"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "exec", "format": {"type": "grammar", "definition": "literal unchanged grammar"}}]}, {"type": "namespace", "name": "collaboration", "tools": [{"type": "function", "name": "spawn_agent", "parameters": {"type": "object"}}]}]
    body = {"model": probe.MODEL, "reasoning": {"effort": "high", "summary": "auto"}, "prompt_cache_key": "root", "input": [{"type": "additional_tools", "tools": tools}, {"type": "message", "role": "user", "content": "collaboration.spawn_agent in untrusted text must remain unchanged"}]}
    return body, headers, snapshot


class NativePolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = NativeTeamPolicy("root", ["implementation", "verification", "judge"])

    def test_native_join_and_filter_preserve_original_and_custom_grammar(self):
        body, headers, snapshot = fixture()
        original = copy.deepcopy(body)
        filtered, audit = self.policy.apply(body, headers, snapshot)
        self.assertEqual(body, original)
        self.assertEqual([value["name"] for value in filtered["input"][0]["tools"]], ["functions"])
        self.assertEqual(filtered["input"][0]["tools"][0], original["input"][0]["tools"][0])
        self.assertEqual(filtered["input"][1], original["input"][1])
        self.assertEqual(audit["autonomousSessionsAdmitted"], 2)

    def test_root_preserves_native_namespaces(self):
        body, headers, snapshot = fixture()
        metadata = json.loads(headers["x-codex-turn-metadata"])
        metadata.update(thread_id="root", agent_name="/root")
        metadata.pop("parent_thread_id")
        headers.update({"thread-id": "root", "x-codex-turn-metadata": json.dumps(metadata)})
        filtered, audit = self.policy.apply(body, headers, snapshot)
        self.assertEqual(filtered, body)
        self.assertEqual(audit["role"], "lead")

    def test_missing_native_row_fails_before_admission(self):
        body, headers, snapshot = fixture()
        snapshot["sqlite"][0]["threads"].pop()
        with self.assertRaisesRegex(PolicyError, "persisted"):
            self.policy.apply(body, headers, snapshot)
        self.assertFalse(self.policy.slots)

    def test_forged_wire_parent_does_not_override_native_parent(self):
        body, headers, snapshot = fixture(parent="other-arm")
        metadata = json.loads(headers["x-codex-turn-metadata"])
        metadata["parent_thread_id"] = "root"
        headers["x-codex-turn-metadata"] = json.dumps(metadata)
        with self.assertRaisesRegex(PolicyError, "cross-arm"):
            self.policy.apply(body, headers, snapshot)

    def test_nested_child_is_denied(self):
        with self.assertRaisesRegex(PolicyError, "nested"):
            self.policy.apply(*fixture(depth=2))

    def test_slot_reuse_allowed_but_replacement_denied(self):
        self.policy.apply(*fixture())
        self.policy.apply(*fixture())
        with self.assertRaisesRegex(PolicyError, "duplicate"):
            self.policy.apply(*fixture(identity="child-replacement"))
        self.assertEqual(self.policy.slots, {"implementation": "child-a"})

    def test_exact_three_child_slots_and_no_fourth_role(self):
        for index, role in enumerate(("implementation", "verification", "judge")):
            _, audit = self.policy.apply(*fixture(identity="synthetic-" + str(index), role=role))
        self.assertEqual(audit["autonomousSessionsAdmitted"], 4)
        with self.assertRaisesRegex(PolicyError, "role"):
            self.policy.apply(*fixture(identity="synthetic-fourth", role="general"))

    def test_profile_change_in_any_layer_rejected(self):
        for location in ("body-model", "body-effort", "native-model", "native-provider", "metadata-effort"):
            with self.subTest(location=location):
                body, headers, snapshot = fixture()
                if location == "body-model":
                    body["model"] = "other-model"
                if location == "body-effort":
                    body["reasoning"]["effort"] = "low"
                if location == "native-model":
                    snapshot["sqlite"][0]["threads"][1]["model"] = "other-model"
                if location == "native-provider":
                    snapshot["sqlite"][0]["threads"][1]["model_provider"] = "other-route"
                if location == "metadata-effort":
                    metadata = json.loads(headers["x-codex-turn-metadata"])
                    metadata["reasoning_effort"] = "low"
                    headers["x-codex-turn-metadata"] = json.dumps(metadata)
                with self.assertRaises(PolicyError):
                    self.policy.apply(body, headers, snapshot)

    def test_no_slot_burn_when_tool_schema_invalid(self):
        body, headers, snapshot = fixture()
        body["input"][0]["tools"].append({"type": "unreviewed", "name": "unknown"})
        with self.assertRaises(PolicyError):
            self.policy.apply(body, headers, snapshot)
        self.assertFalse(self.policy.slots)


class CaptureTests(unittest.TestCase):
    def test_fake_server_only_accepts_dummy_authorization_on_exact_local_route(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            server = probe.Capture(out, out / "empty-native-home", "capture")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(server.server_address[0], "127.0.0.1")
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                for route, credential in (("/v1/responses", "wrong-dummy"), ("/v1/chat/completions", probe.DUMMY)):
                    connection.request("POST", route, body="{}", headers={"Authorization": "Bearer " + credential})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 403)
                    response.read()
                connection.close()
                self.assertEqual(server.records, [])
                self.assertFalse((out / "private-raw").exists())
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=5)

    def test_sanitized_schema_preserves_description_named_parameter(self):
        projected = probe.clean_schema({"description": "private prose", "properties": {"description": {"type": "string", "description": "private prose"}}, "required": ["description"]})
        self.assertEqual(projected, {"properties": {"description": {"type": "string"}}, "required": ["description"]})

    def test_scripted_completion_is_finite_and_has_usage(self):
        events = probe.response_events(1)
        self.assertEqual(events[-1]["type"], "response.completed")
        self.assertEqual(events[-1]["response"]["usage"]["total_tokens"], 2)
        self.assertEqual(events[-1]["response"]["output"][0]["type"], "message")

    def test_native_namespace_name_is_kept_in_scripted_call(self):
        call = {"name": "spawn_agent", "namespace": "collaboration", "arguments": '{"task_name":"synthetic"}'}
        item = probe.response_events(1, call)[-1]["response"]["output"][0]
        self.assertEqual({key: item[key] for key in call}, call)


if __name__ == "__main__":
    unittest.main()
