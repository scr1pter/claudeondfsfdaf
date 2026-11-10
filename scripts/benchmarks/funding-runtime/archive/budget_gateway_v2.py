"""Owner-authorized $48 study; $20 per SaaS runtime, including all helpers.

The provider key exists only in this process. Every forwarding attempt has a
durable admission and immutable batch/actor identity. This is private benchmark
instrumentation, not Vector application code.
"""
import argparse
import getpass
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import threading
import time
import warnings

from budget_gateway import MODEL, SOURCES, count, digest

STUDY_LIMIT = 48.0
ACTOR_LIMITS = {"diagnostics": 8.0, "saas-vector": 20.0, "saas-codex": 20.0}
CONTEXT = 1_050_000
OUTPUT = 32_000
MAX_BODY = 8_000_000
RATES = {"input": 2.0, "read": .1, "write30m": 2.5, "write12h": 5.0, "output": 10.0}


class AdmissionError(ValueError):
    pass


def prepare(body):
    if not isinstance(body, dict) or body.get("model") != MODEL:
        raise AdmissionError("only the approved model is permitted")
    if body.get("service_tier", "default") not in ("default", "standard"):
        raise AdmissionError("only standard processing is permitted")
    if any(body.get(key) for key in ("background", "previous_response_id", "conversation", "prompt", "context_management")):
        raise AdmissionError("stored or managed context is outside this benchmark")
    tools = body.get("tools", [])
    if not isinstance(tools, list) or len(tools) > 128 or any(not isinstance(tool, dict) or tool.get("type") not in ("function", "custom") for tool in tools):
        raise AdmissionError("hosted tools or excessive tool counts are not permitted")
    images = False
    def inspect(value):
        nonlocal images
        if isinstance(value, list):
            for item in value:
                inspect(item)
        if not isinstance(value, dict):
            return
        kind = value.get("type")
        if kind in ("item_reference", "compaction", "input_audio", "input_file", "file", "video"):
            raise AdmissionError("unsupported opaque or non-image input")
        if kind == "input_image":
            images = True
            if not isinstance(value.get("image_url"), str) or not value["image_url"].startswith("data:image/"):
                raise AdmissionError("only inline benchmark screenshots are permitted")
        for key in ("prompt_cache_options", "prompt_cache_breakpoint"):
            if key in value and (not isinstance(value[key], dict) or value[key].get("ttl", "30m") != "30m"):
                raise AdmissionError("only 30-minute cache writes are admitted")
        for item in value.values():
            inspect(item)
    inspect(body)
    allowance = body.get("max_output_tokens", OUTPUT)
    if not count(allowance) or allowance < 1:
        raise AdmissionError("invalid output allowance")
    body["max_output_tokens"] = min(allowance, OUTPUT)
    body["service_tier"] = "default"
    body["store"] = False
    wire = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    if len(wire) > MAX_BODY:
        raise AdmissionError("request exceeds the benchmark transport bound")
    # Inline image compression does not bound vision tokens. Reserve the whole
    # verified model context in that case. Text uses a conservative UTF-8 bound,
    # framing headroom and the context ceiling. The highest ADMITTED write/input
    # rate is $5/M (long-context, 30m); output is at most $15/M.
    input_bound = CONTEXT if images else min(CONTEXT, len(wire) + 32_768 + len(tools) * 256)
    reserve = (input_bound * 5 + body["max_output_tokens"] * 15) / 1_000_000
    return wire, reserve


def price(usage):
    if not isinstance(usage, dict):
        raise ValueError("missing usage")
    inputs, outputs = usage.get("input_tokens"), usage.get("output_tokens")
    details = usage.get("input_tokens_details")
    if not count(inputs) or not count(outputs) or inputs > CONTEXT or not isinstance(details, dict):
        raise ValueError("invalid or partial usage")
    reads, writes = details.get("cached_tokens"), details.get("cache_write_tokens")
    if not count(reads) or not count(writes) or reads + writes > inputs:
        raise ValueError("invalid cache usage")
    split = details.get("cache_write_tokens_details", {})
    if not isinstance(split, dict) or split.get("ttl_12h_tokens", 0) != 0 or split.get("ttl_30m_tokens", writes) != writes:
        raise ValueError("unexpected cache lifetime")
    factor = 2 if inputs > 272_000 else 1
    output_factor = 1.5 if factor == 2 else 1
    return ((inputs - reads - writes) * 2 * factor + reads * .1 * factor + writes * 2.5 * factor + outputs * 10 * output_factor) / 1_000_000


