import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { isLocalSessionNotFoundError, sessionNotFoundError } from "@/utils/server-errors"
import { enqueue, resume, type FollowupItem, type PauseReason } from "./followup-model"
import type { DrainEnv, FollowupDrain } from "./followup-queue"
import { createFollowupStore, KEEP, memoryBackend, type FollowupLocks, type FollowupStore } from "./followup-store"

let queue: typeof import("./followup-queue")
let sendFollowupDraft: typeof import("@/components/prompt-input/submit").sendFollowupDraft

beforeAll(async () => {
  // The router's client build is not what bun test loads; these drainers never navigate.
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  queue = await import("./followup-queue")
  sendFollowupDraft = (await import("@/components/prompt-input/submit")).sendFollowupDraft
})

afterEach(() => {
  delete (window as { api?: unknown }).api
})

const SERVER = "http://127.0.0.1:4096"
const SESSION = "ses_1"
// Real work, so outside the queue the desktop's repository file map would apply; a greeting gets none.
const WORK = "add a caption under this picture that names its colors and what the square could represent"

const draft = (text: string, extra: Partial<FollowupDraft> = {}): FollowupDraft => ({
  sessionID: SESSION,
  sessionDirectory: "/repo",
  prompt: [{ type: "text", content: text, start: 0, end: text.length }],
  context: [],
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  ...extra,
})

/** Exclusive Web Locks shared by every window of the test, with `ifAvailable`. */
function fakeLocks(): FollowupLocks {
  const tails = new Map<string, Promise<void>>()
  const request = async (name: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (lock: { name: string } | null) => unknown
    const options = (rest.length > 1 ? rest[0] : {}) as { ifAvailable?: boolean }
    if (options.ifAvailable && tails.has(name)) return callback(null)
    const previous = tails.get(name) ?? Promise.resolve()
    let done = () => {}
    const mine = new Promise<void>((resolve) => (done = resolve))
    const tail = previous.then(() => mine)
    tails.set(name, tail)
    await previous
    try {
      return await callback({ name })
    } finally {
      done()
      if (tails.get(name) === tail) tails.delete(name)
    }
  }
  return { request } as unknown as FollowupLocks
}

const add = (store: FollowupStore, entry: FollowupItem) =>
  store.update(SERVER, entry.sessionID, (current, context) => {
    const result = enqueue(current, entry, context.total)
    return "queue" in result ? result.queue : KEEP
  })

function fakeEnv(overrides: Partial<DrainEnv> = {}): DrainEnv {
  let next = 0
  return {
    ready: () => true,
    sync: async () => {},
    gate: () => ({ busy: false, blocked: false, child: false, lastRun: { ended: "ok" } }),
    send: async () => true,
    delivered: async () => false,
    notFound: (error, sessionID) => isLocalSessionNotFoundError(error, sessionID),
    failed: () => {},
    paused: () => {},
    messageID: () => `msg_fresh_${++next}`,
    now: () => 1,
    ...overrides,
  }
}

/** A drainer for one window; `held` settles when it holds the server's drain lock. */
function drainer(input: { store: FollowupStore; env: DrainEnv; locks?: FollowupLocks; showing?: ReadonlySet<string> }) {
  let resolve = () => {}
  const held = new Promise<void>((done) => (resolve = done))
  const drain: FollowupDrain = queue.createFollowupDrain({
    server: SERVER,
    store: input.store,
    locks: input.locks,
    env: input.env,
    showing: () => input.showing ?? new Set(),
    onHolding: (holding) => holding && resolve(),
  })
  drain.start()
  return { drain, held }
}

/**
 * sendFollowupDraft against a fake engine, as the app's drainer calls it. `received` holds the message IDs the engine
 * took; with `hang` set, a command or shell input is taken and answered only when its run ends, which is never.
 */
