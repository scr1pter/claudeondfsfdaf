import type {
  VectorClient,
  WorkflowIssue,
  WorkflowPlan,
  WorkflowPlanStage,
  WorkflowSaved,
} from "@vectordevai/sdk/v2/client"
import type { Prompt } from "@/context/prompt"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"

/*
 * Desktop workflow surfaces (5.I.4): the plan as the permission dock and the /workflow form show it, the reason an
 * elevated plan always asks, the saved-workflow form's inputs, and the owner routes (7, 8 and 9) as pure requests over a
 * client. Everything here is plain text: plan titles, stage names and issues come from a spec a model may have written,
 * so the components render them as text, never markup or links (I13).
 */

/** Opens the /workflow form on a session page: `/workflow <name>` typed and sent from the composer dispatches it. */
export const WORKFLOW_EVENT = "vector:open-workflow"
export type WorkflowOpenDetail = { sessionID: string; name?: string }

/** A saved workflow's name, as the engine accepts it (`workflow` tool `name`). */
const SAVED_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Each input value may be at most 8 KiB of JSON (the `workflow` tool and route 9). */
export const INPUT_BYTES = 8 * 1024

// ---------------------------------------------------------------------------
// The plan

export type PlanStage = WorkflowPlanStage
export type Plan = WorkflowPlan

const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function readStage(value: unknown): PlanStage | undefined {
  const stage = record(value)
  if (!stage) return undefined
  const id = text(stage.id)
  const agent = text(stage.agent)
  const items = stage.items === "dynamic" ? "dynamic" : count(stage.items)
  if (!id || !agent || items === undefined) return undefined
  const verify = record(stage.verify)
  const verifier = verify && text(verify.agent)
  const rounds = verify && count(verify.maxRounds)
  return {
    id,
    title: text(stage.title) ?? id,
    phase: text(stage.phase) ?? "",
    agent,
    ...(text(stage.model) ? { model: text(stage.model) } : {}),
    ...(text(stage.effort) ? { effort: text(stage.effort) } : {}),
    ...(text(stage.isolation) ? { isolation: text(stage.isolation) } : {}),
    items,
    serial: stage.serial === true,
    writes: text(stage.writes) ?? "",
    asks: Array.isArray(stage.asks) ? stage.asks.filter((ask): ask is string => typeof ask === "string") : [],
    ...(verifier && rounds ? { verify: { agent: verifier, maxRounds: rounds } } : {}),
  }
}

/**
 * A plan from a permission request's metadata, a validation or a start result, checked field by field. Anything that
 * is not a plan reads as undefined, so a malformed ask still shows its patterns instead of breaking the dock.
 */
export function readPlan(value: unknown): Plan | undefined {
  const plan = record(value)
  if (!plan || !Array.isArray(plan.stages)) return undefined
  const title = text(plan.title)
  const maxAgents = count(plan.maxAgents)
  const concurrency = count(plan.concurrency)
  const steps = count(plan.steps)
  const perAgentSteps = count(plan.perAgentSteps)
  const minutes = count(plan.minutes)
  if (title === undefined || !maxAgents || !concurrency || !steps || !perAgentSteps || !minutes) return undefined
  const stages = plan.stages.map(readStage)
  if (stages.some((stage) => !stage)) return undefined
  const saved = record(plan.saved)
  return {
    title,
    stages: stages as PlanStage[],
    maxAgents,
    concurrency,
    ...(count(plan.usd) ? { usd: count(plan.usd) } : {}),
    ...(count(plan.tokens) ? { tokens: count(plan.tokens) } : {}),
    steps,
    perAgentSteps,
    minutes,
    ...(saved && text(saved.name) && (saved.source === "repository" || saved.source === "user")
      ? { saved: { name: text(saved.name)!, source: saved.source } }
      : {}),
  }
}

const number = (value: number) => value.toLocaleString("en-US")
const usd = (value: number) => `$${value.toFixed(2)}`
const plural = (value: number, one: string, other = `${one}s`) => `${number(value)} ${value === 1 ? one : other}`

