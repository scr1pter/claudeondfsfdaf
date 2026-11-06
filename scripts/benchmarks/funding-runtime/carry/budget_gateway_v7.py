"""Conservative continuation of the same USD20 authorization, not a new grant.

The original missing receipt and the later RemoteDisconnected receipt remain
unknown. Both full reservations are held; immutable history is never rewritten.
Import starts nothing and no credential is accepted before all audits pass.
"""
import argparse
from contextlib import contextmanager, ExitStack
import getpass
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import warnings

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "continuation"))
import budget_gateway_v6 as v6

v2, v3, v4 = v6.v2, v6.v3, v6.v4
canonical, sha, require, same = v6.canonical, v6.sha, v6.require, v6.same
linked, location_digest, rows = v6.linked, v6.location_digest, v6.rows
ACTORS, OLD_ACTORS = v6.ACTORS, v6.OLD_ACTORS
PHASE = "heavy-additional-20-carry-v1"
ANCHOR_FILE = "phase-anchor-v7.json"
APPROVED_PLAN_SHA256 = "315615748b0bb5f163a07fa85e9724d31b408faf878143df0fe9f07f25bf2add"
APPROVED_PLAN_FILE_SHA256 = "a47f0ff191662b2a40a4fce8ee9f327030940b143e096043b1d1c8f9aab66750"
APPROVED_DIRECTORY_SHA256 = "ef103dbdfa1b00eece9f295b0ef60db9992be894959cb29ef16a9d35cea2e6de"
APPROVED_PREVIOUS_DIRECTORY_SHA256 = "e0e94ad05bd166c70c91ee5213d9ba876ae9e28c0a49b0e2552e59fc3e4e2f6e"
APPROVED_ORIGINAL_DIRECTORY_SHA256 = "20a6c9b6f82a4cba452d188c86d907b776151ee0e08a6652b417d0b3755c5bdb"
APPROVED_PLACEMENT_SHA256 = "016f8332ad7e9dac2499b52aa4c9529a84dfb199f2ebc1819f28b5a70774dd65"
PREVIOUS_FILES = {"admissions-v2.jsonl", "receipts.jsonl", "status.json", "phase-anchor-v6.json"}
_policy_lock = threading.RLock()


