"""Draft complete independent gate. Explicit execution only; no repair or model calls."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error

import api_checks
import browser_checks
from oracle import InstrumentFailure, ProductFailure, canonical_digest, manifest, runtime_projection, verdict
from runtime import App


def bounded(value):
    rendered = json.dumps(value, default=str, ensure_ascii=False)
    return json.loads(rendered) if len(rendered) <= 2400 else rendered[:2400] + "…"


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "bun", "node", "task"):
        parser.add_argument("--" + name, type=Path, required=True)
    options = parser.parse_args()
    for key, value in vars(options).items():
        setattr(options, key, value.resolve())
    return options


def run(options):
    inventory = json.loads((options.task / "inventory.json").read_text(encoding="utf-8"))["checks"]
    rows = [{"name": item["name"], "status": "not_run", "expected": item["expected"]} for item in inventory]
    before = None
    instrument_before = None
    runtime_before = None
    error = None
    owned_output = False
    started = time.monotonic()
    try:
        if len(api_checks.CHECKS) != 18 or len(browser_checks.CHECKS) != 8 or len(rows) != 26:
            raise InstrumentFailure("Evaluator and inventory cardinalities differ")
        if options.out.exists() or options.out.is_relative_to(options.app) or options.out.is_relative_to(options.task):
            raise InstrumentFailure("Output must be new and outside both submission and task")
        options.out.mkdir(parents=True)
        owned_output = True
        if not options.bun.is_file() or not options.node.is_file():
            raise InstrumentFailure("Explicit Bun/Node executable is missing")
        for key in ("VECTOR_BENCH_CHROME", "VECTOR_BENCH_PLAYWRIGHT_MODULE", "VECTOR_BENCH_BROWSER_PROXY"):
            if not os.environ.get(key) or not Path(os.environ[key]).exists():
                raise InstrumentFailure("Independent browser prerequisite is missing: " + key)
        before = manifest(options.app)
        instrument_before = manifest(options.task, generated=("FREEZE-v1.json",))
        runtime_before = runtime_projection(options.task)
        checks = [*api_checks.CHECKS, *browser_checks.CHECKS]
        for index, check in enumerate(checks):
            if time.monotonic() - started > 740:
                raise InstrumentFailure("Evaluation reached its bounded total deadline")
            row = rows[index]
            try:
                with App(options, row["name"]) as app:
                    if index < 18:
                        check(app)
                    else:
                        with browser_checks.Browser(app) as browser:
                            check(app, browser)
                row.update(status="passed", actual="Observed all assertions for this independent scenario")
            except ProductFailure as failure:
                row.update(status="failed", expected=failure.expected, actual=bounded(failure.actual))
            except (OSError, urllib.error.URLError) as failure:
                raise InstrumentFailure("Evaluator-owned process or evidence I/O failed: " + str(failure)) from failure
            except InstrumentFailure:
                raise
            except Exception as failure:
                raise InstrumentFailure("Unexpected evaluator exception in " + row["name"] + ": " + type(failure).__name__ + ": " + str(failure)) from failure
            # Modified protected fixtures are a product failure, but their effects cannot be trusted for later checks.
            if index == 0 and row["status"] == "failed":
                protected = json.loads((options.task / "task.json").read_text(encoding="utf-8"))["protectedFiles"]
                if any(not (options.app / name).is_file() or (options.app / name).read_bytes() != (options.task / "seed" / name).read_bytes() for name in protected):
                    for remaining in rows[1:]:
                        remaining["actual"] = "Not run: protected provider or package pins were modified"
                    break
    except Exception as failure:
        error = type(failure).__name__ + ": " + str(failure)
    try:
        unchanged = before is not None and before == manifest(options.app)
        instrument_unchanged = instrument_before is not None and instrument_before == manifest(options.task, generated=("FREEZE-v1.json",))
        if not instrument_unchanged and instrument_before is not None:
            error = "Independent task instrument changed during evaluation"
    except Exception as failure:
        unchanged = False
        instrument_unchanged = False
        error = "Source integrity could not be verified: " + str(failure)
    report = {"version": "delivery-outbox-evaluation-v1", "taskStatus": "frozen" if (options.task / "FREEZE-v1.json").is_file() else "draft-not-frozen",
              "verdict": verdict(rows, inventory, unchanged, error), "sourceUnchanged": unchanged,
              "instrumentUnchanged": instrument_unchanged,
              "instrumentProjectionSha256": canonical_digest(instrument_before) if instrument_before is not None else None,
              "runtimeProjectionSha256": canonical_digest(runtime_before) if runtime_before is not None else None,
              "sourceIntegrityStatus": "unchanged" if unchanged else "unverified_or_changed",
              "checks": rows, "instrumentError": error, "elapsedSeconds": round(time.monotonic() - started, 3),
              "providerCalls": "Only benchmark-local synthetic HTTP fixture; no model/cloud calls"}
    if not owned_output:
        # Never create a rejected output inside source, or overwrite a preexisting output.
        print(json.dumps(report, ensure_ascii=False))
        return 2
    target = options.out / "evaluation.json"
    if target.exists():
        print(json.dumps({"verdict": "instrument_failure", "reason": "report already exists"}))
        return 2
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"verdict": report["verdict"], "checks": len(rows), "report": str(target)}))
    return 0 if report["verdict"] == "passed" else 1 if report["verdict"] == "product_failure" else 2


if __name__ == "__main__":
    sys.exit(run(arguments()))
