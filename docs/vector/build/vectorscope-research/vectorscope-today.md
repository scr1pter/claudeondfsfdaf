# Vectorscope today, end to end (origin/vectorscope vs origin/main)

Read-only study, git only. Branch tips read: `origin/vectorscope` at `dbcfbe8f` (fix(vectorscope): Phase 1 review),
`origin/main` at `4299d743`, merge-base `1aec0b0e`. Citations are `path:line` on `origin/vectorscope` unless another
ref is named (`main:`, `codium:`, `self-evolving:`).

## 0. One-paragraph summary

Vectorscope is a read-only, multi-pass LLM reviewer with three runners that share pure core code
(`packages/core/src/review/*`): the engine runner `Review.run` (used by `vector review` CLI and the GitHub Actions job)
and a separate desktop renderer runner (`packages/app/.../ai-review.ts`). A run = (a) deterministic filtering and
skip rules, (b) git-gathered context (regex-extracted changed symbols -> `git grep` call sites, `git log`/blame,
base-branch AGENTS.md/RULES.md, PR title/body, human comments, team-dismissed patterns, and on local CLI only, Brain
"linked requirements"), (c) a `review` specialist plus, for sensitive paths, a `security` specialist, run in parallel as
hidden `vectorscope.*` sessions with only read/grep/glob/list + StructuredOutput, (d) a `verify` pass on the review model
that re-reads cited code and answers confirmed/rejected per candidate, (e) deterministic selection (confidence floor 0.7,
nits off, dedup by fingerprint/location/title, prior-finding matching, team penalty, caps 10/run and 25/PR, anchoring,
suggestion gating), (f) formatting, secret redaction and a memory-backed posting guard, then GitHub posting (CI) or a
user-pressed Post button (desktop) or terminal print (CLI). The engine admits every provider attempt against a
per-review dollar reservation ($2 default), per-PR ($10) and optional monthly caps; the desktop has no dollar cap,
only a 10-minute timeout. VS-01..04 (Phase 0) built an eval harness (dataset contract + 10-case seed, production replay
adapter, budget ledger + protected/sealed manual CI, causal judging + D2 gate) and VS-06/VS-07 (Phase 1) added two
off-by-default opt-ins (`verifyPolicy: "shared"`, `modelEvidence: "warn"`). VS-05 is not started. **No eval result
exists: no paid run, no paid replay entry point, the D7 environment/key is owner setup, `MODEL_EVIDENCE` is empty and
nothing is committed.** None of the seven proposed upgrades exists; several have partial foundations (Brain
requirements/code graph, triage model, verify pass, codium's second-lab module, self-evolving's isolation, the D2
precision gate).

## 1. Status of the plan and the branch

- Plan status: "approved build plan, not an implementation or a claim of measured quality"
  (`docs/vector/build/vectorscope-plan.md:3`). Owner approved all D1-D14 on 2026-11-03 (`vectorscope-plan.md:14-34`).
  Key decisions for upgrades:
  - D2 gate: no trust regressions, no unaccounted paid attempts, >=95% coverage, >=80% actionable precision,
    <=0.2 false alarms per clean PR, recall no more than 5 points below frozen pipeline (`vectorscope-plan.md:22`).
  - D3: changed reviewer behaviour ships behind an off-by-default opt-in until it passes D2 (`:23`).
  - D5: dry runs only until D7 key; then one $50 pilot, $0.75/case, 1 repetition, dev split only (`:26`).
  - D6: candidate models = current default + one cheaper catalog model; "No model that may train on prompts" (`:27`).
  - D7: protected `vectorscope-eval` environment, new key with provider-side limit = D5 budget (`:28`).
  - D10: fixes need per-operation consent, separate apply/checks/push (`:31`). D11: MCP default-deny (`:32`).
  - D12: results internal, no comparative/accuracy claim (`:33`). D13: VS-08..12 only after `self-evolving` merges (`:34`).
  - D14: nothing user-facing in 1.99.113 (`:35`).
- Merge state (git `merge-base --is-ancestor`): `self-evolving`, `vector-at-mention` and `codium` are all NOT merged
  into `main` as of their tips (`a2789e3a`, `0b68e8f6`, `31820732`). So VS-05/08-13 and the GitHub halves of VS-16/20
  are blocked (`vectorscope-plan.md:332-339`).
- Commits on the branch beyond main: VS-01 `5d32535d`, VS-02 `d9de4cba`, VS-03 `d9d5e040`, VS-04 `852fc2ec`, Phase 0
  review `180e574f`, CI fixes `cfae815c`/`7a5e9cf0`, VS-06 `92484fa5`+`b2451818`, VS-07 `6325462f`, Phase 1 review
  `dbcfbe8f` (git log origin/main..origin/vectorscope). 58 files, +18,787/-271 vs main.
- Drift vs main: main has `3ae59867 fix(review): reserve using actual context price tiers` changing
  `packages/engine/src/review/run.ts` (adds `Track.cost`, `Session.costAt` long-context tier pricing in `nextCost`)
  that `vectorscope` lacks (`git diff 1aec0b0e origin/main -- packages/engine/src/review/run.ts`). Merging main will
  trip the VS-07 source pin `REVIEW_PIPELINE_SOURCES = "cebdc594212560b1"` (`packages/core/src/review/model-evidence.ts:39-42`)
  and force a decision on `REVIEW_PIPELINE_REVISION` (`model-evidence.ts:32-37`).

## 2. The exact pipeline

### 2.1 Surfaces and entry points

