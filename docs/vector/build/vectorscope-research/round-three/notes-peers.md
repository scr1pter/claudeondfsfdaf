# Round three, lens "Large-codebase context and precision in peer tools": notes for VectorScope

Lane note as written before the adversarial verify pass; REPORT-3 states each finding in its verified, corrected form.

Prepared 2026-11-07. Research only: nothing in the worktree was edited, built or run, no Bun command ran, nothing was cloned, and this file is the only file written. The worktree was read at `41a64e5e`.

Finding IDs in brackets ([P1] to [P19]) match the structured result.

## 0. Access and method

- **Reachable, and used as primary sources:**
  - `code.claude.com`: Anthropic's Code Review, `/code-review` and ultrareview docs, read in full;
  - `github.com` and `raw.githubusercontent.com`: Anthropic's official plugin repository, `github/docs`, and one OpenAI repository's commit list.
- **Refused (DNS):** `cursor.com` and `alignment.openai.com`. Following the fetch tool's stop rule, I probed no further hosts after those two. So `claude.com`, `claude.dev`, `github.blog`, `coderabbit.ai`, `qodo.ai`, `graphite.com`, `augmentcode.com`, `ampcode.com`, `blog.sentry.io`, `cubic.dev` and `docs.baz.co` were **not fetched**. Everything from them below is a **search extract**: the search tool's excerpt, whose wording may differ from the page.
- **WebSearch** ran about 35 queries before the shared per-turn budget (200) ran out. After that, only fetches to the reachable hosts above were made.
- **Labels:**
  - *vendor*: a company about itself, docs included;
  - *code*: read in source at a named commit;
  - *independent*: a third party measured it;
  - *community*: a third party's opinion or anecdote;
  - *secondary*: press or aggregator coverage of a vendor statement;
  - *inference*: my own reasoning, always flagged.
- **Overlap with sibling round-three lanes.** Field studies of accepted-comment rates (Sun et al., RovoDev, "Go Home Copilot", AI-to-AI review) are in `notes-benchmarks.md`. Greptile is in `notes-greptile.md`, and prediction research is in `notes-prediction.md`. They are cited here only where a peer technique depends on them.

---

## 1. What rounds one and two concluded on this lens, and what they left open

**Concluded (not repeated):**
- **Round one** (REPORT §3.2, landscape §2):
  - Techniques ranked by evidence. Agentic investigation is A-/B. Generate-then-verify is B+. Single-class lenses are B. Deterministic quote and anchor checks are B. Learned rules are B-. Sandbox execution is D, and voting is D ("Cursor moved away from voting").
  - Bugbot v1 ran 8 parallel passes with majority voting, then moved to an agentic design. Its resolution rate went from 52% to over 70%, and later to 78%.
  - Graphite showed 96% positive feedback (vendor), and P 1.0 / R 0.07 on Martian.
  - CodeRabbit's verification scripts were "unconfirmed".
  - Copilot offers Lite/Balanced/Max effort levels and agentic gathering on Actions runners.
  - Ellipsis runs parallel generators plus a filtering pipeline.
  - Qodo 2.0 uses a judge agent, and Bito uses static analysers.
- **Round two** (REPORT §4, §6, §7; notes `large-codebase-industry.md`, `competitor-features.md`):
  - Reviewers build a graph per review (CodeRabbit) or gather context agentically on a runner (Copilot), rather than reading a persistent index.
  - Do not add embeddings, a symbol tool or a trigram index.
  - Gate dependents before capping them; fuse rankers with RRF; pack the enclosing scope plus depth-1 outbound signatures.
  - Feedback should act on rules with health states (Kodus), not on reactions.
  - VectorScope's one-pattern team-dismissed loop is a poisoning path.

**Left open:**
- the pipelines of Augment and Cubic (round one §7);
- whether CodeRabbit runs verification scripts (round one);
- the "Graphite Agent" name (round one);
- Qodo 3.0, recorded as "unverified" (round two);
- Bugbot's retrieval, of which round two found "no write-up";
- every vendor blog, read only as search extracts (both rounds).

**What round two did not record at all:**
- Anthropic's managed Code Review (launched 2026-03-09), its ultrareview, and its open-source review plugin;
- OpenAI's write-up on its reviewer;
- Copilot's 60-million-review post and its August and September 2026 changes;
- Sentry's AI Code Review;
- Amp's review checks;
- CodeRabbit Secure's runtime verification;
- Qodo's cross-repo review and Rule Miner;
- Korbit's acquisition.

These are this round's main additions.

---

## 2. What is new, peer by peer

### 2.1 Anthropic: managed Code Review, ultrareview, `/code-review`, and the open-source plugin (vendor docs and code; mostly primary)

