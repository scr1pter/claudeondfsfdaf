"""Actual seven-role headless adapter qualification with a local fake provider.

The real task seed stays unchanged. Shell/API/CLI/SDK, rg/git, optional browser
and image transport are exercised through native tools. No funded input exists.
"""
import copy
import json
from pathlib import Path
import sys
import threading

import runner as entry


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
    meter = heavy_adapter_smoke.FakeMeter(options.out)
    adapter_options = copy.copy(options)
    adapter_options.provider_base = "http://127.0.0.1:" + str(meter.server_port)
    original_shell = native_pair_smoke.shell_command
    def fixture_shell(port):
        return original_shell(port) + "; & $env:NODE_EXE ./cli.mjs --help; & $env:NODE_EXE ./sdk.mjs; rg --version; git --version"
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
            label="synthetic-headless-adapter-" + options.runtime, adapter=adapter, task=plan["task"], common=common,
            max_calls=300, seconds=7200, soft_usd=plan["softUsd"], profile=plan["profile"],
            check_frozen=lambda: entry.require(entry.build_plan(options)[0] == plan, "headless qualification freeze changed"),
            persist=lambda value: common.save(options.out / "private-result.json", value))
        capabilities = native_pair_smoke.capabilities(adapter)
        background = heavy_adapter_smoke.vector_background_evidence(adapter)
        output = "\n".join(path.read_text(encoding="utf-8") for path in (adapter.directory / "attempts").glob("*/agent.stdout.log"))
        summary = {"kind": "fake-actual-headless-adapter-qualification-v1", "runtime": options.runtime,
            "realProviderCalls": 0, "fundedMeterCalls": 0, "sourceRevision": plan["sourceRevision"],
            "profileSha256": plan["profileSha256"], "instrumentFiles": plan["teamInstrumentFiles"],
            "binarySha256": plan["binarySha256"], "fakeRequests": len(meter.receipts),
            "unchangedRealSeed": bool(result["attempts"]) and all(row["artifact"].get("unchangedSmokeSeed") is True for row in result["attempts"]),
            "expectedProductGate": "unchanged headless seed remains negative under all 54 checks",
            "allSolHighAutoLow": all(row["model"] == "gpt-6.1-sol" and row["reasoning"].get("effort") == "high"
                and row["reasoning"].get("summary") == "auto" and row["verbosity"] == "low" and row["outputCeiling"] == 32000 for row in meter.rows),
            "capabilityEvidence": capabilities, "backgroundEvidence": background,
            "nativeImagePreviewRequests": sum(row.get("inputImageCount", 0) > 0 for row in meter.rows),
            "trustedRgAndGitAvailable": "ripgrep " in output and "git version " in output,
            **{key: result.get(key) for key in ("functionalVerdict", "nativeAuditVerdict", "stopReason", "reviewRequired",
                "settlementComplete", "providerRequests", "autonomousActorsAdmitted", "nativeAudit")}}
        summary["qualificationPassed"] = (summary["allSolHighAutoLow"] and summary["unchangedRealSeed"]
            and result.get("functionalVerdict") == "product_failure" and result.get("stopReason") == "product_failure_after_one_same_session_repair"
            and result.get("settlementComplete") is True and result.get("reviewRequired") is False
            and result.get("nativeAuditVerdict") == "passed" and result.get("autonomousActorsAdmitted") == 7
            and result.get("providerRequests") == len(meter.receipts) and summary["nativeImagePreviewRequests"] > 0
            and capabilities["successfulActualShellApiAndCommonBrowser"] and summary["trustedRgAndGitAvailable"]
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
