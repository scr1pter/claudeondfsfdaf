import { For, Show, createMemo } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useData } from "../context"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"

/*
 * The `workflow` tool's part (5.I.4): a declarative workflow the agent ran, validated or resumed, with its plan, every
 * ceiling, and a link to the run, whose stages show in Background tasks. Every string in the plan may come from a spec
 * a model wrote, so it renders as plain text only (I13). The plan is read from the tool's output (`Workflow.Started`
 * or `Workflow.Validation`); while the run waits for approval the permission dock shows it instead.
 */

export type WorkflowPartPlan = {
  title: string
  stages: { title: string; agent: string; items: number | "dynamic"; writes: string }[]
  limits: string
}

export type WorkflowPartView = {
  action: "run" | "validate" | "resume" | "guide"
  title: string
  subtitle?: string
  state?: string
  plan?: WorkflowPartPlan
  issues: string[]
  /** The run session, once the run started. */
  runID?: string
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function json(value: unknown) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

const plural = (value: number, one: string) => `${value.toLocaleString("en-US")} ${value === 1 ? one : `${one}s`}`

/** A plan from the tool output, field by field; anything that is not one reads as undefined. */
export function workflowPartPlan(value: unknown): WorkflowPartPlan | undefined {
  const plan = record(value)
  const title = text(plan?.title)
  if (!plan || !title || !Array.isArray(plan.stages)) return undefined
  const stages = plan.stages.flatMap((item): WorkflowPartPlan["stages"] => {
    const stage = record(item)
    const id = text(stage?.id)
    const agent = text(stage?.agent)
    const items: number | "dynamic" | undefined = stage?.items === "dynamic" ? "dynamic" : count(stage?.items)
    if (!stage || !id || !agent || items === undefined) return []
    return [{ title: text(stage.title) ?? id, agent, items, writes: text(stage.writes) ?? "" }]
  })
  const agents = count(plan.maxAgents)
  const concurrency = count(plan.concurrency)
  const minutes = count(plan.minutes)
  const usd = count(plan.usd)
  return {
    title,
    stages,
    limits: [
      ...(agents ? [`up to ${plural(agents, "agent")}`] : []),
      ...(concurrency ? [`${concurrency.toLocaleString("en-US")} at once`] : []),
      ...(minutes ? [plural(minutes, "minute")] : []),
      ...(usd ? [`$${usd.toFixed(2)} for this run`] : []),
    ].join(" · "),
  }
}

export function workflowStageLine(stage: WorkflowPartPlan["stages"][number]) {
  return [
    stage.title,
    stage.agent,
    stage.items === "dynamic" ? "items found while it runs" : plural(stage.items, "item"),
    ...(stage.writes ? [stage.writes] : []),
  ].join(" · ")
}

/** What the part shows for its input, metadata, output and status. */
export function workflowPartView(input: {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  status?: string
}): WorkflowPartView {
  const raw = text(input.metadata.action) ?? text(input.input.action) ?? "run"
  const action = raw === "validate" || raw === "resume" || raw === "guide" ? raw : "run"
  const output = json(input.output)
  const pending = input.status === "pending" || input.status === "running"
  const failed = input.status === "error"
  if (action === "guide") return { action, title: "Workflow guide", issues: [] }
  if (action === "validate") {
    const issues = Array.isArray(output?.issues)
      ? output.issues.flatMap((item) => {
          const issue = record(item)
          const message = text(issue?.message)
          return message ? [`${text(issue?.path) ?? ""}${text(issue?.path) ? ": " : ""}${message}`] : []
        })
      : []
    const plan = workflowPartPlan(output?.plan)
    return {
      action,
      title: "Workflow check",
      subtitle: plan?.title ?? text(input.input.title) ?? text(input.input.name),
      state: pending
        ? "checking"
        : failed
          ? "failed"
          : input.metadata.valid === true || output?.ok === true
            ? "valid"
            : "has issues",
      ...(plan ? { plan } : {}),
      issues,
    }
  }
  const plan = workflowPartPlan(output?.plan)
  const runID = text(input.metadata.runID) ?? text(output?.runID) ?? text(input.metadata.sessionId)
  return {
    action,
    title: "Workflow",
    subtitle: text(output?.title) ?? plan?.title ?? text(input.input.title) ?? text(input.input.name),
    state: pending
      ? runID
        ? "starting"
        : "waiting for approval"
      : failed
        ? "not started"
        : action === "resume"
          ? "resumed"
          : "started",
    ...(plan ? { plan } : {}),
    issues: [],
    ...(runID && !failed ? { runID } : {}),
  }
}

/**
 * The worktree chip of an isolated subagent's task part (5.I.4), from the part's `isolation` metadata (which never
 * carries the directory): "3 files changed · vector/task-x" while its changes wait for review, or its state.
 */
export function worktreeChip(value: unknown): string | undefined {
  const isolation = record(value)
  const state = text(isolation?.state)
  if (!isolation || !state) return undefined
  const branch = text(isolation.branch)
  const files = count(isolation.files)
  if (state === "changed")
    return [files !== undefined ? `${plural(files, "file")} changed` : "Changes to review", branch]
      .filter(Boolean)
      .join(" · ")
  if (state === "unchanged") return "No changes"
  if (state === "merged") return "Merged"
  if (state === "discarded") return "Discarded"
  if (state === "diverged") return "Worktree diverged"
  if (state === "failed") return "Worktree failed"
  return ["Worktree", branch].filter(Boolean).join(" · ")
}

function sessionLink(id: string | undefined, path: string, href?: (id: string) => string | undefined) {
  if (!id) return
  const direct = href?.(id)
  if (direct) return direct
  const index = path.indexOf("/session")
  if (index === -1) return
  return `${path.slice(0, index)}/session/${id}`
}

export function WorkflowPart(props: ToolProps) {
  const data = useData()
  const location = useLocation()
  const view = createMemo(() =>
    workflowPartView({
      input: props.input,
      metadata: props.metadata,
      output: props.output,
      status: props.status,
    }),
  )
  const href = createMemo(() => sessionLink(view().runID, location.pathname, data.sessionHref))
  const open = (event: MouseEvent) => {
    const id = view().runID
    if (!id || !data.navigateToSession) return
    event.preventDefault()
    data.navigateToSession(id)
  }
  const details = () => !!view().plan || view().issues.length > 0
  return (
    <BasicTool
      {...props}
      icon="task"
      trigger={{
        title: view().title,
        subtitle: view().subtitle ?? "",
        args: view().state ? [view().state!] : [],
      }}
      hideDetails={!details()}
    >
      <Show when={details()}>
        <div data-component="tool-output" data-scrollable tabIndex={0} role="region" aria-label="Workflow plan">
          <Show when={view().plan}>
            {(plan) => (
              <>
                <Show when={plan().limits}>
                  <p>{plan().limits}</p>
                </Show>
                <ol>
                  <For each={plan().stages}>{(stage) => <li>{workflowStageLine(stage)}</li>}</For>
                </ol>
              </>
            )}
          </Show>
          <Show when={view().issues.length > 0}>
            <ul>
              <For each={view().issues}>{(issue) => <li>{issue}</li>}</For>
            </ul>
          </Show>
          <Show when={view().runID && (href() || data.navigateToSession)}>
            <p>
              <a href={href() ?? "#"} onClick={open}>
                Open the run
              </a>
            </p>
          </Show>
        </div>
      </Show>
    </BasicTool>
  )
}
