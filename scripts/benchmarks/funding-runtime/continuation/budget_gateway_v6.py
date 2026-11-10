"""Explicit additional USD20 round with the prior unknown call still fenced.

Import starts nothing. Historical journals are read-only; new real calls use a
separate directory and their original global sequence numbers. No missing bill
is invented or credited. The source-pinned phase is required before key entry.
"""
import argparse
from contextlib import contextmanager
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import sys
import threading
import time
import warnings

ARCHIVE = Path(__file__).resolve().parents[1] / "archive"
sys.path.insert(0, str(ARCHIVE))
import budget_gateway_v2 as v2
import budget_gateway_v3 as v3
import budget_gateway_v4 as v4

# Filled only after the root reviews the exact owner-authorized artifact. There
# is deliberately no CLI, environment or configuration override for this pin.
APPROVED_PLAN_SHA256 = "b91f3cfdd0738299f44ffa23e9a8850ca5751665a521859cf5c1fc2507ee0d5d"
APPROVED_PLAN_FILE_SHA256 = "19ee7dbe02ff9e5d3ab2d8e41c1da1f738d1977f879a4a4be284947c793b1255"
APPROVED_LEDGER_DIRECTORY_SHA256 = "e0e94ad05bd166c70c91ee5213d9ba876ae9e28c0a49b0e2552e59fc3e4e2f6e"
APPROVED_HISTORICAL_DIRECTORY_SHA256 = "20a6c9b6f82a4cba452d188c86d907b776151ee0e08a6652b417d0b3755c5bdb"
PHASE = "heavy-additional-20-v1"
ANCHOR_FILE = "phase-anchor-v6.json"
PLACEMENT_FILE = "phase-placement-v6.json"
ACTORS = ("foundry-vector", "foundry-codex")
OLD_ACTORS = ("diagnostics", "saas-vector", "saas-codex")
HISTORICAL_FILES = {"admissions-v2.jsonl", "receipts.jsonl", "status.json", "phase-allocation-v5.json"}
META_FIELDS = {"model", "requestSha256", "requestBytes", "requestedMaxOutputTokens", "maxOutputTokens",
               "requestedReasoningEffort", "cacheKeySha256", "toolsSha256", "inputItemSha256", "rates", "sources"}
RESULT_FIELDS = {"measuredUsd", "httpStatus", "responseID", "responseStatus", "serviceTier", "usage", "elapsedMs", "failureKind"}
ATTEMPT_FIELDS = {"seq", "actor", "label", "batchSha256", "reservedUsd", "startedUtc"}
_policy_lock = threading.RLock()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def same(left, right):
    return v3.finite_nonnegative(left) and v3.finite_nonnegative(right) and math.isclose(left, right, rel_tol=0, abs_tol=1e-8)


def hexadecimal(value):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None


