import { describe, expect, test } from "bun:test"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import type { ReviewMemorySelection } from "./review-memory"
import { reviewMemoryConnection, type ReviewMemoryConnectionSource } from "./review-memory-connected-panel"

const scope = `vrs1_${"1".repeat(64)}`
function fixture() {
  const calls: string[] = []
  const trace: string[] = []
  const events = createGlobalEmitter<{ global: { type: string } }>()
  const dispatch: { current?: { deliveries: number }; listeners: number } = { listeners: 0 }
  const proofs: (() => void)[] = []
  const config = { enabled: true, capability: true, owner: true }
  const hold: { entered?: () => void; answer?: Promise<Response> } = {}
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      calls.push(url.pathname)
      trace.push(`sdk:${url.pathname}`)
      if (url.pathname === "/global/config") return Response.json({ experimental: { vectorscope: config.enabled } })
      if (url.pathname === "/experimental/capabilities")
        return Response.json({ vectorscopeReviewMemoryControls: config.capability })
      if (hold.answer && url.searchParams.get("directory") === "/repo") {
        hold.entered?.()
        return hold.answer
      }
      if (!config.owner) return Response.json({ message: "PRIVATE_DETAIL" }, { status: 403 })
      return Response.json({ repository: "repo", scope, state: { enabled: false, generation: 0, entries: [] } })
    },
  })
  const connectionBinding = {}
  let source: ReviewMemoryConnectionSource = {
    identity: {},
    connection: connectionBinding,
    sdkConnection: connectionBinding,
    client,
    server: "fixture",
    directory: "/repo",
    enabled: true,
    capability: true,
    healthy: true,
    listen: (listener) => {
      dispatch.listeners++
      const unsubscribe = events.listen((event) => {
        // Keep the real emitter's live iteration. Bound a regression's repeated callback so it fails instead of
        // trapping the test worker in an infinite synchronous dispatch, as the original production bug did.
        if (dispatch.current && ++dispatch.current.deliveries > 4) throw new Error("Repeated live event dispatch")
        listener(event.details.type)
      })
      return () => {
        unsubscribe()
        dispatch.listeners--
      }
    },
  }
  const updates: (ReviewMemorySelection | undefined)[] = []
  const connection = reviewMemoryConnection({
    source: () => source,
    changed: (value) => {
      updates.push(value)
      if (value) for (const proof of proofs.splice(0)) proof()
    },
  })
  return {
    connection,
    calls,
    trace,
    config,
    hold,
    updates,
    source: () => source,
    patch: (value: Partial<ReviewMemoryConnectionSource>) => {
      source = { ...source, ...value }
    },
    event: (type: string) => {
      const receipt = { deliveries: 0 }
      dispatch.current = receipt
      try {
        events.emit("global", { type })
        return receipt.deliveries
      } finally {
        dispatch.current = undefined
      }
    },
    nextProof: () => new Promise<void>((resolve) => proofs.push(resolve)),
    listeners: () => dispatch.listeners,
  }
}

