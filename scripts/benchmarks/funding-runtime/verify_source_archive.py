"""Check source bytes/AST only; never import the archived funding runtime."""

import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
PATTERNS = {
    "absoluteWindowsUserPath": rb"(?i)\b[A-Z]:[\\/]+Users[\\/]",
    "absolutePosixUserPath": rb"/(?:Users|home)/[^\s\x22\x27/]+/",
    "providerKey": rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}",
    "privateKey": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "nativeWindowsSid": rb"\bS-1-5-21-(?:\d+-){2,}\d+\b",
    "credentialLiteral": rb"(?i)[\x22\x27]?(?:api[_-]?key|access[_-]?token|client[_-]?secret|controller[_-]?token|local[_-]?token|password)[\x22\x27]?\s*[:=]\s*[\x22\x27]([A-Za-z0-9_./+-]{24,})[\x22\x27]",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git-index", action="store_true", help="Also check staged source blobs and staged -text attributes")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    expected = manifest["files"]
    actual = {file.relative_to(ROOT).as_posix() for file in (ROOT / "archive").rglob("*") if file.is_file()}
    if actual != set(expected):
        raise SystemExit("Archive file inventory differs; runtime state must stay outside this source archive")
    modules = {Path(name).stem: Path(name).name for name in expected}
    exceptions = {(entry["file"], entry["line"]): entry for entry in manifest["scan"]["reviewedSyntheticFixtureExceptions"]}
    reviewed = []
    for relative, entry in expected.items():
        file = ROOT / relative
        if file.is_symlink() or (hasattr(file, "is_junction") and file.is_junction()):
            raise SystemExit("Linked archive path: " + relative)
        content = file.read_bytes()
        if hashlib.sha256(content).hexdigest() != entry["sha256"] or len(content) != entry["bytes"]:
            raise SystemExit("Original source bytes differ: " + relative)
        text = content.decode("utf-8")
        tree = ast.parse(text, filename=relative)
        for category, pattern in PATTERNS.items():
            for match in re.finditer(pattern, content):
                line = content[:match.start()].count(b"\n") + 1
                exception = exceptions.get((relative, line))
                if category != "credentialLiteral" or not exception:
                    raise SystemExit("Blocked source scan: " + relative + ": " + category)
                value = match.group(1).lower()
                functions = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.lineno <= line <= node.end_lineno]
                if not functions or functions[-1].name != exception["testFunction"] or not any(marker in value for marker in (b"test", b"synthetic", b"fake", b"placeholder")) or value.startswith(b"sk-"):
                    raise SystemExit("Synthetic test fixture exception no longer matches: " + relative)
                source = ast.get_source_segment(text, functions[-1])
                if not all(marker in source for marker in ("TemporaryDirectory", "getpass", "patch")):
                    raise SystemExit("Synthetic fixture context differs: " + relative)
                reviewed.append((relative, line))
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.append("." * node.level + (node.module or ""))
            elif isinstance(node, ast.Call):
                name = ast.unparse(node.func)
                if name in ("__import__", "eval", "exec") or "importlib" in name or "runpy" in name:
                    raise SystemExit("Dynamic loading needs separate review: " + relative)
        local = sorted({modules[name.split(".")[0]] for name in imports if name.split(".")[0] in modules})
        if local != entry["localImports"]:
            raise SystemExit("Static local import closure differs: " + relative)
        if any(name.split(".")[0] not in modules and name.split(".")[0] not in sys.stdlib_module_names for name in imports):
            raise SystemExit("Unknown external dependency: " + relative)
    if set(reviewed) != set(exceptions):
        raise SystemExit("Reviewed synthetic fixture inventory differs")
    git_status = "not requested; stage all files before --git-index"
    if args.git_index:
        repo = Path(subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip())
        paths = []
        for relative in expected:
            file = ROOT / relative
            path = file.relative_to(repo).as_posix()
            paths.append(path)
            blob = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", ":" + path], capture_output=True)
            if blob.returncode or blob.stdout != file.read_bytes():
                raise SystemExit("Staged source blob missing or different: " + path)
        attributes = subprocess.run(["git", "-C", str(repo), "check-attr", "--cached", "-z", "text", "--"] + paths, check=True, capture_output=True).stdout.decode().split("\0")
        triples = list(zip(attributes[0::3], attributes[1::3], attributes[2::3]))
        if len(triples) != len(paths) or any(name != "text" or value != "unset" for _, name, value in triples):
            raise SystemExit("Every archived Python source must have staged -text attributes")
        git_status = "all staged source bytes and -text attributes verified"
    print(json.dumps({"sourceFilesVerified": len(expected), "runtimeModules": manifest["runtimeModuleCount"], "syntheticTestSourceModules": manifest["testSourceModuleCount"], "reviewedSyntheticFixtureMatches": len(reviewed), "blockedActualSecretOrPrivatePathFindings": 0, "archivedRuntimeOrTestsImported": False, "gatewayStarts": 0, "apiCalls": 0, "gitIndexVerification": git_status}, indent=2))


if __name__ == "__main__":
    main()
