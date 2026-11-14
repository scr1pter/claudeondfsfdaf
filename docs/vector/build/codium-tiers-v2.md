# Vector Codium tiers v2: perks that make each plan worth it

This builds on `codium-tiers.md` (v1). Everything in v1 still stands unless this file changes it: the pools, Stripe and fee figures, the hard caps, the percent-only display, the "Codium" step label, the 55% top-ups and the build steps in v1 §7.

How I checked:
- Code paths are relative to `main/` (shipped main `6eaf445a`). I only read files. Nothing was built, tested or run.
- Web pages were read on 2026-10-27, and each has its URL next to it.
- Two scoring passes rated 46 perk ideas. A perk made the plan only if both rated it highly, or if one rated it "maybe" but the value was high and the cost was close to zero.
- A skeptical review on 2026-10-27 re-checked the margins, the gates, GitHub's terms, the display rule and the build estimates, and edited this file. Its changes are listed in section 7.

Words used below:
- **Pool:** the private amount of model spend each plan includes. It is never published.
- **ZDR:** zero data retention. The model provider keeps none of the prompts.
- **Hold:** the amount the gateway reserves before a request runs. It is the request's largest possible cost.

---

## 1. The new tier table

| | **Plus $10** | **Pro $50** | **Max $100** | **Ultra $200** |
|---|---|---|---|---|
| **Models** | DeepSeek V4.1 Flash 1017 (default), Claude Haiku 5.5, GPT-6 Luna, and GPT-6.1 Terra listed as "coming" (blocked until it has a ZDR route, see v1 §2). Plus **Codium Auto**. | Everything in Plus, plus **GPT-6.1 Sol**, Kimi K3.1 Pro and Gemini 4 Argon | Everything in Pro, plus **Claude Sonnet 5.5**, **Sol Deep** (extra-high effort, 16K reply) and fast lanes (Kimi highspeed, Gemini priority) | Everything in Max, plus **Claude Opus 5.5**, **Sol Deepest** (maximum effort, 256K context, 32K reply) and **preview models** 30 days before anyone else |
| **Headline perks** | 1. Automatic PR reviews in your GitHub, on Codium, with no API key<br>2. Codium Auto: one choice that makes the month last longer<br>3. Premium models (Sol, Kimi, Argon) from any top-up, with no upgrade needed | 1. Sol, Kimi and Argon included<br>2. Second opinion (opt-in): a model from a different lab checks every verified task<br>3. 256K context on Kimi and Argon | 1. **Cloud agents:** close your laptop and get a PR. They run in your own GitHub repo, on your own Actions minutes, with Codium and no keys.<br>2. Claude Sonnet 5.5 and Sol Deep<br>3. 512K context, fast lanes, and first in line when Codium is busy<br>(4. Overnight scheduled runs on Codium, listed once it ships) | 1. **Vector Labs:** new models first, the beta app a week early, preview features<br>2. Claude Opus 5.5 and Sol Deepest: models from five labs in one plan<br>3. 3x Max's cloud-agent hours, 6 at once, 2-hour runs<br>4. 768K context and no daily ceiling |
| **Usage, as a multiple of Plus** | 1x | 5.5x (10% more per dollar than Plus) | 12x (20% more per dollar) | 25x (25% more per dollar) |
| **Longest context** | 256K on Luna (DeepSeek is already 262K; Haiku stays 64K) | 256K ("Long" Kimi and Argon) | 512K ("Long" DeepSeek, Kimi and Argon) | 768K on the same three |
| **Codium agents at once** | 3 | 6 | 12 | 24 |
| **Requests per minute** | 30 | 60 | 120 | 200 |
| **Daily ceiling** (share of the month per UTC day) | 25% | 25% | 40% | None |
| **Cloud agents on Codium** (Codium runs at once / Codium agent hours a month / longest run; the runs themselves stay free with your own keys if decision 4 is yes) | — | — | 2 / 40 h / 45 min | 6 / 120 h / 120 min |
| **Scheduled cloud runs on Codium** (laptop off) | — | — | Up to 5 a day, inside the hours above | Up to 20 a day |
| **GitHub PR reviews on Codium** | Yes, with a per-review and per-PR daily stop (v1 §3; the figures stay internal) | Same; reviews can use Sol | Same | Same |
| **Vector Labs** | — | — | — | Yes (defined in 1a) |
| **Vector Velocity** (Vector's own model, in development) | — | — | First access when it launches | First access, plus experimental builds through Labs |
| **When Codium is busy** | Waits and retries | Waits and retries | First in line, plus one automatic retry on a busy provider | Same as Max |
| **Support** | "Paid" tag and higher report limits | Same | Front of the queue, with no promised response time | Same, plus Labs feedback tagged to the owner |

**Every plan includes:**
- ZDR routing, no provider keys and no overage charges.
- Usage shown as a percentage, with a forecast such as "at this pace your month lasts until Nov 22". Cloud-agent time also shows as a percentage in the app.
- The free workspace stays exactly as it is: the app, the CLI, your own keys, memory, subagents, Vectorscope, automations and the rest of v1 §5. If decision 4 is yes, Run in GitHub, Continue in GitHub and scheduled runs in GitHub are free with your own keys too, as `/vector` and a hand-written cron in `vector.yml` are today.

**Not at launch:** "Upgrade any time and keep what's left of this month" needs item N, which is after launch. Until then an upgrade starts a new, fully charged month and the old month's remainder ends (MODEL-PLANS.md, "Account and credit flow"), so the page must not promise it yet.

**Vector Velocity:** the page may say only "first access when it launches". It gives no date, and the terms say Velocity is not part of what the subscription buys today. Velocity is "In development", with no weights or benchmarks.

**Founding members (launch only):** everyone who subscribes before the earlier of 500 subscribers or 90 days after sales open gets three things:
- their price and allowance locked while they stay subscribed;
- +10% usage on Plus and Pro;
- a numbered "Founding member" mark.

**Typical tasks a month** are unchanged from v1 §2. For example, DeepSeek covers about 20–200 tasks on Plus. That range is the only model-usage figure the page shows. The page also states caps (agents at once, context, daily ceiling, cloud-agent hours), but never tokens or dollars.

**Holds for the new model entries** (each one is the request's whole context at the input ceiling, plus its longest reply at the output ceiling):

| Entry | Context / reply | Price ceiling per 1M tokens | Hold |
|---|---|---|---|
| Luna (Plus) | 256K / 8,192 | $0.1375 / $0.55 | $0.040 |
| Kimi Long or Argon Long (Pro) | 256K / 8,192 | $2 / $10 (no long-context step on OpenRouter, re-checked 2026-10-27; all three Long models list 1,048,576 context) | $0.594 |
| Kimi Long or Argon Long (Max) | 512K / 8,192 | $2 / $10 | $1.106 |
| Kimi Long or Argon Long (Ultra) | 768K / 8,192 | $2 / $10 | $1.618 |
| DeepSeek Long (Max / Ultra) | 512K or 768K / 16,384 | $0.30 / $1.20 | $0.173 / $0.250 |
| Claude Sonnet 5.5 (Max) | 200K / 16,384 | $2.75 / $11 (regional, including the cache-write price) | $0.730 |
| Claude Opus 5.5 (Ultra) | 200K / 32,768 | $5.50 / $22 | $1.821 |

Sources for the Claude models:
- Both have ZDR routes. Sonnet 5.5 is on Vertex (global, us, europe) and Bedrock. Opus 5.5 is on Bedrock (global, us-east-1, eu-west-1) and Vertex (global, us, europe). Source: https://openrouter.ai/api/v1/endpoints/zdr, a partial read of 1.1M characters that found both.
- Prices are $2/$10 global and $2.20/$11 regional for Sonnet, and $4/$20 and $4.40/$22 for Opus. Both list 1M context, no long-context price step, and only `auto`/`none` tool choice, the same as Haiku today. Source: https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints and `.../claude-opus-5.5/endpoints` (re-checked 2026-10-27; the 5-minute cache writes are $2.75 and $5.50 on the regional routes).
- Long contexts: https://openrouter.ai/api/v1/models/moonshotai/kimi-k3.1-pro/endpoints, `.../google/gemini-4-argon/endpoints` and `.../deepseek/deepseek-v4.1-flash-1017/endpoints`, read 2026-10-27, list 1,048,576 context and no tiered price for Kimi and Argon. DeepSeek's own route has a time-of-day price whose peak equals the $0.30/$1.20 ceiling.

### 1a. What "beta" means in Vector (Ultra's Vector Labs)

Vector Labs has exactly three parts. Each part has a way back.

**1. Beta update channel.**
- Every desktop release goes to Labs first and to everyone about one week later, if nothing breaks.
- The beta build is the normal Vector app, with the same sessions, settings and memory. It is **not** the separate "Vector Beta" app. That app has its own app id, `ai.vector.app.beta` (`packages/desktop/electron-builder.config.ts:60-64, 209-217`), so it keeps its own data folder. It stays an internal tool for the owner.
- This is already almost built. The desktop release's `prerelease` input builds the production app (`VECTOR_CHANNEL: prod`) and publishes it to `releases/vector-beta-updates` (`.github/workflows/vector-desktop-release.yml:13-17, 1093, 1647`).
- The updater can already follow a different feed. Company mirrors use `setFeedURL` (`packages/desktop/src/main/updater.ts:22-27`, `update-feed.ts:31-38`), and the Labs switch reuses that path.
- **Fix releases skip the week.** A release that only fixes bugs or security goes to everyone at once. Otherwise every fix would reach free users a week late, which breaks the "never holds back a fix" rule below.
- **Back to stable:** you either wait for the next stable release, or click "Go back to stable now", which turns on `allowDowngrade` for that one install.
  - **Guard needed.** The stable and beta builds share one database, and migrations have no forward guard: an older build skips migrations it doesn't know (`packages/core/src/database/migration.ts:43-80`; self-evolving I14). So a beta may only ship additive migrations, and "Go back to stable now" is offered only when the beta applied none that stable lacks. Otherwise the button says to wait for the next stable release.
- **Promotion isn't built.** The release workflow stages and commits one channel per run (`packages/cloud/src/upload-desktop-release.ts:24, 58-61`). "Promote a week later" needs a step that commits the already-staged beta to the stable feed without a rebuild (item K).
- **CLI:** Labs tells you to install the `beta` npm tag. The CLI release already offers `channel: [latest, beta]` (`.github/workflows/vector-cli-release.yml:22-27`).

**2. Preview features ("Labs features").**
- **What counts:** a Labs feature is finished, passes CI, and is off by default for everyone else. Each one gets its own switch in Settings → Labs. It takes effect only when a session starts, never in the middle of one.
- **Time limit:** within two releases, every Labs feature either turns on for every user, free users included, or is removed.
- **Never in Labs:**
  - anything that is free today;
  - anything that holds back a fix;
  - learned skills' auto mode as a repository setting. It stays a personal opt-in (self-evolving I6).
- **First candidates:** the agent's `lsp` tool (`VECTOR_EXPERIMENTAL_LSP_TOOL`), experimental plan mode and remote workspaces (`packages/engine/src/effect/runtime-flags.ts:40-44`).
  - Anyone can turn these on today with those `VECTOR_EXPERIMENTAL_*` variables, so they count as free today. The variables keep working for everyone. Labs adds a switch, a feedback route and a promise to finish or remove them; it doesn't lock them.
  - 1.99.113's multi-agent and learning features ship on for everyone, as their specs say. Labs never holds them back. Their opt-in settings, such as workflow exploration, stay ordinary settings.

**3. Preview models.**
- **How it works:** a new Codium model is Ultra-only for 30 days from the day it enters the catalog (`previewUntil`). It is labelled "Preview · Ultra". After that it moves to the tier its price fits.
- **The rules:**
  - Only models with a ZDR route qualify.
  - A model already promised to a lower tier skips the window. Terra goes straight to Plus when its ZDR route appears.
  - There is no promise about how many models there will be or when they arrive.
  - The gateway enforces it. This is the only part of Labs that can't be patched out of the public code.
- **Turned on by default:** preview models are on for every Ultra subscriber. The beta channel and Labs features need the Labs switch.

**Also in Labs:**
- Release notes in the app a week early.
- A Labs feedback button. Reports carry an Ultra tag and get a higher limit than today's 5 per hour per IP (`api/support/bug-report.ts:60, 77-79`). No response time is promised.

**Vector Velocity in Labs:** experimental Velocity builds reach Ultra through Labs only once they exist. There is no date, and they are not part of what Ultra buys today (see "Vector Velocity" under the tier table).

**Copy rules:**
- Say "first", never "exclusive". The beta builds and flags come from public code. The beta feed is public, and the flags are environment variables.
- Call Labs "the build the Vector team uses" only if the owner really runs the Labs channel day to day.
- The terms need a beta line: beta builds can break, back up first, and going back is limited by the guard above.

### 1b. Cloud agents (Max and Ultra): how they work and their hard caps

**Implementation: GitHub Actions in the user's own repo, on the user's own Actions minutes.**
- This matches the owner's own words ("in the user's GitHub repo"). It costs the owner $0 in compute, and almost all of the code already exists (cloud-envs-plan option A).
- Vector-hosted sandboxes (option B) are not in the launch plan. See section 6 and decision 2.

**What the user gets:**
- **Run in GitHub:** a button in the desktop app. You pick a repo from your GitHub sign-in, with no local clone needed. You describe the task, then close the laptop. You get a `vector/*` branch and a PR, with the files changed, the checks run and the judge's verdict.
- **`/vector <task>` on issues and PRs:** this already works today with your own keys (`packages/engine/src/cli/cmd/github.handler.ts:660-736, 1570-1714`). Max adds Codium as the model, so no keys or provider secrets are needed.
- **Continue in GitHub:** a running session moves to GitHub with its transcript. When the laptop reopens, the result comes back into the same conversation as one note.
  - **What sets Max apart** is not the buttons, which decision 4 keeps free with your own keys. It is Codium inside them: no keys, no repo secrets, and the result back in the same conversation. GitHub's own $10 Copilot Pro already lists a cloud agent and PR reviews (https://github.com/features/copilot/plans, re-checked 2026-10-27). So an agent that opens a PR is not elite on its own.
  - **Public repos.** Anyone signed in to GitHub has read access to a public repo, so they can download its run artifacts (https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts). The session artifact is therefore encrypted with a per-run key, which the gateway gives only to that repo's run after the OIDC check. On a public repo the app also warns that run logs are public before it moves a session.
  - **Only repo work moves.** A session can move only if its work is in that repo, because GitHub's terms limit hosted runners to the repo's own software project (see below).
- **Overnight automations** (fast follow, about a week after launch): an Automations switch, "Keep running when my Mac is off". It writes a cron trigger into the repo's workflow and uses an unused field that already exists: `cloud?: boolean` (`packages/app/src/features/scheduled/schedule-model.ts:21`).
  - **The switch is free with your own keys.** Free users can already add a cron to `vector.yml` by hand (`github.handler.ts:170, 459-476`), so a Max-only switch would be a client-side gate on something free.
  - **What Max adds** is Codium in those runs. The gateway counts them from the OIDC token's `event_name: schedule` claim, which GitHub signs (https://docs.github.com/en/actions/reference/security/oidc).
  - **One repo each.** Each automation runs only in its own repo.

**How Codium signs in from GitHub:**
- **No secret in the repo.** The workflow asks GitHub for a short-lived OIDC token. That is an ID GitHub gives each run, and it proves which repo the run came from. A verifier already exists (`api/_lib/github-oidc.ts:7-15`).
- **Repo binding.** The gateway swaps the OIDC token for a short-lived Codium run token, but only if the repo is bound to the user's Vector account. Fork PRs stay refused.
- **No GitHub token is uploaded to bind.** The project's own rule forbids uploading a user's GitHub token (`docs/vector/owner-actions/github-app.md:49`). So the server can't check admin rights through the desktop's GitHub sign-in, as the first draft said. Instead:
  1. The desktop gets a one-time bind code from the gateway.
  2. Using its existing GitHub sign-in, the desktop dispatches a short `bind` run in the repo.
  3. That run sends its OIDC token with the code, and the gateway stores `repository_id → account`.
  - The proof is write access, since dispatching a workflow needs it, not admin rights.
- **Checks on every swap.** Reuse the existing exchange's policy (workflow path and ref, allowed events, replay, proofs at most 5 minutes old; `github-app.md`, "Verification"). Also read the `event_name`, `runner_environment` and `repository_visibility` claims.
- **Who can spend.** Anyone with write access to a bound repo can start a run that spends the binder's Codium, within the caps. The binding screen says so. One personal plan bound to a busy org repo is a team plan by the back door, and the caps keep that small until team plans exist.
- **This is a soft gate, and that's fine.** A Plus or Pro subscriber can still paste a terminal sign-in token into a repo secret and run `/vector` on Codium, outside the run-token caps. That costs the owner nothing, because their own pool pays, under the daily ceiling and the in-flight cap. So the Max-only part of cloud agents is convenience and caps, not a lock, and the page must not claim more.

**Hard caps, all enforced at the gateway:**

| | Max | Ultra |
|---|---|---|
| Codium runs at once | 2 | 6 |
| Codium agent hours a month | 40 | 120 |
| Longest run | 45 min (today's job limit, `packages/core/src/review/workflow.ts:253`) | 120 min (in GitHub-token mode; App mode needs token refresh first, because App tokens last 1 hour) |
| Model spend | The monthly pool and the 40% daily ceiling | The monthly pool |

- **How hours are counted:** from a run's first Codium request to its last, timed on the server and rounded up to the minute. PR reviews don't count toward Codium agent hours. A run's slot frees when the run reports that it's done, or at its deadline.
- **One in-flight cap for everything.** A cloud run's requests count toward the account's Codium agents at once (12 on Max, 24 on Ultra). So 6 cloud runs can't each fan out 8 helpers on top of the laptop's work.
- **When a cap is reached:** at the hours cap or the concurrency cap, the gateway refuses new run tokens. When a run reaches its time limit, its token expires. The CLI learns that deadline up front, so it commits its work and opens a draft PR before the deadline.
- **Which cap bites first:** on Sol or Opus, the pool usually runs out before the hours (estimate, not measured).

**Why cap hours if the compute costs the owner nothing:**
- the caps make Max and Ultra clearly different;
- a looping automation can't eat the month;
- the user's own GitHub bill stays bounded;
- it is the same meter a hosted option would need later.

**What the user pays GitHub:**
- Public repos: nothing.
- Private repos: 2,000 free minutes a month on GitHub Free (about 33 hours) and 3,000 on GitHub Pro, then $0.006 a minute for Linux 2-core, billed by GitHub (https://docs.github.com/en/billing/concepts/product-billing/github-actions, re-checked 2026-10-27).
- **At the full caps, on a private repo on GitHub Free:**
  - Max's 40 h is about 2,400 minutes. That is about 400 past the free 2,000, roughly $2.40 billed by GitHub.
  - Ultra's 120 h is about 7,200 minutes. That is about 5,200 past the free 2,000, roughly $31 billed by GitHub.
  - The repo's other CI uses the same minutes.
  - Without a GitHub payment method and budget, private-repo runs stop when the free minutes run out. So Ultra's full hours on private repos also cost the user money at GitHub. Section 2 says so.
- The Run dialog shows the estimated minutes and links to GitHub's pricing. It shows no dollar figure.

**GitHub's terms:**
- **What the terms bar.** GitHub's Actions terms bar using Actions for "a stand-alone or integrated application or service offering the Actions product or service" for commercial purposes. On GitHub-hosted runners they also bar activity unrelated to the software project of the repo the workflow is in. Source: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features (re-read 2026-10-27).
- **What Vector sells.** Vector sells **model access only**. The workflow, the Run in GitHub button, Continue in GitHub, scheduled runs and `/vector` stay free for everyone with their own keys, as `/vector` is today. What Max adds is Codium inside those runs, plus the caps above.
  - The caps are limits on Codium use, counted from Codium requests. They are not limits on Actions. That is why the table says "Codium runs" and "Codium agent hours".
- **Copy rules.**
  - Every mention of cloud agents sits next to "runs in your own repo, on your own Actions minutes".
  - The page never says "cloud hours", "hosted", "our cloud" or "compute".
  - The page name can stay "cloud agents" or become "agents in your GitHub" (decision 13).
- Get a legal read before listing it (decision 3).

---

## 2. Why each plan feels worth it

**Plus ($10) feels like a steal.**
- For $10 you get models from three labs (DeepSeek, Anthropic, OpenAI) with ZDR and no keys to manage.
- Pull requests in your repos get reviewed on Codium automatically, until the review stop or the month's usage is reached. Don't say "every pull request". A standalone reviewer like CodeRabbit charges $24–30 per developer a month (https://www.coderabbit.ai/pricing), and Copilot Pro bundles review at the same $10.
- Codium Auto keeps easy work on the cheapest model, so the month lasts longer.
- When one hard bug needs a premium model, a top-up unlocks Sol, Kimi or Argon right away instead of a $50 upgrade.
- Founding members also lock the price and get 10% more usage.

**Pro ($50) feels premium.** The owner's direction is premium branding from $50 up, and none on Plus.
- The premium models are included: GPT-6.1 Sol, Kimi K3.1 Pro and Gemini 4 Argon. You get 5.5x Plus's usage for 5x the price.
- When Second opinion is on, every verified task is checked by a different lab's model, which catches the mistakes a model makes when it grades its own work. It uses more of the month, and the setting says so.
- Kimi and Argon get 256K context, so big repos and long sessions need fewer summaries.
- No vendor has a direct $50 peer. The closest are Cursor Premium at $30 (4x its Plus, https://cursor.com/pricing) and Copilot Pro+ at $39 (https://github.com/features/copilot/plans).

**Max ($100) feels elite.**
- Your agents keep working in your own GitHub repo after you close the laptop, on Codium with no keys, and the result comes back into the same conversation. Soon, scheduled automations will also run overnight. They run on your own Actions minutes, which are free on public repos.
- It adds Claude Sonnet 5.5 and Sol Deep, which make it the first plan with a Claude Sonnet model and Sol at extra-high effort. Don't call Sonnet a flagship: Opus is Anthropic's larger model.
- It also adds 512K context, fast lanes, twice Pro's parallelism and first place in line when Codium is busy. At $100, peers sell priority (Claude Max, https://claude.com/pricing; Cursor Super, https://cursor.com/pricing). Max sells priority plus agents that work while you sleep.

**Ultra ($200) feels elite.**
- You get things first: new Codium models 30 days early, each Vector release a week early, and preview features. Claude Max and Cursor Ultra make the same early-access promise (pages above).
- Ultra includes Claude Opus 5.5 and Sol at maximum effort, so it holds models from five labs in one plan, all with ZDR. Don't claim "the top model" from each lab: DeepSeek V4.1 Flash is a Flash model, and nothing here checks that each lab has nothing bigger.
- It has three times Max's cloud-agent hours, 6 at once, 2-hour runs, 768K context, 24 agents at once and no daily ceiling.
- Two honest points:
  - Ultra gives less usage per dollar than the subsidised $200 plans (v1 §6). The perks are what make up for it.
  - On a private repo, using all 120 cloud-agent hours runs about 5,200 minutes past GitHub Free's 2,000, which GitHub bills to the user (about $31 a month at today's rate). Public repos cost nothing.

---

## 3. Owner cost and margin per tier

Inputs are as in v1 §3: pools of $6 / $33 / $72 / $150, Stripe at 2.9% + 30¢ + 0.7% Billing (+1.5% for international cards), and OpenRouter's 5.5% fee (still unverified).

**Why no perk can lose money:**
- **Model use:** every perk that uses a model is paid from the buyer's capped pool. That covers PR reviews, cloud runs, Codium Auto, the second opinion, long context, the Claude models and preview models.
- **Compute:** cloud agents run on the user's own GitHub Actions minutes.
- **Owner costs outside the pool.** v1 left out the gateway's own hosting, and that cost grows with use. There are four such costs:
  - **Gateway memory.** Vercel bills a function's memory for as long as a request is in flight: 2.12¢ per instance-hour at the default 2 GB ($0.0106 per GB-hour in iad1, https://vercel.com/docs/functions/usage-and-pricing, re-read 2026-10-27). `api/model-plans/chat.ts` sets no memory, so the default applies. One instance can serve several streams at once, so this is an upper bound.
    - **Upper bound: about 4 streamed hours per pool dollar, on every tier.** Any subscriber can spend the whole pool on DeepSeek or Luna, and cached cheap-model steps cost roughly $0.25–0.80 an hour. This is an estimate, not a measurement.
    - **Why it changed.** The first draft used 4 h per dollar for Plus but only about 1.3 for the other tiers (24 / 47 / 94 / 189 h). That understated Max and Ultra about 3x.
    - That comes to about 8.5¢ per pool dollar.
  - **Request bytes.** Every step sends the whole context, up to 4.5 MB.
    - Bytes into a function count as Fast Origin Transfer, at $0.06 per GB in iad1 (https://vercel.com/docs/manage-cdn-usage, https://vercel.com/docs/pricing/regional-pricing/iad1).
    - Cached long contexts on cheap models send up to about 0.3 GB per pool dollar (estimate), which is about 1.8¢ per pool dollar.
    - If the team's Flat Rate CDN doesn't cover incoming Fast Data Transfer ($0.15 per GB), this line is 3.5x larger. Check the billing page before launch.
  - **Labs downloads.** Installers come from Vercel Blob at $0.05 per GB, about 1¢ per Ultra user per beta release.
  - **Founding +10%.** It applies to Plus and Pro only, and it scales the lines above by 1.1.
- **Total upper bound outside the pool:** about 10.3¢ per pool dollar. That is $0.62 / $3.39 / $7.40 / $15.42 at full use.
- **Cheap ways to cut it** (item Q):
  - set the chat function to 1 GB, which halves the memory line;
  - accept gzip request bodies, which cuts the bytes line by roughly 4x;
  - read the real cost per function in the first month.

| Per subscriber per month | Plus $10 | Pro $50 | Max $100 | Ultra $200 |
|---|---|---|---|---|
| **Typical** (60% of the pool used, domestic card): v1 profit | $5.54 | $27.01 | $50.52 | $97.55 |
| Gateway memory and bytes (60% of the upper bound) | −$0.37 | −$2.04 | −$4.44 | −$9.25 |
| Labs downloads | — | — | — | −$0.02 |
| Cloud-agent compute | — | — | $0 | $0 |
| **Typical profit after perks** | **$5.17 (52%)** | **$24.98 (50%)** | **$46.08 (46%)** | **$88.28 (44%)** |
| Typical, founding member (uses 60% of a 10% bigger pool) | $4.76 (48%) | $22.68 (45%) | — | — |
| **Full use** (100% used, international card): v1 profit | $2.86 | $12.33 | $18.64 | $31.25 |
| Gateway memory and bytes (upper bound) | −$0.62 | −$3.39 | −$7.40 | −$15.42 |
| Cloud agents at the full 40 h / 120 h | — | — | $0 compute. Their gateway time is inside the row above, because the pool bounds it. | Same |
| Labs downloads | — | — | — | −$0.02 |
| **Full-use profit after perks** | **$2.24 (22%)** | **$8.94 (18%)** | **$11.24 (11%)** | **$15.81 (8%)** |
| Full use, founding member (+10% pool × 1.055) | $1.55 (15%) | $5.12 (10%) | — | — |
| Fraud (pool used at the gateway's upper bound, then the dispute is lost) | −$22.76 (founder −$23.45) | −$56.06 (founder −$59.88) | −$103.76 | −$199.19 |

**What moves:**
- **The typical case drifts toward the full-use case.** Perks like PR reviews and cloud agents make people use more of the pool they paid for. That is the real cost of the perks. The full-use row is still positive on every tier.
- **Ultra is the thinnest.** At full use it keeps about 8%, and that figure depends on the gateway estimate. Do item Q and a first-month measurement before raising any Ultra cap or adding anything to Ultra that costs money outside the pool.
- **Codium Auto works the other way.** It sends routine steps to cheaper models, so it lowers spend per task.
- **Premium on demand adds profit.** In the heavy international case a top-up keeps about 29–32% after the gateway's upper bound (35–37% before it, v1 §5). The Plus monthly pool never pays for premium models.
- **Fraud stays the only losing case.** 3D Secure on first purchases of $100 or more, and pausing the key on a Stripe early-fraud warning (v1 §3), are still required before launch.
  - Ultra has no daily ceiling, so a stolen card can drain its pool in a day, long before an early-fraud warning arrives. 3D Secure on the first purchase is what covers Max and Ultra.
- **Hosted sandboxes, if they are added later as an Ultra extra** (decision 2): 20 hosted hours at about $0.11–0.34 an hour cost $2.20–6.80 (https://vercel.com/docs/vercel-sandbox/pricing, via cloud-envs-plan.md).
  - Ultra's full-use profit would then fall to about $9.01–13.61 (5–7%).
  - The same for Max at 10 hours would leave $7.84–10.14 (8–10%).
  - This needs hour quotas, a spend cap and a kill switch first. Owner direction allows hosted hours at cost, with no loss.

---

## 4. What must be built, and in what order

Each item below lists what already exists and what is new.

**A. Codium in GitHub (the base for Plus reviews and Max cloud agents).** Medium, about 1.5–2 weeks, plus an npm CLI release.
- **Already exists:**
  - the OIDC verifier and its audiences (`api/_lib/github-oidc.ts:7-15`);
  - `id-token: write` in App-mode jobs (`packages/core/src/review/workflow.ts:205, 262`);
  - `workflowModel`, whose `vector` branch already signs in with the account token (`packages/app/src/features/pull-requests/ai-review.ts:409-436`);
  - the desktop's GitHub sign-in and repo list (`packages/desktop/src/main/github-auth.ts:343`).
- **To build:**
  1. **Repo binding.** Binding works by challenge (1b), with no GitHub token uploaded.
     - `POST /api/model-plans/github/bind-code` gives the signed-in account a one-time code.
     - A `bind` dispatch in the repo sends that code with its OIDC token to `POST /api/model-plans/github/bind`, which stores `repository_id → account`.
     - The binding can be listed and revoked in Settings, and that screen says anyone with write access can spend through it.
  2. **Run tokens.** `POST /api/model-plans/github/token` swaps a run's OIDC token for a short-lived run token.
     - The token carries the account, repo, run id and attempt, its purpose (review, task or scheduled), the tier's limits and a deadline.
     - Fork and unbound repos are refused.
     - The swap reuses the existing exchange's checks (`api/_lib/github-oidc.ts`; `github-app.md`, "Verification").
     - Each run also gets the key for its encrypted session artifact (item D).
  3. **Gateway.** It accepts run tokens and keeps counters in Valkey for each run: tokens for reviews, time for tasks. It also enforces Codium runs at once, Codium agent hours each month and scheduled runs a day.
  4. **Workflow.** Add `id-token: write` to the Codium jobs and bump `VECTOR_WORKFLOW_VERSION`.
  5. **CLI.** Let `vector-plan` through `workflowModel`, and teach the engine's Actions sign-in to do the OIDC swap.
  6. **Safety: account tokens.**
     - **The problem.** Today any unexpired account token works for Codium (`api/_lib/model-plan-chat.ts:20-25`) and lasts 90 days (`cli-token.ts:14`). So every existing `VECTOR_CLI_TOKEN` repository secret would become a key that can spend Codium the day sales open.
     - **Why a new `ci` mark doesn't fix it.** The token from vectordev.ai/auth/cli, the one people paste into those secrets, is the same unmarked kind a terminal sign-in gets (`api/account/cli-token.ts:9`, `cli-token.ts:39-44`). A mark added now can't tell existing secrets apart.
     - **The fix.** From this release, mark terminal sign-ins `client: "cli"`. The Codium gateway then accepts only `desktop` tokens, `cli` tokens and run tokens, and refuses unmarked (older) ones.
     - **Effect.** Existing secrets keep working for free models but can't spend Codium. Terminal users sign in once more before their first Codium request. A new `cli` token pasted into a secret can still spend its owner's own pool (the soft gate in 1b).
  7. **Release.** Publish the npm CLI and bump the version the workflow pins. GitHub runners install 1.99.99 today, which has no Codium provider.

**B. Plus PR reviews on Codium.** About 2–3 days on top of A.
- **Token stop.** The token-based review stop from v1 §3: 400K per review and 2M per PR per day. It is needed because the dollar budgets in `packages/core/src/review/skip.ts:33-68` can't price Codium steps.
- **Codium label.** "Codium" on review lines (`ai-review.ts:1717-1729`).
- **Setup.** Codium offered in the desktop's "Set up automatic reviews" (`packages/desktop/src/main/github-pr.ts:683-740`).

**C. Run in GitHub (cloud-envs-plan Phase 1).** About 1–2 weeks on top of A.
- **Workflow inputs.** Add `prompt` and `branch` dispatch inputs and make `pr` optional (`workflow.ts:78-85, 309-313`). Follow-ups continue on the same branch (`github.handler.ts:622-659, 1101-1177`).
- **Desktop button.** A new module next to `github-pr.ts`:
  - it starts runs through the existing sign-in (`github-access.ts:10-16`);
  - it shows progress with `listCiRuns` and `failedStepLog` (`ci-watch.ts:96-135`);
  - it shows a minutes estimate for private repos.
- **Safety, in the same release:**
  - remove `GITHUB_TOKEN`, `GH_TOKEN` and provider keys from the agent's shell (`packages/core/src/child-environment.ts:83-94`);
  - set `persist-credentials: false` on every job (today only App mode has it, `workflow.ts:269`);
  - push only through the path the model's tools can't use (`github.git.ts`).
- **Deadline.** Before the run token expires, the agent wraps up and opens a draft PR.

**D. Continue in GitHub.** About 1–1.5 weeks on top of C. It can only ship after 1.99.113, because it needs 1.99.113's background-job rows.
- **Session artifact.** The session travels as an Actions artifact, using the import logic in `packages/engine/src/cli/cmd/pr.ts:16-109`. Personal memory and private documents are left out.
  - The artifact is encrypted with the per-run key from item A.2. On public repos anyone signed in to GitHub can download artifacts (1b).
  - On a public repo the app warns that run logs are public before it moves a session.
- **Queue.** A queue per branch replaces the per-comment concurrency group (`workflow.ts:254-257`). GitHub keeps only one queued run per group.
- **Return.** The result comes back as one note through 1.99.113's background-job rows (multiagent-parity-spec §0 C/D).

**E. Overnight cloud automations.** About 1 week after launch, on top of C.
- **Already exists:** the engine handles `schedule` and dispatch runs with a prompt (`github.handler.ts:170, 459-476, 820-835`), and the `cloud?: boolean` field sits unused (`schedule-model.ts:21`).
- **To build:**
  - `buildWorkflowYaml` writes `on.schedule` cron lines and maps each one to its automation's prompt;
  - the panel shows the last run;
  - the switch works for everyone with their own keys (1b);
  - Codium scheduled runs get a run token with purpose "scheduled", and the gateway counts them per day from the `event_name: schedule` claim (5 on Max, 20 on Ultra).
- **Watch out:** GitHub's cron is best effort, and it turns off schedules in public repos after 60 days without activity.

**F. Codium Auto.** About 3–5 days.
- **Already exists:** `routeModelForTask` only moves *up*, within one provider, when a task is "complex" (`packages/app/src/utils/task-intelligence.ts:144-162`). Routing is called per message in `packages/app/src/components/prompt-input/submit.ts:789-826`.
- **To build:**
  - **Picker entry.** A "Codium Auto" entry in the picker.
  - **Roles.** A role on each catalog entry: floor (Luna or DeepSeek), default (DeepSeek), or ceiling (Plus: DeepSeek, or Terra once it ships; Pro: Sol; Max: Sol Deep or Sonnet 5.5; Ultra: Sol Deepest or Opus 5.5). The roles are read from the tier-filtered `/models` list.
  - **When it routes:** once per message, never per step, so the prompt cache survives.
  - **Retry.** A "retry with a stronger model" action.
- **Rule it keeps:** the person picks Auto, so "Vector never picks a Codium model by itself" (MODEL-PLANS.md, "Choosing a Codium model") still holds.

**G. Premium on demand.** About 2–3 days.
- **Purchased-only holds.** `holdCredits` gets a purchased-only mode (`api/_lib/model-plan-account.ts:661-690`). For Sol, Kimi and Argon on Plus, the planned `MODEL_PLAN_UPGRADE_REQUIRED` refusal falls back to that mode when purchased credits exist.
- **Model list.** `/models` sends those models to Plus with a `topUpOnly` flag (`api/_lib/model-plan-models.ts`).
- **Badge.** A "with top-ups" badge in the picker (`packages/app/src/utils/provider-brand.ts:91-113`).
- **Status.** The status line says which balance a step used.
- **Terms.** One terms line (`packages/web/src/pages/legal/terms.astro:53-54`).

**H. Second opinion.** About 3–4 days.
- **Already exists:** the judge runs on the message's model unless it has its own (`packages/engine/src/session/prompt.ts:760-761`), and the toggle exists (`settings-v2/general.tsx:259-266`).
- **To build:**
  - **Judge pairing.** A `judge` pairing on each catalog entry.
    - Pro: Sol judges DeepSeek, Kimi and Haiku, and Argon judges Sol and Luna. Luna and Sol are both OpenAI models, so Sol judging Luna would not be a different lab, as the first draft had it.
    - Max uses Sol Deep or Sonnet, and Ultra uses Sol Deepest or Opus, always from the other lab.
    - The engine uses the pairing only when the worker is on Codium, no judge model is set, and the person has turned on "Second opinion". A Sol judge on DeepSeek work costs several times the worker's step, so it never switches on silently.
  - **Second opinion button.** It runs `vector vectorscope --uncommitted`. It works the same with your own key, and it never becomes a paid upgrade for external agents.

**I. Long context.** About 1–2 days, after v1's `upstream` and `minPlan` catalog fields.
- **Catalog.** Long entries with the context sizes in section 1, plus the catalog audit fixture.
- **Test before listing 768K:** a 768K request must clear the gateway's 4.5 MB body limit (`MAX_BYTES`, `model-plan-chat.ts:19`) and the 600 s deadline (`:389`). If it doesn't, Ultra launches at 512K.
- **Never advertise "1M".**
- **Price check.** On 2026-10-27, OpenRouter listed no long-context price step for Kimi or Argon. Re-check before release.

**J. Claude Sonnet 5.5 and Opus 5.5.** About 1–2 days each.
- **Catalog entries.** Entries with `minPlan`, `explicitCache` and auto tool choice handled like Haiku. Their ceilings cover 5-minute cache writes ($2.75/$11 and $5.50/$22).
- **Fixture.** Update the audit fixture.
- **Benchmark.** Run the in-house benchmark in CI before writing any quality claim.

**K. Vector Labs.** About 5–7 days. The first draft said 3–5, before the promote step and the downgrade guard were added.
- **Feed switch.** Add a Labs feed option to `update-feed.ts` and apply it through `setFeedURL` (`updater.ts:22-27`), plus a one-off `allowDowngrade` for going back. A company mirror policy wins over Labs.
- **Downgrade guard.** Offer "Go back to stable now" only when the beta applied no migration that stable lacks (1a). A CI check keeps beta migrations additive.
- **Promote step.** A release workflow input that commits an already-staged beta to the stable feed without rebuilding (`upload-desktop-release.ts:58-61`). Fix-only releases skip Labs.
- **Labs flags.** Flags come from the status entitlements and are applied at session start (`runtime-flags.ts:40-44`).
- **Preview models.** `previewUntil`, with a gateway check (v1 §7).
- **Feedback.** Higher limits for tagged reports (`api/support/bug-report.ts:60, 77-79`).
- **Release routine.** Ship each release with `prerelease: true` first, then promote it a week later.

**L. Usage forecast and renewal recap.** About 3–4 days.
- **Server.** A daily percentage snapshot in Valkey, and `history` and `forecastDate` in the status (`api/_lib/model-plan-status.ts:35-40, 65, 92-94`).
- **Where it shows:** a chart in Settings → Usage (`packages/app/src/components/settings-v2/usage.tsx:159`) and a line in `vector codium` (`packages/core/src/model-plan-status.ts:211-219`).
- **Renewal card.** It is built from the local usage summary (`packages/app/src/utils/usage-summary.ts:26-39`) and shows counts only, never tokens or dollars.
- **Display rules:**
  - Round to whole percent and show "<1%" for small values.
  - Hide the forecast for the first 3 days of a month.
  - Alerts are opt-in.

**M. Priority when busy.** About 1–2 days.
- **Reserve.** A global in-flight counter next to v1's per-account counter. Its last ~20% is reserved for Max and Ultra.
- **One retry.** One retry on an upstream 429 or 503 for Max and Ultra, using the same hold, and only before any reply byte has been sent. Today the gateway passes these straight back (`model-plan-chat.ts:237-249`). MODEL-PLANS.md says "Nothing is retried", so item P updates it.
- **Copy.** It promises no speed or capacity figures.

**N. Upgrade without losing what you paid for.** About 4–6 days, after launch.
- **Carry-over.** On an upgrade, `provisionMonthlyKey` (`model-plan-account.ts:803-848`) adds what was left of the old month to the new key.
- **Pause.** "Pause one month" through Stripe `pause_collection`.
- **Prompts.** At most one prompt a week, and never during a running turn.

**O. Founding members.** About 2–3 days.
- **Checkout.** Checkout metadata (`model-plan-account.ts:1000-1004`), with an atomic counter in `api/_lib/persistent-store.ts`.
- **+10%.** Added in `subscriptionPlanCredits` (`api/_lib/model-plan-config.ts:64-80`). Plan changes must keep the metadata (`:66-69`).
- **Price lock.** Legacy price IDs are accepted for the lock (`model-plan-account.ts:494-505`).
- **Badge.** Through `packages/app/src/vector-account.ts:69`.

**P. Page and terms.** About 1–2 days, on top of v1 step 7.
- **Per-dollar wording.** The per-dollar ladder ("5.5x Plus usage for 5x the price").
- **Badge.** "Recommended" instead of "Most popular" until real sales support it (`packages/web/src/components/marketing/codium/CodiumPricing.tsx:18-19, 213`).
- **Perk lists** (`:738-753`).
- **Terms lines** for:
  - Codium agent hours, and that GitHub bills the Actions minutes;
  - that anyone with write access to a bound repo can spend the binder's Codium;
  - the preview window;
  - Labs beta builds (they can break, back up first, going back is limited);
  - Vector Velocity: first access when it launches, no date, not part of what the subscription buys today;
  - the founding lock;
  - top-ups buying premium models;
  - "runs in your own repo, on your own Actions minutes".
- **Docs.** MODEL-PLANS.md's "Nothing is retried" changes for Max and Ultra's one retry (item M).

**Q. Gateway cost guard.** About 1 day.
- Set the chat function's memory to 1 GB, after checking peak memory on a 4.5 MB request.
- Optionally accept gzip request bodies, with a cap on the size after decompression.
- After the first month, read the real per-function cost and compare it with the section 3 upper bound.

**Order of work.** These are the sums of the item estimates above, in 5-day weeks. They leave out 1.99.112 and 1.99.113 work and any wait for the legal read.
- **v1 steps 1–8:** 15–23 days.
- **v2 items before launch:** about 44–66 days.
- **Total:** about 13 weeks at the low end and 19 at the high end. The table below reaches launch in week 17. The first draft's "about 10 weeks" put 9–16 days of work in week 4 and 12–18 days in week 5.

| Weeks | Work |
|---|---|
| 1–4 | v1 steps 1–8: decisions, plan cache, entitlements and catalog fields (`minPlan`, `previewUntil`, `upstream`, `providerOnly`), gateway caps and the fraud webhook, Sol variants and fast lanes, app and CLI, page and terms, the support tag |
| 5–7 | I (long context), J (Claude models), G (premium on demand), M (priority), Q (cost guard), then K (Labs). This is mostly catalog and gateway work on v1's fields. |
| 8–10 | F (Codium Auto), H (second opinion), L (forecast), O (founding), P (page) |
| 11–13 | A (Codium in GitHub, including the account-token fix), then B (Plus reviews), then the npm CLI release |
| 14–16 | C (Run in GitHub and its safety work), then D (Continue in GitHub, once 1.99.113 has shipped) |
| 17 | v1 step 9: an end-to-end run in Stripe test mode, a load check at Ultra's limits, the legal read, then open sales |
| After launch | E (overnight automations, about 1 week, listed on Max and Ultra once shipped), N (upgrade carry-over and pause) |

Run all tests in CI, not on this Mac while Vector is open.

---

## 5. Decisions only the owner can make

1. **Cloud agents.** Approve GitHub Actions in the user's repo, with Max at 2 at once / 40 h / 45 min and Ultra at 6 / 120 h / 120 min.
2. **Hosted sandboxes.** Decide whether to add them later as an Ultra extra (for example 20 hours, about $2.20–6.80 at full use), once quotas, a spend cap and a kill switch exist. My recommendation is after launch, funded by real sales.
3. **Legal read.** Get one on GitHub's Actions terms and the "your repo, your minutes" copy before listing cloud agents or Actions reviews. OpenRouter's resale terms are still open as well (MODEL-PLANS.md:123).
4. **Run in GitHub for free users.** Decide whether "Run in GitHub" and "Continue in GitHub" work for free users with their own keys, as `/vector` does today. I recommend yes: it keeps the free workspace whole and keeps the paid part to model access. The alternative is a Max-only button, which is a client-side gate and closer to GitHub's line.
5. **Claude models.** Decide on Sonnet 5.5 on Max and Opus 5.5 on Ultra. The alternative is Sonnet on Pro, to fill the gap between $10 and $50.
6. **Labs commitments.** Set the beta lead time (1 week suggested) and the preview window (30 days suggested). Commit to about 1–2 hours of release work a week, and decide who reads Labs feedback.
7. **Premium on demand.** Decide whether Plus top-ups may pay for Pro's models. This changes v1's rule that top-ups follow the plan's tier.
8. **Founding offer.** Approve the close (500 subscribers or 90 days, honoured with no extension), the price lock, and +10% on Plus and Pro only.
9. **Old tokens and Codium.** Decide whether the gateway refuses unmarked (pre-launch) account tokens for Codium (item A.6). Existing `VECTOR_CLI_TOKEN` secrets would then keep working for free models but couldn't spend Codium, and terminal users would sign in once more.
10. **Launch timing.** These are from the sums in section 4:
    - about week 11 with nothing in GitHub (no Plus reviews, no cloud agents);
    - about week 14 with Plus reviews but no cloud agents;
    - about week 17 with both. I recommend this one, because cloud agents are Max's headline and the founding window starts at launch.

    Each option slips if 1.99.112 or 1.99.113 takes the same weeks.
11. **Still open from v1:** the pools, Argon, the daily ceilings, a $20 tier, top-ups at 55%, and Run Guard's 40-unpriced-step rule.
12. **After 2–3 months of sales data:** a 14-day money-back if under 25% is used, rollover of 10–15% on Plus and Pro, and yearly billing at 15% off on Plus and Pro.
13. **The cloud-agent name on the page.** Choose between "cloud agents" and "agents in your GitHub". Either way it always sits next to "runs in your own repo, on your own Actions minutes" (GitHub's terms, 1b). The lawyer should see the final wording.
14. **Vector Velocity on Max and Ultra.** Confirm the "first access when it launches" wording, with no date and nothing in the terms that makes it part of today's purchase.

---

## 6. Perks considered and dropped

- **Hosted cloud sandboxes with live attach:** the only perk whose cost grows with use outside the pool ($0.11–0.34 an hour). It is also 4–8 weeks of work and means holding other people's private code. It could become a later Ultra extra (decision 2).
- **Sol Pro mode on Ultra:** not yet verified that its tool calls stream through OpenRouter or that it finishes within 600 s. If a CI benchmark passes, it can be the first Labs preview model.
- **Codium workflow packs with tier aliases:** they depend on 1.99.113, which hasn't shipped, and one judge rated them low. Revisit after 1.99.113 settles.
- **Sprint days (lift today's ceiling):** only useful if daily ceilings stay (v1 decision 3), and it gives up unused pool.
- **Bigger Brain limits on Max:** charging for rows in your own local database reads as an artificial cap. Raise the limits for everyone if they hurt.
- **Brain backup and sync:** this would be the first user data on Vector's servers. It needs end-to-end encryption and a legal read. Later, backup first.
- **Brain Lane (learning that doesn't use the plan):** a cash cost outside the pool that people could use as free DeepSeek. Instead, let the learning features use a Codium model the person picks, from their own pool.
- **"Fastest route" preference:** it steers Sol to routes that cost 10% more, which drains buyers' pools and the typical margin.
- **Ultra council (calls, votes, a response target):** founder time doesn't scale. Labs keeps only the tagged feedback.
- **Plan colours, signature themes and an Ultra icon as listed perks:** nobody pays for themes. Ship the theme gallery free for everyone, and keep plan colour as unlisted polish.
- **Codium Local Assist:** too narrow. Vector Local users chose to block the network.
- **Ship-it deploy gate:** desktop-only, and it sits in front of production deploys. It could return later as a workflow.
- **Yearly billing:** 15% less revenue, large-dispute risk and billing rework. Revisit for Plus and Pro after sales history (decision 12).
- **First-month +25% boost:** a real cost that also feeds card-testing fraud, and a meter at 125% is confusing.
- **Unused usage rolls over:** it gives up the main source of typical profit and needs a terms change. Revisit for Plus and Pro at 10–15% (decision 12).
- **14-day money-back:** good protection against disputes, but it is a legal question rather than a perk (decision 12).
- **Referral credits:** a growth tool, not a reason to buy a tier. After launch.
- **Students get Pro models at the Plus price:** verifying students is weak and it cannibalises Pro. Premium on demand covers the need.
- **Monthly recap as a listed perk:** folded into the usage page as a renewal card instead.
- **Per-working-day prices on the page:** they read as a gimmick. The per-dollar ladder alone is enough.
- **Signed, entitlement-gated beta download links:** not worth building. The code is public, and preview models are the real gate.

---

## 7. What the 2026-10-27 review changed

1. **Gateway cost was understated for Max and Ultra.** The first draft assumed 4 streamed hours per pool dollar on Plus but about 1.3 on the other tiers. Any subscriber can spend the whole pool on cheap models, so the review used 4 h per dollar on every tier. It also added request bytes (Fast Origin Transfer, $0.06 per GB).
   - Full use is now 22 / 18 / 11 / 8%, where the draft had 24 / 23 / 17 / 14%. Typical use is 52 / 50 / 46 / 44%.
   - Worst-case fraud is −$22.76 to −$199.19.
   - Every tier stays positive. Item Q (1 GB memory, gzip) and a first-month measurement were added.
2. **Users' GitHub bill.** At the full caps on a private repo, GitHub bills the user about $2.40 on Max and about $31 on Ultra, and runs stop without a GitHub payment method. The Run dialog now shows minutes, not dollars.
3. **Repo binding needed a forbidden token upload.** The draft's "admin check through the desktop's GitHub sign-in" would have meant uploading a user token, which `github-app.md:49` forbids. Binding is now an OIDC challenge, and it reuses the existing exchange's checks.
4. **The account-token fix didn't work.** A new `ci` mark can't tell existing `VECTOR_CLI_TOKEN` secrets apart, because they are the same unmarked token. The gateway now refuses unmarked tokens for Codium. The doc also says that cloud agents' Max-only gate is soft (a pasted token), which costs the owner nothing.
5. **Free-workspace leaks.**
   - The cloud Automations switch is free with your own keys, since a hand-written cron already works today.
   - Labs' first features are already usable through `VECTOR_EXPERIMENTAL_*` variables, which stay working.
   - 1.99.113 features aren't held back.
   - Fix releases skip the beta week.
6. **Display rule.** The token figures for PR reviews were removed from the public table, and cloud-agent time shows as a percentage in the app.
7. **Promises not true at launch.** "Upgrade and keep what's left" moved to after launch, because item N comes after launch. "Every PR reviewed", "the top model from five labs" and "Claude and GPT flagship" were corrected.
8. **Second opinion.** Sol judging Luna was the same lab, so Argon now judges Luna. Second opinion is opt-in, because it raises spend.
9. **Privacy and GitHub's terms.**
   - Session artifacts on public repos are encrypted, because anyone signed in to GitHub can download them.
   - Only repo work moves to GitHub.
   - The caps are framed as limits on Codium use, not on Actions.
   - Copy never says "cloud hours" or "hosted".
10. **Labs.** Added a downgrade guard for the shared database, a promote step that doesn't exist yet, a beta terms line, and a rule that Terra skips the preview window.
11. **Build estimate.** About 10 weeks became about 13–19, planned at 17, from the doc's own per-item ranges. K went from 3–5 days to 5–7, D waits for 1.99.113, and the launch-timing options were updated.
12. **Owner direction not yet in v2.** Vector Velocity was added as "first access when it launches", with no date and not part of today's purchase. Pro's branding is now "premium", not "a steal".
