"""Plan-only recovery of one originally unrun Codex arm; never rerun Vector.

This helper lives outside the frozen matched instrument. It does not change the
original pair or waive Vector's execution/quality review. Only explicit --run
reads a controller capability and invokes the unchanged native adapter.
"""
import argparse
import copy
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import sys
from types import SimpleNamespace

ORIGINAL_PLAN_SHA = "b84c72848d9fea3d33e7fce8f3e1121938be1e8d5e53cc8023497060935f8857"
SOURCE = "479303cf229badc0fa2c770f27d7d845dfa4fa68"
SNAPSHOT_SHA = "4675be85beaa531ce3525bceca3a673659ed3c0f8e9e225aae634daa743f352e"
ORIGINAL_FILES = {
    "summary.json": "73a0fa6cabfdef6a722d428220471edd42401b446ba223f7901935aaae4c794e",
    "vector/closure.json": "bf3d40c7494221bf945df012673fa27f060081d52323f739e0b3617644f5230c",
    "vector/witness-audit.jsonl": "4738aacec8a2274576feebdfba5993c984f051daf0786671e50008ead0a803a3",
    "vector/attempts/1/source-manifest.json": "07d9560a959122773aa2e79fc177920cf86462b04ec6a99b08e48c0ad8f01111",
    "vector/attempts/2/source-manifest.json": "07d9560a959122773aa2e79fc177920cf86462b04ec6a99b08e48c0ad8f01111",
}
BASELINE = {"attempts": 1189, "measuredUsd": 27.0914679,
            "foundry-vector": 17.6761006, "foundry-codex": 6.4715992}


class ContinuationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ContinuationError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def manifest(root):
    """Bootstrap the reviewed instrument before importing its Python code."""
    root = Path(root).resolve()
    require(root.is_dir(), "frozen input directory missing")
    result = {}
    for directory, names, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(names):
            path = parent / name
            if name in {".git", "node_modules", "__pycache__"}:
                names.remove(name)
            else:
                require(not path.is_symlink() and not path.is_junction(), "linked frozen input")
        for name in files:
            path = parent / name
            require(not path.is_symlink() and not path.is_junction(), "linked frozen input")
            result[path.relative_to(root).as_posix()] = file_hash(path)
    return dict(sorted(result.items()))


def validate_original(plan, summary, closure):
    # original_inputs authenticates the exact base plan before calling this
    # separate semantic guard (also exercised with labelled synthetic fixtures).
    require(plan["sourceRevision"] == SOURCE and plan["sourceDirty"] is False,
            "original product source changed")
    require(plan["order"] == ["vector", "codex"] and plan["maxCalls"] == 300
            and plan["maxSeconds"] == 7200 and plan["softUsd"] == 13.84808545,
            "original bounds or order changed")
    require(summary.get("kind") == "heavy-native-team-pair-result-v1"
            and summary.get("planSha256") == ORIGINAL_PLAN_SHA
            and summary.get("sourceRevision") == SOURCE
            and summary.get("profileSha256") == plan["profileSha256"]
            and summary.get("fundingPhase") == plan["fundingPhase"]
            and summary.get("fundingAuthorizationPlanSha256") == plan["fundingAuthorizationPlanSha256"],
            "original summary provenance changed")
    require(summary.get("pairCompleted") is False and summary.get("productGateMet") is False
            and summary.get("qualityComparisonMet") is False and summary.get("efficiencyClaimMet") is False
            and summary.get("allChargesRetained") is True and summary.get("historicalAmountsReset") is False,
            "original failure or charges cannot be relabelled")
    require(set(summary.get("arms", {})) == {"vector", "codex"}, "original pair arm set changed")
    require(summary["arms"]["codex"] == {"runtime": "codex", "notRun": True,
            "stopReason": "not_run_after_prior_arm_review", "functionalVerdict": "not_run", "nativeAuditVerdict": "not_run"},
            "Codex was already attempted or original not-run disposition changed")
    vector = summary["arms"]["vector"]
    require(vector.get("runtime") == "vector" and vector.get("providerRequests") == 300
            and math.isclose(vector.get("measuredUsd", -1), 6.7876388, abs_tol=1e-8, rel_tol=0)
            and vector.get("functionalVerdict") == "product_failure" and vector.get("nativeAuditVerdict") == "review_required"
            and vector.get("reviewRequired") is True and vector.get("settlementComplete") is True
            and vector.get("stopReason") == "admission_policy_or_state_failure",
            "original stopped Vector outcome changed")
    require(vector.get("closure") == closure and closure.get("settlementComplete") is True
            and closure.get("usageAccountingStatus") == "settled_and_receipts_reconciled"
            and closure.get("runtimeQuiesced") is True and closure.get("providerRequests") == 300
            and isinstance(closure.get("transcripts"), dict)
            and closure.get("transcripts", {}).get("complete") is True
            and closure.get("transcripts", {}).get("sessionCount") == 7,
            "Vector settlement or quiescence is unknown")
    attempts = vector.get("attempts", [])
    require(len(attempts) == 2 and [row.get("index") for row in attempts] == [1, 2]
            and all(row.get("artifact") == {"fileCount": 39, "manifestSha256": SNAPSHOT_SHA,
                    "protectedViolations": []} and row.get("process", {}).get("ownedTreeQuiesced") is True for row in attempts),
            "original Vector snapshot or invocation history changed")


