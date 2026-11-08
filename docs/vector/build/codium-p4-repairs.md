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

## A23 spend guard and usage

P4b reviews the range `4fde1a49..b4c05481` (`git log --oneline 4fde1a49..b4c05481`): A23 `7a7c664d` ("separate plan
usage from dollar spend guards"), the benchmark preparation `ad187830`, `67e3161e`, `084f4bdd` and A24 `b4c05481`, with
the A24 follow-ups the A24 notes name: `44c35f1c`, `9c5bc861`, `4bc40a87` and `d505d566`. It reads spec §5 A23 and A24,
invariant H5, label plan §3.1, §3.2, §4.3, §5, §6 and C4 to C8, the A23, A24 and benchmark notes, and the "A23: guard
and usage decisions" and "A24: app display decisions" sections of `codium-deviations.md`. Each finding was checked
against the code at `3082bb2c` (`origin/codium` on 8 Nov 2026, checked again before these records were written).
Findings continue from F16; F33 and F34, at the end, close what P4a left open. Line numbers are at `3082bb2c` unless a
finding says otherwise.

**F16. The research report's Spend line does not follow label plan §3.2.** Confirmed, repaired.

- Label plan §3.2 (the "Research report Spend: line" row) says: "Codium-only: no line, as today (it prints only when
  `spentUsd > 0`). Mixed: `$0.12 at list prices + Codium`." C4 says only that the wording "adds `+ Codium`".
- A23 made both report tools write `- Spend: Codium` whenever the guard counted a Codium step and no dollars:
  `packages/core/src/tool/research-report.ts:106-113` (V2) and `packages/engine/src/tool/research-report.ts:86-93` (V1),
  each `spend: spentUsd > 0 ? "… at list prices + Codium" : "Codium"`. No deviation entry covers that reading.
- A third writer was missed by the label plan and by A23: the V1 research judge saves the report again with its verdicts
  (`packages/engine/src/session/prompt.ts:1230-1233`, from `b57af809`, untouched since) with
  `${SpendGuard.formatUsd(spent)} at list prices` and no Codium term. So a judged mixed run (Deep, or Focused citing 8
  notes) ended with `- Spend: $0.12 at list prices`, without `+ Codium`, because the judge's copy replaces the tool's.
- No test pinned either wording: `grep -rn "at list prices"` over the tests found only `research/estimate.test.ts` (the
  plan card estimate) and `research/report.test.ts:241` (the renderer given a ready string).
- Shown against the previous source, before the repair (table below): the new core V2 case saved `- Spend: Codium`; the
  new engine tool case saved `- Spend: Codium`; the new engine judge case saved `- Spend: $0.12 at list prices`.
- **Repair** (line numbers after it): one helper, `SpendGuard.reportSpend(run)`
  (`packages/core/src/spend-guard.ts:228-234`, beside `formatUsd`, importing `CodiumUsage` from `./codium-usage`, which
  imports only schema, so no cycle): no line unless `spentUsd > 0`, else
  `CodiumUsage.withCodium("$X at list prices", codiumSteps)`. All three writers call it:
  `packages/core/src/tool/research-report.ts:86-88,108`, `packages/engine/src/tool/research-report.ts:71-73,88` and
  `packages/engine/src/session/prompt.ts:1230-1233`. Own-key and mixed reports keep the same text as before (the tool
  path's `$X at list prices` and ` + Codium`); only the Codium-only line disappears and the judged mixed copy gains
  ` + Codium`. Reports already saved are not rewritten. No schema, HttpApi or generated file changed.
- **Regression tests:** `packages/core/test/spend-guard.test.ts` "SpendGuard.reportSpend" (2 cases: no line for
  `undefined`, a $0 run and a 45-step Codium run under a $1 cap; then `$0.42 at list prices`,
  `$0.12 at list prices + Codium`, `<$0.01 at list prices + Codium` and a played mixed run);
  `packages/core/test/session/research-v2.test.ts` "a research run on Vector Codium saves a report whose Method has no
  Spend line" (the scripted run on a `vector-plan` model, so every V2 step is classified Codium by
  `runner/model.ts:206`); `packages/engine/test/tool/research-note.test.ts` "a run that spent no dollars beside its
  Codium steps saves a report with no Spend line"; and `packages/engine/test/session/research-judge.test.ts` "a judged
  report keeps a mixed run's Spend line, own dollars + Codium". The two engine cases begin the run in the test's own
  guard and record the Codium (and priced) steps there, because Codium's destination is fixed and the fake LLM server
  cannot stand in for it (label plan C5); the lead's own steps run on the free local test model and add no dollars. All
  four fail against the previous source (table below).

**F17. D-3 might not hold in the engine guard.** Not confirmed.

- `costKindOf` (`packages/core/src/spend-guard.ts:37-49`) checks `codium` first. `afterStep` (`:177-195`) adds $0 for a
  Codium step, adds nothing to the guard's `unpricedSteps` and adds 1 to `codiumSteps`. `checkLimits` (`:243-268`)
  checks dollars only for `priced` and `unknown` steps (`:247`), so neither the 40-step unpriced stop (`:254`) nor the
  prediction applies to Codium; the step limit (`:244`) and the loop rules still do.
- Evidence: the A23 cases in `spend-guard.test.ts` (45 Codium steps under a $1 cap all `ok`; step and loop stops still
  fire; a mixed run stops on own spend; scopes carry `codiumSteps`), 58 pass here.

**F18. The engine review model is never `costKind "codium"`.** Confirmed; repair deferred to P4d.

- Label plan §4.3 lists `packages/engine/src/review/model.ts:128-145` among the `costKindOf` callers that take `codium`.
  At `3082bb2c`, `review/model.ts:128-135` still calls `costKindOf({ free, oauthPlan, listed, local })` without it; the
  file's only commit is `b57af809`, so neither A23 nor A26 touched it. A Codium review model therefore comes out
  `"unknown"` (the engine lists Codium models with `cost: { ...UNPRICED }`,
  `packages/engine/src/provider/provider.ts:1806`, and they are neither free nor local), never `"codium"`.
- The other callers do pass it: `packages/engine/src/session/processor.ts:200`,
  `packages/core/src/session/runner/model.ts:206`, `packages/core/src/tool/research-plan.ts:113`,
  `packages/engine/src/tool/research-plan.ts:508` and `packages/engine/src/session/distill.ts:151`. The run guard
  classifies every review step through `processor.ts`, so D-3 holds for review sessions.
- What fails. `Review.run` (`packages/engine/src/review/run.ts`) gets its main model from `resolveReviewModel`
  (`github.review.ts:1214`). `chooseModels` (`:918-939`) picks triage, confirm and panel judge from the Codium listing
  through `resolved()` (`:942-952`), which does answer `"codium"`, but only when the review model is Codium and the
  caller gave no `triageModel` (`:920`). So `onCodium` (`:400`, P5 `0cef8b91`) is false, and `CODIUM_REVIEW_TOKEN_STOP`
  (400,000 tokens) never applies, for a Codium review with an explicit `triageModel` (both models resolved by
  `review/model.ts`), with no listed review roles, or with a same-lab pair (`reviewModels` keeps the review model and no
  triage, `packages/core/src/review/second-lab.ts:60-69`). The `unused` branch of the cost summary (`run.ts:310`, A26
  `9afebc91`) and the `kind` fallback for a run with no replies (`:339`, `!used.length ? model.costKind`) then report
  `"unknown"` (or `"free"`) for an unused or empty Codium review instead of `"codium"`.
- `packages/engine/test/review/panel.test.ts:414` builds its Codium models by hand (`{ ...model, costKind: "codium" }`),
  so no test reaches the resolver path.
- Not repaired here: the repair belongs to label plan C11, which lists `review/model.ts:128-145` and which spec A26
  owns, so it is P4d's range; it also changes what review budgets, footers and exports read and the P5 token stop. It
  needs no Codex-owned file: only `packages/engine/src/review/model.ts` and its tests change, and `github.review.ts`
  (Codex-owned under spec §0.5) keeps calling `resolveReviewModel` as it is. **Hand-off to P4d:** add
  `codium: Billing.isCodium(model.providerID)` to the `costKindOf` call in `review/model.ts`, with a case in
  `packages/engine/test/review/model.test.ts` that resolves a `vector-plan` model and expects `"codium"`, and a
  `panel.test.ts` case that reaches the stop with an explicit `triageModel` without building `costKind: "codium"` by
  hand. Also in `codium-deviations.md` (Lane status and "P4 review decisions").

