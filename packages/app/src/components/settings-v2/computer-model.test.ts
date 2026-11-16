import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerSettings } from "./computer-model"

const mac = (screen: "granted" | "denied" = "granted", accessibility: "granted" | "denied" = "granted") =>
  ({
    rows: [
      { id: "screen", status: screen, pane: "screen" },
      { id: "accessibility", status: accessibility, pane: "accessibility" },
    ],
    canReset: false,
    adhoc: false,
    helperStart: "ok",
    vectorHoldsGrant: { screen: false, accessibility: false },
  }) satisfies Computer.PermissionsView
const windows = (flags: Partial<{ captureBlocked: boolean; elevated: boolean }> = {}) =>
  ({
    rows: [],
    canReset: false,
    adhoc: false,
    helperStart: "ok",
    vectorHoldsGrant: { screen: false, accessibility: false },
    windows: {
      captureBlocked: false,
      elevated: false,
      inputSetup: { state: "ready", mouse: true, keyboard: true },
      ...flags,
    },
  }) satisfies Computer.PermissionsView

function settings(
  input: {
    prefs?: Partial<Computer.ComputerPrefs>
    policy?: Partial<Computer.ComputerPolicy>
    locked?: Computer.ResolvedComputerSettings["locked"]
    builtins?: Computer.ResolvedComputerSettings["builtins"]
    always?: Computer.AlwaysAllowed[]
  } = {},
): Computer.ResolvedComputerSettings {
  return {
    prefs: {
      enabled: true,
      consentedAt: 1,
      mode: "background",
      pointer: "ask",
      blocked: [],
      unblocked: [],
      retention: "7d",
      stopChord: Hands.STOP_CHORD.darwin,
      keepAwake: true,
      notify: true,
      reduceMotion: false,
      ...input.prefs,
    },
    policy: {
      managed: false,
      enabled: true,
      defaultAccess: "ask",
      allowAlways: true,
      background: true,
      keepAwake: true,
      apps: new Map(),
      ignored: [],
      ...input.policy,
    },
    always: input.always ?? [],
    builtins: input.builtins ?? [],
    locked: input.locked ?? [],
  }
}

const ready = (patch: Partial<ComputerSettings.View> = {}): ComputerSettings.View => ({
  settings: settings(),
  status: { available: true, backend: "local-macos" },
  phase: "ready",
  backend: "local-macos",
  permissions: mac(),
  ...patch,
})

const pill = (view: ComputerSettings.View, supported = true) => ComputerSettings.status(view, supported)

