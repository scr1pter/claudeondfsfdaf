# A55: Done by Morning

A55 builds Done by Morning on top of A53's sessions and A54's computer: jobs queued before bed with success criteria,
each run as one cloud computer session, ending with a report that a model from another lab checks against each
criterion, a short recording only the owner sees, and an Approve that opens the job's pull request. No provider,
Supabase, R2, Stripe, OpenRouter, GitHub or phone service was called: all are fakes in the tests. Nothing was deployed or
pushed.

## What changed

| Area | Files |
|---|---|
| Jobs | `api/_lib/hosted-jobs.ts` (new): records, `enqueueHostedJob`, recurring jobs, the queue's pass, the report and its judge, approve, cancel, recordings, the plan's transitions, account erasure, `overnight`'s readiness |
| Routes | `api/_lib/hosted-jobs-api.ts` (new, the handlers); `api/hosted/jobs.ts`, `api/hosted/jobs/[id].ts`, `api/hosted/jobs/[id]/report.ts`, `api/hosted/jobs/[id]/approve.ts` (new) |
| Registration | `api/_lib/hosted-jobs-runtime.ts` (new): the queue's runner and the heartbeat's recording hook, imported by `api/hosted/reaper.ts` and `api/hosted/sessions/[id]/heartbeat.ts` |
| Sessions | `api/_lib/hosted-sessions.ts`: `registerHostedHeartbeatHook`, run at the end of a live session's heartbeat |
| Gateway | `api/_lib/hosted-run.ts`: the existing hook also logs each hosted request's model and lab (for the judge) |
| Provisioner and listing | `api/_lib/codium-provisioners.ts`: `hosted` runs Done by Morning's part first; `api/_lib/codium-perks.ts`: `overnight`'s readiness |
| Catalog | `api/_lib/model-plan-models.ts`: `servedJudges(plan)` |
| Schema | `packages/schema/src/hosted.ts`: job states, reasons, queue states, ids, limits, `DELIVER_LABEL`, `JobView`, `ReportView`, `RecurringView`, the heartbeat's `segments`/`uploadedSegments`, the answer's `recording`, five error codes |
| Computer | `packages/hosted-computer/src/daemon.ts` (reports and uploads a job's segments, flushes them before `done`), `recorder.ts` (`settled()`), `hostd.ts` (wiring) |
| Router | `vercel.json`: the run-API host also passes `/api/hosted/jobs/jb_…` (the report) |
| Docs | `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-computer.md` ("Done by Morning"), `codium-deviations.md` ("A55 Done by Morning") |
| Tests | `test/hosted-jobs.test.ts` (new), `packages/hosted-computer/test/recording.test.ts` (new) |

## Edits to `api/_lib/model-plan-*.ts`

- `model-plan-models.ts`: new export `servedJudges(plan, fetcher, options)`, the plan's Second opinion judges as the
  gateway serves them now (worker → judge) and each served model's lab. Nothing else changed.

## How it works

- **Queueing** (`POST /api/hosted/jobs {prompt, criteria, deliverBy, startAfter?, jobMinutes?, size?, title?, pages?}`,
  a marked token or a website session) builds a §4.17 trigger and calls `enqueueHostedJob(trigger)`, the single entry
  every source uses. It checks the source (reserved ones get `HOSTED_JOB_REFUSED {reason: "source-unavailable"}`), the
  services, the `hosted` switch, the listing or allowlist, holds, the plan from the snapshot, the job itself, and then,
  in one script with queueing it, the plan's jobs a night (UTC date of the deliver-by time) or recurring jobs a day.
- **The queue** runs from the reaper every minute (`runDueHostedJobs`): running jobs whose session ended become
  `reported` or `incomplete`; due recurring jobs queue their run through the same entry; due jobs start when the plan is
  active, the switch on, the listing open and a place free among the plan's jobs at once, as ordinary sessions
  (`source: "schedule"`) with a prompt that carries the criteria, the time it aims for, its pages and how to report. A
  job still queued at its time is `missed`.
- **The report** (`POST /api/hosted/jobs/<id>/report`, the job's own `vht_` token through the run-API host): first the
  work, answered with the judge to ask (another lab than every model the session used); then that judge's pass or fail
  per criterion, accepted only after the gateway logged the session asking it. With no such judge served, the report
  stands unjudged.
- **Approve** answers the pull request's address for the person's client to open; the server writes nothing.
- **Recordings.** A job session's heartbeat answers carry `recording`; hostd then reports its finished segments among
  the last ten and PUTs each to the signed link the next answer carries; the server counts a segment once a HEAD shows
  its size. The owner gets 15-minute links for 30 days after the job ended.
- **The plan.** Renewing starts nothing; a failed payment pauses the queue; a dispute cancels it (recurring jobs kept);
  an ended plan or a plan without Done by Morning cancels it and removes recurring jobs; account deletion erases it,
  recordings first.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| root | `test/hosted-jobs.test.ts` (new) | 29 pass, 1 skip (Valkey, CI) |
| root | `test/hosted-copy.test.ts`, `test/hosted-sessions-api.test.ts`, `test/hosted-reaper.test.ts`, `test/hosted-lifecycle.test.ts`, `test/hosted-ledger.test.ts` | 5, 25 (1 skip), 21, 15, 28 (1 skip) pass |
| root | `test/api-module-loading.test.ts`, `test/no-topups.test.ts`, `test/no-project-wording.test.ts`, `test/codium-outbox.test.ts`, `test/account-delete.test.ts`, `test/account-delete-api.test.ts` | 1, 4, 2, 18 (2 skip), 9, 8 pass |
| web | `test/codium-public.test.ts`, `test/codium-configuration.test.ts`, `test/model-plan-models-api.test.ts` | 13, 11, 11 pass |
| hosted-computer | `test/recording.test.ts` (new) | 7 pass |
| hosted-computer | `test/daemon.test.ts`, `test/recorder.test.ts`, `test/source.test.ts`, `test/hostd.test.ts` | 8, 3, 3, 14 pass |

What `test/hosted-jobs.test.ts` covers: queueing from the desktop and the phone with its view (counts and times only,
P1) and the session's prompt ("Aims to deliver by", the criteria, never merge); jobs a night counted at enqueue on the
deliver-by date and refunded on cancel; the job's own checks (criteria, time, minutes, size, pages, start, extra
fields); reserved sources and non-hosted targets; S1 refusals (Pro, paused, frozen, the switch, not listed, run tokens,
unmarked tokens); jobs at once and computers at start; hours at start (missed); waiting until the start and missed at
the time; renewing and paused; a dispute, an ended plan and a downgrade through the provisioner; the runner cancelling
after a missed transition; the report's token (account token, browser headers, another job's session); the judge from
another lab and the verdict only after asking it; unjudged reports; `chooseJudge`'s rules; incomplete jobs; report
checks; Approve with no call to the code host and nothing to approve; another account's job; recurring jobs' pages, cap,
schedule, single queueing, day counter, prompt, late runs and removal; recordings' signed uploads, size checks, window,
owner links and the 30 days; no recording for other sessions; account erasure with the bucket deletes; `overnight`'s
readiness; the gateway's model log; the run-API host rule; the runtime registration.

