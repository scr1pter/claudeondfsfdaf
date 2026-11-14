# Greptile architecture: research notes for Vectorscope

Compiled 2026-11-05. Scope: how Greptile builds and uses whole-codebase understanding, how its PR review pipeline works, how it changed from v2 to v5, its API/MCP/IDE/CLI surfaces, and what is public about its models.

## 0. Method and limits (read this first)

- **No page could be fetched directly.** WebFetch failed for every host tried (`www.greptile.com`, `greptile.com`, `hatchet.run`) because they are outside this session's network allowlist. curl returned a 403 from the egress proxy. The GitHub MCP is limited to `scr1pter/vectordev.ai`, so `greptileai/akupara` (Greptile's Helm/Terraform repo) and `greptileai/skills` could not be read. To check these notes against the primary pages, allow `greptile.com`, `www.greptile.com`, `claude.com`, `together.ai` and `hatchet.run` in the session network settings, and attach `greptileai/akupara`.
- **Everything below comes from WebSearch result excerpts.** The search tool returns the URL plus quoted passages and a summary for each page. Quoted figures are what the excerpts showed. I did not read full pages, so section-level context (footnotes, caveats on charts) may be missing. Where two excerpts disagree, both readings are given.
- **How dates were set.** Where a page's date was not in its excerpt, I decoded it from X/LinkedIn post IDs. X uses snowflake IDs, `(id>>22)+1288834974657` ms; LinkedIn activity IDs use `id>>22` ms. These dates are marked "decoded" and count as my inference, though the method is reliable.
- **Labels.** [vendor] = Greptile, or a partner such as Anthropic or Together writing about Greptile. [vendor-competitor] = a competing review vendor's benchmark. [independent] = third party with no product stake. [research] = paper or preprint. [inference] = my own reasoning. [secondary] = a third-party blog or wiki summary that may simply repeat vendor claims.

---

## 1. Timeline

