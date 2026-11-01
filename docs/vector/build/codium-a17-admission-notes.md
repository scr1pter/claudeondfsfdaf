# A17 admission and chat implementation record

This work continues the restored 18-file A17 draft on `14bc7d42` in `codium-next`. It is **not** a completeness claim: the
changes have not run in GitHub CI, and the two major findings of the workflow's independent review were fixed and
checked at the commit gate but not re-reviewed by that reviewer (see "Commit gate" and "Remaining gates"). No provider request, Stripe or OpenRouter call, account setting, deployment or release-catalog
change was made. All service boundaries in the tests are loopback fakes and a disposable local `redis-server` 7.0.15
(Lua-compatible; CI uses Valkey 7.2.14).

## What changed against the draft

The handoff's eight unresolved items (8.7) map to these changes:

1. **Barrier before observation.** Every key replacement (renewal, upgrade, a downgrade taking effect) saves an
   `Account.transition {subscription, start, at}` under the lease _before_ `refreshCarry` and `prepareUpgrade` read
   any source balance. The SET that publishes the new key clears it with `upgrade` and `keyCreation`. HOLD and ADMIT
   fence on the exact raw account record, so a hold or admission observed before the barrier is refused afterwards,
   and anything admitted earlier is in the ledger read taken after it. A replacement whose target stops governing
   before its key is published is abandoned by the same-period and renewing paths (`abandonReplacement`): nothing was
   carried and the current key serves again.
2. **One shared fence.** `model_pool_fence` in `MODEL_SPEND_LUA` is used by both ADMIT and the common HOLD. It
   requires the exact raw record; no `closing`, `upgrade`, `keyCreation`, `transition`, unfinished `ownerEnd`, risk,
   provisioning or revoked key; the key hash, subscription, start and end; a ready genesis whose nonce is the ledger's
   creation; the integer `creditsMicro + carry.micro` equal to the caller's total (no decimal legacy fallback); and
   the live snapshot's account, livemode, subscription, period, meter epoch, optional version and time window (active
   before `periodEnd`, renewing before `periodEnd + grace`). A fence race is `stale` → 503 `MODEL_PLAN_RENEWING`
   (retry-after 1); an untrusted ledger or pool is `unavailable` → 503 `MODEL_PLAN_POOL_UNAVAILABLE` (final).
   `snapshotPoolCredential` applies the same predicate in TypeScript.
