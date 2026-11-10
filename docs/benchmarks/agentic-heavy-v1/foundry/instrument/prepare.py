"""Prepare the empty public Foundry scaffold; never copy hidden evaluators."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent


def prepare(destination, manifest):
    destination, manifest = destination.resolve(), manifest.resolve()
    if destination.is_relative_to(ROOT) or ROOT.is_relative_to(destination):
        raise ValueError("Fixture destination must be separate from private benchmark instruments")
    if manifest.is_relative_to(destination):
        raise ValueError("Manifest must stay outside the model's workspace")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Destination must be new or empty; no existing files will be removed")
    if manifest.exists():
        raise ValueError("Manifest already exists; preserve prior evidence")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("package.json", "tsconfig.json", ".gitignore", "bun.lock"):
        shutil.copyfile(ROOT / "seed" / name, destination / name)
    shutil.copyfile(ROOT / "BUILD_SPEC.md", destination / "BUILD_SPEC.md")
    files = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in destination.iterdir() if file.is_file()}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps({"kind": "foundry-empty-scaffold", "directory": str(destination), "applicationImplementationSeeded": False, "files": files}, indent=2), encoding="utf-8")
    return {"directory": str(destination), "fileCount": len(files), "manifest": str(manifest)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.destination, args.manifest)))


if __name__ == "__main__":
    main()
