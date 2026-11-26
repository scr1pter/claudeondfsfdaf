# cx-bind-everywhere-sessions: bind unattended sessions to their worktree (#156)

Branch `cx-bind-everywhere-sessions`, which finishes Codex's draft PR #156 (`bind-everywhere-sessions`). The draft had been idle for over a day. This run took it over. No flag changes: `VECTOR_EVERYWHERE_ENABLED` stays off, so no job is offered and the runner never reaches this path in production. No public claims.

## 2026-11-26, takeover: merge main and verify the session binding

**What the PR does.** The Desktop runner no longer creates an unattended job's model session through the public `POST /session` route. Instead it asks the built-in Engine over the private utility-process channel that #144 added (`everywhere-session` messages next to `everywhere-preferences`). Before the Engine creates the session and saves a durable `<jid>.session.json` receipt next to #153's reservation, it checks:

- the Engine's own placement record (`<jid>.placed.json`, written by `createUnattended`);
- that the checkout is untouched (folder and git-dir identity, common dir, toplevel, branch and base);
- the owner's current settings (enabled, project listed, no `everywhere` company lock);
- a trusted parent and an untrusted child;
- the job's exact claim (the SHA-256 of the lease id).

A retry after a lost reply gets back the same session ID. A checkout that changes during creation gets no receipt.

**Merge.** `origin/main` (68 commits) merged cleanly. Main had changed none of this PR's files.

**Stacking.** The branch still carries #153 (`reserve-everywhere-worktrees`) and #144 (`everywhere-pref-authority`). Both are open, and another agent of this run is finishing #144. Merge this PR after those two, or together with them.

**Tests (all run locally, one file at a time).**

- engine `test/everywhere/worktree.test.ts`: 29 pass. The new cases are "only the listener's private creator can bind an unattended session after the scoped checkout trust probe", "an ordinary session cannot bind itself using unattended metadata" and "a checkout that changes while the Engine creates the session gets no binding".
- engine `test/everywhere/unattended-session.test.ts`: 6 pass, 1 skip. The skip was already on main.
- desktop `src/main/everywhere-wiring.test.ts`: 33 pass. The new case is "the runner checks the new checkout before using the private session broker or explicit legacy fallback".
- desktop `everywhere-engine.test.ts` 13, `everywhere-runner.test.ts` 62, `everywhere-preferences.test.ts` 5 and `background-mode.test.ts` 49 pass.
- core `test/local-mode/sources.test.ts`: 17 pass.
- `bun typecheck`: core, engine, desktop and app are clean.

**Red before.** The engine sources this PR changes (`server/server.ts`, `routes/instance/httpapi/server.ts`, `worktree/index.ts`, plus the new `server/everywhere-session.ts` and `worktree/unattended-records.ts`) were reverted twice: once to `origin/main` and once to the stacked base (#153 plus #144). Both times the three new engine cases fail (0 pass, 3 fail: no private creator is attached). Restored, they pass. The desktop runner files (`everywhere-engine.ts`, `everywhere-wiring.ts`, `everywhere-runner.ts`) were reverted to the stacked base. The broker case then fails (it expects the broker request, which never arrives). Restored, it passes.

**Mutation checks.**

- Without the claim comparison on an existing receipt (`everywhere-session.ts`), a second claim gets the first job's session. The bind case fails (0 pass, 1 fail). Restored, it passes.
- In `everywhere-engine.ts`, letting an `unavailable` reply fall through to the public HTTP route makes the broker case fail (0 pass, 1 fail). Restored, it passes.

**Lead rulings.**

- The red-before proof is measured against both `origin/main` and the stacked base, because the test file also covers #153 and #144. Reverting only this PR's layer isolates its own change.
- Codex's fallback rule stays as written, since it is the safest option that still closes the item. Only an Engine without the private channel answers `unsupported`, and only that answer falls back to the established `POST /session` path. That fallback is the behaviour on main today. A `refused` answer, or a second `unavailable`, stops the job without falling back.
- Automatic seven-day retirement of unattended worktrees is out of scope, as the PR body says. It needs durable terminal and quiescence evidence first.

**CI only.** The `Vector everywhere tests` lane (`vector-everywhere.yml`) runs every everywhere test file, including the desktop `everywhere-*.test.ts` files. The engine shards in `test.yml` run the engine suite on Linux and on Windows. Windows has no `process.getuid`, so the receipt ownership checks are skipped there, and only CI covers that path. The app e2e jobs run #144's `everywhere-preferences.spec.ts`. The earlier CI run on this PR was cancelled after about three hours without a result, so no hosted result exists yet.

**Follow-up (not done here).** `.github/workflows/vector-everywhere.yml` does not list the new `packages/engine/src/server/everywhere-session.ts` or `packages/engine/src/worktree/unattended-records.ts`. A change to only those files would not start the lane. Open PRs touch that workflow file, so it is left for whoever lands them.
