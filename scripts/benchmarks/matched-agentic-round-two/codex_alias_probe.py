"""Full fixed-role native Codex alias proof; fake upstream only, no Bun."""
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import argparse
import subprocess
import threading

from codex_free_probe import DUMMY, MAX_BODY, MODEL, PIN, command, environment, named_tool, native_state, response_events, save, tools_projection
from native_registry import NativeRegistry
from native_team_policy import PolicyError
from owned_team_witness import OwnedSupervisor, WitnessServer, digest
from vector_free_probe import Capture as VectorFakeLedger

ROLES = ("study-implementation", "study-verification", "study-judge")


class OwnedFreshCodexRegistry(NativeRegistry):
    def __init__(self, home):
        super().__init__("codex", home, home / "state_5.sqlite", None, "free_probe")

    def resolve(self, headers):
        if self.root_id is None:
            with closing(self.connect()) as connection:
                roots = connection.execute("SELECT id FROM threads WHERE source='exec' AND thread_source='user' AND agent_role IS NULL LIMIT 2").fetchall()
            if len(roots) != 1 or roots[0]["id"] != headers.get("thread-id"):
                raise PolicyError("fresh owned native Codex root not unique")
            self.root_id = roots[0]["id"]
        return super().resolve(headers)


def multi_call_events(index, calls):
    if not calls:
        return response_events(index)
    events, items, first, last = [], [], None, None
    for offset, call in enumerate(calls):
        current = response_events(index * 10 + offset, call)
        first = first or current[0]
        for event in current[1:-1]:
            event["output_index"] = offset
            events.append(event)
        items.append(current[-1]["response"]["output"][0])
        last = current[-1]
    last["response"]["id"] = first["response"]["id"]
    last["response"]["output"] = items
    return [first, *events, last]


class FakeLedger(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, out, registry):
        self.out, self.home, self.registry = out, registry.home, registry
        self.lock, self.rows, self.receipts, self.stage = threading.Lock(), [], [], 0
        self.funded_token, self.open, self.remaining = DUMMY, False, 0
        super().__init__(("127.0.0.1", 0), Handler)

    def controller(self, route, value=None):
        result = VectorFakeLedger.controller(self, route, value)
        if route != "/control":
            cost = len(self.receipts) * 0.000012
            result["actors"]["foundry-vector"]["measuredUsd"] = 10.9
            result["actors"]["foundry-codex"]["measuredUsd"] = 5.9 + cost
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        server = self.server
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + server.funded_token:
            self.send_error(403); return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_BODY:
            self.send_error(400); return
        raw = self.rfile.read(length)
        body = json.loads(raw)
        with server.lock:
            index = len(server.rows) + 1
            if index > 32:
                self.send_error(429); return
            identity = self.headers.get("thread-id")
            native = server.registry.resolve(self.headers)
            inputs = [value for value in body.get("input", []) if isinstance(value, dict)]
            tools = body.get("tools", []) + [tool for value in inputs if value.get("type") == "additional_tools" for tool in value.get("tools", [])]
            row = {"index": index, "wireIdentity": identity, "model": body.get("model"), "reasoning": body.get("reasoning"), "textVerbosity": body.get("text", {}).get("verbosity"), "maxOutputTokens": body.get("max_output_tokens"), "cacheKeyMatchesRoot": body.get("prompt_cache_key") == server.registry.root_id, "sessionHeaderMatchesRoot": self.headers.get("session-id") == server.registry.root_id, "nativeJoin": native, "nativeBeforeResponse": native_state(server.home), "tools": tools_projection(tools)}
            server.rows.append(row)
            server.receipts.append({"seq": 600 + index, "actor": "foundry-codex", "label": server.label, "batchSha256": digest(server.funded_token), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": 0.000012})
            server.remaining -= 1
            save(server.out / "private-raw" / ("request-" + str(index).zfill(3) + ".json"), body)
            calls = []
            if identity == server.registry.root_id:
                stage = server.stage
                server.stage += 1
                wanted = "spawn_agent" if stage in (0, 2) else "wait_agent" if stage in (1, 3) else None
                if wanted:
                    found = named_tool(tools, wanted)
                    if found is None:
                        raise PolicyError("scripted native collaboration tool missing")
                    tool, namespace = found
                    selected = ROLES[:2] if stage == 0 else ROLES[2:] if stage == 2 else (None,)
                    for role in selected:
                        arguments = {"task_name": role.removeprefix("study-"), "message": "Harmless protocol probe. Reply only probe-child-complete. Do not use tools, shell, files, browser, apps, external services or further agents.", "agent_type": role, "fork_turns": "none"} if role else {"timeout_ms": 10000}
                        call = {"name": tool["name"], "arguments": json.dumps(arguments)}
                        if namespace:
                            call["namespace"] = namespace
                        calls.append(call)
                    row["scriptedRoles"] = list(selected) if wanted == "spawn_agent" else []
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
    registry = OwnedFreshCodexRegistry(home / "codex")
    server = FakeLedger(args.out, registry)
    holder = {}
    supervisor = OwnedSupervisor(server.controller, lambda: list(server.receipts), args.out / "owned-scope", quiesced=lambda: holder.get("process") is not None and holder["process"].poll() is not None)
    arm = supervisor.begin("codex", "synthetic-free-codex-team", registry, ROLES)
    witness = WitnessServer(("127.0.0.1", 0), server.server_address, arm)
    binding = witness.cli_binding()
    env["BENCH_API_KEY"] = binding["requestToken"]
    role_files = {}
    for role in ROLES:
        path = home / "codex" / (role + ".toml")
        path.write_text('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nmodel_reasoning_summary = "auto"\nmodel_verbosity = "low"\nmodel_context_window = 1050000\nmodel_provider = "free_probe"\n[features]\nmulti_agent = false\n', encoding="utf-8")
        role_files[role] = path
    base = command(args.codex_bin, binding["providerBase"], "multi_agent", 3, role_files[ROLES[0]])
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
                process.wait(timeout=90); timed_out = False
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10); timed_out = True
        closure = supervisor.close(timeout=5)
    finally:
        witness.shutdown(); witness.server_close(); witness_thread.join(5)
        server.shutdown(); server.server_close(); thread.join(5)
    rows = server.rows
    save(args.out / "summary.json", {"kind": "free-codex-aliased-fixed-team-proof-v1", "binarySha256": PIN, "roles": list(ROLES), "contextLimitConfiguredForEveryRole": 1050000, "model": MODEL, "reasoning": "high", "realProviderCalls": 0, "fundedMeterCalls": 0, "BunRuns": 0, "exitCode": process.returncode, "timedOut": timed_out, "requests": len(rows), "distinctNativeInferenceIdentities": len({row["wireIdentity"] for row in rows}), "allSolHighAutoLow": all(row["model"] == MODEL and row["reasoning"].get("effort") == "high" and row["reasoning"].get("summary") == "auto" and row["textVerbosity"] == "low" for row in rows), "allOutputCeilings32000": all(row["maxOutputTokens"] == 32000 for row in rows), "childCollaborationDefinitions": sum(len(tool.get("tools", [])) for row in rows if row["nativeJoin"]["role"] != "lead" for tool in row["tools"] if tool.get("name") == "collaboration"), "observedRoleCalls": {role: sum(row["nativeJoin"]["role"] == role for row in rows) for role in ("lead", *ROLES)}, "closure": closure})
    print(json.dumps({"out": str(args.out), "exitCode": process.returncode, "timedOut": timed_out, "requests": len(rows), "scopeReviewRequired": closure["reviewRequired"]}))


if __name__ == "__main__":
    main()
