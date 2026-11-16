# Evidence behind the Vectorscope upgrade ideas

Research date: 2026-11-05. Compiled for Vectorscope. Topic: how much evidence backs four upgrade ideas:

1. cross-model (cross-family) verification;
2. LLM code review effectiveness (precision, recall, acceptance, false positives, verification passes, context);
3. predicting future bugs (just-in-time defect prediction, churn and hotspots, SZZ, LLM variants);
4. runtime verification during review (test generation, sandboxed execution, fuzzing, changed-line coverage, eBPF and OpenTelemetry).

---

## 0. How this was researched (read first)

**Access limits in this session. They shape how much of this file is verified.**

- **No web searches.** The shared WebSearch budget for the turn was already used up before my first query. I ran zero searches.
- **Most hosts blocked.** `arxiv.org` failed DNS through the session proxy. The proxy log also shows 403s for `greptile.com`, `dev.to` and `news.ycombinator.com` from sibling agents. Per the environment's rule I stopped trying new hosts.
  - `raw.githubusercontent.com` and `pypi.org` were reachable, so the sources I read in full are GitHub-hosted docs, READMEs, data files and PyPI metadata.
  - To verify the research claims below against the papers, allow `arxiv.org`, `dl.acm.org`, `openreview.net`, `research.google`, `engineering.fb.com` and `security.googleblog.com` in the environment's network settings.
- **What "fetched" means.** Primary sources were read in full on 2026-11-05: kernel docs, Docker seccomp profile, GitHub Actions runner docs, OpenTelemetry/OBI docs, eBPF-for-Windows, Firecracker, gVisor, CIFuzz, OSS-Fuzz-gen, diff-cover, Bun coverage docs, and several paper replication repos. I also used Martian Code Review Bench's raw per-PR judge data and re-analysed it myself.
- **What "(recalled)" means.** Many paper-level claims come from my background knowledge (training data to mid-2026) and were **not re-fetched this session**. Each is marked **(recalled)** with a confidence note.
  - I give a number only where I am confident it is the paper's own figure. Where I was unsure I left the number out.
  - Verify every **(recalled)** item before quoting it externally.
- **Bibliographic checks.** Titles, arXiv IDs and months for many 2024–2026 papers were checked against two curated GitHub lists:
  - `codefuse-ai/Awesome-Code-LLM` README, fetched 2026-11-05;
  - `llm-as-a-judge/Awesome-LLM-as-a-judge` README, fetched 2026-11-05.

  This confirms that a paper exists and when it appeared. It does not confirm what the paper says.
- **Claims from sibling notes.** Some claims come from sibling research notes in this same workflow (`greptile-*.md`, `landscape.md` in this folder), which other agents built from web reads. These are marked **(sibling notes)**. I could not re-open their sources because `greptile.com` is blocked.

**Labels.**

| Label | Meaning |
|---|---|
| **vendor claim** | The company's own statement or metric. |
| **independent evaluation** | A third party that ran the tools itself. |
| **research** | A peer-reviewed paper or preprint. Venue is noted where known. |
| **code/docs** | Read directly in source, docs or data files this session. |
| **inference** | My own reasoning or my own analysis of someone else's data. |

---

## 1. Bottom line (evidence strength per idea)

| Idea | Strength of evidence | One-line verdict |
|---|---|---|
| LLM judges favour their own or similar outputs | **Well supported** in general NLG judging (several peer-reviewed papers) | Real, and partly driven by familiarity/perplexity. Smaller or absent on grounded matching tasks. |
| LLM errors are correlated, more so within a provider | **Well supported** (ICML 2025-era papers, recalled) | Real. But frontier models' errors are correlated **across** providers too, which caps the cross-family benefit. |
| A model is worse at finding bugs in its own family's code | **Weak and specific to one vendor.** One vendor blog (Greptile "Model Inversion", ~2026-07); nothing peer-reviewed or replicated found. | Plausible direction. No independent replication. Confounded by comment volume and reviewer capability. |
| "~10% uplift in edge-case bug detection" from cross-family routing | **Not supported.** The only trace is Greptile's "~10% higher catch rate" (vendor). | Don't quote it. It is not about "edge cases", and no method or CI was published. |
| A stronger reviewer helps more than a different family | **Supported** (BIG-Bench Mistake table, self-repair paper) | Capability dominates. A weaker cross-family reviewer does *worse* than self-review. |
| LLM review comments are often acted on in industry | **Moderately supported** (industrial case studies: Beko/Qodo, ByteDance, Atlassian, Google) | Resolution or acceptance figures of roughly 40–75% are reported, each with its own definition. Not comparable across studies. |
| Precision/recall on curated benchmarks | **Moderately supported** (Martian, AACR-Bench, SWR-Bench and others) | The best tools reach about 0.55–0.67 precision and 0.6–0.66 recall on Martian's core set. Many tools are under 0.45 precision. |
| Verification passes reduce false positives | **Moderately supported** (ByteDance ReviewFilter, vendor A/Bs, benchmark ranking) | Consistent direction. No controlled academic ablation found this session. |
| Repo context improves review | **Weak to moderate.** Benchmarks are built around it; my Martian re-analysis shows cross-file PRs are harder (recall about 8–11 points lower). | Direction plausible; effect size not established. |
| JIT defect prediction (change risk) | **Well supported** for population-level ranking (Kamei 2013 and successors). Simple features are competitive with deep models. | Useful for allocating review effort. **Weak** evidence that showing it to developers changes behaviour (Google 2013). |
| SZZ-mined labels | **Well supported that they are noisy** | Any trained model inherits label noise. Evaluate with time-aware splits. |
| LLM-based JIT and risk models | **Emerging.** Meta's Diff Risk Score exists. Few independent replications. | Promising for gating; accuracy claims unverified. |
| LLM test generation with execution filters | **Well supported industrially** (Meta TestGen-LLM, ACH; SWT-bench) | Works when gated by build, pass, flakiness and coverage-gain filters. The oracle problem remains. |
| Changed-line coverage in review | **Supported** (Google practice; standard tooling) | Cheap and deterministic. Bun emits lcov, and diff-cover consumes it. |
| PR-time fuzzing | **Supported for fuzzable C/C++/Rust/Go/Java targets** (CIFuzz) | Time-boxed (10 minutes by default). It reports only crashes the PR introduced. Niche for TypeScript apps. |
| eBPF during review | **Feasibility documented; value for review not studied** | Linux-only, privileged, kernel 5.8+ with BTF. Not portable to macOS. Windows support is partial and work in progress. |
| OpenTelemetry during review | **Feasibility documented; value for review not studied** | Cross-platform when used in-process (SDK or agents). The eBPF flavour (OBI) is Linux-only and privileged. |

