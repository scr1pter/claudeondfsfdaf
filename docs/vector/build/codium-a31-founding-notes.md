# A31: Founding members

A31 follows A30 (`45e35c0d`) and implements the contract's WP A31 on top of A09 (checkout, upgrades) and A11 (switches). No schema, protocol or generated client changed, so no generator ran. No service, account, deployment or provider was called.

## What changed

- **`api/_lib/codium-founding.ts` (new).** The founding window, slots, numbers, the end of a membership, the founders page and the badge, with ten store scripts (`FOUNDING_SCRIPTS`).
  - Window: the earlier of `CODIUM_FOUNDING_LIMIT` (500) paid founders or `CODIUM_FOUNDING_DAYS` (90) after `sales-opened-at` (`MODEL_PLANS_SALES_OPENED_AT` overrides it). Before the first paid month the window has not started, so it is open. Founders counted plus slots still held must stay under the limit. Invalid settings close the window and appear in `codiumBillingConfigProblems()`.
  - Slot: `reserveFoundingSlot` (RESERVE) holds a founding token in the sorted set `founding:reserved` until two days after the checkout closes. An account that has or had a founding record gets none.
  - Number: `assignFoundingNumber` (ASSIGN) reads or writes `founding:member:<account>` (a hash: number, token, subscription, at, listed, ended) and takes the next `founding:count` in the same script. A replayed or parallel `invoice.paid` gets the same number and the count rises once (M13).
  - `settleFounding`, called by reconcile: the governing paid month carrying a token assigns the number; an upgrade carrying the member's token takes the membership over (CARRY); when the subscription carrying it is cancelled and no other live subscription carries the token, the record is marked ended (END), its founders-page entry and name go, and the record stays so the account never gets a second number. It answers the snapshot's `founding: {number, boost}`; accounts whose subscriptions carry no token make no store call.
  - The founders page: `setFoundersListing` (OPT), `syncFoundersListing` (SYNC), `foundersPage` (LIST), `eraseFounding` (ERASE), a random slug made at first use (`founding:slug`), `foundersBadge` (escaped SVG) and `validFoundersName` (1–40 letters, digits, spaces, `.`, `'`, `_`, `-`).
