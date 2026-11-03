"""Independent, model-free Harbor acceptance evaluator.

Only synthetic loopback HTTP/browser traffic is used. Application processes get a
small allowlisted environment and an isolated HOME/data directory. The source
manifest is captured before executing any participant script.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from owned_process import OwnedJob, execute

ROOT = Path(__file__).resolve().parent
API_GROUPS = (
    "health_json_errors", "actors_sessions", "viewer_permissions", "projects_crud_search",
    "environments_uniqueness_scope", "dag_validation_atomicity", "runbook_optimistic_versions",
    "release_snapshot_immutability", "release_draft_revision", "approval_separation_roles",
    "approval_rejection_history", "run_idempotent_concurrency", "dag_order_worker_bound",
    "failure_blocking_retry", "cancellation_terminal", "artifact_bytes_metadata", "job_logs_append_only",
    "rollback_active_history", "incident_release_boundaries", "incident_versions_transitions",
    "incident_notes_timeline", "audit_cursor_filters", "dashboard_export", "restart_persistence",
    "restart_running_recovery", "restart_idempotency_receipt", "cross_project_boundaries",
    "invalid_inputs_no_partial_writes",
)
BROWSER_CHECKS = (
    "navigation_actor", "project_create", "project_edit_search", "environment_create_edit",
    "runbook_create_steps", "runbook_cycle_validation", "runbook_version_edit", "release_create_snapshot",
    "release_draft_edit", "release_submit", "approval_role_switch", "release_approve",
    "release_run_live_jobs", "release_artifact_download", "job_log_detail", "release_deep_link_reload",
    "failure_runbook_create", "failure_release_run", "failure_retry", "second_release_success",
    "rollback_restore_active", "incident_create_link", "incident_note_timeline", "incident_resolve",
    "incident_reopen_filter", "audit_filter", "viewer_restrictions", "escaped_user_text",
    "inline_error_preserves_form", "keyboard_focus", "mobile_layout", "console_local_assets",
)
PREREQUISITES = ("typecheck", "build", "startup", "source_integrity")
STATUSES = {"passed", "failed", "not_run"}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def new_report():
    rows = [{"name": category + ":" + name, "category": category, "status": "not_run"}
            for category, names in (("prerequisite", PREREQUISITES), ("api", API_GROUPS), ("browser", BROWSER_CHECKS))
            for name in names]
    return {"kind": "harbor-independent-evaluation-v1", "modelCalls": 0, "verdict": "instrument_failure",
            "checks": rows, "expectedApiGroups": len(API_GROUPS), "expectedBrowserChecks": len(BROWSER_CHECKS),
            "expectedPrerequisiteChecks": len(PREREQUISITES), "sourceIntegrityStatus": "not_assessed"}


def finalize(report):
    """Fail closed on missing, duplicated, unknown or contradictory evidence."""
    expected = {category + ":" + name: category
                for category, names in (("prerequisite", PREREQUISITES), ("api", API_GROUPS), ("browser", BROWSER_CHECKS))
                for name in names}
    rows = report.get("checks")
    if (not isinstance(rows, list) or len(rows) != len(expected) or
            any(not isinstance(row, dict) or row.get("name") not in expected or
                row.get("category") != expected.get(row.get("name")) or row.get("status") not in STATUSES for row in rows) or
            len({row["name"] for row in rows}) != len(expected)):
        report.update(verdict="instrument_failure", instrumentError="check inventory or status is invalid")
        return report
    counts = {category: {status: sum(row["category"] == category and row["status"] == status for row in rows)
                         for status in sorted(STATUSES)} for category in ("prerequisite", "api", "browser")}
    report["summary"] = counts
    integrity = report.get("sourceIntegrityStatus")
    source = next(row for row in rows if row["name"] == "prerequisite:source_integrity")["status"]
    if integrity not in ("unchanged", "modified", "not_assessed") or source != {
            "unchanged": "passed", "modified": "failed", "not_assessed": "not_run"}.get(integrity):
        report.update(verdict="instrument_failure", instrumentError="source evidence contradicts integrity check")
        return report
    if report.get("instrumentError"):
        report["verdict"] = "instrument_failure"
    elif integrity != "unchanged":
        report.update(verdict="instrument_failure", instrumentError="authored source changed or was not assessed")
    else:
        report["verdict"] = "passed" if all(row["status"] == "passed" for row in rows) else "product_failure"
    return report


def source_manifest(app):
    result = {}
    for path in sorted(app.rglob("*")):
        relative = path.relative_to(app)
        if relative.parts[0] in (".git", "node_modules", "dist"):
            continue
        require(not path.is_symlink(), "symlink in authored source: " + relative.as_posix())
        if path.is_file():
            require(path.resolve().is_relative_to(app), "outside authored source")
            result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def validate_layout(app, declaration):
    """`dist` is reserved output, never an authored input/public/root directory."""
    require(isinstance(declaration, dict) and set(declaration) == {"root", "output", "public", "inputs"}, "unknown build declaration")
    require(Path(declaration["root"]).resolve() == app, "Vite root must be the application root")
    output = app / "dist"
    require(Path(declaration["output"]).absolute() == output and output.resolve() == output, "generated dist output is outside app or symlinked")
    inputs = declaration["inputs"]
    require(isinstance(inputs, list) and inputs and all(isinstance(value, str) for value in inputs), "unknown build inputs")
    protected = [app / "src", app / "server"] + [Path(value).resolve() for value in inputs]
    if declaration["public"] is not None:
        require(isinstance(declaration["public"], str), "unknown public directory")
        protected.append(Path(declaration["public"]).resolve())
    for path in protected:
        require(path.is_relative_to(app) and path != app and not path.is_relative_to(output) and not output.is_relative_to(path),
                "generated output overlaps authored input/public/source or input is outside app")
    return declaration


def validate_browser(raw, process):
    require(isinstance(raw, dict) and raw.get("kind") == "harbor-browser-v1", "browser report missing or invalid")
    require(process.get("exitCode") in (0, 1) and process.get("timedOut") is False, "browser crashed or timed out")
    rows = raw.get("checks")
    require(isinstance(rows, list) and len(rows) == len(BROWSER_CHECKS), "browser inventory length changed")
    require(all(isinstance(row, dict) and row.get("status") in STATUSES for row in rows), "browser status invalid")
    require({row.get("name") for row in rows} == set(BROWSER_CHECKS), "browser inventory changed")
    counts = {status: sum(row["status"] == status for row in rows) for status in sorted(STATUSES)}
    require(raw.get("summary") == counts, "browser summary contradicts checks")
    require((process["exitCode"] == 0) == all(row["status"] == "passed" for row in rows), "browser exit contradicts checks")
    return rows


class Client:
    def __init__(self, base, cookie=None):
        self.base = base
        self.cookie = cookie

    def request(self, method, path, body=None, expected=200, headers=None, raw=False):
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request_headers = {"Content-Type": "application/json", **({"Cookie": self.cookie} if self.cookie else {}), **(headers or {})}
        request = urllib.request.Request(self.base + path, data=data, headers=request_headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=12)
        except urllib.error.HTTPError as error:
            response = error
        content = response.read()
        require(response.status == expected, f"{method} {path}: wanted {expected}, got {response.status}: {content[:250]!r}")
        if raw:
            return content, dict(response.headers)
        if expected == 204:
            require(not content, "204 response had a body")
            return None
        require("application/json" in response.headers.get("Content-Type", ""), "non-JSON API response")
        result = json.loads(content)
        if expected >= 400:
            require(isinstance(result.get("error"), dict) and all(isinstance(result["error"].get(key), str) and result["error"][key]
                    for key in ("code", "message")), "unstructured API error")
        return result

    def login(self, actor):
        request = urllib.request.Request(self.base + "/api/session", data=json.dumps({"actorId": actor}).encode(),
                                        headers={"Content-Type": "application/json"}, method="POST")
        response = urllib.request.urlopen(request, timeout=12)
        require(response.status == 200, "actor session failed")
        cookie = response.headers.get("Set-Cookie", "")
        require(re.search(r"harbor_session=[^;]{32,}", cookie), "session identifier too short")
        require("httponly" in cookie.lower() and "samesite=lax" in cookie.lower() and "path=/" in cookie.lower(), "cookie attributes missing")
        self.cookie = cookie.split(";", 1)[0]
        require(json.loads(response.read())["actor"]["id"] == actor, "wrong session actor")
        return self


class Server:
    def __init__(self, app, out, bun, env, base):
        self.app, self.out, self.bun, self.env, self.base = app, out, bun, env, base
        self.sequence = 0
        self.process = None
        self.job = None

    def start(self):
        self.sequence += 1
        self.job = OwnedJob()
        self.stdout = (self.out / f"server-{self.sequence}.stdout.log").open("w", encoding="utf-8")
        self.stderr = (self.out / f"server-{self.sequence}.stderr.log").open("w", encoding="utf-8")
        self.process = subprocess.Popen([str(self.bun), "--no-env-file", "run", "start"], cwd=self.app, env=self.env,
                                        stdin=subprocess.DEVNULL, stdout=self.stdout, stderr=self.stderr,
                                        start_new_session=os.name != "nt")
        self.job.assign(self.process)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError("application stopped before health")
            try:
                if Client(self.base).request("GET", "/api/health").get("ok") is True:
                    return
            except (OSError, AssertionError, ValueError):
                pass
            time.sleep(0.1)
        raise AssertionError("application health deadline")

    def stop(self):
        if self.process is None:
            return
        if os.name == "nt":
            self.job.close()
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        self.stdout.close()
        self.stderr.close()
        self.job.close()
        self.process = None


def step(key, dependencies=(), duration=150, failure="never", kind="check"):
    return {"key": key, "name": key.title() + " task", "kind": kind, "dependsOn": list(dependencies),
            "durationMs": duration, "failureMode": failure}


class Suite:
    def __init__(self, base, server):
        self.base, self.server = base, server
        self.anon = Client(base)
        self.clients = {}
        self.context = {}

    def client(self, actor="operator"):
        return self.clients[actor]

    def path(self, kind, entity=None, project=None):
        return "/api/projects/" + (project or self.context["project"]["id"]) + "/" + kind + ("/" + entity if entity else "")

    def release(self, title, steps=None, environment=None, actor="operator", ready=False):
        body = {"environmentId": (environment or self.context["stage"])["id"], "title": title,
                "versionLabel": title.lower().replace(" ", "-") + "-v1", "steps": steps or [step("check")]}
        release = self.client(actor).request("POST", self.path("releases"), body, 201)["release"]
        if ready:
            release = self.client(actor).request("POST", self.path("releases", release["id"]) + "/submit",
                                                 {"expectedRevision": release["revision"]})["release"]
            require(release["status"] == "ready", "unprotected submission not ready")
        return release

    def run(self, release, key=None, actor="operator"):
        return self.client(actor).request("POST", self.path("releases", release["id"]) + "/run", {},
                                         headers={"Idempotency-Key": key or "run-" + release["id"]})

    def wait(self, release, status, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            current = self.client().request("GET", self.path("releases", release["id"]))["release"]
            if current["status"] in status:
                return current
            time.sleep(0.04)
        raise AssertionError("release did not reach " + repr(status))

    def jobs(self, release):
        return self.client().request("GET", self.path("releases", release["id"]) + "/jobs")["jobs"]

    def artifacts(self, release):
        return self.client().request("GET", self.path("releases", release["id"]) + "/artifacts")["artifacts"]

    def health_json_errors(self):
        require(self.anon.request("GET", "/api/health") == {"ok": True}, "health contract")
        self.anon.request("GET", "/api/does-not-exist", expected=404)
        self.anon.request("GET", "/api/projects", expected=401)
        self.anon.request("POST", "/api/session", {"actorId": "unknown", "role": "admin"}, 400)

    def actors_sessions(self):
        actors = self.anon.request("GET", "/api/actors")["actors"]
        require({(a["id"], a["role"]) for a in actors} == {("admin", "admin"), ("operator", "operator"), ("viewer", "viewer")}, "actor inventory")
        for actor in ("admin", "operator", "viewer"):
            self.clients[actor] = Client(self.base).login(actor)
            require(self.client(actor).request("GET", "/api/session")["actor"]["id"] == actor, "session role selection")
        revoked = Client(self.base).login("admin")
        revoked.request("DELETE", "/api/session", expected=204)
        revoked.request("GET", "/api/session", expected=401)

    def viewer_permissions(self):
        self.client("viewer").request("POST", "/api/projects", {"name": "Forbidden", "slug": "forbidden"}, 403)
        self.client("viewer").request("GET", "/api/projects")
        self.anon.request("POST", "/api/projects", {"name": "Header bypass", "slug": "header-bypass"}, 401,
                          headers={"X-Harbor-Actor": "admin", "X-Role": "admin"})

    def projects_crud_search(self):
        c = self.client()
        self.context["project"] = c.request("POST", "/api/projects", {"name": "API Atlas", "slug": "api-atlas", "description": "Synthetic release operations"}, 201)["project"]
        self.context["foreign"] = c.request("POST", "/api/projects", {"name": "API Other", "slug": "api-other"}, 201)["project"]
        p = self.context["project"]
        c.request("POST", "/api/projects", {"name": "Duplicate", "slug": "api-atlas"}, 409)
        require([row["id"] for row in c.request("GET", "/api/projects?q=ATLAS")["projects"]] == [p["id"]], "case-insensitive project search")
        temporary = c.request("POST", "/api/projects", {"name": "Temporary", "slug": "api-temporary"}, 201)["project"]
        patched = c.request("PATCH", "/api/projects/" + temporary["id"], {"name": "Renamed"})["project"]
        require(patched["slug"] == "api-temporary" and patched["name"] == "Renamed", "project partial patch")
        c.request("DELETE", "/api/projects/" + temporary["id"], expected=204)
        c.request("GET", "/api/projects/" + temporary["id"], expected=404)

    def environments_uniqueness_scope(self):
        c = self.client()
        self.context["stage"] = c.request("POST", self.path("environments"), {"name": "Staging"}, 201)["environment"]
        self.context["prod"] = c.request("POST", self.path("environments"), {"name": "Production", "protected": True}, 201)["environment"]
        self.context["foreignEnv"] = c.request("POST", self.path("environments", project=self.context["foreign"]["id"]), {"name": "Staging"}, 201)["environment"]
        c.request("POST", self.path("environments"), {"name": "sTAGING"}, 409)
        require(self.context["stage"]["activeReleaseId"] is None and self.context["prod"]["protected"] is True, "environment defaults")
        c.request("GET", self.path("environments", self.context["foreignEnv"]["id"]), expected=404)
        c.request("DELETE", "/api/projects/" + self.context["project"]["id"], expected=409)

    def dag_validation_atomicity(self):
        c = self.client()
        invalid = [[], [step("same"), step("same")], [step("one", ["missing"])], [step("one", ["one"])],
                   [step("one", ["two"]), step("two", ["one"])], [step("one", duration=99)],
                   [step("one", duration=1.5)], [step("one", failure="sometimes")], [step("one", kind="shell")],
                   [step("bad key")], [step("one", ["two", "two"]), step("two")],
                   [step("step-" + str(index)) for index in range(13)],
                   [{**step("one"), "name": " "}], [{**step("one"), "dependsOn": "other"}]]
        before = c.request("GET", self.path("runbooks"))["runbooks"]
        for steps in invalid:
            c.request("POST", self.path("runbooks"), {"name": "Invalid graph", "steps": steps}, 400)
        require(c.request("GET", self.path("runbooks"))["runbooks"] == before, "invalid graph wrote partial runbook")

    def runbook_optimistic_versions(self):
        c = self.client()
        self.context["runbook"] = c.request("POST", self.path("runbooks"), {"name": "API Pipeline", "description": "A versioned DAG", "steps": [step("check"), step("build", ["check"], kind="build"), step("deploy", ["build"], kind="deploy")]}, 201)["runbook"]
        r = self.context["runbook"]
        require(r["version"] == 1, "initial runbook version")
        patched = c.request("PATCH", self.path("runbooks", r["id"]), {"expectedVersion": 1, "description": "Updated description"})["runbook"]
        require(patched["version"] == 2 and patched["steps"] == r["steps"], "version/partial runbook patch")
        c.request("PATCH", self.path("runbooks", r["id"]), {"expectedVersion": 1, "name": "Stale"}, 409)
        require(c.request("GET", self.path("runbooks", r["id"]))["runbook"] == patched, "stale runbook write changed state")
        self.context["runbook"] = patched

    def release_snapshot_immutability(self):
        c, r = self.client(), self.context["runbook"]
        release = c.request("POST", self.path("releases"), {"environmentId": self.context["stage"]["id"], "title": "Snapshot release", "versionLabel": "snapshot-v1", "runbookId": r["id"]}, 201)["release"]
        require(release["steps"] == r["steps"] and release["runbookVersion"] == 2 and release["authorId"] == "operator", "runbook snapshot mismatch")
        c.request("PATCH", self.path("runbooks", r["id"]), {"expectedVersion": 2, "steps": [step("replacement")]})
        require(c.request("GET", self.path("releases", release["id"]))["release"]["steps"] == r["steps"], "runbook edit changed release snapshot")
        c.request("DELETE", self.path("runbooks", r["id"]), expected=204)
        require(c.request("GET", self.path("releases", release["id"]))["release"]["runbookVersion"] == 2, "runbook delete erased snapshot")
        c.request("DELETE", self.path("environments", self.context["stage"]["id"]), expected=409)
        self.context["snapshot"] = release

    def release_draft_revision(self):
        c = self.client()
        r = self.context["snapshot"]
        patched = c.request("PATCH", self.path("releases", r["id"]), {"expectedRevision": 1, "title": "Snapshot edited", "notes": "Persistent notes"})["release"]
        require(patched["revision"] == 2 and patched["steps"] == r["steps"], "draft revision/partial update")
        c.request("PATCH", self.path("releases", r["id"]), {"expectedRevision": 1, "notes": "stale"}, 409)
        c.request("POST", self.path("releases"), {"environmentId": r["environmentId"], "title": "Duplicate version", "versionLabel": r["versionLabel"], "steps": [step("one")]}, 409)
        submitted = c.request("POST", self.path("releases", r["id"]) + "/submit", {"expectedRevision": 2})["release"]
        require(submitted["status"] == "ready" and submitted["revision"] == 3, "submit did not freeze ready plan")
        c.request("PATCH", self.path("releases", r["id"]), {"expectedRevision": 3, "notes": "forbidden"}, 409)

    def approval_separation_roles(self):
        c = self.client()
        own = self.release("Self approval", environment=self.context["prod"], actor="admin")
        own = self.client("admin").request("POST", self.path("releases", own["id"]) + "/submit", {"expectedRevision": 1})["release"]
        require(own["status"] == "awaiting_approval", "protected submission bypassed approval")
        self.client("admin").request("POST", self.path("releases", own["id"]) + "/approve", {"expectedRevision": 2, "decision": "approve", "comment": "self"}, 409)
        release = self.release("Approved deployment", environment=self.context["prod"])
        release = c.request("POST", self.path("releases", release["id"]) + "/submit", {"expectedRevision": 1})["release"]
        c.request("POST", self.path("releases", release["id"]) + "/run", {}, 409, headers={"Idempotency-Key": "unapproved"})
        c.request("POST", self.path("releases", release["id"]) + "/approve", {"expectedRevision": 2, "decision": "approve", "comment": "operator"}, 403)
        approved = self.client("admin").request("POST", self.path("releases", release["id"]) + "/approve", {"expectedRevision": 2, "decision": "approve", "comment": "Independent approval"})["release"]
        require(approved["status"] == "ready" and approved["revision"] == 3 and approved["approvals"][0]["actorId"] == "admin", "approval record missing")
        self.context["approved"] = approved

    def approval_rejection_history(self):
        r = self.release("Rejected deployment", environment=self.context["prod"])
        path = self.path("releases", r["id"])
        self.client().request("POST", path + "/submit", {"expectedRevision": 1})
        self.client("admin").request("POST", path + "/approve", {"expectedRevision": 2, "decision": "reject", "comment": " "}, 400)
        rejected = self.client("admin").request("POST", path + "/approve", {"expectedRevision": 2, "decision": "reject", "comment": "Need safer checks"})["release"]
        require(rejected["status"] == "draft" and rejected["revision"] == 3 and rejected["approvals"][0]["decision"] == "reject", "reject did not return draft/history")
        edited = self.client().request("PATCH", path, {"expectedRevision": 3, "notes": "Addressed review"})["release"]
        submitted = self.client().request("POST", path + "/submit", {"expectedRevision": edited["revision"]})["release"]
        approved = self.client("admin").request("POST", path + "/approve", {"expectedRevision": submitted["revision"], "decision": "approve", "comment": "Fixed"})["release"]
        require([a["decision"] for a in approved["approvals"]] == ["reject", "approve"], "approval history not retained")

    def run_idempotent_concurrency(self):
        r = self.context["approved"]
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda _: self.run(r, "api-identical-run"), range(4)))
        require(all(response == responses[0] for response in responses), "concurrent exact run replay changed receipt")
        require(len(self.jobs(r)) == len(r["steps"]), "duplicate admitted jobs")
        self.client().request("POST", self.path("releases", r["id"]) + "/run", {}, 409, headers={"Idempotency-Key": "different-run"})
        other = self.release("Receipt conflict", ready=True)
        self.client().request("POST", self.path("releases", other["id"]) + "/run", {}, 409, headers={"Idempotency-Key": "api-identical-run"})
        self.context["receipt"], self.context["receiptResponse"] = r, responses[0]

    def dag_order_worker_bound(self):
        steps = [step("root-a", duration=500), step("root-b", duration=500), step("root-c", duration=500), step("join", ["root-a", "root-b", "root-c"], duration=150)]
        a, b = self.release("Bounded A", steps, ready=True), self.release("Bounded B", steps, ready=True)
        self.run(a); self.run(b)
        observed = []
        until = time.monotonic() + 15
        while time.monotonic() < until:
            jobs = self.client().request("GET", "/api/jobs")["jobs"]
            running = [job for job in jobs if job["status"] == "running"]
            observed.append(len(running))
            require(len(running) <= 2, "global WORKER_LIMIT=2 exceeded")
            if all(self.client().request("GET", self.path("releases", r["id"]))["release"]["status"] == "succeeded" for r in (a, b)):
                break
            time.sleep(0.035)
        require(max(observed) >= 1, "no running worker observed")
        for r in (a, b):
            require(self.wait(r, {"succeeded"})["status"] == "succeeded", "DAG completion")
            jobs = self.jobs(r); by_id = {job["id"]: job for job in jobs}
            for job in jobs:
                require(job["attempts"] == 1 and job["status"] == "succeeded", "job started twice")
                require(all(job["startedAt"] >= by_id[dep]["finishedAt"] for dep in job["dependsOn"]), "dependency started before success")
        self.context["successful"] = b

    def failure_blocking_retry(self):
        r = self.release("Retry pipeline", [step("root"), step("flaky", ["root"], failure="once"), step("child", ["flaky"]), step("parallel")], ready=True)
        self.run(r)
        self.wait(r, {"failed"})
        jobs = {job["stepKey"]: job for job in self.jobs(r)}
        require(jobs["flaky"]["status"] == "failed" and jobs["child"]["status"] == "blocked" and jobs["child"]["attempts"] == 0, "failed dependency not blocked")
        preserved = {a["id"] for a in self.artifacts(r)}
        self.client().request("POST", self.path("releases", r["id"]) + "/retry", {})
        self.wait(r, {"succeeded"})
        after = {job["stepKey"]: job for job in self.jobs(r)}
        require(after["root"]["attempts"] == 1 and after["parallel"]["attempts"] == 1 and after["flaky"]["attempts"] == 2 and after["child"]["attempts"] == 1, "retry reran successes or lost attempts")
        require(preserved.issubset({a["id"] for a in self.artifacts(r)}) and len(self.artifacts(r)) == 4, "retry artifact duplication/loss")
        self.context["retry"] = r

    def cancellation_terminal(self):
        r = self.release("Cancelled pipeline", [step("slow", duration=1200), step("tail", ["slow"], duration=150)], ready=True)
        self.run(r)
        until = time.monotonic() + 5
        while not any(j["status"] == "running" for j in self.jobs(r)) and time.monotonic() < until:
            time.sleep(0.02)
        self.client().request("POST", self.path("releases", r["id"]) + "/cancel", {"reason": " "}, 400)
        cancelled = self.client().request("POST", self.path("releases", r["id"]) + "/cancel", {"reason": "Stop synthetic run"})["release"]
        require(cancelled["status"] == "cancelled", "release not cancelled")
        time.sleep(1.35)
        require(all(j["status"] == "cancelled" for j in self.jobs(r)), "late completion overwrote cancellation")
        require(not self.artifacts(r), "cancelled worker produced artifact")
        self.client().request("POST", self.path("releases", r["id"]) + "/retry", {}, 409)
        self.context["cancelled"] = r

    def artifact_bytes_metadata(self):
        r = self.context["retry"]
        artifacts = self.artifacts(r)
        require(len(artifacts) == len(self.jobs(r)) and len({a["jobId"] for a in artifacts}) == len(artifacts), "one artifact per successful job")
        by_id = {j["id"]: j for j in self.jobs(r)}
        for artifact in artifacts:
            content, headers = self.client().request("GET", "/api/artifacts/" + artifact["id"] + "/content", raw=True)
            require(artifact["size"] == len(content) and artifact["sha256"] == hashlib.sha256(content).hexdigest(), "artifact metadata differs from bytes")
            require(r["versionLabel"].encode() in content and by_id[artifact["jobId"]]["stepKey"].encode() in content, "artifact lacks release/step identity")
            require("attachment" in headers.get("Content-Disposition", "") and "/" not in artifact["name"] and "\\" not in artifact["name"], "unsafe artifact filename/download")
        self.client().request("GET", "/api/artifacts/unknown/content", expected=404)

    def job_logs_append_only(self):
        r = self.context["retry"]
        for job in self.jobs(r):
            logs = self.client().request("GET", "/api/jobs/" + job["id"] + "/logs")["logs"]
            require([log["sequence"] for log in logs] == list(range(1, len(logs) + 1)), "noncontiguous log sequence")
            events = [log["event"] for log in logs]
            require(events[0] == "queued" and "started" in events and events[-1] == "succeeded", "required job log events missing")
            if job["stepKey"] == "flaky":
                require(events.count("started") == 2 and "failed" in events, "retry log history lost")
            require(self.client().request("GET", "/api/jobs/" + job["id"])["job"] == job, "job detail differs from list")
        filtered = self.client().request("GET", "/api/jobs?status=succeeded&projectId=" + self.context["project"]["id"])["jobs"]
        require(filtered and all(j["status"] == "succeeded" for j in filtered), "job status filter")

    def rollback_active_history(self):
        env = self.client().request("POST", self.path("environments"), {"name": "Rollback target"}, 201)["environment"]
        one = self.release("Rollback one", environment=env, ready=True); self.run(one); self.wait(one, {"succeeded"})
        self.client("admin").request("POST", self.path("releases", one["id"]) + "/rollback", {"reason": "No predecessor"}, 409)
        two = self.release("Rollback two", environment=env, ready=True); self.run(two); two = self.wait(two, {"succeeded"})
        require(two["previousReleaseId"] == one["id"], "previous active release not captured")
        self.client().request("POST", self.path("releases", two["id"]) + "/rollback", {"reason": "operator"}, 403)
        rolled = self.client("admin").request("POST", self.path("releases", two["id"]) + "/rollback", {"reason": "Synthetic regression"})["release"]
        require(rolled["status"] == "rolled_back", "rollback status")
        current = self.client().request("GET", self.path("environments", env["id"]))["environment"]
        require(current["activeReleaseId"] == one["id"] and self.artifacts(two), "rollback did not restore or lost history")
        self.client("admin").request("POST", self.path("releases", two["id"]) + "/rollback", {"reason": "duplicate"}, 409)
        self.context["rollbackEnv"], self.context["rolled"] = env, two

    def incident_release_boundaries(self):
        c = self.client(); r = self.context["retry"]
        incident = c.request("POST", self.path("incidents"), {"environmentId": r["environmentId"], "releaseId": r["id"], "title": "API synthetic incident", "severity": "sev2", "summary": "Observed synthetic symptom"}, 201)["incident"]
        require(incident["status"] == "open" and incident["version"] == 1 and incident["createdBy"] == "operator", "incident defaults")
        c.request("POST", self.path("incidents"), {"environmentId": self.context["prod"]["id"], "releaseId": r["id"], "title": "Wrong environment", "severity": "sev1"}, 404)
        c.request("POST", self.path("incidents"), {"environmentId": self.context["foreignEnv"]["id"], "title": "Foreign", "severity": "sev1"}, 404)
        self.context["incident"] = incident

    def incident_versions_transitions(self):
        c, i = self.client(), self.context["incident"]
        path = self.path("incidents", i["id"])
        c.request("PATCH", path, {"expectedVersion": 1, "status": "resolved"}, 400)
        mitigated = c.request("PATCH", path, {"expectedVersion": 1, "status": "mitigated"})["incident"]
        require(mitigated["version"] == 2 and mitigated["status"] == "mitigated", "mitigation version")
        c.request("PATCH", path, {"expectedVersion": 1, "title": "stale"}, 409)
        resolved = c.request("PATCH", path, {"expectedVersion": 2, "status": "resolved", "resolution": "Reverted synthetic regression"})["incident"]
        require(resolved["resolvedAt"] and resolved["version"] == 3, "resolution timestamp/version")
        reopened = c.request("PATCH", path, {"expectedVersion": 3, "status": "open"})["incident"]
        require(reopened["resolvedAt"] is None and reopened["status"] == "open", "reopen did not clear resolvedAt")
        found = c.request("GET", self.path("incidents") + "?status=open&severity=sev2&q=SYNTHETIC")["incidents"]
        require(i["id"] in {row["id"] for row in found}, "incident filters missing record")

    def incident_notes_timeline(self):
        c, i = self.client(), self.context["incident"]
        path = self.path("incidents", i["id"])
        c.request("POST", path + "/notes", {"body": " "}, 400)
        c.request("POST", path + "/notes", {"body": "x" * 4001}, 400)
        note = c.request("POST", path + "/notes", {"body": "Synthetic diagnostic note <b>literal</b>"}, 201)["note"]
        require(note["actorId"] == "operator" and note["incidentId"] == i["id"], "note ownership")
        require(note in c.request("GET", path + "/notes")["notes"], "note not durable/readable")
        events = c.request("GET", path + "/timeline")["events"]
        require(len(events) >= 5 and any(note["body"] in event["message"] for event in events), "incident timeline lacks transitions/note")
        require([e["createdAt"] for e in events] == sorted(e["createdAt"] for e in events), "timeline chronology")
        self.context["note"] = note

    def audit_cursor_filters(self):
        c = self.client(); events = c.request("GET", "/api/audit")["events"]
        require(events and len({e["sequence"] for e in events}) == len(events), "audit sequence uniqueness")
        require([e["sequence"] for e in events] == sorted(e["sequence"] for e in events), "audit order")
        require(all(isinstance(e["details"], dict) and e["actorId"] and e["type"] for e in events), "structured audit details")
        cursor = events[len(events) // 2]["sequence"]
        later = c.request("GET", "/api/audit?after=" + str(cursor))["events"]
        require(later == [e for e in events if e["sequence"] > cursor], "exclusive audit cursor")
        chosen = next(e for e in events if e["projectId"] == self.context["project"]["id"])
        filtered = c.request("GET", "/api/audit?projectId=" + chosen["projectId"] + "&type=" + urllib.parse.quote(chosen["type"]))["events"]
        require(filtered and all(e["projectId"] == chosen["projectId"] and e["type"] == chosen["type"] for e in filtered), "audit filters")
        before = events[-1]["sequence"]
        self.run(self.context["receipt"], "api-identical-run")
        require(not c.request("GET", "/api/audit?after=" + str(before))["events"], "idempotent replay appended success audit")
        self.context["auditBeforeRestart"] = events

    def dashboard_export(self):
        c = self.client(); counts = c.request("GET", "/api/dashboard")["counts"]
        projects = c.request("GET", "/api/projects")["projects"]
        environments = [e for p in projects for e in c.request("GET", self.path("environments", project=p["id"]))["environments"]]
        releases = [r for p in projects for r in c.request("GET", self.path("releases", project=p["id"]))["releases"]]
        incidents = [i for p in projects for i in c.request("GET", self.path("incidents", project=p["id"]))["incidents"]]
        require(counts == {"projects": len(projects), "environments": len(environments), "activeReleases": sum(e["activeReleaseId"] is not None for e in environments),
                           "runningJobs": len(c.request("GET", "/api/jobs?status=running")["jobs"]), "openIncidents": sum(i["status"] != "resolved" for i in incidents),
                           "failedReleases": sum(r["status"] == "failed" for r in releases)}, "dashboard counts not actual persisted state")
        export = c.request("GET", "/api/projects/" + self.context["project"]["id"] + "/export")
        require(set(export) == {"project", "environments", "runbooks", "releases", "incidents"} and export["project"]["id"] == self.context["project"]["id"], "project export contract")
        require(self.context["retry"]["id"] in {r["id"] for r in export["releases"]}, "export missing release")
        self.context["export"] = export

    def restart_persistence(self):
        before_jobs = self.jobs(self.context["retry"]); before_artifacts = self.artifacts(self.context["retry"])
        self.server.stop()
        database = Path(self.server.env["DATA_DIR"]) / "harbor.sqlite"
        require(database.is_file() and database.read_bytes().startswith(b"SQLite format 3\0"), "required durable harbor.sqlite is not a SQLite database")
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            require(connection.execute("PRAGMA integrity_check").fetchone() == ("ok",), "durable SQLite integrity check failed")
            require(connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0] > 0, "durable SQLite has no application tables")
        self.server.start()
        require(self.client().request("GET", "/api/session")["actor"]["id"] == "operator", "session lost on restart")
        require(self.client().request("GET", "/api/projects/" + self.context["project"]["id"] + "/export") == self.context["export"], "business data changed across restart")
        require(self.jobs(self.context["retry"]) == before_jobs and self.artifacts(self.context["retry"]) == before_artifacts, "completed jobs/artifacts reran after restart")
        require(self.context["note"] in self.client().request("GET", self.path("incidents", self.context["incident"]["id"]) + "/notes")["notes"], "note lost across restart")

    def restart_running_recovery(self):
        prior_events = self.client().request("GET", "/api/audit")["events"]
        prior_sequence = max((event["sequence"] for event in prior_events), default=0)
        r = self.release("Recovered pipeline", [step("running-one", duration=1800), step("running-two", duration=1800), step("queued-tail", ["running-one", "running-two"])], ready=True)
        self.run(r)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            before = self.jobs(r)
            if sum(j["status"] == "running" for j in before) == 2:
                break
            time.sleep(0.02)
        running = {j["id"] for j in before if j["status"] == "running"}
        require(len(running) == 2, "could not observe two persisted running jobs before crash")
        self.server.stop(); self.server.start()
        self.wait(r, {"succeeded"}, 15)
        jobs = self.jobs(r)
        for job in jobs:
            if job["id"] in running:
                require(job["recoveryCount"] >= 1 and job["attempts"] >= 2, "running job not recovered with preserved attempt history")
                logs = self.client().request("GET", "/api/jobs/" + job["id"] + "/logs")["logs"]
                require(any(log["event"] == "recovered" for log in logs), "recovery log missing")
            else:
                require(job["attempts"] == 1, "queued job ran twice after restart")
        require(len(self.artifacts(r)) == 3 and len({a["jobId"] for a in self.artifacts(r)}) == 3, "recovery duplicated artifacts")
        audit = self.client().request("GET", "/api/audit?after=" + str(prior_sequence))["events"]
        require(any("recover" in e["type"] for e in audit), "recovery audit missing")

    def restart_idempotency_receipt(self):
        require(self.run(self.context["receipt"], "api-identical-run") == self.context["receiptResponse"], "durable receipt changed after restart")
        self.client().request("POST", self.path("releases", self.context["receipt"]["id"]) + "/run", {"unexpected": True}, 409,
                              headers={"Idempotency-Key": "api-identical-run"})

    def cross_project_boundaries(self):
        c = self.client(); foreign = self.context["foreign"]["id"]
        foreign_book = c.request("POST", self.path("runbooks", project=foreign), {"name": "Foreign plan", "steps": [step("foreign")]}, 201)["runbook"]
        c.request("POST", self.path("releases"), {"environmentId": self.context["foreignEnv"]["id"], "title": "Foreign release", "versionLabel": "foreign", "steps": [step("check")]}, 404)
        c.request("POST", self.path("releases"), {"environmentId": self.context["stage"]["id"], "title": "Foreign plan release", "versionLabel": "foreign-plan", "runbookId": foreign_book["id"]}, 404)
        c.request("GET", self.path("runbooks", foreign_book["id"]), expected=404)
        c.request("GET", self.path("releases", self.context["retry"]["id"], project=foreign), expected=404)
        c.request("PATCH", self.path("incidents", self.context["incident"]["id"], project=foreign), {"expectedVersion": 4, "title": "foreign"}, 404)
        c.request("GET", self.path("releases", self.context["retry"]["id"], project=foreign) + "/jobs", expected=404)
        c.request("GET", self.path("releases", self.context["retry"]["id"], project=foreign) + "/artifacts", expected=404)
        self.client("viewer").request("POST", self.path("incidents", self.context["incident"]["id"]) + "/notes", {"body": "forbidden"}, 403)
        self.client("viewer").request("POST", self.path("releases", self.context["retry"]["id"]) + "/retry", {}, 403)
        self.client("viewer").request("POST", self.path("environments"), {"name": "Forbidden environment"}, 403)
        self.client("viewer").request("POST", self.path("runbooks"), {"name": "Forbidden plan", "steps": [step("forbidden")]}, 403)
        self.client("viewer").request("POST", self.path("releases"), {"environmentId": self.context["stage"]["id"], "title": "Forbidden release", "versionLabel": "forbidden", "steps": [step("forbidden")]}, 403)
        self.client("viewer").request("POST", self.path("incidents"), {"environmentId": self.context["stage"]["id"], "title": "Forbidden incident", "severity": "sev1"}, 403)

    def invalid_inputs_no_partial_writes(self):
        c = self.client(); before = c.request("GET", "/api/projects")["projects"]
        for body in ({"name": " ", "slug": "white"}, {"name": "Bad slug", "slug": "UPPER"}, {"name": "Short", "slug": "a"}):
            c.request("POST", "/api/projects", body, 400)
        require(c.request("GET", "/api/projects")["projects"] == before, "invalid project wrote state")
        c.request("POST", self.path("incidents"), {"environmentId": self.context["stage"]["id"], "title": "Bad severity", "severity": "critical"}, 400)
        c.request("POST", self.path("releases"), {"environmentId": self.context["stage"]["id"], "title": " ", "versionLabel": "invalid", "steps": [step("check")]}, 400)
        for body in ({"environmentId": self.context["stage"]["id"], "title": "Missing plan", "versionLabel": "missing-plan"},
                     {"environmentId": self.context["stage"]["id"], "title": "Two plans", "versionLabel": "two-plans", "runbookId": "missing", "steps": [step("check")]}):
            c.request("POST", self.path("releases"), body, 400)
        env_path = self.path("environments", self.context["stage"]["id"])
        original = c.request("GET", env_path)["environment"]
        try:
            changed = c.request("PATCH", env_path, {"activeReleaseId": "client-override"})["environment"]
            require(changed["activeReleaseId"] == original["activeReleaseId"], "client changed active deployment")
        except AssertionError as error:
            if "wanted 200, got 400" not in str(error):
                raise
        request = urllib.request.Request(self.base + "/api/projects", data=b"{broken", method="POST", headers={"Content-Type": "application/json", "Cookie": c.cookie})
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        require(response.status == 400 and json.loads(response.read()).get("error"), "malformed JSON did not return structured 400")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "bun", "node", "playwright-module", "chrome"):
        parser.add_argument("--" + name, type=Path, required=True)
    options = parser.parse_args(argv)
    options.app, options.out = options.app.resolve(), options.out.resolve()
    require(options.app.is_dir() and not options.out.exists() and not options.out.is_relative_to(options.app)
            and not options.app.is_relative_to(options.out), "new separate output and existing app required")
    options.out.mkdir(parents=True)
    report = new_report(); by_name = {row["name"]: row for row in report["checks"]}
    started = time.monotonic(); server = None
    try:
        before = source_manifest(options.app)
        report["sourceBefore"] = before
        home = options.out / "isolated-home"; home.mkdir()
        data = options.out / "data"; data.mkdir()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0)); port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        env = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP"}}
        env.update({"HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "AppData/Roaming"),
                    "LOCALAPPDATA": str(home / "AppData/Local"), "DATA_DIR": str(data), "PORT": str(port),
                    "WORKER_LIMIT": "2", "CI": "1", "DO_NOT_TRACK": "1", "BUN_CONFIG_NO_CLEAR_TERMINAL": "1"})
        layout_process = execute([str(options.node.resolve()), str(ROOT / "layout-probe.cjs"), str(options.app)],
                                 options.app, env, options.out / "layout-probe", 30)
        report["layoutProcess"] = layout_process
        layout_valid = False
        try:
            require(layout_process["exitCode"] == 0 and not layout_process["timedOut"], "Vite declaration probe failed")
            report["buildDeclaration"] = validate_layout(options.app, json.loads((options.out / "layout-probe.stdout.log").read_text(encoding="utf-8")))
            layout_valid = True
        except Exception as error:
            report["instrumentError"] = "Build declaration needs review: " + str(error)[:700]
        report["build"] = {}
        for name in ("typecheck", "build"):
            process = execute([str(options.bun.resolve()), "--no-env-file", "run", name], options.app, env, options.out / name, 120)
            report["build"][name] = process
            by_name["prerequisite:" + name].update(status="passed" if process["exitCode"] == 0 and not process["timedOut"] else "failed")
        if all(by_name["prerequisite:" + name]["status"] == "passed" for name in ("typecheck", "build")):
            server = Server(options.app, options.out, options.bun.resolve(), env, base)
            try:
                server.start(); by_name["prerequisite:startup"]["status"] = "passed"
            except Exception as error:
                by_name["prerequisite:startup"].update(status="failed", error=str(error)[:700])
            if by_name["prerequisite:startup"]["status"] == "passed":
                suite = Suite(base, server)
                for name in API_GROUPS:
                    row = by_name["api:" + name]; begin = time.monotonic()
                    try:
                        getattr(suite, name)(); row["status"] = "passed"
                    except KeyError as error:
                        row.update(status="not_run", error="Earlier fixture unavailable: " + str(error))
                    except Exception as error:
                        row.update(status="failed", error=type(error).__name__ + ": " + str(error)[:1000])
                    row["wallMs"] = round((time.monotonic() - begin) * 1000, 3)
                    (options.out / "api-progress.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
                browser_out = options.out / "browser"; browser_out.mkdir()
                process = execute([str(options.node.resolve()), str(ROOT / "browser-eval.cjs"), "--base", base,
                    "--out", str(browser_out), "--playwright-module", str(options.playwright_module.resolve()),
                    "--chrome", str(options.chrome.resolve())], options.app, env, options.out / "browser-process", 420)
                report["browserProcess"] = process
                try:
                    browser = json.loads((browser_out / "browser.json").read_text(encoding="utf-8"))
                    for row in validate_browser(browser, process):
                        by_name["browser:" + row["name"]].update({key: value for key, value in row.items() if key != "name"})
                    report["browserEvidence"] = {key: browser.get(key) for key in ("screenshots", "consoleErrors", "blockedRequests")}
                except Exception as error:
                    report["instrumentError"] = "Browser evidence invalid: " + str(error)[:1000]
        else:
            by_name["prerequisite:startup"].update(status="failed", error="Required typecheck/build did not pass; application not started")
    except Exception as error:
        report["instrumentError"] = type(error).__name__ + ": " + str(error)[:1000]
    finally:
        if server:
            server.stop()
        try:
            after = source_manifest(options.app)
            report["sourceAfter"] = after
            if "sourceBefore" in report and locals().get("layout_valid", False):
                report["sourceIntegrityStatus"] = "unchanged" if after == report["sourceBefore"] else "modified"
                by_name["prerequisite:source_integrity"]["status"] = "passed" if after == report["sourceBefore"] else "failed"
        except Exception as error:
            report["instrumentError"] = "Source inventory failed: " + str(error)[:1000]
        report["wallMs"] = round((time.monotonic() - started) * 1000, 3)
        finalize(report)
        (options.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("verdict", "summary", "sourceIntegrityStatus", "wallMs")}))
    return {"passed": 0, "product_failure": 1, "instrument_failure": 2}[report["verdict"]]


if __name__ == "__main__":
    raise SystemExit(main())
