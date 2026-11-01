# Vector Codium tiers v3: plans built on Vector, not just models

**30 Oct:** GPT-6.1 Terra and GPT-6 Astra (with Astra Long) are out and Sol stays (owner decision, `codium-tiers-v3-changes.md` §8). The Terra and Astra text below is history; §8 wins over it.

Written 27 Oct 2026 for the owner. This builds on `codium-tiers-v2.md` (v2) and `codium-tiers.md` (v1). Where they disagree, v3 wins. Anything v3 doesn't mention stays as v2 has it: the pools, Stripe and fee figures, the gateway cost bound, the percent-only display, the "Codium" step label, Labs (v2 §1a) and cloud agents (v2 §1b).

**How I checked**
- **Code:** read only, with cat, grep, sed and git. Nothing was built, tested or run. Paths with no root are in vector-main (`main/`, now at `f2b66f63`). Paths marked **(evolve)** are in vector-evolve (`self-evolving/`, at `27916d6b`). v2's line numbers came from an older commit, `6eaf445a`.
- **Model routes:** OpenRouter's public API, read 2026-10-27. The URLs are listed at the end.
- **Prices for the new hosted services:** I re-read Cloudflare's Durable Objects and R2 pricing pages on 2026-10-27. The other prices come from today's research pass, and each has its URL.
- **Perks:** two judges scored 34 ideas. A perk is a headline here only if both judges said "include", or if both rated its value high, one said "maybe", and this plan deals with that judge's concern.

**Words used below** (the same as v2)
- **Pool:** the private amount of model spend each plan includes. It is never published.
- **ZDR:** zero data retention. The provider keeps no prompts.
- **Hold:** what the gateway reserves before a request runs, which is the most that request can cost.
- **"Listed once shipped":** the pricing page shows a perk only after it ships, never as "coming".

---

## 0. What changed since v2

1. **Vector's own features now lead every tier.** Each tier has four headline perks. Three are Vector's own and one is about models.
2. **GPT-6 Astra is on Max (128K context) and Ultra (256K, as "Astra Long").** It runs on its two Azure ZDR routes.
3. **Top-ups are gone, and the plans are monthly only.** The following are removed:
   - v2's "Premium on demand" (item G);
   - v1's top-up packs at 55% of the price;
   - every rule that mentioned purchased credits.

   Upgrading is now the only way to get more usage within a month. So "upgrade and keep what's left" (v2 item N) moves before launch.
4. **Claude Sonnet 5.5 on Max and Opus 5.5 on Ultra are settled.** You accepted them on 27 Oct ("ok fine"), which closes v2 decision 5. The reason for them hasn't changed: they put a Claude model in the top two plans, both have ZDR routes, and Sonnet's cost fits Max's pool while Opus's fits Ultra's.
5. **New perks that only Vector can offer:**
   - Vector Remote and phone alerts;
   - Codium Brain;
   - Codium Auto that learns your repo;
   - PR reviews checked by a second lab;
   - a report tracker (free for everyone, see the review note below);
   - a roadmap vote;
   - your repo's Brain inside cloud runs (free with your own keys; Max adds Codium);
   - Brain Vault;
   - Race (free for everyone; Pro adds labs to race and judge with);
   - Vector Playbooks.

   **Review note (27 Oct):** the report tracker's "fixed in this version" notice is built from the public changelog and report ids the desktop keeps, and Race is a workflow anyone can write. Both could be switched on in the client for free, so neither is sold as a paid perk. Paid tiers keep only the parts the server enforces (models, agents at once, report tags and limits).
6. **GPT-6.1 Terra now has one ZDR route,** in the EU only (see 1a and decision 3).
7. **Margins:** typical-use profit barely moves (at most 1 point). Full-use profit drops by $0.37 to $2.01 per subscriber (section 3).

**On "OpenRouter provides ZDR for everything":** that isn't quite true, so each new model still needs a check before it is listed.
- 98 models on OpenRouter have no ZDR route at all, not counting 19 `~…-latest` aliases and 6 `openrouter/*` routers.
- None of its 71 `:batch` variants has one.
- Astra, Sonnet 5.5, Opus 5.5, Terra and Sol have ZDR only on Azure, Bedrock or Vertex, never through OpenAI or Anthropic directly.
- Every model in this plan does have a ZDR route, including the fast lanes (Kimi `moonshotai/highspeed`, Argon `google-vertex/global/priority`). Re-checked against the saved ZDR list on 2026-10-27.

---

## 1. The tier table

| | **Plus $10** | **Pro $50** | **Max $100** | **Ultra $200** |
|---|---|---|---|---|
| **Headline 1** | **Vector Remote:** watch, answer and steer your agents from your phone, with an alert when one finishes or needs you. No setup. *(Listed once shipped, about week 32.)* | **Brain Vault:** your Brain (memory, learned skills, workflow insights) and your sessions, backed up end-to-end encrypted. A new computer starts where you left off. *(About week 36.)* | **Cloud agents that know your repo:** close the laptop and get a PR. Runs start with your repo's approved learned skills and insights, on Codium with no keys, and the result comes back into the same conversation. Runs in your own repo, on your own Actions minutes. | **Vector Labs, the build the Vector team uses:** preview Codium models 30 days early (enforced at the gateway), each release a week early on the Labs feed (a real gate only if decision 15 signs the feed), switches and a feedback line for Labs features, and a Labs mark in the app. |
| **Headline 2** | **PR reviews in your GitHub, checked by a second lab:** Vectorscope reviews on Codium with no keys or secrets. A model from another lab confirms each finding. | **Two labs check each other, with Pro's judges:** with Second opinion on, Sol or Argon, from a different lab, checks every verified task (at launch). **Race** (free for everyone, about week 34) gets five labs to race and judge with on Pro, where Plus has three. | **Automations that keep running with your computer off,** in your own repo, on Codium, on your own Actions minutes. *(Week 26, one week after launch.)* | **Your feedback goes straight to the team:** Labs reports are tagged to the owner and read first. You can also put one candidate on the roadmap vote each quarter. |
| **Headline 3** | **Codium Brain:** Vector learns your repo on the plan with no keys. It drafts skills, learns from your corrections, reads your specs and PDFs, and gives a new repo a starting set. Everything waits for your review. | **Vector Playbooks:** multi-agent workflows the team maintains, such as a dependency sweep, a flaky-test hunt, docs drift and a deep review. Each shows its ceiling as a share of your month before it runs. *(Listed after two are proven, about week 37 or later.)* | **A vote on what Vector builds next:** a quarterly roadmap vote in Settings → Labs. The winning feature starts in the next release cycle, and anything it adds to the free workspace ships free. | **The most Codium agent time:** 3x Max's Codium agent hours, 6 runs at once and 2-hour runs, in your own repo, on your own Actions minutes. Plus 24 agents at once and no daily ceiling. |
| **Headline 4: models** | DeepSeek V4.1 Flash (default), Claude Haiku 5.5 and GPT-6 Luna: three labs, all ZDR, no keys. GPT-6.1 Terra too if decision 3 says yes. **Codium Auto learns which model passes your repo's checks** and keeps easy work on the cheapest one. | Everything in Plus, plus **GPT-6.1 Sol, Kimi K3.1 Pro and Gemini 4 Argon**, with 256K context | Everything in Pro, plus **Claude Sonnet 5.5, GPT-6 Astra and Sol Deep**, and fast lanes. **First access to Vector Velocity when it launches.** | Everything in Max, plus **Claude Opus 5.5, GPT-6 Astra Long (256K) and Sol Deepest**, and preview models. **First access to Vector Velocity when it launches.** |
| **Also included** (not headlines) | A higher report limit and a paid tag on reports, usage forecast, founding mark (founding window only) | Remote on 3 computers; Plus's reviews also on Sol and Argon; everything in Plus | Remote on 5 computers, which also lists your cloud runs; the three-lab review panel with Sonnet and Sol Deep; first in line when Codium is busy; reports read first; Settings → Labs | Labs pill and Labs app icon; the review panel with Opus and Sol Deepest; Labs live, if decision 11 says yes |
| **Usage, as a multiple of Plus** | 1x | 5.5x (10% more per dollar) | 12x (20% more per dollar) | 25x (25% more per dollar) |
| **Longest context** | 256K on Luna (DeepSeek 262K, Haiku 64K) | 256K (Kimi and Argon "Long") | 512K; Astra 128K | 768K; Astra Long 256K |
| **Codium agents at once** (of which Astra) | 3 | 6 | 12 (Astra 4) | 24 (Astra 8) |
| **Requests per minute** | 30 | 60 | 120 | 200 |
| **Daily ceiling** (share of the month per UTC day) | 25% | 25% | 40% | None |
| **Codium Brain share** (most of the month Brain helpers may use) | about 10% | about 10% | about 10% | about 10% |
| **Remote: paired computers** | 1 | 3 | 5, plus a list of your cloud runs | 5, plus a list of your cloud runs |
| **Brain Vault storage** (30 days of versions) | — | 10 GB | 25 GB | 50 GB |
| **Race on Codium** (Race is free for everyone; lanes are not a plan gate: racers count inside agents at once, and the judge must come from a lab no racer used) | Up to 2 lanes (three labs) | Up to 4 lanes (five labs) | Same as Pro | Same as Pro |
| **Cloud agents on Codium** (Codium runs at once / Codium agent hours a month / longest run; in your own repo, on your own Actions minutes) | — | — | 2 / 40 h / 45 min | 6 / 120 h / 120 min |
| **Scheduled runs on Codium** (computer off) | — | — | Up to 5 a day, inside the hours above | Up to 20 a day |
| **PR reviews on Codium** | Yes, with the internal per-review and per-PR stops | Same | Same; the optional panel can use Sonnet and Sol Deep | Same; the panel can use Opus and Sol Deepest |
| **Reports** (status and the "fixed in this version" notice are free for everyone) | Higher limit and a paid tag | Same | Read first | Read first, tagged to the owner |
| **When Codium is busy** | Waits and retries | Waits and retries | First in line, plus one automatic retry | Same as Max |

