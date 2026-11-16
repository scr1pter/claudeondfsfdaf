import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Hands } from "@vectordevai/schema/hands"
import * as Barrel from "@vectordevai/schema"

// D1: the brand constant (build contract section 2.1). The user-visible name lives only in hands.ts; internal
// identifiers stay "computer" and never change.

const mac = (bundleId: string): Computer.AppIdentity => ({
  platform: "macos",
  bundleId,
  teamId: "TEAMID1234",
  apple: false,
  system: false,
  verified: true,
  name: bundleId,
})

describe("Hands brand constants", () => {
  test("BANNER is the owner's fixed sentence, not built from NAME", () => {
    expect(Hands.BANNER).toBe("Vector is using your computer")
    expect(Hands.BANNER).not.toContain(Hands.NAME)
  })

  test("the user-visible names match section 2.1", () => {
    expect(Hands.NAME).toBe("Vector Hands")
    expect(Hands.SHORT).toBe("Hands")
    expect(Hands.MENTION).toBe("Hands")
    expect(Hands.DOCS).toBe("vector-hands")
    expect(Hands.MENTION_KEYWORDS).toEqual([
      "computer",
      "computer use",
      "screen",
      "use my computer",
      "mouse",
      "keyboard",
      "hands",
    ])
  })

  test("no user-visible name borrows a rival's feature name", () => {
    const visible = [Hands.NAME, Hands.SHORT, Hands.MENTION, Hands.BANNER, ...Hands.CHANNELS.map(Hands.helperName)]
    const rivals = ["computer use", "operator", "agent mode", "copilot actions", "agent workspace", "cowork"]
    for (const text of visible) for (const rival of rivals) expect(text.toLowerCase()).not.toContain(rival)
  })

  test("ID and MARKER are the fixed internal identifiers", () => {
    expect(Hands.ID).toBe("computer")
    expect(Hands.MARKER).toBe("vector.computer.mention")
    // One marker key across the schema: the mention marker shape (section 2.5) is keyed by Computer.MENTION_KEY.
    expect(Hands.MARKER).toBe(Computer.MENTION_KEY)
    // Internal identifiers never carry the brand, so a rename never touches them.
    expect(Hands.ID).not.toContain(Hands.SHORT.toLowerCase())
    expect(Hands.MARKER).not.toContain(Hands.SHORT.toLowerCase())
    expect(Hands.helperBundleId("ai.vector.app")).not.toContain(Hands.SHORT.toLowerCase())
  })

  test("the stop key and the default stop chords", () => {
    expect(Hands.STOP_KEY).toBe("Escape")
    expect(Hands.STOP_CHORD).toEqual({ darwin: "Command+Shift+Escape", win32: "Control+Alt+Shift+Escape" })
  })

  test("shared lists cannot be changed at run time", () => {
    expect(Object.isFrozen(Hands.MENTION_KEYWORDS)).toBe(true)
    expect(Object.isFrozen(Hands.STOP_CHORD)).toBe(true)
    expect(Object.isFrozen(Hands.CHANNELS)).toBe(true)
    expect(() => (Hands.MENTION_KEYWORDS as string[]).push("x")).toThrow()
    expect(() => ((Hands.STOP_CHORD as { darwin: string }).darwin = "Escape")).toThrow()
  })

  test("the schema barrel exports the same module", () => {
    expect(Barrel.Hands).toBe(Hands)
  })
})

describe("helperBundleId", () => {
  test("is the app id plus .computer, never under Electron's .helper bundles", () => {
    expect(Hands.helperBundleId("ai.vector.app")).toBe("ai.vector.app.computer")
    expect(Hands.helperBundleId("ai.vector.app").startsWith("ai.vector.app.helper")).toBe(false)
  })

  test("holds for every release channel's app id", () => {
    for (const appId of ComputerApps.VECTOR_APP_IDS) {
      const id = Hands.helperBundleId(appId)
      expect(id).toBe(`${appId}.${ComputerApps.HELPER_SUFFIX}`)
      expect(id.startsWith(`${appId}.helper`)).toBe(false)
      for (const suffix of ComputerApps.ELECTRON_HELPER_SUFFIXES) expect(id).not.toBe(`${appId}.${suffix}`)
      // The helper is Vector itself, so it is on the never-list (INV-S1).
      expect(ComputerApps.category(mac(id))).toBe("vector")
    }
  })
})

describe("helperName", () => {
  test("names the helper per channel, as System Settings lists it", () => {
    expect(Hands.helperName("prod")).toBe("Vector Hands")
    expect(Hands.helperName("beta")).toBe("Vector Hands Beta")
    expect(Hands.helperName("dev")).toBe("Vector Hands Dev")
  })

  test("every channel's name starts with NAME", () => {
    expect(Hands.CHANNELS).toEqual(["prod", "beta", "dev"])
    for (const channel of Hands.CHANNELS) expect(Hands.helperName(channel).startsWith(Hands.NAME)).toBe(true)
    expect(new Set(Hands.CHANNELS.map(Hands.helperName)).size).toBe(Hands.CHANNELS.length)
  })

  test("an unknown channel gets the dev name, as desktop main treats it", () => {
    expect(Hands.helperName("latest" as Hands.Channel)).toBe("Vector Hands Dev")
    expect(Hands.helperName("__proto__" as Hands.Channel)).toBe("Vector Hands Dev")
  })
})
