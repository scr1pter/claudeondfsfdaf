# AI code review landscape and techniques that demonstrably work

Research date: 2026-11-05. Compiled for Vectorscope.

## 0. How this was researched (read first)

- **Primary sources read in full.** These are public GitHub repositories cloned at the commits listed. Every claim marked `code` comes from reading them.
  - PR-Agent: `github.com/qodo-ai/pr-agent`, now the community org `The-PR-Agent/pr-agent`, commit 8f6be9d, 2026-11-05.
  - Martian Code Review Bench: `github.com/withmartian/code-review-benchmark`, commit e616e84, 2026-08-30, including its raw per-PR judge outputs.
  - Kodus: `github.com/kodustech/kodus-ai`, commit 2ee5d32, 2026-11-05, including its eval targets.
  - GitHub's own docs repo: `github.com/github/docs`, commit 17d6ee5, 2026-11-05, Copilot code review pages.
  - Bito: `github.com/gitbito/CodeReviewAgent`, commit 040bbc8, 2025-11-13.
  - Sourcery: `github.com/sourcery-ai/sourcery`, commit 2205e06, 2026-09-17.
- **Limits of the session.**
  - WebFetch could not reach `cursor.com` or `coderabbit.ai` (the hosts are outside this session's network allowlist). Per the environment's rule I stopped trying further hosts.
  - The shared WebSearch budget for the turn ran out partway through. No searches were done for Sourcery internals, Bito's current docs, Greptile's own claims, Augment, Cubic, or the July 2025 Bugbot GA post.
  - Items marked "search summary" come from the search tool's synthesis of the page, not a full read. They should be re-verified once `cursor.com`, `coderabbit.ai`, `graphite.com`, `qodo.ai`, `baz.co`, `ellipsis.dev`, `macroscope.com` and `arxiv.org` are allowed.
- **Labels.**
  - **vendor claim**: the company's own statement or metric.
  - **independent evaluation**: a third party that runs tools itself.
  - **research**: peer-reviewed paper or preprint.
  - **code**: read directly in source.
  - **inference**: my own reasoning.
  - Research items marked "(recalled)" come from background knowledge and were not re-fetched this session. Verify them before quoting.

---

## 1. Independent evidence: Martian Code Review Bench (the only cross-vendor, reproducible dataset found)

**Source:** github.com/withmartian/code-review-benchmark, commit e616e84 (2026-08-30). The README and methodology summary are by Martian, which says it is "funded independently of the code review market". Label: **independent evaluation**.

**Offline design.**
- 50 PRs from Sentry (Python), Grafana (Go), Cal.com (TypeScript), Discourse (Ruby) and Keycloak (Java).
- 173 human-verified "golden comments", each with a severity and a category. An earlier version had 137.
- It builds on Greptile's July 2025 dataset and Augment's December 2025 expansion.
- Scoring pipeline:
  - Extract candidate issues from each tool's comments.
  - Group duplicates with an LLM, so a tool that posts the same issue inline and in a summary is not penalised twice.
  - An LLM judge decides whether a candidate and a golden comment "describe the same underlying issue".
  - Three judges were used: Claude Opus 4.5, GPT-5.2 and Claude Sonnet 4.5. "the top 5 tools are identical across all three judges".
- Scoring profiles:
  - Strict: bug, security, concurrency, data, api (139 goldens).
  - Core: Strict plus perf, test_gap, doc_defect (158).
  - All: Core plus style, speculative (173).
  - F-beta weights range from 0.5 to 3.
- Known limits it states itself:
  - Training-data leakage.
  - Sparse style goldens (about 10).
  - A real bug that is missing from the gold set counts as a false positive.

**Online benchmark.**
- Samples fresh merged GitHub PRs where review bots commented.
- An LLM extracts (a) each bot suggestion and (b) what the developer actually fixed after review, then matches the two.
- Precision is the share of suggestions matched to a real fix. Recall is the share of fixes the bot had flagged.
- I did not get the online dashboard numbers. The site codereview.withmartian.com was not fetched.

**My aggregation of their published raw judge outputs.**
- Source files: `offline/results/<judge>/evaluations.json`.
- These are micro-averaged totals over all 50 PRs: all categories, with dedup already applied in the file. They are not the dashboard's default Core profile. Label: **independent evaluation** (data), aggregation is mine.
- Only rows judged against the 173-golden set are shown, so they are comparable. Review date is the date in the forked-repo name.

| Tool (run) | Review date | Opus 4.5 judge P / R / F1 | GPT-5.2 judge P / R / F1 | Sonnet 4.5 judge P / R / F1 |
|---|---|---|---|---|
| qodo-extended-v2 | 2026-03-29 | 0.68 / 0.61 / 0.64 | 0.59 / 0.55 / 0.57 | 0.57 / 0.53 / 0.55 |
| cubic-v2 | 2026-03-13 | 0.62 / 0.62 / 0.62 | 0.58 / 0.58 / 0.58 | 0.57 / 0.57 / 0.57 |
| augment | 2026-01-22 | 0.61 / 0.62 / 0.62 | 0.51 / 0.58 / 0.54 | 0.54 / 0.59 / 0.56 |
| qodo-v2 | 2026-02-27 | 0.56 / 0.59 / 0.58 | 0.47 / 0.60 / 0.53 | 0.48 / 0.53 / 0.50 |
| gitlab (Duo) | 2026-04-23 | 0.56 / 0.53 / 0.54 | 0.47 / 0.47 / 0.47 | 0.50 / 0.48 / 0.49 |
| macroscope | 2026-03-09 | 0.62 / 0.47 / 0.53 | 0.50 / 0.39 / 0.44 | 0.53 / 0.40 / 0.46 |
| greptile-v4-1 | 2026-04-05 | 0.53 / 0.51 / 0.52 | 0.45 / 0.49 / 0.47 | 0.49 / 0.48 / 0.49 |
| gemini-v2 | 2026-04-22 | 0.47 / 0.55 / 0.51 | 0.40 / 0.51 / 0.45 | 0.41 / 0.50 / 0.45 |
| bugbot (Cursor) | 2026-01-22 | 0.58 / 0.45 / 0.51 | 0.53 / 0.43 / 0.48 | 0.55 / 0.42 / 0.48 |
| copilot-v2 | 2026-06-24 | 0.41 / 0.66 / 0.50 | 0.35 / 0.63 / 0.45 | 0.36 / 0.61 / 0.45 |
| devin | 2026-03-02 | 0.70 / 0.39 / 0.50 | 0.59 / 0.39 / 0.47 | 0.68 / 0.40 / 0.50 |
| claude-code | 2026-03-10 | 0.49 / 0.49 / 0.49 | 0.42 / 0.41 / 0.42 | 0.38 / 0.40 / 0.39 |
| sourcery | 2026-03-07 | 0.43 / 0.55 / 0.48 | 0.38 / 0.50 / 0.43 | 0.39 / 0.48 / 0.43 |
| baz | 2026-01-22 | 0.63 / 0.36 / 0.46 | 0.46 / 0.32 / 0.38 | 0.57 / 0.34 / 0.42 |
| kodus-v2 | 2026-03-12 | 0.60 / 0.36 / 0.45 | 0.54 / 0.33 / 0.41 | 0.58 / 0.34 / 0.43 |
| coderabbit | 2026-01-22 | 0.35 / 0.60 / 0.44 | 0.31 / 0.60 / 0.41 | 0.35 / 0.57 / 0.43 |
| greptile-v5 | 2026-06-26 | 0.40 / 0.45 / 0.43 | 0.36 / 0.44 / 0.39 | 0.36 / 0.42 / 0.39 |
| claude (app) | 2026-01-27 | 0.46 / 0.38 / 0.42 | 0.41 / 0.38 / 0.39 | 0.41 / 0.36 / 0.38 |
| codeant-v2 | 2026-03-25 | 0.41 / 0.39 / 0.40 | 0.31 / 0.34 / 0.32 | 0.33 / 0.33 / 0.33 |
| graphite | 2026-01-23 | 1.00 / 0.07 / 0.13 (12 TP, 0 FP) | 0.73 / 0.06 / 0.12 | 1.00 / 0.07 / 0.13 |

**Notes and caveats on this table.**
- Absolute numbers move by about 0.05–0.10 depending on the judge. Rankings are fairly stable. **inference**
- Runs scored against the older 137-golden set are left out because they are not comparable. They include copilot v1 (2026-01-22), cubic-dev, greptile (2026-01-22), greptile-v4, qodo (2026-01), propel, mergemonkey, gitar, kodus v1, codeant v1, mesa, entelligence and linearb.
- Copilot v1 (Jan 2026, 137 set, Opus judge) scored P 0.28 and R 0.53. copilot-v2 (Jun 2026, 173 set) scored P 0.41 and R 0.66. The rise is real in direction, but the golden-set change confounds the comparison.
- Bito's run produced 0 candidates on all 50 PRs. That is probably an install or run failure, so it is not evaluable here.
- Graphite (Jan 2026) posted almost nothing: 12 true positives and 0 false positives across 50 PRs. It shows an extreme precision-first gating policy.

**What the table says.**
- No tool exceeds about 0.65 F1, even with the friendliest judge.
- The best systems sit near P ≈ R ≈ 0.6.
- The others are clearly tilted one way:
  - Recall-heavy: CodeRabbit, Copilot-v2, cubic-dev (P 0.30 / R 0.76 on the 137 set).
  - Precision-heavy: Devin, Baz, Kodus-v2, Graphite.
- **inference**

Critique of vendor benchmarks: DeepSource, "Every AI code review vendor benchmarks itself, and wins" (deepsource.com/blog/ai-code-review-benchmarks, 2026, exact date unknown; search summary). Martian's methodology makes the same point and notes that injected-bug benchmarks may not match the distribution of real bugs. **independent commentary**

---

## 2. Vendor-by-vendor

### 2.1 PR-Agent (open source) and Qodo Merge / Qodo 2.0

**Status.** The README says PR-Agent is now "a community-maintained legacy project of Qodo… distinct from Qodo's primary AI code review offering". It moved to the `The-PR-Agent` org, with Docker images under `pragent/pr-agent` from 0.34.2. Source: README, commit 8f6be9d, 2026-11-05. **code**

**Pipeline shape (`/improve`, the code-suggestion tool).** Files: `pr_agent/tools/pr_code_suggestions.py`, `settings/code_suggestions/*.toml`, `settings/configuration.toml`. **code**

1. **Diff packing.** Source: `docs/docs/core-abilities/compression_strategy.md`.
   - Binary and non-code files are excluded.
   - Files are sorted by the repo's main languages, then by token count within each language.
   - For large PRs, deletion-only hunks are dropped and deleted files are folded into a list.
   - Patches are added with tiktoken until a buffer before the max is reached. Remaining files are listed as "other modified files" without their patches.
2. **Context per hunk: asymmetric and dynamic.** Source: `dynamic_context.md`.
   - Context before a change matters more than context after: `patch_extra_lines_before=5`, `patch_extra_lines_after=1`, on top of git's default 3.
   - The context window extends up to `max_extra_lines_before_dynamic_context=10` lines to reach the enclosing function or class.
   - The stated rationale is to avoid "needle-in-the-haystack" degradation from too much context.
3. **Chunked generation.**
   - Large PRs are split into chunks of up to `max_model_tokens` (default 32k).
   - `max_number_of_calls=3` chunks run with `parallel_calls=true`.
   - Each chunk gets `num_code_suggestions_per_chunk=3`.
   - A failed chunk is retried on `fallback_models`.
4. **Generation prompt.** The default is `focus_only_on_problems=true`.
   - "Only give suggestions that address critical problems and bugs", and return an empty list if none.
   - Explicit bans: changing package versions, adding unrelated imports, declaring undefined or removing unused variables, using more specific exception types, repeating changes already made in the PR.
   - "Be aware that your input consists only of partial code segments… refrain from questioning code elements… that may be defined elsewhere".
   - "Do not invent identifiers…"
   - Commit messages and CI artifacts are marked as untrusted, as prompt-injection hygiene.
5. **Deterministic post-filters.** Function `_prepare_pr_code_suggestions` drops a suggestion when:
   - required keys are missing;
   - it is a duplicate (same one-sentence summary in the same file);
   - it matches a regex for "use const instead of let";
   - `existing_code` or `improved_code` is missing.
   - A "critical" label is softened to "possible issue".
6. **Self-reflection, a second LLM call.** Prompt: `pr_code_suggestions_reflect_prompts.toml`.
   - All suggestions are presented together with the diff. The model scores each 0–10 with a "why", and also re-derives line numbers.
   - The rubric gives 0 for: wrong suggestions; `improved_code` that does not reflect the claim; ignoring parts of the PR; docstrings, type hints or comments; unused imports; more specific exception types; "questions the definition… of any entity… that might be done in the outer codebase".
   - Caps: "verify/ensure" suggestions at 7 or below; error-handling or type-checking suggestions at 8 or below.
   - Score 0 is dropped and the threshold `suggestions_score_threshold` defaults to 1.
   - If reflection fails or returns the wrong count, every suggestion gets `score_on_reflection_failure=7`. That is fail-open, and operators can set it below the threshold to fail closed.
   - Reflection alone is retried on the next fallback model.
   - Docs rationale: "models often struggle to simultaneously generate high-quality code suggestions and rank them well in a single pass", and "presenting all generated suggestions simultaneously provides the model with a comprehensive context… compared to evaluating each suggestion individually".
7. **Grounding checks.**
   - `_validate_suggestion`: the `existing_code` must match the file's lines at the anchored range exactly, after dedent and trailing-space normalisation, or the suggestion is rejected or not committed.
   - `_validate_python_replacement_syntax`: compiles the file with the replacement applied for `.py` files and rejects one that breaks compilation.
   - `validate_one_liner_suggestion_not_repeating_code` also applies.
   - When `existing_code == improved_code`, the code half is cleared.
8. **Output shaping.**
   - `new_score_mechanism` with high ≥ 9 and medium ≥ 7.
   - Optional `max_suggestions_per_file`.
   - Hierarchical, collapsible presentation. The docs say users spend about 5–10 s per item.

**`/review` tool.** Prompt `pr_reviewer_prompts.toml`, merge logic `algo/review_merge.py`. **code**
- `num_max_findings=3` by default.
- Prompt rules include:
  - "Do not speculate that a change might break other code unless you can identify the specific affected code path."
  - "Do not flag intentional design choices or stylistic preferences."
  - "Communicate severity accurately."
  - Failure-mode fields must not "claim a test was executed".
- Optional large-diff chunking (`enable_large_pr_chunking`) merges chunk outputs as follows:
  - Findings are unioned, deduped and cut back to `max_findings`.
  - Whole-PR judgements (score, risk, merge recommendation, effort) take the most conservative chunk value.
  - Time estimates are summed.

**Cross-run memory and "learning".** **code**
- `persistent_finding_state=true` stores findings in a hidden HTML-comment state blob, in `algo/review_finding_state.py`.
- Earlier findings are fed back with a budget of `max_previous_findings_chars=8000`, so the model "keeps their wording instead of re-raising them reworded".
- Findings whose inline thread a human resolved are skipped.
- A "dismissed" finding (won't fix or by design) must not be reported again "unless the current code makes it worse".
- `algo/inline_comment_dedup.py` gives cross-run inline-comment dedup. It fingerprints each comment with SHA-256 over (file, anchor line, normalised body) OR (file, line, the suggestion code block). It catches "same prose, different code" and "same code, different prose" re-emissions.

**Other context.**
- `repo_context_files`, for example `AGENTS.md` or `best_practices.md`. `@import` is followed up to 4 hops, like CLAUDE.md.
- Bounded sibling-repo fetches.
- Agent Skills (`SKILL.md`), text only, because PR-Agent "runs single-shot model calls with no tool-use loop".
- A deterministic "structural reach" risk row computed from a build-graph JSON, with no model call.
- `model_routing` sends small PRs (by hunks, files or characters) to a cheaper model.
- **code**

**Key architectural fact.** PR-Agent is single-shot with no agent tool loop. Docs `agent_skills.md`, 2026-11-05. It is the clearest open baseline for the "diff plus heuristics plus self-reflection" generation of tools. **code**

**Qodo 2.0 (commercial), launched 2026-02-04.** Sources: qodo.ai/blog/introducing-qodo-2-0 and GlobeNewswire 2026-02-04 (search summary).
- Architecture: a multi-agent review in which "a judge agent evaluates findings across agents, resolves conflicts, removes duplicates, and filters out low-signal results", plus a recall-optimised "exhaustive/extended" mode. **vendor claim**
- Qodo's own benchmark (qodo.ai/ai-code-review-benchmark):
  - 100 merged PRs from 8 repos in 7 languages, with 580 human-validated injected issues (functional bugs, edge cases, races, resource leaks, error handling, repo best-practice violations).
  - Reported F1 60.1% and recall 56.7%, "9% ahead of next best"; the press release says 11%.
  - **vendor claim.** The ground truth is not published (DeepSource critique, search summary).
- Independent cross-check: in Martian's table above, qodo-extended-v2 (2026-03-29) is #1 under the Opus judge (F1 0.64) and #1–#3 under the other judges. This is the strongest independent support any vendor's "multi-agent plus judge" claim has. **independent evaluation**

### 2.2 Cursor Bugbot (Cursor also acquired Graphite, 2025-12-19)

Sources:
- Cursor blog "Building a better Bugbot", Jan 2026. URL cursor.com/blog/building-bugbot; Cursor forum mirror forum.cursor.com/t/building-a-better-bugbot/149040.
- "Bugbot now self-improves with learned rules", cursor.com/blog/bugbot-learning.
- Changelog cursor.com/changelog/04-08-26 (2026-04-08).

All Cursor items are from search summaries; the fetch was blocked.

- **v1 pipeline.**
  - Eight parallel bug-finding passes over the same diff with randomised or shuffled file order.
  - Majority voting: only bugs that recur across passes are kept, to suppress spurious findings.
  - **vendor claim** (search summary).
- **Shift to agentic, fall 2025.** The agent decides which files to explore, which tools to call and when to fetch more context. Cursor calls this "the biggest single improvement". It also found the agent "too cautious" and moved to aggressive prompts that make it investigate every suspicious pattern. **vendor claim**
- **Metric: resolution rate.**
  - Definition: the share of Bugbot-flagged bugs that the author fixes before merge. At merge time an AI judge checks the final diff, and a fix done differently from Bugbot's suggestion still counts.
  - About 40 major experiments and 11 shipped versions took the rate from 52% to over 70%.
  - Bugs found per run went from 0.4 to 0.7.
  - **vendor claim** (Jan 2026). Cursor does not publish precision, recall or false-positive rate (secondary critique, search summary).
- **Learned rules (2026-04-08).**
  - Each review is a "natural experiment".
  - Candidate rules are mined from reactions and replies to Bugbot comments and from human reviewers' comments.
  - Rules that accumulate signal are promoted, and rules that stop being useful are disabled.
  - Backfill over recent PRs is available.
  - More than 110,000 repos enabled it, generating more than 44,000 rules.
  - Resolution rate 78%, or "78.13% across 50,310 PRs on public repos".
  - **vendor claim**
- A secondary report puts the rate at 80% at default effort in a 2026-05-11 changelog. **unverified**
- Independent result: bugbot (2026-01-22) on Martian scored P 0.58 / R 0.45 / F1 0.51 (Opus judge). That is precision-leaning and mid-pack on recall. **independent evaluation**

### 2.3 Graphite Diamond / Graphite Agent

- **Product.** Stacked PRs, a merge queue and an AI reviewer called Diamond. Cursor signed an agreement to acquire Graphite on 2025-12-19, at a price "well above" its $290M valuation (Axios, 2025-12-19). Graphite "will continue to operate independently". **vendor claim / press**
- **Metrics.**
  - Graphite blog "How Graphite uses Claude" (graphite.com/blog/how-graphite-uses-claude, 2025, exact date unknown): a 96% positive-feedback rate on AI comments and a 67% implementation rate for suggested changes. Claude had the lowest false-positive rate of the LLMs tested, with no number given. **vendor claim**
  - Braintrust case study (braintrust.dev/blog/graphite and /customers/graphite, 2025, date unknown): acceptance rate, meaning the developer commits the change, is "their most important metric", alongside upvote and downvote rates; a "90%+ target acceptance rate"; and a "5% reduction in negative rules". The latter's meaning is ambiguous. **vendor claim via partner**
  - Product Hunt "<3% false positives" has no methodology. **vendor claim, low credibility**
- **Independent result.** On Martian (2026-01-23) Graphite posted 12 true positives with 0–4 false positives across 50 PRs (R ≈ 0.07). That is consistent with very aggressive gating toward acceptance rate, and it shows that acceptance-rate optimisation alone can collapse recall. **independent evaluation, plus inference**
- The task's name "Graphite Agent" was not verified this session; the search ran out.

### 2.4 CodeRabbit

Sources:
- "Context Engineering: Level up your AI Code Reviews", coderabbit.ai/blog/context-engineering-ai-code-reviews, about July 2025.
- "Explainable reviews / review context engine", coderabbit.ai/blog/explainable-reviews-coderabbit-review-context-engine, date unknown, likely 2026.
- Docs changelog docs.coderabbit.ai/changelog.

All are search summaries; the fetch was blocked.

- **Context.**
  - The repo is cloned into a per-review sandbox, and file relationships and dependencies are mapped (a code graph).
  - Past PR titles, descriptions and commit ranges are indexed ("PR and Issue indexing").
  - Linked issues, architecture standards, custom review instructions, coding conventions, "learnings" from past reviews, and MCP access to team systems are added.
  - **vendor claim**
- **Verification.**
  - "Verification scripts" are generated in the sandbox to test each LLM review comment, and "low value feedback is automatically filtered out".
  - A separate verification agent filters the output of 40+ bundled linters and SAST tools to cut noise.
  - The newer post describes a review agent that proposes comments and verification agents that filter them against guidelines, config and team preferences.
  - **vendor claim**
- **Third-party descriptions.** These come from a sponsored Substack (theaiengineer.substack.com/p/how-coderabbit-actually-works, date unknown) and are **unverified**:
  - The agent investigates with raw shell (cat, grep, ast-grep) rather than predefined tools.
  - A model ensemble: cheap models for context cleanup, frontier reasoning models for the deep pass, and a judge model to verify.
  - The sandbox is destroyed after the review.
- **Independent result.** On Martian (2026-01-22) CodeRabbit scored P 0.35 / R 0.60 / F1 0.44 (Opus judge). Recall is high but precision is among the lowest of the major tools, despite the verification layer. **independent evaluation**
- Macroscope's own Sept 2025 benchmark had CodeRabbit at 46% detection. **vendor claim, by a competitor**

### 2.5 GitHub Copilot code review

Primary source: `github/docs` commit 17d6ee5 (2026-11-05), file `content/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review.md`, plus `data/variables/copilot.yml` and `content/copilot/responsible-use/agents.md`. **vendor claim (official docs)**

- **Architecture.**
  - "Agentic capabilities: Full project context gathering… analyzes your entire repository."
  - These capabilities run on GitHub Actions runners. If runners are unavailable, Copilot "falls back to a more limited review".
  - Changelog 2026-03-05, "Copilot code review now runs on an agentic architecture" (GA): a tool-calling reviewer that gathers repository context such as directory structure and references on demand. Search summary.
- **Effort levels.**
  - Lite: standard review.
  - Balanced (default): "routes pull requests to a higher-reasoning model".
  - Max (preview): "uses multiple high-reasoning models".
  - Average cost per review: Lite $0.25 (range $0.05–1), Balanced $1.50 ($0.25–5), Max $10 ($1.50–25), excluding Actions minutes.
  - This is the clearest published example of compute and recall scaling by tiers.
- **Model choice.** "Model switching is not supported, as changing the model is likely to compromise reliability… and the quality of review comments."
- **Deterministic tools.**
  - Changelog 2025-10-28, "new public preview features… AI reviews that see the full picture": blends LLM detections with ESLint and CodeQL. Search summary.
  - The current docs instead point to GitHub Code Quality (rules-based CodeQL on PRs and the default branch, coverage metrics, merge gating) as the complement.
- **Context and customisation.**
  - `.github/copilot-instructions.md`, path-scoped `.github/instructions/**/*.instructions.md`, `AGENTS.md`, and skills in `.github/skills`.
  - MCP servers: the GitHub MCP and Playwright MCP are on by default. Comments carry attributions naming the skill or MCP server used.
  - "Copilot Memory": repository-level facts learned and reused in reviews.
- **Exclusions.** Dependency and lock files, logs and SVGs are not reviewed.
- **Approval.** An "approval assessment" appears in every review. Optionally, a Copilot approval can satisfy required approvals, and it is dismissed on a new push.
- **Responsible-use card.** Copilot "has a risk of hallucination — it may highlight problems… that do not exist", and code suggestions may be invalid.
- **Independent result (Martian).**
  - copilot (2026-01-22, 137 set): P 0.28 / R 0.53.
  - copilot-v2 (2026-06-24, 173 set): P 0.41 / R 0.66 / F1 0.50 (Opus judge), the highest recall among the 173-set runs.
  - **independent evaluation**
- No GitHub-published acceptance or precision number was found. A "1M developers" figure (third party) refers to users, not quality.

### 2.6 Sourcery

- From `github.com/sourcery-ai/sourcery` README (2026-09-17):
  - Reviews include a summary, high-level feedback, and line-by-line suggestions.
  - "We use both OpenAI and Anthropic LLMs to provide pieces of our code reviews… we need to send them sections of your code (typically the diff of the PR)".
  - Code is retained for at most 30 days.
  - **vendor claim**
- No pipeline write-up was retrieved; the search ran out.
- Independent result: sourcery (2026-03-07) on Martian scored P 0.43 / R 0.55 / F1 0.48 (Opus judge). **independent evaluation**

### 2.7 Ellipsis

Sources:
- Nick Bradford (CTO), "How we built Ellipsis", nsbradford.com/blog/how-we-built-ellipsis, about early 2025.
- Substack version nickbradford.substack.com/p/lessons-from-27-months-building-llm, about Nov 2025, a talk at the YC Alumni AI Retreat.

Both are search summaries.

- **Pipeline.**
  - Several Comment Generators run in parallel, and each attaches Evidence (links to code snippets).
  - A multistage Filtering Pipeline that "significantly reduces the false positive rate":
    1. Deduplicate similar comments.
    2. A Logical Correctness filter that uses the attached evidence to detect "straight-up hallucinations".
    3. A confidence-threshold filter. This one is in the ZenML summary only.
    4. Feedback: thumbs up/down feed an embedding search over past comments that users reacted to.
  - A Code Search sub-agent is shared by the generators and the filters.
  - Filtered comments and the reason for filtering are included in the output for transparency.
  - **vendor claim**
- No published precision numbers. Ellipsis is not in the Martian table.

### 2.8 Bito AI Code Review Agent

- From `github.com/gitbito/CodeReviewAgent` (2025-11-13). **code / vendor claim**
  - README:
    - "powered by Anthropic's Claude Sonnet 3.5", which is likely stale.
    - "analyze your entire codebase in depth".
    - Combines LLM review with static analysis (fbinfer) and OSS vulnerability tools (OWASP Dependency-Check), and can include high-severity findings from Snyk or Sonar.
    - Claims "Can reduce code review time by up to 50%", with no method given.
  - Config `cra-scripts/bito-cra.properties`:
    - `static_analysis_tool=fb_infer,astral_ruff,mypy`
    - `linters_feedback=True`
    - `secret_scanner_feedback=True`
    - `dependency_check` (with Snyk token)
    - `code_context=True`
    - `suggestion_mode=essential`
    - default `exclude_files=*.xml,*.json,*.properties,.gitignore,*.yml,*.md`
    - `exclude_draft_pr=True`
- Martian's run produced no comments, so Bito is not evaluable there.

### 2.9 Macroscope

Sources: blog.macroscope.com/blog/code-review-benchmark (about Sept 2025), TechCrunch 2025-09-17, and the MacroscopeBench announcement (date unknown). All are search summaries.

- **Context.** "Code walking" over the AST builds a graph of how the codebase works, which is then used as review context. **vendor claim**
- **Own benchmark (Sept 2025).** 100+ real production bugs from OSS. Detection was 48% for Macroscope, 46% for CodeRabbit and 42% for Bugbot. By language: Go 86%, Java 56%, Python 50%, Swift 36%. CodeRabbit led on JavaScript (59%) and Rust (45%). **vendor claim**
- Later "Detection Mode" settings (Budget, Balanced, Precise, Ultra) trade recall, precision, latency and cost. A "98% precision" figure exists only on an aggregator. **unverified**
- Independent result: macroscope (2026-03-09) on Martian scored P 0.62 / R 0.47 / F1 0.53 (Opus judge). **independent evaluation**

### 2.10 Baz

- baz.co/resources/baz-1-in-precision-in-independent-code-review-bench (about Feb 2026): Baz claims #1 precision on Martian, and that "Precision is the adoption gate, but it is not the only metric that matters." **vendor claim**
  - My aggregation: P 0.63 (Opus judge), R 0.36. Among tools with meaningful comment volume only Devin (0.70) is higher. Graphite's 1.00 is on 12 comments. So the claim is roughly consistent, depending on profile and judge. **independent evaluation, plus inference**
- "Baz Evaluations" (baz.co/resources/launching-the-new-baz-evaluations-from-metrics-to-action, date unknown): scores each reviewer agent by developer response (acceptance and sentiment rates), compares agents, and recommends changes for underperforming reviewers. **vendor claim**
- AWS ML blog, "How Baz improved its AI agent code review accuracy using Amazon Bedrock AgentCore" (about June 2026): an orchestration layer coordinates a multi-agent review. A Spec Review agent uses the AgentCore Browser to check behaviour against Jira specs, and sandboxing lets multiple MCP servers run safely. **vendor claim, partner blog**

### 2.11 Kodus (open-source 2025–2026 entrant with the most published technical detail)

Source: `github.com/kodustech/kodus-ai` commit 2ee5d32 (2026-11-05), files `evals/README.md`, `evals/stages.js`, `evals/funnel/**`, `evals/heavy-recall/targets.json`, `evals/investigation/targets.json` and `e2b-sandbox/template.ts`. **code**. Its quality numbers are **vendor-published evals with open code**.

**Pipeline stages, from `evals/stages.js`.**
1. **Business logic.** Before the agents run, it reads the linked task (for example a Jira ticket via MCP) and flags what the PR leaves out. It has its own judge and verifier.
2. **Static analyzers.** Beta and opt-in: a secret scanner (betterleaks 1.8.1) and a dependency CVE scanner (osv-scanner 2.6.0). Both versions are pinned "so findings don't change under us". Their output is handed to the review as evidence.
3. **Finder.** An agent that reads the PR and repo with tools, "running commands in a sandbox" (E2B, egress via a proxy). Per-model step caps apply, and a "synthesis rescue" pass is set per model family. Each finding has five fields: file, lines, what is wrong, and two more.
4. **Heavy mode** (`--heavy`). Nine "lenses" run in parallel with the generalist. Each looks for one defect class only, with at most 3 steps and 4 findings each. All findings go through the same verify step and every later stage.
5. **Memories** (team-saved conventions) and **repo instructions** (CLAUDE.md, AGENTS.md, .cursor/rules, Copilot instructions governing the changed files, read from the target branch; a violation must quote the rule).
6. **Parse plus prose recovery.** If a finder ends with prose and no findings, a call converts the prose into findings, "never the hypotheses it dismissed".
7. **Verify.** "Checks each bug the finder proposes against the code, with its own tools, and drops the ones the code does not confirm: claims the code contradicts, hallucinations, nits."
   - An **evidence gate** fully re-verifies any finding on a file the finder never read.
   - A verdict-delivery eval exists because of issue #1937. A verifier wrote `{"keep": false}` in text instead of calling the tool, and the refutation was discarded: "kept by default". The lesson: parse every verdict shape, and decide fail-open versus fail-closed deliberately.
8. **Kody Rules.** Team rules are checked by an agent. "A mechanical rule becomes a pattern search whose hits the AI confirms", using ast-grep.
9. **Custom agents.** Glob-scoped, each with its own severity floor and comment cap, then verify and dedup.
10. **Anchoring.** A finding whose file is not in the PR is dropped, and lines are snapped onto changed lines.
11. **Later rounds.** No repost of a comment already on the PR or one the developer declined.
12. **Dedup.** Merge findings that describe the same bug "without merging two different bugs". It uses embeddings.
13. **Severity.** One call per PR. The team minimum (default medium) drops anything below it. "A real bug rated too low is dropped here without anyone seeing it."
14. **Enrichment** (title, plus a fix only when it fits exactly the cited lines), **format**, **posting**, and **PR summary**.

**Eval discipline.**
- Evals run production code with production tools and the sandbox.
- Cases come in pairs (must act / must not).
- Floors are calibrated from two runs with paired bootstrap 95% intervals.
- A change ships only if nothing regresses and the main metric improves beyond its interval, or ties with fewer tokens.
- Every eval logs token use and cost.
- A funnel eval measures how many known bugs each post-finder stage loses, on frozen snapshots.
- **code**

**Published numbers.**
- Dataset: the 50-PR golden set (136 goldens). Judge: gpt-5.6-luna. Controlled set: 15 PRs, three per repo.
- Normal finder, recall / precision:
  - deepseek-v4-flash: 0.39 / 0.52
  - gpt-6-sol: 0.49 / 0.37
  - claude-sonnet-5-5: 0.39 / 0.58
  - kimi-k2.7-code: 0.48 / 0.51
  - Mean tool calls per review are 25–70.
- Heavy mode (nine lenses plus generalist, same verify), recall / precision:
  - deepseek: 0.53 / 0.50
  - gpt-6-sol: 0.62 / 0.39
  - sonnet-5-5: 0.56 / 0.43
  - kimi: 0.63 / 0.48
  - This is **+0.10 to +0.17 recall** for a precision change of -0.15 to +0.02, at 1.3–2.1× the tokens (runs of 2026-11-02).
- Verify keeps 0.97–1.00 of the known bugs that reach it (controlled set, calibrated 2026-10-17). The heavy snapshot keeps 0.926. A deliberate break test (the verifier drops everything) correctly fails the gate.
- These are the only public, per-stage numbers I found showing that a verifier can be close to recall-neutral.
- **vendor eval (open code)**
- Independent result: kodus-v2 (2026-03-12) on Martian scored P 0.60 / R 0.36 (Opus judge).

### 2.12 Other entrants seen on the independent board (pipeline detail not retrieved)

- **Augment** (2026-01-22) and **Cubic** (cubic-v2, 2026-03-13) are joint top with Qodo extended-v2 on Martian, at about P 0.6 / R 0.6. Augment published the December 2025 expanded dataset that Martian built on. Pipeline details were not gathered (search budget). **independent evaluation**
- **Greptile.** Its July 2025 benchmark was the origin of the dataset. Martian scores: greptile-v4-1 (2026-04-05) F1 0.52 (Opus); greptile-v5 (2026-06-26) P 0.40 / R 0.45 / F1 0.43, a drop from v4-1 under all three judges. **independent evaluation.** Greptile's own claims were not retrieved here; it is covered in a separate lane.
- **Devin** (2026-03-02) has the highest precision among tools with volume, P 0.70 / R 0.39, and **GitLab Duo** (2026-04-23) scored P 0.56 / R 0.53. **independent evaluation**

---

## 3. Research and industrial studies (recalled, not re-fetched this session; verify before citing)

- **Cihan et al., "Automated Code Review In Practice", ICSE-SEIP 2025, arXiv:2412.18531.**
  - Industrial study of a Qodo PR-Agent deployment at Beko.
  - Recalled: 73.8% of automated comments were marked resolved, and PR closure time increased rather than decreased.
  - The useful lesson: the resolution rate of comments does not equal velocity gains.
  - **research (recalled)**
- **BitsAI-CR (ByteDance), arXiv:2501.15134, 2025.**
  - A two-stage design: RuleChecker generation over a rule taxonomy, then a ReviewFilter verification model, with a data flywheel from feedback.
  - Recalled: 75.0% precision, and an "Outdated Rate" metric (share of flagged lines changed later) of about 26.7% for Go.
  - This is the closest peer-reviewed analogue of "generate, then filter, then learn from outcomes".
  - **research (recalled)**
- **Uber uReview** (Uber engineering blog, 2025).
  - Recalled: multi-stage. Comment generators (general bugs, best practices, security) feed a grader/filter for confidence, a semantic dedup, and a category-based suppression of low-value classes.
  - High usefulness and address rates were reported; the exact numbers were not verified here.
  - **vendor/industry (recalled)**
- **Google AutoCommenter** (Vijayvergiya et al., 2024): an LLM detecting best-practice violations in code review at Google scale, deployed with feedback loops. **research (recalled; no numbers quoted)**
- **SWR-Bench** (2025 preprint): recalled finding that aggregating multiple independent review runs ("multi-review aggregation") substantially raises F1 over a single run. This is consistent with Bugbot v1 and Kodus heavy mode. **research (recalled; exact figure and ID not verified)**

---

## 4. Cross-cutting techniques ranked by strength of evidence

Evidence tiers:
- **A**: independent quantitative evidence, or several vendors' quantitative results that agree.
- **B**: a vendor-internal quantitative result with a disclosed method, or code-level evidence plus convergent adoption.
- **C**: convergent adoption and design rationale, with no public measurement.
- **D**: claimed, with thin or no evidence.

1. **Precision and recall are a frontier, so ship explicit operating points instead of one setting.** Tier **A**.
   - Martian shows tools spread from Graphite (P 1.0, R 0.07) to cubic-dev (P 0.30, R 0.76). The best are near P ≈ R ≈ 0.6, and nothing tops about 0.65 F1.
   - Vendors converge on tiers: Copilot Lite/Balanced/Max at $0.25/$1.50/$10; Macroscope Budget/Balanced/Precise/Ultra; Qodo default/extended; Kodus normal/heavy; Cursor "default effort".
   - Acceptance-rate-only optimisation collapses recall, as Graphite on Martian shows. **independent evaluation, plus inference**
2. **Agentic, tool-using investigation of the repo instead of single-shot diff prompting.** Tier **A-/B**.
   - Cursor credits the agentic redesign as its largest gain: resolution 52% to over 70%, bugs per run 0.4 to 0.7. **vendor**
   - GitHub moved Copilot review to agentic tool calling (GA 2026-03-05), and its independent Martian scores rose (P 0.28 to 0.41, R 0.53 to 0.66), though the golden-set change confounds this. **independent**
   - Every top-five Martian tool is an agentic or context-heavy system. **inference**
   - Kodus's finder makes 25–70 tool calls per review in a sandbox. **code**
   - No controlled public ablation of agentic versus single-shot on the same model was found.
3. **Generate, then verify: an independent verifier or judge pass with evidence, dropping unconfirmed candidates.** Tier **B+**.
   - Present in PR-Agent (self-reflection scoring, code), Ellipsis (evidence-based logical-correctness filter), CodeRabbit (verification agents and scripts), Qodo 2.0 (judge agent), Kodus (tool-using verifier plus evidence gate), BitsAI-CR (ReviewFilter, research) and Uber uReview (grader).
   - Kodus shows the verifier can keep 97–100% of the known bugs reaching it, which makes it nearly recall-neutral.
   - Qodo's judge-based extended mode is #1 on the independent board.
   - Missing: a public "precision with and without the verifier" ablation.
   - Important design details:
     - Judge all candidates together, for comparative context (PR-Agent docs).
     - Re-verify findings on unread files (Kodus).
     - Handle verdict parse failures deliberately (Kodus #1937; PR-Agent fail-open at 7).
4. **Multiple specialised passes or lenses, unioned, then dedup, then verify, to raise recall.** Tier **B**.
   - Kodus heavy mode: +0.10 to +0.17 recall at -0.15 to +0.02 precision for 1.3–2.1× tokens, with disclosed calibration.
   - Qodo multi-agent extended mode is top on Martian. **independent**
   - Copilot Max uses "multiple high-reasoning models". **vendor, no numbers**
   - Bugbot v1 used eight shuffled passes with majority vote, a precision-oriented variant later replaced by an agentic design.
   - Multi-review aggregation in research (recalled).
   - Majority voting raises precision; union raises recall and needs a verifier after it. **inference**
5. **Deterministic grounding and validators on model output.** Tier **B** (code-level, obviously correct, unmeasured publicly).
   - Anchor every finding to a changed line in a PR file, and drop or snap the rest (Kodus anchoring).
   - The quoted `existing_code` must match the file exactly (PR-Agent `_validate_suggestion`).
   - Compile-check the replacement (PR-Agent, Python).
   - Ship a fix only when it fits exactly the cited lines (Kodus enrichment).
   - Schema validation and prose-to-finding recovery (Kodus).
   - These remove whole classes of nonsense output at zero model cost. **code**
6. **Learning from feedback: reactions, replies, resolutions, dismissals become rules, memories and suppressions.** Tier **B-**.
   - Cursor learned rules: 44k rules over 110k repos; resolution rate rose to 78% alongside them. This is confounded by concurrent model and agent changes. **vendor**
   - CodeRabbit "learnings", Copilot Memory (repo facts) and Ellipsis embedding retrieval of reacted comments. **vendor**
   - PR-Agent persistent finding state: dismissed findings are not re-raised, resolved threads are skipped, previous wording is kept. **code**
   - Kodus review rounds: no repost of declined comments. **code**
   - BitsAI-CR data flywheel. **research, recalled**
   - The core primitive, outcome tracking per comment, is cheap and doubles as the metric. **inference**
7. **Metrics grounded in developer action, measured at merge.** Tier **B** (as a measurement technique).
   - Cursor resolution rate, judged by an AI on the final diff, counts fixes done differently.
   - Graphite and Braintrust use acceptance rate plus up and down votes.
   - Baz tracks per-agent acceptance and sentiment.
   - Martian's online benchmark matches suggestions to post-review commits.
   - Martian's caveat: "not acted on ≠ wrong". Mitigations include human categorisation of non-action, comment afterlife, per-pattern acceptance rates, and the action rate across severities.
8. **Static analysis and linters as evidence inputs, filtered by the LLM.** Tier **C+**.
   - CodeRabbit runs 40+ linters and SAST tools through a verification agent. **vendor**
   - Copilot: ESLint and CodeQL in preview (2025-10-28), later Code Quality with merge gating. **vendor**
   - Bito: fb_infer, ruff, mypy, secret scanner, OWASP. **code**
   - Kodus: pinned betterleaks, osv-scanner and ast-grep. Mechanical team rules compile to ast-grep searches whose hits the LLM confirms. **code**
   - Static tools are precise within their class but noisy as raw comments; every vendor filters them. **inference**
   - No public lift numbers.
9. **Repo instruction files and team rules as the definition of "what to flag".** Tier **C+**.
   - Universal: Copilot (copilot-instructions, path-scoped instructions, AGENTS.md, skills), PR-Agent (`repo_context_files`, skills), Kodus (repo instructions with a quote requirement, Kody Rules), CodeRabbit (path instructions and guidelines).
   - Martian argues that precision and recall are ill-defined without conditioning on these files. It proposes giving the same file to both tool and grader.
   - No measured lift.
10. **Context selection heuristics for large repos.** Tier **C**.
    - PR-Agent:
      - asymmetric and enclosing-scope context;
      - language and size prioritisation;
      - token-aware packing;
      - chunking with conservative merge rules.
    - Macroscope: AST code walking.
    - CodeRabbit: code graph plus PR and issue history indexing.
    - Copilot: full project context gathered on Actions runners.
    - Kodus: files the finder actually read are tracked and used in the evidence gate.
    - Rationale only. PR-Agent explicitly warns that more context can degrade quality ("needle in a haystack").
11. **Hard output caps, severity floors and category blocklists.** Tier **C**.
    - Examples: PR-Agent `num_max_findings=3`; its reflection rubric zeroes docstrings, type hints, unused imports and exception specificity; Kodus has a medium severity floor and per-agent caps.
    - These raise perceived precision, but Kodus documents the cost: "A real bug rated too low is dropped here without anyone seeing it."
12. **Sandboxed execution of code or tests to verify findings.** Tier **D**.
    - CodeRabbit generates verification scripts in a sandbox. Kodus's finder and verifier can `exec` in an E2B sandbox at PR head. Copilot runs on Actions runners.
    - No vendor published a test-execution-based verifier with numbers.
    - Running the project's tests is not described by anyone as a standard verification step.
    - Plausible, but unproven in public. **inference**
13. **Multi-model voting.** Tier **D**.
    - It is the claimed design of Copilot Max ("multiple high-reasoning models") and of the CodeRabbit ensemble (sponsored, unverified).
    - Cursor moved away from multi-pass voting toward agentic.
    - No public ablation.

---

## 5. Implications for Vectorscope (inference)

- **Architecture to copy:**
  - an agentic finder with sandboxed read, grep, ast-grep and exec over the repo at PR head;
  - optional parallel single-class lenses for a "deep" mode;
  - a tool-using verifier with an evidence gate (re-verify findings on files the finder never read);
  - deterministic anchoring and quote matching;
  - embedding plus LLM dedup that will not merge distinct bugs;
  - severity scoring with a visible floor;
  - cross-run state (fingerprints, dismissed and resolved tracking).
- **Expose operating points:**
  - precise (for example, post only verified high and medium findings, capped);
  - balanced;
  - exhaustive (lenses plus union).
  - Report cost per review per mode, as Copilot does.
- **Measure from day one:**
  - Use Martian's public offline harness (50 PRs, 173 goldens, three judges, dedup-aware) for controlled comparisons against the table in section 1.
  - Use a per-stage funnel (Kodus style) to see where known bugs are lost.
  - In production, use a merge-time resolution rate judged on the final diff (Cursor style), plus per-pattern acceptance.
- **Treat static analysers as evidence inputs to the verifier, not as comments.** Pin their versions.
- **Make the verifier's failure mode explicit.** Choose fail-open or fail-closed deliberately, and parse verdicts from both the tool payload and free text.
- **Mine reactions, replies and declines into candidate rules,** promoted or retired by accumulated signal (Cursor), stored per repo.

## 6. Open questions

- What is CodeRabbit's actual verifier design, and what is its precision lift? Its independent precision (0.35) is low despite "verification agents". Needs a full read of coderabbit.ai posts.
- Is there any controlled ablation (same model, same PRs) of agentic versus single-shot review, or verifier on versus off? None public was found. Kodus's open eval harness could produce one.
- Does executing tests or scripts in a sandbox improve verifier precision measurably? No vendor numbers.
- How do Martian online-benchmark precision proxies (matched to fixes) rank tools compared with the offline table? The online dashboard was not fetched.
- What exactly changed between greptile-v4-1 and v5 (F1 dropped under all judges), and between Copilot v1 and v2?
- What are the pipelines of Augment and Cubic, which are co-leaders on Martian? Not retrieved this session.
- Cursor's 80% resolution-rate claim (2026-05-11) and its July 2025 GA numbers are unverified.
- The research items in section 3 should be re-verified against the papers (arXiv was not reachable).
