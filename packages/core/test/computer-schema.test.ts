import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

const strict = (schema: Schema.Decoder<unknown>) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })

test("pixel scroll units survive both bridge and helper codecs without changing generic wheel amounts", () => {
  const step = { kind: "scroll", at: { x: 12, y: 34 }, dx: -123, dy: 456, unit: "pixel" }
  expect(strict(Computer.Step)(step)).toEqual(step)
  const helper = { id: 1, op: "input.scroll", captureId: "frame_1", x: 12, y: 34, dx: -123, dy: 456, unit: "pixel" }
  expect(strict(Computer.helperRequest("input.scroll"))(helper)).toEqual(helper)
  expect(strict(Computer.Step)({ kind: "scroll", dx: 0, dy: 2 })).not.toHaveProperty("unit")
  expect(() => strict(Computer.Step)({ ...step, unit: "unknown" })).toThrow()
  expect(() => strict(Computer.helperRequest("input.scroll"))({ ...helper, unit: "unknown" })).toThrow()
})

const accepts = (schema: Schema.Decoder<unknown>, value: unknown) => {
  expect(() => strict(schema)(value)).not.toThrow()
}

const rejects = (schema: Schema.Decoder<unknown>, value: unknown) => {
  expect(() => strict(schema)(value)).toThrow()
}

const mac = {
  platform: "macos",
  bundleId: "com.apple.iWork.Numbers",
  apple: true,
  system: false,
  verified: true,
  name: "Numbers",
  path: "/Applications/Numbers.app",
  pid: 501,
}
const terminal = { ...mac, bundleId: "com.apple.Terminal", system: true, name: "Terminal", pid: 502 }
const rect = { x: 0, y: 0, w: 1440, h: 900 }
const budget = { maxWidth: 1440, maxHeight: 900, maxPixels: 1440 * 900 }
const frame = {
  id: "frame_1",
  scope: "window",
  display: "1",
  windowId: "42",
  bounds: rect,
  scale: 2,
  image: { w: 1440, h: 900 },
  at: 1_700_000_000_000,
  hash: "0123456789abcdef",
}
const jpeg = "data:image/jpeg;base64,AAAA"
const png = "data:image/png;base64,AAAA"
test("native app icons retain the exact decoded PNG byte cap", () => {
  const row = { identity: mac, active: false, windows: [] }
  const maximum = `data:image/png;base64,${Buffer.alloc(Computer.LIMITS.iconBytes).toString("base64")}`
  const overflow = `data:image/png;base64,${Buffer.alloc(Computer.LIMITS.iconBytes + 1).toString("base64")}`
  expect(maximum.length).toBe(overflow.length)
  expect(strict(Computer.HelperApp)({ ...row, icon: maximum })).toEqual({ ...row, icon: maximum })
  expect(strict(Computer.HelperApp)(row)).toEqual(row)
  rejects(Computer.HelperApp, { ...row, icon: overflow })
  rejects(Computer.HelperApp, { ...row, icon: "data:image/jpeg;base64,AAAA" })
  rejects(Computer.HelperApp, { ...row, icon: "data:image/png;base64,A" })
})
const inspect = {
  app: mac,
  category: "office",
  pid: 501,
  window: { id: "42", title: "Receipts" },
  element: { role: "AXButton", label: "Save", secure: false, enabled: true, editable: false },
  clipboard: { agentOwned: false },
}
const state = {
  phase: "working",
  backend: "local-macos",
  mode: "foreground",
  holder: { sessionID: "ses_root", directory: "/Users/me/project", title: "Receipts", startedAt: 1, actions: 3 },
  apps: [{ key: "app:macos:com.apple.iwork.numbers", name: "Numbers" }],
  step: "Clicking Save in Numbers",
  queue: [{ sessionID: "ses_other", title: "Other task" }],
  escStops: true,
  stopChord: "Command+Shift+Escape",
  lease: 7,
  reduceMotion: false,
}
const envelope = { v: 1, rootSessionID: "ses_root", sessionID: "ses_root", directory: "/Users/me/project" }
const lease = 7

