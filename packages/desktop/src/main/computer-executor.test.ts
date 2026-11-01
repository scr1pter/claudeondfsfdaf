import { afterEach, describe, expect, test } from "bun:test"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { OVERLAY } from "../../test/computer/fake-desktop"
import {
  createFakeHelper,
  manualClock,
  type FakeOptions,
  type FakeProgramArtifact,
} from "../../test/computer/fake-helper"
import { decodePng } from "../../test/computer/png"
import { NativeHelperBackend } from "./computer-backend"
import type { ComputerBridgeKey } from "./computer-bridge"
import { actDeadline, createComputerExecutor } from "./computer-executor"
import { createComputerFrames } from "./computer-frames"
import { createComputerGrants, type GrantScope } from "./computer-grants"
import { createHelperClient, type HelperChannel } from "./computer-helper"
import { defaultPolicy } from "./computer-policy"
import { createComputerSession } from "./computer-session"
import { access, defaultPrefs, resolve, type AppGrants } from "./computer-settings"
import { createComputerKeepAwake, type KeepAwakeEvent } from "./keep-awake"

// End-to-end desktop-main boundary over the real codec/client/backend and a wholly virtual C1 desktop.
// Paths, clipboard, overlays and power are injected; no process, real display, consent API or user input runs.
const ROOT = { rootSessionID: "ses_a", sessionID: "ses_a", directory: "/virtual/project-a" }
const NEXT = { rootSessionID: "ses_b", sessionID: "ses_b", directory: "/virtual/project-b" }
const BUDGET: Computer.CaptureBudget = { maxWidth: 1000, maxHeight: 800, maxPixels: 800_000 }
const cleanups: (() => Promise<void>)[] = []
type Wire = { id: number; op: Computer.HelperOpName } & Record<string, unknown>
type Body<C extends Computer.BridgeCommandName> = Omit<
  Extract<Computer.BridgeRequest, { command: C }>,
  "v" | "command" | "rootSessionID" | "sessionID" | "directory" | "lease"
>

async function flush() {
  for (let index = 0; index < 40; index++) await Promise.resolve()
}

async function until(check: () => boolean) {
  for (let index = 0; index < 20 && !check(); index++) await flush()
  expect(check()).toBe(true)
}

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

