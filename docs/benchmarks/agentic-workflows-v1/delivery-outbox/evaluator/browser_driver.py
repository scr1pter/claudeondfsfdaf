"""Supervise a fresh benchmark-owned common browser; no provider credentials."""
import json
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import queue
import secrets
import signal
import subprocess
import threading

from owned_process import OwnedJob


def browser_environment(source=None):
    # The coding/evaluation home can be virtual. Query native path metadata only;
    # never read a user profile or pass model/controller capabilities to Chrome.
    if source is None and os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        security = ctypes.WinDLL("advapi32", use_last_error=True)
        user = ctypes.WinDLL("userenv", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        security.OpenProcessToken.restype = wintypes.BOOL
        user.ExpandEnvironmentStringsForUserW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        user.ExpandEnvironmentStringsForUserW.restype = wintypes.BOOL
        token = wintypes.HANDLE()
        if not security.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise OSError("Could not query native browser path metadata")
        try:
            result = {}
            for name in ("SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"):
                value = ctypes.create_unicode_buffer(32768)
                if not user.ExpandEnvironmentStringsForUserW(token, "%" + name + "%", value, len(value)) or not value.value or "%" in value.value or not Path(value.value).is_absolute() or value.value.startswith("\\\\"):
                    raise OSError("Could not resolve a local native browser path: " + name)
                result[name] = value.value
            return result
        finally:
            kernel.CloseHandle(token)
    source = os.environ if source is None else source
    allowed = ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "HOME", "LANG", "LC_ALL")
    return {name: source[name] for name in allowed if name in source}


class BrowserDriver:
    def __init__(self, *, node, root, playwright, chrome, output, origin):
        self.node, self.root, self.playwright, self.chrome = map(Path, (node, root, playwright, chrome))
        self.output, self.origin = Path(output), origin
        self.token = secrets.token_urlsafe(32)
        self.process, self.job, self.stderr = None, None, None

    def __enter__(self):
        if self.output.exists():
            raise ValueError("Browser output must be new")
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.stderr = self.output.with_suffix(".stderr.log").open("w", encoding="utf-8")
        self.job = OwnedJob()
        try:
            self.process = subprocess.Popen(
                [str(self.node), str(self.root / "server.cjs"), "--playwright-module", str(self.playwright),
                 "--chrome", str(self.chrome), "--out", str(self.output), "--allow-origin", self.origin, "--token-stdin"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, encoding="utf-8",
                start_new_session=os.name != "nt", env=browser_environment(),
            )
            self.job.assign(self.process)
            self.process.stdin.write(self.token + "\n")
            self.process.stdin.close()
            ready = queue.Queue(maxsize=1)
            def read_ready():
                try:
                    ready.put(self.process.stdout.readline())
                except (OSError, ValueError):
                    ready.put("")
            threading.Thread(target=read_ready, daemon=True).start()
            line = ready.get(timeout=45)
            value = json.loads(line)
            if value.get("ready") is not True or value.get("origins") != [self.origin] or Path(value.get("out", "")).resolve() != self.output.resolve():
                raise ValueError("Browser startup did not confirm its frozen origin and output")
            from urllib.parse import urlsplit
            endpoint = urlsplit(value.get("endpoint", ""))
            if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.port is None or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment or endpoint.username or endpoint.password:
                raise ValueError("Browser returned an invalid endpoint")
            self.metadata = {"endpoint": value["endpoint"], "origins": value["origins"], "out": str(self.output)}
            self.environment = {"BENCH_BROWSER_TOKEN": self.token, "BROWSER_DRIVER_ENDPOINT": value["endpoint"],
                                "BROWSER_DRIVER_CLIENT": str(self.root / "client.cjs"), "NODE_EXE": str(self.node)}
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_args):
        try:
            if self.process is not None:
                if os.name == "nt":
                    if self.process.poll() is None:
                        self.process.terminate()
                else:
                    try:
                        os.killpg(self.process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                if self.job:
                    self.job.close()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=10)
                for stream in (self.process.stdin, self.process.stdout):
                    if stream and not stream.closed:
                        stream.close()
        finally:
            if self.job:
                self.job.close()
            if self.stderr:
                self.stderr.close()
