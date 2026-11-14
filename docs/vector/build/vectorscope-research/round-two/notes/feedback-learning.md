# Round two: learning from reviewer feedback and controlling noise

Prepared 2026-11-06 for the VectorScope upgrade work. This round extends round one's §2.3, §3.4 and the "Team learning" row of the gap table (`REPORT.md`; `greptile-quality.md` §1.3–§2). It does not repeat them.

## 0. Access this round (read first)

- **The web was closed to this lane.** By the time this lane started, the shared WebSearch budget for the turn was already used up, so no search ran. WebFetch failed DNS for `www.greptile.com` and for `arxiv.org`. Following the tool guidance, I stopped probing web hosts after the second failure. The proxy's relay log also showed 403s for `docs.coderabbit.ai`, `docs.qodo.ai`, `docs.cursor.com`, `sourcegraph.com` and `ampcode.com` from sibling lanes. I did not retry those hosts.
- **What I could read instead.** Anonymous git reads of public GitHub repositories worked. Every new primary fact in this note comes from source code or from documentation kept in a repository:
  - `kodustech/kodus-ai` at `2ee5d32` (2026-11-05), with history deepened to read the removal of its feedback filter;
  - `greptileai/skills` at `59e79ec` (2026-11-03);
  - `greptileai/akupara` at `09b7db2` (2026-11-04);
  - `github/docs` at `17d6ee5` (2026-11-05), sparse checkout of `content/copilot`;
  - `withmartian/code-review-benchmark` at `e616e84` (2026-08-30);
  - `qodo-ai/pr-agent` at `6de02f5` (2026-11-05);
  - VectorScope's own code on the worktree at `765ef4ec` (2026-11-06), read-only.
- **Recalled literature.** The academic and industrial studies the angle asks about (Google, Meta, Microsoft and the comment-usefulness papers) could not be fetched. Section 6 gives what I recall, labelled **recalled** and **weak**. None of it should be quoted as a number until someone fetches it.
- **To re-verify the web claims,** allow `www.greptile.com`, `arxiv.org`, `dl.acm.org`, `research.google`, `engineering.fb.com`, `docs.coderabbit.ai` and `cursor.com` in the session's network settings, and allow new WebSearch calls.

Labels: **code** (read in source or in a repository's docs at a commit), **vendor** (the company's own claim, including its docs), **independent** (a third party measured it or wrote the method), **academic**, **community**, **inference** (mine).

---

## 1. The most important finding is in VectorScope itself: today's team-dismissed loop

Round one described VectorScope's analogue to Greptile's filter as "a finding loses 0.15 confidence when it resembles at least two team-dismissed patterns" (`REPORT.md` §3.4). That is true, but it is only half of the mechanism. Reading the code end to end turns up five properties that matter more than the penalty's size. **[code]** VectorScope worktree `765ef4ec`, 2026-11-06.

### 1.1 Who can dismiss, and what gets stored

- `classifyPrior` (`packages/core/src/review/state.ts:276-310`) treats four things as dismissal signals:
  - a resolved thread whose anchor did not change;
  - a 👎 reaction (`thumbs_down` / `-1`);
  - a reply that starts with "not an issue", "won't fix", "wontfix" or "false positive";
  - `/vector dismiss`.
- A signal counts only when it comes from a writer (checked through the permission API, `github.review.ts:625-655`) or from **the PR author**. The one exception: the PR author alone cannot dismiss a blocking security finding (`state.ts:298-305`).
- **Strength worth keeping.** Reactions from people who are neither writers nor the PR author are ignored. This is stricter than Kodus, which counts every reaction (section 3.4).
- **What the store loses.** The dismissal is written as `st=d` into the finding marker in Vector's own comment (`state.ts:36-104`). The marker keeps only:
  - id, severity, category and commit;
  - up to six normalised title words.
  It does **not** record who dismissed, their role (writer or PR author), the reason, or the directory scope. `dismissedBy` exists in memory during the run but is never persisted to the marker.

### 1.2 How one PR's dismissal becomes repository-wide memory