| Surface | Entry | Runner | Trust source |
| --- | --- | --- | --- |
| GitHub Actions | `githubReview` `packages/engine/src/cli/cmd/github.review.ts:1098-1234` -> `executeReviewJob`/`reviewJob` `:196`, `:231` | `Review.run` (`:1202`) | `pull.fork ? "untrusted" : "trusted"` (`:264`) |
| CLI `vector review` | `executeLocalReview` `packages/engine/src/cli/cmd/review.ts:182` | `Review.run` (`:1284`) | `--pr` => untrusted, own changes trusted (`:203`) |
| Desktop panel | `runReview` `packages/app/src/features/pull-requests/ai-review.ts:664` via SDK client | its own loop (`runSpecialist` `:1382`, `runVerify` `:1515-1559`) | checkout match => trusted, rebuilt => untrusted (`chooseCheckout` `:538-566`); memory scope by `authorship` (`:574-579`) |
| Eval | `ReviewEval.replay` `packages/engine/src/review/eval.ts:195`; `desktopReplay` `script/vectorscope-eval/desktop.ts` | `Review.run` / desktop `runReview` | dataset cases replay untrusted (`eval.ts:235-238`) |

### 2.2 Settings and skips (zero-token stage)

- Config `.vector/review.json` + env overrides + defaults (`packages/core/src/review/config.ts:174-222`). Defaults
  (`packages/core/src/review/types.ts:255-283`): incremental true, minSeverity concern, minConfidence 0.7,
  maxComments 10, maxCommentsPerPr 25, security auto, verify blocking, verifyPolicy legacy, modelEvidence off,
  maxFiles 300, maxChangedLines 5,000, maxDiffChars 120,000, maxSteps 30, maxCostUsd 2, maxCostUsdPerPr 10,
  maxCostUsdPerMonth 0, timeoutMinutes 12, nits false. `triageModel` forces verify away from "off" (`config.ts:214-220`).
- Settings come from the PR base in CI (`github.review.ts:278-290`), working tree for trusted local, base blob for
  `--pr` (`review.ts:214-226`); desktop refuses settings a PR changes (`ai-review.ts:682-695`).
- `decideSkip` (`packages/core/src/review/skip.ts:49-74`), first match wins: month-budget, then auto-only label
  (`vector:paused` + skipLabels), draft, author (dependabot/renovate), branch, fork; already-reviewed head;
  auto per-PR budget; nothing-to-review; auto too-large (>300 files or >5,000 changed lines after ignores). A command
  (`/vector review`) on a fork runs untrusted (`skip.ts:63-64,73`). GitHub job calls it at `github.review.ts:369-384`.
- File classification: lockfiles, `DEFAULT_IGNORES` (dist, node_modules, snapshots, generated, min/map, pb), binaries,
  deleted, size-limit, user ignores (`packages/core/src/review/ignore.ts:8-47,199-215`); generated headers count only when
  the base agrees (`github.review.ts:519-547`; `review.ts:317-332`).
- Incremental/carry planning: `planRange` (`packages/engine/src/review/source.ts:190-243`): full on first/forced;
  incremental focus hunks when ahead; force-push compared by patch-id per file, identical => `carry` (no model call)
  (`source.ts:226-235`). Desktop reuses the last outcome when every file key and settings hash is unchanged
  (`ai-review.ts:700-762`).
- There is **no trivial-change classifier**: docs-only, comment-only, whitespace-only or version-bump changes still go
  to the model (doc extensions are only used to exclude paths from sensitivity, `ignore.ts:109,133`).

### 2.3 Context gathering

Engine (`packages/engine/src/review/context.ts`), all via git, no shell for the model:
- `relatedCode` (`context.ts:28-80`): up to 10 symbols from `changedSymbols` (regex per TS/JS, Py, Go, Rust, Java,
  `packages/core/src/review/symbols.ts:1-3,49-143,149-177`), `git grep -n -w -F` at head, 15 hits each, 200 chars/hit,
  excludes ignored paths.
- `history` (`context.ts:82-144`): 10 largest changed files, last 5 commits each, porcelain blame at base for up to 20
  removed/rewritten ranges; shallow-clone boundary labelled.
- `baseInstructions` (`context.ts:146-174`): AGENTS.md (or CLAUDE.md) and `.vector/RULES.md` from the base, 16 KB each
  (CI only; locally the engine loads instructions normally).
- `requirements` (`context.ts:176-240`): Brain links of changed files (<=40 files) to records of kind
  requirement/constraint/contract/decision with anchor weight >=0.6, with drift flags ("drifted", "missing",
  "code says X"), cards text <=160 chars, <=300 tokens total. Wired only into the CLI: `deps.requirements`
  (`review.ts:133-139,386-389`) implemented at `review.ts:1302-1317` with
  `personal: !input.shared && chosen !== undefined && !freeModelMayTrain(chosen)`; `shared` = `--post`.
  GitHub job has no Brain (`github.review.ts:674` context = gathered + team + humans). Desktop has none
  (`ai-review.ts:821-848`). The eval replay excludes it on purpose (`vectorscope-deviations.md:61-65`).
- `gather` combines related, history, instructions (`context.ts:247-273`); GitHub calls it via `createReviewGit`
  (`github.review.ts:1084`); CLI at `review.ts:378-385`; eval at `eval.ts:411`.
- GitHub-only extras: human comments, last 30, 1,000 chars (`github.review.ts:126-127,315,1318-1347`); team-dismissed
  patterns from up to 3 pages of the bot's dismissed markers (`:316-327`); prior findings rebuilt from sticky state and
  the bot's own threads (`:572-658`). PR text = title, body, author only, no commit list (`:675`).
- CLI: commit subjects as `pr.commits` (`review.ts:402-414`). For untrusted PRs, `headFiles` (PR versions <=40 KB
  whole, else hunks with 20 lines context) (`source.ts:245-283`).
- Desktop-only: CI checks with failing-step log excerpts (`ai-review.ts:670,845`; IPC `checks`
  `packages/desktop/src/preload/types.ts:288-289`); its own `relatedCode` via the engine's ripgrep `find.text`
  (`ai-review.ts:1352-1380`); no history/blame, no team-dismissed, no prior findings.
