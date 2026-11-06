"""Private v4: immutable Foundry allocation over the existing USD48 ledger.

Transport and durable reservation/settlement ordering are inherited unchanged.
The approved phase plan seals old SaaS actors without reclassifying any cost,
and grants two new actors a fresh USD20 each. No allowance is changed in a live
process. Startup requires the existing process lock, an unchanged historical
journal prefix, a durable allocation audit, and a fresh masked key entry.
"""
import argparse
from contextlib import contextmanager
import getpass
import json
import math
import os
from pathlib import Path
import threading
import time
import warnings

import budget_gateway_v2 as v2
import budget_gateway_v3 as v3

APPROVED_PLAN_SHA256 = "8f4286ab15ccd622fead826330105be9ae256cae3904954b41cf8196ce38dcd6"
ALLOCATION_FILE = "phase-allocation-v4.json"
STUDY_LIMIT = 48.0
OLD_ACTORS = ("diagnostics", "saas-vector", "saas-codex")
NEW_ACTORS = ("foundry-vector", "foundry-codex")
_policy_lock = threading.RLock()

MODEL, RATES = v3.MODEL, v3.RATES
AdmissionError, prepare, price, handler = v3.AdmissionError, v3.prepare, v3.price, v3.handler
UnarmedHandler = v3.UnarmedHandler
LOCAL_RPC_TIMEOUT_SECONDS = 30


class OwnedHTTPServer(v3.OwnedHTTPServer):
    # Keep the phase policy and ledger owner alive until every accepted handler
    # has finished settlement. ThreadingHTTPServer otherwise uses daemon workers.
    daemon_threads = False
    block_on_close = True

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(LOCAL_RPC_TIMEOUT_SECONDS)
        return request, address


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def validate_plan(plan):
    if not isinstance(plan, dict) or v3.file_hash(canonical(plan)) != APPROVED_PLAN_SHA256:
        raise ValueError("phase plan is not the source-pinned owner-approved allocation")
    if plan.get("kind") != "foundry-phase-allocation-v1" or plan.get("authorizedStudyMaximumUsd") != STUDY_LIMIT:
        raise ValueError("phase plan does not retain the authorized USD48 study")
    historical, limits = plan.get("historicalActorMeasuredUsd"), plan.get("actorLimitsUsd")
    if not isinstance(historical, dict) or set(historical) != set(OLD_ACTORS):
        raise ValueError("phase plan must retain every historical actor")
    if not isinstance(limits, dict) or set(limits) != set(OLD_ACTORS + NEW_ACTORS):
        raise ValueError("phase plan actor set differs from the reviewed allocation")
    if not all(v3.finite_nonnegative(value) for value in (*historical.values(), *limits.values())):
        raise ValueError("invalid phase amount")
    if any(limits[actor] != 20 for actor in NEW_ACTORS):
        raise ValueError("each new Foundry actor must have exactly USD20")
    if any(limits[actor] != historical[actor] for actor in OLD_ACTORS[1:]):
        raise ValueError("old SaaS actors must be sealed at historical spend")
    if abs(sum(limits.values()) - STUDY_LIMIT) > 1e-8 or historical["diagnostics"] > limits["diagnostics"]:
        raise ValueError("phase allocation exceeds the unchanged study maximum")
    if not v2.count(plan.get("historicalSequence")) or not v3.finite_nonnegative(plan.get("historicalMeasuredUsd")):
        raise ValueError("invalid historical phase boundary")
    if abs(sum(historical.values()) - plan["historicalMeasuredUsd"]) > 1e-8:
        raise ValueError("phase historical totals do not reconcile")
    if set(plan.get("prefix", {})) != {"receipts.jsonl", "admissions-v2.jsonl"}:
        raise ValueError("phase must bind both authoritative journals")
    for prefix in plan["prefix"].values():
        if not isinstance(prefix, dict) or set(prefix) != {"count", "sha256"} or not v2.count(prefix["count"]) or not isinstance(prefix["sha256"], str) or len(prefix["sha256"]) != 64:
            raise ValueError("invalid phase prefix binding")
    return plan


