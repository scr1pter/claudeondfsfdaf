"""Closed adoption of the stopped heavy Codex tree. PLAN ONLY without --run.

The old nine charges and failed turns remain evidence. Native home, app and
support paths are retained; new scope artifacts are separate. Planning neither
reads a controller capability/receipt ledger nor starts a native runtime.
"""
import argparse
from contextlib import closing
import copy
import importlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import time

import codex_arm

require = codex_arm.require
digest = codex_arm.digest
file_hash = codex_arm.file_hash
manifest = codex_arm.manifest
OLD_PLAN_SHA = "b945e5a5d4dbd6b074b47b4099e1df2952047bb0e8ec93e2bd2bd86c5b994189"
OLD_FILES = {
    "continuation-plan.json": "3b0dbe3f18fbedcb720c37414a1b69b869b34b22773ed9b1accbd8268332d02f",
    "summary.json": "3efe452a46899c69194ab5e57bfff7f1fc77499dc966b27a3d52df8613900db6",
    "codex/closure.json": "e0602ddb2ecec8306d3e9eafadd26a066704757386595e495ddeb8e9f3056642",
    "codex/witness-audit.jsonl": "dc5737889010b7b2bd00416fbda29292ee1c259ecceb93e3dc61a2a4aace3cce",
    "codex/attempts/1/source-manifest.json": "8267bffe5b2acaeb88ff31115f6c73d0dd1b9a6e1598a18fe2cbabad3083476f",
}
IDENTITIES = {
    "lead": "12950002db2dbfa71b796ce6cb26fed9672cfbe44d16c12f322b7ef06fd0de4d",
    "backend_coordinator": "47be2242ef4cb01938da988dae13d6ea41ada64587df3d2ec9bfb966f517adb5",
    "frontend_worker": "e19c667b3a69fef79f4bf4fcbbd519b87187423780816271247258e70034687b",
}
OLD_CALLS, OLD_USD, OLD_ACTIVE_MS = 9, .1423925, 37656
NEW_CALLS, NEW_SECONDS = 291, 7162.344
SOFT_USD = 13.84808545
BASELINE = {"attempts": 1198, "measuredUsd": 27.2338604,
            "foundry-vector": 17.6761006, "foundry-codex": 6.6139917}
ROLES = ("backend_coordinator", "backend_api", "backend_data", "frontend_worker", "qa_specialist", "team_judge")


def exact_tree(root):
    """Archive inventory includes dependencies, caches and SQLite sidecars."""
    root = Path(root)
    require(root.is_dir() and not root.is_symlink() and not root.is_junction(), "owned archive root missing or linked")
    root = root.resolve()
    files = {}
    for directory, names, leaves in os.walk(root, followlinks=False):
        for name in [*names, *leaves]:
            path = Path(directory) / name
            require(not path.is_symlink() and not path.is_junction(), "owned archive contains a link")
        for name in leaves:
            path = Path(directory) / name
            files[path.relative_to(root).as_posix()] = file_hash(path)
    return dict(sorted(files.items()))


def validate_old_arm(summary, closure, snapshot):
    arm = summary.get("arms", {}).get("codex", {})
    require(summary.get("continuationPlanSha256") == OLD_PLAN_SHA
            and summary.get("originalPairRemainsIncomplete") is True
            and summary.get("historicalAmountsReset") is False
            and summary.get("allChargesRetained") is True
            and summary.get("qualityComparisonMet") is False and summary.get("efficiencyClaimMet") is False,
            "old continuation provenance changed")
    require(arm.get("runtime") == "codex" and arm.get("providerRequests") == OLD_CALLS
            and math.isclose(arm.get("measuredUsd", -1), OLD_USD, abs_tol=1e-8, rel_tol=0)
            and arm.get("autonomousActorsAdmitted") == 3 and arm.get("settlementComplete") is True
            and arm.get("reviewRequired") is True and arm.get("stopReason") == "forwarded_client_cancelled"
            and arm.get("functionalVerdict") == "not_run" and arm.get("nativeAuditVerdict") == "review_required",
            "old failed Codex outcome changed")
    require(arm.get("closure") == closure and closure.get("runtimeQuiesced") is True
            and closure.get("settlementComplete") is True and closure.get("providerRequests") == OLD_CALLS
            and closure.get("usageAccountingStatus") == "settled_and_receipts_reconciled"
            and closure.get("transcripts", {}).get("complete") is True
            and closure.get("transcripts", {}).get("sessionCount") == 3,
            "old scope is not known closed and quiescent")
    attempts = arm.get("attempts", [])
    require(len(attempts) == 1 and attempts[0].get("index") == 1
            and attempts[0].get("process", {}).get("ownedTreeQuiesced") is True
            and attempts[0].get("process", {}).get("wallMs") == OLD_ACTIVE_MS
            and attempts[0].get("artifact") == {"fileCount": 5, "manifestSha256": digest(snapshot), "protectedViolations": []}
            and "formalRepairStartedUnix" not in arm,
            "old invocation, snapshot or formal repair count changed")
    return arm


