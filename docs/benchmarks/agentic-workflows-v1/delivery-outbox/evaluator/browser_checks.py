"""Visible workflow checks using only the common frozen browser-driver protocol."""
import json
import http.client
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.error

from browser_driver import BrowserDriver, browser_environment
from oracle import InstrumentFailure, ProductFailure, equal, page_request_denials, receipt_matches, require, stable
from runtime import poll, request


class Browser:
    def __init__(self, app):
        self.app = app
        proxy = os.environ.get("VECTOR_BENCH_BROWSER_PROXY")
        playwright = os.environ.get("VECTOR_BENCH_PLAYWRIGHT_MODULE")
        chrome = os.environ.get("VECTOR_BENCH_CHROME")
        if not all((proxy, playwright, chrome)):
            raise InstrumentFailure("Browser prerequisites are absent; no browser check may be silently counted as passed")
        self.temp_root = Path(browser_environment().get("TEMP", tempfile.gettempdir())).resolve()
        self.profile_parent = Path(tempfile.mkdtemp(prefix="outbox-browser-", dir=self.temp_root)).resolve()
        self.owned_profile = True
        self.profile_output = self.profile_parent / "run"
        self.driver = BrowserDriver(node=app.options.node, root=Path(proxy).parent, playwright=playwright,
                                    chrome=chrome, output=self.profile_output, origin=app.origin)

    def __enter__(self):
        try:
            self.driver.__enter__()
        except Exception as failure:
            self.cleanup_profile()
            raise InstrumentFailure("Common browser startup failed: " + str(failure)) from failure
        try:
            self.action({"action": "open", "url": self.app.origin})
            self.wait_text("Support desk")
            return self
        except BaseException:
            self.driver.__exit__(None, None, None)
            self.cleanup_profile()
            raise

    def __exit__(self, *args):
        try:
            self.driver.__exit__(*args)
        finally:
            self.cleanup_profile()

    def cleanup_profile(self):
        if not self.owned_profile:
            return
        if self.profile_parent.resolve().parent != self.temp_root or not self.profile_parent.name.startswith("outbox-browser-") or self.profile_parent.is_symlink() or getattr(self.profile_parent, "is_junction", lambda: False)() or self.profile_output != self.profile_parent / "run":
            raise InstrumentFailure("Refusing cleanup outside the atomically created owned browser directory")
        stderr = self.profile_output.with_suffix(".stderr.log")
        if stderr.exists():
            shutil.copyfile(stderr, self.app.work / "browser-driver.stderr.log")
        screenshots = self.profile_output / "screenshots"
        if screenshots.exists():
            shutil.copytree(screenshots, self.app.work / "browser-screenshots")
        deadline = time.monotonic() + 5
        while self.profile_parent.exists():
            try:
                shutil.rmtree(self.profile_parent)
            except OSError as failure:
                if time.monotonic() >= deadline:
                    raise InstrumentFailure("Owned browser directory remained locked after process cleanup: " + str(failure)) from failure
                time.sleep(0.05)
        self.owned_profile = False
        (self.app.work / "browser-cleanup.json").write_text(json.dumps({"ownedParent": str(self.profile_parent), "removed": True, "processTreeStoppedBeforeRemoval": True}) + "\n", encoding="utf-8", newline="\n")

    def action(self, value):
        try:
            status, result = request(self.driver.metadata["endpoint"], "/action", "POST", value,
                                     headers={"Authorization": "Bearer " + self.driver.token}, timeout=28)
        except (OSError, urllib.error.URLError, http.client.HTTPException, ProductFailure) as failure:
            raise InstrumentFailure("Common browser transport stopped responding") from failure
        with (self.app.work / "browser-actions.ndjson").open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps({"request": value, "response": result}, ensure_ascii=False) + "\n")
        if status != 200 or result.get("ok") is not True:
            if result.get("snapshot", {}).get("untrustedPageData") is True:
                raise ProductFailure("Visible browser action succeeds", result)
            raise InstrumentFailure("Common browser action failed without a current page observation: " + str(result))
        self.snapshot = result.get("snapshot", {})
        require(self.snapshot.get("untrustedPageData") is True, "Driver returns a current semantic observation", result)
        equal(page_request_denials(self.snapshot), [], "Observed page-route requests stay on the app origin; proxy-only background denials are unattributed")
        return result

    def observe(self):
        self.action({"action": "observe"})
        return self.snapshot

    def click(self, name):
        return self.action({"action": "click", "role": "button", "name": name})

    def type_reply(self, body):
        return self.action({"action": "type", "role": "textbox", "name": "Reply", "text": body})

    def wait_text(self, text):
        return poll(self.observe, lambda snapshot: text.lower() in snapshot.get("text", "").lower(), "Visible page includes " + text, timeout=10)

    def refresh(self):
        self.click("Refresh")
        return self.observe()

    def controls(self):
        return self.observe().get("controls", [])

    def save(self, body, subject="Replacement cable", ticket="t-101"):
        self.click(subject)
        self.type_reply(body)
        self.click("Save draft")
        messages = poll(lambda: self.app.api("/api/tickets/" + ticket)["messages"], lambda rows: any(row["body"] == body for row in rows), "Visible save creates the entered draft")
        value = next(row for row in messages if row["body"] == body)
        self.refresh()
        self.wait_text(body)
        return value

    def queue(self, identifier):
        self.click("Queue " + identifier)
        value = poll(lambda: self.app.get(identifier), lambda row: row["status"] == "queued", "Visible Queue action admits durable work")
        self.refresh()
        return value

    def process(self, identifier, status):
        self.click("Process queue")
        value = poll(lambda: self.app.get(identifier), lambda row: row["status"] == status, "Visible Process queue converges to " + status)
        self.refresh()
        return value

    def details(self, identifier):
        value = self.app.get(identifier)
        receipt = value.get("delivery", {}).get("receiptId") if value.get("delivery") else None
        if receipt and receipt in self.observe().get("text", ""):
            return self.snapshot
        self.click("Details " + identifier)
        return self.observe()

    def no_page_errors(self):
        result = self.action({"action": "console"})
        equal([row for row in result.get("result", {}).get("entries", []) if row.get("level") == "pageerror"], [], "Visible workflow has no uncaught browser exception")


