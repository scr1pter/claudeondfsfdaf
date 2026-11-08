# Codium payments: what to set up

Once the steps below are done, Codium runs without anyone acting on a payment. Until then nothing sells: `MODEL_PLANS_ENABLED=false` and Stripe is not connected. No Stripe account, OpenRouter purchase, key or live setting was created or changed while building this.

## What happens on its own

1. **A buyer pays.** Stripe Checkout takes the card payment for a monthly plan ($10, $50, $100 or $200) or a top-up of the same amounts. Stripe pays the money out to your bank on its normal payout schedule.
2. **Credits are granted at once.** Stripe's signed notification reaches `/api/model-plans/webhook`. vectordev.ai asks Stripe whether the money was really paid, then sets the buyer's OpenRouter key limit:
   - A monthly plan gets a new key capped at the month's credits. It keeps working for `CODIUM_RENEWAL_GRACE_MINUTES` (120 by default, at most 360) past the end of the paid period, so a renewal that is still being collected never cuts off someone who pays. Each paid renewal gets a fresh key and the old one is switched off, so monthly credits reset rather than roll over.
   - A top-up adds its credits to the buyer's purchased-credit key, which never expires. The first top-up creates that key.
3. **Credits come off on their own.** Each of these switches the month's key off or lowers the purchased-credit limit:
   - a failed renewal (the subscription goes past due);
   - a cancellation, once the paid period ends;
   - a refund: any refund ends the month's credits, and a top-up refund removes that share of its credits;
   - a dispute, until Stripe reports that you won it.

   Notifications are read against Stripe's current state, so retries, duplicates and events arriving out of order never grant credits twice.

4. **OpenRouter is paid by OpenRouter's auto top-up.** OpenRouter has no API for buying credits, so Vector cannot pay OpenRouter by itself. OpenRouter's own auto top-up charges your saved card whenever Vector's balance falls below the threshold you set, and OpenRouter takes its fee on each of those purchases.
5. **Sales pause when OpenRouter can't cover them.** Every 10 minutes, a scheduled check (`/api/model-plans/funding`) compares Vector's OpenRouter balance (`GET /api/v1/credits`) with what it needs:
   - everything customers can still spend: the credit limit minus usage on every enabled, unexpired Codium key;
   - the credits in checkouts that may still be paid (below);
   - room for one more of your largest plan or top-up;
   - the safety margin on all of that: 10% plus $20 by default.

   When the balance is less, sales pause: new checkouts and top-ups answer "New Codium purchases are temporarily unavailable. Credits you already have keep working. Please try again later."

   Each purchase also has to fit when its checkout opens. Opening a checkout reserves its credits, in one step that checks them against the last reading, what is owed, every other open reservation and the margin. So purchases made between two checks cannot together sell more than the balance covers: once they use up the room, further purchases are refused, and the next check pauses sales and emails you unless the balance has grown by then. A reservation lasts until half an hour after its checkout closes, so a paid purchase counts twice for up to about 90 minutes, which errs towards pausing. A buyer's paid purchases keep their reservations when they buy again, so one buyer buying again and again is held to the balance as many buyers are. Opening a new checkout gives back the reservation of the buyer's earlier checkout only when that one can no longer be paid: the new checkout closes it, or Stripe already has. So a buyer holds at most one unpaid open checkout of each kind.

   The check fails safe:
   - **A check that cannot finish pauses sales at once.** If it cannot read the balance or the key list (OpenRouter down, a wrong management key) or a margin setting is invalid, it saves a pause straight away. The last good reading no longer counts, so nothing sells until a later check succeeds.
   - **A stale reading is not trusted.** A sale needs a reading from the last 15 minutes. When the newest is older, for example after a missed cron run, the checkout runs a check first and sells only if that check succeeds and finds enough balance.

   You get an email when sales pause, saying whether the balance is short or the check could not finish, another if that reason changes, a reminder each day the pause lasts, and one when sales reopen. Sales reopen by themselves at the first check that succeeds and finds enough balance. Credits customers already bought keep working throughout.