---

## 2. Cross-model verification

### 2.1 Self-preference and self-recognition in LLM judges (well supported)

- **Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"**, arXiv 2306.05685, Jun 2023, NeurIPS 2023 Datasets & Benchmarks. **research (recalled, high confidence).**
  - The paper names "self-enhancement bias".
  - GPT-4 as judge favoured itself with about a **10% higher win rate**, and Claude-v1 favoured itself with about 25%.
  - The authors caveat that the data is limited, that the differences are small, and that GPT-3.5 did not favour itself.
  - **inference:** this is a likely origin of a loosely quoted "~10%" self-bias figure. It concerns judging chat answers, not bug detection.
  - Fetched this session: FastChat `llm_judge/README.md` (2026-11-05) says GPT-4 judge and human agreement is "over 80%, the same level of agreement between humans". **code/docs.**
- **Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations"**, arXiv 2404.13076, Apr 2024, NeurIPS 2024. arXiv ID confirmed via Awesome-LLM-as-a-judge. **research (recalled, high confidence).**
  - GPT-4 and Llama 2 distinguish their own summaries from others' and from humans' better than chance.
  - Fine-tuning to raise self-recognition raised self-preference, with a **linear correlation** between the two.
  - This is the closest thing to causal evidence that "knowing it's mine" drives the bias.
  - Tasks were summarization (XSUM, CNN/DailyMail), not code.
- **Wataoka, Takahashi, Ri, "Self-Preference Bias in LLM-as-a-Judge"**, arXiv 2410.21819, Oct 2024. **research (recalled, medium-high confidence).**
  - Proposes a fairness-style metric and finds GPT-4 shows significant self-preference.
  - Mechanism: judges give higher scores to **lower-perplexity (more familiar) text, whether or not they wrote it**.
  - **inference:** this is the theoretical reason cross-family review could help. Models from one family share training data and style, so they find each other's mistakes "familiar".
- **Chen et al., "Do LLM Evaluators Prefer Themselves for a Reason?"**, arXiv 2025 (ID not verified). **research (recalled, medium confidence).**
  - On verifiable tasks (math, factual QA, code), much of a strong model's "self-preference" is justified, because its answers really are better.
  - *Harmful* self-preference (favouring its own wrong answer) persists. Longer reasoning at inference time reduces it.
  - **inference:** naive "self-preference" numbers overstate the harm. The harm is concentrated where the reviewer shares the author's blind spot.
- **Xu et al., "Pride and Prejudice: LLM Amplifies Self-Bias in Self-Refinement"**, arXiv 2402.11436, ACL 2024. **research (recalled, high confidence).**
  - Self-bias grows over self-refinement iterations.
  - Larger models and external feedback with accurate assessment reduce it.
  - **inference:** a "verify your own findings" pass run by the *same* model and prompt is the weakest kind of verification.
- **Li et al., "Preference Leakage: A Contamination Problem in LLM-as-a-judge"**, arXiv 2502.01534, Feb 2025. arXiv ID confirmed via list. **research (recalled, medium confidence).**
  - Judges favour student models trained on data generated by the judge, or by a related model of the same family.
  - This extends the bias to "relatives", not just the model itself.

### 2.2 Correlated errors across models (well supported, and it cuts both ways)

- **Kim, Garg, Peng, Garg, "Correlated Errors in Large Language Models"**, arXiv 2506.07962, Jun 2025, ICML 2025. **research (recalled, medium-high confidence).**
  - Studied 350+ LLMs on two leaderboards (HF and HELM) plus a résumé-screening task.
  - "On one leaderboard dataset, models agree 60% of the time when both models err."
  - Shared provider and architecture raise correlation.
  - **But "larger and more accurate models have highly correlated errors, even with distinct architectures and providers."**
  - It shows downstream effects on LLM-as-judge.
  - **inference:** at the frontier tier Vectorscope would actually use, the cross-family gain should be smaller than older-model studies suggest.
- **Goel et al., "Great Models Think Alike and this Undermines AI Oversight"**, arXiv 2502.04313, Feb 2025. **research.**
  - arXiv ID, authors and the metric names CAPA (κp), discrete CAPA and Error Consistency were verified in the `model-similarity/lm-similarity` README (fetched 2026-11-05). **code/docs.**
  - Findings (recalled, high confidence):
    - LLM judges score models *similar to themselves* higher, which generalises self-preference into "affinity bias";
    - weak-to-strong gains are larger when supervisor and student make different mistakes;
    - model mistakes grow more similar as capability rises.
  - **implication:** use a reviewer whose *errors* differ from the author's. A tool exists (`pip install lm-sim`) to measure this on Vectorscope's own eval set.

### 2.3 Error finding and self-correction (supported; capability dominates family)

- **Tyen et al., "LLMs cannot find reasoning errors, but can correct them given the error location"**, ACL Findings 2024, arXiv 2311.08516.
  - Venue verified via the `WHGTyen/BIG-Bench-Mistake` README. Table 4 was read from the repo's `results.png` (2026-11-05). **research + code/docs.**
  - The chain-of-thought traces were **generated by PaLM 2 Unicorn**. Each model then tried to find the first mistake.
  - Overall mistake-finding accuracy (direct-trace / direct-step / CoT-step):

    | Model | Direct (trace) | Direct (step) | CoT (step) |
    |---|---|---|---|
    | PaLM 2 Unicorn (same model as the generator) | 17.09 | 23.67 | 24.65 |
    | GPT-4 (other family, stronger) | 39.80 | 52.87 | 43.40 |
    | GPT-4-Turbo | 30.13 | 48.33 | n/a |
    | GPT-3.5-Turbo (other family, weaker) | 10.44 | 14.78 | 14.31 |
    | Gemini Pro (Google, related lineage) | 16.14 | n/a | n/a |

  - **inference:** the cross-family *stronger* model roughly doubles accuracy. The cross-family *weaker* model is worse than the generator reviewing itself. Reviewer capability, not family, is the first-order variable. Even the best finder was right only about half the time on these traces.
- **Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet"**, arXiv 2310.01798, ICLR 2024. **research (recalled, high confidence).**
  - Without external feedback, intrinsic self-correction often fails to help, and sometimes makes reasoning accuracy worse.