def browse_compose_edit(app, browser):
    require("Support desk" in browser.snapshot.get("headings", []), "Page retains the Support desk heading", browser.snapshot)
    names = [row.get("name") for row in browser.controls()]
    for subject in ("Replacement cable", "Invoice copy", "Delivery window"):
        require(subject in names, "Existing ticket control is reachable: " + subject, names)
    draft = browser.save("Browser-created synthetic draft", "Invoice copy", "t-102")
    browser.click("Edit " + draft["id"])
    browser.type_reply("Browser-edited synthetic draft")
    browser.click("Save draft")
    poll(lambda: app.get(draft["id"]), lambda row: row["body"] == "Browser-edited synthetic draft", "Visible draft editing persists")
    browser.refresh()
    browser.wait_text("Browser-edited synthetic draft")
    equal(len(app.api("/api/tickets/t-102")["messages"]), 1, "Editing does not create another draft")
    browser.no_page_errors()


def validation_preserves_input(app, browser):
    browser.click("Replacement cable")
    body = "  \n "
    expected_error = app.api("/api/tickets/t-101/messages", "POST", {"body": body}, 400)["error"]
    browser.type_reply(body)
    browser.click("Save draft")
    snapshot = browser.wait_text(expected_error)
    reply = next((row for row in snapshot["controls"] if row.get("role") == "textbox" and row.get("name") == "Reply"), None)
    require(reply is not None, "Reply field remains visible after validation failure", snapshot)
    equal(reply.get("value"), body, "Failed save retains the user's entered text")
    equal(app.api("/api/tickets/t-101")["messages"], [], "Invalid visible save creates no message")
    browser.no_page_errors()


def queue_is_truthful(app, browser):
    draft = browser.save("Queue this visible reply")
    queued = browser.queue(draft["id"])
    snapshot = browser.wait_text("queued")
    require(not re.search(r"\bstatus\s*:\s*delivered\b", snapshot["text"], re.I), "Queued work is not labelled delivered", snapshot["text"])
    require("Edit " + draft["id"] not in [row["name"] for row in snapshot["controls"]], "Admitted message is not editable through the UI")
    equal(queued["delivery"]["attempts"], 0, "Visible Queue does not transmit")
    equal(app.state()["attempts"], [], "Queue is separate from processing")
    browser.details(draft["id"])
    browser.wait_text(draft["id"])
    browser.no_page_errors()


