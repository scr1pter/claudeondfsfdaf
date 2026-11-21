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

## 2026-11-20: Windows deferred removal without PowerShell command discovery

Branch `ownership-windows` from `7c7508d2`. Product code: `packages/engine/src/installation/windows-remove.ts`, the
two identity probes in `standalone.ts` and the same probe in `script/verify-windows-installer.ts`; diagnostics and a
portable guard in `test/installation/ownership.test.ts`. No assertion, test timer (30 s kill, 40 s cleanup, 45 s
test), 10 s acknowledgement, 15 min exit wait, 310 s `prepared()` deadline, shard layout or flag changes.

Failure. Main push run 44009054115, job 133814545422 ("engine (windows, shard 6/12)", head `7c7508d2`):
"Windows deferred standalone removal removes only owned files after its parent exits" failed at
ownership.test.ts:221 after 34381.02 ms with `exitCode` 143, empty stderr, the status file still
`{"state":"preparing"}` and the parent's last checkpoint `identity-command-finished` (code 0, 18-digit ticks). The
replaced-executable case after it, in the same process, passed in 2661.58 ms; earlier runs of the failing case took
1879-2393 ms. No file involved changed since `b57af809`, and no other Windows engine job on main or PRs #36, #43 and
#44 failed this test.

Mechanism. The parent was healthy: `launch()` had resolved and it was polling `prepared()`. Exit 143 is the test's own
30 s `child.kill()`. The detached Windows PowerShell 5.1 worker started, created its status file and wrote
`preparing`, then spent about 30 s before `prepared`. It was not stuck for good: the test's cleanup wait returned at
34.38 s, before its 40 s deadline, which only the worker's own `finally` can cause. Between the two writes the worker
ran `Get-Process`, a `StartTime` check, a `CreateNew`/`FileShare.None` lock open, `Get-FileHash` and `WriteAllText`.
The .NET calls throw at once rather than wait, and any throw writes `failed`, which never appeared. That leaves
PowerShell command discovery and module auto-load; `Get-Process` was the first use of
Microsoft.PowerShell.Management in that process (`New-Object` before `preparing` had already loaded Utility, which
also holds `Get-FileHash`). This is inferred from one sample: nothing timestamped the worker's steps. An equally
consistent alternative is contention on the shared module analysis cache with the identity probe's `powershell.exe`,
which had just run `Get-Process` and exited. Related evidence: release-approval.md:111-118 (discovery took
15,674.88 ms without `PSModuleAnalysisCachePath`, 1,161.65 ms with it; that variable reached this shard),
release-approval.md:467-477 (two deferred-uninstall cases stopped before scheduling earlier; the native-discovery
environment fix from then is in place here, so this is a remaining intermittent stall, not a regression), and
windows-holder.ts:157-160 (discovery "can otherwise wait indefinitely before Add-Type starts, even with -NoProfile",
under a different environment with no PSModulePath at all).

Change. The worker script and the identity probe now use operators and .NET only, so neither explanation applies:
`[Diagnostics.Process]::GetProcessById` in a `parentTicks` function (`$null` once the process is gone, `''` while it
is exiting or its start time cannot be read, keeping the old identity, acknowledgement and exit-wait semantics),
`[IO.File]::OpenRead` plus `SHA256.ComputeHash` for the hash (same `FileShare.Read`), `[Threading.Thread]::Sleep`,
`[IO.File]::Delete` and `[IO.Directory]::Delete` in `try` for cleanup, a regex `\uXXXX` escape for the failed-status
JSON instead of `ConvertTo-Json`, and `[Console]::Error` instead of `Write-Error`/`Write-Warning`. The `preparing`
status now names its step (`identity`, `lock`, `hash`); `prepared()` ignores the extra field. The test's checkpoints
add `at` and `elapsedMs`, and its early-exit error lists every fixture entry, so a recurrence names the phase and the
lock's presence separates the identity step from the hash step. A new portable test strips string literals and
comments from the generated worker and probe, then fails on any Verb-Noun word in any case, and on any bare word at
command position (line start, after `;`, `{`, `}`, `(`, `|`, `=`, `&`, `return` or `throw`) that is not a language
keyword or one of the script's own three functions. It reports every cmdlet in the `7c7508d2` script, and a scratch
check showed it also catches lowercase `get-process`, `measure-object` inside a block and the aliases `gps`, `sleep`,
`dir`, `gci` and `gc` after `=`, `&`, `(` and `return`.

Not changed, flagged for the lead or owner: `packages/web/public/install.ps1` is a live-site asset whose deferred
upgrade wait has the same exposure (`Get-FileHash` :105, :124, :148; `Get-Process` and `Start-Sleep` :151-167;
`ConvertTo-Json` :46), so a real Windows `vector upgrade` can still stall in discovery up to the 310 s deadline. Core's
`windows-powershell.ts` environment boundary and its native-discovery regression test stay as they are: the installer
needs cmdlets such as `Expand-Archive`.

Validation (Linux, Bun 1.3.14, one workload at a time through the serial lock): `packages/engine`
`bun test --timeout 30000 test/installation/ownership.test.ts` 6 pass, 2 skip (the Windows cases), 0 fail;
`packages/engine` `bun typecheck` exit 0; `bun turbo typecheck --concurrency=2` 27 of 27 tasks successful. No PowerShell
ran locally.

Open check: the root cause counts as confirmed only once Windows CI on this branch's PR shows every Windows engine
shard green and ownership's two deferred cases back near 2 s. That PR does not exist yet (the branch is not pushed);
record its run ID, the shard jobs' IDs and both cases' durations here when they finish.

## 2026-11-20: Windows patch-limit listing row and its after-test rejection

Branch `windows-engine-timeouts` from `56b2862b`. Test-only change in `packages/engine/test/cli/github.bundle.test.ts`.
No product code, assertion, 2,001-path count, 30 s test deadline, retry, skip or shard layout changes.

Failure. `writeBundle > patch-limit refusal: files, counted in the listing` timed out at its 30 s deadline twice on
Windows: main `dc89e4ec` run 44006980544, job 133785925116 ("engine (windows, shard 12/12)"), and PR #46 run
44666752560, job 136057825295 ("engine (windows, shard 1/12)"). In PR #46 Bun printed `killed 1 dangling process`,
then `(fail) ... counted in the listing [30011.98ms]`, then `Unhandled error between tests` with "Vector could not
record the run's changes." at `src/cli/cmd/github.bundle.ts:776:41` <- `#maybeClose` <- `#handleOnExit`. In `dc89e4ec`
no git child was running at the deadline; the dropped row body kept running alongside the next row instead, and
"files, deletions counted" took 27,765 ms against about 9.5 s normally. Linux and most Windows runs pass.

What the row does. `repository()` wrote README.md plus 1,001 distinct `tracked/<i>.txt` files, then ran `git add -A`
(about 1,002 loose objects) and `git commit` through Bun `$`. `make()` rewrote the 1,001 tracked files and wrote 1,000
new ones. `writeBundle` (no `timeoutMs`, so its own `GIT_TIMEOUT_MS` = 120 s) runs one git child per step:
`rev-parse`, `read-tree` into a private index, `ls-files --others` (1,000 paths), `update-index -q --refresh` and
`ls-files --modified` (1,001 paths); 2,001 is over `PATCH_LIMITS.files`, so it refuses before the add. The read-tree
index has no stat data, so the refresh and the listing each hash the 1,001 changed files. No other child process.

