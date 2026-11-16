# Round two, angle: large-codebase context in industry

Prepared 2026-11-06. Scope: how code-review and coding tools find the right context in very large repositories, and which well-evidenced techniques VectorScope does not yet plan. VectorScope today uses regex `changedSymbols`, `git grep -n -w -F` at head (10 symbols x 15 hits, 200 chars each), `git log`/blame history, and agents with read/grep/glob/list tools (`vectorscope-today.md` §2.3). VS-25 (proposed) adds a pinned tree-sitter impact slice: enclosing definitions, import-gated dependents, `BrainGraph.rank`, signatures and call-site windows (±3 lines) in at most 15% of context and 6k tokens.

## 0. How this round was run, and its limits

- **Network.** Only `raw.githubusercontent.com`, `api.github.com` (for some repositories) and git over HTTPS were reachable. WebFetch could not resolve cursor.com, github.blog, zenml.io or plushcap.com, and curl through the proxy failed for augmentcode.com, coderabbit.ai, qodo.ai, sourcegraph.com, arxiv.org (all mirrors), huggingface.co, semanticscholar.org, openreview.net, dl.acm.org, web.archive.org, news.ycombinator.com, docs.github.com, docs.cursor.com, docs.augmentcode.com, docs.coderabbit.ai and docs.qodo.ai. The GitHub API refused `github/docs` and `continuedev/continue` for this session, so I read them through raw.githubusercontent.com and shallow git clones.
- **Search.** WebSearch worked until the turn's shared 200-search budget ran out, partway through the Augment code-review internals. **Most vendor and paper figures below are therefore search-engine extracts, not full reads**, and are marked "(search extract)". Code I read myself is marked **code**.
- **Labels.** *vendor*: the company about itself. *independent*: a third party measured it. *academic*: a paper or preprint. *code*: read in source at the SHA given. *community*: user reports. *inference*: my reasoning.
- **Naming.** Open-source coding-agent CLIs and harnesses are referred to generically.

---

## 1. The vendors, one by one

### 1.1 Cursor (indexing, semantic search, Instant Grep, Bugbot)

**Indexing and incremental sync (vendor, search extract).** The post "Securely indexing large codebases" (cursor.com/blog/secure-codebase-indexing, 2026-01-27) describes the following:
- The client builds a Merkle tree of file hashes and compares it with the server's tree to find exactly which subtrees diverged, so only changed files are re-chunked and re-embedded.
- **Index reuse across teammates.** The client derives a simhash from its Merkle tree. The server searches the simhashes of the other indexes held by the same team or user, and copies the closest one above a similarity threshold as the starting index. The client can query immediately, but sees results only for files whose hashes it can prove it holds ("content proofs", deleted once the roots match).
- Reported effect on time-to-first-query (German and Korean versions of the post, via search extract):

  | Percentile | Before | After |
  |---|---|---|
  | median | 7.87 s | 525 ms |
  | p90 | 2.82 min | 1.87 s |
  | p99 | 4.03 h | 21 s |

  The-Decoder's "four hours to 21 seconds" is the same p99 figure (the-decoder.com, 2026).

**Semantic search's measured value (vendor, search extract).** "Improving agent with semantic search" (cursor.com/blog/semsearch, Nov 2025):
- Accuracy on Cursor's internal Context Benchmark rose by 12.5% on average (6.5–23.5% depending on the model).
- **In the online A/B test the effect was small:**
  - agent code retention rose 0.3% overall;
  - in codebases with 1,000 or more files it rose 2.6% (stated in the translated versions of the post);
  - dissatisfied follow-up requests fell 2.2%.
- Cursor says grep plus semantic search together gives the best results, and trains its embedding model on agent traces, aligning similarity with LLM-ranked relevance.

The lesson: embeddings help mostly in large codebases, mostly alongside grep, and the online lift is small.

**Instant Grep (vendor, search extract).** "Fast regex search: indexing text for agent tools" (cursor.com/blog/fast-regex-search, 2026-03-23):
- A client-side inverted index over sparse n-grams, whose boundaries are chosen from character-pair frequency weights. It is seeded from the current git commit, with user and agent edits layered on top.
- On an enterprise monorepo, regex search dropped from 16.8 s (ripgrep) to 13 ms locally, or 243 ms with a network round trip (secondary write-ups: analyticsindiamag.com, swequiz.com, agentpatterns.ai, 2026).
- The motivating fact is that ripgrep must scan every file, which took 15+ seconds in big monorepos.