**Managed Code Review** (code.claude.com/docs/en/code-review, page undated, read 2026-11-07) [P1]:
- **Four stages:** "1. **Find**: several agents examine the diff and the surrounding code in parallel. 2. **Verify**: a verification step checks the candidate findings against the code and filters out false positives. 3. **Rank**: the findings that remain are deduplicated and ranked by severity. 4. **Post**".
- **Reads only.** "a review works from reading the diff and the surrounding code, without building or running your code."
- **No model choice.** "Code Review chooses the Claude models that reviews run on, and its admin settings don't offer a model choice."
- **Three severities** (code-review-pull-requests): Important ("A bug that should be fixed before merging"), Nit, and **Pre-existing** ("A bug that exists in the codebase but wasn't introduced by this PR"). A collapsed "**Why this was flagged**" section says "why Claude flagged the issue and how it verified the problem".
- **Never a failing check.** "A review never approves or blocks your pull request, and the check run never concludes as a failure."
  - The machine-readable result is an HTML comment holding severity counts: `<!-- bughunter-severity: {"nit":1,"normal":2,"pre_existing":0} -->`.
  - A missing line must be read as no verdict: "Treat that as no verdict rather than as zero findings. A check run for a review that failed, timed out, was canceled, or was superseded by a newer one has no such line".
- **Re-reviews:**
  - "A later review that starts on its own, such as after a push, focuses on what changed since the last review and posts fewer nits and pre-existing findings." The body then counts what it left out, in sentences ending "outside the scope of this re-review and not posted" and "found and not posted".
  - A push can keep the earlier result when "The pull request still adds and removes the same lines, as after an empty commit, a clean merge of the base branch, or a clean rebase" and "Nobody has resolved an Important finding's thread since that review".
- **Budget.** "Code Review also skips reviews once what's left is less than the expected cost of one review." A PR comment then names the limit that was reached (code-review-costs, code-review-troubleshooting).
- **Availability.** "Code Review isn't available to organizations with Zero Data Retention enabled or with the HIPAA configuration applied, and isn't covered under Anthropic's Business Associate Agreement (BAA)." [P2]

**Trusted instructions** (code-review-customize) [P3]:
- **Which files.** "A review reads the `CLAUDE.md` at your repository root and the `CLAUDE.md` files in the parent directories of each changed file."
- **Never the PR's copy.** `REVIEW.md` is read "from the pull request's base branch or from the default branch, never from the pull request's own changes."
- **Suppression needs a protected branch.** Only "When a review reads the copy on a protected default branch" does it honour "Lowering a finding's severity", "Excluding paths, files, or classes of issue" and "Capping nit comments". An unprotected default branch yields the root file only. Where protection cannot be confirmed, no `REVIEW.md` is read at all.
- **Directories whose `REVIEW.md` is ignored:**
  - tests: `test`, `tests`, `__tests__`, `testdata`, `fixtures`, `__fixtures__`, `golden`, `corpus`, `snapshots`, `__snapshots__`;
  - examples: `example`, `examples`, `sample`, `samples`, `demo`, `demos`;
  - generated code: `generated`;
  - third-party code: `vendor`, `third_party`, `third-party`, `thirdparty`, `node_modules`, `bower_components`, `external`, `extern`, `deps`, `godeps`, `pods`, `carthage`, `site-packages`, `contrib`.
- **Caps:**
  - "The remaining subdirectory `REVIEW.md` files on the paths a pull request changes share a limit of 150,000 bytes, not counting the root file."
  - At most eight included files;
  - "keep Markdown links at 64 or fewer" — past that, the whole root file is skipped.
- **PR-controlled links.** A `REVIEW.md` that links to a file the PR changes is skipped (troubleshooting: "it links to a file or folder this pull request changes").
- **Evidence rules as false-positive control.** The docs suggest writing them into `REVIEW.md`, for example: "behavior claims need a `file:line` citation in the source, not an inference from naming".

**Ultrareview** (code.claude.com/docs/en/ultrareview, research preview, undated) [P4, P10]:
- "every reported finding is independently reproduced and verified, so the results focus on real bugs rather than style suggestions".
- "a larger fleet of reviewer agents explores the change in parallel".
- **Limits:** "a branch review can include up to 500 changed files and 8,000 changed lines by default."
- **Time and cost:** "A review typically takes 5 to 15 minutes." Cost is "typically $5 to $25 in usage credits depending on the size of the change".
- **Not available** "to organizations that have enabled Zero Data Retention".

**Local `/code-review`** (code.claude.com/docs/en/code-review-local) [P17]:
- "At `low`, the review reports the findings it's most confident in, so you see fewer false positives. From `medium` through `max`, the review broadens coverage."
- "Where the review reports through the findings tool, the limit is 32."

