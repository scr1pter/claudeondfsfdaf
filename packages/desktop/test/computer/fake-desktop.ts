import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { optional } from "@vectordevai/schema/schema"
import blocklistFile from "../../native/computer-helper/blocklist.json" with { type: "json" }
import { averageHash, encodePng } from "./png"

/**
 * The fake Vector Hands helper's virtual desktop (C1): six apps (Calculator, Notes with a locked-note password field,
 * Terminal, Vector itself, a System Settings privacy pane and a fictional bank), the desktop furniture, a
 * notification toast and Vector's overlay, on one or two displays, plus TextEdit and an IDE that start closed. Window order, the UI tree, hit-testing and the
 * rendered frames all come from this one model, so a test can check that what a frame shows, what a hit-test
 * reports and what an action changes agree.
 *
 * Coordinates are helper units (macOS points, Windows physical pixels), global, origin top-left. The fake's
 * protected decision reads the committed blocklist.json the way the native helpers do (`readBlocklist`), not the
 * TypeScript table, so the generated file is shown to be enough.
 */

// ---------------------------------------------------------------------------------------------------------------
// blocklist.json, as the helpers read it

const Patterns = Schema.Array(Schema.String)

export const BlocklistFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: Schema.String,
  match: Schema.Struct({
    case: Schema.Literal("insensitive"),
    wildcard: Schema.String,
    macos: Schema.String,
    windows: Schema.String,
  }),
  never: Schema.Array(ComputerApps.AppCategory),
  noAlways: Schema.Array(ComputerApps.AppCategory),
  clickOnly: Schema.Array(ComputerApps.AppCategory),
  reasons: Schema.Record(Schema.String, ComputerApps.BlockReason),
  rules: Schema.Array(Schema.Struct({ id: Schema.String, rule: Schema.String })),
  entries: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      category: ComputerApps.AppCategory,
      list: Schema.Literals(["never", "system-ui", "default-blocked", "benign-system", "categorized"]),
      removable: optional(Schema.Boolean),
      macos: optional(Patterns),
      windows: optional(
        Schema.Struct({ aumid: optional(Patterns), windowClass: optional(Patterns), binary: optional(Patterns) }),
      ),
    }),
  ),
})
export type BlocklistFile = typeof BlocklistFile.Type
type BlocklistEntry = BlocklistFile["entries"][number]

/** A helper's reading of blocklist.json: the category rules in `rules`, applied in order. */
export function readBlocklist(value: unknown) {
  const file = Schema.decodeUnknownSync(BlocklistFile, { onExcessProperty: "error" })(value)
  const never = new Set(file.never)
  const clickOnly = new Set(file.clickOnly)
  const matchId = (pattern: string, id: string | undefined) => {
    if (!id) return false
    const expected = pattern.toLowerCase()
    const actual = id.toLowerCase()
    return expected.endsWith("*") ? actual.startsWith(expected.slice(0, -1)) : actual === expected
  }
  const matches = (entry: BlocklistEntry, app: Computer.AppIdentity, signals: ComputerApps.Signals) => {
    if (app.platform === "macos") return entry.macos?.some((id) => matchId(id, app.bundleId)) ?? false
    if (app.platform !== "windows" || !entry.windows) return false
    if (signals.windowClass && entry.windows.windowClass?.some((id) => matchId(id, signals.windowClass))) return true
    if (app.kind === "aumid") return entry.windows.aumid?.some((id) => matchId(id, app.aumid)) ?? false
    return entry.windows.binary?.some((id) => matchId(id, app.binary)) ?? false
  }
  const inList = (list: BlocklistEntry["list"], app: Computer.AppIdentity, signals: ComputerApps.Signals) =>
    file.entries.some((entry) => entry.list === list && matches(entry, app, signals))
  const category = (app: Computer.AppIdentity, signals: ComputerApps.Signals = {}): ComputerApps.AppCategory => {
    if (app.platform === "remote") return "general"
    const listed = file.entries.find((entry) => matches(entry, app, signals))
    if (listed && never.has(listed.category)) return listed.category
    if (signals.childShell && listed?.category !== "developer") return "terminal"
    if (listed?.category === "system-ui") return "system-ui"
    const benign = (app.platform !== "macos" || app.apple) && inList("benign-system", app, signals)
    if (app.system && !benign && !inList("default-blocked", app, signals)) return "security"
    return listed?.category ?? "general"
  }
  return {
    file,
    category,
    /** The never floor: what a helper refuses with `protected`, whatever the session approved. */
    isProtected: (app: Computer.AppIdentity, signals?: ComputerApps.Signals) => never.has(category(app, signals)),
    /** The click-only rule: text input into these apps is refused with `blocked`. */
    isClickOnly: (app: Computer.AppIdentity, signals?: ComputerApps.Signals) => clickOnly.has(category(app, signals)),
  }
}