function fixture(options: FakeOptions & { mode?: Computer.Mode; pointer?: "ask" | "take" } = {}) {
  const clock = manualClock(1000)
  const data = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(event: { code?: number; signal?: string }) => void>()
  const sent: Wire[] = []
  const blocked: Uint8Array[] = []
  const blockOps = new Set<string>()
  const helper = createFakeHelper(
    { scenario: "notes", ...options },
    {
      clock,
      write: (bytes) => data.forEach((callback) => callback(bytes)),
      exit: (code) => exits.forEach((callback) => callback({ code })),
    },
  )
  const channel: HelperChannel = {
    write(bytes) {
      const request = JSON.parse(Buffer.from(bytes).subarray(4).toString("utf8")) as Wire
      sent.push(request)
      if (blockOps.has(request.op)) {
        blocked.push(bytes.slice())
        return
      }
      helper.receive(bytes)
      state.onRequest?.(request)
    },
    end: () => helper.endOfInput(),
    kill: () => helper.endOfInput(),
    onData(callback) {
      data.add(callback)
      return () => void data.delete(callback)
    },
    onExit(callback) {
      exits.add(callback)
      return () => void exits.delete(callback)
    },
  }
  const client = createHelperClient(channel, { clock })
  const backend = new NativeHelperBackend(client, options.platform === "windows" ? "local-windows" : "local-macos")
  const prefs = {
    ...defaultPrefs(options.platform === "windows" ? "win32" : "darwin"),
    enabled: true,
    consentedAt: 1,
    mode: options.mode ?? "foreground",
    pointer: options.pointer ?? "ask",
  }
  const policy = defaultPolicy()
  const state = {
    scope: undefined as GrantScope | undefined,
    approvedWait: undefined as Promise<void> | undefined,
    onRequest: undefined as ((request: Wire) => void) | undefined,
    clipboard: "User clipboard",
    clipboardRead: undefined as Promise<string> | undefined,
    clipboardReads: 0,
    clipboardWrites: [] as { text: string; phase: Computer.NativePhase }[],
    always: [] as Computer.AlwaysAllowed[],
    views: [] as Computer.ComputerState[],
    aborts: [] as string[],
    cursor: [] as unknown[],
    realPointer: [] as boolean[],
    esc: [] as string[],
    visible: false,
    request: 0,
    permission: 0,
  }
  const settings = {
    get: () => resolve(prefs, policy, state.always),
    access(identity: Computer.AppIdentity, grants?: AppGrants) {
      return access(identity, settings.get(), grants)
    },
    async acceptAlways(identity: Computer.AppIdentity) {
      state.always.push({ key: Computer.appKey(identity), name: identity.name, addedAt: clock.now() })
      return true
    },
  }
  const grants = createComputerGrants({ settings, rootOf: async (sessionID) => sessionID })
  const lost = new Set<() => void>()
  const overlay = {
    async show(value: Computer.ComputerState) {
      state.visible = true
      state.views.push(structuredClone(value))
    },
    async update(value: Computer.ComputerState) {
      state.views.push(structuredClone(value))
    },
    async ready() {},
    close() {
      state.visible = false
    },
    fade() {},
    windowIds: () => [OVERLAY],
    onLost(callback: () => void) {
      lost.add(callback)
      return () => void lost.delete(callback)
    },
    async cursor(value: unknown) {
      state.cursor.push(value)
    },
    step() {},
    realPointer(on: boolean) {
      state.realPointer.push(on)
    },
  }
  const keepAwake = createComputerKeepAwake({ clock, blocker: { start: () => 0, stop: () => {} } })
  const controller = createComputerSession({
    backend,
    overlay,
    settings,
    grants,
    async approved(scope) {
      const identities = (await backend.apps({ installed: true }))
        .filter((app) => settings.access(app.identity, grants.grants(scope)).verdict === "granted")
        .map((app) => app.identity)
      await state.approvedWait
      return identities
    },
    helper: { setRunActive() {}, async resume() {} },
    exclusions: () => ({ vectorPids: [helper.desktop.app("vector")!.pid], vectorWindowIds: ["vector-1"] }),
    async abort(scope) {
      state.aborts.push(scope.rootSessionID)
    },
    clock,
    wallNow: () => 1_700_000_000_000 + clock.now(),
    keepAwake,
  })
  const unlisten = backend.onEvent((event) => controller.helperEvent(event))
  const registry = createComputerFrames({
    backend,
    platform: options.platform === "windows" ? "windows" : "macos",
    phase: (scope) => {
      try {
        return controller.nativePhase(scope)
      } catch {
        return undefined
      }
    },
    ...(options.platform === "windows" ? { toDip: (rect: Computer.Rect) => ({ ...rect }) } : {}),
  })
  const paths = new Map<string, string>()
  const executor = createComputerExecutor({
    backend,
    controller,
    settings,
    grants,
    registry,
    overlay,
    clock,
    canonicalPath: async (file) => paths.get(file) ?? file,
    protectedPaths: ["/virtual/Vector/instructions.md"],
    protectedDirectories: ["/virtual/Vector/private"],
    clipboard: {
      readText: () => {
        state.clipboardReads++
        return state.clipboardRead ?? state.clipboard
      },
      writeText(text, phase) {
        state.clipboard = text
        state.clipboardWrites.push({ text, phase })
      },
    },
    suspendEsc: () => {
      state.esc.push("suspend")
    },
    resumeEsc: () => {
      state.esc.push("resume")
    },
  })
  cleanups.push(async () => {
    executor.close()
    controller.close()
    unlisten()
    await backend.close()
    keepAwake.close()
  })
  function call<C extends Computer.BridgeCommandName>(command: C, body: Body<C>, scope = state.scope ?? ROOT) {
    const envelope = {
      v: 1,
      rootSessionID: scope.rootSessionID,
      sessionID: scope.sessionID,
      directory: scope.directory,
    }
    const lease =
      "lease" in scope && Object.hasOwn(Computer.BridgeCommands[command].request.fields, "lease")
        ? scope.lease
        : undefined
    const request = { ...envelope, command, ...(lease === undefined ? {} : { lease }), ...body } as Extract<
      Computer.BridgeRequest,
      { command: C }
    >
    const key: ComputerBridgeKey = Object.freeze({
      id: ++state.request,
      command,
      ...envelope,
      ...(lease === undefined ? {} : { lease }),
    })
    return { key, promise: executor.run(request, key) }
  }
  async function run<C extends Computer.BridgeCommandName>(command: C, body: Body<C>) {
    return call(command, body).promise
  }
  async function acquire(root = ROOT) {
    const result = await call("acquire", { title: root.rootSessionID }, root).promise
    if (!("lease" in result)) throw new Error("The virtual executor did not acquire the computer")
    state.scope = { ...root, lease: result.lease }
    return state.scope
  }
  async function observe(event: KeepAwakeEvent) {
    await controller.observe(event)
  }
  async function grant(slot: string, reply: "once" | "always" | "reject" = "once") {
    const key = Computer.appKey(helper.desktop.app(slot)!.identity)
    const app = (await backend.apps({ installed: true })).find((app) => Computer.appKey(app.identity) === key)!.identity
    if (app.platform === "remote") throw new Error("The fixture has no remote app")
    const id = `per_executor_${++state.permission}`
    const verdict = settings.access(app, grants.grants(state.scope!))
    const canAlways = verdict.verdict === "ask" && verdict.canAlways
    const metadata: Computer.AppAskMetadata = {
      action: "use_app",
      level: "interact",
      canAlways,
      target: {
        appName: app.name,
        appKey: key,
        platform: app.platform,
        verified: app.verified,
        category: ComputerApps.category(app),
        ...(app.pid ? { pid: app.pid } : {}),
        ...(app.platform === "macos"
          ? {
              ...(app.path ? { path: app.path } : {}),
              ...(app.teamId ? { teamId: app.teamId } : {}),
              ...(app.apple ? { publisher: "Apple Inc." } : {}),
            }
          : { ...(app.exe ? { path: app.exe } : {}), ...(app.publisher ? { publisher: app.publisher } : {}) }),
      },
    }
    await observe({
      directory: state.scope!.directory,
      payload: {
        type: "permission.asked",
        properties: {
          id,
          sessionID: state.scope!.sessionID,
          permission: "computer_app",
          patterns: [key],
          always: canAlways ? [key] : [],
          metadata,
        },
      },
    })
    await observe({
      directory: state.scope!.directory,
      payload: { type: "permission.replied", properties: { sessionID: state.scope!.sessionID, requestID: id, reply } },
    })
    if (reply !== "reject") await run("grant", { identity: app, level: "interact", requestID: id })
    return { app, key, id }
  }
  async function sensitive(
    step: Computer.Step,
    inspect: Computer.InspectResult,
    why: Computer.SensitiveWhy,
    frame?: string,
  ) {
    const id = `per_sensitive_${++state.permission}`
    const metadata: Computer.SensitiveAskMetadata = {
      action: step.kind === "type" ? "type" : step.kind === "key" ? "key" : step.kind === "drag" ? "drag" : "click",
      why,
      stepDigest: ComputerSensitive.digest(step),
      target: {
        appKey: Computer.appKey(inspect.app),
        appName: inspect.app.name,
        pid: inspect.pid,
        windowId: inspect.window.id,
        ...(inspect.element?.ref ? { ref: inspect.element.ref } : {}),
        ...(inspect.element?.elementId ? { elementId: inspect.element.elementId } : {}),
      },
      ...(inspect.element?.label
        ? { targetName: Computer.clean(inspect.element.label, Computer.LIMITS.labelChars) }
        : {}),
      ...(frame ? { frame } : {}),
      stepIndex: 0,
    }
    await observe({
      directory: state.scope!.directory,
      payload: {
        type: "permission.asked",
        properties: {
          id,
          sessionID: state.scope!.sessionID,
          permission: "computer_sensitive",
          patterns: [`${metadata.target.appKey}:${why}`],
          always: [],
          metadata,
        },
      },
    })
    await observe({
      directory: state.scope!.directory,
      payload: {
        type: "permission.replied",
        properties: { sessionID: state.scope!.sessionID, requestID: id, reply: "once" },
      },
    })
    return id
  }
  async function programProof(program: Computer.ProgramLaunch) {
    const id = `per_program_${++state.permission}`
    const metadata: Computer.SensitiveAskMetadata = {
      action: "open",
      why: "run_program",
      stepDigest: ComputerProgram.digest(program),
      target: { appKey: program.key, appName: program.name },
      path: program.path,
      program,
      stepIndex: 0,
    }
    await observe({
      directory: state.scope!.directory,
      payload: {
        type: "permission.asked",
        properties: {
          id,
          sessionID: state.scope!.sessionID,
          permission: "computer_sensitive",
          patterns: [`${program.key}:run_program`],
          always: [],
          metadata,
        },
      },
    })
    await observe({
      directory: state.scope!.directory,
      payload: {
        type: "permission.replied",
        properties: {
          sessionID: state.scope!.sessionID,
          requestID: id,
          reply: "once",
        },
      },
    })
    return id
  }
  async function advance(ms: number) {
    for (let remaining = ms; remaining > 0; ) {
      const step = Math.min(2000, remaining)
      clock.advance(step)
      await flush()
      if (state.scope)
        await Promise.resolve()
          .then(() => controller.heartbeat(state.scope!))
          .catch(() => {})
      await backend.heartbeat().catch(() => {})
      await flush()
      remaining -= step
    }
  }
  return {
    executor,
    controller,
    grants,
    settings,
    prefs,
    policy,
    state,
    helper,
    backend,
    clock,
    sent,
    paths,
    blockOps,
    blocked,
    call,
    run,
    acquire,
    grant,
    sensitive,
    programProof,
    advance,
    deliverBlocked() {
      for (const bytes of blocked.splice(0)) helper.receive(bytes)
    },
  }
}

test("the act deadline reserves each input, exact waits, settling, capture and cancellation slack", () => {
  const steps: Computer.Step[] = [
    { kind: "wait", ms: 30_000 },
    { kind: "key", combo: ["ArrowLeft"], repeat: 20, holdMs: 10_000 },
    { kind: "type", text: "A".repeat(4000) },
  ]
  expect(actDeadline({ steps, settleMs: 5000 })).toBe(80_000)
})

