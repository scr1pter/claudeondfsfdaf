import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceService, type WorkspaceRuntime } from "../src/service"
import { snapshotDigest } from "../src/docker"
import { WorkspacePublishError, type publishWorkspaceChanges } from "../src/github"
import { signWorkspaceRequest } from "../src/signing"
import { WorkspaceStore } from "../src/store"

const owner = "69b887b6-2893-471c-a8fc-23cb58756c7d"
const other = "1d2cc251-0663-493d-b78a-c592683d2129"
const secret = "host-secret-".repeat(5)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(input: { modelLimit?: number; maxActive?: number; publish?: typeof publishWorkspaceChanges } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vector-workspace-service-"))
  let clock = 1780000000000
  const state = {
    createFailure: false,
    stopFailure: false,
    modelFailure: false,
    calls: 0,
    starts: 0,
    stops: 0,
    requests: [] as { path: string; init: RequestInit }[],
    creation: undefined as unknown,
    saved: [] as unknown[],
    containers: new Map<string, "running" | "stopped">(),
    modelHeaders: "",
    snapshotText: "new content",
    publications: [] as unknown[],
  }
  const failedStops = new Set<string>()
  const runtime: WorkspaceRuntime = {
    async create(value) {
      state.creation = value
      if (state.createFailure) throw new Error("PRIVATE-CREDENTIAL")
      state.containers.set(value.id, "running")
      return { state: "running", port: 12345, baseCommit: "a".repeat(40) }
    },
    async start(id) {
      state.starts++
      state.containers.set(id, "running")
      return { state: "running", port: 12345 }
    },
    async inspect(id) {
      return { state: state.containers.get(id) ?? "missing" }
    },
    async stop(id) {
      state.stops++
      if (state.stopFailure || failedStops.has(id)) throw new Error("PRIVATE-CREDENTIAL")
      if (state.containers.has(id)) state.containers.set(id, "stopped")
    },
    async remove(id) {
      state.containers.delete(id)
    },
    async health() {
      return true
    },
    async snapshot(id, input) {
      if (state.containers.get(id) !== "stopped") throw new Error("Snapshot requires pause.")
      const snapshot = {
        baseCommit: input.baseCommit,
        changes: [
          { path: "README.md", mode: "100644" as const, content: Buffer.from(state.snapshotText).toString("base64") },
        ],
        diff: `--- README.md\n+++ README.md\n+${state.snapshotText}\n`,
      }
      return { ...snapshot, digest: snapshotDigest(snapshot) }
    },
    async request(_id, _password, path, init = {}) {
      state.requests.push({ path, init })
      if (path.includes("prompt_async")) {
        state.saved.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      const message = /\/message\/(msg_[A-Za-z0-9]+)/.exec(path)?.[1]
      if (message) {
        const saved = state.saved.find(
          (item) => typeof item === "object" && item !== null && "messageID" in item && item.messageID === message,
        )
        return saved
          ? Response.json({ info: { id: message, role: "user" }, parts: [] })
          : new Response(null, { status: 404 })
      }
      return Response.json(state.saved)
    },
  }
  const upstream: typeof fetch = Object.assign(
    async (_request: string | URL | Request, init?: RequestInit) => {
      state.calls++
      state.modelHeaders = new Headers(init?.headers).get("authorization") ?? ""
      if (state.modelFailure) throw new Error("PRIVATE-UPSTREAM-KEY")
      return Response.json({ choices: [{ message: { role: "assistant", content: "Cloud reply" } }] })
    },
    { preconnect: fetch.preconnect },
  )
  let store = new WorkspaceStore({
    path: join(directory, "workspaces.sqlite"),
    maxActivePerAccount: input.maxActive ?? 1,
    now: () => clock,
  })
  const make = () =>
    createWorkspaceService({
      store,
      runtime,
      secret,
      nonceDatabase: join(directory, "requests.sqlite"),
      relayOrigin: "http://host.docker.internal:4097",
      model: { id: "example", name: "Example", origin: "https://models.example/v1", key: "PRIVATE-UPSTREAM-KEY" },
      maxModelCalls: input.modelLimit ?? 5,
      maxRunMs: 60000,
      now: () => clock,
      fetch: upstream,
      publish:
        input.publish ??
        (async (input) => {
          state.publications.push(input)
          return {
            url: `https://github.com/${input.repository}/pull/1`,
            branch: `vector/${input.workspaceId}`,
            commit: "b".repeat(40),
          }
        }),
    })
  let service = make()
  const signed = (accountId: string, path: string, body?: unknown, nonce = randomUUID()) => {
    const raw = body === undefined ? "" : JSON.stringify(body)
    const method = body === undefined ? "GET" : "POST"
    return new Request(`http://service${path}`, {
      method,
      headers: signWorkspaceRequest({ secret, accountId, method, path, body: raw, now: clock, nonce }),
      ...(body === undefined ? {} : { body: raw }),
    })
  }
  const call = (path: string, body?: unknown, accountId = owner) => service.fetch(signed(accountId, path, body))
  async function turn(id: string, text: string) {
    const result = (await (
      await call(`/workspaces/${id}/engine`, {
        path: "/session/ses_saved/message_id",
        method: "POST",
        body: { requestID: randomUUID() },
      })
    ).json()) as { messageID: string }
    return { messageID: result.messageID, parts: [{ type: "text", text }] }
  }
  async function create() {
    const response = await call("/workspaces", {
      repository: "fixture/repository",
      idempotencyKey: randomUUID(),
      githubToken: "github_fixture_credential_only_init",
    })
    const value = (await response.json()) as { workspace: { id: string } }
    await service.settle()
    return value.workspace.id
  }
  const model = (
    id: string,
    body: NonNullable<RequestInit["body"]> = JSON.stringify({
      model: "example",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 20,
    }),
  ) => {
    const password = store.get(owner, id)!.enginePassword
    return service.fetch(
      new Request(`http://service/model/${id}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${password}` },
        body,
      }),
    )
  }
  cleanups.push(async () => {
    await service.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    state,
    failedStops,
    runtime,
    signed,
    call,
    create,
    model,
    turn,
    get service() {
      return service
    },
    get store() {
      return store
    },
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    async restart() {
      await service.close()
      store.close()
      store = new WorkspaceStore({
        path: join(directory, "workspaces.sqlite"),
        maxActivePerAccount: input.maxActive ?? 1,
        now: () => clock,
      })
      service = make()
      await service.recover()
    },
  }
}

