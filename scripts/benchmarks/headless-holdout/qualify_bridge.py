"""Owner-run Bun qualification composer; the private reference stays external.

First run the external reference controls with Bun. This composer checks that
proof, reruns the actual gate bridge on the reference and empty seed, and freezes
all public instrument bytes. It neither starts an agent nor calls a provider.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import gate_bridge
import owned_process

EXPECTED_REQUIREMENTS = "a85c62de50f23145bfc3ee6db261db08c565889ff8df0a7808bae1143b968351"
EXPECTED_EVALUATOR = "2a2abb4a47accc790b62af406003a48c09e6b92ba5c7c4b84bea55f19ca84999"
NEGATIVES = {"revoked-authority", "same-subject-replay", "lease-capability-binding", "unchecked-checksum", "pre-body-authority"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("reference", "private-proof", "runtime", "node", "typescript", "out"):
        parser.add_argument("--" + key, type=Path, required=True)
    options = parser.parse_args(argv)
    for key, value in vars(options).items():
        setattr(options, key, value.resolve())
    root = Path(__file__).resolve().parent
    gate_bridge.require(not options.reference.is_relative_to(root) and not root.is_relative_to(options.reference),
                        "private reference overlaps public instrument")
    options.out.mkdir(parents=True, exist_ok=False)
    proof = json.loads(options.private_proof.read_text(encoding="utf-8"))
    gate_bridge.require(proof.get("kind") == "private-headless-qualification-v1" and proof.get("mode") == "bun-qualification"
                        and proof.get("runtimeQualified") is True and proof.get("reference", {}).get("checksPassed") == 54
                        and proof.get("empty", {}).get("businessPassed") == 0 and proof.get("negativeControlsRejected") == 5
                        and proof.get("negativeControlsTotal") == 5 and set(proof.get("negativeControls", {})) == NEGATIVES
                        and all(row.get("rejected") is True for row in proof["negativeControls"].values())
                        and proof.get("requirementsSha256") == EXPECTED_REQUIREMENTS and proof.get("evaluatorSha256") == EXPECTED_EVALUATOR
                        and proof.get("noReferenceInPublicTask") is True and proof.get("originalRequirementsUnchanged") is True,
                        "private Bun positive/negative controls incomplete")
    gate_bridge.require(hashlib.sha256((root / "instrument/BUILD_SPEC.md").read_bytes()).hexdigest() == EXPECTED_REQUIREMENTS
                        and hashlib.sha256((root / "evaluate.py").read_bytes()).hexdigest() == EXPECTED_EVALUATOR,
                        "original requirements or independent evaluator changed")
    reference_files = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in options.reference.iterdir() if path.is_file()}
    gate_bridge.require(reference_files == proof.get("referenceSha256"), "private reference changed after controls")
    reports = {}
    for name, app in (("positiveReference", options.reference), ("emptySeed", root / "instrument/seed")):
        destination = options.out / name
        process = owned_process.run([sys.executable, "-B", str(root / "gate_bridge.py"), "--app", str(app), "--out", str(destination),
            "--runtime", str(options.runtime), "--node", str(options.node), "--typescript", str(options.typescript), "--mode", "bun-qualification"],
            capture_output=True, text=True, timeout=180)
        report = json.loads((destination / "evaluation.json").read_text(encoding="utf-8"))
        gate_bridge.require(process.returncode == (0 if name == "positiveReference" else 1), "bridge result changed")
        reports[name] = report
    files = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(root.rglob("*"))
             if path.is_file() and "__pycache__" not in path.parts and path.name not in ("qualification.json", "runtime-freeze.json")}
    aggregate = digest(files)
    qualification = {"kind": "headless-runtime-qualification-v1", "status": "runtime_qualified", "runtimeQualified": True,
        "modelCalls": 0, "expectedChecks": {"api": 50, "browser": 0, "prerequisite": 4, "total": 54}, **reports,
        "damagedReferenceControls": [{"name": name, **row} for name, row in sorted(proof["negativeControls"].items())],
        "originalRequirementsUnchanged": True, "privateReferenceOutsideTaskRoot": True,
        "sourceFreezeAggregateSha256": aggregate,
        "privateProofSha256": hashlib.sha256(options.private_proof.read_bytes()).hexdigest()}
    (root / "qualification.json").write_text(json.dumps(qualification, indent=2) + "\n", encoding="utf-8", newline="\n")
    freeze = {"kind": "headless-runtime-freeze-v1", "status": "runtime_qualified", "files": files, "aggregateSha256": aggregate,
              "qualificationReportSha256": hashlib.sha256((root / "qualification.json").read_bytes()).hexdigest(),
              "binarySha256": {key: hashlib.sha256(getattr(options, key).read_bytes()).hexdigest() for key in ("runtime", "node", "typescript")}}
    (root / "runtime-freeze.json").write_text(json.dumps(freeze, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"referenceChecks": 54, "emptyBusinessPasses": 0, "negativeControlsRejected": 5,
                      "runtimeQualified": True, "sourceAggregateSha256": aggregate,
                      "qualificationSha256": freeze["qualificationReportSha256"]}))


if __name__ == "__main__":
    main()
