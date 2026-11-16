# VectorScope research report: Greptile, the field, and the seven upgrade ideas

Prepared 2026-11-06 for the owner, and revised the same day after two reviews. Its companion is the build contract `docs/vector/build/vectorscope-upgrade.md`; the reviews' outcome, including the critiques we rejected and why, is in its closing "Review notes".

## How to read this

- **What this is.** A plain-language synthesis of eight research notes in this folder, together with the approved plan (`docs/vector/build/vectorscope-plan.md`) and its deviation log (`docs/vector/build/vectorscope-deviations.md`) on `origin/vectorscope`. Every claim cites its source inline. Bracketed section numbers point into the notes: for example, `[quality §6.1]` means section 6.1 of `greptile-quality.md`.
- **Status of the packages named here.** VS-21 to VS-31 are *proposed* packages, defined in `vectorscope-upgrade.md`. The approved plan ends at VS-20 and the deviation log mentions none of them, so each one needs owner approval. "VS-25 supersedes VS-17" would change an owner-approved plan item and is pending owner sign-off.
- **How far to trust it.**
  - The research sessions could not open greptile.com, docs.greptile.com, cursor.com, coderabbit.ai, openrouter.ai, platform.openai.com, privacy.claude.com, arxiv.org, dev.to, news.ycombinator.com or hatchet.run because of the network policy. developers.openai.com, ai.google.dev, cloud.google.com, graphite.com, qodo.ai and macroscope.com were not reached either, because the sessions stopped trying new hosts after the first refusals.
  - The web-search budget was the second limit. Two of the eight notes (`evidence.md`, `enablers.md`) ran no web searches at all, and two (`landscape.md`, `greptile-trust-cost.md`) ran out of budget partway. So **"not found" in this report means "not found in a limited search"**, and every absence claim is marked "(limited search)".
  - As a result:
    - Greptile's docs and blog posts are known only from search-engine extracts.
    - Several results from papers were recalled from memory and not re-read; they are marked "(recalled)". One 2026 preprint is known only from a search extract; it is marked "(search extract, not read)".
  - The strongest evidence is what we read or measured directly:
    - Martian's open Code Review Bench data, which we re-analysed;
    - Greptile's public self-host repository (`greptileai/akupara` at `09b7db2`);
    - the PR-Agent and Kodus source code;
    - Anthropic's docs;
    - OpenRouter's SDK and OpenAPI text;
    - this repository;
    - a tree-sitter benchmark run on this repository (with the limits listed in section 4.4).
- **Labels.**
  - *vendor*: a company talking about itself.
  - *independent*: a third party, an independent tracker, or open data.
  - *research*: a paper.
  - *code*: read in source.
  - *inference*: our own reasoning or arithmetic.
- **Name.** The approved plan calls the product VectorScope, and this report does too. `vectorscope` stays only in branch and path names.

---

## 1. Summary

1. **Greptile is good, but not uniquely good, and its own numbers overstate it.**
   - Martian's open offline set of 50 PRs is the only independent cross-vendor benchmark. It can be read two ways, which give different numbers, so we name the view each time:
     - Martian's own dashboard (Core profile): Greptile v4.1 scores F1 0.45–0.51 across the three judges and ranks 8th–9th of 21 [quality §5 row 4].
     - Our all-category micro-average of Martian's raw judge outputs: F1 0.47–0.52, which is 7th of the 20 comparable runs under the Opus judge [landscape §1].
   - A **pre-release** v5 build, which Martian ran on 2026-06-26, about six weeks before the public v5 launch (~2026-08-05), scored lower under all three judges (all-category F1 0.39–0.43). We found no independent score of the shipped v5 [quality §1.5, §5 row 4].
   - On Martian's online benchmark Greptile reached #1 on 2026-07-30 (F1 60.8, precision 76.2), mostly on precision, then fell to #3 by about October [quality §5 row 5].
   - Its much-quoted "82% catch rate" counts one planted bug per PR and ignores false positives [quality §5 row 1].
   - No tool on the independent board exceeds about 0.65 F1 [landscape §1].
