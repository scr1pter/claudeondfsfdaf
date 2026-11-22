# spend-cap-follow: A23-model-edit-race

Branch `spend-cap-follow`, cut from origin/main `609763f7`. It covers one Vector v2 leftover P0 item: the concurrent owner model change that A23 left unfenced. No flag, provider, Stripe, protocol or generated file changes.

The A23 record is `docs/vector/build/codium-a23-guard-usage-notes.md`. It is a shared lane doc, so this entry lives here. Fold the status line at the end of this entry into its "Status on 8 Nov 2026 (P4b)" section.

Files: `packages/desktop/src/main/scheduled-agents.ts` and its test, and `packages/core/test/spend-guard.test.ts` (test only). `spend-limits.ts` is unchanged.

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

- An owner-armed `budget` replaces begin()'s fallback in the guard (`arm` clears `fallback`; V2's `begin` keeps an owner-armed budget). A Codium scheduled run that resumes a session whose agent is research now runs under the `{ usd }` fence instead of research's default caps, so research's default step cap no longer applies to it. Priced scheduled runs already behave this way. Other agents are unaffected: V2 arms no config `budget.run` today (`core/src/session/runner/llm.ts`).
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

> 22 Nov 2026 (`spend-cap-follow`): the concurrent owner model edit is now fenced. A Codium scheduled run carries its ordinary dollar headroom, or $0.01 when none is left, as a cap the engine applies to priced and unknown steps only, and it holds no reservation. A switch to a priced model is stopped within one step, so it can overrun the window by at most one step, or by one step past the $0.01 floor. A pure Codium run's warn and stop messages name no dollar cap. Lead ruling: the $0.01 floor.
