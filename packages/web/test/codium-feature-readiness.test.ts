import { afterEach, beforeEach, expect, test } from "bun:test"
import { CODIUM_AUTO_ROLES, CODIUM_TIER_MODELS } from "../../../api/_lib/codium-catalog"
import { codiumKey } from "../../../api/_lib/codium-keys"
import type { ModelPlanModel } from "../../../api/_lib/model-plan-config"
import {
  autoLearnModelsServed,
  brainHelpersServed,
  reviewPairsServed,
  reviewPanelServed,
} from "../../../api/_lib/model-plan-models"
import { codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"

const models: readonly ModelPlanModel[] = CODIUM_TIER_MODELS
const floor = CODIUM_AUTO_ROLES["vector-10"].floor
const defaultModel = CODIUM_AUTO_ROLES["vector-10"].default
// Only this test's explicit catalog is accepted. Production never injects this qualification seam.
const accepted = (model: ModelPlanModel) => models.some((candidate) => candidate.id === model.id)
const ports = [reviewPairsServed, brainHelpersServed, autoLearnModelsServed]
let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment()
})
afterEach(() => restore())

test("missing accepted production evidence keeps every model readiness port false without any inference", async () => {
  const fake = codiumFakes()
  for (const port of ports) expect(await port(fake.fetcher)).toBe(false)
  expect(fake.openRouter.calls).toEqual([])
  expect(fake.stripe.calls).toEqual([])
  expect(fake.store.commands.length).toBeGreaterThan(0)
  expect(fake.store.commands.every(([command]) => command === "SMEMBERS")).toBe(true)
})

test("actual qualified per-plan catalog reads can prove model capacity without starting an account operation", async () => {
  const fake = codiumFakes()
  for (const port of ports) expect(await port(fake.fetcher, { models, qualify: accepted })).toBe(true)
  expect(fake.openRouter.calls).toEqual([])
  expect(fake.stripe.calls).toEqual([])
  expect(fake.store.commands.every(([command]) => command === "SMEMBERS")).toBe(true)
})

test("two-lab reviews do not require the optional third-lab panel models", async () => {
  const fake = codiumFakes()
  const pairOnly = models.filter((model) => model.lab === "deepseek" || model.lab === "openai")
  expect(await reviewPairsServed(fake.fetcher, { models: pairOnly, qualify: accepted })).toBe(true)
  expect(await reviewPanelServed(fake.fetcher, { models: pairOnly, qualify: accepted })).toBe(false)
  const sameLab = models.map((model) => (model.id === floor ? { ...model, lab: "deepseek" as const } : model))
  expect(await reviewPairsServed(codiumFakes().fetcher, { models: sameLab, qualify: accepted })).toBe(false)
  const unknownLab = models.map((model) => (model.id === floor ? { ...model, lab: undefined } : model))
  expect(await reviewPairsServed(codiumFakes().fetcher, { models: unknownLab, qualify: accepted })).toBe(false)
})

test("a missing real floor disables Brain helpers while Auto keeps its qualified default fallback", async () => {
  const fake = codiumFakes()
  const withoutFloor = models.filter((model) => model.id !== floor)
  expect(await brainHelpersServed(fake.fetcher, { models: withoutFloor, qualify: accepted })).toBe(false)
  expect(await autoLearnModelsServed(fake.fetcher, { models: withoutFloor, qualify: accepted })).toBe(true)
  const noAutoRoles = withoutFloor.filter((model) => model.id !== defaultModel)
  expect(await autoLearnModelsServed(codiumFakes().fetcher, { models: noAutoRoles, qualify: accepted })).toBe(false)
})

test("a manual-only or locked floor cannot authorize a helper on every plan", async () => {
  const manual = models.map((model) => (model.id === floor ? { ...model, manualOnly: true } : model))
  expect(await brainHelpersServed(codiumFakes().fetcher, { models: manual, qualify: accepted })).toBe(false)
  expect(await autoLearnModelsServed(codiumFakes().fetcher, { models: manual, qualify: accepted })).toBe(true)
  expect(await reviewPairsServed(codiumFakes().fetcher, { models: manual, qualify: accepted })).toBe(false)
  const locked = models.map((model) => (model.id === floor ? { ...model, minPlan: "vector-200" as const } : model))
  expect(await brainHelpersServed(codiumFakes().fetcher, { models: locked, qualify: accepted })).toBe(false)
})

test("disabled and rejected routes cannot be replaced by a model with a matching label", async () => {
  const fake = codiumFakes()
  await fake.fetcher(process.env.KV_REST_API_URL!, {
    method: "POST",
    body: JSON.stringify(["SADD", codiumKey("models-off"), floor]),
  })
  expect(await brainHelpersServed(fake.fetcher, { models, qualify: accepted })).toBe(false)
  expect(await autoLearnModelsServed(fake.fetcher, { models, qualify: accepted })).toBe(true)
  expect(await reviewPairsServed(fake.fetcher, { models, qualify: accepted })).toBe(false)
  expect(
    await brainHelpersServed(codiumFakes().fetcher, {
      models,
      qualify: (model) => accepted(model) && model.id !== floor,
    }),
  ).toBe(false)
})

test("a store failure propagates to the existing fail-closed listing boundary", async () => {
  for (const port of ports) {
    const fake = codiumFakes()
    fake.store.down = true
    await expect(port(fake.fetcher, { models, qualify: accepted })).rejects.toThrow()
    expect(fake.openRouter.calls).toEqual([])
    expect(fake.stripe.calls).toEqual([])
  }
})
