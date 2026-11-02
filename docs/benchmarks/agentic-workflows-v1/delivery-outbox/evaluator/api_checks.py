"""Independent acceptance scenarios; all failures are observable public behavior."""
import json

from oracle import equal, outbox_matches, provider_consistent, receipt_matches, require, stable
from runtime import Pending


def fixture_and_readiness(app):
    descriptor = json.loads((app.options.task / "task.json").read_text(encoding="utf-8"))
    for name in descriptor["protectedFiles"]:
        equal((app.options.app / name).read_bytes(), (app.options.task / "seed" / name).read_bytes(), "Protected seed file remains byte-identical: " + name)
    equal(app.control("/health").get("ok"), True, "Protected local provider is ready")
    state = provider_consistent(app.state())
    equal(state["receipts"], [], "Fresh runtime has no synthetic delivery effects")
    require(not app.data.is_relative_to(app.options.app), "Runtime data directory is outside application source")


def existing_draft_workflow(app):
    expected = json.loads((app.options.task / "seed/fixtures/tickets.json").read_text(encoding="utf-8"))
    actual = app.api("/api/tickets").get("tickets")
    equal([(row["id"], row["subject"], row["customer"]) for row in actual], [(row["id"], row["subject"], row["customer"]) for row in expected], "Existing synthetic ticket catalog is preserved")
    first = app.draft("First synthetic draft")
    second = app.draft("Second synthetic draft")
    equal(first["status"], "draft", "Creation saves an editable draft")
    edited = app.api("/api/messages/" + first["id"], "PATCH", {"body": "Edited synthetic draft"})["message"]
    equal(edited["body"], "Edited synthetic draft", "Draft editing persists")
    equal([row["id"] for row in app.api("/api/tickets/t-101")["messages"]], [first["id"], second["id"]], "Replies retain creation order")
    app.restart()
    equal(app.get(first["id"])["body"], "Edited synthetic draft", "Existing saved drafts survive restart")


def invalid_input_atomicity(app):
    draft = app.draft("Unchanged valid draft")
    before = app.get(draft["id"])
    for raw in (b"{", b"[]", b"null", b'{"body":"   "}', json.dumps({"body": "x" * 2001}).encode()):
        app.api("/api/tickets/t-101/messages", "POST", expected=400, raw=raw)
        app.api("/api/messages/" + draft["id"], "PATCH", expected=400, raw=raw)
    for request_id in (None, "", "bad key", "x" * 81, 42):
        app.api("/api/messages/" + draft["id"] + "/send", "POST", {"requestId": request_id}, 400)
    app.api("/api/messages/" + draft["id"] + "/send", "POST", expected=400, raw=b"{")
    equal(app.get(draft["id"]), before, "Invalid operations do not mutate the draft")
    outbox_matches(app.outbox(), [])
    equal(app.state()["attempts"], [], "Invalid admission never transmits")
    equal(len(app.api("/api/tickets/t-101")["messages"]), 1, "Invalid saves create no partial message")
    app.api("/api/messages/no-such-message", expected=404)
    app.api("/api/tickets/no-such-ticket/messages", "POST", {"body": "No orphan"}, 404)


def durable_admission(app):
    draft = app.draft("Immutable queued reply")
    queued = app.send(draft["id"])
    equal(queued["status"], "queued", "Admission returns queued work")
    equal(queued["delivery"]["attempts"], 0, "Admission alone makes no delivery attempt")
    equal(queued["delivery"]["receiptId"], None, "Queued message has no receipt")
    outbox_matches(app.outbox(), [draft["id"]])
    equal(app.state()["attempts"], [], "No provider transmission occurs before explicit processing")
    app.api("/api/messages/" + draft["id"], "PATCH", {"body": "Must not replace admitted body"}, 409)
    stable(queued, app.get(draft["id"]))


