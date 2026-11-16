# Round three, lens: tokenomics and ZDR in late 2026

Lane note as written before the adversarial verify pass; REPORT-3 states each finding in its verified, corrected form.

Compiled 2026-11-07. Read-only on the worktree `/home/user/wt/vectorscope` (head 41a64e5e). No Bun was run, and no paid API was called.

**Evidence labels:**
- **vendor:** the company's own page, docs mirror or SDK text about its own product;
- **independent:** a third party that measured or aggregated something;
- **community:** an issue or PR by a third-party developer;
- **code:** something I read in source;
- **inference:** my own arithmetic or reasoning.

Every number carries its source sentence, quoted exactly where I could.

## 0. Reachability, and what this round could not do

- **Blocked:** developers.openai.com, openai.com and apievangelist.com would not resolve, and the openrouter.ai API returned 403 on CONNECT. For the first three hosts to be read, they have to be allowed in the session's network settings.
- **Search budget:** the shared WebSearch budget ran out after two searches. I did no further searching and did not route around the limit.
- **What worked:**
  - platform.claude.com and code.claude.com, through WebFetch;
  - github.com pages;
  - `git clone` of public repositories: the OpenRouterTeam/docs mirror at cf50b6d (2026-11-07), github/docs at 8cd1075 (2026-11-06), openai/openai-cookbook, and kodustech/kodus-ai;
  - raw.githubusercontent.com (LiteLLM's price table);
  - the npm registry (`openai` 7.53.0, 2026-11-06);
  - PyPI (botocore 1.43.126, 2026-11-06).
- **OpenAI prices therefore rest on three secondary sources that agree with each other:**
  - OpenRouter's docs for the OpenAI route (vendor of the route);
  - LiteLLM's price table (independent aggregator, read as code);
  - a community issue that quotes OpenAI's docs as of 2026-10-21.
- **None of them is OpenAI's own page.** Google prices rest on the aggregator alone.

## 1. What rounds one and two already concluded on this lens (not repeated below)

- **Round one (REPORT §4.2, enablers §3):**
  - the Anthropic price table, including Opus/Sonnet 5.5 at 0.05x cache reads and Haiku 5.5's >100K tier;
  - caching break-even: a 5-minute write pays back after one reuse, a 1-hour write after two;
  - parallel fan-out defeats caching unless it waits;
  - Batch is not ZDR-eligible (29-day retention);
  - count tokens only with the provider that serves the request;
  - "shrinking context saves more than caching".
- **Round two (G3, G4; REPORT §1 items 6 and 10):**
  - the agentic hit rate is mechanical: h(S) = 1 − (P + (S−1)R)/(S·P + R·S(S−1)/2);
  - OCR-on-AACR runs 334–743K gross tokens per PR, and a capped reviewer uses 5.4–14.7x fewer tokens than an uncapped agent;
  - on Opus 5.5, an OCR-shaped review costs $0.46–1.70;
  - OpenAI gpt-5.5+ supports only 24-hour cache retention;
  - OpenRouter's ZDR leaks: Safety Retention is allowed by default on self-serve accounts; Claude is served on Bedrock/Vertex and GPT on Azure; response caching; server tools; Fusion;
  - Vertex defaults to durable caching, and Bedrock has an account retention mode.
- **These became VS-33 and VS-40 in addendum A.** VS-40's h(S) and write premium are built in core (`packages/core/src/review/dispatch.ts:165-226`).
- **Round two left open:**
  - whether OpenAI's extended cache is inside ZDR;
  - the Vertex and Gemini terms;
  - Azure and Together retention;
  - Bedrock cache points under ZDR;
  - OpenRouter's exact `zdr: true` error body.

## 2. Current prices that change review cost (USD per million tokens)

### 2.1 Anthropic (vendor, https://platform.claude.com/docs/en/about-claude/pricing, undated, accessed 2026-11-07)

| Model | Input | 5m write | 1h write | Cache read | Output | Batch in/out |
|---|---|---|---|---|---|---|
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 | 2 / 10 |
| Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 | 10 | 1 / 5 |
| Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 | 1 / 5 |
| Sonnet 4.5 (deprecated) | 3 | 3.75 | 6 | 0.30 | 15 | 1.50 / 7.50 |
| Haiku 5.5, prompt ≤100K | 0.10 | 0.125 | 0.20 | 0.01 | 0.50 | 0.05 / 0.25 |
| Haiku 5.5, prompt >100K | 0.50 | 0.625 | 1 | 0.05 | 2.50 | 0.25 / 1.25 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 | 0.50 / 2.50 |

Exact sentences:
- "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price."
- "Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000 tokens pays higher prices. A request's prompt length counts all of its input tokens, including cache reads and cache writes."
- "The Batch API allows asynchronous processing of large volumes of requests with a 50 percent discount on both input and output tokens."
- "For Claude 4.6 and later models, specifying US-only inference through the `inference_geo` parameter incurs a 1.1x multiplier on all token pricing categories".
- "Regional and multi-region endpoints include a 10 percent premium over global endpoints." This applies on Bedrock and on Google-managed Vertex, which is where OpenRouter's ZDR route serves Claude.
- Fast mode: "Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok". "Fast mode is not available with the Batch API."
- Sonnet 5's footnote: "The $2/$10 per million input/output token pricing for Claude Sonnet 5 ... is now the standard price."

### 2.2 OpenAI (secondary sources; OpenAI's pages were unreachable)

The LiteLLM table (`model_prices_and_context_window.json`, main, fetched 2026-11-07) and Vector's own catalog snapshot (`packages/web/public/models/api.json` at 255cfd83, 2026-10-28) agree:

| Model | Input | Cached | Cache write (30m) | Output | Above 272K (in / out) | Batch / Flex | Priority |
|---|---|---|---|---|---|---|---|
| gpt-6.1-sol | 2 | 0.10 | 2.50 | 10 | 4 / 15 | 50% | 2x |
| gpt-6.1-terra | 1 | 0.05 | 1.25 | 5 | 2 / 7.5 | 50% | 2x |
| gpt-6-luna | 0.10 | 0.01 | 0.125 | 0.50 | 0.20 / 0.75 | 50% | 2x |
| gpt-5.6-luna | 0.20 | 0.02 | 0.25 | 1.20 | 0.40 / 1.80 | 50% | 2x |
| gpt-5.5 | 5 | 0.50 | (none) | 30 | 10 / 45 | 50% | 2.5x |

The multipliers are stated by OpenRouter for its OpenAI route (vendor of the route, `guides/best-practices/prompt-caching.mdx`, synced 2026-11-06):
- "Cache writes: no cost on models before the GPT-5.6 family. GPT-5.6 and later charge cache writes at 1.25x the price of the original input pricing, even with automatic caching — no opt-in required."
- "Cache writes (12-hour TTL): charged at 2.5x the price of the original input pricing".
- "To turn caching off for a request, set `prompt_cache_options.mode` to `"explicit"` and do not mark any content block with `prompt_cache_breakpoint`."

They are corroborated by a community summary of OpenAI's docs, as checked on 2026-10-21 (https://github.com/code-yeongyu/senpi/issues/3901): "cache write at 1.25x input"; "(Responses API only, cache write at 2.5x input)"; "Reads cost the same for both lifetimes (0.1x input, 0.05x on GPT-6.1 Sol)."

**Contradiction.** OpenAI's own cookbook says "It works automatically on all API requests and has no additional fees" (`examples/Prompt_Caching_201.ipynb`, last changed 2026-09-16). That predates GPT-5.6's paid writes and is outdated for gpt-5.6 and later.

**Another stale vendor line.** OpenRouter's caching guide still says OpenAI reads are "charged at 0.25x or 0.50x". It also gives Google reads a 0.25 multiplier (`snippets/exports/constants.mdx`). Both contradict the per-model prices, which work out to 0.05–0.1x. Estimates must use per-model prices, never these doc multipliers.

### 2.3 Google and open-weight models (aggregator only, LiteLLM, fetched 2026-11-07; treat as unverified)

- Gemini 4 Argon: $2 / $10, cached $0.10.
- Gemini 3.5 Flash: $1.50 / $9.
- Gemini 3.6–3.8 Flash: $0.75 / $3.75.
- Gemini 3.1 Pro preview: doubles above 200K tokens.
- DeepSeek V4 Flash (DeepSeek direct): $0.30 / $1.20, cached $0.006.
- GLM-5.3 (Z.ai): $1.40 / $4.40.
- Qwen3.8-Max: $2 / $6.

Under a strict OpenRouter ZDR policy most Google models are unavailable (round two G4 §1.2). Whether DeepSeek, GLM and Qwen have ZDR endpoints needs `GET /api/v1/endpoints/zdr`, which was blocked.

### 2.4 Route fees (vendor, OpenRouter docs mirror, cf50b6d, 2026-11-07)

- **Credit purchases:** `faq.mdx` says "OpenRouter charges a {getTotalFeeString('stripe', null)} fee when you purchase credits"; the constant is `'5.5% ($0.80 minimum)'`.
- **No markup:** "We pass through the pricing of the underlying model providers without any markup".
- **Your own key:** "Usage above the allowance has a fee of {BYOK_FEE_PERCENTAGE}% ...", with `BYOK_FEE_PERCENTAGE = '5'` and a pay-as-you-go allowance of `'$25,000'` a month.

So the eval key's effective price is list × 1.055 (inference).

## 3. Reasoning-token billing on Claude 5.5 (new)

- **Thinking is billed as output, in full** (https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost, undated, accessed 2026-11-07):
  - "Tokens Claude uses while thinking (billed as output tokens)".
  - "You are billed for the full thinking process, not the thinking content visible in the response."
  - Prior thinking blocks that stay in context are "billed as input tokens".
  - The response reports `usage.output_tokens_details.thinking_tokens`.
- **No budget, only `max_tokens` and effort:**
  - "You don't set a thinking token budget."
  - "In a tool-use loop, each request in the turn has its own `max_tokens`, so it doesn't bound the whole turn's spend."
- **Changing effort breaks the cache:** "The resolved effort value is rendered into the prompt, so changing it between requests invalidates cache breakpoints".
- **Defaults:**
  - Anthropic: "`medium` (default on Claude Opus 5.5 and Claude Haiku 5.5)"; "`high` (default on most models)".
  - OpenRouter's migration guide (`cookbook/evaluate-and-optimize/model-migrations/claude-5-5.mdx`, 2026-11-04) gives the default effort as "`medium` | `high` | `medium`" for Opus, Sonnet and Haiku 5.5.
  - The same guide: "Budgets are not forwarded"; Opus 5.5 "rejects `tool_choice` set to `{"type": "any"}` or a named tool"; Haiku 5.5's thinking "can be turned off".
- **VectorScope sets no effort** unless an agent variant is configured (`packages/engine/src/review/model.ts`, the variant only when the agent's own model is chosen; `transform.ts:839-925` defines variants). So a Sonnet 5.5 verifier runs at `high` by default (code plus vendor).

## 4. ZDR: routes and exact conditions (late 2026)

| Route | ZDR available? | Exact conditions and residuals | Cost effect |
|---|---|---|---|
| Anthropic direct (`api.anthropic.com`) | Yes, per organisation through sales | "To request ZDR for your organization, contact the Anthropic sales team." Prompt caching: "Yes ... KV cache representations and cryptographic hashes are held in memory for the cache TTL and promptly deleted after expiry." Fast mode: "ZDR applies regardless of speed setting." Threshold compaction, context editing and the advisor tool are eligible. Batch is not: "29-day retention; async storage required." Fable and Mythos "are not available under ZDR unless expressly authorized by Anthropic." Residual: "if a chat or session is flagged, Anthropic may retain inputs and outputs for up to 2 years." (vendor, api-and-data-retention page, accessed 2026-11-07) | Caching keeps full value. Batch's 50% is lost. Data residency costs 1.1x. |
| Anthropic's own reviewers | **No** | Code Review "isn't available to organizations with Zero Data Retention enabled"; Ultrareview "is not available to organizations that have enabled Zero Data Retention" (vendor, code.claude.com, accessed 2026-11-07). **New.** | Market context: Anthropic's own PR reviewer does not serve ZDR organisations. |
| OpenRouter, ZDR enforced on the account | Yes, by model group (round two) | Self-serve accounts allow Safety Retention unless changed. Claude is served on Bedrock or Vertex, GPT on Azure. Most Google models are out. **New:** the Batch API "cannot run when your privacy settings require ZDR for the model's provider", "Deleted 30 days after you submit", and "Batch runs on US-based infrastructure" (`guides/features/batch-api.mdx`, added 2026-11-04). **New:** the workspace default `service_tier` and preset tiers (`service-tiers.mdx`, 2026-11-04). **New:** "Sticky sessions expire after **60 minutes** of inactivity" (was 10 minutes; 2026-11-06). | Caching works (OpenRouter treats in-memory caching as not retention). Batch is lost. Regional endpoints add 10% (inference). |
| OpenAI direct | Per organisation/project | Community readings of OpenAI's docs: "every prompt-cache feature is ZDR-compatible" (https://github.com/mostlydev/cllama/pull/69, 2026-10-26, the author's paraphrase). gpt-5.5 and gpt-5.5-pro support only `24h` (`openai` 7.53.0 SDK types, 2026-11-06). Extended caching keeps KV tensors on GPU-local storage (round two). Flex and Batch terms unread. | With an `extendedCache` attestation, caching is as normal. Without it, gpt-5.6+ can run with caching off, at +75% on a verify pass (§6). |
| Bedrock | Account mode `none` (round two) | botocore 1.43.126 (2026-11-06) still has `DataRetentionMode` default/none/aws_review/provider_data_share/inherit, `CacheTTL` 5m/1h, and `ServiceTierType` priority/default/flex/reserved. Cache points under ZDR are still unread. | Regional endpoints cost +10% (Vector's catalog lists us./eu./jp./au. Opus 5.5 at $4.40/$22). |

## 5. Published cost per review or per PR

| Source | Figure (exact) | Kind | Date |
|---|---|---|---|
| Anthropic Ultrareview | "typically \$5 to \$25 in usage credits depending on the size of the change"; diff cap "up to 500 changed files and 8,000 changed lines"; "A review typically takes 5 to 15 minutes." | vendor | undated, accessed 2026-11-07 (https://code.claude.com/docs/en/ultrareview) |
| Anthropic Code Review | "Code Review has no flat per-review price." "Code Review also skips reviews once what's left is less than the expected cost of one review." | vendor | undated, accessed 2026-11-07 (https://code.claude.com/docs/en/code-review-costs) |
| GitHub Copilot code review | `copilot_code_review_lite_average_cost: '$0.25 USD'`, balanced `'$1.50 USD'`, max `'$10 USD'`; ranges `'$0.05 USD to $1 USD'`, `'$0.25 USD to $5 USD'`, `'$1.50 USD to $25 USD'`; "Estimates exclude ... Actions minutes." | vendor (re-verified) | github/docs `data/variables/copilot.yml` at c9d8b26, 2026-11-06 |
| Cursor Bugbot | "The average Bugbot run costs $1.00-$1.50, depending on PR size and complexity." Then "22% cheaper" | vendor (round one) | 2026-05-11 and 2026-06-10 |
| Greptile | $1 per credit: Base 1, Plus 3, Apex 10; a TREX run costs 3 | vendor (rounds one and three) | 2026-09-25 and 2026-10-16 |
| Greptile build-vs-buy page | frontier-model reviews at "about $3 to $15 each" | vendor (round-three Greptile notes) | undated |
| Fletcher (single pass) | about $0.085 and $0.19 per PR | user self-report (round two GU9) | 2026 |
| OCR on AACR (Opus 4.6) | 385K gross tokens per PR, which is $0.55–2.12 depending on cache share | vendor data plus round-two arithmetic | 2026-11-05 |

The independent anchors are SWE-bench mini-agent per-task costs (round two, p50 $0.28–0.57) and Cursor forum anecdotes ("~$30 per run" in a monorepo, round one). No independent per-PR dollar measurement of a code reviewer was found this round.

## 6. What VectorScope's pipeline should cost per PR (inference, formulas below)

### 6.1 Model

For one agentic pass:
- S = steps;
- P = first-turn prompt (static prefix Ps + diff D + slice and cards C);
- R = tokens each step adds;
- O = output tokens per step, thinking included;
- automatic caching with a breakpoint on the last message, all steps inside the TTL.

```
gross input  G = S·P + R·S(S−1)/2
written      W = P + (S−1)·R          (each step's delta becomes the next step's prefix)
read         Rd = G − W               (h = Rd/G, VS-40's h(S))
cost         C = Σ_k m_k·p_in·(w·W_k + r·Rd_k) + Σ_k m'_k·p_out·O
               with m_k, m'_k = the long-context multipliers when L_k = P + (k−1)R exceeds the tier
               (Haiku 5.5: 5x/5x above 100K; OpenAI gpt-5.5+: 2x/1.5x above 272K)
uncached     C = Σ_k m_k·p_in·L_k + Σ_k m'_k·p_out·O
PR cost      = Σ triage passes (review, security if sensitive, lenses if high band) on the triage model
               + one verify pass on the strong model.  Tier 3 (guardrail) is pure code: 0 tokens.
```

The structure follows the code. `run.ts:690-702` runs review and security on `triage`, with security capped at ceil(2/3·maxSteps); verify runs at `VERIFY_STEPS = 10` on `model`. `guardrail.ts` is pure.

### 6.2 Parameters (inference, each anchored)

| Size | Changed lines / files | P (Ps + D + C) | Review S, R | Security S | Lenses | Verify P, R, S | Gross tokens |
|---|---|---|---|---|---|---|---|
| Small | about 50 / 2 | 7.5K (4K + 2K + 1.5K) | 5, 2.0K | none | none | 7K, 1.5K, 3 | 83K |
| Medium | about 300 / 8 | 18K (4K + 10K + 4K) | 10, 2.5K | 7 | none | 10K, 2K, 6 | 561K |
| Large | about 1,500 / 30 | 52K (4K + 40K + 8K) | 20, 3.0K | 14 | 3 × 8 steps | 14K, 2.5K, 10 | 4.36M |

The anchors:
- **Small:** VectorScope's one measured review, 79.3K input over 5+4 steps with P ≈ 5.3K and R = 2K (`plan.ts:24-29`), against 83K here.
- **Medium:** AACR's OCR range, 334–743K at a mean of 242 lines (round two G3-1).
- **Large:** CRBugBench's fix-track p90 of 1,894 lines, about 33K diff tokens (G3 §6).
- **Output per step:** O = 1,500 for triage and 1,800 for verify. 1,800 is the measured figure, "reasoning included" (`plan.ts:28-29`).
- **Uncertainty:** treat these as medians. SWE-bench shows p90/p50 of 2–4.4x (G3 §2.1).

### 6.3 Results (USD per PR, list prices, 5-minute caching on every route)

| Triage → verify | Small | Medium | Large | Verify share (medium) | Uncached (small / medium / large) |
|---|---|---|---|---|---|
| Haiku 5.5 → Opus 5.5 | **0.17** | **0.36** | **0.74** | 93% | 0.22 / 0.64 / 1.96 |
| Haiku 5.5 → Sonnet 5.5 | **0.09** | **0.19** | **0.45** | 86% | 0.11 / 0.35 / 1.28 |
| gpt-6-luna → gpt-6.1-sol | 0.09 | 0.19 | 0.43 | 86% | 0.11 / 0.35 / 1.14 |
| Haiku 5.5 → gpt-6.1-sol (cross-family) | 0.09 | 0.19 | 0.45 | 86% | n/a |
| gpt-6-luna → Opus 5.5 (cross-family) | 0.17 | 0.36 | 0.72 | 93% | n/a |
| Sonnet 5.5 only | 0.20 | 0.64 | 2.58 | 26% | 0.30 / 1.49 / 9.78 |
| Opus 5.5 only | 0.40 | 1.29 | 5.16 | 26% | 0.59 / 2.97 / 19.55 |
| Haiku 4.5 → Sonnet 4.5 (Phase A's D6 pair) | 0.18 | 0.52 | 1.80 | 50% | 0.25 / 1.03 / 5.57 |
| Sonnet 4.5 only | 0.31 | 1.04 | 4.46 | 25% | 0.44 / 2.23 / 14.67 |

What the model shows:
- **Cheap triage is the largest saving.** Against Opus-only it saves 58%, 72% and 86% at the three sizes. Gross tokens are not cost; strong-model tokens are.
- **With cheap triage, the verify pass is the cost.** It is 86–96% of the total on small and medium PRs (79% on the large Haiku → Opus case), and output is 61–67% of verify's cost at O = 1,800.
- **Verify effort is the next lever.** Halving verify output (O = 900) cuts the Opus verify pass from $0.330 to $0.222 on a medium PR. Doubling it (O = 3,600, plausible for Sonnet 5.5's default `high`) raises it to $0.546.
- **Caching is worth 24–62%** on the Haiku → Opus pair, and 33–74% on Sonnet-only.
- **Fit against caps:**
  - Only the cheap-triage pairs fit the D5 pilot's $0.75 per case at every size; the large Haiku → Opus case only just fits.
  - Sonnet-only and Opus-only exceed the $2 per-review default on large PRs.
  - Phase A's projection of $0.27 per case (Sonnet 4.5, one canned step) matches the small row.
- **Haiku 5.5's long-context tier.** On the large review pass, 3 of 20 steps cross 100K. That pass then costs $0.0695 instead of $0.0436 (+59%); small in dollars, invisible to today's estimator (§7, item 3).

## 7. Code facts found this round (all code, read-only)

1. **Fan-out hold has no cache benefit today.**
   - The review and security passes use different agents with different system prompts (`packages/engine/src/agent/agent.ts:518-575`, `PROMPT_REVIEW` and `PROMPT_SECURITY`).
   - The user prompt starts with `TASKS[kind]` (`packages/core/src/review/prompt.ts:342`).
   - So two specialists' prefixes diverge before the diff. VS-40 item 4's 5-second hold buys at most the shared tool definitions.
   - Within-pass caching is already on: `applyCaching` marks the first two system messages and the last two others as ephemeral (5 minutes) for Claude-family models (`packages/engine/src/provider/transform.ts:455-480, 563-588`).
   - A shared-prefix layout would save about 6% (medium) and 17% (large) on Sonnet-on-Sonnet, assuming 90% of P is shared between passes on the same model, and under 3% with Haiku triage (§6 arithmetic). That layout is: one common agent prompt, then the diff, slice and cards, then the kind-specific trusted task last, which I-2's "trusted instructions last" allows.
2. **Catalog price error.**
   - `packages/web/public/models/api.json` (255cfd83, 2026-10-28) lists Sonnet 5.5 `cache_read: 0.2` under anthropic, amazon-bedrock, google-vertex-anthropic and openrouter. Anthropic lists $0.10.
   - This inflates Sonnet-only estimates by 7% (medium) and 15% (large).
   - Haiku 5.5 appears only under openrouter, not under direct anthropic, Bedrock or Vertex. The live catalog was not checked.
3. **Long-context tiers are ignored by the estimator.**
   - The engine's cost schema has `tiers` and `experimentalOver200K` (`packages/engine/src/provider/provider.ts:1199-1200, 1471-1511`).
   - VectorScope's `ReviewPrice` has only input, output, cacheRead and cacheWrite (`packages/core/src/review/plan.ts:17-22`), so VS-40 prices every step at the base tier.
4. **OpenRouter Batch is not refused by path.**
   - `BATCH_ENDPOINT` covers `/v1/messages/batches`, `batchPredictionJobs` and `model-invocation-job(s)` only (`packages/core/src/review/privacy.ts:370-371`). OpenRouter requests get a body check only (`zdrBodyRefusal`, `privacy.ts:246-276`).
   - A body with `endpoint`, `model`, `requests` and `callback_url` has no tools or messages at top level, so it would pass, and `zdrRequestBody` would add `provider.zdr`.
   - No VectorScope code issues batches today. This is defence in depth.
5. **Eval price strings cannot express caching.** They are `model=input:output` only (`script/vectorscope-eval/ci.ts:116`, README:205), so Phase A projections price every input token as uncached.

## 8. Which caching or batching changes would cut cost most without breaking ZDR (ranked by dollars saved per medium PR, Haiku 5.5 → Opus 5.5 unless noted)

| Rank | Change | Saving | ZDR status |
|---|---|---|---|
| 1 | Keep cheap triage with strong verify, rather than a strong model throughout (a model choice, not caching) | $0.93 a PR against Opus-only (−72%) | Neutral: every model is non-Covered and ZDR-eligible on Anthropic direct |
| 2 | Keep 5-minute within-pass caching on every route (already on for Claude; on OpenAI gpt-5.6+ it needs the `extendedCache` attestation, or it is lost) | $0.28 (−44%); OpenAI verify $0.288 → $0.165 | Anthropic: eligible. OpenAI: attestation (VS-33) |
| 3 | Pin verify effort, fixed for the session (medium or low on verify, low on triage) | $0.11 per halving of verify output | Neutral; quality must be measured |
| 4 | OpenAI Flex for the verify pass (50% off, synchronous) | about $0.08 | **Unverified**; OpenAI's terms were unreachable |
| 5 | Shared-prefix prompt layout (§7, item 1) | about $0.002 on Haiku triage; $0.04 on Sonnet triage | Neutral |
| 6 | 1-hour cross-review cache for the stable prefix | ≤$0.02 a pass at a 4K prefix; about $0.08 at 20K with 10 reviews an hour; a loss at 1 review an hour | Eligible ("held in memory for the cache TTL") |
| 7 | Batch, on any provider | 50% | **Not ZDR**: Anthropic 29 days, OpenRouter 30 days. Excluded. |

## 9. Findings

- **T3-1 (high, new).** Sonnet 4.5, the D6 candidate behind Phase A's projections and the eval README's examples, retires on the Claude API on 2026-11-30.
  - Source: "| November 30, 2026 | `claude-sonnet-4-5-20250929` | `claude-sonnet-5-5` |" (model-deprecations page, deprecated 2026-09-30).
  - Haiku 4.5 is "Active ... Not sooner than October 15, 2026"; that date has passed.
  - Sonnet 5.5 costs about 33% less on input and output and 67% less on cache reads.
  - **Proposal:** an owner question to re-pick D6 as Sonnet 5.5, plus Haiku 5.5 as the cheaper model. Re-run the zero-spend projections, update the price strings and the README examples, and log it as a deviation.
- **T3-2 (high, new).** Cheap triage with strong verify costs about $0.09–0.17 (small), $0.19–0.36 (medium) and $0.43–0.74 (large) per PR. Verify dominates.
  - **Proposal:** VS-40's report splits cost by pass and by input or output. Add "verify output cap or effort" and "a candidate cap before verify" to the shrink levers, both measured in the funded ablation.
- **T3-3 (high, new).** Claude 5.5 thinking is billed in full as output. There is no budget; effort is the only control and it breaks the cache when it changes. Sonnet 5.5 defaults to `high`. VectorScope sets no effort.
  - **Proposal:** under the VectorScope opt-in only, pin effort per pass, constant for the session. Put it in `EvidenceScope`, key `CALIBRATED_OUTPUT_PER_STEP` by model and effort, and record `thinking_tokens`.
- **T3-4 (high, new).** OpenAI gpt-5.6+ charge 1.25x for cache writes (2.5x at 12 hours), even with automatic caching. Caching can be turned off per request.
  - **Proposal:**
    - VS-40 uses the catalog's `cacheWrite` (present for gpt-6.1-sol);
    - one-shot gpt-5.6+ calls send `mode: "explicit"` with no breakpoints;
    - an owner option to send caching-off instead of refusing gpt-5.6+ routes without an `extendedCache` attestation, once OpenAI confirms that nothing is persisted. gpt-5.5 stays refused.
- **T3-5 (high, new).** OpenRouter's Batch API (2026-11-04) keeps data 30 days, cannot run under ZDR, and has a `callback_url`. VectorScope's batch refusal does not cover it.
  - **Proposal:** add `/api/v1/batches` (and OpenAI's `/v1/batches` and `/v1/files`) to the batch refusal and to VS-23c's path check, with tests. It applies under `zdr` only.
- **T3-6 (medium, partly new).** Long-context tiers (Haiku 5.5 above 100K, OpenAI above 272K) are ignored by VS-40.
  - **Proposal:** per-step tier pricing from `cost.tiers`, and keep Haiku triage steps under 100K.
- **T3-7 (medium, new).** The Sonnet 5.5 cache-read price in the repo catalog snapshot is wrong ($0.20 against $0.10).
  - **Proposal:** fix it upstream, outside the contract, and add an eval-side price assertion for the D6 candidates.
- **T3-8 (medium, new; contradicts VS-40 item 4).** Fan-out hold buys nothing while the prefixes diverge at the first token.
  - **Proposal:** drop it as a cost measure in the pilot, or add an eval-only shared-prefix variant for the funded ablation.
- **T3-9 (high, partly new).** The ZDR route table (§4) adds four facts: Anthropic's own reviewers exclude ZDR organisations; OpenRouter now has Batch and service tiers; and the sticky-routing window is now 60 minutes.
  - **Proposal:** extend the README's owner setup: workspace default service tier left unset or default; no Batch; and a pinned `service_tier: "default"` under the opt-in.
- **T3-10 (high, new for Anthropic's figures).** Vendor per-review prices (§5) run from $0.25 to $25. VectorScope's estimate is below Copilot Balanced and Bugbot at every size.
  - This is internal only (D12). Anthropic's own reviewer uses the same predictive skip that VS-40 builds, which supports that design.
  - **Proposal:** none beyond VS-40.
- **T3-11 (medium).** A 1-hour cross-review cache is not worth building at a 4K stable prefix.
- **T3-12 (medium, new).** Service tiers: an OpenRouter workspace default or a preset can silently move traffic to priority (2x). Flex's ZDR status is unverified.
- **T3-13 (low, new).** Threshold compaction is ZDR-eligible, starts at 50K, and bills an extra sampling step in `usage.iterations`.
  - Source: "`value` must be at least 50,000 tokens."; "Compaction requires an additional sampling step, which contributes to rate limits and billing."
  - **Proposal:** if compaction is ever enabled, settle cost from `usage.iterations`.
- **T3-14 (low, new).** OpenRouter's doc-level cache multipliers are stale; use per-endpoint prices only.
- **T3-15 (medium, new).** Eval price strings lack cache prices.
  - **Proposal:** extend them to `model=input:output[:cacheRead[:cacheWrite]]` (eval-only) and report cached and uncached projections side by side.

## 10. Open questions

- Is OpenAI's Flex, and caching-off on gpt-5.6+ (no cacheable prefix), inside OpenAI's ZDR? Is extended caching (KV on GPU-local storage for up to 24 hours) inside it? OpenAI's own page was unreachable.
- Does Azure, which serves GPT on OpenRouter's ZDR route, enable extended caching by default for gpt-5.5+? A search extract said so; the page was unread.
- Which open-weight endpoints (DeepSeek V4, GLM-5.x, Qwen3.8) appear in OpenRouter's `/endpoints/zdr` list, and at what price?
- Is Bedrock's ZDR mode valid with cache points, and what does Bedrock Flex cost?
- What is the actual output per step on Opus and Sonnet 5.5 at each effort for VectorScope's prompts? This needs the D7 pilot.
- Does the live catalog, not the repo snapshot, carry Sonnet 5.5's $0.10 cache read and Haiku 5.5 on direct Anthropic?
- Are Haiku 4.5's and Opus 4.5's retirement dates announced yet?

## Sources (dated)

- **Anthropic, vendor, all undated and accessed 2026-11-07:**
  - https://platform.claude.com/docs/en/about-claude/pricing
  - https://platform.claude.com/docs/en/about-claude/model-deprecations (the Sonnet 4.5 deprecation is dated 2026-09-30)
  - https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
  - https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
  - https://platform.claude.com/docs/en/build-with-claude/compaction-threshold
  - https://code.claude.com/docs/en/code-review
  - https://code.claude.com/docs/en/code-review-costs
  - https://code.claude.com/docs/en/ultrareview
- **OpenRouter docs mirror, vendor** (https://github.com/OpenRouterTeam/docs, HEAD cf50b6d, 2026-11-07):
  - `guides/features/batch-api.mdx` (added ae925ae, 2026-11-04)
  - `guides/features/service-tiers.mdx` (2026-11-04)
  - `guides/best-practices/prompt-caching.mdx` (1ba230a, 2026-11-06)
  - `cookbook/evaluate-and-optimize/model-migrations/claude-5-5.mdx` (2026-11-04)
  - `faq.mdx` and `snippets/exports/constants.mdx`
  - `guides/features/zdr.mdx`
- **OpenAI and secondary sources:**
  - npm `openai` 7.53.0 (2026-11-06), vendor SDK types;
  - https://github.com/openai/openai-cookbook/blob/main/examples/Prompt_Caching_201.ipynb (last change 2026-09-16), vendor;
  - https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json (fetched 2026-11-07, independent aggregator);
  - https://github.com/code-yeongyu/senpi/issues/3901 (2026-10-21, community);
  - https://github.com/mostlydev/cllama/pull/69 (2026-10-26, community).
- **GitHub, vendor:** github/docs `content/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review.md` (8cd1075, 2026-11-06) and `data/variables/copilot.yml` (c9d8b26, 2026-11-06).
- **AWS, vendor:** botocore 1.43.126 on PyPI (2026-11-06).
- **Cursor, vendor, cited from round one:** https://cursor.com/blog/may-2026-bugbot-changes (2026-05-11) and https://cursor.com/blog/bugbot-updates-june-2026 (2026-06-10).
- **Code in the worktree:**
  - `packages/core/src/review/{plan,dispatch,privacy,prompt}.ts`
  - `packages/engine/src/review/run.ts`
  - `packages/engine/src/agent/agent.ts`
  - `packages/engine/src/provider/{transform,provider}.ts`
  - `packages/web/public/models/api.json` (255cfd83, 2026-10-28)
  - `script/vectorscope-eval/ci.ts`
