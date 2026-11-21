# hosted-download-billing: H1-O1-O2 and H1-O4-O6-PR3

Branch `hosted-download-billing`, cut from origin/main `31dcb41b1`. It covers two Vector v2 leftover P0 items on the
cloud computer's files flow, in three commits: O1 (a job session's dropped copy), O4 with PR3 and O6 (a download-only
session's upload checked and charged only once confirmed), and O2 (a work folder too large to pack). `computer` stays
unlisted and every flag stays off, so no customer reaches any of it.

The short dated lines are in the lane's own notes, which no open PR touches: `codium-a53-hosted-sessions-notes.md`
(server), `codium-a54-hosted-image-notes.md` (hostd and daemon), `owner-actions/hosted-computer.md` and
`MODEL-PLANS.md`. This file keeps the build record. `codium-deviations.md` is left alone: fold these entries into its
"Codium finish: H1 computer (15 Nov 2026)" observations once that is wanted.

Every test file was run alone, one at a time, with `bun test --timeout 30000`. Everything is a fake: the Codium store,
Stripe, OpenRouter, the ledger, the provider and the media bucket.

## 2026-11-21, O1: a job session's dropped copy is packed again

**The gap.** `recordHeartbeat` decided between `pack` and an upload link from `next.archiveBytes`, which keeps the
size of an earlier beat. A job session's hostd drops its copy when an answer to an `uploaded` beat asks for nothing,
and a failed HEAD answered nothing. The next beat carried no size, but the server signed a link for the old size, which
hostd cannot use. The person's files never became ready.

**The fix** (`api/_lib/hosted-sessions.ts` only):
- a beat without `uploaded` asks to pack when it carries no `archiveBytes` of its own, and is signed a link for its
  own size otherwise;
- an `uploaded` beat's HEAD is still checked against the kept size, now through `checkUpload`, which answers
  `confirmed`, `rejected` or `unknown`;
- for a job session, `unknown` answers a fresh link for the same size. hostd's job path keeps its copy while an answer
  carries a link, and uploads nothing while it reports the upload, so the next beat checks again. `rejected` answers
  nothing, as before: hostd drops the copy and the next beat is asked to pack;
- download-only sessions keep their old answers here (the next commit changes them);
- `signUpload` signs the PUT and does the archives key's SADD first, as the inline code did.

**Tests** (`test/hosted-sessions-api.test.ts`, "the session's files"):
- "a job session's computer that dropped an unconfirmed copy is asked to pack again, not handed a link (O1)": after an
  `uploaded` beat with an empty bucket, beat `{}` answers `pack: true` and no link; an object of another size is
  rejected the same way; the object at its size makes the files ready.
- "a HEAD that fails keeps a job session's copy: a fresh link, and the next check decides (O1)": a timeout, a 503 and
  a 200 with no length each answer a fresh link for the same key and size, and the files are not ready; the next
  check confirms.

**Evidence.**
- Red-before: with the source change reverted in the working tree (saved diff, `git checkout --` of
  `hosted-sessions.ts`, restored with `git apply`, sha256 compared), the file gave 60 pass, 1 skip and 2 fail, the two
  new cases. The first failed at `pack` (expected true, received undefined: it was handed a link instead).
- Green: 62 pass, 1 skip, 0 fail.
- Mutation: `next.archiveBytes` put back in the pack decision and the link's size. The first new case went red (61
  pass, 1 fail). The file was restored and its sha256 matched.
- `bun typecheck --project ../../tsconfig.json` from `packages/engine` (the api check CI runs): clean.

## 2026-11-21, O4, PR3 and O6: a download is checked, asked again, and charged only once confirmed

**The gap.** A download-only start charged the kept disk's retention in `launchSession`, right after the block's hold
and before the computer had shown it could pack anything. A disk made before signed heartbeats (O6) has every beat
refused, so it delivered nothing and still paid the retention. While a beat said `uploaded`, a download session's HEAD
that never matched (O4) was never answered with anything, so the session ran out its block with no files and the
retention charged.

**The fix** (`api/_lib/hosted-sessions.ts`, comments in `api/_lib/hosted-crons.ts`):
- a download session's rejected check answers `pack: true`; an unknown one answers nothing; `readyAt` is set only on a
  confirmed check;
- the `chargeRetention` call and the `launch.download.{final, snapshot, due}` plumbing are gone from `launchSession`;
- `chargeDownloadRetention(record, due, options)` reads the snapshot with `readEntitlement`, as the start does, and
  calls the unchanged `chargeRetention` for access `final` or `current`. It runs once, inside the existing confirmation
  guard (`saved.download.readyAt === now`), after the egress waiver, with `due` from `readDiskDue` (skipped when no date
  is set), and is wrapped in `.catch(() => undefined)` so the confirmation stands;
- comments updated at the module header, `launchSession`, `startHostedDownload`, `recordHeartbeat` and the two
  provisioner comments in `hosted-crons.ts`.

**Lead call (plan section 3, accepted in the rulings).** The retention's daily-share check moves from the start to the
confirmation. A refusal there leaves the disk kept at Vector's cost instead of refusing the start.

**Tests** (`test/hosted-sessions-api.test.ts`, "download-only starts for an ended plan's kept disk (H1a)"):
- new, "the retention is charged only once an upload is confirmed; a download that delivers nothing charges none (PR3,
  O6)": no line after the start; an unsigned beat answers 403 and still no line; the session ends at its block's end
  with no line; exactly one line after the next start's confirmed upload; still one after a third start and upload;
- new, "an upload the bucket does not hold, or holds at another size, is asked for again; a failed check is only
  retried (O4)": a missing object and one of another size each answer `pack: true` and no link; a timeout, a 500 and a
  200 with no length each answer nothing; no retention until the confirming check, which sets `readyAt` and `bytes`;
- changed on purpose, from a charge at the start to "no line before an upload, exactly one after": the first case
  ("an ended plan inside the window starts one"), "the retention is charged once across two starts", "a provider that
  cannot start the computer charges no retention and no block time (PR3)" (was "charges the retention once and no
  block time") and "a live plan without a cloud computer downloads from its current period, retention included". This
  is a behaviour change, recorded here and in the lane notes, not a loosened test: each still pins the one line, its
  ref, days and period.

**Evidence.**
- Red-before: with both source files reverted to the O1 commit in the working tree (saved diff, `git checkout --`,
  restored with `git apply`, sha256 compared), the file gave 58 pass and 6 fail: the two new cases and the four changed
  ones. The PR3 case failed at its first assertion (a line after the start), the O4 case at `pack`.
- Green: 64 pass, 1 skip, 0 fail.
- Mutations, each restored with its sha256 compared:
  - the charge put back in `launchSession`: the PR3 case went red at its first assertion, with the four changed cases;
  - the confirmation-time call removed: the PR3 case went red at its after-upload assertion, with the four changed
    cases;
  - the download-mode `pack` for a rejected check removed: the O4 case went red (63 pass, 1 fail).
- Regressions, run but not edited: `test/hosted-lifecycle.test.ts` (23 pass; its :346-348 case still finds one
  retention line after a confirmed upload), `test/hosted-ledger.test.ts` (35 pass, 1 skip), plus
  `test/hosted-reaper.test.ts`, `test/hosted-copy.test.ts`, `test/hosted-clients.test.ts` and
  `test/account-delete.test.ts`, all green.
- `bun typecheck --project ../../tsconfig.json` from `packages/engine`: clean.
