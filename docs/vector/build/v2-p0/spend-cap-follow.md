# spend-cap-follow: A23-model-edit-race

Branch `spend-cap-follow`, cut from origin/main `609763f7`. It covers one Vector v2 leftover P0 item: the concurrent owner model change that A23 left unfenced. No flag, provider or Stripe changes. The review follow-up below adds one optional protocol field, `tightenBudget`, and regenerates `packages/client`.

The A23 record is `docs/vector/build/codium-a23-guard-usage-notes.md`. It is a shared lane doc, so this entry lives here. Fold the status line at the end of this entry into its "Status on 8 Nov 2026 (P4b)" section.

Files: `packages/desktop/src/main/scheduled-agents.ts` and its test, and `packages/core/test/spend-guard.test.ts` (test only). `spend-limits.ts` is unchanged. The review follow-up adds `packages/protocol/src/groups/session.ts`, `packages/server/src/handlers/session.ts`, the regenerated `packages/client/src/generated*`, and a test in `packages/engine/test/server/httpapi-session.test.ts`.

## 2026-11-22, a priced-only dollar fence for Codium scheduled runs

**The gap.** A23's "Review and limits" section says it: an owner can change an existing session's model between the desktop's model read and prompt admission. `runTarget` in `scheduled-agents.ts` reads the session's model, and when it is Codium, the ledger's Codium branch admits the run with no reservation and no `budgetUsd`. The prompt then went to the engine with no `budget` at all. A switch to a priced model after that read, or during the run, ran uncapped: the scheduled run's dollar windows were checked against nothing. Its cost was recorded afterwards, but nothing stopped it.

**The fix** (desktop only):

- The Codium check still runs first and still admits the run with nothing reserved, as A23 intends.
- A Codium run then makes the ordinary check, `checkAllowance({ runId, source: "scheduled", reserve: false })`, to read the dollar headroom. It holds nothing. `codiumFence` turns the answer into the prompt's `budget.usd`:
  - allowed with a positive `budgetUsd`: that headroom (the whole of it under a per-run limit, half of it without one, as for any run);
  - blocked, or a headroom that is not positive: `CODIUM_FENCE_FLOOR_USD`, $0.01;
  - no dollar limits at all: no budget, as before.
- A non-Codium run is unchanged: it still sends its reserved `allowance.budgetUsd`.

The engine compares a run's dollar cap with priced and unknown steps only (`checkLimits` in `packages/core/src/spend-guard.ts` returns ok for any other cost kind before reading `usd`). So a pure Codium run never feels the cap. A priced step after a switch counts against it, and the guard stops the run within one step. The existing guard-stop path in `promptTarget` then fails the target with the engine's message, and `recordRunCost` charges the priced cost to the ledger.

**Lead ruling.** The lead ruled on the cap: use the minimal priced-only cap the plan proposes. The plan's suggested value is $0.01, so that is the floor. The engine's warn and stop messages must not mention a dollar cap for a pure Codium run. The core test below asserts that.

**What the fence cannot do.**

- A priced switch can overrun the window by at most one step, as every capped run can. Under the floor it can overrun by one step past $0.01. The guard checks after each step, and the cost of the step that crosses the cap is already spent.
- The headroom is not reserved, so two Codium runs that both switch to priced models can each spend up to the same headroom. Holding it would take dollars from other runs that a Codium run never spends, which is what A23 chose against.
- With the day exhausted, a priced step stops with "Spend cap reached: $0.03 spent against a $0.01 cap for this run. …". The $0.01 is the floor, not a limit the user set. The message is accurate about the run, but it does not say the window was exhausted.

**Choices beyond the plan's letter, for the reviewer.**

- A headroom below the floor (positive but under $0.01) is sent as it is, not raised to $0.01. It is the stricter of the two.
- Plan step 4 asked for a dated line in `codium-a23-guard-usage-notes.md`. The task forbids editing shared lane docs, so the line is proposed below for the lead to fold in.

**What could go wrong.**

