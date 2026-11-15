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
  `43619796230`.
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
| NQ-3 | Refuse at admission any mask whose ancestors the keeper cannot search | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-4 | Inventory direct process spawn sites and their isolation stance | None (typecheck; test.yml at the lane end) | Planned |
| NQ-5 | Mask the runner home instead of its unreachable temporary leaf | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-6 | Native baseline cell follow-up A | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-7 | Native baseline follow-up B and the full matrix | Exactly one: the diagnostic cell, or `{"diagnostic_cell": false}` (eight cells) only if the diagnostic cell is green with the `owned` refusal case. Any full-matrix spend beyond that one bounded dispatch is owner-gated. | Planned |
| NQ-8 | Close the lane's native qualification and spawn-review records | None (typecheck) | Planned |

## Dispatch log

| Package | Run | Job | Head | Inputs | Closed label | Step results |
| --- | --- | --- | --- | --- | --- | --- |
| NQ-1 | [43660129312](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660129312) (`workflow_dispatch`, attempt 1, failure) | `132647364562` `Shell seam (bun, own-key, baseline)`, `ubuntu-24.04` | `597dbcc922b44a0e53e0c311cbe416b26cdf6252` | `{"diagnostic_cell": true}` (the run has this single job) | `prepare-keeper-child-exit-log-bwrap-destination-host-temp-eacces-info-child-created` (entry `CalledProcessError` exit 1; control `native-prepare` `CalledProcessError` exit 125; transport `close` `ChildExit` exit 1) | Gate: guard-unit [43660083062](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660083062) passed at the same head (typecheck [43660085781](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43660085781) passed too). Steps 1-12 passed: control policy (3 pass, 0 fail, 33 `expect()` calls), pure Python (`Ran 35 tests` ... `OK`), compile, install, workspace and both Node/Bun metadata preflights (`readerSHA256` `c8283da6fea8a33adb803d7004f0b3508535a27ebbf96912e4af90c2f3dcdba8`, `sourceRevision` the head above). Step 13 "Actual native prepare without SUDO mode or diagnostic profile" failed (exit 125). Steps 14-16 (seed, verify, lifecycle witness) were skipped. Step 17 "Always finish the exact owned native operation; missing state is refused" printed `cleanup-proof` (entry `RuntimeError`; control `native-cleanup` exit 125) and reports conclusion `success` in the API. Step 18 "Preserve every earlier failure and cleanup uncertainty" ran `manage.mjs assert 'success' 'failure' 'skipped' 'failure'`, printed "Native Shell CI management refused" and failed (exit 125). Step 19 "Retain bounded public receipts" uploaded the receipts (artifact `14139517979`). |
| NQ-2 | None: not a native package | | | | | Only the runner's automatic `native-guard-unit.yml` and `typecheck.yml` dispatches follow the push. |

Before NQ-1, `list_workflow_runs` for `native-shell.yml` on `native-qualify` returned
`total_count` 0, and `origin/native-qualify` did not exist.

NQ-2 filled the NQ-1 row from `list_workflow_runs`, `list_workflow_jobs`,
`get_workflow_run` and the job log tail, read on 15 November 2026 (D21); at that read,
43660129312 was still the only `native-shell.yml` run on `native-qualify`. NQ-3
interprets this row and does not record it again.

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
