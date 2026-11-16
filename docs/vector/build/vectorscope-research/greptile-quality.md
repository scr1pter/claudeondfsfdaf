# How Greptile gets review quality: research notes

Compiled 2026-11-05 for Vectorscope. Scope: noise and false-positive controls, learning from teams, bug-catching and "prediction" claims, summary and confidence-score UX, and every benchmark involving Greptile I could find, with a critique of each method.

## 0. Access caveats (read first)

- **www.greptile.com and dev.to were blocked** by this session's egress proxy. WebFetch failed with ENOTFOUND, and curl got a CONNECT 403. arxiv.org and news.ycombinator.com were also unreachable. I did not try to route around the block (no archive mirrors).
- So Greptile docs, blog and changelog claims below come from **search-engine extractions of those pages** (the WebSearch tool), not from pages I read in full. Each one is marked "(via search extraction)". Exact wording and some numbers should be re-checked once greptile.com is allowed.
- **GitHub was reachable.** I cloned the open-source Martian Code Review Bench repo (`withmartian/code-review-benchmark`, HEAD `e616e84`, committed 2026-08-30). It holds Greptile's **raw review comments** from four Greptile versions on 50 benchmark PRs, plus judge outputs. This is the strongest primary evidence in these notes: real Greptile output (summaries, confidence scores, P-badges, diagrams) and an independent scoring of it. My own re-analysis of that data is labelled **[my analysis]**. It is reproducible with the code in Appendix A.

Label key: **vendor claim** (Greptile or a competitor about itself or a rival) / **independent evaluation** (a third party with no product in the race, or open data) / **research** (peer-reviewed or preprint) / **inference** (my reasoning) / **code** (from repo code or data).

---

## TL;DR

1. **Noise control has three layers:**
   - static knobs: `strictness` 1-3, `commentTypes`, ignore patterns, and P0/P1/P2 severity gating;
   - a learned, per-team suppression layer: embeddings of comments a team downvoted, ignored or addressed, plus suggested rules;
   - since v3 (Sep 2025), agentic validation. Since v5 (Aug 2026) this is a "swarm" of agents that each test one bug hypothesis. Greptile also adds paid depth tiers (Base, Plus, Apex) and routes review to a different model family than the one that wrote the PR ("model inversion").
2. **Greptile's north-star metric is "addressed rate":** the share of its comments the author addresses before merge, judged by an LLM. Reported values: 19%→55% (Dec 2024 embedding filter), 30%→43% (v3→v4), 52%→66% (v4→v5). All are vendor A/B claims with no published method. Martian's *online* benchmark defines precision almost the same way, which helps explain why Greptile ranks #1-3 there on precision. [inference]
3. **Benchmarks conflict sharply, and the differences come from metric choice:**
   - Greptile's own July 2025 test: 82% catch rate (Bugbot 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%). Recall only, one planted bug per PR, false positives ignored.
   - Augment (Dec 2025): Greptile F 45% on the same PRs with expanded golden comments.
   - Macroscope: 23.6%, from 17 of 72 bugs.
   - Tenki: 36.1% recall.
   - Martian offline (open data, core profile): Greptile v4 ranks 8th-9th of 21 tools, F1 45.0-51.1 across three judges.
   - Martian online: #1 at F1 60.8 / precision 76.2 / recall 50.6 on 2026-07-30, then #3 by about Oct 2026.
   - Cursor's resolution-rate table: Bugbot 78.13% vs Greptile 63.49%.
4. **[my analysis] Severity badges carry signal, but it weakened in v5.** On Martian's offline data:
   - Greptile v4.1 (Apr 2026): P1 comments 60-72% precise vs P2 at 33-37%. P0 was 5/5 correct.
   - Greptile v5 (Jun 2026 run): many more comments were marked P1 (131 vs 80), and P1 precision fell to 37-40%, close to P2.
   - Offline F1 also fell from v4.1 to v5 under all three judges (Opus 0.524→0.425, all categories, micro-averaged), while Greptile reported addressed rate rising 52%→66%.
5. **[my analysis] The 0-5 confidence score is weakly informative and poorly calibrated on known-buggy PRs.** Every benchmark PR contains known issues, yet v5 gave 4/5 on 38 of 50 and 5/5 on 7. In 2-3 of those 7 five-star PRs Greptile missed at least one High or Critical golden issue. Using 5/5 to auto-approve (a beta feature) is therefore risky.
6. **No "future bug prediction" or hotspot feature exists**, as far as I could find. The closest are:
   - an opt-in "preventative" security mode that flags patterns that raise future vulnerability risk;
   - the confidence score;
   - the "Auto" tier picker (by PR size, risk and complexity);
   - auto-approve with risk caps.

---

## 1. Noise and false-positive reduction

### 1.1 Static configuration knobs (vendor docs, via search extraction; undated living docs, read 2026-11-05)

- **`strictness` (1-3, default 2).**
  - The reference says 1 comments on all issues, 2 does moderate filtering, 3 comments only on the most critical issues. Other values are rejected.
  - The dashboard shows it as Low / Medium / High. The quickstart says "Medium comments on P2s less often, High never comments on P2s". So strictness works as a **severity-threshold gate on P-levels**.
  - Sources: https://www.greptile.com/docs/code-review/greptile-json-reference, https://www.greptile.com/docs/code-review/controlling-nitpickiness, https://www.greptile.com/docs/quickstart
- **`commentTypes`.**
  - Docs list `logic`, `syntax`, `style` (one doc also lists `info`). All are on by default. Setting the array replaces the defaults.
  - The docs suggest `["logic"]` for logic-only review.
- **`ignorePatterns`:** a newline-separated string in .gitignore syntax.
- **`.greptile/` directory config** supersedes `greptile.json`. If both exist in the same directory, `.greptile/` wins.
  - It supports cascading per-directory overrides, separate rules files, and structured rules with severity and disable-by-ID.
  - When monorepo configs conflict, strictness takes the maximum and commentTypes take the union.
  - Org-level enforced rules from the dashboard cannot be overridden by repo config.
  - Sources: https://www.greptile.com/docs/code-review/greptile-config, https://www.greptile.com/docs/code-review/greptile-config-reference
