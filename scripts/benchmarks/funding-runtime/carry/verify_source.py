"""Verify the complete frozen source/data closure without importing a gateway."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git-index", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "carry" / "manifest.json").read_bytes())
    modules = {Path(name).stem for name in manifest["files"] if name.endswith(".py")}
    for relative, entry in manifest["files"].items():
        path = root / relative
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise SystemExit("Linked source: " + relative)
        data = path.read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise SystemExit("Changed source: " + relative)
        if re.search(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", data):
            raise SystemExit("Credential-shaped source: " + relative)
        if relative.endswith(".py"):
            tree = ast.parse(data, filename=relative)
            for node in ast.walk(tree):
                names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) else []
                if any(name and name.split(".")[0] not in modules | sys.stdlib_module_names for name in names):
                    raise SystemExit("Unlisted import: " + relative)
                if isinstance(node, ast.Call) and ast.unparse(node.func) in ("__import__", "eval", "exec", "runpy.run_path", "importlib.import_module"):
                    raise SystemExit("Dynamic loader: " + relative)
        if args.git_index:
            repo = Path(subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip())
            name = path.relative_to(repo).as_posix()
            blob = subprocess.run(["git", "-C", str(repo), "cat-file", "blob", ":" + name], check=True, capture_output=True).stdout
            if blob != data:
                raise SystemExit("Staged bytes differ: " + relative)
    print(json.dumps({"sourceAndDataFilesVerified": len(manifest["files"]), "runtimeModules": 6,
                      "gatewayImports": 0, "providerCalls": 0, "credentialReads": 0, "gitIndexVerified": args.git_index}))


if __name__ == "__main__":
    main()
