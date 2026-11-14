# Round two, risk angle: predicting future bugs, and turning risk into action

## 0. How this round worked, and its limits

- **Web search was not available.** The turn's shared budget of 200 WebSearch calls was already used up when this lane started, so no search ran at all. Direct fetches of `arxiv.org` and `engineering.fb.com` failed DNS under the session's network policy. Following the tool's guidance, I then stopped trying new web hosts.
- **What I could reach was public GitHub over git.** I made shallow, read-only clones into the scratchpad and ran nothing from them. That gave **code** evidence from:
  - Mozilla's production defect-risk system (`mozilla/bugbug`);
  - Qodo's PR-Agent;
  - CodeScene's MCP server and agent skills;
  - LinearB's gitStream;
  - the bugspots implementation of Google's 2011 bug-prediction heuristic;
  - PySZZ v2;
  - the ApacheJIT dataset (MSR 2022).
- **I ran my own experiment.** I used the public ApacheJIT dataset: 106,674 labelled commits from 15 Apache projects, 2003–2019. For four of those projects I made treeless clones of their full history, so I could compute VectorScope's exact VS-28 history features. The scripts are pure numpy with no paid APIs, in `<session scratchpad>/scripts/` (`jit.py`, `jit2.py`, `jit3.py`, `hist.py`, `hist2.py`, `hist_eval.py`, `hist_eval2.py`, `pts.py`).
  - Labelled **independent (own measurement)**.
  - It is not peer reviewed. It covers Java/Scala Apache projects, per commit, with SZZ-derived labels. Treat it as directional evidence for VS-28's design, not as a benchmark claim (I-13/D12: internal only).
- **Literature is recalled.** The papers I could not open this round are labelled **academic (recalled, not opened)**, with their canonical identifiers. Where I am unsure of an identifier, I say so.

## 1. Bottom line for VS-28

1. **Round one's verdict holds, and the evidence is now stronger.** "Risk sets review depth and is never posted as a prediction" is confirmed. The strongest new support is code from a real deployment: Mozilla's `regressor` model.
   - Its stated purpose is "to detect patches which are more likely to cause regressions. It could be used to make riskier patches undergo more scrutiny" (`README.md`, bugbug @7e8a342, 2026-11-05).
   - Its output is a **band defined relative to the project's own base rate**, not a "this will break" claim.
   - Across the tools I could read, risk drives scrutiny, test selection and approvals, never a forecast to the author:
     - PR-Agent keeps its LLM risk fields opt-in and default-off. It says its failure scenarios "guide review and do not decide whether merging is safe".
     - gitStream uses size and review-time rules to require a second approval.
     - CodeScene's own agent skill puts the change set first and uses hotspots only as background.
2. **Refinement 1: history features barely matter. Make `riskOf` diff-first and put history in the explanation.** On ApacheJIT with a time-aware split (train ≤2016, test 2017–2019):
   - diff-only features (lines added and deleted, files, directories, entropy) reach AUC 0.809;
   - adding history (unique prior changes, file age, developer count) adds about +0.01;
   - developer experience adds nothing;
   - on four repositories, VS-28's exact fix-density feature (90-day count of `fix|bug|revert|hotfix` commits on the touched files) adds **0.000**. AUC went from 0.799 to 0.798.
   - The "last 5 commits per file" variant the current history gatherer could support adds +0.002. Google's decayed hotspot score is slightly negative.

   So VS-28's worry that "history is often missing in CI" is mostly moot. A diff-only band and a diff+churn band agreed on 86% of commits and never differed by more than one band.
3. **Refinement 2: the strongest non-size signal is "this change is itself a bug fix", and VectorScope cannot use it under I-2 as written.**
   - Fix commits were labelled buggy 64% of the time, against 19% for other commits, and the feature adds +0.05 AUC.
   - In VectorScope that fact comes only from untrusted text (PR title, branch name, commit messages), and I-2 forbids untrusted text from choosing depth.
   - A raise-only use (it can only add depth, never remove it) is a candidate exception, but it needs an owner decision.
4. **Refinement 3: risk-scaled depth is mostly size-scaled depth, so price it that way.**
   - The diff-only "high" band (the top 10–14% of changes) holds **55–68% of all changed lines**.
   - Running lenses at Kodus's reported 1.3–2.1× tokens on that band would raise total review spend by roughly **+17% to +75%**. That is the number VS-28's Phase A cost gate should test.
