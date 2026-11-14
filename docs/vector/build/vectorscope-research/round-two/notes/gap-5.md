
# G5: Greptile's ZDR and data handling (round two)

Research date: 2026-11-06. Lane: round one §7 gap "Greptile's own ZDR and data-handling scope is unverified".

## 0. Read this first: what this lane could and could not reach

- **The main gap is still open.** The pages that would close it could not be opened: greptile.com /security, /security/subprocessors, /security/privacy, /privacy, /terms-of-service, the docs and any llms.txt, plus trust.greptile.com, Vanta and Drata trust hosts, web.archive.org and archive.ph, the OpenAI and Together AI case studies, and OpenAI's and Together's data-control docs.
  - WebFetch returned `ENOTFOUND` (outside the session allowlist) for www.greptile.com, openai.com and www.together.ai.
  - WebFetch refused web.archive.org at the tool level.
  - curl through the egress proxy got `403` on CONNECT for every one of these hosts.
- **WebSearch was not available to this lane at all.** The first query returned "this turn's web search budget is used up (limit: 200 WebSearch calls per turn, shared by every agent in it)". Step 5 of the task (Hacker News, Reddit and X security reviews or procurement write-ups) therefore could not be done. **There are no community findings in this lane.** That is a gap, not evidence that no such write-ups exist.
- **What could be reached, and what this lane added:**
  1. Greptile's own public GitHub repositories, cloned read-only into the scratchpad: `greptileai/akupara` @`09b7db2` (2026-11-04), `greptileai/skills` @`59e79ec` (2026-11-03), `greptileai/claude-plugin` @`3538cf0` (2026-10-27) and `greptileai/cli` @`7ecf571` (2026-05-21).
  2. The published npm package `greptile@3.8.0` (2026-10-26), Greptile's own CLI.
  3. Anthropic's customer story about Greptile (claude.com, read in full).
  4. Anthropic's current "API and data retention" page (platform.claude.com, read in full as Markdown).
- **Labels:** **vendor** = the company's own claim (including Greptile's own README prose and app-store declarations); **code** = read in source, config or a commit; **independent** = third-party measurement; **community** = user reports (none this round); **inference** = my reasoning, flagged as such. Self-hosting findings are marked **SELF-HOST ONLY** and must not be read as describing Greptile Cloud.

## 1. What round one established, and what this lane adds to it

Round one (`greptile-trust-cost.md` §1.1–1.4, REPORT §2.5) worked mainly from search-engine extracts, and found:
- code is kept in an encrypted cache on AWS until code-host access is revoked;
- it is hard-deleted within 24 hours of org deletion, with backups "may" be destroyed within 30 days;
- the terms allow training on de-identified data, with an admin opt-out;
- Greptile claims "zero data retention agreements with LLM providers", available under Trust Center Resources;
- the Trust Center lists 18 subprocessors, 3 of them AI providers, unnamed (secondhand);
- SOC 2 Type II.

This lane could not re-read any of those pages, so none of them is confirmed or corrected first-hand here. What this lane adds is **primary evidence from Greptile's own shipped code and manifests**:
- the hosted product keeps a durable server-side record of reviews, comments, knowledge-base documents, rules and patterns, and analytics;
- what the CLI does and does not send;
- a self-hosted usage-export channel that round one missed;
- how the self-hosted knowledge-base, memory and embedding stores are configured: no retention controls exist in the deployment layer;
- a self-hosted batch-API routing setting that conflicts with Anthropic's ZDR scope.

## 2. Hosted Greptile keeps durable server-side records (code, from Greptile's own MCP app manifest)

### 2.1 The evidence

`greptileai/skills/plugins/greptile/.codex-plugin/chatgpt-app-submission.json` (last changed in commit `ad6cf7d`, 2026-10-22; read at HEAD `59e79ec`, 2026-11-03) is Greptile's submission to OpenAI's app directory for its hosted MCP server. `plugins/greptile/.mcp.json` points it at `https://api.greptile.com/mcp`. Each tool carries Greptile's own justification. The read-only tools describe what Greptile Cloud holds:

| MCP tool | Greptile's own justification (verbatim) | What it shows is stored server-side |
|---|---|---|
| `get_code_review` | "Retrieves a saved review body, status, and citations without modifying the review." | Full review bodies and their code citations |
| `get_merge_request` | "Retrieves saved pull request details, review results, comments, and citations" | PR metadata, review results and comments |
| `list_merge_request_comments` | "Retrieves saved comments and their addressed flags" | Every bot comment, plus the outcome of the addressed-judge |
| `search_greptile_comments` | "Searches saved Greptile comments across pull request **and CLI reviews**" | Comments from local CLI reviews are kept too, not only PR reviews |
| `list_knowledge_bases` / `get_knowledge_base_document` / `search_knowledge_base` | "published knowledge-base data"; "Reads a published knowledge-base document"; "Searches published knowledge-base text and returns matching excerpts" | Generated Markdown documentation about the customer's code, full-text searchable |
| `list_custom_context` / `get_custom_context` / `search_custom_context` | "Lists saved rules and patterns with metadata and counts"; "linked comment references" | Learned rules and patterns ("memory"), linked back to the comments they came from |
| `create_custom_context` | "Creates a persistent rule or pattern that can affect subsequent reviews"; "Stores context within the connected Greptile organization" | Memory is explicitly called *persistent* |
| `get_analytics_overview` / `list_analytics_findings` | "Computes review metrics from existing records"; "Retrieves existing findings and aggregate counts" | A historical store of findings |
| `trigger_code_review` | "Starts an asynchronous review that consumes review credits and **persists results**." | Every review result persists by design |

Two prose sources in the same repository say the same:
- `plugins/greptile/skills/review/SKILL.md`: "This dispatches a **headless** review: it reviews the working branch and does not need an open pull request. The review is stored on the user's Greptile account, so the `greptile` MCP tools in this plugin can read it back".
- `plugins/greptile/README.md` describes `get_merge_request` as returning "stored addressed flags and commits since the latest review comment".

The Codex plugin manifest (`plugins/greptile/.codex-plugin/plugin.json`, v1.3.1) declares `"privacyPolicyURL": "https://www.greptile.com/security/privacy"`. That is the current privacy-policy path; round one tried `/privacy`. This lane could not open it either.

### 2.2 What this establishes (code) and what it does not

- **Established (code):** Greptile Cloud keeps a durable, queryable record of review output, comments, knowledge-base documents, learned rules and patterns, and findings analytics, for both PR reviews and CLI or headless reviews of a local branch.
  - Review bodies and citations quote or point at customer code.
  - Knowledge-base documents are model-written descriptions of the customer's codebase.
  - So customer-derived content persists in Greptile's own systems by design, not by accident.