def validate_plan(plan):
    require(isinstance(plan, dict) and sha(canonical(plan)) == APPROVED_PLAN_SHA256,
            "not the source-pinned conservative continuation")
    expected = {"kind", "phaseID", "authorizedAdditionalUsd", "originalHistoricalKnownMeasuredUsd",
                "historicalKnownMeasuredUsd", "previousRoundKnownMeasuredUsd", "historicalLatestAdmittedSeq",
                "historicalActorMeasuredUsd", "carriedUnsettled", "historicalLiabilityUsd",
                "remainingAdditionalExposureUsd", "cumulativeUpperExposureLimitUsd", "actorLimitsUsd",
                "originalPhasePlanSha256", "previousPhaseFiles", "previousPlacementSha256",
                "previousPhaseRowCounts", "historicalPricingRates", "noLiabilityReleased",
                "allHistoricalAdmissionsSettled"}
    require(set(plan) == expected and plan["kind"] == "reviewed-conservative-carry-v1"
            and plan["phaseID"] == PHASE and plan["authorizedAdditionalUsd"] == 20
            and plan["noLiabilityReleased"] is True and plan["allHistoricalAdmissionsSettled"] is False,
            "continuation identity, allowance or uncertainty changed")
    require(plan["originalPhasePlanSha256"] == v6.APPROVED_PLAN_SHA256
            and plan["historicalPricingRates"] == v3.RATES,
            "original authorization or pricing differs")
    amounts, limits, unknowns = plan["historicalActorMeasuredUsd"], plan["actorLimitsUsd"], plan["carriedUnsettled"]
    require(isinstance(amounts, dict) and isinstance(limits, dict)
            and set(amounts) == set(limits) == set(ACTORS + OLD_ACTORS)
            and all(v3.finite_nonnegative(x) for x in (*amounts.values(), *limits.values()))
            and same(sum(amounts.values()), plan["historicalKnownMeasuredUsd"]), "invalid actor amounts")
    require(isinstance(unknowns, list) and len(unknowns) == 2, "both exact liabilities are required")
    for item in unknowns:
        require(isinstance(item, dict) and set(item) == {"seq", "actor", "reservedUsd", "requestSha256",
                "admissionCanonicalSha256", "receiptCanonicalSha256"}
                and v2.count(item["seq"]) and item["seq"] > 0 and item["actor"] in ACTORS
                and v3.finite_nonnegative(item["reservedUsd"]) and item["reservedUsd"] > 0
                and v6.hexadecimal(item["requestSha256"]) and v6.hexadecimal(item["admissionCanonicalSha256"])
                and (item["receiptCanonicalSha256"] is None or v6.hexadecimal(item["receiptCanonicalSha256"])),
                "invalid carried liability")
    require(unknowns[0]["seq"] < unknowns[1]["seq"] == plan["historicalLatestAdmittedSeq"]
            and unknowns[0]["receiptCanonicalSha256"] is None
            and v6.hexadecimal(unknowns[1]["receiptCanonicalSha256"])
            and same(sum(x["reservedUsd"] for x in unknowns), plan["historicalLiabilityUsd"]),
            "liability order, exact receipt or total differs")
    require(same(plan["historicalKnownMeasuredUsd"], plan["originalHistoricalKnownMeasuredUsd"] + plan["previousRoundKnownMeasuredUsd"])
            and same(plan["remainingAdditionalExposureUsd"], 20 - plan["previousRoundKnownMeasuredUsd"] - unknowns[1]["reservedUsd"])
            and same(plan["cumulativeUpperExposureLimitUsd"], plan["historicalKnownMeasuredUsd"]
                     + plan["historicalLiabilityUsd"] + plan["remainingAdditionalExposureUsd"]),
            "continuation would reset or increase the existing USD20 allowance")
    require(isinstance(plan["previousPhaseFiles"], dict) and set(plan["previousPhaseFiles"]) == PREVIOUS_FILES
            and all(v6.hexadecimal(x) for x in plan["previousPhaseFiles"].values())
            and v6.hexadecimal(plan["previousPlacementSha256"]), "previous history hashes differ")
    counts = plan["previousPhaseRowCounts"]
    require(isinstance(counts, dict) and set(counts) == {"admissions", "receipts"}
            and all(v2.count(x) and x > 0 for x in counts.values())
            and counts["admissions"] == counts["receipts"], "previous history inventory differs")
    return plan


def load_plan(path):
    data = Path(path).read_bytes()
    require(sha(data) == APPROVED_PLAN_FILE_SHA256, "approved plan raw bytes differ")
    return validate_plan(json.loads(data))


@contextmanager
def phase_limits(plan):
    plan = json.loads(canonical(validate_plan(plan)))
    with _policy_lock:
        require(v2.ACTOR_LIMITS is v3.ACTOR_LIMITS, "shared actor policy identity differs")
        previous = dict(v2.ACTOR_LIMITS), v2.STUDY_LIMIT, v3.STUDY_LIMIT
        try:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(plan["actorLimitsUsd"])
            v2.STUDY_LIMIT = v3.STUDY_LIMIT = plan["cumulativeUpperExposureLimitUsd"]
            yield
        finally:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(previous[0])
            v2.STUDY_LIMIT, v3.STUDY_LIMIT = previous[1:]