**F19. Desktop limits might hold or reserve dollars for a known Codium run.** Not confirmed; one reading recorded.

- `packages/desktop/src/main/spend-limits.ts:293-297`: `evaluate` returns
  `{ allowed: true, state: "ok", unmeasuredRuns: 0 }` for `billing: "codium"` before `load()`, so no window is read and
  no reservation is made.
- `scheduled-agents.ts:562-586` reads the existing session's current model (`/api/session/<id>`) and falls back to the
  ordinary check when the read fails; the prompt body (`:486-495`) sends no model, so the session's model is the one
  that runs. `parallel-workspaces.ts:2227-2232` uses the provider pinned on the freshly created session
  (`parallel-session-scope.ts:17-40`).
- Tests: `spend-limits.test.ts` "known Codium runs bypass spent dollar windows and reserve no headroom",
  `scheduled-agents.test.ts` (both saved/current model directions) and `parallel-workspaces.spend.test.ts` (A25's mixed
  and Codium-only cases), all pass here.
- Reading: inside a known-Codium desktop run, a subagent on its own configured model
  (`packages/engine/src/tool/task.ts:955`, `next.model`) spends own-key dollars that the desktop windows do not stop
  mid-run, because no `budgetUsd` is sent. That spend is measured afterwards (`recordRunCost`,
  `scheduled-agents.ts:515-524`, and the parallel drain measurement), counts in the windows and blocks later own-key
  runs; the engine's own caps (`budget.run`, `--max-cost`, research limits) still stop it. This is what D-3, C8
  ("neither blocks such a run … nor reserves `budgetUsd`") and the A23 decision ask; no change.

**F20. Check-ins might carry `vector-plan`, Codium tokens or Codium cost.** Not confirmed.

- `summarizeUsage` (`packages/engine/src/session/session.ts:1284-1490`) filters to assistant messages (`:1289`) and
  leaves Codium out of tokens, cost, `favoriteModels` and `effortLevels` (the `metered` list, `:1291`) while still
  counting activity, `UsageDay.codium` and `codiumResponses`.
- `UsageReport.fromSummary` (`packages/schema/src/usage-report.ts:155-204`) forwards no Codium field. Both senders read
  the bundled local engine: `packages/desktop/src/main/usage-checkin.ts:237-249` and
  `packages/engine/src/cli/usage-report.ts:40,70-77`.
- `fromSummary` itself does not drop a `vector-plan` favorite; that input is unreachable under label plan §6 ("Desktop
  main + engine: no skew"), so no filter is added (reading in `codium-deviations.md`).
- Tests: `usage-checkin.test.ts` (24), `test/usage-api.test.ts` (46) and engine `usage.test.ts` (16) pass here; the
  exerciser scenario `experimental.session.usage.codium`
  (`packages/engine/test/server/httpapi-exercise/index.ts:122-138`) runs in CI.

**F21. A hand-written mapping might drop `codiumSteps`.** Not confirmed. The V2 spend response
(`packages/server/src/handlers/session.ts:345`), both `BudgetStopError` writers (`processor.ts:409`, `prompt.ts:2197`),
the desktop drain sum (`packages/desktop/src/main/run-usage.ts:161`, `combineSpend`) and the exerciser's
`v2.session.get.codium` and `v2.session.spend.codium` (`index.ts:141-168`) all carry it.

**F22. A23's self-evolving integration gate might be unmet.** Not confirmed, at `origin/self-evolving` `245f730f` (read
with `git show`, no checkout): `packages/engine/src/agent/subagent-kind.ts:51,92`,
`tool/subagent-lifecycle.ts:186,652,714` (`scopeFields` keeps `codiumSteps`) and `task/limits.ts:88,351,704-750`, where
the restart seed subtracts session Codium counts from unknown counts and keeps a Codium seed count.

**F23. `67e3161e` might have loosened the billing assertions.** Not confirmed. `test/codium-billing.test.ts` keeps all
three refusals with the same fields (503 `MODEL_PLAN_RENEWING` with `retryAfterSeconds: 1`, 503 `MODEL_PLAN_RENEWING`
for `holdPool`, 402 `MODEL_PLAN_REQUIRED` for the stranger), now on `Promise.allSettled` results. The no-Stripe
assertion moved after all three reads, so it now also covers the stranger's read, which is stricter.

## A24 app surfaces

**F24. H5 (one whole percentage; used + left = 100; the meter's `aria-valuenow` is the share left).** Not confirmed.

- `usageShare` (`packages/app/src/components/settings-v2/codium-usage-model.ts:4-8`) rounds once and derives
  `used = 100 − left`. The Usage card's meter (`packages/app/src/components/settings-vector-codium.tsx:181-198`, not
  under `settings-v2/`) has `role="meter"` and `aria-valuenow={share().left}` (`:187`).
- Settings → Account's own meter, which label plan §5 says the card reuses, is
  `packages/app/src/components/settings-v2/account.tsx:320-330` with `aria-valuenow={Math.round(left * 100)}` (`:326`),
  and its text comes from `account-model.ts:49` (`ModelPlanStatus.formatShare`, a whole-percent `Intl` format,
  `packages/core/src/model-plan-status.ts:159,324`).
- The server sends whole-percent shares (`api/_lib/model-plan-status.ts:298-300` and the meter fields at `:376`), so the
  two rounding paths, the Today and perk `1 − used` values and the account page's `UsageRow`
  (`packages/web/src/components/marketing/account/ModelPlans.tsx:442-462`) agree on every input the server can send.
- Test: `codium-usage-model.test.ts` "rounds one side … (H5)", 10 pass here.

**F25. Digits might appear beside Codium labels on A24 surfaces.** Not confirmed. Pill, tooltip, context tooltip and
ledger: `session-cost-readout.tsx:108,128-136,183` and the browser spec `codium-usage-labels.spec.ts` (CI). Working
status: `pages/session/composer/session-working-status.tsx:49-50`. Context ring: `session-context-usage.tsx:145`.
Context tab rows: `session/session-context-tab.tsx:107-112`. `Codium · 80 steps`
(`features/research/research-model.ts:155`) is the step cap label plan §3.2 names. The renewal card's response counts
are A32 and D-7 activity counts, outside this range.

**F26. Mixed work might lose own-key dollars or tokens.** Not confirmed. `features/economics/format-spend.ts:56-93`
(`sessionReading`) and `:95-117` (`spendPill`); `utils/session-cost.ts:7-23` (`formatSessionCost`) and `:25-56`
(`sessionSpend`); the browser spec's mixed case ("$0.12 + Codium", "48,213 + Codium").

**F27. The Settings → Usage card might miss spec A24's rows or refresh rules.** Not confirmed; one reading recorded.
Rows come from `codiumUsageRows` (`codium-usage-model.ts:10-46`); there is no purchased row; the card shows Velocity,
forecast, notices, the empty-state text, Change plan / Manage billing / Refresh and freshness. It refreshes on open, on
sign-in (`account.onChange`), on Refresh (`codiumChanged`), on focus at most once a minute (`createUsageRefresh`,
`:137-175`, the 60 s gate at `:154`), on `onCodiumChange`, and 15 s after a Codium turn ends (`:163`,
`utils/codium-turn.ts`, `pages/layout-new.tsx:3162`). It does not poll while closed; the 60 s interval only updates the
freshness text. Reading: Codium turns that end while a delayed read is pending share that one read (the account-settings
browser spec and the unit case "open usage refresh throttles focus, delays turn settlement once, and cancels on close"
pin this); a debit that lands after the read shows at the next focus or Refresh.

**F28. The 80% alert might repeat or be on by default.** Not confirmed for A24's desktop path; an A41 interaction is
confirmed and handed off.

- A24 (`b4c05481`): off by default (`packages/app/src/context/settings.tsx` sets `codium.alert80: false`; not touched
  here), and deduplicated by account, plan and renewal for the app lifetime (`settings-vector-codium.tsx:66-100`); a
  failed desktop `notify` removes the key so the next read tries again (`.catch(() => alertedPeriods.delete(key))`).