- **Not established:** how long any of it is kept, where (region), whether it is deleted when code-host access is revoked (round one's security-page wording covers "code", not explicitly these derived artifacts), and whether the de-identified training licence (ToS §2.2, round one) reaches these artifacts.
- **Inference:** "zero data retention" at Greptile can only describe the **LLM-provider leg** (Greptile → model provider). Greptile's own storage layer retains by product design: the knowledge base, rules and patterns, and review history are features. That matches round one's wording ("ZDR agreements with LLM providers"), and these manifests now give primary evidence for the distinction instead of inference.

## 3. What the Greptile CLI sends, and what it keeps back (code / vendor README)

Source: npm `greptile@3.8.0` (published 2026-10-26; the README says it documents CLI 3.6.2), files `README.md`, `settings-schema.json`, `CHANGELOG.md`.

### 3.1 The review payload
- "`greptile review` compares the merge base of the selected base and `HEAD` with `HEAD`. It sends committed, non-binary changes only. Uncommitted and binary files stay local and produce warnings."
- Organization review settings "are stored on the server"; the local settings file "contains preferences and deployment origins, never credentials".

### 3.2 Client-side holdback of sensitive files, before upload
"Before sending anything, `greptile review` holds back changed files that look like they contain secrets". A file is held back when:
- its **name** suggests secrets: dotenv files, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `.npmrc`, `credentials`, and similar (`.env.example` is still sent);
- its **diff contains a recognizable credential**: private keys, or AWS, GitHub, Slack, Google, Stripe, Anthropic or OpenAI keys;
- it **matches a `.gitignore` rule** but was committed anyway. These are held back quietly.

Further behaviour:
- `--include PATH` bypasses the check ("sent as-is").
- A commit that *removes* a secret is also held back, because the removed value is still in the diff.
- A rename *away* from a sensitive name is judged on the original path.
- If every file is held back, the review stops.

### 3.3 Two telemetry tiers, and a service-side record that cannot be turned off
- Client events (`cli_first_run`, `cli_command_completed`, `cli_transport_error` and others) carry the install method, OS, architecture, whether the run was interactive, and the agent surface. They never carry "your code, repository or branch names, file paths, or review content".
- **Anonymous** is the default, and it is opt-out. **Account-linked** is opt-in and asked once, on the first interactive run.
- Both tiers are off when `CI` is set or when the CLI points at a self-hosted Greptile. They can be turned off with `GREPTILE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` or a settings key.
- Verbatim: "Greptile separately records service-side API usage and review events. Those records can include the authenticated account and organization and are not disabled by the CLI's telemetry setting or environment switches."
- The plugin README (`greptileai/skills`) adds that telemetry goes to `/v1/telemetry` on `api.greptile.com`. Inside Claude Code and Codex the CLI is "always non-interactive", so it falls back to anonymous mode.

### 3.4 Customer secrets for test execution (TREX) are stored server-side
- `greptile environment env-var set NAME`: "Variables are secret by default, and secrets reach only the setup script. `--non-secret` values can also reach TREX reviews when runtime secrets are enabled for your organization."
- CLI 3.7.0 (2026-10-17) added `greptile environment ... network-policy` and `blockers`.
- With the OpenAI case study's description (round one: Astra starts a dev server for the PR and simulates users), this means **hosted TREX builds and runs customer code with customer-supplied environment variables on Greptile-operated infrastructure**. Where it runs, the retention of build logs and evidence ("a link to its evidence", 3.8.0 changelog), and whether those runs are covered by any ZDR statement are all unknown.

### 3.5 What this means for VectorScope
- Greptile's documented pre-send controls are client-side and file-level (secret-file holdback). Its retention controls (sections 2 and 6) are server-side and undisclosed.
- A VectorScope route manifest that lists **every destination per request and what was sent** would be stricter than anything Greptile's public materials describe.
- The holdback heuristics themselves are a cheap, well-specified feature to copy into VectorScope's redaction step (I-4). Two parts are worth copying exactly: the `.gitignore`-but-committed rule and the "removed secret still in diff" case.

## 4. A self-hosted usage channel back to Greptile (code; corrects round one's "telemetry off unless OTLP")

**SELF-HOST ONLY.** Round one recorded (from `docs/operations/observability.md`) that self-hosted services export nothing unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. That is still true for OTLP traces, metrics and logs. But two October 2026 akupara commits add a **separate** outbound channel.

### 4.1 Commit `1c2f43c` (2026-10-22), "Persist instance IDs and wire optional self-hosted licenses (#114)"
- "Self-hosted usage attribution needs a persistent deployment identity and optional customer-license delivery."
- It provisions an immutable `GREPTILE_INSTANCE_ID` UUID (a Helm ConfigMap "retained on Helm removal"; a Compose `.env.greptile-instance`) and wires `GREPTILE_LICENSE` (a JWT).
- "Reading it into usage reports remains an application-side change in Greptilia". Greptilia is the private application codebase.

### 4.2 Commit `67a3c8c` (2026-10-25), "Persist jobs usage export checkpoints across restarts (#115)"
- The jobs application "defaults to `https://usage.greptile.com/usage-reports`, `production`, and `/var/lib/greptile/jobs-state/usage-export.json`".
- Operators must "allow outbound HTTPS to `usage.greptile.com:443`". "Exports run at startup and daily at 01:30 UTC."
- "An explicitly empty `USAGE_EXPORT_URL` disables automatic uploads for air-gapped deployments."
- A follow-up note says that when `GREPTILE_LICENSE` is unset, export should be skipped. That guard "belongs to the separate Greptilia jobs exporter PR".
- The commit says it "does not deploy anything" and needs "a jobs image containing the automatic usage exporter, whose application changes are being prepared separately".

### 4.3 What this means
- **Not visible:** the contents of a usage report. The application code is private, and "usage" plus "report metadata" is all the deployment repository says.
- **Inference:** usage-based self-host licensing (credits) is moving to automatic daily reporting. The default is on whenever a license is set, and opting out is explicit.
- **Correction:** round one's line "telemetry off unless an OTLP endpoint is set" should read "OTLP telemetry is off unless an endpoint is set; a separate daily usage export to usage.greptile.com is being wired in (default on with a license, disabled by an empty `USAGE_EXPORT_URL`)".
- Related commits:
  - `5199053` (2026-09-08) "Disable Pylon for on-prem web deployments" sets `PYLON_ENABLED=false`. **Inference:** the hosted web app embeds Pylon, a customer-support tool. Pylon is therefore a likely hosted subprocessor, unconfirmed because the subprocessor list could not be read.
  - `EMAIL_PROVIDER='SES'` in `.env.example`. **Inference:** AWS SES, consistent with the AWS hosting on the security page.

## 5. Self-hosted persistent stores: knowledge base, memory, embeddings (code, SELF-HOST ONLY)

All from akupara @`09b7db2` (2026-11-04), `RELEASE_NOTES_202610.5.md` (release date 2026-10-12) and commits `cff67df` (2026-10-07) and `e1eba41` (2026-10-12). **None of this describes Greptile Cloud.** It shows how the product's data model works when the customer runs it, which is the best available proxy for which stores exist.

### 5.1 Knowledge Base
- "Knowledge Base artifacts are stored at `/var/lib/greptile/artifacts` and must be available to the web, API, worker, and jobs services."
- Compose creates a persistent `knowledge_base` volume. "The Helm chart creates a 100 GiB `ReadWriteMany` PVC by default".
- Config: `KNOWLEDGE_BASE_BUCKET='file:///var/lib/greptile/artifacts'`, `KNOWLEDGE_BASE_SYNTHESIS_ENABLED='true'`, `KNOWLEDGE_BASE_MATERIALIZATION_ENABLED='true'`, `KNOWLEDGE_BASE_MIN_REVIEW_COUNT='0'`, `DEFAULT_KNOWLEDGE_BASE_ROUTING_POLICY='kb-gen-roll@5'`.
- The docs refresh every day at 00:17 UTC (`KNOWLEDGE_BASE_DOCS_CRON_EXPRESSION='17 0 * * *'`).
- The jobs service also writes `FILE_CHANGE_ACTIVITY_BUCKET='file:///var/lib/greptile/artifacts'`.
- KB generation "requires access to `gpt-5.6-terra` through your LLM proxy".
- **Inference:** a `*_BUCKET` setting taking a URI (with `file://` given for self-host) suggests the hosted product writes these artifacts to an object store such as S3. Not confirmed.

### 5.2 Embeddings and vectors
- `VECTOR_DB_URL=postgresql://…/vector`, `VECTOR_EMBEDDINGS_TABLE_NAME='embeddings'`. "We recommend using the same Postgres DB for vector storage as for general Greptile."
- `docs/operations/upgrade.md`: "The bundled Postgres instance stores application metadata and vectors."
- The `chunker` "fetches repositories, chunks and embeds code, and stores indexes and metadata".

### 5.3 Memory
LiteLLM aliases:
- `memory-learning` → `claude-sonnet-4-6` (comment: "could also be openai/gpt-5.6-terra");
- `memory-clustering` → `claude-sonnet-4-6`;
- `memory-embeddings` → `text-embedding-3-small`.

`REPO_CLUSTERS_ENABLED='true'` is set by default.

### 5.4 No retention controls in the deployment layer
Searching the whole repository for retention, TTL, purge, expiry and prune settings found no setting for:
- the knowledge base,
- the embeddings table,
- memory (rules, patterns, clusters),
- review state,
- the shared workdir of cloned repositories.

The only TTLs in the repository are `ttlSecondsAfterFinished: 86400` on the DB-migration job and Hydra's OAuth token TTLs. Retention of these stores is therefore either hard-coded in the private application or absent. The deployment layer leaves it entirely to the operator's volume and database lifecycle. **The search covered the deployment repository only, not the application code.**

### 5.5 What this means
- The knowledge base, embeddings and memory are durable, growing stores by design, with refresh and accumulation (daily KB refresh, `MIN_REVIEW_COUNT=0`) and no expiry knob.
- That is the evidence-based version of round one's inference that "Greptile's persistent artifacts conflict with ZDR by design". The conflict is with **vendor-side ZDR** when hosted, not with provider-side ZDR.

## 6. Provider-leg retention risks visible in Greptile's own routing config

### 6.1 Batch APIs (code + vendor, Anthropic)
- **Code, SELF-HOST ONLY.** akupara `deploy/docker-compose/llmproxy-config.yaml` @`09b7db2` has `batch_settings.providers.anthropic.model_patterns: [claude-*]` and `openai.model_patterns: [gpt-4o*, gpt-5*, chatgpt-*]`. The block was added in commit `3904840` (2026-05-08) and is still present.
- **Vendor (Anthropic), fetched 2026-11-06.** Anthropic's API and data retention page lists Batch processing (`/v1/messages/batches`) as **ZDR eligible: No**, with "29-day retention; async storage required". It also says: "Under ZDR, the API does **not** block these features; using one is a choice to step outside your ZDR arrangement for that specific data."
- **Not visible:** which Greptile jobs use batch. Candidates: the weekly digest, comment analytics, and memory clustering.
- **Inference:** if hosted Greptile uses the same batch pattern for Claude jobs, those jobs sit outside Anthropic ZDR even under a ZDR agreement. A ZDR claim would then cover only the synchronous requests.
- **Confirms VectorScope's design:** I-3 already refuses Batch (`ReviewRouteRefusal` includes `"batch"`).

### 6.2 OpenAI Responses API mode (code; the OpenAI side could not be verified)
- **Code, SELF-HOST ONLY.** `gpt-6*`, `gpt-5.6-luna` and `dsv4-flash-leased-nothink` are configured with `mode: responses`. The config sets no `store` parameter.
- **Unverified:** OpenAI's default retention for stored Responses objects, and how ZDR changes it. The pages that would settle this (developers.openai.com, platform.openai.com) could not be opened here, and no claim is made about them.
- **Action for a later lane:** confirm whether Responses-mode traffic retains application state by default and whether a ZDR organisation overrides it. VectorScope's OpenAI route should send `store: false` explicitly regardless.

### 6.3 Anthropic's ZDR scope, now read first-hand (vendor; confirms and extends round one)
platform.claude.com, "API and data retention", fetched 2026-11-06; the page shows no date.

Not ZDR-eligible:
- Batch: 29 days.
- Files API: kept until deleted or expired.
- **MCP connector** (`/v1/messages` with `mcp_servers`): "Data retained according to standard policy".
- MCP tunnels.
- Code execution and programmatic tool calling: up to 30 days.
- **Claude Managed Agents**: "no feature is eligible for ZDR or HIPAA readiness".
- Message threads: held in memory and deleted ≤1 h after last use, but marked "No".
- User profiles.

ZDR-eligible, some only "qualified":
- **Prompt caching** is eligible: "KV cache representations and cryptographic hashes are held in memory for the cache TTL".
- **Structured outputs** are "Yes (qualified)": "Only the JSON schema is cached, for up to 24 hours since last use".
- Cache diagnostics are "Yes (qualified)".

ZDR for Claude Code and the API key:
- "ZDR applies when Claude Code is used with API keys from a Commercial organization … If metrics logging is enabled in Claude Code, productivity data such as usage statistics is exempted from ZDR and may be retained."

Models that require retention:
- Fable 5/5.1 and Mythos 5/5.1 "require 30-day data retention and are not available under ZDR unless expressly authorized by Anthropic".
- A non-compliant organisation gets a `400 invalid_request_error`.

**Link to Greptile (vendor, Anthropic case study, read in full 2026-11-06):** Gupta says "the integration with MCP has been valuable".
- If that means the **server-side MCP connector**, those requests are outside Anthropic ZDR.
- If it means **client-side MCP through the Agent SDK**, they can be ZDR-eligible.
- The case study does not say which, and it makes **no data-handling, retention or ZDR statement at all**.

## 7. The Anthropic case study's memory description (vendor; confirms persistence)

claude.com/customers/greptile, read in full:
- "One sub-agent handles memory retrieval, pulling from a bank of information that includes coding standards the team has expressed, idiosyncrasies Greptile has learned about the codebase, and context from documentation, claude.md files, and cursor rules. This accumulated knowledge informs every review."
- Also: "Greptile runs on Opus 4.5"; "reviewing over a billion lines of code each month"; "more than 2,000 organizations".
- Self-hosting customers use "their own Anthropic instances".

This is vendor language (Anthropic about Greptile) for a persistent, accumulating, per-organization store derived from customer code and conversations. It agrees with section 2's MCP manifest.

## 8. Self-host never routes to Together AI (code); the hosted Together leg is unexplained

- akupara's supported providers are Anthropic, OpenAI, Azure AI Foundry and AWS Bedrock (GCP Vertex per the vendor docs, round one). There is **no Together AI route and no open-weights route**.
- The alias `dsv4-flash-leased-nothink` ("Required by new OpenAI based variants") is pointed at `openai/gpt-5.6-luna` for self-hosting.
- **Inference:** the hosted pipeline sends that subtask to a DeepSeek-V4-Flash-class open model on leased capacity, probably the Together AI deployment described in Together's customer story (round one, ~2026-08-31, vendor). If so, a third LLM provider sits on the hosted path, and its retention terms are not covered by any source this lane could read.
- Whether Greptile's ZDR agreements include Together, and whether the "3 AI subprocessors" in round one's secondhand count are OpenAI, Anthropic and Together, remains **unverified**.

## 9. What remains unknown (carried forward)

| Question | Status after this lane |
|---|---|
| Named subprocessors, and which 3 are AI providers | Unknown. The Trust Center and subprocessor page were unreachable. Candidates from code and vendor sources: AWS (hosting, SES), OpenAI, Anthropic, Together AI, Pylon (inferred). Not a list. |
| Which providers and routes Greptile's ZDR covers | Unknown. Section 6 identifies two route classes (provider batch APIs; server-side MCP connector) that fall outside Anthropic ZDR by Anthropic's own rules, if Greptile uses them on the hosted product. |
| Retention of review history, KB documents, memory, embeddings | Persistence confirmed (code, sections 2 and 5). Duration and region unknown. No self-host knob exists in the deployment repository. |
| Whether derived artifacts are deleted when code-host access is revoked | Unknown. Round one's security-page wording covers "code". |
| Whether the de-identified training licence covers derived artifacts | Unknown. |
| TREX execution data and secret retention | Secrets stored server-side (code). Retention and location unknown. |
| OpenAI and Together case studies: data-handling statements | Unreadable this round (hosts blocked). |
| Community security reviews and procurement write-ups (HN, Reddit, X) | Not searched: the WebSearch budget was exhausted and the hosts were blocked. |

## 10. What this means for VectorScope

1. **Do not claim "better ZDR than Greptile" on the provider leg.** Greptile's provider-side ZDR scope is still unverified, so a head-to-head claim cannot be supported either way.
2. **Claim the structural difference instead, with evidence.**
   - Greptile Cloud, by its own MCP manifest, keeps review bodies, comments (including those from local CLI reviews), knowledge-base documents, persistent rules and patterns, and findings analytics on its own servers (code).
   - VectorScope on a customer's own key, or on loopback, has no vendor-side store.
   - That is a claim that can be checked, and it holds whatever Greptile's provider agreements say.
3. **Make the per-review route manifest (GU20) record the classes Greptile's config shows are risky:**
   - batch versus synchronous;
   - server-side versus client-side tool or MCP use;
   - OpenAI `store` setting;
   - structured-output schema caching (Anthropic keeps schemas up to 24 h);
   - prompt caching (allowed; in memory for the TTL);
   - any vendor-side persistence (none for VectorScope local).

   Each entry should name its evidence (Anthropic's feature-eligibility table). VS-23's refusal list already covers Batch and retention-required models. It should add "server-side MCP connector", and "OpenAI Responses with store not false" once the OpenAI terms are verified.
4. **Copy Greptile's CLI secret holdback into VectorScope's pre-send redaction (I-4):**
   - secret-like names;
   - credential patterns in the diff;
   - `.gitignore`-matched files that were committed anyway;
   - removed secrets that still appear in the diff;
   - renames judged on the original path.

   List held-back files in the manifest.
5. **State service-side records honestly, as Greptile's CLI README does.** If any Vector-hosted component (the Codium gateway, the free-model route) logs usage, the manifest and docs should say so plainly. Greptile sets that bar itself, and VectorScope should meet it.
6. **If VectorScope ever offers knowledge pages or Brain cards as a hosted feature, they become exactly the kind of persistent derived store that Greptile has.**
   - Keep them local, or in the customer's own storage, by default.
   - Give them an explicit TTL and a delete path. Greptile's self-host deployment exposes neither.
