# Integrated CI harness repairs

2026-11-14; isolated `ci-fixture-repairs` branch from `641db1209`. No production store, erasure ordering, external model call, feature flag or paid evaluation behavior is changed.

## Desktop account fixture

The historical PR #33 free-model integration job [132528907281](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43621798725/job/132528907281), at `fbf1eb1b3`, failed `packages/web/test/desktop-account.test.ts:82`: the synthetic Redis handler treated the newly integrated permanent connector closure `SET` as an expiring sign-in code, expecting `EX 300 NX` and receiving no expiry arguments.

The fixture now stores the account revocation written through the real REST-style endpoint, models the empty Cloud-agent/Brain indexes and their erasure calls, and stores Everywhere's permanent closure without adding an expiry. Its identity-delete handler checks that those service cleanup steps happened first. Existing exact expiry assertions remain for actual sign-in codes and deletion grants. This is still an empty-service fixture, not a substitute for the disposable Redis Lua suites.

## Eval-script typecheck configuration

The current candidate job [132535483818](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43623926840/job/132535483818), at `57f6bf0c1`, fails while checking scripts through `script/vectorscope-eval/tsconfig.json`. The desktop baseline imports App/UI DOM code, but that standalone configuration inherits the engine TUI JSX runtime and its different type-import treatment. Ordinary App/Desktop typechecks passed in the historical run while this separate mixed-source configuration failed.

The standalone check now uses Solid DOM JSX and matches the App's type-import handling. Engine/App source, evaluation algorithms, costs, gates and model execution are unchanged. Validation runs only the TypeScript checker; it does not execute an evaluation.

## Workspace deletion retry fixture

Current-head cloud-workspace job [132535485451](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43623926606/job/132535485451), at `57f6bf0c1`, exposed another fixture mismatch: the closed-after-revoke/billing-retry case returned `true` from its revoke stub without storing the account fence. The integrated cloud-agent eraser correctly refused cleanup, leaving Codium, keys and identity pending.

The case now uses its existing `markRevoked(w)` helper, which stores the exact account mark with the same 100-day expiry already used by the deletion-route and cron fixtures. It additionally checks that mark while billing is still unavailable. The explicit failed-revoke case and the original workspace-fencing and identity-completion assertions remain. No production revocation, erasure, readiness or identity guard changed.

## Native Node connected-review fixture

The `57f6bf0c1` desktop bundle job [132535486900](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43623926779/job/132535486900) executed ordinary turns under native Node, then timed out waiting for the connected-review approval. Its fixture selected a chat model but omitted the owner's required explicit VectorScope model selection.

`packages/engine/script/smoke-node-bundle.ts` now sets `agent.vectorscope.model` in its synthetic owner-global configuration to its existing loopback-only smoke provider/model. All ordinary model identities, approval/readiness/privacy checks and smoke assertions remain unchanged. This adds no application fallback. Build and native smoke execution remain GitHub-CI-only; the local package typecheck is source evidence, not a native smoke pass.

### Follow-up: actual global configuration provenance

The first explicit-model repair did not fix the hosted smoke: exact `f2988d6ad` Node job [132552984489](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43629550831/job/132552984489) still timed out before owner consent. Static tracing identified a different source boundary: the fixture wrote its configuration only to `<temporary userData>/config/vector/vector.json`, passed as `VECTOR_AGENT_CONFIG_DIR`. Ordinary turns use that merged desktop configuration, but `ReviewModel.resolveReviewModel` intentionally obtains owner identity through `Config.getGlobal`. That loader reads `Global.Path.config`, which is `<XDG_CONFIG_HOME>/<VECTOR_APP_NAMESPACE>`; in this fixture it was the separate, empty `<temporary userData>/xdg-config/vector` directory.

The fixture now derives the real global path from the exact child environment and writes the same synthetic provider/owner-model configuration to both isolated sources before spawning the child and before its global configuration cache can load. The native acceptance also checks the actual `GET /global/config` response for the expected VectorScope model before starting the owner review. An early refused/error result is now reported immediately, rather than being hidden behind the approval-poll timeout. The later real approval, concurrent-start refusal, cancellation and durable-settlement assertions remain in place.

No product config loader, fallback, feature flag, identity requirement or timeout changed. This is not an owner UI/browser/native-input test. A successful local typecheck does not establish that the repaired native smoke passed; GitHub must run it on the new exact source revision.

Follow-up validation from an isolated worktree based on `f2988d6ad`: Bun 1.3.14 frozen installation with scripts disabled completed in 28.07 seconds with no lockfile change; `bun run typecheck` from `packages/engine` exited 0 without diagnostics. No smoke server, native input, browser, model or bundle execution ran locally.

## Validation

Windows; Bun 1.3.14. Frozen installation with scripts disabled completed in 35.23 seconds; the lockfile did not change. The coordinated local Bun slot was released after these checks:

- From `packages/web`, `bun test --timeout 30000 ./test/desktop-account.test.ts`: exit 0, 12 passed, 156 assertions, zero failures or skips.
- From `packages/engine`, `bun run typecheck --project ../../script/vectorscope-eval/tsconfig.json`: exit 0, no diagnostics. This checks types only; it does not execute a model or evaluation.
- From `packages/web`, `bun test --timeout 30000 ../../test/account-delete.test.ts`: exit 0, 37 passed, 454 assertions; one explicit CI-only Valkey test was not run locally. The real one-second HTTP deadline case also passed.
- From `packages/engine`, `bun run typecheck` after the Node owner-model fixture repair: exit 0, no diagnostics. No local smoke build or execution ran.

The first fixture repair run identified one further test-harness mismatch: Redis command arguments can arrive as numbers in JSON (the Lua key count), while the old fixture cast every argument to a string without conversion. The handler now normalizes command elements to strings, matching Redis's representation; the complete named file then passed. The production command format and scripts are unchanged.

For the workspace retry case, an initial attempt to use `revokeAccountTokens` directly correctly stopped at `revoke`: this billing fixture deliberately lacks Upstash's path-style REST endpoint. Reusing its existing durable-marker helper instead made the complete account-deletion file pass; the separate real revocation tests remain intact.

Exact-source hosted checks remain required after integration; queued, skipped and superseded checks are not passes. The earlier scope UI/Vite configuration failure was superseded by a successful `57f6bf0c1` UI run. Its Vercel commit status also became successful at 18:05:26 UTC; that receipt does not qualify later source revisions.
