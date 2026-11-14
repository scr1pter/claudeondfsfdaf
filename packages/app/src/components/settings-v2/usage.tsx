import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Component, For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { formatSessionCost } from "@/utils/session-cost"
import { formatServerError } from "@/utils/server-errors"
import {
  helperUsage,
  normalizeUsageSummary,
  usageStreakCalendar,
  usageTokens,
  type DisplayUsageSummary,
} from "@/utils/usage-summary"
import { SettingsVectorCodium } from "../settings-vector-codium"
import "./settings-v2.css"

type UsageView = "daily" | "weekly" | "cumulative"
type CalendarDay = {
  date: string
  tokens: number
  codium?: number
  tokensUnknown?: boolean
  tasks: number
  cost: number
  placeholder?: boolean
}
const number = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })
// Helpers such as autocomplete often cost less than a cent, which two decimals would show as free.
const smallMoney = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 })

const modelLabel = (modelID: string) =>
  modelID
    .split("/")
    .at(-1)
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? modelID

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

const duration = (milliseconds: number) => {
  if (!milliseconds) return "0m"
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.max(1, Math.round((milliseconds % 3_600_000) / 60_000))
  if (!hours) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

const calendar = (summary: DisplayUsageSummary, view: UsageView) => {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const start = addDays(today, -364)
  const byDate = new Map(summary.days.map((day) => [day.date, day]))
  const days: CalendarDay[] = Array.from({ length: 365 }, (_, index) => {
    const date = localDateKey(addDays(start, index))
    const usage = byDate.get(date)
    return {
      date,
      tokens: usage?.tokens ?? 0,
      codium: usage?.codium ?? 0,
      tokensUnknown: summary.legacyCodium && !!usage,
      tasks: usage?.tasks ?? 0,
      cost: usage?.cost ?? 0,
    }
  })

  if (view === "daily") return days
  if (view === "cumulative") {
    const total = { tokens: 0, codium: 0, tokensUnknown: false }
    return days.map((day) => ({
      ...day,
      tokens: (total.tokens += day.tokens),
      codium: (total.codium += day.codium ?? 0),
      tokensUnknown: (total.tokensUnknown ||= !!day.tokensUnknown),
    }))
  }

  const weeks = new Map<string, { tokens: number; codium: number; tokensUnknown: boolean }>()
  days.forEach((day) => {
    const date = new Date(`${day.date}T12:00:00`)
    const week = localDateKey(addDays(date, -date.getDay()))
    const previous = weeks.get(week)
    weeks.set(week, {
      tokens: (previous?.tokens ?? 0) + day.tokens,
      codium: (previous?.codium ?? 0) + (day.codium ?? 0),
      tokensUnknown: !!previous?.tokensUnknown || !!day.tokensUnknown,
    })
  })
  return days.map((day) => {
    const date = new Date(`${day.date}T12:00:00`)
    const week = weeks.get(localDateKey(addDays(date, -date.getDay())))
    return { ...day, tokens: week?.tokens ?? 0, codium: week?.codium ?? 0, tokensUnknown: week?.tokensUnknown }
  })
}

const paddedCalendar = (days: CalendarDay[]) => {
  const first = new Date(`${days[0]?.date}T12:00:00`).getDay()
  const leading = Array.from(
    { length: first },
    (_, index): CalendarDay => ({
      date: `leading-${index}`,
      tokens: 0,
      tasks: 0,
      cost: 0,
      placeholder: true,
    }),
  )
  const result = [...leading, ...days]
  const trailing = (7 - (result.length % 7)) % 7
  return [
    ...result,
    ...Array.from(
      { length: trailing },
      (_, index): CalendarDay => ({
        date: `trailing-${index}`,
        tokens: 0,
        tasks: 0,
        cost: 0,
        placeholder: true,
      }),
    ),
  ]
}

const intensity = (tokens: number, peak: number) => {
  if (!tokens || !peak) return 0
  const ratio = tokens / peak
  if (ratio <= 0.08) return 1
  if (ratio <= 0.25) return 2
  if (ratio <= 0.5) return 3
  if (ratio <= 0.75) return 4
  return 5
}

export const SettingsUsageV2: Component = () => {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [view, setView] = createSignal<UsageView>("daily")
  // Immediate custom hover tooltip (the native `title` only appears after a ~1s delay
  // and can't be styled). Positioned with viewport coordinates from the square's rect.
  const [hovered, setHovered] = createSignal<{ day: CalendarDay; left: number; top: number }>()
  const tooltipWhen = (day: CalendarDay) => {
    const date = new Date(`${day.date}T12:00:00`)
    const formatted = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    if (view() === "weekly") return `Week of ${formatted}`
    if (view() === "cumulative") return `Through ${formatted}`
    return formatted
  }
  const [summary, { refetch }] = createResource(async () => {
    const response = await sdk().client.experimental.session.usage()
    if (response.data) return normalizeUsageSummary(response.data)
    throw new Error(formatServerError(response.error, undefined, "Vector could not load local usage data."))
  })
  const days = createMemo(() => paddedCalendar(calendar(normalizeUsageSummary(summary()), view())))
  const peak = createMemo(() => Math.max(0, ...days().map((day) => day.tokens)))

  return (
    <section class="settings-v2-page settings-usage-page">
      <div class="settings-v2-page-hero settings-usage-hero">
        <div>
          <p class="settings-v2-page-kicker">Local usage</p>
          <h2 class="settings-v2-page-title">Usage & streaks</h2>
          <p class="settings-v2-page-subtitle">
            Tokens and cost cover models you use with your own keys, plus free and local models. Work on Vector Codium
            models shows as Codium; your plan's usage is the percentage above.
          </p>
        </div>
        <ButtonV2 variant="neutral" icon="reset" onClick={() => void refetch()} disabled={summary.loading}>
          Refresh
        </ButtonV2>
      </div>

      <SettingsVectorCodium
        summary={summary.state === "ready" || summary.state === "refreshing" ? summary.latest : undefined}
      />
      <Show when={summary()?.legacyCodium}>
        <p class="text-12-regular text-text-weak">
          This server combines Codium and own token totals. Update the server to see separate own tokens and daily
          Codium activity. Recorded dollars still cover your own models.
        </p>
      </Show>

      <Switch>
        <Match when={summary.loading}>
          <div class="settings-usage-state" role="status">
            Calculating local usage...
          </div>
        </Match>
        <Match when={summary.error}>
          <div class="settings-usage-state settings-usage-state--error" role="alert">
            <strong>Usage data is unavailable</strong>
            <span>{formatServerError(summary.error, undefined, "Vector could not load local usage data.")}</span>
          </div>
        </Match>
        <Match when={summary()} keyed>
          {(usage) => (
            <>
              <div class="settings-usage-metrics">
                <div>
                  <strong>
                    {CodiumUsage.withCodium(
                      usage.lifetimeTokens > 0 || !usage.codiumResponses
                        ? number.format(usage.lifetimeTokens)
                        : undefined,
                      usage.codiumResponses,
                    )}
                  </strong>
                  <span>Lifetime tokens</span>
                </div>
                <div>
                  <strong>{number.format(usage.completedChats)}</strong>
                  <span>Completed chats</span>
                </div>
                <div>
                  <strong>{number.format(usage.conversations)}</strong>
                  <span>Conversations</span>
                </div>
                <div>
                  <strong>{usage.currentStreak} days</strong>
                  <span>Current streak</span>
                </div>
                <div>
                  <strong>{usage.longestStreak} days</strong>
                  <span>Longest streak</span>
                </div>
                <div>
                  <strong>
                    {formatSessionCost({
                      cost: usage.lifetimeCost,
                      unpricedSteps: usage.unpricedResponses,
                      codiumSteps: usage.codiumResponses,
                      format: (value) => money.format(value),
                      t: language.t,
                    })}
                  </strong>
                  <span>Recorded cost</span>
                </div>
                <div>
                  <strong>{duration(usage.averageTaskMs)}</strong>
                  <span>Average time per run</span>
                </div>
                <div>
                  <strong>
                    {CodiumUsage.withCodium(
                      usage.lifetimeTokens > 0 || !usage.codiumResponses
                        ? number.format(usage.averageTokensPerChat)
                        : undefined,
                      usage.codiumResponses,
                    )}
                  </strong>
                  <span>Average own tokens per chat</span>
                </div>
              </div>

              <div class="settings-usage-card settings-usage-streak">
                <div class="settings-usage-streak-summary">
                  <div>
                    <div class="settings-usage-streak-label">
                      <span class="settings-usage-streak-flame" aria-hidden="true">
                        <svg viewBox="0 0 20 20">
                          <path
                            d="M11.7 2.4c.5 2.7-.8 3.7-2 5.1-.8.9-1.5 1.9-1.3 3.5-1.1-.7-1.7-1.9-1.6-3.3C4.9 9.2 4 11 4.2 13c.3 3 2.7 5 5.8 5s5.7-2.2 5.8-5.5c.1-3.4-2-6.8-4.1-10.1Z"
                            fill="currentColor"
                          />
                          <path
                            d="M10.5 10.3c.2 1.3-.6 1.8-1.1 2.5-.4.5-.6 1.1-.4 1.9-.7-.4-1.1-1.1-1.1-1.9-.8.7-1.1 1.6-1 2.5.2 1.6 1.5 2.6 3.1 2.6 1.8 0 3.2-1.2 3.2-3 0-1.7-1.2-3.4-2.7-4.6Z"
                            fill="rgba(255,255,255,.68)"
                          />
                        </svg>
                      </span>
                      <p>My daily streak</p>
                    </div>
                    <div class="settings-usage-streak-count">
                      <strong>{usage.currentStreak}</strong>
                      <span>day{usage.currentStreak === 1 ? "" : "s"}</span>
                    </div>
                    <span>
                      {usage.currentStreak > 0
                        ? "Keep building to extend your streak."
                        : "Complete a model run today to begin a streak."}
                    </span>
                  </div>
                  <div class="settings-usage-streak-best">
                    <span>Personal best</span>
                    <strong>
                      {usage.longestStreak} day{usage.longestStreak === 1 ? "" : "s"}
                    </strong>
                    <small>
                      {usage.activeDays} active day{usage.activeDays === 1 ? "" : "s"} recorded
                    </small>
                  </div>
                </div>
                <div class="settings-usage-streak-week" aria-label="Activity during the past seven days">
                  <For each={usageStreakCalendar(usage)}>
                    {(day) => (
                      <div
                        class="settings-usage-streak-day"
                        classList={{
                          "settings-usage-streak-day--active": day.active,
                          "settings-usage-streak-day--today": day.today,
                        }}
                        title={`${day.date}: ${usageTokens(day.tokens, day.codium, undefined, day.tokensUnknown)}`}
                        data-codium={day.codium ? "true" : undefined}
                      >
                        <span>{day.label}</span>
                        <i aria-hidden="true">{day.day}</i>
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <div class="settings-usage-insights">
                <div class="settings-usage-card settings-usage-ranking">
                  <div class="settings-usage-card-header">
                    <div>
                      <h3>Favorite models</h3>
                      <p>Own models ranked by token use</p>
                    </div>
                    <span>{number.format(usage.modelResponses)} responses</span>
                  </div>
                  <Show
                    when={usage.favoriteModels.length > 0 || (usage.codiumResponses ?? 0) > 0}
                    fallback={
                      <div class="settings-usage-empty settings-usage-empty--compact">No model activity yet.</div>
                    }
                  >
                    <div class="settings-usage-ranking-list">
                      <For each={usage.favoriteModels}>
                        {(model, index) => (
                          <div class="settings-usage-ranking-row">
                            <span class="settings-usage-rank">{index() + 1}</span>
                            <div class="settings-usage-ranking-copy">
                              <div>
                                <strong>{modelLabel(model.modelID)}</strong>
                                <span>{model.providerID}</span>
                              </div>
                              <Show when={!usage.legacyCodium}>
                                <div class="settings-usage-bar">
                                  <i style={{ width: `${Math.max(model.percentage, 2)}%` }} />
                                </div>
                              </Show>
                            </div>
                            <div class="settings-usage-ranking-value">
                              <Show when={!usage.legacyCodium}>
                                <strong>{model.percentage.toFixed(1)}%</strong>
                              </Show>
                              <span>{number.format(model.tokens)}</span>
                            </div>
                          </div>
                        )}
                      </For>
                      <Show when={(usage.codiumResponses ?? 0) > 0}>
                        <div class="settings-usage-ranking-row" data-slot="codium-model-activity">
                          <div class="settings-usage-ranking-copy">
                            <strong>Vector Codium</strong>
                            <span>Codium</span>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </div>

                <div class="settings-usage-card settings-usage-ranking">
                  <div class="settings-usage-card-header">
                    <div>
                      <h3>Effort profile</h3>
                      <p>
                        Favorite: <strong>{usage.effortLevels[0]?.label ?? "No data"}</strong>
                      </p>
                    </div>
                    <span>{number.format(usage.completedChats)} chats</span>
                  </div>
                  <Show
                    when={usage.effortLevels.length > 0}
                    fallback={
                      <div class="settings-usage-empty settings-usage-empty--compact">No effort activity yet.</div>
                    }
                  >
                    <div class="settings-usage-ranking-list">
                      <For each={usage.effortLevels}>
                        {(effort) => (
                          <div class="settings-usage-ranking-row settings-usage-ranking-row--effort">
                            <span class="settings-usage-effort-dot" data-effort={effort.id} />
                            <div class="settings-usage-ranking-copy">
                              <div>
                                <strong>{effort.label}</strong>
                                <span>{effort.responses} responses</span>
                              </div>
                              <div class="settings-usage-bar">
                                <i style={{ width: `${Math.max(effort.percentage, 2)}%` }} />
                              </div>
                            </div>
                            <div class="settings-usage-ranking-value">
                              <strong>{effort.percentage.toFixed(1)}%</strong>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>

              <Show when={helperUsage(usage.helpers).length > 0}>
                <div class="settings-usage-card settings-usage-ranking" data-component="settings-usage-helpers">
                  <div class="settings-usage-card-header">
                    <div>
                      <h3>Vector helpers</h3>
                      <p>
                        Work Vector ran under the hood, already counted in the totals above. A helper started from a
                        session also counts in that session's cost.
                      </p>
                    </div>
                  </div>
                  <div class="settings-usage-ranking-list">
                    <For each={helperUsage(usage.helpers)}>
                      {(helper) => (
                        <div class="settings-usage-ranking-row settings-usage-ranking-row--effort">
                          <span class="settings-usage-effort-dot" />
                          <div class="settings-usage-ranking-copy">
                            <div>
                              <strong>{helper.label}</strong>
                              <span>
                                {helper.sessions} run{helper.sessions === 1 ? "" : "s"} ·{" "}
                                {usageTokens(
                                  helper.tokens,
                                  helper.codiumSteps,
                                  (value) => number.format(value),
                                  usage.legacyCodium,
                                )}
                              </span>
                            </div>
                          </div>
                          <div class="settings-usage-ranking-value">
                            <strong>
                              {CodiumUsage.withCodium(
                                helper.cost > 0 || !helper.codiumSteps
                                  ? (helper.cost > 0 && helper.cost < 0.01 ? smallMoney : money).format(helper.cost)
                                  : undefined,
                                helper.codiumSteps,
                              )}
                            </strong>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div class="settings-usage-card">
                <div class="settings-usage-card-header">
                  <div>
                    <h3>Model activity</h3>
                    <p>
                      {usage.activeDays} active days ·{" "}
                      {usageTokens(usage.averageTokensPerChat, usage.codiumResponses, (value) => number.format(value))}
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses
                        ? " on average per own-model chat"
                        : " activity"}
                    </p>
                  </div>
                  <div class="settings-usage-view" role="tablist" aria-label="Usage aggregation">
                    <For each={["daily", "weekly", "cumulative"] as UsageView[]}>
                      {(item) => (
                        <button
                          type="button"
                          role="tab"
                          aria-selected={view() === item}
                          classList={{ active: view() === item }}
                          onClick={() => setView(item)}
                        >
                          {item[0].toUpperCase() + item.slice(1)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <Show
                  when={usage.days.length > 0}
                  fallback={
                    <div class="settings-usage-empty">
                      Use Vector for a model task and the first activity square will appear here.
                    </div>
                  }
                >
                  <div class="settings-usage-calendar" style={{ "--usage-columns": `${Math.ceil(days().length / 7)}` }}>
                    <For each={days()}>
                      {(day) => (
                        <div
                          class="settings-usage-day"
                          classList={{ "settings-usage-day--placeholder": !!day.placeholder }}
                          data-level={
                            (day.codium || (day.tokensUnknown && day.tasks)) && !day.tokens
                              ? 1
                              : intensity(day.tokens, peak())
                          }
                          data-codium={day.codium ? "true" : undefined}
                          style={
                            day.codium && !day.tokens
                              ? { outline: "1px solid var(--text-interactive-base)", "outline-offset": "-1px" }
                              : undefined
                          }
                          aria-label={
                            day.placeholder
                              ? undefined
                              : `${day.date}, ${usageTokens(day.tokens, day.codium, undefined, day.tokensUnknown)}, ${day.tasks} runs`
                          }
                          onMouseEnter={(event) => {
                            if (day.placeholder) return
                            const rect = event.currentTarget.getBoundingClientRect()
                            setHovered({ day, left: rect.left + rect.width / 2, top: rect.top })
                          }}
                          onMouseLeave={() => setHovered(undefined)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={(usage.codiumResponses ?? 0) > 0}>
                  <p class="text-12-regular text-text-weak">
                    + Codium work. Token breakdown below covers own, free and local models only.
                  </p>
                </Show>
                <div class="settings-usage-breakdown">
                  <div>
                    <span>Input</span>
                    <strong>
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses ? number.format(usage.inputTokens) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Output</span>
                    <strong>
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses ? number.format(usage.outputTokens) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Reasoning</span>
                    <strong>
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses ? number.format(usage.reasoningTokens) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Cache</span>
                    <strong>
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses ? number.format(usage.cachedTokens) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Peak day</span>
                    <strong>
                      {usage.lifetimeTokens > 0 || !usage.codiumResponses ? number.format(usage.peakTokens) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Longest run</span>
                    <strong>{duration(usage.longestTaskMs)}</strong>
                  </div>
                </div>
              </div>
            </>
          )}
        </Match>
      </Switch>

      <Show when={hovered()}>
        {(active) => (
          <div
            class="settings-usage-tooltip"
            style={{ left: `${active().left}px`, top: `${active().top}px` }}
            role="tooltip"
          >
            <strong>
              {usageTokens(active().day.tokens, active().day.codium, undefined, active().day.tokensUnknown)}
            </strong>
            <span>
              {tooltipWhen(active().day)}
              <Show when={view() === "daily"}>
                {" · "}
                {active().day.tasks} task{active().day.tasks === 1 ? "" : "s"}
              </Show>
            </span>
          </div>
        )}
      </Show>
    </section>
  )
}
