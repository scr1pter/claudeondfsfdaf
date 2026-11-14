# Integrated CI harness repairs

2026-11-14; isolated `ci-fixture-repairs` branch from `641db1209`. No production store, erasure ordering, model call, feature flag or paid evaluation behavior is changed.

## Desktop account fixture

The historical PR #33 free-model integration job [132528907281](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43621798725/job/132528907281), at `fbf1eb1b3`, failed `packages/web/test/desktop-account.test.ts:82`: the synthetic Redis handler treated the newly integrated permanent connector closure `SET` as an expiring sign-in code, expecting `EX 300 NX` and receiving no expiry arguments.

The fixture now stores the account revocation written through the real REST-style endpoint, models the empty Cloud-agent/Brain indexes and their erasure calls, and stores Everywhere's permanent closure without adding an expiry. Its identity-delete handler checks that those service cleanup steps happened first. Existing exact expiry assertions remain for actual sign-in codes and deletion grants. This is still an empty-service fixture, not a substitute for the disposable Redis Lua suites.

## Eval-script typecheck configuration

The current candidate job [132535483818](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43623926840/job/132535483818), at `57f6bf0c1`, fails while checking scripts through `script/vectorscope-eval/tsconfig.json`. The desktop baseline imports App/UI DOM code, but that standalone configuration inherits the engine TUI JSX runtime and its different type-import treatment. Ordinary App/Desktop typechecks passed in the historical run while this separate mixed-source configuration failed.

The standalone check now uses Solid DOM JSX and matches the App's type-import handling. Engine/App source, evaluation algorithms, costs, gates and model execution are unchanged. Validation runs only the TypeScript checker; it does not execute an evaluation.

## Validation

Windows; Bun 1.3.14. Frozen installation with scripts disabled completed in 35.23 seconds; the lockfile did not change. The coordinated local Bun slot was released after these checks:

- From `packages/web`, `bun test --timeout 30000 ./test/desktop-account.test.ts`: exit 0, 12 passed, 156 assertions, zero failures or skips.
- From `packages/engine`, `bun run typecheck --project ../../script/vectorscope-eval/tsconfig.json`: exit 0, no diagnostics. This checks types only; it does not execute a model or evaluation.

The first fixture repair run identified one further test-harness mismatch: Redis command arguments can arrive as numbers in JSON (the Lua key count), while the old fixture cast every argument to a string without conversion. The handler now normalizes command elements to strings, matching Redis's representation; the complete named file then passed. The production command format and scripts are unchanged.

Exact-source hosted checks remain required after integration; queued, skipped and superseded checks are not passes. The earlier scope UI/Vite configuration failure was superseded by a successful `57f6bf0c1` UI run. Its Vercel commit status also became successful at 18:05:26 UTC; that receipt does not qualify later source revisions.