- A41 (`4caf1073`, P6's range) added a phone alert in the same block, sent before the desktop notification. When both
  are on and the desktop `notify` keeps failing, the key is removed after each failure, so every later run of the
  effect while Usage is open sends the phone alert again. The effect runs again when a status read changes a value it
  reads (the share left moving from 19% to 18%, or a good read after a failed one); `reconcile` leaves an unchanged read
  silent. `sendPhoneAlert`
  (`packages/app/src/context/phone-alerts.ts:36-41`) has no dedupe of its own. Confirmed by reading, not by a test. The
  block also compares the raw `left > 0.2`, which equals the rounded share only because the server sends whole
  percentages (F24).
- **Hand-off to the P6 addendum:** A41's code, outside P4b's range and already past the P6 review, goes to the package
  that appends the A36 review to `codium-p6-repairs.md`, since A41 is in P6's range; also in `codium-deviations.md` ("P4
  review decisions" and Lane status). Regression test for it: both switches on, the desktop `notify` rejects on two
  status reads whose share left differs (19% then 18% left), and exactly one `sendPhoneAlert` call (one
  `phoneAlerts.send`) is expected. Not repaired here.

**F29. The recommender and outcomes might use Codium.** Not confirmed.
`features/economics/economics-recommender.ts:26,100`, `economics-repository.ts:251`, `session-outcomes.ts:108`,
`workspace-outcomes.ts:64` and `token-usage.ts:134` leave Codium out; `economics-recommender.test.ts` (39),
`session-outcomes.test.ts` (26), `workspace-outcomes.test.ts` (11) and `token-usage.test.ts` (24) pass here.

**F30. The test-only follow-ups, or the feature commits, might have loosened assertions.** Not confirmed.

- `44c35f1c` changes the browser fixture's data only (zero cache rates the pricing reader requires, chronological
  message ids); every assertion is unchanged. `d505d566` only pauses the browser clock before scheduling the refresh;
  the 14,999 + 1 ms and request-count assertions are unchanged.
- `9c5bc861` adds `codiumSteps: 0` to four exact HttpApi spend snapshots in
  `packages/engine/test/server/httpapi-session.test.ts`, which `toEqual` requires once the field exists. It also renames
  the Host locally test from "the launcher and the agents' views read nothing of Vector's account, plan, credits or
  pricing" to "the launcher and the agents' views have no account or plan access", and lets `agent-dashboard-model.ts`
  keep exactly its usage-label code: three `.replace` calls (the `CodiumUsage` import at `:6`,
  `if (agent.billing === "codium") {` at `:253`, `CodiumUsage.withCodium(` at `:263`) each match once, and one
  `.replaceAll` removes the two `billing?: "codium"` declarations (`:38,250`). After stripping, the file has no other
  `codium` text and the full regex still applies to it and to every other file. The basis is label plan §3.1 and §3.2
  (the agent dashboard row: `Codium` or `$0.12 + Codium`) and C7 (`features/agents/agent-dashboard-model.ts:241-250`),
  which put that label in this file; the dashboard reads no account and gates no launch. `host-locally-model.test.ts`
  (17) passes here.