describe("window and app-menu observation contracts", () => {
  const node = { ref: "ui_1", role: "AXMenuItem", name: "Save", secure: false, enabled: true }
  const hit = { ...node, owner: mac, windowId: "42", elementId: "element-1" }
  const menu = {
    scope: "app-menu",
    app: mac,
    category: "office",
    pid: 501,
    menuPath: ["File", "Save"],
    element: { ...inspect.element, role: "AXMenuItem", ref: "ui_1", elementId: "element-1" },
    clipboard: { agentOwned: false },
  }
  const menuHit = {
    scope: "app-menu",
    ...node,
    owner: mac,
    pid: 501,
    elementId: "element-1",
    menuPath: ["File", "Save"],
  }
  const menuNode = { scope: "app-menu", ...node, pid: 501, elementId: "element-1", menuPath: ["File", "Save"] }

  test("legacy required-window observations and explicit window scope remain compatible", () => {
    for (const scope of [undefined, "window"]) {
      const explicit = scope ? { scope } : {}
      accepts(Computer.InspectResult, { ...inspect, ...explicit })
      accepts(Computer.HitResult, { ...hit, ...explicit })
      accepts(Computer.UiNode, { ...node, ...explicit })
      accepts(Computer.TreeResult, {
        generation: 1,
        truncated: false,
        nodes: [{ ...node, ...explicit, bounds: rect, focused: false }],
      })
    }
    rejects(Computer.InspectResult, { ...inspect, window: undefined })
    rejects(Computer.HitResult, { ...hit, windowId: undefined })
    rejects(Computer.TreeResult, { generation: 1, truncated: false, nodes: [{ ...node, focused: false }] })
  })

  test("menu observations require the explicit Mac scope and no fabricated window", () => {
    accepts(Computer.InspectResult, menu)
    accepts(Computer.HitResult, menuHit)
    accepts(Computer.UiNode, menuNode)
    accepts(Computer.TreeResult, { generation: 1, truncated: false, nodes: [{ ...menuNode, focused: false }] })
    accepts(Computer.InspectResult, { ...menu, bounds: rect })
    accepts(Computer.HitResult, { ...menuHit, bounds: rect })
    rejects(Computer.InspectResult, { ...menu, window: inspect.window })
    rejects(Computer.HitResult, { ...menuHit, windowId: "42" })
    rejects(Computer.HitResult, { ...menuHit, windowTitle: "Invented" })
    rejects(Computer.InspectResult, { ...menu, scope: undefined })
    rejects(Computer.UiNode, { ...menuNode, scope: undefined })
    rejects(Computer.InspectResult, { ...inspect, menuPath: ["File", "Save"] })
    rejects(Computer.HitResult, { ...hit, menuPath: ["File", "Save"] })
    const hybrids: readonly (readonly [Schema.Decoder<unknown>, unknown])[] = [
      [Computer.InspectResult, { ...menu, window: inspect.window }],
      [Computer.HitResult, { ...menuHit, windowId: "42" }],
      [Computer.UiNode, { ...menuNode, windowId: "42" }],
    ]
    for (const [schema, hybrid] of hybrids) {
      expect(Schema.is(schema)(hybrid)).toBe(false)
      expect(() => Schema.decodeUnknownSync(schema)(hybrid)).toThrow()
    }
  })

  test("menu ownership and private element identity cannot be replaced by app-only or Windows facts", () => {
    const windows = {
      platform: "windows",
      kind: "aumid",
      aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
      name: "Calculator",
      system: true,
      verified: true,
      pid: 501,
    }
    for (const app of [windows, { ...mac, pid: undefined }, { ...mac, pid: 502 }]) {
      rejects(Computer.InspectResult, { ...menu, app })
      rejects(Computer.HitResult, { ...menuHit, owner: app })
    }
    for (const key of ["ref", "elementId"] as const) {
      rejects(Computer.InspectResult, { ...menu, element: { ...menu.element, [key]: undefined } })
      rejects(Computer.HitResult, { ...menuHit, [key]: undefined })
      rejects(Computer.UiNode, { ...menuNode, [key]: undefined })
    }
    rejects(Computer.InspectResult, { ...menu, pid: 502 })
    rejects(Computer.HitResult, { ...menuHit, pid: 502 })
    rejects(Computer.UiNode, { ...menuNode, pid: undefined })
  })

  test("the read-only menu root is observable but cannot be a sensitive whole-app approval", () => {
    accepts(Computer.InspectResult, { ...menu, menuPath: [] })
    accepts(Computer.UiNode, { ...menuNode, menuPath: [] })
    const target = {
      scope: "app-menu",
      appName: "Numbers",
      appKey: "app:macos:com.apple.iwork.numbers",
      pid: 501,
      ref: "ui_1",
      elementId: "element-1",
      menuPath: ["File", "Send"],
    }
    const sensitive = { action: "click", why: "send", target, targetName: "Send", stepDigest: "a".repeat(64) }
    accepts(Computer.SensitiveAskTarget, target)
    accepts(Computer.SensitiveAskMetadata, sensitive)
    for (const key of ["pid", "ref", "elementId", "menuPath"] as const)
      rejects(Computer.SensitiveAskMetadata, { ...sensitive, target: { ...target, [key]: undefined } })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, target: { ...target, menuPath: [] } })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, target: { ...target, windowId: "42" } })
    const programKey = "program:macos:" + "a".repeat(64)
    accepts(Computer.ProgramKey, programKey)
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, target: { ...target, appKey: programKey } })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, target: { ...target, scope: undefined } })
  })

  test("menu paths retain strict component and depth bounds across observations and consent", () => {
    accepts(Computer.MenuPath, Array(30).fill("x".repeat(256)))
    for (const path of [[""], ["Save\n"], ["Save\u202e"], ["x".repeat(257)], Array(31).fill("File")]) {
      rejects(Computer.MenuPath, path)
      rejects(Computer.InspectResult, { ...menu, menuPath: path })
      rejects(Computer.UiNode, { ...menuNode, menuPath: path })
    }
  })

  test("only explicit menu observations and receipts can carry a bounded observed shortcut", () => {
    const menuShortcut = ["Command", "v"]
    accepts(Computer.InspectResult, { ...menu, menuShortcut })
    accepts(Computer.HitResult, { ...menuHit, menuShortcut })
    accepts(Computer.UiNode, { ...menuNode, menuShortcut })
    accepts(Computer.SensitiveAskTarget, {
      scope: "app-menu",
      appName: "Numbers",
      appKey: "app:macos:com.apple.iwork.numbers",
      pid: 501,
      ref: "ui_1",
      elementId: "element-1",
      menuPath: ["Édition", "Coller"],
      menuShortcut,
    })
    rejects(Computer.InspectResult, { ...inspect, menuShortcut })
    rejects(Computer.HitResult, { ...hit, menuShortcut })
    for (const invalid of [[], [""], ["\n"], ["x".repeat(33)], Array(9).fill("Shift")]) {
      rejects(Computer.InspectResult, { ...menu, menuShortcut: invalid })
      rejects(Computer.HitResult, { ...menuHit, menuShortcut: invalid })
    }
  })
})