describe("Settings status pill", () => {
  test("Linux, a failed first read and loading come before anything the desktop reports", () => {
    expect(pill(ready(), false)).toEqual({ key: "computer.status.linux", kind: "off" })
    expect(pill({ failed: true })).toEqual({ key: "computer.settings.readFailed", kind: "failed" })
    expect(pill(ready({ loading: true }))).toBeUndefined()
    expect(pill(ready({ settings: undefined }))).toBeUndefined()
    expect(pill(ready({ backend: undefined }))).toBeUndefined()
  })

  test("a ready, granted, enabled Mac is Ready, and an ad-hoc helper or probe is Preview", () => {
    expect(pill(ready())).toEqual({ key: "computer.status.ready", kind: "ready" })
    expect(pill(ready({ phase: "working" }))?.key).toBe("computer.status.ready")
    expect(pill(ready({ permissions: { ...mac(), adhoc: true } }))).toEqual({
      key: "computer.status.preview",
      kind: "preview",
    })
    expect(
      pill(
        ready({
          status: { available: true, backend: "local-macos", helper: { version: "1", protocol: 1, signing: "adhoc" } },
        }),
      )?.key,
    ).toBe("computer.status.preview")
  })

  test("a company turning Hands off, or locking it, reads Off — set by your company over everything else", () => {
    expect(pill(ready({ settings: settings({ policy: { enabled: false } }) }))).toEqual({
      key: "computer.status.companyOff",
      kind: "off",
    })
    expect(pill(ready({ status: { available: false, reason: "policy_disabled", backend: "local-macos" } }))?.key).toBe(
      "computer.status.companyOff",
    )
    expect(pill(ready({ settings: settings({ locked: ["enabled"] }) }))?.key).toBe("computer.status.companyOff")
    expect(pill(ready({ settings: settings({ locked: ["consentedAt"] }) }))?.key).toBe("computer.status.companyOff")
    // Even when the person has not turned it on, or the probe failed.
    expect(
      pill(
        ready({
          settings: settings({ prefs: { enabled: false }, policy: { enabled: false } }),
          permissions: undefined,
        }),
      )?.key,
    ).toBe("computer.status.companyOff")
  })

  test("blockers setup cannot fix read Off with their sentence, never Needs permissions", () => {
    const off = (view: ComputerSettings.View) => pill(view)
    expect(
      off(
        ready({
          backend: "local-windows",
          status: { available: true, backend: "local-windows" },
          permissions: windows({ elevated: true }),
        }),
      ),
    ).toEqual({ key: "computer.status.off", kind: "off", note: "computer.availability.elevated" })
    expect(off(ready({ status: { available: false, reason: "elevated", backend: "local-windows" } }))).toEqual({
      key: "computer.status.off",
      kind: "off",
      note: "computer.availability.elevated",
    })
    expect(off(ready({ permissions: { ...mac(), helperStart: "failed" } }))).toEqual({
      key: "computer.status.off",
      kind: "off",
      note: "computer.onboarding.helperFailed",
    })
    expect(off(ready({ status: { available: false, reason: "helper_missing", backend: "local-macos" } }))?.note).toBe(
      "computer.onboarding.helperFailed",
    )
    expect(off(ready({ status: { available: false, reason: "unsupported_os", backend: "local-macos" } }))?.note).toBe(
      "computer.availability.macos",
    )
    expect(off(ready({ backend: "remote" }))?.note).toBe("computer.availability.desktop")
  })

  test("setup-fixable situations read Needs permissions once Hands is on, and Off while it is off", () => {
    expect(pill(ready({ permissions: mac("granted", "denied") }))).toEqual({
      key: "computer.status.needsPermissions",
      kind: "setup",
    })
    expect(pill(ready({ phase: "setup" }))?.key).toBe("computer.status.needsPermissions")
    expect(pill(ready({ status: { available: false, reason: "permissions", backend: "local-macos" } }))?.key).toBe(
      "computer.status.needsPermissions",
    )
    const blockedCapture = ready({
      backend: "local-windows",
      status: { available: true, backend: "local-windows" },
      permissions: windows({ captureBlocked: true }),
    })
    expect(pill(blockedCapture)).toEqual({
      key: "computer.status.needsPermissions",
      kind: "setup",
      note: "computer.onboarding.windows.captureBlocked",
    })
    // A failed probe is never Ready: it asks for a new check.
    expect(pill(ready({ permissions: undefined }))).toEqual({
      key: "computer.status.needsPermissions",
      kind: "setup",
      note: "computer.onboarding.checkFailed",
    })
    // A permission view that disagrees with the backend is a failed check, not a grant.
    expect(pill(ready({ permissions: windows() }))?.note).toBe("computer.onboarding.checkFailed")
    // Consent is part of being set up.
    expect(pill(ready({ settings: settings({ prefs: { consentedAt: undefined } }) }))?.key).toBe(
      "computer.status.needsPermissions",
    )

    const off = settings({ prefs: { enabled: false } })
    expect(pill(ready({ settings: off, permissions: mac("denied", "denied") }))).toEqual({
      key: "computer.status.off",
      kind: "off",
    })
    expect(pill({ ...blockedCapture, settings: off })).toEqual({
      key: "computer.status.off",
      kind: "off",
      note: "computer.onboarding.windows.captureBlocked",
    })
  })

  test("the live phase overrides the preference: off reads Off, setup reads Needs permissions", () => {
    expect(pill(ready({ phase: "off" }))?.key).toBe("computer.status.off")
    expect(pill(ready({ phase: "setup", permissions: mac() }))?.key).toBe("computer.status.needsPermissions")
    expect(pill(ready({ phase: undefined }))?.key).toBe("computer.status.ready")
  })
})