- Fixed in the review follow-up below. As first written, the fence was armed as the owner's budget, which replaces begin()'s fallback in the guard, so a Codium scheduled run on a research session lost research's default caps. Priced scheduled runs still arm their reserved headroom as the owner's budget; that is unchanged.
- The app's Budget stop card renews `capUsd` on Continue. After a loop stop on a Codium scheduled session, a Continue carries the fence's cap into the next prompt. Codium steps ignore it; a priced step under it stops as above. Priced scheduled runs already renew their cap the same way.
- The spend route and the `Spend` status event now report `budget.usd` and `capUsd` for a Codium scheduled run. The app's cost pill hides a cap while the run has spent no dollars (`spendPill` in `packages/app/src/features/economics/format-spend.ts`). The stop card leaves out the dollar line for a Codium-only stop (`budgetStopCopy`). Neither was changed.
- The drain aggregation issue A23 notes (a zero `budgetUsd` causing false headroom refusals) does not come back. The fence never sends zero, and the ledger's `allowance.budgetUsd` is unchanged.

**Tests.**

- `scheduled-agents.test.ts`, the new describe at :1157, "a Codium run's priced-only dollar fence". It uses a real `createSpendLedger` in a temp folder, with no external hosts:
  - :1181, no dollar limits: no budget, and the second check is `reserve: false`.
  - :1198, a $10 day: the prompt carries `budget.usd` 5. A check from another run, made while this one is active, is still handed $5, so nothing was held.
  - :1220, a day whose headroom another run holds: the run is still admitted, with `budget.usd` 0.01.
  - :1237, the session switches to a priced model after the first read. A fake engine stops priced steps only under an armed cap. The target fails with the guard's message, and the ledger records $5.02 against the priced provider.
- The harness got three test-only options: `ledger` (a real ledger in place of the fake allowance), `switchedModel` (every session read after the first reports it), and an armed-budget argument to `spend`. `onActivePoll` is now awaited.
- `spend-guard.test.ts` :115, "the scheduled fence's smallest cap never warns a Codium-only run, and its stops name no dollars". Under `{ usd: 0.01 }`, 45 continuing Codium steps with a catalog price all give `{ state: "ok" }`: no warning, no stop. A step-limit stop and a loop stop name no dollars and no cap. The first priced step after two Codium steps is stopped for `cap`.
- The two A23 model-boundary cases (:1089 and :1107) are unchanged and pass.

**Evidence** (each file run alone through vector-serial with `--timeout 30000`):

- Red-before. With origin/main's `scheduled-agents.ts` put back in the working tree and the tests unchanged, the desktop file gave 67 pass and 4 fail: :1181, :1198, :1220 and :1237. The fixed file was restored, and its sha256 (`febef364…`) matched.
- Green. `scheduled-agents.test.ts` 71 of 71, `spend-limits.test.ts` 38 of 38, core `spend-guard.test.ts` 81 of 81. After that run, the only source change was one comment line. The final file (sha256 `81814d81…`) was run again: 71 of 71. `bun typecheck` passed in packages/desktop and packages/core. Prettier was clean on the three changed files.
- Mutation M1 set the fence check to `reserve: true`. :1198 went red (the other run was handed 2.5, not 5), and so did :1181. The file was restored, and its sha256 matched.
- Mutation M2, in core, let `checkLimits` apply dollar rules to `codium` steps. Only the new core test went red (80 pass, 1 fail). The older Codium test kept passing because it has no continuing priced-looking steps. Restored with `git checkout`, and the diff was empty.
- The core test is a characterization test of existing engine behaviour, so it is green both before and after the desktop change. M2 shows that it bites.

**Status line to fold into `codium-a23-guard-usage-notes.md` (P4b section).**

> 22 Nov 2026 (`spend-cap-follow`): the concurrent owner model edit is now fenced. A Codium scheduled run carries its ordinary dollar headroom, or $0.01 when none is left, as a cap the engine applies to priced and unknown steps only, and it holds no reservation. The cap is sent with `tightenBudget`, so it only narrows the run's limits: an agent's own default caps, such as research's $1 and 80 steps, still hold, and the stricter of each limit applies. A switch to a priced model is stopped within one step, so it can overrun the window by at most one step, or by one step past the $0.01 floor. A pure Codium run's warn and stop messages name no dollar cap. Lead ruling: the $0.01 floor.