Timing (passing Windows runs, from the two investigations' job logs, e.g. main `4bb9bcb2` run 44007029816 job
133786559895 and codium-finish run 44009826105 attempt 2 job 136042932366): "files" (README plus 2,001 new files)
1.3-1.8 s, "deletions counted" (same 1,002-file base, little for writeBundle to read) 7.9-9.5 s, the listing row
8.4-13.2 s. So the base build (1,002 writes, `add -A`, commit) is about 6-7 s of the row and the product's hashing about
0-2 s: only 2.3x-3.5x headroom. In both failing jobs the first writeBundle rows ran 1.7x-10x slower for a short
stretch (in PR #46 "files" took 3,291 ms against 1,340 ms, and the next row ran a normal 9,211 ms). The logs do not
show what slowed the runner. On Linux the listing row takes about 144 ms, about 80% of it fixture.

Why the error lands after the test. When Bun times a test out it drops the test body's promise but lets its async work
run on, and kills the processes it still holds. Bun killed the git child `writeBundle` was waiting on; its `close` event
had a non-zero code, so `github.bundle.ts:776` rejected FAILED. That rejection travels `git()` -> `stage()` ->
`writeBundle` -> the row's `await bundle(...)`, whose promise Bun had already dropped, so it surfaces as an unhandled
error between tests. Reproduced locally with a scratch Bun test that mirrors `git()` (a `git hash-object --stdin`
child that never gets EOF, 1 s test timeout): with a 120 s signal Bun printed `killed 1 dangling process`, the test
failed at 1,001 ms and `Unhandled error between tests` followed with the close-handler FAILED via `#maybeClose`; with a
300 ms signal the same test failed inside itself with the abort FAILED and nothing landed between tests. The product
behaves as designed: a killed git is a failure, and `writeBundle` deliberately takes no signal.

Change. (1) A new `trackedRepository(count)` builds the two heavy rows' base cheaply: `git init`, README.md written
and added normally, one `hash-object -w --stdin` blob ("base\n"), all `tracked/<i>.txt` entries in a single
`update-index --index-info` call on stdin (1,001 `--cacheinfo` arguments would pass the Windows command-line limit),
then `commit`. 5 objects instead of about 1,005, and the tracked files are never written to disk; README.md stays on
disk, or `ls-files --modified` would count it and give 2,002. "deletions counted" no longer runs `fs.rm` of the
never-written `tracked/`. `sh()` gained an optional stdin `input`. The product path is unchanged: same 1,001-path base
tree, same read-tree, and the same refresh and listing hashing of 1,001 changed or deleted paths. Locally the base
build fell from 770-1,084 ms to 23-29 ms (5 runs each); on Windows the row should fall from 8.4-13.2 s to about 3-4 s.
(2) Every patch-limit row passes `writeBundle` its own `timeoutMs`, the 25 s left of a budget taken at the row's start
(at least 1 ms), so on a slow runner the product's git is stopped inside the row and the row fails with its own
error instead of a git child outliving it. This only tightens a bound and applies to these five rows only, not the
shared `bundle()` helper. It does not cover setup git run through Bun `$` that is still running at the deadline; step
(1)'s headroom is what prevents the flake. Not changed: `countChanges` hashes changed files twice on a fresh read-tree
index; the later add relies on the refresh's stat data, so leave it unless measured.

Validation (Linux, Bun 1.3.14, through the serial lock): `packages/engine`
`bun test --timeout 30000 test/cli/github.bundle.test.ts` 24 pass, 2 skip (the existing platform-selected cases), 0
fail; `packages/engine` `bun typecheck` exit 0.

Open check: confirmed only once Windows CI on this branch's PR shows every Windows engine shard green and the listing
and "deletions counted" rows near 3-4 s. The branch is not pushed yet; record the run ID, shard job IDs and both rows'
durations here when they finish.

## 2026-11-20: Windows isolated save renamed over an open record

Failure. PR #46 run 44666752560, engine (windows) shard 4/12, job
[136057825288](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/44666752560/job/136057825288):
`packages/engine/test/tool/task.test.ts` "task isolation saves > stopping the parent while a foreground isolated
child's normal save runs does not wait on Git" failed after 26,327 ms with "the save never finished after the Stop".
That is about 6.3 s of setup plus the whole 20 s `ISOLATED` wait; neighbouring isolated-save tests in the same job took
6.3-7.7 s, and the same test passed in 10.2 s on a slower runner (job 133427562994), so the deadline is not short: the
record never reached "changed". The rerun at the same SHA passed. Searches of engine (windows) jobs since `2034e1da`
found no other failure of this test.

Cause (the most likely one, not reproduced: Linux renames over an open file). The writer side of the race that
`20efba16` and `4435beab` fixed on the reader side. `TaskIsolation.find` reads record.json without the per-task lock
(the test polls it every 20 ms), and `privateRead` keeps the file open through stat, read and close. Every save goes
through `privateJSON`, which writes a temp file and renames it over the record with no retry, and Windows refuses a
rename over a file another handle has open with EPERM. Whichever save lost (markSettling's, settle's settling save or
`save(final)`) made settle's catch write `failed`, through the same rename; if that collided too, the error only
reached `BackgroundJob.finished`'s warning. The log shows no EPERM because settle stores the error in the record. Job
[133427562994](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43900984996/job/133427562994) (codium-finish
`0b9f8337`) showed the mechanism: its stress test's own `record.json.0.tmp` rename over a record held open by `find`
loops failed with EPERM, and `4435beab` removed that stress test and keeps the replace-under-open-handle case off
Windows, which hid the writer side. The parent's Stop is not involved: the job had ended, so `cancel` only joins it, and
the save runs in the uninterruptible `onExit`. A residual alternative leaves the same signature: `retire(final)`
failing after "changed" was written, which settle also turns into `failed`.

Change. `packages/engine/src/task/isolation.ts`: a new `cleared()` retries, on win32 only, an error
`LockFs.isTransient` accepts (EBUSY, EPERM, ENOTEMPTY, EMFILE, ENFILE) with LockFs's schedule (10 ms doubling to
250 ms, 2 s window), then reports it. `privateJSON`'s rename uses it (still removing the temp file on a final failure),
and so does `privateRead`'s open, which can meet a delete-pending record. Each retried open first re-runs the path
guard: Windows has no O_NOFOLLOW, so the path's lstat is the only symbolic link check there, and a retry would
otherwise stretch the gap between that check and the open from microseconds to up to 2 s. Readers still take no lock: Stop and the
Changes view must never wait behind a save that holds the task lock across Git. Other platforms are unchanged. `place()`
renames (merge and rollback) are not changed here. Tests: `packages/engine/test/task/isolation.test.ts` gains "a save
over a record another handle holds open waits for the handle and then replaces the record" (on Windows it is expected
to fail with EPERM without the fix; that rests on job 133427562994's EPERM and has not been run) and "a save over a record held open past the retry window fails on Windows, keeping the old
record and no temp file" (on other platforms the save replaces the record). In `task.test.ts` every "changed" wait in
"task isolation saves" now goes through `reached()`, `saveStarted`'s diagnostic generalised, so a timeout reports the
record's state, attempt, settled attempt and saved error, and names a failed save (EPERM rename) or a retire failure.
No deadline changed.

Validation (Linux, Bun 1.3.14, through the serial lock): `packages/engine` `bun test --timeout 30000
test/task/isolation.test.ts` 94 pass, 0 fail; `bun test --timeout 30000 test/tool/task.test.ts` 161 pass, 0 fail;
`bun typecheck` exit 0. After the per-retry path guard, the same three runs again: 94 pass, 161 pass, exit 0.

Open check: the Windows half of both new tests runs only on Windows CI, and neither Windows-only branch has run yet:
the old record staying "running" while the handle is open, and the EPERM failure after the retry window. Linux renames
over an open file at once, so local passes do not exercise them, and this branch has not yet shown the named cause (a
rename blocked by `find`). The branch is not pushed yet; record the run ID, the Windows engine shard job IDs and both
new isolation tests' results here when they finish, re-running the shards a few times. If the first test ever flakes on
Windows, look first at its one timing gap: once the poll sees the .tmp file, the save retries for at most 2 s while
the test does one more `find` and closes the handle, and the test's own deadline does not cover that gap. Do not
lengthen any deadline for it.

## 2026-11-20: Bun 1.3.14 crash in scrollback.surface (Worker terminated while loading)

Branch `scrollback-bun-crash` from `6a771354`. Changes: `patches/@opentui%2Fcore@0.3.4.patch` (registered in the root
`package.json` `patchedDependencies` and `bun.lock`) and one shared mock in
`packages/engine/test/cli/run/scrollback.surface.test.ts`. No assertion, test, timeout, shard layout or flag changes.

Failures. Bun 1.3.14 panicked ("Segmentation fault at address 0xFFFFFFFFFFFFFFF8", "Bun has crashed", then exit 132
or 139) inside `test/cli/run/scrollback.surface.test.ts` with no failing test: main `dabc4821` run 43974310423 shard
5/6 job 133679953809 (after "renders structured write finals once as code blocks"), PR #44 run 43988960845 shard 5/6
job 133728559216, PR #45 shard 5/6 job 133732849924, main `56b2862b` run 44676025086 shard 6/6 job 136088455729 (after
"does not emit blank patch snapshots between edit and task"); about 5 of ~50 six-shard Linux engine jobs. RSS stayed
below 1.1 GB. The earlier crash at the same address in multiagent-parity-deviations.md (shard 2/4 job 126909620047)
was not diagnosed and may share this cause.

Mechanism. Every test in the file creates and destroys an opentui test renderer. The writer's `<diff>` and `<code>`
elements are built as `new CodeRenderable(ctx, { id })`, whose `options.treeSitterClient ?? getTreeSitterClient()`
creates the process-global `TreeSitterClient`; its constructor starts a real `parser.worker.js` Worker. When afterEach
destroys the last renderer, opentui's `finalizeDestroy` destroys that singleton, and `stopWorker()` called
`worker.terminate()` 3-170 ms after spawn, while the worker's module graph (about 350 ms) was still loading. In the
Bun 1.3.14 sources, `WebWorker.shutdown` (`src/jsc/web_worker.zig`) unpublishes the VM, tears down JSC and runs
`vm.deinit()` without waiting for `RuntimeTranspilerStore.TranspilerJob`s on the shared WorkPool, which hold a raw
`this.vm` and later write its source maps (`putMappings`, `sourceMapHandler`). Our bun.report trace decodes to frame
offsets only (no symbols offline): its fault value is -8, the null-header `capacity` read of a freed HashMap, and its
frames sit on a pool thread, not the JS thread. That the frames are `SavedSourceMap.putValue` through
`runFromWorkerThread` is an inference from the source and the offsets, not a symbolized stack. The `bun:ffi` and
`napi_module_register` entries in the Features line are incidental. `MockTreeSitterClient` extends the real client in
0.3.4, so each test's mock also started a real worker (17 per file); those were never terminated, so they only widened
the window.

Evidence (local Linux, Bun 1.3.14, through the serial lock). A positive control that terminates each client's raw
Worker 5-45 ms after spawn crashed 4 of 5 runs of the file with trace
`C4j+hvE+ypR82oiwC4u41hDiytzhD2szqyD40w/uCm4lnB2svqCA2DR`: every frame equals CI's
`D4j+hvE+ypR82oiwC4u41hDiytzhD2szqyD40w/uCm4lnB2svqCA2DR` except the leading byte, and the platform/feature prefix
differs (`g/Bqkog` locally, `i/Hz6339/` in CI), so the strings are the same stack, not byte-identical reports. An
earlier unamplified local crash (1 in 19 plain runs) has the same frames. A second local signature from the shard-6
file sequence at main (fault 0x2B11, trace `Fz7339/D4j+hvE+ypRm4lnB2svqCA2AixV`, `workers_terminated(2)`) shares the
two top frames and the two thread-start frames and lacks the five middle ones: consistent with the same freed VM read
through reused rather than zeroed memory, with a shorter unwind, but not proven. Bun's non-TTY reporter prints no
passing tests, so that log cannot place it before scrollback.surface; a worker-logging preload on the same sequence
shows footer.view and the other earlier files spawn and terminate no worker, and scrollback.surface terminates exactly
two (both singletons), so `workers_terminated(2)` places it inside scrollback.surface. The Features counts therefore
do not attribute a spawn to footer.view; they depend on how many tests ran before the crash.