6. **Every payment lands in a private ledger.** For each Codium charge it records:
   - the price and any refund;
   - Stripe's fee and net, from the charge's balance transaction, plus any dispute withdrawals;
   - the model credit the payment can still cost;
   - OpenRouter's fee on buying that credit;
   - the profit left.

   Only you can read it (see [Reading the ledger](#reading-the-ledger)).

## 1. Stripe

Do all of this in **test mode** first, for the preview test run in [section 4](#4-test-mode-run-before-selling), then repeat it in live mode for Production.

1. Finish the account: business details, identity verification and the bank account for payouts.
2. Create the prices, the customer portal and the webhook. From `packages/web`:

   ```sh
   bun scripts/setup-model-plans.ts            # dry run: shows what it will create
   # Test mode, for the preview in section 4:
   STRIPE_SECRET_KEY=sk_test_... VECTOR_PUBLIC_URL=https://<preview address> \
     VERCEL_AUTOMATION_BYPASS_SECRET=<bypass secret> bun scripts/setup-model-plans.ts --apply
   # Live mode, for Production:
   STRIPE_SECRET_KEY=sk_live_... VECTOR_PUBLIC_URL=https://vectordev.ai bun scripts/setup-model-plans.ts --apply
   ```

   It prints the values for the environment variables in [section 3](#3-vercel-environment):
   - `STRIPE_MODEL_PLAN_<price>_PRICE_ID` and `STRIPE_MODEL_TOPUP_<price>_PRICE_ID` for the four prices;
   - `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID` and `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`, the two portal configurations;
   - `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`. Stripe shows the signing secret only once, so copy it straight into Vercel.

   Running the script again reuses what exists: prices by their lookup keys, the two portal configurations it created (the plan-change one is updated to the current prices), and the webhook at the same address. If that webhook's bypass secret changed, the script updates its address and keeps its signing secret; if it is missing events, the script lists them. If you deleted the webhook, the script creates a new one and prints its new secret.

3. To do it by hand instead:
   - **Prices**, all USD:
     - four monthly recurring prices on products named `Vector Codium Plus`, `Vector Codium Pro`, `Vector Codium Max` and `Vector Codium Ultra`, at $10, $50, $100 and $200 a month;
     - four one-time prices on products named `Vector Codium $10 credit top-up`, `$50`, `$100` and `$200`, at the same amounts.
   - Stripe checkout shows each product's own name, so products made before the plans were renamed keep their old names, which carry the price instead of Plus, Pro, Max or Ultra, until you rename them in the Stripe dashboard (Product catalog → the product → Edit). Prices, lookup keys and ids stay as they are.
   - **Webhook** (Developers → Webhooks):
     - URL `https://vectordev.ai/api/model-plans/webhook`;
     - API version `2025-02-24.acacia`;
     - exactly these 20 events: `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `.updated`, `.deleted`, `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `.updated`, `.closed`, `.funds_reinstated`, `radar.early_fraud_warning.created`, `.updated`, `subscription_schedule.released` and `subscription_schedule.canceled`.
   - **Customer portal**, two configurations:
     - **Without plan changes** (`STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`): email updates, payment-method updates, invoice history and cancellation at the end of the period. Plan switching off. This one opens while Codium sales are paused or `MODEL_PLANS_ENABLED` is `false`, so nobody can buy a bigger plan then.
     - **With plan changes** (`STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`): the same, plus subscription updates to a different price, listing the four monthly products, each with its one price. Set proration to **none**, the billing cycle anchor to **now** (Stripe's API calls it `billing_cycle_anchor: now`; the dashboard may not offer it, so the script is the reliable way), and **schedule downgrades at the end of the period** (`decreasing_item_amount`).
     - Why those settings: Codium grants a month's credits only for a full, paid invoice for that month. A bigger plan therefore starts a new month on it today, charged in full, and what is left of the old month's credits ends then. A smaller plan waits for the renewal date. A prorated charge would pay for part of a month, which Codium never grants, and would leave the subscriber without monthly credits until renewal.
4. Keep the card as the only payment method, with no trials or coupons: Codium grants credits only for a full, paid card charge.
5. Optional: turn on Stripe's emailed receipts for successful payments and refunds, in Stripe's customer email settings.

## 2. OpenRouter

1. **Which account.** Use an OpenRouter account other than the one behind `OPENROUTER_FREE_API_KEY`. The free-models account must stay unfunded, with no automatic top-up (see [openrouter.md](openrouter.md)), and Codium's account needs both.
2. **Management key.** Create one under Settings → Management Keys (some OpenRouter pages call these provisioning keys). It goes in `OPENROUTER_MANAGEMENT_KEY`. It creates, caps and switches off each buyer's key, and reads the balance and key list for the funding check.
   - Do not rename or delete Codium's keys in the OpenRouter dashboard. The check counts keys named `Vector <account id> …` or `Codium <account id> …`.
3. **Starting balance.** Add enough credits to cover your first customers. Before the first sale, the funding check needs the balance to cover the credits of your largest plan or top-up, multiplied by 1.1, plus $20. The test run in [section 4](#4-test-mode-run-before-selling) needs $50 more.
4. **Auto top-up** (Settings → Credits). Turn it on and set:
   - **Threshold:** at least what the funding check needs at your busiest point: the credits customers will hold, plus the credits they buy in about 90 minutes, plus the credits of your largest purchase, all multiplied by 1.1, plus $20 (see the margin variables below). If the threshold is lower, the balance can sit between the two: auto top-up does not fire, and sales stay paused until you add credits or raise the threshold.
   - **Amount:** at least a week of expected model spend, so the card is charged in a few large purchases rather than many small ones.
   - Example: at the busiest point customers hold $400 of credits and buy $60 of credits in 90 minutes. With L for the credits your largest purchase grants, set the threshold to at least ($400 + $60 + L) × 1.1 + $20, which is $526 + 1.1 × L.
5. **Fee.** OpenRouter charges a fee on every credit purchase, auto top-ups included (5.5% by card when this was written). Set `CODIUM_OPENROUTER_FEE_PERCENT` to the fee its credits page shows, so the ledger's estimate stays right.
6. **Resale terms.** OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict reselling API access. Confirm Codium is covered by suitable commercial terms before selling.
7. **Privacy settings** (before the first sale, on this account only). The labels come from OpenRouter's documentation; match them to what the pages show.
   - Settings → Observability: **Private Input & Output Logging — OFF.** If it is on, OpenRouter stores every Codium prompt and reply, and the privacy policy's zero-data-retention description stops being true.
   - [Settings → Privacy](https://openrouter.ai/settings/privacy): **OpenRouter Use of Inputs/Outputs (the 1% discount) — OFF.**
   - Same page: **paid models, allow providers that may train — OFF**, and **providers that may publish prompts — OFF.**
   - Same page: **ZDR — ON for every model group** (Anthropic, OpenAI, Google, SpaceXAI and all other models). Codium already sends `zdr: true` on every request, so this is a second guard. Never turn this on for the free-models account (see [openrouter.md](openrouter.md), step 4).
   - No BYOK provider keys, and no default or enforced plugins on this account.
   - Once these are set, confirm it, so the privacy policy can say Vector keeps logging and input/output use off.

## 3. Vercel environment

Set these for **Production** with the live values (secrets only in Vercel, never in the repository), then redeploy. The test run sets its own copies for one preview branch ([section 4](#4-test-mode-run-before-selling)).

| Variable                                                                            | What to set                                                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_PLANS_ENABLED`                                                               | `false` until the test-mode run passes and the live values are in, then `true`                                                     |
| `STRIPE_SECRET_KEY`                                                                 | Stripe live secret key (`sk_live_…`)                                                                                               |
| `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`                                                  | The webhook's signing secret (`whsec_…`)                                                                                           |
| `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`                                                | The portal configuration without plan changes (`bpc_…`)                                                                            |
| `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`                                         | The portal configuration with plan changes (`bpc_…`). Unset, nobody can change plans.                                              |
| `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`                                        | The four monthly price IDs                                                                                                         |
| `STRIPE_MODEL_TOPUP_{10,50,100,200}_PRICE_ID`                                       | The four one-time price IDs                                                                                                        |
| `MODEL_CREDIT_MARKUP_PERCENT`, or each `MODEL_PLAN_…` / `MODEL_TOPUP_…_CREDITS_USD` | Your private credit allowances. There is no default.                                                                               |
| `OPENROUTER_MANAGEMENT_KEY`                                                         | The OpenRouter management key                                                                                                      |
| `MODEL_PLAN_KEY_ENCRYPTION_SECRET`                                                  | 64 hex characters (`openssl rand -hex 32`). Keep it forever: changing it makes every stored buyer key unreadable.                  |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`                                              | The persistent store for Codium accounts, the funding state and the ledger                                                         |
| `CRON_SECRET`                                                                       | Vercel sends it to the Codium cron jobs (funding, outbox, replay, sweeps), as to the existing ones                                 |
| `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`                                      | Send the pause and reopen emails; bug reports use the same pair                                                                    |
| `CODIUM_OWNER_EMAIL`                                                                | Where pause and reopen emails go (falls back to `VECTOR_BUG_REPORT_TO`). With neither set, sales still pause but no email is sent. |
| `CODIUM_OWNER_SECRET`                                                               | At least 32 characters (`openssl rand -hex 32`). Unlocks the ledger.                                                               |
| `CODIUM_FUNDING_MARGIN_PERCENT`                                                     | Optional, default `10`: the share added to what the funding check needs                                                            |
| `CODIUM_FUNDING_MARGIN_USD`                                                         | Optional, default `20`: the fixed amount added on top                                                                              |
| `CODIUM_OPENROUTER_FEE_PERCENT`                                                     | Optional, default `5.5`: OpenRouter's purchase fee, for the ledger                                                                 |

## 4. Test-mode run before selling

Run the test on one **preview** branch with its own settings, so test payments never reach Production. Production keeps `MODEL_PLANS_ENABLED=false` throughout. You need Stripe test keys and the test card `4242 4242 4242 4242`. OpenRouter has no test mode: the keys this creates are real, but nothing is spent until a model request is made.

1. **A stable preview address.** Push a branch for the test, for example `codium-test`, and use its branch address from Vercel (Deployments → the branch's deployment → Domains, `…-git-codium-test-….vercel.app`), or give the branch a domain under Settings → Domains. It stays the same on every push.
2. **Let Stripe through.** Previews sit behind Vercel's Deployment Protection, which would turn Stripe's notifications away. Under Settings → Deployment Protection → Protection Bypass for Automation, create a secret. The setup script adds it to the webhook's address (`VERCEL_AUTOMATION_BYPASS_SECRET` in section 1), and your own calls below add `?x-vercel-protection-bypass=<secret>`.
3. **A separate store.** Connect a second Redis database to **Preview only** (Storage → Create → Upstash for Redis). The test writes Codium accounts, the funding state and the ledger, and none of that may land in Production's store.
4. **Preview settings for that branch only.** Under Settings → Environment Variables, add each variable from section 3 for **Preview**, limited to the branch, with these values:
   - `MODEL_PLANS_ENABLED=true`;
   - `VECTOR_PUBLIC_URL=https://<preview address>`, where checkout sends buyers back;
   - the Stripe values from a test-mode run of section 1;
   - the second store's `KV_REST_API_URL` and `KV_REST_API_TOKEN`;
   - a `MODEL_PLAN_KEY_ENCRYPTION_SECRET` and a `CRON_SECRET` of their own;
   - the same `OPENROUTER_MANAGEMENT_KEY`, email settings, `CODIUM_OWNER_SECRET` and allowances as Production.

   Then redeploy the branch.

5. **Sign in on the preview's account page** (`https://<preview address>/account`) with your email and password. Google and GitHub sign-in return there only if the address is in Supabase's Redirect URLs (Authentication → URL Configuration).
6. **Enough balance for the test.** Fund Codium's OpenRouter account to the minimum in [section 2](#2-openrouter), step 3, plus $50. The test's two $10 purchases count among what customers hold until they are refunded, and each stays reserved for up to 90 minutes after its checkout opens. At the bare minimum, a check during the test, such as the funding check in the fifth step below, can answer `"status":"paused"`.

Then:

1. Buy the $10 plan. Within seconds OpenRouter should list a new key named `Vector <your account id> sub_…`, capped at that plan's credits, and the account page should show 100% left.
2. Buy a $10 top-up. A `Codium <your account id> purchased credits` key appears with that top-up's credits.
3. Refund the top-up in Stripe. The purchased-credit key's limit drops to zero. Refund the plan's charge. The monthly key is switched off.
4. Read the ledger (below) at the preview address, adding `?entries=1&x-vercel-protection-bypass=<secret>`. There should be two entries, with Stripe's fees filled in, the refunds shown and the profit worked out.
5. Run the funding check. Vercel runs cron jobs only on Production, so call it yourself:

   ```sh
   curl -H "Authorization: Bearer <preview CRON_SECRET>" \
     "https://<preview address>/api/model-plans/funding?x-vercel-protection-bypass=<secret>"
   ```

   With the extra $50 from preparation step 6, it should answer `{"enabled":true,"status":"open","ran":true,"notified":false}`. Then set the branch's `CODIUM_FUNDING_MARGIN_USD` above the OpenRouter balance (for example `100000`), redeploy and call it again: it answers `"status":"paused"`, checkout refuses with "temporarily unavailable", and the pause email arrives. Set the margin back, redeploy and call it again: sales reopen and the reopen email arrives.

6. Change plans in the preview's portal (account page → Manage billing → Update plan): buy the $10 plan again with a new test checkout, then choose the $50 plan. Stripe should charge $50 today and show a new billing period starting now. Within seconds the `Vector <your account id> sub_…` key for the $10 month is switched off and a new key appears, capped at the $50 plan's credits. Then choose the $10 plan: the portal should say it starts on the renewal date, and nothing is charged now. While that change waits, open the portal again and note whether Stripe still lets you change or cancel the plan: the app refuses a further change then, and allows cancelling, so tell the developers if Stripe behaves otherwise.
7. Buy a $10 top-up on the preview's account page with the 3D Secure test card `4000 0027 6000 3184`. The bank's confirmation appears inside Stripe's checkout page and the purchase completes. The desktop app always talks to vectordev.ai, so its billing window can only be tried against Production: once you sell, buy the smallest top-up from Settings → Account → Buy credits in Vector and check that the window closes by itself and the account shows the credits.
8. Cancel the plan in the preview's portal. Its key stays switched off, as the refund left it, and expires at the end of the period.

Afterwards, delete the branch's Preview variables and the test webhook (Stripe test mode → Developers → Webhooks). The test's OpenRouter keys end switched off by the refunds, so Production's funding check does not count them. Then run section 1 in live mode, put the live values in Production (section 3), and set `MODEL_PLANS_ENABLED=true` there when you decide to sell.

## Buying from the Vector app

Vector 1.99.109 and later handle billing inside the app, under Settings → Account. Clicking your name in the sidebar opens it.

- **Buy credits** lists the four plans and four top-ups with their prices, and never their credits. While `MODEL_PLANS_ENABLED` is `false`, every button says "Coming soon" and nothing can be bought.
- **Subscribe** and **Buy** open Stripe Checkout in a Vector window. **Change plan**, **Cancel plan** and **Manage billing and invoices** open Stripe's customer portal there. The window sits above Vector's own, with a title bar that names the Stripe address and a close button, and has its own private session. It closes itself when Stripe returns to `https://vectordev.ai/account`; the portal's home stays open until the person closes it or uses Stripe's link back. Only the page is kept to Stripe: a bank's card check (3D Secure), Link and captchas load inside it. Other links open in the browser. One billing window is open at a time; a second request brings it forward.
- **Change plan** is not offered for a plan set to end. vectordev.ai also refuses a change while a smaller plan waits for the renewal date, and says so.
- The app sends its Vector sign-in token to `/api/model-plans/checkout`, `/topup` and `/portal`, which accept it as they accept a website session. The portal, which can charge the saved card and change the billing email, accepts only a token from a sign-in made in Vector 1.99.109 or later, never one pasted into `vector login --token`. So someone who signed in on an older version gets the account page in the browser for the portal until they sign in again; checkout and top-ups work in the app for them. Deploy the website before releasing that app version. Against an older deployment the app opens vectordev.ai in the browser instead.
- **Delete account** asks for the account's email, then a fresh sign-in in the browser (vectordev.ai checks it is from the last 10 minutes), and deletes the account from the app. Deploy the website first for this too.

## Reading the ledger

```sh
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" https://vectordev.ai/api/model-plans/ledger
curl -H "Authorization: Bearer $CODIUM_OWNER_SECRET" "https://vectordev.ai/api/model-plans/ledger?entries=1"
```

All amounts are US cents. The answer has three parts:

- **`totals`** and **`months`** add up `price`, `refunded`, `stripeFee`, `stripeNet`, `credits`, `reversedSpend`, `openRouterFee` and `profit`.
- **`funding`** is the funding check's last reading: whether sales are open, why they are paused (`short` or `unavailable`), the balance, what customers hold, what open checkouts reserve and what is needed. After a check that could not finish, the amounts are `null` and `error` names what failed.
- **`entries`**, with `?entries=1`, lists each payment.

`profit` is Stripe's net minus the credits minus OpenRouter's fee. It assumes every credit granted gets spent, so monthly credits that expire unused are extra margin it does not show. A refunded or disputed payment still counts what was spent before the reversal:

- a month counts its key's usage at the time;
- top-ups share one purchased-credit key, so for them it is the key's usage above the credits still paid for. That spend is counted against the account's reversed top-ups, oldest first, each up to the credits its reversal took away, and shows as `reversedSpend`. A later top-up pays for that spend first, since the buyer gets only what is left of it, so `reversedSpend` falls by what the new top-up covers.

`feesPending` counts charges whose Stripe fee had not settled yet; they update on their own.

Anyone without the secret, signed-in buyers included, gets a 404. The ledger shows what each purchase includes, so never share its output or the secret.

## Known limits

- A plan change made in the portal keeps the credits checkout recorded for the old plan in the subscription's metadata; Codium ignores them once the subscription is on another plan and grants the new plan's configured credits. A later change to `MODEL_PLAN_…_CREDITS_USD` therefore also changes what an upgraded subscription's next month grants.
- An upgrade whose payment fails or waits for the bank leaves the subscription without monthly credits until the payment completes, because the latest invoice is then unpaid. Test it with `4000 0000 0000 0341` (the card is attached but the charge fails) before selling.
- An upgrade in the portal does not reserve its credits the way a checkout does. The funding check keeps room for one more of the largest purchase, so one upgrade is always covered, and the new month's key is counted from the next check.

- Stripe drafts each renewal invoice (`invoice.created`) and would charge it about an hour later. vectordev.ai finalizes and charges it within about a minute instead, through the outbox cron, but only while the account is not on hold, the subscription is the account's own current one (not upgraded away from, not a duplicate), Vector Codium is switched on and the OpenRouter balance covers what is owed plus the renewal. When the balance is short it leaves the charge to Stripe's own schedule; in the other cases it pauses collection on that subscription so nobody is charged. Either way you get an email naming the account, subscription and invoice ids. Until the renewal is paid, the previous month's key keeps serving, up to the renewal grace.
- A Stripe notification that never arrives, or that vectordev.ai could not finish, is handled by replay within 10 minutes: it lists the 20 subscribed events since its last run and handles each one not yet marked done. An event that keeps failing is retried every 10 minutes for three days, and you get an email once it is an hour old. An hourly sweep also compares Stripe's disputes from the last 120 days with each account's hold, reconciles renewing and past-due accounts, and emails you about any customer with more than one live subscription (ids only; cancel and refund the extra one in Stripe). A daily sweep at 04:23 UTC checks every paying account's OpenRouter key limit, sets back any that was changed outside vectordev.ai and emails you, and rechecks stale accounts.
- A checkout page opened before a pause can still be paid for until it expires, up to an hour later. The pause stops new checkouts; the open one's credits were already reserved when it opened.
- Renewals still charge and grant credits while sales are paused, because those subscribers are already owed them.
- Credits that were paid for but whose key could not yet be created (Stripe retries the notification until it succeeds) count only through their checkout's reservation. Once that lapses, half an hour after the checkout closes, they are not counted until the key exists. The margin covers this.
