import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createDesktopCloudAgentApi } from "../../../api/_lib/cloud-agents-desktop"
import { githubApp } from "../../../api/_lib/github-app"

const account = "11111111-1111-4111-8111-111111111111"
const uploadId = `vbu_${"u".repeat(32)}`
const sha256 = "a".repeat(64)
const saved = {
  secret: process.env.VECTOR_CLI_TOKEN_SECRET,
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
}
const state = {
  revoked: false,
  wrongAccount: false,
  bindFails: false,
  enabled: true,
  eligible: true,
  calls: [] as string[],
  stores: 0,
  fetches: 0,
  limits: 0,
}
const binding = {
  repositoryId: "123",
  ownerId: "7",
  repository: "owner/project",
  account,
  visibility: "private",
  defaultRef: "refs/heads/main",
  generation: "1",
  binderGithubId: "9",
  binderLogin: "writer",
  workflowVersion: "3",
  boundAt: "1800000000000",
  installationId: "600",
}
const api = createDesktopCloudAgentApi({
  env: {
    get VECTOR_GITHUB_BRAIN_ENABLED() {
      return state.enabled ? "true" : "false"
    },
  },
  fetcher: (async (_url, init) => {
    state.fetches++
    const command = JSON.parse(String(init?.body))
    expect(command).toEqual(["GET", `vector:cli-revoked:${account}`])
    return Response.json({ result: state.revoked ? "1" : null })
  }) as typeof fetch,
  store: async (command) => {
    state.stores++
    expect(command[0]).toBe("EVAL")
    expect(command[2]).toBe("1")
    expect(command[3]).toBe("vector:cloud-agents:binding:123")
    return [
      Object.entries({
        ...binding,
        account: state.wrongAccount ? "22222222-2222-4222-8222-222222222222" : account,
      }).flat(),
    ]
  },
  app: {
    ...githubApp,
    attachmentRepository: async (value) => {
      expect(value.repositoryId).toBe("123")
      state.calls.push("current-repository")
      return { repositoryId: "123", generation: 1, publicRepository: true }
    },
  },
  prepare: async (trigger, deps) => {
    expect(trigger).toMatchObject({
      source: "desktop",
      account,
      purpose: "task",
      prompt: "Maintain this repository",
      target: { kind: "github-run", repositoryId: 123 },
    })
    expect(deps?.brainUpload).toBe(uploadId)
    state.calls.push("prepare")
    return {
      ok: true,
      ticketHash: "b".repeat(64),
      dispatch: async () => {
        state.calls.push("dispatch")
        return { ok: true, dispatchedAt: 1_800_000_000_000 }
      },
      cancel: async () => {
        state.calls.push("cancel")
        return true
      },
    }
  },
  bind: async (value) => {
    state.calls.push("bind")
    expect(value).toMatchObject({
      account,
      repositoryId: "123",
      generation: 1,
      uploadId,
      sha256,
      ticketHash: "b".repeat(64),
    })
    if (state.bindFails) throw new Error("fixture consent changed")
    return { uploadId, sha256, bytes: 40, approvedAt: 1_800_000_000_000 }
  },
  limit: async () => {
    state.limits++
  },
  eligible: async () => state.eligible,
})
const server = createServer((request, response) => {
  const route = new URL(request.url ?? "/", "http://fixture").pathname.slice(1)
  void (route === "prepare" || route === "commit" || route === "download" ? api[route] : api.start)(request, response)
})
let origin = ""
beforeAll(async () => {
  process.env.VECTOR_CLI_TOKEN_SECRET = "desktop-brain-fixture-secret-at-least-32-characters"
  process.env.KV_REST_API_URL = "https://kv.fixture.invalid"
  process.env.KV_REST_API_TOKEN = "fixture-only"
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  for (const [key, value] of Object.entries({
    VECTOR_CLI_TOKEN_SECRET: saved.secret,
    KV_REST_API_URL: saved.url,
    KV_REST_API_TOKEN: saved.token,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
const body = { repositoryId: "123", prompt: "Maintain this repository", brain: { uploadId, sha256 } }
const post = (
  value: unknown = body,
  token = mintCliToken({ id: account, email: "fixture@example.test" }, Date.now(), "desktop").token,
) =>
  fetch(origin, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(value),
  })

test("an exact approved desktop attachment binds before dispatch and returns no credential", async () => {
  state.calls = []
  const response = await post()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, dispatchedAt: 1_800_000_000_000 })
  expect(state.calls).toEqual(["current-repository", "prepare", "bind", "dispatch"])
})

test("failed attachment binding cancels the prepared ticket without dispatch", async () => {
  state.calls = []
  state.bindFails = true
  try {
    expect((await post()).status).toBe(503)
    expect(state.calls).toEqual(["current-repository", "prepare", "bind", "cancel"])
  } finally {
    state.bindFails = false
  }
})

test("only the current unrevoked desktop binder may start and renderer source/account/generation fields are refused", async () => {
  for (const token of [
    "vrt_fixture.signature",
    "website_fixture",
    mintCliToken({ id: account, email: "fixture@example.test" }).token,
  ]) {
    state.calls = []
    expect((await post(body, token)).status).toBe(503)
    expect(state.calls).toEqual([])
  }
  for (const field of ["source", "account", "generation", "publicRepository"]) {
    state.calls = []
    expect((await post({ ...body, [field]: "forged" })).status).toBe(503)
    expect(state.calls).toEqual([])
  }
  for (const field of ["revoked", "wrongAccount"] as const) {
    state.calls = []
    state[field] = true
    try {
      expect((await post()).status).toBe(503)
      expect(state.calls).toEqual([])
    } finally {
      state[field] = false
    }
  }
})

test("manual desktop calls cannot bypass a closed source allowance or unpublished Brain service", async () => {
  state.eligible = false
  state.calls = []
  try {
    expect((await post()).status).toBe(503)
    expect(state.calls).toEqual([])
  } finally {
    state.eligible = true
  }
})

test("the new attachment route remains off by default and never starts a no-attachment fallback", async () => {
  state.enabled = false
  state.calls = []
  try {
    expect((await post()).status).toBe(503)
    expect(state.calls).toEqual([])
  } finally {
    state.enabled = true
  }
})

test("with the switch off every Brain route answers 503 before any method, body, credential, limit or store work", async () => {
  const token = mintCliToken({ id: account, email: "fixture@example.test" }, Date.now(), "desktop").token
  const routes = {
    prepare: { repositoryId: "123", sha256, bytes: 40, includeBrain: true },
    commit: { uploadId, nonce: "A".repeat(16), ciphertext: "A".repeat(76) },
    download: { uploadId },
    "": body,
  }
  const variants: Array<{ method: string; body?: unknown; query?: string; headers?: Record<string, string> }> = [
    { method: "POST" },
    { method: "POST", body: { forged: "field" } },
    { method: "POST", query: "?ticket=secret" },
    { method: "GET" },
    { method: "POST", headers: { origin: "https://attacker.invalid" } },
    { method: "POST", headers: { "content-type": "text/plain" } },
  ]
  Object.assign(state, { enabled: false, stores: 0, fetches: 0, limits: 0, calls: [] })
  try {
    for (const [route, value] of Object.entries(routes))
      for (const variant of variants) {
        const response = await fetch(`${origin}/${route}${variant.query ?? ""}`, {
          method: variant.method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...variant.headers },
          ...(variant.method === "GET" ? {} : { body: JSON.stringify({ ...value, ...(variant.body ?? {}) }) }),
        })
        expect({ route, variant, status: response.status, body: await response.json() }).toEqual({
          route,
          variant,
          status: 503,
          body: { error: { code: "BRAIN_UPLOAD_UNAVAILABLE", message: expect.any(String) } },
        })
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      }
    expect({ stores: state.stores, fetches: state.fetches, limits: state.limits, calls: state.calls }).toEqual({
      stores: 0,
      fetches: 0,
      limits: 0,
      calls: [],
    })
  } finally {
    state.enabled = true
  }
  // Positive control: switched on, the same request reaches the desktop revocation read, then stops at eligibility.
  state.eligible = false
  try {
    const response = await fetch(`${origin}/prepare`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(routes.prepare),
    })
    expect(response.status).toBe(503)
    expect({ stores: state.stores, fetches: state.fetches, limits: state.limits }).toEqual({
      stores: 0,
      fetches: 1,
      limits: 0,
    })
  } finally {
    state.eligible = true
  }
})
