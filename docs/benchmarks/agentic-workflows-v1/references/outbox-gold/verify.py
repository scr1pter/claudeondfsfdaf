"""Verify the published reference bytes; never run the app, tests, or network."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

EXPECTED_SOURCE_SHA256 = "8d5b30a010beefa5b87b594240014420ccdac3956d88508ab55ae2fae1300e34"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify(root, git_mode="physical"):
    root = Path(root).resolve()
    source = root / "source"
    frozen = json.loads((root / "SOURCE-MANIFEST-v1.json").read_text(encoding="utf-8"))
    expected = frozen["files"]
    if len(expected) != 15 or frozen["sourceSha256"] != EXPECTED_SOURCE_SHA256 or digest(expected) != EXPECTED_SOURCE_SHA256:
        raise ValueError("Original fifteen-file reference manifest does not match the published source digest")
    for name, value in expected.items():
        path = PurePosixPath(name)
        if path.is_absolute() or "\\" in name or ":" in name or any(part in (".", "..") for part in path.parts) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("Invalid portable source-manifest entry")
    paths = list(source.rglob("*"))
    if any(path.is_symlink() for path in paths):
        raise ValueError("Reference source cannot contain links")
    actual = {path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}
    if actual != expected or digest(actual) != EXPECTED_SOURCE_SHA256:
        raise ValueError("Physical source inventory or bytes differ from the original snapshot")
    files = sorted(path for path in root.rglob("*") if path.is_file())
    result = {"status": "verified", "sourceFiles": len(actual), "sourceSha256": digest(actual),
              "publicationFiles": len(files), "sourceMatchesOriginalSnapshot": True,
              "gitMode": git_mode, "appTestsBrowserOrNetworkExecuted": False}
    if git_mode != "physical":
        repository = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, capture_output=True, timeout=15, check=False)
        if repository.returncode:
            raise ValueError("Local Git repository unavailable")
        repository_root = Path(repository.stdout.decode().strip()).resolve()
        for path in files:
            relative = path.relative_to(repository_root).as_posix()
            reference = ":" + relative if git_mode == "index" else "HEAD:" + relative
            blob = subprocess.run(["git", "cat-file", "blob", reference], cwd=repository_root, capture_output=True, timeout=15, check=False)
            if blob.returncode or blob.stdout != path.read_bytes():
                raise ValueError("Physical bytes differ from actual " + git_mode + " Git blob: " + relative)
        result.update(physicalEqualsActualGitBlobBytes=True, gitBlobFiles=len(files))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git-mode", choices=("physical", "index", "head"), default="physical")
    options = parser.parse_args()
    print(json.dumps(verify(Path(__file__).resolve().parent, options.git_mode), indent=2))


if __name__ == "__main__":
    main()
