# VectorScope upgrade build contract (VS-21 to VS-31)

Status: a proposed extension of the approved plan `docs/vector/build/vectorscope-plan.md`, written 2026-11-06 and revised the same day after two reviews (§10). It is not approved, not implemented, and makes no claim of measured quality.

- **VS-21 to VS-31 are proposed packages.** The approved plan ends at VS-20, and the deviation log mentions none of them, so each needs owner approval (Q15). "VS-25 supersedes VS-17" would change an owner-approved plan item and is pending owner sign-off.
- The approved decisions D1–D14 stay in force. Where this contract, or the owner's request, conflicts with one of them or with the plan's order of work, §7 says so and makes a recommendation. The decision wins until the owner changes it.
- **Evidence.** `vectorscope-research/REPORT.md` and the eight research notes beside it in `docs/vector/build/vectorscope-research/`. Round two of the research is `vectorscope-research/round-two/REPORT.md`, and its proposed packages VS-32 to VS-49, with changes to VS-21 to VS-31, are in `vectorscope-upgrade-addendum-a.md` (addendum A, pending owner question Q18). Round three of the research is `vectorscope-research/round-three/REPORT-3.md`, and its proposed packages, each amending a package of this contract or of addendum A, are in `vectorscope-upgrade-addendum-b.md` (addendum B, pending owner question Q45). Notes are cited by name, for example `[quality §6.1]` for `greptile-quality.md` section 6.1.
- **Citations.** Code is cited as `path:line` on the merged commit `02c23b4c` (P0: `origin/main` at `4299d743` merged into `origin/vectorscope` at `dbcfbe8f`), unless marked `self-evolving:`, `codium:` or `vector-at-mention:`. P0 re-cited every line (deviations log, 2026-11-06 · P0), and P0's own edits move none of them. The research notes keep their citations on `dbcfbe8f`.
- **Name.** The plan calls the product VectorScope; so does this contract. `vectorscope` stays only in branch and path names. Some code strings still read "Vectorscope" (for example `format.ts:663`); changing user-visible text is out of scope here (D14).

## 0. Rules for the implementing agent

### 0.1 Precondition P0, before any package

1. Cut a working branch from `origin/vectorscope`, for example `vectorscope-upgrade`.
2. Merge `origin/main` into it (246 commits ahead when this was written). This brings, among others:
   - `3ae59867 fix(review): reserve using actual context price tiers` to `packages/engine/src/review/run.ts`;
   - the V1 fetch body rewrite through `ProviderTransform.promptCacheBreakpointBody` and `requestInput` in `packages/engine/src/provider/provider.ts`;
   - changes to `packages/core/src/session/runner/model.ts` and `packages/core/src/brain/knowledge.ts`.
3. The merge breaks the `REVIEW_PIPELINE_SOURCES` pin (`packages/core/src/review/model-evidence.ts:39-42`), checked in `packages/core/test/review/model-evidence.test.ts`. Update the pin.
4. Do not bump `REVIEW_PIPELINE_REVISION`, and record why in the deviations entry: `3ae59867` changes which reservation price applies once a session's context crosses a provider's price tier (its own note tests the 272,000-token boundary), not what a review finds below that size. Note as a scope caveat that, under a tight cap, a pass past that boundary may now be refused where it used to be admitted.
5. Re-cite every `path:line` in this contract on the merged commit before the first package lands.
6. Record all of this in `docs/vector/build/vectorscope-deviations.md`.

### 0.2 How packages land

- **Two windows** (§5). Pure core modules, new engine files that nothing yet calls, and the eval work land now. Wiring new behaviour into the runners (`run.ts`, `ai-review.ts`, `provider.ts`, `session/llm.ts`, `posting.ts`) waits until `self-evolving` reaches `main`, unless the owner grants an exception (Q13). Both `self-evolving` (+136 lines in `run.ts`, +314 in `ai-review.ts`, +150 in `provider.ts`) and `codium` (+316 in `run.ts`, +413 in `ai-review.ts`, plus `types.ts`, `config.ts`, `format.ts` and `state.ts`) rewrite the same files.
- If the owner grants Q13, add a rebase checkpoint before each of the `self-evolving` and `codium` merges. The owner of that branch's workstream resolves conflicts in its files, and the deviations entry records who did and how.
- Land packages one at a time, in order. Rebase each on the one before: almost every package touches `types.ts`, `config.ts`, `prompt.ts` and the pin.
- Commit messages: `feat(review): ...` and `test(review): ...`.
- Branch names: at most three words, no slashes.

### 0.3 What every behaviour-changing package carries

1. **An opt-in key.** Add an off-by-default key to `ReviewConfig` (`packages/core/src/review/types.ts:211-283`) and parse it through the source-tagged merge in `config.ts` (§1.1). The key reaches `Review.run` through `RunInput.config` on every surface.
   - **Every key-driven step happens inside `Review.run`**, from `RunInput.config`, `directory`, `base` and `head`. The GitHub job passes only `config.model` and `config.triageModel` to model resolution (`github.review.ts:291-301`), and its context gatherer takes no config and returns only related code, history and instructions (`github.review.ts:168-175,563-570,1082-1093`). So route checks, the impact slice and depth decisions cannot live in `ReviewContext.gather` or in model resolution if they are to reach GitHub without editing `github.review.ts`.
   - A step that has to live in the GitHub job itself waits for the @vector merge (§5).
   - VS-06 and VS-07 used this pattern.
2. **A D3 parity test, per runner.** With the key unset, each runner sends byte-identical requests and returns the same outcome as *that same runner* did before the package. (The engine and desktop runners already differ under the legacy verify rules, `plan.test.ts:268-278`, so cross-runner identity is not the bar.) Patterns to follow:
   - `packages/engine/test/review/run.test.ts`;
   - `packages/app/src/features/pull-requests/ai-review.test.ts`;
   - VS-06's legacy comparison in `packages/core/test/review/plan.test.ts`.
3. **Evidence scope.**
   - If the key changes what is found or posted, add it to `EVIDENCE_POLICY_KEYS`. If it changes the route, add an `EvidenceScope` field.
   - **Default-stable digests.** `policyDigest` hashes every listed key today (`model-evidence.ts:256-258`), and `promptsDigest` hashes every canonical prompt. So a new key contributes to `policyDigest` only when set to a non-default value, and a new prompt section or output schema (strict schemas included) enters `promptsDigest` only when the key that enables it is set. The frozen `engine` baseline then stays comparable across packages. Existing keys keep their current digest behaviour, so VS-07's digests do not move.
   - Add new pure pipeline modules to `REVIEW_PIPELINE_FILES` in `model-evidence.test.ts` and update the pin.
   - Only VS-31 bumps `REVIEW_PIPELINE_REVISION`, when it changes a default.
4. **A replay variant name** registered in VS-21a, and a dry projection.
5. **The desktop half, or a documented difference.** Until VS-10, `ai-review.ts` is a separate runner (dollar cap, step caps, context, prior findings and CI checks differ). Each package either implements its key there too, with its own parity test, or records an intentional difference (`vectorscope-plan.md:320`); the desktop eval adapter then writes `variant.applied: false`.
6. **A dated deviations entry.**

### 0.4 Tests and typecheck

- Run test files from their package directory: `packages/core`, `packages/engine` or `packages/app`.
- The eval scripts' tests run from `script/vectorscope-eval` (`bun test replay.test.ts` and so on), and the fixtures test from `packages/script` (`bun test --timeout 30000 ../../script/vectorscope-eval/fixtures.test.ts`) (`script/vectorscope-eval/README.md:310-313,484-494`).
- Run `bun typecheck` in each package. Check the eval scripts with `script/vectorscope-eval/tsconfig.json`.
- Never run either from the repo root.
- After any change to a protocol or HttpApi, run `bun run generate` in `packages/client`. A change to the engine's global config schema (VS-23d) also needs `./packages/sdk/js/script/build.ts`, because the config type is in the generated SDK (`packages/sdk/js/src/gen/types.gen.ts:2416`).

### 0.5 Never

- Edit files @vector owns before `vector-at-mention` merges. These are:
  - `packages/core/src/review/workflow.ts` and `command.ts`;
  - `packages/engine/src/cli/cmd/github.*`;
  - `packages/desktop/src/main/github-*.ts`;
  - the GitHub sections of `packages/web/src/pages/docs/vectorscope.astro`.
- Start a paid run.
- Commit eval results.
- Widen MCP access.
- Add GitHub App permissions.
- Publish to npm.
- Build a second coordinator, ledger, isolation layer, lab mapper or cross-lab checker beside the ones on `self-evolving` and `codium` (`codium:packages/core/src/review/second-lab.ts`, `reviewModels`, the `panel` and `judgeModel` settings).
- Build a third code reader beside `brain/code.ts` and `review/symbols.ts` (VS-25 decision).

## 1. Architecture of the new pipeline

```
PR or local diff
  |
  v
Stage 0  Gate (0 tokens)                     core skip.ts, trivial.ts, privacy.ts; engine run.ts (inside Review.run)
  - existing skips: budget, label, draft, fork, already-reviewed, carry, nothing-to-review, too-large
  - route: every model the run may use has an allowed ZDR route, or the review stops ("privacy") with 0 attempts
  - trivial: whitespace / docs / rename / comment-only under strict rules, never sensitive or behaviour-bearing ("trivial")
  |
  v
Stage 1  Tier 1 impact slice (0 tokens)      engine review/parse.ts, review/impact.ts; core impact.ts, risk.ts, brain/code.ts
  - import graph from BrainCode.imports/resolve (+ workspace and tsconfig aliases)
  - pinned tree-sitter spans at base and head: enclosing definitions, references, comments
  - changed definitions -> import-gated dependents (git grep of the head tree-ish, parsed to confirm)
  - personalized PageRank (BrainGraph.rank); token-budgeted slice of signatures and call sites
  - change-risk band -> depth (history features only where available)
  - at most 3 Brain cards (local CLI)
  |
  v
Budget   Pre-dispatch estimate (0 tokens)    core dispatch.ts; engine run.ts
  - estimate every planned pass; decide on the low (or calibrated) estimate:
    shrink lenses -> cards -> dependents -> diff, or stop ("budget-estimate") with 0 attempts
  |
  v
Stage 2  Tier 2 deep reasoning               engine run.ts (existing specialists, allowed route)
  - review (+ security on sensitive paths, + single-class lenses on high risk when `lenses` is on)
  - read tools kept: the slice is a starting point, not a limit
  |
  v
(optional) Runtime evidence                  engine review/runtime.ts (local, own changes, consented; after self-evolving, VS-12, VS-18)
  - tests at head and base, changed-line coverage, differential reproducers; isolated worktree, network off
  |
  v
Stage 3  Tier 3 guardrail                    engine run.ts verify; core guardrail.ts, select.ts
  - verify every candidate (shared policy); cross-family through the triageModel/model pair when configured
  - strict rules S1-S8; dedup; cap; StrictResult JSON; empty only when complete; unreadable verdicts fail closed
  |
  v
Surfaces: GitHub (existing posting, redaction, posting guard), CLI (print, existing --json), desktop (Post)
```

- No stage before Tier 2 calls a model.
- **Where the route check sits.** Every model call is already admitted by the reservation ledger's admission policy (`run.ts:427-502`, `SessionAdmission.Policy`). The route check goes in that policy's `admit`, before the step and budget logic, and in `ask()` before the session is created. It must not go inside `reserve()`, which returns `true` for an uncapped run (`run.ts:258-261`) and would therefore skip free, plan and local models. The transport backstop in VS-23c refuses anything that slips past.

### 1.1 Opt-in keys

| Key | Values (default first) | Env | Package | Evidence scope |
|---|---|---|---|---|
| `privacy` | `standard` / `zdr` | `REVIEW_PRIVACY` (raises only) | VS-23 | `EvidenceScope.route` |
| `zdrAttested` | `[]` (provider IDs, `openrouter`, server hosts) | none | VS-23 | route |
| `trivial` | `review` / `skip` | `REVIEW_TRIVIAL` | VS-24 | policy key |
| `maxInputTokens` | `0` (none) | `REVIEW_MAX_INPUT_TOKENS` | VS-24 | budget, not a policy key |
| `impact` | `grep` / `graph` | `REVIEW_IMPACT` | VS-25 | policy key |
| `cards` | `off` / `brain` | `REVIEW_CARDS` | VS-26 | policy key |
| `guardrail` | `off` / `strict` | `REVIEW_GUARDRAIL` | VS-27 | policy key |
| `depth` | `fixed` / `auto` | `REVIEW_DEPTH` | VS-28 | policy key |
| `lenses` | `off` / `high` | `REVIEW_LENSES` | VS-28 | policy key |
| `alternateModel`, `inversion` | unset; `off` / `author` | none | VS-29b | scope |
| `runtime` | `off` / `ask` | none | VS-30 | policy key |
| `mode` | `standard` / `precise` | `REVIEW_MODE` | VS-31 | expands into the keys above |

