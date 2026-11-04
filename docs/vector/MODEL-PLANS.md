# Vector Codium

Codium is Vector's managed coding-model plan: four monthly subscriptions, Plus, Pro, Max and Ultra, at $10, $50, $100 and $200 a month (plan ids `vector-10`, `vector-50`, `vector-100`, `vector-200`, which never change). There are no top-ups, no annual prices and no overage charges. A plan gives models from several labs with zero data retention and no provider keys, a private monthly pool of model spend that is never published, and the perks listed for its tier. The workspace stays free.

**Nothing is on sale.** `MODEL_PLANS_ENABLED=false`, Stripe is not connected and `ROUTE_ACCEPTANCES` is empty, so the gateway serves no model route and nothing can be bought. Source changes do not activate sales. The owner's steps, in order, are in [owner-actions/codium-payments.md](owner-actions/codium-payments.md); the guards the owner operates afterwards are in [owner-actions/codium-owner-guards.md](owner-actions/codium-owner-guards.md).

The build contract is [build/codium-build-spec.md](build/codium-build-spec.md). Each work package records what it built in `build/codium-<id>-…-notes.md`, and departures from the contract are in [build/codium-deviations.md](build/codium-deviations.md). This page is the summary.

## What people see

- **Usage is a whole percentage of the month**, the same figure everywhere: Settings → Usage and Settings → Account in the app, `vector codium` (alias `vector credits`) in the terminal, and the account page on vectordev.ai. `used + left = 100`, and meters report the share left as `aria-valuenow`.
- **Codium work shows the label "Codium"** in place of tokens or a price: in sessions, Settings → Usage, the TUI, `vector run --format json`, exports, Vectorscope reviews and GitHub evidence. Session costs and dollar spend limits leave Codium steps out; step and loop limits still apply.
- **No amount leaves the server.** Status, `/models`, the estimate API, errors and every page carry shares, counts and the public caps from `ENTITLEMENTS` only (invariant P1).
- **When the month is used up**, Codium pauses until renewal. Own keys, Vector Local and free models keep working. The person can upgrade and keep what's left of the month.
- The desktop and CLI show the provider as **Vector Codium**; its stable internal id remains `vector-plan`.

Public pages: `/codium` (pricing; `/pricing` redirects there), `/account` (the plan card), and `/docs/codium` (the docs page; `/docs/plans` and `/docs/pricing` redirect there).

## Plans and caps

`packages/schema/src/codium-entitlements.ts` (`CodiumEntitlements`) holds what each plan includes as counts, hours, shares and flags, never dollars. The API, the app, the CLI and the website import it, and every number on a page comes from it.

|                                              | Plus | Pro  | Max  | Ultra |
| -------------------------------------------- | ---- | ---- | ---- | ----- |
| Usage, multiple of Plus                      | 1x   | 5.5x | 12x  | 25x   |
| Codium requests at once                      | 3    | 6    | 12   | 24    |
| Requests a minute                            | 30   | 60   | 120  | 200   |
| Daily limit (share of the month per UTC day) | 25%  | 25%  | 40%  | none  |
| Longest context                              | 256K | 256K | 512K | 768K  |
| First in line when busy, one retry           | no   | no   | yes  | yes   |

The private pool of each plan is `MODEL_PLAN_<price>_CREDITS_USD` (or `MODEL_CREDIT_MARKUP_PERCENT`). Codium stays off unless Pro, Max and Ultra pools are 5.5x, 12x and 25x Plus's within 0.05, because the pages publish those multiples. The perks of each tier (§1.1 of the contract) are in the same module and are shown only when listed (below). `api/_lib/codium-limits.ts` holds the server-only limits: the trust ramp, the pool ramp and the renewal grace.

## The listing rule and `CODIUM_LISTED_PERKS`

A perk appears on `/codium`, the account page, Settings and `/docs/codium` only while `listedPerks()` (`api/_lib/codium-perks.ts`) lists it:

