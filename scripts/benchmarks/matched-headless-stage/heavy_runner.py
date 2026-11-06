"""One separately labelled heavy native-team pair. PLAN ONLY without --run.

The old four-role study remains a separate default profile. This entry point
does not load credentials, receipts, a runtime or a browser while planning.
"""
import argparse
import copy
import json
from pathlib import Path
import re
import sys

from funding_profiles import HEAVY_PHASE, funding_policy
from native_team_policy import MODEL, PolicyError, require
from owned_team_witness import OwnedSupervisor, digest
from role_graph import HEAVY_ROLES, HEAVY_ROLE_PARENTS
import paired_runner as common_team

FUNDING = funding_policy(HEAVY_PHASE)
COMMON = common_team.COMMON.replace("TASK.md", "BUILD_SPEC.md")
INSTRUCTIONS = {
    "lead": COMMON + (
        "Build the complete connected application using exactly this fixed native team. Start one backend_coordinator "
        "and one frontend_worker with nonoverlapping file ownership. The coordinator alone starts exactly one backend_api "
        "and one backend_data child and integrates their work; those two are its children, not your direct children. "
        "You own root build/configuration and cross-stack integration. Agree API/data/UI boundaries before edits. "
        "After the coordinator, both nested leaves and frontend finish, start one qa_specialist. After QA finishes, "
        "start one team_judge to review the whole implementation and QA evidence. Correct every material issue, then "
        "personally verify the final API and UI using the common browser client. Reuse the same six native child "
        "identities for every follow-up; never replace them, add roles or exceed depth two. After any formal repair, "
        "have the same QA specialist recheck the final state and the same judge review it before your final verification. "
        "Preserve all quality, images, verification and requirements even when budget is limited. Report incomplete work candidly."
    ),
    "backend_coordinator": COMMON + (
        "You are the fixed backend coordinator. Own backend integration/entrypoint files assigned by the lead. "
        "Before edits agree nonoverlapping ownership, then start exactly one backend_api and one backend_data child. "
        "Give the API child transport/routes/validation ownership and the data child schema/authentication/persistence "
        "ownership. Retain shared backend integration files yourself. Wait for both leaves, integrate their actual code, "
        "verify the complete backend and only then finish. Reuse their same native identities for follow-ups. "
        "Do not start any other role or nest below those leaves. Coordinate frontend interfaces through the lead."
    ),
    "backend_api": COMMON + (
        "You are the coordinator's fixed backend API leaf. Own only its assigned transport/routes/validation files. "
        "Agree contracts with the coordinator and data leaf before edits. Implement and test all assigned requirements, "
        "report evidence and gaps, and do not delegate or edit another worker's files."
    ),
    "backend_data": COMMON + (
        "You are the coordinator's fixed backend data leaf. Own only its assigned schema/authentication/persistence files. "
        "Preserve durability, authorization and transactional requirements. Coordinate contracts before edits, implement "
        "and test your complete assignment, report evidence and gaps, and do not delegate or edit another worker's files."
    ),
    "frontend_worker": COMMON + (
        "You are the fixed frontend worker. Own only UI/client/style files assigned by the lead. Agree the complete "
        "API contract before edits. Build every connected user workflow with accessible, polished states, verify browser "
        "behavior through the common client, and report evidence and material gaps. Do not delegate or edit backend/shared files."
    ),
    "qa_specialist": COMMON + (
        "You are the fixed independent QA specialist. Begin only after backend coordinator/leaves and frontend finish. "
        "Inspect the complete public BUILD_SPEC.md and actual implementation. Exercise connected API and browser workflows, "
        "negative cases, authentication boundaries, persistence/restart and regressions. You may author dedicated verification "
        "tests in files assigned by the lead, but do not alter product code or the independent evaluator. Report concrete "
        "reproductions and evidence; do not waive requirements. Recheck the final state on follow-up and do not delegate."
    ),
    "team_judge": COMMON + (
        "You are the fixed independent code/research judge. Begin only after all implementation and QA roles finish. "
        "Review the actual connected product and QA evidence for correctness, durability, security, accessibility and "
        "missing verification. Identify material issues and concrete reproductions for the lead to correct. Do not edit "
        "the product/evaluator, silently waive requirements, or delegate. Review the final repaired state on follow-up."
    ),
}
PROFILE = {
    "model": MODEL, "reasoning": "high", "reasoningSummary": "auto", "verbosity": "low",
    "contextLimit": 1050000, "outputCeiling": 32000, "nativeAutonomousIdentities": 7,
    "childLifetimeSlots": list(HEAVY_ROLES), "roleParents": HEAVY_ROLE_PARENTS, "maxDepth": 2,
    "reviewedRoles": [role for role in HEAVY_ROLES if role != "team_judge"],
    "creationAfter": {"qa_specialist": ["backend_coordinator", "backend_api", "backend_data", "frontend_worker"]},
    "completionAfter": {"backend_coordinator": ["backend_api", "backend_data"]},
    "specialistInputs": ["backend_coordinator", "backend_api", "backend_data", "frontend_worker"],
    "maxSameSessionRepairs": 1, "maxProviderRequestsPerArm": 300, "maxAgentSecondsPerArm": 7200,
    "repairAdmissionThresholdUsdPerArm": FUNDING.repair_threshold_usd,
    "sameIdentityFollowupsAllowed": True, "allHelpersAndRepairsBilled": True, "instructions": INSTRUCTIONS,
}


