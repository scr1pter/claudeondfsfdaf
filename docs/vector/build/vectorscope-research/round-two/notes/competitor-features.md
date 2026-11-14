# Round two, angle: features that make a reviewer good, beyond Greptile

Prepared 2026-11-06. Read-only. Nothing in the VectorScope worktree was edited, built or run.

## 0. Method, access, and how this extends round one

**What was reachable.**
- **WebSearch:** none. The shared per-turn budget of 200 searches was already spent when this lane started, so not one search ran.
- **WebFetch:** the first two hosts tried, docs.coderabbit.ai and github.blog, failed DNS resolution under the session's network policy. Following the tool's stop rule, no further hosts were tried: cursor.com, graphite.com, qodo.ai, bito.ai, ellipsis.dev, korbit.ai, kodus.io, arxiv.org and web.archive.org.
- **What worked:** `git clone` through the session's git proxy, for public GitHub repositories only. `gh api` was refused for every repository ("GitHub access … not enabled for this session").

**Where the evidence comes from.** Almost all of it is vendor documentation or vendor configuration read from public repositories at a pinned commit. The label says what kind of claim it is:
- **code**: read in source or config;
- **vendor**: the vendor's own docs or claims;
- **academic**: a paper. Papers are marked (recalled) when they were not re-read this session.

**Primary sources read this session.** Dates are the repository's HEAD commit date; all clones were shallow, so a file's own date is unknown.
- GitHub Copilot docs: `github/docs` @ `17d6ee5` (2026-11-05). Code review how-to, lifecycle tutorial, concept page, excluded files, the CLI agentic review, code-scanning autofix and PR summaries.
- CodeRabbit's own config library: `coderabbitai/awesome-coderabbit` @ `60b891c` (2026-09-29). The annotated default `.coderabbit.yaml`, starter configs, and the pre-merge-check packs with their README.
- PR-Agent docs: `qodo-ai/pr-agent` @ `6de02f5` (2026-11-05). `fetching_ticket_context.md`, `describe.md`, `ask.md`, `improve.mdx`, `automations_and_usage.md`.
- Kodus docs, mirrored in `kodustech/kodus-ai` @ `2ee5d32` (2026-11-05), `docs/en/**`. Business logic validation, auto-approve and risk, severity threshold, Cockpit "Kodus Review", the coding-agent instructions page, feedback and learning, review directive, PR summary, CLI agent loop, pricing.
- Greptile skills: `greptileai/skills` @ `59e79ec` (2026-11-03). `cli-review`, `greploop`, `check-pr`.
- OpenAI Codex: `openai/codex` @ `5589742` (2026-11-06). `codex-rs/prompts/templates/review/rubric.md` and `codex-rs/protocol/src/review_format.rs`.
- Anthropic: `anthropics/claude-code-security-review` @ `0c6a49f` (2026-02-11) and `anthropics/claude-code-action` @ `c0949c5` (2026-11-04).
- Google: `google-github-actions/run-gemini-cli` @ `387c8dd` (2026-08-21), the PR-review example and its eval.
- Smaller repositories:
  - `qodo-ai/qodo-cover` @ `adcf55b` (2025-06-23);
  - `sourcery-ai/sourcery` @ `2205e06` (2026-09-17);
  - `gitbito/CodeReviewAgent` @ `040bbc8` (2025-11-13);
  - `presubmit/ai-reviewer` @ `aa176b7` (2026-09-14);
  - `withmartian/code-review-benchmark` @ `e616e84` (2026-08-30), `online/README.md`.
- VectorScope itself: the worktree `/home/user/wt/vectorscope` @ `13b9db02`, which includes VS-21a and VS-21b.

**Relation to round one.**
- Round one covered Greptile in depth, the Martian scores, Bugbot and CodeRabbit pricing, and the verifier and lens techniques.
- This lane does not repeat them. It adds:
  - a feature-by-feature matrix;
  - VectorScope's own status on each feature, read from code;
  - vendor features round one did not record: Kodus hotspot risk, Kodus turning off its reaction learning, Copilot's admitted repeat-comments behaviour, the Codex rubric, CodeRabbit pre-merge checks, PR-Agent ticket compliance, Greptile's CLI and review loop;
  - two corrections: VectorScope already has a GitHub fix path and a thread-chat path through the @vector agent on `main`, which round one did not record; and reaction-based learned suppression is weaker than round one ranked it.

## 1. VectorScope's feature baseline (code, worktree `13b9db02`)

