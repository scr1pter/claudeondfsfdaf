"""Pure independent transcript predicates. No application imports or execution."""
import hashlib
import json
import os
from pathlib import Path
import re


class ProductFailure(AssertionError):
    def __init__(self, expected, actual=None):
        super().__init__(expected)
        self.expected, self.actual = expected, actual


class InstrumentFailure(RuntimeError):
    pass


def require(condition, expected, actual=None):
    if not condition:
        raise ProductFailure(expected, actual)


def equal(actual, expected, label):
    require(actual == expected, label, actual)


def message(value):
    require(isinstance(value, dict), "Message is a JSON object", value)
    require({"id", "ticketId", "body", "status", "delivery"} <= value.keys(), "Message exposes every required field", value)
    require(all(isinstance(value.get(key), str) and value[key] for key in ("id", "ticketId", "body")), "Message has nonempty ID, ticket ID and body", value)
    require(all(re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value[key]) for key in ("id", "ticketId")), "Message identifiers can be safely addressed by the public API", value)
    require(value.get("status") in {"draft", "queued", "sending", "retryable", "delivered", "cancelled"}, "Message status uses the contract vocabulary", value)
    delivery = value.get("delivery")
    if value["status"] == "draft":
        equal(delivery, None, "Draft has no delivery envelope")
        return value
    if value["status"] == "cancelled" and delivery is None:
        return value
    require(isinstance(delivery, dict), "Admitted message has delivery metadata", value)
    require({"idempotencyKey", "attempts", "receiptId", "lastError", "cancelRequested"} <= delivery.keys(), "Delivery exposes every required field", value)
    require(isinstance(delivery.get("idempotencyKey"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,160}", delivery["idempotencyKey"]), "Provider key is a nonempty valid stable identifier", value)
    require(type(delivery.get("attempts")) is int and delivery["attempts"] >= 0, "Attempt count is a nonnegative integer", value)
    require(delivery.get("receiptId") is None or isinstance(delivery["receiptId"], str) and delivery["receiptId"], "Receipt ID is null or nonempty", value)
    require(delivery.get("lastError") is None or isinstance(delivery["lastError"], str) and delivery["lastError"].strip(), "Error is null or useful text", value)
    require(type(delivery.get("cancelRequested")) is bool, "Cancellation intent is a boolean", value)
    if value["status"] == "delivered":
        require(bool(delivery["receiptId"]), "Delivered requires a provider receipt", value)
    if value["status"] == "retryable":
        require(bool(delivery["lastError"]), "Retryable requires an explanatory error", value)
    if value["status"] == "cancelled":
        equal(delivery["receiptId"], None, "Cancelled message cannot claim an acceptance receipt")
    return value


def stable(before, after):
    message(before)
    message(after)
    for key in ("id", "ticketId", "body"):
        equal(after[key], before[key], "Admitted message retains " + key)
    equal(after["delivery"]["idempotencyKey"], before["delivery"]["idempotencyKey"], "Retries/recovery preserve provider key")
    require(after["delivery"]["attempts"] >= before["delivery"]["attempts"], "Durable attempts never decrease", after)


def provider_consistent(state):
    require(isinstance(state, dict) and all(isinstance(state.get(key), list) for key in ("receipts", "attempts", "cancellations", "held", "plans")), "Provider state has complete collections", state)
    receipts = state["receipts"]
    equal(len({row["idempotencyKey"] for row in receipts}), len(receipts), "At most one provider effect per key")
    equal(len({row["messageId"] for row in receipts}), len(receipts), "At most one provider effect per logical message")
    require(not ({row["idempotencyKey"] for row in receipts} & set(state["cancellations"])), "Provider cancellation and acceptance are mutually exclusive", state)
    for row in state["attempts"]:
        equal(row["key"], row["envelope"]["idempotencyKey"], "Attempt log agrees with transmitted key")
    return state


def receipt_matches(value, state):
    message(value)
    provider_consistent(state)
    equal(value["status"], "delivered", "Message converges to delivered")
    receipts = [row for row in state["receipts"] if row["messageId"] == value["id"]]
    equal(len(receipts), 1, "Exactly one durable provider effect for the message")
    receipt = receipts[0]
    equal(value["delivery"]["receiptId"], receipt["id"], "App records the actual provider receipt")
    for key in ("messageId", "ticketId", "body", "idempotencyKey"):
        expected = value["id"] if key == "messageId" else value["delivery"][key] if key == "idempotencyKey" else value[key]
        equal(receipt[key], expected, "Receipt matches immutable " + key)
    attempts = [row for row in state["attempts"] if row["message_id"] == value["id"]]
    equal(value["delivery"]["attempts"], len(attempts), "App attempt count matches actual provider wire attempts")
    require(bool(attempts), "Acceptance has at least one transmitted attempt", value)
    require(all(row["key"] == value["delivery"]["idempotencyKey"] for row in attempts), "Every attempt retains the same provider key", attempts)
    for attempt in attempts:
        equal(attempt["envelope"], {key: receipt[key] for key in ("idempotencyKey", "messageId", "ticketId", "body")}, "Every wire attempt retains the immutable accepted envelope")


def outbox_matches(items, expected_ids):
    require(isinstance(items, list), "Outbox items is an array", items)
    equal(len({row["id"] for row in items}), len(items), "Outbox contains no duplicate logical message")
    equal({row["id"] for row in items}, set(expected_ids), "Outbox contains every admitted message and no draft")
    for row in items:
        message(row)


def loopback_origin(value):
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port is not None and 1 <= parsed.port <= 65535 and parsed.path in ("", "/") and not any((parsed.username, parsed.password, parsed.query, parsed.fragment))
    except (TypeError, ValueError):
        valid = False
    require(valid, "Provider origin is an exact loopback HTTP origin", value)
    return value.rstrip("/")


def manifest(root, ignored=("node_modules", ".git", "__pycache__"), generated=("dist",)):
    root = Path(root).resolve()
    result = {}
    for directory, names, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(names):
            path = parent / name
            if name in ignored or path.relative_to(root).as_posix() in generated:
                names.remove(name)
                continue
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise InstrumentFailure("Linked authored source is unsupported")
        for name in files:
            path = parent / name
            if path.relative_to(root).as_posix() in generated:
                continue
            if path.is_symlink():
                raise InstrumentFailure("Linked authored source is unsupported")
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(result.items()))


def verdict(rows, inventory, unchanged=True, infrastructure_error=None):
    names = [row.get("name") for row in rows]
    if infrastructure_error or not unchanged or names != [row["name"] for row in inventory] or len(set(names)) != len(names) or any(row.get("status") not in ("passed", "failed", "not_run") for row in rows):
        return "instrument_failure"
    if all(row["status"] == "passed" for row in rows):
        return "passed"
    return "product_failure" if any(row["status"] == "failed" for row in rows) else "instrument_failure"


def portable_bytes(path):
    data = Path(path).read_bytes()
    if b"\r" in data:
        raise InstrumentFailure("Frozen text must use LF bytes: " + str(path))
    data.decode("utf-8")
    return data


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
