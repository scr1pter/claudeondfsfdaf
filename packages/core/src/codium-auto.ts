export * as CodiumAuto from "./codium-auto"

import type { Tier } from "@vectordevai/schema/task-size"
import type { ModelPlans } from "./model-plans"
import { ModelPlanStatus } from "./model-plan-status"

// Pure choices over a decoded /models catalog, with no I/O, so the engine, Core V2 and the app pick the same model.
// Only type imports reach model-plans.ts, which needs Node; the app bundles this module for the browser.

const ROLES = ["floor", "default", "ceiling"] as const
export type Role = (typeof ROLES)[number]
export type Suggestion = { readonly instead: string; readonly model: string; readonly saving: number }
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
    if (step.providerID !== ModelPlanStatus.PROVIDER_ID || weight === undefined || !Number.isFinite(weight) || weight <= 0)
      return undefined
    const tokens = [step.input, step.output, step.reasoning, step.cacheRead]
    if (tokens.some((value) => !Number.isFinite(value) || value < 0)) return undefined
    return weight * (step.input + step.output + step.reasoning + 0.1 * step.cacheRead)
  })
  if (values.some((value) => value === undefined)) return undefined
  const total = values.reduce<number>((sum, value) => sum + value!, 0)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

// A chat or light message starts on the floor, a standard task on the default, a thorough one on the ceiling.
const START: Record<Tier, Role> = { chat: "floor", light: "floor", standard: "default", thorough: "ceiling" }

/** The share of a model's context window a message may fill before Auto moves to a model with a larger one. */
export const WINDOW_SHARE = 0.8

/**
 * The model Codium Auto uses for one user message: the role its size starts on, then the next role up whose window
 * holds the context within WINDOW_SHARE; when none does, the role with the largest window. Never a locked, manual-only
 * or unlisted model, and never Auto itself; undefined when the catalog offers no Auto.
 */
export function resolve(input: { catalog: ModelPlans.Catalog; tier: Tier; contextTokens: number; learned?: readonly Suggestion[] }) {
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
  const baseline = (fits ?? models.toSorted((a, b) => b.model.contextLength - a.model.contextLength)[0])?.model
  if (!baseline) return undefined
  // Suggestions are only candidates: the current account catalog and this request's context remain authoritative.
  const learned = input.learned?.find((item) => item.instead === baseline.id && Number.isFinite(item.saving) && item.saving >= 0.2 &&
    models.some(({ model }) => model.id === item.model && input.contextTokens <= model.contextLength * WINDOW_SHARE))
  return learned ? models.find(({ model }) => model.id === learned.model)!.model : baseline
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

/** A Brain helper requires a real qualified floor, never Auto's substituted default or an arbitrary paid model. */
export function brain(catalog: ModelPlans.Catalog) {
  if (!catalog.enabled || !catalog.plan) return undefined
  return catalog.models.find((model) => model.role === "floor" && usable(catalog, model.id) === model)
}

function usable(catalog: ModelPlans.Catalog, id: string) {
  return catalog.models.find(
    (model) => model.id === id && model.id !== ModelPlanStatus.AUTO_ID && !model.locked && !model.manualOnly,
  )
}

/** A saved first-party playbook resolves its role against the current account's Auto pointers. */
export function role(catalog: ModelPlans.Catalog, role: Role) {
  if (!catalog.enabled || !catalog.plan) return undefined
  const auto = catalog.models.find((model) => model.id === ModelPlanStatus.AUTO_ID)?.auto
  return auto ? usable(catalog, auto[role]) : undefined
}
