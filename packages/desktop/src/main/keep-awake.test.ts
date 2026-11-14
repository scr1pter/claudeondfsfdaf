import { describe, expect, test } from "bun:test"

import {
  engineEventSource,
  setDesktopWorkBlocker,
  startKeepAwake,
  whileDesktopWorks,
  type KeepAwakeEvent,
  type KeepAwakeLocation,
  type KeepAwakeSource,
} from "./keep-awake"

// An engine with the global event stream and per-directory status route the desktop's keep-awake reads, and the V2
// runner's list of the sessions it drains. Every connection opens with server.connected, as the real one does.
function engine() {
  const statuses = new Map<string, Record<string, { type: string }>>()
  const requests = new Map<string, { id: string; sessionID: string }[]>()
  const drains = new Set<string>()
  const prompts = new Map<string, { id: string; sessionID: string }[]>()
  const failing = new Set<string>()
  const streams: ReturnType<typeof stream>[] = []
  const asked: KeepAwakeLocation[] = []
  const state = {
    refuse: false,
    unreadable: false,
    drainsFail: false,
    drainReads: 0,
    gate: undefined as Promise<void> | undefined,
  }
  const source: KeepAwakeSource = {
    events(signal) {
      if (state.refuse) return refused()
      const next = stream(signal)
      next.push({ payload: { type: "server.connected", properties: {} } })
      streams.push(next)
      return next.events
    },
    async statuses(location) {
      asked.push(location)
      if (state.unreadable || failing.has(location.directory)) throw new Error("status route failed")
      return statuses.get(location.directory) ?? {}
    },
    async requests(location) {
      return requests.get(location.directory) ?? []
    },
    // The list is read when the request reaches the runner; `gate` holds back the answer.
    async drains() {
      state.drainReads += 1
      const listed = [...drains]
      await state.gate
      if (state.drainsFail) throw new Error("active route failed")
      return listed
    },
    async prompts(sessionID) {
      return prompts.get(sessionID) ?? []
    },
  }
  return {
    source,
    statuses,
    requests,
    drains,
    prompts,
    failing,
    streams,
    asked,
    state,
    current: () => streams[streams.length - 1]!,
    status: (sessionID: string, type: string, directory = "/repo") =>
      ({ directory, payload: { type: "session.status", properties: { sessionID, status: { type } } } }) as const,
    event: (type: string, properties: Record<string, unknown>, directory = "/repo") =>
      ({ directory, payload: { type, properties } }) as const,
  }
}

function stream(signal: AbortSignal) {
  const queue: KeepAwakeEvent[] = []
  const state = { ended: false, wake: undefined as (() => void) | undefined }
  const notify = () => {
    state.wake?.()
    state.wake = undefined
  }
  signal.addEventListener("abort", notify)
  return {
    signal,
    push(event: KeepAwakeEvent) {
      queue.push(event)
      notify()
    },
    end() {
      state.ended = true
      notify()
    },
    events: (async function* () {
      while (true) {
        if (signal.aborted) throw new DOMException("The connection was aborted.", "AbortError")
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (state.ended) return
        await new Promise<void>((resolve) => {
          state.wake = resolve
        })
      }
    })(),
  }
}

async function* refused(): AsyncGenerator<KeepAwakeEvent> {
  throw new Error("connection refused")
}

