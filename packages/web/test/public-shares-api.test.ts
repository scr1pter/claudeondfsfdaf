import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient, SQL } from "bun"
import { randomBytes, randomUUID } from "node:crypto"
import { createServer, request } from "node:http"
import createHandler from "../../../api/shares/index"
import itemHandler from "../../../api/shares/[id]"
import cleanupHandler from "../../../api/shares/cleanup"
import { mintCliToken, verifyCliTokenClaims } from "../../../api/_lib/cli-token"
import { revokeCliToken } from "../../../api/_lib/revocation"
import type { ApiRequest } from "../../../api/_lib/http"
import { PublicSession } from "../../schema/src/public-session"

// Dedicated disposable databases only: these tests execute the real SQL and Lua.
const url = new URL(process.env.VECTOR_TEST_POSTGRES_URL ?? "postgres://127.0.0.1/vector_shares_test")
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/vector_shares_test")
  throw new Error("Public share tests require a disposable loopback vector_shares_test database")
const database = new SQL(url.href)
const redis = new RedisClient(process.env.VECTOR_TEST_REDIS_URL ?? "redis://127.0.0.1:6379")
const state = { origin: "", storageDown: false, kvDown: false, redirect: false, redirected: 0, owner: "" }
const captured: Record<string, unknown>[] = []
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const route = new URL(request.url).pathname
    if (route === "/redis") {
      if (state.kvDown) return new Response(null, { status: 503 })
      expect(request.headers.get("authorization")).toBe("Bearer fixture-kv")
      const command = (await request.json()) as string[]
      return Response.json({ result: await redis.send(command[0], command.slice(1).map(String)) })
    }
    if (route === "/unexpected") {
      state.redirected++
      return Response.json({})
    }
    expect(route).toBe("/rest/v1/rpc/vector_public_share")
    if (state.storageDown) return new Response(null, { status: 503 })
    if (state.redirect) return Response.redirect(`${upstream.url.origin}/unexpected`, 307)
    expect(request.headers.get("authorization")).toBe("Bearer fixture-service-role")
    expect(request.headers.get("apikey")).toBe("fixture-service-role")
    const body = (await request.json()) as { request: Record<string, unknown> }
    captured.push(body.request)
    const rows = await database.begin(async (transaction) => {
      await transaction`set local role service_role`
      return transaction`select public.vector_public_share(${body.request}::jsonb) as result`
    })
    return Response.json(rows[0].result)
  },
})
const server = createServer((request, response) => {
  if (request.url === "/api/shares/cleanup") {
    void cleanupHandler(request, response)
    return
  }
  const id = /^\/api\/shares\/([^/?]+)$/.exec(request.url ?? "")?.[1]
  if (id) {
    const item: ApiRequest = request
    item.query = { id }
    void itemHandler(item, response)
    return
  }
  void createHandler(request, response)
})
const keys = [
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_ABUSE_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "CRON_SECRET",
]
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

beforeAll(async () => {
  await database
    .unsafe(
      `
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
  `,
    )
    .simple()
  await database
    .unsafe(await Bun.file(new URL("../../../docs/vector/owner-actions/sql/public-shares.sql", import.meta.url)).text())
    .simple()
  Object.assign(process.env, {
    NODE_ENV: "development",
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    KV_REST_API_URL: `${upstream.url.origin}/redis`,
    KV_REST_API_TOKEN: "fixture-kv",
    CRON_SECRET: "fixture-cleanup-secret",
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture failed to bind")
  state.origin = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  state.owner = randomUUID()
  state.storageDown = false
  state.kvDown = false
  state.redirect = false
  captured.length = 0
  await database`insert into auth.users(id) values (${state.owner})`
})

afterAll(async () => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  await database.close()
  redis.close()
  keys.forEach((key) => (previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key])))
})

