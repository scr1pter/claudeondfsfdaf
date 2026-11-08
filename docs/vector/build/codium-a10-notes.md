# A10 risk build notes

Implemented on `codium-next`, based on A09 at `38aae992`. Local validation and independent safety review are complete. Full branch CI passed at canonical `ee181efa`; protected provider e2e remains a release check.

## Boundaries

Implement only A10: checkout 3-D Secure policy, early-fraud handling, dispute collection effects, trust/pool ramps and their money invariants. No live Stripe/OpenRouter requests, deployment, account setup, hosted compute or new perks. A11 starts only after A10 tests, typecheck and review pass.

## Payment and risk ordering

- An earlier paid, unreversed Codium invoice must be at least the target plan's price to exempt a high-value checkout from requesting 3DS. A previous Max payment does not exempt the first Ultra payment. Invalid monetary fields never grant an exemption.
- Recompute this decision before reusing an unpaid checkout; a reversal of the invoice that exempted it must not preserve an outdated exemption.
- Persist the risk state and pause intent, write the frozen/ended entitlement, and disable the provider key before financial side effects. Reconcile retries re-read the warning/payment rather than trusting webhook contents.
- A risk write must belong to this customer and a Codium invoice/subscription. An unrelated product's warning must not act on Codium.
- Actionable warnings with the default `CODIUM_EFW_REFUND=true` refund and cancel immediately. Non-actionable warnings or the explicit refund-off setting freeze only. The mapping fixture now explicitly represents a non-actionable warning; new risk tests cover both branches and assert disabled access before every Stripe mutation.
- Collection unpause requires Vector's persisted pause ownership, the governing subscription, no other risk hold, and Codium enabled. Owner pauses are preserved.

## Pool ramp and carry

The first high-value cohort stays restricted for 72 hours if that payment was not authenticated with 3DS. A later tier upgrade cannot shorten that window. An Ultra period that starts inside that risk window retains the 40% daily cap for its entire period.

Keep both visible and full paid credit amounts privately. Early upgrades preserve the source month's deferred remainder, while the 12-minute true-up can release only the currently visible remainder. A separate action at the ramp boundary can release the full remainder. Immutable visible/full origin allocations and a revocation mask prevent earlier consumed or refunded credit from being reintroduced.

Provider limits still equal the presently granted credits plus presently granted carry minus applied debits. Replacement keys retain A09's publication barrier while those values converge.

## Funding remains responsible for deferred credit

A lower provider limit does not remove Vector's obligation to grant the withheld paid allowance. A private liability hash adds deferred base and carry to funding's owed figure. Frozen accounts retain the recoverable paid obligation even while their keys are disabled; ending/deletion clears it after access is disabled.

Raise this liability before provisioning and lower it only after the provider's limit converges. A monotonic store version surrounds liability mutations. Funding reads that version before listing keys and atomically reads the version plus liabilities afterward; a changed version fails closed, avoiding a keys-before-release/index-after-release reading that understates the obligation. The index reserves the full pending paid obligation before replacing or creating a key, so a failed creation stays funded after the checkout reservation expires. Conservative double-counting during a transition is acceptable; understatement is not.

## Outbox test isolation

`createActionRegistry()` supplies optional per-drain handler registries. Unit tests use their own registries instead of borrowing action kinds not implemented yet. Production keeps its singleton and refuses duplicate/unknown registration. Internal owner-alert delivery remains outside the public registration allowlist.

## Validation

All tests ran one file at a time from `packages/web`, with a 30-second per-test timeout and only local Stripe/OpenRouter/Resend fakes. API typecheck ran from `packages/engine` with `bun typecheck --project ../../tsconfig.json`.

- `test/codium-risk.test.ts`: 23 passing, including the real Valkey liability/version case. Covers the 3DS history matrix and malformed amounts, EFW replay/refund failures/same-card targeting, access disabled before financial writes, owner pause takeover, direct admission before webhook, Max→Ultra during the pool ramp, full funding before creation, deferred source carry, source reversal before 72 hours and mixed key/index reads.
- `test/codium-plan-change.test.ts`: 21 passing A09 carry, chained upgrades, late hosted debit, source refunds and retry regressions.
- `test/codium-billing.test.ts`: 53 passing including two real Valkey snapshot/meter cases.
- `test/codium-renewal.test.ts`: 30 passing. Existing high-tier key fixtures now include their prior paid history; actual first high-payment behavior is covered in the risk file.
- `test/codium-replay.test.ts`: 29 passing including two real Valkey walk/cursor cases.
- `test/codium-mode.test.ts`: 18 passing.
- `test/codium-outbox.test.ts`: 20 passing including two real Valkey drain/Lua cases and isolated registry behavior.
- `test/codium-pool.test.ts`: 18 passing.
- `packages/web/test/model-plans-api.test.ts`: 43 passing against real Valkey and local HTTP providers. The new case checks the exact `payment_method_options[card][request_three_d_secure]=any` form field for both HTTP subscription checkout and Plus→Max upgrade checkout.
- `packages/web/test/codium-payments.test.ts`: 22 passing against real Valkey and local HTTP providers. Its fakes now support the authoritative invoice/subscription reads and collection writes A10 requires.

Total: **277 unique passing tests across 10 files**, including **7 real Valkey cases**; API typecheck passed. The ephemeral server was shut down afterward. Independent billing review rechecked pause ownership/idempotency, direct admission, pending liability and full/visible origin allocation and found no remaining confirmed blockers.

Full GitHub acceptance: [run 40783630533](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40783630533) completed successfully at canonical `ee181efa`, including all eight typechecks, all selected test files, browser checks, and API/client gates. The inherited legacy top-up-removal fixture now permits paid-history fields and supports the deferred-liability read; this CI-only fix is included in the A11 worktree.

## Protected test-mode e2e checklist

Stripe's acceptance of the subscription-Checkout 3DS field requires the protected owner-approved `codium-test` job. With Preview isolated in test mode, create a first Max subscription checkout and a Plus→Max upgrade checkout; confirm Stripe accepts the exact form field, authenticate the test card, complete payment, and verify the recorded charge outcome controls the initial pool allowance. Repeat with an attempt-acknowledged result and confirm the 30% grant plus outbox release at 72 hours. No real Stripe/OpenRouter request or deployment was made during this work.
