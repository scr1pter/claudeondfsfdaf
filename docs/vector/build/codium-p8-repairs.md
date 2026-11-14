# P8 phase review repairs (A51 to A58, hosted and deploy)

These repairs answer the P8 phase review ("hosted and deploy") on `codium-wt`. Each of the fourteen findings was checked
against the code first, and all fourteen were confirmed. Each repair has a regression test written so that it fails
against the previous source (reasoned from the code; the tests were not run against the old files here).
The owner's pending decisions are unchanged: Vector Labs on the pricing page, the Oct 30 model lineup and the investors
page claims. No provider, Vercel, Stripe, Supabase, R2, GitHub or phone service was called, nothing was deployed or
pushed, and no cloud-agent file was touched. Contract readings are in `codium-deviations.md` ("P8 review decisions").

## A55 Done by Morning: failed starts

**A job whose computer fails to boot was retried every minute and charged each time.** Confirmed. `startDueJob` put a
job back in the queue at its original `startAfter` after any start error that `startRefusal` read as "wait". A failed
boot is one: `startHostedSession` stops the computer and charges what ran (`endHostedSession(record, "failed")`), then
`bootHostedComputer`'s 503 `HOSTED_UNAVAILABLE` maps to "wait". Since `startAfter` was already past, the next reaper pass
started it again. **Repair:** `hostedStartFailure(error)` (hosted-sessions.ts) says whether a start failed at the provider
(`start`) or after a computer ran (`ran`). A `ran` failure misses the job at once with reason `failed`. A `start` failure
counts on the job (`startTries`) and is tried again 5, then 15 minutes after the failure (`START_RETRY_MS`, never past the
deliver-by time). The third one (`START_TRIES`) misses the job. The phone alert says "Done by Morning: a job could not
start", and the screens say "The cloud computer could not start, so Vector stopped trying." Regression
(`test/hosted-jobs.test.ts`): with every boot failing, two hours of queue passes start one computer, charge one block
of one minute and miss the job. With the provider failing every start, starts happen at 0, 5 and 20 minutes, then the job
is missed and nothing is charged.

## A53 nightly: egress charged twice

**A true-up failure kept the old egress reading.** Confirmed. `runHostedNightly` stored the new reading only after
`chargeComputer` and `trueUpComputer` both succeeded, so a failed true-up left the old reading and the next night charged
the same bytes again under its own day's line. **Repair:** the reading is stored as soon as `chargeComputer` charged,
then again with the CPU figures after the true-up. Regression (`test/hosted-reaper.test.ts`): the ledger refuses the
true-up on night 1 (2 GB charged), and night 2 charges only its own 1 GB.

## A53 budget: egress, kept disks and short months

**The worst case left out egress.** Confirmed. At the fair-use caps (Max 5 GB, Ultra 15 GB a day) and the default
$0.15/GB, egress is several times the compute figure, so the budget workflow could set a budget that the spend webhook
would hit, which stops every subscriber's computer. **The disks kept for ended plans were left out**, since only roster
accounts were counted. **A 30-day step could miss a period** that starts before the cycle ends. All confirmed.
**Repair:** `hostedBudget` adds each roster account's egress cap for each day left (at `egressGbCostMicro()`), the disk
of every computer in `hosted:names` whose account is off the roster (ended plans, disputes), and steps periods by 28
days. The answer gains `retained` and `egressGb`. Regression (`test/hosted-reaper.test.ts`): the existing budget case
now includes egress. A new case counts three periods when the cycle ends 29 days after the period, and two kept disks of
an ended plan.

## A53 nightly: storage skipped without an egress figure

**A listing with no egress figure skipped the day's storage charge.** Confirmed: `totalEgressBytes` is optional in
`@vercel/sandbox` 3.8.0, and `chargeComputer` returned early when it was missing. **Repair:** storage is charged anyway.
The last egress reading is kept (so the next figure charges everything since), and the day is stored as charged.
Regression: a computer listed with no figure pays its storage line once, and the next night's figure charges
the egress since the last reading.

## A53 provisioner: retention charged for a download that does not exist

