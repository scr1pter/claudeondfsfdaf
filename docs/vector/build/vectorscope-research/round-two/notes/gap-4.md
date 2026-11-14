# G4: primary ZDR terms for VectorScope's routes (round two)

Accessed 2026-11-06. Every claim below is labelled **vendor** (the company's own published text, including its API specs and SDK type text), **code** (read in VectorScope's source at `/home/user/wt/vectorscope`, HEAD `0f772e6e`, 2026-11-06), or **inference** (my reading, marked as such). No independent, academic or community evidence was reachable on this angle (see "Unreachable").

## 0. How this was done, and what the network allowed

The session's network allowlist blocked most primary docs hosts, so the brief's fallbacks were used:

- **Blocked (proxy CONNECT 403 or DNS refusal):** developers.openai.com, platform.openai.com, openrouter.ai (docs, llms.txt, API, blog), web.archive.org, docs.cloud.google.com / cloud.google.com docs, ai.google.dev, learn.microsoft.com, docs.aws.amazon.com, together.ai, docs.together.ai. **No web.archive.org snapshot could be fetched, so no snapshot dates are recorded.** The shared WebSearch budget for this turn was already used up, so no third-party write-ups were found either.
- **Reachable, and used instead:** raw.githubusercontent.com and github.com pages; the npm and PyPI registries (vendor SDKs and API models); Google's API discovery endpoints (`aiplatform.googleapis.com/$discovery`, `generativelanguage.googleapis.com/$discovery`); platform.claude.com.
- **The most useful substitute** is the OpenRouter docs source mirror. **github.com/OpenRouterTeam/docs** (`main`, `.source-commit` 3b6eafa47dd418c2ff0b45b7786eeffbb5752e95, updated 2026-11-06) is, per its README, the public mirror that Mintlify builds openrouter.ai/docs from. Pages render only with `publish: true`, and the pages read here carry that flag. So for OpenRouter this round read the published prose, not SDK types (vendor).
- **Mirrors that do not exist:**
  - MicrosoftDocs/azure-ai-docs returns 404 on raw and on github.com and is not listed in the MicrosoftDocs organization. It now appears to be private or removed.
  - awsdocs/amazon-bedrock-user-guide returns 404.
  - No Together AI docs repository exists in the first 30 of the togethercomputer organization's 107 repositories, and none of the guessed names resolved.

## 1. OpenRouter: published ZDR prose (fills VOI2)

Source: `guides/features/zdr.mdx` in OpenRouterTeam/docs (live path openrouter.ai/docs/guides/features/zdr), accessed 2026-11-06, vendor.

### 1.1 Safety Retention is broader than round one said (corrects enablers §1.2)

Round one, quoting the SDK's endpoint flag, described Safety Retention as "the provider may retain prompts its safety classifiers flag". The published page defines three data-policy tiers:

| Tier | Vendor wording |
|---|---|
| ZDR | "No routine storage after processing" |
| Safety Retention | "OpenRouter or a provider may retain prompts and responses from **any request, whether flagged or not**, only to detect, investigate, and prevent abuse." Also: "Safety Retention limits why data can be kept. It does not require a request to be flagged before it can be stored." |
| Retention and Training | "Data may be stored and used for training under the applicable provider policy." |

The guardrail field descriptions in OpenRouter's OpenAPI spec now say the same: "may retain prompts and responses from any request, only to prevent abuse" (`openapi/openapi.yaml`, `allow_safety_retention_google` and `allow_safety_retention_other`; vendor).

The defaults matter for VS-23:
- "If you haven't chosen, **self-serve accounts allow Safety Retention** and enterprise accounts use ZDR only" (vendor).
- `zdr: true` on a request "follows the same account and guardrail choice" (vendor).

So on a self-serve account that never touched the setting, `provider.zdr: true` can land on an endpoint that may keep every prompt. VS-23's requirement that the owner attest "safety retention disallowed" before `openrouter` goes in `zdrAttested` is therefore load-bearing, not belt-and-braces.

### 1.2 Google on Vertex now requires Safety Retention (new)

"Starting October 18, 2026, Google requires Safety Retention for Google models served through Vertex. With Safety Retention, Google doesn't retain prompts by default, but it may retain prompts that its safety classifiers flag, for up to 90 days, for abuse monitoring … These endpoints don't meet a strict Zero Data Retention requirement" (vendor). Under **ZDR only**, "Most Google models become unavailable."

