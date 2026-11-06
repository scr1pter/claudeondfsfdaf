# VectorScope upgrade contract, addendum A (round two)

Files: this addendum is `docs/vector/build/vectorscope-upgrade-addendum-a.md`. It extends `docs/vector/build/vectorscope-upgrade.md`, and its evidence is `docs/vector/build/vectorscope-research/round-two/REPORT.md` with the lane notes in `round-two/notes/`.

Status: a proposed extension of `docs/vector/build/vectorscope-upgrade.md`, written 2026-11-06 from "VectorScope research, round two", and revised the same day after review. It is not approved and not implemented, and it makes no claim of measured quality.

- **Packages VS-32 to VS-49 are proposals.** Each needs owner approval (Q18).
- **Rules inherited unchanged:**
  - the contract's §0 rules: P0, the two windows, the six items every behaviour-changing package carries, tests and typecheck from package directories, and the "Never" list;
  - invariants I-1 to I-14;
  - decisions D1 to D14 (approved), including D14: nothing user-facing in 1.99.113;
  - the proposed D15 (ZDR default) and D16 (class-scoped recall), pending Q1 and Q3. Where a package leans on D15 (VS-33, Q21), it depends on the answer to Q1. Where a kill criterion is stated in class-scoped recall, it depends on Q3.
- **The six §0.3 items per package.** §1a names each behaviour-changing package's VS-21a replay variant (item 4) and its desktop half, or the documented difference (item 5).
- **Every new key is off by default.** Every key-driven step happens inside `Review.run`, unless the package says it waits for the @vector merge.
- **Config schema changes.** Some packages add a field to the user's global engine config schema:
  - `zdrAttested`'s structured shape (VS-33);
  - `holdback` (VS-34);
  - `instructionScope`, when accepted from the global config locally (VS-48).

  Each such package regenerates the legacy JavaScript SDK (`./packages/sdk/js/script/build.ts`) and the client (`bun run generate` in `packages/client`), and runs `bun typecheck` in each affected package directory (contract §0.4, I-11). Any global-config setting ships hidden, as `review.privacy` does, until the owner decides (I-14, the Q16 precedent).
- **Evidence.** Finding IDs in brackets (for example [G1-10]) refer to findings stated in the round-two report. [VT1] to [VT3] are the VectorScope code findings listed after its §7 table, cited at HEAD 7cadfcb8. Gap-lane findings (G1 to G6) were single-pass.
  - Some figures rest on lane findings that the report names only in ranges or not at all. These are VOI5 to VOI7, G3-7, G4-2, G4-6, G4-9, G4-12, G4-18, G5-7, and the count of AACR positives outside the grammar set.
  - They are marked *(lane note)*, and must be re-checked against the vendor page or the dataset before implementation.
- **Windows:**
  - **now**: pure core modules, uncalled engine files, eval scripts;
  - **runner-wiring**: after `self-evolving` merges, or on owner exception Q13;
  - **later**: after a named merge (`vector-at-mention`, `codium`) or a measured trigger.
- **Merged proposals.** Duplicates were merged; merged and dropped proposals are listed in §6.

## 1. New opt-in keys

| Key | Values (default first) | Env | Package | Evidence scope | Source rule (I-2) |
|---|---|---|---|---|---|
| `failOn` (new value) | existing values; adds `blocking-or-incomplete` | `REVIEW_FAIL_ON` for existing values only; the new value is never read from the environment | VS-32 | not a policy key | **new value: base `review.json` only**. When base sets it, no other source can lower it, enforced by VS-23a's source-tagged merge |
| `zdrAttested` (shape) | strings as today (legacy); or `{id, operator, project?, region?, extendedCache?, verify?: attest\\|api}` with `operator` required | none | VS-33 | route | **unchanged from VS-23**: the user global engine config locally; the base branch `review.json` in CI; never env or the working tree |
| `holdback` | `off` / `secrets` | `REVIEW_HOLDBACK` | VS-34 | policy key | **raise-only: the strictest of** the user global engine config (ships hidden), the surface's `review.json` and `REVIEW_HOLDBACK`, as for `privacy` |
| `teamMemory` | `legacy` / `guarded` | none | VS-35 | policy key | existing |
| `rereview` | `full` / `focused` | `REVIEW_REREVIEW` | VS-41 | policy key; `EvidenceScope.reviewRun` only under `focused` | existing |
| `scopeGate` | `off` / `introduced` | none | VS-42 | policy key; effective only with `guardrail: strict` | existing |
| `ruleCheck` | `off` / `strict` | none | VS-43 | policy key | existing |
| `verifyEvidence` | `off` / `certificate` | none | VS-44 | policy key; effective only with `guardrail: strict` | existing |
| `receipt` | `off` / `json` | none | VS-47 | not a policy key | existing |
| `instructionScope` | `root` / `scoped` | none | VS-48 | policy key | **trusted only**: base `review.json` in CI; the user global engine config or base `review.json` locally |
| `depthRules` | `[]` (glob plus `minBand`, at most 20) | none | VS-48 | policy key | **trusted only**: base `review.json`, in CI and locally |
| `explore` | `off` / `slice` | none | VS-49 | policy key | existing |

- **No new key** for VS-36 to VS-39: they change behaviour only inside the existing `impact: graph`, `depth: auto` and `lenses: high` values.
- **VS-40** changes the estimator used only when VS-24's keys are set.
- **VS-45 and VS-46** are eval and report work with no runtime key.
- **Eval-only parameters** (VS-37 tier shares and top-k, VS-41 `rereviewSteps`, the VS-25 budget sweep) need a VS-21a follow-up. It adds `VariantEntry.params` and `VariantRecord.params`, an engine allowlist `VARIANT_PARAMS.engine`, and a `RunInput` field that only `ReviewEval.replay` and `ReviewEval.project` set and that is never parsed from config or env, all recorded in the artifact's variant record. Until that lands, they are swept only in offline projections. `EvidenceScope` keeps key-driven fields only.
- **Keys effective only under strict.** `scopeGate` and `verifyEvidence` act inside `strictSelect` and need strict quotes. Set without `guardrail: strict`, each is ignored with a note, and a test asserts that.
- **Digests.** Each new key enters `policyDigest` only when set to a non-default value. New prompt sections and schema fields enter `promptsDigest` only when their key is set (§0.3).

## 1a. Replay variants and desktop halves (§0.3 items 4 and 5)

Variant names contain no `=`. The desktop runner (`packages/app/src/features/pull-requests/ai-review.ts`) does not call `Review.run`. So each desktop half is either a separate call from that runner to the same pure core function, or a documented difference recorded with `variant.applied: false`.

