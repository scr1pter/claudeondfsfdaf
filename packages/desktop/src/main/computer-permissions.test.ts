import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { COMPUTER_PERMISSION_REQUESTS_KEY, createComputerPermissions } from "./computer-permissions"
import type { PermissionProbe } from "./computer-permissions"
import { defaultPrefs, resolve } from "./computer-settings"

const anchors = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  windows: "ms-settings:privacy",
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function fixture(platform: "darwin" | "win32" = "darwin", verified = false) {
  const values = new Map<string, unknown>()
  const log: string[] = []
  const requests: { op: Computer.HelperOpName; args?: Record<string, unknown> }[] = []
  const patches: Partial<Computer.ComputerPrefs>[] = []
  const urls: string[] = []
  const vectorCalls: unknown[] = []
  const state = {
    probe: {
      permissions: {
        screen: platform === "darwin" ? "denied" : "n/a",
        accessibility: platform === "darwin" ? "denied" : "n/a",
      },
      responsible: true,
      ...(platform === "win32" ? { captureBlocked: false, elevated: false } : {}),
    } as PermissionProbe,
    probes: 0,
    refreshes: 0,
    kind: "signed" as "signed" | "adhoc" | "unknown",
    prefs: defaultPrefs(platform),
    ownScreen: "denied",
    ownAccessibility: false,
    elevated: false,
    at: 100,
    probeThrows: false,
    signingThrows: false,
    vectorThrows: false,
    elevationThrows: false,
    storeThrows: false,
    requestThrows: false,
    refreshThrows: false,
    probeFactory: undefined as (() => Promise<PermissionProbe>) | undefined,
    requestGate: undefined as Promise<void> | undefined,
    storeGate: undefined as Promise<void> | undefined,
    refreshGate: undefined as Promise<void> | undefined,
    onRequest: undefined as
      | ((op: Computer.HelperOpName, args?: Record<string, unknown>) => void | Promise<void>)
      | undefined,
  }
  const input = {
    platform,
    helperVersion: "1.0.0",
    resetVerified: verified,
    now: () => state.at,
    helper: {
      probe: async () => {
        state.probes++
        log.push("probe")
        if (state.probeThrows) throw new Error("Fixture helper cannot start")
        return state.probeFactory ? state.probeFactory() : structuredClone(state.probe)
      },
      request: async <T>(op: Computer.HelperOpName, args?: Record<string, unknown>) => {
        log.push(op)
        requests.push({ op, args: structuredClone(args) })
        await state.requestGate
        if (state.requestThrows) throw new Error("Fixture native permission request failed")
        await state.onRequest?.(op, args)
        return structuredClone(state.probe.permissions) as T
      },
      refreshPermissions: async () => {
        log.push("refresh")
        state.refreshes++
        await state.refreshGate
        if (state.refreshThrows) throw new Error("Fixture helper refresh failed")
      },
    },
    settings: {
      get: () => resolve(state.prefs),
      setPrefs: async (patch: Partial<Computer.ComputerPrefs>) => {
        patches.push(structuredClone(patch))
        Object.assign(state.prefs, structuredClone(patch))
      },
    },
    promptStore: {
      get: (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        log.push("persist-start")
        await state.storeGate
        if (state.storeThrows) throw new Error("Fixture private store is unavailable")
        values.set(key, structuredClone(value))
        log.push("persist-done")
      },
    },
    signing: () => {
      if (state.signingThrows) throw new Error("Fixture signature is unavailable")
      return state.kind
    },
    vector: {
      getMediaAccessStatus: (type: "screen") => {
        vectorCalls.push(type)
        if (state.vectorThrows) throw new Error("Fixture Vector query failed")
        return state.ownScreen
      },
      isTrustedAccessibilityClient: (prompt: false) => {
        vectorCalls.push(prompt)
        if (state.vectorThrows) throw new Error("Fixture Vector query failed")
        return state.ownAccessibility
      },
    },
    elevated: () => {
      if (state.elevationThrows) throw new Error("Fixture elevation query failed")
      return state.elevated
    },
    openExternal: (url: string) => {
      log.push("open")
      urls.push(url)
    },
  }
  return {
    state,
    values,
    log,
    requests,
    patches,
    urls,
    vectorCalls,
    input,
    open: (overrides: Partial<Parameters<typeof createComputerPermissions>[0]> = {}) =>
      createComputerPermissions({ ...input, ...overrides }),
  }
}