- **`patternRepositories`** points Greptile at repos whose patterns count as the house style. The confidence score uses this as its "fits codebase patterns" factor.
- **Implication [inference]:** Greptile's default is fairly permissive (strictness 2, all types on). Precision is tuned per team rather than fixed. Benchmarks run "at default settings with no custom rules" therefore measure an untuned product. Greptile's own benchmark states that rule (July 2025), and so do Martian's.

### 1.2 Severity tiers P0 / P1 / P2 (vendor docs and changelog via search extraction; primary artifacts in Martian data)

- **Docs ("Anatomy of a Review"):**
  - P0 = must fix before merge (security, data loss, crashes);
  - P1 = should fix (bugs, edge cases);
  - P2 = consider fixing (code quality, maintainability).
  - Source: https://www.greptile.com/docs/code-review/first-pr-review
- **Changelog:** a v5 release added P0/P1/P2 badges and a findings list sorted by severity. Source: https://www.greptile.com/changelog
- **[code] Conflict with primary artifacts.** In Martian's data the badges already appear in Greptile reviews posted **2026-04-07** (run `greptile-v4-1`, badge asset `p1.svg?v=7`). The badges therefore predate v5. Earlier runs (Jan 2026 `greptile`, Mar 2026 `greptile-v4`) have no badges.
- The analytics "Bugs Caught" tab filters findings by P0/P1/P2: https://www.greptile.com/docs/analytics (via search extraction).

### 1.3 The embedding-based nit filter: Greptile's best-documented technique

Source: "How to Make LLMs Shut Up", Greptile blog, **Dec 2024**: https://www.greptile.com/blog/make-llms-shut-up. This is a vendor claim, via search extraction. HN discussions: https://news.ycombinator.com/item?id=42465374 and https://news.ycombinator.com/item?id=42451968. ZenML LLMOps case-study summary: https://www.zenml.io/llmops-database/improving-ai-code-review-bot-comment-quality-through-vector-embeddings

- **Baseline audit:** about 19% of comments were good, 2% were flat-out wrong, and **79% were nits**: technically true, but not something the developer cared about.
- **What failed:**
  - prompting with good and bad examples;
  - a second LLM pass that rated each comment's severity 1-10. The post concludes that "LLMs are bad evaluators of severity".
- **What worked:**
  1. Embed past comments that developers addressed, upvoted or downvoted.
  2. Store the vectors **partitioned per team**, because what counts as a nit varies by team.
  3. Block new comments that sit close to downvoted ones.
- **Claimed result:** within two weeks of rollout, address rate went from **19% to 55%+**. This is vendor-reported, with no control group or confidence intervals described.
- **HN critique:**
  - a second LLM call might have filtered low-importance comments without any voting;
  - embeddings may capture the *form* of a comment rather than its meaning.
- **Relevance [inference]:**
  - This approach needs feedback data, so it starts cold.
  - It does not suppress by category (security is never suppressed, see 1.4).
  - It is the core of Greptile's "learning" story.

### 1.4 Learning thresholds: what can and cannot be suppressed (vendor docs, via search extraction)

Sources: https://www.greptile.com/docs/how-greptile-works/nitpicks and https://www.greptile.com/docs/how-greptile-works/memory-and-learning

- **Suppressible if consistently ignored:**
  - style and formatting;
  - import organisation;
  - missing non-critical docs;
  - naming deviations;
  - code-organisation preferences.
- **Never suppressed:** security vulnerabilities, memory leaks, null-pointer exceptions.
- The example in the memory docs suppresses a missing-semicolon comment after **3 ignores**. It looks illustrative; no official threshold is documented.
- **"Addressed" is inferred from commits** by comparing the first and last commit of the PR.
  - The MCP auto-fix doc gives a looser definition: any later commit that touches the file.
  - These two definitions may be inconsistent. Sources: https://www.greptile.com/docs/how-greptile-works/nitpicks, https://www.greptile.com/docs/mcp-v2/auto-fix

### 1.5 Agent architecture changes that Greptile credits for precision (vendor claims)

**v3, "agentic" (launched about 2025-09-23).**
- A full rewrite into an agent loop with codebase-search tools, built on the **Claude Agent SDK**: sub-agents handle codebase memory, and hooks are used for determinism.
- Claims: a **256% improvement in the upvote/downvote ratio** and **70.5% higher acceptance** than v2. No method was disclosed.
- Sources: https://www.greptile.com/blog/greptile-v3-agentic-code-review, https://claude.com/customers/greptile

**v4 (about 2026-03-05).**
- Claimed "far lower false positive rate" than v3, but **no FP numbers were published**.
- A/B results claimed:
  - addressed comments per PR 0.92→1.60 (+74%);
  - addressed rate **30%→43%**;
  - positive replies +68%;
  - upvotes +60%.
- "Addressed" is judged by an LLM.
- Pricing changed to $30 per developer per month including 50 reviews, then $1 per review.
- Source: https://www.greptile.com/blog/greptile-v4. Dating is from the LinkedIn post https://www.linkedin.com/posts/dakshg_today-were-releasing-greptile-agent-v4-activity-7435353275857743872-7idK and third-party reviews.

**v5 (blog dated about 2026-08-05, per search extraction).**
- "Spins up a swarm of agents that each explore one hypothesis for a potential bug."
- Claims: median review time 5:04→2:25, and addressed rate **52%→66%** in production A/B tests.
- Martian ran a `greptile-v5` build on 2026-06-26, so a pre-release was evaluated before the public date.
- Note that v4's addressed rate is quoted as 43% at launch and 52% as the v5 baseline. The baseline drifted, or the cohorts differ.
- Sources: https://www.greptile.com/blog/greptile-v5, https://www.greptile.com/changelog

**Review tiers (2026-09-25).**
- Base costs 1 credit, Plus 3, Apex 10. Deeper tiers give more time for parallel sub-agents.
- An **Auto** mode picks the tier "based on size, risk, and complexity".
- Tier rules can match labels or file counts, for example a `security` label runs at Apex.
- Sources: https://www.greptile.com/blog/introducing-plus-and-apex, https://www.greptile.com/docs/code-review/review-tiers

