import { Option, Schema } from "effect"

/*
 * Keeps the computer awake while the local engine has work running.
 *
 * Idle sleep froze agents mid-run: on battery a Mac can sleep after a minute without input, and a sleeping machine
 * only moves its agents forward in brief dark wakes. While any session in the engine is busy or retrying, this holds
 * a power save blocker that lets the display sleep but keeps the system awake. Sleep the user asks for still happens:
 * closing a laptop's lid sleeps it whatever is running.
 *
 * Busy sessions are tracked here, from the engine's own event stream, and never from a window, whose stream is what
 * goes stale. Each connection is seeded from the status of every directory sessions have run in. The blocker is never
 * held on old news: once the stream has been down or silent for longer than `silenceMs` (the engine sends a heartbeat
 * every 10 seconds), it is released until a fresh connection has been seeded.
 *
 * Sessions the engine's V2 runner drains (a parallel workspace's Vector agent, a swarm's planner and workers) never
 * report a session.status, and nothing announces that a drain ended. The runner lists the drains it owns, so that list
 * is read with each seed, as soon as a session it does not know of shows V2 activity, and every `pollMs` while any
 * drain is known. A session a read did not list asks again at most once per `pollMs`: a remote workspace's sessions
 * relay their activity here but never run on this runner.
 *
 * Nor is it held for work that waits on the user. A session stays busy while a permission or question prompt is
 * unanswered, so a session with one does not count. Its parent, waiting on it as a foreground subagent, still looks
 * busy; so while any prompt is unanswered, the blocker is released once nothing has moved for `stalledMs`.
 *
 * Except while a paired phone watches (Vector Remote, WP A41: `watching`): the person can answer from the phone, so
 * every busy session holds the blocker, one waiting on a prompt included, for as long as the phone stays. The relay
 * closes a phone that sends nothing for 30 minutes, which ends the watch.
 */

const SILENCE_MS = 5 * 60_000
const STALLED_MS = 10 * 60_000
const POLL_MS = 15_000
const RETRY_MS = 1_000
const RETRY_MAX_MS = 30_000
const WATCHDOG_MAX_MS = 15_000
const SEED_TIMEOUT_MS = 10_000
const BUSY = new Set(["busy", "retry"])
const ASKED = new Set(["permission.asked", "question.asked", "permission.v2.asked", "question.v2.asked"])
const ANSWERED = new Set([
  "permission.replied",
  "question.replied",
  "question.rejected",
  "permission.v2.replied",
  "question.v2.replied",
  "question.v2.rejected",
])

const KeepAwakeEvent = Schema.Struct({
  directory: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Struct({ type: Schema.String, properties: Schema.optional(Schema.Unknown) }),
})
export type KeepAwakeEvent = typeof KeepAwakeEvent.Type

const Status = Schema.Struct({ type: Schema.String })
const Statuses = Schema.Record(Schema.String, Status)
const Request = Schema.Struct({ id: Schema.String, sessionID: Schema.String })
const Requests = Schema.Array(Request)
const Drains = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })
const SessionRequests = Schema.Struct({ data: Requests })
const SessionProperties = Schema.Struct({ sessionID: Schema.String })
const StatusProperties = Schema.Struct({ sessionID: Schema.String, status: Status })
const AnsweredProperties = Schema.Struct({ requestID: Schema.String })
const DisposedProperties = Schema.Struct({ directory: Schema.String })

export type KeepAwakeLocation = { directory: string; workspace?: string }

export type KeepAwakeSource = {
  /** The engine's global event stream. It ends or throws when the connection drops, and stops when `signal` aborts. */
  events(signal: AbortSignal): AsyncIterable<KeepAwakeEvent>
  /** The status of each session the engine has for one directory; sessions missing from it are idle. */
  statuses(location: KeepAwakeLocation, signal: AbortSignal): Promise<Readonly<Record<string, { type: string }>>>
  /** The permission and question prompts waiting on the user in one directory. */
  requests(location: KeepAwakeLocation, signal: AbortSignal): Promise<readonly { id: string; sessionID: string }[]>
  /** The sessions the engine's V2 runner is draining; sessions missing from it are not running there. */
  drains(signal: AbortSignal): Promise<readonly string[]>
  /** The permission and question prompts one session on the V2 runner waits on the user for. */
  prompts(sessionID: string, signal: AbortSignal): Promise<readonly { id: string; sessionID: string }[]>
}

