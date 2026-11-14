import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Hands } from "@vectordevai/schema/hands"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Schema } from "effect"
import { sanitizeTerminalText } from "./presentation"
import { isRecord } from "./record"

export const canAutoApprovePermission = PermissionPolicy.canAutoApprove
export const canAlwaysAllowPermission = PermissionPolicy.canAlwaysApprove

/**
 * Display only verified metadata fields. Pattern keys and model-authored reasons are never titles. Only Hands' two asks
 * get these details; another tool's `computer_<tool>` permission keeps the ordinary prompt.
 */
export function computerPermissionDetails(request: {
  permission: string
  metadata: Record<string, unknown>
  always?: readonly string[]
}) {
  if (!PermissionPolicy.handsAsk(request.permission)) return
  const target = request.metadata.target
  const fields = target && typeof target === "object" && !Array.isArray(target) ? target : undefined
  const name = computerLabel(fields && Reflect.get(fields, "appName"), 256)
  const app = name || "this app"
  const kind = request.permission === "computer_app" ? "app" : "sensitive"
  const label = computerLabel(request.metadata.targetName, 40) || "this control"
  const action = typeof request.metadata.action === "string" ? request.metadata.action : ""
  const verbs: Record<string, string> = {
    click: `click “${label}” in ${app}`,
    type: `type in ${app}`,
    key: `press a key in ${app}`,
    drag: `drag in ${app}`,
    open: "run a program",
  }
  const metadata = {
    ...request.metadata,
    ...(fields ? { target: { ...fields, appName: name } } : {}),
    ...(typeof request.metadata.targetName === "string"
      ? { targetName: computerLabel(request.metadata.targetName, 40) }
      : {}),
    ...(typeof request.metadata.reason === "string" ? { reason: computerLabel(request.metadata.reason, 200) } : {}),
  }
  const appMetadata = kind === "app" && Schema.is(Computer.AppAskMetadata)(metadata) ? metadata : undefined
  const reason =
    request.permission === "computer_sensitive" && Schema.is(Computer.SensitiveAskMetadata)(metadata)
      ? computerSensitiveReason(metadata, app)
      : undefined
  const canApprove =
    Boolean(name) &&
    (appMetadata
      ? !ComputerApps.isNever(appMetadata.target.category) &&
        Computer.parseAppKey(appMetadata.target.appKey)?.platform === appMetadata.target.platform
      : reason !== undefined)
  const verb =
    request.metadata.why === "run_program" || action === "open"
      ? "run a program"
      : request.metadata.why === "paste"
        ? `paste in ${app}`
        : verbs[action]
  const canAlways =
    appMetadata !== undefined &&
    canApprove &&
    appMetadata.canAlways &&
    appMetadata.alwaysWhyNot === undefined &&
    appMetadata.target.verified &&
    !ComputerApps.NO_ALWAYS.has(appMetadata.target.category) &&
    canAlwaysAllowPermission(request.permission, request.always) &&
    request.always?.every((key) => key === appMetadata.target.appKey) === true
  return {
    kind,
    app,
    title: !canApprove
      ? `Review ${Hands.NAME} request`
      : kind === "app"
        ? `Allow ${Hands.NAME} to use ${app}?`
        : `${Hands.NAME} wants to ${verb}`,
    body: !canApprove
      ? "This request could not be verified. Deny it and ask the agent to try again."
      : kind === "app"
        ? request.metadata.level === "observe"
          ? `It can see the windows of ${app} until this task is done.`
          : `It can see the windows of ${app} and click, type and use its menus until this task is done.`
        : `App: ${app}\n${reason}`,
    alwaysDescription: `Always allow skips this question for ${app} from now on. Remove it in Settings › ${Hands.NAME}.`,
    canAlways,
    canApprove,
    primaryLabel: kind === "app" ? "Allow" : "Allow once",
  }
}

function computerLabel(value: unknown, limit: number) {
  const text = computerText(value, limit)
  return /^(?:app:|window:\d+:\d+$)/i.test(text) ? "" : text
}

function computerText(value: unknown, limit: number) {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .trim()
    .slice(0, limit)
    .replace(/[\ud800-\udbff]$/, "")
}