describe("company locks", () => {
  test("explicit locks and the policy ceiling both lock a field", () => {
    const open = settings()
    for (const field of ["enabled", "mode", "keepAwake", "pointer", "retention"] as const)
      expect(ComputerSettings.locked(field, open)).toBe(false)
    expect(ComputerSettings.locked("pointer", settings({ locked: ["pointer"] }))).toBe(true)
    expect(ComputerSettings.locked("enabled", settings({ policy: { enabled: false } }))).toBe(true)
    expect(ComputerSettings.locked("mode", settings({ policy: { background: false } }))).toBe(true)
    expect(ComputerSettings.locked("keepAwake", settings({ policy: { keepAwake: false } }))).toBe(true)
    expect(ComputerSettings.locked("notify", settings({ policy: { background: false, keepAwake: false } }))).toBe(false)
  })

  test("the effective values follow the company", () => {
    expect(
      ComputerSettings.effective(
        settings({
          prefs: { mode: "background", keepAwake: true, retention: "30d" },
          policy: { background: false, keepAwake: false, maxRetentionDays: 7 },
        }),
      ),
    ).toEqual({ mode: "foreground", keepAwake: false, retention: "7d" })
    expect(ComputerSettings.effective(settings())).toEqual({ mode: "background", keepAwake: true, retention: "7d" })
  })

  test("Settings writes only its own unlocked fields, and turns Hands off but never on", () => {
    const open = settings()
    expect(ComputerSettings.writable({ enabled: false }, open)).toBe(true)
    expect(ComputerSettings.writable({ mode: "foreground", pointer: "take", notify: false }, open)).toBe(true)
    expect(ComputerSettings.writable({ unblocked: ["builtin:find-my"] }, open)).toBe(true)
    expect(ComputerSettings.writable({ enabled: true }, open)).toBe(false)
    expect(ComputerSettings.writable({ consentedAt: 2 }, open)).toBe(false)
    expect(ComputerSettings.writable({ granted: { helperVersion: "1", at: 1 } }, open)).toBe(false)
    expect(ComputerSettings.writable({ reduceMotion: true }, open)).toBe(false)
    expect(ComputerSettings.writable({ blocked: [] }, open)).toBe(false)
    expect(ComputerSettings.writable({}, open)).toBe(false)
    expect(ComputerSettings.writable({ stopChord: "" }, open)).toBe(false)
    expect(ComputerSettings.writable({ mode: "background" }, settings({ policy: { background: false } }))).toBe(false)
    expect(ComputerSettings.writable({ notify: false, keepAwake: true }, settings({ locked: ["keepAwake"] }))).toBe(
      false,
    )
    expect(ComputerSettings.writable({ retention: "30d" }, settings({ policy: { maxRetentionDays: 7 } }))).toBe(false)
    expect(ComputerSettings.writable({ retention: "7d" }, settings({ policy: { maxRetentionDays: 7 } }))).toBe(true)
  })
})

describe("screenshot retention", () => {
  test("choices follow the company maximum at every boundary", () => {
    expect(ComputerSettings.retentionOptions(undefined)).toEqual(["task", "1d", "7d", "30d", "session"])
    expect(ComputerSettings.retentionOptions(0)).toEqual(["task"])
    expect(ComputerSettings.retentionOptions(1)).toEqual(["task", "1d"])
    expect(ComputerSettings.retentionOptions(3)).toEqual(["task", "1d"])
    expect(ComputerSettings.retentionOptions(7)).toEqual(["task", "1d", "7d"])
    expect(ComputerSettings.retentionOptions(29)).toEqual(["task", "1d", "7d"])
    expect(ComputerSettings.retentionOptions(30)).toEqual(["task", "1d", "7d", "30d"])
    expect(ComputerSettings.retentionOptions(365)).toEqual(["task", "1d", "7d", "30d"])
    // A malformed maximum is the strictest one, never "no maximum".
    expect(ComputerSettings.retentionOptions(-1)).toEqual(["task"])
    expect(ComputerSettings.retentionOptions(Number.NaN)).toEqual(["task"])
  })

  test("a longer choice is clamped to the longest allowed one", () => {
    expect(ComputerSettings.clampRetention("session", undefined)).toBe("session")
    expect(ComputerSettings.clampRetention("session", 365)).toBe("30d")
    expect(ComputerSettings.clampRetention("30d", 29)).toBe("7d")
    expect(ComputerSettings.clampRetention("30d", 30)).toBe("30d")
    expect(ComputerSettings.clampRetention("7d", 3)).toBe("1d")
    expect(ComputerSettings.clampRetention("1d", 0)).toBe("task")
    expect(ComputerSettings.clampRetention("task", 0)).toBe("task")
    expect(ComputerSettings.clampRetention("forever" as Computer.Retention, undefined)).toBe("task")
  })
})