| Feature | VectorScope today | Where |
|---|---|---|
| Incremental re-review | Yes, and strong. Defaults: `incremental: true`. `planRange` reviews only focus hunks when the PR is ahead; a force-push with identical per-file patch-ids is "carried" with no model call; the already-reviewed head is skipped. Prior findings are matched and carried forward: fixed ones resolve their thread (optional reply with `replyOnFix`), still-open ones are not re-posted, dismissed ones stay dropped. | `types.ts` defaults; round-one today §2.2, §2.6; `github.review.ts:855` |
| PR summary | A sticky comment with a 2–3-sentence model summary ("what the change does and the main risk"), a risk header, a table of the files that matter most, counts, "since last review", partial-coverage banners and cost. No PR-description writing, walkthrough, diagram, effort estimate, labels or suggested reviewers. | `schema.ts:27-35`; `format.ts:590-700` |
| Linked issues | Local CLI only: Brain "linked requirements", 300 tokens, sent only to models that do not train. No GitHub, Jira or Linear issues. VS-16 plans same-repository issues and commit messages after the @vector merge. | `context.ts:176-240`; plan VS-16 |
| Custom rules and path instructions | `.vector/review.md` with `## path: <glob>` sections, plus `review.json` `paths`. Findings cite the broken rule (`rule from .vector/review.md: "…"`). Only root `AGENTS.md` or `CLAUDE.md` and `.vector/RULES.md` are read from base, 16 KB each. No nested `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md` or `.github/instructions/*.instructions.md`. | `config.ts:239`; `types.ts:252`; `context.ts:21,146-174`; `format.ts:317-321` |
| Committable fixes | Yes, gated: the anchor must be exactly the model's own lines, RIGHT side, at most 40 lines, same indent; in untrusted reviews only when verified. Otherwise the fix is shown as a diff block. | `select.ts:327-337`; `format.ts:305-314` |
| One-click autofix | **On GitHub, yes, through the general @vector agent.** Trusted inline comments say "reply `/vector fix` to have Vector apply this". `/vector fix` in a Vector finding's thread makes the finding the task, and the agent can push to the PR branch, a fork branch or a new branch. This is not VS-12/13's consented contract. Locally (CLI or desktop) there is no apply step. | `format.ts:321-322`; `github.handler.ts:862-871, 1145-1167, 1848-1909` |
| Test generation | None. VS-30 plans differential reproducers as evidence, never as deliverables. | contract VS-30 |
| Security scanning | A read-only `security` specialist on sensitive paths, plus secret redaction of output. No SAST, secret or dependency scanner. VS-18 plans offline secret scanning and pinned linters. | today §2.5; plan VS-18 |
| Severity and confidence display | `blocking`/`concern`/`nit` label, `confidence 0.xx`, a `verified` tag and the rule source on every inline comment; a risk header on the summary; `failOn: blocking` fails the check. | `format.ts:307-317` |
| Chat with the reviewer | Not with VectorScope itself. A `/vector <question>` on a review thread goes to the general @vector agent with file, line and diff-hunk context (`github.handler.ts:853-856`). The commands are `review`, `review full`, `pause`, `resume`, `dismiss` and task (`command.ts:6`). | |
| Latency | 12-minute timeout. Not measured: no eval result exists. | `types.ts` `timeoutMinutes: 12` |
| Pricing | BYOK in the customer's CI; $2 per review, $10 per PR, optional monthly cap; Vector-provided free models as the unattended fallback. | round one §2.6 |
| Privacy and self-host | Runs in the customer's own Actions with their key; no VectorScope server. No ZDR yet (VS-23). | round one §4.1 |
| Local pre-PR review | `vector review` on your own changes, `--pr`, `--json`, `--checks`; and the desktop panel. | `review.ts` |

## 2. Feature-by-feature survey

### 2.1 Incremental re-review on new pushes

**Who has it.**
- **Copilot (vendor docs).** A pushed change is **not** re-reviewed unless automatic review is enabled with **"Review new pushes"** in the ruleset; otherwise the user re-requests a review.
- **Copilot admits a defect.** "When re-reviewing a pull request, Copilot may repeat the same comments again, even if they have been dismissed with the 'Resolve conversation' button or downvoted" (`content/copilot/how-tos/use-copilot-agents/use-code-review.md`, `github/docs` @ 17d6ee5, 2026-11-05).
- **CodeRabbit (code: vendor config).** `reviews.auto_review.auto_incremental_review` is "Automatic incremental code review on each push" (default true), with `abort_on_close` (default true) and `drafts: false` by default (`configs/default/coderabbit-default-with-comment.yaml`, awesome-coderabbit @ 60b891c, 2026-09-29). Round one also recorded `auto_pause_after_reviewed_commits`.
- **PR-Agent (code: docs).**
  - `handle_push_trigger` and `push_commands`, both opt-in.
  - `push_trigger_ignore_merge_commits` (default true) "avoiding duplicate reviews on 'Update branch' clicks".
  - `push_trigger_ignore_bot_commits` (default true).
  - `persistent_finding_state` resolves and reopens findings across runs; "Incremental and partial reviews do not resolve absent findings" (`docs/docs/usage-guide/automations_and_usage.md`, `tools/review.md`, pr-agent @ 6de02f5).
