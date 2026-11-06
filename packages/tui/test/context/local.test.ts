import { expect, test } from "bun:test"
import { parseModel, recentModels, toggledFavorites } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

test("model fallback notices include slash-containing saved IDs and ignore stale lower-priority recents", async () => {
  const { unavailableModel, providerNoticeTracker } = await import("@vectordevai/schema/provider-unavailable")
  const missing = parseModel("openrouter/family/saved")
  const live = parseModel("anthropic/claude-sonnet-4")
  const valid = (model: { providerID: string }) => model.providerID === "anthropic"
  const declared = (providerID: string) => providerID === "anthropic" || providerID === "openrouter"
  expect(unavailableModel([missing, live], valid, declared)).toEqual({
    providerID: "openrouter",
    modelID: "family/saved",
  })
  expect(unavailableModel([live, missing], valid, declared)).toBeUndefined()
  const take = providerNoticeTracker()
  expect(take("server", "openrouter/family/saved")).toBe(true)
  expect(take("server", "openrouter/family/saved")).toBe(false)
})

test("a saved model from a retired provider falls back without a notice", async () => {
  const { unavailableModel } = await import("@vectordevai/schema/provider-unavailable")
  const retired = parseModel("retired-gateway/included/model")
  const live = parseModel("anthropic/claude-sonnet-4")
  const valid = (model: { providerID: string }) => model.providerID === "anthropic"
  expect(unavailableModel([retired, live], valid, (providerID) => providerID === "anthropic")).toBeUndefined()
})

test("a favorite is removed even when it is no longer valid; only adding one asks", () => {
  // Locked after a downgrade: no longer valid, but still under Favorites with its badge.
  const locked = parseModel("vector-plan/anthropic/claude-opus-5.5")
  const other = parseModel("anthropic/claude-sonnet-4")
  const valid = (model: { providerID: string }) => model.providerID !== "vector-plan"
  expect(toggledFavorites(locked, [locked, other], valid)).toEqual([other])
  expect(toggledFavorites(locked, [other], valid)).toBeUndefined()
  expect(toggledFavorites(other, [locked], valid)).toEqual([other, locked])
  expect(toggledFavorites(other, [locked, other], valid)).toEqual([locked])
})