function items(stage: PlanStage) {
  if (stage.items === "dynamic") return "items found while it runs"
  return plural(stage.items, "item")
}

/** One stage: "Review each file · review · model · effort · 12 items · read only · asks: bash". */
export function stageLine(stage: PlanStage) {
  return [
    stage.title,
    stage.agent,
    ...(stage.model ? [stage.model] : []),
    ...(stage.effort && stage.effort !== "default" ? [stage.effort] : []),
    items(stage),
    ...(stage.writes ? [stage.writes] : []),
    ...(stage.verify ? [`checked by ${stage.verify.agent}, up to ${plural(stage.verify.maxRounds, "round")}`] : []),
    ...(stage.asks.length ? [`asks: ${stage.asks.join(", ")}`] : []),
  ].join(" · ")
}

/**
 * Every ceiling the run is held to (G.3): agents, concurrency, steps, per-agent steps, minutes, tokens, the run's own
 * spend and the request's subagent ceiling it shares.
 */
export function ceilingsLine(plan: Plan, delegated?: { usd?: number }) {
  return [
    `Up to ${plural(plan.maxAgents, "agent")}`,
    `${number(plan.concurrency)} at once`,
    plural(plan.steps, "step"),
    `${plural(plan.perAgentSteps, "step")} per agent`,
    plural(plan.minutes, "minute"),
    ...(plan.tokens !== undefined ? [plural(plan.tokens, "token")] : []),
    ...(plan.usd !== undefined ? [`${usd(plan.usd)} for this run`] : []),
    ...(delegated?.usd !== undefined ? [`shares the ${usd(delegated.usd)} subagent ceiling`] : []),
  ].join(" · ")
}

// ---------------------------------------------------------------------------
// The workflow permission ask (G.3)

export type AskReason = "web" | "mcp" | "agent" | "large"

export type WorkflowAsk = {
  plan?: Plan
  /** Why the plan asks every time; undefined for a plan within the configured defaults. */
  reason?: AskReason
  /** Any pattern other than "run": the ask is never auto-approved and never saved as Always (I15). */
  elevated: boolean
  /** Always allow is offered only for a "run" pattern the engine marked always-able. */
  canAlways: boolean
  /** The request's subagent ceiling the run shares. */
  delegated?: { usd?: number }
}

const REASON_PREFIX = `${PermissionPolicy.AFTER_WEB}workflow:`

/** A workflow ask as the dock shows it, or undefined for any other permission. */
export function readWorkflowAsk(request: {
  permission: string
  patterns: readonly string[]
  always: readonly string[]
  metadata?: Record<string, unknown>
}): WorkflowAsk | undefined {
  if (request.permission !== PermissionPolicy.WORKFLOW) return undefined
  const elevated = request.patterns.length === 0 || request.patterns.some((pattern) => pattern !== "run")
  const reason = request.patterns
    .flatMap((pattern) => (pattern.startsWith(REASON_PREFIX) ? [pattern.slice(REASON_PREFIX.length)] : []))
    .find((value): value is AskReason => value === "web" || value === "mcp" || value === "agent" || value === "large")
  const delegated = record(request.metadata?.delegated)
  const ceiling = delegated ? count(delegated.usd) : undefined
  return {
    plan: readPlan(request.metadata),
    ...(reason ? { reason } : {}),
    elevated,
    canAlways:
      !elevated &&
      PermissionPolicy.canAlwaysApprove(request.permission, [...request.always], [...request.patterns]) &&
      request.always.includes("run"),
    ...(ceiling !== undefined ? { delegated: { usd: ceiling } } : {}),
  }
}

/** The line under an elevated plan, saying why it asks every time and has no Always allow. */
export function reasonLine(ask: Pick<WorkflowAsk, "reason" | "elevated">) {
  if (!ask.elevated) return undefined
  const tail = "so it asks every time and cannot be allowed always."
  if (ask.reason === "web") return `This conversation read the web, which may have shaped this plan, ${tail}`
  if (ask.reason === "mcp") return `This conversation used MCP tools, which may have shaped this plan, ${tail}`
  if (ask.reason === "agent") return `A program Vector's agent started asked for this workflow, ${tail}`
  if (ask.reason === "large") return `This plan goes past your workflow limits in Settings → Agents, ${tail}`
  return `This plan asks every time and cannot be allowed always.`
}