5. **Refinement 4: keep likelihood and impact on separate axes.**
   - Sensitive paths (auth, crypto, tokens) showed no likelihood lift (AUC 0.52).
   - Changes that touch tests were labelled buggy **more** often within each size bucket, not less.
   - So `sensitive` should stay an impact escalation: it brings in the security pass, as today. `testDelta` should not lower risk.
   - PR-Agent's new deterministic "structural reach" rating separates reach and sensitivity from size and from the model's judgement in the same way.
6. **Labels from SZZ (the standard way of tracing a bug back to the commit that introduced it) build in a "small and deletion-only means safe" bias.** In ApacheJIT:
   - commits that add no lines are **never** labelled buggy (0.000 of 4% of commits), because SZZ can only blame added lines;
   - one 11,964-commit project (apache/hadoop) has **zero** buggy labels;
   - per-project base rates range from 13.6% to 76%.

   `riskOf` therefore needs a floor for deletion-heavy changes, for example removed guards. Bands should be calibrated per repository as percentiles, and should never be shown as a probability.

## 2. Industrial deployments: what was verified this round

### 2.1 Mozilla bugbug `regressor`: the most complete open production system (code, strong)

Source: `bugbug/models/regressor.py`, `docs/models/regressor.md` and `http_service/bugbug_http/models.py` at https://github.com/mozilla/bugbug, commit 7e8a342, 2026-11-05.

- **Model.** XGBoost with random undersampling and `IsotonicRegressionCalibrator`, so it outputs calibrated probabilities. The features:
  - source, test and other file sizes, and lines added and deleted for each;
  - author experience and recent experience, author backouts and seniority;
  - reviewer experience and backouts, and number of reviewers;
  - how often the component, directory and file were touched before;
  - files, components and directories, and counts of each;
  - number and size of functions touched;
  - average cyclomatic and Halstead metrics.

  The commit description is used **only** when `interpretable=False`. The default is interpretable, with no free-text features, which matches the spirit of VectorScope's I-2.
- **Labels.** By default (`exclude_finder=True`) the positives come from Bugzilla's developer-filled "Regressed by" field, not from SZZ. SZZ-found regressors are *excluded* from the clean set rather than added as positives, and the code comments that SZZ "isn't remotely as precise as the 'Regressed By' data". `scripts/regressor_finder.py` measures how many known regressors SZZ recovers. Commits that were backed out are dropped, and so are automated test-sync commits.
- **How it handles time.**
  - Training negatives come only from the last two years, because "using too old patches might cause worse results as patch characteristics evolve over time".
  - The newest three months are excluded "as there could be regressions which haven't been filed yet". This is a label-maturity gap.
  - Evaluation uses a separate three-month holdout (`EVALUATION_MONTHS = 3`).
- **Bands, relative to the base rate.** The evaluation code comments that on average about 1 in 8 patches (13%) causes a regression. The bands are set so that:
  - band 1 is about half the average (about 7%);
  - band 2 is about the average (about 15%);
  - band 3 is about double (about 35%);
  - each band needs a minimum sample of 200.

  The production cutpoints come from a secret (`REGRESSOR_RISK_BANDS`), and `find_risk_band` maps a score to a named band. The bands feed `generate_landings_risk_report.py`, a per-bug landing risk report that also records time to regression and fuzzing status. That is a release-management view, not a comment to the author.
- **Action layer: test selection.** Risk turns into spend, explicitly:
  - config selection "weighs groups by their probability of regressing", and adds a config only when the "risk-weighted gain in the probability of catching a group's regression per unit of cost" exceeds `CONFIG_SELECTION_THRESHOLD = 0.00015`;
  - manifests that contain modified tests are forced to risk 1.0;
  - recently failing (backout) groups run on all configs.

  These are deterministic overrides layered over the learned risk.
- **What this means for VectorScope:**
  - define bands relative to the repository's base rate or percentiles, not as absolute scores;
  - turn a band into budget through an explicit cost-gain rule;
  - keep deterministic overrides (sensitive path means the security pass);
  - keep free text out of the default model;
  - when VectorScope ever trains, use developer-informed labels such as reverts and linked "fixes" issues over raw SZZ, and keep a label-maturity gap.

### 2.2 Google's bug-prediction heuristic (code for the algorithm; academic recalled for the outcome)

