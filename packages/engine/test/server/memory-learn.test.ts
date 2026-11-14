import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Flag } from "@vectordevai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Learning about you over HTTP (section 6.5): the owner's settings for what Vector may learn, export and import of
// memory, and erasing what one session taught. Every route is the owner's own; an invited guest gets 403.

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
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
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

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = owner) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", shared.path)
  return fetch(url, {
    method,
    keepalive: false,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("memory routes for learning about you", () => {
  test("an invited guest gets 403 from export, import, settings and the session erase", async () => {
    for (const [method, route, body] of [
      ["GET", "/memory/export"],
      ["POST", "/memory/import", { text: "## Preferences\n- I prefer tables" }],
      ["PATCH", "/memory/settings", { facets: { format: false } }],
      ["PATCH", "/memory/settings", { codiumHelpers: "on", distillation: true }],
      ["POST", "/memory/bootstrap", {}],
      ["DELETE", "/memory/sessions/ses_none"],
    ] as const)
      expect((await call(method, route, body, guest)).status).toBe(403)
  })

  test("the facets Vector may learn and the model learner are the owner's settings", async () => {
    const before = (await (await call("GET", "/memory/settings")).json()) as {
      facets: Record<string, boolean>
      modelLearner: string
    }
    expect(before.facets).toEqual({
      format: true,
      workflow: true,
      vocabulary: true,
      tooling: true,
      sources: true,
      style: true,
    })
    expect(before.modelLearner).toBe("local-only")
    const changed = await call("PATCH", "/memory/settings", { facets: { tooling: false }, modelLearner: "off" })
    expect(changed.status).toBe(200)
    const after = (await changed.json()) as { facets: Record<string, boolean>; modelLearner: string; learning: boolean }
    expect(after.facets.tooling).toBe(false)
    expect(after.facets.format).toBe(true)
    expect(after.modelLearner).toBe("off")
    expect(after.learning).toBe(true)
    await call("PATCH", "/memory/settings", { facets: { tooling: true }, modelLearner: "local-only" })
  }, 30_000)

  test("Brain helper consent is ask until the owner chooses, and a subscription cannot enable it", async () => {
    const before = (await (await call("GET", "/memory/settings")).json()) as { codiumHelpers?: string }
    expect(before.codiumHelpers).toBe("ask")
    const on = await call("PATCH", "/memory/settings", { codiumHelpers: "on", distillation: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ codiumHelpers: "on", distillation: true })
    const off = await call("PATCH", "/memory/settings", { codiumHelpers: "off", distillation: false })
    expect(await off.json()).toMatchObject({ codiumHelpers: "off", distillation: false })
    expect((await call("PATCH", "/memory/settings", { codiumHelpers: true })).status).toBe(400)
    await call("PATCH", "/memory/settings", { codiumHelpers: "ask" })
  }, 30_000)

  test("an import lands every entry waiting for approval, and the export carries it as an attachment", async () => {
    const imported = await call("POST", "/memory/import", {
      text: "## Preferences\n- I prefer bullet points over prose\n## Terms\n- When I say ship it, I mean open a PR and merge once CI passes\n## Rules\n- Never force-push",
    })
    expect(imported.status).toBe(200)
    const result = (await imported.json()) as { entries: { kind: string; status: string; origin: string }[] }
    expect(result.entries.map((entry) => [entry.kind, entry.status, entry.origin])).toEqual([
      ["preference", "proposed", "import"],
      ["term", "proposed", "import"],
    ])
    const exported = await call("GET", "/memory/export?scope=personal&format=json")
    expect(exported.status).toBe(200)
    expect(exported.headers.get("content-disposition")).toContain("attachment")
    expect(exported.headers.get("content-type")).toContain("application/json")
    const file = (await exported.json()) as { format: string; entries: { text: string; status: string }[] }
    expect(file.format).toBe("vector-memory")
    expect(file.entries.map((entry) => entry.text)).toContain("I prefer bullet points over prose")
    const page = await call("GET", "/memory/export")
    expect(page.headers.get("content-type")).toContain("text/markdown")
    expect(await page.text()).toContain("## Terms")
  }, 30_000)

  test("an import past 2 MB is refused, and a session that taught nothing erases nothing", async () => {
    const big = await call("POST", "/memory/import", { text: "x".repeat(2 * 1024 * 1024 + 1) })
    expect(big.status).toBe(400)
    const erased = await call("DELETE", "/memory/sessions/ses_none")
    expect(erased.status).toBe(200)
    expect(await erased.json()).toBe(0)
  }, 30_000)
})
