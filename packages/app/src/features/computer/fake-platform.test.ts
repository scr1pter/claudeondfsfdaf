import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { createFakeComputer, type FakeComputerCall, type FakeComputerScript } from "./fake-platform"

const notes = {
  platform: "macos",
  bundleId: "com.apple.Notes",
  apple: true,
  system: false,
  verified: true,
  name: "Notes",
} as const satisfies Computer.AppIdentity
const key = Computer.appKey(notes)

function permissions(status: Computer.PermissionsView["rows"][number]["status"]): Computer.PermissionsView {
  return {
    rows: [
      { id: "screen", status, pane: "screen-pane" },
      { id: "accessibility", status, pane: "accessibility-pane" },
    ],
    canReset: true,
    adhoc: true,
    helperStart: "ok",
    vectorHoldsGrant: { screen: false, accessibility: false },
  }
}

describe("fake computer platform", () => {
  test("defaults are valid, deterministic and off until setup", async () => {
    const fake: Computer.ComputerPlatform = createFakeComputer()
    expect(fake.supported).toBe(true)
    expect(await fake.status()).toEqual({ available: true, backend: "fake" })
    expect(Schema.is(Computer.ComputerState)(await fake.state())).toBe(true)
    expect(await fake.state()).toEqual({
      phase: "off",
      backend: "local-macos",
      mode: "foreground",
      apps: [],
      queue: [],
      escStops: false,
      stopChord: Hands.STOP_CHORD.darwin,
      lease: 0,
      reduceMotion: false,
    })
    expect((await fake.prefs()).prefs).toEqual({
      enabled: false,
      mode: "foreground",
      pointer: "ask",
      blocked: [],
      unblocked: [],
      retention: "7d",
      stopChord: Hands.STOP_CHORD.darwin,
      keepAwake: true,
      notify: true,
      reduceMotion: false,
    })
    expect((await fake.permissions()).rows.map((row) => [row.id, row.status])).toEqual([
      ["screen", "denied"],
      ["accessibility", "denied"],
    ])
    expect(await fake.apps()).toEqual([])
  })

  test("Windows and unsupported Linux fixtures need no OS access", async () => {
    const windows = createFakeComputer({ state: { backend: "local-windows" } })
    expect(Schema.is(Computer.ComputerState)(await windows.state())).toBe(true)
    expect((await windows.state()).stopChord).toBe(Hands.STOP_CHORD.win32)
    expect((await windows.prefs()).prefs.stopChord).toBe(Hands.STOP_CHORD.win32)
    expect(await windows.permissions()).toMatchObject({
      rows: [],
      windows: { captureBlocked: false, elevated: false },
    })
    const linux = createFakeComputer({ supported: false, status: { available: true } })
    expect(linux.supported).toBe(false)
    expect(await linux.status()).toEqual({ available: false, reason: "unsupported_os", backend: "fake" })
    expect(Schema.is(Computer.ComputerState)(await linux.state())).toBe(true)
    expect((await linux.permissions()).rows).toEqual([])
  })

  test("Windows calibration is explicit synthetic metadata and preserves fresh permission failures", async () => {
    const windows: Computer.PermissionsView = {
      rows: [],
      canReset: false,
      adhoc: false,
      helperStart: "ok",
      vectorHoldsGrant: { screen: false, accessibility: false },
      windows: { captureBlocked: false, elevated: false },
    }
    const fake = createFakeComputer({
      state: { backend: "local-windows", phase: "paused" },
      prefs: { consentedAt: 1 },
      permissions: windows,
      recheck: { ...windows, windows: { captureBlocked: true, elevated: false } },
    })
    expect(await fake.inputSetup!("start")).toEqual({ state: "calibrating", mouse: false, keyboard: false })
    fake.emitInputSetup({ state: "calibrating", mouse: true, keyboard: false })
    expect(Computer.inputSetupReady(await fake.inputSetup!("status"))).toBe(false)
    fake.emitInputSetup({ state: "ready", mouse: true, keyboard: true })
    expect((await fake.permissions()).windows?.inputSetup).toEqual({ state: "ready", mouse: true, keyboard: true })
    expect((await fake.recheck()).windows).toEqual({
      captureBlocked: true,
      elevated: false,
      inputSetup: { state: "ready", mouse: true, keyboard: true },
    })
    expect((await fake.state()).phase).toBe("paused")
    expect((await fake.prefs()).prefs.enabled).toBe(false)
    expect(fake.calls).toEqual([
      { method: "inputSetup", action: "start" },
      { method: "inputSetup", action: "status" },
    ])
    expect(await fake.inputSetup!("reset")).toEqual({ state: "needs-calibration", mouse: false, keyboard: false })
  })

  test("passive setup status reads preserve a scripted fresh loss of readiness", async () => {
    const windows: Computer.PermissionsView = {
      rows: [],
      canReset: false,
      adhoc: false,
      helperStart: "ok",
      vectorHoldsGrant: { screen: false, accessibility: false },
      windows: {
        captureBlocked: false,
        elevated: false,
        inputSetup: { state: "ready", mouse: true, keyboard: true },
      },
    }
    const unavailable: Computer.InputSetupStatus = { state: "unavailable", mouse: false, keyboard: false }
    const fake = createFakeComputer({
      state: { backend: "local-windows" },
      permissions: windows,
      recheck: { ...windows, windows: { ...windows.windows!, inputSetup: unavailable } },
    })
    const status = await fake.inputSetup!("status")
    expect(status).toEqual({ state: "ready", mouse: true, keyboard: true })
    Object.assign(status, { mouse: false })
    expect(await fake.inputSetup!("status")).toEqual({ state: "ready", mouse: true, keyboard: true })
    expect((await fake.recheck()).windows?.inputSetup).toEqual(unavailable)
    expect(await fake.inputSetup!("status")).toEqual(unavailable)
    expect(fake.calls.every((call) => call.method === "inputSetup" && call.action === "status")).toBe(true)
  })

  test("scripts survive JSON transport and policy entries become detached maps", async () => {
    const script: FakeComputerScript = {
      status: { available: false, reason: "policy_disabled" },
      prefs: { enabled: true, retention: "1d" },
      policy: { managed: true, enabled: false, apps: [[key, "deny"]], ignored: ["missing Team ID"] },
      always: [{ key, name: "Notes", addedAt: 12 }],
      builtins: [{ key: "app:macos:com.apple.terminal", name: "Terminal", reason: "terminal", removable: false }],
      locked: ["enabled"],
      alwaysReset: true,
    }
    const fake = createFakeComputer(JSON.parse(JSON.stringify(script)))
    const settings = await fake.prefs()
    expect(settings.policy.apps).toBeInstanceOf(Map)
    expect(settings.policy.apps.get(key)).toBe("deny")
    expect(settings.policy.ignored).toEqual(["missing Team ID"])
    expect(settings.alwaysReset).toBe(true)
    expect(settings.always).toEqual(script.always!)
    expect(settings.builtins).toEqual(script.builtins!)
    expect(await fake.status()).toMatchObject({ available: false, reason: "policy_disabled" })
    const mutate = settings.policy.apps as Map<string, "allow" | "deny">
    mutate.set(key, "allow")
    settings.always[0].name = "Changed"
    settings.policy.ignored.push("Changed")
    expect((await fake.prefs()).policy.apps.get(key)).toBe("deny")
    expect((await fake.prefs()).always[0].name).toBe("Notes")
    expect((await fake.prefs()).policy.ignored).toEqual(["missing Team ID"])
  })

  test("permissions, recheck and reset consume independent sequences and repeat the final response", async () => {
    const denied = permissions("denied")
    const unknown = permissions("unknown")
    const granted = permissions("granted")
    const reset = permissions("reset-after-update")
    const fake = createFakeComputer({
      permissions: [denied, unknown],
      recheck: [denied, granted],
      reset: [reset, denied],
    })
    denied.rows[0].status = "granted"
    expect((await fake.permissions()).rows[0].status).toBe("denied")
    expect(await fake.recheck()).toEqual(permissions("denied"))
    expect(await fake.permissions()).toEqual(unknown)
    expect(await fake.recheck()).toEqual(granted)
    expect(await fake.recheck()).toEqual(granted)
    expect(await fake.permissions()).toEqual(unknown)
    expect(await fake.reset("screen")).toEqual(reset)
    expect((await fake.reset("accessibility")).rows[0].status).toBe("denied")
    const response = await fake.reset("screen")
    response.rows[0].status = "granted"
    expect((await fake.reset("screen")).rows[0].status).toBe("denied")
    expect(fake.calls.map((call) => call.method)).toEqual(["reset", "reset", "reset", "reset"])
  })

  test("an unconfigured or empty sequence returns the latest permission view", async () => {
    const granted = permissions("granted")
    const fake = createFakeComputer({ permissions: granted, recheck: [] })
    expect(await fake.recheck()).toEqual(granted)
    expect(await fake.permissions()).toEqual(granted)
    expect(await fake.recheck()).toEqual(granted)
    expect(await fake.reset("screen")).toEqual(granted)
    expect(await fake.permissions()).toEqual(granted)
  })

  test("emit updates state with isolated subscriber snapshots and unsubscribe stops delivery", async () => {
    const initial = { apps: [{ key, name: "Notes" }] }
    const fake = createFakeComputer({ state: initial })
    initial.apps[0].name = "Changed input"
    const seen: string[] = []
    const unsubscribeMutator = fake.onState((state) => Reflect.set(state.apps[0], "name", "Changed listener"))
    const unsubscribe = fake.onState((state) => seen.push(`${state.phase}:${state.apps[0].name}`))
    const working = { ...(await fake.state()), phase: "working" as const }
    fake.emit(working)
    Reflect.set(working.apps[0], "name", "Changed emission")
    expect(seen).toEqual(["working:Notes"])
    expect((await fake.state()).apps[0].name).toBe("Notes")
    const snapshot = await fake.state()
    Reflect.set(snapshot.apps[0], "name", "Changed read")
    expect((await fake.state()).apps[0].name).toBe("Notes")
    unsubscribe()
    unsubscribe()
    fake.emit({ ...(await fake.state()), phase: "paused", pause: "button" })
    expect(seen).toEqual(["working:Notes"])
    unsubscribeMutator()
    expect((await fake.state()).phase).toBe("paused")
  })

  test("subscriptions added during an emission start with the next event", async () => {
    const fake = createFakeComputer()
    const seen: string[] = []
    const later = (state: Computer.ComputerState) => seen.push(state.phase)
    fake.onState(() => fake.onState(later))
    fake.emit({ ...(await fake.state()), phase: "working" })
    expect(seen).toEqual([])
    fake.emit({ ...(await fake.state()), phase: "done" })
    expect(seen).toEqual(["done"])
  })

  test("commands log detached arguments and leave desktop transitions to emit", async () => {
    const fake = createFakeComputer()
    const arg = { sessionID: "ses_queued" }
    for (const command of Computer.Command.literals) await fake.command(command, arg)
    arg.sessionID = "Changed argument"
    expect(fake.calls).toEqual(
      Computer.Command.literals.map((command) => ({ method: "command", command, arg: { sessionID: "ses_queued" } })),
    )
    expect((await fake.state()).phase).toBe("off")
    const snapshot = fake.calls
    Reflect.set(snapshot[0], "command", "Changed log")
    expect(fake.calls[0]).toMatchObject({ command: "stop" })
    await fake.command("stop")
    expect(fake.calls.at(-1)).toEqual({ method: "command", command: "stop" })
  })

  test("settings mutations persist, obey fixture locks and keep input and output snapshots separate", async () => {
    const fake = createFakeComputer({ prefs: { notify: true }, locked: ["notify"] })
    const patch = { mode: "background" as const, notify: false, blocked: [{ key, name: "Notes", addedAt: 10 }] }
    const result = await fake.setPrefs(patch)
    patch.blocked[0].name = "Changed patch"
    result.prefs.blocked[0].name = "Changed return"
    expect((await fake.prefs()).prefs).toMatchObject({
      mode: "background",
      notify: true,
      blocked: [{ key, name: "Notes", addedAt: 10 }],
    })
    expect(fake.calls).toEqual([
      {
        method: "setPrefs",
        prefs: { mode: "background", notify: false, blocked: [{ key, name: "Notes", addedAt: 10 }] },
      },
    ])
    expect((await createFakeComputer().prefs()).prefs.blocked).toEqual([])
  })

  test("app and screenshot actions mutate only the fake and record every requested operation", async () => {
    const fake = createFakeComputer({
      always: [
        { key, name: "Notes", addedAt: 1 },
        { key: "app:macos:com.apple.mail", name: "Mail", addedAt: 2 },
      ],
      builtins: [{ key, name: "Notes", reason: "user", removable: true }],
      apps: [
        { key, name: "Notes", running: true },
        { key: "app:macos:com.apple.mail", name: "Mail", running: false, rule: "company-deny" },
      ],
      removedScreenshots: 4,
      now: 123,
    })
    await fake.removeAlways(key)
    expect((await fake.prefs()).always.map((app) => app.name)).toEqual(["Mail"])
    await fake.removeAllAlways()
    expect((await fake.prefs()).always).toEqual([])
    await fake.block({ key, name: "Notes" })
    await fake.block({ key, name: "Notes" })
    expect((await fake.prefs()).prefs.blocked).toEqual([{ key, name: "Notes", addedAt: 123 }])
    expect(await fake.apps("nOt")).toEqual([{ key, name: "Notes", running: true, rule: "blocked" }])
    await fake.unblock(key)
    expect((await fake.prefs()).prefs.blocked).toEqual([])
    expect((await fake.prefs()).prefs.unblocked).toEqual([key])
    const apps = await fake.apps()
    apps[0].name = "Changed result"
    expect((await fake.apps())[0].name).toBe("Notes")
    expect((await fake.apps("Mail"))[0].rule).toBe("company-deny")
    await fake.openPane("screen")
    await fake.openPane("accessibility")
    await fake.openPane("windows-capture")
    expect(await fake.deleteScreenshots()).toEqual({ removed: 4 })
    expect(await fake.deleteScreenshots()).toEqual({ removed: 0 })
    expect(fake.calls).toEqual([
      { method: "removeAlways", key },
      { method: "removeAllAlways" },
      { method: "block", app: { key, name: "Notes" } },
      { method: "block", app: { key, name: "Notes" } },
      { method: "unblock", key },
      { method: "openPane", id: "screen" },
      { method: "openPane", id: "accessibility" },
      { method: "openPane", id: "windows-capture" },
      { method: "deleteScreenshots" },
      { method: "deleteScreenshots" },
    ] satisfies FakeComputerCall[])
  })

  test("unblocking preserves never and company-denied fixture rules", async () => {
    const fake = createFakeComputer({
      apps: [
        { key, name: "Notes", running: true, rule: "never" },
        { key: "app:macos:com.apple.mail", name: "Mail", running: true, rule: "company-deny" },
      ],
    })
    await fake.block({ key, name: "Notes" })
    await fake.unblock(key)
    await fake.unblock("app:macos:com.apple.mail")
    expect((await fake.apps()).map((app) => app.rule)).toEqual(["never", "company-deny"])
  })

  test("block records a detached copy of the row, stores only app keys main accepts, and honours a blocked lock", async () => {
    const row = { key, name: "Notes", running: true }
    const fake = createFakeComputer({ prefs: { unblocked: ["builtin:find-my"] } })
    await fake.block(row)
    row.name = "Changed after the call"
    expect((await fake.prefs()).prefs.blocked).toEqual([{ key, name: "Notes", addedAt: 0 }])
    // Main validates block keys with parseAppKey (D6b.1), so a removed default is never blocked again this way: only
    // setPrefs({unblocked}) changes it (D6b.8). The calls are still logged.
    await fake.block({ key: "builtin:find-my", name: "Find My" })
    await fake.block({ key: "app:macos:com.Apple.Mail", name: "Mail" })
    expect(fake.calls).toEqual([
      { method: "block", app: { key, name: "Notes" } },
      { method: "block", app: { key: "builtin:find-my", name: "Find My" } },
      { method: "block", app: { key: "app:macos:com.Apple.Mail", name: "Mail" } },
    ])
    expect((await fake.prefs()).prefs).toMatchObject({
      blocked: [{ key, name: "Notes", addedAt: 0 }],
      unblocked: ["builtin:find-my"],
    })

    const locked = createFakeComputer({ locked: ["blocked"] })
    await locked.block({ key, name: "Notes" })
    expect(locked.calls).toEqual([{ method: "block", app: { key, name: "Notes" } }])
    expect((await locked.prefs()).prefs.blocked).toEqual([])
  })

  test("grantAlways stores a detached grant once per key, logs nothing, and Remove takes it off", async () => {
    const fake = createFakeComputer({ always: [{ key: "app:macos:com.apple.mail", name: "Mail", addedAt: 1 }] })
    const grant = { key, name: "Notes", publisher: "Apple Inc.", addedAt: 2 }
    fake.grantAlways(grant)
    grant.name = "Changed after the grant"
    expect((await fake.prefs()).always).toEqual([
      { key: "app:macos:com.apple.mail", name: "Mail", addedAt: 1 },
      { key, name: "Notes", publisher: "Apple Inc.", addedAt: 2 },
    ])
    // A second Always for the same app replaces its entry rather than listing it twice.
    fake.grantAlways({ key, name: "Notes", publisher: "Apple Inc.", addedAt: 3 })
    expect((await fake.prefs()).always.filter((app) => app.key === key)).toEqual([
      { key, name: "Notes", publisher: "Apple Inc.", addedAt: 3 },
    ])
    // It stands in for desktop main observing the reply, not for a renderer command.
    expect(fake.calls).toEqual([])
    await fake.removeAlways(key)
    expect((await fake.prefs()).always.map((app) => app.key)).toEqual(["app:macos:com.apple.mail"])
    expect(fake.calls).toEqual([{ method: "removeAlways", key }])
  })

  test("held app answers wait for releaseApps, and later lookups answer at once", async () => {
    const fake = createFakeComputer({ holdApps: true, apps: [{ key, name: "Notes", running: true }] })
    const answers: string[] = []
    const first = fake.apps("No").then((apps) => answers.push(`first:${apps.length}`))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(answers).toEqual([])
    fake.releaseApps()
    await first
    expect(answers).toEqual(["first:1"])
    expect(await fake.apps("Zz")).toEqual([])
    // Without the option, an answer never waits.
    expect(await createFakeComputer({ apps: [{ key, name: "Notes", running: true }] }).apps()).toHaveLength(1)
  })
})