function engine(options: { commands?: { name: string }[]; fail?: Error } = {}) {
  const prompts: { messageID?: string; parts: { text?: string; synthetic?: boolean }[] }[] = []
  const commands: { command: string; arguments: string; messageID?: string }[] = []
  const shells: { command: string; messageID?: string }[] = []
  const received = new Set<string>()
  const known = options.commands ?? []
  const state = { hang: false }
  const take = async (messageID: string | undefined) => {
    if (messageID) received.add(messageID)
    if (state.hang) await new Promise(() => {})
    return { data: undefined }
  }
  const client = {
    session: {
      promptAsync: async (input: (typeof prompts)[number]) => {
        if (options.fail) throw options.fail
        prompts.push(input)
        return take(input.messageID)
      },
      command: async (input: (typeof commands)[number]) => (commands.push(input), take(input.messageID)),
      shell: async (input: (typeof shells)[number]) => (shells.push(input), take(input.messageID)),
    },
  }
  const sync = {
    data: {
      get command() {
        return known
      },
      agent: [{ name: "build" }],
      // The drainer's page never loaded the session's replies.
      message: { [SESSION]: [] },
      part: {},
      config: {},
    },
    session: { optimistic: { add: () => undefined, remove: () => undefined } },
  }
  // session_status as the server sync holds it, and every write to it in order.
  const statuses: Record<string, string> = {}
  const writes: string[] = []
  const serverSync = {
    session: {
      data: { session_working: (id: string) => (statuses[id] ?? "idle") !== "idle" },
      set: (key: string, id: string, value: { type: string }) => {
        if (key !== "session_status") return
        statuses[id] = value.type
        writes.push(value.type)
      },
    },
  }
  type SendInput = Parameters<typeof sendFollowupDraft>[0]
  const send = (entry: FollowupDraft, messageID?: string) =>
    sendFollowupDraft({
      client: client as unknown as SendInput["client"],
      sync: sync as unknown as SendInput["sync"],
      serverSync: serverSync as unknown as SendInput["serverSync"],
      draft: entry,
      messageID,
      optimisticBusy: true,
    })
  // What the app's drainer sends with: `sendQueued`, which reads the session's status itself.
  const sendQueued = (item: FollowupItem, messageID: string) =>
    queue.sendQueued({
      client: client as unknown as SendInput["client"],
      sync: sync as unknown as SendInput["sync"],
      serverSync: serverSync as unknown as SendInput["serverSync"],
      item,
      messageID,
    })
  return { prompts, commands, shells, received, known, state, statuses, writes, send, sendQueued }
}

