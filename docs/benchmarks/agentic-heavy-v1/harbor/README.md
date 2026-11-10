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
node --test local-proxy.test.cjs
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

Runtime qualification on Windows passed all **64/64** positive reference rows:
28 API groups, 32 browser checks and four prerequisites. The exact empty scaffold
failed typecheck/build/startup meaningfully, with all 60 API/browser rows not_run,
zero application passes, unchanged source and no instrument error. Dependencies
were reused from an existing matching installation; no network install or model
call was used. All 11 reference authored files were independently preserved and
byte-unchanged during the passing evaluation.

Two full evaluations of deliberately damaged reference copies confirmed rejection.
Corrupting artifact hashes failed both the HTTP byte/metadata check and the real
browser download check. Adding an asset on a different owned loopback origin
failed the local-assets browser check, while that denied origin received zero
requests. These are controls of the verifier, not model-generated deliveries.
See `qualification.json` for sanitized per-check outcomes, raw-report hashes and
preserved preflight failures. The reference source remains outside this task and
is not published while study arms may still run.

The initial static snapshot remains in `static-freeze.json` and commit `672f833`.
Runtime qualification repaired instrument defects without changing either public
product contract: Windows ESM path conversion, owned AppData/temp creation, an
independent loopback assertion client compatible with proxy rules, guarded shared
proxy transport, and asynchronous/case-insensitive display assertions. The proxy
retains every denied transport separately; page-origin HTTP and WebSocket attempts
drive the application-assets gate. Chromium's own updater/autofill denials do not
become fabricated application requests. No denied transport is connected.

The final source freeze is `runtime-freeze.json`; `provenance.json` records the
infrastructure origins and revision limits. Passing these synthetic controls does
not establish production readiness, equal source/visual quality or any paid-model
outcome. Blinded source and screenshot review remain separate.