function power() {
  const active = new Set<number>()
  const counts = { started: 0 }
  return {
    active,
    counts,
    blocker: {
      start() {
        counts.started += 1
        active.add(counts.started)
        return counts.started
      },
      stop(id: number) {
        active.delete(id)
      },
    },
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

describe("startKeepAwake", () => {
  test("holds the blocker while any session is busy or retrying and releases it once none is", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)

    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.status("ses_b", "retry", "/other"))
    fake.current().push(fake.status("ses_a", "idle"))
    await pause(20)
    expect(blocker.active.size).toBe(1)

    fake.current().push(fake.status("ses_b", "idle", "/other"))
    await until(() => blocker.active.size === 0)
    expect(blocker.counts.started).toBe(1)
    keepAwake.stop()
  })

  test("keeps holding through a short drop, then releases once the stream has been down past the limit", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, silenceMs: 300, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.refuse = true
    fake.current().end()
    await pause(100)
    expect(blocker.active.size).toBe(1)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("drops a connection that has gone silent and releases what it last said", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, silenceMs: 200, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.unreadable = true
    await until(() => fake.streams[0]!.signal.aborted)
    await until(() => fake.streams.length > 1)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("reseeds on reconnect from the status of every directory sessions ran in", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    // ses_a finished while the stream was down, so its idle event never arrived.
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)
    expect(fake.asked).toEqual([{ directory: "/repo" }])

    // ses_b started in the same directory during the next drop.
    fake.statuses.set("/repo", { ses_b: { type: "busy" }, ses_c: { type: "idle" } })
    fake.current().end()
    await until(() => fake.streams.length === 3)
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.status("ses_b", "idle"))
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a reconnect whose directory cannot report never holds the blocker on old news", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.state.unreadable = true
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a directory that cannot report is left out, and neither fails the connection nor hides the others", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "idle", "/broken"))
    fake.current().push(fake.status("ses_b", "busy", "/repo"))
    await until(() => blocker.active.size === 1)

    fake.failing.add("/broken")
    fake.statuses.set("/repo", { ses_b: { type: "busy" } })
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await pause(100)
    expect(fake.streams.length).toBe(2)
    expect(fake.streams[1]!.signal.aborted).toBe(false)
    expect(blocker.active.size).toBe(1)

    // The broken directory is asked again next time, and counts as soon as it reports a status.
    fake.current().push(fake.status("ses_a", "busy", "/broken"))
    fake.current().push(fake.status("ses_b", "idle", "/repo"))
    await pause(20)
    expect(blocker.active.size).toBe(1)
    keepAwake.stop()
  })

  test("does not count a session waiting on a permission or question prompt", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash" }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("permission.replied", { sessionID: "ses_a", requestID: "per_1", reply: "once" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_1", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("question.rejected", { sessionID: "ses_a", requestID: "que_1" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_2", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("question.replied", { sessionID: "ses_a", requestID: "que_2", answers: [] }))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("a prompt that ended without an answer does not hide the session's next run", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash" }))
    await until(() => blocker.active.size === 0)

    // Disposing the directory ends its prompts without announcing an answer.
    fake.current().push(fake.event("server.instance.disposed", { directory: "/repo" }))
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.asked", { id: "que_1", sessionID: "ses_a", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.status("ses_a", "idle"))
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("reads the prompts already waiting on the user when it reconnects", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    // The prompt was asked while the stream was down.
    fake.statuses.set("/repo", { ses_a: { type: "busy" } })
    fake.requests.set("/repo", [{ id: "per_1", sessionID: "ses_a" }])
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 0)

    // It was answered during the next drop.
    fake.requests.set("/repo", [])
    fake.current().end()
    await until(() => fake.streams.length === 3)
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("a parent waiting on a subagent's unanswered prompt is held only until nothing has moved for a while", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, stalledMs: 200 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_parent", "busy"))
    fake.current().push(fake.status("ses_child", "busy"))
    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_child", permission: "bash" }))
    await until(() => blocker.active.size === 1)

    await until(() => blocker.active.size === 0)
    // Progress anywhere, such as a background subagent writing its reply, counts again.
    fake.current().push(fake.event("message.part.updated", { sessionID: "ses_other" }))
    await until(() => blocker.active.size === 1)
    await until(() => blocker.active.size === 0)

    fake.current().push(fake.event("permission.replied", { sessionID: "ses_child", requestID: "per_1", reply: "once" }))
    await until(() => blocker.active.size === 1)
    await pause(300)
    expect(blocker.active.size).toBe(1)
    keepAwake.stop()
  })

  test("while a paired phone watches, a session waiting on a prompt holds the blocker, stalled or not", async () => {
    const fake = engine()
    const blocker = power()
    const phone = { watching: false }
    const keepAwake = startKeepAwake({
      source: fake.source,
      blocker: blocker.blocker,
      stalledMs: 100,
      watching: () => phone.watching,
    })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.event("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash" }))
    await until(() => blocker.active.size === 0)

    // A phone attaches and watches: the person can answer from it, so the computer stays awake.
    phone.watching = true
    keepAwake.refresh()
    expect(blocker.active.size).toBe(1)
    await pause(250)
    expect(blocker.active.size).toBe(1)

    // The phone leaves: the waiting session no longer counts.
    phone.watching = false
    keepAwake.refresh()
    expect(blocker.active.size).toBe(0)

    // Watching never holds the blocker with nothing busy.
    phone.watching = true
    fake.current().push(fake.status("ses_a", "idle"))
    await until(() => blocker.active.size === 0)
    await pause(50)
    expect(blocker.active.size).toBe(0)
    keepAwake.stop()
    expect(blocker.active.size).toBe(0)
  })

  test("forgets a disposed directory and does not ask it for statuses again", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    fake.current().push({
      directory: "/repo",
      payload: { type: "server.instance.disposed", properties: { directory: "/repo" } },
    })
    await until(() => blocker.active.size === 0)
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await pause(20)
    expect(fake.asked).toEqual([])
    keepAwake.stop()
  })

  // Parallel workspaces, swarm planners and swarm workers run on the engine's V2 runner. Their sessions never report a
  // session.status; only the runner's list of drains says they are working.
  test("holds the blocker while the V2 runner drains a session and releases it once the drain ends", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 20 })
    await until(() => fake.streams.length === 1)

    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }, "/swarm/worker"))
    await until(() => blocker.active.size === 1)
    // Between steps, while a tool runs, the drain says nothing at all.
    await pause(100)
    expect(blocker.active.size).toBe(1)

    fake.drains.delete("ses_worker")
    await until(() => blocker.active.size === 0)
    expect(blocker.counts.started).toBe(1)
    keepAwake.stop()
  })

  test("does not count a V2 session waiting on a permission or question prompt", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 20 })
    await until(() => fake.streams.length === 1)
    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("permission.v2.asked", { id: "per_1", sessionID: "ses_worker", action: "bash" }))
    await until(() => blocker.active.size === 0)
    fake
      .current()
      .push(fake.event("permission.v2.replied", { sessionID: "ses_worker", requestID: "per_1", reply: "once" }))
    await until(() => blocker.active.size === 1)

    fake.current().push(fake.event("question.v2.asked", { id: "que_1", sessionID: "ses_worker", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.current().push(fake.event("question.v2.rejected", { sessionID: "ses_worker", requestID: "que_1" }))
    await until(() => blocker.active.size === 1)

    // A prompt its drain ended without an answer to does not hide the session's next drain.
    fake.current().push(fake.event("question.v2.asked", { id: "que_2", sessionID: "ses_worker", questions: [] }))
    await until(() => blocker.active.size === 0)
    fake.drains.delete("ses_worker")
    const before = fake.state.drainReads
    await until(() => fake.state.drainReads > before)
    await pause(60)
    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("reseeds V2 drains and the prompts they wait on when it reconnects", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10, pollMs: 20 })
    await until(() => fake.streams.length === 1)

    // The drain started while the stream was down, so none of its events arrived.
    fake.drains.add("ses_worker")
    fake.current().end()
    await until(() => fake.streams.length === 2)
    await until(() => blocker.active.size === 1)

    // It asked for a permission during the next drop.
    fake.prompts.set("ses_worker", [{ id: "per_1", sessionID: "ses_worker" }])
    fake.current().end()
    await until(() => fake.streams.length === 3)
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a runner that cannot list its drains neither fails the connection nor holds the blocker on old news", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, retryMs: 10, pollMs: 20 })
    await until(() => fake.streams.length === 1)
    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }))
    await until(() => blocker.active.size === 1)

    fake.state.drainsFail = true
    await until(() => blocker.active.size === 0)
    fake.current().end()
    await until(() => fake.streams.length === 2)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    await pause(60)
    expect(fake.streams.length).toBe(2)
    expect(fake.streams[1]!.signal.aborted).toBe(false)
    keepAwake.stop()
  })

  test("a drain that starts while the runner is being read is counted from the read after", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 60_000 })
    // The connection's seed has read the runner and finished.
    await until(() => fake.state.drainReads === 1)
    await pause(20)
    const gate = Promise.withResolvers<void>()
    fake.state.gate = gate.promise
    fake.current().push(fake.event("session.next.prompt.admitted", { sessionID: "ses_worker" }))
    await until(() => fake.state.drainReads === 2)

    // The drain begins after that read reached the runner, and its only event arrives while the read is in flight.
    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }))
    await pause(20)
    fake.state.gate = undefined
    gate.resolve()
    await until(() => blocker.active.size === 1)
    expect(fake.state.drainReads).toBe(3)
    keepAwake.stop()
  })

  test("disposing a directory never forgets the prompt a V2 drain waits on", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 20, stalledMs: 50 })
    await until(() => fake.streams.length === 1)
    fake.drains.add("ses_worker")
    fake.current().push(fake.event("session.next.step.started", { sessionID: "ses_worker" }, "/swarm/worker"))
    await until(() => blocker.active.size === 1)
    fake.current().push(fake.event("permission.v2.asked", { id: "per_1", sessionID: "ses_worker" }, "/swarm/worker"))
    await until(() => blocker.active.size === 0)

    // Connecting a provider or changing a setting disposes every directory; the runner keeps waiting on the user.
    fake.current().push(fake.event("server.instance.disposed", { directory: "/other" }, "/other"))
    fake.current().push(fake.event("server.instance.disposed", { directory: "/swarm/worker" }, "/swarm/worker"))
    await pause(150)
    expect(blocker.active.size).toBe(0)

    fake.current().push(fake.event("permission.v2.replied", { sessionID: "ses_worker", requestID: "per_1" }))
    await until(() => blocker.active.size === 1)
    keepAwake.stop()
  })

  test("a drain whose prompts cannot be read on reconnect is counted without them, and the others keep theirs", async () => {
    const fake = engine()
    const blocker = power()
    // ses_gone ended between the read of the drains and the read of its prompts.
    const source: KeepAwakeSource = {
      ...fake.source,
      async prompts(sessionID, signal) {
        if (sessionID === "ses_gone") throw new Error("The engine's route answered 404.")
        return fake.source.prompts(sessionID, signal)
      },
    }
    fake.drains.add("ses_waiting")
    fake.drains.add("ses_gone")
    fake.prompts.set("ses_waiting", [{ id: "per_1", sessionID: "ses_waiting" }])
    const keepAwake = startKeepAwake({ source, blocker: blocker.blocker, pollMs: 20 })
    await until(() => blocker.active.size === 1)

    fake.drains.delete("ses_gone")
    await until(() => blocker.active.size === 0)
    keepAwake.stop()
  })

  test("a session the runner does not list reads the drains at most once per poll, and counts once its drain shows", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 1_000 })
    await until(() => fake.state.drainReads === 1)
    // A remote workspace's session relays its activity here but never runs on this runner.
    for (let delta = 0; delta < 20; delta++) {
      fake.current().push(fake.event("session.next.text.delta", { sessionID: "ses_remote", delta: "x" }))
      await pause(2)
    }
    await pause(50)
    expect(fake.state.drainReads).toBeLessThanOrEqual(3)
    expect(blocker.active.size).toBe(0)

    // Its drain shows on this runner after all: it is read for again once the poll interval has passed.
    fake.drains.add("ses_remote")
    fake.current().push(fake.event("session.next.text.delta", { sessionID: "ses_remote", delta: "x" }))
    await until(() => blocker.active.size === 1, 5_000)
    keepAwake.stop()
  })

  test("asks the V2 runner nothing while nothing runs on it", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker, pollMs: 10 })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)
    await pause(100)
    // Only the connection's seed asked.
    expect(fake.state.drainReads).toBe(1)
    keepAwake.stop()
  })

  test("stop releases the blocker and closes the stream", async () => {
    const fake = engine()
    const blocker = power()
    const keepAwake = startKeepAwake({ source: fake.source, blocker: blocker.blocker })
    await until(() => fake.streams.length === 1)
    fake.current().push(fake.status("ses_a", "busy"))
    await until(() => blocker.active.size === 1)

    keepAwake.stop()
    expect(blocker.active.size).toBe(0)
    expect(fake.current().signal.aborted).toBe(true)
  })
})

