# task-wait-listen: a task wait could miss a helper that starts waiting on the user

Branch `task-wait-listen`, cut from origin/main `e11d6466`. No feature flag changes.

Files: `packages/engine/src/task/signals.ts`, `packages/engine/src/task/manager.ts` (`TaskManager.wait`) and `packages/engine/test/task/attention.test.ts`.

## 2026-11-22, register the wait's listener before anything is read

**The bug.** `TaskManager.wait` (the `task_manage` wait action, `vector tasks wait` and the experimental task wait route) should end early when a selected helper starts waiting on the user (D.4), so the agent can tell the user. It did its reads first: the session's background commands (`commands()`, which calls `ShellJobs.list` when `shl_` IDs are named) and then the tasks (`before = locked(controlLock)(pick())`, several database reads). Only after that did it register its listener with `TaskSignals.next(...)`. `TaskSignals.publish` wakes only listeners that are already registered. So a helper that started waiting during those reads was missed, and the wait ran to its full timeout (up to 60 s) instead of ending early.

**How it was found.** While root-causing the Windows `attention.test.ts` flake in runs 44987712493 and 44944158244. That flake is a different problem: a cold config load inside the existing test's 2 s window. It is left as an owner decision (warm the config in the test's `boot()`, or not) and is not changed here. Two agents verified the race separately.

**The fix.**

- `TaskSignals.next(taskIDs)` becomes `listen(taskIDs)`, a scoped effect. It registers the listener at once with `acquireRelease`, and the scope's close removes it. It returns the effect that waits for the next signal sent after the listening began.
- `TaskManager.wait` calls `signals.listen` straight after it checks the timeout, before `commands()` and before the board read. It listens on `input.taskIDs` without `shl_` IDs (`ShellJobs.isID`) and desktop workspace or swarm IDs (`DesktopTasks.owns`), as before. The body is wrapped with `Effect.fn(..., Effect.scoped)`, so the listener is removed on every exit: a result, a validation error or an interrupt.
- `attention.ts` is unchanged. It still publishes after it writes the helper's waiting record.

**The behaviour change.** Before, the wait listened only on the selected tasks that were active in its first read. Now it listens on every selected subagent. This matters only in mode `all`: there, an ended task does not end the wait (mode `any` returns at once when any selected task has ended). If such a task is resumed during the wait and starts waiting on the user, the wait now ends early with `attention: [id]`. That is harmless and matches D.4. The three callers (`task_manage`, the CLI and the HTTP route) only return the result. The tasks in it are read again after the wait, so they show the resumed task as it is. A task that was already waiting when the wait began still does not end it, because no new signal is sent.

**Tests** (`attention.test.ts`):

- :613, `task_manage wait ends for a helper that starts waiting while the wait reads its board`. It holds the real `SubagentLifecycle.controlLock` with `withPermits(1)` while the helper asks, so the helper is signalled before the wait reads its board. That lock is process-global; holding it is safe because the tests in a file run one after another.
- :644, `task_manage wait ends for a helper that starts waiting while the wait reads its background commands`. The wait names the helper and one `shl_` command. A second test layer (`withShells`, :160) replaces `ShellJobs` with a fake whose `list` reports that it was entered and then holds until the test opens it (:137). No process is started. The helper asks and is marked waiting while the listing is held. A fake is needed here: the real `ShellJobs.list` takes no lock a test could hold, so there is no other way to make it slow on purpose.
- The existing wait test (:580) and its 2 s budget are unchanged.

**Proof** (each file run alone from `packages/engine` with `--timeout 30000`):

- Red before. With main's `manager.ts` and `signals.ts` put back in the working tree and the tests kept: 5 pass and 2 fail. Both new cases fail with their "the wait missed ..." messages. The fixed files were restored, and `sha256sum -c` passed for all three files.
- Mutation M1: the listener moved back after `commands()`, which is where the first version of this patch had it. Only :644 went red (6 pass, 1 fail). This shows the background-command case covers the window that the board case leaves open. Restored, sha256 equal.
- Mutation M2: the listener moved after the board read. Both :613 and :644 went red (5 pass, 2 fail). Restored, sha256 equal.
- Green: `attention.test.ts` passed 7 of 7 in each of 10 runs in a row (16 to 20 s each). Also green: `task-manage.test.ts` (53), `task-manage-abort.test.ts` (3), `desktop-tasks.test.ts` (11), `task-batch-promotion.test.ts` (5), `prompt-routing.test.ts` (6), `cli/tasks.test.ts` (14) and `server/httpapi-sdk.test.ts` (19). `bun typecheck` in packages/engine passed, and so did the full turbo typecheck.

**Risks.**

- A listener now exists for the whole wait, including the reads before it, which were not covered before. It holds a set of at most the selected IDs, and the scope removes it on every exit. There is no leak path.
- A wait whose input is invalid (for example an unknown `shl_` ID or more than 200 IDs) registers a listener and removes it straight away. This has no visible effect.
- The behaviour change above: in mode `all`, a task that ended and was resumed can now end a wait early with `attention`. No caller depends on the old behaviour.
