export * as CodiumModelSelection from "./codium-model-selection"

// Structural and import-free: the API and every client use the same choices without importing a client runtime.
const ROLES = ["floor", "default", "ceiling"] as const
export type Role = (typeof ROLES)[number]
export type Suggestion = { readonly instead: string; readonly model: string; readonly saving: number }
export type Model = {
  readonly id: string
  readonly contextLength: number
  readonly role?: string
  readonly locked?: unknown
  readonly manualOnly?: boolean
  readonly auto?: { readonly floor: string; readonly default: string; readonly ceiling: string }
}
export type Catalog<M extends Model> = {
  readonly enabled: boolean
  readonly plan?: string | null
  readonly models: readonly M[]
}
const START = { chat: "floor", light: "floor", standard: "default", thorough: "ceiling" } as const
export const WINDOW_SHARE = 0.8

/** Existing Auto window, access and learned-savings policy; returns the original full model object. */
export function resolve<M extends Model>(input: {
  catalog: Catalog<M>
  autoId: string
  tier: keyof typeof START
  contextTokens: number
  learned?: readonly Suggestion[]
}) {
  const auto = input.catalog.models.find((model) => model.id === input.autoId)?.auto
  if (!auto) return undefined
  const models = ROLES.flatMap((role) => {
    const model = usable(input.catalog, auto[role], input.autoId)
    return model ? [{ role, model }] : []
  })
  const start = models.findIndex((item) => ROLES.indexOf(item.role) >= ROLES.indexOf(START[input.tier]))
  const fits = models
    .slice(start === -1 ? -1 : start)
    .find((item) => input.contextTokens <= item.model.contextLength * WINDOW_SHARE)
  const baseline = (fits ?? models.toSorted((a, b) => b.model.contextLength - a.model.contextLength)[0])?.model
  if (!baseline) return undefined
  const learned = input.learned?.find(
    (item) =>
      item.instead === baseline.id &&
      Number.isFinite(item.saving) &&
      item.saving >= 0.2 &&
      models.some(({ model }) => model.id === item.model && input.contextTokens <= model.contextLength * WINDOW_SHARE),
  )
  return learned ? models.find(({ model }) => model.id === learned.model)!.model : baseline
}

/** Generic helpers may use Auto's default fallback. Brain helpers below may not. */
export function helper<M extends Model>(catalog: Catalog<M>, autoId: string) {
  const auto = catalog.models.find((model) => model.id === autoId)?.auto
  return auto ? (usable(catalog, auto.floor, autoId) ?? usable(catalog, auto.default, autoId)) : undefined
}

export function brain<M extends Model>(catalog: Catalog<M>, autoId: string) {
  if (!catalog.enabled || !catalog.plan) return undefined
  return catalog.models.find((model) => model.role === "floor" && usable(catalog, model.id, autoId) === model)
}

export function role<M extends Model>(catalog: Catalog<M>, selected: Role, autoId: string) {
  if (!catalog.enabled || !catalog.plan) return undefined
  const auto = catalog.models.find((model) => model.id === autoId)?.auto
  return auto ? usable(catalog, auto[selected], autoId) : undefined
}

function usable<M extends Model>(catalog: Catalog<M>, id: string, autoId: string) {
  return catalog.models.find((model) => model.id === id && model.id !== autoId && !model.locked && !model.manualOnly)
}
