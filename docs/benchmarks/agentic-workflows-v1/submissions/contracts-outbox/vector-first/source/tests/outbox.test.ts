import { expect, test } from "bun:test"
import { harness, poll, request } from "./support"

async function setup() {
  const app = await harness()
  let providerOrigin = (await request(app.origin, "/api/health")).providerOrigin as string
  return {
    app,
    api: (path: string, method = "GET", body?: unknown, status = 200) => request(app.origin, path, method, body, status),
    provider: (path: string, body?: unknown) => request(providerOrigin, path, body === undefined ? "GET" : "POST", body),
    async restart() { await app.restart(); providerOrigin = (await request(app.origin, "/api/health")).providerOrigin },
    async draft(body = "Synthetic outbox reply") { return (await request(app.origin, "/api/tickets/t-101/messages", "POST", { body }, 201)).message },
  }
}
const route = (id: string, action = "") => "/api/messages/" + id + (action ? "/" + action : "")

test("validation is stable, code-point aware, verbatim, and nonmutating", async () => {
  const s = await setup()
  try {
    const draft = await s.draft("  Synthetic\nreply  \n")
    expect(draft.body).toBe("  Synthetic\nreply  \n")
    for (const body of ["", " \n\t", "x".repeat(2001), "🙂".repeat(2001), 1, null, {}, []]) {
      const first = await s.api(route(draft.id), "PATCH", { body }, 400)
      expect(await s.api(route(draft.id), "PATCH", { body }, 400)).toEqual(first)
    }
    for (const value of [null, [], "text", 1]) await s.api(route(draft.id, "cancel"), "POST", value, 400)
    const invalid = await fetch(s.app.origin + route(draft.id, "send"), { method: "POST", body: "{" })
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get("content-type")).toContain("application/json")
    expect((await invalid.json() as any).error).toBeTruthy()
    for (const requestId of [undefined, "", " ", "x".repeat(81), "bad.id", "🙂", 5, null]) await s.api(route(draft.id, "send"), "POST", { requestId }, 400)
    expect((await s.api(route(draft.id))).message).toEqual(draft)
    expect((await s.api("/api/outbox")).items).toEqual([])
    const astral = "🙂".repeat(2000)
    expect((await s.draft(astral)).body).toBe(astral)
    await s.api("/api/messages/unknown", "GET", undefined, 404)
    await s.api("/api/tickets/unknown", "GET", undefined, 404)
    await s.api("/api/tickets/t-101/messages", "POST", { body: "  " }, 400)
    const { message: admitted } = await s.api(route(draft.id, "send"), "POST", { requestId: "verbatim" }, 202)
    await s.api(route(draft.id), "PATCH", { body: "different" }, 409)
    await s.api("/api/outbox/drain", "POST", {})
    const state = await s.provider("/control/state")
    expect(state.receipts[0].body).toBe(draft.body)
    expect((await s.api(route(draft.id))).message.delivery.idempotencyKey).toBe(admitted.delivery.idempotencyKey)
  } finally { await s.app.close() }
}, 30_000)

test("admission is durable, idempotent and never transmits; concurrent drains have one effect", async () => {
  const s = await setup()
  try {
    const draft = await s.draft()
    const admitted = await Promise.all(Array.from({ length: 8 }, () => s.api(route(draft.id, "send"), "POST", { requestId: "admit" }, 202)))
    expect(new Set(admitted.map((result) => result.message.delivery.idempotencyKey)).size).toBe(1)
    expect(admitted[0].message.status).toBe("queued")
    expect(admitted[0].message.delivery.attempts).toBe(0)
    expect((await s.provider("/control/state")).attempts).toEqual([])
    await s.api(route(draft.id, "send"), "POST", { requestId: "different" }, 409)
    const other = await s.draft()
    await s.api(route(other.id, "send"), "POST", { requestId: "admit" }, 409)
    await s.restart()
    expect((await s.api(route(draft.id))).message).toEqual(admitted[0].message)
    await Promise.all(Array.from({ length: 5 }, () => s.api("/api/outbox/drain", "POST", {})))
    const delivered = (await s.api(route(draft.id))).message
    expect(delivered.status).toBe("delivered")
    expect(delivered.delivery.attempts).toBe(1)
    expect(delivered.delivery.receiptId).toBeTruthy()
    expect((await s.api(route(draft.id, "send"), "POST", { requestId: "admit" }, 202)).message).toEqual(delivered)
    await s.api(route(draft.id, "retry"), "POST", {}, 409)
    expect((await s.api("/api/outbox")).items).toEqual([delivered])
    const state = await s.provider("/control/state")
    expect(state.receipts).toHaveLength(1)
    expect(state.attempts).toHaveLength(1)
    await s.restart()
    expect((await s.api(route(draft.id))).message).toEqual(delivered)
  } finally { await s.app.close() }
}, 30_000)