- **Kodus (vendor docs).** It "remembers the last analyzed commit to keep follow-ups incremental" and skips runs with no new commits (`@kody review --force` overrides). Business-logic re-checks can be set to "each push while something is missing" (`docs/en/how_to_use/code_review/flow.mdx`, `business_logic_validation.mdx`).
- **Bugbot** runs on every push by default, priced per run (round one).

**Evidence that it improves outcomes.** None measured (limited access). The evidence that matters is about costs and failure modes:
- per-push runs multiply cost (the Bugbot forum complaints in round one);
- repeated, already-dismissed comments are an admitted Copilot defect.

**VectorScope.** It has this, and it is **ahead of Copilot's documented behaviour**. It matches by fingerprint, location and title; dismissed findings stay dropped; patch-id carry skips rebases. Two small gaps:
- merge-from-base "Update branch" pushes: whether the incremental focus already excludes base-merge hunks needs a check;
- the bot's own commits, such as an @vector fix commit.

### 2.2 PR summaries, walkthroughs, diagrams and descriptions

**Who has it.**
- **CodeRabbit (code: vendor config).** Defaults on: `high_level_summary` (written into the PR description), `changed_files_summary`, `sequence_diagrams`, `assess_linked_issues`, `related_issues`, `related_prs`, `suggested_labels`, `suggested_reviewers`, `review_status`, `commit_status`; and `poem: true`. Optional: `estimate_code_review_effort` and auto-title generation.
- **PR-Agent `/describe` (code: docs).** Title, type, summary, a "Changes walkthrough" and labels. A Mermaid diagram is on by default (`enable_pr_diagram`), with adaptive direction; about 30 s per run.
- **Copilot (vendor docs).** "Summary" in the description field, on request. The docs warn it "does not take into account any existing content in the pull request description".
- **Kodus (vendor docs).** Automatic PR summary with Replace/Concatenate/Complement modes for an existing description, a choice of what happens on new commits, and summary instructions.
- **Sourcery (vendor README, 2026-09-17).** Every review has "a summary of the changes, high level feedback, and line by line suggestions".
- **Presubmit (vendor README, 2026-09-14).** Title and description generation.
- **Greptile.** Round one recorded its summary, confidence score, file table and diagrams, and that v5 cut sequence diagrams from about 50 of 50 PRs to 8 and switched to flowcharts of the failure scenario [quality §4.2].

**Evidence.**
- **academic (recalled, not re-read):** Xiao, Treude, Hata, Matsumoto, "Generative AI for Pull Request Descriptions: Adoption, Impact, and Developer Interventions", FSE 2024. In repositories using Copilot for PRs, PRs with AI-generated descriptions were reviewed faster and were more likely to be merged. As recalled: about 19 hours less review time and an odds ratio of about 1.6 for merging. Treat the numbers as unverified. The study is observational: authors who use the tool may differ from those who do not.
- No study found on walkthrough tables or diagrams (limited search). Greptile's own retreat from per-PR sequence diagrams hints that their value is unproven.

**VectorScope.** It has a terse summary. It lacks description writing, a per-file walkthrough and diagrams. These are cheap: the review pass already returns `summary` and `files[].note`. But any new user-facing text is held by D14.

### 2.3 Linked-issue and requirement context (Jira, Linear, GitHub issues)

**Who has it.**
- **PR-Agent (code: docs).**
  - Sources: GitHub and GitLab issues, Jira, Asana, Linear. Fetched fields: title, description, custom fields such as acceptance criteria, sub-tasks, labels, images.
  - `/review` assigns a compliance label per ticket: Fully, Partially or Not Compliant, or "PR Code Verified" (meets the ticket but needs manual testing beyond the code).
  - Optional `check_pr_additional_content` flags code unrelated to the ticket.
  - **Trust rule:** issues in another repository need a host allowlist, `repo_context_sibling_repos`. "Repository settings and comment arguments cannot change this allowlist." The command requester must have read access to private repositories.
  - Source: `docs/docs/core-abilities/fetching_ticket_context.md` @ 6de02f5.
