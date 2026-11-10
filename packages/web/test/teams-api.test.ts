import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { RedisClient, SQL } from "bun"
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { createServer } from "node:http"
import { Schema } from "effect"
import { Teams } from "../../schema/src/teams"
import { createTeamsApi } from "../../../api/_lib/teams"
import { mintCliToken, verifyCliTokenClaims } from "../../../api/_lib/cli-token"
import { revokeCliToken } from "../../../api/_lib/revocation"

integrationTests()

function integrationTests() {
  if (!process.env.VECTOR_TEST_TEAMS_POSTGRES_URL || !process.env.VECTOR_TEST_REDIS_URL) {
    test.skip("Teams HTTP/crypto/SQL tests require explicit disposable VECTOR_TEST_TEAMS_POSTGRES_URL and VECTOR_TEST_REDIS_URL", () => {})
    return
  }
  const postgres = new URL(process.env.VECTOR_TEST_TEAMS_POSTGRES_URL)
  const redisURL = new URL(process.env.VECTOR_TEST_REDIS_URL)
  if (
    !["127.0.0.1", "localhost"].includes(postgres.hostname) ||
    postgres.pathname !== "/vector_teams_test" ||
    !["127.0.0.1", "localhost"].includes(redisURL.hostname)
  )
    throw new Error("Teams tests only use disposable loopback services and vector_teams_test")
  const database = new SQL(postgres.href)
  const redis = new RedisClient(redisURL.href, { connectionTimeout: 1_000, enableOfflineQueue: false })
  const signing = generateKeyPairSync("ed25519")
  const state = {
    origin: "",
    account: "",
    org: "",
    token: "",
    storageDown: false,
    kvDown: false,
    redirect: false,
    redirected: 0,
    revokeAfterLookup: false,
    override: undefined as unknown,
  }
  const captured: Record<string, unknown>[] = []
  const redisKeys = new Set<string>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const route = new URL(request.url).pathname
      if (route === "/redis") {
        if (state.kvDown) return new Response(null, { status: 503 })
        expect(request.headers.get("authorization")).toBe("Bearer teams-fixture-kv")
        const command = (await request.json()) as (string | number)[]
        redisKeys.add(String(command[command[0] === "EVAL" ? 3 : 1]))
        return Response.json({ result: await redis.send(String(command[0]), command.slice(1).map(String)) })
      }
      if (route === "/unexpected") {
        state.redirected++
        return Response.json({})
      }
      expect(route).toBe("/rest/v1/rpc/vector_team_configuration")
      expect(request.headers.get("authorization")).toBe("Bearer fixture-service-role")
      expect(request.headers.get("apikey")).toBe("fixture-service-role")
      if (state.storageDown) return Response.json({ error: "fixture-service-role must stay private" }, { status: 503 })
      if (state.redirect) return Response.redirect(`${upstream.url.origin}/unexpected`, 307)
      const body = (await request.json()) as { request: Record<string, unknown> }
      captured.push(body.request)
      if (state.override instanceof Response) return state.override
      if (state.override !== undefined) return Response.json(state.override)
      const result = await database.begin(async (transaction) => {
        await transaction`set local role service_role`
        return transaction`select public.vector_team_configuration(${body.request}::jsonb) as result`
      })
      if (state.revokeAfterLookup) {
        const key = `vector:cli-revoked:${state.account}`
        redisKeys.add(key)
        await redis.send("SET", [key, "1"])
      }
      return Response.json(result[0].result)
    },
  })
  const api = createTeamsApi()
  const server = createServer((request, response) => {
    void (request.url?.startsWith("/api/org/keys") ? api.keys : api.config)(request, response)
  })
  const environment = [
    "NODE_ENV",
    "VERCEL_ENV",
    "VECTOR_TEAMS_ENABLED",
    "VECTOR_TEAMS_SIGNING_KEY_ID",
    "VECTOR_TEAMS_SIGNING_PRIVATE_KEY",
    "VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS",
    "VECTOR_CLI_TOKEN_SECRET",
    "VECTOR_ABUSE_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
  ]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

  beforeAll(async () => {
    await redis.connect()
    await database
      .unsafe(
        `
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
      create schema if not exists auth;
      create table if not exists auth.users(id uuid primary key, email text not null);
    `,
      )
      .simple()
    await database
      .unsafe(await Bun.file(new URL("../../../docs/vector/owner-actions/sql/teams.sql", import.meta.url)).text())
      .simple()
    Object.assign(process.env, {
      NODE_ENV: "development",
      VECTOR_CLI_TOKEN_SECRET: "teams-cli-fixture-secret".repeat(3),
      SUPABASE_URL: upstream.url.origin,
      SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
      KV_REST_API_URL: `${upstream.url.origin}/redis`,
      KV_REST_API_TOKEN: "teams-fixture-kv",
    })
    delete process.env.VERCEL_ENV
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture bind failed")
    state.origin = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    Object.assign(process.env, {
      VECTOR_TEAMS_ENABLED: "true",
      VECTOR_TEAMS_SIGNING_KEY_ID: "fixture-active",
      VECTOR_TEAMS_SIGNING_PRIVATE_KEY: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS: "[]",
      VECTOR_ABUSE_SECRET: `teams-fixture-${crypto.randomUUID()}`,
    })
    delete process.env.VERCEL_ENV
    state.account = crypto.randomUUID()
    state.org = crypto.randomUUID()
    state.token = mintCliToken({ id: state.account, email: "fixture@example.test" }).token
    state.storageDown = false
    state.kvDown = false
    state.redirect = false
    state.redirected = 0
    state.revokeAfterLookup = false
    state.override = undefined
    captured.length = 0
    await database`insert into auth.users(id,email) values (${state.account},'fixture@example.test')`
    await database`insert into public.vector_teams(id,name) values (${state.org},'Fixture team')`
    await database`insert into public.vector_team_memberships(team_id,account_id,role) values (${state.org},${state.account},'member')`
    await database`insert into public.vector_team_configurations(team_id,config) values (${state.org},${{ permission: { bash: "ask" }, model: "fixture/model" }}::jsonb)`
  })
  afterAll(async () => {
    server.closeAllConnections()
    server.close()
    upstream.stop(true)
    if (redisKeys.size) await redis.send("DEL", [...redisKeys])
    redis.close()
    await database.close()
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  async function send(
    path = "/api/org/config",
    token = state.token,
    method = "GET",
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${state.origin}${path}`, {
      method,
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    })
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
  }

  async function signed(response: Response, token = state.token) {
    expect(response.status).toBe(200)
    const envelope = Schema.decodeUnknownSync(Teams.Envelope, { onExcessProperty: "error" })(await response.json())
    const bytes = Buffer.from(`vector-org-config-v1.${envelope.payload}`, "utf8")
    expect(verify(null, bytes, signing.publicKey, Buffer.from(envelope.signature, "base64url"))).toBe(true)
    expect(
      verify(
        null,
        Buffer.concat([bytes, Buffer.from("tampered")]),
        signing.publicKey,
        Buffer.from(envelope.signature, "base64url"),
      ),
    ).toBe(false)
    const payload = Schema.decodeUnknownSync(Teams.Payload, { onExcessProperty: "error" })(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    )
    expect(payload.credentialHash).toBe(createHash("sha256").update(token).digest("hex"))
    expect(payload.expiresAt - payload.issuedAt).toBeLessThanOrEqual(Teams.MAX_AGE_MS)
    expect(payload.issuedAt).toBeLessThanOrEqual(Date.now())
    expect(payload.expiresAt).toBeGreaterThan(Date.now())
    expect(JSON.stringify(payload)).not.toContain(token)
    return payload
  }

  test("actual Ed25519 and PostgreSQL produce only the signed account's roster and explicit selected policy", async () => {
    const keys = await send("/api/org/keys", "")
    expect(keys.headers.get("cache-control")).toBe("no-store")
    const publicKeys = Schema.decodeUnknownSync(Teams.Keys)(await keys.json())
    expect(publicKeys.keys).toEqual([
      {
        id: "fixture-active",
        publicKey: signing.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      },
    ])
    const personal = await signed(await send())
    expect(personal.account).toEqual({ id: state.account, email: "fixture@example.test" })
    expect(personal.orgs).toEqual([{ id: state.org, name: "Fixture team", role: "member" }])
    expect(personal.active).toBeNull()
    const response = await send(`/api/org/config?org=${state.org}`)
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect((await signed(response)).active).toEqual({
      id: state.org,
      revision: 1,
      config: { model: "fixture/model", permission: { bash: "ask" } },
    })
    expect(captured).toEqual([{ accountID: state.account }, { accountID: state.account, orgID: state.org }])
  })

  test("nonmembers, removed memberships and deleted accounts cannot receive an explicit team configuration", async () => {
    const stranger = crypto.randomUUID()
    await database`insert into auth.users(id,email) values (${stranger},'stranger@example.test')`
    const foreign = await send(
      `/api/org/config?org=${state.org}`,
      mintCliToken({ id: stranger, email: "stranger@example.test" }).token,
    )
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: { code: "TEAM_ACCESS_DENIED" } })
    await database`delete from public.vector_team_memberships where team_id=${state.org} and account_id=${state.account}`
    expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(403)
    expect((await signed(await send())).orgs).toEqual([])
    await database`delete from auth.users where id=${state.account}`
    expect((await send()).status).toBe(401)
    expect(
      (
        await database`select count(*)::int as count from public.vector_team_configurations where team_id=${state.org}`
      )[0].count,
    ).toBe(1)
  })

  test("account revocation and storage outages fail closed and never serialize private upstream errors", async () => {
    const key = `vector:cli-revoked:${state.account}`
    redisKeys.add(key)
    await redis.send("SET", [key, "1"])
    expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(401)
    expect(captured).toEqual([])
    await redis.send("DEL", [key])
    state.kvDown = true
    const denied = await send()
    expect(denied.status).toBe(503)
    expect(await denied.json()).toMatchObject({ error: { code: "PERSISTENT_STORE_UNAVAILABLE" } })
    state.kvDown = false
    state.storageDown = true
    const failed = await send()
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain("fixture-service-role")
    state.storageDown = false
    state.redirect = true
    expect((await send()).status).toBe(503)
    expect(state.redirected).toBe(0)
  })

  test("revocation during the SQL lookup prevents signing an already-read policy", async () => {
    state.revokeAfterLookup = true
    const response = await send(`/api/org/config?org=${state.org}`)
    expect(response.status).toBe(401)
    expect(captured).toHaveLength(1)
    expect(await response.json()).toMatchObject({ error: { code: "CLI_TOKEN_INVALID" } })
  })

  test("one revoked CLI grant cannot load signed policy while its sibling remains authorized", async () => {
    const user = { id: state.account, email: "fixture@example.test" }
    const token = mintCliToken(user, Date.now(), "cli").token
    const sibling = mintCliToken(user, Date.now(), "cli").token
    const claims = verifyCliTokenClaims(token)
    redisKeys.add(`vector:cli-revoked:${claims.id}:token:${claims.jti}`)
    expect((await signed(await send(`/api/org/config?org=${state.org}`, token), token)).account.id).toBe(state.account)
    await revokeCliToken(claims.id, claims.jti!, claims.expiresAt)
    captured.length = 0
    expect((await send(`/api/org/config?org=${state.org}`, token)).status).toBe(401)
    expect(captured).toEqual([])
    expect((await signed(await send(`/api/org/config?org=${state.org}`, sibling), sibling)).account.id).toBe(
      state.account,
    )
  })

  test("configuration revisions advance atomically under parallel writes and cannot be rolled back by caller fields", async () => {
    await Promise.all(
      Array.from(
        { length: 5 },
        (_, index) =>
          database`update public.vector_team_configurations set config=${{ model: `fixture/${index}` }}::jsonb, revision=1 where team_id=${state.org}`,
      ),
    )
    const active = (await signed(await send(`/api/org/config?org=${state.org}`))).active
    expect(active?.revision).toBe(6)
    expect(active?.config.model).toMatch(/^fixture\/[0-4]$/)
    await expect(
      Promise.resolve(
        database`update public.vector_team_configurations set team_id=${crypto.randomUUID()} where team_id=${state.org}`,
      ),
    ).rejects.toBeDefined()
  })

  test("database RLS and RPC grants deny direct client reads/writes and invalid configurations", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        database.begin(async (transaction) => {
          await transaction.unsafe(`set local role ${role}`)
          return transaction`select * from public.vector_team_configurations`
        }),
      ).rejects.toBeDefined()
      await expect(
        database.begin(async (transaction) => {
          await transaction.unsafe(`set local role ${role}`)
          return transaction`select public.vector_team_configuration(${{ accountID: state.account }}::jsonb)`
        }),
      ).rejects.toBeDefined()
      await expect(
        database.begin(async (transaction) => {
          await transaction.unsafe(`set local role ${role}`)
          return transaction`insert into public.vector_teams(name) values ('Unauthorized')`
        }),
      ).rejects.toBeDefined()
    }
    for (const value of [
      [],
      JSON.parse('{"__proto__":{"bad":true}}'),
      { nested: { constructor: {} } },
      { text: "x".repeat(Teams.MAX_CONFIG_BYTES) },
    ])
      await expect(
        Promise.resolve(
          database`update public.vector_team_configurations set config=${value}::jsonb where team_id=${state.org}`,
        ),
      ).rejects.toBeDefined()
    const enabled = await database<
      { relrowsecurity: boolean }[]
    >`select relrowsecurity from pg_class where oid in ('public.vector_teams'::regclass,'public.vector_team_memberships'::regclass,'public.vector_team_configurations'::regclass)`
    expect(enabled.map((row) => row.relrowsecurity)).toEqual([true, true, true])
  })

  test("disabled/preview configuration and malformed or duplicate rotation keys never expose private key material", async () => {
    process.env.VECTOR_TEAMS_ENABLED = "false"
    expect((await send("/api/org/keys", "")).status).toBe(503)
    process.env.VECTOR_TEAMS_ENABLED = "true"
    process.env.VERCEL_ENV = "preview"
    expect((await send()).status).toBe(503)
    delete process.env.VERCEL_ENV
    const old = generateKeyPairSync("ed25519")
    const entry = {
      id: "old-key",
      publicKey: old.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    }
    process.env.VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS = JSON.stringify([entry])
    expect((await (await send("/api/org/keys", "")).json()).keys).toHaveLength(2)
    for (const value of [
      [{ ...entry, id: "fixture-active" }],
      [entry, entry],
      [{ ...entry, publicKey: "bad" }],
      [{ ...entry, privateKey: "never" }],
      [entry, { ...entry, id: "b" }, { ...entry, id: "c" }],
    ]) {
      process.env.VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS = JSON.stringify(value)
      const response = await send("/api/org/keys", "")
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain("PRIVATE KEY")
    }
    expect(createPublicKey(signing.privateKey).asymmetricKeyType).toBe("ed25519")
  })

  test("query, auth and upstream shape bounds do not permit arbitrary orgs or unsigned configuration", async () => {
    expect((await send("/api/org/config", "")).status).toBe(401)
    expect((await send("/api/org/config", state.token + ".extra")).status).toBe(401)
    for (const suffix of [
      "?org=",
      "?org=invalid",
      `?org=${state.org}&org=${state.org}`,
      `?org=${state.org}&extra=true`,
      "?accountID=someone",
    ])
      expect((await send("/api/org/config" + suffix)).status).toBe(400)
    expect((await send("/api/org/keys?org=anything", "")).status).toBe(400)
    expect((await send("/api/org/config", state.token, "POST")).status).toBe(405)
    for (const row of [
      { status: "ok", orgs: [], active: { id: state.org, revision: 1, config: {} } },
      { status: "ok", orgs: [{ id: state.org, name: "Fixture", role: "member" }], active: null },
      { status: "ok", orgs: [], active: null, extra: true },
      {
        status: "ok",
        orgs: [],
        active: { id: state.org, revision: 1, config: { text: "x".repeat(Teams.MAX_CONFIG_BYTES + 1) } },
      },
    ]) {
      state.override = row
      expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(503)
    }
  })

  test("account deletion cascades only its memberships and preserves the other member's shared policy", async () => {
    const colleague = crypto.randomUUID()
    await database`insert into auth.users(id,email) values (${colleague},'colleague@example.test')`
    await database`insert into public.vector_team_memberships(team_id,account_id,role) values (${state.org},${colleague},'admin')`
    await database`delete from auth.users where id=${state.account}`
    expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(401)
    expect(
      (
        await database`select count(*)::int as count from public.vector_team_memberships where account_id=${state.account}`
      )[0].count,
    ).toBe(0)
    const token = mintCliToken({ id: colleague, email: "colleague@example.test" }).token
    const payload = await signed(await send(`/api/org/config?org=${state.org}`, token), token)
    expect(payload.orgs).toEqual([{ id: state.org, name: "Fixture team", role: "admin" }])
    expect(payload.active?.revision).toBe(1)
    await database`delete from public.vector_teams where id=${state.org}`
    expect(
      (await database`select count(*)::int as count from public.vector_team_memberships where team_id=${state.org}`)[0]
        .count,
    ).toBe(0)
    expect(
      (
        await database`select count(*)::int as count from public.vector_team_configurations where team_id=${state.org}`
      )[0].count,
    ).toBe(0)
  })

  test("roster includes only current account memberships and rejects more than 100 without truncating", async () => {
    const stranger = crypto.randomUUID()
    const foreign = crypto.randomUUID()
    await database`insert into auth.users(id,email) values (${stranger},'stranger@example.test')`
    await database`insert into public.vector_teams(id,name) values (${foreign},'Private foreign team')`
    await database`insert into public.vector_team_memberships(team_id,account_id,role) values (${foreign},${stranger},'owner')`
    await database`with added as (insert into public.vector_teams(name) select 'Additional ' || item from generate_series(1,99) item returning id) insert into public.vector_team_memberships(team_id,account_id,role) select id,${state.account}::uuid,'member' from added`
    const payload = await signed(await send())
    expect(payload.orgs).toHaveLength(100)
    expect(payload.orgs.some((org) => org.id === foreign)).toBe(false)
    const overflow = crypto.randomUUID()
    await database`insert into public.vector_teams(id,name) values (${overflow},'Overflow')`
    await database`insert into public.vector_team_memberships(team_id,account_id,role) values (${overflow},${state.account},'member')`
    expect((await send()).status).toBe(503)
    expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(503)
  })

  test("signed policy never outlives its CLI grant and forged or expired grants never reach the database", async () => {
    const grant = mintCliToken(
      { id: state.account, email: "fixture@example.test" },
      Date.now() - 90 * 24 * 60 * 60 * 1_000 + 60_000,
    )
    const payload = await signed(await send(`/api/org/config?org=${state.org}`, grant.token), grant.token)
    expect(payload.expiresAt).toBe(grant.expiresAt)
    captured.length = 0
    const expired = mintCliToken(
      { id: state.account, email: "fixture@example.test" },
      Date.now() - 91 * 24 * 60 * 60 * 1_000,
    )
    expect((await send("/api/org/config", expired.token)).status).toBe(401)
    expect((await send("/api/org/config", state.token.slice(0, -4) + "abcd")).status).toBe(401)
    expect(captured).toEqual([])
  })

  test("SQL bounds reject deep/prototype policy and malformed RPC requests", async () => {
    const deep = Array.from({ length: Teams.MAX_CONFIG_DEPTH + 1 }).reduce<Record<string, unknown>>(
      (value) => ({ nested: value }),
      {},
    )
    expect(Teams.isConfig(deep)).toBe(false)
    await expect(
      Promise.resolve(
        database`update public.vector_team_configurations set config=${deep}::jsonb where team_id=${state.org}`,
      ),
    ).rejects.toBeDefined()
    for (const input of [
      null,
      [],
      {},
      { accountID: state.account, orgID: null },
      { accountID: "invalid" },
      { accountID: state.account, surprise: true },
    ]) {
      const rows = await database`select public.vector_team_configuration(${JSON.stringify(input)}::jsonb) as result`
      expect(rows[0].result).toEqual({ status: "invalid", orgs: [], active: null })
    }
    for (const config of [{ nested: JSON.parse('{"prototype":true}') }, deep]) {
      state.override = {
        status: "ok",
        orgs: [{ id: state.org, name: "Fixture", role: "member" }],
        active: { id: state.org, revision: 1, config },
      }
      expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(503)
    }
  })

  test("bounded upstream reading rejects oversized, invalid UTF-8 and non-JSON bodies", async () => {
    for (const body of ["x".repeat(Teams.MAX_RESPONSE_BYTES + 1), new Uint8Array([0xff]), "not json"]) {
      state.override = new Response(body)
      const response = await send()
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain("not json")
    }
  })

  test("persistent limits cover unauthenticated keys, IP attempts and accounts across source IPs", async () => {
    for (const _ of Array.from({ length: 120 }))
      expect((await send("/api/org/keys", "", "GET", { "x-forwarded-for": "192.0.2.1" })).status).toBe(200)
    expect((await send("/api/org/keys", "", "GET", { "x-forwarded-for": "192.0.2.1" })).status).toBe(429)
    for (const _ of Array.from({ length: 60 }))
      expect((await send("/api/org/config", "", "GET", { "x-forwarded-for": "192.0.2.2" })).status).toBe(401)
    expect((await send("/api/org/config", "", "GET", { "x-forwarded-for": "192.0.2.2" })).status).toBe(429)
    for (const index of Array.from({ length: 60 }, (_, index) => index))
      expect(
        (await send("/api/org/config", state.token, "GET", { "x-forwarded-for": `198.51.100.${index + 1}` })).status,
      ).toBe(200)
    const limited = await send("/api/org/config", state.token, "GET", { "x-forwarded-for": "198.51.100.200" })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(captured).toHaveLength(60)
  })

  test("unconfigured selected policy fails instead of signing a silent personal fallback", async () => {
    await database`delete from public.vector_team_configurations where team_id=${state.org}`
    expect((await send(`/api/org/config?org=${state.org}`)).status).toBe(503)
    expect((await signed(await send())).active).toBeNull()
  })
}