function fixture() {
  return {
    id: randomBytes(16).toString("hex"),
    secret: randomBytes(32).toString("hex"),
    expiresAt: Date.now() + 86_400_000,
    consent: { version: 1 as const, public: true as const, updates: true },
    archive: {
      version: 1 as const,
      engine: "v2" as const,
      title: "Share fixture",
      messages: [
        {
          id: "source-message",
          role: "user" as const,
          createdAt: Date.now(),
          parts: [{ type: "text" as const, text: "A visible question" }],
        },
      ],
    },
  }
}

async function send(method: string, id?: string, body?: unknown, extra: Record<string, string> = {}) {
  if (body && JSON.stringify(body).length > PublicSession.MAX_BYTES) {
    // Exercise early HTTP rejection independently of Bun's pooled upload client.
    const text = JSON.stringify(body)
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        `${state.origin}/api/shares`,
        {
          method,
          agent: false,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
          incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })))
          incoming.on("error", reject)
        },
      )
      outgoing.on("error", reject)
      outgoing.end(text)
    })
  }
  const response = await fetch(`${state.origin}/api/shares${id ? `/${id}` : ""}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mintCliToken({ id: state.owner, email: "fixture@example.test" }).token}`,
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
}

test("create/view/update/unshare executes the real SQL and exposes no management identity", async () => {
  const input = fixture()
  const created = await send("POST", undefined, input)
  expect(created.status).toBe(200)
  const info = await created.json()
  expect(info).toMatchObject({ id: input.id, revision: 0, updates: true, url: `https://vectordev.ai/s/${input.id}` })
  expect(await (await send("POST", undefined, input)).json()).toEqual(info)
  expect(captured[0].secret).not.toBe(input.secret)
  expect(captured[0].secret).toMatch(/^[a-f0-9]{64}$/)
  const view = await send("GET", input.id, undefined, { authorization: "" })
  expect(view.status).toBe(200)
  expect(view.headers.get("cache-control")).toBe("no-store")
  expect(view.headers.get("x-robots-tag")).toContain("noindex")
  const snapshot = await view.json()
  expect(snapshot.archive).toEqual(input.archive)
  expect(Object.keys(snapshot).sort()).toEqual([
    "archive",
    "expiresAt",
    "id",
    "revision",
    "updatedAt",
    "updates",
    "url",
  ])
  expect(JSON.stringify(snapshot)).not.toContain(state.owner)
  expect(JSON.stringify(snapshot)).not.toContain(input.secret)
  const updated = { secret: input.secret, revision: info.revision, archive: { ...input.archive, title: "Updated" } }
  expect((await send("PUT", input.id, updated)).status).toBe(200)
  expect((await (await send("PUT", input.id, updated)).json()).revision).toBe(1)
  expect((await send("PUT", input.id, { ...updated, archive: input.archive })).status).toBe(409)
  expect((await send("DELETE", input.id, { secret: input.secret })).status).toBe(200)
  expect((await send("DELETE", input.id, { secret: input.secret })).status).toBe(200)
  expect((await send("GET", input.id)).status).toBe(404)
  expect((await send("POST", undefined, input)).status).toBe(409)
  expect((await send("PUT", input.id, updated)).status).toBe(409)
  const rows = await database`select snapshot, deleted_at from public.vector_public_shares where id = ${input.id}`
  expect(rows[0].snapshot).toBeNull()
  expect(Number(rows[0].deleted_at)).toBeGreaterThan(0)
})

test("deletion arriving before creation and racing updates cannot resurrect a share", async () => {
  const delayed = fixture()
  expect((await send("DELETE", delayed.id, { secret: delayed.secret })).status).toBe(200)
  expect((await send("POST", undefined, delayed)).status).toBe(409)
  const input = fixture()
  expect((await send("POST", undefined, input)).status).toBe(200)
  const outcomes = await Promise.all([
    send("PUT", input.id, { secret: input.secret, revision: 0, archive: { ...input.archive, title: "Racing update" } }),
    send("DELETE", input.id, { secret: input.secret }),
    send("POST", undefined, input),
  ])
  expect(outcomes[1].status).toBe(200)
  expect([200, 409]).toContain(outcomes[0].status)
  expect([200, 409]).toContain(outcomes[2].status)
  expect((await send("GET", input.id)).status).toBe(404)
})

