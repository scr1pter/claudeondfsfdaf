import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { UNATTENDED_SHELL_KEY, UNATTENDED_SHELL_OFFLINE } from "@vectordevai/core/everywhere/frame"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { ConfigPermissionV1 } from "@vectordevai/core/v1/config/permission"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { createEverywhereEngine, localEngineOrigin, unattendedCapabilities, unattendedRules } from "./everywhere-engine"
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
  // EV-18: every unattended session carries the shell mark, so its commands run only in the offline sandbox.
  expect(created.metadata[UNATTENDED_SHELL_KEY]).toBe(UNATTENDED_SHELL_OFFLINE)
  expect(Object.keys(created.metadata).sort()).toEqual([UNATTENDED_SHELL_KEY, "vector.unattended"].sort())
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

// EV-18: the ruleset's shell, the user's own rules whatever order GET /global/config gives their keys in, and the two
// capability probes. `decide` is the engine's own reading of a ruleset: the last rule whose permission and pattern match.
const decide = (rules: readonly PermissionV1.Rule[], permission: string, pattern = "*") =>
  rules.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))?.action

const ALWAYS_DENIED = ["unsandboxed_shell", "terminal", "terminal_input", "browser_external", "task", "skill", "webfetch", "external_directory", "private_network", "computer_click", "vector_cloud_publish", "question", "mcp_fixture_read", "connect_write", "network_command", "fixture_unknown"]

test("bash is denied without the offline-v1 capability and allowed with it; unsandboxed_shell and the rest never are", () => {
  const user = [{ permission: "*", pattern: "*", action: "allow" as const }]
  for (const rules of [unattendedRules(user), unattendedRules(user, "none")]) {
    expect(decide(rules, "bash", "npm test")).toBe("deny")
    for (const permission of ALWAYS_DENIED) expect({ permission, action: decide(rules, permission) }).toEqual({ permission, action: "deny" })
  }
  const offline = unattendedRules(user, "offline-v1")
  expect(decide(offline, "bash", "npm test")).toBe("allow")
  for (const permission of ALWAYS_DENIED) expect({ permission, action: decide(offline, permission) }).toEqual({ permission, action: "deny" })
  // The only rule added for the shell is `bash` itself, after every deny.
  expect(offline.slice(unattendedRules(user).length)).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
  // The user's own shell rules follow that allow: their denies hold and their asks stay asks (the runner refuses them).
  const own = unattendedRules([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
    { permission: "bash", pattern: "git push*", action: "ask" },
  ], "offline-v1")
  expect(decide(own, "bash", "rm -rf src")).toBe("deny")
  expect(decide(own, "bash", "git push origin")).toBe("ask")
  expect(decide(own, "bash", "bun test")).toBe("allow")
  expect(decide(unattendedRules([{ permission: "bash", pattern: "*", action: "deny" }], "offline-v1"), "bash", "true")).toBe("deny")
})

