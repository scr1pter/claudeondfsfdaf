# VectorScope research, round three

Files: this report is `docs/vector/build/vectorscope-research/round-three/REPORT-3.md`. Its inputs are the Phase A measurement (`phaseA/REPORT.md`, with raw outputs in `phaseA/raw/`; session records kept outside the repository, I-13) and five lane notes beside it in `round-three/`: `notes-greptile.md`, `notes-peers.md`, `notes-prediction.md`, `notes-benchmarks.md` and `notes-tokenomics.md`. Its companion is addendum B (`docs/vector/build/vectorscope-upgrade-addendum-b.md`), which turns these results into packages.

Prepared 2026-11-07. Worktree read: `/home/user/wt/vectorscope`, branch `vectorscope`, head `41a64e5e`. It extends round one (`docs/vector/build/vectorscope-research/REPORT.md`) and round two (`round-two/REPORT.md`, and the addendum `docs/vector/build/vectorscope-upgrade-addendum-a.md`) and does not repeat them.

Status: research only. Nothing here is approved, and nothing here is a measured quality claim. Under D12 every number is an internal diagnostic.

## How to read this

- **Two kinds of input.**
  - **Phase A** ran the contract's §6.4 gates at zero spend: zero outbound model requests, no key, no budget, no ledger, no tracked file edited. Its numbers are measured, but on 10 public seed cases with a canned model.
  - **Five research lanes** read sources. Most of what they report is a search-engine extract, not a page they opened (access limits below).
- **Labels.** Every claim carries one:
  - *measured (Phase A)*: run in the worktree at `41a64e5e`, zero spend;
  - *code*: read in source at a named commit;
  - *vendor*: a company about itself, docs included;
  - *independent*: a third party measured it, or a lane measured it from third-party data;
  - *academic*: a paper or preprint (industry authors noted);
  - *user-report* or *community*: GitHub issues and PRs, HN, review sites;
  - *secondary*: press or aggregator coverage;
  - *own arithmetic*: a lane's own calculation or simulation, internal only;
  - *inference*: reasoning, always flagged.
