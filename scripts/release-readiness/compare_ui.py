"""Run the common UI harness serially with explicit build roots and AC evidence."""

import argparse
from collections import Counter
import ctypes
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time


class PowerStatus(ctypes.Structure):
    _fields_ = [
        ("ac", ctypes.c_ubyte), ("flags", ctypes.c_ubyte),
        ("battery", ctypes.c_ubyte), ("reserved", ctypes.c_ubyte),
        ("remaining", ctypes.c_uint32), ("full", ctypes.c_uint32),
    ]


def power():
    status = PowerStatus()
    if os.name != "nt" or not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
        raise RuntimeError("Windows AC status is required for this comparison")
    return {"atUtc": datetime.now(timezone.utc).isoformat(), "acLineStatus": status.ac, "batteryPercent": status.battery}


def scenario_repeats_complete(records, repeats):
    names = ["opens an unvisited task without a blank frame",
             "opens the new session page before its lazy module is used",
             "opens a child session without a blank frame"]
    expected = {("performance: first navigation paint > " + name, repeat) for name in names for repeat in range(repeats)}
    return (len(records) == len(expected)
            and {(item.get("name"), item.get("repeatEachIndex")) for item in records} == expected
            and all(item.get("retry") == 0 and item.get("status") == "passed" for item in records))


def stop_owned(process):
    if process.poll() is not None:
        return
    try:
        # Only this wrapper's owned test process and its build/browser descendants.
        subprocess.run([str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"),
                        "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--candidate-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--port", type=int, default=4487)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--order", choices=["baseline-first", "candidate-first"], default="baseline-first")
    options = parser.parse_args()
    if options.repeats < 1 or not 1024 <= options.port <= 65535:
        parser.error("repeats must be positive and port must be between 1024 and 65535")
    if power()["acLineStatus"] != 1:
        raise RuntimeError("Connect AC power before starting the comparison")
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    candidate = options.candidate_root.resolve()
    toolkit = Path(__file__).resolve().parents[2]
    config = toolkit / "scripts/release-readiness/compare-ui.playwright.config.ts"
    command = ["bun", "x", "--no-install", "playwright", "test", "--config", str(config),
               "timeline/first-navigation-benchmark.spec.ts", "--project", "chromium", "--workers", "1",
               "--repeat-each", str(options.repeats), "--retries", "0"]
    arms = [("baseline", options.baseline_root.resolve()), ("candidate", candidate)]
    if options.order == "candidate-first":
        arms.reverse()
    context = {"order": [label for label, _ in arms], "repeatsPerScenario": options.repeats,
               "harnessRevision": subprocess.check_output(["git", "-C", str(toolkit), "rev-parse", "HEAD"], text=True).strip(),
               "command": command, "profiler": "off", "powerScheme": subprocess.check_output(["powercfg", "/getactivescheme"], text=True).strip(),
               "node": subprocess.check_output(["node", "--version"], text=True).strip(),
               "bun": subprocess.check_output(["bun", "--version"], text=True).strip()}
    (output / "context.json").write_text(json.dumps(context, indent=2) + "\n", encoding="utf-8")
    results = []
    for label, build in arms:
        if power()["acLineStatus"] != 1:
            raise RuntimeError("AC power lost; retained partial results are not a matched comparison")
        arm = output / label
        arm.mkdir()
        revision = subprocess.check_output(["git", "-C", str(build), "rev-parse", "HEAD"], text=True).strip()
        environment = {name: value for name, value in os.environ.items()
                       if not name.startswith(("VITE_", "SENTRY_", "VECTOR_PERFORMANCE", "PLAYWRIGHT_")) and name != "CI"}
        environment.update(VECTOR_CHANNEL="dev", VECTOR_PERFORMANCE="1",
                           VECTOR_PERFORMANCE_RUN_ID=output.name + "-" + label,
                           VECTOR_BENCHMARK_BUILD_ROOT=str(build), VECTOR_BENCHMARK_OUTPUT=str(arm),
                           PLAYWRIGHT_PORT=str(options.port), PLAYWRIGHT_SERVER_PORT=str(options.port),
                           PLAYWRIGHT_SERVER_HOST="127.0.0.1", PLAYWRIGHT_BASE_URL="http://127.0.0.1:" + str(options.port))
        print(label + " " + revision + " starting", flush=True)
        samples = []
        with (arm / "console.log").open("wb") as log, (arm / "power.jsonl").open("w", encoding="utf-8") as journal:
            process = subprocess.Popen(command, cwd=toolkit / "packages/app", env=environment, stdout=log, stderr=subprocess.STDOUT)
            started = time.monotonic()
            try:
                while True:
                    if time.monotonic() - started >= 1200:
                        raise TimeoutError("Benchmark arm exceeded its 20-minute completion bound")
                    sample = power()
                    samples.append(sample)
                    journal.write(json.dumps(sample) + "\n")
                    journal.flush()
                    try:
                        code = process.wait(timeout=10)
                        break
                    except subprocess.TimeoutExpired:
                        pass
            except BaseException:
                stop_owned(process)
                raise
            sample = power()
            samples.append(sample)
            journal.write(json.dumps(sample) + "\n")
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", (arm / "console.log").read_text(encoding="utf-8-sig"))
        records = [json.loads(line.split("BENCHMARK ", 1)[1]) for line in text.splitlines() if "BENCHMARK {" in line]
        result = {"arm": label, "revision": revision, "exitCode": code, "acAtEverySample": all(item["acLineStatus"] == 1 for item in samples),
                  "outcomes": dict(Counter(item["status"] for item in records)),
                  "scenarioRepeatsComplete": scenario_repeats_complete(records, options.repeats), "records": records}
        (arm / "results.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        results.append(result)
        print(json.dumps({key: value for key, value in result.items() if key != "records"}), flush=True)
    valid = all(item["exitCode"] == 0 and item["acAtEverySample"] and item["scenarioRepeatsComplete"] for item in results)
    (output / "completion.json").write_text(json.dumps({"matchedCompletion": valid, "qualification": "Descriptive local sample; fixed arm order, shared host activity and thermal/cache state remain possible confounders."}, indent=2) + "\n", encoding="utf-8")
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
