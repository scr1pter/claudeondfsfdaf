# Round three, lens "Greptile since round two": notes for VectorScope

Lane note as written before the adversarial verify pass; REPORT-3 states each finding in its verified, corrected form.

Compiled 2026-11-07. Builds on round one (`vectorscope-research/REPORT.md`, `greptile-*.md`) and round two (`round-two/REPORT.md`, `notes/greptile-primary.md`, `notes/greptile-users.md`). It does not repeat them.

Labels: **vendor** (Greptile, or a partner, about Greptile), **independent** (a third party measured it), **user-report** (GitHub issues and PRs, HN, Trustpilot), **code** (read in shipped artefacts or git refs), **inference** (my reasoning, always flagged). "Extract" means the text comes from a search-engine extract, not a full page read.

`newSinceRoundTwo = true` means round two did not report it. Each finding also says when its source was published, because several sources predate round two and were simply missed.

## 0. Access and method

- **greptile.com and docs.greptile.com are still unreachable.** WebFetch returned ENOTFOUND and curl returned a proxy 403. repowise.dev also failed, so I stopped probing third-party hosts. Greptile prose is again known only from **search extracts**, as in rounds one and two.
- **What worked:**
  - `git ls-remote` and `git clone` of public GitHub repositories;
  - WebFetch of github.com issue and PR pages;
  - the npm registry.
- **Greptile artefacts did not change between round two and today.**
  - npm `greptile`: latest is still **3.8.0** (2026-10-26T22:38Z).
  - `greptileai/akupara`: HEAD is still `09b7db2` (2026-11-04). Its newest PR head is #117 (2026-11-03, a Helm ingress fix). Tags end at `202610.5`.
  - `greptileai/skills`: HEAD is still `59e79ec` (2026-11-03).
  - `greptileai/cli` is unchanged since 2026-05-21, and all of its v3.x tags point to the same install-script commit.
- **No Greptile changelog entry dated 2026-11-01 to 2026-11-07 surfaced.** The newest entry visible in extracts is "Computer use in TREX". Its X announcement decodes to 2026-10-28.
- **Benchmarks did not change either:**
  - Martian `code-review-benchmark` main is still `e616e84` (2026-08-30), and no new Greptile run exists.
  - ReviewBench main is at `f223ce3` (2026-11-05). No ref, branch or PR head mentions Greptile, and the newest refs are dated 2026-11-05.

---

## 1. Corrections: what round two said that is now outdated or incomplete

