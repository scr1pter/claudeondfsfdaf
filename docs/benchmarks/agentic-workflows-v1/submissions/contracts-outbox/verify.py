"""Verify original source bytes; optionally verify staged Git blobs. No app runs."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent
PATTERNS = {
    "absoluteWindowsUserPath": rb"(?i)\b[A-Z]:[\\/]+Users[\\/]",
    "absolutePosixUserPath": rb"/(?:Users|home)/[^\s\x22\x27/]+/",
    "providerKey": rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}",
    "privateKey": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "credentialAssignment": rb"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[\x22\x27][A-Za-z0-9_./+-]{20,}[\x22\x27]",
    "privateStudyIdentifier": rb"(?i)foundry-(?:vector|codex)|vector-research-tools|paid-cycle[\\/]",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git-index", action="store_true", help="Also compare every source byte with its staged Git blob; stage all source and .gitattributes first")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    repo = Path(subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip()).resolve()
    results = []
    published_paths = []
    expected_counts = {"vector-first": 16, "codex-first": 17}
    if {entry["id"] for entry in manifest["submissions"]} != set(expected_counts):
        raise ValueError("Both original archives must be present")
    for submission in manifest["submissions"]:
        root = ROOT / submission["sourceDirectory"]
        if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
            raise ValueError("Linked source root")
        actual = {}
        for file in sorted(root.rglob("*")):
            if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
                raise ValueError("Published evidence contains a linked path")
            if not file.is_file():
                continue
            relative = file.relative_to(root).as_posix()
            parts = PurePosixPath(relative)
            if parts.is_absolute() or ".." in parts.parts:
                raise ValueError("Invalid source inventory path")
            content = file.read_bytes()
            content.decode("utf-8")
            for category, pattern in PATTERNS.items():
                if re.search(pattern, content):
                    raise ValueError("Blocked source scan: " + submission["id"] + "/" + relative + ": " + category)
            actual[relative] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
            repo_relative = file.relative_to(repo).as_posix()
            published_paths.append(repo_relative)
            if args.git_index:
                blob = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", ":" + repo_relative], capture_output=True)
                if blob.returncode:
                    raise ValueError("Source not available in Git index; stage it first: " + repo_relative)
                if blob.stdout != content:
                    raise ValueError("Staged Git blob differs from original source: " + repo_relative)
        if actual != submission["includedFiles"]:
            raise ValueError("Published source bytes or inventory changed: " + submission["id"])
        if len(actual) != expected_counts[submission["id"]]:
            raise ValueError("Original application archive count changed")
        if submission["originalCoordinatorStopReason"] != "coordinator_review_required" or submission["originalAutomaticBrowserAuditStatus"] != "review_required" or submission["originalAutomaticGateRewritten"]:
            raise ValueError("Original automatic coordinator flags must remain preserved")
        if submission["excludedFiles"] or submission["excludedFileCount"] != 0:
            raise ValueError("This inspected archive has no permitted publication exclusions")
        included = {name: entry["sha256"] for name, entry in actual.items()}
        if len(included) != submission["includedFileCount"] or len(included) != submission["originalArchiveFileCount"]:
            raise ValueError("Original archive count is not fully accountable")
        if digest(included) != submission["publishedSourceInventorySha256"] or digest(included) != submission["originalArchiveInventorySha256"]:
            raise ValueError("Original/published inventory digest changed")
        hidden = sorted(name for name in actual if any(part.startswith(".") for part in PurePosixPath(name).parts))
        if hidden != submission["hiddenAuthoredFilesInspectedAndIncluded"]:
            raise ValueError("Hidden authored file inventory differs")
        if included["TASK.md"] != manifest["taskAndEvaluator"]["agentVisibleTaskSha256"]:
            raise ValueError("Agent-visible task differs between submissions")
        gate = submission["independentGate"]
        if not (gate["exitCode"] == 0 and gate["verdict"] == "passed" and gate["apiPassed"] == 18 and gate["browserPassed"] == 8 and gate["requiredChecksPassed"] == 26 and gate["instrumentUnchanged"] and gate["sourceUnchanged"]):
            raise ValueError("Recorded independent gate metadata is inconsistent")
        results.append({"submission": submission["id"], "includedVerified": len(included), "excludedHashesAccountedFor": 0, "byteInventory": "unchanged", "hiddenAuthoredFilesVerified": hidden})
    supplements = []
    for entry in manifest["supplementalAuthoredFiles"]:
        relative = PurePosixPath(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or "supplemental-authored" not in relative.parts:
            raise ValueError("Invalid separate supplement path")
        file = ROOT / entry["path"]
        if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
            raise ValueError("Linked supplemental source")
        content = file.read_bytes()
        content.decode("utf-8")
        for category, pattern in PATTERNS.items():
            if re.search(pattern, content):
                raise ValueError("Blocked supplemental source scan: " + category)
        if hashlib.sha256(content).hexdigest() != entry["sha256"] or len(content) != entry["bytes"]:
            raise ValueError("Supplemental current source bytes changed")
        if not entry["outsideOriginalApplicationArchive"] or entry["originalImmutableSourceManifestCoveredFile"] or entry["provenance"]["executionBytesAuthenticated"]:
            raise ValueError("Supplement provenance must retain its historical limits")
        repo_relative = file.relative_to(repo).as_posix()
        published_paths.append(repo_relative)
        if args.git_index:
            blob = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", ":" + repo_relative], capture_output=True)
            if blob.returncode or blob.stdout != content:
                raise ValueError("Staged supplement blob missing or differs: " + repo_relative)
        supplements.append({"path": entry["path"], "bytesVerified": len(content), "includedInOriginalArchiveCount": False, "historicalExecutionBytesAuthenticated": False})
    expected = {entry["path"] for entry in manifest["supplementalAuthoredFiles"]}
    observed = {file.relative_to(ROOT).as_posix() for folder in ROOT.glob("*/supplemental-authored") for file in folder.rglob("*") if file.is_file()}
    if observed != expected:
        raise ValueError("Separate supplemental authored inventory differs")
    if sum(path.startswith("vector-first/") for path in expected) != 1 or sum(path.startswith("codex-first/") for path in expected) != 3:
        raise ValueError("Supplements must remain separate: one Vector and three Codex")
    for entry in manifest["manualReviewLineage"]["cases"].values():
        if entry["originalStopReason"] != "coordinator_review_required" or entry["originalAuditStatus"] != "review_required" or entry["manualDisposition"] != "bounded_manual_review_no_clear_bypass_observed" or entry["originalRunModifiedByManualReview"]:
            raise ValueError("Manual dispositions must remain separate from original flags")
    attribute_command = ["git", "-C", str(repo), "check-attr"] + (["--cached"] if args.git_index else []) + ["-z", "text", "--"] + published_paths
    attribute_output = subprocess.run(attribute_command, check=True, capture_output=True).stdout.decode().split("\0")
    attributes = list(zip(attribute_output[0::3], attribute_output[1::3], attribute_output[2::3]))
    if len(attributes) != len(published_paths) or any(name != "text" or value != "unset" for _, name, value in attributes):
        raise ValueError("Every published source must have effective -text Git attributes")
    print(json.dumps({"modelCalls": 0, "appExecutions": 0, "sourceScanBlockedFindings": 0, "sourceTextAttributes": "unset", "gitBlobVerification": "index verified" if args.git_index else "not requested; run --git-index after staging", "submissions": results, "separateAuthoredSupplements": supplements}, indent=2))


if __name__ == "__main__":
    main()
