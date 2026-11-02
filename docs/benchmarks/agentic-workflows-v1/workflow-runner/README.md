# Workflow Runner maintenance benchmark

This task upgrades an existing working serial job dashboard. It measures substantial code navigation, schema migration, real process orchestration, debugging and local browser use. It does not call a model or deploy anything by itself.

`TASK.md` is the agent-visible contract; copy it and only `seed` into an isolated model workspace. The seed intentionally implements v1, not the requested DAG scheduler. It must pass its own typecheck/build/smoke before evaluation, then fail the independent v2 gate for meaningful missing features. Do not reveal evaluator files, control implementations or another agent's delivered app as starter code.

The root runner reads `task.json`. It supplies explicit Python/Bun/Node paths and an isolated workspace/output. The independent gate has16API/process groups and8browser groups. It uses a fresh disposable v1 database for each group, preventing a failed or blocked case from contaminating later checks. `sourceUnchanged` compares authored source before/after evaluation, excluding standard dependency/cache/Git directories and only the declared app-root generated `dist` directory. Protected fixtures remain unchanged across agent work.

## Free validation

Use Bun1.3.14, Node24 and Python3.11+. Install the seed's pinned dependencies or use a controlled read-only dependency junction with the same lockfile. Run one Bun workload at a time.

```sh
cd seed
bun run typecheck
bun run build
bun test tests/smoke.test.ts
```

From this directory:

```sh
python -m unittest test_controls.py
python lifecycle_controls.py --bun <absolute-bun-executable>
node browser-controls.cjs --out <new-controls-output> --playwright <absolute-playwright-package> --chrome <absolute-chrome-executable>
```

The browser positive/negative controls use a synthetic finite-state HTTP stand-in to validate accessible locators and live UI observations. They are **instrument controls**, not a real scheduler/product pass. The lifecycle controls run actual protected worker processes, release barriers, fail-once attempts, and parent-death cleanup.

## Evaluate a candidate

```sh
python evaluate.py --app <candidate-app> --out <new-output> --bun <absolute-bun-executable> --node <absolute-node-executable> --task <this-directory> --playwright-module <absolute-playwright-package> --chrome <absolute-chrome-executable>
```

The last two paths can instead use `VECTOR_BENCH_PLAYWRIGHT_MODULE` and `VECTOR_BENCH_CHROME`. The gate never downloads a browser. `evaluation.json` has exactly24 named checks with `passed`, `failed` or `not_run`; verdict is `passed`, `product_failure`, or `instrument_failure`. Exit codes0/1/2 correspond to those verdicts. Browser startup/prerequisite failures are instrument failures, not evidence the product is wrong. App startup/build failures mark a product check failed and leave dependent checks not run.

All worker/database/browser state is synthetic and isolated. The gate controls fixture release files; application code must not forge them. Real subprocess PIDs are independently observed. A crash test kills the actual `bun server/index.ts` process, not a CLI wrapper, and the fixture exits when its parent disappears. Restart semantics are at least once, with interrupted attempts retained; arbitrary external side effects are not promised exactly once.

Browser transport uses the repository's reviewed `scripts/benchmarks/browser-driver/proxy.cjs` and `policy.cjs` to fence every HTTP redirect hop to the exact local app origin. Freeze those external dependencies alongside this task. Chrome receives a fresh owned short temporary profile and an explicit native OS-directory environment allowlist; provider credentials are excluded. Existing user browser profiles/accounts are never opened. The app's HOME/data environment remains isolated. This distinction is necessary for Windows Chromium startup and long-path handling.

## Freeze after review

```sh
python freeze.py
python freeze.py --write
python freeze.py --check
```

The first command only inventories source. Write the first manifest only after review and free controls pass. Never overwrite a freeze silently or change business assertions after seeing paid results. Record amendments and repeat both unchanged arms under the same corrected instrument. `artifacts`, dependency directories and Python caches are excluded from Git and freezing. Source uses LF checkouts so hashes remain portable.

The current reviewed instrument includes the [postlaunch keyboard-v2 correction](instrument-revisions/postlaunch-keyboard-v2/README.md).
Its original freeze and changed files are preserved verbatim in that revision's
archive. The corrected check uses ordinary user interactions and native Tab
traversal to reach all four required workflow form controls. The other seven
browser checks and all sixteen API assertions are unchanged. Free reevaluation
of all three unchanged baseline submissions passed the complete corrected gate;
original outcomes and repair charges remain retained.
