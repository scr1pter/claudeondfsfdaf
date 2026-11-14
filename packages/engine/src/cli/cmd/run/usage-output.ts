import { Billing } from "@vectordevai/schema/billing"
import type { StepFinishPart, ToolPart } from "@vectordevai/sdk/v2"

/** JSON is a public usage report; the original part still carries context tokens inside the engine. */
export function stepForOutput(part: StepFinishPart, billing?: "codium" | "own") {
  const codium = Boolean(Billing.of(part) || billing === "codium")
  if (!codium && billing === "own") return part
  const result: Partial<StepFinishPart> = {
    ...part,
    ...(codium ? { billing: "codium" as const, cost: 0, unpriced: true } : {}),
  }
  delete result.tokens
  return result
}

/** Editable lifecycle metadata cannot certify aggregate figures in machine output. Step events report own usage. */
export function toolForOutput(part: ToolPart) {
  if (!["task", "workflow"].includes(part.tool) || (part.state.status !== "completed" && part.state.status !== "error"))
    return part
  return { ...part, state: { ...part.state, metadata: taskMetadata(part.state.metadata) } }
}

/** Lifecycle records keep dollars and counts but lose aggregate token figures and their proof, wherever nested. */
export function taskMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(taskMetadata)
  if (!value || typeof value !== "object") return value
  const item = value as Record<string, unknown>
  const next = { ...item }
  if (item.usage && typeof item.usage === "object" && !Array.isArray(item.usage)) {
    const usage = { ...item.usage } as Record<string, unknown>
    delete usage.tokens
    delete usage.total
    delete usage.tokensOwnOnly
    next.usage = usage
  }
  if (item.tasks && typeof item.tasks === "object")
    next.tasks = Array.isArray(item.tasks)
      ? item.tasks.map(taskMetadata)
      : "usage" in item.tasks
        ? taskMetadata(item.tasks)
        : Object.fromEntries(Object.entries(item.tasks).map(([key, child]) => [key, taskMetadata(child)]))
  if (item.subagent && typeof item.subagent === "object") next.subagent = taskMetadata(item.subagent)
  if (item.workflow && typeof item.workflow === "object" && !Array.isArray(item.workflow)) {
    const workflow = { ...item.workflow } as Record<string, unknown>
    if (workflow.progress && typeof workflow.progress === "object" && !Array.isArray(workflow.progress)) {
      const progress = { ...workflow.progress } as Record<string, unknown>
      // Runtime checkpoints hold enforcement counters and are never a public usage receipt.
      delete progress.runtime
      delete progress.tokens
      workflow.progress = progress
    }
    next.workflow = workflow
  }
  return next
}