`CODIUM_LISTED_PERKS` (comma list) ∩ the `codium` switch and the perk's service switch on ∩ not in `perks-off` ∩ every perk it requires listed (transitively) ∩ its service ready ∩ for Track B perks `CODIUM_TRACK_B_LIVE=true` ∩ for App perks a configured GitHub App.

- If the store cannot be read, nothing is listed. With `MODEL_PLANS_ENABLED=false`, nothing is listed.
- The readiness table holds real configured checks only. Today it has `priority`, which needs `MODEL_PLAN_GLOBAL_INFLIGHT` and a valid reserve (`MODEL_PLAN_PRIORITY_RESERVE`, default 0.2), and `second-opinion` and `review-panel`, which need their judges and review pair served (below). Each later service work package adds its own check after its gate; an environment listing cannot claim an unfinished service.
- `founding` is resolved at runtime only: its readiness check is the founding window (below), so it leaves every page the moment the window closes.
- `GET /api/model-plans/config` answers `publicCodiumTiers()` with `listed`, accepted models and public caps, cached `s-maxage=60, stale-while-revalidate=30`. Prerendered pages never capture the listing: their scripts read the configuration after loading and remove whatever is no longer listed. The account status carries the same `listed` set.
- Copy lives in `packages/schema/src/codium-copy.ts` (`CodiumCopy`): perk text, the computed taglines (a tagline never names an unlisted perk), `COMING`, the free-workspace list and `tierView()`.
- Vector Velocity is always tagged Coming, with the owner-approved planned-size wording, no date and no part in today's purchase. Vector Labs is not shown; whether it returns as a Coming row is an open owner decision.

## The plan cache

Only reconcile writes an account's plan. Every other service reads its `EntitlementSnapshot` (`api/_lib/codium-entitlements.ts`), which carries the state, the plan, the period, `meterEpoch`, the ramp and the effective caps.

- **Read rules.** A missing snapshot runs one on-demand reconcile, and a `none` answer is cached for 60 seconds. A stale snapshot (over 6 hours old, or past its period end) is served while one reconcile runs, at most one a minute per account. The gateway refuses a snapshot whose `livemode` differs from the server's Stripe mode.
- **No Stripe call on a hot path** (M4). Chat, `/models`, status and entitlement checks read only the store.
- **Store keys** all sit under `vector:codium:<live|test>:` through `codiumKey()` (`api/_lib/codium-keys.ts`), so test and live records never mix. OpenRouter keys created in test mode are named `Vector test …` and capped at `CODIUM_TEST_CREDIT_CAP_USD`.

### States

| Stripe                                              | State / reason               | Codium models                                                                    |
| --------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| no subscription, `incomplete`, `incomplete_expired` | none                         | 402 `MODEL_PLAN_REQUIRED`                                                        |
| current period paid and unreversed                  | active                       | served within the caps                                                           |
| period ended, renewal invoice not yet paid          | renewing                     | the previous key serves until period end + grace, then 503 `MODEL_PLAN_RENEWING` |
| renewing past period end + grace                    | paused / payment_pending     | 402 `MODEL_PLAN_PAYMENT_REQUIRED`                                                |
| `invoice.payment_action_required`                   | paused / action_required     | 402, action `confirm-payment`                                                    |
| `past_due`                                          | paused / payment_failed      | 402, action `update-card`                                                        |
| `unpaid` or `canceled`                              | ended                        | 402 `MODEL_PLAN_REQUIRED`                                                        |
| full refund of the current period's charge          | ended / refunded             | 402                                                                              |
| partial refund                                      | no change                    | unchanged                                                                        |
| open dispute on any Codium charge                   | frozen / disputed            | key disabled at once                                                             |
| early-fraud warning                                 | frozen / early_fraud_warning | key disabled at once                                                             |
| `risk.blocked` or owner freeze                      | frozen / owner               | key disabled at once                                                             |
| account deletion                                    | ended / closing              | key disabled                                                                     |

A won dispute returns to the Stripe-derived state with the same `meterEpoch`; a lost one ends the plan, sets `risk.blocked` and cancels the subscription. Every new period, including the one an upgrade starts, gets a new `meterEpoch`, so per-period meters start fresh.

## Payments

