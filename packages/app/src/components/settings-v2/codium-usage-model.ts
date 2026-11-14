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
  return ModelPlanStatus.forecastText(status?.plan?.forecastDate, undefined)
}

const DAY_MS = 86_400_000
/** The usage strip shows the last 31 UTC dates up to the newest one status sent (A32). */
export const HISTORY_STRIP_DAYS = 31
const utcDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

export type UsageStripDay = {
  day: string
  /** Read aloud and shown on hover, such as "Oct 3: 4% of this month" or "Oct 3: <1% of this month". */
  label: string
  /** Whether the date belongs to this period; earlier dates have no share. */
  period: boolean
  today: boolean
  /** The bar's height, as a percentage of the strip's busiest day. */
  height: number
}

/**
 * Settings → Usage's 31-day strip (A32): each UTC date's share of this month's Codium usage as a whole percent, "<1%"
 * when it rounds to 0. Status's history counts every Codium request wherever it was made (runs started while this
 * computer is off included) and starts on the period's first date, so dates before it show no share. Undefined
 * without a history.
 */
export function usageHistoryStrip(status: ModelPlanStatus.Status | undefined, now = Date.now()) {
  if (!status?.signedIn || status.error || !status.plan || !status.history?.length) return undefined
  const shares = new Map(status.history.map((entry) => [entry.day, entry.used]))
  const dates = [...shares.keys()].sort()
  const first = dates[0]!
  const last = Date.parse(`${dates.at(-1)!}T00:00:00Z`)
  const peak = Math.max(0.01, ...shares.values())
  const today = new Date(now).toISOString().slice(0, 10)
  const days = Array.from({ length: HISTORY_STRIP_DAYS }, (_, index): UsageStripDay => {
    const day = new Date(last - (HISTORY_STRIP_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10)
    const used = shares.get(day)
    const period = day >= first
    return {
      day,
      label:
        used === undefined
          ? `${utcDate(day)}: ${period ? "not available" : "before this period"}`
          : `${utcDate(day)}: ${ModelPlanStatus.formatDayShare(used)} of this month`,
      period,
      today: day === today,
      height: used === undefined ? 0 : Math.round((used / peak) * 100),
    }
  })
  return {
    days,
    caption:
      "Each bar is one day's share of this month's Codium usage, by UTC date. It counts all your Codium work, not just this computer's.",
  }
}

/** The local usage summary's days, as Settings → Usage reads them. */
type LocalUsage = { days: readonly { date: string; codium?: number }[]; legacyCodium?: boolean }

/**
 * The renewal card (A32): what this computer did on Codium this period, in counts only (never tokens, dollars or
 * shares), from the local usage summary. The period starts on status history's first date; local dates are counted
 * from that date on, so the first day can be off by the hours between UTC and local time. Undefined without a plan, a
 * history, or a summary that can attribute Codium work to days (older servers cannot).
 */
export function renewalCard(status: ModelPlanStatus.Status | undefined, summary: LocalUsage | undefined) {
  if (!status?.signedIn || status.error || !status.plan || !status.history?.length) return undefined
  if (!summary || summary.legacyCodium) return undefined
  const since = status.history.map((entry) => entry.day).sort()[0]!
  const worked = summary.days.filter((day) => day.date >= since && (day.codium ?? 0) > 0)
  const responses = worked.reduce((count, day) => count + (day.codium ?? 0), 0)
  return {
    title: status.plan.cancelAtPeriodEnd ? "Before your plan ends" : "Before your plan renews",
    rows: [
      { label: "Codium responses", value: responses.toLocaleString() },
      { label: "Days with Codium work", value: worked.length.toLocaleString() },
    ],
    note: `Counted on this computer since ${utcDate(since)}.`,
  }
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