| Date | Event | Source | Label |
|---|---|---|---|
| ~Mar 2024 (from HN item ID range) | Launch HN "Greptile (YC W24): RAG on codebases that actually works". Pipeline: parse the AST, recursively generate a docstring for each node, embed the docstrings (HyDE-like). Founder confirms tree-sitter is used for all AST parsing ("Yup"). | https://news.ycombinator.com/item?id=39604961 | vendor (founder comments) |
| Jun 2024 | $4.1M seed (Initialized). Describes indexing that "mirrors how experienced engineers" work: build a general map/graph of the codebase, then follow references. Codebases are treated as graphs, not flat file lists. | https://www.greptile.com/blog/seed | vendor |
| Aug 15 2024 or Apr 15 2025 (two copies give different dates) | "Codebases are uniquely hard to search semantically". The natural-language description of code scored 0.8152 similarity to the query, raw code 0.7280. A single function scored 0.768, the whole file containing it 0.739. Conclusion: translate code to natural language before embedding, and chunk at function level. | https://www.greptile.com/blog/semantic-codebase-search | vendor (informal experiment) |
| 2024-10-08 | "Introducing Greptile 2.0", described as a ground-up rewrite. Builds a "detailed codegraph of how each function, class, file, and directory is connected." | https://www.greptile.com/blog/greptile-2 | vendor |
| Dec 2024 (HN item 42451968 range) | "How to Make LLMs Shut Up". About 19% of comments were good, 2% wrong and 79% nits. Prompting and LLM severity rating did not fix this. Fix: embed each team's past comments in a vector DB and filter new comments that resemble downvoted ones. Address rate went from 19% to 55%+ within 2 weeks. | https://www.greptile.com/blog/make-llms-shut-up ; HN https://news.ycombinator.com/item?id=42451968 ; summary https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings | vendor |
| Feb 2025 | Older self-hosting doc recommends "Anthropic Claude 3.7 Sonnet (as of Feb 2025)" plus OpenAI embeddings. | https://greptile.com/docs/security/selfhost | vendor (outdated) |
| Jul 2025 | Greptile benchmark: 5 tools, 50 real bugs, 5 repos (Sentry/Python, Cal.com/TS, Grafana/Go, Keycloak/Java, Discourse/Ruby). Reported catch rates: Greptile 82%, Cursor 58%, Copilot 54% (one secondary source says ~55%), CodeRabbit 44%, Graphite 6%. Only detection of the injected bug counted; false positives were not scored. | https://greptile.com/benchmarks | vendor |
| 2025-09-23 | $25M Series A (Benchmark) and **Greptile v3**, "a complete rewrite of our code review workflow" and "core agent architecture". Claims 3x more critical bugs caught than v2. | https://www.greptile.com/blog/series-a ; https://siliconangle.com/2025/09/23/greptile-bags-25m-funding-take-coderabbit-graphite-ai-code-validation/ ; v3 post https://www.greptile.com/blog/greptile-v3-agentic-code-review (excerpt shows the page dated 2025-11-26, probably an update) | vendor / trade press |
| ~2026-01-17 (decoded from Lydia Hallie's X post) | Anthropic customer story: "Greptile builds truly agentic code review with Claude Agent SDK". | https://claude.com/customers/greptile ; https://x.com/lydiahallie/status/2012580617448239264 | vendor (Anthropic) |
| ~2026-01 | "There is an AI Code Review Bubble". Thesis: the review agent should be independent of the coding agent. | https://www.greptile.com/blog/ai-code-review-bubble (date from aggregator fooqux) | vendor |
| 2026-03-05 (decoded from LinkedIn) / changelog lists 2026-03-06 | **Greptile Agent v4** and new pricing ($30/dev/month, 50 reviews included, then $1/review). | https://www.greptile.com/blog/greptile-v4 ; https://www.linkedin.com/posts/dakshg_today-were-releasing-greptile-agent-v4-activity-7435353275857743872-7idK | vendor |
| Apr–May 2026 | `context.repos` cross-repo field, directory-scoped `.greptile/` config, Repo Clusters (dates come from search summaries and are uncertain). | https://www.greptile.com/changelog | vendor |
| 2026-06-04 (decoded) | Greptile CLI (`npm i -g greptile`, `greptile review`). | https://x.com/dakshgup/status/2062550804104659373 ; https://www.greptile.com/docs/code-review/greptile-cli | vendor |
| 2026-06-15 | **TREX** public beta: Greptile runs the PR branch in a sandbox. | https://www.greptile.com/blog/trex ; https://www.greptile.com/blog/trex-code-execution ; https://x.com/dakshgup/status/2066536928716235254 | vendor |
| ~early Jul 2026 | "Automating Code Validation". Goal is to cover intent, blast radius, running code and security for each change. | https://www.greptile.com/blog/automating-code-validation | vendor |
| Jul 2026 | "Models are worse at reviewing their own code" research, which led to the **Model Inversion** feature. | https://www.greptile.com/blog/model-inversion ; https://x.com/bradflora/status/2079602352458547200 (decoded 2026-07-21) | vendor |
| 2026-07-30 | Greptile claims #1 on Martian's online Code Review Bench (60.8% F1). | https://www.greptile.com/content-library/greptile-martian-code-review-benchmark | vendor citing an independent benchmark |
| 2026-08-05 (decoded) | **Greptile v5**: a swarm of parallel per-hypothesis agents. | https://www.greptile.com/blog/greptile-v5 ; https://x.com/dakshgup/status/2085033901286957127 | vendor |
| 2026-08-20 | `greptileai/examples` (API examples) repo archived. VS Code extension marked deprecated. | https://github.com/greptileai/examples ; https://github.com/greptileai/greptile-vscode | vendor (repo state) |
| 2026-08-31 (decoded) | Together AI announces Greptile as a customer. Greptile runs open models alongside frontier models. | https://www.together.ai/customers/greptile ; https://x.com/togethercompute/status/2094554758912868364 | vendor (Together) |
| 2026-09-16 (decoded) | Knowledge Base MCP: Claude Code and Codex can read Greptile's codebase knowledge base. | https://x.com/greptile/status/2100268607477273048 | vendor |
| 2026-09-25 | **Plus and Apex** review tiers (Base 1 credit, Plus 3, Apex 10, plus Auto). | https://www.greptile.com/blog/introducing-plus-and-apex ; https://www.greptile.com/docs/code-review/review-tiers ; https://x.com/dakshgup/status/2103522349786304720 | vendor |
| 2026-10-19 | $50M Series B (Menlo) at a $750M valuation. Claims it reviews and tests more than 1% of all GitHub PRs every day. | https://x.com/greptile/status/2112193902555898208 ; https://roundos.ai/funding/deals/greptile-series-b-2026-10-19 | vendor |
| 2026-10-23 | Seat fees reportedly removed: $1/credit with one balance per org. This comes from third-party trackers. | https://macroscope.com/content/greptile-pricing-2026 ; https://repowise.dev/blog/comparisons/greptile-pricing | secondary (competitor-written) |
| ~2026-10-26/28 | AI Engineer talk by Daksh Gupta, "How to build an AI code review agent". | https://www.greptile.com/blog/how-to-build-a-code-review-agent ; https://www.sean-weldon.com/blog/2026-10-28-how-to-build-an-ai-code-review-agent-daksh-gupta-greptile | vendor / secondary |

The versions do not run in a clean sequence. "Greptile 2.0" (Oct 2024) is the indexing and codegraph rewrite. "v3" (Sep 2025) is the agent-loop rewrite. v4 (Mar 2026) is a tuning release with fewer false positives. v5 (Aug 2026) is the hypothesis swarm. TREX (Jun 2026) and the tiers (Sep 2026) are separate layers on top.

---

## 2. Codebase understanding (the index)

### 2.1 Graph
- The docs describe three indexing steps. (1) Scan the repo and parse every file to extract directories, files, functions, classes and variables. (2) Map relationships: calls, imports, dependencies, variable usage. (3) Store the graph so reviews can query it quickly. Source: https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context [vendor; the search engine put the page at roughly 200 days old, about April 2026].
- At review time, for a changed function the agent checks its dependencies, its callers, and similar functions elsewhere in the repo. The checklist page says it flags when "you're breaking consistency with similar functions". Sources: same docs page; https://www.greptile.com/code-review-checklist [vendor].
- The overview says it builds "a complete graph of your codebase - every function, class, and dependency" (https://www.greptile.com/docs/introduction) [vendor]. The key-features page says the graph covers functions, classes, imports and dependencies and is used to reason about "ripple effects beyond the diff" (https://www.greptile.com/docs/code-review/key-features) [vendor].
- Third-party summaries add class inheritance and variable scopes as graph contents (https://note.com/yoshitaka_kadoya/n/nffaf717ec315) [secondary].

### 2.2 Docstrings and summaries, then embeddings
- Founder, 2024 Launch HN: "Instead of directly embedding code, we parse the AST of the codebase, recursively generate docstrings for each node in the tree, and then embed the docstrings." The stated rationale is that it works like HyDE. Tree-sitter is used for all AST parsing. Source: https://news.ycombinator.com/item?id=39604961 [vendor/founder, 2024].
- The Hatchet case study says retrieval combines semantic search, keyword search and an "agentic" step that checks relevance and follows references. Jobs used to stall "at 99% completion due to the large number of leaf nodes in the AST dependency chain", which is why the workflow was made resumable in 4 steps. Moving to Hatchet halved failed runs. Hatchet caps runs per worker to manage memory and keeps ingestion fair across concurrent users. Greptile has indexed the Linux kernel, CPython and VS Code. Source: https://hatchet.run/customers/greptile [vendor (Hatchet); undated, probably 2024].
- The code-context marketing page says Greptile generates docstrings with AI for every function, class, file and directory, then builds a relationship graph (https://www.greptile.com/code-context) [vendor].
- **Current self-hosted components.** The docs list "chunker" and "summarizer" indexer workers. The chunker splits repos into chunks for indexing; the summarizer generates repository summaries. Postgres with **pgvector** is the application store. Hatchet (with its own Postgres and RabbitMQ) orchestrates jobs. Redis handles caching and rate limiting. Other services: web, auth, api, webhook, reviews (port 3005 in Compose), jobs, llmproxy. Sources: https://www.greptile.com/docs/system-architecture ; https://www.greptile.com/docs/docker-compose/overview ; https://www.greptile.com/docs/kubernetes-new ; https://github.com/greptileai/akupara [vendor].
- Self-hosted model roles. A "smart" model (code review and agent tasks; Claude Sonnet 4.5+ or GPT-5.x/6.x). A "fast" model (summarization and quick tasks; GPT-4o-mini, GPT-5 nano or Claude Haiku 4.5). An "embeddings" model (code indexing; text-embedding-3-small or Amazon Titan V2). Providers: OpenAI, Anthropic, AWS Bedrock, Azure OpenAI, GCP Vertex AI. Source: https://www.greptile.com/docs/deployment-options [vendor; current as of 2026]. [inference] This confirms the 2024 design is still in place: a cheap model summarizes chunks and nodes, a small embedding model vectorizes them, and pgvector stores them.

### 2.3 Knowledge base (2026 layer above the graph)
- "Greptile generates and maintains a large internal knowledge base about every part of the codebase. What it does, how it works, how it's architected, how it's connected to other parts of the codebase, bugs that have been introduced in the past here, and potential sources of risk." For "a medium-sized company" monorepo this can be "hundreds of pages". Users can edit it, and it updates as code changes. When a new PR looks like it patches a previously merged bug, that location is recorded as a risk area for later PRs. Sources: https://www.greptile.com/greptile-vs-coding-agents ; https://www.greptile.com/knowledge-base [vendor, 2026].
- Why it exists: the knowledge base "eliminates the tens of thousands of tokens that the agent would otherwise consume re-learning how the codebase works" (https://www.greptile.com/blog/automating-code-validation, ~Jul 2026) [vendor]. Talk coverage says grep plus file reads burn most inference tokens, so Greptile hands the model a curated wiki instead. The "How to build" post advises having agents "crawl your codebase periodically and maintain some type of wiki" (https://www.greptile.com/blog/how-to-build-a-code-review-agent ; https://www.sean-weldon.com/blog/2026-10-28-how-to-build-an-ai-code-review-agent-daksh-gupta-greptile) [vendor / secondary].
- Since 2026-09-16 coding agents can read it over MCP (Knowledge Base MCP) (https://x.com/greptile/status/2100268607477273048) [vendor].

### 2.4 Learned memory (team standards)
- Learning sources: team PR comments, replies to Greptile, reactions and commits. Repeated patterns become suggested custom rules (https://www.greptile.com/changelog) [vendor]. Only 👍/👎 reactions train the system, and a 👎 should come with a short explanation (https://www.greptile.com/docs/code-review/training-the-learning-system) [vendor]. The first ~2–3 weeks are "standard suggestions, high noise" (https://www.greptile.com/docs/code-review/developer-essentials, quoted by https://www.cubic.dev/blog/greptile-review) [vendor/secondary].
- The 2024 mechanism is per-team embeddings of past comments with a similarity filter against downvoted ones (https://www.greptile.com/blog/make-llms-shut-up) [vendor].
- v3 auto-detects `CLAUDE.md`, `.cursorrules` and similar files instead of asking for a new standard. It pulls Jira, Notion and Linear context to infer intent (https://www.greptile.com/blog/greptile-v3-agentic-code-review ; https://siliconangle.com/2025/09/23/greptile-bags-25m-funding-take-coderabbit-graphite-ai-code-validation/ ; https://www.greptile.com/greptile-vs-coding-agents) [vendor/trade press].
- In the Claude Agent SDK build, one **sub-agent handles memory retrieval** over coding standards, learned codebase quirks and docs such as claude.md and cursor rules (https://claude.com/customers/greptile) [vendor (Anthropic)].

### 2.5 Staying current on new commits
- No primary doc found states the re-index trigger or latency. What the docs do say:
  - The API status check returns a `sha` once a repo is indexed, with "We may just be processing updates from a newer commit." This implies per-commit incremental processing on the indexed branch (https://docs.greptile.com/quickstart) [vendor].
  - Initial indexing takes "3-5 minutes for small repositories, and over an hour for bigger ones" (same source) [vendor].
  - The knowledge base is built "with an initial scan of the repository, then updates it as the codebase changes" (https://www.greptile.com/changelog) [vendor].
  - Config changes apply to the next PR "immediately — no reindexing required" (https://www.greptile.com/docs/code-review/greptile-config) [vendor].
  - To force a refresh, open a PR with `@greptileai review`. The dashboard shows Indexed, Indexing or Failed (https://www.greptile.com/docs/code-review/custom-standards) [vendor].
  - `ignorePatterns` exclude files from review but "Greptile will still index them" (https://www.greptile.com/docs/code-review-bot/greptile-json) [vendor].
- Third parties say the graph is "updated incrementally as new commits arrive" (https://vantaige.io/ai-tool/greptile ; https://www.morphllm.com/comparisons/greptile-vs-copilot) [secondary].
- [inference] Webhook-driven incremental re-processing of changed files on the tracked branch (keyed by sha), with Hatchet jobs, is the most likely design. Nothing found specifies whether callers and summaries of unchanged dependents get recomputed.

---

## 3. PR review pipeline

### 3.1 v2 (Oct 2024 to Sep 2025): fixed pipeline
- The v3 post describes v2 as a "flowchart": read the diff, gather codebase context, gather external context, write comments. Its weakness was that it "could not act on what a search turned up". In the post's example it never reads a third file that a called function depends on, because the flowchart has already moved on (https://www.greptile.com/blog/greptile-v3-agentic-code-review) [vendor].

### 3.2 v3 (Sep 2025): agent loop on the Claude Agent SDK
- The pipeline was replaced with "a loop with access to some key tools such as codebase search and accessing learned rules". The agent recurses through nested calls and follows the dependency chain to decide whether a suspected issue is real or a false positive. Example from the post: a discount-logic change where the agent finds an outdated helper left over from an old hotfix (https://www.greptile.com/blog/greptile-v3-agentic-code-review) [vendor].
- Built on the **Claude Agent SDK** (https://claude.com/customers/greptile) [vendor (Anthropic), ~Jan 2026]:
  - Model: "Greptile runs on Opus 4.5" (as of the case study).
  - Investigation tools: grab codebase context, find semantically similar functions, retrieve git history, read PR context. The SDK "handles orchestration" so Greptile can build specialized tools (git history analysis, similarity detection).
  - Heavy use of SDK **sub-agents**, including the memory-retrieval sub-agent above.
  - **Hooks** are used "to inject determinism where it matters".
  - About **90% prompt cache hit rate**. For self-hosters using their own Anthropic instances, this lets usage scale "without proportional cost increases".
  - Example: it flagged a precision bug in NVIDIA PhysicsNeMo, and when the author disputed it, replied with evidence (comparisons to similar functions across the codebase, plus relevant git history).
- v3 vs v2 numbers [vendor]: action rate 34.75% to 59.24% (+70.5%); upvote/downvote ratio 1.44 to 5.13 (the "256%" headline); about 3x more context tokens per review, yet "75% lower inference costs for our self-hosted customers, thanks to extremely high cache hit rates". Also shipped: an MCP server, Jira and Notion context, and a copyable prompt per comment for coding agents.

### 3.3 v4 (Mar 2026): accuracy and false-positive work
- The official post gives metrics but almost no architecture. From a month of A/B testing against v3 across many customers [vendor] (https://www.greptile.com/blog/greptile-v4):
  - Addressed comments per PR 0.92 to 1.60 (+74%). "Addressed" is judged by an LLM.
  - Share of comments addressed 30% to 43%.
  - Positive replies per PR 0.31 to 0.52 (+68%).
  - Upvotes per PR 0.05 to 0.08 (+60%). The absolute numbers are tiny.
- Third-party descriptions of v4 call it "multi-hop investigation" (dependency tracing, git history, following leads across files in a loop) and say it attaches a per-comment confidence indicator. These are unconfirmed by the primary excerpts (https://dev.to/jovan_chan_9500711396d4e6/greptile-review-2026-82-bug-catch-rate-the-1review-trap-and-who-should-pay-30month-4jao ; https://weavai.app/blog/en/2026/04/30/greptile-2026-review-ai-code-review-for-30-mo/) [secondary].

### 3.4 v5 (Aug 2026): hypothesis swarm
- "Greptile V5 spins up a swarm of agents that each explore one hypothesis for a potential bug. Because each agent is focused on a narrowly scoped task, it can explore much deeper when needed. Since these agents run in parallel, our end to end latency is much smaller." (https://www.greptile.com/blog/greptile-v5) [vendor].
- From live production data on 1M+ PRs, v5 vs v4 [vendor]: median review time 5:04 to 2:25; comments addressed 52% to 66%; positive replies per PR 0.266 to 0.342 (+28.6%, per the founder's X post https://x.com/dakshgup/status/2085033901286957127). [inference] The v4 "addressed" baseline is 43% in the v4 post but 52% in the v5 post. The metric definition, population or time window probably changed, so the version-over-version numbers cannot be chained.
- Together AI says the V5 agent "spins up sub-agents to review each pull request, using an orchestration of models … Open models run alongside frontier models, each doing the work it does best." Together's test deployments met Greptile's latency requirements "from the first demo" (https://www.together.ai/customers/greptile, ~Aug 31 2026) [vendor (Together)]. Which open models are used was not disclosed.
- Alongside v5 [vendor, changelog]: "Fix All" in the review summary; Greptile Bridge (a small CLI that routes fix requests from GitHub to the developer's local agent); auto-marking of addressed comments; follow-up replies in threads; a separate comment for issues outside the changed code.

### 3.5 Review tiers (Sep 2026): compute scaling per PR
- Base (1 credit): "thorough code review with full codebase context". Plus (3): "a deeper review for PRs that need extra scrutiny". Apex (10): "our most intensive review for large, complex PRs". Auto picks the tier per PR by size, risk and complexity and bills for the tier that ran. Rules can force Plus or Apex for large PRs or high-risk paths. Sources: https://www.greptile.com/blog/introducing-plus-and-apex ; https://www.greptile.com/docs/code-review/review-tiers [vendor].
- Mechanism: higher tiers get "more time to run subagents in parallel" plus more tools and subagents. No source says Apex uses a larger model [vendor]. The founder argues "it is increasingly prudent to allocate more compute to validation than to generation" and says Greptile ran Apex on its own repos for a month (https://x.com/dakshgup/status/2103522349786304720, 2026-09-25) [vendor].
- Vendor chart (metric undefined in the excerpt): going from 0–10 to 28+ changed files, Apex rises 0.67 to 2.55, Plus 0.57 to 1.67, Base 0.42 to 1.23. [inference] Probably bugs or addressed comments per PR. Either way, the gap between tiers widens on large PRs, which is the case for scaling compute with PR size.

### 3.6 TREX (Jun 2026): execution-backed validation
- The reviewer agent is the **orchestrator**. It reads the diff, picks the behaviours worth running, and spins up a dedicated TREX agent plus sandbox for each one, all in parallel. Each sub-agent inherits what the reviewer already found, has its own context window, and is scoped to one problem. Sandboxes are fresh isolated compute instances that start "in milliseconds" and are discarded afterwards. TREX starts services, sends real requests, mocks API calls, drives the UI, and writes and runs ephemeral unit tests. It attaches logs, screenshots, API traces, scripts or video to the PR comment. The orchestrator and TREX sub-agents can use different model providers in the same review. Claim: "~20% more bugs than review alone" in internal evals, with no eval set published. Sources: https://www.greptile.com/blog/trex ; https://www.greptile.com/blog/trex-code-execution ; https://www.greptile.com/trex ; https://www.greptile.com/docs/trex/overview [vendor]; critique at https://victorinollc.com/thinking/trex-verification-by-execution [independent commentary].
- The DIY recipe in the 2026 talk uses Firecracker microVMs for isolation, with a model-agnostic open-source coding-agent harness behind a PR webhook. Whether Greptile's own sandboxes are Firecracker is not confirmed (https://www.sean-weldon.com/blog/2026-10-28-how-to-build-an-ai-code-review-agent-daksh-gupta-greptile) [secondary].

### 3.7 How context is picked for a diff (synthesis)
1. Graph queries around changed symbols: dependencies, callers, similar functions (docs).
2. Agentic follow-up. The agent searches the codebase and follows call chains or nested calls as far as it needs (v3 onward).
3. Git history of touched code (Claude case study).
4. Knowledge-base pages for affected modules, including past-bug and risk notes (2026).
5. Team memory: learned rules, custom rules, `CLAUDE.md`/`.cursorrules`, and scoped `.greptile/` rules where the closest directory's settings win and rules from every level apply (https://www.greptile.com/docs/code-review/greptile-config-reference) [vendor].
6. External intent from Jira, Notion or Linear tickets and in-repo docs.
7. Cross-repo context through `context.repos` or Repo Clusters, read-only, **up to 7 related repos per review**, same SCM host and credentials (https://www.greptile.com/changelog ; https://www.greptile.com/docs/code-review/greptile-json-reference) [vendor].

### 3.8 Very large monorepos and very large PRs
- Monorepos: the scoped `.greptile/` folder is the recommended approach, with per-directory overrides. `ignorePatterns` uses gitignore syntax and affects review only. Repo Clusters handle related repos; one secondary source gives a 20 GB cluster size. Hatchet case study: the Linux kernel, CPython and VS Code were indexed. Indexing takes "over an hour" for big repos. No published line-count or file-count ceiling was found. Sources: docs above; https://hatchet.run/customers/greptile [vendor]; https://www.morphllm.com/comparisons/greptile-vs-copilot [secondary].
- Large PRs:
  - The config reference says "previously saved review and auto-approval file limits no longer apply", so a file cap existed and was removed (https://www.greptile.com/docs/code-review/greptile-config-reference) [vendor].
  - Reviews blocked by settings (drafts, file or line limits) end with a SKIPPED status. This comes from a third-party reimplementation (https://github.com/mbelenkiy29/OPENREVIEW/pull/82) [secondary].
  - The 2026 answer to large PRs is the tier system: Apex or Auto for large or complex PRs. [inference] Under v5, PR size is handled by parallelism, with more hypotheses and more sub-agents, rather than by squeezing the diff into one context.
  - Users report building their own size gates (label PRs over 250 or 400 changed lines) to save credits (https://github.com/anima-research/connectome-host/pull/293 ; https://github.com/anima-research/eidoverse-worlds/pull/253) [independent user practice].

### 3.9 Output format
- A PR summary plus inline comments on specific lines. A "Confidence Score: N/5" for merge readiness, contextual to the risk of the area. A sequence diagram for every PR (collapsible and configurable). A separate comment for issues outside the changed code. The "Important Files Changed" table and "T-Rex Logs" section were later removed in a summary redesign. Sources: https://www.greptile.com/docs/code-review/first-pr-review ; https://www.greptile.com/sequence-diagrams ; https://www.greptile.com/changelog ; sample PR https://github.com/NVIDIA-NeMo/DataDesigner/pull/423 [vendor/user].
- Comment volume is tuned with nitpickiness controls (https://www.greptile.com/docs/code-review/controlling-nitpickiness) [vendor].

---

## 4. Models (publicly known)

| Period | Model facts | Source | Label |
|---|---|---|---|
| Feb 2025 | Self-host recommendation: Claude 3.7 Sonnet plus OpenAI embeddings | https://greptile.com/docs/security/selfhost | vendor (outdated) |
| ~Jan 2026 | "Greptile runs on Opus 4.5" in the Claude Agent SDK build | https://claude.com/customers/greptile | vendor (Anthropic) |
| 2026 | Uses "a combination of frontier models from OpenAI and Anthropic, to leverage their respective strengths" | https://www.greptile.com/independence | vendor |
| 2026 | "Right-sized model, both frontier and open source, for each subtask" | https://www.greptile.com/blog/how-to-build-a-code-review-agent | vendor |
| Jul 2026 | Model Inversion detects the authoring agent from commit trails, branch prefixes and PR titles, then routes review to the other family (Claude-written to GPT review, and the reverse). Research: two 500-PR sets (Claude Code-authored and Codex-authored), ~1,500 ground-truth comments. Each model catches more bugs in the other's code. On Claude Code PRs, GPT (one source says "GPT 5.5") caught a higher share of high-severity bugs than Opus. Opus wins on Codex PRs. Codex reviews average 1–2 comments, Opus 7–8 (more intent, style and praise). Labelled experimental. | https://www.greptile.com/blog/model-inversion ; https://www.greptile.com/changelog | vendor |
| Aug 2026 | V5 orchestrates open models (served on Together AI) alongside frontier models | https://www.together.ai/customers/greptile | vendor (Together) |
| 2026 | API "genius" mode selects "a larger, more accurate model", is about 8–10 s slower, and costs more per query | https://apis.io/apis/greptile/greptile-query-api/ ; https://docs.sim.ai/tools/greptile | vendor spec / secondary |
| 2026 | Self-host roles: smart (Sonnet 4.5+ or GPT-5.x/6.x), fast (Haiku 4.5, GPT-5 nano, 4o-mini), embeddings (text-embedding-3-small, Titan V2) | https://www.greptile.com/docs/deployment-options | vendor |

No exact current production model IDs were found for the cloud product after the Opus 4.5 statement.

---

## 5. Surfaces

### 5.1 REST API (legacy codebase-QA API, still documented)
- Base `https://api.greptile.com/v2/`. Auth: `Authorization: Bearer <key>` plus `X-Github-Token`. Endpoints: `POST /repositories` to index; `GET /repositories/{remote:branch:owner/repo url-encoded}` for status (a `sha` field means indexed); `POST /query` (a messages array, repositories, an optional `sessionId` to keep conversation, an optional `genius`); `POST /search` (code references with no generated answer). Sources: https://docs.greptile.com/quickstart ; https://docs.greptile.com/api-reference/introduction [vendor].
- No public code-review API endpoint was found. Reviews are triggered through the SCM app, `@greptileai` mentions, the MCP `trigger_code_review` tool and the CLI. The API examples repo was archived on 2026-08-20 [vendor repo state]. [inference] The API is a 2024 product line that has been de-emphasized.

### 5.2 MCP server
- URL `https://api.greptile.com/mcp`, OAuth auth (https://www.greptile.com/docs/mcp-v2/overview ; https://www.greptile.com/docs/mcp-v2/setup) [vendor].
- Tools named in listings: `list_pull_requests`, `get_merge_request`, `list_merge_request_comments`, `list_code_reviews`, `get_code_review`, `trigger_code_review`, `search_greptile_comments` (case-insensitive substring search over Greptile comments), and the custom context tools `list_custom_context`, `search_custom_context`, `get_custom_context`, `create_custom_context`. Knowledge-base read tools were added 2026-09-16. Composio lists 21 tools. Sources: https://www.greptile.com/docs/mcp-v2/custom-context ; https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/greptile ; https://composio.dev/toolkits/greptile_mcp [vendor/secondary].
- Use: coding agents fetch Greptile comments, apply fixes and resolve threads (the "auto-fix workflow", https://www.greptile.com/docs/mcp-v2/auto-fix) [vendor].

### 5.3 Claude Code plugin and agent skills
- Open-source skills at `github.com/greptileai/skills`:
  - `/greptile:check-pr` reads PR comments, fixes, commits, pushes and resolves threads.
  - `/greptile:cli-review`.
  - `/greptile:greploop` loops "trigger review, fix, push, wait" until there is a 5/5 confidence score and zero unresolved comments.
- Install with `/plugin marketplace add greptileai/skills`. Requires Claude Code v2.1+ and Node 22+. Also listed in Anthropic's official plugin marketplace. Sources: https://www.greptile.com/docs/mcp/skills ; https://www.greptile.com/docs/integrations/claude-code ; https://claude.com/plugins/greptile [vendor].

### 5.4 CLI and Bridge
- `greptile review` compares committed changes on the current branch against the default branch and ignores uncommitted edits. Options: `--branch`, `--resume`, `--diff`, `--json`, `--agent` (plain output for agents), and `greptile review status` for hooks. The docs cover CLI v3.2.3. Sources: https://www.greptile.com/docs/code-review/greptile-cli ; https://www.greptile.com/cli [vendor].
- Greptile Bridge routes fix requests from GitHub to the developer's local coding agent (https://www.greptile.com/changelog) [vendor].

### 5.5 IDE
- The VS Code extension (`greptileai/greptile-vscode`) is marked deprecated. The IDE strategy is now MCP plus agent skills (https://github.com/greptileai/greptile-vscode) [vendor repo state].

### 5.6 SCM and deployment
- SCMs: GitHub (Cloud, Enterprise Server, EMU/data residency), GitLab (.com and Self-Managed), Bitbucket (Cloud and Data Center), Gitea, Perforce and "Cursor Origin". Azure DevOps is not listed. Older docs said no Bitbucket or Perforce. Source: https://www.greptile.com/docs/integrations/code-providers [vendor].
- Self-hosting:
  - Docker Compose for up to about 100 developers, Kubernetes/Helm for more.
  - The `greptileai/akupara` repo holds the Helm charts plus a Terraform stack for EKS. Hatchet is installed as a separate Helm release.
  - Needs Postgres with pgvector. PgBouncer is bundled.
  - Needs an LLM provider key, plus a GitHub App or GitLab OAuth.
  - Sources: https://www.greptile.com/docs/deployment-options ; https://github.com/greptileai/akupara ; https://www.greptile.com/docs/self-hosting/kubernetes [vendor].

---

## 6. Evaluations: vendor vs independent

- Greptile's July 2025 benchmark gave it 82%, ahead of Cursor 58%, Copilot 54%, CodeRabbit 44% and Graphite 6%. It is vendor-run, has a small sample (50 bugs), and does not score false positives (https://greptile.com/benchmarks) [vendor].
- **Martian Code Review Bench** is independent and open source (https://github.com/withmartian/code-review-benchmark). Its offline track uses 50 PRs from the same 5 repos with 136 golden comments (another count says 173) and an LLM judge. An online track uses merged OSS PRs and a rolling window.
  - Greptile claimed #1 at 60.8% F1 on 2026-07-30 (https://www.greptile.com/content-library/greptile-martian-code-review-benchmark) [vendor citing independent].
  - Later readings put Greptile at 62.3% F1, second, with the highest precision at 80.5% (https://www.aicodereviews.io/blog/martians-code-review-bench-the-1-claim-rots-in-months/) [secondary].
  - On 2026-10-04: Greptile 61.9% vs CodeRabbit 61.8% (https://www.cubic.dev/blog/coderabbit-vs-greptile) [vendor-competitor reading of independent data].
  - On 2026-10-10: cubic 64.0, Kody 63.4, Greptile 63.2 (https://www.cubic.dev/best-ai-code-review-tools) [vendor-competitor].
  - Paper using Martian as independent validation: https://arxiv.org/pdf/2606.15689 [research].
  - [inference] The offline set reuses Greptile's 2025 repo selection. Check whether that gives Greptile a home-field advantage.
- Competitor-run benchmarks:
  - Augment re-ran the same 5 repos with a rebuilt answer key: Greptile 45% F (45% precision and recall), CodeRabbit 39% (https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results).
  - Tenki: Greptile recall 36.1%, F1 22.1 vs CodeRabbit 28.7% recall, F1 26.7 (https://tenki.cloud/benchmarks/code-reviewer).
  - Entelligence on Cal.com: Greptile F1 47.4% vs CodeRabbit 46.0% (https://entelligence.ai/code-review-benchmark-2026).
  - Another comparison counted Greptile at 11 false positives vs CodeRabbit's 2 across 50 PRs, but with high precision because Greptile also produces many true comments (https://www.morphllm.com/comparisons/greptile-vs-copilot) [secondary].
  - All of these are [vendor-competitor] or [secondary].
- Overall [inference]: across independent and competitor measures, Greptile sits at or near the top on precision and F1, in a tight pack (about ±2 F1 points), with the lead changing month to month. Its own 82% catch rate should not be compared with F1 numbers.

---

## 7. Implications for Vectorscope

Vectorscope today (from `packages/core/src/review/*`):
- a `review` specialist, plus a `security` specialist when sensitive paths change;
- an inlined diff budget of 30% of the context left after a reserve;
- regex-based changed-symbol extraction plus grep for callers (`symbols.ts`);
- location- and title-based dedupe and noise control (`select.ts`, `fingerprint.ts`);
- "Don't flag this again" repo rules;
- a monthly cost cap.

Mapped against Greptile:

1. **Replace regex symbols with a tree-sitter symbol and edge graph built on the fly** for the PR's touched files plus their callers and callees. This matches Greptile's v2 graph (functions, classes, calls, imports) without a persistent index. [inference]
2. **Hypothesis fan-out instead of fixed specialists.** v5's biggest vendor-reported gains (median latency halved, addressed rate 52% to 66%) come from one cheap pass that proposes candidate bugs, then parallel narrow agents that each verify or refute one hypothesis with tool access. Vectorscope's `review`/`security` split is a coarse form of this. A verify-per-hypothesis stage would also be the main false-positive filter. [vendor + inference]
3. **Scale compute with PR size and risk (an Auto tier).** Greptile's tier chart shows the quality gap growing with changed-file count. Vectorscope already has cost planning (`plan.ts`), so it can raise the hypothesis or sub-agent budget for large or high-risk PRs within the monthly cap, instead of truncating the diff. [vendor + inference]
4. **Cross-family review (Model Inversion).** Detect the authoring agent from commit trailers, branch prefixes and PR titles (Vector's own sessions already know which model they used) and route review to a different provider family where one is configured. Cheap to add, and backed by Greptile's 1,000-PR study (vendor). [vendor + inference]
5. **Prompt-cache-friendly structure.** Greptile used about 3x more context in v3 but cut self-host inference cost by 75% at about 90% cache hits. Keep a stable prefix (system prompt, rules, repo map) and put the diff and tool results after it. Vectorscope's `ReviewPrice.cacheRead` field suggests this is already modeled; check real hit rates. [vendor + inference]
6. **A small persistent "repo wiki" is the next step after a graph.** Greptile's 2026 position is that grep plus file reads waste most tokens, so it keeps module docs with past-bug and risk notes. For Vectorscope (which runs in GitHub Actions), a cached per-repo summary artifact on the default branch, refreshed incrementally by changed paths and keyed by sha, would copy this without a server. Past accepted findings can be written into it as "risk areas". [vendor + inference]
7. **Feedback learning by embedding similarity.** Greptile's 2024 change from prompt-based severity filtering to embedding past downvoted comments and suppressing look-alikes took the address rate from 19% to 55%. Vectorscope's "Don't flag this again" rules are the explicit version. Adding similarity matching against dismissed findings (title plus code embedding) would generalize them. [vendor + inference]
8. **Auto-ingest existing agent rule files** (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) and support directory-scoped rules where the closest directory wins. Greptile found auto-detection beat asking users for a new format. [vendor]
9. **Output conventions worth copying:** a 1–5 merge-confidence score, a separate comment for issues outside the diff, a copyable fix prompt per finding, and a "greploop" mode where Vector's own agent iterates until the review is clean. Vector already owns the coding agent, which is an advantage over Greptile's Bridge and MCP workaround. [vendor + inference]
10. **Measure the way Greptile does, and also the way the independent benchmark does.** Greptile's version metrics are addressed rate (LLM-judged), addressed comments per PR, positive replies per PR, upvotes per PR and median latency. For an external check, run Vectorscope on Martian's offline set (`withmartian/code-review-benchmark`, 50 PRs, golden comments). The scratchpad already has a `martian-repo` directory, so this may be underway. [independent + inference]
11. **Execution (TREX-style) is a later, optional layer.** Greptile claims +20% bugs with no published eval. It needs sandboxes; Firecracker is what the talk's DIY recipe uses. Within GitHub Actions, the cheap version is letting a verifier sub-agent run the repo's existing tests or a scratch script in the job container. [vendor + inference]

---

## 8. Open questions (unverified because pages could not be fetched)

- Exact v3, v4 and v5 tool lists, and whether v4 changed the model or only prompts and tools.
- Which open models run on Together, and for which subtasks (summarization? hypothesis generation? verification?).
- The current cloud production models after Opus 4.5. Does Model Inversion now route between Opus 4.x and GPT-5.x by default?
- The re-index trigger and latency on default-branch pushes. Are dependents' summaries and graph edges recomputed on change?
- Whether a hard file or line cap still exists for Base-tier reviews, and how v5 splits very large diffs across hypothesis agents.
- How hypotheses are generated in v5 (one planner pass? per-file?) and how many agents a typical PR spawns per tier.
- Embedding model and dimensions in the cloud product. Is pgvector also used in the cloud, or only self-hosted?
- Whether the Martian offline set derives from Greptile's own 2025 benchmark set (same 5 repos), and whether that biases results.
- The definitions behind the Plus and Apex chart metric and the changes in the "addressed" baseline across the v4 and v5 posts.