**Open-source plugin** (`anthropics/claude-plugins-official`, `plugins/code-review`; code) [P4, P5]:
- The command file was replaced on **2026-10-26** by commit `c905cd8`, "code-review: bring in the newer command from anthropics/claude-code". The README was touched in the same commit but still describes the old design.
- **README (old design):** "Launches 4 parallel agents". Agents #1 and #2 audit CLAUDE.md, #3 scans for bugs, and #4 analyses "git blame/history". "Scores each issue 0-100 for confidence level" and "Filters out issues below 80 confidence threshold".
- **Command (new design):**
  - Four parallel reviewers. Two Sonnet agents check CLAUDE.md compliance.
  - Two Opus bug agents. Agent 3 is told "Focus only on the diff itself without reading extra context". Agent 4 is told "Only look for issues that fall within the changed code".
  - Then **one validation subagent per flagged issue**: "Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations". Its job is "to validate that the stated issue is truly an issue with high confidence".
  - There is no numeric confidence threshold and no git-history agent. The rule is "If you are not certain an issue is real, do not flag it."
- **Inference:** in its own open reviewer, Anthropic replaced a self-reported 0–100 score with independent per-issue validation, and dropped the history agent.

**Launch figures** (search extract of claude.com/blog/code-review and x.com/claudeai/status/2031088173510701125, 2026-03-09; vendor):
- "Engineers largely agree with what it surfaces: less than 1% of findings are marked incorrect."
- "PRs w/ substantive review comments went from 16% → 54% <1% of review findings are marked incorrect by engineers On large PRs (1,000+ lines), 84% surface findings, avg 7.5 issues each".
- Small PRs: "PRs under 50 lines" get findings in 31% of cases, averaging 0.5 issues (extract wording).
- These are internal figures. No independent audit was found [P8, P18].

**"How the Claude Code team does code review"** (claude.dev/blog/solving-code-review-at-anthropic, 2026-10-15; **secondary only**, the post itself was not read):
- Summaries say several agents hunt bugs and another group votes on whether each finding is real, with only the survivors posted.
- A risk tier (classifier, trusted-author lists, sensitive paths) sets 0, 1 or 2 human approvals.
- "merged PRs more than doubled and the share reverted fell by more than 40%" (secondary extract) [P6, P19].
- A community critique argues every reviewer in that process is Claude ("no second model"; paddo.dev, undated).

### 2.2 OpenAI (search extracts; primary blocked) [P16]

"A Practical Approach to Verifying Code at Scale" (alignment.openai.com/scaling-code-verification, undated in extracts) and a FAR.AI talk by Maja Trębacz (undated):
- **Precision first.** A section is headed "Precision is more important for usability than recall". Training-time checks favour recall, and "Deployed code review has the inverse priorities."
- **Tools and execution.** The reviewer is dedicated and trained. Repository-wide tools and execution access are credited with raising both recall and precision (extract paraphrase).
- **Comment rate.** "Codex code review makes comments on 36% of the PRs that were entirely generated by Codex cloud."
- **Coverage and reactions.** "100% of the PRs published within OpenAI internal repositories are reviewed by our code review model" (talk summary). Over 80% of reactions are positive (talk summary).
- **Unconfirmed.** A 52.7% "addressed with a code change" figure appears only in secondaries. Do not cite it.
- **Judging is hard.** The talk: "it's still very hard to assess whether a code review comment is correct or not when it's not really your code."
- OpenAI's open-source CLI review rubric is unchanged since round two: last commit `81de4f2`, 2026-07-21, "Attribute review findings to repository rules". The repository path is withheld per the round-two naming convention.

### 2.3 GitHub Copilot code review (search extracts of github.blog; docs primary)

- **"60 million Copilot code reviews and counting"** (github.blog, March 2026):
  - "in 71% of the reviews, Copilot code review surfaces actionable feedback". A daily.dev summary adds that in the other 29% "it stays silent rather than adding noise".
  - It "can maintain memory across reviews".
  - The "5.1 comments per review" figure is third-party only [P8].
- **2026-03-05 changelog:** agentic tool calling "to gather broader repository context as needed (e.g., relevant code, directory structure, and references)" (round one had this from an extract).
- **2026-08-27** (secondary): reviews of bot-authored PRs, **the previous size limit for large PRs removed**, and resolution reasons.
- **2026-09-18 changelog:** "Copilot now resolves comments with a resolution reason, either Won't Fix or Incorrect, based on your subsequent commits", and it honours replies asking to leave a comment open [P7].
- **2026-09-28** (secondary): the default effort moved from Lite to Balanced.
- The current docs (`github/docs`, concept page) describe no confidence threshold, comment cap or silent-review mechanism. The responsible-use card gives no false-positive figure.

