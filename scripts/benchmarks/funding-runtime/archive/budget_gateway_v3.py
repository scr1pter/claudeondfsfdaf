"""Private v3 gateway: authoritative fsynced journals, derived status snapshot.

Transport, price calculation, immutable tokens, admission caps and settlement
ordering are reused unchanged from reviewed v2. This module never clears a live
gateway's halt. Explicit recovery is only available at a new process startup,
under the shared process lock, after complete ledger reconciliation and fsync.
"""
import argparse
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import budget_gateway_v2 as v2

MODEL, SOURCES = v2.MODEL, v2.SOURCES
STUDY_LIMIT, ACTOR_LIMITS = v2.STUDY_LIMIT, v2.ACTOR_LIMITS
CONTEXT, OUTPUT, MAX_BODY, RATES = v2.CONTEXT, v2.OUTPUT, v2.MAX_BODY, v2.RATES
AdmissionError, prepare, price, handler = v2.AdmissionError, v2.prepare, v2.price, v2.handler
LEGACY_RECEIPT_MAX = 34
V2_PERSISTENCE_HALT = "persistence failure; all unresolved reservations retained and new spending halted"


def finite_nonnegative(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def file_hash(data):
    return hashlib.sha256(data).hexdigest()


def journal(directory, name):
    path = directory / name
    data = path.read_bytes() if path.exists() else b""
    if data and not data.endswith(b"\n"):
        raise ValueError("unterminated journal; no automatic repair or recovery")
    rows = []
    for line in data.splitlines():
        if not line:
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("journal row is not an object")
        rows.append(row)
    return rows, file_hash(data)


def audit_ledger(directory):
    """Read-only reconciliation. No status writes, fsync, key/config or HTTP."""
    directory = Path(directory)
    admissions, admission_hash = journal(directory, "admissions-v2.jsonl")
    receipts, receipt_hash = journal(directory, "receipts.jsonl")
    admitted, settled = {}, {}
    actor_spent = {actor: 0.0 for actor in ACTOR_LIMITS}
    spent, priced = 0.0, 0
    for admission in admissions:
        seq = admission.get("seq")
        if not v2.count(seq) or seq == 0 or seq in admitted or admission.get("actor") not in ACTOR_LIMITS or not finite_nonnegative(admission.get("reservedUsd")) or admission["reservedUsd"] <= 0:
            raise ValueError("invalid or duplicate durable admission")
        admitted[seq] = admission
    for receipt in receipts:
        seq, actual = receipt.get("seq"), receipt.get("measuredUsd")
        actor = receipt.get("actor", "diagnostics")
        if not v2.count(seq) or seq == 0 or seq in settled or actor not in ACTOR_LIMITS or not finite_nonnegative(actual):
            raise ValueError("invalid, duplicate or unresolved receipt")
        if not finite_nonnegative(receipt.get("reservedUsd")) or actual > receipt["reservedUsd"] + 1e-8:
            raise ValueError("settlement exceeded its admission reservation")
        if receipt.get("model") != MODEL or receipt.get("serviceTier") not in (None, "default", "standard"):
            raise ValueError("unapproved historical model or processing tier")
        # Validate provider usage against the unchanged reviewed rates. Preserve
        # the original measured amount; never replace/reprice historical costs.
        if receipt.get("rates") != RATES or abs(price(receipt.get("usage")) - actual) > 1e-8:
            raise ValueError("historical usage/rate/cost does not reconcile")
        priced += 1
        if seq in admitted:
            if any(receipt.get(key) != value for key, value in admitted[seq].items()):
                raise ValueError("immutable admission/receipt metadata differs")
        elif seq > LEGACY_RECEIPT_MAX or "actor" in receipt:
            raise ValueError("receipt has no durable v2 admission and is not approved legacy evidence")
        settled[seq] = receipt
        spent += actual
        actor_spent[actor] += actual
        if "cumulativeMeasuredUsd" in receipt and (not finite_nonnegative(receipt["cumulativeMeasuredUsd"]) or abs(receipt["cumulativeMeasuredUsd"] - spent) > 1e-8):
            raise ValueError("historical cumulative total does not reconcile")
    seq = max(settled, default=0)
    if set(settled) != set(range(1, seq + 1)):
        raise ValueError("settlement sequence has a gap")
    if any(value not in settled for value in admitted):
        raise ValueError("unmatched durable admission; its reservation cannot be released")
    if spent > STUDY_LIMIT + 1e-8 or any(actor_spent[actor] > ACTOR_LIMITS[actor] + 1e-8 for actor in ACTOR_LIMITS):
        raise ValueError("historical study/actor costs exceed owner authorization")
    snapshot, snapshot_hash, problems = None, None, []
    snapshot_path = directory / "status.json"
    if snapshot_path.exists():
        data = snapshot_path.read_bytes()
        snapshot_hash = file_hash(data)
        try:
            snapshot = json.loads(data)
        except ValueError:
            problems.append("invalid derived snapshot JSON")
        if not isinstance(snapshot, dict):
            problems.append("missing derived snapshot object")
        else:
            if snapshot.get("halted"):
                problems.append("derived snapshot records a halt")
            if snapshot.get("active") != 0 or snapshot.get("reservedUsd") != 0:
                problems.append("derived snapshot records active/reserved state")
            if snapshot.get("attempts") != seq or not finite_nonnegative(snapshot.get("measuredUsd")) or abs(snapshot.get("measuredUsd", -1) - spent) > 1e-8:
                problems.append("derived snapshot totals/sequence differ from journals")
            actors = snapshot.get("actors", {})
            if not isinstance(actors, dict):
                problems.append("invalid derived snapshot actor object")
                actors = {}
            for actor, value in actors.items():
                if actor not in ACTOR_LIMITS or not isinstance(value, dict) or not finite_nonnegative(value.get("measuredUsd")) or abs(value["measuredUsd"] - actor_spent[actor]) > 1e-8:
                    problems.append("derived snapshot actor totals differ from journals")
                    break
    elif seq:
        problems.append("derived snapshot missing for existing history")
    return {"kind": "read-only-v3-ledger-reconciliation", "journalSha256": {"admissions-v2.jsonl": admission_hash, "receipts.jsonl": receipt_hash},
            "snapshotSha256": snapshot_hash, "admissionCount": len(admissions), "receiptCount": len(receipts), "legacyReceiptCount": sum(value not in admitted for value in settled),
            "verifiedProviderPrices": priced, "allAdmissionsSettled": True, "unresolvedReservations": 0, "sequence": seq,
            "measuredUsd": spent, "actorMeasuredUsd": actor_spent, "studyLimitUsd": STUDY_LIMIT, "actorLimitsUsd": ACTOR_LIMITS,
            "snapshotProblems": problems, "snapshot": snapshot}


class Budget(v2.Budget):
    def __init__(self, directory, recover_reconciled_snapshot=False, recovery_reason=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.condition = threading.Condition()
        self.batches, self.pending, self.settled = {}, {}, set()
        self.reserved, self.actor_reserved = 0.0, {actor: 0.0 for actor in ACTOR_LIMITS}
        self.halted, self.persistence_failed, self.persistence_detail = None, False, None
        self.snapshot_warning, self.diagnostic_events = None, []
        audit = audit_ledger(self.directory)
        self.seq, self.spent, self.actor_spent = audit["sequence"], audit["measuredUsd"], audit["actorMeasuredUsd"]
        self.settled = set(range(1, self.seq + 1))
        if audit["snapshotProblems"]:
            if not recover_reconciled_snapshot:
                raise ValueError("derived snapshot needs explicit reconciled startup recovery")
            old_snapshot = audit["snapshot"] if isinstance(audit["snapshot"], dict) else {}
            old_halt = old_snapshot.get("halted")
            if old_halt not in (None, V2_PERSISTENCE_HALT):
                raise ValueError("this halt is not eligible for derived-snapshot recovery")
        if recover_reconciled_snapshot:
            if not isinstance(recovery_reason, str) or len(recovery_reason.strip()) < 12:
                raise ValueError("explicit startup recovery needs a concrete review reason")
            self._record_recovery(audit, recovery_reason.strip())

    def _diagnostic(self, operation, error):
        event = {"event": "gateway_storage_error", "operation": operation, "exception": type(error).__name__,
                 "errno": getattr(error, "errno", None), "winerror": getattr(error, "winerror", None),
                 "seq": self.seq, "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.diagnostic_events.append(event)
        self.diagnostic_events = self.diagnostic_events[-20:]
        # Fixed operation labels and error numbers only: no exception message,
        # file content, provider key, HTTP authorization or request text.
        try:
            print(json.dumps(event), file=sys.stderr, flush=True)
        except (OSError, ValueError):
            pass  # A closed console must never undo a journal halt.
        return event

    def _record_recovery(self, audit, reason):
        # Complete readable rows after a prior fsync error are not assumed
        # durable. Explicit recovery flushes those exact audited journal bytes,
        # then verifies hashes again without changing their content.
        for name, expected in audit["journalSha256"].items():
            file = self.directory / name
            if file.exists():
                with file.open("r+b") as stream:
                    os.fsync(stream.fileno())
                if file_hash(file.read_bytes()) != expected:
                    raise ValueError("journal changed during recovery validation")
        verified = audit_ledger(self.directory)
        if verified["journalSha256"] != audit["journalSha256"]:
            raise ValueError("journal changed during startup recovery")
        artifact = {**audit, "snapshot": None, "kind": "explicit-v3-startup-recovery-audit", "reason": reason,
                    "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "exactJournalBytesFsynced": True,
                    "noHistoricalAmountsResetOrRepriced": True, "noLiveGatewayStateChanged": True,
                    "historicalCauseCaveat": "v2 generic persistence halt did not record errno; reconciliation does not uniquely prove its historical cause",
                    "instrumentSha256": {name: file_hash((Path(__file__).parent / name).read_bytes()) for name in ("budget_gateway_v2.py", "budget_gateway_v3.py")}}
        destination = self.directory / ("recovery-audit-v3-" + str(time.time_ns()) + "-" + secrets.token_hex(4) + ".json")
        with destination.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(artifact, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.recovery_audit = destination.name

    def status(self):
        # Pure in-memory HTTP/status reads. Polling never touches status.json.
        with self.condition:
            value = {"limitUsd": STUDY_LIMIT, "measuredUsd": self.spent, "reservedUsd": self.reserved,
                     "remainingAdmissionUsd": STUDY_LIMIT - self.spent - self.reserved, "halted": self.halted,
                     "attempts": self.seq, "active": len(self.pending),
                     "batchCallsRemaining": sum(batch["left"] for batch in self.batches.values() if batch["open"]),
                     "actors": {actor: {"limitUsd": ACTOR_LIMITS[actor], "measuredUsd": self.actor_spent[actor], "reservedUsd": self.actor_reserved[actor]} for actor in ACTOR_LIMITS},
                     "statusSnapshotDerived": True, "snapshotWarning": self.snapshot_warning, "persistenceDetail": self.persistence_detail}
            return value

    def publish_snapshot(self):
        # A locked Windows snapshot cannot authorize/refund a request: journals
        # are authoritative. Retry sharing failures briefly; preserve the old
        # snapshot and expose a warning if it stays locked. Never truncate it.
        with self.condition:
            temp = self.directory / ("status-v3-" + secrets.token_hex(6) + ".tmp")
            try:
                value = self.status()
                value["snapshotWarning"] = None
                temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
                for attempt in range(4):
                    try:
                        os.replace(temp, self.directory / "status.json")
                        self.snapshot_warning = None
                        return True
                    except OSError as error:
                        retryable = getattr(error, "winerror", None) in (5, 32, 33) or error.errno in (13, 16)
                        if not retryable or attempt == 3:
                            raise
                        time.sleep(.025 * (attempt + 1))
            except OSError as error:
                self.snapshot_warning = self._diagnostic("derived_status_snapshot", error)
                return False
            finally:
                try:
                    temp.unlink(missing_ok=True)
                except OSError:
                    pass

    def append(self, name, value):
        try:
            with (self.directory / name).open("a", encoding="utf-8") as file:
                file.write(json.dumps(value, ensure_ascii=False) + "\n")
                file.flush()
                os.fsync(file.fileno())
        except OSError as error:
            self.persistence_halt()
            self.persistence_detail = self._diagnostic("durable_journal_" + name, error)
            raise

    def arm(self, actor, label, calls):
        try:
            return super().arm(actor, label, calls)
        finally:
            self.publish_snapshot()

    def disarm(self, token=None):
        try:
            return super().disarm(token)
        finally:
            self.publish_snapshot()

    def admit(self, token, reserve, metadata):
        try:
            return super().admit(token, reserve, metadata)
        finally:
            self.publish_snapshot()

    def settle(self, seq, result):
        try:
            return super().settle(seq, result)
        finally:
            self.publish_snapshot()


class UnarmedHandler(BaseHTTPRequestHandler):
    """No provider access while the owned socket is bound before key entry."""
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_error(503, "Gateway is not armed")

    do_POST = do_GET


class OwnedHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can permit competing listeners. Require sole
    # ownership so an occupied port fails before asking for a provider key.
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        return super().server_bind()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    # Existing keyless wire witness owns 23129 and forwards to this gateway.
    parser.add_argument("--port", type=int, default=23128)
    parser.add_argument("--recover-reconciled-snapshot", action="store_true")
    parser.add_argument("--recovery-reason")
    args = parser.parse_args()
    directory = args.directory.resolve()
    # Acquire the SAME process lock as v2 before startup audit, key entry or any
    # derived snapshot publication. The owner stops the old process separately.
    import msvcrt
    with (directory / "gateway-v2.lock").open("a+b") as ledger_lock:
        ledger_lock.seek(0)
        msvcrt.locking(ledger_lock.fileno(), msvcrt.LK_NBLCK, 1)
        approved = json.loads((directory / "owner-budget.json").read_text(encoding="utf-8"))
        if approved.get("authorizedStudyMaximumUsd") != STUDY_LIMIT:
            raise SystemExit("Owner authorization does not match the reviewed $48 study")
        # Prove the port is available BEFORE recovery writes or another masked
        # key entry. This context closes the owned socket on any prompt failure.
        with OwnedHTTPServer(("127.0.0.1", args.port), UnarmedHandler) as server:
            budget = Budget(directory, args.recover_reconciled_snapshot, args.recovery_reason)
            config = json.loads((directory / "gateway-config.json").read_text(encoding="utf-8"))
            print(f"Reviewed v3: $48 total; ${budget.spent:.6f} historical cost preserved; no batch armed.")
            print("The provider key stays only in this process; no key is written to disk.")
            warnings.simplefilter("error", getpass.GetPassWarning)
            api_key = getpass.getpass("Re-enter the OpenAI API key for the account YOU want billed (hidden): ").strip()
            if not api_key:
                raise SystemExit("No key supplied; nothing sent.")
            server.RequestHandlerClass = handler(budget, api_key, config["localToken"])
            budget.publish_snapshot()
            print(f"Ready on 127.0.0.1:{args.port}; no paid batch is armed. Leave this window open.")
            server.serve_forever()


if __name__ == "__main__":
    main()