**Bugbot (vendor, search extract).** Cursor has published no write-up of how Bugbot retrieves context (limited search):
- June 2026: about 90 s per review, about 22% cheaper, about 10% more bugs; an incremental review that looks only at new commits.
- May 2026: Default, High and Custom effort levels.

### 1.2 Augment Code (Context Engine, Code Review)

**Real-time per-user index (vendor, search extract).** "A real-time index for your codebase: secure, personal, scalable" (augmentcode.com/blog, 2025-01-01):
- One index per developer, so branch switches are handled, updated "within seconds" of a change; Augment contrasts this with competitors' 10-minute delays.
- **Proof of possession:** the IDE must send a file's hash before the backend will return content from that file. Augment gives this as a reason for building its own embedding search.

**Scale (vendor, search extract).** "How we made code search 40% faster for 100M+ line codebases using quantized vector search" (augmentcode.com/blog/repo-scale-100M-line-codebase-quantized-vector-search, 2025-06-11):
- Code embeddings need 20+ bytes per line of code to store and 20+ ns per line to search.
- At 100M lines: memory went from about 2 GB to 250 MB, and latency from over 2 s to under 200 ms, with "99.9%" accuracy on typical queries (the measure is not defined).
- The quantized index is built in the background. Until it is ready, search falls back to exact embedding similarity, and an older index serves while a new one builds.

**Context Engine as MCP (vendor, search extract).** GA on 2026-02-06 (augmentcode.com/blog/context-engine-mcp-now-live; siliconangle.com 2026-02-06):
- Claimed improvements of 70%+, broken down as Claude Code + Opus 4.5 +80%, Cursor + Opus 4.5 +71%, Cursor + Composer-1 +30%.
- These are on Augment's own five-dimension rubric (correctness, completeness, best practices, code reuse, unsolicited documentation), not a public benchmark. No independent replication was found (limited search).

**Augment Code Review (vendor, search extract).** Launched 2025-12-11 (augmentcode.com/changelog/introducing-augment-code-review):
- On its re-run of Greptile's 50-PR set it reports about 65% precision, 55% recall and 59% F-score. Its table gives Bugbot 60/41/49, Greptile 45/45/45, Codex review 68/29/41, CodeRabbit 36/43/39, Claude Code 23/51/31 and Copilot 20/34/25.
- The product page says 54% recall, so the figures disagree slightly between pages.
- It credits the Context Engine "consistently retriev[ing] the right files, dependencies, and call sites" for its recall, with GPT-5.2 as the model.
- The March 2026 "How we built a high-quality AI code review agent" names three essentials: context beyond the PR, agent design, and evaluation loops. It gives the agent **semantic retrieval, file browsing and symbol search, with "minimal overlap" between them**, and folds guidelines into the prompt. The search budget ran out before I could read the rest.
- Note the conflict with Martian, where Copilot-v2 scored P 0.41 / R 0.66 (round one): Augment's table puts Copilot far lower. Vendor tables are not comparable.
- An aggregator claims Harness acquired Augment assets in Oct 2026 (aicodereview.cc). This is unverified.

### 1.3 Sourcegraph (SCIP, Search, Cody, Deep Search, MCP)

- **Cody Enterprise dropped embeddings for Sourcegraph Search** (vendor). The FAQ (sourcegraph.com/docs/cody/faq) gives two reasons: retrieval that scales across many and larger repositories, and a system that is secure and needs little admin maintenance. The earlier blog "How Cody understands your codebase" says keeping embeddings current "introduces complexity that Sourcegraph admins have to manage". Secondary sources say this happened around 5.3 and that the replacement was an adapted BM25F; that detail is unverified, but the code below shows a BM25F scorer in Zoekt.
- **Zoekt ranking** (**code**: github.com/sourcegraph/zoekt at `a5a933b`, 2026-11-03, `index/score.go`):
  - `scoreFileBM25` and `scoreLineBM25` use Lucene's BM25 defaults and treat IDF as constant.
  - Filename matches and symbol-definition matches count `importantTermBoost = 5` times a content match.
  - "Low priority" files (tests, generated code) have their term frequencies divided by `lowPriorityFilePenalty = 5`, which the comment calls a BM25F-style field at half priority.
  - The design doc (`doc/design.md`) uses positional trigrams with posting lists on SSD. It needs about 1.2x the corpus size in RAM and "can easily be made incremental".
