# Round two, angle RR: repository-level retrieval research 2023-2026, and what it means for VS-25

Prepared 2026-11-06. Read-only against the worktree. Round one (`REPORT.md` §4.3-4.4, `enablers.md` §2, `evidence.md` §2) already covered: Greptile's docstring-then-embed design and its semantic-search experiment, a repo-map approach from an open-source coding-agent CLI (tree-sitter tags plus personalized PageRank), PR-Agent's hunk-to-function extension, SCIP and stack-graphs, the Martian cross-file recall gap (8-11 points, my re-analysis in round one), and AACR-Bench by name only. Round one said "context files are used everywhere, but no study measures their lift", and it listed the numeric results of AACR-Bench and the ICML 2025 Kuaishou paper as unreached. This note extends, corrects or confirms those points and adds the academic and benchmark literature round one did not cover.

## 0. Method, access and how far to trust this

- **Access.** arxiv.org, export.arxiv.org, ar5iv, huggingface.co, alphaxiv, the Semantic Scholar API, proceedings.iclr.cc, bytez.com, mdpi.com and an author's github.io site did not resolve: this session's network blocks them. github.com did resolve, so I read the authors' repositories where they publish numbers. Most paper numbers below come from **search-engine extracts of the paper text**, which often quote the abstract or the HTML version, plus third-party summaries. I mark which is which. Treat any number tagged "(extract)" as needing one check against the PDF once arXiv is reachable.
- **Search budget.** The shared WebSearch budget ran out partway through, after about 45 queries in this lane. These were planned and **not run**: SWE-bench memorization ("SWE-Bench Illusion"), CodexGraph's numbers, Long Code Arena's context composers, "Lost in the Middle", HippoRAG's PPR result, and "Cost-Effective Repository Exploration for Agentic Issue Localization" (arXiv 2608.29675). Where I mention one of them, it is labelled **recalled, unverified**.
- **Evidence labels.** academic (peer-reviewed or preprint), independent (third-party measurement), vendor, code (read in a repository), community. Two of these are new benchmark repositories with results tables in their README. I label those academic+code.
- **The transfer problem, stated once.** Most repository-retrieval research is about one of two tasks: *code completion*, where the query is a cursor position, or *issue localization*, where the query is a natural-language issue and the answer is the buggy file or function. PR review is a different retrieval problem. The anchor, the diff, is already known. What the reviewer needs is (a) the code the change affects, meaning reverse dependents and callers; (b) the code the change relies on, meaning forward callees and types; and (c) the intent, meaning PR and issue text. Localization results transfer mainly as evidence about *retrieval machinery*: graphs, ranking and budgets. The closest analogues to review are change-impact analysis, "edit-to-ripple" retrieval, comment-to-context retrieval, and the review benchmarks in §5.

## 1. Context length versus retrieval: the case for a small, ranked slice

**1.1 SWE-bench (Jimenez et al., ICLR 2024, arXiv 2310.06770, Oct 2023)** — academic (extract and secondary).
- With BM25 retrieval, Claude 2 resolved 1.96% of issues. With an "oracle" retriever, meaning the files the gold patch edits, it resolved 4.8%. GPT-4 resolved 0% with BM25 and 1.74% with the oracle.
- BM25 was run at several context limits: 13k, 27k, and 40k or 50k tokens. The two secondary sources disagree on the largest limit. Larger limits retrieve more of the oracle files, but resolution "often declines" (beancount.io research log, 2026-04-30, secondary; evalscope docs list 13K/27K/40K).
- **Transfer:** more recall from padding the context did not buy more task success. That is the earliest code-specific evidence for VS-25's hard cap.

**1.2 LongCodeBench (arXiv 2505.07897, May 2025)** — academic (extract).
- On the paper's LongSWE-Bench task, Claude 3.5 Sonnet's accuracy fell **from 29% to 3%** as context grew from 32K to 256K tokens. Qwen2.5 fell from 70.2% to 40%.
- The ground-truth files are always present in that task. Only the distractors grow.
- RAG gave Claude 3.5 Sonnet positive scores on LongSWE-Bench but did not help on the QA task. The authors say the best strategy is task-dependent.
- **Transfer:** a bug-fixing task with the gold code in context degrades sharply as irrelevant code is added. This is strong support for packing a small, ranked slice rather than "send the whole module".

