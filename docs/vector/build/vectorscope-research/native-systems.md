# Native Vector systems Vectorscope should reuse

Read-only study, 2026-11-06. Every citation is `branch:path:line`, read with `git show origin/<branch>:<path>`.
Branches read: `origin/main`, `origin/self-evolving`, `origin/codium`, `origin/vector-at-mention`, plus `origin/vectorscope`
where it touches the same files.

## 0. Branch status (relative to origin/main)

| branch | ahead | behind | notes |
|---|---|---|---|
| self-evolving | 156 | 248 | merge-base 78526052; adds TaskIsolation (WP27/WP28), delegated spend ledger, learned skills |
| codium | 84 | 266 | merge-base dfc98974; adds ZDR route acceptance, model-lab, second-lab review panel |
| vector-at-mention | 46 | 265 | merge-base 78526052; adds the hosted agent sandbox (V16) |
| vectorscope | 17 | 246 | VS-01..VS-07 eval/verify-policy/model-evidence work |

Tokenomics and accounting branches: **all fully merged into main** (`git merge-base --is-ancestor` true, 0 commits ahead):
tokenomics-complete, -delivery, -efficiency, -envelope, -focus, -gaps, -scale, -unsettled, compaction-accounting,
legacy-step-accounting, publication-accounting, cost-profiler, meter-source.

---

## 1. Tokenomics

### 1.1 Run Guard (SpendGuard) — `packages/core/src/spend-guard.ts` (main)

