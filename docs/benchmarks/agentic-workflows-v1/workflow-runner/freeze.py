"""Create/check a portable source manifest. Write only after root review."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def sources():
    files = {}
    for directory, folders, names in os.walk(ROOT, followlinks=False):
        folders[:] = [name for name in folders if name not in {"__pycache__", "node_modules", ".git"} and (Path(directory) / name).relative_to(ROOT).as_posix() != "artifacts"]
        for name in names:
            file = Path(directory) / name
            if file.name == "manifest.json" or file.suffix == ".pyc":
                continue
            if file.is_symlink() or file.is_junction():
                raise ValueError("Manifest source must not contain links")
            files[file.relative_to(ROOT).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "manifest.json"
    current = sources()
    if args.write:
        if target.exists():
            raise ValueError("Manifest already exists; preserve the prior freeze")
        target.write_bytes((json.dumps({"kind": "workflow-runner-v1-freeze", "frozenAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "apiGroups": 16, "browserChecks": 8, "modelCalls": 0, "files": current}, indent=2) + "\n").encode("utf-8"))
    elif args.check:
        expected = json.loads(target.read_text(encoding="utf-8"))
        if current != expected["files"]:
            raise ValueError("Frozen task source changed")
    print(json.dumps({"sourceFiles": len(current), "manifestWritten": args.write, "manifestChecked": args.check, "modelCalls": 0}))


if __name__ == "__main__":
    main()
