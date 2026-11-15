# Native qualification lane notes

## Purpose, branch and base

This lane qualifies the native Linux isolation seam on hosted CI and closes the
process-ownership follow-ups that depend on it. It works on the `native-qualify`
branch, which starts from `release-finish` at `0ee486e3` (PR #33, the combined v2
integration). When #33 merges into `main`, the lead merges `main` into this branch;
until then this lane never merges `main` itself. Everything reaches `main` only
through a reviewed PR with a merge commit.

## No production activation is authorized

Nothing in this lane activates native isolation in a shipped build.
`LinuxIsolationBuild.enabled` stays `false`, `LinuxIsolationBuild.entrySHA` stays
`undefined` and `ProcessIsolation.FLOOR` stays `false`. No runtime, environment or
configuration switch is added. Native commands registered with `OwnedProcess` stay
refused before launch (spawn review §4.4); the delegate-versus-refuse end state is
the native lane's or the owner's decision. Root installation of the native adapter or
the `vector-sandbox-v1` AppArmor profile outside hosted CI, runner image changes,
paid runners and any full-matrix spend beyond the bounded dispatches below are
owner-gated.

`.github/workflows/vector-at-mention.yml` holds no native experiment: a
case-insensitive search for `native` in it is empty, and `git log -S native` for that
file is empty. It stays untouched, and this lane never dispatches it.

## How CI works in this lane

- After each push the lane runner dispatches `native-guard-unit.yml` and
  `typecheck.yml` automatically. `native-guard-unit.yml` runs the pure Python fixture
  `packages/core/test/fixture/native-mask-origins.py` on `ubuntu-24.04`, the same
  image and the same fixture as the native workflow's pure-policy step.
- `native-shell.yml` is not a lane CI workflow. With `{"diagnostic_cell": false}` it
  runs the full eight-cell matrix (about 18 minutes per cell) and is expected red until
  qualification. A package whose brief says "native dispatch" dispatches it exactly
  once, in its commit step, after the push succeeds.
- A native dispatch waits for `native-guard-unit.yml` to pass at the pushed SHA (read
  its job log first). If guard-unit is red, the package does not dispatch: it fixes
  the fixture or source in a new commit and records the skipped dispatch here. This
  avoids spending the single dispatch on a pure-policy failure, as happened in run
  `43619796230`. From NQ-3 on, the automatic `typecheck.yml` run at the pushed SHA must
  pass too, because a red lane workflow stops the lane at the next CI check (D39); both
  run IDs go in the dispatch log's gate column.
- Run identification: the dispatch API returns no run ID. After the dispatch, poll
  `list_workflow_runs` for `native-shell.yml` on `native-qualify` and accept only a run
  with event `workflow_dispatch`, `head_sha` equal to the pushed SHA and `created_at`
  after the dispatch time. Then read `list_workflow_jobs` for
  `Shell seam (bun, own-key, baseline)`. Record the run ID, job ID and head SHA read
  from the API; never infer them.
- Every native package's plan starts by reading the newest completed
  `native-shell.yml` run on `native-qualify` (runs, then jobs, then the job log tail).
  No CI result is guessed.

## Failure history before this lane

All four runs are the single diagnostic cell `Shell seam (bun, own-key, baseline)` on
`ubuntu-24.04`. None is a successful isolation or cleanup witness.

| Run | Job | Head | Closed result | Step results |
| --- | --- | --- | --- | --- |
| [43566766483](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43566766483) | `132362207081` | `faa1fa09` (`build-native-shell`) | `prepare-keeper-child-exit-log-no-marker-info-child-created`, exit 1 | Pure policy, compile, install and both metadata preflights passed; prepare failed; cleanup proof refused. |
| [43619796230](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43619796230) | `132522658130` | `065287ba` (`native-finish`) | Pure-policy step failed: 29 cases passed, one still expected the old 114-element product instead of 162 | Control policy passed; everything after the pure-policy step was skipped. No native prepare ran. |
| [43620478356](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43620478356) | `132524834451` | `c12c144e` (`native-finish`) | `prepare-keeper-child-exit-log-bwrap-destination-info-child-created`, exit 1 | 30 pure-policy cases, compile, install and both Node/Bun metadata preflights passed; prepare failed; cleanup proof refused. |
| [43621985900](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43621985900) | `132529480650` | `f141ef16` (`native-finish`) | `prepare-keeper-child-exit-log-bwrap-destination-host-temp-info-child-created` (entry `CalledProcessError` exit 1; control `native-prepare` exit 125) | 3 control-policy tests, 31 pure Python tests, compile, install, workspace and both Node/Bun metadata preflights passed; prepare failed; finish refused with `cleanup-proof`; the preserve-failures step failed. Runner image `ubuntu-24.04` 20261111.370.1, bubblewrap `0.9.0-1ubuntu0.3`. |

## Root-cause hypothesis (unconfirmed)

This is a hypothesis from reading the source. NQ-1 only sharpens the diagnostic; NQ-3
must confirm the geometry on CI before any mask design changes.

- `entry.py` starts the keeper as `aa-exec vector-sandbox-v1`, then `prlimit`, then
  `setpriv --reuid/--regid=vector-agent --clear-groups --no-new-privs`, then
  `bwrap --unshare-user --uid 0 --ro-bind / /` with `--tmpfs T --remount-ro T` for each
  mask in `MASKS` (`/home/vector-agent`, `/tmp`, `/var/tmp`, `/run`,
  `/home/runner/work/_temp`).
- Inside its user namespace only the `vector-agent` uid and gid are mapped. Runner-owned
  inodes are unmapped, so the keeper's namespace capabilities give no DAC override over
  them and only their "other" permission bits apply.
- For `--tmpfs`, bubblewrap v0.9.0 first runs `mkdir_with_parents(dest)` and dies with
  `bwrap: Can't mkdir parents for <dest>: <strerror>` on failure (bubblewrap.c:1194-1214),
  before the per-operation `ensure_dir` (`Can't mkdir <dest>`, bubblewrap.c:1366). Both
  map to the same closed label. If `/home/runner` is `0750 runner:runner` (HOME_MODE),
  the stat of `/home/runner` succeeds but the walk into `/home/runner/work` fails with
  `EACCES`, so the likely line is
  `bwrap: Can't mkdir parents for /home/runner/work/_temp: Permission denied`.
- `supported_mask_sources` checks each parent only for an owner in (0, runner) and no
  group/other write. It never checks that the keeper can search a mask's ancestors, so
  admission accepts a geometry the keeper cannot build.