describe("Windows window-menu evidence contracts", () => {
  const app = {
    platform: "windows",
    kind: "aumid",
    aumid: "Test.Editor!App",
    name: "Editor",
    system: false,
    verified: true,
    pid: 501,
  }
  const menu = { path: ["Édition", "Coller"], shortcut: ["Control", "v"] }
  const node = {
    ref: "ui_1",
    role: "MenuItem",
    name: "Coller",
    secure: false,
    enabled: true,
    pid: 501,
    windowId: "42",
    elementId: "element-1",
    menu,
  }
  const observed = {
    ...inspect,
    app,
    element: { ...inspect.element, role: "MenuItem", ref: "ui_1", elementId: "element-1" },
    menu,
  }
  const hit = {
    ref: node.ref,
    role: node.role,
    name: node.name,
    secure: node.secure,
    enabled: node.enabled,
    windowId: node.windowId,
    elementId: node.elementId,
    menu,
    owner: app,
  }
  const tree = { ...node, owner: app, focused: false, bounds: rect }
  const target = {
    appName: "Editor",
    appKey: "app:windows:aumid:test.editor!app",
    pid: 501,
    windowId: "42",
    ref: "ui_1",
    elementId: "element-1",
    menu,
  }
  const trees = (value: unknown) => ({ generation: 1, truncated: false, nodes: [value] })

  test("actual window menus retain nested ancestry and accelerator across observations and consent", () => {
    accepts(Computer.WindowMenu, menu)
    accepts(Computer.InspectResult, observed)
    accepts(Computer.HitResult, hit)
    accepts(Computer.UiNode, node)
    accepts(Computer.TreeResult, trees(tree))
    accepts(Computer.SensitiveAskTarget, target)
    accepts(Computer.SensitiveAskMetadata, {
      action: "click",
      why: "paste",
      target,
      targetName: "Coller",
      stepDigest: "a".repeat(64),
    })
  })

  test("a known absent accelerator stays absent rather than inventing a key or root action", () => {
    const noShortcut = { path: ["Fichier", "Enregistrer"] }
    expect(strict(Computer.WindowMenu)(noShortcut)).toEqual(noShortcut)
    expect(Schema.encodeSync(Computer.WindowMenu)({ ...noShortcut, shortcut: undefined })).toEqual(noShortcut)
    accepts(Computer.InspectResult, { ...observed, menu: noShortcut })
    accepts(Computer.HitResult, { ...hit, menu: noShortcut })
    accepts(Computer.SensitiveAskTarget, { ...target, menu: noShortcut })
    rejects(Computer.WindowMenu, { path: [] })
    for (const path of [[""], ["File\n"], ["Save\u202e"], ["x".repeat(257)], Array(31).fill("File")])
      rejects(Computer.WindowMenu, { path })
    for (const shortcut of [[], [""], ["\n"], ["x".repeat(33)], Array(9).fill("Shift")])
      rejects(Computer.WindowMenu, { ...menu, shortcut })
  })

  test("Windows menu evidence cannot be attached to Mac windowless or ordinary window observations", () => {
    rejects(Computer.InspectResult, { ...observed, app: mac })
    rejects(Computer.HitResult, { ...hit, owner: mac })
    rejects(Computer.TreeResult, trees({ ...tree, owner: mac }))
    rejects(Computer.SensitiveAskTarget, { ...target, appKey: "app:macos:test.editor" })
    rejects(Computer.SensitiveAskTarget, { ...target, appKey: "program:windows:" + "a".repeat(64) })
    for (const role of ["Button", "Edit", "AXMenuItem"]) {
      rejects(Computer.InspectResult, { ...observed, element: { ...observed.element, role } })
      rejects(Computer.HitResult, { ...hit, role })
      rejects(Computer.UiNode, { ...node, role })
      rejects(Computer.TreeResult, trees({ ...tree, role }))
    }
    rejects(Computer.InspectResult, { ...observed, scope: "app-menu", menuPath: menu.path })
    rejects(Computer.HitResult, { ...hit, scope: "app-menu", menuPath: menu.path })
    rejects(Computer.UiNode, { ...node, scope: "app-menu", menuPath: menu.path })
    rejects(Computer.SensitiveAskTarget, { ...target, scope: "app-menu", menuPath: menu.path })
  })

  test("menu ownership requires the agreeing actual process and window", () => {
    for (const owner of [
      { ...app, pid: undefined },
      { ...app, pid: 502 },
    ]) {
      rejects(Computer.InspectResult, { ...observed, app: owner })
      rejects(Computer.TreeResult, trees({ ...tree, owner }))
    }
    rejects(Computer.HitResult, { ...hit, owner: { ...app, pid: undefined } })
    for (const key of ["windowId", "elementId", "pid"] as const) {
      rejects(Computer.UiNode, { ...node, [key]: undefined })
      rejects(Computer.TreeResult, trees({ ...tree, [key]: undefined }))
      rejects(Computer.SensitiveAskTarget, { ...target, [key]: undefined })
    }
    rejects(Computer.TreeResult, trees({ ...tree, owner: undefined }))
    rejects(Computer.InspectResult, { ...observed, window: undefined })
    rejects(Computer.HitResult, { ...hit, windowId: undefined })
  })

  test("native element identity is required and the Mac shortcut field cannot cross scopes", () => {
    for (const key of ["ref", "elementId"] as const) {
      rejects(Computer.InspectResult, { ...observed, element: { ...observed.element, [key]: undefined } })
      rejects(Computer.HitResult, { ...hit, [key]: undefined })
      rejects(Computer.SensitiveAskTarget, { ...target, [key]: undefined })
    }
    for (const [schema, value] of [
      [Computer.InspectResult, observed],
      [Computer.HitResult, hit],
      [Computer.UiNode, node],
      [Computer.SensitiveAskTarget, target],
    ] as const)
      rejects(schema, { ...value, menuShortcut: menu.shortcut })
  })
})