| Round two said | Now | Evidence |
|---|---|---|
| "Greptile's check succeeds at any score" (GU10, from synnax's `check_review.sh`) | **True only at the default.** The dashboard has a **"Required confidence to pass"** setting on the Greptile status check. Raised to 5, the "Greptile Review" check run concludes `failure` below 5/5. It was seen at 0 on 2026-09-22, and set to 5 and enforced from 2026-09-23. Before mid-September users saw `success` at any score. | letsrebase/rebase #269 (2026-09-22), #302 (2026-09-23); hathach/agentrc #176 (2026-10-20); goldmar/openclaw-code-agent #585 (2026-11-03); ejc3/fcvm #927 (2026-09-13); user-report |
| "TREX is not compatible with Plus, Apex, or Auto at this time" (review-tiers docs extract) | Probably outdated. The "TREX is generally available" changelog entry (dated 2026-10-16 by a third-party tracker) says, per extract, that a TREX run "costs 3 credits and works with every review tier". | greptile.com/changelog (extract); usagepricing.com (undated) |
| Open: whether a push re-review analyses only the new commits | Vendor docs (extract) say each review is "independent, not iterative", so every push gets a full review. Reviews cannot be cancelled once running. | greptile.com/docs/code-review-bot/trigger-code-review (undated, extract) |
| Open: whether "addressed" is a file-touch heuristic | The docs extract now quotes it: "A comment becomes addressed when there's a commit after the comment that modifies the relevant file". | greptile.com/docs/mcp/comment-resolution (undated, extract) |
| Open: whether hosted reviews read config from base or head | The docs extract: "Settings are read from the source branch of the PR and override dashboard settings." This is head-controlled, as round two inferred. | greptile.com/docs/code-review/greptile-json-reference; troubleshooting/common-issues (undated, extract) |
| The KB "is read on every review" (vendor) | In the cloud product, knowledge-base synthesis "is being rolled out per organization, so ask your Greptile contact if you need it enabled". So the KB is not part of every customer's reviews. | greptile.com/changelog (extract) |
| Model Inversion method: 2×500 PRs, 3 runs, LLM judge, high-severity only | Adds about 1,500 ground-truth bug comments, P0/P1 only, and averages over 3 runs. A chart titled "Each model finds more bugs in the other model's code" shows recall values of 64%, 60% and 56%, which cannot be mapped to models from the extract. One secondary source says 1,000 PRs. | greptile.com/blog/model-inversion (~2026-07-21, extract); YouTube HjEB4quZz5E (undated) |
| "A TREX run costs 3 credits" | Still true. The billing docs add that TREX is charged "only when at least one flow reaches a pass or fail", that credits are pooled per organisation, and that auto-recharge exists. Without auto-recharge, "new reviews pause until you add more". | greptile.com/docs/code-review-bot/billing-seats (undated, extract) |
| The v5 launch was 2026-08-05 | Unchanged. One extract shows the v5 post dated 2026-09-25, probably a re-date or edit at the tier launch. Minor. | greptile.com/blog/greptile-v5 (extract) |

---

## 2. What Greptile shipped or published since round two, and the late-October items round two missed

### 2.1 TREX: general availability and computer use (vendor)

- **GA.**
  - The changelog entry "TREX is generally available" lists per-repository environments, custom flows and recordings of each tested flow.
  - It is dated 2026-10-16 by usagepricing.com. The entry itself is undated in extracts.
  - Earlier: public beta on 2026-06-15, with "$2 per run" after the beta, according to the HN thread of 2026-06-17.
- **Computer use** (X, decoded 2026-10-28; exact text): "Introducing Computer Use in TREX. TREX now spins up the relevant services for your changes and uses computer use to test them end to end. It can test desktop apps, click through a web app in a browser to simulate user flows, or use a terminal to test your CLI."
- **Environment docs** (extract, undated):
  - setup instructions of up to 32,000 characters, and a setup script of up to 100,000 characters;
  - variables reach the setup script only;
  - turning off "Allow internet access" blocks egress "except to your repository and Greptile's own services";
  - with internet on, "Allowed domains defaults to All".
- **Independent evidence:** none. The "~20% more bugs" figure is still only "in evals" (vendor, 2026-06-15).
- **For VectorScope:** none new. VS-30 and I-6 (consent, network off, no secrets, own branch only) remain far stricter than TREX's defaults.

### 2.2 The status check can now fail below a confidence threshold (user-report, several repositories)

- **The setting is real.**
  - letsrebase #269 (2026-09-22; exact): "«Required confidence to pass» on the Greptile status check stays at 0: raising it to 5 would turn the check red under 5/5".
  - letsrebase #302 (2026-09-23): the threshold is set under Status Checks at app.greptile.com, and "since 2026-09-23" the `Greptile Review` check goes red below 5/5.
- **Observed in later repositories.**
  - hathach/agentrc #176 (2026-10-20; exact): "When the review scores below the repository's required confidence, the check concludes `failure`". The check's summary says it "reflects your team's confidence threshold, not a review failure".
  - goldmar/openclaw-code-agent #585 (2026-11-03): its gate now requires the `Greptile Review` check run (app id 867647) to be successful on the exact head, plus a `<!-- greptile_confidence_score:5 -->` marker. The reason given is that prose matching broke when a 5/5 review said "no outstanding findings".
- **Before mid-September.** ejc3/fcvm #927 (2026-09-13; exact): "Its conclusion is `success` either way".
- **Not every user knows about the setting.** Division6066 #465 (2026-10-02) still says "Greptile has no built-in score threshold for its own check".
- **Not exposed outside the dashboard.**
  - The CLI 3.8.0 settings schema has no threshold field (code: grep of the bundle).
  - The greptile.json docs list `statusCheck` as a boolean (vendor, extract).
- **What remains weak (user-report):**
  - "below threshold" is a plain `failure`. A bot reader cannot tell it from a crashed CI job: agentrc #176 is titled "a Greptile confidence-gate check run is an unclassified CI failure and reads unknown to the bot reader";
  - the score that drives the threshold is still a model output;
  - there is no "not reviewed" or "incomplete" conclusion.

### 2.3 Refusals that look like reviews, and silent pauses (user-report; the sources date 2026-09-24 to 2026-11-05)

- **Trial limit.** Greptile submits a PR review with state `COMMENTED` whose whole body is a refusal.
  - Exact: "`guilhermegor` has reached the 50-credit limit for trial accounts. To continue receiving code reviews, upgrade your plan" (guilhermegor/dotfiles-linux-dev #804, 2026-10-17).
  - The gate passed PR #801, "whose only review was this refusal".
  - The same pattern appears in Grimblaz-and-Friends/change-proof #22 (2026-09-24): Greptile's wording "matches none of the gate's notice patterns".
- **Open-source credit pool** (exact bot text in omacom/omarchy #15333, 2026-10-13): "Greptile has paused reviews on this repository — it used its 4000 free open-source review credits for this billing period." "To continue before then, an organization admin can keep reviews running past the free credits — those bill as normal usage."
  - This is the first concrete figure for the OSS program found by any round.
  - Inference: the opt-in to bill past the pool fits the Trustpilot reports of open-source repositories triggering paid usage.
- **Out of credits as a plain comment.** omnivision-solutions/tuti #323 (merged 2026-10-30; exact): Greptile "posts its out-of-credits notice as a conversation comment". The team built a fallback to CodeRabbit after 20 minutes of Greptile silence.
- **Stuck checks.** michaelshimeles/skills #10 (opened 2026-09-06, merged 2026-10-15; exact): "one stuck check blocked it permanently"; "It now treats a check running longer than `--stuck-after` seconds, 1800 by default, as stuck."
- **Account-side triggers.** auerbachb/claude-code-config #1897 (2026-11-05): "Paid tools may still review a PR on their own account-side settings (… Greptile's dashboard auto-trigger)". The repository cannot stop paid reviews from its own config.
- **Flex limit** (third-party pricing extracts, undated, unverified): once projected spend reaches the Flex Usage Limit, Greptile "skips reviews that would cost extra credits", leaving PRs unreviewed.
- **For VectorScope:** this confirms VS-32 and I-7. See finding F2 for one regression test.

### 2.4 The knowledge base and "future bugs" (vendor)

- **No new KB feature since round two.**
  - Changelog extract: per-area docs with "risk areas" and a "Reverts section: past high-signal revert, rollback, and incident PRs".
  - "Automating Code Validation" (~2026-07): a fix to a previously merged bug records a risk area.
  - Cloud rollout is **per organization** (see §1).
  - YouTube "Introducing Greptile Knowledge Base" (undated).
- **Still no per-file forecast, score or measured effect.** Independent evidence: none.
- **Greptile's own outcome data** ("Rise of the Overnight Agents", 2026-05-05, Daksh Gupta; extracts):
  - reverts per 1,000 merged PRs, 2026-03-15 to 2026-04-14: "Codex: 1.19", "Claude: 1.80", "Human baseline: 2.72", "Cursor BG: 3.41", "Devin: 3.50";
  - the post's prose says reverts are rare, "4 per 1,000". The two figures disagree, which points to different windows or definitions;
  - by PR size, single-file agent PRs are worse: "13.36 vs 2.99 reverts per 1k". Agent PRs are tied at 2 to 3 files and better at 4 or more files;
  - rework is "Codex sits around 5–6% rework, Claude around 8%. Human stays glued to ~10%";
  - the population is "several million PRs across 65,000 organizations", and the share of AI-authored PRs rose from 0.86% (Feb 2025) to 27.6% (Apr 2026);
  - a monthly "agent leaderboard" exists (April 2026 update).
- **Confidence data** (greptile.com/what-is-ai-code-review, extract; the page says "In our Q3 2026 data, the difference in outcomes between high and low confidence PRs is clear"). The extract summarises it as:
  - 83% of PRs scored 4 to 5;
  - the median time to merge was 1.3 h for 4 to 5 against 3.0 h for 1 to 3;
  - 57% of PRs that started at 1 to 3 reached 4 to 5 after fixes.

  The exact sentences carrying these numbers were not visible. There is no revert or defect outcome by score.
- **Score definition** (docs "Anatomy of a Review", extract): it is "calculated based on the severity and quantity of issues found, the complexity of changes, and how well the code aligns with your codebase patterns". 5/5 means "production ready" and 4/5 "minor polish needed".
- **A community reverse-engineering of the score.**
  - Ashref-dev/greptile-style-review, commits 2026-11-02 to 2026-11-03, README (exact): "Any P0 gives 0/5. Otherwise the score is 5 minus the number of P1s, P2-only gives 4/5, and a security P1 costs one extra point. These rules reproduce Greptile's own score on 96% of 722 real Greptile reviews."
  - The 722-review data is not in the repository, so the claim cannot be reproduced.
  - If it holds, 5/5 almost means "no P0, P1 or P2 comment", and the score adds little beyond the severities (inference).

### 2.5 Other vendor items

- **Security page** "last updated October 18, 2026" (extract).
  - It says SOC 2 Type II, and "zero data retention agreements with LLM providers are available under Resources" on the Trust Center.
  - Administrator-initiated deletion hard-deletes from running production systems within 24 hours.
  - An aggregator (synergetic.solutions, "updated November 3, 2026") counts 18 subprocessors, including 3 AI/LLM providers. It names none, and I could not verify it.
  - Training on de-identified data, with an opt-out, is still reported by third parties.
  - **Named AI subprocessors and the ZDR scope per route are still unverified.**
- **Self-host lag** (docs `security/selfhost`, extract): self-hosted builds have a "maximum 30-day version delta from cloud".
  - Inference: akupara's switch of its default to an OpenAI routing policy on 2026-10-12 probably reflects cloud at most about 30 days earlier. This strengthens round two's reading of akupara as a proxy for the cloud product.
- **Auto-approve docs contradict each other** (extracts):
  - the config reference says `riskCeiling` set to critical approves every 5/5 change;
  - the auto-approve page says Critical-risk changes are never auto-approved;
  - the risk-assessment instructions can be set only in the dashboard.
- **Tier precedence** (troubleshooting, extract): Greptile runs the highest tier set across five sources, and "A comment can raise the tier but not lower it". Cubic (competitor, ~Oct 2026) says Greptile recommends Auto with Apex rules for production-branch PRs and PRs over 30 files. That recommendation is unconfirmed on Greptile's pages.
- **Cost claims** (vendor):
  - the build-vs-buy page puts frontier-model reviews at about $3 to $15 each, against Greptile's flat $1;
  - talk summaries say $3 to $25.

  Neither has a method.
- **Series B** (2026-10-19; round one): ">1% of all PRs opened on GitHub every day". No newer company numbers.

### 2.6 Large codebases and the code graph (vendor and community)

- **Nothing new is shipped or published.**
  - Repo Clusters (changelog 2026-06-02, extract): up to 7 related repositories per review, suggested from shared contributors over the last 90 days.
  - Indexing times (third-party guides, unverified): about 5 minutes for small repositories, 15 to 30 for large ones, up to an hour for a monorepo's first index. A community MCP README advises "indexing specific branches or tags" for large monorepos.
- **Independent evidence:** nothing since round two. Round two's re-analysis (Martian, cross-file n = 34) found no Greptile advantage, and it remains the only measurement.

### 2.7 Learning from feedback

- **Vendor:** the "Memory and Learning" release (2026-05-12), automatic import of CLAUDE.md and similar rule files (2026-07-28), rules suggested after about 10 PRs, and admin approval.
- **Community** (codenamev/ai-software-architect #122, 2026-10-16): three rule stores (dashboard, `.greptile/`, `greptile.json`), and duplicates across them are "a known issue". The per-signal list could not be verified.
- **Independent:** none.

### 2.8 Noise, cost and speed: user reports

- **HN item 46777079** (~2026-01-26; extract, not opened): "pretty much pure noise" after 3 PRs.
  - Its examples are a suggestion to silence an exception already handled upstream, and a claim that Python 3.14 does not exist. The second is a model-knowledge false positive.
  - The same commenter says it found one major bug that human review missed.
- **G2:** 4/5 from 26 reviews (aggregated, old). One headline reads "Faster, Easier Code Reviews—Though Sometimes Slow". The overage is called "steep".
- **Competitor pages** still recycle "11 FP vs 2" (traced to Panto in round two). A Propel-run board reportedly scores Greptile 45% F-score (vendor-competitor, unverified).
- **Online Martian snapshots:** no snapshot dated after early October was found. A search summary claimed a 2026-10-10 cubic snapshot with Greptile 3rd at 63.2 F1; a second search could not confirm it, so it is unusable.
- **Speed:** there is still no independent latency measurement. The vendor's v5 median is "5:04 to 2:25" (extract, "live production data from over a million PRs").

---

## 3. Vendor claim against independent evidence (state on 2026-11-07)

| Greptile claim | Vendor source | Independent evidence | Verdict |
|---|---|---|---|
| Whole-codebase graph and KB give better cross-file and large-codebase reviews | docs, KB page, v5 blog | Round two: cross-file recall 0.48 to 0.51 for v4.1, below four tools and level with a generic agent within CIs (n = 34, Q10-gated). Nothing new. | Unsupported |
| The KB records risk areas and incident history and is read on every review | changelog, KB page | None; and the cloud rollout is per organization | Unsupported; a partial walk-back |
| Learns from team feedback (memory, suggested rules) | changelog 2026-05-12 | None on Greptile. Kodus retired its similar filter (round two). | Unsupported |
| "Predicting future bugs" | revert/incident sections, risk areas | None. Greptile publishes revert rates by agent author, not by its own verdict or score. | No forecast exists; unsupported |
| The confidence score separates PRs | Q3 2026 data: 83% at 4 to 5; merge time 1.3 h against 3.0 h | Round one: 5/5 PRs still missed High or Critical goldens. Community: a severity rule reproduces 96% of 722 scores (unreproducible). | Weak; mostly a function of the severities |
| TREX finds about 20% more bugs | TREX blog | None | Unsupported |
| Model Inversion | blog, about 1,500 ground-truth comments, 3 runs | None | Unsupported (method partly known) |
| Fast (v5 median 2:25) | v5 blog | None | Unverified |
| ZDR with its LLM providers | security page | None; agreements are behind the Trust Center | Unverifiable |

---

## 4. Findings for VectorScope (see the structured result for IDs F1 to F12)

- **F1 (high).** Greptile now ships an opt-in, head-bound pass/fail check above a confidence threshold. Round two's "succeeds at any score" holds only at the default of 0.
  - VectorScope's remaining edge is distinct `not-reviewed`, `incomplete` and `blocking` states, and no model scalar (VS-32, VS-47).
  - **Proposal:** fix the claim in the round-three report and in addendum B's comparison text. Keep VS-32 as designed. When the VS-32 job wiring lands (after the @vector merge, I-9), document the `vectorscope-verdict` tokens for downstream bots, so that a policy result is never read as a CI crash, which is agentrc #176's failure.
- **F2 (high).** Greptile's refusals arrive as `COMMENTED` reviews or plain comments, and gates count them as coverage. Credit exhaustion silently pauses reviews.
  - At worktree head 41a64e5e, VectorScope submits a PR review object only when it has inline findings. The GitHub job checks this at `github.review.ts:765` (`if (!payload.comments.length) return`), and the CLI `--pr` path at `review.ts:639-641` (`count ? … postReview … : []`). Skips and refusals go only to the sticky comment.
  - **Proposal:** with the VS-32 wiring, add a regression test that a `not-reviewed` or `policy-skip` run (budget, privacy, held-back only) never calls `createReview`. Also, under VS-32's value only, prefix the review body of an `incomplete` run that does post inline findings with a bot-authored verdict marker. This is off by default (I-1), and the marker is bot-written, never read from PR text (I-2).
- **F3 (high).** The revert base rate is very low: about 2.7 to 4 per 1,000 merged PRs (vendor; the two figures disagree).
  - VS-46's revert labels will be close to empty on owner volumes: about 0.5 to 0.8 expected reverts in 200 matured PRs (inference).
  - **Proposal:**
    - make the blame-based follow-up-fix label VS-46's primary post-merge outcome;
    - compute expected positives from the observed base rate before any band test;
    - apply the "overlapping intervals on 200 matured PRs" kill rule only to strata with at least 10 expected positives, and otherwise report "underpowered", not "no separation".

    Internal only (I-13, D12).
- **F4 (high).** No PR-level forecast or verdict-outcome link exists at Greptile.
  - **Proposal:** add a VS-46 stratum, "verdict `clean-complete`" against "PRs with findings", reporting post-merge follow-up-fix and revert rates. This is the test Greptile has never published for 5/5. It needs VS-32's `reviewVerdict`, which is already pure. It reads only base-branch history and markers, and is sealed.
- **F5 (high, confirmation).** There is no new independent evidence on Greptile v5, its tiers or large codebases, and no new Martian or ReviewBench run. "As good as or better than Greptile" stays unsupportable under D12. Proposal: none (owner question O1).
- **F6 (medium).** The KB is rolled out per organization in the cloud, refreshes nightly on self-host, and has no published lift. Proposal: none beyond VS-26's ablation gate and VS-46 item 6.
- **F7 (medium).** Re-reviews are full and independent, not deltas; addressed means a later commit touched the file; config comes from the PR head and overrides the dashboard. All three confirm round two's direction (VS-41, VS-46 and I-2). Proposal: none.
- **F8 (medium).** TREX is GA with computer use, every tier and permissive network defaults. VS-30 stays stricter. Proposal: none.
- **F9 (medium).** The Model Inversion method adds about 1,500 P0/P1 goldens and 3 runs averaged. Proposal for the VS-29b eval spec: report P0/P1-only recall averaged over 3 runs, per family pair, with intervals. That makes any comparison like-for-like, and Greptile publishes neither the table nor intervals.
- **F10 (medium).** Greptile's privacy surface is unchanged and still unverifiable; self-host trails cloud by at most 30 days. Proposal: none new (VS-47 receipt).
- **F11 (medium).** Billing mechanics: 4,000 OSS credits per period, a 50-credit trial, auto-recharge, flex-limit skips, and dashboard auto-triggers the repository cannot stop. Proposal: none new (VS-24 caps on by default, base config only).
- **F12 (low to medium).** A model-knowledge false positive ("Python 3.14 does not exist"). Proposal: a VS-22 adversarial control case. It bumps a runtime or library to a version newer than the reviewer model's training data, and the expected result is no finding.

## 5. Open questions

- **O1 (owner).** Should anyone commission a like-for-like Greptile run (Base and Auto) on a D8-clean public set, such as AACR's permissive subset, paid by the owner? Without it, no comparative claim is possible, and no public run of shipped v5 exists.
- **O2.** Where is "Required confidence to pass" set, what is its default, and when did it ship? Users report 0, which suggests opt-in; no vendor page was readable.
- **O3.** Who are the 3 AI subprocessors, and is the ZDR scope per route (Together, GPT-6 Astra, Daybreak) covered?
- **O4.** What do the revert rates actually mean: 2.72 per 1,000 as the human baseline against "4 per 1,000" in the prose?
- **O5.** Can the 96%-of-722 score reproduction be replicated on D8-clean public PRs that Greptile reviewed? It needs no Greptile account and only public PR pages, but it needs GitHub read access at scale.
- **O6.** Do credits roll over or expire? This is still unknown.
- **O7.** Does TREX "work with every review tier"? This needs the GA changelog page itself.