Typecheck: the root `tsconfig.json` (api), `packages/schema` and `packages/hosted-computer` (`tsgo --noEmit`, with its
tests) are clean. `test/hosted-jobs.test.ts` is outside every typecheck config; it was checked once with a temporary
config (Bun and Node types) and is clean. Every new route, the reaper, the heartbeat, chat, `/models`, status, the
outbox, the webhook, config, account deletion and the new modules were each loaded first in their own Bun process (import
cycles). `bun run build` in `packages/hosted-computer` and `node --check` on the bundle pass.

## CI only

- **The Lua.** The last case of `test/hosted-jobs.test.ts` runs ENQUEUE, REFUND, SLOT, RECUR and MODELS on Valkey when
  `VECTOR_TEST_REDIS_URL` is set. This Mac has no Valkey: only their TypeScript copies in the test ran here.
- **The SQL.** With `VECTOR_TEST_POSTGRES_URL` set, the ledger lines of the jobs' sessions go through A51's `hosted.sql`.
- **Never exercised anywhere:** a real computer recording and uploading segments to a real R2 bucket, a real phone
  alert, a real judge request through the gateway, and the crons on Vercel.

## For later packages

- **A56:** the desktop and phone call `/api/hosted/jobs` (queue, list, cancel, approve) and `GET /api/hosted/jobs/<id>`
  for the report and its recording links (MPEG-TS segments, `video/mp2t`). Show `Hosted.DELIVER_LABEL`, never a promise.
- **A57:** the provisioner already erases Done by Morning on `closing`; A57 can call `eraseAccountHostedJobs(account)`
  directly, before `eraseAccountHosted`.
- **The computer-use build (Codex):** the agent sends the report itself, as the job's prompt says: step 1 `{summary,
  links?, pullRequest?}` to `POST /api/hosted/jobs/<id>/report` on the run-API host (no credential, no `Sec-Fetch-*`), then
  asks the named judge through the gateway and sends `{judge, results}`.
- **Whoever builds hostd's git-token route** makes pull requests from jobs possible; Approve already handles them.
- **A60:** accepting the judges' routes turns judged reports on; list `overnight` with `computer`.

## Not done

- hostd's `/api/hosted/sessions/<id>/git-token` (A54's ask): a server-issued write token for a subscriber's repository
  needs A59's repository binding and an S9 decision. Until then a job cannot push or open a pull request.
- No screens (A56). No `vector` CLI command for jobs.
- `overnight` stays unlisted: it lists only with `computer` (contract §1.2).
- No generators were run: no engine route, SDK input or config schema changed.
- Nothing was pushed or deployed. bun.lock was not touched.

**Status, 9 Nov 2026 (P8 review).** The sections above describe their own day. P8's review (`codium-p8-repairs.md`)
changed A55: a job whose computer ran and failed is missed at once (`failed`), and a start that failed at the provider is
tried again 5 and 15 minutes later and missed at the third failure (`START_TRIES`); a recording segment newer than the
session's minutes allow is ignored; and the report's pass or fail per criterion is shown as Vector's report, since the
server checks that the judge was asked, not what it answered. "Checked by a model from another lab" above is no longer
what the screens say.
