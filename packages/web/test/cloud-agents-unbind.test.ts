import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { ABUSE_RATE_LIMIT_SCRIPT } from "../../../api/_lib/abuse"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createCloudAgentsApi } from "../../../api/_lib/cloud-agents-api"

// HTTP contract coverage only. The paused same-owner replacement and actual atomic Lua are exercised against
// disposable Redis by cloud-agents-binding.test.ts and cloud-agents-bind-api.test.ts in the required CI lane.
const account = "11111111-1111-4111-8111-111111111111"
const variables = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "VECTOR_CLI_TOKEN_SECRET", "VECTOR_ABUSE_SECRET"]
const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
const state: { reply: unknown; down: boolean; commands: readonly (string | number)[][] } = {
  reply: 0,
  down: false,
  commands: [],
}
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer unbind-http-fixture")
    const command = (await request.json()) as unknown[]
    if (command[0] === "GET") {
      expect(command).toEqual(["GET", `vector:cli-revoked:${account}`])
      return Response.json({ result: null })
    }
    expect(command.slice(0, 3)).toEqual(["EVAL", ABUSE_RATE_LIMIT_SCRIPT, "1"])
    return Response.json({ result: [1, 300] })
  },
})
const api = createCloudAgentsApi({
  store: async (command) => {
    state.commands = [...state.commands, [...command]]
    if (state.down) throw new Error("fixture unavailable")
    return state.reply
  },
})
const server = createServer((request, response) => {
  void api.unbind(request, response)
})
const fixture = { origin: "", token: "" }
beforeAll(async () => {
  Object.assign(process.env, {
    KV_REST_API_URL: upstream.url.origin,
    KV_REST_API_TOKEN: "unbind-http-fixture",
    VECTOR_CLI_TOKEN_SECRET: "fixture-unbind-http-secret-32-characters",
    VECTOR_ABUSE_SECRET: "fixture-unbind-http-abuse-32-characters",
  })
  fixture.token = mintCliToken({ id: account, email: "fixture@example.invalid" }, Date.now(), "desktop").token
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not listen")
  fixture.origin = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  state.reply = 0
  state.down = false
  state.commands = []
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
async function send(body: unknown) {
  const response = await fetch(`${fixture.origin}/unbind`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  expect(response.headers.get("cache-control")).toBe("no-store")
  return { status: response.status, body: await response.json() }
}

test("missing or malformed generation consent is refused before a binding command", async () => {
  for (const condition of [
    {},
    ...[null, "7", 0, -1, 1.5, true, Number.MAX_SAFE_INTEGER + 1].map((expectedGeneration) => ({ expectedGeneration })),
  ])
    expect((await send({ repositoryId: "42", ...condition })).status).toBe(400)
  expect((await send({ repositoryId: "42", expectedGeneration: 7, account })).status).toBe(400)
  expect(state.commands).toEqual([])
})

test("the API forwards the exact displayed generation in the atomic account-bound command", async () => {
  const refused = await send({ repositoryId: "42", expectedGeneration: 7 })
  expect(refused.status).toBe(403)
  expect(refused.body.error.code).toBe("ACTOR_NOT_ALLOWED")
  expect(state.commands).toHaveLength(1)
  expect(state.commands[0]?.slice(2)).toEqual([
    "3",
    "vector:cloud-agents:binding:42",
    "vector:cloud-agents:gen:42",
    `vector:cloud-agents:bindings:${account}`,
    account,
    "42",
    "7",
  ])
  state.reply = 1
  expect(await send({ repositoryId: "42", expectedGeneration: 9 })).toEqual({ status: 200, body: { ok: true } })
  expect(state.commands[1]?.at(-1)).toBe("9")
})

test("store errors and malformed receipts fail closed without a successful unbind response", async () => {
  for (const reply of [null, true, "1", [], "corrupt"]) {
    state.reply = reply
    expect((await send({ repositoryId: "42", expectedGeneration: 7 })).status).toBe(503)
  }
  state.down = true
  expect((await send({ repositoryId: "42", expectedGeneration: 7 })).status).toBe(503)
})