**1.3 Chroma "Context Rot" technical report (July 2025, research.trychroma.com/context-rot)** — independent (secondary summaries; primary not opened).
- 18 models were tested (GPT-4.1, Claude 4, Gemini 2.5, Qwen3). Task difficulty was held fixed while only input length grew, and accuracy fell in every model.
- A single semantically similar distractor reduced accuracy. Four reduced it more. The less similar the needle was to the question, the faster accuracy degraded.
- **Transfer:** call sites of a *different* function with the same name are exactly the kind of semantically similar distractor that hurts. This is the strongest general argument for VS-25's import gate as a precision filter.

**1.4 Hierarchical Context Pruning (HCP; Zhang et al., AAAI 2025, arXiv 2406.18294, Jun 2024)** — academic (extract); code at github.com/Hambaobao/HCP-Coder (README has no numbers).
- Only dependency files at **level 1**, meaning files directly imported by the current file, "significantly enhance completion accuracy". Deeper levels did not.
- "Pruning the specific implementations of functions in all dependent files does not significantly reduce the accuracy of completions." Global context in dependency files could also be removed without loss.
- Prompts stayed around **8k tokens**, against about 50k for the full repository, and beat the earlier methods on 5 of 6 code LLMs. The repository's example configuration is top-k 5, top-p 0.3.
- **Transfer:**
  - This supports VS-25's choice of signatures plus call-site windows over whole bodies, and an 8k-scale budget.
  - It also supports depth-1 neighbours over transitive closure.
  - Caveats: HCP's dependencies are *forward* (what the edited file imports), and the task is completion, not review.

**1.5 Repoformer (Wu et al., ICML 2024, arXiv 2403.10059)** — academic (extract); code at github.com/amazon-science/Repoformer.
- "A large proportion of the retrieved contexts" were "unhelpful or harmful" to code LMs.
- Learning *when* to retrieve gave up to 70% inference speedup "without harming the performance".
- **Transfer:** an empty slice is a legitimate outcome. VS-25 should not pad the 6k budget when the change touches no exported names.

**1.6 "What to Retrieve for Effective Retrieval-Augmented Code Generation?" (Gu et al., arXiv 2503.20589, Mar 2025)** — academic (extract).
- In-context code and API information "significantly enhance" performance.
- Retrieved *similar code* "often introduces noise, degrading results by up to 15%".
- A follow-up, arXiv 2607.24884 (Jul 2026), finds that retrieval utility depends on the interaction, not on a fixed ranking of sources.
- **Transfer:** structural context (definitions, signatures, callers) is preferred over similarity retrieval. This is a caution against adding Greptile-style "semantically similar functions" to the zero-token slice. Keep that as an agent tool the model chooses to call.

**1.7 CodeRAG-Bench (Wang et al., NAACL Findings 2025, arXiv 2406.14497)** — academic (extract).
- Gold documents lift GPT-4o by 27.4% on SWE-bench.
- The best retrieval-augmented setting stays about 9 points below gold.
- "Current retrieval models struggle to find useful documents", and generators have "limited context capacity and RAG abilities". Dense code embedders beat BM25.
- **Transfer:** the size of the prize is large when the right code is found, and the retriever is the bottleneck. This confirms that VS-25's measurable goal, slice recall at equal tokens, is the right primary metric.

**1.8 RepoCoder (Zhang et al., EMNLP 2023, arXiv 2303.12570)** — academic (extract).
- Iterative retrieve-generate improves the in-file baseline "by over 10% in all settings" on RepoEval.
- **Transfer:** the second retrieval round uses the model's own draft as the query. For review, the analogue is VS-25's Tier 2 keeping read tools: the slice seeds the model, and the model's hypotheses drive further reads.