There is no new verifier key. The cross-family verifier (VS-29a) uses the existing `triageModel`/`model` pair: the review and security passes run on `triageModel`, and the double-check runs on `model` (`types.ts:247-249`; `run.ts:226-227`). `EvidenceScope.triage` already records the pair (`model-evidence.ts:66-74`).

**Where a key may come from (invariant I-2).** Today `parseReviewConfig` takes one JSON text and one environment, with no notion of where either came from (`config.ts:176-222`). VS-23a adds a merge that tags each source: the user's global engine config, `review.json` at the base commit, `review.json` in the working tree, and the environment.
- **`privacy`** is the strictest of the global engine config's `review.privacy`, the `review.json` the surface reads, and `REVIEW_PRIVACY`. Any source may raise it; none may lower it.
  - **In CI**, set it in the base branch's `review.json`. The generated workflow runs same-repository PRs on `pull_request` (`workflow.ts:187-193`), so a PR can edit the workflow and its environment, and a setting that lives only in the workflow environment can be removed by such a PR.
  - **On the desktop**, when a PR changes `review.json` the runner today falls back to the defaults (`ai-review.ts:682-695`), which would silently lower `zdr` to `standard`. VS-23d makes it read the base blob instead, and the global setting applies regardless.
- **`zdrAttested`, `alternateModel`, `inversion` and `runtime`** come only from trusted sources:
  - locally, from the user's global engine config, never from the working tree, because your own branch can hold other people's commits (`review.ts:215-216`);
  - in CI, from the base branch's `review.json` only, never from the environment.
- **Every other key** keeps today's sources: CI reads the base branch's `review.json` and the workflow environment (`github.review.ts:278-290`); the desktop refuses settings a PR changes.
- Each rule has its own test.

### 1.2 Data contracts (new core modules, pure and browser-safe)

```ts
// packages/core/src/review/types.ts (VS-27a). The file stays import-free (types.ts:1-2), so the shared types live here.
export const FAILURE_CLASSES = ["crash", "data-corruption", "leak", "runaway-loop", "auth-bypass"] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]
export interface FailureInfo { class: FailureClass; mechanism: "logic" | "concurrency" | "regression" | "resource" | "access"; trigger: string; impact: string }
export interface Quote { path: string; line: number; side: Side; code: string } // LEFT side for code the change removed
// In the strict report schema only, ModelFinding gains: failure?: FailureInfo (required on blocking findings),
// quotes?: Quote[] and patch?: string (a unified diff against head). Today evidence is only "path:line" strings
// (types.ts:34, schema.ts:69), so S4 and S6 cannot run on legacy output.
// Finding gains verifiedBy?: "model" | "runtime"; Finding.verified stays boolean (see "Types that change" below).

// packages/core/src/review/privacy.ts (VS-23a)
export type ReviewPrivacy = "standard" | "zdr"
export type RouteRefusal = "free-model" | "router-or-preset" | "fallback-models" | "plugins" | "unattested-provider"
  | "unattested-openrouter" | "unattested-network-server" | "retention-required-model" | "codium-unaccepted" | "batch"
  | "unreadable-body" | "unattributed-request" | "unknown-destination"
export type RouteDecision = { allowed: true; kind: "loopback" | "openrouter-attested" | "attested" } | { allowed: false; refusal: RouteRefusal }
export function decideRoute(model: { providerID: string; modelID: string; npm?: string; baseURL?: string; freeModel?: boolean },
  policy: { privacy: ReviewPrivacy; attested: readonly string[] }): RouteDecision
// Adds provider.zdr = true and provider.data_collection = "deny" and keeps every other provider preference as it is.
// It does not add require_parameters, which is not a privacy control. Returns undefined, so the caller refuses, when
// openRouterModelRouting(body, modelID) is non-empty or the body has any `plugins` (the "web" plugin passes
// openRouterModelRouting, free-model-catalog.ts:202-204, yet sends the query to a search provider).
export function zdrRequestBody(body: unknown, modelID: string): Record<string, unknown> | undefined

// packages/core/src/review/trivial.ts (VS-24)
export type TrivialKind = "whitespace" | "docs" | "rename" | "comment"
export type TrivialDecision = { trivial: true; kinds: TrivialKind[] } | { trivial: false; because: string }
export function classifyTrivial(files: readonly DiffFile[], input: {
  sensitive: (path: string) => boolean
  comments?: (path: string, side: Side) => readonly { start: number; end: number; text: string }[] | undefined // VS-25a
  referencesOldPath?: (oldPath: string) => boolean // `git grep` of the head tree-ish for a renamed file's old path
}): TrivialDecision

// packages/core/src/review/dispatch.ts (VS-24)
export interface PassPlan { pass: string; model: string; promptTokens: number; maxSteps: number; price?: ReviewPrice }
export interface DispatchEstimate { firstTurnTokens: number; inputTokens: { low: number; high: number }; outputTokens: number; usd?: { low: number; high: number } }
export function estimateDispatch(passes: readonly PassPlan[]): DispatchEstimate // reuses estimateCostUsd and nextStepCostUsd
export type DispatchDecision = { go: true } | { go: false; shrink: true } | { go: false; stop: "budget-estimate" }
// Decides on the low estimate (or a median calibrated on replay data, once one exists) and on first-turn tokens.
// The high estimate goes only into the note: its growth term alone exceeds the default caps (VS-24).
export function decideDispatch(e: DispatchEstimate, limits: { maxInputTokens: number; remainingUsd?: number }): DispatchDecision

// packages/core/src/review/impact.ts (VS-25b)
export interface Definition { path: string; name: string; kind: string; start: number; end: number; exported: boolean; signature: string }
export interface Reference { path: string; line: number; name: string; enclosing?: string; importsChanged: boolean }
export interface ImpactSlice { changed: Definition[]; dependents: (Reference & { rank: number; window: string })[];
  tests: string[]; unsupported: string[]; tokens: number; ms: number
  locations: string[] } // "path:line" of every block included, so slice recall can be computed from artifacts

// packages/core/src/review/risk.ts (VS-28)
export interface RiskFeatures { added: number; deleted: number; files: number; dirs: number; entropy: number;
  sensitive: boolean; testDelta: number; churn?: number; fixCommits?: number; dependents?: number }
// churn and fixCommits need history that CI does not fetch by default; dependents needs the VS-25 slice.
export function riskOf(f: RiskFeatures): { band: "low" | "medium" | "high"; reasons: string[]; missing: string[] }
// riskOf never feeds Selection.risk or the sticky header's "Risk:" (select.ts:122-141, format.ts:663).

// packages/core/src/review/guardrail.ts (VS-27b)
export interface StrictFinding { id: string; class: FailureClass; mechanism: FailureInfo["mechanism"]; path: string; line: number; endLine?: number; side: Side;
  title: string; trigger: string; impact: string; quotes: Quote[];
  fix: { kind: "suggestion" | "patch" | "unchecked"; text: string }; verifiedBy: "model" | "runtime"; verifier: string }
export type StrictDrop = "unverified" | "verdict-unreadable" | "out-of-scope" | "not-blocking" | "anchor" | "quote-mismatch"
  | "no-impact" | "no-fix" | "duplicate" | "cap"
export interface StrictResult { version: 1; head: string; complete: boolean; incomplete?: string[]; findings: StrictFinding[];
  dropped: { reason: StrictDrop; count: number }[]; fixUnchecked: number }
export function strictSelect(findings: readonly Finding[], input: StrictInput): StrictResult

// packages/core/src/review/runtime.ts (VS-30)
export interface RuntimeEvidence { command: string; side: "head" | "base"; exit: number; ms: number; runs: number;
  coverage?: { path: string; changed: number; covered: number }[]; reproducerFor?: string }
// Only "confirmed" changes anything (it sets verifiedBy: "runtime"). "contradicted" is recorded as evidence and never
// drops, downgrades or un-verifies a finding, because the code under review controls its own test results (I-2).
export function runtimeVerdict(head: readonly RuntimeEvidence[], base: readonly RuntimeEvidence[]): "confirmed" | "inconclusive" | "contradicted"
```

**Types that change**, each in one place:
- `Finding` gains `verifiedBy?: "model" | "runtime"`; `verified` stays `boolean`. Widening `verified` to `boolean | "runtime"` would silently change every `=== true` check: `github-payload.ts:39`, `select.ts:374,386`, `eval.ts:604`, `ai-review.ts:1766` and `script/vectorscope-eval/desktop.ts:179`. Its other consumers are `diff.ts:418-424` (`suggestionAllowed`), `select.ts:335`, `format.ts:316`, `eval.ts:146`, `run.ts:747`, `ai-review.ts:980,1250,1779`, `github.review.ts:737` (which passes it to `suggestionAllowed`) and `pull-requests.tsx:489`; a runtime confirmation sets both `verified: true` and `verifiedBy: "runtime"`.
- `ReviewOutcome.partial` (`types.ts:186`) and `run.ts`'s `Stop` (`run.ts:131`) gain `"privacy"` and `"budget-estimate"`.
- `ReviewOutcome.specialists[].name` and `ReviewPass.name` (`types.ts:189,202`), and with them `run.ts`'s `Name` (`run.ts:130`), widen once to add `"lens"` (with a `lens?: string` field) and `"repro"`, together with codium's `"judge"` (`codium:packages/core/src/review/types.ts:199,214`), so the codium merge does not conflict twice.
- `ReviewOutcome` gains `strict?: StrictResult`.
- `RunInput` (`run.ts:90-126`) gains `forceFull?: boolean`, set only by `review-full`, and a projection hook (VS-21b).

### 1.3 When each stage reaches each surface

"Wiring" means the runner-wiring window of §5.

| Stage | CLI | GitHub job | Desktop |
|---|---|---|---|
| Route (VS-23) | with wiring | with wiring, inside `Review.run`. Without a configured model, resolution in CI still picks the free fallback (the job passes no privacy to it); `Review.run` then refuses that model and stops with `privacy`. Skipping the fallback inside resolution waits for the @vector merge | through a global `review.privacy` enforced in the engine server (VS-23d); per project after VS-10 |
| Trivial (VS-24) | with wiring | after the @vector merge, through `decideSkip` state. Before that, a zero-attempt outcome would be posted as "No issues found" and recorded as a reviewed head (`github.review.ts:900-956`) | with wiring, in `ai-review.ts` |
| Budget estimate and token caps (VS-24) | with wiring | with wiring: a `budget-estimate` stop is a `partial` outcome with every file unreviewed, so the job's existing `notePartial` banner shows (`github.review.ts:912-925`), and the summary says "Not reviewed" (format change in VS-24) | token estimate with wiring; dollar admission after VS-10 |
| Impact (VS-25) | with wiring | with wiring, computed inside `Review.run` | after VS-10 |
| Cards (VS-26) | with wiring | after VS-11 | after VS-10 |
| Guardrail (VS-27) | with wiring | with wiring | with wiring (parse check engine-only until VS-10) |
| Depth and lenses (VS-28) | with wiring | with wiring; history features are often missing in CI | after VS-10 |
| Cross-family verifier (VS-29a) | works today through `triageModel`/`model` | works today | works today |
| Runtime (VS-30) | after `self-evolving`, VS-12 and VS-18 | unprivileged job after the @vector merge | after VS-10 and VS-12 |

Until VS-10, these gaps are documented intentional differences (`vectorscope-plan.md:320`). For any key the desktop eval adapter cannot apply, it records `variant.applied: false`.

## 2. Invariants