def validate_plan(plan):
    require(isinstance(plan, dict) and sha(canonical(plan)) == APPROVED_PLAN_SHA256,
            "not the source-pinned additional-round authorization")
    expected = {"kind", "phaseID", "authorizedAdditionalUsd", "historicalKnownMeasuredUsd", "historicalLatestAdmittedSeq",
                "historicalSettledThroughSeq", "historicalActorMeasuredUsd", "carriedUnsettled", "cumulativeUpperExposureLimitUsd",
                "actorLimitsUsd", "historicalFiles", "historicalRowCounts", "previousPhasePlanSha256",
                "historicalPricingRates", "noOldLiabilityReleased", "allHistoricalAdmissionsSettled"}
    require(set(plan) == expected and plan["kind"] == "owner-approved-additional-20-phase-v1" and plan["phaseID"] == PHASE,
            "phase identity or fields changed")
    require(plan["authorizedAdditionalUsd"] == 20 and plan["noOldLiabilityReleased"] is True
            and plan["allHistoricalAdmissionsSettled"] is False and plan["historicalPricingRates"] == v3.RATES,
            "new allowance, price schedule or old uncertainty changed")
    amounts, limits = plan["historicalActorMeasuredUsd"], plan["actorLimitsUsd"]
    require(isinstance(amounts, dict) and isinstance(limits, dict) and set(amounts) == set(limits) == set(ACTORS + OLD_ACTORS),
            "historical actor identity changed")
    require(all(v3.finite_nonnegative(x) for x in (*amounts.values(), *limits.values()))
            and same(math.fsum(amounts.values()), plan["historicalKnownMeasuredUsd"]), "invalid historical actor amounts")
    carried = plan["carriedUnsettled"]
    require(isinstance(carried, dict) and set(carried) == {"seq", "actor", "reservedUsd", "requestSha256", "admissionCanonicalSha256"}
            and carried["actor"] == "foundry-codex" and v3.finite_nonnegative(carried["reservedUsd"])
            and 0 < carried["reservedUsd"] <= 5.73
            and hexadecimal(carried["requestSha256"]) and hexadecimal(carried["admissionCanonicalSha256"]),
            "carried uncertainty is not the exact approved request")
    require(v2.count(plan["historicalSettledThroughSeq"]) and plan["historicalSettledThroughSeq"] > 0
            and v2.count(plan["historicalLatestAdmittedSeq"])
            and carried["seq"] == plan["historicalLatestAdmittedSeq"] == plan["historicalSettledThroughSeq"] + 1,
            "historical sequence boundary changed")
    require(same(plan["cumulativeUpperExposureLimitUsd"], plan["historicalKnownMeasuredUsd"] + carried["reservedUsd"] + 20),
            "new round does not conserve its exposure ceiling")
    for actor in amounts:
        hold = carried["reservedUsd"] if actor == carried["actor"] else 0
        require(same(limits[actor], amounts[actor] + hold + (20 if actor in ACTORS else 0)),
                "runtime ceiling or sealed historical actor changed")
    require(isinstance(plan["historicalFiles"], dict) and set(plan["historicalFiles"]) == HISTORICAL_FILES
            and all(hexadecimal(x) for x in plan["historicalFiles"].values())
            and hexadecimal(plan["previousPhasePlanSha256"]), "historical file identity is incomplete")
    counts = plan["historicalRowCounts"]
    require(isinstance(counts, dict) and set(counts) == {"admissions", "receipts"}
            and all(v2.count(x) and x > 0 for x in counts.values())
            and counts["receipts"] == plan["historicalSettledThroughSeq"], "historical row counts changed")
    return plan


def load_plan(path):
    data = Path(path).read_bytes()
    require(sha(data) == APPROVED_PLAN_FILE_SHA256, "phase plan raw bytes differ from the approved artifact")
    plan = validate_plan(json.loads(data))
    return plan


@contextmanager
def phase_limits(plan):
    plan = json.loads(canonical(validate_plan(plan)))
    with _policy_lock:
        require(v2.ACTOR_LIMITS is v3.ACTOR_LIMITS, "shared actor policy identity changed")
        previous = (dict(v2.ACTOR_LIMITS), v2.STUDY_LIMIT, v3.STUDY_LIMIT)
        try:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(plan["actorLimitsUsd"])
            v2.STUDY_LIMIT = v3.STUDY_LIMIT = plan["cumulativeUpperExposureLimitUsd"]
            yield
        finally:
            v2.ACTOR_LIMITS.clear()
            v2.ACTOR_LIMITS.update(previous[0])
            v2.STUDY_LIMIT, v3.STUDY_LIMIT = previous[1:]


def linked(path):
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def location_digest(path):
    return sha(Path(path).resolve().as_posix().casefold().encode("utf-8"))


def rows(directory, name):
    path = directory / name
    require(not linked(path), "linked ledger file")
    return v3.journal(directory, name)[0]


