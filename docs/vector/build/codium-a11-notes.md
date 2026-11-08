# A11 runtime switches and collection ownership

A11 is committed and pushed on `codium`; its complete GitHub CI passed in [run 40786941008](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40786941008) at `72e6e9c1`. Independent final billing review is complete. No provider configuration, live payment, deployment or sales enablement was performed.

## Runtime controls

`readSwitch(name, fetcher)` retains its existing interface and gains an optional fresh-read/clock argument. Ordinary reads cache for at most 30 seconds, isolated by fetcher and Stripe mode. Checkout and financial collection decisions bypass that cache. Direct model credentials and Codium entitlement admission now honor the runtime Codium switch before provider or Stripe work.

`writeSwitch` changes the record and appends its audit event in one Valkey script. A no-op preserves the generation and the first continuous off timestamp. Returning on and then off starts a fresh clock. Bare pre-A11 values and earlier `{value}` records remain readable; a legacy off state starts its clock when first observed. Model/perk kill sets have separate atomic audited mutation helpers for subsequent catalog/listing work. Audit actor identifiers accept no email addresses, and records are bounded to 90 days.

## Collection effects

The minute outbox cron schedules a generation-scoped collection scan, due after the configured service-off interval (60 minutes by default). Each scan uses `ZSCAN` and queues account work; unfinished durable pages and account actions retry through the normal outbox. Every action reads current switch state again, and pause/resume writes recheck the generation immediately before Stripe. Stale jobs cannot reuse time from an earlier off period.

Collection changes hold the account's billing lease and persist per-subscription intents before Stripe writes. Service pauses have their own account/token metadata; they never claim an owner pause or an A10 risk pause. An owner changing the behavior, resume time or ownership marker ends Vector's prior ownership. A fresh later off cycle uses a new provider idempotency token.

Service-on resumes only an owned pause on the governing subscription, with Codium enabled and no remaining risk/closing hold. Superseded and duplicate subscriptions stay paused. The implementation also recognizes the earlier renewal guard's `vector_paused_for=codium-off|frozen` pauses; it preserves owner and A10 risk ownership.

Exact held renewal IDs are stored before a renewal guard stops collection or changes `auto_advance`. Both pause and resume merge newly visible collectable invoices into that intent. A risk win may clear its own pause first, but the durable invoice intent remains until that exact invoice has been checked and queued for `finalize-renewal`. A lost response or lost lease after resumption therefore cannot strand the invoice with `auto_advance=false`. Invoice/customer/subscription provenance is rechecked before holding or requeuing it, and the renewal handler still applies all existing payment guards.

The sales switch remains independent of renewal collection and already-paid upgrade reconciliation. Funding warnings and a sales pause never cancel or disable purchased service (M12).

## Funding

[Funding notes](codium-a11-funding-notes.md) document the seven-day history, private integer-cent rates, runway, low-water alerts, top-up watchdog and spend spikes. The full A10 deferred-liability/version protocol and atomic checkout reservations remain in the funding reading. No API can purchase provider credits.

## Validation

Files ran individually from `packages/web` with a 30-second per-test timeout. HTTP and optional Lua checks used an ephemeral local Valkey and local fake Stripe/OpenRouter/Resend boundaries. The server was shut down after the checks. API typecheck ran from `packages/engine` using `bun typecheck --project ../../tsconfig.json`. Subsequent workloads use the local `vector-serial` lock wrapper as required by the parent coordinator.

- `test/codium-switches.test.ts`: 19 passing, including two real Valkey concurrency/audit cases. Covers the 30-second cache, continuous off clock, stale jobs, owner takeover, exact renewal resumption, risk/service hold ordering, late invoice visibility, lost responses/leases, and funded renewals while sales are off.
- `test/codium-funding.test.ts`: 21 passing. Includes the same-bucket cumulative-usage adjustment regression and private cron response checks.
- A10 regression files remain green: risk 23, billing 53, renewal 30, replay 29, mode 18, outbox 20, pool 18 and plan-change 21. These include seven real Valkey cases. The outbox cron fixture now counts the generation scan and its account collection check as well as its provisioner action.
- `test/codium-topups-removed.test.ts`: 10 passing, including the canonical A10 CI fixture correction.
- HTTP integration: `packages/web/test/model-plans-api.test.ts` 43 passing and `packages/web/test/codium-payments.test.ts` 22 passing against real Valkey/local HTTP fakes.

Total: **327 unique passing tests across 13 files**, including **9 real Valkey cases**, and a passing API typecheck. No unresolved test failures remain. Independent billing review rechecked the held-renewal repairs, pause ownership/generation guards, funding liability/reservations and telemetry/alert privacy, and found no remaining confirmed financial, security or cost-correctness blockers. The canonical pre-push hook and complete GitHub CI subsequently passed.

### Funding clock rollback follow-up

A later review reproduced four cases in which a future-dated cached funding reading admitted a sale or early renewal charge. Both admission paths now refresh such a reading and reject it if a busy funding checker returns the same future-dated fallback. Current readings and readings just below the existing fifteen-minute age limit remain usable. A failed refresh refuses the new sale or early charge; it does not pause purchased service or claim ownership of Stripe's collection schedule.

All four new admission cases failed against the prior source. The initial targeted renewal run also hit the default five-second fixture hook timeout; the complete verification used the required thirty-second per-test timeout. After the repair, `test/codium-funding.test.ts` passed **25 tests**, `test/codium-renewal.test.ts` passed **32 tests**, and the API typecheck passed. The six added cases use isolated fake providers and stores. Independent review approved the four runtime guards and their boundary coverage. This follow-up's canonical push and complete CI are recorded separately from the earlier A11 run above.
