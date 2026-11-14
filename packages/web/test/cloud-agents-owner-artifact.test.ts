import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { createOwnerArtifactReadApi } from "../../../api/_lib/cloud-agents-owner-artifact"
import { cloudRunArtifactKey, cloudBrainArtifactKey } from "../../../api/_lib/cloud-agents-artifact"
import { githubApp } from "../../../api/_lib/github-app"

const account = "11111111-1111-4111-8111-111111111111"
const rid = "gh-123-42-1-99"
const at = Date.now()
const saved = {
  secret: process.env.VECTOR_CLI_TOKEN_SECRET,
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
}
const record = {
  rid,
  account,
  repository: "owner/project",
  repositoryId: "123",
  runUrl: "https://github.com/owner/project/actions/runs/42",
  event: "workflow_dispatch",
  source: "github-dispatch",
  purpose: "task",
  startedAt: String(at - 60_000),
  generation: "1",
  jti: "j".repeat(22),
  thread: "dispatch-42",
  triggerSource: "desktop",
  triggerPurpose: "task",
  endedAt: String(at - 10_000),
  outcome: "changes",
  verdict: "pass",
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
  boundAt: String(at - 70_000),
  installationId: "600",
}
const state = {
  enabled: true,
  revoked: false,
  foreign: false,
  source: "desktop",
  thread: "dispatch-42" as string | undefined,
  generation: "1",
  rebind: false,
  brain: false,
  reads: 0,
}
const env = {
  VECTOR_RUN_ARTIFACT_SECRET: "owner-artifact-fixture-at-least-32-characters",
  get VECTOR_GITHUB_BRAIN_ENABLED() {
    return state.enabled ? "true" : "false"
  },
}
const api = createOwnerArtifactReadApi({
  env,
  now: () => at,
  fetcher: (async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual(["GET", `vector:cli-revoked:${account}`])
    return Response.json({ result: state.revoked ? "1" : null })
  }) as typeof fetch,
  store: async (command) => {
    if (command[0] === "HGETALL") {
      expect(command[1]).toBe(`vector:cloud-agents:run:${rid}`)
      return Object.entries({
        ...record,
        account: state.foreign ? "22222222-2222-4222-8222-222222222222" : account,
        triggerSource: state.source,
        ...(state.brain ? { brainSha: "a".repeat(64), brainPublic: "0" } : {}),
        ...(state.thread === undefined ? {} : { thread: state.thread }),
      })
        .filter(([key]) => state.thread !== undefined || key !== "thread")
        .flat()
    }
    expect(command[0]).toBe("EVAL")
    expect(command[2]).toBe("1")
    expect(command[3]).toBe("vector:cloud-agents:binding:123")
    return [Object.entries({ ...binding, generation: state.generation }).flat()]
  },
  app: {
    ...githubApp,
    ownerArtifact: async (current, run, artifactId) => {
      state.reads++
      expect(current.account).toBe(account)
      expect(run).toMatchObject({ repositoryId: "123", thread: "dispatch-42", runId: "42" })
      expect(artifactId).toBe("55")
      if (state.rebind) state.generation = "2"
      return { repositoryId: "123", generation: 1, publicRepository: true }
    },
  },
  limit: async () => {},
})
const server = createServer((request, response) => void api(request, response))
let origin = ""
beforeAll(async () => {
  process.env.VECTOR_CLI_TOKEN_SECRET = "owner-artifact-desktop-fixture-secret-at-least-32-characters"
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
const body = { rid, artifactId: "55" }
const post = (
  value: unknown = body,
  token = mintCliToken({ id: account, email: "fixture@example.test" }, at, "desktop").token,
) =>
  fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(value),
  })

test("a marked owner reads a completed exact artifact without acquiring model authority or requiring active model allowance", async () => {
  const response = await post()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ...cloudRunArtifactKey({ sub: account, repo: "123", gen: 1, thr: "dispatch-42" }, env),
    repositoryId: "123",
    thread: "dispatch-42",
    rid,
    artifactId: "55",
    publicRepository: true,
  })
})

test("completed Brain results derive the immutable stored Brain domain rather than an ordinary live conversation key", async () => {
  state.brain = true
  try {
    const response = await post()
    expect(response.status).toBe(200)
    const body = await response.json()
    const claims = { sub: account, repo: "123", gen: 1, thr: "dispatch-42" }
    expect(body.key).toBe(cloudBrainArtifactKey(claims, { sha256: "a".repeat(64), publicRepository: false }, env).key)
    expect(body.key).not.toBe(cloudRunArtifactKey(claims, env).key)
    expect(body.publicRepository).toBe(true)
  } finally {
    state.brain = false
  }
})

test("run tokens, ordinary CLI credentials and caller-picked thread/repository/account are refused", async () => {
  for (const token of [
    "vrt_fixture.signature",
    "website_fixture",
    mintCliToken({ id: account, email: "fixture@example.test" }, at).token,
  ]) {
    state.reads = 0
    expect((await post(body, token)).status).toBe(503)
    expect(state.reads).toBe(0)
  }
  for (const key of ["thread", "repositoryId", "account", "generation", "url"]) {
    state.reads = 0
    expect((await post({ ...body, [key]: "forged" })).status).toBe(503)
    expect(state.reads).toBe(0)
  }
})

test("foreign/legacy/repository-triggered records, current revocation and generation changes deny key reads", async () => {
  for (const change of ["foreign", "revoked", "source", "thread", "generation"] as const) {
    state.reads = 0
    if (change === "foreign" || change === "revoked") state[change] = true
    if (change === "source") state.source = "github-comment"
    if (change === "thread") state.thread = undefined
    if (change === "generation") state.generation = "2"
    try {
      expect((await post()).status).toBe(503)
      expect(state.reads).toBe(0)
    } finally {
      state.foreign = false
      state.revoked = false
      state.source = "desktop"
      state.thread = "dispatch-42"
      state.generation = "1"
    }
  }
})

test("a rebind during slow metadata verification and the closed activation switch both withhold the key", async () => {
  state.rebind = true
  try {
    expect((await post()).status).toBe(503)
  } finally {
    state.rebind = false
    state.generation = "1"
  }
  state.enabled = false
  state.reads = 0
  try {
    expect((await post()).status).toBe(503)
    expect(state.reads).toBe(0)
  } finally {
    state.enabled = true
  }
})