class Budget:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.condition = threading.Condition()
        self.batches = {}
        self.pending = {}
        self.settled = set()
        self.spent = 0.0
        self.actor_spent = {actor: 0.0 for actor in ACTOR_LIMITS}
        self.reserved = 0.0
        self.actor_reserved = {actor: 0.0 for actor in ACTOR_LIMITS}
        self.halted = None
        self.persistence_failed = False
        self.seq = 0
        status_file = self.directory / "status.json"
        old = json.loads(status_file.read_text()) if status_file.exists() else None
        receipts_file = self.directory / "receipts.jsonl"
        receipts = [json.loads(line) for line in receipts_file.read_text().splitlines() if line] if receipts_file.exists() else []
        for receipt in receipts:
            seq, actual = receipt.get("seq"), receipt.get("measuredUsd")
            actor = receipt.get("actor", "diagnostics")
            if not count(seq) or seq == 0 or seq in self.settled or actor not in ACTOR_LIMITS or not isinstance(actual, (float, int)) or isinstance(actual, bool) or not math.isfinite(actual) or actual < 0:
                raise ValueError("ledger contains an unresolved or invalid settlement")
            self.settled.add(seq)
            self.seq = max(self.seq, seq)
            self.spent += actual
            self.actor_spent[actor] += actual
        if self.settled != set(range(1, self.seq + 1)):
            raise ValueError("settlement sequence has a gap")
        admissions_file = self.directory / "admissions-v2.jsonl"
        admissions = [json.loads(line) for line in admissions_file.read_text().splitlines() if line] if admissions_file.exists() else []
        if any(row["seq"] not in self.settled for row in admissions):
            raise ValueError("unmatched durable admission: its reservation must not be released")
        if old and (old.get("active") or old.get("reservedUsd") or old.get("halted") or old.get("attempts") != self.seq or abs(old.get("measuredUsd", -1) - self.spent) > 1e-8):
            raise ValueError("prior gateway is active or its ledger does not reconcile")
        if self.spent > STUDY_LIMIT or any(self.actor_spent[actor] > ACTOR_LIMITS[actor] for actor in ACTOR_LIMITS):
            raise ValueError("ledger is already outside the authorized limits")

    def append(self, name, value):
        try:
            with (self.directory / name).open("a", encoding="utf-8") as file:
                file.write(json.dumps(value, ensure_ascii=False) + "\n")
                file.flush()
                os.fsync(file.fileno())
        except OSError:
            self.persistence_halt()
            raise

    def persistence_halt(self):
        with self.condition:
            self.persistence_failed = True
            self.halted = "persistence failure; all unresolved reservations retained and new spending halted"
            self.condition.notify_all()

    def status(self):
        value = {"limitUsd": STUDY_LIMIT, "measuredUsd": self.spent, "reservedUsd": self.reserved, "remainingAdmissionUsd": STUDY_LIMIT - self.spent - self.reserved, "halted": self.halted, "attempts": self.seq, "active": len(self.pending), "batchCallsRemaining": sum(batch["left"] for batch in self.batches.values() if batch["open"]), "actors": {actor: {"limitUsd": ACTOR_LIMITS[actor], "measuredUsd": self.actor_spent[actor], "reservedUsd": self.actor_reserved[actor]} for actor in ACTOR_LIMITS}}
        temp = self.directory / "status.tmp"
        try:
            temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
            os.replace(temp, self.directory / "status.json")
        except OSError:
            self.persistence_halt()
            raise
        return value

    def arm(self, actor, label, calls):
        with self.condition:
            if self.halted or actor not in ACTOR_LIMITS or not isinstance(label, str) or not 1 <= len(label) <= 120 or not count(calls) or not 1 <= calls <= 500:
                raise AdmissionError("invalid batch or halted ledger")
            token = "local-run-" + secrets.token_hex(24)
            self.batches[token] = {"actor": actor, "label": label, "left": calls, "open": True}
            self.status()
            return {"requestToken": token, "actor": actor, "label": label, "status": self.status()}

    def disarm(self, token=None):
        with self.condition:
            for key, batch in self.batches.items():
                if token is None or key == token:
                    batch["open"] = False
                    batch["left"] = 0
            self.condition.notify_all()
            return self.status()

    def admit(self, token, reserve, metadata):
        with self.condition:
            deadline = time.monotonic() + 60
            while True:
                batch = self.batches.get(token)
                if self.halted or not batch or not batch["open"] or batch["left"] <= 0:
                    raise AdmissionError("no live authorized batch")
                actor = batch["actor"]
                if not math.isfinite(reserve) or reserve <= 0:
                    raise AdmissionError("invalid reservation")
                available = self.spent + self.reserved + reserve <= STUDY_LIMIT and self.actor_spent[actor] + self.actor_reserved[actor] + reserve <= ACTOR_LIMITS[actor]
                if available:
                    break
                temporary = self.reserved > 0 and self.spent + reserve <= STUDY_LIMIT and self.actor_spent[actor] + reserve <= ACTOR_LIMITS[actor]
                if not temporary or time.monotonic() >= deadline:
                    raise AdmissionError("cannot reserve the next call inside the study and runtime limits")
                self.condition.wait(timeout=min(1, deadline - time.monotonic()))
            attempt = {**metadata, "seq": self.seq + 1, "actor": actor, "label": batch["label"], "batchSha256": digest(token), "reservedUsd": reserve, "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            self.append("admissions-v2.jsonl", attempt)
            self.seq += 1
            batch["left"] -= 1
            self.pending[self.seq] = attempt
            self.reserved += reserve
            self.actor_reserved[actor] += reserve
            self.status()
            return attempt

    def settle(self, seq, result):
        with self.condition:
            if self.persistence_failed:
                return False
            attempt = self.pending.get(seq)
            if attempt is None:
                return False
            actual = result.get("measuredUsd")
            actor, reserve = attempt["actor"], attempt["reservedUsd"]
            known = isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isfinite(actual) and actual >= 0
            receipt = {**attempt, **result, "cumulativeMeasuredUsd": self.spent + (actual if known else 0)}
            if not known:
                receipt["measuredUsd"] = None
            # Do not release a reservation until its settlement is durable.
            # A failed fsync can leave ambiguous bytes; halt instead of retrying
            # the append and creating a duplicate receipt.
            self.append("receipts.jsonl", receipt)
            self.pending.pop(seq)
            if not known:
                self.halted = "uncertain settlement; reservation retained and further spending halted"
            else:
                self.reserved -= reserve
                self.actor_reserved[actor] -= reserve
                self.spent += actual
                self.actor_spent[actor] += actual
                if actual > reserve or self.spent + self.reserved > STUDY_LIMIT or self.actor_spent[actor] + self.actor_reserved[actor] > ACTOR_LIMITS[actor]:
                    self.halted = "settlement exceeded conservative admission bound"
            self.settled.add(seq)
            self.status()
            self.condition.notify_all()
            return True


def handler(budget, api_key, controller_token, upstream_factory=None):
    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def result(self, code, value):
            data = json.dumps(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def token(self):
            return self.headers.get("Authorization", "").removeprefix("Bearer ")

        def do_GET(self):
            if self.path != "/status" or self.token() != controller_token:
                return self.result(403, {"error": "controller authorization required"})
            with budget.condition:
                self.result(200, budget.status())

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.result(400, {"error": {"message": "invalid benchmark body length"}})
            try:
                body = json.loads(self.rfile.read(length))
                if self.path in ("/control", "/disarm"):
                    if self.token() != controller_token:
                        return self.result(403, {"error": "controller authorization required"})
                    return self.result(200, budget.arm(body.get("actor"), body.get("label"), body.get("calls")) if self.path == "/control" else budget.disarm(body.get("requestToken")))
                if self.path != "/v1/responses":
                    return self.result(404, {"error": "only Responses is supported"})
                requested_output = body.get("max_output_tokens")
                wire, reserve = prepare(body)
                reasoning = body.get("reasoning") if isinstance(body.get("reasoning"), dict) else {}
                attempt = budget.admit(self.token(), reserve, {"model": MODEL, "requestSha256": hashlib.sha256(wire).hexdigest(), "requestBytes": len(wire), "requestedMaxOutputTokens": requested_output, "maxOutputTokens": body["max_output_tokens"], "requestedReasoningEffort": reasoning.get("effort"), "cacheKeySha256": digest(body.get("prompt_cache_key")), "toolsSha256": digest(body.get("tools")), "inputItemSha256": [digest(item) for item in body.get("input", [])] if isinstance(body.get("input"), list) else [], "rates": RATES, "sources": SOURCES})
            except (ValueError, TypeError, AttributeError):
                return self.result(400, {"error": {"message": "benchmark admission refused; inspect local status", "type": "benchmark_admission"}})
            observation = {"measuredUsd": None}
            connection = upstream_factory() if upstream_factory else http.client.HTTPSConnection("api.openai.com", timeout=600)
            started = time.monotonic()
            disconnected = False
            def terminal(value):
                if not isinstance(value, dict):
                    return
                observation.update({"responseID": value.get("id"), "responseStatus": value.get("status"), "serviceTier": value.get("service_tier"), "usage": value.get("usage")})
                if value.get("service_tier") not in (None, "default", "standard"):
                    raise ValueError("unexpected processing tier")
                observation["measuredUsd"] = price(value.get("usage"))
                observation["elapsedMs"] = round((time.monotonic() - started) * 1000, 1)
                budget.settle(attempt["seq"], observation)
            try:
                connection.request("POST", "/v1/responses", body=wire, headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"})
                response = connection.getresponse()
                observation["httpStatus"] = response.status
                if response.status != 200:
                    response.read()
                    return self.result(response.status, {"error": {"message": "provider refused benchmark request; raw error withheld", "type": "provider_error"}})
                content_type = response.getheader("Content-Type", "application/json")
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Connection", "close")
                self.end_headers()
                buffer = b""
                while chunk := response.read1(65536):
                    buffer += chunk
                    if "text/event-stream" in content_type:
                        while b"\n" in buffer:
                            line, buffer = buffer.split(b"\n", 1)
                            if not line.startswith(b"data:"):
                                continue
                            try:
                                event = json.loads(line[5:].strip())
                            except ValueError:
                                continue
                            if event.get("type") in ("response.completed", "response.incomplete", "response.failed", "response.done"):
                                terminal(event.get("response"))
                    # Settle terminal usage BEFORE the CLI sees completion. A
                    # socket tail is not a reason to reject its next model call.
                    if not disconnected:
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            disconnected = True
                if "text/event-stream" not in content_type:
                    terminal(json.loads(buffer))
            except (OSError, ValueError, http.client.HTTPException) as error:
                observation["failureKind"] = type(error).__name__
            finally:
                connection.close()
                observation["elapsedMs"] = round((time.monotonic() - started) * 1000, 1)
                budget.settle(attempt["seq"], observation)
    return Gateway


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=23128)
    args = parser.parse_args()
    directory = Path(args.directory)
    config = json.loads((directory / "gateway-config.json").read_text(encoding="utf-8"))
    approved = json.loads((directory / "owner-budget.json").read_text(encoding="utf-8"))
    if approved.get("authorizedStudyMaximumUsd") != STUDY_LIMIT:
        raise SystemExit("the configured owner authorization does not match this reviewed $48 study")
    budget = Budget(directory)
    # Acquire a process lock before accepting a key. The old v1 gateway must
    # already be drained/stopped; it predates this lock.
    import msvcrt
    ledger_lock = (directory / "gateway-v2.lock").open("a+b")
    ledger_lock.write(b"0")
    ledger_lock.flush()
    ledger_lock.seek(0)
    msvcrt.locking(ledger_lock.fileno(), msvcrt.LK_NBLCK, 1)
    print(f"Vector benchmark study: $48 TOTAL; already measured ${budget.spent:.6f}.")
    print("Next SaaS phase: $20 Vector + $20 Codex. Other diagnostics share the remaining $8.")
    print("The key stays only in this process. It is never written to a file.")
    print("No paid request is admitted until a controller explicitly arms a labelled runtime batch.")
    warnings.simplefilter("error", getpass.GetPassWarning)
    api_key = getpass.getpass("Re-enter the OpenAI API key for the account YOU want billed (hidden): ").strip()
    if not api_key:
        raise SystemExit("No key supplied; nothing sent.")
    budget.status()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(budget, api_key, config["localToken"]))
    print(f"Ready on 127.0.0.1:{args.port}; no paid batch is armed. Leave this window open.")
    server.serve_forever()


if __name__ == "__main__":
    main()
