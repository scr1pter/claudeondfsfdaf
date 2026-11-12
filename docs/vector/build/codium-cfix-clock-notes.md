# CFIX: the Stripe fixture scenarios run on their own clock

This package fixes the calendar failures handed on by the P3 review (footnote (\*) in
[codium-p3-repairs.md](codium-p3-repairs.md)) and assigned by the lane coordinator as CFIX. It sits between P3
(A17 to A20) and P4. Handoff §8.8 lists P4 (A21 to A26) as the next phase; CFIX starts none of it and pulls nothing
forward. No Stripe fixture JSON and no contract text changed, and every existing assertion is kept as it was. The one
production change passes reconcile's own `now` on to its `purchase-confirmation` enqueue (see "Reconcile's clock reaches
the purchase confirmation"). No live Stripe, OpenRouter or GitHub call was made. No file the @vector lane
shares (`api/cloud-agents/*`, `api/_lib/cloud-agents-*.ts`, `api/_lib/github-oidc.ts`,
`packages/engine/src/cli/cmd/github.review.ts`, `packages/core/src/review/format.ts`) was touched. The owner's policy is
untouched: larger fixed reservations, current context windows, `ROUTE_ACCEPTANCES` empty, Sol staged.

## Cause

The fixtures were not the cause. Each Stripe fixture under `packages/web/test/fixtures/stripe/` is a fixed epoch with
its own moment, `now` (early October 2026). Most scenarios already reconcile it at `fixture.now * 1000` through the
existing seams: the `now` parameters of the account, webhook, entitlement and outbox functions, and the `FakeClock`
that `codiumFakes({ now })` shares between the fake store, the fake Stripe and the fake OpenRouter. Two scenarios
failed because a later step read the wall clock instead:

- `test/codium-billing.test.ts`, "a dispute on last month's charge…": three `reconcileModelPlanEvent` calls without
  `options.now`, and `modelPlanCredential(…, Date.now(), …)`.
- `test/codium-renewal.test.ts`, "when the reconcile cannot be queued either…": it posts through the Vercel route,
  which reads `Date.now()` itself, and unlike its sibling test it never pinned the clock.

`active-paid` and `frozen-dispute-previous-charge` end their period at `current_period_end` 1793404800
(2026-10-31T00:00Z). From that moment the wall-clock steps saw a renewal instead of the paid month.

## CI evidence

Branch `codium`, workflow `.github/workflows/vector-codium.yml`. Seen through the GitHub API in this package:

- Run 41164998802 (`99fcf1c0`, "fix(codium): P3 review"): completed, failure. It has 10 jobs. "Codium browser specs"
  passed, and the 8 typecheck jobs passed: api, desktop, cloud, schema, core, app, web and engine. "Codium tests" (job 124430534967) failed only in its "Run the Codium test files" step. "Run HttpApi exerciser gates" and "Check
  generated client" passed. I searched the whole job log (4999 lines) for `(fail)` and for non-zero fail counts. It
  holds exactly two failing cases, each in its own file with `1 fail`:
  - billing: expected `active`, version 3; received `state: "paused"`, `reason: "payment_pending"`.
  - renewal: expected 500 `WEBHOOK_RETRY`; received 200 `{ received: true }`.
- Run 41161359560 (`a5cad27a`): failure. A search of the log of job 124419402165 (4998 lines) shows the same two cases
  and nothing else.
- Run 41138356775 (`2722736d`) failed in the Codium browser specs only, before the calendar boundary. The planner
  checked it, not this package. The browser specs passed in run 41164998802.

## What changed

