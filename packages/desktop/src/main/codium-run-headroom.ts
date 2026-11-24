import type { SpendLedger, SpendSource } from "./spend-limits"

// The engine budget a desktop run admitted as Codium carries (lead ruling R2, 21 Nov 2026, on A23's model edit race).
// Its Codium check reserves nothing and skips the dollar windows, and Codium steps stay exempt: the run guard counts
// no dollars for them and checks its dollar cap only on priced or unknown steps (D-3). The same run can still take
// own-key steps: its session's model can change between the desktop's read and the prompt's admission, or while it
// runs, and a subagent can run on its own configured model. Those steps spend the account-wide dollars the windows
// protect, so the run is sent the headroom an ordinary run would get as its budget, and the engine stops it within
// one own-key step of it. The check holds nothing, so a Codium run never takes headroom from an own-key run beside it.
//
// When the dollars are already spent, the run still starts (the gateway caps its Codium steps) with a 1-cent budget,
// because a budget must be above zero (`RunBudget.Info.usd`): own-key steps stop it at their first cent.
export const CODIUM_RUN_HEADROOM_FLOOR_USD = 0.01

// Undefined when no dollar limit applies, so the run is sent no budget, as an own-key run would be.
export async function codiumRunHeadroom(
  ledger: Pick<SpendLedger, "checkAllowance">,
  run: { runId: string; source: SpendSource; at?: Date },
): Promise<number | undefined> {
  // No `billing` and no `reserve`: the ordinary windows, read without holding anything.
  const ordinary = await ledger.checkAllowance({ runId: run.runId, source: run.source, at: run.at })
  if (!ordinary.allowed) return CODIUM_RUN_HEADROOM_FLOOR_USD
  if (ordinary.budgetUsd === undefined) return undefined
  return ordinary.budgetUsd > 0 ? ordinary.budgetUsd : CODIUM_RUN_HEADROOM_FLOOR_USD
}
