export * as SecondOpinion from "./second-opinion"

import { labOf } from "@vectordevai/core/model-lab"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { SessionV1 } from "@vectordevai/core/v1/session"

// Second opinion (WP A35): when Vector's judge checks work a Vector Codium model did, it runs on the plan's judge from
// another lab instead of on the worker's own model. It applies only when every condition holds: the worker is a Codium
// model, no judge model is configured (agent.judge.model wins), the judge runs at all (LLM-as-a-judge on and the work
// qualifying), the person turned Second opinion on in Settings, and the catalog lists a usable judge for that worker
// from a lab other than the worker's. A judge from another lab spends several times what the worker's own step would,
// so nothing turns it on by itself. The gateway still decides whether the plan may use the judge's model.

/** Where the judge gate hands the task tool the judge's model. */
export const EXTRA = "judgeModel"

type Ref = { providerID: string; modelID: string }

/** What a listed Codium entry says about itself, as the provider lists it (ModelV2.Codium). */
type Entry = {
  id: string
  codium?: { lab?: string; judge?: string; locked?: unknown; manualOnly?: boolean; auto?: unknown }
}

/**
 * Whether the person had Second opinion on for the work being judged: what the newest message they wrote in it says.
 * The app stamps every prompt while the setting is on, so turning it off takes effect with the next message.
 */
export function enabled(users: readonly SessionV1.WithParts[]): boolean {
  const last = users.findLast((user) => user.info.role === "user")?.info
  return last?.role === "user" && last.secondOpinion === true
}

/**
 * The model the judge runs on for Second opinion, or undefined to keep the usual choice (the judge's own model, else
 * the worker's). `models` are the Vector Codium provider's listed entries; `configured` says agent.judge.model is set.
 */
export function judgeModel(input: {
  worker: Ref
  models: Readonly<Record<string, Entry>> | undefined
  configured: boolean
  on: boolean
}): Ref | undefined {
  if (!input.on || input.configured || input.worker.providerID !== ModelPlanStatus.PROVIDER_ID) return
  const worker = input.models?.[input.worker.modelID]
  const id = worker?.codium?.judge
  const judge = id && id !== input.worker.modelID ? input.models?.[id] : undefined
  if (!worker || !judge || judge.codium?.locked || judge.codium?.manualOnly || judge.codium?.auto) return
  const first = labOf(`${ModelPlanStatus.PROVIDER_ID}/${worker.id}`, worker.codium?.lab)
  const second = labOf(`${ModelPlanStatus.PROVIDER_ID}/${judge.id}`, judge.codium?.lab)
  if (!first || !second || first === second) return
  return { providerID: ModelPlanStatus.PROVIDER_ID, modelID: judge.id }
}

/** The judge model the gate handed the task tool, when the launch is the gate's own judge. */
export function fromExtra(extra: Record<string, unknown> | undefined): Ref | undefined {
  const value = extra?.[EXTRA]
  if (!value || typeof value !== "object") return
  const { providerID, modelID } = value as Record<string, unknown>
  if (providerID !== ModelPlanStatus.PROVIDER_ID || typeof modelID !== "string" || !modelID.trim()) return
  return { providerID, modelID }
}
