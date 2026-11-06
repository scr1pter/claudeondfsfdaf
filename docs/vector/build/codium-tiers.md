# Vector Codium tiers: corrected proposal

Code paths are relative to `main/`, which is shipped main `6eaf445a`. I only read files and ran nothing. Every price has a URL and the date I read it. Where a figure comes from the owner's brief, I say so.

---

## 1. Recommendation

- **Keep the four plans and their ids.** They are Plus $10 (`vector-10`), Pro $50, Max $100 and Ultra $200 (`packages/schema/src/codium-plan.ts:7-12`). The ids never change (`:4-5`).
- **Every tier adds something real, not just more usage.**
  - Plus: four everyday models.
  - Pro: adds the premium models, led by GPT-6.1 Sol.
  - Max: adds deeper reasoning on Sol, fast lanes, twice Pro's parallelism and a higher daily ceiling.
  - Ultra: adds Sol at its deepest setting with a 256K context, new models before anyone else, twice Max's parallelism and no daily ceiling.
- **Lock only what the gateway enforces.** The code is public, so a limit that lives only in the app can be patched out. Every perk above is applied on the server in `api/_lib/model-plan-chat.ts`. Reasoning effort is already set there by the catalog, not by the client (`:137-138`).
- **No tier can lose money on tokens.** Each tier's monthly pool is a hard stop set below break-even, and three server backstops already exist (section 3). The real exposures are fraud chargebacks and the Stripe-per-request load problem, not heavy honest use.
- **Usage is shown only as a percentage.** Any Codium step shows the label "Codium" instead of tokens or price. No dollar amount of included usage is published anywhere.
- **No team features now.** A short sketch is in section 8.

---

## 2. Tier table

