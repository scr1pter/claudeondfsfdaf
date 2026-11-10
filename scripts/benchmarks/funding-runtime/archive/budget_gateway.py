"""Private, loopback-only live benchmark gateway. Never persists a provider key.

The owner types the key into getpass in a separate console. Only fixed-model
Responses requests are forwarded. Every attempt reserves a conservative bound
before forwarding; missing/partial receipts stop subsequent paid requests.
This is a benchmark instrument, not application/runtime code.
"""
import argparse
import getpass
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODEL = "gpt-6.1-sol"
MAX_BODY = 100_000
OUTPUT_CAP = 8192
RATES = {"input": 2.0, "read": 0.1, "write30m": 2.5, "write12h": 5.0, "output": 10.0}
SOURCES = ["https://developers.openai.com/api/docs/models/gpt-6.1-sol", "https://developers.openai.com/api/docs/guides/prompt-caching"]


def count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def price(usage):
    if not isinstance(usage, dict):
        raise ValueError("missing usage")
    input_count = usage.get("input_tokens")
    output_count = usage.get("output_tokens")
    details = usage.get("input_tokens_details")
    if not count(input_count) or not count(output_count) or not isinstance(details, dict):
        raise ValueError("partial usage")
    read = details.get("cached_tokens")
    write = details.get("cache_write_tokens")
    if not count(read) or not count(write):
        raise ValueError("missing cache usage")
    split = details.get("cache_write_tokens_details", {})
    short = split.get("ttl_30m_tokens", write)
    long = split.get("ttl_12h_tokens", 0)
    if not count(short) or not count(long) or short + long != write:
        raise ValueError("inconsistent write usage")
    ordinary = input_count - read - write
    if ordinary < 0:
        raise ValueError("overlapping cache usage")
    # Requests over the short-context threshold are rejected conservatively by
    # admission; refuse an unexpectedly long-context receipt rather than underprice.
    if input_count > 272_000:
        raise ValueError("unexpected long context")
    return (ordinary * RATES["input"] + read * RATES["read"] + short * RATES["write30m"] + long * RATES["write12h"] + output_count * RATES["output"]) / 1_000_000


def prepare(body):
    if body.get("model") != MODEL:
        raise ValueError("only the approved benchmark model is allowed")
    if body.get("service_tier", "default") not in ("default", "standard"):
        raise ValueError("only standard processing is allowed")
    if body.get("background") or body.get("previous_response_id") or body.get("conversation"):
        raise ValueError("hidden server-side context is not permitted")
    if body.get("prompt"):
        raise ValueError("stored prompts are not permitted")
    def inspect(value):
        if isinstance(value, list):
            for item in value:
                inspect(item)
        if not isinstance(value, dict):
            return
        if value.get("type") in ("input_image", "input_audio", "input_file", "image_url", "file", "video"):
            raise ValueError("only text benchmark inputs are permitted")
        if value.get("type") == "item_reference":
            raise ValueError("stored input references are not permitted")
        for name in ("prompt_cache_options", "prompt_cache_breakpoint"):
            if name in value and value[name].get("ttl", "30m") != "30m":
                raise ValueError("this round permits only default 30m cache writes")
        for item in value.values():
            inspect(item)
    inspect(body)
    if len(body.get("tools", [])) > 64:
        raise ValueError("benchmark tool count exceeded")
    if any(tool.get("type") not in ("function", "custom") for tool in body.get("tools", [])):
        raise ValueError("paid hosted tools are not permitted")
    requested = body.get("max_output_tokens", OUTPUT_CAP)
    if not count(requested) or requested < 1:
        raise ValueError("invalid output allowance")
    body["max_output_tokens"] = min(requested, OUTPUT_CAP)
    body["service_tier"] = "default"
    body["store"] = False
    wire = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    if len(wire) > MAX_BODY:
        raise ValueError("request exceeds benchmark input bound")
    # UTF-8 bytes conservatively upper-bound visible byte-level tokens. Add a
    # large rendering/system overhead and use the higher 12h-write rate. This
    # is admission headroom, never advertised as actual billed usage.
    reserve = ((len(wire) + 16_384) * RATES["write12h"] + body["max_output_tokens"] * RATES["output"]) / 1_000_000
    return wire, reserve


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Budget:
    def __init__(self, directory, limit):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        if (self.directory / "status.json").exists() or (self.directory / "receipts.jsonl").exists():
            raise ValueError("existing spending ledger: refusing to reset or restart this round")
        self.limit = limit
        self.spent = 0.0
        self.reserved = 0.0
        self.stopped = None
        self.seq = 0
        self.active = 0
        self.label = "unlabelled"
        self.batch_left = 0
        self.lock = threading.Lock()
        self.write_status()

    def write_status(self):
        value = {"limitUsd": self.limit, "measuredUsd": self.spent, "reservedUsd": self.reserved, "remainingAdmissionUsd": self.limit - self.spent - self.reserved, "halted": self.stopped, "attempts": self.seq, "active": self.active, "batchCallsRemaining": self.batch_left, "label": self.label}
        target = self.directory / "status.json"
        temp = self.directory / "status.tmp"
        temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
        os.replace(temp, target)
        return value

    def arm(self, label, calls):
        with self.lock:
            if self.active or self.stopped:
                raise ValueError("gateway busy or halted")
            if not isinstance(label, str) or not label or len(label) > 100 or not count(calls) or not 0 <= calls <= 20:
                raise ValueError("invalid labelled batch")
            self.label, self.batch_left = label, calls
            return self.write_status()

    def disarm(self):
        with self.lock:
            self.batch_left = 0
            return self.write_status()

    def admit(self, reserve):
        with self.lock:
            if self.stopped or self.batch_left <= 0 or self.active:
                raise ValueError("no armed batch, active call, or halted budget")
            if not math.isfinite(reserve) or reserve <= 0 or self.spent + self.reserved + reserve > self.limit:
                raise ValueError("insufficient reserved budget")
            self.seq += 1
            self.active += 1
            self.batch_left -= 1
            self.reserved += reserve
            self.write_status()
            return self.seq, self.label

    def settle(self, receipt, reserve):
        with self.lock:
            actual = receipt.get("measuredUsd")
            if actual is None:
                self.stopped = "missing or uncertain receipt; reservation retained"
            else:
                self.reserved -= reserve
                self.spent += actual
                if actual > reserve or self.spent + self.reserved > self.limit:
                    self.stopped = "receipt exceeded conservative admission bound"
            self.active -= 1
            receipt["cumulativeMeasuredUsd"] = self.spent
            with (self.directory / "receipts.jsonl").open("a", encoding="utf-8") as file:
                file.write(json.dumps(receipt, ensure_ascii=False) + "\n")
                file.flush()
                os.fsync(file.fileno())
            self.write_status()


