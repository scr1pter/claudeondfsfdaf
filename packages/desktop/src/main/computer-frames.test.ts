import { expect, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { createComputerFrames, imageMime } from "./computer-frames"
import type { GrantScope } from "./computer-grants"
import { encodePng } from "../../test/computer/png"

const APP: Computer.AppIdentity = {
  platform: "macos",
  bundleId: "example.Writer",
  teamId: "TEAM123456",
  verified: true,
  apple: false,
  system: false,
  name: "Writer",
  pid: 20,
  path: "/Applications/Writer.app",
}
const SCOPE: GrantScope = { rootSessionID: "root", sessionID: "root", directory: "/repo", lease: 1 }
const PHASE = { sessionId: "native-task", phaseRevision: 1 }
const NATIVE = { x: -2000, y: 40, w: 100, h: 80 }

function fixture(
  platform: "macos" | "windows" = "macos",
  toDip?: (rect: Computer.Rect, displayId: string) => Computer.Rect,
) {
  const state = {
    scope: { ...SCOPE },
    identity: structuredClone(APP) as Computer.AppIdentity,
    phase: { ...PHASE },
    bounds: { ...NATIVE },
    appsWait: undefined as Promise<void> | undefined,
    resolveWait: undefined as Promise<void> | undefined,
    appReads: 0,
    displayReads: 0,
    hit: {
      ref: "native_1",
      elementId: "element_1",
      role: "AXTextField",
      name: "Title",
      secure: false,
      enabled: true,
      editable: true,
      owner: APP,
      windowId: "window",
    } as Computer.HitResult,
  }
  const backend = {
    async apps(): Promise<Computer.HelperApp[]> {
      state.appReads++
      await state.appsWait
      return [
        {
          identity: state.identity,
          active: true,
          windows: [
            { windowId: "window", title: "Document", bounds: { ...state.bounds }, minimized: false, onScreen: true },
          ],
        },
      ]
    },
    async displays(): Promise<Computer.DisplayInfo[]> {
      state.displayReads++
      return [
        {
          id: "display",
          bounds: { ...state.bounds },
          pixelSize: { w: state.bounds.w, h: state.bounds.h },
          scale: 1,
          primary: true,
        },
      ]
    },
    async resolveRef(ref: string) {
      await state.resolveWait
      if (ref !== state.hit.ref) throw Object.assign(new Error("changed"), { code: "stale_ref" })
      return structuredClone(state.hit)
    },
  }
  const registry = createComputerFrames({
    platform,
    backend,
    toDip,
    phase: (scope) => (JSON.stringify(scope) === JSON.stringify(state.scope) ? { ...state.phase } : undefined),
  })
  const capture = (scale = 0.5, masked: Computer.Rect[] = []) => {
    const width = Math.round(NATIVE.w * scale),
      height = Math.round(NATIVE.h * scale)
    const bytes = encodePng({ width, height, rgba: new Uint8Array(width * height * 4) })
    const header: Computer.CaptureHeader = {
      captureId: "native_capture",
      width,
      height,
      origin: { x: NATIVE.x, y: NATIVE.y },
      imageScale: scale,
      displayId: "display",
      capturedAtMs: 1000,
      masked,
      hiddenCount: masked.length ? 1 : 0,
      hash: "0000000000000000",
      imageBytes: bytes.length,
    }
    return { header, bytes, target: { windowId: "window" }, approved: [APP], phase: { ...state.phase } }
  }
  const tree = (generation = 1): Computer.TreeResult => ({
    generation,
    truncated: false,
    nodes: [
      {
        ref: "native_1",
        role: "AXTextField",
        name: "Title",
        value: "Document",
        bounds: { x: -1975, y: 50, w: 20, h: 10 },
        enabled: true,
        focused: false,
        secure: false,
      },
      {
        ref: "native_password",
        role: "AXTextField",
        name: "Password",
        value: "never exported",
        bounds: { x: -1970, y: 60, w: 20, h: 10 },
        enabled: true,
        focused: false,
        secure: false,
      },
    ],
  })
  return { registry, state, capture, tree }
}

const menuHit = (): Extract<Computer.HitResult, { scope: "app-menu" }> => ({
  scope: "app-menu",
  pid: 20,
  owner: { ...APP, platform: "macos", pid: 20 },
  ref: "native_menu",
  elementId: "menu_element",
  menuPath: ["File", "New"],
  role: "AXMenuItem",
  name: "New",
  secure: false,
  enabled: true,
  editable: false,
  bounds: { x: -1980, y: 43, w: 25, h: 16 },
})
const menuTree = (hit = menuHit()): Computer.TreeResult => ({
  generation: 1,
  truncated: false,
  nodes: [
    {
      scope: "app-menu",
      pid: hit.pid,
      ref: hit.ref,
      elementId: hit.elementId,
      menuPath: [...hit.menuPath],
      ...(hit.menuShortcut === undefined ? {} : { menuShortcut: [...hit.menuShortcut] }),
      role: hit.role,
      name: hit.name ?? "",
      secure: hit.secure,
      enabled: true,
      focused: true,
      ...(hit.bounds ? { bounds: hit.bounds } : {}),
    },
  ],
})

const WINDOWS_APP: Computer.AppIdentity = {
  platform: "windows",
  kind: "aumid",
  aumid: "Example.Writer_fixture!App",
  publisher: "Fixture Publisher",
  system: false,
  verified: true,
  name: "Writer",
  pid: 20,
  exe: "C:\\Programs\\Writer\\writer.exe",
}
type WindowHit = Exclude<Computer.HitResult, { readonly scope: "app-menu" }>
const windowsMenuHit = (): WindowHit => ({
  scope: "window",
  owner: structuredClone(WINDOWS_APP),
  windowId: "window",
  ref: "native_windows_menu",
  elementId: "windows_menu_element",
  role: "MenuItem",
  name: "Save",
  secure: false,
  enabled: true,
  editable: false,
  menu: { path: ["File", "Save"], shortcut: ["Control", "s"] },
})
const windowsMenuTree = (hit = windowsMenuHit()): Computer.TreeResult => ({
  generation: 1,
  truncated: false,
  nodes: [
    {
      scope: "window",
      owner: hit.owner.platform === "windows" ? structuredClone(hit.owner) : undefined,
      pid: hit.owner.platform === "windows" ? hit.owner.pid : undefined,
      windowId: hit.windowId,
      ref: hit.ref!,
      elementId: hit.elementId,
      role: hit.role,
      name: hit.name ?? "",
      secure: hit.secure,
      enabled: true,
      focused: true,
      bounds: { x: -1980, y: 43, w: 25, h: 16 },
      menu: structuredClone(hit.menu!),
    },
  ],
})

test("Windows menu nodes retain real window owner witnesses and mint private refs without inventing a frame", async () => {
  const fake = fixture("windows")
  fake.state.hit = windowsMenuHit()
  const node = fake.registry.tree(SCOPE, windowsMenuTree())[0]!
  expect(node).toMatchObject({
    pid: 20,
    windowId: "window",
    elementId: "windows_menu_element",
    menu: { path: ["File", "Save"], shortcut: ["Control", "s"] },
  })
  expect(node.ref).not.toBe("native_windows_menu")
  expect(node).not.toHaveProperty("menuPath")
  expect(node).not.toHaveProperty("menuShortcut")
  expect(node).not.toHaveProperty("bounds")
  expect(fake.registry.uiRef(SCOPE, fake.state.hit)).toBe(node.ref)
  expect(await fake.registry.resolve(SCOPE, node.ref)).toMatchObject({ windowId: "window", ref: "native_windows_menu" })
})

test("Windows menu owner path signer process window element and complete menu facts bind the private receipt", async () => {
  const changes: ((hit: WindowHit) => WindowHit)[] = [
    (hit) => ({ ...hit, owner: { ...WINDOWS_APP, publisher: "Different Publisher" } }),
    (hit) => ({ ...hit, owner: { ...WINDOWS_APP, aumid: "EXAMPLE.Writer_fixture!App" } }),
    (hit) => ({ ...hit, owner: { ...WINDOWS_APP, exe: "C:\\Other\\writer.exe" } }),
    (hit) => ({ ...hit, owner: { ...WINDOWS_APP, pid: 21 } }),
    (hit) => ({ ...hit, owner: { ...WINDOWS_APP, verified: false } }),
    (hit) => ({ ...hit, windowId: "another_window" }),
    (hit) => ({ ...hit, elementId: "another_element" }),
    (hit) => ({ ...hit, menu: { ...hit.menu!, path: ["Message", "Save"] } }),
    (hit) => ({ ...hit, menu: { ...hit.menu!, shortcut: ["Control", "r"] } }),
    (hit) => ({ ...hit, menu: { ...hit.menu!, shortcut: ["s", "Control"] } }),
    (hit) => ({ ...hit, menu: { path: [...hit.menu!.path] } }),
    (hit) => ({ ...hit, menu: undefined }),
  ]
  for (const change of changes) {
    const fake = fixture("windows")
    const original = windowsMenuHit()
    fake.state.hit = original
    const id = fake.registry.uiRef(SCOPE, original)!
    fake.state.hit = change(original)
    expect(await fake.registry.resolve(SCOPE, id).catch((error) => error)).toMatchObject({ code: "stale_ref" })
    fake.state.hit = original
    expect(await fake.registry.resolve(SCOPE, id).catch((error) => error)).toMatchObject({ code: "stale_ref" })
    expect(fake.registry.uiRef(SCOPE, original)).not.toBe(id)
  }
})

test("public and helper-returned Windows menu arrays cannot rewrite private ancestry or shortcut witnesses", async () => {
  const fake = fixture("windows")
  fake.state.hit = windowsMenuHit()
  const tree = windowsMenuTree()
  const node = fake.registry.tree(SCOPE, tree)[0]!
  if (node.scope === "app-menu" || !node.menu) throw new Error("Expected a Windows menu")
  ;(node.menu.path as string[])[0] = "Changed public path"
  ;(node.menu.shortcut as string[])[0] = "Alt"
  const native = tree.nodes[0]!
  if (native.scope === "app-menu" || !native.menu) throw new Error("Expected native window menu")
  ;(native.menu.path as string[])[1] = "Changed source array"
  expect(await fake.registry.resolve(SCOPE, node.ref)).toMatchObject({
    menu: { path: ["File", "Save"], shortcut: ["Control", "s"] },
  })
})

test("Windows menu refs cannot move between ordinary window app-menu or another task scope", async () => {
  const fake = fixture("windows")
  const original = windowsMenuHit()
  fake.state.hit = original
  const id = fake.registry.uiRef(SCOPE, original)!
  fake.state.hit = { ...original, menu: undefined, role: "Button" }
  expect(await fake.registry.resolve(SCOPE, id).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  fake.state.hit = original
  const fresh = fake.registry.uiRef(SCOPE, original)!
  fake.state.hit = { ...menuHit(), ref: original.ref!, elementId: original.elementId! }
  expect(await fake.registry.resolve(SCOPE, fresh).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  fake.state.hit = original
  const scoped = fake.registry.uiRef(SCOPE, original)!
  fake.state.scope = { ...SCOPE, lease: 2 }
  expect(await fake.registry.resolve(fake.state.scope, scoped).catch((error) => error)).toMatchObject({
    code: "stale_ref",
  })
})

test("an ordinary public ref never upgrades into observed Windows menu authority", async () => {
  const fake = fixture("windows")
  const original = windowsMenuHit()
  fake.state.hit = { ...original, menu: undefined, role: "Button" }
  const id = fake.registry.uiRef(SCOPE, fake.state.hit)!
  fake.state.hit = original
  expect(await fake.registry.resolve(SCOPE, id).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  expect(fake.registry.uiRef(SCOPE, original)).not.toBe(id)
})

test("Windows menu tree witnesses cannot be omitted borrowed from another frame or used on macOS", async () => {
  const fake = fixture("windows", (rect) => rect)
  fake.state.identity = WINDOWS_APP
  const frame = await fake.registry.add(SCOPE, { ...fake.capture(), approved: [WINDOWS_APP] })
  for (const change of [
    { owner: undefined },
    { pid: 21 },
    { windowId: undefined },
    { elementId: undefined },
    { menu: { path: [] } },
    { menu: { path: ["File", ""] } },
  ]) {
    const tree = windowsMenuTree()
    expect(() => fake.registry.tree(SCOPE, { ...tree, nodes: [{ ...tree.nodes[0]!, ...change }] })).toThrow()
  }
  const other = windowsMenuHit()
  expect(() => fake.registry.tree(SCOPE, windowsMenuTree({ ...other, windowId: "unrelated" }), frame.frame)).toThrow()
  const mac = fixture()
  expect(() => mac.registry.tree(SCOPE, windowsMenuTree())).toThrow()
})

test("only fresh unchanged native Windows menu resolution promotes an existing receipt across a stable phase", async () => {
  const fake = fixture("windows")
  fake.state.hit = windowsMenuHit()
  const id = fake.registry.uiRef(SCOPE, fake.state.hit)!
  const pending = Promise.withResolvers<void>()
  fake.state.resolveWait = pending.promise
  const result = fake.registry.resolve(SCOPE, id).catch((error) => error)
  fake.state.phase.phaseRevision++
  pending.resolve()
  expect(await result).toMatchObject({ code: "stale_ref" })
  // The raced attempt grants nothing; only an explicit unchanged resolve in a stable phase promotes it.
  expect(await fake.registry.resolve(SCOPE, id)).toMatchObject({ menu: { path: ["File", "Save"] } })
  const fresh = fake.registry.uiRef(SCOPE, fake.state.hit)!
  expect(fresh).toBe(id)
  fake.state.phase.phaseRevision++
  expect(await fake.registry.resolve(SCOPE, fresh)).toMatchObject({ menu: { path: ["File", "Save"] } })
  expect(fake.registry.uiRef(SCOPE, fake.state.hit)).toBe(fresh)
})

test("app-menu nodes retain native scope and identity without projecting bounds through a random frame", async () => {
  const fake = fixture()
  const capture = await fake.registry.add(SCOPE, fake.capture(2))
  fake.state.hit = menuHit()
  const node = fake.registry.tree(SCOPE, menuTree(), capture.frame)[0]!
  expect(node).toMatchObject({ scope: "app-menu", pid: 20, elementId: "menu_element", menuPath: ["File", "New"] })
  expect(node).not.toHaveProperty("bounds")
  expect(node).not.toHaveProperty("windowId")
  expect(fake.registry.uiRef(SCOPE, fake.state.hit)).toBe(node.ref)
  expect(await fake.registry.resolve(SCOPE, node.ref)).toMatchObject({ scope: "app-menu", bounds: menuHit().bounds })
})

test("menu-only reads do not require any capture and ignore an unrelated unavailable frame", () => {
  const fake = fixture()
  const unrelated = { id: "never-recorded" } as Computer.Frame
  const nodes = fake.registry.tree(SCOPE, menuTree(), unrelated)
  expect(nodes[0]).toMatchObject({ scope: "app-menu" })
  expect(nodes[0]).not.toHaveProperty("bounds")
  expect(() => fake.registry.tree(SCOPE, fake.tree(), unrelated)).toThrow()
})

test("menu hit coordinates require the latest full display frame and actual unchanged display geometry", async () => {
  const fake = fixture()
  const window = await fake.registry.add(SCOPE, fake.capture())
  expect(await fake.registry.current(SCOPE, window.frame, menuHit())).toBe(false)
  const display = await fake.registry.add(SCOPE, { ...fake.capture(), target: { display: "display" } })
  const appReads = fake.state.appReads
  expect(await fake.registry.current(SCOPE, display.frame, menuHit())).toBe(true)
  expect(fake.state.appReads).toBe(appReads)
  expect(await fake.registry.current(SCOPE, { ...display.frame, scope: "window" }, menuHit())).toBe(false)
  expect(await fake.registry.current(SCOPE, { ...display.frame, image: { w: 10, h: 10 } }, menuHit())).toBe(false)
  expect(
    await fake.registry.current(SCOPE, { ...display.frame, bounds: { ...display.frame.bounds, x: 0 } }, menuHit()),
  ).toBe(false)
  const next = await fake.registry.add(SCOPE, { ...fake.capture(), target: { display: "display" } })
  expect(await fake.registry.current(SCOPE, display.frame, menuHit())).toBe(false)
  fake.state.bounds.x++
  expect(await fake.registry.current(SCOPE, next.frame, menuHit())).toBe(false)
})

test("a display menu hit cannot survive a native phase change", async () => {
  const fake = fixture()
  const display = await fake.registry.add(SCOPE, { ...fake.capture(), target: { display: "display" } })
  fake.state.phase.phaseRevision++
  expect(await fake.registry.current(SCOPE, display.frame, menuHit())).toBe(false)
})

test("an old public menu ref cannot become a window ref with the same native token", async () => {
  const fake = fixture()
  fake.state.hit = menuHit()
  const node = fake.registry.tree(SCOPE, menuTree())[0]!
  fake.state.hit = {
    ref: "native_menu",
    elementId: "menu_element",
    role: "AXButton",
    secure: false,
    owner: APP,
    windowId: "window",
  }
  expect(await fake.registry.resolve(SCOPE, node.ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  expect(() => fake.registry.uiRef(SCOPE, fake.state.hit)).toThrow()
})

test("an old public window ref cannot become an app-menu ref", async () => {
  const fake = fixture()
  const ref = fake.registry.uiRef(SCOPE, fake.state.hit)!
  fake.state.hit = { ...menuHit(), ref: "native_1", elementId: "element_1" }
  expect(await fake.registry.resolve(SCOPE, ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
})

test("menu PID, ancestry and stable element identity each bind public ref resolution", async () => {
  for (const change of [
    (hit: ReturnType<typeof menuHit>) => ({ ...hit, pid: 21, owner: { ...hit.owner, pid: 21 } }),
    (hit: ReturnType<typeof menuHit>) => ({ ...hit, menuPath: ["File", "Delete"] }),
    (hit: ReturnType<typeof menuHit>) => ({ ...hit, elementId: "another_element" }),
  ]) {
    const fake = fixture()
    fake.state.hit = menuHit()
    const ref = fake.registry.uiRef(SCOPE, fake.state.hit)!
    fake.state.hit = change(menuHit())
    expect(await fake.registry.resolve(SCOPE, ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
    expect(() => fake.registry.uiRef(SCOPE, fake.state.hit)).toThrow()
  }
})

test("public menu path mutations cannot rewrite the private observed path", async () => {
  const fake = fixture()
  fake.state.hit = menuHit()
  const node = fake.registry.tree(SCOPE, menuTree())[0]!
  if (node.scope !== "app-menu") throw new Error("Expected an app menu")
  const exposedPath = node.menuPath as string[]
  exposedPath[0] = "Changed by consumer"
  expect((await fake.registry.resolve(SCOPE, node.ref)).scope).toBe("app-menu")
  expect(await fake.registry.resolve(SCOPE, node.ref)).toMatchObject({ menuPath: ["File", "New"] })
})

test("only an explicit unchanged receipt resolution promotes a menu ref across a stable phase", async () => {
  const fake = fixture()
  fake.state.hit = menuHit()
  const old = fake.registry.uiRef(SCOPE, fake.state.hit)!
  const gate = Promise.withResolvers<void>()
  fake.state.resolveWait = gate.promise
  const pending = fake.registry.resolve(SCOPE, old).catch((error) => error)
  fake.state.phase.phaseRevision++
  gate.resolve()
  expect(await pending).toMatchObject({ code: "stale_ref" })
  expect(await fake.registry.resolve(SCOPE, old)).toMatchObject({ scope: "app-menu", ref: "native_menu" })
  expect(fake.registry.uiRef(SCOPE, fake.state.hit)).toBe(old)
})

test("Windows and mismatched native menu owners cannot mint menu authority", () => {
  const windows = fixture("windows")
  expect(() => windows.registry.tree(SCOPE, menuTree())).toThrow()
  expect(() => windows.registry.uiRef(SCOPE, menuHit())).toThrow()
  const mac = fixture()
  expect(() => mac.registry.uiRef(SCOPE, { ...menuHit(), pid: 21 })).toThrow()
})

test("localized menu shortcut observations remain public data but bind the private receipt exactly", async () => {
  for (const replacement of [["Command", "v"], ["s", "Command"], ["command", "s"], undefined]) {
    const fake = fixture()
    const original = {
      ...menuHit(),
      name: "Enregistrer",
      menuPath: ["Fichier", "Enregistrer"],
      menuShortcut: ["Command", "s"],
    }
    fake.state.hit = original
    const node = fake.registry.tree(SCOPE, menuTree(original))[0]!
    expect(node).toMatchObject({ scope: "app-menu", menuShortcut: ["Command", "s"] })
    expect(node).not.toHaveProperty("bounds")
    fake.state.hit = { ...original, menuShortcut: replacement }
    expect(await fake.registry.resolve(SCOPE, node.ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  }
})

test("native PNG bytes determine MIME and scoped bridge IDs remain distinct from native captures", async () => {
  const fake = fixture()
  const result = await fake.registry.add(SCOPE, fake.capture())
  expect(result.image).toStartWith("data:image/png;base64,")
  expect(result.frame.id).not.toBe("native_capture")
  expect(fake.registry.captureId(SCOPE, result.frame.id)).toBe("native_capture")
  expect(fake.registry.latest(SCOPE)).toEqual(result.frame)
  expect(result.frame.bounds).toEqual(NATIVE)
  expect(result.frame.scale).toBe(0.5)
  expect(result.visible).toEqual([APP])
  expect(imageMime(new Uint8Array([255, 216, 255]))).toBe("image/jpeg")
  expect(() => imageMime(new Uint8Array([1, 2, 3]))).toThrow()
})

test("Windows physical geometry uses per-monitor DIP origins without double-applying capture scale", async () => {
  const fake = fixture("windows", (rect, display) => {
    expect(display).toBe("display")
    return { x: -1280 + (rect.x + 2000) / 1.25, y: (rect.y - 40) / 1.25, w: rect.w / 1.25, h: rect.h / 1.25 }
  })
  const capture = fake.capture()
  const result = await fake.registry.add(SCOPE, { ...capture, header: { ...capture.header, dpiScale: 1.25 } })
  expect(result.frame.bounds).toEqual({ x: -1280, y: 0, w: 80, h: 64 })
  expect(result.frame.scale).toBe(0.625)
  expect(fake.registry.point(SCOPE, result.frame, { x: 25, y: 20 })).toEqual({ x: -1239.2, y: 32.8 })
  expect(fake.registry.captureId(SCOPE, result.frame.id)).toBe(capture.header.captureId)
  expect(fake.registry.pixel(SCOPE, result.frame, { x: -1949, y: 81 })).toEqual({ x: 25, y: 20 })
  const missing = fixture("windows")
  expect(await missing.registry.add(SCOPE, missing.capture()).catch((error) => error)).toMatchObject({
    code: "unavailable",
  })
})

test("Retina image pixels map to logical points and out-of-image points are rejected", async () => {
  const fake = fixture()
  const result = await fake.registry.add(SCOPE, fake.capture(2))
  expect(result.frame.scale).toBe(2)
  expect(fake.registry.point(SCOPE, result.frame.id, { x: 25, y: 40 })).toEqual({ x: -1987.25, y: 60.25 })
  expect(() => fake.registry.point(SCOPE, result.frame, { x: 200, y: 0 })).toThrow()
  expect(() => fake.registry.point(SCOPE, result.frame, { x: -1, y: 0 })).toThrow()
})

test("native mask unions hide fully covered windows and only approved identities are reported", async () => {
  const fake = fixture()
  const hidden = await fake.registry.add(
    SCOPE,
    fake.capture(0.5, [
      { x: 0, y: 0, w: 25, h: 40 },
      { x: 25, y: 0, w: 25, h: 40 },
    ]),
  )
  expect(hidden.visible).toEqual([])
  expect(hidden.hiddenCount).toBe(1)
  expect((await fake.registry.add(SCOPE, fake.capture(0.5, [{ x: 0, y: 0, w: 25, h: 40 }]))).visible).toEqual([APP])
  expect((await fake.registry.add(SCOPE, { ...fake.capture(), approved: [] })).visible).toEqual([])
})

test("native window movement and another hit-test window make captured coordinates stale", async () => {
  const fake = fixture()
  const result = await fake.registry.add(SCOPE, fake.capture())
  expect(await fake.registry.current(SCOPE, result.frame, fake.state.hit)).toBe(true)
  const newer = await fake.registry.add(SCOPE, fake.capture())
  expect(await fake.registry.current(SCOPE, result.frame, fake.state.hit)).toBe(false)
  expect(await fake.registry.current(SCOPE, newer.frame, fake.state.hit)).toBe(true)
  expect(await fake.registry.current(SCOPE, newer.frame, { ...fake.state.hit, windowId: "other" })).toBe(false)
  fake.state.bounds = { ...fake.state.bounds, x: -1999 }
  expect(await fake.registry.current(SCOPE, newer.frame, fake.state.hit)).toBe(false)
})

test("old roots/leases cannot use another task's captures and only three capture records remain", async () => {
  const fake = fixture()
  const first = await fake.registry.add(SCOPE, fake.capture())
  for (let index = 0; index < 3; index++) await fake.registry.add(SCOPE, fake.capture())
  expect(() => fake.registry.frame(SCOPE, first.frame.id)).toThrow()
  const latest = fake.registry.latest(SCOPE)!
  fake.state.scope = { ...SCOPE, lease: 2 }
  fake.state.phase = { sessionId: "successor", phaseRevision: 0 }
  expect(() => fake.registry.frame(fake.state.scope, latest.id)).toThrow()
  expect(() => fake.registry.frame(SCOPE, latest.id)).toThrow()
})

test("late captures do not install after a task/phase change or registry invalidation", async () => {
  const fake = fixture()
  const gate = Promise.withResolvers<void>()
  fake.state.appsWait = gate.promise
  const pending = fake.registry.add(SCOPE, fake.capture()).catch((error) => error)
  fake.registry.clear(SCOPE)
  fake.state.phase = { ...PHASE, phaseRevision: 2 }
  gate.resolve()
  expect(await pending).toMatchObject({ code: "stopped" })
  expect(fake.registry.latest(SCOPE)).toBeUndefined()
})

test("screen-reader refs re-resolve native elements without focus and secure values are removed", async () => {
  const fake = fixture()
  const nodes = fake.registry.tree(SCOPE, fake.tree())
  expect(nodes[0]).not.toHaveProperty("bounds")
  expect(nodes[1]).toMatchObject({ secure: true })
  expect(nodes[1]).not.toHaveProperty("value")
  expect((await fake.registry.resolve(SCOPE, nodes[0]!.ref)).elementId).toBe("element_1")
  expect(fake.registry.uiRef(SCOPE, fake.state.hit)).toBe(nodes[0]!.ref)
  fake.state.hit = { ...fake.state.hit, elementId: "replacement" }
  expect(await fake.registry.resolve(SCOPE, nodes[0]!.ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
})

test("tree bounds use image pixels, a new generation invalidates old refs and IDs never recycle", async () => {
  const fake = fixture()
  const result = await fake.registry.add(SCOPE, fake.capture())
  const nodes = fake.registry.tree(SCOPE, fake.tree(), result.frame)
  expect(nodes[0]!.bounds).toEqual({ x: 12.5, y: 5, w: 10, h: 5 })
  const next = fake.registry.tree(SCOPE, fake.tree(2), result.frame)
  expect(next[0]!.ref).not.toBe(nodes[0]!.ref)
  expect(await fake.registry.resolve(SCOPE, nodes[0]!.ref).catch((error) => error)).toMatchObject({ code: "stale_ref" })
  fake.registry.clear()
  expect(fake.registry.tree(SCOPE, fake.tree(2))[0]!.ref).not.toBe(next[0]!.ref)
})

test("an asynchronous ref resolution cannot escape into a cleared/successor scope", async () => {
  const fake = fixture()
  const node = fake.registry.tree(SCOPE, fake.tree())[0]!
  const gate = Promise.withResolvers<void>()
  fake.state.resolveWait = gate.promise
  const pending = fake.registry.resolve(SCOPE, node.ref).catch((error) => error)
  fake.registry.clear()
  gate.resolve()
  expect(await pending).toMatchObject({ code: "stale_ref" })
})

test("a capture never labels pixels with a replacement process or changed signer", async () => {
  const fake = fixture()
  fake.state.identity = { ...APP, pid: 21 }
  expect((await fake.registry.add(SCOPE, fake.capture())).visible).toEqual([])
  fake.state.identity = { ...APP, teamId: "OTHER12345" }
  expect((await fake.registry.add(SCOPE, fake.capture())).visible).toEqual([])
  fake.state.identity = { ...APP, verified: false }
  expect((await fake.registry.add(SCOPE, fake.capture())).visible).toEqual([])
})
