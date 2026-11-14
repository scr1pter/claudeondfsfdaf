// Counts the HTTP requests the app makes while a multi-step session with subagents runs.
//
// The engine is an in-memory fake behind the real SDK client. The script emits the events the engine emits for each
// step, and every event goes through the same handlers the app runs: the session cache, the directory reducer (whose
// refresh queue re-bootstraps a directory), the economics recorder and the layout's status reconciliation. Set
// VECTOR_TRAFFIC_REPORT=1 to print the counts, and VECTOR_TRAFFIC_PROVIDER_BODY to serve a real /provider body for
// byte counts.
import { afterEach, expect, test, vi } from "bun:test"
import { MessageChannel } from "node:worker_threads"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { createVectorClient, type Event } from "@vectordevai/sdk/v2/client"
import { createServerSession } from "@/context/server-session"
import { applyDirectoryEvent } from "@/context/global-sync/event-reducer"
import { bootstrapDirectory } from "@/context/global-sync/bootstrap"
import { createRefreshQueue } from "@/context/global-sync/queue"
import type { State, VcsCache } from "@/context/global-sync/types"
import { ServerScope } from "@/utils/server-scope"
import { createSessionEconomics } from "./session-economics"

const directory = "/repo"
const model = { providerID: "openai", modelID: "gpt-6.1" }

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

type Info = Record<string, unknown> & { id: string; time: { created: number; updated: number }; parentID?: string }
type Entry = { info: Record<string, unknown> & { id: string }; parts: Record<string, unknown>[] }

