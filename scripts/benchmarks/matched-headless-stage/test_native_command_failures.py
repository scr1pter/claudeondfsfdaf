"""Observed failed-command normalization controls using synthetic local metadata."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import paired_runner as runner


class NativeCommandFailureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.common = runner.common_helpers(Path(__file__).resolve().parent.parent / "agentic-study")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native-command-failure-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.app = self.directory / "app"
        self.app.mkdir()

    def command_row(self, *, exit_code=7, status="failed", command="Write-Output synthetic-fixture"):
        return {
            "type": "event_msg",
            "timestamp": "2026-11-01T00:00:02Z",
            "payload": {
                "type": "item_completed",
                "started_at_ms": 1793491201000,
                "completed_at_ms": 1793491202000,
                "item": {
                    "type": "CommandExecution", "id": "synthetic-command", "command": command,
                    "status": status, "exit_code": exit_code,
                },
            },
        }

    def rows(self, command, *, completed=False, fatal=False):
        rows = [
            {"type": "session_meta", "timestamp": "2026-11-01T00:00:00Z", "payload": {}},
            {"type": "event_msg", "timestamp": "2026-11-01T00:00:00Z", "payload": {"type": "task_started"}},
            command,
        ]
        if fatal:
            rows.append({"type": "event_msg", "timestamp": "2026-11-01T00:00:03Z",
                         "payload": {"type": "error", "message": "synthetic native failure"}})
        if completed:
            rows.append({"type": "event_msg", "timestamp": "2026-11-01T00:00:04Z",
                         "payload": {"type": "task_complete"}})
        return rows

    def normalize(self, command, **outcome):
        path = self.directory / "rollout.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in self.rows(command, **outcome)), encoding="utf-8")
        return runner.normalize_transcript(path, "codex")

    def audit_commands(self, normalized):
        path = self.directory / "audit-events.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in normalized["events"]), encoding="utf-8")
        return self.common.audit_tool_events(path, "codex", self.app, "shared-client")

    def test_observed_failed_commands_retain_positive_and_negative_exit_metadata(self):
        for exit_code in (1, 7, -9):
            with self.subTest(exit_code=exit_code):
                normalized = self.normalize(self.command_row(exit_code=exit_code))
                self.assertEqual(len(normalized["events"]), 2)
                finished = normalized["events"][1]
                self.assertEqual(finished["type"], "item.completed")
                self.assertEqual(finished["item"]["status"], "failed")
                self.assertEqual(finished["item"]["exit_code"], exit_code)
                self.assertEqual(normalized["executions"][0]["status"], "failed")
                self.assertEqual(normalized["executions"][0]["exitCode"], exit_code)
                self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
                self.assertEqual(normalized["unknownInteractiveInputs"], 0)

    def test_malformed_failed_or_nonterminal_commands_remain_unknown(self):
        changes = [
            ("failed-zero-exit", "item", "exit_code", 0),
            ("missing-exit", "item", "exit_code", None),
            ("boolean-exit", "item", "exit_code", True),
            ("float-exit", "item", "exit_code", 1.0),
            ("string-exit", "item", "exit_code", "1"),
            ("in-progress", "item", "status", "in_progress"),
            ("status-missing", "item", "status", None),
            ("unknown-status", "item", "status", "cancelled"),
            ("missing-command", "item", "command", None),
            ("blank-command", "item", "command", "  "),
            ("empty-command-vector", "item", "command", []),
            ("missing-id", "item", "id", None),
            ("empty-id", "item", "id", ""),
            ("missing-start", "payload", "started_at_ms", None),
            ("missing-end", "payload", "completed_at_ms", None),
            ("boolean-start", "payload", "started_at_ms", True),
            ("nan-start", "payload", "started_at_ms", float("nan")),
            ("infinite-start", "payload", "started_at_ms", float("inf")),
            ("nan-end", "payload", "completed_at_ms", float("nan")),
            ("infinite-end", "payload", "completed_at_ms", float("inf")),
            ("reversed-time", "payload", "started_at_ms", 1793491203000),
        ]
        for name, location, key, value in changes:
            with self.subTest(name=name):
                command = self.command_row()
                target = command["payload"]["item"] if location == "item" else command["payload"]
                if value is None:
                    target.pop(key)
                else:
                    target[key] = value
                normalized = self.normalize(command)
                self.assertEqual(normalized["knownFailedCommandExecutions"], 0)
                self.assertEqual(normalized["unknownInteractiveInputs"], 1)
                self.assertEqual(normalized["events"], [])
                self.assertEqual(normalized["executions"], [])

    def test_invalid_iso_timestamp_keeps_existing_fail_closed_exception(self):
        command = self.command_row()
        command["payload"]["started_at_ms"] = "not-a-timestamp"
        with self.assertRaises(ValueError):
            self.normalize(command)

    def test_completed_status_keeps_acceptance_and_records_nonzero_exit_as_failure(self):
        for exit_code in (0, 4):
            with self.subTest(exit_code=exit_code):
                normalized = self.normalize(self.command_row(status="completed", exit_code=exit_code), completed=True)
                self.assertEqual(normalized["unknownInteractiveInputs"], 0)
                self.assertEqual(normalized["knownFailedCommandExecutions"], int(exit_code != 0))
                self.assertEqual(normalized["events"][1]["item"]["status"], "completed")
                self.assertEqual(normalized["events"][1]["item"]["exit_code"], exit_code)
                self.assertEqual(normalized["latestOutcome"], "completed")

    def test_tool_failure_alone_does_not_complete_native_turn(self):
        normalized = self.normalize(self.command_row())
        self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
        self.assertEqual(normalized["latestOutcome"], "pending")
        self.assertEqual(normalized["completions"], [])
        self.assertIsNone(normalized["completed"])
        self.assertEqual(normalized["nativeErrorObservations"], 0)

    def test_native_completion_after_a_failed_command_stays_explicit(self):
        normalized = self.normalize(self.command_row(), completed=True)
        self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
        self.assertEqual(normalized["latestOutcome"], "completed")
        self.assertEqual(len(normalized["completions"]), 1)

    def test_native_fatal_observation_is_not_cleared_by_known_command_failure(self):
        normalized = self.normalize(self.command_row(), fatal=True)
        self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
        self.assertEqual(normalized["latestOutcome"], "fatal")
        self.assertEqual(normalized["nativeErrorObservations"], 1)
        self.assertEqual(normalized["completions"], [])

    def test_failed_browser_library_command_still_requires_manual_review(self):
        normalized = self.normalize(self.command_row(command="node -e \"require('playwright')\""))
        audit = self.audit_commands(normalized)
        self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
        self.assertGreater(audit["counts"]["directBrowserReferences"], 0)
        self.assertIn("executed_browser_library_reference", audit["observations"])
        self.assertIs(audit["requiresManualReview"], True)

    def test_failed_missing_script_command_keeps_script_unavailable_review(self):
        normalized = self.normalize(self.command_row(command="node missing-check.mjs"))
        audit = self.audit_commands(normalized)
        self.assertEqual(normalized["knownFailedCommandExecutions"], 1)
        self.assertIn("executed_script_unavailable", audit["observations"])
        self.assertIs(audit["requiresManualReview"], True)

    def test_descendant_session_coverage_reports_known_failure_count_without_passing_pending_turns(self):
        transcripts = self.directory / "transcripts"
        transcripts.mkdir()
        support = self.directory / "support"
        support.mkdir()
        files = []
        for identity in ("synthetic-root", *runner.ROLES):
            key = hashlib.sha256(identity.encode()).hexdigest()
            name = key + ".jsonl"
            path = transcripts / name
            path.write_text("".join(json.dumps(row) + "\n" for row in self.rows(self.command_row())), encoding="utf-8")
            files.append({"file": name, "identitySha256": key, "sha256": self.common.file_hash(path)})
        (transcripts / "manifest.json").write_text(json.dumps({"runtime": "codex", "complete": True, "files": files}),
                                                   encoding="utf-8")
        audit = runner.audit_descendants(self.common, "codex", transcripts, self.app, support,
                    self.directory / "synthetic-client.cjs", {role: role for role in runner.ROLES}, "synthetic-root",
                    verification_mode="headless")
        self.assertEqual(len(audit["sessions"]), 4)
        self.assertTrue(all(session["knownFailedCommandExecutions"] == 1 for session in audit["sessions"]))
        self.assertTrue(all(session["unknownInteractiveInputs"] == 0 for session in audit["sessions"]))
        self.assertTrue(all(session["latestNativeOutcome"] == "pending" for session in audit["sessions"]))
        self.assertIs(audit["requiredNativeLatestOutcomesSettled"], False)
        self.assertIs(audit["requiresManualReview"], True)

    def post_judge_command_audit(self, runtime, status, *, tool="bash", exit_code=7, process_status="exited",
                               execution_start=True, execution_end=True, terminal_sequence=None):
        case = "-".join([runtime, tool, status, str(exit_code), str(process_status),
                         str(execution_start), str(execution_end), str(terminal_sequence)])
        transcripts = self.directory / ("transcripts-" + case)
        transcripts.mkdir()
        support = self.directory / ("support-" + case)
        support.mkdir()
        (self.app / "cli.mjs").write_text("console.log('synthetic fixture')", encoding="utf-8")
        (self.app / "sdk.mjs").write_text("console.log('synthetic fixture')", encoding="utf-8")

        def stamp(seconds):
            return "2026-11-01T00:00:" + format(seconds, "06.3f") + "Z"

        files = []
        for identity in ("synthetic-root", *runner.ROLES):
            judge = identity == "team_judge"
            start, end = (3, 4) if judge else (0, 10) if identity == "synthetic-root" else (0, 2)
            rows = [
                {"type": "session_meta", "timestamp": stamp(start), "payload": {}},
                {"type": "event_msg", "timestamp": stamp(start), "payload": {"type": "task_started"}},
            ]
            commands = [
                (5, "node cli.mjs --help"),
                (6, "node sdk.mjs"),
                (7, "curl http://127.0.0.1:4123/api/synthetic"),
            ] if identity == "synthetic-root" else [(start + .5, "Write-Output synthetic-fixture")]
            if runtime == "vector":
                millis = lambda at: int((1793491200 + at) * 1000)
                rows = [
                    {"table": "session", "row": {"time_created": millis(start)}},
                    {"table": "message", "row": {"time_created": millis(start), "data": json.dumps({
                        "role": "user", "time": {"created": millis(start)},
                    })}},
                    {"table": "message", "row": {"time_created": millis(start + .1), "data": json.dumps({
                        "role": "assistant", "finish": "stop",
                        "time": {"created": millis(start + .1), "completed": millis(end)},
                    })}},
                ]
                for index, (at, command) in enumerate(commands):
                    root = identity == "synthetic-root"
                    code = exit_code if root else 0
                    metadata = {} if code is None else {"exitCode" if tool == "terminal" else "exit": code}
                    if tool == "terminal" and process_status is not None:
                        metadata["status"] = process_status
                    terminal_id = "synthetic-terminal" if terminal_sequence == "reused-id-open" else "synthetic-terminal-" + str(index)
                    if tool == "terminal":
                        metadata.update(action="open", id=terminal_id)
                    if root and terminal_sequence == "ready-running":
                        metadata["matched"] = True
                    times = {"start": millis(at), "end": millis(at + .1)}
                    if root and not execution_start:
                        times.pop("start")
                    if root and not execution_end:
                        times.pop("end")
                    rows.append({"table": "part", "row": {"time_created": millis(at), "data": json.dumps({
                        "id": "synthetic-command-" + str(index), "type": "tool", "tool": tool,
                        "state": {
                            "status": status if root else "completed",
                            "input": {"command": command, **({"action": "open"} if tool == "terminal" else {}),
                                      **({"pattern": "synthetic-ready"} if root and terminal_sequence == "ready-running" else {})},
                            "metadata": metadata,
                            # Output text is deliberately insufficient to prove a successful exit.
                            "output": "Process exited with code 0",
                            "time": times,
                        },
                    })}})
                    if root and terminal_sequence is not None:
                        action = "read" if terminal_sequence == "read" else "wait"
                        followed_id = "synthetic-other-terminal" if terminal_sequence == "mismatched-id" else terminal_id
                        followed_metadata = {"action": action, "id": followed_id,
                                             "status": "running" if terminal_sequence == "ready-running" else "exited"}
                        if terminal_sequence == "ready-running":
                            followed_metadata["matched"] = True
                        else:
                            followed_metadata["exitCode"] = 7 if terminal_sequence == "nonzero-wait" else 0
                        rows.append({"table": "part", "row": {"time_created": millis(at + .2), "data": json.dumps({
                            "id": "synthetic-followup-" + str(index), "type": "tool", "tool": "terminal",
                            "state": {
                                "status": "completed", "input": {"action": action, "id": followed_id,
                                    **({"pattern": "synthetic-ready"} if terminal_sequence == "ready-running" else {})},
                                "metadata": followed_metadata, "output": "Synthetic terminal status observation",
                                "time": {"start": millis(at + .2), "end": millis(at + .3)},
                            },
                        })}})
            for index, (at, command) in enumerate(commands):
                if runtime == "vector":
                    break
                row = self.command_row(command=command,
                                       status=status if identity == "synthetic-root" else "completed",
                                       exit_code=exit_code if identity == "synthetic-root" else 0)
                row["timestamp"] = stamp(at + .1)
                row["payload"]["started_at_ms"] = int((1793491200 + at) * 1000)
                row["payload"]["completed_at_ms"] = int((1793491200 + at + .1) * 1000)
                row["payload"]["item"]["id"] = "synthetic-command-" + str(index)
                rows.append(row)
            if runtime == "codex":
                rows.append({"type": "event_msg", "timestamp": stamp(end), "payload": {"type": "task_complete"}})
            key = hashlib.sha256(identity.encode()).hexdigest()
            name = key + ".jsonl"
            path = transcripts / name
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            files.append({"file": name, "identitySha256": key, "sha256": self.common.file_hash(path)})
        (transcripts / "manifest.json").write_text(json.dumps({"runtime": runtime, "complete": True, "files": files}),
                                                   encoding="utf-8")
        return runner.audit_descendants(self.common, runtime, transcripts, self.app, support,
                    self.directory / "synthetic-client.cjs", {role: role for role in runner.ROLES}, "synthetic-root",
                    verification_mode="headless")

    def test_nonzero_post_judge_commands_never_satisfy_api_cli_or_sdk_verification(self):
        scenarios = [("codex", "failed", "bash"), ("codex", "completed", "bash"),
                     ("vector", "completed", "bash"), ("vector", "error", "bash"),
                     ("vector", "completed", "terminal"), ("vector", "error", "terminal")]
        for runtime, status, tool in scenarios:
            with self.subTest(runtime=runtime, status=status, tool=tool):
                audit = self.post_judge_command_audit(runtime, status, tool=tool)
                self.assertIs(audit["requiredNativeLatestOutcomesSettled"], True)
                self.assertIs(audit["allWorkerCompletionPhasesReviewedBySameJudge"], True)
                if runtime == "codex":
                    self.assertEqual(sum(session["knownFailedCommandExecutions"] for session in audit["sessions"]), 3)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], False)
                self.assertIs(audit["requiresManualReview"], True)

    def test_vector_missing_exit_metadata_never_uses_output_text_as_success_evidence(self):
        for tool in ("bash", "terminal"):
            with self.subTest(tool=tool):
                audit = self.post_judge_command_audit("vector", "completed", tool=tool, exit_code=None)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], False)
                self.assertIs(audit["requiresManualReview"], True)

    def test_explicit_zero_terminal_exits_can_satisfy_verification_for_both_runtimes(self):
        for runtime, tool in (("codex", "bash"), ("vector", "bash"), ("vector", "terminal")):
            with self.subTest(runtime=runtime, tool=tool):
                audit = self.post_judge_command_audit(runtime, "completed", tool=tool, exit_code=0)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], True)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], True)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], True)
                self.assertIs(audit["requiresManualReview"], False)

    def test_terminal_zero_exit_requires_an_explicit_exited_process(self):
        for process_status in ("running", None):
            with self.subTest(process_status=process_status):
                audit = self.post_judge_command_audit("vector", "completed", tool="terminal", exit_code=0,
                                                      process_status=process_status)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], False)
                self.assertIs(audit["requiresManualReview"], True)

    def test_vector_missing_explicit_execution_times_cannot_qualify_success(self):
        for tool in ("bash", "terminal"):
            for execution_start, execution_end in ((False, True), (True, False)):
                with self.subTest(tool=tool, execution_start=execution_start, execution_end=execution_end):
                    audit = self.post_judge_command_audit("vector", "completed", tool=tool, exit_code=0,
                                execution_start=execution_start, execution_end=execution_end)
                    self.assertIs(audit["rootPostJudgeCliVerificationCommandObserved"], True)
                    self.assertIs(audit["rootPostJudgeSdkVerificationCommandObserved"], True)
                    self.assertIs(audit["rootPostJudgeApiVerificationCommandObserved"], True)
                    self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], False)
                    self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], False)
                    self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], False)
                    self.assertIs(audit["requiresManualReview"], True)

    def test_terminal_later_status_observations_do_not_prove_prior_command_success(self):
        for sequence in ("wait", "read", "nonzero-wait", "mismatched-id", "reused-id-open", "ready-running"):
            with self.subTest(sequence=sequence):
                audit = self.post_judge_command_audit("vector", "completed", tool="terminal", exit_code=None,
                            process_status="running", terminal_sequence=sequence)
                self.assertIs(audit["requiredNativeLatestOutcomesSettled"], True)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandObserved"], True)
                self.assertIs(audit["rootPostJudgeCliVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeSdkVerificationCommandSucceeded"], False)
                self.assertIs(audit["rootPostJudgeApiVerificationCommandSucceeded"], False)
                self.assertIs(audit["requiresManualReview"], True)


if __name__ == "__main__":
    unittest.main()
