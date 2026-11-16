# Vectorscope technical enablers: ZDR routing, code graphs, token budgeting

Researched 2026-11-05/06. Written for the Vectorscope review helper in this repo.

## How this was researched, and the gaps

- **Blocked hosts.** The session's network blocked `openrouter.ai`, `platform.openai.com` and `privacy.claude.com` (DNS failures through the proxy). Following the tool guidance, I stopped probing other web hosts after that. **To re-verify the OpenRouter prose docs, OpenAI docs and Google docs, `openrouter.ai`, `developers.openai.com`, `ai.google.dev` and `cloud.google.com` must be allowed in the session's network settings.**
- **Search budget.** The shared WebSearch budget for this turn was already used up before my first query. No web searches ran, so this file has no search-snippet claims.
- **What I read instead (primary sources only):**
  - Anthropic docs on `platform.claude.com` (reachable).
  - Vendor SDKs and OpenAPI specs, downloaded from npm. OpenRouter's SDK is generated from its OpenAPI spec, so its doc comments are the API reference text.
  - Public GitHub repos (tree-sitter, SCIP, stack-graphs, LSIF, ctags, Aider, PR-Agent, FrugalGPT), shallow-cloned.
  - This repo's own code.
  - One benchmark I ran myself.
- **Labels.** Every claim carries one:
  - `[vendor]`: vendor docs or vendor SDK text.
  - `[independent]`: a third party, or my own measurement.
  - `[research]`: a paper.
  - `[code]`: read from source code.
  - `[inference]`: my reasoning.
  - `[prior-knowledge]`: from my training data and not re-fetched this session. Treat these as possibly outdated.
- **Dates.** Anthropic doc pages show no "last updated" date. I give the access date and the `anthropic-version: 2026-10-21` header used in their examples. SDK sources carry the package publish date. Repos carry the HEAD commit date.

---

## 1. Zero data retention (ZDR) routing

### 1.1 OpenRouter request parameters (exact names)

Source: `@openrouter/sdk` 1.5.59 (published 2026-11-05), `esm/models/providerpreferences.d.ts`, https://www.npmjs.com/package/@openrouter/sdk. Same text in the OpenAPI spec at https://github.com/OpenRouterTeam/typescript-sdk/blob/main/.speakeasy/in.openapi.yaml (commit fe342e9, 2026-11-05), schema `ProviderPreferences`. All `[vendor]`.

The request body takes `provider: { ... }` with these wire names, all optional and nullable:

| Field | Type | Vendor description (quoted or condensed) |
|---|---|---|
| `zdr` | boolean | "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. When true, only endpoints that do not retain prompts will be used." |
| `data_collection` | `"allow"` \| `"deny"` | "If no available model provider meets the requirement, your request will return an error. allow: (default) allow providers which store user data non-transiently and may train on it. deny: use only providers which do not collect user data." |
| `allow_fallbacks` | boolean | "true: (default) when the primary provider (or your custom providers in "order") is unavailable, use the next best provider. false: use only the primary/custom provider, and return the upstream error if it's unavailable." |
| `order` | string[] | "The router will attempt to use the first provider in the subset of this list that supports your requested model, and fall back to the next if it is unavailable. If no providers are available, the request will fail with an error message." |
| `only` | string[] | "List of provider slugs to allow. If provided, this list is merged with your account-wide allowed provider settings for this request." |
| `ignore` | string[] | "List of provider slugs to ignore… merged with your account-wide ignored provider settings." |
| `require_parameters` | boolean | "Whether to filter providers to only those that support the parameters you've provided. If this setting is omitted or set to false, then providers will receive only the parameters they support, and ignore the rest." |
| `quantizations` | string[] | Filter by quantization level. |
| `sort` | string or object | "The sorting strategy to use for this request, if "order" is not specified. When set, no load balancing is performed." |
| `max_price` | `{prompt, completion, request, image, audio}` | USD per million tokens (prompt and completion), or per request or image. |
| `preferred_max_latency`, `preferred_min_throughput` | number or percentile object | Soft deprioritization, not hard filters. |
| `enforce_distillable_text` | boolean | Restrict routing to models whose authors allow distillation. |
| `options` | object | Provider-specific passthrough keyed by provider slug. |

Example (from the SDK README, same date) `[vendor]`:

```ts
openRouter.chat.send({ chatRequest: { model: "openai/gpt-5", provider: { zdr: true, sort: "price" }, messages: [...] } })
```

The AI SDK provider (`@openrouter/ai-sdk-provider` 3.1.0, modified 2026-09-19, `dist/index.d.ts`) has a typed `provider` setting with the same fields, including `zdr`, `data_collection`, `allow_fallbacks`, `require_parameters`, `only`, `ignore`, `order`, `quantizations`, `sort` and `max_price`. It can also be set through `extraBody`. `[vendor]` This repo pins version 2.9.0 (`packages/core/package.json`, `packages/engine/package.json`); I did not check whether 2.9.0's types include `zdr` `[code]`. Passing it through `extraBody` works on any version `[inference]`.

Other request fields that matter for caching and routing (same SDK, `chatrequest.d.ts`) `[vendor]`:
- `session_id`: "OpenRouter uses it as the sticky routing key, routing all requests in the session to the same provider to maximize prompt cache hits." Max 256 characters. It can also be sent as the `x-session-id` header.
- `cache_control` (top level, Anthropic-style automatic caching). Block-level `cache_control` and the OpenAI-style `prompt_cache_breakpoint` "are interchangeable: OpenRouter converts between the two based on the provider serving the request."
- `prompt_cache_options`: `{ mode: "explicit", ttl: "30m" | "12h" }`. "Only supported by OpenAI GPT-5.6 and newer."
- `models: []`: a list of fallback models. This repo's code notes that data-policy settings apply once to the whole list (`packages/core/src/free-model-request.ts`) `[code]`.

