import { describe, expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { defaultPolicy } from "./computer-policy"
import {
  access,
  clampRetention,
  createComputerSettings,
  defaultPrefs,
  normalizePrefs,
  resolve,
} from "./computer-settings"

const app: Computer.AppIdentity = {
  platform: "macos",
  bundleId: "com.example.Writer",
  teamId: "TEAM123456",
  apple: false,
  system: false,
  verified: true,
  name: "Writer",
  pid: 10,
  path: "/Applications/Writer.app",
}
const enabled = () => ({ ...defaultPrefs(), enabled: true, consentedAt: 1 })
const ready = (policy = defaultPolicy(), always: Computer.AlwaysAllowed[] = []) => resolve(enabled(), policy, always)
const allowed = (identity = app): Computer.AlwaysAllowed => ({
  key: Computer.appKey(identity),
  name: identity.name,
  teamId: identity.platform === "macos" ? identity.teamId : undefined,
  publisher: identity.platform === "windows" ? identity.publisher : undefined,
  addedAt: 10,
})

function fixture() {
  const values = new Map<string, unknown>([["computer", enabled()]])
  const state = {
    file: undefined as string | undefined,
    secure: true,
    vaultLocked: false,
    writesFail: false,
    policy: defaultPolicy(),
  }
  const input = {
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => {
        values.set(key, structuredClone(value))
      },
      delete: (key: string) => {
        values.delete(key)
      },
    },
    vault: {
      available: () => state.secure,
      seal: (text: string) => Buffer.from(`test-sealed:${text}`),
      open: (bytes: Buffer) => {
        if (state.vaultLocked) throw new Error("Fixture vault is locked")
        return bytes.toString().replace(/^test-sealed:/, "")
      },
    },
    files: {
      read: async () => state.file,
      write: async (text: string) => {
        if (state.writesFail) throw new Error("Fixture disk is full")
        state.file = text
      },
    },
    now: () => 100,
    policy: () => state.policy,
  }
  return { state, values, input, open: () => createComputerSettings(input) }
}

