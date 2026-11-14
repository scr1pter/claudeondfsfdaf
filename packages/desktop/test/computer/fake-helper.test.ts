import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"

import identity from "../../native/computer-helper/identity.json" with { type: "json" }

import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { blocklist, COLORS, OVERLAY, type Rgb } from "./fake-desktop"
import { connect, main, manualClock, parseCli, type FakeOptions } from "./fake-helper"
import { decodePng, fit, type Image } from "./png"
import { encodeFrame, readTranscript, replay, type Channel } from "./transcript"

// C1: the fake helper speaks helper protocol v1 over its virtual desktop. Everything runs in-process on a manual
// clock; no test starts a process, captures the real screen or posts real input.

const FIXTURES = path.join(import.meta.dir, "../fixtures/computer-protocol")
const FULL_DISPLAY = { maxWidth: 4096, maxHeight: 4096, maxPixels: 4096 * 4096 }

describe("labelled synthetic Windows input setup (not native proof)", () => {
  test("status cannot calibrate, synthetic gestures require health, and reset invalidates readiness", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    expect(fake.call("input.setup", { action: "status" })).toMatchObject({
      ok: true,
      state: "needs-calibration",
      mouse: false,
      keyboard: false,
    })
    expect(fake.helper.control({ type: "synthetic_input_setup", mouse: true, keyboard: true, healthy: true })).toBe(
      false,
    )
    expect(fake.call("input.setup", { action: "start" })).toMatchObject({
      ok: true,
      state: "calibrating",
      mouse: false,
      keyboard: false,
    })
    expect(fake.call("input.setup", { action: "status" })).toMatchObject({
      state: "calibrating",
      mouse: false,
      keyboard: false,
    })
    expect(fake.helper.control({ type: "synthetic_input_setup", mouse: true, keyboard: true, healthy: false })).toBe(
      true,
    )
    expect(fake.call("input.setup", { action: "status" })).toMatchObject({
      state: "calibrating",
      mouse: true,
      keyboard: true,
    })
    expect(fake.helper.control({ type: "synthetic_input_setup", mouse: true, keyboard: true, healthy: true })).toBe(
      true,
    )
    expect(fake.call("input.setup", { action: "status" })).toMatchObject({
      state: "ready",
      mouse: true,
      keyboard: true,
    })
    expect(fake.call("input.setup", { action: "reset" })).toMatchObject({
      state: "needs-calibration",
      mouse: false,
      keyboard: false,
    })
    expect(fake.kinds()).not.toContain("input")
  })

  test("macOS does not expose Windows setup", () => {
    const fake = start()
    for (const action of ["status", "start", "reset"])
      expect(fake.call("input.setup", { action })).toMatchObject({ ok: false, code: "unsupported_action" })
  })
})

describe("windowless macOS app-menu observations", () => {
  const tree = (fake: ReturnType<typeof start>, slot = "notes", extra: Message = {}) =>
    fake.call("ui.tree", { pid: fake.helper.desktop.app(slot)!.pid, maxNodes: 50, maxDepth: 4, ...extra })
  const fresh = () => {
    const fake = start({ scenario: "notes" })
    fake.helper.desktop.closeWindows("notes")
    fake.begin(["notes"], { mode: "background" })
    return fake
  }
  const leaf = (fake: ReturnType<typeof start>) => tree(fake).nodes.find((item: Message) => item.name === "New")

  test("a real windowless app exposes menu refs without a frame, fabricated window or bounds", () => {
    const fake = fresh()
    const desktop = fake.helper.desktop
    const app = desktop.app("notes")!
    const before = {
      cursor: desktop.cursor,
      front: desktop.frontmost().pid,
      windows: desktop.apps().flatMap((item) => desktop.windowsOf(item.slot)).length,
    }
    const observed = tree(fake)
    expect(observed).toMatchObject({ ok: true, truncated: false })
    expect(observed.nodes).toHaveLength(3)
    for (const node of observed.nodes) {
      expect(node).toMatchObject({ scope: "app-menu", pid: app.pid })
      expect(typeof node.ref).toBe("string")
      expect(typeof node.elementId).toBe("string")
      expect(node).not.toHaveProperty("windowId")
      expect(node).not.toHaveProperty("bounds")
    }
    expect(observed.nodes[0].menuPath).toEqual([])
    const target = observed.nodes.find((item: Message) => item.name === "New")
    const resolved = fake.call("ui.resolve", { ref: target.ref })
    expect(resolved).toMatchObject({
      scope: "app-menu",
      pid: app.pid,
      owner: { platform: "macos", pid: app.pid },
      menuPath: ["File", "New"],
      elementId: target.elementId,
    })
    expect(resolved).not.toHaveProperty("windowId")
    expect(resolved).not.toHaveProperty("windowTitle")
    expect(
      fake.call("ui.perform", { ref: target.ref, action: "AXPress", pid: app.pid, elementId: target.elementId }),
    ).toMatchObject({ ok: true, took: true })
    expect(app.menuActions).toEqual(["notes.menu.new"])
    expect({
      cursor: desktop.cursor,
      front: desktop.frontmost().pid,
      windows: desktop.apps().flatMap((item) => desktop.windowsOf(item.slot)).length,
    }).toEqual(before)
    expect(desktop.windowsOf("notes")).toEqual([])
    expect(fake.kinds()).not.toContain("capture")
    expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ code: "stale_ref" })
  })

  test("focused menus preserve actual app ownership and only real optional geometry", () => {
    const fake = fresh()
    expect(fake.call("ui.focused")).toMatchObject({ scope: "app-menu", role: "AXMenuBar", menuPath: [] })
    const app = fake.helper.desktop.app("notes")!
    app.menus[2]!.bounds = { x: 80, y: 25, w: 70, h: 18 }
    fake.helper.desktop.focusMenu("notes", app.menus[2]!.id)
    expect(fake.call("ui.focused")).toMatchObject({
      scope: "app-menu",
      menuPath: ["File", "New"],
      bounds: app.menus[2]!.bounds,
    })
  })

  test("unapproved and never-listed windowless apps disclose no menu refs", () => {
    const fake = fresh()
    fake.begin(["calculator"])
    expect(tree(fake)).toMatchObject({ code: "not_granted" })
    fake.helper.desktop.closeWindows("terminal")
    fake.begin(["terminal"])
    expect(tree(fake, "terminal")).toMatchObject({ code: "protected" })
    expect(fake.helper.desktop.app("terminal")!.menuActions).toEqual([])
  })

  test("Windows has no fabricated app-menu surface", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    fake.helper.desktop.closeWindows("notes")
    fake.begin(["notes"])
    expect(tree(fake)).toMatchObject({ code: "app_not_found" })
    expect(fake.helper.desktop.app("notes")!.menus).toEqual([])
  })

  test("menu actions bind actual PID and element identity", () => {
    const fake = fresh()
    const target = leaf(fake)
    const pid = fake.helper.desktop.app("notes")!.pid
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress", pid: pid + 1 })).toMatchObject({
      code: "changed",
    })
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress", elementId: "different" })).toMatchObject({
      code: "changed",
    })
    expect(fake.helper.desktop.app("notes")!.menuActions).toEqual([])
  })

  test("same element with changed menu ancestry cannot reuse its observed reference", () => {
    const fake = fresh()
    const target = leaf(fake)
    fake.helper.desktop.app("notes")!.menus[2]!.menuPath = ["File", "Delete"]
    expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ code: "stale_ref" })
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
    expect(fake.helper.desktop.app("notes")!.menuActions).toEqual([])
  })

  test("accepted phase updates demote menu authority until an explicit unchanged refresh", () => {
    const fake = fresh()
    const original = leaf(fake)
    expect(fake.call("session.update", { approved: [fake.identity("notes")] })).toMatchObject({ ok: true })
    expect(fake.call("ui.perform", { ref: original.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
    expect(fake.call("ui.resolve", { ref: original.ref })).toMatchObject({
      ok: true,
      ref: original.ref,
      elementId: original.elementId,
    })
    const updated = leaf(fake)
    fake.begin(["notes"], { mode: "background" })
    expect(fake.call("ui.perform", { ref: updated.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
  })

  test("root and complete forbidden routes cannot mutate", () => {
    const fake = fresh()
    const root = tree(fake).nodes[0]
    expect(fake.call("ui.perform", { ref: root.ref, action: "AXPress" })).toMatchObject({ code: "blocked" })
    const menu = fake.helper.desktop.app("notes")!.menus[2]!
    menu.name = "Run"
    menu.menuPath = ["Tools", "Macros", "Run"]
    const target = tree(fake).nodes.find((item: Message) => item.name === menu.name)
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({ code: "blocked" })
    expect(fake.helper.desktop.app("notes")!.menuActions).toEqual([])
  })

  test("menu text and secure surfaces fail before any mutation", () => {
    const fake = fresh()
    const target = leaf(fake)
    expect(fake.call("ui.setValue", { ref: target.ref, value: "replacement" })).toMatchObject({ code: "blocked" })
    fake.helper.desktop.app("notes")!.menus[2]!.secure = true
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({ code: "secure_field" })
    expect(fake.call("ui.setValue", { ref: target.ref, value: "secret" })).toMatchObject({ code: "secure_field" })
    expect(fake.helper.desktop.app("notes")!.menuActions).toEqual([])
  })

  test("raising or typing into a menu never fabricates a coordinate target", () => {
    const fake = fresh()
    const target = leaf(fake)
    const app = fake.helper.desktop.app("notes")!
    const cursor = fake.helper.desktop.cursor
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXRaise" })).toMatchObject({ code: "needs_foreground" })
    expect(fake.call("input.type", { pid: app.pid, ref: target.ref, elementId: target.elementId, text: "x" }).ok).toBe(
      false,
    )
    expect(fake.helper.desktop.cursor).toEqual(cursor)
    expect(fake.helper.desktop.windowsOf("notes")).toEqual([])
    expect(app.menuActions).toEqual([])
  })

  test("menu depth and node limits report truncation without invented geometry", () => {
    const fake = fresh()
    const shallow = tree(fake, "notes", { maxDepth: 1 })
    expect(shallow).toMatchObject({ truncated: true })
    expect(shallow.nodes).toHaveLength(1)
    expect(shallow.nodes[0].menuPath).toEqual([])
    expect(tree(fake, "notes", { maxNodes: 2 })).toMatchObject({ truncated: true })
    const menu = fake.helper.desktop.app("notes")!.menus[2]!
    menu.menuPath = ["File", "x".repeat(257)]
    expect(tree(fake)).toMatchObject({ code: "unavailable" })
  })

  test("locking retires a private menu ref even after the screen unlocks", () => {
    const fake = fresh()
    const target = leaf(fake)
    fake.control({ type: "lock", locked: true })
    expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ code: "locked" })
    fake.control({ type: "lock", locked: false })
    expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ code: "stale_ref" })
    expect(fake.helper.desktop.app("notes")!.menuActions).toEqual([])
  })
})

describe("run-owned inactive observation receipts", () => {
  const setup = (kind: "window" | "menu", before?: (fake: ReturnType<typeof start>) => void) => {
    const fake = start({ scenario: "notes" })
    if (kind === "menu") fake.helper.desktop.closeWindows("notes")
    before?.(fake)
    fake.begin(["notes"], { mode: "background", escStops: false, paused: true, phaseRevision: 0 })
    const app = fake.helper.desktop.app("notes")!
    const result = fake.call("ui.tree", {
      ...(kind === "menu" ? { pid: app.pid } : { windowId: "notes-1" }),
      maxNodes: 50,
      maxDepth: 4,
    })
    const node = result.nodes.find((item: Message) =>
      kind === "menu" ? item.name === "New" : item.role === "AXTextField" && item.editable !== false,
    )!
    const hit = kind === "menu" ? { ...node, owner: fake.identity("notes") } : fake.call("ui.focused")
    const update = (revision = 1, extra: Message = {}) =>
      fake.call("session.update", {
        sessionId: "test",
        phaseRevision: revision,
        paused: false,
        approved: [fake.identity("notes")],
        ...extra,
      })
    const act = (revision = 1) =>
      fake.call(kind === "menu" ? "ui.perform" : "ui.setValue", {
        ref: hit.ref,
        pid: app.pid,
        elementId: hit.elementId,
        sessionId: "test",
        phaseRevision: revision,
        ...(kind === "menu" ? { action: "AXPress" } : { value: "Approved value" }),
      })
    return { fake, app, hit, update, act }
  }

  for (const kind of ["window", "menu"] as const) {
    test(`${kind}: a phase change cannot act until explicit unchanged re-observation republishes the same receipt`, () => {
      const { fake, app, hit, update, act } = setup(kind)
      const before = { cursor: fake.helper.desktop.cursor, front: fake.helper.desktop.frontmost().pid }
      expect(update()).toMatchObject({ ok: true })
      expect(act()).toMatchObject({ code: "stale_ref" })
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({
        ok: true,
        ref: hit.ref,
        elementId: hit.elementId,
      })
      expect({ cursor: fake.helper.desktop.cursor, front: fake.helper.desktop.frontmost().pid }).toEqual(before)
      expect(fake.helper.log.filter((entry) => entry.kind === "ui")).toEqual([])
      expect(act()).toMatchObject({ ok: true, took: true })
      if (kind === "menu") expect(app.menuActions).toEqual(["notes.menu.new"])
    })

    test(`${kind}: current app approval is required even for an unchanged inactive receipt`, () => {
      const { fake, hit, update, act } = setup(kind)
      update(1, { approved: [], paused: true })
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "not_granted" })
      update(2)
      expect(act(2)).toMatchObject({ code: "stale_ref" })
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({
        ok: true,
        ref: hit.ref,
        elementId: hit.elementId,
      })
      expect(act(2)).toMatchObject({ ok: true, took: true })
    })

    test(`${kind}: a new tree permanently drops receipts instead of recreating old native refs`, () => {
      const { fake, app, hit, update } = setup(kind)
      update()
      const next = fake.call("ui.tree", {
        ...(kind === "menu" ? { pid: app.pid } : { windowId: "notes-1" }),
        maxNodes: 50,
        maxDepth: 4,
      })
      expect(next.nodes.some((node: Message) => node.ref === hit.ref)).toBe(false)
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "stale_ref" })
    })

    test(`${kind}: reused wire session IDs cannot revive an older run receipt`, () => {
      const { fake, hit } = setup(kind)
      fake.begin(["notes"], { sessionId: "test", mode: "background", phaseRevision: 0 })
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "stale_ref" })
    })
  }

  test("window receipts bind complete names, role/security/document and actual window witnesses", () => {
    const changes = [
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { name: "Renamed" }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { role: "AXButton" }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { subrole: "AXSecureTextField", secure: true }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { enabled: false }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { editable: false }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { documentStatus: "unknown" }),
      (fake: ReturnType<typeof start>) =>
        Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, {
          documentStatus: "known",
          document: "/virtual/different",
        }),
      (fake: ReturnType<typeof start>) => {
        fake.helper.desktop.window("notes-1")!.bounds.x++
      },
      (fake: ReturnType<typeof start>) => {
        fake.helper.desktop.window("notes-1")!.onScreen = false
      },
      (fake: ReturnType<typeof start>) => {
        fake.helper.desktop.window("notes-1")!.spaceWitness = "different-space"
      },
      (fake: ReturnType<typeof start>) => {
        fake.helper.desktop.window("notes-1")!.nodes[0] = { ...fake.helper.desktop.window("notes-1")!.nodes[0]! }
      },
    ]
    for (const change of changes) {
      const { fake, hit, update } = setup("window")
      update()
      change(fake)
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "stale_ref" })
      expect(fake.helper.log.filter((entry) => entry.kind === "ui")).toEqual([])
    }
  })

  test("value edits do not become receipt identity and refreshing never returns the edited value", () => {
    const { fake, hit, update, act } = setup("window")
    update()
    fake.helper.desktop.setValue(fake.helper.desktop.window("notes-1")!.nodes[0]!, "private edited value")
    expect(act()).toMatchObject({ code: "stale_ref" })
    const refreshed = fake.call("ui.resolve", { ref: hit.ref })
    expect(refreshed).toMatchObject({ ok: true, ref: hit.ref, elementId: hit.elementId })
    expect(refreshed).not.toHaveProperty("value")
    expect(act()).toMatchObject({ ok: true, took: true })
  })

  test("truncated or Unicode-normalized names cannot refresh an older exact receipt", () => {
    const incomplete = setup("window", (fake) => {
      fake.helper.desktop.window("notes-1")!.nodes[0]!.nameComplete = false
    })
    incomplete.update()
    expect(incomplete.fake.call("ui.resolve", { ref: incomplete.hit.ref })).toMatchObject({ code: "stale_ref" })
    const canonical = setup("window", (fake) => {
      Object.assign(fake.helper.desktop.window("notes-1")!.nodes[0]!, { name: "Caf\u00e9" })
    })
    canonical.update()
    Object.assign(canonical.fake.helper.desktop.window("notes-1")!.nodes[0]!, { name: "Cafe\u0301" })
    expect(canonical.fake.call("ui.resolve", { ref: canonical.hit.ref })).toMatchObject({ code: "stale_ref" })
  })

  test("menu receipts retain the actual root, full ancestry and complete label", () => {
    for (const change of [
      (app: ReturnType<typeof setup>["app"]) => {
        app.menus[0] = { ...app.menus[0]! }
      },
      (app: ReturnType<typeof setup>["app"]) => {
        app.menus[2]!.menuPath = ["Other", "New"]
      },
      (app: ReturnType<typeof setup>["app"]) => {
        app.menus[2]!.name = "New name"
      },
      (app: ReturnType<typeof setup>["app"]) => {
        app.menus[2]!.nameComplete = false
      },
      (app: ReturnType<typeof setup>["app"]) => {
        app.menus[2]!.secure = true
      },
    ]) {
      const { fake, app, hit, update } = setup("menu")
      update()
      change(app)
      expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "stale_ref" })
      expect(app.menuActions).toEqual([])
    }
  })

  test("inactive receipts cannot retarget a replacement PID or changed signer", () => {
    for (const kind of ["window", "menu"] as const) {
      const pid = setup(kind)
      pid.update()
      Object.assign(pid.app, { pid: pid.app.pid + 1 })
      Object.assign(pid.app.identity, { pid: pid.app.pid })
      expect(pid.fake.call("ui.resolve", { ref: pid.hit.ref })).toMatchObject({ code: "stale_ref" })
      const signer = setup(kind)
      signer.update()
      Object.assign(signer.app.identity, { teamId: "TEAM123456" })
      expect(signer.fake.call("ui.resolve", { ref: signer.hit.ref })).toMatchObject({ code: "not_granted" })
    }
  })

  test("the bounded private receipt ledger permanently evicts old lineage", () => {
    const { fake, app, hit, update } = setup("menu")
    update(1, { paused: true })
    let latest = ""
    for (let index = 0; index < 4096; index++) {
      const item = {
        id: `notes.extra.${index}`,
        role: "AXMenuItem" as const,
        name: `Item ${index}`,
        menuPath: ["File", `Item ${index}`],
        enabled: true,
        secure: false,
      }
      app.menus.push(item)
      app.focused = item.id
      latest = fake.call("ui.focused").ref
    }
    expect(fake.call("ui.resolve", { ref: hit.ref })).toMatchObject({ code: "stale_ref" })
    expect(fake.call("ui.resolve", { ref: latest })).toMatchObject({ ok: true, ref: latest })
    expect(app.menuActions).toEqual([])
  })
})

