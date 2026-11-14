import { expect, test } from "bun:test"
import { CodiumAuto } from "../src/codium-auto"
import { ModelPlans } from "../src/model-plans"

const model = (id: string, contextLength: number, extra: Partial<ModelPlans.Model> = {}): ModelPlans.Model => ({
  id,
  name: id,
  contextLength,
  maxOutputTokens: 1000,
  ...extra,
})
const floor = model("vendor/floor", 10_000)
const middle = model("vendor/default", 20_000)
const ceiling = model("vendor/ceiling", 40_000)
const auto = (roles = { floor: floor.id, default: middle.id, ceiling: ceiling.id }) =>
  model(ModelPlans.AUTO_ID, 10_000, { auto: roles })
const catalog = (models: ModelPlans.Model[]): ModelPlans.Catalog => ({ enabled: true, models })
const plan = catalog([middle, auto(), floor, ceiling])

test("learned roles still obey the current catalog, context window and saving threshold", () => {
  const learned = [{ instead: middle.id, model: floor.id, saving: 0.3 }]
  expect(CodiumAuto.resolve({ catalog: plan, tier: "standard", contextTokens: 100, learned })?.id).toBe(floor.id)
  expect(CodiumAuto.resolve({ catalog: plan, tier: "standard", contextTokens: 9_000, learned })?.id).toBe(middle.id)
  for (const extra of [{ manualOnly: true as const }, { locked: { plan: "vector-50", name: "Pro" } }])
    expect(CodiumAuto.resolve({ catalog: catalog([auto(), middle, { ...floor, ...extra }]), tier: "standard", contextTokens: 10, learned })?.id).toBe(middle.id)
  expect(CodiumAuto.resolve({ catalog: plan, tier: "standard", contextTokens: 10, learned: [{ ...learned[0]!, saving: 0.19 }] })?.id).toBe(middle.id)
  expect(CodiumAuto.resolve({ catalog: plan, tier: "standard", contextTokens: 10, learned: [{ ...learned[0]!, model: "not-listed" }] })?.id).toBe(middle.id)
})

test("relative usage is known only for entirely measured Codium work", () => {
  const weighted = catalog([{ ...floor, weight: 1 }, { ...middle, weight: 2 }])
  const step = { providerID: ModelPlans.PROVIDER_ID, modelID: floor.id, input: 100, output: 20, reasoning: 10, cacheRead: 100 }
  expect(CodiumAuto.units(weighted, [step, { ...step, modelID: middle.id }])).toBe(420)
  for (const bad of [{ providerID: "own-key" }, { modelID: "unknown" }, { input: NaN }, { output: -1 }])
    expect(CodiumAuto.units(weighted, [step, { ...step, ...bad }])).toBeUndefined()
  expect(CodiumAuto.units(weighted, [])).toBeUndefined()
  expect(CodiumAuto.units(plan, [step])).toBeUndefined()
})

test("a message starts on the role its size names", () => {
  const pick = (tier: "chat" | "light" | "standard" | "thorough") =>
    CodiumAuto.resolve({ catalog: plan, tier, contextTokens: 100 })?.id
  expect([pick("chat"), pick("light"), pick("standard"), pick("thorough")]).toEqual([
    floor.id,
    floor.id,
    middle.id,
    ceiling.id,
  ])
})

test("the window guard moves up at 80% of a model's window, to the token", () => {
  const pick = (contextTokens: number) => CodiumAuto.resolve({ catalog: plan, tier: "chat", contextTokens })?.id
  expect(pick(8_000)).toBe(floor.id)
  expect(pick(8_001)).toBe(middle.id)
  expect(pick(16_000)).toBe(middle.id)
  expect(pick(16_001)).toBe(ceiling.id)
  // Nothing holds it: the largest window, never a smaller one.
  expect(pick(50_000)).toBe(ceiling.id)
  // A larger default than ceiling is still the one with the most room when nothing fits.
  const wide = catalog([model(middle.id, 90_000), auto(), floor, ceiling])
  expect(CodiumAuto.resolve({ catalog: wide, tier: "thorough", contextTokens: 100_000 })?.id).toBe(middle.id)
  // A thorough message never steps down to a smaller model that would fit.
  expect(CodiumAuto.resolve({ catalog: plan, tier: "thorough", contextTokens: 33_000 })?.id).toBe(ceiling.id)
})

test("Auto never picks a locked, manual-only, unlisted model or itself", () => {
  const locked = catalog([middle, auto(), { ...floor, locked: { plan: "vector-50", name: "Pro" } }, ceiling])
  expect(CodiumAuto.resolve({ catalog: locked, tier: "chat", contextTokens: 100 })?.id).toBe(middle.id)
  const manual = catalog([middle, auto(), floor, { ...ceiling, manualOnly: true }])
  expect(CodiumAuto.resolve({ catalog: manual, tier: "thorough", contextTokens: 100 })?.id).toBe(middle.id)
  const unlisted = catalog([middle, auto(), floor])
  expect(CodiumAuto.resolve({ catalog: unlisted, tier: "thorough", contextTokens: 100 })?.id).toBe(middle.id)
  const itself = catalog([
    auto({ floor: ModelPlans.AUTO_ID, default: ModelPlans.AUTO_ID, ceiling: ModelPlans.AUTO_ID }),
  ])
  expect(CodiumAuto.resolve({ catalog: itself, tier: "chat", contextTokens: 100 })).toBeUndefined()
  // No Auto entry: nothing to resolve.
  expect(CodiumAuto.resolve({ catalog: catalog([floor, middle]), tier: "chat", contextTokens: 100 })).toBeUndefined()
})

test("a helper call uses Auto's floor, then its default, and is skipped when neither is usable", () => {
  expect(CodiumAuto.helper(plan)?.id).toBe(floor.id)
  expect(CodiumAuto.helper(catalog([middle, auto(), { ...floor, manualOnly: true }, ceiling]))?.id).toBe(middle.id)
  // The ceiling is never a helper, however cheap it looks.
  const neither = catalog([
    { ...middle, locked: { plan: "vector-100", name: "Max" } },
    auto(),
    { ...floor, locked: { plan: "vector-100", name: "Max" } },
    ceiling,
  ])
  expect(CodiumAuto.helper(neither)).toBeUndefined()
  expect(CodiumAuto.helper(catalog([floor, middle]))).toBeUndefined()
})

test("Brain requires a qualified actual floor and a current plan, never Auto's substituted default", () => {
  const ready = { ...catalog([{ ...floor, role: "floor" }, middle, auto()]), plan: "vector-10" }
  expect(CodiumAuto.brain(ready)?.id).toBe(floor.id)
  expect(CodiumAuto.brain({ ...ready, enabled: false })).toBeUndefined()
  expect(CodiumAuto.brain({ ...ready, plan: null })).toBeUndefined()
  expect(CodiumAuto.brain({ ...ready, plan: undefined })).toBeUndefined()
  expect(
    CodiumAuto.brain({
      ...ready,
      models: [middle, auto({ floor: middle.id, default: middle.id, ceiling: middle.id })],
    }),
  ).toBeUndefined()
  for (const extra of [{ manualOnly: true as const }, { locked: { plan: "vector-50", name: "Pro" } }])
    expect(
      CodiumAuto.brain({ ...ready, models: [{ ...floor, role: "floor", ...extra }, middle, auto()] }),
    ).toBeUndefined()
})
