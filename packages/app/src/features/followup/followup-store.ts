import type { Platform } from "@/context/platform"
import { parseQueue, serverTotal, type FollowupQueue } from "./followup-model"

/*
 * Where queued follow-ups live (5.I.1): the dedicated storage `vector.followup.dat`, with an index key plus one key per
 * server and session, shared by every window of this app. Every write is a read-modify-write inside the Web Lock
 * `vector.followup.write`, announced on the BroadcastChannel `vector.followup` so other windows reload that queue. The
 * writes go straight to the storage, never through persist.ts and its quota eviction: a full storage refuses the write.
 */

export const FOLLOWUP_STORAGE = "vector.followup.dat"
export const INDEX_KEY = "index"
export const WRITE_LOCK = "vector.followup.write"
export const CHANNEL = "vector.followup"

/** Either a desktop store (async, over IPC) or the browser's localStorage under the storage's prefix. */
export type FollowupBackend = {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export type FollowupLocks = Pick<LockManager, "request">

export type FollowupChange = { server: string; session: string }

export type FollowupChannel = {
  post(change: FollowupChange): void
  listen(listener: (change: FollowupChange) => void): () => void
  close(): void
}

/** Queued items per server and session, so a window finds every queue and counts a server's items without reading them. */
export type FollowupIndex = Record<string, Record<string, number>>

export type FollowupState = Record<string, Record<string, FollowupQueue>>

/** Returned by an update to leave the queue as it is. */
export const KEEP = Symbol("keep")

export type FollowupUpdate = (
  queue: FollowupQueue | undefined,
  context: { /** The server's queued items, this session's included. */ total: number },
) => FollowupQueue | undefined | typeof KEEP

export function queueKey(server: string, session: string) {
  return `queue:${encodeURIComponent(server)}:${encodeURIComponent(session)}`
}

function parse(raw: string | null) {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function parseIndex(value: unknown): FollowupIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const index: FollowupIndex = {}
  for (const [server, sessions] of Object.entries(value)) {
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) continue
    const counts: Record<string, number> = {}
    for (const [session, count] of Object.entries(sessions))
      if (typeof count === "number" && Number.isFinite(count) && count > 0) counts[session] = count
    if (Object.keys(counts).length > 0) index[server] = counts
  }
  return index
}

function withCount(index: FollowupIndex, server: string, session: string, count: number): FollowupIndex {
  const sessions = { ...(index[server] ?? {}) }
  if (count > 0) sessions[session] = count
  else delete sessions[session]
  const next = { ...index }
  if (Object.keys(sessions).length > 0) next[server] = sessions
  else delete next[server]
  return next
}

export type FollowupStore = ReturnType<typeof createFollowupStore>