The documented escape is your own key: "If your own Google Cloud agreement includes zero data retention, you can use Vertex through your own key with ZDR only. Declare ZDR on your BYOK key" (vendor).

Two notes on this:
- The Google-specific paragraph says "flagged … up to 90 days". The tier definition says Safety Retention may cover any request. The two texts differ in strength; the safe reading is the tier definition (inference).
- Implication: a strict VectorScope ZDR policy (VS-23 attestation of "safety retention disallowed") removes nearly all Gemini models from the OpenRouter route. That is a route-audit fact for the D6 candidates, not a bug.

### 1.3 Per-model-group ZDR moves Claude to Bedrock/Vertex and GPT to Azure (new)

The five model groups, with the effect of enforcing ZDR on each (vendor):

| Group | Effect |
|---|---|
| Anthropic | "Removes first-party Anthropic endpoints (Bedrock and Vertex remain available)" |
| OpenAI | "Removes first-party OpenAI endpoints (Azure remains available)" |
| Google | "Removes AI Studio endpoints. Vertex endpoints that use Safety Retention remain available only if Safety Retention is allowed" |
| SpaceXAI | non-ZDR endpoints removed |
| All other models | non-ZDR endpoints removed |

Inference: an OpenRouter ZDR request for a Claude model is served by AWS Bedrock or Google Vertex, and one for a GPT model by Azure, never by the model lab directly. Under Anthropic's own terms (§5), on Bedrock and Google-managed Vertex "the cloud provider is the data processor". So a VectorScope "ZDR via OpenRouter" review of a Claude model rests on Amazon's or Google's terms plus OpenRouter's agreements, not Anthropic's ZDR. This also changes cache behaviour (§4.3, §6.2) and model availability.

### 1.4 Request, account and guardrail precedence (extends)

- "The request-level `zdr` parameter operates as an 'OR' with your account-wide and guardrail ZDR settings … can only be used to ensure ZDR is enabled for a specific request, not to override or disable" account or guardrail enforcement (vendor).
- Guardrails combine with "OR logic per model group" for ZDR. For Safety Retention the "most restrictive wins per model group" (`guides/features/guardrails.mdx`, vendor).
- "If OpenRouter is not able to establish or ascertain a clear policy for a provider or endpoint, we take a conservative stance and assume that the endpoint both retains and trains" (vendor).

### 1.5 In-memory caching is explicitly not retention (confirms round one's inference)

"OpenRouter has taken the stance that in-memory caching of prompts is *not* considered 'retaining' data, and we therefore allow endpoints/models with implicit caching to be hit when a ZDR routing policy is in effect" (vendor). Round one inferred this from `supports_implicit_caching` on `PublicZdrEndpoint`; it is now a published position.

The word "in-memory" matters:
- OpenRouter says nothing about providers whose caches are backed by durable storage. OpenAI's extended caching (§3.2) and Vertex's `DURABLE` implicit-cache retention (§4.1) are both of that kind.
- Whether OpenRouter's ZDR classification of such endpoints accounts for durable caching is unverified.

### 1.6 BYOK and private-endpoint declarations (extends)

From `guides/overview/auth/byok.mdx` (vendor):
- A key's **Provider agreement → Zero data retention** setting has three values: OpenRouter's default (`declared_zdr: null`), "My account has ZDR" (`true`), and "My account does not have ZDR" (`false`).
- "The declaration is your statement about your own provider agreement. OpenRouter does not check it."
- "A ZDR declaration also covers Safety Retention … Declare ZDR only if your own provider agreement excludes the provider's safety retention."
- A Fallback key that declares ZDR "ranks behind the ZDR endpoints of other providers". With `allow_fallbacks: false`, OpenRouter "uses only the endpoint that led the pool before your key was added, which can be another provider's ZDR endpoint." So a declared BYOK key does not pin traffic to your own account.

For private endpoints, "Not declared" is treated as retaining, and "An explicit OpenRouter data-policy override set by our team remains authoritative over your declaration" (vendor). The 2026-10-29 changelog adds `prompt_retention_days` to `PrivateProvider` (`changelog.mdx`, vendor).