| Package | VS-21a replay variant | Desktop half |
|---|---|---|
| VS-32 | No replay variant. `reviewVerdict` is computed for every replay artifact as a recorded field, and item 4 is recorded as not applicable, because `failOn` never changes `Review.run` | Documented difference: the desktop has no CI exit code. `variant.applied: false` |
| VS-33 | `engine:privacy-zdr` (VS-23's variant, extended) | Follows VS-23's desktop half through the same `privacy.ts`; otherwise a documented difference |
| VS-34 | `engine:holdback-secrets` | `ai-review.ts` calls `holdbackFiles` before prompt building, or records a documented difference with `variant.applied: false` |
| VS-35 | `engine:team-guarded` | Documented difference: team memory is GitHub-only. `variant.applied: false` |
| VS-36 | No separate variant. VS-36 to VS-38 change `engine:impact-graph` (still pending VS-25b wiring). The arms in their kill criteria are computed offline from the recorded `ImpactSlice.stages`, dropped and per-tier locations | Follows VS-25's desktop half; until then a documented difference, `variant.applied: false` |
| VS-37 | As VS-36 | As VS-36 |
| VS-38 | As VS-36 | As VS-36 |
| VS-39 | Changes `engine:depth-auto` | Follows VS-28's desktop half; until then a documented difference |
| VS-40 | No variant. Both the legacy and the v2 estimate are recorded per pass in the artifact | Desktop: the token estimate and the step-cap shrink arrive with VS-24 wiring. The desktop runner has no dollar cap (`ai-review.ts:110`), so `remainingUsd` does not apply there until VS-10 and Q32. Until then this is a documented difference, with `variant.applied: false` |
| VS-41 | `engine:rereview-focused` | A documented difference unless the desktop runner gains incremental reviews. `variant.applied: false` |
| VS-42 | `engine:scope-introduced` | Pure core in `guardrail.ts`; applies wherever the desktop runs `guardrail: strict` (VS-27's desktop half), otherwise a documented difference |
| VS-43 | `engine:rule-strict` | `ai-review.ts` calls `ruleCited` on its trusted rules (`ai-review.ts:842-843`), or records a documented difference |
| VS-44 | `engine:verify-cert` | As VS-42 |
| VS-47 | `engine:receipt-json` | Documented difference: the desktop has no `--json` outcome. `variant.applied: false` |
| VS-48 | `engine:instructions-scoped`, `engine:depth-rules` | `ai-review.ts` reads both through the same core helper, or records a documented difference |
| VS-49 | `engine:explore-slice` | Documented difference until the desktop runner records session events. `variant.applied: false` |

---

## 2. Work packages

### VS-32 Fail-closed review verdict

*Merges round-two proposals P1 (economy and trust) and P-7 (precision).*

- **Problem.**
  - **Exit 0** today: the GitHub job exits 0 on:
    - skips (too-large, PR budget, month budget, unreadable spend and the rest);
    - partial outcomes (budget, steps, timeout, model error);
    - model or tool failures caught after the review starts;
    - other failures before it starts (GitHub or git), unless a model that cannot start was already recorded.
  - **Exit 1** today: configuration errors already exit 1. These are a model that cannot start, GitHub 401, 403 or 404, the working-tree and head mismatch checks (`configError` at 269 and 273), and command-level failures before the job starts (missing repository, `VECTOR_PURE` or `VECTOR_DISABLE_PROJECT_CONFIG` unset in Actions, no PR, App auth). `failOn: "blocking"` with open blocking findings also exits 1 (959-960) (`github.review.ts:200-221, 268-276, 391-402, 959-978, 1108-1120, 1220-1229`) [VT1].
  - **No output:** the job writes no `$GITHUB_OUTPUT`.
  - **Why it matters:** a team that makes the job a required check gets a green check on a review that never finished. GitHub treats `success`, `skipped` and `neutral` as passing, so mapping "not reviewed" to neutral or skipped would still fail open. User-built Greptile gates show this failure in practice [GU10, GU11, GU17].
- **Scope of protection.**
  - **Unfinished reviews only.** The verdict is fail-closed against unfinished reviews, not against a hostile same-repository author. The generated workflow runs same-repository PRs on `pull_request` (`workflow.ts:187-193`), and such a PR can edit the workflow and its environment (contract §1.1). Teams that need the gate to hold against authors must protect the workflow file with branch protection or code owners. The setup docs say so after the @vector merge.
  - **Job-level skips are outside what the verdict can close.** The generated workflow's job `if:` skips forks, the `vector:skip` and `vector:paused` labels, drafts, and Dependabot or Renovate authors (`workflow.ts:187-193`). GitHub treats a skipped job as a passing required check, so those PRs go green whatever the verdict says, and fork PRs carry the most risk.
  - **Request to the @vector owner (V-series):** an always-running gate step after the merge. It would read the verdict output, and fail when no head-bound verdict exists for the PR's head.
- **Design:**
  1. Add a pure `reviewVerdict(outcome | skip | failure)` in `packages/core/src/review/state.ts`, next to `nextState`. It returns exactly one value, evaluated in this order (first match wins):
     1. `not-reviewed`: the privacy or budget-estimate stops (which are `ReviewOutcome.partial` values, contract §1.2), too-large, pr-budget, month-budget, spend unreadable;
     2. `policy-skip`: label, draft, author, branch, fork auto-skip, `nothing-to-review` (a PR whose only files are ignored lockfiles, generated or vendored files), and VS-24's `trivial` skip when it lands;
     3. `incomplete`: any other `partial`, any unreviewed file, any held-back file (VS-34; a held-back file whose change is a deletion only, with nothing sent, does not make the verdict incomplete; it adds a note), `StrictResult.complete === false`, a failed or skipped specialist, or a thrown review error;
     4. `blocking`;
     5. `findings` (non-blocking);
     6. `clean-complete`.
  2. **Only under the new value**, store the verdict in the encoded `ReviewState` as a new optional `verdict` field (`types.ts:138-150` has none today). Only the bot's sticky comment holds that state. `already-reviewed` then carries the earlier verdict for the same head. Under the new value, `already-reviewed` with no stored verdict (state written before the value was set, or with the key unset) maps to `not-reviewed` (exit 1), with a note to run `/vector review full`. With `failOn` unset or on its current values, `nextState` (`state.ts:366`) writes byte-identical state.
  3. **Config value.** The parse change for `failOn: "blocking-or-incomplete"` lands with the job wiring, after `vector-at-mention`.
     - **Source.** The value is read from the base branch's `review.json` only, through VS-23a's source-tagged merge, so `REVIEW_FAIL_ON` cannot lower it (today env overrides `review.json`: `parseReviewConfig`, `config.ts:176`, precedence comment at 174; `REVIEW_FAIL_ON` at 125). From the environment or a working-tree file, the value is ignored with a warning.
     - **Until then,** the existing unknown-value warning applies: `failOn` is `oneOf(["never", "blocking"])` (`config.ts:20-25, 89`), so the value warns and stays at the default `never`. Exit codes do not change before the wiring, and the value is not documented before it.
     - **Exit codes.** Under the value, the job exits 1 for `not-reviewed`, `incomplete` and `blocking`, including in the catch paths, and 0 otherwise. With the key unset or on its current values, exit codes are unchanged.
  4. **Only under the new value**, append `vectorscope-verdict=<value>` and `vectorscope-head=<full sha>` to `$GITHUB_OUTPUT`, and add the marker to the job summary. With the key unset, the job writes neither. Never emit neutral or skipped semantics. No confidence scalar and no approve action (§9).
  5. Reuse `decideSkip` reasons, `ReviewOutcome.partial` and `unreviewed`, `SkippedFile.reason` and `StrictResult.complete`. No new store.
- **Invariants:**
  - I-1 and D14/I-14: with the key unset, exit codes, sticky bodies, `$GITHUB_OUTPUT` and the step summary are byte-identical to today, enforced by the parity test below.
  - I-2: the verdict lives in bot-only state, and the value comes from base config only. It does not defend against a same-repository author who edits the workflow, or against job-level skips (see Scope).
  - I-7: made enforceable for downstream gates.
  - I-9: the config value and job wiring wait for the @vector merge.
  - I-14: no App permission and no check-run API.
- **Tests:**
  - a truth table of `reviewVerdict` over every `SkipReason` (`nothing-to-review` and `trivial` as `policy-skip`), every `partial` value, unreviewed files present or absent, held-back files present (`incomplete`), a held-back deletion only (not `incomplete`, with a note), `already-reviewed` with no stored verdict (`not-reviewed`), and strict complete or incomplete;
  - precedence cases: privacy and budget-estimate partials give `not-reviewed`, not `incomplete`; a partial run with blocking findings gives `incomplete`; a complete run with blocking findings gives `blocking`;
  - a parse test before the wiring: `blocking-or-incomplete` warns and resolves to `never`, exactly as today;
  - a parse test after the wiring: the value is accepted from base `review.json`; it is ignored with a warning from `REVIEW_FAIL_ON` or the working tree; `REVIEW_FAIL_ON=never` cannot lower it;
  - a D3 parity test on the existing `github.review` tests: with the key unset, it requires byte-identical exit codes, byte-identical sticky bodies, and no `$GITHUB_OUTPUT` or step-summary writes;
  - every exit path, the catch blocks included, and every existing exit-1 path unchanged. That covers `cannotStart` (206-208, 391-402), GitHub 401, 403 and 404 (210-212), the two checkout-mismatch `configError` exits (269: a trusted tree not at the expected head; 273: a fork's head checked out), `failOn: "blocking"` with open blocking findings (960), and the command-level failures before the job starts (1108-1120, 1220-1229);
  - injected timeout, model-error, privacy and budget-estimate stops across all seed cases produce 0 exit-0 results under the new value;
  - over every saved engine and desktop replay artifact, 0 partial outcomes map to `clean-complete`.
- **Done when:**
  - the pure function is merged with its tests;
  - after the @vector merge, the config value, the job wiring, the `ReviewState.verdict` field and the output token are merged with parity tests;
  - the deviations entry is recorded;
  - the always-running gate step has been requested from the @vector owner.
- **Measurement and kill.**
  - Owner dogfood: the rate of PRs turned red, by cause.
  - If more than 5% of PRs go red from provider or model errors over 30 days, keep the verdict token, but move the model-error exit to a retry-then-recheck flow (Q19).
  - Report the share of red PRs caused by held-back files alone; if above 1%, reconsider mapping held-back to `incomplete`.
- **Window:**
  - now: `reviewVerdict` only;
  - later (after `vector-at-mention`): the config parse change, exit codes, `ReviewState.verdict`, `$GITHUB_OUTPUT` and the summary marker.
- **Depends on:**
  - VS-23a (source-tagged merge; `privacy` stop);
  - VS-27a (`StrictResult.complete`);
  - VS-24 (`budget-estimate` stop, `trivial` skip);
  - VS-34 (`held-back`).
  - The pure function works without VS-24, VS-27a and VS-34 by treating their values as absent. The config value needs VS-23a.
- **Owner questions:** Q19.

### VS-33 ZDR refusal list v2 and checkable attestations

- **Problem.**
  - **Missed retention paths.** VS-23a's `decideRoute` and `zdrRequestBody` miss retention paths that are documented today [G4-1, G4-3, G4-4, G4-7, G4-11, G4-13, G3-8, G5-7 *(lane note)*, VOI7 *(lane note)*].
  - **Fusion.** Fusion's inner generations do not inherit request-level `provider` settings, `zdr: true` included. Account-level and guardrail ZDR do apply to them (vendor, OpenRouter `server-tools.mdx`) [G4-4]. Q7's account-level enforcement closes that path for the eval key; a request-level refusal of server tools covers the rest.
  - **Anthropic.** Anthropic's feature-eligibility table lists further non-ZDR features (platform.claude.com, accessed 2026-11-06).
  - **Merging.** A later `provider` object silently replaces the configured one, `zdr` included [VOI1].
- **Design.** The changes go in `review/privacy.ts` (pure, VS-23a) and in VS-23c's transport backstop in `provider.ts`. Everything below applies under `privacy: zdr` only.
  1. **New `RouteRefusal` values:**
     - `server-tool`: any `tools[].type` starting with `openrouter:`, or an OpenRouter Files reference [G4-4];
     - `provider-options`: a non-empty `provider.options` (inference: arbitrary per-provider options can carry retention settings, so they are refused conservatively);
     - `extended-cache-unattested`: OpenAI gpt-5.5 or later without `extendedCache: true` in the attestation [G3-8, G4-11];
     - `grounding-tool`: any non-function tool on Vertex or Gemini routes (Google's grounding exceptions in its Service Terms; report §8);
     - `durable-cache`: a Vertex project whose cache config is neither `disableCache` nor `EPHEMERAL` [G4-13];
     - `anthropic-non-zdr-feature`, from Anthropic's feature-eligibility table (https://platform.claude.com/docs/en/manage-claude/api-and-data-retention, accessed 2026-11-06): the server-side MCP connector and MCP tunnels, Agent Skills, server code execution, programmatic tool calling, dynamic web-fetch or web-search filtering, the Files API, Managed Agents, and message threads (`/v1/messages` with `thread`). VS-23 already refuses Batch (29-day retention).
  2. **Normalisation of the final body** (after `promptCacheBreakpointBody`):
     - Send `X-OpenRouter-Cache: false`, and refuse `true` [G4-7]. Response caching is off by default and unavailable under account-level ZDR, but a preset can enable it, and a per-request `zdr: true` does not block it. The explicit `false` guards against presets.
     - Send `store: false` on every OpenAI-family request kind under zdr, Azure and Mantle included.
     - On OpenAI models before gpt-5.5, send `prompt_cache_retention: "in_memory"` and strip `prompt_cache_options.ttl`. The spec (openai/openai-openapi master, fetched 2026-11-06) marks `prompt_cache_retention` (`in_memory` | `24h`) as deprecated ("Use `prompt_cache_options.ttl` instead"), with retention "up to a maximum of 24 hours". It defines `prompt_cache_options.ttl` (`30m` | `12h`) as a minimum lifetime, and says "the two fields are independent and do not interact". Stripping `ttl` is therefore a conservative design choice, not a spec requirement. Send whichever retention field the pinned `openai` SDK actually emits, and pin it with a test.
     - On `@ai-sdk/google`, send `store: false`.
     - Re-assert `provider.zdr: true` and `data_collection: "deny"` after every merge [VOI1].
  3. **Structured `zdrAttested` entries:** `{id, operator, project?, region?: eu|us, extendedCache?, verify?: attest|api}`, with `operator` required. A plain string keeps today's meaning, as the legacy form. Sources are unchanged from VS-23 (§1): the user global engine config locally, and the base branch `review.json` in CI. They are never read from env or the working tree.
     - **`verify: "api"`.** Admission makes one metadata call per run. It sends no code, and it refuses on a timeout or on any answer that does not match:
       - Bedrock: `GetAccountDataRetention().mode === "none"`, on the review's own credentials;
       - Vertex: `projects.getCacheConfig` and `fetchPublisherModelConfig` (no data-sharing publisher model), on the review's own credentials;
       - OpenAI: project `data_retention` needs an admin key, which the review key is not. `verify: "api"` is therefore refused for OpenAI entries (attestation only), unless Q20 approves a separate admin credential read from the trusted global config only.
     - The schema change follows the header's regeneration rule (SDK build script, `bun run generate` in `packages/client`, `bun typecheck`).
  4. **Routing:**
     - `decideRoute` treats `eu.openrouter.ai` and `us.openrouter.ai` as OpenRouter. An attested Business or Enterprise account may pin a region, which skips OpenRouter I/O logging [G4-6 *(lane note)*].
     - Route keys and notes name the platform operator.
     - `retention-required-model` also matches Fable and Mythos IDs on Bedrock and Vertex.
  5. **No privacy decision keys on 404 text.** A 404 or 503 that mentions no endpoints, ZDR or data policy only chooses the note wording. Identical retries cannot leak, and model switches stay refused in `admit` [G4-8].
  - **Not in this package.** Vector's own `smallOptions` (`transform.ts:1415-1431`) omits `store: false` for `@ai-sdk/azure` and Bedrock Mantle, and the pinned Responses model defaults `store` to true [G4-19]. `smallOptions` serves every Vector session, so the fix is a general engine privacy fix, filed separately (`fix(provider): send store false on Azure and Mantle helper requests`, with its own tests) and owned outside the VectorScope contract. VectorScope relies on it (Q22 is a note, not a question).
  - **Reuse:** VS-23a's tables and refusal union, VS-23c's recording-fetch tests, and VS-21b's fake provider server. The model-version table lives in one place.
- **Invariants:** I-3 (closes known gaps), I-4, I-1 (under `standard`, nothing changes), I-11 (SDK and client regenerated for the config shape), I-12 (route fields in `EvidenceScope`).
- **Tests:**
  - one fixture per refusal and per normalisation, including a request carrying `thread`;
  - an `extraBody` or `providerOptions.openrouter` replacement of `provider` still leaves with `zdr: true` and `data_collection: "deny"` [VOI1];
  - a settings-level `models` is refused as `fallback-models`;
  - `verify: "api"` against stub endpoints for success, failure, a non-`none` mode, a timeout and a network error. An OpenAI entry with `verify: "api"` and no approved admin credential is refused;
  - a structured entry without `operator` is rejected at parse, and a plain string still parses;
  - config: the structured shape parses from both trusted sources (the global engine config locally; base `review.json` in CI), and is refused from `REVIEW_*` env and from the working tree;
  - the OpenAI retention field: a test pins the field name and values that the pinned `openai` SDK serialises, so an SDK bump that changes the emitted field fails the test;
  - requests of unregistered sessions are byte-identical to today.
- **Done when:** under `engine:privacy-zdr`, every request kind of every seed case shows 0 wire bodies with:
  - an `openrouter:`-typed tool;
  - a non-empty `provider.options`;
  - `X-OpenRouter-Cache: true`;
  - a missing or true `store` on an OpenAI-family request;
  - an unattested extended cache;
  - an Anthropic non-ZDR feature, `thread` included.
- **Measurement and kill.** This is a hard requirement, with no quality kill. The one allowed downgrade is to `verify: "api"` for a single provider. If it falsely refuses an account the owner confirmed in the console more than once, fall back to attestation for that provider and record it in the deviations log.
- **Window:**
  - now, after VS-23a (which alone creates `privacy.ts`, `decideRoute` and `RouteRefusal`): the `RouteRefusal` values and the structured-entry parser in core, over base `review.json` input. The global engine config schema, the SDK build and `bun run generate` land with VS-23d;
  - runner-wiring, after VS-23c: the transport normalisation and the admission metadata calls;
  - later: the Codium gateway (after `codium`).
- **Depends on:** VS-23a to VS-23c; Q1 (D15) for whether zdr is the default.
- **Owner questions:** Q20, Q21. This extends Q2 and Q7.

### VS-34 Pre-dispatch secret holdback for the model payload

- **Problem.** `redact.ts` covers "everything Vector posts" (`redact.ts:1-2`). Untrusted content reaches the model through three channels with no redaction [VT2]:
  1. **The diff and head files.** `Review.run` builds prompts from the raw diff and head files with no redaction (`run.ts:661-685`). A committed `.env`, `.npmrc` or `*.pem` change, or a deletion that removes a key, therefore reaches the model.
  2. **The other untrusted `PromptInput` blocks.** `context.related` (`git grep` hits), history, human comments and PR text also pass no redaction.
  3. **Tool output.** The read tool denies only `SECRET_FILES` plus `*.env`/`*.env.*` (`permission.ts:11-22,67-72`). That list does not cover `.envrc`, `.netrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials`, a root `id_rsa`, `*.pfx`, `*.jks` or `*.keystore`. grep checks read permission per file (`grep.ts:94-109`), so the same gaps apply to grep output.

  I-4 requires everything leaving the machine to pass redaction. Greptile's CLI holds such changes back before upload [GP2, G5-2, G6-15].
- **Design.** Key `holdback: off | secrets`, raise-only (§1). With the key unset, nothing below runs, and permission rules and prompts are byte-identical (I-1).
  1. **Module.** Add a pure `holdbackFiles(files, {headText?, ignored})` in a new `packages/core/src/review/holdback.ts`. It imports `redact.ts`, `brain/scan.ts` and the exported `SECRET_FILES`. A new module is needed because `brain/scan.ts` already imports `../review/redact` (`scan.ts:3`); placing the function in `redact.ts` would create a circular import.
  2. **Whole-file holdback** for key-material paths, checked on the new **or** old path, so deletions and renames away from a sensitive name are covered.
     - **Lists.** The list is `SECRET_FILES`, exported **unchanged** from `permission.ts` for reuse, plus a separate payload-only list:
       - `.env` and `.env.*`, except `.example`, `.sample`, `.template`, `.dist` and `.defaults`;
       - `.envrc`, `.netrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `credentials`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.ppk`, `*.pfx`, `*.jks`, `*.keystore`.
     - **Matching** uses the same `Wildcard` matcher as the permission rules, in which `*` crosses `/` (`permission.ts:9-10`), so nested paths match exactly as the read tool's rules do. minimatch is not used. Each basename entry is written in a root form and a nested `*/` form (for example `.envrc` and `*/.envrc`), as `SECRET_FILES` does; the nested fixture `config/prod/.envrc` tests it.
     - **Tool rules under `holdback: secrets` only.** Add read deny rules for the payload-only list. grep inherits them through its per-file read check. Do not add grep rules keyed on paths: grep's permission pattern is the regex, so such a rule would refuse searches such as `process.env`. Withholding grep output lines from listed paths (`SECRET_FILES` or the payload-only list) stays as a backstop. The read tool's existing exemption (`permission.ts:67-70` allows only `.env.example`) is unchanged. With the key unset, the session permission rules are byte-identical to today.
  3. **In-place value redaction** applies to every untrusted `PromptInput` block that holdback does not drop: diff hunks, head files, `context.related`, history, human comments, the PR title and body, and the VS-25 impact slice. It uses `BrainScan.secrets` and `credential`, plus redact.ts's token shapes, applied through `redactSecrets` (`TOKEN_SHAPES` itself is private, `redact.ts:9`). Values become `[redacted]`, the placeholder `redactSecrets` writes.
     - Today the prompt only tells the security model to write `[redacted]` in its own output (`prompt.ts:125`). It does not say that inputs may be redacted.
     - So, under the key only, add one input-redaction sentence to both prompts: "values shown as [redacted] were removed before sending; do not report the placeholder itself". It enters `promptsDigest` only when `holdback` is set.
  4. **Gitignored-but-committed files** are listed, never dropped silently. The engine computes the ignored list (`git check-ignore --no-index` over the changed paths) and passes it to `holdbackFiles` as input, so the core function stays pure. Greptile drops these files silently; VectorScope must not.
  5. **Recording.** In the now window, `holdbackFiles` returns its own result type (`{held: {path, oldPath?, reason}[]; redactions; ignoredCommitted}`), with no union change. In runner-wiring, held-back files are recorded with a new `SkippedFile.reason` value, `held-back` (`types.ts:157`), which I-7 already reports as not reviewed. Its labels are added to the three exhaustive `Record<SkippedFile["reason"], string>` maps (`format.ts:61`, `review.render.ts:44`, `ai-review.ts:147`). They do not go into `state.unreviewed` (`types.ts:147`). That would block the `already-reviewed` skip (`skip.ts:66-67`), and every trigger would re-review, at full cost, a PR that commits a credential file.
  6. **Note.** A deterministic, zero-token note: "a possible credential is committed in X (its value was not sent)".
  7. **No PR-text override.** A trusted override comes only from base config or the user global config.
  8. **Placement.** Holdback, and the in-place value redaction of item 3, apply in `Review.run` before prompt building and to every read and grep tool result before it enters the next request. The desktop `ai-review.ts` calls the same function, or records a difference (§1a).
- **Invariants:**
  - **I-4**, closed for the payload under `secrets`: the diff, head files, every untrusted `PromptInput` block, and all read and grep tool output (held-back paths withheld, grep through its read check; other paths value-redacted);
  - **I-7**: held-back files are "not reviewed", never clean;
  - **I-2**: no PR-controlled include; raise-only sources;
  - **I-1**: tool permission rules and prompts are byte-identical with the key unset.
- **Tests:**
  - about 40 fixture diffs: every token shape, PEM blocks, `.env` changes, a key deletion, a rename of `id_rsa` to `notes.txt`, nested paths (`config/prod/.envrc`), and false-positive bait (`tokenizer`, placeholders, `process.env.X`, fake test keys);
  - wire-body assertions through the VS-21b projection, covering a secret placed in `context.related`, in a human comment, in the PR body, in history and in the impact slice;
  - a projection fixture whose canned model output calls read and grep on a held-back path. It asserts that no secret string appears in the next wire body;
  - a projection fixture whose canned model output reads a non-listed file containing a token shape. It asserts that the token is absent from the next wire body;
  - the session permission rules are byte-identical with the key unset. With it set, they differ only by the added read deny rules;
  - under the key, a grep for `process.env` is still allowed, and a directory grep over a tree holding `config/.envrc` returns no line from it;
  - a held-back file appears in `skipped` with `held-back`, not in `unreviewed`, and a re-trigger on the same head still takes the `already-reviewed` skip;
  - `holdbackFiles` is pure: given the same `ignored` input, it returns the same result, and it makes no git calls;
  - the input-redaction sentence is absent, and `promptsDigest` unchanged, with the key unset;
  - a config test that no source can lower `holdback` set by another;
  - parity with the key unset.
- **Done when:** under `holdback: secrets`, 0 secret-shaped strings appear in any recorded wire body, across seed cases, fixtures and the tool-call projection fixture.
- **Measurement and kill.**
  - Report the redaction false-positive rate: the share of files with at least one redaction that holds no real secret.
  - If any VS-22 bug case loses its defect location to holdback, narrow that rule.
  - If more than 2% of non-secret files are redacted, drop the generic assigned-secret pattern and keep only the token shapes.
- **Window:**
  - now: pure, after VS-21 and VS-22a, as the contract sequences them;
  - runner-wiring: the `Review.run` call, the tool rules, the ignored-list computation, and the `held-back` reason with its labels.
- **Depends on:** nothing in code. It shares a scanner with VS-18. VS-24 notes, VS-27 `incomplete` and VS-32 use the `held-back` reason.
- **Owner questions:** Q23.

### VS-35 Guarded team memory

*Merges P7 (economy and trust) and P-4 (precision). Amends approved VS-11 and VS-20.*

- **Problem:**
  - `classifyPrior` (`state.ts:278-310`) accepts an author's dismissal for every finding except blocking security.
  - `teamPatterns` reads dismissed markers across the repository with no actor, role or age filter [FL1].
  - The trusted prompt line "anything that matches `<team_dismissed>` unless it is clearly more serious" (`prompt.ts:243`) suppresses on one pattern, in the security pass too, and nothing is logged [FL2].
  - Agent loops resolve threads by instruction [FL9, G6-16].
  - "Fixed" can rest on the model alone [FL18].
  - In effect, PR-author actions act as a suppression verdict, which I-2 forbids.
- **Design.** Key `teamMemory: legacy | guarded`.
  1. **Provenance.** When a finding's status becomes dismissed, write a second hidden marker: `<!-- vector-dismissal by=w|a why=fp|wontfix|thumbs|resolved|cmd h=<12-hex salted hash> -->`. The finding-marker regex (`FINDING_MARKER`, `state.ts:85-86`) is untouched. Legacy readers ignore the new marker. Under `guarded`, dismissals without it count as role unknown and are excluded. Markers are written only under `teamMemory: guarded`. With the key unset, comment bodies are byte-identical; parity test in the `github.review` tests after the merge.
     - **Salt.** The hash is an HMAC of the login, keyed with a repository secret (for example `VECTOR_DISMISSAL_SALT`) that stays secret and stable across runs and PRs. The @vector owner adds it to the generated workflow after the merge; VectorScope does not edit the @vector-owned workflow. Without the secret, guarded mode writes no marker and notes why.
     - At least 12 hex characters (48 bits), so distinct writers do not collide in practice and the "2 distinct writers" gate holds.
  2. **Who counts.** Only `by=w` (a writer who is not the PR author) counts. A pattern needs at least 2 distinct writer hashes in the same directory, within a window that starts at 90 days and is swept. Author dismissals still close findings inside their own PR.
  3. **Never suppress.** The security pass gets an empty `<team_dismissed>` block. Some findings skip both the prompt rule and `teamPenalty` (`select.ts:114,222-231`): category security, severity blocking, any `FailureClass` under `guardrail: strict`, and crash or data-loss wording.
  4. **Demote, don't silence.** The prompt rule becomes: "report a matching finding at most as a concern and name the pattern". Selection records a new `DropReason`, `team-dismissed`, for any drop or demotion.
  5. **Exclude-only signals.** These are excluded from learning:
     - batches of 5 or more threads resolved by one actor within 60 s, with no reply and no code change;
     - dismissals within 2 minutes of a push by a bot login;
     - model-only `fixed` outcomes, as positive labels;
     - Vector's own comments.
  6. **Durable learning** goes to Brain as pending `review` proposals with citations and scope. A proposal needs at least 3 writer dismissals from at least 2 people, and only the owner activates it [FL13]. Never active by default. There is no cross-repository fallback.
- **Invariants:** I-2 (actors and untrusted signals may only exclude data), I-7 (suppression becomes visible), I-1, I-9 (marker writes and repository-wide reads are in `github.review.ts`).
- **Tests.**
  - **Pure tests (now, on synthetic data).** These run on synthetic comment bodies that already carry `vector-dismissal` markers, because no real markers exist before the marker window. They cover:
    - writer counting by distinct hash and directory;
    - the window;
    - the never-suppress set;
    - the demotion rule (the `team-dismissed` drop record in `select.ts` is tested in runner-wiring with the D3 parity tests);
    - the exclude-only rules.
  - **VS-22 adversarial fixtures**, with synthetic markers:
    - (a) a real blocking or security bug whose title is at least 0.5 similar to an injected dismissed pattern: legacy suppresses it, guarded posts it;
    - (b) author-only and agent-bulk dismissals never enter `teamPatterns`;
    - (c) non-writer reactions never count (a regression test for brigading [FL6]).
  - **Markers.** A round-trip with old parsers. A collision test: under one salt, distinct logins never share a hash across a large synthetic login set, and the same login always gets the same hash.
- **Done when:**
  - the pure tests above pass;
  - the `team-dismissed` count appears in `--json` and replay artifacts;
  - after the marker window: guarded loses 0 blocking defects to adversarial patterns across at least 10 replays that carry real `vector-dismissal` markers. This criterion can only be met after markers are written. Before that, guarded mode has no team memory, so it would pass trivially.
- **Measurement and kill.**
  - Replay with seeded genuine-writer and adversarial-author patterns.
  - Kill the count gate (keep demotion and the never-suppress set) if guarded raises false alarms per clean PR by more than 0.05, or lowers precision by more than 2 points, with no recall gain on the fixtures.
  - If legacy loses no defect to adversarial patterns across 10 or more marker-carrying replays, keep `guarded` only as logging.
- **Window:**
  - now: pure core helpers, uncalled by `prompt.ts` and `select.ts`: the guarded pattern filter over marker-carrying comment bodies, the never-suppress predicate and the demotion rule, with the synthetic-marker tests. `teamMemory` is not parsed yet, so the unknown key warns;
  - runner-wiring: the config parse, `prompt.ts`'s guarded rule and empty security block, and `select.ts`'s demotion and `team-dismissed` record, with D3 parity tests in `run.test.ts` and `ai-review.test.ts`;
  - later (after `vector-at-mention`, and once the @vector owner adds the salt secret): marker writes, role passing and `TeamPattern` provenance (writer hashes) from `github.review.ts`, then the 10-case done criterion;
  - after VS-11: the Brain proposal route.
- **Depends on:** VS-22a follow-up (adversarial cases, §3), VS-21a (artifact fields). It changes VS-11 and VS-20.
- **Owner questions:** Q24.

### VS-36 Gate-first dependent discovery with fused ranking and stage-wise slice recall

*Amends VS-25b steps 2 to 4.*

- **Problem.**
  - **Order.** VS-25b caps `git grep` output (in path order) at 200 files *before* the import gate. In a simulation on 40 real Kubernetes commits, that order lost import-gated dependents in 65% of commits (median 16 of 20) [G1-10].
  - **Ranking.** Candidates are otherwise unranked.
  - **Records.** `ImpactSlice` records only what was packed, so a miss cannot be attributed to a stage.
- **Design.** Under `impact: graph`, no new key.
  1. **Candidates.** One combined `git grep -l -w -F -e <name>…` over the changed exported names, with no cap [G1-7]. Above 5,000 candidates, intersect with a second `-l -F` grep for the changed module's basename or package specifier.
  2. **Gate before cap.**
     - Read candidate blobs with a single `git cat-file --batch` on objects of the head tree-ish (I-8 amendment below) [G1-12].
     - Keep only files whose `BrainCode.imports`/`resolve` reach the changed module.
     - Parse-confirm references for at most 200 gated files.
  3. **Rank** with reciprocal rank fusion (k = 60) [LCI7] of:
     - (a) `BrainGraph.rank`, seeded on the changed files;
     - (b) a pure lexical score: a definition or import-site hit counts 5 times a plain reference, and test, vendored and generated files are divided by 5 [LCI6];
     - (c) `BrainCode.coChange`, when history is present, ranked below static edges (inference).
  4. **Do not pad.** An empty slice is valid, and abstention is structural, never decided by score [RR8, RR2].
  5. **Records.** `ImpactSlice` gains `stages: {candidates, prefiltered, gated, confirmed, packed}` and `dropped: {prefilter, gate: string[], cap, budget}`, where `dropped.prefilter` holds the count and the first 20 paths.
  6. **Placement.** Code goes in core `review/impact.ts` (pure) and engine `review/impact.ts`. Fusion weights freeze before the held-out split.
- **Invariants:** I-8, amended; I-10 (no third code reader); I-7 (drops recorded); I-12; I-13.
  - **I-8 amendment (proposed).** I-8 lists only `git show` and `git grep` of the head tree-ish for fork reads. Amend it to also allow `git cat-file --batch` on objects of the head tree-ish. The two are equivalent in what they read. The amendment needs owner approval with Q18.
- **Tests:**
  - order tests: gate before cap;
  - an RRF determinism test;
  - an empty-slice test;
  - stage counts consistent with locations;
  - the multi-name grep returns the same file set as per-name greps;
  - a barrel re-export importer and a tsconfig-alias importer are either kept or counted in `dropped.prefilter`;
  - a parse test for the I-8 amendment: a fork read through `cat-file --batch` accepts only objects of the head tree-ish, and refuses a working-tree path.
- **Done when:** the VS-21 projection reports stage-wise slice recall on three sets:
  - VS-22 cross-file cases (target at least 30);
  - the AACR permissive repo-level comments;
  - the 40-commit Kubernetes set.
- **Measurement and kill.**
  - Compare at equal packed tokens: VS-25b as written, gate-first with graph rank only, and gate-first with fusion.
  - Revert to the written order if gate-first does not raise gated-stage recall by at least 10 points.
  - Drop the lexical and co-change rankers if fusion does not beat graph-only by at least 3 points of packed recall.
  - Demote the gate from a filter to a ranking feature if its false-drop rate on labelled cases exceeds 20%.
  - p95 must stay at or below 5 s per file-count band (VS-38).
- **Window:** now (core and the uncalled engine file); wiring together with VS-25b wiring.
- **Depends on:** VS-25a and VS-25b, VS-22 (cross-file labels), VS-21b.
- **Owner questions:** none new; the I-8 amendment goes with Q18.

### VS-37 Three-tier slice packing

*Amends VS-25b step 5.*

- **Problem.** VS-25b packs only inbound dependents, so two kinds of context are missing:
  - File and enclosing scope. About 34% of AACR comments are file-level, against about 15% repo-level (chart only; paper counts unverified). 78.5% of ReviewBench high-severity findings need the diff plus related files [LCI2, G6-12].
  - Forward signatures of what the changed lines call [LCI8, RR7, RR6].

  A single cap for every model also ignores model-specific sensitivity [RR5].
- **Design.** Inside `impact: graph` and the existing 6k-token cap, packed in order:
  - **Tier a:**
    - Contents: the full enclosing definition of each hunk (at head, and at base for removed code), plus the class, struct or impl header, plus the import lines the changed lines use.
    - Skipped when the changed file is already inline.
  - **Tier b:**
    - Contents: depth-1 outbound signatures only, at most 10.
    - Identifiers on changed lines are resolved with `BrainCode.resolve`, and deduplicated against the diff and tier a.
    - Declaration files of dependencies (`.d.ts`, `.pyi`) are allowed within the cap (design choice).
    - The standard library and parameter declarations are skipped.
  - **Tier c:** VS-36's ranked call sites, with windows widened to the enclosing statement (at most 8 lines).
  - **Eval-only parameters.** Tier shares and dependent top-k (1, 3, 5) are eval-only parameters recorded in the artifact's variant record (the VS-21a follow-up in §1), not user keys. Until that follow-up lands, they are swept only in offline projections.
  - **Fallback note.** A one-line `<untrusted_impact>` note names any tier that fell back, for example: unsupported language, a file over the cap, missing dependency source [LCI18].
- **Invariants:** I-1, I-8, I-12, I-13 (tier shares freeze before held-out).
- **Tests:**
  - dedupe between tiers;
  - tier a is skipped when the file is inline;
  - the cap is never exceeded;
  - the fallback note text;
  - a declaration file bounded by its per-file cap.
- **Done when:** the projection reports, at equal packed tokens, with p50 and p90 tokens used:
  - slice recall per context level (hunk, file, repo);
  - for the tier sets c-only, a+c and a+b+c;
  - for top-k 1, 3 and 5.
- **Measurement and kill:**
  - Tier b stays off if it adds less than 3 points of file- or repo-level location recall at equal tokens.
  - Tier a stays off if it drops tier-c recall by more than 5 points.
  - In the funded ablation (Q9), drop any tier that lowers diff-level recall by more than 5 points against `engine`.
  - Report the C, C++, C# and PHP cases separately, since they are outside the grammar set [VOI13].
- **Window:** now; wiring with VS-25b.
- **Depends on:** VS-36, VS-25a, the VS-22a follow-up (the context-level label, §3).
- **Owner questions:** none new.

### VS-38 Monorepo-scale Tier 1 execution plan

*Amends VS-25b and VS-25's Phase A gate.*

- **Problem:**
  - Tree-ish grep makes p95 fail at Linux scale: 5.9 s [G1-9] (Linux is not D8-clean, so this figure is gated on Q26; Phase A re-measures on a permissive repository of 50k files or more, such as llvm-project or rust-lang/rust).
  - Partial or sparse clones silently miss dependents or blow the budget [G1-11].
  - Whole-repository parsing takes 30 s (Kubernetes) to 145 s (Linux, gated on Q26) [G1-8].
  - VS-25 has no time box and no clone-mode detection, and its single pooled p95 was measured on mid-sized repositories [G1-3, G1-5].
- **Design.** Inside engine `review/impact.ts`, under `impact: graph`.
  1. **Scan plan, zero tokens, once per review.** Read `git version`, `extensions.partialClone` and `remote.*.promisor`, and `core.sparseCheckout`. Check whether HEAD equals the review head with a clean tree. Use working-tree grep only in that case (the local CLI on its own branch). Otherwise use tree-ish grep, and always for forks (I-8).
  2. **Pathspec scoping.** Scope to the languages that can import the module. In workspaces, also scope to the packages whose manifests depend on the changed package.
     - This uses the workspace-manifest resolution that VS-25b adds to `brain/code.ts`. If VS-25b does not add one, a new pure helper there (`workspaceDependents`) does the job.
     - It is not `BrainCode.dependencies` (`brain/code.ts:466`), which resolves a file's own import specifiers to repository files.
  3. **Partial clones.** Read gated candidates through one `git cat-file --batch`. In a partial clone, it fetches missing blobs on demand, for the candidate set only, within the time box. When that cannot finish inside the box, set `incomplete: "partial-clone"`.
     - **No lazy fetch in search.** When `extensions.partialClone` or `remote.*.promisor` is set, every `git grep` call, and every `cat-file` read outside the gated candidates, runs with lazy fetching off (`GIT_NO_LAZY_FETCH=1`, git 2.44 or later; on older git, the tree-ish grep is skipped). It searches only blobs present locally, and sets `incomplete: "partial-clone"` with the count of unsearched paths. Only the missing blobs of gated candidates are fetched on demand, inside the time box.
     - No `git backfill`. It downloads the missing blobs reachable from the history it walks, not just those of the reviewed tree. On a blobless clone of a large repository that cannot fit the roughly 4 s time box, and it writes into the user's object store.
  4. **Adaptive time box** at about 4 s. Steps are ordered so an early stop still yields a usable slice, and a stop sets `incomplete: "time"`.
  5. **Parser safety.**
     - Catch parser exceptions per file, and keep VS-25a's caps.
     - Add a deep-nesting fixture [G1-15].
     - C, C++, C# and PHP use VS-25b's `changedSymbols` plus `git grep` fallback and are reported separately. If a C grammar is ever added (an owner decision), its definitions are low-confidence (69% error trees on kernel-style C) [G1-8].
  6. **Records.** `ImpactSlice` gains `{plan, gitVersion, grepMs, parseMs, incomplete?}`. When the slice is incomplete, a one-line "context considered" note goes to the model (wrapped) and to the review notes [LCI16].
  7. **Coverage (design statement, not a question).** Impact incompleteness is context incompleteness, not coverage. Every changed line is still reviewed, and I-7 concerns changed-line coverage. So impact incompleteness is an informational note only, and never sets `StrictResult.complete` to false.
- **Invariants:** I-7, I-8, I-1, I-5 (time box).
- **Tests:**
  - working-tree and tree-ish plans give byte-identical slices on clean checkouts;
  - a dirty tree forces tree-ish;
  - partial-clone and sparse detection;
  - the time box sets `incomplete`;
  - on a partial clone, no command fetches or prefetches objects outside the gated candidate set (a recording git wrapper asserts the requested object IDs);
  - on a blobless clone, a recording git wrapper shows the candidate grep ran with lazy fetching off and requested no object IDs;
  - impact incompleteness never changes `StrictResult.complete`;
  - the deep-nesting fixture.
- **Done when:** the Phase A latency gate reports p50 and p95 grep, parse and total time by file-count band (under 10k, 10k to 50k, 50k or more). The bands include at least one permissively licensed repository of 50k files or more, and one blobless-sparse case.
- **Measurement and kill:**
  - Any mismatch between the two plans on a clean checkout disables the working-tree optimisation.
  - If `incomplete: "time"` or `"partial-clone"` fires on more than 10% of cases in the 50k-or-more band, reopen the budget, or trigger the conditional fact cache (§3, VS-25).
  - If p95 already holds in every band with tree-ish grep alone, skip the scoping code.
- **Window:** now; wiring with VS-25b.
- **Depends on:** VS-25a and VS-25b, VS-36.
- **Owner questions:** Q26.

### VS-39 PR-calibrated risk axes

*Amends VS-28.*

- **Problem:**
  - Commit cutpoints put 56% of PRs, and 86 to 96% of lines, in the high band on Martian (gated on Q10) and ReviewBench [G2-1].
  - At PR level, the points score does no better than raw size (AUC 0.60 against 0.70) [G2-7, G2-2].
  - Findings per kLOC are densest in the low band [G2-3].
  - `RiskFeatures` mixes likelihood with impact [RP7].
  - The fix regex counts reverts together with fixes, and matches substrings [G2-9, RP4].
  - Finding caps confound the lens gains [G2-6].
  - Diff budgeting inlines files in input order [RP14].
- **Design.** In core `review/risk.ts` (pure), under `depth: auto` and `lenses: high`.
  1. **`riskOf` returns three axes plus reasons:**
     - **Likelihood:** log(added + deleted), with directory count and entropy as tie-breakers [G2-2, RP12].
     - **Reach:** gated dependent files from VS-25 or VS-36, recorded as `missing` when the slice is off.
       - The starting thresholds, narrow ≤ 3, moderate ≤ 25 and wide above, are PR-Agent's project-count thresholds [RP8].
       - Using them as starting points for file counts is inference. They are refit in the Phase A band analysis below.
     - **Impact flags:** a sensitive path and a deletion-heavy change.
       - Each raises the band to at least medium, and sensitive plus wide reach gives high [RP6, RP7, RP8].
       - `testDelta` never lowers the band. A PR is "test-only" when every changed file is a test file by path classification and no non-test file changed. Only a test-only PR is marked low by this flag.
  2. **Cutpoints** are percentiles of a PR population, with the high band holding at most 20% of PRs.
     - **Seeding.** They are seeded from numstat (diff statistics only) of VS-22, the AACR permissive subset and ReviewBench (Q27).
     - **Coverage.** The round-two band analysis covered 131 of AACR's 140 permissive positive samples and 48 of Martian's 50 PRs; the rest could not be fetched (report §5.2 note). The Martian part is subject to Q10.
     - **Refit.** Cutpoints are refit per repository after 200 or more of its own PRs [RP13, G2-8].
  3. **History** (churn, and fix commits matched with a word-anchored regex) goes into explanation text only. Reverts are their own feature. This is a design decision, not an owner question: fix density adds about +0.00 AUC at commit level [RP4, RP10, RP19, G2-9]. A later +1 point is allowed only if VS-46 shows separation with an interval excluding 0.
  4. **Re-reviews.** Under `rereview: focused` (VS-41), the band is computed on the focus hunks; otherwise on the whole PR [GP8, GP12].
  5. **`order(files)`** ranks files by risk density. `budgetDiff` uses it (only under `depth: auto`), and so does VS-19 batching [RP14].
  6. **Cost** is projected from the high band's share of changed lines, at a model cost of 1 + k × (0.03 to 0.17) for k lenses.
     - The range comes from Kodus's heavy mode, over nine lenses: 1.3 to 2.1 times the tokens (0.03 to 0.12 per lens) and about 2.5 times the model cost (about 0.17 per lens) (vendor) [RP5, G3-11].
     - Token projections use 0.03 to 0.12, and say so.
  7. **Effective depth.** An explicitly requested depth that cannot run fails loudly, and the effective depth is recorded [G6-2].
  8. **Never posted.** The band never feeds `Selection.risk`, and it is never posted as a prediction. It appears in the run's notes. It appears in `--json` (through VS-47) only if Q28 is answered yes [RP18, C-8].
- **Invariants:** I-1, I-2 (no untrusted input), I-12; C-8 respected.
- **Tests:**
  - band truth tables;
  - raise-only floors;
  - `testDelta` never lowers the band of a PR that changes any source file;
  - a test-only PR (all changed paths classified as tests) is marked low;
  - the regex does not match "prefix" or "debug";
  - percentile refit at 200 PRs;
  - `order()` is stable and deterministic;
  - CI and local band agreement;
  - with Q28 unanswered or no, the band is absent from `--json`.
- **Done when (Phase A, zero spend):**
  - band shares of PRs and of lines are reported on the three populations, with the high band holding at most 20% of PRs and at most 50% of lines;
  - the reach thresholds are fitted on gated-file counts and reported against the PR-Agent starting points;
  - the low band is projected at or below baseline cost;
  - CI and local bands agree on at least 85% of PRs and never differ by more than one band [RP4];
  - recall on high-severity goldens by band is reported from existing artifacts [G2-5].
- **Measurement and kill:**
  - The funded Q9 ablation adds a **mandatory equal-token control arm**: a raised finding cap, or VS-19 chunking, on the high band. Lenses stay off unless they beat the control with an interval excluding 0, scored as high-severity recall per extra dollar.
  - Drop reach from depth (keep it in reasons) if, within every size tercile, high-severity recall by band with reach differs from recall without it by less than 3 points, or its 95% interval includes 0.
  - Refit if the high band exceeds 25% of PRs.
- **Window:** now (`risk.ts`); runner-wiring (VS-28 wiring).
- **Depends on:** VS-28, VS-36 (reach), VS-22, VS-21b.
- **Owner questions:** Q27, Q28.

### VS-40 Estimator v2

*Amends VS-24's `dispatch.ts`.*

- **Problem:**
  - `plan.ts` has three flaws:
    - it prices growth as never cached, with no cache-write premium;
    - it uses an `OUTPUT_PER_STEP` of 600, against a measured 1,800;
    - it was fitted on one review [G3-15].
  - VS-24's shrink order never touches step caps, a major token lever (inference): capped and uncapped reviewers differ by 5.4 to 14.7 times [G3-2].
  - The per-PR cap check fires only after the cap is crossed (`skip.ts:68-69`), so the review that crosses it starts and goes partial.
  - Whether agent cost per run has a heavy tail is not measured yet (inference). The $2 check below measures it.
- **Design.** In VS-24's `review/dispatch.ts`. `estimateCostUsd` gains optional `{cacheReadShare?, writePrice?, outputPerStep?}` inputs whose defaults reproduce today's numbers (a test pins that), and `dispatch.ts` calls it for v2, so the two estimates cannot drift apart (I-10). `nextStepCostUsd` and `OUTPUT_PER_STEP` stay unchanged for existing checks (I-1). The pipeline pin is updated.
  1. **Per-pass cost:**
     - input = S·P + R·S(S−1)/2;
     - cache-read share h(S) = 1 − (P + (S−1)R) / (S·P + R·S(S−1)/2) [G3-6];
     - effective input price = h·cacheRead + (1 − h)·writePrice, where writePrice is the catalog's `cacheWrite`, else plain input;
     - output = S·`calibratedOutputPerStep` (start at 1,800).
     - Constants carry their fit date and cases. Without caching or a last-message breakpoint, fall back to catalog prices.
  2. **Shrink order:** lenses, then cards, then **step caps** (verify, security, review), then the lowest-ranked dependents, then diff trim.
     - Each step-cap shrink lowers a pass's cap to a fixed fraction of its current cap, never above the current cap. Verify already runs at `VERIFY_STEPS = 10`, `run.ts:222`.
     - The fraction is 50% in the pilot. Other fractions are swept only in projections (tokens) or the funded ablation (quality, Q9).
     - Each step is re-estimated and recorded.
  3. **`remainingUsd`** = min(`maxCostUsd`, `maxCostUsdPerPr` − prior PR spend, month remainder). A review whose low estimate exceeds it shrinks, then stops with `budget-estimate` at zero attempts [G3-9].
     - Prior spend and the month remainder exist only in the GitHub job today (`skip.ts` inputs); `RunInput` (`run.ts:93-131`) carries neither.
     - Add `RunInput.spent?: {prUsd, monthUsd}`. Without it, `remainingUsd` = `maxCostUsd`, which is what the CLI uses. The desktop runner has no dollar cap (§1a).
  4. **Fan-out hold.** The fan-out hold waits at most 5 s for the first specialist to stream. This is a fixed design choice in the pilot; any sweep happens in projections or the funded ablation (Q9), not in the D5 pilot.
  5. **The VS-21c report** gains:
     - cost per verified finding and per true positive;
     - estimate error per pass;
     - predicted against observed cache-read share;
     - step-cap hit rate [GU9].
- **Invariants:** I-5 (estimates are estimates; zero-attempt stops), I-1, I-10, I-7 (stops read "Not reviewed"), I-9 (the GitHub half of `spent`).
- **Tests:**
  - h(S) against hand-computed values;
  - `estimateCostUsd` with none of the new inputs returns today's numbers;
  - the shrink order, and that a shrunk cap never exceeds the current cap;
  - zero attempts on an admission stop;
  - the per-PR remainder includes prior spend when `spent` is passed, and equals `maxCostUsd` when it is not;
  - parity with VS-24's keys unset.
- **Done when:** projections report v2, legacy and projected tokens per pass for every seed case.
- **Measurement and kill:**
  - Keep the legacy constants in the gate unless v2's median absolute estimate error on the pilot runs is at least 5 points lower. This uses runs the pilot makes anyway; no extra arms.
  - Move step caps after dependents in the shrink order if any pilot case loses a verified finding when the step-cap shrink fires.
  - Before keeping the $2 default, measure the share of runs that a cap at 3 times the calibrated median would stop.
- **Window:**
  - now: pure;
  - runner-wiring: with VS-24 wiring, `RunInput.spent` and the CLI `maxCostUsd` path;
  - later, after `vector-at-mention`: passing `spent` from `github.review.ts`.
- **Depends on:** VS-24, VS-21c, D7 for the pilot.
- **Owner questions:** none new; the desktop cap question is Q32.

### VS-41 Focused re-reviews

- **Problem.** Incremental review is on by default (`types.ts:256`), but each re-review costs as much as a first review:
  - security is planned over the whole PR (`run.ts:690-700`), so any sensitive file re-runs the security pass on every push;
  - step caps are full;
  - prior findings are re-verified.

  Greptile, Copilot and PR-Agent default push re-review to off [GP5, CF2, CF3], and billing complaints centre on per-trigger cost [GU16]. Base-merge exclusion and rebase carry already exist and are kept.
- **Design.** Key `rereview: full | focused`.
  1. **Under `focused`, for `mode: incremental` only:**
     - specialists are planned over the focus files, and security runs only when a focused file is sensitive or a prior security finding is open;
     - step caps come from `rereviewSteps`, an eval-only parameter recorded in the artifact's variant record (the VS-21a follow-up in §1), not a user key. Its defaults are ceil(maxSteps/2) for review and ceil(maxSteps/3) for security. Any sweep of it runs in projections (tokens) or the funded ablation (quality, Q9), never in the fixed D5 pilot;
     - verify gets new candidates only, because prior findings are matched deterministically (`select.ts` step 6);
     - the prompt keeps the whole diff as context, and asks for findings in the focus hunks plus their interactions.
  2. **Zero-token self-fix carry.** A finding is marked fixed with no model call only when all of these hold:
     - every commit since the last head is authored and committed by the bot identity, read from the GitHub API, never from trailers;
     - every hunk equals the post-image of a posted committable suggestion of an open Vector finding (`applyPatch`, `matchPostImage`);
     - the commits change nothing else.

     Any other bot commit is re-reviewed on its own range [CF12].
  3. **`reviewRun: initial | subsequent`** is recorded in the replay artifact. It enters `EvidenceScope`, and `ScopeChange`, only when `rereview: focused` is set (I-12). `rereviewSteps`, when set, is recorded in the variant record.
  4. **Reporting.** The re-review share of PR spend, and cost per push, go into the replay artifact and VS-21c.
- **Invariants:** I-1, I-2 (bot identity from the API), I-5, I-12, I-9 (the GitHub half).
- **Tests:**
  - an exact suggestion commit is carried;
  - a bot commit with one extra line is not;
  - a human commit matching a suggestion is not;
  - focused planning skips security only when no focused file is sensitive and no security finding is open;
  - `rereviewSteps` is never read from config or env;
  - with the key unset, `EvidenceScope` and certificate matching are unchanged;
  - parity with the key unset.
- **Done when:**
  - the projection reports tokens and USD per push, full against focused;
  - VS-22 holds at least 15 multi-commit sequences, through the VS-22a follow-up schema change (§3): at least 5 interaction cases (a defect introduced via an unfocused file) and at least 5 clean later commits.
- **Measurement and kill.** In the funded ablation (Q9), measure paired recall on later-commit defects, focused against full. If focused is more than 5 points lower, or misses more than 1 interaction case, keep only the self-fix carry and the reporting.
- **Window:**
  - runner-wiring: the engine and CLI half;
  - later (after `vector-at-mention`): the GitHub bot-identity half.
- **Depends on:** VS-24 (`PassPlan`s), VS-21c, the VS-22a follow-up (multi-commit cases), VS-39 (focus-hunk band).
- **Owner questions:** none new.

### VS-42 Introduced-by-change gate (S9)

- **Problem.**
  - S3 requires only that the anchor sit on a changed line, so a defect that already existed at base can be posted as blocking.
  - The rubric scores "not a defect in this change" as a false alarm (`script/vectorscope-eval/judging-rubric.md:39` at 7cadfcb8).
  - In ReviewBench's goldens, 173 of 2,623 true positives (6.6%) are labelled `pre-existing` and 59 (2.2%) `exacerbated-by-pr`. ReviewBench still counts them as true, because its scope label is informational [G6-13].
  - The rubric of OpenAI's open-source coding-agent CLI forbids flagging pre-existing bugs [CF10].
- **Design.** Key `scopeGate: off | introduced`, applied inside `strictSelect`, so it is **effective only with `guardrail: strict`**. Set without it, the key is ignored with a note.
  1. **Schema.** Only when `scopeGate: introduced` is set, the strict report schema (VS-27a) gains `scope: introduced | exacerbated | pre-existing`, required on blocking findings. With the key off, the strict schema and the `guardrail: strict` digests are unchanged.
  2. **Suspect check.** A pure `preExistingSuspect(finding, head, base, files)` in `guardrail.ts` is true when all of these hold:
     - every RIGHT quote (and every VS-44 trace quote) appears unchanged in the base blob after `normalizeCode`;
     - no quote touches an added or modified line. This uses `resolveAnchor`, plus `changedSpans` exported from `diff.ts` (private today, `diff.ts:648`), or the existing `touched` helper;
     - the anchor is RIGHT;
     - the finding is not a deletion defect.

     Exceptions:
     - LEFT anchors are exempt;
     - renames use `DiffFile.oldPath`;
     - when the base blob is unreadable, do not demote.
  3. **Drop rule.** A finding is dropped with a new `StrictDrop`, `pre-existing`, in either case:
     - the model says pre-existing;
     - it is a suspect without an `exacerbated` claim backed by a quote on a changed line.

     The drop is counted in `StrictResult.dropped` and in notes. It is not moved into the summary, because the rubric counts summary listings as posted.
  4. **Prompt clause** under the key: "do not report bugs that exist at the merge-base unless this change makes them reachable or worse".
- **Invariants:** I-2 (model labels can only drop), I-7 (counted), I-1, I-12.
- **Tests:**
  - fixtures: a pre-existing bug beside a benign edit (dropped);
  - a change that makes an old latent bug reachable (kept as exacerbated);
  - a rename (`DiffFile.oldPath`);
  - a LEFT-anchored deletion defect;
  - an unreadable base (kept);
  - the key set without `guardrail: strict` has no effect, and emits the note;
  - a model-evidence test: with `scopeGate` off, the `engine:guardrail-strict` `promptsDigest` and schema digest equal today's.
- **Done when:**
  - the pure code and its deterministic tests are merged;
  - the annotation guide has a "not in this change" tag;
  - the re-selection pre-check below has run once settled artifacts exist.
- **Measurement and kill:**
  - **Pre-check timing.** The zero-spend pre-check re-selects saved artifacts. It needs human-settled findings, which exist only after the D7/D5 pilot or once seed replays are settled. It runs on the first settled artifacts. Until then, only the deterministic tests gate the merge of the pure code.
  - Kill if the rule drops more than 2% of settled true positives, or removes under 20% of the false alarms that annotators tagged "not in this change".
  - In Phase C, as part of a `precise` candidate: report the precision change with an interval, and class-scoped recall within 5 points (D2).
  - External comparisons (VS-21) must state that S9 drops pre-existing findings, which ReviewBench counts as true.
- **Window:**
  - now: `preExistingSuspect`, the `pre-existing` drop in `strictSelect` and the deterministic tests;
  - runner-wiring: the prompt clause and the `scope` schema field reaching the model, with VS-27c.
- **Depends on:** VS-27a and VS-27b, the VS-22a follow-up, VS-21b.
- **Owner questions:** none new.

### VS-43 Rule citations checked against trusted rule text

- **Problem.** `ModelFinding.rule` is parsed (`schema.ts:266`) and rendered into posted comments (`format.ts:317-319`), but never compared with the trusted rules. A finding can do any of these:
  - cite a rule that does not exist;
  - misquote one;
  - ignore a rule's path scope;
  - cite a rule the PR itself added at head.

  The posted comment then presents model output with repository authority, against I-2.
- **Design.** Key `ruleCheck: off | strict`.
  1. Under `strict`, `rule` becomes `{source: repository_instructions | review_rules | paths[i] | scoped:<path>, quote, lines?}`.
  2. **A pure `ruleCited(finding, trusted)` check.**
     - **Quote.** The whitespace-normalised quote must be a substring of the exact trusted text that `trusted()` sent, whatever its `rulesSource`. That is `base branch` in CI, and `working tree` for trusted local CLI and desktop runs (`review.ts:448`, `run.ts:680-682`, `ai-review.ts:842-843`). The `rulesSource` is recorded per finding.
     - **Clipped text.** To make the clipped text available, `trusted()` returns it alongside the prompt (or `MAX_TRUSTED_CHARS`, private in `prompt.ts:102`, is exported).
     - **Scope.** A `paths[]` glob must match the finding's path.
     - **Anchor.** The anchor must be on an added or modified line (S3).
  3. **Head-added rules.** Only when `rulesSource` is `base branch`: a rule whose quote appears in the PR's own head changes but not in the base text fails the check.
  4. **On a mismatch:**
     - if the rule was the finding's only basis (style, maintainability, docs), drop the finding with `DropReason` `rule-unverified`;
     - otherwise strip the rule claim and count it.
  5. **Prompt clauses:** "cite a rule only by quoting its smallest supporting line range; never raise a finding solely because a rule file exists" [CF10].
  6. **Severity.** Rule findings are never blocking unless trusted base config gives the rule a severity. There is no such field today, so this stays out until one is added [GP6].
  7. **Reuse.** VS-48's scoped instruction files reuse this checker.
- **Invariants:** I-2, I-1, I-12.
- **Tests:**
  - the adversarial VS-22 case (a PR adds a rule to its own AGENTS.md and code that breaks it): 0 findings may cite it in a base-branch run;
  - a local `working tree` run citing a working-tree rule passes;
  - misquote, wrong scope and clipped-text cases.
- **Done when:** the Phase A report gives three figures:
  - the share of findings with `rule` set;
  - the share failing the check;
  - the settled precision of rule-cited findings against other findings.
- **Measurement and kill.** Kill in either case:
  - fewer than 2% of posted findings carry a rule, *and* no adversarial fixture is caught;
  - format mismatches drop more than 2% of settled true positives.
- **Window:**
  - now: the pure `ruleCited` checker, the structured-rule decoder and their tests, uncalled; `ruleCheck` is not parsed;
  - runner-wiring: the config parse, the schema switch under `strict`, the prompt clauses, the `rule-unverified` drop in `select.ts` and the desktop half, with D3 parity tests in `run.test.ts` and `ai-review.test.ts`.
- **Depends on:** VS-27b, the VS-22a follow-up.
- **Owner questions:** none new.

### VS-44 Blind, certificate-backed verification

*Amends VS-27 S1 and VS-06's verify schema under strict.*

- **Problem.**
  - S1's "verified" is one word plus one sentence (`VERIFY_JSON_SCHEMA`, `schema.ts:92`).
  - The verifier reads the reviewer's body and suggestion first (`prompt.ts:465-477`), and nothing checks its reasoning against the code.
  - Under precise mode, every posted comment rests on that one word.
- **Design.** Key `verifyEvidence: off | certificate`, effective only with `guardrail: strict`.
  1. **Blind candidate.** The verifier sees the id, path, line, side and severity, the strict `failure` fields and the evidence path:line list. It does not see the body or the suggestion.
  2. **New `VERIFY_CERT_JSON_SCHEMA`.** For each id:
     - `verdict`: confirmed, rejected or unsure;
     - `trace`: 1 to 6 Quote objects from trigger to failure;
     - `guards`: Quote[], or a note saying none were found;
     - `reach`: `caller-shown`, `entry-point` or `assumed`.
  3. **A pure `certified()` in `guardrail.ts`.** It reuses S4's matcher on head and base blobs read with `cat-file --batch` (I-8 as amended in VS-36). A confirmed verdict counts as verified only if:
     - every trace quote matches;
     - at least one quote lies in a changed hunk or on the anchor;
     - `reach` is not `assumed`.

     Quotes can only veto; they never confirm on their own (I-2).
  4. **New `StrictDrop` values,** `certificate-mismatch` and `verdict-unsure`. These are drops, not incompleteness. `verdict-unreadable` still fails closed.
  5. **Attachment.** Matching certificates are attached to the finding in `StrictResult`, never posted as a separate comment [GP3].
  6. **Composition.** It composes with VS-29a.
- **Invariants:** I-2, I-7, I-1, I-12, I-5 (extra output tokens go into VS-40's estimate).
- **Tests:**
  - matcher normalisation (whitespace, CRLF, LEFT quotes against base);
  - a fabricated trace is vetoed;
  - `assumed` reach is rejected;
  - schema conformance;
  - parity under `off`;
  - a fork read of a trace quote through `cat-file --batch` stays within the head tree-ish.
- **Done when:**
  - the schema and checker are merged with their deterministic tests;
  - the pre-check below has run once settled artifacts exist.
- **Measurement and kill.**
  - **Pre-check first, on settled artifacts.**
    - It needs human-settled false alarms, which exist only after the D7/D5 pilot or once seed replays are settled. It runs on the first such artifacts. Until then, only the deterministic tests gate the merge of the pure code.
    - If verify-confirmed false alarms are under 15% of settled false alarms, kill before funding.
  - **Funded ablation (Q9):** `engine:precise` against `engine:precise+cert`, with paired repetitions. Kill if any of these holds:
    - the precision change's lower bound is below 0, or the point gain is under 3 points;
    - class-scoped recall drops more than 5 points, or cross-file recall drops more than 5 points;
    - `certificate-mismatch` drops more than 5% of settled true positives;
    - median verify output tokens rise more than 60%.
- **Window:**
  - now: the schema and `certified()`, with VS-27a and VS-27b;
  - runner-wiring: the prompt, with VS-27c.
- **Depends on:** VS-27a to VS-27c, VS-06, VS-40, VS-36 (I-8 amendment).
- **Owner questions:** none new.

### VS-45 Severity-calibration judging

- **Problem.**
  - D2 counts a real but minor `extra` the same as a crash.
  - Precise mode's S2 keeps only blocking findings, so it is only as good as the blocking label.
  - Round one showed severity inflation erasing Greptile's severity-gating gain [CF15, GP16].
- **Design.** Eval only; zero review tokens.
  1. **Rubric revision.** Revise the rubric and annotation guide, and bump `RUBRIC_VERSION` in `packages/core/src/review/eval.ts` (`eval.ts:138`, 1 at 7cadfcb8) to 2. Each `match` or `extra` verdict gains `importance: would-block | should-fix | minor`. Two judges judge it, with human settlement.
  2. **New metrics** in core `eval.ts` and `eval-report.ts`:
     - important precision;
     - precision@blocking: posted blocking findings that are real and would-block, over all posted blocking findings;
     - a severity gradient: the would-block share by posted severity, flagged if flat or inverted;
     - high-severity recall, reported separately [GP16, G2-5].
  3. **Unchanged.** D2 thresholds and `DEFAULT_GATE` are unchanged. The summary-plus-inline duplicate rule stays explicit [GU3].
  4. **Reuse.** The gradient metric is defined once and reused by VS-46.
- **Invariants:** I-13 (it applies to verdicts, not frozen labels; the `RUBRIC_VERSION` bump lands before the held-out freeze), D2 unchanged.
- **Tests:**
  - metric arithmetic;
  - gradient flagging;
  - loosening detection in `eval-report.ts`;
  - verdicts judged under rubric 1 and rubric 2 are never pooled.
- **Done when:** the metrics are reported on the D5 pilot's judged findings and on every later ablation.
- **Measurement and kill:**
  - Drop the importance axis if inter-judge kappa on importance, over at least 100 double-judged findings, is below 0.4. Report only precision@blocking then.
  - Flag any package whose precision@blocking falls by more than 5 points against `engine:shared-verify`.
- **Window:** now.
- **Depends on:** VS-21, VS-04.
- **Owner questions:** Q29.

### VS-46 Outcome ledger from production markers and merge outcomes

*Merges P8 (economy and trust), P-6 (precision) and the merge-outcome ledger (large codebase).*

- **Problem:**
  - Production markers already record each finding's severity, category and outcome, but nothing reads them.
  - No public PR dataset joins AI review output to post-merge outcomes. So the owner's "predict future bugs" can only be tested on VectorScope's own merged PRs [G2-10].
  - Resolution signals are contaminated by agent loops, model-only "fixed" outcomes and author dismissals [FL9, FL18, G6-16, GP15], and human presence changes resolution rates [GU19].
- **Design.** A read-only script, `script/vectorscope-eval/outcomes.ts`, that the owner runs with `gh` on nominated repositories. No runner change, no key, no model call. It reuses `parseFindingMarker` and the state parsers; it is not a second store.
  1. **Per finding:**
     - the outcome: fixed-confirmed-by-thread, fixed-model-only, acknowledged, dismissed-writer, dismissed-author, open-at-merge, outdated;
     - whether a human other than the author engaged;
     - whether the PR is agent-authored, from trusted local records only. Untrusted markers may only exclude or split;
     - bulk resolutions, split out.
  2. **Post-merge labels from the base branch:**
     - a revert within 30 or 90 days;
     - a follow-up fix within N days that edits lines the reviewed PR added, found by blame at the fix's base. It is labelled by the fix PR's bug, regression or hotfix label, else by a word-anchored title regex.
     - PRs merged within the last 90 days are excluded. Backed-out PRs count as neither positive nor clean [G2-9, RP1].
  3. **Reports:**
     - resolution by severity and category, with VS-45's gradient and the flat-rate check [FL10, CF15];
     - writer-dismissal rate;
     - escape rate: outcomes at lines that were reviewed with no finding posted;
     - outcomes at dismissed findings;
     - re-review share of spend (VS-41);
     - the VS-39 band against revert and fix rate, computing `riskOf` offline on the merged diff;
     - results always paired with cycle time.
  4. **Proxy validation.** On the eval harness, compute "proxy-fixed" precision for each variant×model cell: the fix commit must overlap the defect's labelled location, not just the file. Compare it with human-settled precision.
  5. **Output** is sealed with `ci.ts` `seal()` under `PUBLIC_KEY_ENV`, with hashed logins. The 180-day expiry is a field in the sealed payload, checked by `unseal` callers. It is never sent to a model, tool, retrieval or Brain (I-13).
  6. **History risk areas** ("area reverted N times") may become a `riskOf` reason for a repository only if they improve band separation with an interval excluding 0. They come from git history, not eval labels.
  7. **Depth assignment for comparisons.** Comparing outcomes across depths needs depth assigned independently of risk. The assignment is never a random draw inside the runner. Either:
     - the owner sets `depth` per PR through trusted config (base `review.json` on a branch, or the global config locally); or
     - an eval-only assignment table, kept in the sealed ledger, is applied through trusted config.

     Each run records its assignment source and value in `EvidenceScope` (I-12) (Q30).
- **Invariants:** I-13, D12 (internal only), I-2, I-12 (assignment recorded), D8 (needs Q30).
- **Tests:**
  - synthetic marker histories covering every outcome;
  - lag-window exclusion;
  - agent splits only exclude;
  - 0 writes on a recording GitHub client;
  - sealed output;
  - the runner contains no random depth choice, and a run under an assignment records it in `EvidenceScope`.
- **Done when:** the script runs read-only on one owner repository and produces the sealed report. Rates are shown only for strata with at least 50 settled findings; smaller strata get counts with intervals.
- **Measurement and kill:**
  - The proxy may inform decisions only if both hold:
    - Spearman between proxy and settled precision is at least 0.5 across at least 6 cells;
    - it orders variants the same in at least 4 of 5 pairwise comparisons.

    Otherwise it is a monitor only.
  - If fewer than about 200 settled findings accrue in 90 days, report the severity gradient only.
  - If low- and high-band outcome rates have overlapping 95% intervals on at least 200 matured PRs, document `riskOf` as a size, reach and sensitivity heuristic, and never enable history risk areas for that repository.
- **Window:** now (script). Using its results to decide anything waits for enough volume.
- **Depends on:** VS-21c, VS-45, VS-39.
- **Owner questions:** Q30.

### VS-47 Deterministic review receipt

- **Problem.**
  - Greptile shows a model-written "What we checked" list and a 0 to 5 score [GP4, G6-4]. Users find the score misleading [GU13], and gates misuse it [GU10].
  - Greptile's provider-leg ZDR is unverifiable, and it stores reviews server-side [G5-1, G5-11, GU20].
  - VectorScope records routes and coverage only for the eval, so users cannot see where code went or what ran.
- **Design.** Key `receipt: off | json`. A `ReviewReceipt` (an import-free type in core `types.ts`) goes inside the existing `--json` outcome (I-14). It is built in `Review.run` from recorded data, with no model-written field.
  - **Only what the outcome lacks.** `ReviewOutcome` already holds `skipped`, `unreviewed`, `specialists` and `passes` (`types.ts:176-200`). The receipt references those fields by name and does not copy them, so the two cannot drift.
  - **The receipt holds:**
    - `version: 1` and `head`.
    - `route[]`, per request kind actually sent:
      - the provider and platform operator;
      - the VS-23 route kind or refusal;
      - sync only (Batch is never used);
      - cache TTLs written, from `cache_creation.ephemeral_5m` and `ephemeral_1h`, or OpenAI `ttl`;
      - the `store` flag;
      - the vendor-side store: "none" for BYOK or loopback; the Codium gateway or free-model route named, with wording agreed with the codium owner;
      - "upstream not reported" when unknown.
    - `context[]`: the sources used and the fallbacks (impact grep fallback, history missing, cards off, impact incomplete).
    - `checked[]`: deterministic facts only, namely which passes, lenses and strict rules completed over which files. On a complete empty result, it is shown as the substance of "No verified production-breaking issues".
    - `holdback`: the per-file in-place redaction counts and the gitignored-but-committed list. Whole-file holdbacks are already in `outcome.skipped`, with reason `held-back`, and are referenced, not copied.
    - `verdict`: the value VS-32's pure `reviewVerdict` computes for the run. It is computed for the receipt whatever `failOn` is, but stored in `ReviewState` only under VS-32's new value.
    - `band`: the VS-39 band and reasons, only if Q28 is answered yes.
  - **Scope.** The receipt covers only run-level outcomes. In GitHub, `decideSkip` reasons never reach `Review.run`, and job-level skips (VS-32 Scope) run no job at all, so neither produces a receipt.
  - **Reuse:** VS-21a's recorder and VS-23's route decisions.
  - **Later:** a GitHub sticky section, after the @vector merge and a D14 decision.
- **Invariants:** I-2 (no model text), I-14, I-3 (the receipt reports, never decides), I-1.
- **Tests:**
  - schema validation for every seed case and variant;
  - 0 mismatches between route entries and recorded wire bodies (operator, zdr flag, store flag);
  - the receipt contains no copy of `skipped`, `unreviewed`, `specialists` or `passes`;
  - `--json` byte-identical with the key unset;
  - build time under 50 ms;
  - the receipt and the VS-32 verdict never disagree.
- **Done when:** the projection passes all of the above.
- **Measurement and kill:**
  - Any mismatch between a receipt and a wire body blocks the key from leaving opt-in.
  - If no owner workflow consumes the receipt after 60 days, keep it eval-only.
  - Adoption effect is not measurable in the harness.
- **Window:** runner-wiring; later (GitHub section).
- **Depends on:** VS-21a, VS-23, VS-32, VS-34 (holdback data), VS-38 (incomplete reasons).
- **Owner questions:** Q28.

### VS-48 Directory-scoped trusted instructions and depth rules

- **Problem.** Path-scoped trusted rules already exist: `.vector/review.md` sections with globs, and `review.json` `paths: {path, instructions}[]`. `rulesForPaths` (`config.ts:270-281`) builds one rules block for the whole change: the global section, every section whose globs match any changed file, then matching `paths` entries. The block is sent to every specialist and clipped at `MAX_TRUSTED_CHARS` (16,000 characters, `prompt.ts:102,448-451`). Both the CLI (`review.ts:434-438`) and the CI job call it [VT3]. The gap is narrower:
  - The trusted rule path does not read nested AGENTS.md and CLAUDE.md files, or `.github/instructions/*.instructions.md`.
    - In CI, only the root instructions come from the base commit.
    - Locally, the engine's ordinary session loader handles instruction files (`context.ts:247-248`, `session/instruction.ts`), outside VectorScope's trusted, base-scoped rules [VT3].
  - There is no trusted way to force depth on critical subtrees.
  - Copilot, Kodus and Greptile all scope instructions by path [CF8, CF9, GP6], and Greptile scopes depth by directory [GP8]. The quality prior for context files is about null, with a cost increase [RR14].
- **Design.** Two keys, both trusted-only (§1).
  1. **`instructionScope: root | scoped`**, built on the existing mechanism. Collected files become extra entries in the same section format that `rulesForPaths` merges. The glob is the file's directory subtree, or `applyTo` for `.instructions.md`. Selection and tagging then apply unchanged; caps are under "Order and caps" below.
     - **Engine and CLI half (runner-wiring).**
       - **Reads.** Inside `Review.run`, read with `git cat-file --batch` (I-8 as amended in VS-36):
         - the ancestor-directory AGENTS.md, CLAUDE.md and `.vector/RULES.md` of each changed file;
         - `.github/instructions/**/*.instructions.md` files whose `applyTo` matches a changed file.
       - **Commit.** Read them at a new `RunInput.rulesCommit`. In runner-wiring only the CLI sets it, to the merge-base (`RunInput.base`, `run.ts:98`), and the run records that choice. In CI, `github.review.ts` must pass `rulesCommit = pull.base.sha` and make sure that commit is fetched (the workflow checks out with `fetch-depth: 1`), or read nested files through `gh.getContent(path, base)` as it reads the root rules. That is @vector-owned work and waits for `vector-at-mention`. Until then, a CI run with `instructionScope: scoped` and no `rulesCommit` collects no scoped files and adds a note.
       - **Local sources.** Locally, root rules are read from the working tree (trusted) or from the resolved base (`--pr`, `review.ts:214-222`). Scoped files read at `rulesCommit` are tagged with their own source and commit inside the block, and VS-43 checks each quote against the copy it came from.
       - **Surfaces.** The CLI gets the behaviour in runner-wiring. The GitHub job gets it after `vector-at-mention`. The desktop runner does not call `Review.run`; its half is in §1a.
       - **Not reused:** `baseInstructions` and `ReviewContext.gather`, which the CLI never calls with `instructions` (`review.ts:377-384`).
     - **Local CLI.** `scoped` does not change the engine's session instruction loading (`session/instruction.ts`). The scoped files above are added to the trusted rules from the base commit. When the engine's loader also attaches a working-tree copy of the same path, both copies are tagged with their source, and VS-43 checks against the trusted one.
     - **GitHub half (later, after `vector-at-mention`).** In CI, the base-commit gatherer runs in `github.review.ts:563-570`, through a contents-API reader (`gh.getContent(path, base)`), and takes no config. Passing the key, or the directory list, to that reader is @vector-owned work and waits for the merge.
     - **Order and caps.** Nearest first: for a multi-file change, entries are ordered by the depth of the scoped directory, deepest first, ties in path order. At most 8 files, 64 KB and 4k tokens are collected in total, and each block is tagged with its path and scope. The entries are appended after the `.vector/review.md` sections and `paths` entries, so they share the one 16,000-character `MAX_TRUSTED_CHARS` clip with them and are clipped first.
     - **Base versions only.** Only base-commit versions are used, so head additions and edits have no effect.
     - Findings that cite these files go through VS-43's checker.
     - An injection-text fixture is added.
  2. **`depthRules`**, from base `review.json` only, in CI and locally (trusted-only; no global-config source, which would apply a per-repository glob list to every repository). At most 20 rules of `{glob, minBand: medium | high}`. They only raise the VS-39 band. PR text, labels and comments never select depth (I-2; Greptile's escalation by comment is rejected). Because `depthRules` is not in the global config, it needs no SDK regeneration.
  3. **Provenance.** Notes name where each effective rule came from [G6-14]. If base config cannot be read, `depthRules` are skipped and noted (fail-safe) [GP7, G6-1].
- **Invariants:** I-2, I-1, I-8, I-11 (schema regeneration if `instructionScope` is accepted from the global config), I-12, I-14 (config surface undocumented until after 1.99.113).
- **Tests:**
  - a nested AGENTS.md added or edited by the PR, and a head-only `depthRule`, have 0 effect;
  - an edited nested AGENTS.md contributes its base version only;
  - a CI-trigger run (trigger `auto` or `command`) with no `rulesCommit` reads no nested file, adds no scoped files and emits the note;
  - after `vector-at-mention`: nested and root files come from the same commit in CI (`rulesCommit` = `pull.base.sha`, or the contents-API read at `pull.base.sha`);
  - caps;
  - nearest-first order on a multi-file change, and scoped entries clipped first under `MAX_TRUSTED_CHARS`;
  - `applyTo` matching;
  - collected files reach the prompt through `rulesForPaths` in the existing section format;
  - with `instructionScope: root`, trusted rules and the engine's session instructions are byte-identical to today;
  - `depthRules` from the global config or env is ignored with a warning;
  - an unreadable base is noted.
- **Done when:** Phase A reports token overhead (p50, p90) and the share of cases with a scoped file; the adversarial cases pass; and the cost projection reports the share of PRs raised by `depthRules`.
- **Measurement and kill.**
  - `scoped` stays off if median tokens rise more than 10%, or false alarms per clean PR rise, without a class-scoped recall gain whose interval excludes 0 (Q9).
  - `depthRules` carry no quality gate; they are pure owner policy.
- **Window:**
  - runner-wiring: the `Review.run` half, `RunInput.rulesCommit` (CLI only) and `depthRules`;
  - later, after `vector-at-mention`: CI `rulesCommit = pull.base.sha` plus its fetch (or nested reads through `gh.getContent(path, base)`), and the GitHub contents-API half.
- **Depends on:** VS-43, VS-39, VS-22, VS-36 (I-8 amendment).
- **Owner questions:** none new (approval through Q18; sending scoped instruction files to models is covered by Q18 and I-4, see §5).

### VS-49 Slice-utilisation instrumentation and an exploration nudge

- **Problem.**
  - Agents explore the right code and then fail to use it [RR11].
  - Hand-offs fail silently [LCI10].
  - Symbol tools are rarely used and do not reliably save tokens [LCI4, RR3].
  - Token savings must be measured, not assumed [LCI5].
  - Nothing records whether Tier 2 uses the VS-25 slice.
- **Design:**
  1. **Observer fields.** These are VS-21a artifact fields, taken from existing session events at zero tokens. For each pass, record:
     - tool calls by kind;
     - paths read inside and outside `ImpactSlice.locations`;
     - greps for names already in the slice;
     - for each finding, whether its evidence falls in the diff, the slice or tool-read files (approximate for legacy evidence strings);
     - for VS-28 lenses, what each lens received and cited.
     - These fields stay out of digests unless the variant is on.
  2. **One prompt variant, `explore: off | slice`:** "before concluding, check the listed dependents for each changed signature" [RR16].
  3. **No symbol tool now.** Reconsider only if the logs show models re-deriving dependents by grep in many cases.
- **Invariants:** I-1, I-12, I-13 (the variant waits for the held-out freeze before tuning).
- **Tests:** observer fields from fixture sessions; digest stability with the variant off.
- **Done when:** every projection and pilot artifact carries the fields.
- **Measurement and kill:**
  - The nudge stays off if the class-scoped recall gain is under 3 points, or its cost exceeds +10%.
  - If under 10% of cross-file findings cite slice locations while slice recall is high, reopen VS-37 before further VS-25 tuning.
- **Window:** now (artifact fields); runner-wiring (the run observer and the variant).
- **Depends on:** VS-21a, VS-25, VS-36.
- **Owner questions:** none new.

---

## 3. Changes round two implies for existing packages

**VS-21 Eval readiness**
- **External comparisons.**
  - State the metric and β for every external comparison. Martian's offline default is F2 (β = 2; its code comment calls the β² = 4 weighting "4x"), and its online ETL default is F1.
  - Use one tested rule for summary-plus-inline duplicates, matching S7 [GU2, GU3].
- **Repetition and recall.** Repeat runs per case. Report high-severity recall separately. Add a reverts-within-N-days metric through VS-46 [GP16].
- **Cost, latency, humans.** Report cost per verified finding [GU9] (VS-40), latency p50 and p90 [CF24], and whether a human engaged [GU19].
- **Slice.** Record slice recall by stage (VS-36) and utilisation (VS-49) [LCI7, RR11].
- **Stratification.**
  - On ReviewBench, report results by golden producer. The `ccr` producer IDs name the models it ran with, for example `ccr:gpt-5.5[ReasoningEffort=medium]`, so stratify by them.
  - On AACR, report by `source_model` [GU7, VOI15].
- **Ablation.** Add an ablation of the PR description and linked issue (as untrusted data) against the impact slice [RR12].
- **Reproducibility.**
  - Copy the round-two research scripts into `script/vectorscope-eval/research/`, with every input named by URL and commit. The scripts are the ApacheJIT models, the PR band analysis, the grep and tree-sitter timings, the Martian and ReviewBench re-analyses, and the AACR token arithmetic. Results stay uncommitted (I-13).
  - **Commit now** only scripts whose inputs are D8-clean: ApacheJIT and the Apache repositories, Keycloak, Kubernetes, vscode, the AACR permissive subset.
  - **Gate the rest** on Q10 and Q26. That covers scripts whose inputs include Linux, Grafana, Sentry, Discourse or Martian goldens.
  - ReviewBench re-analyses use MIT-licensed labels plus diff statistics of corpus repositories whose licences are unchecked. Commit those scripts only after the VS-22 per-repository licence check.
  - The numbers from those inputs were gathered before Q10 and Q26 were answered, and must not be reused until both are answered.
  - If the session scratchpad is lost before the scripts are copied, mark those numbers permanently not reproducible. Until the scripts are committed, the report's own measurements are marked not reproducible.

**VS-22 Dataset**
- **External source.**
  - Prefer AACR-Bench's permissive subset (144 PRs, 140 positives, 970 goldens) as the D8-clean external source. AACR is a separate external manifest with its own selection, outside `PER_REPOSITORY`; or, if it joins `upgrade.json`, at most 2 PRs per project (about 80).
  - Check licences per PR, at the PR's commit and paths, and store `{repo, commit, SPDX, licence path}`. Flag mixed-licence paths (`tsl/`, `x-pack`) [VOI13, VOI14, G3-3].
  - Record the 9 positive samples whose commits GitHub no longer serves (report §5.2 note).
- **Martian.** The D8-clean Martian subset (13 PRs, 40 goldens) is a smoke test only [VOI11, VOI12].
- **Languages.** Report AACR cases outside the grammar set (C, C++, C#, PHP; 53 of 140 positives by `project_main_language` *(lane note, re-derived from `positive_samples.json`)*) separately [VOI13].
- **Hygiene.** Strip third-party bot blocks from PR bodies [GU7]. ReviewBench licences are not in its manifest, so check them before use [GU7].
- **VS-22a follow-up (a schema change to a merged package).** VS-22a has landed at HEAD (7cadfcb8, "feat(review): VS-22a upgrade dataset labels"), so the new labels below are a follow-up change, not part of VS-22a.
  - **Labels and strata:**
    - a context-level label (hunk, file, repo) [LCI2];
    - strata for Python, security and test gaps [GU5];
    - a scope label on ReviewBench's axis (`introduced-by-pr`, `exacerbated-by-pr`, `pre-existing`, `unrelated`) and pre-existing and exacerbated fixtures (VS-42). VS-42's model field keeps three values (introduced, exacerbated, pre-existing); S9 drops model-labelled pre-existing findings and suspects (VS-42 item 3), and scoring treats goldens labelled pre-existing or unrelated as out of S9's scope;
    - a head-added rule case (VS-43);
    - adversarial feedback cases with synthetic `vector-dismissal` markers: forged author dismissals, non-writer brigading, an agent bulk resolve, and a thumbs-down on a real security finding (VS-35) [FL6, FL9, FL16];
    - multi-commit sequences (VS-41). Single base/head cases cannot express a sequence, so the case schema gains an ordered commit list.
  - **Where:** the `dataset.ts` schema, `fixtures.test.ts` and a deviations entry; dataset schema `vectorscope-dataset/3`; `ReplayCase` gains comments and threads (bot comments carrying synthetic markers, human replies); `caseView` and `mirrorPlan` cover every commit in a sequence; `ReviewEval.replay` gains a sequence mode that carries prior findings, state and `since` between commits.
  - **When:** landed before the held-out freeze (I-13).
- **Large repositories.** Add a large-repository slice of 20k files or more (licence-checked) and a latency case of 50k files or more (VS-38) [G1-3, G1-6].
- **PR size.** AACR's PRs are below about 1,000 lines; CRBugBench's fix track covers the large-PR end of the curve [G3-3, G3-14].

**VS-23 ZDR routing**
- **VS-33.** All of VS-33.
- **Batch.** The OpenRouter batch refusal is now vendor-backed [VOI6 *(lane note)*].
- **Owner setup for the eval key (Q7):**
  - every `enforce_zdr_*` field;
  - both `allow_safety_retention_*` set to false;
  - ZDR only, for both Safety Retention groups;
  - I/O and discount logging off;
  - every BYOK `declared_zdr: true` key vouched for [G4-1; VOI5, G4-9 *(lane notes)*].
  - Account-level enforcement also closes two paths. Fusion's inner generations run under the account's ZDR settings, but not the request-level `provider` settings. Response caching is unavailable under account-level ZDR [G4-4, G4-7].
- **Gemini.** Gemini is effectively unavailable on the OpenRouter ZDR route from 2026-10-18 without the owner's own GCP ZDR [G4-2 *(lane note)*].
- **Cache TTLs.** Anthropic-direct ZDR routes may use 1-hour TTLs in cache work [VOI7, G3-7 *(lane notes)*].
- **Cloud-hosted Claude.** Bedrock and Google-managed Claude need a cloud-account attestation [G4-3; VOI7 *(lane note)*].
- **Receipt.** Structured-output schema caching (up to 24 h) goes in the receipt [G5-7 *(lane note)*].
- **Residuals to state in notes:**
  - OpenRouter CSAM screening and categorisation sampling;
  - Google's 90-day flagged retention on Vertex Google models;
  - OpenAI safety alerts on ZDR traffic;
  - customer-side logging on Bedrock and Vertex [VOI9; G4-6, G4-2, G4-12, G4-18 *(lane notes)*].
- **404 text.** Do not key privacy on 404 text; this corrects round two's VOI2 recommendation [G4-8].
- **Engine fix.** Relies on the separate engine fix for `store: false` on Azure and Mantle helper requests (VS-33, "Not in this package").

**VS-24 Zero-token gate and budget**
- **Payload rules.** Copy Greptile's zero-token payload rules [GP1, G6-5]:
  - a byte cap before dispatch;
  - commit-message thinning (first and last above 50);
  - subject truncation at 1,024 characters;
  - explicit "not included" warnings for uncommitted, binary and held-back files.
- **Evidence for Q11** (recommendation; the owner decides). gptme's workflow cites Greptile catching a tailwind-merge 3 / Tailwind 4 mismatch [GU22]. Keep manifests and lockfiles under "Never trivial", as VS-24 already does with its (Q11) tag. Q11 stays open in the contract's §8.
- **Skip mapping.** The `trivial` skip maps to VS-32's `policy-skip`.
- **Re-reviews.** Budget re-reviews explicitly, and report their cost per PR [GP5] (VS-41).
- **Estimator.** Adopt VS-40: step caps are a shrink lever, and the per-PR remainder is used where `RunInput.spent` is passed.
- **Desktop cap.** Desktop dollar cap by default: Q32 [GU16].

**VS-25 Impact slice**
- **Adopt:** VS-36 (gate before cap), VS-37 (packing tiers) and VS-38 (bands, partial clones, time box) [G1-7 to G1-12].
- **Budget.** Sweep the budget at 2k, 4k, 6k and 8k per model, in projections or the funded ablation, instead of fixing it at 6k [RR1, RR2, RR5].
- **No whole-repository parse.** Never parse the whole repository (C-5 holds) [G1-8].
- **Not now:** no embeddings, symbol tool or trigram index [LCI9, RR3, LCI14].
- **Conditional fact cache** (VS-25's later half). Build it only if VS-38's band p95 fails. If built, it:
  - keys on (blob SHA, grammar version, query version);
  - keeps base facts plus a per-PR overlay, with a fan-out re-check;
  - serves facts only for blobs present in the reviewed tree's `git ls-tree`;
  - produces byte-identical slices cached and uncached;
  - is per-repository and local (no cross-repository index, §9), with a TTL and a delete path;
  - has an Actions-shared variant only with the @vector owner [LCI11, LCI12, LCI13, G5-5].

**VS-26 Brain cards**
- **Card source.** Use a `files.json`-style trusted list as a card source: path, description and glob scope, from base config only, read only when a changed file matches [GP6].
- **Build cadence.**
  - **Local:** build cards from a base-SHA artifact rebuilt when the base changes, not per PR [GP9, G6-7].
  - **CI:** a nightly per-repository artifact needs the Actions cache in the @vector-owned workflow (I-9). It belongs in the after-`vector-at-mention` window, with the @vector owner.
- **Cost criterion.** Pre-register a cost and latency criterion: the prior for recall lift is about null [RR14]. Cards target a 6 to 8% tail of findings [G6-12].
- **Hosted store.** Any hosted card store must have a TTL and a delete path [G5-5].

**VS-27 Strict guardrail**
- **Fields.** Add StrictResult fields from Greptile's schema [GP3]:
  - `linkedRule` (checked by VS-43);
  - `clarificationQuestion`;
  - a `securityIssue` flag;
  - before and after snippets;
  - per-file notes.
- **Severity.** Under precise mode, a finding whose severity cannot be parsed is dropped. Never default it to the lowest level [GP3].
- **Evidence placement.** Attach execution or certificate evidence to the matching finding, never as a separate comment [GP3] (VS-44, VS-30).
- **`checked[]`.** It is deterministic and comes from VS-47, shown only on a complete empty result [GP4, G6-4].
- **Candidates.** S9 (VS-42) and the S1 certificate (VS-44) join only after their gates. VS-42's `scope` field enters the strict schema only under `scopeGate: introduced`.

**VS-28 Risk depth and lenses**
- **Adopt** VS-39.
- **Greptile's categories.** Do not present Greptile's auto-approve categories as Greptile's taxonomy [GP20, G6-8, G6-4].
  - `isSensitivePath` already drives security planning and the trivial rules, so widening it would change default behaviour (I-1).
  - Any extract-only candidate list therefore goes behind `depth: auto` (as an extra raise-only impact flag inside `riskOf`), or through VS-31's precise-mode gates. It never goes into the default `isSensitivePath`.
- **Taxonomy mapping.** Publish a mapping from the five classes and four lenses onto Martian's and ReviewBench's taxonomies. Adopt ReviewBench's scope axis (`introduced-by-pr`, `exacerbated-by-pr`, `pre-existing`, `unrelated`) [G6-13]. The VS-22 dataset scope label uses this axis; VS-42's three-value model field maps onto it (introduced to introduced-by-pr, exacerbated to exacerbated-by-pr, pre-existing to pre-existing; unrelated has no model value), and scoring treats pre-existing and unrelated goldens as out of S9's scope.
- **Effective depth.** An explicit depth that cannot run fails loudly, and the effective depth is recorded [G6-2].
- **Validator lens.** Consider a lens backed by validators the repository already has: type checkers, schema tests or property tests [GU8].
- **Depth sources.** Depth may come from trusted base `depthRules` (VS-48), never from comments [GP8].

**VS-29 Cross-family verifier and inversion**
- **AACR A/B.** Stratify an AACR A/B by golden `source_model`, or score on the 274 human goldens of the permissive subset [VOI15].
- **29b.** 29b stays a local opt-in with no vendor setting to mirror. Greptile's detection signals stay untrusted [VOI17, G6-9].
- **Hypothesis swarm.** No independent evidence supports the hypothesis swarm, so lenses must win on VectorScope's own replay [GU1].
- **Show its work.** A cross-family verifier should also show its work through VS-44 [GU8].

**VS-30 Runtime verification**
- **Simulation first.** Run runtime checks in simulation on past PRs, posting nothing, before enabling them [GP17].
- **"Checks not run" reasons.** Reuse Greptile's blocker taxonomy (missing dependencies, services, config, fixtures) as the reasons for "checks not run" (I-6) [GP17].
- **No network or secrets.** Keep network access off and supply no secrets; Greptile's defaults are weaker [GP17, G5-9].
- **Fix validation.** Validate fixes by re-running the deterministic check that raised them [CF12].

**VS-31 Precise mode**
- **Verdict.** Precise mode should carry VS-32's verdict, so an empty result is safe to gate on.
- **Joining packages.** VS-42, VS-43 and VS-44 join `precise` only after their own gates. VS-34 is a candidate to require under zdr (Q23).
- **Martian rank.** Expect a low rank on Martian's default F2 view, by design [GU2].
- **Precision floor.** D2's 0.80 precision floor is parity with Greptile online (if the snapshots hold); the opening is class-scoped recall at that precision [GU6].

**Other approved packages**
- **VS-11 and VS-20:** amended by VS-35 [FL1 to FL17].
- **VS-12 and VS-13:** bind the existing `/vector fix` path to the consent contract at the @vector merge. Give the CLI a consented apply step on StrictResult. Loop on verified findings, never on a score [CF1, CF13, GU12].
- **VS-16:** emit a per-requirement verdict (met, partial, missing, check manually) with path:line evidence. Resolve a reference only on an exact tracker id. Use a host-only cross-repository allowlist plus a check of the requester's access [CF6, CF7].
- **VS-18:** pull offline, pinned secret and dependency scanning forward, as evidence lanes the model filters, sharing VS-34's scanner [CF20, GP19].
- **VS-19:** batch large PRs in VS-39's density order [RP14].

---

## 4. Sequencing additions

| Window | Packages |
|---|---|
| Now | VS-32 (`reviewVerdict` only); VS-33 (`privacy.ts` refusals and the structured-entry parser over base `review.json` input, after VS-23a); VS-34 (pure `holdback.ts`, with its own result type); VS-35 (pure core helpers uncalled by `prompt.ts` and `select.ts`, pure tests on synthetic markers); VS-36, VS-37, VS-38 (core and uncalled engine impact files); VS-39 (`risk.ts`); VS-40 (`dispatch.ts`); VS-42 (`preExistingSuspect` and the strict drop); VS-43 (the `ruleCited` checker and decoder, uncalled); VS-44 (schema and checker); VS-45; VS-46 (script); VS-49 (artifact fields); the VS-22a follow-up labels (before the held-out freeze) |
| Runner-wiring | VS-33 (transport normalisation and admission calls, after VS-23c; the global engine config schema with VS-23d); VS-34 (`Review.run` call, tool rules, ignored list, `held-back` reason); VS-35 (config parse, guarded prompt rule and select demotion, with D3 parity tests); VS-36 to VS-38 (with VS-25b wiring); VS-39 (with VS-28 wiring); VS-40 (with VS-24 wiring, `RunInput.spent`); VS-41 (engine and CLI); VS-42 (prompt clause and `scope` field, with VS-27c); VS-43 (config parse, strict schema, prompt clauses, `rule-unverified` drop, desktop half); VS-44 (prompt, with VS-27c); VS-47; VS-48 (`Review.run` half, CLI `rulesCommit`, `depthRules`); VS-49 (observer, variant) |
| Later, after `vector-at-mention` | VS-32 config parse, exit codes and job wiring (plus the request for an always-running gate step); VS-35 markers, roles and `TeamPattern` provenance (with the salt secret), then its 10-case criterion; VS-40 GitHub `spent` wiring; VS-41 GitHub self-fix carry; VS-47 sticky section; VS-48 CI `rulesCommit` and its fetch (or contents-API nested reads), and the GitHub contents-API half; VS-26 nightly CI card artifact (with the @vector owner) |
| Later, after VS-11 | VS-35 Brain proposals |
| Later, on a measured trigger | The conditional VS-25 fact cache, if VS-38's ≥50k-band p95 fails |

Order, consistent with the contract's sequence (VS-21, then VS-22a and VS-23a):
1. **Invariant gaps first** (I-3, I-4, I-7):
   - VS-34 and VS-32's pure function, after VS-21 and VS-22a;
   - VS-33's refusals and attestation parsing, immediately after VS-23a, which creates `privacy.ts`, `decideRoute` and `RouteRefusal`;
   - VS-33's normalisation and admission calls follow VS-23c, in the runner-wiring window.
2. Then VS-36 to VS-39, alongside VS-25 and VS-28.
3. Then VS-40 to VS-44.
4. VS-45, VS-46 and VS-49, alongside the eval work.

Prompt tuning in VS-42, VS-43, VS-44 and VS-49 waits for the held-out freeze (I-13).

---

## 5. New owner questions

- **Q18.** Are VS-32 to VS-49 approved as proposed additions, on the same terms as Q15? Beyond the packages themselves, that approval includes two things:
  - the I-8 amendment allowing `git cat-file --batch` on objects of the head tree-ish (VS-36);
  - under `instructionScope: scoped`, sending nested AGENTS.md and CLAUDE.md files and `.github/instructions/*.instructions.md` from the base commit to review models. This is the same trust class as the root AGENTS.md, which is already sent from the base commit, and it passes I-4's redaction (formerly Q33).
- **Q19.** Under `failOn: blocking-or-incomplete`, should a provider or model error exit non-zero at once, or retry and recheck first (VS-32)?
- **Q20.** May admission make metadata-only calls on the review's own credentials (Bedrock `GetAccountDataRetention`, Vertex `getCacheConfig` and `fetchPublisherModelConfig`) when an attestation sets `verify: "api"`, refusing on any failure or timeout? For OpenAI, project `data_retention` needs an admin key. Should `verify: "api"` stay refused for OpenAI (attestation only), or may a separate admin credential be read from the trusted global config only (VS-33)?
- **Q21.** Is OpenAI extended prompt caching acceptable under D15 when the attestation says so? Or are gpt-5.5 and later models refused under zdr (VS-33)? Extended caching keeps KV tensors on GPU-local storage for up to 24 hours, and `prompt_cache_options.ttl` can additionally set a 12-hour minimum. It is the only option on gpt-5.5 and later. This depends on the answer to Q1.
- **Note (formerly Q22).** VectorScope relies on a separate engine fix that sends `store: false` on Azure and Bedrock Mantle helper requests. That fix is outside the VectorScope contract and needs no VectorScope decision (VS-33).
- **Q23.** Once VS-34's gates pass, should `holdback: secrets` be required whenever `privacy: zdr` is set?
- **Q24.** Feedback learning (§8 has no question on it): do you approve VS-35? It amends VS-11 and VS-20, and team memory will shrink sharply on same-repository PRs. It covers:
  - repository memory counted only from writers who are not the PR author;
  - the never-suppress set;
  - the separate dismissal marker, with a salt secret the @vector owner adds;
  - demotion instead of silence;
  - Brain proposals instead of active rules.
- **Q25 (withdrawn).** It asked whether impact incompleteness should ever mark a strict empty result incomplete. I-7 settles it: every changed line is reviewed, so impact incompleteness is an informational note only (VS-38, design item 7).
- **Q26.** D8 exception: may non-permissive public repositories (for example Linux, GPL) be used for latency timing only, with no code stored? This also decides whether round two's Linux, Grafana, Sentry and Discourse timings may be reused (VS-21). If not, llvm-project and rust-lang/rust (permissive) serve as the 50k-files-or-more cases (VS-38).
- **Q27.** VS-39:
  - May PR-level cutpoints be seeded from numstat (diff statistics only, no code stored) of ReviewBench PRs, whose per-repository licences are unchecked?
  - QR1 (a raise-only fix signal from untrusted text) is withdrawn, because its evidence (RP15) was refuted. Using fix density as explanation text only is now a VS-39 design decision, not a question.
- **Q28.** May the band and its reasons appear in `--json`, inside the receipt key, so repositories can drive their own rules (risk-notes QR2; VS-39, VS-47)? Until this is answered, the band appears in notes only.
- **Q29.** Do you approve a rubric revision with an importance axis (`RUBRIC_VERSION` 2), given that it adds owner adjudication time (VS-45)?
- **Q30.** VS-46:
  - May the owner's own repositories' production markers and merged PRs be read for internal measurement under D8 and I-13, sealed, with a 180-day expiry and hashed logins?
  - May depth be assigned per PR on those repositories, independently of risk, to separate the effect of depth from risk? The assignment would be made by the owner through trusted config, or from an eval-only assignment table in the sealed ledger. It is recorded in `EvidenceScope` and is never a random draw inside the runner.
- **Q31.** Do you accept the AACR-Bench permissive subset (144 PRs; licences checked per repository at its first dataset PR commit, and a per-PR check is pending in VS-22) as the D8-clean external source? Do you accept the reading of the FSL availability date that puts three Martian Sentry PRs (and a fourth on 2026-11-11) under Apache-2.0 (VS-22; updates Q10)?
- **Q32.** Should the desktop runner get a hard dollar cap, on by default? That changes a default, and so falls under D3 and VS-31 (VS-24) [GU16].
- **Q33 (folded into Q18).** Sending scoped instruction files is the same trust class as the root AGENTS.md, and is covered by Q18 and I-4.
- **Q34.** The research rule refers to every open-source coding-agent CLI or harness generically. Is it acceptable to keep full source URLs and paths that name such a project (for example the review-rubric path in OpenAI's open-source CLI repository, the Greptile plugin's subdirectory for that CLI, a SWE-bench run directory, the code-assistant snapshots) for traceability? Until you answer, the report withholds them and cites the repository owner and commit only. The full links stay in the round-two lane notes.

---

## 6. Merged and dropped proposals

| Proposal | Outcome | Reason |
|---|---|---|
| P-4 Guarded team memory (precision) | Merged into VS-35 | Same substance as P7. P7 keeps the finding-marker regex untouched by using a separate dismissal marker, and correctly places the GitHub half after the @vector merge. P-4's bulk-resolution and bot-push thresholds, and its "any FailureClass under strict", were carried over |
| P-6 Afterlife ledger (precision) | Merged into VS-46 | Duplicates P8's ledger. Its proxy-validation step (Spearman ≥ 0.5 against settled precision) was carried over, with a tightened "overlaps the labelled location" rule against file-touch inflation [GP15] |
| P-7 Head-bound verdict (precision) | Merged into VS-32 | Duplicates P1. P1 covers every skip path and GitHub's rule that neutral and skipped count as passing. P-7 misplaced the job-side half, since all of `github.*` is @vector-owned (§0.5). Its harness check over all replay artifacts was carried over |
| Merge-outcome ledger (large codebase) | Merged into VS-46 | Duplicates P8's post-merge outcomes. Carried over: its word-anchored regex, blame to added lines, escape rate, per-repository risk-area gate, and the depth-assignment confound (now resolved without a runner-internal random draw) |
| Base-SHA fact cache (large codebase) | Not a package; folded in as conditional requirements on VS-25's later half (§3) | The judges split. Its own kill criterion says not to build it if VS-38 meets p95. The proof-of-possession evidence is vendor-only [LCI11]. The Actions-shared variant needs the @vector owner. A persistent store must not drift toward §9's excluded index |
| `store: false` in `smallOptions` (VS-33 item 6 in the first draft) | Moved out of the VectorScope contract | `smallOptions` serves every Vector session, so this is a general engine privacy fix with its own tests, not a VectorScope key or default |
| `git backfill` for partial clones (VS-38, first draft) | Dropped | It fetches blobs reachable from walked history, not only the reviewed tree, so it cannot fit the time box, and it writes into the user's object store. On-demand `cat-file --batch` for gated candidates replaces it |

Considered and not proposed:
- **Embedding index:** the online effect is small, and it conflicts with ZDR routing [LCI9].
- **Read-only symbol tool now:** rarely used, no reliable savings [LCI4, RR3].
- **Trigram index:** only if p95 fails [LCI14].
- **Raise-only "this is a fix" signal from untrusted text:** refuted [RP15].
- **Head-controlled config and comment-driven depth escalation:** conflict with I-2 [GP7, GP8].
- **Reaction or embedding suppression, and cross-repository fallback learning:** Kodus retired the approach, and it breaks repository isolation [FL3].
- **Auto-approve, a confidence score, and test generation as a deliverable:** excluded by §9 and [CF22, CF23].
- **Greptile-style full network access or secrets at build time for runtime checks:** weaker than I-6 [GP17].
- **A random depth choice inside the runner:** a hidden behaviour outside the key system and I-12 (VS-46 uses trusted assignment instead).
