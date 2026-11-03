"""Fake-only native cancellation timing; no Bun, browser, real key or gateway.

Uses the unchanged matched-team witness and actual pinned Codex command/profile.
The fixture never edits an application or claims a product/quality pass.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

TEAM = Path(__file__).resolve().parents[1] / "matched-agentic-study"
sys.path.insert(0, str(TEAM))
from codex_free_probe import DUMMY, PIN, named_tool, response_events, save
import heavy_runner
from heavy_codex_alias_probe import FakeLedger
import owned_team_witness
import paired_runner
from native_pair_smoke import multi_events

MARKER = "synthetic-coordinator-status-message"


class TrackingWriter:
    """Passive socket-write observation; does not alter original forwarding."""
    def __init__(self, original, events):
        self.original, self.events, self.buffer = original, events, b""
        self.terminal = False

    def write(self, data):
        try:
            result = self.original.write(data)
        except OSError:
            self.events.append({"event": "downstream_write_error", "unixNs": time.time_ns()})
            raise
        self.buffer += data
        if not self.terminal and b'event: response.completed\n' in self.buffer and self.buffer.endswith(b"\n\n"):
            self.terminal = True
            self.events.append({"event": "terminal_frame_written", "unixNs": time.time_ns()})
        return result

    def flush(self):
        return self.original.flush()

    def __getattr__(self, name):
        return getattr(self.original, name)


class TrackingHandler(owned_team_witness.Handler):
    def setup(self):
        super().setup()
        self.delivery = []
        self.server.delivery.append(self.delivery)
        self.wfile = TrackingWriter(self.wfile, self.delivery)

    def forward_model(self, arm):
        with arm.registry.connect() as database:
            row = database.execute("SELECT agent_role FROM threads WHERE id=?", (self.headers.get("thread-id"),)).fetchone()
        role = row[0] or "lead" if row else "unknown"
        arrival = {"role": role, "arrivedUnixNs": time.time_ns(), "finished": False}
        self.server.arrivals.append(arrival)
        try:
            return super().forward_model(arm)
        finally:
            arrival.update(finished=True, finishedUnixNs=time.time_ns())


class TrackingWitness(owned_team_witness.WitnessServer):
    def __init__(self, address, upstream, arm):
        self.delivery, self.arrivals = [], []
        super().__init__(address, upstream, arm)
        self.RequestHandlerClass = TrackingHandler


class Ledger(ThreadingHTTPServer):
    daemon_threads = True
    controller = FakeLedger.controller

    def __init__(self, out, registry, mode):
        self.out, self.registry, self.home, self.mode = out, registry, registry.home, mode
        self.lock, self.rows, self.receipts = threading.RLock(), [], []
        self.stages, self.finished, self.events = {}, set(), []
        self.funded_token, self.open, self.remaining = DUMMY, False, 0
        self.coordinator_sent, self.held = False, False
        super().__init__(("127.0.0.1", 0), Provider)


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        server = self.server
        if self.path != "/v1/responses" or self.headers.get("Authorization") != "Bearer " + DUMMY or not server.open:
            self.send_error(403); return
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        with server.lock:
            index = len(server.rows) + 1
            if index > 40:
                self.send_error(429); return
            native = server.registry.resolve(self.headers)
            role = native["role"]
            stage = server.stages.get(role, 0)
            server.stages[role] = stage + 1
            tools = body.get("tools", []) + [tool for value in body.get("input", []) if isinstance(value, dict)
                and value.get("type") == "additional_tools" for tool in value.get("tools", [])]
            calls, hold = [], False
            def call(name, arguments):
                selected = named_tool(tools, name)
                if selected is None:
                    raise ValueError("required native fixture tool absent: " + name)
                tool, namespace = selected
                value = {"name": tool["name"], "arguments": json.dumps(arguments)}
                if namespace:
                    value["namespace"] = namespace
                calls.append(value)
            if server.mode != "final-tail":
                if role == "lead" and stage == 0:
                    for child in (["backend_coordinator", "frontend_worker"] if server.mode in ("message-queued", "interrupt-queued") else ["backend_coordinator"]):
                        call("spawn_agent", {"task_name": child, "agent_type": child, "fork_turns": "none",
                            "message": "Labelled fake-only cancellation mechanics. Follow deterministic native responses. Do not edit files or use external services."})
                    if server.mode == "interrupt-queued":
                        call("interrupt_agent", {"target": "/root/frontend_worker"})
                elif role == "lead" and "backend_coordinator" not in server.finished:
                    hold = server.mode == "message-inflight" and server.coordinator_sent and not server.held
                    selected = named_tool(tools, "exec")
                    if selected is None:
                        raise ValueError("native code mode absent")
                    calls.append({"type": "custom_tool_call", "name": selected[0]["name"],
                        "namespace": selected[1], "input": 'text("labelled-native-noop");'})
                elif role == "backend_coordinator" and stage == 0 and server.mode == "interrupt-queued":
                    hold = True
                    server.finished.add(role)
                elif role == "backend_coordinator" and stage == 0:
                    server.coordinator_sent = True
                    call("send_message", {"target": "/root", "message": MARKER})
                elif role == "frontend_worker" and server.mode == "message-queued":
                    hold = server.coordinator_sent and not server.held
                else:
                    server.finished.add(role)
            if hold:
                server.held = True
            row = {"ordinal": index, "role": role, "stage": stage, "held": hold,
                   "markerAlreadyInInput": MARKER in json.dumps(body.get("input", [])),
                   "nativeIdentity": native["id"], "model": body.get("model"), "reasoning": body.get("reasoning"),
                   "text": body.get("text"), "maxOutputTokens": body.get("max_output_tokens"), "calls": [c["name"] for c in calls],
                   "startedUnixNs": time.time_ns()}
            server.rows.append(row)
            server.receipts.append({"seq": 889 + index, "actor": "foundry-codex", "label": server.label,
                "batchSha256": owned_team_witness.digest(DUMMY), "requestSha256": hashlib.sha256(raw).hexdigest(), "measuredUsd": .000012})
            server.remaining -= 1
            save(server.out / "private-capture.json", server.rows)
        self.send_response(200); self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close"); self.end_headers()
        events = multi_events(index, calls) if calls else response_events(index)
        if hold and role == "lead":
            item = {"type": "reasoning", "id": "rs_fixture_" + str(index),
                    "summary": [{"type": "summary_text", "text": "Labelled synthetic progress boundary."}]}
            reasoning = [
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "summary": []}},
                {"type": "response.reasoning_summary_part.added", "item_id": item["id"], "output_index": 0, "summary_index": 0,
                 "part": {"type": "summary_text", "text": ""}},
                {"type": "response.reasoning_summary_text.delta", "item_id": item["id"], "output_index": 0, "summary_index": 0,
                 "delta": item["summary"][0]["text"]},
                {"type": "response.reasoning_summary_text.done", "item_id": item["id"], "output_index": 0, "summary_index": 0,
                 "text": item["summary"][0]["text"]},
                {"type": "response.reasoning_summary_part.done", "item_id": item["id"], "output_index": 0, "summary_index": 0,
                 "part": item["summary"][0]},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
            ]
            for event in events[1:-1]:
                if "output_index" in event:
                    event["output_index"] += 1
            events[-1]["response"]["output"].insert(0, item)
            events = [events[0], *reasoning, *events[1:]]
        for sequence, event in enumerate(events):
            if role == "lead" and stage == 0 and server.mode == "interrupt-queued" and event["type"] == "response.function_call_arguments.delta" and event.get("output_index") == 2:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    pending = {row["role"] for row in server.witness.arrivals if not row["finished"]}
                    if {"backend_coordinator", "frontend_worker"} <= pending:
                        break
                    time.sleep(.01)
                server.events.append({"event": "native_interrupt_waited_for_pending_workers", "roles": sorted(pending), "unixNs": time.time_ns()})
            if hold and role == "lead" and event["type"] == "response.output_item.done" and event["item"]["type"] == "reasoning":
                time.sleep(.5)
            if role == "backend_coordinator" and stage == 0 and event["type"] == "response.function_call_arguments.delta":
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if any(row["role"] == "lead" and not row["finished"] for row in server.witness.arrivals):
                        break
                    time.sleep(.01)
                with server.arm.condition:
                    queued = len(server.arm.queue)
                server.events.append({"event": "coordinator_message_waited_for_pending_lead", "queued": queued, "unixNs": time.time_ns()})
            if hold and sequence == (7 if role == "lead" else 1):
                server.events.append({"event": "held_native_inference", "ordinal": index, "role": role, "unixNs": time.time_ns()})
                time.sleep(4)
            event["sequence_number"] = sequence
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
            if server.mode == "interrupt-queued" and role == "lead" and stage == 0 and event["type"] == "response.output_item.done" and event.get("output_index") == 2:
                time.sleep(.5)
        server.events.append({"event": "provider_terminal_sent", "ordinal": index, "unixNs": time.time_ns()})
        if server.mode == "final-tail" or role == "backend_coordinator" and stage == 0 and server.mode == "message-queued":
            time.sleep(1)
            self.wfile.write(b": labelled trailing SSE heartbeat\n\n"); self.wfile.flush()
            server.events.append({"event": "provider_trailing_heartbeat_sent", "ordinal": index, "unixNs": time.time_ns()})
        self.close_connection = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-bin", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--mode", choices=("final-tail", "message-inflight", "message-queued", "interrupt-queued"), required=True)
    args = parser.parse_args()
    args.codex_bin, args.out = args.codex_bin.resolve(), args.out.resolve()
    if args.out.exists() or args.out.is_relative_to(Path(__file__).resolve().parents[3]) or hashlib.sha256(args.codex_bin.read_bytes()).hexdigest() != PIN:
        raise SystemExit("new private output and pinned Codex required")
    args.out.mkdir(parents=True)
    common = paired_runner.common_helpers(TEAM.parent / "agentic-study")
    home, app = args.out / "runtime-home", args.out / "empty-workspace"
    home.mkdir(); app.mkdir()
    options = SimpleNamespace(codex_bin=args.codex_bin)
    env = common.isolated_environment(home, app, Path(sys.executable), Path(sys.executable))
    registry = paired_runner.FreshOwnedRegistry("codex", home, max_depth=2)
    server = Ledger(args.out, registry, args.mode)
    holder = {}
    supervisor = owned_team_witness.OwnedSupervisor(server.controller, lambda: list(server.receipts), args.out / "owned-scope",
        quiesced=lambda: holder.get("result", {}).get("ownedTreeQuiesced") is True, funding_profile=heavy_runner.FUNDING.phase)
    arm = supervisor.begin("codex", "synthetic-native-cancellation", registry, heavy_runner.HEAVY_ROLES,
        role_parents=heavy_runner.HEAVY_ROLE_PARENTS, max_calls=40, seconds=90, soft_usd=13.84808545)
    registry.on_bind = arm.record
    server.arm = arm
    witness = TrackingWitness(("127.0.0.1", 0), server.server_address, arm)
    server.witness = witness
    binding = witness.cli_binding()
    env = paired_runner.team_environment(common, "codex", env, home, binding, profile=heavy_runner.PROFILE)
    for role in heavy_runner.HEAVY_ROLES:
        (home / "codex" / (role + ".toml")).write_text('model="gpt-6.1-sol"\nmodel_provider="benchmark"\nmodel_reasoning_effort="high"\nmodel_reasoning_summary="auto"\nmodel_verbosity="low"\nmodel_context_window=1050000\n', encoding="utf-8")
    command = paired_runner.native_command(common, "codex", options, app, home, binding,
        "Labelled fake-only native cancellation mechanics. Follow deterministic provider actions; no files, browser, apps or external services.",
        None, 40, profile=heavy_runner.PROFILE)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    witness_thread = threading.Thread(target=witness.serve_forever, daemon=True); witness_thread.start()
    try:
        holder["result"] = paired_runner.execute_owned(common, command, app, env, args.out / "cli", 90, monitor=lambda: arm.failure)
        closure = supervisor.close(timeout=10)
    finally:
        witness.shutdown(); witness.server_close(); witness_thread.join(5)
        server.shutdown(); server.server_close(); thread.join(5)
    audit = [json.loads(line) for line in (args.out / "owned-scope/codex/witness-audit.jsonl").read_text().splitlines()]
    summary = {"kind": "fake-native-cancellation-mechanics-v1", "mode": args.mode,
        "binarySha256": PIN, "realProviderCalls": 0, "fundedMeterCalls": 0, "bunRuns": 0, "browserRuns": 0,
        "process": holder["result"], "closure": closure, "providerEvents": server.events,
        "socketWriteObservations": witness.delivery,
        "nativeRequestArrivals": witness.arrivals,
        "requests": [{key: row[key] for key in ("ordinal", "role", "stage", "held", "markerAlreadyInInput", "calls")} for row in server.rows],
        "afterUpstream": [{key: row[key] for key in ("ordinal", "terminalObserved", "outcome", "terminalEvent", "clientDisconnected", "transportFailed", "usage") if key in row}
            for row in audit if row["type"] == "after_upstream"],
        "stopEvents": [{key: row[key] for key in ("type", "reason", "ordinal") if key in row}
            for row in audit if row["type"] in ("arm_stopped_for_review", "admission_refused")],
        "productEvaluationPerformed": False, "qualificationOrQualityClaim": False}
    save(args.out / "summary.json", summary)
    print(json.dumps({"mode": args.mode, "requests": len(server.rows), "stopReason": closure.get("stopReason"),
        "settlementComplete": closure.get("settlementComplete"), "exitCode": holder["result"]["exitCode"]}))


if __name__ == "__main__":
    main()