### 1.2 OpenRouter account and workspace controls (non-request)

All from the OpenAPI spec and SDK above, 2026-11-05 `[vendor]`:

- **Guardrails** (`POST /guardrails`, then assign them to API keys, members, or a workspace's default guardrail) carry:
  - `enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_xai` and `enforce_zdr_other`. The legacy `enforce_zdr` is deprecated; when set, its value is copied into the per-provider fields that are not explicitly given.
  - `enable_paid_model_training`, `enable_free_model_training` and `enable_free_model_publication`.
  - `allowed_providers`, `ignored_providers`, `allowed_models`, `ignored_models`, `allowed_data_regions` (`global` / `europe` = eu.openrouter.ai / `us` = us.openrouter.ai) and `limit_usd`.
  - A newly created guardrail "enforces nothing until it is assigned to API keys or organization members."
- **Safety Retention** is a third retention class.
  - The `safety_retention` endpoint flag means: "prompts are not retained by default, but the provider may retain prompts its safety classifiers flag. A ZDR-enforced request reaches these endpoints only when the account allows Safety Retention and no applied guardrail disallows it."
  - Guardrail fields `allow_safety_retention_google` and `allow_safety_retention_other` (for example open-weight models on Vertex) "can only be more restrictive than the account setting."
  - Effect: depending on account settings, `zdr: true` does **not** guarantee that flagged prompts are never retained `[inference from vendor text]`.
- **OpenRouter-side logging** is separate from the upstream provider. Workspace settings include:
  - `is_data_discount_logging_enabled` ("data discount logging").
  - `is_observability_io_logging_enabled` ("private logging"), with `io_logging_sampling_rate` and `io_logging_api_key_ids`.
  - `GET /generation/content` "Returns the stored prompt and completion content".
  - So a ZDR posture must also keep these workspace flags off. `[vendor]` for the flags; `[inference]` that they defeat ZDR.
- **BYOK keys** carry `declared_zdr`: "`true` declares the account ZDR so requests that require ZDR may route to this credential even when the shared endpoint retains data… Self-declared and not verified by OpenRouter." Private endpoints likewise carry an attested `declared_zdr`.
- `GET /models/user` lists "models filtered by user provider preferences, privacy settings, and guardrails". This is the cheapest way to show a user only what their account can actually route.
- `[prior-knowledge, ~2025]` The dashboard privacy page (openrouter.ai/settings/privacy) also has an account-wide "ZDR endpoints only" toggle and training toggles. The guardrail fields above are their API equivalents. Not re-verified.

### 1.3 Listing ZDR endpoints per model

`[vendor]`, SDK and spec as above:

- `GET /api/v1/endpoints/zdr` (SDK: `endpoints.listZdrEndpoints`, "Preview the impact of ZDR on the available endpoints"). Returns `data: PublicZdrEndpoint[]` ("An endpoint whose data policy does not retain prompts by default"). Each entry has:
  - `model_id`, `provider_name`, `tag`, `context_length` and `max_completion_tokens`.
  - `pricing`, including `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `discount` and conditional `overrides` such as long-context pricing.
  - `supports_implicit_caching`, `supported_parameters` and `quantization`.
  - `uptime_last_5m/30m/1d` and latency/throughput percentiles.
  - `safety_retention`.
- `GET /api/v1/models?zdr=true`: "When set to "true", return only models with zero data retention endpoints."
- `GET /api/v1/models/{author}/{slug}/endpoints`: every endpoint for a model. Join on `tag` against `/endpoints/zdr` to tell which of a model's endpoints are ZDR `[inference]`.

### 1.4 What happens when no ZDR or compliant endpoint exists

- Vendor text only says the request "will return an error" (`data_collection`, `order`) `[vendor]`.
- This repo's own code documents the concrete shape: "OpenRouter answers 404 "No endpoints found matching your data policy" when no endpoint a request may use passes both the user's own privacy settings and the request's data_collection" (`packages/core/src/free-models.ts`, `explainPolicyRefusal`, last touched 2026-10-24) `[code]`.
- That `zdr: true` fails through the same 404 "No endpoints found…" path is `[inference]`, consistent with `[prior-knowledge]`.
- `[prior-knowledge]` `require_parameters: true` with no capable endpoint returns a 404 of the form "No endpoints found that can handle the requested parameters".
- `allow_fallbacks: false` returns "the upstream error if it's unavailable" `[vendor]`. Vectorscope should treat a 404 data-policy error as a configuration error (show the model and the policy), not as a transient error to retry `[inference]`.

### 1.5 Does prompt caching work on ZDR endpoints?

- **Anthropic direct: yes.** Prompt caching is "ZDR eligible: Yes". "Your prompts and Claude's outputs are not stored. KV cache representations and cryptographic hashes are held in memory for the cache TTL and promptly deleted after expiry." Source: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (accessed 2026-11-05) and https://platform.claude.com/docs/en/build-with-claude/prompt-caching `[vendor]`.
- **OpenRouter: the API data says yes per endpoint.** `PublicZdrEndpoint` reports `supports_implicit_caching` and cache-read/write prices, so ZDR endpoints are not defined as cache-less `[vendor data]`. That OpenRouter counts in-memory provider caching as compatible with ZDR is `[inference]`. I could not read the prose page openrouter.ai/docs/features/zdr (host blocked).
- **Cache locality.** A cache is per provider and per model. Under `zdr: true` an Anthropic model may be served by several ZDR endpoints, so send `session_id` to stay on one provider `[vendor field; inference on necessity]`.
- **OpenAI direct.** SDK text on `prompt_cache_retention` says: "For older models that support both `in_memory` and `24h`, the default depends on your organization's data retention policy: Organizations without ZDR enabled default to `24h`. Organizations with ZDR enabled default to `in_memory`… For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported." (`openai` npm 7.52.0, 2026-11-05, `resources/responses/responses.d.ts`) `[vendor]`. My reading: in-memory caching is the ZDR-default class, and extended (24h) caching applies to ZDR orgs on gpt-5.5+. Confirm this against developers.openai.com/api/docs/guides/prompt-caching and your-data before relying on it `[inference]`.

### 1.6 Direct-provider retention terms

**Anthropic** (https://platform.claude.com/docs/en/manage-claude/api-and-data-retention, accessed 2026-11-05) `[vendor]`:

- ZDR "is enabled per organization" by the account team via sales. Each new org must be enabled separately. ZDR orgs cannot call the API from a browser: CORS requests are rejected.
- **Covered:** the Messages and Token Counting APIs for eligible features, Claude Code with Commercial API keys (metrics-logging productivity data excepted), Claude Platform on AWS, and Claude on Google Cloud (Anthropic managed).
- **Not covered:**
  - Console/playground, Managed Agents, consumer plans, Teams/Enterprise UIs (Claude Code on Enterprise has a separate offering) and Claude for Excel.
  - **Covered Models**: Claude Fable 5.1, Mythos 5.1, Fable 5 and Mythos 5 "require 30-day data retention and are not available under ZDR unless expressly authorized". Calling Fable 5 without the needed retention returns `400 invalid_request_error`: "In order to access this model, your organization or workspace must have data retention enabled." A ZDR org can turn on 30-day retention for a single non-default workspace.
- **ZDR feature table:**
  - Yes: Messages, prompt caching, token counting, thinking/adaptive thinking, effort, fast mode, citations, PDF inline, search results, web search and web fetch (without dynamic filtering), advisor tool, tool search, context editing, threshold compaction, 1M context, and client tools (bash, text editor, memory, computer use).
  - Yes (qualified): structured outputs ("Only the JSON schema is cached, for up to 24 hours since last use"), cache diagnostics (hash fingerprint retained briefly).
  - No: Batch (`/v1/messages/batches`, "29-day retention"), Files API, code execution and programmatic tool calling ("data retained up to 30 days"), Agent Skills, MCP connector, MCP tunnels, message threads, Managed Agents and user profiles.
- "Under ZDR, the API does **not** block these features; using one is a choice to step outside your ZDR arrangement." HIPAA orgs, by contrast, get a 400 for ineligible features.
- **Override:** "if a chat or session is flagged, Anthropic may retain inputs and outputs for up to 2 years". Legal holds also override.
- The page states: "Conversation content (your prompts and Claude's outputs) is not retained by default; the exception is Covered Models, which require 30-day retention." The default commercial retention article (privacy.claude.com) was blocked.
- `[prior-knowledge]` Anthropic announced in 2025 that standard API log retention would drop from 30 to 7 days from 2025-09-15. The current wording above may supersede this. Verify.

**OpenAI** (https://developers.openai.com/api/docs/guides/your-data was not reachable):

- `[vendor]` (SDK text): Responses API `store` "Defaults to true… response data will be stored for at least 30 days, subject to the data retention exceptions". Use `include: ["reasoning.encrypted_content"]` for stateless multi-turn "when the `store` parameter is set to `false`, or when an organization is enrolled in the zero data retention program". There is a "ZDR-compatible compaction" path.
- `[prior-knowledge, 2025]`:
  - API content is not used for training by default.
  - Abuse-monitoring logs are kept up to 30 days by default.
  - ZDR and Modified Abuse Monitoring need approval for eligible customers.
  - Stateful endpoints (Assistants/Threads, Files, Vector Stores, Batch, and background mode) are not ZDR-eligible.
  - A 2025 US court preservation order (NYT v. OpenAI) temporarily forced retention of non-ZDR API output logs. ZDR customers were excluded, and OpenAI said the order ended in late 2025. Lesson: legal holds can override default retention.

**Google** (ai.google.dev and cloud.google.com not reachable) `[prior-knowledge, 2025; verify]`:

- **Gemini Developer API, unpaid tier:** content may be used to improve products and reviewed by humans.
- **Gemini Developer API, paid tier:** prompts and responses are not used for product improvement but are logged for a limited period (Google has cited 55 days) for abuse detection.
- **Vertex AI ZDR** requires the customer to:
  - disable Vertex's default in-memory data caching (up to 24h per project);
  - obtain an exception from abuse-monitoring prompt logging;
  - avoid features that store data (Grounding with Google Search keeps data around 30 days; session resumption).
- `[vendor]` (SDK, `@google/genai` 2.32.0, 2026-10-29): `models.countTokens` exists. Explicit context caches are resources with a `ttl`. The SDK ships an experimental offline `LocalTokenizer` (`@google/genai/tokenizer/node`) whose model list runs only up to `gemini-3-pro-preview` (possibly stale).
- **Through OpenRouter**, Google endpoints are where "Safety Retention" applies (`allow_safety_retention_google`) `[vendor]`.

---

## 2. Code graphs at scale

### 2.1 Tree-sitter, including web-tree-sitter (wasm) in Bun and Node

- **Concept.** "Tree-sitter is a parser generator tool and an incremental parsing library. It can build a concrete syntax tree for a source file and efficiently update the syntax tree as the source file is edited… Robust enough to provide useful results even in the presence of syntax errors… Dependency-free." Source: https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/index.md (commit 62816e1, 2026-11-04) `[vendor]`.
- **web-tree-sitter** (README `lib/binding_web/README.md`, same commit) `[vendor]`:
  - `Parser.init({ locateFile })`, then `Language.load(path.wasm)` or `Language.loadSync(WebAssembly.Module)`.
  - Incremental edits via `tree.edit(...)` followed by `parser.parse(newText, oldTree)`.
  - `Tree.getChangedRanges(other)`.
  - ABI table: 0.24.x supports ABI 13–14; >= 0.25.0 supports ABI 13–15.
  - Warning: "Some prebuilt `.wasm` files use an older dynamic-linking format that newer versions of `web-tree-sitter` cannot load… Rebuild these files using a current tree-sitter CLI."
  - "Executing `.wasm` files in Node.js is considerably slower than running Node.js bindings."
  - Since 0.26.1, `tree-sitter build --wasm` downloads wasi-sdk automatically.
- **Versions** (npm registry, read 2026-11-05) `[vendor]`: web-tree-sitter latest is 0.27.1 (2026-10-08). 0.26.0 shipped 2025-09-19 and 0.25.10 on 2025-09-22. This repo pins `web-tree-sitter` 0.25.10 (`packages/engine/package.json`) `[code]`.
- **Upgrade gotcha** `[code]`: the runtime wasm export was renamed. 0.25.10 exports `./tree-sitter.wasm`; 0.27.1 exports `./web-tree-sitter.wasm`. The repo loads `import("web-tree-sitter/tree-sitter.wasm", { with: { type: "wasm" } })` in `packages/engine/src/tool/shell.ts` (with lazy per-grammar loading because "The PowerShell grammar alone adds about 15 MiB"), so a bump must change that specifier.
- **Prebuilt grammar packs.** My test, 2026-11-06, Bun 1.3.14 with web-tree-sitter 0.27.1 `[independent]`:
  - `tree-sitter-wasms` 0.1.13 (2025-10-07; 36 grammars; built with `tree-sitter-cli ^0.20.8`): the Rust and Java wasm **failed to load**.
  - `@vscode/tree-sitter-wasm` 0.3.1 (2026-04-07; 16 grammars: bash, c#, cpp, css, go, ini, java, js, php, powershell, python, regex, ruby, rust, ts, tsx): **loaded** (ABI 14/15).
  - Per-language npm packages `tree-sitter-python` 0.25.0, `tree-sitter-go` 0.25.0 and `tree-sitter-typescript` 0.23.2 ship `.wasm` files and **loaded** (ABI 15/15/14) in about 11–12 ms each.
- **Measured throughput** `[independent; my measurement]`. Script: `a scratch benchmark script (not committed)`. Setup: Bun 1.3.14, web-tree-sitter 0.27.1, tree-sitter-typescript 0.23.2, one thread on a 4-vCPU Xeon 2.1 GHz, this repo's `packages/*/src/**/*.{ts,tsx}` (2,735 files, 23.6 M chars). Two runs:

  | Metric | Result |
  |---|---|
  | Runtime init | 29 ms |
  | Cold parse of all files | 4.75–4.83 s (about 5 MB/s) |
  | Import/export source query over all trees | 1.30–1.34 s |
  | Def/ref query (function/class defs + call identifiers, 71,041 captures) | 1.06–1.12 s |
  | Reverse import graph from 6,316 resolved relative-import edges | 14 ms |
  | BFS of transitive dependents of the most-imported file (`packages/core/src/effect/app-node.ts`: 103 direct, 208 transitive) | 0.44 ms |
  | Full reparse of the largest file (305 KB) | 67–74 ms |
  | Incremental reparse after an append edit (1 changed range) | 0.61 ms |
  | RSS with all 2,735 trees held | about 770 MB |

  RSS drops if trees are discarded after extraction `[inference]`. `git ls-tree -r HEAD -- packages` (6,400 blob SHAs) took 11 ms.
- **Tags/code-navigation queries.** tree-sitter's `tags` system uses `@definition.*` / `@reference.*` captures plus `@name`. It powers "GitHub's support for search-based code navigation" (`docs/src/4-code-navigation.md`) `[vendor]`. This is name-based, not type-resolved.

### 2.2 SCIP

Source: https://github.com/scip-code/scip (README and `docs/DESIGN.md`, commit bbec534, 2026-10-28). The repo has moved from `sourcegraph/scip` to the `scip-code` org. `[vendor]`:

- "A language-agnostic protocol for indexing source code" for go-to-definition, find-references and find-implementations.
- Protobuf schema with Go and Rust bindings, plus generated TypeScript and Haskell bindings and a `scip` CLI.
- Design: "a transmission format… not meant as a storage format for querying". Goals include "Adding file-level incrementality should be easy… Scaling for large monorepos" and parallel indexers. Protobuf TLV "enables streaming reads and writes as well as merging by concatenation". String symbol IDs instead of LSIF's integer IDs limit "the blast radius of indexer bugs".
- Indexers listed:
  - scip-java (Java, Scala, Kotlin)
  - scip-typescript (TS, JS)
  - rust-analyzer
  - scip-clang (C/C++)
  - scip-ruby
  - scip-python
  - scip-dotnet (C#, VB)
  - scip-dart
  - scip-php
- **Precise indexers need a build environment.** scip-typescript's README says `npm install` then `scip-typescript index --infer-tsconfig`, and documents OOM on large codebases (https://github.com/sourcegraph/scip-typescript, commit cfce600, 2026-11-05; npm `@sourcegraph/scip-typescript` 0.6.1, 2026-11-03) `[vendor]`.
- **Implication.** SCIP fits as an optional "precise mode" indexed in CI on the base branch. It is not the default per-PR path, because a hosted review bot often cannot install dependencies or build the repo `[inference]`.

### 2.3 Stack graphs

Source: https://github.com/github/stack-graphs (last commit fcb7705, 2025-09-09, "Merge pull request #502 from github/archive") `[vendor]`:

- README: "**This repository is no longer supported or updated by GitHub.**"
- Stack graphs "define the name resolution rules for an arbitrary programming language in a way that is efficient, incremental, and does not need to tap into existing build or program analysis tools". They are based on TU Delft scope graphs.
- Language definitions in the repo: Java, JavaScript, Python and TypeScript only.
- **Implication:** do not build on stack-graphs. The incremental, build-free idea is right; the code is unmaintained `[inference]`.

### 2.4 LSIF

- https://github.com/microsoft/lsif-node (HEAD 2026-10-22): "a standard format for language servers… to dump their knowledge about a workspace" as newline-separated JSON. The README still calls the tools "work in progress" with known gaps `[vendor]`.
- SCIP's design doc: "Sourcegraph historically supported LSIF uploads… ran into issues of development velocity, debugging, as well as indexer performance bottlenecks. LSIF support has since been fully deprecated and removed." `[vendor, competitor-adjacent]`
- **Implication:** skip LSIF.

### 2.5 ctags

- Universal Ctags (https://github.com/universal-ctags/ctags, HEAD 7053781, 2026-11-03) "generates an index (or tag) file of language objects found in source files", with regex-defined "optlib" parsers for new languages `[vendor]`.
- In HEAD, `parsers/` has 145 files and `optlib/` has 31 `.ctags` definitions. These are file counts, not a language count `[code]`.
- `[prior-knowledge]` ctags mainly emits definitions; reference tags exist only for some parsers. It is a native binary, not wasm, so it adds a distribution burden for a Bun tool.
- **Implication:** at most a fallback for languages with no tree-sitter grammar `[inference]`.

### 2.6 How review and coding tools compute impacted context cheaply

- **Aider repo map** (https://github.com/Aider-AI/aider/blob/main/aider/repomap.py, commit 5dc9490, 2026-05-22) `[code]`:
  - Tree-sitter `*-tags.scm` queries (60 query files) extract `name.definition.*` and `name.reference.*` per file. Refs are backfilled with pygments when a grammar has defs only.
  - Results are cached per file in a `diskcache` keyed by path and **mtime**.
  - It builds a file graph with an edge referencer→definer per identifier. Edge weight = multiplier × sqrt(ref count). Identifiers mentioned in chat get ×10; long snake/camel names get ×10; `_private` names get ×0.1; names defined in more than 5 places get ×0.1; refs from files already in chat get ×50.
  - It ranks with **personalized PageRank** (networkx), seeded on chat or mentioned files, then fills a token budget (`max_map_tokens`).
  - Token counting for large texts samples about 1/100 of lines and scales by character ratio (`token_count`).
- **PR-Agent / Qodo** (https://github.com/qodo-ai/pr-agent, commit ebdad19, 2026-11-05) `[code]` + `[vendor docs]`:
  - "Dynamic context" extends each hunk upward to the enclosing function or class (`allow_dynamic_context=true`, `max_extra_lines_before_dynamic_context = 10`, `patch_extra_lines_before = 5`, `patch_extra_lines_after = 1`).
  - Large-PR compression (`docs/docs/core-abilities/compression_strategy.md`):
    - sort files by the repo's main languages, then by token count;
    - drop deletion-only hunks;
    - add patches "until the prompt reaches a certain buffer from the max token length" (`OUTPUT_BUFFER_TOKENS_SOFT_THRESHOLD = 1500`, `HARD = 1000`);
    - list leftovers as "other modified files" and deleted files by name only.
  - `max_model_tokens = 32000` caps any model. `large_patch_policy = "clip"`.
- **Greptile** (vendor): full codegraph of functions, classes, calls and imports; checks callers, dependencies and similar functions for changed code. See the sibling note `docs/vector/build/vectorscope-research/greptile-architecture.md` §2.1.

### 2.7 Recommended design for "impacted dependents of a diff" `[inference unless marked]`

1. **Content-addressed per-file facts.** Key a cache on `(git blob SHA, grammar version, query version)`. Each entry stores the file's imports, top-level definitions with byte ranges, and referenced identifiers. Blob SHAs come free from `git ls-tree` (11 ms for 6,400 files, measured) and survive clones and CI. Aider's mtime key does not.
2. **Per PR, parse only changed blobs.** Base-branch facts are reused. A cold full index of this repo costs about 5 s parse plus about 2.5 s of queries in wasm (measured), and it is a one-time cost per base commit.
3. **Dependents in three precision levels:**
   - (a) **File level:** reverse import graph BFS (measured sub-millisecond).
   - (b) **Symbol level:** map each hunk to its enclosing definition (smallest named node containing the range), then find files that both import the changed module and reference the changed name. "Import-gated name match" cuts the name collisions that plague pure tags.
   - (c) **Precise:** optional SCIP index on the base branch for TS, Python, Java and Go repos whose CI can build.
4. **Rank under the token budget** with personalized PageRank seeded on changed files (Aider's weighting is a good starting point). Include dependents' signatures and call sites, not their whole bodies.
5. **Language coverage tradeoff:**
   - tree-sitter: broad and build-free, but syntactic only.
   - SCIP: precise, but about 10 indexers, each needing a build.
   - stack-graphs: 4 languages, archived.
   - ctags: broad definitions, weak references.
   - Ship tree-sitter for about 15 core languages via `@vscode/tree-sitter-wasm` or per-language npm wasm, and degrade to diff-only context elsewhere.

---

## 3. Token budgeting

### 3.1 Estimating input tokens before dispatch

- **Anthropic** `POST /v1/messages/count_tokens`. Source: https://platform.claude.com/docs/en/build-with-claude/token-counting (accessed 2026-11-05) `[vendor]`:
  - Accepts the same body as Messages: system, tools, base64 images and PDFs, thinking.
  - "**free to use**". Rate limits are separate from message creation: Start 5,000 RPM, Build 10,000, Scale 20,000.
  - "The token count is an **estimate**… might differ by a small amount." ZDR- and HIPAA-eligible.
  - Errors on server tools (except advisor), the MCP connector, and URL/file sources.
  - "No, token counting provides an estimate without using caching logic."
  - "Claude 4.7 and later models and Claude Mythos Preview use a newer tokenizer. The same input text produces approximately 30 percent more tokens" than earlier models, so recount per target model.
- **OpenAI** `POST /v1/responses/input_tokens` (SDK `client.responses.inputTokens.count()`, returns `{object: "response.input_tokens", input_tokens}`; `openai` 7.52.0, 2026-11-05) `[vendor]`. Offline: `tiktoken` / `js-tiktoken` 1.0.21–22 (2025-08-09) and `gpt-tokenizer` 4.1.0 (2026-10-18) on npm `[vendor]`.
- **Gemini** `models.countTokens` and the offline experimental `LocalTokenizer` (`@google/genai` 2.32.0) `[vendor]`.
- **OpenRouter has no token-count endpoint.** Its API path list has none (spec 2026-11-05) `[vendor]`. Estimate via the upstream provider's tokenizer or counter, and reconcile with response `usage.cost` / `cost_details` and `GET /generation` `[vendor]`.
- **Local Anthropic tokenizer.** `@anthropic-ai/tokenizer` 0.0.4 (2026-10-07) is a beta `countTokens(text)` whose README does not say which model generation it matches `[vendor]`. Because of the 30% tokenizer shift, use it only as a rough local estimate and calibrate against `count_tokens` `[inference]`.
- **Fixed overheads to add:**
  - Tool-use system prompt per model. Examples: Opus 5.5 / Sonnet 5.5 / Haiku 5.5 add 286 tokens (auto/none); Opus 4.7 adds 675/804; Sonnet 4.6 adds 497/589.
  - Tool definitions and images.
  - Source: https://platform.claude.com/docs/en/about-claude/pricing `[vendor]`.
- **Practice in open-source reviewers** `[code]`:
  - PR-Agent counts with tiktoken by default. When accuracy is needed it calls the provider-native counter through LiteLLM. If only a local estimate is available it inflates by `model_token_count_estimate_factor=0.3`. Content over 9 MB skips the provider counter.
  - Aider samples lines (above).

### 3.2 Estimating output and cost

- **Output tokens cannot be counted beforehand.** Bound them with `max_tokens` (and the advisor's own `max_tokens`) and predict from history: per-stage p50/p95 output tokens per file or per finding, persisted per repo `[inference]`.
- **Reasoning tokens.** Thinking/reasoning tokens bill as output; cap them with effort or thinking settings. OpenRouter forbids setting both `reasoning.effort` and `reasoning.max_tokens` `[vendor]`.
- **Anthropic cost formula** (multipliers from the prompt-caching and pricing pages, accessed 2026-11-05) `[vendor]`. In the formula, `p_in` and `p_out` are the model's per-token input and output prices, and `r` is the cache-read multiplier:
  - `cost = in_uncached·p_in + write_5m·1.25·p_in + write_1h·2·p_in + cache_read·r·p_in + out·p_out`
  - `r` = 0.1 by default, 0.05 on Opus 5.5 / Sonnet 5.5, and 0.025 on Fable 5.1 / Mythos 5.1.
  - Multiply by 1.1 for `inference_geo: "us"` (4.6+ models) and 0.5 for Batch.
  - Fast mode has its own price: Opus 5.5 $8/$40 per MTok.
- **Current prices per MTok** (input / 5m write / 1h write / cache hit / output) `[vendor]`:

  | Model | Input | 5m write | 1h write | Cache hit | Output |
  |---|---|---|---|---|---|
  | Fable 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |
  | Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
  | Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
  | Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
  | Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
  | Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
  | Haiku 5.5 (prompt ≤100k) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
  | Haiku 5.5 (prompt >100k) | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
  | Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

  - Haiku 5.5's threshold counts all input including cache reads: "a request over the threshold pays the higher prices even when part of its prompt is a cache hit".
  - Claude 4.6+ (except Haiku 5.5) have 1M context at standard price.
- **OpenRouter pre-dispatch pricing** `[vendor]`: per-endpoint `pricing` (prompt, completion, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `discount`, conditional `overrides`) from `/models/{author}/{slug}/endpoints` or `/endpoints/zdr`. Cap spend with `provider.max_price`. Reconcile with `usage.cost`.
- **This repo already has** `RunBudget` (`packages/schema/src/run-budget.ts`). It includes a `"predicted"` stop reason and a `CostKind` that "Vectorscope and the run guard share" `[code]`. A pre-dispatch estimate should feed `predicted`.
- **Worked example, Anthropic list prices** `[inference arithmetic]`. A PR review with a 30k-token diff, a 10k-token static reviewer prefix and 50k tokens of per-PR context:
  - **Filter on Haiku 5.5** (30k in, 2k out): $0.003 + $0.001 = **$0.004**.
  - **Reasoning on Opus 5.5:** 10k cached prefix read ($0.002; first write $0.05) + 50k uncached in ($0.20) + 6k out ($0.12) = **about $0.32** warm, **about $0.37** cold.
  - **Formatter on Haiku 5.5** (8k in, 3k out): **about $0.002**.
  - **Total about $0.33.** Running filter and formatter on Opus instead adds about $0.25 (about $0.16 + $0.09).
  - **The dominant cost is strong-model per-PR input and output.** Shrinking context (graph ranking) saves more than any caching trick.

### 3.3 Caching strategies for review prompts

**Anthropic mechanics** (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, accessed 2026-11-05) `[vendor]`:
- **Breakpoints and lookback.** Up to 4 explicit breakpoints; automatic top-level `cache_control` uses one slot. Lookback is 20 positions per breakpoint.
- **Invalidation hierarchy:** `tools → system → messages`. Tool definition changes invalidate everything. `tool_choice` and image changes invalidate messages. Thinking-parameter changes "always invalidate message blocks".
- **Minimum cacheable length:**
  - 512 tokens: Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5, Fable/Mythos.
  - 1,024 tokens: Sonnet 5, Sonnet 4.6/4.5, Opus 4.8.
  - 2,048 tokens: Opus 4.7.
  - 4,096 tokens: Haiku 4.5, Opus 4.5/4.6.
  - Shorter prompts are not cached, and "no error is returned".
- **TTL.** Default 5 min (refreshed free on use); `ttl: "1h"` at 2× write. TTL counts from the request start. 1h entries must precede 5m ones.
- **Parallel requests:** "a cache entry only becomes available after the first response starts."
- **Isolation.** Caches are workspace-isolated (org-isolated on Bedrock and Google-managed Vertex) and never shared across orgs.
- **Cache diagnostics** (https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics; ZDR "qualified"). Send `diagnostics: { previous_message_id }` and the response reports `model_changed | system_changed | tools_changed | messages_changed | previous_message_not_found | unavailable` with `cache_missed_input_tokens`.
- **Pre-warming.** `max_tokens: 0` cache pre-warming exists but is "not supported inside a batch" (batch-processing page) `[vendor]`.

**Batch** (https://platform.claude.com/docs/en/build-with-claude/batch-processing) `[vendor]`:
- 50% off input and output.
- Up to 100,000 requests or 256 MB per batch; "most batches completing within 1 hour", expiring after 24 h; results kept 29 days.
- Docs suggest the 1-hour cache for shared context.
- **Not ZDR-eligible.**

**OpenAI mechanics** (SDK text) `[vendor]`:
- `prompt_cache_key` "to optimize your cache hit rates".
- `prompt_cache_options.mode`: `implicit` (one implicit breakpoint plus up to the latest 3 explicit ones) or `explicit` (up to 4 explicit; none means no caching).
- `ttl` `30m` (default) or `12h` (minimum lifetime); `prewarm: true`. Supported on gpt-5.6+.
- `prompt_cache_retention` `in_memory | 24h` is deprecated.

**Recommended layout for Vectorscope** `[inference]`:
1. **Order the prompt for cache reuse:**
   - tools (fixed order, deterministically serialized schemas);
   - system: reviewer instructions, rubric and output schema, byte-stable with no timestamps or IDs;
   - repo-stable context: repo rules (AGENTS.md / CLAUDE.md), language guides, repo map at the base commit;
   - PR-stable context: PR description, full diff summary, ranked dependents;
   - per-chunk task: the one file or hunk group to review.
   Put breakpoints at the ends of the system, repo and PR layers.
2. **Fan out per file only after the first response has started streaming**, or pre-warm with `max_tokens: 0`. Otherwise N parallel requests each pay a cache write.
3. **Break-even** (`[inference arithmetic]`, relative to base input price):
   - 5m TTL: one write costs 1.25 versus a plain 1.0, and each reuse costs 0.1 versus 1.0, so a **single reuse already wins**.
   - 1h TTL: 2 + 0.1n < 1 + n needs **n ≥ 2 reuses**. Use 1h only for slow pipelines (CI queues, human-paced re-reviews, batches).
4. **Keep the model fixed** for a given prefix: the cache is per model (`model_changed`). Tiered models each keep their own cache, so only the strong tier's prefix is worth heavy caching.
5. **Watch the minimum length.** Small reviewer prompts under 512 (5.5-gen) or 4,096 (Haiku 4.5) tokens silently do not cache.
6. **Through OpenRouter**, send `session_id` per PR for sticky routing, and keep `cache_control` blocks (converted per provider).
7. **Add cache diagnostics in development** to catch silent misses.

### 3.4 Model tiering: cheap filter, strong reasoner, cheap formatter

- **Price spread is large.** Haiku 5.5 input is $0.10 vs Opus 5.5 $4 (40×), and output $0.50 vs $20 (40×) `[vendor]`. Keep Haiku 5.5 filter prompts at or under 100k tokens to avoid its 5× long-prompt price `[inference]`.
- **Under ZDR the strong tier must not be a Covered Model** (Fable/Mythos need 30-day retention) `[vendor]`. Practical ZDR strong tier: Opus 5.5 or Sonnet 5.5 `[inference]`.
- **Server-side tiering: Anthropic advisor tool.** Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool; beta header `advisor-tool-2026-03-01`, tool `{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}` `[vendor]`.
  - A cheaper executor consults a stronger advisor in one request.
  - Advisor tokens bill at advisor rates and are reported under `usage.iterations[]`; top-level `usage` shows executor tokens only.
  - "Sonnet on complex tasks: add an Opus advisor… keeps total cost similar or lower".
  - Advisor `max_tokens` 2048 is the recommended start ("roughly 7x" output reduction, accuracy "within noise" at n=40).
  - Caching "breaks even at roughly three advisor calls".
  - ZDR-eligible. Poor fit for "single-turn Q&A".
  - For Vectorscope's multi-step review, a Sonnet 5.5 executor with an Opus 5.5 advisor is a candidate to A/B against plain Opus `[inference]`.
- **Open-source precedent:** PR-Agent config has `model`, `fallback_models`, `model_weak` ("a weaker model to use for some easier tasks") and `model_reasoning` ("dedicated reasoning model for self-reflection") (`pr_agent/settings/configuration.toml`, 2026-11-05) `[code]`.
- **Research** (models are dated; treat as directional):
  - FrugalGPT (Chen, Zaharia, Zou; arXiv 2305.05176, 2023; TMLR 2024; https://github.com/stanford-futuredata/FrugalGPT) proposes LLM cascades under budget constraints. `[research]` The often-quoted "up to 98% cost reduction while matching GPT-4" is from the abstract as I recall it `[prior-knowledge]`.
  - RouteLLM (Ong et al., arXiv 2406.18665, 2024; README of PyPI `routellm` 0.2.0): trained routers "reduce costs by up to 85% on widely-used benchmarks such as MT Bench while maintaining 95% GPT-4 performance" `[research/vendor-of-own-work]`.
  - Neither study used code review.
- **Formatter tier.** Structured outputs / `strict: true` tools are ZDR "qualified" ("Only the JSON schema is cached, for up to 24 hours") `[vendor]`. A Haiku-tier formatter with a strict schema is cheap. Keep sensitive strings out of schema `enum`/`const` values `[inference]`.
- **Gating.** The filter's job is to (a) drop files that are generated, vendored, lockfiles or pure renames, and (b) score hunks for risk so the strong model sees only top-K files within budget. Calibrate K against a labelled set; do not trust the filter blindly `[inference]`.

---

## 4. Concrete recommendations for Vectorscope

1. **ZDR mode** sends `provider: { zdr: true, data_collection: "deny", require_parameters: true }` and a per-PR `session_id`. Before dispatch, check the chosen model against `/endpoints/zdr`. If the list is empty, refuse locally with "no ZDR endpoint for model X" rather than waiting for a 404. Also tell users to:
   - apply an `enforce_zdr_*` guardrail to the API key;
   - turn off workspace I/O logging and data-discount logging;
   - understand the Safety Retention carve-out for Google and others.
2. **Direct-provider ZDR.**
   - Anthropic: ZDR covers Messages, caching, token counting, thinking, the advisor tool and structured outputs (qualified). It excludes Batch, Files, code execution, and Fable/Mythos.
   - OpenAI: set `store: false` and use `reasoning.encrypted_content` for stateless reasoning.
   - Never use Batch in ZDR mode.
3. **Graph:** web-tree-sitter (bump to 0.27.x and fix the wasm specifier), grammars from `@vscode/tree-sitter-wasm` or per-language npm wasm (avoid `tree-sitter-wasms`), a blob-SHA fact cache, a reverse import graph, import-gated symbol matching, PageRank ranking, and optional SCIP.
4. **Budget:** count input with provider counters (free on Anthropic) or calibrated local tokenizers. Predict output from history. Feed `RunBudget.predicted`. Price with per-endpoint OpenRouter pricing or provider tables including cache multipliers. Reconcile with `usage.cost`.
5. **Caching:** use a byte-stable layered prefix with breakpoints at the system, repo and PR layers. Fan out after the first token or pre-warm. 5m TTL by default, 1h only for slow pipelines. Diagnostics on in development.
6. **Tiering:** Haiku 5.5 filter, then Opus 5.5 (or Sonnet 5.5 with an Opus advisor) reviewer, then a Haiku 5.5 strict-schema formatter. Measure precision and recall on a labelled PR set before switching defaults.

## 5. Open questions / to verify once hosts are allowed

- openrouter.ai/docs/features/zdr prose: exact ZDR definition, caching wording, and the exact error body for `zdr: true` with no endpoint.
- OpenAI your-data page: current ZDR endpoint table, and whether 24h/12h extended caching is ZDR-eligible.
- Gemini API and Vertex ZDR terms as of 2026 (abuse-log retention, in-memory caching default, context caching under ZDR).
- Anthropic's default commercial retention now (7 vs 30 days; "not retained by default" wording).
- Whether `@openrouter/ai-sdk-provider` 2.9.0 (pinned here) types `zdr`.
- Native `tree-sitter` Node bindings versus wasm throughput in Bun (README says wasm is "considerably slower"; not measured here).
