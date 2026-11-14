# Codium owner guards

What protects the money once Codium sells, how you see each guard, and what to do when one fires. Setting Codium up is [codium-payments.md](codium-payments.md); how it works is [MODEL-PLANS.md](../MODEL-PLANS.md). Nothing here was switched on, configured or tried against a live service while building it.

Three rules hold everywhere:

- **Never set `MODEL_PLANS_ENABLED` back to `false` while anyone is subscribed.** It stops Codium for people who paid. Use the `sales` and `codium` switches.
- **Paused sales never touch existing subscribers.** Renewals, upgrades already paid and service continue.
- **No guard buys anything.** Vector cannot buy OpenRouter credit, raise a budget or pause a Vercel deployment; it pauses its own sales or services and emails you.

## The owner page

`/owner/codium` is unlinked and not indexed. Sign in with a Google account listed in `VECTOR_ADMIN_EMAILS`. Changing anything (a switch, a replay, a refund) needs a Google sign-in from the last 10 minutes; when the page asks, sign in again. The page refreshes every minute and shows accounts by id, never by email.

It shows:

- **Sales:** open or paused, and why (balance short, or the check could not read OpenRouter).
- **Funding:** the OpenRouter balance, what customers can still spend, what open checkouts reserve, what is needed, days of runway at the observed spend, the auto top-up watchdog and seven days of history.
- **Subscribers:** counts per plan and monthly recurring revenue.
- **Risk:** disputes and early-fraud warnings in the last 30 days, and their ratio to paid invoices. Over 0.5% it also emails you.
- **Health:** the webhook and replay, the outbox depth and dead letters, the last sweeps and any key-limit drift they repaired, and the store.
- **Switches,** with their current values and the audit log.
- **A Stripe checklist** of dashboard settings the API cannot confirm: Smart Retries with cancel after the last retry, customer emails for failed payments and 3-D Secure, the Terms of Service URL, and a portal without plan changes.

The private ledger, with each payment's fees and profit, is a separate API behind `CODIUM_OWNER_SECRET` ([codium-payments.md](codium-payments.md#reading-the-ledger)).

## Runtime switches

Switches take effect within 30 seconds, need no redeploy, and every change is audited. A service's environment variables say it is configured; its switch turns it off.

| Switch                           | Off means                                                                                                                                                                                                                                                 | Use it when                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `sales`                          | New checkouts and upgrades are refused ("temporarily unavailable"). Renewals, paid upgrades and service continue.                                                                                                                                         | You want to stop selling for a while: a launch problem, a pricing review, a provider issue. |
| `codium`                         | The gateway refuses Codium for everyone and nothing is listed. After `CODIUM_CODIUM_OFF_PAUSE_MINUTES` (60) off, active subscriptions get `pause_collection=void`, so nobody is billed for a stopped service; collection resumes when the switch returns. | Codium itself must stop: a routing or provider incident.                                    |
| `cloudAgents`                    | The GitHub-agent perks leave the pages; once the GitHub integration ships (WP A59), runs on Codium are refused too.                                                                                                                                       | A problem with GitHub runs.                                                                 |
| `hosted`                         | `no-new` refuses new cloud-computer sessions and jobs; `stop` also stops running ones.                                                                                                                                                                    | A hosted-compute problem or a spend alert.                                                  |
| `ops`, `remote`, `vault`, `push` | That service stops and its perks leave the pages.                                                                                                                                                                                                         | A problem in that service.                                                                  |
| `perk-off:<id>`                  | One perk leaves `/codium`, the account page, Settings and the docs.                                                                                                                                                                                       | A perk's copy or service needs to come down alone.                                          |
| `model-off:<id>`                 | One model leaves `/models` and the gateway answers 503 `MODEL_PLAN_MODEL_UNAVAILABLE` for it.                                                                                                                                                             | A model's provider misbehaves.                                                              |

The hosted, ops, remote, vault and push services are later work packages; their switches exist before them so the pages and the gateway already honour them.

## Funding

OpenRouter has no API for buying credit, so Codium's balance is refilled by OpenRouter's own auto top-up on your card. The funding check (`/api/model-plans/funding`, every 10 minutes) makes sure Vector never sells more than that balance covers.

