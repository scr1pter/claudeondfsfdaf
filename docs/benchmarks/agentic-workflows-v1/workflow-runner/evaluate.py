"""Independent local Workflow Runner gate. Synthetic data; no model or deployment calls."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

API_NAMES = ["legacy_migration", "legacy_post_compatibility", "graph_validation_atomicity", "durable_idempotency", "dependency_ordering", "bounded_real_concurrency", "automatic_retry_success", "retry_exhaustion_and_blocking", "running_cancellation", "queued_cancellation", "interrupted_attempt_recovery", "durable_event_replay", "invalid_request_safety", "cross_workflow_isolation", "real_worker_result_integrity", "completed_restart_persistence"]
BROWSER_NAMES = ["dashboard_boot", "legacy_jobs_visible", "browser_create_workflow", "external_changes_live", "browser_cancel_workflow", "worker_failure_visible", "durable_events_visible", "mobile_layout_and_keyboard"]


class ProductFailure(Exception):
    pass


class InstrumentFailure(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ProductFailure(message)


def wait_for(action, description, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = action()
            if value:
                return value
        except (ConnectionError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = type(error).__name__
        time.sleep(0.035)
    raise ProductFailure("Timed out waiting for " + description + (" (" + last + ")" if last else ""))


def inventory(app):
    result = {}
    for directory, folders, files in os.walk(app, followlinks=False):
        folders[:] = [name for name in folders if name not in {"node_modules", "__pycache__", ".git"} and (Path(directory) / name).relative_to(app).as_posix() != "dist"]
        for name in folders + files:
            file = Path(directory) / name
            relative = file.relative_to(app)
            if file.is_symlink() or file.is_junction():
                raise ProductFailure("Application source contains a link: " + relative.as_posix())
            if file.is_file():
                result[relative.as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        try:
            return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def call(self, method, route, value=None, key=None, raw=None):
        headers = {"Content-Type": "application/json"}
        if key is not None:
            headers["Idempotency-Key"] = key
        data = raw if raw is not None else json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request(self.base + route, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=8)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(2_000_000)
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeError):
                payload = None
            return response.status, payload

    def expect(self, method, route, status=200, **kwargs):
        actual, value = self.call(method, route, **kwargs)
        require(actual == status, f"{method} {route.split('?')[0]} expected HTTP {status}, received {actual}")
        require(isinstance(value, dict), "Expected a JSON object response")
        return value


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def environment(home, bun, node):
    home.mkdir(parents=True, exist_ok=True)
    (home / "local").mkdir(exist_ok=True)
    (home / "roaming").mkdir(exist_ok=True)
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH") if key in os.environ}
    env.update({"PATH": str(bun.parent) + os.pathsep + str(node.parent) + os.pathsep + env.get("PATH", ""), "HOME": str(home), "USERPROFILE": str(home), "TEMP": str(home), "TMP": str(home), "LOCALAPPDATA": str(home / "local"), "APPDATA": str(home / "roaming"), "WORKFLOW_PROFILE_ROOT": tempfile.gettempdir(), "CI": "1", "NO_COLOR": "1"})
    return env


def browser_environment(bun, node):
    # Windows Chromium needs its native OS-directory environment. The browser still uses a fresh
    # explicit profile and strict forwarding proxy; provider credentials are never copied.
    names = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "OS", "SYSTEMDRIVE", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PROGRAMDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "USERNAME", "USERDOMAIN"]
    env = {key: os.environ[key] for key in names if key in os.environ}
    env.update({"PATH": str(bun.parent) + os.pathsep + str(node.parent) + os.pathsep + env.get("PATH", ""), "WORKFLOW_PROFILE_ROOT": tempfile.gettempdir(), "CI": "1", "NO_COLOR": "1"})
    return env


def stop(process, crash=False):
    if process is None or process.poll() is not None:
        return
    if crash:
        process.kill()
    elif os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class Fixture:
    def __init__(self, app, out, task, bun, node):
        self.app, self.out, self.task, self.bun, self.node = app, out, task, bun, node
        self.out.mkdir(parents=True)
        self.data = self.out / "data"
        self.data.mkdir()
        self.markers = self.out / "worker-markers"
        self.markers.mkdir()
        self.env = environment(self.out / "home", bun, node)
        self.env.update({"DATA_DIR": str(self.data), "WORKFLOW_MARKER_DIR": str(self.markers), "WORKFLOW_WORKER_PATH": str(task / "worker.ts"), "WORKFLOW_CONCURRENCY": "2"})
        database = sqlite3.connect(self.data / "workflow.sqlite")
        database.executescript((task / "seed/sql/v1.sql").read_text(encoding="utf-8"))
        database.execute("INSERT INTO jobs(id,name,kind,status,attempt,result,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", ("legacy-completed", "Legacy completed", "succeed", "succeeded", 1, "legacy result", None, 100, 100))
        database.commit()
        database.close()
        self.process = None
        self.start_number = 0

    def start(self):
        self.start_number += 1
        self.env["PORT"] = str(free_port())
        self.base = "http://127.0.0.1:" + self.env["PORT"]
        self.client = Client(self.base)
        self.stdout = (self.out / f"server-{self.start_number}.stdout.log").open("w", encoding="utf-8")
        self.stderr = (self.out / f"server-{self.start_number}.stderr.log").open("w", encoding="utf-8")
        self.process = subprocess.Popen([str(self.bun), "server/index.ts"], cwd=self.app, env=self.env, stdin=subprocess.DEVNULL, stdout=self.stdout, stderr=self.stderr, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        def healthy():
            require(self.process.poll() is None, "Application exited during startup")
            status, value = self.client.call("GET", "/api/health")
            return status == 200 and isinstance(value, dict) and value.get("ok") is True
        wait_for(healthy, "local application health", timeout=20)

    def close(self, crash=False):
        stop(self.process, crash)
        self.process = None
        if hasattr(self, "stdout"):
            self.stdout.close()
            self.stderr.close()

    def workflow(self, workflow_id):
        result = self.client.expect("GET", "/api/workflows/" + workflow_id)
        workflow = result.get("workflow")
        require(isinstance(workflow, dict) and isinstance(workflow.get("jobs"), list), "Expected workflow with jobs")
        return workflow

    def create(self, name, jobs=None, concurrency=2, key=None):
        body = {"name": name, "concurrency": concurrency, "jobs": jobs if jobs is not None else [job("a")]}
        result = self.client.expect("POST", "/api/workflows", 201, value=body, key=key or "create-" + name)
        value = result.get("workflow")
        require(isinstance(value, dict) and isinstance(value.get("id"), str), "Creation did not return workflow identity")
        return value

    def settled(self, workflow_id, status="succeeded"):
        return wait_for(lambda: (value if (value := self.workflow(workflow_id)).get("status") == status else None), "workflow " + status)

    def started(self, node, attempt=1):
        require(isinstance(node.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", node["id"]), "Job id cannot be passed to the protected worker")
        file = self.markers / f"{node['id']}.{attempt}.started.json"
        return wait_for(lambda: json.loads(file.read_text()) if file.exists() else None, "real worker start")

    def release(self, node, attempt=1):
        (self.markers / f"{node['id']}.{attempt}.release").touch()


def job(key, kind="succeed", dependencies=None, attempts=1):
    return {"key": key, "name": "Job " + key, "kind": kind, "dependsOn": dependencies or [], "maxAttempts": attempts}


def nodes(workflow):
    return {item["key"]: item for item in workflow["jobs"]}


def events(fixture, workflow_id, after=0):
    result = fixture.client.expect("GET", f"/api/workflows/{workflow_id}/events?after={after}")
    require(isinstance(result.get("events"), list), "Expected events array")
    return result["events"]


def legacy_migration(f):
    require(f.client.expect("GET", "/api/health").get("schemaVersion") == 2, "Startup did not report schema version 2")
    record = f.client.expect("GET", "/api/jobs/legacy-completed").get("job")
    require(isinstance(record, dict), "Legacy job missing")
    require(all(record.get(key) == value for key, value in {"id": "legacy-completed", "name": "Legacy completed", "kind": "succeed", "status": "succeeded", "attempt": 1, "result": "legacy result", "created_at": 100, "updated_at": 100}.items()), "Migration changed completed legacy data")
    database = sqlite3.connect(f.data / "workflow.sqlite")
    version = database.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    database.close()
    require(version == ("2",), "Schema version was not durably migrated")
    require(not list(f.markers.glob("legacy-completed.*.started.json")), "Migration re-executed completed legacy work")


def legacy_post(f):
    created = f.client.expect("POST", "/api/jobs", 201, value={"name": "Compatibility job", "kind": "succeed"}).get("job")
    require(isinstance(created, dict) and isinstance(created.get("id"), str), "Legacy create response changed")
    def finished():
        value = f.client.expect("GET", "/api/jobs/" + created["id"]).get("job", {})
        return value if value.get("status") == "succeeded" else None
    result = wait_for(finished, "legacy job completion")
    require(result.get("attempt") == 1 and result.get("result"), "Legacy execution counters or result missing")


def validation(f):
    baseline = f.client.expect("GET", "/api/workflows").get("workflows")
    require(isinstance(baseline, list), "Workflow list is malformed")
    identities = {item["id"] for item in baseline}
    prior_events = {identity: events(f, identity) for identity in identities}
    invalid = [[], [job("a"), job("a")], [job("a", dependencies=["missing"])], [job("a", dependencies=["a"])], [job("a", dependencies=["b"]), job("b", dependencies=["a"])], [job("a", dependencies=["b", "b"]), job("b")]]
    for index, jobs in enumerate(invalid):
        f.client.expect("POST", "/api/workflows", 400, value={"name": "Invalid", "concurrency": 2, "jobs": jobs}, key="invalid-" + str(index))
    current = f.client.expect("GET", "/api/workflows").get("workflows")
    require(isinstance(current, list) and {item["id"] for item in current} == identities, "Invalid graph changed the workflow inventory")
    require(all(events(f, identity) == history for identity, history in prior_events.items()), "Invalid graph changed existing workflow events")
    # A rejected request must not consume its key.
    f.create("Valid retry", key="invalid-0")


def idempotency(f):
    body = {"name": "Idempotency", "concurrency": 2, "jobs": [job("a")]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: Client(f.base).call("POST", "/api/workflows", value=body, key="same-key"), range(2)))
    require(sorted(status for status, _ in responses) == [200, 201], "Concurrent idempotency did not create once and replay once")
    ids = [value.get("workflow", {}).get("id") for _, value in responses]
    require(ids[0] == ids[1] and isinstance(ids[0], str), "Idempotent responses returned different identities")
    f.settled(ids[0])
    before = events(f, ids[0])
    replay = f.client.expect("POST", "/api/workflows", value={"jobs": body["jobs"], "concurrency": 2, "name": "Idempotency"}, key="same-key")
    require(replay.get("replayed") is True, "Replay indicator missing")
    require(events(f, ids[0]) == before, "Idempotency replay appended events")
    f.client.expect("POST", "/api/workflows", 409, value={**body, "name": "Different"}, key="same-key")


def dependency_order(f):
    value = f.create("Dependency order", [job("a", "block"), job("b", dependencies=["a"])])
    first = nodes(f.workflow(value["id"]))["a"]
    f.started(first)
    current = nodes(f.workflow(value["id"]))
    require(current["b"]["status"] == "queued" and not current["b"].get("attempts"), "Dependent started before predecessor completion")
    f.release(first)
    result = nodes(f.settled(value["id"]))
    require(all(item["status"] == "succeeded" for item in result.values()), "Dependency chain did not complete")
    require(result["a"]["attempts"][0]["finishedAt"] <= result["b"]["attempts"][0]["startedAt"], "Recorded attempts violate dependency ordering")


def bounded_concurrency(f):
    value = f.create("Concurrency", [job("a", "block"), job("b", "block"), job("c", "block")], concurrency=3)
    wait_for(lambda: len(list(f.markers.glob("*.started.json"))) >= 2, "two concurrent worker barriers")
    deadline = time.monotonic() + 0.75
    while time.monotonic() < deadline:
        require(len(list(f.markers.glob("*.started.json"))) == 2, "Global live-worker limit of two exceeded")
        time.sleep(0.025)
    current = f.workflow(value["id"])
    running = [node for node in current["jobs"] if node["status"] == "running"]
    require(len(running) == 2, "Worker evidence and running state disagree")
    for node in running:
        started = f.started(node)
        require(process_alive(started.get("pid")), "Running attempt has no real live child")
        f.release(node)
    wait_for(lambda: len(list(f.markers.glob("*.started.json"))) == 3, "third worker after capacity release")
    for node in f.workflow(value["id"])["jobs"]:
        f.release(node)
    f.settled(value["id"])
    # The workflow's own bound must also apply below the global bound.
    single = f.create("Serial workflow", [job("x", "block"), job("y", "block")], concurrency=1)
    candidates = nodes(f.workflow(single["id"]))
    wait_for(lambda: any((f.markers / f"{node['id']}.1.started.json").exists() for node in candidates.values()), "serial worker")
    require(sum((f.markers / f"{node['id']}.1.started.json").exists() for node in candidates.values()) == 1, "Workflow concurrency one exceeded")
    for node in candidates.values():
        f.release(node)
    f.settled(single["id"])


def retry_success(f):
    value = f.create("Retry success", [job("a", "fail_once", attempts=2)])
    node = nodes(f.settled(value["id"]))["a"]
    require([attempt["status"] for attempt in node["attempts"]] == ["failed", "succeeded"], "Retry did not retain failed and successful attempts")
    require([attempt["number"] for attempt in node["attempts"]] == [1, 2], "Attempt numbering is not monotonic")
    require("job.retrying" in [event["type"] for event in events(f, value["id"])], "Retry transition missing from durable events")


def retry_exhaustion(f):
    value = f.create("Retry exhaustion", [job("a", "fail", attempts=2), job("b", dependencies=["a"])])
    result = nodes(f.settled(value["id"], "failed"))
    require(result["a"]["status"] == "failed" and len(result["a"]["attempts"]) == 2, "Failure retry allowance was not respected")
    require(result["b"]["status"] == "blocked" and not result["b"].get("attempts"), "Failed predecessor did not block downstream work")
    require(not (f.markers / f"{result['b']['id']}.1.started.json").exists(), "Blocked child executed")


def running_cancel(f):
    value = f.create("Running cancellation", [job("a", "block"), job("b", dependencies=["a"])])
    node = nodes(f.workflow(value["id"]))["a"]
    evidence = f.started(node)
    require(process_alive(evidence.get("pid")), "Expected real running worker before cancel")
    f.client.expect("POST", "/api/workflows/" + value["id"] + "/cancel")
    result = f.settled(value["id"], "cancelled")
    wait_for(lambda: not process_alive(evidence["pid"]), "cancelled child exit", timeout=3)
    require(nodes(result)["a"]["attempts"][-1]["status"] == "cancelled", "Running attempt did not record cancellation")
    require(nodes(result)["b"]["status"] == "cancelled" and not nodes(result)["b"].get("attempts"), "Queued child started or was not cancelled")
    before = events(f, value["id"])
    f.client.expect("POST", "/api/workflows/" + value["id"] + "/cancel")
    require(events(f, value["id"]) == before, "Repeated cancellation appended events")


def queued_cancel(f):
    busy = f.create("Capacity holder", [job("a", "block"), job("b", "block")])
    for node in f.workflow(busy["id"])["jobs"]:
        f.started(node)
    value = f.create("Queued cancellation")
    f.client.expect("POST", "/api/workflows/" + value["id"] + "/cancel")
    result = f.settled(value["id"], "cancelled")
    require(all(node["status"] == "cancelled" and not node.get("attempts") for node in result["jobs"]), "Queued cancellation executed work")


def interrupted_recovery(f):
    value = f.create("Crash recovery", [job("a", "block", attempts=1)])
    node = nodes(f.workflow(value["id"]))["a"]
    old = f.started(node)
    f.close(crash=True)
    wait_for(lambda: not process_alive(old["pid"]), "old fixture exit after parent crash", timeout=5)
    f.start()
    new = f.started(node, 2)
    require(process_alive(new["pid"]), "Recovered attempt did not run a real child")
    f.release(node, 2)
    result = nodes(f.settled(value["id"]))["a"]
    require([attempt["status"] for attempt in result["attempts"]] == ["interrupted", "succeeded"], "Restart lost or misclassified interrupted attempt")
    require("job.interrupted" in [event["type"] for event in events(f, value["id"])], "Recovery event missing")


def event_replay(f):
    value = f.create("Events")
    f.settled(value["id"])
    all_events = events(f, value["id"])
    sequences = [event.get("seq") for event in all_events]
    require(all(isinstance(seq, int) and seq > 0 for seq in sequences) and sequences == sorted(set(sequences)), "Event sequence is not strictly increasing")
    require({"workflow.created", "job.started", "job.succeeded", "workflow.succeeded"}.issubset({event.get("type") for event in all_events}), "Required durable transitions missing")
    cursor = sequences[1]
    require(events(f, value["id"], cursor) == [event for event in all_events if event["seq"] > cursor], "Event cursor returned duplicate or omitted transitions")
    require(events(f, value["id"], 999999999) == [], "Future event cursor must be empty")
    f.client.expect("GET", f"/api/workflows/{value['id']}/events?after=-1", 400)


def invalid_requests(f):
    base = {"name": "Input safety", "concurrency": 2, "jobs": [job("a")]}
    for key in [None, "", "x" * 129]:
        f.client.expect("POST", "/api/workflows", 400, value=base, key=key)
    for index, changed in enumerate([{**base, "concurrency": 0}, {**base, "concurrency": 4}, {**base, "jobs": [job("../bad")]}, {**base, "jobs": [job("a", "shell")]}, {**base, "jobs": [job("a", attempts=4)]}, {**base, "name": " "}]):
        f.client.expect("POST", "/api/workflows", 400, value=changed, key="invalid-field-" + str(index))
    f.client.expect("POST", "/api/workflows", 400, raw=b"{not-json", key="bad-json")
    f.client.expect("GET", "/api/workflows/does-not-exist", 404)
    f.client.expect("POST", "/api/workflows/does-not-exist/cancel", 404)
    f.client.expect("GET", "/api/workflows/does-not-exist/events?after=0", 404)


def isolation(f):
    left = f.create("Isolated left", [job("a", "block")], concurrency=1)
    right = f.create("Isolated right", [job("a", "block")], concurrency=1)
    right_node = nodes(f.workflow(right["id"]))["a"]
    for value in [left, right]:
        f.started(nodes(f.workflow(value["id"]))["a"])
    f.client.expect("POST", "/api/workflows/" + left["id"] + "/cancel")
    require(f.workflow(right["id"])["status"] == "running", "Cancelling one workflow changed another")
    require("workflow.cancelled" not in [event["type"] for event in events(f, right["id"])], "Events leaked between workflows")
    f.release(right_node)
    f.settled(right["id"])


def result_integrity(f):
    value = f.create("Worker result")
    result = nodes(f.settled(value["id"]))["a"]
    output = json.loads(result.get("result", "null"))
    require(output == {"jobId": result["id"], "attempt": 1, "message": "completed"}, "Persisted result differs from real worker output")
    evidence = f.started(result)
    require(result["attempts"][0].get("pid") == evidence["pid"], "Attempt PID differs from actual worker evidence")
    f.client.expect("POST", "/api/workflows/" + value["id"] + "/cancel", 409)


def persistence(f):
    value = f.create("Durable completion", key="durable-key")
    before = f.settled(value["id"])
    before_events = events(f, value["id"])
    f.close()
    f.start()
    after = f.workflow(value["id"])
    require(after == before, "Completed workflow or attempt changed on restart")
    require(events(f, value["id"]) == before_events, "Restart duplicated or lost completed events")
    replay = f.client.expect("POST", "/api/workflows", value={"name": "Durable completion", "concurrency": 2, "jobs": [job("a")]}, key="durable-key")
    require(replay.get("replayed") is True and replay.get("workflow", {}).get("id") == value["id"], "Idempotency did not survive restart")


API_FUNCTIONS = [legacy_migration, legacy_post, validation, idempotency, dependency_order, bounded_concurrency, retry_success, retry_exhaustion, running_cancel, queued_cancel, interrupted_recovery, event_replay, invalid_requests, isolation, result_integrity, persistence]


def run_command(argv, app, env, log, timeout=90):
    with log.open("w", encoding="utf-8") as output:
        process = subprocess.Popen(argv, cwd=app, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop(process)
            return 124


def evaluate(args):
    args.app, args.out, args.task = args.app.resolve(), args.out.resolve(), args.task.resolve()
    if args.out.exists():
        raise InstrumentFailure("Output directory already exists; preserve prior results")
    if args.out.is_relative_to(args.app) or args.app.is_relative_to(args.out):
        raise InstrumentFailure("Output and application must be separate")
    args.out.mkdir(parents=True)
    checks = [{"name": name, "category": "api" if name in API_NAMES else "browser", "status": "not_run"} for name in API_NAMES + BROWSER_NAMES]
    report = {"kind": "workflow-runner-independent-v1", "verdict": "instrument_failure", "checks": checks, "modelCalls": 0, "feedback": "", "sourceUnchanged": False}
    before = inventory(args.app)
    try:
        if not args.bun.is_file() or not args.node.is_file():
            raise InstrumentFailure("Bun/Node executable missing")
        playwright = args.playwright_module or (Path(os.environ["VECTOR_BENCH_PLAYWRIGHT_MODULE"]) if os.environ.get("VECTOR_BENCH_PLAYWRIGHT_MODULE") else None)
        chrome = args.chrome or (Path(os.environ["VECTOR_BENCH_CHROME"]) if os.environ.get("VECTOR_BENCH_CHROME") else None)
        if playwright is None or not playwright.is_dir() or chrome is None or not chrome.is_file():
            raise InstrumentFailure("Local Playwright package and Chrome are required before product evaluation")
        env = environment(args.out / "build-home", args.bun, args.node)
        report["build"] = {}
        prerequisites = [("typecheck", [str(args.bun), "run", "typecheck"]), ("build", [str(args.bun), "run", "build"]), ("smoke", [str(args.bun), "test", "tests/smoke.test.ts", "--timeout", "30000"])]
        for name, command in prerequisites:
            code = run_command(command, args.app, env, args.out / (name + ".log"))
            report["build"][name] = {"exitCode": code}
            if code != 0:
                checks[0].update(status="failed", error=f"Required {name} exited {code}")
                raise ProductFailure(f"Required {name} did not pass")
        for index, (name, action) in enumerate(zip(API_NAMES, API_FUNCTIONS)):
            fixture = Fixture(args.app, args.out / "api" / name, args.task, args.bun, args.node)
            started = time.monotonic()
            try:
                fixture.start()
                action(fixture)
                checks[index]["status"] = "passed"
            except (ProductFailure, ValueError, KeyError, IndexError, sqlite3.DatabaseError, json.JSONDecodeError, urllib.error.URLError, TimeoutError, ConnectionError) as error:
                checks[index].update(status="failed", error=str(error)[:500])
            finally:
                fixture.close()
                checks[index]["elapsedMs"] = round((time.monotonic() - started) * 1000)
        browser = Fixture(args.app, args.out / "browser-app", args.task, args.bun, args.node)
        try:
            browser.start()
            browser_output = args.out / "browser"
            browser_output.mkdir()
            command = [str(args.node), str(args.task / "browser-check.cjs"), "--base-url", browser.base, "--out", str(browser_output), "--playwright", str(playwright.resolve()), "--chrome", str(chrome.resolve())]
            if args.proxy_module:
                command.extend(["--proxy-module", str(args.proxy_module.resolve())])
            browser_env = browser_environment(args.bun, args.node)
            code = run_command(command, args.task, browser_env, args.out / "browser.log", timeout=90)
            result_path = browser_output / "results.json"
            if not result_path.is_file():
                raise InstrumentFailure(f"Browser evaluator exited {code} without its result")
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if result.get("verdict") == "instrument_failure":
                raise InstrumentFailure(result.get("error", "Browser prerequisite failure"))
            expected = {item["name"]: item for item in result.get("checks", [])}
            if set(expected) != set(BROWSER_NAMES):
                raise InstrumentFailure("Browser check inventory differs from frozen contract")
            for check in checks[len(API_NAMES):]:
                check.update(expected[check["name"]])
        except ProductFailure as error:
            checks[len(API_NAMES)].update(status="failed", error=str(error)[:500])
        finally:
            browser.close()
        report["verdict"] = "passed" if all(check["status"] == "passed" for check in checks) else "product_failure"
    except ProductFailure as error:
        report["verdict"] = "product_failure"
        report["feedback"] = str(error)
    except (InstrumentFailure, OSError, subprocess.SubprocessError) as error:
        report["verdict"] = "instrument_failure"
        report["instrumentError"] = str(error)[:500]
    finally:
        after = inventory(args.app)
        report["sourceUnchanged"] = before == after
        report["sourceIntegrityStatus"] = "unchanged" if before == after else "changed"
        if before != after:
            checks[0].update(status="failed", error="Application authored source changed during evaluation")
            report["verdict"] = "product_failure"
        report["apiPassed"] = sum(item["status"] == "passed" for item in checks[:len(API_NAMES)])
        report["browserPassed"] = sum(item["status"] == "passed" for item in checks[len(API_NAMES):])
        if report["verdict"] == "product_failure":
            report["feedback"] = "\n".join(item["name"] + ": " + item.get("error", "failed") for item in checks if item["status"] == "failed")[:6000]
        (args.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ["app", "out", "bun", "node", "task"]:
        parser.add_argument("--" + flag, type=Path, required=True)
    parser.add_argument("--playwright-module", type=Path)
    parser.add_argument("--chrome", type=Path)
    parser.add_argument("--proxy-module", type=Path)
    args = parser.parse_args()
    try:
        report = evaluate(args)
    except (InstrumentFailure, ProductFailure, OSError) as error:
        print(json.dumps({"verdict": "instrument_failure", "error": str(error)[:500]}))
        return 2
    print(json.dumps({key: report[key] for key in ["verdict", "apiPassed", "browserPassed", "sourceUnchanged"]}))
    return 0 if report["verdict"] == "passed" else 1 if report["verdict"] == "product_failure" else 2


if __name__ == "__main__":
    raise SystemExit(main())
