# replay-held-settlements: early held and needs-approval results replay on a lost acknowledgement (PR #140)

Branch `replay-held-settlements` (PR #140), opened by Codex on 2026-11-24 and taken over by this v2 run on 2026-11-26 after it sat idle for more than a day. This run's work branch is `cx-replay-held-settlements`. It closes the EV-03 follow-up recorded in `vector-everywhere-deviations.md` under "Same class, left open" and "Not changed, follow-up", and in `vector-everywhere-handoff.md` under "Single settles outside the push boundary (EV-03, open)". The feature stays dormant: `OFFER_KEYS` is empty and `VECTOR_EVERYWHERE_ENABLED` stays off.

The branch is stacked on PR #118 (`everywhere-publication-ack`), which adds the `SettlementEnded` handling in `deliver`. #118 must merge first; after that this PR's own diff is only the runner change and its test. Both log files above are touched by other open PRs, so this entry lives here. Fold it back into those two places once they are free.

Files: `packages/desktop/src/main/everywhere-runner.ts` and `everywhere-runner.test.ts`.

## 2026-11-26, a lost early held or needs-approval acknowledgement no longer becomes a failed result

**Bug.** Two of the runner's results were sent with a single `deps.jobs.settle` call instead of `deliver`: the `held` result when the computer has no safe unattended worktree, and the `needs-approval` result when the session asked for a permission or a question. If that one call threw (a lost acknowledgement or a transport failure), the catch block sent `outcome: "failed"` (the initial value) with the fixed summary "The unattended job ended without publishing changes." That contradicts the result the runner meant to send, and for `needs-approval` it also dropped the summary and the list of needed permissions.

**Fix (Codex, commit `abeab79be`).** Both paths go through `deliver`, the runner's bounded settlement delivery (three attempts, the same result each time, a fixed local warning when none is acknowledged, and no retry once the server answers `JOB_ENDED`). Neither path commits, pushes or opens a pull request. This run also records the outcome as `settled = await deliver({...})`, the shape the review asked for and the one the third early `held` path (worktree unavailable) already uses. That assignment is not observable today, because `deliver` never throws and both paths return at once, so the catch block cannot run.

**Test.** `packages/desktop/src/main/everywhere-runner.test.ts`, "a lost early held acknowledgement replays the original result" and "a lost early needs-approval acknowledgement replays the original result". A fake jobs client loses the first settle. Each case expects exactly two identical attempts with the original outcome, summary and (for `needs-approval`) `needs: ["external_directory"]`, no commit, push or open-pr call, and an empty ledger afterwards.

**Red before.** With `everywhere-runner.ts` restored to the commit before the fix (`abeab79be^`, #118's code), both cases fail and the other 68 pass. With it restored to origin/main, the same two fail along with #118's own cases. Restored to this branch, 70 pass.

**Mutation check.** With only the `needs-approval` path sent through a single `deps.jobs.settle` again, its case fails (69 pass, 1 fail); restored, 70 pass.

**Checks run (one file at a time).** Desktop `everywhere-runner.test.ts` (70 pass), `everywhere-ledger.test.ts` (9 pass) and `everywhere-wiring.test.ts` (31 pass); schema `test/everywhere.test.ts` (59 pass). Desktop, schema and API (`packages/engine`, `bun typecheck --project ../../tsconfig.json`) typechecks pass. The PR's earlier CI run was cancelled by the runner queue, not by a failure, so the whole "Vector everywhere tests" job and the hosted CI shards run again on the next push.

**Not changed.** The three `decline` calls before a job starts (two for a repository that is not mapped, one for a changed GitHub trigger) are still single calls. If one throws, the catch block sends a `failed` result with the fixed summary instead of the decline. That uses a different endpoint and was not part of this follow-up, so it is left as is.