**1.9 DraCo (Cheng, Wu, Hu, ACL 2024, arXiv 2405.19782)** — academic (extract).
- Dataflow-guided retrieval beat the previous best by 3.43% exact match and 3.27% identifier F1 on average.
- It argues that retrieval "by import relations or text similarity" is "insufficiently relevant" to the target.
- **Transfer:** this is a mild caution. Import relations are a good *filter*, while data flow is a better *relevance* signal. VS-25 uses imports as a gate and PageRank as the score, and neither is data flow.

## 2. Ranking under a token budget: what supports BrainGraph.rank and the 6k cap

**2.1 Agent Retrieval Bench (ARB; Qin and Xie, arXiv 2607.24882, Jul 2026)** — academic+code (README results table, github.com/eyuansu62/agent-retrieval-bench, read 2026-11-06).
- **Setup:** 427 real-workflow samples from 25 repositories. The task is to find the files an agent must read next, or to say that no local file helps. Workflow categories include `comment2context` (80 samples: a *review comment* plus a given file, and the agent must find the additional context files) and `edit2ripple` (an edit, and the files it ripples into).
- **Results on 345 positive samples:**

| Retriever | Recall@20 | MRR | BCY@8k |
|---|---|---|---|
| Qwen3-Embedding-8B | **0.703** | 0.234 | 0.373 |
| Repo map (PageRank over tree-sitter tags, from an open-source coding-agent CLI) | 0.633 | 0.216 | **0.379** |
| BM25 | 0.445 | 0.152 | 0.205 |

  BCY@8k is the fraction of gold files exposed when the output is packed into an 8k-token budget.
- The PageRank repo map is **best of all retrievers at an 8k budget**, ahead of an 8B embedding model, and far ahead of lexical search: 0.379 against 0.205 for BM25 and 0.265 for "Lexical".
- No retriever wins every workflow. The leader on `edit2ripple` (Recall@20) is an embedding model, and "the Qwen ordering reverses between fully packed 4k and 8k budgets".
- "Raw retrieval confidence is not yet a reliable repository-independent abstention signal."
- Caveats: the README says repo-map scores published before PR #3 may differ on rerun. The benchmark is file-level only.
- **Transfer (the most direct evidence for VS-25 found this round):**
  - PageRank ranking is competitive exactly where VS-25 operates: a small, fixed token budget.
  - Lexical candidate generation alone (`git grep`) is the weakest family.
  - Budget size changes rankings, so VS-25's 6k must be tuned, not assumed.
  - Abstention should be structural ("no exported name changed"), not a score threshold.

**2.2 ContextBench (Li et al., arXiv 2602.05892, Feb 2026)** — academic (extract and README, github.com/EuniAI/ContextBench).
- **Setup:** 1,136 issue-resolution tasks, 66 repositories, 8 languages, human-annotated gold contexts. Four LLMs and five coding agents.
- Block-level (definition-level) F1 is **below 0.45**, and line-level F1 is below 0.35.
- "LLMs consistently favor recall over precision", and "sophisticated agent scaffolding yields only marginal gains".
- There are "substantial gaps between explored and utilized context": agents open the right code and then do not use it.
- **Transfer:**
  - Agents left to themselves over-retrieve and under-use what they retrieve. A precise, pre-ranked slice is a reasonable complement to read tools.
  - VS-25 should also log whether Tier 2 *cites* slice blocks, measuring utilization and not only recall.

**2.3 Language server versus grep for agents (Xu, arXiv 2608.13568, Aug 2026)** — academic (extract), preliminary.
- Python and TypeScript repositories, with Claude Opus 4.8, Sonnet 4.6 and Haiku 4.5. The metric is tokens-to-success.
- For reference lookups, a language server gave **precision 1.00 against 0.76** for grep (no false call sites), but cost 12-19% *more* tokens for capable models.
- For symbol-name lookups, it raised tokens by 6-118%. Models defaulted to grep for localization (0-6% semantic-tool use).
- **Transfer:**
  - About a quarter of grep-found call sites were false in this setting. That is a measured size for the problem VS-25's "import-gated, parsed to confirm" step solves.
  - It also says to do the confirmation *deterministically before the model sees it*, because handing the model a semantic tool did not save tokens.

