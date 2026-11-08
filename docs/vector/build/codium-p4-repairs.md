# P4 phase review repairs (A21 to A28)

P4 reviews the label plan packages A21 to A28 (`codium-label-plan.md`), which no phase review covered. It runs as four
packages, P4a to P4d. This first part is P4a's review of A21 (`90f0c83f`) and A22 (`4fde1a49`): the range
`90f0c83f^..4fde1a49`, 59 files (`git diff --stat 90f0c83f^ 4fde1a49`). P4b, P4c and P4d append sections for A23 to
A28. Each finding was checked against the code at `dc64a6a5` (`origin/codium` on 8 Nov 2026). P4a found no code
defect, so it repairs no source and adds no test; the two confirmed findings, F5 and F14, are stale records, repaired
with dated status lines. Findings are numbered in reading order, F1 to F15, and each number is used once; P4b to P4d
continue from F16. No service, account, deployment or provider was called (the GitHub reads were read-only workflow
and job queries), no Codex-owned file (spec §0.5) was touched, and `api/_lib/model-plan-*.ts` was not edited. Contract
readings are in `codium-deviations.md` ("P4 review decisions (8 Nov 2026)").

## A21 contract

**F1. Old payloads might not decode once the cost kind and the billing fields exist.** Not confirmed.

- `CostKind` gains `"codium"` in both unions, `packages/schema/src/run-budget.ts:26-28` and
  `packages/core/src/review/types.ts:22`, and `packages/core/src/spend-guard.ts:20-21` keeps them equal at compile time.
  `packages/core/src/brain/knowledge.ts:65,214` takes the shared type (A21's "knowledge.ts takes the shared type"); the
  `costKind === "codium"` branch at `:3926` came later, with A24 (`fa16befa`).
- `Billing.Kind` (`packages/schema/src/billing.ts:12`) is only ever used as an optional field: V1 `StepFinishPart`
  (`v1/session.ts:271`) and `Assistant` (`:519`); V2 `Assistant` and `Compaction` (`session-message.ts:199,223`);
  `Step.Ended` (`session-event.ts:175`, durable version still 2) and the compaction and ancillary fields that reuse it
  (`:223,493,509`).
- Every new count is optional too: `SessionInfo.codiumSteps` and `subagentCodiumSteps` (`v1/session.ts:615,623`), V2
  `Session.Info` (`session.ts:43,51`), `Task.Usage` and `Task.BudgetScope` (`task.ts:31,45`), `Spend`
  (`session-status-event.ts:65`), `Snapshot` (`run-budget.ts:42`), the wire `BudgetStopError` (`v1/session.ts:83`) and
  its runtime copy (`packages/core/src/v1/session.ts:84`).
- Evidence here: `billing.test.ts` (39 pass) decodes a record from before each change without the new keys, round-trips
  it byte for byte and leaves unset keys out on encode; `event-manifest.test.ts` keeps the durable versions;
  `budget-stop-error.test.ts`, `wire-compat.test.ts` and `contract-identity.test.ts` pass (table below).

**F2. A provider-id literal might be left behind, or a replacement might change behaviour.** Not confirmed.

- `rg -n 'vector-plan' packages api`, leaving out tests, e2e, generated output, `dist`, fixtures and `node_modules`,
  finds only the allowed exceptions: the constant and its comment (`packages/schema/src/billing.ts:5-6`); the research
  answer prefix `vector-plan:` (`packages/core/src/research/plan.ts:94-95,114`, `packages/schema/src/research.ts:47`,
  `packages/app/src/features/research/research-model.ts:199,329`, `plan-card.tsx:36`); the typed
  `vector-plan/<model>` hints (`packages/engine/src/provider/provider.ts:1449`, `packages/engine/src/acp/error.ts:83`,
  `packages/engine/src/cli/cmd/codium.ts:44`); the `packages/core/src/model-lab.ts:100` comment; the plugin's import
  path (`packages/core/src/plugin/internal.ts:35`); and the display strip in `packages/core/src/review/format.ts:122`
  (A26, P4c and P4d scope). `api/` has none.
- Each replaced literal now compares against `Billing.CODIUM_PROVIDER_ID`, whose type is the same `"vector-plan"`
  literal, or calls `Billing.isCodium`, which is the same strict equality, so behaviour is identical:
  `dialog-select-model.tsx:151` (`VECTOR_MARKS`), `dialog-select-provider.tsx:46` (the provider filter),
  `settings-providers.tsx:34` and `settings-v2/providers.tsx:36` (`HIDDEN_PROVIDER_IDS`),
  `features/economics/format-spend.ts:38` (`spendKind`), `utils/provider-brand.ts:117` (`modelAccess`), all under
  `packages/app/src/`; `packages/core/src/model-plan-status.ts:22`,
  `packages/core/src/plugin/provider/vector-plan.ts:11` and `packages/schema/src/provider-policy.ts:222`.
- Tests: `format-spend.test.ts` (24 pass) covers `spendKind`, and `dialog-select-model.test.ts` (51 pass) covers
  `VECTOR_MARKS` and `modelAccess` from `provider-brand.ts`. `dialog-select-provider.tsx`, `settings-providers.tsx` and
  `settings-v2/providers.tsx` have no test file; they rest on the constant's identity and the app typecheck (in the
  full `bun turbo typecheck`).

