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
