"""Read-only receipt accounting and conservative native-history cost attribution.

Only the explicit projection returned by profile_arm is publishable. Raw input
objects, IDs, hashes, tool arguments, results, and filesystem paths stay private.
"""
from __future__ import annotations

import argparse
import collections
from datetime import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys


class AuditError(ValueError):
    pass


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)


def load_lines(path):
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line, parse_float=Decimal))
        except ValueError:
            raise AuditError(f"Invalid JSONL at line {number}") from None
    return rows


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str,
                                     separators=(",", ":")).encode()).hexdigest()


def number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
    except Exception:
        return None
    return result if result.is_finite() else None


def money(rows):
    values = [number(row.get("measuredUsd")) for row in rows]
    known = [value for value in values if value is not None]
    return {"receiptCount": len(rows), "knownMeasuredUsd": str(sum(known, Decimal(0))),
            "unknownMeasuredUsdCount": len(values) - len(known),
            "measuredUsdComplete": len(values) == len(known)}


def milliseconds(value):
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, AttributeError):
        return None


def safe_name(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,64}", value) else "unknown"


def usage_vector(value, vector_native=False):
    if not isinstance(value, dict):
        return None
    if vector_native:
        cache = value.get("cache", {})
        keys = (value.get("input"), value.get("output"), value.get("total"))
        if any(not isinstance(item, int) or isinstance(item, bool) for item in keys):
            return None
        return (keys[0] + cache.get("read", 0) + cache.get("write", 0),
                keys[1] + value.get("reasoning", 0), keys[2])
    keys = tuple(value.get(key) for key in ("input_tokens", "output_tokens", "total_tokens"))
    return keys if all(isinstance(item, int) and not isinstance(item, bool) for item in keys) else None


def unique_links(candidates):
    """Accept only isolated edges in the complete bipartite candidate graph.

    A greedy 'first unique candidate wins' silently attributes a charge when two
    native records both identify the same request. Neither is accepted here.
    """
    reverse = collections.Counter(right for choices in candidates.values() for right in choices)
    return {left: choices[0] for left, choices in candidates.items()
            if len(choices) == 1 and reverse[choices[0]] == 1}