// One sample request and at least one sample response for every bridge command.
const bridge: Record<Computer.BridgeCommandName, { request: Record<string, unknown>; responses: unknown[] }> = {
  status: {
    request: {},
    responses: [
      {
        platform: "macos",
        backendVersion: "1.0.0",
        permissions: { screen: "granted", accessibility: "granted" },
        displays: [{ id: "1", name: "Built-in Display", bounds: rect, scale: 2, primary: true }],
        mode: "foreground",
      },
    ],
  },
  acquire: {
    request: { title: "Receipts", wait: true },
    responses: [
      { lease },
      { code: "busy", holder: { title: "Other task" } },
      { code: "permissions", missing: ["screen", "accessibility"] },
    ],
  },
  release: { request: { lease }, responses: [{ ok: true }] },
  access: {
    request: { lease, app: { name: "Numbers" }, liftDeny: true },
    responses: [
      { identity: mac, category: "office", verdict: "ask", canAlways: true, companyAllowed: false, changed: false },
      {
        identity: mac,
        category: "office",
        verdict: "ask",
        canAlways: false,
        alwaysWhyNot: "changed",
        companyAllowed: true,
        changed: true,
        ownBuild: { repo: "receipts" },
      },
      { identity: terminal, category: "terminal", verdict: "never", reason: "terminal" },
      { identity: mac, category: "office", verdict: "blocked", reason: "default" },
      { identity: mac, category: "office", verdict: "company-deny" },
      { identity: mac, category: "office", verdict: "denied" },
      { identity: mac, category: "office", verdict: "granted", level: "interact", via: "task" },
    ],
  },
  grant: { request: { lease, identity: mac, level: "interact", requestID: "per_1" }, responses: [{ ok: true }] },
  remember: { request: { identity: mac, requestID: "per_1" }, responses: [{ saved: true }] },
  listApps: {
    request: { lease, query: "num", installed: false },
    responses: [
      {
        apps: [
          {
            identity: mac,
            name: "Numbers",
            running: true,
            frontmost: false,
            category: "office",
            verdict: "granted",
            windows: [{ id: "42", title: "Receipts", bounds: rect, display: "1" }],
          },
          {
            identity: terminal,
            name: "Terminal",
            running: true,
            frontmost: false,
            category: "terminal",
            verdict: "never",
          },
        ],
      },
    ],
  },
  openApp: {
    request: { lease, app: { path: "/Applications/Numbers.app" }, background: true },
    responses: [{ identity: mac, launched: true }],
  },
  prepareOpen: {
    request: { lease, app: { path: "/Applications/Numbers.app" } },
    responses: [{ kind: "app", identity: mac }],
  },
  focusWindow: {
    request: { lease, app: { key: "app:macos:com.apple.iwork.numbers" }, window: "42" },
    responses: [{ ok: true }],
  },
  screenshot: {
    request: { lease, scope: { app: { name: "Numbers" }, window: "42" }, budget, format: "jpeg" },
    responses: [{ frame, image: jpeg, visible: [mac], hiddenCount: 2, pointer: { x: 10, y: 20 } }],
  },
  zoom: {
    request: { lease, frame: "frame_1", region: { x0: 0, y0: 0, x1: 100, y1: 80 }, budget },
    responses: [{ image: png }],
  },
  inspect: { request: { lease, frame: "frame_1", x: 10, y: 20 }, responses: [inspect] },
  readUi: {
    request: { lease, app: { name: "Numbers" }, query: "save", limit: 50 },
    responses: [{ nodes: [{ ref: "ui_1", role: "button", name: "Save", bounds: rect, enabled: true, secure: false }] }],
  },
  act: {
    request: {
      lease,
      frame: "frame_1",
      steps: [
        { kind: "click", button: "left", count: 1, at: { x: 10, y: 20 }, modifiers: [] },
        { kind: "click", button: "right", count: 2, at: { ref: "ui_4" }, modifiers: ["shift"] },
        { kind: "move", at: { x: 1, y: 1 } },
        { kind: "down", button: "left" },
        {
          kind: "drag",
          path: [
            { x: 1, y: 1 },
            { x: 5, y: 5 },
          ],
          modifiers: [],
        },
        { kind: "scroll", dx: 0, dy: -3 },
        { kind: "type", text: "October receipts", ref: "ui_3" },
        { kind: "key", combo: ["cmd", "s"], repeat: 1 },
        { kind: "wait", ms: 500 },
      ],
      approvals: [{ index: 0, requestID: "per_2" }],
      settleMs: 300,
    },
    responses: [
      { done: 1, frame, image: jpeg, state, pending: { index: 1, kind: "sensitive", why: "send", inspect } },
      { done: 0, state, waiting: { waitId: "wait_1", reason: "pointer" } },
    ],
  },
  handoff: { request: { lease, phase: "start", reason: "sign_in" }, responses: [{ ok: true }] },
  awaitControl: { request: { lease, waitId: "wait_1" }, responses: [{ result: "pending" }, { result: "resumed" }] },
  heartbeat: { request: { lease }, responses: [{ state }] },
  cancel: { request: { lease, requestId: "req_1" }, responses: [{ ok: true }] },
}