| # | Invariant | Source | Enforced by |
|---|---|---|---|
| I-1 | **Off by default.** With every new key unset, each runner sends byte-identical requests and returns identical outcomes to that runner before the package. A default changes only through VS-31, after a held-out D2 pass and owner approval. | D2, D3 | parity tests |
| I-2 | **Untrusted text never decides.** PR title, body, comments, diff, commit messages and trailers, branch names, model output, MCP data, test and coverage output, Brain cards and knowledge pages never choose an invocation field (privacy, models, depth, lenses, runtime, verifier or authorship) and never act as a verdict. They stay data in wrapped, escaped blocks, with trusted instructions last (`prompt.ts:180-191,440-453`). | plan | adversarial cases (VS-22), prompt tests |
| I-3 | **Privacy fails closed.** Under `zdr`, every outbound model request of a `vectorscope.*` session, of any kind (turn, finalizer, retry, verify, lens, repro, compaction, title) and on every transport (the generic V1 fetch, the Codium plan route, the free-model route, the native LLM runtime), is either refused before sending or sent with ZDR routing to a loopback server or an attested destination. No free-model fallback; no router, preset, fallback-model or plugin fields; no Batch; no model that requires retention; no unattested direct provider, OpenRouter account or network server. A refusal stops the review with a note and is never retried on another model. ZDR reduces retention; it cannot rule it out: provider safety flags (Anthropic may keep flagged content up to 2 years), legal holds and account settings Vector cannot see remain, and the notes say so. | owner (1) | recording-fetch and fake-server tests on every transport |
| I-4 | **Existing privacy rules hold.** No model that may train on prompts sees private code (D6). Personal Brain items go only to models that do not train (and, under `zdr`, only on a ZDR or loopback route), and never into shared or posted reviews. Everything leaving the machine passes redaction and the posting guard. **The guard does not fail closed today:** it follows lineage to depth 3 and 200 sessions, silently cuts the list at those bounds, and treats a failed child lookup as no children (`posting.ts:14-25,71-83`); the GitHub job passes no session IDs to it at all (`github.review.ts:1192-1193`). Before fan-out grows (VS-28 lenses, VS-30 repro), `posting.ts` must refuse when the lineage is cut short or a lookup fails; before cards reach CI, the GitHub check must receive `outcome.sessions` (after the @vector merge). | D6, plan | knowledge and posting tests |
| I-5 | **Budget.** Every provider attempt is admitted. Pre-dispatch estimates gate dispatch but are described only as estimates. Token caps cover free, plan and local models. Zero-token paths make zero attempts. The eval never retries a paid attempt on its own. | plan, `run.ts:1-5` | observer tests (`RunInput.observe`) |
| I-6 | **Execution.** Review mode runs no project code except through the existing opt-in local `--checks` (own branch only, never with `--pr`, with a confirmation when others authored commits; `review.ts:349-359,750-751`; `permission.ts:24-40,75-84`). New runtime checks extend that one consent path; they do not add a second. Each run needs per-operation consent (D10), single-use and bound to the head SHA and the command digest, in an isolated worktree with the network off, a clean environment with no provider keys or tokens, and writes only inside the worktree. Never for `--pr`, fork or untrusted code, never in a job that holds secrets or write tokens. If isolation or network filtering is unavailable, the review reports that checks did not run. | D10, plan | VS-30 refusal tests |
| I-7 | **Honest coverage.** Tier 1 never silently drops changed lines; files over the budget are listed as not reviewed. If a specialist, the verify pass or the guardrail does not finish, or a verify verdict cannot be read, the review is never shown as clean. Zero-attempt stops (`privacy`, `budget-estimate`) are reported as "Not reviewed", never as "No issues found", and do not record the head as reviewed. `StrictResult.complete` separates "nothing verified" from "not finished". | plan, VS-19 | guardrail, format and run tests |
| I-8 | **Safe parsing.** Grammars are exactly pinned engine dependencies, loaded lazily. Nothing is loaded from the reviewed repository. Grammar files and input files have separate size caps, and each parse has a time limit. Forks are read with `git show` or `git grep` of the head tree-ish, never checked out. | VS-17, plan | parse tests |
| I-9 | **Ownership.** No edits to @vector-owned files before the merge; after it, only together with the @vector owner. | D1 | review checklist |
| I-10 | **Reuse, don't rebuild.** From `self-evolving`: TaskIsolation, `subagent-model.ts`, `json-schema-check.ts`, `audience.ts`. From `codium`: `labOf`, `second-lab.ts` (`reviewModels`, `checkedLabs`), `panel`, `judgeModel`. From `main`: Run Guard, `nextStepCostUsd`, `estimateCostUsd`, Brain search, `BrainGraph.rank` (already exported, `graph.ts:91`), `BrainCode.imports`/`resolve`. | D13 | review checklist |
| I-11 | **Dependency direction.** Schema, then Core and Protocol, then Server. The renderer never imports the engine runtime. The engine stays Node-compatible. Protocol and config-schema changes regenerate the client and the SDK. | AGENTS.md, plan | typecheck |
| I-12 | **Evidence scope.** New keys go into `EVIDENCE_POLICY_KEYS` or `EvidenceScope`, with default-stable digests (§0.3). `canonicalPrompts` covers new sections and strict schemas. Every package updates the pin. | VS-07 | `model-evidence.test.ts` |
| I-13 | **Eval discipline.** Dry runs only until D7; the D5 pilot limits; permissive licences only (D8). The held-out split is frozen before any VS-24–30 prompt tuning. Labels and fixes never reach tools, retrieval or a Brain index. Dataset code is never run to label it. Results are sealed and stay internal; no accuracy or comparative claims (D12). | D5, D7, D8, D12 | ci and report tests |
| I-14 | **Release.** Nothing user-facing in 1.99.113. `vector review --json` already exists (`review.ts:1236`); StrictResult goes inside its outcome behind the key, with no new flag. Runtime checks extend `--checks`, with no new flag. The global `review.privacy` setting and its UI ship hidden until the owner decides it is not user-facing (Q16). No new GitHub App permissions. MCP stays default-deny. No plan gating. | D4, D9, D11, D14 | release checklist |

## 3. Integration map

| File | Change | Package |
|---|---|---|
| `packages/core/src/review/types.ts:1-60,160-202,211-283` | new keys and defaults; `FAILURE_CLASSES`, `FailureInfo`, `Quote`; strict-schema fields on `ModelFinding`; `Finding.verifiedBy`; `ReviewOutcome.partial` and `.strict`; pass-name unions widened once | 23–31 |
| `packages/core/src/review/config.ts:77-222` | source-tagged merge (privacy raise-only; trusted-only keys); env vars; the `precise` preset | 23a, 24–31 |
| `packages/core/src/review/model-evidence.ts:32-74,224-258` | policy keys; `EvidenceScope.route`; default-stable digests; canonical prompts and strict schemas; pin | each |
| `packages/core/src/review/skip.ts:11-21` | `SkipReason` adds `trivial` (types only); wired into `decideSkip` only after the @vector merge | 24 |
| `packages/core/src/review/prompt.ts:50-78,231-305` | `<untrusted_impact>`, `<untrusted_context_cards>` and `<untrusted_runtime_evidence>` blocks; strict task text; lens prompts | 25–30 |
| `packages/core/src/review/schema.ts:27-92` | strict report schema (`failure`, `quotes`, `patch`) and `STRICT_RESULT_JSON_SCHEMA` | 27a |
| `packages/core/src/review/select.ts:153-393` | hands off to `strictSelect` after placement; export `sameFinding` (private today, `:393`) | 27b |
| `packages/core/src/review/diff.ts:414-437` | patch-application helper for S6 | 27b |
| `packages/core/src/review/plan.ts:18-210` | lens planning; export `OUTPUT_PER_STEP` (private today, `:29`); calibration input for estimates | 24, 28 |
| `packages/core/src/review/permission.ts:24-87` | export `CHECK_COMMANDS` (private today, `:27`); coverage-command allowlist per test runner | 30 |
| `packages/core/src/review/format.ts` | notes: route refused, trivial, budget stop, depth reasons, runtime not run, strict result empty or incomplete; "Not reviewed" instead of "No issues found" when every file is unreviewed | 23–30 |
| new `packages/core/src/review/{privacy,trivial,dispatch,impact,risk,guardrail,runtime}.ts` | the contracts in §1.2 | 23–30 |
| `packages/core/src/brain/code.ts:473-500` | workspace-package and tsconfig path-alias resolution in `resolve`, used by Tier 1 | 25b |
| `packages/core/src/free-model-catalog.ts:198-233` | reuses `openRouterModelRouting` and `denyDataCollection`; no change | 23 |
| `packages/core/src/session/runner/model.ts:308-330` | no change here: review sessions are V1, V2 execution has no admission policy (`admission.ts:33`), and V2 `prepare` has no session ID. The V2 check moves to VS-10 | — |
| `packages/engine/src/provider/provider.ts:2330-2420,2502-2618` | at the top of `resolveSDK`, before the plan and free-model branches (which return before the generic wrapper exists), refuse a `zdr`-registered session's model that the route rules refuse; in the generic fetch, apply `zdrRequestBody` to the final body (after main's `promptCacheBreakpointBody`, against `requestInput`, `:2505-2525`) or throw before sending; refuse a body that is not a string or sits inside a `Request`, and a malformed `x-session-id`, while a `zdr` review is active | 23c |
| `packages/engine/src/session/llm.ts:322-377` | the native runtime is not selected for `zdr`-registered sessions | 23c |
| new `packages/engine/src/review/route.ts` | `ReviewRoutes`: a session-ID-to-policy map registered by `Review.run`, falling back to: internal is `vectorscope.*` and the global `review.privacy` is `zdr` | 23b |
| `packages/engine/src/review/model.ts:47-182` | route check for the review, triage and alternate models; no free fallback under `zdr` when the caller passes privacy (CLI and desktop now, GitHub after the merge); `local` keeps its pricing meaning (it includes LAN servers, `:141-143`) but grants nothing under `zdr`; `subject.choice` | 23b, 29b |
| `packages/engine/src/review/run.ts:90-131,224-269,378-593,644-756` | `RunInput.forceFull` and projection hook; register sessions; route check in `admit` and before session creation; trivial and budget checks; impact slice; lenses; guardrail; repro sub-pass | 21b, 23b–30 |
| `packages/engine/src/review/context.ts:28-273` | `cards` gatherer (`links`, `search`) for the CLI | 26 |
| new `packages/engine/src/review/{parse,impact,author,runtime}.ts` | parser; slice builder called from `Review.run` (greps the head tree-ish, as `relatedCode` does, `context.ts:44-60`); trusted authorship; executor | 25, 29b, 30 |
| `packages/engine/src/session/posting.ts:14-83` | refuse when lineage is cut short or a lookup fails, with tests | VS-11, or before VS-28 lenses with the plan owner's agreement |
| `packages/engine/src/cli/cmd/review.ts:133-143,330-414,1236-1317` | cards dependency; notes; StrictResult inside the existing `--json` outcome; runtime evidence through `--checks` consent | 26, 27c, 30 |
| `packages/engine/package.json`, `licenses/dependencies`, `bunfig.toml` | exactly pinned grammar packages; licence entries; the 3-day `minimumReleaseAge`; binary-size check | 25a |
| the engine's global config schema (`packages/engine/src/config/`), generated `packages/sdk/js/src/gen/types.gen.ts`, `packages/client` | `review.privacy`; SDK and client regeneration | 23d |
| `packages/app/src/features/pull-requests/ai-review.ts` | base blob when a PR changes settings; parity for trivial and guardrail; notes | 23d, 24, 27c |
| `packages/engine/src/review/eval.ts:73-175,252-339,600-610` | artifact records every applied key, context locations, Tier 1 time, wall time per pass, shrink steps, cache reads and writes; Brain index from the base commit only (local eval) | 21a, 26 |
| new `packages/engine/script/vectorscope-replay.ts` | the in-process engine entry point for paid replays | 21c |
| `script/vectorscope-eval/{replay,report,ci,dataset,run}.ts`, `packages/core/src/review/eval-report.ts`, `.github/workflows/vectorscope-eval.yml` | variant registry, projection driver, metrics, CI inputs, mirror-fetch step | 21, 22 |

## 4. Work packages

### Existing packages re-scoped