describe("whileDesktopWorks", () => {
  test("holds one blocker across overlapping desktop work and releases it when the last piece ends", async () => {
    const blocker = power()
    setDesktopWorkBlocker(blocker.blocker)
    const external = Promise.withResolvers<string>()
    const checks = Promise.withResolvers<void>()

    const running = whileDesktopWorks(() => external.promise)
    const validating = whileDesktopWorks(() => checks.promise)
    expect(blocker.active.size).toBe(1)
    external.resolve("done")
    expect(await running).toBe("done")
    expect(blocker.active.size).toBe(1)
    checks.reject(new Error("typecheck failed"))
    await expect(validating).rejects.toThrow("typecheck failed")
    await until(() => blocker.active.size === 0)
    expect(blocker.counts.started).toBe(1)
    setDesktopWorkBlocker(undefined)
  })

  test("work that throws before it starts still releases the blocker", async () => {
    const blocker = power()
    setDesktopWorkBlocker(blocker.blocker)
    const failed = whileDesktopWorks((): Promise<void> => {
      throw new Error("could not spawn the CLI")
    })
    expect(blocker.active.size).toBe(1)
    await expect(failed).rejects.toThrow("could not spawn the CLI")
    await until(() => blocker.active.size === 0)
    setDesktopWorkBlocker(undefined)
  })

  test("clearing the blocker releases what desktop work holds", async () => {
    const blocker = power()
    setDesktopWorkBlocker(blocker.blocker)
    const external = Promise.withResolvers<void>()
    const running = whileDesktopWorks(() => external.promise)
    expect(blocker.active.size).toBe(1)

    setDesktopWorkBlocker(undefined)
    expect(blocker.active.size).toBe(0)
    external.resolve()
    await running
    expect(blocker.counts.started).toBe(1)
  })
})

