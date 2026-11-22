# codium-run-headroom: A23-model-edit-race

Branch `codium-run-headroom`, cut from origin/main `609763f72`. It covers one Vector v2 leftover P0 item,
A23-model-edit-race, under lead ruling R2 option 1 (rulings file, 21 Nov 2026). Desktop only: no engine, protocol,
generated client or budget file changes, and every flag stays off.

Files: the new `packages/desktop/src/main/codium-run-headroom.ts` and `codium-run-headroom.test.ts`,
`scheduled-agents.ts`, `parallel-workspaces.ts`, `scheduled-agents.test.ts`, `parallel-workspaces.spend.test.ts`, and
these docs. Short dated pointers are in `codium-deviations.md`, `codium-p4-repairs.md` (under F19) and
`codium-a23-guard-usage-notes.md`, which no open PR touches. `spend-limits.ts`, `run-budget.ts` and `spend-guard.ts`
are read, not changed: the helper is named `codium-run-headroom.ts`, as the plan asks, to stay apart from them.

## 2026-11-21, A23 model edit race: a run admitted as Codium carries the own-key headroom

**The gap.** A desktop run admitted as Codium (`checkAllowance({ billing: "codium" })`) skipped the local dollar
windows, reserved nothing and was sent no engine budget (`budgetUsd` undefined), which F19 recorded as accepted. A
Codium run can still take own-key steps:

- a scheduled run that continues a session reads that session's model (`scheduled-agents.ts`, `runTarget`) and then
  admits its prompt with no model in the body, so a model the owner switches in between the read and the admission
  runs with no budget (A23's "concurrent owner-edit race", left open in `codium-a23-guard-usage-notes.md`);
- a parallel run's session model can be switched while it runs;
- a subagent can run on its own configured model (`packages/engine/src/tool/task.ts`, `next.model`).

Those steps spend the same account-wide own-key dollars the windows protect. The ledger only saw them after the run
(`recordRunCost`), so nothing stopped them mid-run, even with the day's own-key dollars already spent.

**The ruling taken (R2, option 1).** A run admitted as Codium also carries the own-key headroom as its engine budget.
Codium steps stay exempt (D-3): `SpendGuard.afterStep` adds no dollars for a `codium` step, and `checkLimits` checks
the dollar cap only on `priced` or `unknown` steps, so the budget is spent and enforced on own-key steps only. The
Codium check itself is unchanged: it still returns `{ allowed: true, state: "ok", unmeasuredRuns: 0 }`, reserves
nothing and never blocks the run.

**The fix.**

- New `codiumRunHeadroom(ledger, { runId, source, at? })` in `codium-run-headroom.ts`: a second, ordinary,
  non-reserving check (`checkAllowance` with no `billing` and no `reserve`), so a Codium run never takes headroom from
  an own-key run beside it. It answers that check's `budgetUsd`: the whole remaining headroom under a per-run limit,
  else the uncapped share, as an own-key run gets. When the check is blocked (the own-key dollars are already spent,
  or a limit is an explicit 0) it answers `CODIUM_RUN_HEADROOM_FLOOR_USD`, 1 cent: the run still starts, because the
  gateway caps its Codium steps, and its own-key steps stop it at their first cent. `RunBudget.Info.usd` must be above
  zero, which is why the floor is 1 cent and not 0 (the A23 decision's reason for sending no `usd: 0` budget). With no
  dollar limit in force it answers undefined, so no budget is sent, as for an own-key run.
- `scheduled-agents.ts` `runTarget`: when the Codium check admitted the run, `budgetUsd` comes from
  `codiumRunHeadroom(ledger, { runId, source: "scheduled" })`; an own-key run keeps its reserving check's
  `allowance.budgetUsd`. `promptTarget` sends it as `budget: { usd }` exactly as before.
- `parallel-workspaces.ts` `executeParallelWorkspace`: the same with `source: "parallel"`, stored as
  `launched.spend.budgetUsd`. Every later prompt of the run (`admitVectorPrompt`, `messageParallelWorkspace`) already
  sends `promptBudgetUsd`, the headroom less the run's measured own-key spend (Codium steps cost 0 there), so a later
  prompt after the own-key headroom is spent is refused with the existing "Spend limit reached" message, and a
  Codium-only run keeps its whole budget.

**Reverses F19 by lead ruling.** F19 (`codium-p4-repairs.md`) and the deviations entry "Known-Codium desktop runs carry
no desktop budget (F19)" read D-3 and C8 as asking for no budget at all. R2 reverses that reading. The A25 assertion
in `parallel-workspaces.spend.test.ts` (was `:419`, `expect(engineState.prompts[0]?.body.budget).toBeUndefined()`)
now expects `{ usd: headroom / 2 }`, with a dated comment beside it saying so. What D-3 and C8 protect still holds:
the Codium check neither blocks such a run nor reserves `budgetUsd`.

**A consequence for the reviewer (no change made).** A budget sent with a prompt is armed by the engine's guard
(`SpendGuard.arm`) and takes the place of `begin()`'s fallback, the config `budget.run` or research's default caps
(`session/prompt.ts`, the `guard.begin(sessionID, caps?.budget ?? own)` call). Own-key desktop runs already work this
way whenever a dollar limit is in force. A Codium desktop run now does too: under the default unattended policy
($5 a run, $25 a day) every scheduled Codium run arms `{ usd }`, so a config `budget.run.steps` or research's default
step cap no longer applies to it, while loop limits and the gateway still do. D-3 (label plan) says only the step and
loop limits stop a Codium run; with a dollar limit in force, the step limit from config or research's defaults is now
the one an own-key desktop run already loses. The owner's prompt route always arms (`tightenBudget` is set only for an
invited guest), so the desktop has no way to tighten instead. If that is not wanted, the follow-up is engine-side (a
tightening budget field for the owner, or option 3's model fence) and is out of this ruling's scope.

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
- `packages/desktop/src/main/scheduled-agents.test.ts`, describe "a scheduled run admitted as Codium carries the
  own-key headroom" (the harness gains `sessionModelOnRead`, the model each read of a session's route answers):
  - "a fresh Codium session is sent the headroom an ordinary check gives, and nothing is held": budget `{ usd: 5 }`,
    checks `[["codium", true], [undefined, undefined]]` on one run id, nothing reserved.
  - "an own-key model switched in after the Codium read is admitted under the own-key headroom": the race itself.
    The session reads as Codium for the admission check and as `provider-own` from the next read on; the prompt
    carries `{ usd: 2.5 }` and the ledger records the run under `provider-own`.
  - "a Codium run whose own-key dollars are spent still starts, with a 1-cent budget": completed, budget
    `{ usd: 0.01 }`.
  - "a Codium run with no dollar limit is sent no budget, as an own-key run would be" (guard).
  - "an own-key run still takes one reserving check and its own headroom" (guard).
- `packages/desktop/src/main/parallel-workspaces.spend.test.ts`:
  - "Codium-only parallel usage reaches the persisted card without a fake zero charge" and its "mixed" twin: the A25
    assertion above, now `{ usd: headroom / 2 }`.
  - New "a Codium parallel run started after the own-key dollars are spent carries a 1-cent budget": the day's limit
    set to $0, an own-key check is blocked, the Codium run still runs with `{ usd: 0.01 }`, settles as `codium` and
    leaves no ledger event; the $10 limit is put back in a `finally`.

**Evidence.** Not run by the drafter, who did not hold the Bun turn (no bun, test runner or typecheck was run). Run
each file alone from `packages/desktop`, one at a time:

- `bun test --timeout 30000 src/main/codium-run-headroom.test.ts`
- `bun test --timeout 30000 src/main/scheduled-agents.test.ts`
- `bun test --timeout 30000 src/main/parallel-workspaces.spend.test.ts`
- `bun typecheck` in `packages/desktop` (the helper and both call sites; test files are excluded from the desktop
  tsconfig).

Expected red-before, with `scheduled-agents.ts` and `parallel-workspaces.ts` put back to origin/main (save the diff,
`git checkout --` both, restore with `git apply`, compare sha256): in `scheduled-agents.test.ts` the fresh-session,
switched-model and 1-cent cases fail on `budget` (received undefined); in `parallel-workspaces.spend.test.ts` both
A25 cases and the new 1-cent case fail on `budget` (received undefined). `codium-run-headroom.test.ts` fails to load
without `codium-run-headroom.ts`.

Mutation checks to run:

1. In `codium-run-headroom.ts`, return `undefined` instead of `CODIUM_RUN_HEADROOM_FLOOR_USD` for a blocked check:
   the two floor cases in the helper's file, the scheduled 1-cent case and the parallel 1-cent case go red.
2. In `codium-run-headroom.ts`, pass `reserve: true` to the ordinary check: "is the budget an ordinary run would get,
   and holds none of it" goes red (the own-key run sees $3, not $6).
3. In `scheduled-agents.ts`, send `allowance.budgetUsd` for a Codium run again: the three scheduled cases go red.

Restore each file after its mutation and compare its sha256 with the saved one.