- **"Extract".** The text comes from a search-engine extract of the page, not a full read. Wording may differ from the page, and confidence is lower.
- **Verification pass.** Every lane finding went through a second, adversarial pass (`verdicts.json`, keys `verify:<lane>`; a session record kept outside the repository, I-13): 74 verdicts over the five lanes, of which 16 confirmed, 53 weakened, 5 unverifiable and 0 refuted. Each verifier also listed what its lane missed (46 items).
  - This report states each weakened finding only in its corrected form, cited as *(verified, weakened: ID)*.
  - The 5 unverifiable findings are marked *unproven* where they are used: Greptile F6 (KB rollout), prediction P3-14 (DRS test-path handling), peers P16 (OpenAI's tools-and-execution attribution), and benchmarks B3-12 (CRJudgeBench's 76.60%) and B3-13 (MCR-Bench's re-raise share). None of them carries a package.
  - The verifiers met the same access limits, so verification mostly checked quotes, code and arithmetic, not the unopened papers.
  - The licence counts in §6.3 were re-derived by the benchmarks verifier (B3-01, B3-02), who found and corrected errors.
- **Access limits.**
  - Unreachable for every lane or verifier that tried: greptile.com and docs.greptile.com, arxiv.org (and its mirrors), engineering.fb.com, dl.acm.org, huggingface.co, openreview.net, cursor.com, alignment.openai.com, developers.openai.com, platform.openai.com, openai.com, the openrouter.ai API, conf.researchr.org, mockus.us, blog.sentry.io, github.blog and aimultiple.com.
  - So **every Meta paper number, every OpenAI price and every Greptile prose claim is a search extract or a secondary source.** Owner question Q38 (addendum B) asks to allow the hosts that would let a later pass read the primary texts.
  - What worked: `git clone` and `git ls-remote` of public repositories, raw.githubusercontent.com, github.com issue and PR pages, the npm and PyPI registries, platform.claude.com and code.claude.com.
  - The shared WebSearch budget ran out partway through several lanes. The tokenomics lane ran two searches in all.
- **Naming.** As in round two, open-source coding-agent CLIs and harnesses are referred to generically.
- **Dates.** Every web source in §11 carries its publication or last-updated date, or "undated". Phase A used no web source and cites none, which is correct.

---

## 1. Summary

1. **Phase A: two of the eight §6.4 rows pass.** *(new; measured)*
   - VS-21 (projections) and VS-28 (risk bands) pass.
   - VS-24 passes on safety only: 0 of 16 bug changes classified trivial. Its skip rate cannot be measured, because there are no trivial controls.
   - VS-25 passes on p95 only (971 ms), and only on repositories of 100 to 800 files. Recall is undecided (n = 1), and the token target is not met.
   - VS-23, VS-26, VS-27 and VS-30 cannot be measured until the runner is wired and data or keys exist.
   - 14 of the 17 engine variants are refused as pending, because each waits for its wiring (Q13, Q18).
2. **No large-codebase or Greptile-parity claim is supported.** *(confirms; measured and independent)*
   - The impact slice (VS-25b) and three-tier packing (VS-37a) send 8.5 and 9.4 times relatedCode's tokens. On the only cross-file case, all three arms found 0 of 1 labelled locations.
   - Tier 1 latency is measured only on small repositories. There is no 10k-to-50k, no 50k-plus and no blobless-sparse measurement.
   - No seed or fixture case lands in the high risk band, so the high band and its lenses are untested.
   - Projected high sides are $6.60 to $9.60 per case on Sonnet, against the D5 pilot's $0.75 bound.
   - There is still no independent evidence on Greptile v5, its tiers or large codebases (§3). "As good as or better than Greptile" remains unsupportable under D12.
3. **"Predicts future bugs" cannot yet be tested, let alone claimed.** *(new; own arithmetic, code, vendor)*
   - VS-46a's follow-up-fix label is basic SZZ (blame of a fix's deleted lines), with known noise and a built-in size bias.
   - Its decision rule, non-overlap of two 95% Wilson intervals at 200 matured PRs, detects a real 2x separation only about 12% of the time.
   - Reverts run at about 1.2 to 4 per 1,000 merged PRs (vendor, Greptile's own data, extract; a talk transcript calls the rates "pretty even"), so 200 matured PRs hold about 0.2 to 0.8 expected reverts. The owner's history can give its own base rate directly: this worktree has 2 revert-prefixed against 256 fix-prefixed commit subjects out of 857 *(verified, weakened: F3)*.
   - A result at owner scale is therefore **underpowered or undecided**, never "no separation". The built report's wording ("never enable history risk areas") overstates what an overlap means, and addendum B amends it.
   - A causal "deeper review means fewer future bugs" result needs about 900 to 1,500 matured high-band PRs per arm. That is out of reach on one owner repository.
4. **Risk improves process proxies when it drives an action.** *(corrects round one's shorthand; academic, extracts; verified, weakened: P3-2)* The 2013 Google result (no behaviour change from a hotspot display) stands. Two newer studies report better process proxies, not fewer defects, when risk triggers a concrete action: a 48-person lab study (Gherald) and a randomized trial at Meta (RDR) whose outcome is the risk model's own score on the final diff. Round two already had the "risk plus a concrete remedy" framing. RDR's remedy includes a bypassable pre-land dialog shown to the author, which conflicts with round two's rule "never message the author about the risk". Q28 has to settle that conflict (addendum B, Q46); this evidence does not license posting predictions.
5. **A route to latent bugs other than prediction, unproven.** *(academic extract and an uncontrolled industrial self-report; verified, weakened: P3-8)* Diff-time tests that separate head from base behaviour (Meta's JiTTests) report 4x more candidate catches than hardening tests; candidates, not confirmed bugs. Meta's later figures (74 privacy bugs, a 20% drop in privacy SEVs) are a before/after self-report read through a secondary summary. VS-30's consent path could host a narrow, off-by-default version later; under a rule that posts a probe only when it backs a finding, its measurable value is confirming findings.
6. **Greptile since round two.** *(corrects and extends)*
   - Its status check **can** fail below an opt-in confidence threshold ("Required confidence to pass") *(user-report; verified, weakened: F1)*. Users observed the setting at 0, where it succeeds at any score; the vendor default is unverified. So round two's "succeeds at any score" holds only at 0. The check blocks a merge only where a team makes it a required status.
   - Refusals and pauses arrive on inconsistent channels: sometimes as `COMMENTED` reviews, sometimes as plain comments. Gates that count review objects have credited them as coverage; in the cited cases this was caught before merge. Round two already had this pattern; new are the 4000-credit open-source pool and its pause notice *(verified, weakened: F2, F11)*.
   - *Unproven (F6):* one undated changelog extract says the cloud knowledge base is rolled out per organization. It conflicts with round two's self-host default (on for every repository) and a vendor partner's "thousands of customers".
   - No PR-level forecast, and no link between its score and post-merge outcomes, has been published (as round two found).
7. **Peers: one peer verifies each finding in isolation; the managed services verify after finding.** *(vendor docs and code; verified, weakened: P4, P5)*
   - Anthropic's managed Code Review runs find, verify, rank and post: a union of finders, then one verification step of undocumented granularity. It never fails a check, labels pre-existing bugs, and counts what it left out on re-reviews.
   - Anthropic's open-source review command validates each bug or logic issue its agents 3 and 4 flag with its own subagent, and uses no numeric confidence threshold. That design dates from about 2025-12-06 (`anthropics/claude-code` `9babb8d`); `c905cd8` (2026-10-26) only copied it into `claude-plugins-official`, whose README still describes the old 0–100, threshold-80 design. This is not a recent change. VectorScope still filters on a model-reported `minConfidence: 0.7`.
   - Anthropic's managed Code Review and ultrareview are not available to Zero Data Retention organizations; the local `/code-review` and Claude in a customer's own CI remain *(verified, confirmed: P2)*. That is a narrow market opening for VectorScope's ZDR-only design, not evidence of quality.
8. **Benchmarks: no academic benchmark found includes Greptile, and none is directly usable.** *(academic and code; verified, weakened: B3-02, B3-03)* Martian's offline set (50 PRs) does include Greptile, and the search for academic coverage was not exhaustive. SWR-Bench has a permissive subset of 797 PRs, or about 790 if the 7 ISC-era requests PRs are excluded (re-derived, §6.3). CR-Bench and ContextCRBench have no usable licence. SEVRA-Bench's method (same diff, different PR narratives) is a direct test of I-2 and needs no data copied.
9. **Tokenomics: verify dominates the modelled cost, and the eval's example model is retiring.** *(vendor and own arithmetic)*
   - Sonnet 4.5, the model in the eval README's and `ci.ts`'s example price strings and in Phase A's projections, retires on Anthropic-operated platforms on 2026-11-30; Bedrock and Google-managed Vertex keep their own schedules, and OpenRouter serves Claude through them. D6 names no candidate models, so Q35 asks the owner to pick them from active models and to record which operator serves each *(verified, weakened: T3-1)*.
   - In an unmeasured model calibrated on one review, with cheap triage and a strong verifier, the verify pass is 86–96% of cost on small and medium PRs *(verified, weakened: T3-2)*. Claude 5.5 thinking is billed in full as output, and effort is the only control. VectorScope sets no effort, so a Sonnet 5.5 verifier would run at its `high` default *(verified, confirmed: T3-3)*.
   - VS-40's fan-out hold saves nothing between review and security, which run on different agents with different system prompts. Lens passes run on the review agent and share its tools and system blocks, which carry cache breakpoints, so the hold may still save that prefix for review plus lens passes (unmeasured). This narrows addendum A's VS-40 item 4 *(verified, weakened: T3-8)*.
   - OpenRouter's Batch API (its guide dates from 2026-10-21, last changed 2026-10-31) keeps data 30 days and is not covered by VectorScope's Batch refusal, which checks Anthropic-format paths only. Round two knew of OpenRouter Batch and wrongly called its refusal "vendor-backed" (addendum A) *(verified, weakened: T3-5)*.

---

## 2. Phase A: what was measured, and the measured limits

All of this section is *measured (Phase A)*, from `phaseA/REPORT.md` (a session record kept outside the repository, I-13), unless marked otherwise.

### 2.1 The eight §6.4 rows

| Row (package) | Result | Status |
|---|---|---|
| Projections (VS-21) | 10 seed cases × 3 built variants on Sonnet 4.5, 2 on Haiku 4.5, plus the CI plan job: 110 projection records, 0 problems. Strict egress guard: 231 connection attempts, 0 off the machine. Sonnet `engine` low side $0.2744 mean, $0.3502 p90; high side $7.1973 mean | **Pass** for the 3 built variants. The other 14 are refused as pending, with exit 2 |
| Route audit (VS-23) | Offline only: 105 of 105 recorded wire bodies pass `zdrBodyRefusal`; 48 of 48 privacy tests pass | **Not measurable** as specified (needs VS-23b/c and the fake server on every transport). Fidelity limit: the fake server speaks chat completions and responses, not Anthropic Messages, and the dry bodies come from `@ai-sdk/openai-compatible`, not the OpenRouter SDK, so the 105 bodies are not the production wire format |
| Trivial safety and skip rate (VS-24) | 0 of 8 seed bug cases and 0 of 8 planted-bug fixtures classified trivial, with and without callbacks | **Partial**: safety passes; skip rate not measurable (0 trivial controls of the 20 targeted) |
| Slice recall, tokens, p95 (VS-25) | p95 971 ms (VS-25b) and 997 ms (VS-37a); recall 0/1 for every arm; tokens 8.5× and 9.4× relatedCode | **p95 passes** (under 10k files only); recall undecided; tokens not met |
| Cards (VS-26) | none | **Not measurable** (VS-26 not built) |
| Guardrail re-selection (VS-27) | no engine replay artifact to re-select; 59 of 59 guardrail tests pass | **Not measurable** (needs a paid replay and settled judgements) |
| Risk bands (VS-28) | Seed: low 8, medium 2, high 0. Fixtures: low 5, medium 5, high 0. Low band $0.2519 against a $0.2744 baseline | **Pass** |
| Runtime evidence (VS-30) | 37 of 37 contract tests pass; 0 executions (no executor exists) | **Not measurable** |

### 2.2 Observations that bound what can be claimed

1. **`engine` and `engine:shared-verify` are indistinguishable under the canned model.** They are identical on all 10 cases for both models: the canned model emits only blocking findings, and both verify policies send those to verify. *(code, core `plan.ts:180-223`)* On the engine the two policies pick the same candidates at `verify: blocking` whatever the severities; they differ only for an untrusted case under `verify: all` or a triage pair, where the shared policy also sends a nit or below-`minConfidence` finding that carries a suggestion. Only real model output or a canned scenario built for that case can show a difference (addendum B, VS-21e).
2. **The $0.75 per-case bound will bind on multi-step reviews.** Projected high sides are $6.60 to $9.60 per case on Sonnet (maxSteps 30), 9 to 13 times the bound. Only the one-step low side ($0.24 to $0.38) fits. "Over the cap: 0" reflects the canned model's single step. Owner question Q44 asks how the pilot should treat this. The tokenomics lane's median model (§7.3) does not reassure: it is calibrated on one review, its large Haiku 5.5 → Opus 5.5 median ($0.74) sits at the bound, and at the p90 it states (2–4x the median) that pair and every other large row exceed it *(verified, weakened: T3-2)*.
3. **The slice costs 8.5 to 9.4 times relatedCode's tokens and found no extra labelled evidence.**
   - On the cross-file case (caddy, `hosts.go:83`), the missed location is a field of a same-package Go type in another file: an outbound dependency of the change.
   - VS-25b ranks callers, so it does not target that. VS-37a's tier b, which packs outbound signatures, packed 0 tokens there.
   - **Likely cause, supported by code but not yet by a test:** tier b ties signatures to an import, and a same-package Go file needs none. The builder's comment says so ("Tier b's targets (VS-37a): the files the changed lines' imports name", engine `review/impact.ts:1114`), and core `outboundUses` binds a reference only to an import statement of the file ("A bare name the file defines itself is never an import's, and a member of anything else ... binds to nothing", core `review/impact.ts:700-760`, *code*, `41a64e5e`). Addendum B's VS-37c adds the fixture that confirms it.
4. **No large-codebase latency evidence exists.** p95 is under 1 s, but only on repositories of 100 to 800 files. VS-38's bands need a permissive repository with at least 50k files and a blobless-sparse case. Both can be measured at zero spend with the same harness (addendum B, VS-38a).
5. **`dataset.ts --mirrors` exits 1 on `ci.ts mirrors` output**, with 8 "fix.sha … is not a commit" problems, because the mirrors leave fix commits out on purpose. On a copy with the fix commits added it exits 0. The object check needs full clones kept apart from the replay's mirrors.
6. **The trivial classifier is safe but cannot skip anything yet.** Without VS-24 wiring's callbacks every code file refuses with `comments-unchecked`.
7. **Cross-family is cheaper only when the triage model is cheaper.** Sonnet with gpt-5 as first pass is 27% lower on the low side; Haiku with gpt-5 is 27% higher. No quality claim follows (C-3).
8. **Dataset gaps** (`dataset.ts` dry run): cross-file cases 1 of 30 targeted; trivial controls 0 of 20; trivial-looking bug cases 0 of 3; adversarial cases 0 of 10; `runnable` labelled on 0 of 8 bug cases (target 15). All 10 labels are drafts, and the set is not frozen.
9. **Contamination.** The seed cases are public bug fixes models have probably seen. The projections use a canned model, so this does not affect them, but it will affect every later quality figure.
10. **One unintended npm fetch.** A first measurement attempt let Bun auto-install `effect@4.1.2` from the npm registry into a scratch cache before crashing. The cache was deleted, and every later script ran with `bun --no-install`. No model request was made.

---

## 3. Greptile since round two

### 3.1 Corrections to round two

| Round two said | Now | Evidence |
|---|---|---|
| Greptile's check "succeeds at any score" | True at a threshold of 0, which users observed as the setting's value; the vendor default is unverified. A dashboard setting, "Required confidence to pass", turns the "Greptile Review" check run to `failure` below the threshold. Users saw it at 0 on 2026-09-22 and set to 5 and enforced from 2026-09-23. Before mid-September users saw `success` at any score. It blocks a merge only where a team makes it required *(verified, weakened: F1)* | user-report: letsrebase/rebase #269 and #302, hathach/agentrc #176, goldmar/openclaw-code-agent #585, ejc3/fcvm #927 |
| "TREX is not compatible with Plus, Apex, or Auto" | Possibly outdated: one extract of the GA entry says a TREX run "costs 3 credits and works with every review tier". Unverified; round two's docs page may simply be stale *(verified, weakened: F8)* | vendor, changelog extract |
| Open: does a push re-review only the new commits? | **New:** each review is "independent, not iterative" | vendor, docs extract |
| "Addressed" is a file-touch heuristic (round two) | Restated, not new: "A comment becomes addressed when there's a commit after the comment that modifies the relevant file" *(verified, weakened: F7)* | vendor, docs extract |
| Hosted config is read from the source branch (round two) | Restated, not new: "Settings are read from the source branch of the PR and override dashboard settings". The "override" clause conflicts with round two's community case where the dashboard overrode the file (GP7) *(verified, weakened: F7)* | vendor, docs extract |
| The KB "is read on every review" | *Unproven (F6):* one undated extract says KB synthesis "is being rolled out per organization" in the cloud; it conflicts with the self-host default and a vendor partner's statement of broad use. Round two's statement stands until a primary page is read | vendor, changelog extract |

### 3.2 What changed or surfaced

- **Pass/fail threshold, still weak** *(user-report; verified, weakened: F1)*. A below-threshold result has the same bare `conclusion` (`failure`) as a crashed run, but its output title and summary say what it is ("Plus review: Confidence 4/5 — below your required 5/5"; "this check reflects your team's confidence threshold, not a review failure"). The bug in agentrc #176 was a bot that read the conclusion alone. The score that drives it is still a model output, and Greptile already had a machine verdict on the same score (auto-approve on 5/5, round two). There is no "not reviewed" or "incomplete" conclusion. The setting is absent from the skills bundle (`59e79ec`) and the CLI 3.8.0 settings schema (*code*). **Design point for VectorScope:** VS-32's check run should carry its verdict token in the output title and summary as well as in the conclusion, so readers of either classify it correctly (addendum B, L1).
- **Refusals that look like reviews** *(user-report; verified, weakened: F2)*. Channels vary. A trial-limit refusal arrived as a `COMMENTED` review whose whole body was the refusal, and a gate counted it as coverage; it was caught by hand before a merge (guilhermegor/dotfiles-linux-dev #804). The open-source pool pause notice ("used its 4000 free open-source review credits for this billing period") was posted by the bot in a review (omacom/omarchy #15333). Out-of-credits notices arrived as plain comments, and teams build silence timeouts (omnivision-solutions/tuti #323). No merge of an unread PR is documented, and the pattern was already in round two (#832, GU17).
- **VectorScope today** *(code, `41a64e5e`)*. The GitHub job submits a PR review object only when it has inline findings (`github.review.ts:765`, `if (!payload.comments.length) return`), and so does the CLI `--pr` path (`review.ts:639-641`). Skips and refusals go only to the sticky comment. VS-32's fail-closed verdict (pure `reviewVerdict`, built as VS-32a) is the stronger design, but its job wiring is @vector-owned and waits for `vector-at-mention` (I-9).
- **Revert base rates** *(vendor, "Rise of the Overnight Agents", 2026-05-05, extract; verified, weakened: F3)*. Reverts per 1,000 merged PRs: human baseline 2.72; agents from 1.19 (Codex) and 1.80 (Claude) to 3.50 (Devin); the prose says "4 per 1,000", and a talk transcript says the rates were "pretty even". So the range is about 1.2 to 4, with unpublished definitions over 65,000 organisations. It is no base rate for the owner's repositories, which can be measured directly (this worktree: 2 revert-prefixed against 256 fix-prefixed subjects in 857 commits). Either way reverts alone cannot power VS-46's check at owner scale (§5.3).
- **Confidence data** *(vendor, Q3 2026, extract; verified, weakened: F4)*. 83% of PRs scored 4 to 5; merge time 1.3 h against 3.0 h, which has a mechanical confound (fewer comments, faster merge). No revert or defect outcome by score, as round two found. A community reverse-engineering claims a severity rule reproduces 96% of 722 Greptile scores; the data is not published, so it cannot be reproduced. Any VectorScope comparison of clean against with-findings PRs must be stratified by band or size, since clean verdicts go mostly to small PRs (addendum B, VS-46d item 5).
- **Model Inversion method** *(vendor, ~2026-07-21, extract)*. About 1,500 P0/P1 ground-truth comments, averaged over 3 runs. No table or intervals published.
- **A model-knowledge false positive** *(user-report, HN, ~2026-01-26)*: a claim that Python 3.14 does not exist.
- **TREX** is GA with computer use and permissive network defaults (*vendor*). VS-30 and I-6 stay far stricter.
- **Privacy** is unchanged and still unverifiable: ZDR agreements sit behind the Trust Center, and self-hosted builds trail cloud by at most 30 days (*vendor*, extracts).

### 3.3 Claims against independent evidence (2026-11-07)

| Greptile claim | Independent evidence | Verdict |
|---|---|---|
| Better cross-file and large-codebase reviews | Round two: cross-file recall 0.48 to 0.51 for v4.1, level with a generic agent within intervals (n = 34, Q10-gated). Nothing new | Unsupported |
| KB with risk areas, read on every review | None. One unverified extract says the cloud KB rolls out per organization; other sources conflict (F6, unproven) | Unsupported |
| Learns from feedback | None | Unsupported |
| "Predicting future bugs" | None; it publishes revert rates by author agent, not by its own verdict or score | No forecast exists |
| Confidence score separates PRs | Merge-time data only; a severity rule may reproduce the score | Weak |
| TREX finds ~20% more bugs | None | Unsupported |
| Fast (v5 median 2:25) | None | Unverified |
| ZDR with its LLM providers | None | Unverifiable |

**No independent, reproducible number for Greptile v5 has appeared since round two** (the Greptile and benchmark lanes agree). The one new third-party ranking (AIMultiple, last updated 2026-03-13, extract; the page did not open) uses winner-take-all per PR with an LLM judge, which rewards detail and volume; its credibility is low and it should not be cited. The October snapshot of Martian's online board (Cubic first, Greptile second) was already in round two; the board itself was not read *(verified, weakened: B3-03)*. A like-for-like run would need a paid Greptile run on a D8-clean set, and even then gives an internal diagnostic only (Q39, D12).

---

## 4. Peer tools: context and precision

### 4.1 What is new

- **Anthropic managed Code Review** *(vendor docs, read in full, undated pages)*:
  - four stages: find (parallel agents), verify, rank, post; it works "without building or running your code";
  - three severities, including **Pre-existing**; "a review never approves or blocks your pull request, and the check run never concludes as a failure";
  - a machine-readable severity comment, and a missing line is to be read as no verdict;
  - re-reviews focus on what changed and, on automatic re-reviews, say how many findings were "found and not posted"; a first review posts pre-existing findings with their own gray severity *(verified, confirmed: P1)*;
  - it skips reviews once the remaining budget is below one review's expected cost;
  - `REVIEW.md` is read from the base or default branch, never from the PR; suppressive directives (lower severity, exclude paths, cap nits) are honoured only from the root file on a protected default branch, and when protection cannot be confirmed no `REVIEW.md` is read at all (fail-closed); subdirectory `REVIEW.md` files in test, example, generated and vendored directories are ignored, and the rest share 150,000 bytes. `CLAUDE.md` is read at the root and in each changed file's parent directories, with no documented denylist *(verified, weakened: P3)*;
  - not available to organizations with Zero Data Retention, the HIPAA configuration or customer-managed keys; the local `/code-review` and Claude in a customer's own CI remain available.
- **Ultrareview** *(vendor)*: every finding "independently reproduced and verified" (granularity and execution not documented); up to 500 files and 8,000 lines; 5 to 15 minutes; "typically $5 to $25"; not available under ZDR *(verified, weakened: P4, P10)*.
- **Anthropic's open-source review command** *(code; verified, weakened: P4, P5)*: four parallel reviewers, one of them diff-only ("Focus only on the diff itself without reading extra context") and one scoped to the introduced code, then one validation subagent per issue that agents 3 and 4 flag. There is no 0–100 score and no git-history agent. This design was in `anthropics/claude-code` by `9babb8d` (2025-12-06); `c905cd8` (2026-10-26) copied it into `claude-plugins-official`, whose README still describes the old score-80 design. The agents receive the PR title and description, which VectorScope's I-2 treats as untrusted.
- **Anthropic's SDLC post** *(vendor, 2026-07-21, primary; found by the verify pass)*: internal review agents each have a narrow focus, use retrieval over past incidents, and must write a proof that each finding is valid; the codebase is tiered by risk, with human review kept for regulated or critical code, logged approvals and a risk-weighted human sample *(verified, weakened: P12, P13, P19)*.
- **Launch figures** *(vendor, 2026-03-09)*: "less than 1% of findings are marked incorrect"; substantive comments on PRs rose from 16% to 54%. No mechanism or denominator for "marked incorrect" is documented, so it is neither a precision nor a bound on one *(verified, weakened: P18)*.
- **OpenAI** *(extract, undated)*: "Precision is more important for usability than recall"; comments on 36% of Codex-generated PRs, a population the vendor chose. *Unproven (P16):* the attribution of its gains to repository-wide tools and execution.
- **GitHub Copilot** *(vendor extracts; verified, weakened: P7, P8)*: actionable feedback in 71% of reviews (March 2026, extract); comments resolved with a reason, "Won't Fix" or "Incorrect" (2026-09-18, changelog extract). The large-PR size limit's removal rests only on a low-quality aggregator whose dates conflict with the changelog. Balanced as the default effort was already in round one.
- **Sentry AI Code Review** *(vendor, undated, extract; verified, weakened: P12)*: at most 3 bug hypotheses, each with its own verifier that can fetch production issues. Not the only peer that grounds review in incident history: Anthropic's internal agents retrieve past incidents (2026-07-21). Neither publishes evidence that this predicts bugs.
- **Qodo** *(vendor, June 2026, extracts; verified, weakened: P9)*: cross-repo review; a rule miner whose rules reportedly link to their source comment; rules rarely fixed switch off. Rule health in code was already found in round two (Kodus); what is new for VectorScope is fix-rate demotion from VS-46 outcomes.
- **Amp** *(vendor, 2026-02-04)*: one separate agent per user-defined check.
- **CodeRabbit Secure** *(vendor, 2026-10-28)*: runtime reproduction of security findings in a prepared environment. Whether its general PR review runs reproducers is still unconfirmed.
- **Cubic** *(vendor, June 2025, extract; verified, weakened: P13)*: "reduced false positives by 51% without sacrificing recall" with explicit reasoning logs and micro-agents. This predates cubic-v2 (2026-03-13), so it says nothing about the pipeline round one asked about; no controls are published.
- **Graphite**: the Diamond name was deprecated on 2025-10-08 (now "Graphite Agent"), and Graphite "is joining Cursor" (*vendor*). **Korbit** was acquired by Boost Security (about 2026-05-06, aggregator); drop it from the peer set.

### 4.2 Corrections to rounds one and two

1. **Voting: no change from round one.** Anthropic's managed service is documented as a union of parallel finders followed by a verification step and deduplication: union plus verify, not voting. The only voting hint is a truncated secondary social-media post. Round one's evidence tier D for voting stands until a primary source shows k-of-n agreement *(verified, weakened: P6)*. Same-family voting is not cross-family verification.
2. **One peer replaces self-reported confidence with per-issue validation** (Anthropic's open-source command, *code*, since about 2025-12). Whether isolated validation beats batched verification is untested anywhere. VectorScope's `minConfidence: 0.7` (`types.ts:502`) is a model-reported number.
3. **Pre-existing bugs: drop or label.** VS-42a's S9 drops them under `scopeGate: introduced`. Anthropic's managed service labels and posts them on a first review and counts them on automatic re-reviews; its plugin's false-positive list excludes them. VectorScope's strict summary counts only cap drops (`format.ts:766`), although `StrictResult.dropped` already holds the count for every drop reason (`types.ts:198`).
4. **Size limits.** Ultrareview allows 500 files and 8,000 lines; Copilot's reported removal of its limit rests on an aggregator only (P7). VectorScope skips above 300 files or 5,000 changed lines (`types.ts:517-518`). This raises VS-19's priority but is not a contradiction.

---

## 5. Predicting future bugs

### 5.1 What the evidence says

- **Meta's Diff Risk Score** *(academic, Meta authors, extract; verified, weakened: P3-1)*: scored as "share of incidents captured at a given share of diffs gated". A logistic regression captures about 18.7%, 27.9% and 84.6% of SEVs at 5%, 10% and 50% gated; fine-tuned LLMs capture about 1.40x, 1.52x and 1.05x that (the mapping of the multipliers to the gates is inferred from the extract, and fits AIware 2026's "over 40% at 10% gated"). The LLM gain needs in-house incident labels and title and summary text as input. VectorScope has neither the labels nor I-2 room for that text, so **no model call in `riskOf`** stays right.
- **Risk drives action** *(academic, extracts; verified, weakened: P3-2)*: Gherald (EMSE 2024, 48 participants, a lab study) and Meta's RDR (FSE 2026, a randomized trial on high-risk diffs: an extra recommended reviewer plus a bypassable pre-land dialog). Both outcomes are process proxies: RDR's is DRS's own score on the final diff (self-referential) plus about 0.45% more review time; no defect outcome was found in the extracts. Round two already proposed "risk plus a concrete remedy" (CLEVER, PTS, CRANE). **Conflict for Q28:** RDR's dialog is a message to the author, which round two's rule forbids ("spend more compute or tests on risky changes; never message the author about the risk"). Addendum B's Q46 asks the owner to settle it.
- **LLM-based just-in-time defect prediction** *(extracts; verified, weakened: P3-3, P3-4)*: zero-shot prompting loses to fine-tuned small models (BRACIS 2025), and fine-tuned models are insensitive to swapping added and deleted blocks (ReDef, one C/C++ benchmark). DRS-OSS's ApacheJIT gain uses commit messages, which may carry ApacheJIT's issue-link construction; leakage is plausible but unshown. **Vulnerability prediction falls to near the base rate under realistic imbalance**: PR-AUC on average 0.016 (ICSME 2025), which mostly shows that balanced evaluations overstate usefulness. Keep `sensitive` as an impact floor only.
- **SZZ labels are noisy** *(verified, weakened: P3-5)*. "Only half of the bug fixing commits determined by SZZ are actually bug fixing" (Herbold et al., EMSE 2022); deleted-line blame cannot trace add-only fixes (Rosa et al., ICSE 2021). Human-validated or revert-anchored labels reach about 90%, but that does not measure SZZ. Round two already had the size bias and "never train on raw SZZ".
- **Diff-time differential tests** (JiTTests, arXiv 2601.22832, Meta authors, extract; verified, weakened: P3-8): 4x more candidate catches than hardening tests (candidates, not confirmed bugs; 6.4% weak catches against 2.5%). Meta reports 74 serious privacy bugs caught at the diff stage in the first half of 2026 and a 20% drop in privacy SEVs (*industrial self-report*, 2026-10-29, read via a secondary summary): a before/after comparison with no control, relying on an intent judge and human triage VectorScope does not have.
- **Agent-authored merges** draw verified follow-up fixes at 1.62 times the odds (arXiv 2609.26847, extract; verified, weakened: P3-11). Size control is unknown, and 69.6% of the follow-up fixes come from the same agent, so continuation work is a likely confound.
- **Past fixes as seeds.** Google's Big Sleep found a pre-release SQLite bug when seeded with a previously patched one (*vendor*, one anecdote from a security agent). Whether a prior fix's diff helps a reviewer detect a recurrence is untested. A recurrence share would measure hotspot co-location, which round two found does not help ranking (decay hotspot AUC 0.630, which lowered a combined model), so only the funded ablation (Q9) can test a prior-fix card *(verified, weakened: P3-10)*.
- **Effort-aware metrics**: report the first-hit cost and the share of positives that land in the low band, not only band rates (Huang, Xia & Lo, ICSME 2017).

### 5.2 What VS-46a does today *(code, `script/vectorscope-eval/outcomes.ts` at `41a64e5e`)*

- `fixHits` blames only the fix commit's deleted lines (`git blame --line-porcelain --first-parent`, `outcomes.ts:1243-1254`), with no whitespace, comment or move detection (no `-w`, `-M` or `-C`). Lines a PR merely moved are blamed on it, which inflates labels for refactor PRs. A fix that only adds lines cannot be traced, and a deletion-only PR can be positive only through a revert *(verified, weakened: P3-5)*.
- `fixKind` decides a fix from a PR label or a title regex.
- `bandsOf` returns `"separated"` only when the low and high bands' 95% Wilson intervals do not overlap at 200 or more matured PRs. Its report text on overlap says "document riskOf as a size, reach and sensitivity heuristic for this repository, and never enable history risk areas for it" (`outcomes.ts:1878`).
- Nothing compares the band with a size-only ranking. Such a comparison must use the final band, not `riskOf`'s score: the score is `log2(1 + added + deleted)` plus at most 0.5 from the dirs and entropy tie-breakers (core `risk.ts:183-191`), so ranking by score against log size compares size with itself. Only the band's floors (sensitive, deletion-heavy, sensitive with wide reach), the test-only rule and the tie-breakers differ *(verified, weakened: P3-1)*.
- The production band is computed without `dependents` (`outcomes.ts:895`), so reach is never tested.
- The ledger records each PR's final band and score (`LedgerPull.band`, `score`) but not its added and deleted lines, so a size baseline needs a new field and a ledger schema change.
- `outcomes.ts` refuses shallow and partial clones (`outcomes.ts:745-757`), so a large-codebase user on a blobless clone cannot run VS-46 as built.

### 5.3 Why its verdict is underpowered *(own arithmetic and simulation; prediction lane)*

Share of runs that come out "separated" under the interval rule, with the low band at 50% and the high band at 20% of N matured PRs:

| N | 10% → 20% | 7% → 15% | 7% → 35% |
|---|---|---|---|
| 200 | 0.12 | 0.11 | 0.89 |
| 500 | 0.39 | 0.32 | 1.00 |
| 1,000 | 0.77 | 0.68 | 1.00 |

- Interval non-overlap is roughly a p < 0.006 test. A plain two-proportion test has power 0.30 at N = 200 for 10% → 20%.
- **Revert labels at owner scale.** At about 1.2 to 4 reverts per 1,000 PRs (§3.2), 200 matured PRs hold about 0.2 to 0.8 expected reverts (*inference*). A revert-based band check is empty, not negative. VS-46 should report the observed per-repository base rate first.
- **Follow-up-fix labels.** More common, but they partly rediscover size by construction, and nothing estimates their precision for VS-46a (unaudited; P3-5).
- **The causal question.** Detecting a 25% relative reduction at two-sided α = 0.05 and power 0.8 needs about 1,500 matured PRs per arm at a 13% base rate and about 905 at 20% *(verified, confirmed: P3-7)*. For reverts, the lane's 4% is J.P. Morgan's per-commit rate and gives about 5,300 per arm; at the per-PR rates above (0.12–0.4%) the same test needs about 55,000 matured PRs per arm at 0.4% and more below it (*own arithmetic*, normal approximation), about ten times the 4% figure. With the high band holding at most 20% of PRs, the 13% fix-label case alone means about 15,000 matured PRs in total.
- **So:** at owner scale, an overlap means "underpowered" or "undecided", never "no separation" and never "never". Post-merge outcomes are a monitor, not a gate, for lens and depth decisions; those rest on VS-39's pre-merge measure (high-severity recall per extra dollar against an equal-token control).

### 5.4 How to measure "predict future bugs" honestly (the prediction lane's 9-point protocol)

1. **Target.** A PR merged at least 90 days ago is positive if reverted within 90 days, or if a follow-up fix edited lines it added. Reverts are reported first where they have enough expected positives (addendum B's VS-46c reconciles this with the Greptile lane's "fix label primary").
2. **Label quality.** The owner hand-audits a seeded sample of at least 50 positives and 50 negatives. Report label precision and recall with intervals, and the share of untraceable add-only fixes. Unaudited rates are flagged.
3. **Primary metric.** Capture at overhead: the share of positives in the top 10%, 20% and 50% of PRs by score, with overhead as a share of PRs and of changed lines.
4. **Baselines.** Size alone (log(added + deleted)) and random, with a paired bootstrap over PRs. The band "predicts" only if it beats size alone. The ranking compared must be the final band (floors and the test-only rule included), not the likelihood score, which is size plus at most 0.5 (§5.2).
5. **Low-band miss rate.** The share of positives in the low band, against its share of PRs and lines.
6. **Pre-merge catch rate.** The share of fix-edited lines flagged before merge against the share that escaped, by band and depth.
7. **Power.** Print the minimum detectable effect before any verdict. Verdicts are "beats size", "no better than size" or "undecided". Never "never".
8. **Causal depth effects.** Only with trusted-config assignment (VS-46 item 7), and only above the minimum detectable effect.
9. **Scope.** Internal only (D12); contamination noted; permissive licences or owner repositories only (D8, Q30).

---

## 6. Independent evidence and benchmarks

### 6.1 Academic benchmarks (none found includes Greptile; the search was not exhaustive, and Martian's offline set does include it)

| Benchmark | What it is | Usable under D8? |
|---|---|---|
| SWR-Bench (FSE 2026; repo 2026-06-05) | 1,000 Python PRs (500 positive, 500 clean). 949 labelled changes, 642 evolvability and 307 functional (re-derived). Labels mined with Gemini 2.5 Flash (in code); author verification and the best F1 of about 19% come from the unread paper, and scoring is by an LLM judge. Multi-review aggregation raises F1 "by up to 43.67%" (extract) *(verified, weakened: B3-02, B3-14)* | Harness and data MIT. Repositories mixed: pylint GPL-2.0 (50 PRs); matplotlib under its own PSF-style licence (153 PRs); requests ISC before late 2012 (7 PRs). **Permissive subset: 797 PRs, or about 790 without the ISC-era requests PRs** (re-derived, §6.3) |
| CR-Bench and v2 (2026-03; 2026-11-02) | One labelled defect per instance. v1's "Precision 3.56%" is a search extract. v2's Usefulness 78.0% against KDDR 8.1% for one tool comes only from an AI-agent-written research sweep (a secondary source), and usefulness counts valid suggestions other than the labelled defect. CR-Bench-Verified (174) is drawn from SWE-bench Verified *(verified, weakened: B3-04)* | No licence found. Not usable |
| SWE-PRBench (2026-03-27) | 350 PRs, human-comment ground truth; CONFIRMED / PLAUSIBLE / FABRICATED classes. The published model table covers a 100-PR split scored by one GPT-5.2 judge: diff-only detection 21–31%, with the more-context-scores-worse ordering stable across runs *(verified, weakened: B3-05)* | Harness MIT; dataset CC BY 4.0 per its README, outside D8's list (Q36) |
| ContextCRBench (2025-11-10) | 67,910 hunk-level entries, whole files copied | No licence; copyleft sources. Not usable |
| SEVRA-Bench (2026-06-11) | 2,250 malicious PRs reversing real CVE fixes under 15 social-engineering framings; same diff, different narrative. The retained split (1,062) keeps PRs that a weak baseline (Haiku 4.5 or GPT-5.4-nano among them) approved, so those models' refusal rates are low by construction, and false-decline rates on benign fixes are defined but not reported *(verified, weakened: B3-07)* | Dataset licence unverified (gated); harness has no LICENSE. **Use the method, not the data**: select cases without the model under test and report false declines |
| PRWeaver, MCR-Bench, CodeReviewQA, CRJudgeBench, Sphinx | Attack rendering, multi-round review, comprehension probes, judge accuracy, checklists | Licences unread or data unreleased |

Cross-cutting *(inference)*:
- Absolute scores are low everywhere and not comparable across sets: the ground truth, the unit and the judge differ.
- Model size: SWE-PRBench shows Haiku 4.5 and Sonnet 4.6 tied on diff-only detection (0.306 against 0.297, 100 PRs, one judge), with Sonnet's false-positive rate clearly lower (0.227 against 0.346). The claim that Haiku has 18% higher recall (arXiv 2606.15689) is still an unverified extract, as in round two. So there is no evidence that the smaller model has the higher recall *(verified, weakened: B3-06)*.
- Context depth must be shown to help per model: SWE-PRBench shows harm from more context, AACR a model-dependent effect.
- Aggregation and reflection may help recall (SWR-Bench, CR-Bench-v2; extract and secondary). Their precision effect is unknown because neither paper was read.
- Every external benchmark cited here scores with an LLM judge, so each number depends on its judge.

### 6.2 Field studies: accepted-comment rates

- Rates range from under 1% to 78% (the top is Cursor's vendor resolution rate, round one) depending on the definition (thread resolved, file touched, LLM-judged addressed), the population and whether a human also reviews: RovoDev 38.7% (Atlassian, ICSE SEIP 2026; already in round two); Sun et al. 0.9%–19.2% for AI against 60% for humans (extract); ai-review-churn 42.9% alone against 74.4% with a human (round two) *(verified, weakened: B3-08)*.
- **So an addressed rate is comparable only within one population, with one definition, as a paired or A/B comparison**, never against a vendor's addressed rate (round one's conclusion, reinforced). Greptile's own "addressed" is a file-touch heuristic (§3.1).
- Field evidence supports precision-first only together with a recall floor, which is D2's paired-recall rule. D2 should not be relaxed.

### 6.3 Licence audit (own measurement, **re-derived by the verify pass with corrections**)

- **Method.** For ReviewBench, the first licence file at standard root paths at each PR's base commit, then keywords in a fixed order. For SWR-Bench, only each repository's earliest and latest base commits were checked, which misses licence changes between them. It sees the root file only (no per-path licences, no dual licensing).
- **Classifier bugs.** Keyword matching on the licence body misreads texts that mention other licences: GPL-2.0 text that mentions the Library GPL read as LGPL (pylint, corrected by hand), BSD files bundling MIT notices read as MIT, and **GPL-3.0 read as AGPL-3.0** because GPL-3.0's section 13 names the Affero licence (statista; not caught by the lane). Addendum B's VS-22d keys the classifier on the title line or SPDX header and checks every PR's base commit.
- **Re-derived.** The benchmarks verifier re-ran the check (22 root paths through raw.githubusercontent.com, 215 unique base commits from ReviewBench's `corpus/manifest.json`) and the SWR-Bench counts from the dataset file *(verified, weakened: B3-01, B3-02)*.
- **Seeds, not results:**
  - ReviewBench (`f223ce3`): 195 of 219 PRs have an MIT root licence at base (about 170 of 187 repositories); 23 PRs (16 repositories) have no root licence file, so they are not D8-clean as they stand (a README may claim a licence; a later commit may add one); 1 PR (statista at `39d775a`) is GPL-3.0, not AGPL. Its ">100 MB" slice is GitHub's current repository size, not codebase scale: 30 MIT and 6 with no file; its ">500 MB" part is 14 PRs from 4 repositories, 10 of them from one frontend app, so it is no evidence of large-codebase coverage.
  - SWR-Bench: 797 PRs after excluding pylint (GPL-2.0) and matplotlib (PSF-style; Q36), of which 393 positive and 79 from 2024 or later. psf/requests was ISC until late 2012, and 7 of its PRs (2011-12-17 to 2012-08-06, all clean) sit at ISC commits; excluding them leaves about 790 (Q36).
  - AACR lvgl: MIT at both commits of all 4 positive PRs (closes round two's item at root-file level; `src/libs` still needs the per-path check).
- **CRBugBench has no licence** (`e8e585e`; no LICENSE file, and the README states none) *(verified, confirmed: B3-10)*. This corrects addendum A's §3 VS-22 "PR size" bullet, which relies on CRBugBench's fix track for the large-PR end. The correction belongs in an addendum A amendment or a deviation entry, not a new package (addendum B §3).

### 6.4 Contamination

- OpenAI stopped reporting SWE-bench Verified as "increasingly contaminated" (2026-02-23, *vendor*, extract). SWR-Bench and CR-Bench reuse SWE-bench's 12 repositories, and CR-Bench-Verified is drawn directly from SWE-bench Verified *(verified, weakened: B3-11)*.
- Only 79 of SWR-Bench's 797 permissive PRs date from 2024 or later. AACR's positives date from 2024–2025, which is not post-cutoff for most current models either.
- Only VectorScope's own sealed held-out cases and post-cutoff PRs are clean. External manifests need a PR-date field so results can be split before and after each model's training cutoff.

---

## 7. Tokenomics and ZDR

### 7.1 Prices that change review cost (USD per million tokens)

Anthropic *(vendor, pricing page, undated, accessed 2026-11-07)*:

| Model | Input | 5m write | Cache read | Output |
|---|---|---|---|---|
| Opus 5.5 | 4 | 5 | 0.20 | 20 |
| Sonnet 5.5 | 2 | 2.50 | 0.10 | 10 |
| Sonnet 4.5 (deprecated) | 3 | 3.75 | 0.30 | 15 |
| Haiku 5.5, prompt ≤100K | 0.10 | 0.125 | 0.01 | 0.50 |
| Haiku 5.5, prompt >100K | 0.50 | 0.625 | 0.05 | 2.50 |
| Haiku 4.5 | 1 | 1.25 | 0.10 | 5 |

- **Sonnet 4.5 retires on Anthropic-operated platforms on 2026-11-30** (model-deprecations page; deprecated 2026-09-30; Bedrock and Google-managed Vertex "set their own retirement schedules"). It is the model in Phase A's projections and in the eval README's and `ci.ts`'s example price strings; D6 itself names no candidates ("the current default review model plus one cheaper model already in the catalog"). Haiku 4.5 is still Active: its "not sooner than October 15, 2026" date has passed, but with at least 60 days' notice it cannot retire before about January 2027. A Sonnet 4.5 projection overstates a Sonnet 5.5 review by 50% at uncached prices (every rate is 1.5x). Owner question Q35 *(verified, weakened: T3-1)*.
- **OpenAI prices** rest on three secondary sources that agree (OpenRouter's caching guide, last changed 2026-11-06; LiteLLM's price table; a community issue of 2026-10-21). GPT-5.6 and later charge cache writes at 1.25x input (30-minute TTL; 2.5x at a 12-hour TTL); caching can be turned off per request. OpenAI's own cookbook (last changed 2026-09-16) says gpt-5.5 and all later models cache for 24 hours with no in-memory option. The sources **conflict**, OpenAI's primary pages were unreadable, and so VS-33's refusal of gpt-5.5 and later stays *(verified, weakened: T3-4)*.
- **Long-context tiers**: Haiku 5.5 costs 5x above 100K prompt tokens; OpenAI gpt-5.5+ 2x input and 1.5x output above 272K; and the catalog's OpenRouter Sonnet 4.5, today's example model, 2x input and 1.5x output above 200K *(verified, confirmed: T3-6)*. VectorScope's `ReviewPrice` (`plan.ts:17-22`) has no tiers, so VS-40 prices every step at the base tier (*code*). The engine already picks tiers for reservations (`Session.costAt`, engine `session/session.ts:442-449`).
- **Route fee**: OpenRouter credit purchases cost 5.5% ($0.80 minimum), so the eval key's effective price is list × 1.055 (*vendor*; *inference*). Own-key usage costs 5% above $25,000 a month on pay-as-you-go, and Anthropic charges a 10% regional premium *(verified, weakened: T3-9)*.
- **Catalog error** *(code)*: `packages/web/public/models/api.json` (255cfd83, 2026-10-28) lists Sonnet 5.5 `cache_read: 0.2` where Anthropic lists $0.10. That is outside the VectorScope contract (addendum B §3).

### 7.2 Reasoning tokens on Claude 5.5 *(vendor)*

- "Tokens Claude uses while thinking (billed as output tokens)"; "You are billed for the full thinking process".
- "You don't set a thinking token budget"; each request in a tool loop has its own `max_tokens`, which does not bound the turn.
- Changing effort between requests "invalidates cache breakpoints".
- Defaults: `medium` on Opus 5.5 and Haiku 5.5, `high` on Sonnet 5.5 (Anthropic; OpenRouter's migration guide, own date not read, agrees).
- VectorScope sets no effort unless an agent variant is configured (*code*, engine `review/model.ts`), so a Sonnet 5.5 verifier runs at `high` *(verified, confirmed: T3-3)*.
- Levers the lane did not list: Haiku 5.5 thinking can be turned off (unlike Opus and Sonnet 5.5); setting effort explicitly to the model's default does not break the cache; a per-message effort change (beta) keeps earlier breakpoints.

### 7.3 What VectorScope might cost per PR *(own arithmetic, unmeasured; medians, list prices, 5-minute caching; verified, weakened: T3-2, T3-10)*

| Triage → verify | Small | Medium | Large | Verify share (medium) | Uncached (small / medium / large) |
|---|---|---|---|---|---|
| Haiku 5.5 → Opus 5.5 | $0.17 | $0.36 | $0.74 | 93% | $0.22 / $0.64 / $1.96 |
| Haiku 5.5 → Sonnet 5.5 | $0.09 | $0.19 | $0.45 | 86% | $0.11 / $0.35 / $1.28 |
| Sonnet 5.5 only | $0.20 | $0.64 | $2.58 | 26% | $0.30 / $1.49 / $9.78 |
| Opus 5.5 only | $0.40 | $1.29 | $5.16 | 26% | $0.59 / $2.97 / $19.55 |
| Haiku 4.5 → Sonnet 4.5 (the eval examples' models; not a pair Phase A ran) | $0.18 | $0.52 | $1.80 | 50% | $0.25 / $1.03 / $5.57 |
| Sonnet 4.5 only | $0.31 | $1.04 | $4.46 | 25% | $0.44 / $2.23 / $14.67 |

- The model is `G = S·P + R·S(S−1)/2` per pass, with each pass's write, read and output priced separately. Its parameters rest on one calibration (`CALIBRATED_OUTPUT_PER_STEP`, `cases: 1`, `dispatch.ts:34`; one measured 5-file review of 79.3K input over 5 + 4 steps), AACR's token range and CRBugBench's p90 diff size (diff statistics only). The cache-read shares are predicted, never measured, and Haiku 5.5's competence as a triage model is untested. Treat the figures as medians; p90/p50 is 2–4.4x elsewhere.
- **At the D5 bound, not inside it.** The large Haiku 5.5 → Opus 5.5 median ($0.74) sits at the $0.75 per-case bound, and at p90 every large row exceeds it.
- **Cheap triage is the largest modelled saving** (58–86% against Opus-only). With cheap triage, **verify is 86–96% of the modelled total** on small and medium PRs, and output is 61–67% of verify's cost.
- **Verify effort is the next lever**: halving verify output cuts the Opus verify pass on a medium PR from $0.330 to $0.222; doubling it, plausible at Sonnet 5.5's `high`, raises it to $0.546.
- Phase A's $0.27 per case is a one-step canned low side, not comparable with this multi-step model; the model's own Sonnet 4.5-only small row is $0.31 cached and $0.44 uncached.
- Vendor per-review prices run from $0.25 (Copilot Lite average) to $25 (ultrareview's upper end). Raw token cost is not comparable with retail per-review prices, and the strong-only large rows ($2.58–5.16) exceed several of them. Internal context only (D12).

### 7.4 ZDR routes *(vendor unless marked)*

- **Anthropic direct**: ZDR per organization through sales; prompt caching is eligible (KV held in memory for the TTL); Batch is not (29-day retention); flagged content may be kept up to 2 years. US-only inference costs 1.1x.
- **Anthropic's own reviewers**: not available under ZDR (§4.1).
- **Anthropic direct, features marked No** (Batch, the Files API, code execution): "Nothing blocks the request" for a ZDR organisation, so VectorScope's client-side refusals are the only guard on direct Anthropic routes *(verify pass, tokenomics missed list)*.
- **OpenRouter with account-level ZDR**: caching works; **its Batch API "cannot run when your privacy settings require ZDR"**, keeps data 30 days and runs on US infrastructure (`batch-api.mdx`, first committed 2026-10-21, last changed 2026-10-31; round two already knew OpenRouter Batch existed) *(verified, weakened: T3-5)*. Service tiers: a workspace default (added 2026-10-24) and presets can move traffic to priority (2x) silently, and priority endpoints of open-weight models compete for default traffic unless `default` is pinned. A workspace allow-list of tiers (added 2026-11-06) rejects a request for a disallowed tier with a 403, which is the stronger control *(verified, weakened: T3-9; confirmed: T3-12)*. Sticky sessions now expire after 60 minutes (round two recorded 10).
- **OpenAI direct**: whether extended caching, Flex and caching-off on gpt-5.6+ are inside ZDR rests on community paraphrases; OpenAI's pages were unreachable.
- **Bedrock**: account retention mode `none` still exists (botocore 1.43.126, 2026-11-06); cache points under ZDR remain unread.

### 7.5 Code facts *(code, `41a64e5e`)*

1. **Fan-out hold: nothing between review and security; lens passes unmeasured.** The review and security passes run on different agents with different system prompts (`agent.ts:518-575`; system block 0 is the agent prompt), so their prefixes diverge in the system prompt. Lens passes run on the review agent (`run.ts:557`) and share its tool definitions and system blocks, both of which carry cache breakpoints (`transform.ts:456-458`), so a hold can yield cache reads on that shared prefix for review plus lens passes, though not on the diff, because the user prompt starts with `TASKS[kind]` (`prompt.ts:342`). A shared-prefix layout for the diff would save about 6% (medium) to 17% (large) on Sonnet-on-Sonnet and under 3% with Haiku triage (*own arithmetic*, assuming a 90% shared share that a zero-spend dry run can measure). This narrows addendum A's VS-40 item 4 to review against security *(verified, weakened: T3-8)*. System block 1 also holds the date and directory, so any cache shared across reviews breaks daily (T3-11).
2. **OpenRouter Batch is not refused by path.** `BATCH_ENDPOINT` (`privacy.ts:370-371`) covers Anthropic Message Batches, Vertex `batchPredictionJobs` and Bedrock `model-invocation-job(s)`, and it is consulted only inside `anthropicPathRefusal` (`privacy.ts:580`), that is, on the Anthropic request format. OpenRouter requests get a body check only (`zdrBodyRefusal`), and a batch body (`requests` with nested `params`, `callback_url`) has no top-level tools or messages to refuse. Direct OpenAI-compatible routes get no body check at all (`privacy.ts:6-10`). No VectorScope code issues batches today; this is defence in depth *(verified, weakened: T3-5)*.
3. **Only some eval price strings cannot express caching.** Replay projections (`vectorscope-replay.ts`) already price with the committed catalog's cache rates: `--model` must equal the catalog's input and output price (`vectorscope-replay.ts:306-329`), the model is priced with `SpendGuard.priceOf` of the catalog cost (`:452-466`), and each pass's low band reads (S−1)·P at the cache-read rate (core `plan.ts:299-305`; engine `review/eval.ts:1066-1077`). So Phase A's low band is a cached figure (one canned step, so no reads in practice) and its high band is uncached. The fixture runner's `run.ts --price` and the `ci.ts` `EVAL_MODELS` strings are `model=input:output` (`ci.ts:111-120`, `budget.ts:208-213`) and cannot express caching; for their budget reservations this is deliberate, so that estimates bound spend (I-5) *(verified, weakened: T3-15)*.

---

## 8. What VectorScope can and cannot claim today

| Owner goal | What the evidence supports | What it does not |
|---|---|---|
| As good as or better than Greptile on large codebases | Design-level differences only: a fail-closed verdict (built pure), ZDR-only routing (pure rules built), a strict guardrail (built pure). None is wired | Any quality or parity claim. Phase A: slice tokens 8.5–9.4x relatedCode with 0 of 1 cross-file recall; latency only below 800 files; no high-band case; high sides $6.60–9.60 against a $0.75 bound. No independent Greptile v5 data (D12; Q39) |
| Predicting future bugs | A risk band that sets depth (VS-28c, built pure), reported internally against outcomes | Any forecast or validation. VS-46a's check is underpowered at owner scale (§5.3); reverts are nearly absent at 200 PRs; the band has never been compared with size alone |
| Precision over recall | D2's paired-recall rule; verification after finding, as every peer does (per-issue validation in one peer's code) | A measured precision: no settled judgement exists until the D5 pilot (D7). Any claim that isolated beats batched verification (untested) |
| ZDR-only routing | The pure refusal rules pass 105 of 105 recorded bodies offline | End-to-end compliance on every transport (VS-23b/c unbuilt); production wire formats (the fake server has no Anthropic Messages, and the bodies come from `@ai-sdk/openai-compatible`, not the OpenRouter SDK); the OpenRouter Batch path gap (§7.5) |

---

## 9. Corrections to rounds one and two

- Greptile's check can fail below an opt-in threshold; "succeeds at any score" holds at a threshold of 0 (§3.1).
- Re-reviews are full, independent reviews (§3.1). "Addressed" as file-touch and source-branch config are restatements of round two, not corrections; TREX on every tier is one unverified extract.
- "Showing risk to developers did not help" holds only for displays with no action attached; with an action, only process proxies improve (§5.1).
- VS-46a's interval rule cannot support "never enable history risk areas" at owner scale (§5.2, §5.3).
- CRBugBench has no licence; addendum A's VS-22 "PR size" bullet must not rely on it (§6.3).
- VS-40 item 4's fan-out hold saves nothing between review and security; its value for lens passes is unmeasured (§7.5).
- OpenRouter's Batch is not covered by VectorScope's Batch refusal, so addendum A's "the OpenRouter batch refusal is now vendor-backed" is wrong (§7.4, §7.5).
- Sonnet 4.5, the eval's example model, retires on Anthropic-operated platforms on 2026-11-30 (§7.1).
- Not corrections (left as round one and two had them): voting stays at evidence tier D (§4.2); the Greptile KB rollout claim is unproven (F6).

## 10. What still could not be verified

- Every Meta number (DRS, RDR, RADAR, JiTTests): extracts only; papers unread (Q38).
- Greptile: where "Required confidence to pass" is set, its vendor default (users observed 0) and its ship date; whether the PR author can move the threshold check through head config; the three AI subprocessors and per-route ZDR scope; what the revert figures mean; whether the 96%-of-722 score reproduction holds; whether credits roll over; whether TREX works with every tier; whether the cloud KB is rolled out per organization (F6).
- Anything opened by neither lane nor verifier: every greptile.com quote, every arXiv number, the Sentry and Copilot blog posts, AIMultiple, OpenAI's pricing and caching pages.
- Whether Anthropic's managed Code Review uses different models for find and verify; claude.dev's 2026-10-15 post (voting, risk tiers, the revert figure); OpenAI's alignment post; Bugbot's retrieval; Augment's March 2026 post.
- Any public ablation of isolated against batched verification, or of same-family voting against cross-family verification, at equal cost: none found.
- Qodo's "precision 0.80 to 0.82" (no page shows it) and OpenAI's 52.7% "addressed" figure (secondaries only): not used.
- OpenAI's Flex and caching-off terms under ZDR; Azure's extended-caching default for gpt-5.5+; which open-weight endpoints are in OpenRouter's ZDR list; Bedrock cache points under ZDR.
- Actual output per step on Opus and Sonnet 5.5 at each effort for VectorScope's prompts (needs the D7 pilot).
- The data licences of CR-Bench, SWE-CARE, CodeReviewQA and CRJudgeBench on Hugging Face; the SWR-Bench and SWE-PRBench paper tables.
- Whether MCR-Bench's "a third of false positives re-raise resolved defects" is in the paper or only in a secondary blog (B3-13, unproven); CRJudgeBench's 76.60% (B3-12, unproven); DRS test-path handling (P3-14, unproven).
- The size of the prompt prefix shared by review and lens passes (measurable at zero spend from dry-run prompt sizes; T3-8, T3-11).
- How often D8-clean repositories carry nested agent instruction files in vendored or test directories (a zero-token count in addendum B's VS-48a would settle it).

---

## 11. Sources

Accessed 2026-11-07 unless stated. Each carries its publication or last-updated date, or "undated". "Extract" means the page was not opened.

### 11.1 VectorScope (code and docs, worktree `41a64e5e`, 2026-11-07)

- `packages/core/src/review/{privacy,plan,dispatch,prompt,types,format,guardrail,risk,select,model-evidence}.ts`; `packages/engine/src/review/{run,impact,model,eval}.ts`; `packages/engine/src/cli/cmd/github.review.ts`; `packages/engine/src/agent/agent.ts`; `packages/engine/src/provider/{transform,provider}.ts`; `script/vectorscope-eval/{outcomes,ci,dataset,run,report}.ts`; `packages/web/public/models/api.json` (255cfd83, 2026-10-28).
- `docs/vector/build/vectorscope-plan.md`, `vectorscope-upgrade.md`, `vectorscope-upgrade-addendum-a.md`, `vectorscope-deviations.md` (searched, not read whole).
- Phase A: `phaseA/REPORT.md` and `phaseA/raw/` (2026-11-07; session records kept outside the repository, I-13). No web source.

### 11.2 Greptile and its users

- npm `greptile` 3.8.0 (2026-10-26); `greptileai/akupara` HEAD `09b7db2` (2026-11-04), PR #117 (2026-11-03), tags to `202610.5`; `greptileai/skills` `59e79ec` (2026-11-03); `greptileai/cli` (unchanged since 2026-05-21). *code*
- Martian `code-review-benchmark` `e616e84` (2026-08-30); ReviewBench `f223ce3` (2026-11-05). *code*
- GitHub issues and PRs (*user-report*): letsrebase/rebase #269 (2026-09-22) and #302 (2026-09-23); hathach/agentrc #176 (2026-10-20); goldmar/openclaw-code-agent #585 (2026-11-03); ejc3/fcvm #927 (2026-09-13); Division6066 #465 (2026-10-02); guilhermegor/dotfiles-linux-dev #804 (2026-10-17); Grimblaz-and-Friends/change-proof #22 (2026-09-24); omacom/omarchy #15333 (2026-10-13); omnivision-solutions/tuti #323 (merged 2026-10-30); michaelshimeles/skills #10 (opened 2026-09-06, merged 2026-10-15); auerbachb/claude-code-config #1897 (2026-11-05); codenamev/ai-software-architect #122 (2026-10-16); Ashref-dev/greptile-style-review (commits 2026-11-02 to 2026-11-03).
- Greptile pages, all extracts (*vendor*): greptile.com/changelog (undated; the TREX GA entry dated 2026-10-16 by usagepricing.com, itself undated); X announcement of computer use in TREX (2026-10-28); TREX blog (2026-06-15); greptile.com/blog/model-inversion (~2026-07-21); greptile.com/blog/greptile-v5 (2026-08-05; one extract shows 2026-09-25); "Rise of the Overnight Agents" (2026-05-05); greptile.com/what-is-ai-code-review (undated, cites Q3 2026 data); security page (last updated 2026-10-18); greptile.com/knowledge-base (undated); docs pages trigger-code-review, mcp/comment-resolution, code-review/greptile-json-reference, troubleshooting/common-issues, code-review-bot/billing-seats, security/selfhost and "Anatomy of a Review" (all undated); build-vs-buy page (undated); YouTube HjEB4quZz5E (undated).
- Others: HN thread on TREX (2026-06-17) and HN item 46777079 (~2026-01-26), extracts; usagepricing.com (undated); synergetic.solutions (updated 2026-11-03), unverified; G2 Greptile reviews (undated); Cubic's comparison page (~October 2026), competitor.

### 11.3 Peer tools

- Anthropic, read in full (*vendor*, undated pages): https://code.claude.com/docs/en/code-review ; https://code.claude.com/docs/en/code-review-pull-requests.md ; https://code.claude.com/docs/en/code-review-customize.md ; https://code.claude.com/docs/en/code-review-costs.md ; https://code.claude.com/docs/en/code-review-setup.md ; https://code.claude.com/docs/en/code-review-troubleshooting.md ; https://code.claude.com/docs/en/code-review-local.md ; https://code.claude.com/docs/en/ultrareview.md.
- Anthropic SDLC post (*vendor*, primary, 2026-07-21; cited by the verify pass): "How Anthropic secures its AI-native software development lifecycle", claude.com/blog.
- Anthropic plugin (*code*; design in `anthropics/claude-code` by `9babb8d`, 2025-12-06; copied as `c905cd8`, 2026-10-26): https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/commands/code-review.md ; https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/plugins/code-review/README.md ; https://github.com/anthropics/claude-plugins-official/commits/main/plugins/code-review/commands/code-review.md.
- Anthropic launch, extract (2026-03-09): https://claude.com/blog/code-review ; https://x.com/claudeai/status/2031088173510701125.
- Anthropic team post, secondary (2026-10-15): https://claude.dev/blog/solving-code-review-at-anthropic/ ; https://techbytes.app/posts/how-the-claude-code-team-does-code-review/ (undated); https://x.com/Prathkum/status/2111181973591077223 (undated); https://paddo.dev/blog/claude-reviewing-claude/ (undated).
- OpenAI, extracts (undated): https://alignment.openai.com/scaling-code-verification/ ; https://www.far.ai/event-recordings/maja-trbacz-a-practical-approach-to-verifying-code-at-scale.
- GitHub: https://raw.githubusercontent.com/github/docs/main/content/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review.md and https://raw.githubusercontent.com/github/docs/main/content/copilot/responsible-use/agents.md (undated pages, main at 8cd1075, 2026-11-06); `data/variables/copilot.yml` (c9d8b26, 2026-11-06); https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/ (March 2026, extract); https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/ (2026-03-05, extract); https://github.blog/changelog/2026-09-18-copilot-code-review-an-improved-review-experience (2026-09-18, extract); https://startdebugging.net/2026/08/copilot-code-review-defaults-to-balanced-on-september-28/ (August 2026, secondary); https://vpsranking.com/news/ai/ai-2026-08-27-github-copilot-code-review-expanded/ (2026-08-27, secondary).
- Cursor and Graphite, extracts: https://cursor.com/blog/building-bugbot (2026-01-15); https://cursor.com/changelog/04-08-26 (2026-04-08); https://cursor.com/blog/may-2026-bugbot-changes (2026-05-11); https://cursor.com/blog/bugbot-updates-june-2026 (2026-06-10); https://graphite.com/diamond (undated).
- CodeRabbit, extracts: https://www.coderabbit.ai/blog/coderabbit-secure-cross-repository-security (2026-10-28); https://www.coderabbit.ai/blog/runtime-verification-in-coderabbit-secure (October 2026); https://docs.coderabbit.ai/security/runtime-verification (undated).
- Qodo, extracts: https://www.helpnetsecurity.com/2026/06/24/qodo-ai-generated-code-governance/ (2026-06-24); https://thenewstack.io/qodo-cross-repo-code-review/ (June 2026); https://www.qodo.ai/glossary/what-is-false-positive-rate-in-code-review/ (undated); https://www.qodo.ai/blog/introducing-qodo-3.0/ (undated).
- Amp: https://ampcode.com/news/liberating-code-review (2026-02-04, extract). Augment: https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent (March 2026, extract); https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results (undated, extract).
- Sentry: https://blog.sentry.io/building-a-code-review-system-that-uses-prod-data-to-predict-bugs (undated; about late 2025, extract); https://www.businesswire.com/news/home/20250923145396/en/ (2025-09-23); https://www.helpnetsecurity.com/2025/09/24/sentry-ai-code-review/ (2025-09-24).
- Cubic: https://www.cubic.dev/blog/learnings-from-building-ai-agents (June 2025, extract); https://news.ycombinator.com/item?id=44386887 (June 2025). Baz: https://docs.baz.co/agents (undated). Bito: https://bito.ai/blog/one-knowledge-graph-design-coding-review/ (undated). Devin Review: https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin (undated); https://www.testingcatalog.com/devin-launches-ai-powered-code-review-tool-for-github-projects (about 2026-01-21). Korbit: https://www.pulse.bot/ma/news/boost-security-acquires-secureiqx-and-korbit-adds-4m-in-new-funding-d18e884b-35f0-41cb-b50a-401d8ea9bcff/ (about 2026-05-06).

### 11.4 Predicting bugs (all extracts unless stated)

- Meta DRS, ICSE-SEIP 2025: https://arxiv.org/abs/2410.06351 (v1 2024-10); slides https://dpe.org/wp-content/uploads/2024/06/Rui-Abrei_-Moving-Faster-and-Reducing-Risk_-Using-LLMs-in-Release-Deployment.pdf (2024-06).
- Meta DRS blog: https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/ (2025-08-06).
- Un-freeze (TOSEM 2025, DOI 10.1145/3722216): https://mockus.us/papers/UnfreezeMeta.pdf (2025).
- RDR, FSE 2026 Industry (DOI 10.1145/3803437.3805220): https://conf.researchr.org/details/fse-2026/fse-2026-industry-papers/19/Code-Reviewer-Recommendation-for-High-Risk-Diffs-at-Scale-Workflow-Recommender-and (2026-07-08).
- RADAR: https://arxiv.org/abs/2605.30208 (2026-05). DRS explanation, AIware 2026: https://arxiv.org/abs/2607.02782 (2026-07).
- Gherald, EMSE 2024: https://rebels.cs.uwaterloo.ca/papers/emse2024_yu.pdf (2024-02). Google 2013: https://research.google/pubs/pub41145/ (ICSE 2013).
- ReDef: https://arxiv.org/abs/2509.09192 (2025-09; FSE 2026). BRACIS 2025: https://sol.sbc.org.br/index.php/bracis/article/view/40828 (2025). DRS-OSS: https://arxiv.org/abs/2511.21964 (v1 2025-11; v2 2026-01-22). CodeFlowLM: https://arxiv.org/abs/2512.00231 (2025-11-28). JIT vulnerability prediction: https://arxiv.org/abs/2507.10729 (2025-07; ICSME 2025).
- Herbold et al.: https://link.springer.com/article/10.1007/s10664-021-10092-4 (2022). Rosa et al.: https://arxiv.org/abs/2102.03300 (2021-02). PR-SZZ residual errors: https://www.researchsquare.com/article/rs-9846265/v1 (undated). LLM4SZZ: https://arxiv.org/abs/2504.01404 (2025-04).
- Who Finishes the Job?: https://arxiv.org/abs/2609.26847 (2026-09). MSR 2026 agent reverts: https://2026.msrconf.org/details/msr-2026-mining-challenge/27/ (2026). Wayfair: https://2020.esec-fse.org/details/esecfse-2020-industry-papers/17/Adapting-Bug-Prediction-Models-to-Predict-Reverted-Commits-at-Wayfair (2020). J.P. Morgan: https://arxiv.org/abs/2403.09507 (2024-03).
- JiTTests: https://arxiv.org/abs/2601.22832 (2026-01); https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/ (2026-10-29), read via https://daily.dev/posts/catching-bugs-before-they-land-jittesting-s-human-on-the-loop-approach-at-full-scale-bvjm0sq9j (undated); https://www.infoq.com/news/2026/04/meta-jit-testing-ai-detection/ (2026-04).
- Tencent false positives: https://arxiv.org/abs/2601.18844 (2026-01). IRIS: https://arxiv.org/abs/2405.17238 (ICLR 2025). Big Sleep: https://projectzero.google/2024/10/from-naptime-to-big-sleep.html (2024-10/11); https://thehackernews.com/2024/11/googles-ai-tool-big-sleep-finds-zero.html (2024-11).
- Huang, Xia & Lo: https://xin-xia.github.io/publication/icsme173.pdf (ICSME 2017). Bludau & Pretschner: https://quarxiv.authorea.com/doi/full/10.36227/techrxiv.171440925.50536437/v1 (2024).

### 11.5 Benchmarks and field studies

- Repositories read (*code*): https://github.com/ZZR0/SWRench at `67ae1d4` (2026-06-05); https://github.com/kinesiatricssxilm14/ContextCRBench at `ade378c` (2026-02-27); https://github.com/codefuse-ai/SWE-CARE at `d0b419c` (2026-04-21); https://github.com/FoundryHQ-AI/swe-prbench at `379f0bf` (2026-03-30); https://github.com/rufimelo99/malicious-pr-bench at `1d5cf2b` (2026-10-21); https://github.com/malusamayo/CRBugBench at `e8e585e` (2026-10-07); https://github.com/cuhk-s3/Archer at `05b2fcf` (2026-10-02); https://github.com/alibaba/aacr-bench at `ee9d7fe` (2026-10-15); https://github.com/review-bench/ReviewBench at `f223ce3` (2026-11-05); https://github.com/MattFlower/agentic-dev-research/pull/8 (opened 2026-11-04, merged 2026-11-06, secondary).
- Papers, extracts: SWR-Bench arXiv 2509.01494 (v1 2025-09-01); CR-Bench arXiv 2603.11078 (2026-03); CR-Bench-v2 arXiv 2611.02566 (2026-11-02); SWE-PRBench arXiv 2603.26130 (2026-03-27); ContextCRBench arXiv 2511.07017 (2025-11-10); CodeFuse-CR-Bench arXiv 2509.14856 (2025-09); MCR-Bench arXiv 2608.27442 (2026-08) and one secondary blog (2026-09-01; host withheld under the naming rule); CodeReviewQA arXiv 2503.16167 (2025-03); CRJudgeBench arXiv 2609.37216 (2026-09); SEVRA-Bench arXiv 2606.13757 (2026-06-11); PRWeaver arXiv 2608.02693 (2026-08); Sphinx arXiv 2601.04252 (2026-01-06); benchmark survey arXiv 2602.13377 (2026-02-13); "Bigger Isn't Always Better" arXiv 2606.15689 (June 2026 ID; one extract gives 2026-04-09); RovoDev arXiv 2601.01129 (2026-01); Sun et al. arXiv 2508.18771 (v1 2025-08-26, v2 2026-04-25); Human-AI Synergy arXiv 2603.15911 (2026-03); Footprints arXiv 2604.24450 (2026-04); AI-to-AI review https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.ESEM.2026.75 (2026).
- Other, extracts: https://aimultiple.com/ai-code-review-tools (last updated 2026-03-13); https://helpnetsecurity.com/2026/10/06/github-reviewbench-ai-code-review-benchmark (2026-10-06); https://thenewstack.io/github-reviewbench-code-review/ (~2026-10); https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ (2026-02-23); https://deepsource.com/blog/ai-code-review-benchmarks (2026, undated).

### 11.6 Tokenomics and ZDR

- Anthropic (*vendor*, undated pages): https://platform.claude.com/docs/en/about-claude/pricing ; https://platform.claude.com/docs/en/about-claude/model-deprecations (the Sonnet 4.5 deprecation dated 2026-09-30); https://platform.claude.com/docs/en/manage-claude/api-and-data-retention ; https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost ; https://platform.claude.com/docs/en/build-with-claude/compaction-threshold.
- OpenRouter docs mirror (*vendor*, https://github.com/OpenRouterTeam/docs at `cf50b6d`, 2026-11-07). The lane dated files by the mirror's head commit (`ae925ae` touches only `openapi.yaml`); dates below are from each file's own history where the verify pass or the critique read it: `guides/features/batch-api.mdx` (first 2026-10-21, last changed 2026-10-31); `guides/features/service-tiers.mdx` (workspace default added 2026-10-24, `32b14fe`; allowed tiers added 2026-11-06, `dfe8f82`); `guides/best-practices/prompt-caching.mdx` (last changed 2026-11-06, `1ba230a`); `cookbook/evaluate-and-optimize/model-migrations/claude-5-5.mdx` (own date not read; present at `cf50b6d`); `faq.mdx`, `snippets/exports/constants.mdx` and `guides/features/zdr.mdx` (own dates not read; present at `cf50b6d`).
- OpenAI and secondary: npm `openai` 7.53.0 (2026-11-06, SDK types); https://github.com/openai/openai-cookbook/blob/main/examples/Prompt_Caching_201.ipynb (last changed 2026-09-16); https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json (fetched 2026-11-07, aggregator); https://github.com/code-yeongyu/senpi/issues/3901 (2026-10-21, community); https://github.com/mostlydev/cllama/pull/69 (2026-10-26, community).
- AWS: botocore 1.43.126 on PyPI (2026-11-06).
