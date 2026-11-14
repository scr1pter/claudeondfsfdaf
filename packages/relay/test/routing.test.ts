import { describe, expect, test } from "bun:test"
import { AccountRelay } from "../src/account-relay"
import { handleRequest, offeredTicket } from "../src/index"
import { CLOSE } from "../src/protocol"
import type { Env } from "../src/runtime"
import { accountHandle, signTicket, type TicketClaims } from "../src/ticket"
import {
  ACCOUNT,
  ACCOUNT_KEY,
  EPOCH,
  INTERNAL_SECRET,
  NOW,
  FakeKV,
  FakeNamespace,
  FakeRuntime,
  type FakeSocket,
  type FakeState,
  type UpgradeResponse,
  deviceId,
  ticketKeys,
  token,
} from "./fakes"

// WP A39: the Worker takes the ticket from Sec-WebSocket-Protocol, answers with the fixed `vector.v1`, reads its kill
// flag, and hands the connection to one Durable Object per account, named by HMAC(account).

async function setup(overrides: Partial<Env> = {}) {
  const keys = await ticketKeys()
  const clock = { now: NOW }
  const runtime = new FakeRuntime(clock)
  const kv = new FakeKV()
  let env: Env
  const namespace = new FakeNamespace((state: FakeState) => new AccountRelay(state, env, runtime))
  env = {
    ACCOUNT_RELAY: namespace,
    REMOTE_FLAGS: kv,
    TICKET_PUBLIC_KEYS: keys.publicText,
    INTERNAL_SECRET,
    ACCOUNT_KEY,
    ...overrides,
  }
  const ticket = (claims: Partial<TicketClaims> = {}) => {
    const iat = Math.floor(clock.now / 1000)
    return signTicket(
      {
        v: 1,
        aud: "vector-relay",
        sub: ACCOUNT,
        role: "computer",
        dev: deviceId(),
        computers: 3,
        rank: 2,
        epoch: EPOCH,
        periodEnd: NOW + 86_400_000,
        iat,
        exp: iat + 300,
        jti: token(),
        ...claims,
      },
      keys.privateKey,
    )
  }
  const connect = async (
    protocols: string | undefined,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { upgrade: "websocket", ...init.headers }
    if (protocols !== undefined) headers["sec-websocket-protocol"] = protocols
    const response = (await handleRequest(
      new Request("https://relay.example/v1/connect", { method: init.method ?? "GET", headers }),
      env,
      runtime,
    )) as UpgradeResponse
    const socket = response.webSocket ? (runtime.servers.get(response.webSocket) as FakeSocket) : undefined
    return { response, socket }
  }
  return { env, runtime, kv, namespace, clock, keys, ticket, connect }
}