| | **Plus** $10 | **Pro** $50 | **Max** $100 | **Ultra** $200 |
|---|---|---|---|---|
| **Models** | DeepSeek V4.1 Flash 1017 (default), Claude Haiku 5.5, GPT-6 Luna, GPT-6.1 Terra (see the Terra note: blocked until it has a ZDR route) | + **GPT-6.1 Sol** (recommended premium), Kimi K3.1 Pro, Gemini 4 Argon | + **Sol Deep**: Sol at extra-high effort with a 16K reply | + **Sol Deepest**: Sol at maximum effort, 256K context, 32K reply |
| **Fast lanes** | — | — | Kimi highspeed, Gemini priority | Same |
| **New Codium models first** | — | — | — | Yes, during a preview window (for example 30 days) |
| **Usage, as a multiple of Plus** | 1x | 5.5x | 12x | 25x |
| **Codium agents at once** (requests in flight, across all sessions) | 3 | 6 | 12 | 24 |
| **Requests per minute** | 30 (today's limit, `model-plan-chat.ts:373-379`) | 60 | 120 | 200 |
| **Daily ceiling** (share of the month's usage per UTC day) | 25% | 25% | 40% | None; only the monthly pool applies |
| **Support** | "Paid" tag and higher report limits | Same | Front of the queue, with no promised response time | Same |
| **Same on every plan** | Zero-data-retention routing, no provider keys, app and CLI, no overage charges | | | |

**Typical tasks a month.** These go on the page instead of any dollar figure. A big task uses the brief's Artificial Analysis cost per task. A small fix is assumed to cost a tenth of that.
- **DeepSeek** ($0.30 per task): Plus about 20–200, Pro about 110–1,100, Max about 240–2,400, Ultra about 500–5,000.
- **Sol**: at least about 22 / 48 / 100 big tasks on Pro / Max / Ultra. That uses $1.50 per task, which was measured at Sol's Max effort. High effort costs less per task, so these are floors.
- **Terra on Plus** (High effort, $0.54 per task): about 11 big tasks.

**Terra on Plus: blocked for now, with a fallback.**
- **Prices** (https://openrouter.ai/api/v1/models/openai/gpt-6.1-terra/endpoints, read 2026-10-27):
  - Terra has three endpoints, all of them OpenAI direct: flex $0.50/$2.50, standard $1/$5 (cache read $0.05, write $1.25) and fast $2/$10 per 1M tokens.
  - A long-context price applies from 272,000 prompt tokens.
- **No ZDR route.** Terra has no entry on https://openrouter.ai/api/v1/endpoints/zdr (read 2026-10-27, as a summarised read of the 1.1M-character list in 100k sections). Codium routes only with `zdr: true` and has no fallback route (`model-plan-chat.ts:147-154`, `docs/vector/MODEL-PLANS.md:64`). So Terra cannot ship.
- **Fallback until a route appears:**
  - The page lists Terra under "Coming to Plus", with no date. The terms promise nothing about it.
  - At the High effort Codium uses, Terra scores 46, the same as DeepSeek V4.1 Flash 1017, and costs about 1.8x as much per task. So Plus loses no measured quality while Terra is missing.
  - No other ZDR OpenAI-family model fits Plus's price. Luna is already included. The older GPT-5.6 Terra on Azure ZDR costs $2/$12 per 1M (ZDR list, read 2026-10-27), which is as much as Sol.
- **Weekly owner check:** look for Terra on the ZDR list. Sol and Luna are ZDR only on Azure, so Azure is the likely route. When it appears, add the catalog entry, then the audit fixture, then release.
- **Hold per request:** about $0.201 (128K context at the $1.25 cache-write ceiling, plus an 8,192-token reply at $5).

**Sol.**
- **ZDR routes** (https://openrouter.ai/api/v1/models/openai/gpt-6.1-sol/endpoints and the ZDR list, both read 2026-10-27):
  - Sol is ZDR only on Azure: `azure` at $2/$10 (cache write $2.50), and `azure/eu` and `azure/us` at $2.20/$11 (cache write $2.75).
  - The OpenAI fast ($4/$20) and ultrafast ($12/$60) routes are not on the ZDR list. So Sol gets no fast lane.
- **Holds per request,** using the regional ceilings:

  | Entry | Context / reply | Hold |
  |---|---|---|
  | Sol (High) | 128K / 8,192 | $0.442 |
  | Sol Deep | 128K / 16,384 | $0.532 |
  | Sol Deepest | 256K / 32,768 | $1.064 |

  Sol Deepest stays under the 272K long-context price step.
- **Don't advertise Sol's score of 54 on Pro.** That score was measured at Max effort, and Codium runs every model at High (`api/_lib/model-plan-config.ts:30`). Only the Ultra entry matches the measured configuration.

**Argon** (53 at $5.86 per task) costs about 20x DeepSeek per task, about 6 big tasks on Pro. It stays beside Sol at no build cost. The page should list Sol first and say Argon "uses usage fastest".

**Fast lanes** (ZDR list, read 2026-10-27): Kimi `moonshotai/highspeed` is $4/$20 and Gemini `google-vertex/global/priority` is $3.60/$18. Today's $2/$10 price ceilings exclude both (`MODEL-PLANS.md:64`). Holds would be about $0.676 and $0.608. They cost the owner $0, because the buyer's pool pays.

---

## 3. Can any tier lose money? Hard caps per tier

**Inputs**
- **Private monthly pools** (provider-cost USD, never published): $6 / $33 / $72 / $150. They are set by `MODEL_PLAN_<price>_CREDITS_USD` in the hosting environment, with no code change (`model-plan-config.ts:51-63, 103-113`).
- **Stripe** (https://stripe.com/pricing, read 2026-10-27):
  - 2.9% + 30¢ per card payment;
  - +1.5% for international cards (+1% more only when currency conversion is needed);
  - Billing 0.7% on subscriptions;
  - $15 per dispute, plus another $15 if you contest it (refunded if you win).
- **OpenRouter fee:** 5.5% on credits (`api/_lib/codium-ledger.ts:281-283`). This is not verified. The FAQ (https://openrouter.ai/docs/faq, read 2026-10-27) shows an unrendered placeholder where the fee should be.

| | Plus $10 | Pro $50 | Max $100 | Ultra $200 |
|---|---|---|---|---|
| Typical: 60% of the pool used, domestic card → profit | $5.54 (55%) | $27.01 (54%) | $50.52 (51%) | $97.55 (49%) |
| Heavy: 100% used, international card → profit | $2.86 (29%) | $12.33 (25%) | $18.64 (19%) | $31.25 (16%) |
| Fraud: pool fully used, then the dispute is lost | −$22.14 | −$52.67 | −$96.36 | −$183.75 |
| Break-even pool, domestic / international card | $8.85 / $8.71 | $45.40 / $44.69 | $91.09 / $89.67 | $182.46 / $179.62 |

Not included in the table: fixed hosting, sales tax and the owner's time.

**Why heavy honest use can't lose money. Hard caps already in code:**
1. **The request hold.** Each request reserves its largest possible cost before it runs, and parallel requests can't exceed the balance together (`model-plan-chat.ts:383-384`, `MODEL-PLANS.md:88`).
2. **The price ceiling.** Routing has a price ceiling per model (`model-plan-chat.ts:153`).
3. **The monthly key limit.** Each month runs on an OpenRouter key whose limit equals the pool (`model-plan-account.ts:755`).
4. **Upgrades can't cheat the pool.** A mid-period upgrade can't unlock a bigger pool without a full, non-prorated paid invoice (`:532-547`).
5. **Disputes stop access.** A disputed charge ends access (`:528`) and takes back the remaining credits (`codium-ledger.ts:71-82`).

**New per-tier hard caps (server-side):**

| Cap | Plus | Pro | Max | Ultra | What it protects |
|---|---|---|---|---|---|
| Monthly pool (100% means stop) | Yes | Yes | Yes | Yes | **Your money** (already built) |
| Agents at once / requests per minute | 3 / 30 | 6 / 60 | 12 / 120 | 24 / 200 | Gateway load, OpenRouter key reads |
| Daily ceiling on monthly credits | 25% | 25% | 40% | — | The buyer's month, against runaway automations |
| Fraud controls: 3D Secure on first purchases of $100 or more, and pause the key on a Stripe early-fraud-warning webhook (not handled today: no `early_fraud` or `radar` handling in `api/`) | All tiers | | | | **Your money**, in the only losing case |

When the daily ceiling is reached, top-up credits keep working if the buyer has any.

**Vectorscope specifically:**
- **It never costs the owner anything.** A Codium review spends the buyer's own pool, and Vectorscope uses Codium only when the person chooses it (`packages/app/src/features/pull-requests/ai-review.ts:438-439, 698`).
- **Actions reviews can't use Codium today.** As I read `workflowModel` (`ai-review.ts:409-436`), Codium has no repository-secret key, so automatic reviews in GitHub Actions can't run on it.
- **Review budgets are in dollars, which Codium can't use.** The current budgets are dollar amounts (`packages/core/src/review/skip.ts:33-34, 55, 68`), and Codium steps have no price (`packages/web/src/data/docs-content.ts:50`).
- **Add a token-based stop instead.** For Codium reviews, the app stops at a token budget it keeps internally: 400K tokens per review (about 5x a measured 79K-token review) and 2M per PR per day. It only protects the buyer's month. The pool and the daily ceiling are the real caps.
- **Never fund reviews from the owner's account.**

---

## 4. How usage is shown

- **The percentage display already exists.**
  - Status returns only the whole-percent share left (`api/_lib/model-plan-status.ts:35-40, 65, 92-94`).
  - Settings > Usage shows it (`packages/app/src/components/settings-v2/usage.tsx:159` → `settings-vector-codium.tsx:79-85`).
  - So does `vector codium` (`packages/core/src/model-plan-status.ts:211-219`).
  - Add "today: N% of today's limit used" for the daily ceiling, and the plan's entitlements, without any amounts.
  - Purchased credits keep their state word (available / low / used, `model-plan-status.ts:82-90`). A percentage of a pooled balance would read "8% left" just after a new purchase.
- **Show "Codium" instead of tokens or price** for any step whose provider is `vector-plan`:
  - the cost pill label, which today reads "Codium credits" (`packages/app/src/features/economics/format-spend.ts:80`);
  - the tooltip (`:118-119`);
  - review pass lines, which today show tokens (`ai-review.ts:1717-1729`);
  - also check `session-context-tab.tsx`, `session-context-metrics.ts`, `background-tasks-pane.tsx`, `subagent-model.ts`, `token-usage.ts` and the terminal UI.
- **The gateway still sends token counts** (`model-plan-chat.ts:332-337`), because the engine needs them to compact the context. This is a display change only.
- **Rename the top-ups.** "$10 credit top-up" (`codium-plan.ts:17`, pinned by `test/codium-plan-names.test.ts:28-31`) reads as $10 of usage. Use "$10 top-up".
- **A leak to know about.** A task range plus Artificial Analysis's public cost per task lets a reader estimate a pool to within about 2x. That breaks no dollar rule, but the claim that no reader can work back to the dollars (`model-plan-config.ts:178-183`) is only approximately true.

---

## 5. What stays free, and what top-ups buy

- **The free workspace stays free and unlocked.** That covers the desktop app, the CLI, your own keys, free models, parallel agents, subagents, Vectorscope, multiplayer, Vector Cloud, the browser agent, skills, MCP, automations, checkpoints and Run Guard. /codium already promises this (`packages/web/src/components/marketing/codium/CodiumPricing.tsx:169-189`).
- **Codium concurrency caps apply only to Codium requests.** On Plus, Codium helpers run 3 at a time and the rest wait, because the gateway answers 429, which old clients retry. The docs promise "batches of up to eight subagents" (`docs-content.ts:321`), so the /codium page has to say this.
- **Top-ups buy credits only.**
  - Credits are 55% of the price: $5.50 / $27.50 / $55 / $110. The earlier draft's 60% gave a $10 top-up the same credits as Plus with no expiry, which made Plus pointless.
  - In the heavy case (100% used, international card, no Billing fee) a top-up keeps a 35–37% margin.
  - Top-ups carry forward (`packages/web/src/pages/legal/terms.astro:53-54`).
  - Top-up credits follow the subscription's tier. With no subscription, they get Plus's models and caps.

---

## 6. Market check

Competitor figures come from the competitor brief, pages read 2026-10-26.
- **Entry price matches the market.** The usual entry price is $8–10: Cursor Plus $8, ChatGPT Go $8, Copilot Pro $10, Zed Pro $10, JetBrains Pro $10.
- **$50 has no direct peer.** Most vendors sell a $20 core tier. The nearest are Cursor Premium $30, Copilot Pro+ $39 and Kiro Pro+ $40. Codium has no $20 tier.
- **$100 and $200 match.** Peers: Claude Max, ChatGPT Pro 100/200, Cursor Super/Ultra, Google AI Ultra, Copilot Max, Kiro Pro Max/Power, Devin Max.
- **Codium gives less usage per dollar at $200 than most peers.**

  | $200 tier | Usage vs the vendor's base tier | Price vs base | Usage per dollar |
  |---|---|---|---|
  | Claude Max 20x, Google Ultra 20x | 20x | 10x | about 2x |
  | Cursor Ultra | 50x | 25x | about 2x |
  | ChatGPT Pro 200 | 10x (third-party) | 10x | 1x |
  | Codium Ultra | 25x | 20x | 1.25x |

  Codium pays providers per token at cost, so it can't match subsidised multiples. Sell what bring-your-own-key users don't get: no keys, ZDR, the perks and support.
- **The perks follow the market:**
  - models limited at entry (Cursor Plus is Grok-only, ChatGPT Free/Go is Luna-only);
  - deeper reasoning at the top (ChatGPT Pro, snippet);
  - early access (Claude Max, Cursor Ultra, Google Ultra);
  - no short window at the top (ChatGPT Pro has "no five-hour limit");
  - concurrency (Replit 10 parallel agents, Jules concurrency).
- **Plus is generous by comparison.** Four models including Claude Haiku and a GPT model, where peers' entry tiers are single-vendor or auto-only.

---

## 7. How to build it

**Step 0: plan cache (2–4 days).** This comes first.
- **The problem:** every chat and status call lists the customer's Stripe subscriptions (`model-plan-account.ts:726-733`) and reads the OpenRouter key (`:750`).
- **The fix:**
  - Add `plan` to the stored key record (`:42-51`).
  - Write it when the key is provisioned (`provisionMonthlyKey`, `:803`) and when the account is reconciled (`:446`).
  - Read Stripe only on webhooks, at a period boundary, or when nothing is stored.
- **Caching the key read:** it may be cached only for as long as finished requests keep their hold (30 s, `MODEL-PLANS.md:88`). Otherwise extend that hold to cover the cache time.

**Entitlements**
- In `codium-plan.ts`, add `ENTITLEMENTS` keyed by plan id, plus `none` for top-up-only accounts, which gets Plus's values. Fields: `rank`, `inFlight`, `perMinute`, `dailyShare` (null on Ultra), `fastLane`, `earlyModels` and `support`.
- In `codium-catalog.ts`, add per-entry fields: `minPlan`, `previewUntil`, `upstream` and `providerOnly`.
  - `upstream` is needed because variant ids must be unique (`model-plan-config.ts:127`) but the id is sent upstream as the model.
  - `providerOnly` pins the fast-lane route. Today routing only filters by `max_price` (`model-plan-chat.ts:147-154`).
- Widen `reasoningEffort` to `"high" | "xhigh" | "max"` (`model-plan-config.ts:30`).
- Add task ranges for Sol and its variants (`:234-240`). Make all ranges scale by `multiple`, not by price (`:212`).
- Lower DeepSeek's range. The shipped 50–500 on Plus (`:235`, `MODEL-PLANS.md:74`) implies $0.12 per big task at a $6 pool, against the $0.30 Artificial Analysis measures. Use about 20–200, or measure it with Vector's own benchmark harness.

**Gateway**
- **Order in `model-plan-chat.ts`:** read the cached plan, then apply the per-tier rate limit (`:373-379`), then refuse a locked model with `403 MODEL_PLAN_UPGRADE_REQUIRED` before any hold (`:380-384`).
- **In-flight cap:** a per-account counter in Valkey, one entry per request expiring after 660 s and removed in `finally` (`:418-427`). Over the cap, answer `429 MODEL_PLAN_BUSY` with `retry-after`.
- **Daily ceiling:** a second pool in `holdCredits` (`model-plan-account.ts:661-690`) with code `MODEL_PLAN_DAILY_LIMIT`. Let it fall back to top-up credits by adding the code to the list at `:613-616`.
- **Tier through the top-up fallback:** `monthlyCredential` returns the plan (`:764-768`), and a subscriber falling back to top-up credits keeps their tier (`:612-626`).
- **`/models`:** send each client only the models its tier allows. Send locked models only to new clients that say they can show them, and never call Stripe from this endpoint (`model-plan-models.ts:13-27`).
- **Status:** add `entitlements` and a daily percentage, never amounts. Add them to the no-Stripe branch too (`model-plan-status.ts:18-27`). The "used up" check should use the cheapest model the tier allows (`:47-48`).
- **Stripe:** handle the early-fraud-warning webhook by pausing the key, and request 3D Secure on first purchases of $100 or more.
- **Support:** tag paid accounts and raise their limits (`api/support/bug-report.ts:60, 77-79`).

**App and CLI**
- **Shared status and catalog code:**
  - Extend the status schema, `fromRemote`, `describe` and `notice` (`packages/core/src/model-plan-status.ts:25-80, 169-247`).
  - Extend the catalog schema (`packages/core/src/model-plans.ts:26-33`).
  - Map the new codes to an "Upgrade plan" action (`:319-331`, `packages/engine/src/provider/error.ts:200-221`).
- **Model picker and routing:**
  - Show locked models greyed with a plan badge (`packages/app/src/utils/provider-brand.ts:91-113`).
  - Never route to a locked model (`packages/desktop/src/main/swarm-plan.ts:252-260`, `packages/app/src/utils/task-intelligence.ts:172-175`).
- **Display and limits:**
  - Apply the "Codium" label and the percentage display from section 4.
  - Add the token stop for Codium reviews.
  - Run Guard needs a decision: with a dollar cap set, it stops a Codium run after 40 unpriced steps (`docs-content.ts:50`).

**Page, docs and legal** (one release, before `MODEL_PLANS_ENABLED=true`)
- **`CodiumPricing.tsx`:**
  - `:22-23`: remove "Plans differ only in usage".
  - `:142`: model rows come from `minPlan`.
  - Add a "Plan perks" group.
  - `:291`: "for every Codium model" goes.
  - `:519-527` and `:567`: update the FAQ.
  - `:738-753`: fill in the card lists.
- **Other pages:** `packages/web/src/pages/codium.astro:21` and `packages/web/src/pages/docs/desktop-app.astro:72`.
- **`MODEL-PLANS.md`:** lines `:3, :17, :40, :52, :74, :96, :102-104`.
- **Settings copy:** `settings-vector-codium.tsx:55-56`.
- **Terms §3:**
  - `:42-43` and `:48-50`: list included models, limits and daily ceilings.
  - `:53-54`: top-ups follow the plan's models and caps.
  - `:75-76`: changes may cover "included models or features".
  - Add the right to replace a retired model with a comparable one.
  - Add consent to immediate delivery at checkout (EU withdrawal right).
  - Get a lawyer's read.

**Tests** (in CI, not on this Mac while Vector is running)
- **New tests:**
  - entitlements only go up from Plus to Ultra;
  - every model has a valid `minPlan`, and the default model is open to Plus;
  - a locked model gets 403 before any hold;
  - top-up-only accounts get Plus's tier, and a subscriber on top-up credits keeps theirs;
  - the in-flight cap returns 429 and frees the slot on error or abort;
  - the daily pool works and falls back to top-ups;
  - `/models` never calls Stripe;
  - status shows no amounts;
  - task ranges follow the multiple;
  - the "Codium" label shows for `vector-plan` steps.
- **Tests to update:**
  - `packages/web/test/model-plan-models-api.test.ts:60-94` and `packages/web/test/model-plans.test.ts:85-143`;
  - `CodiumPricing.test.ts:124-156, 226-303` (the free-workspace rows stay "Included");
  - `model-plan-status-api.test.ts:56-90`, `model-plans-api.test.ts:1058-1240` and `model-topups-api.test.ts:462-541`;
  - `packages/core/test/model-plans.test.ts:184-261, 396-454, 564-646`;
  - `format-spend.test.ts`, `ai-review.test.ts` and `test/codium-plan-names.test.ts:28-31`;
  - the catalog audit `packages/web/test/model-plan-catalog.test.ts:58-64`, with a new endpoints fixture.

**Order of work** (about 3 weeks solo)

| Step | Work | Estimate |
|---|---|---|
| 1 | Owner decisions | 1 day |
| 2 | Plan cache | 2–4 days |
| 3 | Entitlements and catalog fields | 3–4 days |
| 4 | Gateway caps and fraud webhook | 2–3 days |
| 5 | Sol, its variants and the fast lanes. First check that OpenRouter accepts `xhigh` and `max` effort and the route pins | 1–2 days |
| 6 | App and CLI, then a desktop and CLI release | 4–6 days |
| 7 | Page, terms and docs, plus a legal read | 1–2 days |
| 8 | Support tag | 1 day |
| 9 | End-to-end run in Stripe test mode, plus a load check at Ultra's limits | — |
| Later | Terra, once a ZDR route exists | half a day plus a release |

---

## 8. Later

- **Teams (sketch only).**
  - Seats at the same four tiers, with central billing and an admin daily ceiling in percent. SSO and audit logs come later.
  - Built: the Teams API (signed shared settings), disabled. Members are added by hand in SQL (`docs/vector/owner-actions/teams.md:3`).
  - Missing: seat billing (about 3–6 weeks) and an admin UI (1–2 weeks).
- **Managed cloud hours.** Not built, and the prototype was deleted (`e7a2b8f2`). It is the only perk whose cost grows with use and isn't covered by credits: about $0.110–0.341 an hour (https://vercel.com/docs/vercel-sandbox/pricing, read 2026-10-26). Don't list it until it has hour quotas, a spending cap and a kill switch.

---

## 9. Risks and owner decisions

**Risks**
- OpenRouter's resale terms are still open (`MODEL-PLANS.md:123`).
- The 5.5% OpenRouter fee is not verified.
- Not verified: Terra's ZDR status, the route pinning and whether `xhigh`/`max` effort works through OpenRouter.
- The Artificial Analysis figures come from the owner's brief, which uses the coding-agent board. The `artificialanalysis.ai/models` figures (Kimi 55, DeepSeek 45) are a different index. Don't mix them in copy.
- The $10→$50 gap is large.
- Bring-your-own-key users get the same models at cost. Codium's case rests on convenience, ZDR and the perks.
- Fraud is the only way a tier loses money (up to about $184 on Ultra).
- Old clients route to anything they're sent, so `/models` must filter by tier.

**Decisions**
1. The pools: $6 / $33 / $72 / $150 suggested.
2. Argon: beside Sol (recommended) or dropped.
3. Daily ceilings: 25 / 25 / 40 / none suggested, or none at all.
4. A $20 tier (`vector-20`).
5. Top-ups at 55%, and whether they expire after 12 months.
6. Run Guard's 40-unpriced-step rule for Codium.
7. When to build teams and cloud hours.

---

## What I changed and why

1. **Plus now has four models, and Terra is honestly blocked.** I re-checked Terra on 2026-10-27: no ZDR route, and its endpoints are OpenAI direct only. The fallback is DeepSeek, which has the same score at High effort, with Terra listed as "Coming to Plus" without a date.
2. **Max and Ultra are now clearly separate.** The earlier draft gave Ultra "Same as Max" for models and early access to both. Now Max gets Sol Deep, fast lanes, 12 agents and a 40% daily ceiling. Ultra gets Sol Deepest with 256K context, exclusive early models, 24 agents and no daily ceiling.
3. **Sol is the premium model, with a caveat.** Its score of 54 was measured at Max effort, and Codium runs High (`model-plan-config.ts:30`). So only Ultra's entry matches the benchmark, and Pro's copy must not claim 54.
4. **Per-task figures are updated to the brief's numbers.** The draft said Sol costs 2.8x DeepSeek per task; it is about 5x. I added Argon at about 20x and Terra at about 1.8x.
5. **Shipped task range overstated.** Plus's shipped DeepSeek range of 50–500 implies $0.12 per big task against the $0.30 measured, so I lowered it to about 20–200. I kept the fix that makes ranges scale by `multiple` (`:212`).
6. **Cloud hours are out of the tier table.** They aren't built, and they were the only cost that pushed heavy-use margins to 2–5%. Without them the worst honest-use margin is 16%.
7. **Fraud is the real losing case.** Up to about $184 on Ultra. I added 3D Secure and the early-fraud-warning pause. Disputes already end access (`model-plan-account.ts:528`).
8. **Hard caps are listed per tier, with what each protects.** Only the pool protects money. For Vectorscope, the dollar budgets can't price Codium steps, so the app stops a Codium review by tokens instead.
9. **Percent-only display and the "Codium" label are mapped to code.** The percentage display already exists. The label replaces "Codium credits" (`format-spend.ts:80`) and token readouts (`ai-review.ts:1717-1729`). I added renaming "$10 credit top-up".
10. **Top-ups changed from 60% to 55%.** At 60%, a $10 top-up matched Plus's credits and never expired.
11. **Competitor claims corrected.** $50 has no direct peer. Ultra's 1.25x usage per dollar is below the roughly 2x of Claude, Google and Cursor at $200.
12. **Teams are reduced to a sketch,** as the owner directed.
13. **Build notes corrected.** Model variants and fast lanes need new `upstream` and `providerOnly` catalog fields. The key read can only be cached within the 30 s window. The break-even table now shows international cards too.