import { cloudAgentView } from "./codium-cloud-agents.js"
import { cloudAgentSecondsUsed } from "./cloud-agents-ledger.js"
import { persistentStore } from "./persistent-store.js"
import type { StatusMeterReader } from "./model-plan-status.js"

/** Status exposes a share only. The reader's abort signal also bounds its actual protected-store request. */
export const readCloudAgentsStatusMeter: StatusMeterReader<"cloudAgents"> = async (snapshot, fetcher, signal) => {
  const now = Date.now()
  const allowance = cloudAgentView(snapshot, "github-dispatch", now)
  if (!allowance.active || allowance.allowanceSeconds <= 0) return undefined
  const request = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      fetcher(input, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      }),
    fetcher,
  )
  const used = await cloudAgentSecondsUsed(snapshot.account, snapshot.meterEpoch, now, (command) =>
    persistentStore(command, request),
  )
  return { used: Math.min(1, used / allowance.allowanceSeconds), exhausted: used >= allowance.allowanceSeconds }
}