test("a user deny holds whatever order the engine's answer gives the keys in, and only a key's own patterns keep theirs", () => {
  // GET /global/config re-encodes the block: the known keys come first, so a `*` written first arrives last.
  const written = { "*": "allow", edit: "deny", bash: { "*": "deny", "git status": "allow" }, zz_tool: "ask" }
  const encoded = Schema.encodeUnknownSync(ConfigPermissionV1.Info)(Schema.decodeUnknownSync(ConfigPermissionV1.Info)(written, { propertyOrder: "original" }))
  expect(Object.keys(encoded)).toEqual(["edit", "bash", "*", "zz_tool"])
  const fromConfig = (block: Record<string, unknown>) => Object.entries(block).flatMap(([permission, value]) =>
    typeof value === "string" ? [{ permission, pattern: "*", action: value as PermissionV1.Rule["action"] }]
      : Object.entries(value as Record<string, PermissionV1.Rule["action"]>).map(([pattern, action]) => ({ permission, pattern, action })))
  for (const block of [written, encoded] as Record<string, unknown>[]) {
    const rules = unattendedRules(fromConfig(block), "offline-v1")
    expect(decide(rules, "edit", "src/a.ts")).toBe("deny")
    expect(decide(rules, "bash", "git status")).toBe("allow")
    expect(decide(rules, "bash", "curl example.test")).toBe("deny")
    // A wildcard key's allow is never copied, and a tool the ruleset denies takes none of the user's rules.
    expect(decide(rules, "read", "src/a.ts")).toBe("allow")
    expect(rules.filter((rule) => rule.permission === "zz_tool")).toEqual([])
  }
  // A wildcard deny outranks an exact key's allow, wherever either was written.
  for (const user of [
    [{ permission: "*", pattern: "*", action: "deny" as const }, { permission: "bash", pattern: "*", action: "allow" as const }],
    [{ permission: "bash", pattern: "*", action: "allow" as const }, { permission: "*", pattern: "*", action: "deny" as const }],
    [{ permission: "b*", pattern: "*", action: "deny" as const }, { permission: "bash", pattern: "*", action: "allow" as const }],
  ]) {
    const rules = unattendedRules(user, "offline-v1")
    expect(decide(rules, "bash", "true")).toBe("deny")
    expect(decide(rules, "edit", "a.ts")).toBe(user.some((rule) => rule.permission === "*") ? "deny" : "allow")
  }
})

test("a wildcard key's ask is kept after the exact keys, so nothing it asks for runs unasked; its denies come last", () => {
  for (const shell of ["none", "offline-v1"] as const) {
    const rules = unattendedRules([{ permission: "*", pattern: "*", action: "ask" }], shell)
    for (const permission of ["read", "edit", "glob", "grep", "list", "lsp", "todowrite"])
      expect({ permission, action: decide(rules, permission, "src/a.ts") }).toEqual({ permission, action: "ask" })
    expect(decide(rules, "bash", "bun test")).toBe(shell === "offline-v1" ? "ask" : "deny")
    for (const permission of ALWAYS_DENIED) expect({ permission, action: decide(rules, permission) }).toEqual({ permission, action: "deny" })
  }
  // An exact allow written before or after the wildcard ask: which came last is not known, so the ask holds.
  for (const user of [
    [{ permission: "*", pattern: "*", action: "ask" as const }, { permission: "edit", pattern: "*", action: "allow" as const }],
    [{ permission: "edit", pattern: "*", action: "allow" as const }, { permission: "*", pattern: "*", action: "ask" as const }],
  ]) {
    const rules = unattendedRules(user, "offline-v1")
    expect(decide(rules, "edit", "src/a.ts")).toBe("ask")
    expect(decide(rules, "bash", "true")).toBe("ask")
  }
  // A wildcard deny outranks a wildcard ask in either order; an exact deny under a wildcard ask is asked, and refused.
  for (const user of [
    [{ permission: "b*", pattern: "*", action: "deny" as const }, { permission: "*", pattern: "*", action: "ask" as const }],
    [{ permission: "*", pattern: "*", action: "ask" as const }, { permission: "b*", pattern: "*", action: "deny" as const }],
  ]) {
    const rules = unattendedRules([...user, { permission: "edit", pattern: "*.lock", action: "deny" }], "offline-v1")
    expect(decide(rules, "bash", "true")).toBe("deny")
    expect(decide(rules, "edit", "bun.lock")).toBe("ask")
    expect(decide(rules, "edit", "src/a.ts")).toBe("ask")
  }
})

