"""Local-only ownership regression tests; no authored service is needed."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import owned_process


class OwnershipTests(unittest.TestCase):
    def test_run_preserves_pipes_and_check(self):
        result = owned_process.run([sys.executable, "-c",
            "import sys; print(sys.stdin.read().upper()); print('diagnostic', file=sys.stderr)"],
            input="synthetic", capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(result.stdout, "SYNTHETIC\n")
        self.assertEqual(result.stderr, "diagnostic\n")
        with self.assertRaises(subprocess.CalledProcessError) as error:
            owned_process.run([sys.executable, "-c", "import sys; print('failure'); sys.exit(7)"],
                              capture_output=True, text=True, timeout=5, check=True)
        self.assertEqual(error.exception.returncode, 7)
        self.assertEqual(error.exception.stdout, "failure\n")

    def test_timeout_preserves_output(self):
        with self.assertRaises(subprocess.TimeoutExpired) as error:
            owned_process.run([sys.executable, "-c",
                "import time; print('started', flush=True); time.sleep(30)"],
                capture_output=True, text=True, timeout=.5)
        self.assertEqual(error.exception.stdout, "started\n")

    def test_cleanup_does_not_stop_another_owned_job(self):
        first = owned_process.spawn([sys.executable, "-c", "import time; time.sleep(30)"])
        second = owned_process.spawn([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            first.close()
            self.assertIsNone(second.process.poll())
        finally:
            first.close()
            second.close()

    def test_readers_reach_eof_before_pipe_cleanup(self):
        owned = owned_process.spawn([sys.executable, "-c",
            "import time; print('ready', flush=True); time.sleep(30)"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready = threading.Event()
        lines = []
        failures = []
        def read():
            try:
                for line in owned.process.stdout:
                    lines.append(line)
                    ready.set()
            except Exception as error:
                failures.append(error)
        reader = threading.Thread(target=read)
        reader.start()
        try:
            self.assertTrue(ready.wait(5))
            owned.close()
            reader.join(timeout=5)
            self.assertFalse(reader.is_alive())
            self.assertEqual(lines, ["ready\n"])
            self.assertEqual(failures, [])
        finally:
            owned.close()
            reader.join(timeout=5)

    def _tree(self, parent_exits=False):
        folder = tempfile.TemporaryDirectory(prefix="relay-owned-process-test-")
        marker = Path(folder.name) / "child.pid"
        # The helper records its own PID after it actually starts. It naturally
        # exits if a regression breaks containment, leaving no permanent leak.
        helper = "import os,time,pathlib; pathlib.Path(%r).write_text(str(os.getpid())); time.sleep(4)" % str(marker)
        parent = (
            "import subprocess,sys,time,pathlib; "
            "subprocess.Popen([sys.executable,'-c',%r], stdin=subprocess.DEVNULL, "
            "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL, %s); "
            "marker=pathlib.Path(%r); "
            "\nwhile not marker.exists(): time.sleep(.01)\n"
            "print('ready',flush=True); %s"
        ) % (helper, "creationflags=0x00000008" if os.name == "nt" else "start_new_session=False",
             str(marker), "" if parent_exits else "time.sleep(30)")
        owned = owned_process.spawn([sys.executable, "-c", parent], stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(owned.process.stdout.readline().strip(), "ready")
            child_pid = int(marker.read_text())
            if os.name == "nt":
                import ctypes
                from ctypes import wintypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
                kernel.OpenProcess.restype = wintypes.HANDLE
                kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
                kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                handle = kernel.OpenProcess(0x00100000, False, child_pid)
                self.assertTrue(handle)
                try:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258)
                    if parent_exits:
                        self.assertEqual(owned.process.wait(timeout=5), 0)
                    owned.close()
                    self.assertEqual(kernel.WaitForSingleObject(handle, 1000), 0)
                finally:
                    # Wait for the bounded synthetic helper even after failure.
                    kernel.WaitForSingleObject(handle, 5000)
                    kernel.CloseHandle(handle)
            else:
                if parent_exits:
                    self.assertEqual(owned.process.wait(timeout=5), 0)
                owned.close()
                # No PID signals or global enumeration; /proc observes only the
                # exact helper created above, allowing an already-dead zombie.
                stat = Path("/proc") / str(child_pid) / "stat"
                if stat.exists():
                    self.assertEqual(stat.read_text().split()[2], "Z")
            owned.close()
            self.assertTrue(owned.process.stdout.closed)
            self.assertTrue(owned.process.stderr.closed)
        finally:
            owned.close()
            folder.cleanup()

    def test_close_kills_detached_helper(self):
        self._tree()

    def test_close_kills_helper_after_parent_exits(self):
        self._tree(parent_exits=True)

    @unittest.skipUnless(os.name == "nt", "Windows suspended-start failure boundary")
    def test_assignment_failure_never_executes_child(self):
        with tempfile.TemporaryDirectory(prefix="relay-owned-start-failure-") as folder:
            marker = Path(folder) / "must-not-exist"
            with mock.patch.object(owned_process._kernel, "AssignProcessToJobObject", return_value=0):
                with self.assertRaises(OSError):
                    owned_process.spawn([sys.executable, "-c",
                        "from pathlib import Path; Path(%r).write_text('executed')" % str(marker)])
            self.assertFalse(marker.exists())

    @unittest.skipUnless(os.name == "nt", "Windows suspended-start failure boundary")
    def test_resume_failure_never_executes_child(self):
        with tempfile.TemporaryDirectory(prefix="relay-owned-resume-failure-") as folder:
            marker = Path(folder) / "must-not-exist"
            with mock.patch.object(owned_process._native, "NtResumeProcess", return_value=-1073741790):
                with self.assertRaises(OSError):
                    owned_process.spawn([sys.executable, "-c",
                        "from pathlib import Path; Path(%r).write_text('executed')" % str(marker)])
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
