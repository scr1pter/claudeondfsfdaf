# A14 environment, schedules and private economics

This is the configuration/economics slice of A14. The Stripe setup orchestration is owned by the accompanying A14 change. No provider settings, secrets, deployments or paid services were changed. All 11 focused configuration/economics cases and the coordinated web typecheck passed; canonical push/CI evidence is recorded with the accompanying A14 change.

## Implemented configuration

`.env.example` keeps sales disabled and private allowance/price/secret values empty. It documents the existing separate test/live stores and runtime restricted key, the single no-change portal, canonical `CODIUM_STRIPE_AUTOMATIC_TAX=false`, A10 risk settings, A11 collection pause/funding thresholds, A12 allowlisted Google owner sessions and the A13 per-team spend callback. The local setup key is distinct from the deployed runtime key. The removed change-portal and customer top-up variables have no example slots.

The owner dashboard uses the existing Supabase Google sign-in and `/account` OAuth return. Explicitly configure `VECTOR_ADMIN_EMAILS` for owner access; when blank the existing Design Lab owner fallback still applies. Mutations require a Google sign-in less than ten minutes old. `CODIUM_OWNER_SECRET` is for the private ledger API only and is never placed in a browser. Owner mail uses the configured Resend sender. Configure the same top-up threshold as the separate Codium OpenRouter account's dashboard; a blank threshold disables the watchdog, and Vector never buys credits itself.

The Vercel callback uses the main and hosted team's distinct IDs and signing secrets. Main alerts only; hosted escalates to `no-new` at 75% and `stop` at 100%. A callback never reopens hosted service. These variables do not enable a hosted service or perform Vercel account setup.

Future gateway/listing/service variables in §4.16 are not presented as working controls before their implementing work package. In particular, A14 does not enable service routes, perks, a gateway reserve, hosted compute, Workers or Track B.

## Cron gates

The existing `vercel.json` billing entries already match §4.19 and remain unchanged: outbox every minute; replay and funding every ten minutes; risk sweep hourly at minute 47; full sweep daily at 04:23 UTC. `CRON_SECRET` authenticates every billing job. The preexisting free-model refresh and share cleanup schedules are preserved.

The following §4.19 entries are deliberately absent from deployment configuration until their route implementation and local/provider acceptance gates are complete. Add each schedule in the work package that supplies its authenticated handler; do not poll a missing route.

| Future route          | UTC schedule   | Implementation gate           |
| --------------------- | -------------- | ----------------------------- |
| `/api/hosted/reaper`  | `* * * * *`    | Hosted controls/reaper        |
| `/api/hosted/drift`   | `*/10 * * * *` | Hosted drift reconciliation   |
| `/api/hosted/nightly` | `30 2 * * *`   | Done by Morning scheduling    |
| `/api/vault/cleanup`  | `40 3 * * *`   | Vault lifecycle cleanup       |
| `/api/ops/domains`    | `10 4 * * *`   | Domain and certificate checks |
| `/api/ops/guard`      | `*/10 * * * *` | Ops guard                     |
| `/api/ops/cleanup`    | `40 4 * * *`   | Ops retention cleanup         |

## Economics boundaries

Run `bun scripts/codium-economics.ts` from `packages/web` only in a private owner terminal with private allowances configured. The script reads the current four shared monthly tiers; it refuses absent, invalid or ratio-inconsistent allowances instead of treating missing model cost as zero. It makes no provider requests and does not affect billing or balances. Its output includes private credit allowances and must not be published.

The provider-fee estimate follows `CODIUM_OPENROUTER_FEE_PERCENT` (the ledger's default 5.5%) unless `CODIUM_PROVIDER_FEE_PERCENT` explicitly overrides planning. The other retained planning assumptions are payment processing 2.9% plus $0.30 and subscription billing 0.7%. These are unverified planning inputs, not newly verified account fees or provider contracts. Blank optional values use the documented estimates; explicit zero remains available for sensitivity analysis. Confirm the owner's actual provider/card/billing terms before using the result for launch decisions.

The calculation subtracts the entire configured monthly allowance, its estimated provider purchase fee, and estimated payment/subscription fees. It reports contribution before hosting, support, tax, fraud, refunds and other expenses, rather than claiming net profit. It adds neither top-up/annual offers nor allowance defaults.

## Validation

- `packages/web/test/codium-configuration.test.ts`: 11 passing cases covering env removal/canonical tax/private blanks, existing-route cron schedules, current monthly tier math, private allowance refusal and fee assumptions.
- Web package typecheck passed with zero errors and zero warnings, coordinated with the accompanying setup-script change. The intentionally invalid-price test uses an explicit unsafe-input boundary; runtime types were not widened.

The focused tests use synthetic allowances solely to exercise the public ratios. No production allowance or real credential is included in their fixtures.
