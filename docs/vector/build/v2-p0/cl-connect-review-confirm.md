# cl-connect-review-confirm: CN-10 explicit retry confirm, CN-12 empty state, finished-task copy

Branch `cl-connect-review-confirm`, cut from origin/main `c89a69bd1` (2026-11-25). It covers three Vector v2 leftover
items: P1-9 CN-10-savedAt (the explicit-confirm remainder on top of Codex's merged #92), CN-12-tasks-pane and
tasks-pane-continue-copy. No flag changes: `VECTOR_EXPERIMENTAL_CONNECT` stays off, so P1-9 and CN-12 change nothing a
person sees by default. tasks-pane-continue-copy is plain app copy in the Background tasks pane.

The drafts wrote these sections under an older entry name, `v2-p0/connect-app.md`, which never reached main. They are
folded in here; that name is left out. `connected-workspace-deviations.md` is held by open PRs #162, #163, #167 and
#170, so the pointers it should get are listed under "Lane pointers to fold back" at the end.

## 2026-11-25: P1-9 CN-10, an explicit confirm before a retry that may start a new review

Files: `packages/app/src/features/connect/directory-review-reservation.ts`, `directory-review-controller.ts` and
`directory-review.tsx` beside it, their two unit tests, and `packages/app/e2e/regression/directory-review.spec.ts`.
Behind `VECTOR_EXPERIMENTAL_CONNECT`: with Connect off the directory review card never mounts.

**Problem.** Codex's #92 (merged 2026-11-24, `34a7629ea`) gave the directory review marker a local `savedAt`, reads
both the old 3-key and the new 4-key markers, and shows `retryWarning()` beside "Retry review start": advisory text
for an unknown age, a future timestamp, an age at or over 24 hours (`REPLAY_NOTICE_MS`), or a fresh marker. Nothing
asked before the retry itself. After the engine prunes a settled key (`REPLAY_MS`, 24 hours, when its directory or
the ledger is full), a retried key is a new request and can start a second review. CN-10's Done asked that such a
retry be treated as possibly new.

**Lead ruling (2026-11-25).** The safest option that fully closes CN-10's Done: an explicit "Retry anyway" confirm
before any retry of a stale or unknown-age request, built on #92's marker and warning. A fresh request retries at
once, as before. The marker shape, its `requestKey` and the wire body do not change, and the engine's replay rules
are untouched.

**Change.**

- Reservation. One private classification, `retryAge()`, reads the retained request's age as `unknown` (no
  `savedAt`, or the clock reading is not a safe non-negative integer), `future`, `old` (at least 24 hours) or `fresh`.
  `retryWarning()` maps it to #92's four sentences, byte for byte, and the new `retryStale()` is true for every age
  but `fresh` and false when nothing is retained. Both come from the same function, so the warning and the question
  cannot disagree. `retryStale()` only reads: it never writes storage, mints a key or refreshes `savedAt`.
