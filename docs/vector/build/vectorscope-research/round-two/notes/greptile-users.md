# Greptile in practice: round-two research notes (angle: independent and community evidence)

Compiled 2026-11-06. This extends round one (`REPORT.md`, `greptile-quality.md`, `landscape.md`, `greptile-trust-cost.md`) without repeating it. Every claim carries an evidence label: **vendor** (the company about itself), **independent** (a third party measured it; "my re-analysis" means I recomputed from open third-party data), **academic** (paper or preprint), **code** (read in source), **community** (user reports). Dates are given for every source; where a page shows no date, I say so.

## 0. How this was researched, and the limits

- **Access.** WebFetch failed with DNS refusals for every host tried (codereview.withmartian.com, aicodereviews.io, arxiv.org). Shell curl reached no web host other than GitHub's git endpoints. The GitHub REST API is limited to this session's repositories. So: (a) everything about web pages comes from **WebSearch extracts**, not full reads; (b) everything labelled **code** was read from public git repositories I cloned (`git clone`/`git fetch` of PR refs works).
- **Repositories read** (HEAD commit, date):
  - `withmartian/code-review-benchmark`: `main` at `e616e84` (2026-08-30), all 32 branches fetched; the newest is `add-discover-time-bisection…` at `f6f7aeb` (2026-09-15).
  - `review-bench/ReviewBench` (GitHub's new benchmark) at `f223ce3` (2026-11-05).
  - `shahparshva72/fletcher-code-review-benchmark` at `bc9116b` (2026-10-17).
  - `greptileai/skills` at `59e79ec` (2026-11-03).
  - `cuhk-s3/Archer` at `05b2fcf` (2026-10-02).
  - `abhaymettu/ai-review-churn` at `66ae483` (2026-11-01).
  - PR refs: `synnaxlabs/synnax` #3131 (2026-10-02) and #3208 (2026-10-09); `gptme/gptme` #4322 (2026-10-14).
- **My own analyses** of Martian's open data are reproducible (scripts in the scratchpad; method below). They use Martian's LLM judges and LLM-made PR labels, so they inherit those limits. n is small (50 PRs), so I give bootstrap intervals where a claim depends on a difference.
- X post dates come from decoding the post's snowflake ID (exact to the day).

---

## 1. Martian Code Review Bench as of November 2026

### 1.1 Offline: there is still no independent score of the shipped Greptile v5

**Code (Martian repo).**
- No Greptile run newer than `greptile-v5` (repo date 2026-06-26) exists on any branch of the public repository, including the newest branch (2026-09-15). The tool slugs are `greptile`, `greptile-v4`, `greptile-v4-1`, `greptile-v5`.
- The `greptile-v5` reviews were first committed in `4d32aaf` ("re-evaluate", **2026-08-05**). In the same commit, `greptile-v5` was added to `_HIDDEN_TOOLS` in `offline/analysis/benchmark_dashboard.py`. So the public offline leaderboard has never shown v5. It still shows **v4.1** as Greptile's entry.
- 2026-08-05 is also the date of Greptile's public v5 launch. The repo does not say why the run was hidden. "Pre-release build" (round one's reading) fits, but it is inference.
- **Kai's benchmark page** (kaicontext.com, 2026, vendor/competitor) gives Greptile v5 F1 38.8/42.5/39.4 and, per a search extract, a "28 September 2026" date. Those numbers equal the June run in Martian's raw data to one decimal place. So the date is Kai's own run date, not a new Greptile run. Round one's reading is **confirmed**: no shipped-v5 score exists.

**The leaderboard's default metric is F2, not F1 (code, corrects a detail).**
- The Fletcher repo reproduces the dashboard with Martian's own `benchmark_dashboard.py`. Its default view is the **Core profile with F2**, which weights recall twice as heavily as precision. Round one mostly quoted Core F1.
- Under the default view (Opus judge), Greptile v4.1 scores **F2 51.2** (P 50.9, R 51.3) and ranks **9th of 21**. CodeRabbit scores 51.1 (P 32.6, R 59.5). That near-tie is what Cubic's "CodeRabbit vs Greptile: tied on accuracy" post (cubic.dev, labelled 2026-09-08, vendor/competitor) refers to.
- Under F2, precision-heavy tools fall: Devin goes from 51.6 F1 to 44.8 F2, Kodus-v2 from 46.7 to 41.5, and Graphite to 9.3.
- **Implication:** a precision-first VectorScope (D2, VS-27, VS-31) would rank poorly on Martian's default view by design. Any external comparison has to name the metric and β.