describe("real review-memory connection coordinator", () => {
  test("one actual live-emitter reconnect is finite, retires immediately and performs one fresh verification without rebinding", async () => {
    const f = fixture()
    await f.connection.update(f.source())
    const before = f.calls.length
    const proof = f.nextProof()
    const retired: string[] = []
    f.connection.events.listen(() => retired.push("retired"))
    expect(f.event("server.connected")).toBe(1)
    expect(retired[0]).toBe("retired")
    expect(f.updates.at(-1)).toBeUndefined()
    expect(f.calls).toHaveLength(before)
    await proof
    expect(f.calls).toHaveLength(before + 3)
    expect(f.listeners()).toBe(1)
    expect(f.updates.at(-1)?.owner).toBe("owner")
    f.connection.dispose()
    expect(f.listeners()).toBe(0)
  })

  test("a queued reconnect verification cannot run after disposal or a newer blocked source epoch", async () => {
    for (const mode of ["dispose", "source"] as const) {
      const f = fixture()
      await f.connection.update(f.source())
      const before = f.calls.length
      expect(f.event("global.disposed")).toBe(1)
      if (mode === "dispose") f.connection.dispose()
      if (mode === "source") {
        f.patch({ healthy: false })
        await f.connection.update(f.source())
      }
      await Promise.resolve()
      expect(f.calls).toHaveLength(before)
      expect(f.updates.at(-1)).toBeUndefined()
      f.connection.dispose()
    }
  })

  test("missing opt-in, software capability, health or directory sends no request and never produces owner proof", async () => {
    for (const blocked of [{ enabled: false }, { capability: false }, { healthy: false }, { directory: "" }]) {
      const f = fixture()
      f.patch(blocked)
      await f.connection.update(f.source())
      expect(f.calls).toEqual([])
      expect(f.updates.every((value) => value === undefined)).toBe(true)
      f.connection.dispose()
    }
  })

  test("only fresh config, capability and strict owner inspect establish proof; identical refresh does not retire it", async () => {
    const f = fixture()
    await f.connection.update(f.source())
    expect(f.calls).toEqual(["/global/config", "/experimental/capabilities", "/experimental/review-memory"])
    const selection = f.updates.at(-1)
    if (!selection) throw new Error("Missing actual owner proof")
    expect(selection).toMatchObject({ owner: "owner", directory: "/repo", capability: true, connected: true })
    const count = f.updates.length
    await f.connection.update({ ...f.source() })
    expect(f.updates).toHaveLength(count)
    expect(f.calls).toHaveLength(3)
    f.config.owner = false
    await f.connection.recheck()
    expect(f.updates.at(-1)).toBeUndefined()
    f.connection.dispose()
    expect(f.listeners()).toBe(0)
  })

  test("stale cached true config/capability cannot grant owner proof after fresh results say false", async () => {
    for (const field of ["enabled", "capability"] as const) {
      const f = fixture()
      f.config[field] = false
      await f.connection.update(f.source())
      expect(f.calls).not.toContain("/experimental/review-memory")
      expect(f.updates.at(-1)).toBeUndefined()
      f.connection.dispose()
    }
  })

  test("editing an opaque connection binding retires a same-SDK proof and never sends with its stale authentication", async () => {
    const f = fixture()
    await f.connection.update(f.source())
    const old = f.updates.at(-1)
    if (!old) throw new Error("Missing original owner proof")
    f.patch({ connection: {} })
    const calls = f.calls.length
    await expect(Promise.resolve().then(() => old.api.inspect({}, new AbortController().signal))).rejects.toThrow()
    await f.connection.update(f.source())
    expect(f.calls).toHaveLength(calls)
    expect(f.updates.at(-1)).toBeUndefined()
    f.connection.dispose()
  })

  test("directory changes during a held real SDK owner read abort the old proof and only the new target can win", async () => {
    const f = fixture()
    const entered = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<Response>()
    f.hold.entered = () => entered.resolve()
    f.hold.answer = answer.promise
    const first = f.connection.update(f.source())
    await entered.promise
    f.patch({ directory: "/other" })
    await f.connection.update(f.source())
    const current = f.updates.at(-1)
    expect(current?.directory).toBe("/other")
    answer.resolve(Response.json({ repository: "repo", scope, state: { enabled: false, generation: 0, entries: [] } }))
    await first
    expect(f.updates.filter((value) => value !== undefined).map((value) => value.directory)).toEqual(["/other"])
    if (!current) throw new Error("Missing current owner proof")
    f.patch({ healthy: false })
    const count = f.calls.length
    await expect(Promise.resolve().then(() => current.api.inspect({}, new AbortController().signal))).rejects.toThrow()
    expect(f.calls).toHaveLength(count)
    await f.connection.update(f.source())
    expect(f.updates.at(-1)).toBeUndefined()
    f.connection.dispose()
  })

  test("opt-in, capability and health loss before a held owner reply cannot establish proof", async () => {
    for (const field of ["enabled", "capability", "healthy"] as const) {
      const f = fixture()
      const entered = Promise.withResolvers<void>()
      const answer = Promise.withResolvers<Response>()
      f.hold.entered = () => entered.resolve()
      f.hold.answer = answer.promise
      const waiting = f.connection.update(f.source())
      await entered.promise
      f.patch({ [field]: false })
      await f.connection.update(f.source())
      answer.resolve(
        Response.json({ repository: "repo", scope, state: { enabled: false, generation: 0, entries: [] } }),
      )
      await waiting
      expect(f.updates.every((value) => value === undefined)).toBe(true)
      expect(f.calls).toHaveLength(3)
      f.connection.dispose()
    }
  })

  test("observed reconnect/disposal retires subscribers before another SDK request; unmount removes proof and listeners", async () => {
    const f = fixture()
    await f.connection.update(f.source())
    f.connection.events.listen(() => f.trace.push("retire"))
    for (const type of ["server.connected", "global.disposed", "server.instance.disposed"]) {
      const before = f.trace.length
      f.event(type)
      expect(f.trace[before]).toBe("retire")
      expect(f.updates.at(-1)).toBeUndefined()
      // Await the same production verification path deterministically, not a timer-based completion guess.
      await f.connection.recheck()
      expect(f.updates.at(-1)?.owner).toBe("owner")
    }
    f.connection.dispose()
    expect(f.updates.at(-1)).toBeUndefined()
    expect(f.listeners()).toBe(0)
    expect(f.calls.every((path) => !path.endsWith("/prepare") && !path.endsWith("/confirm"))).toBe(true)
  })
})
