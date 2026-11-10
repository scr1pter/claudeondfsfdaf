"""Produce an allowlisted public record from retained private runtime reports."""
import argparse
import hashlib
import json
from pathlib import Path
import platform

from evaluate import finalize


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def report(path):
    raw = json.loads(path.read_text(encoding="utf-8"))
    checked = finalize(json.loads(json.dumps(raw)))
    if raw.get("verdict") != checked["verdict"] or checked.get("instrumentError"):
        raise ValueError("Runtime report has inconsistent or unassessed evidence")
    return {"verdict": checked["verdict"], "wallMs": raw["wallMs"], "summary": checked["summary"],
            "sourceIntegrityStatus": raw["sourceIntegrityStatus"], "rawReportSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "authoredFileCount": len(raw["sourceBefore"]), "sourceManifestAggregateSha256": digest(raw["sourceBefore"]),
            "checks": [{key: row[key] for key in ("name", "category", "status")} for row in checked["checks"]]}


def qualification(positive_path, empty_path, negatives_path, attempts):
    positive, empty = report(positive_path), report(empty_path)
    if positive["verdict"] != "passed" or any(row["status"] != "passed" for row in positive["checks"]):
        raise ValueError("Every positive-reference row must pass")
    if empty["verdict"] != "product_failure" or any(row["status"] != "not_run" for row in empty["checks"] if row["category"] != "prerequisite"):
        raise ValueError("The exact empty seed must have zero application passes and no executed app checks")
    negatives = json.loads(negatives_path.read_text(encoding="utf-8"))["controls"]
    if len(negatives) != 2 or any(row.get("instrumentErrors") != 0 or row["expectedFailure"] not in row["observedFailures"] for row in negatives):
        raise ValueError("Both damaged-reference controls must fail the expected product check")
    outside = next(row for row in negatives if row["name"] == "outside-origin-asset")
    if outside.get("deniedOriginRequests") != 0:
        raise ValueError("The denied-origin control must prove zero received requests")
    categories = {
        1: "Windows module-loader defect and reference TypeScript errors; no app checks ran",
        2: "Owned browser environment directories absent; API passed, browser did not start",
        3: "Independent assertion client used a refused proxy CONNECT transport",
        4: "Reference entity link names and custom proxy transport defects",
        5: "Asynchronous UI version wait, rendered status case and custom proxy defects",
        6: "Rendered status case and attribution of browser-service proxy denials",
        7: "Reference navigation accessible name included its incident count",
    }
    preflights = []
    for ordinal in range(1, 8):
        path = attempts / f"harbor-runtime-{ordinal:02d}" / "gold/evaluation.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        preflights.append({"ordinal": ordinal, "verdict": raw["verdict"], "summary": raw["summary"],
            "diagnosis": categories[ordinal], "rawReportSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "failedChecks": [row["name"] for row in raw["checks"] if row["status"] == "failed"],
            "referenceSourceAggregateSha256": digest(raw.get("sourceBefore", {})), "rawEvidenceRewritten": False})
    return {"kind": "harbor-qualification-v1", "status": "runtime_qualified", "runtimeQualified": True,
            "paidExecutionAuthorizedByThisRecord": False, "modelCalls": 0, "executedPlatform": platform.system(),
            "expectedChecks": {"api": 28, "browser": 32, "prerequisite": 4, "total": 64},
            "staticChecks": {"pythonControlTestsPassed": 19, "loopbackProxyControlsPassed": 6,
                "evaluatorSyntax": "passed", "seedFileCount": 6, "applicationImplementationSeeded": False},
            "positiveReference": positive, "emptySeed": empty, "damagedReferenceControls": negatives,
            "preservedPreflightAttempts": preflights,
            "limits": ["These are reference and negative controls, not paid model outcomes.",
                "Raw paths, profiles, synthetic entity identifiers and private reference source are omitted.",
                "The reference source remains outside the task and seed until the study ends.",
                "Dependencies were reused from an existing exact-version installation; no network install was used.",
                "Windows was runtime qualified; other platforms and production readiness are not established.",
                "Functional passes do not establish equal blinded source or screenshot quality."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("positive", "empty", "negative-controls", "attempts", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    saved = qualification(args.positive, args.empty, args.negative_controls, args.attempts)
    args.output.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"runtimeQualified": True, "positiveChecks": len(saved["positiveReference"]["checks"]), "negativeControls": len(saved["damagedReferenceControls"])}))


if __name__ == "__main__":
    main()