- The feature commits rewrote existing assertions only where the contract changed them. In `7a7c664d`:
  `model-plans.test.ts` (`costKind "unknown"` to `"codium"`, D-3 and §4.3), `run-usage.test.ts` (the snapshot helper
  takes `codiumSteps`, §2) and `scheduled-agents.test.ts` (a session-model option and the Codium allowance stub, C8; one
  expectation only reformatted). In `b4c05481`: `format-spend.test.ts` ("Codium credits" to "Codium", and the removed "A
  dollar cap counts Codium steps as unpriced" tooltip, label plan §2 copy and D-3), `session-cost.test.ts` and
  `task-board-model.test.ts` (results gain `codiumSteps` and the Codium wrap, C6 and C7), and engine `usage.test.ts`
  (`averageTokensPerChat` 50 to 100: own tokens divided by chats that had own tokens, §5 and the A24 decision).
  `usage-summary.test.ts` only gains cases. The `ai-review.test.ts` edits are A26's review surfaces (P4d).

**F31. The benchmark evidence might not match the notes.** Not confirmed. Medians recomputed here from
`docs/vector/build/evidence/codium-a24-baseline-ad187830.json` and `codium-a24-after-b4c05481.json` (the latter added by
`4bc40a87`, "preserve app benchmark comparison"): baseline 169.6/188.4, 198.7/340.8 and 136.0/230.4 ms (first/stable),
after 153.4/167.7, 178.9/276.2 and 122.7/206.6 ms; 9 of 9 passed in each run, 0 blank and 0 unknown samples, retry 0.
Run, job and artifact ids: 41256445800/124700512313/13063443541 and 41259171922/124708671285/13065165140, as the JSON
files record them. The benchmark and A24 notes link these runs under the repository name `scr1pter/claudeondfsfdaf`, the
name GitHub's own run records give; the lane reads them as `scr1pter/vectordev.ai`, where each id resolves.

**F32. Trailing `import { Billing }` lines.** Not a defect. `economics-recommender.ts:170`,
`economics-repository.ts:286` and `background-tasks/subagent-model.ts:1059` import at the end of the file; ES imports
are hoisted, so they are valid. Left as they are, to avoid churn in files shared with self-evolving.

## Left open by P4a (F15, F13)

**F33. A22's obligations to A23 (F15's C4 and C5 half).** Met. The C4 obligations in `codium-a22-accounting-notes.md`
("Obligations handed to A23") are `costKindOf({ codium })` with its callers `processor.ts` and the V2 `spendStep` (F17,
F18's list), the guard's `codiumSteps`, the V2 spend handler, `combineSpend` and `BudgetStopError.codiumSteps` (F21).
The C5 obligation is `summarizeUsage` leaving Codium tokens out and filling `codiumResponses`, `UsageDay.codium` and
`UsageHelper.codiumSteps` (F20). The A25 half (C9, `vector stats`) stays with P4c.

**F34. `Billing.of` callers added by A23 and A24 (P4a's F13 and its decision bullet).** Not confirmed; one reading.
`git grep 'Billing\.of('` (tests, e2e and fixtures left out) finds 14 callers at `7a7c664d` and 29 at `b4c05481`,
against none at `4fde1a49`. Each was read at `3082bb2c`:

- A23, `packages/engine/src/session/session.ts` (14): `summarizeUsage` reads the `assistant` list (`:1289`), ancillary
  usage records (model calls such as titles and compaction, never user messages) and `usageTokens` of assistant messages
  (`:1506`).
- A24, assistant role first: `session-context-metrics.ts:54,71` (`lastAssistantWithTokens`), `subagent-model.ts:507,529`
  (assistant messages and their step-finish parts), `format-spend.ts:122`, `token-usage.ts:134`,
  `session-composer-region-controller.ts:146` (`findLast` assistant), `utils/codium-turn.ts:21` and
  `utils/session-cost.ts:36`.
- A24, a session's or a model's provider id on purpose (label plan §6 fallback for an older engine):
  `subagent-model.ts:538` (gated by `tokensOwnOnly !== true`) and `utils/usage-summary.ts:87,106` (favourite-model
  entries, not messages).
- A24, `features/pull-requests/ai-review.ts`: the live tracker (`:562`) returns early for non-assistant messages.
  `reviewProgressSpend` (`:1600-1602`, A24 lines 1600-1601) reads `usageOf`'s messages unfiltered (`:1633-1644`), the
  review prompt included; a review prompt carries the pass's own model, so reading it as Codium means the pass runs on
  Codium, the same answer the §6 session fallback gives. The other `ai-review.ts` readers (`:1018,1064,1068,1610,1639`)
  are A26's (C11) and P4d's.

## CI before P4b

- **Run 42442788455** (Vector Codium, push, head `46236dce`, P4a's commit): completed, success, 14 of 14 jobs. Codium
  tests 128615372345; Codium browser specs 128615372346; typecheck jobs cloud 128615372320, relay 128615372329, engine
  128615372379, ops-worker 128615372384, app 128615372393, web 128615372402, schema 128615372479, api 128615372525,
  desktop 128615372527, core 128615372529; Ops Worker dry run and miniflare smoke 128615372268; Remote relay dry run and
  local smoke 128615372427. Its Codium tests log has 9,212 lines and the tool returned the last 5,000, which start in
  `packages/engine` at `test/session/retry.test.ts`: "Codium: 248/248 test files passed", the three HttpApi exerciser
  gates each at `pass=309 fail=0 skip=0 missing=0 extra=0`, and the "Check generated client" step successful. The
  `packages/app`, `packages/core`, `packages/desktop` and earlier engine files are cut off, so their file-level results
  are unconfirmed in this log; the step summary covers them.
- **Run 42444316138** (Vector Codium, push, head `3082bb2c`, another session's commit): completed, success, 14 of 14
  jobs. Codium tests 128619938670; Codium browser specs 128619938547; typecheck jobs cloud 128619938661, engine
  128619938714, desktop 128619938746, app 128619938747, core 128619938759, api 128619938765, relay 128619938808, web
  128619938831, ops-worker 128619938856, schema 128619938877; Ops Worker 128619938693; Remote relay 128619938612. Its
  Codium tests log (9,220 lines, the last 4,999 returned, from the same engine file on) shows "Codium: 248/248 test
  files passed", the exerciser gates at `pass=309 fail=0`, "Check generated client" successful, and, of P4b's files,
  engine `test/session/usage.test.ts` 16 pass and `test/usage-api.test.ts` 46 pass, 0 fail each.
- **typecheck.yml 42444321838** (workflow_dispatch, head `3082bb2c`): completed, success. **test.yml 42444319661**
  (workflow_dispatch, head `3082bb2c`): completed, success (run-level conclusion read by id; its job logs were not read
  here).
- **A23 and A24 runs named in their notes**, checked by id: 41256437634 (Vector Codium, push, head `ad187830`,
  completed, success) and 41261226062 (Vector Codium, workflow_dispatch on `codium-fixtures`, head `975b523b`,
  completed, success).

## Tests run here (P4b)

Every run went through `/home/user/.tools/vector-serial` from the package directory with `--timeout 30000`, one file at
a time, with XDG, `VECTOR_TEST_HOME` and `TMPDIR` roots under `/tmp/vector-codium/p4b/`. Desktop runs add
`--no-env-file`, app runs `--isolate`; the root API file ran from `test/`. All exited 0 after the repair.

| Package | File                                                        | Result                            |
| ------- | ----------------------------------------------------------- | --------------------------------- |
| core    | `test/spend-guard.test.ts`                                  | 58 pass (2 new)                   |
| core    | `test/session/research-v2.test.ts`                          | 21 pass (1 new)                   |
| core    | `test/research/report.test.ts`                              | 14 pass                           |
| core    | `test/model-plans.test.ts`                                  | 36 pass                           |
| core    | `test/research/estimate.test.ts`                            | 10 pass                           |
| core    | `test/codium-usage.test.ts`                                 | 1 pass                            |
| engine  | `test/tool/research-note.test.ts`                           | 2 pass (1 new)                    |
| engine  | `test/session/research-judge.test.ts`                       | 8 pass (1 new)                    |
| engine  | `test/tool/research-scripted-run.test.ts`                   | 1 pass                            |
| engine  | `test/tool/research-plan.test.ts`                           | 7 pass                            |
| engine  | `test/session/processor-effect.test.ts`, `-t Codium`        | 3 pass, 26 filtered out           |
| engine  | `test/session/usage.test.ts`                                | 16 pass                           |
| engine  | `test/review/model.test.ts`                                 | 12 pass (F18 baseline, unchanged) |
| desktop | `src/main/spend-limits.test.ts`                             | 38 pass                           |
| desktop | `src/main/scheduled-agents.test.ts`                         | 67 pass                           |
| desktop | `src/main/usage-checkin.test.ts`                            | 24 pass                           |
| desktop | `src/main/parallel-workspaces.spend.test.ts`                | 10 pass                           |
| desktop | `src/main/run-usage.test.ts`                                | 24 pass                           |
| app     | `src/components/settings-v2/codium-usage-model.test.ts`     | 10 pass                           |
| app     | `src/features/economics/format-spend.test.ts`               | 24 pass                           |
| app     | `src/utils/session-cost.test.ts`                            | 14 pass                           |
| app     | `src/features/agents/agent-dashboard-model.test.ts`         | 39 pass                           |
| app     | `src/components/settings-v2/spend-limits-model.test.ts`     | 10 pass                           |
| app     | `src/features/economics/economics-recommender.test.ts`      | 39 pass                           |
| app     | `src/features/economics/session-outcomes.test.ts`           | 26 pass                           |
| app     | `src/features/economics/workspace-outcomes.test.ts`         | 11 pass                           |
| app     | `src/features/economics/token-usage.test.ts`                | 24 pass                           |
| app     | `src/components/session/session-context-metrics.test.ts`    | 7 pass                            |
| app     | `src/components/settings-v2/memory-documents-model.test.ts` | 30 pass                           |
| app     | `src/context/settings.test.ts`                              | 3 pass                            |
| app     | `src/vector-account.test.ts`                                | 15 pass                           |
| app     | `src/features/agents/host-locally-model.test.ts`            | 17 pass                           |
| app     | `src/features/background-tasks/task-board-model.test.ts`    | 13 pass                           |
| app     | `src/features/background-tasks/subagent-model.test.ts`      | 69 pass                           |
| app     | `src/features/research/research-model.test.ts`              | 24 pass                           |
| app     | `src/components/budget-stop-copy.test.ts`                   | 12 pass                           |
| app     | `src/utils/usage-summary.test.ts`                           | 5 pass                            |
| root    | `test/usage-api.test.ts`                                    | 46 pass                           |

**What the two new engine cases prove.** `research-note.test.ts` and `research-judge.test.ts` seed the run's guard with
`spend.begin` and a recorded `costKind: "codium"` step (and, in the judge case, a priced one) before `send`; they run
no step that the engine classifies as Codium. So they prove that each V1 writer reads the guard's real snapshot. That a
V1 Codium turn reaches that snapshot as a Codium step is pinned by `processor-effect.test.ts -t Codium` (3 pass above),
and a V2 Codium turn end to end by the core `research-v2.test.ts` case. The research test harness answers through a
fake LLM server, which cannot serve Codium's fixed destination (label plan C5), so no engine case stamps a Codium
provider through it.

**Against the previous source** (the new tests with the A23 source, before the repair): `spend-guard.test.ts` 56 pass, 2
fail (`SpendGuard.reportSpend is not a function`); `research-v2.test.ts -t "Vector Codium saves a report"` 1 fail, the
saved Method holding `- Spend: Codium`; `research-note.test.ts -t "spent no dollars beside"` 1 fail, `- Spend: Codium`;
`research-judge.test.ts -t "keeps a mixed run"` 1 fail, `- Spend: $0.12 at list prices` without `+ Codium`. So each of
the three call sites is caught by a test of its own, not only by the helper's cases.

**Mutation checks** (the helper body changed in place, the tests run, the file then copied back and compared byte for
byte with `cmp`): (1) the A23 wording (`spentUsd > 0 || codiumSteps > 0`, else `"Codium"`) fails the first `reportSpend`
case, the core V2 case and the engine tool case; (2) dropping ` + Codium` (`return "$X at list prices"`) fails the
second `reportSpend` case and the engine judge case.

Typecheck: `bun typecheck` in `packages/core`, `packages/engine`, `packages/desktop` and `packages/app`, exit 0. The
full `TURBO_CACHE_DIR=/home/user/.cache/vector-typecheck bun turbo typecheck --concurrency=1` from the worktree root: 25
of 25 tasks successful (23 from cache). `prettier --check` on the eight changed source and test files: clean. No public
schema or HttpApi changed, so no generator ran.

**Re-checked on 8 Nov 2026** by the agent that took P4b over, on the same uncommitted tree at `3082bb2c` (`origin/codium`
fetched again, unmoved; its latest Vector Codium run is still 42444316138, completed, success), with fresh roots under
`/tmp/vector-codium/p4b-verify/`: core `test/spend-guard.test.ts` 58 pass, `test/session/research-v2.test.ts` 21 pass,
`test/research/report.test.ts` 14 pass; engine `test/tool/research-note.test.ts` 2 pass,
`test/session/research-judge.test.ts` 8 pass, `test/tool/research-scripted-run.test.ts` 1 pass; 0 fail in each.
`bun typecheck` in core, engine, desktop and app exit 0; the full turbo typecheck 25 of 25 successful (21 from cache).
`prettier --check` on the eight source and test files and on `codium-p4-repairs.md` and
`codium-a23-guard-usage-notes.md`: clean. `codium-deviations.md` reports differences at lines 1040 to 1593 only, which
it already had at `3082bb2c`; none is in P4b's lines, and they are left as they are.

**After the review of this record (8 Nov 2026).** Source changed only in a comment (`reportSpend` in
`packages/core/src/spend-guard.ts` now says a saved report never names Codium without own dollars beside it); the rest
were wording fixes in this record and in `codium-deviations.md` (F18's deferral basis, F28's receiving package and
test, the engine cases' limit, the CI hand-off to P4c). Rerun with roots under `/tmp/vector-codium/p4b-fix/`: core
`test/spend-guard.test.ts` 58 pass, 0 fail; core `bun typecheck` exit 0; `prettier --check` on `spend-guard.ts`, this
record and `codium-a23-guard-usage-notes.md` clean, and on `codium-deviations.md` the same lines 1040 to 1593 only.

**CI only:** the browser specs `codium-usage-labels.spec.ts` and `account-settings.spec.ts`; `bun run test:httpapi` (the
`experimental.session.usage.codium`, `v2.session.get.codium` and `v2.session.spend.codium` scenarios);
`bun run check:generated`; the Valkey and Postgres cases; and the other 26 cases of `processor-effect.test.ts`. P4b's own
commit was not pushed when this record was written: P4c records its Vector Codium run id and conclusion, as a dated
Lane status line in `codium-deviations.md`, once that run has completed.

Files touched by P4b's repair: `packages/core/src/spend-guard.ts`, `packages/core/src/tool/research-report.ts`,
`packages/engine/src/tool/research-report.ts`, `packages/engine/src/session/prompt.ts`; tests
`packages/core/test/spend-guard.test.ts`, `packages/core/test/session/research-v2.test.ts`,
`packages/engine/test/tool/research-note.test.ts`, `packages/engine/test/session/research-judge.test.ts`.
`packages/app/src/context/settings.tsx` and `packages/engine/src/tool/task.ts`: not touched.

Edits to `api/_lib/model-plan-*.ts`: none.

Shared label files touched: none.

## A25 output boundaries

P4c reviews A25, the range `b4c05481..295ab95e` (112 files, `git diff --stat b4c05481 295ab95e`): `d505d566` (usage
refresh clock), `4bc40a87` (benchmark docs), `fa16befa` (desktop and command usage boundaries), `ced763c3` (trusted
token accounting provenance) and `295ab95e` (task completion usage output). `git log --oneline b4c05481..295ab95e`
holds seven commits: the test-only `44c35f1c` and `9c5bc861` lie in the range too, and P4b reviewed them with
`d505d566` and `4bc40a87` as the A24 follow-ups (its commit message, F27, F30 and F31); P4c reads those four only for
the A25 notes' claims (F54, F55). It reads spec §5 A25, label plan §2, §3.6, §3.7, §3.9 and C8 to C10,
`codium-a25-output-notes.md`, the "A25: output boundaries and historical aggregate provenance" section of
`codium-deviations.md` and `evidence/codium-a25-after-ced763c3.json`. Each finding was checked against the code at
`c7b6376a` (`origin/codium` on 8 Nov 2026, P4b's commit, fetched again before these records were written). Findings
continue from F35. Line numbers are at `c7b6376a` unless a finding says otherwise. No service, account, deployment or
provider was called (the GitHub reads were read-only commit, branch, run and job queries), no Codex-owned file (spec
§0.5) was touched, and `api/_lib/model-plan-*.ts` was not edited.

**F35. A22's obligation to A25 (C9, the other half of P4a's F15): `vector stats` filters Codium.** Met.
`aggregateSessionStats` (`packages/engine/src/cli/cmd/stats.ts:176-289`) reads V1 assistant messages and, for a
session with no V1 messages, its V2 assistant and compaction rows, routes each step by `Billing.of`, and sums own
figures only from steps with `Billing.hasOwnIdentity`. The all-time path keeps the session's dollar total less observed
flagless Codium dollars, floored at the identified own subtotal, and uses the session's token totals only with
`tokensOwnOnly === true` and no more observed Codium steps than `codiumSteps`; the `--days` path sums identified own
steps only; per-model rows carry `billing` and no Codium figure. Tests: `test/cli/stats.test.ts:144` (both paths) and
`:174` (V2 stored billing and Codium compaction).

**F36. `run --format json` step_finish.** Not confirmed. `stepForOutput` (`cli/cmd/run/usage-output.ts:5-14`) returns
a part unchanged only when it has no Codium flag and `billingByMessage` says `"own"`; that map is filled from each
assistant `message.updated` with `Billing.of`, else `Billing.hasOwnIdentity` (`cli/cmd/run.ts:1054-1058`). Codium and
unidentified steps lose `tokens`, and Codium ones read `billing: "codium"`, `cost: 0`, `unpriced: true`. Root
(`run.ts:1198`) and subagent (`:1148`) steps both go through it. Test: `test/cli/run/usage-output.test.ts:5`.

**F37. `run --format json` tool_use.** Not confirmed. `toolForOutput` (`usage-output.ts:17-20`) passes the metadata
of completed and errored `task` parts through `taskMetadata` (`:22-42`), which drops `usage.tokens`, `usage.total` and
`usage.tokensOwnOnly` in single records, batch arrays, batch objects and nested `subagent` records, and keeps dollars
and counts. No other tool's metadata carries usage tokens: the token counts in `tool/memory.ts` are the size of memory
text (label plan D-8). Test: `usage-output.test.ts:28`.

**F38. The task completion note.** Not confirmed. `renderNote` (`packages/engine/src/tool/task.ts:304-351`) prints
`tokens="…"` only when `usage.tokensOwnOnly === true` and the child is not Codium-only (`:322`). That usage comes from
`SubagentLifecycle.observe`, which reads the session row through `sessions.get` and sets
`tokensOwnOnly: info.tokensOwnOnly === true` (`tool/subagent-lifecycle.ts:167`), never from metadata. `renderOutput`
(`task.ts:285-299`) prints no usage. At `origin/self-evolving` `a03b9718`, WP31's `TaskNotify.render` carries the same
guard (`packages/engine/src/task/notify.ts:180` there), so the note half of the A25 notes' WP31 obligation is met on
that branch. Tests: `test/tool/task.test.ts`, the `295ab95e` cases among them.

**F39. `vector tasks`.** Not confirmed. The task manager builds `Task.Info.usage` from the session row, with
`tokensOwnOnly: session.tokensOwnOnly === true` (`packages/engine/src/task/manager.ts:179-188`). `taskForOutput`
(`cli/cmd/tasks.ts:145-151`) drops `tokens` and `total` from JSON without that proof, and `CodiumUsage.taskText`
(`packages/core/src/codium-usage.ts:18-53`) prints no aggregate token figure without it. Test:
`test/cli/tasks.test.ts:65`.

**F40. `vector stats` Total Cost beside Codium.** Not confirmed as a defect; one reading. `displayStats`
(`stats.ts:432-438`) prints `CodiumUsage.withCodium("$X.XX", codiumResponses)`, so own work at $0 beside Codium reads
`$0.00 + Codium`, where label plan §2's table reads `Cost unknown + Codium` (own unpriced only), `free + Codium` or
`ChatGPT plan + Codium`. Stats could tell the unknown case apart (V1 step-finish parts and V2 rows carry `unpriced`, the
session row `unpricedSteps` and `codiumSteps`, and `CodiumUsage.ownUnpricedSteps` exists) but never counts it. Only an
unpriced step carries a flag, so a free step and a plan step look alike in stored data. The reading, in "P4 review
decisions", keeps stats' own-text formatter: it is A25's (C9) surface, not label copy for P4d.

**F41. ACP.** Not confirmed. `buildUsage` (`packages/engine/src/acp/usage.ts:90-106`) returns nothing for a Codium
message; `turnUsage` (`:122-151`) sums only messages with `Billing.hasOwnIdentity`; `promptResponse` falls back to
`buildUsage` only with own identity (`acp/service.ts:851-853`); `usage_update` is skipped when the latest assistant
message or the context sample is not own (`service.ts:639-644`, `usage.ts:256-258`); `totalSessionCost` (`:153-171`)
answers nothing when any step is unpriced or Codium. Tests: `test/acp/usage.test.ts`,
`test/acp/service-session.test.ts`.

**F42. `export --sanitize`: messages, parts and totals.** Not confirmed. `sanitizeLegacy`
(`cli/cmd/export.ts:168-246`) drops `info.tokens` and `info.subagentTokens` without their proof (`:179-180`), drops the
tokens of Codium and unidentified assistant messages and step-finish parts and marks Codium ones `billing: "codium"`
(`withoutTokens`, `:248-256`), and replaces non-empty text, reasoning and tool metadata with a redaction marker
(`data()`, `:17-20`). It returns only `info` and `messages`, so on codium the archive's `ancillaryUsage` (title and
memory model calls, with their `billing` and `tokens`) stays out. Native sessions go through `sanitizePublic`, the
public preview. Tests: the seven earlier cases of `test/cli/export-sanitize.test.ts`. The self-evolving side of
`ancillaryUsage` is a hand-off under "P4 review decisions".

**F43. A sanitized export kept a lifecycle record's aggregate tokens and their proof.** Confirmed, repaired.

- `const info = { ...data.info }` (`export.ts:178`) kept `info.metadata` as it was. On a child session,
  `metadata.subagent` is the lifecycle record, and `SubagentLifecycle.settle` (`subagent-lifecycle.ts:209-215`,
  through `outcome` and `observe`) writes its `usage` with the session's `tokens`, `total` and `tokensOwnOnly` copied
  at completion. So a sanitized export whose `info.tokens` were dropped for missing proof printed the same aggregate in
  `metadata.subagent.usage`, with the serialized proof bit. A child holding flagless Codium tokens from before A22 (its
  record says `tokensOwnOnly: false`, or has no proof field when written before A25) printed them, and so did a record
  whose proof bit a client set through session metadata (`PATCH /session/:id` passes metadata through,
  `httpapi/handlers/session.ts:271`).
- Contract: label plan C10 ("the legacy `--sanitize` path drops Codium tokens"), the A25 decision "editable lifecycle
  metadata never authorizes printed aggregate tokens", and run JSON's handling of the same record (F37).
- Shown against the previous source (table below): the four new lifecycle cases fail with `tokens.input` 987654 and
  `total` 987686 in `metadata.subagent.usage`, and `tokensOwnOnly` beside them where the record had one.
- **Repair:** `sanitizeLegacy` replaces `metadata.subagent`, when present, with `taskMetadata(metadata.subagent)`
  (`export.ts:185-188` after the repair), the walker run JSON already uses, now exported from
  `cli/cmd/run/usage-output.ts` under its own name. The record keeps its dollars, counts and other fields and loses
  `tokens`, `total` and `tokensOwnOnly` wherever nested. Other metadata keys are left as they are, and a session
  without `metadata.subagent` gains no `metadata` key. The stripping is unconditional, as in run JSON: a proven
  `info.tokens` stays beside it, so no proven figure is lost. The raw export (a backup under D-2) and stored rows are
  unchanged, and the walker copies, so the source archive is not mutated.
- **Regression tests** in `packages/engine/test/cli/export-sanitize.test.ts`: "a lifecycle record's aggregate tokens
  never reach a sanitized export: %s" (four cases: a forged true proof on a proven and on an unproven session, an
  unproven record holding flagless Codium tokens, and a record written before the proof existed; each expects the
  record reduced to `{cost, toolUses, steps, codiumSteps}`, the root `usage` and `unrelated` keys kept as they were, no
  `987654` or `987686` in the output, no `tokensOwnOnly` in the metadata, the source unchanged, and `info.tokens` kept
  only with session proof); "a session without metadata gains no metadata key"; and "ancillary usage stays out, so
  Codium title and memory tokens never reach a sanitized export", which passes on codium before and after the repair
  and guards the self-evolving merge (see "P4 review decisions").

**F44. A sanitized export keeps the lifecycle record's text.** Not repaired; handed to the lead. `--sanitize` is
described as "redact sensitive transcript and file data" (`export.ts:272`), yet after the repair the record keeps its
text fields: `title` (the task description), `resultSummary`, `reason`, `error`, `successCriteria[]`, `ownedPaths[]`,
`dependsOn[]`, `resultRef`, `batchID`, `notification.text` and `mailbox[].text` (`SubagentRecord`,
`packages/engine/src/agent/subagent-kind.ts:50-82`), and any other metadata key a client set. This predates Codium
(`sanitize()` already spread `data.info` at `b4c05481`), and C10 covers only Codium figures, so it is outside P4. The
separate task: in `sanitizeLegacy`, after `taskMetadata`, redact the string fields of `metadata.subagent` (with
`notification.text` and every `mailbox[].text`) using the existing `redact()`, or pass non-lifecycle metadata through
`data("session-metadata", ...)`, with an `export-sanitize.test.ts` case asserting a steer prompt's text is absent.
P4c's attempt to queue it as a task suggestion timed out without returning a task id, so the hand-off stays open with
the lead.

**F45. Token provenance is trusted only from the engine.** Not confirmed.

- No serialized flag promotes a row: `sessionRow` writes both flags false whatever the event says
  (`packages/core/src/session/projector.ts:126-128`); the Updated projector strips both from its update (`:416-417`);
  a Created event with any nonzero accounting calls `contribute(false)` (`:376-393`).
- Only `SessionAccounting.initializeEmpty` (`packages/core/src/session/accounting.ts:12-37`) sets them true, for
  sequence 0 with no accounting, messages, parts, inputs, children, events or sequence rows, from the non-replayed
  commit callbacks at `packages/core/src/session.ts:308` and `packages/engine/src/session/session.ts:703`.
- Replay, import and fork invalidate: `projector.ts:169, 247, 351, 439, 469, 478, 545`; archive import writes
  `tokensOwnOnly: false` (`share/archive.ts:360`). The session PATCH payload has no accounting field
  (`httpapi/groups/session.ts:59-68`).
- Outputs: Created and Updated snapshots take the flags and figures from the committed row
  (`session/accounting-output.ts:11-51`, used at `packages/server/src/handlers/event.ts:52`, the engine's
  `httpapi/handlers/event.ts:103` and `event-v2-bridge.ts:40`); forwarded remote snapshots lose them
  (`control-plane/workspace.ts:431`); the app reads tokens from loaded accounting facts, not lifecycle metadata
  (`features/background-tasks/subagent-model.ts:666-668`).
- Tests: core `test/session-token-provenance.test.ts`, engine `test/event-v2-accounting.test.ts` and
  `test/server/httpapi-event.test.ts`. The billing flag on a part edited through the HttpApi is a separate path, F46.

**F46. A client edit through `PATCH` part.update could relabel step usage.** Confirmed, repaired.

- `part.update` (`httpapi/groups/session.ts:488-499`, handler `handlers/session.ts:526-540`) took a whole
  `SessionV1.Part` and checked only that its ids equal the path's. The `PartUpdated` projector (`projector.ts:540-566`)
  reads the stored part by id and upserts it setting `data` only, so the row keeps its `message_id` and `session_id`;
  it routes `previous` by the stored row's message and `next` by the payload's `messageID`, and `applyUsage`
  (`:160-170`) keeps the proof only when both are own-only (`knownOwnOnly`, `:77-79`, reads a Codium flag and an own
  provider identity both as known).
- So an authorized client could (a) add `billing: "codium"` to an own step, which moved its cost and tokens out of the
  own totals and raised `codium_steps`; (b) drop `billing` from a Codium step on its Codium message, which added its
  figures to the own totals and dropped the proof; (c) send the same Codium part under an own message's id without
  `billing`, where both sides read as own-only, so the proof survived and the figures counted as proven own tokens.
  The raw message API returns each Codium step's tokens (`GET /session/:id/message`, `handlers/session.ts:151-190`;
  label plan D-2), so the figures in (c) can be engine-recorded Codium tokens, which then printed as proven own tokens
  in `export --sanitize`, `vector stats` and `vector tasks`. The same route also created step-finish parts and moved a
  part's figures to another session.
- Contract: the brief's check that token provenance is trusted only from the engine and "a client-supplied provenance
  flag cannot relabel own-key usage as Codium or the reverse".
- Shown against the previous source (the handler as at `c7b6376a`, the new test in place, the status assertion
  replaced by a print of the response and the session's totals in a throwaway copy of the test, deleted after the run;
  a session with an own step of 200 input tokens at $0.12 and a Codium step of 987654): every edit was accepted with
  status 200. (a) left `cost` 0, input tokens 0, `codiumSteps` 2, proof true; (b) input tokens 987854, `cost` 0.12, no
  Codium step, proof false; (c) input tokens 987854, no Codium step, proof **true**; a new step-finish part added a
  second own step (400 tokens, $0.24); turning the Codium step into a text part took its Codium step back.
- **Repair:** the HttpApi handler `updatePart` (`handlers/session.ts:530-560` after the repair, `stepUsage` at
  `:597`; the engine's processor writes through `Session.updatePart` and is unaffected) reads the stored part by id
  and returns `BadRequest` when the stored row is in another session or under another message than the payload names,
  or when the stored part or the payload is a step-finish and their usage differs (`stepUsage`: `type`, `billing`,
  `cost`, `unpriced` read as `=== true`, and `tokens`, compared with `isDeepStrictEqual`). So a step-finish part can
  no longer be created, relabelled, re-priced, moved or turned into another part type through the route, while an
  edit to a step's `reason` or `snapshot` and every other part edit pass as before. `BadRequest` is already among the
  endpoint's declared errors (`groups/session.ts:493`), so no HttpApi shape changed and neither the client nor the SDK
  needs regenerating; P4c's first draft said otherwise and read the path as "accepted for now", and a review of that
  uncommitted draft withdrew both.
- **Regression tests** in the new `packages/engine/test/server/httpapi-part-usage.test.ts`: five "refuses … leaving the
  session's totals and parts as stored" cases ((a), (b), (c), a step-finish part the engine never recorded, and a
  stored step turned into a text part), each expecting 400, the session's `cost`, `tokens`, `codiumSteps`,
  `unpricedSteps` and `tokensOwnOnly` unchanged and both stored parts as written; "refuses a step sent under another
  session's message" (400, both sessions' totals unchanged); and "accepts an edit that leaves a step's usage as
  stored" (200 for a `reason` edit on the own and the Codium step, totals unchanged). Against the previous source the
  six refusal cases fail (status 200) and the accepting case passes.
- Unchanged by the repair: desktop admission reads the session model (`desktop/src/main/scheduled-agents.ts:577`,
  `parallel-workspaces.ts:2231`), so no relabel ever opened a dollar window; `measuredCost`
  (`desktop/src/main/run-usage.ts:89-101`) keeps the guard's own spend as a floor whenever the guard reports any.

**F47. The provenance migration is additive.** Not confirmed.
`packages/core/src/database/migration/20261101020803_session_token_provenance.ts:8-9` adds `tokens_own_only` and
`subagent_tokens_own_only` as `integer DEFAULT false NOT NULL` with no backfill, matching `session/sql.ts:60-61` and
`database/schema.gen.ts:232-233`, registered at `migration.gen.ts:51`; `20260611035744_credential.ts:15` uses the same
`DEFAULT false` form. `origin/self-evolving` carries the same file (blob `f4e31afc`). Checks here:
`bun script/migration.ts --check` (exit 0, "No schema changes, nothing to migrate", tree unchanged) and
`test/database-migration.test.ts -t "token provenance starts unknown"`.

**F48. Desktop Codium-only runs append no dollar-ledger event.** Not confirmed; one reading. `recordRunCost`
returns without appending when cost and tokens are both at most 0 (`packages/desktop/src/main/spend-limits.ts:265-269`);
`measuredRun` (`run-usage.ts:103-148`) gives a Codium-only run own cost 0 and no tokens; the card's `actualCost` stays
unset for Codium at $0 (`parallel-workspaces.ts:2633-2634`). Tests: `spend-limits.test.ts:783` and `:813`,
`run-usage.test.ts`, `parallel-workspaces.spend.test.ts`, `scheduled-agents.test.ts`, `agent-task-model.test.ts`. The
reading (a run with no readings) is in "P4 review decisions".

**F49. The `vector run` footer and `--max-cost`.** Not confirmed. `formatSpend` and `formatContext`
(`cli/cmd/run/session-data.ts:143-169`) wrap own spend with `withCodium` and show a Codium context as its percentage
only; the context reading at `:863-867` passes tokens only for Codium or own identity, so an unidentified step shows
no token figure. Test: `test/cli/run/session-data.test.ts`. The `--max-cost` help snapshot from `295ab95e` is
checked in test.yml only.

**F50. `vector models --verbose` and `vector memory doc`.** Not confirmed. `modelForOutput`
(`cli/cmd/models.ts:154-160`) prints `billing: "codium"` in place of Codium's zero rates; `memory-doc.ts:388-418`
prints `Runs on <model> (Codium).`, `Spent: Codium` and `{ billing: "codium" }` JSON with no tokens or cost;
`session/distill.ts:190,259` leaves Codium estimates and results without figures. Tests:
`test/cli/models-codium.test.ts`, `test/session/distill.test.ts`, core `test/brain/distill.test.ts`.

**F51. Review JSON.** Not confirmed for JSON. `reviewForOutput` (`cli/cmd/review-output.ts:13-56`) treats a review as
Codium by its model prefix even when the outcome's kind reads `"unknown"` (P4b's F18). Test: `test/cli/review.test.ts`.
The human review footer is P4d's (A26).

