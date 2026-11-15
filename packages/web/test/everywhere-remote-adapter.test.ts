import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { includes } from "../../../api/_lib/codium-entitlements"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../../../api/_lib/codium-snapshot"
import { disabledSetKey, switchKey } from "../../../api/_lib/codium-switches"
import { codiumAccountAuthority } from "../../../api/_lib/everywhere/adapters/account"
import { createRemotePorts } from "../../../api/_lib/everywhere/adapters/remote"
import { ENV_NAMES, readConfig, type EverywhereConfig } from "../../../api/_lib/everywhere/config"
import { issueLinkCode, recordInstall, redeemLinkCode, setMappingByWord } from "../../../api/_lib/everywhere/identity"
import { claimJob, readJob } from "../../../api/_lib/everywhere/jobs"
import { offerPublicKey, offerVerifyKey, signOffer, verifyOffer } from "../../../api/_lib/everywhere/offer"
import { routeJob } from "../../../api/_lib/everywhere/router"
import { productionPorts } from "../../../api/_lib/everywhere/runtime"
import { relayPresence, relaySuspend } from "../../../api/_lib/remote-relay"
import { fromUtf8 } from "../../../packages/relay/src/bytes"
import { handleRequest } from "../../../packages/relay/src/index"
import { CLOSE, DEVICE_BYTES, FRAME, decodeFrame } from "../../../packages/relay/src/protocol"
import { Harness, INTERNAL_SECRET, type FakeSocket } from "../../../packages/relay/test/fakes"
import { ENTITLEMENTS } from "../../../packages/schema/src/codium-entitlements"
import { PLANS, type PlanId } from "../../../packages/schema/src/codium-plan"
import { TIMING, createJobId } from "../../../packages/schema/src/everywhere"
import { FAKE_KV_URL, codiumFakes, codiumTestEnvironment } from "./fixture/codium-fakes"
import { everywhereEnv } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { routerFixture } from "./lib/everywhere-router"

installFetchGuard()

/*
 * VE-20 (EV-09): the relay adapter. The fake relay is the relay Worker itself (packages/relay, on its own in-memory
 * runtime fakes) served on 127.0.0.1, so every call the adapter makes is signed by the API's code, checked by the
 * relay's code and answered by its Durable Object. Codium's store is the Codium fakes' store. Nothing leaves loopback:
 * the fetch guard fails any test that tries.
 */

type Mode = "normal" | "answer-502" | "answer-text"
const DAY = 86_400_000
const TICKET_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64url")
const OFFER_KEY = { kid: "test-offer-key", key: generateKeyPairSync("ed25519").privateKey }
const OFFER_ENV = {
  [ENV_NAMES.offerSigningKey]: OFFER_KEY.key.export({ format: "pem", type: "pkcs8" }).toString(),
  [ENV_NAMES.offerKeyId]: OFFER_KEY.kid,
}

let h = await Harness.create()
let mode: Mode = "normal"
let fakes = codiumFakes()
let restore = () => {}
/** The internal actions that reached the relay, in order. */
const actions: string[] = []
/** Codium store keys whose read fails, as a store outage for one key would. */
const unreadable = new Set<string>()

const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/internal/v1/")) actions.push(path.slice("/internal/v1/".length))
    if (mode === "answer-502") return new Response("bad gateway", { status: 502 })
    if (mode === "answer-text") return new Response("not json", { status: 200 })
    return handleRequest(request, h.env, h.runtime)
  },
})
afterAll(() => relay.stop(true))

beforeEach(async () => {
  h = await Harness.create()
  mode = "normal"
  actions.length = 0
  unreadable.clear()
  fakes = codiumFakes({ now: h.clock.now })
  restore = codiumTestEnvironment({
    VECTOR_REMOTE_ENABLED: "true",
    VECTOR_REMOTE_TICKET_SIGNING_KEY: TICKET_KEY,
    VECTOR_REMOTE_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    VECTOR_HOSTED_INTERNAL_SECRET: INTERNAL_SECRET,
    CODIUM_LISTED_PERKS: undefined,
    NODE_ENV: "test",
  })
})
afterEach(() => restore())

/**
 * A new identity per call: Codium keeps its switch cache per fetcher for 30 s, so a test that changes a switch reads it
 * through a new fetcher. Loopback goes to the guarded global fetch (the relay); everything else to the Codium fakes.
 */
