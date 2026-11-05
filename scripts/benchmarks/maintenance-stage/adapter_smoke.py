"""Actual seven-role maintenance adapter qualification with a local fake provider.

The real task seed stays unchanged. Shell/API/CLI/SDK, rg/git, optional browser
and image transport are exercised through native tools. No funded input exists.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import threading

import runner as entry


def FailureProbeMeter(base, smoke, output):
    """Exercise a real known nonzero command without changing the task seed."""
    class Probe(base):
        def next_calls(self, adapter, native, tools):
            key = (adapter.runtime, native["id"])
            if native["role"] == "lead" and adapter.smoke_invocation == 1 and key not in self.intentional_failures:
                self.intentional_failures.add(key)
                return [smoke.execution_call(adapter.runtime, tools,
                    "Write-Output 'intentional-known-nonzero-fixture'; exit 7")]
            return super().next_calls(adapter, native, tools)
    meter = Probe(output)
    meter.intentional_failures = set()
    return meter


def intentional_failure_observed(executions):
    return any("intentional-known-nonzero-fixture" in row.get("command", "")
        and row.get("status") in ("completed", "error", "failed")
        and type(row.get("exitCode")) is int and row["exitCode"] == 7
        and row.get("started") is not None and row.get("ended") is not None and row["started"] <= row["ended"]
        for row in executions)


def main(argv=None):
    options = entry.parser().parse_args(argv)
    for key, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, key, value.resolve())
    entry.require(options.runtime in ("vector", "codex") and not options.run
                  and options.controller_config is None and options.receipt_jsonl is None,
                  "fake qualification cannot accept funded inputs")
    plan, heavy, team, witness, common = entry.build_plan(options)
    import heavy_adapter_smoke
    import native_pair_smoke
    from funding_profiles import HEAVY_PHASE
    roots = [Path(value) for value in plan["frozenPaths"].values() if Path(value).is_dir()]
    team.checked_path(options.out, roots)
    options.out.mkdir(parents=True)
    meter = FailureProbeMeter(heavy_adapter_smoke.FakeMeter, native_pair_smoke, options.out)
    adapter_options = copy.copy(options)
    adapter_options.provider_base = "http://127.0.0.1:" + str(meter.server_port)
    original_shell = native_pair_smoke.shell_command
    def fixture_shell(port):
        # Cmdlet failures throw; every native subprocess's exit is checked before
        # another command can overwrite LASTEXITCODE and mask a failed proof.
        check = "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
        return "$ErrorActionPreference='Stop'; " + original_shell(port) + check \
            + "; & $env:NODE_EXE ./cli.mjs --help" + check \
            + "; & $env:NODE_EXE ./sdk.mjs" + check \
            + "; rg --version" + check + "; git --version" + check
    native_pair_smoke.shell_command = fixture_shell
    holder = {"fakeMeter": meter}
    supervisor = witness.OwnedSupervisor(meter.controller, lambda: list(meter.receipts), options.out,
        funding_profile=HEAVY_PHASE,
        quiesced=lambda: holder.get("adapter") is not None and holder["adapter"].quiesced is True)
    adapter = heavy_adapter_smoke.Adapter(options.runtime, adapter_options, common, plan["task"], holder)
    holder["adapter"] = adapter
    thread = threading.Thread(target=meter.serve_forever, daemon=True)
    thread.start()
    try:
        result = team.coordinate_team_arm(supervisor=supervisor, runtime=options.runtime,
            label="synthetic-maintenance-adapter-" + options.runtime, adapter=adapter, task=plan["task"], common=common,
            max_calls=300, seconds=7200, soft_usd=plan["softUsd"], profile=plan["profile"],
            startup_mode=options.startup_affordability_mode,
            check_frozen=lambda: entry.require(entry.build_plan(options)[0] == plan, "headless qualification freeze changed"),
            persist=lambda value: common.save(options.out / "private-result.json", value))
        capabilities = native_pair_smoke.capabilities(adapter)
        background = heavy_adapter_smoke.vector_background_evidence(adapter)
        transcripts = adapter.directory / "private-transcripts"
        transcript_manifest = json.loads((transcripts / "manifest.json").read_text(encoding="utf-8"))
        root_identity = hashlib.sha256(adapter.registry.root_id.encode()).hexdigest()
        root_files = [row for row in transcript_manifest["files"] if row["identitySha256"] == root_identity]
        entry.require(len(root_files) == 1, "owned root transcript missing for deliberate-failure proof")
        root_path = common.inside(transcripts, root_files[0]["file"])
        entry.require(common.file_hash(root_path) == root_files[0]["sha256"], "root transcript changed")
        expected_failure = intentional_failure_observed(team.normalize_transcript(root_path, options.runtime)["executions"])
        baseline = json.loads((options.task_dir / "qualification.json").read_text(encoding="utf-8"))["workingSeed"]["checks"]
        baseline_status = {row["name"]: row["status"] for row in baseline}
        seed_baseline_preserved = bool(result["attempts"]) and all(
            {row["name"]: row["status"] for row in attempt.get("evaluation", {}).get("report", {}).get("checks", [])} == baseline_status
            for attempt in result["attempts"])
        output = "\n".join(path.read_text(encoding="utf-8") for path in (adapter.directory / "attempts").glob("*/agent.stdout.log"))
        summary = {"kind": "fake-actual-maintenance-adapter-qualification-v1", "runtime": options.runtime,
            "realProviderCalls": 0, "fundedMeterCalls": 0, "sourceRevision": plan["sourceRevision"],
            "profileSha256": plan["profileSha256"], "instrumentFiles": plan["teamInstrumentFiles"],
            "binarySha256": plan["binarySha256"], "fakeRequests": len(meter.receipts),
            "unchangedRealSeed": bool(result["attempts"]) and all(row["artifact"].get("unchangedSmokeSeed") is True for row in result["attempts"]),
            "actualWorkingSeedBaselinePreserved": seed_baseline_preserved,
            "expectedProductGate": "working legacy seed retains its measured partial baseline under all 54 checks",
            "allSolHighAutoLow": all(row["model"] == "gpt-6.1-sol" and row["reasoning"].get("effort") == "high"
                and row["reasoning"].get("summary") == "auto" and row["verbosity"] == "low" and row["outputCeiling"] == 32000 for row in meter.rows),
            "capabilityEvidence": capabilities, "backgroundEvidence": background,
            "nativeImagePreviewRequests": sum(row.get("inputImageCount", 0) > 0 for row in meter.rows),
            "knownFailedCommandExecutions": sum(row.get("knownFailedCommandExecutions", 0) for row in result.get("nativeAudit", {}).get("sessions", [])),
            "intentionalExitSevenObservedInOwnedRoot": expected_failure,
            "postJudgeApiCliSdkSucceeded": all(result.get("nativeAudit", {}).get(key) is True for key in
                ("rootPostJudgeApiVerificationCommandSucceeded", "rootPostJudgeCliVerificationCommandSucceeded", "rootPostJudgeSdkVerificationCommandSucceeded")),
            "trustedRgAndGitAvailable": "ripgrep " in output and "git version " in output,
            **{key: result.get(key) for key in ("functionalVerdict", "nativeAuditVerdict", "stopReason", "reviewRequired",
                "settlementComplete", "providerRequests", "autonomousActorsAdmitted", "nativeAudit")}}
        summary["qualificationPassed"] = (summary["allSolHighAutoLow"] and summary["unchangedRealSeed"] and seed_baseline_preserved
            and result.get("functionalVerdict") == "product_failure" and result.get("stopReason") == "product_failure_after_one_same_session_repair"
            and result.get("settlementComplete") is True and result.get("reviewRequired") is False
            and result.get("nativeAuditVerdict") == "passed" and result.get("autonomousActorsAdmitted") == 7
            and result.get("providerRequests") == len(meter.receipts) and summary["nativeImagePreviewRequests"] > 0
            and capabilities["successfulActualShellApiAndCommonBrowser"] and summary["trustedRgAndGitAvailable"]
            and summary["knownFailedCommandExecutions"] >= 1 and expected_failure and summary["postJudgeApiCliSdkSucceeded"]
            and (options.runtime != "vector" or background["backgroundTaskLaunches"] > 0 and background["ownedCompletionNotifications"] > 0))
        common.save(options.out / "smoke-summary.json", summary)
        print(json.dumps({key: value for key, value in summary.items() if key not in ("instrumentFiles", "binarySha256", "nativeAudit")}, indent=2))
        return 0 if summary["qualificationPassed"] else 2
    finally:
        native_pair_smoke.shell_command = original_shell
        meter.shutdown()
        meter.server_close()
        thread.join(timeout=10)


if __name__ == "__main__":
    raise SystemExit(main())
