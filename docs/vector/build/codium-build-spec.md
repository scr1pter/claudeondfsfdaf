# Vector Codium: the build contract

Written 27 Oct 2026. This file is the contract for every engineer-agent session that builds Vector Codium. It merges the five group designs (billing pipeline, gateway and models, cloud agents, hosted services, product perks, website/legal/docs) and applies their critiques. Appendix A lists the few corrections that were changed or rejected, with the reason.

**Precedence.** Owner decisions of 27 and 30 Oct (in the task and in `codium-tiers-v3-changes.md` §6–8) win. Then this file. Where this file is silent: `codium-tiers-v3.md`, then `codium-tiers-v2.md`, then `codium-tiers.md`, then `codium-label-plan.md` and `cloud-envs-plan.md`. All are in `docs/vector/build/`.

**Code anchors.** "main" is `main/` at `42346154`. "self-evolving" is branch `self-evolving` in `self-evolving/` (at `5d39462f` when written; read it only through `git show`/`git diff` on committed refs, because a build is editing its working tree). Line numbers are approximate. Find each anchor again before editing.

**Vector Codium in one paragraph.** Vector is a free agentic coding workspace (desktop app, CLI, own keys, memory, subagents, Vectorscope, automations). Vector Codium is its managed monthly plan: Plus $10, Pro $50, Max $100, Ultra $200 (ids `vector-10`, `vector-50`, `vector-100`, `vector-200`). A plan gives models from several labs with zero data retention and no keys, a private monthly pool of model spend that is never published, and perks only Vector can offer. Usage shows only as a percentage, and Codium work shows the label "Codium" instead of tokens or a price. There are no top-ups.

---

## GitHub's terms: the short answer

**Yes, @vector is allowed as designed.** GitHub does not limit Actions to "simple CI/CD". Its Additional Product Terms, Actions section (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features, read 2026-10-27), forbid:
- on GitHub-hosted runners, activity unrelated to the production, testing, deployment or publication of that repository's software;
- offering Actions itself as a commercial product or service;
- cryptomining, serverless or CDN use, and putting a disproportionate burden on GitHub's servers.

An agent that fixes, reviews, tests or maintains the code of the repo it runs in is doing that repo's software work, on the user's own runner and minutes. Vector sells Codium model access inside the run, never Actions. Anything that is not repo work, such as the cloud computer or computer use for other tasks, must never run on Actions: it runs on compute Vector hosts. This is not legal advice, and the legal read stays an owner step.

---

## 0. Rules for every session

1. **Branches.**
   - **Track A** (everything that does not need 1.99.113): integration branch `codium` cut from main at `42346154`. Each work package (WP) goes on `codium/aNN-<slug>` off `codium` and merges back once its CI is green.
   - **Track B** (needs the unreleased 1.99.113 multi-agent and learned-skills work): branch `codium-113`, cut from `self-evolving` after the multi-agent build has committed its last WP and `codium` has been merged into it (WP B01). Never edit the self-evolving working tree.
2. **The Mac stays light.** The owner runs Vector on this Mac, and full test suites crashed it before. Locally run at most one test file at a time and the typecheck of the package you touched (for `api/`, the root `tsconfig.json`, which includes only `api/**`). Full suites, Playwright, the HttpApi exerciser, Stripe test-mode end-to-end and load checks run only in CI (WP A00). The repo is public: pushing a CI branch follows the owner's CI-branch approval (owner step 2).
3. **Never build:** Vector Labs (it is listed as "Coming" only); the @vector/GitHub cloud-agent pieces, which Codex builds on `vector-at-mention` (triggers, workflow generator, run tokens, Run in GitHub, scheduled runs, follow-ups, docs); Slack, Linear or Jira integrations (only the run-trigger interface in §4.17); team features; top-ups; annual prices.
4. **Never:** name any open-source project this code may derive from; print credentials, tokens or personal emails; publish a dollar amount or token count of included usage; let a paid perk depend on a client-side gate.
5. **Shared files.** Edits to `api/_lib/model-plan-*.ts` are listed in each commit body. Codex owns `api/cloud-agents/*`, `api/_lib/cloud-agents-*.ts`, `packages/core/src/review/workflow.ts`, `packages/engine/src/cli/cmd/github.*`, `packages/desktop/src/main/github-*.ts` and `api/_lib/github-oidc.ts`. Claude edits Codex's `api/_lib/cloud-agents-entitlement.ts` only in the integration commit (WP A59).
6. **Each WP is one commit, or a short series, with its tests.** Its done-criteria must hold before the next WP that depends on it starts.

---

## 1. The tiers

### 1.1 Tier table

Status legend: **L** listed when sales open; **S** listed once shipped (§4.14 gates); **C** shown with a "Coming" tag. Numbers come from `ENTITLEMENTS` (§4.1), never typed into copy.

| | **Plus $10** | **Pro $50** | **Max $100** | **Ultra $200** |
|---|---|---|---|---|
| **Headline perks** | @vector in your GitHub on Codium, no API key (S) · PR reviews checked by a second lab (S) · Codium Brain (S, Track B) · Vector Remote (S) | Second opinion with Pro's judges (L) · Brain Vault (S) · Vector Playbooks (S, Track B) | A cloud computer Vector runs for you (S) · Done by Morning (S) · @vector with more: 2 at once, 40 h, scheduled overnight runs, premium models (S) · Release Guard (S) · Ship Desk (S) | 3 cloud computers, 60 h, 12-hour jobs (S) · On Call (S) · The most Codium agent time: 6 at once, 120 h, 2-hour runs (S) · No daily limit (L) |
| **Models** (all ZDR) | DeepSeek V4.1 Flash (default), Codium Auto, Claude Haiku 5.5, GPT-6 Luna (256K) | + GPT-6.1 Sol, Kimi K3.1 Pro, Gemini 4 Argon, Kimi Long and Argon Long (256K) | + Claude Sonnet 5.5, Sol Deep, DeepSeek Long, Long contexts to 512K, fast lanes (Kimi, Argon) | + Claude Opus 5.5, Sol Deepest, Long contexts to 768K |
| **Coming** (C) | — | — | Vector Velocity | Vector Velocity, Vector Labs |
| Usage, multiple of Plus | 1x | 5.5x (10% more per dollar) | 12x (20% more) | 25x (25% more) |
| Longest context | 256K | 256K | 512K | 768K, or 512K if the launch test fails |
| Codium requests at once | 3 | 6 | 12 | 24 |
| Requests a minute | 30 | 60 | 120 | 200 |
| Daily limit (share of the month per UTC day) | 25% | 25% | 40% | none |
| When Codium is busy | waits | waits | first in line, one retry | same |
| @vector on Codium: at once / Codium agent hours a month / longest run / scheduled a day | 1 / 5 h / 30 min / — | 1 / 15 h / 45 min / — | 2 / 40 h / 45 min / 5 | 6 / 120 h / 120 min / 20 |
| One run's ceiling | 10% of the month, never above the daily limit | same | same | 10% |
| Second-lab PR reviews on Codium (panel judge) | yes (Haiku) | yes (Argon) | yes (Sonnet 5.5) | yes (Opus 5.5) |
| Second opinion judges | — | Sol, Argon | Sonnet 5.5, Sol Deep | Opus 5.5, Sol Deepest |
| Vector Remote: paired computers (also lists cloud runs) | 1 | 3 | 5 | 5 |
| Phone alerts | yes (S) | yes | yes | yes |
| Brain Vault | — | 10 GB | 25 GB | 50 GB |
| Cloud computer: at once / hours a month / longest job / disk kept | — | — | 1 / 20 h / 4 h / 7 days | 3 / 60 h / 12 h / 30 days, plus a large size that counts double |
| Done by Morning: jobs a night / at once / recurring a day | — | — | 3 / 1 / 5 | 10 / 3 / 20 |
| On Call: URLs / every / domains / fix runs a day | — | — | 5 / 5 min / 3 / 3 | 10 / 1 min / 10 / 10 |
| Release Guard: releases a day / watch | — | — | 10 / 30 min | 30 / 60 min |
| Ship Desk: cards a month / kept | — | — | 100 / 30 days | 400 / 90 days |
| Codium Brain helpers (Track B) | up to about 10% of the month | same | same | same |
| Roadmap vote | — | — | vote | vote, plus one nomination a quarter |
| Reports | paid tag, 15 an hour | same | read first, 30 an hour | same |
| Founding members (window only) | +10% usage, price lock, mark | same | price lock, mark | price lock, mark |

**Not offered:** GPT-6.1 Terra and GPT-6 Astra (and Astra Long). They are not ZDR on OpenRouter, the only route Vector uses (owner, 30 Oct; `codium-tiers-v3-changes.md` §8). Sol and its Deep and Deepest variants stay, listed once their OpenRouter ZDR endpoint is captured and accepted (§1.2).

**Every plan includes:** ZDR routing; no provider keys; no overage charges; **monthly plans only, no top-ups**; usage only as a whole percentage, with a forecast; "Codium" in place of tokens and prices; "upgrade and keep what's left of this month" (a precondition for opening sales, WP A09). When the month is used up, Codium stops until renewal, and your own keys, Vector Local and free models keep working.

**Stays free for everyone:** the desktop app and CLI; your own keys and free models; memory, learned skills and workflow insights; subagents and workflows you write; Vectorscope with your own key, including the three-lab panel and the "Checked by a second lab" line; automations; `vector serve`, `vector web`, `vector invite`; desktop notifications; `vector memory export`/`import`; the report tracker's status and "fixed in this version" notice; Race; distillation and "Bootstrap this repo" with your own model; outbound webhooks; @vector with your own key as a repo secret; Brain Vault's "back up to my own GitHub" backend.

**The new Max/Ultra perks** were chosen because only Vector can offer them, they are premium on their own, and none is about the Brain or RAG. Each keeps the owner whole: model use comes from the buyer's capped pool, hosted compute is charged into that pool at or above cost, and fixed hosting is a few cents per subscriber.
- **A cloud computer Vector runs for you** (working label; the product name follows the computer-use brand, `hands-build-spec.md` once written). Close the laptop and Vector finishes the job on a Vector-hosted microVM, with a live view, take-over, credential fields and CAPTCHAs always handed to you, and the browser profile wiped after each job. Never on GitHub Actions.
- **Done by Morning.** Queue jobs before bed with success criteria. A morning report shows what was done, links, a short recording and a second lab's pass or fail per criterion. Anything that would go live waits as a PR for you to merge.
- **On Call.** Vector checks your verified production URLs and domains, alerts your phone after two failures in a row, and on your tap starts a fix run in your own repo. "Vector's agent is on call, not a person."
- **Release Guard.** Each production release your host reports to GitHub is watched. If it breaks what the last release didn't, Vector opens a revert PR and alerts you; you merge it.
- **Ship Desk.** PRs from Codium runs become private cards with the checks, the judge's verdict and before/after screenshots, to approve from your phone.
- **Vector Velocity** (Coming): "Vector Velocity, Vector's premium coding model: only on Max and Ultra, when it launches." No date, never "available", not part of today's purchase.
- **Vector Labs** (Coming, Ultra): a name and a tag only. Nothing is built.

### 1.2 When each perk may be listed

| Perk | Listed when |
|---|---|
| Models, caps, priority, forecast, Second opinion, report tags, vote, founding | Sales open (WP A60). |
| @vector on Codium, scheduled runs, second-lab reviews in GitHub | Codex's work is in a published npm CLI, the integration commit (A59) is merged, and one live Codium run plus one scheduled run on a private test repo pass. "No repo secret" copy needs the GitHub App too. |
| Vector Remote | Outside security review done. |
| Phone alerts | Phone app (A38) shipped. |
| Brain Vault | Legal read and privacy update done. |
| Cloud computer, Done by Morning | Vercel's written OK, the computer-use build, the brand name, the security review of isolation and the viewer. |
| On Call, Release Guard, Ship Desk | GitHub App registered with Deployments: read and the webhook; ops Worker deployed; phone alerts listed (On Call, Ship Desk). |
| Codium Brain, Auto that learns, Playbooks, Brain in cloud runs | Track B shipped in a release (1.99.113 or later). Playbooks also need two proven playbooks. |
| Vector Velocity, Vector Labs | Always shown, always with the "Coming" tag. |
| Preview models (Ultra) | Only once a catalog entry has a future `previewUntil`. The gate is built, dormant. |
| GPT-6.1 Sol, Sol Deep, Sol Deepest | A committed capture of Sol's OpenRouter ZDR endpoint (exact provider tag, native context, output including reasoning, every price tier, `xhigh`/`max` effort) is reviewed and accepted in A60, and `ROUTE_ACCEPTANCES` is filled from it (`codium-tiers-v3-changes.md` §8). |

### 1.3 Taglines (computed)

Each tier has ordered variants. The page shows the first whose required perks are all listed (§4.14), so a tagline never names an unlisted perk.
- **Plus:** "No keys. Reviews checked by a second lab, @vector in your GitHub, and your agents on your phone." → "No keys. @vector in your GitHub and reviews checked by a second lab." → "No keys. Models from three labs, with an Auto mode that keeps easy work cheap."
- **Pro:** "Two labs checking each other's work, and your Brain kept safe." → "Two labs checking each other's work, with Sol, Kimi and Argon."
- **Max:** "Close the laptop. Vector finishes on a computer it runs for you." → "Close the laptop. @vector keeps working in your own repo, on your own Actions minutes." → "Claude Sonnet 5.5, Sol Deep and first place in line when Codium is busy."
- **Ultra:** "The most of everything: three cloud computers, the most Codium agent time and no daily limit." → "The most Codium agent time and no daily limit, with Claude Opus 5.5 and Sol Deepest."

Pro, Max and Ultra use premium styling; Plus is plain. Pro's badge reads "Recommended".

### 1.4 Owner cost per subscriber (estimates)

Inputs as v3 §3 (pools $6 / $33 / $72 / $150, Stripe fees, OpenRouter 5.5% unverified, gateway bound about 10.3¢ per pool dollar). New lines outside the pool, at the caps: ops checks (Max about $0.11, Ultra about $0.90), hosted control calls, R2 and recordings (about $0.25 on Max and Ultra; compute itself is charged into the pool at cost plus 10%), push (under 1¢), and Upstash commands if billed per command (up to about $0.05 / $0.26 / $0.58 / $1.20; about $0 on a fixed plan).

| | Plus | Pro | Max | Ultra |
|---|---|---|---|---|
| Typical profit (v3, 60% used) | $5.06 | $24.85 | $45.85 | $88.05 |
| Full-use profit (v3) | $1.87 | $8.13 | $9.60 | $13.80 |
| Full use, after the new lines (per-command Upstash) | about $1.82 (18%) | about $7.87 (16%) | about $8.66 (9%) | about $11.45 (6%) |

Every tier stays positive. Fraud is still the only losing case; 3-D Secure, the pool ramp and early-fraud handling (WP A10) are required before sales. Recompute after item Q (1 GB chat function, gzip) and the first month's measured cost.

---

## 2. Owner switches and what happens after each

| Owner sets | What happens automatically |
|---|---|
| **Nothing (today)** | /codium says "Coming soon" on every button. `/status` answers `enabled:false`. The gateway answers 503 `MODEL_PLANS_DISABLED`. |
| **Preview test environment:** a separate Upstash store with KV variables scoped to Preview only, `CODIUM_STRIPE_MODE=test`, a test runtime key, `MODEL_PLANS_ENABLED=true`, Vercel Deployment Protection on previews | Full Stripe test-mode runs. Every store key carries the `test` prefix, snapshots carry `livemode:false`, and a live gateway refuses them. OpenRouter keys are named `Vector test …` and capped at `CODIUM_TEST_CREDIT_CAP_USD` (default 0.50); production funding ignores them. Test checkout is open only to `VECTOR_ADMIN_EMAILS`. CI's dispatch-only e2e job can run. |
| **Stripe setup key** (local, owner only) runs `bun scripts/setup-model-plans.ts --apply` from `packages/web` | Four products and monthly prices (lookup keys `vector-models-{10,50,100,200}-monthly-v1`, `tax_behavior=exclusive`, statement descriptor `VECTORDEV CODIUM`), one no-change portal configuration, the webhook endpoint subscribed to exactly the 20 events in §4.5, leftover top-up prices archived. It prints the IDs and the webhook secret. |
| **Stripe runtime restricted key** (`rk_live_…`), webhook secret and price IDs in Production, `CODIUM_STRIPE_MODE=live` | The mode guard passes (a live key is refused unless `VERCEL_ENV=production`). Webhook, replay (every 10 min), outbox (every minute), sweeps (hourly risk, daily all) and funding (every 10 min) start working. Nothing is sold until `MODEL_PLANS_ENABLED=true`. |
| **Stripe dashboard:** Smart Retries with cancel after the last retry, customer emails for failed payments and for 3-D Secure, Terms of Service URL, Radar defaults (optional block list → `CODIUM_RADAR_BLOCKLIST_ID`) | Failed renewals retry and email the customer without Vector code. The owner page shows which of these the API can confirm. |
| **OpenRouter:** the separate Codium account, management key, starting balance, dashboard auto top-up and a backup card; the same threshold in `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD` | The funding cron compares the balance with what is owed plus reserved plus the largest plan plus margin. It pauses and reopens sales, warns at 1.25× required, alerts when auto top-up did not fire within 20 minutes, alerts on spend spikes, and shows days of runway. |
| **Client gates:** `MODEL_PLANS_MIN_CLIENT` (the first release carrying WPs A19–A26), `MODEL_PLAN_REQUIRE_MARKED_TOKENS` (default true), `MODEL_PLAN_GLOBAL_INFLIGHT`, `MODEL_PLAN_PRIORITY_RESERVE=0.2` | Older desktops and CLIs get `enabled:false` from `/models` and 426 from chat. If `MODEL_PLANS_MIN_CLIENT` is unset while sales are enabled, the compiled-in minimum applies (fail closed). Without a global cap there is no reserve, and "first in line" is not listed. |
| **`MODEL_PLANS_ENABLED=true` and redeploy** | Sales open, subject to the `sales` switch and the funding guard. From the first payment, everything in §4.4 happens with no person involved. Never set it back to false while anyone is subscribed: it stops the service. Use the `sales` and `codium` switches instead. |
| **Runtime switches** (owner page, no redeploy, effective within 30 s): `sales`, `codium`, `cloudAgents`, `hosted` (on / no-new / stop), `ops`, `remote`, `vault`, `push`, `perk-off:<id>`, `model-off:<id>` | `sales` off pauses checkout and upgrades (renewals continue). `codium` off makes the gateway refuse Codium; after 60 minutes off, active subscriptions get `pause_collection=void` so nobody is billed for a stopped service, and it is lifted when the switch returns. Service switches stop new work and, for `stop`, running work. A perk switched off disappears from /codium, the account page and Settings on the next config read. |
| **`CODIUM_LISTED_PERKS`** (comma list) and redeploy | That perk appears on /codium, the account page, Settings and docs, provided its runtime switch is on and its required perks are listed. |
| **GitHub App registered** (name other than "vector"; Deployments: read and the webhook from day one; `VECTOR_GITHUB_APP_*`, `VECTOR_GITHUB_APP_WEBHOOK_SECRET`) | Codex's OIDC binding works without a repo secret, the handle in copy comes from `VECTOR_GITHUB_APP_SLUG`, deployment and PR events reach the ops modules, and Release Guard, Ship Desk and On Call fix runs become listable. |
| **Cloudflare:** Workers Paid, R2 buckets `vector-vault` and `vector-media` (bucket-scoped tokens, lifecycle rules), KV namespaces, Worker secrets, `hosted-production` GitHub environment; dispatch `vector-hosted-deploy.yml` | The relay and ops Workers go live behind `VECTOR_REMOTE_ENABLED`, `VECTOR_OPS_ENABLED` and the runtime switches. Budget alerts email the owner. |
| **Vercel `vector-hosted` team**, Vercel's written OK, `VECTOR_HOSTED_PROVIDER=vercel`, image workflow run, `VECTOR_HOSTED_BASE_SNAPSHOT` | Cloud computers start for `VECTOR_HOSTED_ALLOW_ACCOUNTS` first, then for every Max and Ultra subscriber when the `hosted` switch is on. The spend webhook drains at 75% and stops at 100%. The budget workflow raises the team budget as subscribers grow, if `VECTOR_HOSTED_BUDGET_AUTOMATION=true`. |
| **Vercel main team:** Spend Management budget, notify-only webhook to `/api/owner/spend-vercel` | Owner email at thresholds. "Pause production deployments" stays off: it would take vectordev.ai offline. |
| **VAPID keys and the `remote.vectordev.ai` domain** | The phone app and Web Push work. |
| **Supabase SQL** (`docs/vector/owner-actions/sql/brain-vault.sql`, `hosted.sql`) | Vault and hosted tables exist. |
| **Upstash plan** | A fixed plan removes the per-command cost line (§1.4). |

