import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import { createEverywhereEngine, unattendedRules } from "./everywhere-engine"
import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"

installFetchGuard()

test("the real loopback client puts guest, outside and system controls only on the prompt", async () => {
  const requests: { path: string; headers: Headers; body: string }[] = []
  const owner = `Basic ${randomBytes(32).toString("base64")}`
  const now = Date.now()
  const job: EverywhereJob = { v: 1, jid: createJobId(now), platform: "slack", kind: "mention", requester: { label: "Requester", self: true },
    repository: { id: 101, fullName: "acme/app", shared: false }, task: "Fix retry handling", context: [],
    limits: { maxUsd: 50, minutes: 120, deadline: now + 120 * 60_000 }, reply: { format: "slack", maxChars: 1500 }, lease: { id: randomId(), expiresAt: now + 300_000 } }
  await using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname
    const body = await request.text()
    requests.push({ path, headers: request.headers, body })
    if (path === "/session") return Response.json({ id: "ses_everywhere" })
    if (path === "/event") return new Response('data: {"type":"server.connected","properties":{}}\r\n\r\n', { headers: { "content-type": "text/event-stream" } })
    if (path === "/memory/posting-check") return Response.json({ status: "clean", parts: JSON.parse(body).parts })
    if (path.endsWith("/message")) return Response.json([{ info: { role: "assistant" }, parts: [{ type: "text", text: "Fixed retry handling." }] }])
    return Response.json(true)
  } })
  const engine = createEverywhereEngine({ url: server.url.origin, directory: "/fixture/sandbox", authorization: owner })
  const session = await engine.create(job, unattendedRules([{ permission: "*", pattern: "*", action: "allow" }]))
  let ready = false
  for await (const _ of engine.events(new AbortController().signal, () => { ready = true })) expect(ready).toBe(true)
  await engine.prompt(session, job, 1)
  await engine.rejectPermission("per_fixture")
  await engine.rejectQuestion("que_fixture")
  await engine.posting(["summary"], [session])
  expect(await engine.summary(session)).toBe("Fixed retry handling.")
  const created = JSON.parse(requests.find((request) => request.path === "/session")!.body)
  expect(created.metadata["vector.unattended"]).toMatchObject({ by: "everywhere", jid: job.jid })
  const prompt = requests.find((request) => request.path.endsWith("/prompt_async"))!
  expect(prompt.headers.get("x-vector-guest-request")).toBe("1")
  expect(JSON.parse(prompt.body)).toMatchObject({ budget: { usd: 1, steps: 200 }, parts: [{ type: "text", metadata: { "vector.outside": "slack" } }] })
  expect(JSON.parse(prompt.body).system).toContain("Nobody can answer questions or approve actions")
  expect(requests.every((request) => request.headers.get("authorization") === owner)).toBe(true)
  expect(requests.filter((request) => !request.path.endsWith("/prompt_async")).every((request) => !request.headers.has("x-vector-guest-request"))).toBe(true)
  expect(requests.map((request) => request.body).join("\n")).not.toContain(job.lease.id)
})

test("engine endpoints cannot redirect the owner authorization to an outside host", () => {
  for (const url of ["https://127.0.0.1", "http://example.com", "http://user:pass@127.0.0.1", "http://127.0.0.1?remote=1"])
    expect(() => createEverywhereEngine({ url, directory: "/fixture", authorization: "fixture" })).toThrow()
})

function streamedEngine(chunks: readonly Uint8Array[]) {
  let reads = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const fetcher = Object.assign(async () => new Response(body), { preconnect: () => undefined }) as typeof fetch
  const engine = createEverywhereEngine({ url: "http://127.0.0.1", directory: "/fixture", authorization: "fixture", fetcher })
  return { engine, reads: () => reads, cancelled: () => cancelled }
}

test("REST response size is bounded in bytes while streaming and overflow cancels unread content", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify([{ info: { role: "assistant" }, parts: [{ type: "text", text: "€".repeat(750_000) }] }]))
  const f = streamedEngine([encoded.subarray(0, 1024 * 1024), encoded.subarray(1024 * 1024), new Uint8Array(1024 * 1024)])
  await expect(f.engine.summary("ses_fixture")).rejects.toThrow("response is too large")
  expect(f.reads()).toBe(2)
  expect(f.cancelled()).toBe(true)
})

test("one large network chunk containing many bounded events is decoded frame by frame", async () => {
  const frame = `data: ${JSON.stringify({ type: "fixture.event", properties: { text: "x".repeat(3000) } })}\r\n\r\n`
  const f = streamedEngine([new TextEncoder().encode(frame.repeat(500))])
  let count = 0
  for await (const event of f.engine.events(new AbortController().signal, () => undefined)) {
    expect(event.type).toBe("fixture.event")
    count++
  }
  expect(count).toBe(500)
})

test("a patch event larger than the old aggregate cap still allows the final idle event", async () => {
  const patch = { type: "message.part.updated", properties: { part: { sessionID: "ses_fixture", type: "tool", tool: "apply_patch", state: { input: "x".repeat(1500_000), output: "x".repeat(1500_000) } } } }
  const idle = { type: "session.status", properties: { sessionID: "ses_fixture", status: { type: "idle" } } }
  const f = streamedEngine([new TextEncoder().encode(`data: ${JSON.stringify(patch)}\n\ndata: ${JSON.stringify(idle)}\n\n`)])
  const types: string[] = []
  for await (const event of f.engine.events(new AbortController().signal, () => undefined)) types.push(event.type)
  expect(types).toEqual(["message.part.updated", "session.status"])
})

test("an oversized individual event fails closed and cancels the stream before later frames", async () => {
  const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type: "permission.asked", properties: { id: "per_fixture", payload: "x".repeat(8 * 1024 * 1024) } })}\n\n`)
  const f = streamedEngine([frame, new TextEncoder().encode('data: {"type":"session.status","properties":{}}\n\n')])
  const consume = async () => { for await (const _ of f.engine.events(new AbortController().signal, () => undefined)) throw new Error("An oversized authority event was admitted") }
  await expect(consume()).rejects.toThrow("event is too large")
  expect(f.reads()).toBe(1)
  expect(f.cancelled()).toBe(true)
})

test("event decoding preserves UTF-8 and CRLF delimiters across network chunk boundaries", async () => {
  const frame = new TextEncoder().encode('data: {"type":"fixture.event","properties":{"text":"€"}}\r\n\r\n')
  const f = streamedEngine(Array.from(frame, (value) => new Uint8Array([value])))
  const events: unknown[] = []
  for await (const event of f.engine.events(new AbortController().signal, () => undefined)) events.push(event)
  expect(events).toEqual([{ type: "fixture.event", properties: { text: "€" } }])
})
