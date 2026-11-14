export * as ComputerApps from "./computer-apps"

import { Schema } from "effect"
import type { AppIdentity } from "./computer"

/**
 * App categories and the never-list for Vector Hands (build contract section 2.3).
 *
 * The tables below are data: C1 generates the helpers' `blocklist.json` from them, so the engine, desktop main and
 * both native helpers judge apps from one source. Matching is by verified identity only (macOS bundle id; Windows
 * AUMID, window class or the original file name from the signed image), never by display name or window title.
 */

export const AppCategory = Schema.Literals([
  // never: not removable by any preference, policy, mention, ask reply or client
  "vector",
  "terminal",
  "scripting",
  "password-manager",
  "security",
  "remote-viewer",
  // ordinary apps
  "browser",
  "files",
  "mail",
  "messaging",
  "finance",
  "developer",
  "office",
  "creative",
  "simulator",
  "system-ui",
  "general",
]).annotate({ identifier: "ComputerApps.AppCategory" })
export type AppCategory = typeof AppCategory.Type

export const BlockReason = Schema.Literals([
  "terminal",
  "vector",
  "security",
  "passwords",
  "remote",
  "user",
  "company",
  "denied",
]).annotate({ identifier: "ComputerApps.BlockReason" })
export type BlockReason = typeof BlockReason.Type

/** Signals the helper observes beside the identity. */
export interface Signals {
  /** The app's process tree has a child shell or REPL. */
  readonly childShell?: boolean
  /** Windows: the class of the window being judged (for example `ConsoleWindowClass`). */
  readonly windowClass?: string
}

type NeverCategory = "vector" | "terminal" | "scripting" | "password-manager" | "security" | "remote-viewer"

// The reason each never category reports. Frozen, and the only structure `category` and `builtinRule` consult for
// the never decision, so mutating an exported set cannot weaken them.
const NEVER_REASON: Readonly<Record<NeverCategory, BlockReason>> = Object.freeze({
  vector: "vector",
  terminal: "terminal",
  scripting: "terminal",
  "password-manager": "passwords",
  security: "security",
  "remote-viewer": "remote",
})

export function isNever(category: AppCategory): category is NeverCategory {
  return Object.hasOwn(NEVER_REASON, category)
}

const sealed = new WeakSet<object>()

class SealedSet<T> extends Set<T> {
  override add(value: T): this {
    if (sealed.has(this)) throw new TypeError("This set is read-only")
    return super.add(value)
  }
  override delete(_value: T): boolean {
    throw new TypeError("This set is read-only")
  }
  override clear(): void {
    throw new TypeError("This set is read-only")
  }
}

function sealedSet<T>(values: readonly T[]): ReadonlySet<T> {
  const set = new SealedSet<T>(values)
  sealed.add(set)
  return Object.freeze(set)
}

/** Categories Hands never sees or operates. */
export const NEVER: ReadonlySet<AppCategory> = sealedSet<AppCategory>(Object.keys(NEVER_REASON) as NeverCategory[])
/** Categories that always ask: Always allow is never offered for them. */
export const NO_ALWAYS: ReadonlySet<AppCategory> = sealedSet<AppCategory>(["browser", "files", "finance", "developer"])
/** Categories where clicks and keys are allowed but typing text is refused. */
export const CLICK_ONLY: ReadonlySet<AppCategory> = sealedSet<AppCategory>(["developer"])

/**
 * One app (or family of apps) in the identity tables. Ids are compared case-insensitively; an id ending in `*`
 * matches by prefix.
 */
export interface AppMatcher {
  /** Stable key, `builtin:<slug>`. `ComputerPrefs.unblocked` stores it for a removed DEFAULT_BLOCKED entry. */
  readonly key: string
  readonly name: string
  readonly category: AppCategory
  /** macOS bundle ids. */
  readonly macos?: readonly string[]
  readonly windows?: {
    /** Package AUMIDs (or package-family prefixes). */
    readonly aumid?: readonly string[]
    /** Window classes; matched against `Signals.windowClass`. */
    readonly windowClass?: readonly string[]
    /** Original file names from the signed image, never the on-disk basename. */
    readonly binary?: readonly string[]
  }
}

function freezeAll<T extends AppMatcher>(entries: T[]): readonly T[] {
  for (const entry of entries) {
    if (entry.windows) {
      for (const list of Object.values(entry.windows)) if (list) Object.freeze(list)
      Object.freeze(entry.windows)
    }
    if (entry.macos) Object.freeze(entry.macos)
    Object.freeze(entry)
  }
  return Object.freeze(entries)
}

/** Vector's release channel bundle ids (electron-builder `APP_IDS`). */
export const VECTOR_APP_IDS = Object.freeze(["ai.vector.app", "ai.vector.app.beta", "ai.vector.app.dev"] as const)
/** The Vector Hands helper's bundle id is `${appId}.computer`; it is never under `${appId}.helper*`. */
export const HELPER_SUFFIX = "computer"
/** Electron's own helper bundles under each channel id. */
export const ELECTRON_HELPER_SUFFIXES = Object.freeze([
  "helper",
  "helper.Renderer",
  "helper.GPU",
  "helper.Plugin",
  "helper.EH",
  "helper.NP",
] as const)
/** Vector's Windows executables (electron-builder `EXECUTABLE_NAMES`) and the Hands helper. */
export const VECTOR_WINDOWS_BINARIES = Object.freeze([
  "vector-desktop.exe",
  "vector-desktop-beta.exe",
  "vector-desktop-dev.exe",
  "vector-computer.exe",
] as const)

const vectorBundleIds = VECTOR_APP_IDS.flatMap((id) => [
  id,
  `${id}.${HELPER_SUFFIX}`,
  ...ELECTRON_HELPER_SUFFIXES.map((suffix) => `${id}.${suffix}`),
])