- **The Cody RecSys'24 paper** (academic, search extract): "AI-assisted Coding with Cody: Lessons from Context Retrieval and Evaluation for Code Recommendations", arXiv 2408.05344, Aug 2024.
  - It frames context as a two-stage recommender: retrieval optimises recall from several sources (keyword, semantic, similarity, code graph), and ranking optimises precision for the LLM.
  - Sources work best when they return distinct items.
  - There is no ground truth for "good context", so retrieval, ranking and the LLM are evaluated separately as well as end to end.
- **Cody's context fusion** (**code**: github.com/sourcegraph/cody-public-snapshot at `8e20ac6`, 2025-08-01):
  - `reciprocal-rank-fusion.ts` fuses retrievers with RRF at `RRF_K = 60`. The retrievers are graph identifiers, Jaccard windows, an "lsp-light" retriever, recent user actions and a `tsc` retriever.
  - The `tsc` retriever emits the **signatures of symbols the edited code references** (for example a parameter type `Animal`) at a configurable "symbol depth". Depth 1 gives referenced signatures; depth 2 also expands the types inside them, and the comment warns that recursion "quickly goes out of hand".
  - It is capped by `maxNodeMatches`, `maxSnippetsPerNodeMatch` and `maxTotalSnippets`, and skips symbols already in the file.
- **Deep Search and MCP** (vendor, search extract; sourcegraph.com/blog/deep-search, sourcegraph.com/mcp, 2025–2026):
  - Deep Search is an agent loop over regex and structural search, git history and SCIP-backed go-to-definition and find-references across repositories, with cited answers.
  - The MCP server exposes these tools to external agents (Enterprise plans only).
- SCIP itself was covered in round one (enablers §2.2: precise, but needs a build).

### 1.4 GitHub Copilot (semantic index, code review)

- **Repository semantic index** (**code**, docs source: github/docs at `17d6ee5`, 2026-11-05, `content/copilot/concepts/prompting-and-context/repository-indexing.md`):
  - Initial indexing "can take up to 60 seconds for a large repository", and re-indexing then updates "within seconds".
  - The listed consumers are Copilot Chat and the cloud agent. **Copilot code review is not listed.**
  - The code-review page instead describes "full project context gathering" by agentic tools on Actions runners, and "a more limited review" when runners are unavailable (round one confirmed).
  - Agentic tool calling for review went GA on 2026-03-05 (github.blog changelog, search extract).
- **New embedding model** (vendor, search extract; github.blog/news-insights/product-news/copilot-new-embedding-model-vs-code, about Sep–Oct 2025; InfoQ 2025-10):
  - 37.6% higher retrieval quality, about 2x throughput and an 8x smaller index;
  - the average embedding score rose from 0.362 to 0.498;
  - trained with InfoNCE plus Matryoshka representation learning and LLM-mined hard negatives (code that "looks correct but isn't").
- **Inference.** Even GitHub, which has a semantic index, reviews by letting an agent gather context on a runner. That is VectorScope's own CI model.

### 1.5 CodeRabbit

All of the following is vendor, search extract:
- CodeRabbit builds a dependency graph on every review rather than reading a pre-built index, and aims for a **1:1 ratio of code to context** in prompts ("Context Engineering: Level up your AI Code Reviews", coderabbit.ai/blog, Jul 2025).
- A Medium analysis says the graph is rebuilt fresh because pre-built indexes go stale, and that LanceDB holds cross-PR memory and learnings rather than code (medium.com/data-science-collective, 2026; community analysis).
- LanceDB's own case study claims "millisecond" search over "hundreds of thousands of tables" (lancedb.com/blog/case-study-coderabbit, 2025; vendor of a vendor).
- Multi-repo analysis (Mar 2026) and automatic repository linking (Jun 2026) inspect linked repositories for downstream impact, and **list the repositories considered in a "Review info" section** (coderabbit.ai/blog/Coderabbit-multi-repo-analysis; coderabbit.ai/blog/automatic-repository-linking-cross-repo-context).
- CodeRabbit maintains an ast-grep rule pack for reviews (**code**: github.com/coderabbitai/ast-grep-essentials at `7312010`).
- I could not confirm the claim that CodeRabbit generates verification scripts in a sandbox.

