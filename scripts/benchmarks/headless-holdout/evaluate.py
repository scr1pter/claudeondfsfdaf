"""Independent local headless acceptance gate. No providers, browser or dependencies.

The Node mode is authoring prequalification only. Runtime qualification requires
an explicitly supplied Bun executable and proves Bun is actually the runtime.
Every child is directly owned; cleanup never enumerates or kills other PIDs.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

import owned_process

HERE = Path(__file__).resolve().parent
HEADER = "op,external_id,name,email\n"
CSV = HEADER + "upsert,one,Ada,ada@example.test\n"
GROUPS = []


def need(value, message="acceptance assertion failed"):
    if not value:
        raise AssertionError(message)


def group(name):
    def register(function):
        GROUPS.append((name, function))
        return function
    return register


def environment():
    allowed = ("SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC", "PATHEXT")
    return {key: os.environ[key] for key in allowed if key in os.environ}


class Service:
    def __init__(self, options, folder=None):
        self.options = options
        self.temp = tempfile.TemporaryDirectory(prefix="relay-gate-") if folder is None else None
        self.folder = Path(self.temp.name) if self.temp else Path(folder)
        self.data = self.folder / "data"
        self.data.mkdir(exist_ok=True)
        self.root = "synthetic-root-" + uuid.uuid4().hex
        self.env = {**environment(), "RELAY_BOOTSTRAP_TOKEN": self.root}
        self.process = None
        self.owned = None
        self.readers = []
        self.output = []
        self.start()

    def start(self, expect_ready=True):
        self.lines = queue.Queue()
        lines = self.lines
        self.owned = owned_process.spawn([str(self.options.runtime), str(self.options.app / "app.mjs"),
            "--data", str(self.data), "--port", "0"], cwd=self.options.app, env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        self.process = self.owned.process
        def read(stream, ready=False):
            try:
                for line in stream:
                    self.output.append(line)
                    if ready:
                        lines.put(line)
            except (OSError, ValueError):
                pass
            finally:
                if ready:
                    lines.put(None)
        self.readers = [threading.Thread(target=read, args=(self.process.stdout, True), daemon=True),
                        threading.Thread(target=read, args=(self.process.stderr,), daemon=True)]
        for reader in self.readers:
            reader.start()
        if not expect_ready:
            try:
                line = self.lines.get(timeout=2)
            except queue.Empty:
                line = None
            need(not line or not json.loads(line).get("ready"), "unsafe startup announced readiness")
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                raise AssertionError("unsafe startup did not fail promptly")
            need(self.process.returncode != 0, "unsafe startup exited successfully")
            return
        try:
            line = self.lines.get(timeout=5)
            ready = json.loads(line or "null")
            need(isinstance(ready, dict) and ready.get("ready") is True and isinstance(ready.get("port"), int)
                 and 0 < ready["port"] < 65536, "missing ready contract")
            self.url = "http://127.0.0.1:" + str(ready["port"])
        except Exception:
            self.stop(abrupt=True)
            raise

    def stop(self, abrupt=False):
        if self.process is None:
            return
        try:
            if self.process.poll() is None and not abrupt:
                try:
                    self.process.stdin.write("shutdown\n")
                    self.process.stdin.flush()
                    self.process.wait(timeout=5)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
        finally:
            self.owned.close()
            for reader in self.readers:
                reader.join(timeout=5)
            need(not any(reader.is_alive() for reader in self.readers), "owned output reader did not close")

    def close(self, abrupt=False):
        self.stop(abrupt)
        if self.temp:
            self.temp.cleanup()

    def request(self, method, path, body=None, token=None, key=None, raw=None, content_type="application/json"):
        headers = {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if key is not None:
            headers["Idempotency-Key"] = key
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as response:
            status, payload = response.code, response.read()
        try:
            result = json.loads(payload)
        except (ValueError, UnicodeError):
            raise AssertionError("non-JSON HTTP result")
        if status >= 400:
            need(isinstance(result, dict) and isinstance(result.get("error"), dict)
                 and isinstance(result["error"].get("code"), str), "missing structured error")
        return status, result

    def fixture(self):
        self.ws = "w-" + uuid.uuid4().hex[:12]
        status, result = self.request("POST", "/v1/workspaces", {"id": self.ws, "name": "Synthetic roster"}, self.root)
        need(status == 201, "workspace creation")
        self.owner = result["ownerToken"]
        self.base = "/v1/workspaces/" + self.ws
        self.tokens = {}
        self.ids = {}
        for role in ("editor", "approver", "worker", "viewer"):
            self.issue(role, role)
        return self

    def issue(self, subject, role):
        status, value = self.request("POST", self.base + "/tokens", {"subject": subject, "role": role}, self.owner)
        need(status == 200, "capability issuance")
        need(isinstance(value.get("token"), str) and bool(value["token"]), "opaque capability")
        self.tokens[subject], self.ids[subject] = value["token"], value["id"]
        return value["token"]

    def get(self, tail, who="viewer"):
        return self.request("GET", self.base + tail, token=self.owner if who == "owner" else self.tokens[who])

    def post(self, tail, body=None, who="editor", key=None):
        return self.request("POST", self.base + tail, {} if body is None else body,
            self.owner if who == "owner" else self.tokens[who], key)

    def stage(self, csv=CSV, version=None, key=None, who="editor"):
        if version is None:
            version = self.get("/members")[1]["version"]
        status, result = self.post("/imports", {"baseVersion": version, "csv": csv}, who, key or uuid.uuid4().hex)
        need(status == 201, "import staging")
        return result["import"]

    def approved(self, csv=CSV, version=None, who="editor"):
        item = self.stage(csv, version, who=who)
        need(self.post("/imports/" + item["id"] + "/approve", who="approver")[0] == 200, "approval")
        return item

    def claim(self, item, who="worker", lease=5000):
        status, result = self.post("/imports/" + item["id"] + "/claim", {"leaseMs": lease}, who)
        need(status == 200, "worker claim")
        return result

    def commit(self, item, lease, who="worker", key=None):
        return self.post("/imports/" + item["id"] + "/commit", {"leaseToken": lease["leaseToken"]}, who, key or uuid.uuid4().hex)

    def applied(self, csv=CSV):
        item = self.approved(csv)
        lease = self.claim(item)
        status, result = self.commit(item, lease)
        need(status == 200, "commit")
        return item, lease, result

    def events(self):
        status, result = self.get("/events?limit=100")
        need(status == 200, "event read")
        return result["events"]

    def cli(self, args, token=None):
        return owned_process.run([str(self.options.runtime), str(self.options.app / "cli.mjs"), *args],
            cwd=self.options.app, env={**environment(), "RELAY_URL": self.url,
            "RELAY_TOKEN": self.tokens["editor"] if token is None else token}, capture_output=True,
            text=True, encoding="utf-8", timeout=8)


@group("workspace-validation-and-uniqueness")
def g01(s):
    for identifier in ("aa", "UPPER", "../escape", "a" * 25):
        need(s.request("POST", "/v1/workspaces", {"id": identifier, "name": "x"}, s.root)[0] == 400)
    need(s.request("POST", "/v1/workspaces", {"id": s.ws, "name": "other"}, s.root)[0] == 409)
    need(s.request("POST", "/v1/workspaces", {"id": "constructor", "name": "Valid boundary ID"}, s.root)[0] == 201)


@group("initial-directory-and-workspace-reads")
def g02(s):
    need(s.get("/members")[1] == {"version": 0, "members": []})
    need(s.get("")[1]["workspace"]["id"] == s.ws)
    need(s.get("/imports")[1] == {"imports": []})


@group("authentication-and-body-transport-boundaries")
def g03(s):
    for token in (None, "unknown", s.root):
        need(s.request("GET", s.base + "/members", token=token)[0] == 401)
    need(s.request("POST", s.base + "/imports", token=s.tokens["editor"], raw=b"{", key="bad")[0] == 400)
    need(s.request("POST", s.base + "/imports", token=s.tokens["editor"], raw=b"\xff", key="bad")[0] == 400)
    need(s.request("POST", s.base + "/imports", token=s.tokens["editor"], raw=b"{}", content_type="text/plain")[0] == 415)
    need(s.request("POST", s.base + "/imports", token=s.tokens["editor"], raw=b" " * 262145)[0] == 413)
    need(s.request("GET", "/health")[1] == {"ok": True})


@group("tenant-isolation-on-reads-and-writes")
def g04(s):
    other = "z-" + uuid.uuid4().hex[:12]
    need(s.request("POST", "/v1/workspaces", {"id": other, "name": "Other"}, s.root)[0] == 201)
    for method, tail, body in (("GET", "/members", None), ("GET", "/events", None),
                               ("POST", "/imports", {"baseVersion": 0, "csv": CSV})):
        need(s.request(method, "/v1/workspaces/" + other + tail, body, s.owner, "foreign")[0] == 403)


@group("capability-issuance-validation")
def g05(s):
    for body in ({"subject": "x", "role": "admin"}, {"subject": "../x", "role": "editor"},
                 {"subject": "", "role": "viewer"}):
        need(s.post("/tokens", body, "owner")[0] == 400)
    first = s.issue("another", "viewer")
    second = s.issue("another", "viewer")
    need(first != second)


@group("roles-cannot-cross-mutation-boundaries")
def g06(s):
    for role in s.tokens:
        need(s.post("/tokens", {"subject": "bad", "role": "worker"}, role)[0] == 403)
    for role in ("viewer", "approver", "worker"):
        need(s.post("/imports", {"baseVersion": 0, "csv": CSV}, role, "forbidden")[0] == 403)


@group("revocation-and-repeat-event-accounting")
def g07(s):
    before = len(s.events())
    for _ in range(2):
        need(s.post("/tokens/" + s.ids["viewer"] + "/revoke", who="owner")[0] == 200)
    need(s.get("/members")[0] == 401)
    status, result = s.get("/events?limit=100", "owner")
    need(status == 200 and len(result["events"]) == before + 1)


@group("staging-metadata-digest-and-redaction")
def g08(s):
    item = s.stage()
    need(item["state"] == "staged" and item["baseVersion"] == 0 and item["rowCount"] == 1)
    need(item["digest"] == hashlib.sha256(CSV.encode()).hexdigest())
    need(item["creator"] == "editor" and item["workspaceId"] == s.ws and item["approvedBy"] is None and item["leaseEpoch"] == 0)
    need(set(item) == {"id", "workspaceId", "creator", "baseVersion", "state", "rowCount", "digest", "leaseEpoch", "approvedBy"})


@group("csv-bom-crlf-quotes-and-normalization")
def g09(s):
    csv = '\ufeffop,external_id,name,email\r\nupsert,q," Ada, ""Q"" ",ADA@EXAMPLE.TEST\r\n'
    s.applied(csv)
    member = s.get("/members")[1]["members"][0]
    need(member == {"externalId": "q", "name": 'Ada, "Q"', "email": "ada@example.test", "revision": 1})


@group("csv-malformed-shape-rejected-atomically")
def g10(s):
    for csv in ('op,external_id,name,email\nupsert,a,"broken,a@x.test\n',
                HEADER + 'upsert,a,A,a@x.test,extra\n', HEADER + 'upsert,a,A\n',
                HEADER + '\nupsert,a,A,a@x.test\n', 'name,email\nA,a@x.test\n'):
        need(s.post("/imports", {"baseVersion": 0, "csv": csv}, key=uuid.uuid4().hex)[0] == 400)
    need(s.get("/imports")[1]["imports"] == [])


@group("csv-duplicate-identities-and-operation-validation")
def g11(s):
    for csv in (CSV + 'delete,one,,\n', HEADER + 'merge,a,A,a@x.test\n', HEADER + 'delete,a,A,a@x.test\n'):
        need(s.post("/imports", {"baseVersion": 0, "csv": csv}, key=uuid.uuid4().hex)[0] == 400)


@group("csv-field-validation-and-control-characters")
def g12(s):
    for row in ('upsert,../a,A,a@x.test', 'upsert,a,,a@x.test', 'upsert,a,A,broken',
                'upsert,a,A,a@@x.test', 'upsert,a,A,a@nodot', 'upsert,a,A,a @x.test',
                'upsert,a,A, a@x.test', 'upsert,a,A,a@x.test ', 'upsert,a,A,a@x.test\t',
                'upsert,a,"A\tB",a@x.test', 'upsert,a,' + 'a' * 81 + ',a@x.test'):
        need(s.post("/imports", {"baseVersion": 0, "csv": HEADER + row + "\n"}, key=uuid.uuid4().hex)[0] == 400)


@group("import-row-and-byte-bounds")
def g13(s):
    for csv in (HEADER, HEADER + ''.join(f'upsert,a{i},A,a{i}@x.test\n' for i in range(501)), 'x' * 65537):
        need(s.post("/imports", {"baseVersion": 0, "csv": csv}, key=uuid.uuid4().hex)[0] in (400, 413))


@group("stage-base-version-is-optimistic-concurrency-boundary")
def g14(s):
    for version in (-1, True, "0", .5):
        need(s.post("/imports", {"baseVersion": version, "csv": CSV}, key=uuid.uuid4().hex)[0] == 400)
    need(s.post("/imports", {"baseVersion": 1, "csv": CSV}, key="future")[0] == 409)


@group("stage-replay-is-canonical-and-event-free")
def g15(s):
    item = s.stage(key="exact")
    count = len(s.events())
    status, value = s.post("/imports", {"csv": CSV, "baseVersion": 0}, key="exact")
    need(status == 200 and value["import"] == item and len(s.events()) == count)


@group("stage-key-conflict-and-subject-scope")
def g16(s):
    first = s.stage(key="shared")
    need(s.post("/imports", {"baseVersion": 0, "csv": CSV + 'upsert,two,T,t@x.test\n'}, key="shared")[0] == 409)
    s.issue("editor2", "editor")
    need(s.stage(key="shared", who="editor2")["id"] != first["id"])
    for key in (None, "", "a b", "x" * 81):
        need(s.post("/imports", {"baseVersion": 0, "csv": CSV}, key=key)[0] == 400)


@group("staged-and-approved-data-remain-unapplied")
def g17(s):
    s.approved()
    need(s.get("/members")[1] == {"version": 0, "members": []})


@group("separation-of-duty-including-owner")
def g18(s):
    item = s.stage(who="owner")
    need(s.post("/imports/" + item["id"] + "/approve", who="owner")[0] == 403)
    authored = s.stage()
    s.issue("editor", "approver")
    # A capability's subject, rather than token identity, defines separation.
    need(s.post("/imports/" + authored["id"] + "/approve", who="editor")[0] == 403)
    other = s.stage(who="owner")
    need(s.post("/imports/" + other["id"] + "/approve", who="editor")[0] == 200)


@group("approval-repeat-and-other-approver-conflict")
def g19(s):
    item = s.approved()
    count = len(s.events())
    need(s.post("/imports/" + item["id"] + "/approve", who="approver")[0] == 200)
    need(len(s.events()) == count)
    need(s.post("/imports/" + item["id"] + "/approve", who="owner")[0] == 409)


@group("rejection-reason-and-terminal-state")
def g20(s):
    item = s.stage()
    tail = "/imports/" + item["id"]
    need(s.post(tail + "/reject", {"reason": " "}, "approver")[0] == 400)
    need(s.post(tail + "/reject", {"reason": "Invalid source"}, "approver")[0] == 200)
    need(s.post(tail + "/approve", who="approver")[0] == 409)
    need(s.post(tail + "/claim", {"leaseMs": 1000}, "worker")[0] == 409)


@group("cancel-authority-and-lease-invalidation")
def g21(s):
    item = s.approved()
    lease = s.claim(item)
    tail = "/imports/" + item["id"]
    s.issue("editor2", "editor")
    for who in ("viewer", "worker", "editor2"):
        need(s.post(tail + "/cancel", who=who)[0] == 403)
    need(s.post(tail + "/cancel")[0] == 200)
    need(s.commit(item, lease)[0] == 409)
    need(s.get(tail)[1]["import"]["state"] == "cancelled")


@group("claims-require-worker-and-approved-state")
def g22(s):
    item = s.stage()
    tail = "/imports/" + item["id"] + "/claim"
    need(s.post(tail, {"leaseMs": 1000}, "worker")[0] == 409)
    for who in ("owner", "editor", "approver", "viewer"):
        need(s.post(tail, {"leaseMs": 1000}, who)[0] == 403)


@group("simultaneous-claims-have-one-winner")
def g23(s):
    item = s.approved()
    s.issue("worker2", "worker")
    def claim(who):
        return s.post("/imports/" + item["id"] + "/claim", {"leaseMs": 5000}, who)[0]
    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = list(pool.map(claim, ("worker", "worker2")))
    need(sorted(codes) == [200, 409])


@group("lease-bounds-expiry-and-reclaim")
def g24(s):
    item = s.approved()
    for lease in (99, 5001, True, "100", -1):
        need(s.post("/imports/" + item["id"] + "/claim", {"leaseMs": lease}, "worker")[0] == 400)
    first = s.claim(item, lease=5000)
    need(s.post("/imports/" + item["id"] + "/claim", {"leaseMs": 100}, "worker")[0] == 409)
    expiring = s.approved(HEADER + 'upsert,two,Two,two@example.test\n')
    first = s.claim(expiring, lease=100)
    time.sleep(.16)
    second = s.claim(expiring)
    need(second["import"]["leaseEpoch"] == first["import"]["leaseEpoch"] + 1)


@group("lease-epoch-fences-old-token")
def g25(s):
    item = s.approved()
    first = s.claim(item, lease=100)
    time.sleep(.16)
    second = s.claim(item)
    need(second["leaseToken"] != first["leaseToken"])
    need(s.commit(item, first)[0] == 409)
    need(s.commit(item, second)[0] == 200)


@group("lease-cannot-be-used-by-another-worker")
def g26(s):
    item = s.approved()
    lease = s.claim(item)
    s.issue("worker2", "worker")
    need(s.commit(item, lease, "worker2")[0] == 409)
    need(s.get("/members")[1]["version"] == 0)


@group("lease-binds-precise-capability-not-just-subject")
def g27(s):
    item = s.approved()
    lease = s.claim(item)
    old = s.tokens["worker"]
    s.issue("worker", "worker")
    need(s.commit(item, lease)[0] == 409)
    s.tokens["worker"] = old
    need(s.commit(item, lease)[0] == 200)


@group("revoked-worker-cannot-use-admitted-lease")
def g28(s):
    item = s.approved()
    lease = s.claim(item)
    need(s.post("/tokens/" + s.ids["worker"] + "/revoke", who="owner")[0] == 200)
    need(s.commit(item, lease)[0] == 401)
    need(s.get("/members")[1]["version"] == 0)
    # A complete request must not retain authority checked before its body
    # arrived. Revocation is durably acknowledged while this body is incomplete.
    s.issue("delayed", "worker")
    pending = s.approved()
    ticket = s.claim(pending, "delayed")
    wire = json.dumps({"leaseToken": ticket["leaseToken"]}).encode()
    connection = http.client.HTTPConnection("127.0.0.1", int(s.url.rsplit(":", 1)[1]), timeout=5)
    try:
        connection.putrequest("POST", s.base + "/imports/" + pending["id"] + "/commit")
        for key, value in {"Authorization": "Bearer " + s.tokens["delayed"], "Content-Type": "application/json",
                           "Content-Length": str(len(wire)), "Idempotency-Key": "delayed-authority"}.items():
            connection.putheader(key, value)
        connection.endheaders()
        connection.send(wire[:5])
        time.sleep(.08)
        need(s.post("/tokens/" + s.ids["delayed"] + "/revoke", who="owner")[0] == 200)
        count = len(s.events())
        connection.send(wire[5:])
        response = connection.getresponse()
        response.read()
        need(response.status == 401 and s.get("/members")[1]["version"] == 0 and len(s.events()) == count)
    finally:
        connection.close()


@group("commit-lifecycle-member-revisions-and-delete")
def g29(s):
    item, lease, result = s.applied()
    need(result["version"] == 1 and result["applied"] == 1 and result["import"]["state"] == "committed")
    s.applied(HEADER + 'upsert,one,Updated,ada@example.test\nupsert,two,Two,two@example.test\n')
    need(s.get("/members")[1]["members"][0]["revision"] == 2)
    s.applied(HEADER + 'delete,one,,\n')
    need(s.get("/members")[1] == {"version": 3, "members": [{"externalId": "two", "name": "Two", "email": "two@example.test", "revision": 1}]})
    need(s.post("/imports/" + item["id"] + "/claim", {"leaseMs": 1000}, "worker")[0] == 409)
    s.applied(HEADER + 'upsert,__proto__,Proto,proto@x.test\nupsert,constructor,Construct,construct@x.test\n')
    ids = [member["externalId"] for member in s.get("/members")[1]["members"]]
    need(ids == ["__proto__", "constructor", "two"])


@group("commit-replay-remains-exactly-once-after-expiry")
def g30(s):
    item = s.approved()
    lease = s.claim(item, lease=500)
    first = s.commit(item, lease, key="commit-once")
    count = len(s.events())
    time.sleep(.55)
    second = s.commit(item, lease, key="commit-once")
    need(first[0] == 200 and second == first and len(s.events()) == count)
    need(s.get("/members")[1]["version"] == 1)


@group("commit-replay-conflicts-on-body-and-worker")
def g31(s):
    item = s.approved()
    lease = s.claim(item)
    need(s.commit(item, lease, key="fixed")[0] == 200)
    need(s.post("/imports/" + item["id"] + "/commit", {"leaseToken": "changed"}, "worker", "fixed")[0] == 409)
    s.issue("worker2", "worker")
    need(s.commit(item, lease, "worker2", "fixed")[0] == 409)
    s.issue("worker", "worker")
    need(s.commit(item, lease, "worker", "fixed")[0] == 409)


@group("expired-uncommitted-lease-cannot-apply")
def g32(s):
    item = s.approved()
    lease = s.claim(item, lease=100)
    time.sleep(.16)
    need(s.commit(item, lease)[0] == 409)
    need(s.get("/members")[1] == {"version": 0, "members": []})


@group("revocation-is-rechecked-before-successful-replay")
def g33(s):
    item = s.approved()
    lease = s.claim(item)
    need(s.commit(item, lease, key="previous-success")[0] == 200)
    need(s.post("/tokens/" + s.ids["worker"] + "/revoke", who="owner")[0] == 200)
    need(s.commit(item, lease, key="previous-success")[0] == 401)


@group("missing-delete-fails-the-entire-batch")
def g34(s):
    item = s.approved(CSV + 'delete,missing,,\n')
    lease = s.claim(item)
    before = len(s.events())
    need(s.commit(item, lease)[0] == 409)
    need(s.get("/members")[1] == {"version": 0, "members": []} and len(s.events()) == before)


@group("unique-email-conflict-cannot-partially-apply")
def g35(s):
    s.applied()
    item = s.approved(HEADER + 'upsert,two,Two,ada@example.test\nupsert,three,Three,three@x.test\n')
    lease = s.claim(item)
    need(s.commit(item, lease)[0] == 409)
    need(len(s.get("/members")[1]["members"]) == 1 and s.get("/members")[1]["version"] == 1)


@group("atomic-email-swaps-evaluate-final-state")
def g36(s):
    s.applied(CSV + 'upsert,two,Two,two@example.test\n')
    s.applied(HEADER + 'upsert,one,Ada,two@example.test\nupsert,two,Two,ada@example.test\n')
    need([m["email"] for m in s.get("/members")[1]["members"]] == ["two@example.test", "ada@example.test"])


@group("stale-approved-base-version-never-applies")
def g37(s):
    first = s.approved()
    stale = s.approved(HEADER + 'upsert,two,Two,two@example.test\n')
    lease1, lease2 = s.claim(first), s.claim(stale)
    need(s.commit(first, lease1)[0] == 200)
    need(s.commit(stale, lease2)[0] == 409)
    need(s.get("/members")[1]["version"] == 1 and len(s.get("/members")[1]["members"]) == 1)


@group("simultaneous-commits-serialize-version-fence")
def g38(s):
    first = s.approved()
    second = s.approved(HEADER + 'upsert,two,Two,two@example.test\n')
    pairs = [(first, s.claim(first)), (second, s.claim(second))]
    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = list(pool.map(lambda pair: s.commit(*pair)[0], pairs))
    need(sorted(codes) == [200, 409] and s.get("/members")[1]["version"] == 1)


@group("stable-sorted-reads-and-missing-resource-errors")
def g39(s):
    s.applied(HEADER + 'upsert,z,Z,z@x.test\nupsert,a,A,a@x.test\n')
    s.stage(HEADER + 'upsert,b,B,b@x.test\n')
    need([m["externalId"] for m in s.get("/members")[1]["members"]] == ["a", "z"])
    ids = [item["id"] for item in s.get("/imports")[1]["imports"]]
    need(ids == sorted(ids))
    for identifier in ("missing", "__proto__", "constructor"):
        need(s.get("/imports/" + identifier)[0] == 404)


@group("audit-events-are-transactional-and-contiguous")
def g40(s):
    initial = len(s.events())
    s.applied()
    events = s.events()
    need(len(events) == initial + 4)
    need([e["cursor"] for e in events] == list(range(1, len(events) + 1)))
    need([e["type"] for e in events[-4:]] == ["import.staged", "import.approved", "import.claimed", "import.committed"])
    need(all(set(e) == {"cursor", "type", "subject", "importId"} for e in events))
    need(s.post("/imports", {"baseVersion": 99, "csv": CSV}, key="bad-version")[0] == 409)
    need(s.events() == events)


@group("audit-pagination-and-query-validation")
def g41(s):
    events = s.events()
    page = s.get("/events?after=1&limit=2")[1]
    need(page == {"events": events[1:3], "nextCursor": 3})
    need(s.get("/events?after=100&limit=2")[1] == {"events": [], "nextCursor": 100})
    for query in ("after=-1", "after=1.5", "after=bad", "limit=0", "limit=101", "limit=oops"):
        need(s.get("/events?" + query)[0] == 400)


@group("capabilities-and-leases-never-leak-to-storage-or-logs")
def g42(s):
    item = s.approved()
    lease = s.claim(item)
    secrets = [s.root, s.owner, *s.tokens.values(), lease["leaseToken"]]
    data = b"\n".join(p.read_bytes() for p in s.data.rglob("*") if p.is_file())
    exposed = json.dumps(s.events()) + "".join(s.output) + json.dumps(s.get("/imports")[1])
    need(all(secret.encode() not in data and secret not in exposed for secret in secrets))


@group("graceful-restart-preserves-data-authority-and-replays")
def g43(s):
    item = s.stage(key="restart-stage")
    need(s.post("/imports/" + item["id"] + "/approve", who="approver")[0] == 200)
    lease = s.claim(item)
    first = s.commit(item, lease, key="restart-commit")
    need(first[0] == 200)
    need(s.post("/tokens/" + s.ids["viewer"] + "/revoke", who="owner")[0] == 200)
    events = s.get("/events?limit=100", "owner")[1]
    s.stop()
    need(s.process.returncode == 0, "owning stdin shutdown must be graceful")
    s.start()
    need(s.get("/members")[0] == 401)
    need(s.get("/members", "owner")[1]["version"] == 1)
    need(s.commit(item, lease, key="restart-commit") == first)
    need(s.post("/imports", {"csv": CSV, "baseVersion": 0}, key="restart-stage")[1]["import"]["id"] == item["id"])
    need(s.get("/events?limit=100", "owner")[1] == events)


@group("abrupt-restart-recovers-dead-lock-and-outstanding-lease")
def g44(s):
    item = s.approved()
    lease = s.claim(item)
    s.stop(abrupt=True)
    s.start()
    need(s.commit(item, lease)[0] == 200)
    need(s.get("/members")[1]["version"] == 1)


@group("second-live-writer-is-refused")
def g45(s):
    item = s.stage()
    rival = Service.__new__(Service)
    rival.options, rival.folder, rival.data, rival.root, rival.env = s.options, s.folder, s.data, s.root, s.env
    rival.output, rival.temp, rival.process = [], None, None
    try:
        rival.start(expect_ready=False)
    finally:
        rival.stop(abrupt=True)
    need(s.get("/imports/" + item["id"])[0] == 200)


def journal(s):
    text = (s.options.app / "STORAGE.md").read_text(encoding="utf-8")
    names = re.findall(r"(?m)^Journal: ([^\s/\\]+\.jsonl)\s*$", text)
    need(len(names) == 1, "document one safe journal basename")
    path = s.data / names[0]
    need(path.is_file() and not path.is_symlink(), "documented journal missing")
    return path


@group("partial-trailing-transaction-fails-closed")
def g46(s):
    s.applied()
    s.stop()
    path = journal(s)
    before = path.read_bytes()
    path.write_bytes(before + b'{"partial":')
    s.start(expect_ready=False)
    need(path.read_bytes() == before + b'{"partial":', "startup silently repaired history")


@group("valid-json-transaction-tampering-fails-closed")
def g47(s):
    s.applied()
    s.stop()
    path = journal(s)
    lines = path.read_text(encoding="utf-8").splitlines()
    original_lines = list(lines)
    value = json.loads(lines[-1])
    candidates = []
    semantic = {s.ws, "Synthetic roster", "one", "Ada", "ada@example.test", "committed", "import.committed", "editor", "worker"}
    def leaves(node, path=()):
        if isinstance(node, dict):
            for key, item in node.items():
                if key.lower().replace("_", "") in ("hash", "checksum", "prev", "previous", "prevhash", "previoushash", "seq", "sequence"):
                    continue
                leaves(item, (*path, key))
        elif isinstance(node, list):
            for index, item in enumerate(node):
                leaves(item, (*path, index))
        elif isinstance(node, str) and node:
            candidates.append((0 if node in semantic else 1, path, node + "tampered"))
        elif type(node) in (int, float):
            candidates.append((1, path, node + 1))
    leaves(value)
    need(candidates, "journal must describe actual transactions")
    refused = False
    for _, trail, replacement in sorted(candidates, key=lambda candidate: candidate[0])[:32]:
        changed_value = json.loads(json.dumps(value))
        if not trail:
            changed_value = replacement
        else:
            parent = changed_value
            for component in trail[:-1]:
                parent = parent[component]
            parent[trail[-1]] = replacement
        changed_lines = [*original_lines[:-1], json.dumps(changed_value, separators=(",", ":"))]
        changed = ("\n".join(changed_lines) + "\n").encode()
        path.write_bytes(changed)
        try:
            s.start(expect_ready=False)
            refused = True
        except AssertionError:
            # A permitted unchecked metadata field may change without changing
            # transaction content. Try the next independently restored leaf.
            pass
        finally:
            s.stop()
        need(path.read_bytes() == changed, "tampered history was rewritten")
        if refused:
            break
    need(refused, "changed transaction content was accepted")
    for variant in (original_lines[1:], [original_lines[1], original_lines[0], *original_lines[2:]]):
        path.write_text("\n".join(variant) + "\n", encoding="utf-8")
        s.start(expect_ready=False)


@group("cli-connected-workflow-and-structured-failures")
def g48(s):
    source = s.folder / "input.csv"
    source.write_text(CSV, encoding="utf-8")
    result = s.cli(["stage", s.ws, "--file", str(source), "--base-version", "0", "--key", "cli-stage"])
    need(result.returncode == 0)
    item = json.loads(result.stdout)["import"]
    need(s.cli(["approve", s.ws, item["id"]], s.tokens["approver"]).returncode == 0)
    claim = s.cli(["claim", s.ws, item["id"], "--lease-ms", "5000"], s.tokens["worker"])
    need(claim.returncode == 0)
    lease = json.loads(claim.stdout)["leaseToken"]
    commit = s.cli(["commit", s.ws, item["id"], "--lease-token", lease, "--key", "cli-commit"], s.tokens["worker"])
    need(commit.returncode == 0 and json.loads(commit.stdout)["version"] == 1)
    need(json.loads(s.cli(["members", s.ws]).stdout)["members"][0]["externalId"] == "one")
    need(json.loads(s.cli(["status", s.ws]).stdout)["workspace"]["version"] == 1)
    need(json.loads(s.cli(["events", s.ws, "--after", "0", "--limit", "100"]).stdout)["events"])
    failed = s.cli(["stage", s.ws, "--file", "missing-" + uuid.uuid4().hex, "--base-version", "1", "--key", "x"])
    need(failed.returncode != 0 and not failed.stdout.strip() and isinstance(json.loads(failed.stderr)["error"]["code"], str))
    need(s.tokens["editor"] not in failed.stderr and s.url not in failed.stderr)
    need(s.request("GET", "/health")[0] == 200)


@group("sdk-connected-workflow-and-error-contract")
def g49(s):
    script = s.folder / "sdk-probe.mjs"
    script.write_text("""import {createClient,RelayError} from SDK;