def admission_idempotency(app):
    first, second = app.draft("First bound request"), app.draft("Second bound request")
    operations = [Pending(lambda: app.send(first["id"], "shared-request")) for _ in range(3)]
    values = [operation.finish() for operation in operations]
    for value in values[1:]:
        stable(values[0], value)
    app.send(first["id"], "different-request", 409)
    app.send(second["id"], "shared-request", 409)
    equal(app.get(second["id"])["status"], "draft", "Conflicting request reuse leaves the other draft untouched")
    outbox_matches(app.outbox(), [first["id"]])
    equal(app.state()["attempts"], [], "Concurrent admission still does not transmit")


def accepted_delivery(app):
    queued = app.send(app.draft("Accepted once")["id"])
    equal(app.drain()["processed"], [queued["id"]], "Successful drain identifies its attempted logical message")
    delivered = app.get(queued["id"])
    stable(queued, delivered)
    receipt_matches(delivered, app.state())
    before = app.state()
    equal(app.drain()["processed"], [], "Repeated drain has no eligible work")
    equal(app.state(), before, "Repeating drain does not retransmit terminal work")
    outbox_matches(app.outbox(), [queued["id"]])


def rejection_and_bounded_pass(app):
    queued = app.send(app.draft("Rejected synthetic reply")["id"])
    app.plan(queued["id"], "reject")
    app.drain()
    failed = app.get(queued["id"])
    equal(failed["status"], "retryable", "Provider rejection is a retryable failure")
    stable(queued, failed)
    equal(failed["delivery"]["attempts"], 1, "One drain makes one attempt per eligible message")
    equal(len(app.state()["attempts"]), 1, "Drain does not spin on provider rejection")
    equal(app.state()["receipts"], [], "Rejected delivery has no provider effect")
    app.drain()
    equal(len(app.state()["attempts"]), 1, "Retryable work needs an explicit Retry action")


def retry_stable_envelope(app):
    queued = app.send(app.draft("Retry the same reply")["id"])
    app.plan(queued["id"], "fail_once")
    app.drain()
    equal(app.get(queued["id"])["status"], "retryable", "First transient failure is visible")
    retried = app.action(queued["id"], "retry")
    stable(queued, retried)
    equal(retried["status"], "queued", "Explicit retry makes work eligible")
    app.action(queued["id"], "retry")
    app.drain()
    delivered = app.get(queued["id"])
    stable(queued, delivered)
    receipt_matches(delivered, app.state())
    equal(delivered["delivery"]["attempts"], 2, "Retry retains both durable attempts")
    app.action(queued["id"], "retry", 409)


def lost_accepted_response(app):
    queued = app.send(app.draft("Accepted response will be lost")["id"])
    app.plan(queued["id"], "after_accept")
    pending = Pending(app.drain)
    state = app.held(queued["id"], "after_accept")
    equal(len(state["receipts"]), 1, "Acceptance is durable before response release")
    require(app.get(queued["id"])["status"] in ("queued", "sending", "retryable"), "Unknown send is not falsely delivered")
    app.release(queued["id"], "lost")
    pending.finish()
    unknown = app.get(queued["id"])
    equal(unknown["status"], "retryable", "Lost accepted response remains retryable")
    equal(unknown["delivery"]["receiptId"], None, "Lost response does not fabricate a receipt")
    app.action(queued["id"], "retry")
    app.drain()
    delivered = app.get(queued["id"])
    stable(queued, delivered)
    receipt_matches(delivered, app.state())
    equal(app.state()["receipts"], state["receipts"], "Retry reuses the already-committed provider effect")
    equal(delivered["delivery"]["attempts"], 2, "Lost-response recovery records the replay attempt")


def queued_cancellation(app):
    queued = app.send(app.draft("Cancel before transmission")["id"])
    cancelled = app.action(queued["id"], "cancel")
    equal(cancelled["status"], "cancelled", "Queued cancellation is terminal")
    equal(cancelled["delivery"]["cancelRequested"], True, "Cancellation intent is retained")
    stable(queued, cancelled)
    app.action(queued["id"], "cancel")
    app.action(queued["id"], "retry", 409)
    app.drain()
    equal(app.state()["attempts"], [], "Cancelled untransmitted work is never sent")
    equal(app.state()["receipts"], [], "Queued cancellation has no provider effect")


