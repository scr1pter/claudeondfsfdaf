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
*Annotation 2026-11-16 (EV-13):* EV-13 took the second option. The route
checks the allowlist before it looks for an instance and then accepts only an
instance already loaded in this engine for the folder (by any authenticated
request), checking trust on that instance; it never loads one.

*Status 2026-11-16 (EV-13): delivered, CI pending, with no runner wiring
yet.* The engine
serves `POST /experimental/worktree/unattended` (input `{directory, base,
branch, jid}`, success exactly `{directory, branch, base}`) and the probe
`GET /experimental/worktree/unattended`, which answers `{policy:
"unattended-v1"}` to the owner. Both are owner only: no credentials get 401,
and a guest or owner credentials carrying the guest marker get 403. A create
runs these checks in order, and a refusal creates nothing: the handler's owner
check; an absolute `directory` (400); the user's own config files, read
afresh for each request without writing anything or touching the engine's
cached copy (`Config.readGlobal`: `everywhere.enabled` true, the key not
company-locked, the folder listed under the same canonical path; anything
else, an unreadable or invalid file included, is a fixed 403); the folder
exists (400); an instance already loaded in this engine for it, by any
authenticated request (otherwise a fixed 403: creating a job's checkout never
loads an instance, so it never starts the project's plugins, language servers
or dependency installs); `config.trust()` reports trusted
(403); then `Worktree.createUnattended`'s own checks (400). Messages are fixed
and carry no path or task text, and a stray `task` key in the body is dropped.
`POST /experimental/worktree`, `Worktree.create` and
`/experimental/capabilities` are unchanged, and nothing falls back to them. The
cost of never loading an instance: a job for a project no request has loaded
since the engine started (or since the last reload) is refused until it is
opened, and EV-21 holds it. Tests:
packages/engine/test/everywhere/worktree.test.ts, "POST
/experimental/worktree/unattended (EV-13)". The runner still has no
`safeWorktree` and settles `held`; EV-21 wires the port to this route. The
"already loaded" rule is EV-13's own decision, built because the lead's ruling
could not be asked for inside the package; the looser option (load the
instance for an allowed folder, then check trust) would start a trusted
project's plugins and could install their dependencies, so choosing it would
withdraw "delivered" here. See vector-everywhere-deviations.md, "2026-11-16,
EV-13", (c).

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