def old_inputs(options):
    original, vector = codex_arm.original_inputs(options)
    for name, checksum in OLD_FILES.items():
        require(file_hash(options.old_run / name) == checksum, "old Codex evidence changed")
    prior = json.loads((options.old_run / "continuation-plan.json").read_text(encoding="utf-8"))
    require(digest(prior) == OLD_PLAN_SHA and prior.get("originalPlanSha256") == codex_arm.ORIGINAL_PLAN_SHA,
            "old Codex plan changed")
    summary = json.loads((options.old_run / "summary.json").read_text(encoding="utf-8"))
    closure = json.loads((options.old_run / "codex/closure.json").read_text(encoding="utf-8"))
    snapshot = json.loads((options.old_run / "codex/attempts/1/source-manifest.json").read_text(encoding="utf-8"))
    arm = validate_old_arm(summary, closure, snapshot)
    require(summary.get("arms", {}).get("vector") == vector["arms"]["vector"], "prior Vector evidence changed")
    require(len(snapshot) == 5 and manifest(options.old_run / "codex/attempts/1/source") == snapshot
            and manifest(options.old_run / "codex/app") == snapshot, "old app differs from retained snapshot")
    transcripts = options.old_run / "codex/private-transcripts"
    require(file_hash(transcripts / "manifest.json") == closure["transcripts"]["manifestSha256"],
            "old descendant transcript manifest changed")
    transcript_manifest = json.loads((transcripts / "manifest.json").read_text(encoding="utf-8"))
    require(transcript_manifest.get("complete") is True and transcript_manifest.get("runtime") == "codex"
            and len(transcript_manifest.get("files", [])) == 3, "old descendant transcript coverage changed")
    for row in transcript_manifest["files"]:
        name = row.get("file", "")
        require(re.fullmatch(r"[0-9a-f]{64}\.jsonl", name) is not None
                and file_hash(transcripts / name) == row.get("sha256")
                and row.get("identitySha256") in IDENTITIES.values(), "old descendant transcript changed")
    audit = [json.loads(line) for line in (options.old_run / "codex/witness-audit.jsonl").read_text(encoding="utf-8").splitlines()]
    previous = None
    for sequence, row in enumerate(audit, 1):
        require(row.get("sequence") == sequence and row.get("previousSha256") == previous, "old audit chain changed")
        previous = digest(row)
    before = [row for row in audit if row.get("type") == "before_upstream"]
    receipts = [row for row in audit if row.get("type") == "receipt_registered"]
    require(len(before) == len(receipts) == OLD_CALLS
            and {row.get("identitySha256") for row in before} == set(IDENTITIES.values())
            and math.isclose(math.fsum(row["measuredUsd"] for row in receipts), OLD_USD, abs_tol=1e-8, rel_tol=0)
            and audit[-1].get("type") == "owned_scope_closed"
            and audit[-1].get("providerRequests") == OLD_CALLS, "old admissions or known receipts changed")
    return original, prior, summary, arm, audit, snapshot