def inflight_preaccept_cancellation(app):
    queued = app.send(app.draft("Cancel at the preaccept barrier")["id"])
    app.plan(queued["id"], "before_accept")
    pending = Pending(app.drain)
    app.held(queued["id"], "before_accept")
    app.control("/control/cancel-plan", {"idempotencyKey": queued["delivery"]["idempotencyKey"], "mode": "fail_once"})
    unresolved = app.action(queued["id"], "cancel")
    require(unresolved["status"] in ("queued", "sending", "retryable"), "Transient cancellation failure cannot claim a terminal outcome", unresolved)
    equal(unresolved["delivery"]["cancelRequested"], True, "Failed cancellation still retains intent")
    require(bool(unresolved["delivery"]["lastError"]), "Transient cancellation failure has a useful error", unresolved)
    cancelled = app.action(queued["id"], "cancel")
    equal(cancelled["status"], "cancelled", "In-flight preaccept cancellation establishes non-acceptance")
    pending.finish()
    stable(queued, app.get(queued["id"]))
    equal(app.get(queued["id"])["status"], "cancelled", "Late send completion cannot undo cancellation")
    equal(app.state()["receipts"], [], "Preaccept cancellation creates no receipt")
    require(queued["delivery"]["idempotencyKey"] in app.state()["cancellations"], "Provider cancellation tombstone prevents future acceptance")
    app.drain()
    app.action(queued["id"], "retry", 409)


def acceptance_wins_cancellation(app):
    queued = app.send(app.draft("Cancellation is too late")["id"])
    app.plan(queued["id"], "after_accept")
    pending = Pending(app.drain)
    state = app.held(queued["id"], "after_accept")
    delivered = app.action(queued["id"], "cancel")
    receipt_matches(delivered, state)
    equal(delivered["delivery"]["cancelRequested"], True, "Too-late cancellation intent stays visible")
    app.release(queued["id"], "lost")
    pending.finish()
    stable(delivered, app.get(queued["id"]))
    receipt_matches(app.get(queued["id"]), app.state())


def concurrent_drains(app):
    first = app.send(app.draft("Concurrent held reply")["id"])
    second = app.send(app.draft("Concurrent independent reply", "t-102")["id"])
    app.plan(first["id"], "before_accept")
    one = Pending(app.drain)
    app.held(first["id"], "before_accept")
    two = Pending(app.drain)
    app.release(first["id"])
    one.finish()
    two.finish()
    for queued in (first, second):
        delivered = app.get(queued["id"])
        stable(queued, delivered)
        receipt_matches(delivered, app.state())
    outbox_matches(app.outbox(), [first["id"], second["id"]])


def restart_after_admission(app):
    queued = app.send(app.draft("Durable unprocessed admission")["id"])
    app.restart()
    recovered = app.get(queued["id"])
    stable(queued, recovered)
    equal(recovered["status"], "queued", "Unprocessed admission remains queued across restart")
    equal(app.state()["attempts"], [], "Restart alone does not transmit queued work")
    outbox_matches(app.outbox(), [queued["id"]])
    app.drain()
    receipt_matches(app.get(queued["id"]), app.state())


def restart_before_acceptance(app):
    queued = app.send(app.draft("Crash before provider acceptance")["id"])
    app.plan(queued["id"], "before_accept")
    pending = Pending(app.drain)
    app.held(queued["id"], "before_accept")
    app.stop()
    pending.finish(allow_disconnect=True)
    app.start()
    recovered = app.get(queued["id"])
    stable(queued, recovered)
    require(recovered["status"] in ("queued", "sending", "retryable"), "Interrupted preaccept work remains recoverable")
    equal(app.state()["receipts"], [], "No effect was accepted before the crash")
    app.plan(queued["id"], "accept")
    app.drain()
    delivered = app.get(queued["id"])
    receipt_matches(delivered, app.state())
    stable(queued, delivered)
    equal(delivered["delivery"]["attempts"], 2, "Recovery retains the interrupted wire attempt")


