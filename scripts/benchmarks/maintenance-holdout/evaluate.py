"""Preregistered offline maintenance gate: 50 business checks + 4 prerequisites.

No LLM, browser, provider, cloud, company data or external dependencies. Node is
authoring prequalification; an actual Bun executable is needed for qualification.
Each fixture owns and closes its processes and data. Product sources are readonly.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

import owned_process

HERE = Path(__file__).resolve().parent
GROUPS = []
PERIOD = "2026-01"
DATE = "2026-01-12T12:00:00.000Z"
LEGACY = {"version": 1, "accounts": [{"id": "legacy-a", "workspaceId": "acme", "name": "Legacy Tools",
    "plan": {"baseCents": 1000, "includedUnits": 100, "unitCents": 5}}],
    "usage": [{"id": "evt-old", "workspaceId": "acme", "accountId": "legacy-a", "eventId": "legacy-event",
               "units": 120, "occurredAt": "2026-01-10T00:00:00.000Z"}]}
LEGACY_BYTES = (json.dumps(LEGACY, ensure_ascii=False, indent=2) + "\n").encode()


def need(value, message="acceptance assertion failed"):
    if not value:
        raise AssertionError(message)


def group(name):
    def register(function):
        GROUPS.append((name, function))
        return function
    return register


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def environment():
    return {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "COMSPEC", "PATHEXT") if key in os.environ}


def manifest(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file() and not {"node_modules", ".git", "__pycache__"}.intersection(path.parts)}


class Service:
    def __init__(self, options, *, legacy=LEGACY_BYTES, data=None, start=True):
        self.options = options
        self.temp = tempfile.TemporaryDirectory(prefix="ledgerdesk-gate-")
        self.folder = Path(self.temp.name)
        self.data = Path(data) if data else self.folder / "data"
        self.data.mkdir(exist_ok=True)
        if legacy is not None and data is None:
            (self.data / "ledger.json").write_bytes(legacy)
        self.owned = None
        self.logs = []
        if start:
            try:
                self.start()
            except BaseException:
                self.close()
                raise

    def start(self, expect_ready=True):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.url = "http://127.0.0.1:" + str(self.port)
        self.env = {**environment(), "PORT": str(self.port), "DATA_DIR": str(self.data)}
        self.logs = [(self.folder / ("server-" + uuid.uuid4().hex + suffix)).open("w", encoding="utf-8") for suffix in (".out", ".err")]
        self.owned = owned_process.spawn([str(self.options.runtime), str(self.options.app / "app.mjs")], cwd=self.options.app,
            env=self.env, stdin=subprocess.DEVNULL, stdout=self.logs[0], stderr=self.logs[1])
        deadline = time.monotonic() + (5 if expect_ready else 2)
        while time.monotonic() < deadline:
            if self.owned.process.poll() is not None:
                need(not expect_ready and self.owned.process.returncode != 0, "unexpected startup exit")
                return
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=.15) as response:
                    value = json.loads(response.read())
                    if response.status == 200 and value.get("ok") is True:
                        need(expect_ready, "unsafe startup served healthy data")
                        return
            except (OSError, urllib.error.URLError, ValueError):
                pass
            time.sleep(.03)
        raise AssertionError("startup did not reach the required ready/rejected state")

    def stop(self):
        if self.owned:
            self.owned.close()
            self.owned = None
        for log in self.logs:
            log.close()
        self.logs = []

    def close(self):
        try:
            self.stop()
        finally:
            self.temp.cleanup()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def request(self, method, path, body=None, key="owner-acme"):
        headers = {"Authorization": "Bearer " + key} if key is not None else {}
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                status, data = response.status, response.read()
        except urllib.error.HTTPError as response:
            status, data = response.code, response.read()
        value = json.loads(data)
        if status >= 400:
            need(isinstance(value, dict) and isinstance(value.get("error"), dict)
                 and isinstance(value["error"].get("code"), str) and value["error"]["code"]
                 and isinstance(value["error"].get("message"), str) and value["error"]["message"], "invalid error contract")
        return status, value


def account(service, name="Current Account", plan=None):
    status, value = service.request("POST", "/api/accounts", {"name": name,
        "plan": plan or {"baseCents": 1000, "includedUnits": 100, "unitCents": 5}})
    need(status == 201 and isinstance(value.get("id"), str) and value.get("workspaceId") == "acme", "account creation failed")
    return value


def usage(service, account_id="legacy-a", event_id="new-event", units=40, date=DATE, key="owner-acme"):
    return service.request("POST", "/api/accounts/" + account_id + "/usage",
                           {"eventId": event_id, "units": units, "occurredAt": date}, key)


def issue(service, account_id="legacy-a", request_id="issue-one", period=PERIOD, key="owner-acme"):
    status, value = service.request("POST", "/api/accounts/" + account_id + "/invoices", {"period": period, "requestId": request_id}, key)
    need(status == 201 and isinstance(value.get("id"), str), "invoice issue failed")
    return value


def dynamic_key(service, role="billing", account_ids=None):
    body = {"role": role, **({"accountIds": account_ids} if account_ids is not None else {})}
    status, value = service.request("POST", "/api/access-keys", body)
    need(status == 201 and isinstance(value.get("id"), str) and isinstance(value.get("apiKey"), str)
         and len(value["apiKey"]) >= 24, "key creation failed")
    need(value["apiKey"] not in (service.data / "ledger.json").read_text(), "raw key was persisted")
    return value


def credit(service, invoice_id, request_id="credit-one", amount=100, reason="Service adjustment", key="owner-acme"):
    return service.request("POST", "/api/invoices/" + invoice_id + "/credits",
                           {"requestId": request_id, "amountCents": amount, "reason": reason}, key)


def js(options, service, source):
    path = service.folder / ("client-" + uuid.uuid4().hex + ".mjs")
    path.write_text(source, encoding="utf-8")
    return owned_process.run([str(options.node), str(path)], cwd=service.folder,
        env={**environment(), "LEDGER_URL": service.url, "LEDGER_KEY": "owner-acme"}, capture_output=True, text=True, timeout=12)


def cli(options, service, args, key="owner-acme"):
    return owned_process.run([str(options.runtime), str(options.app / "cli.mjs"), *args], cwd=service.folder,
        env={**environment(), "LEDGER_URL": service.url, "LEDGER_KEY": key}, capture_output=True, text=True, timeout=6)


@group("legacy-health")
def check_01(o):
    with Service(o) as s:
        status, value = s.request("GET", "/health", key=None)
        need(status == 200 and value.get("ok") is True and value.get("version") in (1, 2))


@group("legacy-list-accounts")
def check_02(o):
    with Service(o) as s:
        status, value = s.request("GET", "/api/accounts")
        need(status == 200 and len(value) == 1 and value[0] == LEGACY["accounts"][0])


@group("legacy-get-account")
def check_03(o):
    with Service(o) as s:
        need(s.request("GET", "/api/accounts/legacy-a") == (200, LEGACY["accounts"][0]))


@group("legacy-list-usage")
def check_04(o):
    with Service(o) as s:
        need(s.request("GET", "/api/accounts/legacy-a/usage") == (200, LEGACY["usage"]))


@group("legacy-quote")
def check_05(o):
    with Service(o) as s:
        status, value = s.request("GET", "/api/accounts/legacy-a/quote?period=" + PERIOD)
        need(status == 200 and value.get("totalUnits") == 120 and value.get("overageUnits") == 20 and value.get("totalCents") == 1100)


@group("legacy-create-account")
def check_06(o):
    with Service(o) as s:
        value = account(s)
        need(s.request("GET", "/api/accounts/" + value["id"]) == (200, value))


@group("legacy-record-usage")
def check_07(o):
    with Service(o) as s:
        status, value = usage(s)
        need(status == 201 and value.get("units") == 40 and value.get("accountId") == "legacy-a")


@group("legacy-workspace-isolation")
def check_08(o):
    with Service(o) as s:
        need(s.request("GET", "/api/accounts", key="owner-beta") == (200, []))
        need(s.request("GET", "/api/accounts/legacy-a", key="owner-beta")[0] == 404)


@group("unknown-route")
def check_09(o):
    with Service(o) as s:
        need(s.request("GET", "/api/not-a-route")[0] == 404)


@group("authentication-required")
def check_10(o):
    with Service(o) as s:
        need(s.request("GET", "/api/accounts", key=None)[0] == 401)
        need(s.request("GET", "/api/accounts", key="not-a-key")[0] == 401)


@group("migration-v2-envelope")
def check_11(o):
    with Service(o) as s:
        value = json.loads((s.data / "ledger.json").read_bytes())
        need(value.get("version") == 2 and isinstance(value.get("payload"), dict))
        need(value.get("checksum") == hashlib.sha256(canonical(value["payload"])).hexdigest())


@group("migration-exact-backup")
def check_12(o):
    with Service(o) as s:
        need((s.data / "ledger.v1.backup.json").read_bytes() == LEGACY_BYTES)


@group("migration-restart-idempotent")
def check_13(o):
    with Service(o) as s:
        backup = (s.data / "ledger.v1.backup.json").read_bytes()
        s.stop()
        s.start()
        need((s.data / "ledger.v1.backup.json").read_bytes() == backup)
        need(s.request("GET", "/health")[1].get("version") == 2)
        need(s.request("GET", "/api/accounts/legacy-a")[1] == LEGACY["accounts"][0])


@group("checksum-corruption-refused")
def check_14(o):
    with Service(o) as s:
        s.stop()
        path = s.data / "ledger.json"
        value = json.loads(path.read_bytes())
        need(value.get("version") == 2)
        value["checksum"] = "0" * 64
        damaged = canonical(value)
        path.write_bytes(damaged)
        s.start(expect_ready=False)
        need(path.read_bytes() == damaged)


@group("future-version-refused")
def check_15(o):
    body = b'{"version":999,"payload":{},"checksum":"unused"}'
    with Service(o, legacy=body, start=False) as s:
        s.start(expect_ready=False)
        need((s.data / "ledger.json").read_bytes() == body)


@group("invalid-legacy-refused")
def check_16(o):
    for mode in ("negative", "duplicate", "orphan"):
        value = json.loads(LEGACY_BYTES)
        if mode == "negative":
            value["usage"][0]["units"] = -2
        elif mode == "duplicate":
            value["accounts"].append(value["accounts"][0])
        else:
            value["usage"][0]["accountId"] = "not-present"
        body = canonical(value)
        with Service(o, legacy=body, start=False) as s:
            s.start(expect_ready=False)
            need((s.data / "ledger.json").read_bytes() == body)
            need(not (s.data / "ledger.v1.backup.json").exists())


@group("stale-owner-lock-recovery")
def check_17(o):
    with Service(o) as s:
        value = account(s)
        s.stop()
        s.start()
        need(s.request("GET", "/api/accounts/" + value["id"]) == (200, value))


@group("second-live-owner-refused")
def check_18(o):
    with Service(o) as s, Service(o, data=s.data, start=False) as second:
        second.start(expect_ready=False)
        need(s.request("GET", "/health")[0] == 200)


@group("usage-exact-replay")
def check_19(o):
    with Service(o) as s:
        status, first = usage(s)
        need(status == 201)
        need(usage(s) == (200, first))
        s.stop()
        s.start()
        need(usage(s) == (200, first))


@group("usage-conflicting-replay")
def check_20(o):
    with Service(o) as s:
        need(usage(s)[0] == 201)
        need(usage(s, units=41)[0] == 409)
        need(usage(s, date="2026-01-13T00:00:00.000Z")[0] == 409)
        rows = s.request("GET", "/api/accounts/legacy-a/usage")[1]
        need(len(rows) == 2 and rows[-1]["units"] == 40)


@group("usage-input-validation")
def check_21(o):
    with Service(o) as s:
        for index, (units, date) in enumerate([(0, DATE), (-1, DATE), (1.5, DATE), (True, DATE),
                (9007199254740992, DATE), (1, "2026-02-30T00:00:00Z"), (1, "2026-01-12T12:00:00")]):
            need(usage(s, event_id="invalid-" + str(index), units=units, date=date)[0] == 400)
        need(len(s.request("GET", "/api/accounts/legacy-a/usage")[1]) == 1)


@group("usage-utc-month-boundary")
def check_22(o):
    with Service(o) as s:
        need(usage(s, event_id="last", units=5, date="2026-01-31T23:59:59.999Z")[0] == 201)
        need(usage(s, event_id="next", units=7, date="2026-02-01T00:00:00.000Z")[0] == 201)
        need(usage(s, event_id="offset", units=9, date="2026-02-01T00:30:00+01:00")[0] == 201)
        need(s.request("GET", "/api/accounts/legacy-a/quote?period=2026-01")[1].get("totalUnits") == 134)
        need(s.request("GET", "/api/accounts/legacy-a/quote?period=2026-02")[1].get("totalUnits") == 7)
        need(s.request("GET", "/api/accounts/legacy-a/quote?period=2026-13")[0] == 400)


@group("usage-concurrent-deduplication")
def check_23(o):
    with Service(o) as s, ThreadPoolExecutor(max_workers=10) as pool:
        rows = list(pool.map(lambda _: usage(s, event_id="concurrent", units=3), range(20)))
        need(sum(status == 201 for status, _ in rows) == 1 and all(status in (200, 201) for status, _ in rows))
        need(len({row["id"] for _, row in rows}) == 1)
        need(s.request("GET", "/api/accounts/legacy-a/quote?period=" + PERIOD)[1].get("totalUnits") == 123)


@group("account-plan-validation")
def check_24(o):
    with Service(o) as s:
        for field, value in (("baseCents", -1), ("unitCents", 1.5), ("includedUnits", True), ("baseCents", 9007199254740992)):
            plan = {"baseCents": 10, "includedUnits": 0, "unitCents": 1, field: value}
            need(s.request("POST", "/api/accounts", {"name": "Invalid", "plan": plan})[0] == 400)
        need(len(s.request("GET", "/api/accounts")[1]) == 1)


@group("invoice-snapshot-arithmetic")
def check_25(o):
    with Service(o) as s:
        value = issue(s)
        need(value.get("status") == "issued" and value.get("totalUnits") == 120 and value.get("totalCents") == 1100
             and value.get("creditedCents") == 0 and value.get("balanceCents") == 1100)
        need(value.get("overageUnits") == 20 and value.get("baseCents") == 1000 and value.get("includedUnits") == 100 and value.get("unitCents") == 5)
        lines = value.get("lines")
        need(isinstance(lines, list) and len(lines) == 2 and {x["kind"] for x in lines} == {"base", "overage"})
        need(sum(x["amountCents"] for x in lines) == 1100 and all(x["quantity"] * x["unitCents"] == x["amountCents"] for x in lines))


@group("invoice-exact-replay")
def check_26(o):
    with Service(o) as s:
        value = issue(s)
        route = "/api/accounts/legacy-a/invoices"
        need(s.request("POST", route, {"period": PERIOD, "requestId": "issue-one"}) == (200, value))


@group("invoice-conflicting-replay")
def check_27(o):
    with Service(o) as s:
        issue(s)
        need(s.request("POST", "/api/accounts/legacy-a/invoices", {"period": "2026-02", "requestId": "issue-one"})[0] == 409)


@group("invoice-concurrent-period-uniqueness")
def check_28(o):
    with Service(o) as s, ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda index: s.request("POST", "/api/accounts/legacy-a/invoices", {"period": PERIOD, "requestId": "r-" + str(index)}), range(12)))
        need(sum(code == 201 for code, _ in rows) == 1 and sum(code == 409 for code, _ in rows) == 11)
        winner = next(value for code, value in rows if code == 201)
        need(s.request("GET", "/api/invoices/" + winner["id"])[1]["totalCents"] == 1100)


@group("reader-write-denied")
def check_29(o):
    with Service(o) as s:
        need(usage(s, key="reader-acme")[0] == 403)
        need(s.request("POST", "/api/accounts/legacy-a/invoices", {"period": PERIOD, "requestId": "reader"}, "reader-acme")[0] == 403)
        need(s.request("GET", "/api/accounts/legacy-a", key="reader-acme")[0] == 200)


@group("billing-key-account-scope")
def check_30(o):
    with Service(o) as s:
        other = account(s)
        key = dynamic_key(s, account_ids=["legacy-a"])
        need(usage(s, event_id="scoped", key=key["apiKey"])[0] == 201)
        need(issue(s, key=key["apiKey"])["accountId"] == "legacy-a")
        need(s.request("GET", "/api/accounts/" + other["id"], key=key["apiKey"])[0] == 404)
        need(s.request("POST", "/api/accounts", {"name": "Escalated", "plan": other["plan"]}, key["apiKey"])[0] == 403)


@group("key-management-owner-only")
def check_31(o):
    with Service(o) as s:
        for key in ("billing-acme", "reader-acme"):
            need(s.request("POST", "/api/access-keys", {"role": "billing"}, key)[0] == 403)
        need(s.request("POST", "/api/access-keys", {"role": "owner"})[0] == 400)
        need(s.request("POST", "/api/access-keys", {"role": "reader", "accountIds": ["not-present"]})[0] == 400)
        value = dynamic_key(s, role="reader")
        need(s.request("POST", "/api/access-keys/" + value["id"] + "/revoke", {}, "owner-beta")[0] == 404)


@group("revocation-immediate")
def check_32(o):
    with Service(o) as s:
        key = dynamic_key(s)
        need(s.request("GET", "/api/accounts", key=key["apiKey"])[0] == 200)
        need(s.request("POST", "/api/access-keys/" + key["id"] + "/revoke", {}) == (200, {"revoked": True}))
        need(s.request("GET", "/api/accounts", key=key["apiKey"])[0] == 401)
        s.stop()
        s.start()
        need(s.request("GET", "/api/accounts", key=key["apiKey"])[0] == 401)


@group("revoked-idempotent-replay-denied")
def check_33(o):
    with Service(o) as s:
        key = dynamic_key(s)
        invoice = issue(s, key=key["apiKey"])
        need(s.request("POST", "/api/access-keys/" + key["id"] + "/revoke", {})[0] == 200)
        need(s.request("POST", "/api/accounts/legacy-a/invoices", {"period": PERIOD, "requestId": "issue-one"}, key["apiKey"])[0] == 401)
        need(s.request("GET", "/api/invoices/" + invoice["id"])[1]["totalCents"] == 1100)


@group("revoked-inflight-body-denied")
def check_34(o):
    with Service(o) as s:
        key = dynamic_key(s)
        body = canonical({"period": PERIOD, "requestId": "held-body"})
        connection = http.client.HTTPConnection("127.0.0.1", s.port, timeout=4)
        try:
            connection.putrequest("POST", "/api/accounts/legacy-a/invoices")
            connection.putheader("Authorization", "Bearer " + key["apiKey"])
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Content-Length", str(len(body)))
            connection.endheaders()
            connection.send(body[:1])
            need(s.request("GET", "/api/accounts", key=key["apiKey"])[0] == 200)
            need(s.request("POST", "/api/access-keys/" + key["id"] + "/revoke", {})[0] == 200)
            connection.send(body[1:])
            response = connection.getresponse()
            need(response.status == 401 and isinstance(json.loads(response.read()).get("error"), dict))
            # A new authorized operation must still be able to issue this period.
            need(issue(s, request_id="after-revocation")["totalCents"] == 1100)
        finally:
            connection.close()


@group("invoice-workspace-isolation")
def check_35(o):
    with Service(o) as s:
        value = issue(s)
        need(s.request("GET", "/api/invoices/" + value["id"], key="owner-beta")[0] == 404)


@group("invoice-account-scope-isolation")
def check_36(o):
    with Service(o) as s:
        value = issue(s)
        other = account(s)
        key = dynamic_key(s, role="reader", account_ids=[other["id"]])
        need(s.request("GET", "/api/invoices/" + value["id"], key=key["apiKey"])[0] == 404)


@group("late-usage-preserves-issued-invoice")
def check_37(o):
    with Service(o) as s:
        value = issue(s)
        need(usage(s, units=50)[0] == 201)
        need(s.request("GET", "/api/accounts/legacy-a/quote?period=" + PERIOD)[1]["totalCents"] == 1350)
        after = s.request("GET", "/api/invoices/" + value["id"])[1]
        need(all(after.get(field) == value.get(field) for field in ("totalUnits", "totalCents", "lines", "overageUnits")))


@group("invoice-restart-durability")
def check_38(o):
    with Service(o) as s:
        value = issue(s)
        s.stop()
        s.start()
        need(s.request("GET", "/api/invoices/" + value["id"]) == (200, value))
        need(s.request("POST", "/api/accounts/legacy-a/invoices", {"period": PERIOD, "requestId": "issue-one"}) == (200, value))


@group("credit-balance-arithmetic")
def check_39(o):
    with Service(o) as s:
        invoice = issue(s)
        status, value = credit(s, invoice["id"], amount=125)
        need(status == 201 and value.get("amountCents") == 125 and value.get("invoiceId") == invoice["id"])
        result = s.request("GET", "/api/invoices/" + invoice["id"])[1]
        need(result.get("totalCents") == 1100 and result.get("creditedCents") == 125 and result.get("balanceCents") == 975)


@group("credit-exact-replay")
def check_40(o):
    with Service(o) as s:
        invoice = issue(s)
        status, value = credit(s, invoice["id"])
        need(status == 201 and credit(s, invoice["id"]) == (200, value))
        s.stop()
        s.start()
        need(credit(s, invoice["id"]) == (200, value))
        need(len(s.request("GET", "/api/invoices/" + invoice["id"] + "/credits")[1]) == 1)


@group("credit-conflicting-replay")
def check_41(o):
    with Service(o) as s:
        invoice = issue(s)
        need(credit(s, invoice["id"])[0] == 201)
        need(credit(s, invoice["id"], amount=101)[0] == 409)
        need(credit(s, invoice["id"], reason="Changed")[0] == 409)


@group("overcredit-atomic-rejection")
def check_42(o):
    with Service(o) as s:
        invoice = issue(s)
        need(credit(s, invoice["id"], amount=1000)[0] == 201)
        need(credit(s, invoice["id"], request_id="too-much", amount=101)[0] == 409)
        rows = s.request("GET", "/api/invoices/" + invoice["id"] + "/credits")[1]
        need(len(rows) == 1 and rows[0]["amountCents"] == 1000)
        # A failed attempt must not poison a corrected successful request.
        need(credit(s, invoice["id"], request_id="too-much", amount=100)[0] == 201)


@group("concurrent-credit-limit")
def check_43(o):
    with Service(o) as s, ThreadPoolExecutor(max_workers=8) as pool:
        invoice = issue(s)
        rows = list(pool.map(lambda index: credit(s, invoice["id"], request_id="parallel-" + str(index), amount=200), range(12)))
        need(sum(code == 201 for code, _ in rows) == 5 and sum(code == 409 for code, _ in rows) == 7)
        value = s.request("GET", "/api/invoices/" + invoice["id"])[1]
        need(value.get("creditedCents") == 1000 and value.get("balanceCents") == 100)


@group("credit-input-validation")
def check_44(o):
    with Service(o) as s:
        invoice = issue(s)
        for index, (amount, reason) in enumerate([(0, "a"), (-1, "a"), (1.5, "a"), (True, "a"), (1, "   "), (1, "a" * 201)]):
            need(credit(s, invoice["id"], request_id="bad-" + str(index), amount=amount, reason=reason)[0] == 400)
        need(s.request("GET", "/api/invoices/" + invoice["id"] + "/credits")[1] == [])


@group("credit-workspace-isolation")
def check_45(o):
    with Service(o) as s:
        invoice = issue(s)
        need(credit(s, invoice["id"], key="owner-beta")[0] == 404)
        need(s.request("GET", "/api/invoices/" + invoice["id"] + "/credits", key="owner-beta")[0] == 404)


@group("sdk-connected-workflows")
def check_46(o):
    with Service(o) as s:
        source = '''import {createClient} from SDK;
const c=createClient({baseUrl:process.env.LEDGER_URL,apiKey:process.env.LEDGER_KEY});
const a=await c.createAccount({name:'SDK Account',plan:{baseCents:100,includedUnits:1,unitCents:2}});
await c.recordUsage(a.id,{eventId:'sdk',units:3,occurredAt:'2026-01-12T12:00:00.000Z'});
const q=await c.quote(a.id,'2026-01');if(q.totalCents!==104)throw Error('quote');
if((await c.listUsage(a.id,'2026-01')).length!==1)throw Error('usage');
if(!(await c.listAccounts()).some(x=>x.id===a.id))throw Error('account');
const i=await c.issueInvoice(a.id,{period:'2026-01',requestId:'sdk-issue'});
await c.creditInvoice(i.id,{requestId:'sdk-credit',amountCents:4,reason:'SDK credit'});
if((await c.getInvoice(i.id)).balanceCents!==100||(await c.listCredits(i.id)).length!==1)throw Error('credit');
const k=await c.createKey({role:'reader',accountIds:[a.id]});if(!k.apiKey)throw Error('key');
if((await c.revokeKey(k.id)).revoked!==true)throw Error('revoke');console.log('ok');
'''.replace('SDK', json.dumps((o.app / 'sdk.mjs').as_uri()), 1)
        result = js(o, s, source)
        need(result.returncode == 0 and result.stdout.strip() == "ok", "SDK workflows failed")


@group("sdk-strict-types")
def check_47(o):
    with tempfile.TemporaryDirectory(prefix="ledgerdesk-types-") as folder:
        path = Path(folder) / "consumer.mts"
        module = json.dumps((o.app / "sdk.mjs").as_posix())
        path.write_text('''import {createClient,ApiError} from MODULE;
const c=createClient({baseUrl:'http://127.0.0.1',apiKey:'synthetic'});
const a=await c.createAccount({name:'a',plan:{baseCents:1,includedUnits:0,unitCents:1}});
const id:string=a.id; const q=await c.quote(id,'2026-01');const n:number=q.totalCents;
const u=await c.recordUsage(id,{eventId:'x',units:1,occurredAt:'2026-01-01T00:00:00Z'});const units:number=u.units;
const i=await c.issueInvoice(id,{period:'2026-01',requestId:'r'});const cents:number=i.totalCents;
const k=await c.createKey({role:'reader',accountIds:[id]});const raw:string=k.apiKey;
const x=await c.creditInvoice(i.id,{requestId:'c',amountCents:1,reason:'x'});const credit:number=x.amountCents;
const b:boolean=(await c.revokeKey(k.id)).revoked;const rows=await c.listCredits(i.id);const amount:number=rows[0].amountCents;
const accounts=await c.listAccounts();const name:string=accounts[0].name;
const events=await c.listUsage(id);const event:string=events[0].eventId;
const got=await c.getInvoice(i.id);const balance:number=got.balanceCents;
if(x instanceof ApiError){const status:number=x.status;const code:string=x.code;}
// @ts-expect-error invalid role
c.createKey({role:'owner'});
// @ts-expect-error invalid units
c.recordUsage(id,{eventId:'x',units:'one',occurredAt:'now'});
// @ts-expect-error missing request ID
c.issueInvoice(id,{period:'2026-01'});
// @ts-expect-error invalid result type
const wrong:string=q.totalCents;
// @ts-expect-error invalid result field
got.notARealField;
'''.replace("MODULE", module), encoding="utf-8")
        result = owned_process.run([str(o.node), str(o.typescript), "--noEmit", "--strict", "--module", "NodeNext",
            "--moduleResolution", "NodeNext", "--target", "ES2022", str(path)], cwd=folder, env=environment(), capture_output=True, text=True, timeout=15)
        need(result.returncode == 0, "strict SDK consumer rejected correct uses or accepted invalid uses")


@group("sdk-api-error-contract")
def check_48(o):
    with Service(o) as s:
        source = '''import {createClient,ApiError} from MODULE;
const c=createClient({baseUrl:process.env.LEDGER_URL,apiKey:process.env.LEDGER_KEY});
try{await c.getInvoice('missing');throw Error('unexpected success')}catch(e){if(!(e instanceof ApiError)||e.status!==404||typeof e.code!=='string'||!e.code)throw Error('invalid SDK error');console.log('ok')}
'''.replace("MODULE", json.dumps((o.app / "sdk.mjs").as_uri()))
        result = js(o, s, source)
        need(result.returncode == 0 and result.stdout.strip() == "ok", "SDK error contract failed")


@group("cli-connected-workflows")
def check_49(o):
    with Service(o) as s:
        for args in (["accounts", "list"], ["quote", "legacy-a", PERIOD], ["usage", "add", "legacy-a", "cli-usage", "2", DATE]):
            result = cli(o, s, args)
            need(result.returncode == 0 and not result.stderr.strip())
            json.loads(result.stdout)
        result = cli(o, s, ["invoice", "issue", "legacy-a", PERIOD, "cli-invoice"])
        need(result.returncode == 0 and not result.stderr.strip())
        invoice = json.loads(result.stdout)
        result = cli(o, s, ["credit", "add", invoice["id"], "cli-credit", "10", "CLI credit"])
        need(result.returncode == 0 and json.loads(result.stdout)["amountCents"] == 10)
        result = cli(o, s, ["invoice", "show", invoice["id"]])
        need(result.returncode == 0 and json.loads(result.stdout)["balanceCents"] == invoice["totalCents"] - 10)


@group("cli-error-and-secret-contract")
def check_50(o):
    with Service(o) as s:
        for args in (["invoice", "show", "missing"], ["not-a-command"], ["credit", "add"]):
            result = cli(o, s, args, key="reader-acme")
            need(result.returncode != 0 and not result.stdout.strip() and "reader-acme" not in result.stderr)
            value = json.loads(result.stderr)
            need(isinstance(value.get("error", {}).get("code"), str) and value["error"]["code"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "runtime", "node", "typescript"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("node-prequalification", "bun-qualification"), required=True)
    options = parser.parse_args(argv)
    for name, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, name, value.resolve())
    need(options.app.is_dir() and options.out != options.app and not options.out.is_relative_to(options.app), "output/source overlap")
    options.out.mkdir(parents=True, exist_ok=False)
    inventory = json.loads((HERE / "CHECK-INVENTORY.json").read_bytes())
    need([name for name, _ in GROUPS] == inventory["business"] and len(GROUPS) == 50, "preregistered inventory drift")
    before = manifest(options.app)
    rows = []
    def record(name, scope, function):
        try:
            function()
            rows.append({"name": name, "scope": scope, "passed": True})
        except Exception as error:
            rows.append({"name": name, "scope": scope, "passed": False,
                         "error": type(error).__name__ + ": " + (str(error)[:180] if isinstance(error, AssertionError) else "fixture operation failed")})
    def syntax():
        for name in ("app.mjs", "cli.mjs", "sdk.mjs"):
            need(owned_process.run([str(options.node), "--check", str(options.app / name)], cwd=options.app,
                env=environment(), capture_output=True, text=True, timeout=8).returncode == 0, "module syntax check failed")
        proof = owned_process.run([str(options.runtime), "-e", "process.stdout.write(JSON.stringify({bun:!!process.versions.bun}))"],
            env=environment(), capture_output=True, text=True, timeout=4)
        need(proof.returncode == 0 and json.loads(proof.stdout)["bun"] is (options.mode == "bun-qualification"), "runtime mode differs from actual binary")
    def readiness():
        with Service(options) as service:
            need(service.request("GET", "/health", key=None)[0] == 200)
    def dependencies():
        package = json.loads((options.app / "package.json").read_bytes())
        need(all(not package.get(key) for key in ("dependencies", "devDependencies", "optionalDependencies")), "external dependency added")
    record("source-syntax", "prerequisite", syntax)
    record("server-readiness", "prerequisite", readiness)
    record("no-external-dependencies", "prerequisite", dependencies)
    for name, function in GROUPS:
        record(name, "business", lambda function=function: function(options))
    record("authored-source-unchanged", "prerequisite", lambda: need(manifest(options.app) == before, "evaluation changed authored sources"))
    passed = sum(row["passed"] for row in rows)
    report = {"kind": "ledgerdesk-maintenance-gate-v1", "mode": options.mode, "runtimeQualified": options.mode == "bun-qualification" and passed == 54,
              "checks": rows, "checksTotal": 54, "checksPassed": passed, "businessTotal": 50,
              "businessPassed": sum(row["passed"] and row["scope"] == "business" for row in rows), "prerequisitesTotal": 4,
              "prerequisitesPassed": sum(row["passed"] and row["scope"] == "prerequisite" for row in rows),
              "passed": passed == 54, "sourceUnchanged": before == manifest(options.app),
              "sourceSha256": before, "seedPassesAreNotForcedToZero": True, "providerCalls": 0}
    (options.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("checksPassed", "businessPassed", "prerequisitesPassed", "passed")}))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