test("account ownership, replay rejection and fixed engine routing hold across the control plane", async () => {
  const value = fixture()
  const nonce = randomUUID()
  const first = await value.service.fetch(value.signed(owner, "/workspaces", undefined, nonce))
  expect(first.status).toBe(200)
  expect((await value.service.fetch(value.signed(owner, "/workspaces", undefined, nonce))).status).toBe(409)
  const id = await value.create()
  const list = await (await value.call("/workspaces")).text()
  expect(list).not.toContain("enginePassword")
  expect(list).not.toContain("PRIVATE")
  expect(JSON.parse(list).workspaces[0].state).toBe("running")
  expect((await value.call(`/workspaces/${id}/engine`, { path: "/session", method: "GET" }, other)).status).toBe(404)
  expect(
    (await value.call(`/workspaces/${id}/engine`, { path: "/session?directory=/other", method: "GET" })).status,
  ).toBe(400)
  expect((await value.call(`/workspaces/${id}/engine`, { path: "/session?limit=50", method: "GET" })).status).toBe(200)
  expect(value.state.requests[0]!.path).toContain("directory=%2Fdata%2Frepository")
  expect(new Headers(value.state.requests[0]!.init.headers).get("x-vector-directory")).toBe("/data/repository")
  expect(value.state.creation).toMatchObject({
    credential: "github_fixture_credential_only_init",
    model: { maxOutputTokens: 4096 },
  })
  expect(JSON.stringify(value.state.creation)).not.toContain("PRIVATE-UPSTREAM-KEY")
})

test("saved chats survive pause, service restart and explicit resume without replaying a turn", async () => {
  const value = fixture()
  const id = await value.create()
  const turn = await value.turn(id, "Keep this saved")
  expect(
    (
      await value.call(`/workspaces/${id}/engine`, {
        path: "/session/ses_saved/prompt_async",
        method: "POST",
        body: turn,
      })
    ).status,
  ).toBe(200)
  const count = value.state.requests.length
  await value.restart()
  expect(value.store.get(owner, id)!.state).toBe("stopped")
  expect(value.state.starts).toBe(0)
  expect(value.state.requests).toHaveLength(count)
  expect((await value.call(`/workspaces/${id}/start`, {})).status).toBe(202)
  await value.service.settle()
  const saved = await value.call(`/workspaces/${id}/engine`, { path: "/session/ses_saved/message", method: "GET" })
  expect(await saved.json()).toEqual([turn])
  expect(value.state.requests.filter((item) => item.path.includes("prompt_async"))).toHaveLength(1)
  expect((await value.model(id)).status).toBe(422) // Recovery block needs a new explicit turn, not engine retry.
})

test("primary model keys stay server-side and durable limits do not reset on restart", async () => {
  const value = fixture({ modelLimit: 1 })
  const id = await value.create()
  const result = await value.model(id)
  expect(result.status).toBe(200)
  expect(await result.text()).toContain("Cloud reply")
  expect(value.state.modelHeaders).toBe("Bearer PRIVATE-UPSTREAM-KEY")
  expect(value.store.get(owner, id)!.modelCalls).toBe(1)
  expect((await value.model(id)).status).toBe(422)
  expect(value.state.calls).toBe(1)
  await value.restart()
  expect(value.store.get(owner, id)!.modelCalls).toBe(1)
})

