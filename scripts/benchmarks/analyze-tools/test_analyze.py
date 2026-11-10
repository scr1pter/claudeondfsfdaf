import json
import unittest
from analyze import summarize


def lines(*events):
    return [json.dumps(event) for event in events]


def vector(identifier="part_one", status="completed", value=None):
    return {"type": "tool_use", "part": {"id": identifier, "tool": "terminal", "state": {"status": status, "input": value or {"action": "open", "command": "private command"}, "output": "private output"}}}


class ProjectionTests(unittest.TestCase):
    def test_duplicate_completions_do_not_double_count(self):
        result = summarize(lines(vector(), vector()))
        self.assertEqual(result["observedToolCalls"], 1)
        self.assertEqual(result["tools"]["terminal"]["calls"], 1)
        self.assertEqual(result["recognizedEventRecords"]["vector"], 2)

    def test_repeated_distinct_calls_are_counted_without_exporting_values(self):
        result = summarize(lines(vector("one"), vector("two")))
        self.assertEqual(result["observedToolCalls"], 2)
        self.assertEqual(result["repeatedIdenticalToolInputs"], 1)
        exported = json.dumps(result)
        for private in ["private command", "private output", "part_one"]:
            self.assertNotIn(private, exported)

    def test_pending_and_unrelated_records_are_not_tool_results(self):
        result = summarize(lines(vector(status="running"), {"type": "text", "secret": "private"}))
        self.assertEqual(result["observedToolCalls"], 0)

    def test_codex_completed_item_with_failed_exit_is_an_error(self):
        event = {"type": "item.completed", "item": {"id": "one", "type": "command_execution", "status": "completed", "exit_code": 7, "command": "private", "aggregated_output": "failure"}}
        result = summarize(lines(event))
        self.assertEqual(result["tools"]["shell"]["errors"], 1)
        self.assertEqual(result["tools"]["shell"]["knownTextOutputBytes"], 7)

    def test_absent_codex_diff_is_unobserved_not_zero_size(self):
        event = {"type": "item.completed", "item": {"id": "one", "type": "file_change", "changes": [{"path": "private.ts", "kind": "update"}]}}
        result = summarize(lines(event))
        self.assertEqual(result["tools"]["file_change"]["patchObservations"], 0)
        self.assertEqual(result["tools"]["file_change"]["inputObservations"], 0)
        self.assertNotIn("private.ts", json.dumps(result))

    def test_vector_bash_and_codex_commands_use_the_same_category(self):
        event = vector()
        event["part"]["tool"] = "bash"
        result = summarize(lines(event))
        self.assertEqual(result["tools"]["shell"]["calls"], 1)
        self.assertNotIn("other", result["tools"])

    def test_vector_completed_shell_can_still_exit_nonzero(self):
        event = vector()
        event["part"]["tool"] = "bash"
        event["part"]["state"]["metadata"] = {"exit": 1}
        result = summarize(lines(event))
        self.assertEqual(result["tools"]["shell"]["errors"], 1)

    def test_resize_and_type_actions_are_reported_without_exporting_values(self):
        result = summarize(lines(vector("one", value={"action": "resize", "columns": 80}), vector("two", value={"action": "type", "text": "private typed data"})))
        self.assertEqual(result["terminalActions"], {"resize": 1, "type": 1})
        self.assertNotIn("private typed data", json.dumps(result))

    def test_malformed_and_unknown_records_are_explicit(self):
        result = summarize(["not json", "[]", json.dumps({"type": "tool_use", "part": {"tool": "shell", "state": {"status": "completed"}}})])
        self.assertEqual(result["invalidRecords"], 2)

    def test_unknown_tool_names_are_not_exported(self):
        event = vector()
        event["part"]["tool"] = "private-tool-name"
        result = summarize(lines(event))
        self.assertIn("other", result["tools"])
        self.assertNotIn("private-tool-name", json.dumps(result))

    def test_nonstring_tool_names_are_invalid_records(self):
        event = vector()
        event["part"]["tool"] = ["private"]
        result = summarize(lines(event))
        self.assertEqual(result["invalidRecords"], 1)
        self.assertEqual(result["observedToolCalls"], 0)

    def test_unicode_counts_bytes_and_terminal_actions_are_bounded(self):
        result = summarize(lines(vector(value={"action": "wait", "pattern": "α"})))
        self.assertEqual(result["terminalActions"], {"wait": 1})
        self.assertGreater(result["tools"]["terminal"]["knownInputBytes"], 2)


if __name__ == "__main__":
    unittest.main()
