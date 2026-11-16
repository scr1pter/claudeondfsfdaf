# Main service requests found during P1c

These are prerequisites for later laptop-route activation. VE-07 remains
unwired and refuses an unsafe worktree adapter. This branch does not edit the
avoided engine/worktree files to hide an unmet requirement.

## Safe unattended worktree creation

The proposed `POST /experimental/worktree` call is unsafe for this use: its
`Worktree.create` calls `boot`, which resets with ordinary git, loads the instance
and runs `runStartScripts`. There is no skip-startup field in `CreateInput`.

The main owner should provide an owner-only, explicit unattended-worktree
capability with these requirements:

- Input: an already allowed project directory, exact fetched base SHA and the
  canonical job branch (`vector/ve-…`), plus the job id.
- Atomically reserve the branch/path, create the worktree from that exact SHA
  with hooks, fsmonitor, filters and executable configuration disabled, and
  register it as a project sandbox.
- Never run project startup scripts, caller-supplied commands, hooks or package
  installation, and never bootstrap unrelated code as a creation side effect.
- Refuse an existing branch/path or a changed/unresolvable base. Return the
  canonical directory, branch and exact base SHA only after creation succeeds.
- Preserve owner authentication and existing project/instance isolation.
- Tests must include a repository startup script and hook that would publish a
  marker: neither runs. Concurrent creation cannot reuse the same reservation.

VE-07's injected `safeWorktree` port must advertise `unattended-v1` and return the
exact requested branch/base. There is no fallback to the existing endpoint.

*Status 2026-11-16 (EV-12):* the engine service is built, with no route:
`Worktree.createUnattended({directory, base, branch, jid})` in
packages/engine/src/worktree/index.ts. It takes the loaded project's own checkout
only, requires `refs/vector-everywhere/<jid>` (the runner's fetch ref) to name
`base` and `base` to be a commit present here, refuses executable repository
configuration with the runner's allowlist, reserves the folder with an exclusive
mkdir and the branch with git's ref lock, creates and populates the checkout
with the runner's hardened git and a minimal environment, and registers it as a
project sandbox. It loads no instance and runs no start script, caller command,
hook, filter or install. Owner-only exposure, the guest refusal, the
`everywhere.projects` allowlist and the workspace-trust check (refuse unless the
loaded project is trusted) belong to EV-13's handler, which runs the allowlist
and trust checks before an instance is loaded for the folder (or accepts only
an already loaded instance) and also advertises `unattended-v1`; "delivered" is
written there. The runner has no `safeWorktree`
and settles `held` until EV-21. See vector-everywhere-deviations.md,
"2026-11-16, EV-12".

## R-M2: session-scoped offline shell

The runner denies `bash` and `unsandboxed_shell` until a separate engine
capability guarantees a session-scoped offline sandbox with home-directory
secrets denied, a scrubbed child environment and no unsafe Windows fallback.
Capability absence still permits an editing-only job and the result says checks
did not run. A global environment switch is insufficient: it would also change
the owner's other sessions.

The engine behaviour package (VE-08) verifies the actual HTTP request shape and
records any remaining mismatch; a caller-supplied boolean is not live release
qualification.