export const blocklist = readBlocklist(blocklistFile)

// ---------------------------------------------------------------------------------------------------------------
// The model

export type Platform = "macos" | "windows"
export type Scenario = "calculator" | "notes" | "blocked" | "sensitive" | "multi-display"
export const SCENARIOS: readonly Scenario[] = ["calculator", "notes", "blocked", "sensitive", "multi-display"]

export type Rgb = readonly [number, number, number]
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Flat colours, so a test can tell from a pixel what was painted there. */
export const COLORS = {
  mask: [0, 0, 0],
  vector: [88, 44, 160],
  wallpaper: [40, 90, 160],
  menuBar: [222, 222, 222],
  dock: [70, 70, 70],
  calculator: [255, 149, 0],
  notes: [255, 214, 10],
  terminal: [40, 160, 60],
  settings: [110, 120, 140],
  bank: [0, 120, 90],
  vectorApp: [150, 100, 230],
  toast: [245, 245, 245],
  overlay: [255, 0, 255],
  textedit: [200, 230, 255],
  ide: [30, 30, 46],
} as const satisfies Record<string, Rgb>

export interface FakeNode {
  /** Stable model id, for example `notes.password`. */
  readonly id: string
  readonly role: string
  readonly name: string
  value?: string
  /** Window-relative. */
  readonly rect: Rect
  readonly secure: boolean
  readonly editable: boolean
  /** A button's effect when pressed. */
  readonly press?: string
}

export interface FakeWindow {
  readonly windowId: string
  readonly app: string
  title: string
  bounds: Rect
  minimized: boolean
  readonly color: Rgb
  /** Windows only: the class `ComputerApps` keys taskbar, desktop and console windows by. */
  readonly windowClass?: string
  readonly nodes: FakeNode[]
}

export interface FakeApp {
  readonly slot: string
  readonly identity: Computer.AppIdentity
  readonly pid: number
  /** A regular app, listed by `apps.list`; desktop furniture and the notification host are not. */
  readonly regular: boolean
  running: boolean
  focused?: string
}

export interface FakeDisplay {
  readonly id: string
  readonly bounds: Rect
  /** Image pixels per helper unit at native resolution. */
  readonly scale: number
  readonly dpiScale?: number
  readonly primary: boolean
}

type Seed = {
  slot: string
  name: string
  pid: number
  regular?: boolean
  running?: boolean
  /** The colour of the window an app that starts closed opens with. */
  color?: Rgb
  mac: Mac
  win: Win
}
type Mac = { bundleId: string; apple: boolean; system: boolean; path: string; teamId?: string }
type Win =
  | { kind: "aumid"; aumid: string; publisher: string; system: boolean; exe?: string }
  | { kind: "exe"; publisher: string; product: string; binary: string; system: boolean; exe: string }