### 1.6 Qodo

All of the following is vendor, search extract:
- "Qodo Aware" has been renamed the Context Engine. It indexes several repositories at once and draws on past PRs and earlier review decisions (qodo.ai/features/qodo-context-engine).
- A third-party review says re-indexing runs "typically every few hours" (community).
- Qodo 2.0 (2026-02-05): specialist agents plus a judge agent that resolves conflicts, removes duplicates and filters out low-signal results. It reports F1 60.1% and recall 56.7% on Qodo's own injected-bug benchmark (qodo.ai/blog/introducing-qodo-2-0).
- Qodo 3.0 is reported for 2026-10-01 (theaiagentindex.com; unverified).
- Qodo's 2024 RAG post (qodo.ai/blog/rag-for-large-scale-code-repos):
  - chunks of about 500 characters, split by static analysis;
  - large classes indexed per method, **each chunk carrying the class definition and relevant imports**;
  - natural-language descriptions added to the embeddings;
  - **filtering at repository level before chunk search**, to cut noise across thousands of repositories.

### 1.7 Bito

- **AI Architect** (vendor) builds a knowledge graph of repositories, modules, APIs and dependency flows and serves it over MCP. Its local mode hashes each repository and skips unchanged ones on re-index (docs.bito.ai/ai-architect/local-repository-intelligence-for-ai-assistants, search extract).
- **SWE-Bench Pro** (vendor; the evaluator "The Context Lab" is described by Bito as an independent third party, but the results appear only in Bito's marketing):
  - 293 tasks from the five largest repositories. Claude Sonnet 4.5 went from 43.6% to 60.8%, with **50% fewer tool calls, 44% lower cost and 27% faster runs**.
  - A later run took Opus 4.6 from 51.9% to 70% (bito.ai/blog/swe-bench-pro-evaluation; press release Feb 2026; follow-up about May 2026).
- Bito's run on Martian produced no comments (round one).

### 1.8 Graphite

Graphite's marketing describes "full codebase context" through RAG over project history (graphite.com/guides, vendor). A third-party comparison says its context is shaped by the diff (dev.to/pickuma, 2026, community). This is still unresolved, and round one's open question about how Graphite's Martian run was configured remains open.

### 1.9 Google and Meta (published internal systems)

- **Meta Glean** (**code**: github.com/facebookincubator/Glean at `ce5a6ef`, 2026-11-05, `glean/website/blog/2022-12-01-incremental.md`; vendor blog engineering.fb.com 2024-12-19):
  - Incremental indexing stacks a new DB on the base DB. It hides the base facts owned by changed "units" (files) and adds the new facts, with the goal of O(changes) rather than O(repository).
  - Ownership sets are propagated through fact references, so that hiding never leaves dangling references, at a cost of about 7% of DB size.
  - Meta uses Glean for navigation in code review (Phabricator).
  - A third-party wiki summarises Meta's framing as O(fanout) per diff (sysdesign-wiki, 2025); that is unverified.
- **Meta RADAR** (academic, search extract; arXiv 2605.30208, May 2026): automated review and landing for low-risk diffs.
  - The funnel: eligibility model, static heuristics, Diff Risk Score percentile thresholds, LLM review (auto-accept only at confidence ≥8/10 with every change classed safe), then deterministic validation.
  - Results: 535K+ diffs reviewed and 331K+ landed. The revert rate is 1/3, and the production-incident rate 1/50, of non-RADAR diffs. This is confounded by selection, because RADAR only takes low-risk diffs.
  - The DRS paper is arXiv 2410.06351 (Oct 2024); the production write-up is engineering.fb.com 2025-08-06.
- **Meta, "Agentic Code Reasoning"** (academic, search extract, 2026; venturebeat.com, devops.com):
  - Semi-formal "certificates" (explicit premises and execution traces) reached 93% patch-equivalence accuracy without execution, against 86% unstructured; Defects4J top-5 fault localisation improved by 5–12 points.
  - The cost is about 2.8x the steps.
  - The approach **struggles when third-party library source is missing**, which is a context gap.
- **Meta MetaMateCR** (academic, arXiv 2507.13499, FSE 2026 industry track): fixes *for* review comments, not review itself. Out of scope.
- **Google AutoCommenter** (arXiv 2405.13565, 2024): a T5 model that flags best-practice violations, rolled out in stages, with thumbs feedback. Google's 2023 report that 7.5% of reviewer comments were resolved by an ML-suggested edit is older (search extract).
- **I found no 2025–2026 Google paper on how an LLM reviewer retrieves context in Critique** (limited search). Kythe is Google's build-instrumented cross-reference graph and was not checked further.

### 1.10 Other industrial reviewers

- **Uber uReview** (vendor, search extract; uber.com/blog/ureview, Aug 2025):
  - it filters out low-signal targets first (configuration, generated code, experimental directories);
  - prompts include nearby functions, class definitions and imports;
  - review runs in four stages: generate, filter, validate, dedup;
  - 75% of comments are marked useful and 65% addressed (internal measures).
- **Atlassian RovoDev Code Reviewer** (academic; arXiv 2601.01129, ICSE 2026):
  - deployed for a year over 1,900+ repositories, producing 54k+ comments; 38.70% led to a code change;
  - Atlassian's blog adds a 30.8% faster cycle and 35.6% fewer human comments (vendor);
  - **the paper names unknown context as a cause of incorrect or non-actionable comments**.

---

## 2. What the 2025–2026 research says about context for review

1. **More retrieved files can hurt, and how much depends on the model** (academic, search extract of Table 7).
   - CodeFuse-CR-Bench (arXiv 2509.14856, Sep 2025; 601 instances, 70 Python projects) compares BM25 top-1, top-3 and top-5 retrieved files with an oracle context. Scores:

     | Model | Oracle | BM25 top-1 | BM25 top-5 |
     |---|---|---|---|
     | Gemini 2.5 Pro | 52.37 | 52.24 | 51.63 |
     | Claude Sonnet 4 | — | 51.02 | 41.91 |
     | GPT-4o | — | 39.34 | 31.13 (the extraction glitched; treat as approximate) |

   - **Inference:** the right context depth is model-specific, and the top-ranked item does most of the work.
2. **The context level human comments need** (academic, search extract).
   - AACR-Bench (arXiv 2601.19494, Jan 2026; 200 PRs, 1,505 comments, 50 repositories, 10 languages; github.com/alibaba/aacr-bench) splits the comments by the context they need:
     - **754 (50%) can be made from the diff hunk alone;**
     - **518 (34%) need the whole containing file;**
     - **233 (15%) need repository-wide context.**
   - The level of context and the retrieval method "significantly impact" results, and the effect varies by model, language and whether an agent is used. The direction of the effect was not in the extracts.
3. **Long inputs degrade code reasoning** (academic, search extract).
   - LongCodeBench (arXiv 2505.07897, May 2025): Claude 3.5 Sonnet fell from 29% to 3%, and Qwen2.5 from 70.2% to 40%, as context grew toward 1M tokens.
   - Chroma's "Context Rot" report (trychroma.com/research/context-rot, 2025-07-14) found that reliability falls with input length across 18 models.
   - This is the academic backing for round one's Tier C warning ("more context can hurt").
4. **Semantic search versus agentic search** (academic, preprints, search extract):
   - On SWE-QA (720 questions, 15 Python repositories, 4 models), semantic search answered 65.2% correctly against 46.2% for deep agentic search, at under half the cost per correct answer. **41.8% of the agentic failures happened at the hand-off between planner and sub-agent, usually silently** (arXiv 2608.01507, Aug 2026).
   - A source-code study of 11 coding-agent harnesses found **none uses vector RAG over code**; all use ripgrep, glob, tree-sitter and Markdown context files (arXiv 2609.00006, 2026).
   - CORE-Bench (arXiv 2606.11864, Jun 2026, 180K queries) found that off-the-shelf embedders "drop sharply" on agentic retrieval, and that fine-tuning helps.
   - An RL-trained 14B retrieval agent added only +1.2 points on SWE-bench Verified, but cut tokens by 19% (arXiv 2608.05886).
5. **Language-server tools** (academic, preprint, search extract). In a five-arm ablation (arXiv 2608.13568, Aug 2026):
   - LSP retrieval improved precision on reference-finding tasks but **could not raise the recall ceiling set by how thorough the agent was**;
   - it saved tokens only for the weakest model;
   - one arm used the LSP zero times.

   Vendors' "5–34x fewer tokens" claims (agent-lsp, dev.to) are not controlled.
6. **Graph-guided localization** (academic, search extract):
   - LocAgent (ACL 2025), SWE-bench Lite with Claude 3.5: 94.16% file-level Acc@5 and 77.37% function-level Acc@10.
   - RepoGraph (ICLR 2025): +32.8% average relative resolve rate across four frameworks (third-party summary).

   Both are issue-solving results, not review results.
7. **Precomputed system context reduces exploration cost** (vendor only):
   - Bito: −50% tool calls, −44% cost;
   - Augment: "lower token costs";
   - Greptile: "tens of thousands of tokens" saved (round one).

   No independent measurement was found.

---

## 3. What VectorScope already matches, and where round one is extended or corrected

- **Confirmed.**
  - Per-review graph construction (CodeRabbit) and agentic gathering on a CI runner (Copilot) are mainstream, so VectorScope's runner model and VS-25's per-review slice are aligned.
  - Glean confirms enablers §2.7's "base facts plus a per-PR overlay of changed blobs".
  - Uber, RovoDev and PR-Agent all add the enclosing scope (nearby functions, class definition, imports).
- **Extended.**
  - Round one ranked "context heuristics for large repos" at Tier C on PR-Agent's warning alone. CodeFuse-CR-Bench and LongCodeBench now give academic evidence that extra context hurts, and that the harm depends on the model.
  - Round one listed Augment's pipeline as unknown. It is now known in outline: a Context Engine plus semantic, file and symbol tools, on GPT-5.2.
  - Round one had none of Cursor's indexing figures; it now has them, from search extracts.
- **Corrected or qualified.**
  - Round one implied the index question is settled by tree-sitter plus SCIP. Industry practice splits: IDE products (Cursor, Copilot Chat, Augment) rely on embeddings, while reviewers and harnesses lean on lexical search, graphs and agent tools. Sourcegraph dropped embeddings at enterprise scale.
  - Vendor review benchmarks disagree sharply. Augment's table puts Copilot at F 25; Martian puts Copilot-v2 at F1 0.50.

---

## 4. Techniques with the best evidence that VectorScope does not yet plan

Ranked by strength of evidence, then by fit with VectorScope's constraints (CI runner, no server, ZDR, I-4, untrusted data).

1. **Model-specific context depth, measured** (academic: CodeFuse-CR-Bench, LongCodeBench).
   - Today VS-25 caps the slice at 15% of context and 6k tokens for every model.
   - Proposal: make "how many dependents to pack" a per-model replay parameter, record the model alongside `ImpactSlice.locations`, and test top-1, top-3 and top-5 in Phase A. Do not assume more is better. Packing for Claude-family models is the most sensitive.
2. **An explicit tier for whole-file and enclosing definition, before cross-file context** (academic: AACR-Bench 34% vs 15%; industrial: Uber, RovoDev; code: PR-Agent's dynamic context).
   - VS-25b finds enclosing definitions but packs only *dependents'* signatures and call sites. Agents can read files, but the 34% of whole-file comments should not depend on the agent choosing to open the file.
   - Proposal: pack the full enclosing definition of each hunk, plus the changed file when it fits, ahead of the cross-file slice.
   - Label VS-22 cases by the context level they need (hunk, file, repo), as AACR-Bench does, so that VS-25's gate is read on the 15% bucket.
3. **Outbound signatures** (code: Cody's `tsc` retriever, symbol depth 1–2, capped; vendor: Augment's "type definitions, dependency chains").
   - VS-25 looks only at who depends on the change, not at what the change depends on.
   - Proposal: add the signatures (not bodies) of the functions and types that the changed lines reference, resolved through `BrainCode.resolve`, at depth 1, de-duplicated against what is already shown.
   - This is cheap with the tree-sitter references VS-25a already extracts. It also partly addresses Meta's finding that verifiers fail when library source is missing, if declaration files for dependencies are allowed in.
4. **Lexical ranking of candidates, fused with the graph rank** (code: Zoekt's BM25F boosts; Cody's RRF at k=60; an open-source IDE assistant's retrieve-2x-then-rerank, below; vendor: Sourcegraph replacing embeddings with search).
   - VS-25 step 2 produces an unranked `git grep -l` list, which step 4 ranks with PageRank only.
   - Proposal:
     - a deterministic score in which a definition hit counts more than a reference;
     - tests, generated and vendored files are divided by 5, as in Zoekt;
     - a reference from a file that imports the changed module counts more;
     - fuse it with `BrainGraph.rank` by RRF.

     It is pure and needs no model or network.
5. **Retrieval and packing scored separately** (academic: the Cody RecSys'24 paper).
   - VS-25's gate measures slice recall from the recorded locations.
   - Proposal: record two stages, candidate recall before ranking and packed recall after the budget, so a miss can be attributed to retrieval or to packing.
6. **A read-only symbol tool for the review agent** (vendor: Augment's "symbol search", Sourcegraph MCP, Copilot's agentic gathering; academic: LocAgent and RepoGraph for localization; caution: the LSP study).
   - The VS-25 slice is precomputed; the agents keep only read/grep/glob/list.
   - Proposal: expose the same import-gated definition and reference lookup as a tool.
   - Evidence that agents use it and that it saves tokens is weak, so keep the precomputed slice and log tool use in replay before making any claim.
7. **A shareable, content-addressed fact cache with a possession check** (code: Continue-style sha256 `cacheKey` plus branch tags and a global cache; Glean overlays; vendor: Cursor content proofs and simhash reuse, Augment proof of possession).
   - VS-25 already plans a blob-SHA cache and Actions caching after the @vector merge.
   - The additions:
     - reuse facts across branches whenever a blob SHA matches (as the open-source assistant's `addTag` does);
     - **serve facts only for blob SHAs present in the reviewed tree's `git ls-tree`**, so a shared cache can never leak facts about code that is not in this review;
     - key the cache on grammar and query version.
8. **Transparent context notes** (vendor: CodeRabbit's "Review info"; academic: RovoDev's unknown-context failure).
   - Add one line to review notes that lists which context sources ran, and which languages or files fell back to grep or were over budget.
   - Tell the model when a dependency's context was unavailable, rather than letting it guess.

**Not recommended now (inference).**
- Embedding indexes:
  - Online effects are small (Cursor +0.3% overall).
  - Evidence is mixed (the SWE-QA study favours semantic search; the harness study and CORE-Bench do not).
  - An embedding API sends code to another provider, which conflicts with ZDR routing and I-4.
  - VectorScope cannot train an embedder.

  The local Brain embeddings could be a later, local-only experiment.
- A trigram or n-gram index: only if replay shows `git grep` latency over budget on very large repositories (Cursor: 15+ s in monorepos). Zoekt is a Go binary, which is a distribution cost for a Bun tool.
- Quantized vectors: relevant only after embeddings.

---

## 5. Smaller notes

- Co-change ("files that change together", mined from git history) is a cheap ranking signal. The Zimmermann et al. 2005 ROSE result is recalled, not re-read. Augment's "Context Lineage" streams commit history into its index (vendor). VectorScope already fetches per-file history (10 files x 5 commits), so co-change could be a third RRF input, but it is weakly evidenced for review.
- Uber's step of filtering low-signal files before review mirrors `ignore.ts`, which already exists.
- SWR-Bench (arXiv 2509.01494, FSE 2026): aggregating several reviews raised F1 by up to 43.67%. That is relevant to the lenses angle, not to context.
- The "1:1 code-to-context" heuristic (CodeRabbit) is far looser than VS-25's 15%/6k cap. Neither has a published ablation; VS-25's Phase A could test both.
