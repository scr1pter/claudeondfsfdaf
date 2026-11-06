"""Freeze/verify all task source hashes without executing the app or dependencies."""
import argparse
import json
from pathlib import Path

from integrity import digest, manifest


def snapshot(root):
    rows = manifest(root, generated=())
    rows.pop("SOURCE_MANIFEST.json", None)
    return {"format": 1, "algorithm": "sha256", "files": rows, "aggregateSha256": digest(rows)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    target = root / "SOURCE_MANIFEST.json"
    value = snapshot(root)
    if args.check:
        if not target.is_file() or json.loads(target.read_text(encoding="utf-8")) != value:
            raise SystemExit("Task source manifest differs from the frozen task.")
        print(f"Task source manifest verified: {len(value['files'])} files.")
        return
    target.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Task source manifest written: {len(value['files'])} files.")


if __name__ == "__main__":
    main()