**At launch (week 25 if decision 5 picks the recommended option)**, each tier's page shows:
- **Plus:** headlines 2, 3 and 4. Remote joins at about week 32.
- **Pro:** Second opinion with Pro's judges, the extra reviews and the models. Vault and Playbooks join in weeks 35–37, and Race ships free for everyone at about week 34. **Pro is the thinnest tier at launch,** with one headline of Vector's own (decision 1).
- **Max:** headlines 1, 3 and 4. Automations join a week after launch.
- **Ultra:** all four headlines.

On this schedule, every perk that comes after launch is planned within about 13 weeks of launch, which is the 90-day founding window. Playbooks may land just after it, and the window closes early if it reaches 500 subscribers. So founding copy never promises a later perk.

**Every plan includes:**
- ZDR routing, no provider keys and no overage charges.
- **No top-ups.**
  - When the month is used up, Codium stops until it renews.
  - Your own keys, Vector Local and the free models keep working.
  - "Upgrade and keep what's left of this month" (item N) is available from launch.
- Usage shown only as a percentage, with a forecast. Codium steps say "Codium", never tokens or a price.
  - Brain helpers, Race and cloud time all show as shares of that same percentage.
  - Brain Vault shows gigabytes, which reveals nothing about the pool.

**Perks add and never take away.** These stay free for everyone:
- the desktop app and the CLI;
- your own keys and free models;
- memory, learned skills and workflow insights;
- subagents and workflows you write yourself;
- Vectorscope with your own key, including a `triageModel` pair you choose;
- automations;
- `vector serve`, `vector web` and `vector invite` with your own tunnel, which is Remote's do-it-yourself path;
- desktop notifications;
- `vector memory export` and `import`, which is Vault's do-it-yourself path;
- Run in GitHub, Continue in GitHub and `/vector` with your own keys (v2 decision 4).

These also become free for everyone:
- outbound webhooks to your own URL (flexibility-map gap 5);
- document distillation as a normal setting with your own model, instead of an environment flag, and "Bootstrap this repo" with your own model;
- Race, with your own keys or on any Codium tier;
- the report tracker: report status, the fixing commit and the "fixed in this version" notice;
- your repo's Brain in Run in GitHub and Continue in GitHub with your own keys, like the buttons themselves (v2 decision 4);
- the three-lab review panel and the "Checked by a second lab" line with your own keys.

**Every paid perk has a gate the server enforces** (review rule, 27 Oct): Codium models and their tiers, agents at once, the daily ceiling, Codium agent hours, the relay's paired-computer count, Vault quotas, Playbook downloads, the vote entitlement, report tags and preview models. Whatever the public client alone could switch on is free, as listed above. Labs features stay reachable through their `VECTOR_EXPERIMENTAL_*` variables, and the week-early builds are a soft gate until decision 15.

