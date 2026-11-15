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
| NQ-2 | Prove owned background cleanup under required isolation on Linux, and correct C9 | None (typecheck; test.yml at the lane end) | Planned |
| NQ-3 | Refuse at admission any mask whose ancestors the keeper cannot search | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-4 | Inventory direct process spawn sites and their isolation stance | None (typecheck; test.yml at the lane end) | Planned |
| NQ-5 | Mask the runner home instead of its unreachable temporary leaf | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-6 | Native baseline cell follow-up A | Once, `{"diagnostic_cell": true}` | Planned |
| NQ-7 | Native baseline follow-up B and the full matrix | Exactly one: the diagnostic cell, or `{"diagnostic_cell": false}` (eight cells) only if the diagnostic cell is green with the `owned` refusal case. Any full-matrix spend beyond that one bounded dispatch is owner-gated. | Planned |
| NQ-8 | Close the lane's native qualification and spawn-review records | None (typecheck) | Planned |

## Dispatch log

| Package | Run | Job | Head | Inputs | Closed label | Step results |
| --- | --- | --- | --- | --- | --- | --- |
| NQ-1 | Pending: dispatched in the commit step after the push, once guard-unit passes at the pushed SHA; the run, job, head, guard-unit result (or a skipped dispatch) are recorded from the API by a follow-up docs commit or by NQ-3 | | | `{"diagnostic_cell": true}` | | |

Before NQ-1, `list_workflow_runs` for `native-shell.yml` on `native-qualify` returned
`total_count` 0, and `origin/native-qualify` did not exist.

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