**Judge calibration (independent-ish; a reviewer vendor's open repo).**
- Fletcher re-judged existing runs with Gemini 3.8 Flash. Gemini scored Greptile v5 **39.3** all-category F1 (1.5 points below Sonnet 4.5) and CodeRabbit 42.7.
- It reports Martian's three judges disagree by about 5 points on the same tool. That matches round one's 0.05–0.10 spread.

### 1.2 The 19 March 2026 dedup change reshuffled the leaders (my re-analysis, code)

- A search extract (aicodereviews.io, about Oct 2026, unread) claimed a 19 March "deduplication correction" changed who led. The repo history confirms it:
  - `7740ae7` (2026-03-17) added deduplication of summary and inline comments;
  - `30e9f38` (2026-03-18) added dedup to the judge step;
  - `720e1d3` (2026-03-19) re-scored everything.
- I recomputed all-category micro F1 from `evaluations.json` at `720e1d3~1` (before) and `720e1d3` (after). Both use the 137-golden set of that time.
- **Opus judge, before → after:**
  - `qodo-extended-summary`: #1 (F1 0.643) → #3 (0.503);
  - `cubic-v2`: #12 (0.418) → **#1** (0.618);
  - `codeant`: #4 (0.517) → #31 (0.216);
  - `mra-a`: #3 → #24;
  - `qodo-extended`: #17 → #6.
- **Greptile barely moved:** `greptile` #16 → #16 and `greptile-v4` #14 → #13. Its precision rose about 0.01–0.03.
- GPT-5.2 judge: same pattern (`cubic-v2` #9 → #1; `qodo-extended-summary` #1 → #3).
- **Meaning:** how a benchmark counts a finding that appears both in the summary and inline moved tools by up to 27 places. That is larger than most product-version differences.
- **For VectorScope:** VS-21 and VS-27 need one explicit, tested rule for counting summary-plus-inline duplicates before any comparison. The S7 single-root-cause rule is the right instinct, but the eval's counting rule must match it.

### 1.3 Where Greptile is weak on the open set (my re-analysis, independent data)

Martian ships `offline/results/pr_labels.json`: LLM-made per-PR labels, including `requires_context` (cross_file 34, file 15, local 1), `pr_size_category` (small 20, medium 22, large 8) and `review_difficulty`. I split recall and precision by these labels and by language, under the Opus 4.5, GPT-5.2 and Sonnet 4.5 judges.

**Cross-file PRs (n = 34): Greptile's code graph shows no measurable advantage.**

| Tool | Recall, cross-file (Opus / GPT-5.2 / Sonnet) | Precision, cross-file (Opus) |
|---|---|---|
| Augment | 0.63 / 0.59 / 0.58 | 0.66 |
| Qodo extended-v2 | 0.62 / 0.56 / 0.54 | 0.72 |
| Copilot-v2 | 0.66 / 0.62 / 0.60 | 0.43 |
| Cubic-v2 | 0.60 / 0.56 / 0.54 | 0.61 |
| CodeRabbit | 0.58 / 0.58 / 0.54 | 0.34 |
| **Greptile v4.1** | **0.51 / 0.49 / 0.48** | 0.58 |
| Claude Code (generic agent) | 0.50 / 0.41 / 0.40 | 0.52 |
| **Greptile v5 (June build)** | **0.47 / 0.46 / 0.43** | 0.44 |
| Bugbot | 0.44 / 0.42 / 0.40 | 0.61 |

Paired bootstrap over the 34 PRs (4,000 resamples), Greptile v4.1 recall minus the other tool's:
- vs Augment: −0.12 [−0.21, −0.02] (Opus); −0.10 [−0.19, 0.00] (GPT-5.2).
- vs Qodo extended-v2: −0.11 [−0.19, −0.02] (Opus); −0.07 [−0.14, +0.01] (GPT-5.2).
- vs Claude Code: +0.02 [−0.09, +0.12] (Opus); +0.08 [−0.01, +0.16] (GPT-5.2).

So, on this set, Greptile's cross-file recall is below the leaders and not clearly above a general-purpose agent with no index. Caveats:
- The `cross_file` label is an LLM's judgement.
- n = 34.
- The run dates differ by tool.
- Benchmarks run Greptile without per-team learning.

**Large PRs (n = 8, weak):** Greptile v4.1 recall is 0.40–0.42. Augment scores 0.62–0.67, Copilot-v2 0.65–0.69 and CodeRabbit 0.67. Greptile v4.1 is at its best on medium PRs (0.54–0.60).

**By language/repository (Opus; GPT-5.2 similar):**
- Greptile is weakest on **Python/Sentry** (10 PRs, 36 goldens):
  - v4.1: recall 0.42, precision 0.54;
  - v5: recall **0.31**, precision **0.30**;
  - Cubic-v2: recall 0.69; Qodo extended-v2: 0.58.
- Several of these Sentry PRs come from forks named `sentry-greptile`, that is, from Greptile's own 2025 benchmark.
- Greptile is best on Go/Grafana (v4.1 recall 0.64), where Cubic reaches 0.96.

**By golden category (Opus; n is small):**
- Greptile's security recall is 0.36 (v4.1) and 0.27 (v5) on 11 security goldens. Copilot-v2 scores 0.64, Cubic and Qodo 0.55.
- Test gaps: 0 of 4 for both Greptile builds.
- v5's strongest category is concurrency (0.79, n = 14).
- v5 collapsed on style (0.10) and perf (0.17), which fits round one's "v5 trades breadth for hypotheses".

**For VectorScope:**
- The evidence does not support building a heavy whole-repo index on the strength of Greptile's large-codebase claim. A plain agent matches Greptile on cross-file recall here.
- VS-25's bounded, ranked impact slice plus agentic follow-up is the evidence-consistent choice. Its Phase A gate (+10 points slice recall at equal tokens) is the right test.
- VS-22's `crossFile` label and the ≥30 cross-file target are exactly the slice where Greptile is beatable.

### 1.4 Online leaderboard: Greptile is #2, ahead on precision, about 10 points behind on recall

**Snapshots** (independent board, seen through vendor and third-party captures; the live site was unreachable):

| Snapshot | Greptile | Leader | Source |
|---|---|---|---|
| ~2026-02-27 (launch, v0) | F1 50.6, P 65.3, R 41.3 (#2) | CodeRabbit 51.3 | round one |
| 2026-07-30 | **#1**, F1 60.8, P 76.2, R 50.6 | — | Greptile post (vendor) |
| ~2026-10-04 (last-month view) | #2, F1 61.9, P 79.0, R 50.8 | Cubic 65.3 (P 72.0, R 59.7) | cubic.dev (competitor) |
| Oct 2026 (undated) | #2, F1 61.9, P 80.3, R 50.4 | Cubic 65.7 (P 72.9, R 59.8) | dev.to (tessainsley), 2026 |
| ~Oct 2026 | #2, F1 62.3, P 80.5, R 50.8 | Cubic 65.5 (P 72.4, R 59.8) | aicodereviews.io, about a month old |
| Oct 2026 | — | Cubic 64.9 F1; Copilot 4th at 60.9 | The New Stack, ~Oct 2026 |

**Reading.**
- Since v5 (2026-08-05), Greptile's online precision rose about 3–4 points (76 → 79–80.5) while recall stayed at about 50.5.
- Its online position is a precision lead with a persistent recall gap of about 9–10 points to Cubic.
- Attributing the precision rise to v5 is inference, because the measurement changed at the same time (below).

**The measurement changed in August 2026 (code, Martian `online/README.md` and `methodology/full.md` at `e616e84`):**
- Discovery moved from GH Archive/BigQuery to the GitHub Search API (`reviewed-by:<bot> is:merged`; PR #54 merged 2026-08-26), with up to 500 PRs per bot per day and per-repo caps.
- Filters were added for single-bot PRs, human engagement, minimum reviewers, and capped contributions per author and repo.
- The dashboard lets each viewer combine these filters, so vendors can quote different views ("last-month view").
- Snapshots before and after late August are therefore not like-for-like.

**A sampling caveat (inference):**
- Discovery uses `reviewed-by:greptile-apps[bot]`, which matches PRs where the bot left a formal review.
- A community issue says Greptile "posts no review object on re-review" (vfarcic/dot-agent-deck #366, 2026, date not shown).
- If that holds, the online sample may favour first-pass reviews.
- Not verified.

**For VectorScope:**
- Greptile is not unbeatable online on recall.
- Its precision, about 80% online, is the bar for VS-31's "precise" mode.
- D2's ≥0.80 precision floor is about where Greptile already operates in the wild. So D2 alone is parity, not an advantage. The advantage has to come from recall at that precision, or from cost, privacy and honesty of output.

---

## 2. Other benchmarks and studies that include Greptile, or bear on it

### 2.1 GitHub's ReviewBench (new; released ~2026-10-05)

**Vendor (GitHub blog, via search) and code (repository).**
- An MIT-licensed, open benchmark built by GitHub with Microsoft:
  - 219 PRs from 187 public repositories in 19 languages;
  - a 25-PR test set;
  - an agent contract that runs any reviewer in a container;
  - three runs per leaderboard entry;
  - "grounded" and "augmented" precision and recall.
- Per press coverage, Copilot code review (Balanced) leads at **40.1 grounded F1**. GitHub's team ran rivals' public products, and vendors "did not run or verify" those entries. **Greptile was tested in June 2026** (The New Stack, ~Oct 2026).
- **Greptile's ReviewBench score was not reachable.**

**Code findings (my reading of `docs/METHODOLOGY.md` §5.5 and `corpus/manifest.json`):**
- **Producer bias.**
  - 45.2% of golden true positives (51.4% of high and medium ones) come from `ccr`, "an LLM-based code review system… Section 4.2 does not yet name this system", run with GPT-5.5 and Claude Opus 4.7.
  - 53.0% come from `llm_review` agents, mostly Sonnet 4.6 (46.0% of all TPs).
  - Human review comments supply only **1.5%** of TPs and Semgrep 0.3%.
  - The methodology itself warns that "a reviewer that also contributed golden findings, or that shares models with a producer, may benefit."
  - That `ccr` is GitHub's own Copilot code review is my inference from the name and the result; it is not confirmed.
  - A reviewer built on the same model families is favoured.
- **Labels by a classifier.** Labels come from a fixed Claude Sonnet 5 classifier and "encode *our* working group's taste". Humans re-labelled the set at 96.6% agreement (vendor claim).
- **Repository size.** The median repository is 6.4 MB, and the median PR changes 562 lines across 9 files. **36 PRs come from repositories over 100 MB and 14 from repositories over 500 MB** (largest 1.49 GB). That is a usable large-repo slice, which Martian's set lacks.
- **Other bots' text in PR bodies.** 18 of 219 PR bodies already contain other bots' review text: CodeRabbit in 17, Copilot in 15, Greptile's summary block in 2. In one, Greptile's "Comments Outside Diff" P0 finding (an unbound variable under `set -u`) sits in the body. A reviewer that reads PR bodies sees another bot's answers.
- **Licences.** The manifest has no per-repository licence field, so D8 still needs checking repository by repository.
- **For VectorScope (Q10, VS-22):**
  - ReviewBench is a stronger candidate than Martian's set for an internal diagnostic: MIT harness, real (not re-injected) PRs, a large-repo slice and a local judging CLI.
  - Strip third-party bot blocks from PR bodies before use. This also supports I-2: PR bodies can carry other reviewers' verdicts.
  - Report results by producer, because of the bias.

### 2.2 Archer: Greptile on compiler code (academic)

- arXiv 2607.01808 (Jul 2026) and repository `cuhk-s3/Archer`.
- The authors ran **Greptile, CodeRabbit, Copilot and Codex** (Pro tiers, default settings) on a dataset of bisected LLVM regressions. Per the search extracts: "all commercial tools perform poorly on the regression dataset", flagging mostly superficial concerns (missing API parameters, style), with verbose reports.
- Archer itself combines pass-specific knowledge mined from historical bug reports with compiler validation tools (Alive2, llubi) and reports only findings with a reproducible proof of concept. It found 18 of 47 bisected bugs, and 51 semantic bugs across 398 real LLVM PRs (Dec 2025 to Feb 2026). A third-party note (pith.science) cautions that its 21% and 11% "buggy PR" rates rest on an unvalidated detector.
- Per-tool numbers for Greptile were not retrievable.
- **Reading:** on deep-semantics code, general codebase context does not substitute for domain oracles.
- **For VectorScope:** this supports VS-30's "only trusted executor results confirm" rule. It also suggests a lens, under VS-28, that is backed by domain validators where the repository has them (type checkers, schema validators, property tests), rather than by a bigger index.

### 2.3 A cheap single-pass reviewer matches Greptile offline (community/independent)

- Fletcher is a small open reviewer: one prompt and the production path, on Vertex.
- On Martian's 50 PRs (2026-10-17):
  - **Core F1 50.6** (Gemini 3.8 Flash) at about **$0.085 per PR** of model cost;
  - **F1 51.3 / F2 57.2** (Gemini 4 Argon) at about **$0.19 per PR**;
  - under the same Gemini judge, Greptile v5 scores 39.3 and CodeRabbit 42.7 (all-category).
- Caveats: one run per model, a different judge (±5 points), and the PRs are public, so models may have seen them.
- **Academic corroboration:** "Bigger Isn't Always Better" (arXiv 2606.15689, Jun 2026) reports Claude Haiku 4.5 beating Sonnet 4.6 on code review: F1 0.365 against 0.343, 18% higher recall, at **3.2x lower cost**. It used 150 samples, with Martian's set as external validation.
- **Reading (inference):** Greptile's paid tiers (1, 3 or 10 credits at $1 each) do not buy measurably more on the only open cross-vendor set than a well-prompted single pass costing about 10–20 cents.
- **For VectorScope:** this strengthens the `single-prompt` baseline in §6.3. Every extra VS stage must beat it at equal cost. VS-24's pre-dispatch estimate should report cost per verified finding, not only cost per review.

### 2.4 Academic studies of AI review in the wild (none isolates Greptile)

- **"Is Agentic Code Review Helpful?"** (arXiv 2607.03316, 2026-07-03; Lin, Liang, Thongtanunam, Tantithamthavorn; academic).
  - 31,073 CodeRabbit comments on 10,191 PRs in 239 repositories: **56.3% rejected**, 36.4% accepted, 7.3% discussed.
  - Main causes: false positives, redundancy, out-of-scope remarks, and misalignment with developer intent.
  - Lightweight models trained on project feedback predict rejection at **up to 76% F1**.
  - This is the best academic support for the *idea* behind Greptile's learned suppression, measured on a competitor. It supports VS-11/VS-20's dismissal learning, measured before it gates anything.
- **c-CRAB** (arXiv 2603.23448, Mar 2026; academic). It scores a review by whether a coding agent that applies it produces a patch passing tests mined from human reviews.
  - Tools: PR-Agent, Devin Review, Claude Code, Codex (no Greptile).
  - Together they pass only about 41.5% of 234 tests.
  - It is a usable *method* for VS-21 on `runnable` cases.
- **"AI Writes Faster Than Humans Can Review"** (arXiv 2607.01904, Jul 2026; academic). In an enterprise with a "2x merged PRs" mandate, per-reviewer load roughly doubled and automated review came to exceed human review, while merge and revert rates stayed flat.
- **ai-review-churn** (code, 2026-11-01).
  - It covers **CodeRabbit, Copilot and Gemini only, not Greptile.** Round one listed it among Greptile-related studies, which is a correction.
  - On 4,191 PRs from 3,539 repositories: 90.4% of AI-reviewed PRs got no human inline review; bot threads were resolved 42.9% of the time alone against 74.4% with a human present; merge rates were unchanged (84.9% against 83.1%).

### 2.5 Two widely repeated numbers, traced

- **"Greptile 11 false positives vs CodeRabbit 2."** Round one called it untraceable. It traces to **Panto's blog** (getpanto.ai, a competitor; 2025, exact date not shown), "CodeRabbit vs Greptile". Its method is not visible. A related Panto test used 17 open-source PRs. Label: vendor (competitor). Still unfit to cite as a measurement.
- **"~60% of Greptile reviews are nitpicks or false positives."** It traces only to Surmado's alternatives page (a competitor, 2026), which cites unnamed "independent analysis". Untraceable.

### 2.6 The four-tool, three-week bake-off is not independent (corrects round one)

- dev.to "_vjk", ~May 2026; it was not opened, so the details below come from search extracts.
- The author discloses that they **work at Sentry**, whose Seer was one of the four tools. Round one labelled it "independent (single team)". It is **community, vendor-affiliated**.
- What it reports:
  - 679 findings on 146 merged PRs;
  - Greptile 120 findings on 55 PRs (2.2 per PR, the lowest), with near-zero false positives on correctness and architecture;
  - Greptile's status check "flickers", CodeRabbit "thrashes", and Bugbot and Seer were stable;
  - CodeRabbit was slowest, at 9.5 minutes mean to first finding.
- **Most important: of 617 distinct flagged locations, 93.4% were flagged by exactly one tool** (relayed by Addy Osmani, X, 2026-06-15).
- **For VectorScope:** reviewers barely overlap, so no single tool's silence means "clean". This supports VS-28's single-class lenses (union, then verify) and I-7's rule that an empty result is never shown as "clean" unless it is complete.

---

## 3. Community evidence: what users praise and what they complain about

### 3.1 Praise (community; none of it measured)

- "Greptile > Qodo > CodeRabbit. Greptile found the most serious issues and less noise" (Praveen, X, **2026-11-02**). The poster is moving to self-hosted reviewers run in parallel.
- "the best code review agent I've used yet", in the same post as a pricing complaint (Matt Galligan, X, **2026-03-06**).
- The vendor-affiliated bake-off rated Greptile best on precision and signal density (§2.6).
- **A real catch on a dependency bump:** gptme's automerge workflow (code, 2026-10-14) cites Greptile flagging that tailwind-merge 3 targets Tailwind 4 (gptme #4257). It holds automerge unless Greptile scores 5/5.
- In apmantza/pi-lens #4685 (2026, date not shown), Greptile accounted for 64 of 111 actioned threads across three bots on the same repository.

### 3.2 Noise and trust (community)

**Hacker News** ("There is an AI code review bubble", a thread on Greptile's own essay, front page ~2026-01-26, about 351 points and 249 comments, per a listing):
- "pretty much pure noise. I ran it for 3 PRs"; the commenter also found a 4/5 confidence score on every PR irritating because reviewers read it as "the PR has a problem" (item 46777079);
- "so bad we decided to switch to Claude" (item 46770850);
- a company that compared it with Cursor's reviewer did not buy it: occasional good insights, but it overwrote PR descriptions and sometimes argued with itself in comments;
- another commenter noted Greptile finds fewer issues as Claude Code and Opus improve;
- only the top comments were visible in extracts.

**Other community reports:**
- An aggregator quotes a Reddit thread: "might catch more bugs, but at what cost? High false positives, slow reviews" (doolpa.com, 2026). The thread itself was not found.
- PostHog's PR #120228 (2026, date not shown) turns off Greptile's automatic reviews on PR open (`autoReview: []`). The search found no reason given.
- pi-lens #4685 narrowed Greptile with `greptile.json`: reviews only on open, Dependabot excluded, status check off.
- Fooftilly/PRKS #363 proposes minimising noisy bot comments, including Greptile "trial-ended" reviews.

**Praise against measurement:** users praise precision and "serious issues". The measured record shows precision near 80% online, mid-pack offline precision and recall, and **below-leader recall** both online and on cross-file PRs (§1.3–1.4). The praise is consistent with the measurements on precision; nothing measured supports a recall or large-codebase advantage.

### 3.3 The 5/5 merge-gate ecosystem, and why it is fragile (code + community)

A pattern that round one did not see: many repositories make Greptile's 0–5 confidence score a **merge gate**, and the score is not delivered in a machine-trustworthy way.

- **synnaxlabs/synnax.**
  - #3131 (2026-10-02, "Require a 5/5 Greptile score in the review gate"); #3208 (2026-10-09, "[ci] Gate merges on the Greptile review alone").
  - `check_review.sh` (code) says: "The check run succeeds at any score. The score lives only in the description, which the author can edit, so only the latest revision Greptile wrote counts, and only when it names the head. Every score marker must be a 5: a commit title can quote one."
  - It reads GraphQL `userContentEdits` to find the bot-authored revision, matches the hidden marker `greptile_confidence_score:N`, and requires that the revision names the head SHA.
  - Its header says human review is "a convention… not a gate".
- **gptme/gptme #4322** (code, 2026-10-14).
  - "Greptile does not re-review when Dependabot rebases", so the workflow compares dependency lists to decide whether an older review still counts.
  - "No review at all within 90 minutes of the PR opening counts as 5/5: Greptile being down or skipping a PR shouldn't stall routine bumps." That is a user-built **fail-open**.
- **Other gates (community, 2026, dates not shown):**
  - vitali87/code-graph-rag #3558 ("fail the merge unless Greptile scores the head commit 5/5");
  - aetosdios27/Yen #42: the score sits in the PR description, which the author can edit, so the gate script is checked out from the base;
  - fgutort8-droid/albus #11: forged score markers in comments;
  - HamedMP/matrix-os #2572: fails closed on duplicate score headings, because quoted prose could spoof the reviewed commit;
  - brandonmcconnell/geld #434: a pasted "Confidence Score: 5/5" in the description passes a naive gate;
  - mylescorp/mylesnet-dashboard #104: **a 4/5 review showed the 5/5 gate green and merged before its findings were fixed**;
  - Harmeet10000/AgentNexus #98: the gate rejected valid punctuation in the review SHA;
  - theolundqvist/pr-cockpit #39: a stale-score bug;
  - guilhermegor/dotfiles-linux-dev #832: a "trial-ended" notice counted as head-review coverage.
- **Greptile's own tooling confirms the multi-surface problem (code, vendor).**
  - Its `greploop` skill (`greptileai/skills`, v1.3) says: "Greptile may surface its score in several places — check **all**". It reads the PR body, issue comments ("Greptile may edit the same general PR comment on each review cycle… use… `updated_at`") and PR reviews.
  - It then loops (push, re-review, fix) up to 5 times until "5/5 confidence, zero unresolved comments".
- Greptile documents auto-approve on a clean 5/5 (beta). At the "Critical" risk setting it approves every 5/5 change (vendor docs via search).

**Why this matters:**
- Round one found the score weakly calibrated. 5/5 PRs still had a missed High or Critical golden issue in 2–4 of 7–8 PRs per build.
- Teams are now using that score as the **sole** gate, sometimes with fail-open on absence, and agents are told to loop until they satisfy it. That is a Goodhart setup: the agent optimises for the reviewer's approval, not for correctness (inference).

**For VectorScope (concrete):**
- Publish the verdict as **a check-run conclusion bound to the head SHA**, with the VS-27 `StrictResult` JSON as the check's output. Never in PR text that the author can edit.
- Keep "Not reviewed" and "Review incomplete" as distinct, machine-readable states, so a gate cannot fail open by mistake (extends I-7).
- Never emit an approve-style scalar that invites auto-merge without D2 evidence.
- Since Vector is itself a coding agent, a native fix loop should treat VectorScope as evidence, not as the oracle (I-2).

### 3.4 Reliability and integration friction (community)

- "Dashboard shows reviews as 'completed' but the bot isn't posting comments on re-triggers" (Prakhar Shukla, X, **2026-03-26**).
- A request comment that was never posted meant no review; the workaround is re-posting after a timeout (cloving-ai #239, 2026).
- Round one found that Martian's operator needed 53 manual re-triggers for 50 PRs in March.
- The status check "flickers" (§2.6).
- No review object on re-review (dot-agent-deck #366).
- Mermaid diagrams render as raw source in the Checks panel (stablyai/orca #38185).
- Drafts: Greptile's docs say drafts are skipped by default, but a raycast/extensions issue (#32497) asks to stop automatic reviews on drafts.
- Greptile's troubleshooting docs list "Pending status that doesn't update", timeouts and partial reviews, and advise splitting PRs and adding `ignorePatterns` (vendor docs via search).
- **For VectorScope:** idempotent, head-bound reviews, plus one sticky summary with a state marker (already in VS-27c), plus explicit partial-coverage reporting (I-7), answer each of these.

### 3.5 Cost and billing complaints (community)

- **Uncapped by default.** A 1-star Trustpilot review (Danish page, **2026-10-10**): "Charged $700 instead of $90… they had enabled unlimited 'flex usage' by default, without my explicit consent or any spending cap… Greptile refused [a refund]." A second review says enabling Greptile on open-source repositories silently activated usage billing.
- **Per-review pricing punishes stacked PRs** (Matt Galligan, 2026-03-06): "$1/review past 50/mo will be blown past in less than 3 days." Critics note that, by Greptile's own figure of 1.2 reviews per PR, 50 reviews is about 42 PRs per developer per month. An anonymous critic page ("Greptile's New Pricing Is Predatory", 2026) alleges OSS-program members were billed and refunded only after public pressure (unverified).
- **The October 2026 prepaid-credit pool** (no seat fee; Base, Plus and Apex at 1, 3 and 10 credits). Third-party guides note that the pricing page does not say what happens when the pool runs dry, or whether credits roll over (unverified).
- **For VectorScope:**
  - Keep hard dollar caps **on by default** in every runner. Today the desktop runner has none, which is a gap round one recorded; VS-24 should close it.
  - Price and estimate per diff, not per trigger, so stacked small PRs are cheap.
  - Make re-reviews incremental (carry-on-rebase already exists in the engine).
  - Spend zero tokens on rebases with identical content.

### 3.6 Privacy in practice (thin community evidence)

- The search found no community thread raising Greptile privacy incidents. The concerns stay structural (round one): training on de-identified data with an opt-out, and ZDR claims with unnamed subprocessors.
- **Vendor, new.**
  - v5 runs open models on Together AI (round one).
  - OpenAI's Greptile case study (**2026-10-26**) adds GPT-6 Astra for browser-driven testing (it starts a dev server and simulates a user at an iPhone viewport), Daybreak for security, and Codex reading Greptile's knowledge base over MCP for "thousands of customers".
  - Each added model provider is another place where ZDR must hold. No public statement says which of these routes are covered.
- **For VectorScope:** VS-23's per-route refusal with notes ("this route was refused because…") is a differentiator only if it is visible. A per-review route manifest in the JSON (which provider, ZDR attested or not) is something Greptile's users cannot get.

### 3.7 Large repositories in practice

- Third-party guides (2026, unverified) say Greptile must index the whole repository before its first review: 15–30 minutes for medium repositories and "potentially hours" for large monorepos.
- A community issue (stealth-factory/opscope #5) argues that the index silently loses value as it falls behind the default branch.
- No independent source measures Greptile's latency or quality by repository size. Martian online skips PRs over 2,000 lines, and offline has 8 "large" PRs.
- ReviewBench's 36 PRs from repositories over 100 MB are the only open slice where large-repo claims could be tested (§2.1).
- **For VectorScope:** VS-25's no-index, per-review slice (about 4.8 s to parse 2,735 files in round one's benchmark) avoids the cold-start and staleness problems entirely. It is worth stating as a product property once it is measured.

---

## 4. Praised versus measured: a summary

| Claim about Greptile | Users say | Measured (independent) | Verdict |
|---|---|---|---|
| High precision, little noise | Mixed: "pure noise" (HN, Jan 2026) vs "less noise" (X, Nov 2026) | Online P 76→80% (#1 on precision); offline P ~0.51 (Core, v4.1) | **Supported online** |
| Catches the most bugs | Some praise | Online R ~50.5 vs Cubic ~59.8; offline v4.1 recall mid-pack, v5 build lower | **Not supported** |
| Best for large codebases (graph) | Implied by marketing | Cross-file recall 0.48–0.51, below 4 tools, ≈ plain Claude Code; large PRs 0.40–0.42 (n=8) | **Not supported on open data** |
| 5/5 = safe to merge | Used as a merge gate by many repositories | 5/5 PRs still missed High/Critical goldens in 2–4 of 7–8 (round one) | **Contradicted** |
| v5 is better | Vendor A/B: addressed 52→66% | Pre-release v5 offline lower under all judges; no shipped-v5 score; online precision +3–4 points (confounded) | **Unverified** |
| Fast | v5 median 2:25 (vendor) | No independent latency measure found | **Unverified** |
| Fair price | "$1/review trap"; uncapped flex usage | A $0.09–0.19 single-pass reviewer matches its offline F1 | **Weak value on offline evidence** |

## 5. Where Greptile fails: openings for VectorScope, mapped to the contract

1. **Recall at high precision.** Greptile sits at about 80% precision and 50% recall online. VectorScope's D2 floor (≥0.80 precision) is parity. The opening is class-scoped recall at that precision (Q3/D16), via VS-28 lenses plus the VS-27 verify gate. Measure against the `single-prompt` baseline, which a cheap reviewer shows can already reach mid-pack.
2. **Cross-file and large PRs.** Greptile trails here on open data. VS-22's ≥30 cross-file cases and a ReviewBench large-repo slice (licences permitting) are where to prove VS-25.
3. **A trustworthy machine verdict.** Teams gate merges on a score the PR author can edit, delivered on three surfaces, with a check run that "succeeds at any score". VectorScope should ship a head-SHA-bound check conclusion plus `StrictResult` JSON, never a pass inferred from absence, and an explicit "Not reviewed" or "incomplete" state (I-7). This is low-cost and directly answers a pain users are building workarounds for.
4. **No fail-open.** Users write "no review in 90 minutes = 5/5". VectorScope's absence must be distinguishable from approval.
5. **Predictable cost.** Uncapped-by-default billing and per-trigger pricing are live complaints. VectorScope can offer hard caps by default, per-diff estimates (VS-24), and zero spend on rebases and trivial changes. Note that dependency bumps can hide real breaks (gptme's Tailwind case), which supports keeping them out of the trivial skip (Q11).
6. **Honest benchmarking.** Martian's 19 March dedup change moved tools by up to 27 ranks. ReviewBench's goldens are 98% LLM-produced. VectorScope's sealed, human-settled harness (I-13) is stricter than any public Greptile number, provided it reports the summary-dedup rule and producer bias explicitly.
7. **Python/Sentry-like code and security.** Greptile's weakest repository (recall 0.31 for the v5 build) and its low security recall (0.27–0.36, n = 11) are small-n signals. They are worth including as VS-22 strata, not as claims.
8. **Domain oracles over bigger context.** Archer shows that validators plus domain knowledge beat general reviewers on compiler code. VS-30's trusted-executor-only confirmation is the right shape.

## 6. Corrections to round one

- The leaderboard default is **Core F2**, not F1. Greptile v4.1 is F2 51.2 (9th of 21, Opus judge). Round one's Core-F1 table is correct as F1 but is not the "default view".
- `greptile-v5` was **hidden from the dashboard in the same commit that published it** (2026-08-05). Kai's "September" figures are the June run.
- The "11 FP vs 2" figure traces to Panto's blog (a competitor), so it is not untraceable. It is still unusable.
- The dev.to four-tool bake-off is by a **Sentry employee**, so it is vendor-affiliated, not independent.
- ai-review-churn does **not** cover Greptile.
- Round one's "cross-file recall is 8–11 points lower, pooled" now has a Greptile-specific slice (§1.3).

## 7. Unreachable or unverified

- The live Martian leaderboard (codereview.withmartian.com): DNS refused to WebFetch and curl. Online numbers come from third-party snapshots.
- ReviewBench leaderboard values, including Greptile's June score (review-bench.ai unreachable; the repository holds no results).
- Archer's per-tool numbers for Greptile (arXiv unreachable).
- Full Hacker News threads, Reddit threads (none surfaced), and the full text of X posts. Quotes come from search extracts.
- dev.to full posts (the _vjk bake-off, the "$1/review trap" review), Trustpilot pages and Greptile's Trust Center subprocessor list.
- Martian's `speed_analysis.json` (the script exists, but no output is committed), so there is **no independent latency** for Greptile.
- Any shipped-v5 or post-tier (Plus/Apex/Auto) independent offline score.
- Whether Greptile's ZDR covers Together AI, GPT-6 Astra and Daybreak routes.