def history_audit(original, previous, plan):
    original_plan = v6.load_plan(ROOT / "continuation" / "approved-phase-plan.json")
    require(plan["actorLimitsUsd"] == original_plan["actorLimitsUsd"]
            and same(plan["cumulativeUpperExposureLimitUsd"], original_plan["cumulativeUpperExposureLimitUsd"])
            and same(plan["originalHistoricalKnownMeasuredUsd"], original_plan["historicalKnownMeasuredUsd"])
            and {k: v for k, v in plan["carriedUnsettled"][0].items() if k != "receiptCanonicalSha256"}
                == original_plan["carriedUnsettled"], "original authorization or liability changed")
    v6.historical_audit(original, original_plan)
    require(previous.is_dir() and not linked(previous), "previous history missing or linked")
    for name, expected in plan["previousPhaseFiles"].items():
        path = previous / name
        require(path.is_file() and not linked(path) and sha(path.read_bytes()) == expected, "previous history bytes changed")
    placement = original / v6.PLACEMENT_FILE
    require(placement.is_file() and not linked(placement)
            and sha(placement.read_bytes()) == plan["previousPlacementSha256"], "previous placement changed")
    admissions, receipts = rows(previous, "admissions-v2.jsonl"), rows(previous, "receipts.jsonl")
    require(len(admissions) == plan["previousPhaseRowCounts"]["admissions"]
            and len(receipts) == plan["previousPhaseRowCounts"]["receipts"], "previous row counts differ")
    admitted, observed, spent, amounts = {}, set(), original_plan["historicalKnownMeasuredUsd"], dict(original_plan["historicalActorMeasuredUsd"])
    for item in admissions:
        require(set(item) == v6.META_FIELDS | v6.ATTEMPT_FIELDS, "previous admission fields differ")
        v6.validate_metadata({k: item[k] for k in v6.META_FIELDS})
        seq = item.get("seq")
        require(v2.count(seq) and seq > original_plan["historicalLatestAdmittedSeq"] and seq not in admitted
                and item.get("actor") in ACTORS and v3.finite_nonnegative(item.get("reservedUsd"))
                and item["reservedUsd"] > 0, "invalid previous admission")
        admitted[seq] = item
    require(set(admitted) == set(range(original_plan["historicalLatestAdmittedSeq"] + 1, plan["historicalLatestAdmittedSeq"] + 1)),
            "previous admission sequence gap")
    unknown = plan["carriedUnsettled"][1]
    for item in receipts:
        seq = item.get("seq")
        require(seq in admitted and seq not in observed
                and set(item) <= v6.META_FIELDS | v6.ATTEMPT_FIELDS | v6.RESULT_FIELDS | {"cumulativeMeasuredUsd"},
                "previous receipt sequence or fields differ")
        if seq == unknown["seq"]:
            require(item.get("measuredUsd") is None and item.get("usage") is None
                    and item.get("httpStatus") is None and item.get("failureKind") == "RemoteDisconnected"
                    and sha(canonical(item)) == unknown["receiptCanonicalSha256"]
                    and all(item.get(k) == v for k, v in admitted[seq].items())
                    and sha(canonical(admitted[seq])) == unknown["admissionCanonicalSha256"]
                    and all(item.get(k) == unknown[k] for k in ("seq", "actor", "reservedUsd", "requestSha256"))
                    and same(item.get("cumulativeMeasuredUsd"), spent), "new unknown is not the exact retained observation")
        else:
            actor, amount = v6.validate_receipt(item, admitted[seq], spent)
            spent += amount
            amounts[actor] += amount
        observed.add(seq)
    require(observed == set(admitted) and same(spent, plan["historicalKnownMeasuredUsd"])
            and all(same(amounts[a], plan["historicalActorMeasuredUsd"][a]) for a in amounts), "previous known amounts differ")
    status = json.loads((previous / "status.json").read_bytes())
    require(status.get("active") == 0 and status.get("batchCallsRemaining") == 0
            and status.get("halted") == "uncertain settlement; reservation retained and further spending halted"
            and same(status.get("reservedUsd"), unknown["reservedUsd"])
            and same(status.get("measuredUsd"), spent) and status.get("attempts") == plan["historicalLatestAdmittedSeq"]
            and status.get("phaseID") == v6.PHASE and status.get("phasePlanSha256") == v6.APPROVED_PLAN_SHA256,
            "previous process is not the exact quiescent halted phase")
    return original_plan


