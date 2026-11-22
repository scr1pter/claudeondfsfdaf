# codium-run-headroom: A23-model-edit-race (parallel half)

## Current integration, 22 Nov 2026

PR #78 is merged in main and supplies the owner's `tightenBudget` prompt field. This branch now uses that field for
Codium parallel fences too. The active run captures whether it was admitted as Codium; both ordinary run prompts
and live messages send `tightenBudget: true` with a finite headroom budget. The engine therefore keeps stricter
configured and research limits. Own-key prompts retain their existing arming behavior, and an unlimited Codium run
sends neither a budget nor a tightening instruction. The older consequence below about replacing fallback caps is
historical and superseded by this integration. The ledger's limits, reservations, one-cent floor and billing rules
are unchanged; no engine, protocol, generated, budget-data or flag file changes are needed.

Merged main `c515de62465db817ff309f4237023f9704fe7983` cleanly into this branch with merge commit
`1ea0d41373dc67d20585df216d3bb5a1f46bc01c`. The existing parallel spend file passed 11 tests before adding the
integration regressions. With production source unchanged, the expanded file then gave **10 pass / 4 fail**, all
on missing `tightenBudget`: Codium-only and mixed admissions, the one-cent-floor admission, and a live Codium
message. After the fix it gave **14 pass / 0 fail** (80 assertions). Own-key prompt/message and unlimited-Codium
controls remain green. The live-message fixtures wait inside the unchanged 30-second test deadline and always let
the controlled local engine settle.

Other checks ran individually through `/workspace/.tools/vector-serial`, with `--timeout 30000` and fake services:
`codium-run-headroom.test.ts` 6/6, `spend-limits.test.ts` 38/38, `scheduled-agents.test.ts` 71/71, and
`parallel-workspaces.follow-up.test.ts` 45/45. Desktop `bun typecheck` passed. No real Codium, payment, model-vendor
or customer GitHub API was called.

Branch `codium-run-headroom`, cut from origin/main `609763f72` and merged up to `edbc4a8c3`. It covers the parallel
half of one Vector v2 leftover P0 item, A23-model-edit-race, under lead ruling R2 option 1 (rulings file, 21 Nov 2026).
The scheduled half of the same ruling is open PR #78 (`spend-cap-follow`), which owns `scheduled-agents.ts` and its
test; this branch leaves both files as main has them. Desktop only: no engine, protocol, generated client or budget
file changes, and every flag stays off.

Files: the new `packages/desktop/src/main/codium-run-headroom.ts` and `codium-run-headroom.test.ts`,
`parallel-workspaces.ts`, `parallel-workspaces.spend.test.ts`, and these docs. Short dated pointers are in
`codium-deviations.md`, `codium-p4-repairs.md` (under F19) and `codium-a23-guard-usage-notes.md`, which no open PR
touches. `spend-limits.ts`, `run-budget.ts` and `spend-guard.ts` are read, not changed: the helper is named
`codium-run-headroom.ts`, as the plan asks, to stay apart from them.

## 2026-11-21, A23 model edit race: a parallel run admitted as Codium carries the own-key headroom

**The gap.** A desktop run admitted as Codium (`checkAllowance({ billing: "codium" })`) skipped the local dollar
windows, reserved nothing and was sent no engine budget (`budgetUsd` undefined), which F19 recorded as accepted. A
Codium run can still take own-key steps:

- a scheduled run that continues a session reads that session's model (`scheduled-agents.ts`, `runTarget`) and then
  admits its prompt with no model in the body, so a model the owner switches in between the read and the admission
  runs with no budget (A23's "concurrent owner-edit race", left open in `codium-a23-guard-usage-notes.md`). PR #78
  closes this half;
- a parallel run's session model can be switched while it runs;
- a subagent can run on its own configured model (`packages/engine/src/tool/task.ts`, `next.model`).

Those steps spend the same account-wide own-key dollars the windows protect. The ledger only saw them after the run
(`recordRunCost`), so nothing stopped them mid-run, even with the day's own-key dollars already spent.

**The ruling taken (R2, option 1).** A run admitted as Codium also carries the own-key headroom as its engine budget.
Codium steps stay exempt (D-3): `SpendGuard.afterStep` adds no dollars for a `codium` step, and `checkLimits` checks
the dollar cap only on `priced` or `unknown` steps, so the budget is spent and enforced on own-key steps only. The
engine prices a Codium step at 0 (`session.ts`, the `Billing.isCodium` branch), so the desktop's `spentSoFar` for a
later prompt counts own-key spend only. The Codium check itself is unchanged: it still returns
`{ allowed: true, state: "ok", unmeasuredRuns: 0 }`, reserves nothing and never blocks the run.

**The fix.**

- New `codiumRunHeadroom(ledger, { runId, source, at? })` in `codium-run-headroom.ts`: a second, ordinary,
  non-reserving check (`checkAllowance` with no `billing` and no `reserve`), so a Codium run never takes headroom from
  an own-key run beside it. It answers that check's `budgetUsd`: the whole remaining headroom under a per-run limit,
  else the uncapped share, as an own-key run gets. When the check is blocked (the own-key dollars are already spent,
  or a limit is an explicit 0) it answers `CODIUM_RUN_HEADROOM_FLOOR_USD`, 1 cent: the run still starts, because the
  gateway caps its Codium steps, and its own-key steps stop it at their first cent. `RunBudget.Info.usd` must be above
  zero, which is why the floor is 1 cent and not 0 (the A23 decision's reason for sending no `usd: 0` budget). With no
  dollar limit in force it answers undefined, so no budget is sent, as for an own-key run.
- `parallel-workspaces.ts` `executeParallelWorkspace`: when the Codium check admitted the run, `budgetUsd` comes from
  `codiumRunHeadroom(ledger, { runId, source: "parallel" })` and is stored as `launched.spend.budgetUsd`; an own-key
  run keeps its reserving check's `allowance.budgetUsd`. Every later prompt of the run (`admitVectorPrompt`,
  `messageParallelWorkspace`) already sends `promptBudgetUsd`, the headroom less the run's measured own-key spend, so
  a later prompt after the own-key headroom is spent is refused with the existing "Spend limit reached" message, and a
  Codium-only run keeps its whole budget.
- PR #78's `codiumFence` in `scheduled-agents.ts` gives the same three answers (headroom, 1 cent when blocked or at
  zero, none without a limit). Once both land, the scheduled call site can use `codiumRunHeadroom` instead, so the
  floor lives in one place; that is a follow-up for after #78 merges, not part of either branch.

**Reverses F19 by lead ruling.** F19 (`codium-p4-repairs.md`) and the deviations entry "Known-Codium desktop runs carry
no desktop budget (F19)" read D-3 and C8 as asking for no budget at all. R2 reverses that reading. The A25 assertion
in `parallel-workspaces.spend.test.ts` (was `:419`, `expect(engineState.prompts[0]?.body.budget).toBeUndefined()`)
now expects `{ usd: headroom / 2 }`, with a dated comment beside it saying so. What D-3 and C8 protect still holds:
the Codium check neither blocks such a run nor reserves `budgetUsd`.