**F52. TUI.** Not confirmed. `util/locale.ts:87-162` (`spend` and its siblings take `codiumSteps` and
`ownUnpricedSteps`), `util/session.ts:59-130`, `feature-plugins/sidebar/context.tsx:18-100` and
`routes/session/task-presentation.ts`. Tests: `test/task-presentation.test.ts`, `test/util/locale-spend.test.ts`,
`test/util/session.test.ts`, `test/feature-plugins/sidebar-context.test.tsx`.

**F53. App files changed in `ced763c3`.** Not confirmed. `utils/session-cost.ts`,
`features/background-tasks/subagent-model.ts:521-555` (loaded own facts, Codium steps counted apart) and
`task-board-model.ts:134-139` (task tokens only with row proof). Tests: `src/utils/session-cost.test.ts`,
`src/features/background-tasks/subagent-model.test.ts`, `task-board-model.test.ts`.

**F54. The A25 notes' line 3: "the complete 10-job run at `975b523b` passed before A25 publication".** Unverifiable.

- `975b523b` is on no branch: `list_branches` shows no `codium-fixtures` (the branch run 41261226062 names) and no
  branch at that commit, and the lane clone has no such object (`git cat-file -t 975b523b` fails).
- GitHub's commit API still serves the object: subject "test(codium): freeze the usage refresh clock boundary", author
  and committer date 2026-11-01T01:26:17Z, and a 2-line change to
  `packages/app/e2e/regression/account-settings.spec.ts`. `d505d566` has the same subject, author, author date and
  patch, with committer date 01:33:36Z and parent `4bc40a87`, so it was committed again after run 41261226062 (Vector
  Codium, workflow_dispatch, head `975b523b`) was created at 01:28:22Z.