def native_state(home, registry, expected_identities=IDENTITIES):
    """Read native metadata only; never rewrite IDs, ancestry or rollout paths."""
    with closing(registry.connect()) as connection:
        rows = connection.execute("SELECT id,source,thread_source,agent_role,agent_path,rollout_path,archived FROM threads").fetchall()
        require(len(rows) == 3, "retained native tree is not exactly three identities")
        roots = [row for row in rows if row["source"] == "exec" and row["thread_source"] == "user"]
        require(len(roots) == 1 and roots[0]["agent_role"] is None, "retained root is not unique")
        root = roots[0]["id"]
        registry.root_id = root
        identities, slots = {}, {}
        for row in rows:
            role = row["agent_role"] or "lead"
            require(role in expected_identities and role not in identities and row["archived"] == 0
                    and digest_id(row["id"]) == expected_identities[role], "retained identity or role changed")
            parent = None if role == "lead" else root
            metadata = {"thread_id": row["id"], "session_id": root, "parent_thread_id": parent,
                        "agent_name": "/root" if role == "lead" else "/root/" + role,
                        "model": "gpt-6.1-sol", "reasoning_effort": "high", "request_kind": "turn"}
            native = registry.codex(connection, {"thread-id": row["id"], "session-id": root,
                                                "x-codex-turn-metadata": json.dumps(metadata)})
            require(native["depth"] == (0 if role == "lead" else 1), "retained native depth changed")
            rollout = Path(row["rollout_path"])
            require(rollout.is_absolute() and rollout.resolve().is_relative_to(Path(home).resolve()) and rollout.is_file(),
                    "retained rollout path escaped exact old home")
            identities[role] = row["id"]
            if role != "lead":
                slots[role] = row["id"]
        edges = connection.execute("SELECT parent_thread_id,child_thread_id,status FROM thread_spawn_edges").fetchall()
        require(len(edges) == 2 and all(row["parent_thread_id"] == root and row["child_thread_id"] in slots.values()
                and row["status"] == "open" for row in edges), "retained lifetime edges changed")
    codex = Path(home) / "codex"
    with closing(sqlite3.connect((codex / "thread_history_1.sqlite").as_uri() + "?mode=ro", uri=True)) as connection:
        turns = connection.execute("SELECT thread_id,status FROM thread_turns").fetchall()
        require(len(turns) == 3 and {row[0] for row in turns} == set(identities.values())
                and all(row[1] == "failed" for row in turns), "retained failed phase changed")
        projections = dict(connection.execute("SELECT thread_id,next_rollout_byte_offset FROM thread_history_projection_state"))
        require(all(projections.get(row["id"]) == Path(row["rollout_path"]).stat().st_size for row in rows),
                "native history projection is incomplete")
    for name, table in (("queue_1.sqlite", "queued_items"), ("goals_1.sqlite", "thread_goals"), ("memories_1.sqlite", "jobs")):
        with closing(sqlite3.connect((codex / name).as_uri() + "?mode=ro", uri=True)) as connection:
            require(connection.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == 0, "retained native autonomous work remains")
    return identities, slots


def digest_id(value):
    return codex_arm.hashlib.sha256(value.encode()).hexdigest()


def validate_baseline(state, healthy, phase):
    healthy(state, idle=True, funding_profile=phase)
    require(state.get("batchCallsRemaining") == 0 and state.get("attempts") == BASELINE["attempts"]
            and math.isclose(state["measuredUsd"], BASELINE["measuredUsd"], abs_tol=1e-8, rel_tol=0),
            "funding changed since stopped Codex closure")
    for actor in ("foundry-vector", "foundry-codex"):
        require(math.isclose(state["actors"][actor]["measuredUsd"], BASELINE[actor], abs_tol=1e-8, rel_tol=0),
                "actor history changed since stopped Codex closure")
    return state


class ResumeController:
    def __init__(self, controller, healthy, phase, label):
        self.controller, self.healthy, self.phase, self.label = controller, healthy, phase, label
        self.admission_attempted = False

    def __call__(self, route, body=None):
        require(route in ("/status", "/control", "/disarm"), "unknown resume controller route")
        if route == "/control":
            require(not self.admission_attempted and body == {"actor": "foundry-codex", "label": self.label, "calls": NEW_CALLS},
                    "only the remaining original Codex allowance may be admitted once")
            validate_baseline(self.controller("/status"), self.healthy, self.phase)
            self.admission_attempted = True
        response = self.controller(route, body)
        if route == "/status" and not self.admission_attempted:
            validate_baseline(response, self.healthy, self.phase)
        return response


