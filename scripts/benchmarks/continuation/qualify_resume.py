"""Explicit free-only partial failed-tree/native endpoint adoption proof.

Only an ephemeral Python fake upstream and the pinned Codex CLI are started.
The actual native_command and code-mode definitions remain intact. No Bun,
Chrome, app, controller capability, receipt ledger, or real provider is used.
"""
import argparse
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import math
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
from types import SimpleNamespace

import codex_arm
import codex_resume

require = codex_resume.require
MESSAGE = "Labelled free native resume fixture only. Do not edit files, use shell/web/apps/browser, or access external services. Follow only the scripted fixed native collaboration calls."


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class FreeMeter(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, out, modules):
        self.out, self.heavy, self.team, self.witness, self.native, self.common = out, *modules
        self.rows, self.receipts, self.stages = [], [], {}
        self.phase, self.remaining, self.token, self.label = 1, 0, None, None
        self.lock = threading.RLock()
        self.registry = None
        self.protocol = importlib.import_module("native_pair_smoke")
        self.tools = importlib.import_module("codex_free_probe")
        super().__init__(("127.0.0.1", 0), Handler)
        require(self.server_port not in (23128, 23129, 23130), "funded port forbidden in free proof")

    def controller(self, route, value=None):
        with self.lock:
            if route == "/control":
                require(self.remaining == 0 and value["actor"] == "foundry-codex" and 0 < value["calls"] <= 300,
                        "invalid free fixture scope")
                self.token, self.label, self.remaining = "dummy-free-only-" + secrets.token_hex(20), value["label"], value["calls"]
                return {"requestToken": self.token}
            require(route in ("/status", "/disarm"), "unknown free-only control")
            if route == "/disarm":
                require(value == {"requestToken": self.token}, "wrong free-only token")
                self.remaining = 0
            cost = math.fsum(row["measuredUsd"] for row in self.receipts)
            return {"limitUsd": 48, "phaseID": self.heavy.FUNDING.phase, "phasePlanSha256": self.heavy.FUNDING.plan_sha256,
                "halted": None, "attempts": 889 + len(self.receipts), "measuredUsd": 20.3038291 + cost,
                "active": 0, "reservedUsd": 0, "batchCallsRemaining": self.remaining,
                "actors": {"foundry-vector": {"limitUsd": 24.73654725, "measuredUsd": 10.8884618, "reservedUsd": 0},
                           "foundry-codex": {"limitUsd": 20.31968465, "measuredUsd": 6.4715992 + cost, "reservedUsd": 0},
                           "synthetic-sealed-history": {"limitUsd": 2.9437681, "measuredUsd": 2.9437681, "reservedUsd": 0}}}

    def metadata(self):
        with closing(self.registry.connect()) as connection:
            return [dict(row) for row in connection.execute("SELECT id,agent_role,rollout_path FROM threads")]

    def complete(self, roles):
        rows = {row["agent_role"] or "lead": row["id"] for row in self.metadata()}
        path = self.registry.home / "codex/thread_history_1.sqlite"
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
            return all(role in rows and (connection.execute("SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
                       (rows[role],)).fetchone() or [None])[0] == "completed" for role in roles)

    def script(self, native, tools):
        role = native["role"]
        key = (self.phase, role)
        stage = self.stages.get(key, 0)
        def call(name, args):
            found = self.tools.named_tool(tools, name)
            require(found is not None, "required native collaboration tool absent: " + name)
            result = {"name": found[0]["name"], "arguments": json.dumps(args)}
            if found[1]:
                result["namespace"] = found[1]
            return result
        def spawn(roles):
            return [call("spawn_agent", {"task_name": selected, "agent_type": selected, "fork_turns": "none", "message": MESSAGE}) for selected in roles]
        def follow(roles):
            return [call("followup_task", {"target": "/root/" + selected, "message": MESSAGE}) for selected in roles]
        def wait():
            return [call("wait_agent", {"timeout_ms": 10000})]
        if self.phase == 1:
            if role != "lead":
                self.stages[key] = stage + 1
                return None if stage else []
            if stage == 0:
                self.stages[key] = 1
                return spawn(("backend_coordinator", "frontend_worker"))
            if stage == 1 and self.complete(("backend_coordinator", "frontend_worker")):
                self.stages[key] = 2
                return follow(("backend_coordinator", "frontend_worker"))
            return wait()
        if role == "backend_coordinator":
            if stage == 0:
                self.stages[key] = 1
                return spawn(("backend_api", "backend_data"))
            return [] if self.complete(("backend_api", "backend_data")) else wait()
        if role != "lead":
            return []
        if stage == 0:
            self.stages[key] = 1
            return follow(("backend_coordinator", "frontend_worker"))
        if stage == 1:
            if not self.complete(("backend_coordinator", "backend_api", "backend_data", "frontend_worker")):
                return wait()
            self.stages[key] = 2
            return spawn(("qa_specialist",))
        if stage == 2:
            if not self.complete(("qa_specialist",)):
                return wait()
            self.stages[key] = 3
            return spawn(("team_judge",))
        return [] if self.complete(("team_judge",)) else wait()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        meter = self.server
        require(self.path == "/v1/responses" and self.headers.get("Authorization") == "Bearer " + str(meter.token),
                "free fake upstream authentication failed")
        length = int(self.headers.get("Content-Length", "0"))
        require(0 < length <= 8_000_000, "free request bound")
        raw = self.rfile.read(length)
        body = json.loads(raw)
        with meter.lock:
            require(meter.remaining > 0 and len(meter.rows) < 100, "free request allowance exhausted")
            native = meter.registry.resolve(dict(self.headers))
            tools = body.get("tools", []) + [tool for item in body.get("input", [])
                if isinstance(item, dict) and item.get("type") == "additional_tools" for tool in item.get("tools", [])]
            calls = meter.script(native, tools)
            index = len(meter.rows) + 1
            exec_tool = meter.tools.named_tool(tools, "exec")
            meter.rows.append({"phase": meter.phase, "role": native["role"], "identitySha256": codex_resume.digest_id(native["id"]),
                "depth": native["depth"], "model": body.get("model"), "reasoning": body.get("reasoning"),
                "verbosity": body.get("text", {}).get("verbosity"), "outputCeiling": body.get("max_output_tokens"),
                "codeModeOffered": bool(exec_tool and exec_tool[0].get("type") == "custom"), "scriptedFailure": calls is None})
            meter.receipts.append({"seq": 889 + index, "actor": "foundry-codex", "label": meter.label,
                "batchSha256": meter.witness.digest(meter.token), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": .000012})
            meter.remaining -= 1
            save(meter.out / "private-raw" / (str(index).zfill(3) + ".json"), body)
            save(meter.out / "sanitized-requests.json", meter.rows)
            events = meter.protocol.multi_events(index, calls or [])
            if calls is None:
                failed = {**events[-1]["response"], "status": "failed", "output": [],
                    "error": {"code": "server_error", "message": "Labelled initial failed fixture; known synthetic usage retained."}}
                events = [events[0], {"type": "response.failed", "response": failed}]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for sequence, event in enumerate(events):
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()
        self.close_connection = True


def latest_outcomes(home, rows):
    with closing(sqlite3.connect((home / "codex/thread_history_1.sqlite").as_uri() + "?mode=ro", uri=True)) as connection:
        return {row["agent_role"] or "lead": (connection.execute("SELECT status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
                (row["id"],)).fetchone() or [None])[0] for row in rows}


def run_phase(meter, out, home, app, env, runtime, registry, phase, identities=None):
    directory = out / ("phase" + str(phase))
    meter.phase, meter.registry = phase, registry
    quiesced = {"value": False}
    supervisor = meter.witness.OwnedSupervisor(meter.controller, lambda: list(meter.receipts), directory,
        funding_profile=meter.heavy.FUNDING.phase, quiesced=lambda: quiesced["value"])
    arm = supervisor.begin("codex", "synthetic-native-resume-phase" + str(phase), registry, codex_resume.ROLES,
        role_parents=meter.heavy.HEAVY_ROLE_PARENTS, max_calls=300-len(meter.receipts), seconds=90,
        soft_usd=codex_resume.SOFT_USD)
    if identities:
        arm.admitted_ids.update(identities.values())
        arm.slots.update({role: identity for role, identity in identities.items() if role != "lead"})
        arm.record({"type": "labelled_fixture_lifetime_slots_adopted", "initialFailedPhaseRetained": True,
                    "identitySha256ByRole": {role: codex_resume.digest_id(identity) for role, identity in identities.items()}})
    else:
        registry.on_bind = arm.record
    witness = meter.witness.WitnessServer(("127.0.0.1", 0), meter.server_address, arm)
    thread = threading.Thread(target=witness.serve_forever, daemon=True)
    thread.start()
    binding = witness.cli_binding()
    require(witness.server_port not in (23128, 23129, 23130) and binding["requestToken"] != meter.token, "alias/funded port boundary")
    configured = meter.team.team_environment(meter.common, "codex", env, home, binding, profile=meter.heavy.PROFILE)
    command = meter.team.native_command(meter.common, "codex", runtime, app, home, binding, MESSAGE,
                None if identities is None else identities["lead"], 300-len(meter.receipts), profile=meter.heavy.PROFILE)
    try:
        process = meter.team.execute_owned(meter.common, command, app, configured, directory / "codex/agent", 90,
            monitor=lambda: arm.failure if phase == 2 else None)
        quiesced["value"] = process.get("ownedTreeQuiesced") is True
        closure = supervisor.close(timeout=10)
        save(directory / "process.json", process)
        save(directory / "closure-sanitized.json", closure)
        return {"process": process, "closure": closure, "arm": arm, "port": witness.server_port,
                "aliasSha256": codex_resume.digest_id(binding["requestToken"])}
    finally:
        witness.shutdown()
        witness.server_close()
        thread.join(timeout=10)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("original-plan", "witness-root", "out"):
        result.add_argument("--" + name, type=Path, required=True)
    result.add_argument("--expected-witness-revision", required=True)
    result.add_argument("--expected-witness-manifest-sha", required=True)
    result.add_argument("--run-free", action="store_true")
    return result


def main(argv=None):
    options = parser().parse_args(argv)
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    require(options.run_free, "native fake proof requires explicit --run-free")
    original = json.loads(options.original_plan.read_text(encoding="utf-8"))
    require(codex_resume.digest(original) == codex_arm.ORIGINAL_PLAN_SHA, "original task/binary plan changed")
    heavy, team, witness, native, common, files = codex_resume.load_instrument(options, original)
    runtime = codex_arm.runtime_options(options, original, heavy)
    require(heavy.build_plan(runtime, common) == {**original, "teamInstrumentFiles": files}, "free native command freeze changed")
    team.checked_path(options.out, [options.witness_root, options.original_plan.parent, Path(__file__).resolve().parents[3],
        runtime.vector_root, runtime.task_dir, runtime.common_runner_root, runtime.browser_driver_root])
    options.out.mkdir(parents=True, exist_ok=False)
    owned = options.out / "native-owned"
    home, app, support = (owned / name for name in ("runtime-home", "app", "support-data"))
    app.mkdir(parents=True)
    support.mkdir()
    (app / "BUILD_SPEC.md").write_text(MESSAGE + "\n", encoding="utf-8")
    env = common.isolated_environment(home, app, runtime.bun, runtime.node)
    env["NODE_EXE"] = str(runtime.node)
    for role in codex_resume.ROLES:
        (home / "codex" / (role + ".toml")).write_text('\n'.join(['model="gpt-6.1-sol"', 'model_provider="benchmark"',
            'model_reasoning_effort="high"', 'model_reasoning_summary="auto"', 'model_verbosity="low"',
            'model_context_window=1050000', 'developer_instructions=' + json.dumps(heavy.PROFILE["instructions"][role])]) + '\n', encoding="utf-8")
    meter = FreeMeter(options.out, (heavy, team, witness, native, common))
    thread = threading.Thread(target=meter.serve_forever, daemon=True)
    thread.start()
    try:
        registry = team.FreshOwnedRegistry("codex", home, max_depth=2)
        first = run_phase(meter, options.out, home, app, env, runtime, registry, 1)
        rows = meter.metadata()
        identities = {row["agent_role"] or "lead": row["id"] for row in rows}
        before = latest_outcomes(home, rows)
        require(set(identities) == {"lead", "backend_coordinator", "frontend_worker"}
                and before == {role: "failed" for role in identities}
                and first["closure"].get("settlementComplete") is True and first["closure"].get("runtimeQuiesced") is True
                and first["closure"].get("reviewRequired") is True and len(first["arm"].admitted_ids) == 3,
                "initial labelled fixture did not leave the exact known failed partial tree")
        prior = {name: codex_resume.exact_tree(owned / name) for name in ("runtime-home", "app", "support-data")}
        archive = codex_resume.archive_state(owned, options.out, prior)
        registry = native.NativeRegistry("codex", home, home / "codex/state_5.sqlite", identities["lead"], "benchmark", max_depth=2)
        verified_ids, _ = codex_resume.native_state(home, registry, {role: codex_resume.digest_id(identity) for role, identity in identities.items()})
        require(verified_ids == identities, "fixture archive/native adoption identity mismatch")
        second = run_phase(meter, options.out, home, app, env, runtime, registry, 2, identities)
        after_rows = meter.metadata()
        after = {row["agent_role"] or "lead": row["id"] for row in after_rows}
        outcomes = latest_outcomes(home, after_rows)
        phases = [{"phase": name, "forwardedCalls": scope["closure"].get("providerRequests"),
                   "knownReceiptCount": sum(request["receiptRegistered"] for request in scope["arm"].requests),
                   "measuredUsd": scope["closure"].get("measuredUsd"), "latestOutcome": outcome,
                   "reviewRequired": scope["closure"].get("reviewRequired")}
                  for name, scope, outcome in (("initial_failed_fixture", first, "failed"), ("new_binding_resume", second, "completed"))]
        flags = {"qualificationPassed": False, "oldWitnessClosed": True,
            "newWitnessEndpoint": first["port"] != second["port"], "newAliasObserved": first["aliasSha256"] != second["aliasSha256"],
            "rootIdentityPreserved": after.get("lead") == identities["lead"],
            "existingChildIdentitiesPreserved": all(after.get(role) == identity for role, identity in identities.items()),
            "noReplacementChildren": len(after_rows) == len(after) == 7,
            "codeModePreserved": all(row["codeModeOffered"] for row in meter.rows),
            "allSolHighAutoLow": all(row["model"] == "gpt-6.1-sol" and row["reasoning"].get("effort") == "high"
                and row["reasoning"].get("summary") == "auto" and row["verbosity"] == "low" and row["outputCeiling"] == 32000 for row in meter.rows),
            "aliasOnly": True, "receiptJoinComplete": all(row["knownReceiptCount"] == row["forwardedCalls"] for row in phases),
            "archiveBeforeAdoptionVerified": archive["archiveBeforeAdoptionVerified"],
            "initialFailureRetainedSeparately": first["closure"].get("reviewRequired") is True,
            "historicalReviewRequired": True}
        flags["qualificationPassed"] = (all(value for key, value in flags.items() if key != "qualificationPassed")
            and second["process"].get("exitCode") == 0 and second["closure"].get("settlementComplete") is True
            and second["closure"].get("runtimeQuiesced") is True and second["closure"].get("reviewRequired") is False
            and set(after) == {"lead", *codex_resume.ROLES} and all(value == "completed" for value in outcomes.values()))
        save(options.out / "sanitized-native-state.json", {"beforeLatestOutcomes": before, "afterLatestOutcomes": outcomes,
            "identitySha256ByRoleBefore": {role: codex_resume.digest_id(identity) for role, identity in identities.items()},
            "identitySha256ByRoleAfter": {role: codex_resume.digest_id(identity) for role, identity in after.items()},
            "originalFailedPhaseReviewRequired": True, "qualityOrEfficiencyClaim": False})
        evidence_names = ["sanitized-requests.json", "sanitized-native-state.json", "phase1/process.json", "phase1/closure-sanitized.json",
                          "phase1/codex/witness-audit.jsonl", "phase2/process.json", "phase2/closure-sanitized.json", "phase2/codex/witness-audit.jsonl"]
        artifact = {"kind": "heavy-codex-partial-resume-qualification-v1", **flags,
            "binarySha256": original["binarySha256"]["codex_bin"], "witnessInstrumentSha256": codex_resume.digest(files),
            "realProviderCalls": 0, "fundedMeterCalls": 0, "BunRuns": 0, "ChromeRuns": 0,
            "beforeRoles": ["lead", "backend_coordinator", "frontend_worker"], "beforeLatestOutcomes": before,
            "afterRoles": ["lead", *codex_resume.ROLES], "maximumNativeDepth": max(row["depth"] for row in meter.rows),
            "phases": phases, "cumulativeCalls": len(meter.receipts), "formalRepairCount": first["arm"].repairs + second["arm"].repairs,
            "evidenceFiles": {name: codex_resume.file_hash(options.out / name) for name in evidence_names}}
        save(options.out / "qualification.json", artifact)
        if flags["qualificationPassed"]:
            codex_resume.qualification(options.out / "qualification.json", artifact["binarySha256"], artifact["witnessInstrumentSha256"])
        print(json.dumps({"qualificationPassed": flags["qualificationPassed"], "realProviderCalls": 0, "fundedMeterCalls": 0,
                          "BunRuns": 0, "ChromeRuns": 0, "phases": phases, "cumulativeCalls": len(meter.receipts)}, indent=2))
        return 0 if flags["qualificationPassed"] else 2
    finally:
        meter.shutdown()
        meter.server_close()
        thread.join(timeout=10)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"errorType": type(error).__name__, "reason": str(error), "realProviderCalls": 0,
                          "fundedMeterCalls": 0, "automaticRetry": False}), file=sys.stderr)
        raise SystemExit(2)