const SEEDS: Seed[] = [
  {
    slot: "calculator",
    name: "Calculator",
    pid: 501,
    mac: {
      bundleId: "com.apple.calculator",
      apple: true,
      system: true,
      path: "/System/Applications/Calculator.app",
    },
    win: {
      kind: "aumid",
      aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
      publisher: "Microsoft Corporation",
      system: false,
    },
  },
  {
    slot: "notes",
    name: "Notes",
    pid: 502,
    mac: { bundleId: "com.apple.Notes", apple: true, system: true, path: "/System/Applications/Notes.app" },
    // An exe identity whose product holds `|` and `%`, so its key carries escaped parts.
    win: {
      kind: "exe",
      publisher: "Contoso Ltd.",
      product: "Notes | Pro 100%",
      binary: "ContosoNotes.exe",
      system: false,
      exe: "C:\\Program Files\\Contoso\\ContosoNotes.exe",
    },
  },
  {
    slot: "terminal",
    name: "Terminal",
    pid: 503,
    mac: {
      bundleId: "com.apple.Terminal",
      apple: true,
      system: true,
      path: "/System/Applications/Utilities/Terminal.app",
    },
    win: {
      kind: "aumid",
      aumid: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
      publisher: "Microsoft Corporation",
      system: false,
    },
  },
  {
    slot: "settings",
    name: "System Settings",
    pid: 504,
    mac: {
      bundleId: "com.apple.systempreferences",
      apple: true,
      system: true,
      path: "/System/Applications/System Settings.app",
    },
    win: {
      kind: "aumid",
      aumid: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
      publisher: "Microsoft Windows",
      system: true,
    },
  },
  {
    slot: "bank",
    name: "Northwind Bank",
    pid: 505,
    mac: {
      bundleId: "com.example.northwind-bank",
      teamId: "NWBANK0001",
      apple: false,
      system: false,
      path: "/Applications/Northwind Bank.app",
    },
    win: {
      kind: "exe",
      publisher: "Northwind Bank plc",
      product: "Northwind Bank",
      binary: "NorthwindBank.exe",
      system: false,
      exe: "C:\\Program Files\\Northwind Bank\\NorthwindBank.exe",
    },
  },
  {
    slot: "vector",
    name: "Vector",
    pid: 600,
    mac: {
      bundleId: "ai.vector.app",
      teamId: "VECTOR0001",
      apple: false,
      system: false,
      path: "/Applications/Vector.app",
    },
    win: {
      kind: "exe",
      publisher: "Vector",
      product: "Vector",
      binary: "vector-desktop.exe",
      system: false,
      exe: "C:\\Users\\Ada\\AppData\\Local\\Programs\\vector-desktop\\vector-desktop.exe",
    },
  },
  {
    slot: "textedit",
    name: "TextEdit",
    pid: 510,
    running: false,
    color: COLORS.textedit,
    mac: { bundleId: "com.apple.TextEdit", apple: true, system: true, path: "/System/Applications/TextEdit.app" },
    win: {
      kind: "aumid",
      aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
      publisher: "Microsoft Corporation",
      system: false,
    },
  },
  // A developer tool, so the click-only rule has a target: clicks and shortcuts work, text input is refused.
  {
    slot: "ide",
    name: "Visual Studio Code",
    pid: 511,
    running: false,
    color: COLORS.ide,
    mac: {
      bundleId: "com.microsoft.VSCode",
      teamId: "TESTIDE001",
      apple: false,
      system: false,
      path: "/Applications/Visual Studio Code.app",
    },
    win: {
      kind: "exe",
      publisher: "Microsoft Corporation",
      product: "Visual Studio Code",
      binary: "Code.exe",
      system: false,
      exe: "C:\\Users\\Ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    },
  },
  {
    slot: "shell",
    name: "Desktop",
    pid: 90,
    regular: false,
    mac: { bundleId: "com.apple.dock", apple: true, system: true, path: "/System/Library/CoreServices/Dock.app" },
    win: {
      kind: "exe",
      publisher: "Microsoft Windows",
      product: "Microsoft Windows Operating System",
      binary: "explorer.exe",
      system: true,
      exe: "C:\\Windows\\explorer.exe",
    },
  },
  {
    slot: "menubar",
    name: "SystemUIServer",
    pid: 91,
    regular: false,
    mac: {
      bundleId: "com.apple.systemuiserver",
      apple: true,
      system: true,
      path: "/System/Library/CoreServices/SystemUIServer.app",
    },
    win: {
      kind: "exe",
      publisher: "Microsoft Windows",
      product: "Microsoft Windows Operating System",
      binary: "explorer.exe",
      system: true,
      exe: "C:\\Windows\\explorer.exe",
    },
  },
  {
    slot: "notifications",
    name: "Notification Center",
    pid: 92,
    regular: false,
    mac: {
      bundleId: "com.apple.notificationcenterui",
      apple: true,
      system: true,
      path: "/System/Library/CoreServices/NotificationCenter.app",
    },
    win: {
      kind: "exe",
      publisher: "Microsoft Windows",
      product: "Microsoft Windows Operating System",
      binary: "ShellExperienceHost.exe",
      system: true,
      exe: "C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe",
    },
  },
]

function identityOf(seed: Seed, platform: Platform): Computer.AppIdentity {
  if (platform === "macos")
    return {
      platform: "macos",
      bundleId: seed.mac.bundleId,
      ...(seed.mac.teamId ? { teamId: seed.mac.teamId } : {}),
      apple: seed.mac.apple,
      system: seed.mac.system,
      verified: true,
      name: seed.name,
      path: seed.mac.path,
      pid: seed.pid,
    }
  if (seed.win.kind === "aumid")
    return {
      platform: "windows",
      kind: "aumid",
      aumid: seed.win.aumid,
      publisher: seed.win.publisher,
      system: seed.win.system,
      verified: true,
      name: seed.slot === "textedit" ? "Notepad" : seed.name,
      ...(seed.win.exe ? { exe: seed.win.exe } : {}),
      pid: seed.pid,
    }
  return {
    platform: "windows",
    kind: "exe",
    publisher: seed.win.publisher,
    product: seed.win.product,
    binary: seed.win.binary,
    system: seed.win.system,
    verified: true,
    name: seed.slot === "notes" ? "Contoso Notes" : seed.name,
    exe: seed.win.exe,
    pid: seed.pid,
  }
}

/** Vector's overlay window: drawn above everything, so a capture that fails to exclude it shows it. */
export const OVERLAY = "vector-overlay"

const node = (id: string, role: string, name: string, rect: Rect, extra: Partial<FakeNode> = {}): FakeNode => ({
  id,
  role,
  name,
  rect,
  secure: false,
  editable: false,
  ...extra,
})

function windowsFor(platform: Platform, scenario: Scenario): FakeWindow[] {
  const mac = platform === "macos"
  const notesBounds =
    scenario === "multi-display" ? { x: -700, y: -150, w: 360, h: 300 } : { x: 240, y: 100, w: 360, h: 300 }
  const make = (
    windowId: string,
    app: string,
    title: string,
    bounds: Rect,
    color: Rgb,
    nodes: FakeNode[],
    windowClass?: string,
  ) =>
    ({
      windowId,
      app,
      title,
      bounds,
      minimized: false,
      color,
      nodes,
      ...(windowClass && !mac ? { windowClass } : {}),
    }) satisfies FakeWindow
  const keys = ["7", "8", "9", "+"]
  return [
    make(OVERLAY, "vector", "", { x: 0, y: 0, w: 1000, h: 640 }, COLORS.overlay, []),
    make("toast-1", "notifications", "New message", { x: 760, y: 30, w: 220, h: 64 }, COLORS.toast, [
      node("toast.text", "AXStaticText", "Ada: are we still on for lunch?", { x: 10, y: 10, w: 200, h: 40 }),
    ]),
    make("calc-1", "calculator", "Calculator", { x: 40, y: 60, w: 240, h: 320 }, COLORS.calculator, [
      node("calculator.display", "AXStaticText", "Display", { x: 15, y: 20, w: 210, h: 50 }, { value: "0" }),
      ...keys.map((key, index) =>
        node(`calculator.${key}`, "AXButton", key, { x: 15 + index * 60, y: 90, w: 45, h: 45 }, { press: key }),
      ),
      node("calculator.=", "AXButton", "=", { x: 195, y: 260, w: 45, h: 45 }, { press: "=" }),
    ]),
    make("notes-1", "notes", "Groceries", notesBounds, COLORS.notes, [
      node(
        "notes.title",
        "AXTextField",
        "Title",
        { x: 20, y: 20, w: 320, h: 30 },
        { value: "Groceries", editable: true },
      ),
      node(
        "notes.body",
        "AXTextArea",
        "Body",
        { x: 20, y: 60, w: 320, h: 150 },
        { value: "Milk, eggs", editable: true },
      ),
      node(
        "notes.password",
        "AXSecureTextField",
        "Locked note password",
        { x: 20, y: 220, w: 200, h: 30 },
        {
          secure: true,
          editable: true,
        },
      ),
    ]),
    make("bank-1", "bank", "Northwind Bank", { x: 420, y: 330, w: 260, h: 220 }, COLORS.bank, [
      node(
        "bank.amount",
        "AXTextField",
        "Amount",
        { x: 20, y: 20, w: 220, h: 30 },
        { value: "120.00", editable: true },
      ),
      node("bank.send", "AXButton", "Send payment", { x: 20, y: 160, w: 220, h: 40 }, { press: "send" }),
    ]),
    make(
      "settings-1",
      "settings",
      "Privacy & Security",
      { x: 60, y: 400, w: 300, h: 170 },
      COLORS.settings,
      [
        node("settings.heading", "AXHeading", "Privacy & Security", { x: 10, y: 10, w: 280, h: 30 }),
        node("settings.screen", "AXCheckBox", "Screen Recording", { x: 10, y: 50, w: 200, h: 24 }, { value: "1" }),
      ],
      "ApplicationFrameWindow",
    ),
    make(
      "terminal-1",
      "terminal",
      "zsh",
      { x: 640, y: 40, w: 320, h: 220 },
      COLORS.terminal,
      [node("terminal.shell", "AXTextArea", "Shell", { x: 10, y: 10, w: 300, h: 200 }, { value: "% ls" })],
      "CASCADIA_HOSTING_WINDOW_CLASS",
    ),
    make("vector-1", "vector", "Vector", { x: 700, y: 280, w: 280, h: 280 }, COLORS.vectorApp, [
      node("vector.stop", "AXButton", "Stop", { x: 20, y: 20, w: 80, h: 30 }, { press: "stop" }),
    ]),
    ...(mac
      ? [
          make("menubar-1", "menubar", "", { x: 0, y: 0, w: 1000, h: 24 }, COLORS.menuBar, []),
          make("dock-1", "shell", "", { x: 250, y: 590, w: 500, h: 46 }, COLORS.dock, []),
        ]
      : [make("taskbar-1", "menubar", "", { x: 0, y: 600, w: 1000, h: 40 }, COLORS.dock, [], "Shell_TrayWnd")]),
    // The desktop itself, under everything on each display, so every point has an owner.
    make("wallpaper-1", "shell", "", { x: 0, y: 0, w: 1000, h: 640 }, COLORS.wallpaper, [], "Progman"),
    ...(scenario === "multi-display"
      ? [make("wallpaper-2", "shell", "", { x: -800, y: -200, w: 800, h: 500 }, COLORS.wallpaper, [], "Progman")]
      : []),
  ]
}

const FRONT: Record<Scenario, string> = {
  calculator: "calculator",
  notes: "notes",
  blocked: "terminal",
  sensitive: "bank",
  "multi-display": "notes",
}

/** A capture's view of the windows, kept so later ops can answer `stale_frame`, `changed` and `occluded`. */
export interface Snapshot {
  readonly displayGeneration: number
  /** On-screen windows, front first, with their bounds at capture time. */
  readonly windows: readonly { readonly windowId: string; readonly bounds: Rect }[]
}

export type Paint = "show" | "mask" | "vector" | "exclude"

export function createDesktop(input: { platform?: Platform; scenario?: Scenario } = {}) {
  const platform = input.platform ?? "macos"
  const scenario = input.scenario ?? "calculator"
  const apps = new Map<string, FakeApp>(
    SEEDS.map((seed) => [
      seed.slot,
      {
        slot: seed.slot,
        identity: identityOf(seed, platform),
        pid: seed.pid,
        regular: seed.regular ?? true,
        running: seed.running ?? true,
      },
    ]),
  )
  // Front first.
  const windows = windowsFor(platform, scenario)
  const displays: FakeDisplay[] =
    platform === "macos"
      ? [
          { id: "1", bounds: { x: 0, y: 0, w: 1000, h: 640 }, scale: 1, primary: true },
          ...(scenario === "multi-display"
            ? [{ id: "2", bounds: { x: -800, y: -200, w: 800, h: 500 }, scale: 2, primary: false }]
            : []),
        ]
      : [
          { id: "\\\\.\\DISPLAY1", bounds: { x: 0, y: 0, w: 1000, h: 640 }, scale: 1, dpiScale: 1, primary: true },
          ...(scenario === "multi-display"
            ? [
                {
                  id: "\\\\.\\DISPLAY2",
                  bounds: { x: -800, y: -200, w: 800, h: 500 },
                  scale: 1,
                  dpiScale: 1.5,
                  primary: false,
                },
              ]
            : []),
        ]
  const state = {
    frontmost: FRONT[scenario],
    generation: 0,
    displayGeneration: 0,
    clipboard: "",
    cursor: { x: 0, y: 0 },
  }
  apps.get("notes")!.focused = "notes.title"
  const contains = (rect: Rect, point: { x: number; y: number }) =>
    point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h

  const desktop = {
    platform,
    scenario,
    displays,
    /** The virtual OS pointer; querying it never moves it or takes focus. */
    get cursor() {
      return { ...state.cursor }
    },
    set cursor(point: { x: number; y: number }) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The virtual cursor must be finite")
      state.cursor = { x: point.x, y: point.y }
    },
    get generation() {
      return state.generation
    },
    get displayGeneration() {
      return state.displayGeneration
    },
    get clipboard() {
      return state.clipboard
    },
    set clipboard(text: string) {
      state.clipboard = text
    },
    app: (slot: string) => apps.get(slot),
    apps: () => [...apps.values()],
    window: (windowId: string) => windows.find((window) => window.windowId === windowId),
    appOf: (window: FakeWindow) => apps.get(window.app)!,
    windowsOf: (slot: string) => windows.filter((window) => window.app === slot),
    /** Windows on screen, front first. */
    stack: () => windows.filter((window) => !window.minimized && apps.get(window.app)!.running),
    frontmost: () => apps.get(state.frontmost)!,
    display: (id: string) => displays.find((display) => display.id === id),
    displayAt: (point: { x: number; y: number }) =>
      displays.find((display) => contains(display.bounds, point)) ?? displays[0]!,
    /** The topmost on-screen window at a global point, skipping `exclude`. */
    topAt(point: { x: number; y: number }, exclude: ReadonlySet<string> = new Set()) {
      return desktop.stack().find((window) => !exclude.has(window.windowId) && contains(window.bounds, point))
    },
    nodeAt: (window: FakeWindow, point: { x: number; y: number }) =>
      window.nodes.find((item) =>
        contains({ ...item.rect, x: window.bounds.x + item.rect.x, y: window.bounds.y + item.rect.y }, point),
      ),
    /** The focused element of an app, the frontmost one by default. */
    focusedNode(slot = state.frontmost) {
      const app = apps.get(slot)!
      return desktop
        .windowsOf(app.slot)
        .flatMap((window) => window.nodes)
        .find((item) => item.id === app.focused)
    },
    snapshot: (): Snapshot => ({
      displayGeneration: state.displayGeneration,
      windows: desktop.stack().map((window) => ({ windowId: window.windowId, bounds: { ...window.bounds } })),
    }),
    /** Raise a window and make its app frontmost. */
    raise(windowId: string) {
      const index = windows.findIndex((window) => window.windowId === windowId)
      if (index === -1) return
      const [window] = windows.splice(index, 1)
      window!.minimized = false
      // Above every app window, below the notification toast and Vector's overlay.
      const top = windows.findIndex((item) => item.windowId !== OVERLAY && item.app !== "notifications")
      windows.splice(top === -1 ? 0 : top, 0, window!)
      if (apps.get(window!.app)!.regular) state.frontmost = window!.app
      state.generation++
    },
    activate(slot: string) {
      const app = apps.get(slot)
      if (!app) return
      if (!app.running) {
        app.running = true
        windows.splice(2, 0, {
          windowId: `${slot}-1`,
          app: slot,
          title: "Untitled",
          bounds: { x: 300, y: 160, w: 320, h: 240 },
          minimized: false,
          color: SEEDS.find((seed) => seed.slot === slot)?.color ?? COLORS.textedit,
          nodes: [
            node(`${slot}.text`, "AXTextArea", "Text", { x: 10, y: 10, w: 300, h: 220 }, { value: "", editable: true }),
          ],
        })
        app.focused = `${slot}.text`
      }
      const window = windows.find((item) => item.app === slot)
      if (window) desktop.raise(window.windowId)
      state.frontmost = slot
      state.generation++
    },
    focus(windowId: string, nodeId?: string) {
      if (!desktop.window(windowId)) return
      desktop.raise(windowId)
      if (nodeId) desktop.select(windowId, nodeId)
      state.generation++
    },
    /** Focus an element inside its app without raising anything (an AX focus change in a background app). */
    select(windowId: string, nodeId: string) {
      const window = desktop.window(windowId)
      if (!window?.nodes.some((item) => item.id === nodeId)) return
      apps.get(window.app)!.focused = nodeId
      state.generation++
    },
    /** A button's effect (Calculator's keys); returns whether anything happened. */
    press(item: FakeNode) {
      if (!item.press) return false
      const display = windows.flatMap((window) => window.nodes).find((entry) => entry.id === "calculator.display")
      if (display && item.id.startsWith("calculator.")) {
        const current = display.value === "0" ? "" : (display.value ?? "")
        display.value = item.press === "=" ? String(evaluate(current)) : `${current}${item.press}`
      }
      state.generation++
      return true
    },
    setValue(item: FakeNode, value: string) {
      item.value = value
      state.generation++
    },
    move(windowId: string, bounds: Rect) {
      const window = desktop.window(windowId)
      if (!window) return
      window.bounds = { ...bounds }
      state.generation++
    },
    minimize(windowId: string, minimized = true) {
      const window = desktop.window(windowId)
      if (!window) return
      window.minimized = minimized
      state.generation++
    },
    displayChange() {
      state.displayGeneration++
      state.generation++
    },
  }
  desktop.raise(desktop.windowsOf(FRONT[scenario])[0]!.windowId)
  state.generation = 0
  return desktop
}

