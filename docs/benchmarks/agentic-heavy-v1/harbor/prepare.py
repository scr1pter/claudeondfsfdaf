"""Copy only the public empty Harbor scaffold into a new participant workspace."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent
SEED_FILES = ("package.json", "tsconfig.json", ".gitignore", "bun.lock", "UI_CONTRACT.md")


def prepare(destination, manifest):
    destination, manifest = Path(destination).resolve(), Path(manifest).resolve()
    if destination.is_relative_to(ROOT) or ROOT.is_relative_to(destination):
        raise ValueError("Participant workspace must be separate from the benchmark")
    if manifest.is_relative_to(destination) or manifest.exists():
        raise ValueError("New manifest must remain outside the participant workspace")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Workspace must be new or empty; existing files are never removed")
    if set(path.name for path in (ROOT / "seed").iterdir()) != set(SEED_FILES):
        raise ValueError("Unexpected seed content")
    if (ROOT / "UI_CONTRACT.md").read_bytes() != (ROOT / "seed/UI_CONTRACT.md").read_bytes():
        raise ValueError("Public UI contract copies differ")
    destination.mkdir(parents=True, exist_ok=True)
    for name in SEED_FILES:
        shutil.copyfile(ROOT / "seed" / name, destination / name)
    shutil.copyfile(ROOT / "BUILD_SPEC.md", destination / "BUILD_SPEC.md")
    files = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(destination.iterdir())}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"kind": "harbor-empty-scaffold-v1", "applicationImplementationSeeded": False,
                                   "fileCount": len(files), "files": files}, indent=2) + "\n", encoding="utf-8")
    return {"fileCount": len(files), "applicationImplementationSeeded": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.destination, args.manifest)))


if __name__ == "__main__":
    main()