def round_audit(directory, plan):
    admissions, receipts = rows(directory, "admissions-v2.jsonl"), rows(directory, "receipts.jsonl")
    first = plan["historicalLatestAdmittedSeq"]
    admitted, settled, amounts, spent = {}, set(), dict(plan["historicalActorMeasuredUsd"]), plan["historicalKnownMeasuredUsd"]
    for item in admissions:
        require(set(item) == v6.META_FIELDS | v6.ATTEMPT_FIELDS, "current admission fields differ")
        v6.validate_metadata({k: item[k] for k in v6.META_FIELDS})
        seq = item.get("seq")
        require(v2.count(seq) and seq > first and seq not in admitted and item.get("actor") in ACTORS
                and v3.finite_nonnegative(item.get("reservedUsd")) and item["reservedUsd"] > 0, "invalid current admission")
        admitted[seq] = item
    last = max(admitted, default=first)
    require(set(admitted) == set(range(first + 1, last + 1)), "current admission sequence gap")
    for item in receipts:
        seq = item.get("seq")
        require(seq in admitted and seq not in settled
                and set(item) <= v6.META_FIELDS | v6.ATTEMPT_FIELDS | v6.RESULT_FIELDS | {"cumulativeMeasuredUsd"},
                "current receipt sequence or fields differ")
        actor, amount = v6.validate_receipt(item, admitted[seq], spent)
        spent += amount
        amounts[actor] += amount
        settled.add(seq)
    require(set(admitted) == settled, "unmatched current admission; no implicit recovery or refund")
    require(spent + plan["historicalLiabilityUsd"] <= plan["cumulativeUpperExposureLimitUsd"] + 1e-8
            and all(amounts[a] + sum(x["reservedUsd"] for x in plan["carriedUnsettled"] if x["actor"] == a)
                    <= plan["actorLimitsUsd"][a] + 1e-8 for a in amounts), "existing authorization exceeded")
    path = directory / "status.json"
    if path.exists():
        require(not linked(path), "linked current status")
        status = json.loads(path.read_bytes())
        require(status.get("active") == 0 and status.get("reservedUsd") == 0 and status.get("halted") is None
                and status.get("attempts") == last and same(status.get("measuredUsd"), spent)
                and status.get("phaseID") == PHASE and status.get("phasePlanSha256") == APPROVED_PLAN_SHA256
                and status.get("historicalUncertaintyRemains") is True and status.get("allHistoricalAdmissionsSettled") is False
                and status.get("carriedUnresolvedRequestCount") == 2
                and same(status.get("historicalLiabilityUsd"), plan["historicalLiabilityUsd"])
                and same(status.get("newRoundMeasuredUsd"), spent - plan["originalHistoricalKnownMeasuredUsd"])
                and same(status.get("cumulativeUpperExposureUsd"), spent + plan["historicalLiabilityUsd"]), "current status is ambiguous or inconsistent")
        actors = status.get("actors")
        require(isinstance(actors, dict) and set(actors) == set(amounts), "current actor inventory differs")
        for actor, amount in amounts.items():
            state = actors[actor]
            require(isinstance(state, dict) and same(state.get("measuredUsd"), amount)
                    and same(state.get("reservedUsd"), 0) and same(state.get("limitUsd"), plan["actorLimitsUsd"][actor])
                    and same(state.get("historicalLiabilityUsd"), sum(x["reservedUsd"] for x in plan["carriedUnsettled"] if x["actor"] == actor)),
                    "current actor status differs")
    elif admissions:
        raise ValueError("current snapshot missing for existing calls")
    return {"seq": last, "spent": spent, "actor_spent": amounts, "settled": settled}


def anchor_payload(plan):
    names = ["archive/budget_gateway.py", "archive/budget_gateway_v2.py", "archive/budget_gateway_v3.py",
             "archive/budget_gateway_v4.py", "continuation/budget_gateway_v6.py"]
    return {"kind": "durable-v7-two-liability-continuation-anchor", "phasePlanSha256": APPROVED_PLAN_SHA256,
            "phasePlan": plan, "bothHistoriesReadOnly": True, "allHistoricalAdmissionsSettled": False,
            "instrumentSha256": sha(Path(__file__).read_bytes()),
            "inheritedRuntimeSha256": {name: sha((ROOT / name).read_bytes()) for name in names}}