Implication: for VS-23's `zdrAttested: ["openrouter"]`, the owner's attestation must also cover every BYOK key with `declared_zdr: true` on the account. Such a key turns any endpoint into "ZDR", on the owner's word alone.

### 1.7 Plugins and server tools are outside ZDR (new, VS-23 gap)

From the ZDR page: "ZDR enforcement only applies to provider routing for inference requests. It does not apply to plugins and tools you choose to enable, such as web search" (vendor).

`guides/features/server-tools.mdx`, "Privacy and regional availability" (vendor), gives a per-tool matrix:

| Server tool | ZDR position |
|---|---|
| Web Search and Web Fetch (Exa, Parallel, Perplexity, Firecrawl or native) | Firecrawl is rejected when ZDR is enforced; the others "apply their own retention policies" |
| Bash (sandboxed), Shell | "ZDR enforcement does not apply to sandbox contents" |
| Files | "ZDR enforcement does not apply to stored files" |
| Advisor and Subagent | Inner generations receive the request's `provider` preferences, including `zdr` |
| Fusion and Image Generation | Inner generations run under your API key, so only account and guardrail ZDR apply. "Request-level `provider` preferences are not forwarded." |

Server tools are declared in the `tools` array with a `type` prefix `openrouter:*` (for example `{"type": "openrouter:web_search"}`), not in `plugins`.

Implication (inference): VS-23a's `zdrRequestBody` refuses bodies with `plugins` or routing fields, but a body carrying a `tools[].type` that starts with `openrouter:` passes those checks. Two concrete leaks follow:
- An `openrouter:fusion` call would ignore the request-level `zdr: true` that VectorScope injects. Only account settings would protect it.
- `openrouter:bash` and Files store content outside ZDR.

**Add a refusal**, for example `server-tool`, for any `openrouter:`-typed tool, with a test. Also refuse an OpenRouter Files reference.

### 1.8 OpenRouter's own retention, beyond the upstream provider (new)

- **CSAM screening.** Planned from 2026-10-27, "OpenRouter will screen all inference requests, including ZDR traffic, for child sexual abuse material (CSAM) in flight. Content flagged as potential CSAM may be retained for human review, reporting, and preservation where required by law" (`zdr.mdx` and `privacy/data-collection.mdx`, vendor). This is a residual of the same class as Anthropic's flagged-chat override.
- **Anonymous input categorization.** "OpenRouter samples a small number of prompts for categorization … If you are not opted in … any categorization of your prompts is stored completely anonymously … The categorization is done by model with a zero-data-retention policy" (`privacy/data-collection.mdx`, vendor). Whether this sampling applies to ZDR-enforced traffic is not stated, so prompt text may be sent to a second (ZDR) model (inference). Add it to the "what still remains" list.
- **Private Input & Output Logging.** "Retention: Data is retained for a minimum of 3 months, and may be retained beyond 3 months at OpenRouter's discretion unless you request deletion" (`input-output-logging.mdx`, vendor). This quantifies the risk behind round one's "workspace logging cannot be checked from the client".
- **Regional hosts skip I/O logging.** "Input & Output Logging does **not** apply to requests routed through `eu.openrouter.ai` or `us.openrouter.ai` … input/output logging will be skipped" (vendor; Business and Enterprise plans only, per `provider-logging.mdx`). Inference: for an account on those plans, sending ZDR reviews to a regional host closes the I/O-logging part of the gap without trusting a workspace flag. The page does not say whether the separate "OpenRouter use of inputs/outputs" discount logging is also skipped.

### 1.9 Response caching stores responses on OpenRouter (new)

`guides/features/response-caching.mdx` (vendor):
- `X-OpenRouter-Cache: true`, or a preset with `cache_enabled`, stores the full response keyed on API key, model, endpoint, streaming mode and body.
- TTL is 1–86400 s (default 300).
- "If neither header nor preset is set, caching is off."
- `X-OpenRouter-Cache: false` "disables caching even if the preset enables it", but cannot override a preset's explicit `cache_enabled: false`.

The ZDR page does not mention response caching.

Implication (inference): this is retention on OpenRouter of up to 24 hours. VS-23 already refuses presets. VS-23c's transport backstop should also refuse (or strip) `X-OpenRouter-Cache: true` and may send `X-OpenRouter-Cache: false` under `zdr`.

### 1.10 Sticky routing and caching (context)