test("owner and secret are both required; fixed snapshots cannot acquire unconsented updates", async () => {
  const input = fixture()
  input.consent.updates = false
  expect((await send("POST", undefined, input)).status).toBe(200)
  const stranger = mintCliToken({ id: randomUUID(), email: "stranger@example.test" }).token
  expect(
    (
      await send(
        "PUT",
        input.id,
        { secret: input.secret, revision: 0, archive: input.archive },
        { authorization: `Bearer ${stranger}` },
      )
    ).status,
  ).toBe(404)
  expect((await send("DELETE", input.id, { secret: "a".repeat(64) })).status).toBe(404)
  expect(
    (
      await send("PUT", input.id, {
        secret: input.secret,
        revision: 0,
        archive: { ...input.archive, title: "Changed" },
      })
    ).status,
  ).toBe(409)
  expect((await send("GET", input.id)).status).toBe(200)
})

test("consent, expiry, exact bearer, archive fields and byte limits are validated before storage", async () => {
  const input = fixture()
  expect((await send("POST", undefined, input, { authorization: "" })).status).toBe(401)
  expect(
    (
      await send("POST", undefined, input, {
        authorization: `Bearer ${mintCliToken({ id: state.owner, email: "fixture@example.test" }).token}.extra`,
      })
    ).status,
  ).toBe(401)
  expect((await send("POST", undefined, { ...input, consent: undefined })).status).toBe(400)
  expect((await send("POST", undefined, { ...input, consent: { ...input.consent, version: 2 } })).status).toBe(400)
  expect(
    (await send("POST", undefined, { ...input, expiresAt: Date.now() + PublicSession.MAX_AGE_MS + 60_000 })).status,
  ).toBe(400)
  expect(
    (await send("POST", undefined, { ...input, archive: { ...input.archive, permissions: { bash: "allow" } } })).status,
  ).toBe(400)
  expect((await send("POST", undefined, { ...input, padding: "x".repeat(PublicSession.MAX_BYTES) })).status).toBe(413)
  expect((await send("POST", undefined, input, { origin: "https://foreign.example" })).status).toBe(403)
  expect(captured).toHaveLength(0)
})

test("revocation, expiry and account deletion hide public content and prevent reuse", async () => {
  const input = fixture()
  expect((await send("POST", undefined, input)).status).toBe(200)
  await redis.send("SET", [`vector:cli-revoked:${state.owner}`, "1"])
  expect((await send("GET", input.id)).status).toBe(404)
  expect((await send("POST", undefined, fixture())).status).toBe(401)
  await redis.send("DEL", [`vector:cli-revoked:${state.owner}`])
  await database`update public.vector_public_shares set expires_at = 1 where id = ${input.id}`
  expect((await send("GET", input.id)).status).toBe(404)
  const second = fixture()
  expect((await send("POST", undefined, second)).status).toBe(200)
  await database`delete from auth.users where id = ${state.owner}`
  expect((await send("GET", second.id)).status).toBe(404)
  const rows =
    await database`select owner_id, snapshot, deleted_at from public.vector_public_shares where id = ${second.id}`
  expect(rows[0].owner_id).toBeNull()
  expect(rows[0].snapshot).toBeNull()
  expect(Number(rows[0].deleted_at)).toBeGreaterThan(0)
})

test("single CLI revocation stops share mutations while sibling grants and existing public links remain usable", async () => {
  const user = { id: state.owner, email: "fixture@example.test" }
  const token = mintCliToken(user, Date.now(), "cli").token
  const sibling = mintCliToken(user, Date.now(), "cli").token
  const claims = verifyCliTokenClaims(token)
  const input = fixture()
  const key = `vector:cli-revoked:${claims.id}:token:${claims.jti}`
  try {
    expect((await send("POST", undefined, input, { authorization: `Bearer ${token}` })).status).toBe(200)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt)
    expect((await send("POST", undefined, fixture(), { authorization: `Bearer ${token}` })).status).toBe(401)
    expect((await send("GET", input.id)).status).toBe(200)
    expect((await send("POST", undefined, fixture(), { authorization: `Bearer ${sibling}` })).status).toBe(200)
  } finally {
    await redis.send("DEL", [key])
  }
})

