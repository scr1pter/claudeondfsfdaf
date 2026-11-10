# A53: Sessions API, reaper and nightly

A53 builds the cloud computer's sessions on top of A51 (the ledger) and A52 (the provider): starting a session with
every check the contract lists, the computer's heartbeat, take-over, the live view's tokens, the session's files, the
reaper, the nightly job, the drift check, the budget answer, the owner's flags and the `hosted` provisioner. No
provider, Supabase, R2, Stripe, OpenRouter or other service was called: all are fakes in the tests. Nothing was
deployed or pushed.

## What changed

| Area | Files |
|---|---|
| Sessions | `api/_lib/hosted-sessions.ts` (new): records, leases, start, stop, take-over, viewer links, files, the heartbeat, the run-token checks, status and computers |
| Tokens | `api/_lib/hosted-tokens.ts` (new): `vht_` run tokens, Ed25519 viewer tokens, download links, the S7 header check |
| Background | `api/_lib/hosted-crons.ts` (new): the reaper, the nightly job, the drift check, the budget figure, the provisioner's work, account erasure |
| Routes | `api/_lib/hosted-api.ts` (new, the handlers); `api/hosted/{sessions, status, computers, reaper, drift, nightly}.ts`, `api/hosted/sessions/[id]/{stop, takeover, release, heartbeat, viewer, download}.ts`, `api/hosted/admin/{flags, budget}.ts` (new) |
| Gateway | `api/_lib/hosted-run.ts` (new): registers the `vht_` verifier, the hosted session check and the model-activity hook; imported by the chat, `/models` and estimate routes. `api/_lib/model-plan-caller.ts`: run tokens refused with browser headers (S7) |
| Provider | `hosted-provider.ts`: `boot` in the interface, `bootArguments`, `bootHostedComputer`, `destroyHostedComputer`; `hosted-provider-vercel.ts` and `-cloudflare.ts`: `boot` |
| Provisioner and listing | `api/_lib/codium-provisioners.ts`: `hosted` replaces the stub; `api/_lib/codium-perks.ts`: `computer`'s readiness |
| Rates | `api/_lib/hosted-rates.ts`: `HOSTED_DISK_GB_MAX` (16), `weightedMinuteCostMicro` |
| Schema | `packages/schema/src/hosted.ts`: session states, end reasons, sources, ids, timings, viewer token format, boot command, `SessionView`, `Heartbeat`, `HeartbeatAnswer`, new error codes |
| Settings | `.env.example`: `VECTOR_HOSTED_RUN_SIGNING_KEY`, `VECTOR_HOSTED_VIEWER_SIGNING_KEY`, `VECTOR_HOSTED_BUDGET_READ_SECRET`; `vercel.json`: the three crons and the run-API host's redirect |
| Owner | `api/_lib/codium-owner-api.ts`: `requireRecentGoogleSignIn` exported |
| Docs | `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-computer.md` ("Sessions, the reaper and the nightly job"), `codium-deviations.md` ("A53 Sessions API, reaper and nightly") |
| Tests | `test/hosted-sessions-api.test.ts`, `test/hosted-reaper.test.ts`, `test/hosted-lifecycle.test.ts`, `test/hosted-copy.test.ts`, `test/hosted-sessions-fixture.ts` (new); `packages/web/test/fixture/codium-fakes.ts` (`HDEL`, `INCRBY`, `PEXPIRE`); expectations in `packages/web/test/codium-configuration.test.ts` (crons) and `test/hosted-ledger.test.ts` (key scan) |

## Edits to `api/_lib/model-plan-*.ts`

- `model-plan-caller.ts`: `requireModelPlanCaller` calls `refuseBrowserShaped(request.headers)` for a `vht_` token
  before verifying it (S7). Nothing else changed.

## How it works

- **Start** (`POST /api/hosted/sessions {size, jobMinutes, prompt, title?}`, a website session or a marked token):
  the hosted configuration (provider, ledger, both keys), a hold on the account, A51's `requireHostedStart` (switch,
  listing or allowlist, the plan from the snapshot, size, job length, hours), a computer number by lease (CLAIM), the
  session record, A51's first `openBlock`, a run token living until 10 minutes after the block's stopBy, A52's
  `startHostedComputer` with that token, then `bootHostedComputer` (`/opt/vector/boot.sh --run-host <host> --session
  <id>`, no credential). A provider that fails to start charges nothing; a computer that started but did not boot is
  stopped and charged.
