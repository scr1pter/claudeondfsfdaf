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
*Annotation 2026-11-17 (EV-18):* the port is wired. The desktop's
`SafeWorktree` (packages/desktop/src/main/everywhere-wiring.ts
`unattendedWorktree`) advertises `unattended-v1` only while the engine's probe
answers exactly that, sends the route `{directory, base, branch, jid}` as the
owner, and checks the answer is exactly `{directory, branch, base}` with the
requested branch and base (the runner checks them again). A 403 holds the job
with a fixed reply; the checkout must be one GET /config/trust reports
untrusted. There is no fallback to `POST /experimental/worktree`. See
vector-everywhere-deviations.md, "2026-11-17, EV-18".

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

*Status (EV-16, 2026-11-16): delivered for Linux with bubblewrap, CI pending,
with no runner wiring yet.* Built in this lane, not by main's owners. The marks
are two flat session metadata keys, `vector.unattended` and
`vector.unattended.shell: "offline"` (core everywhere/frame.ts). Only the
owner's `POST /session` sets them (403 for a guest or a guest-marked request,
400 for any other value or without `vector.unattended`); nothing changes them
after: PATCH /session/:id and POST /sync/replay refuse an added, changed or
removed mark with 403 (an equal value passes), and the public metadata write
keeps them as it keeps `subagent`; a sync replay also may not delete or move a
session of a marked lineage. A session runs offline-only when it, or a stored
session above it, carries the shell mark (a missing ancestor ends the
lineage). Every shell command of such a session, background ones included,
goes through `Sandbox.unattended` whatever VECTOR_SHELL_SANDBOX or Vector Local
says, and runs only when that gives `sandboxed` with bubblewrap: no TCP or UDP
network (not even this computer's servers) and no host socket under /tmp or
/run, writes only in the checkout and never in its `.git`, private /tmp and
/run, Vector's data folder hidden, no capabilities, the home-directory secrets
and the common plaintext credential stores covered, and an allowlisted
environment (no token, key, proxy, agent or bus socket) with HOME and the
caches pointed at the sandbox's own /tmp. Windows, seatbelt, a missing,
non-root or non-starting bubblewrap, and anything the sandbox cannot wrap are
refused with one fixed message before anything is asked, and never run. The
session's terminals and its POST /session/:id/shell are refused too. The
capability is the owner-only probe `GET /experimental/shell/unattended`:
`{shell: "offline-v1"}` only on Linux with a root-only bubblewrap whose
one-time self-test starts, `{shell: "none"}` elsewhere (an older engine's 404
means none). Other sessions are unaffected and there is no switch for the
whole engine. Tests: packages/engine/test/everywhere/offline-shell.test.ts.
EV-18 creates the runner's session with the shell mark and allows `bash` only
on `offline-v1`; EV-21 wires the runner.
*Annotation 2026-11-17 (EV-18):* done in the desktop: every unattended session
carries the shell mark, and `bash` is allowed only on the probe's exact
`offline-v1` with no company lock on a key that can carry permission rules
(`permission`, `tools`, `agent`, `mode`, `default_agent`). The runner itself
was wired by EV-17 and EV-18; what EV-21 still owes is the settings page.
*Annotation 2026-11-20 (EV-21):* the settings page is built (Settings →
Vector everywhere, packages/app/src/components/settings-v2/everywhere.tsx;
CI pending). It is read-only: the lead refused the desktop config-skew
exception for the `everywhere` key, so the page writes nothing until the
setting has skew-safe storage outside user/global config (deviations log,
"2026-11-20, EV-21", "Ruling on (a)"). That storage is a package for the
lead to brief, not a request to main. The page needs nothing more from main.

- **macOS: not built.** Seatbelt's offline profile lets this computer's
  servers and every Unix socket through, so it does not qualify. It needs a
  loopback- and socket-denying seatbelt profile and a macOS CI runner to
  qualify it, which no lane has yet; until then macOS laptop jobs edit but run
  no checks.
- **Windows:** refused; there is no sandbox.
- **Residual:** a Unix socket file outside /tmp and /run that no mount covers
  (one inside the checkout, /var/snap/lxd/common/lxd/unix.socket, sockets under
  /var/lib) stays reachable; a seccomp AF_UNIX filter or more tmpfs mounts would
  close that. Other projects' files and unknown credential stores in the home
  folder stay readable (a precondition for EV-21's push).
- **Escape path EV-18 or EV-21 must close:** a command can write a formatter,
  package.json or .vector/ config into the checkout, and the engine's next
  formatter run, LSP start or config reload runs it outside the sandbox with
  the network. Formatters, LSP and config reloads must be off for an
  unattended session, or the project's config paths bound read-only, before
  the runner prompts one.
  *Annotation 2026-11-17 (EV-18): closed for the job's checkout.* The engine
  never trusts it (`createUnattended` inherits no trust, and trust is keyed by
  folder and content), and an untrusted folder starts no formatter or language
  server and loads none of its own config; the desktop adapter refuses a
  checkout GET /config/trust reports trusted. Engine
  test/everywhere/worktree.test.ts, "the job's checkout is never trusted",
  writes a formatter, a language server and a .vector folder into the
  checkout and shows none loaded after a reload. Residual: the owner can trust
  a job's checkout by hand in the app.
  *Annotation 2026-11-27 (EV-RM2): residual closed.* `Config.approve` refuses
  a folder inside `<data>/everywhere-worktree`, compared by real path, so POST
  /config/trust answers 400 there and the folder stays untrusted. GET
  /config/trust reports `approvable: false` there, and `vector trust approve`
  prints "A Vector everywhere job's checkout is never trusted." Engine
  test/everywhere/worktree.test.ts, "the owner cannot trust the job's checkout
  by hand, but can still trust a project folder", and test/cli/trust.test.ts,
  "the owner cannot approve trust in a Vector everywhere job's checkout", pin
  it. The desktop's per-prompt recheck was not built: nothing can trust the
  checkout now.

See vector-everywhere-deviations.md, "2026-11-16, EV-16".