export type FakeDesktop = ReturnType<typeof createDesktop>

function evaluate(expression: string) {
  return expression
    .split("+")
    .filter(Boolean)
    .reduce((sum, term) => sum + Number(term), 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

type PixelRect = { x0: number; y0: number; x1: number; y1: number }

/**
 * Paint `windows` (front first) back to front into an RGBA image of `width` x `height` whose top-left pixel starts at
 * global `origin`, with `scale` image pixels per helper unit. A pixel takes the colour of the window under its
 * centre. `mask` windows are opaque black and `vector` windows one opaque Vector block; `exclude` windows are not
 * drawn, so the frame shows what is under them. `masked` lists, in image pixels, the visible part of every painted
 * block. hiddenCount counts distinct regular app owners contributing visible blocks, independently of the number
 * of windows or mask pieces; the caller identifies owners and excludes decorative/system hosts.
 */
export function render(input: {
  windows: readonly FakeWindow[]
  paint: (window: FakeWindow) => Paint
  hiddenOwner: (window: FakeWindow) => string | undefined
  origin: { x: number; y: number }
  scale: number
  width: number
  height: number
}) {
  const rgba = new Uint8Array(input.width * input.height * 4)
  const toPixels = (rect: Rect): PixelRect => {
    const edge = (value: number, origin: number, limit: number) =>
      Math.min(limit, Math.max(0, Math.ceil((value - origin) * input.scale - 0.5)))
    return {
      x0: edge(rect.x, input.origin.x, input.width),
      y0: edge(rect.y, input.origin.y, input.height),
      x1: edge(rect.x + rect.w, input.origin.x, input.width),
      y1: edge(rect.y + rect.h, input.origin.y, input.height),
    }
  }
  const drawn = input.windows
    .map((window) => ({ window, paint: input.paint(window), rect: toPixels(window.bounds) }))
    .filter((item) => item.paint !== "exclude")
  for (const item of drawn.toReversed()) {
    const color = item.paint === "mask" ? COLORS.mask : item.paint === "vector" ? COLORS.vector : item.window.color
    for (let y = item.rect.y0; y < item.rect.y1; y++)
      for (let x = item.rect.x0; x < item.rect.x1; x++) {
        const offset = (y * input.width + x) * 4
        rgba[offset] = color[0]
        rgba[offset + 1] = color[1]
        rgba[offset + 2] = color[2]
        rgba[offset + 3] = 255
      }
  }
  const hidden = new Set<string>()
  const masked = drawn.flatMap((item, index) => {
    if (item.paint !== "mask" && item.paint !== "vector") return []
    const pieces = drawn
      .slice(0, index)
      .reduce((pieces, above) => pieces.flatMap((piece) => subtract(piece, above.rect)), [item.rect])
      .filter((piece) => piece.x0 < piece.x1 && piece.y0 < piece.y1)
    if (pieces.length) {
      const owner = input.hiddenOwner(item.window)
      if (owner !== undefined) hidden.add(owner)
    }
    return pieces.map((piece) => ({ x: piece.x0, y: piece.y0, w: piece.x1 - piece.x0, h: piece.y1 - piece.y0 }))
  })
  const image = { width: input.width, height: input.height, rgba }
  return { image, masked, hiddenCount: hidden.size, png: encodePng(image), hash: averageHash(image) }
}

function subtract(a: PixelRect, b: PixelRect): PixelRect[] {
  if (a.x0 >= a.x1 || a.y0 >= a.y1) return []
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  if (x0 >= x1 || y0 >= y1) return [a]
  return [
    { x0: a.x0, y0: a.y0, x1: a.x1, y1: y0 },
    { x0: a.x0, y0: y1, x1: a.x1, y1: a.y1 },
    { x0: a.x0, y0, x1: x0, y1 },
    { x0: x1, y0, x1: a.x1, y1 },
  ].filter((piece) => piece.x0 < piece.x1 && piece.y0 < piece.y1)
}