- **Algorithm.** The bugspots README (https://github.com/igrigorik/bugspots, cf57488, 2018-08-23) implements Google's heuristic from "Bug Prediction at Google" (http://google-engtools.blogspot.com/2011/12/bug-prediction-at-google.html, Dec 2011; the link appears in the code, but I did not open the page):
  - commits are matched by `\b(fix(es|ed)?|close(s|d)?)\b`;
  - each file's score is Σ 1/(1+e^(−12t+12)), where t ∈ [0,1] normalises a fix's time between the oldest fix and now;
  - the code comment says the score "changes over time with this algorithm due to the moving normalization; it's not meant to provide some objective score, only provide a means of comparison between one file and another at any one point in time".
- **Outcome.** Lewis et al., "Does Bug Prediction Support Human Developers? Findings from a Google Case Study", ICSE 2013 (academic, recalled, not opened): showing these scores in review produced no measurable behaviour change.
- **My measurement.** I computed this decay score over one year of fixes for the touched files. It reached AUC 0.630 alone, and adding it to the diff features *lowered* AUC slightly (0.799 to 0.796).
- **What this means for VectorScope:** a file hotspot score is a moving, within-repository comparison and is not a probability. It belongs in an explanation ("these files were fixed 4 times in 90 days"), not in band arithmetic.

### 2.3 Meta Diff Risk Score (round one claim; still unverified)

- I could not reach `engineering.fb.com` or `arxiv.org` (2410.06351).
- From memory (weak): a fine-tuned in-house code LLM predicts diffs that cause incidents (SEVs). It is used to gate or allow diffs during code freezes and to drive risk-aware tooling, not shown as a forecast to authors.
- The exact capture rates and the "diffs landed during freeze" figures remain unverified. Round one's framing (gating and allocating scrutiny) is consistent with everything verified this round.

### 2.4 Other industrial work (academic, recalled, not opened)

**Turning risk into testing:**
- **Facebook Predictive Test Selection** (Machalica et al., ICSE-SEIP 2019; arXiv 1810.05286). Recalled: it halved test infrastructure cost while catching over 95% of individual test failures and over 99.9% of faulty changes. This is the best-evidenced risk-to-action pattern: risk decides *what to run*, and the safety net is measured on failures caught.
- **Microsoft CRANE** (Czerwonka et al., ICST 2011, Windows): failure prediction and change analysis, used to prioritise testing of Windows updates. It is an early example of risk feeding test effort rather than developer warnings.
- **Microsoft Nudge** (Maddila et al., FSE 2022). It predicts PR completion time and nudges overdue PRs. Recalled: it was deployed widely and roughly halved completion time on treated PRs. Exact figures unverified. It turns a prediction into a low-friction action without claiming defects.
- **Mozilla test selection.** The Hacks post "Testing Firefox more efficiently with machine learning" (https://hacks.mozilla.org/2020/07/testing-firefox-more-efficiently-with-machine-learning/, July 2020; the link is in the bugbug README, but I did not open the post) describes the system whose code I read in §2.1.

**Early change-risk systems:**
- **Avaya / Bell Labs**: Mockus & Weiss, "Predicting risk of software changes", Bell Labs Technical Journal 2000. The first change-level risk model, used to flag risky modification requests for extra inspection.
- **BlackBerry (RIM)**: Shihab et al., "An industrial study on the risk of software changes", FSE 2012. Developer-perceived risk correlated with lines added, the number of linked bugs and developer experience.
- **Ubisoft CLEVER** (Nayrolles & Hamou-Lhadj, MSR 2018). Commit-time risk combined with clone matching against past fixes, so a risky commit comes with a *suggested fix*. Recalled: about 79% precision and 65% recall.
  - The lesson is that risk was paired with a concrete remedy, which is the opposite of a bare hotspot list.

## 3. Turning risk into action without false alarms

What the verified and recalled evidence supports, ordered by strength:

1. **Spend more compute or tests on risky changes; never message the author about the risk** (Mozilla code, Facebook PTS, CRANE, Meta DRS). A false "high" costs tokens or CI minutes. A false "low" costs a missed bug. The asymmetry favours generous escalation with a hard budget cap, which VS-24 already has.
2. **Use deterministic overrides as a floor:**
   - Mozilla forces modified tests to run;
   - PR-Agent's structural reach gives a "sensitive domain" at least High, whatever the size;
   - VectorScope already brings in security on sensitive paths.

   Overrides should never *lower* depth.
3. **Extra reviewers through repository-owned rules** (gitStream code, https://github.com/linear-b/gitstream @5cd1030, 2026-08-30): `set-required-approvals: 2` when `estimatedReviewTime >= 30`, `files >= 10` and some `src/` change. The review-time estimate is an ML model "based on the PR metadata ... and mainly by the number of additions and deletions for each type of change".
   - VectorScope must not change approvals itself (I-14: no new GitHub App permissions).
   - It could emit `band` in `vector review --json` so a repository's own rule engine can act on it. Exposing it is a D14/I-14 decision.
4. **Review participation is causally plausible** (academic, recalled):
   - McIntosh et al. (MSR 2014; EMSE 2016) found that components with low review coverage and participation had more post-release defects;
   - Thongtanunam et al. (MSR 2015) found that files which later had defects had received less intense review;
   - Kononenko et al. (ICSME 2015, Mozilla) found that reviewer experience and workload affect whether reviewed patches stay bug-free.

   This supports "more review depth where risk is higher", which is VS-28's premise.
5. **Choose an effort-aware ranking deliberately.** In my measurement:
   - ranking by raw risk caught only **17%** of buggy commits within 20% of changed lines, below random (20%), because it front-loads big changes;
   - ranking by risk density (risk divided by lines) caught **58%**;
   - "smallest first" (the LApredict effort variant) caught **46%**.

   Huang, Xia & Lo (ICSME 2017 / EMSE 2019, recalled) warn that density-style rankings make reviewers inspect many more changes, which means more context switches.
   - VectorScope's lens cost is roughly per PR: at most 5 steps and 4 findings each, though the diff is in context. So **raw risk is the right ranking for "run lenses or not"**.
   - **Density is the right ranking for "which files inside a large PR get the deepest look"**, which is how VS-19 batches.
6. **Do not post risk as a prediction** (Google 2013, recalled). PR-Agent's opt-in `risk_level` is defined by found issues ("Use high only when the PR introduces a clear bug ..."), not by prediction, which matches VectorScope's existing `computeRisk` in `select.ts:122-141`.

## 4. Review tools that claim to predict future bugs

- **PR-Agent / Qodo** (code, https://github.com/qodo-ai/pr-agent @6de02f5, 2026-11-05; `pr_agent/settings/pr_reviewer_prompts.toml`, `configuration.toml:183-185`, `docs/docs/tools/review.md`):
  - `require_risk_assessment`, `require_merge_recommendation` and `require_failure_modes` all default to `false`;
  - `failure_modes` asks for at most three scenarios "grounded in the visible changes, not generic risks ... These scenarios guide review and do not decide whether merging is safe", each with `trigger`, `detected_by` and `covered_in_this_pr`;
  - a new deterministic **structural reach** row is computed from a build-graph file, "not by the model, so the same input always gets the same rating":
    - reach is narrow up to 3 projects, moderate up to 25 and wide above that;
    - wide reach or a cross-domain change gives at least Moderate;
    - a sensitive domain gives at least High;
    - sensitive with wide reach gives Critical;
    - size is deliberately excluded "because `estimated_effort_to_review_[1-5]` already reflects it".

  This is the closest public design to VS-28. Its lessons are to separate a deterministic reach and sensitivity axis from size, and to keep model judgement opt-in. VectorScope's VS-25 `dependents` maps directly onto "reach". No evidence of accuracy is published (vendor or code only).
- **CodeScene** (vendor, via code: https://github.com/codescene-oss/codescene-mcp-server @319762b, 2026-11-05):
  - **Code Health method** (`src/docs/code-health/how-it-works.md`): 25+ factors, a 1.0–10.0 file score, with bands Red (1–3.9), Yellow (4–8.9), Green (9–9.9) and "Optimal" (10.0).
  - **Evidence claims** (`business-case.md`):
    - Red code "introduces 15 times more defects than Green", and Yellow four times more;
    - tasks in Green code finish more than twice as fast;
    - tasks in Red code take "up to nine times longer";
    - the source is the vendor-authored "Code Red" study (Tornhill & Borg, TechDebt 2022, arXiv 2203.04374; correlational).
  - **The "AI break rate" claim**: healthy code limits it. No study is linked in the files I read.
  - **How its own skill uses risk** (`skills/risk-based-testing-with-code-health/SKILL.md`): the change set first ("more immediately actionable than historical hotspots"), and hotspots as "background context only". The ranking is: health degraded or gate failed, then overlap with a hotspot, then healthy changed files. Risky areas are routed to owners.

  In other words, even the hotspot vendor puts the diff ahead of history. This supports §1, point 2.
- **Sentry Seer "bug prediction"** (vendor, recalled, unverified). Sentry marketed AI code review that uses production error context to predict which changes will cause errors. `getsentry/seer` could not be cloned anonymously on 2026-11-06, so it is private or renamed, and I verified no detail.
- **Greptile.** Round one found no future-bug feature, and this round had no access to greptile.com, so there is no change. Nothing seen this round shows any review tool with *independent* evidence that it predicts future bugs beyond findings in the current diff. **If VectorScope ever claims "predicts future bugs", that would be an unsupported claim (D12).**

## 5. SZZ and labels: what the data shows

- **PySZZ v2** (code, https://github.com/grosa1/pyszz_v2 @6797158, 2023-08-25) implements AG, L, R, MA, RA, PyDriller, A, DU and REV variants. It cites Rosa et al., "A comprehensive evaluation of SZZ Variants through a developer-informed oracle", JSS 202:111729, 2023 (doi 10.1016/j.jss.2023.111729; the ICSE 2021 version is arXiv 2102.03300). This extends round one's ICSE 2021 citation with the 2023 journal version and its variant list.
- **ApacheJIT construction** (code, https://github.com/hosseinkshvrz/apachejit @ddfd547, 2022-01-28). Issue-linked fixes, git annotate through PyDriller, then GumTree filters on "number of lines, number of files, language, and change significance". The released test split covers the last three years and is unbalanced "to represent a real-life scenario".
- **Artefacts I measured** (independent, own measurement):
  - commits with no added lines: 0.0% labelled buggy (4% of the test period), purely because of how the labels are built;
  - apache/hadoop: 0 positives among 11,964 commits;
  - per-project positive rates from 13.6% (camel) to 76.4% (hadoop-hdfs);
  - bug rate rises steadily with lines added: from about 4% for 1–4 lines to 70% for more than 1,000 lines. Part of that is genuine, but SZZ blames added lines, so larger changes have more chances to be blamed. This is the classic size confound.
- **What this means for VectorScope:**
  - lines added will dominate any SZZ-trained weights;
  - "deletion-only" will look safe even when it removes a null check or an auth guard;
  - so `riskOf` should give a deletion-heavy change at least a medium floor in a code file (deletions above 50 lines, or any deletion in a sensitive path), and ideally use VS-25 to detect a removed guard;
  - never train on, or claim calibration against, raw SZZ labels.

## 6. How well predictions transfer across projects

- **Literature** (academic, recalled):
  - Zimmermann et al. (FSE 2009): only 21 of 622 cross-project pairs (3.4%) worked;
  - Kamei et al. (EMSE 2016): cross-project JIT models are weaker unless the projects are similar or the models are ensembled;
  - McIntosh & Kamei (TSE 2018, "Are fix-inducing changes a moving target?"): the properties of fix-inducing changes drift, so models go stale.
- **My measurement:** leave-one-project-out logistic regression on diff+history features, scored on each project's 2017–2019 commits:
  - mean AUC 0.819 cross-project against 0.829 within-project, against 0.784 for lines added alone;
  - cross-project was within 0.05 of within-project for 11 of 12 projects;
  - the exception was hadoop-hdfs, which fell from 0.847 to 0.562. Its 76% base rate means labelling differs, not code.
  - A **fixed, untrained points score** reached mean per-project AUC 0.787 (range 0.728–0.843).
- **Takeaways:**
  - *ranking* transfers across a homogeneous ecosystem, but *calibration* (absolute probability) does not;
  - so ship fixed, documented weights for ranking, set band cutpoints per repository where history allows, and never show a number as a probability;
  - this agrees with Mozilla's relative bands and with bugspots' "only a means of comparison".

## 7. LLM-based JIT defect prediction, 2023–2026

- I could not open any 2023–2026 papers this round, because search and arxiv were blocked. Recalled and weak:
  - fine-tuned code models (for example the CodeBERT/CodeT5/CCT5 family and JIT-Fine/JIT-Smart-style semantic+expert hybrids) give modest gains over expert features on curated datasets;
  - zero-shot chat LLMs are reported to perform poorly at JIT-DP;
  - Meta's DRS is the main industrial case, using a fine-tuned in-house model trained on incident labels.
- Round one's LApredict result (lines added alone beats DeepJIT and CC2Vec; ISSTA 2021 artefact @5fbf45b, 2023-11-21) is reproduced in spirit: lines added alone reached AUC 0.805, against 0.862 for all 13 Kamei-style features.
- **What this means for VectorScope:**
  - do not spend a model call on `riskOf`, because it is pre-dispatch, should cost zero tokens, and must be deterministic;
  - and a model reading untrusted diff text would breach I-2 if it chose depth;
  - the model's own risk already can raise `Selection.risk` to medium (`select.ts:122-141`), which is the right place for model judgement.

## 8. Concrete, evidence-backed `riskOf` design

The weights come from the ApacheJIT lift tables and logistic coefficients. Measured on the 2017–2019 time-split test set (24,690 commits, 14 projects):

| Feature | Points | Measured lift vs project base (test) |
|---|---|---|
| `added` ≤10 / 11–50 / 51–200 / >200 | 0 / 1 / 2 / 3 | 0.14–0.34 / 0.52 / 0.77–1.07 / 1.56–2.42 |
| `deleted` >50 | +1 | standardised log coefficient 0.26, against 1.05 for added |
| `dirs` 1 / 2–3 / ≥4 | 0 / 1 / 2 | 0.34 / 0.70–0.99 / 1.70 |
| `entropy` ≥1 bit | +1 | <0.01: 0.22; ≥3: 1.71 |
| `files` | 0 (dropped) | coefficient about 0 once added and dirs are in |
| `churn` (prior changes to the touched files) 4–15 / ≥16, optional | +1 / +2 | about +0.01 AUC |
| `fixCommits` (VS-28's 90-day regex) | 0; explanation only | +0.000 AUC on 4 repos |
| `sensitive` | no points; separate impact axis that brings in security (as today) and forces at least medium | likelihood AUC 0.52 |
| `testDelta` | no points, and never a reduction | within each size bucket, changes that touch tests had more bugs |
| `dependents` (VS-25) | separate reach axis, in PR-Agent's style: narrow ≤3, moderate ≤25, wide >25 | not measured |

Measured results:

- **Diff-only points (0–7).** AUC 0.785.
  - Cutpoints low 0–3, medium 4–5, high 6–7 give shares of 57/22/20%, observed bug rates of 10/28/57%, 25/26/49% of the bugs, and 8/19/73% of changed lines.
  - Making high = 7 only gives a high band of 10% of changes at 69% observed bug rate.
- **Diff+churn points (0–9).** AUC 0.792.
  - Cutpoints low 0–4, medium 5–7, high 8–9 give shares of 54/31/14%, bug rates of 9/31/62%, and 8/40/52% of changed lines.
  - It agrees with the diff-only band on 86% of commits and never differs by more than one band. This supports "the same band across surfaces" with history used as a tie-breaker.

Rules:

- **Floors, which can only raise the band:**
  - sensitive path: at least medium;
  - deletion-heavy code change: at least medium;
  - wide reach: at least medium;
  - sensitive with wide reach: high.
- **Per-repository calibration, later.** Where history exists, replace the fixed cutpoints with the repository's own 50th and 90th percentiles of past PR scores (Mozilla-style relative bands). Repository-relative 50/90 cutpoints gave a 13% high band at 60% observed bug rate.
- **PR-level caveat.** These are per-commit thresholds. A PR bundles commits, so the size thresholds should be checked against VectorScope's eval PRs in Phase A before they are fixed.
- **Cost gate projection for Phase A.** The high band holds 52–73% of changed lines. With lenses at 1.3–2.1× tokens on high only, total spend rises by about 0.52×0.3 = +16% at the low end and 0.73×1.1 = +80% at the high end. The VS-28 measurable goal ("low band at or below baseline cost") is easy to meet. The real budget question is the high band.

## 9. Owner questions this raises (new)

- **QR1.** May a *raise-only* signal derived from untrusted text ("PR or commit says it fixes a bug": +0.05 AUC, the strongest non-size feature) adjust depth, as a narrow exception to I-2? Or should it stay out?
- **QR2.** Should `band` and `reasons` be exposed in `vector review --json`, so repositories can drive their own approval rules (gitStream-style), or kept internal (I-14)?
- **QR3.** Should VS-28 drop the 90-day fix-density *points* and keep the counts only as explanation text, given no measurable gain?