def parse_object(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        result = json.loads(value)
    except ValueError:
        return {}
    return result if isinstance(result, dict) else {}


def tool_record(name, inputs, output=None, action=None):
    parsed = parse_object(output)
    inputs = inputs if isinstance(inputs, dict) else {}
    action = action or inputs.get("action")
    if name in ("read", "grep", "glob", "list", "ls"):
        category = "read_only"
    elif (name in ("task_manage", "task-manage") and action == "wait") or name == "wait_agent":
        category = "status_wait"
    elif name in ("task", "task_manage", "task-manage", "todowrite", "spawn_agent", "send_message",
                  "followup_task", "list_agents", "interrupt_agent"):
        category = "orchestration"
    elif name in ("apply_patch", "edit", "write"):
        category = "edit"
    elif name in ("bash", "terminal", "exec_command", "write_stdin"):
        category = "execution_or_verification"
    else:
        category = "unknown"
    # A code-wrapper's literal calls are only hints: a branch may never execute.
    code = inputs.get("_code", "")
    hints = re.findall(r"\btools\.([a-zA-Z0-9_]+)\s*\(", code) if isinstance(code, str) else []
    return {"name": safe_name(name), "action": safe_name(action) if action else None,
            "category": category, "inputFingerprint": fingerprint(inputs),
            "outputFingerprint": fingerprint(output) if output is not None else None,
            "outputBytes": len(str(output).encode()) if output is not None else 0,
            "timedOut": parsed.get("timedOut") is True if category == "status_wait" else False,
            "waitShape": tuple(key for key in ("tasks", "timedOut", "status") if key in parsed),
            "wrapperToolHints": [safe_name(item) for item in hints]}


def turn_category(step):
    categories = {tool["category"] for tool in step["tools"]}
    if not categories:
        return "no_tools"
    if len(categories) > 1:
        return "mixed_heuristic"
    category = next(iter(categories))
    return {"status_wait": "status_wait_only", "orchestration": "orchestration_only",
            "unknown": "unknown_tool_semantics"}.get(category, category)


def vector_steps(arm):
    root = arm / "private-transcripts"
    manifest = root / "manifest.json"
    if not manifest.exists():
        return [], {"adapter": "vector", "nativeFiles": 0}
    steps = []
    files = load_json(manifest).get("files", [])
    for item in files:
        path = (root / item["file"]).resolve()
        if not path.is_relative_to(root.resolve()):
            raise AuditError("Transcript manifest escapes its root")
        if item.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
            raise AuditError("Transcript manifest hash mismatch")
        rows = load_lines(path)
        sessions = [row["row"] for row in rows if row.get("table") == "session"]
        if len(sessions) != 1:
            raise AuditError("Expected one native session per transcript")
        session = sessions[0]
        role = "lead" if not session.get("parent_id") else session.get("agent")
        grouped = collections.defaultdict(list)
        for row in rows:
            if row.get("table") == "part":
                grouped[row["row"]["message_id"]].append((row["row"], parse_object(row["row"]["data"])))
        for row in rows:
            if row.get("table") != "message":
                continue
            raw, message = row["row"], parse_object(row["row"]["data"])
            if message.get("role") != "assistant":
                continue
            parts = sorted(grouped[raw["id"]], key=lambda pair: pair[0]["time_created"])
            tools = [tool_record(data.get("tool"), data.get("state", {}).get("input"),
                                 data.get("state", {}).get("output"))
                     for _, data in parts if data.get("type") == "tool"]
            finishes = [(part, data) for part, data in parts if data.get("type") == "step-finish"]
            for part, finish in finishes:
                steps.append({"role": role, "identity": None,
                              "createdMs": message.get("time", {}).get("created", raw["time_created"]),
                              "finishedMs": part["time_created"], "usage": usage_vector(finish.get("tokens"), True),
                              "nativeUsd": number(finish.get("cost")), "tools": tools,
                              "responseID": None, "sourceKey": (session["id"], raw["id"], part["id"])})
    return steps, {"adapter": "vector", "nativeFiles": len(files)}


def codex_steps(arm):
    root = arm / "runtime-home"
    roles = {}
    # This is the sole SQLite read. Never access logs, memory, configs, or user text.
    for path in root.rglob("state_*.sqlite"):
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        conn.execute("PRAGMA query_only=ON")
        try:
            for identity, role in conn.execute("SELECT id, agent_role FROM threads"):
                roles[identity] = role or "lead"
        finally:
            conn.close()
    steps, files, seen, aborted, inherited_tools = [], list(root.rglob("rollout-*.jsonl")), {}, 0, 0
    for path in files:
        identity, pending, previous_end, output_by_call = None, [], None, {}
        for row in load_lines(path):
            payload = row.get("payload", {})
            kind, subtype = row.get("type"), payload.get("type")
            timestamp = milliseconds(row.get("timestamp"))
            if kind == "session_meta":
                identity = payload.get("id", payload.get("session_id"))
            if kind == "event_msg" and subtype == "task_started":
                previous_end = milliseconds(payload.get("started_at")) or timestamp
            if kind == "event_msg" and subtype == "turn_aborted":
                aborted += 1
            if kind == "response_item" and subtype in ("custom_tool_call", "function_call"):
                inputs = payload.get("arguments", payload.get("input"))
                tool = tool_record(payload.get("name"), parse_object(inputs) or {"_code": inputs})
                tool["turnID"] = payload.get("internal_chat_message_metadata_passthrough", {}).get("turn_id")
                pending.append(tool)
                output_by_call[payload.get("call_id")] = tool
            if kind == "response_item" and subtype in ("custom_tool_call_output", "function_call_output"):
                tool = output_by_call.get(payload.get("call_id"))
                if tool:
                    updated = tool_record(tool["name"], {}, payload.get("output"), tool["action"])
                    for key in ("outputFingerprint", "outputBytes", "timedOut", "waitShape"):
                        tool[key] = updated[key]
            if kind != "token_usage_record":
                continue
            # Forked histories can contain a later inherited parent session_meta.
            # The usage record's thread_id identifies the actual response owner.
            record_identity = payload.get("thread_id") or identity
            if not record_identity or not payload.get("response_id"):
                raise AuditError("Native usage record lacks an identity")
            source_key = (record_identity, payload.get("response_id"))
            if source_key in seen:
                if seen[source_key] != fingerprint(payload):
                    raise AuditError("Conflicting duplicate native usage record")
                pending = []
                previous_end = timestamp
                continue
            seen[source_key] = fingerprint(payload)
            response_tools = [tool for tool in pending if not tool["turnID"] or tool["turnID"] == payload.get("turn_id")]
            inherited_tools += len(pending) - len(response_tools)
            steps.append({"role": roles.get(record_identity, "unknown"),
                          "identity": hashlib.sha256(record_identity.encode()).hexdigest(),
                          "createdMs": previous_end, "finishedMs": timestamp,
                          "usage": usage_vector(payload.get("usage")), "nativeUsd": None,
                          "responseID": payload.get("response_id"), "tools": response_tools,
                          "sourceKey": source_key})
            pending, previous_end = [], timestamp
    return steps, {"adapter": "codex", "nativeFiles": len(files), "nativeAbortedEvents": aborted,
                   "inheritedToolRecordsExcludedByTurn": inherited_tools,
                   "usageSource": "token_usage_record only; token_count snapshots are not additional requests"}


def reconcile(arm, all_receipts, provisional):
    audit_path = arm / "witness-audit.jsonl"
    audit = load_lines(audit_path)
    closed = any(row.get("type") == "owned_scope_closed" for row in audit)
    if not closed and not provisional:
        raise AuditError("Run lacks owned_scope_closed; use --provisional only for an explicitly provisional audit")
    bindings = [row for row in audit if row.get("type") == "arm_bound"]
    if len(bindings) != 1:
        raise AuditError("Expected one arm_bound witness record")
    binding = bindings[0]
    scope_keys = [key for key in ("actor", "label", "batchSha256") if key in binding]
    if len(scope_keys) < 3:
        raise AuditError("Receipt scope requires actor, label, and batchSha256")
    scoped = [row for row in all_receipts if all(row.get(key) == binding[key] for key in scope_keys)]
    by_type = {}
    for kind in ("before_upstream", "after_upstream", "receipt_registered"):
        records = [row for row in audit if row.get("type") == kind]
        by_type[kind] = {row["ordinal"]: row for row in records}
        if len(records) != len(by_type[kind]):
            raise AuditError("Duplicate provider ordinal in witness")
    candidates, requests = {}, {}
    for ordinal, before in by_type["before_upstream"].items():
        after, registration = by_type["after_upstream"].get(ordinal), by_type["receipt_registered"].get(ordinal)
        sha = before.get("requestSha256")
        if after and after.get("requestSha256") != sha or registration and registration.get("requestSha256") != sha:
            raise AuditError("Request hash disagreement inside witness")
        start = before["unixNs"] / 1_000_000
        end = after["unixNs"] / 1_000_000 if after else None
        requests[ordinal] = {"before": before, "after": after, "registration": registration,
                             "startMs": start, "endMs": end}
        candidates[ordinal] = []
        for index, receipt in enumerate(scoped):
            if receipt.get("requestSha256") != sha:
                continue
            if registration:
                if receipt.get("seq") == registration.get("meterReceiptSequence"):
                    candidates[ordinal].append(index)
                continue
            started = milliseconds(receipt.get("startedUtc"))
            # Only exact request bytes plus a bounded observed start can identify
            # an unregistered receipt; a sole matching SHA alone is insufficient.
            if started is not None and start - 1000 <= started and (end is None or started <= end + 1000):
                candidates[ordinal].append(index)
    links = unique_links(candidates)
    return audit, scoped, requests, links, closed


def native_links(requests, receipt_links, receipts, steps, slack):
    candidates = {}
    for index, step in enumerate(steps):
        candidates[index] = []
        if step["usage"] is None or step["createdMs"] is None or step["finishedMs"] is None:
            continue
        for ordinal, receipt_index in receipt_links.items():
            request, receipt = requests[ordinal], receipts[receipt_index]
            before, after = request["before"], request["after"]
            if after is None or before.get("role") != step["role"]:
                continue
            if step["identity"] and before.get("identitySha256") != step["identity"]:
                continue
            if usage_vector(receipt.get("usage")) != step["usage"] or usage_vector(after.get("usage")) != step["usage"]:
                continue
            if step["responseID"] and receipt.get("responseID") and step["responseID"] != receipt["responseID"]:
                continue
            # Vector step lifetimes include tool execution after the provider
            # finishes. Requiring completion proximity would discard long tools.
            if (step["createdMs"] - 1000 <= request["startMs"]
                    and request["endMs"] <= step["finishedMs"] + slack):
                candidates[index].append(ordinal)
    return unique_links(candidates), candidates


def diagnostics(steps, scoped, requests):
    tools = [tool for step in steps for tool in step["tools"]]
    reads = [tool for tool in tools if tool["category"] == "read_only"]
    waits = [tool for tool in tools if tool["category"] == "status_wait"]
    read_inputs = collections.Counter(tool["inputFingerprint"] for tool in reads)
    outputs = collections.Counter(tool["outputFingerprint"] for tool in tools if tool["outputFingerprint"])
    followups, timeout_pairs, max_streak = collections.Counter(), 0, 0
    for role in {step["role"] for step in steps}:
        ordered = sorted([step for step in steps if step["role"] == role], key=lambda step: step["finishedMs"] or 0)
        streak = 0
        for index, step in enumerate(ordered):
            timed_out = turn_category(step) == "status_wait_only" and any(tool["timedOut"] for tool in step["tools"])
            streak = streak + 1 if timed_out else 0
            max_streak = max(max_streak, streak)
            if timed_out and index + 1 < len(ordered):
                following = ordered[index + 1]
                followups[turn_category(following)] += 1
                timeout_pairs += turn_category(following) == "status_wait_only" and any(tool["timedOut"] for tool in following["tools"])
    hashes = collections.Counter(row.get("requestSha256") for row in scoped if row.get("requestSha256"))
    duplicate_items = [len(row.get("inputItemSha256", [])) - len(set(row.get("inputItemSha256", []))) for row in scoped]
    return {"interpretation": "All observed native steps, including unjoined steps. Observations and optimization hypotheses only; no automatic dollar savings or QA subtraction.",
            "exactRepeatedRequests": {"shaGroups": sum(count > 1 for count in hashes.values()),
                                      "additionalReceipts": sum(count - 1 for count in hashes.values())},
            "duplicateSerializedInputItems": {"requestsWithDuplicates": sum(count > 0 for count in duplicate_items),
                                              "additionalItems": sum(duplicate_items),
                                              "toolResultIdentityNotEstablished": True},
            "readOnlyCalls": len(reads), "repeatedExactReadInputs": sum(count - 1 for count in read_inputs.values()),
            "repeatedToolOutputs": sum(count - 1 for count in outputs.values()),
            "repeatedOutputNecessityNotEstablished": True,
            "waitCalls": len(waits), "timedOutWaitCalls": sum(tool["timedOut"] for tool in waits),
            "waitOutputShapes": [{"knownKeys": list(keys), "calls": count}
                                 for keys, count in collections.Counter(tool["waitShape"] for tool in waits).items()],
            "timedOutWaitOnlyImmediateFollowups": dict(sorted(followups.items())),
            "consecutiveTimedOutWaitOnlyPairs": timeout_pairs, "maxTimedOutWaitOnlyStreak": max_streak,
            "toolCounts": dict(sorted(collections.Counter(tool["name"] for tool in tools).items())),
            "wrapperLiteralToolHintsHeuristic": dict(sorted(collections.Counter(hint for tool in tools for hint in tool["wrapperToolHints"]).items())),
            "terminalWaitCalls": sum(tool["name"] == "terminal" and tool["action"] == "wait" for tool in tools),
            "disconnectedProviderRequests": sum(bool(request["after"] and request["after"].get("clientDisconnected")) for request in requests.values())}


def profile_arm(arm, all_receipts, provisional=False, slack=5000):
    audit, receipts, requests, receipt_links, closed = reconcile(arm, all_receipts, provisional)
    binding = next(row for row in audit if row.get("type") == "arm_bound")
    exported = arm / "private-transcripts" / "manifest.json"
    declared = load_json(exported).get("runtime") if exported.exists() else None
    runtime = binding.get("runtime") or declared or ("vector" if exported.exists() else "codex")
    if runtime not in ("vector", "codex") or declared is not None and declared != runtime:
        raise AuditError("Native runtime declarations conflict or are unknown")
    if runtime == "vector":
        steps, native_info = vector_steps(arm)
    else:
        steps, native_info = codex_steps(arm)
    links, candidates = native_links(requests, receipt_links, receipts, steps, slack)
    by_ordinal = {ordinal: steps[index] for index, ordinal in links.items()}
    by_receipt = {index: ordinal for ordinal, index in receipt_links.items()}
    charges = []
    for index, receipt in enumerate(receipts):
        ordinal = by_receipt.get(index)
        request, step = requests.get(ordinal), by_ordinal.get(ordinal)
        after = request["after"] if request else None
        charges.append({"chargeIndex": index + 1, "providerOrdinal": ordinal,
                        "role": safe_name(request["before"].get("role")) if request else "unreconciled",
                        "measuredUsd": str(number(receipt.get("measuredUsd"))) if number(receipt.get("measuredUsd")) is not None else None,
                        "responseStatus": safe_name(receipt.get("responseStatus")),
                        "clientDisconnected": bool(after and after.get("clientDisconnected")),
                        "nativeJoined": step is not None,
                        "turnCategory": turn_category(step) if step else "unmatched_charge"})
    matched_indexes = {receipt_links[ordinal] for ordinal in links.values()}
    native_costs = [step["nativeUsd"] for step in by_ordinal.values() if step["nativeUsd"] is not None]
    native_metered = [receipts[receipt_links[ordinal]] for ordinal, step in by_ordinal.items() if step["nativeUsd"] is not None]
    registration_disagreements = sum(
        number(requests[ordinal]["registration"].get("measuredUsd")) is not None
        and number(receipts[index].get("measuredUsd")) is not None
        and abs(number(requests[ordinal]["registration"].get("measuredUsd")) - number(receipts[index].get("measuredUsd"))) > Decimal("0.000000000001")
        for ordinal, index in receipt_links.items() if requests[ordinal]["registration"])
    closure = next((row for row in reversed(audit) if row.get("type") == "owned_scope_closed"), {})
    totals = money(receipts)
    closed_amount = number(closure.get("measuredUsd"))
    closure_checks = {"providerCountMatches": closure.get("providerRequests") == len(requests),
                      "allProviderTerminalsObserved": all(request["after"] is not None
                          and request["after"].get("terminalObserved") is True for request in requests.values()),
                      "allReceiptsReconciled": len(receipt_links) == len(receipts) == len(requests),
                      "measuredUsdKnown": totals["measuredUsdComplete"],
                      "closureAmountMatchesWithinOneTrillionthUsd": closed_amount is not None and totals["measuredUsdComplete"]
                      and abs(closed_amount - Decimal(totals["knownMeasuredUsd"])) <= Decimal("0.000000000001")}
    return {"kind": "receipt-cost-driver-projection-v1", "provisional": provisional or not closed or not all(closure_checks.values()),
            "closedWitnessPresent": closed, "accounting": money(receipts),
            "closureReconciliation": closure_checks,
            "coverage": {"providerRequests": len(requests), "receiptReconciledRequests": len(receipt_links),
                         "unreconciledReceiptCount": len(receipts) - len(receipt_links),
                         "unreceiptedProviderRequests": len(requests) - len(receipt_links),
                         "receiptRegistrationAmountDisagreements": registration_disagreements,
                         "nativeUsageRecords": len(steps), "uniquelyJoinedNativeRecords": len(links),
                         "ambiguousNativeRecords": sum(bool(choices) and index not in links for index, choices in candidates.items()),
                         "unmatchedNativeRecords": sum(not choices for choices in candidates.values()),
                         "matchedCharges": money([row for index, row in enumerate(receipts) if index in matched_indexes]),
                         "unmatchedChargesRetained": money([row for index, row in enumerate(receipts) if index not in matched_indexes])},
            "joinMethod": "Exact actor/label/batch receipt scope; exact request SHA plus receipt sequence or bounded start; role, exact input/output/total usage, bounded native time, and identity/response ID where available. Only mutually unique edges join.",
            "native": native_info,
            "nativeReportedPriceComparison": {"joinedRecordsWithNativePrice": len(native_costs),
                                              "nativeReportedUsdNotAuthoritative": str(sum(native_costs, Decimal(0))) if native_costs else None,
                                              "receiptAccountingForSameRecords": money(native_metered),
                                              "providerPriceCorrectnessNotInferred": True},
            "byRole": {role: money([receipt for index, receipt in enumerate(receipts) if charges[index]["role"] == role])
                       for role in sorted({charge["role"] for charge in charges})},
            "byTurnCategoryHeuristic": {category: money([receipt for index, receipt in enumerate(receipts) if charges[index]["turnCategory"] == category])
                                        for category in sorted({charge["turnCategory"] for charge in charges})},
            "diagnostics": diagnostics(steps, receipts, requests), "charges": charges,
            "safety": {"rawNativeIdsPublished": False, "machinePathsPublished": False,
                       "rawPromptsOrToolContentPublished": False, "providerCalls": 0,
                       "nativeDataWrites": 0, "allScopedChargesRetained": True,
                       "automaticSavingsClaim": False}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, action="append", required=True,
                        help="Arm directory, or pair directory containing codex/vector arms; repeatable")
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provisional", action="store_true", help="Allow an explicitly provisional snapshot of an unclosed run")
    parser.add_argument("--time-slack-ms", type=int, default=5000)
    args = parser.parse_args()
    if not 0 <= args.time_slack_ms <= 60000:
        parser.error("--time-slack-ms must be between 0 and 60000")
    receipts, seen = load_lines(args.receipts), {}
    for receipt in receipts:
        sequence = receipt.get("seq")
        if sequence is None or sequence in seen:
            raise AuditError("Receipt sequences must be present and unique; no silent deduplication")
        seen[sequence] = True
    arms = []
    for run in args.run_dir:
        if (run / "witness-audit.jsonl").exists():
            arms.append(run)
            continue
        arms.extend(run / name for name in ("codex", "vector") if (run / name / "witness-audit.jsonl").exists())
    if not arms:
        raise AuditError("No arm witness audit found")
    # Never permit the output to replace evidence, even if the caller makes a typo.
    output = args.output.resolve()
    if output == args.receipts.resolve() or any(output.is_relative_to(run.resolve()) for run in args.run_dir):
        raise AuditError("Output must be outside all input arm directories and receipt file")
    projection = {"kind": "receipt-cost-driver-profile-v1", "arms": [profile_arm(arm, receipts, args.provisional, args.time_slack_ms) for arm in arms],
                  "pairedComparisonClaim": False}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(projection, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"arms": len(arms), "provisional": any(arm["provisional"] for arm in projection["arms"]),
                      "accounting": [arm["accounting"] for arm in projection["arms"]]}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (AuditError, OSError, sqlite3.Error):
        # Underlying exception messages can include machine paths or raw evidence.
        print("Cost profile failed; validate input schemas, closure, unique sequences, and output location.", file=sys.stderr)
        sys.exit(2)
