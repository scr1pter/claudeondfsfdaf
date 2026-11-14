# Integrated CI harness repairs

2026-11-14; isolated `ci-fixture-repairs` branch from `641db1209`. No production store, erasure ordering, external model call, application feature flag or paid evaluation behavior is changed.

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

### Follow-up: isolated smoke child desktop identity

At exact `f830e3fdf`, both full Node jobs [132557600960](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024090/job/132557600960) and [132557497868](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024061/job/132557497868) progressed beyond the owner-global/consent failure and reported only the synthetic computer flow failing, with zero computer tools, commands, frames, clicks or consumed approvals.

The fixture's private `sidecarEnv` inherited `GITHUB_ACTIONS=true` from its hosted runner. `registry.ts` deliberately withholds computer tools under that identity through `GithubAgents.onActionsRunner` (INV-S13), including when a bridge is ready. The existing registry tests expressly cover both the withheld Actions case and an offered synthetic-ready desktop case. The product guard was working; the fixture was describing its isolated child as an Actions agent.

Only the private smoke child now receives `GITHUB_ACTIONS=false`, matching the desktop it simulates. The runner's environment is never modified. Existing isolated HOME/XDG roots, removal of inherited Vector bridge credentials and injection of only the generated-pixel, authenticated fake bridge remain intact. No production sidecar helper, registry, feature flag, capture, native input, browser, approval, image-attachment, lease or timeout behavior changed.

This narrowed repair is based on `f830e3fdf` in isolated branch `smoke-child-env`. `bun run typecheck` from `packages/engine` exited 0 with no diagnostics. Full smoke build/execution remains GitHub-only and still requires a fresh successful receipt; the local typecheck is not that receipt.

## Everywhere workflow dependency coverage

At exact `f830e3fdf`, job [132557814749](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024020/job/132557814749) passed 54 of 55 Everywhere test files. The only failing file was `everywhere-lane.test.ts`: its actual-import coverage assertion detected that the workflow did not watch the newly imported `api/_lib/codium-tombstone.ts`. This is a real CI coverage gap, not a reason to remove or narrow the assertion.

The helper is now in the workflow's pull-request paths, the same list consumed by the real main-push scope script. The strict expected helper list includes it too, and the existing Bash scope regression additionally checks that a tombstone-only change starts the lane. No trigger permission, dispatch, service, production code or test selection changed.

The named Windows check `bun test --timeout 30000 ./test/everywhere-lane.test.ts --test-name-pattern "the lane's shape"`, run from `packages/web`, passed eight cases and 57 assertions. Five Unix Bash scope/picker cases were filtered out and are not local passes; hosted Linux must run them, including the new tombstone-only case. The first Windows attempt also exposed a fixture scanner issue: `Bun.Glob` yields native separators, while `path.posix.dirname` requires forward slashes. Normalizing only those relative paths corrected the fabricated import names without allowing any additional source or dropping any actual-import check.

## Subsequent full-suite integration repairs

The original main checks were inspected: `43620662183` (types) and `43620664452` (Verify) passed; `43620659749`
failed on a retired numbered plan label quoted in the integration plan and on a scheduler-dependent exact token mean
in the memory HTTP fixture. The plan now describes the retired label without repeating it. The name scan also exhausted
Windows file handles locally because it opened all tracked files concurrently; batches of 64 preserve every scanned
file, strict matcher and coverage assertion. Its complete named file passed 6 cases / 54 assertions after the repair.

The memory fixture freezes and always restores its wall clock, ages an ordinary row by exactly one half-life, and
keeps the strict 1200-token / 0.20-cost expectations. It now also proves the exact 0.5 weight and equality between the
ordinary public arm and internal insight, including an unchanged second internal read after HTTP projection. The named
HTTP file passed 3 cases / 38 assertions. No production learning, tokenomics or privacy projection code changed.

Exact `f830e3fdf` full unit jobs `132557600940` (Linux) and `132557600965` (Windows) exposed duplicate paired-phone
alerts from the joined layout controller. The extra call is removed. Replacing an unviewed toast now dismisses only
the old toast, preserving the new alert's five-second cooldown; replies and close retain full dismissal. The unchanged
strict notification cases and new replacement-boundary case passed together: 10 cases / 37 assertions. App types pass.

The same source's six Node sandbox cells passed, but its Bun cell failed before executing the probe because Bun 1.3.14
misbundled the installed Undici ESM re-export. The CI-only assembler now preserves that installed wrapper byte-for-byte
as an immutable asset for the Bun artifact. A focused actual-import fixture checks both named and default exports.
Production runtime code and all containment, cleanup and deadline assertions remain unchanged. Engine types pass;
the new build/import test and real Bun cell still need fresh hosted execution.