3. **Conservative floor everywhere.** The ledger READ now separates live and abandoned reservations.
   `readPoolLedger` returns `heldMicro` (live nonmodel holds and live reservations), `abandonedMicro`,
   `committedMicro`, `appliedMicro` and `pendingMicro`; `poolFigures` uses `max(usage, committed)` (never a sum) for
   status `used`/`remaining`/`available`; `prepareUpgrade` carries `limit − max(usage, committed) − live − abandoned`;
   the carry true-up waits only for live holds or pending debits, counts abandoned reservations as consumed and uses
   `max(finalUsage, committed + abandoned)`. The provider key limit (M1) and funding's provider liability are unchanged.
   The usage-only `requireMonthlyCredits` pre-checks were removed from `readyKey` and the lease paths: HOLD and ADMIT
   are the only availability decision (M3). Across repeated upgrades, a carry's `fullMicro` is only an upper bound
   (its source's live holds may still spend) until that carry's own true-up marks it `trued`, and that true-up never
   runs once its key is replaced. `prepareUpgrade` therefore settles an untrued carry from its source's current
   standing (`settledCarryOrigins`: final usage, committed and abandoned, late debits, live holds counted as spent)
   before it becomes the next key's full base, so S1→S2→S3 inside the true-up delay cannot grant the first source's
   held spend again. Allowance a live hold later leaves unspent is then not returned (customer-conservative).
4. **TTL after waits.** `holdPool` reads its clock after the credential reads and uses that instant for the purge,
   member deadline, PEXPIREAT, run binding, the fence's period check and the returned `expiresAt`. It has no fixed
   `now` option (a pre-await timestamp would date all of those in the past); `clock` is a test seam that must return
   the current time on every call. Chat already took `admittedAt` after its credential.
5. **Regressions.** See the tables below. The item 1 ordering is pinned by "a hold delayed past an upgrade's barrier"
   (`test/codium-plan-change.test.ts`): the hold prices itself at the replacement's first write or source observation,
   while the source key is still on, and its HOLD lands the instant after the source ledger READ. Moving the barrier
   after `prepareUpgrade` makes it fail (checked by mutation). The delayed ADMIT across a real renewal reconcile (real
   Lua, `model-plans-api.test.ts`) covers an admission landing after a completed replacement; a renewal carries
   nothing, so it is not an ordering test. Also: fence races on snapshot and ledger, legacy keys without genesis,
   floor in status/holds/credentials while usage lags, carry and true-up with committed and abandoned reservations, a
   charge settled above its hold after an upgrade, a second upgrade inside the true-up delay (held spend spent,
   released or still held), the ramped true-up's shortfall not charged again at ramp end, a replacement interrupted
   after its barrier and resumed, the abandoned replacement, and the gateway HTTP contract cases.
6. **Integration runs.** Every listed file below ran one at a time through the lock wrapper; API types and Astro
   passed. The independent review's two major findings were fixed ("Commit gate"); a re-review of those fixes and CI
   remain.
7. **A51 obligation recorded** here, in `codium-deviations.md`, in `holdPool`'s comment and as a source-scan tripwire
   in `test/codium-pool.test.ts`. It lists every call of `holdPool(`, `placeHold(` or `POOL_SCRIPTS.HOLD` under `api/`
   (definitions excluded) and fails unless the list is exactly the reviewed one: `holdPool`'s own `placeHold` call. A
   producer that builds its funding with `snapshotPoolCredential` and calls `placeHold` directly fails it too.
8. No completeness claim is made (this record, "Remaining gates").

Beyond the handoff list:

- **M4 on the chat path.** The admission credential now comes from the entitlement snapshot plus one OpenRouter key
  read; with a fresh snapshot chat makes no Stripe call. A key that is not ready gets at most one on-demand reconcile
  (the existing once-a-minute slot) and, if the snapshot version is unchanged, one more credential attempt; otherwise
  503 `MODEL_PLAN_RENEWING` (retry-after 1). `holdPool` uses the same credential with the caller's snapshot or the
  stored one read by `readEntitlement`'s rules (a missing or stale snapshot is reconciled on demand, exactly as chat's
  `requireEntitlement` does, never a final 402 for a paying account; P3 review: while another request is still writing
  an account's first snapshot, `readEntitlement` answers `MODEL_PLAN_RENEWING` itself for an account with a Codium
  record, where it used to return undefined and the caller refused 402), and the same one on-demand reconcile for a key
  that is not ready. `readEntitlement` moved beside `reconcileOnDemand` in `model-plan-account.ts` (no import cycle);
  `codium-entitlements.ts` re-exports both. A snapshot reconciled on demand (chat's recent-checkout refresh for a locked
  model, the credential retry, `holdPool`) gets `requireEntitlement`'s final answers for its plan state
  (`requireUsableSnapshot`, now in `codium-snapshot.ts` so `model-plan-account.ts` can use it without importing
  `codium-entitlements.ts`): 402, 403 or 409, never a retryable 503 that can never succeed. `reconcileOnDemand` moved
  next to reconcile in `model-plan-account.ts`; `codium-entitlements.ts` re-exports it.
- **Durable settlement.** A model settlement whose answer is lost twice is queued as the outbox action `model-settle`
  with the same known outcome (`settleModelPlanDurably`), logged with ids only; if even the queue write fails, an
  ids-only error is logged. Until it lands the reservation keeps counting at its full amount, as an abandoned one does.
  SETTLE is idempotent (`done`/`missing`), so a repeated retry never charges or releases twice.