test("failed attempts retry with the same envelope and cannot be drained twice without Retry", async () => {
  const s = await setup()
  try {
    const draft = await s.draft()
    const queued = (await s.api(route(draft.id, "send"), "POST", { requestId: "retry" }, 202)).message
    await s.provider("/control/plan", { messageId: draft.id, mode: "fail_once" })
    expect((await s.api("/api/outbox/drain", "POST", {})).processed).toEqual([draft.id])
    const failed = (await s.api(route(draft.id))).message
    expect(failed.status).toBe("retryable")
    expect(failed.delivery.attempts).toBe(1)
    expect(failed.delivery.lastError).toBeTruthy()
    expect(failed.delivery.receiptId).toBeNull()
    expect((await s.api("/api/outbox/drain", "POST", {})).processed).toEqual([])
    await s.api(route(draft.id, "retry"), "POST", {})
    await s.api(route(draft.id, "retry"), "POST", {})
    await s.api("/api/outbox/drain", "POST", {})
    const delivered = (await s.api(route(draft.id))).message
    expect(delivered.status).toBe("delivered")
    expect(delivered.delivery.attempts).toBe(2)
    expect(delivered.delivery.idempotencyKey).toBe(queued.delivery.idempotencyKey)
    expect((await s.provider("/control/state")).receipts).toHaveLength(1)
    await s.api(route((await s.draft()).id, "retry"), "POST", {}, 409)
  } finally { await s.app.close() }
}, 30_000)

test("draft and queued cancellation are durable and prevent any transmission", async () => {
  const s = await setup()
  try {
    const draft = await s.draft()
    expect((await s.api(route(draft.id, "cancel"), "POST", {})).message.delivery).toBeNull()
    const queued = await s.draft()
    const admitted = (await s.api(route(queued.id, "send"), "POST", { requestId: "cancel" }, 202)).message
    const cancelled = (await s.api(route(queued.id, "cancel"), "POST", {})).message
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.delivery.cancelRequested).toBe(true)
    expect(cancelled.delivery.idempotencyKey).toBe(admitted.delivery.idempotencyKey)
    expect((await s.api(route(queued.id, "cancel"), "POST", {})).message).toEqual(cancelled)
    await s.api(route(queued.id, "retry"), "POST", {}, 409)
    await s.api("/api/outbox/drain", "POST", {})
    await s.restart()
    expect((await s.api(route(queued.id))).message).toEqual(cancelled)
    expect((await s.provider("/control/state")).attempts).toEqual([])
  } finally { await s.app.close() }
}, 30_000)

for (const [mode, response] of [["before_accept", "receipt"], ["after_accept", "receipt"], ["after_accept", "lost"]] as const) {
  test(`cancellation racing ${mode} converges truthfully with late ${response}`, async () => {
    const s = await setup()
    try {
      const draft = await s.draft()
      await s.api(route(draft.id, "send"), "POST", { requestId: mode }, 202)
      await s.provider("/control/plan", { messageId: draft.id, mode })
      const drain = s.api("/api/outbox/drain", "POST", {})
      await poll(() => s.provider("/control/state"), (state) => state.held.some((held: any) => held.messageId === draft.id))
      const cancelled = (await s.api(route(draft.id, "cancel"), "POST", {})).message
      expect(cancelled.status).toBe(mode === "before_accept" ? "cancelled" : "delivered")
      expect(cancelled.delivery.cancelRequested).toBe(true)
      if (mode === "after_accept") {
        expect(cancelled.delivery.receiptId).toBeTruthy()
        expect(cancelled.delivery.lastError).toContain("too late")
        await s.provider("/control/release", { messageId: draft.id, response })
      } else expect(cancelled.delivery.receiptId).toBeNull()
      await drain
      expect((await s.api(route(draft.id))).message).toEqual(cancelled)
      await s.api(route(draft.id, "retry"), "POST", {}, 409)
      await s.api("/api/outbox/drain", "POST", {})
      await s.restart()
      expect((await s.api(route(draft.id))).message).toEqual(cancelled)
      expect((await s.api(route(draft.id, "cancel"), "POST", {})).message).toEqual(cancelled)
      expect((await s.provider("/control/state")).receipts).toHaveLength(mode === "after_accept" ? 1 : 0)
    } finally { await s.app.close() }
  }, 30_000)
}