test("the whole act times out while an observation is stalled and releases input immediately", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const gate = Promise.withResolvers<void>()
  fake.state.approvedWait = gate.promise
  const act = fake.call("act", {
    steps: [{ kind: "key", combo: ["ArrowLeft"], repeat: 1 }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  let value: unknown
  const result = act.promise.then(
    (reply) => {
      value = reply
      return reply
    },
    (error) => {
      value = error
      return error
    },
  )
  await flush()
  const start = fake.sent.length
  await fake.advance(35_000 - 1)
  expect(value).toBeUndefined()
  await fake.advance(1)
  expect(await result).toMatchObject({ code: "timeout" })
  expect(fake.sent.slice(start).some((request) => request.op === "input.releaseAll")).toBe(true)
  expect(fake.sent.slice(start).some((request) => request.op === "session.update" && request.paused === true)).toBe(
    true,
  )
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  gate.resolve()
  await flush()
})

test("screenshots disclose only granted apps and preserve the actual PNG MIME", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const shot = await fake.run("screenshot", { scope: { display: "1" }, budget: BUDGET })
  expect(shot.image.startsWith("data:image/png;base64,")).toBe(true)
  expect(shot.visible.map((identity) => Computer.appKey(identity))).toEqual([notes.key])
  expect(shot.hiddenCount).toBeGreaterThan(0)
  const begin = fake.sent.find((request) => request.op === "session.begin")!
  const updates = fake.sent.filter((request) => request.op === "session.update" && Array.isArray(request.approved))
  const approved = updates.at(-1)?.approved ?? begin.approved
  expect((approved as Computer.AppIdentity[]).map((identity) => Computer.appKey(identity))).toEqual([notes.key])
  const image = decodePng(Buffer.from(shot.image.split(",")[1], "base64"))
  const pixel = (x: number, y: number) => {
    const px = Math.floor((x - shot.frame.bounds.x) * shot.frame.scale)
    const py = Math.floor((y - shot.frame.bounds.y) * shot.frame.scale)
    return [...image.rgba.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 3)]
  }
  expect(pixel(70, 170)).toEqual([0, 0, 0])
  expect(pixel(400, 200)).toEqual([255, 214, 10])
  expect(fake.sent.findLast((request) => request.op === "capture")).toMatchObject({ format: "jpeg", quality: 80 })
})

test("app listing hides ungranted titles and keeps never-listed apps flagged", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const result = await fake.run("listApps", {})
  const visible = result.apps.find((app) => Computer.appKey(app.identity) === notes.key)!
  expect(visible.windows?.[0].title).toBe("Groceries")
  const calculator = result.apps.find((app) => app.name === "Calculator")!
  expect(calculator.windows?.every((window) => window.title === undefined) ?? true).toBe(true)
  const terminal = result.apps.find((app) => app.category === "terminal")!
  expect(terminal.verdict).toBe("never")
  expect(terminal.windows?.every((window) => window.title === undefined) ?? true).toBe(true)
})

test("clipboard ownership compares the complete current text and expires with the task", async () => {
  const fake = fixture()
  const scope = await fake.acquire()
  await fake.grant("notes")
  const owned = "This is a long public clipboard value. ".repeat(20)
  expect((await fake.run("inspect", { focus: true })).clipboard.agentOwned).toBe(false)
  await fake.executor.writeClipboard(scope, owned)
  expect((await fake.run("inspect", { focus: true })).clipboard).toEqual({ agentOwned: true, text: owned })
  fake.state.clipboard = `${owned.slice(0, -1)}!`
  const changed = await fake.run("inspect", { focus: true })
  expect(changed.clipboard.agentOwned).toBe(false)
  expect(changed.clipboard.text).toBe(fake.state.clipboard)
  fake.state.clipboard = owned
  await fake.run("release", {})
  await fake.acquire(NEXT)
  await fake.grant("notes")
  expect((await fake.run("inspect", { focus: true })).clipboard.agentOwned).toBe(false)
})

test("app grant and durable save use observed identity and matching event evidence", async () => {
  const fake = fixture()
  await fake.acquire()
  const app = fake.helper.desktop.app("notes")!.identity
  expect(
    await fake.run("grant", { identity: app, level: "interact", requestID: "per_unobserved" }).catch((error) => error),
  ).toMatchObject({ code: "not_granted" })
  const notes = await fake.grant("notes", "always")
  const saved = await fake.run("remember", {
    identity: { ...notes.app, name: "Untrusted body label" },
    requestID: notes.id,
  })
  expect(saved.saved).toBe(true)
  expect(fake.state.always.map((row) => row.name)).toEqual([notes.app.name])
  expect(fake.sent.filter((request) => request.op === "app.launch")).toEqual([])
})