// One sample of the arguments and of the result for every helper op.
const helper: Record<Computer.HelperOpName, { args: Record<string, unknown>[]; results: Record<string, unknown>[] }> = {
  hello: {
    args: [{ protocol: { min: 1, max: 1 } }],
    results: [
      {
        protocol: { min: 1, max: 1 },
        helper: { version: "1.0.0", platform: "macos", arch: "arm64", os: "15.0" },
        features: { "ui.tree": true, "capture.window": true, "some.future.feature": true },
        permissions: { screen: "granted", accessibility: "notDetermined" },
        limits: { maxFrameBytes: 16 * 1024 * 1024 },
        responsible: true,
      },
    ],
  },
  "permissions.status": { args: [{}], results: [{ screen: "granted", accessibility: "denied", postEvent: "n/a" }] },
  "permissions.request": { args: [{ service: "screen" }], results: [{ screen: "granted", accessibility: "denied" }] },
  "permissions.reset": {
    args: [{ service: "accessibility" }],
    results: [{ screen: "granted", accessibility: "notDetermined", captureBlocked: false }],
  },
  "input.setup": {
    args: [{ action: "status" }, { action: "start" }, { action: "reset" }],
    results: [
      { state: "needs-calibration", mouse: false, keyboard: false },
      { state: "calibrating", mouse: true, keyboard: false },
      { state: "ready", mouse: true, keyboard: true },
      { state: "unavailable", mouse: false, keyboard: false },
    ],
  },
  "session.begin": {
    args: [
      {
        sessionId: "ses_root",
        mode: "foreground",
        approved: [mac],
        vectorPids: [100, 101],
        vectorWindowIds: ["7"],
        overlayWindowIds: ["8", "9"],
        escStops: true,
        stopChord: "Command+Shift+Escape",
        heartbeatMs: 2000,
      },
    ],
    results: [{}],
  },
  "session.update": { args: [{ approved: [mac], escStops: false }], results: [{}] },
  "session.end": { args: [{}], results: [{}] },
  heartbeat: { args: [{}], results: [{}] },
  "displays.list": {
    args: [{}],
    results: [{ displays: [{ id: "1", bounds: rect, pixelSize: { w: 2880, h: 1800 }, scale: 2, primary: true }] }],
  },
  "cursor.position": { args: [{}], results: [{ x: -700.5, y: -125, displayId: "2" }] },
  "apps.list": {
    args: [{ installed: false }],
    results: [
      {
        apps: [
          {
            identity: mac,
            active: true,
            windows: [{ windowId: "42", title: "Receipts", bounds: rect, minimized: false, onScreen: true }],
          },
        ],
      },
    ],
  },
  "app.activate": { args: [{ identity: mac }], results: [{ foreground: true }] },
  "apps.resolve": {
    args: [{ path: "/Applications/Numbers.app" }],
    results: [
      { kind: "app", identity: mac },
      { kind: "protected", reason: "security" },
    ],
  },
  "program.launch": {
    args: [{ token: "resolve_1", binding: "0".repeat(64) }],
    results: [{ launched: true }],
  },
  "app.launch": {
    args: [{ identity: mac }, { path: "/Applications/Numbers.app" }],
    results: [{}, { foreground: false }],
  },
  "window.focus": { args: [{ windowId: "42" }], results: [{ foreground: true }] },
  capture: {
    args: [
      { target: { windowId: "42" }, budget, format: "jpeg", quality: 80 },
      {
        target: { display: "1" },
        budget,
        format: "png",
        zoom: { captureId: "cap_1", region: { x0: 0, y0: 0, x1: 9, y1: 9 } },
      },
    ],
    results: [
      {
        captureId: "cap_1",
        width: 1440,
        height: 900,
        origin: { x: 0, y: 25 },
        imageScale: 1,
        displayId: "1",
        capturedAtMs: 1_700_000_000_000,
        masked: [{ x: 10, y: 10, w: 100, h: 50 }],
        hiddenCount: 1,
        hash: "0123456789abcdef",
        imageBytes: 20_000,
      },
      { paused: true },
    ],
  },
  "ui.tree": {
    args: [
      { pid: 501, maxNodes: 400, maxDepth: 30 },
      { windowId: "42", maxNodes: 400, maxDepth: 30 },
    ],
    results: [
      {
        generation: 1,
        truncated: false,
        nodes: [
          { ref: "e1", role: "AXButton", name: "Save", bounds: rect, enabled: true, focused: false, secure: false },
        ],
      },
    ],
  },
  "ui.hittest": {
    args: [{ captureId: "cap_1", x: 10, y: 20 }],
    results: [{ role: "AXButton", name: "Save", secure: false, owner: mac, windowId: "42" }],
  },
  "ui.focused": { args: [{}], results: [{ ref: "e2", role: "AXTextField", secure: true, owner: mac, windowId: "42" }] },
  "ui.resolve": {
    args: [{ ref: "e2" }],
    results: [{ ref: "e2", role: "AXTextField", secure: true, owner: mac, windowId: "42" }],
  },
  "ui.perform": { args: [{ ref: "e1", action: "AXPress" }], results: [{ took: true }] },
  "ui.setValue": { args: [{ ref: "e2", value: "October" }], results: [{}] },
  "input.click": {
    args: [{ captureId: "cap_1", x: 10, y: 20, button: "left", count: 1, modifiers: [] }],
    results: [{}],
  },
  "input.move": { args: [{ captureId: "cap_1", x: 10, y: 20 }], results: [{}] },
  "input.drag": {
    args: [
      {
        captureId: "cap_1",
        path: [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
        button: "left",
        modifiers: ["shift"],
      },
    ],
    results: [{}],
  },
  "input.scroll": { args: [{ captureId: "cap_1", x: 10, y: 20, dx: 0, dy: -3 }], results: [{}] },
  "input.key": { args: [{ pid: 501, combo: ["cmd", "s"], repeat: 1 }], results: [{}] },
  "input.type": { args: [{ pid: 501, text: "October" }], results: [{}] },
  "input.hold": { args: [{ pid: 501, combo: ["shift"], ms: 500 }], results: [{}] },
  "input.releaseAll": { args: [{}], results: [{ released: 2 }] },
  "clipboard.read": { args: [{}], results: [{ text: "copied" }] },
  "clipboard.write": { args: [{ text: "pasted" }], results: [{}] },
  cancel: { args: [{}, { target: 3 }], results: [{}] },
  shutdown: { args: [{}], results: [{}] },
}

describe("computer bridge protocol", () => {
  test("every command has a sample", () => {
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(Computer.BridgeCommands).sort())
    expect(Computer.BridgeCommandName.literals.map(String).sort()).toEqual(Object.keys(Computer.BridgeCommands).sort())
  })

  for (const name of Object.keys(Computer.BridgeCommands) as Computer.BridgeCommandName[]) {
    test(`${name}: request and responses decode, and an unknown field is rejected`, () => {
      const schemas = Computer.BridgeCommands[name]
      const sample = bridge[name]
      const request = { ...envelope, command: name, ...sample.request }
      accepts(schemas.request, request)
      accepts(Computer.BridgeRequest, request)
      rejects(schemas.request, { ...request, unexpected: true })
      rejects(Computer.BridgeRequest, { ...request, unexpected: true })
      rejects(schemas.request, { ...request, v: 2 })
      for (const response of sample.responses) {
        accepts(schemas.response, response)
        rejects(schemas.response, { ...(response as object), unexpected: true })
      }
    })
  }

  test("a request with another command's name or no envelope is rejected", () => {
    rejects(Computer.BridgeCommands.release.request, { ...envelope, command: "grant", lease })
    rejects(Computer.BridgeRequest, { command: "release", lease })
    rejects(Computer.BridgeRequest, { ...envelope, command: "hideOverlay" })
  })

  test("queued cancellation needs no lease but still requires its root envelope", () => {
    const queued = { ...envelope, v: Computer.PROTOCOL, command: "cancel" } as const
    expect(strict(Computer.BridgeRequest)(queued)).toEqual(queued)
    expect(Schema.encodeSync(Computer.BridgeCommands.cancel.request)({ ...queued, lease: undefined })).toEqual(queued)
    accepts(Computer.BridgeCommands.cancel.request, { ...queued, lease })
    rejects(Computer.BridgeCommands.cancel.request, { command: "cancel" })
    rejects(Computer.BridgeCommands.cancel.request, { ...queued, rootSessionID: "" })
    rejects(Computer.BridgeCommands.cancel.request, { ...queued, lease: 0 })
  })

  test("a program path is resolved through access before an approved launch", () => {
    const app = { path: "/Applications/Numbers.app" }
    accepts(Computer.BridgeRequest, { ...envelope, command: "access", lease, app })
    accepts(Computer.BridgeRequest, { ...envelope, command: "openApp", lease, app, requestID: "per_launch" })
    rejects(Computer.BridgeRequest, { ...envelope, command: "openApp", lease, app, requestID: "" })
    rejects(Computer.BridgeRequest, { ...envelope, command: "access", lease, app: { ...app, approved: true } })
    const request = { ...envelope, v: 1 as const, command: "openApp" as const, lease, app }
    expect(Schema.encodeSync(Computer.BridgeCommands.openApp.request)({ ...request, requestID: undefined })).toEqual(
      request,
    )
  })

  test("inspect carries bounded desktop observations for key and program checks", () => {
    accepts(Computer.InspectResult, inspect)
    const observed = {
      ...inspect,
      clipboard: { agentOwned: false, text: "October receipts" },
      layout: { platform: "macos", keys: { KeyQ: { key: "a", shift: "A" }, KeyS: "s" } },
      focusedMenuShortcuts: [{ combo: ["cmd", "s"], label: "Save" }],
      programPath: "/Applications/Numbers.app",
    }
    accepts(Computer.InspectResult, observed)
    rejects(Computer.InspectResult, { ...observed, layout: { ...observed.layout, platform: "linux" } })
    rejects(Computer.InspectResult, { ...observed, clipboard: { agentOwned: false, text: "x".repeat(4001) } })
    rejects(Computer.InspectResult, {
      ...observed,
      focusedMenuShortcuts: Array(129).fill(observed.focusedMenuShortcuts[0]),
    })
    rejects(Computer.InspectResult, {
      ...observed,
      layout: {
        platform: "macos",
        keys: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`Key${index}`, "a"])),
      },
    })
  })

  test("nested unknown fields are rejected too", () => {
    const grant = { ...envelope, command: "grant", lease, level: "interact", requestID: "per_1" }
    rejects(Computer.BridgeRequest, { ...grant, identity: { ...mac, granted: true } })
    rejects(Computer.BridgeCommands.act.request, {
      ...envelope,
      command: "act",
      lease,
      steps: [{ kind: "wait", ms: 10, approved: true }],
      settleMs: 0,
    })
  })

  test("a full batch retains independent app, destination, action and three provider proofs within a bounded body", () => {
    const request = {
      ...envelope,
      command: "act",
      lease,
      settleMs: 0,
      steps: Array.from({ length: 10 }, () => ({ kind: "wait", ms: 0 })),
      approvals: Array.from({ length: 10 }, (_, index) =>
        ["app", "destination", "send", "provider1", "provider2", "provider3"].map((reason) => ({
          index,
          requestID: `per_${index}_${reason}`,
        })),
      ).flat(),
    }
    accepts(Computer.BridgeCommands.act.request, request)
    rejects(Computer.BridgeCommands.act.request, {
      ...request,
      approvals: Array.from({ length: 161 }, (_, index) => ({ index: 0, requestID: `per_${index}` })),
    })
  })

  test("steps are bounded", () => {
    const act = (steps: unknown[]) => ({ ...envelope, command: "act", lease, steps, settleMs: 0 })
    const wait = { kind: "wait", ms: 1 }
    rejects(Computer.BridgeRequest, act([]))
    accepts(Computer.BridgeRequest, act(Array.from({ length: 10 }, () => wait)))
    rejects(Computer.BridgeRequest, act(Array.from({ length: 11 }, () => wait)))
    rejects(
      Computer.BridgeRequest,
      act([{ kind: "click", button: "left", count: 1, at: { ref: "#save" }, modifiers: [] }]),
    )
    rejects(Computer.BridgeRequest, act([{ kind: "type", text: "x".repeat(4001) }]))
  })

  test("capabilities and the 409 body decode", () => {
    accepts(Computer.Capabilities, {
      protocol: 1,
      available: true,
      backend: "local-macos",
      actions: ["screenshot", "click", "read_ui"],
      features: { background: true, uiTree: true, zoom: true, clipboard: false, locked: false },
    })
    accepts(Computer.Capabilities, {
      protocol: 1,
      available: false,
      reason: "permissions",
      backend: "fake",
      actions: [],
      features: { background: false, uiTree: false, zoom: false, clipboard: false, locked: false },
    })
    // Locked use is deferred: no capability can claim it.
    rejects(Computer.Capabilities, {
      protocol: 1,
      available: true,
      backend: "local-windows",
      actions: [],
      features: { background: false, uiTree: true, zoom: true, clipboard: true, locked: true },
    })
    accepts(Computer.BridgeFailure, { ok: false, code: "not_granted", error: "Numbers is not allowed for this task." })
    rejects(Computer.BridgeFailure, { ok: false, code: "nope", error: "x" })
  })
})