test("a lost acceptance response reconciles by replay, without duplicate effect", async () => {
  const s = await setup()
  try {
    const draft = await s.draft()
    const queued = (await s.api(route(draft.id, "send"), "POST", { requestId: "lost" }, 202)).message
    await s.provider("/control/plan", { messageId: draft.id, mode: "after_accept" })
    const drain = s.api("/api/outbox/drain", "POST", {})
    await poll(() => s.provider("/control/state"), (state) => state.receipts.length === 1 && state.held.length === 1)
    await s.provider("/control/release", { messageId: draft.id, response: "lost" })
    await drain
    expect((await s.api(route(draft.id))).message.status).toBe("retryable")
    await s.api(route(draft.id, "retry"), "POST", {})
    await s.api("/api/outbox/drain", "POST", {})
    const delivered = (await s.api(route(draft.id))).message
    expect(delivered.status).toBe("delivered")
    expect(delivered.delivery.idempotencyKey).toBe(queued.delivery.idempotencyKey)
    expect(delivered.delivery.attempts).toBe(2)
    expect((await s.provider("/control/state")).receipts).toHaveLength(1)
  } finally { await s.app.close() }
}, 30_000)

for (const mode of ["before_accept", "after_accept"] as const) {
  test(`hard stop during ${mode} recovers on the next explicit drain`, async () => {
    const s = await setup()
    try {
      const draft = await s.draft()
      const queued = (await s.api(route(draft.id, "send"), "POST", { requestId: "crash" }, 202)).message
      await s.provider("/control/plan", { messageId: draft.id, mode })
      const drain = fetch(s.app.origin + "/api/outbox/drain", { method: "POST", body: "{}" }).catch(() => null)
      await poll(() => s.provider("/control/state"), (state) => state.held.length === 1)
      await s.restart()
      await drain
      const recovered = (await s.api(route(draft.id))).message
      expect(["queued", "sending", "retryable"]).toContain(recovered.status)
      expect(recovered.delivery.attempts).toBe(1)
      expect(recovered.delivery.idempotencyKey).toBe(queued.delivery.idempotencyKey)
      expect((await s.provider("/control/state")).attempts).toHaveLength(1)
      await s.provider("/control/plan", { messageId: draft.id, mode: "accept" })
      await s.api("/api/outbox/drain", "POST", {})
      const delivered = (await s.api(route(draft.id))).message
      expect(delivered.status).toBe("delivered")
      expect(delivered.delivery.attempts).toBe(2)
      expect(delivered.delivery.idempotencyKey).toBe(queued.delivery.idempotencyKey)
      const state = await s.provider("/control/state")
      expect(state.receipts).toHaveLength(1)
      expect(delivered.delivery.receiptId).toBe(state.receipts[0].id)
    } finally { await s.app.close() }
  }, 30_000)
}

test("transient cancellation failure stays unresolved, survives restart, and retries cancellation rather than delivery", async () => {
  const s = await setup()
  try {
    const draft = await s.draft()
    const queued = (await s.api(route(draft.id, "send"), "POST", { requestId: "cancel-failure" }, 202)).message
    await s.provider("/control/plan", { messageId: draft.id, mode: "reject" })
    await s.api("/api/outbox/drain", "POST", {})
    await s.provider("/control/cancel-plan", { idempotencyKey: queued.delivery.idempotencyKey, mode: "fail_once" })
    const unresolved = (await s.api(route(draft.id, "cancel"), "POST", {})).message
    expect(unresolved.status).toBe("retryable")
    expect(unresolved.delivery.cancelRequested).toBe(true)
    expect(unresolved.delivery.lastError).toContain("Cancellation unresolved")
    expect((await s.provider("/control/state")).cancellations).toHaveLength(0)
    await s.restart()
    expect((await s.api(route(draft.id))).message).toEqual(unresolved)
    await s.api(route(draft.id, "retry"), "POST", {})
    await s.api("/api/outbox/drain", "POST", {})
    const cancelled = (await s.api(route(draft.id))).message
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.delivery.attempts).toBe(1)
    expect(cancelled.delivery.idempotencyKey).toBe(queued.delivery.idempotencyKey)
    expect((await s.provider("/control/state")).attempts).toHaveLength(1)
  } finally { await s.app.close() }
}, 30_000)
