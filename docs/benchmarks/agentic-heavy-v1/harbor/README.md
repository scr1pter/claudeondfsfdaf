# Harbor heavy application benchmark

Harbor is a new local release and incident operations product build. It connects
project/environment configuration, versioned dependency plans, approval of release
snapshots, a durable bounded worker queue, retry/cancellation/recovery, artifacts,
rollback, incident timelines and audit history through a complete browser UI.
No application implementation is provided to a participant. There are no cloud
accounts, deployments, Docker jobs or external APIs in this task.

The product candidate was frozen before this specification was constructed. This
task is independent of the earlier Foundry business-operations task. Foundry's
wrapper format, pinned dependency scaffold and process-ownership helper were used
as infrastructure references; its application code and acceptance bodies were
not copied into Harbor. No current paid application outputs or cost outcomes were
inspected while constructing this task.

`BUILD_SPEC.md` and `UI_CONTRACT.md` are the public authoritative requirements.
`prepare.py` produces exactly six files: those two documents, `package.json`,
`tsconfig.json`, `bun.lock` and `.gitignore`. There is no server, frontend,
database, reference solution or test implementation in that scaffold. The native
heavy runner can copy `seed/` and the prompt named by `workspacePromptFile`.
`seed/UI_CONTRACT.md` is a byte-identical copy for that interface; preparation
controls require the copies to agree.

`evaluate.py` has 28 independent HTTP groups, 32 real-browser checks and four
separately labelled prerequisites: typecheck, build, startup and source integrity.
It writes exactly 64 fixed inventory rows to `evaluation.json`. Each row is
passed, failed or not_run. Unavailable fixtures/prerequisites cannot become a
pass. Unknown/duplicate/missing rows, contradictory browser summaries/exits,
source changes or unassessed evidence require instrument review. Passing requires
every row to pass. A complete synthetic report in the pure controls proves only
the report gate, never application correctness.

The API verifier checks concurrent idempotent admission, dependency ordering,
global worker capacity, failed descendants, selective retry, late completion after
cancellation, artifact bytes/hashes, rollback history, optimistic versions,
cross-project references, append-only logs and audit, durable sessions, completed
state across restart and crash recovery while two jobs are running. The browser
verifier creates its own isolated fixtures through accessible UI controls, then
uses read-only HTTP assertions as independent confirmation. It does not inject
application state or intercept responses to manufacture a pass. It also verifies
downloads, deep links, keyboard focus, a 390px layout, escaped user text and local
assets. Screenshot/source quality review remains separate from functional gates.

Run from this directory:

```sh
python -B -m unittest discover -p 'test_*.py' -v
python -B prepare.py --destination <new-app> --manifest <new-outside-manifest>
python -B evaluate.py --app <app> --out <new-output> --bun <absolute-bun> --node <absolute-node> --playwright-module <absolute-playwright-package> --chrome <absolute-chrome>
```

The evaluator launches only owned processes and synthetic browser profiles, uses
an allowlisted environment and isolated HOME/data directories, and does not read
provider credentials, load runtime configuration, call models or reset budgets.
Its application and build operations require the shared Bun workload lease. The
pure controls do not start Bun, applications, browsers, models or cloud services.
The evaluator's 1,200-second outer limit is supplied by the runner; individual
build/browser operations also have finite deadlines and preserve partial reports.

Before paid execution, freeze all task/instrument hashes, complete actual empty
scaffold and positive-reference runtime qualification, and publish a sanitized
qualification record. Preserve failed controls and instrument revisions. If a
verifier defect is found, record the revision and rerun the full unchanged gate;
do not weaken requirements to make an application pass. The positive reference
must stay outside the task root and participant workspace until the paid calls
finish; publishing it later does not retroactively make it a seeded solution.

No runtime qualification or paid outcome is asserted by this README alone.