- **Kodus "Business Logic Validation" (vendor docs).** One kept-up-to-date comment, with a row per requirement in one of five states: MET, PARTIAL, MISSING, CHECK MANUALLY, NOT IN TASK.
  - Every row cites a file and line. A row turns MET or MISSING only on code Kody read at the PR head, including code outside the diff.
  - It reads parents, sub-tasks and attached docs, and checks at most three tasks per PR.
  - A reference counts only if the tracker returns that exact id ("so `UTF-8` or `gpt-5` in a title are never mistaken for tasks").
  - It reads tasks and never writes to the tracker.
  - Source: `docs/en/how_to_use/code_review/business_logic_validation.mdx`.
- **CodeRabbit (code: vendor config).** `assess_linked_issues` (default true) in the walkthrough; a pre-merge check, `issue_assessment`; knowledge-base `jira.project_keys` and `linear.team_keys`; chat integrations that can open Jira or Linear issues; `usage: auto` "disables the integration for public repositories".
- **Copilot (vendor docs).** No built-in tracker. It reads MCP context when "pull request descriptions … include identifiers referencing configured MCP servers such as issue keys or incident IDs".
- **Greptile and Baz:** Jira, Notion and Linear (round one).

**Evidence.** Vendor only; no outcome study found (limited search). Mechanistically, "missing requirement" defects cannot be seen from the diff alone, which is why every major vendor now ships this.

**VectorScope.** Partly: Brain requirements, CLI only. It is planned in VS-16, same-repository GitHub issues only, after the @vector merge. External trackers would need VS-14/15 MCP snapshots, which default to deny. There is no per-requirement compliance output.

### 2.4 Custom rules, path instructions and coding-agent instruction files

**Who has it.**
- **Copilot (vendor docs).**
  - `.github/copilot-instructions.md`.
  - Path-specific `.github/instructions/**/*.instructions.md`, "automatic when the changed files match the instruction scope".
  - `AGENTS.md`, and skills in `.github/skills` (a `code-review` directory name targets review).
  - Repository-level "Copilot Memory".
  - Its excluded-files list includes `requirements.txt`, `tsconfig.json`, `build.gradle` and every lockfile.
- **Kodus (vendor docs).**
  - It reads `.cursorrules`, `.cursor/rules/**/*.mdc`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `.agents/rules/**`, `CLAUDE.md`, `.windsurfrules` and `.sourcegraph/**/*.rule.md`.
  - Scope: only the files that cover the change; nested files cover their subtree; read from the target branch; pointers and `@imports` are followed.
  - Bounds: at most 8 files and 64 KB, nearest first.
  - Each finding must quote the instruction, and the breaking line must be added or modified.
  - The files are "never instructions to Kody".
  - Kodus also *stopped* converting these files into enforced rules and froze earlier imports (`configs/rules_file_detection.mdx`).
- **Codex rubric (code).** It uses "root and scoped project instruction files applicable to changed files" (`AGENTS.override.md`, `AGENTS.md`). For each rule-supported finding it must "verify the applicable project instruction file that supplies the rule and its smallest supporting line range" and cite it, and must not "invent findings solely because a rule file exists" (`codex-rs/prompts/templates/review/rubric.md` @ 5589742).
- **CodeRabbit (code: vendor config).** `path_instructions` (51 occurrences in its sample configs), `path_filters`, `tone_instructions`, and pre-merge `custom_checks` in natural language. Each check returns **pass, failure or inconclusive** in `warning` or `error` mode, and the README advises starting in `warning` "while the team evaluates false positives" (`configs/pre-mergechecks/README.md`).

**Evidence.** Tier C+ (round one): used everywhere, with no measured lift.
- Kodus's design choices are a useful negative signal: it reads only the nearest files, demands quote plus changed-line evidence, and treats the files as data.
- Kodus vendor docs record reverting a design (auto-importing agent files as rules) after it caused rule sprawl: "each repository's copy of a file had become its own rule".

**VectorScope.** It has path rules and rule citation. It lacks nested and scoped `AGENTS.md`/`CLAUDE.md` and the other tools' instruction files.
- This is cheap and deterministic, and I-2 (untrusted data, wrapped) already covers its trust model.
- It needs a byte cap and nearest-first ordering, and it must read from base, as `baseInstructions` already does.

### 2.5 Committable fixes, one-click autofix and review-fix loops

**Who has it.**
- **Copilot (vendor docs).** One-click suggestions, singly or batched into one commit. "Fix with Copilot" on a review comment hands it to the coding agent, which opens a new PR against the branch or commits to the same PR.
- **Copilot Autofix for code scanning (vendor docs).** The agentic version "validates fixes by re-running CodeQL" and "can't confirm fixes for alerts from custom CodeQL queries … or third-party tools" (`content/code-security/concepts/code-scanning/autofix-for-code-scanning.md`).
- **PR-Agent `/improve` (code: docs).**
  - Table mode by default, with committable mode as an option.
  - "Dual publishing" posts suggestions above a score threshold as committable comments.
  - "Suggestions whose replacement ranges cannot be verified remain regular comments without an apply action".
  - An acknowledgement checkbox under the suggestions.