describe("fresh permission truth", () => {
  test("every list performs a new probe without prompts, URL opens or private preference writes", async () => {
    const f = fixture()
    const permissions = f.open()
    expect((await permissions.list()).rows).toEqual([
      { id: "screen", status: "denied", pane: anchors.screen },
      { id: "accessibility", status: "denied", pane: anchors.accessibility },
    ])
    f.state.probe.permissions.screen = "granted"
    expect((await permissions.list()).rows[0].status).toBe("granted")
    expect(f.state.probes).toBe(2)
    expect(f.requests).toEqual([])
    expect(f.urls).toEqual([])
    expect(f.values.size).toBe(0)
    expect(f.patches).toEqual([])
  })

  test("Vector's grants are queried read-only and never stand in for the helper's grants", async () => {
    const f = fixture()
    f.state.ownScreen = "granted"
    f.state.ownAccessibility = true
    const view = await f.open().list()
    expect(view.vectorHoldsGrant).toEqual({ screen: true, accessibility: true })
    expect(view.rows.map((row) => row.status)).toEqual(["denied", "denied"])
    expect(f.vectorCalls).toEqual(["screen", false])
    expect(f.requests).toEqual([])
    f.state.vectorThrows = true
    expect((await f.open().list()).vectorHoldsGrant).toEqual({ screen: false, accessibility: false })
  })

  test("both actual grants record the helper version once without enabling Hands or recording consent", async () => {
    const f = fixture()
    f.state.probe.permissions = { screen: "granted", accessibility: "granted", postEvent: "granted" }
    const permissions = f.open()
    await permissions.list()
    f.state.at = 200
    await permissions.list()
    expect(f.patches).toEqual([{ granted: { helperVersion: "1.0.0", at: 100 } }])
    expect(f.state.prefs.enabled).toBe(false)
    expect(f.state.prefs.consentedAt).toBeUndefined()
    await f.open({ helperVersion: "1.1.0" }).list()
    expect(f.state.prefs.granted).toEqual({ helperVersion: "1.1.0", at: 200 })
    expect(Object.keys(f.state.prefs)).not.toContain("requested")
  })

  for (const at of [0, -1, NaN, Infinity, 1.5])
    test(`does not persist an invalid grant timestamp ${at}`, async () => {
      const f = fixture()
      f.state.probe.permissions = { screen: "granted", accessibility: "granted" }
      f.state.at = at
      await f.open().list()
      expect(f.patches).toEqual([])
    })

  for (const failure of ["probe", "malformed", "responsibility", "signature", "signature-throw"] as const)
    test(`${failure} failure reports unknown helper rows without erasing enabled preferences`, async () => {
      const f = fixture("darwin", true)
      Object.assign(f.state.prefs, { enabled: true, consentedAt: 1 })
      if (failure === "probe") f.state.probeThrows = true
      if (failure === "malformed") f.state.probe = { permissions: { screen: "granted" } } as PermissionProbe
      if (failure === "responsibility") f.state.probe.responsible = false
      if (failure === "signature") f.state.kind = "unknown"
      if (failure === "signature-throw") f.state.signingThrows = true
      const view = await f.open().list()
      expect(view).toMatchObject({ helperStart: "failed", canReset: false })
      expect(view.rows.map((row) => row.status)).toEqual(["unknown", "unknown"])
      expect(f.state.prefs).toMatchObject({ enabled: true, consentedAt: 1 })
      expect(f.patches).toEqual([])
    })

  test("known ad-hoc signing is shown truthfully and can use an owner-verified reset build", async () => {
    const f = fixture("darwin", true)
    f.state.kind = "adhoc"
    expect(await f.open().list()).toMatchObject({ helperStart: "ok", adhoc: true, canReset: true })
  })

  test("a previously recorded helper grant makes a later denial a reset-after-update row", async () => {
    const f = fixture()
    f.state.prefs.granted = { helperVersion: "1.0.0", at: 1 }
    const permissions = f.open()
    expect((await permissions.list()).rows.map((row) => row.status)).toEqual([
      "reset-after-update",
      "reset-after-update",
    ])
    f.state.probe.permissions.postEvent = "n/a"
    expect((await permissions.list()).rows[1].status).toBe("reset-after-update")
    f.state.probe.permissions = { screen: "notDetermined", accessibility: "restricted" }
    expect((await permissions.list()).rows.map((row) => row.status)).toEqual(["unknown", "denied"])
  })

  for (const postEvent of ["denied", "restricted", "notDetermined", "n/a"] as const)
    test(`explicit postEvent ${postEvent} prevents a false Accessibility-ready view and grant stamp`, async () => {
      const f = fixture()
      f.state.probe.permissions = { screen: "granted", accessibility: "granted", postEvent }
      const view = await f.open().list()
      expect(view.rows[1].status).toBe(postEvent === "denied" || postEvent === "restricted" ? "denied" : "unknown")
      expect(f.patches).toEqual([])
    })

  test("Windows reports native capture/elevation facts without querying macOS grants or showing TCC rows", async () => {
    const f = fixture("win32", true)
    const permissions = f.open()
    expect(await permissions.list()).toMatchObject({
      rows: [],
      helperStart: "ok",
      canReset: false,
      adhoc: false,
      windows: {
        captureBlocked: false,
        elevated: false,
        inputSetup: { state: "unavailable", mouse: false, keyboard: false },
      },
    })
    f.state.probe.permissions.captureBlocked = true
    f.state.elevated = true
    expect((await permissions.list()).windows).toEqual({
      captureBlocked: true,
      elevated: true,
      inputSetup: { state: "unavailable", mouse: false, keyboard: false },
    })
    expect(f.vectorCalls).toEqual([])
    expect(f.requests).toEqual([])
  })

  test("missing Windows truth and failed elevation checks fail closed", async () => {
    const f = fixture("win32")
    delete f.state.probe.captureBlocked
    delete f.state.probe.elevated
    expect((await f.open({ elevated: undefined }).list()).helperStart).toBe("failed")
    f.state.probe.captureBlocked = false
    expect((await f.open({ elevated: undefined }).list()).helperStart).toBe("failed")
    f.state.probe.elevated = false
    f.state.elevationThrows = true
    expect((await f.open().list()).helperStart).toBe("failed")
  })

  test("a later completed probe prevents an older denial from replacing its granted snapshot", async () => {
    const f = fixture()
    const old = Promise.withResolvers<PermissionProbe>()
    const denied = structuredClone(f.state.probe)
    const permissions = f.open()
    f.state.probeFactory = () => old.promise
    const earlier = permissions.list()
    await flush()
    f.state.probeFactory = undefined
    f.state.probe.permissions = { screen: "granted", accessibility: "granted" }
    const latest = await permissions.list()
    old.resolve(denied)
    expect(await earlier).toEqual(latest)
    await permissions.recheck()
    expect(f.state.refreshes).toBe(0)
  })
})