def validate_baseline(state, healthy, phase):
    healthy(state, idle=True, funding_profile=phase)
    require(state.get("batchCallsRemaining") == 0, "another scope is open")
    require(state.get("attempts") == BASELINE["attempts"]
            and math.isclose(state["measuredUsd"], BASELINE["measuredUsd"], abs_tol=1e-8, rel_tol=0),
            "funding changed since original Vector closure")
    for actor in ("foundry-vector", "foundry-codex"):
        require(math.isclose(state["actors"][actor]["measuredUsd"], BASELINE[actor], abs_tol=1e-8, rel_tol=0),
                "Codex already attempted or prior actor history changed")
    return state


class CodexOnlyController:
    """One mutation admission; status is rechecked immediately before it."""
    def __init__(self, controller, healthy, phase, label):
        self.controller, self.healthy, self.phase, self.label = controller, healthy, phase, label
        self.admission_attempted = False

    def __call__(self, route, body=None):
        require(route in ("/status", "/control", "/disarm"), "unknown continuation controller route")
        if route == "/control":
            require(not self.admission_attempted and body == {"actor": "foundry-codex", "label": self.label, "calls": 300},
                    "only the once-unrun original Codex arm may be admitted")
            validate_baseline(self.controller("/status"), self.healthy, self.phase)
            self.admission_attempted = True
        response = self.controller(route, body)
        if route == "/status" and not self.admission_attempted:
            validate_baseline(response, self.healthy, self.phase)
        return response


def frozen_instrument(options, plan):
    require(manifest(options.team_runner_root) == plan["teamInstrumentFiles"], "frozen matched instrument changed")
    common_root = Path(plan["frozenPaths"]["common_runner_root"]).resolve()
    require(manifest(common_root) == plan["commonInstrumentFiles"], "frozen common instrument changed")
    sys.path.insert(0, str(options.team_runner_root))
    heavy = importlib.import_module("heavy_runner")
    team = importlib.import_module("paired_runner")
    witness = importlib.import_module("owned_team_witness")
    for module in (heavy, team, witness):
        require(Path(module.__file__).resolve().parent == options.team_runner_root, "cached instrument root mismatch")
    common = team.common_helpers(common_root)
    return heavy, team, witness, common