- `teamPatterns` (`state.ts:328-345`) reads Vector's own review comments across the **whole repository**: up to `TEAM_PAGES = 3` pages (`github.review.ts:124, 316-327`), at most 30 patterns. Every `st=d` marker becomes a pattern for every later PR.
- **The external-contributor path.** On a public repository, the PR author of a fork PR is an external contributor. Such an author can dismiss any non-blocking-security finding on their own PR, and from then on it suppresses similar findings on everyone's PRs.
- This conflicts with the approved plan's memory rules (`vectorscope-plan.md:238-252`):
  - "PR/MCP content cannot install instructions or create durable accepted memories; proposed learning requires the user's approval."
  - "Do not record a dismissed finding as a universally false rule. Capture reason, scope and supporting evidence."
  - "Review quality improvements must be measured before enabling automatic learning."
- Today's loop predates those rules, so VS-11 inherits the job of fixing it. **[code + inference]**

### 1.3 The prompt suppresses on a single pattern, which bypasses the guard in `select.ts`

- The trusted "Do not report" list in `prompt.ts:234-243` includes: "Anything that matches `<team_dismissed>` unless it is clearly more serious."
- The `<team_dismissed>` block lists every pattern (`prompt.ts:426-437`). So **a single dismissed pattern** is enough to ask the model to stay silent.
- The `select.ts` penalty, by contrast, needs two similar patterns (`TEAM_MATCHES = 2`, `select.ts:32-34, 114-120`).
- The skip list is shared by both prompt kinds. The security pass only *adds* "Anything that is not a security defect" (`prompt.ts:244`), so the security reviewer is told the same thing.
- `run.ts:678` spreads `input.context` (including `teamDismissed`) into the shared prompt input, and the penalty in `selectFindings` runs on every category, security included (`select.ts:222-231`).
- **Consequence [inference]:** the most effective suppression is a model instruction that cannot be counted or measured. It is never logged as a "dropped" reason, unlike `low-confidence` in `select.ts`.

### 1.4 Scope and similarity are coarse

- `teamPenalty` matches on category plus title-word Jaccard of at least 0.5. It **ignores the stored `dir`** (`select.ts:114-120`; `fingerprint.ts:143-150`).
- A dismissal in `src/ui/` therefore penalises findings in `src/auth/` with the same category and similar words.
- There is no expiry beyond the three-page recency window, and no counter-evidence: a later human fix of the same kind does not reopen the pattern.

### 1.5 "Fixed" is partly model-judged

- A prior finding becomes `fixed` when its anchor changed **and** either the thread was resolved or the model says it is fixed (`ctx.modelStatus`, `state.ts:288-290`).
- Any addressed-rate metric computed from these markers would therefore partly rest on model output, which I-2 classes as untrusted. That is acceptable for bookkeeping, but it should be labelled when used as a quality metric. **[code + inference]**

### What this means

The safe-learning work in VS-11 and VS-20 starts with a fix, not a new feature (design in section 7):
- drop PR-author dismissals from repository-wide memory;
- store the dismisser's role, reason and directory;
- exempt security and blocking findings;
- make the prompt instruction count-gated and logged.

---

## 2. Embedding suppression: one vendor built it and then retired it

Round one's framing [quality §2] was that "learn from reactions, replies and commits, then propose rules for admin approval" is table stakes. The rule half holds up. The automatic embedding-suppression half needs a correction: Kodus shipped exactly a Greptile-style filter and then turned it off.

### 2.1 What Kodus built **[code]**

Source: `kodustech/kodus-ai`, `libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service.ts` as of the parent of commit `a5bac4029` (2026-10-23).

- **Inputs:**
  - embedded past suggestions, labelled POSITIVE_REACTION, NEGATIVE_REACTION or SUGGESTION_IMPLEMENTED;
  - neutral ones were dropped;
  - a suggestion was "positive" if 👍 > 👎 and "negative" if 👎 > 👍;
  - Kody-rule and breaking-change suggestions were excluded from training.
- **Scope:**
  - per repository once there were at least 50 embedded suggestions;
  - otherwise a "GLOBAL" analysis across the organisation, also gated at 50. That is cross-repository learning by fallback.
- **Model:**
  - k-means over the embeddings, `MAX_CLUSTERS = 50`, number of clusters ≈ n/4;
  - cosine thresholds of 0.6 for positive, negative and cluster membership.
- **Decision:**
  - a unanimous cluster decides directly: all positive or implemented means KEEP, all negative means DISCARD;
  - otherwise, neighbours above the threshold vote, with KEEP or DISCARD only on a strict majority, and UNCERTAIN otherwise;
  - discarded suggestions got the status `discarded-by-kody-fine-tuning`.
