import { beforeAll, describe, expect, mock, test } from "bun:test"
import { ATTACHMENT_LIMIT, claim, enqueue, type FollowupItem, type Refusal } from "./followup-model"
import type { DrainEnv } from "./followup-queue"
import {
  createFollowupStore,
  drainsSession,
  INDEX_KEY,
  KEEP,
  memoryBackend,
  queueKey,
  type FollowupBackend,
  type FollowupChange,
  type FollowupChannel,
  type FollowupLocks,
  type FollowupStore,
} from "./followup-store"

let createFollowupDrain: typeof import("./followup-queue").createFollowupDrain

beforeAll(async () => {
  // The router's client build is not what bun test loads; the drainer never navigates in these tests.
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  createFollowupDrain = (await import("./followup-queue")).createFollowupDrain
})

const SERVER = "http://127.0.0.1:4096"
const SESSION = "ses_1"

const item = (id: string, extra: Partial<FollowupItem> = {}): FollowupItem => ({
  id,
  sessionID: SESSION,
  sessionDirectory: "/repo",
  prompt: [{ type: "text", content: `message ${id}`, start: 0, end: 9 }],
  context: [],
  agent: "build",
  model: { providerID: "p", modelID: "m" },
  ...extra,
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** One storage shared by several windows, where every read and write takes a turn, so unguarded writes interleave. */
function slowBackend(): FollowupBackend & { entries: Map<string, string> } {
  const memory = memoryBackend()
  return {
    entries: memory.entries,
    getItem: async (key) => {
      await tick()
      return memory.getItem(key)
    },
    setItem: async (key, value) => {
      await tick()
      memory.setItem(key, value)
    },
    removeItem: async (key) => {
      await tick()
      memory.removeItem(key)
    },
  }
}

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

/** BroadcastChannel between the test's windows: a post reaches every other window, never the sender. */
function channelHub() {
  const members = new Set<(change: FollowupChange) => void>()
  return (): FollowupChannel => {
    const listeners = new Set<(change: FollowupChange) => void>()
    const deliver = (change: FollowupChange) => listeners.forEach((listener) => listener(change))
    members.add(deliver)
    return {
      post: (change) => {
        for (const member of members) if (member !== deliver) queueMicrotask(() => member(change))
      },
      listen: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      close: () => void members.delete(deliver),
    }
  }
}

const add = (store: FollowupStore, entry: FollowupItem, refusals: (Refusal | undefined)[] = []) =>
  store.update(SERVER, entry.sessionID, (queue, context) => {
    const result = enqueue(queue, entry, context.total)
    refusals.push("refused" in result ? result.refused : undefined)
    return "queue" in result ? result.queue : KEEP
  })

const env = (overrides: Partial<DrainEnv> = {}): DrainEnv => {
  let next = 0
  return {
    ready: () => true,
    sync: async () => {},
    gate: () => ({ busy: false, blocked: false, child: false, lastRun: { ended: "ok" } }),
    send: async () => true,
    delivered: async () => false,
    notFound: () => false,
    failed: () => {},
    paused: () => {},
    messageID: () => `msg_fresh_${++next}`,
    now: () => 1,
    ...overrides,
  }
}

describe("follow-up store", () => {
  test("concurrent windows keep both items", async () => {
    const backend = slowBackend()
    const locks = fakeLocks()
    const one = createFollowupStore({ backend, locks })
    const two = createFollowupStore({ backend, locks })

    await Promise.all([add(one, item("from-one")), add(two, item("from-two"))])

    expect((await two.read(SERVER, SESSION))?.items.map((entry) => entry.id).sort()).toEqual(["from-one", "from-two"])
    expect(await one.index()).toEqual({ [SERVER]: { [SESSION]: 2 } })

    // The same two writes without the lock lose one, so the storage above really interleaves them.
    const loose = slowBackend()
    const three = createFollowupStore({ backend: loose })
    const four = createFollowupStore({ backend: loose })
    await Promise.all([add(three, item("from-three")), add(four, item("from-four"))])
    expect((await three.read(SERVER, SESSION))?.items).toHaveLength(1)
  })

  test("the broadcast reloads the queue in other windows", async () => {
    const backend = memoryBackend()
    const hub = channelHub()
    const one = createFollowupStore({ backend, channel: hub() })
    const two = createFollowupStore({ backend, channel: hub() })
    const heard: FollowupChange[] = []
    one.subscribe((change) => heard.push(change))
    const reloaded = new Promise((resolve) =>
      two.subscribe((change) => void two.read(change.server, change.session).then(resolve)),
    )

    await add(one, item("a"))

    expect(await reloaded).toEqual({ items: [item("a")] })
    // The writing window hears its own change once, from itself, not back from the channel.
    await tick()
    expect(heard).toEqual([{ server: SERVER, session: SESSION }])
  })

  test("without Web Locks only the page showing a session drains it", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    expect(store.locked).toBe(false)
    expect(createFollowupStore({ backend: memoryBackend(), locks: fakeLocks() }).locked).toBe(true)

    expect(drainsSession({ locked: false, holding: false, showing: new Set([SESSION]) }, SESSION)).toBe(true)
    expect(drainsSession({ locked: false, holding: true, showing: new Set() }, SESSION)).toBe(false)
    expect(drainsSession({ locked: true, holding: false, showing: new Set([SESSION]) }, SESSION)).toBe(false)
    expect(drainsSession({ locked: true, holding: true, showing: new Set() }, SESSION)).toBe(true)

    const shown = new Set<string>()
    const sent: string[] = []
    const drain = createFollowupDrain({
      server: SERVER,
      store,
      env: env({ send: async (entry) => (sent.push(entry.id), true) }),
      showing: () => shown,
    })
    drain.start()
    await add(store, item("a"))

    expect(await drain.attempt(SESSION)).toBe("held")
    expect(sent).toEqual([])
    shown.add(SESSION)
    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(sent).toEqual(["a"])
  })

  test("a claimed item is resent with its ID after a reload, or dropped when the engine has it", async () => {
    const backend = memoryBackend()
    const locks = fakeLocks()
    // A window claimed the head and went away (a reload or a crash) before the send finished.
    const before = createFollowupStore({ backend, locks })
    await before.update(SERVER, SESSION, () => claim({ items: [item("a"), item("b")] }, "a", "msg_claimed", 1))

    const after = createFollowupStore({ backend, locks })
    const sends: [string, string][] = []
    const asked: string[] = []
    let delivered = false
    const drain = createFollowupDrain({
      server: SERVER,
      store: after,
      locks,
      env: env({
        delivered: async (_entry, messageID) => (asked.push(messageID), delivered),
        send: async (entry, messageID) => {
          // A fresh item is claimed inside the write lock before it goes out.
          const stored = (await after.read(SERVER, SESSION))?.items.find((value) => value.id === entry.id)
          expect(stored?.claim?.messageID).toBe(messageID)
          sends.push([entry.id, messageID])
          return true
        },
      }),
    })
    const holding = new Promise<void>((resolve) => {
      const timer = setInterval(() => drain.holding() && (clearInterval(timer), resolve()), 1)
    })
    drain.start()
    await holding

    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(asked).toEqual(["msg_claimed"])
    expect(sends).toEqual([["a", "msg_claimed"]])

    expect(await drain.attempt(SESSION)).toBe("sent")
    expect(sends[1]).toEqual(["b", "msg_fresh_1"])
    expect(await after.read(SERVER, SESSION)).toBeUndefined()

    // The engine already has the claimed message: the item is dropped, never sent twice.
    await before.update(SERVER, SESSION, () => claim({ items: [item("c")] }, "c", "msg_landed", 2))
    delivered = true
    expect(await drain.attempt(SESSION)).toBe("delivered")
    expect(sends).toHaveLength(2)
    expect(await after.read(SERVER, SESSION)).toBeUndefined()
    drain.dispose()
  })

  test("attachments past 8 MB are refused, and a full storage evicts nothing", async () => {
    const store = createFollowupStore({ backend: memoryBackend() })
    const image = (bytes: number) => [
      { type: "image" as const, id: "img", filename: "a.png", mime: "image/png", dataUrl: "x".repeat(bytes) },
    ]
    const refusals: (Refusal | undefined)[] = []
    await add(store, item("a", { prompt: image(ATTACHMENT_LIMIT - 10) }), refusals)
    await add(store, item("b", { prompt: image(11) }), refusals)
    await add(store, item("c", { prompt: image(10) }), refusals)
    expect(refusals).toEqual([undefined, "attachments", undefined])
    expect((await store.read(SERVER, SESSION))?.items.map((entry) => entry.id)).toEqual(["a", "c"])

    const memory = memoryBackend()
    memory.setItem("vector.other", "kept")
    const full: FollowupBackend = {
      ...memory,
      setItem: (key, value) => {
        if (key.startsWith("queue:") && memory.entries.has(key)) throw new DOMException("full", "QuotaExceededError")
        memory.setItem(key, value)
      },
    }
    const cramped = createFollowupStore({ backend: full })
    await add(cramped, item("x"))
    await expect(add(cramped, item("y"))).rejects.toThrow("full")
    expect((await cramped.read(SERVER, SESSION))?.items.map((entry) => entry.id)).toEqual(["x"])
    expect(memory.entries.get("vector.other")).toBe("kept")
  })

  test("load finds every server's queues, and an emptied queue leaves no key", async () => {
    const backend = memoryBackend()
    const store = createFollowupStore({ backend })
    await add(store, item("a"))
    await add(store, item("b", { sessionID: "ses_2" }))
    await store.update("other", SESSION, () => ({ items: [item("c")] }))

    const loaded = await createFollowupStore({ backend }).load()
    expect(Object.keys(loaded).sort()).toEqual([SERVER, "other"].sort())
    expect(Object.keys(loaded[SERVER] ?? {}).sort()).toEqual([SESSION, "ses_2"])

    await store.update(SERVER, SESSION, () => undefined)
    expect(backend.entries.has(queueKey(SERVER, SESSION))).toBe(false)
    expect(JSON.parse(backend.entries.get(INDEX_KEY) ?? "{}")).toEqual({
      [SERVER]: { ses_2: 1 },
      other: { [SESSION]: 1 },
    })
  })
})