- **Kodus CLI (vendor docs).** `kodus review --prompt-only` gives structured output for coding agents; `--fix` applies fixes; `--fail-on error` loops until clean; a pre-push hook is available (`docs/en/how_to_use/cli/ai_agents.mdx`).
- **Greptile (code: skills).** `greptile review --json` runs a local CLI review. The `greploop` skill triggers a review, fixes the comments and re-reviews "until 5/5 confidence and zero comments", at most 5 iterations. `check-pr` fixes unresolved comments and failing checks (greptileai/skills @ 59e79ec, 2026-11-03).
- **Codex (code).** Review findings render with `[x]`/`[ ]` selection markers, so the user chooses which ones to act on (`review_format.rs`). The rubric says "Do not generate a PR fix" and allows suggestion blocks only for concrete replacements of 3 lines or fewer in prose.
- **Bugbot Autofix:** see round one, privacy §3.1.

**Evidence.**
- arXiv 2607.21997 (round one; search extract, not read): inline code suggestions are the strongest predictor that a comment gets resolved.
- **academic (recalled):** Sun et al., "Does AI Code Review Lead to Code Changes? A Case Study of GitHub Actions", arXiv 2508.18771 (2025). Comments that are concise, contain code snippets and are manually triggered, especially from hunk-level tools, are more likely to lead to code changes.
- **vendor (recalled, 2024):** GitHub reported Copilot Autofix cut median time-to-fix for code-scanning alerts about threefold in its public beta.

**VectorScope.**
- **Correction to round one:** on GitHub it has a fix path already. `/vector fix` hands the finding to the @vector agent, which can push (`github.handler.ts:862, 1145-1167`), and trusted inline comments advertise it (`format.ts:321-322`).
- What it lacks:
  - VS-12/13's per-operation consent contract (D10);
  - any local apply step in the CLI or desktop;
  - a machine-readable "selected findings → agent fixes → re-review" loop. VS-27's StrictResult inside `--json` is the natural carrier.
- Being itself a coding agent, Vector is better placed for this loop than any reviewer-only vendor.

### 2.6 Test generation

**Who has it.**
- **CodeRabbit (code: vendor config).** `finishing_touches.unit_tests` and `docstrings` (docstrings default true), plus custom finishing-touch recipes (one sample asks for a 1–5 "Confidence Rating").
- **Sourcery** (IDE: "Add unit tests and docstrings").
- **Qodo:** Qodo Cover, the open-source test generator, is "no longer maintained" as of 2025-06-15 (`qodo-ai/qodo-cover` README) (code).
- **Copilot:** through its coding agent, not code review.
- None of the surveyed reviewers posts generated tests as part of the review itself.

**Evidence.** Meta TestGen-LLM (round one, recalled): tests are useful only behind build, pass, flakiness and coverage filters. Qodo's abandonment of Cover is a weak market signal that standalone test generation was not where the review value was.

**VectorScope.** It lacks this, which is fine. VS-30's differential reproducers (fail on head, pass on base) are the evidence-grade version. Offering a confirmed reproducer as a committable test file later would be the low-risk version of this feature.

### 2.7 Security scanning integration

**Who has it.**
- **CodeRabbit (code: vendor config).** 25 tool integrations in the samples: actionlint, ast-grep, biome, buf, checkov, circleci, cppcheck, detekt, eslint, github-checks, **gitleaks**, golangci-lint, hadolint, languagetool, markdownlint, oxc, phpstan, pmd, regal, rubocop, ruff, **semgrep**, shellcheck, sqlfluff, swiftlint and yamllint. The security pre-merge pack covers injection, credentials, broken object authorisation and dependency risk.
- **Kodus:** pinned betterleaks and osv-scanner (round one).
- **Bito:** fbinfer, ruff, mypy, a secret scanner and OWASP Dependency-Check (round one).
- **Copilot:** CodeQL and Code Quality as a complement, plus Autofix.
- **Anthropic `claude-code-security-review` (code, 2026-02-11).**
  - Diff-aware Claude review, then hard-exclusion rules (for example: memory-safety findings outside C/C++, SSRF in HTML only, "resource" patterns), then a Claude false-positive filter.
  - The default model is `claude-opus-4-1-20250805`, with a 20-minute timeout.
  - Its README warns: "not hardened against prompt injection attacks and should only be used to review trusted PRs".