- The commit API answer carries no parent field, so the tree outside that change cannot be compared with codium's
  A24 source through the lane's tools. The notes' sentence is therefore unverifiable; the run's own result does not
  confirm it, and it is not repeated here.

**F55. The A25 notes' "A25 remains open until …" (in the `fa16befa` paragraph).** Superseded by later paragraphs of
the same notes, which the runs confirm by id:

| Run         | Workflow      | Head       | Result                                                                                                                                     |
| ----------- | ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 41263609099 | Vector Codium | `fa16befa` | success                                                                                                                                    |
| 41266218814 | Vector Codium | `ced763c3` | failure: of 10 jobs only Codium tests 124729456887 failed, at "Run the Codium test files"; its exerciser and generated-client steps passed |
| 41266232332 | test.yml      | `ced763c3` | failure; the benchmark job 124729499411 succeeded                                                                                          |
| 41267412463 | Vector Codium | `295ab95e` | success, 10 of 10; Codium tests 124733000253 passed every step                                                                             |
| 41268039624 | test.yml      | `295ab95e` | success                                                                                                                                    |

The evidence file matches the notes: `workflowRun` 41266232332, `job` 124729499411, `artifact` 13067119453 and the
`archiveSha256`; medians recomputed here are 114.9/135.3, 113.7/201.3 and 80.9/136.9 ms (first/stable) for the
unvisited task, the new session page and the child session, with 9 of 9 passed, retry 0, blank 0 and unknown 0. The
notes link the runs under the repository name GitHub's run records give; the lane reads them as
`scr1pter/vectordev.ai` (P4b's F31).

**F56. The brief's file list.** It names `packages/server/src/handlers/session.ts`; A25 changed
`packages/server/src/handlers/event.ts` (4 lines: the row projection of F45). Both were read: `session.ts:345` maps
`codiumSteps` (P4b's F21), and the V2 get answers through `SessionInfo.fromRow`
(`packages/core/src/session/info.ts:33-34`), which takes the proof from the row.

## CI before P4c

- **Run 42450985342** (Vector Codium, push, head `c7b6376a`, P4b's commit): queued when P4c began, completed with
  success at 05:58:34Z, 14 of 14 jobs. Codium tests 128639976336; Codium browser specs 128639976225; typecheck jobs
  desktop 128639976324, app 128639976353, engine 128639976396, ops-worker 128639976448, web 128639976492, api
  128639976501, relay 128639976504, cloud 128639976545, core 128639976552, schema 128639976558; Ops Worker dry run and
  miniflare smoke 128639976342; Remote relay dry run and local smoke 128639976350. The Codium tests job passed every
  step, a new "Build the phone app" step among them. Its log has 9,281 lines; P4c read the last 260, which show the
  last HttpApi exerciser gate at `pass=309 fail=0 skip=0 missing=0 extra=0` and then `bun run check:generated`. The
  picker's file count and the first two exerciser gates are earlier in the log and were not read; their steps report
  success.
- **A25's own runs**, checked by id, are in F55's table.

## Tests run here (P4c)

Every run went through `/home/user/.tools/vector-serial` from the package directory with `--timeout 30000`, one file at
a time, with XDG, `VECTOR_TEST_HOME` and `TMPDIR` roots under `/tmp/vector-codium/p4c/`. Desktop runs use
`bun --no-env-file test`, app runs add `--isolate`. All exited 0 after the repair.

| Package | File                                                                      | Result                  |
| ------- | ------------------------------------------------------------------------- | ----------------------- |
| engine  | `test/cli/export-sanitize.test.ts`                                        | 13 pass (6 new)         |
| engine  | `test/cli/run/usage-output.test.ts`                                       | 2 pass                  |
| engine  | `test/cli/run/session-data.test.ts`                                       | 18 pass                 |
| engine  | `test/cli/stats.test.ts`                                                  | 7 pass                  |
| engine  | `test/cli/tasks.test.ts`                                                  | 3 pass                  |
| engine  | `test/cli/models-codium.test.ts`                                          | 2 pass                  |
| engine  | `test/cli/review.test.ts`                                                 | 25 pass                 |
| engine  | `test/acp/usage.test.ts`                                                  | 17 pass                 |
| engine  | `test/acp/service-session.test.ts`                                        | 40 pass                 |
| engine  | `test/session/usage.test.ts`                                              | 16 pass                 |
| engine  | `test/session/distill.test.ts`                                            | 4 pass                  |
| engine  | `test/tool/task.test.ts`                                                  | 116 pass                |
| engine  | `test/event-v2-accounting.test.ts`                                        | 2 pass                  |
| engine  | `test/server/httpapi-event.test.ts`                                       | 3 pass                  |
| engine  | `test/server/httpapi-part-usage.test.ts` (new)                            | 7 pass                  |
| engine  | `test/server/httpapi-session.test.ts`                                     | 26 pass                 |
| engine  | `test/server/httpapi-sdk.test.ts`                                         | 19 pass                 |
| core    | `test/session-token-provenance.test.ts`                                   | 19 pass                 |
| core    | `test/event.test.ts`                                                      | 46 pass                 |
| core    | `test/codium-usage.test.ts`                                               | 1 pass                  |
| core    | `test/brain/distill.test.ts`                                              | 17 pass                 |
| core    | `test/database-migration.test.ts`, `-t "token provenance starts unknown"` | 1 pass, 19 filtered out |
| desktop | `src/main/run-usage.test.ts`                                              | 24 pass                 |
| desktop | `src/main/spend-limits.test.ts`                                           | 38 pass                 |
| desktop | `src/main/agent-task-model.test.ts`                                       | 8 pass                  |
| desktop | `src/main/parallel-workspaces.spend.test.ts`                              | 10 pass                 |
| desktop | `src/main/scheduled-agents.test.ts`                                       | 67 pass                 |
| tui     | `test/task-presentation.test.ts`                                          | 6 pass                  |
| tui     | `test/util/locale-spend.test.ts`                                          | 8 pass                  |
| tui     | `test/util/session.test.ts`                                               | 10 pass                 |
| tui     | `test/feature-plugins/sidebar-context.test.tsx`                           | 2 pass                  |
| app     | `src/utils/session-cost.test.ts`                                          | 14 pass                 |
| app     | `src/features/background-tasks/subagent-model.test.ts`                    | 69 pass                 |
| app     | `src/features/background-tasks/task-board-model.test.ts`                  | 13 pass                 |

`bun script/migration.ts --check` from `packages/core`: exit 0, and `git status` showed only P4c's three files.

**Against the previous source** (`export.ts` as at `c7b6376a`, the new test file in place): 9 pass, 4 fail; the four
lifecycle cases fail, the no-metadata and ancillary cases pass. For F46 (`handlers/session.ts` as at `c7b6376a`,
restored afterwards and compared with `cmp`): `httpapi-part-usage.test.ts` 1 pass, 6 fail, the six refusal cases
failing on status 200 and the accepting case passing; the throwaway probe's totals are in F46. **Mutation checks**
(the source changed in place, the test run, the file then copied back and compared with `cmp`): (1) without the
`metadata.subagent` line in `export.ts`, the four lifecycle cases fail; (2) without `delete usage.total` in
`taskMetadata`, the four lifecycle cases and `usage-output.test.ts`'s task JSON case fail; (3) with the walker over
the whole metadata object (`metadata: taskMetadata(data.info.metadata)`), the four lifecycle cases fail on the root
`usage` key and the no-metadata case fails on the `undefined` key; for F46, (4) with the stored-row session and message check disabled,
"refuses a step sent under another session's message" fails (the Codium-under-own-message case is still refused,
because removing its flag also changes its usage); (5) with the usage comparison disabled, the own-relabel, flag
removal, never-recorded step-finish and step-to-text cases fail.

Typecheck: `bun typecheck` in `packages/engine`, `packages/core`, `packages/desktop` and `packages/server`, exit 0. The
full `TURBO_CACHE_DIR=/home/user/.cache/vector-typecheck bun turbo typecheck --concurrency=1` from the worktree root:
25 of 25 tasks successful (22 from cache), and again after a comment-only edit to `taskMetadata`'s doc line, 25 of
25 (24 from cache; the two engine files above were rerun, 13 and 2 pass, and engine `bun typecheck` exit 0).
`prettier --check` (through the lock) on the three source and test files and on this record: clean. No public schema
or HttpApi changed, so no generator ran.

After the F46 repair and the review round (the `export-sanitize.test.ts` table rows now carry their expected
`info.tokens` in place of an `if`/`else`): `export-sanitize.test.ts` 13 pass, `httpapi-part-usage.test.ts` 7 pass,
`httpapi-session.test.ts` 26 pass, `httpapi-sdk.test.ts` 19 pass; engine `bun typecheck` exit 0, and the full
`bun turbo typecheck --concurrency=1` from the worktree root 25 of 25 tasks successful (24 from cache);
`prettier --check` on the changed source and test files clean, and the three records add no formatting issue to those
already at `c7b6376a`. F46's repair changes behaviour only: `BadRequest` was already declared for `part.update`, so no generator
ran; the HttpApi exerciser (its `part.update` case edits a text part) and `check:generated` run in CI.

**Merge prediction.** A read-only `git merge-tree --write-tree --name-only` of `origin/self-evolving` `a03b9718` with
`c7b6376a`, and with a probe commit of P4c's tree (both with a throwaway object directory, so no ref moved and no
object entered the shared store), reports the same 7 content conflicts as D1's list. `export.ts` and
`usage-output.ts`, which self-evolving also edits, merge cleanly, and the merged `sanitizeLegacy` holds both
self-evolving's `...data,` and P4c's `metadata.subagent` line. The same probe repeated with the F46 repair (a temporary
index and object directory, so neither the worktree index nor the shared store changed) reports the same 7 conflicts;
`handlers/session.ts`, which self-evolving edits elsewhere (its audience checks and imports), merges cleanly and the
merged file holds both its `SessionAudienceHttp` checks and P4c's `stepUsage` guard.

**CI only:** the Valkey and Postgres cases, `bun run test:httpapi`, `bun run check:generated`, the browser specs, the
help snapshots (test.yml, not dispatched) and the full picker run. P4c's changes were left uncommitted for the lane
lead; the commit, its push and its Vector Codium run are recorded by the package that pushes it.

Files touched by P4c's repairs: `packages/engine/src/cli/cmd/export.ts` and
`packages/engine/src/cli/cmd/run/usage-output.ts` (F43; both also edited on self-evolving) and
`packages/engine/src/server/routes/instance/httpapi/handlers/session.ts` (F46; also edited on self-evolving, in other
functions); tests `packages/engine/test/cli/export-sanitize.test.ts` and the new
`packages/engine/test/server/httpapi-part-usage.test.ts`. `packages/engine/src/tool/task.ts`: not touched. No schema,
HttpApi shape or generated file changed, and no configuration was added, so `MODEL-PLANS.md` and `.env.example` are
unchanged.

Edits to `api/_lib/model-plan-*.ts`: none.

Shared label files touched: none.