- Engine `RunInput.context` type is `Pick<PromptInput, "related"|"history"|"requirements"|"instructions"|"teamDismissed"|"humanComments">`
  (`packages/engine/src/review/run.ts:105`): the engine pipeline never sends CI check results (prompt supports them,
  `packages/core/src/review/prompt.ts:35-41,324-327,386-400`).

### 2.4 Prompt construction (`packages/core/src/review/prompt.ts`)

- Packing: `budgetDiff` with `diffBudgetChars(min(model ctx, triage ctx), maxDiffChars)` = 30% of context after a
  reserve at 3.5 chars/token, clamped 8,000..maxDiffChars (`packages/core/src/review/plan.ts:152-159`; `run.ts:590-611`).
  `packChanges` shows each file once, annotated when its exact PR text is at hand and not larger
  (`packages/core/src/review/pack.ts:1-37`). Incremental: focus files first; settled files without context.
- Section order (`prompt.ts:231-305`): task (REVIEW_TASK `:117-118` "Report only problems that make the code wrong...
  a short list of real bugs beats a long list of opinions"; SECURITY_TASK `:120-126` security only, category security,
  never print secrets); How to work (open files, follow callers, `:252-256`); Anchoring (RIGHT lines, `:257-260`);
  Suggestions (exact replacement, `:261-264`); Confidence and severity ("0.9 proven, 0.7 likely, below 0.5 dropped";
  blocking = users break/data lost/security hole; concern = real edge-case bug; nits only if asked, `:265-269`);
  Each finding (what/when/why + `Fix:`; repeated defect = one finding, `:270-273`); Do not report (style, refactors,
  unread-dependent problems, already-commented, team-dismissed, old TODOs, `:235-246`); Limits ("No findings is valid";
  at most `max(4, 2*maxComments)`, `:275-279`); Untrusted text rules + injection finding title
  "Instructions aimed at AI reviewers" (`:94,280-284`); Open findings / Focus; then data blocks (all untrusted-wrapped
  and tag-escaped: `wrapUntrusted` `:180-191`, `STRUCTURE_TAG` `:128-131`); then trusted `<repository_instructions>`
  and `<review_rules>` last (`:440-453`). Static sections come first for provider prompt caching (`:248-249`).
- Second-line caps: 30 comments, 10 symbols, 15 hits, 10 history files, 16k trusted chars, 30 team patterns,
  20 checks, 4k check chars, 1,600 requirement chars (`prompt.ts:96-106`).
- Owner memory: prompt part metadata `vector.review` = changed paths + trust choose owner memory lines, never PR text
  (`prompt.ts:133-178`; `run.ts:510-511`; desktop `ai-review.ts:870-872,1429`). `ownerBlock` says nothing in it may drop
  or downgrade a security/blocking finding (`prompt.ts:170-178`).
- Verify prompt (`prompt.ts:201-225`): re-read cited code; confirm only when "real and triggered as described"; reject
  style/naming/refactor and anything unconfirmable; candidates wrapped `<untrusted_candidate>`; triage fixed-claims too;
  only head files cited by candidates/evidence (`pack.ts:39-57`).
- Finalize prompt: "Stop investigating. Return the findings you have confirmed so far." (`prompt.ts:227-229`).
- Output schemas: `REVIEW_REPORT_JSON_SCHEMA` (summary, risk, files, findings with path/line/endLine/side/severity/
  category/title<=100/body/suggestion/confidence/evidence/rule/duplicateOf, priorStatus)
  (`packages/core/src/review/schema.ts:27-90`), `VERIFY_JSON_SCHEMA` (`schema.ts:92`); max 100 findings, suggestion
  <=8,000 chars/80 lines (`schema.ts:15-23`). Structured output with `retryCount: 0` (`run.ts:509`;
  `ai-review.ts:127-128`).
- Agent system prompts: specialist sessions run as agent `review` or `security` (`run.ts:505`); verify runs as agent
  `review` (`run.ts:505`, desktop `ai-review.ts:1538`). Prompts: `packages/engine/src/agent/prompt/review.txt:1-12`
  (generic senior reviewer; says Bash runs git/gh/test commands, though the review session permission denies bash),
  `security.txt:1-13`; definitions `packages/engine/src/agent/agent.ts:518-527,570-579`. No dedicated `vectorscope`
  agent yet (VS-09 planned, `vectorscope-plan.md:319`).

### 2.5 Passes (engine `Review.run`, `packages/engine/src/review/run.ts`)

- Permissions per session: deny `*`, allow read/grep/glob/list, deny `.env*` (except .env.example), keys, .ssh, .aws,
  .git, .npmrc, `read mcp:*`; `external_directory` only for the truncation glob (trusted only) and allowDirs; `--checks`
  only adds test/typecheck commands without flags; StructuredOutput allowed
  (`packages/core/src/review/permission.ts:1-87`; `run.ts:229-235`). Permission prompts are auto-rejected (`run.ts:283-290`).
- Sessions: hidden helper sessions `internal: "vectorscope.<name>"` (`run.ts:395-401`); run guard loop rules ignored
  (`run.ts:416-418`).
- Specialists: `planSpecialists` = review always; security when "always" or "auto" and a sensitive path changed
  (`plan.ts:34-45`; sensitive words/paths `ignore.ts:84-142`). Both run in parallel, concurrency 2, both on the triage
  model when set (`run.ts:639-652`). Step caps: review maxSteps, security ceil(2/3 maxSteps) (`run.ts:646`).
- Per-session flow `ask` (`run.ts:374-588`): first prompt with deadline; on stop/no report, a finalize prompt in the
  same session with all tools but StructuredOutput denied, one reserved attempt (`run.ts:547-572`); failures become
  `failed` with the most specific provider error (`run.ts:943-956`).
- Normalize: findings get id = fingerprint(path, category, normalized title words, normalized anchored code)
  (`run.ts:897-914`); reports merged (summary from review, max risk, union of findings) (`run.ts:958-983`).
