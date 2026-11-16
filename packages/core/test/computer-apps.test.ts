import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"

type Sample = { id: string; app: Computer.AppIdentity; signals?: ComputerApps.Signals }

const concrete = (id: string) => (id.endsWith("*") ? `${id.slice(0, -1)}x` : id)

const mac = (bundleId: string, extra: Partial<Computer.MacIdentity> = {}): Computer.AppIdentity => ({
  platform: "macos",
  bundleId,
  apple: false,
  system: false,
  verified: true,
  name: bundleId,
  ...extra,
})

const exe = (binary: string, extra: Partial<Computer.WindowsExeIdentity> = {}): Computer.AppIdentity => ({
  platform: "windows",
  kind: "exe",
  publisher: "",
  product: binary,
  binary,
  system: false,
  verified: false,
  name: binary,
  exe: `C:\\Apps\\${binary}`,
  ...extra,
})

const aumid = (id: string, extra: Partial<Computer.WindowsAumidIdentity> = {}): Computer.AppIdentity => ({
  platform: "windows",
  kind: "aumid",
  aumid: id,
  system: false,
  verified: true,
  name: id,
  ...extra,
})

/** One identity for every id an entry lists. */
function samples(entry: ComputerApps.AppMatcher): Sample[] {
  return [
    ...(entry.macos ?? []).map((id) => ({ id, app: mac(concrete(id)) })),
    ...(entry.windows?.aumid ?? []).map((id) => ({ id, app: aumid(concrete(id)) })),
    ...(entry.windows?.binary ?? []).map((id) => ({ id, app: exe(concrete(id)) })),
    ...(entry.windows?.windowClass ?? []).map((id) => ({
      id,
      app: exe("explorer.exe", { system: true, verified: true, publisher: "Microsoft Windows" }),
      signals: { windowClass: id },
    })),
  ]
}

const neverEntries = ComputerApps.TABLE.filter((entry) => ComputerApps.isNever(entry.category))
const builtinKeys = [
  ...ComputerApps.TABLE.map((entry) => entry.key),
  ...[...ComputerApps.NEVER].map((c) => `builtin:${c}`),
]

// Never-listed apps that come from a signal or the system rule rather than a table entry.
const derivedNever: Sample[] = [
  { id: "child shell", app: mac("com.example.notes"), signals: { childShell: true } },
  { id: "system component", app: mac("com.apple.ActivityMonitor", { apple: true, system: true }) },
  {
    id: "windows system binary",
    app: exe("SearchHost.exe", { system: true, verified: true, publisher: "Microsoft Windows" }),
  },
  { id: "console window", app: exe("unknown-tool.exe"), signals: { windowClass: "ConsoleWindowClass" } },
]

