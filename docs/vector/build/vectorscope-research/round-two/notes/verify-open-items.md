# Round two: checking round one's open items (REPORT.md §7) against primary sources

Lane: verifying open items. Date: 2026-11-06. Read-only against `/home/user/wt/vectorscope`. All downloads went into my scratchpad.

## 0. How this was researched, and what limited it

- **Web search was not available at all.** The shared WebSearch budget (200 calls per turn, across all agents) was used up before my first query. I ran no searches. Everything below comes from fetching primary artifacts directly.
- **What the network reached:**
  - the npm registry, used for package tarballs;
  - `raw.githubusercontent.com` and `git clone`/`git fetch` of public GitHub repositories (the REST API is limited to this session's repositories, and github.com web pages return 403);
  - `platform.claude.com`;
  - `cloud.google.com`, but only pages that do not redirect to `docs.cloud.google.com`.
- **What did not resolve or was refused:** openrouter.ai, developers.openai.com, platform.openai.com, openai.com, ai.google.dev, docs.cloud.google.com, policies.google.com, greptile.com and its docs, app and api subdomains, arxiv.org and export.arxiv.org, zenodo.org, Semantic Scholar, OpenAlex, Crossref, DBLP, alphaXiv, Europe PMC, scholar.archive.org, web.archive.org, unpkg.com, cdn.jsdelivr.net, x.com, Hacker News, YouTube, Medium, LinkedIn, graphite.com and withmartian.com. The full list is in `unreachable`.
- **Substitutes for blocked doc sites:**
  - **SDK type text.** Vendors generate it from their own API specs, so it counts as vendor text. I read:
    - `@openrouter/sdk` 1.5.60 (published 2026-11-06T01:02Z);
    - `@openrouter/ai-sdk-provider` 2.9.0;
    - `openai` 7.52.0 (published 2026-11-05);
    - the official `greptile` CLI 3.8.0 (2026-10-26).
  - **Licence files**, read at the exact commits a benchmark uses.
  - **Benchmark data**, read directly.
- **Evidence labels:** **vendor** (the company's own text, including generated SDK docs), **independent** (a third party measured it), **academic**, **code** (read in source or data), **community**. "My analysis" means I computed it from the named data. "Inference" is marked as inference.

---

## 1. Does `@openrouter/ai-sdk-provider` 2.9.0 type a `zdr` field? Yes. Verified in code.

**Source:** https://registry.npmjs.org/@openrouter/ai-sdk-provider/-/ai-sdk-provider-2.9.0.tgz
- Published 2026-04-28T20:42Z; Apache-2.0; read 2026-11-06.
- The integrity hash `sha512-Seva+NCa0WUQ…8pJdcQ==` matches the entry in `bun.lock`, so this is the exact artifact the repo pins in `packages/core/package.json:103` and `packages/engine/package.json:93`.

**What is in it** (`dist/index.d.ts`) **[code]:**
- **The chat settings type.** `OpenRouterChatSettings.provider` (lines 209-257) has `order`, `allow_fallbacks`, `require_parameters`, `data_collection` (`'deny' | 'allow' | (string & {})`), `only`, `ignore`, `quantizations`, `sort` and `max_price`. It also has:

```ts
/** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints.
 *  When true, only endpoints that do not retain prompts will be used. */
zdr?: boolean;
```

- **Version history.** `zdr` is typed from 1.5.0 at the latest, is present in 2.0.0 and 2.8.1, and is absent in 1.2.0 (I checked each version's tarball).
- **Embedding and image settings** type `data_collection` but **not** `zdr`. Not relevant to review, which only uses chat.
- **What 2.9.0 does not type** (compared with `@openrouter/sdk` 1.5.60): `provider.options`, `enforce_distillable_text`, `preferred_max_latency` and `preferred_min_throughput`.

**Something round one did not record: how the provider builds the body** (`dist/index.js`) **[code]:**
- `getArgs` (lines 3539-3598) puts `provider: this.settings.provider` into the body, and also `models: this.settings.models` (fallback models), `plugins`, `web_search_options`, `debug` and the top-level `cache_control`.
- It then spreads `this.config.extraBody` and `this.settings.extraBody` over the whole object.
- `doGenerate`/`doStream` then spread the call-level `providerOptions.openrouter` over it.
- **All of these merges are shallow.** An `extraBody.provider` or a call-level `providerOptions.openrouter.provider` therefore **replaces** the configured `provider` object instead of merging into it.

**What it changes:**
- **VS-23:** no dependency bump is needed for typing.
- **VS-23c:** it confirms that the ZDR guarantee belongs at the transport layer, on the final body (`zdrRequestBody` after `promptCacheBreakpointBody`), not in model settings. A `provider: { zdr: true }` set in settings is silently lost if anything later supplies its own `provider`.
- **Add a test to `zdr-route.test.ts`:** a body whose `provider` was replaced through `extraBody` or `providerOptions.openrouter` still leaves with `zdr: true` and `data_collection: "deny"`.
- **`models` is emitted by the provider itself.** It is already in `OPENROUTER_MODEL_ROUTING_FIELDS` (`free-model-catalog.ts:201`), so `fallback-models` catches it. A test should prove that a settings-level `models` is refused.

---

## 2. OpenRouter: ZDR, `data_collection`, the "no endpoint" error, and new fields

The prose page (openrouter.ai/docs/features/zdr) and the live `/api/v1/endpoints/zdr` remain **unreachable** (DNS refused). I re-read the vendor's generated SDK at its newest release, `@openrouter/sdk` 1.5.60 (2026-11-06, `esm/models/*.d.ts`). **[vendor]**

### Confirmed unchanged since round one
- **`provider.zdr`:** "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. When true, only endpoints that do not retain prompts will be used."
- **`provider.data_collection`:** "If no available model provider meets the requirement, your request will return an error. allow: (default) allow providers which store user data non-transiently and may train on it; deny: use only providers which do not collect user data."
- **`PublicZdrEndpoint`:** "An endpoint whose data policy does not retain prompts by default." Its `safetyRetention` flag means: "prompts are not retained by default, but the provider may retain prompts its safety classifiers flag. A ZDR-enforced request reaches these endpoints only when the account allows Safety Retention and no applied guardrail disallows it."
- **Guardrail fields:** `enforceZdrAnthropic | Openai | Google | Xai | Other`. The legacy `enforceZdr` is "Deprecated… its value is copied into any of those per-provider fields that are not explicitly specified".
- **BYOK `declared_zdr`:** still "Self-declared and not verified by OpenRouter."

### The documented error when no ZDR endpoint exists: still not verified
- The SDK's `NotFoundResponseError` says only "Not Found – Resource does not exist". No ZDR- or data-policy-specific error code exists anywhere in the 1.5.60 models; I grepped every `errors/*` file.
- The string "No endpoints found matching your data policy" appears only in this repo's own code and test fixture (`packages/core/src/free-models.ts:429`; `packages/core/test/free-models.test.ts:468,480`). That is **self-authored [code]**, not vendor evidence.
- **Answer:** the vendor says only "your request will return an error". Whether `zdr: true` fails with that exact 404 body is still **unverified**.

### New since round one [vendor]
1. **`provider.options`:** "Provider-specific options keyed by provider slug… Only options for the matched provider are forwarded… Unrecognized keys are silently dropped."
   - This is a **passthrough to the upstream provider**, sitting inside `provider`.
   - `zdrRequestBody` as specified "keeps every other provider preference as it is", so it would forward whatever is in it.
2. **`only` and `ignore`** "are merged with your account-wide … settings for this request." Per-request lists cannot widen what the account allows; they can only add to it.
3. **Data regions.** A guardrail field `allowedDataRegions`: "`global` is https://openrouter.ai, `europe` is https://eu.openrouter.ai, and `us` is https://us.openrouter.ai. Requests arriving through any other region are rejected… the effective regions are the intersection of every non-null value."
4. **Safety-retention allowances exist only for Google and "Other".** The fields are `allowSafetyRetentionGoogle` and `allowSafetyRetentionOther`, the latter "for example open-weight models on Vertex … A guardrail can only be more restrictive than the account setting."
   - There is no Anthropic, OpenAI or xAI counterpart.
   - **[inference]:** OpenRouter's safety-retention endpoints are Google-served or "other" endpoints.
   - **Tension:** Anthropic's own terms (§3) still let Anthropic keep flagged content for up to 2 years under ZDR. OpenRouter's flag describes OpenRouter's endpoint classification, not the upstream provider's legal carve-outs.
5. **Batch.** `BatchProviderPreferences`: "Only `provider.only` and `provider.allow_fallbacks` are supported." **[inference]:** an OpenRouter batch cannot carry `zdr` or `data_collection`.

### What it changes in VS-23
- **VS-23a `decideRoute`:**
  - Treat `eu.openrouter.ai` and `us.openrouter.ai` as OpenRouter. Today they would fall to `unknown-destination`, which fails closed but would refuse a legitimate regional base URL.
  - Optionally let the owner attest a region.
- **VS-23a `zdrRequestBody`:** refuse, rather than forward, any body with a non-empty `provider.options` while `zdr` is active (new refusal, e.g. `provider-options`). It is an unaudited passthrough that could, for example, ask an upstream to store or cache. Keep `only`/`ignore` as they are.
- **Owner setup for the eval key (Q7):** set `allow_safety_retention_google: false` and `allow_safety_retention_other: false` explicitly, alongside the per-provider `enforce_zdr_*` fields. Do not rely on the deprecated `enforce_zdr`.
- **VS-23 batch:** the existing `batch` refusal is now backed by vendor text.
- **Error handling (VS-23b/c):** do not match on the 404 message text. Treat any 404 on a request that carried `provider.zdr: true` as a policy refusal (`notePrivacyRefused`) that is never retried on another model. Keep the `/endpoints/zdr` pre-check as the follow-up.

---

## 3. Anthropic's current ZDR terms (verified, vendor)

**Sources:**
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (accessed 2026-11-06)
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching (accessed 2026-11-06)

Both are **[vendor]**.

**Confirmed:**
- **Scope:** "Under a ZDR arrangement, Anthropic does not store customer prompts or responses at rest after the API response is returned."
- **Covered Models:** Fable 5.1, Mythos 5.1, Fable 5 and Mythos 5 "require 30-day data retention; ZDR is therefore not available for any of them unless expressly authorized by Anthropic". Calling Fable 5 without that retention returns `400 invalid_request_error`.
- **Flagged content:** "Even with ZDR … Anthropic may retain data where required by law or where it has been flagged by Anthropic's automated trust and safety systems… up to 2 years."
- **Nothing is blocked:** "Nothing blocks the request" for features marked "No". Using one "is a choice to step outside your ZDR arrangement".

**New or sharpened since round one:**
- **Extended (1-hour) caching is ZDR-eligible.** "Prompt caching (both automatic and explicit) is ZDR eligible… KV cache representations and cryptographic hashes… are held in memory only and are not stored at rest. Cached entries have a minimum lifetime of 5 minutes (standard) or 1 hour (extended), after which they are promptly, though not immediately, deleted." The eligibility row adds "Excludes Covered Models".
- **Features marked not ZDR-eligible:**
  - Batch: "29-day retention";
  - Files API;
  - code execution and programmatic tool calling: "data retained up to 30 days";
  - the MCP connector (`mcp_servers`) and Agent Skills: retained "according to standard policy";
  - "Dynamic filtering for web fetch" and "for web search".
- **Eligible:** threshold compaction and context editing (stateless round-trip), tool search, memory tool, fast mode, effort, thinking and token counting. Cache diagnostics and structured outputs are "Yes (qualified)", because a JSON schema is cached for up to 24 hours.
- **Platforms.** On "Claude Models on Google Cloud (Google managed) and Amazon Bedrock, the cloud provider is the data processor". Anthropic-managed Google Cloud and Claude Platform on AWS follow first-party terms.
- **Claude Code** with commercial API keys is covered, but "if metrics logging is enabled … productivity data … is exempted".
- **Naming.** The page calls Vertex AI "Google Cloud's Agent Platform".

**What it changes:**
- **VS-23 / I-3:** add the MCP connector, Agent Skills, server-side code execution and programmatic tool calling, and dynamic filtering for web search and fetch to the list of request features refused under `zdr`.
- **VS-25/VS-26 cache work** may use 1-hour TTLs on Anthropic-direct ZDR routes. Keep cache diagnostics to development, as the contract already says.
- **`decideRoute`:** when the destination is Bedrock or Google-managed Claude, require an attestation for that cloud account, not for Anthropic.

---

## 4. OpenAI's current ZDR terms, and whether extended caching is ZDR-eligible

**Partly verified.** The prose pages (your-data, prompt-caching guide) are **unreachable**. Source: `openai` npm 7.52.0 (published 2026-11-05), `resources/responses/responses.d.ts` and `resources/safety/alerts.d.ts`. **[vendor]**

- **`prompt_cache_retention`** is now *deprecated* ("Use `prompt_cache_options.ttl` instead").
  - It "expresses a maximum retention policy, while `prompt_cache_options.ttl` expresses a minimum cache lifetime".
  - "For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported."
  - "For older models that support both `in_memory` and `24h` … Organizations without ZDR enabled default to `24h`. Organizations with ZDR enabled default to `in_memory`."
- **`prompt_cache_options`** is "Supported for `gpt-5.6` and later":
  - `mode: implicit | explicit` and explicit `prompt_cache_breakpoint`s, up to four written per request;
  - `ttl: '30m' | '12h'`, "defaults to `30m`";
  - `comparison_response_id` for cache diagnostics.
- **Safety alerts.** `SafetyAlert.reason` is "null for zero data retention requests". `detailed_explanation` is "temporarily available for eligible zero data retention alerts".
- **The verified answer on extended caching:**
  - OpenAI's SDK neither says extended (24h or 12h) caching is ZDR-eligible nor that it is excluded.
  - It does show that ZDR orgs are kept on `in_memory` by default where they have a choice.
  - It also shows that ZDR orgs have **no** in-memory option on gpt-5.5 and later.
  - **[inference]:** OpenAI treats extended caching as something ZDR orgs must opt into for older models. On gpt-5.5+ a ZDR org accepts extended KV retention by using the model. Whether that is inside the ZDR contract is still **unverified**.
  - **[inference]:** safety alerts mean OpenAI also produces, and temporarily holds, safety output about ZDR traffic.

**What it changes:**
- **VS-23a:** an `openai` entry in `zdrAttested` should name what the owner's agreement covers. For gpt-5.5 and later, refuse unless the attestation explicitly covers extended prompt-cache retention (a new reason such as `extended-cache-unattested`, or fold it into `retention-required-model`).
- **VS-23a, OpenAI-direct bodies on older models:** set `prompt_cache_retention: "in_memory"` (and never `ttl: "12h"`) under `zdr`.
- **I-3:** add OpenAI safety alerts to the "ZDR reduces retention; it cannot rule it out" notes.

---

## 5. Google: Gemini API and Vertex / Agent Platform ZDR terms

**Partly verified.**
- **Unreachable:** ai.google.dev (Gemini API terms and ZDR page) and docs.cloud.google.com, which now holds every Vertex doc. The Vertex ZDR page `cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention` 301-redirects there.
- **Reachable:** the Google Cloud Service Specific Terms, https://cloud.google.com/terms/service-terms ("Last modified October 30, 2026"; accessed 2026-11-06). **[vendor, contractual]**

**What the terms say:**
- **§20(h) "Handling of Prompts and Generated Output":** "Absent Customer's prior permission or instruction, Google will not store outside Customer's Account (i) Customer Data prompted to a Generative AI Service for longer than is reasonably necessary to create the Generated Output, or (ii) the Generated Output."
- **§18 Training Restriction:** "Google will not use Customer Data to train or fine-tune any AI/ML models without Customer's prior permission or instruction."
- **Grounding with Google Search:** Google stores "queries derived from End User prompts and contextual information … for up to three (3) days … for debugging", described as "an exception to the security controls" of the Agent Platform.
- **Grounding with Google Maps:** "store prompts, contextual information … and Generated Output for thirty (30) days".
- **Partner and non-TOS customers (§4):** "Notwithstanding the 'Handling of Prompts and Generated Output' section… if these tools detect potential abuse… Google may log prompts… See the Abuse Monitoring documentation". The abuse-monitoring page itself is unreachable.
- **Naming:** Vertex AI is now "Gemini Enterprise Agent Platform (formerly Generative AI on Vertex AI)".
- **Still unverified:** the current Gemini Developer API (AI Studio key) logging period, round one's recalled 55 days, and the Vertex ZDR prerequisites (disable in-memory caching, abuse-logging exception).

**What it changes:**
- **VS-23a:** under `zdr`, refuse Google grounding tools: Search, and above all Maps, with its 30-day storage.
- **VS-23a:** treat a Gemini Developer API key as `unattested-provider` unless the owner attests it. Its terms could not be checked.
- **VS-23a:** an Agent Platform (Vertex) attestation should state that the project has the in-memory caching and abuse-logging exceptions applied (to be confirmed when docs.cloud.google.com is reachable).
- **Naming:** the route table and notes should use "Agent Platform (Vertex)".

---

## 6. D8: licences of Martian's offline benchmark repositories (verified, code)

**The benchmark itself:**
- `withmartian/code-review-benchmark` is **MIT**. HEAD is still `e616e84` (2026-08-30).
- The 50 PRs come from forks: `ai-code-review-evaluation/{cal.com,grafana,sentry,keycloak}-*` and `discourse-graphite`, plus upstream PR URLs.
- What D8 governs is the code in those PRs.

**Licences:**

| Repo (PRs) | Licence at the benchmark snapshot | Upstream HEAD today | D8 |
|---|---|---|---|
| Keycloak (10) | Apache-2.0 (fork `keycloak-greptile/master/LICENSE.txt`) | Apache-2.0 | **OK** |
| Cal.com (10) | **AGPLv3**, with `packages/features/ee` and `apps/api/v2/src/ee` under a commercial licence (fork `cal.com-greptile/main/LICENSE`) | **MIT** (upstream `calcom/cal.com` LICENSE is now plain MIT) | Not OK for the snapshot code; the upstream relicence does not reach the frozen fork |
| Grafana (10) | AGPL-3.0 (fork `grafana-greptile/main/LICENSE`) | AGPL-3.0 | No |
| Discourse (10) | GPL-2.0 (fork `discourse-graphite/master/LICENSE.txt`) | GPL-2.0 | No |
| Sentry (10) | FSL-1.1-Apache-2.0 (fork `sentry-greptile/master/LICENSE.md`) | same | Partly; see the FSL timing below |

**Correction to round one:**
- Cal.com is MIT **upstream today**. The benchmark's frozen code is AGPL plus commercial `ee`.
- Round one's other licences are confirmed.

**FSL timing:**
- The FSL's "Grant of Future License" makes each version Apache-2.0 "effective on the second anniversary of the date we make the Software available".
- I fetched the base and PR-head commits of each Sentry fork in Martian's `code-review-benchmark` org. Commit dates:
  - PR67876: base 2024-03-28, head 2024-04-03;
  - PR77754: base 2024-10-02, head 2024-10-03;
  - PR80168: base and head 2024-11-05;
  - PR80528: 2024-11-11;
  - the rest: 2025-06 and 2025-07.
- **My analysis:** as of 2026-11-06, three Sentry PRs (67876, 77754, 80168) fall under Apache-2.0, PR80528 joins on 2026-11-11, and the rest join in mid-2027.
- That reading assumes "made available" means the commit's public date. That is a legal call for the owner.

**Net (my analysis):** at most **13 of 50 PRs** (Keycloak 10 + Sentry 3), carrying **40 of 173 golden comments**, satisfy D8 today.

**What it changes:**
- **Q10 / C-9:** Martian's full set needs the owner exception. A D8-clean Martian subset exists, but it is too small and too Java-heavy for any rate; at most it is a smoke test.
- **VS-22b:** record the licence per PR at the PR's own commit, not per repo at HEAD. Cal.com shows that the two can differ.

---

## 7. D8: AACR-Bench licences (verified, code)

**Source:** `alibaba/aacr-bench`, cloned at `ee9d7fe` (2026-10-15).
- The repo LICENSE is **Apache-2.0**.
- `dataset/positive_samples.json` has 196 samples and 1,506 comments; `negative_samples.json` has 155.
- Together they cover 200 unique PRs from 50 repos, created 2024-12-02 to 2025-10-03.

**Method:** I fetched each repo's licence file at HEAD, and again at the commit of its first PR in the dataset.

**Permissive (40 repos):**
- **MIT:** PowerShell, uv (MIT/Apache dual), bitcoin, browser-use, aspnetcore, electron, react, filament, langflow, laravel, lvgl (at HEAD only), PowerToys, semantic-kernel, three.js, LocalAI, node, ollama, osu (code), svelte, symfony, union.
- **Apache-2.0:** ClickHouse, spring-ai-alibaba, cline, dbeaver, gofr, gemini-cli, ragflow, hyperswitch, kestra, keycloak, linera, typescript-go, codex, opencv, vllm, waveterm.
- **BSD-3:** appwrite, valkey.
- **zlib:** SDL.
- **Union:** MIT at the PR commit. At HEAD the workspace's `license-file = "LICENSE"` points to a missing file, beside LICENSE-MIT and LICENSE-APACHE.

**Not permissive (10 repos):**
- **AGPL-3.0:** Checkmate, immich, nextcloud.
- **AGPL plus a user-segmented dual licence:** cherry-studio.
- **GPL-3.0:** ComfyUI.
- **GPL-2.0 (LGPL build option):** mpv.
- **LGPL:** FreeCAD (LGPL-2 at the PR commit, LGPL-2.1 at HEAD).
- **AGPL/SSPL/ELv2 triple licence:** Elasticsearch (x-pack is ELv2 only).
- **Sustainable Use License:** n8n (not OSI).
- **Mixed:** timescaledb. Apache outside `tsl/`, Timescale License inside it, and **all 4 of its PRs touch `tsl/`**.

**Permissive subset (my analysis):**
- **144 of 200 PRs**: 140 positive samples with **970 golden comments**, and 114 negative samples.
- **By language** (positive samples): Go 22, C++ 22, Python 16, Java 16, TypeScript 14, C 11, C# 10, PHP 10, Rust 10, JavaScript 9.
- **By context level:** Diff 490, File 320, Repo 160.

**Golden comments are mostly model-written.** In the whole set, 1,114 of 1,506 positive comments have `is_ai_comment: true`, with `source_model` as follows: GPT-5.2 379, Claude-Code/Claude-4.5-Sonnet 190, GLM-4.7 182, Qwen-Coder-480B 162, Gemini-3-Pro 101, DeepSeek-V3.2 100. In the permissive subset, 274 of 970 are human. The README describes the pipeline as "GitHub human comments → LLM enhancement → Expert multi-round cross-annotation". **[vendor (academic group)] + my analysis**

**What it changes:**
- **VS-22b / Q10:** AACR-Bench's permissive subset (144 PRs) is a usable D8-clean source, about ten times the D8-clean Martian subset.
- **VS-22b:** licences must be checked per PR. Timescale's `tsl/` paths and Elasticsearch's x-pack show that a repo-level check is not enough.
- **VS-25:** 41 of the 140 permissive positives are C, C++, C# or PHP, which VS-25's grammar set (TS/TSX, JS, Python, Go, Rust, Java) does not parse. Either restrict to the grammar languages or report those cases separately.
- **VS-29a:** because the golden comments are mostly model-written, and GPT-5.2-written most often, a same-family vs cross-family A/B on AACR is confounded by the golden source. Stratify by `source_model`, or score on the 274 human golden comments only.

---

## 8. arXiv 2607.21997 ("Go Home Copilot, You're Drunk")

**Unreachable.** arxiv.org, export.arxiv.org, Zenodo (replication package record 19247232) and every scholarly mirror I tried were refused.

The only further detail I found is a sibling lane's internal design note (scratchpad `gu/churn/NOTES.md` and `README.md`). It reports, from a "novelty check" whose own source is not stated:
- 54,713 agent comments;
- 341 Python repositories;
- `isResolved` as the outcome;
- resolution rates of 72.9% (Copilot), 67.2% (Cursor) and 54.8% (Codex);
- a frame of "PRs created through Dec 2023".

That last point sits badly with Cursor and Codex review comments, which did not exist in 2023. It is probably a repository-selection frame, not a PR-date frame. **Secondary, unverified.**

The same sibling study reports its own measurement: bot threads resolve at 74.4% when a human also reviews, and 42.9% across all AI-reviewed PRs. **[community/internal, our own measurement]**

**What it changes:**
- The REPORT line "inline code suggestions are the strongest predictor of resolution" stays labelled "search extract, not read".
- A point in its favour, from the Martian data **[code]**: 9 of Graphite's 13 comments carry ```` ```suggestion ```` blocks.
- Do not let it drive VS-27's comment format until the paper is read.

---

## 9. How Graphite's January 2026 Martian run was configured (verified as far as the data allows, code)

**Source:** `offline/results/benchmark_data.json`, `step0_fork_prs.py`, `step1_download_prs.py`, `offline/analysis/benchmark_dashboard.{py,json}` at `e616e84`. Full history was fetched; 209 commits.

**What the data shows:**
- **Where and when it ran.** One Graphite run. Each PR was recreated in Martian's own `code-review-benchmark` org as `{repo}__graphite__PR{n}__20260123`: 49 on 2026-01-23 and 1 on 2026-01-24.
- **How PRs were created.** Step 0 pushes the original base SHA and PR head into a new **private** repo, disables Actions and push protection, opens the PR with the original title and body, then makes the repo **public**.
- **Product.** Comments are signed "Spotted by Graphite Agent", with links to `app.graphite.com/diamond/?org=code-review-benchmark`, so the product was Graphite Agent (formerly Diamond).
- **Timing.** Comments were posted 2026-01-25 (5) and 2026-01-26 (8), two to three days after the PRs were opened.
- **Configuration files.** None of the paths I probed exists in the fork (`.graphite.yml`, `.graphite/config.yml`, `.github/graphite.yml`, `graphite.yml`, `.diamond.yml`). Graphite's settings live in its app, and nothing in the repo records custom rules, sensitivity, exclusions or a product version.
- **Not re-run.** Graphite was never run again, unlike Greptile (4 runs), Qodo (7) or CodeRabbit.

**What Graphite produced:**
- **13 comments on 50 PRs, and nothing at all on 40 of them.** No review body and no summary comment either. Step 1 collects inline comments, review bodies and issue comments, so a summary would have been captured.
- **Scores, Core profile:**
  - Opus judge: TP 12 / FP 0 / FN 146, so precision 100.0, recall 7.6 and F1 14.1;
  - GPT-5.2 judge: TP 11 / FP 4, so precision 73.3 and recall 7.0.

**The comparison round one missed:**
- Martian **hides** `linearb` (16 comments, 41 silent PRs) and `bito` (0 comments) as "incomplete runs etc." (`_HIDDEN_TOOLS`).
- Graphite's run has the same silence pattern (13 comments, 40 silent) but stays on the dashboard.
- Step 1 swallows `gh api` failures (`except subprocess.CalledProcessError: pass`), so a failed fetch is indistinguishable from a silent tool.

**What it changes:**
- **Weaken the inference in C-2 and REPORT §6** that Graphite's 0.07 recall reflects acceptance-only tuning. **[inference]:** the evidence is equally consistent with an incomplete or throttled run, or a very conservative default.
- Graphite's result should not be used as support for the five-class comment filter.

---

## 10. The method behind Greptile's Model Inversion

**Still unverified.** greptile.com, docs.greptile.com and x.com remain unreachable. I checked every primary artifact I could reach:
- **The official CLI** (`greptile` 3.8.0, npm, 2026-10-26, MIT; maintainers include Greptile staff) **[code]:**
  - review requests carry `effort: "base" | "plus" | "apex"`, confirming the depth tiers;
  - the documented org settings keys are `org.review.strictness` ("1 is low, 2 medium, and 3 high"), `triggerOnUpdates`, `shouldUpdateDescription`, `fixWithAI`, `codingAgents` and `summary.*`;
  - there is no model, model-family, inversion, author-detection or ZDR key.
- **`greptileai/akupara`** is unchanged at `09b7db2` (2026-11-04) and has no inversion code.

Round one's description stays vendor-only and unreplicated:
- detection from commit trailers, branch prefixes and PR titles;
- 2×500 PRs;
- about 1,500 ground-truth comments.

**What it changes:**
- **VS-29b** stays an explicit local opt-in. There is no vendor setting to mirror.
- Greptile's user-facing knob is **strictness**, not model choice. Inversion appears to be server-side and automatic **[inference]**.
- Greptile's documented detection signals (trailers, branch names, PR titles) are exactly what I-2 classes as untrusted. The contract is right not to copy them.

---

## 11. Summary of contract changes

**VS-23 (ZDR routing):**
1. Keep the transport-layer `zdrRequestBody`. Add a test that an `extraBody` or `providerOptions.openrouter` replacement of `provider` is still forced to ZDR (VOI1).
2. Refuse `provider.options` under `zdr` (VOI3).
3. Recognise `eu.openrouter.ai` and `us.openrouter.ai` as OpenRouter (VOI4).
4. Treat any 404 on a ZDR request as a non-retried policy refusal, without matching message text (VOI2).
5. Owner setup: per-provider `enforce_zdr_*`, plus `allow_safety_retention_google` and `allow_safety_retention_other` set to false (VOI5).
6. Add to the features refused under `zdr`: Anthropic's MCP connector, Agent Skills, code execution and programmatic tool calling, and dynamic web filtering; also Google grounding (VOI7, VOI10).
7. OpenAI on gpt-5.5+: refuse unless the attestation covers extended caching. Force `in_memory` on older models (VOI8).
8. Route attestation for Bedrock and Google-managed Claude is per cloud account (VOI7).
9. Add OpenAI safety alerts to the I-3 caveats (VOI9).
10. The OpenRouter batch refusal is now vendor-backed (VOI6).

**VS-22 (dataset) and D8:**
1. Prefer AACR-Bench's 144-PR permissive subset (VOI13).
2. Check licences per PR, at the PR's commit (VOI12, VOI14).
3. The D8-clean Martian subset is 13 PRs and 40 golden comments, a smoke test only (VOI11, VOI12).
4. Restrict or separately report the AACR cases in languages VS-25's grammars do not cover (VOI13).

**VS-29 (cross-family verifier):**
1. Stratify the AACR A/B by golden `source_model`, or score on human golden comments only (VOI15).
2. Inversion stays an opt-in with no vendor setting to mirror, and Greptile's detection signals stay untrusted (VOI17).

**C-2:** weaken the Graphite-based argument (VOI16).
