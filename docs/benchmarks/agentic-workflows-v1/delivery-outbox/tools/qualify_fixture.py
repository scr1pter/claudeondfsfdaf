"""Deferred real-fixture free qualification. Requires an explicit exclusive Bun grant."""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "evaluator"))
from oracle import InstrumentFailure, equal, loopback_origin, manifest, provider_consistent, require
from owned_process import OwnedJob
from runtime import Pending, poll, request


class Host:
    def __init__(self, bun, output):
        self.bun, self.output = bun, output
        self.data = output / "provider-data"
        self.data.mkdir()
        self.process, self.job, self.stderr = None, None, None
        self.generation = 0

    def start(self):
        self.generation += 1
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH") if key in os.environ}
        env.update({"HOME": str(self.output), "USERPROFILE": str(self.output), "TEMP": str(self.output), "TMP": str(self.output), "NO_COLOR": "1"})
        self.stderr = (self.output / ("host-" + str(self.generation) + ".stderr.log")).open("w", encoding="utf-8")
        self.job = OwnedJob()
        try:
            self.process = subprocess.Popen([str(self.bun), "--no-env-file", str(ROOT / "tools/provider_host.ts"), str(ROOT / "seed/fixtures/provider.ts"), str(self.data)],
                                            cwd=self.output, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=self.stderr,
                                            text=True, encoding="utf-8", start_new_session=os.name != "nt")
            self.job.assign(self.process)
            ready = queue.Queue(maxsize=1)
            def read_ready():
                try:
                    ready.put(self.process.stdout.readline(4097))
                except (OSError, ValueError):
                    ready.put("")
            threading.Thread(target=read_ready, daemon=True).start()
            line = ready.get(timeout=15)
            value = json.loads(line)
            require(value.get("ready") is True, "Protected provider qualification host becomes ready", value)
            self.origin = loopback_origin(value.get("origin"))
            equal(self.call("/health")[1], {"ok": True}, "Protected provider is ready")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.process is not None:
            if os.name == "nt":
                self.job.close()
            else:
                try: os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process.stdout.close()
            self.process = None
        if self.job: self.job.close()
        if self.stderr: self.stderr.close()

    def call(self, path, body=None, expected=200, raw=None):
        result = request(self.origin, path, "POST" if body is not None or raw is not None else "GET", body, raw)
        equal(result[0], expected, "Protected provider protocol status for " + path)
        return result

    def state(self):
        return provider_consistent(self.call("/control/state")[1])

    def plan(self, envelope, mode):
        self.call("/control/plan", {"messageId": envelope["messageId"], "mode": mode})

    def held(self, envelope, stage):
        return poll(self.state, lambda state: any(row["messageId"] == envelope["messageId"] and row["stage"] == stage for row in state["held"]), "Protected fixture reaches its explicit barrier")


def envelope(index):
    return {"idempotencyKey": "qualification-key-" + str(index), "messageId": "qualification-message-" + str(index), "ticketId": "t-101", "body": "Synthetic fixture qualification " + str(index)}