def load_task(root, common):
    """Closed qualified Foundry contract; no fallback to arbitrary evaluator code."""
    task = json.loads(common.inside(root, "task.json").read_text(encoding="utf-8"))
    require(task.get("name") == "foundry-heavy" and task.get("workspacePromptFile") == "BUILD_SPEC.md",
            "unreviewed heavy task identity")
    require(task.get("promptFile") == "instrument/BUILD_SPEC.md" and task.get("seedDirectory") == "instrument/seed",
            "qualified prompt/seed contract changed")
    require([task.get(key) for key in ("expectedApiGroups", "expectedBrowserChecks", "expectedPrerequisiteChecks", "expectedTotalChecks")] == [32, 40, 4, 76],
            "qualified heavy checks changed")
    require(task.get("evaluatorTimeoutSeconds") == 1500 and task.get("evaluatorReport") == "evaluation.json",
            "qualified evaluator bounds changed")
    require(task.get("protectedFiles") == ["bun.lock"] and task.get("generatedDirectories") == ["dist"],
            "qualified source integrity contract changed")
    require(task.get("setupCommand") == ["{bun}", "--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"],
            "qualified dependency setup changed")
    require(task.get("evaluatorCommand") == ["{python}", "{task}/evaluate.py", "--app", "{app}", "--out", "{out}",
            "--bun", "{bun}", "--node", "{node}", "--playwright-module", "{playwright_module}", "--chrome", "{chrome}"],
            "qualified explicit evaluator command changed")
    require(common.inside(root, task["promptFile"]).is_file() and common.inside(root, task["seedDirectory"]).is_dir(),
            "qualified prompt or seed missing")
    require(common.inside(root, task["seedDirectory"] + "/bun.lock").is_file(), "protected lockfile missing")
    require(not common.inside(root, task["seedDirectory"] + "/dist").exists(), "generated path overlaps seed")
    return task