**A consequence for the reviewer (no change made).** A budget sent with a prompt is armed by the engine's guard
(`SpendGuard.arm`) and takes the place of `begin()`'s fallback, the config `budget.run` or research's default caps
(`session/prompt.ts`, the `guard.begin(sessionID, caps?.budget ?? own)` call). Own-key desktop runs already work this
way whenever a dollar limit is in force. A Codium parallel run under an interactive dollar limit now does too, so a
config `budget.run.steps` or research's default step cap no longer applies to it, while loop limits and the gateway
still do. Interactive work ships with no dollar limit, so by default a Codium parallel run is sent no budget and keeps
those caps. The owner's prompt route always arms (`tightenBudget` is set only for an invited guest), so the desktop
has no way to tighten instead. If that is not wanted, the follow-up is engine-side (a tightening budget field for the
owner, or option 3's model fence) and is out of this ruling's scope. PR #78 records the same consequence for
scheduled runs.

**Tests.**

- New `packages/desktop/src/main/codium-run-headroom.test.ts` (real ledger in a temporary folder), describe "the
  own-key headroom a run admitted as Codium carries":
  - "is the budget an ordinary run would get, and holds none of it": $10 a day, $4 spent: the Codium run gets $3, an
    own-key run checked next still sees $6, and after that run holds its $3 the Codium run gets $1.50.
  - "is the whole remaining headroom under a per-run limit": $5 a run, $25 a day, $22 spent: $3.
  - "is a 1-cent floor once the own-key dollars are spent, so the run still starts".
  - "is a 1-cent floor under an explicit zero limit".
  - "is absent when no dollar limit applies, as for an own-key run".
  - "never moves the Codium check itself, which still reserves nothing and skips the windows".
- `packages/desktop/src/main/parallel-workspaces.spend.test.ts`:
  - "Codium-only parallel usage reaches the persisted card without a fake zero charge" and its "mixed" twin: the A25
    assertion above, now `{ usd: headroom / 2 }`.
  - New "a Codium parallel run started after the own-key dollars are spent carries a 1-cent budget": the day's limit
    set to $0, an own-key check is blocked, the Codium run still runs with `{ usd: 0.01 }`, settles as `codium` and
    leaves no ledger event; the $10 limit is put back in a `finally`.

## 2026-11-21, verification (codium-run-headroom verifier)

Run on this branch at the merge with origin/main `edbc4a8c3`, after `bun install --ignore-scripts`. Each file ran
alone from `packages/desktop` with `bun --no-env-file test --timeout 30000 <file>`, as `scripts/test.ts` runs it in CI.

**Scheduled half dropped from this branch.** The drafter's commit `9dd990079` also changed `scheduled-agents.ts` and
`scheduled-agents.test.ts`. Open PR #78 (`spend-cap-follow`, not this branch) touches both files with the same fix
for the scheduled path, so this branch's edits there were put back to main's version in a new commit. Nothing of the
scheduled half is lost: #78 sends the same budget for the same cases and tests the race itself.

**Green.**

| File                                              | Result            |
| ------------------------------------------------- | ----------------- |
| `src/main/codium-run-headroom.test.ts`            | 6 pass, 0 fail    |
| `src/main/parallel-workspaces.spend.test.ts`      | 11 pass, 0 fail   |
| `bun typecheck` in `packages/desktop` (`tsgo -b`) | passed, no errors |

Existing files that cover the changed modules, each run alone, all green: `parallel-workspaces.follow-up.test.ts` 45,
`parallel-workspaces.environment.test.ts` 1, `parallel-workspaces.merge.test.ts` 12, `spend-limits.test.ts` 38,
`team-delivery.test.ts` 20, `swarm-orchestrator.test.ts` 36, `agent-task-model.test.ts` 8, `store-cache.test.ts` 5,
and `scheduled-agents.test.ts` 67 (main's version, unchanged here). The root `test/no-personal-paths.test.ts` passes
with these docs.

**Red before.** With `parallel-workspaces.ts` put back to origin/main (`git checkout origin/main --`) and the tests
unchanged, `parallel-workspaces.spend.test.ts` gave 8 pass, 3 fail: both A25 cases (line 423) and the new 1-cent case
(line 469), each on `body.budget` (expected the budget, received `undefined`). With `codium-run-headroom.ts` removed,
`codium-run-headroom.test.ts` fails to load ("Cannot find module './codium-run-headroom'"). Both files were restored
with `git checkout HEAD --`, their sha256 matched the saved ones and `git status` showed nothing else changed.

**Mutations.** Each restored with `git checkout HEAD --`, sha256 matched afterwards.

1. `codium-run-headroom.ts` returns `undefined` instead of the floor for a blocked check: the helper file gave 3 pass,
   3 fail (both floor cases and "never moves the Codium check itself"), and `parallel-workspaces.spend.test.ts` gave
   10 pass, 1 fail (the 1-cent case).
2. `codium-run-headroom.ts` passes `reserve: true` to the ordinary check: "is the budget an ordinary run would get, and
   holds none of it" went red (expected 6, received 3). `parallel-workspaces.spend.test.ts` stays green under this
   mutation, because it reads other runs' headroom only after the run has settled; the helper's own case is the guard.

**CI.** Nothing in this branch needs Valkey, Linux bubblewrap, Windows or macOS-only tooling, so every result above is
local evidence. The ordinary `test.yml` unit lane runs only desktop main's computer-use files (turbo has no desktop
test task), so these files run in CI in `vector-desktop-release.yml`'s "Test (desktop)" job (`bun run test` in
`packages/desktop`), and `codium-run-headroom.test.ts`, whose path names Codium, also runs in `vector-codium.yml`'s
"Codium tests" shards on a push to main.