**Copy rules carried from v2:**
- Say "first", never "exclusive".
- Never say "every PR".
- Cloud agents always sit next to "runs in your own repo, on your own Actions minutes", and the page never says "hosted", "compute", "cloud capacity" or "cloud hours" about them.
- In GitHub, Vector sells only Codium inside the runs. The page says that Run in GitHub, Continue in GitHub, the Brain hand-off and the review panel also work free with your own keys (GitHub's terms, v2 §1b).
- Velocity gets only "first access when it launches": no date, no experimental builds, nothing in the terms that makes it part of today's purchase.
- A tagline names only perks that have shipped (see section 2).
- Pro and above get premium styling. Plus uses plain styling.

### 1a. GPT-6 Astra and the other model changes

| Entry | Tier | Context / reply | ZDR routes | Price ceiling per 1M (in / out) | Hold |
|---|---|---|---|---|---|
| **GPT-6 Astra** (`openai/gpt-6-astra`) | Max and Ultra | 128,000 / 16,384 | `azure` and `azure/us` | $13.75 / $55 | **$2.661** |
| **GPT-6 Astra Long** | Ultra | 256,000 / 32,768 | same | same | **$5.322** |
| GPT-6.1 Terra | Plus, if decision 3 says yes | 128,000 / 8,192 | `azure/eu` only | $1.50 / $6 | $0.241 (v1 said $0.201 using OpenAI-direct prices, which aren't ZDR) |
| Claude Sonnet 5.5 | Max | 200K / 16,384 | Bedrock; Vertex global, us and europe | $2.75 / $11 | $0.730 (unchanged) |
| Claude Opus 5.5 | Ultra | 200K / 32,768 | Bedrock global, eu-west-1 and us-east-1; Vertex global, us and europe | $5.50 / $22 | $1.821 (unchanged) |
| Sol / Sol Deep / Sol Deepest | unchanged | unchanged | Azure | $2.75 / $11 | $0.442 / $0.532 / $1.064 (unchanged) |

**Astra: what to know**
- **Hold formula.** A hold is the whole context at the input ceiling plus the longest reply at the output ceiling (`api/_lib/model-plan-config.ts:46-48`). The input ceiling is the regional cache-write price, $13.75. The gateway already sends `zdr: true`, `data_collection: "deny"` and a `max_price` taken from the catalog (`api/_lib/model-plan-chat.ts:148-153`). So a $13.75 / $55 ceiling keeps both Azure routes.
- **Route uptime.** Over the last day, `azure` was up 69.3% of the time and `azure/us` 93.5%. A $12.50 / $50 ceiling would leave only `azure`. Both routes are Azure, so there is no failover outside one vendor.
- **Cost.** Astra costs 2.5x Opus 5.5 per token and 5x Sol. On Max it is the most expensive model, and its hold is larger than Opus's hold on Ultra.
- **Why the "4 at once" cap.** Max's 40% daily ceiling is $28.80 of the $72 pool, and holds count against it. So at most 10 Astra requests fit at once at the start of a day. Without a cap, a 12-agent Astra workflow would be refused for "today's limit" while most of the day was still unused. The cap makes a fifth Astra request wait, the same way other in-flight caps do.
  - On Ultra, 8 × $5.322 = $42.58, which is 28% of the pool. Uncapped, 24 Astra requests would hold $127.73, or 85%.
- **Never picked for you.** Astra is never a Codium Auto role, never a default helper model and never a default judge. A subagent brief that names it needs your allow list (1.99.113 §0 E).
- **Picker note.** The model picker says Astra "uses your month fastest". It shows no figures.
- **Price step.** Both sizes stay under OpenAI's 272K price step. Set `promptTokenLimit: 272000` anyway, as Luna's entry does (`api/_lib/codium-catalog.ts:40-56`).
- **Tool choice.** Astra needs no special handling: the Azure ZDR routes support all four tool-choice modes. The Claude 5.5 ZDR routes take only `none` and `auto`, as Haiku does today.
- **Not a preview model.** Astra is promised to Max, so it skips Ultra's 30-day preview window (v2 §1a).
- **Astra Pro is not listed.** `openai/gpt-6-astra-pro` has the same price and routes, but OpenRouter warns it spends far more. It is in the same position as Sol Pro mode in v2: it could become a Labs preview after a CI benchmark.

**Terra:** a ZDR route appeared today, on `azure/eu`, for the 2026-10-26 snapshot. It is a single route, EU only, with no failover. If Terra is listed, it is an optional model only:
- not Plus's default;
- not Codium Auto's floor;
- never the Brain helper model.

### 1b. Labs and cloud agents

v2 §1a (Labs) and §1b (cloud agents, with GitHub Actions in your own repo, the OIDC binding, the hard caps, the GitHub bill and GitHub's terms) stand. v3 makes only these changes:
- **Your repo's Brain in cloud runs** (item Y).
  - A run starts with the repo's approved learned skills, its workflow insights and its shareable repo memories.
  - Skills it learns come back as drafts for your review.
  - It works with your own keys too, like Run in GitHub and Continue in GitHub (v2 decision 4). Max adds Codium inside the run. This keeps Vector selling only model access inside Actions (GitHub's terms) and keeps the hand-off from being a client-side gate.
  - It is opt-in, and only runs the owner starts from the desktop carry it. Runs started by a comment, a schedule or another person with write access carry no Brain.
  - On public repos, where Actions logs are public, procedures are left out and the app says so (self-evolving I8). On private repos that other people can read, the app says before the first run that those people can read the run's logs.
  - It sends Brain data off the computer, so it needs the same privacy rewording as Codium Brain (decision 8).
- **Remote** lists your cloud runs and their PRs on Max and Ultra. Watching and steering a running cloud agent from the phone is not part of v3. It waits for the legal read (decision 12) or for hosted sandboxes (decision 13).
- **Settings → Labs** (item X) is where Ultra's Labs switches, the roadmap vote and the Velocity line live. Report statuses stay in Settings → Account for everyone.
- **The priority queue for cloud agents** (a v3-changes candidate) is already covered by v2 item M. Cloud runs go through the same gateway and get the same "first in line" place.

---

## 2. Taglines, and why each tier is worth it

**Plus ($10): "No keys. Reviews on your pull requests, a Brain that learns your repo, and your agents on your phone."** Until Remote ships (about week 32), the tagline stops after "learns your repo".
- **Free Vector already does a lot.** Plus adds the parts that need a service:
  - Remote, with no tunnel or server to set up;
  - phone alerts;
  - automatic PR reviews in GitHub, with no keys or repo secrets, confirmed by a second lab;
  - Vector's learning helpers, without Vector Local or a key of your own;
  - models from three labs with ZDR, and an Auto mode that learns which one your repo needs.
- **Compared with other $10–20 plans:**
  - Copilot Pro bundles review at the same $10, but from one vendor (https://github.com/features/copilot/plans, read 2026-10-27).
  - Claude's Remote Control works only for Claude Code sessions with a subscription sign-in, not API keys (https://code.claude.com/docs/en/remote-control, read 2026-10-27).
  - Vector's Remote drives any model, including your own keys and Vector Local.
- No premium styling is needed.

**Pro ($50): "Your Brain kept safe, and two labs checking each other's work."** Until Vault ships (about week 36), the tagline is "Two labs checking each other's work, with Sol, Kimi and Argon."
- **Brain Vault.** Vector's Brain is local-first, so today a new laptop starts from zero. Vault removes that one drawback, and Vector can't read the backup.
- **Second opinion and Race** turn having several labs into a better result:
  - with Second opinion on, Sol or Argon from another lab checks each verified task. On Plus you can still pick a judge by hand, which is free; Pro's part is the judges themselves;
  - Race is free for everyone. On Pro it can race and judge across five labs instead of three, and you merge the best diff.
- **Playbooks** are tested multi-agent workflows that run only in Vector's workflow engine.
- **Models.** Sol, Kimi and Argon are included, at 5.5x Plus's usage for 5x the price.
- **Pro is the first tier with premium styling.**

**Max ($100): "Close the laptop. Agents that already know your repo keep working."**
- **Cloud agents that know your repo.** Max's cloud agents start with the same learned skills and insights your desktop sessions built and you approved, and they return to the same conversation. Scheduled automations keep running with your computer off. All of it runs in your own repo, on your own Actions minutes.
  - Don't say that other cloud agents "start cold". GitHub's Copilot Memory gives its cloud agent and code review repository memories, on by default for individual plans, in public preview (https://docs.github.com/en/copilot/concepts/agents/copilot-memory, read 2026-10-27). Vector's difference is that one Brain, which you review, is shared by your desktop, CLI and cloud runs, with no keys and across labs.
- **A vote on Vector's roadmap.** Only the company that builds the product can offer one.
- **Models.** Sonnet 5.5, Astra and Sol Deep, 512K context, first place in line when Codium is busy, and first access to Velocity when it launches.
- **An honest note.** Runs use your own Actions minutes. At the full 40 h on a private repo with GitHub Free, GitHub bills you about $2.40 (v2 §1b).

**Ultra ($200): "Vector Labs: build with the tool the Vector team uses to build Vector."**
- **You use the build the team uses.**
  - New Codium models arrive 30 days early. The gateway enforces this.
  - Each release reaches you a week before everyone else. Until decision 15 signs the Labs feed, that feed is public, so the page says "first" and never implies others can't get it.
  - Labs features get switches and a feedback line. Their `VECTOR_EXPERIMENTAL_*` variables keep working for everyone.
  - Your reports are tagged to the owner and read first.
  - You can put a feature on the roadmap vote.
- **Max's Codium agent time at three times the scale,** with no daily ceiling.
- **Models.** Opus 5.5, Astra Long and Sol Deepest, and first access to Vector Velocity when it launches.
- **Honest notes:**
  - Ultra gives less usage per dollar than the subsidised $200 plans (v1 §6).
  - On a private repo, the full 120 h costs about $31 a month at GitHub (v2 §1b).
  - Only say "the build the team uses" if you really run the Labs channel day to day.

---

## 3. Owner cost and margin per tier

The inputs are as in v2 §3:
- pools of $6 / $33 / $72 / $150;
- Stripe at 2.9% + 30¢, plus 0.7% Billing and 1.5% for international cards;
- OpenRouter's 5.5% fee (still unverified);
- the gateway upper bound of about 10.3¢ per pool dollar.

**New costs outside the pool:**
- **Remote relay (Cloudflare Durable Objects).**
  - Rates: duration is billed at 128 MB while an object is awake, at $12.50 per million GB-s. Incoming WebSocket messages count 20 to 1 toward requests, at $0.15 per million. Outgoing messages are free. Idle hibernating objects are not billed. Each month includes 1M requests and 400K GB-s, with a $5 minimum (https://developers.cloudflare.com/durable-objects/platform/pricing/, updated 2026-10-18, read 2026-10-27).
  - Cost per hour: an awake relay is about 461 GB-s an hour (Cloudflare counts 128 MB as 0.128 GB), so about $0.006 an hour.
  - Messages: the desktop's stream into the relay is incoming, so it is billed. If it batches events to a few messages a second, messages add under 5% to the duration cost. Sending every token delta (around 50 a second) would add about 23%. Batching is a design rule.
  - Design rules that keep it near the typical figure: the desktop streams only while a phone is attached, it batches events, and the relay closes viewers idle for 30 minutes.
  - Figures used: typical 10–20 viewer-hours ($0.06–0.12, rounded to $0.10) on Plus and Pro, and twice that on Max and Ultra ($0.20), which pair more computers. Upper bound 60 / 100 / 200 / 200 viewer-hours by tier ($0.36 / $0.60 / $1.20 / $1.20).
- **Phone alerts (Web Push):** delivery is free, and the Vercel function calls cost under 1¢ per user.
- **Brain Vault (Cloudflare R2):**
  - Rates: $0.015 per GB-month, Class A operations $4.50 per million, free egress, and 10 GB-month free per account (https://developers.cloudflare.com/r2/pricing/, updated 2026-10-26, read 2026-10-27).
  - Full quota: Pro $0.15, Max $0.38 and Ultra $0.75, plus about $0.05 for roughly 10K writes.
  - Typical users store under 1 GB, which costs about 2¢.
- **Labs downloads:** $0.02 per Ultra user, as in v2.
- **Paid from the pool, $0 outside it:**
  - every model use, including Astra, Brain helpers, Auto, reviews and the panel, Race and Playbooks;
  - cloud agents, whose compute is your Actions minutes;
  - the Brain artifact for cloud runs, which is a few KB.

  Astra does not raise the gateway bound. The bound is per pool dollar, and cheap models set it, because expensive models stream fewer hours per dollar.
- **$0 cash:** the report tracker, the roadmap vote, Settings → Labs and founding marks, which are only a few rows in the existing Redis store.

| Per subscriber per month | Plus $10 | Pro $50 | Max $100 | Ultra $200 |
|---|---|---|---|---|
| **Typical** (60% of the pool used, domestic card): v2 profit after the gateway and Labs downloads | $5.17 | $24.98 | $46.08 | $88.28 |
| Remote relay, typical | −$0.10 | −$0.10 | −$0.20 | −$0.20 |
| Phone alerts | −$0.01 | −$0.01 | −$0.01 | −$0.01 |
| Brain Vault, typical (under 1 GB) | — | −$0.02 | −$0.02 | −$0.02 |
| **Typical profit, v3** | **$5.06 (51%)** | **$24.85 (50%)** | **$45.85 (46%)** | **$88.05 (44%)** |
| Typical, founding member | $4.65 (47%) | $22.55 (45%) | — | — |
| **Full use** (100% of the pool used, international card): v2 profit after the gateway and Labs | $2.24 | $8.94 | $11.24 | $15.81 |
| Remote relay, upper bound | −$0.36 | −$0.60 | −$1.20 | −$1.20 |
| Phone alerts | −$0.01 | −$0.01 | −$0.01 | −$0.01 |
| Brain Vault at full quota | — | −$0.20 | −$0.43 | −$0.80 |
| **Full-use profit, v3** | **$1.87 (19%)** | **$8.13 (16%)** | **$9.60 (10%)** | **$13.80 (7%)** |
| Full use, founding member | $1.18 (12%) | $4.31 (9%) | — | — |
| Fraud (pool used, dispute lost, hosted lines at full) | −$23.13 (founder −$23.82) | −$56.87 (founder −$60.69) | −$105.40 | −$201.20 |

**Fixed monthly costs (not per subscriber):**
- **Cloudflare Workers Paid, $5 a month.** It includes about 870 relay viewer-hours, roughly the first 14 heavy Remote users, and R2's 10 GB-month free.
- **Owner time, about 7–15 hours a month:**
  - Labs release routine: 1–2 h a week;
  - tagging fixed reports: about 1 minute each;
  - the roadmap vote shortlist: 1 h a quarter;
  - Playbook upkeep: 2–3 h a month, after about 1 day per new playbook;
  - optionally, Labs live: about 1.5 h a month.

**What this means:**
- **Typical margins barely move,** by 1 point at most.
- **Full use is thinner.** Ultra goes from 8% to 7%, Max from 11% to 10%, Pro from 18% to 16% and Plus from 22% to 19%. Every tier stays positive.
  - The biggest new line is the relay's upper bound. The attach-only streaming and the idle close are what keep real use near the typical figure.
  - v2's rule still applies: do item Q (1 GB function memory, gzip) and measure the first month before adding anything else to Ultra that costs money outside the pool.
- **Removing top-ups changes no row above,** because the monthly figures never included top-up sales. What goes is the second revenue line: in the heavy case a top-up kept 29–32% (v2 §3), better than Max or Ultra at full use.
- **Fraud is still the only losing case.** 3-D Secure on first purchases of $100 or more, and pausing the key on a Stripe early-fraud warning, are still required before launch. Remote's per-account caps and Vault's quotas keep the hosted lines small even then.
- **Hosted sandboxes, if they are added later** (decision 13):
  - at caps of 20 h on Max and 60 h on Ultra, with 50% CPU, they cost about $4.66 and $13.97 at full use (vercel.com/docs/vercel-sandbox/pricing, read 2026-10-27);
  - charged to the pool at list price, they cost $0 outside it, apart from snapshot storage (about $0.40–1.20).

---

## 4. What must be built, and in what order

v2 items A–Q stand, with three changes:
- **G (Premium on demand) is deleted.**
- **N (upgrade carry-over) moves before launch.** The "pause one month" part can stay after launch.
- **O (founding members) grows,** as described at the end of this list.

New items are lettered R onward. Every test runs in CI, not on this Mac while Vector is open.

**R. GPT-6 Astra and Terra in the catalog.** 1–2 days, alongside I and J.
- **Already exists:**
  - catalog entries in `api/_lib/codium-catalog.ts`; Luna's entry (`:40-56`) is the template: `promptTokenLimit: 272000`, the regional cache-write ceiling, `cacheStyle: "openai"` and `max_completion_tokens`;
  - the ZDR and price-ceiling routing (`api/_lib/model-plan-chat.ts:148-153`);
  - the hold (`api/_lib/model-plan-config.ts:46-48`).
- **To build:**
  - Two Astra entries, Astra (Max and up) and Astra Long (Ultra), at $13.75 / $55. Each gets `promptTokenLimit: 272000`, v1's `minPlan` field, and v1's `upstream` field limited to `azure` and `azure/us`.
  - A Terra entry on `azure/eu`, only if decision 3 says yes.
  - A per-entry in-flight limit, next to the per-account counter: Astra 4 on Max and 8 on Ultra.
  - Astra gets no Auto role and no default judge pairing.
  - A task range for Astra in `CODIUM_TASK_RANGES` (`model-plan-config.ts:234`) only after a reviewed estimate. Until then the entry has none.
  - Update the catalog audit fixture and `CODIUM_CATALOG_UPDATED`.
  - Run the CI benchmark before any quality claim.
  - Re-check the routes in the release week.

**S. Remove top-ups (replaces G).** 1–2 days, folded into v1's steps.
- **Already built, never sold:**
  - the checkout route (`api/model-plans/topup.ts` → `handleModelTopupCheckout` in `api/_lib/model-plan-billing.ts`);
  - the packs (`TOPUPS` in `packages/schema/src/codium-plan.ts:14-19`);
  - `modelTopups` and `requireModelTopups` (`api/_lib/model-plan-config.ts:82-93, 168`) and the public offers (`:186-190, 228`);
  - the purchased-credit fallback once the month is used (`api/_lib/model-plan-account.ts:612-626`) and its ledger (`:141-430`);
  - the purchased state in status (`api/_lib/model-plan-status.ts:42-60`);
  - the pricing page's Top-ups tab and its "Top-ups when credits run low" row (`packages/web/src/components/marketing/codium/CodiumPricing.tsx:8, 16, 166, 258-320`);
  - the app's purchase screens (`packages/app/src/components/codium-purchase.tsx`, `codium-billing.ts`, `settings-vector-codium.tsx`);
  - the terms (`packages/web/src/pages/legal/terms.astro:49-54`), the privacy page and `docs/vector/MODEL-PLANS.md`;
  - also missed by the first draft of this list (found with `git grep -i 'topup\|top-up\|purchased'` on `f2b66f63`):
    - the webhook's `reconcileModelTopup` (`api/model-plans/webhook.ts:2, 42`) and the pack lookups in `api/_lib/codium-ledger.ts:214` and `model-plan-account.ts:267, 1132`;
    - the funding check, which sizes its largest sale from `modelTopups()` (`api/_lib/codium-funding.ts:139`);
    - the CLI's purchased state (`packages/core/src/model-plan-status.ts:38-68`);
    - the account page (`packages/web/src/lib/model-plans.ts`, `packages/web/src/components/marketing/account/ModelPlans.tsx`);
    - the Codium page's description and `?type=topups` mode (`packages/web/src/pages/codium.astro:21-24`), `codium-pricing.ts` and `codium-pricing.css`;
    - the desktop's `model_topup` checkout return (`packages/desktop/src/main/billing-navigation.ts:75-86`) and `vector-account.ts`;
    - the Stripe setup script that creates top-up products (`packages/web/scripts/setup-model-plans.ts:17, 24, 76`), the `STRIPE_MODEL_TOPUP_*_PRICE_ID` lines in `.env.example`, and `codium-economics.ts`;
    - `packages/web/src/pages/docs/troubleshooting.astro:55` ("this month's or purchased"), `docs/vector/owner-actions/codium-payments.md` and `openrouter.md`.
- **To build:**
  - Empty `TOPUPS`, and delete the checkout route, the fallback and the purchased state.
  - Remove the tab, the pricing row and the "buy more" buttons.
  - In the terms, cut "One-time top-ups…" and keep "no overage charges".
  - At 100%, the app says when the month renews and offers three choices: your own key, a free model, or an upgrade that keeps what's left (N).
  - Drop v1's planned daily-ceiling fallback to top-ups and its `none` entitlement for top-up-only accounts.
  - Update the tests (`model-topups-api.test.ts`, `CodiumPricing.test.ts` and others) in CI.
  - **Done when** that `git grep` finds nothing but OpenRouter's own auto top-up of the owner's balance (`codium-funding.ts:10`) and the free-model note about a user's own OpenRouter account (`packages/core/src/free-model-choice.ts:89`).
  - Sales never opened, so no one holds purchased credits that would need honouring.

**T. Codium Brain helpers.** 1–1.5 weeks, after the self-evolving build ships.
- **Already exists (evolve):**
  - the drafter setting, off / local-only / always (`packages/core/src/brain/schema.ts:121`), which defaults to local-only (`packages/core/src/brain/brain.ts:1329`);
  - the drafter gate `drafts()` (`packages/engine/src/session/skill-learn.ts:51-65`);
  - the corrections learner's gate, which needs Vector Local unless it is set to always (`packages/engine/src/session/prompt.ts:3081`);
  - quote-locked distillation, 30K tokens in and 4K out, behind `VECTOR_KNOWLEDGE_DISTILL` (`packages/core/src/brain/distill.ts:13-31`);
  - the Codium provider (`packages/core/src/plugin/provider/vector-plan.ts`).
- **To build:**
  - **The switch.** One switch, "Use Codium for Brain helpers". The app asks once after you subscribe, and it never turns on by itself, so "Vector never picks a Codium model by itself" holds.
  - **Gates and model.** When the switch is on, both gates accept a ZDR Codium floor model (Luna or DeepSeek) under local-only. They never use Terra or Astra.
  - **Brain share.** Requests carry the purpose "brain", and the gateway caps them at about 10% of the month.
  - **Distillation** becomes a normal setting for everyone, with your own model or Codium.
  - **"Bootstrap this repo".** A button that reads the repo's docs, distils them and sends the proposals to the review queue. It works with your own model too (decision 10). Codium only removes the need for a key.
  - **Privacy wording.** Reword self-evolving §14 statement 1 and I13 for this opt-in (decision 8).

**U. Codium Auto that learns your repo.** 1–1.5 weeks, on top of v2 item F.
- **Already exists:**
  - per-message routing (`packages/app/src/utils/task-intelligence.ts:144`, called at `packages/app/src/components/prompt-input/submit.ts:794`);
  - BrainWorkflow's rule: at least 6 checked runs, within 0.1 of the default's pass rate, and at least 20% cheaper (`packages/core/src/brain/workflow.ts:24-28`, evolve).
  - **The gap:** Codium steps carry no price (`draft.cost = []`, `packages/core/src/plugin/provider/vector-plan.ts:36`). Their runs therefore store an unknown cost (I12), and the options can't be compared.
- **To build:**
  - **A hidden weight.** A hidden relative weight for each entry in the tier-filtered models list (`api/_lib/model-plan-models.ts`), taken from public price ratios and never from the pool. It is recorded as a `codium` cost kind.
  - **Comparison.** BrainWorkflow compares Codium options in those units.
  - **Choosing.** Auto chooses among the floor, default and ceiling roles by the same rule, and Astra is never a role.
  - **Explanations** show percentages, such as "used about 40% less of this step", never tokens.
  - **Ceilings.** The same units let Race and Playbook ceilings show as a share of the month. The gateway converts units into that percentage, so the app never holds the pool in units. Units that track public prices would otherwise let anyone work out the private pool in dollars.

**V. PR reviews checked by a second lab.** 2–3 days, on top of v2 items B and H.
- **Already exists:** the triage model and the confirm pass (`packages/engine/src/review/run.ts:179-182, 541`; `packages/core/src/review/config.ts:103, 192-194`). Every finding from the cheaper pass is double-checked on the review model.
- **To build:**
  - **Cross-lab pairs.** On Codium, triage and review run on models from different labs, using H's judge pairing.
  - **Summary line.** The review summary says "Checked by a second lab".
  - **Panel.** An optional three-lab panel: a triage pass, a review pass and a judge, each from a different lab. The panel mode and the "Checked by a second lab" line also work with your own keys. Inside Actions, Vector sells only the Codium models (GitHub's terms), and a client-side mode can't be a paid gate. On Codium, Max's panel uses Sonnet and Sol Deep, and Ultra's uses Opus and Sol Deepest. Lower tiers can build a panel from their own models.
  - **Astra security pass.** Only when you choose it. At the price ceiling, a 50K-in, 2K-out pass costs about $0.80 of the pool on Astra, against $0.32 on Opus and $0.16 on Sonnet.
  - **Limits.** Reviews stay inside the 400K-per-review and 2M-per-PR stops.

**W. Report tracker.** 3–5 days.
- **Already exists:**
  - `api/support/bug-report.ts` emails the owner, returns only the email id (`:122`) and allows 5 reports per hour per IP (`:60`);
  - the desktop sends `channel: process.env.VECTOR_CHANNEL || "prod"` (`packages/desktop/src/main/bug-report.ts:24`) and discards the id;
  - the release-notes dialog reads `changelog.json` (`packages/app/src/context/highlights.tsx:11`), which `packages/web/scripts/build-changelog.ts` builds;
  - the Redis store (`api/_lib/persistent-store.ts`).
- **Free for everyone.** The "fixed" notice compares report ids the desktop keeps with a public changelog, so the client alone could switch it on. The tracker therefore ships free. The paid parts are only the ones the server checks: the plan tag, the higher limit, and read-first triage on Max and Ultra.
- **To build:**
  - **Report records.** A random report id and its status, kept with a retention limit.
  - **Account tag.** An optional account token on reports, giving a plan tag and a higher limit for paid accounts.
  - **On the desktop.** The desktop keeps your report ids.
  - **Fixed list.** The changelog lists hashed ids of the reports each release fixed.
  - **Notice.** The what's-new dialog says "A problem you reported is fixed in this version".
  - **Status page.** Settings → Account shows each report's status with the fixing commit.
  - **Labs.** A `labs` marker on reports from Labs builds.
  - **Owner script.** A short script for the owner to set a report's status.
  - **No response time.** Nothing promises a response time.

**X. Roadmap vote and Settings → Labs.** 1–2 weeks, on top of v2 item K.
- **Already exists:**
  - the plan in status (`api/_lib/model-plan-status.ts`);
  - the sidebar chip (`accountChip`, `packages/app/src/vector-account.ts:63`);
  - the beta artwork (`packages/desktop/icons/beta`).

  The Labs channel itself stays the normal app (v2 §1a). It doesn't use the separate beta app id (`packages/desktop/electron-builder.config.ts:62`).
- **To build:**
  - **Entitlements.** `labs` and `vote` entitlements in status.
  - **Votes.** One vote per account, kept in the Redis store. Results show only after a minimum turnout. A winning feature that touches the free workspace ships free.
  - **The settings page.** A Settings → Labs page that shows only the sections that have content: the vote, Ultra's Labs switches, the Velocity line ("first access when it launches", nothing more), and Labs live if decision 11 says yes.
  - **Signed Labs feed, if decision 15 says yes.** About 2–3 days, in K. Status gives `labs` accounts a short-lived signed feed link, which the updater applies through `setFeedURL`. Beta builds then stop publishing to the public `releases/vector-beta-updates` feed. The owner's internal Vector Beta app needs its own way to read the feed.
  - **Labs mark.** On the Labs feed, a Labs pill next to the plan name and the Labs Dock icon on macOS. Both go back to normal on stable.

**Y. Your repo's Brain in cloud runs.** About 1 week, after v2 item D and the self-evolving build.
- **Already exists:**
  - v2 A.2 and D's encrypted per-run artifact;
  - session import (`packages/engine/src/cli/cmd/pr.ts:16-109`);
  - `BrainSkill.shareable` (`packages/core/src/brain/skill.ts:1822`, evolve), which passes only active, user-approved, non-private skills;
  - imports that wait for review (self-evolving §5.8).
- **To build:**
  - **What travels.** Pack shareable skills, workflow-insight rows without costs, and repo memories that pass the posting check into the artifact.
  - **In the run.** The cloud CLI loads them read-only, for an owner-only session.
  - **What comes back.** New drafts return as imports for review.
  - **Public repos.** Leave procedures out and show a warning (I8).
  - **Who and when.** It is opt-in per repo, and only desktop-started runs carry it. It works with your own keys as well as on Codium (1b).

**Z. Vector Remote.** 3–5 weeks, plus an outside security review, after 1.99.113's helper states.
- **Already exists:**
  - the engine HTTP API: the event stream, permission answers, questions, sessions and control (`packages/engine/src/server/routes/instance/httpapi/groups/event.ts`, `permission.ts`, `question.ts`, `session.ts`, `control.ts`);
  - `vector web` (`packages/engine/src/cli/cmd/web.ts`);
  - the desktop task relay, which already combines parallel workspaces and swarms (`packages/desktop/src/main/task-relay.ts`);
  - keep-awake (`packages/desktop/src/main/keep-awake.ts`).
- **To build:**
  1. **The relay.** A Cloudflare Worker with one Durable Object per account, using WebSocket hibernation. It forwards only encrypted data.
  2. **The desktop side.** A main-process module that connects out to the relay and passes an allowlist of routes to the local engine.
  3. **Pairing and safety.**
     - QR pairing, with the keys kept on the devices.
     - A passkey check before you approve a permission from the phone.
     - A device list with revoke, and a kill switch.
  4. **The phone app.** A web app at vectordev.ai/remote that you can add to your Home Screen. It is `packages/app` in a remote mode, with a manifest and a service worker. Today the site has only `packages/web/public/site.webmanifest`.
  5. **Limits.** The relay enforces the paired-computer count against the account's plan, and refuses a pairing over it. The app only displays the count, so a patched client can't pair more.
  6. **Streaming.** The desktop streams only while a phone is attached, and viewers idle for 30 minutes are closed.
  7. **Keep-awake.** A rule to stay awake while a paired phone watches. Today keep-awake lets the computer sleep while a prompt waits on you (`keep-awake.ts:21-23`), and closing the lid always sleeps it.
  8. **Cloud runs.** On Max and Ultra, a list of your cloud runs, taken from the gateway's run-token records.
- **Must hold:** Remote must never widen the local permission rules, and it stays owner-only (no team or guest use).

**AA. Phone alerts.** About 1 week, after Z's web app.
- **Already exists:**
  - local notifications only (`packages/desktop/src/main/tray.ts:101-110`, `packages/desktop/src/main/ipc.ts:924-926`);
  - the events: 1.99.113's "waiting" and "interrupted" notes, Run Guard's warning at 80% (`WARN_AT`, `packages/core/src/spend-guard.ts:26`), and the usage percentage.
- **To build:**
  - **Push service.** VAPID keys, plus `POST /api/notify/subscribe` and `/api/notify/send`, rate-limited with `api/_lib/abuse.ts`.
  - **Settings.** Settings → Notifications, with a switch for each event and quiet hours.
  - **Contents.** Alerts carry titles only, with no repo names by default.
  - **No email at launch.**
- **Free for everyone, separately:** outbound webhooks to your own URL.

**AB. Race.** 1.5–2 weeks, after 1.99.113's per-brief model, worktree isolation and workflows (§0 E, F, G).
- **Already exists:** the 1.99.113 contract, the judge on its own model (`packages/engine/src/session/prompt.ts:760-761`), and the recommender (`packages/app/src/features/economics/economics-recommender.ts`).
- **To build:**
  - **Starting a race.** A Race entry in the composer. It builds a one-stage workflow with one racer per lab, each in its own worktree.
  - **Judging.** A judge from a lab none of the racers used.
  - **Comparing.** A side-by-side view in the Tasks pane.
  - **Plan card.** Before the race starts, a card shows "about N× a normal task": as a share of the month on Codium (U's units), or as the usual cost estimate with your own keys.
  - **Learning.** Results feed the recommender and BrainWorkflow.
  - **Limits.** Racers count toward agents at once. External agents never race.
  - **Free for everyone.** Race works with your own keys and on every Codium tier (decision 10). Any user could build the same one-stage workflow by hand, so a tier gate on Race would be a client-side gate. The number of lanes comes only from the tier's labs (the judge's lab must differ from every racer's) and its agents at once.

**AC. Brain Vault.** About 2 weeks, plus the legal read.
- **Already exists:**
  - brain.db, shared by the latest, beta and prod builds (`packages/core/src/brain/database.ts:80-96`);
  - `vector memory export` and `import` (`packages/engine/src/cli/cmd/memory.ts:268, 290`; `packages/core/src/brain/export.ts`);
  - session export and import (`packages/engine/src/cli/cmd/export.ts`, `import.ts`);
  - signed uploads and erase on account deletion (`api/_lib/public-shares.ts`).
- **To build:**
  - **Encryption.** A key kept on your device, with a printable recovery code.
  - **Storage.** An R2 bucket keyed by account, holding only encrypted data.
  - **Snapshots.** A nightly snapshot, a list of versions, and delete.
  - **Restore.** Always through import, never a raw brain.db copy, because migrations have no forward guard (`packages/core/src/database/migration.ts:43-80`).
  - **Erase.** Account deletion erases the vault.
  - **Uploads.** `api/vault/*` with signed URLs. The API checks the plan's quota before it signs an upload.
  - **Settings.** Settings → Memory → Backup.
  - **Sync between computers** comes later.

**AD. Vector Playbooks.** About 1 week of plumbing after 1.99.113's workflows, then about 1 day per playbook.
- **Already exists:**
  - saved workflows from `{workflow,workflows}/*.json`, and `vector run --workflow` (multiagent spec §5.G);
  - remote skill indexes fetched with no sign-in (`packages/core/src/skill/discovery.ts:127`);
  - the prompt guard's hold on changed prompt files (self-evolving §8.3).
- **To build:**
  - **Delivery.** `GET /api/account/playbooks`, which returns short-lived signed links by plan.
  - **Installing.** Install into your config's `workflows/` folder, with names that start with `vector-`.
  - **Model choice.** Codium role names (`codium:floor`, `codium:default`, `codium:ceiling`) that each tier resolves to its own models.
  - **Ceilings** shown as a share of the month (U's units).
  - **Safety check.** A CI check that every command in a playbook passes the skill command allowlist.
  - **Listing.** List Playbooks only after two of them are proven.

**O, extended. Founding marks.** 2–3 days more.
- Your member number, shown only to you.
- An opt-in founders page and README badge with a random link (`api/_lib/social-card.ts`, `api/og.ts`).
- The founding mark in the sidebar chip.

**Guided setup** (onboarding, not a listed perk). 4–6 days.
- A `/setup` flow that works free with your own keys. On Codium it needs no keys.
- Every change to the repo shows a diff and asks first.
- It builds on `packages/app/src/features/onboarding/` and "Set up automatic reviews" (`packages/desktop/src/main/github-pr.ts`).

**Order of work.**
- These are sums of the item estimates, in 5-day weeks, and they leave out 1.99.113's own work.
- Before launch: v2's 13–19 weeks, plus 7–10 weeks of v3 work (S, R, N, the O extension, V, T, U, W, X and Y). That is 20–29 weeks, planned at week 25.
- After launch: about 12–13 weeks. That is about the length of the 90-day founding window, but Playbooks may land just after it, and the window closes early at 500 subscribers.

| Weeks | Work |
|---|---|
| 1–4 | v1 steps 1–8, with S (no top-ups) folded in |
| 5–7 | I (long context), J (Claude models), R (Astra and Terra), M (priority), Q (cost guard), K (Labs) |
| 8–11 | F (Auto), H (Second opinion), L (forecast), N (upgrade carry-over, now before launch), O (founding, with marks), P (page and terms) |
| 12–14 | A (Codium in GitHub), B (Plus reviews) with V (second-lab check), npm CLI release |
| 15–17 | C (Run in GitHub), D (Continue in GitHub, once 1.99.113 ships) |
| 18–21 | T (Codium Brain), U (Auto that learns), W (report tracker) |
| 22–24 | X (vote and Settings → Labs), Y (Brain in cloud runs) |
| 25 | v1 step 9: a Stripe test-mode run, a load check at Ultra's limits including Astra's holds, the legal read, then open sales |
| 26 | E (automations with your computer off) |
| 27–32 | Z (Remote) with its outside security review, then AA (alerts) |
| 33–34 | AB (Race) |
| 35–36 | AC (Brain Vault), once the legal read covers stored data |
| 37+ | AD (Playbooks: plumbing, then two proven playbooks), guided setup |

---

## 5. Decisions only the owner can make

1. **Headlines.** Approve the four headlines per tier in section 1.
   - Race is now free for everyone (AB), so moving it before launch no longer helps Pro.
   - Pro launches with one headline of Vector's own: Second opinion with Pro's judges.
   - The only way to give Pro a second at launch is to build Vault (AC, about 2 weeks) before launch. That needs the legal read to cover stored data by week 25.
2. **Astra.** Approve:
   - Astra on Max at 128K / 16,384 and Astra Long on Ultra at 256K / 32,768;
   - both Azure ZDR routes, at a $13.75 / $55 ceiling;
   - 4 Astra at once on Max and 8 on Ultra;
   - never an Auto role or a default helper;
   - Astra Pro not listed.
3. **Terra.** List it on Plus now, on its single EU route with no failover, or wait for a second ZDR route. My pick: list it as an optional model only, not the default, not Auto's floor and never the Brain helper.
4. **With no top-ups, what happens at 100%.** Approve: Codium stops until renewal, your own keys and free models keep working, and an upgrade keeps what's left (N before launch).
5. **Launch timing.**
   - **Week ~25 (recommended):** v2's set, plus Codium Brain, Auto that learns, second-lab reviews, the report tracker, the vote, Settings → Labs and Brain in cloud runs. Remote, alerts, Race, Vault and Playbooks land in weeks 26–37, inside the founding window.
   - **Week ~31:** also wait for Remote and alerts, so Plus launches with its strongest perk.
   - Both slip if 1.99.113 or the self-evolving build slips.
6. **Remote.** Approve:
   - Cloudflare as a new vendor ($5 a month);
   - the security design: end-to-end encryption, a passkey check before approvals, device revoke and a kill switch;
   - an outside security review before it is listed;
   - 1 / 3 / 5 / 5 paired computers.
7. **User data on Vector's servers.** Brain Vault would be the first user data stored on Vector's servers, although it is encrypted and unreadable to Vector. Approve a legal read and a privacy-policy update. The zero-storage alternative is an encrypted backup into a private GitHub repo the user owns.
8. **The privacy default for Codium Brain.** Approve rewording I13 and self-evolving §14 statement 1 for subscribers who switch it on, and the roughly 10% Brain share.
   - Statement 1 says learned skills and insights are "stored only in brain.db on this computer", and Vector "sends them nowhere".
   - Brain in cloud runs (Y) and Brain Vault (AC) also send Brain data off the computer. Both are opt-in, and Vault is encrypted. The rewording must cover all three, not only Codium Brain.
9. **Auto switching models.** Approve Codium Auto choosing the main model per message from your repo's results. The self-evolving non-goal "the primary model is never switched automatically" then applies everywhere except inside Auto, which the user picked.
10. **What stays free with your own keys.**
    - Free (applied in this plan): Race, `/setup`, outbound webhooks, distillation, "Bootstrap this repo", the model drafter with your own model, the report tracker, the review panel, and the Brain in Run and Continue in GitHub. Each of these could be switched on in the client alone, so selling any of them would put a client-side gate on a paid perk.
    - My pick for paid: the Playbooks library content and the hosted services.
    - Gates in public code are soft, so the page says "maintained" or "first", never "exclusive".
11. **Owner time.**
    - Commit about 7–15 hours a month (section 3).
    - Decide on Labs live: a 30-minute monthly demo for Ultra, recorded for Max, about 1.5 hours a month.
    - Don't offer monthly 1:1 calls to every Ultra member, the v3-changes candidate. That would be about 17 hours a month at 50 members.
12. **Legal read** (v2 decision 3). It now also covers:
    - Remote controlling a computer;
    - Vault storage;
    - how long reports are kept;
    - live steering of Actions runs, before that is ever offered.
13. **Hosted sandboxes** (v2 decision 2). Still after launch, funded by sales. If they are added, charge their time to the pool at list price. The same sandboxes would then carry hosted PR reviews and live cloud agents.
14. **Still open from v2:**
    - the pools, Argon, the daily ceilings, a $20 tier, and Run Guard's 40-unpriced-step rule;
    - decision 8 (the founding offer), 9 (old tokens) and 12 (rollover, money-back and yearly billing after sales data). Yearly billing would end "monthly plans only", so it needs your explicit yes. It is not a top-up;
    - decision 13 (the cloud-agent name) and 14 (the Velocity wording). On 14, this plan now uses only "first access when it launches" on Max and Ultra. "Experimental builds through Labs" has been removed.
15. **The Labs feed.** Today the beta feed is public, so anyone can take a release a week early. That makes "a week early" a perk that can be switched on for free.
    - **Option 1:** sign the feed (about 2–3 days, item X).
    - **Option 2:** keep it as a soft gate, always worded as "first".

    My pick is Option 1. Without it, Ultra's Labs headline rests on preview models alone.

    **Now closed:** decision 5 (Sonnet and Opus, accepted 27 Oct), decision 7 (top-ups paying for Pro models) and the top-up part of decision 11.

---

## 6. Perks dropped (one line each)

- **Premium on demand (v2 G):** removed along with top-ups.
- **Top-up packs at 55% (v1 §5):** removed; the plans are monthly only.
- **Students get Pro models at the Plus price:** still dropped. Its fallback, premium on demand, is gone too.
- **Hosted Vectorscope:** it needs sandboxes and means holding private clones, while v2's Actions reviews already cost $0 in compute. Revisit with decision 13.
- **Hosted cloud agents in Vector sandboxes:** after launch, funded by sales (decision 13).
- **Live steering of GitHub cloud runs:** it sharpens the GitHub-terms question. Wait for Remote and the legal read.
- **Laptop-off automations on a hosted scheduler:** v2 item E already delivers this through Actions at $0.
- **PR preview checks:** niche, a cost outside the pool, and a phishing risk from live previews.
- **Cloud connectors:** a vault of refresh tokens is a breach target, and every provider's OAuth app needs upkeep.
- **Cloud browser:** a commodity with shared-IP abuse risk. Bring the browser agent to `vector serve` for free instead.
- **Vector Box (a personal cloud workspace):** a fixed disk cost on Ultra's thin margin, and it overlaps cloud agents plus Remote.
- **Cloud burst for workflows:** needs hosted agents first, few users go past local limits, and it uploads uncommitted code.
- **Codium Search (research everywhere):** it reverses the 23 Oct "no search service" decision, resellers already sell search, and ZDR doesn't cover search.
- **Skills across repos:** the suggestion has to be free, the paid part is too thin, and an all-repo scope is a self-evolving non-goal.
- **Codium-tuned prompts as a perk:** buyers can't see it, and it has a fixed eval cost. Do it as normal engineering.
- **Labs prompt canaries:** a new telemetry flow, worse sessions for top payers, and the harness isn't built.
- **The Build Log as a paid letter:** publish it free with each Labs release instead.
- **Labs Bench:** about $25 a month of fixed eval cost, plus licence risk from submitted code.
- **Members' space:** an empty room below about 30 members, with weekly moderation. Revisit later.
- **Cosmetics, theme packs and keybind packs:** nobody pays for them. Unhide the sound picker and shortcut editor for everyone instead.
- **More Brain capacity on paid plans:** charging for rows in your own local database is an artificial cap. Raise the limits for everyone if they hurt.
- **A monthly 1:1 call for every Ultra member:** founder time doesn't scale. Labs live replaces it (decision 11).
- **Email alerts at launch:** Resend's free tier of 100 a day is shared with purchase emails. Web Push is enough.
- **Astra Pro mode:** spends far more. Possibly a later Labs preview, after a CI benchmark.
- **Guided setup as a listed perk:** built as onboarding instead.

---

## 7. What the 27 Oct review changed

1. **Client-side gates removed.** These are now free for everyone: Race, the report tracker's status and "fixed" notice, the review panel mode, "Bootstrap this repo" with your own model, and the Brain in Run and Continue in GitHub with your own keys. Each paid perk now names its server-side gate: the relay's computer count, Vault quotas checked before signing, and the gateway's units-to-percent conversion. The week-early Labs feed is public, so it is either signed or worded as a soft gate (decision 15).
2. **GitHub's terms.** Inside Actions, Vector again sells only Codium: the Brain hand-off and the panel work with your own keys. "The most cloud capacity" became "the most Codium agent time … in your own repo, on your own Actions minutes".
3. **Velocity.** "Experimental builds through Labs once they exist" was removed from Ultra's headline and tagline. Only "first access when it launches" remains.
4. **Promises before shipping.** Plus's and Pro's taglines drop Remote and Vault until those ship. "Every post-launch perk lands inside the founding window" was softened: Playbooks may land just after it, and the window can close early.
5. **Competitor claim.** "GitHub's $10 cloud agent starts cold every run" was wrong. Copilot Memory gives that agent repository memories. The claim was replaced.
6. **Privacy.** Y and Vault also break self-evolving §14 statement 1, so decision 8 now covers them. Y is opt-in, and only desktop-started runs carry it.
7. **Top-ups.** S's removal list missed about 15 files: the webhook, ledger, funding check, CLI status, account page, Codium page, desktop return, Stripe setup script, `.env.example` and docs. They are now listed, with a done-when `git grep`. Yearly billing is flagged as a change to "monthly only".
8. **Numbers.** 24 × $5.322 is $127.73, not $127.70. The relay's typical figure is now split $0.10 / $0.20 by tier, as the table already used. Message batching was added as a cost rule (unbatched token streaming adds about 23%). Every other hold, margin, fraud and Vault figure was recomputed and matches.
9. **Routes.** Astra's `azure` and `azure/us` ZDR routes were confirmed in the saved ZDR list, and its live endpoint list was re-read with the same prices. The fast lanes' ZDR routes were added to the "every model has ZDR" line.

---

## Sources (all read 2026-10-27)

**Model routes** (OpenRouter's public API, read with `curl`; saved copies are in the session scratchpad `or-data/` folder):
- https://openrouter.ai/api/v1/models
- https://openrouter.ai/api/v1/endpoints/zdr (1,087 routes)
- https://openrouter.ai/api/v1/models/openai/gpt-6-astra/endpoints and `.../openai/gpt-6-astra-pro/endpoints`
- https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints and `.../anthropic/claude-opus-5.5/endpoints`
- https://openrouter.ai/api/v1/models/openai/gpt-6.1-terra/endpoints and `.../openai/gpt-6.1-sol/endpoints`

**Hosted costs:**
- https://developers.cloudflare.com/durable-objects/platform/pricing/ (updated 2026-10-18; I re-read it)
- https://developers.cloudflare.com/r2/pricing/ (updated 2026-10-26; I re-read it)
- https://developers.cloudflare.com/workers/platform/pricing/ (from today's research pass)
- https://vercel.com/docs/vercel-sandbox/pricing
- https://resend.com/pricing
- https://webkit.org/blog/13878 (Home Screen web apps get push on iOS 16.4 and later)

**Market:**
- https://github.com/features/copilot/plans
- https://docs.github.com/en/copilot/concepts/agents/copilot-memory (public preview; "For individual plans, it's on by default"; used by the cloud agent, code review and CLI)
- https://code.claude.com/docs/en/remote-control (re-read in review: "API keys are not supported")
- https://claude.com/pricing
- https://cursor.com/pricing

**Earlier plans:** everything else carries over from v2 and v1, with their own sources and dates.