def build_plan(options, common):
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,45}", options.label), "invalid synthetic label")
    require(1 <= options.max_calls <= 300 and 0 < options.max_seconds <= 7200
            and options.soft_usd == FUNDING.repair_threshold_usd, "closed heavy execution bounds changed")
    require(1 <= options.app_port <= 65535, "explicit loopback app PORT required")
    source, dirty = common.source_revision(options.vector_root)
    task = load_task(options.task_dir, common)
    browser_files = common.manifest(options.browser_driver_root)
    common_team.validate_task_commands(task, options.task_dir, options, common, browser_files, extra_bindings=True)
    binaries = {name: common.file_hash(getattr(options, name)) for name in ("bun", "node", "codex_bin", "chrome")}
    binaries["python"] = common.file_hash(Path(sys.executable))
    binaries["playwright_package"] = common.file_hash(options.playwright_module / "package.json")
    paths = {name: str(getattr(options, name)) for name in ("vector_root", "common_runner_root", "task_dir",
        "browser_driver_root", "bun", "node", "codex_bin", "chrome", "playwright_module")}
    return {"kind": "heavy-native-team-pair-plan-v1", "label": options.label, "order": ["vector", "codex"],
            "classification": "heavy application development replication; previously observed task; no held-out claim",
            "sourceRevision": source, "sourceDirty": dirty, "task": task, "taskFiles": common.manifest(options.task_dir),
            "profile": PROFILE, "profileSha256": digest(PROFILE), "fundingPhase": FUNDING.phase,
            "fundingAuthorizationPlanSha256": FUNDING.plan_sha256, "studyHardCapUsd": 48,
            "cumulativeActorCapsUsd": dict(FUNDING.actor_caps), "historicalMinimumRequests": 889,
            "historicalMinimumUsd": 20.3038291, "historicalAmountsReset": False, "allPriorChargesRetained": True,
            "maxCalls": options.max_calls, "maxSeconds": options.max_seconds, "softUsd": options.soft_usd,
            "softDollarPolicy": "settled formal-repair admission only; no intra-invocation dollar stop",
            "armAdmissionReservationUsd": common_team.FULL_RESERVATION_USD,
            "providerBase": common.validate_base(options.provider_base), "appPort": options.app_port, "frozenPaths": paths,
            "teamInstrumentFiles": common.manifest(Path(__file__).resolve().parent),
            "commonInstrumentFiles": common.manifest(options.common_runner_root), "browserDriverFiles": browser_files,
            "binarySha256": binaries, "browserAccessMode": "shared-client", "operatingSystemSandbox": False,
            "witnessInflightLimit": 1, "timingScope": "serialized inference witness shared by both arms; not production team throughput",
            "nativeHarnessModes": {"vector": {"size": "thorough", "judge": "off", "nativeDollarCap": None},
                "codex": {"multiAgent": True, "maxChildThreads": 6, "codeModePreserved": True, "nativeDollarCap": None}},
            "qualityPolicy": "all 76 checks, bounded native execution audit, then separate blinded 48-point review; no lower Vector task score or established critical regression",
            "automaticNextPair": False, "controllerOrCredentialFilesReadByPlan": False, "privateOutputsMustNotEnterGit": True}


def run_pair(plan, *, supervisor, adapter_factory, common, check_frozen, persist):
    result = {"kind": "heavy-native-team-pair-result-v1", "classification": plan["classification"],
              "sourceRevision": plan["sourceRevision"], "planSha256": digest(plan), "profileSha256": digest(PROFILE),
              "fundingPhase": FUNDING.phase, "fundingAuthorizationPlanSha256": FUNDING.plan_sha256,
              "order": plan["order"], "arms": {}, "automaticNextPair": False, "allChargesRetained": True,
              "historicalAmountsReset": False, "blindedCodeReviewVerdict": "pending_external_review",
              "qualityComparisonMet": False, "efficiencyClaimMet": False}
    for runtime in plan["order"]:
        arm = common_team.coordinate_team_arm(supervisor=supervisor, runtime=runtime,
            label=plan["label"] + "-" + runtime, adapter=adapter_factory(runtime), task=plan["task"], common=common,
            check_frozen=check_frozen, persist=lambda value, name=runtime: (
                result["arms"].__setitem__(name, copy.deepcopy(value)), persist(result)),
            max_calls=plan["maxCalls"], seconds=plan["maxSeconds"], soft_usd=plan["softUsd"], profile=PROFILE)
        result["arms"][runtime] = arm
        persist(result)
        if arm["reviewRequired"] or not arm["settlementComplete"]:
            break
    for runtime in plan["order"]:
        if runtime not in result["arms"]:
            result["arms"][runtime] = {"runtime": runtime, "notRun": True, "stopReason": "not_run_after_prior_arm_review",
                                       "functionalVerdict": "not_run", "nativeAuditVerdict": "not_run"}
    attempted = [arm for arm in result["arms"].values() if not arm.get("notRun")]
    result["pairCompleted"] = len(attempted) == 2 and all(arm["settlementComplete"] and not arm["reviewRequired"] for arm in attempted)
    result["productGateMet"] = result["pairCompleted"] and all(arm["functionalVerdict"] == "passed" for arm in attempted)
    result["disposition"] = "completed_development_pair_pending_blind_review" if result["pairCompleted"] else "incomplete_no_selected_arm_efficiency_claim"
    persist(result)
    return result


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("vector-root", "common-runner-root", "task-dir", "browser-driver-root", "bun", "node", "codex-bin", "chrome", "playwright-module", "out"):
        result.add_argument("--" + name, type=Path, required=True)
    result.add_argument("--provider-base", default="http://127.0.0.1:23128")
    result.add_argument("--label", required=True)
    result.add_argument("--app-port", type=int, default=4123)
    result.add_argument("--max-calls", type=int, default=300)
    result.add_argument("--max-seconds", type=float, default=7200)
    result.add_argument("--soft-usd", type=float, default=FUNDING.repair_threshold_usd)
    for name in ("write-plan", "reviewed-plan", "controller-config", "receipt-jsonl"):
        result.add_argument("--" + name, type=Path)
    result.add_argument("--expected-plan-sha")
    result.add_argument("--expected-source")
    result.add_argument("--run", action="store_true")
    return result


