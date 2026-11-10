import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

/** Round once, then derive the other side: the two displayed shares always add up to 100. */
export function usageShare(left: number | undefined) {
  if (left === undefined || !Number.isFinite(left) || left < 0 || left > 1) return undefined
  const remaining = Math.round(left * 100)
  return { left: remaining, used: 100 - remaining, text: `${100 - remaining}% used · ${remaining}% left` }
}

export function codiumUsageRows(status: ModelPlanStatus.Status | undefined) {
  if (!status?.signedIn || status.error) return []
  const listed = new Set(status.listed)
  const meters = status.meters
  const rows: { label: string; share: ReturnType<typeof usageShare>; detail?: string }[] = []
  if (status.plan) rows.push({ label: "This month", share: usageShare(status.plan.left) })
  if (status.plan?.today)
    rows.push({
      label: "Today",
      share: usageShare(1 - status.plan.today.used),
      detail: `Resets ${new Date(status.plan.today.resetsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    })
  if (listed.has("github-agents"))
    rows.push({ label: "Codium agent time", share: usageShare(meters?.cloudAgents && 1 - meters.cloudAgents.used) })
  if (listed.has("computer"))
    rows.push({ label: "Cloud computer hours", share: usageShare(meters?.hosted && 1 - meters.hosted.used) })
  if (listed.has("vault")) {
    const vault = meters?.vault
    rows.push({
      label: "Vault storage",
      share: usageShare(
        vault && vault.quotaBytes > 0 ? Math.max(0, 1 - vault.usedBytes / vault.quotaBytes) : undefined,
      ),
      detail: vault
        ? `${(vault.usedBytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB used of ${(vault.quotaBytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`
        : undefined,
    })
  }
  if (listed.has("brain"))
    rows.push({
      label: "Brain helpers",
      share: usageShare(
        meters?.brain && meters.brain.cap > 0 ? Math.max(0, 1 - meters.brain.used / meters.brain.cap) : undefined,
      ),
    })
  return rows
}

export function usageFreshness(updatedAt: number | undefined, now = Date.now()) {
  if (updatedAt === undefined) return "Not updated yet"
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000))
  return minutes === 0 ? "Updated just now" : `Updated ${minutes} min ago`
}

export function usageForecast(status: ModelPlanStatus.Status | undefined) {
  const date = status?.plan?.forecastDate
  if (!date) return undefined
  return `At this pace, this month's usage may run out around ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`
}

/** The open card owns these listeners/timers; closing it cancels its delayed read. */
export function createUsageRefresh(
  refresh: () => void,
  input: {
    now?: () => number
    schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
    cancel?: (timer: ReturnType<typeof setTimeout>) => void
  } = {},
) {
  const now = input.now ?? Date.now
  const schedule = input.schedule ?? setTimeout
  const cancel = input.cancel ?? clearTimeout
  const state = { lastRead: -Infinity, timer: undefined as ReturnType<typeof setTimeout> | undefined, closed: false }
  return {
    read() {
      state.lastRead = now()
    },
    focus() {
      if (state.closed || now() - state.lastRead < 60_000) return
      state.lastRead = now()
      refresh()
    },
    turn() {
      if (state.closed || state.timer !== undefined) return
      state.timer = schedule(() => {
        state.timer = undefined
        if (!state.closed) refresh()
      }, 15_000)
    },
    dispose() {
      state.closed = true
      if (state.timer !== undefined) cancel(state.timer)
    },
  }
}
