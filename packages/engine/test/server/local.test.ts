import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { ModelSlots } from "@vectordevai/core/local-mode/model-slots"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { StartupHold } from "@vectordevai/core/startup-hold"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Config } from "../../src/config/config"
import type { LocalSettings } from "../../src/config/local-settings"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { LocalServers } from "../../../core/test/fixture/local-servers/serve"

// The Local API over a real listener with an owner and an invited guest: every /local route is the owner's, a change
// that loosens Vector Local needs `confirm` and writes nothing without it, a held change applies only as the owner saw
// it, a Vector the agent started cannot loosen it, and the network log, Find servers, Check and grants work as the app
// and the terminal UI use them. Nothing leaves this computer: the guard is strict and every model server is a fake one
// on 127.0.0.1. Each test starts from Vector Local off, with no local block in the user's config.

const guard = NetworkGuard.use()

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

const GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file))

// The user's global config without a local block or providers, and Vector Local off with nothing held or logged.
afterEach(async () => {
  delete process.env[ChildEnvironment.AGENT_MARKER]
  GLOBAL_FILES.filter((file) => existsSync(file)).forEach((file) => {
    const value = parse(readFileSync(file, "utf8")) as Record<string, unknown>
    delete value.local
    delete value.provider
    writeFileSync(file, JSON.stringify(value, null, 2))
  })
  Config.refreshLocal()
  Config.confirmLocal()
  rmSync(Config.localConfirmedFile(), { force: true })
  await Egress.erase()
  await disposeAllInstances()
  // Add server reloads the listener's own instances, which then hold the provider it wrote; they read the config again
  // here, as after any settings change, so no test starts with another test's provider.
  expect((await send("POST", "/global/dispose")).status).toBe(200)
})

const at = (route: string) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", shared.path)
  return url
}
// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (route: string, init: RequestInit = {}) => fetch(at(route), { ...init, keepalive: false })
const send = (method: string, route: string, body?: unknown, headers: Record<string, string> = owner) =>
  call(route, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
// What the routes answer, as the tests read them.
type Status = LocalSettings.Status
type Refusal = {
  readonly name: string
  readonly data: {
    readonly code?: string
    readonly message: string
    readonly changes?: readonly string[]
    readonly identity?: readonly string[]
  }
}
type Read = { readonly server: LocalProbe.Server | null; readonly message?: string }
type Added = {
  readonly provider: string
  readonly models: readonly string[]
  readonly server: LocalProbe.Server
  readonly status: Status
  readonly identity?: readonly string[]
}
type Report = LocalSettings.CheckReport & {
  readonly model?: {
    readonly model: string
    readonly result: string
    readonly requests: number
    readonly message?: string
    readonly server_version?: string
  }
}
const json = async <T>(response: Response) => (await response.json()) as T
const patch = (body: unknown) => send("PATCH", "/local", body)
// An edit to the user's local block by hand, or by a program the agent ran, as the watcher would read it.
const edit = (local: Record<string, unknown>) => {
  const file = GLOBAL_FILES.find((item) => existsSync(item))!
  const value = parse(readFileSync(file, "utf8")) as { local?: Record<string, unknown> }
  writeFileSync(file, JSON.stringify({ ...value, local: { ...value.local, ...local } }, null, 2))
  Config.refreshLocal()
}
// The user's provider config, as the app's custom provider dialog writes it.
const providers = async (provider: Record<string, unknown>) => {
  const response = await fetch(new URL("/global/config", listener.url), {
    method: "PATCH",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ provider }),
    keepalive: false,
  })
  expect(response.status).toBe(200)
}
const MODELS = {
  "qwen3-coder:30b": { name: "qwen3-coder:30b", tool_call: true },
  "llama3.3:70b": { name: "llama3.3:70b", tool_call: true },
}
// The user's local block as the global config file holds it.
const written = () =>
  GLOBAL_FILES.filter((file) => existsSync(file))
    .map((file) => (parse(readFileSync(file, "utf8")) as { local?: Record<string, unknown> }).local)
    .find((block) => block !== undefined)

// Turns Vector Local on through the API, as `vector local on` or the switch does.
const turnOn = async (extra: Record<string, unknown> = {}) => {
  const response = await patch({ enabled: true, ...extra, confirm: true })
  expect(response.status).toBe(200)
  return json<Status>(response)
}

