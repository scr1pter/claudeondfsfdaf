"""Pinned native seven-identity/depth-two mechanics; synthetic loopback only."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import threading

from codex_alias_probe import OwnedFreshCodexRegistry, multi_call_events
from codex_free_probe import DUMMY, MAX_BODY, MODEL, PIN, command, environment, named_tool, native_state, save, tools_projection
from funding_profiles import HEAVY_PHASE, HEAVY_PLAN_SHA256, funding_policy
from native_registry import NativeRegistry
from native_team_policy import PolicyError
from owned_team_witness import OwnedSupervisor, WitnessServer, digest
from role_graph import HEAVY_ROLE_PARENTS, HEAVY_ROLES


class FreshHeavyRegistry(OwnedFreshCodexRegistry):
    def __init__(self, home, out):
        NativeRegistry.__init__(self, "codex", home, home / "state_5.sqlite", None, "free_probe", max_depth=2)
        self.out, self.observations = out, []

    def resolve(self, headers):
        self.observations.append({"headers": {key: value for key, value in headers.items() if key.lower() in ("thread-id", "session-id", "x-codex-turn-metadata")}, "native": native_state(self.home)})
        save(self.out / "private-raw" / "native-before-admission.json", self.observations)
        return super().resolve(headers)


class FakeLedger(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, out, registry):
        self.out, self.home, self.registry = out, registry.home, registry
        self.lock, self.rows, self.receipts = threading.RLock(), [], []
        self.stages, self.finished = {}, set()
        self.funded_token, self.open, self.remaining = DUMMY, False, 0
        super().__init__(("127.0.0.1", 0), Handler)

    def controller(self, route, value=None):
        with self.lock:
            if route == "/control":
                if self.open or value["actor"] != "foundry-codex" or not 0 < value["calls"] <= 300:
                    raise PolicyError("invalid synthetic scope")
                self.label, self.remaining, self.open = value["label"], value["calls"], True
                return {"requestToken": self.funded_token}
            if route == "/disarm":
                if value["requestToken"] != self.funded_token:
                    raise PolicyError("wrong synthetic owned token")
                self.remaining, self.open = 0, False
            cost = len(self.receipts) * 0.000012
            return {"limitUsd": 48, "phaseID": HEAVY_PHASE, "phasePlanSha256": HEAVY_PLAN_SHA256, "halted": None,
                    "measuredUsd": 20.3038291 + cost, "reservedUsd": 0, "active": 0, "attempts": 889 + len(self.receipts),
                    "batchCallsRemaining": self.remaining if self.open else 0,
                    "actors": {"foundry-vector": {"limitUsd": funding_policy(HEAVY_PHASE).actor_cap("foundry-vector"), "measuredUsd": 10.8884618, "reservedUsd": 0},
                               "foundry-codex": {"limitUsd": funding_policy(HEAVY_PHASE).actor_cap("foundry-codex"), "measuredUsd": 6.4715992 + cost, "reservedUsd": 0},
                               "synthetic-sealed-history": {"limitUsd": 2.9437681, "measuredUsd": 2.9437681, "reservedUsd": 0}}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        server = self.server
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + server.funded_token or not server.open:
            self.send_error(403); return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_BODY:
            self.send_error(400); return
        raw = self.rfile.read(length)
        body = json.loads(raw)
        with server.lock:
            index = len(server.rows) + 1
            if index > 48:
                self.send_error(429); return
            native = server.registry.resolve(self.headers)
            role = native["role"]
            inputs = [value for value in body.get("input", []) if isinstance(value, dict)]
            tools = body.get("tools", []) + [tool for value in inputs if value.get("type") == "additional_tools" for tool in value.get("tools", [])]
            row = {"index": index, "wireIdentity": native["id"], "model": body.get("model"), "reasoning": body.get("reasoning"), "textVerbosity": body.get("text", {}).get("verbosity"), "maxOutputTokens": body.get("max_output_tokens"), "nativeJoin": native, "tools": tools_projection(tools)}
            server.rows.append(row)
            server.receipts.append({"seq": 889 + index, "actor": "foundry-codex", "label": server.label, "batchSha256": digest(server.funded_token), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": 0.000012})
            server.remaining -= 1
            save(server.out / "private-raw" / ("request-" + str(index).zfill(3) + ".json"), body)
            stage = server.stages.get(role, 0)
            calls, selected, wanted = [], [], None
            if role == "lead":
                if stage == 0:
                    wanted, selected = "spawn_agent", ["backend_coordinator", "frontend_worker", "qa_specialist"]
                    server.stages[role] = 1
                elif stage == 1 and not set(HEAVY_ROLES[:-1]) <= server.finished:
                    wanted = "wait_agent"
                elif stage == 1:
                    wanted, selected = "spawn_agent", ["team_judge"]
                    server.stages[role] = 2
                elif stage == 2 and "team_judge" not in server.finished:
                    wanted = "wait_agent"
            elif role == "backend_coordinator":
                if stage == 0:
                    wanted, selected = "spawn_agent", ["backend_api", "backend_data"]
                    server.stages[role] = 1
                elif not {"backend_api", "backend_data"} <= server.finished:
                    wanted = "wait_agent"
            if wanted:
                found = named_tool(tools, wanted)
                if found is None:
                    raise PolicyError("scripted native collaboration tool missing for " + role)
                tool, namespace = found
                for child in selected or [None]:
                    arguments = {"task_name": child, "message": "Harmless fixed native protocol probe. Reply only probe-child-complete. Do not use shell, files, browser, apps or external services. Only backend_coordinator may create the two fixed backend children when scripted.", "agent_type": child, "fork_turns": "none"} if child else {"timeout_ms": 10000}
                    call = {"name": tool["name"], "arguments": json.dumps(arguments)}
                    if namespace:
                        call["namespace"] = namespace
                    calls.append(call)
                row["scriptedRoles"] = selected
            else:
                server.finished.add(role)
            save(server.out / "capture.json", server.rows)
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Connection", "close"); self.end_headers()
        for sequence, event in enumerate(multi_call_events(index, calls)):
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush(); self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-bin", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.codex_bin, args.out = args.codex_bin.resolve(), args.out.resolve()
    if args.out.exists() or args.out.is_relative_to(Path(__file__).resolve().parents[3]) or hashlib.sha256(args.codex_bin.read_bytes()).hexdigest() != PIN:
        raise SystemExit("fresh private output and exact pinned native Codex binary required")
    args.out.mkdir(parents=True)
    home, app = args.out / "runtime-home", args.out / "empty-workspace"
    home.mkdir(); app.mkdir()
    env = environment(home, args.codex_bin)
    registry = FreshHeavyRegistry(home / "codex", args.out)
    server = FakeLedger(args.out, registry)
    holder = {}
    supervisor = OwnedSupervisor(server.controller, lambda: list(server.receipts), args.out / "owned-scope", quiesced=lambda: holder.get("process") is not None and holder["process"].poll() is not None, funding_profile=HEAVY_PHASE)
    arm = supervisor.begin("codex", "synthetic-free-heavy-codex", registry, HEAVY_ROLES, role_parents=HEAVY_ROLE_PARENTS, soft_usd=13.84808545)
    witness = WitnessServer(("127.0.0.1", 0), server.server_address, arm)
    binding = witness.cli_binding()
    env["BENCH_API_KEY"] = binding["requestToken"]
    role_files = {}
    for role in HEAVY_ROLES:
        path = home / "codex" / (role + ".toml")
        path.write_text('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "auto"\nmodel_verbosity = "low"\nmodel_context_window = 1050000\nmodel_provider = "free_probe"\n[features]\nmulti_agent = false\n', encoding="utf-8")
        role_files[role] = path
    base = command(args.codex_bin, binding["providerBase"], "multi_agent", 6, role_files[HEAVY_ROLES[0]])
    filtered, index = [], 0
    while index < len(base) - 1:
        if base[index] == "-c" and base[index + 1].startswith("agents.study_worker."):
            index += 2; continue
        filtered.append(base[index]); index += 1
    for role, path in role_files.items():
        filtered.extend(["-c", "agents." + role + '.description="Harmless fixed protocol probe role"', "-c", "agents." + role + ".config_file=" + json.dumps(str(path))])
    filtered.append(base[-1])
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    witness_thread = threading.Thread(target=witness.serve_forever, daemon=True); witness_thread.start()
    try:
        with (args.out / "cli.stdout.jsonl").open("w", encoding="utf-8") as stdout, (args.out / "cli.stderr.log").open("w", encoding="utf-8") as stderr:
            process = subprocess.Popen(filtered, env=env, cwd=app, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
            holder["process"] = process
            try:
                process.wait(timeout=120); timed_out = False
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10); timed_out = True
        closure = supervisor.close(timeout=5)
    finally:
        witness.shutdown(); witness.server_close(); witness_thread.join(5)
        server.shutdown(); server.server_close(); thread.join(5)
    rows = server.rows
    save(args.out / "summary.json", {"kind": "free-codex-heavy-aliased-native-proof-v1", "binarySha256": PIN, "roleParents": HEAVY_ROLE_PARENTS, "model": MODEL, "reasoning": "high", "contextLimitConfiguredEveryRole": 1050000, "realProviderCalls": 0, "fundedMeterCalls": 0, "BunRuns": 0, "exitCode": process.returncode, "timedOut": timed_out, "requests": len(rows), "distinctNativeInferenceIdentities": len({row["wireIdentity"] for row in rows}), "allSolHighAutoLow": all(row["model"] == MODEL and row["reasoning"].get("effort") == "high" and row["reasoning"].get("summary") == "auto" and row["textVerbosity"] == "low" for row in rows), "allOutputCeilings32000": all(row["maxOutputTokens"] == 32000 for row in rows), "maximumNativeDepth": max((row["nativeJoin"]["depth"] for row in rows), default=0), "observedRoleCalls": {role: sum(row["nativeJoin"]["role"] == role for row in rows) for role in ("lead", *HEAVY_ROLES)}, "leafCollaborationDefinitions": sum(len(tool.get("tools", [])) for row in rows if row["nativeJoin"]["role"] not in ("lead", "backend_coordinator") for tool in row["tools"] if tool.get("name") == "collaboration"), "closure": closure})
    print(json.dumps({"out": str(args.out), "exitCode": process.returncode, "timedOut": timed_out, "requests": len(rows), "scopeReviewRequired": closure["reviewRequired"]}))


if __name__ == "__main__":
    main()