**2.4 Personalized PageRank evidence beyond code** — not verified this round. HippoRAG (NeurIPS 2024) used PPR for multi-hop retrieval (recalled, unverified). No peer-reviewed study found compares PageRank-seeded-on-changed-files with simpler ranking (in-degree, path distance) for review. ARB's repo-map row is the only measured point, and it is a file-level completion and agent-navigation benchmark.

## 3. Repository graphs and graph-guided localization (machinery evidence)

- **RepoGraph (Ouyang et al., ICLR 2025, arXiv 2410.14684)** — academic (extract); code at github.com/ozyyshr/RepoGraph.
  - A line-level graph with def/ref edges, plugged into four SWE-bench systems.
  - A third-party summary reports a 32.8% average *relative* improvement in resolve rate on SWE-bench Lite. Not verified against the paper.
  - The README's interface is `search_repo(name)` returning def and ref relations, which is what VS-25's `Definition` and `Reference` types already model.
- **LocAgent (Chen et al., ACL 2025, arXiv 2503.09089)** — academic (README read 2026-11-06).
  - A heterogeneous directed graph (contain, import, invoke and inherit relations in the paper; the README says only "directed heterogeneous graphs").
  - Up to **92.7% file-level accuracy** on SWE-bench Lite with a fine-tuned Qwen2.5-Coder-32B, about 86% lower cost than proprietary models, and +12% Pass@10 downstream.
- **CoSIL (arXiv 2503.22424, ASE 2025)** — academic (extract).
  - Builds module call graphs at file level, then function call graphs, with no index.
  - 43.3% Top-1 function localization on SWE-bench Lite and 44.6% on Verified (Qwen2.5-Coder-32B).
  - Feeding its localizations into Agentless raised resolution by 2.98-30.5% (v2).
- **SweRank (Salesforce, ICLR 2026)** — academic (extract) and vendor blog.
  - Embedding retriever plus LLM reranker. SweRankLLM-32B reaches 94.16% file Acc@5 against 86.07% for LocAgent with Claude 3.5. SweRankEmbed-Large reaches 82.12% function Acc@10 against 70.44% for the best prior retriever.
  - Python-first, and "not productized".
- **Agentless (Xia et al., 2024)** — academic (extract). Hierarchical file, then function, then line localization. Secondary sources disagree on its file-level accuracy: 35.3% versus 77.7%, versus about 62% Top-1 in a later comparison table. I did not resolve the discrepancy.
- **SWE-bench-Live (arXiv 2505.23419)** — academic (extract). Single-file fixes under five lines are solved about 48% of the time. Agents "struggle to coordinate coherent edits across multiple files".
- **Leakage caution (recalled, unverified; search budget exhausted).** "The SWE-Bench Illusion" (2025) reported that models can name the buggy file from the issue text alone far more often on SWE-bench Verified than on repositories outside it. A search extract (arXiv 2512.10218 listing) says high localization on Verified "likely reflects pretraining data overlap". VectorScope's own replay cases on private or recent PRs are therefore worth more than public localization numbers.
- **Transfer for PR review:**
  - Graphs with call and inherit edges consistently beat lexical-only retrieval, but every result here is issue-to-location with a natural-language query, mostly in Python.
  - What transfers is the representation (def/ref/import/invoke edges, function granularity) and the finding that cheap fine-tuned or embedding rankers can approach expensive agent search.
  - It does not transfer that "file Acc@5 of 90%" means review will see the impacted code.

## 4. Change-impact analysis and change propagation (the closest analogue to "what does this PR break")

- **GPT-5 for change-impact analysis (arXiv 2512.19481, Dec 2025)** — academic (extract).
  - The task: on 40 Java commits, predict the fully qualified entities a seed change affects, directly or indirectly.
  - GPT-5 scored precision **0.27**, recall **0.18**, F1 **0.22**, with medians of 0.0. GPT-5-mini scored 0.0 on all three.
  - The models had web search to browse the commit tree.
  - **Transfer:** asking a frontier model to *infer* the impact set from the diff is poor. Impact should be computed deterministically (VS-25), with the model reasoning over the computed set.
