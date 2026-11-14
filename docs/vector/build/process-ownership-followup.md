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

The containment and installer workflows filter `pull_request` by path. A later
docs-only commit does not trigger them, and it does not change the code these
runs tested.

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
