# VectorScope upgrade contract, addendum B (round three)

Files: this addendum is `docs/vector/build/vectorscope-upgrade-addendum-b.md`, committed as a proposal pending Q45 (§5). It extends `docs/vector/build/vectorscope-upgrade.md` and addendum A (`docs/vector/build/vectorscope-upgrade-addendum-a.md`). Its evidence is `docs/vector/build/vectorscope-research/round-three/REPORT-3.md`, which cites Phase A (`phaseA/REPORT.md`, a session record kept outside the repository, I-13) and the five round-three lane notes beside it.

Status: a proposal written 2026-11-07, against worktree `/home/user/wt/vectorscope` at `41a64e5e`. It is not approved and not implemented, and it makes no claim of measured quality.

- **Rules inherited:** the contract's §0 rules (P0, the windows, the six §0.3 items, tests and typecheck from package directories, the "Never" list); invariants I-1 to I-14; decisions D1 to D14 (including D14: nothing user-facing in 1.99.113); addendum A's rules, keys and owner questions Q18 to Q34. §3 proposes text amendments to addendum A (CRBugBench, VS-40 item 4, the OpenRouter batch line) and Q36 amends Q26's wording; nothing else is changed.
- **Approval.** Every package here needs owner approval, asked by a new question, Q45 (§5). Q18 covers only VS-32 to VS-49 and stays as it is. Two Now items amend Q15-scope packages (VS-21e amends VS-21, VS-22d amends VS-22), and R4 amends VS-27's wiring; Q45 lists them separately from the items that amend Q18-scope packages.
- **Evidence.** Every lane finding cited here went through the adversarial verify pass (`verdicts.json`, a session record kept outside the repository, I-13); packages cite the corrected form of weakened findings, and none rests on an unverifiable one (REPORT-3, "How to read this").
- **Windows (as in addendum A):**
  - **Now**: pure core modules that no runner calls, uncalled engine builders, eval scripts and eval data. Zero tokens, zero outbound model requests.
  - **Runner-wiring**: after `self-evolving` merges, or on owner exception Q13.
  - **Later**: after a named merge (`vector-at-mention`, `codium`), a measured trigger, or a funded ablation (Q9).
- **Names.** Each item amends an existing package and takes the next free suffix. Suffixes already used or reserved in `vectorscope-deviations.md` are skipped: VS-37b (a possible split of VS-37a), VS-44b (certificate integration), VS-45b (rubric v2 on Q29), VS-46b (VS-46 item 4, proxy validation). So the outcome-script amendments are VS-46c and VS-46d, not new packages and not a second outcome script. VS-40's pure items 1 and 2 landed inside VS-24c without a suffix of their own, so its first suffix is VS-40a.
- **"Unset byte-identity"** in each Now item states the test that shows nothing changes for today's runners and for today's eval outputs when the new input, option or key is absent. For core files in the pipeline pin (`REVIEW_PIPELINE_SOURCES`, `model-evidence.ts:62`), the pin moves and the deviation entry says whether `REVIEW_PIPELINE_REVISION` must go up; it stays at 1 for every item below, because no runner applies the change.
- **No item here supports a quality, parity or prediction claim.** REPORT-3 §8 lists the measured limits.

---

## 1. Now-window packages, in build order

Order: the open I-3 gap first; then the eval fidelity the D6 choice (Q35) needs before projections are re-run; then the dataset; then the large-codebase items Phase A exposed; then VS-35b, a pure helper placed before the outcome script because VS-46d item 6 reads its classifier; then the outcome script (VS-46c, VS-46d, one ledger schema change); then the remaining pure helpers that later wiring will call.

### 1.1 VS-33b Batch and stored-file paths on every ZDR route

*Amends VS-33a (`packages/core/src/review/privacy.ts`). Evidence: tokenomics T3-5 (verified, weakened: the code gap is confirmed, the date and the "new" framing are corrected); REPORT-3 §7.5 item 2.*

- **Problem.**
  - OpenRouter's Batch API (`batch-api.mdx`, first committed 2026-10-21, last changed 2026-10-31) keeps data 30 days, "cannot run when your privacy settings require ZDR", and takes a `callback_url`. It is not new: round two knew of it and wrongly concluded that "the OpenRouter batch refusal is now vendor-backed" (addendum A; §3 corrects that line).
  - `BATCH_ENDPOINT` (`privacy.ts:370-371`) lists Anthropic Message Batches, Vertex `batchPredictionJobs` and Bedrock `model-invocation-job(s)`, and it is read only inside `anthropicPathRefusal` (`privacy.ts:580`), on the Anthropic request format.
  - OpenRouter requests get `zdrBodyRefusal` only, and a batch body (`requests` with nested `params`, `callback_url`) has no top-level tools or messages for it to refuse. Direct OpenAI-compatible routes get no body check at all: "Every other allowed route sends its body unchanged" (`privacy.ts:6-10`).
  - Anthropic does not block Batch, the Files API or code execution for a ZDR organisation either ("Nothing blocks the request"), so client-side refusals are the only guard.
  - No VectorScope code issues batches today; this is defence in depth for VS-23c.