- **"From Seed to Scope: Reasoning to Identify Change Impact Sets" (Yadavally and Nguyen, ICSE 2026, ACM SIGSOFT Distinguished Paper)** — academic (metadata only; the PDF host was blocked). The method expands from the seed edit to a deliberately broader, imprecise scope and then narrows. **No numbers were reached.**
- **CodePlan (Microsoft, FSE 2024, arXiv 2309.12499)** — academic (extract; repository github.com/microsoft/codeplan is archived and holds no numbers).
  - Incremental dependency analysis plus change may-impact analysis plus adaptive planning. Tasks were C# package migration and Python temporal edits spanning 2-97 files.
  - **5 of 7** repositories passed validity checks, against **0 of 7** for baselines given the same context without planning.
  - **Transfer:** dependency-driven impact propagation is what makes multi-file consistency work. That supports VS-25's dependents step for "a signature changed; were all callers updated?" findings.
- **Edit propagation models** — academic (extract).
  - CoEdPilot (arXiv 2408.01733; journal version 2025) predicts edit locations at about 70.8-85.3% accuracy (85.0-89.0% in the journal version).
  - Coeditor (ICLR 2024) raises single-edit exact match from 34.7 to 60.4 by conditioning on repository-level diffs.
  - **Transfer:** learned "where else should this change have been made" is feasible, but needs training data VectorScope does not have.
- **Evolutionary coupling (co-change history)** — academic (extract).
  - ESEM 2024 (Zhou et al.) added structural dependencies and clones to TARMAQ co-change rules and improved recall and MAP on six systems.
  - Kagdi, Gethers and Poshyvanyk (WCRE 2010) combined conceptual and evolutionary coupling for up to +45% recall over evolutionary coupling alone.
  - A replication study warns that the classic ~90% co-change precision and recall figures are inflated by the evaluation method.
  - **Transfer:** co-change edges catch impact with no static import: configs, SQL, generated clients, cross-language contracts. They are a natural *second edge type* for BrainGraph when history is available (VS-28 already plans churn). Evidence for the combined method is modest and mostly pre-LLM.

## 5. Context for automated code review specifically

**5.1 AACR-Bench (Alibaba, arXiv 2601.19494, Jan 2026)** — academic (extracts and secondary summaries); README at github.com/alibaba/aacr-bench (Apache-2.0 code; no dataset licence stated).
- **Setup:** 200 PRs, 50 repositories, 10 languages, 1,505 expert-verified comments. Each comment is tagged by the context it needs: diff, file or repo. The annotation pipeline claims 285% more defects than the original PR comments.
- **Main claim:** "the granularity/level of context and the choice of retrieval methods significantly impact ACR performance, and this influence varies depending on the LLM, programming language, and the LLM usage paradigm."
- **Non-agent setting:** recall decays as required context grows (Diff > File > Repo).
- **Agent setting:** recall on repo-level issues *rises*, but agents drop diff-level issues. DeepSeek-V3.2 went from 4.28% (diff) to 8.00% (repo), and Qwen-480B-Coder from 4.49% to 5.94%. A reviewer calls this "contextual tunnel vision".
- **Precision-recall trade:** Claude-4.5-Sonnet in agent mode had **39.90% precision but 10.10% recall** (secondary).
- **Corrects round one:** round one recorded AACR-Bench only as "benchmarks are built around repository context". Its own finding is that context *helps or hurts depending on model, language and paradigm*, so an ablation on one model does not license a default for others.

**5.2 OCR (Alibaba, Nanjing, Peking; arXiv 2608.09290, Aug 2026)** — academic (via a third-party deep dive on GitHub that reproduces the tables; vendor-adjacent, because the authors also built AACR-Bench).
- **Design:**
  - Deterministic rule-guided file selection and bundling (diffs over 80% of the window are excluded).
  - One subagent per file, concurrency 8, with six bounded tools: 500 lines per read, 100 results per search, 10 s timeouts, 30 rounds.
  - Compression at 60% and 80% of the window.
  - An independent reflection filter that sees **only the diff**, can only delete comments, and **fails open**.