From `guides/best-practices/prompt-caching.mdx` (vendor):
- Sticky routing keys on `session_id`, then the `x-session-id` header, then `prompt_cache_key`; failing those, on a hash of the first system and first non-system message.
- Sessions expire after 10 minutes idle. "If the sticky provider becomes unavailable, OpenRouter automatically falls back to the next-best provider".
- Sticky routing is not used with `provider.order`.

Inference: under ZDR that fallback stays inside the ZDR-eligible pool, so it is a cache-cost concern, not a privacy concern. VectorScope already sends `x-session-id` (`provider.ts:2330-2341`, per the build contract).

### 1.11 The no-endpoint error (fills VOI2's 404 question)

OpenRouter's published docs do **not** document the string "No endpoints found matching your data policy". The repo's own comment documents that 404 (`packages/core/src/free-models.ts:429`, code). What the docs do say (vendor):
- `api_reference/errors-and-debugging.mdx`: "**503**: There is no available model provider that meets your routing requirements". 503s may carry `Retry-After`, and "The OpenAI SDK, Anthropic SDK, Vercel AI SDK, and OpenRouter SDK already respect this header for backoff".
- The same page's typed `error_type` table gives 503 as `provider_overloaded` and 404 as `not_found` ("The requested resource (model, file, etc.) does not exist").
- `guides/routing/provider-selection.mdx`: when account-wide allowed providers and the request's `only` list leave nothing, "the request fails with a 404".
- `byok.mdx`: "If no other ZDR endpoint remains, the request fails with a ZDR error".
- OpenRouter's OpenAPI (`openapi/openapi.yaml`) gives only generic examples for `/chat/completions`, `/responses` and `/messages`: 404 "Resource not found" and 503 "Service temporarily unavailable".

So the exact body of a `zdr: true` refusal is still unverified. The docs point to either a 404 or a 503. A fixed-string 404 classifier would miss the 503 case, and the generic 503 also means "overloaded".

Implication (inference):
- Privacy should not depend on this classification. A retry of the identical body re-sends the same `provider.zdr: true`, so it cannot leak. Only a switch to another model or route without the ZDR body could leak, and VS-23b already refuses that in `admit`.
- Use the classifier only to write a better note ("no ZDR endpoint for this model and policy"). Match a 404 or 503 whose message contains "No endpoints found", or "ZDR" or "data policy" case-insensitively, and never treat either as a cue to change model.
- Don't add a `404-classification` refusal reason.

## 2. OpenRouter guardrail and endpoint fields (confirms round one)

The OpenAPI spec in the docs mirror matches round one's SDK reading:
- `enforce_zdr_anthropic`, `enforce_zdr_openai`, `enforce_zdr_google`, `enforce_zdr_xai` and `enforce_zdr_other`, with the legacy `enforce_zdr` deprecated;
- `declared_zdr` described as "Self-declared and not verified by OpenRouter";
- `GET /endpoints/zdr` (vendor).

`@openrouter/sdk` is now 1.5.60. Its error classes (`notfoundresponseerror`, `serviceunavailableresponseerror`) carry no data-policy message strings (vendor).

## 3. OpenAI direct (fills part of VOI8)

developers.openai.com stayed unreachable, and no snapshot was available. Two vendor substitutes were read:
- OpenAI's published OpenAPI spec, `openai/openai-openapi` `master`, `openapi.yaml`, spec version 2.3.0, accessed 2026-11-06;
- the OpenAI Cookbook notebook "Prompt Caching 201" (`examples/Prompt_Caching_201.ipynb`; registry date 2026-02-18, marked `archived: true`).

### 3.1 Retention is now an API-visible setting, per organization and per project (new)

- `GET/POST /organization/data_retention` (admin key) returns `{"object": "organization.data_retention", "type": ...}`. `type` is one of `zero_data_retention`, `modified_abuse_monitoring`, `enhanced_zero_data_retention` or `enhanced_modified_abuse_monitoring` (vendor).
- The project-level `ProjectDataRetention` also allows `organization_default` and `none` (vendor).
- A 400 is returned when "The requested data retention setting or transition is invalid" (vendor).

Inference:
- A single project can be set to `none` inside a ZDR organization. Since OpenAI API keys are project-scoped, a VectorScope attestation for `openai` should name the project, not just the organization.
- An owner holding an admin key can check the setting rather than attest it.
- What the `enhanced_*` variants add is not described in the spec (unverified).