def delivery_details(app, browser):
    draft = browser.save("Show a real delivery receipt")
    queued = browser.queue(draft["id"])
    delivered = browser.process(draft["id"], "delivered")
    stable(queued, delivered)
    receipt_matches(delivered, app.state())
    browser.details(draft["id"])
    snapshot = browser.wait_text(delivered["delivery"]["receiptId"])
    require(draft["id"] in snapshot["text"] and str(delivered["delivery"]["attempts"]) in snapshot["text"], "Details expose identity, real receipt and attempt count without requiring a label language", snapshot["text"])
    browser.refresh()
    browser.wait_text("delivered")
    browser.no_page_errors()


def retry_workflow(app, browser):
    draft = browser.save("Retry a failed visible reply")
    queued = browser.queue(draft["id"])
    app.plan(draft["id"], "reject")
    failed = browser.process(draft["id"], "retryable")
    require(bool(failed["delivery"]["lastError"]), "Failed delivery exposes an explanatory error")
    browser.details(draft["id"])
    browser.wait_text(failed["delivery"]["lastError"])
    app.plan(draft["id"], "accept")
    browser.click("Retry " + draft["id"])
    poll(lambda: app.get(draft["id"]), lambda row: row["status"] == "queued", "Visible Retry makes failed work eligible")
    delivered = browser.process(draft["id"], "delivered")
    stable(queued, delivered)
    receipt_matches(delivered, app.state())
    browser.wait_text("delivered")
    browser.no_page_errors()


def preaccept_cancel_workflow(app, browser):
    draft = browser.save("Cancel a visible in-flight reply")
    queued = browser.queue(draft["id"])
    app.plan(draft["id"], "before_accept")
    browser.click("Process queue")
    app.held(draft["id"], "before_accept")
    browser.refresh()
    browser.click("Cancel " + draft["id"])
    cancelled = poll(lambda: app.get(draft["id"]), lambda row: row["status"] == "cancelled", "Visible cancellation settles before acceptance")
    stable(queued, cancelled)
    browser.refresh()
    browser.wait_text("cancelled")
    equal(app.state()["receipts"], [], "Visible preaccept cancellation has no delivery effect")
    require(queued["delivery"]["idempotencyKey"] in app.state()["cancellations"], "Visible cancellation establishes a provider tombstone")
    browser.no_page_errors()


def too_late_cancel_workflow(app, browser):
    draft = browser.save("Explain a too-late cancellation")
    browser.queue(draft["id"])
    app.plan(draft["id"], "after_accept")
    browser.click("Process queue")
    state = app.held(draft["id"], "after_accept")
    browser.refresh()
    require(app.get(draft["id"])["status"] in ("sending", "queued", "retryable"), "Unknown response is not falsely terminal")
    require(state["receipts"][0]["id"] not in browser.snapshot["text"], "UI does not fabricate knowledge of an unseen receipt")
    browser.click("Cancel " + draft["id"])
    delivered = poll(lambda: app.get(draft["id"]), lambda row: row["status"] == "delivered", "Too-late cancellation reconciles provider acceptance")
    app.release(draft["id"], "lost")
    browser.refresh()
    browser.details(draft["id"])
    snapshot = browser.wait_text(delivered["delivery"]["receiptId"])
    require(bool(delivered["delivery"]["lastError"]), "Too-late cancellation retains a human-readable explanation", delivered)
    browser.wait_text(delivered["delivery"]["lastError"])
    receipt_matches(app.get(draft["id"]), app.state())
    browser.no_page_errors()


def narrow_restart_workflow(app, browser):
    browser.action({"action": "viewport", "width": 390, "height": 844})
    draft = browser.save("Narrow viewport durable reply")
    queued = browser.queue(draft["id"])
    browser.details(draft["id"])
    browser.wait_text(draft["id"])
    browser.action({"action": "screenshot", "filename": "narrow-queued.png"})
    app.restart()
    browser.action({"action": "open", "url": app.origin})
    browser.wait_text("Narrow viewport durable reply")
    browser.refresh()
    stable(queued, app.get(draft["id"]))
    browser.details(draft["id"])
    delivered = browser.process(draft["id"], "delivered")
    receipt_matches(delivered, app.state())
    browser.details(draft["id"])
    browser.wait_text(delivered["delivery"]["receiptId"])
    browser.action({"action": "screenshot", "filename": "narrow-delivered.png"})
    browser.no_page_errors()


CHECKS = [browse_compose_edit, validation_preserves_input, queue_is_truthful, delivery_details,
          retry_workflow, preaccept_cancel_workflow, too_late_cancel_workflow, narrow_restart_workflow]
