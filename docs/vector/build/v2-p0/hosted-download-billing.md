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
