import { afterEach, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { createEverywhereEngine, unattendedRules } from "../../../desktop/src/main/everywhere-engine"
import { Permission } from "../../src/permission"
import { Server } from "../../src/server/server"
import { ServerAuth } from "../../src/server/auth"
import { taint } from "../../src/session/memory"
import { disposeAllInstances, tmpdir, trustWorkspace } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

// VE-08 uses the real HTTP server and the exact desktop client, with the existing local fake provider.
// The engine test preload's network guard refuses every non-loopback connection. No engine source is changed.
const it = testEffect(TestLLMServer.layer)
const MODEL = { providerID: "everywhere-fixture", modelID: "test-model" }

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function harness(providerUrl: string) {
  return Effect.acquireRelease(Effect.promise(async () => {
    const original = Object.fromEntries(["VECTOR_SERVER_USERNAME", "VECTOR_SERVER_PASSWORD", "VECTOR_DISABLE_DEFAULT_PLUGINS"].map((key) => [key, process.env[key]]))
    const password = randomBytes(24).toString("base64url")
    Object.assign(process.env, { VECTOR_SERVER_USERNAME: "vector", VECTOR_SERVER_PASSWORD: password, VECTOR_DISABLE_DEFAULT_PLUGINS: "1" })
    const provider = testProviderConfig(providerUrl).provider.lmstudio
    const tmp = await tmpdir({ git: true, trusted: true, config: {
      formatter: false, lsp: false, permission: { "*": "allow" }, model: `${MODEL.providerID}/${MODEL.modelID}`,
      provider: { [MODEL.providerID]: { ...provider, id: MODEL.providerID, models: { "test-model": {
        ...provider.models["test-model"], cost: { input: 10, output: 10 },
      } }, options: { ...provider.options, apiKey: randomBytes(24).toString("hex") } } },
    } })
    // Config.Info is normalized; test the actual supported raw shorthand before confirming this fixture's trust.
    const configFile = path.join(tmp.path, "vector.json")
    const rawConfig = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>
    await writeFile(configFile, JSON.stringify({ ...rawConfig, permission: "allow" }))
    await trustWorkspace(tmp.path)
    await writeFile(path.join(tmp.path, "README.md"), "Fixture repository, safe to read.\n")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    const authorization = ServerAuth.header({ username: "vector", password })!
    const client = createEverywhereEngine({ url: listener.url.origin, directory: tmp.path, authorization })
    const send = async (route: string, method: string, body?: unknown, guest = false) => {
      const url = new URL(route, listener.url)
      url.searchParams.set("directory", tmp.path)
      return fetch(url, { method, keepalive: false, headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(guest ? { "x-vector-guest-request": "1" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) })
    }
    const job = (): EverywhereJob => {
      const now = Date.now()
      return { v: 1, jid: createJobId(now), platform: "slack", kind: "mention", requester: { label: "Requester", self: true },
        repository: { id: 101, fullName: "fixture/project", shared: false }, task: "Reply with done.", context: [],
        limits: { maxUsd: 1, minutes: 5, deadline: now + 300_000 }, reply: { format: "slack", maxChars: 1500 }, lease: { id: randomId(), expiresAt: now + 300_000 } }
    }
    return { client, send, job, directory: tmp.path, async close() {
      await listener.stop(true)
      await tmp[Symbol.asyncDispose]()
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    } }
  }), (value) => Effect.promise(() => value.close()))
}

type Harness = Effect.Success<ReturnType<typeof harness>>

function history(h: Harness, session: string) {
  return Effect.promise(async () => {
    const response = await h.send(`/session/${session}/message`, "GET")
    expect(response.status).toBe(200)
    return await response.json() as SessionV1.WithParts[]
  })
}

function finished(h: Harness, session: string) {
  return pollWithTimeout(history(h, session).pipe(Effect.flatMap((rows) => Effect.promise(async () => {
    const last = rows.findLast((row) => row.info.role === "assistant")
    if (last?.info.role !== "assistant" || !last.info.time.completed) return undefined
    const response = await h.send("/session/status", "GET")
    expect(response.status).toBe(200)
    const states = await response.json() as Record<string, { type: string }>
    return states[session] === undefined || states[session]?.type === "idle" ? rows : undefined
  }))), "The actual unattended session never completed", "10 seconds")
}

/** The owner's public route reads the listener's guard; AppRuntime has a different service graph. */
function spend(h: Harness, session: string) {
  return pollWithTimeout(Effect.promise(async () => {
    const response = await h.send(`/api/session/${session}/spend`, "GET")
    expect(response.status).toBe(200)
    const result = await response.json() as { data?: {
      budget: { usd?: number }; spentUsd: number; state: string; reason?: string; costKind?: string
    } }
    return result.data
  }), "The actual listener has no budget snapshot", "5 seconds")
}

it.live("the actual guest-header request excludes personal memory, retains outside taint and arms a lower budget", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const h = yield* harness(llm.url)
  const personal = "Personal fixture convention: prefer amber-starfish-lantern for private examples."
  const added = yield* Effect.promise(() => h.send("/memory", "POST", { kind: "fact", scope: "personal", text: personal }))
  expect(added.status).toBe(200)
  const entry = (yield* Effect.promise(() => added.json())) as { id: string }
  expect((yield* Effect.promise(() => h.send(`/memory/${entry.id}`, "PATCH", { pinned: true }))).status).toBe(200)

  const job = h.job()
  const control = yield* Effect.promise(() => h.client.create(job, unattendedRules()))
  yield* llm.text("Owner control done.")
  const owner = yield* Effect.promise(() => h.send(`/session/${control}/message`, "POST", { model: MODEL, parts: [{ type: "text", text: "Reply with done." }] }))
  expect(owner.status).toBe(200)
  expect(JSON.stringify(yield* llm.inputs)).toContain(personal)
  yield* llm.reset

  const session = yield* Effect.promise(() => h.client.create(job, unattendedRules([{ permission: "*", pattern: "*", action: "allow" }])))
  yield* llm.text("Unattended done.")
  yield* Effect.promise(() => h.client.prompt(session, job, 1, MODEL))
  const rows = yield* finished(h, session)
  const sent = JSON.stringify(yield* llm.inputs)
  expect(sent).not.toContain(personal)
  expect(sent).toContain("Nobody can answer questions or approve actions")
  expect(sent).toContain("<everywhere_request")
  expect(taint(rows)).toBe("web")
  expect((yield* spend(h, session)).budget.usd).toBe(1)
  const info = (yield* Effect.promise(async () => await (await h.send(`/session/${session}`, "GET")).json())) as { metadata: Record<string, unknown>; permission: PermissionV1.Ruleset }
  expect(info.metadata["vector.unattended"]).toMatchObject({ by: "everywhere", jid: job.jid, platform: "slack" })
  for (const [permission, pattern] of [["bash", "echo fixture"], ["terminal_input", "other:fixture"], ["fixture_mcp_read", "*"], ["connect", "*"], ["question", "*"]] as const)
    expect(Permission.evaluate(permission, pattern, [{ permission: "*", pattern: "*", action: "allow" }], info.permission).action).toBe("deny")

  // The owner omits the guest header later: the old mark must continue excluding personal memory.
  yield* llm.reset
  yield* llm.text("Still unattended.")
  expect((yield* Effect.promise(() => h.send(`/session/${session}/message`, "POST", { model: MODEL, parts: [{ type: "text", text: "Reply with done again." }] }))).status).toBe(200)
  expect(JSON.stringify(yield* llm.inputs)).not.toContain(personal)
}), 30_000)

