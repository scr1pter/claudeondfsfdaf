# A14 local Stripe setup and configuration

A14 is implemented in the local `codium-next` draft. Independent static review is closed. All 42 setup/configuration cases, the API check and web Astro check passed. The canonical full hook/push and complete CI remain pending. No live Stripe, OpenRouter or Vercel configuration, payment, setup application, deployment or sales enablement was performed.

## Dry-run and owner setup key

`packages/web/scripts/setup-model-plans.ts` exposes the same `setupModelPlans` orchestration to local fake tests and its thin CLI. Importing it has no side effects. The default dry run makes zero network calls, including when the deployed restricted key or no key is present. It lists exactly four monthly prices, exclusive tax behavior, product descriptor/metadata, legacy cleanup, the single no-change portal and the exact webhook event count. It never prints a preview bypass secret.

Explicit `--apply` requires the owner's full `sk_*` setup key; every importable setup boundary enforces that before its first API request. The deployed `rk_*` runtime key is refused with setup-key guidance. The existing mode guard remains in force, including live-key refusal in a preview; setup does not bypass M1. Owner test-mode commands, to run only in the intended account, are:

```sh
cd packages/web
bun scripts/setup-model-plans.ts
STRIPE_SECRET_KEY=sk_test_... CODIUM_STRIPE_MODE=test bun scripts/setup-model-plans.ts --apply
```

A protected preview additionally needs the already documented `VECTOR_PUBLIC_URL` and automation bypass secret. None of these commands was invoked against a live service during implementation.

## Four monthly products and safe cleanup

The script uses the existing four `vector-models-{10,50,100,200}-monthly-v1` lookup keys. Existing amount, currency, monthly recurrence and active status are checked before mutation; the four prices must belong to distinct Codium products. Existing products must have the exact owned metadata or the historical numeric/name identity bound by those known prices. Unrelated products are not renamed or repurposed. New products carry `vector_codium=monthly-v1`, their `vector_plan` and statement descriptor `VECTORDEV CODIUM`. Private credit allowances are not written as public product data.

A fresh provider read confirms the product name, descriptor and metadata and the price/product binding. A lost product-create response is recovered by its ownership metadata, avoiding a fifth product. Duplicate owned candidates are refused for owner resolution. Existing unspecified tax may become exclusive. Inclusive tax is immutable and is refused with explicit replacement/lookup migration guidance, rather than silently reused.

The old top-up creator used the exact `vector-codium-topup-{10,50,100,200}-v1` keys. Cleanup archives only active one-time prices with those keys, expected USD amounts and verified historical Codium top-up product identities. It creates no top-up product or price and never broad-matches another service's top-up name. Fresh reads confirm archival.

Only the owned no-change billing portal is created/reused, with payment methods, invoice history and cancellation at period end. Old `plan-change-v1` configurations are explicitly deactivated and reported. No configuration enabling plan changes is created. Duplicate active no-change marks are refused instead of choosing one silently.

## Exact webhook and provider API constraints

The endpoint is enabled and subscribed to exactly the 20 `MODEL_PLAN_WEBHOOK_EVENTS`: wildcards, missing events and extra events converge to the full exact list. A preview bypass rotation updates the URL without pretending to obtain a new signing secret. Updates and creates are verified by fresh provider reads; a new secret is printed only after its endpoint appears with the correct settings. Same-address duplicates and incomplete listings refuse setup.

Stripe's pinned API version is immutable after endpoint creation. An older-version existing endpoint is explicitly refused with recreate/new-secret guidance. The update request uses supported `disabled=false`, `enabled_events` and `url`; it does not send unsupported `api_version` or `status` update fields. This follows the [API-compatible Stripe SDK v17.7.0](https://github.com/stripe/stripe-node/tree/4b95f81006d6ab3a3f018fe53dba4d42ce82e919): [price tax behavior](https://github.com/stripe/stripe-node/blob/4b95f81006d6ab3a3f018fe53dba4d42ce82e919/types/PricesResource.d.ts#L381) and [webhook update parameters](https://github.com/stripe/stripe-node/blob/4b95f81006d6ab3a3f018fe53dba4d42ce82e919/types/WebhookEndpointsResource.d.ts#L403).

## Environment, economics and schedules

[Configuration notes](codium-a14-configuration-notes.md) document the canonical `CODIUM_STRIPE_AUTOMATIC_TAX=false`, removed change-portal variable, implemented billing/owner/spend settings and private planning assumptions. The economics script refuses missing/invalid monthly allowances or inconsistent usage ratios and labels its fee assumptions as unverified estimates. It does not enable service or purchase provider funding.

All five implemented billing cron entries already match §4.19 and retain existing routes. The seven future hosted/vault/ops schedules are recorded as gated work; no cron was added to poll an unimplemented route.

## Validation and separate test repair

Initial validation ran from package directories through `vector-serial`, one file at a time with a thirty-second per-test timeout. Every setup provider boundary is an in-memory fake that rejects any unexpected destination and models immutable tax/version fields and idempotent response replay. No setup test opens a provider connection.

- `packages/web/test/model-plan-setup.test.ts`: **31 passing**.
- `packages/web/test/codium-configuration.test.ts`: **11 passing**.
- API typecheck from `packages/engine`: `bun typecheck --project ../../tsconfig.json` passed.
- Web Astro check passed: zero errors, zero warnings and 101 informational hints across 183 files.

The first web check found one deliberately invalid-price test needed an explicit unsafe-input type boundary; runtime types and the rejection assertion were preserved, and the final check passed. The first setup run exposed two test expectation issues (the existing mode-guard error code and the specific failure after an ignored metadata update); both were corrected. The single-argument webhook event matrices now wrap their arrays as object properties, so tests pass real wildcard/missing/extra arrays.

The same audit found A13's duplicate-header table row had been unpacked by Bun. Its isolated test-only repair is committed separately as `cfee4e40`; all six focused signature cases passed, including the actual duplicate `string[]` header. Four unrelated Valkey cases were skipped in that focused selection, with no new Lua claim. The other new A09–A14 single-argument tables use scalar/object cases; multi-argument rows intentionally unpack. No runtime guard failed.

Independent review found no confirmed blocker or material acceptance gap in setup key safety, ownership, tax, portal/webhook convergence, retries, configuration or private economics. The canonical push and full CI evidence will be recorded after completion. The planned current-main integration remains the parent coordinator's separate step after this work package.
