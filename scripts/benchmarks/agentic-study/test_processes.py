"""Owned-process and browser supervision controls with no real child processes."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import browser_driver
import owned_process


class FakeJob:
    def __init__(self):
        self.closed = False
        self.assigned = []

    def assign(self, process):
        self.assigned.append(process)

    def close(self):
        self.closed = True


class FakeProcess:
    def __init__(self, running=True):
        self.pid = 12345
        self.running = running
        self.returncode = None if running else 0
        self.terminated = False
        self.killed = False

    def poll(self):
        return None if self.running else self.returncode

    def terminate(self):
        self.terminated = True
        self.running = False
        self.returncode = -1

    def kill(self):
        self.killed = True
        self.running = False
        self.returncode = -9

    def wait(self, timeout=None):
        self.running = False
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class CapturedInput:
    def __init__(self):
        self.value = ""
        self.closed = False

    def write(self, value):
        self.value += value

    def close(self):
        self.closed = True


class OwnedProcessTests(unittest.TestCase):
    def test_browser_keeps_native_os_paths_without_inheriting_credentials(self):
        source = {"USERPROFILE": "native-profile", "TEMP": "native-temp", "PATH": "native-path",
                  "OPENAI_API_KEY": "private-provider", "BENCH_API_KEY": "private-scope",
                  "BENCH_BROWSER_TOKEN": "private-other-browser", "NODE_OPTIONS": "private-loader"}
        self.assertEqual(browser_driver.browser_environment(source),
                         {"PATH": "native-path", "USERPROFILE": "native-profile", "TEMP": "native-temp"})

    def test_monitor_stop_closes_only_the_created_owned_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, job = FakeProcess(), FakeJob()
            with patch.object(owned_process, "OwnedJob", return_value=job), patch.object(owned_process.subprocess, "Popen", return_value=process), patch.object(owned_process.os, "name", "nt"):
                result = owned_process.execute(["synthetic-cli"], root, {}, root / "agent", 30, monitor=lambda: "case_stop_threshold", clock=lambda: 0)
            self.assertEqual(result["stopReason"], "case_stop_threshold")
            self.assertEqual(job.assigned, [process])
            self.assertTrue(job.closed)
            self.assertFalse(process.killed)

    def test_success_also_closes_descendants_in_the_owned_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, job = FakeProcess(running=False), FakeJob()
            with patch.object(owned_process, "OwnedJob", return_value=job), patch.object(owned_process.subprocess, "Popen", return_value=process), patch.object(owned_process.os, "name", "nt"):
                result = owned_process.execute(["synthetic-cli"], root, {}, root / "agent", 30, clock=lambda: 0)
            self.assertEqual(result["exitCode"], 0)
            self.assertIsNone(result["stopReason"])
            self.assertTrue(job.closed)

    def test_monitor_failure_still_closes_the_owned_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, job = FakeProcess(), FakeJob()
            def failed():
                raise RuntimeError("synthetic unavailable budget status")
            with patch.object(owned_process, "OwnedJob", return_value=job), patch.object(owned_process.subprocess, "Popen", return_value=process), patch.object(owned_process.os, "name", "nt"):
                with self.assertRaises(RuntimeError):
                    owned_process.execute(["synthetic-cli"], root, {}, root / "agent", 30, monitor=failed, clock=lambda: 0)
            self.assertTrue(job.closed)

    def test_time_limit_is_explicit_and_does_not_launch_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process, job = FakeProcess(), FakeJob()
            times = iter([0, 31, 31])
            with patch.object(owned_process, "OwnedJob", return_value=job), patch.object(owned_process.subprocess, "Popen", return_value=process) as launch, patch.object(owned_process.os, "name", "nt"):
                result = owned_process.execute(["synthetic-cli"], root, {}, root / "agent", 30, clock=lambda: next(times))
            self.assertTrue(result["timedOut"])
            self.assertEqual(launch.call_count, 1)
            self.assertTrue(job.closed)


class BrowserDriverTests(unittest.TestCase):
    def driver(self, root, value=None):
        output = root / "new-browser"
        process, job = FakeProcess(), FakeJob()
        process.stdin = CapturedInput()
        process.stdout = io.StringIO(json.dumps(value or {"ready": True, "endpoint": "http://127.0.0.1:54321", "out": str(output), "origins": ["http://127.0.0.1:4123"]}) + "\n")
        driver = browser_driver.BrowserDriver(node=root / "node", root=root / "driver", playwright=root / "playwright", chrome=root / "chrome", output=output, origin="http://127.0.0.1:4123")
        return driver, process, job

    def test_local_token_is_sent_on_stdin_and_never_in_argv_or_saved_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver, process, job = self.driver(root)
            with patch.object(browser_driver, "OwnedJob", return_value=job), patch.object(browser_driver.subprocess, "Popen", return_value=process) as launch, patch.object(browser_driver.os, "name", "nt"):
                with driver as active:
                    self.assertEqual(process.stdin.value, active.token + "\n")
                    self.assertTrue(process.stdin.closed)
                    self.assertEqual(active.environment["BENCH_BROWSER_TOKEN"], active.token)
                    self.assertNotIn(active.token, json.dumps(active.metadata))
                    self.assertNotIn(active.token, json.dumps(launch.call_args.args[0]))
            self.assertTrue(process.terminated)
            self.assertTrue(job.closed)

    def test_invalid_ready_origin_fails_before_funding_and_cleans_owned_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver, process, job = self.driver(root, {"ready": True, "endpoint": "http://127.0.0.1:54321", "out": str(root / "new-browser"), "origins": ["http://127.0.0.1:9999"]})
            with patch.object(browser_driver, "OwnedJob", return_value=job), patch.object(browser_driver.subprocess, "Popen", return_value=process), patch.object(browser_driver.os, "name", "nt"):
                with self.assertRaises(ValueError):
                    driver.__enter__()
            self.assertTrue(process.terminated)
            self.assertTrue(job.closed)

    def test_nonloopback_ready_endpoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver, process, job = self.driver(root, {"ready": True, "endpoint": "https://example.invalid", "out": str(root / "new-browser"), "origins": ["http://127.0.0.1:4123"]})
            with patch.object(browser_driver, "OwnedJob", return_value=job), patch.object(browser_driver.subprocess, "Popen", return_value=process), patch.object(browser_driver.os, "name", "nt"):
                with self.assertRaises(ValueError):
                    driver.__enter__()
            self.assertTrue(job.closed)

    def test_existing_browser_output_is_not_reused_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver, _, _ = self.driver(root)
            driver.output.mkdir()
            marker = driver.output / "existing.txt"
            marker.write_text("preserve", encoding="utf-8")
            with patch.object(browser_driver.subprocess, "Popen", side_effect=AssertionError("Must not launch")):
                with self.assertRaises(ValueError):
                    driver.__enter__()
            self.assertEqual(marker.read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