describe("observed localized menu shortcuts", () => {
  const prepare = (
    label: string,
    shortcut: readonly string[] | undefined,
    options: { slot?: "notes" | "ide"; windowless?: boolean; secure?: boolean; mode?: Computer.Mode } = {},
  ) => {
    const fake = start({ scenario: "notes" })
    const slot = options.slot ?? "notes"
    if (slot === "ide") fake.helper.desktop.activate(slot)
    if (options.windowless) fake.helper.desktop.closeWindows(slot)
    if (options.secure) fake.helper.desktop.select("notes-1", "notes.password")
    const app = fake.helper.desktop.app(slot)!
    const menu = app.menus[2]!
    menu.name = label
    menu.menuPath = ["Édition", label]
    menu.menuShortcut = shortcut === undefined ? undefined : [...shortcut]
    fake.begin([slot], { mode: options.mode ?? "background", escStops: false })
    const tree = fake.call("ui.tree", { pid: app.pid, maxNodes: 50, maxDepth: 4 })
    const target = tree.nodes?.find((node: Message) => node.scope === "app-menu" && node.name === label)
    return { fake, app, menu, tree, target }
  }

  test("Inspecteur Web cannot hide the blocked Cmd+Option+I route behind a localized label", () => {
    const { fake, app, target } = prepare("Inspecteur Web", ["Command", "Option", "i"], { windowless: true })
    expect(target).toMatchObject({ menuShortcut: ["Command", "Option", "i"] })
    expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({ code: "blocked" })
    expect(app.menuActions).toEqual([])
  })

  test("Coller uses actual Cmd+V semantics and cannot paste through a windowless menu", () => {
    for (const mode of ["background", "foreground"] as const) {
      const { fake, app, target } = prepare("Coller", ["Command", "v"], { windowless: true, mode })
      expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ menuShortcut: ["Command", "v"] })
      expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({
        code: mode === "background" ? "needs_foreground" : "unsupported_action",
      })
      expect(app.menuActions).toEqual([])
      expect(fake.helper.desktop.windowsOf(app.slot)).toEqual([])
    }
  })

  test("localized paste checks the actual focused field's secure and developer floors", () => {
    const secure = prepare("Coller", ["Command", "v"], { secure: true })
    expect(secure.fake.call("ui.perform", { ref: secure.target.ref, action: "AXPress" })).toMatchObject({
      code: "secure_field",
    })
    const ide = prepare("Coller", ["Command", "v"], { slot: "ide" })
    expect(ide.fake.call("ui.perform", { ref: ide.target.ref, action: "AXPress" })).toMatchObject({ code: "blocked" })
    const ordinary = prepare("Coller", ["Command", "v"])
    const before = ordinary.fake.helper.desktop.window("notes-1")!.nodes[0]!.value
    expect(ordinary.fake.call("ui.perform", { ref: ordinary.target.ref, action: "AXPress" })).toMatchObject({
      code: "needs_foreground",
    })
    expect(ordinary.fake.helper.desktop.window("notes-1")!.nodes[0]!.value).toBe(before)
    for (const item of [secure, ide, ordinary]) expect(item.app.menuActions).toEqual([])
  })

  test("explicit malformed shortcut observations refuse instead of becoming absent legacy context", () => {
    const malformed = prepare("Coller", [], { windowless: true })
    expect(malformed.tree).toMatchObject({ code: "unavailable" })
    const absent = prepare("Nouveau", undefined, { windowless: true })
    expect(absent.target).not.toHaveProperty("menuShortcut")
    expect(absent.fake.call("ui.perform", { ref: absent.target.ref, action: "AXPress" })).toMatchObject({
      ok: true,
      took: true,
    })
  })

  test("shortcut changes cannot promote or mutate an older localized receipt", () => {
    for (const replacement of [["Command", "v"], ["s", "Command"], ["command", "s"], undefined]) {
      const { fake, app, menu, target } = prepare("Enregistrer", ["Command", "s"], { windowless: true })
      fake.call("session.update", { approved: [fake.identity("notes")] })
      menu.menuShortcut = replacement
      expect(fake.call("ui.resolve", { ref: target.ref })).toMatchObject({ code: "stale_ref" })
      expect(fake.call("ui.perform", { ref: target.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
      expect(app.menuActions).toEqual([])
    }
  })
})

for (const platform of ["macos", "windows"] as const) {
  test(`${platform}: installed app facts expose a PID only after a real virtual launch`, () => {
    const fake = start({ platform })
    const app = fake.helper.desktop.app("ide")!
    const file =
      app.identity.platform === "macos"
        ? app.identity.path
        : app.identity.platform === "windows" && app.identity.kind === "exe"
          ? app.identity.exe
          : undefined
    expect(file).toBeDefined()
    const installed = fake
      .call("apps.list", { installed: true })
      .apps.find((item: Message) => item.identity.name === app.identity.name)
    expect(installed.identity).not.toHaveProperty("pid")
    expect(installed).toMatchObject({ active: false, windows: [] })
    expect(app.identity).toHaveProperty("pid", app.pid)
    fake.begin([])
    const signed = fake.call("apps.resolve", { path: file })
    expect(signed).toMatchObject({ ok: true, kind: "app", identity: { verified: true } })
    expect(signed.identity).not.toHaveProperty("pid")
    Object.assign(app.identity, { verified: false })
    fake.begin(["ide"])
    expect(fake.call("app.launch", { identity: app.identity })).toMatchObject({ code: "not_granted" })
    fake.begin([])
    const unsigned = fake.call("apps.resolve", { path: file })
    expect(unsigned).toMatchObject({ ok: true, kind: "program", program: { path: file } })
    expect(unsigned).not.toHaveProperty("identity")
    expect(unsigned.program).not.toHaveProperty("pid")
    expect(
      fake.call("program.launch", { token: unsigned.program.token, binding: unsigned.program.binding }),
    ).toMatchObject({ ok: true, launched: true })
    expect(app.running).toBe(true)
    const running = fake.call("apps.list").apps.find((item: Message) => item.identity.name === app.identity.name)
    expect(running.identity).toMatchObject({ verified: false, pid: app.pid })
    expect(fake.call("apps.resolve", { path: file })).toMatchObject({
      ok: true,
      kind: "app",
      identity: { verified: false, pid: app.pid },
    })
    expect(fake.call("ui.tree", { windowId: "ide-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "not_granted",
    })
    fake.call("shutdown")
  })

  test(`${platform}: program resolution and launch bind virtual artifacts and never fabricate an app or input grant`, () => {
    const program = {
      path: platform === "macos" ? "/virtual/run.script" : "C:\\virtual\\run.script",
      name: "Run script",
      content: "version 1",
      handler: "verified:runner",
    }
    const fake = start({ platform, programs: [program] })
    expect(fake.call("apps.resolve", { path: program.path })).toMatchObject({ ok: false, code: "unavailable" })
    fake.begin([])
    const resolution = fake.call("apps.resolve", { path: program.path })
    expect(resolution).toMatchObject({ ok: true, kind: "program", program: { path: program.path, platform } })
    expect(resolution.program).not.toHaveProperty("pid")
    expect(resolution.program).not.toHaveProperty("bundleId")
    const descriptor = ComputerProgram.publicLaunch(resolution.program)
    expect(ComputerProgram.valid(descriptor)).toBe(true)
    expect(descriptor).not.toHaveProperty("token")
    expect(fake.call("program.launch", { token: resolution.program.token, binding: descriptor.binding })).toMatchObject(
      { ok: true, launched: true },
    )
    expect(fake.call("program.launch", { token: resolution.program.token, binding: descriptor.binding })).toMatchObject(
      { ok: false, code: "changed" },
    )
    expect(fake.call("input.type", { pid: fake.identity("notes").pid, text: "no grant" })).toMatchObject({
      ok: false,
      code: "not_granted",
    })
    const changed = fake.call("apps.resolve", { path: program.path }).program
    program.content = "version 2"
    expect(fake.call("program.launch", { token: changed.token, binding: changed.binding })).toMatchObject({
      ok: false,
      code: "changed",
    })
    const handler = fake.call("apps.resolve", { path: program.path }).program
    program.handler = "verified:different-runner"
    expect(fake.call("program.launch", { token: handler.token, binding: handler.binding })).toMatchObject({
      ok: false,
      code: "changed",
    })
    const old = fake.call("apps.resolve", { path: program.path }).program
    fake.begin([], { sessionId: "replacement" })
    expect(fake.call("program.launch", { token: old.token, binding: old.binding })).toMatchObject({
      ok: false,
      code: "changed",
    })
    const expiring = fake.call("apps.resolve", { path: program.path }).program
    // Keep the helper alive while advancing the virtual token deadline.
    for (let index = 0; index < 16; index++) {
      fake.advance(2000)
      fake.call("heartbeat")
    }
    expect(fake.call("program.launch", { token: expiring.token, binding: expiring.binding })).toMatchObject({
      ok: false,
      code: "changed",
    })
    expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
    fake.call("shutdown")
  })

  test(`${platform}: unresolved, unknown-handler and protected program targets fail truthfully`, () => {
    const base = platform === "macos" ? "/virtual/" : "C:\\virtual\\"
    const fake = start({
      platform,
      programs: [
        { path: `${base}unknown.script`, name: "Unknown", content: "v1" },
        {
          path: `${base}protected.script`,
          name: "Protected",
          content: "v1",
          handler: "verified:runner",
          protected: "security",
        },
      ],
    })
    fake.begin([])
    expect(fake.call("apps.resolve", { path: `${base}missing.script` })).toMatchObject({
      ok: false,
      code: "app_not_found",
    })
    expect(fake.call("apps.resolve", { path: `${base}unknown.script` })).toMatchObject({
      ok: false,
      code: "app_not_found",
    })
    expect(fake.call("apps.resolve", { path: `${base}protected.script` })).toMatchObject({
      ok: true,
      kind: "protected",
      reason: "security",
    })
    expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(0)
    fake.call("shutdown")
  })

  test(`${platform}: a paused phase observes without posting input and stale unpause cannot reopen it`, () => {
    const fake = start({ platform })
    fake.begin(["notes", "calculator"], { phaseRevision: 0, paused: true })
    const program = fake.call("apps.resolve", {
      path: platform === "macos" ? "/virtual/example.script" : "C:\\virtual\\example.script",
    }).program
    fake.helper.desktop.activate("notes")
    fake.helper.desktop.select("notes-1", "notes.body")
    const focused = fake.call("ui.focused")
    const capture = fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header
    expect(capture).toMatchObject({ ok: true })
    expect(fake.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({ ok: true })
    const pid = fake.identity("notes").pid
    for (const [op, args] of [
      ["input.type", { pid, text: "blocked" }],
      ["input.key", { pid, combo: ["a"], repeat: 1 }],
      ["input.hold", { pid, combo: ["a"], ms: 10 }],
      ["input.click", { captureId: capture.captureId, x: 0, y: 0, button: "left", count: 1, modifiers: [] }],
      ["app.activate", { identity: fake.identity("calculator") }],
      ["program.launch", { token: program.token, binding: program.binding, sessionId: "test", phaseRevision: 0 }],
      ["window.focus", { windowId: "calc-1" }],
      ["ui.perform", { ref: focused.ref, action: "AXPress" }],
      ["ui.setValue", { ref: focused.ref, value: "blocked" }],
    ] as const)
      expect(fake.call(op, args)).toMatchObject({ ok: false, code: "paused" })
    expect(fake.call("session.update", { sessionId: "test", phaseRevision: 2, paused: true })).toMatchObject({
      ok: true,
    })
    expect(fake.call("session.update", { sessionId: "test", phaseRevision: 1, paused: false })).toMatchObject({
      code: "changed",
    })
    expect(fake.call("session.update", { sessionId: "old-run", phaseRevision: 99, paused: false })).toMatchObject({
      code: "changed",
    })
    expect(fake.call("session.update", { paused: false })).toMatchObject({ code: "changed" })
    expect(fake.call("input.type", { pid, text: "still blocked" })).toMatchObject({ code: "paused" })
    expect(fake.call("session.update", { sessionId: "test", phaseRevision: 2, paused: false })).toMatchObject({
      ok: true,
    })
    expect(fake.call("input.type", { pid, text: "old phase", sessionId: "test", phaseRevision: 1 })).toMatchObject({
      code: "changed",
    })
    expect(
      fake.call("program.launch", {
        token: program.token,
        binding: program.binding,
        sessionId: "test",
        phaseRevision: 1,
      }),
    ).toMatchObject({ code: "changed" })
    expect(fake.call("input.type", { pid, text: "missing phase" })).toMatchObject({ code: "changed" })
    expect(fake.call("input.type", { pid, text: "allowed", sessionId: "test", phaseRevision: 2 })).toMatchObject({
      ok: true,
    })
    fake.begin(["notes"], { sessionId: "new-run", phaseRevision: 0, paused: true })
    expect(fake.call("session.update", { sessionId: "test", phaseRevision: 100, paused: false })).toMatchObject({
      code: "changed",
    })
    expect(fake.call("input.type", { pid, text: "old request" })).toMatchObject({ code: "paused" })
    fake.call("session.update", { sessionId: "new-run", phaseRevision: 0, paused: false })
    expect(
      fake.call("input.type", { pid, text: "late old request", sessionId: "test", phaseRevision: 2 }),
    ).toMatchObject({ code: "changed" })
    fake.call("shutdown")
  })
}

type Message = Record<string, any>

/** An in-process fake with a request helper that returns the reply, and every frame and event it sent. */
function start(options: FakeOptions = {}) {
  const clock = manualClock(1_000)
  const fake = connect(options, clock)
  const seen: Message[] = []
  const images = new Map<number, Image>()
  const state = { id: 0, exit: undefined as number | null | undefined }
  const drain = () => {
    while (fake.inbox.length) {
      const item = fake.inbox.shift()!
      if (item.kind === "exit") {
        state.exit = item.code
        continue
      }
      const message = JSON.parse(Buffer.from(item.bytes).toString("utf8")) as Message
      seen.push(message)
      if (typeof message.imageBytes !== "number") continue
      const image = fake.inbox.shift()
      if (image?.kind !== "frame" || image.bytes.length !== message.imageBytes) throw new Error("missing image frame")
      images.set(message.id, decodePng(image.bytes))
    }
  }
  const send = (op: string, args: Message = {}) => {
    const id = ++state.id
    fake.channel.write(encodeFrame({ id, op, ...args }))
    drain()
    return id
  }
  const reply = (id: number) => seen.find((message) => message.id === id && "ok" in message)
  const call = (op: string, args: Message = {}) => reply(send(op, args))!
  const desktop = fake.helper.desktop
  const identity = (slot: string) => desktop.app(slot)!.identity
  const begin = (slots: string[], extra: Message = {}) =>
    call("session.begin", {
      sessionId: "test",
      mode: "foreground",
      approved: slots.map(identity),
      vectorPids: [desktop.app("vector")!.pid],
      vectorWindowIds: ["vector-1"],
      overlayWindowIds: [OVERLAY],
      escStops: true,
      stopChord: "Command+Shift+Escape",
      heartbeatMs: 2000,
      ...extra,
    })
  const capture = (target: Message, budget = FULL_DISPLAY, extra: Message = {}) => {
    const header = call("capture", { target, budget, format: "jpeg", ...extra })
    return { header, image: images.get(header.id) }
  }
  const advance = (ms: number) => {
    clock.advance(ms)
    drain()
  }
  const control = (message: Message) => {
    expect(fake.helper.control(message)).toBe(true)
    drain()
  }
  const kinds = () => fake.helper.log.map((entry) => entry.kind)
  const index = (match: (entry: Message) => boolean) => fake.helper.log.findIndex(match)
  return {
    ...fake,
    clock,
    seen,
    images,
    state,
    drain,
    send,
    reply,
    call,
    begin,
    capture,
    advance,
    control,
    identity,
    kinds,
    index,
  }
}

function pixel(image: Image, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4
  return [image.rgba[offset]!, image.rgba[offset + 1]!, image.rgba[offset + 2]!]
}

/** The pixel of a capture showing a global point (the fake samples each pixel at its centre). */
function at(header: Message, x: number, y: number) {
  return [
    Math.floor((x - header.origin.x) * header.imageScale),
    Math.floor((y - header.origin.y) * header.imageScale),
  ] as const
}

const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

describe("atomic native target binding", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform} pointer operations match the observed window, reference and stable element`, () => {
      const fake = start({ platform })
      fake.begin(["calculator"])
      const header = fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header
      const [x, y] = at(header, 70, 170)
      for (const input of [
        { op: "input.move" },
        { op: "input.scroll", dx: 0, dy: 1 },
        { op: "input.click", button: "left", count: 1, modifiers: [] },
      ]) {
        const hit = fake.call("ui.hittest", { captureId: header.captureId, x, y })
        const expected = { windowId: hit.windowId, ref: hit.ref, elementId: hit.elementId }
        for (const wrong of [{ windowId: "other-window" }, { ref: "other-ref" }, { elementId: "other-element" }])
          expect(
            fake.call(input.op, { ...input, captureId: header.captureId, x, y, ...expected, ...wrong }),
          ).toMatchObject({ code: "changed" })
        expect(fake.call(input.op, { ...input, captureId: header.captureId, x, y, ...expected })).toMatchObject({
          ok: true,
        })
      }
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(3)
      fake.call("shutdown")
    })

    test(`${platform} a same-window control substitution is refused after a queued pointer request`, () => {
      for (const input of [
        { op: "input.click", button: "left", count: 1, modifiers: [] },
        { op: "input.move" },
        { op: "input.scroll", dx: 0, dy: 1 },
      ]) {
        const fake = start({ platform, latencyMs: 100 })
        fake.begin(["calculator"])
        fake.advance(100)
        const captured = fake.send("capture", {
          target: { display: fake.helper.desktop.displays[0]!.id },
          budget: FULL_DISPLAY,
          format: "jpeg",
        })
        fake.advance(100)
        const header = fake.reply(captured)!
        const [x, y] = at(header, 70, 170)
        const inspected = fake.send("ui.hittest", { captureId: header.captureId, x, y })
        fake.advance(100)
        const hit = fake.reply(inspected)!
        const pending = fake.send(input.op, {
          ...input,
          captureId: header.captureId,
          x,
          y,
          windowId: hit.windowId,
          ref: hit.ref,
          elementId: hit.elementId,
        })
        const nodes = fake.helper.desktop.window("calc-1")!.nodes
        const first = nodes.find((node) => node.id === "calculator.7")!
        const second = nodes.find((node) => node.id === "calculator.8")!
        const previous = { ...first.rect }
        Object.assign(first.rect, second.rect)
        Object.assign(second.rect, previous)
        fake.advance(100)
        expect(fake.reply(pending)).toMatchObject({ code: "changed" })
        expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
        fake.call("shutdown")
      }
    })

    test(`${platform} keyboard operations also bind a stable element identity`, () => {
      const fake = start({ platform, scenario: "notes" })
      fake.begin(["notes"])
      fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
      const before = fake.call("ui.focused")
      const pid = fake.identity("notes").pid
      for (const input of [
        { op: "input.key", combo: ["a"], repeat: 1 },
        { op: "input.type", text: "z" },
        { op: "input.hold", combo: ["a"], ms: 1 },
      ])
        expect(
          fake.call(input.op, {
            ...input,
            pid,
            windowId: before.windowId,
            ref: before.ref,
            elementId: "different-field",
          }),
        ).toMatchObject({ code: "changed" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      expect(fake.call("input.type", { pid, elementId: before.elementId, text: "z" })).toMatchObject({ ok: true })
      expect(fake.call("ui.focused").ref).not.toBe(before.ref)
      expect(fake.call("input.type", { pid, elementId: before.elementId, text: "z" })).toMatchObject({ ok: true })
      fake.call("shutdown")
    })

    test(`${platform} a drag rechecks every point and its final release target`, () => {
      const fake = start({ platform })
      fake.begin(["calculator"])
      const header = fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header
      const path = [70, 130, 190].map((globalX) => {
        const [x, y] = at(header, globalX, 170)
        return { x, y }
      })
      const targets = path.map((point) => {
        const hit = fake.call("ui.hittest", { captureId: header.captureId, ...point })
        return { windowId: hit.windowId, ref: hit.ref, elementId: hit.elementId }
      })
      const input = { captureId: header.captureId, path, targets, button: "left", modifiers: [] }
      expect(
        fake.call("input.drag", {
          ...input,
          targets: targets.map((target, index) =>
            index === 1 ? { ...target, elementId: "substituted-middle-element" } : target,
          ),
        }),
      ).toMatchObject({ code: "changed" })
      expect(fake.call("input.drag", input)).toMatchObject({ ok: true })
      const before = fake.helper.log.filter((entry) => entry.kind === "input").length
      const nodeAt = fake.helper.desktop.nodeAt
      let inspected = 0
      fake.helper.desktop.nodeAt = (window, point) => {
        const found = nodeAt(window, point)
        if (++inspected === path.length) {
          const final = window.nodes.find((node) => node.id === "calculator.9")!
          const replacement = window.nodes.find((node) => node.id === "calculator.8")!
          const previous = { ...final.rect }
          Object.assign(final.rect, replacement.rect)
          Object.assign(replacement.rect, previous)
        }
        return found
      }
      try {
        expect(fake.call("input.drag", input)).toMatchObject({ code: "changed" })
      } finally {
        fake.helper.desktop.nodeAt = nodeAt
      }
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(before)
      fake.call("shutdown")
    })
  }

  test("raw helper drag envelopes retain the one-target-per-point schema refinement", () => {
    const points = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]
    const request = {
      id: 1,
      op: "input.drag",
      captureId: "capture",
      path: points,
      targets: [{ windowId: "window" }, { windowId: "window" }],
      button: "left",
      modifiers: [],
    }
    const decode = Schema.decodeUnknownSync(Computer.helperRequest("input.drag"))
    expect(decode(request)).toEqual(request)
    expect(() => decode({ ...request, targets: request.targets.slice(0, 1) })).toThrow()
    expect(() =>
      decode({ ...request, targets: Array(Computer.LIMITS.dragPointsMax + 1).fill(request.targets[0]) }),
    ).toThrow()
    expect(
      decode({
        ...request,
        path: Array(Computer.LIMITS.dragPointsMax).fill(points[0]),
        targets: Array(Computer.LIMITS.dragPointsMax).fill(request.targets[0]),
      }).targets,
    ).toHaveLength(Computer.LIMITS.dragPointsMax)
    const fake = start()
    fake.begin(["calculator"])
    const { id, op, ...args } = request
    expect(fake.call(op, { ...args, targets: request.targets.slice(0, 1) })).toMatchObject({ code: "failed" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  })
})

describe("fresh native observations for desktop main", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform}: resolving a ref observes its exact generation and approved owner without writes`, () => {
      const fake = start({ platform, scenario: "notes" })
      fake.begin(["notes"], { paused: true, phaseRevision: 0 })
      const tree = fake.call("ui.tree", { windowId: "notes-1", maxNodes: 100, maxDepth: 8 })
      const title = tree.nodes.find((node: Message) => node.name === "Title")!
      const desktop = fake.helper.desktop
      const before = {
        generation: desktop.generation,
        frontmost: desktop.frontmost().pid,
        cursor: { ...desktop.cursor },
        value: desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value,
      }
      const resolved = fake.call("ui.resolve", { ref: title.ref })
      expect(resolved).toMatchObject({
        ok: true,
        ref: title.ref,
        owner: fake.identity("notes"),
        windowId: "notes-1",
        role: "AXTextField",
        name: "Title",
        enabled: true,
        editable: true,
        secure: false,
      })
      expect(typeof resolved.elementId).toBe("string")
      expect(desktop.generation).toBe(before.generation)
      expect(desktop.frontmost().pid).toBe(before.frontmost)
      expect(desktop.cursor).toEqual(before.cursor)
      expect(desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value).toBe(before.value)
      expect(fake.helper.log.filter((entry) => ["input", "ui", "app", "program"].includes(entry.kind))).toEqual([])
      desktop.setValue(desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!, "Changed title")
      expect(fake.call("ui.resolve", { ref: title.ref })).toMatchObject({ code: "stale_ref" })
      const fresh = fake
        .call("ui.tree", { windowId: "notes-1", maxNodes: 100, maxDepth: 8 })
        .nodes.find((node: Message) => node.name === "Title")!
      const current = fake.call("ui.resolve", { ref: fresh.ref })
      expect(current.elementId).toBe(resolved.elementId)
      expect(current.ref).not.toBe(resolved.ref)
      fake.call("session.update", { sessionId: "test", phaseRevision: 1, paused: true, approved: [] })
      expect(fake.call("ui.resolve", { ref: fresh.ref })).toMatchObject({ code: "not_granted" })
      fake.begin(["terminal"], { sessionId: "protected-owner", phaseRevision: 0, paused: true })
      expect(fake.call("ui.resolve", { ref: `${desktop.generation}:terminal-1` })).toMatchObject({ code: "stale_ref" })
      expect(fake.call("ui.tree", { windowId: "terminal-1", maxNodes: 10, maxDepth: 2 })).toMatchObject({
        code: "protected",
      })
      expect(fake.helper.log.filter((entry) => ["input", "ui", "app", "program"].includes(entry.kind))).toEqual([])
      fake.call("shutdown")
    })

    for (const enabled of [true, false])
      test(`${platform}: each phased begin reports fresh ${enabled ? "live" : "missing"} detection before its acknowledgement`, () => {
        const fake = start({ platform, scenario: "notes", ...(enabled ? {} : { disabled: ["userInput.detect"] }) })
        for (const sessionId of ["first-run", "second-run"]) {
          const start = fake.seen.length
          const reply = fake.begin(["notes"], { sessionId, phaseRevision: 0, paused: true })
          const messages = fake.seen.slice(start)
          const detection = messages.filter((message) => message.event === "input_detection")
          expect(detection).toEqual([
            enabled
              ? { event: "input_detection", alive: true }
              : { event: "input_detection", alive: false, reason: "probe_missing" },
          ])
          expect(messages.indexOf(detection[0])).toBeLessThan(messages.indexOf(reply))
          expect(reply.ok).toBe(true)
        }
        fake.call("shutdown")
      })
  }

  test("macOS repeats the current secure-input refusal for a new phased session", () => {
    const fake = start({ scenario: "notes" })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    for (const sessionId of ["first-secure-run", "second-secure-run"]) {
      const start = fake.seen.length
      const reply = fake.begin(["notes"], { sessionId, phaseRevision: 0, paused: true })
      const messages = fake.seen.slice(start)
      const detection = messages.filter((message) => message.event === "input_detection")
      expect(detection).toEqual([{ event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" }])
      expect(messages.indexOf(detection[0])).toBeLessThan(messages.indexOf(reply))
    }
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
    fake.call("shutdown")
  })
})

describe("observing the virtual OS pointer", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform} reports actual native coordinates and display without input, focus or frame changes`, () => {
      const fake = start({ platform, scenario: "multi-display" })
      fake.begin(["notes"], { paused: true, phaseRevision: 0 })
      fake.helper.desktop.cursor = { x: -700, y: -125 }
      const frontmost = fake.helper.desktop.frontmost().pid
      const generation = fake.helper.desktop.generation
      const displayId = fake.helper.desktop.displays[1]!.id
      expect(fake.call("cursor.position")).toMatchObject({ ok: true, x: -700, y: -125, displayId })
      expect(fake.helper.desktop.cursor).toEqual({ x: -700, y: -125 })
      expect(fake.helper.desktop.frontmost().pid).toBe(frontmost)
      expect(fake.helper.desktop.generation).toBe(generation)
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      fake.control({ type: "user_input", kind: "pointer", dx: 25, dy: 10 })
      expect(fake.call("cursor.position")).toMatchObject({
        ok: true,
        x: platform === "windows" ? -662.5 : -675,
        y: platform === "windows" ? -110 : -115,
        displayId,
      })
      fake.control({ type: "lock", locked: true })
      expect(fake.call("cursor.position")).toMatchObject({ code: "locked" })
      fake.call("shutdown")
    })

    test(`${platform} a real virtual move updates the observed pointer using capture scale and origin`, () => {
      const fake = start({ platform, scenario: "multi-display" })
      fake.begin(["notes"])
      const displayId = fake.helper.desktop.displays[1]!.id
      const header = fake.capture({ display: displayId }).header
      const [x, y] = at(header, -650, -50)
      expect(fake.call("input.move", { captureId: header.captureId, x, y })).toMatchObject({ ok: true })
      expect(fake.call("cursor.position")).toMatchObject({
        ok: true,
        x: header.origin.x + (x + 0.5) / header.imageScale,
        y: header.origin.y + (y + 0.5) / header.imageScale,
        displayId,
      })
      fake.call("shutdown")
    })
  }

  test("cursor observation is feature-gated and an off-display pointer is never replaced by a center", () => {
    const absent = start({ disabled: ["cursor.position"] })
    absent.begin(["calculator"])
    expect(absent.call("cursor.position")).toMatchObject({ code: "unsupported_action" })
    absent.call("shutdown")
    const fake = start()
    expect(fake.call("cursor.position")).toMatchObject({ code: "unavailable" })
    fake.begin(["calculator"])
    fake.helper.desktop.cursor = { x: 2000, y: 2000 }
    expect(fake.call("cursor.position")).toMatchObject({ code: "out_of_bounds" })
    expect(fake.helper.desktop.cursor).toEqual({ x: 2000, y: 2000 })
    fake.call("shutdown")
  })
})

describe("native approved identities retain their signer and unsigned process binding", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform} an approved stable key cannot lose verification or change its signer`, () => {
      for (const change of ["signer", "verification"] as const) {
        const fake = start({ platform })
        const slot = platform === "macos" ? "bank" : "calculator"
        const windowId = platform === "macos" ? "bank-1" : "calc-1"
        fake.begin([slot])
        fake.control({ type: "focus", windowId })
        const header = fake.capture({ windowId }).header
        const input = { captureId: header.captureId, x: 10, y: 10 }
        expect(fake.call("input.move", input)).toMatchObject({ ok: true })
        const identity = fake.identity(slot)
        const key = Computer.appKey(identity)
        Object.assign(
          identity,
          change === "verification"
            ? { verified: false }
            : platform === "macos"
              ? { teamId: "OTHERTEAM1" }
              : { publisher: "Different publisher" },
        )
        expect(Computer.appKey(identity)).toBe(key)
        expect(fake.call("input.move", input)).toMatchObject({ code: "not_granted" })
        expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(1)
        fake.call("shutdown")
      }
    })

    test(`${platform} unsigned task consent requires its exact canonical path and live process`, () => {
      for (const change of ["path", "pid", "missing-pid", "uncanonical-path"] as const) {
        const fake = start({ platform, scenario: "notes" })
        const app = fake.helper.desktop.app("notes")!
        Object.assign(app.identity, {
          verified: false,
          system: false,
          ...(platform === "macos" ? { apple: false } : { publisher: "" }),
        })
        if (change === "missing-pid") Object.assign(app.identity, { pid: undefined })
        if (change === "uncanonical-path")
          Object.assign(
            app.identity,
            platform === "macos" ? { path: "/Applications/../Unsigned.app" } : { exe: "C:\\virtual\\..\\Unsigned.exe" },
          )
        fake.begin(["notes"])
        const header = fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header
        const [x, y] = at(header, 400, 200)
        const input = { captureId: header.captureId, x, y }
        if (change === "missing-pid" || change === "uncanonical-path") {
          expect(fake.call("input.move", input)).toMatchObject({ code: "not_granted" })
          expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
          fake.call("shutdown")
          continue
        }
        expect(fake.call("input.move", input)).toMatchObject({ ok: true })
        if (change === "path")
          Object.assign(
            app.identity,
            platform === "macos" ? { path: "/Applications/Different.app" } : { exe: "C:\\virtual\\Different.exe" },
          )
        if (change === "pid") {
          Object.assign(app, { pid: app.pid + 1000 })
          Object.assign(app.identity, { pid: app.pid })
        }
        expect(fake.call("input.move", input)).toMatchObject({ code: "not_granted" })
        expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(1)
        fake.call("shutdown")
      }
    })

    test(`${platform} a restarted signed process cannot reuse the previous pointer target witness`, () => {
      const fake = start({ platform })
      fake.begin(["calculator"])
      const app = fake.helper.desktop.app("calculator")!
      const header = fake.capture({ windowId: "calc-1" }).header
      const hit = fake.call("ui.hittest", { captureId: header.captureId, x: 20, y: 100 })
      const expected = { pid: app.pid, windowId: hit.windowId, ref: hit.ref, elementId: hit.elementId }
      Object.assign(app, { pid: app.pid + 1000 })
      Object.assign(app.identity, { pid: app.pid })
      const input = { captureId: header.captureId, x: 20, y: 100, ...expected }
      expect(fake.call("input.move", input)).toMatchObject({ code: "changed" })
      expect(fake.call("input.click", { ...input, button: "left", count: 1, modifiers: [] })).toMatchObject({
        code: "changed",
      })
      expect(fake.call("input.scroll", { ...input, dx: 0, dy: 1 })).toMatchObject({ code: "changed" })
      expect(
        fake.call("input.drag", {
          captureId: header.captureId,
          path: [
            { x: 20, y: 100 },
            { x: 21, y: 101 },
          ],
          targets: [expected, expected],
          button: "left",
          modifiers: [],
        }),
      ).toMatchObject({ code: "changed" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      expect(fake.call("input.move", { ...input, pid: app.pid })).toMatchObject({ code: "changed" })
      const currentHeader = fake.capture({ windowId: "calc-1" }).header
      const currentHit = fake.call("ui.hittest", { captureId: currentHeader.captureId, x: 20, y: 100 })
      expect(currentHit.ref).not.toBe(hit.ref)
      expect(currentHit.elementId).not.toBe(hit.elementId)
      expect(
        fake.call("input.move", {
          captureId: currentHeader.captureId,
          x: 20,
          y: 100,
          pid: app.pid,
          windowId: currentHit.windowId,
          ref: currentHit.ref,
          elementId: currentHit.elementId,
        }),
      ).toMatchObject({ ok: true })
      fake.call("shutdown")
    })
  }

  test("unsigned identities with an absent executable path cannot share two missing path fields", () => {
    for (const platform of ["macos", "windows"] as const) {
      const fake = start({ platform })
      const slot = platform === "macos" ? "notes" : "calculator"
      const windowId = platform === "macos" ? "notes-1" : "calc-1"
      const identity = fake.identity(slot)
      Object.assign(identity, {
        verified: false,
        system: false,
        ...(platform === "macos" ? { apple: false, path: undefined } : { exe: undefined }),
      })
      fake.begin([slot])
      expect(fake.call("ui.tree", { windowId, maxNodes: 10, maxDepth: 3 })).toMatchObject({ code: "not_granted" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      fake.call("shutdown")
    }
  })

  test("pointer PIDs are optional positive witnesses while keyboard PIDs remain required", () => {
    const click = { id: 1, op: "input.click", captureId: "cap", x: 1, y: 1, button: "left", count: 1, modifiers: [] }
    const decode = Schema.decodeUnknownSync(Computer.helperRequest("input.click"))
    expect(decode(click)).not.toHaveProperty("pid")
    expect(decode({ ...click, pid: 123 })).toHaveProperty("pid", 123)
    expect(() => decode({ ...click, pid: 0 })).toThrow()
    for (const [op, args] of [
      ["input.key", { combo: ["a"], repeat: 1 }],
      ["input.type", { text: "x" }],
      ["input.hold", { combo: ["a"], ms: 1 }],
    ] as const) {
      const decode = Schema.decodeUnknownSync(Computer.helperRequest(op))
      expect(() => decode({ id: 1, op, ...args })).toThrow()
      expect(decode({ id: 1, op, ...args, pid: 123 })).toHaveProperty("pid", 123)
    }
  })
})

describe("native reference actions retain their observed process and element", () => {
  for (const platform of ["macos", "windows"] as const) {
    for (const action of ["perform", "setValue"] as const) {
      test(`${platform} ui.${action} refuses a substituted signed process before changing its control`, () => {
        const fake = start({ platform, scenario: action === "setValue" ? "notes" : "calculator" })
        const slot = action === "setValue" ? "notes" : "calculator"
        const windowId = action === "setValue" ? "notes-1" : "calc-1"
        fake.begin([slot])
        const app = fake.helper.desktop.app(slot)!
        const node = fake.helper.desktop
          .window(windowId)!
          .nodes.find((node) => node.id === (action === "setValue" ? "notes.body" : "calculator.7"))!
        const before = node.value
        const tree = fake.call("ui.tree", { windowId, maxNodes: 50, maxDepth: 4 })
        const ref = tree.nodes.find((item: Message) => item.name === node.name).ref
        const hit = fake.call("ui.resolve", { ref })
        const expected = { pid: app.pid, elementId: hit.elementId }
        const args =
          action === "perform"
            ? { ref, action: platform === "windows" ? "Invoke" : "AXPress" }
            : { ref, value: "replacement" }
        expect(fake.call(`ui.${action}`, { ...args, ...expected, elementId: "different-element" })).toMatchObject({
          code: "changed",
        })
        Object.assign(app, { pid: app.pid + 1000 })
        Object.assign(app.identity, { pid: app.pid })
        expect(fake.call(`ui.${action}`, { ...args, ...expected })).toMatchObject({ code: "stale_ref" })
        expect(node.value).toBe(before)
        expect(fake.helper.log.filter((entry) => entry.kind === "ui")).toEqual([])
        const replacement = fake
          .call("ui.tree", { windowId, maxNodes: 50, maxDepth: 4 })
          .nodes.find((item: Message) => item.name === node.name)
        const replacementHit = fake.call("ui.resolve", { ref: replacement.ref })
        expect(replacementHit.elementId).not.toBe(expected.elementId)
        expect(
          fake.call(`ui.${action}`, {
            ...args,
            ref: replacement.ref,
            pid: app.pid,
            elementId: replacementHit.elementId,
          }),
        ).toMatchObject({
          ok: true,
          took: true,
        })
        fake.call("shutdown")
      })
    }
  }

  test("reference-action owner witnesses must be positive when supplied", () => {
    for (const [op, args] of [
      ["ui.perform", { ref: "node", action: "AXPress" }],
      ["ui.setValue", { ref: "node", value: "text" }],
    ] as const) {
      const decode = Schema.decodeUnknownSync(Computer.helperRequest(op))
      expect(decode({ id: 1, op, ...args, pid: 123, elementId: "element" })).toMatchObject({
        pid: 123,
        elementId: "element",
      })
      expect(() => decode({ id: 1, op, ...args, pid: 0 })).toThrow()
      expect(() => decode({ id: 1, op, ...args, pid: -1 })).toThrow()
      expect(() => decode({ id: 1, op, ...args, elementId: "" })).toThrow()
    }
  })
})

/** `masked` must be exactly the painted blocks: every pixel in a rect is a block, every block pixel is in a rect. */
function expectMaskedIsPainted(header: Message, image: Image) {
  const rects = header.masked as { x: number; y: number; w: number; h: number }[]
  const inRect = (x: number, y: number) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
  const block = (color: Rgb) => same(color, COLORS.mask) || same(color, COLORS.vector)
  const wrong: string[] = []
  for (let y = 0; y < image.height && wrong.length < 5; y++)
    for (let x = 0; x < image.width && wrong.length < 5; x++)
      if (block(pixel(image, x, y)) !== inRect(x, y)) wrong.push(`${x},${y}`)
  expect(wrong).toEqual([])
}

describe("conformance transcripts", () => {
  const files = readdirSync(FIXTURES).filter((file) => file.endsWith(".jsonl"))

  test("cover the section 2.11 list", () => {
    expect(files.toSorted()).toEqual(
      [
        "cancel-idle.jsonl",
        "eof.jsonl",
        "frame-too-large.jsonl",
        "heartbeat-loss.jsonl",
        "hello.jsonl",
        "malformed-json.jsonl",
        "permissions.jsonl",
        "session.jsonl",
        "shutdown.jsonl",
        "unsupported-action.jsonl",
      ].toSorted(),
    )
  })

  for (const file of files)
    test(`the fake replays ${file}`, async () => {
      const clock = manualClock(1_000)
      const fake = connect({}, clock)
      const result = await replay(fake.channel, readTranscript(path.join(FIXTURES, file)), {
        name: file,
        wait: async (ms) => clock.advance(ms),
      })
      // The driver skips events, so the fake's own must still be none here.
      expect(result.events).toEqual([])
    })

  // Events may arrive at any time (2.10): a native helper on a runner without grants reports input_detection when a
  // foreground session starts. The fake does the same when the focused field is secure, before answering.
  test("an event a line does not expect is skipped and returned, not matched against the response", async () => {
    for (const file of ["session.jsonl", "heartbeat-loss.jsonl"]) {
      const clock = manualClock(1_000)
      const fake = connect({ scenario: "notes" }, clock)
      expect(fake.helper.control({ type: "focus", windowId: "notes-1", node: "notes.password" })).toBe(true)
      const result = await replay(fake.channel, readTranscript(path.join(FIXTURES, file)), {
        name: file,
        wait: async (ms) => clock.advance(ms),
      })
      expect(result.events).toEqual([
        { event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" },
      ])
    }
  })

  // The driver is the conformance gate for the native helpers, so a frame that a desktop could not decode fails it
  // even when it matches the expected subset.
  test("the driver refuses frames that do not decode", async () => {
    const answering = (frames: Message[]): Channel => ({
      write: () => {},
      end: () => {},
      next: async () => {
        const frame = frames.shift()
        return frame ? { kind: "frame", bytes: Buffer.from(JSON.stringify(frame)) } : undefined
      },
    })
    const hello = { send: { id: 1, op: "hello", protocol: { min: 1, max: 1 } }, expect: { id: 1, ok: true } }
    const failure = { send: { id: 1, op: "teleport" }, expect: { id: 1, ok: false, code: "unsupported_action" } }
    const wait = async () => {}
    await expect(
      replay(answering([{ id: 1, ok: false, code: "unsupported_action" }]), [failure], { wait }),
    ).rejects.toThrow(/does not decode \(not a HelperFailure\)/)
    await expect(replay(answering([{ id: 1, ok: true }]), [hello], { wait })).rejects.toThrow(/not a hello response/)
    await expect(
      replay(answering([{ id: 7, ok: true }]), [{ ...hello, expect: { ok: true } }], { wait }),
    ).rejects.toThrow(/never sent/)
    await expect(
      replay(answering([{ id: 1, ok: false, code: "unsupported_action", error: "no" }]), [failure], { wait }),
    ).resolves.toMatchObject({ messages: [{ id: 1, code: "unsupported_action" }], events: [] })
    // Events are skipped while a line waits for a response or for nothing, but must still decode; a line that
    // expects an event matches it and skips only events of other kinds.
    const tap = { event: "input_detection", alive: false, reason: "tap_disabled" }
    const quiet = { send: { $wait: 10 }, expect: null }
    await expect(
      replay(answering([tap, { id: 1, ok: false, code: "unsupported_action", error: "no" }, tap]), [failure, quiet], {
        wait,
      }),
    ).resolves.toEqual({ messages: [expect.objectContaining({ id: 1 })], events: [tap, tap] })
    await expect(replay(answering([{ event: "teleport" }]), [failure], { wait })).rejects.toThrow(
      /does not decode \(not a HelperEvent\)/,
    )
    await expect(replay(answering([{ id: 9, ok: true }]), [quiet], { wait })).rejects.toThrow(/expected nothing/)
    const stop = { event: "stop", by: "esc" }
    await expect(
      replay(answering([tap, stop]), [{ send: { $wait: 10 }, expect: { event: "stop" } }], { wait }),
    ).resolves.toEqual({ messages: [stop], events: [tap] })
  })
})

describe("capture privacy", () => {
  for (const platform of ["macos", "windows"] as const) {
    test(`${platform}: hiddenCount counts visible app owners once and excludes furniture and occluded apps`, () => {
      const fake = start({ platform })
      fake.begin(["calculator"])
      const desktop = fake.helper.desktop
      const window = (id: string, bounds: Computer.Rect, windowId = id) => ({
        ...desktop.window(id)!,
        windowId,
        bounds,
        nodes: [],
      })
      // One approved window splits Notes into two painted pieces. A second Notes window still contributes
      // one app, while Bank is fully covered or offscreen. The notification host stays masked but uncounted.
      desktop.stack = () => [
        desktop.window(OVERLAY)!,
        window("calc-1", { x: 100, y: 0, w: 100, h: 200 }),
        window("toast-1", { x: 0, y: 220, w: 50, h: 50 }),
        window("vector-1", { x: 200, y: 220, w: 50, h: 50 }),
        window("notes-1", { x: 300, y: 220, w: 50, h: 50 }, "notes-second"),
        window("notes-1", { x: 0, y: 0, w: 300, h: 200 }),
        window("bank-1", { x: 100, y: 0, w: 100, h: 200 }),
        window("bank-1", { x: 1100, y: 0, w: 100, h: 200 }, "bank-offscreen"),
        window("calc-1", desktop.displays[0]!.bounds, "approved-background"),
      ]
      const { header, image } = fake.capture({ display: desktop.displays[0]!.id })
      expect(header).toMatchObject({ ok: true, hiddenCount: 2 })
      expect(header.masked).toHaveLength(5)
      expect(pixel(image!, ...at(header, 10, 230))).toEqual(COLORS.mask)
      expect(pixel(image!, ...at(header, 210, 230))).toEqual(COLORS.vector)
      expectMaskedIsPainted(header, image!)
      fake.call("shutdown")
    })
  }

  test("a display capture shows approved apps and the desktop furniture, and paints everything else", () => {
    const fake = start()
    expect(fake.begin(["calculator"]).ok).toBe(true)
    const { header, image } = fake.capture({ display: "1" })
    expect(header).toMatchObject({ ok: true, width: 1000, height: 640, imageScale: 1, displayId: "1" })
    const color = (x: number, y: number) => pixel(image!, ...at(header, x, y))
    expect(color(60, 200)).toEqual(COLORS.calculator)
    // Notes overlaps Calculator's right edge; Calculator is in front there.
    expect(color(260, 200)).toEqual(COLORS.calculator)
    expect(color(400, 200)).toEqual(COLORS.mask)
    expect(color(700, 200)).toEqual(COLORS.mask) // Terminal
    expect(color(100, 450)).toEqual(COLORS.mask) // System Settings
    expect(color(500, 450)).toEqual(COLORS.mask) // the bank app, not approved
    expect(color(850, 50)).toEqual(COLORS.mask) // the notification toast
    expect(color(850, 400)).toEqual(COLORS.vector) // Vector's own window
    expect(color(10, 10)).toEqual(COLORS.menuBar)
    expect(color(5, 300)).toEqual(COLORS.wallpaper)
    // The overlay is excluded, so the frame shows what lies under it.
    const overlay = Array.from({ length: image!.width * image!.height }).some((_, i) =>
      same(pixel(image!, i % image!.width, Math.floor(i / image!.width)), COLORS.overlay),
    )
    expect(overlay).toBe(false)
    expectMaskedIsPainted(header, image!)
    expect(header.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test("an unapproved window above an approved one masks the overlap; the other way round it does not", () => {
    const fake = start()
    fake.begin(["calculator"])
    fake.control({ type: "focus", windowId: "notes-1" })
    const { header, image } = fake.capture({ display: "1" })
    expect(pixel(image!, ...at(header, 260, 200))).toEqual(COLORS.mask)
    expect(pixel(image!, ...at(header, 60, 200))).toEqual(COLORS.calculator)
    expectMaskedIsPainted(header, image!)
    fake.control({ type: "focus", windowId: "calc-1" })
    const again = fake.capture({ display: "1" })
    expect(pixel(again.image!, ...at(again.header, 260, 200))).toEqual(COLORS.calculator)
    expectMaskedIsPainted(again.header, again.image!)
  })

  test("the never floor beats the approved set: Terminal and Vector stay painted and refused", () => {
    const fake = start()
    fake.begin(["calculator", "terminal", "vector"])
    const { header, image } = fake.capture({ display: "1" })
    expect(pixel(image!, ...at(header, 700, 200))).toEqual(COLORS.mask)
    expect(pixel(image!, ...at(header, 850, 400))).toEqual(COLORS.vector)
    expect(fake.capture({ windowId: "terminal-1" }).header).toMatchObject({ ok: false, code: "protected" })
    expect(fake.capture({ windowId: "vector-1" }).header).toMatchObject({ ok: false, code: "protected" })
    const [x, y] = at(header, 700, 200)
    expect(
      fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }),
    ).toMatchObject({ ok: false, code: "protected" })
    expect(fake.call("app.activate", { identity: fake.identity("terminal") })).toMatchObject({ code: "protected" })
    expect(fake.call("ui.tree", { windowId: "terminal-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "protected",
    })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  })

  test("a zoom keeps painted blocks black and cannot stand in for the frame's coordinates", () => {
    const fake = start()
    fake.begin(["calculator"])
    const full = fake.capture({ display: "1" })
    const zoom = fake.capture({ display: "1" }, FULL_DISPLAY, {
      format: "png",
      zoom: { captureId: full.header.captureId, region: { x0: 200, y0: 150, x1: 320, y1: 250 } },
    })
    expect(zoom.header).toMatchObject({ ok: true, width: 120, height: 100 })
    expect(pixel(zoom.image!, 10, 50)).toEqual(COLORS.calculator)
    expect(pixel(zoom.image!, 100, 50)).toEqual(COLORS.mask)
    expectMaskedIsPainted(zoom.header, zoom.image!)
    const click = { x: 10, y: 50, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", { captureId: zoom.header.captureId, ...click })).toMatchObject({
      code: "stale_frame",
    })
    const zoomOfZoom = fake.call("capture", {
      target: { display: "1" },
      budget: FULL_DISPLAY,
      format: "png",
      zoom: { captureId: zoom.header.captureId, region: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    })
    expect(zoomOfZoom).toMatchObject({ ok: false, code: "stale_frame" })
  })

  test("a window capture holds only that window, and a minimized one reports paused", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["calculator", "notes"])
    const { header, image } = fake.capture({ windowId: "calc-1" })
    expect(header).toMatchObject({ ok: true, width: 240, height: 320, masked: [] })
    // Notes covers this part of Calculator on screen, but a window capture never includes another window.
    expect(pixel(image!, 230, 100)).toEqual(COLORS.calculator)
    fake.helper.desktop.minimize("calc-1")
    expect(fake.call("capture", { target: { windowId: "calc-1" }, budget: FULL_DISPLAY, format: "png" })).toEqual({
      id: expect.any(Number),
      ok: true,
      paused: true,
    })
  })
})

describe("stop and held input (INV-R3)", () => {
  function holding(options: FakeOptions = {}, session: Message = {}) {
    const fake = start(options)
    fake.helper.desktop.focus("calc-1")
    fake.begin(["calculator"], session)
    const hold = fake.send("input.hold", {
      pid: fake.helper.desktop.app("calculator")!.pid,
      combo: ["shift"],
      ms: 10_000,
    })
    expect(fake.reply(hold)).toBeUndefined()
    return { fake, hold }
  }
  const released = (fake: ReturnType<typeof start>, reason: string) =>
    fake.index((entry) => entry.kind === "release" && entry.reason === reason && entry.keys.includes("key:shift"))
  const answered = (fake: ReturnType<typeof start>, id: number) =>
    fake.index((entry) => entry.kind === "response" && entry.id === id)

  for (const platform of ["macos", "windows"] as const) {
    test(`${platform}: own-tagged stop keys and pointer events have no observable effect`, () => {
      const chord = platform === "macos" ? "Command+Shift+Escape" : "Control+Alt+Shift+Escape"
      const { fake, hold } = holding({ platform }, { stopChord: chord })
      fake.helper.desktop.cursor = { x: 100, y: 200 }
      const before = { log: fake.helper.log.length, seen: fake.seen.length, cursor: fake.helper.desktop.cursor }
      for (const event of [
        { kind: "key", key: "Escape" },
        { kind: "key", key: chord },
        { kind: "pointer", dx: 100, dy: 200 },
        { kind: "click" },
        { kind: "scroll", dx: 0, dy: 100 },
      ])
        fake.control({ type: "user_input", tagged: true, ...event })
      expect(fake.helper.log).toHaveLength(before.log)
      expect(fake.seen).toHaveLength(before.seen)
      expect(fake.helper.desktop.cursor).toEqual(before.cursor)
      expect(fake.reply(hold)).toBeUndefined()
      fake.control({ type: "user_input", kind: "key", key: "x" })
      expect(fake.reply(hold)).toMatchObject({ ok: false, code: "paused" })
      expect(released(fake, "user_input")).toBeGreaterThan(-1)
      expect(fake.seen.some((message) => message.event === "stop")).toBe(false)
    })

    test(`${platform}: a 7 DIP pointer packet keeps held input, while 8 DIP releases before notification`, () => {
      const { fake, hold } = holding({ platform, scenario: "multi-display" })
      // The second Windows monitor uses 150% DPI: 7 DIP advances 10.5 physical pixels without taking over.
      const scale = platform === "windows" ? 1.5 : 1
      fake.helper.desktop.cursor = { x: -650, y: -100 }
      fake.control({ type: "user_input", kind: "pointer", dx: 7, dy: 0 })
      expect(fake.helper.desktop.cursor).toEqual({ x: -650 + 7 * scale, y: -100 })
      expect(fake.seen.at(-1)).toEqual({
        event: "user_input",
        kind: "pointer",
        pid: fake.identity("notes").pid,
        dx: 7,
        dy: 0,
      })
      expect(fake.reply(hold)).toBeUndefined()
      expect(released(fake, "user_input")).toBe(-1)
      const before = fake.helper.log.length
      fake.control({ type: "user_input", kind: "pointer", dx: 8, dy: 0 })
      expect(fake.helper.desktop.cursor).toEqual({ x: -650 + 15 * scale, y: -100 })
      expect(fake.reply(hold)).toMatchObject({ ok: false, code: "paused" })
      const changes = fake.helper.log.slice(before)
      const release = changes.findIndex((entry) => entry.kind === "release" && entry.reason === "user_input")
      const event = changes.findIndex((entry) => entry.kind === "event" && entry.event === "user_input")
      expect(release).toBeGreaterThan(-1)
      expect(event).toBeGreaterThan(release)
    })
  }

  test("a pointer packet with missing deltas conservatively releases held input", () => {
    const { fake, hold } = holding()
    fake.control({ type: "user_input", kind: "pointer", dx: 0 })
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "paused" })
    expect(released(fake, "user_input")).toBeGreaterThan(-1)
  })

  for (const platform of ["macos", "windows"] as const)
    test(`${platform}: physical take-over fences queued input and all unpause updates until a fresh session`, () => {
      const fake = start({ platform })
      const pid = fake.identity("calculator").pid
      const phase = { sessionId: "native-takeover", phaseRevision: 7 }
      fake.begin(["calculator"], phase)
      const hold = fake.send("input.hold", { ...phase, pid, combo: ["Shift"], ms: 10_000 })
      const queued = fake.send("input.key", { ...phase, pid, combo: ["ArrowLeft"], repeat: 1 })
      // A newer revision may already be in transit before the physical event; it is not proof of Resume.
      const stale = fake.send("session.update", { ...phase, phaseRevision: 8, paused: false, escStops: true })
      expect(fake.reply(hold)).toBeUndefined()
      expect(fake.reply(queued)).toBeUndefined()
      fake.control({ type: "user_input", kind: "key", key: "x" })
      expect(fake.reply(hold)).toMatchObject({ ok: false, code: "paused" })
      expect(fake.reply(queued)).toMatchObject({ ok: false, code: "paused" })
      expect(fake.reply(stale)).toMatchObject({ ok: false, code: "changed" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "key")).toEqual([])
      expect(
        fake.call("session.update", { sessionId: "another-task", phaseRevision: 99, paused: false }),
      ).toMatchObject({
        code: "changed",
      })
      expect(fake.call("input.key", { ...phase, pid, combo: ["ArrowLeft"], repeat: 1 })).toMatchObject({
        code: "paused",
      })
      expect(fake.call("session.update", { ...phase, paused: false, escStops: true })).toMatchObject({
        code: "changed",
      })
      expect(fake.call("session.update", { ...phase, phaseRevision: 8, paused: false, escStops: true })).toMatchObject({
        code: "changed",
      })
      const resumed = { sessionId: "native-resumed", phaseRevision: 0 }
      expect(fake.begin(["calculator"], resumed)).toMatchObject({ ok: true })
      expect(fake.call("input.key", { ...resumed, pid, combo: ["ArrowLeft"], repeat: 1 })).toMatchObject({ ok: true })
      expect(fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "key")).toHaveLength(1)
    })

  test("legacy unphased physical take-over requires a fresh session rather than an unbound unpause", () => {
    const { fake, hold } = holding()
    const pid = fake.identity("calculator").pid
    const queued = fake.send("input.key", { pid, combo: ["ArrowLeft"], repeat: 1 })
    fake.control({ type: "user_input", kind: "pointer", dx: 8, dy: 0 })
    expect(fake.reply(hold)).toMatchObject({ code: "paused" })
    expect(fake.reply(queued)).toMatchObject({ code: "paused" })
    expect(fake.call("session.update", { paused: false })).toMatchObject({ code: "changed" })
    expect(fake.call("session.update", { sessionId: "test", phaseRevision: 1, paused: false })).toMatchObject({
      code: "changed",
    })
    fake.begin(["calculator"])
    expect(fake.call("input.key", { pid, combo: ["ArrowLeft"], repeat: 1 })).toMatchObject({ ok: true })
  })

  test("background events report actual key and pointer owners independently of app approval and omit key text", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["calculator"], { mode: "background", escStops: false })
    fake.control({ type: "user_input", kind: "key", key: "private physical key" })
    expect(fake.seen.at(-1)).toEqual({ event: "user_input", kind: "key", pid: fake.identity("notes").pid })
    fake.helper.desktop.cursor = { x: 60, y: 200 }
    for (const kind of ["pointer", "click", "scroll"]) fake.control({ type: "user_input", kind, dx: 0, dy: 0 })
    expect(fake.seen.slice(-3)).toEqual(
      ["pointer", "click", "scroll"].map((kind) => ({
        event: "user_input",
        kind,
        pid: fake.identity("calculator").pid,
        dx: 0,
        dy: 0,
      })),
    )
    expect(fake.helper.log.some((entry) => entry.kind === "release" && entry.reason === "user_input")).toBe(false)
    expect(JSON.stringify(fake.helper.log)).not.toContain("private physical key")
    fake.helper.desktop.cursor = { x: 2000, y: 2000 }
    fake.control({ type: "user_input", kind: "click" })
    expect(fake.seen.at(-1)).toEqual({ event: "user_input", kind: "click" })
  })

  test("user-input event owners are optional positive native PIDs", () => {
    const valid = Schema.is(Computer.HelperEvent)
    expect(valid({ event: "user_input", kind: "key" })).toBe(true)
    expect(valid({ event: "user_input", kind: "key", pid: 123 })).toBe(true)
    for (const pid of [0, -1, 1.5, Number.NaN, "123"])
      expect(valid({ event: "user_input", kind: "key", pid })).toBe(false)
  })

  test("Escape releases held input, then sends stop, and input stays stopped until the next session", () => {
    const { fake, hold } = holding()
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    const release = released(fake, "stop")
    const stop = fake.index((entry) => entry.kind === "event" && entry.event === "stop")
    expect(release).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(release)
    expect(fake.seen.find((message) => message.event === "stop")).toEqual({ event: "stop", by: "esc" })
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "stopped" })
    const pid = fake.helper.desktop.app("calculator")!.pid
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ code: "stopped" })
    fake.begin(["calculator"])
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
  })

  test("the stop chord stops too; with escStops off Escape is only user input, sent without the key", () => {
    const fake = start()
    fake.begin(["calculator"], { escStops: false })
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    expect(fake.seen.filter((message) => "event" in message)).toEqual([
      { event: "user_input", kind: "key", pid: fake.helper.desktop.frontmost().pid },
    ])
    expect(released(fake, "user_input")).toBe(-1)
    const userRelease = fake.index((entry) => entry.kind === "release" && entry.reason === "user_input")
    const userEvent = fake.index((entry) => entry.kind === "event" && entry.event === "user_input")
    expect(userRelease).toBeGreaterThan(-1)
    expect(userEvent).toBeGreaterThan(userRelease)
    fake.control({ type: "user_input", kind: "key", key: "Command+Shift+Escape" })
    expect(fake.seen.find((message) => message.event === "stop")).toEqual({ event: "stop", by: "chord" })
  })

  test("a missed heartbeat releases a hold in flight before it answers stopped, and latches until session.begin", () => {
    const { fake, hold } = holding()
    fake.advance(4_999)
    expect(fake.reply(hold)).toBeUndefined()
    fake.advance(1)
    expect(released(fake, "heartbeat")).toBeGreaterThan(-1)
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "heartbeat"))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "stopped" })
    const pid = fake.helper.desktop.app("calculator")!.pid
    // A late heartbeat does not undo the halt: only a new session does.
    expect(fake.call("heartbeat").ok).toBe(true)
    expect(fake.call("input.type", { pid, text: "1" })).toMatchObject({ code: "stopped" })
    fake.begin(["calculator"])
    expect(fake.call("input.type", { pid, text: "1" })).toMatchObject({ ok: true })
  })

  test("heartbeats every 2 s keep input working well past 5 s", () => {
    const fake = start()
    fake.begin(["calculator"])
    const pid = fake.helper.desktop.app("calculator")!.pid
    for (const _ of [2, 4, 6]) {
      fake.advance(2_000)
      expect(fake.call("heartbeat").ok).toBe(true)
    }
    fake.advance(1_000)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    fake.advance(3_999)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    fake.advance(1)
    expect(fake.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ code: "stopped" })
  })

  test("releaseAll ends a hold in flight and counts what it released", () => {
    const { fake, hold } = holding()
    const release = fake.send("input.releaseAll")
    expect(fake.reply(release)).toMatchObject({ ok: true, released: 1 })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "request"))
    expect(answered(fake, release)).toBeGreaterThan(answered(fake, hold))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "failed" })
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
  })

  test("cancel releases a hold before it answers, then answers the cancel", () => {
    const { fake, hold } = holding()
    const cancel = fake.send("cancel", { target: hold })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "cancel"))
    expect(answered(fake, cancel)).toBeGreaterThan(answered(fake, hold))
    expect(fake.reply(hold)).toMatchObject({ ok: false, code: "failed", error: "Cancelled" })
    expect(fake.reply(cancel)).toMatchObject({ ok: true })
  })

  test("end of input releases a hold, then exits 0", () => {
    const { fake } = holding()
    fake.channel.end()
    fake.drain()
    const exit = fake.index((entry) => entry.kind === "exit")
    expect(released(fake, "eof")).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(released(fake, "eof"))
    expect(fake.state.exit).toBe(0)
  })

  test("shutdown releases a hold, answers it, answers the shutdown, then exits 0", () => {
    const { fake, hold } = holding()
    const shutdown = fake.send("shutdown")
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "shutdown"))
    expect(answered(fake, shutdown)).toBeGreaterThan(answered(fake, hold))
    expect(fake.index((entry) => entry.kind === "exit")).toBeGreaterThan(answered(fake, shutdown))
    expect(fake.reply(hold)).toMatchObject({ code: "stopped" })
    expect(fake.state.exit).toBe(0)
  })

  test("cancel reaches a queued op under latency, and is a clean no-op once it has answered", () => {
    const fake = start({ latencyMs: 100 })
    fake.begin(["calculator"])
    fake.advance(100)
    const capture = fake.send("capture", { target: { display: "1" }, budget: FULL_DISPLAY, format: "png" })
    expect(fake.reply(capture)).toBeUndefined()
    expect(fake.call("cancel", { target: capture }).ok).toBe(true)
    expect(fake.reply(capture)).toMatchObject({ ok: false, code: "failed", error: "Cancelled" })
    fake.advance(100)
    expect(fake.images.size).toBe(0)
    expect(fake.call("cancel", { target: capture }).ok).toBe(true)
  })

  test("locking the screen releases input and refuses input and capture until it unlocks", () => {
    const { fake, hold } = holding()
    fake.control({ type: "lock", locked: true })
    expect(answered(fake, hold)).toBeGreaterThan(released(fake, "locked"))
    expect(fake.reply(hold)).toMatchObject({ code: "locked" })
    expect(fake.seen.find((message) => message.event === "locked")).toEqual({ event: "locked", locked: true })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ code: "locked" })
    fake.control({ type: "lock", locked: false })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ ok: true })
  })

  // M8: the helper never acts on the lock screen, and after a stop nothing comes to the front either.
  test("activation, launch and window focus refuse on a locked screen and after a stop", () => {
    const fake = start()
    fake.begin(["calculator", "notes", "textedit"])
    const desktop = fake.helper.desktop
    const order = desktop.stack().map((window) => window.windowId)
    const bringForward = () => [
      fake.call("app.launch", { identity: fake.identity("textedit") }),
      fake.call("app.activate", { identity: fake.identity("notes") }),
      fake.call("window.focus", { windowId: "notes-1" }),
    ]
    fake.control({ type: "lock", locked: true })
    expect(bringForward()).toMatchObject([{ code: "locked" }, { code: "locked" }, { code: "locked" }])
    fake.control({ type: "lock", locked: false })
    fake.control({ type: "user_input", kind: "key", key: "Escape" })
    expect(bringForward()).toMatchObject([{ code: "stopped" }, { code: "stopped" }, { code: "stopped" }])
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(desktop.app("textedit")!.running).toBe(false)
    expect(desktop.stack().map((window) => window.windowId)).toEqual(order)
    expect(fake.helper.log.filter((entry) => entry.kind === "app")).toEqual([])
    fake.begin(["calculator", "notes", "textedit"])
    expect(fake.call("window.focus", { windowId: "notes-1" })).toMatchObject({ ok: true, foreground: true })
    expect(desktop.frontmost().slot).toBe("notes")
  })
})