- **Olausson et al., "Is Self-Repair a Silver Bullet for Code Generation?"**, ICLR 2024, arXiv 2306.09896.
  - Venue verified via the `theoxo/self-repair` README. **research + code/docs.**
  - Findings (recalled, high confidence):
    - self-repair gains are modest and inconsistent;
    - the bottleneck is the quality of the model's feedback on its *own* code;
    - feedback from a **stronger model** (GPT-4 on GPT-3.5 code) or from **humans** substantially improves repair.
  - The cross-model benefit is confounded with capability, and both models are from OpenAI.
- **McAleese et al., "LLM Critics Help Catch LLM Bugs" (CriticGPT)**, arXiv 2407.00215, Jun 2024. ID confirmed via list. **research (vendor-authored by OpenAI; recalled, medium-high confidence).**
  - An RLHF-trained critic from the same lab caught bugs in ChatGPT-written code.
  - Its critiques were preferred over human contractors' critiques in about 63% of cases on naturally occurring bugs.
  - **inference:** a reviewer *trained* to critique can overcome same-family effects. Training and prompting matter, not only family.

### 2.4 Code-review-specific evidence for the cross-family idea

- **Greptile, "Model Inversion" (blog ~2026-07-21) and a companion post "How to build a code review agent" (~2026-10/11).** **vendor claim (sibling notes; I could not open greptile.com).**
  - Study design:
    - two 500-PR sets, one Claude Code-authored and one Codex-authored, with about 1,500 ground-truth comments;
    - each family's reviewer caught more high-severity bugs in the *other* family's code;
    - on Claude Code PRs a GPT model beat Opus on high-severity share, and Opus won on Codex PRs.
  - The companion post reports **"~10% higher catch rate"** with a cross-family reviewer. Greptile now routes review to the other family by detecting the authoring agent from commit trailers, branch prefixes and PR titles.
  - Caveats (inference):
    - (a) no published method, CIs or per-model table;
    - (b) LLM-judged ground truth;
    - (c) a comment-volume confound: Codex reviews average 1–2 comments and Opus 7–8, so "catch rate" partly measures verbosity;
    - (d) not replicated;
    - (e) about "high-severity bugs" or "catch rate", **not "edge-case bugs"**.
- **No peer-reviewed or independent study was found** that measures reviewer-author family effects in code review. Absence is not proof, given zero searches this session; re-check once search is available.
- **My own check on independent data (Martian Code Review Bench offline set).** **inference on independent data.**
  - Data: `withmartian/code-review-benchmark/offline/analysis/benchmark_dashboard.json`, fetched 2026-11-05 from `main`. Sibling notes record commit e616e84 dated 2026-08-30. 50 PRs, 158 "core" golden issues, three judges.
  - Question: does a Claude judge favour Claude Code's reviews?
    - I computed each tool's F1 divided by that judge's mean F1 across all 21 tools.
    - Claude Code (CLI): 0.991 under Opus 4.5, 0.890 under Sonnet 4.5, 0.957 under GPT-5.2.
    - "Claude Code" (the GitHub app config): 0.848 / 0.855 / 0.896.
    - **No same-family favouritism is visible.** The GPT judge is, if anything, kinder to the Claude tools.
  - Question: do judges from one family agree with each other more?
    - Exact agreement on TP count per (PR, tool) cell, n=1,050: Opus–Sonnet 0.862, Opus–GPT-5.2 0.865, Sonnet–GPT-5.2 0.871. All three agree on 0.806.
    - The same-family judge pair is **not** more correlated.
  - Interpretation:
    - The Martian judge task is grounded ("do these describe the same underlying issue?"), and self-preference seems small there.
    - This says nothing about the *reviewer vs author* effect, because the PRs are human-written.
    - The sample is small.

### 2.5 Verdict and what Vectorscope should do