- **What it compares.** The balance against what every enabled, unexpired Codium key can still spend, plus the plans in checkouts that may still be paid, plus paid plans whose key is not created yet, plus room for one more of the largest plan, plus the margin (`CODIUM_FUNDING_MARGIN_PERCENT`, 10, and `CODIUM_FUNDING_MARGIN_USD`, 20).
- **Short:** sales pause at once and you get an email; another if the reason changes, a reminder each day, and one when sales reopen. They reopen by themselves at the first check that finds enough.
- **Cannot read OpenRouter** (an outage, a wrong management key, an invalid setting): sales pause at once. The last good reading no longer counts.
- **Stale reading:** a sale or an early renewal charge needs a reading from the last 15 minutes and not from the future; otherwise it runs a check first and goes ahead only if that check succeeds.
- **Each checkout reserves its plan** when it opens, in one step checked against the reading, what is owed and every other reservation, so purchases between checks cannot together oversell the balance.
- **Low water:** an email when the balance is at or below 1.25 times what is needed. Sales stay open; add funds or raise the auto top-up amount.
- **Auto top-up watchdog:** with `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD` set to OpenRouter's threshold, an email when the balance has been below it for 20 minutes with no credit added. Check the card on file and the backup card.
- **Spend spike:** with `CODIUM_SPEND_SPIKE_USD_PER_HOUR` set, an email when the observed hourly spend reaches it. Look for one account or one model doing most of it, and use `model-off:<id>` or the owner actions below.

The funding cron's own answer carries no amounts; the figures are on the owner page and in the emails.

## Vercel spend

Vercel's Spend Management calls `POST /api/owner/spend-vercel` (signed per team with `VERCEL_SPEND_WEBHOOK_SECRET_MAIN` and `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`).

- **Main team** (`VERCEL_MAIN_TEAM_ID`): an email at each threshold, nothing else. Keep Vercel's "Pause production deployments" off: it would take vectordev.ai offline.
- **Hosted team** (`VERCEL_HOSTED_TEAM_ID`): an email at 50%, `hosted=no-new` at 75% and `hosted=stop` at 100%. A callback only ever escalates; only you set `hosted` back to `on`, on the owner page, once the budget is raised or the cause is fixed.

## Owner actions

Each is a button on the owner page, needs a sign-in from the last 10 minutes, and is audited.

- **Reconcile an account:** re-reads Stripe for that account and rewrites its plan. Use it when an account looks wrong.
- **Replay since a time:** handles every subscribed Stripe event since then (up to 30 days back) that was not marked done. The scheduled replay already does this every 10 minutes for recent events.
- **Clear risk:** lifts a hold after you have checked the account. It refuses while a dispute is open or unknown, or while an end or deletion is in progress, and it never creates a payment or un-cancels a subscription.
- **Refund and end:** refunds the governing charge (or what is left of it after an earlier partial refund), cancels every Codium subscription and open checkout of the account, and ends the plan. The page shows the amount, charge and scope first, and refuses if the payment changed since you looked. Use this, never a partial refund in Stripe: a partial refund does not end a plan.

## Emails you may get

| Subject (after "Vector Codium")                                                      | What it means                                                                                                                                                           | What to do                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| "sales paused", "sales reopened"                                                     | The funding check paused or reopened sales.                                                                                                                             | Add funds or fix the management key; nothing if it reopened.                      |
| "funding is low", "OpenRouter auto top-up has not arrived", "OpenRouter spend spike" | See [Funding](#funding).                                                                                                                                                | As described there.                                                               |
| "a renewal was not charged early"                                                    | A renewal invoice was left to Stripe or its collection paused (frozen, superseded, `codium` off, or balance short). It names the account, subscription and invoice ids. | Check the account; a balance shortfall resolves when funds arrive.                |
| "a Stripe event keeps failing" / "replay could not read every Stripe event"          | An event has failed for an hour, or replay hit its page limit.                                                                                                          | Check the owner page's webhook health; replay retries for three days.             |
| "an account has more than one live subscription"                                     | The hourly sweep found duplicates (ids only).                                                                                                                           | Cancel and refund the extra one in Stripe.                                        |
| "an OpenRouter key was changed outside Vector"                                       | The daily sweep set a key limit back.                                                                                                                                   | Check who can manage keys on the Codium OpenRouter account.                       |
| A dead letter                                                                        | An outbox job failed ten times.                                                                                                                                         | The owner page names the job; fix the cause, then reconcile the account.          |
| Disputes over 0.5%                                                                   | The 30-day dispute and fraud-warning ratio is high.                                                                                                                     | Review the accounts; consider the Radar block list (`CODIUM_RADAR_BLOCKLIST_ID`). |
| Vercel spend                                                                         | A spend threshold was reached.                                                                                                                                          | See [Vercel spend](#vercel-spend).                                                |

Emails go to `CODIUM_OWNER_EMAIL` (or `VECTOR_BUG_REPORT_TO`) through Resend. They may contain private figures, so do not forward them.