def original_inputs(options):
    plan = json.loads(options.original_plan.read_text(encoding="utf-8"))
    require(digest(plan) == ORIGINAL_PLAN_SHA, "unreviewed original pair plan")
    original = options.original_plan.parent
    require(not (original / "codex").exists(), "original Codex runtime was already prepared")
    for relative, checksum in ORIGINAL_FILES.items():
        require(file_hash(original / relative) == checksum, "original result evidence changed")
    summary = json.loads((original / "summary.json").read_text(encoding="utf-8"))
    closure = json.loads((original / "vector/closure.json").read_text(encoding="utf-8"))
    validate_original(plan, summary, closure)
    audit = [json.loads(line) for line in (original / "vector/witness-audit.jsonl").read_text(encoding="utf-8").splitlines()]
    previous = None
    for sequence, row in enumerate(audit, 1):
        require(row.get("sequence") == sequence and row.get("previousSha256") == previous, "Vector audit chain changed")
        previous = digest(row)
    require(audit[-1].get("type") == "owned_scope_closed" and audit[-1].get("providerRequests") == 300
            and audit[-1].get("transcriptCoverageComplete") is True, "Vector audit has no final known closure")
    for index in (1, 2):
        expected = json.loads((original / f"vector/attempts/{index}/source-manifest.json").read_text(encoding="utf-8"))
        require(len(expected) == 39 and digest(expected) == SNAPSHOT_SHA
                and manifest(original / f"vector/attempts/{index}/source") == expected, "Vector source snapshot changed")
    return plan, summary


def runtime_options(options, plan, heavy):
    values = {key: Path(value).resolve() for key, value in plan["frozenPaths"].items()}
    values.update(out=options.out, provider_base=plan["providerBase"], label=plan["label"], app_port=plan["appPort"],
                  max_calls=300, max_seconds=7200, soft_usd=plan["softUsd"])
    return heavy.prepare_options(SimpleNamespace(**values))


def evaluation_overlay(options, original):
    supplied = [options.evaluation_overlay, options.overlay_manifest, options.expected_overlay_sha]
    require(all(supplied) or not any(supplied), "overlay path, reviewed manifest and digest must be explicit together")
    if not any(supplied):
        return None
    reviewed = json.loads(options.overlay_manifest.read_text(encoding="utf-8"))
    require(isinstance(reviewed, dict) and digest(reviewed) == options.expected_overlay_sha,
            "reviewed evaluator overlay manifest digest changed")
    require(manifest(options.evaluation_overlay) == reviewed, "evaluator overlay files changed")
    base = original["taskFiles"]
    additions = {"overlay-provenance.json", "helper.diff", "project-navigation-control.cjs", "test_overlay.py", "OVERLAY.md"}
    if ".gitattributes" not in base:
        additions.add(".gitattributes")
    require(set(reviewed) == set(base) | additions, "overlay file inventory changed")
    require([name for name in sorted(base) if reviewed[name] != base[name]] == ["instrument/browser-eval.cjs"],
            "overlay changed prompt, seed, wrapper or another original requirement")
    provenance = json.loads((options.evaluation_overlay / "overlay-provenance.json").read_text(encoding="utf-8"))
    require(provenance.get("kind") == "foundry-navigation-overlay-v2"
            and provenance.get("baseTaskRevision") == "8ce4af881b98aaef2d73979073910f5a538c4f31"
            and provenance.get("originalTaskManifestSha256") == digest(base), "overlay base provenance changed")
    return {"kind": "foundry-navigation-overlay-v2", "root": str(options.evaluation_overlay),
            "reviewedManifestPath": str(options.overlay_manifest), "manifestSha256": digest(reviewed),
            "files": reviewed, "changedFiles": ["instrument/browser-eval.cjs"],
            "promptSeedAndTaskContractUnchanged": True, "originalEvaluationRetained": True,
            "knownOldFalseFeedbackConfound": "Vector formal repair received original navigation checker failures; original attempt snapshots identical; original outcome unchanged"}