- **The heartbeat** (`POST /api/hosted/sessions/<id>/heartbeat`, the run token only, through the run-API host; no
  `Origin`, `Sec-Fetch-*` or cookie): the daemon reports CPU, last activity, page loads and egress (cumulative), booted,
  done, packed files. The answer carries the state, who has control, the deadline, `wrapBy`, whether the browser may be
  used (§4.2's ramp), the viewer key, the job until it booted, and an upload link when the person asked for the files.
- **The person** can stop (idempotent), take over (30 minutes at most; the gateway refuses the agent's model requests
  meanwhile), release, ask for a viewer link (`#vt=` single-use five-minute Ed25519 token; control only in a take-over)
  and ask for the files (a 24-hour link once packed). Status and computers carry shares, counts and times only.
- **The reaper** (every minute): A51's settle queue; every live session (plan state, switch and holds; fair use; done;
  wrap-up time; stopBy; heartbeat; take-over limit; idle; paused wrap-up; deadline; the next block from 3 minutes
  before the current one ends or a wrap-up; a fresh run token); A52's reconciler; A55's due jobs once registered; the
  pool's unapplied debits.
- **Nightly** (02:30 UTC): disks past their retention deleted; storage (16 GB worst case, live plans) and egress charged
  once per computer and day; ended sessions' blocks trued down on computers running nothing; the budget figures cached.
- **Drift** (every 10 minutes): lifecycle minutes against charged minutes per account with recent activity; the owner
  is emailed when charges fall behind.