**Evidence.** CodeRabbit's January 2025 incident, where a repository-controlled `.rubocop.yml` gave remote code execution (round one), shows that running scanners with the PR's own config is dangerous. Secret and dependency scanners are deterministic, cheap and high-precision; no review-outcome study was found.

**VectorScope.** It has a model security specialist. It lacks scanners; VS-18 plans them with pinned tools and no execution of repository config.

### 2.8 Severity, confidence, verdicts and approval

**Who has it.**
- **Copilot:** "High", "Medium", "Low" labels; an "approval assessment" in every overview comment; optional approving reviews that **count toward required approvals**, dismissed when commits are pushed, and scoped by file path (vendor docs).
- **Codex:** `[P0]`–`[P3]` in the title; `confidence_score` per finding; `overall_correctness` "patch is correct/incorrect", with `overall_confidence_score` (code).
- **Gemini CLI example:** Critical, High, Medium and Low emoji levels with strict definitions (code).
- **Kodus:**
  - a minimum-severity slider (default Medium) that Kody Rules bypass by default;
  - risk-gated **auto-approve**, which holds approval when sensitive paths match, when risk is not "low", or when "the PR changes control flow (`if`, `return`, `throw`) in source files and adds no test", or when the assessment failed;
  - "A file with no history is not treated as safe" (vendor docs).
- **Greptile:** 0–5 confidence and auto-approve at 5/5. Round one found the score weakly calibrated.

**Evidence.**
- Round one's re-analysis: severity gating works only while severity stays calibrated (Greptile v4.1 against the pre-release v5 build).
- **Kodus offers an operational check of calibration (vendor docs):** implementation rate by severity "should be a descending gradient (critical implemented more than low). If it looks flat or inverted, severity isn't guiding the team". Its "Kodus only" toggle separates the model's own severities from rule severities.

**VectorScope.** It has severity, confidence and a verified tag. It lacks a verdict line and approval, which is correctly out of scope (contract §9). It also lacks any online calibration check of its severities.

### 2.9 Chat with the reviewer, steering, and memory commands

**Who has it.**
- **CodeRabbit:** `chat.auto_reply` (answers without being tagged) and chat-driven Jira or Linear issue creation (code: config).
- **PR-Agent:** `/ask`, including on selected diff lines; "the tool does not have 'memory' of previous questions" (code: docs).
- **Copilot:** replies to its comments are visible to humans, but "Copilot won't reply" (vendor docs).
- **Kodus (vendor docs).**
  - `@kody remember …` saves memories.
  - `@kody review focus on …` is a one-run **review directive** that "sets priority, not a filter" and "never suppresses findings outside the focus". Only the first line counts.
  - `@kody review heavy` selects the heavy mode.
- **Presubmit** answers questions in threads (vendor).

**Evidence.** None found on outcomes.

**VectorScope.** Partly. Thread questions reach the general @vector agent with the hunk as context (`github.handler.ts:853-856`), but that agent does not see VectorScope's evidence for the finding. There is no focus directive and no `remember` command; VS-11 and VS-20 plan approval-backed memory.
- A focus directive fits I-2 only as prompt *data* from an authorised commenter, used for priority. It must never set depth, model or scope.

### 2.10 Latency

Vendor claims:
- Copilot: "usually takes less than 30 seconds";
- PR-Agent `/describe`: "after ~30 seconds";
- Bugbot: about 90 s on average (June 2026);
- Greptile v5: median 2:25 (round one);
- Anthropic's security action: 20-minute default timeout.

Evidence on why latency matters, recalled from the code-review literature: Google's "Modern Code Review: A Case Study at Google" (ICSE-SEIP 2018) and Meta's 2022 work on "time in review". Both treat review latency as a primary developer-satisfaction metric.

VectorScope has no measured latency; its 12-minute timeout is an upper bound. Round one already proposed per-stage wall-time budgets (§6.8).

### 2.11 Pricing (only what round one lacked)

- **Kodus (vendor docs):**
  - Community is free (BYOK, self-host or cloud, up to 10 Kody Rules and 3 plugins).
  - Teams is $10 per developer per month plus BYOK tokens, cloud only.
  - "Reviews are unlimited on every plan."
  - A trial covers 5 reviews on Kodus-paid tokens.
- **Copilot:** members without a licence can be allowed to use code review, billed to the organisation; agentic review also consumes Actions minutes (vendor docs).
- **Sourcery:** free for public repositories (vendor README).

VectorScope's BYOK-in-your-own-CI model is closest to Kodus Community and PR-Agent: no seat fee, no token markup.