### 2.4 Cursor Bugbot and Graphite

- **Bugbot.** Nothing new since round two:
  - effort levels Default, High and Custom (May 2026);
  - "Bugbot is now over 3x faster, 22% cheaper, and finds 10% more bugs" with Composer 2.5 (2026-06-10, secondary);
  - `/review` before push.
  - No retrieval write-up exists. cursor.com is blocked.
- **Graphite** (search extract of graphite.com/diamond, undated) [P14]:
  - "as of 10/08/2025, the Diamond name has been deprecated, and AI code review capabilities now slot under Graphite Agent".
  - Graphite "is joining Cursor".
  - The product page claims a "less than 5% negative comment rate"; other pages say under 3%. No method is given (vendor).
  - This closes round one's open "Graphite Agent" name.

### 2.5 CodeRabbit (search extracts; vendor) [P10, P11]

- **CodeRabbit Secure** (blog 2026-10-28, "CodeRabbit Secure now hunts across repos and beyond the merge"; "How Runtime Verification works in CodeRabbit Secure"):
  - Each Deep Scan finding becomes a reproducer guide.
  - Runtime Analysis runs it "in a prepared environment, and shows whether the application was ready and the intended code path was exercised". "Results apply only to the tested revision and environment."
  - "Before generating a guide, CodeRabbit rechecks whether the issue still exists".
  - Findings are followed through linked repositories. Admins can block merges on open critical findings.
  - No false-positive figure is published.
- **Inference.** This partly answers round one's "verification scripts in a sandbox": CodeRabbit's security product does run reproducers. Whether its general PR review does is still unconfirmed.
- The IDE extension changelog for October 2026 (0.23 to 0.25) has nothing on the review pipeline.

### 2.6 Qodo (search extracts; vendor) [P9, P11]

- **June 2026** (Help Net Security 2026-06-24; The New Stack):
  - Cross-Repo Code Review: "a Cross Repo Agent identifies downstream consumers, breaking changes, and blast radius".
  - A Custom Rules Miner: "Every mined rule links back to the comment source it came from, and mined rules can go live automatically or sit in suggested mode for human review first."
- **Qodo's glossary** (undated):
  - It names missing context as a main cause of false positives: the tool "sees the diff and not the callers, the config or the code that already handles the case".
  - Rules "whose findings are rarely fixed switch off once Rule enforcement is on".
- **Qodo 3.0** (post undated in extracts): PR Triage (research preview), a "Software Map" that "draws the blast radius of a change", fix-rate analytics, and an MCP/CLI "Agentic Toolbox".
- **Unverified.** One extract attributes "precision from 0.80 to 0.82" to a Qodo post. The figure could not be found on any page, so it is unverified and not used.

### 2.7 Sourcegraph Amp (search extracts; vendor) [P13]

"Liberating Code Review" (ampcode.com/news/liberating-code-review, 2026-02-04):
- The review agent is a subroutine (`amp review`).
- "Checks are user-defined invariants or review criteria scoped to specific parts of your codebase, defined in .agents/checks/ directories. The code_review tool will kick off a separate agent for each check."
- Amp says this is "a stronger guarantee that each check will actually be checked than if the checks were embedded in a general context file like AGENTS.md".

### 2.8 Augment (search extracts; vendor)

"How we built a high-quality AI code review agent" (March 2026) still could not be read beyond extracts:
- "We found that four parts of the system had the biggest impact on review quality" (the four are not in the extract);
- guidelines "become machine-readable constraints";
- online, "We are able to compute whether each comment posted by Augment is addressed by a human developer".

**Round one's open "Augment pipeline" stays partly open.**

### 2.9 Sentry AI Code Review, part of Seer (search extracts; vendor) [P4, P12]

"Building a Code Review system that uses prod data to predict bugs" (blog.sentry.io; date not confirmed, search metadata suggests late 2025). The product launched 2025-09-23 (BusinessWire).
- "A drafting agent creates a report containing an initial analysis of potential bugs. This report is split into at most 3 bug hypotheses."
- Each hypothesis gets its own verifier, "by focusing the verifying agents into a single hypothesis they can deep dive and more correctly assert if that is a valid bug or not".
- "Each verify agent has access to tools to fetch sentry issues and event details."
- It is the only peer found that grounds review findings in **production failure history**.

### 2.10 Cubic, Baz, Bito, Devin Review, Macroscope, Korbit, Ellipsis (search extracts) [P13, P15]

