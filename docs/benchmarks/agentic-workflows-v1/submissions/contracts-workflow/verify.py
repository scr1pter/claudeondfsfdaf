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
    for submission in manifest["submissions"]:
        root = ROOT / submission["sourceDirectory"]
        if root.is_symlink() or root.is_junction():
            raise ValueError("Linked source root")
        actual = {}
        for file in sorted(root.rglob("*")):
            if file.is_symlink() or file.is_junction():
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
        if submission["excludedFiles"] or submission["excludedFileCount"] != 0:
            raise ValueError("This inspected archive has no permitted publication exclusions")
        included = {name: entry["sha256"] for name, entry in actual.items()}
        if len(included) != submission["includedFileCount"] or len(included) != submission["originalArchiveFileCount"]:
            raise ValueError("Original archive count is not fully accountable")
        if digest(included) != submission["publishedSourceInventorySha256"] or digest(included) != submission["originalArchiveInventorySha256"]:
            raise ValueError("Original/published inventory digest changed")
        hidden = [name for name in actual if any(part.startswith(".") for part in PurePosixPath(name).parts)]
        if hidden != submission["hiddenAuthoredFilesInspectedAndIncluded"]:
            raise ValueError("Hidden authored file inventory differs")
        if included["TASK.md"] != manifest["taskAndEvaluator"]["agentVisibleTaskSha256"]:
            raise ValueError("Agent-visible task differs between submissions")
        gate = submission["independentGate"]
        if not (gate["exitCode"] == 0 and gate["verdict"] == "passed" and gate["apiPassed"] == 16 and gate["browserPassed"] == 8 and gate["sourceUnchanged"]):
            raise ValueError("Recorded independent gate metadata is inconsistent")
        results.append({"submission": submission["id"], "includedVerified": len(included), "excludedHashesAccountedFor": 0, "byteInventory": "unchanged", "hiddenAuthoredFilesVerified": hidden})
    attribute_command = ["git", "-C", str(repo), "check-attr"] + (["--cached"] if args.git_index else []) + ["-z", "text", "--"] + published_paths
    attribute_output = subprocess.run(attribute_command, check=True, capture_output=True).stdout.decode().split("\0")
    attributes = list(zip(attribute_output[0::3], attribute_output[1::3], attribute_output[2::3]))
    if len(attributes) != len(published_paths) or any(name != "text" or value != "unset" for _, name, value in attributes):
        raise ValueError("Every published source must have effective -text Git attributes")
    print(json.dumps({"modelCalls": 0, "appExecutions": 0, "sourceScanBlockedFindings": 0, "sourceTextAttributes": "unset", "gitBlobVerification": "index verified" if args.git_index else "not requested; run --git-index after staging", "submissions": results}, indent=2))


if __name__ == "__main__":
    main()
