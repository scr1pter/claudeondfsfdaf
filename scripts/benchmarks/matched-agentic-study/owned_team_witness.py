"""Keyless owned-arm components. No CLI, credential loading, or service startup.

The supervisor injects an existing meter client and receives its owned batch
token in memory. Coding CLIs receive only an unrelated local alias. Tests use
fake loopback upstreams. Connecting a funded profile requires separate review.
"""
from collections import defaultdict, deque
import copy
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
import select
import socket
import threading
import time

from native_team_policy import MODEL, PolicyError, filter_tools, require

MAX_BODY = 8_000_000
CONTEXT_LIMIT, OUTPUT_CEILING = 1_050_000, 32_000
ACTORS = {"vector": "foundry-vector", "codex": "foundry-codex"}
FUNDING_PHASE = "foundry-large-single-agent-high-v1"
HOP = {"host", "authorization", "content-length", "connection", "transfer-encoding", "proxy-connection", "keep-alive", "upgrade"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def known(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def healthy(state, before=None, idle=False):
    require(isinstance(state, dict), "unknown funding state")
    require(state.get("limitUsd") == 48 and state.get("phaseID") == FUNDING_PHASE and state.get("halted") is None, "funding policy changed or halted")
    require(known(state.get("measuredUsd")) and state["measuredUsd"] >= 11.2319408 and known(state.get("reservedUsd")) and state["measuredUsd"] + state["reservedUsd"] <= 48 + 1e-8, "global funding state invalid")
    require(isinstance(state.get("attempts"), int) and not isinstance(state["attempts"], bool) and state["attempts"] >= 449 and isinstance(state.get("active"), int) and state["active"] >= 0, "request history invalid")
    for actor in ACTORS.values():
        row = state.get("actors", {}).get(actor, {})
        require(row.get("limitUsd") == 20 and known(row.get("measuredUsd")) and known(row.get("reservedUsd")) and row["measuredUsd"] + row["reservedUsd"] <= 20 + 1e-8, "actor funding policy changed")
        if before:
            require(row["measuredUsd"] >= before["actors"][actor]["measuredUsd"] - 1e-8, "actor spending rewound")
    if before:
        require(state["attempts"] >= before["attempts"] and state["measuredUsd"] >= before["measuredUsd"] - 1e-8, "funding history rewound")
    if idle:
        require(state["active"] == 0 and state["reservedUsd"] == 0, "funding remains unsettled")
    return state


class Audit:
    def __init__(self, path):
        self.path, self.sequence, self.previous, self.lock = Path(path), 0, None, threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.open("x", encoding="utf-8").close()

    def append(self, event):
        with self.lock:
            require(not set(event) & {"sequence", "previousSha256", "unixNs"}, "reserved audit field")
            row = {"sequence": self.sequence + 1, "previousSha256": self.previous, "unixNs": time.time_ns(), **event}
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            self.sequence += 1
            self.previous = digest(row)


def generation_pins(value):
    reasoning = value["reasoning"]
    require(reasoning.get("summary", "auto") == "auto", "reasoning summary changed")
    reasoning["summary"] = "auto"
    text = value.get("text", {})
    require(isinstance(text, dict) and text.get("verbosity", "low") == "low", "text verbosity changed")
    value["text"] = {**text, "verbosity": "low"}


def profile_body(body, child):
    require(isinstance(body, dict) and body.get("model") == MODEL and isinstance(body.get("reasoning"), dict) and body["reasoning"].get("effort") == "high", "model or effort changed")
    for value in (body, body["reasoning"]):
        require(value.get("pro") in (None, False) and all(str(value.get(key, "")).lower() != "pro" for key in ("mode", "model_mode", "modelMode", "service_tier")), "unreviewed processing mode")
    require(body.get("service_tier", "default") in ("default", "standard"), "unreviewed processing tier")
    result = copy.deepcopy(body)
    generation_pins(result)
    if "tools" in result:
        result["tools"] = filter_tools(result["tools"], child)
    require(isinstance(result.get("input"), list), "structured input required")
    for item in result["input"]:
        if isinstance(item, dict) and item.get("type") == "additional_tools":
            item["tools"] = filter_tools(item.get("tools"), child)
        if isinstance(item, dict) and item.get("type") == "configuration_update":
            require(set(item) <= {"type", "model", "reasoning", "text"} and item.get("model", MODEL) == MODEL and isinstance(item.get("reasoning"), dict) and item["reasoning"].get("effort") == "high" and item["reasoning"].get("pro") in (None, False) and str(item["reasoning"].get("mode", "")).lower() != "pro", "configuration update changes profile")
            generation_pins(item)
    output = result.get("max_output_tokens", OUTPUT_CEILING)
    require(isinstance(output, int) and not isinstance(output, bool) and output > 0, "invalid output ceiling")
    result.update(max_output_tokens=min(output, OUTPUT_CEILING), service_tier="default", store=False)
    return result


def reservation_bound(body, wire):
    """The unchanged meter's conservative single-call bound, without admission."""
    def image(value):
        return any(image(item) for item in value) if isinstance(value, list) else value.get("type") == "input_image" or any(image(item) for item in value.values()) if isinstance(value, dict) else False
    inputs = CONTEXT_LIMIT if image(body) else min(CONTEXT_LIMIT, len(wire) + 32768 + len(body.get("tools", [])) * 256)
    return (inputs * 5 + body["max_output_tokens"] * 15) / 1000000


def terminal_problem(response, event=None, event_label=None):
    if not isinstance(response, dict) or response.get("object") != "response":
        return "upstream_terminal_schema_unknown"
    status = response.get("status")
    if event is not None and (event_label not in (None, event) or {"response.completed": "completed", "response.done": "completed", "response.failed": "failed", "response.incomplete": "incomplete"}.get(event) != status):
        return "upstream_terminal_event_status_mismatch"
    if status == "failed":
        return "upstream_response_failed"
    if status == "incomplete":
        return "upstream_response_incomplete"
    if status != "completed" or response.get("error") is not None or response.get("incomplete_details") is not None:
        return "upstream_terminal_not_completed"
    return None


def known_length_incomplete(response):
    if not isinstance(response, dict) or not isinstance(response.get("incomplete_details"), dict) or response["incomplete_details"].get("reason") != "max_output_tokens" or response.get("error") is not None:
        return False
    usage = response.get("usage")
    if not isinstance(usage, dict) or not isinstance(usage.get("input_tokens_details"), dict):
        return False
    counts = [usage.get("input_tokens"), usage.get("output_tokens"), usage["input_tokens_details"].get("cached_tokens"), usage["input_tokens_details"].get("cache_write_tokens")]
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in counts):
        return False
    inputs, outputs, reads, writes = counts
    if inputs > CONTEXT_LIMIT or outputs > OUTPUT_CEILING or reads + writes > inputs:
        return False
    split = usage["input_tokens_details"].get("cache_write_tokens_details", {})
    return isinstance(split, dict) and split.get("ttl_12h_tokens", 0) == 0 and split.get("ttl_30m_tokens", writes) == writes


class OwnedArm:
    def __init__(self, runtime, registry, roles, token, before, controller, audit, max_calls=300, seconds=7200, soft_usd=3, label=None):
        require(runtime in ACTORS and registry.runtime == runtime and len(roles) == 3 and len(set(roles)) == 3 and all(isinstance(value, str) and value for value in roles), "invalid fixed team")
        require(isinstance(label, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,69}", label) is not None, "owned synthetic label required")
        require(1 <= max_calls <= 300 and 0 < seconds <= 7200 and 0 < soft_usd <= 3, "study bounds expanded")
        self.runtime, self.registry, self.roles = runtime, registry, set(roles)
        self.actor, self.before, self.controller, self.audit = ACTORS[runtime], copy.deepcopy(before), controller, audit
        self._label = label
        self._funded_token, self._alias, self._owner = token, "owned-alias-" + secrets.token_hex(32), "owned-control-" + secrets.token_hex(32)
        self.batch_digest, self.max_calls, self.soft_usd = digest(token), max_calls, soft_usd
        self.deadline, self.condition = time.monotonic() + seconds, threading.Condition(threading.RLock())
        self.queue, self.forwarding, self.closing = deque(), False, False
        self.retired = False
        self.handlers = 0
        self.failure, self.audit_failed, self.slots, self.requests = None, False, {}, []
        self.admitted_ids, self.helper_slots = set(), {}
        self.nonfatal_reviews = []
        self.repairs = 0
        self.disarm_attempted, self.disarm_acknowledged = False, False
        self.record({"type": "arm_bound", "runtime": runtime, "actor": self.actor, "label": label, "batchSha256": self.batch_digest, "model": MODEL, "reasoning": "high", "reasoningSummary": "auto", "verbosity": "low", "contextLimit": CONTEXT_LIMIT, "outputCeiling": OUTPUT_CEILING, "roles": sorted(roles), "studyCapUsd": 48, "actorCapUsd": 20, "softStopUsd": soft_usd, "maxCalls": max_calls, "maxSeconds": seconds, "inflightLimit": 1})

    def record(self, event):
        try:
            self.audit.append(event)
        except OSError:
            with self.condition:
                self.audit_failed, self.failure = True, "audit_unavailable"
                self.condition.notify_all()
            raise PolicyError("audit unavailable") from None

    @property
    def label(self):
        return self._label

    def latch(self, reason):
        with self.condition:
            if self.failure is None:
                self.failure = reason
                if not self.audit_failed:
                    try:
                        self.record({"type": "arm_stopped_for_review", "reason": reason})
                    except PolicyError:
                        pass
            self.condition.notify_all()

    def status(self):
        with self.condition:
            return {"runtime": self.runtime, "actor": self.actor, "reviewRequired": self.failure is not None or self.retired and bool(self.nonfatal_reviews), "fatalReviewRequired": self.failure is not None, "nonfatalReviewObservationCount": len(self.nonfatal_reviews), "stopReason": self.failure, "auditFailed": self.audit_failed, "forwardedRequests": len(self.requests), "activeForward": self.forwarding, "queuedRequests": len(self.queue), "acceptedHandlers": self.handlers, "autonomousSessions": 1 + len(self.slots), "inflightLimit": 1, "closing": self.closing, "retired": self.retired}

    def begin_handler(self):
        with self.condition:
            if self.retired:
                return False
            self.handlers += 1
            return True

    def end_handler(self):
        with self.condition:
            self.handlers -= 1
            self.condition.notify_all()

    def enter(self, body, headers, cancelled):
        ticket = object()
        with self.condition:
            require(not self.failure and not self.closing and len(self.queue) < 16, "arm unavailable")
            self.queue.append(ticket)
            try:
                while self.forwarding or self.queue[0] is not ticket:
                    if cancelled():
                        self.latch("queued_client_cancelled")
                    if time.monotonic() >= self.deadline:
                        self.latch("arm_deadline")
                    require(not self.failure and not self.closing, "arm stopped")
                    self.condition.wait(timeout=0.05)
                require(not self.failure and not self.closing, "arm stopped")
                if cancelled():
                    self.latch("queued_client_cancelled")
                    raise PolicyError("client cancelled")
                state = healthy(self.controller("/status"), self.before, idle=True)
                require(state["actors"][self.actor]["measuredUsd"] - self.before["actors"][self.actor]["measuredUsd"] < self.soft_usd and len(self.requests) < self.max_calls and time.monotonic() < self.deadline, "arm stopping threshold")
                native = self.registry.resolve(headers)
                require(native["root"] == self.registry.root_id, "wrong arm root")
                identity_kind = native.get("identityKind")
                require(identity_kind in ("autonomous", "helper"), "unknown native identity kind")
                if identity_kind == "helper":
                    producer = native.get("producer")
                    require(producer in self.registry.helper_producers and native["helper"] and native["role"] == "helper", "unknown native helper identity")
                    require(native["parent"] in self.admitted_ids and (native["parent"] == self.registry.root_id or native["parent"] in self.slots.values()), "helper outside admitted team")
                    require(producer not in self.helper_slots or self.helper_slots[producer] == native["id"], "duplicate lifetime helper producer")
                else:
                    if native["id"] == self.registry.root_id:
                        require(native["role"] == "lead" and native["parent"] is None, "invalid lead")
                    else:
                        role = native["role"]
                        require(native["parent"] == self.registry.root_id and native["depth"] == 1 and role in self.roles, "nested or unapproved child")
                        require(role not in self.slots or self.slots[role] == native["id"], "duplicate lifetime slot")
                normalized = profile_body(body, native["id"] != self.registry.root_id or identity_kind == "helper")
                if identity_kind == "helper":
                    require(not body.get("tools") and not any(isinstance(item, dict) and item.get("type") == "additional_tools" and item.get("tools") for item in body["input"]), "native helper may not have tools")
                wire = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode()
                require(len(wire) <= MAX_BODY, "normalized request oversized")
                reserve = reservation_bound(normalized, wire)
                require(state["measuredUsd"] + reserve <= 48 and state["actors"][self.actor]["measuredUsd"] + reserve <= 20, "single-call reservation headroom insufficient")
                entry = {"ordinal": len(self.requests) + 1, "requestSha256": hashlib.sha256(wire).hexdigest(), "identitySha256": hashlib.sha256(native["id"].encode()).hexdigest(), "identityKind": identity_kind, "role": native["role"], "helper": native["helper"], "purpose": native["purpose"], "upstreamTerminal": False, "receiptRegistered": False}
                self.record({"type": "before_upstream", **entry, "requiredReservationUsd": reserve})
                if identity_kind == "autonomous":
                    self.admitted_ids.add(native["id"])
                    if native["id"] != self.registry.root_id:
                        self.slots[native["role"]] = native["id"]
                else:
                    self.helper_slots[native["producer"]] = native["id"]
                self.requests.append(entry)
                self.forwarding = True
                return wire, entry
            except Exception as error:
                if not self.audit_failed:
                    try:
                        self.record({"type": "admission_refused", "reason": str(error) if isinstance(error, PolicyError) else type(error).__name__})
                    except PolicyError:
                        pass
                self.latch("admission_policy_or_state_failure")
                raise
            finally:
                self.queue.remove(ticket)
                self.condition.notify_all()

    def finish(self, entry, terminal, disconnected, transport_failed, issue=None, event=None):
        with self.condition:
            outcome = issue or terminal_problem(terminal, event)
            continuation = outcome == "upstream_response_incomplete" and known_length_incomplete(terminal) and not disconnected and not transport_failed
            entry.update(upstreamTerminal=terminal is not None, upstreamOutcome="length_continuation_review" if continuation else outcome or "completed", clientDisconnected=disconnected, transportFailed=transport_failed)
            try:
                usage = terminal.get("usage") if terminal and isinstance(terminal.get("usage"), dict) else {}
                self.record({"type": "after_upstream", "ordinal": entry["ordinal"], "requestSha256": entry["requestSha256"], "terminalObserved": terminal is not None, "outcome": entry["upstreamOutcome"], "terminalEvent": event, "clientDisconnected": disconnected, "transportFailed": transport_failed, "usage": {key: usage[key] for key in ("input_tokens", "output_tokens", "total_tokens") if known(usage.get(key))}})
                if terminal is None or transport_failed:
                    self.latch("upstream_or_terminal_unknown")
                elif continuation:
                    observation = {"ordinal": entry["ordinal"], "identitySha256": entry["identitySha256"], "reason": "known_max_output_incomplete"}
                    self.record({"type": "nonfatal_review_observation", **observation})
                    self.nonfatal_reviews.append(observation)
                elif outcome:
                    self.latch(outcome)
                if disconnected:
                    self.latch("forwarded_client_cancelled")
            finally:
                self.forwarding = False
                self.condition.notify_all()


class WitnessServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = False

    def __init__(self, address, upstream, arm):
        require(address[0] == upstream[0] == "127.0.0.1" and address[1] not in (23128, 23129, 23130), "owned loopback addresses required")
        self.arm, self.upstream = arm, upstream
        super().__init__(address, Handler)

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(30)
        return request, address

    def cli_binding(self):
        require(not self.arm.retired and not self.arm.closing, "owned alias retired")
        return {"providerBase": "http://127.0.0.1:" + str(self.server_port), "requestToken": self.arm._alias, "model": MODEL, "reasoning": "high", "reasoningSummary": "auto", "verbosity": "low", "contextLimit": CONTEXT_LIMIT, "outputCeiling": OUTPUT_CEILING}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, value):
        wire = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(wire)))
        self.end_headers()
        try:
            self.wfile.write(wire)
        except OSError:
            pass

    def authorized(self, token):
        values = self.headers.get_all("Authorization", [])
        return len(values) == 1 and secrets.compare_digest(values[0], "Bearer " + token)

    def do_GET(self):
        if self.path == "/owner/status" and self.authorized(self.server.arm._owner):
            self.reply(200, self.server.arm.status())
            return
        self.reply(403, {"error": "owner authorization required"})

    def do_POST(self):
        arm = self.server.arm
        if self.path == "/owner/stop":
            if not self.authorized(arm._owner):
                return self.reply(403, {"error": "owner authorization required"})
            if not arm.begin_handler():
                return self.reply(409, {"error": "owned scope retired"})
            try:
                arm.latch("owner_requested_stop")
                return self.reply(200, arm.status())
            finally:
                arm.end_handler()
        if self.path != "/v1/responses" or arm.retired or not self.authorized(arm._alias):
            return self.reply(403, {"error": "owned alias required"})
        if not arm.begin_handler():
            return self.reply(403, {"error": "owned alias retired"})
        try:
            self.forward_model(arm)
        finally:
            arm.end_handler()

    def forward_model(self, arm):
        try:
            require(not self.headers.get("Transfer-Encoding") and self.headers.get("Content-Encoding", "identity") == "identity", "unsupported transfer schema")
            length = int(self.headers.get("Content-Length", "0"))
            require(0 < length <= MAX_BODY, "request body bound")
            data = self.rfile.read(length)
            require(len(data) == length, "incomplete body")
            body = json.loads(data, object_pairs_hook=unique_object)
            def cancelled():
                try:
                    return bool(select.select([self.connection], [], [], 0)[0]) and not self.connection.recv(1, socket.MSG_PEEK)
                except OSError:
                    return True
            wire, entry = arm.enter(body, self.headers, cancelled)
        except (PolicyError, ValueError, TypeError, OSError):
            arm.latch("request_or_policy_failure")
            return self.reply(400, {"error": "owned arm stopped for review"})
        connection = http.client.HTTPConnection(*self.server.upstream, timeout=650)
        sent, disconnected, transport_failed, terminal, buffer = False, False, False, None, b""
        terminal_event, event_label, issue, terminal_count = None, None, None, 0
        try:
            connection.request("POST", "/v1/responses", body=wire, headers={**{key: value for key, value in self.headers.items() if key.lower() not in HOP | {"content-type"}}, "Authorization": "Bearer " + arm._funded_token, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            sent = True
            content_type = response.getheader("Content-Type", "")
            while chunk := response.read1(65536):
                if cancelled():
                    disconnected = True
                buffer += chunk
                require(len(buffer) <= MAX_BODY, "upstream frame bound")
                if "text/event-stream" in content_type:
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        line = line.rstrip(b"\r")
                        if not line:
                            event_label = None
                        if line.startswith(b"event:"):
                            event_label = line[6:].strip().decode("utf-8", errors="replace")
                        if line.startswith(b"data:"):
                            try:
                                event = json.loads(line[5:])
                                kind = event.get("type") if isinstance(event, dict) else None
                                kinds = ("response.completed", "response.done", "response.incomplete", "response.failed")
                                if kind in kinds:
                                    terminal_count += 1
                                    terminal_event = kind
                                    terminal = event.get("response") if isinstance(event.get("response"), dict) else None
                                    issue = issue or terminal_problem(terminal, kind, event_label)
                                    if terminal_count != 1:
                                        issue = "multiple_upstream_terminals"
                                elif event_label in kinds or kind == "error":
                                    issue = issue or "upstream_terminal_event_status_mismatch"
                            except ValueError:
                                pass
                if not disconnected:
                    try:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    except OSError:
                        disconnected = True
            if "text/event-stream" not in content_type:
                try:
                    value = json.loads(buffer)
                    terminal = value if isinstance(value, dict) and value.get("object") == "response" else None
                except ValueError:
                    pass
            if response.status != 200:
                transport_failed = True
        except (OSError, http.client.HTTPException, PolicyError):
            transport_failed = True
            if not sent:
                self.reply(502, {"error": "upstream transport unknown; not retried"})
        finally:
            connection.close()
            try:
                arm.finish(entry, terminal, disconnected, transport_failed, issue, terminal_event)
            except PolicyError:
                pass
            self.close_connection = True


class OwnedSupervisor:
    """One pair; injected controller and immutable receipt reader only."""
    def __init__(self, controller, receipts, output, quiesced=None):
        self.controller, self.receipts, self.output = controller, receipts, Path(output)
        self.quiesced = quiesced or (lambda: False)
        self.used, self.active = set(), None
        self.failed = False
        self.orphaned_token = None
        self.lock = threading.RLock()

    def begin(self, runtime, label, registry, roles, **limits):
        with self.lock:
            return self._begin(runtime, label, registry, roles, **limits)

    def _begin(self, runtime, label, registry, roles, **limits):
        require(not self.failed and self.active is None and runtime in ACTORS and runtime not in self.used, "arm already owned, failed or used")
        require(isinstance(label, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,69}", label) is not None, "synthetic label required")
        require(registry.runtime == runtime and len(roles) == 3 and len(set(roles)) == 3 and all(isinstance(value, str) and value for value in roles), "invalid fixed team")
        require(set(limits) <= {"max_calls", "seconds", "soft_usd"}, "unreviewed arm limit")
        before = healthy(self.controller("/status"), idle=True)
        require(before.get("batchCallsRemaining") == 0, "another paid scope is open")
        require(before["actors"][ACTORS[runtime]]["measuredUsd"] + limits.get("soft_usd", 3) <= 20, "cumulative actor capacity insufficient")
        require(1 <= limits.get("max_calls", 300) <= 300 and 0 < limits.get("seconds", 7200) <= 7200 and 0 < limits.get("soft_usd", 3) <= 3, "study bounds expanded")
        audit = Audit(self.output / runtime / "witness-audit.jsonl")
        audit.append({"type": "supervisor_preflight", "runtime": runtime, "actor": ACTORS[runtime], "studyCapUsd": 48, "actorCapUsd": 20})
        self.failed = True
        response = self.controller("/control", {"actor": ACTORS[runtime], "label": label, "calls": limits.get("max_calls", 300)})
        token = response.get("requestToken") if isinstance(response, dict) else None
        require(isinstance(token, str) and token, "ambiguous arm admission; never retry")
        self.used.add(runtime)
        try:
            self.active = OwnedArm(runtime, registry, roles, token, before, self.controller, audit, label=label, **limits)
        except Exception:
            self.orphaned_token = token
            try:
                healthy(self.controller("/disarm", {"requestToken": token}), before, idle=True)
                self.orphaned_token = None
            except Exception:
                pass
            raise
        self.failed = False
        return self.active

    def repair(self):
        with self.lock:
            require(self.active is not None and not self.active.failure and self.active.repairs == 0, "repair limit or arm failure")
            self.active.repairs = 1
            self.active.record({"type": "same_lead_session_repair", "index": 1})

    def retire_disposition(self, arm, result):
        with arm.condition:
            if arm.forwarding or arm.queue or arm.handlers:
                arm.latch("closure_handlers_pending")
            result["reviewRequired"] = result["reviewRequired"] or arm.failure is not None
            result["nonfatalReviewObservationCount"] = len(arm.nonfatal_reviews)
            result["nonfatalReviewObservations"] = list(arm.nonfatal_reviews)
            result["reviewRequired"] = result["reviewRequired"] or bool(arm.nonfatal_reviews)
            result["stopReason"] = arm.failure
            self.failed = self.failed or result["reviewRequired"]
            if result["settlementComplete"]:
                arm._funded_token = None
                arm.retired = True
                self.active = None

    def close(self, timeout=700):
        with self.lock:
            return self._close(timeout)

    def _close(self, timeout):
        arm = self.active
        require(arm is not None, "no owned arm")
        with arm.condition:
            arm.closing = True
            arm.condition.notify_all()
        result = {"runtime": arm.runtime, "allChargesRetained": True, "settlementComplete": False, "reviewRequired": True, "measuredUsd": None, "controllerUsageThroughClosure": None, "usageAccountingStatus": "unknown_until_owned_scope_closure"}
        try:
            if not arm.disarm_attempted:
                arm.disarm_attempted = True
                self.controller("/disarm", {"requestToken": arm._funded_token})
                arm.disarm_acknowledged = True
            require(arm.disarm_acknowledged, "prior disarm outcome unknown; do not retry mutation")
            deadline = time.monotonic() + timeout
            while True:
                state = healthy(self.controller("/status"), arm.before)
                with arm.condition:
                    if state["active"] == 0 and state["reservedUsd"] == 0 and not arm.forwarding and not arm.queue and arm.handlers == 0:
                        break
                require(time.monotonic() < deadline, "owned closure remains unknown")
                time.sleep(0.05)
            require(state.get("batchCallsRemaining") == 0, "owned scope did not close")
            result.update(controllerUsageThroughClosure={"providerRequests": state["attempts"] - arm.before["attempts"], "measuredUsd": state["actors"][arm.actor]["measuredUsd"] - arm.before["actors"][arm.actor]["measuredUsd"]}, usageAccountingStatus="settled_totals_pending_receipt_join")
            pending = defaultdict(deque)
            for request in arm.requests:
                pending[request["requestSha256"]].append(request)
            receipts = [row for row in self.receipts() if row.get("batchSha256") == arm.batch_digest]
            sequences = set()
            for row in receipts:
                require(row.get("actor") == arm.actor and row.get("label") == arm.label and isinstance(row.get("seq"), int) and row["seq"] > arm.before["attempts"] and row["seq"] not in sequences and pending[row.get("requestSha256")], "receipt scope or request join invalid")
                request = pending[row["requestSha256"]].popleft()
                require(known(row.get("measuredUsd")), "unknown receipt price")
                sequences.add(row["seq"])
                if request["receiptRegistered"]:
                    require(request["receiptSequence"] == row["seq"] and request["measuredUsd"] == row["measuredUsd"], "previous receipt changed")
                    continue
                request["receiptRegistered"] = True
                request.update(receiptSequence=row["seq"], measuredUsd=row["measuredUsd"])
                arm.record({"type": "receipt_registered", "ordinal": request["ordinal"], "label": arm.label, "meterReceiptSequence": row["seq"], "requestSha256": request["requestSha256"], "measuredUsd": row["measuredUsd"], "role": request["role"], "helper": request["helper"], "purpose": request["purpose"]})
            require(all(request["receiptRegistered"] for request in arm.requests), "forwarded request lacks authoritative receipt")
            cost = state["actors"][arm.actor]["measuredUsd"] - arm.before["actors"][arm.actor]["measuredUsd"]
            require(abs(cost - math.fsum(row["measuredUsd"] for row in receipts)) <= 1e-7 and state["attempts"] - arm.before["attempts"] == len(receipts), "authoritative usage reconciliation mismatch")
            result.update(settlementComplete=True, measuredUsd=cost, providerRequests=len(receipts), reviewRequired=arm.failure is not None, stopReason=arm.failure, usageAccountingStatus="settled_and_receipts_reconciled", unknownPurposeRequests=sum(request["purpose"] == "root_or_helper" for request in arm.requests))
            require(self.quiesced() is True, "owned runtime and descendants not confirmed quiescent")
            result["runtimeQuiesced"] = True
            transcripts = arm.registry.collect(self.output / arm.runtime / "private-transcripts")
            require(transcripts.get("complete") is True, "descendant transcript coverage incomplete")
            result["transcripts"] = transcripts
            with arm.condition:
                while arm.forwarding or arm.queue or arm.handlers:
                    require(time.monotonic() < deadline, "accepted handlers remain during closure")
                    arm.condition.wait(timeout=0.05)
                result.update(reviewRequired=arm.failure is not None or bool(arm.nonfatal_reviews), stopReason=arm.failure)
                arm.record({"type": "owned_scope_closed", "providerRequests": len(receipts), "measuredUsd": cost, "reviewRequired": result["reviewRequired"], "transcriptCoverageComplete": transcripts["complete"]})
                self.retire_disposition(arm, result)
        except Exception as error:
            arm.latch("closure_or_accounting_unknown")
            result.update(reviewRequired=True, stopReason=arm.failure, closureFailureType=type(error).__name__)
        finally:
            self.retire_disposition(arm, result)
        try:
            (self.output / arm.runtime / "closure.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        except OSError:
            self.failed = True
            arm.latch("closure_output_unavailable")
            result.update(reviewRequired=True, stopReason=arm.failure)
        return result