def build_plan(options):
    original, summary = original_inputs(options)
    heavy, team, witness, common = frozen_instrument(options, original)
    runtime = runtime_options(options, original, heavy)
    require(heavy.build_plan(runtime, common) == original, "original source/task/profile/binary freeze changed")
    overlay = evaluation_overlay(options, original)
    roots = [runtime.vector_root, runtime.task_dir, runtime.common_runner_root, runtime.browser_driver_root,
             options.team_runner_root, Path(__file__).resolve().parents[3], options.original_plan.parent]
    if overlay:
        roots.append(options.evaluation_overlay)
    team.checked_path(options.out, roots)
    require(not options.out.is_relative_to(options.original_plan.parent), "original output cannot be changed")
    return ({"kind": "heavy-missing-codex-continuation-plan-v1", "originalPlanSha256": ORIGINAL_PLAN_SHA,
             "originalEvidenceSha256": ORIGINAL_FILES, "originalSourceRevision": SOURCE,
             "originalOutput": str(options.original_plan.parent), "originalPlanPath": str(options.original_plan),
             "teamRunnerRoot": str(options.team_runner_root), "newOutput": str(options.out),
             "continuationInstrumentRoot": str(Path(__file__).resolve().parent),
             "continuationInstrumentFiles": manifest(Path(__file__).resolve().parent),
             "runtime": "codex", "vectorRerunAllowed": False, "originalReviewFlagsRetained": True,
             "explicitPriorArmReviewContinuation": True, "originalPairRemainsIncomplete": True,
             "evaluationOverlay": overlay,
             "profileSha256": original["profileSha256"], "fundingPhase": original["fundingPhase"],
             "fundingAuthorizationPlanSha256": original["fundingAuthorizationPlanSha256"],
             "cumulativeActorCapsUsd": original["cumulativeActorCapsUsd"], "studyHardCapUsd": 48,
             "requiredExactPreAdmissionBaseline": BASELINE, "monetaryRoundoffToleranceUsd": 1e-8,
             "maxCalls": 300, "maxSeconds": 7200, "maxSameSessionRepairs": 1, "softUsd": original["softUsd"],
             "armAdmissionReservationUsd": 5.73, "nativeAutonomousIdentities": 7,
             "controllerOrCredentialFilesReadByPlan": False, "automaticNextPair": False,
             "qualityComparisonMet": False, "efficiencyClaimMet": False},
            original, summary, runtime, heavy, team, witness, common)


def run_codex(plan, original, summary, *, supervisor, adapter, common, team, profile, check_frozen, persist):
    """Preserve all original Vector evidence; dispatch exactly one Codex arm."""
    result = {"kind": "heavy-missing-codex-continuation-result-v1", "continuationPlanSha256": digest(plan),
              "originalPlanSha256": ORIGINAL_PLAN_SHA, "originalSummarySha256": ORIGINAL_FILES["summary.json"],
              "evaluationOverlay": copy.deepcopy(plan.get("evaluationOverlay")),
              "originalPairRemainsIncomplete": True, "priorReviewFlagsWaived": False,
              "arms": {"vector": copy.deepcopy(summary["arms"]["vector"])},
              "vectorRerun": False, "historicalAmountsReset": False, "allChargesRetained": True,
              "automaticNextPair": False, "pairCompleted": False, "productGateMet": False,
              "blindedCodeReviewVerdict": "pending_external_review", "qualityComparisonMet": False,
              "efficiencyClaimMet": False, "disposition": "prior_vector_failure_retained_codex_continuation_pending"}
    persist(result)
    result["arms"]["codex"] = team.coordinate_team_arm(supervisor=supervisor, runtime="codex",
        label=original["label"] + "-codex", adapter=adapter, task=original["task"], common=common,
        check_frozen=check_frozen, persist=lambda arm: (result["arms"].__setitem__("codex", copy.deepcopy(arm)), persist(result)),
        max_calls=300, seconds=7200, soft_usd=original["softUsd"], profile=profile)
    codex = result["arms"]["codex"]
    result["codexContinuationSettled"] = codex.get("settlementComplete") is True
    result["codexReviewRequired"] = codex.get("reviewRequired", True)
    result["disposition"] = "original_incomplete_pair_retained_separate_codex_arm_requires_review"
    persist(result)
    return result


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("original-plan", "team-runner-root", "out", "write-plan", "reviewed-plan", "controller-config", "receipt-jsonl"):
        result.add_argument("--" + name, type=Path, required=name in {"original-plan", "team-runner-root", "out"})
    result.add_argument("--expected-continuation-sha")
    result.add_argument("--evaluation-overlay", type=Path)
    result.add_argument("--overlay-manifest", type=Path)
    result.add_argument("--expected-overlay-sha")
    result.add_argument("--run", action="store_true")
    return result