- Verify (`run.ts:663-751`): candidates by `verifyCandidates` (`plan.ts:47-150`):
  legacy engine: "blocking" => blocking >=minConfidence + untrusted suggestions; "all"/triaged => all non-nit >=minConfidence;
  "off" => none (unless triaged). Shared (opt-in): untrusted suggestions always candidates, one per id. Verify runs on the
  review model, 10 steps (`run.ts:196,723-730`), skipped if unaffordable at the low estimate or <2 minutes left
  (`run.ts:698-722`). Rejected findings dropped; confirmed marked `verified`; after triage only confirmed non-nits kept
  (`plan.ts:107-113`; `run.ts:731-745`); triage "fixed" claims need review-model confirmation (`run.ts:677-687,745-751`).
- Partial coverage: unreviewed files computed from what finished specialists read (`run.ts:787-816`).
- Notes: verify/triage unfinished notes, cost incomplete note, model-evidence notes (`run.ts:818-890`).

Desktop runner differences (`ai-review.ts`): same core prompts/selection, but: no dollar cap (no `maxCostUsd` use; only
`REVIEW_TIMEOUT_MS = 10 min`, `ai-review.ts:111,874-875`); `config.maxSteps` used only in estimates (`:852-859,1593-1611`);
model = review.json model, else the agent's model, else fallback; Codium never auto-chosen (`:764-779`); verify on all
non-nits in legacy (`plan.ts:134-144`); selection always `mode: "full"`, no prior/teamDismissed (`ai-review.ts:1036-1052`).

### 2.6 Triage, severity, selection (`packages/core/src/review/select.ts:153-364`)

1. Drop empty, ignored path, unknown path (outside diff and not in repo), low confidence (<0.7), nits/style unless asked
   (`select.ts:160-174`; `isNit` `:148-151`).
2. Dedup within run: by id unless far apart, or `sameFinding` (near <=3 lines with title similarity >=0.3, same fix or
   same code); stronger finding kept; security copy keeps code reviewer's category (`select.ts:176-220`).
3. Team memory: -0.15 confidence when similar (>=0.5) to >=2 dismissed patterns, then re-threshold (`select.ts:222-231`).
4. Prior findings: matched by duplicateOf/id/location+title; dismissed stays dropped; fixed or raised-to-blocking
   continues the earlier id; still-open is not re-commented (`select.ts:233-255`; `matchPrior` `:85-111`).
5. Repeats in one file folded into one comment with "also at" lines (`select.ts:257-280`).
6. Anchoring to the diff: outsideDiff, incremental "elsewhere" (non-blocking outside focus), below minSeverity => nits
   list, else placed (`select.ts:282-299`).
7. Order (severity, verified, confidence, path, line), caps: per run `min(50, maxComments)`, per PR remaining of
   `maxCommentsPerPr`; the first injection warning always posted (`select.ts:301-310,370-372`).
8. Suggestions committable only when the anchor is exactly the model's own lines, RIGHT side, <=40 lines, same indent,
   not identical, and in untrusted reviews only when verified (`select.ts:327-337`; `diff.ts:414-437`).
9. Risk: high if any blocking or security concern; medium if any concern, sensitive change with findings, or >800 lines;
   model risk can raise only to medium (`select.ts:122-141`).
- Severities: blocking/concern/nit; categories bug/security/reliability/performance/tests/maintainability/style/docs
  (`types.ts:4-16`). `failOn: "blocking"` fails the job while blocking findings are open (`github.review.ts:959-960`).

### 2.7 Posting

- GitHub job: sticky summary comment created/updated with a "running" body and state marker before work starts
  (`github.review.ts:473-482`); checkpoints update spend (`:688-693`); exact-head guards: trusted head must equal the
  checked-out head, a fork head is never checked out (`:265-276`); listFiles anchors used only if the head did not move
  (`:360-363,670`); after the run the head is re-checked and anchors re-resolved against the reviewed commit (`:719-741`).
  One `createReview` with only new inline findings; on 422 split in halves, single refused comment moves to the summary;
  commit-gone handling (`:759-820`). Fixed findings: comment edited, thread resolved, optional reply (`:832-858`).
  Final summary with next state (`:876-957`). All text through `redactSecrets` (`:235-236,339,804`; `redact.ts:1-42`)
  and the posting check `SessionPosting.headless` inside the GitHub client (`:1190-1193`), which follows session lineage
  depth 3 / 200 sessions (`packages/engine/src/session/posting.ts:14-25`).
- CLI: prints; `--post` goes through the required `posting` dependency (`review.ts:140-143,1291-1301`).
- Desktop: the user presses Post (`packages/app/src/features/pull-requests/pull-requests.tsx:1261-1300`) -> preload
  `pr-review` (`packages/desktop/src/preload/index.ts:100`; types `preload/types.ts:297-313`) -> main
  `submitPullRequestReview` (`packages/desktop/src/main/ipc.ts:423`; `packages/desktop/src/main/github-pr.ts:304-338`)
  -> `postPullRequestReview`: refuses if PR head moved, runs `checkPost` on all parts as one text with untrusted from
  GitHub (fork or someone else), posts with `commit_id`, falls back to body-only on 422 (`github-pr.ts:346-409`).

### 2.8 Budgets and cost reservation

- Engine: a dollar cap applies when any pass runs on a priced model and `maxCostUsd > 0` (`run.ts:223-228`).
  `reserve()` atomically replaces a pass's reservation and refuses when spent + uncertain + others + this > cap
  (`run.ts:257-268`). First-turn estimate = (prompt + schema chars)/3.5 tokens via `nextStepCostUsd` (`run.ts:378-394`;
  `plan.ts:200-208`). Each provider attempt (retries included) is admitted by a `SessionAdmission.Policy` with step,
  deadline and budget checks, plus one separately reserved finalizer (`run.ts:423-497`). Settlement adds reported cost;
  incomplete usage keeps the estimate as uncertain spend (`run.ts:471-494`). Verify affordability at the low estimate
  (`run.ts:698-718`). Header warns reservations are estimates, not a billing cap (`run.ts:1-5`).