### 2.12 Privacy and self-host (only what round one lacked)

- **CodeRabbit:** `knowledge_base.opt_out` "Disable all knowledge base features that require data retention". Learnings, issues and PR indexing require retention, and `web_search` is on by default (code: config). A ZDR-minded VectorScope must therefore expect "memory" features to conflict with retention, as Brain-in-CI already does (VS-11).
- **Sourcery:** code retained for at most 30 days, no training, sent to both OpenAI and Anthropic (vendor).
- **Kodus:** self-host sends one anonymous daily heartbeat, opt-out by environment variable (vendor).
- **Anthropic's security action:** runs in the user's own Actions with their own key, but is explicitly unsafe on untrusted PRs. VectorScope's fork handling (never checking out fork code, settings from base) is stricter.

### 2.13 Outcome analytics: a feature category round one under-weighted

- **Kodus "Cockpit → Kodus Review" (vendor docs).**
  - Implementation rate overall, by category and by severity; negative-vote rate; "critical suggestions not yet addressed" on merged PRs; per-repository weakest category.
  - **Rule health:** Stale, Low data, Noisy (at least 3 downvotes, more downvotes than upvotes, at least 1 per 10 triggers) and Ignored (20% or less implemented).
  - "Kody Issues" track unimplemented suggestions after merge and auto-resolve them when a later PR implements them.
  - Small samples are faded.
- **Cursor and Greptile:** the same kind of metric, as resolution rate and addressed rate (round one).
- **Martian online benchmark (code, `online/README.md` @ e616e84).** It mines merged, bot-reviewed PRs, extracts the bot's suggestions and the human's later fixes, and an LLM judge matches them. That yields precision ("what % of the bot's advice was actually useful") and recall over real follow-up fixes, filterable by severity and size.
- **VectorScope already tracks per-finding fixed, still-open and dismissed state in its sticky markers** (today §2.6–2.7), so a resolution rate by severity, category and repository is computable with zero model calls. It lacks the aggregation.

### 2.14 Effort tiers and local review (brief)

- **Effort tiers.** Copilot Lite/Balanced/Max and Bugbot effort levels are in round one. Kodus `@kody review heavy` is new here. VS-28's `depth: auto` covers the automatic half; a user-selectable "deep" per review is missing.
- **Local pre-PR review** is now standard: Copilot in the IDE ("Review uncommitted changes") and CLI `/review`, Greptile CLI, Kodus CLI, Codex `/review`. VectorScope already has CLI and desktop local review and is at parity here.

## 3. What not to copy (evidence-weighted)

- **Reaction-based learned suppression.** Kodus's docs now say: "Reaction-based fine-tuning is not currently active … A thumbs-up or thumbs-down alone does not explain why a suggestion was rejected." Kodus relies on explicit memories and approved generated rules instead (`learning/kody_learning.mdx`, vendor). Round one ranked "turn feedback into rules or memory" B- and called Greptile's embedding filter its best-documented technique. A competitor deliberately turning the reaction-only form off weakens it further and supports the contract's §9 choice (explicit dismissals and VS-11 approval-backed memory, not embeddings).
- **Auto-approve or a merge-readiness score.** Copilot approvals can satisfy required reviews. Greptile auto-approves at 5/5, yet round one found its confidence weakly calibrated. If ever considered, Kodus's deterministic holds are the safer pattern: sensitive paths, control-flow change without a test, missing history treated as unsafe, any failure holds. Keep it out of scope, as contract §9 does.
- **Novelty output.** CodeRabbit's `poem: true` and `in_progress_fortune` are on by default. Every extra block competes with the finding for attention; round one cited that long comments are acted on less.
- **Running repository-configured linters inside the review job.** This is the CodeRabbit RCE pattern; VS-18 already forbids it.

## 4. The five gaps most worth closing, with evidence

1. **Close the review → fix → re-review loop, with consent, locally first.**
   - **Field:** "Fix with Copilot" (vendor); Kodus `--prompt-only --fix --fail-on` (vendor); Greptile `greploop` and `check-pr` (code); Codex finding selection (code); Bugbot Autofix (round one).
   - **Evidence:** suggestion-bearing comments get resolved more (arXiv 2607.21997, search extract; Sun et al. 2025, recalled); Autofix remediates about 3x faster (vendor, recalled).
   - **VectorScope:** GitHub `/vector fix` exists through @vector without D10's per-operation consent; CLI and desktop have no apply step.
   - **Action:** land VS-12's local consented apply on the VS-27 StrictResult JSON. The user selects findings; Vector applies each in an isolated worktree with FileLock; then VectorScope re-reviews only the fixed range. Bind GitHub `/vector fix` to the VS-13 contract when @vector merges.