---

## 3. Invariants

Each invariant has a test that runs in CI. A WP that touches the invariant's code must keep its test green.

**Money**
- **M1. The provider key is the hard cap.** Every Codium OpenRouter key's limit equals `credits + carry − debits` (integer micro-dollars, PATCHed rounded to cents, compared within half a cent). Test: `test/codium-pool.test.ts` (no repair to plan credits; carry and debits kept; 73.936 vs 73.94 causes no PATCH).
- **M2. Spend is held before it starts.** Model requests, hosted blocks and any other pool charge place a hold in the same held set. A hold's set TTL only ever grows. Test: a 12 h hold survives a later 660 s hold; two settles racing lose no debit; a failed PATCH is retried and the charge stays held until applied.
- **M3. Available is the same figure everywhere:** `credits + carry − debits − usage − held`, in the fast path, provisioning, `requireMonthlyCredits`, status and funding. Test: hosted spend lowers status `left` and refuses a model hold.
- **M4. No Stripe call on a hot path.** With a fresh snapshot, chat, `/models`, status, `requireEntitlement`, run-token checks and hosted checks make zero calls to `api.stripe.com`. Test: fetch spy; 100 concurrent requests at period end make one Stripe call; an account with no plan makes at most one a minute.
- **M5. Access ends when payment ends.** Past due, unpaid, a full refund, a dispute (on any Codium charge, not only the latest) and an early-fraud warning disable the key within one reconcile, and provisioning never re-enables a key while `risk` holds it. Test: Stripe fixtures in `test/codium-billing.test.ts`; an EFW followed by `invoice.paid` stays frozen.
- **M6. An upgrade never grants twice.** Carry is `max(0, oldLimit − usage − held)` once, only from a paid, unreversed period of the same customer, and only goes up at the true-up. The superseded subscription is cancelled exactly once and its open invoices are voided and drafts deleted. Test: replayed upgrade; past-due old subscription refuses the upgrade; refund of the source charge drops the carry.
- **M7. No renewal charge Vector should not take.** The early finalize and pay of a renewal runs only for the governing, unfrozen, unblocked, not-superseded subscription while `codium` is on and the balance covers what is owed; otherwise collection is paused. Test: each of the five refusals.
- **M8. Hosted compute never loses money.** Each hosted minute is charged into the pool at no less than the provider's worst-case cost (`hosted-rates.ts`), the true-up never goes below cost, and a block cannot start without its hold. Test: `test/hosted-ledger.test.ts`.
- **M9. Owner-side spend has a guard on every provider.** OpenRouter: funding cron. Vercel hosted team: spend webhook escalates only, budget never lowered within a cycle, sandboxes without a live session row are stopped. Cloudflare: per-perk meters and the `ops` switch. Test: funding thresholds; spend webhook escalation; budget calculation; orphan reaper.
- **M10. Test mode cannot touch production money.** Test snapshots are refused by a live gateway; test keys are capped and excluded from live funding. Test: `test/codium-mode.test.ts`.
- **M11. A renewal never locks out someone who pays.** During `renewing`, the previous key serves until `periodEnd + grace`. Test: test-clock fixture; no 402 across the renewal hour.
- **M12. Pausing sales never affects existing subscribers.** Renewals, upgrades already paid and service continue. Test: `sales` off, renewal still charged and served.
- **M13. Founding numbers are idempotent.** A replayed or parallel `invoice.paid` assigns one number and counts once. Test: two parallel webhooks.

**Security**
- **S1. Paid perks are enforced on the server from the snapshot.** No client flag grants anything. Test: a patched client asking for a locked model, a Remote pairing over the count, a Vault upload over quota, a hosted session on Pro, a vote on Pro: all refused.
- **S2. Only marked tokens spend Codium.** Chat accepts desktop tokens, `cli` tokens minted through the new CLI's code exchange, and run tokens. Copy-paste tokens from `/auth/cli` and pre-launch tokens get 401 at chat and still work for free models and status. Test: `test/model-plan-caller.test.ts`.
- **S3. Run tokens have their own domain.** `vrt_` (Codex) and `vht_` (hosted) tokens are accepted only at chat, `/models` and their own service endpoints, never at status, checkout, portal, profile or deletion. Test: refusal matrix.
- **S4. Every webhook verifies its signature over the raw body** (Stripe HMAC-SHA256; Vercel HMAC-SHA1 hex with a per-team secret; GitHub `x-hub-signature-256`) and is idempotent. Test: bad signature, replay.
- **S5. Owner endpoints** need a Google owner session (`requireUsageOwner`), and mutations need a sign-in under 10 minutes old, taken from the OAuth `amr` timestamp, not the JWT `iat`. Test: refresh-token session refused for a switch change.
- **S6. Remote cannot widen permissions.** The relay sees only ciphertext; approvals are verified on the desktop; the phone can allow once or deny, never "always"; turns started from the phone are never auto-approved; a revoked account cannot mint a ticket and its sockets close. Test: route allowlist, passkey, auto-approve and revocation tests.
- **S7. The hosted VM holds no long-lived credential.** Egress is limited by root-owned nftables that fail closed; the run-API host refuses requests carrying `Origin`, `Sec-Fetch-*` or cookies; GitHub tokens exist only inside hostd's git operations while the agent is stopped. Test: image test job.
- **S8. Outbound fetches refuse private, loopback, link-local and metadata addresses and do not follow redirects** (ops probes, domain verification, push endpoints). Test: SSRF list.
- **S9. Vector's server never merges.** Server writes to user repos are limited to opening a revert PR or a PR branch, only where `.vector/ops.json` opts in, re-read before every write. Test: missing opt-in refuses; workflow files in range refuse.

**Privacy**
- **P1. No amount leaves the server.** Status, `/models`, estimate, errors, owner-less pages and the account page carry shares, counts and public caps only. Test: JSON scan for `$`, `usd`, `credit`, `cents`, numbers outside 0..1 except caps from `ENTITLEMENTS` and timestamps.
- **P2. The estimate cannot reveal the pool.** Inputs are clamped and rounded to steps 1.5× apart, answers are bands. Test: a binary search cannot resolve finer than one step.
- **P3. Vault is end-to-end encrypted.** The server never holds the vault key or plaintext. Test: `packages/core/src/vault/vault.test.ts`.
- **P4. Report records never store the message text.** Test: stored record fields.
- **P5. Account deletion erases every Codium and hosted record** (tombstone first, retried by cron), except pseudonymous financial ledger lines. Test: `test/account-delete.test.ts` extended.
- **P6. Codium runs never publish the subscriber's usage.** PR bodies, comments and logs show "Codium", never a usage share or plan name. Test: Codex contract test at merge (A59).
- **P7. Push payloads carry titles only;** desktop alerts are end-to-end encrypted. Test: `test/web-push.test.ts`.

**Honesty**
- **H1. A perk shows only when listed** (§4.14). Test: `CodiumPricing.test.ts` listing cases; account and Settings use the same `listed` set.
- **H2. Velocity and Labs copy.** Always "Coming"; never "available", "included", "free", "guaranteed", a date, month, quarter, "soon", a parameter count, "built on", "based on" or a provider name. Labs has no link. Test: copy guard across web, app, CLI and status strings.
- **H3. No "exclusive", "every PR", "every pull request", "guaranteed", "24/7", "SLA" or uptime or response-time promise.** Test: copy guard.
- **H4. Cloud-agent copy always says "in your own repo, on your own Actions minutes"** and never "hosted", "compute", "cloud hours", "cloud capacity" or "our cloud". Cloud-computer copy never mentions GitHub or Actions. Test: copy guard.
- **H5. Usage is a whole percentage, and the same figure everywhere.** `used + left = 100`; meters report `aria-valuenow` as the share left. Test: `codium-usage-model.test.ts`.
- **H6. The free workspace stays free.** Free-workspace rows read "Included". Test: `CodiumPricing.test.ts`.
- **H7. Old clients keep working.** Status always sends `purchased:{bought:false}`, `empty` and `low`; the 1.99.111 and 1.99.112 decoders, kept as fixtures, decode every new status and config answer. Test: `packages/core/test/model-plan-status-compat.test.ts`.
- **H8. Legal pages change only in a release commit** that bumps both dates. Test: content hash per date in `test/codium-legal.test.ts`.

---

## 4. Shared interfaces (defined once)

### 4.1 Plans and `ENTITLEMENTS`

`packages/schema/src/codium-plan.ts` keeps `PLANS` and adds `PlanId` and `rank(id)`. `TOPUPS` is emptied and then deleted. New browser-safe `packages/schema/src/codium-entitlements.ts` (namespace `CodiumEntitlements`, exported as `@vectordevai/schema/codium-entitlements`). It holds counts, hours, shares and flags only, never dollars, and is importable by `api/`, the app, the CLI and the Workers.

```ts
export type PlanId = "vector-10" | "vector-50" | "vector-100" | "vector-200"
export type Entitlements = {
  rank: 1 | 2 | 3 | 4
  usageMultiple: number                       // 1, 5.5, 12, 25 (public; the page renders from it)
  inFlight: number                            // Codium requests at once, all callers
  perMinute: number
  dailyShare: number | null                   // share of the month per UTC day; null = none
  contextMax: number
  priority: boolean                           // global reserve + one retry
  fastLanes: boolean
  previewModels: boolean                      // dormant until an entry has a future previewUntil
  purposeShare: { brain: number }             // 0.10
  cloudAgents: { atOnce: number; hours: number; longestRunMin: number; scheduledPerDay: number; runCeilingShare: number }
  remote: { computers: number }
  vault: { gb: number; versionDays: number }
  hosted: null | { computers: number; hours: number; jobMin: number; diskDays: number; sizes: ("standard" | "large")[] }
  overnight: null | { perNight: number; atOnce: number; recurringPerDay: number }
  ops: null | {
    onCall: { urls: number; intervalSec: number; domains: number; fixRunsPerDay: number }
    releaseGuard: { perDay: number; watchMin: number; paths: number }
    shipDesk: { cardsPerMonth: number; keepDays: number; images: number }
  }
  secondOpinion: boolean
  playbooks: boolean
  vote: boolean
  nominate: boolean
  reports: { tag: "plus" | "pro" | "max" | "ultra"; perHour: number; readFirst: boolean }
  foundingBoost: number | null                // applies only to founding subscriptions
  velocity: null | "coming"
  labs: null | "coming"
}
export const ENTITLEMENTS: Record<PlanId, Entitlements>
export function publicEntitlements(plan: PlanId, listed: ReadonlySet<PerkId>): Partial<Entitlements>
```

| Field | Plus | Pro | Max | Ultra |
|---|---|---|---|---|
| rank / usageMultiple | 1 / 1 | 2 / 5.5 | 3 / 12 | 4 / 25 |
| inFlight | 3 | 6 | 12 | 24 |
| perMinute | 30 | 60 | 120 | 200 |
| dailyShare | 0.25 | 0.25 | 0.40 | null |
| contextMax | 262144 | 262144 | 512000 | 768000 |
| priority / fastLanes / previewModels | f / f / f | f / f / f | t / t / f | t / t / t |
| purposeShare.brain | 0.10 | 0.10 | 0.10 | 0.10 |
| cloudAgents (atOnce / hours / longestRunMin / scheduledPerDay / runCeilingShare) | 1 / 5 / 30 / 0 / 0.10 | 1 / 15 / 45 / 0 / 0.10 | 2 / 40 / 45 / 5 / 0.10 | 6 / 120 / 120 / 20 / 0.10 |
| remote.computers | 1 | 3 | 5 | 5 |
| vault.gb / versionDays | 0 / 30 | 10 / 30 | 25 / 30 | 50 / 30 |
| hosted | null | null | 1 / 20 / 240 / 7 / [standard] | 3 / 60 / 720 / 30 / [standard, large] |
| overnight | null | null | 3 / 1 / 5 | 10 / 3 / 20 |
| ops.onCall | null | null | 5 / 300 / 3 / 3 | 10 / 60 / 10 / 10 |
| ops.releaseGuard | | | 10 / 30 / 5 | 30 / 60 / 5 |
| ops.shipDesk | | | 100 / 30 / 8 | 400 / 90 / 8 |
| secondOpinion / playbooks | f / f | t / t | t / t | t / t |
| vote / nominate | f / f | f / f | t / f | t / t |
| reports | plus / 15 / f | pro / 15 / f | max / 30 / t | ultra / 30 / t |
| foundingBoost | 1.1 | 1.1 | null | null |
| velocity / labs | null / null | null / null | coming / null | coming / coming |

The per-run ceiling is clamped on the server to `dailyShare` when one exists. Free accounts have no entry (free reports: 5 an hour per IP).

### 4.2 Server-only limits

`api/_lib/codium-limits.ts` (not shipped to clients; env-overridable where named):
- **Trust ramp** (`CODIUM_TRUST_RAMP_DAYS=7`): for 7 days after `firstHighPaidAt` (the first paid invoice of a rank ≥3 price, so a Plus→Ultra upgrade starts it and Max→Ultra does not), hosted hours ×0.25, 1 computer, jobs ≤120 min; hosted browser use from 24 h after that payment. A gap of more than 14 days without a paid period restarts it.
- **Pool ramp:** when that first rank ≥3 payment's `payment_method_details.card.three_d_secure.result` is not `authenticated`, the key limit is 30% of credits for 72 h (raised by an outbox job), and Ultra gets a 40% daily share for that first period.
- **Remote:** 5 phones; viewer-hours per period 60 / 100 / 200 / 200; awake-hours per account at most 1.5× viewer-hours; viewers idle 30 min closed; frames ≤64 KiB and ≤20 a second.
- **Hosted abuse:** 600 page loads an hour; egress to anything except Vector's run-API host 5 GB a day on Max, 15 GB on Ultra; suspended after 30 min above 80% CPU with no model call; take-over at most 30 min at a time.
- **Grace:** `CODIUM_RENEWAL_GRACE_MINUTES=120` (max 360).
- **Hosted rates** live in `api/_lib/hosted-rates.ts` (§WP A51), imported only by `api/`.

### 4.3 The plan cache: `EntitlementSnapshot`

Types in `packages/schema/src/codium-entitlements.ts`; functions in new `api/_lib/codium-entitlements.ts`. Only reconcile writes a snapshot. Every other service reads it.

```ts
export type PlanState = "none" | "active" | "renewing" | "paused" | "ended" | "frozen"
export type PlanReason =
  | "payment_failed" | "action_required" | "payment_pending"
  | "canceled" | "refunded" | "disputed" | "early_fraud_warning" | "closing" | "owner"
export type EntitlementSnapshot = {
  v: 1; version: number; livemode: boolean; account: string
  state: PlanState; reason?: PlanReason
  plan: PlanId | null; subscription?: string
  periodStart: number; periodEnd: number            // ms
  meterEpoch: string                                // `${subscription}:${periodStart}`; new at every new period, including an upgrade
  cancelAtPeriodEnd: boolean
  scheduled?: { plan: PlanId; at: number }          // downgrade at renewal
  founding?: { number: number; boost: boolean }
  firstPaidAt?: number; firstHighPaidAt?: number; memberSince?: number   // memberSince: start of an unbroken Max/Ultra run; private
  ramp: { hostedUntil: number; poolUntil?: number; browserFrom: number }
  revokedBefore?: number                            // run tokens and relay sessions issued earlier are invalid
  caps: Entitlements                                // effective caps, ramp applied
  updatedAt: number; checkedAt: number
  source: "webhook" | "replay" | "sweep" | "request" | "owner" | "outbox"
}
```

```ts
// api/_lib/codium-entitlements.ts — never calls Stripe except through reconcileOnDemand
readEntitlement(account, fetcher?): Promise<EntitlementSnapshot | undefined>
requireEntitlement(account, perk: keyof Entitlements | "codium", fetcher?): Promise<EntitlementSnapshot>
  // throws 402 MODEL_PLAN_REQUIRED | MODEL_PLAN_PAYMENT_REQUIRED {reason, action?}, 403 CODIUM_PERK_REQUIRED {perk, plan},
  //        503 MODEL_PLAN_RENEWING (retry-after 30)
meterKey(s, name): string                           // vector:codium:<mode>:meter:<account>:<meterEpoch>:<name>
meterAdd(s, name, amount, cap): Promise<{ ok: boolean; used: number }>   // atomic check-and-add, expires periodEnd + 40 days
isStale(s, now?): boolean                           // > 6 h old, or past periodEnd (renewing: recheck at most every 60 s)
reconcileOnDemand(account, fetcher?): Promise<EntitlementSnapshot | undefined>   // at most once a minute per account
onEntitlementChange(listener): void                 // registry used by provisioners (§4.8)
```

**Read rules.** Missing snapshot: one on-demand reconcile, and a `state:"none"` snapshot is cached 60 s. Stale or past `periodEnd`: serve the snapshot and run one reconcile (at most one a minute per account). `ended` and `paused` snapshots written by reconcile are trusted. The gateway refuses a snapshot whose `livemode` does not match the server's Stripe mode. After a checkout or `/change` opened in the last hour, a 403 for a model above the snapshot's tier first runs one reconcile.

**Account record** (private, `vector:codium:<mode>:account:<id>`): customer; key `{hash, encrypted, name, creditsMicro, carry?: {micro, fromSubscription, fromStart, fromCharge}, limitMicro, expiresAt, subscription, start, end}`; `risk {blocked, reason, at, openDisputes: Record<chargeId, {status, at}>, efw: chargeId[]}`; `highValueVerified`, `firstPaidAt`, `firstHighPaidAt`, `memberSince`, `closing`. Debits live only in the hash `…:debits:<id>:<keyHash>` (ref → `{micro, applied}`), never in the account JSON.

### 4.4 State machine and what each state does

**Stripe → state** (reconcile reads current Stripe state under `withCodiumLease`; the governing subscription is the paid one with the highest rank, honouring `vector_supersedes`; any other duplicate alerts the owner):