const c=createClient({baseUrl:process.env.RELAY_URL,token:process.env.RELAY_TOKEN});
const w=await c.workspace(process.env.WORKSPACE);const m=await c.members(process.env.WORKSPACE);
const r=await c.stage(process.env.WORKSPACE,{baseVersion:0,csv:process.env.CSV},'sdk-stage');
const e=await c.events(process.env.WORKSPACE,{after:0,limit:100});
let good=false;try{await c.approve(process.env.WORKSPACE,r.import.id)}catch(x){good=x instanceof RelayError&&x.status===403&&typeof x.code==='string'}
console.log(JSON.stringify({version:w.workspace.version,members:m.members.length,state:r.import.state,events:e.events.length,good}));
""".replace("SDK", json.dumps((s.options.app / "sdk.mjs").as_uri())), encoding="utf-8")
    result = owned_process.run([str(s.options.runtime), str(script)], env={**environment(), "RELAY_URL": s.url,
        "RELAY_TOKEN": s.tokens["editor"], "WORKSPACE": s.ws, "CSV": CSV}, capture_output=True, text=True, timeout=8)
    need(result.returncode == 0)
    value = json.loads(result.stdout)
    need(value["version"] == 0 and value["members"] == 0 and value["state"] == "staged" and value["events"] == 6 and value["good"])


@group("sdk-types-compile-positive-and-reject-invalid-uses")
def g50(s):
    need(s.options.typescript and s.options.typescript.is_file(), "explicit offline TypeScript compiler required")
    source = s.folder / "type-probe.mts"
    source.write_text("""import {createClient,RelayError,type Role,type ImportState,type Member,type ImportRecord} from SDK;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : T;
