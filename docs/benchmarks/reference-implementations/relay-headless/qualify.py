"""Private reference controls. Never copy this file into a public task or seed."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("task", "runtime", "node", "typescript", "out"):
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--mode", choices=("node-prequalification", "bun-qualification"), default="node-prequalification")
    options = parser.parse_args()
    for key in ("task", "runtime", "node", "typescript", "out"):
        setattr(options, key, getattr(options, key).resolve())
    root = Path(__file__).resolve().parent
    assert not root.is_relative_to(options.task) and not options.task.is_relative_to(root)
    options.out.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(options.task))
    import evaluate
    if options.mode == "bun-qualification":
        probe = subprocess.run([str(options.runtime), "-e", "if(!globalThis.Bun)process.exit(91)"],
            env=evaluate.environment(), capture_output=True, timeout=5)
        assert probe.returncode == 0
    base_command = [sys.executable, "-B", str(options.task / "evaluate.py"), "--runtime", str(options.runtime),
        "--node", str(options.node), "--typescript", str(options.typescript), "--mode", options.mode]
    results = {}
    for name, app in (("reference", root), ("empty", options.task / "instrument/seed")):
        report = options.out / name
        execution = subprocess.run([*base_command, "--app", str(app), "--out", str(report)],
            env=evaluate.environment(), capture_output=True, text=True, timeout=180)
        value = json.loads((report / "evaluation.json").read_text())
        results[name] = {key: value[key] for key in ("passed", "checksPassed", "checksTotal", "businessPassed", "businessTotal", "runtimeQualified")}
        assert value["checksPassed"] == 54 if name == "reference" else value["businessPassed"] == 0
    original = (root / "app.mjs").read_text()
    mutants = {
        "revoked-authority": ([("fail(cap && !cap.revoked, 401", "fail(cap, 401")], "revocation-is-rechecked-before-successful-replay"),
        "same-subject-replay": ([("old.digest === digest && old.capabilityId === cap.id && old.importId === item.id", "old.digest === digest && old.importId === item.id")], "commit-replay-conflicts-on-body-and-worker"),
        "lease-capability-binding": ([("lease.capabilityId === cap.id", "true")], "lease-binds-precise-capability-not-just-subject"),
        "unchecked-checksum": ([("&& record.hash === hash(canonical({seq: record.seq, previous: record.previous, state: record.state}))", "&& true")], "valid-json-transaction-tampering-fails-closed"),
        "pre-body-authority": ([
            ("    const body = await readBody(request);\n    const result = await transaction(next => {", "    const admittedCap = authorize(state, token, workspaceId);\n    const body = await readBody(request);\n    const result = await transaction(next => {"),
            ("const cap = authorize(next, token, workspaceId), workspace = next.workspaces[workspaceId];", "const cap = admittedCap, workspace = next.workspaces[workspaceId];")
        ], "revoked-worker-cannot-use-admitted-lease")
    }
    controls = {}
    for name, (edits, target) in mutants.items():
        folder = options.out / "mutants" / name
        folder.mkdir(parents=True)
        for path in root.iterdir():
            if path.name in ("app.mjs", "cli.mjs", "sdk.mjs", "sdk.d.mts", "package.json", "STORAGE.md"):
                shutil.copyfile(path, folder / path.name)
        changed = original
        for before, after in edits:
            assert changed.count(before) == 1, (name, "mutation source mismatch")
            changed = changed.replace(before, after)
        (folder / "app.mjs").write_text(changed, encoding="utf-8")
        instance = None
        rejected, detail = False, None
        options.app = folder
        try:
            instance = evaluate.Service(options)
            instance.fixture()
            function = dict(evaluate.GROUPS)[target]
            try:
                function(instance)
            except AssertionError as error:
                rejected, detail = True, str(error)
        finally:
            if instance:
                instance.close()
        controls[name] = {"target": target, "rejected": rejected, "detail": detail,
            "mutantSha256": digest(folder / "app.mjs")}
        assert rejected, (name, "negative control escaped its intended group")
    result = {"kind": "private-headless-qualification-v1", "mode": options.mode,
        "runtimeQualified": options.mode == "bun-qualification", "reference": results["reference"], "empty": results["empty"],
        "negativeControls": controls, "negativeControlsRejected": sum(value["rejected"] for value in controls.values()),
        "negativeControlsTotal": len(controls), "requirementsSha256": digest(options.task / "instrument/BUILD_SPEC.md"),
        "evaluatorSha256": digest(options.task / "evaluate.py"),
        "referenceSha256": {path.name: digest(path) for path in root.iterdir() if path.is_file()},
        "noReferenceInPublicTask": True, "originalRequirementsUnchanged": True}
    (options.out / "qualification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"referenceChecks": results["reference"]["checksPassed"], "total": 54,
        "emptyBusinessPasses": results["empty"]["businessPassed"], "negativeControlsRejected": result["negativeControlsRejected"],
        "negativeControlsTotal": len(controls), "runtimeQualified": result["runtimeQualified"]}))


if __name__ == "__main__":
    main()