| Package | Change |
|---|---|
| VS-17 | Superseded by VS-25 (VS-17 with an explicit Tier 1 contract), pending owner sign-off. Do not build both. |
| VS-18 | Keeps offline secret scanning and pinned linters, and its rule that runner isolation is a prerequisite for executing project code. Its half that runs project code moves to VS-30. |
| VS-19 | Unchanged. It batches by VS-25 impact clusters and VS-28 depth once both exist. |
| VS-06 | VS-27 depends on its `verifyPolicy: "shared"`. |
| VS-07 | VS-23 and VS-29 extend its scope. It never chooses, refuses or replaces a model (`model-evidence.ts:10-12`); VS-29b's inversion is a separate opt-in that names itself in notes. |
| VS-08 | The new invocation fields (privacy, attestations, depth, lenses, runtime consent, authorship) are shaped so VS-08's `review/invocation.ts` can adopt them unchanged. This contract does not create `invocation.ts`. |
| VS-10 | Takes over the V2 transport check and the desktop halves listed in §1.3. |
| VS-11 | Becomes the prerequisite for Brain cards in CI, and the natural home of the fail-closed `posting.ts` change (I-4). |
| VS-12 | VS-30 reuses its consent contract. |
| VS-20 | Its rollout flags carry VS-31's `mode`. |

### VS-21 Eval readiness for the upgrade

Split into three, landed in order. **Behaviour change:** none. **Depends on:** VS-01 to VS-04, and P0.