function createEngine(providerBody: string) {
  const sessions = new Map<string, Info & { cost: number; subagentCost: number }>()
  const history = new Map<string, Entry[]>()
  const status: Record<string, { type: string }> = {}
  const requests: { path: string; bytes: number }[] = []
  const state = { clock: 1_000, inflight: 0 }
  const tick = () => ++state.clock
  const json = (value: unknown) => JSON.stringify(value)
  const route = (path: string) => {
    const message = path.match(/^\/session\/([^/]+)\/message$/)
    if (message) return json(history.get(message[1]) ?? [])
    const session = path.match(/^\/session\/([^/]+)$/)
    if (session && session[1] !== "status") return json(sessions.get(session[1]))
    if (path === "/session/status") return json(status)
    if (path === "/provider") return providerBody
    if (path === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (path === "/config" || path === "/mcp") return json({})
    if (path === "/vcs") return json({ branch: "main" })
    if (path === "/api/reference") return json({ data: [] })
    return json([])
  }
  return {
    requests,
    state,
    tick,
    sessions,
    history,
    status,
    async fetch(request: Request) {
      state.inflight += 1
      await Promise.resolve()
      const path = new URL(request.url).pathname
      const body = route(path)
      requests.push({ path, bytes: Buffer.byteLength(body) })
      state.inflight -= 1
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    },
  }
}

function directoryState() {
  return createStore<State>({
    status: "complete",
    agent: [],
    command: [],
    reference: [],
    project: "project",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider_loaded: true,
    provider: { all: new Map(), connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: directory, directory, home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_spend: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

function createApp(engine: ReturnType<typeof createEngine>) {
  const client = (dir?: string) =>
    createVectorClient({ baseUrl: "http://engine.test", fetch: engine.fetch, ...(dir ? { directory: dir } : {}) })
  const session = createServerSession(client())
  const [store, setStore] = directoryState()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const bootstrap = (dir: string) =>
    bootstrapDirectory({
      directory: dir,
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {},
        path: { state: "", config: "", worktree: directory, directory, home: "/home" },
        project: [{ id: "project", worktree: directory } as never],
        provider: { all: new Map(), connected: [], default: {} },
      },
      sdk: client(dir),
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      async loadSessions() {
        const response = await client(dir).session.list({ roots: true })
        response.data?.forEach(session.remember)
      },
      translate: (key) => key,
      queryClient,
      session,
    })
  const queue = createRefreshQueue({ paused: () => false, bootstrap: async () => {}, bootstrapInstance: bootstrap })
  const saved: Parameters<Parameters<typeof createSessionEconomics>[0]["save"]>[0][] = []
  const economics = createSessionEconomics({
    client: (dir) => client(dir),
    working: (sessionID) => session.data.session_working(sessionID),
    cached: (sessionID) => session.get(sessionID),
    save: async (sample) => {
      saved.push(sample)
    },
    activated() {},
    workspaces: async () => true,
  })
  return {
    session,
    saved,
    bootstrap,
    // One flush of the app's event queue: every event goes through the listeners in the app's order (server-sync's is
    // registered before the layout's), then the layout's status effect reconciles, as it does after the batch.
    emit(...events: unknown[]) {
      for (const details of events) {
        session.apply(details as Event)
        applyDirectoryEvent({
          event: details as Event,
          directory,
          store,
          setStore,
          push: queue.push,
          sessionContent: false,
          permission: session.data.permission,
          loadLsp() {},
        })
        economics.handle({ name: directory, details: details as Event })
      }
      economics.reconcile(
        Object.keys(session.data.session_status)
          .map((id) => session.get(id))
          .filter((info): info is NonNullable<typeof info> => Boolean(info)),
      )
    },
    dispose() {
      queue.dispose()
      economics.dispose()
    },
  }
}

// Pump logical time while the SDK settles. Wall-clock pauses must not split an event burst across the ancestor
// meter's 400ms coalescing window on a slow runner.
async function settle(engine: ReturnType<typeof createEngine>) {
  const channel = new MessageChannel()
  try {
    for (let quiet = 0, pulses = 0; pulses < 1_000; pulses++) {
      const before = engine.requests.length
      const elapsed = Bun.sleep(25)
      vi.advanceTimersByTime(25)
      await elapsed
      // A native event-loop turn drains SDK response parsing without advancing the fake clock again.
      await new Promise<void>((resolve) => {
        channel.port1.addEventListener("message", () => resolve(), { once: true })
        channel.port1.start()
        channel.port2.postMessage(undefined)
      })
      quiet = engine.state.inflight === 0 && engine.requests.length === before ? quiet + 1 : 0
      if (quiet === 3) return
    }
    throw new Error(
      `Session traffic did not settle after 1,000 logical pulses (${engine.requests.length} requests, ${engine.state.inflight} in flight)`,
    )
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
}

function createScript(engine: ReturnType<typeof createEngine>, app: ReturnType<typeof createApp>) {
  const ids = { value: 0 }
  const id = (prefix: string) => `${prefix}_${String(++ids.value).padStart(4, "0")}`
  const touch = (sessionID: string, cost = 0) => {
    const session = engine.sessions.get(sessionID)!
    const time = engine.tick()
    session.cost += cost
    session.time = { ...session.time, updated: time }
    // The projector also bumps every ancestor's revision and subagent spend, without an event.
    for (let parent = session.parentID; parent; parent = engine.sessions.get(parent)?.parentID) {
      const ancestor = engine.sessions.get(parent)!
      ancestor.subagentCost += cost
      ancestor.time = { ...ancestor.time, updated: time }
    }
    return session
  }
  const part = (message: Entry, value: Record<string, unknown>) => {
    const existing = message.parts.findIndex((item) => item.id === value.id)
    if (existing === -1) message.parts.push(value)
    if (existing !== -1) message.parts[existing] = value
    app.emit({
      type: "message.part.updated",
      properties: { sessionID: message.info.sessionID, part: value, time: engine.tick() },
    })
  }
  const status = (sessionID: string, type: "busy" | "idle") => {
    if (type === "busy") engine.status[sessionID] = { type }
    if (type === "idle") delete engine.status[sessionID]
    // The engine publishes idle right after the idle status, so both land in one flush of the app's event queue.
    app.emit(
      { type: "session.status", properties: { sessionID, status: { type } } },
      ...(type === "idle" ? [{ type: "session.idle", properties: { sessionID } }] : []),
    )
  }
  // A step takes seconds, so whatever the handlers started for it has finished before the next one.
  const step = async (
    sessionID: string,
    user: Entry,
    tool?: { name: string; output: string; child?: () => Promise<void> },
  ) => {
    status(sessionID, "busy")
    const created = engine.tick()
    const message: Entry = {
      info: {
        id: id("msg"),
        sessionID,
        role: "assistant",
        parentID: user.info.id,
        ...model,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created },
      },
      parts: [],
    }
    engine.history.get(sessionID)!.push(message)
    app.emit({ type: "message.updated", properties: { sessionID, info: message.info } })
    part(message, { id: id("prt"), sessionID, messageID: message.info.id, type: "step-start" })
    const text = { id: id("prt"), sessionID, messageID: message.info.id, type: "text", text: "" }
    part(message, text)
    const sentence = "Reading the module and checking how the request flows through it. "
    for (let index = 0; index < 20; index++) {
      text.text += sentence
      app.emit({
        type: "message.part.delta",
        properties: { sessionID, messageID: message.info.id, partID: text.id, field: "text", delta: sentence },
      })
    }
    part(message, { ...text })
    if (tool) {
      const call = {
        id: id("prt"),
        sessionID,
        messageID: message.info.id,
        type: "tool",
        tool: tool.name,
        callID: id("call"),
      }
      part(message, {
        ...call,
        state: { status: "running", input: { filePath: "src/a.ts" }, time: { start: engine.tick() } },
      })
      await tool.child?.()
      part(message, {
        ...call,
        state: {
          status: "completed",
          input: { filePath: "src/a.ts" },
          output: tool.output,
          metadata: {},
          title: "",
          time: { start: 1, end: engine.tick() },
        },
      })
    }
    const finish = {
      id: id("prt"),
      sessionID,
      messageID: message.info.id,
      type: "step-finish",
      reason: tool ? "tool-calls" : "stop",
      cost: 0.004,
      tokens: { input: 1_200, output: 300, reasoning: 0, cache: { read: 8_000, write: 0 } },
    }
    Object.assign(message.info, { cost: 0.004, tokens: finish.tokens, finish: finish.reason })
    touch(sessionID, 0.004)
    part(message, finish)
    app.emit({ type: "message.updated", properties: { sessionID, info: message.info } })
    part(message, { ...finish, snapshot: "abc" })
    // The per-step summary patch publishes the session with a fresh revision, then the turn's diff.
    app.emit({ type: "session.updated", properties: { sessionID, info: touch(sessionID) } })
    app.emit({ type: "session.diff", properties: { sessionID, diff: [] } })
    app.emit({ type: "message.updated", properties: { sessionID, info: user.info } })
    Object.assign(message.info, { time: { created, completed: engine.tick() } })
    app.emit({ type: "message.updated", properties: { sessionID, info: message.info } })
    await settle(engine)
  }
  return {
    create(parentID?: string, title = "New session") {
      const sessionID = id("ses")
      const time = engine.tick()
      const info = {
        id: sessionID,
        slug: sessionID,
        projectID: "project",
        directory,
        ...(parentID ? { parentID } : {}),
        title,
        version: "1",
        time: { created: time, updated: time },
        cost: 0,
        subagentCost: 0,
      }
      engine.sessions.set(sessionID, info)
      engine.history.set(sessionID, [])
      app.emit({ type: "session.created", properties: { sessionID, info } })
      return sessionID
    },
    prompt(sessionID: string) {
      const user: Entry = {
        info: { id: id("msg"), sessionID, role: "user", agent: "build", model, time: { created: engine.tick() } },
        parts: [],
      }
      engine.history.get(sessionID)!.push(user)
      app.emit({ type: "message.updated", properties: { sessionID, info: user.info } })
      part(user, {
        id: id("prt"),
        sessionID,
        messageID: user.info.id,
        type: "text",
        text: "Refactor the request module.",
      })
      return user
    },
    step,
    async title(sessionID: string) {
      app.emit({
        type: "session.next.ancillary.usage",
        properties: {
          sessionID,
          usageID: id("evt"),
          purpose: "title",
          model: { providerID: "openai", id: "gpt-6.1-mini" },
          cost: 0.0003,
          timestamp: engine.tick(),
        },
      })
      touch(sessionID, 0.0003)
      const session = engine.sessions.get(sessionID)!
      session.title = "Refactor the request module"
      app.emit({ type: "session.updated", properties: { sessionID, info: { ...session, time: { ...session.time } } } })
      await settle(engine)
    },
    busy: (sessionID: string) => status(sessionID, "busy"),
    async idle(sessionID: string) {
      status(sessionID, "idle")
      await settle(engine)
    },
  }
}

async function runSession(providerBody: string) {
  const engine = createEngine(providerBody)
  const app = createApp(engine)
  // The directory was bootstrapped when the project opened; that is not part of the session's traffic.
  await app.bootstrap(directory)
  await settle(engine)
  engine.requests.length = 0
  const script = createScript(engine, app)
  const phases: { name: string; requests: { path: string; bytes: number }[] }[] = []
  const phase = async (name: string, run: () => Promise<void>) => {
    const start = engine.requests.length
    await run()
    // Include the live ancestor meter's 400ms coalescing window in this phase, not the following review.
    vi.advanceTimersByTime(425)
    await settle(engine)
    phases.push({ name, requests: engine.requests.slice(start) })
  }

  const root = script.create()
  const prompt = script.prompt(root)
  await phase("root step 1 (reads a file, title generated)", async () => {
    // Title generation runs beside the first step.
    script.busy(root)
    await script.title(root)
    await script.step(root, prompt, { name: "read", output: "x".repeat(4_000) })
  })
  const foreground = { id: "" }
  await phase("root step 2 (runs a 3-step subagent)", () =>
    script.step(root, prompt, {
      name: "task",
      output: "Subagent finished.",
      async child() {
        foreground.id = script.create(root)
        const task = script.prompt(foreground.id)
        await script.step(foreground.id, task, { name: "read", output: "y".repeat(4_000) })
        await script.step(foreground.id, task, { name: "grep", output: "z".repeat(2_000) })
        await script.step(foreground.id, task)
        await script.idle(foreground.id)
      },
    }),
  )
  const background = { id: "", prompt: undefined as Entry | undefined }
  await phase("root step 3 (starts a background subagent)", () =>
    script.step(root, prompt, {
      name: "task",
      output: "Started in the background.",
      async child() {
        background.id = script.create(root)
        background.prompt = script.prompt(background.id)
        await script.step(background.id, background.prompt, { name: "read", output: "w".repeat(4_000) })
      },
    }),
  )
  await phase("root step 4 (final answer, root idle)", async () => {
    await script.step(root, prompt)
    await script.idle(root)
  })
  await phase("background subagent steps 2-3 and idle", async () => {
    await script.step(background.id, background.prompt!, { name: "edit", output: "Edited." })
    await script.step(background.id, background.prompt!)
    await script.idle(background.id)
  })
  // Vectorscope runs each reviewer in a session of its own, which reports back to the review panel only.
  const reviewers: string[] = []
  await phase("Vectorscope review (2 reviewer sessions, 2 steps each)", async () => {
    for (const name of ["review", "verify"]) {
      const reviewer = script.create(undefined, `Vectorscope review · #7 · ${name}`)
      reviewers.push(reviewer)
      const task = script.prompt(reviewer)
      await script.step(reviewer, task, { name: "read", output: "v".repeat(4_000) })
      await script.step(reviewer, task)
      await script.idle(reviewer)
    }
  })
  app.dispose()
  return { phases, steps: 4 + 3 + 3, saved: app.saved, root, reviewers }
}

function summarize(requests: { path: string; bytes: number }[]) {
  const group = (path: string) =>
    /\/session\/[^/]+\/message$/.test(path)
      ? "history"
      : /^\/session\/(?!status)[^/]+$/.test(path)
        ? "session"
        : "bootstrap"
  const totals = { requests: requests.length, bytes: 0, history: 0, session: 0, bootstrap: 0, provider: 0 }
  for (const request of requests) {
    totals.bytes += request.bytes
    totals[group(request.path)] += 1
    if (request.path === "/provider") totals.provider += 1
  }
  return totals
}

test("a multi-step session with subagents fetches history only when its family settles", async () => {
  vi.useFakeTimers()
  const body = process.env.VECTOR_TRAFFIC_PROVIDER_BODY
  const result = await runSession(
    body ? await Bun.file(body).text() : JSON.stringify({ all: [], default: {}, connected: [] }),
  )
  const all = result.phases.flatMap((phase) => phase.requests)
  const total = summarize(all)
  if (process.env.VECTOR_TRAFFIC_REPORT) {
    for (const phase of result.phases) console.log(JSON.stringify({ phase: phase.name, ...summarize(phase.requests) }))
    console.log(JSON.stringify({ phase: "session total", steps: result.steps, ...total }))
  }
  const task = summarize(result.phases.slice(0, 5).flatMap((phase) => phase.requests))
  // The root's history is read once when the root goes idle and once when the background subagent settles after it.
  expect(task.history).toBe(2)
  // Title spend refreshes the one session it changed instead of re-bootstrapping the directory.
  expect(total.bootstrap).toBe(0)
  expect(total.provider).toBe(0)
  for (const phase of result.phases.slice(0, 3)) expect(summarize(phase.requests).history).toBe(0)
  // One title read, two snapshots around each settled history, and three debounced ancestor reads keep the
  // live parent meter current while its children run. Those metadata reads never fetch history or providers.
  expect(task.session).toBe(8)
  // A reviewer session is Vector's own: no history read, no session read, no economics sample.
  expect(summarize(result.phases[5].requests).requests).toBe(0)
  // Fewer reads, same evidence: the root's sample is recorded when it stops and again with the late subagent's spend.
  expect(result.saved.map((sample) => sample.sessionID)).toEqual([result.root, result.root])
  expect(result.saved[0].outcome?.costUsd).toBeCloseTo(0.0163 + 0.012 + 0.004, 10)
  expect(result.saved[1].outcome?.costUsd).toBeCloseTo(0.0163 + 0.012 + 0.012, 10)
  expect(result.saved[1].outcome?.execution).toBe("completed")
}, 15_000)