- **No severity or security exemption** appears in the file. The only label filters are the training exclusions above.

### 2.2 How Kodus retired it **[code; vendor docs in the repository]**

- **2026-09-15, commit `7d8cd3d1a`** ("docs(learning): clarify inactive reaction-based fine-tuning"). The docs now say (`docs/en/how_to_use/code_review/learning/kody_learning.mdx`):
  - "Reaction-based fine-tuning is not currently active. 👍/👎 reactions and suggestion implementation status can be recorded, but they do not train a model, build preference clusters, or filter the next review."
  - "A thumbs-up or thumbs-down alone does not explain why a suggestion was rejected. Richer negative-feedback context is needed before this learning loop can be reintroduced."
  - "Do not expect reacting to a suggestion to automatically suppress similar suggestions in later reviews."
  - The README feature row "Kody Learnings and Memory" became "Kody Memory".
- **2026-10-23, commit `a5bac4029`** ("remove fine-tuning and heavy mode"). The commit message says: "Fine-tuning: its stage ran in no pipeline. … The suggestion_embedded table, the kody_fine_tuning_config key and the discarded-by-kody-fine-tuning status stay: they are data." A vestigial `syncedEmbeddedSuggestions` flag still exists in the feedback and pull-request models at HEAD.

### 2.3 What this does and does not show

- **It shows:** a vendor with open code, an eval harness and per-stage quality signals (`docs/quality-signals.md`, which tracks `feedback.thumbs_down.count/.rate`) chose not to run reaction-based suppression. The reason it states is that the signal is uninformative, which echoes CodeRabbit's 2025 "emojis are ambiguous" argument [quality §2].
- **It does not show** that the filter hurt quality. Kodus published no before/after numbers, so the reason is **vendor-stated**, not measured.
- **Greptile's evidence is unchanged.** The 19%→55%+ addressed-rate claim (Dec 2024) remains vendor-only with no control group. Nothing new could be read this round, because greptile.com was unreachable.

---

## 3. What survives: feedback applied to rules, with thresholds and approval

### 3.1 Kodus rule health and auto-pause **[code]**

Sources: `libs/cockpit/domain/helpers/kody-rules-health.helper.ts`, added 2026-06-24 in `0a0435900`; `kody-rules-auto-pause.helper.ts` and `application/use-cases/auto-pause-kody-rules.use-case.ts`, added 2026-10-20 in `8171bbb49`.

- **Rule states**, judged over a 30-day window:
  - `stale`: zero triggers;
  - `low_data`: fewer than 5 triggers (`MIN_TRIGGERS_TO_JUDGE = 5`);
  - `noisy`: at least 3 👎, more 👎 than 👍, **and** 👎 on at least 10% of triggers. The 10% rule exists, in the code comment's words, so that "4 👎 over 74 triggers = 5%" does not raise an alarm;
  - `ignored`: implemented rate at or below 20%;
  - `noisy` outranks `ignored`, because "explicit disagreement is a stronger signal than passive inaction, and its fix is different".
- **Auto-pause** (opt-in through `kodyRulesAutoPauseEnabled`):
  - pauses ACTIVE rules that are noisy or ignored, and notifies admins in-app and by a weekly digest;
  - skips rules kept in a centralised config repository, where a pause would open a PR;
  - skips the whole run when warehouse data is more than 26 hours old;
  - restarts the window at the last resume, "so a resumed rule isn't re-paused on the history that paused it".
- **"Implemented" is LLM-judged.** A prompt compares the patch with the suggestion's `improvedCode` and answers `implemented` or `partially_implemented` (`libs/common/utils/prompts/validateImplementedSuggestions.ts`). "Partially" is generous: "core functionality or main structure … is present".
- **The design choice [inference]:** feedback disables a *named, human-readable rule*, which an admin can see and resume. It does not silently suppress a bug class learned from embeddings. That makes the loop auditable and reversible.

### 3.2 Kodus rule generation from human review comments **[code; vendor docs]**

