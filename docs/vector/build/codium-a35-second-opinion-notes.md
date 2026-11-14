# A35 Second opinion and second-lab reviews: implementation record

A35 builds on A19 (catalog `judges` and `review`, the purpose header) and A26 (review cost wording). No provider,
Stripe, OpenRouter, GitHub or other external call was made. The tests use in-process fakes, the engine's fake LLM
server and the store fake. Readings of the contract are in `codium-deviations.md` under "A35 Second opinion and
second-lab reviews (2 Nov 2026)".

## What changed

| Area | Change |
| --- | --- |
| Labs | `packages/core/src/model-lab.ts` (new): `labOf(name, hint?)` reads the lab from the catalog's stated lab, a vendor path segment, the model family or a first-party provider id. Unknown means no lab and no second-lab claim. |
| Second opinion | `packages/engine/src/session/second-opinion.ts` (new): `enabled(users)` (the newest message the person wrote in the judged work), `judgeModel(...)` (Codium worker, no configured judge, setting on, a listed usable judge from another lab), `fromExtra(extra)`. `prompt.ts`: `secondOpinion` on `PromptInput`, `CommandInput` and the stored user message; the judge gate passes the judge's model as `extra.judgeModel` and copies the setting onto its repair message. `tool/task.ts`: the gate's own judge launch runs on that model at its entry's effort. |
| Listing data | `ModelV2.Codium` gains `judge` and `review`; `ModelPlans.listing(model, catalog)` fills them; the engine provider and the core plugin pass the catalog. SDK (`packages/sdk/js/script/build.ts`) and client (`bun run generate`) regenerated, not edited by hand. |
| App | `general.secondOpinion` (false). Settings → General shows "Second opinion" under LLM-as-a-judge only when the status has `entitlements.secondOpinion` (`second-opinion-model.ts`), and reads the status again on `codiumChanged()`. The composer sends `secondOpinion: true` only while the judge is on. |
| Review | `review.json` gains `panel` (false) and `judgeModel`. `packages/core/src/review/second-lab.ts` (new): `reviewModels()` (the plan's review pair on Codium, same-lab pair warns and runs one pass, the panel judge from a third lab), `checkedLabs()`, `checkedLine()` and the notes. `buildJudgePrompt()` in `review/prompt.ts`. `ReviewCost.labs` (2 or 3) carries the result to the footers. |
| Engine review | `review/run.ts` picks the models through `reviewModels()` (the pair from the Codium listing; `judgeModel` resolved by the runner when the caller passed none), runs the judge after a finished check with the check's caps, lets its verdict stand, adds `judge` to specialists and passes, and sets `cost.labs`. `cli/cmd/review.ts` resolves `judgeModel`; `review.render.ts` prints the line and names the judge pass. |
| Desktop review | `features/pull-requests/ai-review.ts`: the same choice from the catalog's `lab` and `review` fields, the judge pass (`vectorscope.judge`), `cost.labs`, "Panel judge" pass label, the footer line. |
| Footer | `format.ts` footer adds "Checked by a second lab" or "Checked by three labs" from `cost.labs`, own keys included. Codex's `github.review.ts` already passes `cost`, so GitHub summaries get it unchanged. |
| Listing | `api/_lib/codium-perks.ts`: readiness for `second-opinion` and `review-panel`, from `secondOpinionServed()` and `reviewPanelServed()` in `api/_lib/model-plan-models.ts`. Neither is ready until A60 accepts the staged routes. |
| Docs | `/docs/vectorscope` (`#second-lab`, the two new review.json keys), `docs/vector/MODEL-PLANS.md`. |

Edits to `api/_lib/model-plan-*.ts`: `model-plan-models.ts` gains the exported `secondOpinionServed()` and
`reviewPanelServed()`; the `/models` handler is unchanged.

## Tests run here (one file at a time)

| Package | File | Result |
| --- | --- | --- |
| engine | `test/session/second-opinion.test.ts` (new) | 8 pass |
| engine | `test/review/panel.test.ts` (new) | 5 pass |
| core | `test/review/second-lab.test.ts` (new) | 17 pass |
| app | `src/components/settings-v2/second-opinion-model.test.ts` (new) | 3 pass |
| app | `src/features/pull-requests/ai-review.test.ts` (4 new cases) | 110 pass |
| app | `src/components/prompt-input/submit.test.ts` (1 new case) | 57 pass |
| web | `test/codium-public.test.ts` (2 new cases) | 13 pass |
| engine | `test/review/run.test.ts` (unchanged, regression) | 33 pass |
| engine | `test/tool/task.test.ts` (unchanged, regression) | 116 pass |
| engine | `test/provider/model-plans.test.ts` (listing expectation) | 15 pass |
| engine | `test/cli/models-codium.test.ts` | 2 pass |
| core | `test/model-plan-catalog.test.ts` (listing expectation), `test/model-plans.test.ts`, `test/review/config.test.ts`, `format.test.ts`, `prompt.test.ts` | 5, 36, 16, 53, 26 pass |

Typechecks: schema, core, engine, app, client (`tsgo`), root `tsconfig.json` (api), web (`astro check`: 0 errors).

## Left for CI or later

- The CI lane runs every test file this branch added or changed; none of these has run in CI yet. The large engine
  file covering the judge gate (`test/session/prompt.test.ts`) was not run here.
- Settings → General's toggle and the desktop review's judge pass have not been looked at in a browser (no dev server
  on this Mac). Their logic is unit-tested and the components typecheck.
- No integration test drives the whole judge gate (a full session run ending in the judge with Second opinion); the
  gate's choice and the task tool's use of it are tested separately.
- The review token stops (400K per review, 2M per PR a day) do not exist in the code and are not built here (see the
  deviations).
- Engine reviews on Codium take the pair from the provider's Codium listing; that path is covered by the pure
  `reviewModels()` tests and the desktop tests, not by an engine test with a Codium provider.
- `bun.lock` was already modified in the worktree before this work and is not mine; it is left out of the commit.