- The intended fix is an ancestor mask on `/home/runner` plus an admission check, never
  a `chmod`. A mask on `/home/runner` also hides every runtime under it (for example
  setup-bun's `~/.bun`); the native `run()` calls `assertUnmaskedRuntime`, which would
  then refuse such a runtime. That is stricter, not looser. The CI fixture copies its
  runtimes to `/usr/libexec/vector-native-shell-control/runtime`.

## C9 re-analysis at `0ee486e3`

This corrects spawn review C9 and the PR #33 finding SPAWN-2.

- The empty read-only `/proc` comes from the bubblewrap engine launch:
  `ProcessIsolation.engineArguments` mounts `--tmpfs /proc --remount-ro /proc`
  (`packages/core/src/process-isolation.ts`, around line 227). `engineLaunch` in
  `github.sandbox.ts` returns the plain sudo argv unless its `floor` argument is true.
- Correction to the lane notes: the hosted caller passes `native || ProcessIsolation.FLOOR`
  (`github.sandbox.ts:798`), so a native CI build also gets the empty `/proc`, not only
  the FLOOR. A legacy hosted `@vector` engine (FLOOR false, native false) runs with the
  host `/proc`; the sandbox probe itself reads `/proc`, and `/bin/ps` in `groupEmpty`
  works there.
- In native builds an owned command is refused before launch
  (`cross-spawn-spawner.ts:405-411`), so no native `OwnedProcess` group and no
  `groupEmpty` call exists.
- So C9 is not reachable in any shipped or CI build today. It reappears only if FLOOR is
  enabled (owner-gated) or native plus owned is ever delegated rather than refused. No
  `owned-process.ts` change is made. The missing proof (SPAWN-1, POSIX half) is a Linux
  `test.yml` child fixture in NQ-2.

## Package table

Rows are copied from the lane's package list. "Planned" means not started.

| Package | Title | Native dispatch | Status |
| --- | --- | --- | --- |
| NQ-1 | Allow native Shell dispatch from the lane and classify keeper destination errors by a fixed errno enum | Once, `{"diagnostic_cell": true}`, in the commit step after the push, gated on guard-unit | Committed (see below); the guard-unit result and the native dispatch run/job IDs and head are recorded in the dispatch log |
| NQ-2 | Prove owned background cleanup under required isolation on Linux, and correct C9 | None (typecheck; test.yml at the lane end) | Committed (see below); passes locally; the Linux engine shard of `test.yml` runs it at the lane end |
| NQ-3 | Refuse at admission any mask whose ancestors the keeper cannot search | Once, `{"diagnostic_cell": true}` | Committed (see below; D45); the guard-unit and typecheck gate results and the native dispatch run/job IDs and head are recorded in the dispatch log |
| NQ-4 | Inventory direct process spawn sites and their isolation stance | None (typecheck; test.yml at the lane end) | Committed (see below; D56); passes locally; the engine shards of `test.yml` run it at the lane end |
| NQ-5 | Mask the runner home instead of its unreachable temporary leaf | Once, `{"diagnostic_cell": true}` | Committed (see below; D57-D74); the guard-unit and typecheck gate results and the native dispatch run/job IDs and head are recorded in the dispatch log by a later package (D45) |
| NQ-6 | Native baseline cell follow-up A | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-7 | Native baseline follow-up B and the full matrix | Exactly one: the diagnostic cell, or `{"diagnostic_cell": false}` (eight cells) only if the diagnostic cell is green with the `owned` refusal case. Any full-matrix spend beyond that one bounded dispatch is owner-gated. | Planned |
| NQ-8 | Close the lane's native qualification and spawn-review records | None (typecheck) | Planned |

## Dispatch log

| Package | Run | Job | Head | Inputs | Closed label | Step results |
| --- | --- | --- | --- | --- | --- | --- |
| NQ-1 | [43660129312](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660129312) (`workflow_dispatch`, attempt 1, failure) | `132647364562` `Shell seam (bun, own-key, baseline)`, `ubuntu-24.04` | `597dbcc922b44a0e53e0c311cbe416b26cdf6252` | `{"diagnostic_cell": true}` (the run has this single job) | `prepare-keeper-child-exit-log-bwrap-destination-host-temp-eacces-info-child-created` (entry `CalledProcessError` exit 1; control `native-prepare` `CalledProcessError` exit 125; transport `close` `ChildExit` exit 1) | Gate: guard-unit [43660083062](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660083062) passed at the same head (typecheck [43660085781](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660085781) passed too). Steps 1-12 passed: control policy (3 pass, 0 fail, 33 `expect()` calls), pure Python (`Ran 35 tests` ... `OK`), compile, install, workspace and both Node/Bun metadata preflights (`readerSHA256` `c8283da6fea8a33adb803d7004f0b3508535a27ebbf96912e4af90c2f3dcdba8`, `sourceRevision` the head above). Step 13 "Actual native prepare without SUDO mode or diagnostic profile" failed (exit 125). Steps 14-16 (seed, verify, lifecycle witness) were skipped. Step 17 "Always finish the exact owned native operation; missing state is refused" printed `cleanup-proof` (entry `RuntimeError`; control `native-cleanup` exit 125) and reports conclusion `success` in the API. Step 18 "Preserve every earlier failure and cleanup uncertainty" ran `manage.mjs assert 'success' 'failure' 'skipped' 'failure'`, printed "Native Shell CI management refused" and failed (exit 125). Step 19 "Retain bounded public receipts" uploaded the receipts (artifact `14139517979`). |
| NQ-2 | None: not a native package | | | | | Only the runner's automatic `native-guard-unit.yml` and `typecheck.yml` dispatches follow the push. |
| NQ-3 | [43675930370](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43675930370) (`workflow_dispatch`, attempt 1, failure) | `132695971881` `Shell seam (bun, own-key, baseline)`, `ubuntu-24.04` | `f05f991616584eb0542f9ac1fead49e730ba1027` | `{"diagnostic_cell": true}` (the run has this single job) | `prepare-mask-host-temp-keeper-search` (entry `RuntimeError`, errno and exit null; control `native-prepare` `CalledProcessError` exit 125; transport `close` `ChildExit` exit 1) | Gate: guard-unit [43675734735](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43675734735) (job `132695351609`, `Ran 40 tests in 0.132s` ... `OK`) and typecheck [43675737341](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43675737341) both passed at the same head. Steps 1-12 passed: control policy (3 pass, 0 fail, 33 `expect()` calls), pure Python (`Ran 40 tests in 0.197s` ... `OK`), compile, install, workspace and both Node/Bun metadata preflights (`readerSHA256` `c8283da6fea8a33adb803d7004f0b3508535a27ebbf96912e4af90c2f3dcdba8`, `sourceRevision` the head above). Step 13 "Actual native prepare without SUDO mode or diagnostic profile" failed (exit 125). Steps 14-16 (seed, verify, lifecycle witness) were skipped. Step 17 "Always finish the exact owned native operation; missing state is refused" printed transport `close` `ChildExit` exit 1 and control `native-state` `FileNotFoundError` `ENOENT` (no entry record), exit 125, and reports conclusion `success` in the API. Step 18 "Preserve every earlier failure and cleanup uncertainty" ran `manage.mjs assert 'success' 'failure' 'skipped' 'failure'`, printed "Native Shell CI management refused" and failed (exit 125). Step 19 "Retain bounded public receipts" uploaded the receipts (artifact `14146243257`). |
| NQ-4 | None: not a native package | | `b861736d4c130dde51506500c951e40da9b452e1` | | | Only the runner's automatic dispatches followed the push: guard-unit [43680012678](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43680012678) and typecheck [43680015135](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43680015135), both `workflow_dispatch`, attempt 1, completed, success, at the head above (D70). |
| NQ-5 | Pending: dispatched by the NQ-5 commit step after the push and the guard-unit gate | | | `{"diagnostic_cell": true}` | | Filled from the API by a follow-up docs commit if the commit step allows, else by NQ-6. |

Before NQ-1, `list_workflow_runs` for `native-shell.yml` on `native-qualify` returned
`total_count` 0, and `origin/native-qualify` did not exist.

NQ-2 filled the NQ-1 row from `list_workflow_runs`, `list_workflow_jobs`,
`get_workflow_run` and the job log tail, read on 15 November 2026 (D21); at that read,
43660129312 was still the only `native-shell.yml` run on `native-qualify`. NQ-3
interprets this row and does not record it again.

NQ-4 filled the NQ-3 row from `list_workflow_runs` (`total_count` 2 for `native-shell.yml`
on `native-qualify`; 43675930370 is the newer), `list_workflow_jobs` for that run and for
guard-unit run 43675734735, `get_workflow_run` for both gate runs, and the two job log
tails, read on 15 November 2026 (D52). The row records those API and log facts only. As
a plain string comparison, the entry stage equals the one the NQ-3 section lists first
in its interpretation table; reading what it says about the blocking ancestor is
NQ-5's, and NQ-4 does not interpret it.

NQ-5 filled the NQ-4 row from `get_workflow_run` for both gate runs and re-read
`list_workflow_runs` for `native-shell.yml` on `native-qualify` (`total_count` 2, newest
43675930370, completed, no run in progress), on 15 November 2026. NQ-5 interprets the
NQ-1 and NQ-3 rows (D58) and does not record them again.

## NQ-1, 15 November 2026

### What landed

- `.github/workflows/native-shell.yml`: the job `if` allowlist gains
  `refs/heads/native-qualify`. The clause still requires `workflow_dispatch` for that
  ref. Push triggers, paths, the `diagnostic_cell` input and its default, the matrix,
  pinned actions, permissions (`contents: read`) and steps are unchanged.
- `entry.py` `keeper_destination_stage`: after an exact fixed target matches
  `bwrap: Can't mkdir <target>: ` or `bwrap: Can't mkdir parents for <target>: `, the
  complete remainder of that line maps to one closed suffix:
  `Permission denied` to `eacces`, `Read-only file system` to `erofs`,
  `No such file or directory` to `enoent`, `Not a directory` to `enotdir`,
  `Too many levels of symbolic links` to `eloop`, `Operation not permitted` to `eperm`.
  Any other remainder keeps the existing unsuffixed target label, and an unknown target
  keeps `bwrap-destination`. No prose, errno text or path leaves the private log.
  The 14 fixed target paths and the cause table are now explicit literals.
- `keeper_failure_stage` accepts the 60 suffixed labels, written out literally. The
  accepted `log` set grows from 37 to 97 values; the closed product grows from 222 to
  582 stages (97 logs x 2 outcomes x 3 infos). A suffix on the generic
  `bwrap-destination` is not accepted.
- `github.isolation.ts` `FAILURE_STAGES.entry`: each fixed target now expands to itself
  plus its six cause suffixes. No export or signature changes; the decoder remains
  passive error metadata that never changes admission.
- `native-mask-origins.py` (31 to 35 tests): the product test now uses a shared
  97-value vocabulary and asserts 582 distinct stages plus new refusals; three new
  diagnostic tests (one closed suffix per fixed target and errno, including a check that
  the runner's C library prints exactly the mapped text; unknown or inexact tails and
  non-targets; the complete, unique, bounded line contract and oversize or non-bytes
  input); and one source-structure test that pins the classifier's two return
  expressions and checks, by `ast.literal_eval`, that its prefixes, targets and causes
  and the builder's accepted log tuple are exactly the closed vocabulary.
- `github.isolation.test.ts` (30 to 31 tests): the product test asserts 582 stages; a new
  test decodes the predicted label, the three-record cause shape of job `132529480650`
  with the new stage, and all 120 suffixed stages, and refuses 18 malformed or unknown
  variants through both decoders.

### Prediction for the NQ-1 dispatch

The expected closed label is a prediction, not a result:
`prepare-keeper-child-exit-log-bwrap-destination-host-temp-eacces-info-child-created`,
with pure Python `Ran 35 tests ... OK`, control policy 3 pass, and compile, install and
both preflights passing before prepare fails. Any other outcome is recorded verbatim by
NQ-3.

- An `eacces` result confirms the errno only. The `vector-sandbox-v1` profile grants
  unrestricted `file,`, so it points to a DAC denial rather than an AppArmor denial, but
  it does not say which ancestor blocks the walk: an unsearchable `/home/runner/work`
  gives the same label as an unsearchable `/home/runner`.
- Before any `/home/runner` mask design, NQ-3 must collect the geometry proof: the mode,
  owner and group of `/home/runner`, `/home/runner/work` and `/home/runner/work/_temp`
  on the hosted runner, and whether the keeper uid can search each one.
- If the Python and TypeScript vocabularies ever disagree, `decodeFailureRecords` returns
  no records for the whole stderr, so both the entry and the control `native-prepare`
  records drop and only the transport `close` record remains. NQ-3 must read a
  transport-only cause as a possible vocabulary mismatch, not as a new failure.

### Evidence (local)

- Both Python sources parse with `ast.parse`. The fixture was not executed locally, and
  its CI-only gate is unchanged.
- A static agreement check parsed `entry.py` and the fixture with `ast` only: the new and
  changed keeper functions use only calls in the fixture's allowlists; the builder's
  literal log tuple has 97 distinct values whose destination entries are exactly the
  classifier's 10 kinds, alone or with its 6 causes; the product is 582 stages.
- The TypeScript decoder accepted exactly those 582 stages and refused every other one of
  6660 candidates (extra kinds, extra or reordered causes, other categories with a cause,
  unknown outcomes and infos): 0 disagreements.
- Supplementary only (see D13): a scratch smoke compiled only five side-effect-free
  functions extracted from `entry.py` by AST (`require`, `keeper_log_stage`,
  `keeper_destination_stage`, `keeper_log_classification`, `keeper_failure_stage`) with
  a minimal builtins table and ran 892 direct checks; all passed. No fixture code,
  module initialization, ctypes or native operation ran. The authoritative evidence for
  the Python changes is the CI guard-unit run of the 35-test fixture.
- From `packages/engine`: `bun test --timeout 30000 test/cli/github.isolation.test.ts`
  gives 31 pass, 0 fail, 2881 expects (baseline 30 pass, 1283 expects).
- `bun typecheck` passes in `packages/core` and `packages/engine`.
- Prettier reports both TypeScript files unchanged after formatting; `git diff --check`
  is clean.

### Deferred

- The 35-test Python fixture and the hosted label run only in CI (guard-unit, then the
  native dispatch).
- The push, the guard-unit read, the single native dispatch and the run/job record follow
  the commit in the commit step; the dispatch log row is filled from the API by a
  follow-up docs commit or, if the commit step cannot, by NQ-3.
- The `bwrap-userns-denied` gap (D4) is recorded, not fixed.

### Deviations and decisions

- D1. The native-shell job `if` is at line 33, not 34.
- D2. C9 precision: an empty `/proc` also exists in native CI builds
  (`native || FLOOR`). The conclusion is unchanged because native plus owned is refused
  before launch.
- D3. The hosted line most likely uses the `Can't mkdir parents for` prefix; both prefixes
  give the same label.
- D4. Ubuntu's `0.9.0-1ubuntu0.3` patch rewrites the userns-denied message ("No
  permissions to create new namespace ... See <https://deb.li/bubblewrap> ..."), so the
  exact upstream `bwrap-userns-denied` label cannot match on the hosted runner; such a
  failure would classify as `no-marker`. This fails closed. Neither Ubuntu patch touches
  any "Can't mkdir" message.
- D5. `eacces` indicates DAC but does not name the blocking ancestor; NQ-3 confirms.
- D6. `origin/native-qualify` does not exist yet, so the first push's
  `git fetch origin native-qualify` has nothing to fetch. The commit step checks with
  `git ls-remote --heads origin native-qualify` first.
- D7 (critique accepted). The 60 suffixed labels are written out literally in
  `keeper_failure_stage` instead of a starred generator, and the classifier's targets are
  a 14-entry literal tuple instead of a comprehension, so both can be compared with
  `ast.literal_eval`. A new source-structure test asserts that agreement.
- D8 (critique accepted). The native dispatch is gated on guard-unit passing at the pushed
  SHA, and the static agreement check above was added.
- D9 (critique accepted). A vocabulary mismatch drops every decoded entry and control
  record, not just the entry record.
- D10 (critique accepted). The package table copies the lane's package list. NQ-7's
  full-matrix dispatch is conditional on a green diagnostic cell with the `owned` case,
  and any further full-matrix spend is owner-gated.
- D11 (critique accepted). The new status section states that it supersedes the 37/222
  count.
- D12. Beyond the plan, the fixture imports `errno` and checks `os.strerror` for the six
  errnos against the mapped texts. This ties the mapping to the runner's actual C library
  in the C locale, which is the same text bubblewrap prints. It runs first in guard-unit,
  so a mismatch blocks the dispatch instead of wasting it.
- D13. Beyond the plan, the local pure-function smoke above ran AST-extracted production
  functions (never the fixture). The plan proposed `ast.parse` only; this adds direct
  evidence that the new code runs before the CI-only fixture does. This local execution
  is outside the lane's allowed local checks (Python `ast.parse`, pure Bun tests one file
  at a time, per-package `bun typecheck`) and must not be repeated in later packages; it
  is supplementary, and CI guard-unit (35 tests) is the authoritative evidence for the
  Python changes.
- D14 (review finding, partly declined). The review asked for the NQ-1 heading to carry
  the committed SHA. A commit cannot contain its own SHA, so the heading is "What
  landed" and the package table no longer says the work is uncommitted; the SHA, the
  run and job IDs and the guard-unit result go into the dispatch log in the follow-up
  docs commit or in NQ-3.

## NQ-2, 15 November 2026

All citations are at the lane head. NQ-2 changes no production code, so every cited code
line is unchanged since `597dbcc9`.

### What landed

- New `packages/engine/test/task/shell-required-isolation-posix.test.ts` (SPAWN-1, POSIX
  half). It follows the child pattern of `shell-required-isolation.test.ts`, which is not
  edited. The parent test is `test.skipIf(process.platform !== "linux")`, so it is skipped
  explicitly off Linux. It re-runs the file with `bun test --timeout 30000` from
  `packages/engine` (so the bunfig preloads apply) and the fixed environment
  `{ PATH: "/usr/bin:/bin", VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX: "1" }`, with no
  inherited `LD_*`, `NODE_OPTIONS` or other variable. Only on a GitHub-hosted runner
  (`RUNNER_ENVIRONMENT=github-hosted`) does it add
  `VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX_REAPING=1`, which makes the sleeper check
  strict (D17). Bun's spawn `timeout` (50 s) bounds the child. The parent expects exit 0
  and the child's marker, and logs the marker line.
- The child calls `ProcessIsolation.requireIsolation()` and builds `ShellJobs.node`,
  `Session.node` and `BackgroundJobStore.node` with `backgroundSubagents: true`. Its one
  case does this:
  1. It asserts the premise: `required()` is true, `FLOOR` is false and
     `nativeBuild().enabled` is false. It also checks that the guarded branch of `decide`
     is live: `launch` refuses `LD_PRELOAD` with "GitHub agent tools cannot set a native
     loader environment." and otherwise returns the plain command with no wrapper
     (`process-isolation.ts:323`, `:326`).
  2. It starts the owned background command
     `sh -c 'trap "" TERM; sleep 600 & echo $! > A; sleep 600 & echo $! > B; wait'`, with
     both pid files in a fresh `mkdtemp` directory that is removed afterwards. It reads
     both pids and the leader pid from the durable row.
  3. It reads `/proc/<pid>/stat` on the host and asserts that both sleepers have parent and
     process group equal to the leader and are not zombies. So the plain owned group is
     the only signaler, with no bwrap or guardian in between.
  4. In an inner scope it starts `ShellJobs.LIMIT - 1` = 7 plain `sleep 600` fillers,
     each with a scope finalizer that stops it, and asserts that `full` is true.
  5. It stops the target and asserts:
     - the returned shape is `{ status: "stopped" }` with no `exitCode`;
     - the elapsed time is at least `GRACE - 100` ms (SIGTERM was ignored, so the kill
       phase ran) and less than `GRACE + KILL` = 6000 ms (`owned-process.ts:131`,
       `:134`);
     - the row's `metadata.cleanup` is `"confirmed"`;
     - each sleeper has ended: on a GitHub-hosted runner it must be `ESRCH` within 2 s,
       and elsewhere `ESRCH` or a zombie already reparented away from the leader (D17);
     - `full` is false while the 7 fillers still run, so this slot was released.
  6. Closing the inner scope stops the fillers. It then asserts:
     - `shells.list` has no running entry and lists the target as stopped;
     - `full` is false;
     - the stopped note reached the session with `noReply` (D23);
     - the row's `metadata.ended.state` is `"stopped"`.
  7. It prints `POSIX_OWNED_BACKGROUND_CLEANUP_CONFIRMED_UNDER_REQUIRED_ISOLATION`
     followed by `{"elapsed": <ms>, "reaping": <true or false>, "ended": [<ESRCH or Z>,
     <ESRCH or Z>]}`.
- A finalizer sends SIGKILL to a recorded pid only while `/proc/<pid>/stat` still shows
  the leader's process group and a state other than `Z`. So a pid reused by another
  process in the shard is never signalled.
