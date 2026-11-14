"""Independent Foundry evaluation. Synthetic data, local processes, zero model calls."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import time
from typing import NamedTuple
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
PASSWORD = "Foundry-Synthetic!2026"
EMAILS = ["owner@example.invalid", "member@example.invalid", "reader@example.invalid", "manager@example.invalid"]
API_GROUPS = ["authentication_bootstrap", "sessions_password_storage", "workspaces_selection", "invites_email_single_use", "roles_owner_protection", "tenant_boundary", "customers_crud_search", "customers_uniqueness_validation", "products_crud_cents", "stock_ledger_validation", "stock_concurrency", "orders_price_snapshots", "draft_order_state_machine", "fulfillment_atomic_retry", "fulfillment_idempotency", "fulfillment_competing_orders", "fulfillment_same_key_concurrency", "invoices_snapshot_validation", "invoice_number_concurrency", "invoice_status_transitions", "projects_crud", "tasks_crud_filters_validation", "comments_permissions", "project_cascade", "csv_import_atomicity", "csv_exports_roundtrip", "attachments_bytes_auth", "attachment_validation_paths", "attachment_cascade", "activity_sync_analytics", "membership_revocation", "restart_persistence"]


class NotReady(Exception):
    pass


def require(value, message):
    if not value:
        raise AssertionError(message)


class Response(NamedTuple):
    status: int
    value: object
    headers: object
    body: bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPCookieProcessor(self.cookies))

    def call(self, method, route, payload=None, raw=None, headers=None):
        data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + route, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            response = self.opener.open(request, timeout=8)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(8_388_608)
            try:
                value = json.loads(body)
            except (ValueError, UnicodeError):
                value = None
            return Response(response.status, value, response.headers, body)

    def cookie(self):
        return "; ".join(cookie.name + "=" + cookie.value for cookie in self.cookies)


def expected(response, status):
    require(response.status == status, f"expected HTTP{status}, received{response.status}")
    return response.value


def error(response, status):
    allowed = (status,) if isinstance(status, int) else tuple(status)
    require(response.status in allowed, f"expected HTTP{'/'.join(map(str, allowed))}, received{response.status}")
    value = response.value
    require(isinstance(value, dict) and isinstance(value.get("error"), dict), "JSON error envelope missing")
    require(all(isinstance(value["error"].get(key), str) and value["error"][key] for key in ("code", "message")), "error code/message missing")


def sanitized_env(home, bun, node):
    home.mkdir(parents=True, exist_ok=True)
    local, roaming = home / "AppData" / "Local", home / "AppData" / "Roaming"
    local.mkdir(parents=True, exist_ok=True); roaming.mkdir(parents=True, exist_ok=True)
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if key in os.environ}
    env.update({"PATH": str(bun.parent) + os.pathsep + str(node.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": str(home), "USERPROFILE": str(home), "TEMP": str(home), "TMP": str(home), "LOCALAPPDATA": str(local), "APPDATA": str(roaming), "CI": "1", "NO_COLOR": "1"})
    return env


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(5)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(5)


def command(args, cwd, env, prefix, timeout=120):
    with prefix.with_suffix(".stdout.log").open("w", encoding="utf-8") as stdout, prefix.with_suffix(".stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        timed_out = False
        try:
            code = process.wait(timeout)
        except subprocess.TimeoutExpired:
            timed_out = True; terminate(process); code = process.returncode
    return {"exitCode": code, "timedOut": timed_out}


class Server:
    def __init__(self, app, out, bun, node, port):
        self.app, self.out, self.bun = app, out, bun
        self.env = sanitized_env(out / "runtime-home", bun, node)
        self.env.update({"PORT": str(port), "DATA_DIR": str((out / "data").resolve()), "NODE_ENV": "production"})
        self.base, self.process, self.logs = f"http://127.0.0.1:{port}", None, []

    def start(self):
        label = str(len(self.logs) // 2 + 1)
        stdout = (self.out / f"server-{label}.stdout.log").open("w", encoding="utf-8")
        stderr = (self.out / f"server-{label}.stderr.log").open("w", encoding="utf-8")
        self.logs.extend([stdout, stderr])
        self.process = subprocess.Popen([str(self.bun), "--no-env-file", "run", "start"], cwd=self.app, env=self.env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError("owned app server exited before health check")
            try:
                response = Client(self.base).call("GET", "/api/health")
                if response.status == 200 and isinstance(response.value, dict) and response.value.get("ok") is True:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(.15)
        raise AssertionError("owned app server did not become healthy")

    def stop(self):
        if self.process is not None:
            terminate(self.process); self.process = None

    def close(self):
        self.stop()
        for stream in self.logs:
            stream.close()


def multipart(filename, body, entity_type, entity_id, mime="text/plain"):
    boundary = "foundry-eval-" + uuid.uuid4().hex
    pieces = []
    for name, value in (("entityType", entity_type), ("entityId", entity_id)):
        pieces.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    pieces.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + body + b"\r\n")
    pieces.append(f"--{boundary}--\r\n".encode())
    return b"".join(pieces), {"Content-Type": "multipart/form-data; boundary=" + boundary}


def api_evaluate(server, password_hashes):
    a, b, c, d, anonymous = [Client(server.base) for _ in range(5)]
    clients, state, checks = [a, b, c, d], {}, []
    def needed(*keys):
        if any(key not in state for key in keys):
            raise NotReady("prerequisite data missing: " + ", ".join(key for key in keys if key not in state))
    def w(path="", workspace=None):
        needed("workspace")
        return "/api/w/" + (workspace or state["workspace"]) + path
    def post(path, body, client=a):
        return expected(client.call("POST", w(path), body), 201)
    def get(path, client=a):
        return expected(client.call("GET", w(path)), 200)
    def stock(product_id, delta, reason="Synthetic opening stock"):
        return post("/stock-movements", {"productId": product_id, "delta": delta, "reason": reason})
    def product(sku, price=101):
        return post("/products", {"sku": sku, "name": sku + " sample", "priceCents": price})["product"]
    def order(items):
        needed("customer")
        return post("/orders", {"customerId": state["customer"]["id"], "items": items})["order"]
    def upload(name, body, kind, identity, client=a):
        raw, headers = multipart(name, body, kind, identity)
        return client.call("POST", w("/attachments"), raw=raw, headers=headers)
    def parallel(route_bodies):
        cookie = a.cookie()
        def send(item):
            method, route, body = item
            return Client(server.base).call(method, w(route), body, headers={"Cookie": cookie})
        with ThreadPoolExecutor(max_workers=8) as pool:
            return list(pool.map(send, route_bodies))
    def activity_count():
        return len(get("/activity?limit=200")["activity"])
    def revision():
        value = get("/sync")["revision"]
        require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, "sync revision must be a nonnegative integer")
        return value

    def authentication_bootstrap():
        for index, client in enumerate(clients):
            response = client.call("POST", "/api/auth/signup", {"name": ["Avery", "Blair", "Casey", "Drew"][index], "email": EMAILS[index], "password": PASSWORD})
            data = expected(response, 201)
            require(data["user"]["email"] == EMAILS[index], "signup identity differs")
            require(data["workspace"]["name"] == ["Avery", "Blair", "Casey", "Drew"][index] + " workspace", "private owner workspace missing")
            state["user" + str(index)] = data["user"]; state["workspace" + str(index)] = data["workspace"]["id"]
            cookie = response.headers.get("Set-Cookie", "")
            require("foundry_session=" in cookie and "httponly" in cookie.lower() and "samesite=lax" in cookie.lower() and "path=/" in cookie.lower(), "required session cookie attributes missing")
            require(len(client.cookie().split("foundry_session=", 1)[-1].split(";", 1)[0]) >= 32, "session identifier too short")
        state["workspace"] = state["workspace0"]
        require(len({state["workspace" + str(index)] for index in range(4)}) == 4, "signup reused another user's workspace")
        return {"syntheticUsers": 4, "distinctPrivateWorkspaces": 4}

    def sessions_password_storage():
        needed("workspace", "user1")
        error(anonymous.call("GET", "/api/auth/me"), 401)
        error(anonymous.call("POST", "/api/auth/login", {"email": EMAILS[0], "password": "DefinitelyWrong!"}), 401)
        error(anonymous.call("POST", "/api/auth/signup", {"name": "Again", "email": EMAILS[0].upper(), "password": PASSWORD}), 409)
        error(anonymous.call("POST", "/api/auth/signup", {"name": "Bad", "email": "bad", "password": PASSWORD}), 400)
        error(anonymous.call("POST", "/api/auth/signup", {"name": "Short", "email": "short@example.invalid", "password": "short"}), 400)
        old = b.cookie(); expected(b.call("POST", "/api/auth/logout"), 204)
        error(anonymous.call("GET", "/api/auth/me", headers={"Cookie": old}), 401)
        expected(b.call("POST", "/api/auth/login", {"email": EMAILS[1], "password": PASSWORD}), 200)
        require(b.cookie() != old, "revoked session reused on login")
        file = Path(server.env["DATA_DIR"]) / "foundry.sqlite"
        require(file.is_file(), "required DATA_DIR/foundry.sqlite database is missing")
        with sqlite3.connect(file) as db:
            rows = db.execute("SELECT email,password_hash FROM users WHERE email IN (?,?) ORDER BY email", EMAILS[:2]).fetchall()
        require(len(rows) == 2, "required users/password_hash storage contract missing")
        hashes = [row[1] for row in rows]
        require(all(isinstance(value, str) and value.startswith(("$argon2id$", "$2a$", "$2b$", "$2y$")) and len(value) >= 50 for value in hashes) and hashes[0] != hashes[1], "real salted password hashes required")
        password_hashes.extend(hashes)
        for candidate in file.parent.glob("foundry.sqlite*"):
            require(PASSWORD.encode() not in candidate.read_bytes(), "plaintext password in database")
        return {"revokedCookieRejected": True, "differentPasswordSalts": True, "postStopPasswordVerification": "pending"}

    def workspaces_selection():
        needed("workspace")
        created = expected(a.call("POST", "/api/workspaces", {"name": "Field operations"}), 201)["workspace"]
        state["secondary"] = created["id"]
        selected = expected(a.call("POST", "/api/workspaces/" + created["id"] + "/select"), 200)["workspace"]
        require(selected["id"] == created["id"] and expected(a.call("GET", "/api/auth/me"), 200)["activeWorkspaceId"] == created["id"], "active workspace did not persist")
        expected(a.call("POST", "/api/workspaces/" + state["workspace"] + "/select"), 200)
        error(b.call("POST", "/api/workspaces/" + created["id"] + "/select"), 404)
        own = expected(a.call("GET", "/api/workspaces"), 200)["workspaces"]
        require(len(own) == 2 and all(item["role"] == "owner" for item in own), "workspace list leaked another membership")
        return {"creationSelection": True, "outsiderSelectionRejected": True}

    def invites_email_single_use():
        needed("workspace", "user1", "user2", "user3")
        for index, role in ((1, "member"), (2, "read_only"), (3, "manager")):
            invite = post("/invites", {"email": EMAILS[index], "role": role})["invite"]
            require(len(invite["token"]) >= 32, "invite token too short")
            expires = datetime.fromisoformat(invite["expiresAt"].replace("Z", "+00:00"))
            require(0 < (expires - datetime.now(timezone.utc)).total_seconds() <= 7 * 86400 + 5, "invite expiry outside7days")
            if index == 1:
                error(c.call("POST", "/api/invites/accept", {"token": invite["token"]}), 404)
            joined = expected(clients[index].call("POST", "/api/invites/accept", {"token": invite["token"]}), 200)
            require(joined["workspace"]["id"] == state["workspace"], "joined wrong workspace")
            error(clients[index].call("POST", "/api/invites/accept", {"token": invite["token"]}), 409)
        require(all("token" not in row for row in get("/invites")["invites"]), "raw invite tokens leaked by list")
        error(a.call("POST", w("/invites"), {"email": "bad-role@example.invalid", "role": "owner"}), (400, 409))
        state["roles"] = True
        return {"emailBinding": True, "singleUse": True, "rolesJoined": 3}

    def roles_owner_protection():
        needed("roles")
        error(b.call("POST", w("/products"), {"sku": "DENIED", "name": "Denied", "priceCents": 1}), 403)
        error(c.call("POST", w("/customers"), {"name": "Denied"}), 403)
        error(d.call("POST", w("/invites"), {"email": "denied@example.invalid", "role": "member"}), 403)
        allowed = post("/products", {"sku": "MANAGER", "name": "Manager proof", "priceCents": 1}, d)["product"]
        expected(d.call("DELETE", w("/products/" + allowed["id"])), 204)
        error(a.call("PATCH", w("/members/" + state["user0"]["id"]), {"role": "member"}), 409)
        error(a.call("DELETE", w("/members/" + state["user0"]["id"])), 409)
        require(len(get("/members")["members"]) == 4, "owner/member roster incorrect")
        return {"serverRoleChecks": True, "ownerProtected": True}

    def tenant_boundary():
        needed("workspace1")
        foreign = expected(b.call("POST", w("/customers", state["workspace1"]), {"name": "Private tenant customer"}), 201)["customer"]
        state["foreignCustomer"] = foreign["id"]
        foreign_product = expected(b.call("POST", w("/products", state["workspace1"]), {"sku": "PRIVATE-TENANT", "name": "Private tenant product", "priceCents": 333}), 201)["product"]
        foreign_project = expected(b.call("POST", w("/projects", state["workspace1"]), {"name": "Private tenant project"}), 201)["project"]
        foreign_task = expected(b.call("POST", w("/projects/" + foreign_project["id"] + "/tasks", state["workspace1"]), {"title": "Private tenant task"}), 201)["task"]
        foreign_order = expected(b.call("POST", w("/orders", state["workspace1"]), {"customerId": foreign["id"], "items": [{"productId": foreign_product["id"], "quantity": 1}]}), 201)["order"]
        for route in ("/customers", "/products", "/orders", "/invoices", "/projects", "/activity", "/summary", "/sync", "/members"):
            error(a.call("GET", w(route, state["workspace1"])), 404)
            error(anonymous.call("GET", w(route)), 401)
        forged = a.call("POST", w("/customers"), {"name": "Safe override", "workspaceId": state["workspace1"], "userId": state["user1"]["id"]})
        require(forged.status in (400, 201), "ownership override neither rejected nor safely handled")
        require(len(expected(b.call("GET", w("/customers", state["workspace1"])), 200)["customers"]) == 1, "client ownership override changed foreign data")
        error(a.call("GET", w("/customers/" + foreign["id"])), 404)
        for kind, row in (("products", foreign_product), ("projects", foreign_project), ("tasks", foreign_task), ("orders", foreign_order)):
            error(a.call("GET", w("/" + kind + "/" + row["id"])), 404)
        error(a.call("PATCH", w("/products/" + foreign_product["id"]), {"priceCents": 999}), 404)
        error(a.call("POST", w("/stock-movements"), {"productId": foreign_product["id"], "delta": 1, "reason": "Foreign reference denied"}), 404)
        require(expected(b.call("GET", w("/products/" + foreign_product["id"], state["workspace1"])), 200)["product"]["priceCents"] == 333, "foreign product changed through ID reference")
        return {"tenantAndAnonymousListRoutes": 18, "foreignChildReadsAndMutations": 6, "ownershipOverridesSafe": True}

    def customers_crud_search():
        needed("workspace")
        row = post("/customers", {"name": "Northstar Labs", "email": "northstar@example.invalid", "company": "Northstar", "notes": "Synthetic account"})["customer"]
        state["customer"] = row
        changed = expected(a.call("PATCH", w("/customers/" + row["id"]), {"notes": "Review, then \"ship\"\nSecond line"}), 200)["customer"]
        require(changed["name"] == row["name"] and changed["notes"].endswith("Second line"), "partial customer update lost data")
        require(any(item["id"] == row["id"] for item in get("/customers?q=NORTHSTAR")["customers"]), "case-insensitive customer search failed")
        unused = post("/customers", {"name": "Delete customer"})["customer"]
        expected(a.call("DELETE", w("/customers/" + unused["id"])), 204); error(a.call("GET", w("/customers/" + unused["id"])), 404)
        return {"createReadUpdateDeleteSearch": True}

    def customers_uniqueness_validation():
        needed("customer", "workspace1")
        error(a.call("POST", w("/customers"), {"name": "Duplicate", "email": "NORTHSTAR@EXAMPLE.INVALID"}), 409)
        error(a.call("POST", w("/customers"), {"name": "   "}), 400)
        error(a.call("POST", w("/customers"), {"name": "Bad email", "email": "invalid"}), 400)
        expected(b.call("POST", w("/customers", state["workspace1"]), {"name": "Other tenant same email", "email": "northstar@example.invalid"}), 201)
        error(a.call("POST", w("/customers"), raw=b"{broken"), 400)
        error(a.call("GET", "/api/not-a-real-route"), 404)
        return {"workspaceScopedUniqueness": True, "invalidInputErrors": True}

    def products_crud_cents():
        needed("workspace")
        p1 = product("EVAL-A", 1999); p2 = product("EVAL-B", 349)
        state.update({"p1": p1, "p2": p2})
        require(p1["stock"] == 0 and p1["priceCents"] == 1999, "product stock/price not exact")
        require(any(item["id"] == p1["id"] for item in get("/products?q=eval-a")["products"]), "product search failed")
        error(a.call("POST", w("/products"), {"sku": "eval-a", "name": "Duplicate", "priceCents": 1}), 409)
        error(a.call("PATCH", w("/products/" + p1["id"]), {"stock": 99}), 400)
        error(a.call("POST", w("/products"), {"sku": "FRACTION", "name": "Fraction", "priceCents": 1.5}), 400)
        unused = product("DELETE-ME"); expected(a.call("DELETE", w("/products/" + unused["id"])), 204)
        return {"integerCents": True, "skuUniqueness": True, "stockProtected": True}

    def stock_ledger_validation():
        needed("p1", "p2")
        first = stock(state["p1"]["id"], 10); stock(state["p2"]["id"], 1)
        require(first["product"]["stock"] == 10 and first["movement"]["delta"] == 10 and first["movement"]["kind"] == "adjustment", "stock ledger did not match product")
        before, rev = activity_count(), revision()
        error(a.call("POST", w("/stock-movements"), {"productId": state["p1"]["id"], "delta": -11, "reason": "Rejected"}), 409)
        error(a.call("POST", w("/stock-movements"), {"productId": state["p1"]["id"], "delta": 0, "reason": "Zero"}), 400)
        require(get("/products/" + state["p1"]["id"])["product"]["stock"] == 10 and activity_count() == before and revision() == rev, "failed stock write changed durable state/activity")
        unsupported = a.call("DELETE", w("/stock-movements/" + first["movement"]["id"]))
        require(unsupported.status in (404, 405), "immutable stock movement was deletable")
        error(a.call("DELETE", w("/products/" + state["p1"]["id"])), 409)
        return {"ledgerImmutable": True, "negativeStockAtomic": True}

    def stock_concurrency():
        needed("workspace")
        row = product("CONCURRENT-STOCK")
        calls = [("POST", "/stock-movements", {"productId": row["id"], "delta": 1, "reason": "Concurrent receipt"}) for _ in range(8)]
        require(all(response.status == 201 for response in parallel(calls)), "concurrent stock receipts failed")
        require(get("/products/" + row["id"])["product"]["stock"] == 8, "stock increments lost updates")
        return {"concurrentReceipts": 8, "finalStock": 8}

    def orders_price_snapshots():
        needed("customer", "p1", "p2")
        row = order([{"productId": state["p1"]["id"], "quantity": 3}, {"productId": state["p2"]["id"], "quantity": 2}])
        state["order"] = row
        require(row["status"] == "draft" and row["totalCents"] == 6695 and len(row["items"]) == 2 and row["number"].startswith("ORD-"), "order snapshots/totals incorrect")
        require(all(isinstance(item["unitPriceCents"], int) and isinstance(item["quantity"], int) and item["lineTotalCents"] == item["unitPriceCents"] * item["quantity"] and item["sku"] and item["name"] for item in row["items"]) and sum(item["lineTotalCents"] for item in row["items"]) == row["totalCents"], "order line snapshots do not add up exactly")
        expected(a.call("PATCH", w("/products/" + state["p1"]["id"]), {"priceCents": 9999}), 200)
        reread = get("/orders/" + row["id"])["order"]
        require(reread["totalCents"] == 6695 and next(item for item in reread["items"] if item["productId"] == state["p1"]["id"])["unitPriceCents"] == 1999, "catalog edit rewrote an order")
        error(a.call("DELETE", w("/customers/" + state["customer"]["id"])), 409)
        return {"centsExact": True, "catalogPriceSnapshot": True}

    def draft_order_state_machine():
        needed("customer", "p1", "foreignCustomer")
        row = order([{"productId": state["p1"]["id"], "quantity": 1}])
        changed = expected(a.call("PATCH", w("/orders/" + row["id"]), {"items": [{"productId": state["p1"]["id"], "quantity": 2}]}), 200)["order"]
        require(changed["totalCents"] == 19998, "explicit draft edit did not refresh catalog snapshot")
        error(a.call("POST", w("/orders"), {"customerId": state["foreignCustomer"], "items": [{"productId": state["p1"]["id"], "quantity": 1}]}), 404)
        error(a.call("POST", w("/orders"), {"customerId": state["customer"]["id"], "items": [{"productId": state["p1"]["id"], "quantity": 0}]}), 400)
        cancelled = expected(a.call("POST", w("/orders/" + row["id"] + "/cancel")), 200)["order"]
        require(cancelled["status"] == "cancelled", "cancel did not change draft state")
        error(a.call("PATCH", w("/orders/" + row["id"]), {"items": [{"productId": state["p1"]["id"], "quantity": 1}]}), 409)
        removable = order([{"productId": state["p1"]["id"], "quantity": 1}])
        expected(a.call("DELETE", w("/orders/" + removable["id"])), 204)
        return {"draftEditCancelDelete": True, "foreignAndInvalidLinesRejected": True}

    def fulfillment_atomic_retry():
        needed("customer", "p1", "p2")
        row = order([{"productId": state["p1"]["id"], "quantity": 2}, {"productId": state["p2"]["id"], "quantity": 2}])
        before = [get("/products/" + state[key]["id"])["product"]["stock"] for key in ("p1", "p2")]
        movements, activity, rev = len(get("/stock-movements")["movements"]), activity_count(), revision()
        key = "retry-after-stock-arrives"
        error(a.call("POST", w("/orders/" + row["id"] + "/fulfill"), {"idempotencyKey": key}), 409)
        require([get("/products/" + state[item]["id"])["product"]["stock"] for item in ("p1", "p2")] == before, "failed fulfillment partially decremented inventory")
        require(len(get("/stock-movements")["movements"]) == movements and activity_count() == activity and revision() == rev, "failed fulfillment created movements/activity/revision")
        stock(state["p2"]["id"], 10)
        result = expected(a.call("POST", w("/orders/" + row["id"] + "/fulfill"), {"idempotencyKey": key}), 200)
        require(result["order"]["status"] == "fulfilled", "failed attempt consumed retryable idempotency key")
        return {"allLinesAtomic": True, "failedKeyRetryable": True}

    def fulfillment_idempotency():
        needed("order", "p1", "p2")
        path = "/orders/" + state["order"]["id"] + "/fulfill"
        key = "permanent-eval-order-key"
        first = expected(a.call("POST", w(path), {"idempotencyKey": key}), 200)
        before = [get("/products/" + state[item]["id"])["product"]["stock"] for item in ("p1", "p2")]
        activity, rev = activity_count(), revision()
        replay = expected(a.call("POST", w(path), {"idempotencyKey": key}), 200)
        require(first["replayed"] is False and replay["replayed"] is True and first["order"] == replay["order"], "idempotent replay is not the same persisted order")
        require([get("/products/" + state[item]["id"])["product"]["stock"] for item in ("p1", "p2")] == before and activity_count() == activity and revision() == rev, "idempotent replay applied twice")
        moves = [move for move in get("/stock-movements")["movements"] if move["orderId"] == state["order"]["id"]]
        require(len(moves) == 2 and all(move["kind"] == "fulfillment" and move["delta"] < 0 for move in moves), "fulfillment movement ledger incorrect")
        error(a.call("POST", w(path), {"idempotencyKey": "different-fulfilled-key"}), 409)
        other = order([{"productId": state["p1"]["id"], "quantity": 1}])
        error(a.call("POST", w("/orders/" + other["id"] + "/fulfill"), {"idempotencyKey": key}), 409)
        state["fulfilled"] = first["order"]; state["persistentKey"] = key
        return {"exactlyOnce": True, "replayedOrderIdentical": True}

    def fulfillment_competing_orders():
        needed("customer")
        row = product("CONTENDED"); stock(row["id"], 5)
        orders = [order([{"productId": row["id"], "quantity": 4}]) for _ in range(2)]
        replies = parallel([("POST", "/orders/" + item["id"] + "/fulfill", {"idempotencyKey": "compete-" + str(index)}) for index, item in enumerate(orders)])
        require(sorted(reply.status for reply in replies) == [200, 409], "competing orders did not yield exactly one success")
        require(get("/products/" + row["id"])["product"]["stock"] == 1, "competing orders oversold stock")
        state["concurrentInvoiceOrder"] = next(reply.value["order"] for reply in replies if reply.status == 200)
        return {"concurrentStatuses": [reply.status for reply in replies], "stock": 1}

    def fulfillment_same_key_concurrency():
        needed("customer")
        row = product("REPLAY-RACE"); stock(row["id"], 8)
        created = order([{"productId": row["id"], "quantity": 3}])
        body = {"idempotencyKey": "concurrent-same-idempotency-key"}
        replies = parallel([("POST", "/orders/" + created["id"] + "/fulfill", body)] * 2)
        require(all(reply.status == 200 for reply in replies) and sorted(reply.value["replayed"] for reply in replies) == [False, True], "same-key race did not converge to one application")
        require(get("/products/" + row["id"])["product"]["stock"] == 5, "same-key race decremented twice")
        require(len([move for move in get("/stock-movements")["movements"] if move["orderId"] == created["id"]]) == 1, "same-key race duplicated movements")
        state["replayInvoiceOrder"] = created
        return {"sameKeyConcurrentReplay": True}

    def invoices_snapshot_validation():
        needed("fulfilled", "customer", "p1")
        row = post("/invoices", {"orderId": state["fulfilled"]["id"]})["invoice"]
        state["invoice"] = row
        error(a.call("PATCH", w("/invoices/" + row["id"]), {"totalCents": 1}), 400)
        require(row["status"] == "draft" and row["paidAt"] is None and row["currency"] == "USD" and row["totalCents"] == 6695 and row["subtotalCents"] == 6695 and row["number"].startswith("INV-"), "invoice creation state/cents incorrect")
        item_keys = ("productId", "sku", "name", "unitPriceCents", "quantity", "lineTotalCents")
        canonical = lambda items: sorted(({key: item[key] for key in item_keys} for item in items), key=lambda item: item["productId"])
        require(sum(item["lineTotalCents"] for item in row["items"]) == row["totalCents"] and canonical(row["items"]) == canonical(state["fulfilled"]["items"]), "invoice did not preserve exact fulfilled order line snapshots")
        bill_to, items = row["billTo"], row["items"]
        expected(a.call("PATCH", w("/customers/" + state["customer"]["id"]), {"name": "Northstar renamed"}), 200)
        expected(a.call("PATCH", w("/products/" + state["p1"]["id"]), {"priceCents": 12345}), 200)
        reread = get("/invoices/" + row["id"])["invoice"]
        require(reread["billTo"] == bill_to and reread["items"] == items and reread["totalCents"] == 6695, "invoice changed after customer/catalog edit")
        error(a.call("POST", w("/invoices"), {"orderId": state["fulfilled"]["id"]}), 409)
        draft = order([{"productId": state["p1"]["id"], "quantity": 1}])
        error(a.call("POST", w("/invoices"), {"orderId": draft["id"]}), 409)
        return {"invoiceSnapshotsImmutable": True, "oneInvoicePerFulfilledOrder": True}

    def invoice_number_concurrency():
        needed("concurrentInvoiceOrder", "replayInvoiceOrder")
        replies = parallel([("POST", "/invoices", {"orderId": state[key]["id"]}) for key in ("concurrentInvoiceOrder", "replayInvoiceOrder")])
        require(all(reply.status == 201 for reply in replies), "concurrent invoice creation failed")
        numbers = [reply.value["invoice"]["number"] for reply in replies]
        require(len(set(numbers)) == 2, "concurrent invoice numbers duplicated")
        state["voidInvoice"] = replies[0].value["invoice"]
        return {"distinctConcurrentInvoiceNumbers": numbers}

    def invoice_status_transitions():
        needed("invoice", "voidInvoice")
        path = "/invoices/" + state["invoice"]["id"]
        error(a.call("PATCH", w(path), {"status": "paid"}), 409)
        expected(a.call("PATCH", w(path), {"status": "sent"}), 200)
        paid = expected(a.call("PATCH", w(path), {"status": "paid"}), 200)["invoice"]
        require(paid["paidAt"] and paid["status"] == "paid", "payment status/time not recorded")
        error(a.call("PATCH", w(path), {"status": "void"}), 409)
        expected(a.call("PATCH", w("/invoices/" + state["voidInvoice"]["id"]), {"status": "void"}), 200)
        return {"paidAndVoidTerminal": True}

    def projects_crud():
        needed("workspace")
        row = post("/projects", {"name": "Launch operations", "description": "Synthetic cross-functional delivery"})["project"]
        state["project"] = row
        changed = expected(a.call("PATCH", w("/projects/" + row["id"]), {"description": "Durable synthetic delivery plan"}), 200)["project"]
        require(changed["name"] == row["name"] and changed["description"].startswith("Durable"), "project patch lost fields")
        require(any(item["id"] == row["id"] for item in get("/projects")["projects"]), "project list missing created project")
        return {"projectCrud": True}

    def tasks_crud_filters_validation():
        needed("project", "user1")
        path = "/projects/" + state["project"]["id"] + "/tasks"
        row = post(path, {"title": "Launch report", "description": "Synthetic market review", "status": "in_progress", "priority": "high", "assigneeId": state["user1"]["id"], "dueDate": "2026-12-01"})["task"]
        state["task"] = row
        post(path, {"title": "Follow-up", "priority": "low"})
        query = urllib.parse.urlencode({"q": "MARKET", "status": "in_progress", "priority": "high", "assigneeId": state["user1"]["id"]})
        require([item["id"] for item in get(path + "?" + query)["tasks"]] == [row["id"]], "composed task filters/search failed")
        require(any(item["id"] == row["id"] for item in get("/tasks?projectId=" + state["project"]["id"])["tasks"]), "global project task filter failed")
        error(a.call("PATCH", w("/tasks/" + row["id"]), {"title": "Do not commit", "status": "invalid"}), 400)
        require(get("/tasks/" + row["id"])["task"]["title"] == "Launch report", "invalid task patch partially committed")
        error(a.call("POST", w(path), {"title": "Impossible date", "dueDate": "2026-02-30"}), 400)
        outsider = expected(Client(server.base).call("POST", "/api/auth/signup", {"name": "Outside", "email": "outside-assignee@example.invalid", "password": PASSWORD}), 201)["user"]
        error(a.call("POST", w(path), {"title": "Foreign assignee", "assigneeId": outsider["id"]}), 404)
        changed = expected(a.call("PATCH", w("/tasks/" + row["id"]), {"status": "done"}), 200)["task"]
        require(changed["status"] == "done", "task movement not persisted")
        return {"kanbanAndComposedFilters": True, "atomicValidation": True}

    def comments_permissions():
        needed("task", "roles")
        path = "/tasks/" + state["task"]["id"] + "/comments"
        row = post(path, {"body": "Synthetic member review, safely rendered."}, b)["comment"]
        require(row["author"]["id"] == state["user1"]["id"], "comment author forged/missing")
        error(c.call("POST", w(path), {"body": "Denied read-only mutation"}), 403)
        error(c.call("DELETE", w("/comments/" + row["id"])), 403)
        expected(b.call("DELETE", w("/comments/" + row["id"])), 204)
        kept = post(path, {"body": "Persist this owner comment."})["comment"]
        state["comment"] = kept
        require(any(item["id"] == kept["id"] for item in get(path)["comments"]), "comment not persisted")
        return {"authorPermission": True, "readOnlyDenied": True}

    def project_cascade():
        needed("workspace")
        row = post("/projects", {"name": "Disposable project"})["project"]
        task = post("/projects/" + row["id"] + "/tasks", {"title": "Disposable task"})["task"]
        post("/tasks/" + task["id"] + "/comments", {"body": "Cascade me"})
        expected(a.call("DELETE", w("/projects/" + row["id"])), 204)
        error(a.call("GET", w("/tasks/" + task["id"])), 404)
        error(a.call("GET", w("/tasks/" + task["id"] + "/comments")), 404)
        return {"projectTaskCommentCascade": True}

    def csv_import_atomicity():
        needed("workspace")
        content = 'name,email,company,notes\r\n"CSV, Studio",csv-studio@example.invalid,"Quoted \"\"Company\"\"","First line\nSecond line"\r\n"  =SUM(1,2)",formula@example.invalid,@company,Safe text\r\n'
        imported = post("/import/customers", {"csv": content})
        require(imported["imported"] == 2, "quoted multiline CSV did not import both rows")
        rows = get("/customers")["customers"]
        row = next(item for item in rows if item["email"] == "csv-studio@example.invalid")
        require(row["name"] == "CSV, Studio" and row["company"] == 'Quoted "Company"' and row["notes"] == "First line\nSecond line", "CSV parser lost commas/quotes/newlines")
        state["csvCustomer"] = row
        before = len(rows)
        error(a.call("POST", w("/import/customers"), {"csv": "name,email,company,notes\nWould partially import,partial@example.invalid,,\nInvalid,bad-email,,\n"}), 400)
        require(len(get("/customers")["customers"]) == before, "invalid CSV partially committed")
        error(a.call("POST", w("/import/customers"), {"csv": "name,email,company,notes\nDuplicate,csv-studio@example.invalid,,\n"}), 409)
        require(len(get("/customers")["customers"]) == before, "duplicate CSV partially committed")
        error(a.call("POST", w("/import/customers"), {"csv": 'name,email,company,notes\n"Unterminated'}), 400)
        error(a.call("POST", w("/import/customers"), {"csv": "name,email,company,notes\n" + "".join(f"Too many{index},rows{index}@example.invalid,,\n" for index in range(201))}), 400)
        require(len(get("/customers")["customers"]) == before, "malformed/oversized row-count CSV partially committed")
        return {"quotedMultilineImport": True, "invalidImportAtomic": True}

    def csv_exports_roundtrip():
        needed("csvCustomer", "roles")
        headers = {"customers": "id,name,email,company,notes", "products": "id,sku,name,description,priceCents,stock", "orders": "id,number,customerId,status,totalCents", "invoices": "id,number,orderId,status,totalCents", "tasks": "id,projectId,title,description,status,priority,assigneeId,dueDate"}
        for kind, columns in headers.items():
            response = c.call("GET", w("/export.csv?type=" + kind))
            expected(response, 200)
            require("text/csv" in response.headers.get("Content-Type", "").lower() and "attachment" in response.headers.get("Content-Disposition", "").lower(), "CSV download headers missing")
            rows = list(csv.DictReader(io.StringIO(response.body.decode("utf-8-sig"), newline="")))
            require(rows and list(rows[0]) == columns.split(","), "CSV export columns/data missing: " + kind)
            if kind == "customers":
                row = next(item for item in rows if item["id"] == state["csvCustomer"]["id"])
                require(row["notes"] == "First line\nSecond line" and row["company"] == 'Quoted "Company"', "CSV export escaping lost source text")
                formula = next(item for item in rows if item["email"] == "formula@example.invalid")
                require(formula["name"].startswith("'") and formula["company"].startswith("'"), "formula-capable cells not neutralized")
        return {"exportTypes": 5, "readOnlyCanExport": True, "escapingAndFormulaSafety": True}

    def attachments_bytes_auth():
        needed("customer", "roles")
        contents = b"Synthetic evidence, exact bytes.\n\x00Binary-safe tail\n"
        attachment = expected(upload("evidence.txt", contents, "customer", state["customer"]["id"], b), 201)["attachment"]
        state["attachment"] = attachment; state["attachmentBytes"] = contents
        require(attachment["fileName"] == "evidence.txt" and attachment["size"] == len(contents) and attachment["createdBy"] == state["user1"]["id"], "attachment metadata/ownership incorrect")
        downloaded = c.call("GET", w("/attachments/" + attachment["id"] + "/download"))
        expected(downloaded, 200)
        require(downloaded.body == contents and "attachment" in downloaded.headers.get("Content-Disposition", "").lower(), "attachment bytes/download disposition incorrect")
        same_name = expected(upload("evidence.txt", b"different owned bytes", "customer", state["customer"]["id"], b), 201)["attachment"]
        require(same_name["id"] != attachment["id"] and a.call("GET", w("/attachments/" + attachment["id"] + "/download")).body == contents, "same-name attachment upload overwrote existing owned bytes")
        expected(b.call("DELETE", w("/attachments/" + same_name["id"])), 204)
        error(anonymous.call("GET", w("/attachments/" + attachment["id"] + "/download")), 401)
        error(b.call("GET", w("/attachments/" + attachment["id"] + "/download", state["workspace1"])), 404)
        error(c.call("DELETE", w("/attachments/" + attachment["id"])), 403)
        temporary = expected(upload("remove.txt", b"delete", "customer", state["customer"]["id"], b), 201)["attachment"]
        expected(b.call("DELETE", w("/attachments/" + temporary["id"])), 204)
        error(a.call("GET", w("/attachments/" + temporary["id"] + "/download")), 404)
        return {"exactStoredBytes": True, "downloadAuthorization": True, "uploaderDelete": True}

    def attachment_validation_paths():
        needed("customer", "foreignCustomer")
        error(upload("payload.exe", b"not executable", "customer", state["customer"]["id"]), 415)
        error(upload("too-large.txt", b"x" * (2 * 1024 * 1024 + 1), "customer", state["customer"]["id"]), 413)
        error(upload("foreign.txt", b"foreign", "customer", state["foreignCustomer"]), 404)
        canary = server.out / "escape.txt"
        require(not canary.exists(), "owned evaluation path unexpectedly contains traversal canary")
        traversed = upload("../escape.txt", b"must stay inside data", "customer", state["customer"]["id"])
        require(traversed.status in (400, 201), "traversal filename neither rejected nor safely normalized")
        if traversed.status == 201:
            attachment = traversed.value["attachment"]
            require(attachment["fileName"] == "escape.txt", "normalized filename still contains a path")
            expected(a.call("DELETE", w("/attachments/" + attachment["id"])), 204)
        require(not canary.exists(), "attachment traversal wrote outside DATA_DIR")
        return {"sizeTypeForeignReferences": True, "traversalRejectedOrSafeParserNormalization": True}

    def attachment_cascade():
        needed("project")
        task = post("/projects/" + state["project"]["id"] + "/tasks", {"title": "Attachment cascade"})["task"]
        attachment = expected(upload("cascade.txt", b"cascade", "task", task["id"]), 201)["attachment"]
        expected(a.call("DELETE", w("/tasks/" + task["id"])), 204)
        error(a.call("GET", w("/attachments/" + attachment["id"] + "/download")), 404)
        require(not any(path.read_bytes() == b"cascade" for path in Path(server.env["DATA_DIR"]).rglob("*") if path.is_file() and path.stat().st_size == 7), "entity cascade left owned attachment file behind")
        return {"taskAttachmentCascade": True}

    def activity_sync_analytics():
        needed("workspace1", "invoice", "task")
        summary = get("/summary")
        customers, products, orders, invoices, tasks = [get("/" + key)[key] for key in ("customers", "products", "orders", "invoices", "tasks")]
        expected_values = {"customers": len(customers), "products": len(products), "lowStockProducts": sum(item["stock"] <= 5 for item in products), "openOrders": sum(item["status"] == "draft" for item in orders), "fulfilledOrders": sum(item["status"] == "fulfilled" for item in orders), "revenueCents": sum(item["totalCents"] for item in invoices if item["status"] == "paid"), "unpaidCents": sum(item["totalCents"] for item in invoices if item["status"] in ("draft", "sent")), "openTasks": sum(item["status"] != "done" for item in tasks), "completedTasks": sum(item["status"] == "done" for item in tasks)}
        require(all(summary.get(key) == value for key, value in expected_values.items()), "workspace overview analytics differ from actual records")
        actions = {item["action"] for item in get("/activity?limit=200")["activity"]}
        require({"customer.created", "stock.adjusted", "order.fulfilled", "invoice.paid", "task.created", "comment.created", "attachment.created"}.issubset(actions), "required real activity actions missing")
        rev = revision()
        expected(b.call("POST", w("/customers", state["workspace1"]), {"name": "Other tenant update"}), 201)
        require(revision() == rev, "other tenant changed this workspace sync revision")
        post("/customers", {"name": "Local live update"})
        require(revision() > rev, "successful local write did not advance sync revision")
        return {"analyticsMatchRecords": True, "tenantScopedSync": True, "activityActions": sorted(actions)}

    def membership_revocation():
        needed("roles", "user2")
        uid = state["user2"]["id"]
        expected(a.call("PATCH", w("/members/" + uid), {"role": "member"}), 200)
        post("/customers", {"name": "Promoted member write"}, c)
        expected(a.call("DELETE", w("/members/" + uid)), 204)
        error(c.call("GET", w("/customers")), 404)
        error(c.call("POST", w("/customers"), {"name": "Revoked must not write"}), 404)
        return {"promotionEffective": True, "revocationImmediate": True}

    def restart_persistence():
        needed("customer", "project", "task", "comment", "attachment", "fulfilled", "persistentKey")
        before = get("/products/" + state["p1"]["id"])["product"]["stock"]
        server.stop(); server.start()
        me = expected(a.call("GET", "/api/auth/me"), 200)
        require(me["activeWorkspaceId"] == state["workspace"], "durable session/workspace selection missing after restart")
        require(get("/customers/" + state["customer"]["id"])["customer"]["name"] == "Northstar renamed", "customer not persisted")
        require(get("/tasks/" + state["task"]["id"])["task"]["status"] == "done", "task not persisted")
        require(any(item["id"] == state["comment"]["id"] for item in get("/tasks/" + state["task"]["id"] + "/comments")["comments"]), "comment not persisted")
        response = a.call("GET", w("/attachments/" + state["attachment"]["id"] + "/download")); expected(response, 200)
        require(response.body == state["attachmentBytes"], "file bytes did not survive restart")
        replay = expected(a.call("POST", w("/orders/" + state["fulfilled"]["id"] + "/fulfill"), {"idempotencyKey": state["persistentKey"]}), 200)
        require(replay["replayed"] is True and get("/products/" + state["p1"]["id"])["product"]["stock"] == before, "idempotency did not survive restart")
        return {"sessionsBusinessDataFilesAndIdempotencySurviveRestart": True}

    functions = locals()
    for name in API_GROUPS:
        started = time.monotonic()
        try:
            facts = functions[name]()
            checks.append({"name": name, "status": "passed", "facts": facts, "elapsedMs": round((time.monotonic() - started) * 1000, 1)})
        except NotReady as problem:
            checks.append({"name": name, "status": "not_run", "reason": str(problem)})
        except Exception as problem:
            checks.append({"name": name, "status": "failed", "error": type(problem).__name__, "reason": str(problem)[:900], "elapsedMs": round((time.monotonic() - started) * 1000, 1)})
    return checks


def manifest(app, generated=(), raw=False):
    excluded = {"node_modules", ".git", ".foundry-data", ".verification"}
    inventory = {str(file.relative_to(app)).replace("\\", "/"): hashlib.sha256(file.read_bytes()).hexdigest() for file in app.rglob("*")
                 if file.is_file() and not any(part in excluded for part in file.relative_to(app).parts)}
    return inventory if raw else source_manifest(app, inventory, generated)


def source_manifest(app, inventory, generated):
    # Output paths are already canonicalized by validate_build_output. Do not resolve
    # each inventoried path after running config: a new symlink must not reclassify
    # an authored pre-probe file as generated output.
    app = app.absolute()
    generated = tuple(Path(directory).absolute() for directory in generated)
    return {name: digest for name, digest in inventory.items()
            if not name.endswith(".tsbuildinfo") and not any((app / name).is_relative_to(directory) for directory in generated)}


def validate_build_output(app, metadata):
    app = app.resolve()
    root, output = Path(metadata["root"]).resolve(), Path(metadata["outDir"]).resolve()
    require(root.is_relative_to(app), "Vite input root must stay inside the app")
    require(output != app and output.is_relative_to(app), "Vite output must be a distinct app-contained directory")
    protected = [root, app / "src", app / "server"]
    if metadata.get("publicDir"):
        public = Path(metadata["publicDir"]).resolve()
        require(public.is_relative_to(app), "Authored public assets outside the app require manual source review")
        require(not public.is_relative_to(output) and not output.is_relative_to(public), "Vite output overlaps authored public assets; manual review required")
    for source in metadata.get("inputPaths", []):
        source = Path(source).resolve()
        require(source.is_relative_to(app) and not source.is_relative_to(output), "Vite output overlaps a declared authored input, or an input is outside the app; manual review required")
    require(not any(source.resolve().is_relative_to(output) for source in protected), "Vite output overlaps an authored input root; manual review required")
    if output.exists():
        require(not any(file.is_file() and file.suffix in (".ts", ".tsx", ".jsx", ".vue", ".svelte") for file in output.rglob("*")), "Vite output contains possible authored source; manual review required")
    return output


def discover_build_output(app, node, env, out):
    prefix = out / "build-output-resolution"
    process = command([str(node), str(ROOT / "build-output.cjs"), str(app)], app, env, prefix, timeout=30)
    info = {"process": process, "status": "not_assessed", "excludedOutputDirectories": []}
    try:
        require(process["exitCode"] == 0 and not process["timedOut"], "Vite output resolution failed; inspect its independent log")
        lines = prefix.with_suffix(".stdout.log").read_text(encoding="utf-8").splitlines()
        records = [json.loads(line.split("=", 1)[1]) for line in lines if line.startswith("FOUNDRY_BUILD_OUTPUT=")]
        require(len(records) == 1, "Vite output resolution must produce exactly one metadata record")
        output = validate_build_output(app, records[0])
        info.update({"status": "passed", "metadata": records[0], "excludedOutputDirectories": [str(output)]})
    except Exception as problem:
        info["reason"] = str(problem)[:900]
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True); parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True); parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--playwright-module", type=Path); parser.add_argument("--chrome", type=Path); parser.add_argument("--port", type=int)
    args = parser.parse_args()
    app, out = args.app.resolve(), args.out.resolve()
    if out.is_relative_to(app) or out == app or (out.exists() and any(out.iterdir())):
        raise SystemExit("Independent output must be a new/empty directory outside the app")
    out.mkdir(parents=True, exist_ok=True)
    env = sanitized_env(out / "build-home", args.bun, args.node)
    raw_before = manifest(app, raw=True)
    output_info = discover_build_output(app, args.node, env, out)
    generated = output_info["excludedOutputDirectories"]
    before = source_manifest(app, raw_before, generated)
    report = {"kind": "foundry-independent-evaluation", "modelCalls": 0, "build": {}, "api": [], "browser": {"status": "not_run"}, "buildOutputClassification": output_info, "rawManifestBefore": raw_before, "sourceManifestBefore": before}
    for step in ("typecheck", "build"):
        report["build"][step] = command([str(args.bun), "--no-env-file", "run", step], app, env, out / step, timeout=180)
    port = args.port
    if port is None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
    server = Server(app, out, args.bun.resolve(), args.node.resolve(), port)
    hashes = []
    try:
        server.start(); report["startup"] = {"status": "passed", "baseURL": server.base}
        report["api"] = api_evaluate(server, hashes)
        if args.playwright_module and args.chrome:
            browser = command([str(args.node), str(ROOT / "browser-eval.cjs"), "--base-url", server.base, "--out", str(out / "browser"), "--playwright", str(args.playwright_module.resolve()), "--chrome", str(args.chrome.resolve())], ROOT, env, out / "browser-process", timeout=480)
            file = out / "browser" / "browser-results.json"
            report["browser"] = {"process": browser, "results": json.loads(file.read_text(encoding="utf-8")) if file.exists() else None}
    except Exception as problem:
        report["startupOrRuntimeFailure"] = {"error": type(problem).__name__, "reason": str(problem)[:900]}
    finally:
        server.close()
    if not report["api"]:
        report["api"] = [{"name": name, "status": "not_run", "reason": "Owned app startup failed"} for name in API_GROUPS]
    stored = next(check for check in report["api"] if check["name"] == "sessions_password_storage")
    if stored["status"] == "passed":
        try:
            script = 'const hashes=JSON.parse(await Bun.stdin.text()); const verified=await Promise.all(hashes.map(async hash=>[await Bun.password.verify("Foundry-Synthetic!2026",hash),await Bun.password.verify("DefinitelyWrongPassword!",hash)])); console.log(JSON.stringify(verified)); process.exit(verified.length===2&&verified.every(item=>item[0]===true&&item[1]===false)?0:1)'
            result = subprocess.run([str(args.bun), "--no-env-file", "--eval", script], input=json.dumps(hashes), text=True, capture_output=True, cwd=ROOT, env=env, timeout=30)
            (out / "password-verification.stdout.log").write_text(result.stdout, encoding="utf-8"); (out / "password-verification.stderr.log").write_text(result.stderr, encoding="utf-8")
            require(result.returncode == 0 and json.loads(result.stdout) == [[True, False], [True, False]], "stored password hashes did not cryptographically verify correct/reject wrong passwords")
            for file in out.glob("server-*.log"):
                text = file.read_text(encoding="utf-8", errors="replace")
                require(all(value not in text for value in (PASSWORD, "Synthetic-Foundry!2026", "DefinitelyWrong!")), "plaintext password in server logs")
            stored["facts"]["postStopPasswordVerification"] = True
        except Exception as problem:
            stored.update({"status": "failed", "error": type(problem).__name__, "reason": str(problem)[:900]})
    report["apiPassed"] = sum(check["status"] == "passed" for check in report["api"])
    report["apiTotal"] = len(API_GROUPS)
    summary = (report["browser"].get("results") or {}).get("summary", {})
    report["rawManifest"] = manifest(app, raw=True)
    report["sourceManifest"] = source_manifest(app, report["rawManifest"], generated)
    report["sourceIntegrityStatus"] = "not_assessed" if output_info["status"] != "passed" else "unchanged" if report["sourceManifest"] == before else "modified"
    report["applicationSourceUnchanged"] = None if report["sourceIntegrityStatus"] == "not_assessed" else report["sourceIntegrityStatus"] == "unchanged"
    report["functionalGatePassed"] = report["apiPassed"] == len(API_GROUPS) and all(item["exitCode"] == 0 and not item["timedOut"] for item in report["build"].values()) and report.get("startup", {}).get("status") == "passed"
    report["browserGatePassed"] = report["browser"].get("process", {}).get("exitCode") == 0 and summary.get("failed") == 0 and summary.get("notRun") == 0 and summary.get("passed", 0) >= 40
    report["fullGatePassed"] = bool(report["functionalGatePassed"] and report["browserGatePassed"] and report["applicationSourceUnchanged"])
    (out / "evaluation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"fullGatePassed": report["fullGatePassed"], "functionalGatePassed": report["functionalGatePassed"], "browserGatePassed": report["browserGatePassed"], "apiPassed": report["apiPassed"], "apiTotal": len(API_GROUPS), "browserSummary": summary, "report": str(out / "evaluation.json")}))
    raise SystemExit(0 if report["fullGatePassed"] else 1)


if __name__ == "__main__":
    main()