describe("app lists", () => {
  test("always-allowed rows are cleaned and dated only when the date is real", () => {
    expect(
      ComputerSettings.alwaysRows([
        { key: "app:macos:com.apple.notes", name: "Notes‮", publisher: "Apple Inc.", addedAt: 1_700_000_000_000 },
        { key: "app:macos:com.acme.tool", name: " ", teamId: "ABCDE12345", addedAt: 0 },
        { key: "app:windows:exe:acme|tool|tool.exe", name: "Tool", teamId: "bad", addedAt: Number.NaN },
      ]),
    ).toEqual([
      { key: "app:macos:com.apple.notes", name: "Notes", publisher: "Apple Inc.", addedAt: 1_700_000_000_000 },
      { key: "app:macos:com.acme.tool", name: "com.acme.tool", teamId: "ABCDE12345" },
      { key: "app:windows:exe:acme|tool|tool.exe", name: "Tool" },
    ])
  })

  test("company rows are read-only lists, only when managed, with ignored rules", () => {
    const policy = settings({
      policy: {
        managed: true,
        apps: new Map([
          ["app:macos:com.apple.calculator", "allow"],
          ["app:windows:exe:microsoft corporation|microsoft excel|excel.exe", "deny"],
          ["app:windows:aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app", "allow"],
        ]),
        ignored: ["com.example.tool", "\u0007"],
      },
    }).policy
    expect(ComputerSettings.companyRows(policy)).toEqual({
      allowed: [
        { key: "app:macos:com.apple.calculator", name: "com.apple.calculator" },
        {
          key: "app:windows:aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app",
          name: "microsoft.windowscalculator_8wekyb3d8bbwe!app",
        },
      ],
      denied: [{ key: "app:windows:exe:microsoft corporation|microsoft excel|excel.exe", name: "microsoft excel" }],
      ignored: ["com.example.tool"],
    })
    expect(ComputerSettings.companyRows({ ...policy, managed: false })).toEqual({
      allowed: [],
      denied: [],
      ignored: [],
    })
    // Rules that did not arrive as a Map are not guessed at.
    expect(
      ComputerSettings.companyRows({
        ...policy,
        apps: { "app:macos:x": "allow" } as unknown as Computer.ComputerPolicy["apps"],
      }).allowed,
    ).toEqual([])
  })

  test("built-in groups are fixed; default blocks group trading apps and track Allow; your blocks follow the lock", () => {
    const resolved = settings({
      prefs: {
        unblocked: ["builtin:find-my", "builtin:tradingview"],
        blocked: [{ key: "app:macos:com.example.game", name: "Game", addedAt: 5 }],
      },
      builtins: [
        { key: "builtin:terminal", name: "Terminal", reason: "terminal", removable: false },
        { key: "builtin:tradingview", name: "TradingView", reason: "user", removable: true },
        { key: "builtin:find-my", name: "Find My", reason: "user", removable: true },
        { key: "builtin:binance", name: "Binance", reason: "user", removable: true },
        { key: "builtin:disk-utility", name: "Disk Utility", reason: "user", removable: true },
        { key: "builtin:custom", name: "Custom\u0000App", reason: "user", removable: true },
      ],
    })
    const rows = ComputerSettings.blockedRows(resolved)
    expect(rows.never.map((group) => group.id)).toEqual(["terminal", "vector", "security", "passwords", "remote"])
    expect(rows.never.every((group) => !("keys" in group))).toBe(true)
    expect(rows.defaults).toEqual([
      {
        id: "finance",
        title: "computer.settings.blocked.finance",
        keys: ["builtin:tradingview", "builtin:binance"],
        allowed: false,
        editable: true,
      },
      {
        id: "builtin:find-my",
        title: "computer.settings.blocked.findMy",
        keys: ["builtin:find-my"],
        allowed: true,
        editable: true,
      },
      {
        id: "builtin:disk-utility",
        title: "computer.settings.blocked.diskUtility",
        keys: ["builtin:disk-utility"],
        allowed: false,
        editable: true,
      },
      { id: "builtin:custom", name: "Custom App", keys: ["builtin:custom"], allowed: false, editable: true },
    ])
    expect(rows.yours).toEqual([{ key: "app:macos:com.example.game", name: "Game", addedAt: 5, editable: true }])

    const locked = ComputerSettings.blockedRows({ ...resolved, locked: ["unblocked", "blocked"] })
    expect(locked.defaults.every((row) => !row.editable)).toBe(true)
    expect(locked.yours.every((row) => !row.editable)).toBe(true)
  })

  test("allowing and re-blocking a default row changes only removable keys", () => {
    const resolved = settings({
      prefs: { unblocked: ["builtin:find-my"] },
      builtins: [
        { key: "builtin:tradingview", name: "TradingView", reason: "user", removable: true },
        { key: "builtin:binance", name: "Binance", reason: "user", removable: true },
        { key: "builtin:find-my", name: "Find My", reason: "user", removable: true },
        { key: "builtin:terminal", name: "Terminal", reason: "terminal", removable: false },
      ],
    })
    expect(
      ComputerSettings.unblockedAfter(resolved, ["builtin:tradingview", "builtin:binance", "builtin:terminal"], true),
    ).toEqual(["builtin:find-my", "builtin:tradingview", "builtin:binance"])
    expect(ComputerSettings.unblockedAfter(resolved, ["builtin:find-my"], false)).toEqual([])
    expect(ComputerSettings.unblockedAfter(resolved, ["builtin:find-my"], true)).toEqual(["builtin:find-my"])
  })
})

