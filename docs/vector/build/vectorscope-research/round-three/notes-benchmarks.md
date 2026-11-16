# Round three, lens "Independent evidence on AI code reviewers": notes for VectorScope

Lane note as written before the adversarial verify pass; REPORT-3 states each finding in its verified, corrected form.

Compiled 2026-11-07 against worktree `vectorscope` at 41a64e5e. It builds on round one (`vectorscope-research/REPORT.md`, `evidence.md`, `greptile-quality.md`, `landscape.md`) and round two (`round-two/REPORT.md` §3, `notes/greptile-users.md`, `notes/retrieval-research.md`, `notes/gap-1.md`, `notes/gap-3.md`, `notes/verify-open-items.md`). Round-two material is not repeated unless this round corrects or extends it.

**Labels.** *academic* (paper or preprint), *independent* (a third party measured it, or we measured it from third-party data), *vendor* (a company about itself or a rival), *code* (read in a repository, dataset or README), *user-report*, *inference* (my reasoning, always flagged). "Extract" means the text came from a search-engine extract, not a full read of the page.

`newSinceRoundTwo = true` means rounds one and two did not report the item, or reported only its title. Each source carries its own date, because several predate round two and were simply missed.

**Naming.** As in round two, open-source coding-agent CLIs and harnesses are referred to generically. Alibaba's open-source review agent is called "OCR".

---

## 0. Access and method

- **Reachable:** `git clone` and `git ls-remote` of public GitHub repositories, `raw.githubusercontent.com`, WebFetch of github.com pages, and web search.
- **Unreachable (DNS refused):** arxiv.org (including export and PDF), alphaxiv.org, huggingface.co, openreview.net, semanticscholar.org, conf.researchr.org, dl.acm.org, paperswithcode.com, every github.io host tried, and api.github.com (403). I stopped probing new hosts after these refusals. **So every paper number here comes from a search extract or from the paper's own repository, never from the paper's PDF.** Opening arxiv.org and huggingface.co in the session's network settings would let a later pass read the tables directly.
- **Benchmarks unchanged since round two:**
  - AACR-Bench `ee9d7fe` (2026-10-15);
  - ReviewBench `f223ce3` (2026-11-05);
  - Martian `e616e84` (2026-08-30);
  - CRBugBench `e8e585e` (2026-10-07);
  - Fletcher `bc9116b`;
  - OCR moved from `891df1b` to `0d40339` (2026-11-06), a test-isolation fix only.
- **Repositories read this round:**
  - SWR-Bench `ZZR0/SWRench` at `67ae1d4` (2026-06-05);
  - ContextCRBench at `ade378c` (2026-02-27);
  - SWE-CARE (CodeFuse-CR-Bench) at `d0b419c` (2026-04-21);
  - the SWE-PRBench harness at `379f0bf` (2026-03-30);
  - the SEVRA-Bench harness at `1d5cf2b` (2026-10-21);
  - the Archer, CRBugBench and AACR-Bench licence files.
- **Own measurements (single-pass, internal diagnostics only, D12):**
  - per-PR licence classification for ReviewBench's 219 PRs at their base commits;
  - licences of SWR-Bench's 12 repositories at their earliest and latest base commits;
  - lvgl's licence at the 4 AACR PR commits;
  - SWR-Bench dataset statistics.
  - Method: fetch the first licence file found at standard root paths through `raw.githubusercontent.com/<repo>/<sha>/<name>`, then keyword-classify it. The classifier is described in §5. It sees the root licence file only, so it misses per-path licences and dual licensing.
- **Process deviations, reported honestly:**
  - Clones and fetched licence texts went to a working directory beside the output folder (`scratchpad/r3bench/`), not into the output folder. It held downloaded third-party data only. I deleted it after writing these notes, so the licence and SWR-Bench counts in §2 and §5 can be re-derived only from the method described in §5 and the commits listed in §10.
  - A `git grep` I ran in a sibling lane's ReviewBench clone (`vectorscope-research-3/src/rb`, a lane clone and a session record kept outside the repository, I-13) set off git's automatic background `gc` in that clone. It rewrote pack files only, and the content is unchanged.
  - I did not open ContextCRBench's committed `download_script/tokens.tk`, which looks like a credentials file.

---

## 1. What rounds one and two concluded on this lens, and what they left open

**Concluded (not repeated below):**
- Martian's offline set (50 PRs) is the only open cross-vendor set that includes Greptile.
  - The default view is Core F2, where Greptile v4.1 is 9th of 21.
  - Scoring choices move ranks more than products do.
  - Greptile's measured strength is precision.
  - At most 13 of the 50 PRs are D8-clean.
- ReviewBench is vendor-affiliated and has no Greptile entry.
  - 98% of its goldens are LLM-produced.
  - Per-repository licences were unchecked.
- AACR-Bench's permissive subset (144 PRs) is the proposed D8-clean external source (Q31).
  - About 74% of its goldens are model-written.
  - lvgl had been checked at HEAD only.