def load_plan(path):
    data = Path(path).read_bytes()
    plan = validate_plan(json.loads(data))
    if data != canonical(plan):
        raise ValueError("phase plan bytes differ from the pinned canonical artifact")
    return plan


@contextmanager
def phase_limits(plan):
    """Process-local only; importing v4 never changes v2/v3 policy."""
    validate_plan(plan)
    with _policy_lock:
        if v2.ACTOR_LIMITS is not v3.ACTOR_LIMITS or v2.STUDY_LIMIT != STUDY_LIMIT or v3.STUDY_LIMIT != STUDY_LIMIT:
            raise ValueError("shared budget modules do not have the reviewed policy identity")
        previous = dict(v2.ACTOR_LIMITS)
        try:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(plan["actorLimitsUsd"])
            yield
        finally:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(previous)


def validate_prefix(directory, plan):
    """Allow later rows, while binding the exact pre-Foundry journal bytes."""
    validate_plan(plan)
    rows, hashes = {}, {}
    for name, expected in plan["prefix"].items():
        data = (Path(directory) / name).read_bytes()
        lines = data.splitlines(keepends=True)
        if len(lines) < expected["count"] or (data and not data.endswith(b"\n")):
            raise ValueError("phase journal is truncated or has an incomplete row")
        if v3.file_hash(b"".join(lines[:expected["count"]])) != expected["sha256"]:
            raise ValueError("historical phase prefix changed")
        rows[name] = [json.loads(line) for line in lines]
        hashes[name] = v3.file_hash(data)
        if any(row.get("actor", "diagnostics") in OLD_ACTORS[1:] for row in rows[name][expected["count"]:]):
            raise ValueError("sealed SaaS actor has post-phase history")
    receipts = rows["receipts.jsonl"][:plan["prefix"]["receipts.jsonl"]["count"]]
    if {row.get("seq") for row in receipts} != set(range(1, plan["historicalSequence"] + 1)):
        raise ValueError("historical phase receipt sequence differs")
    if any(row.get("actor", "diagnostics") not in OLD_ACTORS for row in receipts):
        raise ValueError("new actor appears before its approved phase")
    for actor, expected in plan["historicalActorMeasuredUsd"].items():
        actual = math.fsum(row["measuredUsd"] for row in receipts if row.get("actor", "diagnostics") == actor)
        if abs(actual - expected) > 1e-8:
            raise ValueError("historical actor amounts differ from phase plan")
    return {"rows": rows, "sha256": hashes}


def allocation_payload(plan):
    return {"kind": "durable-v4-phase-allocation-audit", "phasePlanSha256": APPROVED_PLAN_SHA256,
            "phasePlan": plan, "historicalAmountsRetained": True, "historicalActorsRetained": True,
            "ownerStudyMaximumUnchanged": STUDY_LIMIT, "noLiveAllowanceMutation": True,
            "instrumentSha256": {name: v3.file_hash((Path(__file__).parent / name).read_bytes())
                                 for name in ("budget_gateway_v2.py", "budget_gateway_v3.py", "budget_gateway_v4.py")}}


