"""Owned, no-upstream Codex protocol probe. Never loads real credentials.

All runtime captures belong in a new private --out directory, outside Git.
Only scripted spawn/wait/close calls or a final text response can be emitted.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import threading
import time

from native_team_policy import NativeTeamPolicy, PolicyError

MODEL = "gpt-6.1-sol"
DUMMY = "free-probe-dummy-not-a-provider-key"
PIN = "3097c909fb6d5cd63510d44aceb1d42df9f6e85722a3e447e477def1ecf60e16"
MAX_BODY = 8_000_000


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def clean_schema(value):
    if isinstance(value, list):
        return [clean_schema(item) for item in value]
    if isinstance(value, dict):
        return {key: ({name: clean_schema(schema) for name, schema in item.items()} if key == "properties" else clean_schema(item)) for key, item in value.items() if key not in ("description", "title", "default", "examples")}
    return value


def tools_projection(tools):
    result = []
    for tool in tools if isinstance(tools, list) else []:
        if not isinstance(tool, dict):
            continue
        item = {key: tool[key] for key in ("type", "name") if key in tool}
        if "parameters" in tool:
            item["parameters"] = clean_schema(tool["parameters"])
        if isinstance(tool.get("tools"), list):
            item["tools"] = tools_projection(tool["tools"])
        if "format" in tool:
            item["format"] = {"type": tool["format"].get("type"), "sha256": digest(tool["format"])}
        result.append(item)
    return result


def native_state(home):
    """Read only metadata in this probe's newly created native home."""
    result = {"observedUnixNs": time.time_ns(), "sqlite": [], "rollouts": []}
    for path in sorted(home.rglob("*.sqlite")):
        row = {"relativePath": str(path.relative_to(home)), "tables": [], "threads": []}
        try:
            connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2)
            connection.row_factory = sqlite3.Row
            row["tables"] = [value[0] for value in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            if "threads" in row["tables"]:
                row["threadColumns"] = [value[1] for value in connection.execute("PRAGMA table_info(threads)")]
                allowed = [name for name in row["threadColumns"] if name in ("id", "source", "model_provider", "model", "reasoning_effort", "agent_path", "thread_source", "created_at", "updated_at", "agent_nickname", "agent_role", "parent_thread_id", "rollout_path")]
                row["threads"] = [dict(value) for value in connection.execute("SELECT " + ",".join('"' + name + '"' for name in allowed) + " FROM threads LIMIT 20")]
            if "thread_spawn_edges" in row["tables"]:
                row["spawnEdgeColumns"] = [value[1] for value in connection.execute("PRAGMA table_info(thread_spawn_edges)")]
                row["spawnEdges"] = [dict(value) for value in connection.execute("SELECT * FROM thread_spawn_edges LIMIT 20")]
            connection.close()
        except sqlite3.Error as error:
            row["readError"] = type(error).__name__
        result["sqlite"].append(row)
    for path in sorted(home.glob("sessions/**/*.jsonl")):
        items = []
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if len(line) > MAX_BODY:
                    continue
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if value.get("type") == "session_meta" and isinstance(value.get("payload"), dict):
                    items.append({key: value["payload"][key] for key in ("id", "timestamp", "originator", "cli_version", "source", "model_provider", "agent_nickname", "agent_role", "parent_thread_id") if key in value["payload"]})
                if value.get("type") == "turn_context" and isinstance(value.get("payload"), dict):
                    items.append({key: value["payload"][key] for key in ("turn_id", "model", "effort", "model_provider", "collaboration_mode") if key in value["payload"]})
        result["rollouts"].append({"relativePath": str(path.relative_to(home)), "metadata": items})
    return result


def response_events(index, call=None):
    identity = "resp_free_probe_" + str(index)
    if call:
        item = {"id": "fc_free_probe_" + str(index), "type": "function_call", "status": "completed", "call_id": "call_free_probe_" + str(index), **call}
    else:
        item = {"id": "msg_free_probe_" + str(index), "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "free-probe-complete", "annotations": []}]}
    response = {"id": identity, "object": "response", "created_at": int(time.time()), "status": "completed", "model": MODEL, "output": [item], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}}}
    events = [{"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}, {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", **({"arguments": ""} if call else {"content": []})}}]
    if call:
        events.extend([{"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]}, {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}])
    else:
        events.extend([{"type": "response.content_part.added", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}, {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "free-probe-complete"}, {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": "free-probe-complete"}, {"type": "response.content_part.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": item["content"][0]}])
    events.extend([{"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}])
    return events


def named_tool(tools, name, namespace=None):
    for tool in tools if isinstance(tools, list) else []:
        if tool.get("type") == "namespace":
            found = named_tool(tool.get("tools"), name, tool.get("name"))
            if found:
                return found
        elif tool.get("name") == name:
            return tool, namespace
    return None


class Capture(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, out, home, mode, enforce_policy=False):
        self.out, self.home, self.mode = out, home, mode
        self.lock, self.records = threading.Lock(), []
        self.root_thread, self.root_calls = None, 0
        self.child_calls, self.release_children = {}, threading.Event()
        self.enforce_policy, self.policy = enforce_policy, None
        super().__init__(("127.0.0.1", 0), Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + DUMMY:
            self.send_error(403)
            return
        if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding", "identity") != "identity":
            self.send_error(400)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError("invalid body bound")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("object required")
        except (ValueError, TypeError):
            self.send_error(400)
            return
        with self.server.lock:
            if len(self.server.records) >= 32:
                self.send_error(429, "Finite free probe exhausted")
                return
            index = len(self.server.records) + 1
            save(self.server.out / "private-raw" / ("request-" + str(index).zfill(3) + ".json"), body)
            identity = self.headers.get("thread-id")
            if self.server.root_thread is None:
                self.server.root_thread = identity
            is_root = identity == self.server.root_thread
            if is_root:
                self.server.root_calls += 1
            else:
                self.server.child_calls[identity] = self.server.child_calls.get(identity, 0) + 1
            inputs = [value for value in body.get("input", []) if isinstance(value, dict)]
            outputs = [{"call_id": value.get("call_id"), "output": value.get("output")} for value in inputs if value.get("type") == "function_call_output"]
            declarations = body.get("tools", []) + [tool for value in inputs if value.get("type") == "additional_tools" for tool in value.get("tools", [])]
            record = {"index": index, "receivedUnixNs": time.time_ns(), "headerNames": sorted(self.headers.keys()), "wireIdentities": {key: value[:3000] for key, value in self.headers.items() if re.search(r"thread|session|conversation|parent|turn", key, re.I)}, "model": body.get("model"), "reasoning": body.get("reasoning"), "maxOutputTokens": body.get("max_output_tokens"), "promptCacheKey": body.get("prompt_cache_key"), "topLevelKeys": sorted(body), "inputItemTypes": [value.get("type", value.get("role")) for value in inputs], "tools": tools_projection(declarations), "functionOutputs": outputs, "nativeBeforeResponse": native_state(self.server.home)}
            self.server.records.append(record)
            save(self.server.out / "capture.json", self.server.records)
            if self.server.enforce_policy:
                if self.server.policy is None:
                    self.server.policy = NativeTeamPolicy(self.server.root_thread, ["study_worker"])
                try:
                    body, record["policyAudit"] = self.server.policy.apply(body, dict(self.headers), record["nativeBeforeResponse"])
                except PolicyError as error:
                    record["policyRejected"] = str(error)
                    save(self.server.out / "capture.json", self.server.records)
                    self.send_error(400, "Free native policy refused inference")
                    return
                declarations = body.get("tools", []) + [tool for value in body.get("input", []) if isinstance(value, dict) and value.get("type") == "additional_tools" for tool in value.get("tools", [])]
                record["toolsAfterPolicy"] = tools_projection(declarations)
                save(self.server.out / "private-raw" / ("normalized-" + str(index).zfill(3) + ".json"), body)
            call = None
            wanted = None
            task_name = "probe_child"
            if self.server.mode in ("spawn", "nested", "thread-cap") and is_root:
                if self.server.root_calls == 1:
                    wanted = "spawn_agent"
                elif self.server.mode == "thread-cap" and self.server.root_calls == 2:
                    wanted, task_name = "spawn_agent", "probe_second"
                elif self.server.root_calls == (3 if self.server.mode == "thread-cap" else 2):
                    wanted = "wait_agent"
                    self.server.release_children.set()
            if self.server.mode == "nested" and not is_root:
                metadata = json.loads(self.headers.get("x-codex-turn-metadata", "{}"))
                if metadata.get("agent_name", "").count("/") == 2 and self.server.child_calls[identity] <= 2:
                    wanted = "spawn_agent" if self.server.child_calls[identity] == 1 else "wait_agent"
                    task_name = "probe_nested"
            if wanted:
                found = named_tool(declarations, wanted)
                if found:
                    tool, namespace = found
                    arguments = {"task_name": task_name, "message": "Harmless free protocol probe. Reply only probe-child-complete. Do not use tools, shell, files, web, apps, or further agents.", "agent_type": "study_worker", "fork_turns": "none"} if wanted == "spawn_agent" else {"timeout_ms": 10000}
                    call = {"name": tool["name"], "arguments": json.dumps(arguments)}
                    if namespace:
                        call["namespace"] = namespace
                record["scriptedTool"] = wanted if found else None
            save(self.server.out / "capture.json", self.server.records)
        if self.server.mode == "thread-cap" and not is_root:
            self.server.release_children.wait(timeout=15)
        events = response_events(index, call)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for sequence, event in enumerate(events):
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()
        self.close_connection = True


def environment(home, cli):
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if key in os.environ}
    env.update({"PATH": str(cli.parent) + os.pathsep + str(Path(env.get("SystemRoot", "C:/Windows")) / "System32"), "HOME": str(home), "USERPROFILE": str(home), "CODEX_HOME": str(home / "codex"), "CI": "1", "NO_COLOR": "1", "BENCH_API_KEY": DUMMY})
    for key, relative in {"TEMP": "temp", "TMP": "temp", "LOCALAPPDATA": "AppData/Local", "APPDATA": "AppData/Roaming", "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_STATE_HOME": "state", "XDG_CACHE_HOME": "cache"}.items():
        (home / relative).mkdir(parents=True, exist_ok=True)
        env[key] = str(home / relative)
    (home / "codex").mkdir(parents=True, exist_ok=True)
    return env


def command(cli, base, feature, threads, role_file):
    result = [str(cli), "exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--model", MODEL]
    if feature != "default":
        result.extend(["--enable", feature])
    for value in ['approval_policy="never"', 'web_search="disabled"', 'cli_auth_credentials_store="file"', 'mcp_oauth_credentials_store="file"', 'model_provider="free_probe"', 'model_reasoning_effort="high"', 'model_context_window=1050000', 'model_verbosity="low"', 'model_reasoning_summary="auto"', 'model_providers.free_probe.name="free_probe"', 'model_providers.free_probe.wire_api="responses"', 'model_providers.free_probe.base_url="' + base + '/v1"', 'model_providers.free_probe.env_key="BENCH_API_KEY"', 'model_providers.free_probe.supports_websockets=false', 'agents.max_threads=' + str(threads), 'agents.study_worker.description="Harmless free protocol probe worker"', 'agents.study_worker.config_file=' + json.dumps(str(role_file)), 'analytics.enabled=false', 'feedback.enabled=false', 'otel.exporter="none"']:
        result.extend(["-c", value])
    for name in ("apps", "plugins", "api_key_model_discovery", "api_key_cyber_access_programs", "plugin_discovery_prefetch", "remote_plugin", "skill_search", "skill_mcp_dependency_install", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "daemon_auto_start", "hooks", "shell_snapshot", "shell_tool", "unified_exec", "view_image", "in_app_browser", "artifact", "workspace_dependencies", "memories"):
        result.extend(["-c", "features." + name + "=false"])
    return result + ["Harmless free protocol probe. Follow only the scripted fake provider response. Do not use shell, files, apps, web, external services, or any tools except the exact scripted spawn. Return probe-complete."]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-bin", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--mode", choices=("capture", "spawn", "nested", "thread-cap", "inspect"), default="capture")
    parser.add_argument("--feature", default="multi_agent")
    parser.add_argument("--max-threads", type=int, default=3)
    parser.add_argument("--enforce-policy", action="store_true")
    args = parser.parse_args()
    args.codex_bin, args.out = args.codex_bin.resolve(), args.out.resolve()
    if args.out.exists() or args.out.is_relative_to(Path(__file__).resolve().parents[3]) or hashlib.sha256(args.codex_bin.read_bytes()).hexdigest() != PIN:
        raise SystemExit("new output and exact frozen CLI hash required")
    args.out.mkdir(parents=True)
    home, app = args.out / "runtime-home", args.out / "empty-workspace"
    home.mkdir(); app.mkdir()
    env = environment(home, args.codex_bin)
    (home / "codex" / "study-worker.toml").write_text('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\nmodel_provider = "free_probe"\n[features]\nmulti_agent = false\n', encoding="utf-8")
    version = subprocess.run([str(args.codex_bin), "--version"], env=env, cwd=app, text=True, capture_output=True, timeout=15)
    save(args.out / "version.json", {"stdout": version.stdout, "stderr": version.stderr, "exitCode": version.returncode, "sha256": PIN})
    if args.mode == "inspect":
        result = subprocess.run([str(args.codex_bin), "features", "list"], env=env, cwd=app, text=True, capture_output=True, timeout=15)
        save(args.out / "features.json", {"stdout": result.stdout, "stderr": result.stderr, "exitCode": result.returncode})
        print(json.dumps({"out": str(args.out), "mode": "inspect", "version": version.stdout.strip()}))
        return
    server = Capture(args.out, home / "codex", args.mode, args.enforce_policy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = time.time_ns()
    try:
        with (args.out / "cli.stdout.jsonl").open("w", encoding="utf-8") as stdout, (args.out / "cli.stderr.log").open("w", encoding="utf-8") as stderr:
            process = subprocess.Popen(command(args.codex_bin, "http://127.0.0.1:" + str(server.server_port), args.feature, args.max_threads, home / "codex" / "study-worker.toml"), env=env, cwd=app, stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL)
            try:
                process.wait(timeout=90)
                timed_out = False
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=10)
                timed_out = True
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
    save(args.out / "native-final.json", native_state(home / "codex"))
    save(args.out / "summary.json", {"kind": "free-codex-protocol-probe-v1", "version": version.stdout.strip(), "binarySha256": PIN, "mode": args.mode, "feature": args.feature, "maxThreadsConfigured": args.max_threads, "nativePolicyEnforced": args.enforce_policy, "exitCode": process.returncode, "timedOut": timed_out, "requests": len(server.records), "startedUnixNs": started, "endedUnixNs": time.time_ns(), "hasUpstreamImplementation": False, "realCredentialEnvironmentInherited": False})
    print(json.dumps({"out": str(args.out), "exitCode": process.returncode, "requests": len(server.records), "timedOut": timed_out}))


if __name__ == "__main__":
    main()
