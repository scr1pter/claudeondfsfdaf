import { describe, expect, test } from "bun:test"
import {
  canAlwaysAllowPermission,
  canAutoAcceptPermission,
  computerPermissionDetails,
  coordinate,
  quotedLabel,
  safeLabel,
} from "./permission-policy"

describe("canAutoAcceptPermission", () => {
  test("allows ordinary permission prompts", () => {
    expect(canAutoAcceptPermission("edit")).toBe(true)
    expect(canAutoAcceptPermission("browser_external")).toBe(true)
  })

  test.each(["browser_sensitive", "computer_app", "computer_observe", "computer_interact", "computer_sensitive"])(
    "requires a manual decision for %s",
    (permission) => {
      expect(canAutoAcceptPermission(permission)).toBe(false)
    },
  )

  test.each(["vector_cloud_publish", "vector_cloud_database", "vector_cloud_environment", "vector_cloud_hosting"])(
    "requires a new manual decision for account action %s even with saved patterns",
    (permission) => {
      expect(canAutoAcceptPermission(permission, ["*"])).toBe(false)
      expect(canAlwaysAllowPermission(permission, ["*"])).toBe(false)
    },
  )

  test("keeps each-time future cloud actions manual while allowing repeatable read-only inspection", () => {
    expect(canAutoAcceptPermission("vector_cloud_future", [])).toBe(false)
    expect(canAlwaysAllowPermission("vector_cloud_future", [])).toBe(false)
    expect(canAutoAcceptPermission("vector_cloud_inspect", ["supabase/project/preview"])).toBe(true)
  })

  test("requires a manual decision for future computer permissions", () => {
    expect(canAutoAcceptPermission("computer_new_action")).toBe(false)
  })

  test("never accepts Vector Local's network command or address-after-the-web asks", () => {
    expect(canAutoAcceptPermission("network_command", [], ["curl https://example.com"])).toBe(false)
    expect(canAutoAcceptPermission("webfetch", [], ["after-web https://example.com/?q=1"])).toBe(false)
    expect(canAutoAcceptPermission("browser_external", [], ["after-web https://example.com/"])).toBe(false)
    expect(canAutoAcceptPermission("webfetch", ["https://example.com/*"], ["https://example.com/docs"])).toBe(true)
  })
})

describe("canAlwaysAllowPermission", () => {
  test("requires at least one permanent approval pattern", () => {
    expect(canAlwaysAllowPermission()).toBe(false)
    expect(canAlwaysAllowPermission("webfetch", [])).toBe(false)
    expect(canAlwaysAllowPermission("webfetch", ["https://example.com"])).toBe(true)
  })

  test.each([
    "browser_sensitive",
    "computer_observe",
    "computer_interact",
    "computer_sensitive",
    "computer_future_action",
  ])("never offers permanent approval for %s", (permission) => {
    expect(canAlwaysAllowPermission(permission, ["window:42:0"])).toBe(false)
  })
})

describe("computerPermissionDetails", () => {
  test("describes the exact action and human-readable target", () => {
    expect(
      computerPermissionDetails({
        permission: "computer_interact",
        patterns: ["window:42:0"],
        metadata: { action: "click", x: 120.4, y: 48.8, appName: "Safari", targetName: "Checkout" },
      }),
    ).toEqual({ action: "Click once at 120, 49", target: "Safari · Checkout", proposedText: undefined })
  })

  test("does not expose an internal window ID as the target", () => {
    const details = computerPermissionDetails({
      permission: "computer_sensitive",
      patterns: ["window:42:0"],
      metadata: { action: "type", targetId: "window:42:0" },
    })
    expect(details).toEqual({ action: "Type text in the selected app", target: undefined, proposedText: undefined })
    expect(JSON.stringify(details)).not.toContain("window:42:0")
  })

  test("returns the exact proposed text for explicit review", () => {
    const details = computerPermissionDetails({
      permission: "computer_sensitive",
      patterns: ["window:42:0"],
      metadata: { action: "type", text: "Send the release notes\nwhen ready" },
    })
    expect(details?.proposedText).toBe("Send the release notes\nwhen ready")
    expect(details?.action).toBe("Type 33 characters")
  })

  test("never uses permission patterns as display copy", () => {
    const details = computerPermissionDetails({
      permission: "computer_app",
      patterns: ["app:macos:com.apple.notes", "window:42:0", "untrusted fallback"],
      metadata: { action: "use_app" },
    })
    expect(details).toEqual({ action: "Use this app", target: undefined, proposedText: undefined })
  })

  test.each([
    ["use_app", "Use this app"],
    ["run_program", "Run a program"],
    ["paste", "Paste in the selected app"],
  ])("labels %s without screen instructions", (action, label) => {
    expect(
      computerPermissionDetails({ permission: "computer_sensitive", patterns: [], metadata: { action } })?.action,
    ).toBe(label)
  })
})

describe("computer display labels", () => {
  test("removes control, bidi and zero-width ranges before applying the display cap", () => {
    const ranges = [
      [0x00, 0x1f],
      [0x7f, 0x9f],
      [0x200b, 0x200f],
      [0x2028, 0x202e],
      [0x2060, 0x2069],
      [0xfeff, 0xfeff],
      [0x061c, 0x061c],
    ]
    const hidden = ranges
      .flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i)))
      .join("")
    expect(safeLabel(`  No${hidden}tes  `, 100)).toBe("Notes")
    expect(safeLabel(`${hidden}Notes`, 4)).toBe("Note")
    expect(safeLabel(undefined, 40)).toBe("")
    expect(safeLabel("😀", 1)).toBe("")
    expect(safeLabel("😀", 2)).toBe("😀")
  })

  test("quotes at most 40 label characters and never emits a split emoji", () => {
    expect(quotedLabel("x".repeat(50))).toBe(`“${"x".repeat(40)}”`)
    expect(quotedLabel("Save\u202e\u200b")).toBe("“Save”")
    expect(quotedLabel(`${"x".repeat(39)}😀`)).toBe(`“${"x".repeat(39)}”`)
  })

  test("coordinates require finite numbers", () => {
    expect(coordinate(120.4, 48.8)).toBe("120, 49")
    expect(coordinate(Infinity, 0)).toBeUndefined()
    expect(coordinate(0, NaN)).toBeUndefined()
    expect(coordinate("0", 0)).toBeUndefined()
  })
})
