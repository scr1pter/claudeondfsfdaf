import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  capturedGatewayModel,
  gatewayPlanModels,
  verifiedGatewayModel,
} from "../../../api/_lib/model-plan-catalog-policy"
import { configuredPlanModels, modelAccess } from "../../../api/_lib/model-plan-config"

const previous = process.env.MODEL_PLAN_MODELS_JSON
beforeEach(() => delete process.env.MODEL_PLAN_MODELS_JSON)
afterEach(() => {
  delete process.env.MODEL_PLAN_MODELS_JSON
  if (previous !== undefined) process.env.MODEL_PLAN_MODELS_JSON = previous
})

test("real active models inherit the owner's Pro access policy without activating the fifteen candidates", () => {
  const active = gatewayPlanModels()
  expect(active).toHaveLength(5)
  expect(active.map((model) => model.id)).toEqual(configuredPlanModels().map((model) => model.id))
  expect(active.every(capturedGatewayModel)).toBe(true)
  expect(active.some(verifiedGatewayModel)).toBe(false)
  expect(active[2]!.contextLength).toBe(128000)
  for (const model of active) {
    const premium = model.id.startsWith("moonshotai/") || model.id.startsWith("google/")
    expect(modelAccess(model, "vector-10")).toBe(!premium)
    expect(modelAccess(model, "vector-50")).toBe(true)
    expect(model.minPlan).toBe(premium ? "vector-50" : "vector-10")
  }
})

test("unverified staged routes and altered runtime routing policies never acquire qualification from an ID", () => {
  expect(
    configuredPlanModels({ tiered: true })
      .filter(verifiedGatewayModel)
      .map((model) => model.id),
  ).toEqual([])
  const model = gatewayPlanModels()[0]!
  for (const change of [
    { id: "fixture/unverified" },
    { upstream: model.id },
    { providerOnly: ["unqualified/new-route"] },
    { contextLength: 512000 },
    { inputPrice: 0.01 },
    { reasoningEffort: "xhigh" as const },
  ])
    expect(capturedGatewayModel({ ...model, ...change })).toBe(false)
})