function computerSensitiveReason(metadata: Computer.SensitiveAskMetadata, app: string) {
  if (metadata.why === "run_program") {
    const path = computerText(metadata.path, 4096)
    return path ? `This runs a program: ${path}.` : undefined
  }
  if (metadata.why === "paste")
    return typeof metadata.text === "string"
      ? `This pastes what you copied: “${computerText(metadata.text, 60)}”.`
      : undefined
  if (metadata.why === "new_destination") {
    const destination = computerText(metadata.destination, 2048)
    return destination ? `It's typing an address you didn't give it: ${destination}.` : undefined
  }
  if (metadata.why === "provider_check") {
    const provider = computerText(metadata.providerCheck?.provider, 64)
    const message = computerText(metadata.providerCheck?.message, 1000)
    return provider && message
      ? `${provider} flagged this step: ${message}${metadata.providerCheck?.domain ? "\nWatch this step closely." : ""}`
      : undefined
  }
  return {
    send: "This sends a message.",
    delete: "This deletes something.",
    buy: "This may spend money.",
    submit: "This submits a form.",
    account: "This changes an account or accepts terms.",
    settings: "This changes a setting.",
    ide_run: `This runs code in ${app}.`,
    disruptive: "This quits an app or logs you out.",
    flagged: PermissionPolicy.FLAGGED_SCREEN_REASON,
  }[metadata.why]
}

export function cloudPermissionDetails(request: { permission: string; metadata: Record<string, unknown> }) {
  if (!request.permission.startsWith("vector_cloud_")) return
  const text = (key: string) => {
    const value = request.metadata[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const rows = [
    { label: "Provider", value: text("provider") },
    {
      label: text("provider") === "Vector" ? "Repository" : `${text("provider") ?? "Cloud"} project`,
      value: text("project"),
    },
    { label: "Environment", value: text("environment") },
  ].flatMap((row) => (row.value ? [{ label: row.label, value: row.value }] : []))
  const statements = Array.isArray(request.metadata.statements)
    ? request.metadata.statements.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return []
        const label = Reflect.get(item, "label")
        const sql = Reflect.get(item, "sql")
        const length = Reflect.get(item, "length")
        if (typeof label !== "string" || typeof sql !== "string" || !sql.trim()) return []
        return [{ label, sql, incomplete: typeof length === "number" && length > sql.length }]
      })
    : []
  return { summary: text("summary"), rows, statements }
}

// ---------------------------------------------------------------------------
// Workflows (5.I.5): the plan a workflow ask and `/workflow` show, and why an elevated plan always asks. Plan titles,
// stage names and agents come from a spec a model may have written, so every string passes sanitizeTerminalText.

const safe = sanitizeTerminalText

export type WorkflowPlanStage = {
  id: string
  title: string
  phase: string
  agent: string
  model?: string
  effort?: string
  isolation?: string
  items: number | "dynamic"
  serial: boolean
  writes: string
  asks: string[]
  verify?: { agent: string; maxRounds: number }
}