- **Checkout** (`POST /api/model-plans/checkout`) needs a website session or the desktop's sign-in. An account that already has a subscription gets 409 `MODEL_PLAN_EXISTS`. Checkout shows the consent text and asks the bank for 3-D Secure on a first payment of `CODIUM_3DS_MIN_USD` (100) or more. In test mode only `VECTOR_ADMIN_EMAILS` may check out.
- **Webhook** (`/api/model-plans/webhook`): signature over the raw body, exactly the 20 events in `MODEL_PLAN_WEBHOOK_EVENTS`, objects re-fetched at the pinned API version `2025-02-24.acacia`, reconcile within 8 seconds or a durable queue item. Replay every 10 minutes covers any lost event; an hourly risk sweep and a daily sweep at 04:23 UTC recheck disputes, renewals, duplicate subscriptions and key limits.
- **Renewals.** On `invoice.created` the outbox finalizes and charges the renewal within about a minute, only for the governing, unfrozen, not-superseded subscription while `codium` is on and the OpenRouter balance covers what is owed (M7); otherwise it pauses collection or leaves the charge to Stripe's schedule, and emails the owner. On `invoice.paid`: a new key at the full pool, a new `meterEpoch`, the old key off. During `renewing`, the old key serves until `periodEnd + CODIUM_RENEWAL_GRACE_MINUTES` (120, at most 360), so nobody who pays is locked out (M11).
- **Upgrades** (`POST /api/model-plans/change` to a higher plan) are allowed only while the account is active with no open invoice, not past due or frozen, with no scheduled downgrade, while `sales` is on and funding can reserve the sale. The upgrade is a new Checkout Session that starts a new month today, charged in full. When it is paid, the old key goes off, and the carry is `max(0, oldLimit − usage − held)`, once, only from a paid, unreversed period of the same customer. The old subscription is cancelled exactly once, its open invoices voided and drafts deleted. A true-up 12 minutes later can raise the new key to `oldLimit − finalUsage` and never lowers it. Carried usage ends at the next renewal (M6).
- **Downgrades** are a subscription schedule: the current price to the period end, then the lower price. `DELETE /api/model-plans/change` releases it ("Keep my plan"). A schedule is released before the portal's cancel flow opens.
- **Portal** (`POST /api/model-plans/portal`): one no-change configuration for payment methods, invoices and cancellation at period end. The old `flow:"change"` answers 409 `MODEL_PLAN_CHANGE_UNAVAILABLE`, pointing to the account page.
- **Failed payments** pause Codium and plan perks (`update-card` opens the portal's payment-method flow; `confirm-payment` opens the invoice confirmation). They do not extend the month. A plan ends when Stripe's retries give up.
- **Refunds and disputes.** A full refund of the current charge ends the plan. A partial refund changes nothing, so never refund partially to end a plan: use the owner page's "Refund and end". A dispute on any Codium charge freezes the account and voids collection until it closes (M5).
- **Early-fraud warnings** freeze the account. An actionable warning with `CODIUM_EFW_REFUND=true` (the default) refunds the warned charge and the current period's charge if different, and cancels at once. `CODIUM_RADAR_BLOCKLIST_ID` adds the card to a Radar block list.
- **Ramps.** For 7 days after the first paid Max or Ultra invoice (`CODIUM_TRUST_RAMP_DAYS`), hosted limits are reduced. When that first payment was not authenticated with 3-D Secure, the key holds 30% of the pool for 72 hours, released by an outbox job, and Ultra keeps a 40% daily share for that first period. The pages say "New Max and Ultra accounts start with lower limits while trust builds."
- **Emails and the ledger.** A purchase confirmation email restates consent, renewal and cancellation. Each Codium charge writes a private ledger entry, read only with `CODIUM_OWNER_SECRET` at `/api/model-plans/ledger`.

### Founding members

`api/_lib/codium-founding.ts` (WP A31). The window is the earlier of `CODIUM_FOUNDING_LIMIT` (500) paid founders or `CODIUM_FOUNDING_DAYS` (90) after `sales-opened-at`, the first paid month (`MODEL_PLANS_SALES_OPENED_AT` overrides it). Before the first paid month the window has not started, so it is open. An invalid founding setting closes the window and nothing else: it is named on the owner page ("Founding window settings"), never among the problems that turn Codium off.

- **Checkout.** While `founding` is listed, a first checkout reserves a slot (`founding:reserved`, until two days after the checkout closes) and only then marks the session and its subscription with a founding token (`vector_founding`). An expired or replaced checkout gives its slot back (`checkout.session.expired`, read again from Stripe). An account that has, or had, a founding record gets no slot.
- **The number.** The first paid reconcile turns the token into a number with one script (`founding:count`, `founding:member:<account>`), so a replayed or parallel `invoice.paid` assigns one number and counts it once (M13). The snapshot carries `founding: {number, boost}`; status sends `founding: {number}` only, never the boost.
- **What it keeps.** +10% usage on Plus and Pro only (`subscriptionPlanCredits` applies `ENTITLEMENTS[plan].foundingBoost` to a subscription carrying the token). The server copies the token onto upgrade checkouts, so an upgrade keeps the mark and the lock, and the boost only where the new plan has one; a downgrade by schedule keeps the subscription and its token. The lock is "your price won't go up while you stay subscribed": when a price rises, list the old price id and amount in `STRIPE_MODEL_PLAN_LEGACY_PRICES_<price>` (`price_id:cents,…`) and subscriptions on it stay paid at exactly that amount. A plan change pays the new plan's current price.
- **The end.** Founding ends when the subscription carrying it is deleted (`customer.subscription.deleted`) and no other live subscription carries the token. A resumed scheduled cancellation, a failed payment, an unpaid plan and an upgrade's supersede keep it. An ended record is kept, so the account never gets a second number; account deletion erases it (P5).
- **Founders page.** Founders may list themselves, with an optional display name (1–40 letters, digits, spaces, `.`, `'`, `_`, `-`), from the account page (`GET|POST /api/account/founding`). `/founders` shows them by number; `GET /api/founders` answers only with the page's random slug (in the address's fragment, sent as `x-vector-founders`) until 30 founders are listed, then to anyone. `?badge=<number>` serves that founder's SVG badge. Reconcile hides a frozen plan's entry and shows it again after recovery, and account deletion erases the record, whether or not `founding` is still listed; the `founding` provisioner does the same sooner while it is in `CODIUM_LISTED_PERKS`.