- **Supported:** self-preference and affinity bias in judging, error correlation within and across families, and "stronger external feedback beats self-feedback".
- **Plausible but unproven for code review:** "a different family finds more of the author's bugs".
- **Unsupported:** the "~10% uplift in edge-case bug detection" figure.
- **Recommendations.**
  - Make reviewer routing configurable and record the authoring agent, which Vector sessions already know.
  - Default to the *strongest available* reviewer. Use cross-family as:
    - (a) the tie-breaker between equal-capability options;
    - (b) a second-opinion *verifier* on high-risk diffs.
  - Prove the effect in-house before marketing it:
    - an A/B on a held-out PR set (Martian offline plus Vectorscope's own traffic), same-family vs cross-family at the **same capability tier**;
    - control for comment count (compare at a fixed top-k findings);
    - report high-severity recall and precision with confidence intervals;
    - measure error overlap with `lm-sim`-style metrics on finding-level outcomes.

---

## 3. LLM code review effectiveness

### 3.1 Industrial deployments (acceptance and resolution)

Definitions differ ("resolved", "addressed", "accepted", "useful"), so these are **not comparable across studies**.

- **Cihan et al., "Automated Code Review In Practice"**, arXiv 2412.18531, Dec 2024, ICSE-SEIP 2025. Beko, using Qodo PR-Agent. ID confirmed via list. **research (recalled, medium-high confidence).**
  - 73.8% of automated comments were marked resolved.
  - Average PR closure time *rose* from about 5h52m to 8h20m.
  - Developers reported some faulty or irrelevant comments.
  - **implication:** a high resolution rate can coexist with slower merges. Measure cycle time as well as resolution.
- **BitsAI-CR (ByteDance), "Automated Code Review via LLM in Practice"**, arXiv 2501.15134, Jan 2025. ID confirmed via list. **research (industrial; recalled, medium confidence).**
  - Two stages: a RuleChecker generates issues, then a **ReviewFilter** verifies them.
  - Reported 75.0% precision of generated comments.
  - Introduced an "Outdated Rate" metric: the share of flagged code later changed. 26.7% was reported for Go.
  - About 12k weekly active users.
  - **implication:** the clearest industrial example that a dedicated verification stage is a large lever on precision.
- **Google, "AI-Assisted Assessment of Coding Practices in Modern Code Review" (AutoCommenter)**, arXiv 2405.13565, May 2024. **research (industrial; recalled, qualitative only).**
  - A deployed best-practice commenter with developer feedback signals and thresholding.
- **Atlassian, "RovoDev Code Reviewer: A Large-Scale Online Evaluation of LLM-based Code Review Automation at Atlassian"**, arXiv 2601.01129, Jan 2026. **research (industrial).**
  - Title and ID confirmed via list. Numbers not verified, so none are quoted.
- **Sibling notes** report three 2026 preprints. **research (sibling notes).**
  - arXiv 2604.03196: "12 of 13 code-review agents have average signal ratio below 60%".
  - arXiv 2607.21997 ("Go Home Copilot, You're Drunk"): about 54.7k agent review comments; **inline code suggestions are the strongest predictor of resolution**, and long comments are acted on less.
  - arXiv 2608.21311: "AI-to-AI Code Reviews of GitHub PRs", ESEM 2026.
- **Greptile addressed-rate A/Bs.** **vendor claim (sibling notes).**
  - 19%→55% after an embedding-based filter of team-downvoted comments (Dec 2024).
  - 30%→43% (v3→v4).
  - 52%→66% (v4→v5, hypothesis-verification swarm).

### 3.2 Benchmarks (precision and recall)

- **Martian Code Review Bench, offline set.**
  - **independent evaluation.** Martian says it is not a review vendor. Its data is **code/docs**; my aggregation is **inference**.
  - Design (from the README, fetched 2026-11-05):
    - 50 PRs from Sentry, Grafana, Cal.com, Discourse and Keycloak;
    - 173 golden comments; profiles Strict (139), Core (158) and All (173);
    - LLM-judge matching with Claude Opus 4.5, Claude Sonnet 4.5 and GPT-5.2.
  - Known limitations, stated by Martian:
    - possible training-data leakage;
    - the golden set misses some valid issues, so some "false positives" are real issues;
    - only about 10 style or nit golden comments.
  - My pooled micro-averages over 50 PRs (Core profile). Martian's dashboard may weight differently.

    | Tool | P (Opus / Sonnet / GPT-5.2) | R (Opus / Sonnet / GPT-5.2) | F1 (Opus / Sonnet / GPT-5.2) |
    |---|---|---|---|
    | Qodo Extended | 0.67 / 0.56 / 0.58 | 0.65 / 0.57 / 0.60 | 0.66 / 0.57 / 0.59 |
    | Cubic v2 | 0.62 / 0.57 / 0.57 | 0.66 / 0.61 / 0.61 | 0.64 / 0.59 / 0.59 |
    | Augment | 0.60 / 0.52 / 0.50 | 0.65 / 0.61 / 0.61 | 0.62 / 0.57 / 0.55 |
    | Cursor Bugbot | 0.57 / 0.54 / 0.52 | 0.47 / 0.44 / 0.46 | 0.51 / 0.49 / 0.49 |
    | Greptile v4 | 0.51 / 0.47 / 0.42 | 0.51 / 0.48 / 0.48 | 0.51 / 0.48 / 0.45 |
    | Copilot v2 | 0.39 / 0.34 / 0.33 | 0.67 / 0.62 / 0.63 | 0.49 / 0.44 / 0.44 |
    | Claude Code (CLI) | 0.46 / 0.37 / 0.40 | 0.48 / 0.41 / 0.41 | 0.47 / 0.39 / 0.41 |
    | CodeRabbit | 0.33 / 0.34 / 0.29 | 0.60 / 0.58 / 0.60 | 0.42 / 0.43 / 0.39 |
    | Graphite | 1.00 / 1.00 / 0.73 | 0.08 / 0.08 / 0.07 | 0.14 / 0.14 / 0.13 |

  - Takeaways (inference):
    - Even the best tools miss about a third of curated issues, and a third to almost half of their comments don't match a golden issue.
    - Precision and recall trade off through comment volume (CodeRabbit and Copilot vs Graphite).
    - Opus 4.5 is the most lenient judge (mean F1 0.476 vs 0.435 for Sonnet and 0.425 for GPT-5.2). Always report the judge.
- **Context effect (my re-analysis of the same data).** **inference, weak.**
  - Pooled recall across all tools on PRs labelled `cross_file` (n=34) was 0.42–0.46 across judges, against 0.51–0.54 on `file`-level PRs (n=15).
  - That is a consistent gap of about 8–11 points. The PR counts are small, and the pooled data is not independent across tools.
- **AACR-Bench (Alibaba)**, arXiv 2601.19494, Jan 2026. Repo README fetched 2026-11-05. **research + code/docs.**
  - 200 PRs from 50 projects in 10 languages, 2,145 review comments.
  - Annotation: GitHub human comments, then LLM enhancement, then multi-round expert cross-annotation by 80+ engineers.
  - Each comment is labelled with its context level (diff, file or repo). Metrics are precision, recall and line precision.
  - The harness supports Claude Code and Codex as reviewers. The README has no headline numbers.
- **Other 2025–2026 benchmarks** (existence confirmed via list; contents not read):
  - SWR-Bench, "Benchmarking and Studying the LLM-based Code Review", arXiv 2509.01494;
  - CodeFuse-CR-Bench, arXiv 2509.14856;
  - "Benchmarking LLMs for Fine-Grained Code Review with Enriched Context in Practice", arXiv 2511.07017;
  - CR-Bench, "Evaluating the Real-World Utility of AI Code Review Agents", arXiv 2603.11078;
  - "Towards Practical Defect-Focused Automated Code Review", arXiv 2505.17928, ICML 2025.
    - Recalled, low-medium confidence: an industrial (Kuaishou) system using code slicing for context, with explicit false-alarm reduction.
- **Metric validity research** (titles confirmed via list; CRScore README fetched).
  - CRScore, arXiv 2409.19801. DeepCRCEval, arXiv 2412.18291. "Deep Assessment of Code Review Generation Approaches: Beyond Lexical Similarity", arXiv 2501.05176.
  - All argue that BLEU-style comparison to a single human comment is a poor measure of review quality.
  - "Too Noisy To Learn", arXiv 2502.02757 (recalled, medium confidence): a large share of comments in the classic CodeReviewer dataset (Li et al., 2022, arXiv 2203.09095) are noisy or non-actionable.
  - **implication:** don't train or evaluate on raw CodeReviewer data. Use issue-matching benchmarks.

### 3.3 What drives false positives (synthesis)

Each point names its evidence.

1. **Comment volume and low-value categories.** High-volume tools have low precision (Martian table above). Martian's Core and Strict profiles exclude "style" and "speculative" categories for this reason. **independent evaluation + inference.**
2. **Missing or unretrieved context.** Cross-file issues have lower recall (my re-analysis). Benchmarks are now built around repository context (AACR-Bench). Industrial systems add slicing or retrieval (2505.17928). **research + inference.**
3. **Unverified hypotheses.** Systems with a verify stage report large precision or addressed-rate gains: BitsAI-CR ReviewFilter, Greptile v3→v5. **research (industrial) + vendor claim.**
4. **Self-confirmation in same-model verification.** Pride and Prejudice, and the self-correction literature. **research.**
5. **Benchmark artefacts.** Incomplete golden sets make real findings count as false positives (Martian's own caveat). **independent evaluation.**
6. **Stale comments.** Code changes after the comment is posted (BitsAI-CR's Outdated Rate). **research (recalled).**

### 3.4 Effect of verification passes

- **Direction is consistent.** Two-stage generate-then-verify improves precision in every industrial report I could reach: BitsAI-CR, plus Greptile's vendor A/Bs. Two of the top three tools on Martian (Qodo Extended, Cubic v2) are multi-stage agentic reviewers (sibling notes). **research + vendor + inference.**
- **Missing:** a controlled academic ablation that isolates verification, holding model and context fixed. Treat effect sizes as unknown.
- **Design rule (inference from §2):** the verifier should use different evidence (execution, static analysis, retrieved code) or a different or stronger model. Re-reading with the same prompt is not enough.
  - "Combining Large Language Models with Static Analyzers for Code Review Generation" (arXiv 2502.06633, title confirmed) is one academic example of grounding comments in analyser output.

### 3.5 Implications for Vectorscope

- Optimise for precision at fixed recall.
  - Drop speculative and style categories by default.
  - Require each finding to carry a concrete failure scenario.
  - Verify each hypothesis separately with tool access.
- Prefer inline suggestion blocks and short comments, which the 2607.21997 resolution predictors favour (sibling notes).
- Benchmark on Martian offline with **all three judges** and report Strict, Core and All plus F1 and F2.
  - Vectorscope can run the same aggregation I did: per-PR TP/FP/FN in `benchmark_dashboard.json`.
  - Track an online addressed or resolved rate with a published judge prompt, plus PR cycle time (the Beko result).

---

## 4. Predicting future bugs

### 4.1 Just-in-time defect prediction (well supported for ranking)

- **Kamei et al., "A Large-Scale Empirical Study of Just-in-Time Quality Assurance"**, IEEE TSE 39(6), 2013, doi:10.1109/TSE.2012.70. **research (recalled, high confidence).**
  - 14 change metrics in five groups: diffusion, size, purpose, history, experience.
  - Logistic regression on 6 open-source and 5 commercial projects.
  - Average **68% accuracy and 64% recall**.
  - The effort-aware model finds **35% of defect-inducing changes while inspecting 20% of the effort** (changed LOC).
- **Nagappan & Ball, "Use of Relative Code Churn Measures to Predict System Defect Density"**, ICSE 2005. **research (recalled, high confidence).**
  - Relative churn measures predicted defect density in Windows Server 2003.
  - They discriminated fault-prone from non-fault-prone binaries with **89.0% accuracy**.
- **Process metrics beat code metrics.** **research (recalled, high confidence).**
  - Moser, Pedrycz & Succi, ICSE 2008.
  - Rahman & Devanbu, "How, and why, process metrics are better", ICSE 2013.
  - Hassan, "Predicting faults using the complexity of code changes" (change entropy), ICSE 2009.
- **Kim et al., "Predicting Faults from Cached History" (FixCache)**, ICSE 2007. **research (recalled, medium-high confidence).**
  - A cache holding about 10% of files captured **73–95%** of future faults across the projects studied (file-level hotspot).
- **Simple models match deep models.**
  - Zeng et al., "Deep Just-in-Time Defect Prediction: How Far Are We?", ISSTA 2021. The `ZZR0/ISSTA21-JIT-DP` README (fetched 2026-11-05) says it replicated DeepJIT and CC2Vec, built an "extensive benchmark with over 310K commits", and that a "simplistic 'la' (lines added)-feature-based" model, **LApredict, "turns out to outperform DeepJIT and CC2Vec"**. **research + code/docs.**
  - Yang et al., FSE 2016: simple unsupervised effort-aware models (for example ranking by lines touched) rival supervised ones. The finding was later debated by Fu & Menzies (FSE 2017). **research (recalled).**
  - JIT-Fine (Ni et al., FSE 2022, "The Best of Both Worlds: Integrating Semantic Features with Expert Features for Defect Prediction and Localization"). The README (fetched) shows it combines semantic and expert features and adds line-level localization on its new JIT-Defects4J dataset, built from Herbold et al.'s LLTC4J. **research + code/docs.**
- **Typical accuracy (recalled, approximate).** Within-project JIT-DP AUCs usually fall in the high 0.7s to low 0.8s. Cross-project and time-aware evaluation is lower. Treat this as a ballpark, not a citation.

### 4.2 Label quality (SZZ) and evaluation pitfalls (well supported)

- **Rosa et al., "Evaluating SZZ Implementations Through a Developer-informed Oracle"**, ICSE 2021. **research + code/docs.**
  - Replication package README fetched 2026-11-05: 1,930 developer-informed bug-fix to bug-inducing instances, 1,115 of them language-filtered. It recommends PySZZ v2 for new work.
  - Recalled finding: SZZ variants miss and mislabel a substantial fraction of inducing commits.
- **Herzig, Just & Zeller, "It's Not a Bug, It's a Feature"**, ICSE 2013. **research (recalled, high confidence).**
  - **33.8%** of bug reports were misclassified.
  - **39%** of files marked defective never had a bug.
- **Herbold et al.**, "Problems with SZZ and features…", EMSE 2022. **research (recalled).** Documents label-collection problems across the defect-prediction literature.
- **Verification latency.** Cabral et al., ICSE 2019. **research (recalled).** Bugs surface weeks or months later, so recent "clean" commits are mislabelled at training time. Use time-aware splits and a label-maturity gap.
- PyDriller exposes an SZZ-style "commits that last modified these lines" API. Its docs were fetched; the exact wording was not quoted. **code/docs.**

### 4.3 Does showing risk to developers help? (weak evidence, one strong negative)

- **Lewis et al., "Does Bug Prediction Support Human Developers? Findings from a Google Case Study"**, ICSE 2013. Also the Google Engineering Tools blog "Bug Prediction at Google", Dec 2011. **research (industrial; recalled, high confidence on the qualitative finding).**
  - Google deployed a simple time-weighted bug-fix-count hotspot score (after Rahman et al.) in code review.
  - It produced **no measurable change in developer behaviour**.
  - Developers wanted predictions that are actionable, clearly explained, and not dominated by old, stable "hot" files.
  - **This is the most important caution for a user-facing "future bug" feature.**
- **Meta, Diff Risk Score (DRS).** **research/vendor (industrial; recalled, low-medium confidence; numbers unverified).**
  - Meta has described LLM-based diff-risk models that predict whether a diff will cause a production incident (SEV). They are used to gate or slow risky diffs during code freezes.
  - Preprint "Moving Faster and Reducing Risk: Using LLMs in Release Deployment" (arXiv 2410.06351 per my recall) and a 2025 Meta engineering blog.
  - **implication:** the strongest industrial use of change risk is *gating and allocating scrutiny*, not telling developers "this file will break".
- **Tornhill & Borg, "Code Red: The Business Impact of Code Quality"**, TechDebt 2022. Authors are from CodeScene. **research (vendor-authored; recalled, medium confidence).**
  - Low "code health" files had about 15x more defects, and resolving issues in them took about 124% longer.
  - It is correlational and vendor-authored.

### 4.4 LLM-based JIT and risk prediction (emerging, weakly evidenced)

- Bi-modal change representation learning for JIT-DP (arXiv 2410.12107) shows the field moving to code language models. Title confirmed; contents not read.
- **inference / recalled:** published evidence that general LLMs (zero-shot) beat churn, size and history features at JIT-DP is thin. Fine-tuned code models give modest gains. Meta's DRS is the main industrial counterexample, and it uses fine-tuned in-house models trained on incident labels.

### 4.5 Implications for Vectorscope

- **Do:** compute a cheap, explainable change-risk score from features with decades of support:
  - lines added and deleted, files and directories touched, entropy;
  - recent churn of the touched files and their recent fix density (an SZZ-lite: commits whose messages reference fixes);
  - author's experience with these files;
  - test-file delta.
- Use it to **allocate review depth** (Auto tier, more verification agents, run tests or fuzz) and to explain *why* a PR got deeper review.
- **Don't:** market "predicts future bugs" or show per-file "bug probability" without calibration. The Google 2013 result shows a bare hotspot list doesn't change behaviour.
- If a learned model is added later:
  - train per repo or org;
  - use time-aware evaluation with a label-maturity gap;
  - report effort-aware metrics (recall at 20% LOC, Popt) as well as AUC;
  - expect SZZ label noise.

---

## 5. Runtime verification during review

### 5.1 LLM test generation (well supported when filtered by execution)

- **Meta TestGen-LLM, "Automated Unit Test Improvement using Large Language Models at Meta"**, arXiv 2402.09171, FSE 2024 Industry. **research (industrial; recalled, high confidence).**
  - Generated tests pass filters before engineers see them: builds, passes reliably over repeated runs, and increases coverage.
  - 75% of generated tests built correctly, 57% passed reliably, and 25% increased coverage.
  - In Instagram and Facebook test-a-thons it improved 11.5% of the classes it was applied to, and **73%** of its recommendations were accepted for production.
- **Meta ACH, "Mutation-Guided LLM-based Test Generation at Meta"**, arXiv 2501.12862, Jan 2025. ID confirmed via list. **research (industrial; recalled, medium confidence).**
  - It generates targeted mutants (for example privacy faults), then tests that kill them.
  - Engineers accepted about 73% of the tests, and about 36% were judged privacy-relevant.
- **SWT-bench, "Testing and Validating Real-World Bug-Fixes with Code Agents"**, arXiv 2406.12952, NeurIPS 2024. Repo README fetched 2026-11-05. **research + code/docs.**
  - Task: generate a test that fails before the fix and passes after it. Docker-based harness.
  - Recalled: code agents built for repair beat dedicated test generators. Using generated tests to filter candidate patches roughly **doubled SWE-Agent's precision**.
- **The oracle problem.** "Do LLMs generate test oracles that capture the actual or the expected program behaviour?" (arXiv 2410.21136, title confirmed). **research (recalled, medium confidence).**
  - LLM-written assertions tend to encode the code's *actual* behaviour, including its bugs, rather than intended behaviour.
  - **implication:** a generated test that passes on the PR head proves little. Differential checks (base vs head), tests derived from the PR's stated intent, and mutation-kill are the useful forms.
- "Can LLM Generate Regression Tests for Software Commits?" (arXiv 2501.11086) is directly about commit-time tests. Title confirmed; contents not read.

### 5.2 Changed-line (diff) coverage (supported, cheap, deterministic)

- **Google** surfaces per-changelist coverage in code review at scale. Ivanković, Petrović, Just & Fraser, "Code Coverage at Google", ESEC/FSE 2019. **research (industrial; recalled, qualitative).**
- **Google mutation testing in code review.** **research (industrial; recalled, qualitative).**
  - Petrović & Ivanković, ICSE-SEIP 2018; Petrović et al., "Practical Mutation Testing at Scale" (TSE 2021) and "Does mutation testing improve testing practices?" (ICSE 2021).
  - Surviving mutants on changed lines are shown in review, and developers exposed to them write more tests.
- **Tooling** (fetched 2026-11-05). **code/docs.**
  - `diff-cover` (PyPI 11.0.1, uploaded 2026-11-04) reports "the percentage of new or modified lines that are covered by tests". It reads Cobertura, Clover, JaCoCo and **LCov**.
  - Bun's test runner writes `lcov.info` with `bun test --coverage --coverage-reporter=lcov`.
  - Caveat from Bun's docs: with only the lcov reporter, the coverage threshold check currently exits 0 regardless of the threshold.

### 5.3 PR-time fuzzing (supported for fuzzable targets)

- **CIFuzz (OSS-Fuzz)** docs, fetched 2026-11-05. **code/docs.**
  - It builds fuzzers at the PR commit and runs them "for a short amount of time": **10 minutes by default**, and `fuzz-seconds` "should be at minimum 600 seconds".
  - It reports a crash only if the crash is reproducible **and** does not occur on older OSS-Fuzz builds, so only regressions the PR introduced are reported.
  - With coverage support it runs only the fuzzers the PR affects. It reuses 30-day-old corpora.
  - It requires OSS-Fuzz integration. ClusterFuzzLite is the route for other projects.
- **OSS-Fuzz-gen** README, fetched 2026-11-05. **code/docs (Google).**
  - LLM-generated fuzz targets for C/C++/Java/Python.
  - In a 2024-01-31 experiment over 1,300+ benchmarks from 297 projects, valid targets were produced for 160 C/C++ projects, with a maximum line-coverage gain of 29% over human-written targets.
  - **30 new bugs** reported, including **CVE-2024-9143 (OpenSSL)**. These "could only have been discovered with newly generated targets."
  - Google's Nov 2024 security blog reported 26 vulnerabilities at that time (recalled).
- **inference:** for TypeScript/Bun apps (Vector's own stack), classic coverage-guided fuzzing is a niche fit. Property-based tests generated for changed pure functions are the closer analogue. No study found measures their bug yield in review.

### 5.4 Executing PR code in sandboxes (practical on Linux CI)

- **GitHub-hosted runners** (`github/docs` `content/actions/reference/runners/github-hosted-runners.md`, fetched 2026-11-05). **code/docs.**
  - "The Linux and macOS virtual machines both run using passwordless `sudo`."
  - Windows VMs run as administrators with UAC disabled.
  - **`ubuntu-slim` runs in an unprivileged container**: "accessing low-level kernel features" and Docker-in-Docker are not supported.
- **Firecracker** README: microVMs use Linux KVM. **gVisor** README: requires Linux 5.6+. **code/docs.**
  - Strong isolation is Linux-host-only, and these tools are not usable on macOS desktops.
- **inference (well-known security practice, not re-verified):**
  - Running untrusted fork PR code with secrets (for example under `pull_request_target`) is dangerous.
  - Run executions with no secrets, or in a separate unprivileged job, and pass results as artifacts.

### 5.5 eBPF (feasible only on privileged Linux; value for review unstudied)

All of the following are **code/docs**, fetched 2026-11-05.

- **Kernel defaults.** From `torvalds/linux` `Documentation/admin-guide/sysctl/kernel.rst` and `kernel/bpf/Kconfig`.
  - `BPF_UNPRIV_DEFAULT_OFF` is `default y`, which sets `unprivileged_bpf_disabled=2`.
  - In that state, `bpf()` without `CAP_SYS_ADMIN` or `CAP_BPF` returns `-EPERM`.
  - `perf_event_paranoid` defaults to 2. Tracepoint and ftrace use requires `CAP_PERFMON`.
- **Docker's default seccomp profile** (`moby/profiles/seccomp/default.json`).
  - It allows `bpf` only with `CAP_SYS_ADMIN` or `CAP_BPF`, and `perf_event_open` only with `CAP_PERFMON`.
  - Ordinary containers cannot use eBPF.
- **OpenTelemetry eBPF Instrumentation (OBI).** From the `SUPPORT_MATRIX.md` and opentelemetry.io `zero-code/obi/security.md`.
  - Supported only on Linux amd64 and arm64.
  - Kernel 5.8+, or 4.18+ on RHEL-family distributions with backports. The kernel must expose BTF.
  - Needs root or a list of capabilities: `CAP_BPF`, `CAP_PERFMON`, `CAP_NET_ADMIN`, `CAP_NET_RAW`, `CAP_DAC_READ_SEARCH`, `CAP_CHECKPOINT_RESTORE` and `CAP_SYS_PTRACE`. Some features need `CAP_SYS_ADMIN`.
  - The Docker quick-start uses `--privileged`.
  - "Other operating systems ... are not part of the supported runtime matrix."
  - Debian-style `perf_event_paranoid=3` blocks `perf_event_open`. OBI ≥0.14 falls back to tracefs.
- **eBPF for Windows** README.
  - "Work-in-progress". Supports Windows 11+ and Server 2022+.
  - Offers source compatibility only for "common hooks and helpers". Linux-specific hooks don't apply.
- **macOS:** no eBPF. DTrace is restricted under System Integrity Protection. **inference/recalled; not verified this session.**
- **Value for review:** I found **no study** measuring eBPF-collected runtime evidence improving code review outcomes. **inference.**
- **implication:** make eBPF an optional, Linux-CI-only enricher. Use it, for example, to record syscalls, network and file access of the PR's test run, and diff them against base to flag new egress or file writes. Requirements and scope:
  - standard `ubuntu-*` runners with `sudo`, not `ubuntu-slim`;
  - never required, and never in the desktop local mode on macOS or Windows.

### 5.6 OpenTelemetry (portable in-process; review value unstudied)

- **code/docs:** the opentelemetry.io zero-code index (fetched 2026-11-05) lists zero-code instrumentation per language, and the Kubernetes Operator injects it for .NET, Java, Node.js, Python and Go.
- **inference:**
  - SDK and agent instrumentation runs in-process, needs no kernel privileges, and works on Linux, macOS and Windows.
  - It only sees code paths that tests or scripted runs actually exercise.
  - Plausible review use: run the PR's tests with tracing on base and head, and diff the span graphs (new outbound calls, DB queries, error spans, latency outliers) as "blast radius" evidence.
- No study was found measuring this in review. Bun compatibility with OTel's Node auto-instrumentation hooks was not checked.

### 5.7 Implications for Vectorscope

Ordered by evidence and cost:

1. **Run the repo's existing tests on head (and base when cheap), and compute diff coverage** from lcov. Surface "changed lines not covered" as a deterministic, low-false-positive finding.
2. **Generate tests TestGen-LLM-style**, only for changed units, and keep a test only if it:
   - (a) compiles;
   - (b) passes on head N times (flakiness filter);
   - (c) either raises changed-line coverage or **behaves differently on base vs head** in a way that matches the PR's stated intent.

   Treat a head-only pass as weak evidence (the oracle problem). Use failing differential tests as *evidence attached to a finding*, not as findings on their own.
3. **Use execution to verify hypotheses.** A review hypothesis ("X is null when Y") becomes much stronger when a generated reproducer runs. This is the bridge between §3.4 and §5.
4. **Fuzz only when the repo already has fuzz targets or is a C/C++/Rust/Go/Java library.** Copy CIFuzz's "new crash only, time-boxed" rule.
5. **eBPF and OTel are optional enrichers**, gated by platform and privilege detection, with no claims of bug-detection uplift until measured.

---

## 6. Open questions

- What exactly did Greptile's "Model Inversion" study measure? Specifically: per-model counts, the comment-count normalisation, the judge, CIs, and whether "~10%" is relative or absolute. Needs `greptile.com` access or contact.
- Does a cross-family reviewer still help at **equal capability tier** and **fixed comment budget**? No public data either way. This needs an in-house A/B.
- How large is the verification-pass effect in a controlled ablation (same model and context, with vs without verify)? Industrial numbers exist; controlled ones were not found.
- What are the numeric results of AACR-Bench, SWR-Bench, CR-Bench, CodeFuse-CR-Bench and RovoDev? Each paper needs reading once `arxiv.org` is reachable.
- Has anyone replicated Meta's Diff Risk Score outside Meta, or shown LLM-based JIT-DP beating simple churn and size baselines under time-aware evaluation?
- Does surfacing a risk score in review change outcomes today? The only rigorous deployment study (Google 2013) found no behaviour change.
- What is the bug yield per CI-minute of PR-time generated tests and property tests for TypeScript/Bun projects, as opposed to C/C++ fuzzing?
- Is there any measured review benefit from eBPF or OpenTelemetry runtime diffs? None found.
- Every **(recalled)** number in this file should be re-checked against the paper once the network allows.

---

## 7. Source list

"Fetched" means read this session on 2026-11-05. "Recalled" means not re-fetched.

**Fetched (code/docs or data):**

- Martian Code Review Bench: https://github.com/withmartian/code-review-benchmark (README, `offline/README.md`, `online/README.md`, `offline/analysis/benchmark_dashboard.json`; `main` fetched 2026-11-05; sibling notes record commit e616e84, 2026-08-30). independent evaluation.
- AACR-Bench README: https://github.com/alibaba/aacr-bench (fetched 2026-11-05; paper arXiv 2601.19494, Jan 2026).
- lm-similarity README (Goel et al. 2025): https://github.com/model-similarity/lm-similarity (fetched 2026-11-05).
- BIG-Bench Mistake README and Table 4 image: https://github.com/WHGTyen/BIG-Bench-Mistake (fetched 2026-11-05; ACL Findings 2024).
- Self-repair repo: https://github.com/theoxo/self-repair (fetched 2026-11-05; ICLR 2024).
- FastChat llm_judge README: https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge (fetched 2026-11-05).
- ISSTA'21 JIT-DP artifact: https://github.com/ZZR0/ISSTA21-JIT-DP (fetched 2026-11-05).
- JIT-Fine replication: https://github.com/jacknichao/JIT-Fine (fetched 2026-11-05; FSE 2022).
- SZZ developer-informed oracle replication: https://github.com/grosa1/icse2021-szz-replication-package (fetched 2026-11-05; ICSE 2021).
- CRScore README: https://github.com/atharva-naik/CRScore (fetched 2026-11-05; arXiv 2409.19801).
- SWT-bench README: https://github.com/logic-star-ai/swt-bench (fetched 2026-11-05; NeurIPS 2024, arXiv 2406.12952).
- CIFuzz docs: https://github.com/google/oss-fuzz/blob/master/docs/getting-started/continuous_integration.md (fetched 2026-11-05).
- OSS-Fuzz-gen README: https://github.com/google/oss-fuzz-gen (fetched 2026-11-05).
- Linux kernel sysctl docs: https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/sysctl/kernel.rst; BPF Kconfig: https://github.com/torvalds/linux/blob/master/kernel/bpf/Kconfig (fetched 2026-11-05).
- Docker default seccomp: https://github.com/moby/profiles/blob/main/seccomp/default.json (fetched 2026-11-05).
- OBI README and SUPPORT_MATRIX: https://github.com/open-telemetry/opentelemetry-ebpf-instrumentation (fetched 2026-11-05); OBI security docs: https://github.com/open-telemetry/opentelemetry.io/blob/main/content/en/docs/zero-code/obi/security.md (fetched 2026-11-05); zero-code index, same repo.
- eBPF for Windows README: https://github.com/microsoft/ebpf-for-windows (fetched 2026-11-05).
- Firecracker README: https://github.com/firecracker-microvm/firecracker; gVisor README: https://github.com/google/gvisor (fetched 2026-11-05).
- GitHub-hosted runners reference: https://github.com/github/docs/blob/main/content/actions/reference/runners/github-hosted-runners.md (fetched 2026-11-05).
- diff-cover on PyPI: https://pypi.org/project/diff-cover/ (11.0.1, uploaded 2026-11-04; fetched 2026-11-05).
- Bun coverage docs: https://github.com/oven-sh/bun/blob/main/docs/test/code-coverage.mdx (fetched 2026-11-05).
- Bibliographic lists: https://github.com/codefuse-ai/Awesome-Code-LLM and https://github.com/llm-as-a-judge/Awesome-LLM-as-a-judge (fetched 2026-11-05; used only to confirm titles, IDs and months).

**Recalled research (verify before quoting):**

- Zheng et al., arXiv 2306.05685 (2023), NeurIPS 2023 D&B.
- Panickssery et al., arXiv 2404.13076 (2024), NeurIPS 2024.
- Wataoka et al., arXiv 2410.21819 (2024).
- Chen et al., "Do LLM Evaluators Prefer Themselves for a Reason?" (2025; ID unverified).
- Xu et al., arXiv 2402.11436, ACL 2024.
- Li et al., arXiv 2502.01534 (2025).
- Kim et al., arXiv 2506.07962, ICML 2025.
- Goel et al., arXiv 2502.04313 (2025).
- Huang et al., arXiv 2310.01798, ICLR 2024.
- McAleese et al., arXiv 2407.00215 (2024).
- Cihan et al., arXiv 2412.18531, ICSE-SEIP 2025.
- BitsAI-CR, arXiv 2501.15134 (2025).
- AutoCommenter, arXiv 2405.13565 (2024).
- RovoDev, arXiv 2601.01129 (2026).
- 2505.17928 (ICML 2025); 2502.02757; 2412.18291; 2501.05176; 2502.06633; 2509.01494; 2509.14856; 2511.07017; 2603.11078.
- Kamei et al., TSE 2013; Nagappan & Ball, ICSE 2005; Moser et al., ICSE 2008; Rahman & Devanbu, ICSE 2013; Hassan, ICSE 2009; Kim et al., ICSE 2007.
- Zeng et al., ISSTA 2021; Yang et al., FSE 2016; Fu & Menzies, FSE 2017.
- Herzig et al., ICSE 2013; Herbold et al., EMSE 2022; Cabral et al., ICSE 2019.
- Lewis et al., ICSE 2013; Google Engineering Tools blog, Dec 2011.
- Meta DRS (arXiv 2410.06351 per recall; Meta engineering blog 2025).
- Tornhill & Borg, TechDebt 2022.
- TestGen-LLM, arXiv 2402.09171, FSE 2024 Industry.
- ACH, arXiv 2501.12862 (2025).
- arXiv 2410.21136 (2024); arXiv 2501.11086 (2025).
- Ivanković et al., ESEC/FSE 2019.
- Petrović et al., ICSE-SEIP 2018, TSE 2021, ICSE 2021.
- Google Security Blog, "Leveling up fuzzing", Nov 2024.

**Sibling notes (this workflow; sources not re-opened by me):**

- Greptile "Model Inversion" (~2026-07-21) and "How to build a code review agent" (~2026-10/11).
- Greptile addressed-rate A/Bs.
- arXiv 2604.03196, 2607.21997, 2608.21311.

See `greptile-quality.md`, `greptile-trust-cost.md` and `greptile-architecture.md` in this folder.