2. **Ship outcome telemetry from VectorScope's own state: resolution rate by severity, category and repository, plus severity calibration.**
   - **Field:** Kodus Cockpit (vendor), Cursor resolution rate, Greptile addressed rate (round one), Martian online method (code).
   - **Evidence:** round one's main finding that measurement is the biggest gap; Greptile v5's severity inflation silently broke the severity gate, which a per-severity resolution gradient would have shown.
   - **VectorScope:** fixed, open and dismissed state per finding already exists in sticky markers.
   - **Action:** a zero-token, local-only report, `vector review stats` or a desktop panel (D14 permitting), plus an eval-side "online replay" over the owner's own merged PRs. It is consistent with I-13 (results stay internal) and gives D2 real-world denominators that the 20 held-out bugs cannot.
3. **Read scoped coding-agent instruction files and cite them.**
   - **Field:** Copilot path-specific `*.instructions.md` and `AGENTS.md` (vendor); Kodus's 9 file families, nearest-first, 8 files and 64 KB, quote required (vendor); the Codex rubric's rule attribution and "do not invent findings solely because a rule file exists" (code); Greptile auto-ingests `CLAUDE.md`, `AGENTS.md` and `.cursorrules` (round one).
   - **Evidence:** Tier C (no measured lift), but near-zero cost and deterministic.
   - **VectorScope:** reads only root `AGENTS.md` or `CLAUDE.md` and `.vector/RULES.md`.
   - **Action:** extend `baseInstructions` to nested `AGENTS.md`/`CLAUDE.md` and to `.github/instructions/**` (honouring `applyTo`), read from base. Keep these as untrusted data (I-2) and extend `rule from …` citations to name the source file. As a policy key it is cheap to A/B in Phase A.
4. **Requirement-by-requirement linked-issue validation.**
   - **Field:** PR-Agent ticket compliance labels (code); Kodus Business Logic with five states and code citations (vendor); CodeRabbit `assess_linked_issues` and `issue_assessment` (code: config); Greptile and Baz Jira/Linear (round one).
   - **Evidence:** vendor only. It targets a defect class diff review cannot see: a missing requirement. It is the closest shipping analogue to "predict bugs before they ship" in a non-speculative form.
   - **VectorScope:** VS-16 plans the same-repository issue input.
   - **Action:** add to VS-16 a structured output, met / missing / check-manually per requirement, each with `path:line` evidence. Adopt PR-Agent's two guards: a host-configured cross-repository allowlist, and resolving a reference only when the tracker returns that exact id. Jira and Linear only through VS-15's fixed MCP snapshots.
5. **Deterministic secret and dependency scanning as evidence (pull VS-18's offline half forward).**
   - **Field:** CodeRabbit gitleaks, semgrep and checkov (code: config); Kodus pinned betterleaks and osv-scanner (round one); Bito; Copilot CodeQL with Autofix validation (vendor).
   - **Evidence:** deterministic, high-precision, cheap. The CodeRabbit RCE shows how to do it wrongly.
   - **Action:** pinned binaries, offline, never the PR's config, output wrapped as untrusted evidence, no secret ever printed.

**Runner-up: a PR description or walkthrough.** It is cheap (reuse `summary` and `files[].note`) and backed by the Xiao et al. FSE 2024 description study (recalled). It is ranked sixth only because it is user-facing (D14) and does not raise defect-finding quality.

## 5. Corrections and extensions to round one

- **Correction.** VectorScope is not without a fix or chat path on GitHub. `/vector fix` and `/vector <question>` already route to the @vector agent on `main` (`github.handler.ts:853-871`), and trusted inline comments advertise `/vector fix` (`format.ts:321-322`). What is missing is the consented contract (VS-12/13), and a reviewer that answers with its own evidence.
- **Extension to future-bug prediction.**
  - Kodus ships a per-file "code hotspots" history, refreshed every 2 hours on GitHub and GitLab: merged PRs touching each file, and how many fixed a bug (closing an issue labelled `bug`, `defect` or `regression`, or titled fix, bug, regression or hotfix).
  - It uses the history only to gate auto-approve risk and in a Cockpit view, not to post predictions.
  - This independently matches VS-28's design (fix density decides depth; never posted as a forecast). Round one's "no hotspot feature found at Greptile" stands, but such a feature does exist in the field (vendor docs).
- **Weakening.** Reaction-based learning: one vendor deactivated it (section 3).
- **Confirmation.** Effort tiers and local review are now universal. VectorScope's incremental review is stronger than Copilot's documented behaviour, which can repeat dismissed comments.