function fetcher(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "127.0.0.1") return fetch(input, init)
    if (url.origin === FAKE_KV_URL && unreadable.size > 0) {
      const command: unknown = JSON.parse(String(init?.body))
      if (Array.isArray(command) && unreadable.has(String(command[1])))
        return new Response("unavailable", { status: 503 })
    }
    return fakes.fetcher(input, init)
  }) as typeof fetch
}

function config(env: Record<string, string> = {}) {
  return readConfig({ ...everywhereEnv(), ...env })
}

function ports(options: { config?: EverywhereConfig; wired?: boolean; fetcher?: typeof fetch } = {}) {
  return createRemotePorts({
    config: options.config ?? config(),
    fetcher: options.fetcher ?? fetcher(),
    now: () => h.clock.now,
    wired: options.wired,
  })
}

const REASONS: Partial<Record<SnapshotFacts["state"], SnapshotFacts["reason"]>> = {
  paused: "payment_failed",
  frozen: "disputed",
  ended: "canceled",
}

function snapshotFor(
  account: string,
  plan: PlanId | null,
  state: SnapshotFacts["state"] = "active",
  periodEnd?: number,
) {
  const reason = REASONS[state]
  return buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_fixture${account.slice(-4)}` } : {}),
      periodStart: h.clock.now - DAY,
      periodEnd: periodEnd ?? h.clock.now + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    undefined,
    h.clock.now,
  )
}

function seed(account: string, plan: PlanId | null = "vector-10", state: SnapshotFacts["state"] = "active") {
  fakes.store.set(snapshotKey(account), JSON.stringify(snapshotFor(account, plan, state)))
}

function setRemoteSwitch(value: string) {
  fakes.store.set(switchKey("remote"), value)
}

/**
 * A relay that refuses the connection, as a closed port does (Bun's own error), without depending on an ephemeral
 * port staying free. Nothing reaches the relay, so it shows nothing in `actions`.
 */
function refusing(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "127.0.0.1")
      throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
        code: "ConnectionRefused",
      })
    return fakes.fetcher(input, init)
  }) as typeof fetch
}

const offline = (reason?: "remote-off" | "not-configured" | "not-in-plan" | "unreachable") => ({
  online: false,
  computers: 0,
  ...(reason ? { reason } : {}),
})

function signed(account: string) {
  return signOffer(OFFER_KEY, { account, jid: createJobId(h.clock.now), now: h.clock.now }).offer
}

function offerFrames(socket: FakeSocket) {
  return socket.frames().map((frame) => {
    const decoded = decodeFrame(frame)
    return { kind: decoded?.kind, device: decoded?.device, text: decoded ? fromUtf8(decoded.ciphertext) : undefined }
  })
}

describe("presence (VE-20)", () => {
  test("online only with Remote on, configured and in the plan, one relay call each, counting every computer", async () => {
    const account = randomUUID()
    seed(account)
    const adapter = ports()
    // No computer connected: offline with no reason, so the router may still queue.
    expect(await adapter.presence(account)).toEqual(offline())
    await h.computer({ sub: account })
    expect(await adapter.presence(account)).toEqual({ online: true, computers: 1 })
    await h.computer({ sub: account })
    expect(await adapter.presence(account)).toEqual({ online: true, computers: 2 })
    expect(actions).toEqual(["presence", "presence", "presence"])
  })

  test("the remote switch off is offline even while the relay says a computer is online (E10)", async () => {
    const account = randomUUID()
    seed(account)
    await h.computer({ sub: account })
    setRemoteSwitch(
      JSON.stringify({ value: "off", changedAt: h.clock.now, generation: "g-off", offSince: h.clock.now }),
    )
    // The relay itself still reports the computer: presence there ignores the switch.
    expect((await relayPresence(account, fetcher(), h.clock.now)).online).toBe(true)
    expect(actions).toEqual(["presence"])
    expect(await ports().presence(account)).toEqual(offline("remote-off"))
    // A corrupt record and a store that cannot be read are `stop` too, each read through a new fetcher.
    setRemoteSwitch("garbage")
    expect(await ports().presence(account)).toEqual(offline("remote-off"))
    setRemoteSwitch("on")
    fakes.store.down = true
    expect(await ports().presence(account)).toEqual(offline("remote-off"))
    expect(actions).toEqual(["presence"])
    fakes.store.down = false
    expect(await ports().presence(account)).toEqual({ online: true, computers: 1 })
  })

  test("Remote not configured is offline with no relay call, and an offer goes nowhere", async () => {
    const account = randomUUID()
    seed(account)
    await h.computer({ sub: account })
    for (const name of [
      "VECTOR_REMOTE_ENABLED",
      "VECTOR_REMOTE_TICKET_SIGNING_KEY",
      "VECTOR_REMOTE_RELAY_URL",
      "VECTOR_HOSTED_INTERNAL_SECRET",
    ]) {
      const value = process.env[name]
      delete process.env[name]
      const adapter = ports()
      expect(await adapter.presence(account)).toEqual(offline("not-configured"))
      expect(await adapter.offer(account, signed(account))).toBe("unavailable")
      process.env[name] = value
    }
    expect(actions).toEqual([])
    expect(h.state.entries.every((entry) => (entry.socket as FakeSocket).frames().length === 0)).toBe(true)
  })

  test("not in the plan is offline before the relay is asked, and grants no Remote perk", async () => {
    const grace = 120 * 60_000
    const cases: Array<{ name: string; seed: (account: string) => void }> = [
      { name: "no snapshot", seed: () => undefined },
      { name: "no plan", seed: (account) => seed(account, null, "none") },
      { name: "paused", seed: (account) => seed(account, "vector-10", "paused") },
      { name: "frozen", seed: (account) => seed(account, "vector-50", "frozen") },
      { name: "ended", seed: (account) => seed(account, "vector-10", "ended") },
      {
        name: "renewing past its grace",
        seed: (account) =>
          fakes.store.set(
            snapshotKey(account),
            JSON.stringify(snapshotFor(account, "vector-10", "renewing", h.clock.now - grace - 60_000)),
          ),
      },
      {
        name: "active, its period over past the renewal grace (not reconciled here)",
        seed: (account) =>
          fakes.store.set(
            snapshotKey(account),
            JSON.stringify(snapshotFor(account, "vector-10", "active", h.clock.now - grace - 60_000)),
          ),
      },
      {
        name: "stored for another account",
        seed: (account) =>
          fakes.store.set(snapshotKey(account), JSON.stringify(snapshotFor(randomUUID(), "vector-200"))),
      },
      {
        name: "written in the other Stripe mode",
        seed: (account) =>
          fakes.store.set(
            snapshotKey(account),
            JSON.stringify({ ...snapshotFor(account, "vector-10"), livemode: true }),
          ),
      },
      {
        name: "caps without Remote",
        seed: (account) => {
          const snapshot = snapshotFor(account, "vector-10")
          fakes.store.set(
            snapshotKey(account),
            JSON.stringify({ ...snapshot, caps: { ...snapshot.caps, remote: undefined } }),
          )
        },
      },
      {
        name: "caps with no Remote computers",
        seed: (account) => {
          const snapshot = snapshotFor(account, "vector-10")
          fakes.store.set(
            snapshotKey(account),
            JSON.stringify({ ...snapshot, caps: { ...snapshot.caps, remote: { computers: 0 } } }),
          )
        },
      },
      {
        name: "the snapshot unreadable",
        seed: (account) => {
          seed(account)
          unreadable.add(snapshotKey(account))
        },
      },
    ]
    for (const entry of cases) {
      const account = randomUUID()
      entry.seed(account)
      await h.computer({ sub: account })
      const adapter = ports({ wired: true })
      expect({ name: entry.name, presence: await adapter.presence(account) }).toEqual({
        name: entry.name,
        presence: offline("not-in-plan"),
      })
      expect({ name: entry.name, remote: await adapter.perk(account, "remote") }).toEqual({
        name: entry.name,
        remote: false,
      })
    }
    expect(actions).toEqual([])
    // A non-UUID account is never looked up at all.
    const before = fakes.store.commands.length
    expect(await ports().perk("not-an-account", "remote")).toBe(false)
    expect(fakes.store.commands.length).toBe(before)
  })

  test("a plan in its renewal grace is still in the plan, as Codium's read rules say", async () => {
    for (const state of ["renewing", "active"] as const) {
      const account = randomUUID()
      fakes.store.set(
        snapshotKey(account),
        JSON.stringify(snapshotFor(account, "vector-10", state, h.clock.now - 60_000)),
      )
      await h.computer({ sub: account })
      expect(await ports().presence(account)).toEqual({ online: true, computers: 1 })
      expect(await ports().perk(account, "remote")).toBe(true)
    }
  })

  test("every paid plan has the Remote perk exactly when Codium's own check says so", async () => {
    for (const plan of PLANS.map((entry) => entry.id)) {
      const account = randomUUID()
      seed(account, plan)
      expect({ plan, remote: await ports().perk(account, "remote") }).toEqual({
        plan,
        remote: includes(ENTITLEMENTS[plan], "remote"),
      })
      expect(includes(ENTITLEMENTS[plan], "remote")).toBe(true)
    }
  })

  test("an unreachable relay is offline: an error answer, a malformed one, a refused connection, a timeout or a refusal", async () => {
    const account = randomUUID()
    seed(account)
    await h.computer({ sub: account })
    mode = "answer-502"
    expect(await ports().presence(account)).toEqual(offline("unreachable"))
    mode = "answer-text"
    expect(await ports().presence(account)).toEqual(offline("unreachable"))
    mode = "normal"
    expect(actions).toEqual(["presence", "presence"])

    expect(await ports({ fetcher: refusing() }).presence(account)).toEqual(offline("unreachable"))

    // What AbortSignal.timeout(10 s) rejects with, without waiting 10 s.
    const timingOut = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "127.0.0.1") throw new DOMException("The operation timed out.", "TimeoutError")
      return fakes.fetcher(input, init)
    }) as typeof fetch
    expect(await ports({ fetcher: timingOut }).presence(account)).toEqual(offline("unreachable"))

    // The relay refuses a call signed with another secret (401).
    process.env.VECTOR_HOSTED_INTERNAL_SECRET = "another-internal-fixture-secret-".padEnd(48, "x")
    expect(await ports().presence(account)).toEqual(offline("unreachable"))
    expect(actions).toEqual(["presence", "presence", "presence"])
    process.env.VECTOR_HOSTED_INTERNAL_SECRET = INTERNAL_SECRET
    expect(await ports().presence(account)).toEqual({ online: true, computers: 1 })
  })

  test("the relay's kill flag: no computer online and no offer sent", async () => {
    const account = randomUUID()
    seed(account)
    const computer = await h.computer({ sub: account })
    h.kv.values.set("kill", "1")
    const adapter = ports()
    expect(await adapter.presence(account)).toEqual(offline())
    expect(await adapter.offer(account, signed(account))).toBe("unavailable")
    expect(computer.socket.frames()).toHaveLength(0)
    expect(actions).toEqual(["presence", "job-offer"])
  })

  test("a suspended account, through the API's own suspend call: no computer online and no offer sent (E10)", async () => {
    const account = randomUUID()
    seed(account)
    const computer = await h.computer({ sub: account })
    expect(
      await relaySuspend(account, { suspended: true, reason: "owner", at: h.clock.now }, fetcher(), h.clock.now),
    ).toEqual({ applied: true, suspended: true, closed: 1 })
    expect(computer.socket.closed?.code).toBe(CLOSE.REMOTE_PAUSED)
    const adapter = ports()
    expect(await adapter.presence(account)).toEqual(offline())
    expect(await adapter.offer(account, signed(account))).toBe("unavailable")
    expect(computer.socket.frames()).toHaveLength(0)
    expect(actions).toEqual(["suspend", "presence", "job-offer"])
  })

  test("a stored suspension a live computer still meets: offline, with no offer sent (E10, R-C4)", async () => {
    const account = randomUUID()
    seed(account)
    const computer = await h.computer({ sub: account })
    // The relay's `suspended` row written directly, so the computer's socket is still open when presence is asked.
    h.state.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('suspended', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify({ reason: "owner", at: h.clock.now }),
    )
    expect(computer.socket.closed).toBeUndefined()
    const adapter = ports()
    expect(await adapter.presence(account)).toEqual(offline())
    expect(await adapter.offer(account, signed(account))).toBe("unavailable")
    expect(computer.socket.frames()).toHaveLength(0)
    expect(actions).toEqual(["presence", "job-offer"])
  })
})

describe("offers (R-C1)", () => {
  test("one offer is one relay call, and reaches every computer once, byte for byte", async () => {
    const account = randomUUID()
    const first = await h.computer({ sub: account })
    const second = await h.computer({ sub: account })
    const phone = await h.phone({ sub: account })
    const offer = signed(account)
    expect(await ports().offer(account, offer)).toBe("sent")
    expect(actions).toEqual(["job-offer"])
    for (const computer of [first, second])
      expect(offerFrames(computer.socket)).toEqual([
        { kind: FRAME.JOB_OFFER, device: new Uint8Array(DEVICE_BYTES), text: offer },
      ])
    expect(phone.socket.frames()).toHaveLength(0)
  })

  test("delivered to no computer is unavailable, one call each", async () => {
    const account = randomUUID()
    // The relay has never seen this account.
    expect(await ports().offer(account, signed(account))).toBe("unavailable")
    const computer = await h.computer({ sub: account })
    await h.disconnect(computer.socket)
    expect(await ports().offer(account, signed(account))).toBe("unavailable")
    expect(actions).toEqual(["job-offer", "job-offer"])
  })

  test("the relay's hourly cap (429), a malformed offer (400) and a refused connection are unavailable after one call", async () => {
    const account = randomUUID()
    const computer = await h.computer({ sub: account })
    // Thirty offers accepted within the hour, as the relay keeps them: their times only.
    const times = Array.from({ length: 30 }, (_, index) => h.clock.now - index * 1_000)
    h.state.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('offers', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      JSON.stringify(times),
    )
    expect(await ports().offer(account, signed(account))).toBe("unavailable")
    expect(actions).toEqual(["job-offer"])
    h.state.sql.exec("DELETE FROM meta WHERE k = 'offers'")
    expect(await ports().offer(account, "vef1.not an offer")).toBe("unavailable")
    expect(actions).toEqual(["job-offer", "job-offer"])
    expect(await ports({ fetcher: refusing() }).offer(account, signed(account))).toBe("unavailable")
    expect(computer.socket.frames()).toHaveLength(0)
    expect(actions).toEqual(["job-offer", "job-offer"])
  })
})

describe("the everywhere perk: the allowlist, and the plan only once it may join", () => {
  test("an allowlisted account has it with no store read; nothing else does while the plan's half is closed", async () => {
    const listed = randomUUID()
    const paid = randomUUID()
    seed(paid, "vector-200")
    const settings = config({ [ENV_NAMES.allowAccounts]: listed.toUpperCase() })
    const before = fakes.store.commands.length
    // Today: the laptop route is not wired (LAPTOP_ROUTE_WIRED), whatever the owner lists.
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    expect(await ports({ config: settings }).perk(listed, "everywhere")).toBe(true)
    expect(await ports({ config: settings }).perk(paid, "everywhere")).toBe(false)
    // Wired, but the owner has not listed the perk, or model plans are off.
    process.env.CODIUM_LISTED_PERKS = "remote"
    expect(await ports({ config: settings, wired: true }).perk(paid, "everywhere")).toBe(false)
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await ports({ config: settings, wired: true }).perk(paid, "everywhere")).toBe(false)
    expect(fakes.store.commands.length).toBe(before)
    // The Remote perk is the plan's either way.
    expect(await ports({ config: settings }).perk(paid, "remote")).toBe(true)
    expect(await ports({ config: settings }).perk(listed, "remote")).toBe(false)
  })

  test("once wired and listed by the owner, a paid plan with Remote joins the allowlist", async () => {
    process.env.CODIUM_LISTED_PERKS = "remote, everywhere"
    const settings = config()
    const paid = randomUUID()
    const frozen = randomUUID()
    const none = randomUUID()
    seed(paid, "vector-10")
    seed(frozen, "vector-50", "frozen")
    seed(none, null, "none")
    const adapter = ports({ config: settings, wired: true })
    expect(await adapter.perk(paid, "everywhere")).toBe(true)
    expect(await adapter.perk(frozen, "everywhere")).toBe(false)
    expect(await adapter.perk(none, "everywhere")).toBe(false)
    expect(await adapter.perk(randomUUID(), "everywhere")).toBe(false)
    const before = fakes.store.commands.length
    expect(await ports({ config: settings, wired: true }).perk("not-an-account", "everywhere")).toBe(false)
    expect(fakes.store.commands.length).toBe(before)
  })

  test("the owner's Codium listing controls take the plan's half away again: `perks-off` and the `codium` switch", async () => {
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    const listed = randomUUID()
    const paid = randomUUID()
    seed(paid, "vector-10")
    const settings = config({ [ENV_NAMES.allowAccounts]: listed })
    // Each check through new ports, so Codium's 30-second cache per fetcher never answers for the store.
    const everywhere = (account: string) => ports({ config: settings, wired: true }).perk(account, "everywhere")
    expect(await everywhere(paid)).toBe(true)
    fakes.store.command(["SADD", disabledSetKey("perks-off"), "everywhere"])
    expect(await everywhere(paid)).toBe(false)
    // Another perk in the set hides nothing here.
    fakes.store.command(["SREM", disabledSetKey("perks-off"), "everywhere"])
    fakes.store.command(["SADD", disabledSetKey("perks-off"), "vault"])
    expect(await everywhere(paid)).toBe(true)
    fakes.store.set(
      switchKey("codium"),
      JSON.stringify({ value: "off", changedAt: h.clock.now, generation: "g-off", offSince: h.clock.now }),
    )
    expect(await everywhere(paid)).toBe(false)
    fakes.store.set(switchKey("codium"), JSON.stringify({ value: "on", changedAt: h.clock.now, generation: "g-on" }))
    expect(await everywhere(paid)).toBe(true)
    // Either read failing is false: the listing fails closed, as listedPerks does.
    unreadable.add(disabledSetKey("perks-off"))
    expect(await everywhere(paid)).toBe(false)
    unreadable.clear()
    unreadable.add(switchKey("codium"))
    expect(await everywhere(paid)).toBe(false)
    unreadable.clear()
    // None of this touches the allowlist or the Remote perk, which follow neither control.
    fakes.store.command(["SADD", disabledSetKey("perks-off"), "everywhere"])
    expect(await everywhere(listed)).toBe(true)
    expect(await ports({ config: settings, wired: true }).perk(paid, "remote")).toBe(true)
  })

  test("the Slack repo word's sponsor check follows the same rule", async () => {
    const f = routerFixture()
    const ctx = f.context()
    const installation = "slack:T0123ABCD"
    const person = { bot: false, external: false, guest: false }
    const listed = randomUUID()
    const paid = randomUUID()
    seed(paid, "vector-100")
    const install = await recordInstall(ctx, {
      account: randomUUID(),
      event: "install",
      grant: { installation, scopes: ["chat:write"], installer: { admin: false } },
    })
    expect(install.ok).toBe(true)
    const link = async (account: string, userId: string) => {
      const code = (await issueLinkCode(ctx, { account, platform: "slack" })).code
      expect((await redeemLinkCode(ctx, { code, installation, userId, place: "private", actor: person })).ok).toBe(true)
    }
    await link(listed, "U0LISTED1")
    await link(paid, "U0PAIDAA1")
    const word = (userId: string, place: string, wired: boolean) => {
      const adapter = ports({ config: config({ [ENV_NAMES.allowAccounts]: listed }), wired })
      return setMappingByWord(ctx, {
        installation,
        place,
        userId,
        actor: person,
        repository: { id: 41, fullName: "acme/tool" },
        maySponsor: (account) => adapter.perk(account, "everywhere"),
      })
    }
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    expect((await word("U0LISTED1", "C0LISTED", false)).ok).toBe(true)
    expect(await word("U0PAIDAA1", "C0PAIDAA", false)).toEqual({ ok: false, code: "not-allowed" })
    expect((await word("U0PAIDAA1", "C0PAIDAA", true)).ok).toBe(true)
  })
})

describe("productionPorts", () => {
  test("without the flag and the offer key it is safePorts with the deletion key, and makes no fetch", async () => {
    const listed = randomUUID()
    const paid = randomUUID()
    seed(paid, "vector-200")
    await h.computer({ sub: paid })
    const allow = { [ENV_NAMES.allowAccounts]: listed }
    const variants = [
      { name: "flag off", env: { ...allow, [ENV_NAMES.enabled]: "false" }, enabled: false, offer: false },
      { name: "flag on, no offer key", env: allow, enabled: true, offer: false },
      {
        name: "offer key, flag off",
        env: { ...allow, ...OFFER_ENV, [ENV_NAMES.enabled]: "false" },
        enabled: false,
        offer: true,
      },
    ]
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    for (const variant of variants) {
      const settings = config(variant.env)
      expect({ name: variant.name, enabled: settings.enabled, offer: settings.offer !== undefined }).toEqual({
        name: variant.name,
        enabled: variant.enabled,
        offer: variant.offer,
      })
      // The default fetcher is the guarded global one: a Codium store read would trip the guard, and a relay call
      // would show in `actions`.
      const production = productionPorts(settings)
      expect(production.accountAuthority).toBe(codiumAccountAuthority)
      expect(await production.presence(paid)).toEqual(offline("not-configured"))
      expect(await production.offer(paid, signed(paid))).toBe("unavailable")
      expect(await production.perk(paid, "remote")).toBe(false)
      expect(await production.perk(paid, "everywhere")).toBe(false)
      expect(await production.perk(listed, "everywhere")).toBe(true)
    }
    expect(actions).toEqual([])
    expect(fakes.store.commands).toEqual([])
  })

  test("with the flag and the offer key it uses the relay adapter, and the allowlist stays the everywhere grant", async () => {
    // productionPorts signs relay calls on the real clock, so the relay's clock follows it here.
    h.clock.now = Date.now()
    const listed = randomUUID()
    const paid = randomUUID()
    seed(paid, "vector-10")
    await h.computer({ sub: paid })
    process.env.CODIUM_LISTED_PERKS = "remote,everywhere"
    const production = productionPorts(config({ ...OFFER_ENV, [ENV_NAMES.allowAccounts]: listed }), fetcher())
    expect(production.accountAuthority).toBe(codiumAccountAuthority)
    expect(await production.presence(paid)).toEqual({ online: true, computers: 1 })
    expect(await production.perk(paid, "remote")).toBe(true)
    expect(await production.perk(listed, "everywhere")).toBe(true)
    expect(await production.perk(paid, "everywhere")).toBe(false)
    expect(await production.offer(paid, signed(paid))).toBe("sent")
    expect(actions).toEqual(["presence", "job-offer"])
  })
})

describe("routing through the relay adapter", () => {
  test("an online computer gets the offer and claims it within the 20-second window", async () => {
    const f = routerFixture()
    seed(f.account, "vector-50")
    const computer = await h.computer({ sub: f.account })
    const remote = createRemotePorts({
      config: config({ [ENV_NAMES.allowAccounts]: f.account }),
      fetcher: fetcher(),
      now: () => h.clock.now,
    })
    f.ports.presence = remote.presence
    f.ports.offer = remote.offer
    f.ports.perk = remote.perk
    const used = new Set<string>()
    const slept: number[] = []
    const sleep = async (ms: number) => {
      if (!slept.length) {
        // The computer's side: the frame the relay sent, decoded and verified against the pinned key, then claimed.
        const frames = offerFrames(computer.socket)
        expect(frames.map((frame) => ({ kind: frame.kind, device: frame.device }))).toEqual([
          { kind: FRAME.JOB_OFFER, device: new Uint8Array(DEVICE_BYTES) },
        ])
        const key = f.context().offer
        if (!key) throw new Error("The router fixture signs offers.")
        const pinned = offerPublicKey(key)
        const verdict = await verifyOffer(frames[0]!.text, {
          keys: new Map([[pinned.kid, offerVerifyKey(pinned.publicKey)]]),
          account: f.account,
          now: f.fake.clock.now,
          useJti: async (jti) => {
            if (used.has(jti)) return false
            used.add(jti)
            return true
          },
        })
        if (!verdict.ok) throw new Error(`The offer was refused: ${verdict.reason}`)
        expect(
          (await claimJob(f.context(), { account: f.account, jid: verdict.claims.jid, device: f.computer })).ok,
        ).toBe(true)
      }
      slept.push(ms)
      f.fake.clock.advance(ms)
    }
    const job = await f.create()
    const start = f.fake.clock.now
    expect(await routeJob({ ...f.routing, sleep }, job, await f.facts())).toEqual({ action: "laptop" })
    expect((await readJob(f.store, job.jid))?.state).toBe("claimed")
    // Seen on the first poll after one 2-second sleep, well inside the window.
    expect(slept).toEqual([2_000])
    expect(f.fake.clock.now - start).toBe(2_000)
    expect(f.fake.clock.now - start).toBeLessThan(TIMING.offerWindowMs)
    expect(f.calls.filter((call) => call.kind === "progress").map((call) => call.value)).toEqual(["finding", "laptop"])
    expect(actions).toEqual(["presence", "job-offer"])
  })
})
