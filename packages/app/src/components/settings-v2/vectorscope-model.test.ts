import { describe, expect, test } from "bun:test"
import { readVectorScope, vectorScopeKey, vectorScopeLocked, vectorScopePatch } from "./vectorscope-model"

describe("owner VectorScope settings", () => {
  test("waits for saved config and keeps the service choice independent of generic Review", () => {
    expect(readVectorScope(undefined)).toBeUndefined()
    expect(readVectorScope({ agent: { review: { model: "owner/generic", variant: "high", disable: true } } })).toEqual({
      model: "",
      variant: "",
      disabled: false,
    })
    expect(
      readVectorScope({ agent: { vectorscope: { model: "local/reviewer", variant: "low", disable: true } } }),
    ).toEqual({ model: "local/reviewer", variant: "low", disabled: true })
  })
  test("writes only the three owner fields, preserving other agent and permission settings through the global merge", () => {
    const patch = vectorScopePatch({ model: " local/reviewer ", variant: " low ", disabled: true })
    expect(patch).toEqual({ agent: { vectorscope: { model: "local/reviewer", variant: "low", disable: true } } })
    expect(Object.keys(patch.agent!)).toEqual(["vectorscope"])
    expect(patch.agent!.vectorscope).not.toHaveProperty("permission")
    expect(patch.agent!.vectorscope).not.toHaveProperty("prompt")
  })
  test("using the account default clears a stale variant using explicit empty values the API retains", () => {
    const patch = vectorScopePatch({ model: "", variant: "old-model-variant", disabled: false })
    expect(JSON.parse(JSON.stringify(patch))).toEqual({
      agent: { vectorscope: { model: "", variant: "", disable: false } },
    })
  })
  test("recognizes parent and field locks without locking unrelated settings", () => {
    for (const path of [
      "agent",
      "agent.vectorscope",
      "agent.vectorscope.model",
      "agent.vectorscope.variant",
      "agent.vectorscope.disable",
    ])
      expect(vectorScopeLocked([path])).toBe(true)
    expect(vectorScopeLocked(["model", "agent.review.model"])).toBe(false)
    expect(vectorScopeKey({ model: "a/b", variant: "", disabled: false })).not.toBe(
      vectorScopeKey({ model: "a", variant: "b", disabled: false }),
    )
  })
})
