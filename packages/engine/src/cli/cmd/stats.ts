import { Billing } from "@vectordevai/schema/billing"
import { CodiumUsage } from "@vectordevai/core/codium-usage"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { Database } from "@vectordevai/core/database/database"
import { SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { and, eq, gte } from "drizzle-orm"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"

interface SessionStats {
  totalSessions: number
  totalMessages: number
  codiumResponses: number
  ownResponses: number
  totalCost: number
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
  // What Vector's hidden helpers (a Vectorscope review, autocomplete) spent. It is part of the cost and token totals
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

  let filteredSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    codiumResponses: 0,
    ownResponses: 0,
    totalCost: 0,
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
                    tokens: data.tokens,
                    billing,
                    model: data.model ? `${data.model.providerID}/${data.model.id}` : undefined,
                  },
                ]
              })
            : []
        const steps = [...v1Steps, ...v2Steps]
        const own = steps.filter((step) => !step.billing)
        const codiumResponses =
          cutoffTime > 0 ? steps.length - own.length : Math.max(steps.length - own.length, session.codiumSteps ?? 0)
        const legacy = steps.length - own.length > (session.codiumSteps ?? 0)
        const sessionCost =
          cutoffTime > 0 || legacy ? own.reduce((sum, step) => sum + (step.cost || 0), 0) : (session.cost ?? 0)
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
            : (session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
        const sessionToolUsage: Record<string, number> = {}
        const sessionModelUsage: SessionStats["modelUsage"] = {}
        for (const step of steps) {
          if (!step.model) continue
          const usage = (sessionModelUsage[step.model] ??= {
            messages: 0,
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            ...(step.billing ? { billing: step.billing } : {}),
          })
          usage.messages++
          if (step.billing) continue
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
          // Updates such as a share or a rename also bump a session, so a window counts only sessions with messages in it.
          active: cutoffTime === 0 || messages.length > 0 || v2Steps.length > 0,
          helper: session.internal !== undefined,
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
    if (result.helper) {
      stats.helpers.cost += result.sessionCost
      stats.helpers.tokens += result.sessionTotalTokens
      stats.helpers.codiumResponses += result.codiumResponses
    }
    // A helper's replies are Vector's own, not messages in the user's sessions.
    if (!result.helper) {
      if (result.sessionTotalTokens > 0 || result.codiumResponses === 0)
        sessionTotalTokens.push(result.sessionTotalTokens)
      stats.totalMessages += result.messageCount
    }

    stats.codiumResponses += result.codiumResponses
    stats.ownResponses += result.ownResponses
    stats.totalCost += result.sessionCost
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
  const codiumOnly = stats.codiumResponses > 0 && stats.ownResponses === 0 && !ownTokens && !cost
  console.log(
    renderRow(
      "Total Cost",
      CodiumUsage.withCodium(cost || !codiumOnly ? `$${cost.toFixed(2)}` : undefined, stats.codiumResponses),
    ),
  )
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
  console.log(renderRow("Avg Cost/Day", codiumOnly && !costPerDay ? Billing.LABEL : `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Tokens/Session", codiumOnly ? Billing.LABEL : formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(
    renderRow("Median Tokens/Session", codiumOnly ? Billing.LABEL : formatNumber(Math.round(medianTokensPerSession))),
  )
  console.log(renderRow("Input", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Output", codiumOnly ? Billing.LABEL : formatNumber(stats.totalTokens.output)))
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
      console.log(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
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
