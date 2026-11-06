import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { SessionUsageSummary } from "@vectordevai/sdk/v2"
import { helperLabel } from "./internal-sessions"

export type DisplayUsageSummary = SessionUsageSummary & { legacyCodium?: boolean }

export type UsageStreakDay = {
  date: string
  label: string
  day: string
  tokens: number
  codium?: number
  tokensUnknown?: boolean
  active: boolean
  today: boolean
}

const localDateKey = (date: Date) => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function usageStreakCalendar(summary: DisplayUsageSummary) {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const byDate = new Map(summary.days.map((day) => [day.date, day]))
  return Array.from({ length: 7 }, (_, index): UsageStreakDay => {
    const current = addDays(today, index - 6)
    const date = localDateKey(current)
    const usage = byDate.get(date)
    return {
      date,
      label: current.toLocaleDateString(undefined, { weekday: "short" }),
      day: current.toLocaleDateString(undefined, { day: "numeric" }),
      tokens: usage?.tokens ?? 0,
      ...(usage?.codium ? { codium: usage.codium } : {}),
      ...(summary.legacyCodium && usage ? { tokensUnknown: true } : {}),
      active: (usage?.tasks ?? 0) > 0,
      today: index === 6,
    }
  })
}

function emptyUsageSummary(): SessionUsageSummary {
  return {
    lifetimeTokens: 0,
    lifetimeCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    peakTokens: 0,
    longestTaskMs: 0,
    longestTaskTokens: 0,
    averageTaskMs: 0,
    currentStreak: 0,
    longestStreak: 0,
    completedChats: 0,
    conversations: 0,
    activeDays: 0,
    averageTokensPerChat: 0,
    modelResponses: 0,
    favoriteModels: [],
    effortLevels: [],
    days: [],
  }
}

export function normalizeUsageSummary(value: Partial<DisplayUsageSummary> | undefined): DisplayUsageSummary {
  const fallback = emptyUsageSummary()
  const summary = {
    ...fallback,
    ...value,
    favoriteModels: Array.isArray(value?.favoriteModels) ? value.favoriteModels : fallback.favoriteModels,
    effortLevels: Array.isArray(value?.effortLevels) ? value.effortLevels : fallback.effortLevels,
    days: Array.isArray(value?.days) ? value.days : fallback.days,
  }
  const codium = summary.favoriteModels.filter((model) => Billing.of(model))
  if (summary.codiumResponses !== undefined || !codium.length) return summary
  // Old servers mix Codium into aggregate tokens and cannot attribute it by day or helper. Keep all activity and
  // recorded dollars (Codium contributed zero), but hide inseparable tokens. The ranking proves only these responses.
  return {
    ...summary,
    legacyCodium: true,
    codiumResponses: Math.max(
      1,
      codium.reduce((count, model) => count + model.responses, 0),
    ),
    lifetimeTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    peakTokens: 0,
    longestTaskTokens: 0,
    averageTokensPerChat: 0,
    favoriteModels: summary.favoriteModels.filter((model) => !Billing.of(model)),
    effortLevels: summary.effortLevels.map((effort) => ({ ...effort, tokens: 0 })),
    days: summary.days.map((day) => ({ ...day, tokens: 0 })),
    ...(summary.helpers ? { helpers: summary.helpers.map((helper) => ({ ...helper, tokens: 0 })) } : {}),
  }
}

/** Visible usage contains own quantities and an unnumbered Codium label, even for a Codium-only day. */
export function usageTokens(
  tokens: number,
  codium = 0,
  format: (value: number) => string = (value) => value.toLocaleString(),
  tokensUnknown = false,
) {
  if (tokensUnknown) return CodiumUsage.withCodium("Token totals unavailable", codium)
  return CodiumUsage.withCodium(tokens > 0 || codium <= 0 ? `${format(tokens)} tokens` : undefined, codium)
}

// What Vector's helpers spent, by the name the user knows them by. Their spend is already in every total; this says how
// much of it they account for, including reviews started outside any session.
export function helperUsage(helpers: SessionUsageSummary["helpers"]) {
  return [
    ...(helpers ?? [])
      .reduce((groups, helper) => {
        const label = helperLabel(helper.id)
        const current = groups.get(label) ?? { label, sessions: 0, responses: 0, tokens: 0, cost: 0 }
        return groups.set(label, {
          label,
          sessions: current.sessions + helper.sessions,
          responses: current.responses + helper.responses,
          tokens: current.tokens + helper.tokens,
          cost: current.cost + helper.cost,
          ...((current.codiumSteps ?? 0) + (helper.codiumSteps ?? 0) > 0
            ? { codiumSteps: (current.codiumSteps ?? 0) + (helper.codiumSteps ?? 0) }
            : {}),
        })
      }, new Map<string, { label: string; sessions: number; responses: number; tokens: number; cost: number; codiumSteps?: number }>())
      .values(),
  ].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label))
}