test("storage, KV, redirects and anonymous database access fail closed", async () => {
  const input = fixture()
  state.kvDown = true
  expect((await send("POST", undefined, input)).status).toBe(503)
  state.kvDown = false
  state.storageDown = true
  expect((await send("POST", undefined, input)).status).toBe(503)
  state.storageDown = false
  state.redirect = true
  expect((await send("POST", undefined, input)).status).toBe(503)
  expect(state.redirected).toBe(0)
  const privileges = await database`select
    has_function_privilege('anon', 'public.vector_public_share(jsonb)', 'EXECUTE') as anon_rpc,
    has_function_privilege('authenticated', 'public.vector_public_share(jsonb)', 'EXECUTE') as user_rpc,
    has_table_privilege('anon', 'public.vector_public_shares', 'SELECT') as anon_table,
    has_table_privilege('authenticated', 'public.vector_public_shares', 'SELECT') as user_table,
    has_function_privilege('service_role', 'public.vector_public_share(jsonb)', 'EXECUTE') as server_rpc`
  expect(privileges[0]).toEqual({
    anon_rpc: false,
    user_rpc: false,
    anon_table: false,
    user_table: false,
    server_rpc: true,
  })
})

test("authenticated cleanup erases expired payloads while retaining deletion tombstones", async () => {
  const input = fixture()
  expect((await send("POST", undefined, input)).status).toBe(200)
  await database`update public.vector_public_shares set expires_at = 1 where id = ${input.id}`
  expect((await send("GET", "cleanup")).status).toBe(401)
  expect((await send("GET", "cleanup", undefined, { authorization: "Bearer fixture-cleanup-secret" })).status).toBe(200)
  const rows = await database`select snapshot, deleted_at from public.vector_public_shares where id = ${input.id}`
  expect(rows[0].snapshot).toBeNull()
  expect(Number(rows[0].deleted_at)).toBeGreaterThan(0)
  expect((await send("POST", undefined, input)).status).toBe(409)
})

test("two different snapshots at the same revision have one winner", async () => {
  const input = fixture()
  expect((await send("POST", undefined, input)).status).toBe(200)
  const outcomes = await Promise.all(
    ["first", "second"].map((title) =>
      send("PUT", input.id, {
        secret: input.secret,
        revision: 0,
        archive: { ...input.archive, title },
      }),
    ),
  )
  expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409])
  const viewed = await (await send("GET", input.id)).json()
  expect(viewed.revision).toBe(1)
  expect(["first", "second"]).toContain(viewed.archive.title)
})

test("a request at the byte ceiling remains readable with its public response envelope", async () => {
  const input = fixture()
  input.archive.messages[0]!.parts = [
    { type: "text", text: "a".repeat(1_999_999) },
    { type: "text", text: "b".repeat(1_999_999) },
  ]
  const excess = Buffer.byteLength(JSON.stringify(input)) - PublicSession.MAX_BYTES
  input.archive.messages[0]!.parts[1]!.text = input.archive.messages[0]!.parts[1]!.text.slice(0, -excess)
  expect(Buffer.byteLength(JSON.stringify(input))).toBe(PublicSession.MAX_BYTES)
  expect((await send("POST", undefined, input)).status).toBe(200)
  const viewed = await send("GET", input.id)
  expect(viewed.status).toBe(200)
  const bytes = await viewed.arrayBuffer()
  expect(bytes.byteLength).toBeLessThanOrEqual(PublicSession.MAX_RESPONSE_BYTES)
  expect(JSON.parse(new TextDecoder().decode(bytes)).archive).toEqual(input.archive)
})
