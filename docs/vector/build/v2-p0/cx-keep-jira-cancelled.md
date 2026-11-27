# keep-jira-cancelled takeover: Jira cancellation during repository prompts (#141)

PR #141 (branch `keep-jira-cancelled`) was a Codex draft that had been idle for more than a day. This v2 run took it over to finish and merge it before the Saturday deadline. Vector Everywhere stays dormant: `VECTOR_EVERYWHERE_ENABLED` stays off and no flag changes. Files: `api/_lib/everywhere/jira/adapter.ts` and `packages/web/test/everywhere-jira-a2a.test.ts`, both also touched by the open #121 (Jira and Linear progress copy), whose hunks are elsewhere in those files.

## 2026-11-26, a repository prompt reopened a cancelled Jira task

**Bug.** When a native Jira message needs a repository choice, intake calls the Jira adapter's `repositoryPrompt`. It checks the task, reads the project's mapped repositories, then calls `persist` to set the task to `INPUT_REQUIRED` with the option list and write the repository draft. A signed `CancelTask` can commit while the options are being read. `persist` re-reads the task, so its write was not stale against the store, but its update callback set `INPUT_REQUIRED` regardless of the state it was handed. The cancelled task came back as waiting for input, with its draft restored, and the "Cancelled at your request." reply was replaced by the repository options.

**Fix (Codex's commit, kept as is).** `persist` accepts an update that answers `undefined`, and then writes nothing. The repository prompt's update answers `undefined` when the freshly read task is already terminal (`JIRA_TERMINAL`), so the cancellation keeps its state, its reply and no draft. Intake then finishes the delivery and starts no job. Every other `persist` caller still returns a record, so their behaviour is unchanged.

**Takeover work.** Merged origin/main (no conflicts), re-ran the evidence below on the merged tree, and added this entry. No source change was needed. The PR's earlier CI runs ended with every job cancelled (none ran to a failure), so they say nothing about the branch.

**Test.** web `test/everywhere-jira-a2a.test.ts`, "a delayed repository prompt cannot overwrite a signed cancellation or restore its draft". A wrapped fake store pauses intake at the prompt's own read of the project mapping (the third read of that key), sends a signed `CancelTask` through the loopback A2A route, then lets intake continue. The poll must answer `TASK_STATE_CANCELED` with "Cancelled at your request.", the draft key must be empty and the sponsor must have no jobs.

**Evidence** (macOS, each file run alone from `packages/web` with `bun test <file> --timeout 30000`):

- Red-before: with main's `adapter.ts` checked out and the test unchanged, the file gave 20 pass, 3 skip, 1 fail. The new case failed with `TASK_STATE_INPUT_REQUIRED` where `TASK_STATE_CANCELED` was expected. Restored from the branch, the file's sha256 matched the fixed one.
- Mutation: with the terminal branch answering `record` (the shape the other callers use) instead of `undefined`, the state stays cancelled but the draft is written again, and the case fails on the draft assertion (20 pass, 3 skip, 1 fail). Restored, sha256 equal.
- Green: `everywhere-jira-a2a.test.ts` 21 pass, 3 skip; regressions `everywhere-jira-render.test.ts` 6 of 6, `everywhere-journey-laptop-tracker.test.ts` 5 pass, 4 skip, `everywhere-journey-actions.test.ts` 11 pass, 2 skip.
- Typecheck: `bun typecheck --project ../../tsconfig.json` from `packages/engine` (the hosted API) and `bun typecheck` in `packages/web` both passed.
- The skipped cases need a real Valkey (`VECTOR_TEST_REDIS_URL`, for example "actual Redis native Jira draft fences"). They run in CI only, in the "Vector everywhere tests" job of `.github/workflows/vector-everywhere.yml`, which starts a Valkey service.

**Lead ruling.** None was needed: the PR offered no options. Scope stays the Jira adapter. The Linear adapter's repository prompt keeps no task state that a cancellation could be overwritten in (it posts activities), so it has no matching gap.
