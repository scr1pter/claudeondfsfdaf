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
lineage cases therefore remain Linux-CI requirements. The terminal-admission fixture also pins the mandatory
`unsandboxed_terminal` opening ask as the terminal's only sandbox-off ask: an admitted typed line asks exactly
`terminal_input` and then the shell's own command ask, with no `unsandboxed_shell` or `unsandboxed_terminal` ask. It
registers no tests on Windows, so a zero exit from that local file is recorded as not run, not a pass.

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

## 2026-11-16: Windows ripgrep install and native PR coverage plan

Branch `ci-install-retry` from `3ab7858e`. Both problems are in the CI harness; no product code, test assertion
threshold, timeout budget or feature flag changes.

### Chocolatey ripgrep install

Mechanism. The three Windows x64 steps that installed ripgrep (test.yml `unit` "Install ripgrep (Windows)",
`engine-windows` "Install ripgrep" in all 12 shards, windows-containment.yml `native` "Install native ripgrep") ran an
unpinned `choco install ripgrep`. Chocolatey makes one request to its community V2 feed and does not retry. In job
133556510297 (PR #40, run 43940493286) the feed answered 504 at 20:03:24; choco printed "Unable to find package
'ripgrep'" and "Chocolatey installed 0/0 packages." and exited 0, so the step's own `$LASTEXITCODE` check did not fire
and the step died later on "Cannot find path ...\lib\ripgrep\tools". Job 133557296076 (PR #38) shows the same sequence
with a 503. The step never continued without rg, but it named the wrong cause and one feed blip cost a full re-run.

Change. New composite action `.github/actions/install-ripgrep-windows` downloads the official ripgrep 15.2.0 release
zip from github.com (which every job already needs for checkout) with
`curl.exe --fail --retry 6 --retry-all-errors --max-time 60 --retry-max-time 180` and no `--retry-delay`, so the
exponential backoff stays. `--retry-all-errors` also retries a permanent 404 until the budget ends; the final error
names the URL. The worst case is under about 4.5 minutes, about 272 s: curl checks the 180 s budget only before its
backoff sleep, so an attempt that fails just before 180 s can be followed by one last backoff of up to 32 s (the sixth
retry) and one more full 60 s attempt. That stays inside the engine shards' 5-minute step limit with about 30 s left for
pwsh startup, hashing, `Expand-Archive` and `rg --version`; an overrun still fails the step loudly. The step timeouts
are unchanged. The zip's SHA-256 is compared with the release's published value
(x64 `71b2fef8…aafc5`, ARM64 `e4abca10…5360f`; no job uses ARM64 yet, so that branch has not run in CI), the archive is
expanded under `RUNNER_TEMP`, `rg --version` must report `ripgrep 15.2.0`, and only then is the native folder appended
to `GITHUB_PATH`. Every failure throws; there is no Chocolatey fallback. The three steps keep their names, their
conditions and their timeouts (10, 5, 10 minutes). windows-containment.yml now also runs when the action changes.
`packages/cloud/src/workflow-compliance.test.ts` pins this from the local files only: no workflow runs
`choco install ripgrep`, each of the three steps uses the action, and the action keeps its pinned version and hashes,
the curl exit check right after the download, the hash comparison and the version check before the one `GITHUB_PATH`
write.

Not changed: the `unit` (windows) job's "Run desktop computer-use tests" step still runs after a failed install
because of its own condition; the job still goes red. A release download that fails after all retries is a new failure
signature and should be triaged, not re-run blindly. Whether to drop "Chocolatey or ripgrep 504" from the known-flake
list is the lead's decision.

### computer-helper plan changed-path filter

Mechanism. The plan job (computer-helper.yml) runs on ubuntu-24.04, which has no ripgrep, and its pull_request branch
ran `if rg -q '<filter>' changed-paths; then extended=true; fi` under `set -euo pipefail`. Bash does not apply errexit
to an `if` condition, so exit 127 read as "no match": job 133587777165 (run 43940493286 attempt 2) logged
"line 24: rg: command not found", set extended=false and succeeded. mac-test and windows-arm64-test, gated on
`extended == 'true'`, were therefore skipped on every PR since 5a52aa04 added the check (for example
windows-arm64-test 133587780175 on PR #40; also PR runs 43829091585, 43871132549, 43940516400 and 43869650678). They ran
only after a merge to main, where extended=true is set without the filter (main push run 43930210165 passed them).

Change. The plan now requires a 40-hex base SHA, runs the identical POSIX ERE filter through `grep -qE` (which ships
with the image), treats exit 0 as extended, 1 as narrow and anything else as an `::error::` that fails the plan, and
writes the decision and changed-path count to the step summary. `packages/desktop/scripts/computer-workflow.test.ts`
now extracts the filter from the grep call, refuses any `rg` command in the plan, and runs the plan step's real script
in Bash against a temporary local Git repository: a native change gives extended=true, a docs change false, a shadowing
`rg` function is never called, a grep that exits 2 fails the plan with `::error::`, and a missing or unknown base SHA
fails. Against main's `if rg -q` text the new cases fail (checked locally by reverting just that block).

Expected cost: PRs touching native, computer or Hands paths, test.yml, computer-helper.yml, bun.lock or package.json
now run the two macOS mac-test jobs and windows-arm64-test again, as designed. Failures there are real until shown
otherwise, not flakes.

### Validation

Linux, Bun 1.3.14, frozen install with scripts disabled. One file at a time through the serial lock:

- `packages/desktop`: `scripts/computer-workflow.test.ts` 34 pass, 0 fail; `scripts/computer-overlay-workflow.test.ts`
  6 pass; `scripts/computer-release-workflow.test.ts` 9 pass; `bun typecheck` exit 0.
- `packages/cloud`: `src/workflow-compliance.test.ts` 54 pass, 0 fail; `bun typecheck` exit 0. Removing the curl exit
  check from the action makes the new guard fail.

The PowerShell action, the GitHub release download and the Windows and macOS jobs cannot run here. CI must show, on the
fix revision: the three Windows install steps print `ripgrep 15.2.0` and the following steps find `rg`; the plan job
on a PR that touches test.yml reports extended=true in its summary; and mac-test (macos-15-intel, macos-26) and
windows-arm64-test run and pass on that PR.

## 2026-11-17: Windows review parse child bound and phase marks

Branch `parse-test-windows` from `dabc4821`. Test harness only: `packages/engine/test/review/parse.test.ts`'s
`child()` helper and one new test for it. No product code, assertion, test deadline, shard layout or flag changes.

Failure. Main push run 43974310423, job 133679953818 ("engine (windows, shard 12/12)"): "parseMs times the parse
alone, not the first file's grammar load" timed out at 30001.27 ms, the log printed "killed 1 dangling process", and
then "# Unhandled error between tests: error: child exited 143: " (empty stderr) from parse.test.ts:1138 via :981. The
one fail and the one error are the same event.

Mechanism. `child()` spawned its own Bun process (env PATH, HOME=scratch, NODE_PATH only) and awaited stdout, stderr
and `exited` with no bound of its own. On the runner that child was still running at the 30 s test deadline; Bun
1.3.14 failed the test, SIGTERMed the leftover child as a dangling process (the same chain recorded for
task-manage.test.ts in multiagent-parity-deviations.md), the child's `exited` resolved to 143, and the still-running
body then threw after the test was already failed. Not the cause: the preceding wasm-trap test (its own child, exit 0,
329 ms); the shard list (identical 55 files at 7e440a27, where parseMs passed in 263 ms); code changes (parse.ts,
tree-sitter.ts, parse.test.ts, fixture.ts and preload.ts last changed Nov 6-12); a slow runner ("twenty large trees"
took 23.0 s, inside its 20.8-29.5 s range). Why the child stalled is not in the log: the old helper dropped stdout and
had no phase marks, so a stall in start-up, transpile, the wasm compile or process exit all looked the same.

Change.

- `child()` now bounds its own process: `Bun.spawn` `timeout` (default 20 s, far above the slowest Windows child seen,
  1.6 s, and under the 30 s deadline) with `killSignal: "SIGKILL"`. Any non-zero exit or signal throws inside the
  test with exitCode, signalCode, elapsed ms, "killed at its N ms bound" when the bound fired, and both streams.
  The bound is told by the parent's clock (at or past the limit, or within 50 ms of it with no exit code, for a timer
  that fires early), since Bun's `killed` reads true after any exit and a Windows kill may report no signal code.
- The generated child writes synchronous `fs.writeSync(2, ...)` phase marks with its own clock: `started` (from
  `mark.ts`, passed with `--preload`, so it runs before Bun resolves, transpiles or evaluates the script's static
  imports), `imported`, `ran` (after the body) and `exiting`. A first static import would not do: ESM loads the whole
  graph before any module body runs, so its mark would follow the engine modules' resolve and transpile (checked on
  Bun 1.3.14: with `--preload` the mark prints at about 13 ms, before a missing-module error). No
  grammar-ready mark: loading the grammar before the timed part would take it out of `wall`, which the parseMs
  assertion relies on.
- The child also gets SystemRoot and windir from the parent when they are set (on Windows), which Windows processes
  expect. Nothing else in its env changes: the job argues against env as the cause (the I-8 child ran right after the
  stall with the same minimal env in 325 ms, and more than 15 Windows child runs passed with it), so the profile,
  local-data and temp folders are not redirected until the marks point at start-up. A green shard 12 after this change
  does not tell the SystemRoot and windir pass-through apart from chance; only the marks of a repeat can.
- New test "the child() harness > a child that never finishes is killed at its own bound, and the error names the
  phases it reached" runs a never-ending child with a 5 s bound.

This is diagnostic work: if the stall returns, Windows shard 12 still goes red, but the failure is owned by the test
and names the phase. Next steps by phase: no marks at all is Bun start-up, before the preload runs (compare the
child's PATH with a passing run first, since #41 added the pinned-ripgrep PATH entry, then consider the Windows
profile and temp env); `started` without `imported` is resolve, transpile or top-level evaluation of the engine
modules (consider a per-child BUN_RUNTIME_TRANSPILER_CACHE_PATH inside its scratch directory); a stall between
`imported` and `ran` is the body,
in practice the grammar's wasm read or compile; one between `ran` and `exiting` is a handle keeping the event loop
alive; one after `exiting` is process exit. The last three go to Bun upstream with the marks, not to a workaround in
parse.ts, which sets no timers, workers or handles.

Validation (Linux, Bun 1.3.14, one workload at a time through the serial lock). With the new test and the old helper,
the run reproduced the CI shape exactly: "killed 1 dangling process", a 30000 ms timeout, then "# Unhandled error
between tests" with "child exited 143: ". With the change: `test/review/parse.test.ts` 60 pass, 0 fail; the shard-12
ordered pair `test/review/dismissals.test.ts test/review/parse.test.ts` 63 pass, 0 fail; `packages/engine`
`bun typecheck` exit 0. CI must show, on the next Windows shard-12 run, the trap, parseMs and I-8 children back in the
263-401 ms range and the new harness test passing.

Review revision (same branch, Linux, Bun 1.3.14, through the serial lock): `started` moved to a `--preload`, the
Windows profile, local-data and temp redirection dropped, the early-timer allowance added to the bound check.
`test/review/parse.test.ts` 60 pass, 0 fail; the ordered pair `test/review/dismissals.test.ts
test/review/parse.test.ts` 63 pass, 0 fail; `packages/engine` `bun typecheck` exit 0. The harness test still costs
about 5 s per shard that runs parse.test.ts; a 3 s bound would also sit above the slowest child start-up seen (1.6 s)
if shard time becomes a problem.
