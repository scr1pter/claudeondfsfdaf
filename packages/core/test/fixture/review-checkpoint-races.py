"""Linux-only synthetic Node/Bun writer races. No provider, credentials or host socket."""
import json
import os
import pathlib
import select
import shutil
import signal
import subprocess
import sys
import time

scenario, directory, bun, bun_worker, node_worker, node = sys.argv[1:]
directory = pathlib.Path(directory)
node = shutil.which(node)
assert node and scenario in ("crash", "suspend")
children = []
buffers = {}

def start(runtime, timeout=0):
    child = subprocess.Popen([bun if runtime == "bun" else node,
                              bun_worker if runtime == "bun" else node_worker,
                              str(directory), str(timeout)], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, bufsize=0)
    children.append(child)
    buffers[child.pid] = b""
    return child

def event(child, wanted, runtime):
    deadline = time.monotonic() + 6
    seen = []
    while time.monotonic() < deadline:
        while b"\n" not in buffers[child.pid]:
            readable, _, _ = select.select([child.stdout], [], [], max(0, deadline - time.monotonic()))
            assert readable, ("missing", wanted, seen)
            block = os.read(child.stdout.fileno(), 8192)
            assert block, ("exited", wanted, child.poll())
            buffers[child.pid] += block
            assert len(buffers[child.pid]) <= 16384
        line, buffers[child.pid] = buffers[child.pid].split(b"\n", 1)
        value = json.loads(line)
        assert value["runtime"] == runtime and value["pid"] == child.pid, value
        seen.append(value["event"])
        if value["event"] == wanted:
            return seen
    raise AssertionError(("missing", wanted, seen))

def command(child, value):
    child.stdin.write((value + "\n").encode("ascii"))
    child.stdin.flush()

def backdate():
    locks = [item for item in directory.iterdir() if item.name.endswith(".lock")]
    assert len(locks) == 1
    os.utime(locks[0] / "heartbeat", (time.time() - 90, time.time() - 90))
    return locks[0]

try:
    if scenario == "crash":
        first = start("node")
        event(first, "acquired", "node")
        second = start("bun")
        event(second, "waiting", "bun")
        first.kill()
        assert first.wait(timeout=2) == -signal.SIGKILL
        # Only the dead synthetic compatibility lease is aged; production recovery deadlines are unchanged.
        backdate()
        event(second, "acquired", "bun")
        command(second, "write")
        event(second, "written", "bun")
        command(second, "release")
        event(second, "released", "bun")
        assert second.wait(timeout=2) == 0
        assert (directory / "feature.json").read_text() == "1"
    else:
        first = start("bun")
        event(first, "acquired", "bun")
        os.kill(first.pid, signal.SIGSTOP)
        deadline = time.monotonic() + 2
        while "\nState:\tT" not in pathlib.Path(f"/proc/{first.pid}/status").read_text():
            assert time.monotonic() < deadline
            time.sleep(0.005)
        lock = backdate()
        breaker = lock.with_name(lock.name + ".breaker")
        breaker.mkdir(mode=0o700)
        os.utime(breaker, (time.time() - 90, time.time() - 90))
        identity = breaker.stat().st_ino
        second = start("node", 300)
        event(second, "waiting", "node")
        assert "acquired" not in event(second, "aborted", "node")
        assert second.wait(timeout=2) == 0
        assert breaker.stat().st_ino == identity
        os.kill(first.pid, signal.SIGCONT)
        command(first, "write")
        event(first, "written", "bun")
        command(first, "release")
        event(first, "released", "bun")
        assert first.wait(timeout=2) == 0
        assert (directory / "feature.json").read_text() == "1"
    print(json.dumps({"scenario":scenario,"passed":True,"parent":"python","drivers":["node","bun"]}), flush=True)
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
