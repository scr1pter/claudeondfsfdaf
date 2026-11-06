import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { DateTime, Effect, Schema } from "effect"
import { effectCmd } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@vectordevai/core/database/database"
import { SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { EventTable } from "@vectordevai/core/event/sql"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { and, eq, gte, inArray } from "drizzle-orm"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"

interface SessionStats {
  totalSessions: number
  totalMessages: number
  codiumResponses: number
  ownResponses: number
  totalCost: number
  unpricedSteps: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
      billing?: "codium"
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
  // What Vector's hidden helpers (reviews, autocomplete, titles and memory learning) spent. It is part of the totals
  // above, but the helpers are not sessions of the user's, so they are left out of the session and message counts and
  // the per-session figures.
  helpers: { cost: number; tokens: number; codiumResponses: number }
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by repository (default: all repositories, empty string: current repository)",
        type: "string",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project)
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }
    displayStats(stats, args.tools, modelLimit)
  }),
})

const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row))
})

export const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
) {
  const svc = yield* Session.Service
  const { db } = yield* Database.Service
  const sessions = yield* getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions = sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }
  const selected = new Set(filteredSessions.map((session) => session.id))
  filteredSessions =
    cutoffTime > 0 ? filteredSessions.filter((session) => session.time.updated >= cutoffTime) : filteredSessions

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    codiumResponses: 0,
    ownResponses: 0,
    totalCost: 0,
    unpricedSteps: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
    helpers: { cost: 0, tokens: 0, codiumResponses: 0 },
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []
  const ancillaryRows = (yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .innerJoin(SessionTable, eq(EventTable.aggregate_id, SessionTable.id))
    .where(
      and(
        inArray(EventTable.type, SessionEvent.AncillaryUsageStored),
        projectFilter === undefined ? undefined : eq(SessionTable.project_id, filteredSessions[0].projectID),
      ),
    )
    .all()
    .pipe(Effect.orDie))
    .map((event) => Schema.decodeUnknownSync(SessionEvent.AncillaryUsage.data)(event.data))
    .filter((usage) => selected.has(usage.sessionID))
  // Local archive imports preserve the identity of the paid attempt while remapping sessions/event IDs.
  // Conflicting copies have no reliable amount or date, so retain one unknown request instead of choosing a copy.
  const attempts = new Map<string, (typeof ancillaryRows)[number] | undefined>()
  const receiptsBySession = new Map<string, typeof ancillaryRows>()
  const inWindow = new Set<string>()
  const same = Schema.toEquivalence(SessionEvent.AncillaryUsage.data)
  for (const usage of ancillaryRows) {
    const receipts = receiptsBySession.get(usage.sessionID) ?? []
    receipts.push(usage)
    receiptsBySession.set(usage.sessionID, receipts)
    if (DateTime.toEpochMillis(usage.timestamp) >= cutoffTime) inWindow.add(usage.usageID)
    if (!attempts.has(usage.usageID)) {
      attempts.set(usage.usageID, usage)
      continue
    }
    const previous = attempts.get(usage.usageID)
    if (previous && !same(previous, { ...usage, sessionID: previous.sessionID })) attempts.set(usage.usageID, undefined)
  }
  const ancillary = [...attempts.values()].filter(
    (usage): usage is (typeof ancillaryRows)[number] =>
      usage !== undefined && DateTime.toEpochMillis(usage.timestamp) >= cutoffTime,
  )
  const uncertain = (usage: (typeof ancillaryRows)[number]) =>
    !!usage.unpriced || !!usage.incomplete || usage.cost === undefined || usage.tokens === undefined

  const results = yield* Effect.forEach(
    filteredSessions,
    (session) =>
      Effect.gen(function* () {
        const all = yield* svc
          .messages({ sessionID: session.id })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
        // A session updated inside the window may have started long before it, so a window counts only the messages
        // created inside it. History a fork copied in was counted in the session it came from.
        const messages = all.filter(
          (message) =>
            message.info.time.created >= cutoffTime && !(message.info.role === "assistant" && message.info.forked),
        )
        const v1Steps = messages.flatMap((message) =>
          message.info.role === "assistant"
            ? [
                {
                  cost: message.info.cost,
                  tokens: message.info.tokens,
                  unpriced: !!message.info.unpriced,
                  billing: Billing.of(message.info),
                  model: `${message.info.providerID}/${message.info.modelID}`,
                },
              ]
            : [],
        )
        // V2 rows keep raw context tokens too. Read their identity before deriving any printed statistic.
        const v2Steps =
          all.length === 0
            ? (yield* db
                .select()
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, session.id),
                    gte(SessionMessageTable.time_created, cutoffTime),
                  ),
                )
                .all()
                .pipe(Effect.orDie)).flatMap((row) => {
                const data = row.data as {
                  cost?: number
                  tokens?: (typeof v1Steps)[number]["tokens"]
                  unpriced?: boolean
                  billing?: string
                  model?: { providerID: string; id: string }
                }
                if ((row.type !== "assistant" && row.type !== "compaction") || !data.tokens) return []
                const billing =
                  Billing.of(data) ||
                  (!data.model && session.codiumSteps === undefined && Billing.of(session)) ||
                  undefined
                return [
                  {
                    cost: data.cost ?? 0,
                    storedBilling: data.billing === "codium",
                    tokens: data.tokens,
                    unpriced: !!data.unpriced,
                    billing,
                    model: data.model ? `${data.model.providerID}/${data.model.id}` : undefined,
                  },
                ]
              })
            : []
        const steps = [...v1Steps, ...v2Steps]
        // A helper request on Vector Codium added one Codium step to the session's counters and no cost or tokens: the
        // other receipts come back out of its cost and tokens, the Codium ones out of its Codium steps.
        const sessionReceipts = receiptsBySession.get(session.id) ?? []
        const receipts = sessionReceipts.filter((usage) => !Billing.of(usage))
        const recordedCodium = Math.max(0, (session.codiumSteps ?? 0) - (sessionReceipts.length - receipts.length))
        const own = steps.filter(
          (step) => !step.billing && Billing.hasOwnIdentity({ providerID: step.model?.split("/")[0] }),
        )
        const observedCodium = steps.filter((step) => Boolean(step.billing)).length
        const codiumResponses = cutoffTime > 0 ? observedCodium : Math.max(observedCodium, recordedCodium)
        const legacy = session.tokensOwnOnly !== true || observedCodium > recordedCodium
        const legacyCodiumCost =
          messages.reduce(
            (sum, message) =>
              sum +
              (message.info.role === "assistant" && Billing.of(message.info)
                ? message.parts.reduce(
                    (total, part) => total + (part.type === "step-finish" && part.billing !== "codium" ? part.cost : 0),
                    0,
                  )
                : 0),
            0,
          ) + v2Steps.reduce((sum, step) => sum + (step.billing && !step.storedBilling ? step.cost : 0), 0)
        const ownCost = own.reduce((sum, step) => sum + (step.cost || 0), 0)
        // Remove every projected ancillary receipt from lifetime counters before adding the deduplicated attempts
        // globally. Transcript/archive duplication outside ancillary usage is not changed by this calculation.
        const sessionCost =
          cutoffTime > 0
            ? ownCost
            : Math.max(
                0,
                (session.cost ?? 0) - legacyCodiumCost - receipts.reduce((sum, usage) => sum + (usage.cost ?? 0), 0),
                ownCost,
              )
        const lifetimeTokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        const sessionTokens =
          cutoffTime > 0 || legacy
            ? {
                input: own.reduce((sum, step) => sum + (step.tokens.input || 0), 0),
                output: own.reduce((sum, step) => sum + (step.tokens.output || 0), 0),
                reasoning: own.reduce((sum, step) => sum + (step.tokens.reasoning || 0), 0),
                cache: {
                  read: own.reduce((sum, step) => sum + (step.tokens.cache?.read || 0), 0),
                  write: own.reduce((sum, step) => sum + (step.tokens.cache?.write || 0), 0),
                },
              }
            : {
                input: Math.max(
                  0,
                  lifetimeTokens.input - receipts.reduce((sum, usage) => sum + (usage.tokens?.input ?? 0), 0),
                ),
                output: Math.max(
                  0,
                  lifetimeTokens.output - receipts.reduce((sum, usage) => sum + (usage.tokens?.output ?? 0), 0),
                ),
                reasoning: Math.max(
                  0,
                  lifetimeTokens.reasoning - receipts.reduce((sum, usage) => sum + (usage.tokens?.reasoning ?? 0), 0),
                ),
                cache: {
                  read: Math.max(
                    0,
                    lifetimeTokens.cache.read -
                      receipts.reduce((sum, usage) => sum + (usage.tokens?.cache.read ?? 0), 0),
                  ),
                  write: Math.max(
                    0,
                    lifetimeTokens.cache.write -
                      receipts.reduce((sum, usage) => sum + (usage.tokens?.cache.write ?? 0), 0),
                  ),
                },
              }
        const sessionToolUsage: Record<string, number> = {}
        const sessionModelUsage: SessionStats["modelUsage"] = {}
        for (const step of steps) {
          if (!step.model || (!step.billing && !Billing.hasOwnIdentity({ providerID: step.model.split("/")[0] })))
            continue
          const usage = (sessionModelUsage[step.model] ??= {
            messages: 0,
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            ...(step.billing ? { billing: step.billing } : {}),
          })
          usage.messages++
          if (step.billing || !Billing.hasOwnIdentity({ providerID: step.model.split("/")[0] })) continue
          usage.cost += step.cost || 0
          usage.tokens.input += step.tokens.input || 0
          usage.tokens.output += (step.tokens.output || 0) + (step.tokens.reasoning || 0)
          usage.tokens.cache.read += step.tokens.cache?.read || 0
          usage.tokens.cache.write += step.tokens.cache?.write || 0
        }
        for (const message of messages) {
          for (const part of message.parts) {
            if (part.type === "tool" && part.tool) sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
          }
        }

        return {
          active: cutoffTime === 0 || messages.length > 0 || v2Steps.length > 0,
          helper: session.internal !== undefined,
          // A Codium step is billed to the plan, not of unknown price: the session's unpriced steps include its Codium
          // steps, which are shown as Codium instead.
          unpricedSteps:
            cutoffTime > 0
              ? steps.filter((step) => step.unpriced && !step.billing).length
              : Math.max(
                  0,
                  CodiumUsage.ownUnpricedSteps(session.unpricedSteps, session.codiumSteps) -
                    receipts.filter(uncertain).length,
                ),
          messageCount: messages.length + v2Steps.length,
          codiumResponses,
          ownResponses: own.length,
          sessionCost,
          sessionTokens,
          sessionTotalTokens:
            sessionTokens.input +
            sessionTokens.output +
            sessionTokens.reasoning +
            sessionTokens.cache.read +
            sessionTokens.cache.write,
          sessionToolUsage,
          sessionModelUsage,
          earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
          latestTime: session.time.updated,
        }
      }),
    { concurrency: 20 },
  )

  const active = results.filter((result) => result.active)
  const sessionCount = active.filter((result) => !result.helper).length
  stats.totalSessions = sessionCount
  for (const result of active) {
    earliestTime = Math.min(earliestTime, result.earliestTime)
    latestTime = Math.max(latestTime, result.latestTime)
    stats.helpers.cost += result.helper ? result.sessionCost : 0
    stats.helpers.tokens += result.helper ? result.sessionTotalTokens : 0
    stats.helpers.codiumResponses += result.helper ? result.codiumResponses : 0
    // A helper's replies are Vector's own, not messages in the user's sessions.
    if (!result.helper) {
      if (result.sessionTotalTokens > 0 || result.codiumResponses === 0)
        sessionTotalTokens.push(result.sessionTotalTokens)
      stats.totalMessages += result.messageCount
    }

    stats.codiumResponses += result.codiumResponses
    stats.ownResponses += result.ownResponses
    stats.totalCost += result.sessionCost
    stats.unpricedSteps += result.unpricedSteps
    stats.totalTokens.input += result.sessionTokens.input
    stats.totalTokens.output += result.sessionTokens.output
    stats.totalTokens.reasoning += result.sessionTokens.reasoning
    stats.totalTokens.cache.read += result.sessionTokens.cache.read
    stats.totalTokens.cache.write += result.sessionTokens.cache.write

    for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
      stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
    }

    for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
      if (!stats.modelUsage[model]) {
        stats.modelUsage[model] = {
          messages: 0,
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
      }
      if (usage.billing) stats.modelUsage[model].billing = usage.billing
      stats.modelUsage[model].messages += usage.messages
      stats.modelUsage[model].tokens.input += usage.tokens.input
      stats.modelUsage[model].tokens.output += usage.tokens.output
      stats.modelUsage[model].tokens.cache.read += usage.tokens.cache.read
      stats.modelUsage[model].tokens.cache.write += usage.tokens.cache.write
      stats.modelUsage[model].cost += usage.cost
    }
  }

  stats.unpricedSteps += [...attempts].filter(([id, usage]) => !usage && inWindow.has(id)).length
  for (const usage of ancillary) {
    // A helper request on Vector Codium is billed to the plan: one Codium response of Vector's helpers, never tokens,
    // dollars or an unknown cost.
    if (Billing.of(usage)) {
      const plan = (stats.modelUsage[`${usage.model.providerID}/${usage.model.id}`] ??= {
        messages: 0,
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      })
      plan.messages++
      plan.billing = "codium"
      stats.codiumResponses++
      stats.helpers.codiumResponses++
      const when = DateTime.toEpochMillis(usage.timestamp)
      earliestTime = Math.min(earliestTime, when)
      latestTime = Math.max(latestTime, when)
      continue
    }
    const cost = usage.cost ?? 0
    const tokens = usage.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    stats.totalCost += cost
    stats.helpers.cost += cost
    stats.unpricedSteps += Number(uncertain(usage))
    stats.totalTokens.input += tokens.input
    stats.totalTokens.output += tokens.output
    stats.totalTokens.reasoning += tokens.reasoning
    stats.totalTokens.cache.read += tokens.cache.read
    stats.totalTokens.cache.write += tokens.cache.write
    stats.helpers.tokens += tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const modelKey = `${usage.model.providerID}/${usage.model.id}`
    const current = stats.modelUsage[modelKey] ?? {
      messages: 0,
      tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }
    current.messages++
    current.cost += cost
    current.tokens.input += tokens.input
    current.tokens.output += tokens.output + tokens.reasoning
    current.tokens.cache.read += tokens.cache.read
    current.tokens.cache.write += tokens.cache.write
    stats.modelUsage[modelKey] = current
    const at = DateTime.toEpochMillis(usage.timestamp)
    earliestTime = Math.min(earliestTime, at)
    latestTime = Math.max(latestTime, at)
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  // The average and the median both cover the user's sessions only; what the helpers used is in stats.helpers.
  stats.tokensPerSession =
    sessionTotalTokens.length > 0
      ? sessionTotalTokens.reduce((sum, tokens) => sum + tokens, 0) / sessionTotalTokens.length
      : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

export function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                       OVERVIEW                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Days", stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    COST & TOKENS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  const ownTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  // Only Codium work: no own response, tokens, dollars or unknown cost to show, so Codium stands in for them.
  const codiumOnly =
    stats.codiumResponses > 0 && stats.ownResponses === 0 && !ownTokens && !cost && !(stats.unpricedSteps > 0)
  console.log(
    renderRow(
      "Recorded Cost",
      CodiumUsage.withCodium(
        cost || !codiumOnly ? `$${cost.toFixed(2)}${stats.unpricedSteps > 0 ? " + unknown" : ""}` : undefined,
        stats.codiumResponses,
      ),
    ),
  )
  if (stats.unpricedSteps > 0)
    console.log(renderRow("Unpriced/incomplete requests", stats.unpricedSteps.toLocaleString()))
  if (stats.helpers.cost > 0 || stats.helpers.tokens > 0 || stats.helpers.codiumResponses > 0)
    console.log(
      renderRow(
        "  of which Vector's helpers",
        CodiumUsage.withCodium(
          stats.helpers.cost || stats.helpers.tokens
            ? `$${stats.helpers.cost.toFixed(2)} · ${formatNumber(stats.helpers.tokens)} tokens`
            : undefined,
          stats.helpers.codiumResponses,
        ),
      ),
    )
  console.log(
    renderRow("Avg Recorded Cost/Day", codiumOnly && !costPerDay ? Billing.LABEL : `$${costPerDay.toFixed(2)}`),
  )
  console.log(renderRow("Avg Tokens/Session", codiumOnly ? Billing.LABEL : formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(
    renderRow("Median Tokens/Session", codiumOnly ? Billing.LABEL : formatNumber(Math.round(medianTokensPerSession))),
  )
  console.log(renderRow("Uncached Input", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Visible Output", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Reasoning", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.reasoning)))
  console.log(renderRow("Cache Read", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Write", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.cache.write)))
  if (stats.codiumResponses > 0 && !codiumOnly) console.log(renderRow("Other usage", "+ Codium"))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      MODEL USAGE                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      const label = usage.billing ? `Vector Codium · ${model.slice(model.indexOf("/") + 1)}` : model
      console.log(`│ ${label.padEnd(54)} │`)
      console.log(renderRow("  Messages", usage.messages.toLocaleString()))
      if (usage.billing) {
        console.log(renderRow("  Usage", Billing.LABEL))
        console.log("├────────────────────────────────────────────────────────┤")
        continue
      }
      console.log(renderRow("  Uncached Input", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output + Reasoning", formatNumber(usage.tokens.output)))
      console.log(renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  if (stats.codiumResponses > 0) console.log('Vector Codium usage: see "vector codium".')

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      TOOL USAGE                        │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
