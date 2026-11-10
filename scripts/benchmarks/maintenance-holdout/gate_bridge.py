"""Normalize the independent 54-check headless gate for the native team runner.

No product requirement or evaluator assertion is changed. The original report
is kept in raw-evaluation, and every boolean row maps to one passed/failed row.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import owned_process


def require(value, message):
    if not value:
        raise ValueError(message)


def manifest(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob("*")) if path.is_file() and "node_modules" not in path.parts}


def normalize(report, exit_code, unchanged):
    require(unchanged, "independent evaluation changed authored source")
    require(isinstance(report, dict) and report.get("kind") == "ledgerdesk-maintenance-gate-v1"
            and report.get("mode") == "bun-qualification", "unrecognized independent report")
    rows = report.get("checks")
    require(isinstance(rows, list) and len(rows) == 54 and len({row.get("name") for row in rows}) == 54,
            "independent check inventory changed")
    require(all(isinstance(row.get("name"), str) and row.get("scope") in ("business", "prerequisite")
                and type(row.get("passed")) is bool for row in rows), "independent check row invalid")
    require(sum(row["scope"] == "business" for row in rows) == 50, "business inventory changed")
    count = sum(row["passed"] for row in rows)
    business = sum(row["passed"] for row in rows if row["scope"] == "business")
    require(report.get("checksTotal") == 54 and report.get("businessTotal") == 50
            and report.get("prerequisitesTotal") == 4 and report.get("checksPassed") == count
            and report.get("businessPassed") == business and report.get("prerequisitesPassed") == count - business
            and report.get("passed") is (count == 54) and exit_code == (0 if count == 54 else 2),
            "independent counts, verdict and process disagree")
    normalized = [{"name": row["name"], "category": "api" if row["scope"] == "business" else "prerequisite",
                   "status": "passed" if row["passed"] else "failed",
                   **{key: row[key] for key in ("error", "detail") if key in row}} for row in rows]
    return {"kind": "maintenance-native-gate-bridge-v1", "verdict": "passed" if count == 54 else "product_failure",
            "sourceIntegrityStatus": "unchanged", "checks": normalized,
            "summary": {category: {status: sum(row["category"] == category and row["status"] == status for row in normalized)
                                     for status in ("passed", "failed", "not_run")}
                        for category in ("api", "browser", "prerequisite")},
            "allIndependentRowsRetained": True, "checksPassed": count, "checksTotal": 54}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "runtime", "node", "typescript"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--mode", choices=("bun-qualification",), required=True)
    options = parser.parse_args(argv)
    for name, value in vars(options).items():
        if isinstance(value, Path):
            setattr(options, name, value.resolve())
    require(options.out != options.app and not options.out.is_relative_to(options.app), "output overlaps authored app")
    options.out.mkdir(parents=True, exist_ok=False)
    raw = options.out / "raw-evaluation"
    before = manifest(options.app)
    command = [sys.executable, str(Path(__file__).with_name("evaluate.py")), "--app", str(options.app),
               "--out", str(raw), "--runtime", str(options.runtime), "--node", str(options.node),
               "--typescript", str(options.typescript), "--mode", options.mode]
    result = owned_process.run(command, cwd=options.app, capture_output=True, text=True, timeout=175)
    report = normalize(json.loads((raw / "evaluation.json").read_text(encoding="utf-8")),
                       result.returncode, before == manifest(options.app))
    (options.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0 if report["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
