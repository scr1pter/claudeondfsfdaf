# Round three, lens "Predicting future bugs"

Lane note as written before the adversarial verify pass; REPORT-3 states each finding in its verified, corrected form.

Lane date: 2026-11-07. Worktree read: `/home/user/wt/vectorscope` at 41a64e5e (read-only). No Bun run, no model API called, no repository cloned.

## 0. How this lane worked, and its limits

- **Web search worked this round.** That is the main difference from round two, which had no search at all.
- **Page fetches did not work.**
  - WebFetch failed DNS for `arxiv.org`, `engineering.fb.com` and `www.alphaxiv.org`.
  - `curl` through the proxy got 403 for `arxiv.org` and `github.com`.
  - Following the tool's guidance, I stopped trying new hosts after that.
  - To read the Meta papers (DRS, RDR, RADAR, JiTTests) in full, the owner would have to allow `arxiv.org`, `engineering.fb.com` and `dl.acm.org` in the session's network settings.
- **Every number below from a paper or post is a search-engine extract of that page, not a page I opened.** I quote the wording the extract gave. Where that wording looks like a paraphrase rather than the source's own sentence, I say so. Confidence is lowered for that.
- **My own arithmetic.** The power and sample-size figures (section 3, P3-6 and P3-7) come from a short inline Python computation and simulation (normal approximation; 4,000 Monte Carlo draws per cell; Wilson intervals as in `outcomes.ts`). No files were written. These figures are labelled **independent (own measurement)**.
- **Code reading.** I read `packages/core/src/review/risk.ts` and `script/vectorscope-eval/outcomes.ts` at 41a64e5e.

## 1. What rounds one and two concluded on this lens (not repeated below)

- **Risk sets depth only.** It is never posted as a forecast.
- **At commit level, diff size and spread carry nearly all the ranking power.** Round two measured this on ApacheJIT:
  - diff-only AUC 0.809;
  - Kamei features 0.862;
  - lines added alone 0.805;
  - history adds about +0.00.
- **At PR level the points score is about the same as raw size.**
  - AUC 0.60 against 0.70 on ReviewBench.
  - Commit cutpoints put 56% of PRs in the high band.
  - Findings per kLOC are densest in the low band.
- **SZZ labels build in a size bias**, and commits that add no lines are never labelled buggy.
- **The "self-fix" signal (RP15) was refuted** as a labelling artefact.
- **Meta DRS and RADAR were unread** (RP20, LCI21), so those numbers stayed unverified.
- **No public PR-level dataset with post-merge defect labels was found** (G2-10).
- **"Predict future bugs" can only be validated on VectorScope's own merge outcomes** (VS-46). Do not market it (D12).
- **What the Now window built from this:**
  - VS-28c/VS-39 `risk.ts`: three axes; percentile cutpoints seeded from AACR numstat; history as reasons only.
  - VS-46a `outcomes.ts`: reverts and blame-based follow-up fixes, a band against outcome table, an escape count, and a low-against-high interval-overlap check.

## 2. Bottom line (what round three changes)

1. **Meta's numbers are now visible, and they support round two's framing.**
   - Risk is a percentile gate or a routing signal, and it is scored as "share of incidents captured at a given share of diffs gated".
   - A fine-tuned LLM beats logistic regression mainly at tight gates (1.40x and 1.52x at 5% and 10% gated; 1.05x at 50%).
   - It needs in-house incident labels, and its input includes title and summary text. VectorScope has neither the labels nor I-2 room for that text.
   - So **no model call in `riskOf`** stays right (P3-1, P3-3).
2. **Contradiction to round one's shorthand "showing risk to developers did not help".**
   - The 2013 Google result stands, but it was a file-hotspot display with no action attached.
   - Two newer studies show positive effects when risk drives a concrete action:
     - a 48-person controlled experiment (EMSE 2024);
     - a randomized trial at Meta on more than 20,000 high-risk diffs (FSE 2026): an extra reviewer plus a pre-land dialog the author can bypass.
   - The rule "never posted as a prediction" still holds. The evidence strengthens Q28 (let repository rules act on band and reasons). Caveat: the Meta trial's outcome is the risk model's own score on the final diff, not defects (P3-2).
3. **VS-46a, as built, cannot yet answer "does the band predict future bugs?" honestly.**
   - Its follow-up-fix label is plain blame on the fix's deleted lines, i.e. basic SZZ. That has known label noise:
     - about half of SZZ "fixes" are not bug fixes;
     - add-only fixes cannot be traced;
     - the size bias is built in by construction.
   - Its decision rule is non-overlap of two Wilson intervals. At 200 matured PRs, that rule detects a real 2x separation only about 12% of the time (own simulation).
   - It never compares the band with a size-only ranker, which is the competitor round two identified (P3-5, P3-6).