Change. The patch makes `TreeSitterClient.startWorker()` record `workerSettled`, which resolves on the worker's first
`open`, `error` or `close` event, and `stopWorker()` clear `this.worker`, detach its `onmessage`/`onerror` at once (so,
as before, a stopped worker's messages never reach the client) and call `terminate()` only once `workerSettled`
resolves. `open` fires only after `loadEntryPointForWebWorker` has resolved, so no entry-module transpile is in flight.
There is no timer fallback on purpose: a timed terminate would recreate the crash for a worker still loading, and
`parser.worker.js` has no top-level await, so a worker that neither opens nor fails is not expected. The cost of that
choice: such a worker would be detached but never terminated and would keep the process alive, so it would show up as
a hang at exit rather than a crash (before the patch it was terminated at once). A load failure emits `error`, so it
does not take this path. When the worker is already online, `terminate()` now runs one microtask after `stopWorker()`
returns instead of inside it; `handleReset()` reads the old `workerSettled` before `startWorker()` replaces it, so it
still terminates the right worker, and no caller in engine, tui or cli needs `terminate()` finished on return. Only
`index-54s7pk0d.js` calls `this.worker.terminate()`. The patch covers every opentui caller: this file,
`runtime.test.ts:626` in shard 4, and a real `vector run` exit. The test now shares one module-level
`MockTreeSitterClient({ autoResolveTimeout: 0 })`, so the file keeps one live mock worker instead of 17.

Side effect checked. A client that posted INIT before its worker was online now lets that queued INIT start (mkdir of
`<dataPath>/tree-sitter/{languages,queries}`, the `tree-sitter.wasm` dynamic import, `Parser.init`) before it is
terminated; the old code terminated first. INIT runs only for a client that was asked to highlight, which in production
already meant initializing; in this test file highlighting goes to the mock, so the singleton never receives INIT. A
scratch stress script (5 runs x 40 rounds, each destroying a real client 0-40 ms after `initialize()` and another
0-10 ms after `open` with INIT in flight, data path under a scratch folder) ended every run with exit 0, all 80
initialize promises settled per run and the INIT directories created. That shows the wasm import's window did not race
`terminate()` in 400 tries; it does not prove the import never uses a TranspilerJob. So a residual production risk
remains: if that dynamic import does go through a RuntimeTranspilerStore job, `terminate()` during it (for example the
TUI exiting while a client is still initializing) could hit the same Bun bug after `open`. This test file never sends
INIT to the singleton, so the CI trigger is fixed either way.

Validation (Linux, Bun 1.3.14, one workload at a time through the serial lock, from `packages/engine`):

- Frozen reinstall with scripts disabled after deleting the installed `@opentui/core` applied the patch; `bun.lock`
  changes only by the `patchedDependencies` entry.
- The same 5-45 ms amplifier routed through the patched `stopWorker()`: 0 crashes in 20 runs, 17 pass each.
- `bun test --timeout 30000 ./test/cli/run/scrollback.surface.test.ts`: 40 plain runs, 17 pass, 0 fail each.
- Shard-6 sequence (github.sandbox through scrollback.surface) at this branch with a worker-logging preload: no
  crash; 111 pass, 7 skip, 1 fail, the `run-process.test.ts` case below.
- Every other `test/cli/run/*.test.ts` file once: 32 files pass with 0 fail (`runtime.test.ts` 9 pass; `footer.view`
  22 pass, 5 skip). `run-process.test.ts` fails locally with or without the patch: 25 pass / 2 fail and 20 / 7 with
  it, 18 / 9 with the unpatched chunk swapped back in, at load average about 14. Each failure is a `vector run`
  subprocess reaching its 20 s or 30 s limit (for example "exits nonzero without reaching the process timeout when
  the model is unknown", `timedOut` true); the earlier diagnosis saw the same case fail at unpatched main. Those
  subprocess cases are local timing, not this change; CI is the check for them.
- `packages/engine` `bun typecheck` exit 0; Prettier clean on the test file.

Re-run class. Until CI on this branch's PR shows the six Linux engine shards green, a Bun "panic: Segmentation fault"
on a Linux engine shard stays in the known-flake re-run class (d). After this lands, the same panic in
scrollback.surface or `runtime.test.ts` means the patch missed a path and needs a root cause, not a re-run; record
the job, its bun.report string and its Features counts here.

Not changed, flagged for the lead. `packages/core/src/brain/worker/host.ts:280` terminates a Brain worker on its start
timeout, possibly while it is still loading, and `packages/engine/src/cli/cmd/tui.ts:227` terminates the TUI worker
after a shutdown RPC that can time out after 5 s (by then it is online). If the Bun bug is general, the first can hit
it. Upstream: an oven-sh/bun report (`WebWorker.shutdown` runs `vm.deinit()` while RuntimeTranspilerStore jobs still
hold that VM, with the trace and the amplified reproduction above) is not filed: filing is a public action left to the
lead or owner. The report should also say that the same freed-VM read may apply to a dynamic import that is still
transpiling when `terminate()` runs after `open`, since this patch only closes the entry-module window. No Bun 1.4.x
fix is confirmed (its source fetches came back empty), and @opentui/core 0.9.x still starts the real worker eagerly, so
there is no version to bump to. When a Bun release fixes it, bump setup-bun and the Bun
pin, re-run the raw amplifier on unpatched opentui, and drop this patch.

## 2026-11-20: piped-output smoke hung in Bun's shell output capture

Branch `piped-output-drain` from `14cb9720`. Changes: `vector.pipe` in `packages/engine/test/lib/cli-process.ts` and
the size and comment in `packages/engine/test/cli/smokes/piped-output.test.ts`. `packages/engine/src/index.ts` and
every assertion, deadline and flag are unchanged.

Failure. PR #49 run 44705365424, engine (linux, shard 1/6), job 136185709075: "piped output larger than the pipe
buffer all reaches a reader that starts late" timed out at 30003 ms. The helper's timeout fallback reported exit -1
with empty stdout and stderr, so the log could not show which side hung. The next test in the file passed.

Cause. The hang is in the test process, in Bun 1.3.14's shell output capture. The CLI's exit path is not involved.
`vector.pipe` ran ``$`bun run ... debug config | <reader>`.quiet()``, so the test process captured the reader's
stdout through an AF_UNIX socketpair that it polls with EPOLLIN|EPOLLHUP|EPOLLONESHOT. The reader echoes the CLI's
161,040-byte JSON in one write and exits about 1 ms later. When the test process's event loop reaches that socket only
after the reader has exited, the data and the hangup arrive as one event. `PosixBufferedReader.readWithFn` reads all
161,040 bytes with one recvfrom. More than 128 KiB (`stack_buffer_cutoff`) is now buffered and the hangup has been
seen, so it calls `onReadChunk(chunk, .eof)`. The shell's `PipeReader.onReadChunk` returns false and does not re-arm
the poll, and `readWithFn` returns without reading the real EOF and without calling `done()`. The capture never closes
and the ShellPromise never settles, although both processes have been reaped with exit 0. strace of a failing run
shows the 161,040-byte recvfrom after the reader's `exit_group(0)` and no EPOLL_CTL_MOD or recvfrom on that socket
afterwards; a healthy run reads before the reader exits, re-arms, reads 0 and closes. A loaded or starved event loop
(CI shard runners) is what makes the late read likely.

The window is a captured burst between 128 KiB and the socket buffer (212,992 bytes, `net.core.wmem_default` and
`rmem_default`). A standalone repro (``$`bun -e 'process.stdout.write("x".repeat(N))'`.quiet()`` with the parent
busy for 1.5 s) returned at N = 100,000, 125,000 and 300,000 and hung at 135,000, 160,000 and 200,000. Capturing
stderr hangs the same way, and redirecting the child's stdout to a file does not. Instrumented failures showed the CLI
writing all 161,040 bytes, `end()` calling back within about 1 ms, `process.exit(0)`, and the reader receiving
everything. Contrary to the test's comments, Bun's shell joins the stages with a socketpair on Linux, not a 64 KB pipe,
so 160 KB fitted in the link and the CLI's five-second flush at exit was never reached.

Change.

- `vector.pipe` sends the reader stage's stdout to a file in the fixture home (`| <reader> > <out>`) and the CLI
  stage's stderr to another (`2> <cli.err>`), and reads them once the shell settles. The real link between the CLI and
  the late reader, which the test exists to check, is unchanged. Bun's shell takes one redirect per command, so the
  reader's own stderr stays captured; the readers passed here write nothing there.
- On a timeout the result now carries the reader's output so far and a stderr that names the deadline, how many
  characters the reader had written, and the CLI's stderr, so a repeat shows which side stopped. The deadline stays
  30 s.
- The test's prompt grows from 160,000 to 512,000 characters (it travels through the `VECTOR_AGENT_CONFIG` file), well
  above the socketpair's capacity, so the CLI really is left with queued output and reaches its bounded flush when the
  reader starts late. The comments now describe the socketpair and the capture bug. The larger size alone would also
  have stepped outside the bug's window; it is not the fix.

Validation (Linux, Bun 1.3.14, one workload at a time through the serial lock, from `packages/engine`; "loaded" means
six busy-loop shells alongside the test, as in the diagnosis):

- Before, at `14cb9720`: 2 of 4 loaded runs hung at about 30.2 s (stopped after the second hang); the diagnosis saw
  1 of 5 plain runs hang and 2 of 7 loaded.
- After: 25 of 25 loaded runs pass, 15 of 15 plain runs pass. With the helper change and the size set back to 160,000,
  10 of 10 loaded runs pass, so the helper change fixes it on its own.
- A scratch call with a 2.5 s deadline and a reader that writes "early" then sleeps returned `timedOut`, stdout
  "early" and the new timeout report. That scratch file was deleted.
- `piped-output.test.ts` is the only `vector.pipe` caller. `packages/engine` `bun typecheck` exit 0; Prettier clean on
  both files.

Upstream. A Bun report with the standalone repro above (the fault is in `readWithFn`'s `stack_buffer_cutoff` branch in
`src/io/PipeReader.zig`, which returns without `done()` when `onReadChunk(.eof)` returns false) is not filed: filing is
a public action left to the lead or owner. Any other test that captures a 128 KiB to 208 KB burst through Bun's shell
`.quiet()` or `.text()` can hang the same way.

Review follow-up.

- Margin. At 512,000 characters the Linux run now depends on the CLI's five-second flush at exit, which 160,000 never
  reached. The reader starts reading about 3 s after the pipeline starts and the window opens when the CLI finishes, so
  the margin is about 2 s. If a starved runner wakes the reader after the window, the CLI exits with output still
  queued and the test fails fast with truncated JSON, not a timeout. That is the case the test exists to check (Windows
  already runs it). If it ever flakes as truncated stdout, look at the 3 s reader sleep against the 5 s flush bound
  before suspecting the helper; the timeout report tells the two cases apart.
- Reader stderr. It is still captured by the shell, so a reader passed to `vector.pipe` must keep its stderr well under
  128 KiB; the helper's comment says so. If Bun's shell ever allows two redirects per command, send it to a file too.
- On success the CLI's stderr and the reader's captured stderr are now separated by a `--- reader stderr ---` line
  (only when the reader wrote any), as the timeout report already separates its parts.
- Windows. Only Linux was validated locally. Check the Windows engine shard that runs `piped-output.test.ts` on the
  PR's CI (the `2>` and `>` redirects and the 512 KB size) before merging.

## 2026-11-20: Windows company policy folder test reached the real PowerShell ACL reader

Branch `policy-acl-timeout` from `8e34d05e`. Changes: `packages/engine/test/config/local-policy.test.ts` and
`packages/engine/test/fixture/managed-policy.ts`. `packages/core/src/config/managed.ts` is unchanged: a failed or
timed-out PowerShell read still yields no entries, an `unreadable` verdict and Vector Local on with Web access None.
No deadline, assertion, skip or retry changed, and the 20 s PowerShell timeout stays.

Failure. main push run 44746217530 at `8e34d05e`, engine (windows, shard 9/12), job 136322673267:
`local-policy.test.ts:1254` "sources Vector cannot read > a company policy file that is a folder turns Local on with
Web access None" took 20831.45 ms and its first warning was `Vector could not read who may change <managed>.` instead
of `Vector could not read <managed>\vector.json.` The second warning, `enabled: true` and `web: "none"` held. Every
shard passed at `14cb9720`, and `14cb9720..8e34d05e` touches only `cli-process.ts`, `piped-output.test.ts` and a doc.

Cause. A test-isolation gap. This was the only test in the file that made the managed path itself (`mkdirSync(file)`)
instead of calling `writeManaged()`, so it never installed `useManagedPolicyFixture`. On Windows `ConfigManaged.read()`
then went `check()` -> `windowsCheck()` -> `cachedAcl()` -> the real `powershellAcl()`, a `spawnSync` of
`powershell.exe` with a 20,000 ms timeout. Process starts on this runner were slow at the time, and the cold PowerShell
start (normally 2 to 3.5 s) most likely ran past the timeout; a non-zero status gave `{ entries: {} }`, and
`windowsCheck` reported the first missing entry, the folder. The product failed closed as designed. The slow start is
inferred from the timing below, not observed directly: the log shows nothing from inside the 20 s window.

Evidence.

- 20831.45 ms is the 20,000 ms timeout plus about 0.8 s.
- The same shard, 20 to 47 s earlier, ran neighbours 3.5 to 6.7 times slower than a passing run (44736225208): "the
  policy is resolved before the first catalog fetch" 25379.50 ms against 5222 ms (finished 14:03:40), "the environment
  turned on ..." 11554.31 ms against 1720 ms (14:03:51), "a nested vector keeps Local on ..." 12220.72 ms against
  3498 ms (14:04:07). All three spawn child Bun processes. The folder test started at about 14:04:27.3; the tests just
  before it (14:04:24 to 14:04:27) and just after it (from 14:04:48.17) ran at their usual millisecond times. That points to slow process creation on this runner, not a slow PowerShell path in `managed.ts`.
- In 14 sampled runs this test took 1819 to 5415 ms except the one failure. A product cause (a stdin wait, the minimal
  environment, the script blocking) would slow every call, not one in 14.
- `test/fixture/managed-policy.ts` exists so policy-semantics tests skip Windows ACL discovery. Its reader answers SYSTEM
  as owner, with no rules, for the managed folder and every managed file in it that exists, a folder named
  `vector.json` included, so the verdict is trusted and the read of the folder then fails with exactly the two warnings
  the test asserts, the same path the passing runs took through real PowerShell.

Change.

- The folder test installs the fixture right after `mkdirSync`, with the same line `writeManaged()` uses:
  `managedFixture.restore ??= useManagedPolicyFixture(managedDirectory)`. The existing `afterEach` restores it. Both
  exact assertions stay.
- The fixture's reader is now the exported `managedPolicyAcl(directory)`; `useManagedPolicyFixture` installs it on
  Windows as before and is still a no-op elsewhere.
- Pins that run on Linux too: the file's `afterEach` now fails a test that leaves a company policy file
  (`vector.json` or `vector.jsonc`, a folder of that name included) in the managed folder without the fixture
  installed, and a new test checks, with `platform: "win32"`, that the fixture's reader makes `check()` trust a folder
  named `vector.json` and answers only for its own managed paths that exist (not an absent `vector.jsonc`, not
  `other.json`).

Validation (Linux, Bun 1.3.14, through the serial lock, from the package directories):

- `local-policy.test.ts` 69 pass, 2 skip, 0 fail; `core` `managed.test.ts` 3 pass, 1 skip; `bun typecheck` exit 0 in
  `packages/core` and `packages/engine`.
- `managed-trust.test.ts` 25 pass, 3 skip, 1 fail: "POSIX ownership > checks the real file and every folder above it"
  expects a file the test user made not to be root's, and this sandbox runs as root (uid 0). The file is not touched
  here; CI runs it as a standard user.
- Mutations, each red on Linux, then restored with matching sha256: dropping the new fixture line from the folder test
  (the `afterEach` guard fails), removing `vector.json` from the fixture's owned paths, and changing the fixture's owner
  to Users (`S-1-5-32-545`) (the new check test fails on both).

What Windows CI must show.

- The engine (windows) shard holding `local-policy.test.ts` (shard 9 at `8e34d05e`'s file list) passes, with the folder
  test unchanged and exact. That test takes milliseconds with no PowerShell start and never logs "could not read who
  may change".
- The shard holding `managed-trust.test.ts` (shard 12) still passes its real PowerShell tests ("checks a real file's
  access rules with PowerShell" and the trusted managed file tests).
- Linux and macOS engine shards are unchanged.

Note. `managed-trust.test.ts` still runs real PowerShell on purpose; it is where the fixture contract puts the Windows
allow/deny integration. A runner stall of the same size could fail it the same way. That would be runner contention,
not a product bug: check the shard's neighbouring test times before suspecting `managed.ts`. Optional follow-ups, not
part of this fix: `-InputFormat None` on the PowerShell call (tested only in `managed-trust`), and a review of the
synchronous 20 s `spawnSync` blocking the desktop's 30-second policy refresh.

Review follow-up.

- The first `afterEach` guard failed any test that ran while the managed folder existed. An empty folder is harmless
  (`ConfigManaged.read()` checks only the policy files that exist), but `test/cli/run-local.test.ts` left one behind:
  its `afterEach` removed only `managed/vector.json`. `preload.ts` picks the managed folder once per process and a shard
  runs its files in one process, so had the two files landed on the same shard, or run in one local `bun test`, the
  first local-policy test (which uses no managed policy) would have failed the guard. The guard now looks only for
  `vector.json` and `vector.jsonc`, and `run-local.test.ts` removes the whole managed folder after each test.
- `managed-trust.test.ts` gains a Windows-only real PowerShell test that a folder named `vector.json` in the policy
  file's place is read (trusted with `user: true`), the `[System.IO.Directory]::Exists` branch of `ACL_SCRIPT` that the
  folder test in `local-policy.test.ts` used to cover through real PowerShell before it moved to the fixture. It runs
  only on Windows CI (shard 12 at `8e34d05e`) and was not run locally.
- Validation (Linux, through the serial lock): `local-policy.test.ts` 69 pass, 2 skip; `run-local.test.ts` 5 pass;
  `managed-trust.test.ts` 25 pass, 4 skip, 1 fail (the same root-uid sandbox failure as above); `bun typecheck` exit 0
  in `packages/core` and `packages/engine`. Mutations, each restored with matching sha256: an empty managed folder
  made at load time stays green with the new guard and turns "the policy is resolved before the first catalog fetch"
  red with the old one; dropping the fixture line from the folder test still fails the guard; dropping the fixture
  reader's `existsSync` filter fails the renamed fixture test.

## 2026-11-20: Windows helper compile at the 300 s cmake deadline

Branch `native-build-parallel` from `8e34d05e`. Changes: `/MP2` to `/MP4` in the shared compile options of
`packages/desktop/native/computer-helper/windows/CMakeLists.txt`, and `CMAKE_BUILD_PARALLEL_LEVEL: "2"` plus a
processor-count line on the two Windows helper build steps (`computer-helper.yml` "Build both channel helper
architectures", `test.yml` "Build only the x64 native diagnostic artifacts"). The build script, the overlay-smoke
script, `macos/`, `identity.json` and `macos/identity.lock.json` are unchanged; `helperVersion` stays 1.0.15.

Failure. PR #51 (engine tests and docs only) test.yml run 44759083191. Attempt 1 failed only in the known HF-7 overlay
Stop flake (job 136368889023; its step 9 passed in 562 s). The re-run's windows-build job 136403306943 failed in step 9
with "The native helper command failed: cmake (timed-out)." Step 9 ran from 16:07:36.15 to 16:17:52.37 (616 s). The
captured output is the ARM64 `cmake --build build --config Release`: computer-core (35 files), then caller, target,
overlay-driver-support and vector-computer, then the unit list, stopped at `accessibility_tests.cpp` (24 of 29), with
no node prefixes and no compiler error.

Cause. The build is compute-bound and had almost no room under the fixed 300000 ms per-command cap
(`build-computer-helper.ts:467`). It is not a hang, a flake or anything in PR #51. Every target compiled with `/MP2`,
so two cl workers ran on a runner that very likely has 4 vCPU, and `cmake --build` had no `--parallel`, so MSBuild
built projects one at a time. computer-core and then vector-computer-tests have to run in order (tests link core and
depend on vector-computer and computer-test-caller), so project parallelism can only overlap the four one-file
projects. Source growth since Nov 14 (+3.1% lines) and possibly image 20261116.315.1 (MSVC 14.52) used up the margin.
Precedent: run 42031291175 hit the same deadline and `/MP2` fixed it (`hands-progress.md`, "Windows native compile
budget evidence").

Evidence (step 9, both architectures including configure; the groups do not overlap):

| Group          | Step 9 (s)                                     | Per-architecture build (s, inferred: half of step 9; not measured) | Note                       |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Fast passing   | 314-342                                        | about 155-170                                                      | well under the cap         |
| Middle passing | 400, 410, 470                                  | about 200-235                                                      | 67-78% of the cap          |
| Slow passing   | 514-562 (recent: 555, 555, 558, 562)           | about 255-281                                                      | 85-94% of the cap          |
| Timed out      | 616 (job 136403306943), 620 (job 136058227563) | ARM64 `--build` killed at 300 (the cap); x64 under 300 (it passed) | both slow-group, new image |

In the two timed-out jobs, x64 configure and build, the ARM64 configure and the script's toolchain probes took about
316 s and 320 s (step 9 minus the 300 s kill), so the x64 `cmake --build` was itself close to the cap. Both observed
kills were in the ARM64 `cmake --build` (136403306943 on `accessibility_tests.cpp`, 24 of 29 unit files; 136058227563
after printing all 29 unit sources). That build is also the second build command in step 9, so these two jobs cannot
tell whether ARM64 compiles slower or the kill simply lands on whichever build runs second.

The overlay-stage build (37 files, same CMakeLists) took 83-150 s and tracks step 9 (r = 0.84). Passing jobs print no
per-command times, so per-command figures are inferred from step durations and the two kill points. The 4-vCPU count
is inferred: this repo's ubuntu-24.04 runner recorded `cpuCount: 4` and 16.7 GB in
`docs/benchmarks/vector-hands-1.99.112/baseline-manifest.json`, the standard tier that also covers windows-2025. The
new step line makes it a measurement.

Why only CMake and the workflows. `scripts/build-computer-helper.ts` and `scripts/build-computer-overlay-smoke.ts`
are in `COMPUTER_HELPER_BUILD_INPUTS`, which feed the darwin source digest under the enforced macOS identity lock
(helperVersion 1.0.15). Editing either would fail "Enforce the measured production identity lock" and break
invariant 2. `windows/` feeds only the Windows digest, and the workflow files are not digest inputs. The script
already passes `process.env` to cmake, so `CMAKE_BUILD_PARALLEL_LEVEL` reaches MSBuild as `/m:2`.

Change.

- `/MP4` in place of `/MP2`; every other compile and link flag is unchanged. The count stays explicit so the worker
  count and memory never follow a larger host. `/MP4` is per project: with the workflow's `/m:2`, at most eight cl
  workers run while two multi-file projects overlap. The dependency chain (computer-core, then vector-computer-tests)
  keeps that to the short window when the one-file projects build alongside one of them. `/MPn` changes only how many cl
  processes run; each translation unit still compiles the same way under `/Brepro`, and link order comes from the
  vcxproj source order. Because the vCPUs may be SMT siblings, expect the compile phases to speed up about 1.4-1.9x, not
  2x.
- `CMAKE_BUILD_PARALLEL_LEVEL: "2"` on both build steps (expected saving about 15-30 s) and
  `Write-Output "logical processors: $env:NUMBER_OF_PROCESSORS"` before the bun call.
- The 300000 ms cap, `timeout-minutes: 20` and `timeout-minutes: 15` are unchanged. Nothing retries, skips or lengthens
  a deadline. Precompiled headers were rejected for this fix: they change the compile pipeline and object generation.

Validation (Linux; no native tool runs here):

- `build-computer-helper.test.ts` (20 pass) gains a CMakeLists pin: exactly one `/MP4` and no other `/MP` flag in the
  file, the eight hardening and reproducibility compile flags, the `/guard:cf /Brepro /PDBALTPATH:%_PDB%` link
  options inside the `VECTOR_COMPUTER_TARGETS` loop, and every `add_library`/`add_executable` target listed there
  (with computer-overlay-driver appended under `VECTOR_COMPUTER_OVERLAY_DRIVER`). The injected win32 fixture now
  records each call's settings and checks that both architectures' configure and `--build` get `timeoutMs: 300000` and
  that an injected `CMAKE_BUILD_PARALLEL_LEVEL` reaches each `--build` env.
- `computer-workflow.test.ts` (37 pass) checks both build steps set exactly `CMAKE_BUILD_PARALLEL_LEVEL: "2"`, log the
  processor count first, and keep 20 and 15 minutes.
- Mutations, each red and then restored to its recorded sha256: `/MP4` to `/MP2`; dropping `/sdl`; the script's
  300_000 to 600_000; the computer-helper.yml level "2" to "4"; test.yml's 15 to 20 minutes.
- `packages/desktop` `bun typecheck` and the full turbo typecheck pass.

What Windows CI must show. At least 3 windows-build jobs, including at least one slow-group job (overlay-stage proxy at
least 135 s before, or clearly above the fast group after). The logged processor count must be 4. Step 9 at or below
about 420 s in every job, and the fast group at or below about 260 s, which is about 190 s or less per `cmake --build`
(at least 35% headroom) and about 25 s or less per configure. windows-arm64-test, the native units, the fresh
version/probe checks and the overlay-stage build must also pass. Before judging headroom, compare the x64 and ARM64
build times rather than halving step 9. Passing step logs do not show them: `build-computer-helper.ts` captures cmake
output and prints it only on a failure, so no timestamped `vector-computer-tests.vcxproj ->` lines appear, and adding
per-command timing there would move the darwin source digest. Use what the logs do give: any killed command's captured
output names its architecture, and the x64-only "Build only the x64 native diagnostic artifacts" step in test.yml's
computer-helper-windows-units job times x64 alone (on a different runner, so only as a rough share). Until the split is
known, treat the ARM64 build as the binding one. The overlay-stage build (`diagnose-build-computer-overlay-smoke.ts`)
uses the same CMakeLists but its steps do not set `CMAKE_BUILD_PARALLEL_LEVEL`, so its timings reflect `/MP4` alone and
understate any `/m:2` saving in step 9. If a slow-group step 9 exceeds about 470 s, this is not enough: the next lever
(a measured per-phase `--build` budget or precompiled headers, which need a helperVersion bump and a re-measured macOS
lock) goes to the lead as its own package, and the cap is not changed silently. Only the Windows source digest changes;
since `VECTOR_COMPUTER_SOURCE_DIGEST` is a build define, the Windows exe hash changes for that reason alone. PR #51
did not wait for this merge: the fix was ported into it as merge commit `a3fe7af1`, and both merged (#52 as
`c776fb60`, #51 as `15f3ba77`).

## 2026-11-20: Windows region observer at deadline_compile on a cold PowerShell 7 compiler

Branch `region-compile-budget` from `15f3ba77`. Changes: `packages/desktop/scripts/computer-overlay-smoke-window-region.ts`
(a bounded compiler warm-up and Node-side phase timing), `computer-overlay-smoke-window-region-report.ts` (an optional
closed `elapsed` field), a new entry `scripts/computer-overlay-smoke-region-warm.ts`, one new windows-build step in
`.github/workflows/computer-helper.yml`, and their Linux tests. `REGION_SCRIPT`, the 15 s observer limit, the 120 s
parent limit, the command path and flags, stdin, `maxBytes`, the receipt parser and every native check are unchanged.

Failure. main's push run 44791067930 of test.yml (head `c776fb60`) failed only in computer-helper / windows-build job
136479415862, step 15 "Run real Electron overlay properties and controller lifecycle":
`computer-smoke-window-region {"windows":4,"owned":0,"simple":0,"matched":0,"painted":4,"ok":false,"reason":"deadline_compile"}`,
then overlay-bounds and computer-smoke-failure assertion_failed. Both follow from the region line, because on Windows
`boundsMatch` is the region proof.

Cause (inferred when written; measured on 2026-11-21, see "2026-11-21: warm-up evidence" below, which supports the cold
first Add-Type and not the Electron first-launch alternative). As written on 2026-11-20: consistent with a cold first
Add-Type; launch versus compile was not yet measured, and contention with the first Electron launch was not excluded. Step 15 is the job's first
Roslyn use: the only Add-Type in `.github` and `packages/desktop/scripts` is the observer's
(`computer-overlay-smoke-window-region.ts:306` at `15f3ba77`), and it runs while PowerShell 7's compiler and reference
assemblies are still cold on a fresh VM. The observer arms one 15 s timer at spawn; it fired after the `compile` marker
and before `input`, which is exactly `deadline_compile`.

Evidence (job log timestamps):

| Job                         | Step 15 properties to region line (cold) | Step 18 observer (new pwsh, same source) | Note                              |
| --------------------------- | ---------------------------------------- | ---------------------------------------- | --------------------------------- |
| 136479415862 (this failure) | 15.58 s, deadline_compile                | not reached                              | step 9 446.5 s, controller 5.48 s |
| 136368889023                | 14.60 s, ok 4/4/4/4                      | 1.41 s                                   | passed, at least 0.4 s left (1)   |
| 136322885617                | 10.91 s, ok 4/4/4/4                      | 1.15 s                                   | step 9 469.6 s                    |

(1) Step 9 561.8 s. The 14.60 s span also covers work done before the observer spawns (about 0.58 s in the failing job,
whose observer was capped at 15 s), so this observer finished in at most 14.60 s and had at least 0.4 s left, probably
about 0.9 s. Step 9 figures come from job log timestamps; the job API's whole-second step times agree (470 s, 562 s).

- Step 18 starts a new pwsh process and compiles the same embedded source again, and finishes the whole observer in
  1.15-1.41 s in the two tabled jobs. That shows only that the first observer span in a job takes 10.9-15.6 s and a
  later one 1.15-1.41 s. It is consistent with an earlier compile in another process warming the next one (file cache and
  assembly scans), but step 18 also runs after a second Electron launch and the native-stage build step, so these pairs
  do not separate cold Roslyn from cold Electron or Defender contention.
- The failing VM was not generally slow. Step 9 took 446.5 s, faster than both tabled passing jobs (469.6 s and
  561.8 s), and the controller phase took 5.48 s against the usual 5.2-5.8 s. Today's ~1.75x slow Windows runner group
  does not explain this job.
- The PowerShell 5.1 warm-up in run 42125718778 (`hands-progress.md`, "Windows region compiler control") was also a
  separate-process compile placed right before the first Electron proof, and it did not help. 5.1's Add-Type runs
  csc.exe out of process, but under the theory that one process warms the file cache for the next, csc.exe should have
  benefited the same way. So that result is consistent with the Electron first-launch alternative, unless 5.1 was slow
  even when warm, which no run shows. The new `elapsed` field and the warm-up `ms` are what will decide between the
  two.
- Still open: the stderr phase marks were consumed and never logged, so no run shows how the 15 s splits between pwsh
  launch and Add-Type. Launch is very likely small (every earlier step already runs under pwsh). Contention with the
  first Electron launch's file scans in step 15 is the other candidate, which step 18 would also not pay.

Change.

- `warmComputerSmokeRegionCompiler()` runs the same protected `<SystemRoot drive>\Program Files\PowerShell\7\pwsh.exe`
  with the same `-NoProfile -NonInteractive -EncodedCommand`, a separate fixed script
  (`Add-Type -TypeDefinition 'public static class VectorRegionWarm {}' -Language CSharp`, then stdout `ok`), empty
  stdin, and its own 60 s timer (`COMPUTER_SMOKE_REGION_WARM_TIMEOUT_MS`). It returns only `{ok, ms}` or a closed
  reason (unsupported_platform, launch, compile, output, deadline). It never produces a region result and grants
  nothing. Add-Type emits in memory, so nothing compiled there survives for the observer to load; the observer still
  compiles exactly its embedded source inside the unchanged 15 s.
- New windows-build step "Warm the protected PowerShell 7 compiler", right after "Install the exact pinned Electron
  runtime" and right before step 15, `timeout-minutes: 2`, no `continue-on-error`. It prints
  `computer-smoke-region-warm {"protocol":1,"ok":...,"ms":N}` and exits 0 on a warm-up failure or deadline, since the
  real observer still decides.
- The runner (now exported as `runComputerSmokeRegionBridge`) records, in Node, the whole milliseconds from spawn to the
  first arrival of each valid marker, capped at `timeoutMs` (the parsers need values within the limit), so a logged
  value of exactly 15000 means at or after the limit, not an arrival measured at 15000. The logged
  `computer-smoke-window-region` summary gains an optional `elapsed` object keyed by the phases reached (`compile`,
  `input`, `parent`, `region`, `output`): an ordered prefix with nondecreasing integers in 0..15000. `elapsed.compile` is the launch time and `elapsed.input -
elapsed.compile` the Add-Type time. The script stays byte-identical. Timing is diagnostic only: a malformed value is
  dropped by the observer and rejected by the summary parser, and it never enters the pass condition.
- Rejected: a separate 60 s compile budget with the 15 s starting at `input`. That lets the child run up to 75 s
  before a verdict and lets the proof's own compile take 60 s, which lengthens the proof's deadline. The chosen design
  also gives the first cold compile 60 s, but only in the warm-up step: there the cold cost, which has nothing to do
  with the proof, is paid in a separate step that grants nothing and cannot fail the job, while the observation
  deadline and the proof's own compile stay inside the unchanged 15 s observer limit.

Validation (Linux; no PowerShell or native code runs here):

- `computer-overlay-smoke-window-region.test.ts` (16 pass): timeoutMs is still 15_000 and the UTF-16LE SHA-256 of
  `REGION_SCRIPT` equals the `15f3ba77` value `0049ef8603fe93d3f5fa48184d3100adba2d582c362165e22ab49640328baac8`;
  the warm-up uses the identical command and flags, its decoded script is exactly the fixed source, it sends empty
  stdin, its limit is 60_000, and its failures stay closed; `ok` output and warm-up-shaped JSON can never satisfy
  `observeComputerSmokeWindowRegions`. The real runner is driven by local `process.execPath` children that write the
  fixed markers (no external host): elapsed values are monotonic and at most `timeoutMs`, deadline cases carry only
  the phases reached, and the deadline_launch, deadline_compile, deadline_input and invalid-order mappings are
  unchanged.
- `computer-overlay-smoke-window-region-report.test.ts` (5 pass) covers `elapsed` in the summary and rejects
  out-of-range, fractional, non-prefix, decreasing, unknown-key and non-object values.
- `computer-overlay-workflow.test.ts` (7 pass) pins the warm-up step's position, exact run line, `timeout-minutes: 2`,
  its missing `continue-on-error`, and that step 15's run lines and 3 minutes and step 18's 3 minutes are unchanged.
  `computer-workflow.test.ts` (37), `computer-overlay-smoke-source.test.ts` (19), `build-computer-overlay-smoke.test.ts`
  (7) and `computer-overlay-smoke-report.test.ts` (51) pass unchanged.
- Mutations, each red and then restored to its recorded sha256: the observer limit 15_000 to 60_000; dropping the
  marker timing line; the warm-up's stdin `""` to `"{}"`; the elapsed bound `limit` to `limit * 2`; the warm-up step's
  2 to 5 minutes; one character of `REGION_SCRIPT`.
- `packages/desktop` `bun typecheck` passes. actionlint is not installed in this container.

What Windows CI must show, on at least 3-5 computer-helper runs: the warm-up line `ok` with its `ms` (the 3-14 s cold
cost should now show up there); step 15 `computer-smoke-window-region` ok 4/4/4/4 with `elapsed.compile` (launch)
small, `elapsed.input - elapsed.compile` close to step 18's range (about 2 s or less), and the total well under 15 s;
step 18 unchanged. If the instrumented runs instead show launch as the large share, or compile still slow after a
successful warm-up, the cold-Roslyn cause is refuted; plan for the measured phase next (Electron first-launch
contention is the next candidate). Do not widen the deadline. Moving the readback into the built native test binary
changes what the proof is bound to and is the lead's decision. Two workflow_dispatch-only test.yml lanes still run a
fresh-VM overlay smoke without this warm-up and can still hit the same deadline_compile: the
`computer-helper-windows-overlay` fast lane (the same step 15 smoke) and the staged overlay diagnostic in
`computer-helper-windows-units` (`computer-overlay-smoke.ts --native-stage`). Neither is changed here; if either is
used for evidence, add the same fixed warm-up step there as its own reviewed change, with no `continue-on-error` and a
bounded timeout.

### 2026-11-21: warm-up evidence

Read through the GitHub MCP job logs: six computer-helper / windows-build jobs that ran the warm-up step (the four
named in the lane plan plus runs 44806289578 and 44829529636), each of whose log shows the `computer-smoke-region-warm`
line and both the step 16 and step 19 `computer-smoke-window-region` lines. This is a sample, not every run. In
these jobs the warm-up is step 15, "Run real Electron overlay properties and controller lifecycle" is step 16 (step 15
in the table above) and "Run actual isolated medium-token Windows overlay Stop" is step 19 (step 18 above). Launch is
`elapsed.compile`, Add-Type is `elapsed.input - elapsed.compile` and total is `elapsed.output`, all in ms. Every region
line is `ok` 4/4/4/4.

| Job (run, attempt)                | Head                             | Warm-up ms | Step 16 launch / Add-Type / total | Step 19 launch / Add-Type / total |
| --------------------------------- | -------------------------------- | ---------- | --------------------------------- | --------------------------------- |
| 136565585657 (44806289578, 2)     | `region-compile-budget` 5002a8ce | 12262      | 355 / 1935 / 2332                 | 334 / 855 / 1239                  |
| 136588816103 (44822880542, 1)     | `main` 3670461a                  | 3876       | 321 / 1313 / 1682                 | 366 / 912 / 1330                  |
| 136611151009 (44829529636, 1) (1) | `windows-test-budgets` 2da94b5f  | 2733       | 289 / 1056 / 1394                 | 331 / 806 / 1188                  |
| 136658215090 (44837525118, 2)     | `windows-test-budgets` 625153c7  | 3760       | 199 / 962 / 1197                  | 222 / 511 / 766                   |
| 136673869016 (44848275007, 1)     | `main` f3d7ac74                  | 3815       | 264 / 1279 / 1584                 | 270 / 683 / 993                   |
| 136714734266 (44860782743, 1) (1) | `everywhere-finish` 741aa2af     | 4301       | 313 / 1287 / 1666                 | 358 / 927 / 1339                  |

(1) The job failed later, in step 19, with the HF-7 (1) Stop signature (`uia-runtime-id` and `uia-root-element`
respectively, `lookup` first, `call` root, `actor` retired, `core_failure:no_ui_tree`). Its region lines are `ok`, so
that failure is not this one.

- The cold-Roslyn cause is supported. Launch is small in every proof span (199-366 ms), so the 15 s was never spent
  starting pwsh. The proof's own Add-Type in step 16 is now 0.96-1.94 s and its whole observer 1.2-2.3 s, close to the
  1.15-1.41 s that step 18 took before the warm-up and far from the 10.9-15.6 s first spans tabled above. The cold
  cost moved into the warm-up, which paid 2.7-12.3 s (3.76-4.30 s in the four jobs first read; 12.26 s on
  `region-compile-budget`, a cold VM where the proof still finished in 2.33 s).
- The Electron first-launch alternative is not supported. Step 16 still launches the job's first Electron before its
  observer spawns, and that observer's Add-Type is about 1-1.9 s. If contention with the first Electron launch were
  the cost, it would still be paid there. The 5.1 warm-up result above stays consistent with Windows PowerShell 5.1's
  out-of-process csc.exe simply not warming PowerShell 7's in-process Roslyn; no run measured that directly.
- Margin: the slowest proof span here is 2.33 s against the unchanged 15 s observer limit. No deadline, limit or
  script byte changed.
- Still open: these are all computer-helper.yml windows-build jobs. The two test.yml dispatch lanes named in the last
  paragraph above get the same warm-up step on branch `hands-stop-guardian` (`hands-progress.md`, 2026-11-21); their
  dispatch runs (`computer_helper_target=windows-overlay` and `windows-units`) need that branch pushed and are not
  recorded yet.

## 2026-11-20: Windows engine tests running close to their 30 s budget

Branch `windows-test-budgets` from `15f3ba77`. Four test files, one commit each. No product code, test deadline,
timeout or assertion changed. Windows engine shards run `bun test` with a 30 s default per test. About 14% of hosted
Windows VMs are slow on first touch (setup-node "Environment details" 17-35 s instead of 3.5-5.4 s), and those VMs
make tests that start many processes 2-4x slower, so a test at 60-100% of its budget on a normal VM fails there.
`review/impact.test.ts` and `everywhere/unattended-session.test.ts` also hit their budgets today, but the
`scope-finish` and `everywhere-finish` lanes are rewriting those files, so they are left to those lanes.

Local times are Linux, per test, from `bun test --timeout 30000 --reporter=junit`, one file at a time through the
Bun lock.

| Target                                                                                                                                                                           | Windows evidence                                                                                                                                                                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                         | Local before               | Local after                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| `cli/import.test.ts` "an owner-only conversation keeps its marker on local export and refuses the portable format"                                                               | 23.2-30.0 s over 5 runs. Timed out at 30.0 s on job 136531095350, a normal VM (Environment details 5.9 s). It started 6 cold CLI processes at about 4 s each.                                                           | A file-level `beforeAll` (30 s, the owner-only test's former budget for these two processes and four more) runs `vector serve`, POST /session and `vector export` once inside `withCliFixture`, checks the export's exit code and stops the server before any test runs. The source home and its DB stay until `afterAll`. The owner-only test imports into that DB; the round trip imports into a fresh home. | 14.6 s (round trip 13.3 s) | 10.6 s (round trip 8.5 s), plus about 5.5 s for the hook |
| `tool/task-manage.test.ts` "an agent merges and discards only its direct children: an ancestor or a caller naming another session is refused and nothing is asked"               | 13.0-20.4 s. The 20.4 s (68%) came from job 136513156060, a normal VM. It was the only test of the three that built two isolated children (about 55-60 git processes each).                                             | The six refused merges and discards all name one settled, changed child. The `dropped` child and its state check are gone.                                                                                                                                                                                                                                                                                     | 4.2-4.6 s                  | 2.4-2.5 s                                                |
| `server/task-isolation.test.ts` "a guest whose session claim or workspace directory covers a fenced family gets only the counts; outside it, 403"                                | 17.3-20.6 s (58-69%) on every run with no VM in the 17-35 s slow band. The 20.6 s came from job 136445766690, whose Environment details took 11.4 s. It spawned 200 git processes, all product isolation and diff work. | Split into one test per family: session claim (with the outside-scope 403) and workspace directory. Both use the same `guestStack`, `base` and `isolate`, and the guest's workspace is served during both, as before. The per-family guest checks move into `guestSeesCounts`. The file's total time does not drop, because there is one more instance boot.                                                   | 9.2-9.4 s                  | claim 5.6-6.5 s, workspace 4.4-5.4 s                     |
| `session/task-size.test.ts` "an approval or build it after a Thorough plan from Plan mode carries it out at its size, and the judge checks it" (already on the known-flake list) | 13.8-19.0 s on normal VMs (19.0 s = 63% on job 136513155982) and 25.3 s on slow VM 136445766835. Undo snapshots accounted for 218 of its 259 git processes.                                                             | `providerConfig` sets `snapshot: false` next to `formatter: false, lsp: false`. `setup` already approves the project's trust, so the setting is honoured. `{ git: true }` stays.                                                                                                                                                                                                                               | 10.4 s (file 249.9 s)      | 7.0 s (file 198.7 s)                                     |

Why these keep their meaning.

- import: the archive is still a real local export, made by a real CLI process, of a session a real `vector serve`
  created. The test still adds the owner-only marker itself and reads it back through a real `vector import`. Every
  assertion stays. The only export exit-code check is now the hook's, and if it fails, every test in the file fails,
  including the two that do not use the archive. The import itself reads the source session: `SessionArchive.import`
  forks a source its DB knows (`audience.knows`), which runs the lease check and records a fork lineage edge that
  puts the source in the owner-only fence's family. So the owner-only test imports into the source's own DB, which the
  hook keeps until `afterAll`, as it did when it served, exported and imported in one home; a local probe showed the
  fork edge to the source. The round trip imports into a fresh home, as before, and still asserts
  `importedID !== source.id`.
- task-manage: the refusal comes from the caller checks in TaskManager and TaskIsolation's `by`, not from which task is
  named. TaskManager checks the caller before any state, so a merge stays forbidden whatever the task's state. If a
  refused discard went through, its own `Effect.flip` and `forbidden` check would fail, and the final "changed" check
  would fail too. `asked` stays empty and merged.txt stays at base.
- task-isolation: every expect is unchanged and sits under the family it was about (64 expect calls before and after).
- task-size: no test in the file reads a snapshot or a patch part. As a probe, `changedFiles` was made to ignore patch
  parts while snapshots were still on, and all 68 tests still passed. With snapshots off, all 68 pass and the judge
  learns of tui.rs from the write input alone. That makes the test stricter: if write/edit inputs are ignored it now
  fails on the first answer ("build it"), where the snapshot patch had covered that case before.

Mutations (each red, then restored and checked against its recorded sha256):

- import: the `--public` refusal in `export.ts` disabled (the `portable` exit code is 0); the owner-only
  `fenceIsolation` in `core/src/share/archive.ts` import disabled (privacy is undefined).
- task-manage: TaskManager's discard caller check disabled (the `[root, lead]` discard goes through); TaskManager's and
  TaskIsolation's merge caller checks disabled (a refused merge goes through).
- task-isolation: `guestSessionIDs` dropped in `server/auth.ts` (only the claim test fails, 403 instead of 200);
  `guestWorkspaceDirectories` dropped (only the workspace test fails).
- task-size: write/edit inputs ignored in `changedFiles` (judge count 0); approvals never inherit Thorough in
  `core/src/task-size.ts` (reasoning_effort undefined).

`packages/engine` `bun typecheck` passes. Expected effect on a normal Windows VM: import owner-only 15-18 s instead of
23-30 s; the refusal test in the 11-17 s range of its one-child sibling; each guest test near 8.7-12 s (30-40%); the
Plan mode approval test about 6-9 s. This branch has not run on Windows CI yet. A real cut to the guest tests needs a
product change: rev-parse lookups are repeated many times in each isolation.

Follow-up on this branch's first CI run (test.yml run 44829529636): `unit (windows)` job 136610691971 failed in
`packages/core/test/config/plugin.test.ts` "ConfigExternalPlugin > imports the approved plugin bytes from a private
snapshot after the live file changes" with `Expected: "approved"`, `Received: ""` after 187 ms. That is a race in the
test, not a slow VM: it polled for the marker file to exist and then read it, but the plugin's `Bun.write` creates the
file before it writes the bytes, and on Windows the reader saw the empty file in between. The test now polls for the
marker's content (same 100 × 10 ms bound) and asserts it. Locally 9/9 pass; pointing `executablePath` at the live file
instead of the approved snapshot still fails it with `Received: "changed"`. The same run's other two failures were
infrastructure: Bun 1.3.14 segfaulted in `bun install` before any test ran (`engine (windows, shard 5/12)`, job
136610692430, re-run class d), and HF-7 at stage `uia-runtime-id` in the Windows overlay Stop (job 136611151009).

## 2026-11-21: re-run classes, Windows runner facts and open items

Final docs sweep. Each point below was checked against git history or the GitHub API in this sweep, except where it
says otherwise.

Re-run classes. The lead re-runs a failed job once, and only when nothing else in the run failed, in these classes:

- (a) The HF-7 Windows overlay Stop failure (`hands-deviations.md`, HF-7 point 15): stage `uia-root-element` or
  `uia-runtime-id` with lookup `first`, call `root`, actor `retired` and cause `core_failure:no_ui_tree`. Example:
  windows-build job 136368889023.
- (d) A job whose log shows "oh no: Bun has crashed" (a Bun 1.3.14 panic or segmentation fault) and no failing test.
  Example: `engine (windows, shard 5/12)` job 136610692430, where Bun crashed in `bun install` before any test ran. An
  upstream Bun report was not filed: filing one is a public action left to the owner. The exception is the
  scrollback.surface / `runtime.test.ts` panic covered by the #49 entry above, which needs a root cause, not a re-run.

This file does not describe classes (b) and (c).

Hosted Windows runner size, now measured. The processor-count line from #52 prints "logical processors: 4" (PR #52
test.yml run 44778999824, windows-build job 136437129162). The 4-vCPU count in the #52 entry above is no longer only
inferred.

Open item: #52 did not meet its own target. Its entry asks for step 9 at or below about 420 s in every windows-build
job. In the later jobs checked here, step 9 took 537 s (job 136437129162, PR #52), 446.5 s (job 136479415862, main
`c776fb60`, from its log), 542 s (job 136638058823, PR #54) and 414 s (job 136673869016, main `f3d7ac74`), from the job API's step
times. Three of the four are above 420 s. How much room each
`cmake --build` has under that cap is still not measured, because passing logs print no per-command times.

Windows slow-first-touch triage. About 1 in 7 hosted Windows VMs is slow the first time it touches files and programs:
setup-node's "Environment details" takes 17-35 s instead of 3.5-5.4 s (the #54 entry above). Defender is not the cause
to work around: on windows-2025 images it is already off (runner-images `Configure-WindowsDefender.ps1`, and the
maintainers' live check in runner-images issue #14326), so Defender exclusions would do nothing. That reading comes
from the lead's research on 20 Nov 2026; this sweep could not reach the runner-images repository to recheck it. When a
Windows timing failure appears:

- check that job's setup-node "Environment details" time to tell a slow VM from a test bug;
- harden a test that is sensitive to first use (a warm-up, or first use outside the timed window, as #53 does);
- never lengthen a deadline.

Intermittent: the two Windows timeouts on main `dc89e4ec` (test.yml run 44006980544). `engine (windows, shard 11/12)`
job 133785924937 timed out in `test/session/prompt.test.ts` ("running task tool preserves metadata after tool-call
transition"), and `engine (windows, shard 12/12)` job 133785925116 timed out in `test/cli/github.bundle.test.ts`
("patch-limit refusal: files, counted in the listing"). Neither recurred on the next main run, `4bb9bcb2` (run
44007029816, success). The `github.bundle.test.ts` timeout did come back later on PR #46 (job 136057825295), and #48
changed that test (the "Windows patch-limit listing row" entry above). The `prompt.test.ts` timeout is recorded as
intermittent, with no change.

## 2026-11-21: SQLite open failed with SQLITE_BUSY_RECOVERY while another process recovered the WAL

Branch `wal-busy-timeout` from `5a5b5619`. A product fix in the shared SQLite adapters. No test, fixture, deadline or
timeout was loosened or lengthened.

Evidence. PR #58 test.yml run 44871325403, attempt 1, `unit (windows)` job 136751082469:
`packages/core/test/review/request-store.test.ts` "two processes on the same SQLite file grant only one immutable
pending reservation" failed after 906.73 ms. One of its two probe processes exited 1 with `SQLiteError: database is
locked` (errno 261, `SQLITE_BUSY_RECOVERY`) at `packages/core/src/database/sqlite.bun.ts:190:46`, which is the
`PRAGMA journal_mode = WAL` run straight after `new Database(...)`. #58 does not touch these files, and earlier
`unit (windows)` jobs passed the case (job 136722206106, 621.61 ms).

Cause. Bun opens a database with no busy timeout, and the adapter's first statement was the WAL switch. The database
layers (`database/database.ts`, `brain/database.ts`) set `busy_timeout = 5000` only after it. When the last
connection to a file closes, SQLite removes its -wal and -shm files, so the next process to open it runs WAL
recovery, which holds the WAL write, checkpoint and recover locks. A second process that opens the file meanwhile
gets `SQLITE_BUSY_RECOVERY`. SQLite retries that through the busy handler, but with a timeout of 0 there is none, so
the open failed at once. The test starts both probes together on a file the seed connection has just closed, which
is the case of the desktop engine and a CLI run opening vector.db or brain.db together. The Node adapter had the same
gap: `DatabaseSync` got `timeout: config.timeout`, which no caller sets.

Fix. `sqlite.bun.ts` runs `PRAGMA busy_timeout = 5000` before the WAL switch, and `sqlite.node.ts` defaults
`timeout` to 5000, which `DatabaseSync` applies at open. 5000 ms is what the database layers already set right
after, so the wait starts earlier and is not made longer. `packages/effect-sqlite-node/src/index.ts` has the same
order, but nothing in `src` imports it and its callers pass `timeout`, so it is left as it is.

Regression test. `packages/core/test/database-open.test.ts` (Linux only) seeds a WAL database through
`Database.layerFromPath` and closes it. `test/fixture/wal-recovery-holder.py` then keeps the -shm in the state a
recovering process leaves it in (DMS byte shared, a zeroed 32 KiB wal-index region, bytes 120-122 exclusive) for
1 s, well under the 5 s timeout, and the test opens the file again. It also checks that the open finished after the
holder let go, so a holder that stopped blocking fails the test instead of passing it. Before the fix it failed
3 of 3 runs in about 100 ms with `SQLITE_BUSY_RECOVERY` at `sqlite.bun.ts:190:46`, the CI frame. After it, the file
passes in about 1.4 s.

Mutations, each red and then restored: the new `busy_timeout` line removed (`SQLITE_BUSY_RECOVERY`); the line moved
after the WAL switch (`SQLITE_BUSY_RECOVERY`); the holder without its exclusive locks (the open finished about 1 s
before the holder released, so the ordering check failed). The Node adapter, bundled with `bun build --target=node`
and run under Node 22.23.4 against the same holder, opened after 938 ms with `busy_timeout` 5000; with
`timeout: config.timeout` put back it failed in 4 ms with "database is locked".

Validation, one file at a time through the Bun lock: `request-store.test.ts` 20 of 20 runs passed (5 tests each,
1.24-1.69 s); `database-open.test.ts` 8 of 8; `sqlite-bun.test.ts`, `database-migration.test.ts`,
`brain/database.test.ts`, `background-job-store.test.ts` and `engine/test/storage/storage.test.ts` passed (the last
does not open SQLite; there is no `core/test/database/` folder). `packages/core` `bun typecheck` passes. The
change has not run on Windows CI yet.

## 2026-11-21: EV-18 worktree test cleanup hit EBUSY on the job's checkout on Windows

Branch `worktree-test-cleanup` from `4fc245b6`. The first commit (`4d72d6a4`) is test-only; the second path below
adds a test-side cleanup retry and one product change in `src/project/vcs.ts`. No assertion, deadline or timeout was
skipped, loosened or lengthened.

Evidence. PR #58 test.yml run 44889738895, attempt 1, `engine (windows, shard 9/12)` job 136807229583:
`packages/engine/test/everywhere/worktree.test.ts` "POST /experimental/worktree/unattended (EV-13) > the job's
checkout is never trusted, so its own config, or one written into it, loads no formatter or server" failed with
`EBUSY: resource busy or locked, rm '...\share\vector\everywhere-worktree\5742053554...'` at `worktree.test.ts:737:49`,
the `afterEach` cleanup `rm(item, { recursive: true, force: true })` that runs right after `store.disposeAll()`.
The shard otherwise passed (748 pass, 23 skip, 1 fail). The test came with #56 and passed on main's `153f9a22` run
in 2666 ms; here it took 1935 ms. #58 does not touch it.

Cause. This is the only test in the file that loads an engine instance in the job's checkout, and it loads it twice
(before and after `/instance/dispose`). Every load runs `Vcs.init()`, which forks the Vcs state lookup into the Vcs
layer's app-wide scope (`src/project/vcs.ts`), and bootstrap does not wait for it. The lookup runs
`git symbolic-ref`, `git remote`, `git for-each-ref refs/heads` and `git config init.defaultBranch` with the
checkout as their working folder. `InstanceState`'s disposer only calls `ScopedCache.invalidate`, which closes the
entry's scope but does not interrupt a lookup still running in the caller's fiber, so neither `/instance/dispose`
nor `store.disposeAll()` waits for those processes. On Windows a running process holds its working folder open, so
the cleanup `rm`, which has no retry, failed with EBUSY when it ran before git had exited. `Worktree.remove` already
tolerates the same leftover handle with its 50 x 100 ms win32 `rm` retry in `cleanDirectory`. File watchers,
formatters and language servers are not the cause: the checkout watcher is behind `VECTOR_EXPERIMENTAL_FILEWATCHER`
(off), the git-folder watcher targets the source repository's `.git`, and the untrusted checkout starts no
formatter or server.

Change. The test now calls `GET /vcs` in the checkout (through its existing `read` helper, which also expects
status 200) right before `/instance/dispose` and again after its last `state()` check. `GET /vcs` awaits
`vcs.branch()` and `vcs.defaultBranch()`, which join the in-flight lookup, so both loads' git processes have exited
before the instance is disposed and before `afterEach` removes the checkout. The cleanup loop is unchanged.

At `4d72d6a4` this was left as a product follow-up: `Vcs.init` forking its lookup outside the instance's scope means
disposal neither waits for nor stops git in the instance's folder. It is fixed by the second path's product change
below.

Validation, one file at a time through the Bun lock: `worktree.test.ts` 5 of 5 runs passed on Linux (20 tests each,
17.3-24.3 s); `packages/engine` `bun typecheck` passes. Linux does not reproduce the EBUSY (it removes a process's
working folder), so the local runs show only that the added waits succeed. CI must show the `engine (windows)` shard
that runs `worktree.test.ts` passing this test, with no EBUSY from the `afterEach` cleanup, across repeated runs.

### Second path: the createUnattended fixture finalizer

Evidence. With `4d72d6a4` in place, Windows failed a different test in the same file on three PRs: #61 job
136821212417, #62 job 136827690549 and #63 job 136829137042 (at `4d72d6a4`). Each failed
"Worktree.createUnattended > refuses malformed ids, branches that are not the job's, and a directory other than the
loaded checkout" with `EBUSY: resource busy or locked, rm '...\share\vector\everywhere-worktree\<project id>'` at
`worktree.test.ts:115:13`, the `fixture()` finalizer's `rm(root, { recursive: true, force: true })`. The other
createUnattended cases passed.

Cause. The holder is the test's own instance load, not `createUnattended`. Near its end the case runs
`refusal(seeded).pipe(provideInstance(made.directory))`, which loads an instance in the job's checkout under `root`.
Layer memoization gives that load the test layer's store, which runs the real `InstanceBootstrap`, so `Vcs.init` forks
the same background git lookup (`symbolic-ref --quiet HEAD`, `remote`, `for-each-ref refs/heads`,
`config init.defaultBranch`) with the checkout as its working folder. The refusal needs no git, the case ends within
milliseconds, and the finalizer runs before the shared store disposes the instance (and disposal would not have
waited for the forked lookup anyway). `createUnattended` itself awaits every git call, forks nothing and loads no
instance.

Change.

- Product (`src/project/vcs.ts`): `Vcs.init` now awaits `InstanceState.get(state)` instead of forking it into the
  layer's app-wide scope, as `Snapshot.init`, `Format.init`, `LSP.init` and `Project.init` already do. The lookup now
  runs in the bootstrap fiber, which `InstanceStore` joins and interrupts, so its git has exited before a load
  returns. `InstanceBootstrap.run` already runs every init concurrently, so the boot waits only for the slowest init.
  New test `test/project/vcs.test.ts` "Vcs init > init() returns only after the branch lookup's git has exited"
  counts git processes at the `AppProcess` boundary for the instance's folder; it failed before the change (no git
  had started when `init()` returned) and passes after it. The EV-18 comment now describes the new behaviour; its two
  `GET /vcs` reads stay.
- Test (`test/everywhere/worktree.test.ts`): one helper, `removeFolder`, retries `rm` 50 times 100 ms apart on win32
  for EBUSY or EPERM only, as `Worktree.remove`'s `cleanDirectory` does; on Linux and macOS, and for any other error,
  the first failure stands. It replaces the `fixture()` finalizer's two folder removals and the EV-13 `afterEach`
  cleanup loop. It is still needed with the product change: the seeded instance is still loaded when the finalizer
  runs. The shared `tmpdir` disposals (errors already swallowed), the mid-test junction removal, the managed policy
  folder and the file removals are unchanged.

Validation, one file at a time through the Bun lock, on Linux: `worktree.test.ts` 5 of 5 runs passed (20 tests each,
16.9-19.8 s); `test/project/vcs.test.ts` 26 of 26 (the new test failed before the product change, 25 of 26);
`instance-bootstrap.test.ts`, `instance.test.ts`, `instance-store-exclusive.test.ts`, `test/project/worktree.test.ts`,
`worktree-remove.test.ts`, `test/worktree/create-for-task.test.ts` and `test/server/httpapi-workspace.test.ts` passed;
`packages/engine` `bun typecheck` passes. Linux does not reproduce the EBUSY, so CI must show the `engine (windows)`
shard that runs `worktree.test.ts` passing both the EV-13/EV-18 test and the createUnattended refusal case, across
repeated runs.