- Pre-dispatch estimates: `estimateCostUsd` low/high model fitted on one measured review (`plan.ts:24-32,181-198`), shown
  for >50 files (`review.ts:88-91,360-371`; desktop `ai-review.ts:852-862`) and in the too-large note
  (`github.review.ts:448-468`). Context floor 32k (`plan.ts:11,170-175`).
- PR/month: per-PR cap skip (`skip.ts:68-69`), month scan of spend with "wait for a command" when unreadable
  (`github.review.ts:328-336,418-431`); in-flight spend folded into state (`:1268-1280`).
- Eval ledger (separate): `script/vectorscope-eval/budget.ts:4-25` (10% reserve, 2 chars/token input estimate,
  output = max_tokens, uncertain on missing usage, stop on overshoot/unpriced/cancel, append-only journal).

### 2.9 Model choice

- Engine `resolveReviewModel` (`packages/engine/src/review/model.ts:47-182`): CI order: triageModel exact,
  REVIEW_AUTO_MODEL (auto only), review.json model, MODEL env; with nothing chosen in CI, an available free model that
  is not "may train" (`model.ts:80-86`). Local: --model, review.json, `agent.review.model`, configured default. Refuses
  <32k context (`:137-138`). Cost kind via SpendGuard (free/plan/local/priced) (`:140-151`). `subject` records why
  (`:155-171`). Generated workflow writes `MODEL` (`packages/core/src/review/workflow.ts:232-233`).
- `triageModel` = cheaper first pass for review+security; verify on `model` (`types.ts:247-249`; `run.ts:111-113,225-226`).
- VS-07 model evidence notes only under opt-in; never switches (`model-evidence.ts:10-12`).
- Codium branch (not merged): A35 second-lab reviews `codium:packages/core/src/review/second-lab.ts:1-125` with lab
  detection `codium:packages/core/src/model-lab.ts:1-60` (11 labs from vendor path or family regex); `reviewModels()`
  runs the Codium review pair across labs, warns on same-lab pair, optional third-lab panel judge (`second-lab.ts:51-80`);
  footer "Checked by a second lab" (`:104-109`). Commit `298cc87f`, only on `origin/codium`.

### 2.10 Privacy and trust rules

- Untrusted text always wrapped/escaped; trusted instructions last (`prompt.ts:1-2,128-131,180-191,440-453`).
- Fork code never checked out; settings from base; CI requires `VECTOR_PURE` and `VECTOR_DISABLE_PROJECT_CONFIG`
  (`github.review.ts:272-285,1110-1115`); workflow also sets `{"lsp":false,"formatter":false,"snapshot":false}`
  (`workflow.ts:237-239`).
- Truncated tool output store not readable in untrusted reviews (`run.ts:229-235`).
- Memory audience depends on `vectorscope.*` internal metadata (`vectorscope-plan.md:254-260`); posting guard lineage
  bounded (`posting.ts:14-16`).
- Free/training: CI fallback excludes may-train (`model.ts:80-86`); Brain private documents only for a no-training model
  and never in a posted review (`review.ts:1302-1313`; `context.ts:176-180`). OpenRouter routing/presets get
  `data_collection: "deny"` unless training consent (`packages/engine/src/provider/provider.ts:2503-2521`;
  `packages/core/src/free-model-catalog.ts:206-233`). **Zero data retention is explicitly not requested**:
  `packages/core/src/free-model-choice.ts:14-15`, `packages/core/src/free-model-request.ts:175-186`.
- D6 forbids may-train candidates for the eval (`vectorscope-plan.md:27`).

## 3. What VS-01..VS-07 added (all on origin/vectorscope, none on main)

| Package | Added | Behaviour change? |
| --- | --- | --- |
| VS-01 Dataset contract | `script/vectorscope-eval/dataset.ts` (types, `manifestProblems`, `assignSplits`, `heldOutDigest`, `objectProblems`, `caseView`), `dataset/seed.json`, `annotation-guide.md`; `promptInput` moved to `fixture.ts` taking a label-free view (`vectorscope-deviations.md:6-38`). Seed = 10 cases from 10 repos: 8 bug (werkzeug, fastify, nats-server, caddy dev; vite, tracing calibration; click, hono held-out) + 2 controls (requests, express, dev), one draft label pass, not frozen, no held-out controls (`deviations.md:13-23`; seed.json). Adversarial `kind` added later (`deviations.md:359-365`). Full ~100-case set owned by no package (`deviations.md:366-373`). | No |
| VS-02 Production replay | `packages/engine/src/review/eval.ts` (`ReviewEval.replay`, `recordingPosting`), `RunInput.observe` hook (`run.ts:122-124,134-156,248-255`), `source.ts` `missingCommits`/`show` (`source.ts:113-137`), `script/vectorscope-eval/replay.ts` driver (plans + prepares checkouts only), `desktop.ts` desktopReplay via recording client (`deviations.md:40-88,345-354`). Replay refuses without eval's own positive maxCostUsd and untrusted without isolation flags (`eval.ts:195-245`). | No (observer only) |
| VS-03 Budgeted manual CI | `budget.ts` ledger, `ci.ts` (plan/paid/report/seal/unseal), workflow rework: dry-run default, `model=input:output` prices, total + per-case budget, protected env, key `VECTORSCOPE_EVAL_API_KEY`, outputs sealed (AES-256-GCM + RSA-OAEP) and uploaded 7 days (`.github/workflows/vectorscope-eval.yml:1-148`; `deviations.md:90-150,288-317`). `run.ts` sends only with budget; hosted endpoint only in CI env (`deviations.md:288-297`). Paid workflow runs `run.ts` (single-prompt smoke test on 10 synthetic fixtures), not the production replay (`ci.ts:37-44,65,353`). | No |
| VS-04 Causal judging and gate | core `review/eval.ts` (verdicts, settle, scoreRun, Wilson/Poisson/Newcombe intervals, `sameModel`), `eval-judge.ts` (blinding, Matcher, judgeRuns), `eval-report.ts` (`DEFAULT_GATE` = D2, `eval-report.ts:56-72`; loosening detection `:199`), `judge.ts`/`report.ts`, `judging-rubric.md`. Model judge never sole authority; settlement needs a human (`deviations.md:152-245,256-269`). No model judge connected to a provider. | No |
| VS-05 CLI setup | Not started; waits for `vector-at-mention` (`vectorscope-plan.md:315,375`). | - |
| VS-06 Verify parity | `verifyPolicy: "legacy"|"shared"` opt-in (`types.ts:224-227`; `config.ts:87,123,142-155,191-194`), `SHARED_VERIFY_DEFAULT = "all"` (`types.ts:285-287`), `verifyCandidates`/`verifyUnconfirmed`/`verifyUnanswered` with legacy branches copied from both runners (`plan.ts:47-150`), `noteVerifyUnfinished` (`format.ts:555`), desktop uses same notes under shared (`deviations.md:382-495`). Not measured; legacy stays default (`deviations.md:437-440,487-495`). | Only under opt-in |
| VS-07 Model evidence | `modelEvidence: "off"|"warn"` (`types.ts:228-231`), `model-evidence.ts` (certificates, scope digests, `MODEL_EVIDENCE = []` `:99-100`, 90-day max `:44-46`, statuses certified/unvetted/expired/stale/retired/rerouted `:117`, notes `:519-556`), `ResolvedModel.subject` (`model.ts:27-29,155-171`), retired-model refusal under opt-in (`model.ts:111-119`), `certify.ts`, setup card warnings (`ai-review.ts:442-479`; `deviations.md:497-594`), source pin of 10 pipeline files (`deviations.md:636-653`). | Only under opt-in (notes) |
| CI | Eval script tests in `test.yml` (`.github/workflows/test.yml:117-124`), script typecheck job (`typecheck.yml:32-44`). | - |