4. **A causal "deeper review means fewer future bugs" result is out of reach at owner-repository scale.**
   - Roughly 900 to 1,500 matured high-band PRs per arm are needed for a 25% relative reduction at 13 to 20% base rates (own arithmetic).
   - Lens decisions must rest on pre-merge proxies. Post-merge outcomes stay a monitor (P3-7).
5. **The most promising new way to catch latent bugs before they ship is not prediction at all.** It is diff-time generated tests that separate head behaviour from base behaviour:
   - Meta's JiTTests: 4x candidate catches over hardening tests;
   - 74 privacy SEV bugs caught at the diff stage in the first half of 2026 (industrial self-report).

   VS-30 already has the consent, isolation and executor to try a narrow, off-by-default version (P3-8).
6. **What is confirmed rather than changed:**
   - no LLM risk scorer;
   - no vulnerability-likelihood score (realistic-base-rate PR-AUC collapses to 0.005 to 0.111);
   - reverts kept as a separate, cleaner label;
   - percentile bands;
   - no claims.

## 3. Findings

Kinds: **academic** (a peer-reviewed paper or preprint; industry authors are noted), **vendor** (a company's own product claim), **independent** (my own measurement or a third party), **code**.

### P3-1. Meta DRS: risk is scored as "share of incidents captured at a share of diffs gated", and LLM gains are concentrated at tight gates (new; round two RP20 unverified)

- **Evidence** (academic, Meta authors, search extract):
  - ICSE-SEIP 2025, arXiv 2410.06351 (v1 Oct 2024): "A baseline logistic regression model captures 18.7%, 27.9%, and 84.6% of SEVs at the 5%, 10%, and 50% gating thresholds, respectively". This wording may be the extract's paraphrase.
  - Same paper: "iCodeLlama-34B and iDiffLlama-13B, when risk-aligned, capture more SEVs than the logistic regression model in production: 1.40x, 1.52x, 1.05x, respectively". StarBERT captured "0.61x, 0.85x, and 0.81x".
  - AIware 2026 (arXiv 2607.02782, July 2026), citing that work: fine-tuning on "diffs, summaries, and titles" let the model "catch over 40% of outages by gating only the top 10% of diffs" (extract wording).
  - TOSEM 2025, DOI 10.1145/3722216 (Mockus, Abreu, Rigby et al.):
    - The evaluation uses "the fraction of flagged/gated changes to measure overhead and the fraction of all outage-causing changes contained within the set of flagged set of changes".
    - "only 16% of changes are gated. Although 42% more changes landed ... compared to the prior year, there was a 52% decrease in outages."
  - Meta blog (2025-08-06): "DRS evaluates code changes and metadata to produce a risk score and highlight potentially risky code snippets"; 10,000+ changes landed during a 2024 freeze.
  - RADAR (arXiv 2605.30208, May 2026): DRS "powers approximately 20 risk-aware features across Meta".
- **Reading:**
  - The lift over the base rate is 3.7x at 5% gated (logistic regression) and about 5x (LLM). At 50% gated the LLM adds only 5%.
  - The 52% outage drop is a year-on-year before/after comparison with no control group.
- **Implication for VectorScope:**
  - Use capture-at-overhead, by share of PRs *and* share of lines, as the primary metric, not AUC or interval overlap.
  - The LLM advantage needs fine-tuning on incident labels, and title and summary text as inputs. I-2 forbids that text choosing depth, and VectorScope has no such labels.
- **Proposal:** in VS-46 `open`, add a capture table:
  - for the top 10%, 20% (the high band) and 50% of matured PRs by `riskOf` score, report the share of positives captured, the share of PRs and the share of changed lines;
  - beside it, report the same for a size-only ranking (log(added+deleted)) and the paired bootstrap difference.

  This is a script-only change: read-only, sealed, and makes no model call.

### P3-2. Risk helps when it triggers an action: two newer studies qualify Google 2013 (new; contradicts round one's shorthand)

- **Evidence:**
  - **Google** (ICSE 2013; academic, research.google page): "We deployed a bug prediction algorithm across Google, and found no identifiable change in developer behavior." Its stated must-haves are actionable messages, obvious reasoning and a bias toward the new (secondary summary).
  - **Gherald** (Yu, Cogo, McIntosh, Godfrey; EMSE 2024, online Feb 2024; academic): a controlled between-subjects experiment with 48 participants. Gherald "is associated with statistically significant improvements" in risk awareness and code review effectiveness (one-tailed Mann-Whitney, α = 0.05). Efficiency was not significant (extract).
  - **Meta RDR** (FSE 2026 Industry, presented 2026-07-08; academic, Meta authors; official abstract via search extract):
    - The workflow "assigns an additional recommended reviewer for high-risk diffs and shows a bypassable pre-land dialog";
    - in a randomized trial on the top 5% of diffs it increased review depth and collaboration;
    - it raised the share of diffs whose final version fell below the high-risk threshold by 9.56%, "a minor 0.45% increase in diff reviewing time";
    - the recommender was A/B tested on more than 5k diffs. A secondary listing gives "9.94% more comments and 7.77% more acceptances"; unverified.
- **Caveats:**
  - RDR's main outcome is DRS's own score on the final diff. That is self-referential, and no defect or revert outcome was found in the extracts.
  - Gherald is a lab study.
- **Implication for VectorScope:**
  - "Never posted as a prediction" stays right.
  - What works is risk tied to more scrutiny with obvious reasons. VectorScope's version is more depth (VS-28) and, only if Q28 is answered yes, band and reasons in `--json` so a repository's own rules can add a reviewer. That keeps I-14: no new App permissions, and VectorScope does not assign reviewers itself.
- **Proposal:**
  - Cite RDR and Gherald under Q28 as evidence for a "yes, inside the receipt key" answer.
  - In VS-46, report the human-review rate (the existing `humanReview` field) by band. That is a cheap proxy for whether repository rules change scrutiny.

### P3-3. LLM-based JIT defect prediction: zero-shot loses, fine-tuned models lean on surface cues, and DRS-OSS's gain may be text leakage (new; round two had only recall)

- **Evidence:**
  - **BRACIS 2025** (academic): "fine-tuned small and medium open models outperform zero-shot prompting of the closed LLMs" (extract paraphrase of the abstract; no numbers).
  - **ReDef** (FSE 2026; arXiv 2509.09192, Sep 2025; academic):
    - 3,164 defective and 10,268 clean function-level changes from 22 C/C++ projects, anchored on reverts;
    - under counterfactual swaps of added and deleted blocks, "performance remains effectively stable, revealing that what appears to be robustness in fact reflects a reliance on superficial cues rather than true semantic understanding";
    - a secondary review reports 92% audited label precision.
  - **DRS-OSS** (arXiv 2511.21964; v1 Nov 2025, v2 2026-01-22; academic):
    - a Llama 3.1 8B classifier on ApacheJIT "reaches a ROC–AUC of 0.895";
    - v1 says gating "the riskiest 30% of commits can prevent up to 86.4% of defect-inducing changes";
    - its inputs include commit messages.
  - **CodeFlowLM** (arXiv 2512.00231, 2025-11-28; academic): for line-level localisation, "GPT-5 delivers comparable performance for Recall@20% and Effort@20% ... although attention-based methods retain an advantage in fine-grained ranking metrics (Top-k, IFA)".
- **Reading** (inference): round two measured Kamei features at 0.862 on ApacheJIT's time split, and showed that message-related "fix" signals there are a labelling artefact (RP15). DRS-OSS's +0.03 with commit messages in its input is therefore not evidence that the diff semantics add anything. Its split method could not be checked.
- **Implication for VectorScope:** the contract's rule stands: no model call for `riskOf`, and the model may only raise `Selection.risk`. No change needed.
- **Proposal:** none.

### P3-4. Just-in-time vulnerability prediction collapses at realistic base rates (new)

- **Evidence** (ICSME 2025, arXiv 2507.10729, July 2025; academic):
  - "The average PR-AUC of mainstream methods plummets from 0.805 to 0.016";
  - "JIT-Fine, dropped to 0.111 on FFmpeg and 0.005 on Linux";
  - neutral commits are more than 90% of commits;
  - imbalance remedies did not help.
- **Implication for VectorScope:**
  - Keep `sensitive` as an impact floor only (as built).
  - Never derive or claim a vulnerability likelihood from change features.
- **Proposal:** none.

### P3-5. VS-46a's follow-up-fix label is basic SZZ, with known noise and a size bias built in (new: VS-46a postdates round two)

- **Evidence (code):** `script/vectorscope-eval/outcomes.ts` at 41a64e5e.
  - `fixHits` (lines 1214–1270) blames only the fix commit's deleted lines (`git blame --line-porcelain --first-parent`), with no whitespace or comment filter.
  - `fixKind` (lines 456–475) decides a fix from a PR label (`FIX_LABEL`) or the title regex.
  - A fix that only adds lines, such as a newly added null check, cannot be traced. A PR that only deletes lines can never be labelled.
- **Evidence (academic):**
  - Herbold et al. (EMSE 2022): "only half of the bug fixing commits determined by SZZ are actually bug fixing".
  - Rosa et al. (ICSE 2021, arXiv 2102.03300): SZZ variants "do not take into account added lines, but only deleted lines, since those are the ones on which it is possible to use the blame command". The JSS 2023 version adds DU-chain tracing.
  - PR-SZZ residual-error preprint (Research Square rs-9846265 v1, undated): "PR-SZZ generates wrong defect labels for approximately 12% of commits"; against manual labels "average model recall drops from 0.72 to 0.64 and precision from 0.27 to 0.19".
  - LLM4SZZ (ISSTA 2025): precision up "from 2.4% to 9.2%".
  - Who Finishes the Job? (arXiv 2609.26847, Sep 2026): human-validated follow-up fixes; an LLM judge reaches "Cohen's Kappa=0.78 against a human-human K=0.77, Direct-fix precision 90%".
- **Implication:**
  - VS-46's band-against-fix table will partly rediscover size by construction, as SZZ did on ApacheJIT (RP6).
  - Its fix labels may be only 50–90% precise, and nothing in the sealed report estimates that.
- **Proposal:** script-only changes, read-only git, sealed output, no model call (an LLM judge would breach VS-46's no-model rule and the egress rules for customer data):
  1. **Label audit.** `open` draws a seeded random sample, for example 50 positive and 50 negative matured PRs. The owner labels them by hand, and the report gives label precision and recall with Wilson intervals. Without an audit, rates are marked "unaudited".
  2. **Untraceable share.** Report the share of fix commits with zero deleted lines.
  3. **Filter cosmetic lines.** Blame with `-w` and skip deleted lines that are blank or comment-only, in the style of MA-SZZ.
  4. **Reverts first.** Report the revert label as the primary band check, because it has no blame-size bias. Fix labels are secondary.
  5. **Normalise by size.** Add fix-edited lines per kLOC added, by band.

### P3-6. VS-46a's separation check is underpowered, so its kill rule fires on sample size (new; independent own measurement)

- **Evidence (code):** `bandsOf` (`outcomes.ts:1713–1758`) declares "separated" only when the low and high bands' 95% Wilson intervals do not overlap, at 200 or more matured PRs. "Overlap" triggers VS-46's kill: "document `riskOf` as a size, reach and sensitivity heuristic ... and never enable history risk areas".
- **Evidence (own simulation):** with the low band at 50% and the high band at 20% of N matured PRs, the share of runs that come out "separated":

  | N | 10% → 20% | 7% → 15% | 7% → 35% (bugbug-like) |
  |---|---|---|---|
  | 200 | 0.12 | 0.11 | 0.89 |
  | 500 | 0.39 | 0.32 | 1.00 |
  | 1,000 | 0.77 | 0.68 | 1.00 |

  A normal-approximation two-proportion test has power 0.30 at N = 200 for 10% → 20%. Interval non-overlap is roughly a p < 0.006 test.
- **Also:**
  - Nothing compares the band against size alone.
  - The production band in `outcomes.ts:895` is computed without `dependents`, so reach is never tested.
- **Implication:** an "overlap" result at owner scale is mostly a statement about N. The kill rule would usually fire even when a real 2x separation exists, and a "separated" result would mostly rediscover size.
- **Proposal:**
  1. Print the minimum detectable effect for the observed counts before any verdict.
  2. Use a difference-in-proportions interval, plus P3-1's paired capture comparison against size alone.
  3. Return three verdicts: "beats size", "no better than size" (the interval excludes a pre-registered margin) and "undecided".
  4. Change the kill wording so that "undecided" means "not yet", never "never enable".

  This is an amendment to VS-46's measurement rule (addendum-B material).

### P3-7. A causal "deeper review → fewer future bugs" effect needs Meta-scale volume (new; own arithmetic)

- **Evidence (own arithmetic):** two-sided α = 0.05, power 0.8, matured PRs per arm, to detect a 25% relative reduction:

  | Base rate | Per arm |
  |---|---|
  | 13% (bugbug's "about 1 in 8"), to 9.75% | ~1,500 |
  | 20%, to 15% | ~905 |
  | 4% revert rate, to 3% | ~5,300 |

  - The 4% figure is from J.P. Morgan: "less than 4% of code commits resulting in reverts" (arXiv 2403.09507, Mar 2024; academic, industry authors).
  - With the high band holding at most 20% of PRs, the 13% case means about 15,000 matured PRs in total.
- **Comparison:** Meta's RDR trial used more than 20,000 high-risk diffs (P3-2).
- **Implication:**
  - VS-46 item 7 (depth assigned through trusted config, independent of risk) is the right design, but it will rarely reach a decision on one owner repository.
  - Lens decisions must use VS-39's pre-merge measure: high-severity recall per extra dollar against the equal-token control.
- **Proposal:** the VS-46 report prints the depth-comparison minimum detectable effect, and suppresses any "depth effect on outcomes" row below it. State in the contract that post-merge outcomes are a monitor, not a gate, for lenses.

### P3-8. Catching latent bugs before they ship: diff-time tests that separate head from base behaviour (new)

- **Evidence:**
  - **The paper** (arXiv 2601.22832, Jan 2026; academic, Meta authors):
    - "Analyzing 22,126 generated tests, we show code-change-aware methods improve candidate catch generation 4x over hardening tests and 20x over coincidentally failing tests";
    - the intent-aware workflow turned 6.4% of its tests into weak catches, against 2.5% for the "dodgy diff" workflow;
    - the main challenge is false-positive test failures.
  - **Meta Engineering post** (2026-10-29; vendor/industrial self-report, read through secondary extracts such as daily.dev):
    - "In the first half of 2026 the system caught 74 serious privacy bugs at the diff stage and lowered privacy SEV occurrences by 20%";
    - "589 engineers ... or 64% of those reached out to, engaged ... and these engineers reported a 60% true-positive rate";
    - it "catches classes of bugs that LLM- or agent-based code reviews might not".
- **Implication:**
  - VS-30 is finding-first: the review proposes, and a reproducer confirms.
  - JiTTests are behaviour-difference-first: generate tests on the changed code, run them on base and head, then judge whether the difference was intended.
  - This catches bugs no review pass hypothesised.
- **Proposal:** a VS-30 sub-mode, "differential probe".
  - **Off by default and opt-in.** It uses the same `--checks` consent bound to SHA and command digest, runs local-only, and is never used for `--pr`, forks or CI (I-6). It runs on the high band only. The repro pass runs on a ZDR route (I-3).
  - **The model** returns tests that exercise the changed functions, with no tools.
  - **The executor** runs each twice on base and twice on head.
  - **Outcomes:**
    - a test that passes on base and fails on head becomes a candidate;
    - it is posted only if the model ties it to a finding with trigger and impact that passes the guardrail (I-2: exit codes and the tie decide; test output stays untrusted);
    - otherwise it goes in notes as "behaviour changed, not judged" and is never posted.
  - **Measure** on VS-30's trusted fixtures:
    - defects caught only by probes (complementarity);
    - posted false catches on behaviour-preserving controls, which must be 0;
    - p90 added time within VS-30's 6-minute cap;
    - cost per catch.

### P3-9. Static analysis plus LLM hybrids: strong at removing false positives, but filters drop 12–14% of true alarms (new)

- **Evidence:**
  - **Tencent** (ICSE-SEIP 2026, arXiv 2601.18844; academic, industry data):
    - 433 alarms (328 false positives, 105 true positives);
    - LLM4PFA eliminates "94-98% of false positives while maintaining high recall", recall 0.86–0.88;
    - $0.0011–$0.12 and 2.1–109.5 s per alarm, against 10–20 minutes manually.
  - **IRIS** (ICLR 2025, arXiv 2405.17238; academic):
    - "detecting 55 vulnerabilities, which is 28 (103.7%) more than CodeQL" on 120 CWE-Bench-Java cases;
    - "average false discovery rate of 84.82%".
- **Implication:**
  - Analyzer candidates are far below D2's 80% precision unless they are verified.
  - Even good LLM filters lose about 1 true alarm in 8. VS-42's kill rule (drop at most 2% of settled true positives) is appropriately stricter than the field.
- **Proposal:**
  - None now.
  - Later and off by default: repository-produced SARIF on changed lines as untrusted hypotheses for the verify pass, measured for class-scoped recall and precision on VS-22.

### P3-10. Variant analysis seeded by past fixes found a pre-release bug; VectorScope uses history only as reasons (new)

- **Evidence:**
  - **Project Zero "From Naptime to Big Sleep"** (vendor/industrial, 2024-10/11) and The Hacker News (2024-11):
    - Big Sleep was given a previously patched SQLite bug and run over "the recent changes to the SQLite source code";
    - the stack buffer underflow it found was "in a development branch ... flagged before it made it into an official release" (news wording).
    - It is one anecdote.
  - **Greptile's knowledge base page** (vendor, undated) lists a "potential risks" layer of past bugs. No measured effect has been found in three rounds.
- **Implication:**
  - Round two showed that fix history does not help *rank* commits (RP4).
  - Whether a prior fix's diff helps a reviewer *detect* a recurrence is a different, untested question.
- **Proposal: a zero-spend pre-check first.**
  - In VS-46 `open`, report the recurrence share: the share of matured follow-up fixes whose fixed lines fall in a file or function that had an earlier fix within 365 days of the reviewed PR's merge.
  - Pre-register, for example: build only if at least 25%.
  - If it passes, add a "prior-fix card": one of VS-26's at most three cards, carrying the most recent fix diff of the touched function from the base history, as wrapped untrusted data (I-2) on the ZDR route. Measure it in the funded ablation (Q9).

### P3-11. Agent-authored merges draw more follow-up fixes; authorship is a trusted signal locally (new)

- **Evidence:**
  - **Who Finishes the Job?** (arXiv 2609.26847, Sep 2026; academic):
    - 6,774 merged agent PRs against 5,044 contemporaneous human PRs from the same repositories;
    - verified follow-up fixes at 1.62 times the odds (extract wording);
    - "69.6% of verified fixes in agent merges come from the same agent".
    - Whether it controls for size is unknown.
  - **MSR 2026 Mining Challenge** "When AI Code Doesn't Stick" (academic, 2026), revert causes: "unintended side effects and overengineering (22.33%), functional incorrectness (22.13%), code quality issues (17.71%), and dependency management problems (12.47%)".
- **Implication:**
  - Locally, Vector knows which model wrote a change from trusted records (VS-29b, VS-46's agent split). That is not untrusted text, so a raise-only use fits I-2.
  - VS-46 already splits outcomes by agent stratum.
- **Proposal:**
  - Add "agent-authored (trusted local record)" as a `riskOf` reason only.
  - Grant a raise-only floor of medium under `depth: auto` only if VS-46 shows higher outcome rates for agent PRs within each size tercile, with an interval excluding 0.
  - It stays off by default and never comes from markers or PR text.
  - New owner question (QP3-2).

### P3-12. Reverts are the cleaner, rarer label; revert prediction is industrially established (partly new)

- **Evidence:**
  - **Wayfair** (ESEC/FSE 2020 Industry; academic, industry): models "rank reverted commits above 80% of non-reverted commits on average"; in a developer study they "reduce the amount of time needed to find certain kinds of bugs by 55%".
  - **J.P. Morgan** (arXiv 2403.09507, Mar 2024): fewer than 4% of commits reverted.
  - **RADAR** (arXiv 2605.30208, May 2026):
    - "Reverts across 535K+ RADAR reviewed diffs: 1/3 the rate of non-RADAR diffs";
    - "For human-authored diffs, the default DRS threshold is P5";
    - "Each runbook must demonstrate a clean track record over a 60-day lookback window".
    - The selection effect is unquantified.
- **Implication:**
  - VS-46 is right to keep reverts separate and backed-out PRs neutral.
  - Reverts have no blame-size bias, but they are rare. See P3-7 for the volume this needs.
- **Proposal:** covered by P3-5 item 4 (reverts first for the band check).

### P3-13. Effort-aware metrics: report the low band's miss rate and the first-hit cost, not only band rates (partly new)

- **Evidence:**
  - **Huang, Xia & Lo** (ICSME 2017, PDF; academic): PCI@20% and IFA, because "developers are not willing to use a prediction model if the first few recommendations are all false alarms".
  - **Bludau & Pretschner** (TechRxiv 2024 preprint; academic): "while still reviewing 95% of defective commits, on average, 46% of the non-defective commits are correctly identified".
  - **CodeFlowLM** (see P3-3): LLMs are competitive on Effort@20% but weaker on IFA.
- **Implication:**
  - The low band is VectorScope's RADAR-like saving. Its honest cost is the share of positives that land in it.
  - `order(files)` (risk density) should be scored as Effort@20% on fix-edited lines.
- **Proposal:** in VS-46's capture table, add:
  - the low band's share of positives, against its share of PRs and lines;
  - Effort@20% for `order(files)` inside matured multi-file PRs.

### P3-14. Explaining risk: Meta's attention highlighting is noisy on generated and test files (new; low relevance)

- **Evidence** (AIware 2026, arXiv 2607.02782): token attention is aggregated into lines, hunks and files, with the top K shown in review. "Code changes in test files are often mechanically correlated with the code under test and rarely represent the root cause of a risky diff." Users complained about noisy highlights on generated or test code (overview extract).
- **Implication:** VS-39's deterministic reasons, test-path exclusion and generated-file classification already match these lessons.
- **Proposal:** none.

### P3-15. Sentry Seer and the other vendors: production data for picking files, no independent evidence (new; vendor)

- **Evidence:**
  - Sentry engineering blog (undated; beta announced around 2025-09-24, per Help Net Security): "If more than five files will be changed, it narrows the set down to the most error-prone files". Multi-agent hypotheses are drafted, then verified.
  - The launch post says it "won't prevent every error from happening".
  - No benchmark was found. A search for PR "merge risk" features at the major vendors found nothing shipped.
- **Implication:** VectorScope has no production telemetry and must not pull customer runtime data off the machine. Nothing to adopt.
- **Proposal:** none.

### P3-16. Greptile: still no measured effect of its "risk areas" (not new)

- **Evidence:** greptile.com/knowledge-base (vendor, undated), via search extract: three layers, including "potential risks", which "tracks past bugs and risks". No revert or incident mechanism and no metric were found in search.
- **Implication:** round two's G2-12 and GP10 stand. A "predicts future bugs" claim is unsupported for everyone (D12).
- **Proposal:** none.

### P3-17. VS-42's pre-existing drops are an unscored, free stream of latent-bug forecasts (new proposal)

- **Evidence:**
  - **Code:** VS-42a drops `pre-existing` findings and counts them in `StrictResult.dropped` and in notes. They are never posted.
  - **Round two G6-13:** 6.6% of ReviewBench true positives are pre-existing and 2.2% exacerbated.
  - **JiTTests** (P3-8) and **Big Sleep** (P3-10) both catch latent bugs in code that is not the focus of the change.
- **Implication:** each dropped pre-existing finding is a forecast that "this location has a bug". VS-46 could score that against later fixes without posting anything.
- **Proposal:**
  - **Eval and local artifacts only.** Never put these in GitHub state or markers, because hidden markers are still public.
  - **What to keep:** path, base line span, class, base SHA and fingerprint for each `pre-existing` drop.
  - **Scoring:** VS-46 `open` joins them to later fixes (blame of the fix's deleted lines) to report latent-forecast precision at 90 days. It is sealed and internal (I-13, D12).
  - **Kill:** drop it if precision is under 10% on at least 100 drops.

## 4. How to measure "predict future bugs" honestly (protocol)

1. **Target.** A PR merged at least 90 days ago is positive if it was reverted within 90 days, or if a follow-up fix edited lines it added. Report reverts first.
2. **Label quality.**
   - The owner hand-audits a seeded sample of at least 50 positives and 50 negatives.
   - Report label precision and recall with intervals, and the share of untraceable add-only fixes.
   - Unaudited rates are flagged as such.
3. **Primary metric.** Capture at overhead, after Meta: the share of positives in the top 10%, 20% and 50% of PRs by score, with overhead given both as a share of PRs and as a share of changed lines.
4. **Baselines.** Size alone (log(added+deleted)) and random, with a paired bootstrap over PRs. The band "predicts" only if it beats size alone.
5. **Low-band miss rate.** The share of positives in the low band, against the low band's share of PRs and lines.
6. **Pre-merge catch rate.** The share of fix-edited lines flagged before merge, against the share that escaped (VS-46 already has this), split by band and depth. This is the direct measure of "caught latent bugs before they shipped".
7. **Power.** Print the minimum detectable effect from the matured counts before any verdict. Verdicts are "beats size", "no better than size" or "undecided". Never write "never" on an undecided result.
8. **Causal depth effects.** Measure these only with trusted-config assignment (VS-46 item 7), and only above the minimum detectable effect. Otherwise post-merge outcomes are a monitor only.
9. **Scope.** Internal only (D12): no accuracy claim, contamination noted, permissive licences or owner repositories only (D8, Q30).

## 5. VectorScope against the field

| Capability | Field evidence | VectorScope now | Gap |
|---|---|---|---|
| Change-risk band | Meta: percentile gates; LR captures 27.9% of SEVs at 10% gated; LLM 1.52x | VS-28/39 `risk.ts`: three axes, percentile cutpoints, history as reasons only | Fine as is; a model scorer is impossible under I-2 and unhelpful without labels |
| Risk → action | RDR: extra reviewer plus dialog, randomized; PTS (Meta) and test spend | Depth only; band never posted; `--json` waits on Q28 | Q28 (P3-2) |
| Outcome labels | Revert-anchored (ReDef, 92%); human-validated follow-up fixes (90% precision) | Reverts, plus basic-SZZ blame of deleted lines; unaudited | P3-5 |
| Validation metric | Capture at overhead (Meta TOSEM); IFA and PCI (Huang et al.) | Interval overlap, low against high, at 200 PRs | P3-1, P3-6, P3-13 |
| Pre-existing / latent | JiTTests; Big Sleep variant analysis | VS-42 drops pre-existing findings; nothing scores them | P3-17, P3-10 |
| Catching before ship | JiTTests: diff-time differential tests | VS-30: finding-first reproducers under consent | P3-8 |
| Static plus LLM | LLM4PFA removes 94–98% of false positives at recall 0.86–0.88 | Guardrail and verifier; no analyzer input | P3-9 (later) |

## 6. New owner questions

- **QP3-1.** May `arxiv.org`, `engineering.fb.com` and `dl.acm.org` be allowed, so that the DRS, RDR, RADAR and JiTTest papers can be read in full? Every Meta number here is a search extract.
- **QP3-2.** May "agent-authored (trusted local record)" become a raise-only depth floor once VS-46 shows separation within each size tercile (P3-11)?
- **QP3-3.** For the differential probe (P3-8): may a "behaviour changed, not judged" note appear in local notes, given that it is never posted?
- **QP3-4.** Roughly how many PRs per 90 days are merged on the repositories nominated for VS-46? This decides whether P3-6's verdicts can ever leave "undecided".

## 7. Sources (all dates as given by the source or its listing; "extract" means search-engine extract, page not opened)

- Meta DRS, ICSE-SEIP 2025: https://arxiv.org/abs/2410.06351 (v1 2024-10); slides https://dpe.org/wp-content/uploads/2024/06/Rui-Abrei_-Moving-Faster-and-Reducing-Risk_-Using-LLMs-in-Release-Deployment.pdf (2024-06). Extract.
- Meta DRS blog: https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/ (2025-08-06). Extract.
- Un-freeze, TOSEM: https://mockus.us/papers/UnfreezeMeta.pdf, DOI 10.1145/3722216 (2025; FSE 2026 journal-first). Extract.
- RDR, FSE 2026 Industry: https://conf.researchr.org/details/fse-2026/fse-2026-industry-papers/19/Code-Reviewer-Recommendation-for-High-Risk-Diffs-at-Scale-Workflow-Recommender-and (2026-07-08), DOI 10.1145/3803437.3805220. Extract.
- RADAR: https://arxiv.org/abs/2605.30208 (2026-05). Extract.
- DRS explanation, AIware 2026: https://arxiv.org/abs/2607.02782 (2026-07). Extract.
- Gherald, EMSE 2024: https://rebels.cs.uwaterloo.ca/papers/emse2024_yu.pdf (2024-02), DOI 10.1007/s10664-024-10443-x. Extract.
- Google 2013: https://research.google/pubs/pub41145/ (ICSE 2013). Extract.
- ReDef: https://arxiv.org/abs/2509.09192 (2025-09; FSE 2026). Extract.
- BRACIS 2025: https://sol.sbc.org.br/index.php/bracis/article/view/40828 (2025). Extract.
- DRS-OSS: https://arxiv.org/abs/2511.21964 (v1 2025-11; v2 2026-01-22). Extract.
- CodeFlowLM: https://arxiv.org/abs/2512.00231 (2025-11-28). Extract.
- JIT-VP realistic evaluation: https://arxiv.org/abs/2507.10729 (2025-07; ICSME 2025). Extract.
- Herbold et al., EMSE 2022: https://link.springer.com/article/10.1007/s10664-021-10092-4 (2022). Extract.
- Rosa et al.: https://arxiv.org/abs/2102.03300 (2021-02; ICSE 2021). Extract.
- PR-SZZ residual errors: https://www.researchsquare.com/article/rs-9846265/v1 (undated). Extract.
- LLM4SZZ: https://arxiv.org/abs/2504.01404 (2025-04; ISSTA 2025). Extract.
- Who Finishes the Job?: https://arxiv.org/abs/2609.26847 (2026-09). Extract.
- MSR 2026 agent reverts: https://2026.msrconf.org/details/msr-2026-mining-challenge/27/ (2026). Extract.
- Wayfair: https://2020.esec-fse.org/details/esecfse-2020-industry-papers/17/Adapting-Bug-Prediction-Models-to-Predict-Reverted-Commits-at-Wayfair (2020). Extract.
- J.P. Morgan: https://arxiv.org/abs/2403.09507 (2024-03). Extract.
- JiTTests paper: https://arxiv.org/abs/2601.22832 (2026-01). Extract.
- JiTTests post: https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/ (2026-10-29), via https://daily.dev/posts/catching-bugs-before-they-land-jittesting-s-human-on-the-loop-approach-at-full-scale-bvjm0sq9j (undated). Extract.
- InfoQ on JiTTests: https://www.infoq.com/news/2026/04/meta-jit-testing-ai-detection/ (2026-04). Extract.
- Tencent false positives: https://arxiv.org/abs/2601.18844 (2026-01; ICSE-SEIP 2026). Extract.
- IRIS: https://arxiv.org/abs/2405.17238 (v3; ICLR 2025). Extract.
- Big Sleep: https://projectzero.google/2024/10/from-naptime-to-big-sleep.html (2024-10/11); https://thehackernews.com/2024/11/googles-ai-tool-big-sleep-finds-zero.html (2024-11). Extract.
- Huang, Xia & Lo: https://xin-xia.github.io/publication/icsme173.pdf (ICSME 2017). Extract.
- Bludau & Pretschner: https://quarxiv.authorea.com/doi/full/10.36227/techrxiv.171440925.50536437/v1 (2024). Extract.
- Sentry: https://blog.sentry.io/building-a-code-review-system-that-uses-prod-data-to-predict-bugs (undated); https://www.helpnetsecurity.com/2025/09/24/sentry-ai-code-review/ (2025-09-24). Extract.
- Greptile knowledge base: https://www.greptile.com/knowledge-base (undated). Extract.
- Code: `/home/user/wt/vectorscope/script/vectorscope-eval/outcomes.ts` and `/home/user/wt/vectorscope/packages/core/src/review/risk.ts` at 41a64e5e (2026-11-07).