export type PowerBlocker = { start(): number; stop(id: number): void }

export function startKeepAwake(input: {
  source: KeepAwakeSource
  blocker: PowerBlocker
  /** How long the stream may be down or silent before what it last said stops holding the blocker. */
  silenceMs?: number
  /** How long work may go without progress, while a prompt waits on the user, before it stops holding the blocker. */
  stalledMs?: number
  /** How often the V2 runner's drains are read while any is known to run. */
  pollMs?: number
  /** The first reconnect delay; it doubles after each failed attempt, up to 30 seconds. */
  retryMs?: number
  /** Whether a paired phone is attached and watching (Remote); call `refresh()` when it changes. */
  watching?: () => boolean
  log?: (message: string, meta?: Record<string, unknown>) => void
}) {
  const silenceMs = input.silenceMs ?? SILENCE_MS
  const stalledMs = input.stalledMs ?? STALLED_MS
  const retryMs = input.retryMs ?? RETRY_MS
  const pollMs = input.pollMs ?? POLL_MS
  // Each busy or retrying session, with the key of the location its status came from.
  const busy = new Map<string, string>()
  // Each session the V2 runner drained when it was last asked.
  const drains = new Set<string>()
  // Sessions whose V2 activity asked for a read of the drains that has not started yet.
  const asking = new Set<string>()
  // Sessions whose V2 activity a read, started after it, did not list, with when that read ended.
  const unlisted = new Map<string, number>()
  // Each prompt waiting on the user, with the session that asked it.
  const waiting = new Map<string, string>()
  const locations = new Map<string, KeepAwakeLocation>()
  let held: number | undefined
  // When a seeded connection was last heard from; only that keeps the blocker held.
  let heardAt = Date.now()
  // When the current connection attempt was last heard from, seeded or not.
  let activeAt = Date.now()
  // When a session last changed status or wrote to its messages.
  let progressAt = Date.now()
  let seeded = 0
  let stopped = false
  let attempt: AbortController | undefined
  // The seeded connection the drains are read for; a read that outlives it says nothing about the next one.
  let live: AbortSignal | undefined
  let polling = false
  let again = false
  // A read put off until `pollMs` after a read that did not list a session asking again.
  let deferred: ReturnType<typeof setTimeout> | undefined

  const apply = () => {
    const sessions = new Set([...busy.keys(), ...drains])
    const blocked = new Set(waiting.values())
    const watched = input.watching?.() === true
    // A watching phone can answer what a session waits on, so then every busy session counts.
    const working = watched ? [...sessions] : [...sessions].filter((sessionID) => !blocked.has(sessionID))
    const stalled = !watched && working.length < sessions.size && Date.now() - progressAt > stalledMs
    const hold = !stopped && working.length > 0 && !stalled && Date.now() - heardAt <= silenceMs
    if (hold && held === undefined) {
      held = input.blocker.start()
      input.log?.("keep awake: holding off idle sleep", {
        sessions: working.length,
        ...(watched ? { phone: true } : {}),
      })
    }
    if (!hold && held !== undefined) {
      input.blocker.stop(held)
      held = undefined
      input.log?.("keep awake: released", { sessions: working.length, waiting: sessions.size - working.length })
    }
  }

  // A drain that ended has nothing left to ask, like a session that went idle.
  const setDrains = (ids: readonly string[]) => {
    const ended = [...drains].filter((sessionID) => !ids.includes(sessionID))
    for (const entry of waiting) if (ended.includes(entry[1])) waiting.delete(entry[0])
    drains.clear()
    ids.forEach((sessionID) => drains.add(sessionID))
  }

  // A read that fails forgets the drains rather than holding the blocker on old news; the next read counts them again.
  // A read asked for while one is in flight runs after it, since the one in flight may have started too early to see a
  // drain that just began.
  const poll = () => {
    const signal = live
    if (!signal) return
    if (polling) {
      again = true
      return
    }
    polling = true
    const asked = [...asking]
    asking.clear()
    // A session that asked for this read and is not in it, or asked for one that failed, asks again only once `pollMs`
    // has passed.
    const settle = (ids: readonly string[]) => {
      if (live !== signal) return
      setDrains(ids)
      const at = Date.now()
      for (const entry of unlisted) if (ids.includes(entry[0]) || at - entry[1] >= pollMs) unlisted.delete(entry[0])
      asked.filter((sessionID) => !ids.includes(sessionID)).forEach((sessionID) => unlisted.set(sessionID, at))
    }
    void input.source
      .drains(AbortSignal.any([signal, AbortSignal.timeout(SEED_TIMEOUT_MS)]))
      .then(settle, () => settle([]))
      .finally(() => {
        polling = false
        apply()
        if (!again) return
        again = false
        poll()
      })
  }

  const handle = (event: KeepAwakeEvent) => {
    const type = event.payload.type
    if (type.startsWith("message.") || type.startsWith("session.next.") || type === "session.status")
      progressAt = Date.now()
    if (type.startsWith("session.next.")) {
      const activity = Option.getOrUndefined(Schema.decodeUnknownOption(SessionProperties)(event.payload.properties))
      // A session the runner was not draining at the last read may have just started: read the drains now rather than
      // at the next poll, which only runs while a drain is known.
      if (!activity || drains.has(activity.sessionID)) return
      asking.add(activity.sessionID)
      // A session a read did not list a moment ago is read for again once `pollMs` has passed, not dropped: its drain
      // may have begun just after that read.
      const wait = (unlisted.get(activity.sessionID) ?? -Infinity) + pollMs - Date.now()
      if (wait <= 0) {
        poll()
        return
      }
      if (deferred) return
      deferred = setTimeout(() => {
        deferred = undefined
        poll()
      }, wait)
      deferred.unref()
      return
    }
    if (type === "session.status") {
      const change = Option.getOrUndefined(Schema.decodeUnknownOption(StatusProperties)(event.payload.properties))
      if (!change || !event.directory) return
      const location = { directory: event.directory, ...(event.workspace ? { workspace: event.workspace } : {}) }
      const key = locationKey(location)
      locations.set(key, location)
      busy.delete(change.sessionID)
      if (BUSY.has(change.status.type)) {
        busy.set(change.sessionID, key)
        return
      }
      // An idle session has nothing left to ask. A prompt it never announced an answer to (disposing a directory ends
      // its prompts silently) must not hide the session's next run.
      for (const entry of waiting) if (entry[1] === change.sessionID) waiting.delete(entry[0])
      return
    }
    if (ASKED.has(type)) {
      const request = Option.getOrUndefined(Schema.decodeUnknownOption(Request)(event.payload.properties))
      if (request) waiting.set(request.id, request.sessionID)
      return
    }
    if (ANSWERED.has(type)) {
      const answered = Option.getOrUndefined(Schema.decodeUnknownOption(AnsweredProperties)(event.payload.properties))
      if (answered) waiting.delete(answered.requestID)
      return
    }
    if (type !== "server.instance.disposed") return
    const disposed = Option.getOrUndefined(Schema.decodeUnknownOption(DisposedProperties)(event.payload.properties))
    if (!disposed) return
    // A disposed directory runs nothing, and asking it for statuses on the next connection would start it again. It
    // ends its own sessions' prompts, never those of a V2 drain: the runner is process-global and keeps waiting.
    for (const entry of locations) if (entry[1].directory === disposed.directory) locations.delete(entry[0])
    for (const entry of busy) if (!locations.has(entry[1])) busy.delete(entry[0])
    for (const entry of waiting) if (!busy.has(entry[1]) && !drains.has(entry[1])) waiting.delete(entry[0])
  }

  // Events that arrive while the seed is in flight wait in the stream and apply after it, in order, so the newest
  // word on each session wins. A directory, or the V2 runner, that cannot answer is left out rather than failing the
  // connection, so one bad source never keeps the others from being followed; its sessions count again from their next
  // status, or the next read of the drains.
  const seed = async (signal: AbortSignal) => {
    const limit = () => AbortSignal.any([signal, AbortSignal.timeout(SEED_TIMEOUT_MS)])
    const settled = await Promise.all([
      Promise.allSettled(
        [...locations].map(async (entry) => {
          const both = await Promise.all([
            input.source.statuses(entry[1], limit()),
            input.source.requests(entry[1], limit()),
          ])
          return { key: entry[0], statuses: both[0], requests: both[1] }
        }),
      ),
      Promise.allSettled([
        // A drain whose prompts cannot be read, one that ended since the list was read for example, counts as waiting
        // on nothing rather than hiding every other drain.
        input.source.drains(limit()).then(async (ids) => ({
          ids,
          prompts: await Promise.allSettled(ids.map((sessionID) => input.source.prompts(sessionID, limit()))),
        })),
      ]),
    ])
    signal.throwIfAborted()
    const answers = settled[0]
    const drained = settled[1][0]
    const failed = [...answers, drained, ...(drained.status === "fulfilled" ? drained.value.prompts : [])].flatMap(
      (answer) => (answer.status === "rejected" ? [answer.reason] : []),
    )
    if (failed.length > 0)
      input.log?.("keep awake: some sessions could not report their status", {
        sources: failed.length,
        error: String(failed[0]),
      })
    busy.clear()
    drains.clear()
    waiting.clear()
    answers.forEach((answer) => {
      if (answer.status === "rejected") return
      Object.entries(answer.value.statuses)
        .filter((entry) => BUSY.has(entry[1].type))
        .forEach((entry) => busy.set(entry[0], answer.value.key))
      answer.value.requests.forEach((request) => waiting.set(request.id, request.sessionID))
    })
    if (drained.status === "rejected") return
    drained.value.ids.forEach((sessionID) => drains.add(sessionID))
    drained.value.prompts
      .flatMap((read) => (read.status === "fulfilled" ? read.value : []))
      .forEach((request) => waiting.set(request.id, request.sessionID))
  }

  const connect = async () => {
    const controller = new AbortController()
    attempt = controller
    activeAt = Date.now()
    let ready = false
    // Leaving the loop by a throw (a seed that was aborted) leaves the connection open unless it is aborted here, and
    // once `attempt` moves on nothing else could.
    try {
      for await (const event of input.source.events(controller.signal)) {
        activeAt = Date.now()
        if (event.payload.type === "server.connected") {
          await seed(controller.signal)
          ready = true
          live = controller.signal
          seeded += 1
        }
        handle(event)
        if (ready) heardAt = Date.now()
        apply()
      }
    } finally {
      if (live === controller.signal) live = undefined
      controller.abort()
    }
  }

  const run = async () => {
    let failures = 0
    while (!stopped) {
      const before = seeded
      await connect().catch((error: unknown) => {
        if (stopped || failures > 0) return
        input.log?.("keep awake: engine event stream failed", { error: String(error) })
      })
      attempt = undefined
      failures = seeded > before ? 0 : failures + 1
      apply()
      if (stopped) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs * 2 ** failures, RETRY_MAX_MS)).unref())
    }
  }

  const watchdog = setInterval(
    () => {
      // A connection that stays open but says nothing, not even a heartbeat, is as good as dropped.
      if (attempt && Date.now() - activeAt > silenceMs) attempt.abort()
      apply()
    },
    Math.min(silenceMs / 4, stalledMs / 4, WATCHDOG_MAX_MS),
  )
  watchdog.unref()
  // Only a read of the drains says one ended.
  const poller = setInterval(() => {
    if (drains.size > 0) poll()
  }, pollMs)
  poller.unref()
  void run()

  return {
    /** Decides again now, after `watching` changed. */
    refresh() {
      apply()
    },
    stop() {
      stopped = true
      clearInterval(watchdog)
      clearInterval(poller)
      clearTimeout(deferred)
      attempt?.abort()
      apply()
    },
  }
}

