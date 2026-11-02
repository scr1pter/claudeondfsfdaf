"""Bounded loopback-only supervision. This module never writes application source."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

from oracle import InstrumentFailure, ProductFailure, equal, loopback_origin, message, require
from owned_process import OwnedJob


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def request(origin, path, method="GET", body=None, raw=None, timeout=15, headers=None):
    require(path.startswith("/") and not path.startswith("//"), "HTTP path stays on its validated local origin", path)
    payload = raw if raw is not None else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(loopback_origin(origin) + path, data=payload, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as failure:
        response = failure
    with response:
        data = response.read(1_048_577)
        require(len(data) <= 1_048_576, "HTTP JSON response remains bounded", len(data))
        require(response.headers.get_content_type() == "application/json", "API response is application/json", response.headers.get("Content-Type"))
        try:
            value = json.loads(data)
        except (ValueError, UnicodeError):
            raise ProductFailure("API response is valid JSON", data[:200].decode(errors="replace")) from None
        return response.status, value


def poll(operation, predicate, expected, timeout=8):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = operation()
        if predicate(last):
            return last
        time.sleep(0.04)  # Polling cadence only: completion requires the observable predicate.
    raise ProductFailure(expected, last)


class Pending:
    def __init__(self, operation):
        self.result = None
        self.error = None
        def run():
            try:
                self.result = operation()
            except BaseException as failure:
                self.error = failure
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def finish(self, allow_disconnect=False):
        self.thread.join(timeout=18)
        require(not self.thread.is_alive(), "Owned asynchronous request settles within its deadline")
        if self.error and not allow_disconnect:
            raise self.error
        return self.result


class App:
    def __init__(self, options, name):
        self.options = options
        self.work = options.out / "runtime" / name
        self.work.mkdir(parents=True)
        self.data = self.work / "data"
        self.data.mkdir()
        self.home = self.work / "home"
        self.home.mkdir()
        self.origin = "http://127.0.0.1:4123"
        self.process, self.job, self.streams = None, None, []
        self.generation = 0

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_args):
        self.stop()

    def start(self):
        if self.process is not None:
            raise InstrumentFailure("Evaluator attempted to start an already-owned application")
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", 4123))
            except OSError:
                raise InstrumentFailure("App port 4123 was occupied before evaluator startup; no unrelated process was stopped") from None
        self.generation += 1
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "LANG", "LC_ALL") if key in os.environ}
        env.update({"PORT": "4123", "DATA_DIR": str(self.data), "HOME": str(self.home), "USERPROFILE": str(self.home),
                    "TEMP": str(self.home), "TMP": str(self.home), "LOCALAPPDATA": str(self.home), "APPDATA": str(self.home), "CI": "1", "NO_COLOR": "1"})
        self.streams = [(self.work / ("app-" + str(self.generation) + "." + suffix + ".log")).open("w", encoding="utf-8") for suffix in ("stdout", "stderr")]
        self.job = OwnedJob()
        try:
            self.process = subprocess.Popen([str(self.options.bun), "--no-env-file", "server/index.ts"], cwd=self.options.app, env=env,
                                            stdin=subprocess.DEVNULL, stdout=self.streams[0], stderr=self.streams[1], start_new_session=os.name != "nt")
            self.job.assign(self.process)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                require(self.process.poll() is None, "Submitted application remains running until ready", self.process.returncode)
                try:
                    status, health = request(self.origin, "/api/health", timeout=0.5)
                except (OSError, urllib.error.URLError):
                    time.sleep(0.04)
                    continue
                equal(status, 200, "Health endpoint returns 200")
                require(isinstance(health, dict) and health.get("ok") is True, "Health confirms application readiness", health)
                self.provider = loopback_origin(health.get("providerOrigin"))
                require(self.provider != self.origin, "Protected provider has its own loopback HTTP listener", health)
                try:
                    self.control("/health")
                except InstrumentFailure as failure:
                    raise ProductFailure("App exposes a ready protected local provider", str(failure)) from failure
                return
            raise ProductFailure("Submitted application becomes ready within 15 seconds")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.process is not None:
            if os.name == "nt":
                if self.job:
                    self.job.close()  # Hard stop also closes all owned children.
            else:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if self.job:
            self.job.close()
            self.job = None
        for stream in self.streams:
            stream.close()
        self.streams = []

    def restart(self):
        self.stop()
        self.start()

    def api(self, path, method="GET", body=None, expected=200, raw=None):
        status, value = request(self.origin, path, method, body, raw)
        equal(status, expected, method + " " + path + " returns " + str(expected))
        require(isinstance(value, dict), "API JSON response is an object", value)
        if expected in (200, 201, 202) and path.startswith("/api/messages/"):
            message(value.get("message"))
        if expected == 201 and path.startswith("/api/tickets/"):
            message(value.get("message"))
        if path == "/api/tickets" and expected == 200:
            require(isinstance(value.get("tickets"), list) and all(isinstance(row, dict) and all(isinstance(row.get(key), str) for key in ("id", "subject", "customer")) for row in value["tickets"]), "Ticket list has the public catalog shape", value)
        if method == "GET" and path.startswith("/api/tickets/") and expected == 200:
            require(isinstance(value.get("ticket"), dict) and isinstance(value.get("messages"), list), "Ticket detail includes ticket and ordered message array", value)
            for row in value["messages"]:
                message(row)
        if path == "/api/outbox" and expected == 200:
            require(isinstance(value.get("items"), list), "Outbox includes its items array", value)
            for row in value["items"]:
                message(row)
        return value

    def control(self, path, body=None):
        try:
            status, value = request(self.provider, path, "POST" if body is not None else "GET", body)
            if status != 200 or not isinstance(value, dict):
                raise InstrumentFailure("Protected provider control rejected the evaluator's valid request")
            return value
        except (OSError, urllib.error.URLError, ProductFailure) as failure:
            raise InstrumentFailure("Protected provider control unavailable: " + str(failure)) from failure

    def state(self):
        return self.control("/control/state")

    def plan(self, identifier, mode):
        return self.control("/control/plan", {"messageId": identifier, "mode": mode})

    def release(self, identifier, response="receipt"):
        return self.control("/control/release", {"messageId": identifier, "response": response})

    def draft(self, body="Synthetic reply", ticket="t-101"):
        return message(self.api("/api/tickets/" + ticket + "/messages", "POST", {"body": body}, 201).get("message"))

    def get(self, identifier):
        return message(self.api("/api/messages/" + identifier).get("message"))

    def send(self, identifier, request_id=None, expected=202):
        result = self.api("/api/messages/" + identifier + "/send", "POST", {"requestId": request_id or "request-" + identifier}, expected)
        return message(result.get("message")) if expected == 202 else result

    def action(self, identifier, name, expected=200):
        result = self.api("/api/messages/" + identifier + "/" + name, "POST", {}, expected)
        return message(result.get("message")) if expected == 200 else result

    def drain(self):
        result = self.api("/api/outbox/drain", "POST", {})
        require(isinstance(result.get("processed"), list) and all(isinstance(item, str) for item in result["processed"]), "Drain reports processed message IDs", result)
        equal(len(set(result["processed"])), len(result["processed"]), "A drain reports each logical message at most once")
        return result

    def held(self, identifier, stage):
        return poll(self.state, lambda state: any(row.get("messageId") == identifier and row.get("stage") == stage for row in state["held"]), "Fixture observes explicit " + stage + " barrier")

    def outbox(self):
        return self.api("/api/outbox").get("items")
