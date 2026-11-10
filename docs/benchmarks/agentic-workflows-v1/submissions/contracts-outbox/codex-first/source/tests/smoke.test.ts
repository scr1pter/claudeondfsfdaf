import { expect, test } from "bun:test"
import { withHarness } from "./support"

test("existing ticket and draft workflow persists across an app restart", () => withHarness(async h => {
  const catalog = await h.request("/api/tickets")
  expect(catalog.data.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["t-101", "t-102", "t-103"])
  const draft = await h.draft("Synthetic saved draft")
  expect(draft.status).toBe("draft")
  await h.request("/api/messages/" + draft.id, "PATCH", { body: "Edited synthetic draft" })
  await h.stop(); await h.start()
  const restored = await h.get(draft.id)
  expect(restored.body).toBe("Edited synthetic draft")
  expect(restored.status).toBe("draft")
  expect(restored.delivery).toBeNull()
  expect((await h.provider()).attempts).toEqual([])
}), 30_000)
