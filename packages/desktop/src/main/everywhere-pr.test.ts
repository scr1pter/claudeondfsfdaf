import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import { openEverywherePr } from "./everywhere-pr"
import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"

installFetchGuard()

test("draft PRs use the fixed template and live private repository proof", async () => {
  let isPrivate = true
  let existing: { html_url: string; body: string }[] = []
  const writes: unknown[] = []
  const now = Date.now()
  const job: EverywhereJob = { v: 1, jid: createJobId(now), platform: "linear", kind: "assign", requester: { label: "Requester", self: true }, issue: { key: "ENG-123" },
    repository: { id: 101, fullName: "acme/app", shared: false }, task: "Fix retry handling", context: [],
    limits: { maxUsd: 2, minutes: 45, deadline: now + 45 * 60_000 }, reply: { format: "markdown", maxChars: 1500 }, lease: { id: randomId(), expiresAt: now + 300_000 } }
  await using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (new URL(request.url).pathname === "/repositories/101") return Response.json({ id: 101, full_name: "acme/app", private: isPrivate })
    if (request.method === "POST") { writes.push(await request.json()); return Response.json({ html_url: "https://github.com/acme/app/pull/4" }) }
    return Response.json(existing)
  } })
  const input = { access: { token: randomBytes(32).toString("hex"), source: "vector" as const, apiUrl: server.url.origin }, job,
    branch: "vector/ve-eng-123-abcdefgh", base: "main", summary: "Fixed retry handling.", held: 2 }
  expect(await openEverywherePr(input)).toBe("https://github.com/acme/app/pull/4")
  expect(writes[0]).toMatchObject({ draft: true, head: input.branch, base: "main", title: "ENG-123 Vector: Fix retry handling" })
  expect(JSON.stringify(writes[0])).toContain(`<!-- vector:job ${job.jid} -->`)
  expect(JSON.stringify(writes[0])).toContain("Fixes ENG-123")
  existing = [{ html_url: "https://github.com/acme/app/pull/4", body: `<!-- vector:job ${job.jid} -->` }]
  expect(await openEverywherePr(input)).toBe("https://github.com/acme/app/pull/4")
  expect(writes).toHaveLength(1)
  for (const html_url of ["https://github.com/acme/other/pull/4", "https://github.com/acme/app/pull/4/files", "https://github.com/acme/app/pull/4?redirect=1", "https://github.com/acme/app/pull/0", "http://github.com/acme/app/pull/4"]) {
    existing = [{ html_url, body: `<!-- vector:job ${job.jid} -->` }]
    await expect(openEverywherePr(input)).rejects.toThrow("Invalid Everywhere PR response")
  }
  isPrivate = false
  expect(await openEverywherePr(input)).toBeUndefined()
  expect(writes).toHaveLength(1)
})