- No setsid grandchild is spawned. Without the floor it would escape the group, which is
  the pre-existing limit at `shells.ts:31` ("Independent POSIX groups are not
  contained"). It is recorded here and not asserted.

### §6 Q3 answer (code reading)

The question: can background shells run in a hosted GitHub run? From code reading:
**yes**, in a hosted legacy `@vector` run on Linux.

- The flag is on. `backgroundSubagents` defaults to true (`runtime-flags.ts:33-38`). The
  hosted engine starts under `/usr/bin/env -i` (`github.sandbox.ts:788-791`) with only
  `sandboxEnvironment` (`github.sandbox.ts:309-350`, built at `:705`). That environment
  takes its names from `SANDBOX_ENV_ALLOW` (`packages/core/src/github-agents.ts:126-168`).
  Neither `VECTOR_DISABLE_BACKGROUND_SUBAGENTS` nor
  `VECTOR_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is on that list.
- A lease always exists. Each engine instance opens `BackgroundJobStore.open()`
  (`background/job.ts:37`) and passes it to `makeWith` (`:46`). `lease()` returns it
  (`packages/core/src/background-job.ts:853`), so the check at `shells.ts:469-470` passes.
- The shell tool reaches `ShellJobs`:
  - `jobs` is resolved with `Effect.serviceOption` (`tool/shell.ts:1905`);
  - `ShellJobs.node` is in the tool registry (`registry.ts:694`);
  - session turns pass `promptOps` (`session/prompt.ts:698`);
  - background admission checks only the subagent rule, the flag, availability, the
    timeout and the limit (`tool/shell.ts:2221-2228`), then routes to `ShellJobs`
    (`:2239-2253`).
  `github.handler.ts:297-301` already expects background work to continue in the hosted
  process.
- `ShellJobs.start` refuses on required isolation only on win32 (`isolationRefusal`,
  `shells.ts:96-98`, used at `:464`). On Linux the shell tool skips its own sandbox
  wrapper while isolation is required (`tool/shell.ts:1243`). It builds
  `ChildProcess.make(command, [], { shell, cwd, env, stdin: "ignore", detached: process.platform !== "win32" })`
  (`:1284-1290`), a detached process on POSIX, which
  `ShellJobs` wraps with `OwnedProcess.command` (`shells.ts:630`). The spawner's
  non-native branch runs it unwrapped, because `decide` returns the plain command without
  the floor (`process-isolation.ts:326`). `OwnedProcess.track` then owns it
  (`cross-spawn-spawner.ts:456`). Cleanup is the plain process group, checked against the
  host `/proc`, which is exactly what the new test exercises.
- A native CI build behaves differently (`LinuxIsolationBuild.enabled` true), and this is
  unverified code reading until the native-shell `owned` refusal scenario proves it:
  - `ShellJobs` refuses nothing before a row there. The refusal at
    `cross-spawn-spawner.ts:405-411` fires inside the job's `run` (`shells.ts:630`),
    after `background.start` has written the durable row (`:695`).
  - No process is created. The error reaches the caller through `ready` (`:690`, `:762`)
    as "Vector could not start the command: ..." (`:632`).
  - The row ends terminal with cleanup `"confirmed"`, because `owned` is undefined and
    `unowned` is false (`:512`, `:520`). The slot is released (`:527-530`).
  - Whether the row ends failed or stopped, and whether a note is sent, depends on whether
    the job's own error or start's error cancel (`:765`) settles first.
  - This differs from the Windows S4-3 contract, where no row is written at all. The
    NQ-6/NQ-7 `owned` refusal scenario must expect a row.
- The product decision stays open and owner-gated: whether hosted `@vector` runs offer
  background shells at all. Nothing in NQ-2 changes admission. The smallest future refusal
  would drop the `win32` condition from `isolationRefusal`; that is not done.

### C9 and SPAWN-2

C9 is not reachable at the lane head; see the dated addendum in
[`v2-spawn-review.md`](v2-spawn-review.md#addendum-15-november-2026-c9-spawn-1-and-spawn-2-at-the-native-qualify-head-nq-2).
`groupEmpty` is deliberately unchanged.

### Evidence (local)

From `packages/engine`, one Bun workload at a time:

- The new test (parent) passed: 1 pass, 0 fail, 2 `expect()` calls. The marker line was
  `{"elapsed":3081,"ended":["Z","Z"]}`; a rerun after formatting gave `3083`, and the
  rerun after restoring `owned-process.ts` (below) gave `{"elapsed":3094,"ended":["Z","Z"]}` (1 pass, 0 fail).
- The child branch, run directly with the same fixed environment
  (`env -i PATH=/usr/bin:/bin VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX=1`), passed:
  1 pass, 0 fail, 24 `expect()` calls, with the same marker.
- `ended` is `["Z","Z"]` here because this container's PID 1 reaps orphans only on a
  sweep about every 2 s (D17). On a GitHub-hosted runner the child polls for strict
  `ESRCH`, and the marker in the `test.yml` log records `reaping` and the outcome.
- Mutation 1, in the test, then reverted: removing `trap "" TERM` failed the lower bound
  ("Expected: >= 2900, Received: 93.36"; 0 pass, 1 fail).
- Mutation 2, in production code, then reverted: changing `process.kill(-pid, value)` to
  `process.kill(pid, value)` in `owned-process.ts` `signal` signals only the leader. The
  test failed at the first stop assertion: the stop returned `status: "failed"` instead
  of `"stopped"` (0 pass, 1 fail, case 10.1 s). The sleepers survived the stop and were
  killed by the guarded finalizer; no `sleep 600` process was left afterwards.
- Both mutations ran the child branch directly, to read its failure output. The test file
  was compared byte for byte (`cmp`) against the reviewed copy, and `owned-process.ts`
  against its original.
- `git diff --exit-code origin/native-qualify` is empty for
  `packages/core/src/owned-process.ts`, `packages/core/test/process/owned-process.test.ts`,
  `packages/engine/test/task/shells.test.ts` and
  `packages/engine/test/task/shell-required-isolation.test.ts`.
- `bun typecheck` passes in `packages/engine`, the only package with a changed file.
  Prettier reports the new file formatted, and `git diff --check` is clean.
- After the review fixes (D17, D27, D28), same day and same commands:
  - the parent passed (1 pass, 0 fail, 2 `expect()` calls) with
    `{"elapsed":3106,"reaping":false,"ended":["Z","Z"]}`;
  - the child branch run directly passed (1 pass, 0 fail, 21 `expect()` calls; three
    fewer because the per-pid loops became single assertions) with
    `{"elapsed":3079,"reaping":false,"ended":["Z","Z"]}`;
  - supplementary only (D17): the child run directly with
    `VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX_REAPING=1` passed with
    `{"elapsed":3088,"reaping":true,"ended":["ESRCH","ESRCH"]}`;
  - mutation 2, rerun against the revised test and then reverted, still failed at the
    stop assertion (`status: "failed"`; 0 pass, 1 fail, case 10.1 s). The inner scope
    stopped the fillers and the guarded finalizer killed the sleepers: no `sleep 600`
    process was left after any run. `owned-process.ts` was restored, and both `cmp`
    against the saved copy and `git diff --exit-code origin/native-qualify` are clean;
  - `bun typecheck` in `packages/engine` passes, Prettier reports the test file
    formatted, and `git diff --check` is clean.

### Deferred

- The Linux engine shard of `test.yml` at the lane end, where the marker shows `ESRCH` or
  `Z` on the hosted runner.
- SPAWN-1's native half, the refusal at `cross-spawn-spawner.ts:411`. It cannot be tested
  from source because `process-isolation/build.ts:2` is false. It belongs to an `owned`
  refusal scenario in the native-shell fixture (template: `native-shell-engine.ts:272-279`)
  in NQ-6/NQ-7, which must expect a durable row (see Q3 above).
- S4-2's `setsid` canary. This is the pre-existing limit at `shells.ts:31`, and it is not
  asserted.
- The §6 Q3 product decision, which belongs to the owner.

### Deviations and decisions

- D15. `shells.list` is not empty after a stop, because `BackgroundJob.list` keeps ended
  jobs (`packages/core/src/background-job.ts:594-598`). The test asserts no running entry
  plus the stopped target.
- D16. The slot proof uses 7 fillers. `full()` with one job is always false (`LIMIT` 8,
  `shells.ts:35`). This is the pattern of the uncertain-cleanup case in `shells.test.ts`.
- D17 (critique accepted, deviation from the brief off hosted runners; revised after
  review). The brief asks for `ESRCH`. On a GitHub-hosted runner the test asserts exactly
  that: the parent sees `RUNNER_ENVIRONMENT=github-hosted` and passes one test-owned,
  non-loader variable, `VECTOR_TEST_SHELL_REQUIRED_ISOLATION_POSIX_REAPING=1`, into the
  child's fixed environment. The child then polls each sleeper for `ESRCH` for up to 2 s
  after the stop, and on timeout returns its `/proc` state so the assertion names it. The
  `engine-linux` job runs on `ubuntu-24.04` (`test.yml:725`, `:733`) with no `container:`,
  so its PID 1 is expected to be systemd, which reaps orphans. The lane-end shard confirms
  this or not, and a failure there is a real result that needs a root cause. Off hosted
  runners a sleeper may also be a zombie, but only one already reparented away from the
  leader that keeps the leader's process group. Any other zombie or live process fails.
  This container's PID 1 (`process_api`) reaps orphans only on a sweep about every 2 s: in
  a scratch Python measurement (`/tmp/vector-v2/native/reap-delay.py`) eleven orphan
  zombies lived 1.09-2.00 s before PID 1 reaped them. So an immediate check sees `Z` here,
  and a strict 2 s bound would race the sweep. The original D17 text said this PID 1 does
  not reap at all; that was wrong. A supplementary local run of the child with the strict
  variable set passed (`ended` `["ESRCH","ESRCH"]`), which shows the strict branch works,
  not that it is stable here. A scratch Bun spawn showed that an orphan of a Bun-spawned
  shell is reparented to PID 1, so Bun is not a child subreaper and the hosted runner's
  PID 1 is the reaper there. The review suggested `GITHUB_ACTIONS` as the marker, but the
  shard step sets `GITHUB_ACTIONS=false` (`.github/workflows/test.yml:773`), so the parent
  reads `RUNNER_ENVIRONMENT` instead and the child sees only the test's own variable. The
  grace and kill bounds are unchanged, and the 2 s poll runs after the stop is timed.
  `OwnedProcess.groupEmpty` already treats `Z` as gone (`owned-process.ts:90`). The marker
  now records `reaping`, so the `test.yml` log shows which branch ran.
- D18 (refines D2). The §4.4 delegate never calls `groupEmpty`: it never signals, and it
  runs the native owner's stop instead. So delegating native plus owned would not bring C9
  back. C9 reappears only if FLOOR is enabled, or if a native build ever routes an owned
  command through `OwnedProcess.track` instead of delegating or refusing. This replaces
  the NQ-1 C9 section's clause "or native plus owned is ever delegated rather than
  refused"; that section is left as written.
- D19 (beyond the brief, partly from the critique). The test also asserts the premise
  (`required`, `FLOOR`, `nativeBuild`), the guarded launch branch (the `LD_PRELOAD`
  refusal and the plain return), and the geometry (each sleeper's parent and process group
  equal the row's leader pid).
- D20. The upper bound is grace plus kill (6 s) for the whole `shells.stop`. Drain is not
  added, because the pipes close when the last group member dies. The lower bound is
  `GRACE - 100` ms. Locally the stop took about 3.08 s. If the shard is ever slow enough to
  break the bound, the RULES-v2 root-cause rule applies; the bound is not loosened.
- D21. NQ-2 filled the NQ-1 dispatch row from API reads on 15 November 2026 (see the
  dispatch log). NQ-3 interprets it and does not record it again. The step after finish is
  named as in the API and the log: "Preserve every earlier failure and cleanup
  uncertainty", running `manage.mjs assert`.
- D22. `native-isolation-status.md` is unchanged, because no native gate changed.
- D23 (deviation from the plan). The plan's fake `prompt` died. `TaskNotify` delivers the
  stopped note through `ops.prompt` with `noReply`, so a dying prompt would only log a
  delivery warning. The fake records each note and returns a synthetic reply, as
  `shells.test.ts` does, and the test asserts the stopped note is `noReply`.
- D24 (critique accepted). The production mutation (mutation 2) was added, so the test is
  shown to detect a leader-only signal, not only a fixture change.
- D25 (critique accepted). The native refusal in the Q3 answer is worded as a written row
  that ends with cleanup confirmed, not as "nothing exists". It is marked unverified until
  the native `owned` scenario runs.
- D26 (critique accepted). The finalizer signals only a pid still in the leader's group
  and not a zombie. Code is cited by declaration lines (`groupEmpty` `:74-96`, `track`
  `:112-163`).
- D27 (review finding, deviation from the brief's wording). The brief asks that both the
  stop result and the row show cleanup `"confirmed"`. `ShellJobs.stop` returns `Task.Shell`
  (`shells.ts:133`, `:816-822`), which has no cleanup field. Its `status: "stopped"` is the
  stop result's half of the proof: `shape` reports unknown or pending cleanup, or a live
  cleanup failure, as `"failed"` (`shells.ts:414-418`), and `fromRow` does the same for a
  stored row (`:785`). The row half is `metadata.cleanup === "confirmed"`. A comment at the
  stop assertion says this.
- D28 (review findings, style). The geometry and `ended` checks are single `toEqual`
  assertions over the pid list, not `for` loops, so a failure still prints every value.
  The fillers are started with `Effect.forEach` inside an inner `Effect.scoped`, each with
  a finalizer that stops it, instead of being pushed into a mutable array that an
  `ensuring` block stopped. The parent's `setTimeout` plus `try`/`finally` is replaced by
  Bun's spawn `timeout` (50 s), which kills the child the same way. `readPid` accepts a
  pid file only when it matches `/^\d+\n$/` (`echo` writes digits and a newline at once),
  so a read of a partial write is polled again instead of parsed as a truncated pid.

## NQ-3, 15 November 2026

All citations are at the lane head `f96e2456` plus this package's changes. NQ-1 grew
`entry.py`, so its lines moved from the brief's `0ee486e3` numbers (D29).

### Precondition

Read from the API on 15 November 2026 and re-checked before implementation:
`list_workflow_runs` for `native-shell.yml` on `native-qualify` returns `total_count` 1,
run `43660129312` (`workflow_dispatch`, attempt 1, `completed`, `failure`, head
`597dbcc922b44a0e53e0c311cbe416b26cdf6252`). Its only job, `132647364562`
`Shell seam (bun, own-key, baseline)`, closed with the label recorded verbatim in the
dispatch log:
`prepare-keeper-child-exit-log-bwrap-destination-host-temp-eacces-info-child-created`.
That is exactly the NQ-1 prediction, so NQ-3 proceeds as briefed and NQ-5's design is
not rewritten. No native run was in progress. Guard-unit run `43668864838` passed at
`f96e2456` (read in the plan step).

### What landed

- `packages/core/src/process-isolation/linux/entry.py`, the only production behaviour
  change:
  - a new pure helper `keeper_searchable(mode, owner, group, uid, gid)` (line 1502),
    directly below `supported_mask_sources`;
  - in `supported_mask_sources` (1395), `searches = []` beside `records = []` (1428), and
    `searches.append((label, item))` as the last statement of the parent loop (1459),
    after the parent-canonical check;
  - after the final `validate_source_view(...)` and before `return result`, one pass over
    those already-admitted parent `lstat` results (1496-1498) that refuses with the fixed
    stage `prepare-mask-<label>-keeper-search`;
  - in `prepare_in_capture` (1691), after the `state` statement that computes
    `runtime_images()` and before `prepare-record`, one check of the container ancestry
    (every strict ancestor of the checkout, 1721-1723) with the fixed stage
    `prepare-keeper-search-checkout` (D30, D31).
  - Unchanged: `MASKS`, `HOST_TEMP`, the keeper argv, `keeper_destination_stage`,
    `keeper_failure_stage` and cleanup. No `chmod` is added.
- `packages/engine/src/cli/cmd/github.isolation.ts` `FAILURE_STAGES.entry`: the per-mask
  step list gains `keeper-search` (line 140), and `prepare-keeper-search-checkout`
  follows `prepare-images` (145). That is 6 more entry stages. No export, type or
  signature changes; the decoder stays passive error metadata. The client `mask_proof`
  `parents` tuple (675) is unchanged because `MASKS` is unchanged.
- Counts:

  | Product | Before | After |
  | --- | --- | --- |
  | Mask admission stages (11 literals + 5 masks x steps + 2 `target-mode`) | 68 | 73 |
  | TypeScript per-mask entries | 57 | 62 |
  | `prepare_in_capture` literal stages | 16 | 17 |
  | `entry.py` stage assignments (literals / mask f-strings / builder calls) | 53 (38 / 13 / 2) | 55 (39 / 14 / 2) |
  | `FAILURE_STAGES.entry` | | +6 |
  | Keeper product (logs / stages) | 97 / 582 | 97 / 582 |
  | `native-mask-origins.py` tests (CI-only) | 35 | 40 |
  | `github.isolation.test.ts` tests | 31 | 33 |

- `packages/core/test/fixture/native-mask-origins.py`: `keeper_searchable` joins the pure
  allowlist (it calls only `require`, `integer`, `all` and `type`). New class
  `KeeperSearchTests` (keeper 1002:1002, runner 1001:1001, foreign gid 118):
  - refused: runner `0750` (the HOME_MODE case), runner:docker `0750`, a group-only grant
    `0710` to a non-keeper gid, Root `0770`, Root `0700`, Root `0766`, `0701`
    (1001:1002: the group class is selected and has no search bit) and `0071`
    (1002:1001: the owner class is selected and the unmapped gid gives no override);
  - admitted: Root `0755`, Root `1777`, keeper-owned `0700` and `0000` (both ids mapped,
    so the capability override applies), runner `0711`, `0750` (1001:1002, a group
    grant to the keeper gid) and `0100` (1002:1001);
  - each of the five arguments refuses `None`, `True`, `False`, `"755"`, `-1` and `1.0`;
    a mode of `0o200000` and an owner or group of 9007199254740992 refuse, while
    `0o177777` with owner and group 9007199254740991 is admitted (the bounds are
    inclusive and match `integer()`'s; D44); a uid or gid of 0 or 9007199254740992 refuses.
  Two new `SourceStructureTests`:
  - `test_keeper_search_runs_after_every_mask_predicate_and_before_construction` pins the
    last three statements of `supported_mask_sources` (the `validate_source_view` call,
    the exact search loop, `return result`), `records = []` then `searches = []` before
    the `MASKS` loop, the append as the last statement of the single parent loop after the
    five parent steps in order, exactly three uses of `searches`, the exact two statements
    between the `runtime_images` statement and `prepare-record`, the order masks, then
    container search, then `write_json`, `os.mkdir`, `os.chown` and `subprocess.Popen`, and
    that the only callers are `supported_mask_sources` and `prepare_in_capture`, once each;
  - `test_mask_admission_stages_are_one_closed_fixed_product` checks that every stage
    assignment in `supported_mask_sources` is a literal or the exact
    `f"prepare-mask-{label}-<step>"` shape, that there are 11 literals and 14 f-strings with
    13 distinct steps, that both `target-mode` assignments sit directly in the
    `target == '/home/vector-agent'` and `target == HOST_TEMP` bodies, that the labels dict
    covers `MASKS` in order with home, tmp, var-tmp, run, host-temp, that the product is 73
    stages, and that `prepare_in_capture`'s 17 literal stages are in the expected order.
  The cleanup independence test also forbids `keeper_searchable` in `cleanup`,
  `read_state` and `mask_records`.
- `packages/engine/test/cli/github.isolation.test.ts`:
  - "keeper search admission stages decode only as fixed mask and checkout labels": the
    predicted cause decodes (entry `prepare-mask-host-temp-keeper-search` `RuntimeError`,
    errno and exit null; control `native-prepare` `CalledProcessError` exit 125;
    transport `close` `ChildExit` exit 1), all six new stages decode through both
    decoders and are refused under the control, client and transport origins, and 21
    near-misses are refused by both decoders (bad labels, suffixes including the
    `-runner-home`/`-runner-work` witnesses D34 declines, `:0750`, a newline and a NUL,
    truncations, `prepare-keeper-search` variants including the dropped `-scratch`, a case
    variant and a keeper-family splice);
  - "every fixed entry stage in the native source decodes" (D35) reads `entry.py` with
    `Bun.file`, requires every `_DIAGNOSTIC_STAGE = ` assignment to be a literal, a mask
    f-string or a `keeper_failure_stage(...)` call, requires every literal to decode, and
    requires the decoder to accept exactly the source's label x step product within a
    candidate set that adds foreign labels and steps. The product is read from the source,
    not restated (D44): a mask step assigned directly in a loop body belongs to every
    label, one assigned in an `if/elif target == ...` branch belongs to that branch's
    target, resolved through the `labels` dict (today `target-mode`, for home and
    host-temp), and a step under any other enclosing block is unresolved and fails.

### Search model

- The keeper is `setpriv --reuid=<uid> --regid=<gid> --clear-groups` (entry.py:1736),
  then `bwrap --unshare-user --uid 0 --gid 0`, so its `uid_map` and `gid_map` are both
  `0 <id> 1` (asserted at `prepare-keeper-identity`). `useradd --user-group`
  (`github.sandbox.ts:474-479`) gives `vector-agent` its own group.
- Bubblewrap v0.9.0 (`8e51677`, read in `/tmp/vector-v2/native/bubblewrap`):
  `setup_newroot` calls `mkdir_with_parents(dest, parent_mode, FALSE)` for every
  operation with a destination (bubblewrap.c:1194-1214), and `ensure_dir` stats each
  strict-ancestor prefix and tries `mkdir` when the stat fails (utils.c:668-692, 697).
  A stat needs search permission on every strict ancestor of its path. The unprivileged
  child holds full capabilities in the namespace it created during setup.
- Linux `generic_permission`: `acl_permission_check` selects one class (owner when the
  fsuid matches; else group when the inode's group is the fsgid or a supplementary
  group, of which the keeper has none; else other). The `CAP_DAC_READ_SEARCH`/
  `CAP_DAC_OVERRIDE` fallback goes through `capable_wrt_inode_uidgid`, which requires
  both the inode's uid and gid to be mapped in the caller's namespace. So only the
  keeper's own inodes get the override, and every Root- or runner-owned ancestor is
  judged by its one selected class.
- The mask target itself needs no search bit: `ensure_dir(dest)` and the mount resolve
  it through its parents only. `/` is a strict ancestor of every mask, so `--dev /dev`
  and `--proc /proc` (whose only ancestor is `/`) are covered.

### Expected hosted outcome for NQ-5 to verify

A prediction from code reading, not a result:

- Pure Python `Ran 40 tests` ... `OK`; control policy 3 pass; compile, install, workspace
  and both Node/Bun metadata preflights pass.
- Step 13 prepare fails with transport `close` `ChildExit` exit 1, entry
  `prepare-mask-host-temp-keeper-search` `RuntimeError` errno null exit null, and control
  `native-prepare` `CalledProcessError` exit 125. Steps 14-16 are skipped.
- The finish prediction covers only the printed records (D40): control `native-state`
  `FileNotFoundError` `ENOENT` with no entry record, because the refusal comes before
  `prepare-record` writes `private/state.json`, so `native_state()` cannot open it
  (`github.isolation.ts` `native_state` and the cleanup branch). Step 17's API conclusion
  is read, not assumed (in NQ-1 it was `success` although it printed a refusal), and
  step 18's `manage.mjs assert` arguments follow from it.

| Label seen | Meaning | NQ-5 action |
| --- | --- | --- |
| `prepare-mask-host-temp-keeper-search` | The hypothesis is confirmed at admission. `MASKS` order checks `home` first, whose ancestors are `/home` and `/`, so both are keeper-searchable and the blocker is `/home/runner` or `/home/runner/work`. | The `/home/runner` mask design stands (D34). |
| `prepare-mask-home-keeper-search` (or another mask's) | `/` or `/home` (or that mask's own ancestry) is not keeper-searchable. | Rewrite NQ-5 before it runs. |
| `prepare-keeper-search-checkout` | The container ancestry blocks the keeper. | Record it and design separately. |
| Still `...bwrap-destination-host-temp-eacces...` | The model missed the denial (for example an ACL, an LSM or a gid overlap). | Root-cause it first. |
| Finish prints `cleanup-proof` instead of `native-state` | `private/state.json` existed, so the refusal came after `prepare-record`, which contradicts an admission-time refusal. | Root-cause it first. |
| Transport-only cause | A vocabulary mismatch (D9). | Fix the vocabulary. |
| Anything else | | Record it verbatim. |

### Evidence (local)

From the worktree, one Bun workload at a time through the lock:

- Both Python sources parse with `ast.parse` (`python3 -I -S -B`). The fixture was not
  executed locally; its CI-only gate is unchanged.
- Supplementary (D43), AST-only: `/tmp/vector-v2/native/nq3/static-check.py` parsed
  `entry.py` and the fixture and passed 77 checks (78 after D44, whose bound check adds
  one `type` call to the helper). They mirror the two new structure
  tests (placements, shapes, the 73-stage product and the 17 prepare literals) and check
  that the helper calls only names the fixture's allowlist accepts, that it has no
  defaults or decorators, that `PURE` lists it, and that the fixture's 40 test names are
  unique.
- Supplementary (D43): `/tmp/vector-v2/native/nq3/kernel-model.py` models
  `acl_permission_check` and `capable_wrt_inode_uidgid` in the kernel's own form. All 15
  fixture cases agree with it, and the helper's selection rule, restated, agrees with it
  on all 65536 combinations of 4096 modes and four owner and group ids. It never imports
  `entry.py` or the fixture.
- From `packages/engine`: `bun test --timeout 30000 test/cli/github.isolation.test.ts`
  gives 33 pass, 0 fail, 2962 `expect()` calls (baseline 31 pass, 2881); after the D44
  review fixes, 33 pass, 0 fail, 2964 `expect()` calls.
- Mutations (D36), each run once against the same file, then restored from
  `/tmp/vector-v2/native/nq3/saved` and checked with `cmp`:
  - M1, `entry.py` `keeper-search` renamed `keeper-searched`: 32 pass, 1 fail (the
    source-agreement test);
  - M2, `keeper-search` removed from `FAILURE_STAGES`: 31 pass, 2 fail (both new tests);
  - M3, `prepare-keeper-search-checkout` removed from `FAILURE_STAGES`: 31 pass, 2 fail
    (both new tests).
- `bun typecheck` passes in `packages/core` and `packages/engine` (`tsgo --noEmit`, exit 0).
- Prettier rewrote the test file and reported `github.isolation.ts` unchanged; neither
  file changed afterwards except by the restored mutations. `git diff --check` is clean.
- After the D44 review fixes, same day and same commands: both Python sources parse;
  `static-check.py` passes 78 checks and `kernel-model.py` reports no disagreement; the
  Bun file gives 33 pass, 0 fail, 2964 `expect()` calls; `bun typecheck` passes in
  `packages/core` and `packages/engine`; Prettier reports both TypeScript files
  formatted; `git diff --check` is clean. The mutations were re-run from
  `/tmp/vector-v2/native/nq3/review/mutate.sh`, each restored from
  `/tmp/vector-v2/native/nq3/review/saved` and checked with `cmp`:
  - M1, M2 and M3 as above give the same results (32/1, 31/2, 31/2);
  - M4, `entry.py`'s first `target-mode` branch changed from
    `target == "/home/vector-agent"` to `target == "/tmp"` (the decoder unchanged):
    32 pass, 1 fail (the source-agreement test, on the set comparison). With the
    earlier restated rule swapped back in, the same mutation gives 33 pass, 0 fail,
    which is the false pass the review described;
  - M5, a `target-mode` assignment added under the `else:` branch: 32 pass, 1 fail
    (the source-agreement test, on the unresolved step).

### Deferred

- The 40-test fixture and the hosted label run only in CI (guard-unit, then the native
  dispatch).
- Commit, push, the guard-unit and typecheck gate (D39), the single dispatch and the
  dispatch-log row belong to the commit step; if it cannot record the run, NQ-5 does.
- Which of `/home/runner` and `/home/runner/work` blocks stays unproven (D34).
- For NQ-5: if `HOST_TEMP` stays in `MASKS` under a new `/home/runner` mask, its
  keeper-search check would still refuse, because `/home/runner` is one of its strict
  ancestors on the host even though bwrap would build it inside the keeper-owned tmpfs.
  NQ-5 must either drop the covered `HOST_TEMP` mask or exempt ancestors already hidden
  by an earlier mask, and say which in its notes. No such change is made here.

### Deviations and decisions

- D29. Line drift: NQ-1 grew `entry.py`, so the brief's `0ee486e3` line numbers moved.
  This section cites the working lines (for example `supported_mask_sources` 1395,
  `prepare_in_capture` 1691, `FAILURE_STAGES` 107).
- D30 (deviation from the plan's placement). The mask check is one final pass in
  `supported_mask_sources` over the parent `lstat` results the earlier predicates already
  admitted, after `validate_source_view`, so every geometry refused there before NQ-3 keeps
  its label. The container check sits after the `runtime_images()` statement, not before
  `prepare-images` as planned, so a runtime-image refusal also keeps its label. Only
  `prepare_in_capture` knows the container, so that check lives there. One case still
  changes label: a geometry with an unsearchable mask ancestor that previously failed at
  `prepare-images` now reports `prepare-mask-<label>-keeper-search`. Nothing refused before
  is admitted, and geometry the keeper's mode bits allow is admitted as before.
- D31 (critique accepted). One container-ancestry check, `prepare-keeper-search-checkout`,
  replaces the planned `-checkout`/`-scratch` pair. `validate_spec` pins both directly
  under the container, so they have the same strict ancestors, and a scratch check could
  never fail once the checkout check passed. The container itself must be Root-owned
  `0755` (`prepare_in_capture`), so the check can fail only on the container's ancestors
  (`/mnt`, `/var/lib`, `/var`, `/home`, `/`). The `-checkout` name follows the brief's
  suggested family. `FAILURE_STAGES` grows by 6, not 7.
- D32. The capability override follows the brief but is not reachable from admission at
  this head: the parent-owner predicate admits only Root or the runner, and
  `secure_chain` requires Root along the container chain. Only the helper tests exercise
  it.
- D33. Not modelled: POSIX ACLs, MAC (the `vector-sandbox-v1` profile grants `file,`) and
  the search needed to execute and change directory. An ACL-only grant is refused, which
  is stricter; an ACL deny is still caught by bwrap's own failure. On the exec and chdir
  paths, the installer creates `BASE` and `ROOT` as Root `0755` (`github.isolation.ts:781-782`)
  and re-checks both as exactly `0755` at `control-lock` (789), `entry.py` is written
  `0444` (786), and the scratch is keeper-owned `0700`; `/usr`, `/usr/bin` and
  `/usr/libexec` are image defaults that `secure_chain` checks only for Root ownership and
  no group/other write. So after NQ-5 no other DAC search blocker is expected on that path.
  This is code reading, not proof.
- D34 (critique accepted, option (b): the NQ-1 geometry-proof requirement is superseded).
  The NQ-1 notes asked NQ-3 for the raw mode, owner and group of `/home/runner`,
  `/home/runner/work` and `/home/runner/work/_temp` before any `/home/runner` mask design.
  They are not collected: no host metadata leaves the private log and no workflow step is
  added. A per-ancestor witness label (option (a), for example
  `prepare-mask-host-temp-keeper-search-runner-home`) was considered and declined: NQ-5's
  `/home/runner` mask works whichever of the two blocks. Bwrap's walk to `/home/runner`
  needs search only on `/` and `/home`, which the `home` mask's ancestor check proves
  first in `MASKS` order, and the tmpfs then hides both `/home/runner` and
  `/home/runner/work`. A narrower `/home/runner/work` mask would need a per-ancestor
  witness first. The NQ-1 section is left as written.
- D35 (critique accepted in part). The source-agreement Bun test is kept because
  guard-unit never runs the TypeScript decoder, so it is the only local guard against a
  D9 mismatch. It asserts set agreement and complete shape coverage instead of freezing
  the raw 55-assignment total. Cost: a new stage still needs edits in `entry.py`, the
  fixture and `FAILURE_STAGES`, and a new stage shape also needs this test.
- D36. Local mutations of the Bun file, each restored from a saved copy and checked with
  `cmp`; results in the evidence above.
- D37. `v2-spawn-review.md` and `process-ownership-followup.md` are unchanged, because no
  spawn hot-spot file or ownership contract is touched.
- D38. Interpretation of the NQ-1 row, which NQ-2 left to NQ-3: the label is the
  predicted `eacces` on the fixed hosted temporary root. With the profile granting
  `file,`, that is a DAC denial in the walk of `HOST_TEMP`'s ancestry, consistent with the
  root-cause hypothesis, but it does not name the ancestor. Step 17's `success` conclusion
  next to a printed refusal is recorded, not explained.
- D39 (critique accepted). The dispatch gate reads both `native-guard-unit.yml`
  (`Ran 40 tests` ... `OK`) and `typecheck.yml` at the pushed SHA, as the NQ-1 row did,
  and records both run IDs.
- D40 (critique accepted). The finish prediction covers the printed records only; the
  step 17 API conclusion is to be read. Seeing `cleanup-proof` would contradict an
  admission-time refusal (interpretation table).
- D41 (critique accepted). The near-miss list has 21 entries: the plan's 17, plus
  `prepare-mask-home-keeper-search-checkout`, the dropped `prepare-keeper-search-scratch`
  and the two declined witness labels.
- D42 (beyond the plan). The input test also refuses `False`, and the cleanup
  independence test forbids `keeper_searchable`.
- D43. Supplementary scratch checks, outside the fixture and never executing `entry.py`
  or extracted production functions (the D13 rule): an AST-only agreement script and an
  independent model of the kernel's permission check; results in the evidence above.
- D44 (review findings, all four accepted, all non-blocking; nothing declined).
  - The source-agreement Bun test no longer restates which masks have `target-mode`. It
    reads each mask step's labels from `entry.py` (the enclosing loop or
    `if/elif target == ...` branch, resolved through the `labels` dict) and fails on any
    other enclosing block. M4 shows the earlier restatement passed a source drift that
    this catches. The fixture's `test_mask_admission_stages_are_one_closed_fixed_product`
    still pins the two `target-mode` branches on the Python side.
  - `keeper_searchable` now bounds `mode` to `0..0o177777` and `owner` and `group` to
    `0..9007199254740991`, matching `integer()`'s upper bound (`0` stays allowed for
    Root-owned inodes). The input test gains one overbound case per argument and one
    inclusive-bound admission. The values come from `lstat`, so no hosted geometry
    changes label or admission; the fixture still has 40 tests.
  - The status document's count now reads as the decoder and its test file
    `github.isolation.test.ts` (33 tests, 2 new).
  - The package-table row says "Implemented, uncommitted" until the commit step pushes,
    and is changed to "Committed" together with the dispatch-log row.
- D45 (commit step). The package-table row reads "Committed" in the NQ-3 commit itself,
  as NQ-1's did, because a commit cannot record the dispatch that follows its own push.
  The dispatch-log row stays pending in that commit; the commit step's report carries the
  gate run IDs and the native run ID, and a later package fills the row from the API.

## NQ-4, 15 November 2026

All citations are at the lane head `f05f9916`. Of the files the inventory cites, only
`github.isolation.ts` changed since `0ee486e3` (NQ-1 and NQ-3 grew `FAILURE_STAGES`), so
its spawn line is the HEAD line (D46).

### Precondition

Read from the API on 15 November 2026: `list_workflow_runs` for `native-shell.yml` on
`native-qualify` returns `total_count` 2. The newer run, `43675930370`, is the NQ-3
dispatch and is `completed` with `failure` at `f05f9916`; its facts are now in the
dispatch log. No native run was in progress. NQ-4 is not a native package and does not
depend on that run.

### What landed

- `packages/engine/test/spawn-inventory.test.ts`, the only code change. It imports only
  `bun:test` and `node:path`, so Core never reaches into Engine. It transpiles every
  non-test source file under `packages/core/src` and `packages/engine/src` (1235 files,
  about 0.65 s) and holds eleven tests:
  - T1: the scan sees each primitive, and ignores comments and look-alikes (28 snippets,
    plus one `.tsx` case);
  - T2: the set of files that reach a spawner equals the table below; it fails on any
    unlisted file (named with its labels) and on any stale entry;
  - T3: `type-only` entries reach a process module in types only, and every other entry
    reaches one at run time;
  - T4: each `launch` entry calls `ProcessIsolation.launch(` or `commandPlan(`, starts at
    least one `isolated.file` with `isolated.args` and no shell of its own, and makes no
    other start the check can see, except one listed helper call: no other call through a
    name bound from a process module (a named, default or namespace import, or a
    destructured or `const`-bound `require(…)` or `import(…)`), no member call on an
    inline `require(…)` or `import(…)` of one, and no run-time primitive whose calls the
    check cannot follow (Bun's own spawners and `Bun[]`/`"bun"` imports, Effect's
    platform layers). The helper list fails when stale;
  - T5: both `required-refusal` entries contain `ProcessIsolation.required()` and spawn;
  - T6: the `#pty` import map in `packages/core/package.json` names exactly the two
    `pty-backend` entries, only `core/src/pty.ts` loads them, and it calls
    `ProcessIsolation.launch(`;
  - T7: only `engine/src/task/shells.ts` loads the Windows holder, and it still asks
    `isolationRefusal({ platform: process.platform, required: ProcessIsolation.required() })`
    (the refusal's behaviour is S4-3's test);
  - T8: the plugin host's only primitive is `Bun.$`, and it calls
    `ProcessIsolation.assertExternalCodeAllowed()`;
  - T9: only `engine/src/mcp/stdio.ts`, a `launch` entry, constructs
    `StdioClientTransport`;
  - T10: only `core/src/cross-spawn-spawner.ts` builds Effect's `ChildProcessSpawner`
    service (`make`/`makeHandle` imported from it, a namespace import of it,
    `ChildProcessSpawner.make`/`.makeHandle`/`.of`, or `Layer`/`Context`/`Effect` called
    with it as the first argument);
  - T11 (next to T4 in the file): T4's per-file check on 14 snippets, one per form: a
    planned call, a call on another file, a default-import member call, a cross-spawn
    default member call, `const`-bound `require` and `await import`, inline `require` and
    `import()` member calls, `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, a `globalThis.Bun`
    destructure, a `"bun"` import and an Effect platform layer.
- No production source, workflow, flag, environment or configuration switch changes.
  `LinuxIsolationBuild.enabled` and `entrySHA` and `ProcessIsolation.FLOOR` are untouched,
  and native plus owned stays refused.

### Stance vocabulary

- `launch`: routes every process through the ProcessIsolation launch decision and starts
  only what it returns. While FLOOR and the native build are off, that is the command
  unchanged, or a refusal off Linux under required isolation (`decide`,
  `process-isolation.ts:313-330`). No site is isolated today.
- `pty-backend`: a PTY adapter behind `#pty` that only `core/src/pty.ts` loads, after its
  own launch decision.
- `required-refusal`: refuses to spawn while `ProcessIsolation.required()`.
- `fixed-helper`: a fixed system program with fixed arguments; no caller-chosen command.
- `type-only`: names a process module in types only.
- `windows-holder`: the Windows Job Object holder, which only ShellJobs loads and which
  ShellJobs refuses under required isolation.
- `runner`: the CI job's own controller, run before or after the agent or in a separate
  job, never as the agent.
- `cli`: a person's own command, which a hosted agent cannot reach.
- `plugin-host`: hands a spawner to plugins, whose external code is refused under
  required isolation.
- `url-opener`: opens a URL in the operating system's browser on a person's request.
- `re-export`: re-exports a process module's class without constructing it.

Principle 5 ("every spawn site consults the isolation floor") holds for the 6 `launch` and
2 `pty-backend` entries. The other 23 are listed exceptions, each with its reason.

### Stance table

| File | Stance | Why (HEAD lines) |
| --- | --- | --- |
| `core/src/cross-spawn-spawner.ts` | launch | The Effect spawner: `ProcessIsolation.launch` (:432), or `commandPlan` in a native build under required isolation (:413; owned commands refused at :411), inside `Effect.try`; cross-spawn starts `isolated.file` with `isolated.args` and `isolated.options` (:452). Its Windows `killGroup` taskkill (:523) is the one listed helper call (F7). |
| `core/src/untrusted-git.ts` | launch | `ProcessIsolation.launch` (:66), then `execFile(isolated.file, isolated.args)` (:68). |
| `core/src/brain/document/ocr.ts` | launch | `ProcessIsolation.launch` (:280), then `spawn(isolated.file, isolated.args)` with `shell: false` (:282). |
| `engine/src/util/process.ts` | launch | `Process.spawn`, used by LSP servers and installers: `ProcessIsolation.launch` (:81), then cross-spawn with `isolated.file`, `isolated.args` and `isolated.shell` (:82-84). Its `child_process` import is a type (F3). |
| `engine/src/cli/cmd/github.bundle.ts` | launch | The bundle's Git helper: `ProcessIsolation.launch` (:732), then `spawn(isolated.file, isolated.args)` (:734). |
| `engine/src/mcp/stdio.ts` | launch | Local MCP servers: `ProcessIsolation.launch` (:13), then the SDK's `StdioClientTransport` starts `isolated.file` with `isolated.args` (:14-16) (F4). |
| `core/src/pty/pty.bun.ts` | pty-backend | The bun-pty adapter behind `#pty`; only `core/src/pty.ts` loads it (:21), and it spawns after `ProcessIsolation.launch` (:241-242). |
| `core/src/pty/pty.node.ts` | pty-backend | The `@lydell/node-pty` adapter (a `createRequire` load, :12) behind `#pty`; same loader and decision. |
| `core/src/directory-identity.ts` | required-refusal | The fixed Python metadata reader: refuses while isolation is required at admission (:700) and right before `spawn` (:748-749). |
| `core/src/read-only-git.ts` | required-refusal | The fixed Python Git verifier: `requireValue(!ProcessIsolation.required())` at open (:1221) and right before `spawn` (:569-570). |
| `core/src/owned-process.ts` | fixed-helper | `groupEmpty` runs `/bin/ps -A -o pgid=,stat=` with `untrustedChildEnvironment` during an owned stop (:79); no caller input reaches its argv. |
| `core/src/pty/process.ts` | fixed-helper | `foreground` runs `ps -o tpgid= -p <pid>` for the PTY's own pid (:55), resolved through `PATH` with the engine's environment (F8). |
| `core/src/shell.ts` | fixed-helper | `killTree`'s Windows-only `taskkill /pid <pid> /f /t` (:38): a fixed argv, resolved through `PATH` and the working directory, with `untrustedChildEnvironment` (F7). |
| `core/src/config/managed.ts` | fixed-helper | Company-policy readers: `plutil`, `ls -lde`, `reg.exe` and `powershell.exe` at absolute paths with minimal environments (:312, :343, :410, :529). |
| `core/src/local-mode/hardware.ts` | fixed-helper | Vector Local's hardware read: `vm_stat` or `nvidia-smi` with fixed arguments, found with `which` outside the repository, with the engine's environment (:151) (F9). |
| `engine/src/lsp/launch.ts` | type-only | Uses the `ChildProcessWithoutNullStreams` type; starts servers through `Process.spawn` (:12). |
| `engine/src/lsp/server.ts` | type-only | Uses the same type; starts servers through `lsp/launch.ts` and `Process.spawn`. |
| `engine/src/tool/shell/windows-process.ts` | windows-holder | The Job Object holder (System32 `powershell.exe`, :182). Only `task/shells.ts` loads it (:23, used at :610), and `ShellJobs.start` refuses a Windows background command while isolation is required (`isolationRefusal` :96, called at :464). SPAWN-3 (the holder's own guard) is the review-fixes lane's. |
| `engine/src/cli/cmd/github.isolation.ts` | runner | The native adapter's control transport (:1116). Only `github.sandbox.ts` loads it; it runs as the runner in `vector github sandbox prepare` and `finish`. |
| `engine/src/cli/cmd/github.sandbox.ts` | runner | `vector github sandbox prepare|run|finish`, Linux-only. It sets up the sandbox and launches the agent as `vector-agent` (:800); the agent never runs this file. |
| `engine/src/cli/cmd/github.publish.ts` | runner | `vector github publish`, in the separate publish job after the agent job. It runs Git with hooks, helpers and credentials disabled (:309) (F6). |
| `engine/src/cli/cmd/ship.ts` | runner | The hidden `vector ship capture`, in Ship Desk's own job, which holds only a capture ticket (`captureEnvironmentProblem` :65, checked at :556). There it runs the repository's start command through `sh -c` (:212), Git (:270) and Chrome (:304), unisolated by design (F12). |
| `engine/src/cli/cmd/db.ts` | cli | `vector db` opens `sqlite3` on the person's local database (:39). |
| `engine/src/installation/standalone.ts` | cli | A Windows-only `cmd.exe` start of the upgrade or removal script (:227), from `vector upgrade`, `vector uninstall` or the app's upgrade request. A hosted agent runs only on Linux. |
| `engine/src/plugin/index.ts` | plugin-host | Hands `Bun.$` to server plugins (:201). External plugin code is refused while isolation is required (`assertExternalCodeAllowed`, :124-139), and the internal plugins never call it (F2). |
| `engine/src/mcp/index.ts` | url-opener | MCP OAuth opens the authorization URL (:1288), from `vector mcp auth` (`cli/cmd/mcp.ts:260`) or the app's MCP auth request (`handlers/mcp.ts:69`); no agent tool calls it. Its stdio import (:13) is a type; servers start through `mcp/stdio.ts` (:490). |
| `engine/src/plugin/snowflake-cortex.ts` | url-opener | The external-browser sign-in opens the authorize URL (:484) inside the auth method's `authorize` (:474), reached only from a person's provider sign-in: `ProviderAuth.authorize` (`provider/auth.ts:236`) from the provider authorize route (`handlers/provider.ts:115`), or `vector providers login` (`cli/cmd/providers.ts:101`). It is an internal plugin, so `assertExternalCodeAllowed` does not cover it; no agent tool reaches provider sign-in. |
| `engine/src/cli/cmd/web.ts` | url-opener | `vector web` opens the local UI (:75, :79). |
| `engine/src/cli/vector-account.ts` | url-opener | `vector login`, or the account gate on a person's first interactive run (`ensureVectorAccount`, called from `index.ts:164`, logs in at :438 and refuses without a TTY at :431), opens the approval page (:250). |
| `engine/src/cli/cmd/invite.ts` | url-opener | `vector invite --open` (:138). |
| `engine/src/mcp/sdk.ts` | re-export | Re-exports `StdioClientTransport` (:17) for `mcp/index.ts`'s `instanceof` check (:676); only `mcp/stdio.ts` constructs it (T9). |

Counts: launch 6, pty-backend 2, required-refusal 2, fixed-helper 5, type-only 2,
windows-holder 1, runner 4, cli 2, plugin-host 1, url-opener 5, re-export 1 (31).

### Search model

- Primitives. Process modules: `child_process` (with or without `node:`), `cross-spawn`,
  `bun-pty`, `node-pty` (with or without `@lydell/`), the MCP SDK's
  `client/stdio(.js)`, `open`, and Effect's platform index or `NodeServices`,
  `NodeContext` or `NodeChildProcessSpawner` subpath (node, bun or `-shared`). Bun's own:
  `Bun.spawn`, `Bun.spawnSync`, `Bun.$`, `Bun.openInEditor`, `Bun[...]`,
  `globalThis["Bun"]` (or `self`), and `const { ... } = Bun` (or `globalThis.Bun`,
  `self.Bun`), an import of `spawn`, `spawnSync`, `$` or `openInEditor`, a
  default import or a namespace import from `"bun"`, and any `NodeChildProcessSpawner` or
  `BunChildProcessSpawner` name.
- Run time versus types. `Bun.Transpiler` (`ts`, or `tsx` for `.tsx`/`.jsx`) erases
  comments, `import type`, `import { type X }` and `typeof import()`, and keeps value
  imports. The run-time labels are read from its output. A process module that matches
  only the raw text is a type-level reference, so a quoted module name in a comment fails
  closed; a Bun member access in a comment does not count.
- `open` and Effect's platform index count only in import positions (`from`, `import(`,
  `require(`), because `"open"` is a common event name and `core/src/effect/platform-node.ts`
  names the index in a comment.
- Effect `ChildProcess` users need no entry: they spawn through the `ChildProcessSpawner`
  service, which only `cross-spawn-spawner.ts` builds (T10), and no core or engine file
  imports a platform spawner layer (T2). At HEAD those users are 18 files
  (`owned-process.ts` imports types only):
  - core: `git.ts`, `process.ts`, `ripgrep.ts`, `ripgrep/binary.ts`, `tool/bash.ts`;
  - engine: `format/index.ts`, `git/index.ts`, `installation/index.ts`, `mcp/index.ts`,
    `project/project.ts`, `session/prompt.ts`, `snapshot/index.ts`, `task/shells.ts`,
    `tool/registry.ts`, `tool/shell.ts`, `tool/shell/windows-process.ts`,
    `tool/terminal.ts`, `worktree/index.ts`.
  That list comes from a search at HEAD and is not frozen by the test.
- Limits: a computed specifier (`import(name)`), aliasing beyond the patterns (a spawn
  function or module handed on as a value and called elsewhere, `Bun` bound to another
  name with `const B = Bun`, or a `createRequire(…)(…)` load followed by its calls), spawns
  inside dependencies, other packages, scripts and `entry.py` are not seen (F10, F11).
  T4 follows only the binding forms above; in a launch file that already reaches a
  process module, a start through an alias of that module is not seen. T4's call window
  is the text up to the first `)` or 160 characters after the call's name.

### Findings

- F1: `github.secrets.ts`, which the brief lists as a runner-side controller, starts no
  process. It imports no process module, and its only match is a comment ("Bun.spawn was
  given", :185). It is not in the table.
- F2: `plugin/index.ts` hands `Bun.$` to plugins; the brief's table missed it. It is
  justified as `plugin-host`. A search of `engine/src/plugin` found no `$` tagged
  template and no `input.$`. No change.
- F3: `util/process.ts` imports `child_process` for a type only and spawns through
  cross-spawn, so the brief's three patterns would have called a real launch site
  type-only. `cross-spawn` is a primitive.
- F4: MCP stdio servers start through the SDK's `StdioClientTransport`
  (`mcp/stdio.ts:11-20`), which no brief pattern sees. The SDK stdio specifier is a
  primitive; `mcp/sdk.ts` and `mcp/index.ts` follow from it.
- F5: the `open` package starts the operating system's URL opener in five files, all on
  a person's request. `open` is a primitive, matched in import positions only.
- F6: `github.publish.ts` runs in the publish job, so it is `runner`, not user CLI.
- F7: `cross-spawn-spawner.ts:523` `killGroup` runs `NodeChildProcess.exec` (a shell, a
  `PATH`-resolved `taskkill` and the engine's inherited environment) on Windows only.
  `shell.ts:38` also starts a bare `taskkill`, which libuv resolves through the working
  directory and `PATH`, though with `untrustedChildEnvironment`. Both run only for
  unisolated processes, because Windows refuses every launch while isolation is required.
  One follow-up for the review-fixes lane covers both: start
  `%SystemRoot%\System32\taskkill.exe` with `untrustedChildEnvironment` and no shell. Not
  fixed here (D54).
- F8: `pty/process.ts:55` runs a `PATH`-resolved `ps` with the engine's environment,
  unlike `owned-process.ts`. It is reached from the terminal tool's signal path
  (`engine/src/tool/terminal.ts:651`). It is a Hands PTY file, so it is recorded for the
  Hands lane and not fixed.
- F9: `hardware.ts:151` `execFile` inherits the engine's environment, and `which` finds
  the program through `PATH`. Minor; recorded.
- F10: spawns inside dependencies are not inventoried, matching the egress inventory's
  scope: `google-auth-library` (`build/src/auth/googleauth.js` and
  `pluggable-auth-handler.js` import `child_process`), reached through `GoogleAuth` at
  `core/src/plugin/provider/google-vertex.ts:45` and `engine/src/provider/provider.ts:806`;
  `@aws-sdk/credential-provider-process` (`credential_process`), through
  `fromNodeProviderChain` at `provider.ts:601` and `:625` and `amazon-bedrock.ts:100-101`;
  and `@npmcli/arborist`, at `npm.ts:159-179` with `ignoreScripts: true`. Deferred.
- F11: out of scope: other packages (desktop, app, cloud and the rest), scripts,
  `entry.py` (the Python root-side native entry), and `worker_threads`, which start no
  process.
- F12: `ship.ts` runs the repository's own start command, Git and Chrome unisolated by
  design. Its boundary is the credential-free job that `captureEnvironmentProblem`
  enforces before capture (no OIDC request, no run token, no `VECTOR_CLI_TOKEN`), not the
  agent sandbox. Recorded; no change.

### Evidence (local)

From `packages/engine`, one Bun workload at a time through the lock:

- `bun test --timeout 30000 test/spawn-inventory.test.ts`: 11 pass, 0 fail, 23
  `expect()` calls, before and after Prettier (after the review round, D55; it was 10
  pass and 22 calls before T11).
- `bun typecheck` (`tsgo --noEmit`): exit 0.
- Prettier 3.6.2 (`node_modules/.bin/prettier --write`, through the lock) rewrapped the
  test file; `git diff --check` is clean.
- Mutations, from `/tmp/vector-v2/native/nq4/mutate.sh`, all rerun with the eleven
  tests after the review round (`/tmp/vector-v2/native/nq4/mutate-review.log`). Each
  edits one source file, runs the test file once, then restores it from
  `/tmp/vector-v2/native/nq4/saved` and checks it with `cmp`; every one was restored:
  - M1, `import { spawn as probe } from "node:child_process"` plus an export appended to
    the unlisted `engine/src/util/error.ts` (the brief's synthetic unlisted import): T2
    fails, naming `packages/engine/src/util/error.ts child_process` (10 pass, 1 fail);
  - M2, `untrusted-git.ts` starts `git` instead of `isolated.file`: T4 fails (10/1);
  - M3, every `ProcessIsolation.required()` in `read-only-git.ts` replaced by `false`: T5
    fails (10/1);
  - M4, `export { spawn as ptySpawn } from "./pty.bun"` appended to `pty/process.ts`: T6
    fails (10/1);
  - M5, `lsp/launch.ts:1` `import type` changed to a value import: T3 fails (10/1); the
    transpiler keeps a value import even when only types use it. M5b, a real
    `child_process` value import added there: T3 fails (10/1);
  - M6, the comment `// Bun.spawn(["x"])` appended to `util/error.ts`: 11 pass;
  - M7, `import { NodeServices } from "@effect/platform-node"` plus a use appended to
    `util/error.ts`: T2 fails, naming `effect-platform` (10/1);
  - M8, `ChildProcessSpawner.of(...)` appended to `core/src/process.ts`: T10 fails (10/1);
  - M9, `util/process.ts` passes `shell: opts.shell` instead of `isolated.shell`: T4 fails
    (10/1);
  - M10, `export const probe = () => Bun.spawn(["git"])` appended to `untrusted-git.ts`
    (the review's example; before D55 it passed all ten tests, per the review and by
    reading the old T4, which saw only calls through imported names): T4 fails, naming
    `packages/core/src/untrusted-git.ts Bun.spawn primitive` (10/1);
  - M11, `import cp from "node:child_process"` and a `cp.exec("x")` call appended to
    `untrusted-git.ts`: T4 fails, naming `cp.exec("x"` (10/1);
  - M12, an inline `require("node:child_process").exec("x")` appended to `ocr.ts`: T4
    fails (10/1);
  - M13, an inline `(await import("node:child_process")).exec("x")` appended to
    `github.bundle.ts`: T4 fails (10/1);
  - M14, `const { spawn: probe } = globalThis.Bun` and a call appended to the unlisted
    `util/error.ts`: T2 fails, naming `packages/engine/src/util/error.ts Bun[]` (10/1).
- Plan-step probes (`/tmp/vector-v2/native/nq4/*-probe.ts`) only read sources and use
  `Bun.Transpiler`; no production code ran.

### Deferred

- `test.yml` at the lane end runs the file in the engine shards (Linux and Windows); it is
  platform-neutral and needs no network or process.
- F7 (with `shell.ts:38`) and SPAWN-3 for the review-fixes lane; F8 for the Hands lane;
  F10 (dependency-internal spawns).
- The `native-guard-unit.yml` and `typecheck.yml` run IDs that follow the NQ-4 push are
  in the commit step's report; a later package records them from the API (D56).

### Deviations and decisions

- D46. Citations are at `f05f9916`. The brief's `0ee486e3` line numbers still hold for
  every cited file except `github.isolation.ts`, whose spawn is cited at its HEAD line.
- D47 (brief's table corrected; critique accepted for `ship.ts`). The primitive set adds
  cross-spawn, the MCP SDK stdio transport, `open` in import positions, Effect's platform
  spawners, `Bun.openInEditor`, computed or destructured `Bun` access and imports from
  `"bun"` (F3-F5). The table has 31 entries, not the brief's 24: `github.secrets.ts` is
  dropped (F1), and `plugin/index.ts`, `mcp/stdio.ts`, `mcp/sdk.ts`, `mcp/index.ts`,
  `snowflake-cortex.ts`, `web.ts`, `vector-account.ts` and `invite.ts` are added, with the
  new stances `plugin-host`, `url-opener` and `re-export`. `github.publish.ts` (F6) and
  `ship.ts` (F12) are `runner`, not `cli`: both run in their own CI job, and `runner` is
  defined to cover that job, not only the agent job.
- D48 (critique accepted, both major points). `launch` is defined by what the decision
  returns today, and the notes and addendum say that no site is isolated today and that
  principle 5 holds for 8 of the 31 entries. The Effect platform index and
  `NodeServices`/`NodeContext`/`NodeChildProcessSpawner` subpaths are primitives, and T10
  pins `cross-spawn-spawner.ts` as the only builder of the spawner service. Departure
  from the critique: the platform specifiers count in import positions only, because
  `core/src/effect/platform-node.ts` names the index in a comment and would otherwise need
  an entry; an `import type` from it still counts as a type-level reference. The 18
  Effect `ChildProcess` users are listed in the search model, not the critique's nine.
- D49 (critique accepted). T4 requires `isolated.file` with `isolated.args` as the next
  argument (or `command:`/`args:` for the SDK transport) and rejects a `shell:` other than
  `isolated.shell` or `false` in the call window. One listed helper call is exempt (F7),
  and the exemption fails when stale. The brief's "contains `ProcessIsolation.`" is
  replaced by a call of `launch(` or `commandPlan(`.
- D50. Run-time references come from `Bun.Transpiler` output and type-level ones from the
  raw text (search model). T1 keeps one run-time case per primitive and a few type-only
  and negative cases (26 plus one `.tsx` when this entry was written, 28 after D55), per
  the critique's scope point. `INVENTORY` and
  `HELPER_CALLS` use `as const` (with `satisfies` and a small `Stance` union) instead of
  explicit annotations.
- D51. Reachability checks beyond the brief: T6 (PTY backends only through `pty.ts`), T7
  (the holder only through ShellJobs, and ShellJobs still asks the refusal), T9 (the MCP
  stdio transport only in `mcp/stdio.ts`) and T10.
- D52 (critique accepted). The NQ-3 dispatch-log row is filled here, as D45 allows, with
  API and log facts only. The one comparison sentence is a plain string comparison with
  the NQ-3 table; NQ-5 interprets the row.
- D53. `native-isolation-status.md` and `process-ownership-followup.md` are unchanged,
  because no isolation behaviour or ownership contract changes (as in D37).
  `v2-spawn-review.md` gains a dated addendum only.
- D54 (critique accepted for the grouping). F7 and `shell.ts:38` are one review-fixes
  follow-up, not fixed here: the spawner is the hot spot, and both changes are
  Windows-only behaviour that cannot be checked locally. F8 is a Hands PTY file. F9 and
  F12 are recorded. F10 is deferred. The NQ-4 package row reads "Implemented, uncommitted"
  until the commit step, as in D44.
- D55 (review round one; all five non-blocking findings accepted). T4 was weaker than its
  title: it saw only calls through named or namespace imports and destructured
  `require`/`import()`, so a default-import member call (`cp.exec`), a `const`-bound
  `require` or `await import`, an inline `require(…).exec(…)` and any `Bun.spawn`,
  `Bun.spawnSync` or `Bun.$` in a launch file passed (the review found that appending
  `Bun.spawn(["git"])` to `untrusted-git.ts` left all ten tests green). Now `imported` binds a default as `name`
  and `name.`, `directCalls` follows `const`-bound `require`/`import()` and inline member
  calls, and T4 counts every run-time primitive outside the six traced process modules as
  unplanned (`unplannedCalls`). That covers the Bun-native set the review named, and
  Effect's platform layers too; the alternative of pinning each launch entry's label set
  was not taken, because a pin would let a reviewed Bun spawn through without a planned
  or helper-call check. T11 unit-checks each form, and M10-M14 show the gaps closed. The
  `Bun[]` pattern also matches a destructure from `globalThis.Bun` or `self.Bun` and a
  `globalThis["Bun"]` access, with two T1 cases. T1's count was 26, not 27 as recorded;
  it is now 28. The `vector-account.ts` reason names the startup account gate as well as
  `vector login`; the review cited :430 and :437, and the HEAD lines are :431 (the TTY
  refusal) and :438 (`login()`). The search model's limits now name the aliasing forms
  T4 still misses, and the spawn review addendum is worded to the check.
- D56 (commit step). The commit stages only this test file, `native-qualify-notes.md`
  and `v2-spawn-review.md`, and dispatches nothing native. The package-table row reads
  "Committed" in the NQ-4 commit itself, as in D45. Before the push, the commit step
  reran the test file (11 pass, 0 fail), the engine `bun typecheck` and the full
  `bun turbo typecheck --concurrency=2` with `TURBO_CACHE_DIR` inside the worktree.

## NQ-5, 15 November 2026

All citations are at the lane head `b861736d` before this change (D57).

### Precondition

- The newest completed `native-shell.yml` run on `native-qualify` is 43675930370 (job
  `132695971881`, head `f05f9916`), recorded in the dispatch log by NQ-4. Its entry
  stage `prepare-mask-host-temp-keeper-search` is row 1 of the NQ-3 interpretation table,
  so the brief's precondition is met. NQ-1's run 43660129312 (job `132647364562`, head
  `597dbcc9`) closed with the brief's alternative precondition,
  `...-bwrap-destination-host-temp-eacces-...`. No native run was in progress when this
  package was planned or implemented.
- What each row proves is split in D58: hosted evidence on one side, code reading on the
  other.

### What landed

Phase 5a (Python), then phase 5b (TypeScript and fixtures), as one working-tree change
(D68):

- `packages/core/src/process-isolation/linux/entry.py`:
  - `RUNNER_HOME = "/home/runner"` replaces `HOST_TEMP`, which is dropped because nothing
    in `entry.py` would use it (D60). `MASKS` is
    `("/home/vector-agent", "/tmp", "/var/tmp", "/run", RUNNER_HOME)`, and `RUNNER_HOME`
    takes `HOST_TEMP`'s index 4. So the keeper argv (it iterates `MASKS`), the per-command
    bwrap, `mask_records`, `validate_masks`, cleanup and every index-aligned copy keep
    their order.
  - `validate_spec` requires that no mask hides the container, stage, scratch, directory
    or socket (D64).
  - `keeper_destination_stage` names `("runner-home", b"/home/runner")` in place of the
    hosted temporary target. `keeper_failure_stage` accepts `bwrap-destination-runner-home`
    and its six causes in place of the `host-temp` ones (D59).
  - `supported_mask_sources`:
    - `prepare-mask-runner-identity` also requires `runner.pw_dir == RUNNER_HOME` (D62);
    - the labels dict maps `RUNNER_HOME` to `runner-home`;
    - the `elif target == RUNNER_HOME` branch keeps the former hosted temporary body: the
      runner uid owns it (`target-owner`), with no group or other write (`target-mode`);
    - every mask parent must now be Root-owned (`parent-owner`, D61).
    Mount-present, mount-device, `pin_source`, `source_record`, the origins pass
    (`hidden()` over the new `MASKS` enumerates and pins nested mounts beneath
    `/home/runner`), `require_capture_closure`, `refuse_mask_aliases`,
    `validate_source_view` and the keeper-search pass are unchanged. Nothing runs
    `chmod` or `chown`, and nothing adds a stage shape or a function.
- `packages/core/test/fixture/native-mask-origins.py` (CI-only, 40 to 45 tests):
  - `CONSTANTS` is `{"CONTAINERS", "RUNNER_HOME", "MASKS"}`, so 26 + 3 definitions are
    selected;
  - the destination and keeper-log tables use `runner-home`;
  - `FRAGMENTS`/`fragment()` compile exactly four guarded statements of
    `supported_mask_sources` on synthetic metadata (D63);
  - the allowlist test now lists those fragments;
  - the edited destination, failure-stage and mask-product tests;
  - the new `RunnerHomeMaskTests` class (5 tests).
- `packages/core/src/process-isolation/linux.ts`:
  - exports `RUNNER_HOME`;
  - `MASKS` ends with `RUNNER_HOME`;
  - `HOST_TEMP` stays for `hostedTemporary` (RUNNER_TEMP equality);
  - a private `masked()` serves `parseMaskProof` and `assertUnmaskedRuntime`;
  - `parseSpec` refuses a published path under any mask.
  Signatures are unchanged.
- `packages/engine/src/cli/cmd/github.isolation.ts`:
  - `FAILURE_STAGES` uses `runner-home` for the mask list, the `target-mode` condition
    and the destination targets;
  - the control-side `mask_proof` validator's `parents` tuple ends with `/home/runner`.
- CI fixtures:
  - `native-shell-payload.ts`:
    - `CANARY_ROOTS` is `MASKS`, then `HOST_TEMP`, then the four agent-home roots;
    - canaries beneath the runner home must be exactly `ENOENT`, both directly and through
      `/proc/self/root`;
    - `mkdir` of `/home/runner/work` must be `EROFS` (D65).
  - `native-shell-host.ts`:
    - `OBSERVE` `MASKS` ends with `/home/runner`;
    - `CANARIES` adds `/home/runner/work/_temp`;
    - Root reads the `HOSTED` canaries before the privilege drop;
    - `controls` returns `readableCanaries`, `rootCanaries` and `dacWritableControl`
      (D65).
  - `native-shell-ci/manage.ts` seeds a Root-owned `0444` canary in `/home/runner`. No
    runner path changes mode or owner.
  - `native-shell-ci/policy.test.ts` adds a 4th test.
- Bun tests:
  - `process-isolation-linux.test.ts` (17 to 18);
  - `github.isolation.test.ts` (33 to 34, including the agreement test, D67).

### Mask geometry and proof obligations

`MASKS` = `/home/vector-agent`, `/tmp`, `/var/tmp`, `/run`, `/home/runner`, each built as
`--tmpfs T --remount-ro T` in that order. The fixed `RUNNER_TEMP` `/home/runner/work/_temp`
is no longer a mask root; it is hidden beneath `/home/runner`. Coverage is a superset
of the former list: every former root is still hidden, and the mask now also hides every
other runner-home path (the runner install and diagnostic trees, `~/.bun`, tool caches and
the synthetic CI workspace `/home/runner/work/vector-native-shell-checkout`, whose
checkout prepare moves into the container stage with `rename(2)` before the native
prepare starts, leaving a placeholder; `github.sandbox.ts:467-468`).

The source enforces these obligations at admission:

- Runner home: a canonical directory (`lstat`, `S_ISDIR`, `realpath` equality) owned by
  the runner uid, with no group or other write. The `runner` account's `pw_dir` must be
  exactly `/home/runner`.
- Every mask parent, including `/home` and `/`: canonical, a directory, Root-owned, with
  no group or other write. After every other predicate, each parent must also be
  keeper-searchable.
- Each mask root's mount is present, descriptor-pinned and on the recorded device.
- Nested mounts beneath any mask, `/home/runner` included, are pinned as origins.
  `require_capture_closure`, `refuse_mask_aliases` and `validate_source_view` are
  unchanged.
- No published container, stage, scratch, directory or socket path lies under a mask
  (`validate_spec` and `parseSpec`).

At construction, `validate_masks` checks each mask twice as a live, read-only, empty,
keeper-owned `0755` tmpfs (unchanged).

At run time, `run()` refuses any engine or runtime beneath a mask, now including
`/home/runner` (D66).

These CI witness obligations stay open until a hosted run passes prepare:

- the runner-home canaries are exactly `ENOENT` through the mask;
- `/home/runner/work` cannot be rebuilt (`EROFS`);
- Root reads both hosted seeds before the privilege drop.

### Counts

| Item | Before | After |
| --- | --- | --- |
| Mask admission product (`entry.py`) | 73 | 73 |
| TypeScript per-mask entries | 62 | 62 |
| Keeper logs / stages | 97 / 582 | 97 / 582 |
| Python fixture tests (CI) | 40 | 45 |
| `github.isolation.test.ts` | 33 pass, 2964 `expect()` | 34 pass, 2989 `expect()` |
| `process-isolation-linux.test.ts` | 17 | 18 pass, 274 `expect()` |
| `native-shell-ci/policy.test.ts` | 3 pass, 33 `expect()` (CI step 7) | 4 pass, 58 `expect()` |

### Expected hosted outcome for NQ-6 to verify

A prediction from code reading, not a result (D71):

- Guard-unit prints `Ran 45 tests` ... `OK`. In the native job, the control policy has
  4 pass and the pure Python step prints `Ran 45 tests` ... `OK`. Compile, install,
  workspace and both metadata preflights pass.
- Mask admission passes:
  - `prepare-mask-runner-identity` holds the runner's `pw_dir`;
  - `/home/runner` is runner-owned without group or other write;
  - `/home` and `/` are Root-owned `0755`;
  - the `home` mask's ancestor checks already passed on the same `/home` and `/` in
    NQ-3.
- `prepare-images` and `prepare-keeper-search-checkout` pass, and bwrap builds the
  `/home/runner` tmpfs.
- Every label after that point is open.

| Label seen | Meaning | Action |
| --- | --- | --- |
| `prepare-mask-runner-identity` | NQ-3 passed this stage with the uid conditions alone, so the `pw_dir` binding refused (D62) | Root-cause it; never widen the binding without a reviewed reason |
| `prepare-mask-runner-home-target-owner` / `-target-mode` | Runner-home ownership or mode refused | Root-cause it; never `chmod` or `chown` |
| `prepare-mask-<label>-parent-owner` | The Root-only tightening (D61) refused a parent | Root-cause it |
| `prepare-mask-runner-home-keeper-search` | Contradicts NQ-3 (the same `/home` and `/` passed for `home`) | Root-cause it |
| `prepare-mask-origins` / `prepare-mask-aliases` | A nested mount or alias beneath `/home/runner` | Record it; design separately, with no weakening |
| `prepare-keeper-search-checkout` | The container ancestry blocks the keeper | Design separately |
| `...-bwrap-destination-runner-home-*` | The admission model missed a denial | Root-cause it |
| `...-bwrap-destination-info-*` on the mask step | An unknown destination, for example the former hosted temporary path | Root-cause it |
| A refusal after prepare passed, in the mask-source re-check (`validate_source_view` or `validate_masks`, reached in the host or finish step, for example through the control `inspect` operation's `live-client` check) | `validate_source_view` re-checks each root record with `source_record(...) == record`, which includes mode, uid and gid. `/home/runner` is now a root record and the runner owns it, so a runner-owned step that changed `$HOME`'s mode or owner after prepare makes validation refuse. The runner-owned `_temp` root had the same exposure, but no earlier run passed prepare, so it was never observed | Record it and root-cause it; never widen the check |
| Any later keeper, broker or publish label, or prepare success with a host-step failure | | NQ-6 |
| Transport-only cause | A vocabulary mismatch (D9) | Fix the vocabulary |

### Evidence (local)

From the worktree, one Bun workload at a time through the lock:

- Both Python sources parse with `ast.parse` (`python3 -I -S -B`). The fixture was not
  executed locally, and neither were `entry.py` or any extracted function (the D13
  rule).
- Supplementary, AST-only: `/tmp/vector-v2/native/nq5/static-check.py` passed 49 checks.
  It never imports, compiles or executes `entry.py` or the fixture. It covers:
  - `MASKS`, `RUNNER_HOME` and no top-level `HOST_TEMP`;
  - the destination targets literal (with targets 1-5 equal to `MASKS`);
  - the 97 accepted keeper logs with no `host-temp`;
  - the 73-stage mask product with no `host-temp`;
  - the fixture's 29 selected definitions and constant shapes;
  - each of the 4 fragments, which matches exactly once with the allowed calls, names
    and shape, and the `target-owner` branch tests;
  - 45 unique test names;
  - a coarse unbound-name scan of the fixture;
  - `SimpleNamespace` as the only named import;
  - every `prepare-mask-` string in the new class is a product stage;
  - the host `OBSERVE` script parses.
- From `packages/core`: `bun test --timeout 30000 test/process-isolation-linux.test.ts`
  gives 18 pass, 0 fail, 274 `expect()` calls (286 before the review fixes, D73).
- From `packages/engine`:
  - `test/cli/github.isolation.test.ts` gives 34 pass, 0 fail, 2989 `expect()` calls
    (2987 before the review fixes, D73);
  - `test/fixture/native-shell-ci/policy.test.ts` gives 4 pass, 0 fail, 58 `expect()`
    calls.
  All three files were re-run after Prettier and the mutations, with the same results.
- `bun typecheck` passes in `packages/core` and `packages/engine` (`tsgo --noEmit`).
- Prettier reformatted `github.isolation.test.ts` and `native-shell-payload.ts` and
  reported the other six TypeScript files unchanged. `git diff --check` is clean.
- Mutations, from `/tmp/vector-v2/native/nq5/mutate.sh`. Each was run once, then
  restored from `/tmp/vector-v2/native/nq5/current` and checked with `cmp`:
  - M1, the control `parents` tuple back to `/home/runner/work/_temp`: 33 pass, 1 fail
    (the agreement test);
  - M2, `entry.py` `MASKS` ending with `"/home/runner/work/_temp"`: 33 pass, 1 fail (the
    agreement test);
  - M3, `runner-home` dropped from the `FAILURE_STAGES` mask list: 31 pass, 3 fail (mask
    stage projection, keeper-search stages, and the source-agreement test);
  - M4, `/var/lib` appended to the TypeScript `MASKS`:
    - `process-isolation-linux.test.ts` 14 pass, 4 fail (hidden roots, the new spec-path
      test, and the two proof-target tests);
    - `policy.test.ts` 3 pass, 1 fail (the new test). The `parseSpec` check fires (D64).
  - M5, the TypeScript `MASKS` back to `HOST_TEMP`:
    - `process-isolation-linux.test.ts` 16 pass, 2 fail (hidden roots, proof targets);
    - `github.isolation.test.ts` 33 pass, 1 fail (the agreement test).
  - After the review fixes (D73), from `/tmp/vector-v2/native/nq5/review`, each restored
    and checked with `cmp`:
    - M6, `/home/runner` dropped from the `manage.ts` seed list: `github.isolation.test.ts`
      33 pass, 1 fail (the agreement test);
    - M4 again, against the renamed spec test: `process-isolation-linux.test.ts` 14 pass,
      4 fail (the same four tests).
- Tooling notes (D72).

### Deferred

- The 45-test fixture and the hosted label run only in CI: guard-unit, then the single
  diagnostic-cell dispatch by the commit step. NQ-6 reads the result.
- Commit-step gate (D73): the 5 new `RunnerHomeMaskTests` and the edited destination and
  failure-stage fixture tests have never run, because the rules forbid running the fixture
  locally. The commit step waits until the automatic `native-guard-unit.yml` run at the
  pushed head prints `Ran 45 tests` ... `OK`, then makes the single `diagnostic_cell`
  dispatch, and records the guard-unit run and job IDs in the NQ-5 dispatch-log row. If
  guard-unit is red, it fixes the cause in a follow-up commit and does not dispatch.
- Which of `/home/runner` and `/home/runner/work` blocked the keeper stays unproven
  (D34). The runner-home mask does not depend on it.
- Commit, push, the guard-unit and typecheck gate, the dispatch and the NQ-5
  dispatch-log row belong to the commit step.

### Deviations and decisions

- D57. Line drift: NQ-1 and NQ-3 grew `entry.py`, so the brief's `0ee486e3` lines moved
  (for example `validate_spec` 106, `keeper_destination_stage` 916, `keeper_failure_stage`
  1043, `supported_mask_sources` 1395, the keeper argv 1730-1745). The brief's "CLIENT
  `mask_proof` `parents` tuple at `github.isolation.ts:666`" is the control-side
  `mask_proof` validator (line 675 at `b861736d`), which validates CLIENT output.
- D58 (critique accepted: NQ-1 is cited next to NQ-3). Interpretation of the two rows:
  - Hosted evidence:
    - NQ-3's label is an admission-time refusal on the hosted temporary mask's parents.
    - NQ-1's label names the fifth mask's destination with `EACCES`. Bubblewrap applies
      its setup operations in argv order (code reading of v0.9.0) and stops at the first
      fatal error, so the four earlier `--tmpfs`/`--remount-ro` masks over Root-owned,
      unmapped host directories did not die. That supports building a tmpfs on
      `/home/runner` through Root-owned `/home`.
  - Code reading: the keeper-search pass runs over `searches` in `MASKS` order. So the
    refusal at `host-temp` means the `home`, `tmp`, `var-tmp` and `run` ancestors (`/`,
    `/home`, `/var`) passed it.
  - The workflow sets `continue-on-error: true` on the finish step (`native-shell.yml`).
    That is why the API reports step 17 as `success` while `steps.finish.outcome` is
    `failure` (the fourth `manage.mjs assert` argument). This closes D38's open point.
- D59. Both `host-temp` families are removed where they no longer exist, consistently in
  `entry.py`, the fixture and `FAILURE_STAGES`:
  - the 13 `prepare-mask-host-temp-*` stages;
  - `bwrap-destination-host-temp`;
  - its 6 causes.
  The `runner-home` families replace each in place, so every product count is unchanged.
  A hosted line naming `/home/runner/work/_temp` now classifies as the generic
  `bwrap-destination`, which fails closed. The fixture and the Bun tests refuse the
  removed labels, including NQ-1's and NQ-3's observed ones.
- D60 (critique accepted). `HOST_TEMP` is dropped from `entry.py` and from the fixture
  `CONSTANTS`, because after the change `MASKS`, the labels and the `target-owner` branch
  all use `RUNNER_HOME`. The brief's "`HOST_TEMP` stays for hostedTemporary/RUNNER_TEMP
  equality" is the TypeScript `hostedTemporary` (`linux.ts`), where it stays, as it does
  in the payload and host fixtures. This answers NQ-3's deferred question: the covered
  hosted temporary mask is replaced by its ancestor, not kept beside it, and no hidden
  ancestor is exempted from keeper-search. No mask is dropped; the root moved up one
  covered level.
- D61. Every mask parent must now be Root-owned (`require(item.st_uid == 0)`). This goes
  beyond the brief's `/home` wording and is stricter: the former rule admitted the runner
  only because `/home/runner` and `/home/runner/work` were parents of the hosted
  temporary root. It supersedes D32's statement that "the parent-owner predicate admits
  only Root or the runner". The `keeper_searchable` capability override becomes even less
  reachable from admission and is still exercised only by the helper tests.
- D62 (critique's optional point taken). The runner-home owner check stays uid-only, as it
  was for the hosted temporary root. `prepare-mask-runner-identity` now also requires
  `runner.pw_dir == RUNNER_HOME`, which binds the literal to the account it hides,
  without a new stage. NQ-3's run passed this stage with the two uid conditions, so a
  hosted refusal there would name the binding alone (interpretation table).
- D63 (critique's major point accepted). The fixture runs four fixed guarded statements of
  the non-pure `supported_mask_sources` instead of extracting a single-use helper into
  production. They are `runner-identity`, the `target-owner` `if/elif/else`, and
  `parent-owner` and `parent-mode`, each run with its stage assignment. Each is found by
  an exact AST match of its stage assignment and must be unique. Before compiling, each is
  checked to call only `require` (with `integer` for `runner-identity`), to use only
  allowlisted names and to contain only `Assign`, `Expr` and `If` statements. It runs on
  `SimpleNamespace` metadata, so no `lstat`, `realpath`, pin or mount call is reached.
  `test_only_allowlisted_pure_definitions_are_executed` now pins the fragment list and
  each one's call and name sets against the existing forbidden set. The matrices keep to
  the brief's cases: runner-owned admitted; group or other write, Root, keeper or foreign
  owner refused; runner- or keeper-owned parents refused; unchanged `home` and `tmp`
  branches. One deviation from the plan: `runner-identity` is a fourth fragment, for D62.
- D64. The spec-path invariant cannot be reached today for the three fixed `CONTAINERS`.
  It binds the invariant on both sides, and M4 shows that the TypeScript `parseSpec`
  check fires. The refusal itself is covered only by that mutation: no test input reaches
  it, because every `CONTAINERS` entry passes `container()` and lies outside the masks.
  The test is named as a reachability guard, "every fixed container spec parses and stays
  outside every mask" (D73).
- D65. A latent host-controls defect is fixed. The `_temp` canary would have refused
  step 16 as soon as prepare passed, because the agent cannot search `/home/runner` or
  `/home/runner/work` (D34; which of the two is unproven).
  Root now reads the `HOSTED` canaries (`/home/runner` and `/home/runner/work/_temp`)
  before the privilege drop, and the TypeScript side requires both counts.
  - Critique accepted: beneath the runner home, the direct and `/proc/self/root` reads
    must be exactly `ENOENT`, because `EACCES` would mean host DAC hid the canary instead
    of the mask. Only `/proc/1/root` keeps the permissive set.
  - `mkdir` of `/home/runner/work` (direct and `/proc/self/root`) must be `EROFS`.
- D66. `run()`'s `assertUnmaskedRuntime(node/binary)` (`github.sandbox.ts:680-681`, native
  intent only) now refuses any runtime beneath `/home/runner`, for example setup-bun's
  `~/.bun`. That is stricter. The native CI fixture runs only its `/usr/libexec` copies
  (`native-shell.yml` 124-128), and the new policy test pins them as unmasked. The
  hosted `run()` case in `github.isolation.test.ts` refuses at `fromBuild` before
  `assertUnmaskedRuntime`, so a `test.yml` `process.execPath` beneath `~/.bun` does not
  change it.
- D67 (critique accepted for scope). The agreement test checks only the copies that
  cannot import `LinuxIsolation`:
  - `entry.py`'s `MASKS` and `RUNNER_HOME`, and that it has no `HOST_TEMP`;
  - the control `parents` tuple;
  - the host `OBSERVE` `MASKS` and `CANARIES`, against `CANARY_ROOTS`;
  - the `HOSTED` expression;
  - that the runner-home subset is exactly `[RUNNER_HOME, HOST_TEMP]`.
  The review fixes (D73) add the `manage.ts` `manifest`-branch seed list, with `TEMP`
  taken from `common.ts`, against `CANARY_ROOTS` in order. The kept mutations M1, M2, M4,
  M5 and M6 prove the test and the `parseSpec` check; M3 was cheap and is kept too.
- D68. The package is one implement step in two ordered phases (5a Python, 5b
  TypeScript), and there is one commit. A 5a-only commit would make the Python and
  TypeScript mask lists disagree, which the brief forbids, and the agreement test would
  fail.
- D69. `v2-spawn-review.md`, `process-ownership-followup.md` and `native-shell.yml` are
  unchanged. No spawn hot-spot file or ownership contract is touched, and the job `if`
  already allows `native-qualify`.
- D70. The NQ-4 row records its two gate runs from `get_workflow_run` (see the dispatch
  log).
- D71. The expected hosted outcome above is a prediction only. Nothing here qualifies
  native isolation. Both native build switches and `FLOOR` stay false, native plus
  `OwnedProcess` stays refused (`cross-spawn-spawner.ts:405-411`), and the §4.4 and §6
  Q2/Q3 decisions stay open and owner-gated.
- D72. Tooling notes:
  - A `pyflakes` run over the fixture, from a scratch install, was denied by the
    permission system. It was not retried, and the scratch install was removed. The
    AST-only `static-check.py` covers unbound names instead, coarsely.
  - One `bun test` invocation from the worktree root was refused by the repository's
    `do-not-run-tests-from-root` guard, so no test ran. Every recorded run is from a
    package directory.
- D73 (review round one; every finding accepted, none disputed). Uncommitted, like the
  rest of NQ-5:
  - The agreement test in `github.isolation.test.ts` now also reads the `manage.ts`
    seed list in the `manifest` branch and requires it to equal `CANARY_ROOTS` in order,
    with `TEMP` from `common.ts` (two findings, one fix; it closes D67's deferral).
    `manage.ts` keeps its literal list, because importing `native-shell-payload.ts` would
    change the separately bundled management entry (`native-shell.yml:65`) and pull
    `LinuxIsolation` into it. M6 proves the check.
  - The `entry.py` `RUNNER_HOME` comment no longer states as fact that the keeper cannot
    search the runner-owned ancestors. It says at least one of them could not be
    searched, and cites run 43675930370 and `prepare-mask-host-temp-keeper-search`. D65
    now names `/home/runner` or `/home/runner/work` (D34). The `linux.ts` `HOST_TEMP`
    comment states the admission requirement, not a hosted fact.
  - The spec-path test in `process-isolation-linux.test.ts` is renamed "every fixed
    container spec parses and stays outside every mask", is commented as a reachability
    guard, and drops its repeated `assertUnmaskedRuntime` loop: 286 to 274 `expect()`
    calls, the same 18 tests. D64 records that only M4 covers the refusal.
  - The interpretation table gains a row for a refusal after prepare in the mask-source
    re-check, which can mean that a runner-owned step changed `/home/runner`'s mode or
    owner. The status section names the same fail-closed exposure.
  - The commit-step gate on guard-unit before the single dispatch is written under
    Deferred.
  - Re-run: both Python files parse; `static-check.py` passes 49 checks;
    `process-isolation-linux.test.ts` 18 pass, 274 `expect()`;
    `github.isolation.test.ts` 34 pass, 2989 `expect()`; `policy.test.ts` 4 pass, 58
    `expect()`; `bun typecheck` passes in `packages/core` and `packages/engine`; Prettier
    reports the three edited TypeScript files unchanged.
- D74 (commit step). The commit stages only the twelve NQ-5 paths: `entry.py`,
  `linux.ts`, `github.isolation.ts`, the Python fixture, the two Bun test files, the four
  native-shell fixtures, `native-isolation-status.md` and this file. The package-table
  row reads "Committed" in the NQ-5 commit itself, as in D45, and the NQ-5 dispatch-log
  row stays pending: the commit step's report carries the guard-unit and typecheck run
  IDs and the native run ID, and NQ-6 fills the row from the API. Before the push, the
  commit step re-parsed both Python files with `ast.parse`, reran the three Bun test files
  one at a time (`process-isolation-linux.test.ts` 18 pass, 274 `expect()`;
  `github.isolation.test.ts` 34 pass, 2989 `expect()`; `policy.test.ts` 4 pass, 58
  `expect()`), ran `bun typecheck` in `packages/core` and `packages/engine`, and ran the
  full `bun turbo typecheck --concurrency=2` with `TURBO_CACHE_DIR` inside the worktree
  (27 of 27 tasks). The single `diagnostic_cell` dispatch follows the guard-unit gate
  written under Deferred.
