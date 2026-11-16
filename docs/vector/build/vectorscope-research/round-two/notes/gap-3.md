# Round two, lane G3: tokenomics baseline, cache under ZDR, Greptile billing mechanics

Compiled 2026-11-06. Read-only on the VectorScope worktree. Evidence labels: **vendor** (the company's own claim or its own shipped code describing its own product), **independent** (a third party measured it), **academic**, **code** (read in source), **community**. "Inference" marks my own arithmetic or reasoning on top of labelled evidence.

## 0. What was reachable, and how

- **Blocked hosts:** `arxiv.org`, `huggingface.co`, `www.greptile.com`, `docs.greptile.com`, `developers.openai.com`, `claude.dev` (where the claude.com blog now redirects) and `web.archive.org` all failed to resolve or were refused. The `gh` API returned 403 for non-session repositories.
- **Search budget:** WebSearch was already used up for this turn (the shared limit of 200 calls), so I ran no searches. I could not locate ContextBench or re-check the source of Fletcher's $0.085–0.19 (GU9).
- **What worked:**
  - `git clone` over HTTPS for public GitHub repositories;
  - `npm pack` for published npm tarballs, downloaded without installing or running anything;
  - `code.claude.com` and `platform.claude.com` through WebFetch.
- **What that gave me, all read as code:**
  - Alibaba's benchmark table and harness: alibaba/open-code-review at `891df1b`, 2026-11-05; alibaba/aacr-bench at `ee9d7fe`, 2026-10-15;
  - the AACR-Bench dataset itself;
  - CRBugBench's 995 task diffs (malusamayo/CRBugBench at `e8e585e`, 2026-10-07);
  - per-instance dollar costs for 500 SWE-bench Verified tasks under five models (swe-bench/experiments at `40f164d`, 2026-09-03);
  - four published builds of Greptile's own CLI, 3.5.4, 3.6.0, 3.7.0 and 3.8.0, from the npm registry;
  - Greptile's self-host repository (greptileai/akupara at `09b7db2`, 2026-11-04);
  - the OpenAI cookbook's two prompt-caching notebooks (openai/openai-cookbook at `86c5050`, 2026-11-04);
  - the `openai` 7.52.0 SDK type definitions (2026-11-05).
- **The arXiv papers (2608.09290, 2601.19494, 2610.13668) stayed unreadable.** Every number below attributed to "OCR/AACR-Bench" comes from the vendor's own repository and website source, not the paper tables.

## 1. The first real per-PR token table for agentic reviewers (AACR-Bench, from source)

The `README.md` of alibaba/open-code-review (OCR) only says OCR uses "~1/9 of the tokens" of Claude Code on the same model. The numbers sit in an image, `imgs/benchmark-en.png`, and in `pages/src/components/BenchmarkSection.tsx` as a typed `rawRows` array. I read both, and they agree.

**The benchmark.** AACR-Bench has 200 PRs from 50 repositories in 10 languages, with 1,505 annotated issues. Recall denominators are /1505.
- **Evidence kind:** vendor. Alibaba runs its own tool on its own benchmark. The harness is open code.

| Rank | Tool (version) | Model | F1 | Precision (TP/posted) | Recall (TP/1505) | Avg time | Avg tokens per PR (input / output) |
|---|---|---|---|---|---|---|---|
| 1 | OCR v1.3.1 | Claude Opus 4.6 | 25.10% | 33.90% (301/889) | 20.00% | 1m23s | 385K (375K / 10K) |
| 2 | OCR v1.8.7 | Qwen3.8-Max | 23.00% | 33.90% (262/774) | 17.40% | 5m14s | 334K (303K / 32K) |
| 3 | OCR v1.3.1 | GLM-5.2 | 21.30% | 32.30% (239/741) | 15.90% | 7m58s | 682K (624K / 58K) |
| 4 | OCR v1.3.1 | Qwen3.7-Max | 21.20% | 25.20% (276/1096) | 18.30% | 4m41s | 625K (587K / 38K) |
| 5 | OCR v1.3.1 | GPT-5.5 | 21.00% | 32.10% (234/728) | 15.50% | 2m51s | 422K (409K / 13K) |
| 6 | OCR v1.3.1 | GLM-5.1 | 20.40% | 28.90% (237/820) | 15.70% | 4m11s | 743K (707K / 36K) |
| 7 | OCR v1.3.1 | Claude Opus 4.8 | 17.90% | 37.80% (176/465) | 11.70% | 1m6s | 352K (342K / 11K) |
| 8 | OCR v1.3.1 | DeepSeek-V4-Pro | 17.90% | 30.60% (191/624) | 12.70% | 6m28s | 394K (350K / 44K) |
| 9 | Claude Code v2.1.169 | Claude Opus 4.8 | 14.13% | 15.93% (191/1200) | 12.70% | 5m38s | 2,062K (2,039K / 23K) |
| 10 | Claude Code v2.1.169 | Qwen3.7-Max | 12.17% | 8.23% (351/4260) | 23.37% | 8m6s | 5,153K (5,108K / 44K) |
| 11 | Claude Code v2.1.169 | GLM-5.1 | 11.93% | 8.37% (313/3742) | 20.80% | 14m10s | 4,038K (3,998K / 39K) |
| 12 | Claude Code v2.1.169 | Claude Opus 4.6 | 11.57% | 7.23% (435/5980) | 28.90% | 13m6s | 5,664K (5,603K / 60K) |
| 13 | Claude Code v2.1.169 | DeepSeek-V4-Pro | 10.93% | 8.27% (243/2945) | 16.13% | 14m24s | 5,450K (5,389K / 60K) |
| 14 | OpenAI open-source coding-agent CLI v0.140.0 | GPT-5.5 | 8.36% | 27.82% (74/266) | 4.92% | 2m58s | 525K (520K / 5K) |

Sources: https://github.com/alibaba/open-code-review/blob/main/pages/src/components/BenchmarkSection.tsx and `imgs/benchmark-en.png` (repo HEAD 2026-11-05). **vendor**.

**How the tokens are counted** (code, alibaba/aacr-bench `evaluation/evaluate.py` lines 208–262 and `reviewers/claude.py` lines 246–277; OCR `internal/llm/client.go:1772`):
- **They are gross processed input tokens, cache reads included.**
  - Claude Code: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
  - The OpenAI CLI: `input_tokens`, which already include cached tokens under OpenAI's convention.
  - OCR's own Anthropic client: `PromptTokens = InputTokens + CacheReadInputTokens + CacheCreationInputTokens`.
- **So the bases are comparable,** and they are the same basis Greptile's "~3x more context" claim would use.
- **They are not dollars.** The harness stores Claude Code's `total_cost_usd` per instance (`claude_cost_usd`), but the summary does not publish it, and no per-PR logs are published.
- Reasoning tokens from the OpenAI CLI are explicitly not added to the total (`codex.py:398`).

**The harness is asymmetric** (code, `evaluation/reviewers/ocr.py`, `claude.py`):
- OCR runs `ocr review --from base --to head --max-tools 30 --concurrency N`.
- Claude Code runs with `--permission-mode acceptEdits`, an MCP findings tool and a 30-minute timeout. It has no turn cap.
- So part of the 5–15x token gap is the cap, not the architecture.
- Current OCR HEAD raises any `--max-tools` below 50 to 50 per subtask (`cmd/<OCR CLI>/shared_flags.go:141-147`). The v1.3.1 benchmark semantics may differ.

### 1.1 RR4 resolved: the "9–15x" ratio is a range across models, and "~1/9" is roughly its mean

Same-model ratio of Claude Code to OCR gross tokens per PR (inference, arithmetic on the vendor table):

| Model | Ratio |
|---|---|
| Opus 4.8 | 5.86x |
| GLM-5.1 | 5.43x |
| Qwen3.7-Max | 8.24x |
| DeepSeek-V4-Pro | 13.83x |
| Opus 4.6 | 14.71x |

- The mean is **9.6x** (hence the README's "~1/9"), and the range is **5.4–14.7x**.
- Against the OpenAI CLI on GPT-5.5 the ratio is only **1.24x** (525K / 422K).
- **Both round-one figures were right:** "9x" is the mean, "15x" is the Opus 4.6 row.
- For VectorScope the useful statement is: **a targeted, tool-capped reviewer uses about 5–15x fewer tokens than an uncapped general coding agent on the same model.** The size of the gap depends on the model's exploration habits.

### 1.2 PR sizes behind those averages (AACR-Bench dataset, code)

`dataset/positive_samples.json` (alibaba/aacr-bench, Apache-2.0 at the repository level) has 196 PRs with 1,506 reference comments, 7.7 per PR on average. I computed the distribution of `change_line_count`:

| Statistic | Changed lines |
|---|---|
| Minimum | 4 |
| p25 | 56 |
| Median | 152.5 |
| p75 | 324 |
| p90 | 689 |
| Maximum | 971 |
| Mean | 242 |

- **Languages:** C++ 33, Java 30, TypeScript 29, Go 22, Python 21, C 19, JavaScript 11, PHP 11, C# 10, Rust 10.
- **The benchmark caps PRs below about 1,000 changed lines.** A token curve fitted only on AACR-Bench will under-predict large PRs.
- **Licence (a §7 item):** the benchmark repository is Apache-2.0. The licences of the 50 underlying projects are still unchecked, and FreeCAD (LGPL) is among them.

**Gross tokens per changed line** (inference). At the mean of 242 lines, OCR on Opus 4.6 processes about 1,590 gross tokens per changed line. Claude Code on the same model processes about 23,000. The unified diff itself is a few thousand tokens. So **more than 98% of gross input is re-sent context and tool output, not the diff**.

### 1.3 Cost per true positive (GU9: "cost per verified finding")

Inference arithmetic. Inputs:
- the vendor token table, over 196 PRs;
- Opus 4.6 list prices from round one: $5 input, $6.25 for a 5-minute write, $0.50 for a read, $25 output per MTok;
- the assumption that all non-read input is written once at the 5-minute rate, which is how automatic or last-message breakpoints behave.

| Row | Cache-read share h | $ per PR | $ per true positive | Gross tokens per TP |
|---|---|---|---|---|
| OCR, Opus 4.6 | 0 / 0.80 / 0.90 / 0.95 | 2.12 / 0.87 / 0.65 / 0.55 | 1.38 / 0.57 / 0.43 / 0.36 | 251K |
| OCR, Opus 4.8 | same | 1.99 / 0.84 / 0.64 / 0.54 | 2.21 / 0.93 / 0.72 / 0.61 | 393K |
| Claude Code, Opus 4.8 | same | 10.77 / 3.94 / 2.77 / 2.18 | 11.05 / 4.04 / 2.84 / 2.24 | 2.12M |
| Claude Code, Opus 4.6 | same | 29.52 / 10.74 / 7.52 / 5.91 | 13.30 / 4.84 / 3.39 / 2.66 | 2.55M |

- On Opus 5.5 prices ($4 / $5 / $0.20 / $20), an OCR-shaped review of 375K input and 10K output costs **$1.70 uncached, $0.64 at h = 0.8 and $0.46 at h = 0.9**.
- **Output is a minority but not negligible:** about 38% of the OCR Opus 4.6 dollar figure at h = 0.9.
- **What this means for GU9.** Fletcher's self-reported $0.085–0.19 per PR is about 3–7x below a capped Opus-class agentic reviewer on AACR-sized PRs at a 90% cache rate. It is consistent only with smaller PRs, a Sonnet- or Haiku-class model, or far fewer steps (inference).
- **Where "cost per verified finding" should be anchored:** about **$0.4–0.9 per matched finding** for a targeted Opus reviewer, against **$2–5** for a general coding agent. These are AACR "matched" findings, a weaker notion than VectorScope's "verified" (inference).

## 2. How tokens scale: what external data supports

### 2.1 Steps drive cost, superlinearly; repository size barely does (SWE-bench Verified, independent)

`swe-bench/experiments` publishes `per_instance_details.json` (cost, API calls, resolved) for each submission. I read five runs of an open-source minimal coding-agent harness (v2.0.0, bash-only, 500 tasks each, 2026-02-17). That harness enables Anthropic `cache_control` markers by default for Anthropic models (harness source, `models/__init__.py` lines 57–60, commit `04d809c`, 2026-09-03), so the Anthropic costs already include caching. These tasks fix code rather than review it, but the loop economics are the same.

| Model | p50 $ | p90 $ | p99 $ | p90/p50 | Top-10% share of spend | Calls p50 / p90 | Exponent b in cost ∝ calls^b | Unresolved p50 / resolved p50 |
|---|---|---|---|---|---|---|---|---|
| Claude Haiku 4.5 (high) | 0.281 | 0.554 | 1.355 | 2.0 | 25% | 63 / 102 | 1.34 | 1.55x |
| Claude Sonnet 4.5 (high) | 0.567 | 1.092 | 1.994 | 1.9 | 22% | 45 / 72 | 1.23 | 1.40x |
| Claude Opus 4.5 (high) | 0.570 | 1.434 | 3.013 | 2.5 | 28% | 29 / 56 | 1.35 | 1.86x |
| Claude Opus 4.6 | 0.309 | 1.368 | 3.018 | 4.4 | 39% | 23 / 56 | 1.21 | 1.69x |
| GPT-5.2 (high) | 0.356 | 0.965 | 2.215 | 2.7 | 29% | 31 / 57 | 1.35 | 1.72x |

Sources:
- https://github.com/swe-bench/experiments/tree/main/evaluation/verified/20260217_mini-v2.0.0_claude-4-6-opus (`metadata.yaml`: total cost $275.76, instance_cost $0.5515, instance_calls 28.9, resolved 75.6%), and the four sibling runs dated 20260217. **independent** (submitted runs, costs computed by the harness from provider usage).
- The 2026-09-01 Gemini 3.5 Flash run has no cost field.

**Findings** (inference on that data):
- **Cost per call rises with run length.** Median cost per call is about 1.6–1.8x higher for runs of 50 or more calls than for runs of 20 or fewer (Opus 4.6: $0.0141 to $0.0248). That is the quadratic context-growth term showing through caching.
- **Repository identity is a weak predictor.** Django, the largest repository, sits at or below the median in every model (Opus 4.6: $0.265 against a $0.309 median). The smallest repository, seaborn (`mwaskom`), is the most expensive in four of five models (Opus 4.6: $1.34). **Task difficulty and step count dominate repository size.**
- **Failed runs cost more.** Unresolved tasks cost 1.4–1.9x resolved ones at the median: agents flail longer when they are failing.
- **The tail is heavy.** The top decile of tasks takes 22–39% of all spend. A cap at about 2–3x the median hits roughly 10% of runs.

### 2.2 VectorScope's own model already has the right shape; its constants need replay calibration

`packages/core/src/review/plan.ts` (code, read-only):
- **The model:** input = S·P + R·S(S−1)/2.
- **The fit:** S = 5 steps and R = 2,000, fitted on one measured review of a 5-file change. The review and security passes took 5 and 4 steps and 79.3K input tokens, so P is about 5.3K.
- **Output:** the measured run averaged 1,800 output tokens a step against the coded `OUTPUT_PER_STEP` of 600.
- **The SWE-bench exponent of 1.2–1.35** is consistent with this form at realistic P/R ratios (inference).

**Gaps** (inference):
- **The low estimate's cache handling is optimistic in one place and pessimistic in another.**
  - It prices (S−1)·P as cache reads, but prices the first P and every growth delta at plain input. On Anthropic they are written at 1.25x (5-minute TTL) or 2x (1-hour TTL).
  - It treats the growth term as never cached, although every step's delta becomes the next step's cached prefix.
- **The measured review used about 4.7x fewer gross tokens than OCR's AACR mean on Opus 4.6** (79.3K against 375K). One PR is not a baseline.
- **The measured review's dollar cost** (inference, 79.3K in and about 16.2K out): $0.64 uncached and $0.45 at h = 0.7 on Opus 5.5; $0.32 and $0.23 on Sonnet 5.5.

### 2.3 OCR's pre-dispatch estimator: a concrete design reference for VS-24

`internal/agent/estimate.go` and `agent.go:388-410` (code):
- **The per-file estimate:**
  - PLAN phase: diff tokens + 2,000 overhead in, 400 out;
  - MAIN phase: (diff tokens + 2,000) × 7 rounds in, 700 × 7 out.
  - Comments: "Observed ~6 [rounds] on real repos; round up", and the estimate is "a floor" because "agent tool-use inflates this".
- **It warns and never blocks:** it prints only when a `MAX_TOKENS_BUDGET` is set, and "money is intentionally omitted".
- **The hard stop is dispatch-time:** per-group subtasks stop once the running total plus a per-group look-ahead would exceed the budget.
- **Cache affinity is per conversation** (`internal/llm/sessionkey.go`): the key is (session, task type, hashed file or batch). A run-wide key would pin unrelated per-file conversations to one node, and OpenAI reroutes a `prompt_cache_key` above about 15 requests per minute.
- **Anthropic breakpoints:** on the last system block, the last tool and the last message, at the default 5-minute TTL (`client.go:1642-1668`).
- **Usage fields** (`internal/llm/usage_resolver.go`): Anthropic `cache_read_input_tokens` and `cache_creation_input_tokens`; OpenAI `prompt_tokens_details.cached_tokens` and `input_tokens_details.cached_tokens`. It notes that OpenAI's prompt tokens already include cached tokens.

**Calibration** (inference): on AACR-sized PRs, OCR's floor formula gives about 21K tokens per file plus 8 × diff tokens. At about 5–10 files and about 8K diff tokens with context, that is roughly 170–275K, against 375K measured: **measured / floor ≈ 1.4–2.3x**.

### 2.4 A defensible curve VS-24 can adopt now (inference, built from the above)

- **Model each pass as S steps** with prefix P = static prefix + diff slice + cards. The default R is 2,000, to be replaced by the replay median.
- **Predict S from changed files and changed lines,** not from repository size. Use the replay median and p90, and carry the SWE-bench finding that p90/p50 runs 2–4.4x and failed runs cost 1.4–1.9x.
- **Anchor points:**
  - a 5-file change gives about 80K gross tokens (VectorScope, measured);
  - AACR-sized PRs (median 152 lines, p90 689) give about 330–740K for capped reviewers and 2–5.7M for uncapped general agents.
- **Gate on first-turn tokens and on the median.** Report p90 in the note.
- **The decisive lever is the step cap**, not repository size or caching: a tool or step cap separates the 5–15x token regimes.

## 3. Cache hit rates under ZDR-compatible caching

### 3.1 The agentic hit rate is mechanical and can be computed before dispatch (inference on the vendor mechanism)

Anthropic's docs: total input = cache_read + cache_creation + input, and caching matches the exact prefix (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-11-06, vendor). With a breakpoint on the last message, step k reads step k−1's whole prompt and writes only the delta. So, for one pass with first prompt P, growth R per step and S steps, all within the TTL and above the model's minimum cacheable length:

```
h(S) = 1 − (P + (S−1)·R) / (S·P + R·S(S−1)/2)
```

With VectorScope's fitted P = 5.3K and R = 2K:

| S | h |
|---|---|
| 5 | 0.71 |
| 10 | 0.84 |
| 20 | 0.91 |
| 30 | 0.94 |

- **Greptile's reported ~90% cache hits** (Anthropic case study, vendor, round one) are what a loop of about 20 steps produces automatically. No special trick is needed, and none is implied.
- **Effective input-price multiplier on Anthropic** with 5-minute writes: m = h·r + (1−h)·1.25.
  - At h = 0.71 and r = 0.1, m = 0.43.
  - At h = 0.9, m = 0.215 at r = 0.1, and 0.17 at r = 0.05 (Opus and Sonnet 5.5).
  - **With 1-hour writes:** m = h·r + (1−h)·2, which is 0.29 at h = 0.9. **Inside a single review the 1-hour TTL costs more.** It pays only when a later review reuses a stable layer at least twice (round one's n ≥ 2 rule).
- **Parallel fan-out:** each specialist that starts cold pays its own P as a write. Claude Code's workflow fan-out now **holds all but the first same-prefix agent "for up to 5 seconds by default"** so the rest read the first one's prefix (https://code.claude.com/docs/en/prompt-caching, read 2026-11-06, vendor). That is a concrete version of round one's "wait for the first streamed response".

### 3.2 Anthropic: what ZDR keeps (vendor)

- **Eligibility:** "Prompt caching is ZDR-eligible, excluding Covered Models. Prompts and Claude's outputs are not stored. KV cache representations and cryptographic hashes are held in memory for the cache TTL and promptly deleted after expiry." The statement does not name 5-minute or 1-hour; it says "the cache TTL", so it covers whichever TTL is used.
- **Reporting fields:** `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens` (after the last breakpoint), and `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`.
- **Automatic caching:** a top-level `cache_control` moves the breakpoint forward as the conversation grows. It fails with a 400 only on legacy Bedrock for Opus 4.6 and earlier.
- Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (read 2026-11-06).

**Consequence** (inference): **under Anthropic ZDR, within-review caching, which is where agentic hit rates come from, is fully available.** ZDR's real cost penalty against Greptile is:
- the loss of Batch (50% off, not ZDR-eligible, round one);
- Covered Models being unavailable;
- not the cache.

### 3.3 OpenAI: the round-one premise "in_memory only under ZDR" is outdated for new models (vendor)

**From the `openai` 7.52.0 SDK** (`resources/responses/responses.d.ts`, 2026-11-05, code describing the vendor API):
- `prompt_cache_retention` is deprecated in favour of `prompt_cache_options.ttl`.
- "For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported. For older models that support both `in_memory` and `24h` ... Organizations without ZDR enabled default to `24h`. Organizations with ZDR enabled default to `in_memory`."
- `prompt_cache_options` (gpt-5.6+): mode `implicit | explicit`, ttl `30m | 12h`, optional `comparison_response_id` for cache diagnostics.
- Usage now reports `input_tokens_details.cache_write_tokens` with `ttl_30m_tokens` and `ttl_12h_tokens`, as well as `cached_tokens`.

**From the OpenAI cookbook "Prompt Caching 201"** (examples/Prompt_Caching_201.ipynb, repo HEAD 2026-11-04, vendor):
- Extended caching "offload[s] the key/value tensors to GPU-local storage when memory is full ... Only the key/value tensors may be persisted in local storage; all original input content is only retained in memory."
- **Routing:** "~15 requests per minute per prefix + `prompt_cache_key` combination"; routing hashes about the first 256 tokens.
- **Hit-rate evidence:**
  - "one of our coding customers saw an improved hit rate from 60% to 87% when they started using `prompt_cache_key`";
  - Responses gives "40-80% better cache utilization" than Chat Completions for reasoning models;
  - in 10,000 identical requests, Flex with extended caching had an "8.5% increase in cache hit rate compared to the Batch job", for "a 23% reduction in input token cost".
- Cache discount for gpt-5.2 is 90%.

**Prompt Caching 101** (same repo, vendor): caching "is eligible for zero data retention, as no data is stored during the process."

**Consequence** (inference):
- On gpt-5.5 and newer, a ZDR organization has **no in_memory option**. Either 24h or 12h retention of KV tensors is acceptable under its ZDR terms, or those models cannot be cached.
- The SDK text implies ZDR organizations can still use these models, but OpenAI's ZDR page itself was unreachable (`developers.openai.com`).
- **This is now the open question VOI7/VOI8 should ask:** "Is KV-tensor persistence to GPU-local storage for up to 24h compatible with VectorScope's ZDR definition (D15/Q1)?" It replaces "in_memory only".

### 3.4 Published hit rates for agentic coding (all vendor, mostly illustrative)

- **Claude Code `/usage`:**
  - the docs' example session shows "1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write", which is 95% of input read from cache;
  - the "Prompt cache (main)" example line reads "14 requests · 91% of input tokens from cache".
  - These are examples, not fleet statistics.
  - Defaults: the TTL is 5 minutes on an API key, usage credits or a cloud provider, and 1 hour on a subscription within plan usage. Subagents always get 5 minutes unless set. `FORCE_PROMPT_CACHING_5M` and `ENABLE_PROMPT_CACHING_1H` exist. Agent teams use "approximately 7x more tokens".
  - Enterprise averages are "around $13 per developer per active day and $150-250 per developer per month ... below $30 per active day for 90% of users".
  - Sources: https://code.claude.com/docs/en/costs and https://code.claude.com/docs/en/prompt-caching (read 2026-11-06).
- **Greptile:** ~90% (Anthropic case study, round one). Its v3 post credits "extremely high cache hit rates" for a 75% lower self-host inference cost at ~3x the context.
- **OpenAI coding customer:** 60% to 87% with `prompt_cache_key` (cookbook, above).
- **Not found:** any independent, measured hit rate for a code reviewer. The AACR harness stores the cache fields per instance but publishes only totals.

## 4. Greptile billing mechanics (GU16)

### 4.1 What Greptile's own CLI code reveals (code; Greptile's shipped client, describing its own service)

I diffed the error-code tables in four published builds of `dist/greptile.js` (npm `greptile`; release dates from the registry: 3.5.4 2026-09-22, 3.6.0 2026-09-25, 3.7.0 2026-10-18, 3.8.0 2026-10-26).

**New in 3.7.0** (released 2026-10-18; its CHANGELOG entry is dated 2026-10-17):
- `403 credits_exhausted`: "your organization has insufficient credits for this review. Add credits at <upgradeUrl>."
- `403 billing_restricted`: "Reviews are paused because billing access is restricted. Contact support to restore access."
- `403 migration_required` and `subscription_unpaid`: "Reviews are paused. Open billing settings to continue."

**Still present in 3.8.0:**
- `403 flex_usage_limit_exceeded`: "this CLI review would exceed your organization's monthly flex usage limit. Raise the limit at <upgradeUrl>."
- `429 rate_limited`: "daily review limit reached for your organization."
- Also `trial_limit_reached`, `trial_not_eligible`, `billing_not_configured` ("billing plan does not include per-use CLI reviews") and `headless_reviews_not_available_on_free_plan`.

**What this establishes:**
1. **The credit cut-over landed in the client between 3.6.2 (2026-10-09) and 3.7.0 (2026-10-17).** `migration_required` implies existing seat-plan organizations had to act. This corroborates the trackers' 2026-10-14 to 10-23 date.
2. **Exhaustion is an admission check against the price of this review.** The wording is "insufficient credits *for this review*". A 10-credit Apex request can be refused while a 1-credit Base request would still run. Exhaustion pauses the review; it does not cut it off mid-run. This is consistent with "only completed reviews are charged" (round one, vendor billing doc).
3. **A monthly dollar cap on "flex" usage still exists alongside credits,** and the check is predictive: "*would* exceed". It survived the seat-to-credit move in the client code. Whether "flex" now means auto-recharge spend is not stated.
4. **There is also an organization-wide daily review count limit** (HTTP 429).
5. **The client never shows a balance or a pre-dispatch estimate.** The only "credits" strings are in errors. The flat per-tier price *is* the estimate.
6. **Effort selection fails closed:**
   - README 3.8.0: "`--plus` and `--apex` ... require the organization's effort feature and an effort-specific routing rule. If either is unavailable, the review fails without running a fallback." Results include the effective effort.
   - 3.6.0 added exit code 6 for "feature not enabled".
   - 3.5.4 removed the 500-file refusal; the remaining preflight limits are 50 `.greptile` files and payload size.
7. **The settings schema has no cost keys.** `settings-schema.json` (3.8.0) holds only `color`, `telemetry`, `apiBaseUrl`, `webBaseUrl` and `review.{output, layout, context, width}`. It says organization settings live on the server. There are no flex, cap or credit flags in the CLI.
8. **Still unknown:** whether credits roll over or expire, the auto-recharge thresholds, and whether the monthly flex limit applies to PR-bot reviews or only to CLI reviews (the message says "this CLI review"). Pricing and docs pages were unreachable.

Sources: npm `greptile@3.5.4`, `@3.6.0`, `@3.7.0`, `@3.8.0` tarballs (https://www.npmjs.com/package/greptile, versions dated as above); `package/CHANGELOG.md` and `README.md` in 3.8.0. The CLI's GitHub repository (https://github.com/greptileai/cli) holds only README.md and install.sh.

### 4.2 Self-host cost controls (code, greptileai/akupara at `09b7db2`, 2026-11-04)

- `docs/configuration/review-variants.md`: `FEATURE_FLAGS_JSON='{"effort-levels":true}'` enables Base, Plus and Apex. Setting it to false makes "every review then run at Base, which limits inference cost".
  - Routing policies: Anthropic `native-rsv11-stndrd4-expansion@3` (Sonnet 4.6); OpenAI `greptile-v5.3@6` (needs gpt-6.1-sol, gpt-6-sol, gpt-6-luna and a low-effort gpt-5.6-luna alias) or `v5.2-tiers@2`.
  - `post-review-gate` is optional and "fails open".
- The LiteLLM config sets **no budget, spend tracking or cache-control settings**. The only cost-relevant blocks are `batch_settings` and the per-task alias table (round one).
- **Capacity guidance:** "at least 100 requests per minute and 800,000 tokens per minute". "Each worker pod handles up to two concurrent reviews by default".
- **Inference:** a self-hoster's only cost knobs are the effort flag, model routing and provider-side limits. Greptile absorbs token variance in its cloud product through flat per-tier pricing, and leaves self-hosters to pay raw tokens with no in-product cap.

**Implication for VectorScope** (inference): Greptile prices per review and absorbs a token distribution whose top decile can carry 22–39% of spend (§2.1). VectorScope passes tokens through to the user, so it has to carry Greptile's *admission* semantics:
- refuse before dispatch when the predicted cost of this review exceeds what remains;
- fail closed when a deeper tier is unavailable;
- charge or count only completed reviews.

It also needs a running cap during the review, which Greptile's cloud does not need.

## 5. The lens multiplier (RP5)

The Kodus `evals/heavy-recall/README.md` (kodustech/kodus-ai at `2ee5d32`, 2026-11-05; vendor eval with open code) confirms round one's figure and adds two facts:
- A heavy review is "the generalist and the nine lenses" in parallel, with the same verify on every finding.
- It costs "1.3 to 2.1 times the tokens of a normal review on the 2026-11-02 runs", on the controlled set (15 PRs, three per repository).

Inference:
- Nine extra lenses add only 0.3–1.1x. Each lens's marginal cost is about **3–12% of a normal review**. Lenses are far cheaper than the generalist, presumably because they explore less and share verify.
- **So the multiplier does not scale linearly with lens count.** A VectorScope high band with 3–4 lenses should be projected at roughly 1.1–1.5x, to be calibrated, not 1.3–2.1x.
- **What it still is:** one vendor, one 15-PR set and one week's runs. The funnel snapshots (`evals/funnel/snapshot/*.json`) have no token fields, so I could not re-derive the figure.

## 6. CRBugBench: diff sizes for projecting the pilot (code)

malusamayo/CRBugBench at `e8e585e` (2026-10-07) has 995 container-format tasks from 98 repositories. It is a reconstruction of the paper's benchmark. **It contains no cost or token data**, and the paper (arXiv 2610.13668) was unreachable, so the "cost of exploration nudges" could not be read.

Every task runs a three-model judge panel: gpt-5.5, claude-opus-4.8 and gemini-3.5-flash, through a Copilot CLI by default. That is an eval-cost line item. Agent and verifier timeouts are 1,800 s, with 2 CPUs and 4 GB per container.

Diff sizes I computed from `environment/pr_to_review.diff`:

| Track | n | Changed lines p50 / p90 / max | Files p50 / p90 | Bytes p50 / p90 / max |
|---|---|---|---|---|
| fix (the PR that introduced a bug) | 500 | 280 / 1,894 / 6,017 | 7 / 35 | 20.8K / 114.9K / 249K |
| comment (a snapshot a reviewer saw) | 495 | 97 / 869 / 4,733 | 4 / 19 | 7.9K / 55.9K / 213K |

- **The fix track is about 3x larger than AACR-Bench at the median and well beyond its 971-line cap at p90.**
- **Token estimate** (inference, at about 3.5 characters per token): a fix-track diff is about 6K tokens at p50 and 33K at p90. Even the p90 diff is a small share of the 300K+ gross tokens an agentic reviewer spends, which confirms §1.2.

## 7. What this changes in the build contract (inference)

- **VS-24 estimate.**
  - Keep S·P + R·S(S−1)/2.
  - Add the write premium: the first P and each delta at 1.25x, or 2x for a 1-hour TTL.
  - Raise `OUTPUT_PER_STEP` towards the measured 1,800 once a priced run confirms it.
  - Predict S from files and lines, not from repository size.
  - Report the computed h(S) next to the estimate.
  - Use OCR's per-group look-ahead as the in-run stop.
- **GU9 metric.**
  - Report gross tokens, cache read and write, and dollars per *verified* finding.
  - External anchor: about $0.4–0.9 per matched finding for a capped Opus-class reviewer, and $2–5 for an uncapped general agent (AACR, inference).
- **RP5 high band.** Project lenses at 1 + k × (0.03–0.12) per lens until replay data exists, not a flat 1.3–2.1x.
- **ZDR economics.**
  - **Anthropic:** within-review caching is unaffected. Plan on h ≈ 0.7 at 5 steps and about 0.9 at 20, and m ≈ 0.2–0.43 of list input price. Treat the loss of Batch as the real ZDR penalty.
  - **OpenAI gpt-5.5+:** re-ask the owner whether 24h or 12h KV retention is acceptable under D15 before routing there under ZDR.
- **Fan-out:** hold specialists until the first has started streaming. Claude Code's 5 s default is a usable reference.
- **Caps:** with a p90/p50 of 2–4.4x, a review cap at about 3x the calibrated median stops roughly 5–10% of reviews. That count should be measured on replay before the default $2 is kept.