def prepare_options(options):
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    options.browser_access_mode = "shared-client"
    options.selected_task_root, options.task_root, options.task_index = options.task_dir, options.task_dir.parent, 1
    options.team_profile = PROFILE
    return options


def main(argv=None):
    options = prepare_options(parser().parse_args(argv))
    common = common_team.common_helpers(options.common_runner_root)
    plan = build_plan(options, common)
    if not options.run:
        if options.write_plan:
            common.save(options.write_plan, plan)
        print(json.dumps({"plan": plan, "planSha256": digest(plan), "paidExecutionRequested": False}, indent=2))
        return 0
    common_team.reviewed(plan, options)
    require(options.controller_config is not None and options.receipt_jsonl is not None,
            "explicit private controller and receipt paths required")
    common_team.checked_path(options.out, [options.vector_root, options.task_dir, options.common_runner_root,
        options.browser_driver_root, Path(__file__).resolve().parents[3]])
    options.out.mkdir(parents=True)
    common.save(options.out / "plan.json", plan)
    config = json.loads(options.controller_config.read_text(encoding="utf-8"))
    require(isinstance(config.get("localToken"), str) and config["localToken"], "existing controller capability missing")
    controller = common.Controller(options.provider_base, config["localToken"])
    def receipts():
        with options.receipt_jsonl.open("r", encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
    holder = {}
    supervisor = OwnedSupervisor(controller, receipts, options.out, funding_profile=HEAVY_PHASE,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    def adapter_factory(runtime):
        adapter = common_team.NativeAdapter(runtime, options, common, plan["task"], holder)
        holder["adapter"] = adapter
        return adapter
    result = run_pair(plan, supervisor=supervisor, adapter_factory=adapter_factory, common=common,
        check_frozen=lambda: require(build_plan(options, common) == plan, "heavy source/task/profile/runtime freeze changed"),
        persist=lambda value: common.save(options.out / "summary.json", value))
    print(json.dumps({"pairCompleted": result["pairCompleted"], "productGateMet": result["productGateMet"],
        "automaticNextPair": False, "arms": {name: {key: arm.get(key) for key in ("stopReason", "providerRequests", "measuredUsd", "reviewRequired", "settlementComplete")}
                                           for name, arm in result["arms"].items()}}, indent=2))
    return 0 if result["productGateMet"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PolicyError, ValueError, OSError) as error:
        print(json.dumps({"errorType": type(error).__name__, "automaticRetry": False, "automaticNextPair": False}), file=sys.stderr)
        raise SystemExit(2)