const NEVER_ENTRIES = freezeAll([
  // Vector itself. Vector is also identified by process and window id (desktop main and the helpers); apps Vector
  // or the agent launched are not Vector.
  {
    key: "builtin:vector",
    name: "Vector",
    category: "vector",
    macos: [...vectorBundleIds, "ai.vector.app.*"],
    windows: { aumid: [...VECTOR_APP_IDS, "ai.vector.app.*"], binary: [...VECTOR_WINDOWS_BINARIES] },
  },

  // Terminals.
  { key: "builtin:terminal", name: "Terminal", category: "terminal", macos: ["com.apple.Terminal"] },
  { key: "builtin:iterm2", name: "iTerm2", category: "terminal", macos: ["com.googlecode.iterm2"] },
  { key: "builtin:warp", name: "Warp", category: "terminal", macos: ["dev.warp.*"], windows: { binary: ["warp.exe"] } },
  { key: "builtin:ghostty", name: "Ghostty", category: "terminal", macos: ["com.mitchellh.ghostty"] },
  { key: "builtin:kitty", name: "kitty", category: "terminal", macos: ["net.kovidgoyal.kitty"] },
  {
    key: "builtin:alacritty",
    name: "Alacritty",
    category: "terminal",
    macos: ["org.alacritty", "io.alacritty"],
    windows: { binary: ["alacritty.exe"] },
  },
  {
    key: "builtin:wezterm",
    name: "WezTerm",
    category: "terminal",
    macos: ["com.github.wez.wezterm"],
    windows: { binary: ["wezterm-gui.exe", "wezterm.exe"] },
  },
  {
    key: "builtin:hyper",
    name: "Hyper",
    category: "terminal",
    macos: ["co.zeit.hyper"],
    windows: { binary: ["hyper.exe"] },
  },
  {
    key: "builtin:tabby",
    name: "Tabby",
    category: "terminal",
    macos: ["org.tabby"],
    windows: { binary: ["tabby.exe"] },
  },
  { key: "builtin:rio", name: "Rio", category: "terminal", macos: ["com.raphaelamorim.rio"] },
  { key: "builtin:wave", name: "Wave Terminal", category: "terminal", macos: ["dev.commandline.waveterm"] },
  {
    key: "builtin:termius",
    name: "Termius",
    category: "terminal",
    macos: ["com.termius-dmg.mac", "com.termius.mac"],
    windows: { binary: ["termius.exe"] },
  },
  {
    key: "builtin:xquartz",
    name: "XQuartz",
    category: "terminal",
    macos: ["org.xquartz.X11", "org.macosforge.xquartz.X11"],
  },
  {
    key: "builtin:windows-terminal",
    name: "Windows Terminal",
    category: "terminal",
    windows: {
      aumid: ["Microsoft.WindowsTerminal*"],
      windowClass: ["CASCADIA_HOSTING_WINDOW_CLASS"],
      binary: ["WindowsTerminal.exe", "wt.exe"],
    },
  },
  {
    key: "builtin:console",
    name: "Console window",
    category: "terminal",
    windows: {
      windowClass: ["ConsoleWindowClass", "PseudoConsoleWindow"],
      binary: ["conhost.exe", "OpenConsole.exe"],
    },
  },
  { key: "builtin:cmd", name: "Command Prompt", category: "terminal", windows: { binary: ["cmd.exe"] } },
  {
    key: "builtin:powershell",
    name: "PowerShell",
    category: "terminal",
    windows: { binary: ["powershell.exe", "pwsh.exe"] },
  },
  {
    key: "builtin:wsl",
    name: "Windows Subsystem for Linux",
    category: "terminal",
    windows: {
      aumid: [
        "MicrosoftCorporationII.WindowsSubsystemForLinux*",
        "CanonicalGroupLimited.*",
        "TheDebianProject.*",
        "KaliLinux.*",
        "46932SUSE.*",
        "WhitewaterFoundryLtd.Co.*",
      ],
      binary: ["wsl.exe", "wslhost.exe", "bash.exe"],
    },
  },
  {
    key: "builtin:mintty",
    name: "mintty",
    category: "terminal",
    windows: { windowClass: ["mintty"], binary: ["mintty.exe", "git-bash.exe", "sh.exe"] },
  },
  {
    key: "builtin:putty",
    name: "PuTTY",
    category: "terminal",
    windows: { windowClass: ["PuTTY"], binary: ["putty.exe"] },
  },
  {
    key: "builtin:conemu",
    name: "ConEmu",
    category: "terminal",
    windows: { windowClass: ["VirtualConsoleClass"], binary: ["ConEmu.exe", "ConEmu64.exe", "Cmder.exe"] },
  },
  { key: "builtin:mobaxterm", name: "MobaXterm", category: "terminal", windows: { binary: ["MobaXterm.exe"] } },
  // The Run dialog. Its window carries this AUMID; the helpers check the window's own AUMID property (W7).
  {
    key: "builtin:run-dialog",
    name: "Run",
    category: "terminal",
    windows: { aumid: ["Microsoft.Windows.Shell.RunDialog"] },
  },

  // Script and automation tools.
  { key: "builtin:script-editor", name: "Script Editor", category: "scripting", macos: ["com.apple.ScriptEditor2"] },
  { key: "builtin:automator", name: "Automator", category: "scripting", macos: ["com.apple.Automator"] },
  { key: "builtin:shortcuts", name: "Shortcuts", category: "scripting", macos: ["com.apple.shortcuts"] },
  {
    key: "builtin:script-debugger",
    name: "Script Debugger",
    category: "scripting",
    macos: ["com.latenightsw.ScriptDebugger*"],
  },
  {
    key: "builtin:keyboard-maestro",
    name: "Keyboard Maestro",
    category: "scripting",
    macos: ["com.stairways.keyboardmaestro.*"],
  },
  { key: "builtin:hammerspoon", name: "Hammerspoon", category: "scripting", macos: ["org.hammerspoon.Hammerspoon"] },
  {
    key: "builtin:bettertouchtool",
    name: "BetterTouchTool",
    category: "scripting",
    macos: ["com.hegenberg.BetterTouchTool"],
  },
  { key: "builtin:raycast", name: "Raycast", category: "scripting", macos: ["com.raycast.macos"] },
  { key: "builtin:alfred", name: "Alfred", category: "scripting", macos: ["com.runningwithcrayons.Alfred*"] },
  {
    key: "builtin:powershell-ise",
    name: "PowerShell ISE",
    category: "scripting",
    windows: { binary: ["powershell_ise.exe"] },
  },
  {
    key: "builtin:script-host",
    name: "Windows Script Host",
    category: "scripting",
    windows: { binary: ["wscript.exe", "cscript.exe", "mshta.exe"] },
  },
  {
    key: "builtin:autohotkey",
    name: "AutoHotkey",
    category: "scripting",
    windows: {
      binary: ["AutoHotkey.exe", "AutoHotkey64.exe", "AutoHotkey32.exe", "AutoHotkeyU64.exe", "AutoHotkeyU32.exe"],
    },
  },
  {
    key: "builtin:power-automate",
    name: "Power Automate",
    category: "scripting",
    windows: { aumid: ["Microsoft.PowerAutomateDesktop*"], binary: ["PAD.Console.Host.exe"] },
  },
  {
    key: "builtin:powertoys-run",
    name: "PowerToys Run",
    category: "scripting",
    windows: { binary: ["PowerToys.PowerLauncher.exe"] },
  },

  // Password managers and Keychain.
  { key: "builtin:passwords", name: "Passwords", category: "password-manager", macos: ["com.apple.Passwords"] },
  {
    key: "builtin:keychain-access",
    name: "Keychain Access",
    category: "password-manager",
    macos: ["com.apple.keychainaccess"],
  },
  {
    key: "builtin:1password",
    name: "1Password",
    category: "password-manager",
    macos: ["com.1password.*", "com.agilebits.onepassword*"],
    windows: { binary: ["1Password.exe"] },
  },
  {
    key: "builtin:bitwarden",
    name: "Bitwarden",
    category: "password-manager",
    macos: ["com.bitwarden.desktop"],
    windows: { aumid: ["8bitSolutionsLLC.bitwardendesktop*"], binary: ["Bitwarden.exe"] },
  },
  {
    key: "builtin:lastpass",
    name: "LastPass",
    category: "password-manager",
    macos: ["com.lastpass.LastPass"],
    windows: { binary: ["LastPass.exe"] },
  },
  {
    key: "builtin:dashlane",
    name: "Dashlane",
    category: "password-manager",
    macos: ["com.dashlane.*"],
    windows: { binary: ["Dashlane.exe"] },
  },
  {
    key: "builtin:keepassxc",
    name: "KeePassXC",
    category: "password-manager",
    macos: ["org.keepassxc.keepassxc"],
    windows: { binary: ["KeePassXC.exe"] },
  },
  { key: "builtin:keepass", name: "KeePass", category: "password-manager", windows: { binary: ["KeePass.exe"] } },
  {
    key: "builtin:enpass",
    name: "Enpass",
    category: "password-manager",
    macos: ["in.sinew.Enpass-Desktop"],
    windows: { binary: ["Enpass.exe"] },
  },
  {
    key: "builtin:keeper",
    name: "Keeper",
    category: "password-manager",
    macos: ["com.keepersecurity.*"],
    windows: { binary: ["keeperpasswordmanager.exe"] },
  },
  {
    key: "builtin:proton-pass",
    name: "Proton Pass",
    category: "password-manager",
    macos: ["me.proton.pass.*"],
    windows: { binary: ["Proton Pass.exe"] },
  },
  { key: "builtin:nordpass", name: "NordPass", category: "password-manager", windows: { binary: ["NordPass.exe"] } },
  { key: "builtin:roboform", name: "RoboForm", category: "password-manager", windows: { binary: ["RoboForm.exe"] } },
  { key: "builtin:strongbox", name: "Strongbox", category: "password-manager", macos: ["com.markmcguill.strongbox*"] },
  { key: "builtin:macpass", name: "MacPass", category: "password-manager", macos: ["com.hicknhacksoftware.MacPass"] },
  {
    key: "builtin:credential-manager",
    name: "Windows Credential Manager",
    category: "password-manager",
    windows: { binary: ["credwiz.exe"] },
  },

  // OS security, privacy, administrator and credential UI. Every system identity outside BENIGN_SYSTEM is also
  // `security` (see `category`), so this list names the hosts explicitly for the helpers and for clarity.
  {
    key: "builtin:system-settings",
    name: "System Settings",
    category: "security",
    macos: ["com.apple.systempreferences"],
  },
  {
    key: "builtin:security-prompts",
    name: "Security and authorization prompts",
    category: "security",
    macos: [
      "com.apple.SecurityAgent",
      "com.apple.coreservices.uiagent",
      "com.apple.UserNotificationCenter",
      "com.apple.LocalAuthentication.UIAgent",
      "com.apple.accessibility.universalAccessAuthWarn",
      "com.apple.AuthenticationServicesCore.AuthenticationServicesAgent",
      "com.apple.loginwindow",
      "com.apple.ScreenSaver.Engine",
    ],
    windows: {
      aumid: ["Microsoft.LockApp*"],
      binary: ["consent.exe", "CredentialUIBroker.exe", "LogonUI.exe", "LockApp.exe", "smartscreen.exe"],
    },
  },
  {
    key: "builtin:notifications",
    name: "Notifications",
    category: "security",
    macos: ["com.apple.notificationcenterui"],
    windows: { binary: ["ShellExperienceHost.exe"] },
  },
  {
    key: "builtin:installer",
    name: "Installer",
    category: "security",
    macos: ["com.apple.installer"],
    windows: { binary: ["msiexec.exe"] },
  },
  {
    key: "builtin:windows-security",
    name: "Windows Security",
    category: "security",
    windows: { aumid: ["Microsoft.SecHealthUI*", "Microsoft.Windows.SecHealthUI*"], binary: ["SecHealthUI.exe"] },
  },
  {
    key: "builtin:windows-settings",
    name: "Windows Settings and Control Panel",
    category: "security",
    windows: {
      aumid: ["windows.immersivecontrolpanel*"],
      binary: [
        "SystemSettings.exe",
        "control.exe",
        "regedit.exe",
        "mmc.exe",
        "UserAccountControlSettings.exe",
        "Taskmgr.exe",
        "msconfig.exe",
      ],
    },
  },

  // Remote-desktop and virtual-machine viewers: Vector can't see which apps run inside them.
  {
    key: "builtin:screen-sharing",
    name: "Screen Sharing",
    category: "remote-viewer",
    macos: ["com.apple.ScreenSharing"],
  },
  {
    key: "builtin:apple-remote-desktop",
    name: "Remote Desktop",
    category: "remote-viewer",
    macos: ["com.apple.RemoteDesktop"],
  },
  {
    key: "builtin:iphone-mirroring",
    name: "iPhone Mirroring",
    category: "remote-viewer",
    macos: ["com.apple.ScreenContinuity"],
  },
  {
    key: "builtin:microsoft-remote-desktop",
    name: "Microsoft Remote Desktop and Windows App",
    category: "remote-viewer",
    macos: ["com.microsoft.rdc.*"],
    windows: {
      aumid: ["Microsoft.RemoteDesktop*", "MicrosoftCorporationII.Windows365*"],
      binary: ["mstsc.exe", "msrdc.exe"],
    },
  },
  {
    key: "builtin:vnc",
    name: "VNC viewers",
    category: "remote-viewer",
    macos: ["com.realvnc.vncviewer", "com.tigervnc.*"],
    windows: { binary: ["vncviewer.exe", "tvnviewer.exe", "vncviewer64.exe"] },
  },
  {
    key: "builtin:teamviewer",
    name: "TeamViewer",
    category: "remote-viewer",
    macos: ["com.teamviewer.*"],
    windows: { binary: ["TeamViewer.exe"] },
  },
  {
    key: "builtin:anydesk",
    name: "AnyDesk",
    category: "remote-viewer",
    macos: ["com.philandro.anydesk"],
    windows: { binary: ["AnyDesk.exe"] },
  },
  { key: "builtin:parallels", name: "Parallels Desktop", category: "remote-viewer", macos: ["com.parallels.*"] },
  {
    key: "builtin:vmware",
    name: "VMware",
    category: "remote-viewer",
    macos: ["com.vmware.*"],
    windows: { binary: ["vmware.exe", "vmplayer.exe", "vmware-view.exe"] },
  },
  { key: "builtin:utm", name: "UTM", category: "remote-viewer", macos: ["com.utmapp.*"] },
  {
    key: "builtin:virtualbox",
    name: "VirtualBox",
    category: "remote-viewer",
    macos: ["org.virtualbox.app.*"],
    windows: { binary: ["VirtualBox.exe", "VirtualBoxVM.exe"] },
  },
  {
    key: "builtin:hyper-v",
    name: "Hyper-V Connection",
    category: "remote-viewer",
    windows: { binary: ["vmconnect.exe"] },
  },
  {
    key: "builtin:windows-sandbox",
    name: "Windows Sandbox",
    category: "remote-viewer",
    windows: { binary: ["WindowsSandbox.exe", "WindowsSandboxClient.exe"] },
  },
  {
    key: "builtin:citrix",
    name: "Citrix Workspace",
    category: "remote-viewer",
    macos: ["com.citrix.*"],
    windows: { binary: ["SelfService.exe", "CDViewer.exe", "wfica32.exe", "Receiver.exe"] },
  },
  { key: "builtin:jump-desktop", name: "Jump Desktop", category: "remote-viewer", macos: ["com.p5sys.jump.*"] },
  {
    key: "builtin:parsec",
    name: "Parsec",
    category: "remote-viewer",
    macos: ["tv.parsec.www"],
    windows: { binary: ["parsecd.exe"] },
  },
  {
    key: "builtin:moonlight",
    name: "Moonlight",
    category: "remote-viewer",
    macos: ["com.moonlight-stream.Moonlight"],
    windows: { binary: ["Moonlight.exe"] },
  },
  {
    key: "builtin:rustdesk",
    name: "RustDesk",
    category: "remote-viewer",
    macos: ["com.carriez.rustdesk"],
    windows: { binary: ["rustdesk.exe"] },
  },
  {
    key: "builtin:splashtop",
    name: "Splashtop",
    category: "remote-viewer",
    macos: ["com.splashtop.*"],
    windows: { binary: ["strwinclt.exe"] },
  },
  {
    key: "builtin:quick-assist",
    name: "Quick Assist",
    category: "remote-viewer",
    windows: { aumid: ["MicrosoftCorporationII.QuickAssist*"], binary: ["QuickAssist.exe"] },
  },
  {
    key: "builtin:amazon-workspaces",
    name: "Amazon WorkSpaces",
    category: "remote-viewer",
    macos: ["com.amazon.workspaces"],
    windows: { binary: ["workspaces.exe"] },
  },
  {
    key: "builtin:royal-ts",
    name: "Royal TS",
    category: "remote-viewer",
    macos: ["com.lemonmojo.RoyalTSX*"],
    windows: { binary: ["RoyalTS.exe"] },
  },
  { key: "builtin:orbstack", name: "OrbStack", category: "remote-viewer", macos: ["dev.kdrag0n.MacVirt"] },
] satisfies AppMatcher[])

