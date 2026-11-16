import { afterEach, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainPrivate } from "@vectordevai/core/brain/private"
import { frameTask, UNATTENDED_KEY } from "@vectordevai/core/everywhere/frame"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import type { PermissionV1 } from "@vectordevai/schema/permission-v1"
import { createEverywhereEngine, unattendedRules } from "../../../desktop/src/main/everywhere-engine"
import { Permission } from "../../src/permission"
import { Server } from "../../src/server/server"
import { ServerAuth } from "../../src/server/auth"
import { SessionMemory, taint } from "../../src/session/memory"
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

/** A session the owner makes with the same rules and the default agent, and no `vector.unattended` mark. */
function plain(h: Harness, title: string) {
  return Effect.promise(async () => {
    const response = await h.send("/session", "POST", { title, permission: unattendedRules() })
    expect(response.status).toBe(200)
    const result = await response.json() as { id?: unknown; metadata?: Record<string, unknown> }
    if (typeof result.id !== "string" || !/^ses[A-Za-z0-9_]+$/.test(result.id)) throw new Error("Invalid owner session")
    expect(result.metadata?.[UNATTENDED_KEY]).toBeUndefined()
    return result.id
  })
}

/** The system messages of every model request, as one string. */
function system(inputs: readonly Record<string, unknown>[]) {
  return JSON.stringify(inputs.flatMap((body) => Array.isArray(body.messages)
    ? body.messages.filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "system")
    : []))
}

// R-M3's fixtures (EV-14): the owner's own entries, each checked against the real outward screen first.
const TASK = "Fix the billing retry backoff in src/billing/retry.ts so failed charges wait longer between attempts."
const SCREENED = "Keep each billing fix in its own small commit with a regression test."
const PARTICULAR = "Move the Initech billing retry to the new queue before Q3."
const RECALLED = "The billing retry backoff broke Initech checkout in March."
const ATTACHED = "Retrying a Globex invoice twice charged that customer two times."
const PERSONAL = "Personal fixture fact: the owner's badge reads cobalt-heron-quartz."
const MEMORY_FOR = "Vector's memory for src/billing/retry.ts"

/**
 * The owner's entries as Settings writes them: a screened and a particular repository decision, pinned; a particular
 * lesson left unpinned for recall; a particular lesson about src/billing/retry.ts, imported and approved (POST /memory
 * takes no paths); and a pinned personal fact. Each is read back active, pinned as asked.
 */
function memories(h: Harness) {
  return Effect.promise(async () => {
    const fixtures = [["decision", SCREENED], ["decision", PARTICULAR], ["lesson", RECALLED], ["lesson", ATTACHED]] as const
    expect(fixtures.map(([kind, text]) => BrainPrivate.screened({ kind, text }))).toEqual([true, false, false, false])
    await mkdir(path.join(h.directory, "src", "billing"), { recursive: true })
    await writeFile(path.join(h.directory, "src", "billing", "retry.ts"), "export const attempts = 3\n")
    const read = async (id: string, expected: Record<string, unknown>) => {
      const response = await h.send(`/memory/${id}`, "GET")
      expect(response.status).toBe(200)
      expect(((await response.json()) as { entry: unknown }).entry).toMatchObject({ status: "active", ...expected })
    }
    const entries = [["decision", "repository", SCREENED, true], ["decision", "repository", PARTICULAR, true],
      ["lesson", "repository", RECALLED, false], ["fact", "personal", PERSONAL, true]] as const
    for (const [kind, scope, text, pinned] of entries) {
      const added = await h.send("/memory", "POST", { kind, scope, text })
      expect(added.status).toBe(200)
      const id = ((await added.json()) as { id: string }).id
      if (pinned) expect((await h.send(`/memory/${id}`, "PATCH", { pinned: true })).status).toBe(200)
      await read(id, { kind, scope, text, pinned })
    }
    const imported = await h.send("/memory/import", "POST", { text: `## Lessons\n- ${ATTACHED} _(repository)_\n  - paths: \`src/billing/retry.ts\`\n` })
    expect(imported.status).toBe(200)
    const held = ((await imported.json()) as { entries: { id: string; text: string }[] }).entries.filter((entry) => entry.text === ATTACHED)
    expect(held).toHaveLength(1)
    expect((await h.send(`/memory/${held[0]!.id}`, "PATCH", { action: "approve" })).status).toBe(200)
    await read(held[0]!.id, { kind: "lesson", scope: "repository", text: ATTACHED, pinned: false, paths: ["src/billing/retry.ts"] })
  })
}

