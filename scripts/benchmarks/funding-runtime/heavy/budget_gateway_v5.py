"""Owner-approved equal remainder allocation; unchanged durable transport.

No startup, configuration read or funding occurs on import. The explicit CLI
requires the existing private ledger, immutable reviewed plan and hidden key.
Historical journals are never rewritten and the USD48 total never increases.
"""
import argparse
from contextlib import contextmanager
import getpass
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import warnings

ARCHIVE = Path(__file__).resolve().parents[1] / "archive"
sys.path.insert(0, str(ARCHIVE))
import budget_gateway_v2 as v2
import budget_gateway_v3 as v3
import budget_gateway_v4 as v4

APPROVED_PLAN_SHA256 = "5f75ba025ae3d4f3cde51b4d85586df63fee00e76fdcc300dc1ecd530a0e4c6e"
PHASE = "heavy-matched-teams-high-v1"
ALLOCATION_FILE = "phase-allocation-v5.json"
ACTORS = ("foundry-vector", "foundry-codex")
STUDY_LIMIT = 48.0
_policy_lock = threading.RLock()


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def validate_plan(plan):
    if not isinstance(plan, dict) or v3.file_hash(canonical(plan)) != APPROVED_PLAN_SHA256:
        raise ValueError("not the source-pinned owner-approved remainder allocation")
    historical, limits = plan["historicalActorMeasuredUsd"], plan["actorLimitsUsd"]
    if plan["phaseID"] != PHASE or plan["authorizedStudyMaximumUsd"] != STUDY_LIMIT:
        raise ValueError("study authorization changed")
    if set(limits) != set(historical) or set(limits) != set(v4.OLD_ACTORS + ACTORS):
        raise ValueError("historical actors changed")
    if any(not v3.finite_nonnegative(value) for value in (*limits.values(), *historical.values())):
        raise ValueError("invalid allocation")
    if abs(math.fsum(historical.values()) - plan["historicalMeasuredUsd"]) > 1e-8 or abs(math.fsum(limits.values()) - STUDY_LIMIT) > 1e-8:
        raise ValueError("allocation does not conserve the study total")
    remaining = (STUDY_LIMIT - plan["historicalMeasuredUsd"]) / 2
    if any(abs(limits[actor] - historical[actor] - remaining) > 1e-8 for actor in ACTORS):
        raise ValueError("remaining runtime allowances are not equal")
    if any(limits[actor] != historical[actor] for actor in v4.OLD_ACTORS):
        raise ValueError("historical non-runtime actors must remain sealed")
    return plan


def load_plan(path):
    data = Path(path).read_bytes()
    plan = validate_plan(json.loads(data))
    if data != canonical(plan):
        raise ValueError("plan is not the exact canonical artifact")
    return plan


@contextmanager
def phase_limits(plan):
    validate_plan(plan)
    with _policy_lock:
        if v2.ACTOR_LIMITS is not v3.ACTOR_LIMITS or v2.STUDY_LIMIT != STUDY_LIMIT or v3.STUDY_LIMIT != STUDY_LIMIT:
            raise ValueError("shared funding policy identity changed")
        previous = dict(v2.ACTOR_LIMITS)
        try:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(plan["actorLimitsUsd"])
            yield
        finally:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(previous)


def validate_prefix(directory, plan):
    validate_plan(plan)
    directory = Path(directory)
    prior = directory / v4.ALLOCATION_FILE
    if v3.file_hash(prior.read_bytes()) != plan["previousAllocationSha256"]:
        raise ValueError("previous durable allocation changed")
    previous = json.loads(prior.read_bytes())
    if previous.get("phasePlanSha256") != plan["previousPhasePlanSha256"]:
        raise ValueError("previous phase lineage changed")
    rows, hashes = {}, {}
    for name, expected in plan["prefix"].items():
        data = (directory / name).read_bytes()
        lines = data.splitlines(keepends=True)
        if len(lines) < expected["count"] or (data and not data.endswith(b"\n")) or v3.file_hash(b"".join(lines[:expected["count"]])) != expected["sha256"]:
            raise ValueError("historical journal prefix changed or truncated")
        rows[name] = [json.loads(line) for line in lines]
        hashes[name] = v3.file_hash(data)
        if any(row.get("actor", "diagnostics") not in ACTORS for row in rows[name][expected["count"]:]):
            raise ValueError("sealed actor has post-allocation history")
    prefix = rows["receipts.jsonl"][:plan["prefix"]["receipts.jsonl"]["count"]]
    if {row.get("seq") for row in prefix} != set(range(1, plan["historicalSequence"] + 1)):
        raise ValueError("historical receipt sequence changed")
    for actor, expected in plan["historicalActorMeasuredUsd"].items():
        actual = math.fsum(row["measuredUsd"] for row in prefix if row.get("actor", "diagnostics") == actor)
        if abs(actual - expected) > 1e-8:
            raise ValueError("historical actor cost changed")
    return {"rows": rows, "sha256": hashes}


