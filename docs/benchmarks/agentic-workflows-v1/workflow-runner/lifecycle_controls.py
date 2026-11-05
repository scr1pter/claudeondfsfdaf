"""Real protected-worker controls. Local Bun processes only; no models."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from evaluate import process_alive, wait_for

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", type=Path, required=True)
    args = parser.parse_args()
    passed = []
    with tempfile.TemporaryDirectory(prefix="workflow-worker-controls-") as directory:
        markers = Path(directory)
        def worker(job_id, attempt, kind, parent=None):
            env = {**os.environ, "WORKFLOW_MARKER_DIR": str(markers), "WORKFLOW_PARENT_PID": str(parent or os.getpid())}
            return subprocess.Popen([str(args.bun), str(ROOT / "worker.ts"), "--job-id", job_id, "--attempt", str(attempt), "--kind", kind], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process = worker("success", 1, "succeed")
        stdout, _ = process.communicate(timeout=5)
        assert process.returncode == 0 and json.loads(stdout) == {"jobId": "success", "attempt": 1, "message": "completed"}
        passed.append("real_success_output")
        first = worker("retry", 1, "fail_once")
        first.communicate(timeout=5)
        second = worker("retry", 2, "fail_once")
        second.communicate(timeout=5)
        assert first.returncode == 5 and second.returncode == 0
        passed.append("fail_once_attempts")
        blocked = worker("barrier", 1, "block")
        try:
            evidence = wait_for(lambda: json.loads((markers / "barrier.1.started.json").read_text()) if (markers / "barrier.1.started.json").exists() else None, "barrier evidence")
            assert evidence["pid"] == blocked.pid and process_alive(blocked.pid) and blocked.poll() is None
            (markers / "barrier.1.release").touch()
            blocked.communicate(timeout=5)
            assert blocked.returncode == 0
        finally:
            if blocked.poll() is None:
                blocked.kill()
                blocked.wait(timeout=5)
        passed.append("block_release_barrier")
        parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        orphan = worker("parent-exit", 1, "block", parent.pid)
        try:
            wait_for(lambda: (markers / "parent-exit.1.started.json").exists(), "parent-exit worker")
            parent.kill()
            parent.wait(timeout=5)
            orphan.communicate(timeout=5)
            assert orphan.returncode == 71 and not process_alive(orphan.pid)
        finally:
            for process in [parent, orphan]:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        passed.append("parent_death_exits_fixture")
        invalid = worker("../outside", 1, "succeed")
        invalid.communicate(timeout=5)
        assert invalid.returncode == 64 and not (markers.parent / "outside.1.started.json").exists()
        passed.append("invalid_identity_rejected")
    print(json.dumps({"passed": len(passed), "checks": passed, "modelCalls": 0}))


if __name__ == "__main__":
    main()
