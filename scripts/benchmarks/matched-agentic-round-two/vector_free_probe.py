"""Harmless frozen-Vector wire capture. No provider upstream or funding code."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys
import threading
import time

from codex_free_probe import DUMMY, MAX_BODY, MODEL, response_events, save, tools_projection
from native_registry import NativeRegistry
from native_team_policy import PolicyError
from owned_team_witness import FUNDING_PHASE, OwnedSupervisor, WitnessServer, digest

ROLES = ("study-implementation", "study-verification", "study-judge")
SOURCE = "a35c03d6a9bb16f16ec0187ad69c6c6420d10f19"


class Capture(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, out, home, mode):
        self.out, self.home, self.mode = out, home, mode
        self.lock, self.rows, self.root, self.stage = threading.Lock(), [], None, 0
        self.funded_token, self.receipts, self.open, self.remaining = DUMMY, [], False, 0
        super().__init__(("127.0.0.1", 0), Handler)

    def controller(self, route, value=None):
        with self.lock:
            if route == "/control":
                self.funded_token, self.open, self.remaining = "fake-vector-funded-" + secrets.token_hex(24), True, value["calls"]
                self.label = value["label"]
                return {"requestToken": self.funded_token}
            if route == "/disarm":
                if value["requestToken"] != self.funded_token:
                    raise ValueError("wrong fake owned scope")
                self.open, self.remaining = False, 0
            cost = len(self.receipts) * 0.000012
            return {"limitUsd": 48, "phaseID": FUNDING_PHASE, "halted": None, "measuredUsd": 19.8 + cost, "reservedUsd": 0, "active": 0, "attempts": 600 + len(self.receipts), "batchCallsRemaining": self.remaining if self.open else 0, "actors": {"foundry-vector": {"limitUsd": 20, "measuredUsd": 10.9 + cost, "reservedUsd": 0}, "foundry-codex": {"limitUsd": 20, "measuredUsd": 5.9, "reservedUsd": 0}}}


class OwnedFreshVectorRegistry(NativeRegistry):
    """Free-probe bootstrap from one native root in this newly created home."""
    def __init__(self, home):
        super().__init__("vector", home, home / "not-created.db", None, "openai")

    def resolve(self, headers):
        if self.root_id is None:
            candidates = []
            for path in self.home.rglob("vector*.db"):
                connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
                try:
                    roots = connection.execute("SELECT id FROM session WHERE parent_id IS NULL AND internal IS NULL").fetchall()
                    candidates.extend((path, row[0]) for row in roots)
                except sqlite3.Error:
                    pass
                finally:
                    connection.close()
            if len(candidates) != 1 or candidates[0][1] != headers.get("X-Session-Id"):
                raise PolicyError("fresh owned native root not unique")
            self.database, self.root_id = candidates[0]
        return super().resolve(headers)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + self.server.funded_token:
            self.send_error(403); return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= MAX_BODY:
            self.send_error(400); return
        raw = self.rfile.read(size)
        body = json.loads(raw)
        with self.server.lock:
            index = len(self.server.rows) + 1
            if index > 32:
                self.send_error(429); return
            identity = self.headers.get("X-Session-Id")
            self.server.root = self.server.root or identity
            databases = list(self.server.home.rglob("vector*.db"))
            native, registry_error = [], None
            database = None
            for path in databases:
                connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
                connection.row_factory = sqlite3.Row
                try:
                    native = [dict(row) for row in connection.execute("SELECT id,parent_id,internal,agent,model,metadata FROM session")]
                    database = path
                except sqlite3.Error:
                    pass
                finally:
                    connection.close()
                if database:
                    break
            try:
                registry = NativeRegistry("vector", self.server.home, database, self.server.root, "openai")
                joined = registry.resolve(self.headers)
            except (PolicyError, TypeError) as error:
                joined, registry_error = None, str(error)
            tools = body.get("tools", []) + [tool for value in body.get("input", []) if isinstance(value, dict) and value.get("type") == "additional_tools" for tool in value.get("tools", [])]
            row = {"index": index, "unixNs": time.time_ns(), "model": body.get("model"), "reasoning": body.get("reasoning"), "headerNames": sorted(self.headers), "wireIdentity": identity, "parentHeader": self.headers.get("x-parent-session-id"), "tools": tools_projection(tools), "nativeBeforeResponse": native, "registryJoin": joined, "registryError": registry_error}
            self.server.rows.append(row)
            self.server.receipts.append({"seq": 600 + index, "actor": "foundry-vector", "label": getattr(self.server, "label", "synthetic-unscoped-probe"), "batchSha256": digest(self.server.funded_token), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": 0.000012})
            self.server.remaining -= 1
            save(self.server.out / "private-raw" / ("request-" + str(index).zfill(3) + ".json"), body)
            save(self.server.out / "capture.json", self.server.rows)
            call = None
            if self.server.mode in ("team", "duplicate") and identity == self.server.root and any(tool.get("name") == "task" for tool in tools) and self.server.stage < 2:
                selected = ROLES[:2] if self.server.stage == 0 else ROLES[:1] if self.server.mode == "duplicate" else ROLES[2:]
                self.server.stage += 1
                arguments = {"tasks": [{"description": "Harmless " + role, "prompt": "Harmless free protocol probe. Reply only probe-child-complete. Do not use shell, files, apps, browser, web or further agents.", "subagent_type": role} for role in selected], "background": False}
                call = {"name": "task", "arguments": json.dumps(arguments)}
                row["scriptedRoles"] = list(selected)
                save(self.server.out / "capture.json", self.server.rows)
        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Connection", "close"); self.end_headers()
        for sequence, event in enumerate(response_events(index, call)):
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush(); self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("vector-root", "bun", "node", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("capture", "team", "duplicate"), default="capture")
    parser.add_argument("--owned-witness", action="store_true")
    args = parser.parse_args()
    args.vector_root, args.bun, args.node, args.out = [value.resolve() for value in (args.vector_root, args.bun, args.node, args.out)]
    if args.out.exists() or args.out.is_relative_to(args.vector_root) or args.out.is_relative_to(Path(__file__).resolve().parents[3]):
        raise SystemExit("fresh private output outside source required")
    revision = subprocess.run(["git", "-C", str(args.vector_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(args.vector_root), "status", "--porcelain"], capture_output=True, text=True, check=True).stdout.strip()
    if revision != SOURCE or dirty:
        raise SystemExit("exact reviewed frozen source required")
    args.out.mkdir(parents=True)
    home, app = args.out / "runtime-home", args.out / "empty-workspace"
    home.mkdir(); app.mkdir()
    runner_path = Path(__file__).resolve().parent.parent / "agentic-study"
    sys.path.insert(0, str(runner_path))
    spec = importlib.util.spec_from_file_location("free_vector_runner_helpers", runner_path / "runner.py")
    runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
    env = runner.isolated_environment(home, app, args.bun, args.node)
    env["PATH"] = str(args.bun.parent) + ";" + str(args.node.parent) + ";" + str(Path(env["SystemRoot"]) / "System32")
    env = runner.vector_environment(env, home, "http://127.0.0.1:1", DUMMY)
    config = json.loads(env["VECTOR_CONFIG_CONTENT"])
    config["permission"] = {"*": "allow", "task": {"*": "deny", **{name: "allow" for name in ROLES}}, "research": "deny", "escalate": "deny", "bash": "deny", "terminal": "deny", "browser": "deny", "external_directory": "deny"}
    config["agent"] = {name: {"disable": True} for name in ("general", "explore", "review", "judge", "debug", "security", "research", "researcher", "research-judge", "test", "document")}
    config["agent"].update({name: {"mode": "subagent", "model": "openai/" + MODEL, "variant": "high", "description": "Harmless free native protocol probe", "prompt": "Reply only probe-child-complete. Do not use tools or delegate.", "permission": {"task": "deny", "task_manage": "deny", "research": "deny", "escalate": "deny"}} for name in ROLES})
    server = Capture(args.out, home, args.mode)
    witness, witness_thread, supervisor, closure = None, None, None, None
    holder = {}
    if args.owned_witness:
        supervisor = OwnedSupervisor(server.controller, lambda: list(server.receipts), args.out / "owned-scope", quiesced=lambda: holder.get("process") is not None and holder["process"].poll() is not None)
        arm = supervisor.begin("vector", "synthetic-free-vector", OwnedFreshVectorRegistry(home), ROLES)
        witness = WitnessServer(("127.0.0.1", 0), server.server_address, arm)
        witness_thread = threading.Thread(target=witness.serve_forever, daemon=True); witness_thread.start()
        binding = witness.cli_binding()
        config["provider"]["openai"]["options"].update(baseURL=binding["providerBase"] + "/v1", apiKey=binding["requestToken"])
        env["VECTOR_AUTH_CONTENT"] = json.dumps({"openai": {"type": "api", "key": binding["requestToken"]}})
    else:
        config["provider"]["openai"]["options"]["baseURL"] = "http://127.0.0.1:" + str(server.server_port) + "/v1"
    env["VECTOR_CONFIG_CONTENT"], env["VECTOR_PERMISSION"] = json.dumps(config), json.dumps(config["permission"])
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    command = [str(args.bun), "--no-env-file", "run", "--conditions=browser", str(args.vector_root / "packages/engine/src/index.ts"), "--pure", "run", "--dir", str(app), "--format", "json", "--model", "openai/" + MODEL, "--variant", "high", "--size", "thorough", "--judge", "off", "--max-cost", "3", "--max-steps", "30", "--auto", "Harmless free protocol probe. Follow only the fixed fake response script. No shell, file, app, browser or web actions. Use only the scripted study roles. Then report probe-complete."]
    try:
        with (args.out / "cli.stdout.jsonl").open("w", encoding="utf-8") as stdout, (args.out / "cli.stderr.log").open("w", encoding="utf-8") as stderr:
            process = subprocess.Popen(command, env=env, cwd=app, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
            holder["process"] = process
            try:
                process.wait(timeout=120); timed_out = False
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10); timed_out = True
    finally:
        if supervisor:
            closure = supervisor.close(timeout=5)
        if witness:
            witness.shutdown(); witness.server_close(); witness_thread.join(5)
        server.shutdown(); server.server_close(); thread.join(5)
    save(args.out / "summary.json", {"kind": "free-vector-native-protocol-probe-v1", "source": SOURCE, "mode": args.mode, "ownedAliasWitness": args.owned_witness, "fakeMeter": True, "paidProviderCalls": 0, "closure": closure, "exitCode": process.returncode, "timedOut": timed_out, "requests": len(server.rows), "allSolHigh": all(row["model"] == MODEL and row.get("reasoning", {}).get("effort") == "high" for row in server.rows), "allNativeJoins": all(row["registryJoin"] for row in server.rows), "BunSha256": hashlib.sha256(args.bun.read_bytes()).hexdigest(), "NodeSha256": hashlib.sha256(args.node.read_bytes()).hexdigest(), "hasProviderUpstream": False})
    print(json.dumps({"out": str(args.out), "requests": len(server.rows), "exitCode": process.returncode, "timedOut": timed_out}))


if __name__ == "__main__":
    main()