describe("explicit permission prompts and fixed panes", () => {
  test("only the fixed platform anchors can be opened", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.openPane("screen")
    await permissions.openPane("accessibility")
    expect(f.urls).toEqual([anchors.screen, anchors.accessibility])
    expect(f.requests).toEqual([
      { op: "permissions.request", args: { service: "screen" } },
      { op: "permissions.request", args: { service: "accessibility" } },
    ])
    const before = [...f.log]
    for (const id of ["windows-capture", "https://example.com", anchors.screen, "screen&Privacy_AllFiles"])
      expect(() => permissions.openPane(id as "screen")).toThrow()
    expect(f.log).toEqual(before)
    const windows = fixture("win32")
    await windows.open().openPane("windows-capture")
    expect(windows.urls).toEqual([anchors.windows])
    expect(windows.state.probes).toBe(0)
    expect(windows.requests).toEqual([])
    expect(windows.values.size).toBe(0)
    expect(() => windows.open().openPane("screen")).toThrow()
  })

  test("the first click revalidates helper responsibility before any native request or stamp", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    f.state.probe.responsible = false
    await expect(permissions.openPane("screen")).rejects.toMatchObject({ code: "unavailable" })
    expect(f.state.probes).toBe(2)
    expect(f.requests).toEqual([])
    expect(f.values.size).toBe(0)
    expect(f.urls).toEqual([])
    f.state.probe.responsible = true
    await permissions.openPane("screen")
    expect(f.requests).toHaveLength(1)
  })

  test("the first-click stamp is durably saved before requesting, even with concurrent controller instances", async () => {
    const f = fixture()
    const saved = Promise.withResolvers<void>()
    f.state.storeGate = saved.promise
    const first = f.open().openPane("screen")
    const second = f.open().openPane("screen")
    await flush()
    expect(f.log).toContain("persist-start")
    expect(f.requests).toEqual([])
    expect(f.urls).toEqual([])
    saved.resolve()
    await Promise.all([first, second])
    expect(f.requests).toHaveLength(1)
    expect(f.urls).toEqual([anchors.screen, anchors.screen])
    expect(f.log.indexOf("persist-done")).toBeLessThan(f.log.indexOf("permissions.request"))
    await f.open({ helperVersion: "2.0.0" }).openPane("screen")
    expect(f.requests).toHaveLength(1)
    expect(f.values.get(COMPUTER_PERMISSION_REQUESTS_KEY)).toEqual({ version: 1, screen: true, accessibility: false })
    expect(f.patches).toEqual([])
  })

  test("concurrent service requests preserve both private service stamps", async () => {
    const f = fixture()
    await Promise.all([f.open().openPane("screen"), f.open().openPane("accessibility"), f.open().openPane("screen")])
    expect(f.requests.map((request) => request.args?.service)).toEqual(["screen", "accessibility"])
    expect(f.values.get(COMPUTER_PERMISSION_REQUESTS_KEY)).toEqual({ version: 1, screen: true, accessibility: true })
  })

  test("an unknown prior prompt stamp suppresses native prompts while keeping the fixed Settings link usable", async () => {
    const f = fixture()
    f.values.set(COMPUTER_PERMISSION_REQUESTS_KEY, { version: 99, screen: false })
    await f.open().openPane("screen")
    await f.open().openPane("accessibility")
    expect(f.urls).toEqual([anchors.screen, anchors.accessibility])
    expect(f.requests).toEqual([])
    expect(f.state.probes).toBe(0)
  })

  test("a failed stamp write prevents prompting; a failed native request retains the stamp across restart", async () => {
    const f = fixture()
    f.state.storeThrows = true
    await expect(f.open().openPane("screen")).rejects.toThrow("private store")
    expect(f.requests).toEqual([])
    f.state.storeThrows = false
    f.state.requestThrows = true
    await expect(f.open().openPane("screen")).rejects.toThrow("native permission request")
    expect(f.values.get(COMPUTER_PERMISSION_REQUESTS_KEY)).toMatchObject({ screen: true })
    f.state.probeThrows = true
    await f.open().openPane("screen")
    expect(f.requests).toHaveLength(1)
    expect(f.urls).toEqual([anchors.screen])
  })
})

