export * as WorkflowProgress from "./progress"

import type { Workflow } from "@vectordevai/schema/workflow"
import type { WorkflowLimits } from "./limits"

export type Node = {
  readonly key: string
  readonly stage: string
  readonly phase?: string
  readonly item?: string
  readonly status: "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "skipped" | "interrupted"
  readonly round?: number
  readonly verified?: boolean
  readonly error?: string
}
export type Stage = {
  readonly id: string
  readonly title: string
  readonly phase?: string
  readonly total?: number
  readonly done: number
  readonly failed: number
  readonly skipped: number
  readonly running: number
  readonly waiting: number
}
export type Progress = {
  readonly stage?: string
  readonly phase?: string
  readonly item?: string
  readonly round?: number
  readonly verified?: boolean
  readonly stages: readonly Stage[]
  readonly agents: { readonly launched: number; readonly max: number; readonly running: number }
  readonly tokens: { readonly used: number; readonly max?: number }
  readonly stop?: { readonly reason: string; readonly message: string }
}

/** Rebuild from durable node state; retries overwrite a node key instead of double counting it. */
export function of(
  plan: Workflow.Plan,
  nodes: readonly Node[],
  usage: WorkflowLimits.Usage,
  stop?: WorkflowLimits.Stop,
): Progress {
  const current = [...new Map(nodes.map((node) => [node.key, node])).values()]
  const active = current.find((node) => node.status === "waiting") ?? current.find((node) => node.status === "running")
  return {
    stage: active?.stage,
    phase: active?.phase,
    item: active?.item,
    round: active?.round,
    verified: active?.verified,
    stages: plan.stages.map((stage) => {
      const own = current.filter((node) => node.stage === stage.id)
      const count = (status: Node["status"]) => own.filter((node) => node.status === status).length
      return {
        id: stage.id,
        title: stage.title,
        phase: stage.phase,
        total: stage.items === "dynamic" ? undefined : stage.items,
        done: count("completed"),
        failed: count("failed"),
        skipped: count("skipped") + count("cancelled") + count("interrupted"),
        running: count("running"),
        waiting: count("waiting"),
      }
    }),
    agents: {
      launched: usage.launched,
      max: plan.maxAgents,
      running: current.filter((node) => node.status === "running" || node.status === "waiting").length,
    },
    tokens: { used: usage.tokens, max: plan.tokens },
    stop: stop ? { reason: stop.reason, message: stop.message } : undefined,
  }
}