describe("the never floor from blocklist.json", () => {
  // Identities built from every pattern in the table, with each system and Apple flag, so the file a helper reads
  // decides exactly what ComputerApps decides.
  const identities = ComputerApps.TABLE.flatMap((entry) => [
    ...(entry.macos ?? []).flatMap((pattern) =>
      [true, false].flatMap((apple) =>
        [true, false].map((system) => ({
          app: {
            platform: "macos" as const,
            bundleId: pattern.replace(/\*$/, "x"),
            apple,
            system,
            verified: true,
            name: entry.name,
          },
          signals: {},
        })),
      ),
    ),
    ...(entry.windows?.aumid ?? []).flatMap((pattern) =>
      [true, false].map((system) => ({
        app: {
          platform: "windows" as const,
          kind: "aumid" as const,
          aumid: pattern.replace(/\*$/, "x"),
          system,
          verified: true,
          name: entry.name,
        },
        signals: {},
      })),
    ),
    ...(entry.windows?.binary ?? []).flatMap((binary) =>
      [true, false].map((system) => ({
        app: windowsExe(binary, system, entry.name),
        signals: {},
      })),
    ),
    ...(entry.windows?.windowClass ?? []).map((windowClass) => ({
      app: windowsExe("host.exe", false, entry.name),
      signals: { windowClass },
    })),
  ])

  function windowsExe(binary: string, system: boolean, name: string): Computer.AppIdentity {
    return {
      platform: "windows",
      kind: "exe",
      publisher: "Publisher",
      product: name,
      binary,
      system,
      verified: true,
      name,
      exe: `C:\\Apps\\${binary}`,
    }
  }

  test("agrees with ComputerApps on every table identity, with and without a child shell", () => {
    expect(identities.length).toBeGreaterThan(300)
    const disagreements = identities.flatMap(({ app, signals }) =>
      [signals, { ...signals, childShell: true }].flatMap((value) => {
        const category = blocklist.category(app, value)
        const never = ComputerApps.builtinRule(app, value)?.removable === false
        return category === ComputerApps.category(app, value) && blocklist.isProtected(app, value) === never
          ? []
          : [`${Computer.appKey(app)} ${JSON.stringify(value)}`]
      }),
    )
    expect(disagreements).toEqual([])
  })

  test("protects an unknown OS binary, allows a benign Apple app, and leaves Disk Utility to the desktop", () => {
    const mac = (bundleId: string, apple: boolean, system: boolean): Computer.AppIdentity => ({
      platform: "macos",
      bundleId,
      apple,
      system,
      verified: true,
      name: bundleId,
    })
    expect(blocklist.isProtected(mac("com.apple.someagent", true, true))).toBe(true)
    expect(blocklist.isProtected(mac("com.apple.Notes", true, true))).toBe(false)
    // A benign entry needs an Apple-anchored signature.
    expect(blocklist.isProtected(mac("com.apple.Notes", false, true))).toBe(true)
    const disk = mac("com.apple.DiskUtility", true, true)
    expect(blocklist.isProtected(disk)).toBe(false)
    expect(blocklist.category(disk)).toBe("general")
    expect(ComputerApps.builtinRule(disk)).toMatchObject({ removable: true, reason: "user" })
    expect(blocklist.category(mac("com.jetbrains.intellij", false, false), { childShell: true })).toBe(
      ComputerApps.category(mac("com.jetbrains.intellij", false, false), { childShell: true }),
    )
  })

  test("every fake app and window has its intended category", () => {
    const intended = {
      macos: {
        [OVERLAY]: "vector",
        "toast-1": "security",
        "calc-1": "general",
        "notes-1": "office",
        "bank-1": "general",
        "settings-1": "security",
        "terminal-1": "terminal",
        "vector-1": "vector",
        "menubar-1": "system-ui",
        "dock-1": "system-ui",
        "wallpaper-1": "system-ui",
      },
      windows: {
        [OVERLAY]: "vector",
        "toast-1": "security",
        "calc-1": "general",
        "notes-1": "general",
        "bank-1": "general",
        "settings-1": "security",
        "terminal-1": "terminal",
        "vector-1": "vector",
        "taskbar-1": "system-ui",
        "wallpaper-1": "system-ui",
      },
    } as const
    for (const platform of ["macos", "windows"] as const) {
      const desktop = start({ platform }).helper.desktop
      const categories = Object.fromEntries(
        desktop
          .stack()
          .map((window) => [
            window.windowId,
            ComputerApps.category(
              desktop.appOf(window).identity,
              window.windowClass ? { windowClass: window.windowClass } : {},
            ),
          ]),
      )
      expect(categories).toEqual(intended[platform])
      expect(ComputerApps.category(desktop.app("textedit")!.identity)).toBe("office")
      expect(ComputerApps.category(desktop.app("ide")!.identity)).toBe("developer")
      expect(blocklist.isClickOnly(desktop.app("ide")!.identity)).toBe(true)
      expect(blocklist.isClickOnly(desktop.app("textedit")!.identity)).toBe(false)
    }
  })
})

