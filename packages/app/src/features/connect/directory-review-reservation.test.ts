import { expect, test } from "bun:test"
import type { Connect } from "@vectordevai/schema/connect"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { createConnectClient } from "./client"
import { createDirectoryReviewController } from "./directory-review-controller"
import { createDirectoryReviewReservation } from "./directory-review-reservation"
import { reviewRun } from "./test-fixture"

const key = "opaque-workspace-scope"
const body = { target: { kind: "branch" as const, base: "a".repeat(40) }, background: true }
const first = "0196aa50-50d0-4f17-9c1d-85eff018e829"
const second = "0196aa50-50d0-4f17-9c1d-85eff018e830"
const target = { workspaceID: "workspace", directory: "/workspace/fixture", base: body.target.base }
const NOW = Date.UTC(2026, 10, 22, 12)
const DAY = 24 * 60 * 60_000
const consumed = {
  code: "consumed" as const,
  message: "This review start did not complete and no review ran. Start a new review.",
}
const pending = {
  code: "pending" as const,
  message: "This review start is not confirmed yet. Retry it shortly; a retry never starts a second review.",
}

function started(): Connect.Run {
  const fixture = reviewRun()
  if (fixture.request.action !== "review") throw new Error("The fixture must be a review.")
  return {
    ...fixture,
    request: {
      ...fixture.request,
      directory: target.directory,
      requester: { kind: "user" },
      target: body.target,
      background: true,
    },
    status: "running",
    result: undefined,
  }
}

/** A fake engine behind the real SDK: each review POST takes the next answer in order. */
function engine(answers: ("lost" | "run" | { status: number; body: unknown })[]) {
  const bodies: unknown[] = []
  const state = { admitted: false }
  const client = createConnectClient(
    createVectorClient({
      baseUrl: "http://engine.test",
      directory: target.directory,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/experimental/connect/runs") return Response.json(state.admitted ? [started()] : [])
        if (path !== "/experimental/connect/review") return Response.json(started())
        bodies.push(await request.json())
        const answer = answers.shift()
        if (answer === undefined) throw new Error("The fixture expected no further review POST.")
        if (answer === "lost") throw new TypeError("The POST response was lost")
        if (answer !== "run") return Response.json(answer.body, { status: answer.status })
        state.admitted = true
        return Response.json(started())
      },
    }),
  )
  return { client, bodies }
}

function review(
  reservation: ReturnType<typeof createDirectoryReviewReservation>,
  client: ReturnType<typeof createConnectClient>,
  start = () => client.directoryReview(reservation.request()),
) {
  const events = { invalidate: (): void => undefined }
  const controller = createDirectoryReviewController({
    target,
    enabled: true,
    current: () => true,
    admission: reservation,
    changed() {},
    subscribe: (notify) => {
      events.invalidate = notify
      return () => {}
    },
    transport: {
      runs: (signal) => client.runs(undefined, signal),
      get: (id, signal) => client.get(id, undefined, signal),
      start,
      pending: async () => [],
      reply: async () => {},
      cancel: async () => {},
    },
  })
  return { controller, events }
}

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => void values.set(name, value),
    removeItem: (name: string) => void values.delete(name),
  }
  let minted = 0
  const clock = { now: NOW }
  const make = () =>
    createDirectoryReviewReservation({
      storage,
      key,
      body,
      requestKey: () => (++minted === 1 ? first : second),
      now: () => clock.now,
    })
  return { storage, make, clock, minted: () => minted }
}

test("savedAt is local metadata fixed before the first POST and never refreshed by retry or remount", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  const request = { requestKey: first, ...body }
  const raw = f.storage.getItem(key)
  expect(JSON.parse(raw!)).toEqual({ ...request, savedAt: NOW })
  expect(original.request()).toEqual(request)
  expect(original.retryWarning()).toContain("can start a new review")
  f.clock.now += DAY
  original.hold(true)
  const remounted = f.make()
  remounted.hold(true)
  expect(remounted.retryWarning()).toContain("at least 24 hours old")
  expect(remounted.request()).toEqual(request)
  expect(f.storage.getItem(key)).toBe(raw)
  expect(f.minted()).toBe(1)
})