describe("computer apps never-list", () => {
  test("built-in never entries are not removable by prefs, policy, mention or reply", () => {
    const all = [...neverEntries.flatMap(samples), ...derivedNever]
    expect(all.length).toBeGreaterThan(100)
    for (const sample of all) {
      const key = Computer.appKey(sample.app)
      const rule = ComputerApps.builtinRule(sample.app, sample.signals)
      expect(rule, sample.id).toBeDefined()
      expect(rule!.removable, sample.id).toBe(false)
      expect(ComputerApps.NEVER.has(rule!.category), sample.id).toBe(true)

      // Prefs: the user's unblocked list names the app, its rule and every built-in key.
      const prefs = { unblocked: [key, rule!.key, ...builtinKeys] }
      // Policy: the company allows the app and saved approvals.
      const policy: Computer.ComputerPolicy = {
        managed: true,
        enabled: true,
        defaultAccess: "ask",
        allowAlways: true,
        background: true,
        keepAwake: true,
        apps: new Map([[key, "allow"]]),
        ignored: [],
      }
      // Mention: the latest message marks the app.
      const mention = Schema.decodeUnknownSync(Computer.MentionMarker)({ kind: "app", key, name: sample.app.name })
      // Reply: an "always" answer for that app.
      const reply = { permission: "computer_app", patterns: [key], always: [key], reply: "always" }

      // The built-in layer runs first and takes only the unblocked list; none of the above reaches it.
      expect(ComputerApps.builtinVerdict(sample.app, prefs, sample.signals), sample.id).toEqual({
        verdict: "never",
        reason: rule!.reason,
      })
      expect(policy.apps.get(key)).toBe("allow")
      expect(mention.kind).toBe("app")
      expect(reply.always).toContain(key)
      // The decision does not change when called again with the same inputs: nothing above was recorded anywhere.
      expect(ComputerApps.builtinRule(sample.app, sample.signals)).toEqual(rule!)
    }
  })

  test("the never tables and category sets cannot be edited at run time", () => {
    expect(Object.isFrozen(ComputerApps.TABLE)).toBe(true)
    expect(Object.isFrozen(ComputerApps.DEFAULT_BLOCKED)).toBe(true)
    expect(Object.isFrozen(ComputerApps.BENIGN_SYSTEM)).toBe(true)
    for (const entry of ComputerApps.TABLE) {
      expect(Object.isFrozen(entry)).toBe(true)
      if (entry.macos) expect(Object.isFrozen(entry.macos)).toBe(true)
      if (entry.windows) expect(Object.isFrozen(entry.windows)).toBe(true)
      for (const list of Object.values(entry.windows ?? {})) expect(Object.isFrozen(list)).toBe(true)
    }
    const never = ComputerApps.NEVER as Set<ComputerApps.AppCategory>
    expect(() => never.delete("terminal")).toThrow()
    expect(() => never.clear()).toThrow()
    expect(() => (ComputerApps.NO_ALWAYS as Set<ComputerApps.AppCategory>).add("general")).toThrow()
    expect(() => (ComputerApps.TABLE as ComputerApps.AppMatcher[]).push(ComputerApps.TABLE[0]!)).toThrow()
    expect(ComputerApps.category(mac("com.apple.Terminal"))).toBe("terminal")
  })

  test("the category sets match section 2.3", () => {
    expect([...ComputerApps.NEVER].map(String).sort()).toEqual(
      ["vector", "terminal", "scripting", "password-manager", "security", "remote-viewer"].sort(),
    )
    expect([...ComputerApps.NO_ALWAYS].map(String).sort()).toEqual(["browser", "files", "finance", "developer"].sort())
    expect([...ComputerApps.CLICK_ONLY]).toEqual(["developer"])
  })

  test("a system identity outside BENIGN_SYSTEM is security", () => {
    expect(ComputerApps.category(mac("com.apple.ActivityMonitor", { apple: true, system: true }))).toBe("security")
    expect(ComputerApps.category(mac("com.apple.notificationcenterui", { apple: true, system: true }))).toBe("security")
    expect(ComputerApps.category(mac("com.apple.Spotlight", { apple: true, system: true }))).toBe("security")
    expect(ComputerApps.category(exe("SearchHost.exe", { system: true, verified: true }))).toBe("security")
    // Benign OS apps keep their own category.
    expect(ComputerApps.category(mac("com.apple.finder", { apple: true, system: true }))).toBe("files")
    expect(ComputerApps.category(mac("com.apple.Safari", { apple: true, system: true }))).toBe("browser")
    expect(ComputerApps.category(mac("com.apple.calculator", { apple: true, system: true }))).toBe("general")
    expect(ComputerApps.category(exe("explorer.exe", { system: true, verified: true }))).toBe("files")
    expect(ComputerApps.category(exe("notepad.exe", { system: true, verified: true }))).toBe("office")
    // A system identity claiming a benign bundle id without an Apple signature is not benign.
    expect(ComputerApps.category(mac("com.apple.finder", { apple: false, system: true }))).toBe("security")
    // Default blocks stay removable even for OS apps; the user can allow them in Settings.
    const diskUtility = mac("com.apple.DiskUtility", { apple: true, system: true })
    expect(ComputerApps.category(diskUtility)).toBe("general")
    expect(ComputerApps.builtinRule(diskUtility)).toMatchObject({ key: "builtin:disk-utility", removable: true })
    // Desktop furniture is visible in frames, not security.
    expect(ComputerApps.category(mac("com.apple.dock", { apple: true, system: true }))).toBe("system-ui")
    expect(
      ComputerApps.category(exe("explorer.exe", { system: true, verified: true }), { windowClass: "Shell_TrayWnd" }),
    ).toBe("system-ui")
    // Every BENIGN_SYSTEM id, as an OS binary, keeps its listed category.
    for (const entry of ComputerApps.BENIGN_SYSTEM)
      for (const sample of samples(entry)) {
        const app =
          sample.app.platform === "macos"
            ? { ...sample.app, apple: true, system: true }
            : { ...sample.app, system: true }
        expect(ComputerApps.category(app, sample.signals), sample.id).toBe(entry.category)
      }
  })

  test("an app with a child shell is terminal unless it is developer", () => {
    const shell = { childShell: true }
    expect(ComputerApps.category(mac("com.example.notes"), shell)).toBe("terminal")
    expect(ComputerApps.category(mac("com.google.Chrome"), shell)).toBe("terminal")
    expect(ComputerApps.category(mac("com.apple.iWork.Numbers"), shell)).toBe("terminal")
    expect(ComputerApps.category(exe("EXCEL.EXE"), shell)).toBe("terminal")
    expect(ComputerApps.builtinRule(mac("com.example.notes"), shell)).toMatchObject({
      key: "builtin:terminal",
      reason: "terminal",
      removable: false,
    })
    // IDEs run commands in their own terminals but stay click-only developer tools.
    expect(ComputerApps.category(mac("com.microsoft.VSCode"), shell)).toBe("developer")
    expect(ComputerApps.category(mac("com.jetbrains.intellij"), shell)).toBe("developer")
    expect(ComputerApps.category(exe("Code.exe"), shell)).toBe("developer")
    expect(ComputerApps.CLICK_ONLY.has(ComputerApps.category(exe("Code.exe"), shell))).toBe(true)
    // A never category stays what it is.
    expect(ComputerApps.category(mac("ai.vector.app"), shell)).toBe("vector")
    // Without the signal, ordinary apps are ordinary.
    expect(ComputerApps.category(mac("com.example.notes"))).toBe("general")
  })

  test("every remote-viewer id is never", () => {
    const viewers = ComputerApps.TABLE.filter((entry) => entry.category === "remote-viewer")
    const ids = viewers.flatMap(samples)
    expect(ids.length).toBeGreaterThan(30)
    for (const sample of ids) {
      expect(ComputerApps.category(sample.app, sample.signals), sample.id).toBe("remote-viewer")
      expect(ComputerApps.builtinRule(sample.app, sample.signals), sample.id).toMatchObject({
        reason: "remote",
        removable: false,
      })
    }
    // The section 2.3 list, by name.
    for (const name of [
      "Screen Sharing",
      "Microsoft Remote Desktop and Windows App",
      "VNC viewers",
      "TeamViewer",
      "AnyDesk",
      "Parallels Desktop",
      "VMware",
      "UTM",
      "VirtualBox",
      "Hyper-V Connection",
      "Citrix Workspace",
    ])
      expect(viewers.map((entry) => entry.name)).toContain(name)
  })

  test("every listed id resolves to its own entry's category", () => {
    for (const entry of ComputerApps.TABLE)
      for (const sample of samples(entry))
        expect(ComputerApps.category(sample.app, sample.signals), `${entry.key} ${sample.id}`).toBe(entry.category)
  })

  test("table keys are unique and default blocks are removable and never in a never category", () => {
    const keys = ComputerApps.TABLE.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^builtin:[a-z0-9-]+$/)
    for (const entry of ComputerApps.DEFAULT_BLOCKED) {
      expect(ComputerApps.isNever(entry.category)).toBe(false)
      for (const sample of samples(entry)) {
        const rule = ComputerApps.builtinRule(sample.app, sample.signals)
        expect(rule, sample.id).toMatchObject({ key: entry.key, reason: "user", removable: true })
        expect(ComputerApps.builtinVerdict(sample.app, { unblocked: [] }, sample.signals)).toEqual({
          verdict: "blocked",
          reason: "default",
        })
        expect(ComputerApps.builtinVerdict(sample.app, { unblocked: [entry.key] }, sample.signals)).toBeUndefined()
      }
    }
    for (const name of ["Disk Utility", "Find My", "Migration Assistant"])
      expect(ComputerApps.DEFAULT_BLOCKED.map((entry) => entry.name)).toContain(name)
    expect(ComputerApps.DEFAULT_BLOCKED.filter((entry) => entry.category === "finance").length).toBeGreaterThan(5)
    // Ordinary apps have no built-in rule at all.
    expect(ComputerApps.builtinRule(mac("com.apple.iWork.Numbers"))).toBeUndefined()
    expect(ComputerApps.builtinVerdict(mac("com.apple.iWork.Numbers"), { unblocked: [] })).toBeUndefined()
  })

  test("Vector is identified by every channel, helper and Electron helper id, and apps it builds are not Vector", () => {
    for (const id of ComputerApps.VECTOR_APP_IDS) {
      for (const bundleId of [
        id,
        `${id}.${ComputerApps.HELPER_SUFFIX}`,
        ...ComputerApps.ELECTRON_HELPER_SUFFIXES.map((suffix) => `${id}.${suffix}`),
      ]) {
        expect(ComputerApps.category(mac(bundleId)), bundleId).toBe("vector")
        expect(ComputerApps.builtinRule(mac(bundleId))).toMatchObject({ reason: "vector", removable: false })
      }
      expect(ComputerApps.category(aumid(id))).toBe("vector")
      // The helper id is never under Electron's own helper ids.
      expect(`${id}.${ComputerApps.HELPER_SUFFIX}`.startsWith(`${id}.helper`)).toBe(false)
    }
    for (const binary of ComputerApps.VECTOR_WINDOWS_BINARIES) expect(ComputerApps.category(exe(binary))).toBe("vector")
    // An app the agent built in the user's repository is asked like any other app.
    expect(ComputerApps.category(mac("com.example.receipts", { verified: false }))).toBe("general")
    expect(ComputerApps.builtinRule(mac("com.example.receipts", { verified: false }))).toBeUndefined()
  })

  test("the section 2.3 terminals, password managers and security hosts are never", () => {
    const expectNever = (app: Computer.AppIdentity, reason: ComputerApps.BlockReason, signals?: ComputerApps.Signals) =>
      expect(ComputerApps.builtinRule(app, signals)).toMatchObject({ reason, removable: false })
    for (const id of [
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "dev.warp.Warp-Stable",
      "com.mitchellh.ghostty",
      "net.kovidgoyal.kitty",
      "org.alacritty",
      "com.github.wez.wezterm",
      "com.apple.ScriptEditor2",
      "com.apple.Automator",
      "com.apple.shortcuts",
    ])
      expectNever(mac(id), "terminal")
    for (const binary of [
      "cmd.exe",
      "powershell.exe",
      "pwsh.exe",
      "wsl.exe",
      "mintty.exe",
      "conhost.exe",
      "OpenConsole.exe",
    ])
      expectNever(exe(binary), "terminal")
    expectNever(aumid("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"), "terminal")
    expectNever(exe("renamed.exe"), "terminal", { windowClass: "CASCADIA_HOSTING_WINDOW_CLASS" })
    expectNever(exe("renamed.exe"), "terminal", { windowClass: "ConsoleWindowClass" })
    expectNever(aumid("Microsoft.Windows.Shell.RunDialog"), "terminal")
    for (const id of [
      "com.apple.Passwords",
      "com.apple.keychainaccess",
      "com.1password.1password",
      "com.bitwarden.desktop",
    ])
      expectNever(mac(id), "passwords")
    for (const binary of ["1Password.exe", "Bitwarden.exe", "KeePassXC.exe", "credwiz.exe"])
      expectNever(exe(binary), "passwords")
    for (const id of [
      "com.apple.systempreferences",
      "com.apple.SecurityAgent",
      "com.apple.installer",
      "com.apple.notificationcenterui",
    ])
      expectNever(mac(id), "security")
    for (const binary of [
      "consent.exe",
      "CredentialUIBroker.exe",
      "LogonUI.exe",
      "SecHealthUI.exe",
      "SystemSettings.exe",
      "control.exe",
      "regedit.exe",
      "mmc.exe",
    ])
      expectNever(exe(binary), "security")
    // Matching ignores case, as bundle ids and Windows file names do.
    expectNever(mac("COM.APPLE.TERMINAL"), "terminal")
    expectNever(exe("CMD.EXE"), "terminal")
  })

  test("browsers, file managers, finance and developer apps never offer Always", () => {
    for (const app of [
      mac("com.google.Chrome"),
      mac("com.apple.finder", { apple: true, system: true }),
      exe("Code.exe"),
      mac("com.quicken.Quicken"),
    ])
      expect(ComputerApps.NO_ALWAYS.has(ComputerApps.category(app))).toBe(true)
    expect(ComputerApps.NO_ALWAYS.has(ComputerApps.category(mac("com.apple.iWork.Numbers")))).toBe(false)
  })
})