describe("computer helper protocol", () => {
  test("every op has a sample", () => {
    expect(Object.keys(helper).sort()).toEqual(Object.keys(Computer.HelperOps).sort())
  })

  for (const name of Object.keys(Computer.HelperOps) as Computer.HelperOpName[]) {
    test(`${name}: request and response frames decode, and an unknown field is rejected`, () => {
      const request = Computer.helperRequest(name)
      const response = Computer.helperResponse(name)
      for (const args of helper[name].args) {
        const frame = { id: 1, op: name, ...args }
        accepts(request, frame)
        rejects(request, { ...frame, unexpected: true })
        rejects(request, { ...frame, op: "shutdown_now" })
      }
      for (const result of helper[name].results) {
        const frame = { id: 1, ok: true, ...result }
        accepts(response, frame)
        rejects(response, { ...frame, unexpected: true })
      }
    })
  }

  test("failures and events decode", () => {
    accepts(Computer.HelperFailure, { id: 4, ok: false, code: "frame_too_large", error: "too large" })
    for (const event of [
      { event: "user_input", kind: "pointer", dx: 9, dy: 0 },
      { event: "user_input", kind: "key" },
      { event: "stop", by: "chord" },
      { event: "input_detection", alive: false, reason: "secure_input", holder: "Safari" },
      { event: "locked", locked: true },
      { event: "display_change" },
      { event: "exit", code: 1 },
    ])
      accepts(Computer.HelperEvent, event)
    rejects(Computer.HelperEvent, { event: "user_input", kind: "key", key: "a" })
    rejects(Computer.HelperEvent, { event: "hide_overlay" })
  })

  test("session.begin pins the heartbeat", () => {
    const begin = { id: 1, op: "session.begin", ...helper["session.begin"].args[0] }
    rejects(Computer.helperRequest("session.begin"), { ...begin, heartbeatMs: 60_000 })
  })
})