describe("computer settings ceilings and access", () => {
  test("starts off, requires a positive consent timestamp and has no hidden preferences", () => {
    expect(defaultPrefs().enabled).toBe(false)
    expect(
      Object.keys(defaultPrefs()).every((key) => Computer.PREFS_KEYS.includes(key as keyof Computer.ComputerPrefs)),
    ).toBe(true)
    expect(normalizePrefs({ enabled: true }).enabled).toBe(false)
    expect(normalizePrefs({ enabled: true, consentedAt: NaN }).enabled).toBe(false)
    expect(normalizePrefs({ enabled: true, consentedAt: 1 }).enabled).toBe(true)
    expect(defaultPrefs("win32").mode).toBe("foreground")
  })

  test("company disabled, foreground and keep-awake ceilings win while preserving the user's stored choices", () => {
    const prefs = enabled()
    const result = resolve(prefs, {
      ...defaultPolicy(),
      managed: true,
      enabled: false,
      background: false,
      keepAwake: false,
    })
    expect(result.prefs).toMatchObject({ enabled: false, mode: "foreground", keepAwake: false })
    expect(result.locked).toEqual(expect.arrayContaining(["enabled", "mode", "keepAwake"]))
    expect(prefs).toMatchObject({ enabled: true, mode: "background", keepAwake: true })
    expect(access(app, result)).toEqual({ verdict: "company-deny" })
  })

  test("company allow turns a default deny into an ask, never into a grant", () => {
    const policy = {
      ...defaultPolicy(),
      managed: true,
      defaultAccess: "deny" as const,
      apps: new Map([[`${Computer.appKey(app)}@team123456`, "allow" as const]]),
    }
    expect(access(app, ready(policy))).toMatchObject({ verdict: "ask", companyAllowed: true })
    expect(access({ ...app, teamId: "OTHER12345" }, ready(policy))).toEqual({ verdict: "company-deny" })
    expect(access({ ...app, verified: false }, ready(policy))).toEqual({ verdict: "company-deny" })
  })

  test("never apps cannot be unblocked by preferences, company allow, task or saved grants", () => {
    const terminal: Computer.AppIdentity = { ...app, bundleId: "com.apple.Terminal", apple: true, name: "Terminal" }
    const key = Computer.appKey(terminal)
    const policy = { ...defaultPolicy(), managed: true, apps: new Map([[key, "allow" as const]]) }
    const prefs = normalizePrefs({ ...enabled(), unblocked: ComputerApps.TABLE.map((row) => row.key) })
    const result = resolve(prefs, policy, [allowed(terminal)])
    expect(access(terminal, result, { task: new Map([[key, { identity: terminal, level: "interact" }]]) })).toEqual({
      verdict: "never",
      reason: "terminal",
    })
    expect(result.builtins.filter((row) => !row.removable).length).toBeGreaterThan(0)
    expect(prefs.unblocked.every((key) => ComputerApps.DEFAULT_BLOCKED.some((row) => row.key === key))).toBe(true)
  })

  test("a default-blocked system app may be explicitly unblocked without removing the never floor", () => {
    const disk: Computer.AppIdentity = {
      ...app,
      bundleId: "com.apple.DiskUtility",
      apple: true,
      system: true,
      name: "Disk Utility",
    }
    const builtin = ComputerApps.builtinRule(disk)!
    expect(builtin.removable).toBe(true)
    expect(access(disk, ready())).toEqual({ verdict: "blocked", reason: "default" })
    expect(access(disk, resolve({ ...enabled(), unblocked: [builtin.key] }))).toMatchObject({ verdict: "ask" })
  })

  test("desktop furniture and reserved remote identities are never app grant targets", () => {
    const dock: Computer.AppIdentity = { ...app, bundleId: "com.apple.dock", apple: true, system: true, name: "Dock" }
    expect(access(dock, ready())).toEqual({ verdict: "never", reason: "security" })
    expect(access({ platform: "remote", id: "reserved", name: "Reserved", verified: false }, ready())).toEqual({
      verdict: "never",
      reason: "remote",
    })
  })

  test("a user block and a conversation deny precede grants; a mention only lifts a deny back to ask", () => {
    const key = Computer.appKey(app)
    const task = new Map([[key, { identity: app, level: "interact" as const }]])
    expect(access(app, resolve({ ...enabled(), blocked: [{ key, name: app.name, addedAt: 1 }] }), { task })).toEqual({
      verdict: "blocked",
      reason: "user",
    })
    expect(access(app, ready(), { task, denied: new Set([key]) })).toEqual({ verdict: "denied" })
    expect(access(app, ready(), { denied: new Set([key]), liftDeny: true })).toMatchObject({ verdict: "ask" })
    expect(
      access(app, ready(defaultPolicy(), [allowed()]), { task, denied: new Set([key]), liftDeny: true }),
    ).toMatchObject({ verdict: "ask" })
  })

  test("unverified apps can have a task-only grant, bound to the observed process and path", () => {
    const unsigned: Computer.AppIdentity = { ...app, verified: false, teamId: undefined }
    const task = new Map([[Computer.appKey(unsigned), { identity: unsigned, level: "observe" as const }]])
    expect(access(unsigned, ready(), { task })).toEqual({ verdict: "granted", level: "observe", via: "task" })
    expect(access({ ...unsigned, pid: 11 }, ready(), { task })).toMatchObject({ verdict: "ask", canAlways: false })
    expect(access({ ...unsigned, path: "/other/Writer.app" }, ready(), { task })).toMatchObject({ verdict: "ask" })
  })

  test("missing process identity never matches an unverified task grant", () => {
    const identities: Computer.AppIdentity[] = [
      { ...app, verified: false, teamId: undefined, path: undefined, pid: undefined },
      { ...app, verified: false, pid: undefined },
      { platform: "windows", kind: "aumid", aumid: "Example.Writer", name: "Writer", verified: false, system: false },
      {
        platform: "windows",
        kind: "exe",
        publisher: "",
        product: "Writer",
        binary: "writer.exe",
        exe: "C:\\writer.exe",
        name: "Writer",
        verified: false,
        system: false,
      },
    ]
    for (const identity of identities) {
      const task = new Map([[Computer.appKey(identity), { identity, level: "interact" as const }]])
      expect(access(identity, ready(), { task })).toMatchObject({ verdict: "ask", canAlways: false })
    }
  })

  test("a changed signer asks again with no Always; an explicit new task approval still works", () => {
    const changed: Computer.AppIdentity = { ...app, teamId: "OTHER12345" }
    const settings = ready(defaultPolicy(), [allowed()])
    expect(access(app, settings)).toEqual({ verdict: "granted", level: "interact", via: "always" })
    expect(access(changed, settings)).toMatchObject({
      verdict: "ask",
      changed: true,
      canAlways: false,
      alwaysWhyNot: "changed",
    })
    expect(
      access(changed, settings, {
        task: new Map([[Computer.appKey(changed), { identity: changed, level: "interact" }]]),
      }),
    ).toMatchObject({ verdict: "granted", via: "task" })
  })

  test("Windows signer changes are detected without matching a display name", () => {
    const windows: Computer.AppIdentity = {
      platform: "windows",
      kind: "exe",
      publisher: "Publisher A",
      product: "Writer",
      binary: "Writer.exe",
      exe: "C:\\Writer.exe",
      name: "Writer",
      system: false,
      verified: true,
    }
    const old = { key: Computer.appKey(windows), publisher: windows.publisher, name: windows.name, addedAt: 1 }
    expect(access({ ...windows, publisher: "Publisher B" }, ready(defaultPolicy(), [old]))).toMatchObject({
      verdict: "ask",
      changed: true,
      canAlways: false,
    })
    expect(access({ ...windows, product: "Another product" }, ready(defaultPolicy(), [old]))).toMatchObject({
      verdict: "ask",
      changed: false,
    })
  })

  test("company no-Always and category ceilings also restrict existing saved approvals", () => {
    expect(access(app, ready({ ...defaultPolicy(), allowAlways: false }, [allowed()]))).toMatchObject({
      verdict: "ask",
      canAlways: false,
      alwaysWhyNot: "policy",
    })
    const browser: Computer.AppIdentity = { ...app, bundleId: "com.apple.Safari", apple: true, name: "Safari" }
    expect(access(browser, ready(defaultPolicy(), [allowed(browser)]))).toMatchObject({
      verdict: "ask",
      canAlways: false,
      alwaysWhyNot: "category",
    })
  })

  test("retention uses the longest available option within the company maximum", () => {
    expect(clampRetention("session", 365)).toBe("30d")
    expect(clampRetention("30d", 6)).toBe("1d")
    expect(clampRetention("7d", 0)).toBe("task")
    expect(clampRetention("task", 7)).toBe("task")
    expect(clampRetention("session")).toBe("session")
    expect(resolve(enabled(), { ...defaultPolicy(), maxRetentionDays: 0 }).locked).toContain("retention")
  })
})

