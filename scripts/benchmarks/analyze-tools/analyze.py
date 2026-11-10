"""Project CLI JSONL into bounded counts; never export commands, text, paths or IDs."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

TOOLS = {
    "shell", "terminal", "read", "glob", "grep", "edit", "write", "apply_patch",
    "browser", "memory", "skill", "todo", "todowrite", "task", "task_manage", "research", "escalate",
}
ACTIONS = {"open", "wait", "read", "close", "keys", "list", "type", "resize"}


def byte_count(value):
    return len(value.encode("utf-8")) if isinstance(value, str) else None


def summarize(lines):
    records = {}
    invalid = 0
    recognized = Counter()
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            invalid += 1
            continue
        if not isinstance(event, dict):
            continue
        part = event.get("part")
        if event.get("type") == "tool_use" and isinstance(part, dict):
            state = part.get("state")
            if not isinstance(state, dict) or state.get("status") not in ("completed", "error"):
                continue
            key = part.get("id") or part.get("callID")
            if not isinstance(key, str):
                invalid += 1
                continue
            name = part.get("tool")
            if not isinstance(name, str):
                invalid += 1
                continue
            tool = "shell" if name in ("bash", "shell") else name if name in TOOLS else "other"
            supplied = state.get("input")
            metadata = state.get("metadata")
            exit_code = metadata.get("exit") if isinstance(metadata, dict) else None
            nonzero = tool == "shell" and isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code != 0
            action = supplied.get("action") if tool == "terminal" and isinstance(supplied, dict) else None
            patch = supplied.get("patchText", supplied.get("patch")) if isinstance(supplied, dict) else None
            records[("vector", key)] = {
                "tool": tool, "error": state["status"] == "error" or nonzero, "input": supplied,
                "textOutputBytes": byte_count(state.get("output")), "patchBytes": byte_count(patch),
                "terminalAction": action if isinstance(action, str) and action in ACTIONS else None,
            }
            recognized["vector"] += 1
        item = event.get("item")
        if event.get("type") != "item.completed" or not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind not in ("command_execution", "file_change"):
            continue
        key = item.get("id")
        if not isinstance(key, str):
            invalid += 1
            continue
        command = kind == "command_execution"
        changes = item.get("changes")
        diffs = [change["diff"] for change in changes if isinstance(change, dict) and isinstance(change.get("diff"), str)] if isinstance(changes, list) else []
        records[("codex", key)] = {
            "tool": "shell" if command else "file_change",
            # A completed command item can still have a nonzero exit code.
            "error": item.get("status") == "failed" or (command and isinstance(item.get("exit_code"), int) and item["exit_code"] != 0),
            "input": item.get("command") if command else None,
            "textOutputBytes": byte_count(item.get("aggregated_output")) if command else None,
            "patchBytes": sum(len(diff.encode("utf-8")) for diff in diffs) if diffs else None,
            "terminalAction": None,
        }
        recognized["codex"] += 1
    tools = {}
    inputs = Counter()
    actions = Counter()
    for (runtime, _), record in records.items():
        tool = record["tool"]
        aggregate = tools.setdefault(tool, {"calls": 0, "errors": 0, "knownInputBytes": 0, "inputObservations": 0, "knownTextOutputBytes": 0, "textOutputObservations": 0, "knownPatchBytes": 0, "patchObservations": 0})
        aggregate["calls"] += 1
        aggregate["errors"] += int(record["error"])
        if record["input"] is not None:
            encoded = json.dumps(record["input"], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            aggregate["knownInputBytes"] += len(encoded)
            aggregate["inputObservations"] += 1
            inputs[(runtime, tool, hashlib.sha256(encoded).digest())] += 1
        for field, total, count in [("textOutputBytes", "knownTextOutputBytes", "textOutputObservations"), ("patchBytes", "knownPatchBytes", "patchObservations")]:
            if record[field] is not None:
                aggregate[total] += record[field]
                aggregate[count] += 1
        if record["terminalAction"]:
            actions[record["terminalAction"]] += 1
    return {
        "kind": "CLI tool activity counts; no raw commands, text, paths, IDs or hashes",
        "observedToolCalls": len(records), "recognizedEventRecords": dict(recognized),
        "invalidRecords": invalid, "tools": tools, "terminalActions": dict(actions),
        "repeatedIdenticalToolInputs": sum(count - 1 for count in inputs.values()),
        "scope": "Observed bytes are not model tokens or cost. Missing input/output/diff fields have zero observations, not measured zero size. Errors count explicit tool errors or nonzero command exits in both runtimes; expected negative checks can legitimately exit nonzero, so these outcomes do not automatically indicate waste or product failure. Duplicate completion events are deduplicated by runtime and private transient ID.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl", type=Path)
    args = parser.parse_args()
    with args.jsonl.open(encoding="utf-8", errors="replace") as stream:
        print(json.dumps(summarize(stream), indent=2))


if __name__ == "__main__":
    main()
