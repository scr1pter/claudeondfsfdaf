"""Verify the published synthetic benchmark files without running apps or models."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    manifest = json.loads((ROOT / "snapshot-manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["files"].items():
        file = (ROOT / name).resolve()
        if not file.is_relative_to(ROOT) or not file.is_file():
            raise ValueError("Missing or outside-bundle file: " + name)
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise ValueError("File differs from the measured artifact: " + name)
    print(json.dumps({"verifiedFiles": len(manifest["files"]), "syntheticSubmissions": manifest["syntheticSubmissionCount"], "providerCalls": 0}))


if __name__ == "__main__":
    main()