export function createFollowupStore(input: {
  backend: FollowupBackend
  locks?: FollowupLocks
  channel?: FollowupChannel
}) {
  const listeners = new Set<(change: FollowupChange) => void>()
  const notify = (change: FollowupChange) => {
    for (const listener of [...listeners]) listener(change)
  }
  const unlisten = input.channel?.listen(notify)

  // Writes from this window run one at a time; the Web Lock orders them against other windows. Without locks
  // (plain-http `vector web`), only this window's writes are ordered.
  let chain: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const locks = input.locks
    const next = chain.then(async (): Promise<T> => {
      if (!locks) return run()
      let result!: T
      await locks.request(WRITE_LOCK, async () => {
        result = await run()
      })
      return result
    })
    chain = next.catch(() => undefined)
    return next
  }

  const readIndex = async () => parseIndex(parse(await input.backend.getItem(INDEX_KEY)))
  const read = async (server: string, session: string) =>
    parseQueue(parse(await input.backend.getItem(queueKey(server, session))))

  return {
    /** Whether this browser has Web Locks: without them only the page showing a session drains its queue. */
    locked: !!input.locks,
    read,
    index: readIndex,
    /** Every stored queue, by server and session. */
    async load(): Promise<FollowupState> {
      const index = await readIndex()
      const state: FollowupState = {}
      for (const [server, sessions] of Object.entries(index)) {
        for (const session of Object.keys(sessions)) {
          const queue = await read(server, session)
          if (!queue) continue
          state[server] ??= {}
          state[server][session] = queue
        }
      }
      return state
    },
    /**
     * Read-modify-write of one queue inside the write lock, then the broadcast. An emptied queue is removed. A storage
     * error (a full storage) rejects and leaves the queue as it was.
     */
    update(server: string, session: string, change: FollowupUpdate): Promise<FollowupQueue | undefined> {
      return exclusive(async () => {
        const index = await readIndex()
        const current = await read(server, session)
        const total = serverTotal({ ...(index[server] ?? {}), [session]: current?.items.length ?? 0 })
        const next = change(current, { total })
        if (next === KEEP) return current
        const queue = next && next.items.length > 0 ? next : undefined
        const key = queueKey(server, session)
        // The index is written before a queue that has items and after one is removed, so an interrupted write never
        // leaves items no index entry points to.
        if (queue) {
          if (index[server]?.[session] !== queue.items.length)
            await input.backend.setItem(
              INDEX_KEY,
              JSON.stringify(withCount(index, server, session, queue.items.length)),
            )
          await input.backend.setItem(key, JSON.stringify(queue))
        } else {
          await input.backend.removeItem(key)
          if (index[server]?.[session] !== undefined)
            await input.backend.setItem(INDEX_KEY, JSON.stringify(withCount(index, server, session, 0)))
        }
        const announced = { server, session }
        input.channel?.post(announced)
        notify(announced)
        return queue
      })
    },
    /** Called for every change: this window's writes and other windows' broadcasts. */
    subscribe(listener: (change: FollowupChange) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    close() {
      unlisten?.()
      input.channel?.close()
      listeners.clear()
    },
  }
}

/**
 * Whether this window drains a session's queue. With Web Locks, the window holding the server's drain lock drains every
 * session, its page open or not. Without them, only the window showing the session drains it.
 */
export function drainsSession(
  input: { locked: boolean; holding: boolean; showing: ReadonlySet<string> },
  session: string,
) {
  if (input.locked) return input.holding
  return input.showing.has(session)
}

/** In memory only: for a browser that refuses storage, and for tests. */
export function memoryBackend(): FollowupBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  }
}

/** localStorage under `vector.followup.dat:`. A quota error propagates; nothing else is evicted to make room. */
export function localStorageBackend(storage: Storage, prefix = `${FOLLOWUP_STORAGE}:`): FollowupBackend {
  return {
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
  }
}

export function followupBackend(platform: Pick<Platform, "platform" | "storage">): FollowupBackend {
  if (platform.platform === "desktop" && platform.storage) {
    const storage = platform.storage(FOLLOWUP_STORAGE)
    return {
      getItem: (key) => storage.getItem(key),
      setItem: async (key, value) => void (await storage.setItem(key, value)),
      removeItem: async (key) => void (await storage.removeItem(key)),
    }
  }
  try {
    const storage = globalThis.localStorage
    if (storage) return localStorageBackend(storage)
  } catch {}
  return memoryBackend()
}

/** navigator.locks, which secure contexts have; a page served over plain http on a LAN does not. */
export function navigatorLocks(): FollowupLocks | undefined {
  const locks = globalThis.navigator?.locks
  return locks && typeof locks.request === "function" ? locks : undefined
}

export function broadcastChannel(name = CHANNEL): FollowupChannel | undefined {
  if (typeof globalThis.BroadcastChannel !== "function") return
  const channel = new BroadcastChannel(name)
  return {
    post: (change) => channel.postMessage(change),
    listen(listener) {
      const handler = (event: MessageEvent) => {
        const data = event.data as Partial<FollowupChange> | undefined
        if (typeof data?.server === "string" && typeof data.session === "string")
          listener({ server: data.server, session: data.session })
      }
      channel.addEventListener("message", handler)
      return () => channel.removeEventListener("message", handler)
    },
    close: () => channel.close(),
  }
}