def qualify(host):
    checks = []
    def passed(name): checks.append({"name": name, "status": "passed"})
    one = envelope(1)
    accepted = host.call("/deliver", one)[1]
    equal(host.call("/deliver", one)[1], accepted, "Exact provider replay returns the same durable receipt")
    equal(len(host.state()["receipts"]), 1, "Provider replay has exactly one effect")
    passed("receipt-idempotency")
    host.call("/deliver", {**one, "body": "Conflicting synthetic body"}, expected=409)
    equal(len(host.state()["receipts"]), 1, "Key conflict cannot create another effect")
    passed("key-envelope-conflict")
    two = envelope(2)
    host.plan(two, "fail_once")
    host.call("/deliver", two, expected=503)
    host.call("/deliver", two)
    equal(len([row for row in host.state()["receipts"] if row["messageId"] == two["messageId"]]), 1, "One-shot transient failure is deterministic")
    passed("one-shot-failure")
    three = envelope(3)
    host.plan(three, "before_accept")
    pending = Pending(lambda: host.call("/deliver", three))
    host.held(three, "before_accept")
    equal(host.call("/cancel", {"idempotencyKey": three["idempotencyKey"]})[1]["status"], "cancelled", "Cancellation wins before acceptance")
    equal(pending.finish()[1]["status"], "cancelled", "Cancellation releases the held send")
    equal(host.call("/deliver", three)[1]["status"], "cancelled", "Cancellation tombstone prevents replay acceptance")
    passed("preaccept-cancellation")
    four = envelope(4)
    host.plan(four, "after_accept")
    pending = Pending(lambda: host.call("/deliver", four, expected=503))
    state = host.held(four, "after_accept")
    receipt = next(row for row in state["receipts"] if row["messageId"] == four["messageId"])
    equal(host.call("/cancel", {"idempotencyKey": four["idempotencyKey"]})[1]["receipt"], receipt, "Cancellation after acceptance returns the committed receipt")
    host.call("/control/release", {"messageId": four["messageId"], "response": "lost"})
    pending.finish()
    equal(host.call("/deliver", four)[1]["receipt"], receipt, "A lost accepted response replays the same receipt")
    passed("accepted-lost-response-and-too-late-cancel")
    five = envelope(5)
    host.plan(five, "before_accept")
    pending = Pending(lambda: host.call("/deliver", five))
    host.held(five, "before_accept")
    host.call("/control/cancel-plan", {"idempotencyKey": five["idempotencyKey"], "mode": "fail_once"})
    host.call("/cancel", {"idempotencyKey": five["idempotencyKey"]}, expected=503)
    require(five["idempotencyKey"] not in host.state()["cancellations"], "Failed cancellation creates no tombstone")
    host.call("/cancel", {"idempotencyKey": five["idempotencyKey"]})
    pending.finish()
    passed("transient-cancellation-failure")
    six = envelope(6)
    host.plan(six, "after_accept")
    pending = Pending(lambda: host.call("/deliver", six))
    state = host.held(six, "after_accept")
    host.stop()
    pending.finish(allow_disconnect=True)
    host.start()
    equal(host.state()["receipts"], state["receipts"], "Committed provider effects survive a hard process stop")
    equal(host.call("/deliver", six)[1]["receipt"], next(row for row in state["receipts"] if row["messageId"] == six["messageId"]), "Crash-window replay reconciles original receipt")
    passed("accepted-effect-restart-durability")
    seven = envelope(7)
    host.plan(seven, "before_accept")
    pending = Pending(lambda: host.call("/deliver", seven))
    host.held(seven, "before_accept")
    host.stop()
    pending.finish(allow_disconnect=True)
    host.start()
    require(not any(row["messageId"] == seven["messageId"] for row in host.state()["receipts"]), "Preaccept crash creates no effect")
    host.plan(seven, "accept")
    host.call("/deliver", seven)
    passed("preaccept-restart-and-explicit-release")
    eight = {**envelope(8), "body": " \n" + "🙂" * 1996 + "\n "}
    unicode_receipt = host.call("/deliver", eight)[1]["receipt"]
    equal(unicode_receipt["body"], eight["body"], "The provider preserves 2000 Unicode code points and surrounding whitespace verbatim")
    equal(host.call("/deliver", eight)[1]["receipt"], unicode_receipt, "Unicode envelope replay is idempotent")
    passed("unicode-codepoint-boundary-and-verbatim-body")
    state = host.state()
    host.call("/deliver", expected=400, raw=b"{")
    host.call("/deliver", {**envelope(8), "body": " "}, expected=400)
    host.call("/deliver", {**envelope(9), "body": "🙂" * 2001}, expected=400)
    equal(host.state(), state, "Malformed envelopes never mutate provider state")
    passed("invalid-envelope-no-effect")
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    options = parser.parse_args()
    options.bun, options.out = options.bun.resolve(), options.out.resolve()
    if options.out.exists() or options.out.is_relative_to(ROOT) or not options.bun.is_file():
        raise InstrumentFailure("Qualification requires explicit Bun and a new output outside the task")
    before = manifest(ROOT)
    options.out.mkdir(parents=True)
    host = Host(options.bun, options.out)
    report = {"kind": "delivery-outbox-fixture-qualification-v1", "status": "instrument_failure", "checks": [], "modelCalls": 0}
    try:
        host.start()
        report["checks"] = qualify(host)
        report["status"] = "passed"
    except Exception as failure:
        report["error"] = type(failure).__name__ + ": " + str(failure)
    finally:
        host.stop()
    report["sourceUnchanged"] = before == manifest(ROOT)
    if not report["sourceUnchanged"]: report["status"] = "instrument_failure"
    (options.out / "fixture-qualification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":
    sys.exit(main())
