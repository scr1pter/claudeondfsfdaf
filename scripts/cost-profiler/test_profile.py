import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("cost_profile", Path(__file__).with_name("profile.py"))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.arm = Path(self.temp.name) / "arm"
        self.arm.mkdir()

    def fixture(self, count=1, same_sha=False, disconnected=False):
        audit = [{"type": "arm_bound", "actor": "synthetic", "label": "fixture", "batchSha256": "batch"}]
        receipts = []
        for index in range(count):
            start = 10000 + index * 20000
            sha = "same" if same_sha else f"request-{index}"
            usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
            audit.extend([
                {"type": "before_upstream", "ordinal": index + 1, "role": "lead", "requestSha256": sha,
                 "unixNs": start * 1000000, "identitySha256": hashlib.sha256(b"synthetic-thread").hexdigest()},
                {"type": "after_upstream", "ordinal": index + 1, "requestSha256": sha,
                 "unixNs": (start + 1000) * 1000000, "usage": usage, "clientDisconnected": disconnected,
                 "terminalObserved": True},
                {"type": "receipt_registered", "ordinal": index + 1, "requestSha256": sha, "meterReceiptSequence": index + 100},
            ])
            receipts.append({"seq": index + 100, "requestSha256": sha, "actor": "synthetic", "label": "fixture",
                             "batchSha256": "batch", "usage": usage, "measuredUsd": "0.123456789",
                             "responseStatus": "cancelled" if disconnected else "completed",
                             "responseID": f"private-response-{index}", "inputItemSha256": ["item", "item"],
                             "secret": "MUST_NOT_PUBLISH_RECEIPT_SECRET"})
        audit.append({"type": "owned_scope_closed", "providerRequests": count, "measuredUsd": count * 0.123456789})
        self.write_audit(audit)
        return audit, receipts

    def write_audit(self, audit):
        (self.arm / "witness-audit.jsonl").write_text("\n".join(json.dumps(row) for row in audit), encoding="utf-8")

    def vector(self, tools=None, native_usd=99, duplicate=False):
        root = self.arm / "private-transcripts"
        root.mkdir()
        rows = [
            {"table": "session", "row": {"id": "private-native-id", "parent_id": None}},
            {"table": "message", "row": {"id": "message", "time_created": 10000,
                                         "data": json.dumps({"role": "assistant", "text": "MUST_NOT_PUBLISH_PROMPT"})}},
            {"table": "part", "row": {"id": "finish", "message_id": "message", "time_created": 11000,
                                      "data": json.dumps({"type": "step-finish", "cost": native_usd,
                                                          "tokens": {"input": 10, "output": 5, "total": 15, "cache": {}}})}},
        ]
        for index, tool in enumerate(tools or []):
            rows.append({"table": "part", "row": {"id": f"tool-{index}", "message_id": "message", "time_created": 11500,
                                                   "data": json.dumps(tool)}})
        if duplicate:
            rows.append({"table": "part", "row": {"id": "second-finish", "message_id": "message", "time_created": 11001,
                                                   "data": rows[2]["row"]["data"]}})
        path = root / "fixture.jsonl"
        path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps({"files": [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]}), encoding="utf-8")

    def test_cancelled_charge_without_native_is_retained(self):
        _, receipts = self.fixture(disconnected=True)
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["accounting"]["knownMeasuredUsd"], "0.123456789")
        self.assertEqual(result["coverage"]["unmatchedChargesRetained"]["receiptCount"], 1)
        self.assertTrue(result["charges"][0]["clientDisconnected"])

    def test_unknown_cost_is_never_guessed_zero(self):
        _, receipts = self.fixture()
        receipts[0].pop("measuredUsd")
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["accounting"]["unknownMeasuredUsdCount"], 1)
        self.assertFalse(result["accounting"]["measuredUsdComplete"])
        self.assertIsNone(result["charges"][0]["measuredUsd"])

    def test_after_upstream_observation_is_not_proof_of_terminal(self):
        audit, receipts = self.fixture()
        audit[2].update(terminalObserved=False, outcome="upstream_terminal_schema_unknown")
        self.write_audit(audit)
        result = profile.profile_arm(self.arm, receipts)
        self.assertFalse(result["closureReconciliation"]["allProviderTerminalsObserved"])
        self.assertTrue(result["provisional"])
        self.assertEqual(result["accounting"]["knownMeasuredUsd"], "0.123456789")

    def test_missing_terminal_assertion_stays_provisional(self):
        audit, receipts = self.fixture()
        del audit[2]["terminalObserved"]
        self.write_audit(audit)
        result = profile.profile_arm(self.arm, receipts)
        self.assertFalse(result["closureReconciliation"]["allProviderTerminalsObserved"])
        self.assertTrue(result["provisional"])

    def test_native_dollars_do_not_control_join_or_accounting(self):
        _, receipts = self.fixture()
        self.vector(native_usd=99999)
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["coverage"]["uniquelyJoinedNativeRecords"], 1)
        self.assertEqual(result["accounting"]["knownMeasuredUsd"], "0.123456789")
        self.assertEqual(result["nativeReportedPriceComparison"]["nativeReportedUsdNotAuthoritative"], "99999")

    def test_reverse_collision_never_greedily_claims_charge(self):
        _, receipts = self.fixture()
        self.vector(duplicate=True)
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["coverage"]["uniquelyJoinedNativeRecords"], 0)
        self.assertEqual(result["coverage"]["ambiguousNativeRecords"], 2)
        self.assertEqual(result["coverage"]["unmatchedChargesRetained"]["knownMeasuredUsd"], "0.123456789")

    def test_long_tool_lifetime_still_contains_provider_interval(self):
        _, receipts = self.fixture()
        requests = {1: {"before": {"role": "lead"}, "after": {"usage": receipts[0]["usage"]},
                        "startMs": 10000, "endMs": 11000}}
        step = {"role": "lead", "identity": None, "usage": (10, 5, 15), "createdMs": 10000,
                "finishedMs": 90000, "responseID": None}
        links, _ = profile.native_links(requests, {1: 0}, receipts, [step], 5000)
        self.assertEqual(links, {0: 1})

    def test_repeated_sha_with_distinct_time_is_not_deduplicated(self):
        audit, receipts = self.fixture(count=2, same_sha=True)
        audit = [row for row in audit if row["type"] != "receipt_registered"]
        self.write_audit(audit)
        for index, row in enumerate(receipts):
            row["startedUtc"] = "1970-01-01T00:00:10Z" if index == 0 else "1970-01-01T00:00:30Z"
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["coverage"]["receiptReconciledRequests"], 2)
        self.assertEqual(result["accounting"]["knownMeasuredUsd"], "0.246913578")

    def test_hash_disagreement_fails(self):
        audit, receipts = self.fixture()
        audit[2]["requestSha256"] = "different"
        self.write_audit(audit)
        with self.assertRaises(profile.AuditError):
            profile.profile_arm(self.arm, receipts)

    def test_unclosed_run_requires_provisional_mode(self):
        audit, receipts = self.fixture()
        self.write_audit(audit[:-1])
        with self.assertRaises(profile.AuditError):
            profile.profile_arm(self.arm, receipts)
        self.assertTrue(profile.profile_arm(self.arm, receipts, provisional=True)["provisional"])

    def test_timeout_shape_is_narrow_and_public_projection_has_no_content(self):
        _, receipts = self.fixture()
        self.vector([{"type": "tool", "tool": "task_manage", "state": {"input": {"action": "wait", "task_id": "private-task"},
                     "output": json.dumps({"tasks": [{"prompt": "MUST_NOT_PUBLISH_TASK"}], "timedOut": True})}}])
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["diagnostics"]["timedOutWaitCalls"], 1)
        self.assertEqual(result["charges"][0]["turnCategory"], "status_wait_only")
        serialized = json.dumps(result)
        for secret in ("private-native-id", "private-task", "private-response", "MUST_NOT_PUBLISH", str(self.arm)):
            self.assertNotIn(secret, serialized)

    def test_codex_token_snapshots_are_not_extra_requests_and_sqlite_is_unchanged(self):
        _, receipts = self.fixture()
        root = self.arm / "runtime-home"
        root.mkdir()
        db = root / "state_5.sqlite"
        conn = sqlite3.connect(db)
        conn.execute("CREATE TABLE threads(id TEXT, agent_role TEXT)")
        conn.execute("INSERT INTO threads VALUES ('synthetic-thread', NULL)")
        conn.commit()
        conn.close()
        before = db.read_bytes()
        rows = [
            {"type": "session_meta", "timestamp": "1970-01-01T00:00:09Z", "payload": {"id": "synthetic-thread", "base_instructions": "MUST_NOT_PUBLISH"}},
            {"type": "session_meta", "timestamp": "1970-01-01T00:00:09Z", "payload": {"id": "inherited-parent"}},
            {"type": "event_msg", "timestamp": "1970-01-01T00:00:09Z", "payload": {"type": "task_started", "started_at": 9000}},
            {"type": "response_item", "timestamp": "1970-01-01T00:00:09Z", "payload": {"type": "function_call", "call_id": "old-call", "name": "apply_patch", "arguments": "{}", "internal_chat_message_metadata_passthrough": {"turn_id": "parent-turn"}}},
            {"type": "response_item", "timestamp": "1970-01-01T00:00:10Z", "payload": {"type": "function_call", "call_id": "call", "name": "send_message", "arguments": '{"message":"MUST_NOT_PUBLISH"}', "internal_chat_message_metadata_passthrough": {"turn_id": "current-turn"}}},
            {"type": "token_usage_record", "timestamp": "1970-01-01T00:00:11Z", "payload": {"thread_id": "synthetic-thread", "turn_id": "current-turn", "response_id": "private-response-0", "usage": receipts[0]["usage"]}},
            {"type": "event_msg", "timestamp": "1970-01-01T00:00:12Z", "payload": {"type": "token_count", "info": {"last_token_usage": receipts[0]["usage"]}}},
        ]
        (root / "rollout-fixture.jsonl").write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
        result = profile.profile_arm(self.arm, receipts)
        self.assertEqual(result["coverage"]["nativeUsageRecords"], 1)
        self.assertEqual(result["coverage"]["uniquelyJoinedNativeRecords"], 1)
        self.assertEqual(result["charges"][0]["turnCategory"], "orchestration_only")
        self.assertEqual(result["native"]["inheritedToolRecordsExcludedByTurn"], 1)
        self.assertEqual(result["diagnostics"]["toolCounts"], {"send_message": 1})
        self.assertEqual(before, db.read_bytes())
        self.assertNotIn("MUST_NOT_PUBLISH", json.dumps(result))

    def test_mixed_tools_are_not_relabelled_as_readonly(self):
        step = {"tools": [profile.tool_record("read", {}), profile.tool_record("bash", {"command": "test"})]}
        self.assertEqual(profile.turn_category(step), "mixed_heuristic")


if __name__ == "__main__":
    unittest.main()
