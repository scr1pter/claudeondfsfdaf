# cx-tracker-stage-copy: accurate Jira and Linear progress (PR #121 takeover)

Branch `cx-tracker-stage-copy`, cut from origin/tracker-stage-copy `32482a952` (Codex's draft PR #121). This v2 run took the PR over on 2026-11-25 because the draft had been idle for more than a day before the Saturday deadline. The branch also carries the commit from PR #120 (`fadd9dfe5`, the Jira lost compare-and-set repair), which was closed without merging. It lands here instead. Everything stays dormant: Jira's and Linear's laptop routes are behind `VECTOR_EVERYWHERE_ENABLED` and `LAPTOP_ROUTE_WIRED`, and both stay off.

## 2026-11-25, takeover: what was there and what was left

**Codex's state.** The PR body reported the work done: 54 focused tests, and the Web and API typechecks passed. No follow-ups were listed. The only red CI jobs were in packages this PR does not touch: the Windows `engine` shard 12 (`windows-process-isolation.test.ts`, exit code check), Windows `unit` (a core PowerShell watchdog case), and the `computer-helper` jobs, which hit the runner's time limit after 3 h 40 min.

**This run.** Merged origin/main `dbeb06661` (no conflicts; never rebased). Re-ran both test files and both typechecks. Proved each change red before it was restored. No source change was needed. The handoff's lost compare-and-set line was left as it is, because open PRs edit the handoff (see "Left for others").

## The three fixes (Codex's code, verified here)

1. **A lost compare-and-set on Jira's `laptop` write failed the task** (handoff "A lost compare-and-set on Jira's `laptop` write", deviations EV-20 (p); from PR #120). After a claim, the router's `progress(laptop)` reads the job (claimed, so `SUBMITTED`) and then the Jira task. If the runner reports `started` in between, the router's write loses the compare-and-set. `nativeWork` in `jira/a2a.ts` then marked the task FAILED while the computer ran, and the result never reached Jira. `api/_lib/everywhere/jira/adapter.ts` `progress` now skips the write when the task already shows this job as `WORKING`. When a write loses, it accepts the loss only after a fresh `assertTask` still ties the task to this job, at the same, a later (`WORKING`) or a terminal state. Every other verdict, and authority that no longer matches, still throws `JiraFailure` as before.
2. **Between the claim and `started`, a Jira task said "Waiting for your computer"** (deviations EV-20 (h)). `jira/render.ts` now answers "Your computer picked up the request and is preparing to start." while the job is `claimed`. The A2A state stays `TASK_STATE_SUBMITTED` until `started`.
3. **An expired Linear job's plan was set to all `completed`** (deviations EV-20 (i)). `linear/adapter.ts` now sends `linearPlan("waiting", "canceled")`, which marks all three steps `canceled`, when the job has `expired`. A settled job still gets `linearPlan("pushing", "completed")`.

**Lead call.** The handoff offered three fixes for (1): take the native-resource lock as Linear does, skip a write the task has moved past, or leave a task a job owns in `nativeWork`. Ruling: keep Codex's "skip a write the task has moved past", plus the checked lost-write acceptance. It closes the false FAILED without adding a lock round trip to Jira's 55 s acknowledgement path. It does not widen `nativeWork`, which still fails a task for every other error. The opposite race (the router's `SUBMITTED` write lands first and the runner's `WORKING` write loses) still throws, but only in `events.reported`. It does not mark the task FAILED, and the next milestone report writes `WORKING` again.

## Tests

- `packages/web/test/everywhere-jira-a2a.test.ts`, "a stale Jira routing write cannot fail a task whose own computer already started". It forces the interleaving: a store wrapper runs the computer's real `reportJob(started)` and the `reported` event just before the router's task write. It then checks that the write lost (`-2`), the job is `running`, and the task is `WORKING` in the store and in GetTask. It also runs a second adapter whose job read returns the old `claimed` record, and checks that its write cannot move the task back. Settling then completes the task with one artifact and one private delivery.
- `packages/web/test/everywhere-journey-laptop-tracker.test.ts`: A1 expects the "picked up" text while the job is claimed, and L2 expects the three `canceled` steps for an expired Linear job.

**Runs** (from `packages/web`, `bun test <file> --timeout 30000`, one file at a time):

- Green, after the merge: everywhere-jira-a2a 21 pass, 3 skip, 0 fail. everywhere-journey-laptop-tracker 5 pass, 4 skip, 0 fail.
- Red, `jira/adapter.ts` set back to origin/main: the new Jira case fails (the task is FAILED, not `WORKING`). 20 pass, 1 fail.
- Red, `jira/render.ts` set back to origin/main: A1 fails ("Received your request. Waiting for your computer."). 4 pass, 1 fail.
- Red, `linear/adapter.ts` set back to origin/main: L2 fails (`completed` where `canceled` is expected). 4 pass, 1 fail.
- Mutation 1, the lost-write acceptance turned off (`if (false && written === "changed")`): the new Jira case fails. Restored.
- Mutation 2, the stale-read skip turned off: the new Jira case fails at the older-job-read step. Restored.
- The worktree matched the index after every restore.

The skipped cases need a real Redis (`VECTOR_TEST_REDIS_URL`). CI runs them in vector-everywhere.yml, job "Vector everywhere tests", which has a Valkey service.

**Typechecks.** API: `bun typecheck --project ../../tsconfig.json` from `packages/engine`, clean. Web: `bun typecheck` (astro check), 0 errors.

## Left for others

- The handoff (`vector-everywhere-handoff.md`, "A lost compare-and-set on Jira's `laptop` write") and the deviations log (EV-20 (p)) still call the lost compare-and-set open. This PR fixes it. Open PRs #123, #138 and #157 edit the handoff, so this run added no handoff edit beyond Codex's own. Mark the item fixed by PR #121 at the next handoff edit.
- `docs/vector/owner-actions/vector-everywhere-jira.md` still lists the lost compare-and-set as a step to fix before Jira's laptop route goes live. Open PRs #123 and #157 edit that file, so this run did not. Drop the line when it is next edited.
- PRs #123 and #157 also rewrite the handoff line this PR replaces ("Two Jira and Linear texts"). Whichever lands second resolves that conflict.