## 4. Eval results that exist

- **None.** No paid eval and no paid replay has run: "nothing has been run (D5, D12)" (`vectorscope-deviations.md:620`);
  VS-06 "Not measured, so no default changed" (`:437-440`, `:487-495`); `MODEL_EVIDENCE` empty because no model passed a
  held-out run (`model-evidence.ts:7-8,99-100`).
- Blocking prerequisites: D7 environment + new key + RSA public key are owner setup
  (`script/vectorscope-eval/README.md:246-270`); there is no engine entry point that runs a paid replay
  (`README.md:472-478`; `deviations.md:120-127,487-495`); the desktop paid replay needs an engine server
  (`README.md:476-478`); `report.ts` does not load desktop artifacts (`deviations.md:621-625`); seed not frozen.
- The only paid-capable path is `run.ts`, the single-prompt, tool-less, no-verify smoke test on 10 synthetic fixtures
  (8 planted bugs, 2 clean refactors) with line-proximity scoring (`README.md:57-78,272-296`; `vectorscope-plan.md:53`).
- Results are never committed: `--out` refuses repository paths (`README.md:297-298`). Paid outputs would be sealed to
  the owner's key and uploaded for 7 days (`vectorscope-eval.yml:132-148`).
- Dry runs (validate inputs/fixtures/manifest, estimate cost) are the default and are what CI tests exercise; whether
  any dry-run workflow dispatch happened cannot be seen from git (Actions history not read in this study).
- On `main`, the older harness ran manual OpenRouter jobs using the repository secret `OPENROUTER_API_KEY`
  (`main:.github/workflows/vectorscope-eval.yml:4,44-60`); no results from it are in the repository either.
- Other measured evidence on main is not review quality: tokenomics/benchmark docs mention a Vectorscope UI refresh
  fixture and e2e regression specs (`main:docs/benchmarks/vector-efficiency-2026-10/README.md:140`;
  `main:docs/benchmarks/vector-subagents-2026-10/ui/browser-final.log:130-135`), and a synthetic no-key review
  acceptance (`main:docs/vector/SERVICE-INDEPENDENCE-STATUS.md:25,106`).

## 5. Where each proposed upgrade plugs in

General constraints any upgrade inherits: D3 opt-in until D2 passes (`vectorscope-plan.md:23`); certification scope must
change (`EVIDENCE_POLICY_KEYS` `model-evidence.ts:48-61`, `canonicalPrompts` `:224-251`, `REVIEW_PIPELINE_REVISION` and
source pin `:32-42`); both runners must stay at parity until VS-10 consolidates them (`vectorscope-plan.md:316,320`);
renderer must not import engine runtime (`vectorscope-plan.md:201-205`); public API changes need client regeneration
(root AGENTS.md); `github.review*.ts` is owned by @vector until merge (`vectorscope-plan.md:347-357`); every measurable
change should be a named replay variant (`deviations.md:607-625`; `report.ts replayVariant`).

### 5.1 Brain context cards

- Today: Brain linked requirements only, CLI only, 300 tokens, untrusted-wrapped `<untrusted_linked_requirements>`
  (`context.ts:176-240`; `review.ts:386-389,1302-1317`; `prompt.ts:65-66,320-323,401`). Brain has richer inputs unused
  by review: `BrainCard.line` one-line cards with citation ids (`packages/core/src/brain/card.ts:6-30`),
  `BrainKnowledge.cards/links/review/code` (`packages/core/src/brain/knowledge.ts:492-497,582-590`), a code graph with
  imports/co-change and personalized PageRank seeded by touched files (`packages/core/src/brain/graph.ts:1-25`),
  regex symbol/import extraction for 20,000 files (`packages/core/src/brain/code.ts:6-9,371-473,507`).