**TREX (beta, about June 2026).**
- Writes and runs tests in a sandbox and drives the app like a user (clicking, typing), posting videos of the flows.
- Claim: "~20% more bugs than review alone", with no method disclosed.
- QA.tech, a competitor, notes it does not run your existing test suite or your deployed app.
- Sources: https://www.greptile.com/trex, https://www.greptile.com/docs/trex/overview, https://qa.tech/compare/greptile-alternatives

**Model inversion (blog about 2026-07-21; experimental).**
- Both models found more bugs in code written by the *other* model.
- Greptile now detects which agent authored a PR and routes review to a different model.
- Sample: about 1,000 buggy PRs in Greptile's account, or 2×500 in a secondary account. The exact per-model numbers were not visible to me.
- Source: https://www.greptile.com/blog/model-inversion

**Independence positioning (Jan 2026).** "There is an AI Code Review Bubble" argues that a reviewer should not be the same vendor or model that wrote the code. Greptile deliberately does not generate code. Sources: https://www.greptile.com/blog/ai-code-review-bubble, https://www.greptile.com/independence

---

## 2. How Greptile learns from teams

Vendor docs via search extraction; living docs read 2026-11-05.

**Signals used:**
- team PR comments (from human reviewers, not only replies to Greptile);
- replies to Greptile;
- 👍/👎 reactions (only these two train; other emoji are neutral);
- commits, to see whether comments were addressed between the first and last commit.

The docs recommend adding a reply to every 👎 explaining why. Sources: https://www.greptile.com/docs/code-review/training-the-learning-system, https://www.greptile.com/docs/how-greptile-works/memory-and-learning, https://www.greptile.com/docs/code-review-bot/custom-context

**Time to adapt:** "noticeable improvement in the first few weeks". Developer Essentials says 2-3 weeks of consistent reactions. Source: https://www.greptile.com/docs/code-review/developer-essentials

**Suggested rules ("rules from past comments"):**
- After about 10 PRs, Greptile detects consistent patterns and proposes rules. Example: repeated team comments saying "Move DB calls to service layer" become a rule.
- Suggested rules have status **SUGGESTED**, then **ACTIVE** or **INACTIVE**. Org or team admins approve them; members can only view.
- The docs warn that suggestions may duplicate existing rules. Learned items are visible on the dashboard's custom-context page.
- Sources: https://www.greptile.com/docs/code-review/custom-standards, https://www.greptile.com/docs/mcp-v2/custom-context, https://www.greptile.com/changelog

**Explicit custom rules:**
- written in plain English or as markdown files;
- scoped by repo, path or pattern;
- `.greptile/rules` files can be scoped to the directories each team owns;
- Greptile indexes existing `CLAUDE.md` and `AGENTS.md`.
- Rule-usage tracking shows whether Greptile applied a rule and whether the team acted on it.

**Competitor framing:**
- **CodeRabbit (about Nov 2025, vendor):** emoji are ambiguous ("agree this is a bug" vs "thanks"). Reward hacking pushes the model toward tone and flattery. Behavioral signals (fixed, dismissed, replied) are better. CodeRabbit stores corrections as natural-language "Learnings". https://coderabbit.ai/blog/why-emojis-suck-for-reinforcement-learning
- **Cursor Bugbot (about Apr 2026, vendor)** shipped near-identical "learned rules":
  - inputs: reactions, replies explaining what was wrong, and human-reviewer comments flagging bugs Bugbot missed;
  - candidate rules get promoted to Active, and are disabled after negative feedback.
  - https://cursor.com/blog/bugbot-learning
- **Implication [inference]:** the "learn from reactions, replies and commits → propose rules → admin approval" loop is now table stakes. Differentiation lies in signal quality (behavioral over emoji) and in using human reviewers' comments on bugs the bot missed, which give a recall signal and not just a precision signal.

**Unverified items:**
- A claim that Greptile weights senior engineers' comments more: no source found. Cubic, a competitor, does let teams pick up to 5 senior reviewers to learn from.
- A Miraheze wiki's "68% rise in positive replies" is probably the v4 "+68% positive replies" figure, attributed elsewhere.

---

## 3. How Greptile claims to catch or "predict" bugs

**Graph-based context (vendor docs).**
1. Parse every file into directories, files, functions, classes and variables.
2. Map calls, imports and variable usage.
3. At review time, pull each changed function's dependencies, callers and similar functions elsewhere.

The graph updates incrementally. First indexing of a large repo can take hours (third-party report). Source: https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context

**Hypothesis-driven agents (v5, vendor).** Each agent investigates one suspected bug. This turns review into a generate-then-verify loop rather than single-pass commenting.

**Executing code (TREX, vendor).** See 1.5.

**"Prediction", "hotspot" or "risk score" features: none found.** The searches turned up nothing that predicts *future* bugs per file or module, as defect-prediction tools do. The closest features:
- **Preventative security (opt-in, ~Apr 2026).** It flags patterns that are not vulnerabilities yet but "increase the propensity of future vulnerabilities". Example: a helper function with no auth check that today is always wrapped by an authenticated caller. Sources: Daksh Gupta on X, https://x.com/dakshgup/status/2043774671259349019 (vendor), and the changelog's Security Review beta.
- **Confidence score 0-5** (Section 4): a merge-readiness score for the current PR, not a forecast.
- **Auto tier selection** by "size, risk, and complexity". This implies an internal per-PR risk estimate, but no published scale or method.
- **Auto-approve (beta).**
  - Approves "low-risk, bug-free PRs after a clean 5/5 review", subject to a configurable risk cap.
  - With no cap the ceiling is "Critical". Greptile recommends starting at Low (docs, tests, styling, small low-risk changes).
  - Conflict: the changelog says auth, secrets, billing, migrations, infra, CI and public APIs are *never* auto-approved, while the docs say a low-risk change under a sensitive directory can pass a Low ceiling.
  - Config is read from the base branch, so a PR cannot loosen it for itself.
  - Sources: https://www.greptile.com/docs/code-review/auto-approve-prs, https://www.greptile.com/changelog