- **`api/_lib/model-plan-config.ts`.** `subscriptionPlanCredits` applies `ENTITLEMENTS[plan].foundingBoost` (+10%, to the cent) to a subscription carrying a founding token: Plus and Pro only. `modelPlanLegacyPrices()` reads `STRIPE_MODEL_PLAN_LEGACY_PRICES_<price>` (`price_id:cents,…`); `modelPlanForPrice()` finds a plan by its current price (at the plan's price) or a legacy price (at its own old amount); `modelPlanLegacyPriceProblems()` and the founding settings join the config problems.
- **`api/_lib/model-plan-account.ts`.** Checkout offers founding only while `founding` is listed (which includes its window), reserves the slot after the funding reservation, and only then puts the token on the session and the subscription (`metadata[vector_founding]`, `subscription_data[metadata][vector_founding]`); the funding reservation uses the boosted credits; a replaced or expired earlier checkout gives its slot back first; the checkout record keeps the token. Upgrades copy the current subscription's token onto the upgrade checkout (server-side, never from the request), reserve the boosted credits when the new plan has a boost, and compare the token before reusing an open upgrade checkout. `paidModelPlan` accepts a legacy price at exactly its legacy amount (price and invoice), returns `founding` and `legacy`, and its credits carry the boost; `subscriptionPlanId` knows legacy prices. Reconcile calls `settleFounding` and writes `founding` into the snapshot; the frozen-account owed figure counts the boost. Account deletion (`cancelModelPlanAccount`) erases the founding record, its page entry and name (P5).
- **`api/_lib/codium-provisioners.ts`.** The `founding` stub is replaced: while `founding` is in `CODIUM_LISTED_PERKS`, each snapshot change converges the founder's page entry (hidden while frozen, shown again after) and a closing account's record is erased.
- **`api/_lib/codium-perks.ts`.** `founding`'s readiness check is the window, read at runtime, so founding leaves /codium, the account page and Settings when the window closes.
- **`api/_lib/codium-snapshot.ts`.** `SnapshotFacts.founding`, written into the snapshot (the schema field already existed).
- **`api/_lib/model-plan-status.ts`.** Status sends `founding: {number}` (never the boost) whenever the snapshot has it.
- **`api/model-plans/webhook.ts`.** `checkout.session.expired` reads the session again at the pinned version and releases an expired session's founding slot, best effort (a slot also lapses on its own).
- **`api/_lib/codium-ledger.ts`.** The private ledger recognises a legacy price as its plan.
- **Routes (new).** `GET|POST /api/account/founding` (website session or the desktop's account token; 30 an hour): the membership and the founders-page choice with an optional display name. `GET /api/founders`: the founders page (by number and chosen name), only with the slug (`x-vector-founders`, or `slug` for a badge) until 30 founders are listed; `?badge=<n>` serves an SVG badge with `nosniff` and a no-script CSP.
- **App.** The sidebar chip shows a small "Founding" mark after the plan and adds "founding member #N" to its accessible name (`accountChip` in `vector-account.ts`, `workspace-navigation.tsx`). Settings → Account adds a "Founding member #N" row and the lock line (`account-model.ts`, `account.tsx`).
- **Website.** The account page shows a founding block with the opt-in and the optional name (`FoundingMember.tsx`, inside `ModelPlans.tsx`); the status decoder keeps `founding` (`lib/model-plans.ts`). `/founders` (new page and island) reads the slug from the address's fragment, which browsers never send, and shows the list. `script/prune-vector-site.mjs` keeps `founders`.
- **Configuration and docs.** `.env.example` adds the legacy price lists and the founding settings. `docs/vector/MODEL-PLANS.md` gains a "Founding members" section; `owner-actions/codium-payments.md` lists the new settings.

## Edits to `api/_lib/model-plan-*.ts`

`model-plan-account.ts` (checkout, upgrade, `paidModelPlan`, `subscriptionPlanId`, reconcile, frozen owed figure, deletion), `model-plan-config.ts` (boost, legacy prices, config problems), `model-plan-status.ts` (status `founding`).

## Tests

Run one file at a time with `--timeout 30000`, root tests from `test/`, package tests from their package:

| File                                                                             | Result                            |
| -------------------------------------------------------------------------------- | --------------------------------- |
| `test/codium-founding.test.ts` (new)                                             | 20 pass, 1 skip (Valkey, CI only) |
| `packages/web/test/codium-founding-web.test.ts` (new)                            | 3 pass                            |
| `packages/app/src/vector-account.test.ts` (one case added)                       | 15 pass                           |
| `packages/app/src/components/settings-v2/account-model.test.ts` (one case added) | 20 pass                           |
| `packages/web/test/codium-public.test.ts` (one case extended)                    | 11 pass                           |
| `test/codium-billing.test.ts`                                                    | 52 pass, 2 skip (Valkey)          |
| `test/codium-plan-change.test.ts`                                                | 29 pass                           |
| `test/codium-outbox.test.ts`                                                     | 18 pass, 2 skip (Valkey)          |
| `test/codium-renewal.test.ts`                                                    | 32 pass                           |
| `test/codium-replay.test.ts`                                                     | 27 pass, 2 skip (Valkey)          |
| `test/codium-topups-removed.test.ts`                                             | 10 pass                           |
| `test/codium-mode.test.ts`                                                       | 18 pass                           |
| `test/codium-risk.test.ts`                                                       | 23 pass, 1 skip                   |
| `test/codium-funding.test.ts`                                                    | 25 pass                           |
| `test/codium-owner.test.ts`                                                      | 34 pass, 1 skip                   |
| `test/no-topups.test.ts`                                                         | 3 pass                            |
| `test/api-module-loading.test.ts`                                                | 1 pass                            |
| `packages/web/test/model-plan-status-api.test.ts`                                | 21 pass                           |
| `packages/web/src/components/marketing/account/ModelPlans.test.ts`               | 19 pass                           |
| `packages/web/src/lib/model-plans.test.ts`                                       | 15 pass                           |

`test/codium-founding.test.ts` covers M13 (five parallel assignments, two parallel `invoice.paid` webhooks, replays), the window by limit, slots and days (with the override and invalid settings), listing, checkout marking and slot release on replacement and on `checkout.session.expired`, a closed window and a former founder, the boost on Plus ↔ Pro and none on Max (through `/change`, the copied token and two paid upgrades), the legacy price at exactly its amount, a subscription kept active when its plan's price id moves on, cancellation ending it, a resumed cancellation and a failed payment keeping it, the status number without the boost, the founders page (slug, 30-founder threshold, names, badge escaping), both routes, the provisioner and account deletion.

Typecheck: root `tsconfig.json` (api) clean; `packages/app` `tsgo -b` clean; `packages/web` `astro check` 0 errors, 0 warnings.

## CI only

- The Valkey case in `test/codium-founding.test.ts` runs the ten scripts on a real Valkey (`VECTOR_TEST_REDIS_URL`), including eight parallel assignments. Locally the fake store's TypeScript copies run instead.
- `packages/web/test/codium-payments.test.ts` and `model-plans-api.test.ts` spawn `valkey-server`, which this Mac does not have; they were not run here and A31 did not change their paths beyond what the fakes cover.
- `/founders`, the account page's founding block and the sidebar mark were not looked at in a browser (no dev server runs on this Mac). Their decoders and static render are tested.
