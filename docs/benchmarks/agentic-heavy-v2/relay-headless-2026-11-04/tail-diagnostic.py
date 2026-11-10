"""Separate post-run durability probe; never changes the frozen acceptance gate.

Only fresh synthetic runtime journals are damaged. Authored app source is checked
before and after. There are no model, browser, external network or paid calls.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace


def manifest(root):
    return {file.relative_to(root).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted(root.rglob("*")) if file.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("codex-source", "vector-source", "gate-root", "runtime", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    for name, value in vars(args).items():
        setattr(args, name, value.resolve())
    assert hashlib.sha256((args.gate_root / "evaluate.py").read_bytes()).hexdigest() == \
        "2a2abb4a47accc790b62af406003a48c09e6b92ba5c7c4b84bea55f19ca84999"
    assert not args.out.exists()
    assert all(not args.out.is_relative_to(source) for source in (args.codex_source, args.vector_source))
    sys.path.insert(0, str(args.gate_root))
    import evaluate

    rows = []
    for runtime, app in (("codex", args.codex_source), ("vector", args.vector_source)):
        before = manifest(app)
        for damage in ("missing-journal", "empty-journal", "complete-record-tail-truncation"):
            service = evaluate.Service(SimpleNamespace(app=app, runtime=args.runtime))
            try:
                service.fixture()
                service.applied()
                status, acknowledged = service.get("/members", "owner")
                assert status == 200 and acknowledged["version"] == 1 and len(acknowledged["members"]) == 1
                journal = evaluate.journal(service)
                assert journal.resolve().is_relative_to(service.data.resolve()) and not journal.is_symlink()
                service.stop()
                assert service.process.returncode == 0
                records = journal.read_bytes().splitlines(keepends=True)
                assert len(records) > 1 and all(record.endswith(b"\n") for record in records)
                if damage == "missing-journal":
                    journal.unlink()
                elif damage == "empty-journal":
                    journal.write_bytes(b"")
                else:
                    journal.write_bytes(b"".join(records[:-1]))
                row = {"runtime": runtime, "damage": damage, "acknowledgedVersion": 1,
                       "acknowledgedMembers": 1, "originalRecords": len(records)}
                exits_before_cleanup = []
                original_stop = service.stop
                def observed_stop(abrupt=False):
                    try:
                        service.process.wait(timeout=0.2)
                    except subprocess.TimeoutExpired:
                        pass
                    exits_before_cleanup.append(service.process.poll())
                    return original_stop(abrupt)
                service.stop = observed_stop
                try:
                    service.start()
                except AssertionError:
                    natural_exit = exits_before_cleanup[-1] if exits_before_cleanup else service.process.poll()
                    row.update(announcedReady=False, startupExitCodeBeforeCleanup=natural_exit,
                               refusedDamagedState=natural_exit not in (None, 0))
                else:
                    status, actual = service.get("/members", "owner")
                    row.update(announcedReady=True, readStatus=status, refusedDamagedState=False,
                               observedVersion=actual.get("version"),
                               observedMembers=len(actual["members"]) if "members" in actual else None)
                    row["acknowledgedStatePreserved"] = status == 200 and actual == acknowledged
                rows.append(row)
            except Exception as error:
                rows.append({"runtime": runtime, "damage": damage,
                             "diagnosticError": type(error).__name__, "outcome": "not_established"})
            finally:
                service.close()
        assert before == manifest(app), "diagnostic changed authored app source"
    result = {"kind": "post-run-journal-loss-diagnostic-v1", "providerCalls": 0,
              "sourceUnchanged": True, "originalAcceptanceAndReviewScoresUnchanged": True,
              "preRegisteredAcceptanceCheck": False, "rows": rows,
              "scope": "Three intentionally damaged fresh synthetic directories per implementation. "
                       "This is a post-run adjudication, not an added headline check or security certification."}
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