it.live("a real read approval is rejected through the owner route without the guest header", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const h = yield* harness(llm.url)
  const job = h.job()
  const session = yield* Effect.promise(() => h.client.create(job, unattendedRules([{ permission: "read", pattern: "*", action: "ask" }])))
  yield* llm.tool("read", { filePath: path.join(h.directory, "README.md") })
  yield* llm.text("I could not read without approval.")
  const controller = new AbortController()
  let ready!: () => void
  const subscribed = new Promise<void>((resolve) => { ready = resolve })
  let rejected!: () => void
  const asked = new Promise<void>((resolve) => { rejected = resolve })
  const watcher = (async () => {
    for await (const event of h.client.events(controller.signal, ready)) {
      if (event.type !== "permission.asked" || event.properties.sessionID !== session || typeof event.properties.id !== "string") continue
      await h.client.rejectPermission(event.properties.id)
      rejected()
    }
  })().catch(() => undefined)
  yield* Effect.addFinalizer(() => Effect.promise(async () => { controller.abort(); await watcher }))
  yield* awaitWithTimeout(Effect.promise(() => subscribed), "The actual event stream never subscribed", "5 seconds")
  yield* Effect.promise(() => h.client.prompt(session, job, 1, MODEL))
  yield* awaitWithTimeout(Effect.promise(() => asked), "The actual read never asked for permission", "10 seconds")
  const rows = yield* finished(h, session)
  expect(rows.flatMap((row) => row.parts).some((part) => part.type === "tool" && part.tool === "read" && part.state.status === "error")).toBe(true)
}), 30_000)

it.live("a tightened budget with no earlier owner budget stops actual provider continuation", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const h = yield* harness(llm.url)
  const job = h.job()
  const session = yield* Effect.promise(() => h.client.create(job, unattendedRules()))
  yield* llm.push(reply().tool("read", { filePath: path.join(h.directory, "README.md") }).usage({ input: 10_000, output: 100 }))
  yield* Effect.promise(() => h.client.prompt(session, job, 0.001, MODEL))
  yield* finished(h, session)
  const actual = (yield* llm.inputs).filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation"))
  expect(actual).toHaveLength(1)
  const actualSpend = yield* spend(h, session)
  expect(actualSpend.budget.usd).toBe(0.001)
  expect(actualSpend.spentUsd).toBeGreaterThan(0.001)
  expect(actualSpend).toMatchObject({ state: "stopped", reason: "cap", costKind: "priced" })
}), 30_000)