def handler(budget, api_key, local_token):
    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def result(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            return self.headers.get("Authorization") == "Bearer " + local_token

        def do_GET(self):
            if not self.authorized() or self.path != "/status":
                return self.result(404, {"error": "not found"})
            with budget.lock:
                self.result(200, budget.write_status())

        def do_POST(self):
            if not self.authorized():
                return self.result(403, {"error": "benchmark authorization required"})
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.result(400, {"error": "invalid input length"})
            try:
                body = json.loads(self.rfile.read(length))
                if self.path == "/disarm":
                    return self.result(200, budget.disarm())
                if self.path == "/control":
                    return self.result(200, budget.arm(body.get("label"), body.get("calls")))
                if self.path != "/v1/responses":
                    return self.result(404, {"error": "only Responses is supported"})
                wire, reserve = prepare(body)
                seq, label = budget.admit(reserve)
            except (ValueError, TypeError, AttributeError) as error:
                return self.result(400, {"error": {"message": str(error), "type": "benchmark_admission"}})
            receipt = {"seq": seq, "label": label, "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": MODEL, "reservedUsd": reserve, "requestSha256": hashlib.sha256(wire).hexdigest(), "cacheKeySha256": digest(body.get("prompt_cache_key")), "instructionsSha256": digest(body.get("instructions")), "toolsSha256": digest(body.get("tools")), "inputItemSha256": [digest(item) for item in body.get("input", [])] if isinstance(body.get("input"), list) else [digest(body.get("input"))], "maxOutputTokens": body["max_output_tokens"], "requestBytes": len(wire), "rates": RATES, "sources": SOURCES, "measuredUsd": None}
            connection = http.client.HTTPSConnection("api.openai.com", timeout=180)
            started = time.monotonic()
            try:
                connection.request("POST", "/v1/responses", body=wire, headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"})
                response = connection.getresponse()
                receipt["httpStatus"] = response.status
                if response.status != 200:
                    # Provider errors can echo partial credential material. Never
                    # persist or forward their body.
                    response.read()
                    return self.result(response.status, {"error": {"message": "provider rejected benchmark request; see status code", "type": "provider_error"}})
                content_type = response.getheader("Content-Type", "application/json")
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Connection", "close")
                self.end_headers()
                buffer = b""
                terminal = None
                disconnected = False
                while data := response.read1(65536):
                    if not disconnected:
                        try:
                            self.wfile.write(data)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            # Continue receiving the receipt for a possibly billed
                            # call even when the CLI cancels its HTTP connection.
                            disconnected = True
                    buffer += data
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
                                terminal = event.get("response")
                if "text/event-stream" not in content_type:
                    terminal = json.loads(buffer)
                if not isinstance(terminal, dict):
                    raise ValueError("no terminal provider receipt")
                receipt["responseID"] = terminal.get("id")
                receipt["responseStatus"] = terminal.get("status")
                receipt["serviceTier"] = terminal.get("service_tier")
                receipt["usage"] = terminal.get("usage")
                if terminal.get("service_tier") not in (None, "default", "standard"):
                    raise ValueError("unexpected processing tier")
                receipt["measuredUsd"] = price(receipt["usage"])
            except (OSError, ValueError, http.client.HTTPException) as error:
                receipt["failureKind"] = type(error).__name__
            finally:
                connection.close()
                receipt["elapsedMs"] = round((time.monotonic() - started) * 1000, 1)
                budget.settle(receipt, reserve)
    return Gateway


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--port", type=int, default=23128)
    args = parser.parse_args()
    config = json.loads((Path(args.directory) / "gateway-config.json").read_text(encoding="utf-8"))
    if config.get("limitUsd") != 5:
        raise SystemExit("this reviewed round has a $5 maximum")
    print("Vector live benchmark: OpenAI API billing, total cap $5.00.")
    print("Only synthetic fixtures. Key stays in this process; it is never written to a file.")
    print("No paid call happens until a labelled benchmark batch is separately armed.")
    api_key = getpass.getpass("Enter the OpenAI API key for the account YOU want billed (or Ctrl+C to cancel): ")
    if not api_key.strip():
        raise SystemExit("No key provided; nothing sent.")
    budget = Budget(args.directory, config["limitUsd"])
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(budget, api_key.strip(), config["localToken"]))
    print(f"Ready on 127.0.0.1:{args.port}; spending is not armed. Leave this window open.")
    server.serve_forever()


if __name__ == "__main__":
    main()
