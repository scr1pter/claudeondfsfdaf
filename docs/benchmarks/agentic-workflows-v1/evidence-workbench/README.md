# Evidence Workbench holdout

**Status: POSTLAUNCH instrument revision; not admitted to another paid case.**
Production candidate `893b9629224dc4249f08c0e18712511437a35a22` was frozen before
the original paid holdout exposure. In case `aw3`, the original matcher rejected
a useful, visible validation message because it omitted the word “failed” and
ordinary constraint phrasing. That is an instrument false negative, not a product
defect. The original paid report, 31 receipts, and $0.7953841 charge are retained.

The corrected evaluator passes all 26 checks on the same unchanged Codex source
in a free local rerun, without model repair or app changes. Pure controls pass
27 Python and 9 Node tests. This is a postlaunch correction after inspecting a
paid artifact; it does not retroactively turn the original frozen study into a
preregistered pass. `POSTLAUNCH.md` and `postlaunch-validation.json` record the
diagnosis and limits. `FREEZE_HISTORY.json` preserves both superseded freezes and
their exact source manifests. `SOURCE_MANIFEST.json` records the current sources.

Historical prelaunch evidence remains in `free-validation.json` and the
chronological `VALIDATION.md`: v1 typecheck, 2 smoke tests, build, and the full
unchanged-v1 negative gate completed, with 3 passed, 23 failed, no instrument
errors, and unchanged source. The first post-candidate review also corrected a
strict single-status assumption before any paid holdout exposure. None of those
historical records or raw artifacts was silently rewritten.

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
separate build/server/browser logs, and two end-state browser images to its private
output directory: `browser-final.png` at 1200×850 and `browser-mobile.png` at
390×844. Both show the same application state, with no extra app assertions or
focus changes; the prior viewport is restored afterward. Reports expose only
those safe relative image names. Every instrument fault is retained in `instrument-errors.ndjson`
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