## 2026-11-22, review follow-up: the fence only narrows

**What the review found** (should-fix). The fence went out as a plain owner `budget`. The server arms an owner's budget with `guard.arm`, and an armed budget replaces begin()'s fallback (`begin` in `packages/core/src/spend-guard.ts` leaves nothing movable once an owner budget is held). So a Codium scheduled run that resumes a research session lost research's Focused caps, `{ usd: 1, steps: 80 }` (`packages/core/src/research/plan.ts`), which the V2 runner applies through `guard.replaceFallback` (`packages/core/src/session/runner/llm.ts`). Its 80-step cap was gone, and a priced switch could spend the whole scheduled headroom instead of $1.

**The fix.**

- `session.prompt` (V2) takes an optional `tightenBudget: boolean` (`packages/protocol/src/groups/session.ts`). The handler (`packages/server/src/handlers/session.ts`) arms the budget with `guard.tighten` instead of `guard.arm` when it is true, as it already does for a guest. The guard needed no change: a tightened budget keeps the fallback movable, so research's caps still apply, and each limit is the stricter of the two.
- The desktop sends `tightenBudget: true` with a Codium run's fence only (`promptTarget` in `scheduled-agents.ts`). A priced run's reserved headroom is still the owner's own budget. A run with no dollar limit still sends no budget.
- `bun run generate` in `packages/client` regenerated `src/generated` and `src/generated-effect`. The legacy JS SDK was not regenerated; CI checks only the client.

**Why a protocol field, not a desktop-only fix.** The task preferred a desktop-side fix if the guard's tighten path needed a protocol change. Nothing in the V2 route lets the owner tighten. A desktop-only fix would have to send research's caps itself. To do that it would copy the engine's choice of agent and the user's own `research.limits`. A user who set tighter Focused limits than the defaults would then have them replaced by the defaults, which loosens them. The field is one optional boolean, and it can only lower limits.

**Behaviour now.**

- Research session, $5 fence: `{ usd: 1, steps: 80 }`. Research session, $0.50 fence: `{ usd: 0.5, steps: 80 }`.
- A pure Codium run on another agent: `{ usd: <fence> }`, as before. Codium steps never feel it.
- A fence that lands on a run already going keeps the stricter of that run's limits and the fence, instead of replacing them.
- A Codium run that carries on from a stopped run keeps the stricter of that run's cap and the new fence. This only affects priced steps after a switch.

**Tests.**

- `packages/engine/test/server/httpapi-session.test.ts`, "a v2 prompt budget sent with tightenBudget keeps research's default caps and takes the stricter of each". It posts the fence to the real V2 route, begins the run, and moves the fallback to research's Focused caps as the V2 runner does. A $5 fence gives `{ usd: 1, steps: 80 }`. A $0.50 fence gives `{ usd: 0.5, steps: 80 }`. The same budget without the flag still gives `{ usd: 5 }`.
- `scheduled-agents.test.ts`: the three Codium fence cases with a budget now expect `tightenBudget: true`. The priced-headroom case and the no-limit Codium case expect no `tightenBudget`.

**Evidence** (each file run alone through vector-serial with `--timeout 30000`).

- Red before. With HEAD's protocol and server files put back, the engine file gave 26 pass and 1 fail: the new case received `{ usd: 5 }` for the $5 fence. With HEAD's `scheduled-agents.ts` put back, the desktop file gave 68 pass and 3 fail: the three Codium cases that expect `tightenBudget: true`. All three fixed files were restored, and their sha256 matched.
- Green after. Engine `httpapi-session.test.ts` 27 of 27. Desktop `scheduled-agents.test.ts` 71 of 71, `spend-limits.test.ts` 38 of 38. Core `spend-guard.test.ts` 81 of 81. The guest budget case in `auth-guest.test.ts` passed. `bun typecheck` passed in protocol, server, client, desktop and engine. Prettier was clean.
