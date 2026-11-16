# Greptile trust, deployment and cost model (with CodeRabbit and Cursor Bugbot for comparison)

Research date: 2026-11-05. Prepared for Vectorscope.

## How this was researched (read first)

- **WebFetch was blocked.** The session's network proxy returned 403 on CONNECT for www.greptile.com, docs.greptile.com, dev.to and others. I could not read the vendor pages in full myself.
- **Most web evidence comes from WebSearch result summaries.** These are search-engine extracts of the named pages, restricted to vendor domains wherever possible. Quoted phrases are as the search tool returned them, not verbatim reads of the pages. When a page had no visible date, I give the index "page age" and work out an approximate date from it (marked "~").
- **Greptile's self-hosted deployment repo was read directly.** I read `github.com/greptileai/akupara` (public) from raw.githubusercontent.com at HEAD `09b7db2cf55079fc553a20cf7ae10a03a9847064`, last pushed 2026-11-04. Commit dates come from the GitHub commit search API. This is the strongest primary evidence in these notes.
- **Dates of X/Twitter posts** were decoded from the post IDs (snowflake timestamps).
- **The session's web-search budget ran out** before two checks: (a) Greptile's self-hosted or Enterprise license price and minimums, and (b) Cursor's on-demand spend-limit docs. Both are listed under open questions.
- **Labels:** **[vendor]** = vendor claim (including a model provider's case study about the vendor). **[independent]** = third-party evaluation, tracker or commentary; quality varies and is noted. **[research]** = study-style writeup (vendor-authored unless noted, not peer-reviewed). **[code]** = read from the vendor's public repo. **[inference]** = my own reasoning.

---

## 1. Greptile

### 1.1 Data retention (cloud)

| Claim | Source (date) | Label |
|---|---|---|
| Greptile Cloud runs on AWS. Customer code is stored "on an encrypted filesystem on our servers" and "remains cached on our machines until access is revoked in your code host, at which point it is deleted." | https://www.greptile.com/security (page age ~18 days, so ~2026-10-18) | vendor |
| After an admin deletes the org, Greptile hard-deletes Customer Data from running production systems within 24 hours. Backups may be destroyed within 30 days, and that can be extended during an incident investigation. | https://www.greptile.com/security (~2026-10) | vendor |
| The API quickstart says each generated index "is stored in our database". No retention window is stated. | https://docs.greptile.com/quickstart (undated) | vendor |
| **Outdated:** the Greptile 2.0 launch post said the cloud product does *not* store code and pulls snippets from the code host as needed. The current security page contradicts this. | https://www.greptile.com/blog/greptile-2 (page age ~758 days, so ~2024-10) | vendor (stale) |
| Self-hosted: PostgreSQL with pgvector stores application metadata, indexes (embeddings) and review state. The `worker` clones repos, runs the review sandbox and stores review state. The `chunker` chunks and embeds code. | akupara `docs/reference/architecture.md` @09b7db2 (2026-11-04) | code |

### 1.2 Training on customer data

| Claim | Source (date) | Label |
|---|---|---|
| ToS §2.2: Greptile "may (i) aggregate and anonymize Customer Data ('De-Identified Data') for analytical purposes and to monitor, improve, or expand the Services, and use such data to train and improve artificial intelligence algorithms and models ('AI Training and Learnings')." Greptile "will solely and exclusively own" De-Identified Data and AI Training and Learnings, but not the underlying Customer Data. It promises "measures and controls designed to remove personally identifiable information, customer-specific references, and sensitive data." | https://www.greptile.com/terms-of-service (page age ~915 days, so ~2024-05, possibly stale); the same language appears on https://www.greptile.com/security (~2026-10) | vendor |
| Opt-out: an org admin goes to Organization Settings → Data & Privacy and turns off "Help us improve Greptile". | https://www.greptile.com/security (~2026-10) | vendor |
| The default is *on*, which makes this an opt-out. Greptile's own pages, as seen through search, do not state the default. | https://humantestsai.net/tools/greptile/ (2026, undated) | independent (low confidence, unverified) |
| Self-hosted: "no Customer Data is collected or processed for machine learning purposes unless explicitly configured by the customer." | https://www.greptile.com/security (~2026-10) | vendor |
| Self-hosted telemetry: services export OTLP traces, metrics and logs only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. "When it is unset (the default) nothing is exported." | akupara `docs/operations/observability.md` @09b7db2 | code |

**[inference]** Greptile Cloud does **not** offer a plain "we never train on your code" promise. It offers de-identified training with an admin opt-out, and Greptile owns the derived models. CodeRabbit and Cursor (with Privacy Mode on) both state no training. This difference matters in enterprise security reviews.

### 1.3 Model providers and zero data retention (ZDR)

| Claim | Source (date) | Label |
|---|---|---|
| "Every provider that processes Customer Data is listed on the Trust Center, and our zero data retention agreements with LLM providers are available under Resources." I did not see the agreements themselves. | https://www.greptile.com/security (~2026-10) | vendor |
| Greptile's Trust Center lists 18 subprocessors, 3 of them AI/LLM providers. They are not named in the extract. | https://synergetic.solutions/resources/trust-center-directory/greptile/ (undated) | independent (weak, secondhand) |
| **Anthropic:** "Claude now powers Greptile's investigative approach to code review", built on the Claude Agent SDK, with a reported ~90% cache hit rate. Self-hosters running "their own Anthropic instances" can scale "without proportional cost increases". An Anthropic DevRel post repeats the 90% cache rate, sub-agents for codebase memory and hooks for determinism. | https://claude.com/customers/greptile (undated); https://x.com/lydiahallie/status/2012580617448239264 (decoded 2026-01-17) | vendor (Anthropic) |
| **OpenAI:** "Greptile takes bug detection beyond code review with GPT-6 Astra". Greptile uses Astra's computer use to test app workflows (starts a dev server for the PR and simulates users). Greptile's Knowledge Base is exposed to Codex over MCP. StartupHub notes the story gives no metrics on accuracy, reverts or cost. | https://openai.com/index/greptile-code-review-codex-astra/ (2026-10-26); https://www.startuphub.ai/ai-news/artificial-intelligence/2026/greptile-s-live-app-tests-need-receipts | vendor (OpenAI); independent commentary |
| **NVIDIA open models:** in a beta of pre-release Nemotron 3 Ultra, reply classification (the "Chat with PR" classifier) was ~4.5x cheaper (~78% below uncached cost) and continuous indexing was 62% cheaper, "with quality holding". NVIDIA's Nemotron 3 Super announcement also names Greptile as integrating the model. | https://www.greptile.com/blog/nvidia-nemotron-ultra-in-code-review (page age ~154 days, so ~2026-06); https://blogs.nvidia.com/blog/nemotron-3-super-agentic-ai/ | vendor |
| Self-hosted supported providers: "Anthropic (required unless you use Bedrock for the same models), OpenAI, Azure AI Foundry, AWS Bedrock". All traffic goes through an internal LiteLLM proxy (`greptile-llmproxy`), and you can point `LLM_PROXY_BASE_URL` at your own LiteLLM. Recommended capacity is at least 100 RPM and 800k TPM. The docs site also lists GCP Vertex AI. | akupara `docs/configuration/llm-providers.md` @09b7db2; https://www.greptile.com/docs/security/selfhost | code; vendor |
| Recommended self-host models: Claude Sonnet 4.6+ and Haiku 4.5+, GPT 5.5+, and OpenAI `text-embedding-3-small` for embeddings. | akupara `docs/installation/requirements.md` @09b7db2 | code |
| The LiteLLM alias `dsv4-flash-leased-nothink` is "Required by new OpenAI based variants". Self-host configs forward it to `gpt-5.6-luna` with `reasoning_effort: low`. It was added 2026-09-28 (commit de29212, #103). | akupara `deploy/docker-compose/llmproxy-config.yaml` @09b7db2 | code |
| **[inference]** The alias name suggests Greptile's hosted pipeline uses a DeepSeek-V4-Flash-class open model, "leased" (probably dedicated capacity) and with thinking off, for a cheap subtask. Self-hosters substitute a small GPT. Not confirmed by any Greptile statement. | — | inference |
| **Cross-family reviewing:** each of the two main families (OpenAI, Anthropic) recalled more high-severity bugs in the *other* family's code than in its own. The companion post reports ~10% higher catch rate with a cross-family reviewer and recommends GPT reviewing Claude-written code and vice versa. | https://www.greptile.com/blog/model-inversion (2026-07-21); https://www.greptile.com/blog/how-to-build-a-code-review-agent (~2026-10/11) | research (vendor-authored, small sample, not replicated) |

**ZDR caveat for any vendor that routes to Anthropic's newest frontier tier.** Anthropic's Fable 5 page makes 30-day retention for safety monitoring the default. Eligible enterprises in the "Enterprise Frontier Safeguards" program get exceptions, and until that rollout finishes eligible customers receive ZDR on Fable 5 and 5.1. Secondary sources say other models (Opus 4.8, Sonnet 4.6, Haiku 4.5) remain ZDR-eligible. A CodeRabbit model-evaluation post acknowledges the same gap. Sources: https://www.anthropic.com/claude/fable (undated, ~2026-08 per secondary coverage) [vendor, Anthropic]; https://explainx.ai/blog/anthropic-claude-30-day-data-retention-enterprise-zdr-august-2026 and https://www.forrester.com/blogs/how-fable-5-and-mythos-5-change-ai-security-data-retention-and-vendor-risk/ [independent]. **[inference]** "We have ZDR with our LLM providers" is now model-specific. A vendor routing Apex-style deep reviews to the newest frontier tier may not be ZDR for those requests. Ask each vendor which models are inside its ZDR scope.

### 1.4 Compliance and enterprise controls

| Claim | Source (date) | Label |
|---|---|---|
| SOC 2 Type II. The SOC 2 report, bridge letter and latest penetration-test report are available through the Trust Center. Internal staff and "respected external security firms" assess the services regularly, and the platform is scanned continuously. | https://www.greptile.com/security (~2026-10) | vendor |
| Also claims HIPAA and GDPR compliance. | https://www.greptile.com/enterprise (undated) | vendor |
| Nudge Security lists PCI, HIPAA, ISO 27001, FedRAMP and CSA STAR for Greptile. Nothing corroborates it, and the list repeats SOC 2, so **do not rely on it**. | https://nudgesecurity.com/security-profile/greptile-com | independent (low quality) |
| Enterprise tier: self-hosting, SSO/SAML, RBAC, GitHub Enterprise Cloud with data residency, GHES, GitLab Self-Managed, Bitbucket Data Center, Gitea. Self-hosted SSO uses BoxyHQ Jackson. | https://www.greptile.com/pricing (~2026-10-20); https://www.greptile.com/enterprise; https://www.greptile.com/docs/security/sso; akupara `docs/reference/architecture.md` | vendor; code |

### 1.5 Self-hosting and air-gapped deployment

| Claim | Source (date) | Label |
|---|---|---|
| Docker Compose for up to ~100 developers on a single VM. Kubernetes/Helm for 100+, with horizontal scaling and HA. | https://www.greptile.com/docs/deployment-options | vendor |
| "The entirety of Greptile's service can be self-hosted in an air-gapped environment", with models and images delivered inside your network. | https://www.greptile.com/docs/security/selfhost | vendor |
| Self-hosting requires an Enterprise license. Container images come from Greptile-shared registry credentials on Docker Hub or AWS ECR (you share your AWS account ID). | third-party guide (via search); akupara `docs/installation/requirements.md` | independent; code |
| Compose single node: 64 GB RAM, 32 CPUs, 1 TB root volume. Docker 23+ and Compose v2.20+. | akupara `docs/installation/requirements.md` @09b7db2 | code |
| The review worker runs **privileged with `SYS_ADMIN`** and a `/sys/fs/cgroup` mount for sandboxing. Clusters with strict Pod Security Standards need an exception. | akupara `docs/reference/architecture.md` and `requirements.md` | code |
| Stack: web, auth-v2/hydra (OIDC), api, webhook, worker, chunker, jobs, llmproxy (LiteLLM), Postgres+pgvector, Valkey, pgbouncer, Hatchet (with its own Postgres and RabbitMQ). | akupara `docs/reference/architecture.md` | code |

### 1.6 Pricing timeline

| When | Model | Source | Label |
|---|---|---|---|
| Before March 2026 | $30/developer/month flat with unlimited reviews | https://www.agent-wars.com/news/2026-05-01-greptile-per-review-pricing; https://greptile-fail.vercel.app/ | independent |
| 2026-03-05 (v4) | $30/dev/month **including 50 reviews**, then $1 per review. The CEO said "Less than 10% of active users will exceed the included usage". Greptile cited a "drastic increase in the number of commits reviewed". | https://www.greptile.com/blog/greptile-v4; https://x.com/dakshgup/status/2029587584775836051 (decoded 2026-03-05) | vendor |
| ~2026-04 | **Flex Usage Limits.** Admins set a dollar cap on "flex" reviews (beyond the 50 included per active developer) per billing period, or $0 to stop extras. At the cap, new flex reviews are skipped until the next period, and included reviews still run. | https://www.greptile.com/changelog (the entry sits near a 2026-04-16 date) | vendor |
| 2026-09-25 | **Plus and Apex tiers launch.** Base = 1 credit ("thorough code review with full codebase context"), Plus = 3 ("deeper review for PRs that need extra scrutiny"), Apex = 10 ("most intensive review for large, complex PRs"), plus Auto. The CEO framed it as "allocate more compute to validation than to generation". | https://www.greptile.com/blog/introducing-plus-and-apex; https://x.com/dakshgup/status/2103522349786304720 (decoded 2026-09-25) | vendor |
| ~2026-10-14 to 10-29 | **Seat fee dropped.** Pro is "Unlimited developers and agents, no seat fees" with **prepaid credits at $1, pooled across the org**. Trackers date it 2026-10-23 (an earlier capture shows 10-14). Pages read 10-04 to 10-15 still show $30/seat with 50 credits/seat. | https://www.usagepricing.com/blueprint/activity/greptile-2026-10-23-pro-seat-fee-dropped; https://repowise.dev/blog/comparisons/greptile-pricing; https://macroscope.com/content/macroscope-vs-greptile-ai-code-review-comparison | independent (trackers) |
| Current (2026-11) | **Starter:** free, 1 developer, 50 credits/month, unlimited repos. **Pro:** no seat fee, $1/credit, credits shared org-wide, 14-day trial. **TREX** (code-execution/test run) costs +3 credits on top of the review, charged only when at least one flow reaches pass/fail. If TREX fails or returns nothing readable, you pay only for the review. **Only completed reviews spend credits.** At zero credits, new reviews pause; auto-recharge is optional. Free for qualified OSS, large discounts for pre-Series A startups. **Enterprise:** custom. | https://www.greptile.com/docs/code-review-bot/billing-seats; https://www.greptile.com/pricing (~2026-10-20); https://www.greptile.com/ | vendor |

**Pricing friction (independent).**
- Under v4, one developer reported 571 PRs/month, which took a bill from $30 to more than $500.
- OSS maintainers said they were billed despite the free-OSS promise.
- An anonymous advocacy page ("Greptile's New Pricing Is Predatory") argued Greptile was the only major bot charging per-review overage on top of seats. Its HN thread drew 17 points and 3 comments.
- Several comparison sites claim credits are per-author and not pooled. That conflicts with the current billing doc (pooled) and probably describes the older per-seat allotment.

Sources: https://greptile-fail.vercel.app/; https://www.usagepricing.com/blueprint/greptile; https://dev.to/jovan_chan_9500711396d4e6/greptile-review-2026-82-bug-catch-rate-the-1review-trap-and-who-should-pay-30month-4jao; https://github.com/auerbachb/claude-code-config/issues/1209 (a user issue titled "cap Greptile's uncapped flex spend"). All [independent], quality low to medium.

### 1.7 How Greptile controls model spend per review (public evidence)

**A. Explicit tiering, exposed to the customer as price** [vendor]. Source: https://www.greptile.com/docs/code-review/review-tiers, .greptile config reference.
- Base, Plus and Apex cost 1, 3 and 10 credits. Each PR is billed at the tier that actually ran.
- **Auto** "picks a tier for each PR from its size, risk, and complexity". The selection algorithm is not published.
- Tier rules are evaluated top-to-bottom, and the first match wins. Rules can match on label, target branch, file path or files changed. Rules only set the tier; separate filters decide whether a PR is reviewed at all.
- The **highest** tier wins across five sources: dashboard default, repo config, any directory config the PR touches, the first matching rule, and a request in the trigger comment.
- Auto counts as "no tier" in that comparison, unless a matching rule explicitly sets Auto.
- A trigger comment (`@greptileai review this at apex`) can raise the tier but never lower it.
- In monorepos, a PR touching directories with different tiers runs at the highest of them.

**B. Self-host kill switch** [code]. Source: akupara `docs/configuration/review-variants.md` @09b7db2. `FEATURE_FLAGS_JSON='{"effort-levels":true}'` enables Base, Plus and Apex. Setting it to `false` means "Every review then runs at Base, which limits inference cost."

**C. Per-subtask model routing via LiteLLM aliases** [code]. Source: akupara `deploy/docker-compose/llmproxy-config.yaml` @09b7db2 (`router_settings.model_group_alias`).

| Alias (worker-side name) | Default upstream |
|---|---|
| `review` | claude-sonnet-4-6 |
| `review-deep` | claude-opus-4-6 |
| `review-light` | claude-haiku-4-5-20251001 |
| `refiner` | claude-sonnet-4-6 |
| `post-review-gate` | gpt-5.4-nano (alt: claude-haiku-4-5) |
| `comment-classifier` | gpt-5.4-nano |
| `rule-optimization` | gpt-5.4-nano |
| `api-chat-completion` | gpt-5.4-nano |
| `addressed-judge` | gpt-5.6-luna |
| `acknowledged-judge` | gpt-6-luna |
| `comment-analytics` | gpt-5.6-luna |
| `reply-agent` | gpt-5.6-luna |
| `memory-learning` | claude-sonnet-4-6 (comment: "could also be openai/gpt-5.6-terra") |
| `memory-clustering` | claude-sonnet-4-6 |
| `memory-embeddings` | text-embedding-3-small |
| `weekly-digest`, `first-week-stats` | claude-haiku-4-5 |

Other settings in the same config:
- `batch_settings` routes `claude-*` and `gpt-4o*`/`gpt-5*`/`chatgpt-*` to provider batch APIs. **[inference]** This is for asynchronous or non-latency-critical jobs at batch discounts.
- `routing_strategy: simple-shuffle`, 2–3 retries, 120 s timeout, 600 s stream timeout.
- `post-review-gate` "is used only on a later review that already has Greptile comments. It is optional but highly recommended: a missing route fails open and the review still posts." **[inference]** This is a cheap nano-model gate on re-reviews, probably to suppress duplicate or already-addressed comments rather than to skip the whole review.

**D. Versioned review "variants"/routing policies, chosen with an internal eval system** [code]. Source: akupara `docs/configuration/review-variants.md`.
- Anthropic policy: `native-rsv11-stndrd4-expansion@3`, requiring Sonnet 4.6.
- OpenAI policies: `greptile-v5.3@6` (needs gpt-6.1-sol, gpt-6-sol, gpt-6-luna, dsv4-flash-leased-nothink) and `v5.2-tiers@2` (gpt-6-sol, gpt-5.6-luna, alias).
- "We compare models and variants against each other with an internal eval system."
- A namespace-level `routing.review` binding can override the fleet default.

Commit history:
- 2026-06-29: "Set default experiment variant and dynamic router for on-prem deploys"
- 2026-07-26: "GPT routing, remove summarizer"
- 2026-09-28: "Default reviews to the rsv11 native routing policy"
- 2026-10-12: "Default on-prem reviews to the v5.2 tiered policy"

At HEAD the docs disagree on which policy ships as default: `llm-providers.md` says rsv11, while `review-variants.md` says Compose/Helm ship `greptile-v5.3@6`.

**E. Prompt caching** [vendor].
- Greptile v3 used ~3x more context tokens than v2 but had "75% lower inference costs for our self-hosted customers" thanks to "extremely high cache hit rates". Source: https://www.greptile.com/blog/greptile-v3-agentic-code-review (~2025-09).
- The Anthropic case study reports a ~90% cache hit rate (cited in 1.3).

**F. Right-sized model per subtask.**
- Greptile uses "the right-sized model, both frontier and open source, for each subtask" and claims "better results than pure Codex or Claude Code review at a tenth of the cost". The post is adapted from an AIE NYC talk in October 2026. Source: https://www.greptile.com/blog/how-to-build-a-code-review-agent [vendor, unverified].
- Talk summaries say a naive review loop costs $3–$25 per PR, and that savings come from reallocating inference across ~20 subtasks, each mapped to a model tier. Sources: https://www.sean-weldon.com/blog/2026-10-28-how-to-build-an-ai-code-review-agent-daksh-gupta-greptile; https://www.startuphub.ai/ai-news/artificial-intelligence/2026/greptile-shows-how-not-to-build-review-bots [independent summaries; figures not audited].

**G. Open models for high-volume cheap work.** Nemotron 3 Ultra for reply classification and indexing (cited in 1.3) [vendor].

**H. Not reviewing at all** [vendor]. Source: https://www.greptile.com/docs/code-review/greptile-config-reference, greptile-json-reference, trigger-code-review.
- `ignorePatterns` (gitignore syntax) skips files during review, though they are still indexed.
- `autoReview: [open|push|rebase]`, where each event implies the earlier ones and `[]` means never. The legacy `skipReview: "AUTOMATIC"` equals `[]`, and @-mentions still work.
- Legacy `triggerOnUpdates` turns re-review on every push on or off. Re-review on push is not the default in the older docs.
- Drafts are not reviewed by default (`triggerOnDrafts: false` in the older reference).
- Older file-count limits "no longer apply" in the new config.
- I found **no public "auto-skip trivial PR" feature.** Auto tier plus the post-review gate are the nearest equivalents.

**I. Billing guards** [vendor]. Source: billing doc, changelog.
- Only completed reviews are charged.
- TREX is charged only when a flow reaches pass/fail.
- Prepaid credits stop reviews at zero.
- The Flex Usage Limit was a dollar cap (in the per-seat era).
- **[inference]** With prepaid pooled credits and auto-recharge off, the prepaid balance is now the hard budget.

---

## 2. CodeRabbit (comparison)

### 2.1 Retention and training

| Claim | Source (date) | Label |
|---|---|---|
| Proprietary code is "never used to train or improve the models in any way". LLM queries are "ephemeral". After comments are posted, CodeRabbit "disposes of the environment" and stores no traces of code. | https://www.coderabbit.ai/trust-center (undated, current) | vendor |
| No source code is retained after review "except when review caching is enabled". | https://docs.coderabbit.ai/faq | vendor |
| The review cache is encrypted (except for OSS projects), used only to speed up reviews, **expires after a maximum of 7 days**, and is **on by default**. Disable it with `reviews.disable_cache: true`. | https://docs.coderabbit.ai/reference/caching | vendor |
| Learnings / knowledge base: CodeRabbit stores data "primarily" as vector embeddings, and code indexing stores vector representations of code. Learnings are on by default. Opting out disables knowledge-base features that need retention and removes stored data. On self-hosted, `knowledge_base.opt_out: true` "immediately and irrevocably" deletes it. | https://www.coderabbit.ai/privacy-policy (page age ~20 days, so ~2026-10-16); https://docs.coderabbit.ai/knowledge-base/learnings | vendor |
| ZDR: the Terms of Use say CodeRabbit has a ZDR policy with both OpenAI and Anthropic. The newer MSA extends this to "other Third-Party AI Model Providers". Trust Center resources list a ZDR amendment with OpenAI and a ZDR certification with Anthropic, and both are named subprocessors. | https://tos.coderabbit.ai/; https://www.coderabbit.ai/legal/msa; https://trust.coderabbit.ai/compliance | vendor |
| A CodeRabbit model-evaluation post acknowledges that Anthropic's Fable needs 30-day retention by default, so business ZDR on it requires separate terms. I could not pin down which post. | coderabbit.ai blog (via search, ~2026) | vendor |
| SOC 2 Type II with a new report every year. A GDPR page exists. | https://www.coderabbit.ai/trust-center/soc; https://www.coderabbit.ai/trust-center/gdpr | vendor |
| **Security incident.** Kudelski Security disclosed it on 2025-01-24: a PR containing a malicious `.rubocop.yml` gave RCE on production. Exposed secrets included Anthropic API keys, and Kudelski claims read/write access to ~1M repos. CodeRabbit rotated credentials within 3 h and moved RuboCop into its sandbox within 12 h. It says RuboCop was the only tool outside the sandbox and added automated sandbox enforcement. Its response was published 2025-08-19. | https://kudelskisecurity.com/research/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories (independent); https://coderabbit.ai/blog/our-response-to-the-january-2025-kudelski-security-vulnerability-disclosure-action-and-continuous-improvement (vendor) | independent + vendor |

### 2.2 Providers

- **OpenAI and Anthropic** "remain the primary engines for producing most of the review comments" (June 2026). Source: https://www.coderabbit.ai/blog/coderabbit-supports-nvidia-nemotron-3-ultra [vendor].
- **NVIDIA Nemotron** (Nano, then Super, then Ultra) powers context gathering and summarization before the frontier models reason. The open models are mainly offered to self-hosted customers, and Ultra is ~2x faster. Sources: https://www.coderabbit.ai/blog/coderabbit-ai-code-reviews-now-support-nvidia-nemotron (~2026-01); https://www.coderabbit.ai/blog/faster-code-reviews-with-nemotron-3-super [vendor].
- **Gemini 3.1 Pro** was benchmarked (Feb 2026) against CodeRabbit's "proprietary blend of OpenAI and Anthropic models". It left fewer, higher-signal comments but found fewer bugs, and it is not in the main mix. Source: https://www.coderabbit.ai/blog/gemini-3-1-pro-for-code-related-tasks-more-focus-higher-signal-to-noise [vendor].
- **Security agent:** GPT-6.1 Sol is reported as its primary model, citing a 2026-10-26 OpenAI announcement. Source: https://dev.to/coldcasetech/coderabbit-uses-openai-gpt-61-sol-as-primary-model-in-its-security-agent-326h [independent, secondhand].

### 2.3 Self-hosting

- Enterprise only, **500+ seats**. CodeRabbit ships a container image (runnable on EKS/ECS etc.).
- Supports GitHub, GitLab, Azure DevOps and Bitbucket DC.
- You connect your own LLM provider/account. The agent sends prompts and code to *your* configured provider.
- You can opt out of all data retention.
- A Reverse Tunnel connector dials out over WSS/443 to reach private GHES, GitLab and Gerrit.
- Sources: https://docs.coderabbit.ai/self-hosted/overview; https://www.coderabbit.ai/blog/introducing-coderabbit-reverse-tunnel [vendor]. Specific Bedrock/Azure setup is not confirmed.

### 2.4 Pricing (2026)

- **Plans:** Free/OSS, Essentials ($24/dev/month annual, $30 monthly), Team ($48 annual, $60 monthly), Advanced ($72 annual; a $90 monthly figure is unconfirmed), Enterprise (custom). Sources: https://docs.coderabbit.ai/management/plans and https://www.coderabbit.ai/pricing [vendor]; Advanced figures from https://www.usagepricing.com/blueprint/coderabbit and https://vibecompare.dev/tools/coderabbit/ [independent].
- Only developers who open PRs are billed; reviewers are free [independent].
- Lite and Pro Legacy plans were sunset on 2026-06-08. Source: https://kb.coderabbit.ai/articles/2508018126-sunset-of-lite-and-pro-legacy-subscription-plans [vendor].
- **Rate limits** are per developer over rolling windows: Essentials 5 PR reviews/hour, Team 8, Advanced 10, Enterprise 12. Source: https://docs.coderabbit.ai/management/rate-limits [vendor].
- **Files per review** are capped at 150 or 300 depending on plan. Reviews over 300 files are not supported even under usage pricing [vendor].
- **Usage-based reviews** (Essentials, Team, Advanced): $1/credit, 4 files per credit, so **$0.25 per reviewed file** beyond the limits. Continuation modes are Automatic, On demand or Off. **The default is Unlimited** until an admin sets a cap. Reviews over the limit are free during an eligible trial. Source: https://docs.coderabbit.ai/management/usage-based-addon [vendor].
- A CLI usage add-on removes per-plan CLI rate limits. CodeRabbit Agent costs $0.40 per agent-minute [vendor].

### 2.5 Spend control

- **2023-era engineering post** [vendor, dated], from https://www.coderabbit.ai/blog/how-we-built-cost-effective-generative-ai-application, https://blog.fluxninja.com/blog/coderabbit-cost-effective-generative-ai and https://dev.to/coderabbitai/how-we-managed-gpt-4-api-cost-at-scale-2893:
  - Cheaper models "accurately identify trivial changes" and summarize/triage before the expensive model runs.
  - A similarity filter avoids regenerating similar comments.
  - A cache skips re-review of files whose incremental changes are similar.
  - OSS users get 3 reviews/hour with a burst of 2.
  - ~20% savings, which the versions attribute to different mechanisms.
- **Current config levers** [vendor], from https://docs.coderabbit.ai/configuration/auto-review and https://docs.coderabbit.ai/reference/configuration:
  - Drafts are skipped by default.
  - `path_filters` and default ignored paths (lockfiles, generated code).
  - `auto_incremental_review` (default true) reviews only commits since the last review.
  - `auto_pause_after_reviewed_commits` (default 5) pauses auto-review on busy branches.
  - Title-keyword and label filters skip silently.
  - Per-developer hourly rate limits and per-review file caps.
- Nemotron handles the cheap context and summarization stage (cited in 2.2).

---

## 3. Cursor Bugbot (comparison)

### 3.1 Privacy, retention and compliance

| Claim | Source (date) | Label |
|---|---|---|
| Bugbot "follows the same privacy compliance as Cursor" and "processes data identically to other Cursor requests". | https://cursor.com/docs/bugbot (page age ~414 days in index; content updated since) | vendor |
| Bugbot does not read files whose path looks like a credential (`.env`, `id_rsa`, `*.pem`, `credentials.json`, `*.tfvars`, Terraform state). Templates like `.env.example` are reviewed, and source code containing hardcoded keys is still reviewed. | https://cursor.com/docs/bugbot | vendor |
| Privacy Mode: no training by Cursor or providers. ZDR agreements are in place with inference subprocessors ("all" on the data-use and enterprise pages, "most models" on the governance page). Exception: data can be stored when abuse detectors trigger. Privacy Mode is on by default for team members, and admins can enforce it. **With Privacy Mode off, Cursor may store and train on code data.** | https://cursor.com/data-use (page age ~63 days, so ~2026-09); https://cursor.com/docs/enterprise/privacy-and-data-governance; https://cursor.com/enterprise | vendor |
| Standard (non-legacy) Privacy Mode lets Cursor temporarily store the code that Cloud Agents and Bugbot Autofix need. Legacy Privacy Mode is not supported for Cloud Agents. | https://cursor.com/docs/cloud-agent/security | vendor |
| When Cyber Safeguards are off for "cyber-verified" Opus models, Anthropic's terms apply, and Cursor "cannot honor zero data retention" or Privacy Mode for those requests. | https://cursor.com/docs/account/enterprise/cyber-safeguards | vendor |
| Certifications: SOC 2 Type II, ISO/IEC 27001:2022, ISO/IEC 42001:2023 and AIUC-1. Pentests by third parties at least annually. No China-headquartered subprocessors. Core services run on AWS. | https://cursor.com/security | vendor |
| Subprocessors: OpenAI, Anthropic and Google are named. The full list is at trust.cursor.com/subprocessors, which I did not read. Government-style guidance says Cursor's custom models are hosted on Fireworks (US/EU/Asia). | https://cursor.com/help/security-and-privacy/privacy (vendor); https://equalexperts.github.io/ai-tool-guidance/tool-guidance/cursor-detailed.html and https://defra.github.io/ai-sdlc-tool-guidance/tool-guidance/cursor-detailed.html (independent, Defra version marked deprecated) | vendor; independent |
| Admin controls: repository blocklist, and Protected Git Scopes (only designated teams can use a repo with Cloud Agents, automations and Bugbot). Enterprises with GHES or GitLab self-managed get private connectivity. | https://cursor.com/docs/enterprise/security-hardening | vendor |
| **No self-hosted Bugbot found.** Cursor's self-hosted agent workers keep inference in Cursor's cloud, so they provide no data residency. | https://www.spotdev.co.uk/blog/self-hosted-cursor-agents | independent |

### 3.2 Model

- June 2026: "Composer 2.5, which now powers Bugbot". If an org has opted out of Composer 2.5, Bugbot "will automatically fall back to the next best available model". Source: https://cursor.com/blog/bugbot-updates-june-2026 [vendor].
- **Earlier pipeline** [vendor; date not confirmed], from https://cursor.com/blog/building-bugbot:
  - 8 parallel passes, each over a differently ordered diff.
  - Bug clustering and majority voting (single-pass-only findings dropped).
  - Validator and filter, then dedupe against prior runs.
  - Resolution rate went from 52% to over 70%. Later replaced by an agentic design.

### 3.3 Pricing

- **Before the change:** $40/user/month ($32 annual). Pro was capped at 200 PRs/month and Teams was unlimited. Source: https://www.cubic.dev/blog/cursor-bugbot-review [independent].
- **2026-05-11 announcement:** Bugbot moves to **usage-based billing** for Teams and Individuals, starting at the first renewal after 2026-06-08.
  - Teams pay from on-demand spend. Individuals use included usage first, then on-demand.
  - "The average Bugbot run costs $1.00-$1.50, depending on PR size and complexity."
  - Staff clarify this is per run, not per PR. Bugbot runs on every push by default.
  - Sources: https://cursor.com/blog/may-2026-bugbot-changes [vendor]; https://forum.cursor.com/t/the-new-usage-based-bugbot-pricing-punishes-iterative-workflows-and-power-users/161134 [independent/staff replies].
- **2026-06-10 update:** "over 3x faster, 22% cheaper, and finds 10% more bugs". Average review is ~90 s, down from ~5 min. Bugs found per run rose from 0.56 to 0.62. Sources: https://cursor.com/blog/bugbot-updates-june-2026; https://x.com/cursor_ai/status/2064774675021119825 (decoded 2026-06-10) [vendor].
- **Real-world outlier:** one large monorepo reported ~$30 per run and $300 in 2 days. Source: https://forum.cursor.com/t/optimizing-bugbot-costs-in-a-large-monorepo-30-per-run-and-300-in-2-days-any-best-practices/164241/6 [independent anecdote].
- The dashboard spend limit covers all on-demand usage (chat plus Bugbot), not Bugbot alone. Source: https://omidsaffari.com/blog/cursor-bugbot [independent, unverified].

### 3.4 Spend control

- **Effort levels** Low/Default/High/Smart, available on usage-based plans only. Smart picks a level from your instructions. High finds 35% more bugs with the resolution rate holding at 80%. Sources: https://cursor.com/docs/bugbot; https://cursor.com/blog/may-2026-bugbot-changes [vendor].
- **"Run only once per PR"** (per-repo/installation setting) skips later commits [vendor].
- **Incremental review** covers only what changed since the last pass. `/review` runs locally before pushing [vendor].
- Findings are deduplicated against prior runs, and credential-like files are excluded [vendor].

---

## 4. Side-by-side summary (as of 2026-11-05)

| | Greptile | CodeRabbit | Cursor Bugbot |
|---|---|---|---|
| Trains on customer code? | De-identified training allowed by ToS; admin opt-out ("Help us improve Greptile"); none on self-hosted | No | No with Privacy Mode; yes possible with it off |
| ZDR with LLM providers | Claimed; agreements on Trust Center | Claimed (OpenAI amendment, Anthropic certification) | Claimed under Privacy Mode; carve-outs for abuse flags and cyber-verified Opus |
| Code at rest (cloud) | Encrypted cache until code-host access revoked; 24 h hard delete on org deletion, 30-day backups | Ephemeral by default; review cache ≤7 days (on by default); embeddings/learnings until opt-out | Same as Cursor; temporary storage for agents/Autofix |
| SOC 2 Type II | Yes (+ HIPAA/GDPR claimed) | Yes (+ GDPR) | Yes (+ ISO 27001, ISO 42001, AIUC-1) |
| Self-host / air-gap | Yes, Compose or K8s, air-gapped, BYO LLM via LiteLLM (Anthropic/OpenAI/Azure/Bedrock); Enterprise | Yes, Enterprise ≥500 seats, BYO LLM | No self-hosted Bugbot |
| Providers | Anthropic (Claude Agent SDK), OpenAI (GPT-6 Astra etc.), NVIDIA Nemotron; open models | OpenAI + Anthropic primary; Nemotron for context/summarization | Composer 2.5 (in-house); fallback model unnamed |
| Unit price | $1/credit: Base 1, Plus 3, Apex 10, TREX +3; no seat fee (since ~Oct 2026) | Seats $24–$72/dev/mo + $0.25/file over limits | Usage-based; ~$1.00–$1.50 per run (May 2026), −22% (June) |
| Customer-facing spend levers | Tier rules/Auto, prepaid balance, auto-recharge off, ignore patterns, autoReview events, drafts off | Hourly rate limits, file caps, usage cap (default unlimited), drafts/path/title/label filters, incremental + auto-pause | Effort levels, run-once-per-PR, incremental review, on-demand spend limit |

---

## 5. Implications for Vectorscope (all [inference] unless noted)

1. **Price on the unit that drives cost, and make depth explicit.** Greptile's pricing moved from seats, to seats plus overage, to pure credits with 1/3/10 tiers within 8 months. Cursor moved to per-run billing. Both moves track AI agents raising PR and commit volume. Vectorscope should expose a review "depth" and a predictable per-review cost, not hide it.
2. **Build a tier resolver like Greptile's.** It should be deterministic and documented, with rules (label, branch, path, files changed) and a "highest wins, comments can only raise" rule. Add an Auto tier and publish its inputs (size, risk, complexity) and its decisions so they can be audited.
3. **Put an alias layer between the pipeline and the models.** Use one alias per subtask (review, review-deep, review-light, refiner, post-review-gate, comment-classifier, judges, embeddings, digests), with a per-deployment routing policy that is versioned and eval-gated (`policy@version`). This gives self-host/BYO-LLM support, cross-family reviewer choice, and cheap-model substitution for free. Greptile's akupara config is a concrete template [code].
4. **Gate re-reviews cheaply.** Put a nano-class gate on any review of a PR that already has bot comments, failing open. Default to incremental review of only new commits, plus a run-once-per-PR option. Cursor's per-push billing backlash shows re-runs dominate spend.
5. **Only charge or count completed work**, and charge optional extras (e.g. execution or test runs) only when they produce a readable result. Provide a hard budget: a prepaid balance, or a dollar cap that skips new optional reviews. CodeRabbit's usage cap defaults to "Unlimited", and users push back on uncapped defaults (GitHub issue #1209 for Greptile flex spend).
6. **Design prompts to be cache-first.** Greptile attributes a 75% inference cost cut (v3) and ~90% cache hits to prompt caching [vendor]. Put stable codebase context in front and per-PR deltas last.
7. **Use the cheapest model that works for high-volume side tasks**, such as reply classification, indexing summaries, digests and comment analytics. Batch APIs for asynchronous jobs are a further cut [code + vendor].
8. **Trust posture.** Default to no training (Greptile's opt-out is a weak spot competitors exploit). Publish exactly which models are inside ZDR scope, since Anthropic Fable-class models need 30-day retention by default. Exclude credential-like files from model context (as Bugbot does). Sandbox **every** tool that executes repo-controlled config; the CodeRabbit RuboCop RCE leaked provider API keys. Turn telemetry off by default for self-host (as Greptile does).
9. **Self-host requirements to plan for.** Greptile needs privileged sandbox workers (SYS_ADMIN), a 64 GB / 32 CPU / 1 TB single node, at least 100 RPM / 800k TPM of LLM quota, and registry credentials. CodeRabbit sets a 500-seat minimum. A lighter self-host story could set Vectorscope apart.

---

## 6. Open questions / gaps

- Greptile Enterprise and self-hosted license pricing and minimums: not found (search budget exhausted).
- Names of Greptile Cloud's 3 LLM subprocessors and the scope of its ZDR agreements, especially for Apex-tier models and any Fable-class model. The Trust Center was not readable.
- Whether Greptile's training opt-out is on by default for new orgs, and whether Enterprise contracts disable it.
- How Greptile's Auto tier actually chooses (thresholds and features), and how `review-light`, `review` and `review-deep` map to Base, Plus and Apex.
- Does the hosted Greptile pipeline really use a DeepSeek-V4-Flash-class model (`dsv4-flash-leased-nothink`), and through which provider or region?
- Current Cursor per-run rate card after the June 2026 cut, and whether a Bugbot-only spend limit exists.
- CodeRabbit: whether the embeddings / code index have a retention limit (only the cache has a 7-day limit), and whether self-hosted supports Bedrock/Azure specifically.
- Exact date of Cursor's "Building a better Bugbot" post and of Greptile's Flex Usage Limits changelog entry.
