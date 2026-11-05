import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, type Accessor } from "solid-js"
import type { AssistantMessage, Message, Part, Session, ToolPart, VectorClient } from "@vectordevai/sdk/v2/client"
import type { Task } from "@vectordevai/schema/task"
import type { retry } from "@vectordevai/core/util/retry"
import type { DirectorySync } from "@/context/sync"
import { createServerSession } from "@/context/server-session"
import { createBackgroundTasks, type BackgroundTasksInput } from "@/features/background-tasks/background-tasks"
import { NO_CAPABILITIES, type EngineCapabilities } from "@/features/background-tasks/engine-capabilities"

/*
 * A background subagent finishes, or its run is lost to an engine restart, while the app's event stream is down.
 * Nothing replays what was missed, so the cached root history, child record and child messages keep saying
 * "running". These tests drive the real Background tasks state and session store against an engine that has moved
 * on, and follow what the cards say as the stream reconnects and Stop is pressed.
 */

const ROOT = "ses_root"
const CHILD = "ses_child"

const retryImmediately: typeof retry = (task) => task()

function session(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/repo",
    title: id,
    version: "1",
    time: { created: 1, updated },
    ...extra,
  }
}

function record(extra: Record<string, unknown>) {
  return {
    kind: "specialist",
    agent: "explore",
    custom: false,
    title: "Map the auth flow",
    parentSessionID: ROOT,
    parentMessageID: "msg_a1",
    callID: "call_1",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    background: true,
    startedAt: 1_000,
    ...extra,
  }
}

function assistant(id: string, sessionID: string, parentID: string, time: AssistantMessage["time"]): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time,
    modelID: "claude-opus-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function user(id: string, sessionID: string): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
  }
}

function launch(metadata: Record<string, unknown>): ToolPart {
  return {
    id: "prt_1",
    sessionID: ROOT,
    messageID: "msg_a1",
    type: "tool",
    callID: "call_1",
    tool: "task",
    state: {
      status: "completed",
      input: { description: "Map the auth flow", prompt: "Map it", subagent_type: "explore" },
      output: "",
      title: "",
      metadata,
      time: { start: 1_000, end: 1_100 },
    },
  }
}

// The engine as the stream left it: the subagent launched in the background and was working.
function engine() {
  const sessions = new Map<string, Session>([
    [ROOT, session(ROOT, 1_100)],
    [CHILD, session(CHILD, 1_000, { parentID: ROOT, metadata: { subagent: record({ status: "running" }) } })],
  ])
  const messages = new Map<string, { info: Message; parts: Part[] }[]>([
    [
      ROOT,
      [
        { info: user("msg_u1", ROOT), parts: [] },
        {
          info: assistant("msg_a1", ROOT, "msg_u1", { created: 900, completed: 1_100 }),
          parts: [launch({ sessionId: CHILD, status: "running", background: true, startedAt: 1_000 })],
        },
      ],
    ],
    [
      CHILD,
      [
        { info: user("msg_cu", CHILD), parts: [] },
        { info: assistant("msg_ca", CHILD, "msg_cu", { created: 2_000 }), parts: [] },
      ],
    ],
  ])
  // Every request, as "route:session".
  const calls: string[] = []
  const unreachable = new Set<string>()
  const state: {
    abortFails: boolean
    truncated: boolean
    invalidBoard: boolean
    task?: Task.Info
    shells?: Task.Shell[]
  } = {
    abortFails: false,
    truncated: false,
    invalidBoard: false,
  }
  // Each board request's shells query, "" when it asked for none.
  const boards: string[] = []
  const reach = (route: string, sessionID: string) => {
    calls.push(`${route}:${sessionID}`)
    if (unreachable.has(sessionID)) throw new Error("engine unreachable")
  }
  const settle = (status: string, at: number) =>
    sessions.set(
      CHILD,
      session(CHILD, at, { parentID: ROOT, metadata: { subagent: record({ status, completedAt: at }) } }),
    )
  const client = {
    experimental: {
      task: {
        list: async (input?: { shells?: string }) => {
          boards.push(input?.shells ?? "")
          if (state.invalidBoard) return { data: [] }
          const shells = input?.shells === "true" && state.shells ? { shells: state.shells } : {}
          return { data: { tasks: state.task ? [state.task] : [], truncated: state.truncated, ...shells } }
        },
      },
    },
    session: {
      get: async (input: { sessionID: string }) => {
        reach("get", input.sessionID)
        return { data: structuredClone(sessions.get(input.sessionID)) }
      },
      messages: async (input: { sessionID: string }) => {
        reach("messages", input.sessionID)
        return { data: structuredClone(messages.get(input.sessionID) ?? []), response: { headers: new Headers() } }
      },
      children: async (input: { sessionID: string }) => {
        reach("children", input.sessionID)
        return { data: structuredClone([...sessions.values()].filter((item) => item.parentID === input.sessionID)) }
      },
      // As the engine does when Stop finds no run: a record still saying live is settled as cancelled.
      abort: async (input: { sessionID: string }) => {
        reach("abort", input.sessionID)
        if (state.abortFails) return { error: { name: "UnknownError" } }
        const status = (sessions.get(input.sessionID)?.metadata?.subagent as { status?: string } | undefined)?.status
        if (status === "running" || status === "queued") settle("cancelled", 5_000)
        return { data: true }
      },
    },
  }
  return {
    client,
    calls,
    boards,
    unreachable,
    state,
    count: (call: string) => calls.filter((item) => item === call).length,
    // What happened while the stream was down: the child finished, its record settled and so did the task part.
    finish(options: { part: boolean }) {
      settle("completed", 9_000)
      messages.set(CHILD, [
        { info: user("msg_cu", CHILD), parts: [] },
        { info: assistant("msg_ca", CHILD, "msg_cu", { created: 2_000, completed: 9_000 }), parts: [] },
      ])
      if (!options.part) return
      messages.set(ROOT, [
        messages.get(ROOT)![0]!,
        {
          info: assistant("msg_a1", ROOT, "msg_u1", { created: 900, completed: 1_100 }),
          parts: [
            launch({ sessionId: CHILD, background: true, startedAt: 1_000, status: "completed", completedAt: 9_000 }),
          ],
        },
      ])
    },
  }
}

