# cx-review-dismissal-reader: repository dismissal reads stay out of personal memory (#170)

Takeover of Codex's draft PR #170 (branch `review-dismissal-reader`). It had been idle for more than a day, so this v2 run took it over on 2026-11-26 to finish it. No feature flag changes, no public claims, no prompt call site added.

## 2026-11-26, the dismissal reader synchronized personal and repository mirrors

**Bug.** `ReviewContext.dismissals` (engine `review/context.ts`), the VectorScope reader for owner review dismissals, asked Brain for `list(place, { scope: "repository", filter: "active" })`. The generic list first synchronizes the personal mirrors (`MEMORY.md`, `RULES.md` in the config folder) and the repository's `.vector/BRAIN.md`, which rewrites their mirror entry and source rows when the files changed. A review-only read therefore rewrote personal and repository memory rows, which a review context must never touch. (The list path itself records no use rows; the engine test checks the use table only as a guard.)

**Fix (Codex, commit `087d6ebf6`).** Brain gets `reviewDismissals(place)` (core `brain/brain.ts`): one bounded SQL read of the exact repository's active, owner-written (`origin = "user"`), non-private, non-stale, unheld, unsuperseded `review` entries, newest first then by id, capped at `LIMIT.repository`, then screened with `BrainPrivate.screened`. A held place or a blank repository returns `[]` without querying. The reader calls it instead of `list`. Its path, note and token bounds are unchanged. `REVIEW_PIPELINE_SOURCES` is refreshed to `4b0ba56d8ecc52b9`; `REVIEW_PIPELINE_REVISION` stays 5 because what a review finds or posts does not change (the reader has no caller yet).

**Tests.**

- engine `test/review/dismissals.test.ts`, "reads real repository dismissal SQL without syncing personal or repository files or recording use": a real in-memory Brain database with real mirror files. After the mirrors change on disk, the reader returns the owner note and the entry, source, state, event and use tables are unchanged; an ordinary `list` afterwards does pick up the change.
- core `test/brain/brain.test.ts`, "review-only SQL reads retain only current screened owner notes from the exact repository" (16 excluded legacy-row variants), "review-only SQL reads are bounded and ordered by newest note then id" and "held and personal places do not even query review dismissal SQL".

**Red before.** With `packages/engine/src/review/context.ts` and `packages/core/src/brain/brain.ts` back at `origin/main`, the engine real-SQL case fails on the unchanged-snapshot check (the mirror rows are rewritten from the changed files) and the three core cases fail. Restored, engine 4 pass and core brain 62 pass.

**Mutation check.** With `eq(BrainEntryTable.origin, "user")` removed from the reader's SQL, the exact-repository case fails (1 pass, 1 fail of the two SQL cases); restored, both pass.

**Lead ruling.** Removing the SQL `private = false` condition does not fail any test, because `BrainPrivate.screened` already refuses private entries. Both stay: the SQL condition keeps private rows out of the bounded window, and the screen is the second check. No test is added for a redundant guard.

## 2026-11-26, takeover checks

- Joined current `main` with a merge (no conflicts); the pinned review pipeline digest still matches after the join.
- Stacking: this branch carries the commits of #167 and #163 (and, through them, part of #162 and #128). It merges after those.
- Hosted CI on the last Codex push was cancelled before any job ran; the takeover push reruns it. Linux-only lanes (VectorScope local review, Same-FD identity and review memory) run in CI.
- Local runs, one file at a time: core `test/brain/brain.test.ts` 62 pass, core `test/review/model-evidence.test.ts` 37 pass, engine `test/review/dismissals.test.ts` 4 pass. `bun typecheck` passes in core and engine.

## 2026-11-26, finalize after review

- Review found nothing that must change. Two docs corrections: the bug note no longer says the list read path writes usage (sync rewrites mirror entry and source rows; `used()` is not on that path), and the takeover note no longer names a deadline.
- Joined the PR head and current `main` again with merges, re-ran the touched test files one at a time and `bun typecheck` in core and engine, pushed to the PR head and marked the PR ready. It still merges after #167 and #163.