def qualification(path, binary_sha, witness_sha):
    if path is None:
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    flags = ("qualificationPassed", "oldWitnessClosed", "newWitnessEndpoint", "newAliasObserved", "rootIdentityPreserved",
             "existingChildIdentitiesPreserved", "noReplacementChildren", "codeModePreserved", "allSolHighAutoLow",
             "aliasOnly", "receiptJoinComplete", "archiveBeforeAdoptionVerified", "initialFailureRetainedSeparately",
             "historicalReviewRequired")
    expected = {"kind", "binarySha256", "witnessInstrumentSha256", "realProviderCalls", "fundedMeterCalls", "BunRuns", "ChromeRuns",
                "beforeRoles", "beforeLatestOutcomes", "afterRoles", "maximumNativeDepth", "phases", "cumulativeCalls",
                "formalRepairCount", "evidenceFiles", *flags}
    require(set(value) == expected and value["kind"] == "heavy-codex-partial-resume-qualification-v1"
            and all(value[key] is True for key in flags), "native adoption qualification is incomplete")
    require(value["binarySha256"] == binary_sha and value["witnessInstrumentSha256"] == witness_sha
            and all(value[key] == 0 for key in ("realProviderCalls", "fundedMeterCalls", "BunRuns", "ChromeRuns")),
            "qualification binary, witness or free-only boundary changed")
    require(value["beforeRoles"] == ["lead", "backend_coordinator", "frontend_worker"]
            and value["beforeLatestOutcomes"] == {role: "failed" for role in value["beforeRoles"]}
            and set(value["afterRoles"]) == {"lead", *ROLES} and len(value["afterRoles"]) == 7
            and value["maximumNativeDepth"] == 2, "qualification did not adopt the partial failed tree")
    phases = value["phases"]
    require(isinstance(phases, list) and len(phases) == 2
            and [row.get("phase") for row in phases] == ["initial_failed_fixture", "new_binding_resume"]
            and phases[0].get("latestOutcome") == "failed" and phases[0].get("reviewRequired") is True
            and phases[1].get("latestOutcome") == "completed" and type(phases[1].get("reviewRequired")) is bool
            and all(set(row) == {"phase", "forwardedCalls", "knownReceiptCount", "measuredUsd", "latestOutcome", "reviewRequired"}
                    and isinstance(row["forwardedCalls"], int) and not isinstance(row["forwardedCalls"], bool)
                    and row["forwardedCalls"] > 0 and row["knownReceiptCount"] == row["forwardedCalls"]
                    and isinstance(row["measuredUsd"], (int, float)) and not isinstance(row["measuredUsd"], bool)
                    and math.isfinite(row["measuredUsd"]) and row["measuredUsd"] >= 0 for row in phases)
            and value["cumulativeCalls"] == sum(row["forwardedCalls"] for row in phases)
            and 0 < value["cumulativeCalls"] <= 300
            and type(value["formalRepairCount"]) is int and value["formalRepairCount"] in (0, 1),
            "qualification lost known receipts, original failure or cumulative bounds")
    require(isinstance(value["evidenceFiles"], dict) and value["evidenceFiles"], "qualification has no retained evidence")
    for name, checksum in value["evidenceFiles"].items():
        unresolved = path.parent / name
        target = unresolved.resolve()
        require(not Path(name).is_absolute() and target.is_relative_to(path.parent.resolve()) and target != path
                and all(not item.is_symlink() and not item.is_junction() for item in [unresolved, *unresolved.parents]
                        if item == path.parent or item.is_relative_to(path.parent)) and file_hash(target) == checksum,
                "qualification evidence changed or escaped")
    return {"path": str(path), "sha256": file_hash(path), "kind": value["kind"], "evidenceFilesSha256": digest(value["evidenceFiles"])}


def load_instrument(options, original):
    root = options.witness_root / "scripts/benchmarks/matched-agentic-study"
    require(re.fullmatch(r"[0-9a-f]{40}", options.expected_witness_revision or "") is not None,
            "explicit clean corrected-witness revision required")
    current = manifest(root)
    require(digest(current) == options.expected_witness_manifest_sha, "reviewed corrected-witness manifest changed")
    common_root = Path(original["frozenPaths"]["common_runner_root"]).resolve()
    require(manifest(common_root) == original["commonInstrumentFiles"], "original common instrument changed")
    sys.path.insert(0, str(root))
    modules = [importlib.import_module(name) for name in ("heavy_runner", "paired_runner", "owned_team_witness", "native_registry")]
    require(all(Path(module.__file__).resolve().parent == root for module in modules), "cached witness import came from another root")
    heavy, team, witness, native = modules
    common = team.common_helpers(common_root)
    require(common.source_revision(options.witness_root) == (options.expected_witness_revision, False), "corrected witness source is dirty or changed")
    return heavy, team, witness, native, common, current


