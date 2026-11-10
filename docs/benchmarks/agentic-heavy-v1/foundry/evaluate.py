"""Format-only adapter over the exact, previously qualified Foundry evaluator.

No model, provider credential, or application implementation is loaded here.
The original report and process logs remain in <out>/original and are never
rewritten. Unknown instrument outcomes do not become product passes.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from owned_process import execute

ROOT = Path(__file__).resolve().parent
STATUSES = {"passed", "failed", "not_run"}
PREREQUISITES = ("typecheck", "build", "startup", "source_integrity")


def inventory():
    tree = ast.parse((ROOT / "instrument/evaluate.py").read_text(encoding="utf-8"))
    assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "API_GROUPS" for target in node.targets))
    api = ast.literal_eval(assignment.value)
    browser = re.findall(r'await check\("([^"\n]+)"', (ROOT / "instrument/browser-eval.cjs").read_text(encoding="utf-8"))
    if len(api) != 32 or len(set(api)) != 32 or len(browser) != 40 or len(set(browser)) != 40:
        raise ValueError("historical check inventory changed")
    return api, browser


def normalize(raw, process):
    api_names, browser_names = inventory()
    rows = [{"name": "prerequisite:" + name, "category": "prerequisite", "status": "not_run"}
            for name in PREREQUISITES]
    rows.extend({"name": "api:" + name, "category": "api", "status": "not_run"} for name in api_names)
    rows.extend({"name": "browser:" + name, "category": "browser", "status": "not_run"} for name in browser_names)
    report = {"kind": "foundry-heavy-normalized-v1", "modelCalls": 0, "verdict": "instrument_failure",
              "checks": rows, "sourceUnchanged": False, "sourceIntegrityStatus": "not_assessed",
              "expectedApiGroups": 32, "expectedBrowserChecks": 40, "expectedPrerequisiteChecks": 4,
              "originalReport": "original/evaluation.json", "originalProcess": process,
              "rawReportRewritten": False, "allOriginalRequirementsRetained": True}
    by_name = {row["name"]: row for row in rows}
    try:
        if not isinstance(raw, dict) or process.get("timedOut") or process.get("exitCode") not in (0, 1):
            raise ValueError("original evaluator missing, crashed or timed out")
        if raw.get("kind") != "foundry-independent-evaluation" or raw.get("modelCalls") != 0:
            raise ValueError("unexpected original evaluator report")
        builds = raw.get("build")
        if not isinstance(builds, dict) or set(builds) != {"typecheck", "build"}:
            raise ValueError("original build inventory missing")
        for name in ("typecheck", "build"):
            step = builds[name]
            if not isinstance(step, dict) or not isinstance(step.get("exitCode"), int) or isinstance(step.get("exitCode"), bool) or not isinstance(step.get("timedOut"), bool):
                raise ValueError("unknown original build outcome")
            passed = step["exitCode"] == 0 and not step["timedOut"]
            by_name["prerequisite:" + name].update(status="passed" if passed else "failed",
                **({} if passed else {"error": "Required " + name + " did not complete successfully"}))
        startup = raw.get("startup", {}).get("status") == "passed"
        by_name["prerequisite:startup"].update(status="passed" if startup else "failed",
            **({} if startup else {"error": "Owned application did not start or remain evaluable"}))
        source = raw.get("sourceIntegrityStatus")
        if source not in ("unchanged", "modified", "not_assessed") or raw.get("applicationSourceUnchanged") is not (True if source == "unchanged" else False if source == "modified" else None):
            raise ValueError("source-integrity observations disagree")
        by_name["prerequisite:source_integrity"]["status"] = "passed" if source == "unchanged" else "failed" if source == "modified" else "not_run"
        report.update(sourceUnchanged=source == "unchanged", sourceIntegrityStatus=source)
        apis = raw.get("api")
        if not isinstance(apis, list) or len(apis) != 32 or any(not isinstance(item, dict) for item in apis) or {item.get("name") for item in apis} != set(api_names):
            raise ValueError("original API inventory changed")
        for category, items in (("api", apis),):
            for item in items:
                if item.get("status") not in STATUSES:
                    raise ValueError("unknown original check outcome")
                by_name[category + ":" + item["name"]].update({key: value for key, value in item.items() if key != "name"})
                if "reason" in item:
                    by_name[category + ":" + item["name"]]["error"] = item["reason"]
        api_passed = sum(item["status"] == "passed" for item in apis)
        if raw.get("apiPassed") != api_passed or raw.get("apiTotal") != 32:
            raise ValueError("original API counters disagree")
        password = next(item for item in apis if item["name"] == "sessions_password_storage")
        if password["status"] == "passed" and password.get("facts", {}).get("postStopPasswordVerification") is not True:
            raise ValueError("original post-stop password verification evidence missing")
        browser = raw.get("browser")
        if not isinstance(browser, dict):
            raise ValueError("original browser outcome missing")
        results = browser.get("results")
        browser_passed = False
        if results is not None:
            items = results.get("checks") if isinstance(results, dict) else None
            if not isinstance(items, list) or len(items) != 40 or any(not isinstance(item, dict) for item in items) or {item.get("name") for item in items} != set(browser_names):
                raise ValueError("original browser inventory changed")
            if any(item.get("status") not in STATUSES for item in items):
                raise ValueError("unknown original browser check outcome")
            counts = {"passed": sum(item["status"] == "passed" for item in items),
                      "failed": sum(item["status"] == "failed" for item in items),
                      "notRun": sum(item["status"] == "not_run" for item in items)}
            if results.get("summary") != counts:
                raise ValueError("original browser counters disagree")
            browser_process = browser.get("process", {})
            if browser_process.get("exitCode") not in (0, 1) or browser_process.get("timedOut") is not False:
                raise ValueError("browser process crashed or timed out")
            browser_passed = counts == {"passed": 40, "failed": 0, "notRun": 0}
            if (browser_process["exitCode"] == 0) != browser_passed:
                raise ValueError("browser exit and checks disagree")
            for item in items:
                by_name["browser:" + item["name"]].update({key: value for key, value in item.items() if key != "name"})
                if "reason" in item:
                    by_name["browser:" + item["name"]]["error"] = item["reason"]
        elif startup:
            raise ValueError("started application has no complete browser report")
        functional = api_passed == 32 and startup and all(builds[name]["exitCode"] == 0 and not builds[name]["timedOut"] for name in ("typecheck", "build"))
        full = functional and browser_passed and source == "unchanged"
        if raw.get("functionalGatePassed") is not functional or raw.get("browserGatePassed") is not browser_passed or raw.get("fullGatePassed") is not full or process["exitCode"] != (0 if full else 1):
            raise ValueError("original gate or exit contradicts preserved evidence")
        if source != "unchanged":
            raise ValueError("original source integrity requires review")
        report["verdict"] = "passed" if full else "product_failure"
        report["apiPassed"] = api_passed
        report["browserPassed"] = sum(item["category"] == "browser" and item["status"] == "passed" for item in rows)
        report["prerequisitePassed"] = sum(item["category"] == "prerequisite" and item["status"] == "passed" for item in rows)
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        report["instrumentError"] = str(error)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "out", "bun", "node", "playwright-module", "chrome"):
        parser.add_argument("--" + name, type=Path, required=True)
    options = parser.parse_args(argv)
    options.app, options.out = options.app.resolve(), options.out.resolve()
    if options.out.exists() or options.out.is_relative_to(options.app) or options.app.is_relative_to(options.out):
        raise SystemExit("new separate evaluation output required")
    options.out.mkdir(parents=True)
    command = [sys.executable, "-B", str(ROOT / "instrument/evaluate.py"), "--app", str(options.app),
        "--out", str(options.out / "original"), "--bun", str(options.bun.resolve()), "--node", str(options.node.resolve()),
        "--playwright-module", str(options.playwright_module.resolve()), "--chrome", str(options.chrome.resolve())]
    process = execute(command, options.app, dict(os.environ), options.out / "original-process", timeout=1440)
    raw_path = options.out / "original/evaluation.json"
    raw = None
    if raw_path.is_file() and raw_path.stat().st_size <= 16_777_216:
        try:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
        except ValueError:
            pass
    report = normalize(raw, process)
    report["originalReportSha256"] = hashlib.sha256(raw_path.read_bytes()).hexdigest() if raw_path.is_file() else None
    (options.out / "evaluation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in ("verdict", "apiPassed", "browserPassed", "prerequisitePassed", "sourceIntegrityStatus")}))
    return 0 if report["verdict"] == "passed" else 1 if report["verdict"] == "product_failure" else 2


if __name__ == "__main__":
    raise SystemExit(main())
