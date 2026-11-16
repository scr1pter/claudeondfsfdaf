import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigComputerV1 } from "@vectordevai/core/v1/config/computer"

const decode = Schema.decodeUnknownSync(ConfigV1.Info)

describe("computer company policy", () => {
  test("decodes all policy fields and both verified Windows identity forms", () => {
    const computer = {
      enabled: false,
      default_app_access: "deny",
      allow_always: false,
      background: false,
      keep_awake: false,
      away_minutes: 30,
      screenshot_retention_days: 7,
      max_actions: 300,
      max_minutes: 45,
      native_tools: "off",
      screenshots: { keep: 3, max_width: 1440, max_height: 900 },
      apps: {
        macos: { "com.apple.TextEdit": "allow", "com.example.Editor@TEAM123456": "deny" },
        windows: [
          { aumid: "Example.Reader_123!App", access: "allow" },
          { publisher: "Example Corporation", product: "Editor", access: "deny" },
          { publisher: "Example Corporation", product: "Reader", binary: "reader.exe", access: "allow" },
        ],
      },
    } satisfies ConfigComputerV1.Info
    expect(decode({ computer }).computer).toEqual(computer)
    expect(Schema.decodeUnknownSync(ConfigComputerV1.Info)({})).toEqual({})
    expect(decode({}).computer).toBeUndefined()
  })

  for (const [key, min, max] of [
    ["away_minutes", 5, 240],
    ["screenshot_retention_days", 0, 365],
    ["max_actions", 1, 5000],
    ["max_minutes", 1, 600],
  ] as const) {
    test(`${key} enforces an inclusive integer range`, () => {
      for (const value of [min, max]) expect(decode({ computer: { [key]: value } }).computer).toEqual({ [key]: value })
      for (const value of [min - 1, max + 1, min + 0.5, "30", null])
        expect(() => decode({ computer: { [key]: value } })).toThrow()
    })
  }

  test("bounds screenshots and rejects unknown policy decisions", () => {
    for (const keep of [1, 10])
      expect(decode({ computer: { screenshots: { keep } } }).computer?.screenshots?.keep).toBe(keep)
    for (const screenshots of [{ keep: 0 }, { keep: 11 }, { keep: 1.5 }, { max_width: 0 }, { max_height: -1 }])
      expect(() => decode({ computer: { screenshots } })).toThrow()
    for (const computer of [
      { default_app_access: "allow" },
      { native_tools: "on" },
      { apps: { macos: { "com.apple.TextEdit": "ask" } } },
      { apps: { windows: [{ aumid: "Example.Reader_123!App", access: "always" }] } },
      { apps: { windows: [{ publisher: "Example Corporation", access: "allow" }] } },
    ])
      expect(() => decode({ computer })).toThrow()
  })
})