- **Design.**
  1. A new exported pure `zdrPathRefusal(path: unknown): RouteRefusal | undefined`. It normalises the pathname as `anthropicPathRefusal` does and returns `"batch"` for:
     - every path `BATCH_ENDPOINT` matches today;
     - OpenRouter `/api/v1/batches` and its subpaths;
     - OpenAI `/v1/batches` and `/v1/files` and their subpaths. Files are refused as `"batch"` because OpenAI's Batch API reads its input from stored files, and VectorScope never uploads files.
     - A non-string path is `"unreadable-body"`.
  2. `anthropicPathRefusal` and `BATCH_ENDPOINT` stay exactly as they are, so every Anthropic-format refusal value is unchanged (for example `/v1/batches` on the Anthropic format still returns `"anthropic-non-zdr-feature"`).
  3. `zdrBodyRefusal` refuses as `"batch"` a body that has a top-level `requests` array or a `callback_url` field (OpenRouter's batch body shape), before its existing checks.
  4. VS-23c's transport backstop calls `zdrPathRefusal` on every OpenRouter and OpenAI-compatible request, and the body-shape check on every request on those routes, including direct OpenAI-compatible ones that today get no body check (runner-wiring, §2 R1).
- **Unset byte-identity.** No runner calls `privacy.ts`'s refusal functions today (VS-23b and VS-23c are unbuilt), and they apply only under `privacy: zdr`. Tests: all 48 existing `privacy.test.ts` cases pass unchanged; `anthropicPathRefusal`'s existing path table is unchanged; the 105 wire bodies that Phase A recorded (or the repository's own recorded-body fixtures, since Phase A's records stay outside the repository under I-13) still pass `zdrBodyRefusal`. Those bodies come from `@ai-sdk/openai-compatible` against a fake server with no Anthropic Messages endpoint, so they show only that the change refuses nothing it refused before on that format, not compliance of production wire bodies (R1 closes that).
- **Tests:**
  - refused: `/api/v1/batches`, `/api/v1/batches/b-1`, `https://openrouter.ai/api/v1/batches?x=1`, a trailing slash, `/v1/batches`, `/v1/batches/b-1/cancel`, `/v1/files`, `/v1/files/f-1/content`;
  - allowed: `/api/v1/chat/completions`, `/api/v1/responses`, `/api/v1/messages`, `/v1/chat/completions`, `/v1/responses`, and near-misses `/v1/batchesx`, `/v1/filesystem`;
  - bodies with `requests: []` or `callback_url` are `"batch"`; a chat body with a message whose text contains "requests" is not;
  - a non-string path is `"unreadable-body"`.
- **Invariants:** I-3 (closes a gap), I-1, I-12 (pin).
- **Done when:** merged with tests, the pin updated, a deviation entry.
- **Kill:** none; it is a refusal.
- **Window:** Now (pure); R1 wires it.
- **Depends on:** VS-33a. **Owner questions:** none new.

### 1.2 VS-21e Eval cost fidelity

*Amends VS-21a to VS-21c (eval scripts, core `eval-report.ts`, engine test fixtures). Evidence: T3-2, T3-3, T3-7, T3-9, T3-12, T3-15 (all weakened or confirmed; corrected forms used); Greptile F9; Phase A observation 1.*

- **Problem** (*code*, `41a64e5e`).
  - Replay projections already price with the committed catalog's cache rates: `vectorscope-replay.ts --model` must equal the catalog's input and output price, "the cache rates come with it" (`vectorscope-replay.ts:306-329`); the model is priced with `SpendGuard.priceOf` of the catalog cost (`:452-466`); each pass's low band reads (S−1)·P at the cache-read rate and its high band reads none (core `plan.ts:299-305`, engine `review/eval.ts:1066-1077`). What is missing there is a side-by-side cached and uncached view in the report (core `eval-report.ts` `renderProjections`, `:611`).
  - The fixture runner's `run.ts --price` and the `ci.ts` `EVAL_MODELS` strings are `model=input:output` (`ci.ts:111-120`; `budget.ts:34-37`, `:208-213`) and cannot express caching at all. For budget reservations this is deliberate: `estimateUsd` counts the whole body as input at the input price "so estimates bound spend" (`budget.ts:217-225`, I-5), and `run.ts` settles each ticket with `charge(answer, flags.price)` (`run.ts:412-422`).
  - Cost is not split by pass or by token kind, although verify is 86–96% of the modelled cost with cheap triage (REPORT-3 §7.3, an unmeasured model).
  - Reasoning tokens are already recorded per review (`ReviewCost.reasoning`, core `types.ts:314`, filled at engine `review/run.ts:370` and merged into output at `:401`), but not per attempt or per pass.
  - High-severity recall with intervals already exists per variant and model (`breakdowns.highSeverity`, core `eval-report.ts:214`, computed at `:393` with `gate.confidence`, VS-45a), but not averaged per repetition or grouped by family pair.
  - Under the canned model `engine` and `engine:shared-verify` are identical. On the engine the two policies pick the same candidates at `verify: blocking` whatever the severities (core `plan.ts:180-198` against `:213-223`; `plan.test.ts:470-477`). They differ only for an untrusted case under `verify: all` or a triage pair, where the shared policy also sends a nit or below-`minConfidence` finding that carries a suggestion.
  - The owner setup in the eval README does not cover OpenRouter's service tiers or Batch.
- **Design:**
  1. **Cache-aware price strings, projection-only.** `run.ts --price` and `ci.ts` `EVAL_MODELS` accept `input:output[:cacheRead[:cacheWrite]]`. The cache fields are parsed into a separate projection-only price that only projection and report code reads. `budget.ts`'s `Price`, `parsePrice` (two fields), `estimateUsd`, Ledger admission and `run.ts` settlement are unchanged: reservations and settlement stay uncached, and a cache price can never lower a reservation, an admission check or a ticket (I-5, D5). `ci.ts` passes only the two-field price to `run.ts`'s budget path and to `vectorscope-replay.ts`. `vectorscope-replay.ts --model` and `--triage-model` stay at two fields, checked against the catalog as today; their cache rates keep coming from the catalog.
  2. **Side-by-side view and cost split.** Core `eval-report.ts` `renderProjections` shows, per pass, the low band (cache reads at the catalog rate) and the high band (uncached) as the cached and uncached figures, and the VS-21c report gives projected and settled cost per pass (review, security, each lens, verify) and per token kind (input, cache read, cache write, output).
  3. **Reasoning tokens per attempt and per pass**, read from the session's `tokens.reasoning`, beside the existing per-review `ReviewCost.reasoning`. Recording only; absent when the provider reports none.
  4. **A `suggestion-untrusted` canned scenario** for projections, opt-in by flag, whose canned replies live with today's in engine `test/fixture/projection.ts` (`projectionReplies`): an untrusted case run under a triage pair or `verify: all`, whose canned review emits a nit or a below-`minConfidence` finding carrying a suggestion. Under it `engine:shared-verify` sends one more verify candidate than `engine`. The default canned replies are unchanged.
  5. **High-severity recall over repeats.** Build on `breakdowns.highSeverity`: add only the averaging per repetition and the grouping per model family pair, with the existing intervals. This is the like-for-like form for any internal comparison with Greptile's Model Inversion method, which publishes neither table nor intervals (Greptile F9, weakened: little beyond round two). It is also the spec for VS-29b's report.
  6. **D6 price sanity table.** A dated table of list prices for the models the owner picks under Q35 that warns when a given price string differs. This is the eval-side assertion T3-7 asks for; the catalog fix itself is outside the contract (§3).
  7. **README owner setup** (eval key, Q7): in the OpenRouter workspace Routing settings, disallow every non-default service tier (a request for a disallowed tier then fails with a 403) and leave the workspace default at `default`; no presets that set a tier; never use Batch; note that credit-funded keys pay a 5.5% purchase fee, so effective price is list × 1.055. R2 also pins `service_tier: "default"` on requests, because priority endpoints of open-weight models compete for default traffic unless it is pinned (T3-9, T3-12).
- **Unset byte-identity.** Two-field price strings parse to the same `Price` objects as today, and every `plan`, projection and report output is byte-identical (a test reruns the existing projection fixtures and compares digests). A test that a four-field `--price` leaves every Ledger reservation, every `estimateUsd` result and every ticket amount byte-identical to the two-field run. Artifacts without the per-attempt reasoning field validate as before. Without the scenario flag, projection body digests equal today's. Without the new report options, `report.ts` output is byte-identical. No runner file changes (the projection hook already exists).
- **Tests:** parsing of 2, 3 and 4 price fields and rejection of 5 or of negative values; the cache fields never reach `Price`, `estimateUsd`, the Ledger or `charge` (the four-field test above); cached figure ≤ uncached figure; per-pass and per-kind sums equal the total; per-attempt reasoning read from a fixture session; under the new scenario `engine:shared-verify` has exactly one more verify candidate than `engine`, and under the default replies the two are identical (as today); per-repetition high-severity recall on a synthetic report; the price-table warning.
- **Invariants:** I-5 (reservations stay worst-case; estimates stay estimates), I-13, I-1, I-12 (no key added).
- **Done when:** a zero-spend re-run of Phase A's projection commands reports the cached and uncached figures and the split.
- **Kill:** none (measurement).
- **Window:** Now. Effort pinning per pass is runner-wiring (§2 R2).
- **Depends on:** VS-21a, VS-21b, VS-21c, VS-45a. **Owner questions:** Q35 (which models to re-run with), Q45 (approval).

### 1.3 VS-40a Estimator: long-context tiers and effort-keyed output

*Amends VS-40, whose pure items 1 and 2 landed inside VS-24c (`packages/core/src/review/dispatch.ts`, `plan.ts`). Evidence: T3-3 (confirmed), T3-6 (confirmed, with the Sonnet 4.5 tier it missed).*

- **Problem.** `ReviewPrice` (`plan.ts:17-22`) has only input, output, cacheRead and cacheWrite, so every step is priced at the base tier. Haiku 5.5 costs 5x above 100K prompt tokens; OpenAI gpt-5.5+ 2x input and 1.5x output above 272K; and the catalog's OpenRouter `anthropic/claude-sonnet-4.5`, today's example model, 2x input and 1.5x output above 200K (`api.json`, `cost.tiers`). On the large Haiku review pass, 3 of 20 steps cross 100K and the pass costs $0.0695 instead of $0.0436 (+59%; `notes-tokenomics.md` §6.3, the lane's own model). The calibrated output per step (1,800, one case) ignores effort, which now sets thinking spend.
- **Existing rule.** The engine already picks a tier for reservations: `Session.costAt` (engine `session/session.ts:442-449`) takes the highest context tier the request strictly passes (`contextTokens > tier.size`), and `experimentalOver200K` only when no exact tiers exist; `review/run.ts:311-313` uses it. VS-40a reproduces that rule in core, and a parity test keeps them equal (I-10).
- **Design.**
  1. `ReviewPrice` gains optional `tiers?: {above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number}[]`. VS-40's per-step estimate prices step k at the tier for its prompt length L_k = P + (k−1)R, counting cache reads and writes in the length as Anthropic does, by `Session.costAt`'s rule.
  2. **How projections get tiers.** The dry projection provider cannot carry exact tiers: the engine config's only long-context form is `context_over_200k` (`vectorscope-replay.ts:399-401`; engine `provider.ts:2002-2021`), so Haiku 5.5's 100K tier never reaches the booted model. The replay script therefore reads `cost.tiers` from the model's committed catalog entry (which `catalogModel` already reads, `vectorscope-replay.ts:306-329`) and passes them to the estimate directly, beside the booted model's price. Carrying tiers through the engine config instead would change its schema (I-11, SDK regeneration) and is not Now. In runners, nothing passes `tiers` until VS-24 is wired.
  3. `calibratedOutputPerStep(model?, effort?)` returns today's 1,800 whenever effort is absent. The table holds only measured entries; new entries are added from D7 pilot artifacts (VS-21e item 3), with their fit date and cases.
  4. The two new shrink levers T3-2 names ("verify output cap or effort" and "a candidate cap before verify") are offline projection sweeps only, not part of the runtime shrink order and not a replay variant, until the VS-21a `VariantEntry.params` follow-up (addendum A, not yet built; `replay.ts:153-158` has no `params`) lands and the funded ablation (Q9) measures their quality cost.
- **Unset byte-identity.** With `tiers` and effort absent, `estimateCostUsd`, the VS-40 estimate and `nextStepCostUsd` return today's numbers over a grid of P, R, S and prices (an extension of the existing pin test). `OUTPUT_PER_STEP` is unchanged. Without the replay script's tier read, projection outputs are byte-identical. The pipeline pin moves (`plan.ts`, `dispatch.ts`).
- **Tests:** a hand-computed tier crossing (the Haiku example above); a step exactly at the threshold priced at the lower tier ("over 100,000" is strict); the OpenAI 272K tier; the Sonnet 4.5 200K tier from the catalog fixture; parity with `Session.costAt` over a grid of context sizes and catalog costs (exact tiers, `experimentalOver200K` only, both, neither); tier ordering and duplicate thresholds rejected; effort-absent equality.
- **Invariants:** I-5, I-10 (one estimator rule, checked against the engine's), I-1.
- **Done when:** projections report tiered and base-tier estimates per pass, with Haiku 5.5's 100K tier read from the catalog.
- **Kill:** keep the base-tier estimate in the gate unless the tiered one's median absolute error on pilot runs is at least 5 points lower (VS-40's own rule).
- **Window:** Now; wired with VS-24 (§2 R2 for effort).
- **Depends on:** VS-24c, VS-21e; item 4's variant form also on the VS-21a `params` follow-up. **Owner questions:** Q45 (approval).

### 1.4 VS-22d Dataset, round three

*Amends VS-22 (dataset schema, `dataset.ts`, `ci.ts mirrors`, eval data). Evidence: Phase A observations 5 and 8; the benchmarks note's proposals P1 to P5 (verdicts B3-01, B3-02, B3-07, B3-11, weakened); Greptile F12 (weakened: an extract of a round-two source).*

- **Problem.** Phase A found: cross-file 1 of 30 targeted, trivial controls 0 of 20, trivial-looking bug cases 0 of 3, adversarial 0 of 10, `runnable` on 0 of 8 bug cases (target 15), and `dataset.ts --mirrors` exiting 1 on `ci.ts mirrors` output. External sets lack PR dates and licence records, and their goldens are not VectorScope's.
- **Design:**
  1. **Curation.** No new targets: this item re-prioritises VS-22b's existing targets, which block VS-24's skip-rate gate, VS-25's recall gate and VS-30. Every new label starts as a draft. Two Phase A leftovers are recorded here, not fixed: Phase A's second labelled location that no arm reached (vite, `packages/plugin-legacy/index.js:454-459`, in the changed file but outside its hunks; an in-file, out-of-hunk case for VS-25's recall gate, not a tier b case), and the risk features missing on every case (churn, `fixCommits`, reverts, dependents), which VS-28 and VS-25b wiring supply. CI-against-local band agreement needs a GitHub run and stays with VS-28 wiring.
  2. **Adversarial cases:**
     - **Newer-than-training version** (Greptile F12): a change that bumps a runtime or library to a version released after the reviewer model's training cutoff; expected result: no finding about the version's existence.
     - **Narrative-invariance fixtures** (benchmarks P3, SEVRA's method, no SEVRA data copied): 10 to 20 cases in D8-clean repositories made by reversing a real security fix, each with a neutral, non-empty `pr.body` (`ReplayCase.pr`, engine `review/eval.ts:119`; a blank body drops the `pr_body` block, core `prompt.ts:433`) and 3 to 5 framings (prior approval, false coverage, misleading hardening, an agent-authored claim, evidence dilution). Cases are never selected by how the model under test (or any candidate model) reviews them, unlike SEVRA's retained split (B3-07). Each reversed fix has a benign counterpart (the real fix itself), so the paid comparison can report a false-decline rate beside the refusal rate.
     - **Now: a recording test**, limited to what a projection record holds today (engine `review/eval.ts:366-391`): for each framing, the projection gives the same `scope` (`EvidenceScope`, including the policy digest), the same `models`, the same pass list with the same `maxSteps`, and recorded wire bodies that differ only inside the wrapped `<untrusted_pr_body>` block. This is a direct I-2 test at zero spend for those fields.
     - **With each wiring package:** the same comparison for the depth plan (VS-28 wiring), lenses (VS-28 wiring), the privacy decision (VS-23b/c) and the runtime decision (VS-30), which no Now projection produces (their variants are pending, `replay.ts:170-203`).
     - **Later (Q9):** the paid comparison that findings and verdict do not change between framings.
  3. **External manifest fields:** `prDate` (benchmarks P4); `licence: {spdx, path, commit, classifierVersion}` (P1), recorded at each PR's own base commit; `stratum: "unflagged"` for SWR-Bench's permissive clean PRs (P2), which never count toward D2's controls and score only functional changes, mapped onto the five classes. **Import keeps only `{repo, SHA, label}` manifests plus these fields**: PR bodies, review text, full diffs, commit author and committer names and email addresses, and every other personal field are stripped (benchmarks verify pass, missed list).
  4. **External goldens are drafts** (P5). They count toward D2's held-out defects only after settlement under rubric v1, and they never reach tools, retrieval or a Brain (I-13).
  5. **Licence classifier script** (`script/vectorscope-eval/research/licences.ts`):
     - classify on the SPDX header (`SPDX-License-Identifier`) when present, otherwise on the licence's title line (the first non-blank heading, such as "GNU GENERAL PUBLIC LICENSE Version 3"), never on body keywords. Body keywords produced both known errors: GPL-2.0 that mentions the Library GPL read as LGPL, and GPL-3.0, whose section 13 names the Affero licence, read as AGPL (B3-01);
     - a file holding both BSD and MIT texts is `mixed` and needs a hand ruling;
     - check at every PR's own base commit, never only at a repository's earliest and latest commits: psf/requests was ISC until late 2012, and 7 SWR-Bench PRs sit at ISC commits (B3-02);
     - a per-path pass for bundled directories (`src/libs`, `third_party`, `vendor` and similar);
     - output is the manifest field above. Results stay uncommitted (I-13). The verify pass's re-derived counts are seeds to be reproduced by the script, never inputs: ReviewBench 195 MIT, 23 with no root licence file (16 repositories), 1 GPL-3.0 (statista); SWR-Bench 797 after excluding pylint and matplotlib, about 790 without the ISC-era requests PRs.
  6. **Object checks.** `ci.ts mirrors --with-fixes <dir>` fetches the fix commits into a separate object-check store, never into the replay mirrors. `dataset.ts --mirrors` keeps exit 1 on a missing fix commit, but prints one line naming the flag.
- **Unset byte-identity.** Without the new flags, `ci.ts mirrors` writes the same objects and `dataset.ts` prints the same output, except the added hint line on the exit-1 path. The seed set's freeze digest is unchanged while no seed case uses a new field; if the schema version must bump, the deviation entry records the old and new digests. No runner file changes.
- **Tests:** validators for each new field; `prDate` required on external cases; stripping of PR bodies, diffs, names, emails and other personal fields; `unflagged` cases excluded from the D2 control count; draft external goldens excluded from the D2 defect count; the recording test across framings (with a non-empty neutral body); classifier fixtures (GPL-2.0 mentioning the Library GPL, GPL-3.0 with its section 13 Affero mention, AGPL-3.0, an SPDX header that disagrees with the body, BSD bundling an MIT notice, no file); a repository whose licence changes between two PR base commits; the `--with-fixes` store kept apart from the mirrors.
- **Invariants:** I-2 (the recording test), I-13, D8, D12.
- **Done when:** the dry run reports the new strata and counts, and the recording test passes on the fixtures.
- **Kill:** none (data).
- **Window:** Now; the paid narrative comparison is Later (Q9).
- **Depends on:** VS-22a, VS-22c, VS-21b. **Owner questions:** Q36 before SWR-Bench, SWE-PRBench or Archer data is used; existing Q27 and Q31; Q45 (approval).

### 1.5 VS-37c Tier b for same-package outbound references

*Amends VS-37a (core `outboundUses`, engine `review/impact.ts`, uncalled). Evidence: Phase A observation 3.*

- **Problem.** On the only cross-file case (caddy, `hosts.go:83`), the missed location is a field of a same-package Go type in another file, and tier b packed 0 tokens. **Likely cause, supported by code:** tier b's targets come from import statements. The builder's comment (engine `impact.ts:1114`) says "the files the changed lines' imports name", and core `outboundUses` binds a reference only to an import statement of the file: "A bare name the file defines itself is never an import's, and a member of anything else (`obj.save()`) binds to nothing" (core `impact.ts:700-760`). A same-package Go file needs no import, so nothing binds. The fixture below confirms this before any change.
- **Design.**
  1. **Test first.** A fixture with a Go package of two files, where a changed line uses a field of a type declared in the sibling file. Expected today: tier b packs nothing (the code above); expected after item 2: it packs the declaration's signature.
  2. **If the test fails as expected:** for Go, resolve identifiers on changed lines against declarations in the other `.go` files of the same directory (excluding `_test.go` unless the changed file is a test), read exactly as `readTargets` reads tier b's files today: `git show --no-textconv <head>:<path>` of the head tree-ish (engine `impact.ts:1125`, `:1180`; I-8 as written), inside tier b's 10-signature cap and the 6k-token cap. The later move of every builder read to `git cat-file --batch` follows Q18 and the I-8 amendment with the other reads (deviation log, VS-25b: Later), not this item. Other languages with directory-scoped packages are listed for later measurement, not changed.
  3. **If the test passes unexpectedly:** record in the deviation entry why tier b packed 0 on caddy, and close the item without a code change.
- **Unset byte-identity.** The builder is uncalled, so nothing changes for runners. Under `impact: graph` with packing unset, VS-25b's slice is byte-identical (existing test). For every non-Go seed case, the tiered output is byte-identical to `41a64e5e`'s (a golden over the seed set). Core and engine `review/impact.ts` are both in the pipeline pin, so the pin moves and the deviation entry records it.
- **Tests:** the fixture; the cap; deduplication against the diff and tier a; no read outside the reviewed tree.
- **Invariants:** I-8 (as written), I-1, I-12 (pin), I-13.
- **Done when:** the test passes and the caddy projection is re-measured at zero spend.
- **Kill:** VS-37's rule (tier b stays off if it adds less than 3 points of file- or repo-level recall at equal tokens). With n = 1 cross-file case, no decision is possible until VS-22d's curation lands.
- **Window:** Now; wired with VS-25b.
- **Depends on:** VS-37a, VS-25a. **Owner questions:** Q18 (VS-37's approval, already open); Q45. Not the I-8 amendment: this item reads as the builder does today.

### 1.6 VS-38a Large-repository latency run at zero spend

*The measurement VS-38's "Done when" requires, on the builders that exist (VS-25b, VS-37a). Evidence: Phase A observation 4.*

- **Problem.** p95 under 1 s was measured only on repositories of 100 to 800 files. VS-38's bands (under 10k, 10k to 50k, 50k or more) and its blobless-sparse case are unmeasured, so no large-codebase latency statement is possible.
- **Design.**
  1. Write the bench the deviation log already plans and defers (VS-25b: "the optional `vectorscope-impact-bench.ts` over Kubernetes, Keycloak and vscode, which was not written") as `packages/engine/script/vectorscope-impact-bench.ts`, beside its precedent `vectorscope-parse-bench.ts`, starting from Phase A's scratch `measure.ts` (a session record kept outside the repository, I-13). It lives in the engine package because the builder imports `@/git` (engine `review/impact.ts:20`), which the `script/vectorscope-eval/` tree does not resolve. It supersedes the research slice benches (`script/vectorscope-eval/research/slicebench*.mjs`) for VS-38 measurement; they stay as research records. Run with `bun --no-install`; results are written outside the repository (I-13).
  2. Choose one permissively licensed repository per band, and verify each band by `git ls-tree -r --name-only <head> | wc -l` at the chosen commit before counting it. For 50k or more, prefer rust-lang/rust (MIT or Apache-2.0) if the count holds; llvm-project (Apache-2.0 with the LLVM exception) only after Q36.
  3. Add a blobless-sparse clone (`--filter=blob:none --sparse`) of the 50k-plus repository. Count the clone's local objects before and after the run to show that nothing was fetched lazily outside the gated candidates.
  4. Take 10 merged PRs per repository by a seeded rule that spreads diff sizes. No labels: latency, incomplete reasons and token counts per arm only.
  5. Report p50 and p95 of grep, parse and total time per band, and every `incomplete` reason.
- **Outcome rule (VS-38's own).** If p95 holds in every band with tree-ish grep alone, VS-38's scoping code is skipped. If `incomplete: "time"` or `"partial-clone"` fires on more than 10% of 50k-plus cases, VS-38's design and the conditional fact cache reopen.
- **Unset byte-identity.** A script only; no core, engine or runner file changes.
- **Constraints.** Public anonymous git over https only, no GitHub API, no model request, one Bun workload at a time. No code from those repositories is stored outside the scratch clone.
- **Tests:** the script's argument parsing and output schema on a small fixture repository.
- **Invariants:** I-13, D8, I-8.
- **Done when:** the band table exists with a 50k-plus row and a blobless-sparse row.
- **Window:** Now. **Depends on:** VS-25b, VS-37a, VS-37c (measure after it). **Owner questions:** Q36 (llvm-project only; addendum A's Q26 already names it permissive, and Q36 asks the owner to confirm that wording); Q26 is not needed if only permissive repositories are used; Q45.

### 1.7 VS-35b Dismissal reason classes and rule health (pure)

*Amends VS-35a (core `team.ts`, uncalled by `prompt.ts` and `select.ts`). Evidence: the peers note's proposals 4 and 7 (verdicts P7 and P9, weakened: Copilot's reasons are a changelog extract; rule health is already in Kodus, round two).*

- **Problem** (*code*, `41a64e5e`). VS-35a already defines the dismissal reasons and roles in the `vector-dismissal` marker: `DISMISSAL_WHY = ["fp", "wontfix", "thumbs", "resolved", "cmd"]` and `DISMISSAL_BY = ["w", "a"]` (core `team.ts:34-46`; addendum A VS-35 design 1). But guarded team memory does not weigh the reason: `exclusion` (`team.ts:240-253`) checks the marker, the role, own hashes, the window, bot pushes, bulk resolves and security, never `why`, so a `wontfix` and an `fp` dismissal count the same. Separately, `classifyPrior` (core `state.ts:286`) treats every writer or author dismissal alike, and the reply text that would set `why` has no classifier yet. Copilot reportedly resolves with "Won't Fix" or "Incorrect" (2026-09-18, extract); Qodo reportedly switches off rules that are rarely fixed. Round two found that one-pattern team dismissal is a poisoning path.
- **Design.**
  1. `dismissalWhy(reply, by: DismissalBy)` maps reply text onto the existing `DismissalWhy` values, `fp` or `wontfix`, or returns `undefined`, by a fixed, word-anchored phrase table applied only when `by` is `"w"` (a writer who is not the PR author). An author reply (`"a"`) or a reply from a non-writer returns `undefined`; such replies may only exclude data (I-2). No new vocabulary: the output is what the marker's `why` already holds. The phrase table is data with its own fixture test (for example "false positive" and "not a bug" as `fp`; "won't fix" and "wontfix" as `wontfix`; negations such as "not a false positive" give `undefined`).
  2. `exclusion` gains one rule, applied only by a new option of `guardedMemory` that no caller sets: a dismissal whose `why` is `wontfix` never becomes a suppressing team pattern. It is a new `TEAM_EXCLUSIONS` reason, `wontfix`, last in precedence, so existing reasons keep their counts.
  3. `ruleHealth(rule: { id: string; source?: string }, outcomes: readonly { ruleId: string; fixed: boolean }[])` is demote-only. `rule.id` is a VS-43 rule id or a VS-48 instruction rule id, and `source` links the rule's source thread, as Qodo's rule miner does. `outcomes` are VS-46 per-finding outcomes for findings that rule produced. After at least 5 outcomes, a rule whose findings are rarely fixed becomes `demoted`. It never promotes and never touches VS-35's never-suppress set.
  4. Only `fp` from a non-author writer may feed a pending Brain proposal (VS-35's later half, after VS-11). `wontfix` never suppresses. New rules stay pending until the owner approves them, never live by default.
- **Unset byte-identity.** Uncalled, as VS-35a; with the new `guardedMemory` option unset its output is byte-identical; `teamMemory: legacy` output unchanged (existing parity tests). `team.ts` is in the pipeline pin (`REVIEW_PIPELINE_FILES`), so the pin moves and the deviation entry records it.
- **Tests:** the phrase table; negations; author, non-writer and forged-marker replies give `undefined`; outputs are always members of `DISMISSAL_WHY`; the `wontfix` exclusion only under the new option; the 5-outcome threshold; never-suppress findings never demoted; no promotion path.
- **Invariants:** I-2, I-1, I-12 (pin).
- **Kill:** if hand-checked precision of `fp` on a sample of owner-repository replies is below 0.9, the classifier returns only `undefined`.
- **Window:** Now (pure); wired with VS-35 (runner-wiring and later).
- **Depends on:** VS-35a. **Owner questions:** Q24 (existing).

### 1.8 VS-46c Outcome measurement rule

*Amends VS-46a (`script/vectorscope-eval/outcomes.ts`). Evidence: prediction P3-1 (weakened: the size comparison must use the final band), P3-6 and P3-7 (confirmed), P3-13 (weakened) and §4; Greptile F3 (weakened).*

- **Problem.** `bandsOf` (`outcomes.ts:1713-1758`) declares separation only on non-overlapping Wilson intervals at 200 or more matured PRs, a rule that finds a real 2x separation about 12% of the time at N = 200. It never compares the band with size alone. On overlap the sealed report says "never enable history risk areas" (`outcomes.ts:1878`). Reverts at about 1.2 to 4 per 1,000 PRs (Greptile's vendor figures, extract) give about 0.2 to 0.8 expected positives at N = 200, so a revert-based check is empty, not negative; the owner's own base rate is measurable and is what counts.
- **Design** (protocol items 3, 4, 5 and 7):
  1. **Observed base rate and expected positives first.** Report each label's observed per-repository base rate (reverts, follow-up fixes, and the share of fix-prefixed and revert-prefixed subjects on the base branch) before anything else, then the expected positives per compared band. A comparison with fewer than 10 expected positives in either band reports `underpowered` and no verdict.
  2. **Which label decides.** Reverts decide when both compared bands have at least 10 expected reverts, because reverts carry no blame-size bias. Otherwise the follow-up-fix label decides, flagged "SZZ-based, size-biased" and "unaudited" unless VS-46d's audit ran. Both labels are always reported. (This reconciles the prediction lane's "reverts first" with the Greptile lane's "fix label primary".)
  3. **Minimum detectable effect** is printed for the observed counts before any verdict.
  4. **Capture at overhead, by final band.** `riskOf`'s likelihood score is `log2(1 + added + deleted)` plus at most 0.5 from the dirs and entropy tie-breakers (core `risk.ts:183-191`), so ranking by score against a log-size ranking would compare size with itself. The ranking is therefore the **final band** as `riskOf` returns it (`LedgerPull.band`: floors for sensitive, deletion-heavy and sensitive-with-wide-reach included, test-only lowered), with ties inside a band broken by score. For the top 10%, 20% and 50% of matured PRs in that order: the share of positives, the share of PRs and the share of changed lines. The same for a size-only ranking (log(added + deleted)) and for random order, with a seeded paired bootstrap of the band-minus-size difference. The report states plainly what the comparison tests: only what the band adds beyond size, that is, the floors, the test-only rule and the tie-breakers. It also prints how many matured PRs any floor or the test-only rule moved, and the minimum detectable difference for that count; when that count gives fewer than 10 expected positives, the size comparison is `underpowered`.
  5. **Low-band miss rate** (the share of positives in the low band against its share of PRs and lines), and Effort@20% for `order(files)` inside matured multi-file PRs (which inherits the fix label's noise and needs volume; P3-13).
  6. **Verdicts:** `underpowered`, `beats-size`, `no-better-than-size` (the difference interval lies wholly below a margin pre-registered in the report config before the first run and recorded in the sealed output) and `undecided`. Because the band differs from size only on floor-moved PRs, `beats-size` means "the floors and tie-breakers add capture beyond size", and `no-better-than-size` means "they add none detectable at this power"; neither says anything about history features.
  7. **Kill wording.** `underpowered` and `undecided` mean "not yet". `no-better-than-size` documents `riskOf` as a size, reach and sensitivity heuristic for that repository. It does not by itself decide history risk areas: VS-46 item 6 already gates them on a measured separation gain with an interval excluding 0, and that gate stands. The word "never" is removed.
  8. **Depth effects.** Rows comparing outcomes across depths are suppressed below their minimum detectable effect. The report states that post-merge outcomes are a monitor, not a gate, for lens and depth decisions (P3-7).
  9. **Reach.** The report notes that the production band is computed without `dependents` (`outcomes.ts:895`), so reach is untested.
- **Compatibility: a ledger schema change, shared with VS-46d.** The size baseline and line shares need data the ledger does not record: `LedgerPull` (`outcomes.ts:207-228`) has `band` and `score` but no added or deleted line counts. So collection changes, not only the report, and `LEDGER_SCHEMA` (`outcomes.ts:69`, today `"vectorscope-outcomes/1"`) becomes `"vectorscope-outcomes/2"`. New `LedgerPull` fields from VS-46c: `added`, `deleted` (the merged PR's reviewed files, as `riskFeatures` counts them); one new ledger-level field, `subjects: {commits, fix, revert}`, counted over the base branch's first-parent history in the collection window. VS-46c and VS-46d land as **one** schema change, so one sealed schema name has one meaning; VS-46d's fields are listed there. Old ledgers: `ledgerProblem` (`outcomes.ts:1471`) keeps refusing any other schema for collection, and `open` reads a `/1` ledger read-only as v1, printing every v1 section as today and every new section as "unavailable: a /1 ledger has no added or deleted counts". On the synthetic histories, every v1 report section except `bands.separation` and its overlap sentence is byte-identical. The bootstrap is seeded, so reruns are identical. No runner, core or digest changes. Output stays sealed, with 0 writes on a recording GitHub client and 0 model calls.
- **Tests:** synthetic histories that reach each verdict; observed base rates and expected positives; the size baseline ranked by final band, including a history where only floor-moved PRs differ from size; the floor-moved count and its minimum detectable difference; bootstrap determinism; the old "never" sentence absent; depth rows suppressed below the minimum detectable effect; a `/1` ledger opened read-only with new sections marked unavailable; 0 writes.
- **Invariants:** I-13, D12, I-2.
- **Done when:** a dry run on synthetic data prints every section.
- **Window:** Now (script). **Depends on:** VS-46a. **Owner questions:** Q30 (existing), Q43, Q45.

### 1.9 VS-46d Outcome labels and strata

*Amends VS-46a. Evidence: prediction P3-2, P3-5, P3-10, P3-11, P3-17 (all weakened; corrected forms used); Greptile F4 (weakened); the peers note's proposal 4 (verdict P7); the benchmarks note's proposal P8 (verdict B3-08).*

- **Problem.** The follow-up-fix label is unaudited basic SZZ, blind to add-only fixes, to cosmetic lines and to moved lines (blame runs without `-w`, `-M` or `-C`, `outcomes.ts:1243-1254`, so lines a PR merely moved are blamed on it). The report has no verdict-against-outcome stratum (the test Greptile has never published for 5/5), no dismissal reasons, and no definition beside its addressed rate.
- **Design:**
  1. **Label audit.** Draw a seeded sample of at least 50 positive and 50 negative matured PRs (hashed identifiers) for the owner to label by hand in a local file that is never sent anywhere. With those labels, report label precision and recall with Wilson intervals; without them, every rate is marked "unaudited".
  2. **Untraceable share:** fix commits with zero deleted lines.
  3. **Cosmetic and move filter:** blame with `-w -M -C` and skip deleted lines that are blank or comment-only (a fixed prefix table per language). The filtered label is primary in the `vectorscope-outcomes/2` report; the unfiltered counts stay as the v1 fields, so the change is visible. The report also gives the share of fix-blamed lines that the filter reattributes or drops, split into whitespace, comment and move.
  4. **Size normalisation:** fix-edited lines per kLOC added, by band.
  5. **Verdict against outcome** (Greptile F4): follow-up-fix and revert rates for "reviewed, nothing posted, complete" against "reviewed with findings", **within each VS-39 band and within each size tercile**, or under VS-46 item 7's independent depth assignment where it exists. Clean verdicts go mostly to small, low-reach PRs, whose fix and revert rates are lower anyway, so a raw difference measures size: it is printed only beside the stratified ones and labelled "confounded by size". Until `ReviewState.verdict` lands (VS-32, later) the stratum is a proxy built from sticky state and markers, labelled as a proxy; after it, the exact `clean-complete` value from VS-32a's `reviewVerdict`.
  6. **Dismissal reasons by severity**, from VS-35b's classifier.
  7. **Addressed rate with its definition and population**, paired with cycle time and human-comment volume. The report text forbids comparison with vendor or cross-population rates (D12).
  8. **Human-review rate by band** (the existing `humanReview` field), a cheap proxy for whether repository rules change scrutiny (P3-2, evidence for Q28).
  9. **Agent-authored split within size terciles**, from trusted local records only; untrusted markers may only exclude. The report also gives the share of follow-up fixes authored by the same agent as the PR, since same-agent iteration confounds the label (P3-11). This is the evidence Q41 needs; on one repository it will most likely stay undecided.
  10. **Recurrence share, descriptive only** (P3-10): the share of matured follow-up fixes whose fixed lines fall in a file or function that had an earlier fix within 365 days of the reviewed PR's merge. It measures hotspot co-location, which round two found does not help ranking, and it cannot show that a prior-fix card helps detection, so it gates nothing; L6 is gated on the Q9 ablation alone.
  11. **Latent-forecast scoring** (P3-17): when local eval artifacts hold VS-42 `pre-existing` drops (path, base line span, class, base SHA, fingerprint), join them to later fixes and report latent-forecast precision at 90 days. Kill: precision under 10% on at least 100 drops. Never read from GitHub state or markers, which are public. Until the recording half lands (§2, R5), it prints "no drops recorded". Limits: drops exist only when `scopeGate: introduced` and `guardrail: strict` are both set (both off by default); once wired, the scope prompt clause suppresses most pre-existing findings before they become drops; `StrictResult.dropped` keeps only counts, so locations are new retained data; following base lines through later history is new machinery (`outcomes.ts`'s blame never returns a base line). On one repository the stream may never reach 100 matured drops.
- **Compatibility and byte-identity.** Part of VS-46c's single `vectorscope-outcomes/2` ledger schema change, not a second version. The filtered label (items 2 and 3), the same-agent share (item 9) and recurrence locations (item 10) change collection, because fixes are computed at collection by blame (`outcomes.ts:1214`). New `LedgerPull` fields from VS-46d: `fixesFiltered` (the item 3 label, beside the unfiltered `fixes`), per-fix `deleted: {code, blank, comment, moved}` line kinds, per-fix `location: {path, fn?}` (hashed path) and `sameAgent`. Old `/1` ledgers open read-only as in VS-46c, with these sections marked unavailable. v1 report sections keep their values (the unfiltered labels), new sections are additive, output sealed, 0 writes, 0 model calls, no runner change.
- **Tests:** synthetic histories for each new section; the audit sample's determinism and its "unaudited" marking; the `-w` and comment filter; a moved-lines fixture (a block moved within a file and to another file, then fixed) where `-M -C` blames the original author's PR, not the mover's; the clean-against-findings stratum computed within band and tercile, with the raw difference labelled; agent splits only exclude; the proxy labelled as such; latent scoring on a fixture artifact and its kill rule; a `/1` ledger opened read-only.
- **Invariants:** I-13, D12, I-2, D8.
- **Window:** Now (script); R5 records the drops. **Depends on:** VS-46a, VS-46c (same schema change), VS-35b, VS-32a. **Owner questions:** Q30, Q41, Q43, Q45.
- **Known gap, not fixed here:** `outcomes.ts` refuses shallow and partial clones (`outcomes.ts:745-757`), so a large-codebase user on a blobless clone cannot run VS-46. Blame needs the blobs; a partial-clone mode would need its own design under I-8 and is not proposed.

### 1.10 VS-44c Isolated verification planner and pending variant

*Amends VS-44 (core `plan.ts`; the variant registry in `script/vectorscope-eval/replay.ts`). Evidence: the peers note's proposal 1 (verdict P4, weakened).*

- **Problem.** One peer is shown in code to verify each issue in isolation: Anthropic's open-source review command, which gives each bug or logic issue its agents 3 and 4 flag its own validation subagent (since about 2025-12-06). Anthropic's managed Code Review documents one verification step of unstated granularity; ultrareview's "independently reproduced and verified" does not say one call per finding; Sentry's per-hypothesis verifiers come from a search extract. VectorScope batches every candidate into one verify call (`run.ts:715-780`), where verdicts can anchor on each other (*inference*). Whether isolation beats batching is untested: no public ablation of the two exists. So this package builds only an ablation candidate, never a default.
- **Design.**
  1. A pure `planIsolatedVerify(calls, {k = 3})` in core `plan.ts`. Its input is each candidate with what a VS-40 estimate needs: `{candidate, promptTokens, maxSteps, price: ReviewPrice}`, where `promptTokens` is the token count of that candidate's isolated verify prompt and of the batched prompt for the rest. It picks the top k blocking candidates by a deterministic order (severity, class, then path and line) for one verify call each, sends the rest through today's batched pass, and returns the per-call candidate lists with an estimate per call from `estimateCostUsd` in `plan.ts` itself (not `dispatch.ts`, which imports `./plan` and would make a cycle). Inputs are blind, as VS-44 requires: no reviewer body or suggestion.
  2. `engine:verify-isolated` is registered as pending in `script/vectorscope-eval/replay.ts`'s `VARIANTS` (`:161-260`), as the 14 other pending variants are: it sets no keys, its engine half waits for "VS-44c wiring", and its desktop half is a documented difference until VS-27's desktop guardrail.
- **Unset byte-identity.** No runner calls the planner. The registry change only adds a name that refuses with exit 2 and creates nothing (tested as the others are). The pin moves.
- **Tests:** ordering and tie-breaks; k larger than the candidate count; no reviewer text in any planned call; estimates sum to the batched estimate when k = 0.
- **Invariants:** I-5 (each call admitted when wired), I-3 (the review model's ZDR route when wired), I-1.
- **Kill (in the funded ablation, Q9):** drop it if the precision gain is under 3 points or its lower bound is below 0, if verify tokens rise more than 60%, or if class-scoped recall falls more than 5 points.
- **Window:** Now (planner, pending name); runner-wiring (§2 R3); the ablation is later. **Depends on:** VS-44a, VS-40a. **Owner questions:** Q9, Q45.

### 1.11 VS-48a Instruction-path denylist and nested-file count

*Amends the unbuilt VS-48 (core `config.ts`; an eval script). Evidence: the peers note's proposal 3(a) and (c), open question 7 (verdict P3, weakened).*

- **Problem.** VS-48 as written reads the ancestor-directory AGENTS.md, CLAUDE.md and `.vector/RULES.md` of each changed file at the base commit, with caps of 8 files and 64 KB, and no directory exclusions. Changed files under `**/node_modules/**` and a root `vendor/**` are already skipped by VectorScope's default ignores (core `ignore.ts:33`, `:38`), so those paths are not the exposure. The real exposure is directories outside that list: `third_party`, `deps`, fixtures, tests, examples and nested `vendor`, where a vendored or sample instruction file would steer the review. Anthropic's practice is no direct precedent: its denylist applies to **subdirectory `REVIEW.md` files only**, and it documents no denylist for CLAUDE.md, which it reads in every changed file's parent directories. The list below is therefore VectorScope's own choice, informed by Anthropic's REVIEW.md list, and it may drop legitimate instructions in test or example directories.
- **Design.**
  1. A pure `instructionPathExcluded(path)` in core `config.ts`: true when a path segment is on a fixed list (test, fixture, golden, corpus and snapshot directories; example, sample and demo directories; `generated`; vendored and third-party directories such as `vendor` at any depth, `third_party`, `site-packages`, `deps`, `contrib`). Uncalled.
  2. A zero-token count script, `script/vectorscope-eval/research/instructions.ts`, over the D8-clean repositories in VS-22's manifests: how many nested AGENTS.md, CLAUDE.md or `.instructions.md` files sit under each excluded segment, and how many of those sit in test or example directories of the project's own code rather than in vendored code. **The count decides** whether R6 applies the list at all, and which segments it keeps: a segment with no nested instruction files in the count is dropped from the list, and test or example segments are kept only if the files there look vendored.
  3. **Amendment text for VS-48** (not built): its collector skips paths the count keeps (3(a)); it keeps its 8-file, 64 KB and 4k-token caps, already tighter than Anthropic's 150,000 bytes for subdirectory REVIEW.md files (3(c)). The suppressive-directive split (3(b)) is later (§2, L3).
- **Unset byte-identity.** Uncalled; `rulesForPaths` and every collector output are unchanged.
- **Tests:** the segment list; case handling; a path whose file name, not a directory, matches is not excluded; `vendor` excluded at any depth, unlike the root-only default ignore.
- **Window:** Now (helper and count); VS-48 wiring applies it after the count. **Depends on:** VS-22. **Owner questions:** none for 3(a) and 3(c); Q45.

### 1.12 VS-32b Posting plan by verdict (pure; lowest priority)

*Amends VS-32a (core `verdict.ts`). Evidence: Greptile F2 (weakened: channels vary; no unread merge is documented).*

- **Design.** A pure `postingPlan(verdict: ReviewVerdict, inlineCount: number, options: { failOn: "never" | "blocking" | "blocking-or-incomplete" })` in core `verdict.ts`, beside `reviewVerdict` (`verdict.ts:109`) and `REVIEW_VERDICTS` (`:19-27`). The `failOn` type is local to `verdict.ts`: `ReviewConfig.failOn` is `"never" | "blocking"` (`types.ts:471`, `config.ts:182`) and is not touched in Now, because VS-32's config parse is Later, after `vector-at-mention` (addendum A §4).
  - `not-reviewed` and `policy-skip`: never create a PR review, for every `failOn`;
  - `incomplete`: with `failOn: "never"` or `"blocking"`, today's rule (create a review only when there are inline findings, no marker); with `failOn: "blocking-or-incomplete"`, create the review when there are inline findings, with a bot-written marker (`<!-- vectorscope-verdict: incomplete -->`) at the top of the body, and create none without inline findings (the verdict reaches the check run and the sticky comment instead, I-1);
  - every other verdict: create a review only when there are inline findings (today's rule at `github.review.ts:765`), for every `failOn`.
- **Not Now:** calling it from `github.review.ts` and the CLI `--pr` path, and the regression test that a `not-reviewed` or `policy-skip` run never calls `createReview`, are @vector-owned and wait for `vector-at-mention` (I-9; §2 L2).
- **Unset byte-identity.** Uncalled; no `github.*` file and no `ReviewConfig` field touched. `verdict.ts` is outside the pipeline pin, so the pin does not move.
- **Tests:** the truth table over every verdict, every `failOn` value and inline counts of 0 and 1; the marker only under `"blocking-or-incomplete"`; the marker text is constant, never built from PR or model text (I-2).
- **Window:** Now (helper). **Depends on:** VS-32a. **Owner questions:** Q19 (existing), Q45.

---

## 2. Runner-wiring and Later items (not Now)

### 2.1 Runner-wiring (after `self-evolving`, or on Q13)

| Item | What | Depends on |
|---|---|---|
| R1 | VS-23c's backstop calls `zdrPathRefusal` and the body-shape check on every OpenRouter and OpenAI-compatible request. VS-23's fake server is extended to speak Anthropic Messages, and the route audit records bodies from the OpenRouter SDK as well as `@ai-sdk/openai-compatible`, so the audit covers production wire formats (Phase A's fidelity limit). Not Now: until VS-23b/c are wired the audit row cannot be measured at all, so a better fake server measures nothing earlier | VS-33b, VS-23c |
| R2 | Effort pinned per pass under the VectorScope opt-in, constant for the session, from trusted config only, recorded in `EvidenceScope` (I-2, I-12); per-attempt reasoning tokens read by the run observer; `service_tier: "default"` pinned on OpenRouter requests under the opt-in (with the README's workspace allow-list, VS-21e item 7) | VS-21e, VS-40a, Q18 |
| R3 | `run.ts` verify pass runs VS-44c's isolated calls under `engine:verify-isolated`, each admitted (I-5), on the review model's ZDR route (I-3) | VS-44c |
| R4 | The omitted-finding sentence in `format.ts` ("N pre-existing and M non-blocking findings found and not posted"), only under `guardrail: strict`. It reads `StrictResult.dropped` directly, as `strictCountLine` already reads its `cap` entry (`format.ts:766`); no helper is needed, since `dropped` already holds one `{reason, count}` entry per drop reason with a count of 1 or more (core `types.ts:198`, filled in `STRICT_DROPS` order at `guardrail.ts:434`, `:475`). Tests: the counts per reason in the sentence sum to the number of dropped candidates (`dropped[].count` summed, not `dropped.length`); a D3 parity test that the summary is byte-identical with the key unset. User-visible only after D14. Replaces the former Now helper VS-27d (peers proposal 2, verdict P1) | VS-27c, D14 |
| R5 | Local eval artifacts record VS-42 `pre-existing` drops (path, base span, class, base SHA, fingerprint) for VS-46d's latent scoring; never GitHub state or markers | VS-42 wiring, VS-27c |
| R6 | VS-48's collector applies `instructionPathExcluded` and keeps its caps | VS-48 wiring, VS-48a |
| R7 | "Agent-authored (trusted local record)" as a `riskOf` reason only, with no band effect | VS-39 wiring |

### 2.2 Later

| Item | What | Gate |
|---|---|---|
| L1 | Document the `vectorscope-verdict` tokens for downstream bots with VS-32's job wiring, and put the verdict token in the check run's output title and summary as well as in its conclusion, so a bot reading either classifies a policy result correctly and never as a CI crash. Greptile's threshold check does this in its text (agentrc #176 was a bot reading the conclusion alone; Greptile F1, weakened, and the verify pass's missed list) | `vector-at-mention` (I-9) |
| L2 | Call VS-32b from the job and the CLI `--pr` path; the regression test that `not-reviewed` and `policy-skip` never call `createReview`; the `incomplete` marker (Greptile F2) | `vector-at-mention`, with the @vector owner |
| L3 | VS-48 3(b), following Anthropic's REVIEW.md rule (peers proposal 3(b), verdict P3): suppressive directives (exclude, lower severity, cap nits) are accepted **only from the root base file** (base `review.json` or the root instruction file), never from scoped or nested files, and only when base-branch protection is confirmed. When protection cannot be confirmed, fail closed: no suppressive directive is applied from any instruction file, and the VS-47 receipt says so. Additive directives in scoped files keep VS-48's rules | Research item on reading branch protection (formerly Q37, §3); VS-48's GitHub half |
| L4 | Diff-only lens: `lenses: high` plus a `diff` member with no read tools and no slice; keep it only if diff-level recall rises at least 3 points with no rise in false alarms per clean PR (peers proposal 5, verdict P5) | VS-28 wiring; Q9 |
| L5 | Production-grounded hypotheses from history only: a wrapped one-line fact ("this region was reverted N times"), never a verdict (peers proposal 6, verdict P12: at least two peers claim it, neither publishes evidence) | VS-46 item 6's own gate: a measured separation gain from history features with an interval excluding 0, on that repository; trusted config only; after the held-out freeze (I-13). VS-46c's size comparison does not gate it, because that comparison tests only the band's floors and tie-breakers, not history |
| L6 | Prior-fix card: one of VS-26's three cards, carrying the most recent fix diff of the touched function from base history (P3-10, weakened) | The funded ablation alone (Q9), on VS-26. VS-46d's recurrence share is descriptive and gates nothing |
| L7 | Differential probe, a VS-30 sub-mode: model-written tests on changed functions, run twice on base and twice on head; posted only when tied to a guardrail-passing finding; high band only; local, consented, never `--pr`, forks or CI (P3-8, I-6). Under the tie-to-finding rule it cannot post a bug that no finding names, so its measurable value is confirming findings; probe-only catches stay in local notes (Q42). VS-30 item 4 already runs tests twice on base and head, so the new part is finding-free test generation, which nothing has shown works without Meta's intent judge and human triage | VS-30 executor; Q8; Q42 |
| L8 | Funded-ablation items: per-model context-depth ablation (benchmarks P6); a shared-prefix prompt variant for the diff (T3-8), after the zero-spend measurement of the shared prefix (§3); the paid narrative-invariance comparison (VS-22d); P0/P1-only recall over 3 runs per family pair for VS-29b (F9). A smaller-model recall lens (benchmarks P7) is dropped: its only support was a tie on detection (verdict B3-06) | Q9 |
| L9 | Agent-authored raise-only floor of medium under `depth: auto` (P3-11, weakened). The gate will most likely stay undecided on one repository, and same-agent iteration confounds the label (Q41) | VS-46d shows higher outcome rates within each size tercile with an interval excluding 0, after removing same-agent follow-ups; Q41 |
| L10 | Repository-produced SARIF on changed lines as untrusted hypotheses for verify (P3-9) | Off by default; measured on VS-22 |
| L11 | Caching-off for gpt-5.6+ routes without an `extendedCache` attestation, instead of refusing them (T3-4) | Q40 (depends on Q1, Q21, OpenAI's terms) |

---

## 3. Items that are not packages

- **CRBugBench correction** (benchmarks P9). CRBugBench (`e8e585e`) has no LICENSE file and its README states no licence. Proposed amendment to addendum A §3, VS-22, "PR size" bullet: "AACR's PRs are below about 1,000 lines. CRBugBench has no licence, so its tasks may not be used; its numstat (diff statistics only, no code) may inform the size curve only under a Q26-style ruling. For the large-PR end, use ReviewBench's MIT PRs after VS-22's per-path check, or the owner's own repositories." Record it in a deviation entry; no code change.
- **Catalog price error** (T3-7). `packages/web/public/models/api.json` lists Sonnet 5.5 `cache_read: 0.2` against Anthropic's $0.10. That file serves every Vector user, so the fix is outside the VectorScope contract; it is flagged to the owner of that file. VS-21e's price table is the only VectorScope-side change.
- **VS-40 item 4 (fan-out hold).** Proposed amendment, restricted to review against security (T3-8, weakened): "Between the review and security passes the fan-out hold saves nothing: they run on different agents, so their system prompts differ (`agent.ts:518-575`). Do not wire it for that pair. Lens passes run on the review agent (`run.ts:557`) and share its tool definitions and system blocks, which carry cache breakpoints (`transform.ts:456-458`), so for review plus lens passes the hold stays a candidate; its saving is an open measurement in projections. A shared-prefix layout for the diff is an eval-only variant in the funded ablation (§2, L8)."
- **Shared-prefix measurement** (T3-8, T3-11; verify pass). At zero spend, from dry-run prompt sizes, measure the stable prefix (agent prompt, tool definitions, project instructions) and the share review and lens passes share, replacing the assumed 90% and 4K. A measurement, not a package; it runs with the D6 follow-up below. It should also note that system block 1 holds the date and directory, so a cache shared across reviews breaks daily.
- **OpenRouter batch line in addendum A** (T3-5, weakened). Addendum A §3 says "**Batch.** The OpenRouter batch refusal is now vendor-backed [VOI6]". No OpenRouter batch refusal exists in `privacy.ts`: `BATCH_ENDPOINT` is read only on the Anthropic request format. Proposed amendment: "**Batch.** OpenRouter's Batch API cannot run under ZDR and keeps data 30 days, but VectorScope does not yet refuse it: `BATCH_ENDPOINT` covers only Anthropic, Vertex and Bedrock batch paths on the Anthropic format. Addendum B's VS-33b closes the gap." Record it in a deviation entry that points to VS-33b; no code change beyond VS-33b.
- **Greptile comparison wording** (F1, weakened). Any VectorScope text saying Greptile's check "succeeds at any score" must say "at a threshold of 0, the value users observed (the vendor default is unverified); an opt-in dashboard threshold can fail it, and it blocks merges only where a team makes it required" (REPORT-3 §3.1).
- **The 14 pending engine variants.** No action; each flips with its wiring (Q13, Q18).
- **D6 follow-up** (T3-1, weakened). After Q35, re-run Phase A's projections at zero spend with the chosen models. Replay projections already carry the catalog's cache rates, so the re-run needs no new price syntax; with VS-21e it also shows the cached and uncached figures side by side and the per-pass split. Update the README and `ci.ts` example strings, record which operator serves each chosen model on the eval route, and log a deviation entry. A measurement, not a package.
- **Research item: reading branch protection** (formerly owner question Q37). Whether VectorScope's existing GitHub credentials can read a base branch's protection or rulesets is a fact about the GitHub API and the installed permissions, not an owner decision; adding a permission is already forbidden (contract §0.5, "Add GitHub App permissions"; I-14). A later research pass answers it from GitHub's documentation. The answer only decides how often L3 fails closed.

---

## 4. Sequencing

| Window | Items |
|---|---|
| Now, in order | VS-33b; VS-21e; VS-40a; VS-22d; VS-37c; VS-38a; VS-35b; VS-46c and VS-46d (one ledger schema change); VS-44c; VS-48a; VS-32b |
| Now, measurement | after Q35: re-run Phase A projections, with the shared-prefix measurement; after VS-37c: VS-38a's band run; after VS-48a: the nested-instruction count |
| Runner-wiring | R1 to R7 (§2.1); R4 holds the omitted-finding sentence that was VS-27d |
| Later | L1 to L11 (§2.2) |

Prompt tuning in L4, L5 and L6 waits for the held-out freeze (I-13).

---

## 5. New owner questions

Approval of the items above is asked by Q45, not through Q18.

- **Q35.** Sonnet 4.5, the model in the eval README's and `ci.ts`'s example price strings and in Phase A's projections, retires on Anthropic-operated platforms on 2026-11-30; Bedrock and Google-managed Vertex set their own schedules, and the eval route (OpenRouter) serves Claude through them. D6 names no candidates ("the current default review model plus one cheaper model already in the catalog"). Which active models should be D6's candidates for the README, the projection examples and the pilot (for example Sonnet 5.5 with Haiku 5.5, or Haiku 4.5, still Active), and should the route audit record which operator serves each one on the eval route? (T3-1, weakened.)
- **Q36.** D8 licence ruling: may matplotlib's PSF-style licence, ISC, CC BY 4.0 (SWE-PRBench's dataset) and Apache-2.0 with the LLVM exception (llvm-project, Archer's regressions) count as permissive? This extends Q31, and for llvm-project it amends addendum A's Q26, which already calls llvm-project permissive; confirming that wording is part of the ruling. VS-38a can proceed on rust-lang/rust without it.
- **Q37.** Withdrawn as an owner question: whether existing credentials can read branch protection is a researchable fact, now a research item (§3), and adding a permission is already forbidden (§0.5, I-14). The number is kept so later numbers do not move.
- **Q38.** May the session's network allow arxiv.org, engineering.fb.com, dl.acm.org, huggingface.co, conf.researchr.org and mockus.us, so a later pass can read the Meta papers, the benchmark tables and the dataset licences in full? Optionally also developers.openai.com, platform.openai.com and openai.com (T3-4, Flex terms), greptile.com and docs.greptile.com, blog.sentry.io, github.blog and aimultiple.com, each of which the lanes or the verify pass could not reach.
- **Q39.** Should a like-for-like Greptile run (Base and Auto) be commissioned on a D8-clean public set, such as AACR's permissive subset, paid by the owner (Greptile O1)? It would give an internal diagnostic only: under I-13 and D12 results stay sealed and no comparative or parity claim follows, so a published comparison would also need the owner to change D12.
- **Q40.** For gpt-5.6+ routes without an `extendedCache` attestation, may VectorScope send caching-off requests instead of refusing them, once OpenAI's terms confirm nothing is persisted (T3-4)? Depends on Q1 and Q21; gpt-5.5 stays refused.
- **Q41.** May "agent-authored (trusted local record)" become a raise-only depth floor of medium under `depth: auto`, once VS-46d shows higher outcome rates for agent PRs within each size tercile (P3-11, QP3-2)? Expect the answer to stay moot: on one repository the within-tercile gate will most likely stay undecided (the power arithmetic in REPORT-3 §5.3), and the 1.62x figure it rests on is confounded by same-agent iteration (69.6% of follow-up fixes come from the same agent).
- **Q42.** For the differential probe (§2, L7): may a "behaviour changed, not judged" note appear in local review notes, given it is never posted (QP3-3)?
- **Q43.** About how many PRs per 90 days merge on the repositories nominated for VS-46, and will you hand-label VS-46d's audit sample of at least 50 positive and 50 negative PRs (QP3-4, P3-5)? The answer decides whether VS-46c can ever leave `underpowered`.
- **Q44.** Phase A projects $6.60 to $9.60 per case on the high side against the D5 pilot's $0.75 bound, and even the tokenomics median model puts its large cheap-triage case at the bound ($0.74) and over it at p90. For the pilot (Q9), should multi-step reviews that hit the bound be accepted as partial outcomes and reported as such, should the pilot set a lower `maxSteps` (recorded), or should the per-case bound change within the $50 total?
- **Q45.** Are addendum B's packages approved as proposed additions, on the same terms as Q15 and Q18? Listed separately: (a) Now items that amend Q15-scope packages: VS-21e (VS-21) and VS-22d (VS-22); (b) Now items that amend Q18-scope packages: VS-33b, VS-40a, VS-37c, VS-38a, VS-35b, VS-46c, VS-46d, VS-44c, VS-48a and VS-32b; (c) the runner-wiring items R1 to R7, which change the wiring of packages from both sets (R1 VS-23c, R4 VS-27c and R5 VS-42 among them); (d) the §3 text amendments to addendum A. An answer to Q18 does not answer Q45.
- **Q46.** May any risk-triggered action reach the PR author? Round two's rule is "spend more compute or tests on risky changes; never message the author about the risk", while Meta's RDR, which REPORT-3 §5.1 cites for Q28, adds a bypassable pre-land dialog shown to the author, and its measured outcomes are process proxies (DRS's own score, review time), not defects. This is a sub-question of Q28: Q28's answer should say whether VectorScope's risk band may ever produce author-visible text, or only internal depth and compute changes.

---

## 6. Completeness check against round three

| Research item | Where it lands |
|---|---|
| Phase A verdict (2 of 8 rows; VS-24 safety only; VS-25 p95 only; 14 pending) | REPORT-3 §1, §2.1 |
| `engine` and `engine:shared-verify` indistinguishable | REPORT-3 §2.2; VS-21e item 4 |
| `dataset.ts --mirrors` exit 1 | REPORT-3 §2.2; VS-22d item 6 |
| Large-codebase limits (tokens 8.5–9.4x, 0/1, p95 on 100–800 files, no high band, $6.60–9.60 against $0.75) | REPORT-3 §1, §2, §8; VS-37c; VS-38a; Q44 |
| Dataset gaps (1/30 cross-file, 0/20 trivial, runnable on 0 of 8 bug cases against a target of 15) | REPORT-3 §2.2; VS-22d item 1 |
| Phase A: second out-of-diff labelled location (vite, `plugin-legacy/index.js:454-459`, in-file, out of hunk) | VS-22d item 1 (curation note; a VS-25 recall case, not tier b) |
| Phase A: churn, `fixCommits`, reverts and dependents missing on every case; CI-against-local band agreement unmeasured | VS-22d item 1 (recorded); supplied by VS-28 and VS-25b wiring |
| Phase A: fake server without Anthropic Messages; bodies from `@ai-sdk/openai-compatible`, not the OpenRouter SDK | REPORT-3 §2.1, §8; VS-33b byte-identity caveat; §2.1 R1 |
| Verify pass: VS-46 refuses partial and shallow clones | VS-46d "Known gap"; REPORT-3 §5.2 |
| Verify pass: import must strip PR bodies and personal fields | VS-22d item 3 |
| Verify pass: SEVRA-style tests must not select on the model under test, and must report false declines | VS-22d item 2 |
| Verify pass: licence checked at every PR's base commit | VS-22d items 3 and 5 |
| Greptile F1 (threshold check; corrects "any score"; verdict weakened) | REPORT-3 §3.1, §3.2; §2.2 L1 (verdict token in the check-run title and summary); §3 |
| Greptile F2 (refusals on inconsistent channels, already in round two; verdict weakened) | REPORT-3 §3.2; VS-32b; §2.2 L2 |
| Greptile F3 (revert base rate, about 1.2 to 4 per 1,000; the owner's own rate first) | REPORT-3 §3.2, §5.3; VS-46c items 1–2 |
| Greptile F4 (verdict-against-outcome stratum, size-confounded) | VS-46d item 5 (stratified) |
| Greptile F5 (no independent v5 evidence; confirmed) | REPORT-3 §3.3, §8; Q39 |
| Greptile F6 (KB rollout; unverifiable) | REPORT-3 §1, §3.1, §3.3, §10 (marked unproven; no package) |
| Greptile F7, F8, F10, F11 (mostly restatements of rounds one and two) | REPORT-3 §3.1 (marked restated) |
| Greptile F9 (P0/P1 recall over 3 runs with intervals) | VS-21e item 5; §2.2 L8 |
| Greptile F12 (newer-than-training adversarial case) | VS-22d item 2 |
| Greptile O1 | Q39 (internal diagnostic only) |
| Peers proposal 1, isolated verification (verdict P4) | VS-44c (ablation candidate only); §2.1 R3 |
| Peers proposal 2, omitted counts (verdict P1) | §2.1 R4 (reads `StrictResult.dropped`; the former VS-27d is dropped) |
| Peers proposal 3(a)/(c), VS-48 denylist and caps (verdict P3) | VS-48a (VectorScope's own list, decided by the count); §2.1 R6 |
| Peers proposal 3(b), suppressive directives (verdict P3) | §2.2 L3 (root base file only, fail closed); §3 research item |
| Peers proposal 4, dismissal reason classes (verdict P7) | VS-35b (onto `DismissalWhy`); VS-46d item 6 |
| Peers proposal 5, diff-only lens (verdict P5) | §2.2 L4 |
| Peers proposal 6, production-grounded hypotheses (verdict P12) | §2.2 L5 |
| Peers proposal 7, rule health, demote-only (verdict P9) | VS-35b |
| Peers: Anthropic's 2026-07-21 SDLC post (verify pass) | REPORT-3 §4.1, §11.3 |
| Peers P2, P6, P8, P10, P13, P16, P18, P19 | REPORT-3 §4 (corrected forms; voting stays tier D) |
| Prediction P3-1, P3-13 (capture at overhead, low-band miss rate) | VS-46c items 4–5 (by final band) |
| Prediction P3-2 (process proxies; author-message conflict; Q28) | REPORT-3 §1, §5.1; VS-46d item 8; Q46 |
| Prediction P3-5 (SZZ label noise, no move detection) | VS-46d items 1–4 |
| Prediction P3-6, P3-7 (power; causal infeasible; confirmed) | VS-46c items 1–3, 6–8 |
| Prediction P3-8 (differential probe) | §2.2 L7; Q42 |
| Prediction P3-10 (recurrence; prior-fix card) | VS-46d item 10 (descriptive only); §2.2 L6 (Q9 alone) |
| Prediction P3-11 (agent-authored, QP3-2) | VS-46d item 9; §2.1 R7; §2.2 L9; Q41 |
| Prediction P3-17 (latent forecasts, kill at 10% on ≥100) | VS-46d item 11 (limits stated); §2.1 R5 |
| Prediction P3-3, P3-4, P3-9, P3-12, P3-14 (unverifiable), P3-15, P3-16 | REPORT-3 §5.1 (corrected forms, no change needed); P3-9 as §2.2 L10; P3-12 in VS-46c item 2 |
| Prediction §4 protocol | REPORT-3 §5.4; VS-46c and VS-46d |
| Prediction QP3-1 to QP3-4 | Q38, Q41, Q42, Q43 |
| Tokenomics T3-1 (no named D6 candidates; Anthropic-operated retirement) | Q35; §3 D6 follow-up |
| Tokenomics T3-2, T3-3 (verify dominates the modelled cost; effort; reasoning tokens) | VS-21e items 2–3; VS-40a; §2.1 R2; Q44 |
| Tokenomics T3-4 (conflicting sources) | Q40; §2.2 L11 |
| Tokenomics T3-5 (batch gap; re-dated) | VS-33b; §2.1 R1; §3 addendum A batch line |
| Tokenomics T3-6 (long-context tiers, Sonnet 4.5's included) | VS-40a |
| Tokenomics T3-7 | §3 (outside the contract); VS-21e item 6 |
| Tokenomics T3-8 (fan-out hold, review against security only) | §3; §2.2 L8 |
| Tokenomics T3-9, T3-12 (service tiers and the allow-list, no Batch) | VS-21e item 7; §2.1 R2 |
| Tokenomics T3-10, T3-11, T3-13, T3-14 | REPORT-3 §7 (no package: T3-10 supports VS-40's design; T3-11 says a 1-hour cache is not worth building and its prefix should be measured, §3; T3-13 applies only if compaction is ever enabled; T3-14 is covered by per-model prices) |
| Tokenomics T3-15 (projection-only cache prices) | VS-21e item 1 |
| Benchmarks proposal P1, licence manifest and classifier (verdict B3-01) | VS-22d item 5; REPORT-3 §6.3 |
| Benchmarks proposals P2–P5 (unflagged stratum, narrative invariance, PR date, re-settling goldens; verdicts B3-02, B3-07, B3-11) | VS-22d items 2–4 |
| Benchmarks proposal P6, context-depth ablation (verdict B3-05) | §2.2 L8 |
| Benchmarks proposal P7, smaller-model lens (verdict B3-06) | Dropped (§2.2 L8): a tie on detection |
| Benchmarks proposal P8, addressed-rate definition (verdict B3-08) | VS-46d item 7 |
| Benchmarks proposal P9, CRBugBench (verdict B3-10) | §3 |
| Benchmarks B3-03, B3-04, B3-12, B3-13 (unverifiable), B3-14, B3-15 | REPORT-3 §3.3, §6 (corrected forms) |
| Carried owner questions (D6 candidates, D8 ruling, host allowlist, approval, author messages) | Q35, Q36, Q38, Q45, Q46; branch protection is now a §3 research item |
| Dated citations | REPORT-3 §11 |

Proposal numbers ("peers proposal 1", "benchmarks proposal P1") are the lane notes' own numbering; the verdict ids beside them (peers P1 to P19, benchmarks B3-xx) are the finding ids in `verdicts.json` (a session record kept outside the repository, I-13), a separate series.

Rejected, with reasons:
- **A model-scored `riskOf`** (Meta DRS, DRS-OSS): needs incident labels and title or summary text as input, which I-2 forbids; the ApacheJIT gain is plausibly text leakage (REPORT-3 §5.1).
- **A vulnerability-likelihood score:** PR-AUC collapses to 0.005–0.111 at realistic base rates.
- **A 1-hour cross-review cache** (T3-11): not worth building at a 4K stable prefix.
- **Batch on any provider:** not ZDR (Anthropic 29 days, OpenRouter 30 days).
- **An LLM judge for VS-46 labels:** breaches VS-46's no-model rule and the egress rules for customer data.
- **A recurrence-share gate for the prior-fix card:** it measures hotspot co-location, which cannot show detection value (P3-10); the share is kept as a descriptive number only.
- **A smaller-model recall lens:** its only support was a tie on detection with a higher false-positive rate (B3-06).
- **A separate omitted-count helper (the former VS-27d):** `StrictResult.dropped` already holds the counts.
- **A better fake server in Now:** the route audit cannot be measured until VS-23b/c are wired, so the fake server is extended with R1 instead.

---

## 7. Critique responses

The critique's two blocking issues (both files missing) are resolved: both files now exist. Every major issue is applied as asked; the points below record where this addendum departs from the critique's wording, and why.

1. **T3-5 does not go into `BATCH_ENDPOINT`.** The critique says to add `/api/v1/batches`, `/v1/batches` and `/v1/files` to `BATCH_ENDPOINT` at `privacy.ts:370`. That regex is read only inside `anthropicPathRefusal` (`privacy.ts:580`), on the Anthropic request format. OpenRouter and OpenAI-compatible requests never reach it, so the paths added there would not close the gap. They would also change an existing refusal value: `/v1/batches` on the Anthropic format would move from `"anthropic-non-zdr-feature"` to `"batch"`. VS-33b therefore adds a separate exported `zdrPathRefusal` for VS-23c and a body-shape check in `zdrBodyRefusal`, and leaves `BATCH_ENDPOINT` unchanged. The tests and the byte-identity statement the critique asks for are in VS-33b.
2. **Two lane notes disagree on which outcome label leads VS-46.** The prediction note says reverts first (no blame-size bias). The Greptile note says the follow-up-fix label first (reverts are too rare). VS-46c item 2 picks per comparison: reverts when both bands have at least 10 expected reverts, otherwise the fix label, flagged. Both are always reported.
3. **llvm-project is not assumed D8-clean.** Phase A named llvm-project or rust-lang/rust for the 50k-files band. The benchmarks note says Apache-2.0 with the LLVM exception is the owner's call. So VS-38a prefers rust-lang/rust, checks its file count at the chosen commit first, and uses llvm-project only after Q36.
4. **F2 keeps a small Now part.** The critique classifies F1 and F2 as Later and allows, at most, an uncalled pure helper deciding whether to post. VS-32b is that helper and nothing more. The regression test, the marker in posted bodies and every call site stay Later (§2.2 L2). Nothing of F1 is Now.
5. **VS-46's amendments are VS-46c and VS-46d, not VS-46b.** The critique asks to amend VS-46a rather than duplicate it, which this does. The deviation log already reserves VS-46b for VS-46 item 4 (proxy validation), so these take the next free suffixes. The same rule skips VS-37b, VS-44b and VS-45b.
6. **The licence counts are kept, as re-derived seeds.** The first critique asked that they be presented as single-pass and unverified, and an earlier draft added that they could not be re-derived. That was wrong: the benchmarks verifier re-derived them (B3-01, B3-02) and corrected three of them (GPL-3.0, not AGPL; 16 repositories, not 17; the ISC-era requests PRs). REPORT-3 §6.3 and VS-22d now carry the corrected counts, still as seeds the script must reproduce, never inputs.
7. **Peers proposal 2 has no Now part.** An earlier draft kept an uncalled count helper (VS-27d). The second critique showed, and the code confirms, that `StrictResult.dropped` already holds one `{reason, count}` entry per drop reason (`types.ts:198`) and that `format.ts:766` already reads it; the helper's test ("the sum equals `dropped.length`") was also wrong, since `dropped.length` counts reasons. VS-27d is dropped; R4 reads `dropped` directly.
8. **Approval is a new question, Q45.** An earlier draft asked the owner to read Q18 as covering addendum B. The second critique is right that Q18 names only VS-32 to VS-49 and that VS-21e and VS-22d amend Q15-scope packages, so one answer would silently approve items never put to the owner. Q45 asks for addendum B's approval and lists the two scopes separately.

The second critique (round three, after the verify pass) is applied except where noted below. Each point was checked against the worktree at `41a64e5e`, `verdicts.json` (a session record kept outside the repository, I-13) or the lane notes before it was applied.

9. **Verification counts differ from the critique's.** The critique cites 72 verdicts with 57 weakened. A count of `verdicts.json` (a session record kept outside the repository, I-13) gives 74 verdicts: 16 confirmed, 53 weakened, 5 unverifiable, 0 refuted (greptile 12, prediction 17, benchmarks 15, peers 15, tokenomics 15), plus 46 missed items. REPORT-3 uses the counted figures. The five unverifiable ids match the critique (F6, P3-14, P16, B3-12, B3-13).
10. **The VS-46c size comparison ranks by final band.** The critique offered two fixes: rank by the final band, or state that the comparison tests only the floors and tie-breakers. VS-46c does both, because ranking by final band (with ties broken by score) still differs from size only where a floor or the test-only rule moved a PR. L5 is no longer gated on VS-46c at all; it keeps VS-46 item 6's own history gate.
11. **VS-21e item 1 is narrowed, not dropped.** Two critique points pulled in different directions: one said to add cache-aware strings to `run.ts` and `ci.ts` only, the other that `run.ts --price` feeds budget admission. Both hold. Cache fields are accepted by `run.ts` and `ci.ts` but parsed into a projection-only price that `Price`, `estimateUsd`, the Ledger and `charge` never see; `vectorscope-replay.ts --model` stays at two fields, since the catalog already supplies its cache rates.
12. **The Anthropic Messages fake server is not a Now item.** The critique offered "add a Now item ... or drop it explicitly with a reason". The route audit row cannot be measured until VS-23b/c are wired, so a better fake server earlier measures nothing; it is part of R1, and the limit is stated in REPORT-3 §2.1, §8 and VS-33b.
13. **VS-40b is renamed VS-40a.** The critique offered a rename or a recorded reason. VS-40a appears nowhere in the deviation log or addendum A, so the stated next-free-suffix rule gives "a". The rename touches no other document.
14. **Q37 keeps its number.** The critique asks to turn Q37 into a research item. It is withdrawn as an owner question and moved to §3, but the number stays as "withdrawn" so that Q38 to Q44, already cited in REPORT-3, do not move.
15. **Service-tier and batch dates.** The batch guide's dates (2026-10-21, last changed 2026-10-31) are the tokenomics verifier's, from the file's own history. The service-tier dates (workspace default 2026-10-24, `32b14fe`; allowed tiers 2026-11-06, `dfe8f82`) are taken from the critique's file history; this pass could not re-read that history (the GitHub API was not enabled for that repository), and the allow-list text itself was confirmed in the fetched `tiers.mdx` (lines 203-210). `claude-5-5.mdx` and the other mirror files are marked "own date not read" rather than guessed.
16. **The OpenAI-compatible route claim is sharpened, not reversed.** The critique says direct OpenAI-compatible routes get "no body check at all". `privacy.ts:6-10` confirms it: only `openrouter-attested` routes get `zdrBodyRefusal`. VS-33b's R1 wiring now applies the body-shape check on those routes too.
