"""Free real-process/browser smoke; never contacts a model or a funding controller."""
import argparse
import ctypes
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import urllib.request

from browser_driver import BrowserDriver, browser_environment
from owned_process import execute


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><title>Runtime Fixture</title><h1>Owned runtime fixture</h1><label>Value<input name="value"></label>'
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def alive(pid):
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        status = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(status)):
            raise OSError("Could not query the owned smoke child")
        return status.value == 259
    finally:
        kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("node", "browser-driver-root", "playwright-module", "chrome", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    root = args.out.resolve()
    root.mkdir(parents=True, exist_ok=False)
    checks = []
    env = browser_environment()
    result = execute([str(args.node), "-e", "console.log('owned-success')"], root, env, root / "normal", 10)
    assert result["exitCode"] == 0 and not result["timedOut"]
    checks.append("owned process exits normally")
    result = execute([str(args.node), "-e", "process.exit(7)"], root, env, root / "nonzero", 10)
    assert result["exitCode"] == 7
    checks.append("nonzero exit is preserved")
    pid_file = root / "owned-child.pid"
    code = "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)"
    result = execute([str(args.node), "-e", code, str(pid_file)], root, env, root / "timeout", 2)
    assert result["timedOut"] and pid_file.is_file()
    assert not alive(int(pid_file.read_text()))
    checks.append("timeout closes owned process descendants")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with BrowserDriver(node=args.node, root=args.browser_driver_root, playwright=args.playwright_module,
                           chrome=args.chrome, output=root / "browser", origin=origin) as browser:
            request = urllib.request.Request(browser.metadata["endpoint"] + "/action",
                data=json.dumps({"action": "open", "url": origin}).encode(),
                headers={"Authorization": "Bearer " + browser.environment["BENCH_BROWSER_TOKEN"], "Content-Type": "application/json"})
            with opener.open(request, timeout=30) as response:
                opened = json.load(response)
            assert opened.get("ok") is True and "Owned runtime fixture" in json.dumps(opened)
            checks.append("supervised fresh browser observes the owned fixture")
            process = browser.process
        assert process.poll() is not None
        checks.append("supervised browser owner closes after the arm")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    summary = {"kind": "Real owned runtime preflight", "passed": len(checks), "failed": 0,
               "checks": checks, "providerCalls": 0, "controllerCalls": 0, "cloudActions": 0}
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