describe("helper-only permission refresh and verified reset", () => {
  test("polling a Screen Recording change does not erase the pending helper refresh", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    f.state.probe.permissions.screen = "granted"
    await permissions.list()
    await permissions.list()
    expect(f.state.refreshes).toBe(0)
    expect((await permissions.recheck()).rows[0].status).toBe("granted")
    expect(f.state.refreshes).toBe(1)
    await permissions.recheck()
    expect(f.state.refreshes).toBe(1)
    f.state.probe.permissions.accessibility = "granted"
    await permissions.recheck()
    expect(f.state.refreshes).toBe(1)
    f.state.probe.permissions.screen = "denied"
    await permissions.recheck()
    expect(f.state.refreshes).toBe(2)
    expect(f.requests).toEqual([])
  })

  test("a failed helper refresh stays unavailable and a later explicit recheck can retry", async () => {
    const f = fixture("darwin", true)
    const permissions = f.open()
    await permissions.list()
    f.state.probe.permissions.screen = "granted"
    f.state.refreshThrows = true
    const failed = await permissions.recheck()
    expect(failed).toMatchObject({ helperStart: "failed", canReset: false })
    expect(failed.rows.every((row) => row.status === "unknown")).toBe(true)
    f.state.refreshThrows = false
    expect((await permissions.recheck()).helperStart).toBe("ok")
    expect(f.state.refreshes).toBe(2)
  })

  test("a stale probe completion cannot restore the healthy snapshot after refresh failure", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    const old = Promise.withResolvers<PermissionProbe>()
    f.state.probeFactory = () => old.promise
    const earlier = permissions.list()
    await flush()
    f.state.probeFactory = undefined
    f.state.probe.permissions.screen = "granted"
    f.state.refreshThrows = true
    await permissions.recheck()
    old.resolve({ permissions: { screen: "granted", accessibility: "granted" }, responsible: true })
    expect(await earlier).toMatchObject({ helperStart: "failed", canReset: false })
    expect(f.patches).toEqual([])
  })

  test("concurrent rechecks coalesce after serialized refresh and return the freshest probe snapshot", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    f.state.probe.permissions.screen = "granted"
    const gate = Promise.withResolvers<void>()
    f.state.refreshGate = gate.promise
    const first = permissions.recheck()
    await flush()
    const second = permissions.recheck()
    await flush()
    expect(f.state.refreshes).toBe(1)
    gate.resolve()
    await Promise.all([first, second])
    expect(f.state.refreshes).toBe(1)
  })

  test("reset rejects unverified, wrong-platform and invalid-service requests before OS effects", async () => {
    const f = fixture()
    const permissions = f.open()
    expect((await permissions.list()).canReset).toBe(false)
    const before = [...f.log]
    expect(() => permissions.reset("screen")).toThrow()
    expect(() => permissions.reset("Privacy_AllFiles" as "screen")).toThrow()
    expect(f.log).toEqual(before)
    const windows = fixture("win32", true)
    expect(() => windows.open().reset("screen")).toThrow()
    expect(windows.log).toEqual([])
  })

  test("verified reset still requires fresh known signing and helper responsibility", async () => {
    const f = fixture("darwin", true)
    const permissions = f.open()
    expect((await permissions.list()).canReset).toBe(true)
    f.state.probe.responsible = false
    await expect(permissions.reset("accessibility")).rejects.toMatchObject({ code: "unavailable" })
    f.state.probe.responsible = true
    f.state.kind = "unknown"
    await expect(permissions.reset("accessibility")).rejects.toMatchObject({ code: "unavailable" })
    expect(f.requests).toEqual([])
  })

  test("successful explicit reset clears only that service's prompt stamp and returns fresh status", async () => {
    const f = fixture("darwin", true)
    const permissions = f.open()
    await permissions.openPane("screen")
    await permissions.openPane("accessibility")
    f.state.onRequest = (op) => {
      if (op === "permissions.reset") f.state.probe.permissions.accessibility = "notDetermined"
    }
    expect((await permissions.reset("accessibility")).rows[1].status).toBe("unknown")
    expect(f.values.get(COMPUTER_PERMISSION_REQUESTS_KEY)).toEqual({ version: 1, screen: true, accessibility: false })
    expect(f.state.refreshes).toBe(0)
    await f.open().openPane("screen")
    await f.open().openPane("accessibility")
    expect(f.requests.map((request) => `${request.op}:${request.args?.service}`)).toEqual([
      "permissions.request:screen",
      "permissions.request:accessibility",
      "permissions.reset:accessibility",
      "permissions.request:accessibility",
    ])
  })

  test("screen reset refreshes the helper before returning even if the raw permission value stays unchanged", async () => {
    const f = fixture("darwin", true)
    const permissions = f.open()
    await permissions.list()
    await permissions.reset("screen")
    expect(f.state.refreshes).toBe(1)
    expect(f.log.indexOf("permissions.reset")).toBeLessThan(f.log.indexOf("refresh"))
    f.state.probe.permissions.screen = "granted"
    await permissions.list()
    await permissions.recheck()
    expect(f.state.refreshes).toBe(2)
  })

  test("successful OS reset still refreshes the helper when persisting the cleared prompt stamp fails", async () => {
    const f = fixture("darwin", true)
    f.values.set(COMPUTER_PERMISSION_REQUESTS_KEY, { version: 1, screen: true, accessibility: true })
    f.state.storeThrows = true
    f.state.onRequest = (op) => {
      if (op === "permissions.reset") f.state.probe.permissions.screen = "notDetermined"
    }
    await expect(f.open().reset("screen")).rejects.toThrow("private store")
    expect(f.state.refreshes).toBe(1)
    expect(f.values.get(COMPUTER_PERMISSION_REQUESTS_KEY)).toEqual({ version: 1, screen: true, accessibility: true })
    expect(f.log.indexOf("permissions.reset")).toBeLessThan(f.log.indexOf("refresh"))
  })

  test("successful screen reset retires the helper even if its subsequent fresh probe fails", async () => {
    const f = fixture("darwin", true)
    f.state.onRequest = (op) => {
      if (op === "permissions.reset") f.state.probeThrows = true
    }
    const view = await f.open().reset("screen")
    expect(f.state.refreshes).toBe(1)
    expect(view).toMatchObject({ helperStart: "failed", canReset: false })
    expect(view.rows.every((row) => row.status === "unknown")).toBe(true)
  })

  test("a permission request cannot be interrupted by a concurrent recheck refresh", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    const gate = Promise.withResolvers<void>()
    f.state.requestGate = gate.promise
    const prompt = permissions.openPane("screen")
    await flush()
    expect(f.requests).toHaveLength(1)
    f.state.probe.permissions.screen = "granted"
    const recheck = permissions.recheck()
    await flush()
    expect(f.state.refreshes).toBe(0)
    gate.resolve()
    await Promise.all([prompt, recheck])
    expect(f.state.refreshes).toBe(1)
    expect(f.log.indexOf("open")).toBeLessThan(f.log.indexOf("refresh"))
  })

  test("a concurrent recheck cannot kill an in-flight reset or overwrite its newer result", async () => {
    const f = fixture("darwin", true)
    f.state.probe.permissions = { screen: "granted", accessibility: "granted" }
    const permissions = f.open()
    await permissions.list()
    const gate = Promise.withResolvers<void>()
    f.state.requestGate = gate.promise
    f.state.onRequest = (op) => {
      if (op === "permissions.reset") f.state.probe.permissions.screen = "notDetermined"
    }
    const reset = permissions.reset("screen")
    await flush()
    const recheck = permissions.recheck()
    await flush()
    expect(f.requests[0].op).toBe("permissions.reset")
    expect(f.state.refreshes).toBe(0)
    gate.resolve()
    const views = await Promise.all([reset, recheck])
    expect(f.state.refreshes).toBe(1)
    expect(views.map((view) => view.rows[0].status)).toEqual(["unknown", "unknown"])
  })

  test("a later fresh probe remains visible while an earlier helper refresh completes", async () => {
    const f = fixture()
    const permissions = f.open()
    await permissions.list()
    f.state.probe.permissions.screen = "granted"
    const gate = Promise.withResolvers<void>()
    f.state.refreshGate = gate.promise
    const recheck = permissions.recheck()
    await flush()
    f.state.probe.permissions.screen = "notDetermined"
    await permissions.list()
    gate.resolve()
    expect((await recheck).rows[0].status).toBe("unknown")
    await permissions.recheck()
    expect(f.state.refreshes).toBe(2)
  })
})