def build_plan(options):
    original, prior, summary, old_arm, audit, snapshot = old_inputs(options)
    heavy, team, witness, native, common, witness_files = load_instrument(options, original)
    runtime = codex_arm.runtime_options(options, original, heavy)
    expected = {**original, "teamInstrumentFiles": witness_files}
    require(heavy.build_plan(runtime, common) == expected, "original source/task/profile/binary freeze changed")
    overlay = prior.get("evaluationOverlay")
    require(isinstance(overlay, dict) and overlay.get("manifestSha256") == "1100a3ef3fad5f043c1228e16809944ff974025f42decb6310d43864104db9d7"
            and manifest(Path(overlay["root"])) == overlay["files"], "old reviewed evaluator overlay changed")
    home = options.old_run / "codex/runtime-home"
    registry = native.NativeRegistry("codex", home, home / "codex/state_5.sqlite", None, "benchmark", max_depth=2)
    identities, slots = native_state(home, registry)
    owned = {name: exact_tree(options.old_run / "codex" / name) for name in ("runtime-home", "app", "support-data")}
    roots = [options.old_run, options.original_plan.parent, options.witness_root, Path(__file__).resolve().parents[3],
             runtime.vector_root, runtime.task_dir, runtime.common_runner_root, runtime.browser_driver_root, Path(overlay["root"])]
    team.checked_path(options.out, roots)
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", options.label) is not None, "explicit synthetic continuation label required")
    proof = qualification(options.qualification, original["binarySha256"]["codex_bin"], digest(witness_files))
    plan = {"kind": "heavy-stopped-codex-native-resume-plan-v1", "oldPlanSha256": OLD_PLAN_SHA,
        "originalPlanSha256": codex_arm.ORIGINAL_PLAN_SHA, "originalSourceRevision": codex_arm.SOURCE,
        "oldRun": str(options.old_run), "oldEvidenceSha256": OLD_FILES, "oldIdentitySha256ByRole": IDENTITIES,
        "oldScope": {"providerRequests": OLD_CALLS, "measuredUsd": OLD_USD, "activeWallMs": OLD_ACTIVE_MS,
                     "formalRepairCount": 0, "latestNativeOutcomes": "failed", "reviewRequired": True},
        "ownedStateSha256": {name: digest(files) for name, files in owned.items()},
        "ownedStateFileCounts": {name: len(files) for name, files in owned.items()},
        "immutablePriorTreesSha256": {name: digest(exact_tree(options.old_run / "codex" / name))
                                     for name in ("attempts/1", "private-transcripts")},
        "newOutput": str(options.out), "newLabel": options.label, "witnessRoot": str(options.witness_root),
        "witnessRevision": options.expected_witness_revision, "witnessInstrumentFiles": witness_files,
        "witnessInstrumentSha256": digest(witness_files), "helperInstrumentFiles": manifest(Path(__file__).resolve().parent),
        "profileSha256": original["profileSha256"], "taskFilesSha256": digest(original["taskFiles"]),
        "binarySha256": original["binarySha256"], "evaluationOverlay": overlay, "qualification": proof,
        "requiredExactPreAdmissionBaseline": BASELINE, "fundingPhase": original["fundingPhase"],
        "fundingAuthorizationPlanSha256": original["fundingAuthorizationPlanSha256"],
        "studyHardCapUsd": 48, "cumulativeActorCapsUsd": original["cumulativeActorCapsUsd"],
        "maxNewCalls": NEW_CALLS, "maxCumulativeCalls": 300, "remainingActiveSeconds": NEW_SECONDS,
        "maxCumulativeActiveSeconds": 7200, "deadlineChoice": "remaining_active_time_excluding_disclosed_instrument_pause",
        "maxCumulativeFormalRepairs": 1, "cumulativeRepairAdmissionThresholdUsd": SOFT_USD,
        "newScopeRepairAdmissionThresholdUsd": SOFT_USD - OLD_USD, "nativeAutonomousIdentities": 7,
        "existingLifetimeSlots": sorted(slots), "remainingLifetimeSlots": sorted(set(ROLES) - set(slots)),
        "archiveRequiredBeforeNativeAppend": True, "retainExactNativeHomeAppSupportPaths": True,
        "allChargesRetained": True, "historicalAmountsReset": False, "priorReviewFlagsWaived": False,
        "originalPairRemainsIncomplete": True, "vectorRerunAllowed": False, "automaticNextPair": False,
        "qualityComparisonMet": False, "efficiencyClaimMet": False, "controllerOrCredentialFilesReadByPlan": False}
    return plan, original, prior, summary, old_arm, runtime, heavy, team, witness, common, registry, identities, slots, owned


def archive_state(old_directory, out, expected):
    destination = out / "pre-adoption-archive"
    destination.mkdir(parents=True, exist_ok=False)
    for name, files in expected.items():
        source = old_directory / name
        require(exact_tree(source) == files, "owned state changed before archive")
        shutil.copytree(source, destination / name)
        require(exact_tree(destination / name) == files and exact_tree(source) == files,
                "quiescent pre-adoption archive did not verify")
    record = {"kind": "quiescent-native-adoption-archive-v1", "archiveBeforeAdoptionVerified": True,
              "sourceRoots": {name: str(old_directory / name) for name in expected},
              "files": expected, "manifestSha256ByRoot": {name: digest(files) for name, files in expected.items()}}
    (destination / "manifest.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return {"archiveBeforeAdoptionVerified": True, "manifestSha256": file_hash(destination / "manifest.json"),
            "roots": {name: digest(files) for name, files in expected.items()}}