### Roadmap vote

`api/_lib/roadmap.ts` and `GET|POST /api/roadmap` (WP A34), shown in the desktop's Settings → Roadmap vote when the status lists the vote for the plan (`entitlements.vote`).

- **Who.** Max and Ultra vote while the plan is active or renewing; Ultra also nominates. The route decides from the snapshot (`requireEntitlement(account, "vote" | "nominate")`), never from the client, and takes only a Vector account token (`vct_`), never a run token.
- **Ballots.** Each UTC quarter's ballot (`roadmap:<yyyy-qn>:ballot`) opens and closes inside that quarter. One ballot per account (`roadmap:<yyyy-qn>:ballots`, a hash keyed by a SHA-256 of the account id), changeable until the close. One nomination per Ultra account a quarter (`roadmap:<yyyy-qn>:nominations`, written with HSETNX), for the owner to consider for the next ballot. `roadmap:quarters` lists every quarter holding any of these.
- **Results.** After the close, as totals, once at least 20 ballots are counted. A ballot counts when it was cast before the close, for a candidate on the ballot, with a plan that included the vote when it was cast (the plan is kept with it). The winner reads "Planned for the next release cycle." with no date; a tie shows no winner until the owner records one of the tied candidates.
- **Owner.** `bun script/roadmap-ballot.ts open <quarter> --candidates <file.json> --closes <date> --mode live|test` publishes a ballot of 2 to 10 candidates whose copy names no date, month, quarter or "soon". `close`, `results`, `decide <quarter> <id>` (ties only) and `nominations` do the rest; none prints who voted or nominated.
- **Deletion.** `eraseAccountBallots(account)` removes the account's ballots and nominations from every quarter; account deletion calls it from A57. Ballots and nominations are otherwise kept until the account is deleted.

