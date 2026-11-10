"""Free evaluation of a copied synthetic app; no model or funding controls."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

from owned_process import execute

ROOT = Path(__file__).resolve().parent
IGNORED = {".git", "node_modules", "__pycache__", "dist"}


def manifest(root):
    return dict(sorted((path.relative_to(root).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest())
        for path in root.rglob("*") if path.is_file()
        and not any(part in IGNORED for part in path.relative_to(root).parts)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "dependencies", "out", "bun", "node", "playwright-module", "chrome"):
        parser.add_argument("--" + name, type=Path, required=True)
    options = parser.parse_args()
    for name, value in vars(options).items():
        setattr(options, name, value.resolve())
    if options.out.exists() or any(options.out == root or options.out.is_relative_to(root)
                                  for root in (options.source, options.dependencies, ROOT)):
        raise ValueError("Qualification requires a new separate private output directory")
    options.out.mkdir(parents=True)
    app = options.out / "app"
    before = manifest(options.source)
    shutil.copytree(options.source, app, ignore=shutil.ignore_patterns(*IGNORED))
    if manifest(app) != before:
        raise ValueError("Copied authored source differs")
    shutil.copytree(options.dependencies, app / "node_modules")
    home = options.out / "home"
    home.mkdir()
    env = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if name in os.environ}
    system = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32"
    env.update(PATH=os.pathsep.join((str(options.bun.parent), str(options.node.parent), str(Path(sys.executable).parent),
                                     str(system), str(system / "WindowsPowerShell/v1.0"))),
               HOME=str(home), USERPROFILE=str(home), TEMP=str(home), TMP=str(home), CI="1", NO_COLOR="1")
    for name, child in (("LOCALAPPDATA", "Local"), ("APPDATA", "Roaming")):
        target = home / "AppData" / child
        target.mkdir(parents=True)
        env[name] = str(target)
    command = [sys.executable, "-B", str(ROOT / "evaluate.py"), "--app", str(app), "--out", str(options.out / "evaluation"),
        "--bun", str(options.bun), "--node", str(options.node), "--playwright-module", str(options.playwright_module),
        "--chrome", str(options.chrome)]
    process = execute(command, app, env, options.out / "process", timeout=1500)
    report_path = options.out / "evaluation/evaluation.json"
    report = json.loads(report_path.read_text()) if report_path.is_file() else None
    result = {"kind": "foundry-nav-v2-free-app-qualification", "modelCalls": 0, "fundedMeterCalls": 0,
        "process": process, "sourceFileCount": len(before), "sourceManifestSha256": hashlib.sha256(
            json.dumps(before, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
        "copiedAuthoredSourceUnchanged": manifest(app) == before, "originalAuthoredSourceUnchanged": manifest(options.source) == before,
        "verdict": report.get("verdict") if report else None,
        "checks": report.get("checks") if report else [], "reportSha256": hashlib.sha256(report_path.read_bytes()).hexdigest() if report_path.is_file() else None}
    (options.out / "qualification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("modelCalls", "process", "sourceFileCount", "sourceManifestSha256",
        "copiedAuthoredSourceUnchanged", "originalAuthoredSourceUnchanged", "verdict")}))
    return 0 if report is not None and result["copiedAuthoredSourceUnchanged"] and result["originalAuthoredSourceUnchanged"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