test("unknown model outcomes block automatic paid retries until a new explicit user turn", async () => {
  const value = fixture()
  const id = await value.create()
  value.state.modelFailure = true
  const result = await value.model(id)
  expect(result.status).toBe(422)
  expect(await result.text()).not.toContain("PRIVATE-UPSTREAM-KEY")
  value.state.modelFailure = false
  expect((await value.model(id)).status).toBe(422)
  expect(value.state.calls).toBe(1)
  await value.call(`/workspaces/${id}/engine`, {
    path: "/session/ses_saved/prompt_async",
    method: "POST",
    body: await value.turn(id, "Continue after review"),
  })
  expect(await (await value.model(id)).text()).toContain("Cloud reply")
  expect(value.state.calls).toBe(2)
})

test("slow request bodies cannot bypass one in-flight model admission", async () => {
  const value = fixture()
  const id = await value.create()
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller)
      },
    })
  const a = value.model(id, body())
  const b = value.model(id, body())
  const bytes = new TextEncoder().encode(
    JSON.stringify({ model: "example", messages: [{ role: "user", content: "hello" }] }),
  )
  controllers.forEach((controller) => {
    controller.enqueue(bytes)
    controller.close()
  })
  const results = await Promise.all([a, b])
  expect(results.map((item) => item.status).sort()).toEqual([200, 429])
  await Promise.all(results.map((item) => item.text()))
  expect(value.state.calls).toBe(1)
})

test("hard lifetime and uncertain cleanup refuse more paid work without releasing its slot", async () => {
  const value = fixture()
  const id = await value.create()
  value.advance(60001)
  expect((await value.model(id)).status).toBe(422)
  expect(value.state.calls).toBe(0)
  value.state.stopFailure = true
  expect((await value.call(`/workspaces/${id}/stop`, {})).status).toBe(503)
  expect(value.store.get(owner, id)!.state).toBe("running")
  await value.restart()
  expect(value.store.get(owner, id)!.state).toBe("running")
  expect((await value.model(id)).status).toBe(422)
  value.state.stopFailure = false
  await value.service.reap()
  expect(value.store.get(owner, id)!.state).toBe("stopped")
})

test("failed initialization retains quota until cleanup succeeds and never leaks its exception", async () => {
  const value = fixture()
  value.state.createFailure = true
  value.state.stopFailure = true
  const id = await value.create()
  expect(value.store.get(owner, id)!.state).toBe("creating")
  value.state.stopFailure = false
  await value.service.recover()
  expect(value.store.get(owner, id)!.state).toBe("error")
  const response = await value.call(`/workspaces/${id}/delete`, {})
  expect(response.status).toBe(200)
  expect(value.store.get(owner, id)).toBeUndefined()
})

test("account closure durably blocks the workspace and removes its saved data without relying on browser access", async () => {
  const value = fixture()
  const id = await value.create()
  const password = value.store.get(owner, id)!.enginePassword
  expect((await value.call("/accounts/close", {})).status).toBe(202)
  expect((await value.call("/workspaces")).status).toBe(403)
  await value.service.settle()
  expect(value.store.list(owner)).toEqual([])
  expect(value.state.containers.size).toBe(0)
  const request = new Request(`http://service/model/${id}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${password}` },
    body: JSON.stringify({ model: "example", messages: [{ role: "user", content: "hello" }] }),
  })
  expect((await value.service.fetch(request)).status).toBe(401)
  expect(value.state.calls).toBe(0)
  await value.restart()
  expect((await value.call("/workspaces")).status).toBe(403)
})

test("closed accounts keep their paid-work fence even when cleanup needs a retry", async () => {
  const value = fixture()
  const id = await value.create()
  value.state.stopFailure = true
  expect((await value.call("/accounts/close", {})).status).toBe(202)
  await value.service.settle()
  expect(value.store.active()).toHaveLength(1)
  expect((await value.model(id)).status).toBe(401)
  value.state.stopFailure = false
  await value.service.reap()
  await value.service.settle()
  expect(value.store.list(owner)).toEqual([])
})