- **Public repos already gate merges on the score.** For example, a CI check fails the merge unless Greptile scores the head commit 5/5: https://github.com/vitali87/code-graph-rag/pull/3558

---

## 4. Summary, diagrams and confidence-score UX

### 4.1 Documented definition (vendor docs, via search extraction)

The score is 0-5, computed from:
- the severity and number of issues found;
- the complexity of the change;
- how well the code fits existing codebase patterns.

| Score | Meaning |
|---|---|
| 5/5 | production ready (merge) |
| 4/5 | minor polish |
| 3/5 | implementation issues |
| 2/5 | significant bugs |
| 0-1/5 | critical problems |

The docs say the weight of a score depends on what the PR touches. The diagram type is chosen by change type (sequence, class or flow), and trivial changes get no diagram. Marketing pages say "a sequence diagram for every PR", which conflicts. Sources: https://www.greptile.com/docs/code-review/first-pr-review, https://www.greptile.com/sequence-diagrams

### 4.2 What the output actually looks like [code: Martian `offline/results/benchmark_data.json`]

The summary comment for Grafana PR 97529, reviewed by `greptile-v4-1` on 2026-04-07, has these sections:

- `<h3>Greptile Summary</h3>`: a paragraph, then bullets per finding with severity and location, e.g. "**P1 (`bleve.go` L96):** Narrowing the lock exposes a pre-existing TOCTOU …".
- `<h3>Confidence Score: 4/5</h3>`: a one-line verdict ("Safe to merge for the eager-init and trace fixes; the lock narrowing … needs the TOCTOU and TotalDocs race addressed before production use"), then a rationale, then the files needing attention.
- `<h3>Important Files Changed</h3>`: a table of filename and a one-line overview per file.
- A diagram in Mermaid. In v5 it is `<h3>Flowchart</h3>` drawn as a *failure scenario*: "Concurrent writer --write between snapshot and watcher--> Search index misses the change". It is emitted twice, once for light and once for dark theme.
- A footer: `Reviews (1): Last reviewed commit: … | Re-trigger Greptile` link.

Inline comments carry:
- a P-badge image;
- a **bold title** ("Same-Key Builds Race", "Watcher Starts After Snapshot");
- 1-2 paragraphs stating the concrete failure scenario;
- often a GitHub ```suggestion``` block with the fix.

Style drift across versions:
- v3 (Jan 2026) summaries were long, with "Key Changes" bullets.
- v5 (Jun 2026) summaries are terse.
- v5's flowcharts illustrate the bug rather than just the PR's control flow.

Diagram frequency on the 50 PRs (heading counts):

| Run | Sequence diagrams | Flowcharts |
|---|---|---|
| v3, Jan 2026 | about 50 | none |
| v4, Mar 2026 | 37 | 13 |
| v4.1, Apr 2026 | 33 | 15 |
| v5, Jun 2026 | 8 | 16 |

Operational noise: in the March 2026 `greptile-v4` run, the benchmark operator had to post `@greptileai` re-triggers 53 times across the 50 PRs, and 16 times in the Jan run. This suggests reviews sometimes failed to start or needed manual triggers.

### 4.3 Comment volume and score distribution [my analysis, same data]

| Greptile run (Martian label, review date) | Inline comments per PR | P0 / P1 / P2 badges | Confidence-score distribution (0-5) |
|---|---|---|---|
| `greptile` (2026-01-22) | 2.38 | none | 0:5, 1:8, 2:13, 3:7, 4:14, 5:4 |
| `greptile-v4` (2026-03-06) | 3.74 | none | 0:2, 1:10, 2:18, 3:18, 4:2 |
| `greptile-v4-1` (2026-04-05/07) | 2.68 | 5 / 80 / 77 | 2:3, 3:10, 4:29, 5:8 |
| `greptile-v5` (2026-06-26/29) | 3.80 | 2 / 131 / 61 | 2:3, 3:2, 4:38, 5:7 |

For comparison, inline comments per PR on the same PRs: CodeRabbit 3.62, Bugbot 2.46, Copilot-v2 5.52, Cubic-v2 3.46, Augment 3.40.

**Observation [inference]:** the score distribution has shifted toward 4/5 over time. v5 gives 4/5 to 76% of PRs that all contain known defects, so the score barely discriminates between them.

---

## 5. Every published benchmark or comparison involving Greptile