describe("approval and the refusals", () => {
  test("approval matches the exact app key, escaped exe parts included", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    const notes = fake.identity("notes")
    expect(Computer.appKey(notes)).toBe("app:windows:exe:contoso ltd.|notes %7c pro 100%25|contosonotes.exe")
    // The same text written already escaped is a different app.
    const lookalike = { ...notes, product: "Notes %7c Pro 100%25" }
    fake.begin([], { approved: [lookalike], vectorPids: [600] })
    const display = "\\\\.\\DISPLAY1"
    const first = fake.capture({ display })
    expect(pixel(first.image!, ...at(first.header, 400, 200))).toEqual(COLORS.mask)
    const [x, y] = at(first.header, 400, 200)
    const click = { captureId: first.header.captureId, x, y, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", click)).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [notes] })
    const second = fake.capture({ display })
    expect(pixel(second.image!, ...at(second.header, 400, 200))).toEqual(COLORS.notes)
    expect(fake.call("input.click", { ...click, captureId: second.header.captureId })).toMatchObject({ ok: true })
  })

  test("a secure field refuses typing and setValue, never shows a value, and reports secure input in front", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    const pid = fake.helper.desktop.app("notes")!.pid
    expect(fake.call("input.type", { pid, text: " list" })).toMatchObject({ ok: true })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    expect(fake.seen.at(-1)).toEqual({
      event: "input_detection",
      alive: false,
      reason: "secure_input",
      holder: "Notes",
    })
    expect(fake.call("input.type", { pid, text: "hunter2" })).toMatchObject({ code: "secure_field" })
    // Key by key is typing too (INV-S4); navigation and editing keys and shortcuts are not, so a handoff still works.
    // The rule fails closed: a key it does not know types, and Option is a text modifier on macOS (Option+S is ß).
    for (const combo of [
      ["h"],
      ["Shift", "H"],
      ["KeyH"],
      ["space"],
      ["AltGr", "2"],
      ["h", "2"],
      ["IntlBackslash"],
      ["IntlRo"],
      ["NumpadEqual"],
      ["NumpadComma"],
      ["Option", "KeyS"],
      ["Alt", "Shift", "k"],
      ["fn", "e"],
      ["Command", "v"],
      ["Control", "KeyV"],
      ["Shift", "Insert"],
    ])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "secure_field" })
    expect(fake.call("input.hold", { pid, combo: ["h"], ms: 1000 })).toMatchObject({ code: "secure_field" })
    expect(fake.call("input.hold", { pid, combo: ["IntlYen"], ms: 1000 })).toMatchObject({ code: "secure_field" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(1)
    for (const combo of [
      ["Tab"],
      ["Enter"],
      ["Backspace"],
      ["ArrowLeft"],
      ["Command", "a"],
      ["Control", "a"],
      ["Shift"],
      ["Option", "ArrowLeft"],
      ["Escape"],
      ["PageDown"],
      ["F5"],
      ["MediaPlayPause"],
    ])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
    const tree = fake.call("ui.tree", { pid, maxNodes: 50, maxDepth: 4 })
    const password = tree.nodes.find((item: Message) => item.secure)
    expect(password).toMatchObject({ role: "AXSecureTextField", focused: true })
    expect(password).not.toHaveProperty("value")
    expect(tree.nodes.find((item: Message) => item.name === "Title").value).toBe("Groceries list")
    expect(fake.call("ui.setValue", { ref: password.ref, value: "hunter2" })).toMatchObject({ code: "secure_field" })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    expect(fake.seen.at(-1)).toEqual({ event: "input_detection", alive: true })
    expect(JSON.stringify(fake.helper.log)).not.toContain("hunter2")
  })

  // Windows: Ctrl+Alt is AltGr, and Alt with numpad digits types an Alt code; Alt or Ctrl alone is a shortcut.
  test("on Windows a secure field refuses AltGr and Alt-code typing but takes shortcuts", () => {
    const fake = start({ platform: "windows", scenario: "notes" })
    fake.begin(["notes"])
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    const pid = fake.helper.desktop.app("notes")!.pid
    for (const combo of [
      ["Control", "Alt", "KeyQ"],
      ["Ctrl", "Alt", "2"],
      ["Alt", "Numpad2"],
      ["IntlBackslash"],
      ["Control", "v"],
      ["Ctrl", "Shift", "KeyV"],
      ["Shift", "Insert"],
    ])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "secure_field" })
    for (const combo of [["Control", "a"], ["Alt", "f"], ["Win", "d"], ["Control", "Alt", "Delete"], ["Tab"]])
      expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
  })

  // Secure event input is a macOS signal (M6); Windows has no such state (W9 lists its own reasons). On macOS the event
  // follows every way an app comes to the front, AXRaise included.
  test("secure input is reported on macOS only, and also when AXRaise brings the secure field forward", () => {
    const windows = start({ platform: "windows", scenario: "notes" })
    windows.begin(["notes"])
    windows.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    expect(windows.seen.filter((message) => "event" in message)).toEqual([])
    const pid = windows.helper.desktop.app("notes")!.pid
    expect(windows.call("input.type", { pid, text: "x" })).toMatchObject({ code: "secure_field" })

    const mac = start({ scenario: "notes" })
    mac.begin(["calculator", "notes"])
    mac.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    mac.control({ type: "focus", windowId: "calc-1" })
    const events = () => mac.seen.filter((message) => "event" in message)
    expect(events()).toEqual([
      { event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" },
      { event: "input_detection", alive: true },
    ])
    const tree = mac.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 1 })
    expect(mac.call("ui.perform", { ref: tree.nodes[0].ref, action: "AXRaise" })).toMatchObject({
      ok: true,
      took: true,
    })
    expect(mac.helper.desktop.frontmost().slot).toBe("notes")
    expect(events().at(-1)).toEqual({ event: "input_detection", alive: false, reason: "secure_input", holder: "Notes" })
  })

  // Section 7: typed text is kept as a length only, whichever op typed it, and the user's own keys are never kept.
  test("the action log keeps typed keys as a length and shortcuts as their combo", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    const pid = fake.helper.desktop.app("notes")!.pid
    for (const key of ["h", "u", "n", "t", "e", "r", "2"])
      expect(fake.call("input.key", { pid, combo: [key], repeat: 1 })).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid, combo: ["Shift", "KeyQ"], repeat: 3 })).toMatchObject({ ok: true })
    const hold = fake.send("input.hold", { pid, combo: ["Shift", "z"], ms: 100 })
    fake.advance(100)
    expect(fake.reply(hold)).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid, combo: ["Command", "s"], repeat: 1 })).toMatchObject({ ok: true })
    fake.control({ type: "user_input", kind: "key", key: "j" })
    const input = fake.helper.log.filter((entry) => entry.kind === "input")
    expect(input).toHaveLength(10)
    expect(input.slice(0, 7)).toEqual(
      Array.from({ length: 7 }, () => expect.objectContaining({ op: "key", types: true, length: 1 })),
    )
    expect(input[7]).toMatchObject({ op: "key", types: true, length: 3 })
    expect(input[8]).toMatchObject({ op: "hold", types: true, ms: 100 })
    expect(input.slice(0, 9).every((entry) => !("combo" in entry))).toBe(true)
    expect(input[9]).toMatchObject({ op: "key", combo: ["Command", "s"], repeat: 1 })
    const log = JSON.stringify(fake.helper.log)
    for (const text of ['"h"', '"r"', '"2"', "KeyQ", '"z"', "key:z", '"j"']) expect(log).not.toContain(text)
    expect(log).toContain("key:Shift")
  })

  // 1.5 E and M9: Alongside me acts through the target's elements and app-directed keys without moving the pointer or
  // taking focus; a step that needs the real pointer, or that would bring something forward, answers needs_foreground
  // with no side effect, so the desktop can raise the pointer ask (D19).
  test("a background session acts through elements without taking focus; anything else needs the foreground", () => {
    const fake = start({ scenario: "notes" })
    expect(fake.begin(["calculator", "notes", "textedit"], { mode: "background" })).toMatchObject({ ok: true })
    const desktop = fake.helper.desktop
    const order = () => desktop.stack().map((window) => window.windowId)
    const before = order()
    const pointer = (op: string, x: number, y: number, extra: Message = {}) => {
      const { header } = fake.capture({ display: "1" })
      const [px, py] = at(header, x, y)
      return fake.call(op, { captureId: header.captureId, x: px, y: py, ...extra })
    }
    const click = (x: number, y: number, extra: Message = {}) =>
      pointer("input.click", x, y, { button: "left", count: 1, modifiers: [], ...extra })
    const drag = () => {
      const { header } = fake.capture({ display: "1" })
      const [px, py] = at(header, 70, 170)
      const path = [
        { x: px, y: py },
        { x: px + 5, y: py },
      ]
      return fake.call("input.drag", { captureId: header.captureId, path, button: "left", modifiers: [] })
    }
    // Calculator's 7 behind Notes: pressed through its element.
    expect(click(70, 170)).toMatchObject({ ok: true })
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 50, maxDepth: 4 }).nodes[1].value).toBe("7")
    expect(desktop.frontmost().slot).toBe("notes")
    expect(order()).toEqual(before)
    // Notes' body behind Calculator: focused through its element, then typed into with app-directed keys.
    fake.control({ type: "focus", windowId: "calc-1" })
    const behind = order()
    expect(click(400, 200)).toMatchObject({ ok: true })
    const notes = desktop.app("notes")!.pid
    expect(fake.call("input.type", { pid: notes, text: " list" })).toMatchObject({ ok: true })
    expect(fake.call("input.key", { pid: notes, combo: ["Enter"], repeat: 1 })).toMatchObject({ ok: true })
    expect(desktop.window("notes-1")!.nodes.find((item) => item.id === "notes.body")!.value).toBe("Milk, eggs list")
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(order()).toEqual(behind)
    const acted = fake.helper.log.filter((entry) => entry.kind === "input").length
    // Everything that needs the real pointer or would take focus.
    const needs = [
      click(590, 120), // Notes, but no element there
      click(60, 100), // Calculator's display: an element with nothing to press or focus
      click(70, 170, { button: "right" }),
      click(70, 170, { count: 2 }),
      click(70, 170, { modifiers: ["shift"] }),
      pointer("input.move", 70, 170),
      pointer("input.scroll", 400, 200, { dx: 0, dy: 3 }),
      drag(),
      fake.call("app.activate", { identity: fake.identity("notes") }),
      fake.call("app.launch", { identity: fake.identity("textedit") }),
      fake.call("window.focus", { windowId: "notes-1" }),
      fake.call("ui.perform", {
        ref: fake.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 1 }).nodes[0].ref,
        action: "AXRaise",
      }),
    ]
    expect(needs.map((reply) => reply.code)).toEqual(Array.from({ length: needs.length }, () => "needs_foreground"))
    // The never floor and the approved set still answer first.
    expect(click(700, 200)).toMatchObject({ code: "protected" })
    expect(click(500, 500)).toMatchObject({ code: "not_granted" })
    expect(order()).toEqual(behind)
    desktop.minimize("notes-1")
    expect(fake.call("input.type", { pid: notes, text: "x" })).toMatchObject({ code: "needs_foreground" })
    expect(desktop.window("notes-1")!.minimized).toBe(true)
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(acted)
    expect(desktop.frontmost().slot).toBe("calculator")
    expect(desktop.app("textedit")!.running).toBe(false)
  })

  test("a helper without background support refuses a background session", () => {
    for (const options of [{ platform: "windows" }, { disabled: ["background"] }] satisfies FakeOptions[]) {
      const fake = start(options)
      expect(fake.call("hello", { protocol: { min: 1, max: 1 } }).features.background).toBe(false)
      expect(fake.begin(["calculator"], { mode: "background" })).toMatchObject({ code: "unsupported_action" })
      expect(fake.capture({ display: fake.helper.desktop.displays[0]!.id }).header).toMatchObject({
        code: "unavailable",
      })
      expect(fake.begin(["calculator"]).ok).toBe(true)
      expect(fake.call("session.update", { mode: "background" })).toMatchObject({ code: "unsupported_action" })
      expect(fake.call("session.update", { mode: "foreground" }).ok).toBe(true)
    }
  })

  // M6 and W7: IDEs are click-only, so the helper refuses typing into them too, whatever the desktop's gate decided.
  test("a developer app is click-only: clicks, shortcuts and navigation keys work, text input is refused", () => {
    for (const platform of ["macos", "windows"] as const) {
      const fake = start({ platform })
      fake.begin(["ide"])
      expect(fake.call("app.launch", { identity: fake.identity("ide") })).toMatchObject({ ok: true, foreground: true })
      const pid = fake.helper.desktop.app("ide")!.pid
      expect(fake.call("input.type", { pid, text: "rm -rf build" })).toMatchObject({ code: "blocked" })
      // Option types on macOS and Ctrl+Alt is AltGr on Windows; an unknown key name types too.
      const typing = platform === "macos" ? ["Option", "KeyS"] : ["Control", "Alt", "KeyQ"]
      for (const combo of [["x"], ["Shift", "X"], ["KeyX"], ["Digit4"], ["space"], ["IntlBackslash"], typing])
        expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "blocked" })
      expect(fake.call("input.hold", { pid, combo: ["x"], ms: 500 })).toMatchObject({ code: "blocked" })
      const tree = fake.call("ui.tree", { pid, maxNodes: 50, maxDepth: 4 })
      const editor = tree.nodes.find((item: Message) => item.role === "AXTextArea")
      expect(fake.call("ui.setValue", { ref: editor.ref, value: "x" })).toMatchObject({ code: "blocked" })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      const shortcut = platform === "macos" ? "Command" : "Control"
      for (const combo of [
        [shortcut, "v"],
        [shortcut, "Shift", "KeyV"],
        ["Shift", "Insert"],
      ]) {
        expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ code: "blocked" })
        expect(fake.call("input.hold", { pid, combo, ms: 500 })).toMatchObject({ code: "blocked" })
      }
      for (const combo of [[shortcut, "s"], ["Enter"], ["ArrowDown"], ["Tab"]])
        expect(fake.call("input.key", { pid, combo, repeat: 1 })).toMatchObject({ ok: true })
      const { header, image } = fake.capture({ display: platform === "macos" ? "1" : "\\\\.\\DISPLAY1" })
      const [x, y] = at(header, 400, 300)
      expect(pixel(image!, x, y)).toEqual(COLORS.ide)
      expect(
        fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }),
      ).toMatchObject({ ok: true })
      expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({
        op: "click",
        windowId: "ide-1",
        node: "ide.text",
      })
    }
  })

  test("ui.tree refuses protected and unapproved apps; refs go stale when the UI changes", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(fake.call("ui.tree", { windowId: "terminal-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "protected",
    })
    expect(fake.call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 4 })).toMatchObject({
      code: "not_granted",
    })
    const tree = fake.call("ui.tree", { pid: fake.helper.desktop.app("calculator")!.pid, maxNodes: 50, maxDepth: 4 })
    const seven = tree.nodes.find((item: Message) => item.name === "7")
    expect(fake.call("ui.perform", { ref: seven.ref, action: "AXPress" })).toMatchObject({ ok: true, took: true })
    expect(fake.call("ui.perform", { ref: seven.ref, action: "AXPress" })).toMatchObject({ code: "stale_ref" })
    const after = fake.call("ui.tree", { windowId: "calc-1", maxNodes: 50, maxDepth: 4 })
    expect(after.nodes.find((item: Message) => item.name === "Display").value).toBe("7")
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 3, maxDepth: 4 })).toMatchObject({
      truncated: true,
      nodes: expect.any(Array),
    })
  })

  test("a hit-test names the owner of any window, but the element only in an approved app", () => {
    const fake = start()
    fake.begin(["calculator"])
    const { header } = fake.capture({ display: "1" })
    const hit = (x: number, y: number) => {
      const [px, py] = at(header, x, y)
      return fake.call("ui.hittest", { captureId: header.captureId, x: px, y: py })
    }
    const terminal = hit(700, 200)
    expect(terminal).toMatchObject({
      ok: true,
      windowId: "terminal-1",
      owner: fake.identity("terminal"),
      secure: false,
    })
    expect(terminal).not.toHaveProperty("name")
    expect(terminal).not.toHaveProperty("ref")
    expect(terminal).not.toHaveProperty("elementId")
    expect(terminal).not.toHaveProperty("windowTitle")
    const notes = hit(400, 200)
    expect(notes).toMatchObject({ windowId: "notes-1", owner: fake.identity("notes") })
    expect(notes).not.toHaveProperty("name")
    expect(notes).not.toHaveProperty("elementId")
    expect(notes).not.toHaveProperty("windowTitle")
    expect(hit(70, 170)).toMatchObject({ windowId: "calc-1", role: "AXButton", name: "7", ref: expect.any(String) })
  })

  test("pointer input checks the frame first, then the owner, and acts on the window under the point", () => {
    const fake = start()
    fake.begin(["calculator"])
    const { header } = fake.capture({ display: "1" })
    const click = (x: number, y: number) =>
      fake.call("input.click", { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] })
    expect(click(-1, 5)).toMatchObject({ code: "out_of_bounds" })
    expect(click(1000, 5)).toMatchObject({ code: "out_of_bounds" })
    expect(click(...at(header, 400, 200))).toMatchObject({ code: "not_granted" })
    expect(click(...at(header, 10, 10))).toMatchObject({ code: "not_granted" }) // the menu bar is never a target
    expect(click(...at(header, 70, 170))).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toMatchObject([
      { op: "click", windowId: "calc-1", node: "calculator.7" },
    ])
    // Raising Notes over the point means a different window is there now.
    fake.helper.desktop.raise("notes-1")
    expect(click(...at(header, 260, 200))).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [fake.identity("calculator"), fake.identity("notes")] })
    expect(click(...at(header, 260, 200))).toMatchObject({ code: "changed" })
    fake.helper.desktop.move("calc-1", { x: 41, y: 60, w: 240, h: 320 })
    expect(click(...at(header, 70, 170))).toMatchObject({ code: "stale_frame" })
  })

  test("keyboard input goes only to the focused app the step named", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(
      fake.call("input.key", { pid: fake.helper.desktop.app("notes")!.pid, combo: ["a"], repeat: 1 }),
    ).toMatchObject({ code: "changed" })
    fake.control({ type: "focus", windowId: "terminal-1" })
    expect(fake.call("input.type", { pid: fake.helper.desktop.app("terminal")!.pid, text: "rm -rf ~" })).toMatchObject({
      code: "protected",
    })
  })

  test("focused observations retain field identity across value changes and scope it to the helper session", () => {
    const fake = start({ scenario: "notes" })
    fake.begin(["notes"])
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
    const before = fake.call("ui.focused")
    expect(before).toMatchObject({
      enabled: true,
      editable: true,
      windowTitle: "Groceries",
      layout: { platform: "macos", keys: { KeyQ: { key: "q", shift: "Q" } } },
      focusedMenuShortcuts: [],
    })
    expect(typeof before.elementId).toBe("string")
    expect(
      fake.call("input.type", {
        pid: fake.helper.desktop.app("notes")!.pid,
        windowId: before.windowId,
        ref: before.ref,
        text: "z",
      }),
    ).toMatchObject({ ok: true })
    const after = fake.call("ui.focused")
    expect(after.ref).not.toBe(before.ref)
    expect(after.elementId).toBe(before.elementId)
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    const title = fake.call("ui.focused")
    expect(title.elementId).not.toBe(before.elementId)
    fake.begin(["notes"])
    expect(fake.call("ui.focused").elementId).not.toBe(title.elementId)
  })

  for (const target of [
    { platform: "macos", mode: "foreground" },
    { platform: "windows", mode: "foreground" },
    { platform: "macos", mode: "background" },
  ] as const)
    test(`${target.platform} ${target.mode} keyboard input binds the focused window and element`, () => {
      const fake = start({ scenario: "notes", platform: target.platform })
      fake.begin(["notes", "calculator"], { mode: target.mode })
      fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
      const pid = fake.helper.desktop.app("notes")!.pid
      const before = fake.call("ui.focused")
      const inputs = [
        { op: "input.type", text: "z" },
        { op: "input.key", combo: ["ArrowLeft"], repeat: 1 },
        { op: "input.hold", combo: ["ArrowLeft"], ms: 0 },
      ]
      for (const input of inputs)
        expect(fake.call(input.op, { ...input, pid, windowId: "calc-1" })).toMatchObject({ code: "changed" })
      fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
      expect(fake.call("ui.focused")).toMatchObject({ owner: { pid }, windowId: before.windowId, name: "Title" })
      for (const input of inputs)
        expect(fake.call(input.op, { ...input, pid, windowId: before.windowId, ref: before.ref })).toMatchObject({
          code: "changed",
        })
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
      for (const input of inputs) {
        const live = fake.call("ui.focused")
        const id = fake.send(input.op, { ...input, pid, windowId: live.windowId, ref: live.ref })
        fake.advance(0)
        expect(fake.reply(id)).toMatchObject({ ok: true })
      }
      expect(fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value).toBe(
        "Groceriesz",
      )
      expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(3)
    })

  test("the focused reference is checked after a queued typing request reaches the helper", () => {
    const fake = start({ scenario: "notes", latencyMs: 100 })
    fake.begin(["notes"])
    fake.advance(100)
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
    const focused = fake.send("ui.focused")
    fake.advance(100)
    const before = fake.reply(focused)!
    const typing = fake.send("input.type", {
      pid: fake.helper.desktop.app("notes")!.pid,
      windowId: before.windowId,
      ref: before.ref,
      text: "z",
    })
    fake.control({ type: "focus", windowId: "notes-1", node: "notes.title" })
    fake.advance(100)
    expect(fake.reply(typing)).toMatchObject({ code: "changed" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
    expect(fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.title")!.value).toBe(
      "Groceries",
    )
  })

  test("activation and launch follow the approved set", () => {
    const fake = start()
    fake.begin(["calculator"])
    expect(fake.call("app.activate", { identity: fake.identity("notes") })).toMatchObject({ code: "not_granted" })
    expect(fake.call("window.focus", { windowId: "settings-1" })).toMatchObject({ code: "protected" })
    expect(fake.call("app.launch", { identity: fake.identity("textedit") })).toMatchObject({ code: "not_granted" })
    fake.call("session.update", { approved: [fake.identity("calculator"), fake.identity("textedit")] })
    expect(fake.call("app.launch", { path: "/System/Applications/TextEdit.app" })).toMatchObject({
      ok: true,
      foreground: true,
    })
    expect(fake.helper.desktop.frontmost().slot).toBe("textedit")
  })

  test("apps.list and input.releaseAll work without a session; ops that act need one", () => {
    const fake = start()
    const list = fake.call("apps.list")
    const titles = Object.fromEntries(
      list.apps.flatMap((app: Message) => app.windows.map((window: Message) => [window.windowId, window.title])),
    )
    expect(titles["calc-1"]).toBe("Calculator")
    expect(titles["terminal-1"]).toBe("")
    expect(titles["settings-1"]).toBe("")
    expect(titles["vector-1"]).toBe("")
    expect(list.apps.some((app: Message) => app.identity.name === "TextEdit")).toBe(false)
    const installed = fake.call("apps.list", { installed: true })
    expect(installed.apps.find((app: Message) => app.identity.name === "TextEdit")).toMatchObject({
      active: false,
      windows: [],
    })
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
    expect(fake.capture({ display: "1" }).header).toMatchObject({ code: "unavailable" })
    expect(fake.call("input.key", { pid: 501, combo: ["a"], repeat: 1 })).toMatchObject({ code: "unavailable" })
    fake.begin(["calculator"])
    expect(fake.call("session.end").ok).toBe(true)
    expect(fake.call("apps.list").ok).toBe(true)
    expect(fake.call("input.releaseAll")).toMatchObject({ ok: true, released: 0 })
  })
})

