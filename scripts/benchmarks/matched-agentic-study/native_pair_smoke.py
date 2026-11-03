"""Explicit fake-only qualification of the actual NativeAdapter commands.

No provider/controller credential is loaded. The only upstream is an ephemeral
Python loopback server owned by this process. Its deterministic responses leave
the real task seed unchanged, so the real evaluator must remain negative. Raw
requests, native IDs, tool commands and runtime homes stay private.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
from pathlib import Path
import secrets
import threading

from codex_free_probe import MAX_BODY, named_tool, response_events
from native_team_policy import MODEL, PolicyError, require
from owned_team_witness import ACTORS, FUNDING_PHASE, OwnedSupervisor, digest
import paired_runner as runner


def custom_events(index, call):
    events = response_events(index, {"name": call["name"], "namespace": call["namespace"], "arguments": call["input"]})
    def item(value):
        value["type"] = "custom_tool_call"
        value["input"] = value.pop("arguments")
    for event in events:
        if event["type"].startswith("response.function_call_arguments."):
            event["type"] = event["type"].replace("function_call_arguments", "custom_tool_call_input")
            if "arguments" in event:
                event["input"] = event.pop("arguments")
        if "item" in event:
            item(event["item"])
        for value in event.get("response", {}).get("output", []):
            if value["type"] != "custom_tool_call":
                item(value)
    return events


def execution_call(runtime, tools, command):
    if runtime == "vector":
        found = named_tool(tools, "bash")
        require(found is not None, "native shell capability absent")
        return {"name": found[0]["name"], "arguments": json.dumps({"command": command, "description": "Owned fake-protocol capability verification"})}
    found = named_tool(tools, "exec")
    require(found is not None and found[0].get("type") == "custom", "native custom exec capability absent")
    return {"type": "custom_tool_call", "name": found[0]["name"], "namespace": found[1],
            "input": "const result = await tools.exec_command(" + json.dumps({"cmd": command, "yield_time_ms": 30000}) + "); text(result);"}


def multi_events(index, calls):
    if not calls:
        return response_events(index)
    first, events, items, last = None, [], [], None
    for offset, call in enumerate(calls):
        current = custom_events(index * 10 + offset, call) if call.get("type") == "custom_tool_call" else response_events(index * 10 + offset, call)
        first = first or current[0]
        for event in current[1:-1]:
            event["output_index"] = offset
            events.append(event)
        items.append(current[-1]["response"]["output"][0])
        last = current[-1]
    last["response"]["id"] = first["response"]["id"]
    last["response"]["output"] = items
    return [first, *events, last]


def shell_command(port):
    # Capabilities only: this page/API are a labelled smoke fixture, not the app.
    action = json.dumps({"action": "open", "url": "http://127.0.0.1:" + str(port)}, separators=(",", ":"))
    return ("Invoke-RestMethod 'http://127.0.0.1:" + str(port) + "/api/health' | ConvertTo-Json -Compress; "
            "'" + action + "' | & $env:NODE_EXE $env:BROWSER_DRIVER_CLIENT --endpoint $env:BROWSER_DRIVER_ENDPOINT")


def scripted_calls(runtime, stage, tools, port):
    def call(name, arguments):
        found = named_tool(tools, name)
        require(found is not None, "required native capability absent: " + name)
        tool, namespace = found
        result = {"name": tool["name"], "arguments": json.dumps(arguments)}
        if namespace:
            result["namespace"] = namespace
        return result
    message = "Fake-only adapter qualification. Leave the task seed unchanged. Reply smoke-child-complete; do not use tools or delegate."
    if runtime == "vector" and stage in (0, 1):
        roles = runner.ROLES[:2] if stage == 0 else runner.ROLES[2:]
        return [call("task", {"tasks": [{"description": "Fixed smoke " + role, "prompt": message,
                                         "subagent_type": role} for role in roles], "background": False})]
    if runtime == "codex" and stage in (0, 2):
        roles = runner.ROLES[:2] if stage == 0 else runner.ROLES[2:]
        return [call("spawn_agent", {"task_name": role, "agent_type": role, "fork_turns": "none", "message": message}) for role in roles]
    if runtime == "codex" and stage in (1, 3):
        return [call("wait_agent", {"timeout_ms": 10000})]
    if stage == (2 if runtime == "vector" else 4):
        return [execution_call(runtime, tools, shell_command(port))]
    return []


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.server.hits.append({"api": self.path == "/api/health", "browser": "Chrome/" in self.headers.get("User-Agent", "")})
        wire = (b'{"ok":true,"fixture":"adapter-smoke-only"}' if self.path == "/api/health" else
                b'<!doctype html><html><title>Adapter smoke fixture</title><body>Fake protocol qualification only. This is not a benchmark app.</body></html>')
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if self.path == "/api/health" else "text/html")
        self.send_header("Content-Length", str(len(wire)))
        self.end_headers()
        self.wfile.write(wire)


class FakeMeter(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, out):
        self.out, self.lock = out, threading.RLock()
        self.rows, self.receipts, self.root_stages, self.child_stages = [], [], {}, {}
        self.token, self.actor, self.label, self.remaining = None, None, None, 0
        self.adapter = None
        super().__init__(("127.0.0.1", 0), Handler)
        require(self.server_port not in (23128, 23129, 23130), "normal funded port forbidden")

    def controller(self, route, value=None):
        with self.lock:
            if route == "/control":
                require(self.remaining == 0, "fake scope already open")
                self.actor, self.label, self.remaining = value["actor"], value["label"], value["calls"]
                self.token = "dummy-fake-scope-" + secrets.token_hex(24)
                return {"requestToken": self.token}
            require(route in ("/status", "/disarm"), "unrecognized fake-only controller operation")
            if route == "/disarm":
                require(value == {"requestToken": self.token}, "wrong fake scope")
                self.remaining = 0
            costs = {actor: sum(row["measuredUsd"] for row in self.receipts if row["actor"] == actor) for actor in ACTORS.values()}
            return {"limitUsd": 48, "phaseID": FUNDING_PHASE, "halted": None,
                    "attempts": runner.HISTORICAL_REQUESTS + len(self.receipts),
                    "measuredUsd": runner.HISTORICAL_USD + sum(costs.values()), "active": 0, "reservedUsd": 0,
                    "batchCallsRemaining": self.remaining,
                    "actors": {actor: {"limitUsd": 20, "measuredUsd": initial + costs[actor], "reservedUsd": 0}
                               for actor, initial in (("foundry-vector", 10.8884618), ("foundry-codex", 6.4715992))}}


    def next_calls(self, adapter, native, tools):
        calls = []
        if native["role"] == "lead":
            stage = self.root_stages.get(adapter.runtime, 0)
            self.root_stages[adapter.runtime] = stage + 1
            calls = scripted_calls(adapter.runtime, stage, tools, adapter.options.app_port)
        else:
            identity = native["id"]
            stage = self.child_stages.get(identity, 0)
            self.child_stages[identity] = stage + 1
            if stage == 0:
                calls = [execution_call(adapter.runtime, tools, "Write-Output 'smoke-child-shell-complete'")]
        return calls


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        server = self.server
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + str(server.token):
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_BODY:
            self.send_error(400)
            return
        raw = self.rfile.read(length)
        body = json.loads(raw)
        with server.lock:
            require(server.remaining > 0 and len(server.rows) < 100, "bounded fake request limit")
            adapter = server.adapter
            native = adapter.registry.resolve(dict(self.headers))
            tools = body.get("tools", []) + [tool for item in body.get("input", [])
                if isinstance(item, dict) and item.get("type") == "additional_tools" for tool in item.get("tools", [])]
            index = len(server.rows) + 1
            row = {"runtime": adapter.runtime, "native": native, "model": body.get("model"),
                   "reasoning": body.get("reasoning"), "verbosity": body.get("text", {}).get("verbosity"),
                   "outputCeiling": body.get("max_output_tokens"), "offeredToolNames": [tool.get("name") for tool in tools]}
            server.rows.append(row)
            server.receipts.append({"seq": runner.HISTORICAL_REQUESTS + index, "actor": server.actor,
                "label": server.label, "batchSha256": digest(server.token), "requestSha256": hashlib.sha256(raw).hexdigest(),
                "measuredUsd": 0.000012})
            server.remaining -= 1
            adapter.common.save(server.out / "private-raw" / (str(index).zfill(3) + ".json"), body)
            adapter.common.save(server.out / "private-capture.json", server.rows)
            calls = server.next_calls(adapter, native, tools)
            adapter.common.save(server.out / "private-raw" / (str(index).zfill(3) + ".json"), body)
            adapter.common.save(server.out / "private-capture.json", server.rows)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for sequence, event in enumerate(multi_events(index, calls)):
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()
        self.close_connection = True


class SmokeAdapter(runner.NativeAdapter):
    """Commands/run/environment are inherited unchanged; only fixture lifecycle wraps them."""
    def prepare(self):
        super().prepare()
        self.fixture_hits = []
        self.seed_manifest = self.common.manifest(self.app, self.task.get("generatedDirectories", []))

    def preserve(self, index):
        artifact = super().preserve(index)
        artifact["unchangedSmokeSeed"] = self.seed_manifest == self.common.manifest(self.app, self.task.get("generatedDirectories", []))
        return artifact

    def bind(self, arm):
        super().bind(arm)
        self.supervisor_holder["fakeMeter"].adapter = self

    def run(self, prompt, session, timeout, index):
        fixture = ThreadingHTTPServer(("127.0.0.1", self.options.app_port), FixtureHandler)
        fixture.hits = []
        thread = threading.Thread(target=fixture.serve_forever, daemon=True)
        thread.start()
        try:
            return super().run(prompt, session, timeout, index)
        finally:
            fixture.shutdown()
            fixture.server_close()
            thread.join(timeout=10)
            self.fixture_hits.extend(fixture.hits)


def capabilities(adapter):
    calls = []
    for path in (adapter.directory / "attempts").glob("*/agent.stdout.log"):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if adapter.runtime == "vector":
                part = row.get("part", {})
                if part.get("type") != "tool" or part.get("tool") != "bash":
                    continue
                state = part.get("state", {})
                code, output = state.get("metadata", {}).get("exit"), state.get("output", "")
            else:
                item = row.get("item", {})
                if row.get("type") != "item.completed" or item.get("type") != "command_execution":
                    continue
                code, output = item.get("exit_code"), item.get("aggregated_output", "")
            calls.append({"exitZero": code == 0, "apiMarker": '"fixture":"adapter-smoke-only"' in output,
                          "browserTitle": "Adapter smoke fixture" in output,
                          "browserAction": '"action":"open"' in output and '"ok":true' in output})
    return {"successfulActualShellApiAndCommonBrowser": any(all(row.values()) for row in calls),
            "rootShellCallsObserved": len(calls), "fixtureApiRequests": sum(row["api"] for row in adapter.fixture_hits),
            "fixtureBrowserPageRequests": sum(row["browser"] and not row["api"] for row in adapter.fixture_hits)}


def main(argv=None):
    parser = runner.parser()
    parser.description = __doc__
    parser.add_argument("--runtime", choices=("vector", "codex"), required=True)
    options = parser.parse_args(argv)
    require(not options.run and options.controller_config is None and options.receipt_jsonl is None,
            "smoke cannot accept real controller/receipt execution inputs")
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    require(options.task_index == 1 and not options.previous_summary, "smoke uses only the unchanged first real seed")
    runner.checked_path(options.out, [options.vector_root, options.task_root, options.common_runner_root,
        options.browser_driver_root, Path(__file__).resolve().parents[3]])
    common = runner.common_helpers(options.common_runner_root)
    options.browser_access_mode = "shared-client"
    # The fake endpoint replaces the supplied default before any NativeAdapter binding.
    options.out.mkdir(parents=True)
    meter = FakeMeter(options.out)
    options.provider_base = "http://127.0.0.1:" + str(meter.server_port)
    plan = runner.build_plan(options, common)
    require(not plan["sourceDirty"] and options.expected_source == plan["sourceRevision"],
            "smoke requires the explicitly reviewed clean product revision")
    common.save(options.out / "smoke-plan.json", plan)
    holder = {"fakeMeter": meter}
    supervisor = OwnedSupervisor(meter.controller, lambda: list(meter.receipts), options.out,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    task = plan["fixedTasks"][0]["contract"]
    adapter = SmokeAdapter(options.runtime, options, common, task, holder)
    holder["adapter"] = adapter
    thread = threading.Thread(target=meter.serve_forever, daemon=True)
    thread.start()
    try:
        result = runner.coordinate_team_arm(supervisor=supervisor, runtime=options.runtime,
            label="synthetic-adapter-smoke-" + options.runtime, adapter=adapter, task=task, common=common,
            check_frozen=lambda: require(runner.build_plan(options, common) == plan, "smoke source freeze changed"),
            persist=lambda value: common.save(options.out / "private-result.json", value))
        summary = {"kind": "fake-actual-native-adapter-smoke-v1", "runtime": options.runtime,
            "realProviderCalls": 0, "fundedMeterCalls": 0,
            "unchangedRealSeed": bool(result["attempts"]) and all(attempt["artifact"].get("unchangedSmokeSeed") is True for attempt in result["attempts"]),
            "expectedFunctionalVerdict": "product_failure", "sourceRevision": plan["sourceRevision"],
            "instrumentFreeze": plan["teamInstrumentFiles"], "binarySha256": plan["binarySha256"],
            "fakeRequests": len(meter.receipts), "allSolHighAutoLow": all(row["model"] == MODEL
                and row["reasoning"].get("effort") == "high" and row["reasoning"].get("summary") == "auto"
                and row["verbosity"] == "low" and row["outputCeiling"] == 32000 for row in meter.rows),
            **{key: result.get(key) for key in ("functionalVerdict", "nativeAuditVerdict", "stopReason",
                "reviewRequired", "settlementComplete", "providerRequests", "autonomousActorsAdmitted", "nativeAudit")}}
        summary["capabilityEvidence"] = capabilities(adapter)
        summary["qualificationPassed"] = (summary["allSolHighAutoLow"] is True and summary["unchangedRealSeed"] is True
            and result.get("functionalVerdict") == "product_failure"
            and result.get("stopReason") == "product_failure_after_one_same_session_repair"
            and result.get("settlementComplete") is True and result.get("reviewRequired") is False
            and result.get("nativeAuditVerdict") == "passed" and result.get("autonomousActorsAdmitted") == 4
            and result.get("providerRequests") == len(meter.receipts)
            and summary["capabilityEvidence"]["successfulActualShellApiAndCommonBrowser"] is True
            and summary["capabilityEvidence"]["fixtureApiRequests"] > 0
            and summary["capabilityEvidence"]["fixtureBrowserPageRequests"] > 0)
        common.save(options.out / "smoke-summary.json", summary)
        print(json.dumps({key: value for key, value in summary.items() if key not in ("instrumentFreeze", "binarySha256", "nativeAudit")}, indent=2))
        return 0 if summary["qualificationPassed"] else 2
    finally:
        meter.shutdown()
        meter.server_close()
        thread.join(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