describe("app keys", () => {
  test("appKey lowercases and round-trips through parseAppKey", () => {
    const cases: [Computer.AppIdentity, string, string[]][] = [
      [
        {
          platform: "macos",
          bundleId: "com.Apple.iWork.Numbers",
          apple: true,
          system: false,
          verified: true,
          name: "Numbers",
        },
        "app:macos:com.apple.iwork.numbers",
        ["com.apple.iwork.numbers"],
      ],
      [
        {
          platform: "windows",
          kind: "aumid",
          aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
          system: false,
          verified: true,
          name: "Calculator",
        },
        "app:windows:aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app",
        ["aumid", "microsoft.windowscalculator_8wekyb3d8bbwe!app"],
      ],
      [
        {
          platform: "windows",
          kind: "exe",
          publisher: "Microsoft Corporation",
          product: "Microsoft Excel",
          binary: "EXCEL.EXE",
          system: false,
          verified: true,
          name: "Excel",
          exe: "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE",
        },
        "app:windows:exe:microsoft corporation|microsoft excel|excel.exe",
        ["exe", "microsoft corporation", "microsoft excel", "excel.exe"],
      ],
      [{ platform: "remote", id: "Box-1", name: "Cloud computer", verified: false }, "app:remote:box-1", ["box-1"]],
    ]
    for (const [identity, key, parts] of cases) {
      accepts(Computer.AppIdentity, identity)
      expect(Computer.appKey(identity)).toBe(key)
      expect(Computer.parseAppKey(key)).toEqual({ platform: identity.platform, parts })
      accepts(Computer.AppKey, key)
    }
  })

  test("a Windows exe identity without a signer keys as unsigned", () => {
    const exe = {
      platform: "windows",
      kind: "exe",
      product: "Tool",
      binary: "Tool.exe",
      system: false,
      name: "Tool",
      exe: "C:\\Tools\\Tool.exe",
    } as const
    expect(Computer.appKey({ ...exe, publisher: "", verified: false })).toBe("app:windows:exe:unsigned|tool|tool.exe")
    // A publisher name that no verified signature backs is not trusted either.
    expect(Computer.appKey({ ...exe, publisher: "Microsoft Corporation", verified: false })).toBe(
      "app:windows:exe:unsigned|tool|tool.exe",
    )
    expect(Computer.appKey({ ...exe, publisher: "Contoso Ltd", verified: true })).toBe(
      "app:windows:exe:contoso ltd|tool|tool.exe",
    )
  })

  test("the key never includes the Team ID or signer verification state", () => {
    const base = { platform: "macos", bundleId: "com.contoso.app", apple: false, system: false, name: "App" } as const
    expect(Computer.appKey({ ...base, teamId: "ABCDE12345", verified: true })).toBe(
      Computer.appKey({ ...base, teamId: "ZZZZZ99999", verified: false }),
    )
  })

  test("exe keys stay unambiguous when a part contains the separator", () => {
    const exe = (publisher: string, product: string) =>
      Computer.appKey({
        platform: "windows",
        kind: "exe",
        publisher,
        product,
        binary: "d.exe",
        system: false,
        verified: true,
        name: "D",
        exe: "C:\\d.exe",
      })
    expect(exe("A", "B|C")).not.toBe(exe("A|B", "C"))
    expect(Computer.parseAppKey(exe("A", "B|C"))).toEqual({ platform: "windows", parts: ["exe", "a", "b|c", "d.exe"] })
  })

  test("parseAppKey rejects anything appKey would not make", () => {
    for (const key of [
      "",
      "app:",
      "app:macos:",
      "App:macos:com.apple.finder",
      "app:macos:Com.Apple.Finder",
      "app:linux:x",
      "app:windows:exe:a|b",
      "app:windows:exe:|b|c.exe",
      "app:windows:aumid:",
      "app:macos:com.apple.finder\u202e",
      "com.apple.finder",
    ])
      expect(Computer.parseAppKey(key)).toBeUndefined()
  })
})