describe("routing", () => {
  test("a valid ticket upgrades with vector.v1 only, and reaches the object named by the account's HMAC", async () => {
    const { connect, ticket, namespace } = await setup()
    const text = await ticket()
    const { response, socket } = await connect(`vector.v1, ${text}`, {
      headers: { cookie: "session=1", origin: "https://elsewhere.example", "x-vector-relay-account": "forged" },
    })
    expect(response.status).toBe(101)
    expect(response.headers.get("sec-websocket-protocol")).toBe("vector.v1")
    expect(socket?.closed).toBeUndefined()
    expect(socket?.messages()[0]).toMatchObject({ t: "hello", v: 1, role: "computer" })
    const handle = (await accountHandle(ACCOUNT_KEY, ACCOUNT))!
    expect(namespace.calls).toHaveLength(1)
    expect(namespace.calls[0]!.name).toBe(handle)
    // The object gets the upgrade and the ticket, and nothing else the client sent.
    expect([...namespace.calls[0]!.headers.keys()].sort()).toEqual(["upgrade", "x-vector-relay-ticket"])
    expect(namespace.calls[0]!.headers.get("x-vector-relay-ticket")).toBe(text)
    // The object stores the HMAC, not the account id.
    const object = namespace.objects.get(handle)!
    expect(JSON.stringify(object.state.sql.rows("SELECT * FROM meta"))).not.toContain(ACCOUNT)
    expect(JSON.stringify(object.state.sql.rows("SELECT * FROM devices"))).not.toContain(ACCOUNT)
  })

  test("the ticket may come first or second; the subprotocol list must be exactly vector.v1 and one ticket", async () => {
    const { connect, ticket } = await setup()
    expect((await connect(`${await ticket()},vector.v1`)).response.status).toBe(101)
    const text = await ticket()
    expect(offeredTicket(`vector.v1, ${text}`)).toBe(text)
    for (const header of [
      undefined,
      "",
      "vector.v1",
      text,
      `vector.v2, ${text}`,
      `vector.v1, ${text}, extra`,
      `vector.v1, vector.v1`,
      `vector.v1, bearer.${text.slice(4)}`,
      `vector.v1, ${text} space`,
    ]) {
      const { response, socket } = await connect(header)
      expect({ header, status: response.status, socket }).toEqual({ header, status: 400, socket: undefined })
    }
  })

  test("a computer and a phone of one account share an object; another account gets its own", async () => {
    const { connect, ticket, namespace } = await setup()
    await connect(`vector.v1, ${await ticket({ role: "computer" })}`)
    await connect(`vector.v1, ${await ticket({ role: "phone" })}`)
    await connect(`vector.v1, ${await ticket({ sub: "acct_fixture_0002" })}`)
    const names = namespace.calls.map((entry) => entry.name)
    expect(names[0]).toBe(names[1]!)
    expect(names[2]).not.toBe(names[0]!)
    expect(names[2]).toBe((await accountHandle(ACCOUNT_KEY, "acct_fixture_0002"))!)
  })

  test("invalid, expired or foreign tickets are refused before any object is reached", async () => {
    const { connect, ticket, namespace, clock } = await setup()
    const other = await ticketKeys()
    const iat = Math.floor(NOW / 1000)
    const foreign = await signTicket(
      {
        v: 1,
        aud: "vector-relay",
        sub: ACCOUNT,
        role: "phone",
        dev: deviceId(),
        computers: 3,
        rank: 2,
        epoch: EPOCH,
        periodEnd: NOW + 1,
        iat,
        exp: iat + 300,
        jti: token(),
      },
      other.privateKey,
    )
    const expiring = await ticket()
    clock.now += 300_000
    for (const text of [foreign, expiring]) {
      const { response, socket } = await connect(`vector.v1, ${text}`)
      expect(response.status).toBe(401)
      expect(socket).toBeUndefined()
      expect(await response.json()).toEqual({ error: { code: "RELAY_TICKET_INVALID" } })
    }
    expect(namespace.calls).toHaveLength(0)
  })

  test("a ticket opens one connection", async () => {
    const { connect, ticket } = await setup()
    const text = await ticket()
    expect((await connect(`vector.v1, ${text}`)).response.status).toBe(101)
    const second = await connect(`vector.v1, ${text}`)
    expect(second.response.status).toBe(401)
    expect(await second.response.json()).toEqual({ error: { code: "RELAY_TICKET_USED" } })
  })

  test("the kill flag closes every new connection with RELAY_OFF; an unreadable flag counts as set", async () => {
    const { connect, ticket, kv, namespace } = await setup()
    kv.values.set("kill", "1")
    const killed = await connect(`vector.v1, ${await ticket()}`)
    expect(killed.response.status).toBe(101)
    expect(killed.socket?.closed).toEqual({ code: CLOSE.RELAY_OFF, reason: "RELAY_OFF" })
    kv.values.delete("kill")
    kv.failing = true
    expect((await connect(`vector.v1, ${await ticket()}`)).socket?.closed?.code).toBe(CLOSE.RELAY_OFF)
    expect(namespace.calls).toHaveLength(0)
    kv.failing = false
    expect((await connect(`vector.v1, ${await ticket()}`)).socket?.closed).toBeUndefined()
  })

  test("without its keys the relay is unavailable", async () => {
    for (const overrides of [{ TICKET_PUBLIC_KEYS: "" }, { TICKET_PUBLIC_KEYS: "nope" }, { ACCOUNT_KEY: "short" }]) {
      const { connect, ticket } = await setup(overrides)
      expect((await connect(`vector.v1, ${await ticket()}`)).response.status).toBe(503)
    }
  })

  test("only GET upgrades; health answers; anything else is not found", async () => {
    const { connect, ticket, env, runtime } = await setup()
    expect((await connect(`vector.v1, ${await ticket()}`, { method: "POST" })).response.status).toBe(405)
    expect((await connect(`vector.v1, ${await ticket()}`, { headers: { upgrade: "h2c" } })).response.status).toBe(426)
    const health = await handleRequest(new Request("https://relay.example/health"), env, runtime)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    for (const path of ["/", "/v1/connect/extra", "/internal", "/v2/connect"])
      expect((await handleRequest(new Request(`https://relay.example${path}`), env, runtime)).status).toBe(404)
  })

  test("heartbeats are answered by the runtime without waking the object", async () => {
    const { connect, ticket, namespace } = await setup()
    await connect(`vector.v1, ${await ticket()}`)
    const object = [...namespace.objects.values()][0]!
    expect(object.state.autoResponse).toEqual({ request: "ping", response: "pong" })
  })
})