These repairs are not final-head CI receipts. All affected shared lanes must qualify the next pushed candidate.

The broader Engine shards also exposed stale integration fixtures: the Engine manifest expected only 101 live events
despite retaining both Hands and Connect (the canonical Schema defines 102); the browser IPC inventory still named its
old inlined file; and a fix-worktree graph omitted explicit Connect opt-in, leaving its hidden fix agent undefined.
The manifest now checks the combined count; the inventory moves the same single IPC attribution to the extracted
helper; the graph opts in explicitly. Local named checks passed 2 / 5 / 13 cases with 25 / 12 / 175 assertions.
The five-review cap scenario omits an unrelated preceding-request review while retaining all five actual reviews,
the intervening fix and the refused sixth review. That actual private-Git path still requires Linux CI.

Two POSIX terminal cases now create real parent/helper Session rows instead of only populating a display-lineage map.
The terminal named file passed 16 cases / 63 assertions on Windows, with 39 POSIX cases explicitly skipped; the new
lineage cases therefore remain Linux-CI requirements. The terminal-admission fixture also distinguishes the mandatory
`unsandboxed_terminal` opening ask from typed commands' separate `unsandboxed_shell` ask. It registers no tests on
Windows, so a zero exit from that local file is recorded as not run, not a pass.

The connected authority fixes preserve verified lexical root and subtree mappings. Real Windows junction tests first
reproduced lost ASK/DENY and nonsecret preflight restrictions; they now pass without granting an unrelated parent or
sibling prefix authority. An observed alias retarget permanently retires its capability even if the old target is
restored. Full hub validation passed 48 cases / 378 assertions with independent review and Engine types.

HTTP instance middleware now verifies that the final workspace-routed path exists and is a directory before discovery
or bootstrap can create anything. Its actual named HTTP file passed 10 cases / 26 assertions, including literal percent
paths, missing paths remaining absent, ordinary-file refusal and workspace precedence. The consent/auth/cancel fixture
uses actual registered groups and handlers with an explicitly inert test member, retaining a separate actual production
assembly refusal check; 12 Windows cases / 125 assertions passed. No production member or injection backdoor is added.

## Validation

The remaining Connect review fixtures now select their model through the real owner-global configuration, restore
its exact previous bytes, and invalidate configuration after setup/cleanup. The headless child uses its own pinned XDG
configuration. CLI/Connect equivalence compares matching pinned HEAD and policy snapshots, including rules provenance;
the size-limit case retains an incomplete/partial result rather than claiming a clean review. These five test-only files
do not add a production fallback or alter protected review execution. Named Windows results: loop 2 cases / 26 assertions,
after-run 21 / 101, affected Scope guards 2 / 24, and Engine types. Heavy headless execution and Linux private-Git positive
paths remain CI-required; Windows guard returns are not evidence that those paths passed.

Windows; Bun 1.3.14. Frozen installation with scripts disabled completed in 35.23 seconds; the lockfile did not change. The coordinated local Bun slot was released after these checks:

- From `packages/web`, `bun test --timeout 30000 ./test/desktop-account.test.ts`: exit 0, 12 passed, 156 assertions, zero failures or skips.
- From `packages/engine`, `bun run typecheck --project ../../script/vectorscope-eval/tsconfig.json`: exit 0, no diagnostics. This checks types only; it does not execute a model or evaluation.
- From `packages/web`, `bun test --timeout 30000 ../../test/account-delete.test.ts`: exit 0, 37 passed, 454 assertions; one explicit CI-only Valkey test was not run locally. The real one-second HTTP deadline case also passed.
- From `packages/engine`, `bun run typecheck` after the Node owner-model fixture repair: exit 0, no diagnostics. No local smoke build or execution ran.

The first fixture repair run identified one further test-harness mismatch: Redis command arguments can arrive as numbers in JSON (the Lua key count), while the old fixture cast every argument to a string without conversion. The handler now normalizes command elements to strings, matching Redis's representation; the complete named file then passed. The production command format and scripts are unchanged.

For the workspace retry case, an initial attempt to use `revokeAccountTokens` directly correctly stopped at `revoke`: this billing fixture deliberately lacks Upstash's path-style REST endpoint. Reusing its existing durable-marker helper instead made the complete account-deletion file pass; the separate real revocation tests remain intact.

Exact-source hosted checks remain required after integration; queued, skipped and superseded checks are not passes. The earlier scope UI/Vite configuration failure was superseded by a successful `57f6bf0c1` UI run. Its Vercel commit status also became successful at 18:05:26 UTC; that receipt does not qualify later source revisions.
