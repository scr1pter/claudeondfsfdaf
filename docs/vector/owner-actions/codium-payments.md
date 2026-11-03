# Codium payments: what to set up

Once the steps below are done, Codium runs without anyone acting on a payment. Until then nothing sells: `MODEL_PLANS_ENABLED=false`, Stripe is not connected, and no model route is accepted (`ROUTE_ACCEPTANCES` is empty, contract WP A60). No Stripe account, OpenRouter purchase, key or live setting was created or changed while building this.

Codium sells four monthly plans, Plus, Pro, Max and Ultra, at $10, $50, $100 and $200. There are no top-ups, annual prices or overage charges. The guards you operate once it sells are in [codium-owner-guards.md](codium-owner-guards.md); how it all works is in [MODEL-PLANS.md](../MODEL-PLANS.md).

## What happens on its own

1. **A buyer pays.** Stripe Checkout takes the card payment for a monthly plan. Stripe pays the money out to your bank on its normal payout schedule.
2. **The plan starts at once.** Stripe's signed notification reaches `/api/model-plans/webhook`. vectordev.ai asks Stripe whether the money was really paid, writes the account's plan, and creates the buyer's OpenRouter key capped at that plan's private pool. Notifications are read against Stripe's current state, so retries, duplicates and events arriving out of order never grant anything twice. A notification that never arrives is picked up by replay within 10 minutes.
3. **Renewals.** When Stripe drafts a renewal invoice, vectordev.ai charges it within about a minute through the outbox, but only while the account is not on hold, the subscription is its current one, the `codium` switch is on and the OpenRouter balance covers what is owed. Each paid renewal gets a fresh key at the full pool, so usage resets rather than rolls over. Until the renewal is paid, the previous key keeps serving for `CODIUM_RENEWAL_GRACE_MINUTES` (120 by default, at most 360) past the end of the period, so someone who pays is never cut off.
4. **Plan changes.** An upgrade starts a new month on the bigger plan today, charged in full, and carries what was left of the old month into it once. A downgrade waits for the renewal date. Both happen on vectordev.ai's account page or in the app, never in Stripe's portal.
5. **Access comes off on its own.** The key is switched off, or the plan paused, by a failed renewal (past due), a payment that needs the bank's confirmation, a cancellation once the paid period ends, a full refund of the current charge, a dispute on any Codium charge (until Stripe reports that you won it), and an early-fraud warning. With `CODIUM_EFW_REFUND=true` (the default), an actionable warning also refunds the warned charge and cancels the plan.
6. **OpenRouter is paid by OpenRouter's auto top-up.** OpenRouter has no API for buying credits, so Vector cannot pay OpenRouter by itself. OpenRouter's own auto top-up charges your saved card whenever Codium's balance falls below the threshold you set, and OpenRouter takes its fee on each of those purchases.
7. **Sales pause when OpenRouter can't cover them.** Every 10 minutes the funding check compares Codium's OpenRouter balance with everything customers can still spend, the plans in checkouts that may still be paid, room for one more of the largest plan, and a margin (10% plus $20 by default). When the balance is less, or the check cannot read OpenRouter, new checkouts and upgrades are refused and you get an email; sales reopen by themselves at the first check that finds enough. Renewals and service for people who already pay continue throughout. Details are in [codium-owner-guards.md](codium-owner-guards.md#funding).
8. **Every payment lands in a private ledger** with the price, any refund, Stripe's fee and net, the model spend the payment can still cost, OpenRouter's fee on buying it, and the profit left. Only you can read it (see [Reading the ledger](#reading-the-ledger)).

## 1. Stripe

Do all of this in **test mode** first, for the preview test run in [section 4](#4-test-mode-run-before-selling), then repeat it in live mode for Production.

1. Finish the account: business details, identity verification and the bank account for payouts.
2. **Create the prices, the portal and the webhook** with the setup script. It needs your full secret key (`sk_test_…`, then `sk_live_…`), used only on your own computer. It refuses a restricted `rk_` key. From `packages/web`:

   ```sh
   bun scripts/setup-model-plans.ts            # dry run: shows what it will do, makes no network call
   # Test mode, for the preview in section 4:
   STRIPE_SECRET_KEY=sk_test_... CODIUM_STRIPE_MODE=test VECTOR_PUBLIC_URL=https://<preview address> \
     VERCEL_AUTOMATION_BYPASS_SECRET=<bypass secret> bun scripts/setup-model-plans.ts --apply
   # Live mode, for Production:
   STRIPE_SECRET_KEY=sk_live_... CODIUM_STRIPE_MODE=live VERCEL_ENV=production VECTOR_PUBLIC_URL=https://vectordev.ai \
     bun scripts/setup-model-plans.ts --apply
   ```

   It creates or reuses:
   - four monthly prices, one per product `Vector Codium Plus`, `Pro`, `Max` and `Ultra`, with lookup keys `vector-models-{10,50,100,200}-monthly-v1`, `tax_behavior=exclusive` and the statement descriptor `VECTORDEV CODIUM`;
   - one customer portal configuration without plan changes: payment-method updates, invoice history and cancellation at the end of the period;
   - the webhook at `/api/model-plans/webhook`, API version `2025-02-24.acacia`, subscribed to exactly these 20 events: `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `.updated`, `.deleted`, `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `.updated`, `.closed`, `.funds_reinstated`, `radar.early_fraud_warning.created`, `.updated`, `subscription_schedule.released` and `subscription_schedule.canceled`.

   It also archives the legacy top-up prices an earlier version created, and deactivates an old plan-change portal it made; remove that portal's environment value. It prints `STRIPE_MODEL_PLAN_<price>_PRICE_ID` for the four prices, `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID` and, for a new webhook, `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`. Stripe shows the signing secret only once, so copy it straight into Vercel. Running the script again reuses what exists and lists anything that differs; a webhook made at an older API version has to be recreated, and the script says so.

3. **The runtime key.** Create a restricted key (`rk_test_…`, then `rk_live_…`) for vectordev.ai and never deploy the `sk_` setup key. Codium's server creates Checkout Sessions, portal sessions and refunds; updates customers, subscriptions, subscription schedules and invoices (finalize, pay, void, delete drafts, pause collection); reads charges, disputes, early-fraud warnings, events, balance transactions and prices; and, only when `CODIUM_RADAR_BLOCKLIST_ID` is set, adds Radar value-list items. Give the key exactly those permissions. The test run in section 4 exercises each of them; a missing permission shows as a Stripe permission error there.
4. **Dashboard settings** the API cannot set (the owner page lists them as a checklist):
   - Billing → Revenue recovery: Smart Retries, and cancel the subscription after the last retry;
   - customer emails for failed payments and for payments that need 3-D Secure;
   - your Terms of Service URL (`https://vectordev.ai/legal/terms#codium`), shown at checkout;
   - Radar's default rules; optionally a block list, whose id goes in `CODIUM_RADAR_BLOCKLIST_ID`;
   - tax: set up Stripe Tax first, then `CODIUM_STRIPE_AUTOMATIC_TAX=true`. Prices are tax-exclusive.
5. Keep the card as the only payment method, with no trials or coupons: Codium starts a plan only for a full, paid card charge.
6. Optional: Stripe's emailed receipts for successful payments and refunds. vectordev.ai also sends its own purchase confirmation, which restates the consent, the renewal and how to cancel.

## 2. OpenRouter

1. **Which account.** Use a separate OpenRouter account for Codium, never the one behind `OPENROUTER_FREE_API_KEY`. The free-models account must stay without automatic top-up and with ZDR off (see [openrouter.md](openrouter.md)); Codium's account needs a balance, automatic top-up and ZDR on.
2. **Management key.** Create one under Settings → Management Keys (some OpenRouter pages call these provisioning keys). It goes in `OPENROUTER_MANAGEMENT_KEY`. It creates, caps and switches off each buyer's key, and reads the balance and key list for the funding check.
   - Do not rename or delete Codium's keys in the OpenRouter dashboard. The funding check counts keys named `Vector <account id> …` (and `Codium <account id> …` from before); test keys are named `Vector test …` and the live check never counts them.
3. **Starting balance.** Add enough to cover your first customers. Before the first sale, the funding check needs the balance to cover the pool of your largest plan, multiplied by 1.1, plus $20. The test run in [section 4](#4-test-mode-run-before-selling) needs a few dollars more; each test key is capped at `CODIUM_TEST_CREDIT_CAP_USD` (0.50 by default).
4. **Auto top-up** (Settings → Credits). Turn it on and set:
   - **Threshold:** at least what the funding check needs at your busiest point: what customers' keys can still spend, plus the plans bought in about 90 minutes, plus the pool of your largest plan, all multiplied by 1.1, plus $20. Below that, the balance can sit between the two: auto top-up does not fire, and sales stay paused until you add funds or raise the threshold. Put the same number in `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD`, so you get an email when auto top-up has not fired 20 minutes after the balance fell below it.
   - **Amount:** at least a week of expected model spend, so the card is charged in a few large purchases rather than many small ones.
   - **A backup card**, so a declined card does not stop the refills.
5. **Fee.** OpenRouter charges a fee on every purchase of credit, auto top-ups included (5.5% by card when this was written, unverified). Set `CODIUM_OPENROUTER_FEE_PERCENT` to the fee its credits page shows, so the ledger's estimate stays right.
6. **Resale terms.** OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict reselling API access. Confirm Codium is covered by suitable commercial terms before selling.
7. **Privacy settings** (before the first sale, on this account only). The labels come from OpenRouter's documentation; match them to what the pages show.
   - Settings → Observability: **Private Input & Output Logging — OFF.** If it is on, OpenRouter stores every Codium prompt and reply, and the privacy policy's zero-data-retention description stops being true.
   - [Settings → Privacy](https://openrouter.ai/settings/privacy): **OpenRouter Use of Inputs/Outputs (the 1% discount) — OFF.**
   - Same page: **paid models, allow providers that may train — OFF**, and **providers that may publish prompts — OFF.**
   - Same page: **ZDR — ON for every model group** (Anthropic, OpenAI, Google, SpaceXAI and all other models). Codium already sends `zdr: true` on every request, so this is a second guard. Never turn this on for the free-models account (see [openrouter.md](openrouter.md), step 4).
   - No BYOK provider keys, and no default or enforced plugins on this account.
   - Once these are set, confirm it, so the privacy policy can say Vector keeps logging and input/output use off.

## 3. Vercel environment

Set these for **Production** with the live values (secrets only in Vercel, never in the repository), then redeploy. The test run sets its own copies for one preview branch ([section 4](#4-test-mode-run-before-selling)). `.env.example` lists every variable with a comment.

| Variable                                                                                                                                                            | What to set                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PLANS_ENABLED`                                                                                                                                               | `false` until the test-mode run passes, the live values are in and the launch checks are done, then `true`. Never back to `false` while anyone is subscribed: use the `sales` and `codium` switches.                                                                                                  |
| `CODIUM_STRIPE_MODE`                                                                                                                                                | `live` (Production) or `test` (the preview). It must match the key; a live key runs only where `VERCEL_ENV=production`.                                                                                                                                                                               |
| `STRIPE_SECRET_KEY`                                                                                                                                                 | The restricted runtime key (`rk_live_…`), never the `sk_` setup key                                                                                                                                                                                                                                   |
| `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`                                                                                                                                  | The webhook's signing secret (`whsec_…`)                                                                                                                                                                                                                                                              |
| `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`                                                                                                                                | The portal configuration without plan changes (`bpc_…`)                                                                                                                                                                                                                                               |
| `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`                                                                                                                        | The four monthly price IDs                                                                                                                                                                                                                                                                            |
| `CODIUM_STRIPE_AUTOMATIC_TAX`                                                                                                                                       | `false` until Stripe Tax is set up                                                                                                                                                                                                                                                                    |
| `MODEL_PLAN_{10,50,100,200}_CREDITS_USD`, or `MODEL_CREDIT_MARKUP_PERCENT`                                                                                          | Your private pools. There is no default. Pro, Max and Ultra must be 5.5x, 12x and 25x Plus's (within 0.05), or Codium stays off.                                                                                                                                                                      |
| `OPENROUTER_MANAGEMENT_KEY`                                                                                                                                         | The Codium account's management key                                                                                                                                                                                                                                                                   |
| `MODEL_PLAN_KEY_ENCRYPTION_SECRET`                                                                                                                                  | 64 hex characters (`openssl rand -hex 32`). Keep it forever: changing it makes every stored buyer key unreadable.                                                                                                                                                                                     |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`                                                                                                                              | The persistent store for Codium accounts, plans, the outbox, the funding state and the ledger                                                                                                                                                                                                         |
| `CRON_SECRET`                                                                                                                                                       | Vercel sends it to the Codium cron jobs (outbox, replay, funding, sweeps)                                                                                                                                                                                                                             |
| `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`                                                                                                                      | Purchase confirmations and owner emails                                                                                                                                                                                                                                                               |
| `CODIUM_OWNER_EMAIL`                                                                                                                                                | Where owner alerts go (falls back to `VECTOR_BUG_REPORT_TO`). With neither set, sales still pause but no email is sent.                                                                                                                                                                               |
| `CODIUM_OWNER_SECRET`                                                                                                                                               | At least 32 characters (`openssl rand -hex 32`). Unlocks the ledger API only.                                                                                                                                                                                                                         |
| `VECTOR_ADMIN_EMAILS`                                                                                                                                               | The Google accounts allowed on `/owner/codium`, and the only buyers allowed in test mode                                                                                                                                                                                                              |
| `MODEL_PLANS_MIN_CLIENT`                                                                                                                                            | The first desktop and CLI release that carries the Codium client work. Blank uses the compiled-in minimum (1.99.113).                                                                                                                                                                                 |
| `MODEL_PLAN_GLOBAL_INFLIGHT`, `MODEL_PLAN_PRIORITY_RESERVE`                                                                                                         | Optional. A global cap on Codium requests at once, and the share kept for Max and Ultra (default 0.2). Without a global cap there is no reserve, and "first in line" is not listed.                                                                                                                   |
| `CODIUM_LISTED_PERKS`                                                                                                                                               | The perks the pages may list, comma-separated (see [MODEL-PLANS.md](../MODEL-PLANS.md#the-listing-rule-and-codium_listed_perks))                                                                                                                                                                      |
| `CODIUM_FOUNDING_LIMIT`, `CODIUM_FOUNDING_DAYS`, `MODEL_PLANS_SALES_OPENED_AT`                                                                                      | Optional, defaults `500` and `90`: the founding window, the earlier of that many paid founders or that many days after the first paid month. List `founding` in `CODIUM_LISTED_PERKS` at sales open and keep it there after the window closes ([MODEL-PLANS.md](../MODEL-PLANS.md#founding-members)). |
| `STRIPE_MODEL_PLAN_LEGACY_PRICES_{10,50,100,200}`                                                                                                                   | Blank until a price rises. Then list the old price ids with their old amounts in cents (`price_id:cents,…`), so subscribers on them keep their price (the founding lock). A malformed list turns Codium off.                                                                                          |
| `CODIUM_FUNDING_MARGIN_PERCENT`, `CODIUM_FUNDING_MARGIN_USD`                                                                                                        | Optional, defaults `10` and `20`: the margin the funding check adds                                                                                                                                                                                                                                   |
| `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD`                                                                                                                             | The same threshold as OpenRouter's auto top-up; blank turns its watchdog off                                                                                                                                                                                                                          |
| `CODIUM_SPEND_SPIKE_USD_PER_HOUR`                                                                                                                                   | Optional: email when model spend reaches this rate                                                                                                                                                                                                                                                    |
| `CODIUM_OPENROUTER_FEE_PERCENT`                                                                                                                                     | Optional, default `5.5`: OpenRouter's purchase fee, for the ledger                                                                                                                                                                                                                                    |
| `CODIUM_3DS_MIN_USD`, `CODIUM_TRUST_RAMP_DAYS`, `CODIUM_RENEWAL_GRACE_MINUTES`, `CODIUM_EFW_REFUND`, `CODIUM_RADAR_BLOCKLIST_ID`, `CODIUM_CODIUM_OFF_PAUSE_MINUTES` | Optional risk settings; the defaults are in `.env.example`                                                                                                                                                                                                                                            |

Remove these if an earlier setup left them: `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`, `STRIPE_MODEL_TOPUP_*`, `MODEL_TOPUP_*_CREDITS_USD`. Nothing reads them.

## 4. Test-mode run before selling

Run the test on one **preview** branch with its own settings, so test payments never reach Production. Production keeps `MODEL_PLANS_ENABLED=false` throughout. You need Stripe test keys and the test card `4242 4242 4242 4242`. OpenRouter has no test mode: the keys this creates are real, capped at `CODIUM_TEST_CREDIT_CAP_USD` and named `Vector test …`, and nothing is spent until a model request is made. The repository's dispatch-only `vector-codium-e2e` workflow runs the same flows with Stripe test clocks once you approve its `codium-test` environment.

1. **A stable preview address.** Push a branch for the test, for example `codium-test`, and use its branch address from Vercel (Deployments → the branch's deployment → Domains), or give the branch a domain. It stays the same on every push.
2. **Let Stripe through.** Previews sit behind Vercel's Deployment Protection, which would turn Stripe's notifications away. Under Settings → Deployment Protection → Protection Bypass for Automation, create a secret. The setup script adds it to the webhook's address (`VERCEL_AUTOMATION_BYPASS_SECRET` in section 1), and your own calls below add `?x-vercel-protection-bypass=<secret>`.
3. **A separate store.** Connect a second Redis database to **Preview only** (Storage → Create → Upstash for Redis). Every Codium key a test server writes already starts with `vector:codium:test:`, but the test must not share Production's store at all.
4. **Preview settings for that branch only.** Under Settings → Environment Variables, add each variable from section 3 for **Preview**, limited to the branch, with:
   - `MODEL_PLANS_ENABLED=true` and `CODIUM_STRIPE_MODE=test`;
   - `VECTOR_PUBLIC_URL=https://<preview address>`, where checkout sends buyers back;
   - the Stripe values from a test-mode run of section 1, with a restricted `rk_test_…` runtime key;
   - the second store's `KV_REST_API_URL` and `KV_REST_API_TOKEN`;
   - a `MODEL_PLAN_KEY_ENCRYPTION_SECRET` and a `CRON_SECRET` of their own;
   - your Google account in `VECTOR_ADMIN_EMAILS`: in test mode only those accounts can check out;
   - the same `OPENROUTER_MANAGEMENT_KEY`, email settings, `CODIUM_OWNER_SECRET` and pools as Production.

   Then redeploy the branch.

5. **Sign in on the preview's account page** (`https://<preview address>/account`) with that Google account. Google sign-in returns there only if the address is in Supabase's Redirect URLs (Authentication → URL Configuration).
6. **Model routes.** Codium serves a model only once its route is accepted (WP A60). Until then the steps below test payments, plan state and keys, and a chat request answers "temporarily unavailable".

Then:

1. **Subscribe to Plus.** Within seconds OpenRouter should list a new key named `Vector test <your account id> sub_…`, capped at the test cap, and the account page should show Plus, Active and 100% left.
2. **Upgrade to Pro** from the account page. It says "$50 today, then monthly from today" before opening checkout. After paying, the Plus key is switched off, a new key appears for the Pro month, Stripe shows the Plus subscription cancelled and a new billing period starting now, and the account page shows Pro.
3. **Switch at renewal.** Choose Plus under "Switch at renewal": nothing is charged, and the account page shows the scheduled change. Choose **Keep my plan**: the schedule is released.
4. **3-D Secure.** On a second test account, subscribe to Max with the card `4000 0027 6000 3184`. The bank's confirmation appears inside Stripe's checkout and the purchase completes. Then try `4000 0000 0000 3220` and decline the confirmation: no plan starts.
5. **A failed payment.** In Stripe, attach `4000 0000 0000 0341` (attaches, then fails) to the first test customer and use a test clock to reach the renewal. The account page shows Payment failed with **Update card**, and the key stops serving after the grace.
6. **A dispute.** Pay with `4000 0000 0000 0259` (disputed after payment). The account shows Paused and the key is switched off within one reconcile. Win it by submitting the evidence text `winning_evidence` in Stripe: the plan comes back with the same month.
7. **Refund and end.** On `/owner/codium` (preview address), use **Refund and end** on a test account. The plan ends, the key goes off and the ledger shows the refund.
8. **Read the ledger** (below) at the preview address, adding `?entries=1&x-vercel-protection-bypass=<secret>`. Each payment is there, with Stripe's fees filled in, refunds shown and the profit worked out.
9. **The funding check.** Vercel runs cron jobs only on Production, so call it yourself:

   ```sh
   curl -H "Authorization: Bearer <preview CRON_SECRET>" \
     "https://<preview address>/api/model-plans/funding?x-vercel-protection-bypass=<secret>"
   ```

   It answers `{"enabled":true,"status":"open","ran":true,…}` with no amounts. Then set the branch's `CODIUM_FUNDING_MARGIN_USD` above the OpenRouter balance (for example `100000`), redeploy and call it again: it answers `"status":"paused"`, checkout refuses with "temporarily unavailable", and the pause email arrives. Set the margin back, redeploy and call it again: sales reopen and the reopen email arrives.

10. **Cancel** the remaining plans in the preview's portal (account page → Manage subscription). Each key stays on until the end of its period.

Afterwards, delete the branch's Preview variables and the test webhook (Stripe test mode → Developers → Webhooks), and switch off any test key still enabled in OpenRouter. Then run section 1 in live mode, put the live values in Production (section 3), and set `MODEL_PLANS_ENABLED=true` there only when the launch checks in the build contract (WP A60) are done.

## Buying from the Vector app

From the release that carries the Codium client work, billing also happens in the app, under Settings → Account (clicking your name in the sidebar opens it).

- The plan picker lists the four plans with their prices, never their pools. While Codium is not on sale every button says "Coming soon".
- Choosing a plan opens Stripe Checkout in a Vector window; **Manage billing** opens Stripe's portal there for the card, invoices and cancellation. The window has its own private session, a title bar naming the Stripe address and a close button, and closes itself when Stripe returns to `https://vectordev.ai/account`. A bank's 3-D Secure check, Link and captchas load inside it. One billing window is open at a time.
- An upgrade or a switch at renewal goes through vectordev.ai (`/api/model-plans/change`), never the portal, and the app states the charge first.
- A payment failure shows **Update card**; a payment that needs the bank shows **Confirm payment**.
- The portal and plan changes accept only a token from the desktop's own sign-in, never one pasted into `vector login --token`. Deploy the website before releasing that app version.

## Reading the ledger

```sh
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" https://vectordev.ai/api/model-plans/ledger
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" "https://vectordev.ai/api/model-plans/ledger?entries=1"
```

All amounts are US cents. **`totals`** and **`months`** add up `payments`, `price`, `refunded`, `stripeFee`, `stripeNet`, `credits` (the model spend each payment granted), `openRouterFee` and `profit`; **`funding`** is the funding check's last reading; **`entries`**, with `?entries=1`, lists each payment.

`profit` is Stripe's net minus the model spend granted minus OpenRouter's fee. It assumes every grant gets spent, so pools that end unused are extra margin it does not show. A refunded or disputed payment still counts what its key spent before the reversal. `feesPending` counts charges whose Stripe fee had not settled yet; they update on their own.

Anyone without the secret, signed-in buyers included, gets a 404. The ledger shows what each plan includes, so never share its output or the secret. The owner page (`/owner/codium`) shows the same health figures behind your Google sign-in.

## Known limits

- **Model routes need acceptance.** No model is served until its captured OpenRouter ZDR evidence is accepted (WP A60). Until then a paid plan would buy nothing, which is one reason sales stay off.
- **Unknown outcomes are charged.** A request the provider refused or never priced after it was sent counts at its full fixed reservation, because it may still be billed. Size the pools with that in mind (the reservation table is in `build/codium-a17-context-decision.md`).
- **An upgrade whose payment fails** leaves the old plan running; nothing changes until the new checkout is paid.
- **A checkout page opened before a pause** can still be paid until it expires, up to an hour later; its plan was reserved when it opened.
- **Renewals continue while sales are paused**, because those subscribers are already owed them.
- **Plans whose key could not be created yet** (Stripe retries the notification until it succeeds) count through their checkout's reservation and the deferred-liability index until the key exists; the margin covers the gap.
- **Stripe settings the API cannot read** (Smart Retries, customer emails, Terms URL) are on the owner page's checklist as reminders; confirm them yourself.
- **A partial refund never ends a plan.** Use **Refund and end** on the owner page instead.
- **The desktop billing window** always talks to vectordev.ai, so it can only be tried against Production once you sell.