**Ended plans paid 14 days of storage "for download" with no way to download.** Confirmed: no download-only start
exists (A53, A56). **Repair:** the provisioner keeps the disks the same 14 days without calling `chargeRetention`, at
Vector's cost (deviations entry). Regression (`test/hosted-lifecycle.test.ts`): an ended plan and a downgrade to Pro
write no retention line, and the disks are still deleted after 14 days.

## A53 start: a store fault after the first block

**A failed record write after `openBlock` left a 10-minute charge for nothing.** Confirmed. **Repair:** that write is
inside a try; on failure `failSession` closes the block at its own start before anything is asked of the provider.
Regression (`test/hosted-sessions-api.test.ts`): the first compare-and-set after `openBlock` fails. Nothing starts, the
session ends `failed`, no minute is charged, and the reaper ten minutes later charges nothing either.

## A53 start: an uncertain provider failure

**A start that timed out after the computer was made was charged nothing**, and the computer ran uncharged until the
reconciler stopped it (M8). Confirmed. **Repair:** `failSession` now asks the provider to stop the computer first. When
the provider says one was running, the block closes at that stop. When none was, it closes at its start. When the stop
fails too, the session is left stopping with its block open, and the reaper's stop closes it when the computer stops.
Regression: a start that makes the computer and then times out 90 seconds later is charged 2 minutes. When neither the
start nor the stop answers, the session waits, stopping, and the reaper charges the 3 minutes it ran. The existing case
where the provider never makes the computer still charges nothing.

## A53/A54 heartbeats: any process could report for hostd

**The agent could forge heartbeats.** Confirmed. The provider's proxy adds the run token to every request for the
run-API host, and `nftables.conf` lets uid 10001 reach any address on tcp/443. So beats that drop `busySince` or move
`activeAt` could defeat the busy-processor and idle checks. **Repair:** hostd signs its heartbeats (`run-api.ts`). It
makes a 32-byte key before the agent exists, keeps it in memory, sends it as `hostdKey` until a beat is answered, and
adds `mac` (HMAC-SHA256 over `Hosted.hostdMacInput(session, body)`). The server (`requireDaemonBeat`) registers the first
key with SET NX (`hosted:hostd:<sid>`). It refuses an unsigned beat, a beat signed with another key, and a beat that
offers another key (403 `HOSTED_RUN_REFUSED`). The job comes only in an answer, so the agent can never register first.
Regressions: `test/hosted-sessions-api.test.ts` covers an unsigned beat, a key of the agent's own (offered or not) and a
body changed after signing. All are refused, and the daemon's busy processor stands. In
`packages/hosted-computer/test/hostd.test.ts`, every beat is signed, the key goes out only until a beat is answered, and
a report cannot carry its own key or signature. The root test helpers sign their beats with `daemonBeat`
(`test/hosted-sessions-fixture.ts`).

## A55 recordings: a forged segment number