type Equal<A,B> = (<T>()=>T extends A ? 1 : 2) extends (<T>()=>T extends B ? 1 : 2) ? true : false;
const exactRoles:Equal<Role,'owner'|'editor'|'approver'|'worker'|'viewer'>=true;
const exactStates:Equal<ImportState,'staged'|'approved'|'leased'|'committed'|'rejected'|'cancelled'>=true;
type FieldAny<T> = true extends {[K in keyof T]:IsAny<T[K]>}[keyof T] ? true : false;
const memberFieldsTyped:FieldAny<Member>=false;const importFieldsTyped:FieldAny<ImportRecord>=false;
const client=createClient({baseUrl:'http://127.0.0.1',token:'synthetic'});
type Results = {[K in keyof typeof client]:typeof client[K] extends (...args:never[])=>Promise<infer R> ? IsAny<R> : true};
const methodsTyped:true extends Results[keyof Results] ? true : false=false;
const members=await client.members('abc');
const nestedMember:NotAny<typeof members.members[number]>=members.members[0];
const record:Member=members.members[0];const revision:number=record.revision;
const stage=await client.stage('abc',{baseVersion:0,csv:'x'},'key');
const imp:ImportRecord=stage.import;const state:ImportState=imp.state;const role:Role='worker';
const notAny:NotAny<typeof members>=members;const typed:NotAny<typeof imp>=imp;
const claim=await client.claim('abc',imp.id,100);const token:string=claim.leaseToken;
const commit=await client.commit('abc',imp.id,token,'key');const version:number=commit.version;
const events=await client.events('abc',{after:0,limit:10});const cursor:number=events.nextCursor;
const error=new RelayError(409,'CONFLICT','conflict');const status:number=error.status;
// @ts-expect-error exact role enum
const badRole:Role='administrator';
// @ts-expect-error exact state enum
const badState:ImportState='running';
// @ts-expect-error baseVersion is numeric
await client.stage('abc',{baseVersion:'zero',csv:'x'},'key');
// @ts-expect-error lease duration is numeric
await client.claim('abc','id','100');
// @ts-expect-error declared member has no imaginary property
record.imaginary;
""".replace("SDK", json.dumps((s.options.app / "sdk.mjs").as_posix())), encoding="utf-8")
    result = owned_process.run([str(s.options.node), str(s.options.typescript), "--strict", "--noEmit", "--target", "ES2022",
        "--lib", "ES2022,DOM", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", str(source)],
        env=environment(), capture_output=True, text=True, timeout=20)
    need(result.returncode == 0, "positive/negative SDK type contract failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "runtime", "node", "typescript"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("node-prequalification", "bun-qualification"), default="node-prequalification")
    options = parser.parse_args()
    for name in ("app", "out", "runtime", "node", "typescript"):
        setattr(options, name, getattr(options, name).resolve())
    need(options.out != options.app and not options.out.is_relative_to(options.app), "report directory outside authored app")
    options.out.mkdir(parents=True, exist_ok=True)
    if options.mode == "bun-qualification":
        result = owned_process.run([str(options.runtime), "-e", "if(!globalThis.Bun)process.exit(91)"],
            capture_output=True, env=environment(), timeout=5)
        need(result.returncode == 0, "qualification requires real Bun")
    checks = []
    def record(name, scope, function):
        try:
            function()
            checks.append({"name": name, "scope": scope, "passed": True})
        except Exception as error:
            checks.append({"name": name, "scope": scope, "passed": False,
                "error": type(error).__name__, "detail": str(error)[:180]})
    service = None
    def launch():
        nonlocal service
        service = Service(options)
    record("owned-process-ready-contract", "prerequisite", launch)
    record("loopback-json-health", "prerequisite", lambda: need(service.request("GET", "/health") == (200, {"ok": True})))
    def help_check():
        result = owned_process.run([str(options.runtime), str(options.app / "cli.mjs"), "--help"],
            cwd=options.app, env=environment(), capture_output=True, text=True, timeout=5)
        need(result.returncode == 0 and all(word in result.stdout for word in ("stage", "approve", "claim", "commit", "events")))
    record("cli-help-is-usable", "prerequisite", help_check)
    def sdk_check():
        result = owned_process.run([str(options.runtime), "--input-type=module", "-e",
            "const m=await import(" + json.dumps((options.app / "sdk.mjs").as_uri()) + ");if(typeof m.createClient!=='function'||typeof m.RelayError!=='function')process.exit(2)"],
            cwd=options.app, env=environment(), capture_output=True, text=True, timeout=5)
        need(result.returncode == 0 and (options.app / "sdk.d.mts").is_file())
    record("sdk-module-and-declarations-exist", "prerequisite", sdk_check)
    if service:
        service.close(abrupt=True)
    for name, function in GROUPS:
        def run(function=function):
            instance = None
            fixture_complete = False
            try:
                instance = Service(options)
                instance.fixture()
                fixture_complete = True
                function(instance)
            finally:
                if instance:
                    instance.close(abrupt=not fixture_complete)
        record(name, "business", run)
    need(len(GROUPS) == 50 and len(checks) == 54, "instrument check inventory changed")
    passed = sum(check["passed"] for check in checks)
    business = sum(check["passed"] for check in checks if check["scope"] == "business")
    report = {"kind": "relay-headless-gate-v1", "mode": options.mode, "runtimeQualified": options.mode == "bun-qualification" and passed == 54,
        "passed": passed == 54, "checksPassed": passed, "checksTotal": 54, "businessPassed": business, "businessTotal": 50,
        "prerequisitesPassed": passed - business, "prerequisitesTotal": 4, "checks": checks,
        "appSha256": {p.relative_to(options.app).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(options.app.rglob("*")) if p.is_file() and "node_modules" not in p.parts}}
    (options.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("passed", "runtimeQualified", "checksPassed", "checksTotal", "businessPassed", "businessTotal")}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