describe("sealed approval persistence", () => {
  test("saves only eligible approvals, verifies them on reload, and snapshots cannot change authority", async () => {
    const fake = fixture()
    const settings = await fake.open()
    expect(await settings.acceptAlways(app)).toBe(true)
    expect(fake.values.get("computerAlwaysKey")).toBeString()
    const reloaded = await fake.open()
    const copy = reloaded.get()
    copy.always[0].teamId = "OTHER12345"
    copy.policy.apps = new Map([[Computer.appKey(app), "deny"]])
    expect(reloaded.access(app)).toMatchObject({ verdict: "granted", via: "always" })
    expect(JSON.parse(fake.state.file!).entries).toHaveLength(1)
  })

  test("an edited list is discarded and reported, rather than trusted or silently repaired", async () => {
    const fake = fixture()
    const first = await fake.open()
    await first.acceptAlways(app)
    const changed = JSON.parse(fake.state.file!)
    changed.entries[0].teamId = "OTHER12345"
    fake.state.file = JSON.stringify(changed)
    const reloaded = await fake.open()
    expect(reloaded.get()).toMatchObject({ always: [], alwaysReset: true })
    expect(reloaded.access(app)).toMatchObject({ verdict: "ask" })
    expect(fake.values.has("computerAlwaysKey")).toBe(false)
  })

  test("the signing key is required and unexpected list fields are refused", async () => {
    for (const mutate of [
      (fake: ReturnType<typeof fixture>) => {
        fake.values.delete("computerAlwaysKey")
      },
      (fake: ReturnType<typeof fixture>) => {
        fake.state.file = JSON.stringify({ ...JSON.parse(fake.state.file!), injected: true })
      },
    ]) {
      const fake = fixture()
      await (await fake.open()).acceptAlways(app)
      mutate(fake)
      expect((await fake.open()).get()).toMatchObject({ always: [], alwaysReset: true })
    }
  })

  test("a temporary vault failure preserves encrypted approvals and does not label them edited", async () => {
    const fake = fixture()
    await (await fake.open()).acceptAlways(app)
    const before = fake.state.file
    fake.state.vaultLocked = true
    await expect(fake.open()).rejects.toThrow("Secure storage")
    expect(fake.state.file).toBe(before)
    expect(fake.values.has("computerAlwaysKey")).toBe(true)
    expect(fake.values.has("computerAlwaysReset")).toBe(false)
    fake.state.vaultLocked = false
    expect((await fake.open()).access(app)).toMatchObject({ verdict: "granted", via: "always" })
  })

  test("without OS secure storage no approval or plaintext key is saved", async () => {
    const fake = fixture()
    fake.state.secure = false
    const settings = await fake.open()
    await expect(settings.acceptAlways(app)).rejects.toThrow("Secure storage")
    expect(settings.get().always).toEqual([])
    expect(fake.state.file).toBeUndefined()
    expect(fake.values.has("computerAlwaysKey")).toBe(false)
  })

  test("a revoke takes effect on next access and stays revoked after reload", async () => {
    const fake = fixture()
    const settings = await fake.open()
    await settings.acceptAlways(app)
    await settings.removeAlways(Computer.appKey(app))
    expect(settings.access(app)).toMatchObject({ verdict: "ask" })
    expect((await fake.open()).access(app)).toMatchObject({ verdict: "ask" })
  })

  test("a failed revoke invalidates the old signing key so restart cannot restore the grant", async () => {
    const fake = fixture()
    const settings = await fake.open()
    await settings.acceptAlways(app)
    fake.state.writesFail = true
    await expect(settings.removeAllAlways()).rejects.toThrow("disk is full")
    expect(settings.access(app)).toMatchObject({ verdict: "ask" })
    expect((await fake.open()).get().always).toEqual([])
  })

  test("policy changes cannot be overridden by an Always reply from a client", async () => {
    const fake = fixture()
    const settings = await fake.open()
    fake.state.policy.allowAlways = false
    expect(await settings.acceptAlways(app)).toBe(false)
    expect(fake.state.file).toBeUndefined()
    fake.state.policy = { ...defaultPolicy(), enabled: false }
    expect(await settings.acceptAlways(app)).toBe(false)
  })

  test("persists preferences under the desktop computer key and validates app blocks", async () => {
    const fake = fixture()
    const settings = await fake.open()
    await settings.setPrefs({ enabled: false })
    expect(fake.values.get("computer")).toMatchObject({ enabled: false })
    await expect(settings.setPrefs({ enabled: true, consentedAt: undefined })).rejects.toThrow("consent")
    await settings.setPrefs({ enabled: true, consentedAt: 100 })
    await settings.block({ key: Computer.appKey(app), name: "Writer\u202e" })
    expect(settings.get().prefs.blocked).toEqual([{ key: Computer.appKey(app), name: "Writer", addedAt: 100 }])
    expect(settings.access(app)).toEqual({ verdict: "blocked", reason: "user" })
    await expect(settings.block({ key: "builtin:terminal", name: "Terminal" })).rejects.toThrow("Invalid app block")
    await settings.unblock(Computer.appKey(app))
    expect(settings.access(app)).toMatchObject({ verdict: "ask" })
  })
})
