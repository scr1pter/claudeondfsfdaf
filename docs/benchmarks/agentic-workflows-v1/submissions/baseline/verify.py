"""Verify the published original synthetic sources; no model or app execution."""
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    results = []
    for submission in manifest["submissions"]:
        root = ROOT / submission["sourceDirectory"]
        actual = {}
        for file in sorted(root.rglob("*")):
            if file.is_symlink() or file.is_junction():
                raise ValueError("Published evidence contains a linked path")
            if not file.is_file():
                continue
            relative = file.relative_to(root).as_posix()
            if relative.startswith(".verification/"):
                raise ValueError("Generated private runtime artifact was published")
            content = file.read_bytes()
            actual[relative] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        if actual != submission["includedFiles"]:
            raise ValueError("Published source bytes or file inventory changed: " + submission["id"])
        included = {name: entry["sha256"] for name, entry in actual.items()}
        excluded = {name: entry["sha256"] for name, entry in submission["excludedFiles"].items()}
        if set(included) & set(excluded) or any(not name.startswith(".verification/") for name in excluded):
            raise ValueError("Unexpected publication exclusion scope")
        if len(included) != submission["includedFileCount"] or len(excluded) != submission["excludedFileCount"]:
            raise ValueError("Publication file count differs from inventory")
        if len(included) + len(excluded) != submission["originalArchiveFileCount"]:
            raise ValueError("Original complete archive count is not accountable")
        if digest(included) != submission["publishedSourceInventorySha256"]:
            raise ValueError("Published inventory digest changed")
        if digest({**included, **excluded}) != submission["originalArchiveInventorySha256"]:
            raise ValueError("Complete original archive inventory digest changed")
        if included["TASK.md"] != manifest["taskAndEvaluator"]["agentVisibleTaskSha256"]:
            raise ValueError("Agent-visible task differs between submissions")
        gate = submission["correctedIndependentGate"]
        if not (gate["exitCode"] == 0 and gate["verdict"] == "passed" and gate["apiPassed"] == 16 and gate["browserPassed"] == 8 and gate["sourceUnchanged"]):
            raise ValueError("Recorded corrected gate outcome is inconsistent")
        results.append({"submission": submission["id"], "includedVerified": len(included), "excludedHashesAccountedFor": len(excluded), "byteInventory": "unchanged"})
    print(json.dumps({"modelCalls": 0, "appExecutions": 0, "submissions": results}, indent=2))


if __name__ == "__main__":
    main()