**F3. The generated SDK and client might not match the generators.** Not confirmed.

- `check:generated` covers `packages/client` only (`src/generated`, `src/generated-effect`). It passed on A21's own run
  (job 124466390398) and on the head before this review: run 42439456526, Codium tests job 128605353887, step "Check
  generated client" (head `dc64a6a5`).
- The legacy SDK (`packages/sdk/openapi.json`, `packages/sdk/js/src/gen`, `src/v2/gen`) has no drift check in
  `vector-codium.yml`. Its last regeneration was A45 (`c9cd1bdb`), and A49 (`00d0e602`) and P7 (`d5975d28`) changed
  schema or server source after it.
- Both generators ran here at `dc64a6a5` (table below), exit 0. Afterwards
  `git status --porcelain --untracked-files=all packages/sdk packages/client` was empty: no tracked file changed and no
  untracked file was left (the build removes its own `openapi.json` and `openapi-v1.json`; `packages/sdk/js/dist` is
  ignored build output). Nothing needed restoring.

**F4. A custom provider named `vector-plan` would read as Codium (A21's version-skew note).** Not confirmed. No
configuration can carry the id: V1 deletes any configured `vector-plan` provider before listing Codium
(`packages/engine/src/provider/provider.ts:2234-2236`, "Codium replaces every user or project override of its ID"),
and V2 adds `VectorPlanPlugin` after `ConfigProviderPlugin` (`packages/core/src/plugin/internal.ts:147-151`), which
removes the id (`plugin/provider/vector-plan.ts:23-24`). Both were already there before A21 (`b57af809`, 24 Oct, an
ancestor of `90f0c83f`). Tests: `packages/core/test/model-plan-catalog.test.ts:26` and
`packages/engine/test/provider/model-plans.test.ts:108` (both pass, table below).

**F5. The A21 record says no CI result is recorded and owner step 9 is pending.** Confirmed, records only.

- A21 ran as Vector Codium run 41176960799 (run 29, push, head `90f0c83f`): success, 10 of 10 jobs. Typecheck jobs:
  desktop 124466390357, core 124466390361, api 124466390383, cloud 124466390428, web 124466390435, schema
  124466390441, engine 124466390450, app 124466390463. Codium tests 124466390398; Codium browser specs 124466390244.
- The Codium tests log has 4,954 lines; the GitHub tool returned 4,953 of them, from the runner's first line, so the
  whole test step is visible. It shows "Codium: 93/93 test files passed", with `packages/schema/test/billing.test.ts`
  39 pass 0 fail, `contract-hygiene.test.ts` 5 pass 0 fail, `packages/core/test/review/plan.test.ts` 11 pass 0 fail
  and `packages/app/src/components/dialog-select-model.test.ts` 51 pass 0 fail. The HttpApi exerciser printed
  `pass=304 fail=0`, and "Check generated client" passed.
- The A22 record already holds this run's result ("CI evidence before the change"). D1 checked only the A21 record's
  "Not run anywhere" bullet, against test.yml run 41268039624, and left the record unchanged.
- A21 reached self-evolving through `d36a3607` ("feat(integration): combine Codium accounting with isolated agents",
  1 Nov, second parent `4fde1a49`), an ancestor of `origin/self-evolving` (`e0bfa00b` on 8 Nov), the branch of PR #20.
- **Repair:** a dated status paragraph in `codium-a21-contract-notes.md`, after its owner step 9 paragraph. Nothing
  earlier in the record was changed.

**F6. Label plan §6: on self-evolving, an unknown persisted cost kind should decode as `"unknown"`.** Hand-off, not a
codium defect. At `origin/self-evolving` `e0bfa00b`, `RunBudget.CostKind` is still the closed six-value literal
(`packages/schema/src/run-budget.ts:26` there) and `Task.BudgetScope.costKind` reads it
(`packages/schema/src/task.ts:46` there), so a kind newer than the build still fails the decode of a record's
`budgetScopes`. It belongs to the self-evolving lane and owner step 9 (also in `codium-deviations.md`, "P4 review
decisions (8 Nov 2026)").

## A22 stamping and accounting

**F7. The `SessionV1.Event.Updated` strip list might write back stale Codium counts.** Not confirmed. The handler
(`packages/core/src/session/projector.ts:404-444`, its destructuring at `:409-429`) strips `codium_steps` (`:412`) and
`subagent_codium_steps` (`:415`) with every other usage column; A25 later added `tokens_own_only` and
`subagent_tokens_own_only` (`:416-417`). The stale-update cases in `session-projector.test.ts` and the engine
`session.test.ts` pass (table below).

**F8. A count might be subtracted that was never added, or go below 0.** Not confirmed for the totals.

- The A22 routing of cost, unpriced steps, `codium_steps` and tokens reads only the stored flag. `usage()`
  (`projector.ts:46-63`) takes `billing` from the step-finish part (`:59`), and `messageUsage()` (`:87-97`) from the V2
  row (`:93`). `contribution()` (`:230-243`) gives a flagged record `{cost 0, unpriced 1, codium 1, tokens 0}` and any
  other record its own values. `applyUsage()` (`:160-226`) writes `sign·next − prior` to the session and to every
  ancestor's subagent columns.
- Every subtraction reads the record it counted. V1: PartUpdated (`:540-567`, a replacement in place or a move between
  sessions), PartRemoved (`:523-539`) and MessageRemoved (`:504-522`). V2: Step.Ended (`:625-661`, `previous` read
  from the row before the row is updated), RevertEvent.Committed (`:760` on, `rowUsage` per removed row at `:785`) and
  MessageImported (`:349-357`, which adds from the row it stores). `message-updater.ts` writes the same cost,
  `unpriced`, `billing` and tokens onto the row (`:213-231` for Step.Ended, `:392-409` for Compaction.Ended), so a
  revert takes back what was added.
- AncillaryUsage (`:662-686`) and Compaction.Failed (`:700-718`) only add. Compaction.Ended (`:719-737`) adds, and its
  compaction row is subtracted on revert.
- Fork clears `billing` on copied step-finish parts with cost, `unpriced` and tokens
  (`packages/engine/src/session/session.ts:983`), so a copy contributes nothing.
- Archive import builds a fresh `SessionInfo` with no counts (`packages/core/src/share/archive.ts:352-364`) and replays
  parts, messages and ancillary records, so nothing is counted twice.
- The engine's `toRow` (`session.ts:139`) has no caller in source; `fromRow` (`:110,115`) and
  `packages/core/src/session/accounting-output.ts:28,31` map both counts.
- **Narrowed from the plan.** The own-only provenance bit that A25 (`ced763c3`) added to the same functions does read
  the provider id: `knownOwnOnly()` (`:77-79`) calls `Billing.hasOwnIdentity` (`billing.ts:25-28`), which calls `of()`
  with its provider-id fallback, and the V1 MessageUpdated handler calls it directly (`:479`). It feeds
  `SessionAccounting.contribute` and `tokens_own_only`, not the totals. A flagless `vector-plan` step written before A22
  reads as not own-only both when it is added and when it is subtracted, because the same function reads the same
  stored record. That is A25 code; P4c confirms it.
- The search `rg -n 'Billing\.(of|hasOwnIdentity)\b'` over `packages/core/src/session`, `packages/core/src/share` and
  `packages/engine/src/session` at `dc64a6a5` finds `projector.ts:78` and `:479` (`hasOwnIdentity`) and the engine
  usage summary's display reads (`session.ts:1291-1506`, A23), and no `Billing.of` in core's session or share code.

**F9. A path might record Codium usage without the flag.** Not confirmed.

- V1. `getUsage` (`packages/engine/src/session/session.ts:519`) returns cost 0, `unpriced` and `billing: "codium"` for
  a Codium model, before the Copilot and OpenRouter pricing paths. `updateMessage` (`:877-885`) stamps the published
  copy of every V1 assistant message, compaction included; it is the only V1 MessageUpdated publisher besides archive
  import (`archive.ts:445,540`). `processor.ts:684` (step-finish) and `:836` (`settleStarted`) copy `usage.billing`,
  and so does `title-usage.ts:32`.
- V2. `runner/llm.ts:421-427` (Step.Ended); `compaction.ts:248-250` (`spent`), published on Failed (`:252-259`, when
  usage was reported) and on Ended (`:262-270`); `message-updater.ts:221-222` and `:404` keep the flag on the rows.
  V2 `model.provider` is the provider id (`runner/model.ts:286`; the guard reads it at `:206`).
- The only step-finish writers in core and engine source are `processor.ts:680` and `:832`, and the only
  AncillaryUsage publisher besides archive import is `title-usage.ts:21`.

**F10. The share archive might leak Codium figures or drop the counts.** Not confirmed.
`packages/core/src/session/info.ts:32,37` and `packages/core/src/share/archive.ts:256,261` map the counts, and the
Native export uses the row mapping. `publicArchive` (`archive.ts:77`) leaves out `billing`, the counts, cost and tokens
(`public-session-share.test.ts`). The local archive keeps per-step tokens beside the flag, as D-2 allows. Also
checked: the V2 model-switched notice in `publicArchive` (`archive.ts:121`; `:122` at `4fde1a49`, so A22 already had
it) publishes `Model changed to ${providerID}/${id}`, so a public share of a Codium session shows the raw
`vector-plan/<model>` id. It carries no dollar, credit or token figure and no plan tier name, so P1 and P6 hold, and it
is the only place `publicArchive` writes a model or provider id (`PublicSession` has no model field). Accepted under
label plan §3.7 ("Public share. No change"); whether the notice should name the model instead of the raw id is
label-surface copy, handed to P4d with the other copy findings. No code change in P4a.

**F11. The subagent usage or the task note might show Codium tokens or wrong pricing text.** Not confirmed.
`subagent-lifecycle.ts:148-183` (`observe`) takes tokens and total from the session totals, which leave Codium out
since A22, and maps `codiumSteps` (`:174`); so does `task/manager.ts:186`, and `SubagentUsage` declares the field with
its comment at `agent/subagent-kind.ts:41-42`. `tool/task.ts` `renderNote` (`:304-351`) follows label plan §3.3: no
`tokens` attribute for a Codium-only child, the two Codium sentences, and a pricing sentence that counts only
`unpricedSteps − codiumSteps` and appears only when that is above 0. A25 later added the `tokensOwnOnly` gate
(`:322`). `task.test.ts` passes 116 cases here (A22 recorded 114).

**F12. The migration might be unsafe on an existing database.** Not confirmed.

- `20261031070337_session_codium_steps.ts` runs two `ALTER TABLE session ADD … integer DEFAULT 0 NOT NULL`, matching
  `schema.gen.ts:230-231` and `sql.ts:57-58`.
- `DatabaseMigration.applyOnly` (`packages/core/src/database/migration.ts:43-81`) skips a migration whose id is already
  recorded, one transaction each, so order does not matter. `origin/self-evolving` carries the same id and file, so
  no column is added twice. Older engines ignore the columns, and their inserts take the defaults.
- `bun script/migration.ts --check` from `packages/core` at `dc64a6a5`, exit 0: "No schema changes, nothing to
  migrate", then the full schema equal to `schema.gen.ts` and the registry current (the script throws otherwise);
  `git status` stayed clean. A25's `20261101020803_session_token_provenance` is the one migration added since.
- The existing-database case passes here with `-t` (table below), and in CI as listed under F14.

**F13. `Billing.of` reads a V1 user message on a `vector-plan` model as Codium.** Narrowed; not an A21 or A22 defect.
At `4fde1a49` `Billing.of` had no caller in source (`git grep 'Billing\.of(' 4fde1a49 -- packages api`, tests left
out, finds none), so A21 and A22 never read a message through it, and the projector reads none at `dc64a6a5`. `of`
does answer `"codium"` for a V1 user message, because it reads `model.providerID`. The message-level callers checked
here filter to assistants or parts first: `summarizeUsage` (`packages/engine/src/session/session.ts:1289`), the TUI
sidebar context (`packages/tui/src/feature-plugins/sidebar/context.tsx:67`), `packages/app/src/utils/codium-turn.ts:14`
and the composer (`packages/app/src/pages/session/composer/session-composer-region-controller.ts:145`). The aggregate
callers (`packages/core/src/codium-usage.ts:76`, `packages/desktop/src/main/run-usage.ts:118`,
`packages/engine/src/cli/cmd/stats.ts:225`, `packages/app/src/features/background-tasks/subagent-model.ts:538`) read a
session's `model.providerID` on purpose, the label plan §6 fallback for an older engine. All of these came with A23 to
A28; P4b to P4d check each caller in their range.

**F14. The A22 record says no CI result is recorded and owner step 9 is pending.** Confirmed, records only.

- A22 ran as Vector Codium run 41184766251 (run 30, push, head `4fde1a49`): success, 10 of 10 jobs.
- Its Codium tests job 124489334009 has 5,375 lines; the tool returned the last 4,999, starting inside the setup-bun
  step, so the whole test step is visible. It shows "Codium: 101/101 test files passed".
- The CI-only files: `packages/core/test/database-migration.test.ts` 19 pass 0 fail, including "adds the Codium step
  counts to existing sessions at 0 and leaves their totals as they were" and "declared schema has no ungenerated
  migrations"; `packages/engine/test/session/prompt.test.ts` 138 pass 1 skip 0 fail, including "a Codium session's
  title goes through the gateway and counts as a Codium step" and "a Codium subagent's steps count once, as Codium
  steps, and add no tokens or dollars".
- A22's other files, all 0 fail: `session-projector` 19, `session-runner` 100, `public-session-share` 20,
  `review/plan` 11, engine `provider/model-plans` 15, `processor-effect` 29, `session` 22, `title-usage` 12,
  `tool/task` 114, schema `billing` 39, `contract-hygiene` 5. The HttpApi exerciser printed `pass=304 fail=0`, and
  "Check generated client" passed.
- A22 reached self-evolving as the second parent of `d36a3607` (above).
- **Repair:** a dated status paragraph in `codium-a22-accounting-notes.md`, after its owner step 9 paragraph.

**F15. A22's obligations to A23 (C4, C5) and A25 (C9, `vector stats`).** Deferred to P4b and P4c.

## CI before this review

- **Run 42439456526** (push, head `dc64a6a5`, D1's record): completed, success, 14 of 14 jobs. Typecheck jobs: web
  128605353853, cloud 128605353876, ops-worker 128605353918, desktop 128605353941, relay 128605353953, core
  128605353960, app 128605353969, schema 128605353981, api 128605354000, engine 128605354036. Codium tests
  128605353887; Codium browser specs 128605353783; Ops Worker dry run and miniflare smoke 128605353890; Remote relay
  dry run and local smoke 128605353949.
- Its Codium tests log shows "Codium: 248/248 test files passed", the HttpApi exerciser at `pass=309 fail=0`, and
  "Check generated client" passing. The tool returned the last 4,999 of its 9,220 lines, which start inside
  `packages/engine`, before `test/session/retry.test.ts`. Of P4a's files, the visible ones are engine `session.test.ts`
  22, `title-usage.test.ts` 12, `tool/task.test.ts` 116, schema `billing.test.ts` 39 and `contract-hygiene.test.ts` 5,
  all 0 fail. The `packages/app`, `packages/core` and earlier engine files (`prompt.test.ts` and `processor-effect`
  among them) are cut off, so their file-level results in this run are unconfirmed; the step's summary covers them.
- **Runs 41176960799 (A21) and 41184766251 (A22)**: see F5 and F14 above.

## Tests run here (one file at a time)

Every run went through `/home/user/.tools/vector-serial` from the package directory with `--timeout 30000`, with XDG,
`VECTOR_TEST_HOME` and `TMPDIR` roots under `/tmp/vector-codium/p4a/`. All exited 0.

| Package | File                                                        | Result                   |
| ------- | ----------------------------------------------------------- | ------------------------ |
| schema  | `test/billing.test.ts`                                      | 39 pass                  |
| schema  | `test/contract-hygiene.test.ts`                             | 5 pass                   |
| schema  | `test/budget-stop-error.test.ts`                            | 1 pass                   |
| schema  | `test/event-manifest.test.ts`                               | 2 pass                   |
| schema  | `test/provider-policy.test.ts`                              | 3 pass                   |
| core    | `test/session-projector.test.ts`                            | 19 pass                  |
| core    | `test/public-session-share.test.ts`                         | 20 pass                  |
| core    | `test/session-runner.test.ts`                               | 100 pass                 |
| core    | `test/review/plan.test.ts`                                  | 11 pass                  |
| core    | `test/model-plan-status-compat.test.ts`                     | 4 pass                   |
| core    | `test/model-plan-catalog.test.ts`                           | 5 pass                   |
| core    | `test/database-migration.test.ts`, `-t` filter (1)          | 1 pass, 19 filtered out  |
| engine  | `test/session/processor-effect.test.ts`                     | 29 pass                  |
| engine  | `test/session/title-usage.test.ts`                          | 12 pass                  |
| engine  | `test/session/session.test.ts`                              | 22 pass                  |
| engine  | `test/tool/task.test.ts`                                    | 116 pass                 |
| engine  | `test/provider/model-plans.test.ts`                         | 15 pass                  |
| engine  | `test/session/compaction.test.ts`                           | 67 pass, 1 skip (3)      |
| engine  | `test/session/prompt.test.ts`, `-t` filter (2)              | 3 pass, 136 filtered out |
| client  | `test/contract-identity.test.ts`                            | 3 pass                   |
| sdk/js  | `test/wire-compat.test.ts`                                  | 10 pass                  |
| app     | `src/features/economics/format-spend.test.ts` (`--isolate`) | 24 pass                  |
| app     | `src/components/dialog-select-model.test.ts` (`--isolate`)  | 51 pass                  |

1. `-t "adds the Codium step counts"`: only "adds the Codium step counts to existing sessions at 0 and leaves their
   totals as they were", which applies the migration to an existing session table in one process. The nested-Bun
   "declared schema has no ungenerated migrations" case and the rest of the file are left to CI.
2. `-t "Codium"`: "a Codium session's title goes through the gateway and counts as a Codium step" (`:941`), "a Codium
   subagent's steps count once, as Codium steps, and add no tokens or dollars" (`:983`) and "a Codium turn after
   signing out reports why and offers Sign in to Vector" (`:1028`), all on the loopback gateway fake. `heldShell`,
   which starts `process.execPath`, is used only at `:2876` and `:2919`, outside the filter.
3. The skip is the existing `it.live.skip` "projects a compaction message to v2 (v2 projector disabled)" (`:716`).

Generators, through `vector-serial` with the same roots: `cd packages/client && bun run generate`, then
`./packages/sdk/js/script/build.ts` from the worktree root, both exit 0 and both clean (F3). `bun script/migration.ts
--check` from `packages/core`, exit 0 and clean (F12).

Typecheck: `bun typecheck` in `packages/schema`, `packages/core` and `packages/engine`, exit 0. The full
`TURBO_CACHE_DIR=/home/user/.cache/vector-typecheck bun turbo typecheck --concurrency=1` from the worktree root: 25 of
25 tasks successful (22 from cache). No generated file changed, so `packages/client` and `packages/sdk/js` needed no
separate run.

No mutation check ran: no source was repaired, so there is no regression test to prove.

**CI only:** the nested-Bun "declared schema has no ungenerated migrations" case and the rest of
`database-migration.test.ts`; `prompt.test.ts` outside the `-t "Codium"` filter; `bun run test:httpapi`;
`bun run check:generated`; and the full picker run with Valkey and Postgres. P4a's own push and its Vector Codium run
are recorded by the next package (P4b).

Edits to `api/_lib/model-plan-*.ts`: none.

Shared label files touched: none.