def seed_lifetime_slots(arm, identities, slots):
    require(not arm.requests and not arm.slots and not arm.admitted_ids and arm.repairs == 0,
            "native adoption requires a fresh remaining-allowance witness")
    require(set(identities) == {"lead", "backend_coordinator", "frontend_worker"}
            and set(slots) == {"backend_coordinator", "frontend_worker"}
            and len(set(identities.values())) == 3 and identities["lead"] == arm.registry.root_id
            and all(slots[role] == identities[role] for role in slots), "native adoption seed mismatch")
    arm.admitted_ids.update(identities.values())
    arm.slots.update(slots)
    arm.record({"type": "existing_native_lifetime_slots_adopted", "oldPlanSha256": OLD_PLAN_SHA,
                "identitySha256ByRole": {role: digest_id(identity) for role, identity in identities.items()},
                "oldCallsRetained": OLD_CALLS, "oldMeasuredUsdRetained": OLD_USD,
                "remainingCalls": NEW_CALLS, "oldLatestOutcomes": "failed", "oldReviewRequired": True})


def prepare_adopted_adapter(adapter, old_directory, runtime, original, snapshot, registry, overlay):
    """Rebuild process environment without setup, seeding, or an app restart."""
    adapter.directory.mkdir(parents=True, exist_ok=False)
    adapter.home, adapter.app, adapter.support = (old_directory / name for name in ("runtime-home", "app", "support-data"))
    adapter.registry = registry
    adapter.task_dir = Path(overlay["root"])
    adapter.protected = {name: snapshot[name] for name in [*original["task"]["protectedFiles"], "BUILD_SPEC.md"]}
    adapter.env = adapter.common.isolated_environment(adapter.home, adapter.app, runtime.bun, runtime.node)
    system = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"
    adapter.env["PATH"] = os.pathsep.join([str(runtime.bun.parent), str(runtime.node.parent),
        str(Path(sys.executable).parent), str(system), str(system / "WindowsPowerShell/v1.0")])
    adapter.env.update(NODE_EXE=str(runtime.node), PORT=str(runtime.app_port), DATA_DIR=str(adapter.support), VECTOR_DISABLE_CHANNEL_DB="1")
    for key, value in original["task"].get("environment", {}).items():
        require(key in ("PORT", "DATA_DIR", "WORKFLOW_DATA_DIR"), "unreviewed task environment")
        if key != "PORT":
            target = Path(str(value).replace("{arm}", str(old_directory)).replace("{app}", str(adapter.app))).resolve()
            require(target == adapter.support or target.is_relative_to(adapter.support), "adopted support environment escaped")
            adapter.env[key] = str(target)