### 3.2 Extended prompt caching (answers part of the round-one question)

- The spec, on the deprecated `prompt_cache_retention`, says: "Set to `24h` to enable extended prompt caching … This field expresses a maximum retention policy, while `prompt_cache_options.ttl` expresses a minimum cache lifetime … For `gpt-5.5`, `gpt-5.5-pro`, and future models, only `24h` is supported. For older models … Organizations without ZDR enabled default to `24h`. Organizations with ZDR enabled default to `in_memory`" (vendor).
- `PromptCacheOptionsParam.ttl` is "The minimum lifetime … Defaults to `30m` … **The backend may retain cache entries for longer**". Breakpoints accept `30m` or `12h` (vendor).
- The Cookbook, in a section titled "Extended Prompt Caching & Zero Data Retention": "Extended Prompt Caching works by offloading the key/value tensors to GPU-local storage when memory is full … Only the key/value tensors may be persisted in local storage; all original input content is only retained in memory" (vendor, archived notebook).

Neither text says outright whether extended caching is ZDR-eligible. OpenAI's own framing is that only KV tensors, not raw input, reach local storage. Its defaults treat `in_memory` as the ZDR default where both exist.

Implication (inference): an `extended-cache-unattested` refusal would refuse every gpt-5.5-and-later OpenAI route under `zdr`, since `in_memory` is not supported there. A better rule:
- on older models, send `prompt_cache_retention: "in_memory"` (the maximum) under `zdr`;
- on gpt-5.5+, allow the route only when the owner's OpenAI attestation explicitly covers extended caching (a sub-flag of the attestation, not a separate refusal reason);
- record in the route note that KV tensors may sit on GPU-local storage for up to 24 h.

VectorScope's only explicit breakpoint path sends `ttl: "30m"` to `gpt-6.1-sol` on `api.openai.com` (`packages/engine/src/provider/transform.ts:53-126`, code), and per the spec that is a minimum, not a cap.

### 3.3 `store` and safety alerts

- Responses `store` "Defaults to true … stored for at least 30 days, subject to the data retention exceptions" (vendor; same as round one).
- The spec documents a `/safety/alerts/{id}` resource and a `safety.alert.created` webhook. `SafetyAlertErrorType` includes `potentially_unintended_data_transfer`, `potentially_unintended_data_access` and `potentially_unintended_destructive_activity`.
- The alert's `reason` is "null for zero data retention requests", and `detailed_explanation` is "temporarily available for eligible zero data retention alerts" (vendor).

Inference: OpenAI runs agentic-safety classification on ZDR traffic and keeps something about flagged ZDR requests at least transiently. This is another residual, like the providers' safety holds.

### 3.4 VectorScope code facts (code)

- `ProviderTransform.options` sets `store = false` for `providerID === "openai"`, `@ai-sdk/openai`, `@ai-sdk/github-copilot` and `@ai-sdk/amazon-bedrock/mantle`, and for `@ai-sdk/azure` (with `promptCacheKey = sessionID`) (`packages/engine/src/provider/transform.ts:1249-1262`).
- `smallOptions` (titles, summaries) sets `store: false` only for openai, `@ai-sdk/openai` and copilot. It does **not** do so for `@ai-sdk/azure` or Bedrock Mantle (`transform.ts:1415-1430`).
- The pinned `@ai-sdk/openai` 3.0.67 Responses model defaults `store` to `true` when unset (`dist/index.mjs:4975`). `@ai-sdk/azure` builds on it.

Implication: a small helper request on Azure or Mantle may go out with `store: true`. VS-23c item 5 (no helper requests for `vectorscope.*` sessions under `zdr`) covers it only if that suppression is complete. Add a test asserting `store: false` on every OpenAI-family request kind, Azure and Mantle included.

## 4. Google: Vertex and the Gemini API (fills part of VOI10)

The Vertex ZDR and abuse-monitoring pages and the Gemini API terms stayed unreachable. Google's machine-readable API discovery documents were reachable:
- `aiplatform` v1 and v1beta1, revision 20261027;
- `generativelanguage` v1beta, revision 20261105;
- plus `google-cloud-aiplatform` 2.7.0 on PyPI (2026-10-28) and `@google/genai` 3.0.0 on npm.