- **Lost admission answer.** When the ADMIT EVAL's answer is lost (transport error, timeout or non-OK store reply),
  the store may still have run it while the gateway never dispatches anything for that ticket, so the outcome is known.
  `admitModelPlan` cancels that exact ticket at once (P3 review: this frees its in-flight slot and reservation
  without waiting for the deadline when the EVAL already ran). When that cancel answers `missing` (not run yet) or is
  lost too, it queues `model-settle` with `{kind: "cancel"}` for the ticket at its deadline plus
  `LOST_ADMISSION_CANCEL_MS` (60 s; the store call itself gives up after 3 s), so an EVAL delayed on its way cannot
  land behind the cancel; until then a late EVAL counts in full. An EVAL delayed past that margin, or one whose cancel
  and queue writes both fail too (an ids-only error is logged), is left as an abandoned reservation that counts in full
  until the period's ledger expires (conservative, never free). A store refusal (`monthly`, `daily`, `stale`, …)
  queues nothing.
- **Hooks after settlement.** `afterSettle` runs once for every admitted request after `settleModelPlanDurably`,
  whether the settlement landed, was queued for the outbox or (both failing) left the reservation counting in full,
  with the outcome the gateway knows (`charge`, `streamed`). A request refused before admission never reaches it.
- **ADMIT cost.** ADMIT purges expired members of the concurrency sets it reads before any check (§4.7 "purge expired
  members; check…") and counts live ones with `ZCOUNT`, O(log N), instead of walking the global set.
- **Run guards.** The computer-use and hosted-session guards apply to a run caller when either its signed service or
  its signed purpose names `cloud-agents` or `hosted` (A16 binds the service to the token prefix; the contract text
  names the purpose).
- **One run-id grammar.** A16's run verifier accepted ids with `:` and up to 256 characters, which ADMIT's held member
  and `run:<id>` (§4.6) cannot store, so such a run would have been refused as `MODEL_PLAN_RUN_EXPIRED` on every
  chat. The verifier now applies the admission grammar (`validRunId`: `[A-Za-z0-9_.-]{1,128}`, not `-`), so a run is
  refused once, at verification, and every run id the verifier accepts can be admitted.
- **Retired A03 model hold.** `modelPlanCredential` is credential-only and has no production caller left (tests and
  maintenance only); with `requiredCredits` it is a read-only check through the same figure. Tests that stand for the
  production admission path drive ADMIT (real Lua) or `holdPool` (the snapshot credential and the shared fence), not
  it: the M11 renewal-hour loop (`codium-renewal.test.ts`) and the replacement race (`codium-plan-change.test.ts`, "a
  hold during a replacement waits for its lease…", refused `RENEWING` and then `EXHAUSTED` once the refunded carry is
  gone). `settleHold`, `POOL_SCRIPTS.SETTLE` and the
  model 30-second bridge outside the committed floor are gone; the pool's READ is the ledger's READ.
- **One shortfall answer.** ADMIT's `monthly` refusal is the same `MODEL_PLAN_EXHAUSTED` code and message as every
  other pool shortfall (`monthlyShortfall`, now in `codium-spend-ledger.ts`).
- **Integer reservations.** `modelPlanReservation(model, plan)` returns `{attemptMicro, attempts, requiredMicro}` with
  `requiredMicro = attempts × attemptMicro`, so a broken settlement (`dispatched × attemptMicro`) can never exceed the
  reservation. The chat injection point validates that shape.
- **Stream bounded by the request deadline.** The wait for a slow client to drain the stream is aborted by the request's
  deadline signal (600 s or the run's deadline), not only by the connection closing. A client that stops reading but
  keeps its connection open used to hold the handler until the platform killed it at `maxDuration` (800 s), so the
  `finally` never settled and the reservation stayed open as abandoned at its full amount for the rest of the period
  (two attempts on Max/Ultra). Now the gateway's `finally` settles it as `broken` (the dispatched attempts), as for a
  client abort, frees the slot and runs `afterSettle`.
- **Abandoned key creations are reused.** `abandonReplacement` keeps the abandoned `keyCreation` in
  `Account.abandonedCreations` until its key would expire (period end + grace), and so does a creation for another
  period that a new creation replaces. The same period's next creation reuses that nonce and request, so OpenRouter's
  idempotent create answers the key it may already have made (answer lost) instead of a second funded key that funding
  would count as owed. Neither the fence nor the credential reads the field. Residuals, both overstating liability
  (never under-funding): an abandoned creation whose period never governs again leaves its key, if one was made,
  enabled with no recorded secret until it expires; and reuse depends on OpenRouter keeping the idempotency key.
- **Contract order.** Gateway limit configuration is validated at the enabled gate; an unknown model is still a 400
  before any store read; a staged, switched-off or unqualified route is 503 before the snapshot, credential, hold or
  fetch; a tier variant is qualified again before anything is reserved.
- **Carry shortfall.** When the source finally spent more than it held at the upgrade (a charge settled above its
  hold or reservation), the true-up charges that difference to the successor pool as a debit, once per cumulative
  amount (`carry-shortfall-<fromHash>-<amount>`), so carry still only rises (M6) and nothing is granted twice. A later
  true-up that supports more (the full limit once the pool ramp ends) raises the carry over the debits already
  charged (`max(micro, supported + charged)`) instead of keeping them on top, and `fullMicro` is recorded in the same
  gross units, so the next upgrade, which subtracts those debits as applied, does not subtract the overspend twice.

## Local validation

Each file ran alone with `--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME` roots, through `vector-serial`. "Valkey"
means `VECTOR_TEST_REDIS_URL` pointed at the disposable loopback server.

| File                                                  | Store             |           Result |
| ----------------------------------------------------- | ----------------- | ---------------: |
| `test/codium-pool.test.ts`                            | in memory         |          26 pass |
| `test/codium-pool.test.ts`                            | Valkey (real Lua) |          26 pass |
| `test/codium-plan-change.test.ts`                     | in memory         |          29 pass |
| `test/codium-billing.test.ts`                         | in memory         | 51 pass (2 skip) |
| `test/codium-billing.test.ts`                         | Valkey            |          53 pass |
| `test/codium-renewal.test.ts`                         | in memory         |          32 pass |
| `test/codium-risk.test.ts`                            | in memory         | 23 pass (1 skip) |
| `test/codium-risk.test.ts`                            | Valkey            |          24 pass |
| `test/codium-owner.test.ts`                           | Valkey            |          35 pass |
| `test/codium-outbox.test.ts`                          | in memory         | 18 pass (2 skip) |
| `test/codium-outbox.test.ts`                          | Valkey            |          20 pass |
| `test/codium-replay.test.ts`                          | Valkey            |          29 pass |
| `test/codium-mode.test.ts`                            | in memory         |          18 pass |
| `test/codium-switches.test.ts`                        | Valkey            |          19 pass |
| `test/codium-topups-removed.test.ts`                  | in memory         |          10 pass |
| `test/codium-funding.test.ts`                         | in memory         |          25 pass |
| `test/codium-vercel-spend.test.ts`                    | in memory         | 52 pass (4 skip) |
| `test/codium-vercel-spend.test.ts`                    | Valkey            |          56 pass |
| `test/codium-plan-names.test.ts`                      | in memory         |           6 pass |
| `test/account-delete.test.ts`                         | in memory         |           9 pass |
| `test/account-delete-api.test.ts`                     | in memory         |           8 pass |
| `test/api-module-loading.test.ts`                     | in memory         |           1 pass |
| `test/model-plan-cli-tokens.test.ts`                  | in memory         | 19 pass (1 skip) |
| `packages/web/test/model-plan-admit.test.ts`          | Valkey (real Lua) |          66 pass |
| `packages/web/test/model-plans-api.test.ts`           | Valkey (real Lua) |          67 pass |
| `packages/web/test/model-plan-caller.test.ts`         | in memory         |          40 pass |
| `packages/web/test/model-plan-reservations.test.ts`   | in memory         |           9 pass |
| `packages/web/test/model-plan-catalog-policy.test.ts` | in memory         |           2 pass |
| `packages/web/test/model-plan-entitlements.test.ts`   | in memory         |          66 pass |
| `packages/web/test/model-plans.test.ts`               | in memory         |          20 pass |
| `packages/web/test/model-plan-gateway-hooks.test.ts`  | in memory         |          13 pass |
| `packages/web/test/model-plan-models-api.test.ts`     | Valkey            |           4 pass |
| `packages/web/test/model-plan-status-api.test.ts`     | Valkey            |           3 pass |
| `packages/web/test/model-plan-context.test.ts`        | in memory         |           6 pass |
| `packages/web/test/model-plan-catalog.test.ts`        | in memory         | 40 pass (1 skip) |
| `packages/web/test/codium-payments.test.ts`           | Valkey            |          22 pass |
| `packages/web/test/free-models-api.test.ts`           | Valkey            |          41 pass |
| `packages/web/test/model-plan-setup.test.ts`          | in memory         |          31 pass |

These are the runs after the review fixes (chained-upgrade carry, ramp shortfall netting, precise delayed-HOLD
ordering test, final plan-state answers, durable settlement, ADMIT purge/`ZCOUNT`, run guards). The second review
pass (lost ADMIT answer, hooks after a queued settlement, `holdPool` without a fixed `now` and with the entitlement
read rules, one run-id grammar) reran these files, each alone: `codium-pool` (in memory and Valkey), `codium-plan-change`,
`codium-risk` and `codium-billing` (in memory and Valkey), `codium-renewal`, `codium-switches` (Valkey),
`api-module-loading`, `model-plan-admit`, `model-plans-api`, `model-plan-caller`, `model-plan-entitlements`,
`model-plan-gateway-hooks` and `model-plans`, with the counts above; the other rows are from the first pass. The new
regressions fail when their fix is reverted (checked by mutation: queued cancel removed, `afterSettle` gated on a
landed settlement again, `holdPool` reading the raw snapshot again). API typecheck (`packages/engine`:
`bun typecheck --project ../../tsconfig.json`) passed. The skips are pre-existing Valkey-only or release-mirror cases
in the in-memory runs; each Valkey-only case passed in the Valkey run of its file.

Web Astro (`packages/web`: `bun typecheck`) passed across 194 files with 0 errors, 0 warnings and 167 hints. The
baseline is A16's record for this base (`codium-a16-callers-notes.md`: 189 files, 113 hints; `14bc7d42` changed only a
workflow file). All 54 net new hints are TypeScript's ts(80007) "'await' has no effect on the type of this expression"
on bun:test `await expect(...).rejects` or `.resolves` lines in the two new test files: 49 in
`model-plan-admit.test.ts` and 5 in `model-plan-gateway-hooks.test.ts`. One edited line in `model-plans-api.test.ts`
keeps the hint it already had. The other 112 hints (ts(80007) in untouched tests, ts(6385) deprecation and one
ts(80006) in untouched site files) are unchanged from the base. An earlier version of this record said 164 hints with
"three new"; that undercounted the delta (it was 51 then).

A third review pass (financial/auth boundary) added regressions and reran each affected file alone through the lock
wrapper, with the counts above: `codium-pool` (in memory and Valkey), `codium-plan-change`, `codium-renewal`,
`codium-billing` and `codium-risk` (in memory and Valkey), `codium-topups-removed`, `codium-owner`, `codium-replay`
and `codium-switches` (Valkey), `model-plan-admit`, `model-plans-api` and `codium-payments` (Valkey), and
`model-plans`, `model-plan-caller` and `model-plan-context` (in memory). New: a `renewing` snapshot is admitted (real
Lua ADMIT) and held (`holdPool`, in memory and on Valkey) from the period's end until the end of its grace and refused
at it, while an `active` one is refused at its period's end, both by the TypeScript predicate and by the fence when the
credential was read just before the cutoff; the M11 renewal-hour loop holds through `holdPool`; an open model
reservation, live and then abandoned, refuses a nonmodel HOLD it would overspend until it is settled (real Lua ADMIT,
SETTLE and `placeHold`; and as ADMIT records it, through `holdPool` in memory and on Valkey); an abandoned replacement's
key is the one its period gets when it governs again; and a client that stops reading is settled at the request's
deadline (`streamModelPlanResponse` and the handler). Each fails when its fix or the guarded term is reverted (checked
by mutation: the renewing cutoff moved to the period's end in the Lua fence, in the emulation and in
`snapshotPoolCredential`; `spend.reserved` dropped from HOLD's burden; the abandoned nonce not reused; the deadline
signal not passed to the drain wait). API typecheck passed again; Astro now reports 169 hints, the two new ones being
ts(80007) on the new `await expect(...).rejects` lines in `model-plan-admit.test.ts` (51 there).

`codium-pool.test.ts` runs the same HOLD/READ/fence cases in memory (the shared emulation in
`packages/web/test/fixture/codium-spend-emulation.ts`, which `FakeStore` also uses) and on real Lua, which is the
emulation check. ADMIT and SETTLE are deliberately not emulated: their money, race and boundary cases run only on real
Lua (`model-plan-admit.test.ts`, `model-plans-api.test.ts`). Every real-Lua test anchors to the wall clock
(`Date.now()` periods), so absolute expiries are meaningful there; the FakeStore plan-change races use the fake clock
and the emulation only.

### Commit gate

The workflow's independent review (with the financial/auth boundary angle) left two major test-coverage findings, and
the third pass above addresses both:

- **Renewal admission was tested only through the retired credential path.** Now covered by the `renewing` cases in
  `model-plan-admit.test.ts` (real Lua ADMIT) and `codium-pool.test.ts` ("a renewing snapshot holds through its grace
  and never past it…", in memory and on Valkey). The M11 renewal-hour loop in `codium-renewal.test.ts` now drives
  `holdPool`. The replacement race in `codium-plan-change.test.ts` was retitled to "a hold during a replacement waits
  for its lease…" and also drives `holdPool`. Neither of those two tests calls `modelPlanCredential` any more.
- **No test showed an open model reservation refusing a nonmodel HOLD.** Now covered by "an open model reservation,
  live or abandoned, refuses a pool hold it would overspend until it settles" (`model-plan-admit.test.ts`: real Lua
  ADMIT, SETTLE and `placeHold`). Also by "a model reservation, live or abandoned, holds what a pool charge cannot
  spend until it is settled" (`codium-pool.test.ts`: the reservation written as ADMIT writes it, in memory and on
  Valkey).

