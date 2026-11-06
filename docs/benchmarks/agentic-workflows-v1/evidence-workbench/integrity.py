"""Authored-source manifests share the runner's exact generated-root policy."""
import hashlib
from pathlib import Path

IGNORED_COMPONENTS = {"node_modules", ".git", "__pycache__", ".pytest_cache"}


def manifest(root, generated=("dist",)):
    root = Path(root).resolve()
    excluded = {Path(name).as_posix().strip("/") for name in generated}
    rows = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        name = relative.as_posix()
        if any(part in IGNORED_COMPONENTS for part in relative.parts):
            continue
        if any(name == item or name.startswith(item + "/") for item in excluded):
            continue
        if path.is_file():
            rows[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return rows


def digest(rows):
    payload = "".join(f"{name}\0{sha}\n" for name, sha in sorted(rows.items()))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
