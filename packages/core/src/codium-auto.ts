export * as CodiumAuto from "./codium-auto"

import type { Tier } from "@vectordevai/schema/task-size"
import type { ModelPlans } from "./model-plans"
import { ModelPlanStatus } from "./model-plan-status"
import { CodiumModelSelection } from "./codium-model-selection"

// Pure choices over a decoded /models catalog, with no I/O, so the engine, Core V2 and the app pick the same model.
// Only type imports reach model-plans.ts, which needs Node; the app bundles this module for the browser.

export type Role = CodiumModelSelection.Role
export type Suggestion = CodiumModelSelection.Suggestion
export type Usage = {
  readonly providerID: string
  readonly modelID: string
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
}

/** Private relative usage, never currency or a displayed token allowance. Unknown steps make the total unknown. */
export function units(catalog: ModelPlans.Catalog, steps: readonly Usage[]) {
  if (!steps.length) return undefined
  const values = steps.map((step) => {
    const weight = catalog.models.find((model) => model.id === step.modelID)?.weight
    if (
      step.providerID !== ModelPlanStatus.PROVIDER_ID ||
      weight === undefined ||
      !Number.isFinite(weight) ||
      weight <= 0
    )
      return undefined
    const tokens = [step.input, step.output, step.reasoning, step.cacheRead]
    if (tokens.some((value) => !Number.isFinite(value) || value < 0)) return undefined
    return weight * (step.input + step.output + step.reasoning + 0.1 * step.cacheRead)
  })
  if (values.some((value) => value === undefined)) return undefined
  const total = values.reduce<number>((sum, value) => sum + value!, 0)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

/** The share of a model's context window a message may fill before Auto moves to a model with a larger one. */
export const WINDOW_SHARE = CodiumModelSelection.WINDOW_SHARE

/**
 * The model Codium Auto uses for one user message: the role its size starts on, then the next role up whose window
 * holds the context within WINDOW_SHARE; when none does, the role with the largest window. Never a locked, manual-only
 * or unlisted model, and never Auto itself; undefined when the catalog offers no Auto.
 */
export function resolve(input: {
  catalog: ModelPlans.Catalog
  tier: Tier
  contextTokens: number
  learned?: readonly Suggestion[]
}) {
  return CodiumModelSelection.resolve({ ...input, autoId: ModelPlanStatus.AUTO_ID })
}

/**
 * The model for a helper call (a title, a memory note, an explore subagent) in a Codium conversation: Auto's floor,
 * then its default. Undefined when neither is usable, so the caller skips the helper instead of spending more.
 */
export function helper(catalog: ModelPlans.Catalog) {
  return CodiumModelSelection.helper(catalog, ModelPlanStatus.AUTO_ID)
}

/** A Brain helper requires a real qualified floor, never Auto's substituted default or an arbitrary paid model. */
export function brain(catalog: ModelPlans.Catalog) {
  return CodiumModelSelection.brain(catalog, ModelPlanStatus.AUTO_ID)
}

/** A saved first-party playbook resolves its role against the current account's Auto pointers. */
export function role(catalog: ModelPlans.Catalog, role: Role) {
  return CodiumModelSelection.role(catalog, role, ModelPlanStatus.AUTO_ID)
}