describe("coordinates", () => {
  test("downscaling stays within every budget limit after rounding", () => {
    const budgets = [
      { maxWidth: 1280, maxHeight: 800, maxPixels: 1_048_576 },
      { maxWidth: 4096, maxHeight: 4096, maxPixels: 100_003 },
      { maxWidth: 333, maxHeight: 4096, maxPixels: 4096 * 4096 },
      { maxWidth: 16_384, maxHeight: 16_384, maxPixels: 100 },
      { maxWidth: 1, maxHeight: 1, maxPixels: 1 },
    ]
    for (const size of [
      [2000, 1280],
      [1601, 999],
      [10_000, 1],
      [1, 10_000],
      [640, 400],
    ] as const)
      for (const budget of budgets) {
        const out = fit(size[0], size[1], budget)
        expect(out.width).toBeGreaterThanOrEqual(1)
        expect(out.height).toBeGreaterThanOrEqual(1)
        expect(out.width).toBeLessThanOrEqual(Math.min(budget.maxWidth, size[0]))
        expect(out.height).toBeLessThanOrEqual(Math.min(budget.maxHeight, size[1]))
        expect(out.width * out.height).toBeLessThanOrEqual(budget.maxPixels)
        // Each pixel's centre lies inside the target at the reported scale, unless a side had to be raised to one.
        expect(out.width === 1 || out.width - 0.5 < size[0] * out.scale).toBe(true)
        expect(out.height === 1 || out.height - 0.5 < size[1] * out.scale).toBe(true)
      }
    expect(fit(640, 400, FULL_DISPLAY)).toEqual({ width: 640, height: 400, scale: 1 })
  })

  // When the two sides round down differently, imageScale must still be the one scale both sides were cut with:
  // the smaller of the two ratios would map the last column or row outside the target and leave it unpainted.
  test("a capture under an odd budget paints every pixel and maps its last column and row into the target", () => {
    const fake = start()
    fake.begin(["calculator"])
    const unbounded = { maxHeight: 4096, maxPixels: 4096 * 4096 }
    const opaque = (image: Image) => image.rgba.every((value, index) => index % 4 !== 3 || value === 255)
    const display = fake.capture({ display: "1" }, { maxWidth: 999, ...unbounded })
    expect(display.header).toMatchObject({ ok: true, width: 999, height: 639, imageScale: 0.999 })
    expect(opaque(display.image!)).toBe(true)
    expectMaskedIsPainted(display.header, display.image!)
    const right = display.header.width - 1
    const bottom = display.header.height - 1
    for (const [x, y, windowId] of [
      [right, 0, "menubar-1"],
      [right, bottom, "wallpaper-1"],
      [0, bottom, "wallpaper-1"],
    ] as const)
      expect(fake.call("ui.hittest", { captureId: display.header.captureId, x, y })).toMatchObject({
        ok: true,
        windowId,
      })
    const window = fake.capture({ windowId: "calc-1" }, { maxWidth: 239, ...unbounded })
    expect(window.header).toMatchObject({ ok: true, width: 239, height: 318 })
    const image = window.image!
    expect(
      Array.from({ length: image.width * image.height }).every((_, i) =>
        same(pixel(image, i % image.width, Math.floor(i / image.width)), COLORS.calculator),
      ),
    ).toBe(true)
    const click = { captureId: window.header.captureId, button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", { ...click, x: image.width - 1, y: image.height - 1 })).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "calc-1" })
  })

  test("a downscaled capture of a second display with a negative origin maps back to the right window", () => {
    const fake = start({ scenario: "multi-display" })
    fake.begin(["notes"])
    const displays = fake.call("displays.list").displays
    expect(displays).toContainEqual({
      id: "2",
      bounds: { x: -800, y: -200, w: 800, h: 500 },
      pixelSize: { w: 1600, h: 1000 },
      scale: 2,
      primary: false,
    })
    const budget = { maxWidth: 1000, maxHeight: 1000, maxPixels: 500_000 }
    const { header, image } = fake.capture({ display: "2" }, budget)
    expect(header).toMatchObject({ ok: true, origin: { x: -800, y: -200 }, displayId: "2" })
    expect(header.width).toBeLessThanOrEqual(budget.maxWidth)
    expect(header.width * header.height).toBeLessThanOrEqual(budget.maxPixels)
    expect(header.imageScale).toBeLessThan(2)
    const point = at(header, -500, 0)
    expect(pixel(image!, ...point)).toEqual(COLORS.notes)
    expect(fake.call("ui.hittest", { captureId: header.captureId, x: point[0], y: point[1] })).toMatchObject({
      windowId: "notes-1",
      owner: fake.identity("notes"),
    })
    const click = { captureId: header.captureId, x: point[0], y: point[1], button: "left", count: 1, modifiers: [] }
    expect(fake.call("input.click", click)).toMatchObject({ ok: true })
    expect(fake.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "notes-1" })
    // A zoom of the downscaled frame comes back at the display's native resolution.
    const zoom = fake.capture({ display: "2" }, FULL_DISPLAY, {
      zoom: { captureId: header.captureId, region: { x0: 0, y0: 0, x1: 100, y1: 50 } },
    })
    expect(zoom.header.ok).toBe(true)
    expect(zoom.header.imageScale).toBeCloseTo(2, 1)
    expect(zoom.header.width).toBeGreaterThan(100)
    fake.control({ type: "display_change" })
    expect(fake.seen.at(-1)).toEqual({ event: "display_change" })
    expect(fake.call("input.click", click)).toMatchObject({ code: "stale_frame" })
    expect(fake.call("ui.hittest", { captureId: header.captureId, x: point[0], y: point[1] })).toMatchObject({
      code: "stale_frame",
    })
  })
})

