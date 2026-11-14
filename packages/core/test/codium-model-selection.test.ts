import { expect, test } from "bun:test"
import { CodiumAuto } from "../src/codium-auto"
import { CodiumModelSelection } from "../src/codium-model-selection"
import { ModelPlanStatus } from "../src/model-plan-status"

const floor = {
  id: "fixture/floor",
  name: "Floor",
  contextLength: 10_000,
  maxOutputTokens: 1_000,
  role: "floor" as const,
  evidence: "keep-this-field",
}
const middle = { id: "fixture/default", name: "Default", contextLength: 20_000, maxOutputTokens: 1_000 }
const ceiling = { id: "fixture/ceiling", name: "Ceiling", contextLength: 40_000, maxOutputTokens: 1_000 }
const auto = {
  id: ModelPlanStatus.AUTO_ID,
  name: "Auto",
  contextLength: 10_000,
  maxOutputTokens: 1_000,
  auto: { floor: floor.id, default: middle.id, ceiling: ceiling.id },
}
const catalog = { enabled: true, plan: "vector-10", models: [floor, middle, ceiling, auto] }

test("client and structural API selection preserve window boundaries, tiers and the original complete model", () => {
  for (const entry of [
    { tier: "chat" as const, contextTokens: 8_000, expected: floor },
    { tier: "chat" as const, contextTokens: 8_001, expected: middle },
    { tier: "standard" as const, contextTokens: 16_001, expected: ceiling },
    { tier: "thorough" as const, contextTokens: 100_000, expected: ceiling },
  ]) {
    expect(CodiumAuto.resolve({ catalog, ...entry })).toBe(entry.expected)
    expect(CodiumModelSelection.resolve({ catalog, autoId: ModelPlanStatus.AUTO_ID, ...entry })).toBe(entry.expected)
  }
  expect(CodiumAuto.WINDOW_SHARE).toBe(0.8)
  expect(CodiumModelSelection.WINDOW_SHARE).toBe(CodiumAuto.WINDOW_SHARE)
  expect(CodiumModelSelection.brain({ ...catalog, models: [floor] }, ModelPlanStatus.AUTO_ID)?.evidence).toBe(
    "keep-this-field",
  )
})

test("learned suggestions retain the saving threshold and current context/access boundaries in both entry points", () => {
  for (const [saving, contextTokens, expected] of [
    [0.2, 100, floor],
    [0.19, 100, middle],
    [0.3, 9_000, middle],
  ] as const) {
    const input = {
      catalog,
      tier: "standard" as const,
      contextTokens,
      learned: [{ instead: middle.id, model: floor.id, saving }],
    }
    expect(CodiumAuto.resolve(input)).toBe(expected)
    expect(CodiumModelSelection.resolve({ ...input, autoId: ModelPlanStatus.AUTO_ID })).toBe(expected)
  }
  const unavailable = { ...catalog, models: [{ ...floor, manualOnly: true as const }, middle, ceiling, auto] }
  expect(CodiumAuto.helper(unavailable)).toBe(middle)
  expect(CodiumModelSelection.helper(unavailable, ModelPlanStatus.AUTO_ID)).toBe(middle)
  expect(CodiumAuto.brain(unavailable)).toBeUndefined()
  expect(CodiumModelSelection.brain(unavailable, ModelPlanStatus.AUTO_ID)).toBeUndefined()
})

test("the shared strict Brain and playbook selectors retain current-plan gates and refuse an Auto self-reference", () => {
  expect(CodiumAuto.brain(catalog)).toBe(floor)
  expect(CodiumModelSelection.brain(catalog, ModelPlanStatus.AUTO_ID)).toBe(floor)
  for (const changed of [
    { ...catalog, enabled: false },
    { ...catalog, plan: null },
    { ...catalog, plan: undefined },
  ]) {
    expect(CodiumAuto.brain(changed)).toBeUndefined()
    expect(CodiumModelSelection.brain(changed, ModelPlanStatus.AUTO_ID)).toBeUndefined()
    expect(CodiumAuto.role(changed, "default")).toBeUndefined()
    expect(CodiumModelSelection.role(changed, "default", ModelPlanStatus.AUTO_ID)).toBeUndefined()
  }
  expect(CodiumAuto.role(catalog, "ceiling")).toBe(ceiling)
  expect(CodiumModelSelection.role(catalog, "ceiling", ModelPlanStatus.AUTO_ID)).toBe(ceiling)
  const self = {
    ...catalog,
    models: [{ ...auto, role: "floor" as const, auto: { floor: auto.id, default: auto.id, ceiling: auto.id } }],
  }
  expect(CodiumAuto.resolve({ catalog: self, tier: "standard", contextTokens: 0 })).toBeUndefined()
  expect(
    CodiumModelSelection.resolve({ catalog: self, autoId: auto.id, tier: "standard", contextTokens: 0 }),
  ).toBeUndefined()
  expect(CodiumAuto.brain(self)).toBeUndefined()
  expect(CodiumModelSelection.brain(self, auto.id)).toBeUndefined()
})