test("background pointer input returns its ask immediately and a control wait ends at sixty seconds", async () => {
  const fake = fixture({ mode: "background" })
  await fake.acquire()
  const notes = await fake.grant("notes")
  const shot = await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
  const at = fake.clock.now()
  const result = await fake.run("act", {
    frame: shot.frame.id,
    steps: [{ kind: "move", at: { x: 80, y: 160 } }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  expect(fake.clock.now()).toBe(at)
  expect(result.done).toBe(0)
  expect(typeof result.waiting?.waitId).toBe("string")
  expect(result.waiting?.reason).toBe("pointer")
  expect(fake.controller.state().ask).toMatchObject({ kind: "pointer", requestID: result.waiting!.waitId })
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  const waiting = fake.call("awaitControl", { waitId: result.waiting!.waitId })
  await fake.advance(60_000)
  expect(await waiting.promise).toEqual({ result: "pending" })
  expect(fake.state.scope!.lease).toBe(fake.controller.state().lease)
})

test("a background failure stays a foreground requirement and cannot report unsent typing as done", async () => {
  const fake = fixture({ mode: "background" })
  await fake.acquire()
  const notes = await fake.grant("notes")
  const shot = await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
  const first = await fake.run("act", {
    frame: shot.frame.id,
    steps: [{ kind: "move", at: { x: 80, y: 160 } }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  expect(first.waiting).toBeDefined()
  expect(await fake.executor.control("hand-over", first.waiting!.waitId)).toBe(true)
  expect(fake.controller.state().mode).toBe("foreground")
  await fake.controller.setMode("background")
  const before = fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "type").length
  const second = await fake.run("act", {
    steps: [{ kind: "type", text: "Fallback text" }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  const typed = fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "type").length - before
  if (second.waiting) {
    expect(second.done).toBe(0)
    expect(typed).toBe(0)
    expect(fake.controller.state().ask?.kind).toBe("pointer")
  } else {
    expect(second.done).toBe(1)
    expect(typed).toBe(1)
    expect(fake.controller.state().mode).toBe("foreground")
  }
})

test("background fallback belongs to the hit-tested app rather than the app currently in front", async () => {
  const fake = fixture({ mode: "background" })
  await fake.acquire()
  const calculator = await fake.grant("calculator")
  expect(fake.helper.desktop.frontmost().slot).toBe("notes")
  const shot = await fake.run("screenshot", { scope: { app: { key: calculator.key } }, budget: BUDGET })
  const result = await fake.run("act", {
    frame: shot.frame.id,
    steps: [{ kind: "move", at: { x: Math.round(40 * shot.frame.scale), y: Math.round(80 * shot.frame.scale) } }],
    allowedApps: [calculator.key],
    settleMs: 0,
  })
  expect(result.waiting).toBeDefined()
  expect(await fake.executor.control("hand-over", result.waiting!.waitId)).toBe(true)
  await fake.controller.setMode("background")
  const tree = await fake.run("readUi", { app: { key: calculator.key }, limit: 100 })
  const seven = tree.nodes.find((node) => node.name === "7")!
  const next = await fake.run("act", {
    steps: [{ kind: "click", at: { ref: seven.ref }, button: "left", count: 1, modifiers: [] }],
    allowedApps: [calculator.key],
    settleMs: 0,
  })
  if (next.waiting) expect(next.done).toBe(0)
  else {
    expect(next.done).toBe(1)
    expect(fake.controller.state().mode).toBe("foreground")
  }
})

test("disconnect cancels a waiting act, releases input and drops its holder", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const act = fake.call("act", { steps: [{ kind: "wait", ms: 30_000 }], allowedApps: [notes.key], settleMs: 0 })
  const result = act.promise.catch((error) => error)
  await flush()
  await flush()
  const start = fake.sent.length
  fake.executor.disconnect()
  await flush()
  expect(await result).toMatchObject({ code: "stopped" })
  expect(fake.sent.slice(start).some((request) => request.op === "cancel")).toBe(true)
  expect(fake.sent.slice(start).some((request) => request.op === "input.releaseAll")).toBe(true)
  expect(fake.controller.state().holder).toBeUndefined()
  expect(fake.state.visible).toBe(false)
  expect(fake.state.aborts).toEqual([])
})

test("cancelling exact queued or completed acquire keys never stops the holder", async () => {
  const fake = fixture()
  const first = fake.call("acquire", { title: ROOT.rootSessionID }, ROOT)
  const acquired = await first.promise
  if (!("lease" in acquired)) throw new Error("The virtual fixture did not acquire")
  fake.state.scope = { ...ROOT, lease: acquired.lease }
  await fake.grant("notes")
  fake.executor.cancel(first.key)
  expect(fake.controller.state().holder?.sessionID).toBe(ROOT.rootSessionID)
  const queued = fake.call("acquire", { title: NEXT.rootSessionID, wait: true }, NEXT)
  const result = queued.promise.catch((error) => error)
  await flush()
  fake.executor.cancel({ ...queued.key })
  expect(fake.controller.state().queue).toHaveLength(1)
  const at = fake.sent.length
  fake.executor.cancel(queued.key)
  expect(await result).toMatchObject({ code: "stopped" })
  expect(fake.sent.slice(at).filter((request) => request.op === "cancel" || request.op === "input.releaseAll")).toEqual(
    [],
  )
  expect(fake.controller.state().holder?.sessionID).toBe(ROOT.rootSessionID)
  expect(fake.state.aborts).toEqual([])
})

test("late input from an old task cannot enter a successor's native session", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  fake.blockOps.add("input.key")
  const old = fake.call("act", {
    steps: [{ kind: "key", combo: ["ArrowLeft"], repeat: 1 }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  const oldResult = old.promise.catch((error) => error)
  await until(() => fake.blocked.length === 1)
  expect(fake.blocked).toHaveLength(1)
  const oldWire = fake.sent.findLast((request) => request.op === "input.key")!
  fake.blockOps.delete("input.key")
  await fake.run("release", {})
  await fake.acquire(NEXT)
  const successor = await fake.grant("notes")
  const next = await fake.run("act", {
    steps: [{ kind: "key", combo: ["ArrowRight"], repeat: 1 }],
    allowedApps: [successor.key],
    settleMs: 0,
  })
  expect(next.done).toBe(1)
  const nextWire = fake.sent.findLast((request) => request.op === "input.key")!
  expect(typeof oldWire.sessionId).toBe("string")
  expect(Number.isSafeInteger(oldWire.phaseRevision)).toBe(true)
  expect(oldWire.sessionId).not.toBe(nextWire.sessionId)
  const posted = fake.helper.log.filter((entry) => entry.kind === "input").length
  const at = fake.sent.length
  fake.executor.cancel(old.key)
  await flush()
  expect(fake.sent.slice(at).filter((request) => request.op === "cancel" || request.op === "input.releaseAll")).toEqual(
    [],
  )
  fake.deliverBlocked()
  expect(["stopped", "changed"]).toContain((await oldResult).code)
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toHaveLength(posted)
  expect(fake.controller.state().holder?.sessionID).toBe(NEXT.rootSessionID)
})

test("a canonical script needs its own once-only program proof and exposes no native token", async () => {
  const artifact = {
    path: "/virtual/scripts/task.script",
    name: "Task script",
    content: "virtual version 1",
    handler: "verified:virtual-runner",
  }
  const fake = fixture({ programs: [artifact] })
  await fake.acquire()
  fake.paths.set("/virtual/shortcut", artifact.path)
  const prepared = await fake.run("prepareOpen", { app: { path: "/virtual/shortcut" } })
  if (prepared.kind !== "program") throw new Error("Expected a prepared virtual program")
  expect(prepared.program.path).toBe(artifact.path)
  expect(prepared.program.key.startsWith("program:macos:")).toBe(true)
  expect(Object.keys(prepared.program).sort()).toEqual(["binding", "key", "name", "path", "platform"])
  const missing = await fake.run("openApp", { app: { program: prepared.program } })
  expect("pending" in missing && missing.pending.why).toBe("run_program")
  expect(JSON.stringify(missing)).not.toContain('"token"')
  expect(fake.helper.log.filter((entry) => entry.kind === "program")).toEqual([])
  const requestID = await fake.programProof(prepared.program)
  const opened = await fake.run("openApp", { app: { program: prepared.program }, requestID })
  expect("launched" in opened && opened.launched).toBe(true)
  expect(JSON.stringify(opened)).not.toContain('"token"')
  expect(fake.grants.grants(fake.state.scope!).task?.size ?? 0).toBe(0)
  expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
  const launch = fake.sent.findLast((request) => request.op === "program.launch")!
  expect(typeof launch.token).toBe("string")
  expect(typeof launch.sessionId).toBe("string")
  expect(Number.isSafeInteger(launch.phaseRevision)).toBe(true)
  await fake.run("prepareOpen", { app: { path: artifact.path } })
  const replay = await fake.run("openApp", { app: { program: prepared.program }, requestID })
  expect("pending" in replay && replay.pending.why).toBe("run_program")
  expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
})

for (const platform of ["macos", "windows"] as const)
  for (const selector of ["name", "key"] as const)
    test(`${platform} closed unsigned app opened by ${selector} requires artifact consent before its first process`, async () => {
      const artifact = {
        path: platform === "macos" ? "/virtual/Unsigned Editor.app" : "C:\\virtual\\Unsigned Editor.exe",
        name: "Unsigned Editor",
        content: "virtual unsigned editor v1",
        handler: `verified:direct-native:${platform}`,
      }
      const fake = fixture({ platform, programs: [artifact] })
      const app = fake.helper.desktop.app("ide")!
      app.running = false
      if (app.identity.platform === "macos")
        Object.assign(app.identity, {
          name: artifact.name,
          bundleId: "local.fixture.UnsignedEditor",
          verified: false,
          apple: false,
          system: false,
          teamId: undefined,
          path: artifact.path,
        })
      if (app.identity.platform === "windows")
        Object.assign(app.identity, {
          name: artifact.name,
          verified: false,
          publisher: "",
          system: false,
          exe: artifact.path,
        })
      await fake.acquire()
      const key = Computer.appKey(app.identity)
      const query = selector === "name" ? { name: artifact.name } : { key }
      const installed = (await fake.backend.apps({ installed: true })).find(
        (candidate) => Computer.appKey(candidate.identity) === key,
      )!
      expect(installed.identity.platform !== "remote" && installed.identity.pid).toBeUndefined()
      const prepared = await fake.run("prepareOpen", { app: query })
      if (prepared.kind !== "program") throw new Error("An unsigned closed artifact cannot use a fabricated app PID")
      expect(prepared.program.path).toBe(artifact.path)
      expect(prepared.program.name).toBe(artifact.name)
      expect(JSON.stringify(prepared)).not.toContain('"token"')
      const missing = await fake.run("openApp", { app: query })
      expect("pending" in missing && missing.pending.why).toBe("run_program")
      expect(app.running).toBe(false)
      expect(fake.sent.filter((request) => request.op === "app.launch" || request.op === "program.launch")).toEqual([])
      expect(fake.grants.grants(fake.state.scope!).task?.size ?? 0).toBe(0)
      const requestID = await fake.programProof(prepared.program)
      const opened = await fake.run("openApp", { app: query, requestID })
      expect("program" in opened && opened.launched).toBe(true)
      expect(app.running).toBe(true)
      expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
      expect(fake.sent.filter((request) => request.op === "app.launch")).toEqual([])
      expect(fake.grants.grants(fake.state.scope!).task?.size ?? 0).toBe(0)
      const nowRunning = await fake.run("prepareOpen", { app: query })
      expect(nowRunning.kind).toBe("app")
      if (nowRunning.kind === "app")
        expect(nowRunning.identity.platform !== "remote" && nowRunning.identity.pid).toBe(app.pid)
    })

for (const platform of ["macos", "windows"] as const)
  test(`${platform} closed verified app keeps its app approval and launch flow`, async () => {
    const fake = fixture({ platform })
    await fake.acquire()
    const app = fake.helper.desktop.app("textedit")!
    expect(app.running).toBe(false)
    expect(app.identity.verified).toBe(true)
    const prepared = await fake.run("prepareOpen", { app: { name: app.identity.name } })
    expect(prepared.kind).toBe("app")
    const granted = await fake.grant("textedit")
    const opened = await fake.run("openApp", { app: { key: granted.key } })
    expect("identity" in opened && opened.launched).toBe(true)
    expect(app.running).toBe(true)
    expect(fake.sent.filter((request) => request.op === "app.launch")).toHaveLength(1)
    expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
  })

for (const changed of ["content", "handler"] as const)
  test(`a changed program ${changed} requires a new binding and proof before launch`, async () => {
    const artifact = {
      path: "/virtual/mutable.script",
      name: "Mutable script",
      content: "virtual version 1",
      handler: "verified:virtual-runner",
    }
    const fake = fixture({ programs: [artifact] })
    await fake.acquire()
    const prepared = await fake.run("prepareOpen", { app: { path: artifact.path } })
    if (prepared.kind !== "program") throw new Error("Expected a prepared virtual program")
    const requestID = await fake.programProof(prepared.program)
    artifact[changed] = changed === "content" ? "virtual version 2" : "verified:another-runner"
    const result = await fake.run("openApp", { app: { program: prepared.program }, requestID })
    if (!("pending" in result)) throw new Error("A changed program must wait for a new approval")
    expect(result.pending.program.binding).not.toBe(prepared.program.binding)
    expect(result.pending.program.key).not.toBe(prepared.program.key)
    expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
    const fresh = await fake.programProof(result.pending.program)
    const opened = await fake.run("openApp", { app: { program: result.pending.program }, requestID: fresh })
    expect("launched" in opened && opened.launched).toBe(true)
    expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
  })

test("program approval from an ended task cannot authorize the same artifact in another lease", async () => {
  const fake = fixture()
  await fake.acquire()
  const prepared = await fake.run("prepareOpen", { app: { path: "/virtual/example.script" } })
  if (prepared.kind !== "program") throw new Error("Expected a prepared virtual program")
  const requestID = await fake.programProof(prepared.program)
  await fake.run("release", {})
  await fake.acquire(NEXT)
  await fake.run("prepareOpen", { app: { path: prepared.program.path } })
  const result = await fake.run("openApp", { app: { program: prepared.program }, requestID })
  expect("pending" in result && result.pending.why).toBe("run_program")
  expect(fake.helper.log.filter((entry) => entry.kind === "program")).toEqual([])
})

function unsignedFixture() {
  const artifact = {
    path: "/virtual/Unsigned Editor.app",
    name: "Unsigned Editor",
    content: "virtual editor v1",
    handler: "verified:direct-native:macos",
  }
  const fake = fixture({ programs: [artifact] })
  const app = fake.helper.desktop.app("ide")!
  if (app.identity.platform !== "macos") throw new Error("Expected the virtual Mac app")
  app.running = false
  Object.assign(app.identity, {
    name: artifact.name,
    bundleId: "local.fixture.UnsignedEditor",
    verified: false,
    apple: false,
    system: false,
    teamId: undefined,
    path: artifact.path,
  })
  return { fake, app, artifact, key: Computer.appKey(app.identity) }
}

for (const selector of ["name", "key", "program"] as const)
  test(`a user-blocked unsigned app cannot bypass its ceiling through ${selector}`, async () => {
    const { fake, app, key } = unsignedFixture()
    await fake.acquire()
    const prepared = await fake.run("prepareOpen", { app: { key } })
    if (prepared.kind !== "program") throw new Error("Expected a prepared unsigned artifact")
    const requestID = await fake.programProof(prepared.program)
    fake.prefs.blocked.push({ key, name: app.identity.name, addedAt: fake.clock.now() })
    const target =
      selector === "name" ? { name: app.identity.name } : selector === "key" ? { key } : { program: prepared.program }
    expect(await fake.run("openApp", { app: target, requestID }).catch((error) => error)).toMatchObject({
      code: "blocked",
    })
    expect(fake.grants.consumeProgram(requestID, fake.state.scope!, prepared.program, false)).toBe(true)
    expect(fake.sent.filter((request) => request.op === "app.launch" || request.op === "program.launch")).toEqual([])
  })

test("a conversation app denial also denies its prepared unsigned artifact without consuming consent", async () => {
  const { fake, key } = unsignedFixture()
  await fake.acquire()
  const prepared = await fake.run("prepareOpen", { app: { key } })
  if (prepared.kind !== "program") throw new Error("Expected a prepared unsigned artifact")
  const requestID = await fake.programProof(prepared.program)
  await fake.grant("ide", "reject")
  expect(fake.grants.grants(fake.state.scope!).denied?.has(key)).toBe(true)
  expect(
    await fake.run("openApp", { app: { program: prepared.program }, requestID }).catch((error) => error),
  ).toMatchObject({ code: "not_granted" })
  expect(fake.grants.consumeProgram(requestID, fake.state.scope!, prepared.program, false)).toBe(true)
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
})

test("company default deny refuses an unassociated script before an approval can be prepared", async () => {
  const fake = fixture()
  fake.policy.defaultAccess = "deny"
  await fake.acquire()
  expect(
    await fake.run("prepareOpen", { app: { path: "/virtual/example.script" } }).catch((error) => error),
  ).toMatchObject({ code: "blocked" })
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
})

test("a known signed canonical artifact honors an explicit company allow under default deny", async () => {
  const artifact = {
    path: "/virtual/company-tool.script",
    name: "Company tool",
    content: "virtual signed tool v1",
    handler: "verified:virtual-runner",
  }
  const fake = fixture({ programs: [artifact] })
  const app = fake.helper.desktop.app("textedit")!.identity
  if (app.platform !== "macos" || !app.path) throw new Error("Expected an installed signed Mac artifact")
  // The injected virtual filesystem establishes the installed artifact's canonical alias.
  fake.paths.set(app.path, artifact.path)
  fake.policy.managed = true
  fake.policy.defaultAccess = "deny"
  fake.policy.apps = new Map([[Computer.appKey(app), "allow"]])
  await fake.acquire()
  const prepared = await fake.run("prepareOpen", { app: { path: artifact.path } })
  if (prepared.kind !== "program") throw new Error("Expected the associated virtual launch artifact")
  const pending = await fake.run("openApp", { app: { program: prepared.program } })
  expect("pending" in pending && pending.pending.why).toBe("run_program")
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
  const requestID = await fake.programProof(prepared.program)
  const opened = await fake.run("openApp", { app: { program: prepared.program }, requestID })
  expect("program" in opened && opened.launched).toBe(true)
  expect(fake.helper.log.filter((entry) => entry.kind === "program")).toHaveLength(1)
  expect(fake.grants.grants(fake.state.scope!).task?.size ?? 0).toBe(0)
})

for (const ceiling of ["user", "company", "conversation"] as const)
  test(`a private native script handler honors its ${ceiling} denial without entering public consent`, async () => {
    const artifact: FakeProgramArtifact = {
      path: "/virtual/handled.script",
      name: "Handled script",
      content: "virtual handled script v1",
      handler: "verified:virtual-textedit-handler",
    }
    const fake = fixture({ programs: [artifact] })
    const handler = fake.helper.desktop.app("textedit")!.identity
    artifact.handlerIdentity = handler
    await fake.acquire()
    const prepared = await fake.run("prepareOpen", { app: { path: artifact.path } })
    if (prepared.kind !== "program") throw new Error("Expected a program using the actual virtual handler")
    expect(Object.keys(prepared.program).sort()).toEqual(["binding", "key", "name", "path", "platform"])
    expect(JSON.stringify(prepared)).not.toContain('"handler"')
    expect(JSON.stringify(prepared)).not.toContain('"token"')
    const native = await fake.backend.resolveLaunch(artifact.path)
    if (native.kind !== "program" || !native.program.handler)
      throw new Error("The main-only native handler is required for policy")
    expect(Computer.appKey(native.program.handler)).toBe(Computer.appKey(handler))
    const requestID = await fake.programProof(prepared.program)
    if (ceiling === "user")
      fake.prefs.blocked.push({ key: Computer.appKey(handler), name: handler.name, addedAt: fake.clock.now() })
    if (ceiling === "company") {
      fake.policy.managed = true
      fake.policy.apps = new Map([[Computer.appKey(handler), "deny"]])
    }
    if (ceiling === "conversation") await fake.grant("textedit", "reject")
    const refused = await fake.run("openApp", { app: { program: prepared.program }, requestID }).catch((error) => error)
    expect(refused).toMatchObject({ code: ceiling === "conversation" ? "not_granted" : "blocked" })
    expect(fake.grants.consumeProgram(requestID, fake.state.scope!, prepared.program, false)).toBe(true)
    expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
    expect(fake.helper.log.filter((entry) => entry.kind === "program")).toEqual([])
  })

test("an explicitly allowed handler does not exempt an unknown artifact from company default deny", async () => {
  const artifact: FakeProgramArtifact = {
    path: "/virtual/unassociated.script",
    name: "Unassociated script",
    content: "virtual script v1",
    handler: "verified:virtual-textedit-handler",
  }
  const fake = fixture({ programs: [artifact] })
  const handler = fake.helper.desktop.app("textedit")!.identity
  artifact.handlerIdentity = handler
  fake.policy.managed = true
  fake.policy.defaultAccess = "deny"
  fake.policy.apps = new Map([[Computer.appKey(handler), "allow"]])
  await fake.acquire()
  expect(await fake.run("prepareOpen", { app: { path: artifact.path } }).catch((error) => error)).toMatchObject({
    code: "blocked",
  })
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
})

test("artifact launch still requires feature consent independently of an observed program answer", async () => {
  const fake = fixture()
  await fake.acquire()
  const prepared = await fake.run("prepareOpen", { app: { path: "/virtual/example.script" } })
  if (prepared.kind !== "program") throw new Error("Expected a prepared virtual program")
  const requestID = await fake.programProof(prepared.program)
  fake.prefs.consentedAt = 0
  expect(fake.settings.get().prefs.enabled).toBe(false)
  expect(
    await fake.run("openApp", { app: { program: prepared.program }, requestID }).catch((error) => error),
  ).toMatchObject({ code: "blocked" })
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
})

test("a ceiling changed during native resolution is checked before consuming the program proof", async () => {
  const fake = fixture()
  await fake.acquire()
  const prepared = await fake.run("prepareOpen", { app: { path: "/virtual/example.script" } })
  if (prepared.kind !== "program") throw new Error("Expected a prepared virtual program")
  const requestID = await fake.programProof(prepared.program)
  fake.blockOps.add("apps.resolve")
  const opening = fake.run("openApp", { app: { program: prepared.program }, requestID }).catch((error) => error)
  await until(() => fake.blocked.length === 1)
  fake.policy.defaultAccess = "deny"
  fake.blockOps.delete("apps.resolve")
  fake.deliverBlocked()
  expect(await opening).toMatchObject({ code: "blocked" })
  expect(fake.grants.consumeProgram(requestID, fake.state.scope!, prepared.program, false)).toBe(true)
  expect(fake.sent.filter((request) => request.op === "program.launch")).toEqual([])
})

test("a late old-task clipboard read cannot clear its successor's frames, refs or clipboard ownership", async () => {
  const fake = fixture()
  await fake.acquire()
  await fake.grant("notes")
  const delayed = Promise.withResolvers<string>()
  fake.state.clipboardRead = delayed.promise
  const reads = fake.state.clipboardReads
  const old = fake.run("inspect", { focus: true }).catch((error) => error)
  await until(() => fake.state.clipboardReads > reads)
  fake.state.clipboardRead = undefined
  await fake.run("release", {})
  await fake.acquire(NEXT)
  const notes = await fake.grant("notes")
  await fake.executor.writeClipboard(fake.state.scope!, "Successor clipboard")
  const shot = await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
  const tree = await fake.run("readUi", { app: { key: notes.key }, limit: 100 })
  const body = tree.nodes.find((node) => node.name === "Body")!
  delayed.resolve("Old task clipboard")
  await flush()
  expect(await old).toMatchObject({ code: "stopped" })
  expect(fake.controller.state().holder?.sessionID).toBe(NEXT.rootSessionID)
  expect((await fake.run("inspect", { ref: body.ref })).clipboard.agentOwned).toBe(true)
  const moved = await fake.run("act", {
    frame: shot.frame.id,
    allowedApps: [notes.key],
    settleMs: 0,
    steps: [{ kind: "move", at: { x: Math.round(60 * shot.frame.scale), y: Math.round(150 * shot.frame.scale) } }],
  })
  expect(moved.done).toBe(1)
})

test("secure UI values stay absent and a secure ref never receives input", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.password")!.value =
    "private fixture value"
  await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
  const tree = await fake.run("readUi", { app: { key: notes.key }, limit: 100 })
  const password = tree.nodes.find((node) => node.secure)!
  expect(password.value).toBeUndefined()
  expect(password.ref.startsWith("ui_")).toBe(true)
  const result = await fake
    .run("act", {
      steps: [{ kind: "type", ref: password.ref, text: "Public replacement" }],
      allowedApps: [notes.key],
      settleMs: 0,
    })
    .catch((error) => error)
  expect(result).toMatchObject({ code: "secure_field" })
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
})

test("readUi applies its result limit after filtering the query", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const result = await fake.run("readUi", { app: { key: notes.key }, query: "Body", limit: 1 })
  expect(result.nodes.map((node) => node.name)).toEqual(["Body"])
  expect(result.nodes[0].ref.startsWith("ui_")).toBe(true)
})

test("sensitive proofs retain their frame, PID, window, ref, element and full-step binding", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const shot = await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
  const tree = await fake.run("readUi", { app: { key: notes.key }, limit: 100 })
  const title = tree.nodes.find((node) => node.name === "Title")!
  const inspect = await fake.run("inspect", { ref: title.ref })
  const step: Computer.Step = { kind: "type", ref: title.ref, text: "outside@example.net" }
  const base = { frame: shot.frame.id, steps: [step], allowedApps: [notes.key], settleMs: 0 }
  const unknown = await fake
    .run("act", { ...base, approvals: [{ index: 0, requestID: "per_unknown" }] })
    .catch((error) => error)
  expect(unknown).toMatchObject({ code: "not_granted" })
  for (const changed of [
    { ...inspect, pid: inspect.pid + 1 },
    { ...inspect, window: { ...inspect.window, id: "a-previous-window" } },
    { ...inspect, element: { ...inspect.element!, ref: "ui_999" } },
    { ...inspect, element: { ...inspect.element!, elementId: "a-previous-field" } },
  ]) {
    const requestID = await fake.sensitive(step, changed, "new_destination", shot.frame.id)
    const result = await fake.run("act", { ...base, approvals: [{ index: 0, requestID }] })
    expect(result.pending).toMatchObject({ kind: "sensitive", why: "new_destination" })
    expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  }
  const oldFrame = await fake.sensitive(step, inspect, "new_destination", "a-previous-frame")
  const stale = await fake.run("act", { ...base, approvals: [{ index: 0, requestID: oldFrame }] })
  expect(stale.pending?.why).toBe("new_destination")
  const valid = await fake.sensitive(step, inspect, "new_destination", shot.frame.id)
  const changed = await fake.run("act", {
    ...base,
    steps: [{ ...step, text: "another@example.net" }],
    approvals: [{ index: 0, requestID: valid }],
  })
  expect(changed.pending?.why).toBe("new_destination")
  const result = await fake.run("act", { ...base, approvals: [{ index: 0, requestID: valid }] })
  expect(result.done).toBe(1)
  expect(fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "type")).toHaveLength(1)
  const fresh = await fake.run("readUi", { app: { key: notes.key }, limit: 100 })
  const current = fresh.nodes.find((node) => node.name === "Title")!
  expect(
    await fake
      .run("act", { ...base, steps: [{ ...step, ref: current.ref }], approvals: [{ index: 0, requestID: valid }] })
      .catch((error) => error),
  ).toMatchObject({ code: "not_granted" })
})

test("a sensitive key proof from a prior lease cannot authorize a successor", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const inspect = await fake.run("inspect", { focus: true })
  const step: Computer.Step = { kind: "key", combo: ["ArrowLeft"], repeat: 1 }
  const requestID = await fake.sensitive(step, inspect, "provider_check")
  await fake.run("release", {})
  await fake.acquire(NEXT)
  await fake.grant("notes")
  const result = await fake
    .run("act", { steps: [step], allowedApps: [notes.key], approvals: [{ index: 0, requestID }], settleMs: 0 })
    .catch((error) => error)
  expect(result).toMatchObject({ code: "not_granted" })
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
})

test("a missing live reason does not spend an already-approved provider proof", async () => {
  const fake = fixture({ scenario: "sensitive" })
  await fake.acquire()
  const bank = await fake.grant("bank")
  const tree = await fake.run("readUi", { app: { key: bank.key }, limit: 100 })
  const button = tree.nodes.find((node) => node.name === "Send payment")!
  const inspect = await fake.run("inspect", { ref: button.ref })
  const step: Computer.Step = { kind: "click", at: { ref: button.ref }, button: "left", count: 1, modifiers: [] }
  const provider = await fake.sensitive(step, inspect, "provider_check")
  const base = { steps: [step], allowedApps: [bank.key], settleMs: 0 }
  const pending = await fake.run("act", { ...base, approvals: [{ index: 0, requestID: provider }] })
  expect(pending.pending).toMatchObject({ kind: "sensitive", why: "send" })
  expect(fake.sent.filter((request) => request.op === "ui.perform")).toEqual([])
  const send = await fake.sensitive(step, inspect, "send")
  const result = await fake.run("act", {
    ...base,
    approvals: [
      { index: 0, requestID: provider },
      { index: 0, requestID: send },
    ],
  })
  expect(result.done).toBe(1)
  expect(fake.sent.filter((request) => request.op === "ui.perform")).toHaveLength(1)
})

for (const platform of ["macos", "windows"] as const)
  test(`${platform}: every native input family carries the active phase and preserves pixel scrolling`, async () => {
    const fake = fixture({ platform })
    await fake.acquire()
    const notes = await fake.grant("notes")
    const shot = await fake.run("screenshot", { scope: { app: { key: notes.key } }, budget: BUDGET })
    const point = (x: number, y: number) => ({
      x: Math.round(x * shot.frame.scale),
      y: Math.round(y * shot.frame.scale),
    })
    const steps: Computer.Step[] = [
      { kind: "click", at: point(40, 30), button: "left", count: 1, modifiers: [] },
      { kind: "move", at: point(40, 80) },
      { kind: "scroll", at: point(40, 80), unit: "pixel", dx: 0, dy: 37 },
      { kind: "drag", path: [point(40, 80), point(60, 100)], modifiers: [] },
      { kind: "key", combo: ["ArrowLeft"], repeat: 1 },
      { kind: "type", text: "Public text" },
    ]
    const result = await fake.run("act", { frame: shot.frame.id, steps, allowedApps: [notes.key], settleMs: 0 })
    expect(result.done).toBe(steps.length)
    const writes = fake.sent.filter((request) => /^input\.(?:click|move|scroll|drag|key|type)$/.test(request.op))
    expect(new Set(writes.map((request) => request.op))).toEqual(
      new Set(["input.click", "input.move", "input.scroll", "input.drag", "input.key", "input.type"]),
    )
    expect(
      writes.every((request) => typeof request.sessionId === "string" && Number.isSafeInteger(request.phaseRevision)),
    ).toBe(true)
    expect(fake.sent.findLast((request) => request.op === "input.scroll")).toMatchObject({ unit: "pixel", dy: 37 })
    expect(fake.controller.state().holder?.actions).toBe(steps.length)
    const text = fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "type")
    expect(text).toHaveLength(1)
    expect(text[0].length).toBe("Public text".length)
  })

test("native focus, launch and UI actions are phase-bound to observed granted apps", async () => {
  const fake = fixture()
  await fake.acquire()
  const calculator = await fake.grant("calculator")
  await fake.run("focusWindow", { app: { key: calculator.key }, window: "calc-1" })
  const tree = await fake.run("readUi", { app: { key: calculator.key }, limit: 100 })
  const seven = tree.nodes.find((node) => node.name === "7")!
  const pressed = await fake.run("act", {
    steps: [{ kind: "click", at: { ref: seven.ref }, button: "left", count: 1, modifiers: [] }],
    allowedApps: [calculator.key],
    settleMs: 0,
  })
  expect(pressed.done).toBe(1)
  const textedit = await fake.grant("textedit")
  expect(textedit.app.platform !== "remote" && textedit.app.pid).toBeUndefined()
  const opened = await fake.run("openApp", { app: { key: textedit.key } })
  expect("launched" in opened && opened.launched).toBe(true)
  expect(fake.helper.desktop.app("textedit")!.running).toBe(true)
  const activated = await fake.run("openApp", { app: { key: calculator.key } })
  expect("launched" in activated && activated.launched).toBe(false)
  const writes = fake.sent.filter((request) =>
    ["window.focus", "ui.perform", "app.launch", "app.activate"].includes(request.op),
  )
  expect(new Set(writes.map((request) => request.op))).toEqual(
    new Set(["window.focus", "ui.perform", "app.launch", "app.activate"]),
  )
  expect(
    writes.every((request) => typeof request.sessionId === "string" && Number.isSafeInteger(request.phaseRevision)),
  ).toBe(true)
})

test("handoff inhibits input until its scoped end resumes the work", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  await fake.run("handoff", { phase: "start", reason: "credential" })
  expect(fake.controller.state()).toMatchObject({ phase: "handoff", escStops: false })
  expect(fake.sent.findLast((request) => request.op === "session.update")).toMatchObject({
    paused: true,
    escStops: false,
  })
  const blocked = await fake
    .run("act", { steps: [{ kind: "type", text: "Public text" }], allowedApps: [notes.key], settleMs: 0 })
    .catch((error) => error)
  expect(blocked).toMatchObject({ code: "paused" })
  expect(fake.helper.log.filter((entry) => entry.kind === "input")).toEqual([])
  await fake.run("handoff", { phase: "end", reason: "credential" })
  expect(fake.controller.state()).toMatchObject({ phase: "working", escStops: true })
  const result = await fake.run("act", {
    steps: [{ kind: "key", combo: ["ArrowLeft"], repeat: 1 }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  expect(result.done).toBe(1)
})

test("own-build hints follow canonical workspace containment rather than a path prefix", async () => {
  const fake = fixture()
  await fake.acquire()
  const app = fake.helper.desktop.app("notes")!.identity
  if (app.platform !== "macos" || !app.path) throw new Error("Expected a native Mac path")
  fake.paths.set(app.path, `${ROOT.directory}/build/Notes.app`)
  const inside = await fake.run("access", { app: { key: Computer.appKey(app) } })
  expect(inside).toMatchObject({ verdict: "ask", ownBuild: { repo: ROOT.directory } })
  fake.paths.set(app.path, `${ROOT.directory}-other/Notes.app`)
  const outside = await fake.run("access", { app: { key: Computer.appKey(app) } })
  expect(outside).toMatchObject({ verdict: "ask" })
  expect("ownBuild" in outside ? outside.ownBuild : undefined).toBeUndefined()
})

test("typing refreshes native refs between chunks while preserving one target and phase", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  const text = "A".repeat(129)
  const result = await fake.run("act", { steps: [{ kind: "type", text }], allowedApps: [notes.key], settleMs: 0 })
  expect(result.done).toBe(1)
  const chunks = fake.sent.filter((request) => request.op === "input.type")
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.reduce((length, request) => length + String(request.text).length, 0)).toBe(text.length)
  expect(new Set(chunks.map((request) => request.ref)).size).toBe(chunks.length)
  expect(
    new Set(chunks.map((request) => `${request.sessionId}:${request.phaseRevision}:${request.pid}:${request.windowId}`))
      .size,
  ).toBe(1)
})

test("a live field switch after the first text chunk prevents the remaining text", async () => {
  const fake = fixture()
  await fake.acquire()
  const notes = await fake.grant("notes")
  fake.state.onRequest = (request) => {
    if (request.op !== "input.type") return
    fake.state.onRequest = undefined
    fake.helper.control({ type: "focus", windowId: "notes-1", node: "notes.body" })
  }
  const result = await fake
    .run("act", { steps: [{ kind: "type", text: "A".repeat(129) }], allowedApps: [notes.key], settleMs: 0 })
    .catch((error) => error)
  expect(result).toMatchObject({ code: "changed" })
  const chunks = fake.helper.log.filter((entry) => entry.kind === "input" && entry.op === "type")
  expect(chunks).toHaveLength(1)
  expect(chunks[0].length).toBeLessThan(129)
  expect(fake.helper.desktop.window("notes-1")!.nodes.find((node) => node.id === "notes.body")!.value).toBe(
    "Milk, eggs",
  )
})

test("a timed key hold releases and an injected Escape suspends only its own shortcut", async () => {
  const fake = fixture({ platform: "windows" })
  await fake.acquire()
  const notes = await fake.grant("notes")
  const hold = fake.call("act", {
    steps: [{ kind: "key", combo: ["ArrowLeft"], repeat: 1, holdMs: 50 }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  await until(() => fake.sent.some((request) => request.op === "input.hold"))
  await fake.advance(50)
  expect((await hold.promise).done).toBe(1)
  const wire = fake.sent.findLast((request) => request.op === "input.hold")!
  expect(typeof wire.sessionId).toBe("string")
  expect(Number.isSafeInteger(wire.phaseRevision)).toBe(true)
  const escaped = await fake.run("act", {
    steps: [{ kind: "key", combo: ["Escape"], repeat: 1 }],
    allowedApps: [notes.key],
    settleMs: 0,
  })
  expect(escaped.done).toBe(1)
  expect(fake.state.esc).toEqual(["suspend", "resume"])
  expect(fake.controller.state().holder?.sessionID).toBe(ROOT.rootSessionID)
})
