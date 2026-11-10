"""Independent local evaluator: fixed inventory, explicit product/instrument boundary."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import traceback

from api_checks import Acceptance, Client, ProductFailure, require
from integrity import digest, manifest
from inventory import BROWSER_CHECKS, CHECKS, blank_checks


PATH_VARIABLES = {
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
}


def clean_environment(extra=None):
    # Chrome needs native Windows path variables even with an explicit owned profile.
    value = {key: item for key, item in os.environ.items() if key.upper() in PATH_VARIABLES}
    value.update({"NO_COLOR": "1", "CI": "1", **(extra or {})})
    return value


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def executable(value):
    target = shutil.which(value)
    if target is None or not Path(target).is_file():
        raise RuntimeError("Required local executable is unavailable: " + Path(value).name)
    return str(Path(target).resolve())


def verdict(checks, unchanged=True, instrument_errors=()):
    if not unchanged or instrument_errors:
        return "instrument_failure", 2
    if any(row["status"] == "failed" for row in checks):
        return "product_failure", 1
    if all(row["status"] == "passed" for row in checks):
        return "passed", 0
    return "instrument_failure", 2


class Evaluator:
    def __init__(self, args):
        self.args = args
        self.checks = blank_checks()
        self.rows = {row["name"]: row for row in self.checks}
        self.instrument_errors = []
        self.screenshots = []
        self.process = None
        self.process_log = None
        self.launch_count = 0
        self.port = free_port()
        self.client = Client(f"http://127.0.0.1:{self.port}")

    def instrument(self, message):
        self.instrument_errors.append(message)
        with (self.args.out / "instrument-errors.ndjson").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"classification": "instrument_failure", "message": message}, ensure_ascii=False) + "\n")

    def run(self, name, action):
        try:
            action()
        except (ProductFailure, AssertionError) as error:
            self.rows[name].update(status="failed", detail=str(error)[:450])
        except (KeyError, IndexError, AttributeError, TypeError) as error:
            # JSON object/array shape errors are failures of the public response contract.
            self.rows[name].update(status="failed", detail="API response shape did not satisfy the public contract: " + type(error).__name__)
        else:
            self.rows[name]["status"] = "passed"

    def command(self, arguments, label, timeout=50):
        with (self.args.out / (label + ".log")).open("wb") as log:
            try:
                result = subprocess.run(arguments, cwd=self.args.app, env=clean_environment(),
                                        stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                raise ProductFailure(label + " exceeded its local build timeout.") from error
        require(result.returncode == 0, label + " failed; see retained local build log.")

    def launch(self, directory, port):
        self.launch_count += 1
        log = (self.args.out / f"server-{self.launch_count}.log").open("wb")
        try:
            process = subprocess.Popen([self.args.bun, "server/index.ts"], cwd=self.args.app,
                                       env=clean_environment({"PORT": str(port), "DATA_DIR": str(directory)}),
                                       stdout=log, stderr=subprocess.STDOUT)
        except OSError:
            log.close()
            raise
        client = Client(f"http://127.0.0.1:{port}")
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log.close()
                raise ProductFailure("Application server exited during startup.")
            try:
                value = client.get("/api/health")
                if value.get("ok") is True:
                    return process, log
            except ProductFailure:
                pass
            time.sleep(.1)
        self.stop_process(process, log)
        raise ProductFailure("Application server never became healthy.")

    @staticmethod
    def stop_process(process, log):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=4)
        if log:
            log.close()

    def restart(self):
        self.stop_process(self.process, self.process_log)
        self.process, self.process_log = self.launch(self.args.out / "data", self.port)

    @contextmanager
    def secondary(self, directory):
        port = free_port()
        process, log = self.launch(directory, port)
        try:
            yield Client(f"http://127.0.0.1:{port}")
        finally:
            self.stop_process(process, log)

    def startup(self):
        for command, label in [([self.args.bun, "run", "typecheck"], "typecheck"),
                               ([self.args.bun, "test", "tests/smoke.test.ts"], "public-smoke"),
                               ([self.args.bun, "run", "build"], "build")]:
            self.command(command, label)
        self.process, self.process_log = self.launch(self.args.out / "data", self.port)
        health = self.client.get("/api/health")
        require(health.get("ok") is True, "Health check must be successful.")
        if health.get("schemaVersion") == 2:
            require(type(health.get("revision")) is int and health["revision"] == 0,
                    "A fresh v2 collection must begin at revision 0.")

    def browser(self):
        chrome = os.environ.get("VECTOR_BENCH_CHROME")
        playwright = os.environ.get("VECTOR_BENCH_PLAYWRIGHT_MODULE")
        proxy = os.environ.get("VECTOR_BENCH_BROWSER_PROXY")
        if not all(value and Path(value).exists() for value in [chrome, playwright, proxy]):
            self.instrument("Explicit Chrome, Playwright package, and frozen HTTP loopback proxy paths are required.")
            return
        environment = clean_environment({
            "VECTOR_BENCH_CHROME": str(Path(chrome).resolve()),
            "VECTOR_BENCH_PLAYWRIGHT_MODULE": str(Path(playwright).resolve()),
            "VECTOR_BENCH_BROWSER_PROXY": str(Path(proxy).resolve()),
        })
        with (self.args.out / "browser.log").open("wb") as log:
            try:
                result = subprocess.run([self.args.node, str(self.args.task / "browser.cjs"),
                                         "--origin", self.client.origin, "--out", str(self.args.out)],
                                        env=environment, cwd=self.args.task, stdout=log,
                                        stderr=subprocess.STDOUT, timeout=105)
            except subprocess.TimeoutExpired:
                self.instrument("Owned Chrome acceptance process exceeded its infrastructure timeout; log retained.")
                return
        report_path = self.args.out / "browser.json"
        if not report_path.is_file():
            self.instrument("Browser process did not emit its fixed-inventory report.")
            return
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
            rows = report["checks"]
            valid = (isinstance(rows, list) and [row["name"] for row in rows] == BROWSER_CHECKS
                     and all(row["status"] in {"passed", "failed", "not_run"} for row in rows))
            if not valid:
                raise ValueError("Malformed browser check inventory")
            for row in rows:
                self.rows[row["name"]].update(row)
            artifacts = report.get("screenshots", [])
            if isinstance(artifacts, list):
                self.screenshots = [name for name in artifacts if name in {"browser-final.png", "browser-mobile.png"}]
            if report.get("instrumentError"):
                self.instrument(str(report["instrumentError"])[:1000])
            expected = 2 if report.get("instrumentError") else (1 if any(row["status"] == "failed" for row in rows) else 0)
            if result.returncode != expected or (expected == 0 and any(row["status"] != "passed" for row in rows)):
                self.instrument("Browser report and exit status disagree or contain unexecuted checks.")
        except (ValueError, KeyError, TypeError) as error:
            self.instrument("Browser report was invalid: " + type(error).__name__)

    def execute(self):
        self.run("api.startup", self.startup)
        if self.rows["api.startup"]["status"] != "passed":
            return
        Acceptance(self.client, self.run, self.restart, self.secondary, self.args.out).execute()
        self.browser()


def main(argv=None):
    parser = argparse.ArgumentParser()
    for flag in ["app", "out", "bun", "node", "task"]:
        parser.add_argument("--" + flag, required=True)
    args = parser.parse_args(argv)
    args.app, args.out, args.task = (Path(getattr(args, name)).resolve() for name in ["app", "out", "task"])
    if args.out == args.app or args.out.is_relative_to(args.app) or args.out == args.task or args.out.is_relative_to(args.task):
        parser.error("Evaluator output must be outside the app and task trees.")
    args.out.mkdir(parents=True, exist_ok=True)
    if (args.out / "evaluation.json").exists() or (args.out / "browser.json").exists():
        parser.error("Refusing to reuse an existing evaluator report directory.")
    evaluator = Evaluator(args)
    before = manifest(args.app)
    protected_ok = True
    try:
        descriptor = json.loads((args.task / "task.json").read_text(encoding="utf-8"))
        require(descriptor["generatedDirectories"] == ["dist"], "Generated-root contract changed.")
        for name in ["TASK.md", *descriptor["protectedFiles"]]:
            source = args.task / "TASK.md" if name == "TASK.md" else args.task / "seed" / name
            target = args.app / name
            if not target.is_file() or target.read_bytes() != source.read_bytes():
                protected_ok = False
                evaluator.instrument("A protected public task file changed or is missing: " + name)
        if protected_ok:
            args.bun, args.node = executable(args.bun), executable(args.node)
            evaluator.execute()
    except Exception as error:
        evaluator.instrument("Evaluator infrastructure exception: " + type(error).__name__ + ": " + str(error)[:600])
        (args.out / "instrument-traceback.log").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        evaluator.stop_process(evaluator.process, evaluator.process_log)
    after = manifest(args.app)
    unchanged = before == after and protected_ok
    if before != after:
        evaluator.instrument("Evaluation mutated authored app source; before/after manifests retained.")
    result, exit_code = verdict(evaluator.checks, unchanged, evaluator.instrument_errors)
    report = {
        "verdict": result, "sourceUnchanged": unchanged,
        "checks": evaluator.checks,
        "apiGroups": 18, "browserChecks": 8,
        "sourceBeforeSha256": digest(before), "sourceAfterSha256": digest(after),
        "instrumentErrors": evaluator.instrument_errors,
        "screenshots": evaluator.screenshots,
    }
    (args.out / "source-before.json").write_text(json.dumps(before, indent=2) + "\n", encoding="utf-8")
    (args.out / "source-after.json").write_text(json.dumps(after, indent=2) + "\n", encoding="utf-8")
    (args.out / "evaluation.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"verdict": result, "checks": {status: sum(row["status"] == status for row in evaluator.checks) for status in ["passed", "failed", "not_run"]}, "sourceUnchanged": unchanged}))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