def run_adopted(plan, old_summary, old_arm, *, supervisor, adapter, common, team, profile,
                identities, slots, check_frozen, persist, clock=time.monotonic):
    """Resume the original initial invocation, with at most its one formal repair."""
    result = {"kind": "heavy-stopped-codex-native-resume-result-v1", "resumePlanSha256": digest(plan),
        "originalPairRemainsIncomplete": True, "allChargesRetained": True, "historicalAmountsReset": False,
        "priorReviewFlagsWaived": False, "originalCodexAttempt": copy.deepcopy(old_arm),
        "originalVectorArm": copy.deepcopy(old_summary["arms"]["vector"]), "attempts": [],
        "oldProviderRequests": OLD_CALLS, "oldMeasuredUsd": OLD_USD, "newProviderRequests": 0,
        "providerRequests": OLD_CALLS, "measuredUsd": OLD_USD, "formalRepairCount": 0,
        "functionalVerdict": "not_run", "nativeAuditVerdict": "not_run", "reviewRequired": True,
        "historicalReviewRequired": True, "settlementComplete": False, "qualityComparisonMet": False,
        "efficiencyClaimMet": False, "automaticNextPair": False, "stopReason": None,
        "deadlineChoice": plan["deadlineChoice"], "instrumentPauseExcludedFromActiveTime": True}
    arm, started = None, clock()
    persist(result)
    try:
        check_frozen()
        arm = supervisor.begin("codex", plan["newLabel"], adapter.registry, tuple(profile["childLifetimeSlots"]),
            role_parents=profile["roleParents"], max_calls=NEW_CALLS, seconds=NEW_SECONDS, soft_usd=SOFT_USD - OLD_USD)
        seed_lifetime_slots(arm, identities, slots)
        adapter.bind(arm)
        prompt = ("Continue the SAME interrupted initial task in the SAME native root and existing backend_coordinator and frontend_worker identities. "
                  "The prior provider failure and charges remain recorded. Use native followup_task for those existing children; never replace them. "
                  "Create only the four as-yet unused fixed roles through their required parents and in the original dependency order. "
                  "Preserve the complete BUILD_SPEC.md, role ownership, verification, shared browser-client requirement and quality. "
                  "This resumes the initial invocation; it is not formal repair feedback.")
        for index in (1, 2):
            check_frozen()
            remaining = NEW_SECONDS - (clock() - started)
            require(remaining > 0, "remaining cumulative active deadline exhausted")
            invocation = adapter.run(prompt, identities["lead"], remaining, index)
            result["attempts"].append({"index": index, "process": invocation, "artifact": adapter.preserve(index)})
            persist(result)
            if arm.failure or invocation.get("exitCode") != 0 or invocation.get("timedOut") or invocation.get("stopReason"):
                if not arm.failure:
                    arm.latch("native_execution_fatal_or_timeout")
                result["stopReason"] = arm.failure
                break
            require(adapter.registry.root_id == identities["lead"] and all(arm.slots.get(role) == identity for role, identity in slots.items())
                    and set(arm.slots) == set(ROLES) and len(set(arm.slots.values())) == 6,
                    "resumed native lifetime tree is incomplete or replaced")
            evaluation = adapter.evaluate(index)
            result["attempts"][-1]["evaluation"] = evaluation
            verdict, feedback = team.gate_report(common, evaluation, adapter.task, profile=profile)
            result["functionalVerdict"] = verdict
            if verdict == "passed":
                result["stopReason"] = "functional_gate_passed_historical_review_retained"
                break
            if verdict == "instrument_failure":
                arm.latch("independent_instrument_failure")
                result["stopReason"] = arm.failure
                break
            if index == 2:
                result["stopReason"] = "product_failure_after_original_one_same_session_repair"
                break
            state = team.settled_invocation_state(supervisor, arm)
            spent = state["actors"][arm.actor]["measuredUsd"] - arm.before["actors"][arm.actor]["measuredUsd"]
            if len(arm.requests) >= NEW_CALLS or OLD_USD + spent >= SOFT_USD or clock() - started >= NEW_SECONDS:
                result["stopReason"] = "product_failure_at_original_cumulative_limit"
                break
            supervisor.repair()
            result["formalRepairCount"] = 1
            adapter.formal_repair_started = time.time()
            arm.record({"type": "formal_repair_execution_boundary", "startedUnix": adapter.formal_repair_started})
            prompt = feedback
    except Exception as error:
        if arm is not None:
            arm.latch("resume_runner_or_native_protocol_failure")
        result.update(stopReason="resume_runner_or_native_protocol_failure", failureType=type(error).__name__)
    finally:
        if arm is not None:
            try:
                adapter.stop()
            except Exception as error:
                arm.latch("owned_runtime_stop_unknown")
                result["stopFailureType"] = type(error).__name__
            closure = supervisor.close()
            result["newScopeClosure"] = closure
            result["settlementComplete"] = closure.get("settlementComplete") is True
            result["newProviderRequests"], result["newMeasuredUsd"] = closure.get("providerRequests"), closure.get("measuredUsd")
            if isinstance(result["newProviderRequests"], int) and not isinstance(result["newProviderRequests"], bool):
                require(0 <= result["newProviderRequests"] <= NEW_CALLS, "new calls exceed original remainder")
                result["providerRequests"] = OLD_CALLS + result["newProviderRequests"]
            if isinstance(result["newMeasuredUsd"], (int, float)) and math.isfinite(result["newMeasuredUsd"]):
                result["measuredUsd"] = math.fsum([OLD_USD, result["newMeasuredUsd"]])
            result["newScopeReviewRequired"] = closure.get("reviewRequired", True)
            result["autonomousActorsAdmitted"] = len(arm.admitted_ids)
            result["formalRepairCount"] = arm.repairs
            try:
                quality = adapter.audit(closure)
                result["nativeAudit"] = quality
                result["nativeAuditVerdict"] = "review_required" if quality.get("requiresManualReview", True) else "passed_with_historical_review_retained"
            except Exception as error:
                result.update(nativeAuditVerdict="review_required", nativeAuditFailureType=type(error).__name__)
            result["resumedActiveWallMs"] = math.fsum(attempt["process"].get("wallMs", 0) for attempt in result["attempts"])
            result["newStageElapsedWallMs"] = round((clock() - started) * 1000, 3)
            result["cumulativeActiveWallMs"] = OLD_ACTIVE_MS + result["resumedActiveWallMs"]
            if not result["settlementComplete"] or result["newScopeReviewRequired"]:
                result["stopReason"] = closure.get("stopReason") or "resume_closure_review_required"
        persist(result)
    return result


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    for name in ("original-plan", "old-run", "witness-root", "out", "write-plan", "reviewed-plan", "qualification", "controller-config", "receipt-jsonl"):
        result.add_argument("--" + name, type=Path, required=name in {"original-plan", "old-run", "witness-root", "out"})
    for name in ("expected-witness-revision", "expected-witness-manifest-sha", "expected-resume-sha", "label"):
        result.add_argument("--" + name, required=name in {"expected-witness-revision", "expected-witness-manifest-sha", "label"})
    result.add_argument("--run", action="store_true")
    return result