describe("the Local API", () => {
  test("every /local route is the owner's own: an invited guest gets 403 on each", async () => {
    // The guest may use this workspace (a session list answers), so each 403 below is the owner-only gate itself.
    expect((await call("/session", { headers: guest })).status).toBe(200)
    const routes: (readonly [string, string, unknown?])[] = [
      ["GET", "/local"],
      ["PATCH", "/local", { enabled: true }],
      ["GET", "/local/egress"],
      ["GET", "/local/egress/summary"],
      ["GET", "/local/egress/export"],
      ["DELETE", "/local/egress"],
      ["POST", "/local/egress/report", { events: [] }],
      ["POST", "/local/detect", {}],
      ["POST", "/local/probe", { url: "http://127.0.0.1:9" }],
      ["POST", "/local/servers", { url: "http://127.0.0.1:9" }],
      ["POST", "/local/check", {}],
      ["POST", "/local/grant", { source: "embedding-model" }],
      ["POST", "/local/startup/release"],
      ["GET", "/local/recommend"],
    ]
    for (const [method, route, body] of routes) {
      const response = await send(method, route, body, guest)
      expect([method, route, response.status]).toEqual([method, route, 403])
    }
    // The guest's PATCH changed nothing, and the owner reads every route.
    expect(Config.local().enabled).toBe(false)
    expect(written()).toBeUndefined()
    expect((await send("GET", "/local")).status).toBe(200)
  })

  test("a change that tightens applies at once; turning Vector Local off needs confirm and writes nothing without it", async () => {
    const on = await patch({ enabled: true })
    expect(on.status).toBe(200)
    expect((await json<Status>(on)).policy.enabled).toBe(true)
    expect(Config.local().enabled).toBe(true)

    const refused = await patch({ enabled: false })
    expect(refused.status).toBe(409)
    expect(await json<Refusal>(refused)).toMatchObject({
      name: "LocalConfirmError",
      data: { message: "This change would loosen Vector Local. Apply it?", changes: ["turns Vector Local off"] },
    })
    expect(Config.local().enabled).toBe(true)
    expect(written()?.enabled).toBe(true)

    const off = await patch({ enabled: false, confirm: true })
    expect(off.status).toBe(200)
    expect((await json<Status>(off)).policy.enabled).toBe(false)
    expect(Config.local().enabled).toBe(false)
    expect(written()?.enabled).toBe(false)
    expect(Config.localPending()).toBeUndefined()
  })

  test("a new model server, an allowed service or a looser Web access each need confirm; removing one does not", async () => {
    await turnOn({ web: "network" })
    const server = await patch({ endpoints: { add: ["http://127.0.0.1:11434/v1"] } })
    expect(server.status).toBe(409)
    expect((await json<Refusal>(server)).data.changes).toEqual(["adds the model server http://127.0.0.1:11434"])
    expect(Config.local().endpoints).toEqual([])

    const listed = await json<Status>(await patch({ endpoints: { add: ["http://127.0.0.1:11434/v1"] }, confirm: true }))
    expect(listed.policy.endpoints).toEqual([{ origin: "http://127.0.0.1:11434", from: "user" }])
    expect(written()?.endpoints).toEqual(["http://127.0.0.1:11434"])

    const narrow = await patch({ allow: { add: [{ source: "github", hosts: ["api.github.com"], reason: "API" }] } })
    expect(narrow.status).toBe(409)
    expect((await json<Refusal>(narrow)).data.changes).toEqual(["allows github for api.github.com"])
    const api = { allow: { add: [{ source: "github", hosts: ["api.github.com"], reason: "API" }] }, confirm: true }
    expect((await patch(api)).status).toBe(200)
    // Widening it to every host asks again, and the line names the hosts the owner is confirming.
    const allow = await patch({ allow: { add: [{ source: "github", reason: "Pull requests" }] } })
    expect(allow.status).toBe(409)
    expect((await json<Refusal>(allow)).data.changes).toEqual(["allows github for any host"])
    const allowed = await json<Status>(
      await patch({ allow: { add: [{ source: "github", reason: " Pull requests " }] }, confirm: true }),
    )
    expect(allowed.policy.allow).toEqual([
      { source: "github", reason: "Pull requests", added_at: expect.any(Number), added_by: "app" },
    ])

    const looser = await patch({ web: "ask" })
    expect(looser.status).toBe(409)
    expect((await json<Refusal>(looser)).data.changes).toEqual(["sets Web access to Ask"])

    // Each of these only tightens, so none asks.
    expect((await patch({ web: "none" })).status).toBe(200)
    expect((await patch({ allow: { remove: ["github"] } })).status).toBe(200)
    const removed = await json<Status>(await patch({ endpoints: { remove: ["http://127.0.0.1:11434"] } }))
    expect(removed.policy).toMatchObject({ enabled: true, web: "none", endpoints: [], allow: [] })
  })

  test("refuses what Vector Local never lets through, and addresses that are not a model server's", async () => {
    await turnOn()
    const cases: (readonly [unknown, string])[] = [
      [{ allow: { add: [{ source: "cloud-inference", reason: "Faster" }] } }, "keeps it off"],
      [{ allow: { add: [{ source: "no-such-source", reason: "Why not" }] } }, "no service called no-such-source"],
      [{ allow: { add: [{ source: "github", reason: "  " }] } }, "Say why you allow github"],
      [{ endpoints: { add: ["http://user:secret@127.0.0.1:8000"] } }, "no user name or password"],
      [{ endpoints: { add: ["https://api.openai.com/v1"] } }, "api.openai.com"],
      [{ web_domains: { allow: { add: ["https://docs.example.com/path"] } } }, "is not a site name"],
    ]
    for (const [body, message] of cases) {
      const response = await patch({ ...(body as object), confirm: true })
      const answer = await json<Refusal>(response)
      expect([response.status, answer.name, answer.data.code]).toEqual([400, "LocalError", "invalid"])
      expect(answer.data.message).toContain(message)
    }
    expect(Config.local()).toMatchObject({ endpoints: [], allow: [], web_domains: { allow: [] } })
  })

  test("a change held from a hand edit applies only as the owner saw it", async () => {
    await turnOn()
    // An edit to the user's config by hand, or by a program the agent ran, is held: it would turn Vector Local off.
    edit({ enabled: false })
    const status = await json<Status>(await send("GET", "/local"))
    expect(status.policy.enabled).toBe(true)
    expect(status.held?.changes).toEqual(["turns Vector Local off"])

    const unseen = await json<Refusal>(await patch({ held: ["allows github for any host"], confirm: true }))
    expect(unseen.data).toMatchObject({ code: "changed", changes: ["turns Vector Local off"] })
    expect((await patch({ held: ["turns Vector Local off"] })).status).toBe(409)
    const mixed = await json<Refusal>(await patch({ held: ["turns Vector Local off"], confirm: true, web: "none" }))
    expect(mixed.data.code).toBe("invalid")
    expect(Config.local().enabled).toBe(true)

    const applied = await json<Status>(await patch({ held: ["turns Vector Local off"], confirm: true }))
    expect(applied.policy.enabled).toBe(false)
    expect(applied.held).toBeUndefined()
    // Nothing is held now, so there is nothing to confirm.
    const nothing = await json<Refusal>(await patch({ held: ["turns Vector Local off"], confirm: true }))
    expect(nothing.data.code).toBe("changed")
  })

  test("a change config holds is never part of another: a tightening applies at once, and a confirmed change only itself", async () => {
    await turnOn({ web: "ask" })
    edit({ allow: [{ source: "github", reason: "Added by hand", added_at: 1, added_by: "app" }] })
    expect(Config.localPending()?.changes).toEqual(["allows github for any host"])
    // Web access None only tightens, so it applies without a dialog, and the edit stays held, in the file as it was.
    const tighter = await patch({ web: "none" })
    expect(tighter.status).toBe(200)
    expect((await json<Status>(tighter)).held?.changes).toEqual(["allows github for any host"])
    expect(Config.local()).toMatchObject({ web: "none", allow: [] })
    expect(written()).toMatchObject({ web: "none", allow: [{ source: "github" }] })
    // A looser Web access asks about itself alone, and confirming it leaves the held edit held.
    const looser = await json<Refusal>(await patch({ web: "network" }))
    expect(looser.data.changes).toEqual(["sets Web access to Your network only"])
    const confirmed = await json<Status>(await patch({ web: "network", confirm: true }))
    expect(confirmed.policy).toMatchObject({ web: "network", allow: [] })
    expect(confirmed.held?.changes).toEqual(["allows github for any host"])
    expect(Config.local().allow).toEqual([])
    // Only the held path, with the lines the owner saw, applies the edit.
    const applied = await json<Status>(await patch({ held: ["allows github for any host"], confirm: true }))
    expect(applied.policy.allow.map((item) => item.source)).toEqual(["github"])
  })

  test("turning Vector Local on holds the services, internet servers and sites the config lets through until the owner confirms them", async () => {
    // Nothing is held while Vector Local is off, so anything could have added these.
    expect((await patch({ allow: { add: [{ source: "github", reason: "Pull requests" }] } })).status).toBe(200)
    const added = await patch({
      endpoints: { add: ["http://127.0.0.1:11434", "https://models.example.com"] },
      web_domains: { allow: { add: ["docs.example.com"] } },
    })
    expect(added.status).toBe(200)
    const on = await json<Status>(await patch({ enabled: true }))
    expect(on.policy).toMatchObject({
      enabled: true,
      endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
      allow: [],
      web_domains: { allow: [] },
    })
    expect(on.held?.changes).toEqual([
      "adds the model server https://models.example.com",
      "allows github for any host",
      "lets web pages reach docs.example.com",
    ])
    const applied = await json<Status>(await patch({ held: [...(on.held?.changes ?? [])], confirm: true }))
    expect(applied.held).toBeUndefined()
    expect(applied.policy.allow.map((item) => item.source)).toEqual(["github"])
    expect(applied.policy.endpoints.map((item) => item.origin)).toEqual([
      "http://127.0.0.1:11434",
      "https://models.example.com",
    ])
  })

  test("a Vector the agent or its own terminal started cannot loosen Vector Local, but can tighten it", async () => {
    await turnOn()
    process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
    expect((await json<Status>(await send("GET", "/local"))).agent).toBe(true)
    const refused = await json<Refusal>(await patch({ enabled: false, confirm: true }))
    expect(refused.data).toMatchObject({ code: "agent", changes: ["turns Vector Local off"] })
    const server = await patch({ endpoints: { add: ["http://127.0.0.1:8000"] }, confirm: true })
    expect([server.status, (await json<Refusal>(server)).data.code]).toEqual([400, "agent"])
    const grant = await send("POST", "/local/grant", { source: "embedding-model" })
    expect([grant.status, (await json<Refusal>(grant)).data.code]).toEqual([400, "agent"])
    expect(Config.local()).toMatchObject({ enabled: true, endpoints: [] })
    expect((await patch({ web: "none" })).status).toBe(200)
    expect(Config.local().web).toBe("none")
  })

  test("with Vector Local off, a Vector the agent started still cannot add what would loosen it once it is on", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
      const allow = await json<Refusal>(
        await patch({ allow: { add: [{ source: "github", reason: "Pull requests" }] }, confirm: true }),
      )
      expect(allow.data).toMatchObject({ code: "agent", changes: ["allows github for any host"] })
      const server = await json<Refusal>(await patch({ endpoints: { add: ["http://10.9.9.9:8000"] }, web: "ask" }))
      expect(server.data).toMatchObject({ code: "agent", changes: ["adds the model server http://10.9.9.9:8000"] })
      // Add server neither lists the server nor adds it as a provider.
      const setup = await json<Refusal>(await send("POST", "/local/servers", { url: fake.origin, confirm: true }))
      expect(setup.data).toMatchObject({ code: "agent", changes: [`adds the model server ${fake.origin}`] })
      expect(written()).toBeUndefined()
      expect(
        GLOBAL_FILES.filter((file) => existsSync(file)).some((file) =>
          readFileSync(file, "utf8").includes(fake.origin),
        ),
      ).toBe(false)
      // Turning it on only tightens, so the marker does not stop it, and nothing the agent asked for came with it.
      expect((await patch({ enabled: true })).status).toBe(200)
      delete process.env[ChildEnvironment.AGENT_MARKER]
      expect(Config.local()).toMatchObject({ enabled: true, endpoints: [], allow: [] })
    } finally {
      await fake.close()
    }
  })

  test("a new identity pin for a server on the list, or none, needs confirm; Add server says what changed", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const pin = (await json<Read>(await send("POST", "/local/probe", { url: fake.origin }))).server!.pin
      const older = { ...pin, version: "0.11.0" }
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: older } })
      const replaced = await json<Refusal>(await patch({ pins: { [fake.origin]: pin } }))
      expect(replaced.data.changes).toEqual([`accepts a new identity for ${fake.origin}`])
      const removed = await json<Refusal>(await patch({ pins: { [fake.origin]: null } }))
      expect(removed.data.changes).toEqual([`stops checking the identity of ${fake.origin}`])
      expect(Config.local().pins?.[fake.origin]).toEqual(older)
      // Adding the server again says what changed since it was pinned, and asks the same way.
      const again = await send("POST", "/local/servers", { url: fake.origin })
      expect(again.status).toBe(409)
      expect((await json<Refusal>(again)).data).toMatchObject({
        changes: [`accepts a new identity for ${fake.origin}`],
        identity: ["version"],
      })
      process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
      const agent = await json<Refusal>(await patch({ pins: { [fake.origin]: pin }, confirm: true }))
      expect(agent.data).toMatchObject({ code: "agent", changes: [`accepts a new identity for ${fake.origin}`] })
      delete process.env[ChildEnvironment.AGENT_MARKER]
      const added = await json<Added>(await send("POST", "/local/servers", { url: fake.origin, confirm: true }))
      expect(added.identity).toEqual(["version"])
      expect(Config.local().pins?.[fake.origin]).toEqual(pin)
      // An edit that re-pins it by hand is held too, and the server keeps the identity it was let apply with.
      edit({ pins: { [fake.origin]: older } })
      expect(Config.localPending()?.changes).toEqual([`accepts a new identity for ${fake.origin}`])
      expect(Config.local().pins?.[fake.origin]).toEqual(pin)
    } finally {
      await fake.close()
    }
  })

  test("with Vector Local off, a new identity for a server on the list asks too, and turning it on keeps the one the owner let apply", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const pin = (await json<Read>(await send("POST", "/local/probe", { url: fake.origin }))).server!.pin
      const older = { ...pin, version: "0.11.0" }
      expect((await patch({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: older } })).status).toBe(200)
      expect(Config.local().enabled).toBe(false)
      const again = await send("POST", "/local/servers", { url: fake.origin })
      expect(again.status).toBe(409)
      expect((await json<Refusal>(again)).data).toMatchObject({
        changes: [`accepts a new identity for ${fake.origin}`],
        identity: ["version"],
      })
      expect(written()?.pins).toEqual({ [fake.origin]: older })
      const added = await json<Added>(await send("POST", "/local/servers", { url: fake.origin, confirm: true }))
      expect(added.identity).toEqual(["version"])
      expect(Config.local().pins?.[fake.origin]).toEqual(pin)
      // An edit that re-pins it while Vector Local is off is held as well, and stays held once it is on.
      edit({ pins: { [fake.origin]: older } })
      expect(Config.localPending()?.changes).toEqual([`accepts a new identity for ${fake.origin}`])
      expect((await patch({ enabled: true })).status).toBe(200)
      expect(Config.local()).toMatchObject({ enabled: true, pins: { [fake.origin]: pin } })
      expect(Config.localPending()?.changes).toEqual([`accepts a new identity for ${fake.origin}`])
    } finally {
      await fake.close()
    }
  })

  test("the network log: what Vector sent, its counters, an export as JSON lines or CSV, the desktop's events, and Erase", async () => {
    await turnOn({ endpoints: { add: ["http://127.0.0.1:11434"] } })
    Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    Egress.decide({ source: "local-inference", url: "http://127.0.0.1:11434/v1/chat/completions", method: "POST" })
    const desktop: LocalMode.Event = {
      id: "evt_desktop",
      time: Date.now(),
      source: "updates",
      purpose: "updates",
      class: "internet",
      origin: "https://releases.example.com",
      method: "GET",
      decision: "block",
      rule: "automatic-update",
      reason: "Vector Local turns off automatic update checks.",
      carried: { personal: 0, documents: 0, repository: 0 },
    }
    expect(await json<number>(await send("POST", "/local/egress/report", { events: [desktop] }))).toBe(1)

    const events = await json<LocalMode.Event[]>(await send("GET", "/local/egress"))
    expect(events.map((event) => [event.source, event.decision])).toEqual([
      ["model-catalog", "block"],
      ["local-inference", "allow"],
      ["updates", "block"],
    ])
    // Origins only: never a path or a query.
    expect(events.map((event) => event.origin)).toEqual([
      "https://vectordev.ai",
      "http://127.0.0.1:11434",
      "https://releases.example.com",
    ])
    const blocked = await json<LocalMode.Event[]>(await send("GET", "/local/egress?blocked=true"))
    expect(blocked.map((event) => event.source)).toEqual(["model-catalog", "updates"])

    const summary = await json<LocalMode.Summary>(await send("GET", "/local/egress/summary"))
    expect(summary).toMatchObject({
      model_calls: { "http://127.0.0.1:11434": 1 },
      blocked: { "model-catalog": 1, updates: 1 },
    })

    const lines = await send("GET", "/local/egress/export")
    expect(lines.headers.get("content-type")).toContain("application/x-ndjson")
    const exported = (await lines.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LocalMode.Event)
    expect(exported.map((event) => event.source)).toContain("local-inference")
    const csv = await send("GET", "/local/egress/export?format=csv&blocked=true")
    expect(csv.headers.get("content-type")).toContain("text/csv")
    const rows = (await csv.text()).split("\n")
    expect(rows[0]).toBe(
      "time,source,purpose,class,origin,method,bytes_out,bytes_in,decision,rule,reason,session_id,root_session_id,tool,personal,documents,repository",
    )
    expect(rows.slice(1).map((row) => row.split(",")[1])).toEqual(["model-catalog", "updates"])

    expect(await json<boolean>(await send("DELETE", "/local/egress"))).toBe(true)
    expect(await json<LocalMode.Event[]>(await send("GET", "/local/egress"))).toEqual([])
  })

  test("keeps the desktop's lines while this Vector reads Vector Local off, so none are lost to a mismatch", async () => {
    expect(Config.local().enabled).toBe(false)
    const desktop: LocalMode.Event = {
      id: "evt_desktop_mismatch",
      time: Date.now(),
      source: "release-notes",
      purpose: "release-notes",
      class: "internet",
      origin: "https://vectordev.ai",
      method: "GET",
      decision: "block",
      rule: "vector-service",
      reason: "Vector Local blocks Vector's own services unless you allow them.",
      carried: { personal: 0, documents: 0, repository: 0 },
    }
    expect(await json<number>(await send("POST", "/local/egress/report", { events: [desktop] }))).toBe(1)
    const events = await json<LocalMode.Event[]>(await send("GET", "/local/egress"))
    expect(events.map((event) => event.id)).toEqual(["evt_desktop_mismatch"])
  })

  test("under a company lock, Erase is refused: the company sets how long the network log is kept", async () => {
    const managed = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
    mkdirSync(managed, { recursive: true })
    writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { lock: true, web: "none" } }))
    const restore = useManagedPolicyFixture(managed)
    try {
      expect(Config.refreshLocal().lock).toBe(true)
      Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
      const erase = await send("DELETE", "/local/egress")
      expect([erase.status, (await json<Refusal>(erase)).data.code]).toEqual([400, "locked"])
      expect((await json<LocalMode.Event[]>(await send("GET", "/local/egress"))).length).toBe(1)
    } finally {
      rmSync(managed, { recursive: true, force: true })
      restore()
      Config.refreshLocal()
    }
  })

  test("a Vector the agent started cannot erase the network log", async () => {
    await turnOn()
    Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
    const erase = await send("DELETE", "/local/egress")
    expect([erase.status, (await json<Refusal>(erase)).data.code]).toEqual([400, "agent"])
    delete process.env[ChildEnvironment.AGENT_MARKER]
    expect((await json<LocalMode.Event[]>(await send("GET", "/local/egress"))).length).toBe(1)
  })

  test("Find servers reads this computer; reading a typed address identifies the server and its models", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const found = await json<LocalProbe.Server[]>(await send("POST", "/local/detect", { ports: [fake.port] }))
      expect(found.some((server) => server.origin === fake.origin)).toBe(true)
      const read = await json<Read>(await send("POST", "/local/probe", { url: `${fake.origin}/v1/chat/completions` }))
      expect(read.server).toMatchObject({
        kind: "ollama",
        origin: fake.origin,
        baseURL: `${fake.origin}/v1`,
        version: "0.12.6",
        class: "this-computer",
        pin: { kind: "ollama", version: "0.12.6" },
      })
      expect(read.server?.models.map((model) => model.id)).toContain("qwen3-coder:30b")
      const nothing = await json<Read>(await send("POST", "/local/probe", { url: "http://127.0.0.1:9/v1" }))
      expect(nothing).toEqual({ server: null, message: "No model server Vector knows answered at http://127.0.0.1:9." })
    } finally {
      await fake.close()
    }
  })

  test("Add server lists the server with its identity and adds its models; with Vector Local on it asks first", async () => {
    const ollama = await LocalServers.serve("ollama")
    const studio = await LocalServers.serve("lmstudio")
    try {
      const added = await json<Added>(await send("POST", "/local/servers", { url: `${ollama.origin}/v1` }))
      expect(added).toMatchObject({ provider: "ollama", server: { kind: "ollama", origin: ollama.origin } })
      // Its cloud model runs on ollama.com, and its embedding model writes no text, so neither is added.
      expect(added.models).toEqual(["gemma3:12b", "llama3.3:70b", "qwen3-coder:30b"])
      expect(added.status.policy.endpoints).toEqual([{ origin: ollama.origin, from: "user" }])
      expect(written()?.pins).toEqual({ [ollama.origin]: added.server.pin })
      const provider = GLOBAL_FILES.filter((file) => existsSync(file))
        .map((file) => (parse(readFileSync(file, "utf8")) as { provider?: Record<string, unknown> }).provider?.ollama)
        .find(Boolean)
      expect(provider).toMatchObject({
        npm: "@ai-sdk/openai-compatible",
        name: `Ollama (${new URL(ollama.origin).host})`,
        options: { baseURL: `${ollama.origin}/v1` },
        models: { "llama3.3:70b": { name: "llama3.3:70b", tool_call: true } },
      })

      await turnOn()
      const asked = await send("POST", "/local/servers", { url: studio.origin })
      const refusal = await json<Refusal>(asked)
      const policy = Config.local()
      expect(
        asked.status,
        JSON.stringify({
          body: refusal,
          studioPaths: studio.hits().slice(-12).map((hit) => hit.path.split("?")[0]!.slice(0, 128)),
          local: { enabled: policy.enabled, endpoints: policy.endpoints.slice(0, 8).map((item) => item.origin) },
        }),
      ).toBe(409)
      expect(refusal.data.changes).toEqual([`adds the model server ${studio.origin}`])
      expect(Config.local().endpoints.map((item) => item.origin)).toEqual([ollama.origin])
      const confirmed = await json<Added>(await send("POST", "/local/servers", { url: studio.origin, confirm: true }))
      // lmstudio is the catalog's own provider, so a server added by hand gets the app's name for it.
      expect(confirmed.provider).toBe("lm-studio")
      expect(Config.local().endpoints.map((item) => item.origin)).toEqual([ollama.origin, studio.origin])

      const taken = await json<Refusal>(
        await send("POST", "/local/servers", { url: studio.origin, provider: "ollama", confirm: true }),
      )
      expect(taken.data).toMatchObject({ code: "invalid", message: expect.stringContaining("unused provider name") })
      const nothing = await json<Refusal>(await send("POST", "/local/servers", { url: "http://127.0.0.1:9" }))
      expect(nothing.data.code).toBe("not-found")
    } finally {
      await ollama.close()
      await studio.close()
    }
  })

  test("GET /local says so when the repository's own config has a local block, which never applies", async () => {
    await using repository = await tmpdir({ git: true, config: { local: { enabled: false, web: "ask" } } as never })
    const url = new URL("/local", listener.url)
    url.searchParams.set("directory", repository.path)
    const status = (await (await fetch(url, { headers: owner, keepalive: false })).json()) as {
      policy: { warnings: string[] }
    }
    expect(status.policy.warnings).toContain(
      "Ignored the local block in this repository's config: only your user config and your company's policy can set Vector Local.",
    )
  })

  test("with Web access None, reading a typed internet server is refused before anything connects", async () => {
    await turnOn({ web: "none" })
    const read = await json<Read>(await send("POST", "/local/probe", { url: "https://models.example.com/v1" }))
    expect(read.server).toBeNull()
    expect(read.message).toContain("Web access is set to None")
  })

  test("with Your network only, under a company lock, or in a Vector the agent started, a typed server Vector Local would not let you list is not read", async () => {
    await turnOn({ web: "network" })
    const network = await json<Read>(await send("POST", "/local/probe", { url: "https://exfil.example.com/v1" }))
    expect(network.server).toBeNull()
    expect(network.message).toContain("Web access is set to Your network only")
    const added = await json<Refusal>(
      await send("POST", "/local/servers", { url: "https://exfil.example.com", confirm: true }),
    )
    expect(added.data).toMatchObject({ code: "not-found", message: expect.stringContaining("Your network only") })

    process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
    const agent = await json<Read>(await send("POST", "/local/probe", { url: "http://10.9.9.9:8000" }))
    expect(agent.message).toContain("cannot loosen Vector Local")
    delete process.env[ChildEnvironment.AGENT_MARKER]

    const managed = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
    mkdirSync(managed, { recursive: true })
    const restore = useManagedPolicyFixture(managed)
    try {
      // The company keeps the list, so Vector reads no server it does not list, on the internet or on your network.
      writeFileSync(path.join(managed, "vector.json"), JSON.stringify({ local: { lock: true, user_may: [] } }))
      expect(Config.refreshLocal()).toMatchObject({ lock: true, web: "ask" })
      for (const url of ["https://exfil.example.com", "http://10.9.9.9:8000"]) {
        const read = await json<Read>(await send("POST", "/local/probe", { url }))
        expect([url, read.server, read.message]).toEqual([url, null, expect.stringContaining("Set by your company")])
      }
      // It lets the user list servers on their network and the ones it names, so others on the internet stay unread.
      writeFileSync(
        path.join(managed, "vector.json"),
        JSON.stringify({ local: { lock: true, user_may: ["endpoints"], endpoint_domains: ["*.corp.example"] } }),
      )
      Config.refreshLocal()
      const elsewhere = await json<Read>(await send("POST", "/local/probe", { url: "https://exfil.example.com" }))
      expect(elsewhere.message).toContain("servers on your network or the ones it names")
    } finally {
      rmSync(managed, { recursive: true, force: true })
      restore()
      Config.refreshLocal()
    }
  })

  test("Check reads every layer, and a listed server that stops answering fails its row", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const pin = (await json<Read>(await send("POST", "/local/probe", { url: fake.origin }))).server!.pin
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: pin } })
      const report = await json<Report>(await send("POST", "/local/check", {}))
      expect(report.enabled).toBe(true)
      const layers = report.rows.map((row) => row.layer)
      expect(layers).toEqual(
        expect.arrayContaining(["switch", "guard", "unlabelled", "services", "web", "server", "log"]),
      )
      const server = report.rows.find((row) => row.layer === "server")
      // The fake Ollama lists a cloud model, which runs on ollama.com, so its row says the server passes models on.
      expect(server).toMatchObject({
        status: "warn",
        title: `Ollama 0.12.6 at ${new URL(fake.origin).host}`,
        detail: expect.stringContaining("It answers as it did when it was added. This server may pass your prompts"),
        origin: fake.origin,
      })
      expect(report.rows.find((row) => row.layer === "unlabelled")?.status).toBe("pass")
    } finally {
      await fake.close()
    }
    const after = await json<Report>(await send("POST", "/local/check", {}))
    expect(after.result).toBe("fail")
    expect(after.rows.find((row) => row.layer === "server")).toMatchObject({
      status: "fail",
      title: expect.stringContaining("Nothing answered"),
    })
  })

  test("Check with Vector Local off says so and enforces nothing", async () => {
    const report = await json<Report>(await send("POST", "/local/check"))
    expect(report).toMatchObject({
      enabled: false,
      result: "off",
      rows: [{ layer: "switch", title: "Vector Local is off" }],
    })
  })

  test("Check models runs a listed model with the role's tools and records the result in the user's config", async () => {
    const fake = await LocalServers.serve("ollama", { routes: { "POST /v1/chat/completions": LocalServers.chat() } })
    try {
      const pin = (await json<Read>(await send("POST", "/local/probe", { url: fake.origin }))).server!.pin
      await providers({
        "ollama-test": {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama (test)",
          options: { baseURL: `${fake.origin}/v1` },
          models: MODELS,
        },
        // A catalog-style provider whose models are listed at a cloud address, reached through a proxy the user hosts.
        proxied: {
          npm: "@ai-sdk/openai-compatible",
          name: "Proxied",
          api: "https://api.cloud.example/v1",
          options: { baseURL: `${fake.origin}/v1` },
          models: { "llama3.3:70b": { name: "llama3.3:70b" } },
        },
      })
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: pin } })
      const check = async (model: string, role?: LocalSettings.Role) =>
        (await json<Report>(await send("POST", "/local/check", { model, confirmed: true, ...(role ? { role } : {}) })))
          .model
      const sent = () =>
        fake
          .hits()
          .filter((hit) => hit.path === "/v1/chat/completions")
          .map((hit) => JSON.parse(hit.body) as { model: string; tools: { function: { name: string } }[] })
      // The server has this model loaded with an 8,192-token context, which the agent's prompt and tools do not fit in,
      // so the check says so before it sends anything.
      expect(await check("ollama-test/qwen3-coder:30b")).toMatchObject({
        model: "qwen3-coder:30b",
        result: "context-too-small",
        requests: 0,
        message: expect.stringContaining("Vector's agent needs about"),
      })
      expect(sent()).toEqual([])
      // This one fits: it calls a simple tool, the tool with the most nested parameters, and answers a tool result.
      const works = await check("ollama-test/llama3.3:70b")
      expect(works).toMatchObject({ model: "llama3.3:70b", result: "works", server_version: "0.12.6" })
      expect(sent().length).toBe(works?.requests ?? -1)
      // Each request carries the build agent's real tools.
      expect(sent()[0]!.tools.map((tool) => tool.function.name)).toEqual(
        expect.arrayContaining(["read", "edit", "bash"]),
      )
      expect(written()?.checked).toMatchObject({
        "ollama-test/qwen3-coder:30b": { result: "context-too-small" },
        "ollama-test/llama3.3:70b": { result: "works" },
      })
      // Vectorscope's role sends the review agent's tools, which read and never edit.
      const before = sent().length
      expect(await check("ollama-test/llama3.3:70b", "review")).toMatchObject({ result: "works" })
      const review = sent()[before]!.tools.map((tool) => tool.function.name)
      expect(review).toEqual(expect.arrayContaining(["read", "grep"]))
      expect(review).not.toContain("edit")
      // A model listed at a cloud address keeps its own limits; the check is recorded, and nothing else is written.
      expect(await check("proxied/llama3.3:70b")).toMatchObject({ result: "works" })
      const config = GLOBAL_FILES.filter((file) => existsSync(file))
        .map(
          (file) =>
            (parse(readFileSync(file, "utf8")) as { provider?: Record<string, { models: Record<string, unknown> }> })
              .provider?.proxied,
        )
        .find(Boolean)
      expect(config?.models["llama3.3:70b"]).toEqual({ name: "llama3.3:70b" })
      expect(written()?.checked).toMatchObject({ "proxied/llama3.3:70b": { result: "works" } })

      const unknown = await send("POST", "/local/check", { model: "nowhere/model" })
      expect([unknown.status, (await json<Refusal>(unknown)).data.code]).toEqual([400, "invalid"])
    } finally {
      await fake.close()
    }
  })

  test("Check models records a LiteLLM proxy as passing every prompt on, so its steps are never free local ones", async () => {
    const fake = await LocalServers.serve("openai", { routes: { "POST /v1/chat/completions": LocalServers.chat() } })
    try {
      const read = await json<Read>(await send("POST", "/local/probe", { url: fake.origin }))
      expect(read.server).toMatchObject({ kind: "openai", forwards: "litellm", class: "this-computer" })
      await providers({
        "company-proxy": {
          npm: "@ai-sdk/openai-compatible",
          name: "Company proxy",
          options: { baseURL: `${fake.origin}/v1` },
          models: { "company-coder": { name: "company-coder" } },
        },
      })
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: read.server!.pin } })
      // On this computer and on the list, so until the check says otherwise its steps count as local ones.
      expect(ModelSlots.local(`${fake.origin}/v1`, { policy: Config.local() })).toBe(true)
      const checked = (
        await json<Report>(
          await send("POST", "/local/check", { model: "company-proxy/company-coder", confirmed: true }),
        )
      ).model
      // The proxy does not say how large the model's context is, which the agent needs to know before it uses it.
      expect(checked).toMatchObject({
        result: "works",
        message: expect.stringContaining("so Vector's agent refuses it until a context is set"),
      })
      const options = GLOBAL_FILES.filter((file) => existsSync(file))
        .map(
          (file) =>
            (parse(readFileSync(file, "utf8")) as { provider?: Record<string, { options: Record<string, unknown> }> })
              .provider?.["company-proxy"]?.options,
        )
        .find(Boolean)
      expect(options).toEqual({ baseURL: `${fake.origin}/v1`, forwards: true })
      expect(
        ModelSlots.local(`${fake.origin}/v1`, { policy: Config.local(), forwards: options?.forwards === true }),
      ).toBe(false)
      expect(written()?.checked).toMatchObject({
        "company-proxy/company-coder": { result: "works", message: expect.stringContaining("limit.context") },
      })
    } finally {
      await fake.close()
    }
  })

  test("with Vector Local off too, Check models reads no cloud AI service and no unlisted server on the internet", async () => {
    await providers({
      together: {
        npm: "@ai-sdk/openai-compatible",
        name: "Together",
        options: { baseURL: "https://api.together.xyz/v1", apiKey: "test-key" },
        models: { "kimi-k2": { name: "kimi-k2" } },
      },
      remote: {
        npm: "@ai-sdk/openai-compatible",
        name: "Remote",
        options: { baseURL: "https://models.example.com/v1", apiKey: "test-key" },
        models: { "kimi-k2": { name: "kimi-k2" } },
      },
    })
    expect(Config.local().enabled).toBe(false)
    const cloud = await json<Refusal>(await send("POST", "/local/check", { model: "together/kimi-k2" }))
    expect(cloud.data).toMatchObject({ code: "invalid", message: expect.stringContaining("is a cloud AI service") })
    const remote = await json<Refusal>(await send("POST", "/local/check", { model: "remote/kimi-k2" }))
    expect(remote.data).toMatchObject({
      code: "invalid",
      message: expect.stringContaining(
        "https://models.example.com is on the internet and not on your model server list",
      ),
    })
    expect(written()?.checked).toBeUndefined()
  })

  test("a grant answers one ask, and is refused for a service Vector Local never asks about", async () => {
    await turnOn()
    const download = LocalSources.get("embedding-model")!
    const url = `https://${download.hosts[0] ?? "huggingface.co"}/model.onnx`
    expect(Egress.decide({ source: download.id, url }).decision).toBe("ask")
    expect(await json<boolean>(await send("POST", "/local/grant", { source: download.id }))).toBe(true)
    expect(Egress.decide({ source: download.id, url }).decision).toBe("allow")
    expect(Egress.decide({ source: download.id, url }).decision).toBe("ask")

    const never = await json<Refusal>(await send("POST", "/local/grant", { source: "github" }))
    expect(never.data.code).toBe("invalid")
    const missing = await json<Refusal>(await send("POST", "/local/grant", { source: "no-such-source" }))
    expect(missing.data.code).toBe("not-found")
  })

  test("a desktop first run's held startup fetches go once the owner lets them, and a guest cannot", async () => {
    StartupHold.useTestHold(true)
    try {
      const released: string[] = []
      StartupHold.onRelease(() => void released.push("released"))
      expect((await send("POST", "/local/startup/release", undefined, guest)).status).toBe(403)
      expect(StartupHold.held()).toBe(true)
      expect(await json<boolean>(await send("POST", "/local/startup/release"))).toBe(true)
      expect(StartupHold.held()).toBe(false)
      expect(released).toEqual(["released"])
      // Once is enough: a second answer holds nothing.
      expect(await json<boolean>(await send("POST", "/local/startup/release"))).toBe(false)
    } finally {
      StartupHold.useTestHold(false)
    }
  })

  test("model suggestions name dated examples with their label", async () => {
    const suggested = await json<{ label: string; hardware: { summary: string }; roles: Record<string, unknown> }>(
      await send("GET", "/local/recommend"),
    )
    expect(suggested.label).toContain("Check each model's licence")
    expect(suggested.hardware.summary).toStartWith("This computer has")
    expect(Object.keys(suggested.roles).sort()).toEqual(["agent", "judge", "research", "review", "small", "subagent"])
  })

  test("the owner's event stream hears when Vector Local changes", async () => {
    const controller = new AbortController()
    const response = await fetch(new URL("/global/event", listener.url), {
      headers: owner,
      signal: controller.signal,
      keepalive: false,
    })
    const reader = response.body!.getReader()
    const state = { text: "", acted: false }
    const deadline = Date.now() + 5_000
    try {
      while (Date.now() < deadline && !state.text.includes('"local.updated"')) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)])
        if (!chunk || chunk.done) break
        state.text += new TextDecoder().decode(chunk.value)
        if (!state.acted && state.text.includes("server.connected")) {
          state.acted = true
          expect((await patch({ enabled: true })).status).toBe(200)
        }
      }
    } finally {
      controller.abort()
    }
    const event = state.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { payload: { type: string; properties: unknown } })
      .find((item) => item.payload.type === "local.updated")
    expect(event?.payload.properties).toEqual({ enabled: true, web: "ask", lock: false, held: false })
  })

  test("nothing any route did left this computer", () => {
    expect(guard.outside()).toEqual([])
  })
})