/** Desktop furniture: visible in frames, never a grant target. */
const SYSTEM_UI_ENTRIES = freezeAll([
  { key: "builtin:dock", name: "Dock", category: "system-ui", macos: ["com.apple.dock"] },
  {
    key: "builtin:menu-bar",
    name: "Menu bar",
    category: "system-ui",
    macos: ["com.apple.systemuiserver", "com.apple.controlcenter", "com.apple.TextInputMenuAgent"],
  },
  { key: "builtin:stage-manager", name: "Stage Manager", category: "system-ui", macos: ["com.apple.WindowManager"] },
  { key: "builtin:wallpaper", name: "Wallpaper", category: "system-ui", macos: ["com.apple.wallpaper.*"] },
  {
    key: "builtin:taskbar",
    name: "Taskbar",
    category: "system-ui",
    windows: { windowClass: ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"] },
  },
  { key: "builtin:desktop", name: "Desktop", category: "system-ui", windows: { windowClass: ["Progman", "WorkerW"] } },
  {
    key: "builtin:start",
    name: "Start",
    category: "system-ui",
    windows: { aumid: ["Microsoft.Windows.StartMenuExperienceHost*"], binary: ["StartMenuExperienceHost.exe"] },
  },
] satisfies AppMatcher[])

/** Blocked until the user removes the block in Settings (each with [Allow]). Never in a never category. */
export const DEFAULT_BLOCKED: readonly AppMatcher[] = freezeAll([
  {
    key: "builtin:tradingview",
    name: "TradingView",
    category: "finance",
    macos: ["com.tradingview.tradingviewapp.desktop"],
    windows: { binary: ["TradingView.exe"] },
  },
  {
    key: "builtin:interactive-brokers",
    name: "Interactive Brokers",
    category: "finance",
    windows: { binary: ["tws.exe", "ntws.exe"] },
  },
  {
    key: "builtin:metatrader",
    name: "MetaTrader",
    category: "finance",
    macos: ["net.metaquotes.*"],
    windows: { binary: ["terminal64.exe", "terminal.exe"] },
  },
  { key: "builtin:thinkorswim", name: "thinkorswim", category: "finance", windows: { binary: ["thinkorswim.exe"] } },
  {
    key: "builtin:ledger-live",
    name: "Ledger Live",
    category: "finance",
    macos: ["com.ledger.live"],
    windows: { binary: ["Ledger Live.exe"] },
  },
  {
    key: "builtin:exodus",
    name: "Exodus",
    category: "finance",
    macos: ["com.electron.exodus"],
    windows: { binary: ["Exodus.exe"] },
  },
  {
    key: "builtin:trezor-suite",
    name: "Trezor Suite",
    category: "finance",
    macos: ["io.trezor.TrezorSuite"],
    windows: { binary: ["Trezor Suite.exe"] },
  },
  {
    key: "builtin:electrum",
    name: "Electrum",
    category: "finance",
    macos: ["org.electrum.electrum"],
    windows: { binary: ["electrum.exe"] },
  },
  {
    key: "builtin:sparrow",
    name: "Sparrow Wallet",
    category: "finance",
    macos: ["com.sparrowwallet.sparrow"],
    windows: { binary: ["Sparrow.exe"] },
  },
  {
    key: "builtin:bitcoin-core",
    name: "Bitcoin Core",
    category: "finance",
    macos: ["org.bitcoinfoundation.Bitcoin-Qt"],
    windows: { binary: ["bitcoin-qt.exe"] },
  },
  {
    key: "builtin:atomic-wallet",
    name: "Atomic Wallet",
    category: "finance",
    windows: { binary: ["Atomic Wallet.exe"] },
  },
  {
    key: "builtin:binance",
    name: "Binance",
    category: "finance",
    macos: ["com.binance.*"],
    windows: { binary: ["Binance.exe"] },
  },
  { key: "builtin:disk-utility", name: "Disk Utility", category: "general", macos: ["com.apple.DiskUtility"] },
  { key: "builtin:find-my", name: "Find My", category: "general", macos: ["com.apple.findmy"] },
  {
    key: "builtin:migration-assistant",
    name: "Migration Assistant",
    category: "general",
    macos: ["com.apple.MigrateAssistant"],
  },
] satisfies AppMatcher[])

/**
 * Ordinary OS apps. A `system` identity outside this list (and outside DEFAULT_BLOCKED and the system-ui entries)
 * is `security`, so an unlisted OS component is never driven. macOS entries match only Apple-signed identities.
 */
export const BENIGN_SYSTEM: readonly AppMatcher[] = freezeAll([
  { key: "builtin:finder", name: "Finder", category: "files", macos: ["com.apple.finder"] },
  { key: "builtin:safari", name: "Safari", category: "browser", macos: ["com.apple.Safari"] },
  { key: "builtin:preview", name: "Preview", category: "office", macos: ["com.apple.Preview"] },
  { key: "builtin:textedit", name: "TextEdit", category: "office", macos: ["com.apple.TextEdit"] },
  { key: "builtin:notes", name: "Notes", category: "office", macos: ["com.apple.Notes"] },
  { key: "builtin:calendar", name: "Calendar", category: "office", macos: ["com.apple.iCal"] },
  { key: "builtin:mail", name: "Mail", category: "mail", macos: ["com.apple.mail"] },
  { key: "builtin:simulator", name: "Simulator", category: "simulator", macos: ["com.apple.iphonesimulator"] },
  {
    key: "builtin:calculator",
    name: "Calculator",
    category: "general",
    macos: ["com.apple.calculator"],
    windows: { aumid: ["Microsoft.WindowsCalculator*"], binary: ["calc.exe", "CalculatorApp.exe"] },
  },
  {
    key: "builtin:photos",
    name: "Photos",
    category: "creative",
    macos: ["com.apple.Photos"],
    windows: { aumid: ["Microsoft.Windows.Photos*"] },
  },
  // Other ordinary Apple apps (the contract's "and similar").
  { key: "builtin:reminders", name: "Reminders", category: "office", macos: ["com.apple.reminders"] },
  { key: "builtin:contacts", name: "Contacts", category: "office", macos: ["com.apple.AddressBook"] },
  { key: "builtin:messages", name: "Messages", category: "messaging", macos: ["com.apple.MobileSMS"] },
  { key: "builtin:maps", name: "Maps", category: "general", macos: ["com.apple.Maps"] },
  { key: "builtin:music", name: "Music", category: "general", macos: ["com.apple.Music"] },
  { key: "builtin:tv", name: "TV", category: "general", macos: ["com.apple.TV"] },
  { key: "builtin:podcasts", name: "Podcasts", category: "general", macos: ["com.apple.podcasts"] },
  { key: "builtin:books", name: "Books", category: "general", macos: ["com.apple.iBooksX"] },
  { key: "builtin:freeform", name: "Freeform", category: "creative", macos: ["com.apple.freeform"] },
  { key: "builtin:stickies", name: "Stickies", category: "office", macos: ["com.apple.Stickies"] },
  { key: "builtin:quicktime", name: "QuickTime Player", category: "creative", macos: ["com.apple.QuickTimePlayerX"] },
  { key: "builtin:font-book", name: "Font Book", category: "general", macos: ["com.apple.FontBook"] },
  { key: "builtin:dictionary", name: "Dictionary", category: "general", macos: ["com.apple.Dictionary"] },
  { key: "builtin:weather", name: "Weather", category: "general", macos: ["com.apple.weather"] },
  { key: "builtin:clock", name: "Clock", category: "general", macos: ["com.apple.clock"] },
  { key: "builtin:chess", name: "Chess", category: "general", macos: ["com.apple.Chess"] },
  { key: "builtin:news", name: "News", category: "general", macos: ["com.apple.news"] },
  { key: "builtin:stocks", name: "Stocks", category: "general", macos: ["com.apple.stocks"] },
  // Windows.
  { key: "builtin:file-explorer", name: "File Explorer", category: "files", windows: { binary: ["explorer.exe"] } },
  {
    key: "builtin:notepad",
    name: "Notepad",
    category: "office",
    windows: { aumid: ["Microsoft.WindowsNotepad*"], binary: ["notepad.exe"] },
  },
  {
    key: "builtin:paint",
    name: "Paint",
    category: "creative",
    windows: { aumid: ["Microsoft.Paint*"], binary: ["mspaint.exe"] },
  },
] satisfies AppMatcher[])

/** Third-party and Apple apps with a known category. Unlisted apps are `general`. */
const CATEGORIZED_ENTRIES = freezeAll([
  // Browsers: Hands acts as the user on signed-in sites.
  {
    key: "builtin:chrome",
    name: "Google Chrome",
    category: "browser",
    macos: ["com.google.Chrome*", "org.chromium.Chromium"],
    windows: { binary: ["chrome.exe", "chromium.exe"] },
  },
  {
    key: "builtin:firefox",
    name: "Firefox",
    category: "browser",
    macos: ["org.mozilla.firefox*", "org.mozilla.nightly", "org.torproject.torbrowser"],
    windows: { binary: ["firefox.exe"] },
  },
  {
    key: "builtin:edge",
    name: "Microsoft Edge",
    category: "browser",
    macos: ["com.microsoft.edgemac*"],
    windows: { binary: ["msedge.exe"] },
  },
  {
    key: "builtin:brave",
    name: "Brave",
    category: "browser",
    macos: ["com.brave.Browser*"],
    windows: { binary: ["brave.exe"] },
  },
  {
    key: "builtin:arc",
    name: "Arc",
    category: "browser",
    macos: ["company.thebrowser.*"],
    windows: { aumid: ["TheBrowserCompany.Arc*"], binary: ["Arc.exe"] },
  },
  {
    key: "builtin:opera",
    name: "Opera",
    category: "browser",
    macos: ["com.operasoftware.*"],
    windows: { binary: ["opera.exe"] },
  },
  {
    key: "builtin:vivaldi",
    name: "Vivaldi",
    category: "browser",
    macos: ["com.vivaldi.Vivaldi"],
    windows: { binary: ["vivaldi.exe"] },
  },
  {
    key: "builtin:other-browsers",
    name: "Other browsers",
    category: "browser",
    macos: [
      "com.apple.SafariTechnologyPreview",
      "com.kagi.kagimacOS",
      "com.duckduckgo.macos.browser",
      "app.zen-browser.zen",
    ],
    windows: { aumid: ["DuckDuckGo.DesktopBrowser*"], binary: ["zen.exe", "iexplore.exe"] },
  },
  // File managers and file transfer: they can move, rename and delete files.
  {
    key: "builtin:file-managers",
    name: "File managers",
    category: "files",
    macos: [
      "com.cocoatech.PathFinder",
      "com.binarynights.ForkLift*",
      "com.eltima.cmd1*",
      "com.panic.Transmit*",
      "ch.sudo.cyberduck",
      "org.filezilla-project.filezilla",
    ],
    windows: {
      binary: ["TOTALCMD64.EXE", "TOTALCMD.EXE", "dopus.exe", "WinSCP.exe", "filezilla.exe", "Cyberduck.exe"],
    },
  },
  // Mail.
  {
    key: "builtin:mail-apps",
    name: "Mail apps",
    category: "mail",
    macos: [
      "com.microsoft.Outlook",
      "com.readdle.smartemail-Mac",
      "com.readdle.SparkDesktop*",
      "org.mozilla.thunderbird",
      "com.mimestream.Mimestream",
      "it.bloop.airmail2",
      "com.superhuman.electron",
    ],
    windows: {
      aumid: ["Microsoft.OutlookForWindows*", "microsoft.windowscommunicationsapps*"],
      binary: ["OUTLOOK.EXE", "olk.exe", "thunderbird.exe", "MailClient.exe"],
    },
  },
  // Messaging.
  {
    key: "builtin:messaging-apps",
    name: "Messaging apps",
    category: "messaging",
    macos: [
      "com.tinyspeck.slackmacgap",
      "com.hnc.Discord",
      "com.microsoft.teams*",
      "us.zoom.xos",
      "net.whatsapp.WhatsApp",
      "desktop.WhatsApp",
      "ru.keepcoder.Telegram",
      "org.telegram.desktop",
      "org.whispersystems.signal-desktop",
      "com.skype.skype",
      "im.riot.app",
      "com.viber.osx",
      "com.tencent.xinWeChat",
      "jp.naver.line.mac",
      "Cisco-Systems.Spark",
    ],
    windows: {
      aumid: ["MSTeams*", "5319275A.WhatsAppDesktop*"],
      binary: [
        "slack.exe",
        "Discord.exe",
        "ms-teams.exe",
        "Teams.exe",
        "Zoom.exe",
        "WhatsApp.exe",
        "Telegram.exe",
        "Signal.exe",
        "Skype.exe",
        "Element.exe",
        "Viber.exe",
        "WeChat.exe",
        "LINE.exe",
      ],
    },
  },
  // Finance: every step that could move money asks.
  {
    key: "builtin:finance-apps",
    name: "Finance apps",
    category: "finance",
    macos: [
      "com.quicken.Quicken",
      "com.intuit.QuickBooks*",
      "com.moneymoney-app.retail",
      "com.iggsoftware.banktivity*",
    ],
    windows: { binary: ["qw.exe", "QBW.EXE", "QBW32.EXE"] },
  },
  // Developer tools: click-only, and running or building asks.
  {
    key: "builtin:developer-tools",
    name: "Developer tools",
    category: "developer",
    macos: [
      "com.apple.dt.Xcode",
      "com.apple.dt.Instruments",
      "com.microsoft.VSCode",
      "com.microsoft.VSCodeInsiders",
      "com.todesktop.230313mzl4w4u92",
      "com.exafunction.windsurf",
      "dev.zed.Zed*",
      "com.jetbrains.*",
      "com.google.android.studio*",
      "com.microsoft.visual-studio",
      "com.sublimetext.*",
      "com.panic.Nova",
      "com.barebones.bbedit",
      "com.macromates.TextMate*",
      "org.gnu.Emacs",
      "org.vim.MacVim",
      "org.eclipse.*",
      "org.qt-project.qtcreator",
      "com.github.GitHubClient",
      "com.fournova.Tower*",
      "com.DanPristupov.Fork",
      "com.torusknot.SourceTreeNotMAS",
      "com.axosoft.gitkraken",
      "com.postmanlabs.mac",
      "com.insomnia.app",
      "com.docker.docker",
      "com.unity3d.*",
      "org.godotengine.godot",
      "com.rstudio.desktop",
    ],
    windows: {
      binary: [
        "Code.exe",
        "Code - Insiders.exe",
        "Cursor.exe",
        "Windsurf.exe",
        "zed.exe",
        "devenv.exe",
        "idea64.exe",
        "pycharm64.exe",
        "webstorm64.exe",
        "rider64.exe",
        "clion64.exe",
        "goland64.exe",
        "phpstorm64.exe",
        "rubymine64.exe",
        "datagrip64.exe",
        "rustrover64.exe",
        "studio64.exe",
        "sublime_text.exe",
        "notepad++.exe",
        "emacs.exe",
        "runemacs.exe",
        "gvim.exe",
        "eclipse.exe",
        "qtcreator.exe",
        "GitHubDesktop.exe",
        "Fork.exe",
        "SourceTree.exe",
        "gitkraken.exe",
        "Postman.exe",
        "Insomnia.exe",
        "Docker Desktop.exe",
        "Unity.exe",
        "Unity Hub.exe",
        "rstudio.exe",
      ],
    },
  },
  // Office and notes.
  {
    key: "builtin:office-apps",
    name: "Office apps",
    category: "office",
    macos: [
      "com.microsoft.Word",
      "com.microsoft.Excel",
      "com.microsoft.Powerpoint",
      "com.microsoft.onenote.mac",
      "com.apple.iWork.Pages",
      "com.apple.iWork.Numbers",
      "com.apple.iWork.Keynote",
      "org.libreoffice.script",
      "com.adobe.Acrobat.Pro",
      "com.adobe.Reader",
      "notion.id",
      "md.obsidian",
      "com.evernote.Evernote",
    ],
    windows: {
      binary: [
        "WINWORD.EXE",
        "EXCEL.EXE",
        "POWERPNT.EXE",
        "ONENOTE.EXE",
        "soffice.exe",
        "soffice.bin",
        "Acrobat.exe",
        "AcroRd32.exe",
        "Notion.exe",
        "Obsidian.exe",
        "Evernote.exe",
      ],
    },
  },
  // Creative tools.
  {
    key: "builtin:creative-apps",
    name: "Creative apps",
    category: "creative",
    macos: [
      "com.adobe.Photoshop",
      "com.adobe.illustrator",
      "com.adobe.InDesign",
      "com.adobe.PremierePro*",
      "com.adobe.AfterEffects",
      "com.adobe.LightroomClassicCC7",
      "com.figma.Desktop",
      "com.bohemiancoding.sketch3",
      "com.apple.FinalCut",
      "com.apple.logic10",
      "com.apple.garageband10",
      "com.apple.iMovieApp",
      "com.pixelmatorteam.pixelmator.x",
      "com.seriflabs.*",
      "org.blenderfoundation.blender",
      "com.blackmagic-design.DaVinciResolve*",
      "com.canva.CanvaDesktop",
    ],
    windows: {
      binary: [
        "Photoshop.exe",
        "Illustrator.exe",
        "InDesign.exe",
        "Adobe Premiere Pro.exe",
        "AfterFX.exe",
        "Lightroom.exe",
        "Figma.exe",
        "blender.exe",
        "Resolve.exe",
        "Canva.exe",
      ],
    },
  },
  // Device simulators and emulators.
  {
    key: "builtin:emulators",
    name: "Device emulators",
    category: "simulator",
    windows: { binary: ["emulator.exe", "qemu-system-x86_64.exe", "qemu-system-aarch64.exe"] },
  },
] satisfies AppMatcher[])

/**
 * Every listed app, never categories first (so a never match always wins), then the desktop furniture, the default
 * blocks, the benign OS apps and the other categorized apps.
 */
export const TABLE: readonly AppMatcher[] = Object.freeze([
  ...NEVER_ENTRIES,
  ...SYSTEM_UI_ENTRIES,
  ...DEFAULT_BLOCKED,
  ...BENIGN_SYSTEM,
  ...CATEGORIZED_ENTRIES,
])

function matchId(pattern: string, value: string | undefined) {
  if (!value) return false
  const expected = pattern.toLowerCase()
  const actual = value.toLowerCase()
  return expected.endsWith("*") ? actual.startsWith(expected.slice(0, -1)) : actual === expected
}

/** Whether `entry` names this identity (or, on Windows, the window class in `signals`). */
export function matches(entry: AppMatcher, app: AppIdentity, signals?: Signals): boolean {
  if (app.platform === "macos") return entry.macos?.some((id) => matchId(id, app.bundleId)) ?? false
  if (app.platform !== "windows" || !entry.windows) return false
  const windowClass = signals?.windowClass
  if (windowClass && entry.windows.windowClass?.some((id) => matchId(id, windowClass))) return true
  if (app.kind === "aumid") return entry.windows.aumid?.some((id) => matchId(id, app.aumid)) ?? false
  return entry.windows.binary?.some((id) => matchId(id, app.binary)) ?? false
}

/** The first entry of `entries` that names this identity. */
export function find(entries: readonly AppMatcher[], app: AppIdentity, signals?: Signals): AppMatcher | undefined {
  return entries.find((entry) => matches(entry, app, signals))
}

/** Whether a `system` identity is an ordinary OS app. macOS entries need an Apple-anchored signature. */
export function benign(app: AppIdentity, signals?: Signals): boolean {
  if (app.platform === "macos" && !app.apple) return false
  return find(BENIGN_SYSTEM, app, signals) !== undefined
}

/**
 * The category of an app. Order matters and fails closed:
 * 1. a never-list match;
 * 2. a child shell or REPL makes any non-developer app a terminal;
 * 3. desktop furniture (Dock, menu bar, taskbar, Start);
 * 4. a `system` identity that is neither benign nor default-blocked is `security`;
 * 5. the listed category, else `general`.
 */
export function category(app: AppIdentity, signals?: Signals): AppCategory {
  if (app.platform === "remote") return "general"
  const listed = find(TABLE, app, signals)
  if (listed && isNever(listed.category)) return listed.category
  if (signals?.childShell && listed?.category !== "developer") return "terminal"
  if (listed?.category === "system-ui") return "system-ui"
  if (app.system && !benign(app, signals) && !find(DEFAULT_BLOCKED, app, signals)) return "security"
  return listed?.category ?? "general"
}

export interface BuiltinRule {
  /** The matched entry's key, or `builtin:<category>` for a rule that comes from a signal or the system rule. */
  readonly key: string
  readonly name: string
  readonly category: AppCategory
  readonly reason: BlockReason
  /** False for every never category: no preference, policy, mention, ask reply or client removes it. */
  readonly removable: boolean
}

/** The built-in rule for an app: a never-list entry (not removable) or a DEFAULT_BLOCKED entry (removable). */
export function builtinRule(app: AppIdentity, signals?: Signals): BuiltinRule | undefined {
  const appCategory = category(app, signals)
  if (isNever(appCategory)) {
    const entry = find(TABLE, app, signals)
    const listed = entry?.category === appCategory ? entry : undefined
    return Object.freeze({
      key: listed?.key ?? `builtin:${appCategory}`,
      name: listed?.name ?? app.name,
      category: appCategory,
      reason: NEVER_REASON[appCategory],
      removable: false,
    })
  }
  const blocked = find(DEFAULT_BLOCKED, app, signals)
  if (!blocked) return undefined
  return Object.freeze({
    key: blocked.key,
    name: blocked.name,
    category: appCategory,
    reason: "user",
    removable: true,
  })
}

/**
 * The built-in layer of the access verdict (section 2.6), applied before every other rule. A never-list app is
 * `never` whatever `unblocked` says, and this layer takes nothing else: company rules, mentions and ask replies
 * come later and cannot reach it. A DEFAULT_BLOCKED app is `blocked: default` until its key is in `unblocked`.
 */
export function builtinVerdict(
  app: AppIdentity,
  prefs: { readonly unblocked: readonly string[] },
  signals?: Signals,
):
  | { readonly verdict: "never"; readonly reason: BlockReason }
  | { readonly verdict: "blocked"; readonly reason: "default" }
  | undefined {
  const rule = builtinRule(app, signals)
  if (!rule) return undefined
  if (!rule.removable) return { verdict: "never", reason: rule.reason }
  return prefs.unblocked.includes(rule.key) ? undefined : { verdict: "blocked", reason: "default" }
}