def allocation_payload(plan):
    return {"kind": "durable-v5-equal-remainder-allocation", "phasePlanSha256": APPROVED_PLAN_SHA256,
            "phasePlan": plan, "historicalAmountsRetained": True, "newActorsCreated": False,
            "ownerStudyMaximumUnchanged": STUDY_LIMIT,
            "instrumentSha256": {name: v3.file_hash((ARCHIVE / name).read_bytes()) for name in (
                "budget_gateway.py", "budget_gateway_v2.py", "budget_gateway_v3.py", "budget_gateway_v4.py")},
            "allocationInstrumentSha256": v3.file_hash(Path(__file__).read_bytes())}


class Budget(v3.Budget):
    def __init__(self, directory, plan):
        self.phase_plan = validate_plan(plan)
        self._check_policy()
        checked = validate_prefix(directory, plan)
        destination = Path(directory) / ALLOCATION_FILE
        payload = allocation_payload(plan)
        if destination.exists():
            recorded = json.loads(destination.read_bytes())
            if not isinstance(recorded, dict) or set(recorded) != set(payload) | {"atUtc"} or any(recorded.get(key) != value for key, value in payload.items()) or not isinstance(recorded.get("atUtc"), str):
                raise ValueError("durable remainder audit differs from approved allocation")
        elif any(len(checked["rows"][name]) != plan["prefix"][name]["count"] for name in checked["rows"]):
            raise ValueError("new history exists without its durable allocation audit")
        # Reprice every receipt and reconcile every admission using unchanged v3.
        # No automatic snapshot recovery, refund, reservation reset or unseal.
        super().__init__(directory)
        for name, expected in checked["sha256"].items():
            source = Path(directory) / name
            with source.open("r+b") as stream:
                os.fsync(stream.fileno())
            if v3.file_hash(source.read_bytes()) != expected:
                raise ValueError("journal changed during allocation")
        if not destination.exists():
            payload["atUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with destination.open("xb") as stream:
                stream.write(canonical(payload))
                stream.flush()
                os.fsync(stream.fileno())
        else:
            with destination.open("r+b") as stream:
                os.fsync(stream.fileno())

    def _check_policy(self):
        if v2.ACTOR_LIMITS != self.phase_plan["actorLimitsUsd"] or v3.ACTOR_LIMITS is not v2.ACTOR_LIMITS:
            raise ValueError("v5 used outside its reviewed process policy")

    def status(self):
        self._check_policy()
        return {**super().status(), "phaseID": PHASE, "phasePlanSha256": APPROVED_PLAN_SHA256,
                "historicalPhaseBoundary": self.phase_plan["historicalSequence"]}

    def arm(self, actor, label, calls):
        self._check_policy()
        if actor not in ACTORS:
            raise v2.AdmissionError("historical non-runtime actor is sealed")
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
    args = parser.parse_args()
    directory = args.directory.resolve()
    import msvcrt
    with (directory / "gateway-v2.lock").open("a+b") as ledger_lock:
        ledger_lock.seek(0)
        msvcrt.locking(ledger_lock.fileno(), msvcrt.LK_NBLCK, 1)
        if json.loads((directory / "owner-budget.json").read_text())["authorizedStudyMaximumUsd"] != STUDY_LIMIT:
            raise SystemExit("Owner total must remain USD48")
        plan = load_plan(args.phase_plan)
        with phase_limits(plan):
            with v4.OwnedHTTPServer(("127.0.0.1", args.port), v4.UnarmedHandler) as server:
                budget = Budget(directory, plan)
                config = json.loads((directory / "gateway-config.json").read_text())
                print(f"Reviewed equal remainder: USD48 total; USD{budget.spent:.7f} retained; no batch armed.", flush=True)
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("OpenAI API key (hidden, memory only): ").strip()
                if not key:
                    raise SystemExit("No key; no provider access.")
                server.RequestHandlerClass = v4.handler(budget, key, config["localToken"])
                budget.publish_snapshot()
                print(f"Ready on loopback:{args.port}; all historical charges retained.", flush=True)
                server.serve_forever()


if __name__ == "__main__":
    main()
