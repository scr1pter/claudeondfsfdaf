# A51: Hosted core

A51 builds the core of the cloud computer: its rates, its ledger (blocks held before they run and charged into the
subscriber's pool at no less than the provider's worst-case cost, invariant M8), the plan rules every later hosted
package reads, the pseudonymous ledger lines in Supabase and the shared vocabulary for clients. It builds on A03 (the
pool's common `holdPool`) and A05 (the entitlement snapshot). No provider, Supabase, Stripe or OpenRouter was called:
all are fakes in the tests. Nothing was applied, deployed or pushed.

## What changed

| Area | Files |
|---|---|
| Schema | `packages/schema/src/hosted.ts` (new, `@vectordevai/schema/hosted`): sizes and their weight (large counts double), §4.4's access levels, disk days, error codes, `hoursUsedShare`. No rate or amount |
| Rates | `api/_lib/hosted-rates.ts` (new): Vercel Sandbox iad1, worst case $0.3408/h charged $0.375 (standard), $0.6816/$0.75 (large); 15-minute blocks holding 20; storage, egress, provider cost and the true-up formula |
| Plan rules | `api/_lib/hosted-entitlement.ts` (new): caps with the trust ramp as of now, §4.4's access per state and switch, disk policy, the allowlist, the period's hours, `requireHostedStart`, `hoursUsedShare` |
| Ledger | `api/_lib/hosted-ledger.ts` (new): `openBlock`, `closeBlock`, `settlePending`, `drainHostedSettles`, `chargeNightly`, `chargeRetention`, `trueUpCharge`, `readLine`, `periodCharges`, `eraseAccountHostedLedger`, `hostedAccount` |
| SQL | `docs/vector/owner-actions/sql/hosted.sql` (new): `vector_hosted_ledger` with RLS, one invoker function `vector_hosted(jsonb)`, `service_role` may insert and lower, never delete; no foreign key |
| Pool | `api/_lib/codium-pool.ts`: `LOWER` and `lowerDebit` (true-up); `api/_lib/model-plan-account.ts`: `PoolHold.pool` |
| Status | `api/_lib/hosted-meter.ts` (new), imported by `api/model-plans/status.ts`: `meters.hosted {used}` while `computer` is listed |
| Estimate | `api/_lib/model-plan-estimate.ts`: `{kind: "hosted", minutes, size}` |
| Settings | `.env.example`: `VECTOR_HOSTED_ACCOUNT_SALT`, `VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB`, `VECTOR_HOSTED_ALLOW_ACCOUNTS` |
| Docs | `docs/vector/owner-actions/hosted-computer.md` (new), `docs/vector/MODEL-PLANS.md`, `codium-deviations.md` ("A51 Hosted core") |
| Tests | `test/hosted-ledger.test.ts`, `test/hosted-fixture.ts` (new); the tripwire list in `test/codium-pool.test.ts`; `HGETALL` in `packages/web/test/fixture/codium-fakes.ts`; one expectation and a new case in `packages/web/test/model-plan-estimate-api.test.ts` |

## Edits to `api/_lib/model-plan-*.ts`

- `model-plan-account.ts`: `PoolHold` has a new field `pool` (the key hash the hold was placed on), returned by
  `holdPool`. Nothing else changed.
- `model-plan-estimate.ts`: the hosted form, and the per-step answer and cache moved unchanged into `answerStep`, shared
  by both forms.

## How it works

- **A block** is 15 minutes of one session on one computer. `openBlock(account, {session, size, renew?})` checks the
  plan from the snapshot (a first block only while active; a renewal while active or renewing within the grace; the
  `hosted` switch's `no-new` and `stop` narrow both), the size and the daily share, then holds 20 minutes at the charged
  rate with `holdPool` (purpose `hosted`, no run id, lapsing after 30 minutes). Then one script (`OPEN`) moves any lapsed
  blocks to the settle queue, needs the session free and fewer running than the plan's computers (first block) or the
  session on the block being renewed, reserves up to 15 minutes of what is left of the plan's hours (weighted), and
  stores the block in `hosted:running:<account>`. Anything refused after the hold gives the hold back. It answers when
  the block's minutes are up (`endsAt`) and the latest the session may run on its hold (`stopBy`).
- **Settling.** A renewal, `closeBlock` or the reaper's `LAPSE` moves an ended block to `hosted:settle:<account>`;
  `settlePending` (or `drainHostedSettles`) settles it under the account's lease: minutes rounded up at the charged
  rate, up to the hold on the hold's key when that key is still the account's, otherwise on the current key with the
  old hold given back, and anything past the hold as an overrun debit. Then the minutes count in that period's hours
  (once), the line is written (once), and the block leaves the queue. A failure anywhere leaves it queued, already marked
  with where its charge went, and `drainHostedSettles` retries after a minute.
- **Nightly and retention.** `chargeNightly(account, {computer, day, storageGbDays, egressGb})` charges a computer's
  day once per ref (`hs-`/`he-<computer>-<day>`); an ended plan's storage is not charged there. `chargeRetention`
  charges an ended plan's disk days to the final key, as many as it can still cover, once per computer and period.
- **True-up.** `trueUpCharge(account, {ref, actualCostMicro})` lowers one line's debit to min(current, cost + 10%),
  on the current period's key only, and records it on the line.
- **Lines** are written by `vector_hosted` (`record` once per ref, `get`, `trued`, `period` totals for A53's drift
  check). The SQL refuses a charge below its worst-case cost and a true-up that raises.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| root | `test/hosted-ledger.test.ts` (new; the contract's file) | 28 pass, 1 skip (Valkey, CI) |
| root | `test/codium-pool.test.ts` (tripwire list) | 27 pass |
| root | `test/codium-plan-change.test.ts`, `test/codium-mode.test.ts`, `test/api-module-loading.test.ts`, `test/no-topups.test.ts`, `test/no-project-wording.test.ts` (unchanged) | 29, 18, 1, 4, 2 pass |
| web | `test/model-plan-estimate-api.test.ts` (hosted form) | 13 pass |
| web | `test/model-plan-status-api.test.ts`, `test/codium-configuration.test.ts` (unchanged) | 22, 11 pass |

`test/hosted-ledger.test.ts` covers:
- **Rates:** the contract's figures, every charge at or above cost plus 10%, rounding up to the minute, storage, egress
  and its setting, the true-up formula (only lowers, never below cost), the provider cost from usage.
- **Plan rules:** §4.4's cloud computer row per state and switch, disk policy per state, the trust ramp recomputed at
  read time, start refusals (size, job length, switch, not listed and not allowlisted, Plus, paused) with their codes.
- **M8:** a block holds 20 minutes before it starts and settles 7.5 minutes as 8 at the charged rate, with the line and
  hours; no block opens on a pool that cannot cover its hold; M3 (hosted spend lowers status's share left and refuses a
  model hold); renewal; overrun; a lapsed block charged its whole hold; idempotent settle across a ledger outage;
  computers at once and the hours as caps; the daily share before the hold.
- **Late settle:** a block that ran across a renewal is charged to the new period with when it ran; the replaced key
  keeps nothing. A session renewed after the renewal counts each block once in the new period's hours.
- **Upgrade fresh meters:** Max to Ultra starts the new period's hours at 0 under Ultra's caps; a block running across
  the upgrade counts there and is charged to the successor key.
- **Storage, egress and retention:** charged once; an ended plan's retention paid from the final period and shortened
  when it cannot cover it.
- **True-up:** lowers the debit and raises the key's limit, never raises, never below cost; an unapplied debit keeps its
  own hold at the new amount; another period's charge is left alone.
- **Boundaries:** the SQL's grants, no foreign key and no delete; the rates imported by no client package; no account id
  in any line; account deletion settles and erases the store state but keeps the lines; the status meter's registration.
- **On Valkey (CI only):** `OPEN`, `CLOSE`, `LAPSE`, `METER`, `MARK`, `FINISH`, `MINUTES` and `LOWER` on a real store.

Typecheck: the root `tsconfig.json` (api), `packages/schema` (`tsgo --noEmit`) and `packages/web` (`astro check`, 0
errors) are clean. The two new root test files are outside every typecheck config; they were checked once with a
scratch config (Bun and node types) and are clean.

## CI only

- **The Lua.** With `VECTOR_TEST_REDIS_URL` set, the last case of `test/hosted-ledger.test.ts` runs the ledger's
  scripts and the pool's `LOWER` on Valkey. This Mac has no Valkey and no Lua interpreter: the scripts were reviewed by
  hand and only their TypeScript copies in `test/hosted-fixture.ts` ran here.
- **The SQL.** With `VECTOR_TEST_POSTGRES_URL` set (the Codium lane sets it), every ledger line in
  `test/hosted-ledger.test.ts` goes through `docs/vector/owner-actions/sql/hosted.sql` on the disposable Postgres, as
  `service_role`, instead of `MemoryLedger`. This Mac has no Postgres, so the SQL has never been executed anywhere.
- **Never exercised anywhere:** a real Supabase project, Vercel Sandbox's real billing (the rates are the published
  ones; the true-up's actual cost needs A52/A53's usage reads), and a real renewal or upgrade on Stripe test mode.

## For later packages

- **A52:** `hostedAccount(id)` is the HMAC to name sandboxes from (`vh-<hostedAccount(id)[0:16]>-<n>`). Sizes are
  `HOSTED_SIZES` (2 vCPU/4 GB and 4 vCPU/8 GB).
- **A53:** call `requireHostedStart` before a session, then `openBlock` for its first block and again with `renew` before
  each `endsAt`; stop the computer by `stopBy` when a renewal is refused, then `closeBlock` with the moment it stopped.
  Run `drainHostedSettles` from the reaper every minute. The nightly job calls `chargeNightly` per computer and day, and
  `trueUpCharge` per line once it has the provider's usage (`computeCostMicro`); the drift check reads `periodCharges`.
  The hosted provisioner calls `chargeRetention` when a plan ends (days from `hostedDiskPolicy`) and deletes the disk
  at its `until`. Add `computer`'s readiness check in `perkServices` (provider, snapshot and `hostedLedgerConfigured()`).
- **A56:** the pre-start ceiling is the estimate's hosted form.
- **A57:** call `eraseAccountHostedLedger(account)` after the hosted provisioner stopped the computers. Lines stay.
- **A60 / legal read:** the privacy page's `#hosted-computer` should say the ledger keeps, per charge, the units, what
  was charged and when, under a keyed hash of the account, after deletion.

## Not done

- No route, provider call, cron, provisioner or screen: those are A52–A56. `computer` and `overnight` cannot be listed.
- No hosted job queue (`hosted:jobs:due`, A55).
- bun.lock was not touched. Nothing was pushed or deployed.