**VS-21a Variant registry and artifact fields** (now)
- **Files:** `script/vectorscope-eval/replay.ts`, `report.ts`, `README.md`; `packages/engine/src/review/eval.ts`.
- **Implementation:**
  1. An explicit registry that maps each canonical variant name to its config: `engine`, `engine:shared-verify` (today's name, from `${verifyPolicy}-verify`, `replay.ts:94-103`), `engine:privacy-zdr`, `engine:trivial-skip`, `engine:impact-graph`, `engine:cards-brain`, `engine:guardrail-strict`, `engine:depth-auto`, `engine:lenses-high`, `engine:cross-family` and `engine:precise`, plus aliases for any old name. Names never embed model IDs and never contain `=`, which separates a variant from its model in `report.ts --candidate` and `--baseline`. A sorted-key rule is not used, because it would not produce the names above.
  2. The artifact records every key the run applied (replacing today's `variant?: { verifyPolicy }`, `eval.ts:160-163`), and adds:
     - the context locations included (`path:line` per block), joined with labels offline only;
     - Tier 1 time, and wall time per pass;
     - each budget shrink step;
     - cache reads and writes per pass (from `ReviewPass.cacheRead`).
- **Tests:** `replay.test.ts` (names round-trip; old names still resolve); engine `test/review/eval.test.ts` (artifact fields).

**VS-21b Projection** (now)
- **Files:** `packages/engine/src/review/run.ts` (`RunInput` hook), `packages/engine/test/fixture/` (a fake provider server, or the engine's existing one), `script/vectorscope-eval/replay.ts`.
- **Implementation:**
  1. `RunInput` gains a projection hook. Today `RunInput.observe` only watches, and the admission policy is built inside `ask` (`run.ts:429`), so nothing can replace it.
  2. A projection runs `Review.run` against a fake local provider server that returns canned `StructuredOutput` reports *with findings*. Every pass then runs, including verify (whose candidates come from findings, `run.ts:693-702`), lenses, the guardrail and repro, and every retry. The projection records each pass's real wire body and its estimated tokens and dollars (from `estimateCostUsd` and the price snapshot). A projection in which every attempt is refused would never build the verify, lens or repro prompts and would undercount cost.
  3. Network off: `VECTOR_DISABLE_MODELS_FETCH` and the other catalog flags, so booting providers fetches no free, plan or model catalogs; a dummy key for model resolution.
- **Tests:** a projection makes zero outbound requests on a recording fetch; every pass's body is recorded.

**VS-21c Paid entry point and CI** (now; stays unexercised until D7)
- **Files:** new `packages/engine/script/vectorscope-replay.ts`; `script/vectorscope-eval/ci.ts`, `report.ts`; `packages/core/src/review/eval-report.ts`; `.github/workflows/vectorscope-eval.yml`.
- **Implementation:**
  1. The engine runtime entry point lives under `packages/engine` and runs from that directory, because the eval scripts import only engine *types* today and their `@/*` path maps to both the engine's and the app's sources for typecheck only (`script/vectorscope-eval/tsconfig.json`). It boots the engine in-process, as the engine tests do (`VECTOR_PURE`, `VECTOR_DISABLE_PROJECT_CONFIG`, the provider from `VECTOR_CONFIG_CONTENT` with the key from `VECTORSCOPE_EVAL_API_KEY`), prepares each checkout with `prepareCheckout`, admits each case through `admitReplay`, and runs `ReviewEval.replay`. The script driver keeps to type imports and spawning.
  2. It is dry by default and sends only under `run.ts`'s rules: budget flags, positive prices, `GITHUB_ACTIONS=true` and `VECTORSCOPE_EVAL_ENVIRONMENT=vectorscope-eval`. It is not a user-facing command (D14).
  3. `ci.ts` takes `PIPELINE` (`smoke` by default, or `replay`) and `VARIANTS`, and validates both. The workflow gains matching inputs and a step that fetches the dataset mirrors `prepareCheckout` needs (the seed cases are real repositories). Outputs stay sealed.
  4. Report metrics:
     - cost per review (mean, median, p90; USD and tokens; admitted attempts only; judges excluded);
     - wall time per pass and end to end (p50, p90);
     - zero-token rate;
     - route refusals;
     - estimate error;
     - class-scoped recall and cross-file recall;
     - trivial controls reported separately from behaviour-preserving controls.

     The report also loads desktop artifacts, closing a Phase 1 review note.
- **Tests:** `ci.test.ts`, `report.test.ts`; core `test/review/eval-report.test.ts`; engine tests for the entry point: refuses outside the protected environment; dry by default.
- **Done (VS-21 as a whole):** a dry `ci.ts plan` with `PIPELINE=replay` projects every seed case for `engine` and `engine:shared-verify`; the paid path exists and stays unexercised until D7.
- **Measurable goal:** the projection covers seed cases × 2 variants with 0 outbound requests, and records a wire body for every pass; the report renders the new metrics on synthetic artifacts.

### VS-22 Dataset for the upgrade

**When:** now. Agents annotate in their sessions, with no eval key. The owner adjudicates disagreements (D8). **Depends on:** VS-01.

**VS-22a Schema and tests**
- **Files:** `script/vectorscope-eval/dataset.ts`; `annotation-guide.md`; `judging-rubric.md`; `fixtures.test.ts`.
- **Implementation:**
  - New labels:
    - `failureClass`: one of the five classes, or `other`;
    - `mechanism`;
    - `crossFile`;
    - `runnable`: whether the repository's tests ran at the base commit, taken from the base commit's recorded public CI status. Nothing in the dataset is run to set it (I-13); VS-30's sandbox can confirm it later;
    - optional `authoring`: family and source.
  - A new control kind, `trivial`, with a `trivialKind`.
  - The rubric defines the five classes and "production-breaking", including the leak scope (Q4).
  - Record the sampling rule and every exclusion before any results come in.
- **Tests:** the class enum; trivial controls carry no defect label; cross-file cases name locations in at least two files; adversarial cases stay out of the quality rates.

**VS-22b Curation, in batches**
- **Targets:**
  - at least 100 bug cases, with at least 12 per failure class, at least 30 cross-file and at least 15 `runnable`;
  - at least 25 behaviour-preserving controls;
  - at least 20 trivial controls, split separately, plus trivial-*looking* bug cases (a comment directive, an indentation change in Python, a rename that breaks an import);
  - at least 10 adversarial cases, including PR text that claims an authoring model or asks for a reviewer;
  - MIT, Apache or BSD licences only.
  - These sizes are not enough to decide D2 on the held-out split (§6.2); Q14 asks whether to grow the held-out split.
- **Done:** `manifestProblems` is empty; both passes are recorded and every disagreement adjudicated; the held-out split is frozen, with its digest recorded, **before** any VS-24 to VS-30 prompt tuning.
- **Measurable goal:** the coverage targets are met, and Cohen's kappa between the two passes on `failureClass` is reported.

### VS-23 ZDR-only routing

Split into four. **Later halves:** per-project desktop policy after VS-10; the Codium route after `codium` merges with an `exactTagWithZdr` acceptance (`codium:api/_lib/codium-reservations.ts:83-97`).

**VS-23a Pure route rules and source-tagged config** (now)
- **Files:** new core `review/privacy.ts`; core `types.ts`, `config.ts`, `format.ts`, `model-evidence.ts`.
- **`decideRoute` rules:**

  | Destination | Decision |
  |---|---|
  | A loopback server (127.0.0.0/8, ::1, localhost), checked again at the fetch layer | allowed |
  | A LAN or company model server (counted as `local` for pricing, `model.ts:141-143`) | refused: `unattested-network-server`, unless its host is in `zdrAttested` |
  | OpenRouter, paid model, account listed in `zdrAttested` (the owner attests the account's ZDR guardrails, logging off and safety retention disallowed) | allowed, with the ZDR body |
  | OpenRouter, account not attested | refused: `unattested-openrouter`. `zdr: true` can still reach safety-retention endpoints unless the account disallows them, BYOK `declared_zdr` is self-declared, and workspace logging cannot be checked from the client [enablers §1.2] |
  | A `:free` id or a free catalog model | refused: `free-model` |
  | An `openrouter/*` or `@preset/` id | refused: `router-or-preset` |
  | Routing fields in the body (`openRouterModelRouting`) | refused: `fallback-models` |
  | Any `plugins` in the body | refused: `plugins` |
  | A direct provider listed in `zdrAttested` | allowed |
  | Any other direct provider | refused: `unattested-provider` |
  | Fable or Mythos | refused: `retention-required-model` (they need 30-day retention unless Anthropic expressly authorizes ZDR for the organization) |
  | Plan or Codium | refused: `codium-unaccepted` |
  | Anything else | refused: `unknown-destination` |

- **Config:** the source-tagged merge of §1.1.
- **Tests:** new core `test/review/privacy.test.ts`: every rule; other provider fields survive the merge; no `require_parameters` is added; privacy is never lowered. `config.test.ts`: raise-only merge; trusted-only keys refused from the environment and the working tree; desktop base-blob rule.

**VS-23b Admission and model resolution** (with wiring)
- **Files:** new engine `review/route.ts`; engine `review/model.ts`, `review/run.ts`.
- **Implementation:**
  1. `Review.run` registers each session it creates with `ReviewRoutes`.
  2. Model resolution (`model.ts`), when the caller passes the privacy setting (CLI, desktop): under `zdr`, check the review, triage and alternate models, and skip the CI free fallback (`model.ts:80-86`). A refusal becomes a typed error, which turns into a zero-attempt outcome with `notePrivacyRefused`.
  3. Inside `Review.run`, on every surface: refuse any model or attempt whose route is not allowed, in `admit` and before session creation (§1). The outcome is `partial: "privacy"` with every file unreviewed. This covers retries, finalizers, verify, lenses, repro and any switch of model.
- **Tests:** engine `test/review/model.test.ts` (no free fallback under `zdr`); `run.test.ts` (refusal on a retry, the finalizer and the verify pass, with zero attempts sent; the free fallback a GitHub-shaped call resolves is refused inside `Review.run`).

**VS-23c Transport backstop** (with wiring)
- **Files:** engine `provider/provider.ts`, `session/llm.ts`.
- **Implementation:**
  1. At the top of `resolveSDK`, before the plan (`planID`) and free-model branches, which return their own fetch before the generic wrapper exists (`provider.ts:2343-2415`): a `zdr`-registered session's model that the route rules refuse is refused there.
  2. In the generic V1 fetch: apply `zdrRequestBody` to the final body, after main's `promptCacheBreakpointBody` and against `requestInput` (`provider.ts:2505-2525`), or throw before sending. Today's OpenRouter check parses only string bodies (`provider.ts:2534`); under an active `zdr` review, a body that is not a string or sits inside a `Request` is refused.
  3. **Attribution.** Every session request carries `x-session-id` by construction (`provider.ts:2330-2341`); a request with none is the owner's own non-session call (for example generating an agent from the terminal) and is left alone. A *malformed* header names no session that can be checked, so it is refused while a `zdr` review is active in the process. A test proves that every `vectorscope.*` request kind carries a parseable header.
  4. The native runtime (`flags.experimentalNativeLlm`, `session/llm.ts:322-377`) sends through `@vectordevai/llm`, not `options.fetch`, so it is not selected for `zdr`-registered sessions.
  5. Prove with tests that no title, memory, compaction or other helper request is sent for a `vectorscope.*` session under `zdr`; suppress any that are.
- **Tests:** new engine `test/provider/zdr-route.test.ts`, one case per path: the generic fetch (`provider.zdr: true`, `data_collection: "deny"`, no routing or plugin fields), the plan route, the free-model route, the native runtime, compaction, a non-string body, a body inside a `Request`, a malformed session header, an unattested provider (throws before the fetch), a LAN proxy `baseURL` (refused); requests from unregistered sessions are byte-identical to today's.

**VS-23d Desktop global setting** (with wiring)
- **Files:** the engine's global config schema; generated SDK and client; app `ai-review.ts`.
- **Implementation:** a global `review.privacy` that the engine server enforces for every `vectorscope.*` session, so the desktop's reviews are covered; the desktop reads the base blob when a PR changes `review.json`; notes. Regenerate with `./packages/sdk/js/script/build.ts` and `bun run generate` in `packages/client`. The setting ships hidden until Q16 is answered (D14).
- **Tests:** app `ai-review.test.ts`; a desktop-shaped review under the global setting is refused on an unattested route.

**Owner setup for the eval key**, documented in the README: the `enforce_zdr_*` guardrail on the key; I/O logging and data-discount logging off; safety retention disallowed; then `openrouter` in the eval config's `zdrAttested` (Q7). Pinning requests to endpoints that do not keep flagged prompts (metadata from `GET /api/v1/endpoints/zdr`, then `provider.only`) is a follow-up, once OpenRouter's docs can be read.

- **Done:** I-1 and I-3 hold on every transport.
- **Measurable goal (Phase A):** on the fake provider server, every request kind of every dataset case under `engine:privacy-zdr` carries a compliant wire body or is refused before sending: 0 non-compliant requests. The deviations entry holds a route audit of the D6 candidates (which have an attested ZDR route at all). Quality on the ZDR route is not measured in the pilot, which holds the route constant (§6.5); it needs a funded ablation or Phase C (Q9).

### VS-24 Zero-token gate and pre-dispatch budget

- **When:** with wiring. The GitHub trivial skip waits for the @vector merge (`decideSkip` state).
- **Files:**
  - new core `review/trivial.ts` and `review/dispatch.ts`;
  - core `types.ts`, `config.ts`, `skip.ts` (types only), `format.ts`, `plan.ts`;
  - engine `review/run.ts`;
  - engine `cli/cmd/review.ts`;
  - app `ai-review.ts`.
- **Implementation:**
  1. **Trivial skip** (`trivial: skip`). A change is trivial only if every file is one of:
     - **whitespace-only:** trailing whitespace, line endings or blank lines only, outside string literals (by parser tokens), and never in an indentation-sensitive file (Python, Makefile, YAML, CoffeeScript, Haskell and similar);
     - **docs-only:** an allowlist of `.md`, `.rst` and `.adoc`, excluding agent-instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot instructions), `.vector/**` and `.github/**`. Never `.txt` or `.mdx`, which `DOC_EXTENSIONS` includes (`ignore.ts:109`); `isSensitivePath` returns false for every doc extension (`ignore.ts:133`), so it does not protect `requirements.txt`, `CMakeLists.txt` or executable MDX;
     - **rename-only:** a non-code file, or a code file whose old path a `git grep` of the head tree-ish no longer finds and whose rename leaves test globs and migration order unaffected; never a case-only rename;
     - **comment-only:** only with VS-25's parser comment ranges, minus a denylist of directives and doctests: `@ts-ignore`, `@ts-expect-error`, `@ts-check`, `@ts-nocheck`, `eslint-disable*`, `prettier-ignore`, `//go:build`, `// +build`, `//go:generate`, `//go:embed`, `# type: ignore`, `# noqa`, `# pragma`, Rust `///` and `//!` doctests, Python doctests, shebang and encoding lines, and licence headers.
  2. **Never trivial:**
     - anything `isSensitivePath` matches (`ignore.ts:84-142`);
     - CI and workflow files; Dockerfiles; infrastructure-as-code;
     - dependency manifests and lockfiles (Q11);
     - JSON, YAML, TOML and INI config;
     - SQL and migrations.
  3. `Review.run` returns an outcome with zero attempts and a note. Only `RunInput.forceFull` (set by `review-full`) bypasses the skip; `mode: "full"` does not, since first reviews are full too. Replays of trivial controls use trigger `auto`, because `ReplayCase.trigger` defaults to `command` (`eval.ts:79-80`).
  4. **Pre-dispatch check**, before `run.ts:644`.
     - Build every planned pass's first prompt and estimate:
       - input tokens: characters divided by 3.5, the runner's existing rule (better: the serving provider's own count on an allowed route, or a calibrated local estimate, recounted per target model);
       - output tokens: `OUTPUT_PER_STEP` × steps;
       - dollars: `estimateCostUsd` for each pass, including verify (bounded at `max(4, 2 × maxComments)`), lenses and the guardrail.
     - **Decide on the low estimate** (or a median calibrated on replay data once one exists), and compare `maxInputTokens` with first-turn prompt tokens. The high estimate's growth term, 4,000·S(S−1)/2, does not depend on prompt size (`plan.ts:184-197`): at the default `maxSteps` of 30 it is about 1.74M input tokens per session and about 2.7M across review, security and verify, so a high-estimate trigger would fire on nearly every review at the $2 default and at the pilot's $0.75, and shrinking context cannot lower it. The high estimate goes only into the note.
     - When the trigger fires, shrink in this order and re-estimate after each step:
       1. drop lenses;
       2. drop cards;
       3. drop the lowest-ranked dependents;
       4. trim the diff to the changed hunks, with partial-coverage notes.
     - If the low estimate is still over, stop with `budget-estimate` and zero attempts, as a `partial` outcome with every file unreviewed. `format.ts` says "Not reviewed", never "No issues found".
     - Token caps also cover free, plan and local models.
     - Each shrink is recorded in the replay artifact.
     - `estimateCostUsd` was fitted on a single measured review (`plan.ts:23-31`); it must be recalibrated on replay data before this check leaves opt-in.
  5. **Cache layout and fan-out.**
     - A test pins the static prompt prefix as byte-identical across two cases.
     - The report shows each pass's cache-read and cache-write share.
     - The review and security specialists start in parallel today (`run.ts:644-657`), so each pays its own cache write unless fan-out waits for the first streamed response or the cache is pre-warmed. Try "start the second specialist after the first one streams" as a measured variant; keep cache diagnostics to development (Anthropic's diagnostics are only "qualified" under ZDR).
- **Tests:** new core `test/review/trivial.test.ts` (including a fixture for each trivial-looking bug: a directive comment, a Python indentation change, a `.mdx` component, a `requirements.txt` bump, an import-breaking rename, a case-only rename); `test/review/dispatch.test.ts` with the default `maxSteps`; engine `run.test.ts`: zero attempts on the observer for both stops, shrink notes, `forceFull`; app parity tests; a format golden for "Not reviewed".
- **Done:** I-1, I-5 and I-7 hold.
- **Measurable goal:**
  - Phase A (gate): **0 bug cases classified trivial**, including the trivial-looking bug fixtures, which are the gating test for this hard requirement; at least 80% of trivial controls skipped at 0 tokens; projected savings reported.
  - Pilot (descriptive): median absolute error of the estimate against settled cost, target at most 35%; coverage at or above 95% under the D5 per-case bound.
  - The gate leaves opt-in only with a measured false-skip rate of 0 on replay.

### VS-25 Tier 1 impact slice (supersedes VS-17, pending sign-off)

**When:** with wiring for the CLI and GitHub (through `Review.run`); the parser and slice modules can land now as uncalled new files. **Later halves:** the desktop after VS-10; Actions caching of parse facts after the @vector merge.

**Extractor decision.** VectorScope already has two regex readers: `review/symbols.ts` and Brain's `brain/code.ts`, whose `imports`, `dependencies` and `resolve` are pure functions that the desktop's file ranking also uses. Tree-sitter would make a third. Three readers would disagree about what a change touches and triple the upkeep, so:
- the file-level import graph comes from `BrainCode.imports` and `BrainCode.resolve`, extended with workspace-package and tsconfig path-alias resolution where its suffix matching is ambiguous;
- tree-sitter adds only what regex cannot do well: enclosing-definition spans, reference sites and comment ranges;
- tree-sitter replaces `review/symbols.ts` where a grammar exists; `symbols.ts` stays only as the fallback for other languages.

**VS-25a Parser and grammars**
- **Files:** new engine `review/parse.ts`; `packages/engine/package.json`; `licenses/dependencies`.
- **Implementation:**
  1. Keep `web-tree-sitter` at 0.25.10; `tool/shell.ts` loads `web-tree-sitter/tree-sitter.wasm` (0.27.x renamed it to `web-tree-sitter.wasm`). Bumping is a separate decision, with the specifier change.
  2. Add exactly pinned grammar packages that ship `.wasm` files for TS/TSX, JS, Python, Go, Rust and Java: per-language npm packages or `@vscode/tree-sitter-wasm`, never `tree-sitter-wasms` (its Rust and Java grammars failed to load in our test). Verify that each loads under 0.25.10 (ABI 13–15). Respect `bunfig.toml`'s 3-day `minimumReleaseAge`, add licence entries under `licenses/dependencies`, and check the binary-size growth.
  3. Separate caps: grammar files up to a fixed size per grammar (the TSX grammar is 1.4 MB, so 4 MB), input files up to 1 MB, plus a per-file parse timeout. Discard trees after extraction (all trees held took about 770 MB on this repository).
  4. Queries extract definitions, references and comments.
  5. Re-measure the throughput on 0.25.10 and on a non-TypeScript repository; the 4.8 s figure was measured on 0.27.1 and TypeScript only.
- **Tests:** new engine `test/review/parse.test.ts`: each grammar loads; timeouts; oversize files; syntax errors; nothing loaded from paths inside the repo.

**VS-25b The slice**
- **Files:** new core `review/impact.ts`; new engine `review/impact.ts`; core `brain/code.ts`; engine `review/run.ts`; core `prompt.ts`, `types.ts`, `config.ts`, `model-evidence.ts`.
- **Implementation:**
  1. Find the enclosing definition of each hunk at head, and at base for removed code.
  2. Find candidate dependents with `git grep -l -w -F` on changed exported names *of the head tree-ish*, as `relatedCode` does (`context.ts:44-60`), because in CI fork reviews the working tree is the merge-base. Cap at 200 files, with the ignore rules applied.
  3. Keep only references from files that import the changed module (the import-gated match, our proposal; enablers §2.7).
  4. Rank them with `BrainGraph.rank` (already exported, `graph.ts:91`).
  5. Pack signatures and call-site windows (3 lines either side) into at most 15% of the context, and at most 6k tokens.
  6. For unsupported languages, fall back to `changedSymbols` plus `git grep`.
  7. Add an `<untrusted_impact>` data block; order the diff by impact rank before `budgetDiff`; list files over the budget as not reviewed.
  8. Export comment ranges for VS-24, and record `ImpactSlice.locations` and `ms` in the artifact.
- **Tests:** new core `test/review/impact.test.ts`: renames, overloads, name collisions without an import, re-export depth, workspace and alias imports, generated files, deterministic ranking; engine context tests: forks read through the head tree-ish; `prompt.test.ts` and `model-evidence.test.ts`.
- **Done:** I-1, I-7 and I-8 hold.
- **Measurable goal:**
  - Phase A (gate), on cross-file cases: slice recall at least 10 points above `relatedCode`, at equal or fewer context tokens, computed from the artifact's recorded locations; Tier 1 time at p95 at most 5 s per case.
  - Pilot (descriptive): cross-file recall reported.

### VS-26 Brain context cards (at most three)

- **When:** with wiring, for the local CLI. **Later halves:** the desktop after VS-10; GitHub after VS-11.
- **Files:**
  - engine `review/context.ts`: a `cards` gatherer next to `requirements`;
  - engine `cli/cmd/review.ts:386-389,1302-1317`;
  - core `prompt.ts` (`<untrusted_context_cards>`), `types.ts`, `config.ts`, `model-evidence.ts`;
  - engine `review/eval.ts`.
- **Implementation:**
  1. **Candidates** come from two read-only Brain calls:
     - `BrainKnowledge.links` for the changed files (weight at least 0.6, with drift flags);
     - `search`, with changed symbols and paths as the query and a limit of 3.

     Not `brief`: it needs a session and a request ID, records the IDs it returns against them, and is sized for subagents (`knowledge.ts:616-631`; `BRIEF.subagents` is 4), while cards are gathered before any review session exists.
  2. **Selection.**
     - Dedupe by card id.
     - Rank cards anchored to the change above lexical hits, then by value.
     - Keep at most 3 cards, each at most 160 characters, at most 200 tokens in total.
     - Linked requirements count toward the three.
  3. **Personal items** are allowed only when the review is not shared, the model does not train on prompts and, under `zdr`, the route is ZDR or loopback.
  4. **Untrusted reviews** get only repository-scoped kinds.
  5. **The eval.** CI replays run under `VECTOR_PURE` with no Brain or local search model, so cards are measured in a local-only eval with a Brain seeded from the base commit's documents only.
- **Tests:** engine `test/review/knowledge.test.ts`; `prompt.test.ts`; a posting-guard test that checks a card quoted in a finding.
- **Done:** I-2 and I-4 hold.
- **Measurable goal:**
  - Phase A (local-only eval): 100% of runs within the limits; 0 personal items in shared reviews.
  - Quality: only through a funded ablation (Q9). Without a measured gain, the key stays off.

### VS-27 Tier 3 strict guardrail and JSON result

**Depends on:** VS-06. It uses VS-25's parser when that is present.

**VS-27a Types and schema** (now)
- **Files:** core `types.ts` (§1.2), `schema.ts`, `model-evidence.ts`.
- **Implementation:** the strict report schema (`failure`, `quotes` with side, `patch`) and `STRICT_RESULT_JSON_SCHEMA`; both enter `promptsDigest` only when `guardrail` is `strict`.

**VS-27b The guardrail** (now, pure)
- **Files:** new core `review/guardrail.ts`; core `select.ts`, `diff.ts`, `format.ts`.
- **Implementation:**
  1. **`strictSelect`** keeps a finding only when all of these hold:
     - **S1** It was verified, by the model or at runtime. A verify verdict that cannot be read leaves it unverified (drop `verdict-unreadable`), never "kept by default" (Kodus issue #1937).
     - **S2** It is blocking and its class is one of the five.
     - **S3** It is anchored on a changed line: a RIGHT-side added or modified line, the RIGHT-side line next to a deletion, or a LEFT anchor on removed code. Defects caused by deleting code (a removed guard or null check) are a common crash class.
     - **S4** At least one quote matches the file exactly, apart from whitespace: the head file for RIGHT quotes, the base file for LEFT quotes.
     - **S5** `impact` and `trigger` are present, each at most 400 characters.
     - **S6** It has a fix text. When the fix is a committable suggestion that meets the existing rules (`select.ts:327-337`, `diff.ts:414-437`), or a patch of at most 3 hunks that applies cleanly to head and, where the language is parseable, leaves the file parsing, it is posted as such. Otherwise the committable form is removed, the finding is kept with its fix shown as a plain diff block marked unchecked, and `fixUnchecked` counts it. Fixes for cross-file defects often lie outside the diff (C-14).
     - **S7** It is the only finding for its root cause: fingerprint, `sameFinding`, or the same class within 3 lines.
     - **S8** It falls within `maxComments`.
  2. **Completeness.** `complete` is false, with reasons, when any stage did not finish, coverage is partial, or any verdict was unreadable.
  3. **Wording of an empty result.**
     - Complete: "No verified production-breaking issues".
     - Incomplete: "Review incomplete". Never "clean".
- **Tests:** new core `test/review/guardrail.test.ts`: every drop reason; patch application; the parse check; dedup; empty and complete versus empty and incomplete; an unreadable verdict; deletion-only defects (LEFT anchor, base quote); a cross-file defect whose fix is in another file; a property test that every finding kept satisfies S1–S5, S7 and S8, and S6 in its unchecked form; `schema.test.ts` and `select.test.ts`.

**VS-27c Runner wiring** (with wiring)
- **Files:** engine `review/run.ts`, `cli/cmd/review.ts`; app `ai-review.ts`; `script/vectorscope-eval/report.ts` (`--reselect strict`).
- **Implementation:**
  1. Under `strict`: `shared` verify with `all`, `blocking` as the minimum severity, no nits. The prompts define the five classes and ask for a `failure` block and quotes on each blocking finding.
  2. GitHub: strict findings are posted through the existing path, and the sticky summary keeps its state marker.
  3. CLI: StrictResult goes inside the existing `--json` outcome (`review.ts:1236`), with no new flag.
  4. Desktop: same guardrail; S6's parse check is engine-only (the renderer cannot call the engine parser), a documented difference until VS-10.
  5. Artifacts record the candidates seen before the guardrail, so they can be re-selected offline.
- **Tests:** engine `run.test.ts`; app parity tests; `report.test.ts`.
- **Done:** I-1 and I-7 hold, and the JSON validates against `STRICT_RESULT_JSON_SCHEMA`.
- **Measurable goal:**
  - Offline, at zero cost (gate): re-select saved artifacts with S1 and S3–S8, leaving out the class rule because legacy output has no class and no quotes (so S4 checks only the anchored lines), and report how precision changes.
  - Phase C (decides): as part of `engine:precise` — precision at least 0.80; false alarms per behaviour-preserving clean PR at most 0.2; class-scoped recall within 5 points of `engine:shared-verify`; at least 90% of clean controls return an empty, complete result.

### VS-28 Risk-scaled depth and single-class lenses

- **When:** with wiring. The desktop half comes after VS-10. Lenses also need the fail-closed posting guard (I-4).
- **Files:**
  - new core `review/risk.ts`;
  - core `plan.ts`, `prompt.ts` (`buildLensPrompt`), `types.ts`, `config.ts`, `format.ts`, `model-evidence.ts`;
  - engine `review/run.ts`.
- **Implementation:**
  1. **Risk features** come from:
     - the diff;
     - the history gatherer (`context.ts:82-144`): fix density is the count of commits in the last 90 days matching `fix|bug|revert|hotfix`;
     - `isSensitivePath`;
     - the change in test files;
     - VS-25's count of dependents.

     Weights are additive and documented. The bands are low, medium and high, each with plain-language reasons. **History is often missing in CI:** the generated workflow checks out with `fetch-depth: 1` (`workflow.ts:211`) and the history gatherer reads only the last 5 commits per file (`context.ts:82-112`), while the eval fetches full head history. So `riskOf` records which features were available, CI computes the band without the history features unless the CLI fetches a bounded window, and a test checks that the band is the same across surfaces for the same inputs.
  2. **Depth by band, under `depth: auto`:**

     | Band | Passes |
     |---|---|
     | low | review; security only when a sensitive path changed |
     | medium | review and security |
     | high | review and security; with `lenses: high`, also four lenses: concurrency, resource, access, data-integrity |

  3. **Lenses.** Each lens has at most 5 steps and at most 4 findings, and runs on the review model. At most 3 run in parallel. Their findings are unioned, deduped, verified and then passed to the guardrail.
  4. **Limits.** Lenses are the first thing the budget shrink drops. A review has at most 8 sessions: review, security, verify, up to 4 lenses and repro (finalizers run inside their own session). Risk is never posted as a prediction, and `riskOf` never feeds `Selection.risk` or the header's existing "Risk:" (`select.ts:122-141`; `format.ts:663`).
- **Tests:** new core `test/review/risk.test.ts` (including missing-history inputs); `plan.test.ts`; engine `run.test.ts`: parallel runs, union, dedup, verify, notes, the session bound and the lineage bound.
- **Done:** I-1, I-4 and I-5 hold.
- **Measurable goal:**
  - Phase A (gate): band distribution, which features were available per surface, and projected cost per band, reported; low band projected at or below the baseline's cost.
  - Lenses: only through a funded ablation (Q9). For comparison, Kodus reports +0.10 to +0.17 recall at a precision change of -0.15 to +0.02 and 1.3–2.1x tokens (vendor eval), so lenses join `precise` only if `precise` still meets D2's 80% precision floor with them on.

### VS-29 Cross-family verifier (29a) and authorship inversion (29b)

**29a, now: measurement only, no new key.**
- The cross-family verifier already exists: set `triageModel` to one model and `model` to an equal-tier model from another family. Triage mode also forces the double-check on every finding above a nit and reports only confirmed findings (`types.ts:247-249`; `run.ts:226-227`, `668-681`), which matches `precise`. `EvidenceScope.triage` records the pair.
- Both models must pass VS-23 and the no-training rule, and both must be in D6 (Q5).
- After `codium` merges, build on its `reviewModels`, `checkedLabs` and `judgeModel` (`codium:packages/core/src/review/second-lab.ts`) rather than adding a mechanism (§0.5).
- **Files:** `script/vectorscope-eval` variant `engine:cross-family`; no runtime code.
- **Tests:** the variant registry; a replay test that the pair is recorded in the scope.
- **Done:** the variant runs in Phase A projections.
- **Measurable goal:** an A/B at equal capability and a fixed top-k, same-family against cross-family pair, with the change in precision and recall and Newcombe intervals. It needs a funded ablation (Q9). The pair joins `precise` only if the lower bound of the precision change is at least 0 and recall is not worse. No claim either way (D12).

**29b, later.**
- **When:** after `codium` merges `model-lab.ts`, or the owner approves landing it on `main` first (Q6). Local only until CI provenance exists.
- **Model choice:** pick between the owner-configured `model` and `alternateModel`, declared equal tier, so that `labOf(reviewer)` differs from the authoring lab, and say so in the notes (VS-07 never switches a model by itself).
- **Trusted authorship signals, local only:**
  - V2 `Assistant.model` with `snapshot.files` for the changed files (`packages/schema/src/session-message.ts:179-200`);
  - desktop parallel-workspace records (`packages/desktop/src/main/parallel-workspaces.ts:136-168`).
- **Untrusted claims** (PR body evidence lines, commit trailers, branch names) are recorded as `claimedAuthor` but never choose the model. A commit trailer is commit-message text the PR author controls.
- **GitHub CI has no trusted authoring signal today**, so inversion does not run there. It can, after the @vector merge, only from provenance the PR author cannot forge: a run record @vector stores outside the PR, or a commit signed by the App's bot whose signature and author are verified through the GitHub API (a request to the @vector owner, V21).
- **Files:** new engine `review/author.ts`; `model.ts` (`ResolveInput.author`).
- **Tests:** only trusted sources are used; adversarial claims and forged trailers are ignored.
- **Done:** a local review of an agent-written change picks the alternate model when the labs match, names the switch in its notes, and ignores every untrusted claim.
- **Measurable goal:** needs VS-22's agent-authored subset (Q12) and a funded A/B; no claim either way (D12).

### VS-30 Runtime verification with consent (takes over VS-18's execution half)

- **When:**
  - the core contract, now;
  - the local executor, after `self-evolving` merges, with VS-12's consent contract and VS-18's isolation prerequisite;
  - the desktop, after VS-10;
  - the GitHub half, after the @vector merge, with the @vector owner.
- **Files:**
  - new core `review/runtime.ts`;
  - new engine `review/runtime.ts`;
  - core `permission.ts` (coverage allowlist);
  - engine `run.ts`: a repro sub-pass after the verdicts at `run.ts:736`;
  - engine `cli/cmd/review.ts`: through the existing `--checks` consent, no new flag.
- **Implementation:**
  1. **One consent path (D10).** Runtime evidence extends `--checks`; it does not add `--verify-runtime`.
     - The prompt names the commands, worktree, network setting, time cap and head SHA.
     - The consent is single-use and bound to the head SHA and the command digest; it is stored with the actor and scope, and its expiry is only an upper bound. It is never standing preauthorization, never implied by starting a review, and never comes from PR text.
     - It is refused for `--pr`, forks, untrusted reviews and CI, and asks again when others authored commits (as `--checks` does).
  2. **The executor.**
     - Worktrees at head and at base. TaskIsolation refuses read-only agents and isolates task launches from `HEAD` (`self-evolving:packages/engine/src/task/isolation.ts:996-1025`), and its copy mode leaves out `node_modules` (`self-evolving:packages/core/src/isolation/copy.ts`). Ask the `self-evolving` owners for a trusted API that makes a detached worktree at a given SHA for an executor, not an agent.
     - The shell sandbox `offline()` (`packages/engine/src/tool/shell/sandbox.ts:211-254`). Refuse when it returns `unfiltered` (Windows); on macOS loopback stays reachable (`:211-222`), including the local Vector server, so require bubblewrap or deny loopback.
     - A clean environment with no provider keys or tokens, `CI=1`, and writes only inside the worktree.
     - 120 s and 80 KB of output per command.
     - Commands only from `CHECK_COMMANDS` (`permission.ts:24-40`), which allows no flags; coverage needs flags, so add an explicit per-runner allowlist of exact coverage commands (for Bun, `bun test --coverage --coverage-reporter=lcov`).
     - Dependencies must already be installed. Otherwise the review reports "checks not run: dependencies unavailable".
     - The head moving mid-run aborts it.
  3. **Coverage.** lcov mapped to the changed lines. This is the telemetry over changed paths.
  4. **Reproducers.**
     - A `vectorscope.repro` pass returns at most 3 test files as StructuredOutput. The model gets no write or shell tools.
     - The trusted executor writes them only to test paths inside the worktree (no traversal, no symlinks) and runs each twice on head and twice on base.
     - The verdict is `confirmed` only when every head run fails, every base run passes, and the failing assertion matches the finding's trigger and impact. A head-fails/base-passes test also "confirms" an intended behaviour change, so the assertion has to be tied to the finding.
     - Mixed results never confirm. `contradicted` never drops or downgrades a finding.
     - All output is wrapped as untrusted data in `<untrusted_runtime_evidence>`; only the executor's exit codes decide.
  5. **GitHub.**
     - A separate job with `permissions: {}`, no secrets and no model key, running in the V16 sandbox.
     - It uploads evidence that the review job reads as untrusted data.
     - Never for forks.
  6. **Telemetry options.** No eBPF. OpenTelemetry is deferred until coverage evidence has been measured.
- **Tests:**
  - core: lcov parsing, line mapping, the verdict truth table (including the "intended change" case), flaky runs;
  - engine: refusals (`--pr`, fork, untrusted, CI, `unfiltered`); network off; no keys in the environment; path-traversal writes refused; timeouts; cleanup; the head moving mid-run aborts;
  - `run.test.ts`.
- **Done:** a trusted local review with consent produces runtime evidence for its own change; every refusal case reports "checks not run" with a reason; I-6 holds.
- **Measurable goal**, in a local-only harness with trusted fixtures (eval replays run in CI on untrusted checkouts, `eval.ts:75`, where VS-30 refuses by design):
  - precision of runtime-confirmed findings at least 0.9 on fixtures with known defects;
  - added wall time at p90 at most 6 minutes;
  - strict recall no lower than without runtime checks;
  - 0 executions without consent or in an untrusted context.

### VS-31 Precise mode and switching the default

- **When:** after VS-23 to VS-28 have passed their gates.
- **Gate:** the default switch needs a held-out D2 pass and owner approval.
- **What `mode: precise` sets:**
  - `trivial: skip`;
  - `impact: graph`;
  - `guardrail: strict`;
  - `depth: auto`;
  - `verifyPolicy: shared`;
  - `cards: brain` (local only), `lenses: high` and a cross-family `triageModel`/`model` pair **only** if each passed its funded ablation; otherwise they stay off.

  It does **not** set `privacy`. The route is its own variant axis and its own decision (D15): tying them would either refuse every `precise` run on a model with no ZDR route, or measure the frozen baseline on a route production does not use. Explicit keys still override the preset.
- **Files:** core `types.ts`, `config.ts`; `model-evidence.ts`, which bumps the revision at the switch; the VS-20 flags; docs after 1.99.113; `certify.ts`.
- **Tests:** the preset and its override precedence; the preset never sets `privacy`; the variant name; `certify.ts` refuses without a held-out pass.
- **Done:** `mode: precise` expands as listed; with `mode` unset, nothing changes (I-1).
- **Measurable goal:** a held-out D2 pass for `engine:precise` against the frozen `engine` baseline, on the same route, and a committed certificate.

## 5. Sequencing

| Window | Packages | Reason |
|---|---|---|
| Now, on a branch cut from `origin/vectorscope` after P0 | Pure core modules: VS-23a, the VS-24 `trivial`/`dispatch` modules, VS-25a's parser (an uncalled new engine file) and VS-25b's core slice, VS-27a and VS-27b, VS-28's `risk.ts`, the VS-30 core contract. Eval work: VS-21a–c, VS-22a–b. VS-29a as a variant. Offline re-selection (VS-27) | New files, `types.ts`/`config.ts` additions and eval scripts only. No new behaviour reaches any runner, so the order rule below is not touched |
| Runner wiring: after `self-evolving` merges and VS-08's contract exists, or earlier on owner exception Q13 with rebase checkpoints | VS-23b–d, VS-24 wiring, VS-25b wiring, VS-26 (CLI), VS-27c, VS-28 wiring | The plan puts VS-08–11 before new capabilities, D13 holds VS-08–12 until `self-evolving` merges, and both `self-evolving` and `codium` rewrite `run.ts`, `ai-review.ts` and `provider.ts` (C-13) |
| After `self-evolving` merges (D13) | The VS-30 executor, with VS-12 and VS-18. VS-10, then the desktop halves of VS-23, VS-25, VS-26 and VS-28, and the V2 transport check. VS-11 (with the fail-closed posting guard), then VS-26 in CI | Reuse those modules instead of rebuilding them |
| After `vector-at-mention` merges (D1) | VS-24's GitHub trivial skip through `decideSkip` state; VS-23's privacy passed to GitHub model resolution; the GitHub posting check receiving `outcome.sessions`; the VS-30 GitHub job (V16); CI provenance for VS-29b (V21); VS-25's Actions cache and `REVIEW_PRIVACY` in the generated workflow | @vector owns these files |
| After `codium` merges, or owner exception Q6 | VS-29b `labOf`; VS-29a on `reviewModels`/`judgeModel`; the Codium gateway as a ZDR route | Codium owns these |
| After the D7 key exists | Phase B pilot (descriptive) | D5 |
| After a held-out pass and owner approval | VS-31 default switch | D2, D3, D12 |

Order of work:
- VS-21 first (a, then b, then c).
- Then VS-22a and VS-23a in parallel, then the VS-24, VS-25, VS-27, VS-28 and VS-30 core modules, with VS-22b's curation batches alongside.
- Land them one at a time.
- Code may be written early, but prompt tuning waits until the held-out split is frozen.

## 6. Evaluation plan

### 6.1 What is measured

For every package, before and after: precision, recall, false alarms per clean PR, cost per review and wall time. Also coverage and the zero-token rate. All of it runs on the existing harness:
- VS-01: the manifest;
- VS-02: the engine and desktop replays;
- VS-03: the ledger and sealed CI;
- VS-04: causal judging, the D2 gate, `report.ts --candidate/--baseline variant=model` and `--empty-control`.

### 6.2 Metric definitions and statistical power

- **Actionable precision.** Posted non-nit findings judged real, divided by all posted non-nit findings. Duplicates stay in the denominator. A result is settled only with a human pass.
- **Recall.**
  - End to end, and conditional on the review completing.
  - Paired by case and repetition.
  - Class-scoped: defects in the five classes only.
  - Cross-file.
- **False alarms per clean PR.** Posted non-nit findings on behaviour-preserving controls, divided by the number of those controls. Trivial controls are reported separately and never counted in the D2 figure.
- **Cost per review.**
  - Settled plus uncertain USD across the case's admitted attempts.
  - Judges excluded.
  - Mean, median and p90.
  - Tokens in, out, cache-read and cache-write.
  - Zero-token reviews count as $0 and are also reported as a rate.
- **Wall time.** Per pass and end to end, p50 and p90 (§6.8).
- **Estimate error.** `|estimate − settled| / settled`.
- **Slice recall.** Labelled evidence locations outside the diff that appear in the recorded context locations.
- **Trivial safety.** Bug cases classified trivial; this must be 0.
- **Statistical power** (our arithmetic, normal approximations; rough):
  - The seed set has 10 cases, with 2 held-out bugs and 0 held-out controls (`vectorscope-deviations.md:13-23`); it can support no D2 decision.
  - The planned ~100 bugs and 25 controls, split 60/20/20, leave about 20 held-out bugs and about 5 held-out controls.
  - D2's recall rule is a paired non-inferiority test. With 20 held-out bugs, a 95% interval on the paired recall difference is roughly ±14 to ±20 points, depending on how often the two pipelines disagree (10–20% of defects). Bounding a 5-point drop needs roughly 150–300 held-out defects.
  - "At most 0.2 false alarms per clean PR": even with zero false alarms, the 95% upper bound is about 3/N, so N must be at least 15; with a true rate near 0.1, roughly 40 or more controls are needed.
  - "At least 80% precision": with observed precision near 85%, the interval's lower bound clears 0.80 only at about 200 posted findings.
  - So either grow the held-out split to these sizes (Q14), or state in every report that D2 can be tested only coarsely. Never weaken the thresholds to fit the sample.
- **Contamination.** The seed cases are public open-source bug fixes (werkzeug, fastify, vite and others) that models have probably seen in training. The plan records this limit (`vectorscope-plan.md:104-105`), and every report repeats it.

### 6.3 Baselines

- `engine` (frozen)
- `engine:shared-verify`
- `empty`
- `single-prompt`
- the desktop replay, once VS-21c loads desktop artifacts

### 6.4 Phase A: dry runs and offline re-selection at zero spend (now). These are the per-stage gates

| Measure | Package | Target |
|---|---|---|
| Projected tokens, USD and wire bodies per case and variant | VS-21 | recorded, with 0 outbound requests |
| Route audit and compliance on every transport | VS-23 | 0 non-compliant requests |
| Trivial safety and skip rate | VS-24 | 0 bug cases skipped, trivial-looking bug fixtures included; at least 80% of trivial controls skipped |
| Slice recall and tokens | VS-25 | +10 points at equal or fewer tokens; p95 at most 5 s |
| Card limits and leaks (local-only eval) | VS-26 | 100% within limits; 0 leaks |
| Guardrail properties and offline re-selection | VS-27 | every finding kept satisfies the rules; precision change reported |
| Risk-band distribution, feature availability and cost per band | VS-28 | reported; low band at or below baseline cost |
| Runtime evidence on trusted fixtures (local-only harness) | VS-30 | confirmed precision at least 0.9; 0 executions without consent |

### 6.5 Phase B: the D5 pilot (after D7). Descriptive only

- **Budget.** D5 allows $50 in total, $0.75 per case, one repetition, development split only. After the ledger's 10% reserve, $45 is admissible. Each case reserves its whole $0.75 bound before it starts (`replay.ts:189-197`), so exactly 60 case-runs fit, with no room for anything else. Judges are human, so they cost nothing.
- **Proposal (Q9).**
  - 18 development cases: about 13 bug cases spread across the classes, at least 4 of them cross-file, plus 5 behaviour-preserving controls.
  - 3 variants on the D6 default model: `engine`, `engine:shared-verify` and `engine:precise`.
  - The route is held constant at the route that model really uses in production (ZDR only if that is the production route).
  - 54 paid case-runs, leaving headroom of 6 under the 60 the ledger admits.
  - Trivial controls are only projected, never run: each would reserve a full $0.75 bound before it started, even though it is expected to cost $0.
- **What it is.** A descriptive run of the whole pipeline. It shows cost, wall time, coverage and rough quality, and it is reported as "precise under a $0.75 per-case cap": the VS-24 shrink drops lenses first at that cap, so `engine:precise` in the pilot is not the pipeline that would ship at the $2 default, and the artifact records every shrink.
- **What it is not.** It cannot decide any stage: with 5 controls, "at least 90% of clean controls empty" needs 5 of 5, and "at most 0.2 false alarms" allows one; "+5 cross-file points" on 4 cross-file cases is a fraction of one case.
- **Ablations.** Per-stage quality for VS-23 (route), VS-26 (cards), VS-28 (lenses) and VS-29a (cross-family pair) needs a separate ablation budget from the owner, sized from the interval widths in §6.2 (Q9). Without it, those stages stay off.
- **Stop rules.** The pilot stops on overshoot, on unpriced or unreadable usage, or on cancellation. Nothing is retried automatically.
- The cheaper D6 model is tested later.

### 6.6 Phase C: held-out

- The owner sets the budget after reading the pilot report, with the sizes in §6.2 in mind.
- Run `engine` against `engine:precise`, as a bundle, on the same route.
- The D2 gate decides, with intervals; human review where the interval cannot.
- A pass leads to a certificate, owner approval, then VS-31.
- If the sample is too small, collect more data; do not weaken the thresholds.

### 6.7 Decision rules

- **A stage joins `precise`** only when it meets its Phase A or offline gate, and, for cards, lenses and the cross-family pair, its funded ablation. **"Failing"** a rule means its interval lies wholly past the threshold; an interval that straddles it is "undecided", which is not a pass.
- **A stage with no measured gain stays off.** Cards and the cross-family verifier are the likely cases.
- **`precise` is decided as a bundle in Phase C.**
- **The default switches** only after a held-out pass, owner approval and a revision bump.

### 6.8 Latency budget

The default review timeout is 12 minutes (`types.ts:280`). For reference, Bugbot's average review is about 90 seconds after its June 2026 update, and Greptile v5's median is 2:25 (both vendor). Targets, measured and reported, not promised:

| Stage | Target |
|---|---|
| Stage 0 and the budget check | under 1 s |
| Tier 1 | p95 at most 5 s per case |
| Tier 2, verify and guardrail | inside the existing timeout; p50 and p90 reported per pass |
| Lenses | at most 3 in parallel; dropped first by the budget shrink |
| Runtime evidence (local only) | p90 added at most 6 minutes, with its own cap; when it is exceeded, the review reports "checks not run: time" |

### 6.9 Reporting

- Results are sealed to the owner's key and stay internal.
- Each one gets a deviations entry with sample sizes, intervals, coverage, wall time and spend, and the contamination caveat.
- Nothing is published without the owner.

## 7. Conflicts

| # | Owner request or rule | Conflicts with | Recommendation |
|---|---|---|---|
| C-1 | ZDR-only routing for every remote review payload | D3 (opt-in until D2); D14; the existing free-model fallback in CI (`model.ts:80-86`); D6 (the default model may have no attested ZDR route); Codium's ownership of gateway privacy | An opt-in now, used in every eval where the route allows. Not part of `precise`. New decision D15 for the default. It is a privacy restriction, not a quality change, but it stops reviews that have no ZDR route, and ZDR cannot rule out retention by safety flags or legal holds. |
| C-2 | Comment only on the five classes | D2's rule of at most 5 points of recall drop on paired cases. Evidence: Graphite's 0.07 recall is consistent with acceptance-only tuning (inference), and Kodus documents severity floors dropping real bugs. | Make it the "precise" operating point. New decision D16: judge it on class-scoped recall, or require full recall. |
| C-3 | ~10% from cross-model inversion | Evidence: no source for an edge-case figure; capability matters more than family; frontier models' errors correlate. The plan forbids PR text choosing the model. VS-07 never switches a model. D6 limits the candidate models. Codium already builds a cross-lab checker. | No new verifier key: measure the existing `triageModel`/`model` pair at equal tier. Inversion by author is opt-in, local only, from trusted signals, until CI provenance exists. A/B test. No claims. Extend D6 (Q5). |
| C-4 | Runtime verification with eBPF or OpenTelemetry | The plan says review mode runs no project code (except opt-in `--checks`) and no fork code runs in privileged CI. D10, D13; VS-18's isolation prerequisite. Evidence: eBPF needs privileged Linux and is unstudied; OpenTelemetry is unstudied. | One consent path (`--checks`), own changes only, isolation, coverage and differential reproducers, all output untrusted. GitHub only through an unprivileged job after the merge. No eBPF. OpenTelemetry deferred. |
| C-5 | Tier 1 filters the diff | Honest partial coverage (VS-19). Evidence that agentic follow-up helps. | Rank and bound context. List files left out. Keep the read tools. |
| C-6 | An empty result when nothing is verified | Incomplete reviews must say so; the summary carries state | `complete` flag; the summary and its marker stay; zero-attempt stops say "Not reviewed". |
| C-7 | Brain cards everywhere | Memory rules; no Brain in CI; eval must not leak labels | CLI first; CI after VS-11; local-only eval with a base-commit index. |
| C-8 | Predict future bugs, as Greptile does | Greptile has no such feature that we found. Google's 2013 hotspot study found no change in behaviour. | Use risk to set depth, and look at impact on dependents. Post no predictions. |
| C-9 | Benchmark against Greptile on Martian's set | D8 licences (to verify: Sentry FSL, Cal.com and Grafana AGPL, Discourse GPL); D12; possible training leakage | An internal diagnostic only, with an owner exception (Q10), or AACR-Bench once its licences are checked. |
| C-10 | A hard token budget | The plan: estimates are not caps | Call them estimates; admission and provider-side key limits remain the real bounds. |
| C-11 | JSON output | D14 | `--json` already exists; StrictResult goes inside its outcome behind the opt-in, with no new flag. |
| C-12 | count_tokens before dispatch | Any remote payload falls under the route rules; counting with Anthropic sends the code to Anthropic | Count only with the provider that will serve the request, on an allowed route; otherwise a calibrated local estimate, recounted per model. |
| C-13 | Build the upgrades now | The plan's order ("VS-08–11 before adding capabilities", `vectorscope-plan.md:332-336`) and D13 (VS-08–12 wait for `self-evolving`) | Land pure contracts, shaped for VS-08 to adopt, and the eval work now; wire behaviour into the runners after `self-evolving` merges, or on an owner exception (Q13). |
| C-14 | Every finding comes with a copy-pasteable fix | Recall under D2: fixes for cross-file defects often lie outside the diff, and a fix that does not apply would otherwise drop a real defect | Keep such a finding with its fix shown but marked unchecked, counted separately (S6); the owner decides (Q17). |

## 8. Owner questions

- **Q1.** Make ZDR the VectorScope default (D15)?
- **Q2.** Is an attestation in trusted config acceptable proof of ZDR for a direct provider, an OpenRouter account or a LAN model server, and who sets it in CI (the base branch's `review.json`)?
- **Q3.** Is precise mode judged on class-scoped recall (D16)?
- **Q4.** Does "leaks" include data exposure? Do concurrency bugs with wrong results count?
- **Q5.** May D6 be extended with an equal-tier model from a second family, for the `triageModel`/`model` pair, and which pair?
- **Q6.** May `model-lab.ts` land on `main` before `codium` merges?
- **Q7.** Should the D7 key be set up with the ZDR guardrails, logging off and safety retention disallowed, and then attested as `openrouter` in the eval's `zdrAttested`?
- **Q8.** Is runtime verification local, consented, own-changes-only and through `--checks`, with GitHub through an unprivileged job after the merge, and no eBPF?
- **Q9.** Is the pilot approved as a descriptive run (18 dev cases × 3 variants = 54 runs on the D6 default model, on its production route, within $50)? Will there be a separate ablation budget for routes, cards, lenses and the cross-family pair?
- **Q10.** May Martian's set be used as an internal diagnostic despite D8, or should we check AACR-Bench's licences instead?
- **Q11.** Should dependency and version bumps stay out of the trivial skip?
- **Q12.** Are synthetic agent-authored cases acceptable for 29b?
- **Q13.** May runner wiring for these opt-in keys land before `self-evolving` merges and before VS-08–11, with rebase checkpoints?
- **Q14.** Should the held-out split grow to the sizes in §6.2 (roughly 150–300 defects and 40 or more controls), or do we accept that D2 can be tested only coarsely?
- **Q15.** Are VS-21 to VS-31 approved as additions to the plan, and does VS-25 supersede VS-17?
- **Q16.** Is the global `review.privacy` engine setting user-facing under D14, or may it ship hidden in 1.99.113?
- **Q17.** May a precise finding be posted with a fix that is shown but not checked to apply (C-14)?

## 9. Out of scope

- A hosted or persistent index across repositories.
- A knowledge base of model-written docstrings.
- Embedding-based suppression of dismissed findings. Compare it with the existing dismissed-pattern penalty (`select.ts:222-231`) under VS-11/VS-20 first.
- A confidence score or auto-approve.
- Non-GitHub hosts.
- MCP writes.
- eBPF.
- Fuzzing infrastructure.
- Team or organization features.
- Product-plan gating (D4).
- A bump of `web-tree-sitter` (a separate decision; VS-25a stays on 0.25.10).

## 10. Review notes

Two reviews of the first draft were checked against the research notes and against `origin/vectorscope`, `origin/main`, `origin/self-evolving` and `origin/codium`. Nearly every point was confirmed in the sources and is fixed above or in `vectorscope-research/REPORT.md`. Where the fix differs from the one proposed, or a point was not taken, the reason is below.

**Fixed as proposed (confirmed in code or notes), in brief:** ZDR transport paths that skip the generic fetch (plan and free routes, the native runtime, non-string bodies); key-driven steps moved inside `Review.run`, and the GitHub trivial skip moved to after the @vector merge; the trivial rules (indentation, directives, `.txt`/`.mdx`, renames); the pilot's power and its descriptive role; `privacy` removed from `precise`; codium's cross-lab checker reused instead of a new verifier key; the runner-wiring window and C-13; the posting guard's real behaviour; source-tagged key merging; LAN servers no longer "local" for privacy; OpenRouter attestation and plugins; the strict schema fields and import-free types; deletion defects and cross-file fixes in S3, S4 and S6; the shrink trigger; the projection's fake provider server and hook; the explicit variant registry; VS-30's isolation, sandbox, coverage-flag and verdict gaps; `--json` and `--checks` already existing; Brain `brief`; the `runnable` label; history in CI; `forceFull`; package splits; pilot headroom; the replay entry point's location; artifact fields; session bounds and pass-name unions; route-check placement; default-stable digests; re-citing after P0; per-runner parity; private exports and `BrainGraph.rank`; SDK regeneration; test directories; grammar licences and caps; grepping the head tree-ish; the existing header "Risk:"; reproducer assertions and single-use consent; the citation home for the notes. Every "missing" item from both reviews is now covered.

**Fixed differently from the proposal:**
- **`Finding.verified` is not widened.** The review proposed widening it and updating every consumer. Adding `verifiedBy` is safer: `github-payload.ts:39`, `select.ts:374,386`, `eval.ts:604`, `ai-review.ts:1766` and `script/vectorscope-eval/desktop.ts:179` test `verified === true`, so a `"runtime"` value would silently count as unverified there.
- **S6 keeps the finding with an unchecked fix, shown as a plain diff block, rather than with no fix**, because the owner asked for a copy-pasteable fix on every finding. The tension is logged as C-14 and Q17.
- **Requests with no `x-session-id` are not refused.** The review asked to fail closed on any request without a parseable session ID while a `zdr` review is registered. By construction every session request carries the header (`provider.ts:2330-2341`), and a request without one is the owner's own non-session call, so refusing those would break unrelated work in the same process. Malformed headers are refused, and a test proves every `vectorscope.*` request kind carries a parseable header.
- **Default-stable digests apply to new keys only.** Applying the rule to existing keys too would change VS-07's current digests for no gain.
- **Consent keeps an expiry**, because the plan stores consent "with actor, scope, source/head SHA, patch digest and expiry" (`vectorscope-plan.md:221-222`). It is single-use and bound to the head SHA and command digest, so it is never standing preauthorization (D10).
- **`require_parameters` is neither added nor removed.** `zdrRequestBody` does not add it, since it is not a privacy control; bodies that already carry it (the free route, the Codium gateway) keep it.

**Not taken, or taken only in part:**
- **"VectorScope" in code strings.** The rename is applied to prose in both documents, following the approved plan. Code strings that read "Vectorscope" (for example `format.ts:663`) are user-visible text and are left alone (D14). The review's claim that the code names it "VectorScope" holds only in part: the code mixes both spellings.
- **The blocked-hosts list.** In `vectorscope-research/REPORT.md`, developers.openai.com, ai.google.dev, cloud.google.com, graphite.com, qodo.ai and macroscope.com are described as "not reached", not "blocked". The notes say the sessions stopped trying new hosts after the first refusals, not that these hosts refused.
- **"Kai's figures re-use the same run."** Kai, a competitor benchmark, reports v5 numbers that match our recomputation of Martian's pre-release v5 run [quality §5 row 8]. It is therefore not an independent score of the shipped v5, which `vectorscope-research/REPORT.md` now says ("We found no independent score of the shipped v5"). No separate change was needed.