- Controller. `admission` takes an optional `stale?: () => boolean`. `start(retry)` now runs a private
  `begin(retry, confirmed)` (the shape of draft `93e2121d0`). `start(true)` on a stale request returns before
  `hold(true)` and before any POST, and sets `state.confirmRetry = true`. `confirmRetry()` clears the question and
  runs that retry once through `hold(true)`, with the same saved key; a second click finds no question and sends
  nothing. `cancelRetry()` clears the question and leaves the marker held. Every real start clears `confirmRetry`
  with its busy update, and `retire()` drops it. A `stale` hook that throws counts as stale, so it asks. Without a
  `stale` hook (as in the reservation tests' wiring) a retry behaves as before.
- View. The view wires `admission: { ...saved, stale: () => saved.retryStale() }`, passes `confirmRetry` through its
  store explicitly (a Solid store merge would otherwise keep a stale `true`), and clears it on the unavailable path.
  While `confirmRetry` is set, a group labelled "Confirm review retry" with "Retry anyway" and "Cancel" takes the
  place of "Retry review start"; #92's warning paragraph stays beside it. Hard-coded English like the rest of the
  file, with no amounts and no plan or billing words (draft `93e2121d0`'s "counts against your plan" sentence is not
  used).

**Tests (must fail without the fix).**

- `directory-review-controller.test.ts`, with the real reservation wired as the view wires it:
  - "an unknown-age / a 25-hour-old / a future-dated saved request sends nothing until its retry is confirmed, then its
    original key once": `start(true)` sends no POST and sets `confirmRetry`; `cancelRetry()` sends none and leaves the
    marker byte for byte; the next retry asks again; a double `confirmRetry()` sends exactly one POST with the saved
    `requestKey`; the marker is then cleared.
  - "a saved request under 24 hours old retries at once with its original key, without asking".
  - "retirement drops an unanswered retry question, and a later confirmation sends nothing".
  - "a stale check that throws asks before the retry, as an old request does".
- `directory-review-reservation.test.ts`: "retryStale is true/false for …, and the warning agrees" (a legacy 3-key
  marker, a future `savedAt`, 25 hours, exactly 24 hours: true; 23 hours and just now: false; each also checks the
  warning, that storage is unchanged and that no key is minted), and "retryStale is false with nothing retained and
  true when the clock cannot be read" (NaN, -1, the 24-hour edge and after confirm).
- `e2e/regression/directory-review.spec.ts`, the existing case "a lost review response persists one opaque unpaid
  request and only explicit retry sends that same body after reload". It ages the saved marker to 24 hours and used
  to retry at once. By this lead ruling it now clicks "Retry review start", sees "Retry anyway" with no POST, cancels
  (still no POST, warning still shown), retries, confirms, and sees the same body sent once. The changed lines carry
  a dated comment; this is a ruling change, not a loosening. The case "a consumed review key is cleared …" retries a
  fresh marker twice and still needs each retry to POST, so it pins that a fresh retry does not ask.
- Mutations: (1) `retryStale()` always returns false: four controller cases go red (the three stale ones and the
  retirement case), and so do five reservation cases (the four stale ones and the clock case). (2) The controller's
  `retry && !confirmed && stale()` branch removed: five controller cases go red (the three stale ones, the
  retirement case and the throwing-hook case).
- Runs: recorded 2026-11-25 in "2026-11-25: verified" below.
- e2e (CI only): test.yml's `e2e` job runs `directory-review.spec.ts` on the PR, and `connect-app-validation.yml`
  runs it again on main after merge. With `directory-review.tsx` and `directory-review-controller.ts` from
  origin/main, the changed case fails while it waits for "Retry anyway".

**Risks.** Stale retries take one more click. A fresh retry and every engine answer (`pending`, `consumed`, a lost
response) behave as before. The question lives only in the controller's state: a reload asks again, which is the safe
direction.

## 2026-11-21: CN-12, the Background tasks pane's empty state steps aside for connected runs

Files: `packages/app/src/features/connect/task-rows-section.tsx`,
`packages/app/src/features/background-tasks/background-tasks-pane.tsx` and
`packages/app/e2e/regression/background-tasks-details.spec.ts`. Behind `VECTOR_EXPERIMENTAL_CONNECT`: with Connect
off, `connections` is false, the section never reads or renders, it reports 0 rows, and the pane is as before.

**Problem.** The pane's fallback "No background tasks" showed whenever there were no subagents, commands or
interrupted tasks, even while `ConnectTaskRows` listed connect runs below it (CN-12 Held, first bullet).

**Lead ruling (recorded 2026-11-21, kept 2026-11-25).** Fix the empty state; the launcher badge and the child-session
listing are accepted omissions, to revisit with Connect's Q1.

**Change.**

- `ConnectTaskRows` takes an optional `onRows(count)`, called with the number of rows shown whenever it changes, so 0
  while hidden, refused, off or not yet read, and 0 again when the section unmounts.
- The pane holds `connectRows` (a signal set from `onRows`), and the empty-state fallback renders only when
  `!computerCard() && connectRows() === 0`. The subagent list, the Hands card and the section itself are unchanged.

**Tests (must fail without the fix).**

- `e2e/regression/background-tasks-details.spec.ts`: "the Tasks pane hides its empty state while a connected run is
  listed, and shows it again when none is". With one connect run and no subagents the pane lists the run and does not
  say "No background tasks"; after an event whose owner read returns no runs, the section is gone and the empty state
  shows. The draft put this case in `connected-tools.spec.ts`, which open PR #128 holds, so it moved here with local
  copies of that spec's `reply`, `vectorscopeMember` and `rootRun` helpers. This spec is in `e2e/tsconfig.json` and
  runs in test.yml's app e2e job. The app has no rendering test for the pane, so a unit test would not reach the
  fallback.
- Red before: restore `background-tasks-pane.tsx` from origin/main (restoring `task-rows-section.tsx` alone also turns
  it red, since nothing then reports the rows). The first half of the case fails: "No background tasks" stays beside
  the run.
- Mutation: remove `&& connectRows() === 0`. The first half of the case goes red.
- `e2e/regression/background-commands.spec.ts` ("No background tasks" with no connections) and `hands-run.spec.ts`
  (not shown beside the Hands card) are unchanged and still hold: the first has no connected runs, and the second
  keeps the `!computerCard()` condition.
- Runs (owed): e2e only, in CI. No unit test applies.

**Accepted omissions (recorded).**

- Launcher badge. `background-tasks-button.tsx:17` counts `tasks.runningCount()` only. Connect rows come from an
  owner-only, throttled `/runs` read that runs only while the pane is mounted; counting them on the closed pane would
  need an always-on read per event, and Connect is off by default (Q1). Revisit with Q1.
- Child sessions. `features/connect/task-rows.ts:36` keeps only runs whose requester is the root conversation. A
  subagent cannot hand work to VectorScope: the connect tool refuses a subagent (engine `tool/connect.ts` `SUBAGENT`,
  :101 and :371) and the hub refuses one again ("A subagent cannot hand work to another member.", `connect/hub.ts:955`),
  so a child-session hand-off run cannot exist, and the filter fails closed.

## 2026-11-21: tasks-pane-continue-copy, a finished task no longer sends people to a session that refuses prompts

Files: `packages/app/src/features/background-tasks/background-tasks-pane.tsx` and two new files beside it,
`task-continue-copy.ts` and `task-continue-copy.test.ts` (no open PR and no other cl- branch names them). Not behind a
flag: this is the one change on this branch a person sees with Connect off.

**Problem.** Under a finished task that cannot be continued from the pane, the message box said "This task has
finished. Open its session to continue; your draft is kept." The child session page refuses prompts
(`i18n/en.ts:261` "Subagent sessions cannot be prompted.", and `:263` "This is a subagent. Talk to it from Background
tasks."), so the advice looped back to the pane.

**Change.** The note comes from a new pure module, `task-continue-copy.ts`: `taskMessageNote(editable)` returns
`TASK_DELIVERED_COPY` ("Delivered at the next safe step. Your conversation stays open.", byte for byte the old running
branch) or `TASK_FINISHED_COPY` ("This task has finished and takes no more messages. Ask in your conversation to
continue its work; your draft is kept."). The pane renders `taskMessageNote(editable())` in place of the inline
strings. Hard-coded English, as the pane's other task copy; no i18n key is added, and no other locale has the old
string. `background-tasks.ts` is not touched (no cl- branch edits it); the "Delivered at the next safe step" branch
and the resumable and ask-to-continue branches are unchanged.

**Tests (must fail without the fix).**

- `task-continue-copy.test.ts`: "a finished task that takes no more messages points to the conversation, never to its
  session", "a running task's note is unchanged", and "the pane shows this note and no longer sends people to the
  task's session" (reads `background-tasks-pane.tsx` and checks it renders `taskMessageNote(editable())` and no longer
  contains "Open its session"; the app has no rendering test for the pane).
- Mutation: put the old sentence back in `TASK_FINISHED_COPY`. The first case goes red.
- Runs: recorded 2026-11-25 in "2026-11-25: verified" below.

**Held.** The fallback also shows for a task that is still live but whose engine says it takes no messages
(`controls.message` false, not continuable because it is live). Both the old and the new copy then say "finished".
That predates this item and is left for the pane's owner.

## Other connect-app draft items

- 28 CN-15 wording on the unpinned surfaces (draft `ceb691956`): waits for #162/#163/#167/#170, which hold core
  `frame.ts` and engine `tool/connect.ts`. Not on this branch.
- 29 B4, the Connected tools card's repair option (draft `8d2dca94c`): Dropped 2026-11-25: covered by #90.
- The drafted CN-10-savedAt reservation and view hunks (draft `93e2121d0`): Dropped 2026-11-25: superseded by #92's
  marker and warning. Only the controller's `begin(retry, confirmed)` shape was reused, in a new commit.
- The old lane-pointer list (draft `64e3137f7`): not picked; the list below is written fresh.

## 2026-11-25: assembled on cl-connect-review-confirm

- Commits, in order: `a6d93990a` CN-12 (partial pick of draft `10ab52e5b`), `4f88ce103` tasks-pane-continue-copy
  (pick of draft `1b0186b68`), `91992325c` P1-9 CN-10 explicit confirm (new; controller logic adapted from draft
  `93e2121d0`), then this entry.
- Dropped from the picks: `10ab52e5b`'s `connected-tools.spec.ts` case (open PR #128 holds that file; the case was
  re-created in `background-tasks-details.spec.ts`), and both drafts' hunks of `v2-p0/connect-app.md` (folded in here).
- Pinned case changed by a lead ruling: the aged-marker case in `directory-review.spec.ts` now confirms before its
  retry, with a dated comment.
- Lead rulings (2026-11-25): P1-9, an explicit "Retry anyway" confirm before any retry of a stale or unknown-age
  request, on #92's marker and warning, while a fresh request retries at once. CN-12, fix the empty state; the badge
  count and child-session runs are accepted omissions, to revisit with Connect's Q1.
- Owner items: none. Nothing here is public, released, registered, bought or configured in production.
- Owed at assembly: the unit runs, the typechecks and `test/no-personal-paths.test.ts`, all now recorded in
  "2026-11-25: verified" below. Still owed: the e2e cases in CI (test.yml's `e2e` job;
  `connect-app-validation.yml` runs `directory-review.spec.ts` on main after merge), then push and PR.

## 2026-11-25: verified

- Merged origin/main `b57b8d53a` (#160, #117, #169) into the branch with a merge commit. None of those changes touch
  this branch's files. Open PRs were checked live after the merge (39, #68 included). None of them touches a file on
  this branch, and none covers CN-10's confirm, CN-12's empty state or the finished-task copy. Nothing was removed.
- Bun runs were done one file at a time from `packages/app` with `bun test --timeout 30000 <file>`. Each red-before
  ran with only the fix's source file restored from origin/main. Each mutation edited one line. After every run,
  `git checkout HEAD -- <file>` restored the file and `git status` was clean.
- `src/features/connect/directory-review-controller.test.ts`: green 33/33. Red-before (restored
  `directory-review-controller.ts`): 5 failed and 28 passed. The three stale cases fail at
  `expect(posts).toEqual([])` because main sends the saved request at once. "retirement drops …" and "a stale check
  that throws …" fail because `confirmRetry` is never set. Mutation (2), the confirm branch disabled: the same 5 fail.
  Mutation (1), `retryStale()` always false: 4 fail (the three stale cases and the retirement case).
- `src/features/connect/directory-review-reservation.test.ts`: green 23/23. Red-before (restored
  `directory-review-reservation.ts`): all 7 new cases fail with "retryStale is not a function" and 16 pass. Mutation
  (1): 5 fail (the four stale rows and the clock case). Extra boundary mutation, `>=` to `>` on the 24-hour check:
  "exactly 24 hours old", the clock case and #92's "savedAt is local metadata …" go red.
- `src/features/background-tasks/task-continue-copy.test.ts`: green 3/3. Red-before (restored
  `background-tasks-pane.tsx`): "the pane shows this note and no longer sends people to the task's session" fails and
  2 pass. Mutation, the old sentence put back in `TASK_FINISHED_COPY`: "a finished task that takes no more messages
  points to the conversation, never to its session" goes red.
- CN-12 has no unit run: its proof is the e2e case in `background-tasks-details.spec.ts`, which runs in test.yml's
  `e2e` job (Playwright with a dev server, CI only). Without the fix, the pane's fallback renders whenever there are
  no subagents, commands, interrupted tasks or Hands card. That is exactly the case's first half, so "No background
  tasks" shows beside the run and `not.toContainText` fails. Red-before and the `&& connectRows() === 0` mutation are
  owed to that CI job.
- Adjacent existing file: `src/features/connect/task-rows.test.ts` green 15/15. No unit or browser test renders
  `background-tasks-pane.tsx`, `task-rows-section.tsx` or `directory-review.tsx`.
- Typecheck in `packages/app`: `bun typecheck` (tsgo -b, which includes the `src` tests) clean, and
  `bun run typecheck:e2e` (both changed specs are in `e2e/tsconfig.json`) clean.
- `test/no-personal-paths.test.ts` (run from `test/`): green.
- After restore, each source file's sha256 equals its HEAD blob (first 16 hex shown):
  `directory-review-controller.ts` fd66e0004ad06ab2, `directory-review-reservation.ts` 80d053d21d6e03f2,
  `background-tasks-pane.tsx` 4b83231a3d9fcac8, `task-continue-copy.ts` c4a42b3117f9da80.
- Process note for the lead: during assembly, `4f88ce103` was re-made with `git reset --soft HEAD~1` on a local
  commit that was never pushed, to drop git's "# Conflicts" comment lines after the trailer. No change was lost. It
  is recorded here because it rewrote a local commit the way an amend would.

## Lane pointers to fold back

`connected-workspace-deviations.md` is held by open PRs #162, #163, #167 and #170, so nothing below is written there
yet. Line numbers are at `c89a69bd1`.

- CN-10 entry, Held, first bullet ("*CN-09's replay-window request is not built.*", :1242): now built. #92 added the
  marker's `savedAt` and the warning; this branch adds the explicit "Retry anyway" confirm before a retry of a marker
  of unknown age, with a future timestamp, or at least 24 hours old. See "P1-9 CN-10" above.
- CN-12 entry, Held, first bullet ("The empty-state copy … can show above connect rows, and the launcher badge does
  not count connect runs", :1396): the empty state is fixed here; the badge and the child-session runs (third bullet)
  are accepted omissions by lead ruling, with the reasons in "CN-12" above.
- `connected-workspace-handoff.md:60` says "C6 is not fully closed in the app. CN-09 asked that a key older than the
  replay window be treated as possibly new, and CN-10 does not build that". After merge, point it to this entry.
- Codium polish (triage item 21): tasks-pane-continue-copy was built here. See its section above.