test("publication requires a paused, unchanged reviewed snapshot and persists its receipt for an ambiguous retry", async () => {
  const value = fixture()
  const id = await value.create()
  const initial = await value.call(`/workspaces/${id}/publish`, {
    digest: "a".repeat(64),
    githubToken: "github_fixture_credential_only_publish",
    title: "Update the README",
  })
  expect(initial.status).toBe(409)
  const review = (await (await value.call(`/workspaces/${id}/changes`, {})).json()) as {
    workspace: { state: string }
    changes: { digest: string; diff: string }
  }
  expect(review.workspace.state).toBe("stopped")
  expect(review.changes.diff).toContain("new content")
  value.state.snapshotText = "changed after review"
  expect(
    (
      await value.call(`/workspaces/${id}/publish`, {
        digest: review.changes.digest,
        githubToken: "github_fixture_credential_only_publish",
        title: "Update the README",
      })
    ).status,
  ).toBe(409)
  expect(value.state.publications).toHaveLength(0)
  value.state.snapshotText = "new content"
  const publish = () =>
    value.call(`/workspaces/${id}/publish`, {
      digest: review.changes.digest,
      githubToken: "github_fixture_credential_only_publish",
      title: "Update the README",
    })
  const result = await publish()
  expect(result.status).toBe(200)
  expect(await result.text()).not.toContain("github_fixture_credential")
  expect(value.state.publications).toHaveLength(1)
  expect(value.state.publications[0]).toMatchObject({
    baseCommit: "a".repeat(40),
    token: "github_fixture_credential_only_publish",
  })
  await value.restart()
  expect((await publish()).status).toBe(200)
  expect(value.state.publications).toHaveLength(1)
})

test("account closure cancels a publication already awaiting GitHub before cleanup retries", async () => {
  let began: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let cancelled = false
  const value = fixture({
    publish: async (input) => {
      began!()
      await new Promise<void>((_resolve, reject) => {
        input.signal!.addEventListener(
          "abort",
          () => {
            cancelled = true
            reject(new WorkspacePublishError("github_unavailable"))
          },
          { once: true },
        )
      })
      throw new Error("Publication must not continue after account closure.")
    },
  })
  const id = await value.create()
  const review = (await (await value.call(`/workspaces/${id}/changes`, {})).json()) as { changes: { digest: string } }
  const publishing = value.call(`/workspaces/${id}/publish`, {
    digest: review.changes.digest,
    githubToken: "github_fixture_credential_only_publish",
    title: "Update the README",
  })
  await started
  expect((await value.call("/accounts/close", {})).status).toBe(202)
  expect((await publishing).status).toBe(409)
  expect(cancelled).toBe(true)
  await value.service.settle()
  await value.service.reap()
  await value.service.settle()
  expect(value.store.list(owner)).toEqual([])
})

test("a new prompt cannot unblock an engine whose retirement is still uncertain", async () => {
  const value = fixture()
  const id = await value.create()
  const turn = await value.turn(id, "A new turn")
  value.state.stopFailure = true
  expect((await value.call(`/workspaces/${id}/stop`, {})).status).toBe(503)
  expect(
    (
      await value.call(`/workspaces/${id}/engine`, {
        path: "/session/ses_saved/prompt_async",
        method: "POST",
        body: turn,
      })
    ).status,
  ).toBe(409)
  expect((await value.model(id)).status).toBe(422)
  expect(value.state.requests).toHaveLength(0)
  value.state.stopFailure = false
  await value.service.reap()
  expect(value.store.get(owner, id)!.state).toBe("stopped")
  await value.call(`/workspaces/${id}/start`, {})
  await value.service.settle()
  expect(
    (
      await value.call(`/workspaces/${id}/engine`, {
        path: "/session/ses_saved/prompt_async",
        method: "POST",
        body: turn,
      })
    ).status,
  ).toBe(200)
})

test("an unavailable container does not starve another workspace's account erasure", async () => {
  const value = fixture({ maxActive: 2 })
  const first = await value.create()
  const second = await value.create()
  value.failedStops.add(first)
  await value.call("/accounts/close", {})
  await value.service.settle()
  expect(value.store.get(owner, first)).toBeDefined()
  expect(value.store.get(owner, second)).toBeUndefined()
  value.failedStops.clear()
  await value.service.reap()
  await value.service.settle()
  expect(value.store.list(owner)).toEqual([])
})

test("allocated turns are durably confirmed and an explicit retry cannot dispatch or modify them twice", async () => {
  const value = fixture()
  const id = await value.create()
  const turn = await value.turn(id, "Keep this exact turn")
  const send = (body: unknown) =>
    value.call(`/workspaces/${id}/engine`, { path: "/session/ses_saved/prompt_async", method: "POST", body })
  expect((await send(turn)).status).toBe(200)
  expect((await send(turn)).status).toBe(200)
  expect(value.state.saved).toHaveLength(1)
  expect(value.state.requests.filter((request) => request.path.includes("prompt_async"))).toHaveLength(1)
  expect((await send({ ...turn, parts: [{ type: "text", text: "Changed intent" }] })).status).toBe(409)
  expect((await send({ ...turn, messageID: "msg_0123456789abABCDEFGHIJKLMN" })).status).toBe(400)
})
