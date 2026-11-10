export * as CodiumAuto from "./codium-auto"

import type { Tier } from "@vectordevai/schema/task-size"
import type { ModelPlans } from "./model-plans"
import { ModelPlanStatus } from "./model-plan-status"

// Pure choices over a decoded /models catalog, with no I/O, so the engine, Core V2 and the app pick the same model.
// Only type imports reach model-plans.ts, which needs Node; the app bundles this module for the browser.

const ROLES = ["floor", "default", "ceiling"] as const
export type Role = (typeof ROLES)[number]

// A chat or light message starts on the floor, a standard task on the default, a thorough one on the ceiling.
const START: Record<Tier, Role> = { chat: "floor", light: "floor", standard: "default", thorough: "ceiling" }

/** The share of a model's context window a message may fill before Auto moves to a model with a larger one. */
export const WINDOW_SHARE = 0.8

/**
 * The model Codium Auto uses for one user message: the role its size starts on, then the next role up whose window
 * holds the context within WINDOW_SHARE; when none does, the role with the largest window. Never a locked, manual-only
 * or unlisted model, and never Auto itself; undefined when the catalog offers no Auto.
 */
export function resolve(input: { catalog: ModelPlans.Catalog; tier: Tier; contextTokens: number }) {
  const auto = input.catalog.models.find((model) => model.id === ModelPlanStatus.AUTO_ID)?.auto
  if (!auto) return undefined
  const models = ROLES.flatMap((role) => {
    const model = usable(input.catalog, auto[role])
    return model ? [{ role, model }] : []
  })
  const start = models.findIndex((item) => ROLES.indexOf(item.role) >= ROLES.indexOf(START[input.tier]))
  // Without a usable role at or above the start, the highest usable one is tried.
  const fits = models
    .slice(start === -1 ? -1 : start)
    .find((item) => input.contextTokens <= item.model.contextLength * WINDOW_SHARE)
  return (fits ?? models.toSorted((a, b) => b.model.contextLength - a.model.contextLength)[0])?.model
}

/**
 * The model for a helper call (a title, a memory note, an explore subagent) in a Codium conversation: Auto's floor,
 * then its default. Undefined when neither is usable, so the caller skips the helper instead of spending more.
 */
export function helper(catalog: ModelPlans.Catalog) {
  const auto = catalog.models.find((model) => model.id === ModelPlanStatus.AUTO_ID)?.auto
  if (!auto) return undefined
  return usable(catalog, auto.floor) ?? usable(catalog, auto.default)
}

function usable(catalog: ModelPlans.Catalog, id: string) {
  return catalog.models.find(
    (model) => model.id === id && model.id !== ModelPlanStatus.AUTO_ID && !model.locked && !model.manualOnly,
  )
}