// The open session's page, as the provider builds it, over the real session store.
async function open(
  fake: ReturnType<typeof engine>,
  loaded: readonly string[],
  desktop?: BackgroundTasksInput["desktop"],
  capabilities?: Accessor<EngineCapabilities>,
) {
  const store = createServerSession(fake.client as unknown as VectorClient, { retry: retryImmediately })
  for (const id of loaded) await store.sync(id)
  const sync = {
    data: {
      get message() {
        return store.data.message
      },
      get part() {
        return store.data.part
      },
      get session_status() {
        return store.data.session_status
      },
      get permission() {
        return store.data.permission
      },
      get question() {
        return store.data.question
      },
      session: [],
    },
    session: { get: store.get, sync: store.sync },
  } as unknown as DirectorySync
  const [reconnects, setReconnects] = createSignal(0)
  const root = createRoot((dispose) => ({
    dispose,
    tasks: createBackgroundTasks({
      sessionID: () => ROOT,
      sync: () => sync,
      client: () => fake.client as unknown as VectorClient,
      reconnects,
      pin: () => undefined,
      unpin: () => undefined,
      open: () => undefined,
      desktop,
      capabilities,
    }),
  }))
  return {
    tasks: root.tasks,
    dispose: root.dispose,
    reconnect: () => setReconnects((value) => value + 1),
    agent: () => root.tasks.cards()[0]?.agents[0],
  }
}

async function until(condition: () => boolean, ms = 2_000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Background tasks after the event stream dropped", () => {
  test("an unavailable task-list shape preserves the last valid observation", async () => {
    const fake = engine()
    fake.state.task = {
      id: CHILD,
      sessionID: CHILD,
      parentSessionID: ROOT,
      source: "subagent",
      title: "Map the auth flow",
      status: "running",
      startedAt: 1000,
      elapsedMs: 100,
      ownedPaths: [],
      dependsOn: [],
      resultAvailable: false,
      attempt: 1,
      measuredCost: 0.2,
      controls: { inspect: true, message: true, stop: true },
    }
    const page = await open(fake, [ROOT, CHILD])
    await until(() => page.agent()?.cost === 0.2)
    fake.state.invalidBoard = true
    page.reconnect()
    await until(() => Boolean(page.tasks.error()?.includes("Task updates unavailable")))
    expect(page.agent()?.cost).toBe(0.2)
    expect(page.agent()?.status).toBe("running")
    page.dispose()
  })

  test("a reconnect reloads what the stream missed and settles the card", async () => {
    const fake = engine()
    const page = await open(fake, [ROOT, CHILD])
    await until(() => fake.count("children:ses_root") === 1 && fake.count("messages:ses_child") === 2)
    expect(page.agent()?.status).toBe("running")

    fake.finish({ part: true })
    await pause(30)
    // Each idle agent shown live is reloaded once, not on every change: the card waits for the reconnect.
    expect(page.agent()?.status).toBe("running")

    page.reconnect()
    await until(() => page.agent()?.status === "done")
    expect(page.tasks.live()).toEqual([])
    expect(page.agent()?.endedAt).toBe(9_000)
    expect(fake.count("messages:ses_root")).toBe(2)
    expect(fake.count("children:ses_root")).toBe(2)
    page.dispose()
  })

  test("settles from the child alone when the task part never received the outcome", async () => {
    const fake = engine()
    const page = await open(fake, [ROOT, CHILD])
    await until(() => fake.count("messages:ses_child") === 2)

    fake.finish({ part: false })
    page.reconnect()

    await until(() => page.agent()?.status === "done")
    expect(page.agent()?.endedAt).toBe(9_000)
    page.dispose()
  })

  test("an agent the settle pass could not reload is tried again after a reconnect", async () => {
    const fake = engine()
    fake.unreachable.add(CHILD)
    const page = await open(fake, [ROOT])
    await until(() => fake.count("messages:ses_child") === 1)
    await pause(30)
    expect(fake.count("messages:ses_child")).toBe(1)

    // Its messages never loaded, so only the settle pass knows to reload it.
    fake.unreachable.delete(CHILD)
    page.reconnect()
    await until(() => fake.count("messages:ses_child") === 2)
    page.dispose()
  })
})