// ---------------------------------------------------------------------------
// The /workflow form

export type Saved = WorkflowSaved
export type Issue = WorkflowIssue

/** `/workflow` or `/workflow <name>` sent from the composer; undefined for anything else. */
export function workflowSlash(text: string): { name?: string } | undefined {
  const match = /^\/workflow(?:\s+(\S+))?\s*$/.exec(text.trim())
  if (!match) return undefined
  const name = match[1]
  return name && SAVED_NAME.test(name) ? { name } : {}
}

/**
 * Whether a submission opens the /workflow form instead of being sent: the text is `/workflow` or `/workflow <name>`
 * alone, on an open session of an engine with `workflows`, in normal mode, with no attachments, and the engine lists
 * no command named "workflow" (a user's own command keeps its name).
 */
export function workflowOpen(input: {
  text: string
  mode: "normal" | "shell"
  sessionID: string | undefined
  commands: readonly { name: string }[]
  workflows: boolean
  attachments: number
}): WorkflowOpenDetail | undefined {
  if (input.mode !== "normal" || !input.sessionID || !input.workflows || input.attachments > 0) return undefined
  if (input.commands.some((command) => command.name === "workflow")) return undefined
  const slash = workflowSlash(input.text)
  if (!slash) return undefined
  return { sessionID: input.sessionID, ...(slash.name ? { name: slash.name } : {}) }
}

export type InputField = {
  name: string
  description?: string
  required: boolean
  /** The declared default as the field's placeholder: text as it is, anything else as JSON. */
  placeholder: string
}

