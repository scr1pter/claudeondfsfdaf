# Evidence Workbench holdout

**Status: source frozen after production candidate
`893b9629224dc4249f08c0e18712511437a35a22`.** Local typecheck, both public smoke
tests, build, pure controls, and the full unchanged-v1 negative gate completed.
The negative gate executed all 26 inventory rows with 3 passed, 23 failed, no
instrument errors, and unchanged source. No paid holdout run was admitted or
performed at this freeze. `free-validation.json` and `VALIDATION.md` record the
evidence and limitations; `SOURCE_MANIFEST.json` freezes the external sources.

This independent maintenance benchmark is a neutral, entirely local document
research application. The seed is a working **v1** with JSON/NDJSON import,
SQLite-backed lexical lookup, and safe original-text viewing. The public task asks
for the substantial **v2** storage/API/browser upgrade. The seed intentionally does
not contain that upgrade or a gold implementation. Every corpus record is
deterministically generated synthetic text; there are no company records,
provider calls, cloud dependencies, embeddings, accounts, or PDF dependencies.

`task.json` follows the portable paired-study runner contract. Only `seed` and
`TASK.md` go into the coding workspace. The independent evaluator and all its
controls stay outside that workspace. The fixed inventory contains 18 API groups
and 8 browser checks; each always has exactly one `passed`, `failed`, or `not_run`
row. Exit codes 0/1/2 mean passed/product failure/instrument failure. A build or
startup failure is a product failure with a genuinely failed startup row and
unexecuted dependent rows. Missing local tools, Chrome/proxy failures, contradictory
browser results, evaluator exceptions, or source mutation are instrument failures.
Only genuine, failed product checks can supply bounded repair feedback.

Run the free controls from this directory:

```sh
python -m unittest discover -s tests -p "test_*.py"
node --test tests/browser_support.test.cjs
```

Only after the production-candidate freeze and completed admission gates, use
`python freeze_manifest.py`, then `python freeze_manifest.py --check`, to freeze
and verify the external task-source hashes.

Controls exercise positive and negative citation/UTF-8 assertions, plausible
receipt defects, deterministic corpus generation, fixed report inventory,
product-versus-instrument classification, protected files, exact generated-root
exclusions, and native Windows path-variable filtering. They do not execute Bun,
Chrome, a model, or an application reference implementation.

For the real baseline gate, copy `seed` to a fresh app directory **outside this
task tree**, copy `TASK.md` into that app, and use already-installed pinned
dependencies copied into the isolated app. Do not junction an entire shared
dependency directory: build-tool cache writes can escape through that junction.
Do not write shared dependencies. Set absolute
`VECTOR_BENCH_CHROME`, `VECTOR_BENCH_PLAYWRIGHT_MODULE`, and
`VECTOR_BENCH_BROWSER_PROXY` paths. The latter must be the runner-frozen common
`scripts/benchmarks/browser-driver/proxy.cjs`, with its sibling `policy.cjs`.

```sh
python evaluate.py --task <this-directory> --app <fresh-app> --out <fresh-private-output> --bun <absolute-bun> --node <absolute-node>
```

The gate runs typecheck, protected public smoke, build, an owned direct server
process, black-box HTTP acceptance, real restart and legacy migration, and an
owned Chrome profile. Browser transport uses the common strict HTTP loopback
proxy plus routing; routing alone is insufficient for redirect containment.
The profile is short and temporary; native OS path variables are preserved, while
provider credentials and browser-driver capabilities are not forwarded.
Service workers, downloads, WebSockets, external origins, and popups are blocked.
Each browser check uses exact public accessible names/test IDs. There are no
modals or existing user profiles.

The evaluator writes its complete report, before/after authored-source manifests,
separate build/server/browser logs, and a final browser screenshot to its private
output directory. Every instrument fault is retained in `instrument-errors.ndjson`
and the report. If a harness bug is fixed during unpaid validation, retain its
original failing output and record the correction in `VALIDATION.md`; never
silently relabel a harness failure as a product failure. No paid evidence may be
discarded or rerun automatically after an instrument failure.

Before paid evaluation, finish independent validation, freeze the candidate
production change, then freeze this task's external evaluator hashes with
`freeze_manifest.py`. The task SHA and common browser-driver tree are additionally
frozen by the portable runner. Any subsequent authored task change invalidates
that freeze. The parent production agent must not inspect hidden acceptance
details before its candidate change is frozen. Those local gates and the ordered
source freeze are now recorded. There is no full positive v2 reference
implementation; the passing pure positive controls and the unchanged-v1 negative
gate do not establish that every correct v2 implementation passes the suite.
No paid run is authorized by this README.
