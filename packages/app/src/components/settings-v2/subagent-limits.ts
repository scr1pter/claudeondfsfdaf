import type { Config } from "@vectordevai/sdk/v2/client"

/*
 * Settings → Agents → Limits (5.B.11): how many subagents run at once in a conversation, how many one request may
 * start, and the spend ceiling they share. They are `budget.subagents.running`, `per_request` and `usd` in the
 * engine's global config. Saving reloads the engine, so the page asks first while work is running. The global config
 * update deep-merges and JSON cannot carry `undefined`, so Reset writes the explicit defaults rather than removing the
 * keys, the same way the agent switches write `disable: false`.
 */

/** The engine's defaults (`SubagentDefaults` in packages/core/src/v1/config/config.ts). */
export const SUBAGENT_LIMIT_DEFAULTS = { running: 8, perRequest: 32, usd: 25 } as const

/** The ranges the config schema accepts. USD has no upper bound but must be above 0. */
export const SUBAGENT_LIMIT_RANGES = {
  running: { min: 1, max: 16 },
  perRequest: { min: 1, max: 1000 },
} as const

export type SubagentLimits = { running: number; perRequest: number; usd: number }
export type SubagentLimitKey = keyof SubagentLimits

export const SUBAGENT_LIMIT_FIELDS: readonly {
  key: SubagentLimitKey
  label: string
  description: string
  placeholder: string
}[] = [
  {
    key: "running",
    label: "At once",
    description: "Subagents that run at the same time in one conversation, from 1 to 16. More wait for a free slot.",
    placeholder: String(SUBAGENT_LIMIT_DEFAULTS.running),
  },
  {
    key: "perRequest",
    label: "Per request",
    description: "New subagents one request may start, at any depth, from 1 to 1000.",
    placeholder: String(SUBAGENT_LIMIT_DEFAULTS.perRequest),
  },
  {
    key: "usd",
    label: "Spend ceiling (USD)",
    description:
      "What one request's subagents may spend together, at catalog prices. Free, plan and local models are bounded only by the counts.",
    placeholder: String(SUBAGENT_LIMIT_DEFAULTS.usd),
  },
]

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/** The saved limits, each falling back to its default when the config does not set it. */
export function readSubagentLimits(config: Pick<Config, "budget"> | undefined): SubagentLimits {
  const saved = config?.budget?.subagents
  return {
    running: positive(saved?.running) ?? SUBAGENT_LIMIT_DEFAULTS.running,
    perRequest: positive(saved?.per_request) ?? SUBAGENT_LIMIT_DEFAULTS.perRequest,
    usd: positive(saved?.usd) ?? SUBAGENT_LIMIT_DEFAULTS.usd,
  }
}

/**
 * One field's text as a value. A blank field keeps the default. Counts are whole numbers in their range; the
 * ceiling is a dollar amount above 0.
 */
export function parseSubagentLimit(
  key: SubagentLimitKey,
  input: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = key === "usd" ? input.replace(/[$,\s]/g, "") : input.replace(/[,\s]/g, "")
  if (!trimmed) return { ok: true, value: SUBAGENT_LIMIT_DEFAULTS[key] }
  const value = Number(trimmed)
  if (key === "usd") {
    if (!Number.isFinite(value) || value <= 0) return { ok: false, message: "Enter a dollar amount above 0." }
    return { ok: true, value }
  }
  const range = SUBAGENT_LIMIT_RANGES[key]
  if (!Number.isInteger(value) || value < range.min || value > range.max)
    return { ok: false, message: `Enter a whole number from ${range.min} to ${range.max}.` }
  return { ok: true, value }
}

/** Every field's text as limits, or the first field that is not valid. */
export function parseSubagentLimits(
  input: Readonly<Record<SubagentLimitKey, string>>,
): { ok: true; limits: SubagentLimits } | { ok: false; key: SubagentLimitKey; message: string } {
  const limits = { ...SUBAGENT_LIMIT_DEFAULTS } as SubagentLimits
  for (const field of SUBAGENT_LIMIT_FIELDS) {
    const parsed = parseSubagentLimit(field.key, input[field.key] ?? "")
    if (!parsed.ok) return { ok: false, key: field.key, message: parsed.message }
    limits[field.key] = parsed.value
  }
  return { ok: true, limits }
}

/** The global config update for these limits: `{budget: {subagents: {running, per_request, usd}}}`, nothing else. */
export function subagentLimitsPatch(limits: SubagentLimits): Config {
  return { budget: { subagents: { running: limits.running, per_request: limits.perRequest, usd: limits.usd } } }
}

/** Reset: the explicit defaults (8, 32, 25), since a deep-merged update cannot remove a key. */
export function subagentLimitsResetPatch(): Config {
  return subagentLimitsPatch({ ...SUBAGENT_LIMIT_DEFAULTS })
}

/**
 * Whether saving these limits would change what the engine runs with. Saving reloads the engine, which stops running
 * work, so a save that changes nothing is skipped.
 */
export function subagentLimitsChanged(config: Pick<Config, "budget"> | undefined, limits: SubagentLimits) {
  const saved = readSubagentLimits(config)
  return saved.running !== limits.running || saved.perRequest !== limits.perRequest || saved.usd !== limits.usd
}

/**
 * "How many" on the page: the configured values, read from config, never hardcoded (5.I.4).
 */
export function howManyFact(limits: SubagentLimits) {
  return `Up to ${limits.running} at once in a conversation and ${limits.perRequest} new ones per request; more wait for a free slot. One request's subagents share a $${limits.usd.toFixed(2)} spend ceiling at catalog prices. When more than six are running or waiting, Vector tells you how many.`
}

/**
 * Whether the page's reader is the server's owner. Only the owner may change the global config, and an invited
 * guest is refused the owner-only routes with 401 or 403 before any handler runs. Any other answer, an error status
 * included, came from the owner's side of that gate.
 */
export function ownerFromStatus(status: number | undefined) {
  if (status === undefined) return undefined
  return status !== 401 && status !== 403
}
