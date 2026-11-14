export * as WorkflowLimits from "./limits"

import type { WorkflowSpec } from "./spec"

export const DEFAULTS = { max_agents: 100, concurrency: 16, per_agent_steps: 60, minutes: 120, runs: 1 } as const
export type Configured = WorkflowSpec.Limits & { readonly runs?: number }
export type Resolved = {
  readonly maxAgents: number
  readonly concurrency: number
  readonly usd?: number
  readonly tokens?: number
  readonly steps: number
  readonly perAgentUsd?: number
  readonly perAgentSteps: number
  readonly minutes: number
  readonly runs: number
}
export type Usage = {
  readonly launched: number
  readonly steps: number
  readonly tokens: number
  readonly spentUsd: number
  readonly elapsedMs: number
  readonly delegatedStopped?: boolean
  readonly ledgerStopped?: boolean
  readonly waitingMs?: number
}
export type Stop = {
  readonly reason: "agents" | "steps" | "tokens" | "usd" | "minutes" | "delegated" | "ledger"
  readonly message: string
  readonly abort: boolean
}

export function resolve(requested: WorkflowSpec.Limits = {}, configured: Configured = {}, cpus = 1): Resolved {
  const maxAgents = Math.min(
    requested.max_agents ?? configured.max_agents ?? DEFAULTS.max_agents,
    configured.max_agents ?? DEFAULTS.max_agents,
    1000,
  )
  const result: Resolved = {
    maxAgents,
    concurrency: Math.min(
      requested.concurrency ?? configured.concurrency ?? DEFAULTS.concurrency,
      configured.concurrency ?? DEFAULTS.concurrency,
      16,
      Math.max(1, Math.floor(cpus) - 2),
    ),
    usd: requested.usd ?? configured.usd,
    tokens: requested.tokens ?? configured.tokens,
    steps: requested.steps ?? configured.steps ?? maxAgents * 40,
    perAgentUsd: requested.per_agent_usd ?? configured.per_agent_usd,
    perAgentSteps: requested.per_agent_steps ?? configured.per_agent_steps ?? DEFAULTS.per_agent_steps,
    minutes: requested.minutes ?? configured.minutes ?? DEFAULTS.minutes,
    runs: configured.runs ?? DEFAULTS.runs,
  }
  for (const [key, value] of Object.entries(result))
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value <= 0 || (!["usd", "perAgentUsd"].includes(key) && !Number.isSafeInteger(value)))
    )
      throw new Error(`Invalid workflow limit: ${key}.`)
  if (result.minutes > 1440 || result.runs > 4 || result.concurrency > 16)
    throw new Error("Workflow limit is above its supported maximum.")
  return result
}

export function exceeds(requested: WorkflowSpec.Limits, configured: Configured = {}): boolean {
  const defaults = resolve({}, configured, 18)
  return (
    (requested.max_agents ?? 0) > defaults.maxAgents ||
    (requested.concurrency ?? 0) > defaults.concurrency ||
    (requested.steps ?? 0) > defaults.steps ||
    (requested.per_agent_steps ?? 0) > defaults.perAgentSteps ||
    (requested.minutes ?? 0) > defaults.minutes ||
    (defaults.usd !== undefined && (requested.usd ?? 0) > defaults.usd) ||
    (defaults.tokens !== undefined && (requested.tokens ?? 0) > defaults.tokens) ||
    (defaults.perAgentUsd !== undefined && (requested.per_agent_usd ?? 0) > defaults.perAgentUsd)
  )
}

export function check(limits: Resolved, usage: Usage): Stop | undefined {
  for (const [key, value] of Object.entries(usage))
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
      throw new Error(`Invalid workflow usage: ${key}.`)
  if (usage.delegatedStopped)
    return { reason: "delegated", message: "The shared subagent budget stopped this workflow.", abort: false }
  if (usage.ledgerStopped) return { reason: "ledger", message: "The workflow budget is used up.", abort: false }
  if (usage.elapsedMs >= limits.minutes * 60_000)
    return { reason: "minutes", message: "The workflow reached its time limit.", abort: true }
  if (limits.tokens !== undefined && usage.tokens >= limits.tokens)
    return { reason: "tokens", message: "The workflow reached its token limit.", abort: true }
  if (usage.launched >= limits.maxAgents)
    return { reason: "agents", message: "The workflow reached its agent limit.", abort: false }
  if (usage.steps >= limits.steps)
    return { reason: "steps", message: "The workflow reached its step limit.", abort: false }
  if (limits.usd !== undefined && usage.spentUsd >= limits.usd)
    return { reason: "usd", message: "The workflow reached its spend limit.", abort: false }
}

export function paused(usage: Usage) {
  return (usage.waitingMs ?? 0) >= 60_000
}
