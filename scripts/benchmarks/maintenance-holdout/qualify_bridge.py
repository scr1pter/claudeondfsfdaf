"""Compose actual Bun reference/working-seed evidence and freeze public inputs.

The private reference stays external. No provider, browser or agent is called.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import gate_bridge
import owned_process

EXPECTED_REQUIREMENTS = "86834277bf53afa9b8d8725556c919eae4f9ebb789d3ef8272f5c0bd0f4da5b8"
EXPECTED_EVALUATOR = "8aba9dc770cc22493c40f093dde9bf95e1e99d6491f601997dde47ba25afe702"
EXPECTED_INVENTORY = "b4e32b995387656c6d610b9479f3d456d408ab068d1ecbd00ac05238ded43f7d"
NEGATIVE_TARGETS = {"checksum-bypass": "checksum-corruption-refused", "revoked-replay": "revoked-idempotent-replay-denied",
    "inflight-revocation": "revoked-inflight-body-denied", "credit-cap-bypass": "overcredit-atomic-rejection",
    "invoice-recalculation": "late-usage-preserves-issued-invoice"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("reference", "private-proof", "runtime", "node", "typescript", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    for name, value in vars(args).items():
        setattr(args, name, value.resolve())
    root = Path(__file__).resolve().parent
    need = gate_bridge.require
    need(not args.reference.is_relative_to(root) and not root.is_relative_to(args.reference), "private reference overlaps public task")
    proof = json.loads(args.private_proof.read_bytes())
    inventory = json.loads((root / "CHECK-INVENTORY.json").read_bytes())
    need(proof.get("kind") == "private-ledgerdesk-qualification-v1" and proof.get("mode") == "bun-qualification"
         and proof.get("runtimeQualified") is True and proof.get("providerCalls") == 0
         and proof.get("reference", {}).get("checksPassed") == 54
         and 0 < proof.get("seed", {}).get("businessPassed", 0) < 50
         and proof.get("seed", {}).get("prerequisitesPassed") == 4
         and proof.get("negativeControlsRejected") == proof.get("negativeControlsTotal") == 5
         and set(proof.get("negativeControls", {})) == set(inventory["negativeControls"])
         and all(row.get("rejected") is True and row.get("prerequisitesPassed") == 4
                 and row.get("allIndependentRowsRetained") is True
                 and row.get("report", {}).get("prerequisitesPassed") == 4
                 and row.get("report", {}).get("sourceUnchanged") is True
                 and len(row.get("report", {}).get("checks", [])) == 54
                 and any(check.get("name") == row.get("target") and check.get("scope") == "business" and check.get("passed") is False
                         for check in row["report"]["checks"]) for row in proof["negativeControls"].values())
         and proof.get("originalRequirementsUnchanged") is True and proof.get("noReferenceInPublicTask") is True,
         "actual Bun private controls are incomplete")
    for name, control in proof["negativeControls"].items():
        need(control.get("target") == NEGATIVE_TARGETS[name], "damaged-reference intended target changed")
        normalized = gate_bridge.normalize(control["report"], 2, control["report"].get("sourceUnchanged") is True)
        need(normalized["summary"]["prerequisite"]["passed"] == 4
             and {row["name"] for row in normalized["checks"]} == set(inventory["business"] + inventory["prerequisite"]),
             "damaged-reference complete row inventory or prerequisites differ")
    for filename, field, expected in (("instrument/BUILD_SPEC.md", "requirementsSha256", EXPECTED_REQUIREMENTS),
            ("evaluate.py", "evaluatorSha256", EXPECTED_EVALUATOR), ("CHECK-INVENTORY.json", "inventorySha256", EXPECTED_INVENTORY)):
        need(hashlib.sha256((root / filename).read_bytes()).hexdigest() == proof.get(field) == expected,
             "requirements, inventory or evaluator changed")
    reference = {name: hashlib.sha256((args.reference / name).read_bytes()).hexdigest()
                 for name in ("app.mjs", "sdk.mjs", "sdk.d.mts", "cli.mjs", "package.json")}
    need(reference == proof.get("referenceSha256"), "private reference changed after qualification")
    args.out.mkdir(parents=True, exist_ok=False)
    reports = {}
    for key, app in (("positiveReference", args.reference), ("workingSeed", root / "instrument/seed")):
        destination = args.out / key
        process = owned_process.run([sys.executable, "-B", str(root / "gate_bridge.py"), "--app", str(app),
            "--out", str(destination), "--runtime", str(args.runtime), "--node", str(args.node),
            "--typescript", str(args.typescript), "--mode", "bun-qualification"], capture_output=True, text=True, timeout=180)
        report = json.loads((destination / "evaluation.json").read_bytes())
        need(process.returncode == (0 if key == "positiveReference" else 1), "normalized gate process disagrees")
        reports[key] = report
    need(reports["workingSeed"]["summary"]["api"]["passed"] == proof["seed"]["businessPassed"], "working baseline changed")
    files = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(root.rglob("*"))
             if path.is_file() and "__pycache__" not in path.parts and path.name not in ("qualification.json", "runtime-freeze.json")}
    aggregate = digest(files)
    qualification = {"kind": "maintenance-runtime-qualification-v1", "status": "runtime_qualified", "runtimeQualified": True,
        "modelCalls": 0, "expectedChecks": {"api": 50, "browser": 0, "prerequisite": 4, "total": 54}, **reports,
        "damagedReferenceControls": [{"name": name, **row} for name, row in sorted(proof["negativeControls"].items())],
        "originalRequirementsUnchanged": True, "privateReferenceOutsideTaskRoot": True,
        "actualSeedBusinessPasses": proof["seed"]["businessPassed"], "seedZeroRequired": False,
        "sourceFreezeAggregateSha256": aggregate, "privateProofSha256": hashlib.sha256(args.private_proof.read_bytes()).hexdigest()}
    (root / "qualification.json").write_text(json.dumps(qualification, indent=2) + "\n", encoding="utf-8", newline="\n")
    freeze = {"kind": "maintenance-runtime-freeze-v1", "status": "runtime_qualified", "files": files, "aggregateSha256": aggregate,
        "qualificationReportSha256": hashlib.sha256((root / "qualification.json").read_bytes()).hexdigest(),
        "binarySha256": {key: hashlib.sha256(getattr(args, key).read_bytes()).hexdigest() for key in ("runtime", "node", "typescript")}}
    (root / "runtime-freeze.json").write_text(json.dumps(freeze, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"referenceChecks": 54, "actualSeedBusinessPasses": proof["seed"]["businessPassed"],
                      "negativeControlsRejected": 5, "runtimeQualified": True, "sourceAggregateSha256": aggregate}))


if __name__ == "__main__":
    main()