function shown(value: unknown) {
  if (value === undefined) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

export function inputFields(saved: Pick<Saved, "inputs">): InputField[] {
  return saved.inputs.map((input) => ({
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    required: input.required && input.default === undefined,
    placeholder: shown(input.default),
  }))
}

/** A JSON input value, as route 8 and 9 take it. */
type Json = unknown

/**
 * The form's text as input values. A blank field is left out, so the engine uses its default, and a required one with
 * no default is an issue. Text stays text, except where the declared default is not text (a number, a list, an object)
 * or the text is a JSON object or list: then it is read as JSON.
 */
export function parseInputs(
  saved: Pick<Saved, "inputs">,
  values: Readonly<Record<string, string>>,
): { ok: true; inputs: Record<string, Json> } | { ok: false; issues: Issue[] } {
  const inputs: Record<string, Json> = {}
  const issues: Issue[] = []
  for (const field of saved.inputs) {
    const raw = values[field.name] ?? ""
    if (!raw.trim()) {
      if (field.required && field.default === undefined)
        issues.push({ path: field.name, message: `${field.name} is required.` })
      continue
    }
    const json = field.default !== undefined && typeof field.default !== "string"
    let value: Json = raw
    if (json || /^\s*[[{]/.test(raw)) {
      try {
        value = JSON.parse(raw) as Json
      } catch {
        if (json) {
          issues.push({ path: field.name, message: `${field.name} must be JSON, like its default.` })
          continue
        }
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > INPUT_BYTES) {
      issues.push({ path: field.name, message: `${field.name} must be at most 8 KiB.` })
      continue
    }
    inputs[field.name] = value
  }
  return issues.length ? { ok: false, issues } : { ok: true, inputs }
}

/**
 * What the composer gets when the session is busy: a message asking the agent to run the saved workflow, which it
 * does with the `workflow` tool (and its approval card) when the message is read.
 */
export function busyMessage(name: string, inputs: Readonly<Record<string, unknown>>) {
  const quoted = JSON.stringify(name)
  if (Object.keys(inputs).length === 0) return `Run the saved workflow ${quoted} with its default inputs.`
  return `Run the saved workflow ${quoted} with ${JSON.stringify(inputs)}.`
}

/** The composer draft with the busy message appended after what is already there, attachments kept. */
export function appendWorkflowRequest(prompt: Prompt, message: string): Prompt {
  const end = prompt.reduce((last, part) => (part.type === "image" ? last : Math.max(last, part.end)), 0)
  const content = `${end ? "\n\n" : ""}${message}`
  return [...prompt, { type: "text", content, start: end, end: end + content.length }]
}

/** Saved workflows the form lists: valid ones first, each group by title. Invalid ones stay listed with their issues. */
export function savedEntries(list: readonly Saved[]) {
  return [...list].sort((a, b) => {
    const invalid = Number(!!a.issues?.length) - Number(!!b.issues?.length)
    return invalid || a.title.localeCompare(b.title) || a.name.localeCompare(b.name)
  })
}

// ---------------------------------------------------------------------------
// Owner routes 7, 8 and 9, pure over a client

export type WorkflowClient = {
  experimental: { workflow: Pick<VectorClient["experimental"]["workflow"], "saved" | "validate" | "start"> }
}

export type WorkflowFailure = {
  /** busy: the session is working (start it from the composer instead); owner: not the server owner (403). */
  kind: "busy" | "owner" | "disabled" | "invalid" | "limit" | "other"
  message: string
  issues?: readonly Issue[]
}

/** A route failure as the form says it, from the SDK error's status and `WorkflowApiError` body. */
export function workflowFailure(error: unknown): WorkflowFailure {
  const cause = error instanceof Error ? (error.cause as { status?: unknown; body?: unknown } | undefined) : undefined
  const body = record(cause?.body)
  const code = text(body?.code)
  const message = text(body?.message) ?? (error instanceof Error ? error.message : "The request failed.")
  const issues = Array.isArray(body?.issues)
    ? body.issues.flatMap((issue) => {
        const item = record(issue)
        return item && text(item.path) !== undefined && text(item.message)
          ? [{ path: text(item.path)!, message: text(item.message)! }]
          : []
      })
    : undefined
  const extra = issues?.length ? { issues } : {}
  if (cause?.status === 403 || code === "forbidden")
    return { kind: "owner", message: "Only the server owner can start a saved workflow.", ...extra }
  if (code === "busy") return { kind: "busy", message, ...extra }
  if (code === "disabled") return { kind: "disabled", message, ...extra }
  if (code === "invalid" || code === "not_found") return { kind: "invalid", message, ...extra }
  if (code === "limit" || code === "running") return { kind: "limit", message, ...extra }
  return { kind: "other", message, ...extra }
}

/** Route 7: the trusted saved workflows. */
export async function savedRequest(client: WorkflowClient) {
  const result = await client.experimental.workflow.saved(undefined, { throwOnError: true })
  return result.data?.workflows ?? []
}

/** Route 8: the plan, issues and warnings for a saved workflow with these inputs, without starting anything. */
export async function validateRequest(input: {
  client: WorkflowClient
  name: string
  inputs: Readonly<Record<string, Json>>
}) {
  const result = await input.client.experimental.workflow.validate(
    { workflowValidateInput: { name: input.name, inputs: { ...input.inputs } } },
    { throwOnError: true },
  )
  if (!result.data) throw new Error("The workflow could not be checked.")
  return result.data
}

/** Route 9: starts the saved workflow in an idle session, after the user saw its plan. */
export async function startRequest(input: {
  client: WorkflowClient
  sessionID: string
  name: string
  inputs: Readonly<Record<string, Json>>
}): Promise<{ ok: true; runID: string; title: string } | ({ ok: false } & WorkflowFailure)> {
  return input.client.experimental.workflow
    .start(
      { sessionID: input.sessionID, workflowStartInput: { name: input.name, inputs: { ...input.inputs } } },
      { throwOnError: true },
    )
    .then((result) =>
      result.data
        ? { ok: true as const, runID: result.data.runID, title: result.data.title }
        : { ok: false as const, kind: "other" as const, message: "The workflow did not start." },
    )
    .catch((error: unknown) => ({ ok: false as const, ...workflowFailure(error) }))
}
