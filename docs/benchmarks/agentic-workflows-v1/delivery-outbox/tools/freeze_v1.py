"""Versioned LF-byte freeze helper. Default is a read-only draft preview."""
import argparse
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evaluator"))
from oracle import InstrumentFailure, canonical_digest, manifest, portable_bytes

VERSION = "delivery-outbox-freeze-v1"


def preview(root, candidate_ref=None):
    root = Path(root).resolve()
    files = manifest(root, generated=("FREEZE-v1.json",))
    for name in files:
        portable_bytes(root / name)
    return {"version": VERSION, "status": "draft-preview-not-a-freeze", "candidateFrozenRef": candidate_ref,
            "taskFileSha256": files, "taskSha256": canonical_digest(files),
            "bytes": "Actual UTF-8 LF bytes; .gitattributes enforces the same Git bytes",
            "runtimePins": {"bun": "1.3.14", "node": "24.22.0", "typescript": "5.8.2"}}


def freeze(root, candidate_ref, authorization):
    if not isinstance(candidate_ref, str) or not re.fullmatch(r"[0-9a-f]{40,64}", candidate_ref):
        raise InstrumentFailure("Freeze requires the exact production-candidate revision after it is frozen")
    if not isinstance(authorization, dict) or authorization.get("candidateFrozen") is not True or authorization.get("candidateRef") != candidate_ref or authorization.get("independentTaskReviewed") is not True:
        raise InstrumentFailure("Freeze requires an explicit operator record confirming candidate freeze and independent task review")
    if authorization.get("runtimeValidationPassed") is not True or not isinstance(authorization.get("validationEvidenceSha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", authorization["validationEvidenceSha256"]):
        raise InstrumentFailure("Pure controls alone cannot freeze this task; complete runtime evidence is required")
    target = Path(root).resolve() / "FREEZE-v1.json"
    if target.exists():
        raise InstrumentFailure("Versioned task is already frozen; do not overwrite its manifest")
    result = preview(root, candidate_ref)
    result.update(status="frozen", authorization=authorization)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--freeze", action="store_true")
    parser.add_argument("--candidate-frozen-ref")
    parser.add_argument("--authorization-record", type=Path)
    options = parser.parse_args()
    if not options.freeze:
        print(json.dumps(preview(options.root, options.candidate_frozen_ref), indent=2))
        return
    if not options.authorization_record:
        raise InstrumentFailure("--freeze requires --authorization-record from the coordinating operator")
    authorization = json.loads(options.authorization_record.read_text(encoding="utf-8"))
    print(json.dumps(freeze(options.root, options.candidate_frozen_ref, authorization), indent=2))


if __name__ == "__main__":
    main()