describe("engineEventSource", () => {
  test("reads the engine's authenticated event stream and status route", async () => {
    const encoder = new TextEncoder()
    const requests: { path: string; authorization: string | null; directory: string | null }[] = []
    const sse: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
    // Framed as the engine's SSE encoder frames them, and split mid-event the way a socket may deliver them.
    const send = (data: unknown) => {
      const frame = encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
      sse.controller?.enqueue(frame.slice(0, 7))
      sse.controller?.enqueue(frame.slice(7))
    }
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          directory: url.searchParams.get("directory"),
        })
        if (url.pathname === "/session/status") return Response.json({ ses_b: { type: "busy" } })
        if (url.pathname === "/api/session/active") return Response.json({ data: {} })
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sse.controller = controller
              send({ payload: { id: "evt_1", type: "server.connected", properties: {} } })
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const blocker = power()
    const keepAwake = startKeepAwake({
      source: engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" }),
      blocker: blocker.blocker,
    })

    await until(() => sse.controller !== undefined)
    send({
      directory: "/repo",
      payload: { id: "evt_2", type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
    })
    await until(() => blocker.active.size === 1)
    send({
      directory: "/repo",
      payload: { id: "evt_3", type: "session.status", properties: { sessionID: "ses_a", status: { type: "idle" } } },
    })
    await until(() => blocker.active.size === 0)
    keepAwake.stop()

    // The seed asks the V2 runner once; with nothing running on it, nothing polls it again.
    expect(requests).toEqual(
      ["/global/event", "/api/session/active"].map((path) => ({
        path,
        authorization: `Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`,
        directory: null,
      })),
    )
  })

  test("asks the V2 runner for the sessions it drains and the prompts each waits on", async () => {
    const seen: { path: string; authorization: string | null }[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        seen.push({ path: url.pathname, authorization: request.headers.get("authorization") })
        if (url.pathname === "/api/session/active") return Response.json({ data: { ses_worker: { type: "running" } } })
        if (url.pathname === "/api/session/ses_worker/permission")
          return Response.json({ data: [{ id: "per_1", sessionID: "ses_worker", action: "bash", resources: ["ls"] }] })
        if (url.pathname === "/api/session/ses_worker/question")
          return Response.json({ data: [{ id: "que_1", sessionID: "ses_worker", questions: [] }] })
        return new Response("Unexpected request", { status: 404 })
      },
    })
    const source = engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" })
    expect(await source.drains(new AbortController().signal)).toEqual(["ses_worker"])
    expect(await source.prompts("ses_worker", new AbortController().signal)).toEqual([
      { id: "per_1", sessionID: "ses_worker" },
      { id: "que_1", sessionID: "ses_worker" },
    ])
    expect(seen).toEqual(
      ["/api/session/active", "/api/session/ses_worker/permission", "/api/session/ses_worker/question"].map((path) => ({
        path,
        authorization: `Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`,
      })),
    )
  })

  test("asks each known directory for its statuses and the prompts waiting on the user", async () => {
    const seen: { path: string; directory: string | null; workspace: string | null }[] = []
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        seen.push({
          path: url.pathname,
          directory: url.searchParams.get("directory"),
          workspace: url.searchParams.get("workspace"),
        })
        if (url.pathname === "/permission")
          return Response.json([{ id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["ls"] }])
        if (url.pathname === "/question") return Response.json([{ id: "que_1", sessionID: "ses_b", questions: [] }])
        return Response.json({ ses_a: { type: "retry", attempt: 1, message: "rate limited", next: 2 } })
      },
    })
    const source = engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" })
    const location = { directory: "/repo", workspace: "wrk_1" }
    expect(await source.statuses(location, new AbortController().signal)).toEqual({ ses_a: { type: "retry" } })
    expect(await source.requests(location, new AbortController().signal)).toEqual([
      { id: "per_1", sessionID: "ses_a" },
      { id: "que_1", sessionID: "ses_b" },
    ])
    expect(seen).toEqual(
      ["/session/status", "/permission", "/question"].map((path) => ({ path, directory: "/repo", workspace: "wrk_1" })),
    )
  })

  test("closes the connection when the reader stops early", async () => {
    const state = { opened: 0, closed: 0 }
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        state.opened += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type: "x" } })}\n\n`))
            },
            cancel() {
              state.closed += 1
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const source = engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" })
    for await (const event of source.events(new AbortController().signal)) {
      expect(event.payload.type).toBe("x")
      break
    }
    await until(() => state.closed === 1)
    expect(state.opened).toBe(1)
  })

  test("a directory whose status route keeps failing leaves no connection open", async () => {
    const state = { opened: 0, closed: 0 }
    const encoder = new TextEncoder()
    const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (new URL(request.url).pathname !== "/global/event") return new Response("broken", { status: 500 })
        state.opened += 1
        const first = state.opened === 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame({ payload: { type: "server.connected", properties: {} } }))
              if (!first) return
              // The first connection teaches keep-awake a directory, then drops.
              controller.enqueue(
                frame({
                  directory: "/repo",
                  payload: { type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } },
                }),
              )
              controller.close()
            },
            cancel() {
              state.closed += 1
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const blocker = power()
    const keepAwake = startKeepAwake({
      source: engineEventSource({ url: server.url.href, username: "vector", password: "placeholder-password" }),
      blocker: blocker.blocker,
      retryMs: 10,
    })

    await until(() => state.opened === 2)
    await pause(300)
    expect(state.opened).toBe(2)
    expect(blocker.active.size).toBe(0)

    keepAwake.stop()
    await until(() => state.closed === 1)
  })
})
