import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { CODIUM_MODELS, CODIUM_TIER_MODELS } from "../../../api/_lib/codium-catalog"
import {
  CAPTURED_RESERVATIONS,
  RESERVATION_CAPTURE,
  ROUTE_ACCEPTANCES,
  capturedReservationMicro,
} from "../../../api/_lib/codium-reservations"
import { modelPlanRequestCredits, nominalModelPlanRequestCredits } from "../../../api/_lib/model-plan-config"
import { gatewayPlanModels, verifiedGatewayModel } from "../../../api/_lib/model-plan-catalog-policy"
import snapshot from "./fixtures/codium-endpoints-2026-10-23.json"

test("reservation bounds match the pinned historical bytes and every captured native limit/rate tier", async () => {
  const bytes = await Bun.file(new URL("./fixtures/codium-endpoints-2026-10-23.json", import.meta.url)).arrayBuffer()
  expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(RESERVATION_CAPTURE.sha256)
  for (const [id, bound] of Object.entries(CAPTURED_RESERVATIONS)) {
    const model = snapshot.models.find((model) => model.id === id)!
    const endpoint = snapshot.endpoints.find((endpoint) => endpoint.model_id === id && endpoint.tag === bound.tag)!
    expect(bound.contextLength).toBe(Math.min(model.context_length, endpoint.context_length))
    expect(bound.maxOutputTokens).toBe(endpoint.max_completion_tokens)
    const pricing: Record<string, unknown> = endpoint.pricing
    const tiers: Record<string, unknown>[] = [pricing, ...(Array.isArray(pricing.overrides) ? pricing.overrides : [])]
    const input = tiers.flatMap((tier) =>
      Object.entries(tier)
        .filter(([key]) => key === "prompt" || key.startsWith("input_cache_"))
        .map(([, price]) => Number(price) * 1_000_000),
    )
    const output = tiers.flatMap((tier) =>
      Object.entries(tier)
        .filter(([key]) => key === "completion" || key === "internal_reasoning")
        .map(([, price]) => Number(price) * 1_000_000),
    )
    expect(bound.inputPrice).toBe(Math.max(...input))
    expect(bound.outputPrice).toBe(Math.max(...output))
  }
})

test.each([
  { index: 0, micro: 334234 },
  { index: 1, micro: 1040000 },
  { index: 2, micro: 268644 },
  { index: 3, micro: 2179072 },
  { index: 4, micro: 2179072 },
])("active model $index uses one larger fixed reservation rounded up to $micro micro-dollars", ({ index, micro }) => {
  const model = CODIUM_MODELS[index]!
  expect(capturedReservationMicro(model)).toBe(micro)
  for (const plan of ["vector-10", "vector-50", "vector-100", "vector-200"] as const)
    expect(modelPlanRequestCredits(model, plan)).toBe(
      (micro * (plan === "vector-100" || plan === "vector-200" ? 2 : 1)) / 1_000_000,
    )
  expect(modelPlanRequestCredits(model)).toBe((micro * 2) / 1_000_000)
})

test("historical bounds never fabricate acceptance or a native bound for absent models and fast routes", () => {
  expect(ROUTE_ACCEPTANCES).toEqual([])
  expect(gatewayPlanModels().some(verifiedGatewayModel)).toBe(false)
  // Sol stays staged until its OpenRouter ZDR endpoint is captured (owner, 30 Oct): no bound is invented for it.
  for (const id of [
    "openai/gpt-6.1-sol",
    "openai/gpt-6.1-sol:deep",
    "openai/gpt-6.1-sol:deepest",
    "moonshotai/kimi-k3.1-pro:fast",
    "google/gemini-4-argon:fast",
  ])
    expect(capturedReservationMicro(CODIUM_TIER_MODELS.find((model) => model.id === id)!)).toBeUndefined()
})

test("the approximate prompt cap does not discard the higher Haiku/Luna captured pricing tiers", () => {
  expect(CAPTURED_RESERVATIONS["anthropic/claude-haiku-5.5"]!.inputPrice).toBe(1)
  expect(CAPTURED_RESERVATIONS["anthropic/claude-haiku-5.5"]!.outputPrice).toBe(2.5)
  expect(CAPTURED_RESERVATIONS["openai/gpt-6-luna"]!.inputPrice).toBe(0.25)
  expect(CAPTURED_RESERVATIONS["openai/gpt-6-luna"]!.outputPrice).toBe(0.75)
})

test("missing native facts cannot masquerade as a real hold through the explicitly nominal planning helper", () => {
  const model = { ...CODIUM_MODELS[0], id: "fixture/unverified" }
  expect(() => modelPlanRequestCredits(model, "vector-10")).toThrow("could not be verified")
  expect(nominalModelPlanRequestCredits(model, "vector-10")).toBeGreaterThan(0)
  expect(verifiedGatewayModel(model)).toBe(false)
})