### 4.1 Vertex implicit caching defaults to durable storage (new, corrects round one)

Round one carried "disable Vertex's default in-memory data caching (up to 24h per project)" from prior knowledge. The current API (vendor) says:

- `projects.getCacheConfig` and `projects.updateCacheConfig` act on `projects/{project}/cacheConfig`, "a singleton resource".
- `disableCache`: "If set to true, disables GenAI caching. Otherwise caching is enabled."
- `retentionConfig.retentionType` takes these values:

| Value | Description |
|---|---|
| `EPHEMERAL` | "Restricts implicit caching to ephemeral, volatile-memory-backed retention only." |
| `DURABLE` | "Allows implicit caching to use long-lived, durable-storage-backed retention." |
| `RETENTION_TYPE_UNSPECIFIED` | "Treated the same as `DURABLE`." On `GetCacheConfig`, "a project that has stated no preference reports `DURABLE`." |

Implication (inference): an untouched Vertex project's implicit cache may sit in durable storage. VS-23's attestation for `google-vertex` and `google-vertex-anthropic` should state `disableCache: true` or `retentionType: EPHEMERAL`. An owner can read this with `getCacheConfig` using the same project credentials VectorScope already holds, so it is checkable, not just attestable. Whether Google's ZDR terms count `EPHEMERAL` as compliant, or require `disableCache`, is unverified. The cautious rule is `disableCache: true` until the ZDR page is read.

### 4.2 Grounding and other tools on Vertex (supports a refusal, retention terms unread)

`GoogleCloudAiplatformV1Tool` lists `googleSearch`, `googleSearchRetrieval`, `googleMaps`, `urlContext`, `enterpriseWebSearch` ("powered by Vertex AI Search and Sec4 compliance"), `parallelAiSearch`, `exaAiSearch`, `retrieval`, `codeExecution` and `computerUse`, besides `functionDeclarations` (vendor).

`parallelAiSearch.enableZeroDataRetention`: "Instructs Vertex Grounding to use Parallel's Zero Data Retention Marketplace product. If this value is 'false' or omitted, the Parallel Web Search for Grounding standard subscription will be used" (vendor). That is Google's own admission that grounding backends differ in retention and default to non-ZDR.

The discovery document carries no retention durations for Google Search or Maps grounding.

Implication: under `zdr`, refuse any non-function tool on Vertex and Gemini routes. The tool surface supports a `grounding` refusal reason, but round one's "~30 days for Google Search grounding" figure stays unverified.

### 4.3 Publisher-model data sharing and the Claude retention opt-in on Vertex (new)

`PublisherModelConfig` in v1beta1 (vendor) has three relevant fields:
- `dataSharingEnabledProvider`: "For publisher models that are configured to require data sharing, a prediction request is only allowed when the model's publisher matches this provider. Otherwise, the request is rejected."
- `claudeFeatureConfig.advancedAiEnabled`: "whether the customer has enabled advanced AI features for this publisher model (data retention opt-in)". It replaces `cyberVerificationProgramEnabled`.
- `loggingConfig` and `inferenceEventLoggingConfig`: request/response logging to BigQuery, and per-request metadata to Cloud Logging.

These are read with `fetchPublisherModelConfig`.

Inference: this is the Vertex mechanism behind Anthropic's statement that on Google Cloud's platform the 30-day retention for Covered Models (Fable, Mythos) "stays within your cloud provider's environment" (§5). VS-23's `retention-required-model` refusal for Fable and Mythos should therefore apply on `google-vertex-anthropic` too, not only on Anthropic direct. Customer-side request/response logging is the owner's own storage. It is not a third-party leak, but a ZDR claim should note it.

### 4.4 Gemini Developer API: a per-request `store` flag (new)

`GenerateContentRequest.store`: "Configures the logging behavior for a given request. If set, it takes precedence over the project-level logging config" (generativelanguage v1beta, vendor). `@google/genai` 3.0.0 adds: "This field is not supported in Gemini Enterprise Agent Platform" (that is, Vertex).

The Interactions API also has `store` ("Whether to store the response and request for later retrieval"), with no default stated (vendor).

Implication: on the `@ai-sdk/google` route, send `store: false` under `zdr` when the SDK can express it, or add it in the transport. The Gemini API terms (paid-tier abuse logging, which round one recalled as 55 days) remain unread, so the Gemini API should stay `unattested-provider` by default.

