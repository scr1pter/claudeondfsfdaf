"""Versioned LF-byte freeze helper. Default is a read-only draft preview."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "evaluator"))
from oracle import InstrumentFailure, canonical_digest, manifest, portable_bytes, runtime_projection

VERSION = "delivery-outbox-freeze-v1"


def preview(root, candidate_ref=None):
    root = Path(root).resolve()
    files = manifest(root, generated=("FREEZE-v1.json",))
    for name in files:
        portable_bytes(root / name)
    return {"version": VERSION, "status": "draft-preview-not-a-freeze", "candidateFrozenRef": candidate_ref,
            "taskFileSha256": files, "taskSha256": canonical_digest(files),
            "runtimeProjectionSha256": canonical_digest(runtime_projection(root)),
            "bytes": "Actual UTF-8 LF bytes; .gitattributes enforces the same Git bytes",
            "runtimePins": {"bun": "1.3.14", "node": "24.22.0", "typescript": "5.8.2"}}


def freeze(root, candidate_ref, authorization):
    if not isinstance(candidate_ref, str) or not re.fullmatch(r"[0-9a-f]{40,64}", candidate_ref):
        raise InstrumentFailure("Freeze requires the exact production-candidate revision after it is frozen")
    if not isinstance(authorization, dict) or authorization.get("candidateFrozen") is not True or authorization.get("candidateRef") != candidate_ref or authorization.get("independentTaskReviewed") is not True:
        raise InstrumentFailure("Freeze requires an explicit operator record confirming candidate freeze and independent task review")
    if authorization.get("runtimeValidationPassed") is not True or not isinstance(authorization.get("validationEvidenceSha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", authorization["validationEvidenceSha256"]):
        raise InstrumentFailure("Pure controls alone cannot freeze this task; complete runtime evidence is required")
    if authorization.get("runtimeProjectionSha256") != canonical_digest(runtime_projection(root)):
        raise InstrumentFailure("Runtime validation evidence must identify the exact current seed, contract and evaluator projection")
    target = Path(root).resolve() / "FREEZE-v1.json"
    if target.exists():
        raise InstrumentFailure("Versioned task is already frozen; do not overwrite its manifest")
    result = preview(root, candidate_ref)
    result.update(status="frozen", authorization=authorization)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return result


def git_bytes(root, names, mode):
    root = Path(root).resolve()
    repository = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, capture_output=True, check=False, timeout=15)
    if repository.returncode:
        raise InstrumentFailure("Git byte verification requires a repository")
    repository_root = Path(repository.stdout.decode().strip()).resolve()
    for name in names:
        path = root / name
        relative = path.relative_to(repository_root).as_posix()
        physical = portable_bytes(path)
        if mode in ("index", "head"):
            reference = ":" + relative if mode == "index" else "HEAD:" + relative
            blob = subprocess.run(["git", "cat-file", "blob", reference], cwd=repository_root, capture_output=True, check=False, timeout=15)
            if blob.returncode or blob.stdout != physical:
                raise InstrumentFailure("Physical bytes differ from the " + mode + " Git blob: " + relative)
            continue
        filtered = subprocess.run(["git", "hash-object", "--path=" + relative, "--stdin"], cwd=repository_root, input=physical, capture_output=True, check=False, timeout=15)
        raw = subprocess.run(["git", "hash-object", "--no-filters", "--stdin"], cwd=repository_root, input=physical, capture_output=True, check=False, timeout=15)
        if filtered.returncode or raw.returncode or filtered.stdout.strip() != raw.stdout.strip():
            raise InstrumentFailure("Git clean filters would change physical bytes: " + relative)
    return {"mode": mode, "files": len(names), "physicalEqualsGitBytes": True,
            "comparison": "actual staged blobs" if mode == "index" else "actual HEAD blobs" if mode == "head" else "bytes Git would store through current attributes; no staging performed"}


def check(root, git_mode=None):
    root = Path(root).resolve()
    target = root / "FREEZE-v1.json"
    if not target.is_file():
        raise InstrumentFailure("No final freeze exists; a preview cannot pass --check")
    frozen = json.loads(portable_bytes(target))
    current = preview(root)
    if frozen.get("version") != VERSION or frozen.get("status") != "frozen" or frozen.get("taskFileSha256") != current["taskFileSha256"] or frozen.get("taskSha256") != current["taskSha256"] or frozen.get("runtimeProjectionSha256") != current["runtimeProjectionSha256"]:
        raise InstrumentFailure("Current task bytes differ from the reviewed versioned freeze")
    result = {"version": VERSION, "status": "verified", "taskSha256": frozen["taskSha256"], "runtimeProjectionSha256": frozen["runtimeProjectionSha256"], "files": len(frozen["taskFileSha256"])}
    if git_mode is not None:
        result["git"] = git_bytes(root, [*frozen["taskFileSha256"], "FREEZE-v1.json"], git_mode)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--freeze", action="store_true")
    actions.add_argument("--check", action="store_true")
    parser.add_argument("--git-mode", choices=("filters", "index", "head"), default="filters")
    parser.add_argument("--candidate-frozen-ref")
    parser.add_argument("--authorization-record", type=Path)
    options = parser.parse_args()
    if options.check:
        print(json.dumps(check(options.root, options.git_mode), indent=2))
        return
    if not options.freeze:
        print(json.dumps(preview(options.root, options.candidate_frozen_ref), indent=2))
        return
    if not options.authorization_record:
        raise InstrumentFailure("--freeze requires --authorization-record from the coordinating operator")
    authorization = json.loads(options.authorization_record.read_text(encoding="utf-8"))
    print(json.dumps(freeze(options.root, options.candidate_frozen_ref, authorization), indent=2))


if __name__ == "__main__":
    main()
