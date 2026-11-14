import type { Config, PermissionActionConfig } from "@vectordevai/sdk/v2/client"

/*
 * Settings → Agents → Workflows (5.I.4, G.9): whether the agent may run declarative workflows, whether a plan within
 * your limits asks first, and the ceilings of one run. On or off is `permission.workflow: "deny"` (the engine also
 * reads `tools.workflow: false` as off); ask or allow is `permission.workflow`; the ceilings are `budget.workflow` in
 * the engine's global config. A plan past these ceilings, after web or MCP content, or started under the agent marker
 * asks every time whatever is chosen here (I15).
 *
 * The global config update deep-merges, so these patches only add or replace keys. A ceiling with a default is reset
 * by writing the default; one with no default (spend and tokens) cannot be removed through an update.
 */

/** The engine's defaults (`WorkflowDefaults` in packages/core/src/v1/config/config.ts). */
export const WORKFLOW_DEFAULTS = {
  max_agents: 100,
  concurrency: 16,
  steps_per_agent: 40,
  per_agent_steps: 60,
  minutes: 120,
  runs: 1,
} as const

export type CeilingKey =
  | "max_agents"
  | "concurrency"
  | "steps"
  | "per_agent_steps"
  | "minutes"
  | "runs"
  | "usd"
  | "tokens"
export type Ceilings = Partial<Record<CeilingKey, number>>

export const CEILING_FIELDS: readonly {
  key: CeilingKey
  label: string
  /** Whole numbers only, except spend. */
  integer: boolean
  min?: number
  max?: number
  /** What a blank field means. */
  placeholder: string
}[] = [
  { key: "max_agents", label: "Agents per run", integer: true, min: 1, max: 1000, placeholder: "100" },
  { key: "concurrency", label: "Agents at once", integer: true, min: 1, max: 16, placeholder: "16" },
  { key: "steps", label: "Model steps per run", integer: true, min: 1, placeholder: "40 per agent" },
  { key: "per_agent_steps", label: "Model steps per agent", integer: true, min: 1, placeholder: "60" },
  { key: "minutes", label: "Minutes per run", integer: true, min: 1, max: 1440, placeholder: "120" },
  { key: "runs", label: "Runs at once per conversation", integer: true, min: 1, max: 4, placeholder: "1" },
  { key: "usd", label: "Spend per run (USD)", integer: false, placeholder: "None: the subagent ceiling applies" },
  { key: "tokens", label: "Tokens per run", integer: true, min: 1, placeholder: "None" },
]

export type WorkflowMode = "ask" | "allow"

export type WorkflowSettings = {
  /** False when `permission.workflow` resolves to deny or `tools.workflow` is false. */
  enabled: boolean
  mode: WorkflowMode
  /** `tools.workflow: false` is set, which turning workflows on must clear. */
  toolOff: boolean
  ceilings: Ceilings
}

const ACTIONS = new Set<string>(["ask", "allow", "deny"])

/**
 * What `permission` says for the workflow tool, as the engine reads it: the last rule matching "workflow" with
 * pattern "*" wins, a bare action applies to every tool, and nothing set leaves the default ask.
 */