describe("follow-up drainer", () => {
  test("only the lock holder drains, and the next window takes over when it closes", async () => {
    const backend = memoryBackend()
    const locks = fakeLocks()
    const sent: [string, string][] = []
    const openWindow = (name: string) => {
      const store = createFollowupStore({ backend, locks })
      return {
        store,
        ...drainer({ store, locks, env: fakeEnv({ send: async (entry) => (sent.push([name, entry.id]), true) }) }),
      }
    }
    const one = openWindow("one")
    await one.held
    const two = openWindow("two")
    await add(one.store, queue.queuedItem(draft("first"), "item_1"))
    await add(one.store, queue.queuedItem(draft("second"), "item_2"))

    expect(two.drain.holding()).toBe(false)
    expect(await two.drain.attempt(SESSION)).toBe("held")
    expect(await one.drain.attempt(SESSION)).toBe("sent")
    expect(sent).toEqual([["one", "item_1"]])

    one.drain.dispose()
    await two.held
    expect(one.drain.holding()).toBe(false)
    expect(await one.drain.attempt(SESSION)).toBe("held")
    expect(await two.drain.attempt(SESSION)).toBe("sent")
    expect(sent).toEqual([
      ["one", "item_1"],
      ["two", "item_2"],
    ])
    two.drain.dispose()
  })

  test("an item is sent with its session's page closed", async () => {
    const locks = fakeLocks()
    const store = createFollowupStore({ backend: memoryBackend(), locks })
    const sent: string[] = []
    // No page shows the session: the lock holder sends it anyway.
    const { drain, held } = drainer({
      store,
      locks,
      showing: new Set(),
      env: fakeEnv({ send: async (entry) => (sent.push(entry.id), true) }),
    })
    await held
    await add(store, queue.queuedItem(draft("ship it"), "item_1"))

    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(sent).toEqual(["item_1"])
    expect(await store.read(SERVER, SESSION)).toBeUndefined()
    drain.dispose()
  })

  test("a replied item goes out without prepareAgentTask's file map", async () => {
    const prepared: string[] = []
    Object.assign(window, {
      api: {
        prepareAgentTask: async (_root: string, task: string) => (prepared.push(task), { instruction: "File map." }),
      },
    })
    const store = createFollowupStore({ backend: memoryBackend() })
    const fake = engine()
    const { drain } = drainer({
      store,
      showing: new Set([SESSION]),
      env: fakeEnv({ send: (entry, id) => fake.send(entry, id) }),
    })
    const queued = queue.queuedItem(draft(WORK))
    expect(queued.replied).toBe(true)
    await add(store, queued)

    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(prepared).toEqual([])
    expect(fake.prompts).toHaveLength(1)
    expect(fake.prompts[0]?.messageID).toBe("msg_fresh_1")
    expect(fake.prompts[0]?.parts.some((part) => part.text === "File map.")).toBe(false)

    // The same draft sent outside the queue, with no reply loaded, would get the file map.
    await fake.send(draft(WORK))
    expect(prepared).toEqual([WORK])
  })

  test("a queued /review waits for the commands to load and is sent as a command", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    const fake = engine()
    let loaded = false
    const { drain } = drainer({
      store,
      showing: new Set([SESSION]),
      env: fakeEnv({ ready: () => loaded, send: (entry, id) => fake.send(entry, id) }),
    })
    await add(store, queue.queuedItem(draft("/review the diff")))

    expect(await drain.attempt(SESSION)).toBe("waiting")
    expect(fake.prompts).toEqual([])
    expect(fake.commands).toEqual([])

    fake.known.push({ name: "review" })
    loaded = true
    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(fake.commands).toEqual([expect.objectContaining({ command: "review", arguments: "the diff" })])
    expect(fake.prompts).toEqual([])
  })

  test("a queued /review or shell command goes out under its claim's ID; after a reload, one the engine took is dropped, not run again", async () => {
    for (const entry of [draft("/review the diff"), draft("git push origin main", { shell: true })]) {
      const backend = memoryBackend()
      const fake = engine({ commands: [{ name: "review" }] })
      const sent = entry.shell ? fake.shells : fake.commands
      const env = fakeEnv({
        send: (item, id) => fake.send(item, id),
        delivered: async (_item, id) => fake.received.has(id),
      })
      const first = drainer({ store: createFollowupStore({ backend }), showing: new Set([SESSION]), env })
      await add(createFollowupStore({ backend }), queue.queuedItem(entry, "item_1"))

      // The engine takes it and answers only when the command's run ends, so the claim stays while it runs.
      fake.state.hang = true
      void first.drain.attempt(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(sent).toHaveLength(1)
      expect(sent[0]?.messageID).toBe("msg_fresh_1")
      const store = createFollowupStore({ backend })
      expect((await store.read(SERVER, SESSION))?.items[0]?.claim?.messageID).toBe("msg_fresh_1")

      // The window reloads while it runs. The next drainer finds the message the claim names and sends nothing.
      first.drain.dispose()
      fake.state.hang = false
      const second = drainer({ store, showing: new Set([SESSION]), env })
      expect(await second.drain.attempt(SESSION)).toBe("delivered")
      expect(sent).toHaveLength(1)
      expect(await store.read(SERVER, SESSION)).toBeUndefined()
      second.drain.dispose()
    }
  })

  test("Send now on a working session steers: its failure leaves the session busy, while one from idle shows it idle again", async () => {
    const fake = engine({ fail: new Error("The engine refused the message") })
    fake.statuses[SESSION] = "busy"
    const store = createFollowupStore({ backend: memoryBackend() })
    const env = fakeEnv({
      gate: () => ({
        busy: fake.statuses[SESSION] !== "idle",
        blocked: false,
        child: false,
        lastRun: { ended: "ok" },
      }),
      send: (item, id) => fake.sendQueued(item, id),
    })
    const { drain } = drainer({ store, showing: new Set([SESSION]), env })
    await add(store, queue.queuedItem(draft("also update the changelog"), "item_1"))
    expect(await drain.attempt(SESSION)).toBe("held")

    // The run goes on, so nothing marks the session idle (or busy), and Stop stays on the composer.
    expect(await drain.send(SESSION, "item_1")).toBe(false)
    expect(fake.writes).toEqual([])
    expect(fake.statuses[SESSION]).toBe("busy")
    expect((await store.read(SERVER, SESSION))?.failed).toBe("item_1")

    // Retry once the run has ended: the session reads busy until the engine answers, and idle after the failure.
    fake.statuses[SESSION] = "idle"
    expect(await drain.send(SESSION, "item_1")).toBe(false)
    expect(fake.writes).toEqual(["busy", "idle"])
    drain.dispose()
  })

  test("a session that no longer exists drops its queue", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    const sent: string[] = []
    let gone: "sync" | "send" = "sync"
    const { drain } = drainer({
      store,
      showing: new Set([SESSION]),
      env: fakeEnv({
        sync: async (sessionID) => {
          if (gone === "sync") throw sessionNotFoundError(sessionID)
        },
        send: async (entry) => {
          sent.push(entry.id)
          throw sessionNotFoundError(entry.sessionID)
        },
      }),
    })
    await add(store, queue.queuedItem(draft("one")))
    await add(store, queue.queuedItem(draft("two")))
    expect(await drain.attempt(SESSION)).toBe("dropped")
    expect(await store.read(SERVER, SESSION)).toBeUndefined()
    expect(sent).toEqual([])

    // The engine says so only when the send arrives: the whole queue goes too.
    gone = "send"
    await add(store, queue.queuedItem(draft("three"), "item_3"))
    await add(store, queue.queuedItem(draft("four"), "item_4"))
    expect(await drain.attempt(SESSION)).toBe("dropped")
    expect(sent).toEqual(["item_3"])
    expect(await store.read(SERVER, SESSION)).toBeUndefined()
  })

  test("an error marks the item failed and nothing retries it on its own", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    const failures: string[] = []
    let sends = 0
    let release = () => {}
    const slow = new Promise<void>((resolve) => (release = resolve))
    const env = fakeEnv({
      send: async () => {
        sends++
        await slow
        throw new Error("engine said no")
      },
      failed: (_entry, error) => failures.push((error as Error).message),
    })
    const { drain } = drainer({ store, showing: new Set([SESSION]), env })
    await add(store, queue.queuedItem(draft("one"), "item_1"))
    await add(store, queue.queuedItem(draft("two"), "item_2"))

    // A wake while the send is out runs the drainer once more afterwards, which then holds.
    const first = drain.attempt(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await drain.attempt(SESSION)).toBe("busy")
    release()
    expect(await first).toBe("failed")
    await new Promise((resolve) => setTimeout(resolve, 5))

    const stored = await store.read(SERVER, SESSION)
    expect(stored?.failed).toBe("item_1")
    expect(stored?.items.map((entry) => entry.id)).toEqual(["item_1", "item_2"])
    expect(stored?.items[0]?.claim?.messageID).toBe("msg_fresh_1")
    for (let round = 0; round < 3; round++) expect(await drain.attempt(SESSION)).toBe("held")
    expect(sends).toBe(1)
    expect(failures).toEqual(["engine said no"])

    // Retry: the engine never got it, so it goes again under the ID it was claimed with.
    const retried: string[] = []
    env.send = async (_entry, messageID) => (retried.push(messageID), true)
    expect(await drain.send(SESSION, "item_1")).toBe(true)
    expect(retried).toEqual(["msg_fresh_1"])
    expect((await store.read(SERVER, SESSION))?.failed).toBeUndefined()
  })

  test("a run that ended badly pauses the queue once; Resume lets it send", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    const pauses: [PauseReason, string | undefined][] = []
    const sent: string[] = []
    const env = fakeEnv({
      gate: () => ({ busy: false, blocked: false, child: false, lastRun: { id: "msg_run", ended: "budget" } }),
      send: async (entry) => (sent.push(entry.id), true),
      paused: (_session, reason, lastRunID) => pauses.push([reason, lastRunID]),
    })
    const { drain } = drainer({ store, showing: new Set([SESSION]), env })
    await add(store, queue.queuedItem(draft("after the stop"), "item_1"))

    expect(await drain.attempt(SESSION)).toBe("held")
    expect(await drain.attempt(SESSION)).toBe("held")
    expect(pauses).toEqual([["budget", "msg_run"]])
    expect((await store.read(SERVER, SESSION))?.paused?.reason).toBe("budget")
    expect(sent).toEqual([])

    await store.update(SERVER, SESSION, (current) => resume(current, "msg_run") ?? KEEP)
    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(sent).toEqual(["item_1"])
  })
})