describe("options", () => {
  test("hello answers its own range and refuses a range it does not share", () => {
    const fake = start({ protocol: { min: 2, max: 2 } })
    expect(fake.call("hello", { protocol: { min: 1, max: 1 } })).toMatchObject({
      ok: false,
      code: "helper_incompatible",
    })
    expect(fake.call("hello", { protocol: { min: 1, max: 2 } })).toMatchObject({
      ok: true,
      protocol: { min: 2, max: 2 },
    })
  })

  test("a feature turned off is reported in hello and its op answers unsupported_action", () => {
    const fake = start({ disabled: ["ui.tree"] })
    const hello = fake.call("hello", { protocol: { min: 1, max: 1 } })
    expect(hello.features).toMatchObject({ "ui.tree": false, "capture.display": true, locked: false, background: true })
    fake.begin(["calculator"])
    expect(fake.call("ui.tree", { windowId: "calc-1", maxNodes: 10, maxDepth: 2 })).toMatchObject({
      code: "unsupported_action",
    })
    expect(start({ platform: "windows" }).call("hello", { protocol: { min: 1, max: 1 } }).features.background).toBe(
      false,
    )
  })

  // W2's dispatch table: Windows has no permission prompt to request or reset, and no clipboard ops.
  test("on Windows permissions.request, permissions.reset and the clipboard answer unsupported_action", () => {
    const windows = start({ platform: "windows" })
    expect(windows.call("hello", { protocol: { min: 1, max: 1 } }).features).toMatchObject({ clipboard: false })
    for (const op of ["permissions.request", "permissions.reset"])
      expect(windows.call(op, { service: "screen" })).toMatchObject({ code: "unsupported_action" })
    windows.begin(["calculator"])
    expect(windows.call("clipboard.write", { text: "4" })).toMatchObject({ code: "unsupported_action" })
    expect(windows.call("clipboard.read")).toMatchObject({ code: "unsupported_action" })
    expect(windows.helper.log.filter((entry) => entry.kind === "permissions" || entry.kind === "clipboard")).toEqual([])
    const mac = start()
    expect(mac.call("hello", { protocol: { min: 1, max: 1 } }).features).toMatchObject({ clipboard: true })
    expect(mac.call("permissions.reset", { service: "screen" })).toMatchObject({ ok: true })
    mac.begin(["calculator"])
    expect(mac.call("clipboard.write", { text: "4" }).ok).toBe(true)
    expect(mac.call("clipboard.read")).toMatchObject({ ok: true, text: "4" })
  })

  // A feature reported off must behave off, so desktop tests can cover the fallback main owns.
  test("without capture.exclude the overlay is painted; without ui.secureFieldDetect nothing is reported secure", () => {
    const shown = start({ disabled: ["capture.exclude"] })
    shown.begin(["calculator"])
    const { header, image } = shown.capture({ display: "1" })
    // The overlay is one of Vector's windows, so it is painted as a Vector block over the whole display.
    expect(pixel(image!, ...at(header, 60, 200))).toEqual(COLORS.vector)
    expect(header.masked).toContainEqual({ x: 0, y: 0, w: 1000, h: 640 })
    expect(header.hiddenCount).toBe(0) // The overlay host hides every regular app but is not itself an app count.
    expectMaskedIsPainted(header, image!)
    // It still takes no clicks, so a click goes to the window under it.
    const [x, y] = at(header, 70, 170)
    const click = { captureId: header.captureId, x, y, button: "left", count: 1, modifiers: [] }
    expect(shown.call("input.click", click)).toMatchObject({ ok: true })
    expect(shown.helper.log.filter((entry) => entry.kind === "input").at(-1)).toMatchObject({ windowId: "calc-1" })

    const blind = start({ scenario: "notes", disabled: ["ui.secureFieldDetect"] })
    blind.begin(["notes"])
    blind.control({ type: "focus", windowId: "notes-1", node: "notes.password" })
    const password = blind
      .call("ui.tree", { windowId: "notes-1", maxNodes: 50, maxDepth: 4 })
      .nodes.find((item: Message) => item.role === "AXSecureTextField")
    expect(password).toMatchObject({ focused: true, secure: false })
    // The OS still hides a password field's value; only the helper's own detection is off.
    expect(password).not.toHaveProperty("value")
    expect(blind.call("ui.focused")).toMatchObject({ windowId: "notes-1", secure: false })
    // The helper cannot tell, so it does not refuse: the desktop's own gate must (D14, D16).
    expect(blind.call("ui.setValue", { ref: password.ref, value: "c" })).toMatchObject({ ok: true, took: true })
    const pid = blind.helper.desktop.app("notes")!.pid
    expect(blind.call("input.key", { pid, combo: ["a"], repeat: 1 })).toMatchObject({ ok: true })
    expect(blind.call("input.type", { pid, text: "b" })).toMatchObject({ ok: true })
  })

  test("denied permissions show in status and refuse the ops that need them, without a prompt", () => {
    const mac = start({ deny: ["screen", "accessibility"] })
    expect(mac.call("permissions.status")).toMatchObject({ screen: "denied", accessibility: "denied" })
    mac.begin(["calculator"])
    expect(mac.capture({ display: "1" }).header).toMatchObject({ code: "permissions" })
    expect(mac.call("ui.tree", { windowId: "calc-1", maxNodes: 10, maxDepth: 2 })).toMatchObject({
      code: "permissions",
    })
    expect(mac.call("input.key", { pid: 501, combo: ["a"], repeat: 1 })).toMatchObject({ code: "permissions" })
    expect(mac.call("permissions.request", { service: "screen" })).toMatchObject({ screen: "denied" })
    expect(mac.helper.log.find((entry) => entry.kind === "permissions")).toMatchObject({ service: "screen" })
    const windows = start({ platform: "windows", deny: ["screen"] })
    expect(windows.call("permissions.status")).toMatchObject({
      screen: "n/a",
      accessibility: "n/a",
      captureBlocked: true,
    })
    windows.begin(["calculator"])
    expect(windows.capture({ display: "\\\\.\\DISPLAY1" }).header).toMatchObject({ code: "blocked_by_os" })
  })

  test("crash-after exits 1 without answering, and hang-hello never answers hello", () => {
    const crash = start({ crashAfter: 1 })
    expect(crash.call("permissions.status").ok).toBe(true)
    expect(crash.reply(crash.send("permissions.status"))).toBeUndefined()
    expect(crash.state.exit).toBe(1)
    const hang = start({ hangHello: true })
    expect(hang.reply(hang.send("hello", { protocol: { min: 1, max: 1 } }))).toBeUndefined()
    hang.advance(60_000)
    expect(hang.seen).toEqual([])
    expect(hang.call("permissions.status").ok).toBe(true)
  })

  test("the command line prints its version and probe, and refuses bad usage with exit 2", () => {
    const run = (...argv: string[]) => {
      const out: string[] = []
      const err: string[] = []
      const code = main(argv, { out: (text) => void out.push(text), err: (text) => void err.push(text) })
      return { code, out: out.join(""), err: err.join("") }
    }
    const version = run("--version", "--json")
    expect(version.code).toBe(0)
    expect(JSON.parse(version.out)).toMatchObject({
      helperVersion: identity.helperVersion,
      protocol: { min: 1, max: 1 },
      platform: "darwin",
    })
    expect(JSON.parse(run("--version", "--json", "--platform", "windows", "--protocol", "1..2").out)).toMatchObject({
      platform: "win32",
      protocol: { min: 1, max: 2 },
    })
    expect(JSON.parse(run("--probe", "--json").out)).toEqual({
      permissions: { screen: "granted", accessibility: "granted" },
      responsible: true,
    })
    expect(JSON.parse(run("--probe", "--json", "--fail", "deny:screen").out).permissions.screen).toBe("denied")
    expect(JSON.parse(run("--probe", "--json", "--platform", "windows", "--fail", "deny:screen").out)).toEqual({
      permissions: { screen: "n/a", accessibility: "n/a" },
      captureBlocked: true,
      elevated: false,
      responsible: true,
    })
    expect(
      parseCli([
        "--stdio",
        "--parent-pid",
        "42",
        "--channel",
        "stdio",
        "--control-fd",
        "4",
        "--features",
        "-ui.tree,-clipboard",
        "--fail",
        "deny:screen",
        "--fail",
        "crash-after:3",
        "--latency",
        "50",
        "--scenario",
        "notes",
      ]),
    ).toEqual({
      mode: "serve",
      parentPid: 42,
      channel: "stdio",
      controlFd: 4,
      options: {
        platform: "macos",
        scenario: "notes",
        disabled: ["ui.tree", "clipboard"],
        crashAfter: 3,
        hangHello: false,
        deny: ["screen"],
        latencyMs: 50,
      },
    })
    for (const argv of [
      [],
      ["--version"],
      ["--stdio"],
      ["--stdio", "--parent-pid", "x"],
      ["--version", "--json", "--frobnicate"],
      ["--version", "--json", "--protocol", "2..1"],
      ["--version", "--json", "--features", "ui.tree"],
      ["--version", "--json", "--fail", "explode"],
      ["--version", "--json", "--platform", "windows", "--fail", "deny:accessibility"],
      ["--stdio", "--parent-pid", "1", "--control-fd", "1"],
    ])
      expect(run(...argv).code).toBe(2)
  })

  test("the fake's import graph stays Node-only, including exact shared program and key safety modules", async () => {
    const program = path.resolve(import.meta.dir, "../../../core/src/computer/program.ts")
    const keys = path.resolve(import.meta.dir, "../../../core/src/computer/keys.ts")
    const pending = ["fake-helper.ts", "fake-desktop.ts", "png.ts", "transcript.ts"].map((file) =>
      path.join(import.meta.dir, file),
    )
    const seen = new Set<string>()
    while (pending.length) {
      const file = pending.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      const source = await Bun.file(file).text()
      expect(source).not.toMatch(/\bBun\.|["']bun(?::[\w-]+)?["']/)
      const specifiers = [
        ...source.matchAll(/^import[^"']*["']([^"']+)["']/gm),
        ...source.matchAll(/^export\s+(?:\*|\{[^}]*\})[^\r\n]*\bfrom\s+["']([^"']+)["']/gm),
      ].map((match) => match[1]!)
      expect(specifiers.length).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        if (specifier === "@vectordevai/core/computer/program") {
          pending.push(program)
          continue
        }
        if (specifier === "@vectordevai/core/computer/keys") {
          pending.push(keys)
          continue
        }
        expect(specifier).toMatch(
          /^(?:node:[\w/]+|effect|@vectordevai\/schema\/[\w-]+|\.\/[\w-]+|\.\.\/\.\.\/native\/computer-helper\/[\w-]+\.json)$/,
        )
        if (specifier.startsWith("./")) pending.push(path.resolve(path.dirname(file), `${specifier}.ts`))
      }
    }
    expect(seen.has(program)).toBe(true)
    expect(seen.has(keys)).toBe(true)
  })
})