- **Cubic** ("Learnings from building AI agents", cubic.dev, June 2025; vendor; answers round one's open "Cubic pipeline"):
  - "reduced false positives by 51% without sacrificing recall" after "explicit reasoning logs, streamlined tooling, and specialized micro-agents".
  - The reasoning logs showed that most analyses used a few core tools, and that extra tools caused mistakes.
  - Prompts such as "ignore minor style issues" "had minimal effect".
  - An HN commenter disputes its confidence levels (community).
- **Baz** (docs.baz.co/agents, undated; vendor): "Logical Bugs reviewer is tuned to reduce false positives by requiring multi-source evidence (retrieval + AST +, where possible, runtime traces)". The Evaluations docs track agree, disagree and follow-up per comment.
- **Bito** (bito.ai blog, undated; vendor):
  - its review agent runs on the AI Architect knowledge graph;
  - it claims "merge PRs 89% faster with 34% fewer regressions", with no method given.
- **Devin Review** (Cognition, about 2026-01-21; vendor): diffs grouped logically; the Bug Catcher labels output "Severe bugs require immediate attention. Non-severe bugs should still be reviewed. Flags are informational annotations."
- **Macroscope** (third-party only):
  - an AST graph, then a second-model "consensus" filter;
  - an unsourced "98%" precision claim.

  Low credibility.
- **Korbit:** acquired by Boost Security, announced 2026-05-06 (aggregator extract). The standalone product looks absorbed. Drop it from the peer set.
- **Ellipsis:** nothing new found.

---

## 3. Corrections and contradictions to rounds one and two

1. **Voting is not abandoned in the field** [P6]. Round one ranked "voting across several models" at D and said Cursor had moved away from it.
   - Anthropic's managed service runs several finders in parallel, then verifies (primary docs).
   - Its internal process reportedly decides findings by agents that vote (secondary).
   - Macroscope reportedly uses a second-model consensus (third-party).
   - There is still no public ablation. Revised tier: **C**, adopted by a first-party vendor but unmeasured. Same-family voting is not cross-family verification. The "no second model" critique is anecdotal.
2. **Self-reported confidence thresholds are being replaced** [P4].
   - Round one listed PR-Agent's reflection score and confidence filters as standard practice.
   - Anthropic's own open reviewer dropped its 0–100 score with threshold 80 for per-issue validation subagents (code, 2026-10-26).
   - VectorScope still filters on `minConfidence: 0.7` (`types.ts:502`), a model-reported number.
3. **Pre-existing bugs: drop or label?** [P1]
   - VS-42a's S9 drops them under `scopeGate: introduced`.
   - Anthropic's managed service posts them with their own severity, and posts fewer on re-reviews.
   - Its plugin drops them.
   - Both, when they omit something, say how much they omitted. VectorScope's strict summary counts only cap drops (`format.ts:766`).
4. **Size limits** [P17].
   - Copilot removed its large-PR size limit (2026-08-27, secondary).
   - Ultrareview refuses above 500 files or 8,000 lines.
   - VectorScope skips above 300 files or 5,000 changed lines (`types.ts:517-518`, applied in `skip.ts`).
   - This is not a contradiction, but the field is moving toward reviewing large PRs, which raises VS-19's priority.
5. **"Marked incorrect" is not a false-positive rate** [P18]. Anthropic's "<1% of findings are marked incorrect" counts explicit negative marks only.
   - Its own docs say "Replying alone doesn't dismiss a finding".
   - Qodo's glossary definition differs again.
   - Inference: such figures are lower bounds on wrongness, not precision. Round two's GU and FL findings already warned that resolution signals are contaminated. This extends that warning to "marked incorrect".

---

## 4. Technique map: who does it, and where VectorScope stands

Status key:
- **called**: the runner uses it today;
- **built, uncalled**: merged pure or engine code that no runner calls (waits on Q13/Q18 wiring);
- **planned**: in the contract or addendum, not built;
- **lacks**.

| Technique | Peers (finding) | VectorScope | Status |
|---|---|---|---|
| Per-review import or code graph | CodeRabbit (round two), Macroscope (third-party), Bito KG [P11] | VS-25b gate-first dependents, `BrainGraph.rank`; VS-37a three-tier packing | built, uncalled (`impact: graph`) |
| Persistent semantic index or embeddings | Augment, Cursor, Qodo context engine | none, by round-two decision (embeddings conflict with ZDR) | lacks, deliberately |
| Cross-repo context | Qodo (Jun 2026), CodeRabbit Secure (Oct 2026), Bito [P11] | none | lacks; only a trusted pre-exposure snapshot (VS-15) could allow it |
| Agentic exploration with read tools | Copilot, OpenAI, Anthropic, Bugbot, Amp [P16] | Tier 2 specialists with read/grep/glob/list | called |
| Exploration instrumentation | Cubic reasoning logs [P13] | VS-49a artifact fields | built, uncalled (observer waits) |
| Retrieval rank fusion | Sourcegraph RRF (round two) | VS-36 item 3 deferred; graph rank only | planned |
| Parallel specialist finders | Anthropic, Qodo, Cubic, Amp per-check agents [P13] | review + security specialists; VS-28 lenses (`LENS_TASKS` in `prompt.ts`, key unapplied) | called (two specialists); lenses planned |
| Diff-only finder | Anthropic plugin [P5] | none | lacks |
| Batched verification | (most peers, undocumented) | `run.ts:715-780` verify pass (VS-06 policy) | called |
| Per-finding isolated verification | Anthropic plugin, Sentry, ultrareview [P4] | none (VS-44's certificate is still one batched call) | lacks |
| Evidence-checked verdicts | Baz multi-source, Cubic explicit reasoning, Anthropic "Why this was flagged" [P13] | VS-27b S4 quote match; VS-44a certificate `certified()` | built, uncalled |
| Same-family voting | Anthropic internal (secondary), Bugbot v1 [P6] | none | lacks |
| Cross-family verification | Macroscope (third-party), "no second model" critique [P6] | VS-29a through `triageModel`/`model`; replay variant | called when configured; measurement built |
| Runtime reproduction of findings | ultrareview, CodeRabbit Secure, OpenAI (execution), Baz traces [P10] | VS-30c runtime contract (pure); existing opt-in `--checks` | built, uncalled |
| Pre-existing handling | Anthropic labels; plugin drops [P1] | VS-42a S9 drop | built, uncalled; no omitted-count line |
| Severity calibration | Anthropic redefines "Important" in `REVIEW.md`; Devin severe/non-severe/flag | blocking/concern/nit labels; VS-45a judging | labels called; VS-45a eval built |
| Comment budgets | Anthropic nit caps, 32-finding tool limit [P17] | `maxComments` 10, `maxCommentsPerPr` 25, clamp 50; strict S8 | called |
| Focused re-review with omitted counts | Anthropic [P1] | incremental `planRange` and "carried" force-push (called); VS-41 focused | partly called; VS-41 planned |
| Machine-readable verdict, missing = no verdict | Anthropic severity JSON [P1] | VS-32a `reviewVerdict` | built, uncalled |
| Budget skip before dispatch | Anthropic [P1] | VS-24c `decideDispatch` | built, uncalled |
| Path-scoped trusted instructions | Anthropic (parent CLAUDE.md, subdirectory REVIEW.md, protected branch), Amp checks, Copilot [P3] | `rulesForPaths` (called); VS-48 nested files | partly called; VS-48 planned |
| Rule-level learning with health and provenance | Qodo Rule Miner and auto-off, Bugbot learned rules, Kodus [P9] | `teamPatterns` (called; poisoning path), VS-35a guarded helpers, VS-46a outcome script | legacy called; guarded version built, uncalled |
| Dismissal reason classes | Copilot "Won't Fix" / "Incorrect" [P7] | `classifyPrior` has no reason class | lacks |
| Production-grounded bug prediction | Sentry Seer [P12] | VS-46a merge outcomes; VS-28c risk; VS-46 item 6 history areas | partly (git history only) |
| Risk-tiered human attention | Anthropic internal (secondary) [P19] | VS-28c bands; VS-47 receipt band (Q28) | built pure, uncalled |
| Measured false-positive rate | vendor self-reports only [P18] | VS-21 and VS-04 harness, D2 gate | built; dry runs only until D7 |

---

## 5. Proposals (all off by default, eval-first, ZDR-only, no new outbound route, no customer data leaving except as the contract allows)

1. **[P4] Per-finding isolated verification.** An eval variant first, `engine:verify-isolated`, in the VS-44 family.
   - **Design.** Verify each of the top-k (default 3, matching Sentry's cap) blocking candidates in its own verify call:
     - blind, as VS-44 is: no reviewer body or suggestion;
     - each attempt admitted by the ledger (I-5) and estimated by VS-40;
     - on the review model's ZDR route (I-3);
     - the remaining candidates go through today's batched pass.
   - **Why.** Anthropic's plugin, Sentry and ultrareview all isolate. VectorScope batches every candidate into one call, where verdicts can anchor on each other (inference).
   - **Kill criteria (Q9 ablation):** kill if any of these holds:
     - the precision gain is under 3 points, or its lower bound is below 0;
     - verify tokens rise more than 60%;
     - class-scoped recall falls more than 5 points.
   - **Placement.** A pure planner in core `plan.ts`; the runner changes wait for the wiring window.
2. **[P1] Count what strict selection omitted.** Zero tokens, format only.
   - When `strictSelect` drops `pre-existing` or `not-blocking` findings, the summary adds one deterministic sentence, for example "N pre-existing and M non-blocking findings found and not posted". It is computed from `StrictResult.dropped`, beside today's cap sentence (`format.ts:760-769`).
   - This keeps I-7's honesty when the precision-first S2 and S9 rules empty a review.
   - User-visible text, so it ships only behind `guardrail: strict` and after D14.
3. **[P3] Amend VS-48 (nested instruction files) before it is built.**
   - (a) **Directory denylist.** Never collect a nested AGENTS.md, CLAUDE.md or `.instructions.md` whose path has a segment on Anthropic's list (tests, fixtures, examples, generated, vendor, `node_modules`, `third_party` and so on). Vendored packages carry their own agent files, which would otherwise become trusted rules (inference). Add a VS-22 count of how often this happens in D8-clean repositories.
   - (b) **Split suppressive from additive directives.**
     - Suppressive: exclude a path or class, lower severity, cap nits.
     - Additive: always check X.
     - In CI, suppressive directives apply only when trusted base protection is confirmed, as Anthropic requires; otherwise they are ignored with a note.
     - Whether the existing GitHub token can read branch rules with no new App permission (D9) is open question 1. If it cannot, suppressive directives come from base `review.json` only and are listed in the VS-47 receipt.
   - (c) **Caps.** Keep VS-48's 8 files and 64 KB, which are already tighter than Anthropic's 150,000 bytes.
4. **[P7] Dismissal reason classes for VS-35 and VS-46.**
   - Classify each writer dismissal reply as `incorrect`, `wont-fix` or `unknown`, by a fixed word-anchored rule on trusted-actor replies. Untrusted text may only exclude data (I-2).
   - Only `incorrect` from a non-author writer may feed a pending Brain proposal. `wont-fix` never suppresses.
   - VS-46 reports the split by severity.
   - Pure and zero-token, it follows Copilot's 2026-09-18 change.
5. **[P5] Diff-only lens.** An eval variant: `lenses: high` plus a `diff` member that has no read tools and no slice. Its findings join the union before verify, like the other lenses.
   - Measured against VS-37's context-level labels: keep it only if diff-level recall rises at least 3 points without a rise in false alarms per clean PR.
   - Motivation: Anthropic's plugin runs exactly this agent, and round two's AACR evidence says agents lose diff-level issues ("tunnel vision").
6. **[P12] Production-grounded hypotheses, history only.** No telemetry and no live calls.
   - Extend VS-46 item 6. Where a changed hunk overlaps lines that an earlier revert or follow-up fix touched (from the sealed outcome ledger, computed from git history on the base branch), pass a one-line wrapped fact into the review prompt. Its form is "this region was reverted N times", never a verdict (I-2).
   - Gated on VS-46's band-separation rule. Off unless the owner sets it in trusted config.
   - Sentry's use of Sentry issue data is the peer model. VectorScope must not fetch production data, because of D11 and the MCP rules.
7. **[P9] Rule health for the guarded team memory (VS-35 wiring).**
   - The fix rate per rule comes from VS-46 outcomes.
   - Demote only, after at least 5 triggers.
   - Every rule keeps a link to its source thread, as Qodo's Rule Miner does.
   - New rules stay pending until the owner approves them, never live by default. That is stricter than Qodo's auto-live option, and consistent with round two's FL17.

No proposal for [P2], [P6], [P8], [P10], [P11], [P13] to [P19] beyond what the contract already plans, except the measurement notes in the structured result.

---

## 6. Open questions

1. Can VectorScope's existing GitHub credentials read a base branch's protection or rulesets without a new App permission (D9)? This decides proposal 3(b).
2. Do Anthropic's managed Code Review find and verify stages use different models? The docs offer no model choice and do not say. This bears on the "no second model" critique and on VS-29a's prior.
3. The primary texts that could not be read: claude.dev's 2026-10-15 post (voting, risk tiers, the revert figure), OpenAI's alignment post, Cursor's Bugbot posts, Augment's March 2026 post, and Sentry's blog. Each needs its host allowed in the session's network settings. Until then, every number from them stays a search extract.
4. Has anyone published an ablation of isolated against batched verification, or of same-family voting against cross-family verification, at equal cost? None was found.
5. Qodo's "precision 0.80 to 0.82" figure: no page shows it, so it is unverified.
6. Copilot's 2026-08-27 removal of its size limit: the changelog itself was not read.
7. How often do D8-clean repositories carry nested agent instruction files in vendored or test directories? A zero-token VS-22 count would settle proposal 3(a)'s value.

---

## 7. Sources (accessed 2026-11-07; publication or last-updated date given, or "undated")

**Primary, read in full:**
- Anthropic Code Review docs (undated pages):
  - https://code.claude.com/docs/en/code-review
  - https://code.claude.com/docs/en/code-review-pull-requests.md
  - https://code.claude.com/docs/en/code-review-customize.md
  - https://code.claude.com/docs/en/code-review-costs.md
  - https://code.claude.com/docs/en/code-review-setup.md
  - https://code.claude.com/docs/en/code-review-troubleshooting.md
  - https://code.claude.com/docs/en/code-review-local.md
  - https://code.claude.com/docs/en/ultrareview.md
- Anthropic plugin code (commit `c905cd8`, 2026-10-26):
  - https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/commands/code-review.md
  - https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md
  - https://github.com/anthropics/claude-plugins-official/commits/main/plugins/code-review/commands/code-review.md
- GitHub docs (undated, main branch):
  - https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review.md
  - https://raw.githubusercontent.com/github/docs/main/content/copilot/responsible-use/agents.md

**Search extracts (pages not fetched):**
- Anthropic launch, 2026-03-09: https://claude.com/blog/code-review and https://x.com/claudeai/status/2031088173510701125
- Anthropic team post, 2026-10-15 (secondary): https://claude.dev/blog/solving-code-review-at-anthropic/ ; https://techbytes.app/posts/how-the-claude-code-team-does-code-review/ ; https://x.com/Prathkum/status/2111181973591077223 ; https://paddo.dev/blog/claude-reviewing-claude/ (undated)
- OpenAI, undated: https://alignment.openai.com/scaling-code-verification/ ; https://www.far.ai/event-recordings/maja-trbacz-a-practical-approach-to-verifying-code-at-scale
- GitHub:
  - https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/ (March 2026)
  - https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/ (2026-03-05)
  - https://github.blog/changelog/2026-09-18-copilot-code-review-an-improved-review-experience (2026-09-18)
  - https://startdebugging.net/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/ (August 2026, secondary)
  - https://vpsranking.com/news/ai/ai-2026-08-27-github-copilot-code-review-expanded/ (2026-08-27, secondary)
- Cursor and Graphite:
  - https://cursor.com/blog/building-bugbot (2026-01-15)
  - https://cursor.com/changelog/04-08-26 (2026-04-08)
  - https://graphite.com/diamond (undated)
- CodeRabbit:
  - https://www.coderabbit.ai/blog/coderabbit-secure-cross-repository-security (2026-10-28)
  - https://www.coderabbit.ai/blog/runtime-verification-in-coderabbit-secure (October 2026)
  - https://docs.coderabbit.ai/security/runtime-verification (undated)
- Qodo:
  - https://www.helpnetsecurity.com/2026/06/24/qodo-ai-generated-code-governance/ (2026-06-24)
  - https://thenewstack.io/qodo-cross-repo-code-review/ (June 2026)
  - https://www.qodo.ai/glossary/what-is-false-positive-rate-in-code-review/ (undated)
  - https://www.qodo.ai/blog/introducing-qodo-3.0/ (undated)
- Amp: https://ampcode.com/news/liberating-code-review (2026-02-04)
- Augment:
  - https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent (March 2026)
  - https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results (undated)
- Sentry:
  - https://blog.sentry.io/building-a-code-review-system-that-uses-prod-data-to-predict-bugs (undated; about late 2025)
  - https://www.businesswire.com/news/home/20250923145396/en/ (2025-09-23)
- Cubic:
  - https://www.cubic.dev/blog/learnings-from-building-ai-agents (June 2025)
  - https://news.ycombinator.com/item?id=44386887 (June 2025)
- Baz: https://docs.baz.co/agents (undated)
- Bito: https://bito.ai/blog/one-knowledge-graph-design-coding-review/ (undated)
- Devin Review: https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin (undated) and https://www.testingcatalog.com/devin-launches-ai-powered-code-review-tool-for-github-projects (about 2026-01-21)
- Korbit: https://www.pulse.bot/ma/news/boost-security-acquires-secureiqx-and-korbit-adds-4m-in-new-funding-d18e884b-35f0-41cb-b50a-401d8ea9bcff/ (about 2026-05-06)

**VectorScope code** (worktree `41a64e5e`):
- core `packages/core/src/review/types.ts:394-395,502-504`;
- `select.ts:303-312`;
- `guardrail.ts:422-484`;
- `format.ts:755-769`;
- `config.ts:18-20`;
- engine `packages/engine/src/review/run.ts:715-780`.

**Contract and log:**
- `docs/vector/build/vectorscope-upgrade.md` §1–2;
- `docs/vector/build/vectorscope-upgrade-addendum-a.md` VS-36 to VS-49;
- `docs/vector/build/vectorscope-deviations.md` entries VS-25b, VS-37a and the Now-window review.