def validate_receipt(receipt, admission, expected_cumulative):
    require(isinstance(receipt, dict), "receipt is not an object")
    actor, amount = receipt.get("actor", "diagnostics"), receipt.get("measuredUsd")
    require(actor in v2.ACTOR_LIMITS and v3.finite_nonnegative(amount)
            and v3.finite_nonnegative(receipt.get("reservedUsd"))
            and amount <= receipt["reservedUsd"] + 1e-8, "invalid or unpriced receipt")
    require(receipt.get("model") == v3.MODEL and receipt.get("rates") == v3.RATES
            and receipt.get("serviceTier") in (None, "default", "standard")
            and same(v3.price(receipt.get("usage")), amount), "receipt usage, model, tier or price differs")
    if admission is not None:
        require(all(receipt.get(k) == v for k, v in admission.items()), "immutable admission metadata differs")
    if "cumulativeMeasuredUsd" in receipt:
        require(same(receipt["cumulativeMeasuredUsd"], expected_cumulative + amount), "receipt cumulative cost differs")
    return actor, amount


def historical_audit(directory, plan):
    """v3's full repricing rules, with exactly one source-pinned carried gap."""
    require(directory.is_dir() and not linked(directory), "historical ledger directory missing or linked")
    for name, expected in plan["historicalFiles"].items():
        path = directory / name
        require(path.is_file() and not linked(path) and sha(path.read_bytes()) == expected, "historical file bytes changed")
    allocation = json.loads((directory / "phase-allocation-v5.json").read_bytes())
    require(allocation.get("phasePlanSha256") == plan["previousPhasePlanSha256"], "previous phase lineage changed")
    admissions, receipts = rows(directory, "admissions-v2.jsonl"), rows(directory, "receipts.jsonl")
    require(len(admissions) == plan["historicalRowCounts"]["admissions"]
            and len(receipts) == plan["historicalRowCounts"]["receipts"], "historical journal count differs")
    admitted, settled, actor_spent, spent = {}, set(), {actor: 0.0 for actor in v2.ACTOR_LIMITS}, 0.0
    for item in admissions:
        seq = item.get("seq")
        require(v2.count(seq) and seq > 0 and seq not in admitted and item.get("actor") in v2.ACTOR_LIMITS
                and v3.finite_nonnegative(item.get("reservedUsd")) and item["reservedUsd"] > 0,
                "invalid historical admission")
        admitted[seq] = item
    for item in receipts:
        seq = item.get("seq")
        require(v2.count(seq) and 0 < seq <= plan["historicalSettledThroughSeq"] and seq not in settled,
                "invalid historical receipt sequence")
        require(seq in admitted or (seq <= v3.LEGACY_RECEIPT_MAX and "actor" not in item), "unapproved missing historical admission")
        actor, amount = validate_receipt(item, admitted.get(seq), spent)
        spent += amount
        actor_spent[actor] += amount
        settled.add(seq)
    carried = plan["carriedUnsettled"]
    require(settled == set(range(1, plan["historicalSettledThroughSeq"] + 1))
            and set(admitted) - settled == {carried["seq"]}, "historical unmatched requests differ")
    item = admitted[carried["seq"]]
    require(sha(canonical(item)) == carried["admissionCanonicalSha256"]
            and all(item.get(k) == carried[k] for k in ("seq", "actor", "reservedUsd", "requestSha256")),
            "carried admission metadata differs")
    require(same(spent, plan["historicalKnownMeasuredUsd"])
            and all(same(actor_spent[a], plan["historicalActorMeasuredUsd"][a]) for a in actor_spent),
            "historical known spending differs")
    return {"verifiedHistoricalPrices": len(receipts), "unmatchedHistoricalAdmissions": 1,
            "historicalLiabilityUsd": carried["reservedUsd"], "allHistoricalAdmissionsSettled": False}


def validate_metadata(metadata):
    require(isinstance(metadata, dict) and set(metadata) == META_FIELDS, "unknown or missing request metadata")
    require(metadata["model"] == v3.MODEL and metadata["rates"] == v3.RATES and metadata["sources"] == v3.SOURCES
            and metadata["requestedReasoningEffort"] == "high", "model, price, source or reasoning changed")
    require(v2.count(metadata["requestBytes"]) and 0 < metadata["requestBytes"] <= v3.MAX_BODY
            and v2.count(metadata["maxOutputTokens"]) and 0 < metadata["maxOutputTokens"] <= v3.OUTPUT
            and (metadata["requestedMaxOutputTokens"] is None or
                 (v2.count(metadata["requestedMaxOutputTokens"]) and metadata["requestedMaxOutputTokens"] > 0)),
            "invalid request/output bounds")
    require(all(hexadecimal(metadata[k]) for k in ("requestSha256", "cacheKeySha256", "toolsSha256"))
            and isinstance(metadata["inputItemSha256"], list) and all(hexadecimal(x) for x in metadata["inputItemSha256"]),
            "invalid immutable request hashes")