- **Provisioner** (`hosted`): roster upkeep; paused → wrap up within 5 minutes; ended/frozen/no plan → stop; ended or a
  plan without a cloud computer → disks kept 14 days (charged to the final period by A51's `chargeRetention`), lost
  dispute → 30 days at Vector's cost, frozen → no date; closing → `eraseAccountHosted`.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| root | `test/hosted-sessions-api.test.ts` (new) | 24 pass, 1 skip (Valkey, CI) |
| root | `test/hosted-reaper.test.ts` (new) | 21 pass |
| root | `test/hosted-lifecycle.test.ts` (new) | 15 pass |
| root | `test/hosted-copy.test.ts` (new) | 5 pass |
| root | `test/hosted-ledger.test.ts` (key-scan expectation) | 28 pass, 1 skip (Valkey) |
| root | `test/hosted-provider.test.ts`, `test/api-module-loading.test.ts`, `test/codium-outbox.test.ts`, `test/no-topups.test.ts`, `test/no-project-wording.test.ts`, `test/phone-app.test.ts` | 39 pass 1 todo, 1, 18 pass 2 skip, 4, 2, 11 |
| web | `test/codium-configuration.test.ts` (crons), `test/model-plan-caller.test.ts` | 11, 40 pass |

What the new files cover:
- **S1 (done criterion):** Pro has no cloud computer; Max refuses the large size and jobs over 4 hours; Max runs one
  computer at once, Ultra three and the large size; paused, frozen, the switch at no-new, a hold and an unlisted perk
  each refuse; run tokens are refused by every route the person uses (S3); another account's session is not found;
  control links need a take-over.
- **Sessions:** the start's exact provider calls and the run token's claims and lifetime; failure paths; stop at the
  moment the computer stopped (8 minutes charged for 7m10s), idempotent stop, a stop the provider cannot make; take-over
  and release with the gateway check; viewer tokens checked with the computer's key; the heartbeat's job hand-off and its
  S7 and S3 refusals; the gateway's caller gate with a live and an ended session; the files flow end to end with no
  account id in the link; status, computers, owner flags (S5); `computer`'s readiness; the Vercel boot step.
- **Reaper:** block renewal with a new token and lease; deadline wrap-up and stop with every minute charged; a refused
  block; idle; model requests as activity; heartbeat loss (3 and 5 minutes); done; the take-over limit; the switch;
  a provider that cannot stop; the three fair-use limits (and a busy processor that works); the orphan reconciler; due
  jobs; a lapsed block charged in full; cron auth; nightly charges and true-up (never below cost, idempotent); no
  true-up while a session runs; drift; the budget answer and its secret.
- **Lifecycle:** every row of §4.4's cloud computer column, plus returning subscribers, downgrades, won and lost
  disputes, upgrades, no plan, and account deletion (P5: no hosted key left, the pseudonymous line kept).
- **Copy:** every hosted answer has only copy fields and counts/shares/times (P1); the schema names no amount; every
  hosted message avoids amounts, GitHub, Actions and promises (H3, H4); no client package imports the rates or the
  API's hosted modules; the run-API host's redirect.

Typecheck: the root `tsconfig.json` (api) and `packages/schema` (`tsgo --noEmit`) are clean. The new test files are
outside every typecheck config; they, `test/hosted-provider.test.ts` and `test/hosted-ledger.test.ts` were checked once
with a scratch config (Bun and node types) and are clean. Every entry route was also loaded first in its own Bun
process to rule out an import-cycle failure (`codium-provisioners.ts` now imports the hosted modules).

## CI only

- **The Lua.** The last case of `test/hosted-sessions-api.test.ts` runs SAVE, CLAIM and LEASE on Valkey when
  `VECTOR_TEST_REDIS_URL` is set. This Mac has no Valkey: only their TypeScript copies in `test/hosted-sessions-fixture.ts`
  ran here.
- **The SQL.** With `VECTOR_TEST_POSTGRES_URL` set, every ledger line in the four new files goes through A51's
  `hosted.sql` on the disposable Postgres; locally only the in-memory ledger ran.
- **Never exercised anywhere:** a real provider (create, resume, boot command, run-token updates, stop), Vercel's router
  applying the run-API host's redirect, a real R2 bucket for the files, real crons on Vercel, the computer's daemon
  (A54) and a real Resend email.

## For later packages

- **A54:** boot.sh takes exactly `--run-host <host> --session <id>`; the daemon heartbeats every 30 seconds to
  `https://<host>/api/hosted/sessions/<id>/heartbeat` (`Hosted.Heartbeat`, answers `Hosted.HeartbeatAnswer`), sends
  `booted: true` once it has the job, `done: true` when the agent finished, `cpu` (0–100), `activeAt`, cumulative
  `pageLoads` and `egressBytes` (excluding the run-API host), and on an `upload` request packs the data path to
  `archiveBytes` and PUTs it with the given headers, then sends `uploaded: true`. It pauses the agent and the recorder
  while `control` is `person`, wraps up by `wrapBy`, and disables the browser while `browser` is false. The viewer proxy
  checks viewer tokens with `viewerKey` (`checkViewerToken` in `api/_lib/hosted-tokens.ts` is the reference) and keeps
  the jtis it accepted. The base image must stay at 6 GB or less (`HOSTED_DISK_GB_MAX`).
- **A55:** `registerHostedJobsRunner` runs `hosted:jobs:due` from the reaper; start sessions with
  `startHostedSession(account, {…, source: "schedule"})`.
- **A56:** the desktop and phone call the routes above; the pre-start ceiling is the estimate's hosted form; the budget
  workflow reads `/api/hosted/admin/budget?cycleEnd=<ms>` with `VECTOR_HOSTED_BUDGET_READ_SECRET`. Downloading an ended
  plan's disk (§4.4's 14 days for download) needs a download-only start, which no package builds yet.
- **A57:** the provisioner already erases everything on `closing` (`eraseAccountHosted` in `hosted-crons.ts`); A57 can
  call it directly.

## Not done

- `/api/hosted/spend` from §4.19 (the hosted team's spend webhook is A13's `/api/owner/spend-vercel`).
- Downloading a stopped computer's disk; Done by Morning (A55); the image and the daemon (A54); screens (A56).
- `computer` stays unlisted: listing waits on Vercel's written OK, the computer-use build, the brand name and the
  security review (contract §1.2).
- bun.lock was not touched. Nothing was pushed or deployed.

**Status, 9 Nov 2026 (P8 review).** The sections above describe their own day. P8's review (`codium-p8-repairs.md`)
changed A53 in seven places: the nightly job stores the egress reading as soon as it charged (no double charge after a
failed true-up) and charges storage when a listing has no egress figure; the budget figure adds egress at the fair-use
caps and the disks kept for ended plans, and steps periods by 28 days; an ended plan's 14 days of disk retention are no
longer charged while no download-only start exists; a store fault after the first block charges nothing; a start whose
outcome the provider could not tell is charged up to the computer's stop; every heartbeat must be signed by hostd's own
key (`hosted:hostd:<sid>`); account deletion deletes the sessions' packed files (`hosted:archives:<account>`).