export type WorkflowPlan = {
  title: string
  stages: WorkflowPlanStage[]
  maxAgents: number
  concurrency: number
  usd?: number
  tokens?: number
  steps: number
  perAgentSteps: number
  minutes: number
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

function readStage(value: unknown): WorkflowPlanStage | undefined {
  if (!isRecord(value)) return
  const id = text(value.id)
  const agent = text(value.agent)
  const items = value.items === "dynamic" ? "dynamic" : amount(value.items)
  if (!id || !agent || items === undefined) return
  const verify = isRecord(value.verify) ? value.verify : undefined
  const verifier = verify && text(verify.agent)
  const rounds = verify && amount(verify.maxRounds)
  return {
    id,
    title: text(value.title) ?? id,
    phase: text(value.phase) ?? "",
    agent,
    ...(text(value.model) ? { model: text(value.model) } : {}),
    ...(text(value.effort) ? { effort: text(value.effort) } : {}),
    ...(text(value.isolation) ? { isolation: text(value.isolation) } : {}),
    items,
    serial: value.serial === true,
    writes: text(value.writes) ?? "",
    asks: Array.isArray(value.asks) ? value.asks.filter((ask): ask is string => typeof ask === "string") : [],
    ...(verifier && rounds ? { verify: { agent: verifier, maxRounds: rounds } } : {}),
  }
}

/** A plan from a permission request's metadata or a validation, checked field by field; undefined when malformed. */
export function readWorkflowPlan(value: unknown): WorkflowPlan | undefined {
  if (!isRecord(value) || !Array.isArray(value.stages)) return
  const title = text(value.title)
  const maxAgents = amount(value.maxAgents)
  const concurrency = amount(value.concurrency)
  const steps = amount(value.steps)
  const perAgentSteps = amount(value.perAgentSteps)
  const minutes = amount(value.minutes)
  if (title === undefined || !maxAgents || !concurrency || !steps || !perAgentSteps || !minutes) return
  const stages = value.stages.map(readStage)
  if (stages.some((stage) => !stage)) return
  return {
    title,
    stages: stages as WorkflowPlanStage[],
    maxAgents,
    concurrency,
    ...(amount(value.usd) ? { usd: amount(value.usd) } : {}),
    ...(amount(value.tokens) ? { tokens: amount(value.tokens) } : {}),
    steps,
    perAgentSteps,
    minutes,
  }
}

const number = (value: number) => value.toLocaleString("en-US")
const plural = (value: number, one: string) => `${number(value)} ${value === 1 ? one : `${one}s`}`

/** The plan as lines: its title, one line per stage, and every ceiling the run is held to (G.3). */
export function workflowPlanLines(plan: WorkflowPlan, delegated?: { usd?: number }) {
  return [
    safe(plan.title),
    ...plan.stages.map(
      (stage) =>
        "- " +
        [
          safe(stage.title),
          safe(stage.agent),
          ...(stage.model ? [safe(stage.model)] : []),
          ...(stage.effort && stage.effort !== "default" ? [safe(stage.effort)] : []),
          stage.items === "dynamic" ? "items found while it runs" : plural(stage.items, "item"),
          ...(stage.isolation ? [safe(stage.isolation)] : []),
          ...(stage.writes ? [safe(stage.writes)] : []),
          ...(stage.verify
            ? [`checked by ${safe(stage.verify.agent)}, up to ${plural(stage.verify.maxRounds, "round")}`]
            : []),
          ...(stage.asks.length ? [`asks: ${stage.asks.map(safe).join(", ")}`] : []),
        ].join(" · "),
    ),
    [
      `Up to ${plural(plan.maxAgents, "agent")}`,
      `${number(plan.concurrency)} at once`,
      plural(plan.steps, "step"),
      `${plural(plan.perAgentSteps, "step")} per agent`,
      plural(plan.minutes, "minute"),
      ...(plan.tokens !== undefined ? [plural(plan.tokens, "token")] : []),
      ...(plan.usd !== undefined ? [`$${plan.usd.toFixed(2)} for this run`] : []),
      ...(delegated?.usd !== undefined ? [`shares the $${delegated.usd.toFixed(2)} subagent ceiling`] : []),
    ].join(" · "),
  ]
}

const REASON_PREFIX = `${PermissionPolicy.AFTER_WEB}workflow:`

export type WorkflowAsk = {
  plan?: WorkflowPlan
  delegated?: { usd?: number }
  /** Any pattern other than "run": never auto-approved and never saved as Always (I15). */
  elevated: boolean
  /** The line saying why an elevated plan asks every time. */
  reason?: string
  /** Always allow is offered only for a "run" pattern the engine marked always-able. */
  canAlways: boolean
}

/** A workflow permission ask as the prompt shows it, or undefined for any other permission. */
export function workflowAsk(request: {
  permission: string
  patterns?: readonly string[]
  always?: readonly string[]
  metadata?: Record<string, unknown>
}): WorkflowAsk | undefined {
  if (request.permission !== PermissionPolicy.WORKFLOW) return
  const patterns = request.patterns ?? []
  const always = request.always ?? []
  const elevated = patterns.length === 0 || patterns.some((pattern) => pattern !== "run")
  const kind = patterns
    .flatMap((pattern) => (pattern.startsWith(REASON_PREFIX) ? [pattern.slice(REASON_PREFIX.length)] : []))
    .find((value) => value === "web" || value === "mcp" || value === "agent" || value === "large")
  const tail = "so it asks every time and cannot be allowed always."
  const reason = !elevated
    ? undefined
    : kind === "web"
      ? `This conversation read the web, which may have shaped this plan, ${tail}`
      : kind === "mcp"
        ? `This conversation used MCP tools, which may have shaped this plan, ${tail}`
        : kind === "agent"
          ? `A program Vector's agent started asked for this workflow, ${tail}`
          : kind === "large"
            ? `This plan goes past your workflow limits (budget.workflow), ${tail}`
            : "This plan asks every time and cannot be allowed always."
  const delegated = isRecord(request.metadata?.delegated) ? amount(request.metadata.delegated.usd) : undefined
  return {
    plan: readWorkflowPlan(request.metadata),
    ...(delegated !== undefined ? { delegated: { usd: delegated } } : {}),
    elevated,
    ...(reason ? { reason } : {}),
    canAlways:
      !elevated &&
      always.includes("run") &&
      PermissionPolicy.canAlwaysApprove(request.permission, [...always], [...patterns]),
  }
}