def round_audit(directory, plan):
    admissions, receipts = rows(directory, "admissions-v2.jsonl"), rows(directory, "receipts.jsonl")
    first = plan["historicalLatestAdmittedSeq"]
    admitted, settled, actor_spent, spent = {}, set(), dict(plan["historicalActorMeasuredUsd"]), plan["historicalKnownMeasuredUsd"]
    for item in admissions:
        require(set(item) == META_FIELDS | ATTEMPT_FIELDS, "unknown or missing durable admission metadata")
        validate_metadata({k: item[k] for k in META_FIELDS})
        seq = item.get("seq")
        require(v2.count(seq) and seq > first and seq not in admitted and item.get("actor") in ACTORS
                and v3.finite_nonnegative(item.get("reservedUsd")) and item["reservedUsd"] > 0,
                "invalid additional-round admission")
        admitted[seq] = item
    last = max(admitted, default=first)
    require(set(admitted) == set(range(first + 1, last + 1)), "additional-round admission sequence gap")
    for item in receipts:
        seq = item.get("seq")
        require(v2.count(seq) and seq in admitted and seq not in settled
                and set(item) <= META_FIELDS | ATTEMPT_FIELDS | RESULT_FIELDS | {"cumulativeMeasuredUsd"},
                "unknown or duplicate additional-round receipt metadata")
        actor, amount = validate_receipt(item, admitted[seq], spent)
        spent += amount
        actor_spent[actor] += amount
        settled.add(seq)
    require(set(admitted) == settled, "unmatched new-round admission; no startup recovery or refund")
    require(spent + plan["carriedUnsettled"]["reservedUsd"] <= plan["cumulativeUpperExposureLimitUsd"] + 1e-8
            and all(actor_spent[a] + (plan["carriedUnsettled"]["reservedUsd"] if a == "foundry-codex" else 0)
                    <= plan["actorLimitsUsd"][a] + 1e-8 for a in actor_spent), "additional-round authorization exceeded")
    path = directory / "status.json"
    if path.exists():
        require(not linked(path), "linked current-round status")
        status = json.loads(path.read_bytes())
        require(isinstance(status, dict) and v2.count(status.get("active")) and status["active"] == 0
                and v3.finite_nonnegative(status.get("reservedUsd")) and status["reservedUsd"] == 0
                and status.get("halted") is None and v2.count(status.get("attempts")) and status["attempts"] == last
                and same(status.get("measuredUsd"), spent), "current-round snapshot is ambiguous or halted")
        require(status.get("phaseID") == PHASE and status.get("phasePlanSha256") == APPROVED_PLAN_SHA256
                and status.get("allHistoricalAdmissionsSettled") is False and status.get("historicalUncertaintyRemains") is True
                and same(status.get("historicalLiabilityUsd"), plan["carriedUnsettled"]["reservedUsd"])
                and same(status.get("newRoundMeasuredUsd"), spent - plan["historicalKnownMeasuredUsd"])
                and same(status.get("newRoundReservedUsd"), 0)
                and v2.count(status.get("newRoundAttempts")) and status["newRoundAttempts"] == last - first
                and same(status.get("limitUsd"), plan["cumulativeUpperExposureLimitUsd"])
                and same(status.get("cumulativeUpperExposureUsd"), spent + plan["carriedUnsettled"]["reservedUsd"]),
                "current-round snapshot phase or carried uncertainty differs")
        actors = status.get("actors")
        require(isinstance(actors, dict) and set(actors) == set(actor_spent), "current-round snapshot actor inventory differs")
        for actor, amount in actor_spent.items():
            state = actors[actor]
            require(isinstance(state, dict) and same(state.get("measuredUsd"), amount) and same(state.get("reservedUsd"), 0)
                    and same(state.get("limitUsd"), plan["actorLimitsUsd"][actor])
                    and same(state.get("historicalLiabilityUsd"), plan["carriedUnsettled"]["reservedUsd"] if actor == "foundry-codex" else 0),
                    "current-round snapshot actor state differs")
    elif admissions:
        raise ValueError("current-round snapshot missing for existing calls")
    return {"seq": last, "spent": spent, "actor_spent": actor_spent, "settled": settled,
            "currentRoundCalls": len(admissions)}


