# cx-check-everywhere-continue takeover: check a job's status before continuing it (#145)

Branch `check-everywhere-continue` (PR #145). Codex opened the PR as a draft on 2026-11-24 and left it idle for more than a day. This v2 run took it over to finish it before the Saturday deadline. The PR touches only the desktop app's Settings → Vector everywhere page. No feature flag changes and no public claims. `VECTOR_EVERYWHERE_ENABLED` stays off. Each entry names the bug, the test that fails without the fix, and the mutation check.

## 2026-11-26, Continue could start a second session in a job's folder while the job still ran

**Bug.** On main, the job row's "Continue in a new session on this branch" button only checked the live event stream (`session_working`). That stream knows only the statuses this window has heard since it opened. A job that was already running when Settings opened, or whose events had not reached the panel yet, therefore read as finished. Continue then created a second session in the job's worktree while the job was still writing there. Nothing stopped a second click from sending another create while the first was in flight. A create that finished after the panel had switched to another Engine still navigated to that Engine's session.

**Fix (Codex, kept).** Before it creates a session, Continue reads the Engine's own status snapshot for the job's folder (`session.status` with `directory` set to the job's worktree). `continuationState` (app `settings-v2/everywhere-model.ts`) reads it like this:

- The snapshot lists active sessions only, so a job absent from a successful snapshot is idle.
- A `busy` or `retry` status reads as running.
- A missing, malformed or failed snapshot reads as "unavailable", and nothing is created.

The live busy check still applies, before the read and again after it. The button stays disabled while a continue is in flight. If the panel switches to another Engine, nothing is created, reported or opened.

**Finished in this takeover.** The async flow moved out of the component into `continueEverywhereJob` (same file). It takes the reads and actions as callbacks, so it can be tested without a browser. The component keeps only the in-flight flag. Its two messages are now exported constants (`JOB_UNCONFIRMED`, `CONTINUE_FAILED`) and are covered by the existing plain-copy check. Lead ruling: the job's status is read from the Engine for the job's own folder. That is the folder the create loads anyway, and a job still running there already has it loaded. The page still writes no settings (EV-21, "Ruling on (a)").

**Tests.**

- app `src/components/settings-v2/everywhere-model.test.ts`, "Continue requires a successful scoped status snapshot even before the first live event" (Codex), covers the status rules above.
- The same file's new `continueEverywhereJob` cases use a fake Engine for every path:
  - a live busy job is refused before any read;
  - a session is created and opened only after an empty or idle snapshot;
  - busy, retry, missing and failed snapshots create nothing;
  - a live busy event that lands during the read still refuses;
  - after a server change, nothing is created, reported or opened;
  - a failed create, or one that returns no session, says so.
- app `e2e/regression/everywhere-continue.spec.ts` (Codex) mounts the real page against the mocked Engine. It covers the live busy and idle transitions, and a cold panel's busy, unavailable and idle snapshots. This takeover adds one check: the first status read is held until the button shows disabled and a second click sends nothing. That check fails if the in-flight flag is dropped from `disabled`. Chromium is not installed on the build machine, so this spec runs only in the CI `e2e (linux)` and `e2e (windows)` jobs.

**Red before.** With `everywhere-model.ts` and `everywhere.tsx` reverted to main, the model test file fails to load (`continuationState` is not exported). Restored, all 39 cases pass.

**Mutation checks.** Each mutation is caught by the named case:

| Mutation | Result |
| --- | --- |
| Drop the server-change check after the read | "after a server change…" fails (38 pass, 1 fail) |
| Drop the server-change check after the create | Same case fails (38 pass, 1 fail) |
| Skip the live recheck after the snapshot | "a live busy event that lands while the snapshot is read still refuses" fails (38 pass, 1 fail) |
| Treat a job absent from the snapshot as unavailable | 4 cases fail |

**Checks run.** `bun typecheck` and `bun run typecheck:e2e` in `packages/app` pass.

**CI on the PR before this takeover.** The checks of 2026-11-24 were cancelled after waiting more than five hours for runners. They did not fail on this change. The jobs that ran (app typecheck, website build, air gap) passed.
