# New in VS-21d (no session original). Results never land in the repository (I-13).
# See README.md. A helper that other scripts load with runpy.run_path; it does nothing when run on its own.
import pathlib, subprocess, sys


def outside_repo(path, what):
    # Resolve the path (it may not exist yet) and refuse it inside the repository that holds these scripts, as ci.ts
    # refuses EVAL_OUT_DIR there; outside a git checkout there is nothing to refuse. Then create its parent folder.
    p = pathlib.Path(path).resolve()
    here = pathlib.Path(__file__).resolve().parent
    top = subprocess.run(["git", "-C", str(here), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    root = pathlib.Path(top.stdout.strip()).resolve() if top.returncode == 0 else None
    if root and (p == root or root in p.parents):
        print(f"{what} must be outside the repository ({root}); write results under /tmp/vector-vectorscope/research/", file=sys.stderr)
        sys.exit(2)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p