2. **What Greptile says it does.** None of the following has an independent ablation; the label on each says where the claim comes from:
   - a code graph plus a written knowledge base, so the reviewer starts with context (vendor) [architecture §2];
   - an agent loop that investigates, rather than a fixed pipeline, since v3 (vendor) [architecture §3.2];
   - parallel agents that each test one bug hypothesis, since v5 (vendor) [architecture §3.4];
   - paid depth tiers that scale compute with PR size and risk (vendor; the self-host switch that forces Base is code) [trust-cost §1.7A–B];
   - cheap models for side tasks (code: akupara's per-subtask model aliases) and heavy prompt caching (vendor) [trust-cost §1.7C, E];
   - learned suppression of the kinds of comments a team ignores (vendor, no control group) [quality §1.3].

   v5's swarm coincided with a lower offline F1 (on the pre-release build) and with severity labels that no longer separated good comments from bad ones (section 2.3), while Greptile reports a higher addressed rate. No independent test isolates any of these features.
3. **We found no future-bug prediction or hotspot feature at Greptile** (greptile.com could not be opened; limited search) [quality §0, §3, §6.2]. The closest are:
   - an opt-in "preventative" security mode;
   - a 0–5 confidence score, which our re-analysis found weakly calibrated;
   - risk-based tier selection.

   The research on change-risk prediction supports using a risk score to decide how deeply to review, not to tell developers that a file "will break" (section 3.3).
4. **How the seven ideas stand against the evidence:**
   - **Well supported:** the verify tier (generate findings, then verify each one) and deterministic output validators; pre-dispatch budgets and zero-token skips, provided the rules for "trivial" are conservative.
   - **Supported only in a narrower form:** the AST/dependency tier as a way to *rank and bound* context, not to filter out changed code; precision-first output as an explicit *operating point*, not as a hard five-class filter, which will probably break D2's recall rule.
   - **Feasible and partly supported:** ZDR routing (it reduces retention but cannot rule it out) and Brain context cards.
   - **Weakly supported as stated:**
     - **Cross-model inversion.** The "~10% uplift in edge-case bug detection" figure has no traceable source; the nearest is a vendor blog with no method.
     - **eBPF/OpenTelemetry runtime telemetry.** eBPF works only on privileged Linux, and no study shows that either helps review.
   - Each of the weaker ideas has a better-supported alternative (section 4).
5. **VectorScope's biggest gap against Greptile is measurement, not features.**
   - VectorScope already does several things Greptile is praised for:
     - read-only agent investigation with tools;
     - a verify pass;
     - deterministic selection, anchoring and dedup;
     - team dismissals;
     - a precision-first release gate.
   - But no VectorScope eval result exists yet. There has been no paid run, and no entry point lets a paid replay run the production pipeline [today §4].
   - Even once it runs, the data are thin. The seed set has 10 cases, with 2 held-out bugs and 0 held-out controls [today §6]. The planned ~100 bugs and 25 controls, split 60/20/20, leave about 20 held-out bugs, which is probably too few to decide D2's "at most five points of recall lost" rule (section 6).
   - The seed cases are public open-source bug fixes that models have probably seen in training; the plan records this limit (`vectorscope-plan.md:104-105`), and it caps how far any future result can be trusted.
   - Every upgrade below has to be measured on the existing harness before it can become the default (D2, D3).

---

## 2. Greptile in depth

### 2.1 How it understands a codebase

Greptile's model of a codebase has three layers.

**The 2024 base** [architecture §2.1–2.2]:
- It parses every file with tree-sitter.
- A model writes a short description of every function, class, file and directory, recursively.
- It embeds those descriptions rather than the raw code. Greptile justified this with an informal test: a query matched the natural-language description at 0.815 similarity, against 0.728 for raw code (Greptile blog, 2024/2025, vendor, informal).
- It stores a graph of functions, classes and files, with call, import and usage edges.

**What the self-host repository shows today.** The self-host repository at `09b7db2` (2026-11-04) still has a `chunker` worker that chunks and embeds code, plus Postgres with pgvector and Hatchet for jobs (code) [trust-cost §1.1, §1.5]. A 2026-07-26 commit is titled "GPT routing, remove summarizer", and the repository lists no summarizer worker, so **we do not know whether per-node natural-language summaries are still generated** [trust-cost §1.7D]. (Older vendor docs, seen only through search, listed a "summarizer" worker and "smart", "fast" and "embedding" model roles [architecture §2.2]; the note's conclusion that the 2024 design "is still in place" was its own inference.)
- Recommended self-host models: Claude Sonnet 4.6+ and Haiku 4.5+, GPT 5.5+, and `text-embedding-3-small` for embeddings (code) [trust-cost §1.3].
- Each subtask is routed through its own LiteLLM model alias (code; section 2.6) [trust-cost §1.7C].

**The 2026 knowledge base** [architecture §2.3]:
- It runs to hundreds of pages of module docs for a medium-sized monorepo, including "bugs that have been introduced in the past here, and potential sources of risk" (vendor).
- Greptile's stated reason: it saves the "tens of thousands of tokens" an agent would otherwise spend re-learning the codebase with grep and file reads (~Jul 2026, vendor).
- Coding agents have been able to read it over MCP since about 2026-09-16 (vendor).

**Team memory** [architecture §2.4; quality §2] (vendor):
- It is learned from reactions, replies, human review comments and commits.
- It ingests `CLAUDE.md`, `AGENTS.md` and `.cursorrules` automatically.
- Rules can be scoped to directories through `.greptile/` folders.

No primary doc says how the index stays current. The API's `sha` field and the phrase "processing updates from a newer commit" suggest it is updated incrementally on each commit (inference) [architecture §2.5].

### 2.2 How its review pipeline evolved

| Version | Date | What changed | Evidence |
|---|---|---|---|
| 2.0 | 2024-10-08 | Rewritten around the code graph, as a fixed "flowchart" (read the diff, gather context, write comments) | vendor [architecture §3.1] |
| v3 | 2025-09-23 | Rewritten as an agent loop, with tools for codebase search, similar functions, git history and learned rules. The v3 post reports about 3x v2's context at "75% lower inference costs for our self-hosted customers", credited to "extremely high cache hit rates". Anthropic's case study (~Jan 2026, possibly describing a later build) reports the Claude Agent SDK, Opus 4.5, a memory sub-agent, hooks "to inject determinism" and ~90% cache hits | vendor (v3 post); vendor, Anthropic (case study) [architecture §3.2; trust-cost §1.3, §1.7E] |
| v4 | 2026-03-05 | False-positive and accuracy tuning; addressed rate 30%→43% (judged by an LLM, method not published) | vendor [quality §1.5] |
| TREX | 2026-06-15 | The orchestrator spawns sandboxed sub-agents that run the code, write throwaway tests and attach logs and screenshots. Claims "~20% more bugs"; no eval published | vendor [architecture §3.6] |
| Model inversion | ~2026-07-21 | Routes the review to a different model family from the one that wrote the PR, based on a 2×500-PR study | vendor, experimental [architecture §4] |
| v5 | 2026-08-05 | A parallel "swarm" of agents, each testing one bug hypothesis, mixing frontier and open models (served on Together AI). Median time 5:04→2:25; addressed rate 52%→66%. Martian scored a pre-release build on 2026-06-26 | vendor; independent for the Martian run [architecture §3.4; quality §1.5] |
| Base/Plus/Apex/Auto | 2026-09-25 | Tiers cost 1, 3 and 10 credits; deeper tiers get more parallel sub-agent time; Auto picks a tier from size, risk and complexity. Tiers are now also how large PRs are handled, since an older file cap was removed | vendor [architecture §3.5, §3.8] |

The addressed-rate baseline moved from 43% (at v4's launch) to 52% (the v5 baseline), so these figures cannot be chained from version to version [architecture §3.4].

For a diff, Greptile says it gathers context from (vendor) [architecture §3.7]:
- callers, dependencies and similar functions in the graph;
- the agent's own follow-up searches;
- git history;
- knowledge-base pages;
- team rules;
- Jira, Notion and Linear tickets;
- up to 7 related repositories, read-only.

### 2.3 How it controls quality

**Static settings** (vendor) [quality §1.1–1.2]:
- `strictness` 1–3, which in effect sets a P0/P1/P2 severity threshold;
- `commentTypes`;
- ignore patterns;
- rules enforced at the organization level.

**Suppression learned per team.** In December 2024 Greptile found that 79% of its comments were nits [quality §1.3].
- Two fixes failed: prompting, and a second model rating severity. Greptile concluded: "LLMs are bad evaluators of severity".
- What worked: embedding the team's past comments and filtering out new comments that resemble downvoted ones. The addressed rate went from 19% to 55%+ in two weeks (vendor; no control group).
- Since then it has added rules mined after about 10 PRs, which an admin must approve, and a list that is never suppressed: security, memory leaks and null pointers [quality §1.4, §2].

**Agentic verification.** v3 checks whether a suspected issue is real by following the call chain. v5 gives each hypothesis its own agent (vendor) [quality §1.5].

**Our re-analysis of Greptile's raw benchmark output.** This uses Martian's data: 50 PRs, three model judges [quality §6].
- In v4.1, severity badges were a real precision lever.
  - P1 comments were 60–72% precise, P2 33–37%, and P0 5 of 5.
  - Showing only P0 and P1 would have raised precision from about 0.45–0.53 to 0.62–0.74 while keeping about 64% of true positives.
- In the pre-release v5 build the lever stopped working.
  - It marked many more comments P1 (131 against 80), and P1 precision fell to 37–40%, close to P2.
  - Inflating severity quietly destroyed the gate.
- The 0–5 confidence score barely discriminates.
  - Every benchmark PR contains known defects, yet that build gave 4/5 to 38 of the 50.
  - In 2–3 of the 7 PRs it scored 5/5, Greptile missed at least one High or Critical issue.
  - This matters for its beta feature that auto-approves at 5/5.

### 2.4 Bug "prediction"

We found no feature that predicts future bugs per file or module (limited search; greptile.com could not be opened) [quality §3]. The closest are:
- an opt-in "preventative security" mode, which flags patterns that raise future vulnerability risk (founder, ~Apr 2026, vendor);
- risk-area notes in the knowledge base (vendor);
- the confidence score;
- the Auto tier's internal risk estimate, which is not published.

Greptile says its graph lets it check the callers, dependencies and similar functions of changed code, so it can catch what a change breaks elsewhere (vendor) [architecture §2.1]. No independent result isolates this. Martian's lower recall on cross-file PRs is pooled across all tools, not specific to Greptile [evidence §3.2].

### 2.5 Privacy and deployment

| Topic | What Greptile says or does | Source |
|---|---|---|
| Code at rest (cloud) | Kept in an encrypted cache on AWS until code-host access is revoked; hard-deleted from production within 24 hours when the organization is deleted; backups *may* be destroyed within 30 days, and that can be extended during an incident investigation | security page, ~2026-10, vendor [trust-cost §1.1] |
| Training | Its terms allow training on de-identified customer data, with an admin opt-out; Greptile owns the derived models | ToS §2.2, vendor [trust-cost §1.2] |
| ZDR | Claims ZDR agreements with its LLM providers. Its Trust Center lists 3 AI subprocessors, unnamed in the extract. We could not read the agreements or confirm which providers or models they cover | vendor; independent, weak [trust-cost §1.3, §6] |
| Compliance | SOC 2 Type II; claims HIPAA and GDPR | vendor [trust-cost §1.4] |
| Self-host | Docker Compose or Kubernetes, with your own Anthropic, OpenAI, Azure or Bedrock account (code); telemetry off unless an OTLP endpoint is set (code); "fully air-gapped" (vendor docs, via search); privileged `SYS_ADMIN` review workers (code); a Compose single node needs 64 GB RAM, 32 CPUs and a 1 TB root volume (code); an Enterprise license is required (third-party guide, via search) | akupara `09b7db2`; vendor; independent [trust-cost §1.2, §1.5] |

- Greptile's stance is weaker than CodeRabbit's and Cursor Privacy Mode's, both of which promise no training [trust-cost §4].
- ZDR is now specific to each model:
  - Anthropic's Fable and Mythos "Covered Models" need 30-day retention and are not available under ZDR unless Anthropic expressly authorizes it for the organization.
  - Anthropic's Batch API keeps data for 29 days.
  - So "we have ZDR" holds only for some requests [enablers §1.6; trust-cost §1.3].

### 2.6 Cost model and how Greptile controls spend

**Pricing** [trust-cost §1.6]:
- From 2026-03-05: $30 per seat, including 50 reviews, then $1 per review (vendor).
- From about 2026-10-23 (date from independent trackers): no seat fee. Prepaid $1 credits are pooled across the organization (vendor billing doc).
  - Base, Plus and Apex reviews cost 1, 3 and 10 credits.
  - A TREX run costs 3 more, charged only if it reaches pass or fail.
  - Only completed reviews are charged.

**Its own cost controls**, from its public self-host config [trust-cost §1.7]:
- One model per subtask, through LiteLLM aliases (code):
  - `review` is Sonnet 4.6, `review-deep` Opus 4.6 and `review-light` Haiku 4.5;
  - a `gpt-5.4-nano` "post-review-gate" runs only when re-reviewing a PR that already has comments;
  - nano- and luna-class models act as classifiers and judges;
  - small embedding models do the indexing.
- A `batch_settings` block routes some models to provider batch APIs; that it is meant for asynchronous jobs is the note's inference.
- Versioned routing policies, chosen with an internal eval system (code).
- A kill switch that forces every review to Base, "which limits inference cost" (code).
- Prompt caching (vendor), and cheap open models: Nemotron Ultra is about 4.5x cheaper for reply classification and 62% cheaper for indexing (vendor).

A summary of a Greptile talk puts a naive review loop at $3–25 per PR (independent summary, figures not audited) [trust-cost §1.7F]. We found no automatic skip for trivial PRs at Greptile (limited search) [trust-cost §1.7H].

**For comparison** [trust-cost §2.4, §3.3]:
- CodeRabbit: $24, $48 or $72 per seat with annual billing (vendor for $24 and $48; the $72 Advanced price is from independent trackers), plus $0.25 per file beyond hourly limits; the usage cap is unlimited by default (vendor).
- Cursor Bugbot: usage-based from each team's first renewal after 2026-06-08. About $1.00–1.50 per run in May 2026, cut 22% in the June update (vendor).

---

## 3. The landscape, and what demonstrably works

### 3.1 The only reproducible cross-vendor numbers

These figures come from Martian's offline set: 50 PRs, 173 human-verified issues and three model judges. They are **our all-category micro-average** of Martian's published raw judge outputs, with Opus 4.5 as judge, not the dashboard's Core profile. The table shows 12 of the 20 comparable runs; the full table is in [landscape §1].

| Tool (run date) | Precision | Recall | F1 | Leans towards |
|---|---|---|---|---|
| Qodo extended-v2 (2026-03-29) | 0.68 | 0.61 | 0.64 | balance (top) |
| Cubic-v2 (2026-03-13) | 0.62 | 0.62 | 0.62 | balance |
| Augment (2026-01-22) | 0.61 | 0.62 | 0.62 | balance |
| Macroscope (2026-03-09) | 0.62 | 0.47 | 0.53 | precision |
| Greptile v4.1 (2026-04-05) | 0.53 | 0.51 | 0.52 | balance (7th of 20) |
| Cursor Bugbot (2026-01-22) | 0.58 | 0.45 | 0.51 | precision |
| Copilot-v2 (2026-06-24) | 0.41 | 0.66 | 0.50 | recall |
| Devin (2026-03-02) | 0.70 | 0.39 | 0.50 | precision |
| Kodus-v2 (2026-03-12) | 0.60 | 0.36 | 0.45 | precision |
| CodeRabbit (2026-01-22) | 0.35 | 0.60 | 0.44 | recall |
| Greptile v5, pre-release build (2026-06-26) | 0.40 | 0.45 | 0.43 | — |
| Graphite (2026-01-23) | 1.00 | 0.07 | 0.13 | 12 true positives, 0 false |

Caveats [evidence §2.4, §3.2]:
- The numbers move by 0.05–0.10 depending on the judge; Opus is the most lenient.
- The set grew out of Greptile's own 2025 benchmark and is public, so models may have seen it in training.
- Real bugs missing from the reference set count as false positives.
- On cross-file PRs, pooled recall is 8–11 points lower (small sample).
- We checked the judges for same-family favouritism and found none: a Claude judge does not favour Claude Code's reviews. This is about judges scoring reviews of human-written PRs; it is not evidence about whether a reviewer misses more bugs in code its own family wrote.
- **The set mostly fails D8's licence rule** (to verify): Sentry uses the FSL, Cal.com and Grafana AGPL-3.0, Discourse GPL-2.0; only Keycloak is Apache-2.0. Using it at all needs an owner exception, as an internal diagnostic only. An alternative is AACR-Bench (200 PRs, 50 projects, 10 languages), once its own licence and its repositories' licences are checked [evidence §3.2].

Vendor benchmarks disagree mainly because they measure different things [quality §5]:
- Greptile's 82% is recall only.
- Augment gives Greptile an F score of 45% on the same PRs.
- Tenki reports 36.1% recall, and Macroscope 23.6% (17 of 72 bugs).
- Cursor's resolution-rate table shows Greptile at 63.49% against Bugbot's 78.13%.
- Kai, a competitor, reports v5 F1 figures that match our recomputation of Martian's pre-release run, so it is not a separate score of the shipped v5 [quality §5 row 8].
- The widely repeated "11 false positives against CodeRabbit's 2" has no traceable source. Do not cite it.

### 3.2 Techniques ranked by strength of evidence

The tiers [landscape §4]:
- A: independent quantitative evidence.
- B: a vendor result with a disclosed method, or source code plus several vendors adopting it.
- C: adopted widely, but not measured.
- D: claimed, with little evidence.

| Rank | Technique | Tier | Key evidence |
|---|---|---|---|
| 1 | Offer explicit precision/recall operating points rather than tuning only for acceptance rate | A | Martian results range from Graphite (P 1.0, R 0.07) to recall-heavy tools; Copilot offers Lite/Balanced/Max at about $0.25, $1.50 and $10 per review. Graphite's result is consistent with aggressive acceptance gating (inference); how its run was configured was not verified |
| 2 | Investigate with a tool-using agent rather than a single prompt | A-/B | Cursor: resolution rate 52%→70%+ (vendor); Copilot's independent scores rose after its agentic move (confounded) |
| 3 | Generate findings, then verify each one with evidence | B+ | PR-Agent, Ellipsis, CodeRabbit, Qodo's judge, Kodus. Kodus's verifier keeps 97–100% of the known bugs *that reach it*, on a 15-PR controlled set, and 0.926 in its heavy-mode snapshot (vendor eval with open code, judged by gpt-5.6-luna against 136 goldens) |
| 4 | Run single-class passes, take their union, dedup, then verify | B | Kodus heavy mode: +0.10 to +0.17 recall at a precision change of -0.15 to +0.02, for 1.3–2.1x tokens (vendor eval with open code) |
| 5 | Deterministic checks: anchor to changed lines, quoted code must match the file exactly, compile-check the fix, fingerprint comments across runs | B | PR-Agent and Kodus source code |
| 6 | Turn feedback into rules or memory | B- | Cursor: 44k learned rules, 78% resolution rate (confounded) |
| 7 | Metrics based on what developers did at merge | B | Cursor's resolution rate; Martian's online benchmark |
| 8 | Static analyzers as evidence, filtered by the model | C+ | CodeRabbit, Kodus, Bito |
| 9 | Repository instruction files | C+ | Used everywhere; no measured lift |
| 10 | Context heuristics for large repos | C | PR-Agent warns that more context can make results worse |
| 11 | Hard caps and severity floors | C | Kodus: "A real bug rated too low is dropped here without anyone seeing it" |
| 12 | Running code or tests in a sandbox to verify findings | D | No published method (TREX claims ~20%) |
| 13 | Voting across several models | D | No public ablation; Cursor moved away from voting |

**How verifiers fail.** A verdict the code cannot read is a real failure mode. In Kodus issue #1937 a verifier wrote `{"keep": false}` as text instead of calling the tool, the refutation was discarded, and the finding was "kept by default". PR-Agent's reflection step fails open at score 7 (code) [landscape §2.11, §4]. A VectorScope guardrail has to decide this on purpose (section 4.7).

Industrial reports [evidence §3.1]:
- ByteDance BitsAI-CR's two-stage system (a rule checker, then a ReviewFilter that verifies) reported 75% precision (recalled).
- At Beko, 73.8% of PR-Agent's comments were resolved, yet average PR closure time rose from about 5h52m to 8h20m (recalled). High resolution can coexist with slower merges, so cycle time needs measuring too.
- Inline code suggestions are the strongest predictor that a comment gets resolved, and long comments are acted on less (arXiv 2607.21997; search extract, not read).
- An independent repository analysis found bot review threads resolved 42.9% of the time alone, against 74.4% when a human reviewer was also on the PR (independent) [quality §5].

### 3.3 Predicting bugs: what the research supports

This matters because recommendation 7 uses a risk score [evidence §4]:
- **Change-risk models rank changes well.** Kamei et al. (2013) used 14 change metrics; an effort-aware model found 35% of defect-inducing changes while inspecting 20% of the changed lines (recalled). FixCache held about 10% of files and captured 73–95% of later faults (recalled).
- **Simple models match deep ones.** A model that uses only "lines added" outperformed DeepJIT and CC2Vec on more than 310k commits (research, replication README read).
- **The labels are noisy.** SZZ-mined "bug-inducing" labels miss and mislabel a large share of commits, and 33.8% of bug reports were misclassified in one study (recalled). Any trained model inherits this.
- **Showing risk to developers did not help.** Google deployed a hotspot score in code review in 2013 and found no measurable change in developer behaviour (recalled, high confidence on the qualitative finding).
- **Use:** a cheap, explainable risk score to decide review depth and to explain why a PR got a deeper review. Never post it as a "this will break" forecast (inference) [evidence §4.5].

### 3.4 Learned suppression and its VectorScope analogue

- Greptile's December 2024 filter, which drops new comments that resemble ones a team downvoted, is its best-documented quality technique (19%→55%+ addressed, vendor, no control group) [quality §1.3].
- VectorScope's closest analogue is smaller: a finding loses 0.15 confidence when it resembles at least two team-dismissed patterns, and is then re-thresholded (`select.ts:222-231`) [today §2.6].
- Recommendation: compare the two on replay data under VS-11 and VS-20 (approved plan) before building anything larger. An embedding filter is out of scope until that measurement exists.

### 3.5 Speed references

- VectorScope's default review timeout is 12 minutes (`types.ts:280`).
- Bugbot's average review dropped to about 90 seconds in June 2026, and Greptile v5's median is 2:25 (both vendor) [trust-cost §3.3; architecture §3.4].
- Extra tiers, per-finding verification and execution all add wall time, so each new stage needs a latency budget as well as a cost budget (DESIGN §6.8).

---

## 4. The seven ideas, checked against the evidence

### 4.0 A rule every new context source inherits

Brain cards, knowledge pages, test and coverage output, reproducer output and telemetry are all text that the code under review can influence. Each must be wrapped as untrusted data in the prompt, never treated as instructions or as a verdict (`prompt.ts:180-191,440-453`). The lesson from CodeRabbit's January 2025 incident applies to any step that runs repository-controlled tools or config: a PR's malicious `.rubocop.yml` gave remote code execution in production and exposed provider API keys (independent disclosure, vendor response) [trust-cost §2.1].

### 4.1 ZDR-only routing, with no fallback that could retain code

**Verdict:** feasible and worth doing, provided it fails closed. The honest goal is "request ZDR and refuse every route known to retain"; ZDR reduces retention but cannot rule it out. Vector does not do this today.

**Today** [native §2; today §2.10, §5.5]:
- Vector never sends `zdr` or `allow_fallbacks` from the engine or core, and says so explicitly (`packages/core/src/free-model-choice.ts:14-15`, `free-model-request.ts:175-186`).
- Its privacy rule is "no training":
  - It sends `provider.data_collection: "deny"` on the free route.
  - It also sends it on BYOK OpenRouter requests that could be rerouted (`denyDataCollection` in `free-model-catalog.ts`, applied at `provider.ts:2508-2522` and `session/runner/model.ts:295-315`).
- When unattended, CI falls back to a free model that does not train (`packages/engine/src/review/model.ts:80-86`). Vector provides those free models ("Free models are provided by Vector", `free-model-choice.ts:73`), and that route is not ZDR.
- Only the Codium gateway sends `zdr: true`, and its route acceptances are empty on the codium branch.
- Paid and BYOK catalog models carry no retention metadata, so the catalog needs a per-model retention field before a resolver can tell a ZDR route from another [native §2].

**How ZDR actually works** [enablers §1]:
- **OpenRouter:**
  - `provider.zdr: true` restricts routing to endpoints that retain nothing by default (vendor).
  - When no endpoint matches, the request fails rather than falling back. This repo's code documents a 404, "No endpoints found matching your data policy", for `data_collection`; that `zdr: true` fails the same way is inferred.
  - Endpoints with "Safety Retention" keep prompts their classifiers flag. A ZDR request can reach them if the account allows it; account guardrails close this (vendor).
  - OpenRouter's own I/O logging and data-discount logging must be switched off. These are workspace settings that Vector cannot check per request.
  - A BYOK key's `declared_zdr` is self-declared and "not verified by OpenRouter" (vendor).
- **Fallbacks:** fallback models, presets, router models and plugins can move a request to another model or send it to another service. Under ZDR they must be refused.
- **Anthropic direct:**
  - ZDR is arranged per organization, through sales.
  - It covers Messages, prompt caching (held in memory), token counting, thinking, the advisor tool and structured outputs (qualified).
  - It excludes Batch (29-day retention), Files, code execution, the MCP connector and Managed Agents.
  - Fable and Mythos models need 30-day retention unless Anthropic expressly authorizes ZDR for the organization.
  - The API does not block the excluded features; using one steps outside ZDR, so enforcement has to happen on Vector's side.
  - Flagged chats may be retained for up to 2 years, and legal holds override ZDR.
- **OpenAI direct:** `store` defaults to true, keeping data for at least 30 days (SDK text).
- **Caching:** prompt caching coexists with ZDR on Anthropic direct (confirmed); on OpenRouter ZDR endpoints this is inferred from endpoint data; for OpenAI's extended caching on gpt-5.5+ it is unverified [enablers §1.5].

**What "no fallback that could retain code" means in practice:**
- no fallback to a free model;
- no routers, presets, fallback models or plugins;
- no Batch;
- no models that require retention;
- a direct provider, OpenRouter account or LAN server only when the owner attests its ZDR settings in trusted config;
- a refusal stops the review with a note and is never retried on another model.

**What still remains, even then:** provider safety flags and legal holds, and account settings Vector cannot see.

**The conflict.** Making ZDR the default conflicts with D3 (opt-in until D2 passes). It would also stop reviews for users whose only route is a free model or an unattested provider, including the unattended CI fallback. DESIGN §7 C-1 recommends an opt-in now, used in every eval, and a separate owner decision (D15) for the default.

### 4.2 Tokenomics: estimate cost before high-tier dispatch, use context efficiently, spend zero tokens on idle or trivial changes

**Verdict:** well supported, and most of the machinery already exists. The trivial-change rules need more care than they first appear to.

**What already exists** [native §1; today §2.8]:
- Run Guard's predicted-stop check, built on `nextStepCostUsd` (`packages/core/src/review/plan.ts`);
- `estimateCostUsd`. It is a low/high model fitted to a single measured review (`plan.ts:23-31`, fitted 2026-09-14), so it must be recalibrated on replay data before it gates dispatch;
- a reservation ledger, so parallel passes cannot spend the same remaining budget;
- caps of $2 per review, $10 per PR and a monthly cap, in the engine runner. The desktop runner has no dollar cap, only a 10-minute timeout;
- zero-token paths: skip rules, ignores, nothing-to-review, carry-on-rebase and already-reviewed.

**What is missing** [today §2.2, §5.6]:
- a trivial-change detector: whitespace-only, comment-only, docs-only and rename-only changes all still reach the model;
- a token cap, so free, plan and local reviews have no limit;
- an estimate of the whole review, checked before the first Tier 2 attempt.

**Evidence:**
- In our worked example (inference, Anthropic list prices, a hypothetical PR with a 30k-token diff, a 10k-token static prefix and 50k tokens of context), the strong model's input *and output* dominate cost: a Haiku 5.5 filter costs about $0.004, an Opus 5.5 reasoning pass about $0.32–0.37, of which output is about $0.12 [enablers §3.2]. Shrinking context saves more than caching does.
- Caching pays off from the first reuse: a 5-minute write costs 1.25x the input price, a read 0.1x [enablers §3.3]. VectorScope already puts static prompt sections first (`prompt.ts:248-249`).
- **Parallel fan-out defeats caching** unless it waits: a cache entry becomes available only after the first response starts, so parallel specialists each pay a cache write unless fan-out waits for the first streamed response or the cache is pre-warmed. Cache diagnostics should be on in development [enablers §3.3].
- Token counting [enablers §3.1]:
  - Anthropic's `count_tokens` is free and eligible for ZDR, but it takes the whole prompt: counting with Anthropic sends the code to Anthropic even when the review runs elsewhere, which can break the no-training and ZDR routing choices. Count only with the provider that will serve the request; otherwise use a calibrated local estimate.
  - Claude 4.7 and later produce about 30% more tokens for the same text, so recount for each target model.
  - OpenRouter has no counting endpoint, but its per-endpoint prices support estimating before dispatch and reconciling against `usage.cost` afterwards.
- The plan forbids calling estimates billing caps (`vectorscope-plan.md:71-72`).

**The trivial rules must be conservative.** Sensitive paths are not the only trap:
- Workflow files, Dockerfiles and `.env.example` are never trivial (sensitive-path rules in `ignore.ts`).
- Comment-only edits can change behaviour: `// @ts-ignore`, `eslint-disable`, `//go:build` and `// +build`, `//go:generate`, `# type: ignore`, `# noqa`, Rust and Python doctests, shebangs and encoding lines, licence headers.
- Whitespace-only edits change behaviour in Python, Makefiles, YAML and other indentation-sensitive files, and inside multi-line string literals.
- Rename-only edits can break importers (including case-only renames on case-insensitive file systems), test discovery and migration order.
- `ignore.ts` counts `.txt` and `.mdx` as docs, and treats every doc extension as non-sensitive (`ignore.ts:109,133`), so `requirements.txt`, `CMakeLists.txt`, `AGENTS.md`, `CLAUDE.md`, `.vector/review.md` and executable MDX would all pass as "docs".
- The gate needs a measured false-skip rate on replay, including deliberately trivial-looking bug fixtures, before it leaves opt-in.

### 4.3 Vector Brain: inject at most three specific context cards

**Verdict:** feasible today on the local CLI, with no model call on the request path. It has not been shown to improve quality, and it cannot run in GitHub CI without new shared memory.

**Today** [native §3]:
- Brain is local SQLite. Retrieval fuses several ranked lists:
  - BM25 over memory and documents;
  - Personalized PageRank over the code graph;
  - optional local embeddings.
- Each item is valued by trust, freshness, credit and confidence, then packed into the token budget.
- Cheap top-3 retrieval paths exist: `search({limit: 3})` and `links` plus `cards`. `brief` exists too, but it needs a session and a request id and records what it returned against them, and it is sized for subagents (`knowledge.ts:616-631,678`), so it does not fit a gatherer that runs before any review session exists.
- Review already uses linked requirements (300 tokens, CLI only, sent only to models that do not train, never in a posted review: `packages/engine/src/review/context.ts:176-240`, `cli/cmd/review.ts:1302-1317`) and the owner's review habits (300 tokens).

**Evidence:**
- Greptile says its knowledge base saves tokens (vendor).
- Context files are used everywhere, but no study measures their lift (Tier C).
- PR-Agent warns that extra context can hurt.
- A hard cap of three specific cards is a sensible bound, but it still has to be measured.

**Constraints:**
- The GitHub runner has no Brain.
- Personal memory must never reach a shared review (`vectorscope-plan.md:238-252`).
- Eval labels and fixes must never reach model tools or retrieval, including any Brain index (`vectorscope-plan.md:103`).
- Cards are untrusted data (section 4.0).

### 4.4 Three tiers: fast AST/dependency filter, then deep reasoning on the sub-graph, then a strict schema/dedup guardrail

**Verdict:** the verify tier and the deterministic-validator tier are the best-supported parts of this shape. The AST tier is supported as *ranking*, not as filtering (Tier C context heuristics). Three corrections:

1. **Tier 1 should rank changed code and bound the context around it, not hide changed code.** Silently dropping changed files would break the plan's rule of honest partial coverage.
   - Our proposed middle ground (enablers §2.7, inference) builds on Aider's approach (tree-sitter tags plus personalized PageRank to rank files) and adds one rule: match a changed name only in files that also import the changed module. Neither Aider nor PR-Agent does that import check; PR-Agent extends each hunk to its enclosing function and packs by token count [enablers §2.6].
   - SCIP needs a build environment, and stack-graphs is archived [enablers §2.2, §2.3].
2. **Tier 2 keeps its read tools.** Agentic follow-up is the best-evidenced quality gain.
3. **The guardrail must fail closed for posting.** A verify verdict that cannot be parsed leaves the finding unverified, so a strict guardrail drops it and marks the review incomplete, rather than keeping it by default (section 3.2, "How verifiers fail").

**What the benchmark measured, and what it did not.** Measured on this repository [enablers §2.1]: parsing 2,735 TypeScript files took about 4.8 s, the reverse import graph 14 ms, transitive dependents 0.44 ms, and an incremental reparse 0.6 ms. The limits:
- It used web-tree-sitter **0.27.1**, not the pinned **0.25.10**. The runtime wasm export was renamed between them, so adopting 0.27.x means bumping it and changing the wasm specifier in `packages/engine/src/tool/shell.ts`; otherwise the numbers must be re-measured on 0.25.10.
- The `tree-sitter-wasms` Rust and Java grammars failed to load; `@vscode/tree-sitter-wasm` and per-language packages loaded.
- Resident memory reached about 770 MB with all trees held (it drops if trees are discarded after extraction).
- Only TypeScript was parsed.
- The import graph counted only 6,316 resolved *relative* imports. Workspace package imports such as `@vectordevai/core/...` were not resolved, so cross-package dependents are undercounted. Tier 1 needs a step that resolves workspace packages and tsconfig path aliases.

**One import reader, not three.** VectorScope already has two regex readers: `review/symbols.ts` (declarations in added lines) and Brain's `brain/code.ts` (symbols and imports for 10 languages, with `imports`, `dependencies` and `resolve`, which the desktop's file ranking also uses) [native §4; today §5.2]. Adding tree-sitter as a third extractor would let three readers disagree about what a change touches and triple the upkeep. Our recommendation:
- the file-level import graph comes from `BrainCode.imports` and `BrainCode.resolve`, which are pure functions and can run in CI without a Brain database, extended with workspace and tsconfig alias resolution;
- tree-sitter is added only for what regex cannot do well: enclosing-definition spans, reference sites and comment ranges;
- tree-sitter replaces `review/symbols.ts` where a grammar exists, and `symbols.ts` remains only as the fallback for other languages.

**What VectorScope already has.** Tier 2 and Tier 3 have a skeleton today:
- read-only `review` and `security` specialists;
- a verify pass;
- `select.ts` [today §2.5–2.6].

Tier 1 replaces regex symbol extraction plus `git grep`; this is the plan's VS-17, which VS-25 proposes to supersede (pending owner sign-off). `web-tree-sitter` 0.25.10 is already a runtime dependency of the engine, used only for shell commands [native §4].

### 4.5 Cross-model inversion: detect which model family wrote the change and review it with a different one

**Verdict:** plausible, but not established for code review. The "~10%" figure is unsupported, and capability matters more than family.

**What the evidence says** [evidence §2]:
- Judges favour their own outputs and outputs like them:
  - MT-Bench: GPT-4 had about a 10% higher self win rate (recalled). This is a likely origin of a loosely quoted "~10%".
  - Panickssery et al. (recalled) found self-recognition correlates linearly with self-preference.
  - Wataoka et al. (recalled) found the bias is driven by familiarity and perplexity.
- Kim et al., ICML 2025 (recalled): "larger and more accurate models have highly correlated errors, even with distinct architectures and providers". This caps any gain from switching families.
- In BIG-Bench Mistake, finding errors in PaLM 2's own reasoning traces:
  - PaLM 2 checking itself scored 17–25%;
  - GPT-4 scored 40–53%;
  - the weaker GPT-3.5 scored 10–15%, worse than self-review.
- The only code-review figure is a vendor's: Greptile's "Model Inversion" study and a companion post claiming a "~10% higher catch rate".
  - No method, confidence intervals or per-model table was published.
  - The comparison is confounded by comment volume: Codex-style reviewers average 1–2 comments, Opus 7–8.
- Nothing supports better "edge-case" detection specifically (limited search; `evidence.md` ran no web searches).

**Better-supported alternative:**
- Use the strongest available reviewer.
- Use a verifier from a different family at equal capability. VectorScope can already do this without new code: `triageModel` runs the review and security passes and `model` runs the double-check, so setting them to two equal-tier models from different families gives a cross-family verifier (`types.ts:247-249`; `run.ts:225-226`), and `EvidenceScope.triage` already records the pair.
- Treat routing by author as a measured experiment.

**Constraints:**
- Greptile infers the author from commit trailers, branch prefixes and PR titles. In VectorScope, PR text may not choose the model (`vectorscope-plan.md:195-198`), and a commit trailer is commit-message text the PR author controls and can forge.
- So only trusted signals may change the route. Today these are Vector's own local records: V2 `Assistant.model` plus `snapshot.files`, and desktop parallel-workspace records [native §6]. There is no git-level provenance today, and a model trailer would be new work.
- **In GitHub CI there is no trusted authoring signal today, so inversion is local-only** until provenance exists that the PR author cannot forge, such as a run record @vector stores outside the PR, or a bot-signed commit whose signature and author are checked through the GitHub API.
- VS-07 never chooses, refuses or replaces a model (`model-evidence.ts:10-12`), so inversion would need a new explicit opt-in that names itself in review notes [today §5.3].

### 4.6 Automated runtime verification in an isolated environment, with telemetry over changed paths

**Verdict:** running code to confirm findings is plausible but unproven in public (Tier D). eBPF is feasible only on privileged Linux, such as GitHub-hosted `ubuntu-*` runners, conflicts with VectorScope's review-mode rules, and has no measured value. OpenTelemetry is portable but unstudied.

**Evidence** [evidence §5]:
- eBPF needs privileges:
  - unprivileged BPF is off by default;
  - it needs `CAP_BPF` or `CAP_SYS_ADMIN` plus `CAP_PERFMON`;
  - Docker's default seccomp profile blocks it in ordinary containers;
  - OpenTelemetry's eBPF instrumentation needs Linux 5.8+ with BTF and root;
  - GitHub-hosted Linux runners have passwordless `sudo`, so it is feasible there, but not on `ubuntu-slim`;
  - macOS has no eBPF, and Windows support is a work in progress.
- No study measures any benefit for review (limited search).
- OpenTelemetry SDKs need no privileges but only see the paths that tests exercise. No study exists, and Bun compatibility is unchecked.

**Better-supported ways to get runtime evidence:**
- Changed-line coverage: Bun writes lcov, and mapping it to the diff, as diff-cover does, gives coverage of the changed lines (Google practice, recalled).
- Tests filtered by actually running them. Meta's TestGen-LLM had 73% of its recommendations accepted after build, pass and coverage filters (recalled). But generated assertions encode the code's actual behaviour, so a reproducer counts only when it behaves differently on base and head.
- PR-time fuzzing (CIFuzz, which needs OSS-Fuzz or ClusterFuzzLite), mainly for C, C++, Go, Java and Rust targets, with OSS-Fuzz-gen also covering Python.

**Vector's own rules** [native §5; today §5.4; plan lines 208-233, 328, 405]:
- Review mode runs no project code. The one exception today is the opt-in local `--checks`, which lets the reviewer run flag-less test and typecheck commands on your own branch only: it is refused with `--pr` and asks for confirmation when other people authored commits (`review.ts:349-359,750-751`).
- Running repository checks is its own capability, with consent for each operation (D10).
- Isolation is not available yet. TaskIsolation lives on `self-evolving`, which has not merged; D13 bars VS-08–12 until it does; and it refuses read-only agents (`vectorscope-plan.md:405`). Runtime evidence therefore needs a consented checks or diagnostics mode (VS-12 and VS-18, which treats isolation as a prerequisite), not a review sub-pass.
- The only option available today is the local shell sandbox (seatbelt on macOS, bubblewrap on Linux, none on Windows) under `--checks`-style consent.
- The hosted V16 sandbox runs only on GitHub-hosted Linux.

**Recommendation:**
- Run locally, with consent for each run, on your own changes only: never with `--pr` and never on fork heads.
  - the repository's existing tests;
  - coverage of the changed lines;
  - reproducers that the trusted executor writes and runs on both base and head.
- Run them in an isolated worktree with the network off, no provider keys or tokens in the environment, and file writes limited to the worktree.
- Wrap all execution output as untrusted data. It is evidence, never a verdict: a PR can print "verified" into its own logs. Only the trusted executor's exit codes can confirm a finding, and a contradicting result never suppresses one.
- On GitHub, only in a separate job with no privileges, after the @vector merge. Never for forks.

### 4.7 Precision over recall: comment only on likely crashes, data corruption, leaks, runaway loops or authorization bypass, with exact location, impact and a copy-pasteable fix; return an empty result when nothing is verified

**Verdict:** strongly aligned with the evidence and with D2 (at least 80% precision, at most 0.2 false alarms per clean PR) as an operating point. But a hard five-class filter will probably break D2's recall rule.

**Evidence:**
- Severity gating works while severity stays calibrated (Greptile v4.1 against the pre-release v5 build) [quality §6.1].
- Quote matching and fix validation are free [landscape §4.5].
- Inline suggestions get resolved more often than other comments (search extract, not read).
- Graphite posted 12 findings, all correct, at 7% recall. That is consistent with tuning only for acceptance (inference; how the run was configured was not verified) [landscape §2.3].
- A severity floor drops real bugs unseen (Kodus).

**The conflict with D2.** D2 allows recall to fall at most five points below the frozen pipeline on paired cases. Logic bugs that produce wrong results but are not "data corruption" would be dropped and count as misses (DESIGN §7 C-2).

**Recommendation:**
- Make this an explicit "precise" operating point.
- Judge its recall on the classes it covers, which needs an owner decision (D16).
- Never let an unfinished review read as "nothing found".
- Decide deliberately what an unreadable verify verdict does: under "precise" it drops the finding and marks the review incomplete.

---

## 5. Gap analysis: VectorScope today against Greptile

| Capability | Greptile | VectorScope today | Gap | Addressed by |
|---|---|---|---|---|
| Codebase index | Tree-sitter graph and a knowledge base (vendor); summaries possibly removed from self-host | Regex symbols plus `git grep` (`symbols.ts`, `context.ts:28-80`); Brain's regex import graph used by the CLI's Brain features and desktop ranking | Large | VS-25, VS-26 (proposed) |
| Investigation | Agent loop; hypothesis swarm (vendor) | Read-only `review` and `security` agents with read/grep/glob/list (`run.ts:639-652`) | Medium | VS-28 (proposed) |
| Verification | Agentic validation (vendor) | The legacy engine default verifies blocking findings only, on the same review model; opt-in shared verify policy covers all non-nits (VS-06). Same-model re-reading is the weakest form of verification [evidence §2.3, §3.4] | Medium; not measured | VS-27, VS-29 (proposed) |
| Deterministic output checks | Not public | Strong (`select.ts`: fingerprints, anchoring, caps, committable suggestions) | Small: no exact-quote or syntax check | VS-27 (proposed) |
| Severity and noise | P0–P2, strictness, learned suppression | blocking/concern/nit, confidence ≥0.7, team-dismissed penalty | Medium | VS-27 (proposed); VS-11 |
| Team learning | Reactions, replies, commits, suggested rules | Dismiss command, dismissed patterns, Brain `review` entries | Medium | VS-11, VS-20 |
| Depth by risk and size | Base/Plus/Apex/Auto | Fixed passes; triage model; skip when too large | Large | VS-28, VS-19 |
| Execution | TREX (beta) | Opt-in local `--checks` only | Large | VS-30 (proposed), after VS-12 and VS-18 |
| Cross-family review | Model inversion (vendor, experimental) | Possible today by setting `triageModel` and `model` to two families; no author detection; the codium branch has a second-lab panel | Medium | VS-29 (proposed) |
| Privacy | ZDR claimed; training opt-out | No training on private code; no ZDR; unattended CI falls back to a Vector-provided free model (no training, not ZDR) | Large for ZDR | VS-23 (proposed) |
| Cost control | Credits, tiers, per-subtask models, caching, re-review gate | $2 / $10 / monthly caps, reservation ledger, carry-on-rebase (engine only; the desktop runner has no dollar cap) | Medium | VS-24 (proposed); VS-10 |
| Runner parity | One service | The engine and desktop runners differ in dollar cap, step caps, context, prior findings and CI checks, so every upgrade must be built and measured twice until VS-10 [today §6] | Medium | VS-10 |
| Measurement | Addressed rate (vendor); mid-pack on the independent board | Strong harness but no results, no paid replay entry point, and a held-out set too small for D2 | Critical | VS-21, VS-22 (proposed) |

**Where VectorScope is structurally ahead, with qualifications:**
- **Your own key, your own CI.** When the workflow names a model on the customer's own key, code goes only to that provider and never through a VectorScope server, which gives the benefit of Greptile's self-host without its privileged 64 GB node. But the unattended default falls back to Vector-provided free models (no training, not ZDR), and Codium plan models go through Vector's gateway (`api/_lib/model-plan-chat.ts`).
- **Vector knows the author first-hand.** Vector writes code as well as reviewing it, so locally it knows which model wrote a change. **Risk:** by default a local review uses `agent.review.model` or the configured default, which is often the same model that wrote the change, and same-model verification is the weakest setup (section 4.5). Knowing the author is only an advantage if the review or verify model is then chosen to differ at equal capability.
- **A stricter harness.** Its eval harness (causal matching, human settlement, intervals, a precision-first gate) is stricter than Greptile's public metrics, once it has enough data to decide anything.

## 6. Recommendations

The packages named below are proposed (see "How to read this").

1. **Measure first.** VS-21 (paid replay entry point, projections, metrics) and VS-22 (the full dataset), then the D5 pilot once the owner's key exists, read as a description of the whole pipeline rather than as per-stage proof. Size the held-out set from the interval widths D2 needs, or state that D2 can only be tested coarsely (DESIGN §6.2).
2. **VS-23:** opt-in ZDR routing that refuses every route known to retain, on every transport, and fails closed; whether it becomes the default is the owner's decision (D15).
3. **VS-24:** a conservative trivial-change gate that spends zero tokens (with the exclusions in section 4.2 and a measured false-skip rate), an estimate of the whole review before dispatch, and token caps.
4. **VS-25:** a pinned tree-sitter impact slice that ranks and bounds context, with the import graph from Brain's existing reader (proposed to supersede VS-17, pending sign-off).
5. **VS-26:** at most three Brain cards, from `links` and `search`, kept only if they prove useful.
6. **VS-27:** a strict guardrail with a JSON result inside the existing `--json` output, as the "precise" operating point; unreadable verdicts fail closed for posting.
7. **VS-28:** review depth scaled by an explainable risk score, never posted as a prediction, with single-class lenses judged against D2's 80% precision floor (Kodus's lenses cost up to 0.15 precision).
8. **VS-29:** a cross-family verifier through the existing `triageModel`/`model` pair at equal tier, measured; inversion by author only from trusted local signals until unforgeable provenance exists in CI.
9. **VS-30:** consented runtime evidence (changed-line coverage, differential reproducers) through the existing `--checks` consent path, on your own changes only, after `self-evolving` merges; no eBPF.
10. **VS-31:** bundle the above as a "precise" mode (without the privacy setting, which stays its own decision), made the default only after a held-out D2 pass.
11. **Sequencing.** The approved plan puts VS-08–11 before new capabilities, and D13 holds VS-08–12 until `self-evolving` merges. So land the pure core contracts and the eval work now, and wire new behaviour into the runners after `self-evolving` merges, unless the owner approves an exception (DESIGN §7 C-13).
12. **Latency.** Give every new stage a wall-time budget inside the 12-minute timeout, and record wall time per stage in replay artifacts.

## 7. What could not be verified

- Greptile's docs and the method behind Model Inversion.
- Which providers and models Greptile's ZDR agreements cover.
- Whether Greptile's self-host still generates per-node summaries after the summarizer was removed.
- OpenRouter's prose about ZDR and its exact error bodies, including whether `zdr: true` fails with the documented 404.
- The current ZDR terms of OpenAI and Google, and whether OpenAI's extended caching is ZDR-eligible.
- Every paper result marked "(recalled)", and arXiv 2607.21997 (search extract only).
- Whether the Martian repositories satisfy D8. From our knowledge, still to verify: Sentry uses the FSL, Cal.com and Grafana AGPL-3.0, Discourse GPL-2.0, and only Keycloak Apache-2.0. AACR-Bench's licences are unchecked.
- Whether `@openrouter/ai-sdk-provider` 2.9.0 has a `zdr` type.
- Tree-sitter timings on the pinned web-tree-sitter 0.25.10, and for languages other than TypeScript.
- How Graphite's January 2026 Martian run was configured.

## Sources

The notes in this folder each list their own URLs, dates and labels: `greptile-architecture.md`, `greptile-quality.md` (Appendix A reproduces the Martian re-analysis), `greptile-trust-cost.md`, `landscape.md`, `evidence.md`, `enablers.md`, `vectorscope-today.md` and `native-systems.md`.

Primary sources:
- Martian Code Review Bench at `e616e84`;
- `greptileai/akupara` at `09b7db2`;
- PR-Agent at `8f6be9d`;
- Kodus at `2ee5d32`;
- Anthropic platform docs, accessed 2026-11-05;
- `@openrouter/sdk` 1.5.59;
- kernel BPF docs, Docker's seccomp profile, the support matrix for OpenTelemetry's eBPF instrumentation, GitHub's runner docs and the CIFuzz docs;
- `vectorscope-plan.md` and `vectorscope-deviations.md` on `origin/vectorscope`, and the code on `origin/vectorscope` at `dbcfbe8f`.
