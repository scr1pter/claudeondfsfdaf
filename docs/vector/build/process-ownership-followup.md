# Background command ownership follow-up

This lane continues draft [PR #26](https://github.com/scr1pter/claudeondfsfdaf/pull/26),
based on `d2156cb2d188bde0876309135a9039529870d609`. It does not change Vector Hands
or cloud workspaces. The fixture repairs in PR #23 are already present: the
three changed files have identical contents on both branches, although their
commit identities differ. PR #23 is superseded by this PR; see
[Relationship to PR #23](#relationship-to-pr-23).

## Windows startup failure and correction

The original Windows failures had one shared cause: `WindowsProcess.start`
never received its holder's ready frame. All nine normal native-start cases
failed, while five direct-holder Job Object, holder-death and EOF cases passed.
The direct fixtures inherited the host environment; production intentionally
passes only `SystemRoot`, `WINDIR`, `TEMP` and `TMP` to its trusted holder.

Two focused native runs preserved the failure:

- [43144413334](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43144413334),
  source `6c7c8e293237e132434e0db4778091f4d1c2eead`, job `130938752437`:
  restoring a trusted system PATH, a system module path or profile metadata did
  not make the minimal holder ready within the existing 15-second bound.
- [43147345526](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43147345526),
  source `eaaaebf5ce32412fc20b5e507106471a4c598678`, job `130948149232`:
  closed phase receipts located the stall before `Get-Command Add-Type`
  completed. Only the PowerShell environment group and a combination containing
  that group became ready promptly. Both runs reported 14 passed, 1 skipped and
  9 failed tests; those failures were retained.

The holder now imports Windows PowerShell's built-in Utility assembly by its
exact Microsoft strong name before invoking `Add-Type`. Import and compilation
remain inside the existing pre-payload failure boundary. This avoids module
discovery through an inherited project or user `PSModulePath`; the original
four-variable helper environment stays restricted. Command data still travels
over stdin as JSON and never enters the static helper script.

No process-ownership or timing guarantee changed. The payload is created
suspended with atomic Job Object assignment, its PID must be durably
acknowledged before resume, and termination plus output settlement remain
required for successful cleanup. Startup, persistence, stop and close deadlines
remain 15, 10, 2 and 3 seconds. The encoded-command limit remains 30,000
characters. Two explanatory C# comments moved to the outer documentation so the
new preparation fits that existing bound; executable C# code is unchanged.

## First native acceptance at `a193d18d9`

[43150320218](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43150320218),
source `a193d18d9053f4240443415c64b9935fb2a7f8ec`, job `130957680536`, passes all
14 native cases and 9 portable cases: **23 passed, 1 platform skip, 0 failed,
97 assertions**, in 13.91 seconds. The skipped case is the refusal check that
only applies on a non-Windows host.

The actual cases cover cmd, PowerShell and Git Bash quoting; the suspended PID
acknowledgement barrier; failed persistence; leader and descendant cleanup;
holder death during creation; assignment refusal; parent EOF before and after
acknowledgement; private control handles; filtered credentials; project module
isolation; rejected output and stalled output consumption. A project module may
run in its user's payload; the regression requires any such execution to belong
to the payload PID, never the trusted holder.

In the same job, the old minimal-environment control still timed out before
command discovery completed. Explicit assembly preparation became ready with
confirmed cleanup in 240 ms. The individual module-analysis-cache control also
became ready promptly. These are observations in one CI job, not a general
startup performance claim.

The source-bound selected observations for this run are recorded in
[the native evidence](evidence/process-windows-containment-2026-11-11.json).
They came from decoded official GitHub job logs; no artifact ZIP or final
installer verification is claimed. That file covers run 43150320218 only; the
head runs below are recorded in this document.

## Acceptance at the PR head `4059f6a70`

The previous checkpoint left three things pending: the Windows ShellJobs file,
the three previously failing background-command task-management cases, and
full CI at the exact source. All three now have results. Every run below is a
`pull_request` run of PR #26 at head
`4059f6a70d81c6e4fea9d39b1d388fc6af872477`. Each ran once (attempt 1) and
concluded `success`. The counts come from the official GitHub job logs.

- [Windows background containment 43151685952](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43151685952),
  job `130962118761`, `windows-latest`:
  - `test/tool/shell-windows-process.test.ts`: 23 passed, 1 skipped, 0 failed,
    97 assertions, 17.04 s. The skipped case is again the non-Windows refusal
    check.
  - `test/task/shells.test.ts` (ShellJobs): 11 passed, 3 skipped, 0 failed,
    92 assertions, 16.62 s. The three skips are the cases marked `onPosix`:
    the POSIX process-tree stop, leader-exit group cleanup, and the
    uncertain-cleanup admission retention case. The Windows process-tree stop
    case passed.
  - `test/tool/task-manage.test.ts`, filtered with
    `-t 'background commands|running commands'`: the three previously failing
    background-command task-management cases passed, 49 filtered out, 0 failed,
    27 assertions, 8.83 s.
  - The holder diagnosis step showed the same pattern as before. The old
    minimal environment timed out (15,031 ms). The exact Utility assembly
    control became ready with proven cleanup (300 ms), and so did the
    module-analysis-cache control (350 ms). As before, these are observations
    from one CI job, not a performance claim.
- [test 43151685886](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43151685886):
  21 jobs passed and 0 failed. These were unit and e2e on Linux and Windows,
  all 4 Linux and 12 Windows engine shards, and the desktop engine bundle. The
  three manual jobs (published release engine evidence, production app
  benchmark, offline request footprint) were skipped. Main's
  [42515544563](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42515544563)
  failed on three cases, and all three passed here:
  - the isolated-helper terminal case passed in Linux engine shard 1/4
    (job `130962118998`, 1,741 passed, 3 skipped, 0 failed);
  - the changed-server-identity case and the background-subagent report case
    passed in Windows engine shard 1/12 (job `130962119181`, 742 passed,
    26 skipped, 0 failed). Both also passed in the Linux shard.
- [Verify 43151685821](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43151685821):
  Website build, the 30-minute Vector Local desktop packet capture, and the
  Vector Local air-gap job passed.
- [typecheck 43151685946](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43151685946):
  app, cloud, desktop and engine passed.
- [Vector standalone installers 43151686001](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43151686001):
  `windows` and `windows-native` passed, both on `windows-2025`.

Later docs-only commits to this PR do not change the code these runs tested.

## Relationship to PR #23

[PR #23](https://github.com/scr1pter/claudeondfsfdaf/pull/23) (`finish-checks`,
head `00b50f72b90ed1885b50098ed2e9eaf0cbeedf5a`) carries the same fixture patch
as this branch's `d2156cb2d`. `git cherry` marks `00b50f72b` as already present
here ("-"). All three files it changes are identical at this PR's head:
`docs/vector/build/main-ci-followup.md`,
`packages/engine/test/local-mode/local-run.test.ts` and
`packages/engine/test/task/isolation-terminal.test.ts`. PR #23 is therefore
superseded by PR #26. Its three target cases pass in test 43151685886 (above).
This document does not close PR #23.

## Not covered

CI here ran only on Linux and Windows runners. No macOS run, artifact ZIP
verification, release review or other platform acceptance is claimed. No merge
or release is claimed.

## Hosted sandbox cleanup (C9), 15 November 2026

The process-spawn review's C9 worried that the POSIX owned-group cleanup could not
confirm a stop inside the hosted engine sandbox, because the sandbox `/proc` might be
empty. At the `native-qualify` head that case cannot occur in any shipped or CI build:

- A legacy hosted `@vector` engine runs with the host `/proc`. The bubblewrap floor is off,
  and so is the native build. So the `kill(-pgid, 0)` check and the `/bin/ps` zombie check
  in `OwnedProcess` work there.
- A native CI build has an empty `/proc`, but it refuses owned commands before launch.

The new Linux test `packages/engine/test/task/shell-required-isolation-posix-owned.test.ts`
covers this path. Under required isolation it stops an owned background group that
ignores SIGTERM, and it shows:

- cleanup `"confirmed"`;
- both group members gone (on a GitHub-hosted runner strictly `ESRCH`; elsewhere a
  reparented zombie that PID 1 has not reaped yet is also accepted);
- the slot released;
- the stop inside the default bounds (3 s grace, then 3 s kill).

No process-ownership guarantee or deadline changed: grace, kill and drain stay at 3 s
each, and ShellJobs sets none. A `setsid` grandchild still leaves the group and is not
contained; that limit is unchanged. Hosted CI evidence comes from the Linux engine shard of
`test.yml` at the end of the lane. The details are in the
[spawn-review addendum](v2-spawn-review.md#addendum-15-november-2026-c9-spawn-1-and-spawn-2-at-the-native-qualify-head-nq-2)
and the [lane notes](native-qualify-notes.md#nq-2-15-november-2026).

## Native qualification lane end, 15 November 2026

No process-ownership guarantee or deadline changed in the `native-qualify` lane. At its
head `ce5e5605`:

- POSIX grace, kill and drain stay at 3 s each
  (`packages/core/src/owned-process.ts:131`, `:134`, `:136`).
- The Windows holder's startup, persistence, stop and close stay at 15, 10, 2 and 3 s
  (`packages/engine/src/tool/shell/windows-process.ts:28-31`).

The status of the rest:

- The NQ-2 Linux test `packages/engine/test/task/shell-required-isolation-posix-owned.test.ts`
  has no hosted run yet. `test.yml` has not run on `native-qualify`, so the Linux engine
  shard of the branch's PR is its first hosted run. 21 Nov 2026: `test.yml` ran on main after the native-qualify merge: run 44848275007 at `f3d7ac74` (jobs 136673698344, 136673698359, 136673698427, 136673698207; see native-qualify-notes.md, "21 November 2026: the first hosted test.yml run of the lane's Bun tests").
- Two more POSIX tests for the same contract are on `origin/review-fixes` (`fa5a5639`, not
  merged here). One of them is
  `packages/engine/test/task/shell-required-isolation-posix.test.ts`, the path the NQ-2
  test had until review round two renamed it (lane notes, D106). The two files no longer
  collide, so both tests' scenarios survive the merge without a hand resolution.
- Native commands registered with `OwnedProcess` stay refused before launch
  (`packages/core/src/cross-spawn-spawner.ts:405-411`). The spawn review's §6 Q2,
  delegate versus refuse, stays open.
- The holder's own required-isolation guard (SPAWN-3) is only on `origin/review-fixes`
  (`8562dd7a`).
- The engine sandbox's `/proc` treatment is still undecided. Run 43697711119 shows that
  Bun `-e 0` aborts under the empty `/proc` on the hosted image.
  - If the decision gives the engine its own PID namespace procfs, the `/bin/ps` check in
    `groupEmpty` would see only that namespace.
  - Whoever decides must then check C9 again.

The details are in the
[spawn-review addendum](v2-spawn-review.md#addendum-15-november-2026-lane-end-status-at-the-native-qualify-head-nq-8)
and the [lane notes](native-qualify-notes.md#nq-8-15-november-2026).

Both native build switches and FLOOR stay false; no production activation is authorized
by this section.

## Hosted macOS process ownership

The `macos-process-ownership.yml` workflow runs on `macos-15` for changes to
the process, shell, terminal, task and MCP paths it exercises. It can also be
dispatched for an exact source revision.

It covers owned POSIX process groups and output cleanup, durable background
commands, multi-agent terminal disposal, and task-management list, wait and
stop. The PTY and MCP child fixtures check their parts of S6-5, and the MCP
fixture checks the policy refusal in S6-7. The foreground and background shell
ordering cases under required isolation remain separate from this coverage.
The Linux bubblewrap case is qualified on the Linux lanes.

Record macOS acceptance from the hosted run at the revision being qualified.