describe("asks, markers and tool input", () => {
  test("ask metadata decodes and the agent's words cannot carry control or bidi characters", () => {
    const ask = {
      action: "use_app",
      level: "interact",
      target: {
        appName: "Numbers",
        appKey: "app:macos:com.apple.iwork.numbers",
        platform: "macos",
        publisher: "Apple Inc.",
        verified: true,
        category: "office",
      },
      canAlways: true,
      mentioned: true,
      reason: "Fill the table from your receipts",
    }
    accepts(Computer.AppAskMetadata, ask)
    rejects(Computer.AppAskMetadata, { ...ask, reason: "Fill\u202e the table" })
    rejects(Computer.AppAskMetadata, { ...ask, reason: "x".repeat(201) })
    rejects(Computer.AppAskMetadata, { ...ask, approved: true })
    expect(Computer.clean("Fill\u202e the\ntable\u0007 now", 200)).toBe("Fill the table now")
    expect(Array.from(Computer.clean("x".repeat(500), 200))).toHaveLength(200)

    const sensitive = {
      action: "click",
      why: "send",
      target: { appName: "Mail", appKey: "app:macos:com.apple.mail" },
      targetName: "Send",
      stepIndex: 1,
    }
    accepts(Computer.SensitiveAskMetadata, sensitive)
    accepts(Computer.SensitiveAskMetadata, { ...sensitive, stepDigest: "a".repeat(64) })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, stepDigest: "a".repeat(63) })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, stepDigest: "z".repeat(64) })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, targetName: "x".repeat(41) })
    rejects(Computer.SensitiveAskMetadata, { ...sensitive, always: ["app:macos:com.apple.mail"] })

    accepts(Computer.HandoffQuestionMetadata, { computer: { kind: "handoff", app: "Numbers", reason: "sign_in" } })
    accepts(Computer.CheckInQuestionMetadata, { computer: { kind: "check_in", actions: 300, minutes: 12 } })
  })

  test("a mention marker carries no grant field", () => {
    const part = {
      type: "text",
      text: "",
      synthetic: true,
      metadata: { [Computer.MENTION_KEY]: { kind: "app", key: "app:macos:com.apple.iwork.numbers", name: "Numbers" } },
    }
    accepts(Computer.MentionPart, part)
    accepts(Computer.MentionMarker, { kind: "feature" })
    rejects(Computer.MentionMarker, {
      kind: "app",
      key: "app:macos:com.apple.iwork.numbers",
      name: "Numbers",
      granted: true,
    })
    rejects(Computer.MentionMarker, { kind: "feature", level: "interact" })
    rejects(Computer.MentionPart, { ...part, text: "@Numbers" })
    expect(Computer.MENTION_KEY).toBe("vector.computer.mention")
  })

  test("part metadata decodes", () => {
    accepts(Computer.ComputerPartMetadata, {
      action: "click",
      app: { key: "app:macos:com.apple.iwork.numbers", name: "Numbers" },
      target: { role: "button", name: "Save" },
      point: { x: 10, y: 20 },
      frame: { id: "frame_1", width: 1440, height: 900, hash: "0123456789abcdef" },
      screenshot: true,
      intent: "Save the sheet",
    })
    accepts(Computer.ComputerPartMetadata, { action: "type", text: { length: 12, preview: "October rec" } })
    accepts(Computer.ComputerPartMetadata, { action: "click", blocked: { reason: "terminal" }, code: "blocked" })
    rejects(Computer.ComputerPartMetadata, { action: "type", text: { length: 12, preview: "x".repeat(61) } })
  })

  test("tool input follows section 2.7", () => {
    accepts(Computer.ToolInput, { action: "screenshot" })
    accepts(Computer.ToolInput, { action: "click", x: 10, y: 20, intent: "Open the File menu" })
    accepts(Computer.ToolInput, { action: "hold_key", keys: "shift", seconds: 10 })
    rejects(Computer.ToolInput, { action: "hold_key", keys: "shift", seconds: 11 })
    accepts(Computer.ToolInput, { action: "wait", seconds: 30 })
    rejects(Computer.ToolInput, { action: "wait", seconds: 31 })
    rejects(Computer.ToolInput, { action: "type", text: "x".repeat(4001) })
    rejects(Computer.ToolInput, { action: "drag", path: [{ x: 1, y: 1 }] })
    accepts(Computer.ToolInput, {
      action: "click",
      x: 1,
      y: 1,
      actions: [
        { action: "type", text: "hi" },
        { action: "key", keys: "enter" },
      ],
    })
    // A batch never holds handoff or a nested batch.
    rejects(Computer.ToolInput, { action: "click", actions: [{ action: "handoff", reason: "sign in" }] })
    rejects(Computer.ToolInput, { action: "click", actions: [{ action: "click", actions: [] }] })
    rejects(Computer.ToolInput, {
      action: "click",
      actions: Array.from({ length: 11 }, () => ({ action: "wait", seconds: 1 })),
    })
    expect(Computer.BATCH_FAILURE).toBe("Not executed: an earlier computer action in this turn failed.")
  })

  test("state decodes and holds only Vector-built text", () => {
    accepts(Computer.ComputerState, state)
    accepts(Computer.ComputerState, {
      ...state,
      phase: "asking",
      ask: {
        requestID: "per_1",
        directory: "/Users/me/project",
        kind: "app",
        title: "Allow Vector Hands to use Numbers?",
        canAlways: false,
        shownAt: 1,
      },
    })
    rejects(Computer.ComputerState, { ...state, step: "Clicking\u202e Save" })
    rejects(Computer.ComputerState, { ...state, intent: "model text" })
  })
})