- **Results on AACR-Bench:**
  - Best SEM-F1 **25.10%** (P 33.9%, R 20.0%, Claude-4.6-Opus).
  - Claude Code's best was 14.13% (P 7.2-15.9%).
  - An open-source coding-agent CLI on GPT-5.5 scored 8.36% (P about 28%, R 5%).
  - OCR's weakest configuration (17.90%) beat Claude Code's best.
  - Tokens on the same model: **385K against 5,664K** (about 15x). The README says about 1/9 of the tokens. Recall is lower by design.
  - No per-component ablation.
- **Transfer:**
  - This is the strongest academic evidence that *determinism before the agent plus bounded tools* beats an unconstrained agent on both quality and tokens. That is the VS-25 and VS-24 philosophy.
  - Its reflection step fails open, whereas VectorScope's VS-27 fails closed. The paper does not test that choice.

**5.3 ContextCRBench (arXiv 2511.07017, Nov 2025; ByteDance deployment)** — academic (extract).
- 67,910 context-enriched entries filtered from 153.7K issues and PRs. Tasks are hunk assessment, line-level defect localization and comment generation.
- "**Textual context yields greater performance gains than code context alone**." Issue plus PR description is among the best settings. A ByteDance self-evolving deployment claims a 61.98% improvement.
- **Transfer:**
  - VS-25 adds only code context. The intent channel (PR body, linked issue) may matter more, but VectorScope treats PR text as untrusted data and today injects linked requirements only on the CLI (300 tokens; round one §4.3).
  - A measured question for VS-21: does adding the PR description *as untrusted data* move recall more than the impact slice?

**5.4 Kuaishou defect-focused review (Lu et al., ICML 2025 Spotlight, arXiv 2505.17928)** — academic (extracts and two summaries).
- **Slicing methods compared:**
  - Original Diff;
  - Parent Function;
  - Left Flow (traces assigned values);
  - Full Flow (also traces R-values and collects **callee signatures**).
- "More detailed slicing (Left Flow and Full Flow) improves performance, especially in key bug inclusion (KBI)." A summary gives up to 42.22% KBI (Qwen2 plus Full Flow) against roughly 0-2.22% for baselines.
- After validation, Full Flow at Top-5 kept KBI 20.00 but **dropped at Top-10 "due to the large volume of text"**. "Left Flow often outperforms Full Flow, possibly because shorter context helps maintain focus."
- **Transfer (extends round one, which cited the paper only as "industrial systems add slicing"):**
  - The industrial result that best matches review shows two things: flow-aware slices beat diff-only and function-only, and verbosity erodes the gain.
  - It also includes **forward** context (callee signatures), which VS-25's dependents-only slice omits.

**5.5 RevMate at Mozilla and Ubisoft (Olewicki et al., arXiv 2411.07091, Nov 2024)** — academic (field study; extract).
- Six weeks, 59 reviewers, 587 patch reviews.
- Overall acceptance was 8.1% (Mozilla) and 7.2% (Ubisoft).
- At Ubisoft, the **"Code" variant**, where the model can call a retrieval tool for function definitions and extra lines, had **lower acceptance (5.3%) than the "Example" variant (8.9%)**, which retrieves similar past review comments.
- Refactoring comments were accepted far more often (about 18%) than functional ones (about 5%).
- **Transfer:** the one live A/B of code retrieval in review found no acceptance gain from model-driven code retrieval. Acceptance is a weak proxy for catching bugs, and the models were 2024-era.

**5.6 CRBugBench, "(When) Should a Software Factory be Lights-off?" (Yang et al., arXiv 2610.13668, Oct 2026)** — academic (extract and summaries); repository github.com/malusamayo/CRBugBench (995 open tasks; no numbers in README).
- Agents struggle with bugs that need "non-local reasoning and deep project context".
- Exploration-nudging prompts gain up to 5.8% at 10% higher cost.
- The authors recommend scaling effort to PR complexity and "supplying repository knowledge".
- **Transfer:** non-local bugs are where review agents fail. A cheap prompt nudge to explore dependents is a measured lever to test alongside the static slice.

