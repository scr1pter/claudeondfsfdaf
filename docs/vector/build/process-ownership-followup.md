# Background command ownership follow-up

This lane continues draft [PR #26](https://github.com/scr1pter/claudeondfsfdaf/pull/26),
based on `d2156cb2d188bde0876309135a9039529870d609`. It does not change Vector Hands
or cloud workspaces. The fixture repairs in PR #23 are already present: the
three changed files have identical contents on both branches, although their
commit identities differ.

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

## Actual native acceptance and remaining checks

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

The focused workflow now also runs the actual Windows ShellJobs file and the
three previously failing background-command task-management cases. Their
results and exact-source full CI remain pending at this checkpoint. General
repository CI, any further platform acceptance and release review must be
reported separately. No merge or release is claimed.

The source-bound selected observations are recorded in
[the native evidence](evidence/process-windows-containment-2026-11-11.json).
They came from decoded official GitHub job logs; no artifact ZIP or final
installer verification is claimed.