| Stripe | State / reason |
|---|---|
| no subscription, `incomplete`, `incomplete_expired` | none |
| current period's invoice paid and unreversed | active (`cancelAtPeriodEnd` from Stripe) |
| period ended, latest invoice draft or open with `attempt_count` 0 | renewing, until paid, `past_due`, or `periodEnd + grace` |
| renewing past `periodEnd + grace`, not yet `past_due` | paused / payment_pending |
| `invoice.payment_action_required` | paused / action_required (action opens `hosted_invoice_url`) |
| `past_due` | paused / payment_failed (action opens the portal's `payment_method_update` flow) |
| `unpaid` | ended / payment_failed |
| `canceled` | ended / canceled |
| full refund of the current period's charge | ended / refunded (owner page "Refund and end" also cancels) |
| partial refund | no change (goodwill; owner docs say never refund partially to end a plan) |
| open dispute on any Codium charge (`risk.openDisputes`) | frozen / disputed; `pause_collection[behavior]=void` set |
| dispute won or `warning_closed` | back to the Stripe-derived state; `pause_collection` removed |
| dispute lost | ended / disputed; `risk.blocked`; subscription cancelled |
| early-fraud warning | frozen / early_fraud_warning; if actionable and `CODIUM_EFW_REFUND=true`: refund the warned charge (reason `fraudulent`) and the current period's charge if it is a different charge on the same card, cancel at once → ended / early_fraud_warning, `risk.blocked`; optional Radar block list |
| `risk.blocked` or owner freeze | frozen / owner |
| account deletion | ended / closing |

**Per-service policy** (each provisioner implements its row and converges):

| | active | renewing | paused | ended | frozen |
|---|---|---|---|---|---|
| Codium models | on | previous key until `periodEnd + grace`, then 503 RENEWING | 402 PAYMENT_REQUIRED {reason} | 402 REQUIRED | key disabled at once |
| @vector run tokens (Codex) | caps | new mints allowed | new mints refused; running runs get 402 on their next request | refused | tokens before `revokedBefore` invalid |
| Remote relay | on | on | paid sessions refused (`vector serve` stays free) | refused | sockets closed |
| Phone alerts | on | on | off | off | off |
| Brain Vault | quota | on | uploads refused, restore allowed | read-only 30 days with an in-app and email notice, then deleted | uploads frozen, nothing deleted |
| Cloud computer | caps (ramp) | running jobs continue, no new ones | running jobs wrap, snapshot and stop within 5 min; queue paused | disks kept 14 days for download (notice), then deleted | everything stopped; disks kept until the dispute closes, deleted 30 days after a loss |
| Done by Morning | caps | started jobs continue | queue paused | queue cancelled | queue cancelled |
| On Call | caps | on | checks and alerts continue through Stripe's retry window; fix runs off | stops at period end | off |
| Release Guard | caps | on | no new watches; open revert PRs stay | off | off |
| Ship Desk | caps | on | no new cards; cards readable until expiry | same | cards and images hidden, not deleted |
| Founding | kept | kept | kept (a recovered payment keeps it) | ends on `customer.subscription.deleted` | hidden from the founders page |
| Report tag, vote, Playbooks downloads, judges | on | on | off | off | off |

**Meters** are keyed by `meterEpoch`. Every new period starts a new epoch, including the new period an upgrade creates. A downgrade takes effect at the renewal its schedule bills. A won dispute restores the same epoch.

**Upgrade** (`/change` to a higher plan; WP A09): allowed only while the account is active, has no open invoice, is not past due or frozen, has no scheduled downgrade, `sales` is on and funding can reserve the sale. It creates a Checkout Session with `subscription_data[metadata][vector_supersedes]` set by the server. When paid: the old key is disabled; carry = `max(0, oldLimit − usage − held)` if the old period was paid and unreversed, else 0; new key limit = new credits + carry; the old subscription is cancelled at once (`prorate=false`, `invoice_now=false`) inside reconcile, retried by the outbox, and its open invoices voided and drafts deleted; a `carry-trueup` job 12 minutes later raises the limit to `oldLimit − finalUsage` and never lowers it; meters start fresh at the new caps (the user paid a full new month). Carried credits end at the next renewal.

**Downgrade:** a subscription schedule (phase 1 current price to period end, phase 2 lower price, `end_behavior=release`); the snapshot shows `scheduled`. `DELETE /change` releases it. Before opening the portal's cancel flow, a schedule is released.

**Renewal:** `invoice.created` (`subscription_cycle`) → outbox action `finalize-renewal` → finalize and pay (idempotency `vector-finalize-<in>`, `vector-pay-<in>`) only when M7's guards hold; otherwise skip, alert, and set `pause_collection=void` for frozen, superseded or `codium`-off accounts. On `invoice.paid`: a new key at full credits, carry 0, new `meterEpoch`, old key disabled. The old key's `expires_at` is `periodEnd + grace`.

### 4.5 Stripe webhook events

`MODEL_PLAN_WEBHOOK_EVENTS` (exactly 20, so one replay call can list them): `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_reinstated`, `radar.early_fraud_warning.created`, `radar.early_fraud_warning.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`. The type filter in `api/model-plans/webhook.ts` matches these prefixes, including `radar.` and `subscription_schedule.`. Handlers route on `type`, `data.object.id` and `customer` only, and re-fetch objects at the pinned API version `2025-02-24.acacia`.

**Webhook order:** verify signature → for `invoice.created`, enqueue `finalize-renewal` and answer 200 even if the store is down → otherwise reconcile within an 8 s budget; on success set `stripe:event:<evt>` (done marker, 35 days) and answer 200; on failure enqueue a durable `reconcile:<account>` item and answer 200 if the enqueue succeeded, else 500 so Stripe retries. Side effects are deduped by snapshot version, not by event id.

### 4.6 Store keys

One helper, `codiumKey(...parts)` in `api/_lib/codium-keys.ts`, prefixes every Codium key with `vector:codium:<live|test>:`. Existing `vector:model-plans:*` and `vector:codium:*` keys move under it (sales never opened, so nothing live migrates; preview stores are flushed).

| Key (after the prefix) | Holds |
|---|---|
| `account:<id>` | private record (§4.3) |
| `ent:<id>` | snapshot |
| `idx:period-end` | ZSET for sweeps |
| `stripe:event:<evt>`, `stripe:cursor` | done markers, replay cursor |
| `outbox`, `outbox:item:<id>`, `outbox:dead`, `outbox:lock`, `prov:<provisioner>:<id>` | outbox and last applied version |
| `held:<poolHash>` | holds; member `<ticket>:<purpose>:<runId or ->:<micro>` |
| `day:<poolHash>:<YYYY-MM-DD>` | HASH `total`, `brain` (settled micro; also the forecast history) |
| `purpose:<poolHash>` | HASH per purpose for the period |
| `run:<runId>` | per-run spend (EX 3 days) |
| `debits:<id>:<keyHash>` | hosted and other pool debits |
| `inflight:<id>`, `inflight:global` | ZSETs of in-flight requests |
| `meter:<id>:<meterEpoch>:<name>` | per-period counters |
| `switch:<name>`, `switch:audit`, `models-off`, `perks-off` | runtime switches |
| `funding`, `funding:history` | funding readings (7 days) |
| `owner:alert:<kind>` | alert dedupe |
| `founding:count`, `founding:member:<id>`, `founding:reserved:<session>`, `sales-opened-at` | founding |
| `status:<id>` | status cache (30 s, cleared by reconcile) |
| `reconcile:<id>` | one on-demand reconcile a minute |
| `notify:subs:<id>` | push subscriptions (≤10) |
| `reports:<id>`, `reports:acct:<hash>` | report metadata, index for deletion |
| `roadmap:<yyyy-qn>:{ballot,ballots,nominations}` | vote |
| `hosted:running:<id>`, `hosted:jobs:due`, `hosted:minutes:<id>:<meterEpoch>` | hosted |
| `ops:{incident,card,audit,rg,cards}:*` | ops |
| `tombstone:<id>` | deletion in progress |

### 4.7 Pool, holds and admission

- `expectedLimit = creditsMicro + carryMicro − Σ applied debits`. Displays use `total = credits + carry`, `spent = key.usage + debits`.
- **ADMIT** (one Lua script, one round trip, `api/_lib/model-plan-admit.ts`): purge expired members; check, in order, the account in-flight set (`MODEL_PLAN_CONCURRENCY`), the global set whose last `MODEL_PLAN_PRIORITY_RESERVE` is kept for rank ≥3 (`MODEL_PLAN_BUSY`), monthly `available − held ≥ required` (`MODEL_PLAN_EXHAUSTED`), daily `day.total + heldToday + required ≤ dailyShare × total` (`MODEL_PLAN_DAILY_LIMIT`), purpose `brain` share (`MODEL_PLAN_BRAIN_SHARE`), and run `run + runHeld + required ≤ ceiling` (`MODEL_PLAN_RUN_LIMIT`). Then it adds every member with one deadline (admission + 660 s), extending each set's TTL to the larger of current and new.
- **SETTLE:** replace the hold with the settled charge for 30 s, `HINCRBY day total` (and `brain`), `INCRBY run`. A stream that breaks off adds the hold amount to the day and run buckets (errs toward refusing).
- **holdPool(account, usd, ttlMs, purpose)** for hosted and any non-model charge: same set; `settle(chargedUsd, ref)` writes the debit, PATCHes the limit under the lease, then marks it applied; the hold stays until applied.

### 4.8 Outbox, provisioners and gateway hooks

```ts
// api/_lib/codium-provision.ts
type TransitionCause = "first_payment" | "renewal" | "upgrade" | "downgrade" | "payment_failed" | "payment_recovered"
  | "cancel_scheduled" | "ended" | "refunded" | "disputed" | "dispute_won" | "early_fraud_warning" | "closing" | "owner"
type Transition = { account: string; from?: EntitlementSnapshot; to: EntitlementSnapshot; cause: TransitionCause }
interface PerkProvisioner { id: string; configured(): boolean; apply(t: Transition, fetcher?: typeof fetch): Promise<void> }  // idempotent, converges to t.to
registerProvisioner(p): void        // static list in api/_lib/codium-provisioners.ts
enqueueAction(kind: "reconcile" | "supersede" | "carry-trueup" | "finalize-renewal" | "pool-ramp" | "pause-collection" | "debit-apply", key, payload, at?): Promise<void>
drainOutbox({ budgetMs = 50_000, now }): Promise<{ applied: number; retried: number; dead: number }>
```
The snapshot write and one outbox item per configured provisioner happen in one EVAL. Freeze and revoke items use a priority lane. Ten attempts with backoff, then a dead letter and an owner alert. The daily sweep re-enqueues any provisioner whose `prov:` version is behind the snapshot. Provisioners: `github-runs` (`revokedBefore`), `remote`, `push`, `vault`, `hosted`, `ops`, `founding`, `owner-notify`.

```ts
// api/_lib/model-plan-caller.ts — gateway hooks (static imports)
type ModelPlanCaller = { account: { id: string }; kind: "desktop" | "cli" | "run"; purpose: Purpose
  run?: { id: string; source: RunSource; deadline: number; ceilingShare?: number; service: "cloud-agents" | "hosted"; sessionId?: string } }
registerRunVerifier(prefix: "vrt_" | "vht_", verify: (token: string) => Promise<ModelPlanCaller>): void
beforeAdmit(caller, { snapshot, model, toolNames }): Promise<void>     // throw ApiError to refuse
afterSettle(caller, { snapshot, model, charge?, startedAt, endedAt, streamed }): Promise<void>
```
The gateway itself refuses a run-token request whose tool list contains computer-use tool names (`purpose` cloud-agents), and requests with purpose `hosted` while `assertHostedSessionLive(sessionId)` fails (409 `HOSTED_SESSION_PAUSED`).

### 4.9 Tokens and client headers

- **Account tokens** (`api/_lib/cli-token.ts`): `client: "desktop"` (unchanged) or `client: "cli"`, minted only by the new CLI's code exchange (`api/account/cli-exchange.ts` gains a `cli` purpose) and never displayed; `cli` tokens carry a `jti` and can be revoked singly. Tokens shown on `vectordev.ai/auth/cli` stay unmarked: free models only.
- **Run tokens:** `vrt_` (Codex, HMAC domain `vector-run-v1`) and `vht_` (hosted, domain `vector-hosted-v1`).
- **Headers new clients send** on catalog, chat and status reads (desktop, CLI, TUI, Core V2 runner): `X-Vector-Client: <version>`, `X-Vector-Catalog: 2`; on chat also `X-Vector-Purpose: chat | title | brain | review | judge | race | playbook | task` (a run token's purpose overrides it; unknown counts as `task`). Never gate money on these headers alone.

### 4.10 Error codes

Body `{error:{code, message, ...}}`. "Kind" is the client mapping in `packages/core/src/model-plans.ts`.

| Status | Code | Kind / client behaviour |
|---|---|---|
| 400 | `MODEL_PLAN_MODEL`, `MODEL_PLAN_CONTEXT`, `MODEL_PLAN_ATTACHMENT` | unchanged |
| 401 | `CODIUM_SIGN_IN_REQUIRED` | sign-in (forces a fresh desktop sign-in or `vector login`) |
| 401 | `MODEL_PLAN_RUN_EXPIRED` | run: commit and open a draft PR |
| 402 | `MODEL_PLAN_REQUIRED`, `MODEL_PLAN_PAYMENT_REQUIRED {reason, action?}`, `MODEL_PLAN_EXHAUSTED` | credits: "See plans" without a plan, "Change plan" or "Update card" by reason; never retried |
| 402 | `MODEL_PLAN_CAPACITY` | capacity |
| 403 | `MODEL_PLAN_UPGRADE_REQUIRED {plan, planName, previewUntil?}` | upgrade: Change plan; never retried. An account without a plan gets 402 REQUIRED first |
| 403 | `CODIUM_PERK_REQUIRED {perk, plan}`, `MODEL_PLAN_BLOCKED` | upgrade / contact |
| 409 | `MODEL_PLAN_EXISTS` (checkout with a subscription), `MODEL_PLAN_CHANGE_UNAVAILABLE` (old portal `flow:"change"`, or an upgrade refused) | opens the plan picker or vectordev.ai/account |
| 409 | `HOSTED_SESSION_PAUSED` | wait while the user has control |
| 410 | `MODEL_TOPUP_REMOVED` (JSON, `/api/model-plans/topup`) | — |
| 426 | `CODIUM_UPDATE_REQUIRED` | unavailable: "Update Vector to keep using Vector Codium." |
| 429 | `RATE_LIMITED`, `MODEL_PLAN_BUSY` | retry |
| 429 | `MODEL_PLAN_CONCURRENCY` (retry-after-ms 1500–4000 + jitter) | wait: retried up to 15 min without counting attempts |
| 429 | `MODEL_PLAN_DAILY_LIMIT` (retry-after to 00:00 UTC) | daily: not retried |
| 429 | `MODEL_PLAN_RUN_LIMIT {limit: "ceiling" \| "hours" \| "at-once"}`, `MODEL_PLAN_BRAIN_SHARE` | run / skip quietly: not retried, not a credit code |
| 503 | `MODEL_PLAN_RENEWING` (retry-after 30) | retried like busy |
| 503 | `MODEL_PLAN_MODEL_UNAVAILABLE` | "temporarily unavailable; pick another model" |
| 503 | `MODEL_PLANS_DISABLED`, `CODIUM_SALES_PAUSED` | unavailable |
| service | `HOSTED_NOT_INCLUDED` 403, `HOSTED_BUSY` 429, `HOSTED_HOURS_USED` 402, `HOSTED_PAUSED` 402, `HOSTED_FROZEN` 403, `HOSTED_UNAVAILABLE` 503, `REMOTE_DEVICE_LIMIT`, `REMOTE_REVOKED`, `REMOTE_FAIR_USE`, `REMOTE_PAUSED`, `VAULT_QUOTA` 402, `VAULT_SIZE_MISMATCH` 409, `VAULT_READ_ONLY` 409, `OPS_DOMAIN_UNVERIFIED` 403, `OPS_LIMIT` 429, `OPS_PAUSED` 503 | plain copy, no amounts |

`MODEL_TOPUP_EXHAUSTED` is never sent again. The engine's credit-code suffix becomes " See plans at <url>".

### 4.11 Status API

`GET /api/model-plans/status` (account token or desktop token; cached 30 s per account, cleared by reconcile). Every value is a share in 0..1 rounded to 0.01, a public count, or a timestamp.

```ts
{ enabled: boolean; active: boolean; access: boolean; customer?: boolean
  plan?: { id; name; left: number; renewsAt; cancelAtPeriodEnd; state: PlanState; reason?: PlanReason
           action?: "update-card" | "confirm-payment" | "change-plan"; scheduled?: { id; name; at }
           today?: { used: number; resetsAt: number; reached: boolean }; forecastDate?: string; ramp?: { until: number } }
  listed: PerkId[]                                   // perks this account's surfaces may show
  entitlements?: Partial<Entitlements>               // publicEntitlements(plan, listed)
  meters?: { cloudAgents?: { used: number; exhausted: boolean }; hosted?: { used: number }; brain?: { used: number; cap: 0.1 }
             vault?: { usedBytes: number; quotaBytes: number }; remote?: { computers: number; limit: number }; shipDesk?: { used: number } }
  history?: { day: string; used: number }[]          // current period, whole-percent fractions
  founding?: { number: number }
  velocity?: "coming"; labs?: "coming"
  purchased: { bought: false }                       // always, for ≤1.99.112 decoders
  empty: boolean; low: boolean }                     // low < 10% of total; empty below the cheapest unlocked hold
```
Paused shape: `{active:true, access:false, plan:{…state:"paused"}, empty:false, low:false}`. The forecast is hidden for the first 3 days and under 5% used. The no-Stripe branch returns the same shape without `entitlements`. Clients decode new fields in a separate lenient pass: enums as strings, unknown values dropped, never failing the whole status.

### 4.12 Catalog and `/models`

`ModelPlanModel` (in `api/_lib/model-plan-config.ts`) adds optional: `upstream` (required when the id contains `:`), `minPlan` (default `vector-10`), `previewUntil`, `providerOnly: string[]` (adds `provider.only` and `allow_fallbacks:false`; `zdr:true`, `data_collection:"deny"` and `max_price` always stay), `tierContext: Record<PlanId, number>` (keys at or above `minPlan`, values never falling as rank rises and never above that plan's `contextMax`), `manualOnly`, `lab: "deepseek" | "anthropic" | "openai" | "moonshot" | "google"`, `weight` (public price ratio, DeepSeek = 1). `reasoningEffort` widens to `high | xhigh | max`. `CODIUM_AUTO_ROLES[plan] = {floor, default, ceiling}`: floor Luna, default DeepSeek, ceiling DeepSeek / Sol / Sol Deep / Sol Deepest. `CODIUM_JUDGES[plan]` maps worker → judge from another lab (Pro: Sol judges DeepSeek, Kimi, Haiku and Argon; Argon judges Sol and Luna; Max: Sonnet 5.5 judges non-Anthropic workers, Sol Deep judges Anthropic; Ultra: Opus 5.5 and Sol Deepest the same way; never a `manualOnly` model). `CODIUM_REVIEW_PAIRS[plan] = {triage, confirm, panelJudge}`: Plus DeepSeek → Luna, panel Haiku; Pro DeepSeek → Sol, panel Argon; Max DeepSeek → Sol Deep, panel Sonnet 5.5; Ultra DeepSeek → Sol Deepest, panel Opus 5.5.

Catalog entries (holds in brackets): DeepSeek V4.1 Flash 1017 (default); Haiku 5.5; Luna 256K [0.040]; Sol High 128K/8,192 [0.442]; Kimi; Argon; Kimi Long and Argon Long (tierContext 256K/512K/768K) [0.594 / 1.106 / 1.618]; DeepSeek Long (Max 512K, Ultra 768K) [0.173 / 0.250]; Sonnet 5.5 200K/16,384 [0.730]; Sol Deep xhigh 128K/16,384 [0.532]; Kimi Fast `moonshotai/highspeed` $4/$20 [0.676]; Argon Fast `google-vertex/global/priority` $3.60/$18 [0.608]; Opus 5.5 200K/32,768 [1.821]; Sol Deepest max 256K/32,768 [1.064]. Terra, Astra and Astra Long are not catalog entries (owner, 30 Oct; `codium-tiers-v3-changes.md` §8), and the Sol entries stay staged until their OpenRouter ZDR endpoint is accepted. Long entries and fast lanes are `manualOnly`: never an Auto role, helper, default judge, swarm or routing target. Velocity has no catalog entry until it launches.

`GET /api/model-plans/models` reads only the snapshot and the runtime model switches: no Stripe, no OpenRouter. New clients get `{enabled, plan, limits:{inFlight}, models:[{id, name, contextLength, maxOutputTokens, lab, weight, role?, manualOnly?, locked?:{plan, name, previewUntil?}, preview?:{until}, auto?}], judges?, review}` with the synthetic `vector/codium-auto` entry after DeepSeek. Old clients get only unlocked models in the four-field shape (Plus's set without a plan) and no Auto. Below `MODEL_PLANS_MIN_CLIENT`: `{enabled:false, models:[]}`.

### 4.13 Estimate API

`POST /api/model-plans/estimate` (account or run token, 20 a minute). Body: `{model, inputTokens, outputTokens, requests?}` (clamped to the effective context, `maxOutputTokens` and 100 requests), `{kind:"hosted", minutes, size}`, `{kind:"race", lanes, task:"small"|"large"}` or `{kind:"playbook", id}`. The server rounds units to steps 1.5× apart, caches one answer per (account, period, step) and answers `{share: "under 1%" | "1–2%" | "2–5%" | "5–10%" | "10–20%" | "20–40%" | "over 40%" | "more than your month", todayShare?}` (the same bands).

### 4.14 Perk listing

`PerkId` = `github-agents`, `github-no-secret`, `scheduled`, `reviews`, `second-opinion`, `remote`, `alerts`, `vault`, `computer`, `overnight`, `on-call`, `release-guard`, `ship-desk`, `vote`, `reports-first`, `priority`, `review-panel`, `founding`, `brain`, `auto-learns`, `brain-cloud`, `playbooks`. `requires`: `github-no-secret`, `scheduled` and `reviews` → `github-agents`; `overnight` → `computer`; `on-call` and `ship-desk` → `alerts`; `release-guard`, `ship-desk` and On Call fix runs → GitHub App configured; `brain`, `auto-learns`, `brain-cloud`, `playbooks` → `CODIUM_TRACK_B_LIVE=true`.

`listedPerks(): Promise<Set<PerkId>>` (`api/_lib/codium-perks.ts`) = `CODIUM_LISTED_PERKS` ∩ runtime switch on ∩ requirements listed (transitively) ∩ service configured. If the store cannot be read, it lists nothing. `founding` is resolved at runtime only (the island). `GET /api/model-plans/config` answers `publicCodiumTiers()` with `s-maxage=60, stale-while-revalidate`.

### 4.15 Settings and config keys

- **App settings** (`packages/app/src/context/settings.tsx`): `general.secondOpinion` (false), `codium.alert80` (false), `notifications.events {finished, needsYou, runGuard, usage}`, `notifications.quietHours {start, end} | null`, `remote.enabled`, `vault.enabled`, `vault.backend "vector" | "github"`, `vault.githubRepo?`. Track B: `brain.codiumHelpers "ask" | "on" | "off"` ("ask" by default; never on by itself).
- **Review config** (`packages/core/src/review/config.ts`): `panel: boolean`, `judgeModel?: string`.
- **Repo files:** `.vector/ops.json` `{opsId, environment, productionUrl, paths[≤5], releaseGuard, shipDesk}` (the server-write opt-in); `.vector/ship.json` `{install, build, start, port, routes[]}`.
- **Desktop userData:** `reports.json` (report ids, 60-character titles), Remote keys in `safeStorage`, vault key in `safeStorage`.

### 4.16 Environment and runtime switches

- **Kept:** `MODEL_PLANS_ENABLED`, `STRIPE_SECRET_KEY` (runtime restricted key), `STRIPE_MODEL_PLAN_WEBHOOK_SECRET`, `STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID`, `STRIPE_MODEL_PLAN_{10,50,100,200}_PRICE_ID`, `MODEL_PLAN_{…}_CREDITS_USD`, `OPENROUTER_MANAGEMENT_KEY`, `MODEL_PLAN_KEY_ENCRYPTION_SECRET`, `KV_*`, `CRON_SECRET`, `RESEND_API_KEY`, `VECTOR_PURCHASE_EMAIL_FROM`, `CODIUM_OWNER_EMAIL`, `CODIUM_OWNER_SECRET`, `CODIUM_FUNDING_MARGIN_*`, `CODIUM_OPENROUTER_FEE_PERCENT`, `VECTOR_ADMIN_EMAILS`.
- **New (billing):** `CODIUM_STRIPE_MODE`, `CODIUM_TEST_CREDIT_CAP_USD`, `CODIUM_3DS_MIN_USD=100`, `CODIUM_TRUST_RAMP_DAYS=7`, `CODIUM_RENEWAL_GRACE_MINUTES=120`, `CODIUM_EFW_REFUND=true`, `CODIUM_RADAR_BLOCKLIST_ID`, `CODIUM_STRIPE_AUTOMATIC_TAX=false`, `CODIUM_OPENROUTER_TOPUP_THRESHOLD_USD`, `CODIUM_SPEND_SPIKE_USD_PER_HOUR`, `CODIUM_CODIUM_OFF_PAUSE_MINUTES=60`, `VERCEL_SPEND_WEBHOOK_SECRET_MAIN`, `VERCEL_SPEND_WEBHOOK_SECRET_HOSTED`, `VERCEL_MAIN_TEAM_ID`, `VERCEL_HOSTED_TEAM_ID`.
- **New (gateway):** `MODEL_PLANS_MIN_CLIENT`, `MODEL_PLAN_REQUIRE_MARKED_TOKENS` (default true), `MODEL_PLAN_GLOBAL_INFLIGHT`, `MODEL_PLAN_PRIORITY_RESERVE`.
- **New (listing and perks):** `CODIUM_LISTED_PERKS`, `CODIUM_TRACK_B_LIVE`, `CODIUM_FOUNDING_LIMIT=500`, `CODIUM_FOUNDING_DAYS=90`, `MODEL_PLANS_SALES_OPENED_AT` (override only), `STRIPE_MODEL_PLAN_LEGACY_PRICES_<plan>` (`price_id:cents,…`).
- **New (services):** `VECTOR_REMOTE_ENABLED`, `VECTOR_REMOTE_TICKET_SIGNING_KEY`, `VECTOR_REMOTE_RELAY_URL`, `VECTOR_PHONE_APP_ORIGIN`, `VECTOR_HOSTED_INTERNAL_SECRET`, `VECTOR_VAPID_PUBLIC_KEY`, `VECTOR_VAPID_PRIVATE_KEY`, `VECTOR_VAPID_SUBJECT`, `VECTOR_VAULT_ENABLED`, `VECTOR_VAULT_ACCOUNT_SALT`, `VECTOR_R2_ACCOUNT_ID`, `VECTOR_R2_VAULT_*`, `VECTOR_R2_MEDIA_*`, `VECTOR_OPS_ENABLED`, `VECTOR_OPS_WORKER_URL`, `VECTOR_OPS_SHARED_SECRET`, `VECTOR_GITHUB_APP_WEBHOOK_SECRET`, `VECTOR_HOSTED_PROVIDER`, `VECTOR_HOSTED_VERCEL_TOKEN`, `VECTOR_HOSTED_VERCEL_TEAM_ID`, `VECTOR_HOSTED_VERCEL_PROJECT_ID`, `VECTOR_HOSTED_BASE_SNAPSHOT`, `VECTOR_HOSTED_VIEWER_SIGNING_KEY`, `VECTOR_HOSTED_RUN_SIGNING_KEY`, `VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB`, `VECTOR_HOSTED_ALLOW_ACCOUNTS`, `VECTOR_HOSTED_BUDGET_READ_SECRET`.
- **Removed:** `STRIPE_MODEL_TOPUP_*`, `MODEL_TOPUP_*_CREDITS_USD`, `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID`.
- **Runtime switches** (`api/_lib/codium-switches.ts`, Valkey, 30 s in-memory cache, audit log): `sales`, `codium`, `cloudAgents`, `hosted` (`on | no-new | stop`), `ops`, `remote`, `vault`, `push`; sets `models-off` and `perks-off`. Env variables say a service is configured; runtime switches turn it off. A Worker reads its own kill flag on every alarm and connection.

### 4.17 Run-trigger interface (for "Vector everywhere" later)

`packages/schema/src/codium-run-trigger.ts`:
```ts
export type RunSource = "desktop" | "cli" | "phone" | "schedule" | "ops"
  | "github-comment" | "github-dispatch" | "github-schedule" | "slack" | "linear" | "jira"
export const ENABLED_SOURCES: ReadonlySet<RunSource>   // all but slack, linear, jira
export type RunTrigger = { source: RunSource; account: string; requestedBy?: { platform: string; userId: string }
  target: { kind: "github-run"; repositoryId: number; branch?: string } | { kind: "hosted-job"; size?: "standard" | "large" }
  prompt: string; criteria?: string[]; deliverBy?: number; purpose: "task" | "review" | "scheduled" | "incident" | "changes" }
```
Reserved sources are refused with reason `source-unavailable`. Entry points: `cloudAgentAllowance(account, {source})`, `enqueueHostedJob(trigger)`, relay presence `isComputerOnline(account)` and the reserved relay envelope kind `job.offer`. No Slack, Linear or Jira code is built.

### 4.18 Contract with Codex (`vector-at-mention`)

**Claude provides:**
```ts
// api/_lib/codium-cloud-agents.ts
cloudAgentAllowance(accountId, { source: RunSource; now?: number }, fetcher?)
  : Promise<{ active: true; plan: PlanId; limits: Entitlements["cloudAgents"]; allowanceSeconds: number
              meterEpoch: string; periodEnd: number; premiumModels: boolean; revokedBefore?: number }
          | { active: false; reason: "none" | "payment" | "dispute" | "fraud" | "closing" | "service-off" | "source-unavailable" | "not-in-plan" }>
```
Reads only the snapshot. `service-off` comes from `MODEL_PLANS_ENABLED=false`, the `codium` switch or the `cloudAgents` switch, never from the funding guard's sales pause. `allowanceSeconds = hours × 3600` (ramp does not apply to cloud agents). The gateway enforces state, `minPlan` from the current snapshot (not the token), rate and in-flight caps shared with the account, the daily limit, the run ceiling and the deadline; `afterSettle` records each run's last Codium request time.

**Codex provides:** `registerRunVerifier("vrt_", …)`; `cloudAgentSecondsUsed(accountId, meterEpoch)`; `recordRepoBinding`/`bindingFor`; `startCloudRun(trigger)` with a one-time ticket for the App bot actor; the `vector ship capture --pr <n>` workflow step behind `vars.VECTOR_SHIP_DESK == '1'`; run records for Remote's run list.

**Amendments for the owner to send Codex** (Claude does not edit Codex's files):
1. Authenticate the run-token mint with GitHub OIDC plus the repo binding, not a `VECTOR_CLI_TOKEN` repo secret; Codium never accepts a pasted account token in Actions.
2. In `github-oidc.ts`: accept a token when `job_workflow_ref === workflow_ref` and `job_workflow_sha === workflow_sha` (or both are absent); add a `run` audience; allow `pull_request_review_comment`; record the default ref at bind and require it. Decode one live token's claims before relying on this.
3. Strip `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` too; split the agent job (read-only) from a publish job; one run token per check run.
4. Word boundary after `@vector`; the handle comes from `VECTOR_GITHUB_APP_SLUG`; until then copy uses `/vector`.
5. Hours: reserve time at mint (deadline = min(longest run, allowance − used − time reserved by live runs)), refuse with under 5 minutes left, settle at max(last Codium request, last report) capped at the deadline; ledger keyed by `meterEpoch`.
6. Map `MODEL_PLAN_RUN_LIMIT`, `MODEL_PLAN_RUN_EXPIRED`, `MODEL_PLAN_DAILY_LIMIT`, `MODEL_PLAN_EXHAUSTED`, `MODEL_PLAN_PAYMENT_REQUIRED` and busy-after-retries to "commit and open a draft PR".
7. PR bodies, comments and logs show "Codium" only: no usage share, no plan name.
8. Start runs only for users with write, maintain or admin from the collaborator-permission API; strangers on public repos are refused.
9. Encrypt session artifacts with a per-run key the server gives after the OIDC check.
10. Free a slot on finish, after an idle window, or when the same check run mints again; post one comment when at-once is reached.
11. Put a binding generation in run tokens; Settings shows each binding's last use; one binder per `repository_id`.
12. Rate-limit mint, heartbeat and bind per IP and per repository.
13. Use the `vrt_` prefix and its own HMAC domain, registered through `registerRunVerifier`; do not change `requireModelPlanUser`.
14. Register the GitHub App with Deployments: read and the webhook from day one; `api/github/webhook.ts` is a shared router (§WP A47).
15. Check `VECTOR_WORKFLOW_VERSION` when binding and offer the update PR to old workflows; tell pinned old CLIs to update when they get 426.
16. Computer-use tools never register when `GITHUB_ACTIONS=true`, and non-repo tasks are refused.
17. Continue in GitHub is unassigned: recommended to Codex after 1.99.113.

### 4.19 Routes and crons

- **Billing:** `POST /api/model-plans/checkout`, `POST|DELETE /api/model-plans/change`, `POST /api/model-plans/portal {flow?: "cancel" | "payment_method_update"}` (`"change"` → 409 `MODEL_PLAN_CHANGE_UNAVAILABLE`), `POST /api/model-plans/webhook`, `GET /api/model-plans/status`, `GET /api/model-plans/config`, `GET /api/model-plans/models`, `POST /api/model-plans/chat`, `POST /api/model-plans/estimate`, `/api/model-plans/topup` → 410.
- **Crons (`CRON_SECRET`):** `/api/model-plans/outbox` every minute; `/replay` every 10 min; `/funding` every 10 min; `/sweep?scope=risk` hourly; `/sweep` daily 04:23 UTC; `/api/hosted/reaper` every minute; `/api/hosted/drift` every 10 min; `/api/hosted/nightly` 02:30; `/api/vault/cleanup` 03:40; `/api/ops/domains` 04:10; `/api/ops/guard` every 10 min; `/api/ops/cleanup` 04:40.
- **Owner (`requireUsageOwner`):** `GET /api/owner/codium`; `POST /api/owner/codium-switch {name, value}`, `/codium-reconcile {account}`, `/codium-replay {since}`, `/codium-clear-risk {account}`, `/codium-refund-end {account}`; `POST /api/owner/spend-vercel` (signature).
- **Services:** `/api/remote/{ticket, devices, devices/:id/revoke, kill, cloud-runs}`, `/api/notify/{subscribe, send}`, `/api/vault/{setup, uploads, commit, snapshots, snapshots/:id}`, `/api/hosted/{computers, sessions, sessions/:id/{stop, takeover, release, heartbeat, viewer, download}, jobs, jobs/:id/{report, approve}, status, spend, admin/flags, admin/budget}`, `/api/ops/{repos, domains, monitors, incidents, cards, uploads, image/:card/:n, worker, releases}`, `/api/github/webhook`, `/api/support/{bug-report, reports}`, `/api/roadmap`, `/api/account/playbooks`.

---

## 5. Work packages

Each WP lists: depends, files, changes, tests, done. "Tests" run in CI (WP A00); locally run only the single test file named and the package typecheck.

### Track A (branch `codium` off main `42346154`)

**A00. CI lane.** Depends: none.
- Files: `.github/workflows/vector-codium.yml` (new), `.github/workflows/vector-codium-e2e.yml` (new), `packages/cloud/src/workflow-compliance.test.ts`.
- Changes: on pushes to `codium/**` and `codium-113/**` and on dispatch: typecheck of the root `api/` config and of schema, core, engine, app, desktop, web; the Codium test files with Valkey and Postgres services pinned by digest, as `vector-free-models.yml` and `vector-sharing.yml` do; `permissions: contents: read`; no secrets. The e2e workflow is dispatch-only in a `codium-test` environment with the owner as required reviewer; it holds the Stripe test key and a test Upstash store, and runs Stripe test clocks and Playwright.
- Done: green on an empty change; compliance test covers both files.

**A01. Schema contract.** Depends: A00.
- Files: `packages/schema/src/codium-plan.ts`, `packages/schema/src/codium-entitlements.ts` (new), `packages/schema/src/codium-run-trigger.ts` (new), `packages/schema/test/codium-entitlements.test.ts` (new), `test/codium-plan-names.test.ts`.
- Changes: §4.1 types, values and `publicEntitlements`; §4.3 snapshot types; §4.17 run trigger; `PlanId`, `rank()`; `TOPUPS = []`; `name()` searches plans only.
- Tests: each numeric cap non-decreasing Plus→Ultra (null lowest, `dailyShare` null as unlimited); no key matching `/usd|price|credit|cost|\$/`; every plan `cloudAgents.atOnce ≥ 1`; scheduled 0 on Plus and Pro; `ops`, `hosted`, `overnight` only on Max and Ultra; `foundingBoost` only Plus and Pro; `velocity` only Max and Ultra; `labs` only Ultra.
- Done: schema typecheck; tests green.

**A02. Mode, keys and fail-closed config.** Depends: A01.
- Files: `api/_lib/codium-keys.ts` (new), `api/_lib/codium-limits.ts` (new), `api/_lib/model-plan-stripe.ts`, `api/_lib/model-plan-config.ts`, every `api/_lib/model-plan-*.ts` and `codium-*.ts` that builds a store key, `.env.example`.
- Changes: `stripeMode()`/`requireStripeMode()` (key prefix vs `CODIUM_STRIPE_MODE`; live only with `VERCEL_ENV=production`); `codiumKey()` everywhere; `codiumBillingConfig()` validation; `requireModelPlans()` also requires the min client (env or compiled default), and refuses when private credit ratios differ from `usageMultiple` by more than 0.05; `MODEL_PLAN_REQUIRE_MARKED_TOKENS` defaults true; test mode: key names `Vector test …`, limits capped, checkout only for admins; every pipeline POST requires an idempotency key.
- Tests: `test/codium-mode.test.ts` (live key in preview refused; test snapshot refused live; cap applied; non-admin test checkout refused; prefix on every key written).
- Done: no Codium store key is written without the prefix (grep test).

**A03. Pool, holds and limits.** Depends: A02.
- Files: `api/_lib/codium-pool.ts` (new), `api/_lib/model-plan-account.ts` (`HOLD`, `SETTLE`, `holdCredits`, `monthlyCredential`, `provisionMonthlyKey`, `requireMonthlyCredits`, `monthlyStatus`).
- Changes: integer micro-dollars; `PEXPIRE` to max(PTTL, new); member format §4.6; `expectedLimit`; half-cent compare; cents PATCH; available per M3; `holdPool`/`settle` with the applied flag and hold-until-applied; `poolShareUsed()`; outbox action `debit-apply` retries unapplied debits.
- Tests: `test/codium-pool.test.ts` for M1–M3.
- Done: M1–M3 tests green.

**A04. Remove top-ups on the server.** Depends: A03.
- Files: `api/model-plans/topup.ts` (→ JSON 410), `api/model-plans/webhook.ts`, `api/_lib/model-plan-account.ts` (purchases, wallet, `topupCheckout`, `topupPaymentCredits`, `purchasedCredits`, `settlePendingTopup`, `reconcileModelTopup`, `synchronizeWalletKey`, `walletCredential`, `provisionWalletKey`, `purchasedShortfall`, `modelTopupCheckout`, the purchased fallback in `modelPlanCredential`), `api/_lib/model-plan-billing.ts`, `api/_lib/model-plan-config.ts` (`modelTopups`, `requireModelTopups`, `topups` in public offers), `api/_lib/codium-ledger.ts`, `api/_lib/codium-funding.ts` (largest sale from plans only), `api/_lib/model-plan-status.ts`, `packages/web/test/model-topups-api.test.ts` (delete).
- Changes: as listed; old account fields decoded leniently for one release and ignored; status always sends `purchased:{bought:false}`; `MODEL_PLAN_EXHAUSTED` wording drops "add credits".
- Tests: topup route 410; status still has `purchased`; existing account fixtures with wallet fields still decode.
- Done: server half of v3 item S.

**A05. Snapshot and reconcile.** Depends: A04.
- Files: `api/_lib/codium-entitlements.ts` (new), `api/_lib/model-plan-account.ts` (`Account` schema, `paidModelPlan`, `reconcileModelPlanAccount`, `cancelModelPlanAccount`), `packages/web/test/fixtures/stripe/*.json` (new, acacia), `packages/web/test/fixture/codium-fakes.ts` (new fake Stripe and OpenRouter recording calls, idempotency keys and limits).
- Changes: §4.3 and §4.4: governing subscription, state mapping, partial refunds not ending, `risk.openDisputes`, `firstPaidAt`, `firstHighPaidAt`, `memberSince`, `meterEpoch`, `livemode`; snapshot and outbox in one EVAL (stubs until A06); read rules; `sales-opened-at` SET NX on the first paid reconcile; status cache invalidation.
- Tests: `test/codium-billing.test.ts` mapping cases from fixtures; M4 stampede; a dispute on the previous month's charge freezes.
- Done: every row of the §4.4 mapping table has a fixture.

**A06. Outbox and provisioners.** Depends: A05.
- Files: `api/_lib/codium-provision.ts` (new), `api/_lib/codium-provisioners.ts` (new), `api/model-plans/outbox.ts` (new cron), `vercel.json`.
- Changes: §4.8; time-budget drain under a global NX lock; priority lane; dead letters with alert; provisioners `github-runs`, `owner-notify` and stubs for the rest.
- Tests: failing provisioner retries then dead-letters; an older version never overwrites a newer; crash after snapshot write is repaired by the sweep's re-enqueue.
- Done: outbox drains in CI.

**A07. Webhook rework and renewals.** Depends: A06.
- Files: `api/model-plans/webhook.ts`, `api/_lib/model-plan-stripe.ts` (`MODEL_PLAN_WEBHOOK_EVENTS`), `api/_lib/codium-renewal.ts` (new).
- Changes: §4.5 order and event list; `finalize-renewal` action with M7 guards and `pause_collection=void` otherwise; `renewing` state; old key `expires_at = periodEnd + grace`; `recordCodiumCharge` kept for the private ledger.
- Tests: bad signature 400; reconcile throws after acceptance → event retried or replayed; `invoice.created` answers 2xx with the store down; finalize/pay keys; each M7 refusal; renewal fixture keeps serving the old key; after `invoice.paid` new key, carry 0, new epoch.
- Done: M5, M7, M11 green.

**A08. Replay and sweeps.** Depends: A07.
- Files: `api/model-plans/replay.ts` (new), `api/model-plans/sweep.ts` (new), `api/_lib/model-plan-stripe.ts` (`listStripeEvents`, paged), `vercel.json`.
- Changes: replay lists the 20 types since the cursor minus 5 minutes, re-fetches objects at the pinned version, skips done events; hourly risk sweep (open disputes, renewing, past due, multiple active subscriptions per customer); daily sweep of stale snapshots and accounts past `periodEnd + grace`, key-limit drift audit and repair with alert, provisioner re-enqueue.
- Tests: missed event processed once; overlap does not double-apply; newer-API-version events handled by re-fetch; drift repaired to `expectedLimit`.
- Done: replay covers any single lost webhook within 10 minutes.

**A09. Upgrades, downgrades and the portal.** Depends: A08.
- Files: `api/_lib/codium-plan-change.ts` (new), `api/model-plans/change.ts` (new), `api/_lib/model-plan-account.ts` (`modelPlanCheckout`, `modelPlanPortal`), `api/_lib/model-plan-billing.ts`.
- Changes: §4.4 upgrade and downgrade; checkout refuses with 409 `MODEL_PLAN_EXISTS` when a subscription exists; portal has no change flow (old `flow:"change"` → 409 `MODEL_PLAN_CHANGE_UNAVAILABLE` with "change plans on vectordev.ai/account"); returns use `model_plan=success&change=upgrade` so old desktops read them as success; upgrade checkouts reserve the sale through `reserveCodiumSale`; `/change` needs a desktop token or web session, 10 an hour; release a schedule before the cancel flow; consent and custom text on checkout (§7.2); `automatic_tax` behind its switch.
- Tests: carry formula; replay cancels once; old invoices voided; refused while past due, scheduled or blocked; true-up only raises; meters fresh after upgrade; downgrade schedule phases and release; old portal flow 409.
- Done: M6 green; "upgrade and keep what's left" can be listed.

**A10. Risk: 3-D Secure, fraud warnings, disputes, ramps.** Depends: A09.
- Files: `api/_lib/codium-risk.ts` (new), `api/_lib/model-plan-account.ts`, `api/_lib/codium-entitlements.ts`.
- Changes: `request_three_d_secure=any` for checkouts and upgrade checkouts at or above `CODIUM_3DS_MIN_USD` while the customer has no paid, unreversed invoice of that size; EFW handling per §4.4; dispute `pause_collection` on create, removed on win, cancel on loss; trust ramp and pool ramp (§4.2) via outbox `pool-ramp`.
- Tests: 3DS matrix (first Max yes, Plus no, second Max no, Plus→Max upgrade yes); EFW actionable refunds once, not actionable freezes only, `CODIUM_EFW_REFUND=false` no refund; older-charge dispute; ramps.
- Done: the test-mode check that subscription-mode Checkout accepts the 3DS field is in the e2e list.

**A11. Switches, owner alerts and funding.** Depends: A10.
- Files: `api/_lib/codium-switches.ts` (new), `api/_lib/codium-owner.ts` (new `notifyOwner`, generalised from `emailOwner`), `api/_lib/codium-funding.ts`, `api/model-plans/funding.ts`.
- Changes: §4.16 switches; `codium` off past `CODIUM_CODIUM_OFF_PAUSE_MINUTES` → `pause-collection` actions, reversed on; funding history, runway, low-water at 1.25×, auto top-up watchdog, spike alert; cron answers carry no amounts.
- Tests: switch honoured within 30 s; codium-off pause and resume; each funding alert; sales pause never touches renewals (M12).
- Done: M12 green.

**A12. Owner API and page.** Depends: A11.
- Files: `api/owner/codium.ts`, `codium-switch.ts`, `codium-reconcile.ts`, `codium-replay.ts`, `codium-clear-risk.ts`, `codium-refund-end.ts` (new), `packages/web/src/pages/owner/codium.astro` and `packages/web/src/components/marketing/owner/CodiumOwner.tsx` (new), `vercel.json` rewrite.
- Changes: owner-only, noindex, unlinked, auto-refresh 60 s: sales state and reason, balance, owed, reserved, runway, watchdog, subscriptions per plan and MRR (owner only), disputes and EFWs in 30 days and the ratio (alert over 0.5%), webhook health, outbox depth, dead letters, sweep drift, budgets, store health, switches with toggles, the readable Stripe settings checklist, and the buttons. Accounts show by id; no emails.
- Tests: non-owner 403; password session `GOOGLE_SIGN_IN_REQUIRED`; stale `amr` refused for mutations; audit written; no email addresses in the payload.
- Done: S5 green.

**A13. Vercel spend webhook.** Depends: A11.
- Files: `api/owner/spend-vercel.ts` (new).
- Changes: HMAC-SHA1 hex over the raw body with the per-team secret; main team email only; hosted team 50% email, 75% `hosted=no-new`, 100% `hosted=stop`; escalate only (the payload has no timestamp; only the owner de-escalates); never calls a pause API.
- Tests: bad signature 401; thresholds; a late 75% after a 100% does not de-escalate.
- Done: part of M9.

**A14. Stripe setup script, env and crons.** Depends: A13.
- Files: `packages/web/scripts/setup-model-plans.ts`, `packages/web/scripts/model-plan-setup.ts`, `packages/web/test/model-plan-setup.test.ts`, `.env.example`, `vercel.json`, `packages/web/scripts/codium-economics.ts`.
- Changes: §2 setup row: no top-up loop, archive top-up prices, descriptor and metadata, `tax_behavior=exclusive`, one no-change portal (report or deactivate an old change portal), webhook subscribed to exactly `MODEL_PLAN_WEBHOOK_EVENTS`, dry run lists four monthly prices; the script refuses a runtime restricted key and says to use the setup key; all crons in §4.19.
- Tests: dry run output; `--apply` against the fake; event list equality.
- Done: owner can run it in test mode.

**A15. Catalog.** Depends: A01.
- Files: `api/_lib/codium-catalog.ts`, `api/_lib/model-plan-config.ts`, `packages/web/scripts/model-plan-catalog.ts`, `packages/web/test/fixtures/codium-endpoints-2026-10-27.json` (new, from public `/models`, `/endpoints`, `/endpoints/zdr` only), `packages/web/test/model-plan-entitlements.test.ts` (new), `packages/web/test/model-plan-catalog.test.ts`.
- Changes: §4.12 fields, entries, roles, judges, review pairs; `MODEL_PLAN_MODELS_JSON` overrides default `minPlan` to `vector-10`; `effectiveModel(model, plan)`, `modelAccess(model, plan, now)`, `modelPlanRequestCredits(model, plan)`; `CODIUM_CATALOG_UPDATED='2026-10-27'`; audit matches `upstream ?? id`, checks `providerOnly` against ZDR routes, largest `tierContext` and effort support.
- Tests: holds equal §4.12 to 3 dp; first entry open to Plus; roles unlocked per tier; manualOnly set; judges cross-lab and never `manualOnly`; bad overrides rejected.
- C-SOL (owner, 30 Oct): Terra, Astra and Astra Long leave the staged catalog; `CODIUM_CATALOG_UPDATED='2026-10-30'` and the default audit target is `codium-endpoints-2026-10-30.json`, which pins the same 23 Oct capture (`codium-csol-models-notes.md`).
- Done: catalog typecheck and tests green.

**A16. Callers and tokens.** Depends: A02.
- Files: `api/_lib/model-plan-caller.ts` (new), `api/_lib/cli-token.ts`, `api/account/cli-exchange.ts`, `api/account/cli-token.ts`, `api/_lib/model-plan-chat.ts` (`requireModelPlanUser` unchanged for other endpoints).
- Changes: §4.8 and §4.9: caller kinds, run-verifier registry, `requireModelPlanClient` (426; `local` only outside production), `cli` tokens via code exchange with `jti` and single revocation; unmarked refusal only inside chat and `/models`; run tokens refused everywhere else.
- Tests: S2 and S3 matrices; `vector login` exchange mints `cli` and the portal refuses it.
- Done: S2, S3 green.

**A17. Admission and chat.** Depends: A03, A05, A15, A16.
- Files: `api/_lib/model-plan-admit.ts` (new), `api/_lib/model-plan-chat.ts`, `api/_lib/model-plan-account.ts`.
- Changes: chat order: enabled and client gate → caller → request against catalog minus `models-off` (503 `MODEL_PLAN_MODEL_UNAVAILABLE`) → snapshot (402 before 403; livemode) → per-minute limit by tier → `modelAccess` (403 with recent-checkout reconcile) → context with `effectiveModel` → `beforeAdmit` hooks (computer-use tool refusal for run tokens, hosted live check) → credential → ADMIT (§4.7) with one deadline → upstream (`upstream ?? id`, effort, `providerOnly`) → priority retry for rank ≥3 on 429/503 before any byte, same hold, same deadline → finally release, settle, `afterSettle`.
- Tests: `packages/web/test/model-plans-api.test.ts` extensions: locked 403 with no hold; 31st Plus request 429; concurrency 429 frees on error, abort and throw; reserve; daily limit and retry-after; run ceiling atomic under parallel requests; brain share; retry rules; fast-lane body; variants send upstream id and effort; disabled model 503; tokens still forwarded and cost stripped.
- Done: one Valkey round trip for admission (counted in the test).

**A18. `/models`, status and estimate.** Depends: A17.
- Files: `api/_lib/model-plan-models.ts`, `api/_lib/model-plan-status.ts`, `api/model-plans/estimate.ts` and `api/_lib/model-plan-estimate.ts` (new), `api/model-plans/config.ts`, `packages/web/test/model-plan-models-api.test.ts`, `model-plan-status-api.test.ts`, `model-plan-estimate-api.test.ts` (new).
- Changes: §4.11, §4.12, §4.13; the meters registry other WPs fill; `config` carries `listed` (A27 fills `publicCodiumTiers`).
- Tests: `/models` makes only KV calls; old client four-field list; status JSON scan (P1); forecast hidden rules; paused shape; estimate bands and binary-search resistance (P2).
- Done: P1, P2 green.

**A19. Core and engine clients.** Depends: A18.
- Files: `packages/core/src/model-plans.ts`, `packages/core/src/model-plan-status.ts`, `packages/core/src/codium-auto.ts` (new), `packages/core/src/session/runner/model-plan-route.ts`, `packages/llm/src/route/executor.ts` (final codes only), `packages/engine/src/provider/error.ts`, `packages/engine/src/session/retry.ts`, `packages/engine/src/provider/provider.ts` (`getSmallModel`), `packages/engine/src/session/prompt.ts` (`createUserMessage`, `currentModel`), `packages/schema/src/model.ts`, `packages/schema/src/v1/session.ts`, `packages/core/src/plugin/provider/vector-plan.ts`, `packages/engine/src/cli/cmd/codium.ts`, `models.ts`; regenerate `packages/sdk` and `packages/client` (never by hand).
- Changes: headers (§4.9) on catalog, chat, status and the Core V2 runner; error kinds (§4.10); lenient status decode; `AUTO_ID`; Auto resolves once per user message (floor / default / ceiling from size), guards the chosen model's window at 80%, never a `manualOnly` model, stores `selected`; helpers pick floor, then default, never locked, manualOnly or Auto, and skip when none fits; purpose header passes through `createFetch` and the V2 route (titles `title`, judges `judge`, reviews `review`, `modelLearn` `brain`); `vector codium` and `vector models` lines.
- Tests: `packages/core/test/model-plans.test.ts`, `codium-auto.test.ts` (new), `model-plan-status-compat.test.ts` (new, H7 with frozen 1.99.111/112 decoders), `packages/engine/test/session/retry.test.ts`, `prompt.test.ts`, provider small-model test; Core V2 final codes.
- Done: H7 green; SDK check passes.

**A20. App and desktop plan UI.** Depends: A19.
- Files: `packages/app/src/utils/provider-brand.ts`, `components/dialog-select-model.tsx`, `packages/tui/src/component/dialog-model.tsx`, `packages/app/src/utils/task-intelligence.ts`, `packages/desktop/src/main/swarm-plan.ts`, `packages/app/src/components/codium-error.tsx`, `codium-purchase.tsx`, `codium-billing.ts`, `settings-v2/account.tsx`, `settings-v2/account-model.ts`, `vector-account.ts`, `context/platform.tsx`, `packages/desktop/src/main/billing-navigation.ts`, `vector-account.ts`, `packages/app/e2e/fixtures/account-settings.jsx`, `regression/account-settings.spec.ts`.
- Changes: locked badges ("Codium · Pro", "Preview · Ultra"), Auto pinned under Vector Codium, choosing a locked model opens Change plan; routing and swarms skip locked and manualOnly; app and TUI restore `selected`; error actions; plan picker calling `/change`, payment-failed notice with Update card, action-required notice, scheduled-downgrade line with "Keep my plan"; top-up buttons and purchased rows removed; desktop accepts `change=upgrade` and the payment-method portal return, drops `model_topup`; refreshes `/models` at 5, 20 and 60 s after a purchase return.
- Tests: app unit tests named in the files list; `billing-navigation.test.ts`; `vector-account.test.ts`; `swarm-plan.test.ts`; e2e in CI.
- Done: no top-up UI remains in app or desktop.

**A21. Label plan C1: contract.** Depends: A01. As `codium-label-plan.md` §7 C1: `packages/schema/src/billing.ts`, `CostKind "codium"`, optional `billing`, `codiumSteps` and related counts, provider-id literals replaced, SDK and client regenerated. Tests: `packages/schema/test/billing.test.ts`; old payloads decode. Done: `check:generated` green. Merge `codium` into self-evolving right after this WP (owner step 9).

**A22. Label plan C2 and C3: stamping and accounting.** Depends: A21. As §7 C2–C3, including the projector strip list (`packages/core/src/session/projector.ts:317-343`) and the `codium_steps` migration. Tests: as listed there (`processor-effect`, `title-usage`, `session-projector`, `database-migration`). Done: a Codium step adds to `codium_steps` and no tokens.

**A23. Label plan C4 and C5: spend guard and usage summary.** Depends: A22. As §7 C4–C5 (D-3: a Codium run under a dollar cap is not stopped at 40 steps; desktop limits skip and reserve $0 for known Codium runs). Tests: `spend-guard.test.ts`, `run-usage.test.ts`, `usage.test.ts`, check-in tests, HttpApi exerciser scenarios (CI). Done: check-ins never carry `vector-plan`.

**A24. Label plan C6 and C7: app surfaces and Settings → Usage.** Depends: A23, A18.
- Files: as §7 C6–C7, plus `packages/app/src/components/settings-v2/codium-usage-model.ts` (new) and `settings-vector-codium.tsx`.
- Changes: label plan §5 with these changes: no purchased row; rows Plan, Renews/Ends, This month (meter `aria-valuenow` = left, "36% used · 64% left"), Today (when the tier has a daily limit), Codium agent time, Cloud computer hours, Vault GB, Brain helpers (when listed), Velocity ("Vector Velocity: Coming. Max and Ultra get access when it launches."), Forecast; notices for paused, action required, empty (renewal date, own keys, free model, upgrade and keep what's left), low; buttons Change plan, Manage billing, Refresh; refresh on open, sign-in, Refresh, focus (once a minute), `codiumChanged()`, and 15 s after a Codium turn ends; opt-in 80% alert.
- Tests: `codium-usage-model.test.ts` (H5), `format-spend.test.ts`, `session-cost.test.ts`, `codium-usage-labels.spec.ts` e2e (no digits beside Codium labels).
- Done: H5 green.

**A25. Label plan C8, C9 and C10.** Depends: A24. Desktop main, TUI and CLI text, `run --format json`, ACP and `export --sanitize`, as §7 C8–C10. Tests as listed there. Done: no printed output carries Codium tokens.

**A26. Label plan C11 and the review footer.** Depends: A25. Vectorscope format, state key `k`, `github.evidence.ts`, the `github.review.ts` log line, as §7 C11. This WP owns `packages/core/src/review/format.ts` cost wording; A35 adds its footer line afterwards. Tests: `codium-no-figures.test.ts`, evidence Codium-only and mixed. Done: Codium reviews show no tokens.

**A27. Copy module, listing and /codium.** Depends: A18.
- Files: `packages/schema/src/codium-copy.ts` (new, namespace `CodiumCopy`: `PerkId`, `PERK_COPY`, `requires`, `COMING`, `TAGLINES`, `HEADLINE_ORDER`, `COMPUTER_LABEL = "a computer Vector runs for you"`, `FREE_WORKSPACE`, `tierView()`), `api/_lib/codium-perks.ts` (new, `listedPerks`), `api/_lib/codium-public.ts` (new, `publicCodiumTiers`), `api/model-plans/config.ts`, `packages/web/src/lib/model-plans.ts`, `packages/web/src/lib/codium-pricing.ts`, `packages/web/src/components/marketing/codium/CodiumPricing.tsx`, `codium-pricing.css`, `packages/web/src/pages/codium.astro`, `CodiumPricing.test.ts`.
- Changes: §7.1. No toggle, no top-up tab, `?type=topups` shows plans; card order tagline → usage → Headlines → Models → Coming → Limits → footnote; comparison groups; 11-question FAQ; the island re-reads config on mount and hides perks no longer listed; numbers only from `ENTITLEMENTS`.
- Tests: H1–H4, H6 cases in `CodiumPricing.test.ts`; taglines never name an unlisted perk (all subsets); every cap equals `ENTITLEMENTS`; only $10/$50/$100/$200 appear; `%` only in the allowlisted patterns (`Up to N% of your month a day`, `N% more per dollar`, `counts toward your month`).
- Done: page renders with `CODIUM_LISTED_PERKS` empty and full.

**A28. Account page.** Depends: A27, A09.
- Files: `packages/web/src/components/marketing/account/ModelPlans.tsx`, `model-plans.css`, `ModelPlans.test.ts`, `packages/web/src/lib/model-plans.test.ts`.
- Changes: §7.1 account card; upgrade buttons say "Upgrade to Max: $100 today, then monthly from today. Keeps what's left of this month."; "Switch at renewal" below the current rank; paused shows only "Update payment method"; signed-in paused users on /codium see "Update card".
- Tests: meter, rows, buttons, old-shaped status still renders.
- Done: no purchased or top-up text.

**A29. Docs.** Depends: A27.
- Files: `packages/web/src/pages/docs/codium.astro` (new), `packages/web/src/data/docs-nav.ts`, `docs/desktop-app.astro`, `troubleshooting.astro`, `external-agents.astro`, `terminal-agent.astro`, `tokenomics.astro`, `packages/web/src/data/docs-content.ts`, `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/codium-payments.md`, `openrouter.md`, `codium-owner-guards.md` (new), `packages/web/test/codium-docs.test.ts` (new), `docs-settings.test.ts`.
- Changes: §7.3.
- Tests: anchors exist (`#hosted` and `#coming` always render); no amounts; links to `/docs/vectorscope#github`.
- Done: `git grep -i 'topup\|top-up\|purchased'` finds only OpenRouter's own auto top-up, `packages/core/src/free-model-choice.ts`, unrelated release notes and the "no top-ups" phrases (test `test/no-topups.test.ts` with an allowlist).

**A30. Legal drafts.** Depends: A27. Draft terms §3 and privacy changes (§7.2) on a branch `codium/legal` that is merged only in A60's release commit. Tests: `test/codium-legal.test.ts` (anchors, required phrases, banned phrases, H8 hash). Done: drafts ready for the legal read.

**A31. Founding members.** Depends: A09, A11.
- Files: `api/_lib/codium-founding.ts` (new), `api/_lib/model-plan-account.ts` (checkout metadata, `paidModelPlan` legacy price and amount checks), `api/_lib/model-plan-config.ts` (`subscriptionPlanCredits` boost; legacy prices keyed by plan), `api/_lib/codium-provisioners.ts` (`founding`), app chip (`packages/app/src/vector-account.ts`, `workspace-navigation.tsx`), Settings → Account row.
- Changes: window = earlier of `CODIUM_FOUNDING_LIMIT` paid founders or `CODIUM_FOUNDING_DAYS` after `sales-opened-at`; a slot is reserved at checkout (released on `checkout.session.expired`); one EVAL assigns the number; +10% on Plus and Pro only (an upgrade to Max or Ultra keeps the mark and lock, not the boost); the server copies founding metadata onto upgrade checkouts; the lock is "your price won't go up while you stay subscribed"; ends on `customer.subscription.deleted`; opt-in founders page and badge behind a random slug, public after 30 opt-ins.
- Tests: M13; window close; boost on Plus↔Pro; legacy price at legacy amount; cancel ends it; resumed cancellation keeps it.
- Done: M13 green.

**A32. Usage forecast and history.** Depends: A17.
- Files: `api/_lib/codium-usage-history.ts` (new), `api/_lib/model-plan-status.ts`, `packages/core/src/model-plan-status.ts` (`describe`), Settings → Usage strip.
- Changes: history from the `day:` buckets (so @vector runs while the desktop is closed count); straight-line forecast over the last 7 days, or the period average with fewer than 3 points; hidden in the first 3 days and under 5% used; 31-day strip with `<1%`; renewal card counts only.
- Tests: forecast cases; history includes run-token spend.
- Done: forecast line in `vector codium`.

**A33. Report tracker.** Depends: A05.
- Files: `api/support/bug-report.ts`, `api/support/reports.ts` (new), `packages/desktop/src/main/bug-report.ts`, `ipc.ts`, preload, `script/report-status.ts` (new), `packages/web/src/data/fixed-reports.json` (new), `packages/web/scripts/build-changelog.ts`, `packages/app/src/context/highlights.tsx`, `components/dialog-release-notes.tsx`, Settings → Account "Your reports".
- Changes: random id `r_` + 26 base32, metadata only, 180 days; optional account token gives the tag and limits (free 5, Plus and Pro 15, Max and Ultra 30 an hour); subject tags `[Plus]`, `[Pro]`, `[Max · read first]`, `[Ultra · read first]`; the report id goes in the email; response keeps the old `id` field and adds `report.id`; changelog lists `sha256(id)[0:16]`; What's New shows "A problem you reported is fixed in this version"; unknown statuses read "received".
- Tests: `bug-report-api.test.ts`, `support-reports-api.test.ts`, `highlights-fixed-report.test.ts`.
- Done: P4 green.

**A34. Roadmap vote.** Depends: A05.
- Files: `api/roadmap/index.ts` (new), `script/roadmap-ballot.ts` (new), `packages/app/src/components/settings-v2/roadmap.tsx` (new), `settings-registry.ts`, `dialog-settings-v2.tsx`.
- Changes: Max and Ultra vote, one ballot per account per quarter, changeable until close; Ultra nominates once a quarter (SET NX per quarter); results after close with at least 20 ballots counted from accounts entitled when they voted; copy "planned for the next release cycle", no date; tab shows when `entitlements.vote` is set.
- Tests: `roadmap-api.test.ts`.
- Done: ballots deleted with the account (A57).

**A35. Second opinion and second-lab reviews.** Depends: A19, A26.
- Files: `packages/engine/src/session/second-opinion.ts` (new), `packages/engine/src/session/prompt.ts` (judge gate), `packages/engine/src/tool/task.ts`, `packages/app/src/components/settings-v2/general.tsx`, `context/settings.tsx`, `components/prompt-input/submit.ts`, `packages/core/src/review/config.ts`, `packages/engine/src/review/run.ts`, `packages/core/src/review/format.ts` (footer), `packages/app/src/features/pull-requests/ai-review.ts`.
- Changes: the judge comes from `judges` only for a Codium worker, no configured judge, judge on, `general.secondOpinion` on and different labs; review pairs per tier, same-lab pair warns and runs a single pass; optional panel; footer "Checked by a second lab" / "Checked by three labs", with own keys too; lab from the model's vendor, no line when unknown; within the review token stops.
- Tests: `second-opinion.test.ts`, `review/second-lab.test.ts`, `review/panel.test.ts`.
- Done: Second opinion listable.

**A36. Playbooks server.** Depends: A05, A43.
- Files: `api/account/playbooks.ts` (new), `script/playbooks-publish.ts` (new).
- Changes: Pro and up get `[{name: "vector-*", version, sha256, url}]` with 10-minute signed R2 links (`vector-media/playbooks/`); publish validates against the skill command allowlist (and the workflow schema once it is published, Track B).
- Tests: `playbooks-api.test.ts`.
- Done: endpoint dark until Track B lists it.

**A37. Shared service plumbing and push.** Depends: A05.
- Files: `api/_lib/hosted-internal.ts` (new HMAC: method, path, timestamp, nonce, body hash; 300 s skew; 10 s timeout; `redirect:"error"`), `api/_lib/r2-presign.ts` (new SigV4 with signed `content-length`, ≤900 s), `api/_lib/safe-fetch.ts` (new, S8), `api/_lib/web-push.ts` (new: VAPID via `jose`, RFC 8291 via `node:crypto`), `api/notify/subscribe.ts`, `send.ts` (new).
- Changes: push needs an active paid plan; `send` accepts only end-to-end ciphertext ≤3 KB from a desktop token, 60 an hour; server pushes carry titles only; 404/410 deletes the subscription.
- Tests: `web-push.test.ts` (RFC test vector), `r2-presign.test.ts`, `hosted-internal.test.ts`, `safe-fetch.test.ts`.
- Done: P7, S8 green.

**A38. Phone app shell.** Depends: A37.
- Files: `packages/app/src/phone/` (new: `entry.tsx`, `sw.ts`, `phone.webmanifest`, routes for sessions, approvals, devices, cloud runs, computer, ops, notifications), `packages/app/vite.config.ts` (separate entry → `dist-phone`), `packages/web` build copy, `script/prune-vector-site.mjs` keep list, `vercel.json` (host rewrite for `remote.vectordev.ai`, CSP, `Permissions-Policy: camera=(self)` for that host only, `Service-Worker-Allowed`), `packages/app/src/components/settings-v2/notifications.tsx` (new).
- Changes: one origin and one service worker scope for every phone surface; features shown by `listed` and entitlements; strict CSP; pairing must happen inside the installed Home Screen app on iOS; version handshake.
- Tests: build test that the phone bundle survives the prune; header test for camera and CSP.
- Done: alerts can be listed once A37 and this ship.

**A39. Remote relay Worker.** Depends: A37.
- Files: `packages/relay/` (new: `package.json`, `wrangler.jsonc`, `src/index.ts`, `src/ticket.ts`, `src/internal.ts`, `src/account-relay.ts`, `test/*`).
- Changes: one Durable Object per account (`idFromName(HMAC(account))`) with WebSocket hibernation; ticket in the `Sec-WebSocket-Protocol` header, the handshake echoes a fixed `vector.v1`; Ed25519 ticket check (aud, exp ≤5 min); devices in SQLite; device and fair-use caps from the ticket and §4.2; heartbeats via `setWebSocketAutoResponse`; alarm armed only while a viewer is attached; kill and suspend pushed through the internal API; data frames dropped with no viewer, and a computer socket that keeps sending them is closed; viewer time counted in memory and persisted at most once a minute; tickets refreshed in-band; presence query and reserved `job.offer`.
- Tests: ticket, routing, limits, idle, fair use, internal HMAC; CI smoke under `wrangler dev --local` (ciphertext byte for byte, revoke and kill close sockets).
- Done: deploy dry run green.

**A40. Remote API.** Depends: A39, A16.
- Files: `api/_lib/remote-ticket.ts`, `api/remote/ticket.ts`, `devices.ts`, `devices/[id]/revoke.ts`, `kill.ts`, `cloud-runs.ts` (new); `api/_lib/codium-provisioners.ts` (`remote`).
- Changes: computers need a desktop token plus `requireUnrevokedAccount`; phones need a Supabase session on the phone origin; refused when not active, frozen, switch off or `remote.computers` is 0; `revokeAccountTokens` also kills relay sockets; cloud runs from Codex's records for every paid plan.
- Tests: `remote-ticket-api.test.ts`.
- Done: S6 server half green.

**A41. Desktop Remote.** Depends: A40.
- Files: `packages/desktop/src/main/remote-link.ts`, `remote-routes.ts`, `remote-crypto.ts`, `remote-pairing.ts`, `remote-passkey.ts`, `remote-notify.ts` (new), `keep-awake.ts`, `tray.ts`, `packages/core/src/webauthn/verify.ts` (new).
- Changes: QR pairing with transcript HMAC and a 6-digit check code; per-connection X25519 + HKDF + AES-256-GCM with sequence numbers; keys in `safeStorage`; the route allowlist; permission replies from the phone only `once` with a desktop-verified passkey or `reject`; turns started from the phone never auto-approved; origin checked as exactly `VECTOR_PHONE_APP_ORIGIN`; stream only while viewers > 0, batched to 4 messages a second; keep awake while a phone watches a busy session; "Disconnect all phones" rotates identity; encrypted alerts.
- Tests: `remote-crypto.test.ts`, `remote-routes.test.ts`, `webauthn/verify.test.ts`, auto-approve suppression test.
- Done: S6 green.

**A42. Remote phone UI and Settings → Remote.** Depends: A41, A38.
- Files: `packages/app/src/phone/` remote routes, `packages/app/src/components/settings-v2/remote.tsx` (new).
- Changes: pairing, sessions, approvals, devices; the paired count "N of limit" from status; revoke and Disconnect all.
- Tests: e2e in CI with a virtual WebAuthn authenticator pairing and approving.
- Done: ready for the outside security review.

**A43. Vault core and CLI.** Depends: A01.
- Files: `packages/core/src/vault/crypto.ts`, `format.ts`, `recovery.ts`, `chunker.ts` (new), `packages/schema/src/vault.ts` (new), `packages/engine/src/cli/cmd/vault.ts` (new), `packages/core/src/brain/export.ts` (trusted restore mode).
- Changes: per-file content-defined chunking before compression, each chunk compressed and encrypted (AES-256-GCM, AAD vaultId ‖ chunkId), id = HMAC of plaintext; recovery code 26 base32 + checksum with scrypt (N=2^17); manifest with `minReader`; restore through a vault-trusted versioned import that keeps approval and pin state, batches past 500 entries and 2 MB, never copies `brain.db`; `vector vault backup|status|restore|versions|forget`, `--github <owner/repo>`.
- Tests: `vault.test.ts` (round trip, dedup between versions, wrong code fails cleanly, restore path, `minReader` refusal).
- Done: P3 green.

**A44. Vault API.** Depends: A43, A37.
- Files: `api/_lib/vault-store.ts`, `api/vault/setup.ts`, `uploads.ts`, `commit.ts`, `snapshots.ts`, `snapshots/[id].ts`, `index.ts` (DELETE), `cleanup.ts` (new); `docs/vector/owner-actions/sql/brain-vault.sql` (new; `security invoker`, grants to `service_role`).
- Changes: atomic reservation before signing; signed PUTs only for missing chunks; commit HEADs each object, deletes and answers 409 on a size mismatch; read-only states per §4.4; cleanup prunes versions over 30 days (newest kept), collects unreferenced chunks, sweeps uncommitted objects after 1 hour, deletes lapsed vaults after the notice.
- Tests: `brain-vault-api.test.ts` (20 parallel reservations, quota before signing, read-only states, deletion).
- Done: quota is a server gate.

**A45. Desktop vault and Settings → Memory → Backup.** Depends: A44.
- Files: `packages/desktop/src/main/vault-backup.ts`, `vault-github.ts` (new), Settings → Memory → Backup.
- Changes: nightly while the app is open, plus Back up now; GitHub backend pushes packfiles over git to a private repo (checked private before every push), keeps 7 versions, warns on total repo size above 1 GB; vault key in `safeStorage`.
- Tests: `vault-github.test.ts` (public repo refused, nothing sent to vectordev.ai).
- Done: Vault listable after the legal read.

**A46. Ops Worker.** Depends: A37.
- Files: `packages/ops-worker/` (new: `wrangler.jsonc`, `src/index.ts`, `src/ops-account.ts` (DO per account, SQLite), `src/check.ts`, `src/release-watch.ts`, `src/ssrf.ts`, `src/internal.ts`, `test/*`).
- Changes: alarms at the next due time, always at least 25 s ahead, capped wakes per hour; probes with an 8 s timeout, at most 6 in flight, no redirects (a cross-domain redirect fails), `https` on 443 to verified hostnames only; 401, 403, 429 and challenge pages are inconclusive; two failures in a row; release watch waits 60 s after `success`, compares with the last good release every 30 s, ends when a newer deployment arrives, dedupes by (repo, environment, sha); stores state changes and hourly totals only; pushed snapshot with `validUntil = periodEnd + 24 h` stops checks by itself; Worker-level kill flag; internal HMAC API.
- Tests: miniflare in CI (intervals per plan, in-flight cap, two-failure rule, validUntil, kill flag, delete).
- Done: deploy dry run green.

**A47. GitHub webhook router and ops settings.** Depends: A46.
- Files: `api/github/webhook.ts` (new shared router, `bodyParser:false`), `api/_lib/github-webhook.ts`, `api/_lib/github-webhook-handlers/ops.ts` (new), `api/ops/repos.ts`, `domains.ts`, `monitors.ts` (new).
- Changes: verify signature, dedupe by `x-github-delivery`, filter event types before any store read; `deployment_status` (production environment per repo config) → Release Guard; `pull_request` on App-bot-authored, same-repo PRs → Ship Desk; installation removals drop settings; domains verified by DNS TXT `_vector-verify.<domain>` over DNS-over-HTTPS or `/.well-known/vector-verify.txt` (no redirects), re-verified weekly; monitors within caps.
- Tests: `github-webhook.test.ts`, `on-call.test.ts`.
- Done: Codex can register its handlers in the same router.

**A48. Release Guard and incidents.** Depends: A47.
- Files: `api/_lib/release-guard.ts`, `api/ops/incidents.ts`, `api/ops/worker.ts`, `api/ops/releases.ts` (new), `api/_lib/github-app-server.ts` (new, one-repo installation tokens for `revert` only, revoked after use, audited).
- Changes: intake checks bound repo, `.vector/ops.json`, usable snapshot, daily cap (dedupe before increment); a regression opens one revert PR (SET NX per repo, environment, sha): GraphQL `revertPullRequest` when the range is exactly one merged PR, else a restore commit only when the head equals the deployed sha; no App write when workflow files are in range (fall back to "open in GitHub" and the host's rollback link); the card lists undone commits and warns on migration paths; Undo opens the PR in GitHub or merges with the user's own sign-in in the desktop; snooze 1–24 h; "Fix it" calls Codex's `startCloudRun` only on a user tap.
- Tests: `release-guard.test.ts` (every case in this list, callback retry opens one PR).
- Done: S9 green.

**A49. Ship Desk and capture.** Depends: A47, A38.
- Files: `api/_lib/ship-desk.ts`, `api/ops/cards.ts`, `uploads.ts`, `image.ts` (new), `packages/engine/src/cli/cmd/ship.ts` (new `vector ship capture`).
- Changes: cards from App-bot-authored same-repo PRs, counted once per (repo, PR); verdict from Codex's run record or check run, never the PR body; capture runs in a separate job with no `id-token` and no run token, using a capture ticket (one PR, ≤8 files, 15 min); PNG or WebP only by file signature, SVG refused, served `nosniff`, sandbox CSP, `no-store`, owner-only signed GETs from R2; expiry 30 or 90 days; Approve opens the PR in GitHub or merges in the desktop.
- Tests: `ship-desk.test.ts`.
- Done: cards appear for a test PR in CI fixtures.

**A50. Ops UI and ops crons.** Depends: A48, A49.
- Files: `packages/app/src/phone/` ops routes, `packages/app/src/features/cloud/ops/*`, `packages/desktop/src/main/ops.ts` (new), `api/ops/guard.ts`, `cleanup.ts`, `domains.ts` (cron) (new).
- Changes: incidents, cards with before/after slider, monitors, domains, push opt-in; "Roll back in Vercel" link; guard budget = (Max × cap cost + Ultra × cap cost) × 2 + $5 from active counts and Cloudflare's analytics API, owner email at 75%, at 100% pause only accounts above their own expected usage; cleanup expires cards and incidents and erases after a lost dispute plus 30 days; daily certificate expiry via `node:tls`, domain expiry via RDAP, DNS drift via DNS-over-HTTPS.
- Tests: `ops-guard.test.ts`, `ops-payment-pipeline.test.ts`.
- Done: ops perks listable after the App and security review.

**A51. Hosted core.** Depends: A03, A05.
- Files: `packages/schema/src/hosted.ts` (new), `api/_lib/hosted-entitlement.ts`, `hosted-rates.ts`, `hosted-ledger.ts` (new), `docs/vector/owner-actions/sql/hosted.sql` (new; invoker; ledger lines pseudonymous and not cascade-deleted).
- Changes: rates pinned to region `iad1`: standard worst case $0.3408/h charged $0.375, large $0.6816 charged $0.75; 15-minute blocks held 20 minutes ahead; settle per block rounded up to the minute, attributed to the period active at settle with `occurred_at`; snapshot storage-days and egress (`VECTOR_HOSTED_EGRESS_MICRO_USD_PER_GB`) charged nightly; post-cancel storage charged to the final period, retention shortened if the pool cannot cover it; true-up only lowers, never below cost; `hoursUsedShare`.
- Tests: `hosted-ledger.test.ts` (M8, idempotent settle, late settle, upgrade fresh meters).
- Done: M8 green.

**A52. Provider adapter and reconciler.** Depends: A51.
- Files: `api/_lib/hosted-provider.ts`, `hosted-provider-vercel.ts`, `hosted-provider-cloudflare.ts` (interface stub with contract tests) (new); `package.json` (`@vercel/sandbox` pinned to a version at least two weeks old).
- Changes: persistent named sandboxes `vh-<HMAC(account)[0:16]>-<n>` from the base snapshot; 2 or 4 vCPUs; timeout = job deadline + 5 min; only the viewer port exposed; network policy denies private, link-local, metadata, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `64:ff9b::/96`, `::1/128`, `224.0.0.0/4`, `240.0.0.0/4`; the only injected credential is the `vht_` token for a dedicated run-API host that Chromium's URL policy blocks; snapshot retention set per plan; a reconciler every few minutes lists running sandboxes and stops any without a live session row.
- Tests: provider mocked; create receives the deny list and the single injection; orphan stopped.
- Done: code stays behind `VECTOR_HOSTED_PROVIDER` until Vercel's written OK.

**A53. Sessions API, reaper and nightly.** Depends: A52.
- Files: `api/_lib/hosted-sessions.ts`, `api/hosted/computers.ts`, `sessions.ts`, `sessions/[id]/*`, `status.ts`, `reaper.ts`, `nightly.ts`, `drift.ts`, `admin/flags.ts`, `admin/budget.ts` (new); `api/_lib/codium-provisioners.ts` (`hosted`).
- Changes: start checks (switch, provider, snapshot, size, job length, hours, computers at once by lease, first block hold, create or resume, `vht_` mint, boot); heartbeat; take-over and release; viewer token (Ed25519, 5 min, single-use, view or control, in the URL fragment); download link 24 h; reaper (deadline, 10 min idle, block renewal or wrap-up within 5 min, missing heartbeat 3 min, busy-CPU and egress abuse, due jobs, drain and stop flags, unapplied debits); nightly charges, true-up, deletions, budget target; drift compares lifecycle-based expected cost with ledger charges; `admin/budget` read with `VECTOR_HOSTED_BUDGET_READ_SECRET`; `admin/flags` owner only.
- Tests: `hosted-sessions-api.test.ts`, `hosted-reaper.test.ts`, `hosted-lifecycle.test.ts` (every §4.4 transition), `hosted-copy.test.ts` (copy fields and numeric field names only; rates never imported by client packages).
- Done: S1 hosted cases green.

**A54. Image and hostd.** Depends: A53.
- Files: `packages/hosted-computer/` (new: `image/Dockerfile` pinned by digest, `boot.sh`, `nftables.conf`, `chromium-policies.json`, `credential-guard.js`, `src/hostd.ts`, `viewer-proxy.ts`, `recorder.ts`, `wipe.ts`, `git.ts`, `script/bake-snapshot.ts`, `test/image.test.ts`).
- Changes: agent as uid 10001, no sudo; nftables allows tcp/443, DNS to the resolver and loopback, and `boot.sh` fails closed if it does not load; on every resume `boot.sh` reinstalls verified system components from the base snapshot and refuses a disk below the minimum image generation; 10 GB quota on the data path; hostd action API matching the local computer-use action format, screenshots JPEG or WebP at most 1280 px wide; git clone, fetch and push done by hostd with one-repo short-lived tokens while the agent's process group is stopped; processes not spawned by the current tool call are killed when it ends; viewer proxy on localhost VNC; recorder 2 fps, 1-minute segments, off during take-over; profile wipe after every job; credential guard refuses password, OTP and card fields; CAPTCHAs handed over.
- Tests: Docker job in CI (ports, sudo, VNC bind, viewer tokens, credential guard, wipe); a real-microVM nftables check in the e2e workflow.
- Done: S7 green.

**A55. Done by Morning.** Depends: A53.
- Files: `api/_lib/hosted-jobs.ts`, `api/hosted/jobs.ts`, `jobs/[id].ts`, `jobs/[id]/report.ts`, `jobs/[id]/approve.ts` (new).
- Changes: `enqueueHostedJob(trigger)` is the single entry; `perNight` and `recurringPerDay` at enqueue, `atOnce` and hours at start; recurring jobs on public pages only; report accepted only with that job's token; judge from another lab; recordings 30 days, owner only; "aims to deliver by"; Approve opens the PR (no server merge); a failed payment pauses the queue, a dispute cancels it.
- Tests: `hosted-jobs.test.ts`.
- Done: listable with the computer.

**A56. Hosted clients and budget workflow.** Depends: A54, A38.
- Files: `packages/desktop/src/main/hosted-client.ts` (new), composer "Run on my cloud computer", live-view pane (sandboxed webview), phone computer route, `.github/workflows/vector-hosted-budget.yml` (new).
- Changes: purple edge and "Vector is using its cloud computer"; Take over; pre-start ceiling from `/estimate`; budget workflow: daily and dispatch, skipped unless `VECTOR_HOSTED_BUDGET_AUTOMATION=true`, uses a Billing-role token only in `hosted-production`, sets `max(current, spend + 1.3 × Σ worst case for the rest of the cycle including overlapping periods)`, never lowers within a cycle, never `--pause`.
- Tests: budget calculation unit test; workflow compliance.
- Done: M9 hosted cases green.

**A57. Account deletion.** Depends: A44, A50, A53, A33, A34, A40.
- Files: `api/account/delete.ts`, `api/_lib/codium-erase.ts` (new).
- Changes: set the tombstone that every enqueue and start path checks, then cancel billing, then erase: report index, ballots, nominations, founders listing, push subscriptions, relay devices, vault (delete the wrapped key first, objects asynchronously), computers, snapshots, recordings, monitors, cards, Worker data; a failure leaves the tombstone and the cleanup cron retries; identity deletion waits for the erase marker.
- Tests: `account-delete.test.ts` extended (P5, Worker outage retry).
- Done: P5 green.

**A58. Deploy workflows.** Depends: A39, A46, A54.
- Files: `.github/workflows/vector-hosted-ci.yml`, `vector-hosted-deploy.yml`, `vector-hosted-image.yml` (new), `packages/cloud/src/workflow-compliance.test.ts`.
- Changes: §6.2.
- Tests: compliance (protected environment, protected-main ancestry, actions pinned by SHA).
- Done: owner can dispatch.

**A59. Codex integration commit.** Depends: A18, A16, and Codex's branch merged to main.
- Files: `api/_lib/cloud-agents-entitlement.ts` (delegate to `cloudAgentAllowance`, keep Codex's signature, delete its local limits table), status meters wiring for `cloudAgents`, the Settings row, `packages/web/test/cloud-agents-entitlement-contract.test.ts` (new).
- Changes: one commit; adapter only if shapes differ.
- Tests: contract per plan and reason; mint refuses when hours are used, at-once is reached or `github-schedule` on Plus; PR body shows no usage share (P6).
- Done: @vector listable after the live runs (§1.2).

**A60. Release and go-live.** Depends: all Track A WPs needed for the launch set.
- Changes: merge `codium/legal` in the release commit with both dates; publish the desktop and npm CLI release; set `MODEL_PLANS_MIN_CLIENT` and the compiled default to it; run the e2e workflow (buy Plus; upgrade to Max with the 3DS card; check carry; schedule a downgrade; renew with a test clock; fail a renewal with 4000 0000 0000 0341; refund; dispute; EFW test card; consent text visible); run the load check against a staging deploy with stubbed OpenRouter (24 in-flight Ultra holds, 200 rpm, one admission round trip, peak memory on a 4.5 MB body; a 768K request must clear `MAX_BYTES` and 600 s or Ultra ships at 512K); then item Q (1 GB chat function) if peak memory allows.
- Done: owner checklist in §8.2 steps 15–18.

### Track B (branch `codium-113` off self-evolving, after the multi-agent build)

**B01. Merge and re-apply.** Merge `codium` into `codium-113`. Re-apply label-plan hunks in the six files self-evolving rewrote (`core/spend-guard.ts`, `engine/tool/subagent-lifecycle.ts`, `engine/tool/task.ts`, `schema/task.ts`, `schema/v1/session.ts`, `engine/cli/cmd/memory-doc.ts`) and the Auto hook in `createUserMessage` with `selected`. Tests: the label tests and `prompt.test.ts`. Done: CI green on `codium-113`.

**B02. Label plan C13.** As `codium-label-plan.md` §7 C13 and §11: workflow insight cost cell "Codium", progress without "N of M tokens", the busy note, judges as helpers reading "Codium". Retry wait copy for helpers over Plus's 3 at once says "requests at once", not agents.

**B03. Codium Brain helpers.** Files: `packages/core/src/brain/schema.ts`, `packages/engine/src/session/skill-learn.ts` (`drafts()`), `prompt.ts` (model-learner gate), `packages/core/src/brain/distill.ts`, Settings → Memory, `brain.astro` and privacy text. Changes: `brain.codiumHelpers` asked once after subscribing; gates accept the tier's floor ZDR model (Luna or DeepSeek) with purpose `brain`; distillation becomes a normal setting; "Bootstrap this repo" sends proposals to review; `MODEL_PLAN_BRAIN_SHARE` skips quietly; the decision-8 privacy rewording. Tests: `skill-learn.test.ts`. Done: lists `brain`.

**B04. Codium Auto that learns.** Files: `packages/core/src/brain/workflow.ts`, `packages/core/src/plugin/provider/vector-plan.ts`, `packages/core/src/codium-auto.ts`. Changes: catalog `weight` as hidden metadata; `codiumUnits` when every step ran on Codium; Auto chooses roles by MIN_RUNS 6, MARGIN 0.1, CHEAPER 20%; explanations in percentages. Tests: `brain/workflow.test.ts`. Done: lists `auto-learns`.

**B05. Second opinion on the per-brief model.** Move the judge from `ctx.extra.judgeModel` to the brief's model through `SubagentModel.allowed`. Tests: `second-opinion.test.ts`.

**B06. Race.** Files: `packages/core/src/race/spec.ts`, `packages/app/src/features/race/*`. Changes: one stage per lane on distinct labs in worktrees, a judge from an unused lab, side-by-side in the Tasks pane, merge through isolation review, share band from `/estimate`; free for everyone. Tests: `race/spec.test.ts`.

**B07. Playbooks client.** Files: `packages/core/src/playbooks/install.ts`, `packages/engine/src/cli/cmd/playbooks.ts`, Settings → Workflows. Changes: verify sha256, write only to user config `workflows/vector-*.json`, project files cannot shadow `vector-*`, `codium:floor|default|ceiling` resolve per tier, ceiling band before run. Tests: `playbooks/install.test.ts`. Done: lists `playbooks` after two are proven.

**B08. Brain in cloud runs.** Needs Codex's artifact path. Shareable skills, cost-free insight rows and posting-checked repo memories packed into the encrypted artifact for owner-started desktop runs only; procedures left out on public repos; drafts return for review. Coordinate the file split with Codex before building.

**B09. Remote helper states.** Phone Tasks view of helper and background-job states, "Stop including helpers", waiting and interrupted notes as push alerts.

**B10. Vault skills and insights.** Add `skills` and `insights` sections to the vault manifest (restored as drafts for review); main-built readers refuse with "update Vector" via `minReader`.

**B11. Hosted job result as one note.** Return a finished hosted job into the same desktop conversation through 1.99.113's job rows and note pipeline.

---

## 6. New infrastructure

### 6.1 What is created

| Piece | Where | Purpose | Guard |
|---|---|---|---|
| `vector-remote-relay` Worker + `AccountRelay` DO (SQLite) + KV `REMOTE_FLAGS` | Cloudflare | encrypted relay | kill flag, per-account suspend, fair-use and awake-hour meters, budget alerts |
| `vector-ops` Worker + `OpsAccount` DO (SQLite) + KV `OPS_FLAGS` | Cloudflare | On Call checks, release watches | Worker kill flag, `validUntil`, guard cron, budget alerts |
| R2 `vector-vault` | Cloudflare | encrypted backups | quota before signing, HEAD at commit, sweeper |
| R2 `vector-media` | Cloudflare | recordings, Ship Desk images, download tarballs, playbooks | lifecycle rules (30 / 90 days), owner-only signed GETs |
| Team `vector-hosted` with one empty project | Vercel | Sandbox microVMs | pool holds, spend webhook, budget workflow, reconciler, drift check |
| `remote.vectordev.ai` domain on the main project | Vercel | phone app origin | CSP, camera only here |
| Preview Upstash store | Upstash | test mode | separate URL scoped to Preview |
| Supabase tables (`brain-vault.sql`, `hosted.sql`) | Supabase | durable vault and hosted records | invoker functions, `service_role` grants |
| GitHub environments `hosted-production`, `codium-test` | GitHub | deploy and e2e secrets | owner as required reviewer |

No D1 or Queues are used: per-account Durable Objects hold ops state, and Vercel crons do the daily domain checks.

### 6.2 Deploy workflows (owner switches them on)

- `vector-codium.yml` (A00): CI only, no secrets.
- `vector-codium-e2e.yml` (A00): dispatch only, `codium-test` environment.
- `vector-hosted-ci.yml` (A58): on PRs touching `api/**`, `packages/{relay,ops-worker,hosted-computer,schema}/**`, vault, webauthn and the desktop remote, vault and hosted modules; Postgres and Valkey services; typecheck, tests, `wrangler deploy --dry-run` for both Workers, the image Docker job; `contents: read`.
- `vector-hosted-deploy.yml` (A58): `workflow_dispatch` with `target = relay | ops | all`; a preflight job checks the protected environment and that the commit is an ancestor of protected main; deploy jobs in `hosted-production` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Worker secrets are set once by the owner with `wrangler secret put`, never by the workflow.
- `vector-hosted-image.yml` (A58): dispatch in `hosted-production`; builds the image, pushes it to the hosted team's registry, runs `bake-snapshot.ts` and prints the snapshot id.
- `vector-hosted-budget.yml` (A56): daily and dispatch, skipped unless the repo variable is true.
- Vercel crons are added to `vercel.json` (§4.19) and run with `CRON_SECRET` as today.

---

## 7. Website, legal and docs

### 7.1 Website

- **/codium:** four cards, no plan-type toggle and no top-ups; `?type=topups` shows the plans. Each card: name, price, button ("Get Max", or "Coming soon" while sales are off), computed tagline, usage line ("Codium · on models from three labs" on Plus; "5.5x Plus's usage · 10% more per dollar", 12x/20%, 25x/25%; the per-dollar clause hidden at 0% or less), Headlines (listed only, numbers from `ENTITLEMENTS`), Models ("Everything in Pro, plus …" from `minPlan`), Coming (violet pill), Limits (requests at once, daily limit, longest context, cloud agents "in your own repo, on your own Actions minutes. GitHub bills Actions minutes on private repos beyond your GitHub plan's included minutes."; the trust ramp), footnote "Renews monthly until you cancel. Coming items are not part of today's purchase and have no date."
- **Under the cards:** taxes; monthly plans only; no top-ups or overage charges; when the month is used up Codium pauses until renewal while your own keys and free models keep working; upgrade and keep what's left; link to the Codium terms.
- **Comparison table groups:** Usage; Headline perks (listed); Models; Typical tasks a month; Limits; Coming; Every plan includes; Included in the free Vector workspace (adds "@vector in GitHub with your own key as a repo secret").
- **FAQ (11):** right plan; need Codium?; how usage is measured; when the month runs out; models and where requests go; does @vector cost extra; what "Coming" means; taxes; where to see usage; making the month last; changing or cancelling (upgrade at once and charged in full with what's left carried; downgrade at renewal; a failed payment pauses; cancel keeps access to period end).
- **Page description:** "Vector is free. Codium is Vector's monthly plan, from $10 to $200: models from up to five labs with no keys, plus more on Max and Ultra. No top-ups or overage charges."
- **Account page:** plan name and state badge (Active, Ending this period, Payment failed, Confirm payment); This month meter; Renews or Access ends; optional rows (Today, Codium agent time, Cloud computer hours, Velocity line); plan offers (Choose, Current plan, Upgrade with the charge stated, Switch at renewal); Manage subscription; Refresh; link to /codium.
- **Perk copy when listed:** as §1.1, with numbers filled from `ENTITLEMENTS`. Velocity: "Vector Velocity, Vector's premium coding model: only on Max and Ultra, when it launches." Labs: "Vector Labs" plus the Coming pill, nothing else. The cloud computer always says Vector hosts it and never mentions GitHub or Actions. On Call says "Vector's agent is on call, not a person" and promises no uptime or response time.

### 7.2 Legal (published only in A60's release commit, after the legal read)

**Terms §3, retitled "Cost and Vector Codium plans" (`id="codium"`).** Keep: Vector is free; connected services charge separately; free models are not guaranteed; taxes and the total are shown before payment; the price-change notice; records kept as the law requires; the non-refund and billing-error remedy ("credits" → "usage"). Add, with anchors:
- `#codium-plans`: monthly plans only; no top-ups and no overage charges; automatic renewal; cancel any time and keep the paid period; an upgrade starts a new month today, charged in full, and this month's unused usage carries into that month only; downgrades start at renewal; a failed payment pauses Codium and plan perks and does not extend the month; a plan ends if payment is not made after Stripe's retries; a full refund or a dispute ends what that payment bought; Vector may refund and end a plan after a fraud warning; disputed or fraud-flagged payments suspend access; new Max and Ultra subscriptions start with reduced limits for a short period (the ramp).
- `#codium-models`: models and limits differ by plan and are listed on /codium; models may be temporarily unavailable, or replaced with a comparable model; included usage, models and limits are not reduced during a paid month (changes apply from the next renewal after notice).
- `#codium-usage`: shown only as a whole-percent share, which may lag; no rollover; a daily limit on some plans; not a promise of tokens, requests or tasks.
- `#codium-coming`: "Vector Velocity is in development and is not part of what any subscription buys today. If it launches, we intend to offer it only on Max and Ultra. We don't promise that it will launch, or when." The same clause covers Vector Labs and every item tagged "Coming".
- `#codium-github`: Vector sells only Codium model access inside runs in your own repository, on your own Actions minutes; runs are under your GitHub account and GitHub's terms, and GitHub bills the minutes; runs do only that repository's software work; anyone with write access to a repository you bind can start runs that use your plan; agent time is measured by Vector from Codium requests, not GitHub minutes; @vector works without a plan with your own key as a repository secret.
- `#codium-hosted` (where available): time counts toward your month; Vector may stop a session; acceptable use (no mining, spam, scraping against a site's terms, solving CAPTCHAs or bypassing bot checks); profile wiped after each job; disk retention and deletion after cancellation with notice.
- `#codium-ops` (where available): Vector's App opens revert PRs automatically and never merges; no uptime or response-time promise; checks only on verified domains.
- `#codium-consent`: immediate start; withdrawal within 14 days means paying for what was used (EU); founding lock ("your price won't go up while you stay subscribed"; on a plan change you pay that plan's current price; the +10% applies to Plus and Pro).
- §8 acceptable use adds mining, spam, scraping against terms, CAPTCHA solving, and using cloud agents for work unrelated to the repository.

**Checkout consent text** (exported constant `CODIUM_CHECKOUT_CONSENT`, imported by A09): "I agree to the [Codium terms](https://vectordev.ai/legal/terms#codium) and ask Vector to start my plan now. If I withdraw within 14 days I pay for what I used. Renews monthly at $X until I cancel in my account." On Max and Ultra add "Vector Velocity is coming and is not part of this purchase." A purchase confirmation email restates consent, renewal and cancellation. The billing record stores `consent.terms_of_service` and the terms date.

**Privacy.** §4 Codium rewritten: no top-ups; billing record fields (Stripe ids, plan, period, consent, entitlement snapshot); short-lived Valkey counters; GitHub run records (repository id → account binding until revoked, run id, event, triggering GitHub login or id kept 90 days, start and stop times; Actions logs are GitHub's and public on public repos; session artifacts encrypted per run once Codex ships it, otherwise say they are private Actions artifacts). Codium token totals and cost are not in usage check-ins from the release that carries A23 (activity counts still are). Report metadata 180 days. Ballots. "Where available" paragraphs, each published when its service first lists and kept while its data is kept: `#vault`, `#remote` (relay, devices, push endpoints, titles only), `#hosted-computer` (disk, profile, files, recordings 30 days, nothing recorded during take-over, processors Vercel and Cloudflare, zero data retention covers model calls, not the disk), `#production-checks` (URLs, results, deployment events, private screenshots 30 or 90 days). §12 retention list.

### 7.3 Docs

- `/docs/codium` (new, Features after Models; `plans` and `pricing` redirect here): `#plans` (rendered from `CodiumCopy` and `ENTITLEMENTS`), `#models`, `#usage`, `#used-up`, `#github` (summary, links to `/docs/vectorscope#github`, no trigger syntax), `#hosted` (each perk only when listed; heading always present, "None yet" when empty), `#coming`, `#payments`, `#free`.
- `desktop-app.astro`, `troubleshooting.astro` (new FAQ "My Codium month is used up"), `external-agents.astro`, `terminal-agent.astro`, `docs-content.ts`, `tokenomics.astro`: credits and top-up wording removed; Codium steps are not counted in dollars and step limits still apply.
- `docs/vector/MODEL-PLANS.md`: tiers, no top-ups, plan cache, renewals, upgrades with carry, downgrades, failed payments, disputes, EFWs, switches, listing rule and `CODIUM_LISTED_PERKS`, error codes, "Nothing is retried" updated for Max and Ultra's one retry, line 98 reworded ("inside Codium, once you chose it, Vector may pick another model of your tier"), configuration list.
- Owner docs: `codium-payments.md` (setup, test run, known limits), `openrouter.md`, `codium-owner-guards.md` (new), `remote.md`, `brain-vault.md`, `hosted-computer.md`, `hosted-ops.md` (new), `github-app.md` (Deployments read, webhook, events).
- Codex owns `vectorscope.astro` GitHub sections and `owner-actions/vector-mention.md`; this build does not edit them.

---

## 8. Risks, owner steps and open decisions

### 8.1 Risks

1. **Vercel's terms may block the cloud computer** (Terms §12(i) and (iv), read 2026-10-27). Without a written OK it does not ship; the Cloudflare Containers fallback needs the same OK. Max's and Ultra's headlines then rest on @vector, ops perks and models.
2. **Fraud is the only losing case** (up to about $200 on Ultra). 3-D Secure, the pool and trust ramps, EFW refunds and dispute handling reduce it; 3DS `any` may pass frictionless without liability shift.
3. **The plan cache depends on webhooks, replay and sweeps together.** If all fail, a refunded account can keep access until the 6 h staleness check; the key limit still caps the money.
4. **OpenRouter cannot be funded by API.** If auto top-up fails, sales pause and existing users spend the balance down; the watchdog and low-water emails are the defence. Keep a backup card and a generous threshold.
5. **Upgrades create a second subscription for a moment.** A failed supersede would double-bill at the next renewal; the hourly sweep checks for duplicates.
6. **Upstash is a single point of failure** for accounts, holds, outbox and switches. It fails closed (503); the owner page shows its health.
7. **Funding check scale:** it lists every key every 10 minutes; at a few thousand subscribers it needs an incremental owed figure.
8. **Unverified upstream behaviour:** Sol's OpenRouter ZDR endpoint (exact provider tag, limits and prices) and its `xhigh` and `max` effort there; `provider.only` endpoint tags with `zdr:true`; 768K within 4.5 MB and 600 s. Each needs the audit plus one approved live request.
9. **Merge friction** between `codium` and self-evolving (`task.ts`, `prompt.ts` and the six label files). Merge after A21 and after every later WP that touches them, at the self-evolving build's safe points.
10. **Codex boundary.** If Codex's interfaces slip, @vector, scheduled runs, ops fix runs and Ship Desk screenshots stay unlisted; the copy follows the listing.
11. **Write-access spending.** Any writer on a bound repo spends the binder's month; on a busy org repo that is team sharing by the back door, bounded by the caps.
12. **GitHub handle.** An org named "vector" exists; the App needs another name, and copy uses the registered slug.
13. **Old clients.** Pre-gate desktops show "Buy credits" on 402s (it opens the plans page). Status keeps `purchased`. The min-client gate must be set before sales.
14. **Remote and ops are high-value targets.** Outside security reviews are required before listing; iOS push needs a Home Screen install (iOS 16.4+).
15. **Vault is the first user data Vector stores** (encrypted). A lost recovery code means lost backups; it needs the legal read.
16. **Owner time** grows: image rebuild monthly (1–2 h), roadmap ballot quarterly (1 h), playbook upkeep (2–3 h a month), alert triage.
17. **Velocity copy** is a forward statement about a model with no weights; the copy guard and the terms clause keep it to "Coming".
18. **GitHub terms:** cloud agents must stay repo software work and Vector must never sell Actions; the legal read confirms the "model access only" wording.

### 8.2 Owner steps, in order

1. Confirm this contract's picks (§8.3 "already taken") or override them.
2. Approve the CI policy: temporary `codium/**` branches pushed to the public repo for CI and deleted after merge; set up the `codium-test` and `hosted-production` GitHub environments with yourself as reviewer.
3. Send Codex the amendments in §4.18.
4. Create a separate preview Upstash store with KV variables scoped to Preview; turn on Vercel Deployment Protection for previews.
5. Stripe: finish verification and payouts; create a setup key (products, prices, webhook endpoints, portal configs) for local use only and a runtime restricted key (customers, checkout sessions, subscriptions, subscription schedules, invoices finalize and pay, refunds, early fraud warnings read, value lists if used, events read, disputes read, billing portal sessions).
6. Run the setup script in test mode; put test values in Preview with `CODIUM_STRIPE_MODE=test`; run the e2e workflow.
7. Stripe dashboard: Smart Retries and cancel after the last retry, customer emails, Terms of Service URL, Radar; decide Stripe Tax with an accountant.
8. OpenRouter: separate Codium account, management key, starting balance, auto top-up with a backup card, the threshold env; confirm the resale terms and the 5.5% fee.
9. Merge `codium` into self-evolving right after A21, then after each WP that touches the shared files, at the self-evolving build's safe points.
10. Register the GitHub App (not named "vector"; Deployments: read; webhook to `https://vectordev.ai/api/github/webhook`; events deployment status, pull request, installation; no Workflows, Administration or Secrets permission); set `VECTOR_GITHUB_APP_*`; check the handle.
11. Cloudflare: Workers Paid; R2 buckets with scoped tokens and lifecycle rules; KV namespaces; Budget Alert and billable-usage notifications; Worker secrets; dispatch the deploy workflow.
12. Generate and set secrets (commands in the owner docs; values never in the repo or chat): ticket and viewer and hosted-run signing keys, internal HMAC, VAPID, vault salt, R2 keys; add the `remote.vectordev.ai` domain.
13. Apply the Supabase SQL files.
14. Vercel: main-team Spend Management with the notify-only webhook (never "Pause production deployments"); ask Vercel in writing whether Sandbox may run computers that paying subscribers operate, whether outbound port 25 is blocked, what exposed-port egress costs and whether `--pause` on the hosted team blocks sandbox creation; only with the OK, create the `vector-hosted` team, its budget and webhook, run the image workflow and set the snapshot id.
15. Get the legal read: terms §3, privacy, EU consent text, Velocity and Labs clause, GitHub "model access only", Vault, Remote, hosted computer, recordings, ops writes, founding lock, report retention.
16. Get outside security reviews for Remote, the hosted computer's isolation and viewer, and the App's revert-PR path, before listing each.
17. Go live: setup script with the setup key in live mode; runtime values in Production with `CODIUM_STRIPE_MODE=live`; publish the desktop and npm CLI release; set `MODEL_PLANS_MIN_CLIENT`, `MODEL_PLAN_GLOBAL_INFLIGHT` (start about 400) and `MODEL_PLAN_PRIORITY_RESERVE=0.2`; merge the legal release commit and send the material-change notice to account holders (terms §14); set `MODEL_PLANS_ENABLED=true` and redeploy. Watch `/owner/codium` for the first week.
18. As each perk passes its gate (§1.2), add it to `CODIUM_LISTED_PERKS` and redeploy; for the cloud computer, start with `VECTOR_HOSTED_ALLOW_ACCOUNTS` set to your own account.
19. Ongoing: quarterly ballot (`script/roadmap-ballot.ts`), report statuses (`script/report-status.ts`), release-week ZDR re-checks, monthly image rebuild.

### 8.3 Decisions

**Already taken by this contract** (each is the plan's recommended pick or follows a critique; the owner may override): Sol in, Terra and Astra out (owner, 30 Oct; `codium-tiers-v3-changes.md` §8); Auto ceilings are Sol variants; 403 for locked models and 429 daily limit at 00:00 UTC; one retry on Max and Ultra; unmarked tokens refused for Codium; founding window 500 or 90 days with lock and +10% on Plus and Pro; Second opinion off by default; Codium Brain share about 10%, asked once; Auto may switch the main model only inside Auto; report tracker, Race, the review panel and Bootstrap free; no monthly calls and no Labs live; Vault via R2 after the legal read, with the free GitHub backend; Remote on Cloudflare with an outside review; hosted computer on Vercel Sandbox only with a written OK; no server merges in v1; meters reset on every new period including an upgrade; cloud-agent hours do not carry on an upgrade (the new plan's full hours apply).

**Still open:**
1. Renewal grace length (default 120 minutes).
2. Partial refunds: default "no change to access"; full refunds end the plan.
3. Upstash plan: fixed price or per command.
4. Whether only GitHub accounts linked to the subscriber may spend Codium in bound repos (default: anyone with write access, bounded by caps).
5. "Vector Velocity: only on Max and Ultra" binds future pricing: Velocity could not later be sold to Max and Ultra subscribers as an add-on.
6. Stripe Tax on or off.
7. The computer-use brand name for the cloud computer.
8. ~~Whether to list GPT-6 Astra at launch if its `azure` route stays below about 90% uptime.~~ Resolved 30 Oct: Astra is not offered (`codium-tiers-v3-changes.md` §8).
9. Whether Sol may be accepted if the new capture shows its only OpenRouter ZDR endpoint is OpenRouter's `azure` provider tag, as active Luna's is (`codium-tiers-v3-changes.md` §8, open question). Until then Sol stays staged.

---

## Appendix A. Critique corrections changed or not applied

Every other high and medium correction in the six critiques is applied in the sections above.

1. **Meters on upgrade.** The billing design kept the old `meterEpoch` on an upgrade; the cloud design carried unused hours; the hosted critique reset them. Chosen: a new epoch at every new period, including an upgrade, with no hour carry. An upgrade charges a full new month, and every cap is non-decreasing from Plus to Ultra, so the new plan's full allowance is always at least the old remainder; this also keeps Codex's reader out of the webhook path. The credit pool still carries (item N).
2. **Background reconcile every 15 minutes** (gateway critique A6) is replaced by the 10-minute replay cron plus the hourly risk sweep. Replay catches any event Stripe recorded, for every account, at far lower Stripe load; the 6 h staleness check remains as the last guard.
3. **Refunding an upgrade charge restores the earlier plan** (website critique 7) is not built. The old subscription is cancelled at supersede and its remainder already moved into the refunded period as carry; restoring it would need a new subscription. A full refund ends the plan; the owner can offer a fresh checkout.
4. **Server-side passkeys and server merges** (hosted and perks designs) are dropped, following the perks critique: in v1 Vector opens PRs and the user merges in GitHub or in the desktop with their own sign-in. Passkeys remain only for Remote approvals, verified on the desktop.
5. **Ops Worker shape.** The hosted design's cron, Queue, D1 and `ReleaseWatch` DO and the perks design's per-account DO are merged into one Worker with one DO per account; certificate and domain expiry run on a Vercel cron because a Worker cannot see the server certificate.
6. **Ship Desk images** move from Vercel Blob to R2 `vector-media`: private Blob reads pay transfer through a Function, R2 signed GETs do not.
7. **One phone origin.** Remote, ops cards, the hosted live view and push share `remote.vectordev.ai` and one service worker, instead of separate `/remote` and `/ops` scopes on vectordev.ai.
8. **Owner model switch script** with production KV credentials on the Mac is replaced by the owner endpoint and the `models-off` runtime set.
9. **`reviewPanel` entitlement** removed (the panel is free; the gateway's tier check is the gate); Plus gets Haiku as its panel judge.
10. **`client:"cli"` on `/auth/cli` tokens** (gateway and cloud designs) replaced by code-exchange-only `cli` tokens, per the cloud critique.
11. **`upgrade-keep` perk id** deleted: carry-over is a precondition for opening sales, so the promise is unconditional.
12. **`MODEL_PLANS_ENABLED=false` as "no new sales"** (billing switch matrix) corrected: it stops the whole service in today's code, so new sales are paused with the `sales` switch instead.

## Appendix B. Sources (read 2026-10-27 unless noted)

- GitHub Additional Product Terms, Actions: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- GitHub OIDC reference: https://docs.github.com/en/actions/reference/security/oidc
- Stripe subscription invoices and webhooks: https://docs.stripe.com/billing/invoices/subscription, https://docs.stripe.com/billing/subscriptions/webhooks, https://docs.stripe.com/invoicing/integration/workflow-transitions
- Stripe 3-D Secure: https://docs.stripe.com/payments/3d-secure/authentication-flow
- Stripe events list (20 types per call): https://docs.stripe.com/api/events/list
- OpenRouter credits API deprecation: https://openrouter.ai/docs/api/api-reference/credits/deprecated-coinbase-commerce-charge-endpoint
- OpenRouter reasoning and provider routing: https://openrouter.ai/docs/use-cases/reasoning-tokens, https://openrouter.ai/docs/guides/routing/provider-selection
- OpenRouter endpoints: https://openrouter.ai/api/v1/endpoints/zdr, https://openrouter.ai/api/v1/models/openai/gpt-6-astra/endpoints, https://openrouter.ai/api/v1/models/openai/gpt-6.1-terra/endpoints
- Vercel Spend Management (updated 2026-09-18), webhooks, environment variables, Sandbox pricing, terms (updated 2026-10-19): https://vercel.com/docs/spend-management, https://vercel.com/docs/webhooks/webhooks-api, https://vercel.com/docs/environment-variables, https://vercel.com/docs/vercel-sandbox/pricing, https://vercel.com/legal/terms
- Cloudflare Durable Objects pricing (updated 2026-10-18), WebSockets (updated 2026-09-30), R2 pricing (updated 2026-10-26), budget alerts, containers pricing, terms (updated 2025-09-12): https://developers.cloudflare.com/durable-objects/platform/pricing/, https://developers.cloudflare.com/durable-objects/best-practices/websockets, https://developers.cloudflare.com/r2/pricing/, https://developers.cloudflare.com/billing/manage/budget-alerts/, https://developers.cloudflare.com/containers/pricing, https://cloudflare.com/terms
- Upstash pricing: https://upstash.com/pricing/redis
- iOS web push: https://webkit.org/blog/13878
- Fulcio GitHub principal (evidence that real tokens carry `job_workflow_ref`): https://sources.debian.org/src/golang-github-sigstore-fulcio/1.6.5-1/pkg/identity/github/principal.go