## 5. Anthropic on clouds, and who the processor is (extends VOI7)

Source: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention, accessed 2026-11-06, vendor.

- **Where Anthropic is the processor:** the page covers "the Claude API (api.anthropic.com), Claude Platform on AWS, Claude Models on Google Cloud (Anthropic managed), and Claude in Microsoft Foundry, where Anthropic is the data processor."
- **Where the cloud is the processor:** "On Claude Models on Google Cloud (Google managed) and Amazon Bedrock, the cloud provider is the data processor."
- **ZDR on request:** "Claude Platform on AWS follows the same data retention policy as the first-party Claude API. ZDR is available on request". The same holds for Anthropic-managed Google Cloud.
- **Foundry:** Claude in Microsoft Foundry is named only as an Anthropic-processed and HIPAA-eligible service. It is **not** listed under "What ZDR covers". So ZDR availability for Claude on Foundry is not stated (inference from absence).
- **Covered Models:** "The 30-day data retention requirement applies wherever Covered Models are offered … On Amazon Bedrock and Google Cloud's Agent Platform, retained data stays within your cloud provider's environment."

Implication: VS-23's route table needs the npm or provider id plus the platform operator, not the model family alone:
- "Claude on Bedrock" falls under AWS terms (§6);
- "Claude Platform on AWS" falls under Anthropic's terms;
- Vertex-hosted Claude is either, depending on "Anthropic managed" or "Google managed".

VectorScope supports `@ai-sdk/amazon-bedrock`, `@ai-sdk/amazon-bedrock/mantle`, `@ai-sdk/azure`, `@ai-sdk/google-vertex`, `@ai-sdk/google-vertex/anthropic` and `@ai-sdk/togetherai` (`packages/engine/src/provider/provider.ts:386-404`, code).

## 6. AWS Bedrock (new)

The docs site was unreachable. AWS's published API model was read from botocore 1.43.125 on PyPI (2026-11-05), `botocore/data/bedrock/2023-04-20/service-2.json`, plus its CHANGELOG (vendor).

### 6.1 Account-level data retention mode

- **Operations:** `GetAccountDataRetention` (GET `/data-retention`) and `PutAccountDataRetention` (PUT): "Returns/Sets the account-wide data retention mode for Amazon Bedrock." The response carries `mode` and `updatedAt`.
- **`DataRetentionMode` values:**

| Mode | Description |
|---|---|
| `default` | "The standard data handling for the model applies." |
| `none` | "Zero data retention." |
| `aws_review` | "Amazon Web Services may review the request data. The data is not shared with the model provider. A model must support this mode to be invoked under it." |
| `provider_data_share` | "Data may be shared with the model provider." |
| `inherit` | "No data retention mode is set at this scope." |

- **When:** botocore 1.43.26 (2026-06-09) "Adds support for the Amazon Bedrock account-level data retention APIs". 1.43.89 (2026-09-04) adds "New AWS REVIEW mode".

Inference:
- `default` is model-dependent. It is the mode under which a model requiring review or provider sharing can run. So "Bedrock does not retain" (the common 2024-25 reading) is no longer a safe default assumption.
- `inherit` implies scopes narrower than the account that the public API does not yet expose. An account-level `none` could in principle be overridden elsewhere (unverified).
- VectorScope can **check** this rather than trust an attestation: `GetAccountDataRetention` uses the same AWS credentials as inference, if IAM allows `bedrock:GetAccountDataRetention`. A Bedrock route under `zdr` should require `mode === "none"`, read once per review (or attested when the call is not permitted), and fail closed otherwise. This is the only provider in scope where a client-side check is that cheap.

### 6.2 Bedrock caching

`CachePointBlock.ttl` is `CacheTTL` = `5m` | `1h`, "Time-to-live duration for ephemeral cache entries" (bedrock-runtime, vendor). Whether Bedrock's ZDR mode covers cache points is unread (inference: "ephemeral" suggests memory-backed, unverified).

Model invocation logging (`PutModelInvocationLoggingConfiguration`, with `textDataDeliveryEnabled` to CloudWatch or S3) is customer-side storage (vendor). A ZDR note should mention it.

## 7. Azure OpenAI and Microsoft Foundry (not filled)