**5.7 Function call graphs in review prompts (Haider et al., arXiv 2411.10129, Nov 2024)** — academic (extract).
- Adding call graphs to few-shot GPT-3.5 prompts beat the CodeReviewer baseline by about 90% BLEU-4. Call graph plus code summary was sometimes *worse* than call graph alone.
- **Weak:** BLEU on the CodeReviewer dataset, which round one already flagged as noisy.

**5.8 c-CRAB, Code Review Agent Benchmark (Zhang et al., arXiv 2603.23448, Mar 2026)** — academic (extract). Its conclusion is that repository-specific context is "a likely missing ingredient". The cross-file RQ numbers were not reached.

**5.9 Context files for coding agents (corrects round one)** — academic.
- **Gloaguen et al., "Evaluating AGENTS.md" (ICLR 2026, arXiv 2602.11988):** context files gave no success improvement and sometimes reduced it, while **raising inference cost by over 20%** through extra exploration and testing (extract and author page).
- **Khatri, "Do Context Files Help Coding Agents?" (REALM at EMNLP 2026, arXiv 2607.27250; repository github.com/codeprakhar25/context-files-coding-agents, read 2026-11-06):**
  - 288 evaluated runs, 17 tasks from 3 Python repositories, two agents.
  - Pass rates: Claude Code 53.3% (none), 55.6% (always-on) and 55.6% (selective). The second agent scored 58.8%, 56.9% and 52.9%.
  - Equivalence bounds of ≤10 pp and ≤15 pp. The minimum detectable effect was above 30 pp, and detecting 10 pp would need about 120 tasks.
  - Context changed *process* (fewer slow full-suite runs, about 24% less wall-clock on one repository), not correctness.
- **Transfer to VS-26 (Brain cards):** round one's "no study measures their lift" is now outdated for coding agents. Two studies measure it and find a null on correctness, plus a cost increase. Review is a different task, but the prior for "cards raise recall" is now a null. VS-26 must be ablated and justified on cost or latency if not on recall. The power note matters: 18 dev cases cannot detect a 10-point effect.

**5.10 JetBrains, "On the Importance of Reasoning for Context Retrieval in Repository-Level Code Editing" (arXiv 2406.04464, Jun 2024)** — academic (extract).
- Reasoning "improves the precision of the gathered context" but cannot judge whether it is **sufficient**. Recall tracks context length more than reasoning (summary).
- **Transfer:** the model cannot be trusted to know it has seen enough. That supports VS-25's deterministic accounting: list over-budget files as not reviewed, and record `locations`.

## 6. Verdict on VS-25's design, point by point

