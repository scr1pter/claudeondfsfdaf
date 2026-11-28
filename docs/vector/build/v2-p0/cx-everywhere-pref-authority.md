# cx-everywhere-pref-authority: finish and merge PR #144

Branch `cx-everywhere-pref-authority`, cut from the PR's head `everywhere-pref-authority` (`00671daea`). PR #144, "feat(everywhere): save owner settings through the desktop sidecar", had been an idle draft for more than a day. This v2 run took it over to finish it and merge it before the redesign starts. No flag changes: the Everywhere tab still shows only when the plan lists Vector everywhere (the hosted switch), and `VECTOR_EVERYWHERE_ENABLED` stays off. No public claims.

## 2026-11-25, takeover state

**What the PR does.** The built-in sidecar owns versioned per-user Everywhere preferences in `everywhere-preferences.v1.json` under the Desktop user data folder (engine `config/everywhere-preferences.ts`, wire schema in core `everywhere/preferences.ts`). The Settings panel, the Desktop jobs runner and the engine's unattended-worktree admission all read the same file. Writes go only over the sidecar's parent port, never the HTTP API. Each write must carry the current revision, is refused under a company lock on `everywhere`, and is saved atomically (temporary file, fsync, rename). Turning jobs on asks the owner in a native dialog, with its own wording when Remote must also turn on. While the runner waits for jobs, background mode "auto" keeps Desktop running.

**What was left.** The PR's CI runs were cancelled before any job ran, so it had no CI result. The branch was behind main. Main had changed only `packages/engine/test/everywhere/worktree.test.ts` among the PR's files, and `git merge origin/main` merged cleanly. One gap: nothing tested that only a password-protected loopback listener opens the preferences channel.

**Stacking.** The branch contains no other open PR's commits. PR #156 (`bind-everywhere-sessions`) is stacked on this one: it contains `00671daea`.

## 2026-11-25, only the authenticated loopback sidecar opens the preferences channel

**Behaviour.** `Server.listen` passes the preferences path to the routes and exposes `everywherePreferences` only when the listener binds a loopback address and has a nonempty owner password. That is how the Desktop sidecar starts. A passwordless listener or a network listener (even on a trusted network) gets neither, so admission there uses the legacy user config only and no write channel exists.

**Test.** engine `test/server/listen-policy.test.ts`, "only a password-protected loopback listener opens the private Everywhere preferences channel". A passwordless `127.0.0.1` listener and a password `0.0.0.0` listener with `trustedNetwork` have no channel. A password `127.0.0.1` listener answers a read with `{ kind: "ready", snapshot: { revision: 0 } }`.

**Mutation check.** With the gate removed (the path passed through unconditionally), the case fails (9 pass, 1 fail). Restored, 10 pass.

## 2026-11-25, red-before proof for the PR's own tests

- engine `test/everywhere/worktree.test.ts`, with `handlers/experimental.ts` reverted to origin/main: "the sidecar's versioned preferences take precedence without changing global config" and "durable preference writes compare revisions and immediately stop legacy-enabled admission" fail (22 pass, 2 fail). Restored, 24 pass.
- desktop `src/main/everywhere-wiring.test.ts`, with `everywhere-wiring.ts` from origin/main: "the runner uses the supported sidecar settings and only falls back for explicit version skew" fails (31 pass, 1 fail). Restored, 32 pass.
- desktop `src/main/background-mode.test.ts`, with `background-mode.ts` from origin/main: the "waiting for Everywhere jobs" case fails (48 pass, 1 fail). Restored, 49 pass.
- desktop `src/main/everywhere-preferences.test.ts`, mutation: the owner-confirmation answer is ignored in `everywhere-preference-control.ts`. "renderer consent assertions, owner cancellation and stale authority cannot turn on jobs" fails (4 pass, 1 fail). Restored, 5 pass.

## Runs here and in CI

Run locally one file at a time after the merge with main, all passing: engine `everywhere/worktree.test.ts` (24) and `server/listen-policy.test.ts` (10); desktop `everywhere-preferences` (5), `everywhere-wiring` (32), `background-mode` (49), `ipc-security` (10), `renderer-status`, `computer-preload`, `vault-preload` and `remote-engine`; app `settings-v2/everywhere-model.test.ts` (32); web `everywhere-pages` (68) and `everywhere-docs` (17). `bun typecheck` passes for core, engine, desktop and app.

The PR body said the managed-policy case could not run in its sandbox. Here "a company lock on everywhere is off, with the project open and trusted" ran and passed with the other 23 worktree cases. The new worktree case applies the same lock through `ConfigManaged.useTestPolicies`.

CI only:

- The mounted Settings case `packages/app/e2e/regression/everywhere-preferences.spec.ts` needs Playwright's browsers, which this computer does not have. The `e2e (linux)` and `e2e (windows)` jobs run it.
- The sidecar bundle with the new parent-port message is built by `desktop engine bundle (node)`.

## Lead rulings

2026-11-25, corrected after review: the first ruling used to say the legacy block was read "for viewing only". The runner and admission really use it as settings on version skew, as the wiring test expects (`refresh()` returns `needs-remote` for `unsupported`). Docs only, no code change.

- The PR's own fallback stays. On `unsupported` (a sidecar without the preferences channel, that is version skew), or when Desktop has no preferences bridge at all, the panel shows the legacy `/global/config` block read-only, and the runner and the engine's admission both keep using the legacy user config, consistently: the runner takes the legacy block as its real settings (`fetchSettings` in `everywhere-wiring.ts`), and admission falls back to legacy when no preferences path is bound or the file is missing (`effective()` in `config/everywhere-preferences.ts`). Every other failure (`unavailable`, `invalid`, a locked snapshot, an unreadable or replaced preferences file) keeps jobs off. This is the fail-closed option and needs no code change.
- No owner decision is needed. The write path stays behind the existing plan gate, and no public copy, Terms, Privacy or consent text changes.