- The Azure "data, privacy and security" and "modified abuse monitoring" pages could not be read anywhere: no mirror repo, and learn.microsoft.com is blocked.
- The Microsoft Foundry data-plane spec (`Azure/azure-rest-api-specs`, `specification/ai-foundry/data-plane/Foundry/openapi3/v1/microsoft-foundry-openapi3.yaml`, accessed 2026-11-06) mirrors OpenAI's `prompt_cache_retention` (`in_memory`/`24h`, deprecated), `prompt_cache_options` (TTL `30m`) and a `/openai/v1/responses/compact` operation "suitable for long-running and zero-data-retention scenarios" (vendor). It has no retention prose.
- OpenRouter treats at least some Azure endpoints as ZDR-eligible (§1.3, vendor).

Azure's own abuse-monitoring retention and its approval process stay unverified. Keep `azure` as `unattested-provider` unless the owner attests it.

## 8. Together AI (not filled)

- together.ai and docs.together.ai were unreachable, and no docs mirror was found.
- The `together-ai` npm package 1.0.0 contains no retention, ZDR or privacy text (vendor, absence).
- togethercomputer/skills has no privacy content.

GU20 (Greptile routes through Together) therefore cannot be connected to Together's actual retention terms in this round. Keep `togetherai` as `unattested-provider`.

## 9. What this changes in VS-23 (summary, inference unless marked)

1. **Add refusals:**
   - `server-tool`: any `tools[].type` starting `openrouter:` (Fusion ignores request-level `zdr`; bash, shell and files are outside ZDR);
   - OpenRouter Files references;
   - `X-OpenRouter-Cache: true`;
   - on Vertex and Gemini, any non-function tool (grounding, code execution, URL context, retrieval).
2. **Make attestations specific, and checkable where cheap:**
   - OpenRouter: ZDR per model group, **ZDR only** for both Safety Retention groups (self-serve defaults to allow), I/O and discount logging off, and every BYOK key's `declared_zdr` reviewed;
   - OpenAI: the project, not only the organization (project `none` exists), plus an explicit extended-caching sub-flag for gpt-5.5+;
   - Vertex: `disableCache: true` (or `EPHEMERAL`, once Google's terms are read), checkable with `getCacheConfig`; no data-sharing publisher models;
   - Bedrock: `GetAccountDataRetention().mode === "none"`, checked live.
3. **Make the route key operator-aware:** Claude on Bedrock, Claude Platform on AWS, Anthropic-managed and Google-managed Vertex, and Claude on Foundry are different processors. Keep the Fable/Mythos `retention-required-model` refusal on every platform.
4. **Don't treat 404 classification as a privacy control.** Identical retries carry the same policy; only model or route switches matter, and those are refused in `admit`. Match both 404 and 503 "no endpoint" shapes for the note.
5. **Residuals to list in the user-facing note:**
   - OpenRouter CSAM screening (from 2026-10-27) and its sampling for anonymous categorization;
   - Google's 90-day flagged retention on Vertex Google models;
   - OpenAI's safety alerts on ZDR traffic;
   - Anthropic's 2-year flagged override and legal holds (round one);
   - customer-side logging on Bedrock and Vertex.

## Unreachable (this round)

- developers.openai.com/api/docs/guides/your-data and platform.openai.com/docs/guides/prompt-caching (proxy 403); web.archive.org (proxy 403), so no snapshots.
- openrouter.ai/docs/llms.txt, /llms-full.txt, /docs/features/zdr live page, /api/v1/endpoints/zdr, /api/frontend/v1/all-providers, and the CSAM blog post (blocked). The docs prose was read via the GitHub mirror instead.
- docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention, the abuse-monitoring page, and ai.google.dev/gemini-api/terms (blocked; google/generative-ai-docs is deprecated and has no terms page).
- learn.microsoft.com Azure OpenAI data-privacy and modified-abuse-monitoring pages; the MicrosoftDocs/azure-ai-docs repository (404, not listed in the organization).
- docs.aws.amazon.com Bedrock data-protection page; awsdocs/amazon-bedrock-user-guide (404).
- together.ai privacy and enterprise pages, docs.together.ai (blocked); no Together docs repository found.
- WebSearch (the shared per-turn budget was exhausted), so no third-party write-ups or podcasts. The GitHub REST API via gh was not enabled for these repositories.