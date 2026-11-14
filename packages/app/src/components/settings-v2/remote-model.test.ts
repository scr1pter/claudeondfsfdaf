import { describe, expect, test } from "bun:test"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { RemoteStatus } from "@/context/platform"
import {
  minutesAndSeconds,
  pairedCountLine,
  phoneLine,
  remoteOffered,
  remoteTab,
  secondsLeft,
  spacedCode,
  stateLine,
} from "./remote-model"
import { filterSettingsGroups } from "./settings-registry"

// WP A42: Settings → Remote shows when the plan includes the listed Remote (H1), or when this computer already has
// Remote on or a phone paired, so it can always be turned off. The paired count comes from the status.

const status = (fields: Partial<ModelPlanStatus.Status>) =>
  ({ signedIn: true, enabled: true, active: true, ...fields }) as unknown as ModelPlanStatus.Status

const local = (fields: Partial<RemoteStatus> = {}): RemoteStatus => ({
  enabled: false,
  state: "off",
  phones: [],
  limit: 5,
  viewers: 0,
  pairing: { state: "idle" },
  ...fields,
})

describe("the Remote tab", () => {
  test("shows for a plan with paired computers while Remote is listed", () => {
    expect(remoteOffered(status({ listed: ["remote"], entitlements: { remote: { computers: 1 } } }))).toBe(true)
    expect(remoteOffered(status({ listed: [], entitlements: { remote: { computers: 3 } } }))).toBe(false)
    expect(remoteOffered(status({ listed: ["remote"], entitlements: { remote: { computers: 0 } } }))).toBe(false)
    expect(remoteOffered(status({ listed: ["remote"], entitlements: {} }))).toBe(false)
    expect(remoteOffered(status({ signedIn: false, listed: ["remote"], entitlements: { remote: { computers: 1 } } }))).toBe(false)
    expect(remoteOffered(undefined)).toBe(false)
  })

  test("stays visible while this computer has Remote on or a phone paired, whatever the plan says", () => {
    expect(remoteTab(undefined, local())).toBe(false)
    expect(remoteTab(undefined, local({ enabled: true }))).toBe(true)
    expect(
      remoteTab(
        status({ listed: [] }),
        local({ phones: [{ device: "d", name: "iPhone", pairedAt: 1, connected: false, watching: false }] }),
      ),
    ).toBe(true)
    expect(remoteTab(status({ listed: ["remote"], entitlements: { remote: { computers: 5 } } }), undefined)).toBe(true)
  })

  test("Settings search finds it by what people call it", () => {
    for (const query of ["remote", "pair", "phone", "qr"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toContain("remote")
  })
})

describe("what Settings → Remote says", () => {
  test("the paired count comes from the status meter, else the plan's limit", () => {
    expect(pairedCountLine(status({ meters: { remote: { computers: 2, limit: 3 } } }))).toBe("2 of 3 computers paired.")
    expect(pairedCountLine(status({ meters: { remote: { computers: 1, limit: 1 } } }))).toBe("1 of 1 computer paired.")
    expect(pairedCountLine(status({ entitlements: { remote: { computers: 5 } } }))).toBe("Your plan pairs up to 5 computers.")
    expect(pairedCountLine(undefined)).toBeUndefined()
  })

  test("every connection state reads as plain words; problems are marked", () => {
    const states: RemoteStatus["state"][] = [
      "off",
      "ready",
      "signed-out",
      "connecting",
      "online",
      "paused",
      "not-in-plan",
      "unavailable",
      "device-limit",
      "fair-use",
      "revoked",
      "replaced",
      "local-off",
    ]
    for (const state of states) {
      const line = stateLine(local({ state }))
      expect(line.text.length).toBeGreaterThan(5)
      expect(line.text).not.toMatch(/\$|credit|top-?up|guarantee|soon/i)
    }
    expect(stateLine(local({ state: "online", viewers: 2 })).text).toBe("Connected. 2 phones are open now.")
    expect(stateLine(local({ state: "paused" })).problem).toBe(true)
    expect(stateLine(local({ state: "ready" })).problem).toBe(false)
    // The main process's own message wins where it has one.
    expect(stateLine(local({ state: "not-in-plan", message: "Remote is not in your plan." })).text).toBe(
      "Remote is not in your plan.",
    )
  })

  test("the pairing code's time and digits", () => {
    expect(secondsLeft(10_500, 1_000)).toBe(10)
    expect(secondsLeft(1_000, 5_000)).toBe(0)
    expect(minutesAndSeconds(299)).toBe("4:59")
    expect(minutesAndSeconds(5)).toBe("0:05")
    expect(spacedCode("123456")).toBe("123 456")
    expect(phoneLine({ device: "d", name: "x", pairedAt: 1, connected: true, watching: true })).toBe("Watching now")
    expect(phoneLine({ device: "d", name: "x", pairedAt: 1, connected: false, watching: false })).toBe("Not connected")
  })
})
