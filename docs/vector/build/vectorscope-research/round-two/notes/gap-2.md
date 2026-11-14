# G2: does VS-28's diff-only risk band hold at PR level, and does extra depth on the high band pay off?

Lane date: 2026-11-06. Round two, gap "Predict future bugs is validated only at commit level".

## 0. What this lane could and could not do

- **Web access was almost entirely blocked for this lane.**
  - The turn's shared WebSearch budget (200 calls) was already used up before my first query, so I ran no new literature searches.
  - WebFetch failed at DNS for arxiv.org, ar5iv.labs.arxiv.org, api.semanticscholar.org and hacks.mozilla.org, and was refused for web.archive.org.
  - The egress proxy returned 403 for github.com HTTP pages, api.github.com, patch-diff.githubusercontent.com, huggingface.co and community-tc.services.mozilla.com.
  - Following the tool's instruction, I stopped trying further hosts after these failures. greptile.com was therefore not tried.
- **Git over HTTPS to GitHub did work.** So the offline analysis (task part 1) and the bugbug reading (part 2) were done from source code and public git objects.
- **Parts 3 and 4 are unchanged from round one.**
  - Part 3 (the full text of DRS and RADAR) is unreachable.
  - Part 4 (any measured effect of Greptile's knowledge base or risk areas) is unreachable.
  - For both, I report only what earlier lanes' search extracts already said, and I label it that way.
- **No model was called.**
  - Every number in sections 1 to 4 comes from this lane's own computation on public datasets and existing tool outputs.
  - I label those numbers **independent**: the outputs and labels are third-party, and the measurement is mine.

Scripts and intermediate data (scratchpad, not the worktree):
- `<session scratchpad>/g2/bin/numstat.sh` and `aacr2.sh`: blobless or treeless git fetch of base and head, then `git diff --numstat`.
- `.../g2/bin/feat.py`: features and band. `mart.py`: recall by band. `depth.py`: deep vs shallow tool variants. `gold.py`: ReviewBench. `aacr.py`: AACR-Bench. `stats.py`: Spearman with a permutation p-value.
- `.../g2/features.json`: per-PR la, ld, nf, nd, entropy, points and band.

## 1. Method

### 1.1 The band under test

I used the same "diff-only points" operationalisation of VS-28 that round two used on ApacheJIT (RP12; `scratchpad/rpverify/pp.py`):

- **Points:**
  - lines added: ≤10 → 0, ≤50 → 1, ≤200 → 2, more → 3;
  - plus 1 if deleted > 50;
  - directories touched: ≤1 → 0, ≤3 → 1, more → 2;
  - plus 1 if change entropy ≥ 1 bit.
- **Bands:** low 0-3, medium 4-5, high 6-7. On ApacheJIT commits, RP12 reported shares of 57/22/20%.
- **Features:**
  - Entropy is Shannon entropy (log2) of each file's share of changed lines.
  - nd is the count of distinct parent directories.
  - Binary files count 0 lines.
- **Variants:**
  - `raw` uses every file.
  - `filt` drops lockfiles, minified, vendored, snapshot and image files. Results were the same to two decimals, so only `raw` is reported.
  - A `+sensitive` variant used a broad path regex. It is not VectorScope's `isSensitivePath`, which I did not read, so I mention it only once.

### 1.2 Data

| Set | Source | PRs analysed | Diff source | Outcome available |
|---|---|---|---|---|
| Martian offline benchmark | github.com/withmartian/code-review-benchmark at e616e84 (2026-08-30) | 48 of 50 | `refs/pull/1/merge` on the code-review-benchmark replay forks, `merge^1..merge`. Two sentry-greptile PRs had no merge ref and are dropped | golden comments with severity, plus per-tool tp/fp/fn from `evaluations.json` for 49 tools and 3 LLM judges |
| ReviewBench | github.com/review-bench/ReviewBench at f223ce3 (2026-11-05) | 219 of 219 | base and head SHAs from `corpus/manifest.json`, fetched from the review-bench mirrors. My la/ld match the manifest exactly on 152/219 and closely on the rest | golden findings with tp/fp, severity and scope. No per-tool outputs |
| AACR-Bench | github.com/alibaba/aacr-bench at ee9d7fe (2026-10-15) | 185 of 196 positives. Permissive subset per VOI13: 131 of 140 | `target_commit` is the PR head and `source_commit` the base-branch tip. I diffed merge-base(target, source)..target. Total changed lines are within 10% of the dataset's `change_line_count` for 97/185, median ratio 0.97. 11 SHAs were "not our ref" | golden comments with category; 61-84% are AI-originated and then human-validated |

**Caveat that applies to everything below:** none of these "golden" sets is a post-merge defect label.
- Golden findings are issues that reviewers (human and LLM) could find in the diff.
  - ReviewBench builds its golden set from findings by several LLM reviewers, a code-review agent, human review threads and semgrep, then labels and dedups them (`docs/METHODOLOGY.md` §4, §5.4-5.5).
  - AACR's golden comments are 61-84% LLM-originated.
- So "golden count" measures **reviewable issues**, not "future bugs". It also scales with diff size by construction, because more code gives more places for a reviewer to comment.
- This is the strongest available PR-level proxy, but it is not the label the owner's "predict future bugs" ask implies.

## 2. Does the band predict where the bugs are? (part 1a)

### 2.1 Band distribution: the commit cutpoints do not transfer to PRs

| Set | low (PRs / lines) | medium | high | Median PR size (la+ld) |
|---|---|---|---|---|
| ApacheJIT commits (RP12) | 57% / – | 22% / – | 20% / – | – |
| Martian | 10% / 1% | 33% / 13% | **56% / 86%** | 292 |
| ReviewBench | 16% / 0% | 28% / 4% | **56% / 96%** | 562 |
| AACR permissive | 47% / 14% | 32% / 37% | 21% / 49% | 152 (all) |

Two things follow:
- **The high band is the majority on two of three PR sets.** With commit-calibrated cutpoints, VS-28's `lenses: high` would fire on more than half of PRs and cover 86-96% of changed lines on Martian and ReviewBench.
- **This extends RP5.** RP5 found the high band holds 55-68% of changed lines at commit level. At PR level it is worse, and the high band becomes "almost everything that costs money".

### 2.2 Golden findings per PR by band

**Martian, 48 PRs, golden bugs:**

| Band | n | Golden/PR | Median size | Golden per kLOC |
|---|---|---|---|---|
| low | 5 | 2.20 | 44 | 46.6 |
| medium | 16 | 2.69 | 160 | 14.8 |
| high | 27 | 4.15 | 576 | 6.0 |

Correlation with golden count:
- Points: Spearman ρ = 0.51 (p < 0.001).
- Raw size: ρ = 0.46.
- Within size terciles (n = 16 each), points: ρ = 0.27 / 0.35 / 0.28, none significant.

**ReviewBench, 219 PRs, TP findings scoped introduced-by-PR:**

| Band | n | Golden/PR | High-severity/PR | Median size | Golden per kLOC |
|---|---|---|---|---|---|
| low | 34 | 5.24 | 0.18 | 48 | 57.7 |
| medium | 62 | 7.79 | 0.29 | 228 | 18.3 |
| high | 123 | 14.07 | 1.18 | 1293 | 2.6 |

Correlation with golden count:
- Points: ρ = 0.47.
- Raw size: **ρ = 0.61**.
- Within size terciles, points: ρ = 0.34 (small, p = 0.004), 0.06 (mid, ns), −0.13 (large, ns).

**AACR-Bench permissive, 131 PRs, all golden comments.** In brackets: "Code Defect" comments only.

| Band | n | Golden/PR | Median size | Golden per kLOC |
|---|---|---|---|---|
| low | 62 | 3.85 [1.81] | 34 | 68.1 [31.9] |
| medium | 42 | 8.07 [3.79] | 140 | 37.2 [17.4] |
| high | 27 | 11.70 [5.81] | 457 | 25.6 [12.7] |

Correlation with golden count:
- Points: ρ = 0.57 [0.47].
- Raw size: ρ = 0.50 [0.42].
- Within size terciles, points: ρ = 0.39 / 0.27 / 0.38 (two of three significant at 0.05). Defects-only: 0.21 / 0.23 / 0.37.

**Reading:**
- **The band does rank PRs by how many reviewable issues they contain, on all three sets.**
- **That ranking is mostly diff size.**
  - On ReviewBench, raw size beats the points score outright.
  - Points carry almost nothing once size is held fixed in the mid and large terciles.
  - On AACR, points keep a modest within-size signal: directories and entropy add a little.
- **Issues per line fall steeply as band rises**, by 8x on Martian, 22x on ReviewBench and 2.7x on AACR. A small PR is where each changed line is most likely to carry a finding. This is the "size confound" in a different form: per-PR counts rise, per-line density falls.

### 2.3 Severe bugs: the binary "at least one high-severity bug" (closest to a risk label)

**ReviewBench:**
- 26% of PRs have at least one high-severity introduced TP.
- By band: low 11.8%, medium 17.7%, high 34.1%.
- AUC: points 0.60, raw size **0.70**.

**Martian:**
- 69% of PRs have at least one High or Critical golden bug. The set was curated to contain bugs, so the base rate is high.
- By band: low 60%, medium 50%, high 81.5%.
- AUC: points 0.71, size 0.70.

So at PR level the documented points are **no better than raw size** for flagging PRs with a serious bug, and worse on the larger set. At commit level, RP12 reported AUC 0.785 for the same points against SZZ labels. The PR-level AUC on review-found severe bugs is 0.60-0.71, on different labels.

## 3. Does tool recall differ by band? (part 1b)

Martian's `evaluations.json` gives tp, fn and candidates for 49 tools × 48 PRs (2,351 reviews) under three LLM judges. Pooled recall is micro-averaged, with a PR-cluster bootstrap (3,000 resamples).

| Judge | Recall low / med / high | high − low [95% CI] | high − (low+med) [95% CI] | Precision L/M/H | Candidates per review L/M/H | TP per review L/M/H | TP per kLOC L/M/H |
|---|---|---|---|---|---|---|---|
| Opus 4.5 | 0.536 / 0.431 / 0.430 | −0.106 [−0.183, −0.019] | −0.023 [−0.119, +0.070] | 0.40 / 0.32 / 0.33 | 2.77 / 3.34 / 4.59 | 1.12 / 1.07 / 1.52 | 23.7 / 5.9 / 2.2 |
| Sonnet 4.5 | 0.520 / 0.419 / 0.408 | −0.113 [−0.179, −0.014] | −0.032 [−0.123, +0.052] | 0.37 / 0.30 / 0.31 | 3.00 / 3.50 / 4.79 | 1.09 / 1.05 / 1.48 | 23.2 / 5.8 / 2.1 |
| GPT-5.2 | 0.527 / 0.403 / 0.406 | −0.121 [−0.198, −0.029] | −0.022 [−0.120, +0.068] | 0.34 / 0.27 / 0.29 | 3.30 / 3.73 / 5.02 | 1.11 / 1.01 / 1.46 | 23.4 / 5.5 / 2.1 |

What the table shows:
- **Recall on the high band is not higher**, and it is lower than on the low band, under every judge. Only 19-23 of the 49 tools have higher recall on the high band than on low and medium combined.
- **Bugs caught per review rise only about 35% from low to high**, while the median diff grows about 13x. Bugs caught per changed line fall about 10x.
  - If review cost scales with the size of the diff and its context, as it does for token-billed reviewers, the high band is the **least** cost-efficient place to find bugs at default depth.
- **Output volume does not keep pace.** Candidates per review grow 1.66x low→high while golden bugs grow 1.9x, which is consistent with per-review comment caps or attention limits binding on large PRs.
- **High/Critical bugs are the one stratum that favours the high band.**
  - Recall on High/Critical golden bugs: 0.547 / 0.579 / 0.610 (Opus judge) and 0.539 / 0.547 / 0.584 (GPT-5.2).
  - The low band holds only 5 PRs, so this is weak.
- **Martian's own LLM-assigned `risk_level` label does not separate recall either:** 0.40 for low/medium against 0.43 for high/critical (GPT-5.2 judge).

## 4. Does extra depth help more on the high band? (closest available proxy for the lens question)

There is no public ablation of "same reviewer, more passes, by risk band". The closest data in Martian are pairs of variants of one product whose names indicate more depth or a bigger model. Their internals are undocumented in the repository (the `mra-*` tools are hidden in Martian's dashboard code). Recall change, deep minus shallow, Opus judge; the other two judges agree in sign:

| Pair | low+medium (n=21) | high (n=27) | Candidates high, shallow→deep | Difference in differences |
|---|---|---|---|---|
| qodo → qodo-extended | +0.02 [−0.12, +0.15] | **+0.28 [+0.11, +0.42]** | 112 → 136 | +0.26 |
| qodo-v2 → qodo-extended-v2 | −0.13 [−0.23, −0.02] | +0.08 [−0.02, +0.18] | 102 → 98 | +0.21 |
| mra-nano → mra-ultra | +0.17 [0.00, +0.36] | +0.18 [+0.06, +0.29] | 113 → 150 | +0.01 |
| mra-nano → mra-max | +0.15 [−0.02, +0.31] | +0.19 [+0.06, +0.33] | 113 → 345 | +0.04 |
| mra-claude → mra-mix | −0.06 [−0.19, +0.06] | +0.05 [−0.05, +0.16] | 187 → 177 | +0.11 |

- **The gain from depth is at least as large on the high band, and in the two Qodo pairs clearly larger.** qodo-extended's recall gain is +0.24 to +0.28 on the high band (CI excludes 0 under all three judges) and about 0 on low and medium. That is about +1.0 extra golden bug per high-band PR (0.25 × 4.15).
- **Precision did not suffer there.** It rose from 0.26 to 0.38 on the high band for qodo→qodo-extended.
- **On low and medium, depth can hurt.** qodo-extended-v2 loses 0.13-0.17 recall on low and medium PRs.
- **Taken at face value, this supports VS-28's shape:** spend extra depth on big or complex PRs, and none on small ones.
- **It is confounded:**
  - The variants differ in unknown ways: model, prompts, caps, and run date.
  - n is 21 and 27 PRs.
  - Labels come from LLM judges.
  - No per-review cost is published, so "bugs caught per dollar" cannot be computed. I could only use candidates as a volume proxy.
  - A plausible mechanism is cap relief. Big PRs have more golden bugs than shallow tools emit candidates, so any change that emits more grounded findings on big PRs gains recall there. A lens fan-out (4 lenses × 4 findings) is one such change. Raising the per-review finding cap, or chunking large PRs (VS-19), is another and is cheaper. A VS-28 ablation should include that control arm.

## 5. PR-level and revision-level risk in production: Mozilla bugbug (part 2, code)

I read mozilla/bugbug at 7e8a342 (2026-11-05). This is the most concrete public production system that scores a **review unit** (a Phabricator diff or stack, and per-bug patch groups) rather than single commits.

### 5.1 Labels (`bugbug/models/regressor.py`)
- **Primary label:** the commit's bug ID appears in some bug's Bugzilla "Regressed by" field. These are human-filed regression links.
- **Optional extra label:** SZZ-style `regressor_finder` output (`use_finder`), with a `finder_regressions_only` restriction.
- **Exclusions:**
  - Backed-out commits are skipped entirely (`if commit_data["backedoutby"]: continue`) in both training and evaluation.
  - Negatives are limited to the last 2 years and exclude the last 3 months. A code comment explains that regressions not yet filed would otherwise pollute the clean set.
- **Model:** an XGBoost-style pipeline with isotonic calibration (`IsotonicRegressionCalibrator`) on about 27 expert features:
  - sizes and added/deleted lines for source, test and other files;
  - author and reviewer experience, and reviewer count;
  - whether the component, directory or file was touched before;
  - counts of directories, components and functions touched;
  - rust-code-analysis metrics.
  - Most are diff or history features, as in VS-28's `RiskFeatures`.

### 5.2 Evaluation and bands (`RegressorModel.evaluation`)
- **The evaluation is per bug.** All commits of one bug are grouped and scored by their **maximum** probability. This is closer to PR level than commit level: a bug's patch set is the review unit.
- **Bands are set relative to the base rate, not by fixed weights.** A code comment says: "On average, around 1 out of 8 (13%) patches cause regressions."
  - Band 1 is about half the average risk (~7%).
  - Band 3 is about double (~35%).
  - Band 2 is the middle (~15%).
  - Thresholds are searched on the last 3 months of held-out data, with `MIN_SAMPLE = 200`.
- **The band edges are a deployment secret** (`REGRESSOR_RISK_BANDS`) and are not in the repository.

### 5.3 Use
- **Diff scoring:** `infra/taskcluster-hook-classify-patch.json` runs `bugbug-classify-commit regressor ... --phabricator-deployment ... --diff-id ...`, which applies a Phabricator stack and scores it (`scripts/commit_classifier.py`). It also produces importances and method-level output.
- **Daily landings risk report** (`scripts/generate_landings_risk_report.py`):
  - It counts each team's high, medium and low-risk changes.
  - It predicts regressions as `0.33·high + 0.16·medium + 0.06·low`.
  - It tells teams: "On average, more than 1 out of 3 high risk changes cause a regression."
- **Stated purpose** (README): "It could be used to make riskier patches undergo more scrutiny."
- **No outcome measurement is published in the repository.** Nothing shows whether high-band patches got more scrutiny or whether scrutiny reduced regressions. The training job publishes `metrics.json` to Mozilla's Taskcluster index, which was unreachable from here.

### 5.4 What this means for VS-28 (code)
- **Calibrate bands to the population's base rate**, with a minimum sample, instead of fixed points tuned on another population. Section 2.1 shows fixed commit cutpoints misplace PRs.
- **Score the review unit by the max over its commits.**
- **Keep reverts and regressions separate.** bugbug treats a backout as neither a regression nor a clean example. VS-28's `fixCommits` regex counts `revert`, and Greptile's risk areas are built from revert and incident PRs (GP10). Reverting a change is not the same event as that change having caused a regression.

## 6. Literature and industrial numbers (parts 2-3): status

- **PR-level JIT datasets 2023-2026: no new search was possible**, because the budget was exhausted.
  - From memory, and not verified this round: revert-prediction work exists at commit level, such as Yan et al., "Characterizing and identifying reverted commits", EMSE 2019, and Shimagaki et al., ICSME 2016, on industrial and open-source reverts.
  - I know of no public PR-level dataset with post-merge defect or revert outcomes that is joined to AI-review outputs.
  - The ReviewBench, AACR and Martian golden sets are review-found issues (section 1.2).
  - **This gap therefore stays open:** no PR-level dataset with future-defect labels was found or used.
- **Meta DRS (arXiv 2410.06351):** unreachable through arxiv.org, ar5iv, Semantic Scholar and web.archive.org. Round two's RP20 status ("unverified") stands.
- **Meta RADAR (arXiv 2605.30208):** unreachable in full. What exists is earlier lanes' search extract (LCI21):
  - eligibility gates, then DRS percentile thresholds, then LLM review (auto-accept at confidence ≥ 8/10 with every change classed safe), then deterministic validation;
  - 535K+ diffs reviewed and 331K+ landed;
  - a revert rate 1/3, and an incident rate 1/50, of non-RADAR diffs.
  - The selection effect stays unquantified: RADAR takes only low-risk diffs, so these ratios are not treatment effects.
  - **The base-rate and selection-effect tables the gap asked for were not obtained.**
  - RADAR uses DRS for **routing away from humans** (automating low risk), which is the mirror image of VS-28 (adding depth at high risk).
- **RP17 (human-review studies) is not replaced.** No study found here shows LLM review depth scaled by risk.
  - The closest is section 4: in a cross-sectional comparison, deeper product variants gain more recall on large or complex PRs.
  - That is independent of vendor claims but confounded.

## 7. Greptile risk areas (part 4)

- No new evidence: greptile.com, its changelog and web.archive.org were unreachable or not attempted, per the tool's instruction to stop after repeated host failures.
- Round one's GP10 stands. The knowledge base records past revert, rollback and incident PRs and turns locations into "risk areas" (vendor).
- **No measured effect on bugs caught, false positives, reverts or cost has been seen** in any source reachable by round one or round two.
- In earlier lanes' extracts, the OpenAI customer story on Greptile and Astra was noted by StartupHub as giving "no metrics on accuracy, reverts or cost" (independent commentary, already in round one).

## 8. Answers to the gap's two questions

1. **Do PR-level bands track where review finds bugs?**
   - Partly. They track **how many** reviewable issues a PR has (ρ 0.47-0.57 across three sets).
   - That is mainly diff size: raw size is as good or better, and points add little within size bands on ReviewBench and Martian.
   - They track **severe** bugs no better than size (AUC 0.60-0.71).
   - Per changed line, bugs are densest in the **low** band.
   - Evidence: independent, moderate; the labels are review-found issues, not future defects.
2. **Does routing more depth to the high band raise bugs caught per dollar?**
   - **Unknown, because there is no cost data.** The recall side is mixed but leans yes:
     - At default depth, high-band recall is no better than low or medium. So the high band is where default review misses the most bugs in absolute terms (about 2.4 missed per PR, against about 1.0 in the low band).
     - The one deep-vs-shallow pair with a clear signal (qodo→qodo-extended) gains +0.25 recall only on the high band.
   - The cost side is adverse:
     - With commit cutpoints, the high band covers 56% of PRs and 86-96% of changed lines on two sets.
     - Lenses there multiply most of the spend, so recall would have to rise substantially per extra dollar to pay off.
   - Evidence: independent, weak-moderate.

## 9. Concrete changes this suggests for VS-28 (inference)

1. **Recalibrate cutpoints on PRs before shipping.**
   - Fit the edges on VectorScope's own PR population, or the AACR, ReviewBench or Martian mix, so the high band is a fixed small share of PRs (for example ≤ 20%), or use bugbug-style base-rate-relative bands with a minimum sample.
   - Report the high band's share of PRs **and** of changed lines in the Phase A gate (extends RP5).
2. **Do not claim "points beat size".**
   - Keep the explainable reasons, but expect `riskOf` to behave as a size and spread score.
   - Consider log(la+ld) as the main term, with directories and entropy as tie-breakers. In AACR they carried a small within-size signal.
3. **Add a cap-relief control arm to the lens ablation (Q9).**
   - The arms: extra lenses on the high band; a larger finding cap or VS-19 chunking on the high band; and baseline.
   - Measure recall on high-severity goldens per band, and tokens.
   - The data in section 4 cannot separate "lenses find new bug classes" from "more output slots on big PRs".
4. **Phase A can run offline today on Martian.**
   - Join `evaluations.json` with the computed bands (the scripts above) to report recall per band and high-severity recall per band for every tool, VectorScope included once it has an entry.
   - This needs no model calls.
5. **Keep reverts out of the regression label.** If a revert or incident history feature is added (GP10-style risk areas), treat it as its own feature with its own evaluation, as bugbug does, not as a fix commit.
6. **Keep the existing rules.** Never post the band as a prediction. Do not use a model call for `riskOf` (RP20, I-2).