def main(argv=None):
    options = parser().parse_args(argv)
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    plan, original, summary, runtime, heavy, team, witness, common = build_plan(options)
    if not options.run:
        if options.write_plan:
            roots = [options.original_plan.parent, options.team_runner_root,
                runtime.vector_root, runtime.task_dir, runtime.common_runner_root, runtime.browser_driver_root,
                Path(__file__).resolve().parents[3]]
            if options.evaluation_overlay:
                roots.append(options.evaluation_overlay)
            team.checked_path(options.write_plan, roots)
            common.save(options.write_plan, plan)
        print(json.dumps({"plan": plan, "planSha256": digest(plan), "paidExecutionRequested": False}, indent=2))
        return 0
    require(options.reviewed_plan is not None and options.expected_continuation_sha is not None,
            "run requires exact reviewed continuation plan and digest")
    require(plan == json.loads(options.reviewed_plan.read_text(encoding="utf-8"))
            and digest(plan) == options.expected_continuation_sha, "continuation freeze changed")
    require(options.controller_config is not None and options.receipt_jsonl is not None,
            "explicit private controller capability and immutable receipts required")
    config = json.loads(options.controller_config.read_text(encoding="utf-8"))
    require(isinstance(config.get("localToken"), str) and config["localToken"], "existing local controller capability missing")
    controller = CodexOnlyController(common.Controller(runtime.provider_base, config["localToken"]),
        witness.healthy, heavy.FUNDING.phase, original["label"] + "-codex")
    validate_baseline(controller("/status"), witness.healthy, heavy.FUNDING.phase)
    require(team.affordability(controller("/status"), "codex", funding_profile=heavy.FUNDING.phase)["affordable"],
            "full-quality Codex reservation unavailable")
    options.out.mkdir(parents=True)
    common.save(options.out / "continuation-plan.json", plan)
    def receipts():
        with options.receipt_jsonl.open("r", encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
    holder = {}
    supervisor = witness.OwnedSupervisor(controller, receipts, options.out, funding_profile=heavy.FUNDING.phase,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    supervisor.used.add("vector")
    actual_runtime = copy.copy(runtime)
    if plan["evaluationOverlay"]:
        actual_runtime.selected_task_root = options.evaluation_overlay
        actual_runtime.task_dir = options.evaluation_overlay
        actual_runtime.task_root = options.evaluation_overlay.parent
    # Its copied task, seed, prompt and command are byte-identical; only the
    # explicitly reviewed browser checker helper changes for this evaluation.
    adapter = team.NativeAdapter("codex", actual_runtime, common, original["task"], holder)
    holder["adapter"] = adapter
    def check_frozen():
        # The new output exists once admitted; check original freeze without the
        # planning-only new-directory test, and retain the exact helper bytes.
        current, current_summary = original_inputs(options)
        require(current == original and current_summary == summary
                and heavy.build_plan(runtime, common) == original
                and evaluation_overlay(options, original) == plan["evaluationOverlay"]
                and manifest(Path(__file__).resolve().parent) == plan["continuationInstrumentFiles"],
                "original or continuation freeze changed")
    result = run_codex(plan, original, summary, supervisor=supervisor, adapter=adapter, common=common,
        team=team, profile=heavy.PROFILE, check_frozen=check_frozen,
        persist=lambda value: common.save(options.out / "summary.json", value))
    arm = result["arms"]["codex"]
    print(json.dumps({"originalPairRemainsIncomplete": True, "vectorRerun": False,
        "codex": {key: arm.get(key) for key in ("stopReason", "providerRequests", "measuredUsd", "settlementComplete", "reviewRequired")}}, indent=2))
    return 0 if arm.get("settlementComplete") is True and arm.get("reviewRequired") is False and arm.get("functionalVerdict") == "passed" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"errorType": type(error).__name__, "automaticRetry": False, "automaticNextPair": False}), file=sys.stderr)
        raise SystemExit(2)