/** Whether a session's history holds a Tier 1 recall, and the text of what its read of the file brought. */
function heard(rows: readonly SessionV1.WithParts[]) {
  const parts = rows.flatMap((row) => row.parts)
  const recall = parts.find((part) => SessionMemory.recall(part) !== undefined)
  const read = parts.find((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed")
  return {
    recall: recall?.type === "text" ? recall.text : undefined,
    read: read?.type === "tool" && read.state.status === "completed" ? read.state.output : undefined,
  }
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
  // The same rules and agent without the `vector.unattended` mark: the mark itself makes a session outward (R-M3).
  const control = yield* plain(h, "Owner control")
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

it.live("a session without the unattended mark still hears the owner's particular entries and recall, guest-marked or not", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const h = yield* harness(llm.url)
  yield* memories(h)
  const job = { ...h.job(), task: TASK }

  // The owner's own session, the same agent and rules, prompted with the runner's framed words: the `owner` audience.
  const owner = yield* plain(h, "Owner control")
  yield* llm.tool("read", { filePath: path.join(h.directory, "src", "billing", "retry.ts") })
  yield* llm.text("Owner control done.")
  expect((yield* Effect.promise(() => h.send(`/session/${owner}/message`, "POST", { model: MODEL, parts: [{ type: "text", text: frameTask(job) }] }))).status).toBe(200)
  const ownerSystem = system(yield* llm.inputs)
  for (const text of ["<vector_memory>", SCREENED, PARTICULAR, PERSONAL]) expect(ownerSystem).toContain(text)
  const ownerHeard = heard(yield* history(h, owner))
  expect(ownerHeard.recall).toContain(RECALLED)
  expect(ownerHeard.read).toContain(MEMORY_FOR)
  expect(ownerHeard.read).toContain(ATTACHED)
  yield* llm.reset

  // A guest-marked session as the runner prompts it: no personal fact, but the guest mark alone screens nothing.
  const guest = yield* plain(h, "Guest control")
  yield* llm.text("Guest control done.")
  yield* Effect.promise(() => h.client.prompt(guest, job, 1, MODEL))
  const guestRows = yield* finished(h, guest)
  const guestInputs = yield* llm.inputs
  expect(JSON.stringify(guestInputs)).not.toContain(PERSONAL)
  for (const text of ["<vector_memory>", SCREENED, PARTICULAR]) expect(system(guestInputs)).toContain(text)
  expect(heard(guestRows).recall).toContain(RECALLED)
}), 30_000)

it.live("an unattended session hears only the screened digest, with no recall and no memory beside a file it reads", () => Effect.gen(function* () {
  const llm = yield* TestLLMServer
  const h = yield* harness(llm.url)
  yield* memories(h)
  const job = { ...h.job(), task: TASK }
  const session = yield* Effect.promise(() => h.client.create(job, unattendedRules()))
  yield* llm.tool("read", { filePath: path.join(h.directory, "src", "billing", "retry.ts") })
  yield* llm.text("Unattended done.")
  yield* Effect.promise(() => h.client.prompt(session, job, 1, MODEL))
  const unattended = heard(yield* finished(h, session))
  expect(unattended.recall).toBeUndefined()
  // The read itself ran: what is missing is the memory that would have come with it.
  expect(unattended.read).toContain("export const attempts = 3")
  expect(unattended.read).not.toContain(MEMORY_FOR)
  const inputs = yield* llm.inputs
  for (const text of ["<vector_memory>", SCREENED]) expect(system(inputs)).toContain(text)
  for (const text of [PARTICULAR, RECALLED, ATTACHED, PERSONAL]) expect(JSON.stringify(inputs)).not.toContain(text)
  const info = (yield* Effect.promise(async () => await (await h.send(`/session/${session}`, "GET")).json())) as { metadata: Record<string, unknown> }
  expect(info.metadata[UNATTENDED_KEY]).toMatchObject({ by: "everywhere", jid: job.jid })

  // The owner prompts it later without the guest header: the mark still decides the audience.
  yield* llm.reset
  yield* llm.text("Still unattended.")
  expect((yield* Effect.promise(() => h.send(`/session/${session}/message`, "POST", { model: MODEL, parts: [{ type: "text", text: TASK }] }))).status).toBe(200)
  const later = yield* llm.inputs
  expect(system(later)).toContain(SCREENED)
  for (const text of [PARTICULAR, RECALLED, ATTACHED, PERSONAL]) expect(JSON.stringify(later)).not.toContain(text)
  expect(heard(yield* history(h, session)).recall).toBeUndefined()
}), 30_000)