| VS-25 element | Supported by | Contradicted or qualified by | Net |
|---|---|---|---|
| Deterministic zero-token slice before the model | OCR (15x fewer tokens, higher SEM-F1); GPT-5 CIA F1 0.22 (models infer impact poorly); ContextBench (agents over-retrieve) | AACR-Bench: the effect varies by model and paradigm | **Supported**; ablate per model |
| Import-gated dependents (precision filter) | LSP study (grep call-site precision 0.76 vs 1.00); Context Rot (similar distractors hurt); HCP (level-1 imports matter) | DraCo (imports "insufficiently relevant"); ARB `edit2ripple` led by embeddings; co-change literature (impact without imports); dynamic dispatch, DI and registries are invisible to imports | **Supported as a filter**; recall risk must be measured. Log what the gate dropped |
| Parse to confirm references | LSP precision result; RepoGraph and LocAgent def/ref edges | none | **Supported** |
| Dependents only (reverse direction) | CodePlan (callers of changed signatures); review needs "who breaks" | Kuaishou Full Flow and HCP use **forward** callee signatures | **Gap**: add depth-1 callee signatures |
| BrainGraph.rank (PPR seeded on the change) | ARB: PageRank repo map best at BCY@8k (0.379 vs BM25 0.205) | ARB: no retriever dominates; rankings flip between 4k and 8k; no review-specific PPR study | **Moderately supported** |
| Signatures plus 3-line call-site windows, not bodies | HCP (pruning dependency bodies costs little); Kuaishou (signatures in Full Flow) | Kuaishou: verbosity hurt at Top-10 | **Supported** |
| ≤15% of context and ≤6k tokens | SWE-bench (13k ≥ 27k); LongCodeBench (29%→3%); HCP (~8k beats 50k); ARB uses 8k | No study tests 6k for review; ARB shows budget-sensitive orderings | **Direction supported; the value is untested.** Sweep 2k/4k/6k/8k on replay |
| Fallback to `git grep` for unsupported languages | none | ARB: lexical and BM25 are the weakest families | **Weak**; label the fallback in notes |
| Read tools kept in Tier 2 | RepoCoder (iterative); AACR-Bench (agents gain repo-level recall); CRBugBench (+5.8% from exploration nudges) | AACR-Bench tunnel vision (diff-level loss); OCR bounds tools | **Supported with bounds** |
| Phase A gate: slice recall +10 points at equal tokens | CodeRAG-Bench (retriever is the bottleneck); ARB's BCY metric is the same idea | ContextBench: retrieved is not the same as used | **Keep; add a utilization metric** |

## 7. Concrete recommendations (inference from the above)

1. **Add forward context.** Pack depth-1 callee and type signatures used by each changed definition, alongside dependents (Kuaishou Full Flow; HCP level 1). Split the 6k budget, for example 2k forward and 4k reverse, and sweep the split on replay.
2. **Make the import gate observable.** For every case, record candidates dropped by the gate (`ImpactSlice` could add `gated: number`). On replay, measure how often a gold location sits in a gated-out file. If that rate is material, give gated-out matches a lower rank instead of dropping them.
3. **Add a co-change edge where history exists.** This is local-CLI-first, since CI fetches shallow history. Rank it below static edges. It is the only signal for impact with no import edge (configs, SQL, generated SDKs, `HttpApi` contracts, which matters in Vector's own Schema → Protocol → Server layering).
4. **Sweep the budget instead of fixing 6k.** Use 2k, 4k, 6k and 8k on Phase A cross-file cases, and report BCY-style "gold blocks exposed at budget B" next to slice recall. ARB shows orderings change with budget.
5. **Allow an empty slice and abstain structurally**, for example when no exported name or signature changed, never on a score threshold (Repoformer; ARB on abstention).
6. **Measure utilization.** Count Tier 2 findings whose evidence cites a slice location (ContextBench's explored-versus-utilized gap).
7. **Keep similarity retrieval out of the static slice** (Gu et al. 2025: up to 15% degradation). Offer it as a Tier 2 tool, if at all.
8. **Test the intent channel separately.** ContextCRBench says text context beats code context. A VS-21 ablation of PR description and linked issue (as untrusted data) against the slice would show which to invest in.
9. **Expect a null from Brain cards (VS-26)** and pre-register the cost criterion (the two context-file studies).
10. **Prefer private or recent replay cases over public localization numbers** (SWE-bench leakage concern, recalled).

## 8. Unreached and unverified this round

- Full tables of AACR-Bench (per context level and per retrieval method), the Kuaishou ICML paper (per-slice KBI, FAR, CPI, token lengths), ContextBench (per-agent block F1), CRBugBench (catch rates), c-CRAB (cross-file RQ) and "From Seed to Scope" (any numbers).
- The SWE-bench Table 5 context-limit numbers (13k/27k/40k-50k resolve and recall).
- RepoGraph's 32.8% relative gain (secondary only) and Agentless's file-level accuracy (sources conflict).
- Not searched because the budget ran out: SWE-Bench Illusion, CodexGraph's numbers, Long Code Arena, Lost in the Middle, HippoRAG PPR, Cost-Effective Repository Exploration (2608.29675) and VulContextBench (2609.32601).
- Licence of the AACR-Bench dataset and its source repositories (README states Apache-2.0 for code only).