def anchor_payload(plan):
    return {"kind": "durable-v6-carried-liability-phase-anchor", "phasePlanSha256": APPROVED_PLAN_SHA256,
            "phasePlan": plan, "originalHistoryReadOnly": True, "historicalLiabilityNotReleased": True,
            "allHistoricalAdmissionsSettled": False, "instrumentSha256": sha(Path(__file__).read_bytes()),
            "transportSha256": {name: sha((ARCHIVE / name).read_bytes()) for name in
                                ("budget_gateway.py", "budget_gateway_v2.py", "budget_gateway_v3.py", "budget_gateway_v4.py")}}


class Budget(v3.Budget):
    def __init__(self, directory, historical_directory, plan):
        self.phase_plan = json.loads(canonical(validate_plan(plan)))
        plan = self.phase_plan
        self._check_policy()
        self.directory, self.historical_directory = Path(directory).resolve(), Path(historical_directory).resolve()
        require(location_digest(self.directory) == APPROVED_LEDGER_DIRECTORY_SHA256
                and location_digest(self.historical_directory) == APPROVED_HISTORICAL_DIRECTORY_SHA256,
                "ledger placement differs from the source-pinned single round")
        require(self.directory != self.historical_directory and not self.directory.is_relative_to(self.historical_directory)
                and not self.historical_directory.is_relative_to(self.directory), "new and historical ledgers must be separate")
        historical_audit(self.historical_directory, plan)
        require(not linked(Path(directory)) and not linked(Path(historical_directory)), "linked ledger root")
        self.directory.mkdir(parents=True, exist_ok=True)
        destination, payload = self.directory / ANCHOR_FILE, anchor_payload(plan)
        placement_path = self.historical_directory / PLACEMENT_FILE
        create_placement = not placement_path.exists()
        if not create_placement:
            require(not linked(placement_path), "linked phase placement")
            placement = json.loads(placement_path.read_bytes())
            require(isinstance(placement, dict) and set(placement) == {
                "kind", "phasePlanSha256", "newDirectorySha256", "historicalDirectorySha256", "bootstrapID", "anchorSha256"}
                and placement["kind"] == "durable-v6-single-round-placement"
                and placement["phasePlanSha256"] == APPROVED_PLAN_SHA256
                and placement["newDirectorySha256"] == APPROVED_LEDGER_DIRECTORY_SHA256
                and placement["historicalDirectorySha256"] == APPROVED_HISTORICAL_DIRECTORY_SHA256
                and hexadecimal(placement["bootstrapID"]) and hexadecimal(placement["anchorSha256"]),
                "phase placement differs from the single approved round")
            require(destination.is_file() and not linked(destination)
                    and sha(destination.read_bytes()) == placement["anchorSha256"],
                    "phase placement exists without its exact anchor; partial bootstrap is not recovered")
            require(all((self.directory / name).is_file() and not linked(self.directory / name)
                        for name in ("admissions-v2.jsonl", "receipts.jsonl", "status.json")),
                    "initialized current financial inventory is missing; no implicit empty-ledger reset")
            require(not linked(destination), "linked phase anchor")
            recorded = json.loads(destination.read_bytes())
            require(isinstance(recorded, dict) and set(recorded) == set(payload) | {"atUtc", "bootstrapID"}
                    and all(recorded.get(k) == v for k, v in payload.items()) and isinstance(recorded["atUtc"], str)
                    and recorded["bootstrapID"] == placement["bootstrapID"],
                    "durable additional-round anchor changed")
        else:
            require(not any(self.directory.iterdir()), "new-round files exist without their durable placement")
        checked = round_audit(self.directory, plan)
        self.condition = threading.Condition()
        self.batches, self.pending = {}, {}
        self.settled = set(range(1, plan["historicalSettledThroughSeq"] + 1)) | checked["settled"]
        self.seq, self.spent, self.actor_spent = checked["seq"], checked["spent"], checked["actor_spent"]
        self.reserved, self.actor_reserved = 0.0, {actor: 0.0 for actor in v2.ACTOR_LIMITS}
        self.halted, self.persistence_failed, self.persistence_detail = None, False, None
        self.snapshot_warning, self.diagnostic_events = None, []
        if create_placement:
            payload["atUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            payload["bootstrapID"] = secrets.token_hex(32)
            anchor_bytes = canonical(payload)
            placement = {"kind": "durable-v6-single-round-placement", "phasePlanSha256": APPROVED_PLAN_SHA256,
                "newDirectorySha256": APPROVED_LEDGER_DIRECTORY_SHA256,
                "historicalDirectorySha256": APPROVED_HISTORICAL_DIRECTORY_SHA256,
                "bootstrapID": payload["bootstrapID"], "anchorSha256": sha(anchor_bytes)}
            # The historical placement claim is durable BEFORE its matching new
            # anchor. An interrupted bootstrap fails closed rather than making
            # a different empty directory another USD20 allowance.
            with placement_path.open("xb") as stream:
                stream.write(canonical(placement))
                stream.flush()
                os.fsync(stream.fileno())
            with destination.open("xb") as stream:
                stream.write(anchor_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            for name in ("admissions-v2.jsonl", "receipts.jsonl"):
                with (self.directory / name).open("xb") as stream:
                    stream.flush()
                    os.fsync(stream.fileno())
            require(self.publish_snapshot(), "initial current-round snapshot could not be persisted")

    def _check_policy(self):
        validate_plan(self.phase_plan)
        require(v2.ACTOR_LIMITS is v3.ACTOR_LIMITS and v2.ACTOR_LIMITS == self.phase_plan["actorLimitsUsd"]
                and v2.STUDY_LIMIT == v3.STUDY_LIMIT == self.phase_plan["cumulativeUpperExposureLimitUsd"],
                "v6 used outside its reviewed process policy")

    def status(self):
        self._check_policy()
        with self.condition:
            hold = self.phase_plan["carriedUnsettled"]["reservedUsd"]
            value = super().status()
            value.update(phaseID=PHASE, phasePlanSha256=APPROVED_PLAN_SHA256,
                historicalLiabilityUsd=hold, carriedUnresolvedRequestCount=1,
                historicalKnownMeasuredUsd=self.phase_plan["historicalKnownMeasuredUsd"],
                historicalAttempts=self.phase_plan["historicalLatestAdmittedSeq"],
                historicalLedgerSha256=dict(self.phase_plan["historicalFiles"]),
                carriedUnresolvedRequestSha256=self.phase_plan["carriedUnsettled"]["requestSha256"],
                historicalUncertaintyRemains=True, allHistoricalAdmissionsSettled=False,
                allCurrentRoundAdmissionsSettled=not self.pending and self.reserved == 0 and self.halted is None,
                newRoundLimitUsd=20, newRoundMeasuredUsd=self.spent - self.phase_plan["historicalKnownMeasuredUsd"],
                newRoundReservedUsd=self.reserved, newRoundAttempts=self.seq - self.phase_plan["historicalLatestAdmittedSeq"],
                cumulativeUpperExposureUsd=self.spent + self.reserved + hold,
                remainingAdmissionUsd=v2.STUDY_LIMIT - self.spent - self.reserved - hold,
                historicalLatestAdmittedSeq=self.phase_plan["historicalLatestAdmittedSeq"],
                reservationScope="reservedUsd/active cover current round; historical liability remains separate and binding")
            for actor, state in value["actors"].items():
                state["historicalLiabilityUsd"] = hold if actor == "foundry-codex" else 0
                state["upperExposureUsd"] = state["measuredUsd"] + state["reservedUsd"] + state["historicalLiabilityUsd"]
            return value

    def arm(self, actor, label, calls):
        self._check_policy()
        if actor not in ACTORS:
            raise v2.AdmissionError("historical non-runtime actors remain sealed")
        return super().arm(actor, label, calls)

    def admit(self, token, reserve, metadata):
        self._check_policy()
        validate_metadata(metadata)
        with self.condition:
            batch = self.batches.get(token)
            if batch is None:
                raise v2.AdmissionError("no authorized additional-round batch")
            hold = self.phase_plan["carriedUnsettled"]["reservedUsd"]
            actor = batch["actor"]
            actor_hold = hold if actor == "foundry-codex" else 0
            if not v3.finite_nonnegative(reserve) or reserve <= 0 or self.spent + self.reserved + hold + reserve > v2.STUDY_LIMIT \
                    or self.actor_spent[actor] + self.actor_reserved[actor] + actor_hold + reserve > v2.ACTOR_LIMITS[actor]:
                raise v2.AdmissionError("cannot reserve inside the new USD20 round with historical liability retained")
            return super().admit(token, reserve, metadata)

    def settle(self, seq, result):
        self._check_policy()
        with self.condition:
            require(seq != self.phase_plan["carriedUnsettled"]["seq"], "historical unknown call cannot be settled by this phase")
            if seq not in self.pending:
                return False
            try:
                require(isinstance(result, dict) and set(result) <= RESULT_FIELDS, "unknown settlement metadata")
                amount = result.get("measuredUsd")
                if amount is not None:
                    require(v3.finite_nonnegative(amount) and same(v3.price(result.get("usage")), amount)
                            and result.get("serviceTier") in (None, "default", "standard"), "settlement price or usage differs")
            except (ValueError, TypeError):
                self.halted = "untrusted settlement; current reservations retained and new spending halted"
                self.condition.notify_all()
                self.publish_snapshot()
                raise
            return super().settle(seq, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("directory", "historical-directory", "phase-plan", "controller-config"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--port", type=int, default=23128)
    args = parser.parse_args()
    plan = load_plan(args.phase_plan)
    directory, historical = args.directory.resolve(), args.historical_directory.resolve()
    # Own the old lock as well so no other process can mutate the pinned history.
    # Lock files are already existing protocol files, not financial journals.
    import msvcrt
    require((historical / "gateway-v2.lock").is_file() and not linked(historical / "gateway-v2.lock"),
            "existing historical process lock missing or linked")
    with (historical / "gateway-v2.lock").open("a+b") as historical_lock:
        historical_lock.seek(0)
        msvcrt.locking(historical_lock.fileno(), msvcrt.LK_NBLCK, 1)
        with phase_limits(plan), v4.OwnedHTTPServer(("127.0.0.1", args.port), v4.UnarmedHandler) as server:
            budget = Budget(directory, historical, plan)
            with (directory / "gateway-v6.lock").open("a+b") as round_lock:
                round_lock.seek(0)
                msvcrt.locking(round_lock.fileno(), msvcrt.LK_NBLCK, 1)
                config = json.loads(args.controller_config.read_bytes())
                require(isinstance(config, dict) and set(config) == {"localToken"}
                        and isinstance(config["localToken"], str) and len(config["localToken"]) >= 24,
                        "new local controller capability is invalid")
                print("Additional round: USD20 shared; prior known costs and unresolved USD5.73 remain counted. No batch armed.", flush=True)
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("OpenAI API key (hidden, memory only): ").strip()
                require(bool(key), "no key; no provider access")
                server.RequestHandlerClass = v4.handler(budget, key, config["localToken"])
                budget.publish_snapshot()
                print(f"Ready on loopback:{args.port}; current round reserved state excludes the explicit historical liability.", flush=True)
                server.serve_forever()


if __name__ == "__main__":
    main()