class Budget(v3.Budget):
    def __init__(self, directory, plan, recover_reconciled_snapshot=False, recovery_reason=None):
        self.phase_plan = validate_plan(plan)
        self._check_policy()
        checked = validate_prefix(directory, plan)
        destination = Path(directory) / ALLOCATION_FILE
        payload = allocation_payload(plan)
        if destination.exists():
            recorded = json.loads(destination.read_bytes())
            if not isinstance(recorded, dict) or set(recorded) != set(payload) | {"atUtc"} or any(recorded.get(key) != value for key, value in payload.items()) or not isinstance(recorded.get("atUtc"), str):
                raise ValueError("durable phase audit differs from the approved allocation")
        elif any(len(checked["rows"][name]) != plan["prefix"][name]["count"] for name in checked["rows"]):
            raise ValueError("post-phase history exists without a durable allocation audit")
        # Full v3 reconciliation checks every historical and later receipt's
        # usage, price, admission, sequence, actor cap and global cap.
        super().__init__(directory, recover_reconciled_snapshot, recovery_reason)
        for name, expected in checked["sha256"].items():
            file = Path(directory) / name
            with file.open("r+b") as stream:
                os.fsync(stream.fileno())
            if v3.file_hash(file.read_bytes()) != expected:
                raise ValueError("journal changed during phase allocation")
        if not destination.exists():
            payload["atUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with destination.open("xb") as stream:
                stream.write(canonical(payload))
                stream.flush()
                os.fsync(stream.fileno())
        else:
            # A prior crash after write but before fsync cannot silently turn
            # readable audit bytes into an assumed durable authorization.
            with destination.open("r+b") as stream:
                os.fsync(stream.fileno())
        self.phase_allocation_audit = destination.name

    def _check_policy(self):
        if v2.ACTOR_LIMITS != self.phase_plan["actorLimitsUsd"] or v3.ACTOR_LIMITS is not v2.ACTOR_LIMITS:
            raise ValueError("v4 budget used outside its validated process policy")

    def status(self):
        self._check_policy()
        return {**super().status(), "phaseID": self.phase_plan["phaseID"],
                "phasePlanSha256": APPROVED_PLAN_SHA256, "historicalPhaseBoundary": self.phase_plan["historicalSequence"]}

    def arm(self, actor, label, calls):
        self._check_policy()
        return super().arm(actor, label, calls)

    def admit(self, token, reserve, metadata):
        self._check_policy()
        return super().admit(token, reserve, metadata)

    def settle(self, seq, result):
        self._check_policy()
        return super().settle(seq, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--phase-plan", type=Path, required=True)
    parser.add_argument("--port", type=int, default=23128)
    parser.add_argument("--recover-reconciled-snapshot", action="store_true")
    parser.add_argument("--recovery-reason")
    args = parser.parse_args()
    directory = args.directory.resolve()
    import msvcrt
    with (directory / "gateway-v2.lock").open("a+b") as ledger_lock:
        ledger_lock.seek(0)
        msvcrt.locking(ledger_lock.fileno(), msvcrt.LK_NBLCK, 1)
        approved = json.loads((directory / "owner-budget.json").read_text(encoding="utf-8"))
        if approved.get("authorizedStudyMaximumUsd") != STUDY_LIMIT:
            raise SystemExit("Owner authorization does not match the reviewed USD48 study")
        plan = load_plan(args.phase_plan)
        with phase_limits(plan):
            with OwnedHTTPServer(("127.0.0.1", args.port), UnarmedHandler) as server:
                budget = Budget(directory, plan, args.recover_reconciled_snapshot, args.recovery_reason)
                config = json.loads((directory / "gateway-config.json").read_text(encoding="utf-8"))
                print(f"Reviewed v4: USD48 study; USD{budget.spent:.7f} historical cost retained; fresh Foundry USD20 each; no batch armed.")
                print("The provider key stays only in this process; no key is written to disk.")
                warnings.simplefilter("error", getpass.GetPassWarning)
                api_key = getpass.getpass("Re-enter the OpenAI API key for the account YOU want billed (hidden): ").strip()
                if not api_key:
                    raise SystemExit("No key supplied; nothing sent.")
                server.RequestHandlerClass = handler(budget, api_key, config["localToken"])
                budget.publish_snapshot()
                print(f"Ready on 127.0.0.1:{args.port}; witness23129 unchanged; no paid batch armed. Leave this window open.")
                server.serve_forever()


if __name__ == "__main__":
    main()