- Academic and field studies: CodeRabbit's corpus (56.3% of comments rejected), ai-review-churn, RevMate (7–8% acceptance), c-CRAB, CRBugBench, Archer, Fletcher, Beko/Qodo (higher resolution, slower closure), and BitsAI-CR.
- ContextCRBench, CodeFuse-CR-Bench, SWR-Bench and CR-Bench were known by title or by extract only.

**Left open:**
- the paper tables (arXiv was blocked);
- SWR-Bench's details;
- the "Haiku beats Sonnet" result (arXiv 2606.15689), marked unverified;
- RovoDev's numbers, marked "not verified, none quoted";
- ReviewBench's per-repository licences;
- lvgl's licence at its PR commits;
- Martian's October figures, marked unverifiable.

---

## 2. Academic benchmarks: what is new, and how far to trust it

| Benchmark (date) | Size and labels | Metric | Results (exact source wording) | Greptile? | Credibility | Licence and D8 |
|---|---|---|---|---|---|---|
| **SWR-Bench** (arXiv 2509.01494, v1 2025-09-01; FSE 2026; repository 2026-06-05) **code + academic** | README: "**1,000 real PR instances** from 12 popular Python open-source projects"; "**Balanced labels**: 500 PRs with reviewer-confirmed introduced changes, 500 clean PRs". Labels: an LLM (`CHAT_MODEL = 'gemini-2.5-flash-preview-04-17'` in `collect_pr_review.py`) mines PR timelines for issues that were introduced in the PR, found by a human reviewer, discussed, and fixed in the PR; the authors then verify them manually. | PR-level P/R/F1/accuracy (change vs clean); point-level P/R/F1; clean-PR false-positive severity; E (evolvability) and F (functional) breakdown | Extract: best tool "Overall-F1: 18.73%" (one version), 19.38% (another); "multi-review aggregation strategy that raises F1 scores by up to 43.67%". Judge agreement with humans "∼90%". | No. It tests prompt, iterative and PR-Agent-style baselines, plus an open-source software-engineering agent harness | Medium. Human-reviewer-sourced labels miss bugs that reviewers missed. **My count: 642 of 949 ground-truth changes are E (docs, structure), only 307 are F (functional), and only 278 PRs have at least one functional change.** The repositories are SWE-bench's 12, with PRs from 2011 to 2025, so heavy contamination is likely (§6). | Harness and data MIT. Repositories: pylint is GPL-2.0 (50 PRs); matplotlib uses its own PSF-style licence (153 PRs); requests was ISC before about 2013 (7 PRs); the rest are BSD, MIT or Apache-2.0. **Permissive subset (my count): 797 PRs, 393 positive, 404 clean, of which 210 have functional changes.** The commits carry author names and email addresses; strip them. |
| **CR-Bench** (arXiv 2603.11078, Nutanix, 2026-03) and **CR-Bench-v2** (arXiv 2611.02566, 2026-11-02) **academic (extract)** | "CR-Bench = 584, CR-Bench-verified = 174". It recasts SWE-bench issues as PR review tasks with one labelled defect each. The reference comments and taxonomy are "LLM-generated using Claude Opus 4.5" (secondary summary). | KDDR (recall on the labelled defect), precision (bug hits ÷ all comments), usefulness (bug hits plus valid suggestions ÷ all comments), SNR; three LLM judges | v1: "single-shot with GPT-5.2 reached Recall 27.01%, Precision 3.56%, F1 6.30%, Usefulness 83.63%, SNR 5.11". v2: "Strongest systems: KDDR ≈ 33% on CR-Bench-Verified"; "Gemini Code Assist: KDDR 8.1% but Usefulness Rate 78.0%, so usefulness alone misleads". Reflexion raises KDDR for every backbone (+6.9 to +12.6 points for GPT-5-mini, depending on the judge). | No. Gemini Code Assist is the only commercial tool | Low for precision: with **one label per instance**, every other real finding counts against precision, so 3.56% says more about the labels than the reviewer. It is the same flaw as Greptile's "82% catch rate", in reverse. Python only, Django-heavy, SWE-bench contamination. Its usefulness-versus-recall split is the useful part. | No repository or data licence found. It inherits SWE-bench's repositories (pylint GPL). **Not usable** until a licence is found. |
| **SWE-PRBench** (arXiv 2603.26130, 2026-03-27; harness 2026-03-30) **academic + code** | 350 PRs filtered from 700 by a "Repository Quality Score". Ground truth is the human review comments on merged PRs: initiating comments of at least 10 words, not style-only (`RUBRIC.md`). The judge is GPT-5.2, "validated at kappa=0.75" (extract). | Detection rate (DR) by context configuration, FPR, overall score; comments classed **CONFIRMED / PLAUSIBLE / FABRICATED** | Extract: "8 frontier models detect only 15-31% of human-flagged issues" with the diff only; "All 8 models degrade monotonically from config_A to config_C". README leaderboard: "\| 1 \| Claude Haiku 4.5 \| 0.153 \| 0.306 \| 0.346 \|" and "\| 2 \| Claude Sonnet 4.6 \| 0.152 \| 0.297 \| 0.227 \|" (overall, DR_A, FPR). | No | Medium. A single author, one judge in the main run, and human-comment ground truth (incomplete). Its PLAUSIBLE class is the right fix for incomplete goldens. More context hurt every model, which disagrees with AACR's mixed result and with ContextCRBench. | Harness MIT. Dataset "CC BY 4.0 (see HuggingFace)" per the README; the card itself could not be read. Source-repository licences unchecked. **CC BY is outside D8's MIT, Apache-2.0 and BSD list.** |
| **ContextCRBench** (arXiv 2511.07017, 2025-11-10; FSE 2026 industry track; repository 2026-02-27) **code + academic** | 67,910 entries from 153.7k issues and PRs in 90 repositories (C, C++, C#, Go, Java, JS, Python, Rust). Hunk-level tasks. Each entry stores `content_before` and `content_after` (whole files). | Hunk assessment, line localisation, comment generation | Round two's "textual context yields greater gains" still stands (extract) | No | Medium for its question (intent text against code context), low as a PR-review test | **No LICENSE file in the repository.** The data sits on Google Drive (1.56 GB). Its repositories include copyleft and source-available licences (systemd, mpv, netdata, redis, elasticsearch, cockroach, terraform and others), with whole files copied. **Not usable.** |
| **SWE-CARE / CodeFuse-CR-Bench** (arXiv 2509.14856, 2025-09; repository 2026-04-21) **code + academic** | 601 instances, 70 Python projects, 9 problem domains; repository-level context | Reward model plus LLM judges | Round two (extract): BM25 top-k context, and extra context can hurt | No | Medium-low (Python only; LLM-judged) | Code Apache-2.0. The data licence on Hugging Face (`inclusionAI/SWE-CARE`) could not be read. Project licences unchecked. **Pending.** |
| **MCR-Bench** (arXiv 2608.27442, Aug 2026; ISSTA 2026) **academic (extract)** | "2,269 real-world multi-round code review tasks" in 5 languages; at least 2 rounds per task, average 3.8; each defect tracked as new, open, resolved or reappearing | P/R/F1 per round | ISSTA abstract: "limited overall performance in defect detection". A secondary blog (2026-09-01, unverified) reports a best F1 of 0.55 and says about a third of false positives re-raise defects that were already resolved. | No | Medium; numbers unverified | Licence unknown |
| **CodeReviewQA** (arXiv 2503.16167, 2025-03; v2) **academic (extract)** | "900 manually verified examples across 9 programming languages" from 199 repositories; multiple-choice probes (change type, localisation, solution) | MCQA accuracy over 72 models | Localisation is hardest; a reformulation designed to limit contamination | No | Measures comprehension, not end-to-end review. Low relevance | Hugging Face licence unread |
| **CRJudgeBench** (arXiv 2609.37216, 2026-09; under review) **academic (extract)** | "1,199 instances" of real-PR comments plus expert-verified plausible-but-invalid perturbations; 359-instance test split | Judge accuracy | "Sentinel… reaches 76.60% accuracy on the test set, which the abstract says is 6.13 percentage points above GLM-5.3 and 19.78 points above its base model"; frontier models "struggle to identify plausible but technically incorrect review comments" | n/a | Medium (abstract only) | Hugging Face `dcloud347/CRJudgeBenchmark`; licence unread |
| **SEVRA-Bench** (arXiv 2606.13757, 2026-06-11; FLMSec, a NeurIPS 2026 workshop; harness 2026-10-21) **code + academic** | 2,250 malicious PRs that reverse real CVE fixes, each under one of 15 social-engineering framings. A "retained challenge split" of 1,062, plus 347 benign security fixes. The diff is fixed; only the narrative varies. | Refusal rate (RR), security-reason rate (SRR), false-decline rate | README: "\| Claude Opus 4.7 \| 98 \| 70 \|", "\| GPT-5.5 \| 95 \| 70 \|", "\| Claude Haiku 4.5 \| 53 \| 44 \|", "\| GPT-5.4-nano \| 36 \| 37 \|" | No | Medium-high as a method: paired design with a false-decline guard. The challenge split is chosen adversarially. | Dataset card `license: mit` (`README_hf.md`), gated. **The harness repository has no LICENSE file.** The CVE-fix code keeps its own licences. **Use the method, not the data.** |
| **PRWeaver** (arXiv 2608.02693, Aug 2026) **academic (extract)** | "208 execution-validated base attacks spanning ten repository targets… each instantiated under four matched review renderings" (832) | Detection | "decomposition alone changes detection by at most five points… whole-window interleaving produces a strong dose-dependent degradation". Auditors: OCR, Claude Code, Copilot code review. | No | Medium | Unknown |
| **Sphinx** (arXiv 2601.04252, 2026-01-06; Rochester with Microsoft) **academic (extract)** | Checklist-based PR review benchmark | Checklist coverage | "outperforming… baselines by up to 40% in checklist coverage" | No | Data "will be released after review" | Not released |
| **Survey of code review benchmarks** (arXiv 2602.13377, 2026-02-13) **academic (extract)** | 99 papers (58 before LLMs, 41 since) | — | Calls for "dynamic runtime evaluation, and taxonomy-guided fine-grained assessment" | — | Useful map | — |

**Cross-cutting reading** (inference, from the rows above):
- **No academic benchmark includes Greptile.** They test models and open harnesses (PR-Agent, OCR, Claude Code, an open-source agent harness), plus Gemini Code Assist in CR-Bench and Copilot in PRWeaver.
- **Absolute scores are low everywhere, and they are not comparable.** Best F1 is about 19% on SWR-Bench, best KDDR about 33% on CR-Bench, best detection 15–31% on SWE-PRBench, and best SEM-F1 25% on AACR (round two). The ground truth (human-reviewer comments, one planted defect, LLM-written goldens), the unit (PR, point, comment) and the judge differ in each.
- **Two independent sources now agree that the smaller Claude model has the higher recall and the larger one the better precision.**
  - SWE-PRBench: Haiku 4.5 has DR_A 0.306 and FPR 0.346; Sonnet 4.6 has 0.297 and 0.227.
  - arXiv 2606.15689: Haiku F1 0.365 against Sonnet's 0.343 and "18% higher recall", while "Sonnet wins on precision and severity-weighted F1" (extract).
  - This settles round two's "unverified" item at extract level. The arXiv listing date conflicts with the ID (one extract says submitted 9 April 2026; the 2606 ID means June).
- **Context depth.** SWE-PRBench (monotone harm), AACR (depends on model and paradigm) and ContextCRBench (text beats code) together say that adding context must be shown to help, model by model. That is VS-25's gate as written: +10 points at equal or fewer tokens.
- **Aggregation and reflection help recall.**
  - SWR-Bench's multi-review aggregation: "up to 43.67%" F1.
  - CR-Bench's Reflexion raises KDDR for every backbone.
  - This corroborates VS-28's union-then-verify design. No source isolates the precision cost.

---

## 3. Third-party head-to-heads that include Greptile (new since round two)

| Source (date) | Kind | Method | Where Greptile ranked | Credibility |
|---|---|---|---|---|
| **AIMultiple "RevEval"** (page last updated 2026-03-13; https://aimultiple.com/ai-code-review-tools) | Independent analyst (it ranks vendors; its funding model is not stated; extract only) | "the top four AI code review tools across 309 pull requests from repositories of varying sizes, using input from 10 developers and an LLM-as-a-judge". Repositories cloned at a baseline date, later PRs replayed in order. Ranked by the share of PRs on which each tool scored highest. | "CodeRabbit ranked as the most successful code review tool across 51% of 309 PRs", followed by Greptile, then Copilot. Bugbot gave "less detailed and less accurate analysis". | **Low.** Winner-take-all per PR rewards detail and volume; there is no P/R; one extract says 289 PRs across 7 repositories. Missed in rounds one and two. |
| **Martian online board, 2026-10-06** (Help Net Security and DevX coverage of ReviewBench, extract) | Press relaying Martian's live board | Online F1 (fix-matching) | "its online leaderboard puts Cubic first with a 64.9% F1 score, followed by Greptile and CodeRabbit, while GitHub Copilot ranks fourth at 60.9%" | Secondary. It matches round two's competitor snapshots (Greptile 2nd, Cubic 1st), but the board itself is still unread, and its method changed in August. **Still not verified.** |
| **ReviewBench** (GitHub, 2026-10-05; repository `f223ce3`) | Vendor-affiliated | Grounded P/R/F1 | **No Greptile entry**; Copilot leads at "40.1% grounded F1" | Unchanged from round two |
| **DeepSource, "Every AI code review vendor benchmarks itself, and wins"** (2026, extract) | Vendor critique, then its own benchmark | OpenSSF CVE benchmark | Not a Greptile ranking | Vendor. Its framing is correct, and its own numbers are vendor numbers |
| **Macroscope, Entelligence, Cubic, Augment, Baz, CodeAnt** (2026) | Vendor or competitor | Various | Various | Already classed as vendor in round one §5; nothing new that is independent |

**Bottom line** (inference): since round two, **no new independent, reproducible number for Greptile has appeared.** The one new independent-ish ranking (AIMultiple, March) has the weakest method. On the evidence, Greptile remains a precision-leaning, mid-to-upper-pack reviewer whose rank depends on the metric. Academia has not measured it at all.

---

## 4. Field studies: adoption and accepted-comment rates

| Study (date) | Population | Definition of "accepted" | Rate | Kind and caveat |
|---|---|---|---|---|
| **RovoDev Code Reviewer** (arXiv 2601.01129, 2026-01; ICSE SEIP 2026) | Atlassian, "more than 1,900 repositories", "over 54,000 code review comments", one year | The comment "led to code changes in later commits" | "Roughly 38.7%… only 12.9% relatively lower than human-written comments (44.45%)". Cycle time: "a 30.8% reduction in median time from 20.73 hours to 14.35 hours"; human comments −35.6%. | Industrial, written by the vendor's own staff. The cycle-time effect comes from interrupted time series, and the authors themselves call for A/B or difference-in-differences designs. **Closes round one's "numbers not verified".** |
| **Sun et al., "Does AI Code Review Lead to Code Changes?"** (arXiv 2508.18771, v1 2025-08-26, v2 2026-04-25) | 16 GitHub Actions review tools, "more than 22,000 review comments in 178 repositories" | Valid comment addressed (LLM-assisted classifier) | "Human-authored comments were significantly more likely to be addressed (60% for valid comments) compared to AI-generated comments (0.9%–19.2% depending on the tool)" | Academic. The definition is strict and the tools are mostly 2023–2025 Actions. Round two recalled it with no numbers. |
| **"Human-AI Synergy in Agentic Code Review"** (arXiv 2603.15911, 2026-03; Zhong, Noei, Zou, Adams) | "278,790 code review conversations across 300 open-source GitHub projects", 16 AI review bots, 2022–2025 | Suggestion adopted into the codebase | AI suggestions are adopted "at a significantly lower rate" than human ones. "Conversations ending on an AI response have higher rejection rates, at 7.1% to 25.8%, versus 0.9% to 7.8%". Adopted AI suggestions increase complexity and size more. | Academic (abstract-level extract). Its dataset (Hugging Face `Suzhen/AgentReviewChat`) could not be checked. |
| **"On the Footprints of Reviewer Bots' Feedback on Agentic PRs"** (arXiv 2604.24450, 2026-04; MSR 2026) | "7,416 reviewer-bot comments on 4,532 agentic PRs" from AIDev | Quality coded by the authors; outcomes from PR metadata | More bot comments on a PR go with longer resolution and lower average quality (a "dilution effect"). Per the abstract, feedback quality shows "no meaningful association with workflow outcomes". | Academic. Secondary summaries contradict the abstract on the quality–outcome link; rely on the abstract. |
| **"AI-to-AI Code Reviews of GitHub PRs"** (ESEM 2026, LIPIcs vol. 394; arXiv 2608.21311) | 248,641 agent-authored PRs with at least one AI review (CodAGE) | — | Cross-product AI-to-AI review in "about 1.6%" of agent-authored PRs; a reviewer's output varies with which agent wrote the PR | Academic (LIPIcs extract). Round one had the title only. |
| Round two, for comparison | CodeRabbit corpus 36.4% accepted; ai-review-churn 42.9% resolved alone against 74.4% with a human present; RevMate 8.1% and 7.2% | — | — | — |
| Vendor rates | Greptile addressed rate 66% (v5); Cursor resolution 78.13%; Uber uReview "over 65%" addressed (extract) | Each vendor's own definition | — | Vendor |

**Reading** (inference):
- **"Accepted-comment rate" ranges from under 1% to 78%** across these studies. It depends on:
  - the definition: a thread resolved, a commit touching the file, or an LLM judging the comment addressed;
  - the population: an opt-in team or all of GitHub;
  - whether a human also reviews: 42.9% against 74.4%.
- So the rate is comparable only **within one population, with one definition, as a paired or A/B comparison.** It can never be set against a vendor's addressed rate.
- **Acceptance and usefulness mislead about recall.** CR-Bench shows Gemini Code Assist at 78.0% usefulness but 8.1% KDDR. Footprints finds that volume dilutes quality while quality does not predict outcomes. RovoDev (faster) and Beko (slower) disagree on cycle time.
- **The field evidence supports precision-first only together with a recall floor.** That is exactly D2's paired-recall rule, so D2 should not be relaxed.

---

## 5. Licence audit (own measurements, single-pass)

Classifier: first matching root file among LICENSE, LICENSE.md, LICENSE.txt, LICENCE[.md|.txt], COPYING[.md|.txt], LICENSE.rst, LICENSE.TXT, License.md and similar names, at the PR's **base** commit. Then keywords in order: AGPL, LGPL/Library GPL, GPL, SSPL, BUSL, FSL, Elastic, MPL, EPL, CC, Apache 2.0, MIT ("Permission is hereby granted, free of charge"), BSD ("Redistribution and use in source and binary forms"), ISC, Unlicense. **Known misreads:** GPL-2.0 text that mentions the Library GPL reads as LGPL (pylint), and BSD files that bundle MIT notices read as MIT (Sphinx, SymPy). Both are corrected by hand below. It sees the root file only: no per-path licences, no dual licensing, no NOTICE semantics.

1. **ReviewBench** (`review-bench/ReviewBench` at `f223ce3`, `corpus/manifest.json`, 219 PRs, 187 repositories, 215 unique base commits):
   - **195 of 219 PRs (166 repositories) have an MIT root licence at the base commit.**
   - 23 PRs (17 repositories) have **no licence file** at any of about 35 standard paths. That defaults to all rights reserved, so they are not D8-clean.
   - 1 PR has an AGPL-3.0 root licence at base. That PR's own golden finding is about relicensing from GPL to MIT.
   - The large-repository slice: **32 of the 36 PRs from repositories over 100 MB are MIT, and all 14 over 500 MB are MIT.**
   - (Inference) Such a uniform MIT share suggests ReviewBench sampled MIT-licensed repositories on purpose, but its docs do not say so.
   - **This answers round two's open item at the root-file level.** It unblocks the gated ReviewBench scripts only after VS-22's per-path check and the owner's ruling (Q27, and Q10 for the analogue).
2. **SWR-Bench** (12 repositories, checked at each repository's earliest and latest PR base commits):
   - BSD-3: astropy (earliest base; the latest base has no root file, so recheck), django, flask, scikit-learn, seaborn, sympy (BSD with bundled MIT notices).
   - BSD-2: sphinx.
   - MIT: pytest.
   - Apache-2.0: xarray, and requests at its latest base (ISC at its earliest base; 7 PRs predate 2013).
   - **GPL-2.0: pylint** (50 PRs).
   - **Matplotlib's own PSF-style licence agreement** (`LICENSE/LICENSE`; 153 PRs), which is not on D8's list.
   - Permissive subset: 797 PRs.
3. **AACR-Bench lvgl** (4 positive PRs: #7602, #8129, #8164, #8689): `LICENCE.txt` reads "MIT licence" at **both the source and target commits of all four**. **This closes round two's lvgl item.** lvgl bundles third-party code under `src/libs`, so the per-PR path check still applies. AACR's PRs date from 2024 (24) and 2025 (172).
4. **CRBugBench** (`e8e585e`): **no LICENSE file, and the README states no licence.** It draws on 98 repositories. *Corrects* addendum §3 VS-22 "PR size", which relies on CRBugBench's fix track for the large-PR end. Its diff statistics (numstat only, no code) fall under the same kind of exception as Q26. Its tasks may not be used without the authors' licence.
5. **ContextCRBench:** no LICENSE file; data on Google Drive; whole files from repositories under non-permissive licences. Not usable.
6. **SEVRA-Bench:** dataset card MIT (gated); harness repository with no LICENSE; CVE-fix code under its original licences. Use the method only.
7. **SWE-PRBench:** harness MIT; dataset CC BY 4.0 (README); source repositories unchecked.
8. **SWE-CARE:** code Apache-2.0; data licence unread.
9. **Archer:** `LICENSE` is MIT (`cuhk-s3/Archer` at `05b2fcf`). Its LLVM regressions come from a project licensed Apache-2.0 with the LLVM exception; whether that is D8-clean is the owner's call.

---

## 6. Contamination: evidence and how much each set is exposed

- **OpenAI, "Why we no longer evaluate SWE-bench Verified"** (2026-02-23): the set "is increasingly contaminated". OpenAI "has stopped reporting Verified scores and recommends reporting results for SWE-bench Pro". Press coverage adds that "models scoring above 70% on Verified score around 23% on SWE-bench Pro's public split", a gap it puts down to contamination and scaffolding together (vendor plus press). **SWR-Bench and CR-Bench reuse SWE-bench's 12 repositories**, with SWR-Bench PRs from 2011 to 2025.
- **Exposure by PR date** (my counts; inference about training cutoffs):
  - SWR-Bench: 79 of 797 permissive PRs date from 2024 or later.
  - AACR: all 196 positives date from 2024–2025.
  - ReviewBench repositories include 2026 course projects (for example an AY2025/26 semester-two repository), so part of it probably postdates many models' cutoffs (inference; the manifest has no dates).
  - Martian's 50 PRs are public and older.
  - **Only VectorScope's own sealed held-out cases (I-13) and post-cutoff PRs are clean.**
- CodeReviewQA's multiple-choice reformulation and SEVRA's patch reversal are designed to resist contamination: the answer is not the public PR's own comment.

---

## 7. What a credible VectorScope evaluation must look like

Synthesis (inference), each point tied to the evidence above. Points already in the contract are marked "(have)".

1. **Labels: human-settled, with a verdict for real defects the labels lack.**
   - Rubric v1's `match` / `extra` / `false-alarm`, with human settlement (have), is stronger than any public benchmark here.
   - CR-Bench's one-label precision (3.56%) and SWE-PRBench's PLAUSIBLE class show what happens without it.
   - Keep model judges unable to settle anything (have). CRJudgeBench finds that frontier models struggle to spot plausible but invalid comments.
2. **Precision and recall reported separately, with intervals, per judge and per operating point.**
   - Never one F number, and never F1 and F2 mixed (have, round two).
   - Show the five-class recall and the all-class recall side by side, so a precision-first design cannot hide a recall collapse. The CR-Bench usefulness–KDDR split is the cautionary case.
3. **Controls of three kinds, reported separately:**
   - behaviour-preserving controls for D2 (have);
   - trivial controls (have);
   - **"unflagged real PRs"** (new): merged PRs on which no human reviewer confirmed an issue, for example SWR-Bench's permissive clean PRs. Report false alarms per unflagged PR as an upper bound that includes undiscovered real bugs. Do not count it toward D2.
4. **More than one external set, never one leaderboard.**
   - Martian's 2026-03-19 dedup change moved tools by up to 27 ranks (round two).
   - Each external set has a different ground-truth bias: human reviewer comments (SWR, SWE-PRBench), LLM goldens (ReviewBench, AACR), one planted defect (CR-Bench).
   - Report each set on its own, and stratify by golden producer (have, ReviewBench).
5. **Contamination stratification.** Tag every external case with its PR date, and report results before and after the evaluated model's published training cutoff. Repeat the contamination caveat in every report (have).
6. **Context ablations per model.** SWE-PRBench shows monotone harm; AACR, ContextCRBench and the Haiku/Sonnet split show the effect varies. VS-25's gate (+10 points at equal or fewer tokens) and the RR12 PR-text ablation (have) must be repeated for each D6 model, not inherited.
7. **Adversarial narrative invariance** (new; SEVRA, PRWeaver). The same diff under neutral and adversarial PR text must give the same findings and verdict. This is a direct test of I-2.
8. **Multi-round state** (MCR-Bench). Re-raising resolved defects is a false-positive source. VS-41's commit sequences and VS-35's state handling should be scored for it.
9. **Field outcomes: within-population only.**
   - Addressed rate, with its exact definition, plus cycle time and human-comment volume.
   - Compared only against VectorScope's own baseline on the same repositories (I-13 outcomes on owner repositories).
   - Never against a vendor addressed rate or a study from another population (§4).
10. **Statistical honesty.** The power arithmetic in §6.2 stands (have). External sets can raise the defect count toward the 150–300 held-out defects that D2 needs, but only if their labels are re-settled under rubric v1, because their goldens are not ours.

---

## 8. Proposals (all off by default, eval-only, zero customer data, no new outbound route)

- **P1. Add a licence manifest for ReviewBench and SWR-Bench under VS-22** (code-only, zero spend, Phase A).
  - Store `{repo, commit, SPDX, licence path, classifier version}` per PR.
  - Fix the GPL/LGPL ordering bug before relying on it.
  - Add a per-path pass for bundled directories.
  - This round's single-pass result is the seed: ReviewBench 195 MIT, 23 none, 1 AGPL; SWR-Bench 797 permissive.
  - Owner question: may matplotlib's PSF-style licence, ISC and CC BY (SWE-PRBench labels) count as D8-permissive?
- **P2. SWR-Bench's permissive clean PRs as a separate "unflagged" stratum** (VS-21/VS-22 report field; dry-run counts now, paid runs only in a funded ablation).
  - Manifests and SHAs only (D8).
  - Strip commit author names and emails at import.
  - Report false alarms per unflagged PR; never feed D2's control count.
  - Score only F-class changes as defects, mapping them onto the five classes. E-class changes are out of scope (they are not defects).
- **P3. Narrative-invariance fixtures** (VS-22 adversarial cases; deterministic I-2 test now, paid comparison later).
  - Build 10–20 cases in the owner's D8-clean repositories by reversing a real security fix, SEVRA's method, with no SEVRA data copied.
  - Give each case a neutral PR body and 3–5 framings: prior approval, false coverage, misleading hardening, an AI-agent-authored claim, evidence dilution.
  - Now: a recording test that no framing text reaches any invocation field.
  - Later, in a funded ablation: findings and verdict must not differ between framings; report the paired difference.
- **P4. A PR-date field and contamination strata in the external manifests** (VS-22 schema field, VS-21 report column). Zero spend.
- **P5. Re-settle external goldens under rubric v1 before any of them count toward D2's held-out defects** (VS-22). External labels are evidence for the annotators, never ground truth. This keeps I-13's "labels never reach tools" and D8's two-pass rule.
- **P6. A per-model context-depth ablation in the Q9 ablation budget** (VS-25). Run diff-only, slice and slice-plus-PR-text on each D6 candidate model; SWE-PRBench predicts monotone harm for some models. No default changes.
- **P7. A smaller-model recall lens in the funded ablation only** (VS-28 and VS-29).
  - Two sources agree that Haiku-class models gain recall at a precision cost.
  - Test a Haiku-class single-class lens feeding the existing verifier against the D6 default, on the same route.
  - Under `zdr`, only if that model has an attested ZDR route (I-3); otherwise the lens stays off.
- **P8. Report addressed rate with its definition and its population** (VS-46 outcomes; internal, owner repositories only). Pair it with cycle time and human-comment volume, as RovoDev and Beko show. Forbid comparison with vendor or cross-population rates in report text (D12).
- **P9. Correct the addendum's CRBugBench reliance** (VS-22 "PR size"). The repository has no licence. Use its numstat only under a Q26-style ruling. For the large-PR end, use the ReviewBench MIT PRs (median 562 lines, round two) or the owner's own repositories.

---

## 9. Open questions

1. May matplotlib's licence agreement, ISC, and CC BY 4.0 count as D8-permissive (extends Q31)?
2. Does ReviewBench's documentation state an MIT-only sampling rule? The root-file check suggests one, but per-path licences and the 17 unlicensed repositories still need a ruling.
3. Are CR-Bench's data, SWE-CARE's data, CodeReviewQA's and CRJudgeBench's Hugging Face licences, and the SWR-Bench and SWE-PRBench paper tables readable once arxiv.org and huggingface.co are allowed?
4. Is MCR-Bench's "one third of false positives re-raise resolved defects" in the paper, or only in the secondary blog?
5. Martian's live online board on 2026-11-07 (Greptile 2nd on 2026-10-06 per press). Is the NeurIPS 2026 poster "Code Review Bench: An Automated Benchmark for Evaluating the Software Factory" Martian's paper, and does it report judge–human agreement?
6. Does any independent study measure Greptile's shipped v5 or its TREX mode? None found.
7. Does the Human-AI Synergy dataset (`Suzhen/AgentReviewChat`) carry a licence that would allow its AI-comment adoption labels to calibrate VS-35?

---

## 10. Sources (all accessed 2026-11-07)

**Repositories and data read (code):**
- https://github.com/ZZR0/SWRench at `67ae1d4` (2026-06-05): README, `data/swr_datasets_d5c5.jsonl`, `swrbench/collect_pr_review.py`
- https://github.com/kinesiatricssxilm14/ContextCRBench at `ade378c` (2026-02-27): README
- https://github.com/codefuse-ai/SWE-CARE at `d0b419c` (2026-04-21): README, LICENSE
- https://github.com/FoundryHQ-AI/swe-prbench at `379f0bf` (2026-03-30): README, RUBRIC.md
- https://github.com/rufimelo99/malicious-pr-bench at `1d5cf2b` (2026-10-21): README, README_hf.md
- https://github.com/malusamayo/CRBugBench at `e8e585e` (2026-10-07): top-level tree, README
- https://github.com/cuhk-s3/Archer at `05b2fcf` (2026-10-02): LICENSE
- https://github.com/alibaba/aacr-bench at `ee9d7fe` (2026-10-15): `dataset/positive_samples.json`; lvgl `LICENCE.txt` at the 8 PR commits via raw.githubusercontent.com
- https://github.com/review-bench/ReviewBench at `f223ce3` (2026-11-05): `corpus/manifest.json`; licence files at 215 base commits via raw.githubusercontent.com
- https://github.com/MattFlower/agentic-dev-research/pull/8 (opened 2026-11-04, merged 2026-11-06): CR-Bench-v2 summary (secondary)

**Papers (search extracts only; arXiv unreachable):**
- SWR-Bench, arXiv 2509.01494 (v1 2025-09-01; FSE 2026, DOI 10.1145/3808144)
- CR-Bench, arXiv 2603.11078 (2026-03); CR-Bench-v2, arXiv 2611.02566 (2026-11-02)
- SWE-PRBench, arXiv 2603.26130 (2026-03-27)
- ContextCRBench, arXiv 2511.07017 (2025-11-10)
- CodeFuse-CR-Bench, arXiv 2509.14856 (2025-09)
- MCR-Bench, arXiv 2608.27442 (2026-08; ISSTA 2026); one secondary blog post (2026-09-01), whose host is withheld under the naming rule because it names an open-source coding-agent CLI
- CodeReviewQA, arXiv 2503.16167 (2025-03)
- CRJudgeBench, arXiv 2609.37216 (2026-09)
- SEVRA-Bench, arXiv 2606.13757 (2026-06-11)
- PRWeaver, arXiv 2608.02693 (2026-08)
- Sphinx, arXiv 2601.04252 (2026-01-06)
- Code review benchmark survey, arXiv 2602.13377 (2026-02-13)
- "Bigger Isn't Always Better", arXiv 2606.15689 (June 2026 ID; one extract gives 2026-04-09)
- RovoDev, arXiv 2601.01129 (2026-01; ICSE SEIP 2026)
- Sun et al., arXiv 2508.18771 (v1 2025-08-26; v2 2026-04-25)
- Human-AI Synergy, arXiv 2603.15911 (2026-03)
- Footprints, arXiv 2604.24450 (2026-04; MSR 2026)
- AI-to-AI Code Review, ESEM 2026, https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.75 (2026)

**Other:**
- https://aimultiple.com/ai-code-review-tools (last updated 2026-03-13; extract)
- https://helpnetsecurity.com/2026/10/06/github-reviewbench-ai-code-review-benchmark (2026-10-06; extract)
- https://thenewstack.io/github-reviewbench-code-review/ (~2026-10; extract)
- https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ (2026-02-23; extract)
- https://deepsource.com/blog/ai-code-review-benchmarks (2026, undated; extract)