def restart_after_acceptance(app):
    queued = app.send(app.draft("Crash in the accepted-response window")["id"])
    app.plan(queued["id"], "after_accept")
    pending = Pending(app.drain)
    state = app.held(queued["id"], "after_accept")
    app.stop()
    pending.finish(allow_disconnect=True)
    app.start()
    equal(app.state()["receipts"], state["receipts"], "Provider's committed receipt survives application process death")
    recovered = app.get(queued["id"])
    stable(queued, recovered)
    require(recovered["status"] in ("queued", "sending", "retryable"), "App does not invent acceptance after losing the response")
    app.plan(queued["id"], "accept")
    app.drain()
    delivered = app.get(queued["id"])
    receipt_matches(delivered, app.state())
    stable(queued, delivered)
    equal(delivered["delivery"]["attempts"], 2, "Accepted crash recovery uses one stable-key replay")
    equal(app.state()["receipts"], state["receipts"], "Recovery retains the original receipt")


def terminal_history_durable(app):
    delivered = app.send(app.draft("Keep accepted history")["id"])
    cancelled = app.send(app.draft("Keep cancellation history")["id"])
    app.action(cancelled["id"], "cancel")
    app.drain()
    before = [app.get(row["id"]) for row in (delivered, cancelled)]
    provider_before = app.state()
    app.restart()
    for previous in before:
        current = app.get(previous["id"])
        equal(current, previous, "Terminal message metadata survives hard restart")
        app.action(previous["id"], "retry", 409)
        app.api("/api/messages/" + previous["id"], "PATCH", {"body": "Forbidden mutation"}, 409)
        app.send(previous["id"], "new-request-" + previous["id"], 409)
        app.action(previous["id"], "cancel")
        stable(previous, app.get(previous["id"]))
    app.drain()
    equal(app.state(), provider_before, "Terminal history never causes retransmission")
    outbox_matches(app.outbox(), [delivered["id"], cancelled["id"]])


def ticket_and_queue_isolation(app):
    first = app.send(app.draft("Cedar accepted", "t-101")["id"])
    second = app.send(app.draft("Harbor rejected", "t-102")["id"])
    third = app.send(app.draft("Maple cancelled", "t-103")["id"])
    draft = app.draft("Cedar remains editable", "t-101")
    app.plan(second["id"], "reject")
    app.action(third["id"], "cancel")
    app.drain()
    receipt_matches(app.get(first["id"]), app.state())
    equal(app.get(second["id"])["status"], "retryable", "One ticket's rejection remains isolated")
    equal(app.get(third["id"])["status"], "cancelled", "Another ticket's cancellation remains isolated")
    equal(app.get(draft["id"])["status"], "draft", "Draft is excluded from delivery processing")
    outbox_matches(app.outbox(), [first["id"], second["id"], third["id"]])
    equal([row["id"] for row in app.api("/api/tickets/t-101")["messages"]], [first["id"], draft["id"]], "Ticket one retains only its own ordered replies")
    equal([row["id"] for row in app.api("/api/tickets/t-102")["messages"]], [second["id"]], "Ticket two has no cross-ticket leakage")
    equal([row["id"] for row in app.api("/api/tickets/t-103")["messages"]], [third["id"]], "Ticket three has no cross-ticket leakage")


CHECKS = [fixture_and_readiness, existing_draft_workflow, invalid_input_atomicity, durable_admission,
          admission_idempotency, accepted_delivery, rejection_and_bounded_pass, retry_stable_envelope,
          lost_accepted_response, queued_cancellation, inflight_preaccept_cancellation, acceptance_wins_cancellation,
          concurrent_drains, restart_after_admission, restart_before_acceptance, restart_after_acceptance,
          terminal_history_durable, ticket_and_queue_isolation]