export function workflowPermission(permission: Config["permission"]): PermissionActionConfig {
  if (typeof permission === "string") return permission
  let action: PermissionActionConfig = "ask"
  for (const [key, value] of Object.entries(permission ?? {})) {
    if (key !== "workflow" && key !== "*") continue
    if (typeof value === "string") {
      if (ACTIONS.has(value)) action = value as PermissionActionConfig
      continue
    }
    const all = value?.["*"]
    if (typeof all === "string" && ACTIONS.has(all)) action = all
  }
  return action
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

export function readWorkflowSettings(
  config: Pick<Config, "permission" | "tools" | "budget"> | undefined,
): WorkflowSettings {
  const action = workflowPermission(config?.permission)
  const toolOff = config?.tools?.workflow === false
  const saved = config?.budget?.workflow ?? {}
  const ceilings: Ceilings = {}
  for (const field of CEILING_FIELDS) {
    const value = positive((saved as Record<string, unknown>)[field.key])
    if (value !== undefined) ceilings[field.key] = value
  }
  return { enabled: action !== "deny" && !toolOff, mode: action === "allow" ? "allow" : "ask", toolOff, ceilings }
}

/**
 * The permission patch for one workflow action. A bare permission action ("allow" for every tool) becomes an object
 * that keeps it for every tool under "*", followed by the workflow rule, so the update does not drop it.
 */
function permissionPatch(config: Pick<Config, "permission"> | undefined, action: PermissionActionConfig): Config {
  const current = config?.permission
  if (typeof current === "string") return { permission: { "*": current, workflow: action } }
  return { permission: { workflow: action } }
}

/** Turning workflows on (with the chosen mode) or off. On also clears `tools.workflow: false` when it is set. */
export function workflowSwitchPatch(
  config: Pick<Config, "permission" | "tools"> | undefined,
  enabled: boolean,
  mode: WorkflowMode,
): Config {
  if (!enabled) return permissionPatch(config, "deny")
  return {
    ...permissionPatch(config, mode),
    ...(config?.tools?.workflow === false ? { tools: { workflow: true } } : {}),
  }
}

/** Ask first, or run a plan within your limits without asking. */
export function workflowModePatch(config: Pick<Config, "permission"> | undefined, mode: WorkflowMode): Config {
  return permissionPatch(config, mode)
}

/** One ceiling's text: a blank field means no value (the default), anything else must be in the field's range. */
export function parseCeiling(
  key: CeilingKey,
  input: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const field = CEILING_FIELDS.find((item) => item.key === key)!
  const trimmed = key === "usd" ? input.replace(/[$,\s]/g, "") : input.replace(/[,\s]/g, "")
  if (!trimmed) return { ok: true, value: undefined }
  const value = Number(trimmed)
  if (!field.integer) {
    if (!Number.isFinite(value) || value <= 0) return { ok: false, message: `${field.label}: enter an amount above 0.` }
    return { ok: true, value }
  }
  const min = field.min ?? 1
  if (!Number.isSafeInteger(value) || value < min || (field.max !== undefined && value > field.max))
    return {
      ok: false,
      message:
        field.max !== undefined
          ? `${field.label}: enter a whole number from ${min} to ${field.max}.`
          : `${field.label}: enter a whole number of at least ${min}.`,
    }
  return { ok: true, value }
}

/** A ceiling's value when its field is blank: its default, or undefined for spend and tokens, which have none. */
export function ceilingDefault(key: CeilingKey, ceilings: Ceilings): number | undefined {
  if (key === "usd" || key === "tokens") return undefined
  if (key === "steps") return (ceilings.max_agents ?? WORKFLOW_DEFAULTS.max_agents) * WORKFLOW_DEFAULTS.steps_per_agent
  return WORKFLOW_DEFAULTS[key]
}

/**
 * The `budget.workflow` update for the form. A blank field with a default writes nothing while the config has no
 * value for it, and writes the default when it has one (the update cannot remove a key). Blank spend or tokens with a
 * saved value cannot be cleared here, and say so.
 */
export function workflowCeilingsPatch(
  saved: Ceilings,
  input: Readonly<Partial<Record<CeilingKey, string>>>,
): { ok: true; patch: Config | undefined } | { ok: false; message: string } {
  const typed: Ceilings = {}
  for (const field of CEILING_FIELDS) {
    const parsed = parseCeiling(field.key, input[field.key] ?? "")
    if (!parsed.ok) return parsed
    if (parsed.value !== undefined) typed[field.key] = parsed.value
  }
  const next: Ceilings = {}
  for (const field of CEILING_FIELDS) {
    const value = typed[field.key]
    if (value !== undefined) {
      if (saved[field.key] !== value) next[field.key] = value
      continue
    }
    if (saved[field.key] === undefined) continue
    const fallback = ceilingDefault(field.key, { ...saved, ...typed })
    if (fallback === undefined)
      return {
        ok: false,
        message: `${field.label} cannot be cleared here. Remove budget.workflow.${field.key} from your config file, or enter a value.`,
      }
    if (saved[field.key] !== fallback) next[field.key] = fallback
  }
  if (Object.keys(next).length === 0) return { ok: true, patch: undefined }
  return { ok: true, patch: { budget: { workflow: next } } }
}

/**
 * Reset: the explicit defaults of every ceiling that has one. Steps is written as 40 per default agent (4000), the
 * value the engine derives when nothing is set. Spend and tokens keep what they have.
 */
export function workflowCeilingsResetPatch(): Config {
  return {
    budget: {
      workflow: {
        max_agents: WORKFLOW_DEFAULTS.max_agents,
        concurrency: WORKFLOW_DEFAULTS.concurrency,
        steps: WORKFLOW_DEFAULTS.max_agents * WORKFLOW_DEFAULTS.steps_per_agent,
        per_agent_steps: WORKFLOW_DEFAULTS.per_agent_steps,
        minutes: WORKFLOW_DEFAULTS.minutes,
        runs: WORKFLOW_DEFAULTS.runs,
      },
    },
  }
}

/** The ceilings as the form shows them: a saved value, or blank for the placeholder. */
export function ceilingText(ceilings: Ceilings, key: CeilingKey) {
  const value = ceilings[key]
  return value === undefined ? "" : String(value)
}
