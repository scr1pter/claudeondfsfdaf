import { describe, expect, test } from "bun:test"
import { ENTITLEMENTS, publicEntitlements, type PerkId } from "@vectordevai/schema/codium-entitlements"
import {
  decodePhoneStatus,
  opsParts,
  phoneFeatures,
  planNotice,
  routeFromPath,
  routeShown,
  PHONE_ROUTES,
  type PhoneStatus,
} from "./status"

// WP A38: the phone shows a route only when the status lists its perk and the plan includes it (H1); the server
// enforces every service on its own (S1).

const status = (plan: keyof typeof ENTITLEMENTS | undefined, listed: PerkId[], state = "active"): PhoneStatus =>
  decodePhoneStatus({
    enabled: true,
    access: true,
    ...(plan
      ? { plan: { id: plan, name: "Plan", state }, entitlements: publicEntitlements(plan, new Set(listed)) }
      : {}),
    listed,
    // A field the phone does not read is ignored.
    forecastDate: "2026-11-20",
  })

describe("decodePhoneStatus", () => {
  test("reads only what the phone needs and drops unknown perks and states", () => {
    const decoded = decodePhoneStatus({
      enabled: true,
      plan: { id: "vector-100", name: "Max", state: "someday" },
      listed: ["remote", "teleport", 7, "alerts"],
      entitlements: { rank: 3, remote: { computers: 5 } },
      meters: { remote: { computers: 2, limit: 5 } },
    })
    expect(decoded.enabled).toBe(true)
    expect(decoded.plan).toEqual({ id: "vector-100", name: "Max" })
    expect([...decoded.listed]).toEqual(["remote", "alerts"])
    expect(decoded.remote).toEqual({ computers: 2, limit: 5 })
  })

  test("a malformed or empty answer shows nothing rather than failing", () => {
    for (const body of [undefined, null, "x", [], { listed: "remote" }, { entitlements: [] }]) {
      const decoded = decodePhoneStatus(body)
      expect(decoded.enabled).toBe(false)
      expect(decoded.listed.size).toBe(0)
      expect(phoneFeatures(decoded)).toEqual([])
    }
  })
})

describe("routeShown", () => {
  test("nothing listed shows nothing, whatever the plan", () => {
    for (const plan of ["vector-10", "vector-50", "vector-100", "vector-200"] as const)
      expect(phoneFeatures(status(plan, []))).toEqual([])
  })

  test("a listed perk without a plan shows nothing", () => {
    expect(phoneFeatures(status(undefined, ["remote", "alerts", "computer", "on-call"]))).toEqual([])
  })

  test("Remote's routes need remote listed and paired computers in the plan", () => {
    const plus = status("vector-10", ["remote"])
    expect(phoneFeatures(plus).map((item) => item.route)).toEqual(["sessions", "approvals", "devices"])
    expect(routeShown("cloud-runs", plus)).toBe(false)
    const withRuns = status("vector-10", ["remote", "github-agents"])
    expect(routeShown("cloud-runs", withRuns)).toBe(true)
    // An entitlement claimed without the listing is ignored.
    const forged = decodePhoneStatus({
      plan: { id: "vector-10", name: "Plus" },
      listed: [],
      entitlements: { rank: 1, remote: { computers: 9 } },
    })
    expect(routeShown("sessions", forged)).toBe(false)
  })

  test("the cloud computer shows only on plans that include it", () => {
    expect(routeShown("computer", status("vector-50", ["computer"]))).toBe(false)
    expect(routeShown("computer", status("vector-100", ["computer"]))).toBe(true)
    expect(routeShown("computer", status("vector-200", ["computer"]))).toBe(true)
  })

  test("production shows on Max and Ultra once any ops part is listed, and only the listed parts", () => {
    expect(routeShown("ops", status("vector-50", ["alerts", "on-call"]))).toBe(false)
    const max = status("vector-100", ["alerts", "ship-desk"])
    expect(routeShown("ops", max)).toBe(true)
    expect(opsParts(max)).toEqual(["ship-desk"])
  })

  test("alerts show on every plan once listed", () => {
    for (const plan of ["vector-10", "vector-50", "vector-100", "vector-200"] as const) {
      expect(routeShown("notifications", status(plan, ["alerts"]))).toBe(true)
      expect(routeShown("notifications", status(plan, []))).toBe(false)
    }
  })

  test("routes keep their order", () => {
    const everything = status("vector-200", ["remote", "github-agents", "computer", "on-call", "alerts"])
    expect(phoneFeatures(everything).map((item) => item.route)).toEqual([...PHONE_ROUTES])
  })
})

test("a plan that cannot be used says why and keeps its routes", () => {
  expect(planNotice(status("vector-10", ["alerts"]))).toBeUndefined()
  expect(planNotice(status("vector-10", ["alerts"], "renewing"))).toBeUndefined()
  expect(planNotice(status("vector-10", ["alerts"], "paused"))).toContain("paused")
  expect(planNotice(status("vector-10", ["alerts"], "frozen"))).toContain("on hold")
  expect(planNotice(status("vector-10", ["alerts"], "ended"))).toContain("ended")
  expect(phoneFeatures(status("vector-10", ["alerts"], "paused")).map((item) => item.route)).toEqual(["notifications"])
})

test("paths map to routes inside /phone/ only", () => {
  expect(routeFromPath("/phone/")).toBeUndefined()
  expect(routeFromPath("/phone/devices")).toBe("devices")
  expect(routeFromPath("/phone/cloud-runs/")).toBe("cloud-runs")
  expect(routeFromPath("/phone/admin")).toBeUndefined()
  expect(routeFromPath("/devices")).toBeUndefined()
})