**One report of segment 999,999 pushed every real segment out of the window.** Confirmed. **Repair:** besides the
signing above, a reported segment above (minutes since the session's first block) + 1 + 2 × take-overs is ignored. The
session record now counts `takeovers`. Regression (`test/hosted-jobs.test.ts`): segments 999,999 and 12 right after the
start get no link and fill no slot. Twelve minutes later, segment 12 does.

## A55/A56 judged reports

**The agent wrote the verdicts the screens called a second lab's.** Confirmed. The server checks only that the session
asked the named judge after step 1. **Repair (wording, until the server asks the judge itself):** `verdictLine` says
"Vector reports N of M criteria met." (or "This report has no pass or fail for each criterion."). The composer's
criteria label says "the report says whether each one was met". Code comments, the schema's docs, MODEL-PLANS and the
owner guide say the same. Regression (`packages/app/src/features/cloud/hosted/hosted-model.test.ts`): the line names no
lab and says nothing was checked.

## A57 account deletion: packed files

**Session archives were left to the bucket's lifecycle rule.** Confirmed: `eraseAccountHosted` deleted records and
recordings but never `archiveKey(account, id)`. **Repair:** `eraseSessionArchives` runs before the session records go. It
deletes every session an upload link was signed for (`hosted:archives:<account>`, noted when the link is signed) and
every session whose record says files were asked for. A refusal other than 404 throws, so the deletion cron retries.
Account erasure also deletes the new `hosted:hostd:<sid>` and `hosted:handoff-alert:<sid>` keys. Regression
(`test/account-delete.test.ts`): while the media bucket refuses, deletion stays pending with `computer` failed and the
identity kept. Once it answers, the archive is deleted (its key names no account id) and the deletion finishes.

## A56 hand-over alerts

**A flapping hand-over alerted on every beat.** Confirmed. **Repair:** at most one alert per session in 10 minutes
(`SET NX hosted:handoff-alert:<sid> PX 600000` before sending, `HANDOFF_ALERT_GAP_MS`). Regression
(`test/hosted-clients.test.ts`): a hand-over that goes, comes back and changes reason within ten minutes sends no second
alert. The next new one after the window does.

## A56/A58 the Vercel CLI

**`npx --yes vercel@65.3.1` ran its dependencies' install scripts with the token in the environment.** Confirmed, in the
budget job (Billing token) and the image job's registry login. **Repair:** `vercelCli` installs the pinned CLI once per run
with npm into a new temporary folder, with install scripts off and only PATH, HOME and TMPDIR in npm's environment. It
checks the installed version, then runs that install's `vercel` with the token and only the names it needs (`CLI_ENV`).
The lockfile pin the finding preferred is recorded in the deviations entry. Regression
(`packages/cloud/src/hosted-budget.test.ts`): one install with `--ignore-scripts` and no secret, every run with the token
and allowed names only, and nothing runs when the installed version is not the pin.

## Tests run here (one file at a time)

| Directory | File | Result |
|---|---|---|
| `test/` | `hosted-sessions-api.test.ts` | 29 pass, 1 skip (Valkey, CI) |
| `test/` | `hosted-reaper.test.ts` | 24 pass |
| `test/` | `hosted-lifecycle.test.ts` | 15 pass |
| `test/` | `hosted-jobs.test.ts` | 31 pass, 1 skip (Valkey, CI) |
| `test/` | `hosted-clients.test.ts` | 8 pass |
| `test/` | `hosted-copy.test.ts` | 5 pass |
| `test/` | `hosted-ledger.test.ts` | 28 pass, 1 skip (Valkey, CI) |
| `test/` | `account-delete.test.ts` | 28 pass, 1 skip (Valkey, CI) |
| `test/` | `api-module-loading.test.ts`, `no-project-wording.test.ts`, `no-topups.test.ts` | 1, 2, 4 pass |
| `packages/hosted-computer` | `test/hostd.test.ts`, `test/source.test.ts`, `test/daemon.test.ts` | 15, 3, 8 pass |
| `packages/cloud` | `src/hosted-budget.test.ts`, `src/hosted-image.test.ts`, `src/workflow-compliance.test.ts` | 22, 8, 45 pass |
| `packages/app` | `src/features/cloud/hosted/hosted-model.test.ts` | 14 pass |

Typecheck: the root `tsconfig.json` (api), `packages/schema`, `packages/hosted-computer`, `packages/cloud`
(`tsgo --noEmit`) and `packages/app` (`tsgo -b`) are clean. `bun run build` in `packages/hosted-computer` and
`node --check dist/hostd.mjs` pass. The heartbeat, reaper, nightly and account-deletion routes were each loaded in their
own Bun process. No generator input changed.

## CI only and not done

- The Valkey and Postgres cases are skipped here, as before. Signed heartbeats have not met a real computer: the image
  must be rebuilt (A58's image workflow) before a computer's hostd signs its beats, and an older image's hostd would be
  refused.
- The server still does not see the judge's answer. Server-side judging (the server asking the named judge through the
  gateway, or the gateway keeping that completion) is left for the package that turns the judge routes on (A60).
- The Vercel CLI's dependencies are still resolved at run time, with install scripts off and no secret. Pinning them in
  a lockfile needs network access to update bun.lock.
- A download-only start for an ended plan's disk is still not built. When it is, the provisioner should charge
  `chargeRetention` again.