### Second opinion and second-lab reviews

WP A35. Both run in Vector itself, on models the gateway checks against the plan like any other request; nothing on the server grants them.

- **Second opinion.** With LLM-as-a-judge on and Settings → General → Second opinion on (`general.secondOpinion`, off by default, shown only when the status lists `second-opinion` for the plan), each prompt carries `secondOpinion: true`. When the judge checks work a Codium model did, it runs on the plan's judge for that model (`CODIUM_JUDGES`, listed per entry as `codium.judge`) when no judge model is configured and the judge comes from another lab (`packages/engine/src/session/second-opinion.ts`). Plus lists no judges.
- **Review pairs.** A Vectorscope review on Codium without a `triageModel` runs the plan's review pair (`CODIUM_REVIEW_PAIRS`, listed per entry as `codium.review`): the first pass on DeepSeek and each finding checked on another lab's model. A pair from one lab warns and runs one pass. `panel: true` in `.vector/review.json` adds a judge from a third lab (`judgeModel`, or the plan's panel judge) that makes the final call (`packages/core/src/review/second-lab.ts`). The summary footer says "Checked by a second lab" or "Checked by three labs", with own keys too, and nothing when a lab cannot be named.
- **Listing.** `second-opinion` is ready once every plan that includes it can reach at least one judge among the served models; `review-panel` once every plan's triage, confirm and panel judge are served and come from three labs. Neither is ready before A60 accepts the staged routes.

The removed route `/api/model-plans/topup` answers every request with JSON 410 `MODEL_TOPUP_REMOVED`, so an older Vector shows a message instead of a bare 404. Status still sends `purchased: {bought: false}` because the 1.99.111 and 1.99.112 decoders require it (H7).

## Using Codium in Vector

- **Tokens.** Chat accepts the desktop's sign-in token, a `cli` token minted by the new CLI's code exchange, and run tokens (`vrt_` for GitHub runs, `vht_` for hosted runs). A token pasted from `vectordev.ai/auth/cli` gets 401 `CODIUM_SIGN_IN_REQUIRED` at chat and still works for free models and status (`MODEL_PLAN_REQUIRE_MARKED_TOKENS`, default true). Run tokens are refused everywhere except chat, `/models` and their own service.
- **Old clients.** Below `MODEL_PLANS_MIN_CLIENT` (unset: the compiled-in 1.99.113), `/models` answers `enabled:false` and chat answers 426 `CODIUM_UPDATE_REQUIRED`.
- **The catalog Vector sees** (`GET /api/model-plans/models`) reads only the snapshot and the runtime model switches. New clients get every served model with its lab, weight, role and, for a model above the plan, `locked: {plan, name}`, plus the synthetic **Codium Auto** entry after the default model. Old clients get only the unlocked models in the four-field shape. Choosing a locked model offers Change plan.
- **Choosing Codium.** Vector never moves a person to Codium by itself: not for a new session, a Vectorscope review, a swarm, an editor connected to Vector, or a run where Codium is the only provider. Inside Codium, once the person chose it, Vector may pick another model of their tier: titles and helpers use the plan's smaller models, Codium Auto picks a model for each message by its size, and a swarm may route tasks to the plan's other models. Long-context entries and fast lanes are manual only and are never picked automatically.
- **Admission** (`api/_lib/model-plan-admit.ts`) is one Lua script and one store round trip: the account's requests at once, the global set whose last share (`MODEL_PLAN_PRIORITY_RESERVE`) is kept for Max and Ultra, the month's available pool, the daily share, the Brain helpers' share and a run's ceiling, then one hold per request with one deadline. The per-minute limit is checked before. Each request holds a fixed reservation per model until it settles; an answer the provider never priced, or a refusal after the request was dispatched, is charged at that full reservation, because it may still be billed.
- **What the gateway forwards.** Text and tools through the gateway, with token usage but without the provider's charge, its name or fingerprint. Clients stamp each Codium step as Codium and store no tokens or cost for it.

## Status and estimates

`GET /api/model-plans/status` (account or desktop token, cached 30 seconds, cleared by reconcile) answers shares rounded to 0.01, public counts and timestamps only: the plan, `left`, the state and reason, the action, a scheduled downgrade, today's share when the tier has a daily limit, `listed`, public entitlements, meters, `empty` (below the cheapest unlocked request) and `low` (under 10% left). A paused plan answers `{active: true, access: false, …}`. Clients decode new fields one at a time, so an unknown value never fails the whole status.

`POST /api/model-plans/estimate` answers bands ("under 1%" to "more than your month"), with inputs clamped and rounded to steps 1.5x apart, so it cannot reveal the pool (P2).

## Error codes

Bodies are `{error: {code, message, …}}`. The client mapping is in `packages/core/src/model-plan-status.ts`.

| Status | Code                                                                                           | What the client does                                       |
| ------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 400    | `MODEL_PLAN_MODEL`, `MODEL_PLAN_CONTEXT`, `MODEL_PLAN_ATTACHMENT`                              | `CONTEXT` compacts the conversation                        |
| 401    | `CODIUM_SIGN_IN_REQUIRED`                                                                      | a fresh desktop sign-in or `vector login`                  |
| 401    | `MODEL_PLAN_RUN_EXPIRED`                                                                       | the run commits and opens a draft PR                       |
| 402    | `MODEL_PLAN_REQUIRED`, `MODEL_PLAN_PAYMENT_REQUIRED {reason, action?}`, `MODEL_PLAN_EXHAUSTED` | "See plans", "Change plan" or "Update card"; never retried |
| 402    | `MODEL_PLAN_CAPACITY`                                                                          | capacity                                                   |
| 403    | `MODEL_PLAN_UPGRADE_REQUIRED {plan, planName}`                                                 | Change plan; never retried                                 |
| 403    | `CODIUM_PERK_REQUIRED {perk, plan}`, `MODEL_PLAN_BLOCKED`                                      | upgrade, or contact                                        |
| 409    | `MODEL_PLAN_EXISTS`, `MODEL_PLAN_CHANGE_UNAVAILABLE`                                           | the plan picker or the account page                        |
| 410    | `MODEL_TOPUP_REMOVED`                                                                          | answered by `/api/model-plans/topup`, which sells nothing  |
| 426    | `CODIUM_UPDATE_REQUIRED`                                                                       | "Update Vector to keep using Vector Codium."               |
| 429    | `RATE_LIMITED`, `MODEL_PLAN_BUSY`                                                              | retried                                                    |
| 429    | `MODEL_PLAN_CONCURRENCY`                                                                       | waits, up to 15 minutes, without counting attempts         |
| 429    | `MODEL_PLAN_DAILY_LIMIT`                                                                       | not retried; retry-after is 00:00 UTC                      |
| 429    | `MODEL_PLAN_RUN_LIMIT`, `MODEL_PLAN_BRAIN_SHARE`                                               | not retried; a helper skips quietly                        |
| 503    | `MODEL_PLAN_RENEWING`                                                                          | retried like busy                                          |
| 503    | `MODEL_PLAN_MODEL_UNAVAILABLE`                                                                 | "temporarily unavailable; pick another model"              |
| 503    | `MODEL_PLANS_DISABLED`, `CODIUM_SALES_PAUSED`                                                  | unavailable                                                |

**What is retried.** Refusals before anything reached a provider (`RATE_LIMITED`, `MODEL_PLAN_BUSY` from admission, `MODEL_PLAN_RENEWING`, `MODEL_PLAN_CONCURRENCY`) cost nothing and are retried. Every answer the gateway gives after it dispatched the request carries `dispatched: true` and is final whatever its code, because that attempt counts toward the month; the turn says so and nothing resends it. Credit, upgrade, daily and run answers are never retried, and nothing moves to another paid provider. The one exception is the gateway's own: for Max and Ultra it retries once on a provider 429 or 503 that arrived before any byte, under the same hold and deadline. `MODEL_TOPUP_EXHAUSTED` is never sent again.

## Switches

Runtime switches live in the store (`api/_lib/codium-switches.ts`), take effect within 30 seconds, need no redeploy and are written to an audit log. The owner page sets them.

- `sales`: off pauses checkout and upgrades. Renewals and already-paid upgrades continue (M12).
- `codium`: off makes the gateway refuse Codium. After `CODIUM_CODIUM_OFF_PAUSE_MINUTES` (60) off, active subscriptions get `pause_collection=void`, lifted when the switch returns.
- `cloudAgents`, `hosted` (`on`, `no-new`, `stop`), `ops`, `remote`, `vault`, `push`: one per service.
- `perks-off` and `models-off` take a single perk or model off the pages and the gateway.

Never set `MODEL_PLANS_ENABLED` back to false while anyone is subscribed: it stops the service for paying people. Use `sales` and `codium` instead. Funding, alerts and the owner page are described in [owner-actions/codium-owner-guards.md](owner-actions/codium-owner-guards.md).

## Coding catalog

`api/_lib/codium-catalog.ts` holds two lists. `CODIUM_MODELS` is the reviewed five-model runtime catalog below, from the October 23, 2026 capture (`CODIUM_RUNTIME_CATALOG_UPDATED`). `CODIUM_TIER_MODELS` stages the tier catalog of contract §4.12 with plan floors, per-tier contexts, roles, judges and review pairs (`CODIUM_CATALOG_UPDATED`; the owner's October 30 decision removed Terra, Astra and Astra Long and keeps Sol staged). **No route is served** until its captured OpenRouter ZDR endpoint evidence is accepted into `ROUTE_ACCEPTANCES` (WP A60); until then every real route answers 503 `MODEL_PLAN_MODEL_UNAVAILABLE` before any key, hold or fetch, and `/models` and the pricing page list no model. Records of the captures and staging are in `build/codium-a15-catalog-notes.md`, `build/codium-csol-models-notes.md` and `build/codium-a17-context-decision.md`.

The [public model catalog](https://openrouter.ai/api/v1/models) and [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr) were checked on October 23, 2026. Selected records are captured in `packages/web/test/fixtures/codium-endpoints-2026-10-23.json`. `bun scripts/model-plan-catalog.ts` from `packages/web` audits the staged candidates against the committed manifest offline, without a provider request.

| Model                                                                               | Role                               | Context / max output | Input / output ceiling per million tokens |
| ----------------------------------------------------------------------------------- | ---------------------------------- | -------------------- | ----------------------------------------- |
| [DeepSeek V4.1 Flash 1017](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017) | Default everyday coding            | 262,144 / 16,384     | $0.30 / $1.20                             |
| [Claude Haiku 5.5](https://openrouter.ai/anthropic/claude-haiku-5.5)                | Focused coding and tests           | 64,000 / 16,000      | $0.22 / $0.55                             |
| [GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna)                               | Efficient reasoning and agent work | 128,000 / 8,192      | $0.1375 / $0.55                           |
| [Kimi K3.1 Pro](https://openrouter.ai/moonshotai/kimi-k3.1-pro)                     | Premium coding and reasoning       | 128,000 / 8,192      | $2.00 / $10.00                            |
| [Gemini 4 Argon](https://openrouter.ai/google/gemini-4-argon)                       | Premium coding and analysis        | 128,000 / 8,192      | $2.00 / $10.00                            |

These ceilings are OpenRouter's public provider prices, not what a plan includes. Routing requires `zdr: true`, `data_collection: "deny"` and `require_parameters: true` for every model, with no fallback to a non-ZDR route and every OpenRouter plugin disabled; a request that would exceed the ceilings fails rather than raising the price. OpenRouter's ZDR still has exceptions, which the privacy policy discloses: from October 27, 2026 it screens all traffic, ZDR included, for CSAM, and may keep and report flagged content, and it keeps request metadata such as token counts and latency. The Codium OpenRouter account's privacy settings must stay as [codium-payments.md](owner-actions/codium-payments.md#2-openrouter) lists, or OpenRouter itself may store prompts.

Prompt caching is model-specific and no cache hit is promised; the privacy policy discloses the 5-minute and 30-minute explicit caches. Before sales open, ask OpenRouter to confirm that explicit caching on the Bedrock, Vertex and Azure ZDR endpoints leaves them ZDR; if it does not, set `explicitCache` off for the affected models in `api/_lib/codium-catalog.ts`.

The gateway estimates input at four bytes of content per token, as the clients do, and refuses a request that cannot fit the model's window with its reply (`MODEL_PLAN_CONTEXT`); when the provider refuses a context, the gateway answers the same code and Vector compacts instead of retrying.

OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict resale of model API access. Confirm that the bundled Vector offering is covered by appropriate commercial terms before activation. No source change grants this permission.

## Configuration

Server secrets belong in the hosting environment, never in client builds or the repository. `.env.example` lists every variable with its default. In short:

- **Billing:** `MODEL_PLANS_ENABLED`, `CODIUM_STRIPE_MODE` (`live` or `test`; a live key runs only with `VERCEL_ENV=production`), `STRIPE_SECRET_KEY` (a restricted `rk_` runtime key), `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`, `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`, `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`, `CODIUM_STRIPE_AUTOMATIC_TAX`, the private pools (`MODEL_PLAN_<price>_CREDITS_USD` or `MODEL_CREDIT_MARKUP_PERCENT`), `OPENROUTER_MANAGEMENT_KEY`, `MODEL_PLAN_KEY_ENCRYPTION_SECRET`, `KV_REST_API_URL` and `KV_REST_API_TOKEN`, `CRON_SECRET`, `CODIUM_TEST_CREDIT_CAP_USD`, `VECTOR_ADMIN_EMAILS`.
- **Risk:** `CODIUM_3DS_MIN_USD`, `CODIUM_TRUST_RAMP_DAYS`, `CODIUM_RENEWAL_GRACE_MINUTES`, `CODIUM_EFW_REFUND`, `CODIUM_RADAR_BLOCKLIST_ID`, `CODIUM_CODIUM_OFF_PAUSE_MINUTES`.
- **Funding and owner:** `CODIUM_OWNER_EMAIL`, `CODIUM_OWNER_SECRET`, `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`, `CODIUM_FUNDING_MARGIN_PERCENT`, `CODIUM_FUNDING_MARGIN_USD`, `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD`, `CODIUM_SPEND_SPIKE_USD_PER_HOUR`, `CODIUM_OPENROUTER_FEE_PERCENT`, and the Vercel spend callbacks `VERCEL_MAIN_TEAM_ID`, `VERCEL_SPEND_WEBHOOK_SECRET_MAIN`, `VERCEL_HOSTED_TEAM_ID`, `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`.
- **Gateway:** `MODEL_PLANS_MIN_CLIENT`, `MODEL_PLAN_REQUIRE_MARKED_TOKENS`, `MODEL_PLAN_GLOBAL_INFLIGHT`, `MODEL_PLAN_PRIORITY_RESERVE`, `MODEL_PLAN_MODELS_JSON` (blank uses the reviewed catalog; `[]` offers no models).
- **Listing:** `CODIUM_LISTED_PERKS`, `CODIUM_TRACK_B_LIVE`.
- **Removed:** `STRIPE_MODEL_TOPUP_*`, `MODEL_TOPUP_*_CREDITS_USD` and `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`. Nothing reads them.

`bun scripts/setup-model-plans.ts` from `packages/web` is a dry run by default and makes no network call. With `--apply` and the owner's full `sk_` setup key (never the deployed `rk_` runtime key) it creates or reuses the four monthly products and prices (lookup keys `vector-models-{10,50,100,200}-monthly-v1`, `tax_behavior=exclusive`, statement descriptor `VECTORDEV CODIUM`), the single no-change portal, and the webhook subscribed to exactly the 20 events; it archives the legacy top-up prices and deactivates an old plan-change portal. `bun scripts/codium-economics.ts` prints private planning figures for the owner's terminal only.

Crons (`CRON_SECRET`): outbox every minute, replay and funding every 10 minutes, the risk sweep hourly, the full sweep daily at 04:23 UTC. The hosted, vault and ops schedules are added by the work packages that build their routes.