- **Pipeline** (`libs/code-review/infrastructure/adapters/services/commentAnalysis.service.ts`):
  1. Collect comments from closed PRs.
  2. Drop users whose type is `bot`.
  3. Drop comments Kody wrote, "otherwise the rule-generator LLM learns from Kody's own past reviews … (self-feedback loop)".
  4. Drop comments from reviewers on a **denylist** (issue #1497). Unidentifiable authors are kept.
  5. Keep only comments longer than 100 characters, capped at 100 comments.
  6. Run three LLM calls: an irrelevance filter, then generation, then deduplication against existing rules, then a quality filter.
- **Docs** (`kody_rules_generation.mdx`):
  - at least 3 months of history are required, and suggestions refresh weekly;
  - "By default, generated rules are **active as soon as they are created**", unless "Kody knowledge approval" is on;
  - learning is "from all reviewers by default".
  - The code builds rules with `status: PENDING` and resolves activation through `requiresKnowledgeApproval` (`generate-kody-rules.use-case.ts:186`).
- **The lesson for VectorScope:** the self-feedback-loop exclusion and the reviewer denylist are cheap and worth copying. Active-by-default is not compatible with the plan's "proposed learning requires the user's approval".

### 3.3 Kodus within-PR decisions **[code]**

Sources: `pr-decision-store.service.ts`; `agents/prompts/verifier-prompt.ts:36-110`.

- Earlier suggestions on the **same PR** are given to the verifier as `PreviousReviewDecisions`.
  - A missing implementation status "must read as 'pending', never as 'not implemented'".
  - PR-level suggestions are "descriptive context …, never refutation evidence".
  - If history cannot be loaded, the verifier fails open: "never drop a finding over infra trouble".
- A repeat rule drops a new finding that re-raises "the same crash, hang, wrong result or data loss in the same operation", however it is worded. A *different* problem in the same code is not a repeat.
- Default verdict: "When in doubt, KEEP." The prompt also says: "Never drop a security hole, data loss or crash for this reason."
- **[inference]** This is VectorScope's prior-findings step (`select.ts` step 6) done carefully. Feedback dedups within a PR; it is not used to suppress across PRs.

### 3.4 Who counts as a voter **[code]**

- Kodus's GitHub `countReactions` uses the raw reaction totals. In OAuth mode it subtracts 1 from each of 👍 and 👎, because the bot seeds its own reactions as voting buttons (`github.service.ts:6274-6300`).
- **Anyone who can react is counted.** On a public repository, a handful of outside accounts could push a rule to `noisy` and, with auto-pause on, pause it.
- VectorScope's writer-or-author check is stronger here (section 1.1). The remaining hole is the PR author.

---

## 4. GitHub Copilot: thumbs as product telemetry, memory with citations and expiry

### 4.1 Code review feedback **[vendor docs, `github/docs` at `17d6ee5`, 2026-11-05]**

- Thumbs on Copilot review comments are used "to improve the product and the quality of Copilot's suggestions". A 👎 can carry an optional reason and comment (`content/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review.md:40-51`).
- GitHub documents no per-repository suppression. It warns: "When re-reviewing a pull request, Copilot may repeat the same comments again, even if they have been dismissed with the 'Resolve conversation' button or downvoted with the thumbs down button" (`content/copilot/how-tos/use-copilot-agents/use-code-review.md:81`).
- **[inference]** The largest deployed reviewer keeps feedback as aggregate training and eval signal, not per-team suppression. It accepts repeated comments rather than risk silent suppression. VectorScope already beats this, because dismissed findings stay dropped within a PR.

### 4.2 Copilot Memory, the closest template for Brain review entries **[vendor docs]**

Source: `content/copilot/concepts/prompting-and-context/copilot-memory.md`.

- **Who creates memories.** Repository facts are created only while Copilot works "in a repository you have write access to". Code review "never appl[ies] user-level preferences, so a personal preference will not change how your pull requests are reviewed".
- **Citations are re-checked.** Each fact carries citations to code. Before use, Copilot "checks the fact's citations against the current branch", but "this is a judgment Copilot makes, rather than a guarantee … a stored fact should not be relied on as a rule".
- **Voting.** An internal, automatic voting system upvotes memories Copilot can validate and downvotes wrong or outdated ones. "Memories that are downvoted past a threshold are no longer used", and vote counts are hidden. Users influence voting by commenting; they cannot edit a memory.
- **Expiry.** The default is 90 days. Owners can set 7–180 days for repository facts. The clock resets only on an upvote: "Simply retrieving a memory does not reset this period."
- **Screening.**
  - Memories containing secrets are rejected.
  - "The system can reject memories that contain recognized model-control tokens, as a defense against prompt injection."
  - Copilot is instructed not to store short-lived instructions.
- **Approval.** Code review and the cloud agent "do not ask for this approval" (unlike the CLI's interactive sessions).
- **Known gap the docs state:** "Repository facts can be captured from pull requests that were closed without merging."
- **[inference] What VectorScope should take:**
  - write-access-only creation;
  - code citations re-validated before use;
  - expiry reset only by confirmed use;
  - secret and control-token screening.
- **What VectorScope should reject:**
  - creation without approval;
  - learning from unmerged PRs. The plan's memory section requires approval, and a closed-unmerged PR is untrusted content.

---

## 5. The "addressed rate" metric under agentic workflows

### 5.1 Greptile's own skill tells agents to resolve false positives **[code]**

Source: `greptileai/skills/skills/greploop/SKILL.md`, v1.3, HEAD `59e79ec` (2026-11-03).

- The skill loops a coding agent "until Greptile gives a perfect review: 5/5 confidence, zero unresolved comments".
- For each comment, step D.4 says: "If informational or a false positive, note it but still resolve the thread." The commit message template is "address greptile review feedback (greploop iteration N)".
- **Effects [inference]:**
  1. **Resolution stops carrying information.** Resolution becomes an agent action applied to everything, so "resolved" no longer means "agreed".
  2. **Compliance inflates the addressed rate.** An agent that changes code for every comment, nits included, raises it with no human ever agreeing.
  3. **Loops optimise the score, not the code.** A loop that runs until 5/5 trains a team's workflow against the reviewer's own score.
- I could not see whether Greptile excludes agent-driven PRs from its addressed-rate A/Bs. Its docs were unreachable.
- **What this means for VectorScope [code + inference]:**
  - VectorScope counts "resolved without code change" by the author as a dismissal (`state.ts:292`), and "anchor changed + resolved" as fixed. Under an agent loop, the first records agent housekeeping as team dismissal, and the second records compliance as value.
  - The author's agent acts with the author's credentials, so nothing in GitHub separates the two.
  - Commit trailers or bot co-author lines could mark agent work, but they are **untrusted** (I-2: "commit messages and trailers"). They may be used to *exclude* data from learning, never to *include* it.

### 5.2 Martian's method already lists the checks **[independent]**

Source: `withmartian/code-review-benchmark/methodology/full.md` §7, at `e616e84` (2026-08-30).

- **Compliance is named as a source of overcounting:** "when developers fix things not because they genuinely agree but because clearing bot comments is easier than arguing." The proposed checks:
  - **effort proportionality:** one-line mechanical fixes look like clearing a comment;
  - **action rate across severity levels:** "A roughly flat acceptance rate across severity suggests a 'fix everything' policy rather than genuine signal";
  - **fix durability:** reverted fixes;
  - **cross-referencing repositories without the tool.**
- **Undercounting is also named:** comments acted on later or outside the PR, and useful-but-not-actionable comments. The proposed corrections:
  - human categorisation of ignored comments;
  - per-pattern acceptance rates;
  - cross-tool agreement on ignored flags;
  - the rate at which an ignored comment is fixed later.
- **A further rule:** "where platforms distinguish between explicitly dismissing a comment and simply ignoring it, dismissal is a stronger 'not useful' signal than silence."
- **The online ETL implements part of this [code]** (`online/etl/pipeline/quality.py`):
  - it excludes bot-authored PRs and self-reviews by default;
  - it computes engagement after the bot's first review (distinct human reviewers, rounds, commits after review);
  - it flags "self-dealing" PRs, where only the PR author engaged.
- **The matching judge is generous [code]** (`online/etl/llm/prompts.py`, `JUDGE_MATCHING`): "Even a partial overlap counts if the bot caught part of the real problem."
- **Implication for VS-21/22 [inference].** Any VectorScope addressed rate should be reported:
  - by severity, with the flat-rate check;
  - with agent-authored and self-only PRs split out;
  - beside the explicit dismissal rate;
  - beside cycle time, the Beko lesson from round one.

### 5.3 Greptile's self-host roles confirm two distinct outcomes **[code; interpretation is inference]**

- Round one listed the akupara aliases [trust-cost §1.7C]. Read for this angle, `deploy/docker-compose/llmproxy-config.yaml` at `09b7db2` separates:
  - `addressed-judge` (gpt-5.6-luna) from `acknowledged-judge` (gpt-6-luna);
  - `comment-classifier` and `rule-optimization` (gpt-5.4-nano);
  - `comment-analytics`;
  - a memory pipeline of `memory-embeddings` (text-embedding-3-small), `memory-clustering` (claude-sonnet-4-6) and `memory-learning` (claude-sonnet-4-6).
- **[inference]** Greptile measures "fixed in code" separately from "acknowledged in a reply". Its learning now looks like embed, then cluster, then LLM-synthesise memories or rules, which is structurally the pipeline Kodus retired, plus a synthesis step. Whether a nearest-neighbour downvote block still runs cannot be seen from config.

---

## 6. Literature (recalled; nothing here could be fetched this round)

All items are **recalled, weak**. Verify before citing any number.

- **The origin of "addressed" as usefulness [academic, recalled].**
  - Bosu, Greiler and Bird, "Characteristics of Useful Code Reviews: An Empirical Study at Microsoft", MSR 2015. A comment was classed as useful when it triggered a code change near its location in a later iteration; the classifier was validated against developer interviews.
  - Recalled findings:
    - the share of useful comments falls as the number of files in a change grows;
    - reviewers who had changed or reviewed the file before give more useful comments.
  - This is the academic ancestor of Greptile's commit-based "addressed" and of Martian's online precision. It was designed for human comments, before agent compliance existed.
- **Predicting usefulness [academic, recalled].** Rahman, Roy and Collins, "Predicting Usefulness of Code Review Comments using Textual Features and Developer Experience" (RevHelper), MSR 2017: moderate accuracy (about two-thirds). Turzo and Bosu, "What makes a code review useful to OpenDev developers?", EMSE 2023: usefulness tied to concrete, actionable content.
- **Google [industrial, recalled].**
  - "Resolving code review comments with ML" (Google Research blog, 2023; Frömmgen et al., ICSE-SEIP 2024): ML-suggested edits deployed in Critique, tuned for precision, reported as addressing on the order of 7.5% of reviewer comments.
  - AutoCommenter (arXiv 2405.13565, 2024, already in round one): developer usefulness feedback was used **per best practice**, to retire or tune low-value practices rather than suppress individual findings. This is the same rule-level pattern as Kodus's auto-pause.
- **Meta [industrial, recalled, low confidence].** A 2025 Meta report on LLM-generated fixes for review comments found that showing the fixes to reviewers slowed reviews, and moved them to the author's side. If confirmed, it is a second measured case (with Beko) where a review-assist feature that looked good on acceptance metrics hurt cycle time.
- **Feedback poisoning and sycophancy [academic, recalled].**
  - Rando and Tramèr, "Universal Jailbreak Backdoors from Poisoned Human Feedback", ICLR 2024: a small fraction of poisoned preference labels can implant a behaviour.
  - Sharma et al., "Towards Understanding Sycophancy in Language Models", 2023: human preference data rewards agreeableness.
  - Together these support the two failure modes the angle names: hostile reactions as poisoning, and reaction rewards pushing toward tone over substance.
- **Already covered in round one, not repeated:** Beko/Qodo (73.8% resolved, slower closure), BitsAI-CR (ReviewFilter, Outdated Rate), Uber uReview, Atlassian RovoDev, Cursor learned rules, CodeRabbit's emoji argument, and the 2026 preprints on resolution predictors.

---

## 7. A safe, measurable feedback loop for VectorScope (inference, grounded in sections 1–5)

The guiding rule is I-2 applied to *actors* as well as text. The PR author is the party under review, so the author's signals may close their own findings but may never create memory that suppresses findings for others.

### 7.1 Record outcomes with provenance (VS-11 core contract)

- **Extend the marker, or a ledger beside it, with:**
  - `outcome`: fixed, acknowledged, dismissed-with-reason, dismissed-silent, or ignored-at-merge;
  - `actorRole`: writer-not-author, author, or other. "Other" is ignored, as today;
  - a reason code (the dismiss phrases map to: false-positive, won't-fix, not-an-issue);
  - the directory scope.
- **Keep in-PR behaviour as it is:** an author dismissal still closes the finding on that PR.
- **Repository memory** counts only `writer-not-author` dismissals. This is the one-line fix to `teamPatterns` once roles are stored. It closes the fork-author poisoning path described in section 1.2.
- **Exclude from learning, never include:** PRs whose commits carry agent markers, and threads resolved in bulk within seconds. These markers are untrusted, and that is fine when they can only remove data.

### 7.2 Make suppression bounded, scoped and visible

- **Never suppress** security findings, blocking findings, or data-loss and crash findings. This matches Greptile's documented never-suppress list [quality §1.4] and Kodus's verifier rule.
  - Concretely: give the security pass an empty `<team_dismissed>` block, and skip `teamPenalty` for those classes.
- **Count-gate the prompt instruction** at the same threshold as `select.ts`: at least 2 distinct writer dismissers, and the same directory or package.
- **Demote before dropping.** A matched finding moves to the summary list, rather than being dropped or left unsaid. Recall stays measurable, and the team can still see it.
- **Log every suppression** as a `dropped` reason (`team-dismissed`) in the `--json` output and in replay artifacts. A prompt-level suppression must become a logged one.
- **Expire patterns** after 90 days with no fresh writer dismissal (Copilot's default). Reopen a pattern when a human later fixes a finding of the same kind, which is the plan's "contradictory evidence can reopen a proposal".

### 7.3 Turn repeated feedback into *proposals* in Brain, not active rules

- Brain already has the machinery. A `pending: "review"` entry is one that "only the user puts … in use". Instruction-like or hidden-Unicode text is held apart, and "outside content cannot vouch for memory" (`packages/core/src/brain/brain.ts:180-195, 1540-1580`) **[code]**.
- A proposal needs:
  - at least 3 writer dismissals of one pattern, from at least 2 people;
  - citations to the comment URLs and the code;
  - the scope.
- The owner approves or discards it in the VS-20 controls.
- **Copy Kodus's hygiene:**
  - exclude Vector's own comments from the learner's inputs (the self-feedback loop);
  - allow a reviewer denylist;
  - keep `low_data`, `noisy` and `ignored` states for *approved* rules, with an opt-in auto-pause that notifies the owner and restarts its window on resume.
- **GitHub CI has no Brain** (round one). Until VS-11's repository-shareable store exists, CI keeps only the bounded, logged team pattern from 7.2.

### 7.4 Measure before enabling anything automatic

The plan requires this (`vectorscope-plan.md:252`).

1. **Shadow mode.** Compute what the team filter, and any proposed rule, *would* suppress, and write it to the replay artifact. Post nothing different.
2. **Replay (VS-21/22).** Measure recall loss on held-out bugs with the filter on and off, against D2's "at most five points" rule. Add adversarial cases:
   - forged dismissals by a fork author;
   - 👎 brigading by non-writers;
   - agent auto-resolve;
   - a 👎 on a real security finding.
3. **Online holdback.** Leave a fixed share of PRs (for example 20%, chosen by a hash of the PR number, never by PR content) unsuppressed. Compare:
   - addressed rate by severity, with the flat-rate check;
   - writer-dismissal rate;
   - cycle time.
   Report agent-authored and self-only PRs separately (Martian's filters).
4. **Regret audit.** Count the suppressed or demoted findings whose code a human later fixed, or that a later bug-fix commit touched. That count is the real cost of learning, and no vendor publishes it.

### 7.5 What not to build

- **Reaction-weighted embedding suppression** before 7.4 has run. Its two public stories are a vendor-only 19%→55% and a vendor retirement.
- **Cross-repository or organisation-global fallback learning** (Kodus's ≥50 GLOBAL path). It conflicts with the plan's "cross-repo isolation".
- **Any loop that treats "resolved" or "addressed" as approval** without the compliance checks in 5.2.

---

## 8. What could not be verified this round

- Greptile's current learning docs and blog posts, including "How to Make LLMs Shut Up" (Dec 2024), its similarity threshold, and whether agent-driven PRs are excluded from its A/Bs. `www.greptile.com` failed DNS.
- CodeRabbit's "Learnings" docs (`docs.coderabbit.ai`, proxy 403; no public docs repository under the names tried) and Cursor's Bugbot learning post (`cursor.com`, not attempted after the host failures).
- Every academic and industrial paper in section 6 (`arxiv.org` failed DNS; Google, Meta and Microsoft blogs were not attempted).
- Kodus's internal measurements behind retiring its filter. None are published in the repository.
- Martian's online dashboard numbers (`codereview.withmartian.com`, not attempted). The repository has the method but no results.
- Qodo's former "auto best practices" docs, which are no longer in the `qodo-ai/pr-agent` docs at `6de02f5`.
