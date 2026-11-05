"""Closed Harbor follow-up: plan only, then explicitly run one native arm.

Uses the reviewed native adapter, supervisor, financial policy and fixed seven
roles. No runtime, browser, controller or receipt is opened while planning.
Codex runs first. Vector requires an explicit review of its settled result.
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

CANDIDATE = "587be6478aff24e2cdf98192269bc2bd3ca755bd"
COUNTS = {"api": 28, "browser": 32, "prerequisite": 4, "total": 64}
QUALIFIED_SOURCE = "e4c04a7e174fc9d2980551c36cadfa5c2d295263db0a66a05e045c8902bf6663"
PROFILE_SHA256 = "6f70ed35534e60d66c832323bd5df78be68d20f22233c382c2b8633430bf194b"
PHASE_PLAN_SHA256 = "b91f3cfdd0738299f44ffa23e9a8850ca5751665a521859cf5c1fc2507ee0d5d"
QUALIFICATION_BLOB = "9849f5f80857e7a15f24cd2ba04f974d8a9a9dc6d1b8e3b00273b5a45f98c322"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def manifest(root):
    root = Path(root).resolve()
    require(root.is_dir(), "frozen input directory missing")
    files = {}
    for directory, names, leaves in os.walk(root, followlinks=False):
        for name in list(names):
            path = Path(directory) / name
            if name in {".git", "node_modules", "__pycache__"}:
                names.remove(name)
            else:
                require(not path.is_symlink() and not path.is_junction(), "linked frozen input")
        for name in leaves:
            path = Path(directory) / name
            require(not path.is_symlink() and not path.is_junction(), "linked frozen input")
            files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(files.items()))


def validate_qualification(value):
    require(value.get("kind") == "harbor-qualification-v1" and value.get("status") == "runtime_qualified"
            and value.get("runtimeQualified") is True and type(value.get("modelCalls")) is int
            and value["modelCalls"] == 0 and value.get("expectedChecks") == COUNTS,
            "runtime qualification is incomplete")
    positive, empty = value.get("positiveReference", {}), value.get("emptySeed", {})
    inventories = []
    for report, verdict in ((positive, "passed"), (empty, "product_failure")):
        rows = report.get("checks")
        require(report.get("verdict") == verdict and report.get("sourceIntegrityStatus") == "unchanged"
                and isinstance(rows, list) and len(rows) == 64
                and all(isinstance(row, dict) and isinstance(row.get("name"), str) for row in rows)
                and len({row["name"] for row in rows}) == 64, "qualification rows or source evidence changed")
        inventory = {row["name"]: row.get("category") for row in rows}
        inventories.append(inventory)
        counts = {category: {status: sum(row.get("category") == category and row.get("status") == status for row in rows)
                            for status in ("failed", "not_run", "passed")} for category in ("api", "browser", "prerequisite")}
        require(counts == report.get("summary"), "qualification summary contradicts rows")
        require(all(sum(counts[category].values()) == COUNTS[category] for category in counts), "qualification inventory changed")
    require(inventories[0] == inventories[1] and all(row["status"] == "passed" for row in positive["checks"]),
            "positive qualification has missing checks")
    require(all(row["status"] == ("not_run" if row["category"] != "prerequisite" else
                "passed" if row["name"] == "prerequisite:source_integrity" else "failed") for row in empty["checks"]),
            "empty scaffold qualification contains an application pass")
    controls = value.get("damagedReferenceControls")
    require(isinstance(controls, list) and len(controls) == 2, "negative qualification missing")
    expected = {"artifact-corruption": {"api:artifact_bytes_metadata", "browser:release_artifact_download"},
                "outside-origin-asset": {"browser:console_local_assets"}}
    require({row.get("name") for row in controls} == set(expected), "negative qualification identity changed")
    for row in controls:
        failures = row.get("observedFailures")
        require(type(row.get("instrumentErrors")) is int and row["instrumentErrors"] == 0
                and isinstance(failures, list) and len(failures) == len(set(failures))
                and set(failures) == expected[row["name"]] and row.get("expectedFailure") in failures,
                "damaged reference was not independently rejected")
        if row["name"] == "outside-origin-asset":
            require(type(row.get("deniedOriginRequests")) is int and row["deniedOriginRequests"] == 0,
                    "outside-origin negative escaped the blocker")
        counts = row.get("summary", {})
        for category in ("api", "browser", "prerequisite"):
            failed = sum(name.startswith(category + ":") for name in failures)
            require(counts.get(category) == {"failed": failed, "not_run": 0, "passed": COUNTS[category] - failed},
                    "negative qualification summary changed")


def load_task(root):
    task = json.loads((root / "task.json").read_text(encoding="utf-8"))
    require(task.get("name") == "harbor-heavy" and task.get("promptFile") == "BUILD_SPEC.md"
            and task.get("workspacePromptFile") == "BUILD_SPEC.md" and task.get("seedDirectory") == "seed",
            "unreviewed holdout identity")
    require([task.get(key) for key in ("expectedApiGroups", "expectedBrowserChecks", "expectedPrerequisiteChecks", "expectedTotalChecks")]
            == list(COUNTS.values()), "holdout inventory changed")
    require(task.get("evaluatorCommand") == ["{python}", "{task}/evaluate.py", "--app", "{app}", "--out", "{out}",
            "--bun", "{bun}", "--node", "{node}", "--playwright-module", "{playwright_module}", "--chrome", "{chrome}"]
            and task.get("evaluatorReport") == "evaluation.json" and task.get("evaluatorTimeoutSeconds") == 1200,
            "holdout evaluator command changed")
    require(task.get("protectedFiles") == ["bun.lock", "UI_CONTRACT.md"] and task.get("generatedDirectories") == ["dist"]
            and task.get("setupCommand") == ["{bun}", "--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"],
            "holdout source/setup contract changed")
    qualification = json.loads((root / "qualification.json").read_text(encoding="utf-8"))
    validate_qualification(qualification)
    freeze = json.loads((root / "runtime-freeze.json").read_text(encoding="utf-8"))
    files = manifest(root)
    require(freeze.get("kind") == "harbor-runtime-freeze-v1" and freeze.get("status") == "runtime_qualified"
            and digest(freeze.get("files")) == freeze.get("aggregateSha256") == QUALIFIED_SOURCE
            and qualification.get("sourceFreezeAggregateSha256") == QUALIFIED_SOURCE
            and files.get("qualification.json") == freeze.get("qualificationReportSha256") == QUALIFICATION_BLOB
            and set(files) == set(freeze["files"]) | {"qualification.json", "runtime-freeze.json"}
            and all(files[name] == checksum for name, checksum in freeze["files"].items()),
            "qualified source or evidence hash chain changed")
    seed = manifest(root / "seed")
    require(set(seed) == {".gitignore", "package.json", "tsconfig.json", "bun.lock", "UI_CONTRACT.md"}
            and (root / "UI_CONTRACT.md").read_bytes() == (root / "seed/UI_CONTRACT.md").read_bytes(),
            "empty seed or public contract changed")
    return task


def bootstrap(options):
    files = manifest(options.team_runner_root)
    require(digest(files) == options.expected_team_sha, "reviewed native instrument changed")
    require(digest(manifest(options.common_runner_root)) == options.expected_common_sha,
            "reviewed common instrument changed before import")
    require(digest(manifest(options.browser_driver_root)) == options.expected_browser_sha,
            "reviewed browser driver changed")
    sys.path.insert(0, str(options.team_runner_root))
    modules = [importlib.import_module(name) for name in ("heavy_runner", "paired_runner", "owned_team_witness")]
    require(all(Path(module.__file__).resolve().parent == options.team_runner_root for module in modules),
            "cached native instrument root mismatch")
    heavy, team, witness = modules
    return heavy, team, witness, team.common_helpers(options.common_runner_root)


def build_plan(options):
    require(digest(manifest(options.task_dir)) == options.expected_task_sha, "reviewed task changed")
    heavy, team, witness, common = bootstrap(options)
    task = load_task(options.task_dir)
    funding = witness.funding_policy(witness.ADDITIONAL_PHASE)
    require(funding.phase == "heavy-additional-20-v1" and funding.plan_sha256 == PHASE_PLAN_SHA256
            and funding.study_cap_usd == 55.309095 and funding.new_round_usd == 20
            and funding.historical_liability_usd == 5.73, "unreviewed additional funding phase")
    source, dirty = common.source_revision(options.vector_root)
    require(source == CANDIDATE and dirty is False, "follow-up candidate is not the frozen clean revision")
    require(options.provider_base == "http://127.0.0.1:23128" and 1 <= options.app_port <= 65535,
            "unreviewed provider route or application port")
    require(options.label == "heavy-harbor-02", "closed follow-up label changed")
    options.browser_access_mode = "shared-client"
    options.selected_task_root, options.task_root, options.task_index = options.task_dir, options.task_dir.parent, 1
    options.team_profile = heavy.PROFILE
    options.max_calls, options.max_seconds, options.soft_usd = 300, 7200, heavy.PROFILE["repairAdmissionThresholdUsdPerArm"]
    browser_files = common.manifest(options.browser_driver_root)
    team.validate_task_commands(task, options.task_dir, options, common, browser_files, extra_bindings=True)
    require(digest(heavy.PROFILE) == PROFILE_SHA256 and heavy.PROFILE["nativeAutonomousIdentities"] == 7 and heavy.PROFILE["maxDepth"] == 2
            and heavy.PROFILE["model"] == "gpt-6.1-sol" and heavy.PROFILE["reasoning"] == "high",
            "matched native profile changed")
    binaries = {name: common.file_hash(getattr(options, name)) for name in ("bun", "node", "codex_bin", "chrome")}
    binaries.update(python=common.file_hash(Path(sys.executable)),
                    playwright_package=common.file_hash(options.playwright_module / "package.json"))
    # This CLI version uses sibling executables for code mode and command execution.
    # Pin the package actually exercised by the free native proof, not only its front door.
    binaries["codex_package"] = {name: common.file_hash(options.codex_bin.parent / name) for name in
        ("codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe")}
    paths = {name: str(getattr(options, name)) for name in ("vector_root", "common_runner_root", "team_runner_root", "task_dir",
             "browser_driver_root", "bun", "node", "codex_bin", "chrome", "playwright_module")}
    plan = {"kind": "harbor-additional-team-plan-v1", "label": options.label, "order": ["codex", "vector"],
            "output": str(options.out),
            "sourceRevision": source, "sourceDirty": False, "task": task, "taskFiles": manifest(options.task_dir),
            "profile": heavy.PROFILE, "profileSha256": digest(heavy.PROFILE), "fundingPhase": funding.phase,
            "fundingAuthorizationPlanSha256": funding.plan_sha256, "studyHardCapUsd": funding.study_cap_usd,
            "newRoundHardCapUsd": funding.new_round_usd, "historicalLiabilityHeldUsd": funding.historical_liability_usd,
            "historicalUncertaintyRemains": True, "allHistoricalAdmissionsSettled": False,
            "cumulativeActorCapsUsd": dict(funding.actor_caps), "maxCalls": 300, "maxSeconds": 7200,
            "softUsd": options.soft_usd, "maxSameSessionRepairs": 1, "armAdmissionReservationUsd": 5.73,
            "providerBase": options.provider_base, "appPort": options.app_port, "frozenPaths": paths,
            "teamInstrumentFiles": manifest(options.team_runner_root), "commonInstrumentFiles": manifest(options.common_runner_root),
            "browserDriverFiles": browser_files, "entrypointFiles": manifest(Path(__file__).resolve().parent),
            "binarySha256": binaries, "automaticNextPair": False, "automaticNextArm": False,
            "historicalAmountsReset": False, "allChargesRetained": True,
            "controllerOrCredentialFilesReadByPlan": False, "qualityComparisonMet": False, "efficiencyClaimMet": False,
            "qualityPolicy": "all 64 checks, native execution review, then blinded 48-point code review; quality first",
            "methodologyChange": "same bounded layout diagnostics in the common browser driver for both arms",
            "timingScope": "serialized inference forwards for both arms; not unrestricted production throughput"}
    return plan, heavy, team, witness, common


def validate_predecessor(prior, plan, expected_sha):
    require(expected_sha is not None and digest(prior) == expected_sha,
            "Vector requires an explicit exact review of the prior Codex result")
    require(prior.get("kind") == "harbor-additional-team-arm-result-v1" and prior.get("runtime") == "codex"
            and prior.get("planSha256") == digest(plan), "prior result belongs to a different task, source or profile")
    require(prior.get("historicalUncertaintyRemains") is True and prior.get("allHistoricalAdmissionsSettled") is False
            and prior.get("historicalLiabilityHeldUsd") == 5.73 and prior.get("newRoundHardCapUsd") == 20,
            "prior result waived the protected historical liability")
    arm = prior.get("arm", {})
    closure = arm.get("closure", {})
    require(arm.get("runtime") == "codex" and closure.get("runtime") == "codex"
            and arm.get("allChargesRetained") is True and arm.get("historicalAmountsReset") is False
            and arm.get("settlementComplete") is True
            and closure.get("settlementComplete") is True and closure.get("allChargesRetained") is True
            and closure.get("runtimeQuiesced") is True
            and closure.get("usageAccountingStatus") == "settled_and_receipts_reconciled"
            and closure.get("transcripts", {}).get("complete") is True
            and closure.get("settlementScope") == "current_owned_arm_only"
            and closure.get("historicalUncertaintyRemains") is True
            and closure.get("allHistoricalAdmissionsSettled") is False
            and closure.get("historicalLiabilityUsd") == 5.73,
            "prior owned runtime or financial closure is uncertain")
    require(isinstance(arm.get("providerRequests"), int) and not isinstance(arm["providerRequests"], bool)
            and 0 < arm["providerRequests"] <= 300,
            "prior arm was not actually attempted")
    cost = arm.get("measuredUsd")
    require(isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0,
            "prior charge is unknown")
    for row in (closure, closure.get("controllerUsageThroughClosure", {}), arm.get("controllerUsageThroughClosure", {})):
        value = row.get("measuredUsd")
        require(row.get("providerRequests") == arm["providerRequests"] and type(row.get("providerRequests")) is int
                and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
                and math.isclose(value, cost, abs_tol=1e-8, rel_tol=0), "prior count or charge does not reconcile")
    attempts = arm.get("attempts")
    require(isinstance(attempts, list) and 1 <= len(attempts) <= 2
            and all(isinstance(row, dict) and row.get("index") == index
                    and row.get("process", {}).get("ownedTreeQuiesced") is True for index, row in enumerate(attempts, 1)),
            "prior invocation history is not known quiescent")
    require(prior.get("allChargesRetained") is True and prior.get("historicalAmountsReset") is False,
            "historical charges or flags changed")
    # Exact acknowledgement permits independent execution, not a retroactive pass.
    # The prior arm's original review/functional/native flags remain untouched.
    return {"priorSummarySha256": digest(prior), "priorReviewFlagsRetained": True,
            "priorReviewRequired": arm.get("reviewRequired", True), "explicitPriorReview": True}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("vector-root", "common-runner-root", "team-runner-root", "task-dir", "browser-driver-root",
                 "bun", "node", "codex-bin", "chrome", "playwright-module", "out"):
        result.add_argument("--" + name, type=Path, required=True)
    result.add_argument("--expected-team-sha", required=True)
    result.add_argument("--expected-common-sha", required=True)
    result.add_argument("--expected-browser-sha", required=True)
    result.add_argument("--expected-task-sha", required=True)
    result.add_argument("--label", default="heavy-harbor-02")
    result.add_argument("--provider-base", default="http://127.0.0.1:23128")
    result.add_argument("--app-port", type=int, default=4125)
    for name in ("write-plan", "reviewed-plan", "controller-config", "receipt-jsonl"):
        result.add_argument("--" + name, type=Path)
    result.add_argument("--expected-plan-sha")
    result.add_argument("--reviewed-prior-summary-sha")
    result.add_argument("--runtime", choices=("codex", "vector"))
    result.add_argument("--run", action="store_true")
    return result


def claim_result(path, value):
    # The exclusive result is also the irreversible local admission marker. A
    # crashed partial write blocks retries rather than reopening an unknown arm.
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def main(argv=None):
    options = parser().parse_args(argv)
    for name, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, name, value.resolve())
    plan, heavy, team, witness, common = build_plan(options)
    roots = [Path(value) for value in plan["frozenPaths"].values() if Path(value).is_dir()]
    roots.append(Path(__file__).resolve().parents[3])
    if not options.run:
        if options.write_plan:
            team.checked_path(options.write_plan, [*roots, options.out])
            common.save(options.write_plan, plan)
        print(json.dumps({"planSha256": digest(plan), "paidExecutionRequested": False,
                          "sourceRevision": CANDIDATE, "expectedChecks": COUNTS}, indent=2))
        return 0
    require(options.runtime is not None and options.reviewed_plan is not None and options.expected_plan_sha is not None,
            "run needs one explicit runtime and exact reviewed plan")
    require(plan == json.loads(options.reviewed_plan.read_text(encoding="utf-8")) and digest(plan) == options.expected_plan_sha,
            "reviewed freeze changed")
    require(options.controller_config is not None and options.receipt_jsonl is not None,
            "run requires explicit private controller and authoritative receipt paths")
    result_path = options.out / (options.runtime + "-result.json")
    prior_review = None
    if options.runtime == "codex":
        team.checked_path(options.out, roots)
        options.out.mkdir(parents=True)
        common.save(options.out / "plan.json", plan)
    else:
        require(options.out.is_dir() and not options.out.is_symlink()
                and json.loads((options.out / "plan.json").read_text(encoding="utf-8")) == plan,
                "prior pair output/freeze unavailable")
        prior = json.loads((options.out / "codex-result.json").read_text(encoding="utf-8"))
        prior_review = validate_predecessor(prior, plan, options.reviewed_prior_summary_sha)
    require(not result_path.exists() and not (options.out / options.runtime).exists(),
            "runtime was already attempted; never retry an admission")
    result = {"kind": "harbor-additional-team-arm-result-v1", "runtime": options.runtime, "planSha256": digest(plan),
              "sourceRevision": CANDIDATE, "priorReview": prior_review, "allChargesRetained": True,
              "historicalAmountsReset": False, "automaticNextArm": False, "automaticNextPair": False,
              "qualityComparisonMet": False, "efficiencyClaimMet": False, "arm": {"notRun": True},
              "historicalUncertaintyRemains": True, "historicalLiabilityHeldUsd": 5.73,
              "allHistoricalAdmissionsSettled": False, "newRoundHardCapUsd": 20}
    claim_result(result_path, result)
    config = json.loads(options.controller_config.read_text(encoding="utf-8"))
    require(isinstance(config.get("localToken"), str) and config["localToken"], "controller capability missing")
    controller = common.Controller(options.provider_base, config["localToken"])
    holder = {}
    def receipts():
        return [json.loads(line) for line in options.receipt_jsonl.read_text(encoding="utf-8").splitlines() if line.strip()]
    supervisor = witness.OwnedSupervisor(controller, receipts, options.out, funding_profile=witness.ADDITIONAL_PHASE,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    adapter = team.NativeAdapter(options.runtime, options, common, plan["task"], holder)
    holder["adapter"] = adapter
    def persist(arm):
        result["arm"] = copy.deepcopy(arm)
        common.save(result_path, result)
    arm = team.coordinate_team_arm(supervisor=supervisor, runtime=options.runtime, label=options.label + "-" + options.runtime,
        adapter=adapter, task=plan["task"], common=common,
        check_frozen=lambda: require(build_plan(options)[0] == plan, "follow-up freeze changed"),
        persist=persist, max_calls=300, seconds=7200, soft_usd=options.soft_usd, profile=heavy.PROFILE)
    print(json.dumps({"runtime": options.runtime, **{key: arm.get(key) for key in
        ("stopReason", "providerRequests", "measuredUsd", "functionalVerdict", "reviewRequired", "settlementComplete")}}, indent=2))
    return 0 if arm.get("settlementComplete") and arm.get("functionalVerdict") == "passed" and not arm.get("reviewRequired", True) else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"errorType": type(error).__name__, "automaticRetry": False, "automaticNextPair": False}), file=sys.stderr)
        raise SystemExit(2)