| # | Benchmark (publisher, date) | Kind | Data and method | Greptile result | Others | Critique |
|---|---|---|---|---|---|---|
| 1 | **Greptile "AI Code Review Benchmarks"**, July 2025, https://www.greptile.com/benchmarks | vendor | 50 real bug-fix PRs, 10 each from Sentry, Cal.com, Grafana, Keycloak, Discourse. Each bug was re-introduced in a PR on a clean fork, one fork per tool. Default settings, no custom rules. A "catch" required a line-level comment on the faulty code that explains its impact. False positives, style and unrelated comments do not count. | **82%** catch. By severity (from Greptile's comparison pages, via search): critical 58%, high 100%, medium 89%, low 87% | Bugbot 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%. CodeRabbit by severity: 33/36/56/53% (https://www.greptile.com/greptile-vs-coderabbit) | Recall only, with no precision or FP counts, so it rewards volume. The vendor built the dataset, ran it and graded it. One planted bug per PR, while later curation found 137-173 real issues in the same PRs. Many PR titles look LLM-written ("Dual Storage Architecture", "Advanced SQL Analytics Framework") and some "reviewed commit is not in the repo" (golden-file notes), so the bugs are partly synthetic. The severity profile (critical 58% < high 100%) on tiny buckets suggests few items per bucket. |
| 2 | **Augment**, Dec 2025, https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results | vendor (competitor) | Same 50 PRs. Golden comments expanded and corrected by manual review. Precision, recall and F. | **P 45% / R 45% / F 45%** (an Augment product page says 51%) | Augment P 65 / R 55 / F 59 | Competitor-run. Golden expansion was validated "against tool outputs", which can favour the curator's own tool. This dataset became Martian's offline set. |
| 3 | **Macroscope** Code Review Benchmark, 2025 (exact date unverified; summarised on macroscope.com pages through Oct 2026), e.g. https://macroscope.com/content/best-code-review-tools-2026 | vendor (competitor) | 118 self-contained runtime bugs across 45 OSS repos in 8 languages | **23.6%** (17 of **72** bugs: Greptile was scored on a subset) | Macroscope 48.3%, CodeRabbit 45.8%, Bugbot 42.4%, Graphite Diamond 18.3% | Competitor-run. Greptile was evaluated on fewer bugs. Reported as recall-like. |
| 4 | **Martian Code Review Bench, offline**. Open data and code; repo HEAD 2026-08-30. https://github.com/withmartian/code-review-benchmark | independent evaluation (but see critique) | The 50 Greptile/Augment PRs with **173** curated golden comments, labelled by severity and category. Comments are extracted, deduplicated, then matched to goldens by three LLM judges (Opus 4.5, Sonnet 4.5, GPT-5.2). Category profiles Strict/Core/All. Dashboard default is the Core profile, β=2. | **Greptile v4 (run 2026-04-05)**, official dashboard, Core profile: F1 **51.1** (Opus) / **47.5** (Sonnet) / **45.0** (GPT-5.2). Ranks **9th, 8th and 8th of 21**. P 42-51, R 48-51. The v5 run (2026-06-26) is in the evaluations but not on the dashboard. [my analysis] All-category micro F1 for v5 is 0.425 / 0.388 / 0.394 vs v4.1 at 0.524 / 0.485 / 0.465. | Leaders (Core F1, Opus): Qodo-extended-v2 65.8, Cubic-v2 63.6, Augment 62.2, Qodo-v2 58.5, Macroscope 54.2, GitLab 53.0, Devin 51.6, Bugbot 51.4. CodeRabbit 42.2 (P 32.6 / R 59.5). Graphite 14.1 (P 100 / R 7.6). | Built on Greptile's dataset, so it is static and leakage-prone. Martian says so itself. Golden coverage of style nits is sparse (~10), so correct nits count as FPs. LLM judge variance: the top 5 are the same across judges, others move up to about 2 ranks. **[code] The raw `evaluations.json` mixes golden-set versions:** early runs (`greptile` Jan, `greptile-v4` Mar, `copilot` Jan) were scored against 137 goldens, later ones against 173, so raw cross-version numbers are not like-for-like. The dashboard hides the old runs. |
| 5 | **Martian Code Review Bench, online** (continuous; launched about 2026-02-26). https://codereview.withmartian.com, announcement https://x.com/withmartian/status/2027087286773714984 | independent evaluation | Merged public PRs reviewed by bots. An LLM extracts bot suggestions, then the fixes humans made after the review, then matches the two. **Precision** = suggestions matched to post-review fixes ÷ suggestions. **Recall** = matched fixes ÷ all post-review fixes. PRs over 50 commits or 2,000 lines are skipped. | **v0 launch (~2026-02-27):** F1 50.6, P 65.3, R 41.3, 2nd behind CodeRabbit 51.3. **2026-07-30 (Greptile's post):** **#1, F1 60.8 / P 76.2 / R 50.6**, ahead of Codex connector, Cubic, Devin, CodeRabbit 57.5 (https://www.greptile.com/content-library/greptile-martian-code-review-benchmark). **About Oct 2026:** #3 at F1 63.2 behind Cubic 64.0, last-month view (https://www.cubic.dev/blog/greptile-review). Another Oct snapshot: F1 61.9 / P 79.0 vs CodeRabbit 61.8 / P 70.0 (cubic.dev). | Cubic #1 in Oct 2026 per Cubic | Not a controlled comparison: tools run on different repos, and adoption correlates with repo traits (Martian admits this). "Fixed after review" also captures human-reviewer-driven fixes and ignores valid comments that were declined. **Greptile's own learning loop optimises "addressed rate", nearly the same quantity as this precision metric**, so tuning to it is Goodhart-prone [inference]. Rank changes month to month, so "#1" claims go stale (https://www.aicodereviews.io/blog/martians-code-review-bench-the-1-claim-rots-in-months/). |
| 6 | **Cursor "Bugbot now self-improves with learned rules"**, about Apr 2026, https://cursor.com/blog/bugbot-learning | vendor (competitor) | Resolution rate (flagged issues resolved by merge) across public PRs | **63.49%** on 11,419 PRs | Bugbot 78.13% (50,310 PRs), CodeRabbit 48.96% (33,487), Copilot 46.69% (24,336) | Competitor-run. Repo selection and resolution judging are undisclosed. Resolution rate ignores recall. |
| 7 | **Tenki**, run April 2026, blog 2026-05-19. https://tenki.cloud/benchmarks/code-reviewer, https://tenki.cloud/blog/benchmarking-ai-code-reviewers | vendor (competitor) | Same 5 repos and 50 PRs, re-annotated to **122 bugs** (7 critical, 53 high, 52 medium, 10 low). Findings graded by a majority of 3 LLM judges. | **44/122 = 36.1% recall**, F1 22.1. By severity: 5/7 critical, 17/53 high, 19/52 medium, 3/10 low | Tenki 84/122 (68.9% recall, precision ~0.30), CodeRabbit F1 26.7 / R 28.7%, Cursor 39/122 | Competitor-run. Greptile and others were partly replayed. The critical bucket (n=7) is too small, as Tenki admits. |
| 8 | **Kai**, 2026 (after v5). https://kaicontext.com/benchmarks/code-review/ | vendor (competitor) | Martian offline harness, 173 goldens, 3 judges | **Greptile v5 F1: 38.8 (Sonnet) / 42.5 (Opus) / 39.4 (GPT-5.2)** | CodeRabbit 43.5 / 43.8 / 40.6 | These numbers are consistent with my own all-category micro recomputation from Martian's data (0.388 / 0.425 / 0.394), so Kai probably used the same data. Vendor framing. |
| 9 | **Entelligence**, 2025-2026. https://entelligence.ai/benchmark-review, https://entelligence.ai/vs/greptile.com | vendor (competitor) | 6 bots, 5 repos, 132 golden comments. A separate 67-golden head-to-head. | 67-golden test: **P 30.7%, 31/67 found**. 132-golden Greptile figures not visible. | Entelligence F1 0.705 (its own claim) | The report says ambiguous 50/50 cases "favoured Entelligence". |
| 10 | **MorphLLM comparisons**, about Mar 2026. https://www.morphllm.com/comparisons/greptile-vs-cursor-review, https://www.morphllm.com/comparisons/greptile-vs-copilot | third party (method unclear) | Not visible | P 66.2%, R 40.4%, F1 50.2 | Bugbot F1 48.3 (P 68.9); CodeRabbit P 50.5 / R 52.5 | Probably a Martian online snapshot, unconfirmed. |
| 11 | **dev.to "_vjk": 4 reviewers in parallel for 3 weeks**, about May 2026. https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f | independent (single team) | 146 merged PRs, 446 review events, 679 findings. CodeRabbit, Sentry Seer, Greptile, Bugbot. | **120 findings on 55 PRs = 2.2 per PR**, the lowest density. The author judged Greptile best on precision and signal density. | — | One team's codebase. Judgment is the author's own. The page was not fetched (dev.to blocked); numbers via search extraction. |
| 12 | **CodePulse** recall test, 2026. https://codepulsehq.com/guides/ai-code-review-bots-2026 | vendor | "Real defects" set | **34.0%** recall, #1 | Bugbot 28.2%, CodeRabbit 23.7% | Vendor. Method not visible. |
| 13 | Widely repeated "**Greptile 11 FPs vs CodeRabbit 2 on 50 PRs**" | untraceable | — | — | — | Particula (https://particula.tech/blog/greptile-vs-coderabbit-vs-qodo-ai-code-review-2026) found no primary source. **Do not cite.** |

**Peer-reviewed and preprint research touching AI reviewers.** None isolates Greptile.
- **arXiv 2604.03196**, "From Industry Claims to Empirical Reality", Apr 2026, https://arxiv.org/abs/2604.03196
  - Data: 3,109 PRs from AIDev.
  - 12 of 13 code-review agents have average signal ratio below 60%. 60.2% of closed CRA-only PRs fall in the 0-30% signal band.
  - It cites Greptile's v3 claims as an industry claim.
- **arXiv 2607.21997**, "Go Home Copilot, You're Drunk", Jul 2026, https://arxiv.org/abs/2607.21997v2
  - Data: about 54.7k agent review comments (Copilot, Cursor, Codex, and Devin/Claude in v2) across about 341 Python repos.
  - **Inline code suggestions are the strongest predictor of resolution. Long, complex comments are less likely to be acted on.**
  - Relevant to Greptile's suggestion blocks and terser v5 style.
- **arXiv 2608.21311**, "AI-to-AI Code Reviews of GitHub PRs", ESEM 2026, https://arxiv.org/abs/2608.21311
  - Data: 248,641 AI-authored PRs with AI reviews.
  - A reviewer's comment mix varies with which agent wrote the PR.
- **ai-review-churn**, GitHub, 2026, https://github.com/abhaymettu/ai-review-churn
  - 90.4% of AI-reviewed PRs get no human inline review.
  - Bot threads are resolved 42.9% of the time alone vs 74.4% alongside a human.
  - Independent, but not peer-reviewed.

---

## 6. My independent re-analysis of Martian offline data [my analysis / code]

Data: `offline/results/{judge}/evaluations.json` and `offline/results/benchmark_data.json` at repo HEAD `e616e84` (2026-08-30). Method and caveats are in Appendix A.

### 6.1 Precision by Greptile's own severity badge

Each judged candidate was mapped to the inline comment it came from by token overlap of at least 0.5. Unmatched candidates are summary-only or fuzzy.

| Run | Judge | P0 precision | P1 precision | P2 precision | Summary/unmatched |
|---|---|---|---|---|---|
| v4.1 (Apr 2026) | Opus 4.5 | 5/5 = 1.00 | 52/72 = **0.72** | 23/63 = **0.37** | 9/27 = 0.33 |
| v4.1 | Sonnet 4.5 | 5/5 | 48/76 = 0.63 | 22/63 = 0.35 | 8/25 |
| v4.1 | GPT-5.2 | 5/5 | 50/84 = 0.60 | 20/61 = 0.33 | 9/38 |
| v5 (Jun 2026) | Opus 4.5 | 2/2 | 52/130 = **0.40** | 21/58 = **0.36** | 3/4 |
| v5 | Sonnet 4.5 | 2/2 | 51/136 = 0.38 | 18/61 = 0.30 | 2/4 |
| v5 | GPT-5.2 | 2/2 | 51/138 = 0.37 | 19/64 = 0.30 | 4/9 |

**Reading:**
- In v4.1, severity gating was a strong precision lever. Showing only P0 and P1, which is roughly what strictness=3 does, would raise precision from about 0.45-0.53 to **0.62-0.74** (Opus 57/77, Sonnet 53/81, GPT-5.2 55/89). It would keep about 64% of true positives (57 of 89 under Opus).
- In v5, P1 inflation (131 P1 vs 80) erased that separation: P1 is barely more precise than P2.
- Absolute precision is understated because the golden set is incomplete. Relative differences between badges are more trustworthy.

### 6.2 Is the confidence score informative?

Mean number of High or Critical golden issues per PR, grouped by the score Greptile gave (Opus judge; the other judges are similar):
- **v4.1:** score 2 → 1.00 (n=3); score 3 → 1.80 (n=10); score 4 → 1.34 (n=29); score 5 → 0.75 (n=8).
- **v5:** score 2 → 2.67 (n=3); score 3 → 0.50 (n=2); score 4 → 1.34 (n=38); score 5 → 0.86 (n=7).

The signal is weakly directional: 5/5 PRs have fewer serious goldens. It is not monotone and the groups are tiny.

**5/5 PRs that still contained a missed High or Critical golden issue:**

| Run | Opus judge | GPT-5.2 judge |
|---|---|---|
| v3, Jan 2026 | 2 of 4 | 2 of 4 |
| v4.1 | 3 of 8 | 4 of 8 |
| v5 | 3 of 7 | 2 of 7 |

Examples from v5:
- sentry#80528: config display values are computed but the original is returned;
- grafana#94942: DB methods return errors silently;
- grafana#76186: middleware panics on a nil value.

**Implication [inference]:** a 5/5 score does not certify "bug-free". Auto-approve on 5/5 needs a strict risk cap and path exclusions.

### 6.3 Recall by golden severity (Opus judge; Critical / High / Medium / Low)

- Greptile v4.1: **67% / 56% / 51% / 43%**
- Greptile v5: **50% / 70% / 41% / 20%**
- CodeRabbit: 67 / 63 / 66 / 46
- Bugbot: 58 / 61 / 41 / 28
- Copilot-v2: 75 / 70 / 72 / 52
- Augment: 67 / 76 / 67 / 39
- Cubic-v2: 83 / 70 / 62 / 48
- Graphite: 8 / 9 / 8 / 2

**Reading:**
- v5 trades low and medium recall for high-severity recall. That fits a "hypothesis per suspected bug" design and P1 inflation.
- None of this matches the "100% of high-severity bugs" from Greptile's own 2025 benchmark. The metric differs (all golden issues vs one planted bug per PR), and the golden set is larger.

### 6.4 Offline vs online divergence

- On the dataset Greptile itself created, Greptile now ranks mid-pack offline: 8th-9th of 21.
- Online it reached #1, at 2026-07-30, mostly on precision (76-80%).
- Either:
  - the offline golden set misses many of Greptile's valid findings; or
  - Greptile's in-the-wild precision is helped by per-team learning and tuned strictness (absent offline) and by self-selection of repos; or
  - both. [inference]

Martian's stated plan is to calibrate offline against online, which is exactly this gap.

---

## 7. Methodology critique: a checklist for any Greptile-related number

1. **Metric mismatch.**
   - Catch rate (Greptile 2025), F1 (Martian, Augment, Kai), resolution or addressed rate (Cursor, Greptile internal) and recall-only (Macroscope, CodePulse) are not comparable.
   - The same tool spans 23.6% to 82% purely through metric and dataset choice.
2. **Who builds and grades.** Greptile, Augment, Macroscope, Tenki, Kai, Entelligence, CodePulse and Cursor all publish benchmarks their own product wins or places well in. Only Martian is product-neutral, and its offline data descends from Greptile and Augment.
3. **Dataset construction.**
   - The 50-PR set re-injects historical bugs into forks with partly synthetic PR titles, so it is not organic review traffic.
   - It is also public, so leakage is possible.
   - Golden sets keep growing (50 → 132-137 → 173), so older numbers become obsolete.
4. **Defaults vs tuned.** All benchmarks run defaults with no rules or learning. Greptile's value proposition is per-team adaptation over 2-3 weeks, which no offline benchmark measures. The online benchmark captures it, but uncontrolled.
5. **LLM judges and "addressed" detection.**
   - Martian's judge variance is about ±2 ranks.
   - Greptile's addressed-rate claims also rely on an LLM judge, with no published prompt or validation.
6. **Precision denominators.** Incomplete golden sets penalise valid findings as false positives, since tools that find real unlabelled issues look noisy. Online precision penalises valid-but-declined comments.
7. **Version churn.** Greptile shipped v3, v4, v4.x, v5 and tiers within 12 months, and Martian results exist for four builds. Always cite the version and run date.

---

## 8. Implications for Vectorscope [inference]

- **Copy the severity gate, then measure its calibration.**
  - Emit P0/P1/P2 with an explicit rubric (Greptile's docs give one).
  - Make strictness a threshold over severity, not a prompt tweak.
  - Track precision per severity level on a labelled set. v4.1→v5 shows how inflating severity silently destroys the gate.
- **Do not rely on LLM self-rated severity alone.** Greptile's Dec 2024 finding was that LLMs are bad severity evaluators. Combine severity with:
  - verification: a hypothesis-check agent, or execution;
  - learned per-team suppression keyed on embeddings of past ignored or downvoted comments, partitioned per team or repo;
  - a never-suppress list for security, data loss, crashes and concurrency.
- **Prefer behavioral signals over emoji.** Use addressed-in-later-commit (define it precisely: a first-vs-last-commit diff touching the flagged lines), replies with reasons, and human-reviewer comments on bugs the bot missed (a recall signal, as in Cursor's design). Thumbs up/down are a supplement.
- **Rules from past comments:** mine repeated human review comments into SUGGESTED rules after about N PRs, require admin approval, dedupe against existing rules, and show rule-usage stats.
- **Confidence score:**
  - Ship one only if it is calibrated. Report it alongside "what would lower this score".
  - Gate any auto-approve on path or risk exclusions (auth, secrets, billing, migrations, infra, CI, public APIs) and a conservative cap.
  - Measure on a known-bug set how often a top score coincides with a missed High or Critical issue. Greptile v4.1 and v5 show 3 of 7-8.
- **Summary UX that is supported by evidence:**
  - a severity-sorted findings list linking to inline comments;
  - a one-line verdict;
  - a per-file overview table;
  - diagrams only when non-trivial; v5's "failure-scenario flowchart" is a neat idea;
  - **inline suggestion blocks**, the strongest predictor of resolution per arXiv 2607.21997;
  - short comments, since long ones are resolved less often.
- **Model inversion:** when the PR author is an agent from vendor X, review with a different model family. Cheap to try. The evidence is vendor-only and experimental.
- **Benchmarking Vectorscope:**
  - Run the open Martian offline harness on all three judges and report Strict/Core/All plus F1 and F2.
  - Report precision by severity and the confidence-score calibration from Section 6. This needs no new data.
  - Add an online-style addressed-rate metric on Vectorscope's own traffic with a published judge prompt.
  - Never headline a single "#1".

---

## Open questions (could not resolve with greptile.com blocked)

- Exact text of greptile.com/benchmarks: the per-tool severity table, and whether any FP data appears.
- The published v5 blog date (search says 2026-08-05) vs Martian's `greptile-v5` run on 2026-06-26: was that a pre-release?
- How Greptile's LLM-judged "addressed" is defined and validated. Is it the same cohort for the 43% (v4 launch) and 52% (v5 baseline) figures?
- Whether the embedding nit-filter (2024) still runs under v4 and v5, or was replaced by agentic validation plus learned rules.
- The Auto tier's risk model: inputs, scale, and whether it is exposed anywhere.
- Current Martian online standing: the live leaderboard was not fetchable.
- Whether the auto-approve exclusions are hard-coded (changelog) or risk-assessed (docs).

---

## Appendix A: reproduction of my analysis

1. Clone the benchmark repo: `git clone --depth 1 https://github.com/withmartian/code-review-benchmark` (HEAD `e616e849755441da38f18bf3adba2c9583b03803`, 2026-08-30).
2. Micro P/R/F1: for each judge in `offline/results/*/evaluations.json`, sum `tp`, `fp` and `fn` per tool over the 50 PRs, then P = tp/(tp+fp), R = tp/(tp+fn), F1 = harmonic mean. This is the "All categories, no profile" view.
3. Official numbers come from `offline/analysis/benchmark_dashboard.json`, under `models[judge].overall_metrics[tool].core`.
4. Badge precision:
   1. For each Greptile inline comment in `benchmark_data.json`, read the badge with the regex `alt="(P[0-9])"`.
   2. Tokenise each judged TP (`matched_candidate`) and FP (`candidate`) text with `[a-z0-9_]{3,}`.
   3. Assign it to the inline comment with the highest |overlap| / |candidate tokens|, if that is at least 0.5. Otherwise mark it "summary/unmatched".
5. Confidence score: the last `Confidence Score: (\d)/5` match in the PR's Greptile comments.
6. Caveats:
   - fuzzy matching can misattribute candidates;
   - the golden set is incomplete, so absolute precision is understated;
   - n = 50 PRs;
   - old runs (`greptile`, `greptile-v4`, `copilot`) were judged against 137 goldens, not 173.

## Appendix B: source list with dates and labels

**Greptile (vendor):**
- benchmarks page (July 2025): https://www.greptile.com/benchmarks
- vs CodeRabbit: https://www.greptile.com/greptile-vs-coderabbit
- vs Bugbot: https://www.greptile.com/greptile-vs-bugbot
- "How to Make LLMs Shut Up" (Dec 2024): https://www.greptile.com/blog/make-llms-shut-up
- v3 (about Sep-Nov 2025): https://www.greptile.com/blog/greptile-v3-agentic-code-review
- v4 (about 2026-03-05): https://www.greptile.com/blog/greptile-v4
- v5 (about 2026-08-05): https://www.greptile.com/blog/greptile-v5
- Plus/Apex (2026-09-25): https://www.greptile.com/blog/introducing-plus-and-apex
- model inversion (about 2026-07-21): https://www.greptile.com/blog/model-inversion
- AI code review bubble (Jan 2026): https://www.greptile.com/blog/ai-code-review-bubble
- Martian #1 post (snapshot 2026-07-30): https://www.greptile.com/content-library/greptile-martian-code-review-benchmark
- changelog (living): https://www.greptile.com/changelog
- docs (living, read 2026-11-05):
  - first-pr-review
  - greptile-json-reference
  - greptile-config
  - greptile-config-reference
  - controlling-nitpickiness
  - quickstart
  - how-greptile-works/nitpicks
  - how-greptile-works/memory-and-learning
  - how-greptile-works/graph-based-codebase-context
  - training-the-learning-system
  - developer-essentials
  - custom-standards
  - code-review-bot/custom-context
  - mcp-v2/custom-context
  - mcp-v2/auto-fix
  - auto-approve-prs
  - review-tiers
  - analytics
  - trex/overview
- Daksh Gupta on X, preventative security (about Apr 2026): https://x.com/dakshgup/status/2043774671259349019
- Anthropic customer story (vendor/partner): https://claude.com/customers/greptile

**Independent or open:**
- Martian repo (HEAD 2026-08-30): https://github.com/withmartian/code-review-benchmark (files read: `README.md`, `offline/README.md`, `methodology/summary.md`, `online/README.md`, `online/etl/llm/prompts.py`, results JSON)
- Martian v0 announcement (about 2026-02-26): https://x.com/withmartian/status/2027087286773714984
- aicodereviews.io critique (2026): https://www.aicodereviews.io/blog/martians-code-review-bench-the-1-claim-rots-in-months/
- dev.to 146-PR test (about May 2026): https://dev.to/_vjk/best-ai-code-reviewer-in-2026-we-ran-4-in-parallel-for-3-weeks-146-prs-679-findings-1c0f
- HN threads (Dec 2024): https://news.ycombinator.com/item?id=42465374, https://news.ycombinator.com/item?id=42451968
- Particula (2026): https://particula.tech/blog/greptile-vs-coderabbit-vs-qodo-ai-code-review-2026
- ai-review-churn: https://github.com/abhaymettu/ai-review-churn

**Competitor (vendor):**
- Augment (Dec 2025): https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results
- Macroscope (2025, pages through Oct 2026): https://macroscope.com/content/best-code-review-tools-2026, https://macroscope.com/content/greptile-vs-coderabbit-2026, https://macroscope.com/content/best-greptile-alternatives-ai-code-review
- Cursor (about Apr 2026): https://cursor.com/blog/bugbot-learning
- Tenki (2026-05-19): https://tenki.cloud/benchmarks/code-reviewer, https://tenki.cloud/blog/benchmarking-ai-code-reviewers
- Kai (2026): https://kaicontext.com/benchmarks/code-review/
- Entelligence: https://entelligence.ai/benchmark-review, https://entelligence.ai/vs/greptile.com
- Cubic (checked about 2026-10-10): https://www.cubic.dev/blog/greptile-review
- CodeRabbit (about Nov 2025): https://coderabbit.ai/blog/why-emojis-suck-for-reinforcement-learning
- QA.tech: https://qa.tech/compare/greptile-alternatives
- CodePulse: https://codepulsehq.com/guides/ai-code-review-bots-2026
- MorphLLM (about Mar 2026): https://www.morphllm.com/comparisons/greptile-vs-cursor-review

**Research (preprints):**
- arXiv 2604.03196 (Apr 2026)
- arXiv 2607.21997 (Jul 2026), with replication package https://zenodo.org/records/19247232
- arXiv 2608.21311 (Aug 2026, ESEM 2026)