- Plug-in: (1) a new gatherer beside `requirements` in `packages/engine/src/review/context.ts` that seeds BrainGraph with
  the changed files and returns top-N cards (records, passages, linked code) within a token cap; (2) extend
  `RunInput.context` (`run.ts:105`) and `PromptInput` (`prompt.ts:50-78`) with a typed cards field rendered as an
  untrusted block (data, not instructions) and add it to `canonicalPrompts`; (3) CLI: pass through `deps.requirements`'
  sibling at `review.ts:386-389`; (4) desktop: needs a protocol/server operation (renderer cannot call Brain directly;
  plan's VS-10 boundary) and client regeneration; (5) GitHub CI: no Brain on the runner, so either repository-shareable
  cards committed/published by the owner or none (VS-11 memory rules, `vectorscope-plan.md:238-252`).
- Guards: personal cards only for no-training models and never in posted/`--post` reviews (`review.ts:1312`); posting
  guard must see them (lineage); eval must keep labels/fixes out of the Brain index (`vectorscope-plan.md:101-104`;
  replay deliberately excludes requirements `deviations.md:61-65`). Measure as a replay variant (cross-file recall is the
  target metric per VS-16/17).

### 5.2 Three-tier pipeline (AST/dependency filter -> deep reasoning -> strict dedup/formatting guardrail)

- Tier 1 today = zero-token rules + regex: `decideSkip` (`skip.ts:49-74`), `classifyFiles`/generated headers
  (`ignore.ts:199-215`; `github.review.ts:519-547`), `planSpecialists` sensitive-path regex (`plan.ts:34-45`),
  `changedSymbols` regex + `git grep` (`symbols.ts:149-177`; `context.ts:31-80`), diff budget (`plan.ts:152-159`).
  Planned: VS-17 "deterministic syntax/call-graph context from pinned trusted parsers", no untrusted LSP in CI
  (`vectorscope-plan.md:327`). Plug-in: a pure core module (e.g. a new `review/filter.ts`) that ranks/filters files and
  hunks by AST/dependency impact (reuse `BrainCode.imports/dependencies` `code.ts:397-473` rather than a second parser),
  called after classification in each surface: GitHub after `github.review.ts:547`, CLI after `review.ts:330`, desktop
  after `ai-review.ts:697`, eval at `eval.ts` replay; its output feeds `budgetDiff` ordering (`run.ts:592-603`) and
  `planSpecialists`. Must never execute repository code in CI (`vectorscope-plan.md:208-212`).
- Tier 2 today = review + security specialists with read tools (`run.ts:639-652`). The existing `triageModel`
  (cheap first, expensive verify) is the inverse of "expensive deep reasoning on a filtered subset"; tier 2 would pass
  only Tier-1-selected hunks/symbol neighbourhoods into `promptInput` (`run.ts:612-637`).
- Tier 3 today = verify pass (`run.ts:663-751`) + `selectFindings` dedup/anchoring/caps (`select.ts:153-364`) +
  `sanitizeModelMarkdown` (`format.ts:139`) + redaction + posting guard. Strict dedup exists (fingerprint ids
  `run.ts:897-914`, `sameFinding`/`repeats` `select.ts:176-280`); a stricter guardrail would tighten here (e.g. require
  `evidence`, require verified for posting, reject findings without `Fix:`), as a selection variant.

### 5.3 Cross-model inversion by authoring model

- Today: model chosen only by setting precedence (`model.ts:47-91`; `ai-review.ts:764-773`); no code reads which model
  authored a change. Signals that exist: session `patch` parts recorded per assistant step (files changed) on messages
  that carry provider/model ids (`packages/engine/src/session/processor.ts:248-265`), usable for local/desktop reviews of
  agent-written uncommitted changes; PR commits carry no parsed model trailer (only a human `Co-authored-by` written in
  `github.handler.ts:548`). Lab mapping and cross-lab pairing exist only on `codium` (`codium:core/model-lab.ts`,
  `codium:core/review/second-lab.ts:51-102`).
- Plug-in: after codium merges, reuse `labOf`/`reviewModels` instead of a new mapping; add an `author` (lab) input to
  `ResolveInput` (`model.ts:36-45`) and the desktop picker (`ai-review.ts:525,764-773`); choose a review/verify model from
  a different lab; record it in `ResolvedModel.subject.choice` (`model.ts:155-171`) and in `EvidenceScope`
  (`model-evidence.ts:66-74`) so certificates cover it. Trust: the authoring signal must come from trusted local session
  lineage, never PR text, since PR/model text may not choose invocation fields (`vectorscope-plan.md:195-198`). Policy
  conflict: VS-07 promises "does not switch a chosen model" (`model-evidence.ts:10-12,541`), so inversion must be an
  explicit opt-in setting that names itself in notes, and must respect D6/no-training and Codium "never auto-chosen"
  (`ai-review.ts:776-777`; `main:docs/vector/MODEL-PLANS.md:19`).

### 5.4 Runtime verification in an isolated worktree

- Today: review mode cannot run code (`vectorscope-plan.md:208-212`); verify is read-only re-reading (`prompt.ts:201-225`);
  only the local `--checks` opt-in lets the reviewer run flag-less test/typecheck commands in the user's own checkout,
  with a confirmation when others authored commits (`permission.ts:24-40,75-84`; `review.ts:349-359`); CI forbids it
  (`github.review.ts:1110-1115`; `workflow.ts:237-239`). Infra present: engine git worktree service
  (`packages/engine/src/worktree/index.ts:22-75`), opt-in shell sandbox (seatbelt/bubblewrap, offline network rules,
  `packages/engine/src/tool/shell/sandbox.ts:32-35,123,157-219`); `self-evolving:packages/engine/src/task/isolation.ts`
  (worktree/copy isolation; refused for read-only agents per `vectorscope-plan.md:405`). Plan routes execution through
  VS-12 (fix worktree, consent) and VS-18 (isolated diagnostics, isolation a prerequisite) (`vectorscope-plan.md:322,328`).
- Plug-in: a separate "repro" sub-pass after verdicts (`run.ts:731`) for trusted local reviews only: create an isolated
  worktree at the reviewed head, run a model-written reproduction or the project's tests under the sandbox with network
  off, feed pass/fail as evidence into the verify verdict (or a new `verified: "runtime"` mark in `Finding`
  `types.ts:47-54`). Needs D10-style per-operation consent ("repository checks" is its own capability,
  `vectorscope-plan.md:31,216-233`), a new permission set (today's verify session denies bash), cost/time admission in
  `reserve()` (`run.ts:257-268`), and an explicit "checks not run" note when isolation is unavailable. Never for forks or
  privileged CI.

### 5.5 ZDR-only routing

- Today: no ZDR request anywhere; Vector states it does not request ZDR (`free-model-choice.ts:14-15`;
  `free-model-request.ts:175-186`); privacy is "no training" (`data_collection: "deny"`, `provider.ts:2503-2521`;
  `free-model-catalog.ts:206-233`), the CI free fallback excludes may-train (`model.ts:80-86`), VS-07 warns on may-train
  (`model-evidence.ts:527-531`), Brain private docs gated on no-training (`review.ts:1312`). Codium owns gateway privacy
  (`vectorscope-plan.md:413`).
- Plug-in: a `ReviewConfig` field (`types.ts:211-253`, `config.ts:77-108`, add to `EVIDENCE_POLICY_KEYS`) such as
  `privacy: "zdr"`; enforce at resolution in `resolveReviewModel` (`model.ts:100-151`) by refusing models without a ZDR
  record (the catalog has no such field today; needs catalog/provider metadata) and at request time where OpenRouter
  bodies are already rewritten (`provider.ts:2508-2521`, add a ZDR provider preference beside `data_collection`); same in
  the Core V2 runner path (`packages/core/src/session/runner/model.ts:311`). Desktop must apply it in the engine, not the
  renderer. Certificates should record the route (`rerouted` status `model-evidence.ts:117-131`). Eval key/models (D6/D7)
  should be ZDR too.

### 5.6 Pre-dispatch token budget with zero-token skip of trivial changes

- Today: pre-dispatch character budget for the diff (`plan.ts:152-159`), first-turn dollar reservation from prompt length
  (`run.ts:378-394`), estimates shown for >50 files (`review.ts:360-371`), too-large skip with estimate
  (`github.review.ts:448-468`), dollar caps $2/review, $10/PR, month (`types.ts:242-244`; `skip.ts:55-72`). Zero-token
  paths: `decideSkip` reasons, ignores, nothing-to-review, carry on rebase (`source.ts:226-235`), already-reviewed, desktop
  unchanged reuse (`ai-review.ts:705-762`). No token cap (only dollars, and only for priced models: free/plan/local
  reviews are uncapped in dollars, `run.ts:223-228`), and no trivial-change detector.
- Plug-in: a pure `trivial` decision in core next to `decideSkip` (new `SkipReason` in `skip.ts:11-21`) from the parsed
  `DiffFile`s (whitespace-only, comment-only, docs-only, lockfile/version bump, pure rename via `patchIdOf`), applied in
  the GitHub job (`github.review.ts:369-384`), CLI (`review.ts:330-332` early note), desktop (`ai-review.ts:727-740`) and
  eval replay; a token budget field (e.g. `maxInputTokens`) checked before `ask()` using the same estimate as
  `run.ts:380` (better: a tokenizer, `Token.estimate` already used in `context.ts:236`) and covering free/plan models.
  Trivial-skip changes what is posted, so it belongs in `EVIDENCE_POLICY_KEYS`. Risk: a security-sensitive "trivial"
  change (workflow/Dockerfile/.env) must never be skipped (`ignore.ts:94-107`).

### 5.7 Precision-over-recall output policy

- Today the product already leans to precision: prompt (`prompt.ts:117-118,234-246,265-279`), defaults
  (minConfidence 0.7, concern+, nits off, 10/25 caps, `types.ts:255-283`), selection drops and team penalty
  (`select.ts:160-231`), verify rejection (`run.ts:739-744`), untrusted suggestions only when verified
  (`select.ts:327-337`), and the D2 gate is precision-first (>=80% precision, <=0.2 false alarms/clean PR, recall may
  drop at most 5 points) (`eval-report.ts:56-72`). Under legacy only blocking findings are verified in the engine;
  `verifyPolicy: "shared"` verifies all non-nits (`types.ts:285-287`).
- Plug-in: (1) flip to verify "all" via the existing shared opt-in and measure it (`engine:shared-verify` variant,
  `README.md:416-426`); (2) generalize the triage rule "only confirmed findings are reported" (`plan.ts:107-113`;
  `run.ts:734-742`) into an opt-in `post: "verified-only"` policy for all reviews; (3) raise `minConfidence`/require
  `evidence` in `selectFindings` (`select.ts:160-174`); (4) per-category caps; all as replay variants judged by the D2
  gate, since a precision mode risks the 5-point recall rule.

## 6. Gaps and risks noticed

- Two runners still differ materially (dollar cap, step caps, context, prior findings, CI checks), so any upgrade must
  be done twice until VS-10 (`vectorscope-plan.md:55,320`).
- The paid CI path measures only the single-prompt smoke test, not the production pipeline; production replay has no
  paid entry point (`README.md:472-478`).
- Review/security agent system prompts are generic and mention Bash, which the review session denies
  (`review.txt:12`; `permission.ts:65`).
- GitHub job omits PR commit list and CI check results that the prompt supports (`github.review.ts:675`; `run.ts:105`).
- `main` has a price-tier fix in `run.ts` not on `vectorscope` (section 1), which will trip the VS-07 pin on merge.
- Seed dataset (10 cases, 2 held-out bugs, 0 held-out controls) cannot support D2 decisions; the ~100+25 set is owned by
  no package (`deviations.md:366-373`).
