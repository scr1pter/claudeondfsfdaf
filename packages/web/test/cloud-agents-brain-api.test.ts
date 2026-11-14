import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createBrainUploadApi } from "../../../api/_lib/cloud-agents-brain-api"
import { ApiError } from "../../../api/_lib/http"

const account = "11111111-1111-4111-8111-111111111111"
let storeCalls = 0
let repositoryCalls = 0
let runCalls = 0
const api = createBrainUploadApi({
  desktop: async (request) => {
    if (request.headers.authorization !== "Bearer desktop_fixture") throw new ApiError(401, "DESKTOP_REQUIRED", "Desktop required")
    return { account }
  },
  repository: async (_account, repositoryId) => { repositoryCalls++; return { repositoryId, generation: 1, publicRepository: true } },
  run: async () => { runCalls++; throw new ApiError(401, "RUN_REQUIRED", "Run required") },
  store: async () => { storeCalls++; throw new Error("No valid request in these denial tests reaches storage") },
  limit: async () => {},
})
const server = createServer((request, response) => {
  const operation = request.url?.split("?")[0]?.slice(1)
  if (operation !== "prepare" && operation !== "commit" && operation !== "download") { response.writeHead(404).end(); return }
  void api[operation](request, response)
})
let origin: string
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
const post = (path: string, body: unknown, authorization?: string, extra: Record<string, string> = {}) => fetch(`${origin}/${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}), ...extra }, body: JSON.stringify(body),
})

test("run tokens and anonymous callers cannot prepare or commit desktop Brain uploads", async () => {
  for (const authorization of [undefined, "Bearer vrt_fixture", "Bearer website_fixture"]) {
    expect((await post("prepare", {}, authorization)).status).toBe(401)
    expect((await post("commit", {}, authorization)).status).toBe(401)
  }
  expect(storeCalls).toBe(0)
  expect(repositoryCalls).toBe(0)
})

test("account/source/visibility/ticket claims cannot be smuggled into owner JSON", async () => {
  const selection = { repositoryId: "42", sha256: "a".repeat(64), bytes: 100, includeBrain: true }
  for (const patch of [{ source: "desktop" }, { account }, { generation: 1 }, { publicRepository: false }, { ticketHash: "a".repeat(64) }])
    expect((await post("prepare", { ...selection, ...patch }, "Bearer desktop_fixture")).status).toBe(400)
  expect((await post("prepare?ticket=secret", selection, "Bearer desktop_fixture")).status).toBe(400)
  expect((await post("prepare", selection, "Bearer desktop_fixture", { origin: "https://attacker.invalid" })).status).toBe(403)
  expect(storeCalls).toBe(0)
  expect(repositoryCalls).toBe(0)
})

test("download takes only an opaque handle; desktop account authority grants no run read", async () => {
  const uploadId = `vbu_${"a".repeat(32)}`
  expect((await post("download", { uploadId, ticketHash: "a".repeat(64) }, "Bearer desktop_fixture")).status).toBe(400)
  expect(runCalls).toBe(0)
  expect((await post("download", { uploadId }, "Bearer desktop_fixture")).status).toBe(401)
  expect(runCalls).toBe(1)
  expect(storeCalls).toBe(0)
})