class Budget(v3.Budget):
    def __init__(self, directory, original, previous, placement, plan):
        self.phase_plan = json.loads(canonical(validate_plan(plan)))
        plan = self.phase_plan
        self._check_policy()
        raw_paths = [Path(x) for x in (directory, original, previous, placement)]
        require(all(not linked(x) for x in raw_paths), "linked financial root")
        self.directory, original, previous, placement = (x.resolve() for x in raw_paths)
        require(location_digest(self.directory) == APPROVED_DIRECTORY_SHA256
                and location_digest(original) == APPROVED_ORIGINAL_DIRECTORY_SHA256
                and location_digest(previous) == APPROVED_PREVIOUS_DIRECTORY_SHA256
                and location_digest(placement) == APPROVED_PLACEMENT_SHA256, "source-pinned placement differs")
        paths = [self.directory, original, previous]
        require(all(a != b and not a.is_relative_to(b) for a in paths for b in paths if a is not b)
                and all(not placement.is_relative_to(x) for x in paths), "current, prior and placement must be separate")
        history_audit(original, previous, plan)
        self.directory.mkdir(parents=True, exist_ok=True)
        destination, payload = self.directory / ANCHOR_FILE, anchor_payload(plan)
        creating = not placement.exists()
        if not creating:
            require(placement.is_file() and not linked(placement), "linked durable placement")
            claim = json.loads(placement.read_bytes())
            require(isinstance(claim, dict) and set(claim) == {"kind", "phasePlanSha256", "directorySha256", "bootstrapID", "anchorSha256"}
                    and claim["kind"] == "durable-v7-single-placement" and claim["phasePlanSha256"] == APPROVED_PLAN_SHA256
                    and claim["directorySha256"] == APPROVED_DIRECTORY_SHA256 and v6.hexadecimal(claim["bootstrapID"])
                    and destination.is_file() and sha(destination.read_bytes()) == claim["anchorSha256"], "durable placement or anchor changed")
            require(all((self.directory / name).is_file() and not linked(self.directory / name)
                        for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json")), "initialized financial inventory is missing")
            require(not linked(destination), "linked current anchor")
            recorded = json.loads(destination.read_bytes())
            require(isinstance(recorded, dict) and set(recorded) == set(payload) | {"atUtc", "bootstrapID"}
                    and all(recorded.get(k) == v for k, v in payload.items())
                    and isinstance(recorded["atUtc"], str) and recorded["bootstrapID"] == claim["bootstrapID"], "current anchor differs")
        else:
            require(not any(self.directory.iterdir()), "current files exist without durable placement")
        checked = round_audit(self.directory, plan)
        self.condition, self.batches, self.pending = threading.Condition(), {}, {}
        self.settled = checked["settled"]
        self.seq, self.spent, self.actor_spent = checked["seq"], checked["spent"], checked["actor_spent"]
        self.reserved, self.actor_reserved = 0.0, {actor: 0.0 for actor in v2.ACTOR_LIMITS}
        self.halted, self.persistence_failed, self.persistence_detail = None, False, None
        self.snapshot_warning, self.diagnostic_events = None, []
        if creating:
            payload.update(atUtc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), bootstrapID=secrets.token_hex(32))
            anchor_bytes = canonical(payload)
            claim = {"kind": "durable-v7-single-placement", "phasePlanSha256": APPROVED_PLAN_SHA256,
                     "directorySha256": APPROVED_DIRECTORY_SHA256, "bootstrapID": payload["bootstrapID"], "anchorSha256": sha(anchor_bytes)}
            for path, content in ((placement, canonical(claim)), (destination, anchor_bytes),
                                  (self.directory / "admissions-v2.jsonl", b""), (self.directory / "receipts.jsonl", b"")):
                with path.open("xb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
            require(self.publish_snapshot(), "initial current snapshot could not be persisted")

    def _check_policy(self):
        validate_plan(self.phase_plan)
        require(v2.ACTOR_LIMITS is v3.ACTOR_LIMITS and v2.ACTOR_LIMITS == self.phase_plan["actorLimitsUsd"]
                and v2.STUDY_LIMIT == v3.STUDY_LIMIT == self.phase_plan["cumulativeUpperExposureLimitUsd"], "continuation used outside reviewed policy")

    def status(self):
        self._check_policy()
        with self.condition:
            plan = self.phase_plan
            hold = plan["historicalLiabilityUsd"]
            value = super().status()
            value.update(phaseID=PHASE, phasePlanSha256=APPROVED_PLAN_SHA256,
                historicalLiabilityUsd=hold, carriedUnresolvedRequestCount=2,
                historicalKnownMeasuredUsd=plan["historicalKnownMeasuredUsd"],
                originalHistoricalKnownMeasuredUsd=plan["originalHistoricalKnownMeasuredUsd"],
                historicalAttempts=plan["historicalLatestAdmittedSeq"],
                historicalUncertaintyRemains=True, allHistoricalAdmissionsSettled=False,
                carriedUnsettled=json.loads(canonical(plan["carriedUnsettled"])),
                allCurrentRoundAdmissionsSettled=not self.pending and self.reserved == 0 and self.halted is None,
                newRoundLimitUsd=20, newRoundMeasuredUsd=self.spent - plan["originalHistoricalKnownMeasuredUsd"],
                newRoundReservedUsd=self.reserved,
                newRoundExposureUsd=self.spent - plan["originalHistoricalKnownMeasuredUsd"] + self.reserved + plan["carriedUnsettled"][1]["reservedUsd"],
                newRoundAttempts=self.seq - plan["carriedUnsettled"][0]["seq"],
                currentPhaseAttempts=self.seq - plan["historicalLatestAdmittedSeq"],
                cumulativeUpperExposureUsd=self.spent + self.reserved + hold,
                remainingAdmissionUsd=v2.STUDY_LIMIT - self.spent - self.reserved - hold,
                historicalLatestAdmittedSeq=plan["historicalLatestAdmittedSeq"],
                remainingAdditionalExposureUsd=plan["remainingAdditionalExposureUsd"],
                reservationScope="reservedUsd/active cover current v7 calls; both historical liabilities remain separate and binding")
            for actor, state in value["actors"].items():
                actor_hold = sum(x["reservedUsd"] for x in plan["carriedUnsettled"] if x["actor"] == actor)
                state.update(historicalLiabilityUsd=actor_hold, upperExposureUsd=state["measuredUsd"] + state["reservedUsd"] + actor_hold)
            return value

    def arm(self, actor, label, calls):
        self._check_policy()
        if actor not in ACTORS:
            raise v2.AdmissionError("non-runtime actors remain sealed")
        return super().arm(actor, label, calls)

    def admit(self, token, reserve, metadata):
        self._check_policy()
        v6.validate_metadata(metadata)
        with self.condition:
            batch = self.batches.get(token)
            if batch is None:
                raise v2.AdmissionError("no authorized current batch")
            actor, plan = batch["actor"], self.phase_plan
            actor_hold = sum(x["reservedUsd"] for x in plan["carriedUnsettled"] if x["actor"] == actor)
            if not v3.finite_nonnegative(reserve) or reserve <= 0 \
                    or self.spent + self.reserved + plan["historicalLiabilityUsd"] + reserve > v2.STUDY_LIMIT \
                    or self.actor_spent[actor] + self.actor_reserved[actor] + actor_hold + reserve > v2.ACTOR_LIMITS[actor]:
                raise v2.AdmissionError("cannot reserve within unchanged USD20 authorization and both liability holds")
            return super().admit(token, reserve, metadata)

    def settle(self, seq, result):
        self._check_policy()
        with self.condition:
            require(seq > self.phase_plan["historicalLatestAdmittedSeq"], "historical observations cannot be settled or rewritten")
            if seq not in self.pending:
                return False
            try:
                require(isinstance(result, dict) and set(result) <= v6.RESULT_FIELDS, "unknown settlement fields")
                if result.get("measuredUsd") is not None:
                    require(v3.finite_nonnegative(result["measuredUsd"])
                            and same(v3.price(result.get("usage")), result["measuredUsd"])
                            and result.get("serviceTier") in (None, "default", "standard"), "settlement usage or price differs")
            except (ValueError, TypeError):
                self.halted = "untrusted settlement; reservations retained and spending halted"
                self.condition.notify_all()
                self.publish_snapshot()
                raise
            return super().settle(seq, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("directory", "original-directory", "previous-directory", "placement-file", "phase-plan", "controller-config"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--port", type=int, default=23128)
    args = parser.parse_args()
    plan = load_plan(args.phase_plan)
    import msvcrt
    with ExitStack() as stack:
        for directory, filename in ((args.original_directory, "gateway-v2.lock"), (args.previous_directory, "gateway-v6.lock")):
            path = directory / filename
            require(path.is_file() and not linked(path), "existing process lock missing or linked")
            stream = stack.enter_context(path.open("r+b"))
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        with phase_limits(plan), v4.OwnedHTTPServer(("127.0.0.1", args.port), v4.UnarmedHandler) as server:
            budget = Budget(args.directory, args.original_directory, args.previous_directory, args.placement_file, plan)
            with (budget.directory / "gateway-v7.lock").open("a+b") as current_lock:
                current_lock.seek(0)
                msvcrt.locking(current_lock.fileno(), msvcrt.LK_NBLCK, 1)
                config = json.loads(args.controller_config.read_bytes())
                require(isinstance(config, dict) and set(config) == {"localToken"}
                        and isinstance(config["localToken"], str) and len(config["localToken"]) >= 24, "invalid local controller capability")
                print("Same USD20 round; both unknown reservations remain held. No batch armed.", flush=True)
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("OpenAI API key (hidden, memory only): ").strip()
                require(bool(key), "no key; no provider access")
                server.RequestHandlerClass = v4.handler(budget, key, config["localToken"])
                budget.publish_snapshot()
                print(f"Ready on loopback:{args.port}; no historical liability was released.", flush=True)
                server.serve_forever()


if __name__ == "__main__":
    main()
