# A18 `/models`, status and estimate: implementation record

This work builds on `14fd22dc` (C-SOL) in `codium-next`, which A17 had already given a minimal piece of A18 (status's
`empty` from the captured reservation, or a nominal estimate for unqualified models). It is **not** a completeness
claim: the changes have not run in GitHub CI and have had no independent review (see "Remaining gates"). No provider
request, Stripe or OpenRouter call, account setting, deployment or release-catalog change was made. Every service in the
tests is a loopback fake or a disposable local `redis-server` 7.0.15 (Lua-compatible; CI uses Valkey 7.2.14).

## What changed

| File                                                             | Change                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/_lib/model-plan-catalog-policy.ts`                          | `ModelPlanCatalogOptions` (models, qualify, reservation, run verifiers), shared by chat, `/models`, status and estimate; `servedPlanModels` (catalog with Pro floors, minus `models-off` by id or upstream, minus routes without accepted evidence); `planView` (access, lock plan, preview, the plan's routing variant and whether that variant is qualified). |
| `api/_lib/model-plan-chat.ts`                                    | `ModelPlanGatewayOptions` is `GatewayHookOptions & ModelPlanCatalogOptions` (type only; admission order and money code untouched).                                                                                                                                                                                                                              |
| `api/_lib/model-plan-models.ts`                                  | §4.12: store reads only (raw `readSnapshot`, the `codium` switch, `models-off`); new-client shape with locks, preview, roles, Codium Auto, judges and review; old-client four-field list.                                                                                                                                                                       |
| `api/_lib/model-plan-account.ts`                                 | `modelPlanStatus` reads the snapshot (`readEntitlement`'s rules) instead of listing Stripe subscriptions, plus one OpenRouter key read, the ledger and today's spend for the snapshot's own period key; `snapshotPoolTotal` for estimate. `monthlyStatus` is gone; `subscriptions()`/`listSubscriptions` stay for reconcile and `monthlyCredential`.            |
| `api/_lib/codium-spend-ledger.ts`                                | `MODEL_SPEND_SCRIPTS.DAY` / `readModelSpendDay`: today's spend as ADMIT counts it before adding a request (settled day bucket, live nonmodel holds, debits recorded today, open reservations admitted today), except that a reservation counts only once past its deadline (fourth review). Read only.                                                          |
| `api/_lib/codium-snapshot.ts`                                    | `pausedPayment(snapshot)`: the paused reason and action, used by `requireUsableSnapshot`'s 402 and status's `plan.action`.                                                                                                                                                                                                                                      |
| `api/_lib/model-plan-status.ts`                                  | §4.11 body, the 30-second cache keyed by snapshot version, the meters registry, `forecastDate` (A32's period-average fallback) and `modelPlanBalance` with the cheapest served reservation.                                                                                                                                                                     |
| `api/_lib/model-plan-estimate.ts`, `api/model-plans/estimate.ts` | §4.13 model form, P2 grid, per-step answer cache.                                                                                                                                                                                                                                                                                                               |
| `api/model-plans/config.ts`                                      | Answers `listed: []` beside `publicModelPlans()`.                                                                                                                                                                                                                                                                                                               |
| `packages/web/test/fixture/codium-spend-emulation.ts`            | The in-memory ledger read keeps the live nonmodel holds as the Lua does, and emulates DAY.                                                                                                                                                                                                                                                                      |

## Response shapes

**`/models`, new clients** (`X-Vector-Catalog: 2`): `{enabled: true, plan: PlanId | null, limits: {inFlight},
models: [...], judges?: {worker: judge}, review: {triage?, confirm?, panelJudge?}}`. Each model: `id, name,
contextLength, maxOutputTokens` (its plan's variant; a locked one at its lock plan), `lab?, weight` (rounded to 0.01),
`role?` (`default` > `floor` > `ceiling` when one id holds two roles), `manualOnly?`, `locked?: {plan, name,
previewUntil?}`, `preview?: {until}`. `vector/codium-auto` follows its default model: `{id, name: "Codium Auto",
contextLength, maxOutputTokens (the smallest of its roles), lab and weight (the default's), auto: {floor, default,
ceiling}}`. `limits.inFlight` is the snapshot's cap, or Plus's without a plan.
**Old clients**: `{enabled: true, models: [{id, name, contextLength, maxOutputTokens}]}` with unlocked, served, not
manual-only models. Production today: `models: []` (no accepted route), as chat answers 503 for every route.

**Status**: `{enabled, active, customer?, access, plan?: {id, name, left?, renewsAt, cancelAtPeriodEnd, state, reason?,
action?, scheduled?, today?: {used, resetsAt, reached}, forecastDate?, ramp?: {until}}, listed: [], entitlements?,
meters?, velocity?, labs?, purchased: {bought: false}, empty, low}`. Paused and frozen: `active: true, access: false`,
`plan` without `left`, `empty: false, low: false`, no provider or ledger read. No record, `none`, `ended` or closing:
`active: false`, no plan, `empty: true` (as before). No Stripe key: the same short shape with `listed: []`. `empty`
compares the cheapest served reservation with ADMIT's available figure less the requests still running
(`idleAvailable`): abandoned reservations and live nonmodel holds count, live model reservations do not. `today` is
ADMIT's day figure on the same terms. `enabled` is `MODEL_PLANS_ENABLED` and the `codium` switch on; with either off,
`access` is false too and the rest of the body is unchanged.

**Estimate**: `POST {model, inputTokens, outputTokens, requests?}` → `{share, todayShare?}`, both one of `under 1%`,
`1–2%`, `2–5%`, `5–10%`, `10–20%`, `20–40%`, `over 40%`, `more than your month`.

## Critique items (plan review) and what was done

1. **Status cache vs repeated HTTP reads (major).** Valid. `model-plans-api` now drops `status:<id>` before each read
   that stands for one after 30 s (`forgetStatus`, named in the test), and asserts once that a read within 30 s is the
   cached answer. Every `left`/`empty`/`low` assertion is unchanged.
2. **Cache race not exercised (major).** Valid. "an answer computed before a reconcile and stored after it…"
   (`model-plan-status-api`) holds the status read's cache SET until a reconcile has written a new snapshot and cleared
   the key, then releases it; the next read must compute the new snapshot. Removing the version check fails only this
   test (checked by mutation; the plain reconcile-then-read case passes either way, as the critique said).
3. **`codium-topups-removed` (major).** Valid: explicit `reconcileModelPlanAccount` after the paid subscription (the
   test's intent is the post-payment state; the earlier read cached a `none` snapshot for a minute), `SMEMBERS` and the
   DAY script in its fake, and the `/wallet|state|credits/` guard narrowed to `purchased` being exactly
   `{bought: false}` plus `/wallet|credits|"state":"(available|low|used)"/`. `HGET` was not needed: today's figure comes
   from the DAY script, not a raw hash read.
4. **`today` in the exact body and the `used` regex.** Valid. The exact body includes `plan.state`, `plan.today`,
   `listed` and Plus's `entitlements`; `used` left the literal regex and a P1 walk now checks every number outside
   `entitlements` is a share in 0..1 or a timestamp.
5. **Caller fixture lacks `SMEMBERS`.** Valid; added (empty set). All 40 cases pass unchanged.
6. **`today` from the same records ADMIT reads.** Valid; this is H5. The DAY Lua reuses `model_spend_read` and counts
   what ADMIT counts. A real-Lua test puts a live pool hold at exactly the boundary: one micro-dollar over, status says
   `reached` and ADMIT refuses `MODEL_PLAN_DAILY_LIMIT`; one micro-dollar less, neither (mutation: dropping the hold
   term from DAY fails it).
7. **Estimate auth.** Decided: account tokens marked or unmarked (S2 lets an unmarked token read status, which reveals
   more than a band) and run tokens through the verifier registry (§4.13 says "account or run token"; S3's never-list
   does not name estimate). `runVerifiers` is in the shared options. Recorded below.
8. **Meters drop `exhausted`.** Valid. Each meter is validated against its §4.11 fields (shares, counts, flags);
   tested with a well-formed `cloudAgents` meter.
9. **`readEntitlement` undefined.** Valid: 503 `MODEL_PLAN_RENEWING` with retry-after 1, nothing cached; tested with
   `reconcile:<id>` held and no snapshot.
10. **Switch cache per fetcher.** Valid: every `/models` case builds its own fetcher.
11. **`PEXPIREAT` in FakeStore.** Avoided rather than added: the estimate key uses `SET … NX PX (periodEnd + 1 day −
now)`, which FakeStore and Valkey both honour; the test advances the fake clock to show the key lapses exactly a day
    after the period ends.
12. **Partial `review`.** Valid: `review` always present, members dropped when not usable, `{}` possible; without a
    plan it is Plus's. Recorded below.
13. **Rerun `model-plan-catalog-policy`.** Done (2 pass).

**Beyond the critique: P2 needed the pool on the grid too.** The plan rounded the units and the cost to the 1.5× grid.
That is not enough: the seven band edges (1%, 2%, 5%, 10%, 20%, 40%, 100%) fall at different fractions of a grid step
(log₁.₅ of their ratios has fractional parts 0, 0.10, 0.36, 0.39, 0.68, 0.71, 0.97), so asking at every cost step
would intersect seven 1.5×-wide intervals and narrow the pool to about 1.2%. `estimateAnswer` also rounds the pool down
to the grid, so every answer depends only on (cost step − pool step). The test asks every cost step 0–90 with each
daily share for random pairs of pools inside one step and requires identical answers, and shows pools one step apart
are told apart (mutation: using the exact pool fails it). Every rounding errs the same way, so an answer never
understates a share; together the request count, tokens, cost step and pool step can overstate it by up to about
1.5⁴ ≈ 5× (typically no band or one, at most three). The route test's full-window DeepSeek request is 9.8% of Plus's
daily limit and is answered "10–20%".

**A pre-existing flake fixed in passing.** `codium-mode.test.ts` compared the created key's name with `period().start`
read again at assertion time, which moves when the lifecycle crosses a second boundary (seen once locally after the
status read made the lifecycle slightly longer). It now reads the start from the subscription the lifecycle sold.

## Local validation

Each file ran alone through `vector-serial` with `--timeout 30000` and fresh XDG and `VECTOR_TEST_HOME` roots, after
the final formatter pass. "Valkey" is a disposable loopback `redis-server` 7.0.15 (`--save '' --appendonly no`,
stopped afterwards) through `VECTOR_TEST_REDIS_URL`.

| File                                                      | Store             |           Result | Base (C-SOL) |
| --------------------------------------------------------- | ----------------- | ---------------: | -----------: |
| `packages/web/test/model-plan-models-api.test.ts`         | KV fake           |          11 pass |            4 |
| `packages/web/test/model-plan-status-api.test.ts`         | in memory         |          17 pass |            3 |
| `packages/web/test/model-plan-estimate-api.test.ts` (new) | in memory         |          12 pass |            — |
| `packages/web/test/model-plans-api.test.ts`               | Valkey (real Lua) |          74 pass |           72 |
| `packages/web/test/model-plan-admit.test.ts`              | Valkey (real Lua) |          68 pass |      not run |
| `packages/web/test/model-plan-caller.test.ts`             | in memory         |          40 pass |           40 |
| `packages/web/test/model-plans.test.ts`                   | in memory         |          21 pass |           20 |
| `packages/web/test/model-plan-entitlements.test.ts`       | in memory         |          61 pass |           61 |
| `packages/web/test/model-plan-gateway-hooks.test.ts`      | in memory         |          13 pass |           13 |
| `packages/web/test/model-plan-catalog-policy.test.ts`     | in memory         |           2 pass |            2 |
| `test/codium-pool.test.ts`                                | in memory         |          27 pass |           27 |
| `test/codium-pool.test.ts`                                | Valkey (real Lua) |          27 pass |           27 |
| `test/codium-renewal.test.ts`                             | in memory         |          32 pass |           32 |
| `test/codium-mode.test.ts`                                | in memory         |          18 pass |           18 |
| `test/codium-topups-removed.test.ts`                      | in memory         |          10 pass |           10 |
| `test/codium-plan-change.test.ts`                         | in memory         |          29 pass |           29 |
| `test/codium-billing.test.ts`                             | in memory         | 51 pass (2 skip) |  51 (2 skip) |
| `test/codium-risk.test.ts`                                | in memory         | 23 pass (1 skip) |  23 (1 skip) |
| `test/api-module-loading.test.ts`                         | —                 |           1 pass |            1 |

API typecheck (`packages/engine`: `bun typecheck --project ../../tsconfig.json`) passed. Web Astro (`packages/web`:
`bun typecheck`) passed across 195 files (194 + the new estimate test) with 0 errors, 0 warnings and 173 hints, the
C-SOL baseline's hint count (no new hint).

**Mutation checks** (each reverted and compared byte for byte afterwards):

- `/models` reading through `readEntitlement` → the store-only cases fail (a missing snapshot reaches Stripe).
- Status cache without the snapshot-version check → only the interleaved race test fails.
- The DAY Lua without its live-hold term → the real-Lua status/ADMIT agreement test fails.
- Estimate answering on the exact pool instead of its grid step → the P2 property test fails.
- Forecast thresholds at 2 days / 4% → both hiding-rule tests fail.

## Second review: findings and what was done

The six findings of the package review were checked against the code; all six were real and are fixed here, with the
contract corrections recorded in `codium-deviations.md` (A18).

1. **`empty` ignored abandoned reservations and nonmodel holds (minor).** Valid: `empty` used `remaining`, which leaves
   out every hold, while ADMIT's month check subtracts reservations (live and abandoned) and live nonmodel holds. So an
   abandoned reservation could leave status "not empty, low" while every request got `MODEL_PLAN_EXHAUSTED`.
   `modelPlanStatus` now reads the spend ledger once and also returns `idleAvailable` (M3's available plus the live
   model reservations), and `empty` compares that with the cheapest reservation. Live model reservations are left
   out on purpose (recorded): they settle within 11 minutes, and ADMIT's refusal then says to wait. `codium-pool.ts`
   gained `poolLedger(...)`, the mapping `readPoolLedger` already used, so the ledger is read once. Tests: real-Lua
   "status's empty counts what ADMIT counts" (`model-plans-api`). An abandoned reservation one micro-dollar over the
   room gives `empty` and a 402; one micro-dollar less gives neither; a running reservation of the larger size is not
   `empty`. The `M3` pool test adds a hosted hold that takes all that is left, which shows as `empty` with 38% unspent.
   Mutations: `empty` from `remaining` fails both; `empty` from `available` (running requests included) fails the
   running case.
2. **The recorded P2 bias bound was wrong (minor).** Valid: "less than 1.5×" held only for the pool step. Units, cost
   and pool each round by up to 1.5×. The route test itself answers "10–20%" for a request that is 9.8% of the daily
   limit. The deviation, these notes, the handler's doc comment and that test's comment now state the compound bound:
   never an understatement, up to about 1.5⁴ ≈ 5×, typically no band or one, at most three. The rounding is kept.
   Rounding to the nearest step instead could understate, and `/estimate` feeds pre-start ceilings (A51, B06).
3. **The estimate cache outlived the pool ramp (major).** Valid: the key named neither the pool nor its phase. The ramp
   end raises a rank ≥ 3 key's credits about 3.3× inside the same period and meter epoch, and answers given during the
   ramp were then served for the rest of the month. The key now carries `ramp` or `full`, read from the same key record
   as the total (`creditsMicro < fullCreditsMicro`), so an answer computed on a ramped total is never stored as `full`.
   There is no gap between `ramp.poolUntil` and the outbox action that raises the key. Carry rises within a phase stay
   pinned, as the existing carry test asserts. (This item said carry only rises; it does not: see the third review
   below.) Test: a Max
   whose first payment was not 3-D Secure authenticated asks during the ramp ("1–2%", today "2–5%"). The ramp then
   ends through the outbox (same key, same period), and the same question answers "under 1%" under the `full` key.
   Mutation: a constant phase fails it.
4. **A lasting key condition answered as a retry (minor).** Valid: a period key with no `creditsMicro` (from before the
   A17 ledger) answered 503 `MODEL_PLAN_RENEWING` with retry-after 1 forever. `snapshotPool` (formerly
   `snapshotPoolTotal`) now throws `modelSpendUnavailable()` (503 `MODEL_PLAN_POOL_UNAVAILABLE`, no retry-after) for
   the snapshot's own period key without credits, as chat's credential does. A missing, revoked or other-period key
   still gets `RENEWING`, and a zero total is no longer read as missing. Test: both answers with their headers;
   mutation: returning undefined for the credit-less key fails it.
5. **Estimate skipped chat's sign-in mapping (minor).** Valid: account tokens went straight to
   `requireUnrevokedCliToken`, so expired or invalid tokens got `CLI_TOKEN_EXPIRED`/`CLI_TOKEN_INVALID`.
   `requireModelPlanCaller` gained `accepts: {unmarked}`, and estimate now uses it for every caller. That brings the
   8192-character bound, the token grammar and `CODIUM_SIGN_IN_REQUIRED` for missing, malformed, oversized, expired,
   invalid and revoked tokens, while unmarked tokens are still accepted. Chat and `/models` pass nothing and are
   unchanged (`model-plan-caller` 40 pass). Test: tampered, expired, browser-session, oversized and revoked tokens
   each answer 401 `CODIUM_SIGN_IN_REQUIRED`, and an unregistered hosted run token answers `MODEL_PLAN_RUN_EXPIRED`.
6. **A meter reader could still break or stall status (minor).** Valid: `meter.read(...).catch` misses a reader that
   throws before returning its promise, and nothing bounded one that never settles. The read now goes through
   `Promise.resolve().then(...)` and races `AbortSignal.timeout(METER_TIMEOUT_MS)` (1.5 s). The signal is passed to
   the reader as a third argument so it can stop its own requests. Test: a synchronously throwing reader and a
   never-settling one drop only their meters; the read returns after the timeout, and the slow reader sees the abort.
   Mutation: calling the reader directly fails it.

Rerun after these fixes, each file alone through `vector-serial` (`--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME`
roots; real Lua on a disposable loopback `redis-server` 7.0.15, stopped afterwards). These runs used `model-plans-api`
(74), `model-plan-admit` (68) and `codium-pool` (27) on real Lua; and estimate (12), status (17), caller (40), `/models`
(11), `model-plans` (21), `codium-pool` (27), `codium-topups-removed` (10), `codium-renewal` (32),
`codium-plan-change` (29), `codium-mode` (18), `codium-risk` (23, 1 skip) and `api-module-loading` (1) in memory. All
passed. The API typecheck passed. The web Astro typecheck reported 195 files with 0 errors, 0 warnings and 173 hints.
`codium-billing`, `model-plan-entitlements`, `model-plan-gateway-hooks` and `model-plan-catalog-policy` were not
rerun.

## Third review: findings and what was done

Three findings; the first and third are the same defect. Both real ones are fixed.

1. **The estimate cache could understate after a carry fell (major; also reported as a minor).** Valid, reproduced.
   Carry does not only rise: `refreshCarry` drops every origin whose source charge is unpaid, refunded, fully refunded,
   disputed without a won or warning-closed outcome, or not this customer's, and rewrites `carry.micro` from what is
   left. It runs on every same-period reconcile (`provisionMonthlyKey`, `convergeKey`) and in the `carry-trueup`
   outbox action. The subscription, period, phase and daily share stay the same, so the estimate key did too, and an
   answer worked out on the larger pool was served for the rest of the period, up to one 1.5× pool step below the
   exact share. Fix: the store keeps `{answer, poolStep}` (`floorStep` of the pool the answer was worked out on), and
   a kept answer is served only while the current pool step is at or above it. Otherwise the answer is worked out
   on the current pool and replaces the kept one (`SET` without `NX` when a value was read, so only a first answer
   races with `NX`). A parallel first answer that lost the `NX` race is served only under the same rule, else the
   caller gets its own fresh answer. A pool that rose still gets the kept answer, so a carry rise says nothing new,
   and a fall reveals only the new pool step, as any fresh answer does. The handler's doc comment and the deviation
   ("carry only rises") are corrected. Test (extends "a step keeps its first answer…"): Plus with a 40 USD carry from
   `ch_before` answers "5–10%" / "20–40%"; `ch_before` is then refunded and a real reconcile drops the carry
   (`micro: 0`, `revokedOrigins: ["ch_before"]`); the same question now answers "over 40%" / "more than your month"
   under the same key. Before the fix it answered the stale "5–10%" / "20–40%" (run and seen failing). A parallel
   first answer from before the refund that lands between the read and the `NX` write is not served and is replaced
   by the next request; a carry that rises again afterwards keeps the larger-share answer. Mutations, each failing
   the test: serving any kept answer; serving the raced answer without the pool-step check; always writing with `NX`.
2. **The status cache cap had no test (minor).** Valid. New test "an answer is never kept past the next UTC
   midnight or the pool ramp's end": a Plus read ten seconds before a UTC midnight is stored for ten seconds, and the
   first read at midnight shows `today.resetsAt` as the next midnight. A ramped Max (first payment not 3-D Secure
   authenticated, ramp ending at 01:00 UTC) read ten seconds before the ramp end is stored for ten seconds, and the
   read at the ramp end has no `plan.ramp`. Mutations, each failing it: no midnight term; no ramp term; a flat 30 s.
   Each still fails with the PTTL assertions removed, on the screen-visible fields alone. Every Stripe fixture's
   period ends at a UTC midnight, so the period-end term is covered only together with the midnight term. Past the
   renewal grace a read reconciles and the snapshot version changes, so that boundary is the version check's, as
   before.

Rerun after these fixes, each file alone through `vector-serial` (`--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME`
roots, in memory): estimate (12 pass) and status (18 pass). No other test reads the estimate module or its key. The
API typecheck passed. The web Astro typecheck reported 195 files with 0 errors, 0 warnings and 173 hints. Prettier
reports the changed files formatted.

## Fourth review: findings and what was done

Three minor findings, all real and fixed here, with the contract corrections recorded in `codium-deviations.md` (A18).

1. **Status ignored the `codium` switch (minor).** Valid, reproduced: with the switch off, `/models` answered
   `{enabled: false, models: []}` and chat and estimate 503 `MODEL_PLANS_DISABLED`, while status still said
   `enabled: true, access: true`, so `ModelPlanStatus.notice` gave no notice. `enabled` is now `MODEL_PLANS_ENABLED`
   and the `codium` switch on (read through its 30-second cache, beside the cached body), and with either off `access`
   is false too; the plan, its shares and `empty`/`low` still show. Test (`model-plan-status-api`): with the switch
   off, status answers `enabled: false, access: false` with the plan and `left`, and the core decoder's notice is
   "unavailable"; switched back on, the same kept answer has access again. Before the fix it answered `enabled: true` and
   `access: true` (run and seen failing). Mutations, each failing it: no switch read; the switch read without the
   `access` override.
2. **`/models` departed from §4.12's shape without a record (minor).** Valid: `limits` was left out without a plan,
   and the Auto entry had no `lab`. `limits: {inFlight}` is now always sent (Plus's public cap without a plan, as the
   locks are then Plus's), and Auto carries its default model's `lab` beside its `weight`. A model's `lab` can still be
   missing only on a `MODEL_PLAN_MODELS_JSON` entry without one (`ModelPlanModel.lab` is optional in §4.12); recorded
   in the A19 obligation. Tests (`model-plan-models-api`): the production, Plus and ended-plan cases now expect
   `limits` and Auto's `lab`; reverting either change fails three cases.
3. **`today` counted running requests (minor).** Valid, reproduced on real Lua: with one request running whose
   reservation took 1.24 of Plus's 1.25 daily limit, status showed `today: {used: 0.99, reached: true}`, and the
   30-second cache would have kept that after the request settled. DAY now counts an open reservation admitted today
   only once past its deadline (abandoned, as `empty` counts it), and both `used` and `reached` use it; the emulation
   matches. While a request runs ADMIT still counts its reservation, so a further request can be refused
   `MODEL_PLAN_DAILY_LIMIT` that status does not yet show as reached; this is recorded beside the `empty` deviation.
   Test (`model-plans-api`, real Lua): a running 1.24 reservation leaves `today` at `{used: 0, reached: false}` while
   a second chat answers 429 `MODEL_PLAN_DAILY_LIMIT`; DAY read a millisecond before the reservation's deadline leaves
   it out and at the deadline counts it in full (the times are chosen inside one UTC day and the subscribed hour, so
   the case does not depend on the wall clock). Before the fix the status assertion failed with `used: 0.99` and
   `reached: true`. Mutation: counting from `deadline < now` instead of `<=` fails it. The existing live-hold boundary
   test (nonmodel holds still count) passes unchanged.

Rerun after these fixes, each file alone through `vector-serial` (`--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME`
roots; real Lua on a disposable loopback `redis-server` 7.0.15, stopped afterwards): `model-plans-api` (75 pass),
`model-plan-admit` (68) and `codium-pool` (27) on real Lua; status (19), `/models` (11), estimate (12), caller (40),
`codium-pool` (27), `codium-topups-removed` (10), `codium-mode` (18) and `api-module-loading` (1) in memory. All passed.
The API typecheck passed. The web Astro typecheck reported 195 files with 0 errors, 0 warnings and 173 hints.

## Final gate before commit

The last source and test edits were made after the fourth-review reruns, so the gate reran every file that reads a
changed module. Each file ran alone through `vector-serial` with `--timeout 30000` and fresh XDG and `VECTOR_TEST_HOME`
roots. Real Lua ran on a disposable loopback `redis-server` 7.0.15 (`--save '' --appendonly no`), flushed between files
and shut down afterwards.

- **Real Lua:** `model-plans-api` 75 pass, `model-plan-admit` 68 pass, `codium-pool` 27 pass, `codium-billing` 53 pass
  and `codium-risk` 24 pass. The real-Lua runs of `codium-billing` and `codium-risk` are new for A18.
- **In memory, `packages/web`:** status 19 pass, `/models` 11, estimate 12, caller 40, `model-plans` 21,
  `model-plan-gateway-hooks` 13, `model-plan-catalog-policy` 2 and `model-plan-entitlements` 61.
- **In memory, root `test/`:** `codium-pool` 27 pass, `codium-topups-removed` 10, `codium-mode` 18, `codium-renewal` 32,
  `codium-plan-change` 29, `codium-billing` 51 (2 skip), `codium-risk` 23 (1 skip) and `api-module-loading` 1. The
  skips are the Valkey-only cases, which pass on real Lua above.

No file failed. The API typecheck (`packages/engine`: `bun typecheck --project ../../tsconfig.json`) passed. The web
Astro typecheck (`packages/web`: `bun typecheck`) reported 195 files with 0 errors, 0 warnings and 173 hints. The push
runs the pre-push hook, which typechecks every package.

## Not provider acceptance

`ROUTE_ACCEPTANCES` stays empty, so production `/models` lists no model, status's `empty` trips only when nothing is
left, and estimate answers 503 for every model, as chat does. Tests inject qualification and reservations through the
explicit options; there is no environment bypass and no fabricated acceptance.

## Obligations for later work packages

- **A19:** decode the new `/models` shape (send `X-Vector-Catalog: 2`); resolve Auto from `auto: {floor, default,
ceiling}`, never from `role`; treat any `review` member and any judge as possibly missing; treat `plan: null` as
  Plus's locks and `limits`; `limits` and Auto's `lab` are always sent, and a model's `lab` is missing only on a
  `MODEL_PLAN_MODELS_JSON` entry without one (`ModelPlanModel.lab` is optional, §4.12). Status's `enabled: false`
  (Codium deployed off or the `codium` switch off) can come with a plan and its figures; show the unavailable notice
  first, as `ModelPlanStatus.notice` does. Decode status's new fields leniently (H7 fixtures). Map
  `CODIUM_ESTIMATE_KIND` as a final 400.
- **A20 / A24:** paused and frozen now answer `active: true, access: false` with `plan.state`, `reason` and `action`;
  until the notices land, current clients show their generic notice.
- **A27:** replace `listed: []` in status and config with `listedPerks()`; config gets `publicCodiumTiers()` and its
  cache header. Meters then show for listed perks.
- **A32:** day-bucket history and the 7-day forecast line replace `forecastDate`'s period average; the hiding rules
  stay.
- **A37, A51, A59 and other perk services:** register their meter with `registerStatusMeter(perk, name, read)`
  (shares, counts or flags only). A reader has 1.5 s and receives an `AbortSignal` to pass to its own requests.
- **A51, B06, Track B:** the `hosted`, `race` and `playbook` estimate kinds.
- **A57:** account deletion erases `estimate:<account>:*` (now `estimate:<account>:<epoch>:<phase>:…`) and
  `status:<account>`, or relies on their TTLs (period end + 1 day; 30 s).

## Remaining gates

- Independent review of this package, money and privacy angle (P1/P2/H5/M4).
- `vector-codium.yml` (Valkey 7.2.14, the root suite, typecheck matrix, browser specs). It runs on its own when the
  commit is pushed to `codium`; no workflow is dispatched by hand. Its result is not recorded here. Local
  `redis-server` 7.0.15 is not CI proof for Valkey reply shapes.
- H7's frozen 1.99.111/1.99.112 decoder fixtures are A19's; only the in-repo core and web decoders were checked here.
