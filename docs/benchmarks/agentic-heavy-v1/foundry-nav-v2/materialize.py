"""Restore only hash-proven historical newline spellings after Git checkout."""
import hashlib
import json
from pathlib import Path


def materialize(root):
    root = root.resolve()
    record = json.loads((root / "overlay-provenance.json").read_text())
    pending = []
    for name, row in record["copiedFiles"].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Overlay materialization path escaped its root")
        value = path.read_bytes()
        expected = row["overlaySha256"]
        if hashlib.sha256(value).hexdigest() == expected:
            continue
        normalized = value.replace(b"\r\n", b"\n")
        options = [normalized, normalized.replace(b"\n", b"\r\n")]
        matches = [candidate for candidate in options if hashlib.sha256(candidate).hexdigest() == expected]
        if not matches:
            raise ValueError("Overlay bytes differ beyond historical newline spelling: " + name)
        pending.append((name, path, matches[0]))
    for _, path, value in pending:
        path.write_bytes(value)
    return [name for name, _, _ in pending]


if __name__ == "__main__":
    print(json.dumps({"restoredHistoricalNewlineFiles": materialize(Path(__file__).resolve().parent), "modelCalls": 0}))
