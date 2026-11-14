import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"
import { createCloudAgentsWebhookHandler } from "../../../api/_lib/github-webhook-handlers/cloud-agents"
import artifactKey from "../../../api/cloud-agents/artifact-key"
import bind from "../../../api/cloud-agents/bind"
import bindCode from "../../../api/cloud-agents/bind-code"
import bindings from "../../../api/cloud-agents/bindings"
import heartbeat from "../../../api/cloud-agents/heartbeat"
import mint from "../../../api/cloud-agents/mint"
import runs from "../../../api/cloud-agents/runs"
import settle from "../../../api/cloud-agents/settle"
import unbind from "../../../api/cloud-agents/unbind"

// SEC-1 / SEC-2: while the service is off, no cloud-agents route or webhook delivery may read for write or write the
// persistent store. Every store path is recorded: the injected store, the KV REST upstream that rate limits, OIDC
// replay marks and revocation reads use, and the injected fetcher.
const ROUTES = ["bind-code", "bind", "bindings", "unbind", "runs", "mint", "heartbeat", "settle", "artifact-key"]
const GET = new Set(["bindings", "runs"])
const variables = [
  "NODE_ENV",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "VECTOR_ABUSE_SECRET",
  "MODEL_PLANS_ENABLED",
  "VECTOR_GITHUB_BRAIN_ENABLED",
]
const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
const state = { kv: [] as unknown[], store: [] as unknown[], fetched: [] as string[], called: [] as string[] }
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    state.kv.push(await request.json())
    return Response.json({ result: [1, 300] })
  },
})
const refuse = (name: string) => () => {
  state.called.push(name)
  throw new Error(`${name} ran while the service was off`)
}
const api = createCloudAgentsApi({
  store: async (command) => {
    state.store.push([...command])
    return null
  },
  fetcher: (async (input: RequestInfo | URL) => {
    state.fetched.push(String(input))
    return new Response(null, { status: 500 })
  }) as typeof fetch,
  verify: refuse("verify"),
  entitlement: refuse("entitlement"),
  revokedBefore: refuse("revokedBefore"),
})
const injected = new Map(
  Object.entries(api).map(([name, handler]) => [name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), handler]),
)
// The deployed functions share the real persistent store, which the KV upstream records.
const deployed = new Map(
  Object.entries({ artifactKey, bind, bindCode, bindings, heartbeat, mint, runs, settle, unbind }).map(
    ([name, handler]) => [name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), handler],
  ),
)
const server = createServer((request, response) => {
  const [, source, route] = new URL(request.url ?? "/", "http://fixture").pathname.split("/")
  void (source === "deployed" ? deployed : injected).get(route ?? "")?.(request, response)
})
const fixture = { origin: "" }

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "production",
    KV_REST_API_URL: upstream.url.origin,
    KV_REST_API_TOKEN: "service-off-fixture",
    VECTOR_ABUSE_SECRET: "service-off-fixture-abuse-secret-32-characters",
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not listen")
  fixture.origin = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  state.kv = []
  state.store = []
  state.fetched = []
  state.called = []
  delete process.env.MODEL_PLANS_ENABLED
  delete process.env.VECTOR_GITHUB_BRAIN_ENABLED
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  upstream.stop(true)
  for (const name of variables) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
})

async function send(source: "injected" | "deployed", route: string) {
  const response = await fetch(`${fixture.origin}/${source}/${route}`, {
    method: GET.has(route) ? "GET" : "POST",
    headers: {
      authorization: "Bearer vct_service-off-fixture",
      "content-type": "application/json",
      origin: "https://vectordev.ai",
    },
    ...(GET.has(route) ? {} : { body: JSON.stringify({ code: "fixture", repositoryId: "42", state: "running" }) }),
  })
  return { status: response.status, body: await response.json() }
}

test("the route list covers every exported cloud-agents route", () => {
  expect([...injected.keys()].sort()).toEqual([...ROUTES].sort())
  expect([...deployed.keys()].sort()).toEqual([...ROUTES].sort())
})

test("every route refuses and touches no store while either switch is off", async () => {
  for (const flags of [
    {},
    { MODEL_PLANS_ENABLED: "true" },
    { VECTOR_GITHUB_BRAIN_ENABLED: "true" },
    { MODEL_PLANS_ENABLED: "true", VECTOR_GITHUB_BRAIN_ENABLED: "1" },
    { MODEL_PLANS_ENABLED: "TRUE", VECTOR_GITHUB_BRAIN_ENABLED: "true" },
  ]) {
    delete process.env.MODEL_PLANS_ENABLED
    delete process.env.VECTOR_GITHUB_BRAIN_ENABLED
    Object.assign(process.env, flags)
    for (const route of ROUTES)
      for (const source of ["injected", "deployed"] as const)
        expect({ route, source, ...(await send(source, route)) }).toEqual({
          route,
          source,
          status: 503,
          body: { error: { code: "CLOUD_AGENTS_UNAVAILABLE", message: "This request could not be completed." } },
        })
  }
  expect(state).toEqual({ kv: [], store: [], fetched: [], called: [] })
})

test("with both switches on each route reaches request protection or its checks, so the switch is what refused", async () => {
  Object.assign(process.env, { MODEL_PLANS_ENABLED: "true", VECTOR_GITHUB_BRAIN_ENABLED: "true" })
  for (const route of ROUTES) {
    state.kv = []
    state.called = []
    await send("injected", route)
    expect({ route, reached: state.kv.length + state.called.length > 0 }).toEqual({ route, reached: true })
  }
})

test("the repository webhook handler reads and writes no binding while either switch is off", async () => {
  const handler = createCloudAgentsWebhookHandler({
    bindingFor: refuse("bindingFor"),
    suspendBinding: refuse("suspendBinding"),
    renameBinding: refuse("renameBinding"),
  })
  for (const flags of [{}, { MODEL_PLANS_ENABLED: "true" }, { VECTOR_GITHUB_BRAIN_ENABLED: "true" }]) {
    delete process.env.MODEL_PLANS_ENABLED
    delete process.env.VECTOR_GITHUB_BRAIN_ENABLED
    Object.assign(process.env, flags)
    for (const action of ["transferred", "deleted", "renamed"])
      await handler.handle({
        name: "repository",
        action,
        deliveryId: "service-off-fixture",
        payload: { repository: { id: 123, owner: { id: 8 }, full_name: "new/project" } },
      })
  }
  expect(state.called).toEqual([])
  Object.assign(process.env, { MODEL_PLANS_ENABLED: "true", VECTOR_GITHUB_BRAIN_ENABLED: "true" })
  await expect(
    handler.handle({
      name: "repository",
      action: "deleted",
      deliveryId: "service-off-fixture",
      payload: { repository: { id: 123 } },
    }),
  ).rejects.toThrow("bindingFor ran while the service was off")
})