At the gate, the scratch backups used for the third pass's mutation checks were compared byte for byte with
`model-plan-account.ts`, `codium-pool.ts`, `codium-spend-ledger.ts`, `model-plan-chat.ts` and
`codium-spend-emulation.ts`, and they match: no mutation was left in. The files edited after the last recorded runs
(the formatter's pass over four test files) and the files behind both findings were rerun. Each ran alone through
`vector-serial` with `--timeout 30000`, fresh XDG and `VECTOR_TEST_HOME` roots, and a new disposable loopback
`redis-server` 7.0.15 (stopped afterwards):

| File                                         | Store             |           Result |
| -------------------------------------------- | ----------------- | ---------------: |
| `test/codium-pool.test.ts`                   | in memory         |          26 pass |
| `test/codium-pool.test.ts`                   | Valkey (real Lua) |          26 pass |
| `test/codium-plan-change.test.ts`            | in memory         |          29 pass |
| `test/codium-renewal.test.ts`                | in memory         |          32 pass |
| `test/codium-billing.test.ts`                | in memory         | 51 pass (2 skip) |
| `test/codium-billing.test.ts`                | Valkey            |          53 pass |
| `packages/web/test/model-plan-admit.test.ts` | Valkey (real Lua) |          66 pass |
| `packages/web/test/model-plans-api.test.ts`  | Valkey (real Lua) |          67 pass |
| `packages/web/test/model-plans.test.ts`      | in memory         |          20 pass |

The API typecheck (`packages/engine`: `bun typecheck --project ../../tsconfig.json`) passed again at the gate. The web
Astro check and every workspace package run in the pre-push hook's `bun typecheck`.

## HTTP contract cases (A17 test list)

**30 Oct (C-SOL):** the fifth-Astra case and the real-Lua group-cap assertions below were removed with the Astra in-flight group, and ADMIT and SETTLE now take 12 keys (`codium-tiers-v3-changes.md` §8). The counts in this record are the A17 evidence; current cases and counts are in [codium-csol-models-notes.md](codium-csol-models-notes.md).

`model-plans-api.test.ts` "A17 admission and chat" covers: unqualified real route (no snapshot, Stripe, OpenRouter or
ADMIT); disabled model 503; misconfigured limits refused with no external or store call; M4 (five chats, five ADMIT
EVALs, five key reads, no Stripe call, no provider secret in any store command); locked 403 with no hold; a locked
model after a checkout opened this hour → exactly one reconcile, then served on the upgraded plan, or 402
`MODEL_PLAN_PAYMENT_REQUIRED {update-card}` (no retry-after) when that reconcile finds the payment failed; a settlement
lost twice → queued `model-settle` with its known outcome while the reservation and slot stay held, recorded once by
the outbox, a repeated delivery charging nothing; scoped service hooks run `beforeAdmit` before ADMIT and
`afterSettle` once after the settlement landed or was queued (charge, streamed), never for a request refused before
admission; the 31st
request of a parallel Plus burst rate limited (exactly four `RATE_LIMITED`, the rest served or `CONCURRENCY`);
concurrency freed after an upstream error, a transport throw and a client abort, and a fourth Plus request refused with
`retry-after-ms` 1500–4000; the fifth Astra on Max; the global priority reserve; the daily share with retry-after to UTC
midnight; the Brain share; the run ceiling atomic under parallel requests; computer-use and paused-hosted-session run
guards before any credential; a run bound to a replaced pool → 401 `MODEL_PLAN_RUN_EXPIRED` while a new run is admitted;
an admission EVAL delayed across a completed renewal reconcile (barrier, old key off, new key) refused as `RENEWING`
with nothing reserved on either pool (the fence on the raw record; a renewal carries nothing, so the barrier's ordering
is pinned by the upgrade test in `codium-plan-change.test.ts`);
an unready key → one reconcile then `RENEWING`; retry rules by rank (uncertain first attempt committed); a variant's
upstream id, catalog effort and pinned route. Refusal bodies are scanned for amounts (P1). Existing cases keep tokens
forwarded with cost stripped and the serial 31st-request case.

Three existing expectations changed with A17's owner-approved policy and are not weakened: a completed answer that
reports no cost commits its one-attempt reservation (an unknown charge is never free); a provider refusal or transport
failure after dispatch settles as `broken`, which commits every dispatched attempt at its full fixed reservation to the
period's committed spend floor; and a request without `X-Vector-Purpose` is held as `task` (§4.9). The `broken`
commitment is permanent consumption for the period, not a temporary hold: model spend is `max(usage, committed)`
everywhere, so it is never released when the provider's usage later shows less, and it also counts against the day,
Brain and run budgets. Before A17 the gateway released such a hold at once. The reading is 8.6's "unknown
post-dispatch outcomes retain worst-case allowance" and "do not assume a 429/503 was nonbilling": a non-OK answer
carries no cost report, so the gateway cannot tell a definite refusal from a billed one. On the captured reservations
each refusal consumes one attempt (2.179072 USD of allowance for Kimi or Argon), and a Max or Ultra retry whose two
attempts both fail commits two. This customer-facing consequence is listed for the owner's pre-sales sizing review
(A60) beside the reservation table in `codium-a17-context-decision.md`.

## Not provider acceptance

`ROUTE_ACCEPTANCES` stays empty, so every real route answers 503 `MODEL_PLAN_MODEL_UNAVAILABLE` before any credential,
hold or fetch. Tests inject qualification and integer reservations explicitly; there is no environment bypass. The
captured-window reservations (`codium-a17-context-decision.md`) are reservations, not measured invoices or route
acceptance. Real route, native-window and reasoning-bound acceptance remains A60's external gate.

## Obligations for later work packages

- **A18:** project qualification (`verifiedGatewayModel`) and the Pro floors into `/models`; make status read the
  snapshot instead of listing Stripe subscriptions (status already uses the committed floor).
- **A19:** map `MODEL_PLAN_POOL_UNAVAILABLE` and `MODEL_PLAN_RUN_EXPIRED` as final (no retry; a run must start again
  after an upgrade or renewal); retry `MODEL_PLAN_RENEWING` with its retry-after and a bounded count; keep
  `MODEL_PLAN_BRAIN_SHARE` and `MODEL_PLAN_RUN_LIMIT` out of the credit kind. Plus the A16 login obligations.
- **A51 and every later nonmodel producer:** the common HOLD supplies the monthly figure and the run's pool binding
  only. Before a producer calls `holdPool` it must enforce the shared day, Brain and run caps atomically; keep its run
  binding (HOLD binds for at least three days or the hold's deadline) for the producer's lifetime; hold its worst case
  and never settle above it (a charge above its hold is spent from the hold's own pool, and after one upgrade becomes
  a successor debit through the carry shortfall, but a second upgrade inside the 12-minute true-up delay counts the
  first source's live holds as spent at their held amount, so anything charged above such a hold is not recovered);
  settle before its hold lapses; and keep holds short enough that a source pool's carry true-up (outbox: ten
  attempts, about 3.7 hours) is not dead-lettered by a long live hold, or reschedule that true-up. `holdPool` answers
  a plan state that cannot use Codium with `requireEntitlement`'s final codes (402/403/409) and makes at most one
  on-demand reconcile for a key that is not ready; a producer retries only `MODEL_PLAN_RENEWING`. A51's
  "attributed to the period active at settle" must be reconciled with immutable old-pool settlement. Never pass
  `holdPool` a timestamp taken before its awaits: it has no `now` option, and a producer passes no `clock`. The
  tripwire in `test/codium-pool.test.ts` lists reviewed callers; adding one there is that review.
- **Run verifiers (A37, A51, A59) and gateway hook authors:** mint run ids in the admission grammar (the verifier
  refuses anything else) and globally unique, because `run:<id>` and `run-pool:<id>` are keyed by the run id alone
  (§4.6): two accounts sharing an id would share a ceiling and the first binding would refuse the other as
  `MODEL_PLAN_RUN_EXPIRED` (a refusal, never extra allowance). `afterSettle` runs once per admitted request after its
  settlement is recorded or queued; a hook must not read it as proof the ledger already holds the charge.
- **A57:** account deletion must erase, or rely on the bounded TTLs of, `model-spend:<pool>`,
  `model-reservations:<pool>` and `run-pool:<run>` (period end + 40 days; three days for run bindings).
- **A59 / A60:** service registrations of run verifiers and hooks happen only with their own admission enforcement;
  `ROUTE_ACCEPTANCES` needs approved external evidence.

## Remaining gates

- A re-review by a non-author of the fixes for the independent review's two major findings ("Commit gate"). The
  financial/auth boundary angle stays in scope: money must never be reopened or laundered across pool epochs, retries,
  upgrades, expiries or unknown outcomes. The gate's check is not a substitute for that re-review.
- After the commit and the pre-push typecheck: the coordinator's `vector-codium.yml` dispatch on `codium-next` (Valkey 7.2.14, Postgres 16, browser specs, typecheck matrix) and the
  in-memory `test.yml` path. Local `redis-server` 7.0.15 is not CI proof for Valkey reply shapes or EVAL latency.
- Pre-A17 keys without a genesis fail closed everywhere, including as an upgrade source (`prepareUpgrade` cannot read
  their ledger). Sales never opened, so only preview and test stores hold such keys, and §4.6 flushes preview stores.
