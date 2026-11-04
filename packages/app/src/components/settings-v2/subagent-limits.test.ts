import { describe, expect, test } from "bun:test"
import {
  SUBAGENT_LIMIT_DEFAULTS,
  howManyFact,
  ownerFromStatus,
  parseSubagentLimit,
  parseSubagentLimits,
  readSubagentLimits,
  subagentLimitsChanged,
  subagentLimitsPatch,
  subagentLimitsResetPatch,
} from "./subagent-limits"

describe("subagent limits", () => {
  // The engine's SubagentDefaults (packages/core/src/v1/config/config.ts). The app does not import the config module,
  // which pulls engine-only files into the app's program, so the values are stated here.
  test("defaults are 8 running, 32 per request and $25", () => {
    expect(SUBAGENT_LIMIT_DEFAULTS).toEqual({ running: 8, perRequest: 32, usd: 25 })
    expect(readSubagentLimits(undefined)).toEqual({ running: 8, perRequest: 32, usd: 25 })
    expect(readSubagentLimits({})).toEqual({ running: 8, perRequest: 32, usd: 25 })
  })

  test("reads what the global config sets, field by field", () => {
    expect(readSubagentLimits({ budget: { subagents: { running: 4 } } })).toEqual({
      running: 4,
      perRequest: 32,
      usd: 25,
    })
    expect(
      readSubagentLimits({ budget: { subagents: { running: 12, per_request: 200, usd: 7.5, steps: 9 } } }),
    ).toEqual({
      running: 12,
      perRequest: 200,
      usd: 7.5,
    })
  })

  test("the patch is exactly {budget: {subagents: {running, per_request, usd}}}", () => {
    expect(subagentLimitsPatch({ running: 3, perRequest: 40, usd: 12.5 })).toEqual({
      budget: { subagents: { running: 3, per_request: 40, usd: 12.5 } },
    })
    // Nothing else of the budget or the config is written, so the deep merge keeps steps, warnAt and the rest.
    const patch = subagentLimitsPatch({ running: 3, perRequest: 40, usd: 12.5 })
    expect(Object.keys(patch)).toEqual(["budget"])
    expect(Object.keys(patch.budget!)).toEqual(["subagents"])
    expect(Object.keys(patch.budget!.subagents!).sort()).toEqual(["per_request", "running", "usd"])
  })

  test("ranges: running 1 to 16 and per request 1 to 1000, whole numbers; USD above 0", () => {
    expect(parseSubagentLimit("running", "1")).toEqual({ ok: true, value: 1 })
    expect(parseSubagentLimit("running", "16")).toEqual({ ok: true, value: 16 })
    expect(parseSubagentLimit("running", "0").ok).toBe(false)
    expect(parseSubagentLimit("running", "17").ok).toBe(false)
    expect(parseSubagentLimit("running", "2.5").ok).toBe(false)
    expect(parseSubagentLimit("running", "many").ok).toBe(false)
    expect(parseSubagentLimit("perRequest", "1000")).toEqual({ ok: true, value: 1000 })
    expect(parseSubagentLimit("perRequest", "1,000")).toEqual({ ok: true, value: 1000 })
    expect(parseSubagentLimit("perRequest", "1001").ok).toBe(false)
    expect(parseSubagentLimit("usd", "$12.50")).toEqual({ ok: true, value: 12.5 })
    expect(parseSubagentLimit("usd", "0").ok).toBe(false)
    expect(parseSubagentLimit("usd", "-3").ok).toBe(false)
    expect(parseSubagentLimit("usd", "abc").ok).toBe(false)
    const refused = parseSubagentLimit("running", "20")
    expect(refused.ok === false && refused.message).toBe("Enter a whole number from 1 to 16.")
  })

  test("a blank field keeps the default; the first invalid field is named", () => {
    expect(parseSubagentLimits({ running: "", perRequest: "", usd: "" })).toEqual({
      ok: true,
      limits: { running: 8, perRequest: 32, usd: 25 },
    })
    expect(parseSubagentLimits({ running: "4", perRequest: "2000", usd: "0" })).toMatchObject({
      ok: false,
      key: "perRequest",
    })
  })

  test("Reset writes the explicit defaults, since the deep-merged update cannot remove a key", () => {
    expect(subagentLimitsResetPatch()).toEqual({ budget: { subagents: { running: 8, per_request: 32, usd: 25 } } })
  })

  test("a save that changes nothing the engine runs with is skipped", () => {
    expect(subagentLimitsChanged({}, { running: 8, perRequest: 32, usd: 25 })).toBe(false)
    expect(
      subagentLimitsChanged({ budget: { subagents: { running: 4 } } }, { running: 4, perRequest: 32, usd: 25 }),
    ).toBe(false)
    expect(
      subagentLimitsChanged({ budget: { subagents: { running: 4 } } }, { running: 8, perRequest: 32, usd: 25 }),
    ).toBe(true)
  })

  test("the How many fact names the configured values", () => {
    expect(howManyFact({ running: 5, perRequest: 60, usd: 10 })).toContain("Up to 5 at once")
    expect(howManyFact({ running: 5, perRequest: 60, usd: 10 })).toContain("60 new ones per request")
    expect(howManyFact({ running: 5, perRequest: 60, usd: 10 })).toContain("$10.00 spend ceiling")
  })

  test("only a 401 or 403 from an owner-only route marks a guest", () => {
    expect(ownerFromStatus(200)).toBe(true)
    expect(ownerFromStatus(400)).toBe(true)
    expect(ownerFromStatus(403)).toBe(false)
    expect(ownerFromStatus(401)).toBe(false)
    expect(ownerFromStatus(undefined)).toBeUndefined()
  })
})