test("legacy markers keep their exact wire request and warn of unknown replay age without migration", () => {
  const f = fixture()
  const request = { requestKey: first, ...body }
  const raw = JSON.stringify(request)
  f.storage.setItem(key, raw)
  const saved = f.make()
  expect(saved.retryWarning()).toContain("age is unknown")
  saved.hold(true)
  expect(saved.request()).toEqual(request)
  expect(f.storage.getItem(key)).toBe(raw)
  expect(f.minted()).toBe(0)
})

test("another view cannot refresh only savedAt to replace this view's captured marker", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  const replacement = JSON.stringify({ requestKey: first, ...body, savedAt: NOW + 1 })
  f.storage.setItem(key, replacement)
  expect(() => original.hold(true)).toThrow("original review request")
  expect(() => original.confirm()).toThrow("saved review request changed")
  expect(f.storage.getItem(key)).toBe(replacement)
  expect(f.minted()).toBe(1)
})

test("invalid timestamps refuse without changing storage; future time remains uncertain rather than fresh", () => {
  const f = fixture()
  for (const savedAt of ["123", null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = JSON.stringify({ requestKey: first, ...body, savedAt })
    f.storage.setItem(key, raw)
    expect(() => f.make()).toThrow("does not match this workspace")
    expect(f.storage.getItem(key)).toBe(raw)
  }
  const raw = JSON.stringify({ requestKey: first, ...body, savedAt: NOW + 1 })
  f.storage.setItem(key, raw)
  const future = f.make()
  expect(future.retryWarning()).toContain("timestamp is in the future")
  future.hold(true)
  expect(future.request()).toEqual({ requestKey: first, ...body })
  expect(f.storage.getItem(key)).toBe(raw)
  expect(f.minted()).toBe(0)
})

test("a missing local timestamp is not inferred from now and an invalid new clock saves no request", () => {
  const f = fixture()
  f.clock.now = Number.NaN
  const unsaved = f.make()
  expect(() => unsaved.hold(false)).toThrow("timestamp")
  expect(f.storage.getItem(key)).toBeNull()
})

for (const version of ["legacy", "aged"] as const)
  test(`${version} markers warn before explicit retry while the actual SDK sends the same UUID/body only`, async () => {
    const f = fixture()
    f.storage.setItem(
      key,
      JSON.stringify({ requestKey: first, ...body, ...(version === "aged" ? { savedAt: NOW - DAY } : {}) }),
    )
    const reservation = f.make()
    const e = engine([{ status: 400, body: pending }, "run"])
    const view = review(reservation, e.client)
    try {
      await view.controller.refresh()
      expect(e.bodies).toEqual([])
      expect(reservation.retryWarning()).toContain("can start a new review")
      await view.controller.start(true)
      expect(view.controller.state.admissionAnswer).toEqual(pending)
      expect(reservation.retryWarning()).toContain("can start a new review")
      await view.controller.start(true)
      expect(e.bodies).toEqual([
        { requestKey: first, ...body },
        { requestKey: first, ...body },
      ])
      expect(f.minted()).toBe(0)
      expect(reservation.pending()).toBe(false)
    } finally {
      view.controller.dispose()
    }
  })

for (const mutation of ["remove", "replace"] as const)
  test(`an uncertain actual controller refuses retry when its saved request is ${mutation}d`, async () => {
    const f = fixture()
    const reservation = f.make()
    const posts: unknown[] = []
    const controller = createDirectoryReviewController({
      target: { workspaceID: "workspace", directory: "/workspace/fixture", base: body.target.base },
      enabled: true,
      current: () => true,
      admission: reservation,
      changed() {},
      subscribe: () => () => {},
      transport: {
        runs: async () => [],
        get: async () => {
          throw new Error("No confirmed review exists")
        },
        start: async () => {
          const request = reservation.request()
          expect(JSON.parse(f.storage.getItem(key)!)).toEqual({ ...request, savedAt: NOW })
          posts.push(request)
          throw new TypeError("The successful POST response was lost")
        },
        pending: async () => [],
        reply: async () => {},
        cancel: async () => {},
      },
    })
    try {
      await controller.refresh()
      await controller.start()
      expect(posts).toEqual([{ requestKey: first, ...body }])
      expect(controller.state.admissionUncertain).toBe(true)
      if (mutation === "remove") f.storage.removeItem(key)
      else f.storage.setItem(key, JSON.stringify({ requestKey: second, ...body }))
      await controller.start(true)
      expect(posts).toHaveLength(1)
      expect(f.minted()).toBe(1)
      expect(controller.state.admissionUncertain).toBe(true)
      expect(controller.state.error).toContain("cannot be tracked safely")
    } finally {
      controller.dispose()
    }
  })

test("same-body retries and remounts retain the captured key until that exact request is confirmed", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  const request = original.request()
  original.hold(true)
  expect(original.request()).toEqual(request)
  const remounted = f.make()
  expect(remounted.pending()).toBe(true)
  remounted.hold(true)
  expect(remounted.request()).toEqual(request)
  expect(f.minted()).toBe(1)
  remounted.confirm()
  expect(() => original.hold(true)).toThrow("original review request")
  expect(original.pending()).toBe(true)
  expect(f.minted()).toBe(1)
  expect(remounted.pending()).toBe(false)
  remounted.hold(false)
  expect(remounted.request()).toEqual({ requestKey: second, ...body })
  expect(f.minted()).toBe(2)
})