| File                              | Site                                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/codium-billing.test.ts`     | file `afterEach`                                                               | Also resets `setSystemTime()`.                                                                                                                                                                                                                                                                                                                                                                |
| `test/codium-billing.test.ts`     | "account deletion writes ended/closing…"                                       | `cancelModelPlanAccount` writes its closing snapshot at `Date.now()` (`api/_lib/model-plan-account.ts`, `commitSnapshot(…, Date.now(), …)`). The wall clock is pinned to the fixture clock an hour on, `requireEntitlement` takes that moment, and the later reconcile takes the fixture clock another hour on. New expectation: the closing snapshot's `checkedAt` is the deletion's moment. |
| `test/codium-billing.test.ts`     | M5 describe                                                                    | `beforeEach` pins the wall clock at 2031-01-01, past every fixture's period. It is a regression guard: a step that reads the wall clock fails today, not when the calendar reaches the period's end.                                                                                                                                                                                          |
| `test/codium-billing.test.ts`     | "a dispute on last month's charge…"                                            | Its three `reconcileModelPlanEvent` calls take `{ now: fakes.clock.advance(HOUR) }`, and `modelPlanCredential` takes `fakes.clock.now`.                                                                                                                                                                                                                                                       |
| `test/codium-billing.test.ts`     | "an early-fraud warning freezes…"                                              | Both `reconcileModelPlanEvent` calls take `{ now: fakes.clock.advance(HOUR) }`.                                                                                                                                                                                                                                                                                                               |
| `test/codium-billing.test.ts`     | "a lost dispute blocks for good…"                                              | `modelPlanCredential` takes `fixture.now * 1000 + HOUR`, the moment the test already uses for its reconcile and `requireEntitlement`.                                                                                                                                                                                                                                                         |
| `test/codium-billing.test.ts`     | "sales-opened-at is never set by an unpaid account…"                           | The `none-incomplete` reconcile takes `none.clock.now`.                                                                                                                                                                                                                                                                                                                                       |
| `test/codium-billing.test.ts`     | "a renewal is a new version…"                                                  | The refused older-version write takes `checkedAt` and `now` of `(start + 660) * 1000`, after the renewal's reconcile, instead of `Date.now()`.                                                                                                                                                                                                                                                |
| `test/codium-renewal.test.ts`     | "a bad signature is refused…", "invoice.created queues…", "…the answer is 500" | Each test pins the wall clock to `fixture.now`, with the comment its sibling test already used: the route reads the clock itself, and `sign()` and `verifyModelPlanWebhook` read the same pinned clock.                                                                                                                                                                                       |
| `test/codium-renewal.test.ts`     | "the outbox cron runs finalize-renewal…"                                       | The replay call takes `{ now: at }`, the renewal fixture's moment.                                                                                                                                                                                                                                                                                                                            |
| `test/codium-plan-change.test.ts` | "consent comes from the completed checkout…"                                   | Both drains take the fixture's `now` instead of `Date.now()`. No pin: reconcile now queues the confirmation at its own `now`.                                                                                                                                                                                                                                                                 |
| `api/_lib/model-plan-account.ts`  | `reconcileModelPlanAccount`, `recordCheckoutConsent`                           | Reconcile passes its `now` to `recordCheckoutConsent` (and its recursive call), which passes it to `enqueueAction`'s existing `now` for `purchase-confirmation`. No exported signature changes.                                                                                                                                                                                               |
| `test/codium-replay.test.ts`      | "replay skips done events through MGET…" (Valkey)                              | Comment only: the ledger expiry its reconcile sets follows the fixture's period, and nothing in the test reads that ledger (see the static check).                                                                                                                                                                                                                                            |

The scenario steps keep their order, and each event lands at a fixture-clock moment after the one before. One
difference is accepted: in the dispute test the later events now fall inside the fixture's hosted ramp window
(`hostedUntil` is one day after `fixture.now`), where under the wall clock they had landed after it. None of that
test's assertions depends on the ramp, and they pass unchanged.

### Reconcile's clock reaches the purchase confirmation

`reconcileModelPlanAccount(id, fetcher, now)` passes its `now` to every step (the snapshot, the risk review, the
standing, the pool-ramp enqueue) except one: `recordCheckoutConsent` queued `purchase-confirmation` through
`enqueueAction`'s default `now = Date.now()`. A test that reconciles and drains at `fixture.now`, as the rule below says,
found the confirmation due at the wall clock, after the fixture's moment, so it never ran (the planner's rejected
prototype, below, and the mutation check in Validation). Reconcile
now passes its `now` on, through `enqueueAction`'s existing `now` argument. In production every caller passes a real
time taken at the start of its own run (the webhook, replay, the sweep, the outbox's `action.now`, on-demand and owner
reconciles), and the cron drains on the real clock, so the item is still due at once. Only its due time and
`createdAt` move earlier, to that caller's moment, by at most the caller's run so far. The pool-ramp, supersede and
carry-trueup enqueues already took the same `now`. The consent test needs no pin as a result.

### Why `setSystemTime` instead of a production `now`

The Vercel route handler, `verifyModelPlanWebhook` and `cancelModelPlanAccount`'s closing snapshot read the wall clock
themselves, with no parameter. bun:test's `setSystemTime` is the seam this suite already uses for them
(`codium-renewal`'s outbox case, `codium-replay`, `model-plan-status-api`, `model-plan-estimate-api`). It governs
those internal reads as well, so no production parameter is needed for them. A pin freezes `Date.now()`, so a lease wait (`withCodiumLease`'s 5-second deadline) or a drain
budget could never run out under it. The pins are therefore used only in scenarios with no contended lease, where the
drain stops at its item limit or when nothing is due. They are not set file-wide.

### Left on the wall clock

These sites are not fixture scenarios. Each takes its times from `Date.now()` and compares them with `Date.now()`, so
the date does not matter to them:

- the `requireEntitlement`, meter and `isStale` sections of `codium-billing` (`stored()`, `buildSnapshot(…, Date.now())`);
- `codium-pool`'s `period()`, `codium-mode`'s and `codium-payments`' subscriptions;
- the renewal file's budget timing (`Date.now() - started`).

## Scan for the same pattern

**Dynamic probe (in-process clock only).** The planner wrote a preload, `/tmp/vector-CFIX/probe/shift.ts`. It is
never committed, because AGENTS.md discourages `globalThis` in tests. It replaces `Date` with a subclass that adds an
offset while the clock is unset, and leaves times set with `setSystemTime` alone.

- This package, on the final files, through `vector-serial`:
  - `codium-billing`: 52 pass, 2 skip, 0 fail at −30, −1, +3.5, +400 and +3650 days.
  - `codium-renewal`: 32 pass at −30, −1, +3.5, +400 and +3650 days.
  - `codium-plan-change`: 29 pass at the same offsets, also on the final, unpinned file.
  - `codium-billing` on Valkey: 54 pass at +3.5 and +400 days. This ran before the deletion test's `checkedAt`
    expectation was added. The final file ran on Valkey unshifted (see Validation).
- The planner's earlier scan, recorded in its output files under `/tmp/vector-CFIX/probe/`:
  - every root `test/*.test.ts`;
  - the Codium tests in `packages/web`, `app`, `core`, `schema` and `desktop`, and six engine Codium tests;
  - the non-Codium CI-lane files `desktop-account`, `vector-login`, `vector-account`, `billing-navigation`,
    `swarm-plan` and `dialog-select-model`;
  - offsets 0.25, 3.5, 40, 400 and 3650 days, in memory and, for the Valkey files, on a disposable Valkey.

  At HEAD only the two known cases failed. Two kinds of output there are not date bombs:
  - The `codium-plan-change` failures at offsets 0, 400 and 3650 come from the planner's rejected prototype. It moved
    only the drains to the fixture clock while the confirmation was still queued on the wall clock. The fix above also
    queues the confirmation at reconcile's `now`, and its offset runs pass.
  - `packages/web/test/model-plan-admit.test.ts`, "reservation/counter lifetimes are bounded…", fails only when the JS
    clock is shifted against a real Valkey. The ledger's Lua sets absolute `PEXPIREAT` values, and Valkey's own clock is
    not shifted. The test passes at +0 and was not changed.

  The output files are named by file basename, so same-named files in different packages (for example the two
  `codium-billing` and the two `vector-account` tests) cannot be told apart from them.

**What the probe cannot see.** The probe shifts only the test process's JS clock. It does not shift:

- Valkey's own clock, so an absolute `PEXPIREAT` computed from a fixed time stays in the future during the probe;
- Postgres (`public-shares-api`, `teams-api`, run only in CI);
- subprocesses, for example the `redis-server` that `codium-payments` may start;
- Playwright browser specs (CI only).

**Static check of the real-Valkey sections.** These scripts set absolute expiries, which Valkey compares with its own
clock:

- `codium-pool.ts` (`p.now + p.ttl`, and DEBIT's keep time);
- `codium-spend-ledger.ts` (`at` and `untilAt` from the caller's time, and GENESIS at the key's period end plus 40
  days, which follows the period, not any caller's time);
- `codium-snapshot.ts` (METER_ADD's `ARGV[3]`);
- `model-plan-admit.ts` (deadlines and keep times).

The Valkey sections that reach them take their times from `Date.now()`, with the one exception below:

- the billing Lua describe (`const now = Date.now()`, `runMeterAdd(…, Date.now() + DAY, …)`);
- the outbox Lua describe (`Date.now()`);
- `codium-pool` (`period()` from `Date.now()`, `holdPool`'s default clock);
- `model-plan-admit`'s `data()`;
- `model-plans-api`;
- `codium-payments`.

The exception is `codium-replay`'s Valkey describe. Its case "replay skips done events through MGET…" seeds
`active-paid`, which has no key, and sends every store command to Valkey. Its reconcile therefore provisions a key and
runs GENESIS with the fixture's period end. A `MONITOR` capture of the whole file on a disposable Valkey shows exactly
one absolute expiry, `PEXPIREAT vector:codium:test:model-spend:fake_key_1 1796860800000`, which is 2026-12-10T00:00Z.
No later command touches that ledger. From that date Valkey deletes the ledger as soon as GENESIS sets it. A mutation
that deletes the ledger right after GENESIS, which is the state Valkey reaches from then on, leaves both Valkey cases
passing, because neither the test's assertions nor reconcile's later steps read the ledger. The test is left as it is,
with a comment saying so. An assertion on the ledger, the pool's status or admission in that describe would need a
period relative to `Date.now()`.

The Valkey sections that use a fixed time send only commands with no time-based expiry or with relative expiries:

- `codium-owner`: `SET` and the outbox `ENQUEUE`, whose `now` is only a score;
- `codium-switches` and `codium-vercel-spend`: `PEXPIRE` and a score cutoff;
- `codium-replay`'s "the daily walk…" (`now` 1_800_000_000_000): relative `PX` and scores only, as the same capture
  shows;
- `codium-risk`: no time at all.

`codium-outbox`'s fixed `T0` is used only in its in-memory sections, always passed explicitly to `enqueueAction`,
`drainOutbox` and the fake clock.

**Static check of the hard-coded dates.** I reproduced the CI lane's selection (`selectUnitTests`: every `test/` file,
every Codium-named test, and every test file changed since the fork from `origin/main`; 90 files) without Bun and
searched each file for epoch literals and dated strings. The future dates I found are display or echo values that are
never compared with the wall clock:

- `renewsAt`/`at` 2026-11-01 in the app, desktop and web plan tests;
- `previewUntil` and `until` in `model-plan-entitlements`;
- the gateway-hooks snapshot period;
- `forecastDate` strings.

The planner's probe covered those files at +400 and +3650 days, and they passed. Seventeen selected files were not in
the probe. Fourteen of them have no date literal. The other three have only past dates or non-dates:

- `llm-request`'s 2026-04-23 and `prompt`'s 2025-01-01 release dates;
- `codium-plan-names`' dated comments.

The hosted fixture loaders outside `test/` (`model-plan-status-api`, `model-plan-estimate-api`) already pin the clock to
the fixture.

**Rule for new tests.** A test that seeds a Stripe fixture passes `fixture.now`, or its `fakes.clock`, to every
function with a `now` default. These are `reconcileModelPlanAccount`, `reconcileModelPlanEvent`,
`handleModelPlanEvent`, `modelPlanCredential`, `requireEntitlement`, `readEntitlement`, `drainOutbox`, `writeSnapshot`
and `enqueueAction`. Reconcile hands its `now` to every item it queues, the purchase confirmation included. When the
code under test reads the clock itself, as the webhook route, `verifyModelPlanWebhook` and `cancelModelPlanAccount`'s
closing snapshot do, the test pins `setSystemTime` to the fixture's moment. A fixture scenario that runs on a real
Valkey cannot move Valkey's clock: GENESIS's ledger expiry follows the fixture's period, so such a test either asserts
nothing that reads the ledger or seeds a period relative to `Date.now()`.

## Validation

Each file ran alone from its package's test root (`test/`, whose `bunfig.toml` owns it, or `packages/web`), through
`vector-serial` with `--timeout 30000`. The XDG and `VECTOR_TEST_HOME` roots were fresh, under
`/tmp/vector-CFIX/review2-xdg/` for the final runs. "Valkey" means `VECTOR_TEST_REDIS_URL` pointed at a disposable
loopback `redis-server` 7.0.15, started with `--save '' --appendonly no`, flushed before each file and stopped
afterwards. The renewal and plan-change files have no Valkey path. The replay, owner, outbox and `model-plans-api` rows
were added with the production change, because it reaches their reconcile or outbox paths; they were not rerun at
`99fcf1c0`.

| File                                        | Store     | Result (final files) | At `99fcf1c0`, today               |
| ------------------------------------------- | --------- | -------------------- | ---------------------------------- |
| `test/codium-billing.test.ts`               | in memory | 52 pass, 2 skip      | 51 pass, 2 skip, 1 fail (P3 notes) |
| `test/codium-billing.test.ts`               | Valkey    | 54 pass              | 53 pass, 1 fail (P3 notes)         |
| `test/codium-renewal.test.ts`               | in memory | 32 pass              | 31 pass, 1 fail (P3 notes)         |
| `test/codium-plan-change.test.ts`           | in memory | 29 pass              | 29 pass (P3 notes)                 |
| `test/codium-replay.test.ts`                | in memory | 27 pass, 2 skip      | not rerun                          |
| `test/codium-replay.test.ts`                | Valkey    | 29 pass              | not rerun                          |
| `test/codium-owner.test.ts`                 | in memory | 34 pass, 1 skip      | not rerun                          |
| `test/codium-owner.test.ts`                 | Valkey    | 35 pass              | not rerun                          |
| `test/codium-outbox.test.ts`                | in memory | 18 pass, 2 skip      | not rerun                          |
| `test/codium-outbox.test.ts`                | Valkey    | 20 pass              | not rerun                          |
| `packages/web/test/model-plans-api.test.ts` | Valkey    | 76 pass              | not rerun                          |

Mutation checks. Each was applied to the real file, run, and reverted by restoring a byte-identical backup, checked
with `cmp`:

| Change                                                                                              | Result                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Dispute test: the `charge.dispute.closed` step 40 days on                                           | The dispute case fails as in CI: `paused`, `payment_pending` instead of `active`.                                                     |
| Dispute test: the `invoice.paid` step 40 days on                                                    | The dispute case fails: a new version (3) instead of frozen version 2.                                                                |
| 500 test: pinned to the period's end plus an hour                                                   | It fails as in CI: 200 `{ received: true }` instead of 500.                                                                           |
| M5 guard present; the closing step back on the wall clock                                           | The dispute case fails today, and also with the clock shifted to 30 October.                                                          |
| The same change without the M5 guard, clock shifted to 30 October                                   | It passes: the guard is what makes a wall-clock step fail before the calendar does.                                                   |
| M5 guard present; the credential check back on the wall clock                                       | It passes: a frozen account is refused whatever the time, so that step never depended on the date.                                    |
| Deletion test without its pin                                                                       | It fails on the new `checkedAt` expectation (the closing snapshot carries the real clock).                                            |
| Deletion test pinned 40 days on                                                                     | It passes: closing does not depend on the period.                                                                                     |
| Reconcile's confirmation enqueue back on `enqueueAction`'s default clock, consent test unpinned     | The consent case fails today: `confirmationSent` is undefined (the confirmation is due at the wall clock, after the fixture's `now`). |
| The other two route pins and the replay `now` removed                                               | They pass: those assertions do not depend on the period, so the pins only keep them consistent.                                       |
| Replay on Valkey: the new pool's ledger deleted right after GENESIS, as Valkey does from 2026-12-10 | Both Valkey cases pass: no later command reads the ledger.                                                                            |

Other checks:

- Prettier `--check`, through `vector-serial`:
  - `codium-renewal`, `codium-plan-change`, `codium-replay`, `api/_lib/model-plan-account.ts`, this file,
    `codium-deviations.md` and `codium-p3-repairs.md` are clean.
  - `codium-billing` reports only line 118, the `seed()` line that was already unformatted at `HEAD` (see
    `codium-p3-repairs.md`). It was left as it was.
  - A second Prettier call, through stdin to show that diff, ran without the wrapper in the first pass and through it
    in the review pass. It is Node, not Bun.
- The api typecheck the Vector Codium workflow runs, `bun typecheck --project ../../tsconfig.json` from
  `packages/engine` through `vector-serial`, passes with the production change.
- No package typecheck covers `test/*.ts`, because the root `tsconfig.json` includes only `api/**`. As an extra check,
  `bun typecheck --project /tmp/vector-CFIX/review2/tsconfig.tests.json` ran from `packages/engine` through
  `vector-serial`. That scratch config extends the root one and includes the four changed test files. It reports 5
  errors, all in untouched lines of `codium-plan-change` (`fetch` fakes without `preconnect`, and one overload), at the
  same lines as on the `HEAD` version of that file.

Evidence notes:

- During planning, one `bun packages/cloud/src/codium-ci-tests.ts --browser --list` listing ran without
  `vector-serial` by mistake. It listed files and ran no tests.
- Every other Bun workload went through the wrapper: tests, probe runs, mutation checks and the typecheck, in planning
  and here.
- In this package the CI selection was reproduced in Python, not with that script.
- The Valkey `MONITOR` captures used `redis-cli` against the disposable server. They are not Bun workloads.

## Final gate

- **Tree.** `git status` before the commit showed only the eight files in this package: the production change
  (`api/_lib/model-plan-account.ts`), the four test files in the table above, this notes file,
  `codium-deviations.md` ("CFIX decisions") and `codium-p3-repairs.md`. No scratch files, logs, `node_modules`,
  fixture JSON or temporary fixtures. Scratch, probe and backup files live outside the worktree, under
  `/tmp/vector-CFIX/`. No file the @vector lane shares and no generated file is touched.
- **Last edit re-checked.** The last source edit was `api/_lib/model-plan-account.ts`. Every test row in Validation
  and the api typecheck ran after it, under `/tmp/vector-CFIX/review2/`. The one later code edit is the comment in
  `test/codium-replay.test.ts`. That file was rerun after it, in memory (27 pass, 2 skip, 0 fail) and on Valkey (29
  pass, 0 fail). The final Prettier `--check` ran after the last edit to every changed file, with the result above.
  The disposable `redis-server` is stopped.
- **Push.** The commit is pushed through `vector-serial` to `codium-next` and `codium`, both fast-forwards from
  `99fcf1c0`. The pre-push hook typechecks every package one at a time. No workflow is dispatched by hand: the push to
  `codium` starts the scoped Vector Codium workflow (`.github/workflows/vector-codium.yml`) on its own, and its result
  is not recorded here.
- **CI only.** The whole Codium test lane on the pushed commit: `public-shares-api` and `teams-api` on Postgres,
  Valkey in CI, the browser specs and the generated-client check. The two calendar cases should pass there.