describe("stop shortcut", () => {
  const press = (
    code: string,
    modifiers: Partial<ComputerSettings.KeyPress> = {},
    key = code.replace(/^Key|^Digit/, ""),
  ) => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  })

  test("records the physical key with two modifiers, whatever character the layout produces", () => {
    expect(ComputerSettings.recordChord(press("KeyK", { ctrlKey: true, shiftKey: true }), "macos")).toEqual({
      type: "chord",
      accelerator: "Control+Shift+K",
    })
    // Option changes the character (Option+K is ˚), Shift changes digits, and other layouts change letters.
    expect(ComputerSettings.recordChord(press("KeyK", { metaKey: true, altKey: true }, "˚"), "macos")).toEqual({
      type: "chord",
      accelerator: "Command+Alt+K",
    })
    expect(ComputerSettings.recordChord(press("Digit1", { ctrlKey: true, shiftKey: true }, "!"), "windows")).toEqual({
      type: "chord",
      accelerator: "Control+Shift+1",
    })
    expect(ComputerSettings.recordChord(press("KeyK", { ctrlKey: true, altKey: true }, "л"), "windows")).toEqual({
      type: "chord",
      accelerator: "Control+Alt+K",
    })
    expect(ComputerSettings.recordChord(press("F12", { metaKey: true, shiftKey: true }), "macos")).toEqual({
      type: "chord",
      accelerator: "Command+Shift+F12",
    })
  })

  test("records the default Escape chords on both platforms", () => {
    expect(ComputerSettings.recordChord(press("Escape", { metaKey: true, shiftKey: true }), "macos")).toEqual({
      type: "chord",
      accelerator: Hands.STOP_CHORD.darwin,
    })
    expect(
      ComputerSettings.recordChord(press("Escape", { ctrlKey: true, altKey: true, shiftKey: true }), "windows"),
    ).toEqual({ type: "chord", accelerator: Hands.STOP_CHORD.win32 })
  })

  test("a plain Esc cancels and a modifier alone keeps recording", () => {
    expect(ComputerSettings.recordChord(press("Escape"), "macos")).toEqual({ type: "cancel" })
    expect(ComputerSettings.recordChord(press("ShiftLeft", { shiftKey: true }, "Shift"), "windows")).toEqual({
      type: "pending",
    })
    expect(ComputerSettings.recordChord(press("ControlRight", { ctrlKey: true }, "Control"), "macos")).toEqual({
      type: "pending",
    })
  })

  test("refuses too few modifiers, other keys, the Windows key, Control+Option and reserved chords", () => {
    const refused = (event: ReturnType<typeof press>, platform: ComputerSettings.Platform) =>
      ComputerSettings.recordChord(event, platform)
    expect(refused(press("KeyK", { ctrlKey: true }), "windows")).toEqual({ type: "invalid", reason: "keys" })
    expect(refused(press("Escape", { shiftKey: true }), "macos")).toEqual({ type: "invalid", reason: "keys" })
    expect(refused(press("Space", { ctrlKey: true, shiftKey: true }, " "), "windows")).toEqual({
      type: "invalid",
      reason: "keys",
    })
    expect(refused(press("F13", { ctrlKey: true, shiftKey: true }), "windows")).toEqual({
      type: "invalid",
      reason: "keys",
    })
    expect(refused(press("KeyK", { metaKey: true, ctrlKey: true, shiftKey: true }), "windows")).toEqual({
      type: "invalid",
      reason: "keys",
    })
    expect(refused(press("KeyK", { ctrlKey: true, altKey: true }), "macos")).toEqual({
      type: "invalid",
      reason: "reserved",
    })
    expect(refused(press("Escape", { metaKey: true, altKey: true }), "macos")).toEqual({
      type: "invalid",
      reason: "reserved",
    })
    expect(refused(press("Digit4", { metaKey: true, shiftKey: true }, "$"), "macos")).toEqual({
      type: "invalid",
      reason: "reserved",
    })
    expect(refused(press("Escape", { ctrlKey: true, shiftKey: true }), "windows")).toEqual({
      type: "invalid",
      reason: "reserved",
    })
  })
})