- Purpose: main:packages/core/src/spend-guard.ts:3-6 — a run belongs to a root session; subagents link to it; money is
  counted as spent (never reads `session.cost`, so a revert can't lower spend). "Vectorscope shares costKindOf and
  priceOf, so a review and the run guard agree on which models can be priced."
- Constants: main:packages/core/src/spend-guard.ts:26-32 — `WARN_AT = 0.8`, `UNPRICED_STEPS = 40`, `LOOP_REPEATS = 3`,
  `LOOP_WINDOW = 8`, `ERROR_STREAK = 3`, `LAST_RUNS = 200`.
- `costKindOf` main:packages/core/src/spend-guard.ts:37-43 (free > plan > priced > local > unknown);
  `priceOf` :46-58 (catalog USD/Mtok, cache read/write optional; zero input+output -> no price).
- `Step` shape :91-110 (costUsd, costKind, unpriced, price, contextTokens, cachedTokens, continues, tools, patched).
- `tighter()` :146-165 — per-limit min of two budgets (used for child/batch/guest budgets).
- `afterStep()` :170-189 — counts spend for priced/unknown kinds only (:175), unpriced steps (:177), then limits, then loops.
- `checkLimits()` :237-266 — steps cap, `$` cap, unpriced cap, then **predicted stop**: next step estimated with
  `nextStepCostUsd(contextTokens + NEXT_STEP_SLACK, price, cachedTokens)` low and with 0 cached as high (:253-259);
  stops if `spent + low > cap` (:260-261); warns once at `warnAt` or when `spent + high > cap` (:262-264).
- Loop rules :273-323 (same tool+input+output 3x without new results or file change; same error 3x in a row).
- Scopes: ledgers of kind `run | batch | child` (:413-418, :338-347 `ScopeSnapshot`); `link(child, parent, {budget, batch})`
  (:719-777) creates child/batch ledgers under the launch run; `capture()` (:564-607) pins the launching scopes for an
  ancillary request (title/memory helper) so it charges the run that launched it, de-duplicated by usageID.
- Interface :356-405: `arm`, `tighten`, `begin`, `replaceFallback`, `ignoreLoops` (:376-379 "such as a Vectorscope
  specialist"), `link`, `release`, `unlink`, `rootOf`, `running`, `record`, `changed`, `resetLoops`, `stopped`, `end`,
  `snapshot`. `record` publishes `SessionStatusEvent.Spend` (:535-559).
- Schema: main:packages/schema/src/run-budget.ts:9-14 `RunBudget.Info {usd, steps, warnAt, unpricedSteps}`;
  :17 `StopReason = cap|predicted|unpriced|steps|loop`; :25 `CostKind = free|priced|plan|local|unknown`
  ("Vectorscope and the run guard share it", :22-24); :31-41 `Snapshot`.
- Where steps are recorded:
  - V2 runner: main:packages/core/src/session/runner/llm.ts:394-436 (`settleStep` -> `guard.record`, including failed
    steps the provider billed, :399-404); :527 `guard.begin`.
  - Step classification: main:packages/core/src/session/runner/model.ts:194-224 `spendStep` (catalog cost, provider
    reported USD preferred, `local` detection, `price` at context+slack).
  - Run start / linking: main:packages/engine/src/session/prompt.ts:2051-2088 — helper sessions (`parentID && internal`)
    link to the root's run only while it is running, else they are a run of their own (:2055-2062); subagents always
    link (:2063-2075); root `begin` with config `budget.run` or research caps (:2080-2088). `arm/tighten` at :1986.
  - Subagent budgets: main:packages/engine/src/tool/task.ts:1390 and :1473 `guard.link(..., { budget })`.
- Self-evolving diverged here (based on an older main): origin/self-evolving:packages/core/src/spend-guard.ts adds a
  `delegated` ledger per request (subagents stop, main agent continues) and a `codium` cost kind with `codiumSteps` and
  `kinds` counters (commits c81c18ad WP4, 3529c596 WP5, 7a7c664d, 42e9ecd2). codium branch also adds `"codium"` to
  `CostKind` (origin/codium:packages/core/src/review/types.ts:21-22 in the diff). On main, Codium steps count as unpriced.

### 1.2 Cost estimation — the step estimator

- **The step estimator**: main:packages/core/src/review/plan.ts:94-102 `nextStepCostUsd(contextTokens, price,
  cachedTokens)` = uncached context at input price + cached at cache-read price + `OUTPUT_PER_STEP` (600) at output price.
  Callers add `NEXT_STEP_SLACK = 3_000` (:12-13). Shared by Run Guard (spend-guard.ts:14,256-257), the review runner
  (engine review/run.ts:213-217) and research (research/estimate.ts:3,10).
- Whole-review range: main:packages/core/src/review/plan.ts:75-92 `estimateCostUsd({promptTokens, maxSteps, price})`
  using `S·P + R·S·(S−1)/2` input growth, low S=5/R=2,000 with cache reads, high S=maxSteps/R=4,000 (constants and their
  2026-09-14 fit at :23-31).
- Diff budget: :46-53 `diffBudgetChars(context, maxDiffChars)` (30% of context after reserve, 3.5 chars/token, 8k..cap).
- `combineCostKinds` :55-62; `contextRefusal` (MIN_CONTEXT 32k) :10, :64-69.
- Research plan estimator: main:packages/core/src/research/estimate.ts:6-12 (prices each step like Run Guard), :73-114
  `estimate()`, :117-133 copy, :136-150 per-agent context growth.
- The vectorscope branch does not change the estimator; it adds a verify-candidate policy to plan.ts
  (origin/vectorscope:packages/core/src/review/plan.ts, VS-06 `verifyCandidates`, `verifyUnconfirmed`, `verifyUnanswered`).

### 1.3 Review budgets

- Config fields: main:packages/core/src/review/types.ts:228-235 (`maxFiles`, `maxChangedLines`, `maxDiffChars`,
  `maxSteps` "security gets ceil(2/3), verify 10", `maxCostUsd`, `maxCostUsdPerPr`, `maxCostUsdPerMonth`,
  `timeoutMinutes`); `triageModel` :236-239. Defaults :245-271 — maxSteps 30, maxCostUsd $2, maxCostUsdPerPr $10,
  perMonth 0 (install writes $50 for paid models, :234), timeout 12 min, maxDiffChars 120k.
- Parsing/env overrides: main:packages/core/src/review/config.ts:93-101 (clamps), :115-126 (`REVIEW_MAX_COST_USD*`,
  `REVIEW_TIMEOUT_MINUTES`), :189-190 `REVIEW_AUTO_MODEL`, :191-197 triage forces verify.
- PR/month gates: main:packages/core/src/review/skip.ts:55-56 (`month-budget`), :68-69 (`pr-budget`, automatic only).
  Month scan in main:packages/engine/src/cli/cmd/github.review.ts:330 and :426-443.
- Persistent per-PR spend: main:packages/core/src/review/types.ts:138-153 `ReviewState {costUsd, tokens, month, inflight}`.
- Runner enforcement: main:packages/engine/src/review/run.ts
  - :178-183 dollar cap only when a pass is on a priced model;
  - :201-212 `reserve()` — synchronous reservation ledger so parallel specialists cannot spend the same remainder
    (spent + uncertain + others' reservations + turn + finalize <= maxCostUsd);
  - :213-217 `nextCost()` uses long-context tier pricing (`Session.costAt`) then `nextStepCostUsd`;
  - :322-330 first-turn admission estimate from prompt+schema length / 3.5;
  - :361-409 `SessionAdmission.Policy` per specialist: step cap, deadline, budget reservation; `settle` adds actual
    cost and keeps uncertain exposure when usage was incomplete (:393-406);
  - :352-354 `guard.ignoreLoops(session.id)` (review has its own limits; Run Guard caps still apply);
  - :450-452 a `BudgetStopError` from Run Guard counts as a budget stop;
  - :540-553 specialists in parallel, security cap ceil(2/3·maxSteps) (:547);
  - :600-613 verify skipped when `estimateCostUsd(...).low` would exceed the cap or < 2 min remain (VERIFY_STEPS 10, :151).
- Desktop runner mirrors it: main:packages/app/src/features/pull-requests/ai-review.ts:55, :1452 (`estimateCostUsd`),
  :1294 and :1341-1345 (run-guard partial review).

### 1.4 Spend ledger(s)

- Engine/session ledger (durable): session row columns main:packages/core/src/session/sql.ts:48-65 (`cost`,
  `unpriced_steps`, `subagent_cost`, `subagent_unpriced_steps`, `subagent_tokens_*`, `tokens_*`); migrations
  main:packages/core/src/database/migration/20261003000011_session_unpriced_steps.ts:8,
  20261003055810_session_subagent_spend.ts:8-9.
- Desktop account-wide ledger: main:packages/desktop/src/main/spend-limits.ts:5 (`vector-spend-ledger.json`), :26-45
  `SpendEvent {projectPath, runId, provider, model, costUsd?, tokens?, source: session|parallel|scheduled}` (cost absent =
  unmeasured, never 0), :56-74 per-run/day/month limits, :76-79 interactive vs unattended policy, :123-135 defaults
  (unattended $5/run, $25/day; interactive uncapped), :151-200 `createSpendLedger`/`recordSpend`, :360-392 API
  (`checkAllowance`, `recordSpend`, `recordRunCost`, `reserve`, `release`, `policy`, `recentEvents`).
  Used by main:packages/desktop/src/main/ipc.ts:199,535-547 and parallel-workspaces.ts:48,2104-2596.

### 1.5 How usage is recorded for helper / review sessions

- Helper sessions are ordinary sessions with `internal` set and a `parentID`:
  main:packages/core/src/session/sql.ts:33-35 ("Helper sessions stay out of session lists; their spend still counts,
  towards parent_id"). Engine review creates `internal: "vectorscope.<name>"` with `parentID: input.parentID`
  (main:packages/engine/src/review/run.ts:331-337); desktop the same (main:packages/app/src/features/pull-requests/ai-review.ts:1241-1249, :1370).
- Each step-finish rolls up to every ancestor: main:packages/core/src/session/projector.ts:119-175 `applyUsage` updates
  the session then `subagent_*` columns of all ancestors via a recursive CTE (:153-172, comment :154 names Vectorscope).
- Non-transcript helper calls (title, model learner) use `SessionEvent.AncillaryUsage`
  (main:packages/schema/src/session-event.ts:207-238, purposes `title|memory`) projected into the same session totals
  (main:packages/core/src/session/projector.ts:529-547) and charged to the captured Run Guard scope
  (main:packages/engine/src/session/title-usage.ts:9-71).
- Review report cost: main:packages/engine/src/review/run.ts:241-287 `measure()` sums assistant messages of all review
  sessions and their children via `measureCost` (main:packages/engine/src/cli/cmd/github.evidence.ts:100-129, returns
  undefined instead of a fabricated zero); per-pass breakdown :290-311 (`ReviewPass`, types.ts:201-208).
- Review model cost kind: main:packages/engine/src/review/model.ts:121-145 (`SpendGuard.costKindOf`, OAuth plan, local
  server, `SpendGuard.priceOf`).

### 1.6 Tokenomics fixes on tokenomics-* / *-accounting branches (all merged)

| commit | branch | what | files |
|---|---|---|---|
| e6ebdfc1 | tokenomics-efficiency | bind ancillary spend to launching scopes (`capture`) | core/src/spend-guard.ts |
| 36a0e921 | tokenomics-efficiency | preserve usage uncertainty and helper run costs | engine/src/session/{processor,prompt,session,title-usage}.ts |
| a369199d | tokenomics-efficiency | prefer reported OpenRouter costs over catalog | engine/src/session/session.ts |
| c96f83a1, 70613cc4 | tokenomics-efficiency | explicit prompt cache boundaries, on by default | engine/src/provider/{provider,transform}.ts, session/llm/request.ts |
| bd537fd2 | tokenomics-efficiency | omit malformed provider token totals | engine/src/session/session.ts |
| 9fbc670f, 46e63cdd | tokenomics-unsettled | uncertainty for interrupted turns; absent terminal usage != zero | core/src/session/runner/{llm,model,publish-llm-event}.ts |
| fbe2b85d, dae48615, b9bc0cbb | compaction-accounting lineage | V2 loop signatures, reset loops on promoted user input, V2 loop guards | core/src/spend-guard.ts, runner/* |
| 1a3d07c4 | compaction-accounting | count compaction calls against run budgets | core/src/session/compaction.ts (main:...compaction.ts:302) |
| 94c27c67 | legacy-step-accounting | retain completed step spend through cancellation | engine/src/session/processor.ts |
| 89525f44 | publication-accounting | retain guard spend after publication defects | engine/src/session/processor.ts (main:...processor.ts:738) |

Write-ups on main: docs/benchmarks/tokenomics-2026-11-04/{compaction-accounting,legacy-cancellation-accounting,publication-accounting,final-study-report}.md.

---

## 2. ZDR / privacy

- `packages/core/src/provider-policy.ts` (main, 256 lines) is **not** a data-retention policy: it governs which OAuth
  sign-ins and credentials are allowed (main:packages/core/src/provider-policy.ts:16-24 sign-in switches, :213-245
  `providerOAuthAllowed`/`providerCredentialAllowed`). No ZDR, training or retention fields.
- Data policy exists **only for free models**: main:packages/schema/src/model.ts:66-70 (`freeModel.dataPolicy`),
  main:packages/schema/src/free-model.ts:10 (`no-training | may-train | unreviewed`). Paid/BYOK models carry no
  retention metadata (`family` is the only lineage-ish field, :22, :64).
- "May train on prompts" filtering:
  - main:packages/core/src/free-model-choice.ts:13-17 (no-ZDR disclosure, label), :22-30 (consent copy), :124-127
    `freeModelMayTrain`.
  - main:packages/core/src/free-model-catalog.ts:44-108 `REVIEWED_FREE_ENDPOINTS` (per-endpoint reviewed policy,
    unreviewed = may-train), :292-308 `freeEndpointPolicy`/`freeModelDataPolicy` (least private endpoint wins).
  - main:packages/core/src/catalog.ts:265-271 never auto-pick a may-train model first.
  - main:packages/engine/src/provider/provider.ts:1641-1649 `withoutTrainingFreeModels` (guests);
    :2849 default free pick excludes may-train.
  - Brain: private documents and personal memory withheld from may-train models
    (main:packages/core/src/brain/knowledge.ts:79-80, main:packages/core/src/brain/distill.ts:113-116).
  - Review: private documents only for a non-training model, never in a posted review —
    main:packages/engine/src/cli/cmd/review.ts:1294-1305 (`personal: !shared && !freeModelMayTrain(chosen)`).
- OpenRouter routing options already sent:
  - Free-model route: main:packages/core/src/free-model-request.ts:112-130 (fallbacks never weaken policy),
    :135-141 (`only` provider list or `ignore` barred), :171-186 `provider: { data_collection: deny|allow,
    require_parameters: true, only/ignore, max_price: 0 }`, plugins disabled (:174). Comment :175-177: "Zero data
    retention is not requested".
  - BYOK OpenRouter guard: main:packages/core/src/free-model-catalog.ts:198-224 `openRouterModelRouting` (fields that
    could reroute: models/route/preset/plugins/openrouter/*), :226-233 `denyDataCollection` (sets
    `provider.data_collection: "deny"`). Applied V1 in main:packages/engine/src/provider/provider.ts:2526-2546 and V2 in
    main:packages/core/src/session/runner/model.ts:308-330 — **only** when routing fields are present and the user has
    not consented.
  - Other OpenRouter body fields: main:packages/engine/src/provider/transform.ts:1264-1271 (`usage: {include: true}`),
    :1378-1380 (`prompt_cache_key`). main:packages/engine/src/plugin/openrouter.ts is OAuth only.
  - `zdr`, `allow_fallbacks`: **not sent anywhere in packages/engine or packages/core** on any of the four branches.
- Codium gateway (server side, `api/_lib`):
  - main:api/_lib/model-plan-chat.ts:147-154 `provider: { data_collection: "deny", zdr: true, require_parameters: true,
    quantizations?, max_price }`; catalog note main:api/_lib/codium-catalog.ts:1-3 ("ZDR remains mandatory").
  - origin/codium adds pinned routes: origin/codium:api/_lib/model-plan-chat.ts:158-166 (`only: providerOnly,
    allow_fallbacks: false` when `providerOnly` is set); origin/codium:api/_lib/codium-reservations.ts:4-55
    (`RESERVATION_CAPTURE` sha + `CAPTURED_RESERVATIONS` per model with tag, context, prices), :62-81
    (`capturedReservationMicro`), :83-97 **`ROUTE_ACCEPTANCES` = [] deliberately empty** with required premises
    `nativeWindowEnforced, outputIncludesReasoning, exactTagWithZdr, capturedRatesBoundCharges`;
    origin/codium:api/_lib/model-plan-catalog-policy.ts:25-37 (`servedPlanModels` -> none while empty), :58-69
    (`gatewayPlanModels` adds `providerOnly: [tag]`), :76-108 (`capturedGatewayModel`), :110-126
    (`verifiedGatewayModel` requires an acceptance with `exactTagWithZdr`). Validation of `providerOnly` tags:
    origin/codium:api/_lib/model-plan-config.ts:39, :294-297. origin/self-evolving carries the same
    model-plan-chat.ts:160-162 change.

---

## 3. Vector Brain (`packages/core/src/brain/*`, main)

- Tiers: main:packages/core/src/brain/brain.ts:44-53 (Tier 0 digest, Tier 1 recall/attach BM25, Tier 2 search/get; no
  model call on the request path). Budgets :78-87 (`memory 800, pinned 300, attach 200, search 1200 chars`),
  :132-138 (`HABITS = {subagent: 100, review: 300}`, `recallBudget` chat 0/light 200/standard 300/thorough 500),
  `Place` :143-152.
- Memory entries: main:packages/core/src/brain/schema.ts:5-24 one entry model; kinds
  `rule|preference|decision|lesson|fact|failure|review|term`; **`review` = what Vectorscope was told not to flag, read
  only by reviews** (:19). Tables main:packages/core/src/brain/sql.ts:11-180 (`brain_entry`, evidence, events, use).
- Documents/cards: main:packages/core/src/brain/knowledge.ts:65-80 (sections, passages, typed records; recall fuses
  memory+cards in one budget; private docs withheld from guests and may-train models). Card rendering
  main:packages/core/src/brain/card.ts:6-39 (`- [id] kind · title p.N §x: text`, passage behind `get`, wrapped as data).
- Budgets: main:packages/core/src/brain/knowledge.ts:641-688 — `GET {card 600, passage 600, outline 600, part 1500}`,
  `READS`, **`POINTER = {weight 0.6, ids 3, tokens 60, guard 50}`**, `BRIEF = {tokens 200, subagents 4}`,
  `budget(tier)` with documents `{light 300, standard 500, thorough 900}` halved when Run Guard warned (`tight`).
- How recall picks items: main:packages/core/src/brain/knowledge.ts:2374-2520
  1. memory candidates (top 5) from BM25 (:2397-2402);
  2. document lexical hits over request terms + changed file paths, vocabulary expansion, eligibility gate and confidence
     floor (:2403-2412);
  3. code-graph activation from seeds (files/symbols) through Personalized PageRank (:2413-2423);
  4. dense meaning hits once the local embedding model is ready (:2424-2426);
  5. weighted RRF fusion (:2451-2456; main:packages/core/src/brain/fuse.ts:28-46, K=60, DEPTH=50);
  6. value = fused/best × trust × freshness × proven credit × confidence (fuse.ts:56-67; TRUST :14-26);
  7. knapsack pack within the token budget, diminishing returns per section/document, conflict pairs together, stop at
     15% of first pick (main:packages/core/src/brain/pack.ts:3-73).
- Code graph / symbol index: regex per language (main:packages/core/src/brain/code.ts:6-9, LIMIT :54-67); stored in
  `brain_code_file` (imports, dependencies, co_change), `brain_code_symbol` (name, kind, line, exported,
  signature_hash), `brain_code_literal` (routes, env vars, constants) main:packages/core/src/brain/sql.ts:487-544.
  PPR graph main:packages/core/src/brain/graph.ts:3-36 (ALPHA 0.25, HOPS 3, weights imports/co-change/contains).
  Doc->code anchors via Ripgrep (anchor.ts:1-2), drift checks (drift.ts), outcome credit (credit.ts).
  Seeds: fuse.ts:69-79 (`edited 1, attached 1, symbol 0.9, changed 0.8, read 0.7`, max 12).
- Already wired into review:
  - Linked requirements: main:packages/engine/src/review/context.ts:176-240 `ReviewContext.requirements` — per changed
    file `knowledge.links`, keeps requirement/constraint/contract/decision links with weight >= 0.6, flags drifted /
    missing / value mismatch, renders cards, caps 300 tokens and 40 files (:22-26).
  - Owner review habits: main:packages/engine/src/session/prompt.ts:3085-3125 `reviewFor` uses `brain.habits` with
    `Brain.HABITS.review` (300 tokens), query = changed paths (`scopeQuery`), outward audience; trust gating in
    `habitsOf` :144-156 (untrusted PRs get only preference+review kinds); `ownerBlock`
    main:packages/core/src/review/prompt.ts:165-178.
- Cheap "top 3 cards" options (no model call, all local SQLite):
  - `BrainKnowledge.search(place, {query, limit: 3, personal})` main:packages/core/src/brain/knowledge.ts:551-554,
    :3029-3068 — BM25 (+ dense if ready), returns redacted `Card[]`; query from changed paths + `changedSymbols` names.
  - `BrainKnowledge.links(place, file, {personal})` + `cards()` (:584-588, :5850, :493-497) — code-anchored,
    already used by ReviewContext.requirements; just slice the sorted lines to 3.
  - `pointers(place, input)` (:571, POINTER ids 3 / 60 tokens) — the read-time "Documents linked to <file>" line.
  - `brief(place, {query, seeds, ...})` (:619-631, :6511-6548) — a 200-token recall with code-graph seeds; seeds can be
    the changed files (`changed` 0.8) and declared symbols (0.9).
- self-evolving adds learned skills and workflow insights (origin/self-evolving:packages/core/src/brain/skill.ts 2118
  lines, workflow.ts, skill-store.ts, migrations 20261210000000_learned_skills, 20261211000000_workflow) — not on main.

---

## 4. Parsing

- Dependencies (identical on all five branches):
  - main:packages/engine/package.json:138-139 `tree-sitter-bash 0.25.0`, `tree-sitter-powershell 0.25.10`;
    :144 `web-tree-sitter 0.25.10` (runtime `dependencies`).
  - main:packages/core/package.json:61 `@babel/parser 7.29.7` (runtime).
  - main:packages/engine/package.json:32 `@babel/core 7.28.4` and :50 `typescript` — **devDependencies only**.
  - No `@typescript-eslint`, `ts-morph`, `acorn`, `@swc`, `oxc`, `@ast-grep` anywhere.
- Usage:
  - web-tree-sitter only parses shell commands for permissions: main:packages/engine/src/tool/shell.ts:9, :896-930
    (lazy WASM runtime, bash and PowerShell grammars loaded on first use).
  - @babel/parser only rewrites plugin imports: main:packages/core/src/plugin/local-sdk.ts:20, :140.
  - TUI highlight grammars are fetched as remote WASM URLs: main:packages/tui/src/parsers-config.ts:1-10 onward
    (python, rust, go, cpp, java, ...; JS/TS via opentui built-ins) — not available to core/engine.
  - No TypeScript compiler API import in any `src`.
  - LSP client exists: main:packages/engine/src/lsp/{client,diagnostic,language,launch,lsp,server}.ts.
- `packages/core/src/review/symbols.ts` (main, 177 lines): regex-based declarations in a diff's **added lines** for
  TS/JS, Python, Go, Rust, Java (:1-3, :14-31); skips keywords/common names (:33-44); per-language matchers (:49-143);
  `changedSymbols(files, limit=10)` exported-first, then function/class/type, method, variable (:145-177). Consumed by
  `ReviewContext.relatedCode` which runs `git grep -n -w -F` at the head for up to 10 symbols × 15 hits
  (main:packages/engine/src/review/context.ts:15-17, :28-80). The brain code index uses a separate, broader regex
  reader (brain/code.ts) with 10 languages.

---

## 5. Isolation for runtime checks

- self-evolving TaskIsolation (WP27 lifecycle 2026-10-29, WP28 wiring/merge 2026-10-30 —
  origin/self-evolving:docs/vector/build/multiagent-parity-deviations.md:419, :437):
  - origin/self-evolving:packages/engine/src/task/isolation.ts:57-121 `Record` (mode `worktree | copy`, branch,
    gitDirectory, state, attempt); :125-133 `Limits` (fileBytes 50 MiB, minFreeBytes 1 GiB, copyBytes 1 GiB, copyFiles
    20k, patchBytes 256 KiB); :262-264 `brief` text for the agent; :265-274 locations
    (`<data>/task-worktree/<project>/<task>`, branch `vector/subagent/<taskID>`); methods `check` :991, `reserve` :1040,
    `start` :1231, `settle` :1534, `changes` :1720, `merge` :2275, `discard` :2490, `resume` :2526, `admit` :2755;
    interface :2789-2810; `Service` :2814; `complete` :2821.
  - Raw checkout primitive: origin/self-evolving:packages/engine/src/worktree/index.ts:126-134 (`createForTask`,
    `removeForTask`); file-copy mode origin/self-evolving:packages/core/src/isolation/copy.ts.
  - Not on main (main's task tool has no isolation; main:packages/engine/src/worktree/index.ts:120-127 has only the
    user-facing create/list/remove/reset).
- @vector hosted agent sandbox V16 (vector-at-mention):
  - origin/vector-at-mention:packages/engine/src/cli/cmd/github.sandbox.ts:11-16 (separate `vector-agent` UID, staging
    containers), :17-30 private state, :37-44 mode gate (GitHub Actions only, codium requires github-hosted, no sudo),
    :365 `prepare`, :513-560 `run` (verifies core_pattern=/dev/null, ptrace_scope>=2, UID, clean env, secret channel),
    :609 `finish` (cleanup guard, quarantine). Constants origin/vector-at-mention:packages/core/src/github-agents.ts:119-122.
  - Design notes origin/vector-at-mention:docs/vector/build/vector-at-mention-deviations.md:324-341; CI probe
    origin/vector-at-mention:.github/workflows/vector-at-mention.yml:197-296.
  - Linux GitHub-hosted runners only; self-hosted own-key runs have no UID isolation (:549-552).
- Local shell sandbox (main and branches): main:packages/engine/src/tool/shell/sandbox.ts:12 (`seatbelt | bubblewrap |
  none`), :32 `VECTOR_SHELL_SANDBOX`, :123-134 availability, :157-206 seatbelt profile, :211-222 offline network rules,
  :252 `offline()`.
- Existing "run the repo's tests" facilities:
  - Vectorscope local `--checks`: main:packages/core/src/review/permission.ts:24-40 `CHECK_COMMANDS` (bun/npm/pnpm/yarn
    test, typecheck, pytest, cargo test, go test; no flags allowed), :75-84 rules; CLI consent and refusal
    main:packages/engine/src/cli/cmd/review.ts:341-348 (other authors' commits), :742-743 (never with --pr), :1246 flag.
  - Desktop deterministic guardrails: main:packages/desktop/src/main/workspace-guardrails.ts:64-130
    `detectWorkspaceChecks` (package scripts typecheck/check/test/lint/build via detected runner, python compileall +
    pytest, cargo check, go test; max 5), :132-201 `runCheck` (untrusted child env, CI=1, 120 s timeout, 80 KB output,
    missing tool = skipped), :203-229 `validateWorkspace` (stops at first failure), :231-240 repair prompt. Used by
    parallel workspaces (main:packages/desktop/src/main/parallel-workspaces.ts:44, :222-223, :836-841).
  - Check detection from transcripts: main:packages/engine/src/cli/cmd/github.evidence.ts:70-80 `isCheckCommand`,
    :131-150 `collectChecks` (bash tool calls that look like tests/typecheck/lint/build, with exit codes).

---

## 6. Authoring-model metadata

- Per-step model and changed files (V2): main:packages/schema/src/session-message.ts:179-200 `Assistant { agent,
  model: Model.Ref, snapshot: {start, end, files}, cost, tokens }`; model switches :51-56; step end event with
  `snapshot` and `files` main:packages/schema/src/session-event.ts:163-183.
- Session-level: main:packages/core/src/session/sql.ts:68-73 (`agent`, `model {id, providerID, variant}`).
- Desktop parallel workspaces record who wrote it: main:packages/desktop/src/main/parallel-workspaces.ts:136-168
  (`runtime` vector or external CLI, `provider`, `model`, `runtimeModel`, `externalSessionId`, `gitBranch`,
  `baseCommit`), :209 `pullRequestUrl`.
- PRs opened by `vector github run` carry a "## Vector evidence" section with
  `**Cost:** ... · provider/model · N turns` (main:packages/engine/src/cli/cmd/github.evidence.ts:199-212, :258-270;
  model = latest assistant message, :104-125).
- Commit trailers: only the human actor — main:packages/engine/src/cli/cmd/github.handler.ts:544-549
  (`Co-authored-by: <actor> <actor@users.noreply.github.com>`); same on all branches. **No trailer or git note records
  the model.** self-evolving only classifies `git notes` / `--trailer` as ref mutations for shell claims
  (origin/self-evolving:packages/engine/src/tool/shell/git-mutation.ts:99, :486-492).
- Lab/family detection (codium only, not merged): origin/codium:packages/core/src/model-lab.ts:7-113 (`LABS`, vendor
  path segments, family regexes, first-party providers, `labOf(name, hint)`); review panel
  origin/codium:packages/core/src/review/second-lab.ts:1-125 (`reviewModels` refuses same-lab pairs, `checkedLabs`,
  "Checked by a second lab"); config fields `panel`, `judgeModel` (origin/codium:packages/core/src/review/config.ts
  diff; types.ts `labs?: 2|3`, specialist `judge`). Commit 298cc87f (A35). Main has only `Model.Family`
  (main:packages/schema/src/model.ts:22, :64).
- vectorscope branch VS-07 model evidence is about the reviewer's model certificate, not the author
  (origin/vectorscope:packages/core/src/review/model-evidence.ts:1-12).

---

## Implications for Vectorscope

1. Reuse `SpendGuard.costKindOf/priceOf` + `nextStepCostUsd` + the review runner's reservation ledger for any new pass
   (ensemble, judge, runtime-check agent); keep `ignoreLoops` and the `internal: vectorscope.*` + `parentID` convention so
   spend rolls up and stays out of session lists.
2. Treat all tokenomics fixes as present on main; build on main, not on self-evolving's older SpendGuard. If delegated
   ledgers or the `codium` cost kind are needed, they live only on self-evolving/codium.
3. ZDR for BYOK OpenRouter does not exist in the engine. To offer it, extend the `denyDataCollection` overlay pattern
   (free-model-catalog.ts:226-233 + runner/model.ts:308-330 + provider.ts:2532-2546) to add `zdr: true`; reuse Codium's
   `providerOnly` + `allow_fallbacks: false` shape. Codium's gateway already sends `zdr: true`, but codium's pinned-route
   acceptances are empty, so Codium serves nothing on that branch.
4. For context, call `ReviewContext.requirements` (existing) and add a 3-card `BrainKnowledge.search` or `brief` call
   seeded with changed files and `changedSymbols`; respect `personal` (may-train) and trust gating.
5. web-tree-sitter is already a runtime dependency of engine; a code-language grammar would add WASM assets (the TUI's
   grammar URLs show versions), but core/review/symbols.ts and brain/code.ts are regex today.
6. For runtime checks reuse `workspace-guardrails.ts` detection/runner and run it inside a TaskIsolation worktree
   (self-evolving) or the shell sandbox; the hosted V16 sandbox is GitHub-Actions-only.
7. Authoring family can be inferred from session/assistant `model` + `snapshot.files`, parallel-workspace records, or the
   evidence line in PR bodies, then mapped with codium's `labOf`. There is no git-level provenance; a model trailer would
   be new work.