describe("Stop", () => {
  test("a failed desktop refresh cannot clear its retained snapshot's truncation", async () => {
    const fake = engine()
    const task: Task.Info = {
      id: "workspace:one",
      parentSessionID: ROOT,
      source: "external",
      title: "Desktop worker",
      status: "running",
      startedAt: 1000,
      elapsedMs: 100,
      ownedPaths: [],
      dependsOn: [],
      resultAvailable: false,
      attempt: 1,
      controls: { inspect: true, message: false, stop: true },
    }
    const state = { failed: false, stops: 0 }
    const page = await open(fake, [ROOT, CHILD], {
      sourcePath: () => "/repo",
      api: {
        list: async () => {
          if (state.failed) throw new Error("Desktop unavailable")
          return { tasks: [task], truncated: true }
        },
        inspect: async () => {
          throw new Error("Unexpected inspect")
        },
        message: async () => {
          throw new Error("Unexpected message")
        },
        stop: async () => {
          state.stops += 1
          return { tasks: [task] }
        },
        onChange: () => () => undefined,
      },
    })
    await until(() => page.tasks.cards().some((card) => card.agents.some((agent) => agent.task?.id === task.id)))
    state.failed = true
    page.reconnect()
    await until(() => Boolean(page.tasks.error()?.includes("Desktop task updates unavailable")))
    await page.tasks.stopAllBackground()
    expect(state.stops).toBe(0)
    expect(fake.count("abort:ses_child")).toBe(0)
    page.dispose()
  })

  test("an incomplete board refuses Stop all before touching any visible worker", async () => {
    const fake = engine()
    fake.state.truncated = true
    const page = await open(fake, [ROOT, CHILD])
    await until(() => Boolean(page.tasks.error()?.includes("Showing the most recent tasks")))
    await page.tasks.stopAllBackground()
    expect(fake.count("abort:ses_child")).toBe(0)
    expect(page.agent()?.status).toBe("running")
    page.dispose()
  })

  test("settles an agent whose run the engine lost, and reloads the stopped agent and the root", async () => {
    const fake = engine()
    const page = await open(fake, [ROOT, CHILD])
    await until(() => fake.count("messages:ses_child") === 2)
    // A reload still in flight would answer Stop's own with what it read before the stop.
    await pause(30)
    const card = page.tasks.cards()[0]!
    expect(card.live).toBe(true)

    await page.tasks.stop(card)

    expect(fake.count("abort:ses_child")).toBe(1)
    expect(fake.count("messages:ses_child")).toBe(3)
    expect(fake.count("messages:ses_root")).toBe(2)
    expect(page.agent()?.status).toBe("stopped")
    expect(page.tasks.live()).toEqual([])
    page.dispose()
  })

  test("still reloads the agents when the engine refuses to stop them", async () => {
    const fake = engine()
    const page = await open(fake, [ROOT, CHILD])
    await until(() => fake.count("messages:ses_child") === 2)
    await pause(30)
    fake.state.abortFails = true

    await page.tasks.stopAllBackground()

    expect(fake.count("abort:ses_child")).toBe(1)
    expect(fake.count("messages:ses_child")).toBe(3)
    expect(page.agent()?.status).toBe("running")
    page.dispose()
  })
})

describe("Background commands", () => {
  // The flags can answer after the board's first load (a cold start, a restored tab), and an idle conversation with
  // only a dev server running sends no event that would load it again.
  test("flags that arrive after the first board load bring the conversation's commands", async () => {
    const fake = engine()
    fake.state.shells = [
      {
        id: "shl_dev",
        title: "bun run dev",
        command: "bun run dev",
        status: "running",
        startedAt: 1_000,
        outputBytes: 0,
      },
    ]
    const [capabilities, setCapabilities] = createSignal<EngineCapabilities>(NO_CAPABILITIES)
    const page = await open(fake, [ROOT, CHILD], undefined, capabilities)
    await until(() => fake.boards.length > 0)
    await pause(200)
    expect(fake.boards.every((shells) => shells === "")).toBe(true)
    expect(page.tasks.shells()).toEqual([])

    setCapabilities({ ...NO_CAPABILITIES, backgroundSubagents: true, backgroundShells: true })
    await until(() => page.tasks.shells().length === 1)
    expect(fake.boards.at(-1)).toBe("true")
    expect(page.tasks.shells()[0]?.id).toBe("shl_dev")
    page.dispose()
  })
})