/*
 * Work the desktop runs itself never reaches the engine's stream: an external agent's CLI (Codex, Claude Code, Cursor)
 * and a workspace's checks run in this process, with the engine idle. Each piece of that work holds a blocker of its
 * own for as long as it runs. None of it waits on the user, and an external agent's run has its own time limit.
 */
const desktopWork = new Set<symbol>()
let desktopBlocker: PowerBlocker | undefined
let desktopHeld: number | undefined

/** The blocker desktop work holds; undefined releases what is held and holds nothing until one is set again. */
export function setDesktopWorkBlocker(blocker: PowerBlocker | undefined) {
  if (desktopHeld !== undefined) desktopBlocker?.stop(desktopHeld)
  desktopHeld = undefined
  desktopBlocker = blocker
  syncDesktopWork()
}

/** Keeps the computer awake while `work` runs, however it ends. */
export function whileDesktopWorks<T>(work: () => Promise<T>) {
  const token = Symbol()
  desktopWork.add(token)
  syncDesktopWork()
  return Promise.resolve()
    .then(work)
    .finally(() => {
      desktopWork.delete(token)
      syncDesktopWork()
    })
}

function syncDesktopWork() {
  if (desktopWork.size > 0 && desktopHeld === undefined && desktopBlocker) desktopHeld = desktopBlocker.start()
  if (desktopWork.size > 0 || desktopHeld === undefined) return
  desktopBlocker?.stop(desktopHeld)
  desktopHeld = undefined
}