test("unconfirmed markers cannot be replaced or retargeted, including after remount", () => {
  const f = fixture()
  const original = f.make()
  original.hold(false)
  f.storage.setItem(key, JSON.stringify({ requestKey: second, ...body }))
  expect(() => original.hold(true)).toThrow("original review request")
  expect(() => original.confirm()).toThrow("changed")
  expect(f.storage.getItem(key)).toBe(JSON.stringify({ requestKey: second, ...body }))
  f.storage.setItem(key, JSON.stringify({ requestKey: first, target: { kind: "staged" }, background: true }))
  expect(() => f.make()).toThrow("does not match this workspace")
  expect(f.minted()).toBe(1)
})

test("a consumed answer clears the saved key, and only a click mints and sends a new one", async () => {
  const f = fixture()
  const reservation = f.make()
  const e = engine(["lost", { status: 400, body: consumed }, "run"])
  const { controller, events } = review(reservation, e.client)
  try {
    await controller.refresh()
    await controller.start()
    await controller.start(true)
    expect(e.bodies).toEqual([
      { requestKey: first, ...body },
      { requestKey: first, ...body },
    ])
    expect(f.storage.getItem(key)).toBeNull()
    expect(reservation.pending()).toBe(false)
    expect(controller.state.admissionUncertain).toBe(false)
    expect(controller.state.admissionAnswer).toEqual(consumed)
    expect(f.minted()).toBe(1)
    events.invalidate()
    await controller.refresh()
    await controller.start(true)
    expect(e.bodies).toHaveLength(2)
    expect(f.minted()).toBe(1)
    await controller.start()
    expect(e.bodies).toEqual([
      { requestKey: first, ...body },
      { requestKey: first, ...body },
      { requestKey: second, ...body },
    ])
    expect(f.minted()).toBe(2)
    expect(f.storage.getItem(key)).toBeNull()
    expect(controller.state.admissionAnswer).toBeUndefined()
    expect(controller.state.run?.status).toBe("running")
  } finally {
    controller.dispose()
  }
})

test("a pending answer keeps the same saved key for an explicit retry that replays the bound run", async () => {
  const f = fixture()
  const reservation = f.make()
  const e = engine(["lost", { status: 400, body: pending }, "run"])
  const { controller, events } = review(reservation, e.client)
  try {
    await controller.refresh()
    await controller.start()
    const raw = f.storage.getItem(key)
    await controller.start(true)
    expect(f.storage.getItem(key)).toBe(raw)
    expect(controller.state.admissionUncertain).toBe(true)
    expect(controller.state.admissionAnswer).toEqual(pending)
    events.invalidate()
    await controller.refresh()
    await controller.start()
    expect(e.bodies).toHaveLength(2)
    await controller.start(true)
    expect(f.storage.getItem(key)).toBeNull()
    expect(e.bodies).toEqual([
      { requestKey: first, ...body },
      { requestKey: first, ...body },
      { requestKey: first, ...body },
    ])
    expect(f.minted()).toBe(1)
    expect(controller.state.admissionUncertain).toBe(false)
    expect(controller.state.admissionAnswer).toBeUndefined()
    expect(controller.state.run?.status).toBe("running")
  } finally {
    controller.dispose()
  }
})