def main(argv=None):
    options = parser().parse_args(argv)
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    values = build_plan(options)
    plan, original, prior, summary, old_arm, runtime, heavy, team, witness, common, registry, identities, slots, owned = values
    if not options.run:
        if options.write_plan:
            team.checked_path(options.write_plan, [options.out, options.old_run, options.original_plan.parent,
                options.witness_root, Path(__file__).resolve().parents[3], runtime.vector_root, runtime.task_dir,
                runtime.common_runner_root, runtime.browser_driver_root])
            common.save(options.write_plan, plan)
        print(json.dumps({"plan": plan, "planSha256": digest(plan), "paidExecutionRequested": False}, indent=2))
        return 0
    require(options.reviewed_plan is not None and options.expected_resume_sha is not None and plan["qualification"] is not None,
            "run requires an exact reviewed plan/digest and qualified failed-tree new-binding proof")
    require(plan == json.loads(options.reviewed_plan.read_text(encoding="utf-8")) and digest(plan) == options.expected_resume_sha,
            "reviewed native adoption plan changed")
    require(options.controller_config is not None and options.receipt_jsonl is not None,
            "explicit private controller capability and receipts required")
    config = json.loads(options.controller_config.read_text(encoding="utf-8"))
    require(isinstance(config.get("localToken"), str) and config["localToken"], "existing controller capability missing")
    controller = ResumeController(common.Controller(runtime.provider_base, config["localToken"]), witness.healthy,
                                  heavy.FUNDING.phase, options.label)
    validate_baseline(controller("/status"), witness.healthy, heavy.FUNDING.phase)
    require(team.affordability(controller("/status"), "codex", funding_profile=heavy.FUNDING.phase)["affordable"],
            "full-quality cumulative reservation unavailable")
    options.out.mkdir(parents=True, exist_ok=False)
    common.save(options.out / "resume-plan.json", plan)
    archive = archive_state(options.old_run / "codex", options.out, owned)
    common.save(options.out / "archive-verification.json", archive)
    require({name: digest(exact_tree(options.old_run / "codex" / name)) for name in owned} == plan["ownedStateSha256"],
            "native state changed after verified archive")
    def receipts():
        with options.receipt_jsonl.open("r", encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
    holder = {}
    supervisor = witness.OwnedSupervisor(controller, receipts, options.out, funding_profile=heavy.FUNDING.phase,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    supervisor.used.add("vector")
    actual_runtime = copy.copy(runtime)
    actual_runtime.max_calls = NEW_CALLS
    actual_runtime.selected_task_root = actual_runtime.task_dir = Path(plan["evaluationOverlay"]["root"])
    actual_runtime.task_root = actual_runtime.task_dir.parent
    adapter = team.NativeAdapter("codex", actual_runtime, common, original["task"], holder)
    holder["adapter"] = adapter
    snapshot = json.loads((options.old_run / "codex/attempts/1/source-manifest.json").read_text(encoding="utf-8"))
    prepare_adopted_adapter(adapter, options.old_run / "codex", actual_runtime, original, snapshot, registry, plan["evaluationOverlay"])
    def check_frozen():
        for name, checksum in OLD_FILES.items():
            require(file_hash(options.old_run / name) == checksum, "immutable prior attempt evidence changed")
        require(heavy.build_plan(runtime, common) == {**original, "teamInstrumentFiles": plan["witnessInstrumentFiles"]}
                and manifest(Path(plan["evaluationOverlay"]["root"])) == plan["evaluationOverlay"]["files"]
                and all(digest(exact_tree(options.old_run / "codex" / name)) == checksum
                        for name, checksum in plan["immutablePriorTreesSha256"].items())
                and manifest(Path(__file__).resolve().parent) == plan["helperInstrumentFiles"], "resume source/task/instrument freeze changed")
    result = run_adopted(plan, summary, old_arm, supervisor=supervisor, adapter=adapter, common=common, team=team,
        profile=heavy.PROFILE, identities=identities, slots=slots, check_frozen=check_frozen,
        persist=lambda value: common.save(options.out / "summary.json", {**value, "archive": archive}))
    print(json.dumps({key: result.get(key) for key in ("providerRequests", "measuredUsd", "settlementComplete", "reviewRequired",
        "historicalReviewRequired", "functionalVerdict", "stopReason", "qualityComparisonMet", "efficiencyClaimMet")}, indent=2))
    return 0 if result["settlementComplete"] and not result["reviewRequired"] and result["functionalVerdict"] == "passed" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"errorType": type(error).__name__, "automaticRetry": False, "automaticNextPair": False}), file=sys.stderr)
        raise SystemExit(2)