test("the capability probes count only the exact answers and send no directory or guest marker", async () => {
  const requests: { url: URL; headers: Headers; redirect?: RequestRedirect }[] = []
  const owner = `Basic ${randomBytes(32).toString("base64")}`
  const answering = (answers: Record<string, () => Response | Promise<Response>>) =>
    Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect })
      const answer = answers[url.pathname]
      if (!answer) throw new Error("No such fixture route")
      return answer()
    }, { preconnect: () => undefined }) as typeof fetch
  const probe = (answers: Record<string, () => Response | Promise<Response>>) =>
    unattendedCapabilities({ url: "http://127.0.0.1:4096", authorization: owner, fetcher: answering(answers) })
  const worktree = (answer: () => Response | Promise<Response>) => ({ "/experimental/worktree/unattended": answer })
  const shell = (answer: () => Response | Promise<Response>) => ({ "/experimental/shell/unattended": answer })

  expect(await probe({ ...worktree(() => Response.json({ policy: "unattended-v1" })), ...shell(() => Response.json({ shell: "offline-v1" })) }))
    .toEqual({ worktree: true, shell: "offline-v1" })
  expect(requests.map((request) => request.url.pathname).sort()).toEqual(["/experimental/shell/unattended", "/experimental/worktree/unattended"])
  for (const request of requests) {
    expect(request.url.search).toBe("")
    expect(request.headers.get("authorization")).toBe(owner)
    expect(request.headers.has("x-vector-guest-request")).toBe(false)
    expect(request.headers.has("x-vector-directory")).toBe(false)
    expect(request.redirect).toBe("error")
  }
  expect(await probe({ ...worktree(() => Response.json({ policy: "unattended-v1" })), ...shell(() => Response.json({ shell: "none" })) }))
    .toEqual({ worktree: true, shell: "none" })
  // Any other 200, an extra key, a 404 from an engine without the route, 401 and 403 are definite noes.
  for (const answer of [
    () => Response.json({ policy: "unattended-v2" }), () => Response.json({ policy: "unattended-v1", fallback: true }),
    () => Response.json(true), () => new Response("unattended-v1"), () => new Response("x".repeat(5000)),
    () => new Response("", { status: 404 }), () => new Response("", { status: 401 }), () => new Response("", { status: 403 }),
  ]) {
    const shellAnswer = answer().clone()
    expect(await probe({ ...worktree(answer), ...shell(() => shellAnswer) })).toEqual({ worktree: false, shell: "none" })
  }
  // A 5xx, a refused connection, a timeout, a redirect and a body that breaks off (an engine restarting) give no
  // answer at all: the caller asks again later.
  const reset = () => {
    const reads = { count: 0 }
    return new Response(new ReadableStream<Uint8Array>({ pull: (controller) => {
      reads.count += 1
      if (reads.count === 1) return controller.enqueue(new TextEncoder().encode('{"shell":'))
      controller.error(new TypeError("connection reset"))
    } }))
  }
  for (const answer of [
    () => new Response("", { status: 503 }),
    () => Promise.reject(new TypeError("connection refused")),
    () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    () => Promise.reject(new TypeError("unexpected redirect")),
    reset,
  ]) expect(await probe({ ...worktree(answer), ...shell(answer) })).toEqual({})
  expect(await probe({ ...worktree(() => Response.json({ policy: "unattended-v1" })), ...shell(() => new Response("", { status: 500 })) }))
    .toEqual({ worktree: true })
  await expect(unattendedCapabilities({ url: "http://example.com", authorization: owner, fetcher: answering({}) })).rejects.toThrow("local engine")
})

test("the probes reach the real loopback engine without a directory, and only a loopback engine is asked", async () => {
  const seen: { path: string; search: string }[] = []
  await using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const url = new URL(request.url)
    seen.push({ path: url.pathname, search: url.search })
    if (url.pathname === "/experimental/worktree/unattended") return Response.json({ policy: "unattended-v1" })
    if (url.pathname === "/experimental/shell/unattended") return Response.json({ shell: "offline-v1" })
    return new Response("", { status: 404 })
  } })
  expect(await unattendedCapabilities({ url: server.url.origin, authorization: "fixture" })).toEqual({ worktree: true, shell: "offline-v1" })
  expect(seen.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: "/experimental/shell/unattended", search: "" },
    { path: "/experimental/worktree/unattended", search: "" },
  ])
  for (const url of ["https://127.0.0.1", "http://example.com", "http://user:pass@127.0.0.1", "http://127.0.0.1?remote=1", "http://127.0.0.1#x"])
    expect(() => localEngineOrigin(url)).toThrow()
})