/** The local engine's event stream, session statuses and prompts, over its authenticated loopback HTTP server. */
export function engineEventSource(connection: { url: string; username: string; password: string }): KeepAwakeSource {
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`
  // The V2 routes place a request by its session, or need no place at all, so they take no location.
  const read = async (path: string, signal: AbortSignal, location?: KeepAwakeLocation) => {
    const url = new URL(path, connection.url)
    if (location) url.searchParams.set("directory", location.directory)
    if (location?.workspace) url.searchParams.set("workspace", location.workspace)
    const response = await fetch(url, { headers: { authorization }, signal })
    const body = await response.text()
    if (!response.ok) throw new Error(`The engine's ${path} route answered ${response.status}.`)
    return body
  }
  return {
    async *events(signal) {
      // However this generator ends, a consumer that stopped reading included (return() runs only this finally), the
      // connection must close, or the engine keeps queueing every event for it. Aborting the request is what closes it
      // everywhere: cancelling the body leaves the socket open under Bun.
      const done = new AbortController()
      try {
        const response = await fetch(new URL("/global/event", connection.url), {
          headers: { authorization, accept: "text/event-stream" },
          signal: AbortSignal.any([signal, done.signal]),
        })
        if (!response.ok || !response.body) throw new Error(`The engine's event stream answered ${response.status}.`)
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ""
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) return
          const blocks = (buffer + chunk.value).split("\n\n")
          buffer = blocks.pop() ?? ""
          yield* blocks.flatMap((block) => {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5))
              .join("\n")
            return Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(KeepAwakeEvent))(data))
          })
        }
      } finally {
        done.abort()
      }
    },
    statuses: async (location, signal) =>
      Schema.decodeUnknownPromise(Schema.fromJsonString(Statuses))(await read("/session/status", signal, location)),
    requests: async (location, signal) =>
      (
        await Promise.all(
          ["/permission", "/question"].map(async (path) =>
            Schema.decodeUnknownPromise(Schema.fromJsonString(Requests))(await read(path, signal, location)),
          ),
        )
      ).flat(),
    drains: async (signal) =>
      Object.keys(
        (await Schema.decodeUnknownPromise(Schema.fromJsonString(Drains))(await read("/api/session/active", signal)))
          .data,
      ),
    prompts: async (sessionID, signal) =>
      (
        await Promise.all(
          ["permission", "question"].map(
            async (kind) =>
              (
                await Schema.decodeUnknownPromise(Schema.fromJsonString(SessionRequests))(
                  await read(`/api/session/${encodeURIComponent(sessionID)}/${kind}`, signal),
                )
              ).data,
          ),
        )
      ).flat(),
  }
}

function locationKey(location: KeepAwakeLocation) {
  return `${location.workspace ?? ""}\n${location.directory}`
}
