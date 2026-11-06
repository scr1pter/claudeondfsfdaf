import { expect, test } from "bun:test"
import { harness, request } from "./support"

test("existing ticket and draft workflow persists across an app restart", async () => {
  const app = await harness()
  try {
    const catalog = await request(app.origin, "/api/tickets")
    expect(catalog.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["t-101", "t-102", "t-103"])
    const { message: draft } = await request(app.origin, "/api/tickets/t-101/messages", "POST", { body: "Synthetic saved draft" }, 201)
    expect(draft.status).toBe("draft")
    await request(app.origin, "/api/messages/" + draft.id, "PATCH", { body: "Edited synthetic draft" })
    await app.restart()
    const { message: restored } = await request(app.origin, "/api/messages/" + draft.id)
    expect(restored.body).toBe("Edited synthetic draft")
    expect(restored.status).toBe("draft")
    const health = await request(app.origin, "/api/health")
    expect((await request(health.providerOrigin, "/control/state")).attempts).toEqual([])
  } finally { await app.close() }
}, 30_000)
