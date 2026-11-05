"""PRIVATE reference qualification; never include this directory in paid tasks.

Imports only the independently frozen public evaluator. Node authoring and Bun
qualification must be explicitly selected. No provider or benchmark agent calls.
"""
import argparse
import copy
from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("task", "reference", "runtime", "node", "typescript", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("node-prequalification", "bun-qualification"), required=True)
    options = parser.parse_args()
    for name, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, name, value.resolve())
    if options.reference.is_relative_to(options.task) or options.task.is_relative_to(options.reference):
        raise ValueError("private reference overlaps public task")
    options.out.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(options.task))
    import evaluate
    import owned_process
    reports = {}
    for name, app in (("reference", options.reference), ("seed", options.task / "instrument/seed")):
        destination = options.out / name
        result = owned_process.run([sys.executable, "-B", str(options.task / "evaluate.py"), "--app", str(app),
            "--out", str(destination), "--runtime", str(options.runtime), "--node", str(options.node),
            "--typescript", str(options.typescript), "--mode", options.mode], capture_output=True, text=True, timeout=180)
        report = json.loads((destination / "evaluation.json").read_bytes())
        if result.returncode != (0 if name == "reference" else 2):
            raise ValueError(name + " evaluation process did not match the frozen contract")
        if name == "reference" and report["checksPassed"] != 54:
            raise ValueError("private reference does not pass all 54 independent checks")
        if name == "seed" and not (0 < report["businessPassed"] < 50 and report["prerequisitesPassed"] == 4):
            raise ValueError("working seed outcome is not a meaningful partial baseline")
        if report.get("sourceUnchanged") is not True:
            raise ValueError("evaluation changed authored source")
        reports[name] = report
    original = (options.reference / "app.mjs").read_text(encoding="utf-8")
    changes = {
      "checksum-bypass": ("checksum-corruption-refused", "if(!object(value.payload)||value.checksum!==hash(canon(value.payload)))", "if(!object(value.payload))"),
      "revoked-replay": ("revoked-idempotent-replay-denied", "x.tokenHash===tokenHash&&!x.revoked", "x.tokenHash===tokenHash"),
      "inflight-revocation": ("revoked-inflight-body-denied", "if(b!==undefined)p=auth(req.headers.authorization)", "// deliberately skip commit-boundary reauthorization"),
      "credit-cap-bypass": ("overcredit-atomic-rejection", "if(b.amountCents>invoiceView(i).balanceCents)", "if(false)"),
      "invoice-recalculation": ("late-usage-preserves-issued-invoice", "return {...i,creditedCents,balanceCents:i.totalCents-creditedCents}", "return {...i,...quote(data.accounts.find(a=>a.id===i.accountId),i.period),creditedCents,balanceCents:i.totalCents-creditedCents}")
    }
    controls = {}
    for name, (target, before, after) in changes.items():
        if original.count(before) != 1:
            raise ValueError("negative-control source anchor changed: " + name)
        with tempfile.TemporaryDirectory(prefix="ledgerdesk-negative-") as temporary:
            app = Path(temporary) / "app"
            app.mkdir()
            for filename in ("app.mjs", "sdk.mjs", "sdk.d.mts", "cli.mjs", "package.json"):
                shutil.copyfile(options.reference / filename, app / filename)
            (app / "app.mjs").write_text(original.replace(before, after), encoding="utf-8")
            destination = options.out / ("negative-" + name)
            result = owned_process.run([sys.executable, "-B", str(options.task / "evaluate.py"), "--app", str(app),
                "--out", str(destination), "--runtime", str(options.runtime), "--node", str(options.node),
                "--typescript", str(options.typescript), "--mode", options.mode], capture_output=True, text=True, timeout=180)
            report = json.loads((destination / "evaluation.json").read_bytes())
            target_rows = [row for row in report.get("checks", []) if row.get("name") == target and row.get("scope") == "business"]
            if result.returncode != 2 or report.get("prerequisitesPassed") != 4 or report.get("sourceUnchanged") is not True \
                    or len(report.get("checks", [])) != 54 or len(target_rows) != 1:
                raise ValueError("damaged-reference prerequisite or complete report failed: " + name)
            check_options = copy.copy(options)
            check_options.app = app
            passed = target_rows[0]["passed"] is not False
            trials = 3 if name == "inflight-revocation" else 1
            observations = []
            for _ in range(trials):
                try:
                    dict(evaluate.GROUPS)[target](check_options)
                    observations.append("unexpected_pass")
                    passed = True
                except AssertionError:
                    observations.append("rejected")
            controls[name] = {"target": target, "rejected": not passed, "trials": trials, "observations": observations,
                              "prerequisitesPassed": 4, "allIndependentRowsRetained": True,
                              "report": report, "damagedSourceSha256": checksum(app / "app.mjs")}
    proof = {"kind": "private-ledgerdesk-qualification-v1", "mode": options.mode,
             "runtimeQualified": options.mode == "bun-qualification" and all(x["rejected"] for x in controls.values()),
             "reference": reports["reference"], "seed": reports["seed"], "negativeControls": controls,
             "negativeControlsTotal": 5, "negativeControlsRejected": sum(x["rejected"] for x in controls.values()),
             "requirementsSha256": checksum(options.task / "instrument/BUILD_SPEC.md"),
             "evaluatorSha256": checksum(options.task / "evaluate.py"),
             "inventorySha256": checksum(options.task / "CHECK-INVENTORY.json"),
             "referenceSha256": {name: checksum(options.reference / name) for name in ("app.mjs", "sdk.mjs", "sdk.d.mts", "cli.mjs", "package.json")},
             "originalRequirementsUnchanged": True, "noReferenceInPublicTask": True, "providerCalls": 0,
             "heldBodyScheduleLimit": "One controlled schedule, repeated three times for its damaged-reference control; not exhaustive concurrency proof."}
    (options.out / "qualification.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"mode": options.mode, "referenceChecks": reports["reference"]["checksPassed"],
                      "actualSeedBusinessPasses": reports["seed"]["businessPassed"], "negativeControlsRejected": proof["negativeControlsRejected"],
                      "providerCalls": 0, "runtimeQualified": proof["runtimeQualified"]}))
    return 0 if all(x["rejected"] for x in controls.values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