test("a consumed answer never clears a marker another view replaced", async () => {
  const f = fixture()
  const reservation = f.make()
  const replaced = JSON.stringify({ requestKey: second, ...body })
  const e = engine(["lost", { status: 400, body: consumed }])
  const attempts = { count: 0 }
  const { controller } = review(reservation, e.client, () => {
    if (++attempts.count === 2) f.storage.setItem(key, replaced)
    return e.client.directoryReview(reservation.request())
  })
  try {
    await controller.refresh()
    await controller.start()
    await controller.start(true)
    expect(f.storage.getItem(key)).toBe(replaced)
    expect(controller.state.admissionUncertain).toBe(true)
    expect(controller.state.admissionAnswer).toEqual(consumed)
    await controller.start()
    await controller.start(true)
    expect(e.bodies).toEqual([
      { requestKey: first, ...body },
      { requestKey: first, ...body },
    ])
    expect(f.storage.getItem(key)).toBe(replaced)
    expect(controller.state.error).toContain("cannot be tracked safely")
  } finally {
    controller.dispose()
  }
})

test("discard removes only the exact captured request, and the next hold mints a new key", () => {
  const f = fixture()
  const empty = f.make()
  empty.discard()
  expect(empty.pending()).toBe(false)
  expect(f.minted()).toBe(0)
  const reservation = f.make()
  reservation.hold(false)
  reservation.discard()
  expect(f.storage.getItem(key)).toBeNull()
  expect(reservation.pending()).toBe(false)
  expect(() => reservation.request()).toThrow("not saved")
  expect(() => reservation.hold(true)).toThrow("original review request")
  reservation.hold(false)
  expect(reservation.request()).toEqual({ requestKey: second, ...body })
  expect(f.minted()).toBe(2)
  const other = JSON.stringify({ requestKey: first, ...body })
  f.storage.setItem(key, other)
  expect(() => reservation.discard()).toThrow("changed")
  expect(f.storage.getItem(key)).toBe(other)
})

test("a consumed answer after another view cleared the same key lets this view start a new review", async () => {
  const f = fixture()
  const e = engine(["lost", { status: 400, body: consumed }, { status: 400, body: consumed }, "run"])
  const original = f.make()
  const a = review(original, e.client)
  try {
    await a.controller.refresh()
    await a.controller.start()
    const remounted = f.make()
    const b = review(remounted, e.client)
    try {
      await b.controller.refresh()
      expect(b.controller.state.admissionUncertain).toBe(true)
      await Promise.all([a.controller.start(true), b.controller.start(true)])
      expect(e.bodies).toEqual([
        { requestKey: first, ...body },
        { requestKey: first, ...body },
        { requestKey: first, ...body },
      ])
      expect(f.storage.getItem(key)).toBeNull()
      for (const view of [a, b]) {
        expect(view.controller.state.admissionUncertain).toBe(false)
        expect(view.controller.state.admissionAnswer).toEqual(consumed)
      }
      expect(original.pending()).toBe(false)
      expect(remounted.pending()).toBe(false)
      expect(f.minted()).toBe(1)
      await b.controller.start()
      expect(e.bodies).toHaveLength(4)
      expect(e.bodies[3]).toEqual({ requestKey: second, ...body })
      expect(f.minted()).toBe(2)
      expect(f.storage.getItem(key)).toBeNull()
      expect(b.controller.state.run?.status).toBe("running")
    } finally {
      b.controller.dispose()
    }
  } finally {
    a.controller.dispose()
  }
})
