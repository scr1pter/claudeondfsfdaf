import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { Hosted } from "../packages/schema/src/hosted"
import { codiumKey } from "../api/_lib/codium-keys"
import { switchKey } from "../api/_lib/codium-switches"
import {
  handleHostedComputers,
  handleHostedFlags,
  handleHostedHeartbeat,
  handleHostedSessionAction,
  handleHostedSessions,
  handleHostedStatus,
  type SessionAction,
} from "../api/_lib/hosted-api"
import { hostedAccount, hostedRunningKey, readLine } from "../api/_lib/hosted-ledger"
import { bootArguments, computerName, hostedComputerKey } from "../api/_lib/hosted-provider"
import { vercelProvider, type VercelSandboxSdk } from "../api/_lib/hosted-provider-vercel"
import {
  HOSTED_SESSION_SCRIPTS,
  assertHostedSessionLive,
  hostedJobKey,
  hostedLeaseKey,
  hostedViewerKey,
  parseHeartbeat,
  readBeat,
  readSessionRecord,
  verifyHostedRunToken,
} from "../api/_lib/hosted-sessions"
import { checkViewerToken, readHostedRunToken } from "../api/_lib/hosted-tokens"
import { createRunVerifierRegistry, requireModelPlanCaller } from "../api/_lib/model-plan-caller"
import { perkServices } from "../api/_lib/codium-perks"
import { ledgerBackend, type LedgerBackend } from "./hosted-fixture"
import {
  ACCOUNT_ID,
  MINUTE,
  R2_HOST,
  VIEWER_PUBLIC_X,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  type Answer,
  type HostedWorld,
} from "./hosted-sessions-fixture"

// WP A53: the cloud computer's sessions API. Every service is a fake (the Codium store and Stripe, the ledger's
// Supabase function, the provider, the media bucket, website sessions); nothing real is reached. The S1 hosted cases
// (a patched client asking for what its plan does not include) are in "S1: the plan decides".

let ledger: LedgerBackend
let restore = () => {}
beforeAll(async () => {
  ledger = await ledgerBackend()
})
afterAll(async () => {
  await ledger.close()
})
beforeEach(async () => {
  restore = hostedSessionEnvironment()
  await ledger.reset()
})
afterEach(() => restore())

const PROMPT = "Update the dependencies, run the tests and open a pull request."

function start(w: HostedWorld, body: Record<string, unknown> = {}, authorization = w.desktopToken()) {
  return invoke((request, response) => handleHostedSessions(request, response, w.options), {
    method: "POST",
    authorization,
    body: { size: "standard", jobMinutes: 60, prompt: PROMPT, ...body },
  })
}

function action(w: HostedWorld, id: string, kind: SessionAction, body: Record<string, unknown> = {}) {
  return invoke((request, response) => handleHostedSessionAction(request, response, kind, w.options), {
    method: "POST",
    authorization: w.desktopToken(),
    body,
    query: { id },
  })
}

function beat(w: HostedWorld, id: string, body: Record<string, unknown>, options: { token?: string; headers?: Record<string, string> } = {}) {
  const token = options.token ?? w.provider.token(computerName(ACCOUNT_ID, 1))!
  return invoke((request, response) => handleHostedHeartbeat(request, response, w.options), {
    method: "POST",
    authorization: token,
    body,
    query: { id },
    ...(options.headers ? { headers: options.headers } : {}),
  })
}

async function started(w: HostedWorld, body: Record<string, unknown> = {}) {
  const answer = await start(w, body)
  expect(answer.status).toBe(201)
  return answer.body.session as Hosted.SessionView
}

/** No amount anywhere in an answer (P1): no currency, no money words, and numbers only as counts, shares or times. */
function expectNoAmounts(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toMatch(/\$|usd|price|credit|cents|micro|cost|charge/i)
}

describe("starting a session", () => {
  test("holds the first block, starts the computer with its run token, boots it and answers the session", async () => {
    const w = await hostedWorld(ledger)
    const answer = await start(w)
    expect(answer.status).toBe(201)
    const session = answer.body.session as Hosted.SessionView
    expect(session).toMatchObject({ state: "running", computer: 1, size: "standard", source: "desktop" })
    expect(Hosted.SESSION_ID.test(session.id)).toBe(true)
    expect(session.deadline).toBe(w.fakes.clock.now + 60 * MINUTE)
    expectNoAmounts(answer.body)

    const name = computerName(ACCOUNT_ID, 1)
    expect(w.provider.calls).toEqual([`start ${name}`, `boot ${name}`])
    expect(w.provider.boots).toEqual([{ name, runHost: Hosted.RUN_API_HOST, session: session.id }])
    // The one credential: a run token for this session, added by the provider's proxy, valid about one block.
    const token = w.provider.token(name)!
    const claims = readHostedRunToken(token, w.fakes.clock.now)
    expect(claims).toMatchObject({ account: ACCOUNT_ID, session: session.id, source: "desktop" })
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60 * MINUTE)
    expect(claims.exp).toBe(w.fakes.clock.now + 30 * MINUTE)

    const running = w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID))
    expect(JSON.parse(running.get(session.id)!)).toMatchObject({ block: 0, size: "standard" })
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).get("1")).toStartWith(`${session.id}:`)
    expect(JSON.parse(w.fakes.store.get(hostedComputerKey(name))!)).toMatchObject({ session: session.id, computer: 1 })
    expect(JSON.parse(w.fakes.store.get(hostedJobKey(session.id))!)).toEqual({ prompt: PROMPT })
    expect(await assertHostedSessionLive(session.id, w.fetcher, w.fakes.clock.now)).toBe(true)
  })

  test("a website session starts from the phone or the site; an unmarked token cannot spend Codium", async () => {
    const w = await hostedWorld(ledger)
    const unmarked = await start(w, {}, w.desktopToken("unmarked"))
    expect(unmarked.status).toBe(401)
    expect(unmarked.body.error.code).toBe("CODIUM_SIGN_IN_REQUIRED")
    const site = await start(w, { title: "Nightly tidy" }, w.sessionToken())
    expect(site.status).toBe(201)
    expect(site.body.session).toMatchObject({ source: "desktop", title: "Nightly tidy" })
  })

  test("a provider that cannot start the computer charges nothing and frees the computer", async () => {
    const w = await hostedWorld(ledger)
    w.provider.fail.start = true
    const answer = await start(w)
    expect(answer.status).toBe(503)
    expect(answer.body.error.code).toBe("HOSTED_UNAVAILABLE")
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(0)
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
    const ids = [...w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys()]
    expect((await readSessionRecord(ids[0]!, w.fetcher))).toMatchObject({ state: "ended", reason: "failed" })
    const line = await readLine(ACCOUNT_ID, `hb-${ids[0]}-0`, w.options)
    expect(line?.units ?? 0).toBe(0)
    w.provider.fail.start = false
    expect((await start(w)).status).toBe(201)
  })

  test("a computer that started but could not boot is stopped, and what it ran is charged", async () => {
    const w = await hostedWorld(ledger)
    w.provider.fail.boot = true
    const answer = await start(w)
    expect(answer.status).toBe(503)
    const name = computerName(ACCOUNT_ID, 1)
    expect(w.provider.calls).toEqual([`start ${name}`, `boot ${name}`, `stop ${name}`])
    expect(w.provider.computers.get(name)!.status).toBe("stopped")
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
  })
})

describe("readiness", () => {
  test("computer is ready to list only with the provider, the ledger and both signing keys", () => {
    const vercel = {
      VECTOR_HOSTED_PROVIDER: "vercel",
      VECTOR_HOSTED_VERCEL_TOKEN: "fixture-token",
      VECTOR_HOSTED_VERCEL_TEAM_ID: "team_hostedfixture",
      VECTOR_HOSTED_VERCEL_PROJECT_ID: "prj_hostedfixture",
      VECTOR_HOSTED_BASE_SNAPSHOT: "snap_basefixture",
      VERCEL_HOSTED_TEAM_ID: "team_hostedfixture",
      VERCEL_SPEND_WEBHOOK_SECRET_HOSTED: "fixture-spend-secret",
      VERCEL_MAIN_TEAM_ID: "team_mainfixture",
    }
    expect(perkServices.computer!(fetch)).toBe(false)
    for (const [missing, ready] of [
      [{}, true],
      [{ VECTOR_HOSTED_BASE_SNAPSHOT: undefined }, false],
      [{ VECTOR_HOSTED_RUN_SIGNING_KEY: undefined }, false],
      [{ VECTOR_HOSTED_VIEWER_SIGNING_KEY: "not-an-ed25519-key" }, false],
      [{ SUPABASE_SERVICE_ROLE_KEY: undefined }, false],
      [{ VECTOR_HOSTED_ACCOUNT_SALT: undefined }, false],
    ] as const) {
      restore()
      restore = hostedSessionEnvironment({ ...vercel, ...missing })
      expect([missing, perkServices.computer!(fetch)]).toEqual([missing, ready])
    }
  })
})

describe("the boot step", () => {
  test("Vercel runs it as root, detached, with the run host and session only; never on a stopped or foreign computer", async () => {
    const commands: unknown[] = []
    const name = "vh-0123456789abcdef-1"
    const sandbox = {
      name,
      status: "running",
      tags: { "vector-mode": "test" },
      runCommand: async (params: unknown) => {
        commands.push(params)
        return {}
      },
    }
    const sdk = { get: async () => sandbox } as unknown as VercelSandboxSdk
    const env = {
      VECTOR_HOSTED_VERCEL_TOKEN: "fixture-token",
      VECTOR_HOSTED_VERCEL_TEAM_ID: "team_hostedfixture",
      VECTOR_HOSTED_VERCEL_PROJECT_ID: "prj_hostedfixture",
      VECTOR_HOSTED_BASE_SNAPSHOT: "snap_basefixture",
      VERCEL_HOSTED_TEAM_ID: "team_hostedfixture",
      VERCEL_SPEND_WEBHOOK_SECRET_HOSTED: "fixture-spend-secret",
    }
    const provider = vercelProvider({ env, mode: "test", sdk })
    const session = `hs_${"c".repeat(26)}`
    await provider.boot(name, { runHost: Hosted.RUN_API_HOST, session })
    expect(commands).toEqual([
      { cmd: Hosted.BOOT_COMMAND, args: ["--run-host", Hosted.RUN_API_HOST, "--session", session], sudo: true, detached: true },
    ])
    sandbox.status = "stopped"
    await expect(provider.boot(name, { runHost: Hosted.RUN_API_HOST, session })).rejects.toMatchObject({ code: "HOSTED_UNAVAILABLE" })
    sandbox.status = "running"
    sandbox.tags = { "vector-mode": "live" }
    await expect(provider.boot(name, { runHost: Hosted.RUN_API_HOST, session })).rejects.toMatchObject({ code: "HOSTED_UNAVAILABLE" })
    expect(commands).toHaveLength(1)
    expect(() => bootArguments({ runHost: "evil host; rm -rf /", session })).toThrow()
    expect(() => bootArguments({ runHost: Hosted.RUN_API_HOST, session: "hs_short" })).toThrow()
  })
})

describe("S1: the plan decides, never the client", () => {
  test("Pro has no cloud computer", async () => {
    const w = await hostedWorld(ledger)
    w.setSnapshot({ plan: "vector-50" })
    const answer = await start(w)
    expect(answer.status).toBe(403)
    expect(answer.body.error).toMatchObject({ code: "HOSTED_NOT_INCLUDED", perk: "computer", plan: "vector-100" })
    expect(w.provider.calls).toEqual([])
  })

  test("Max refuses the large size and a job longer than four hours", async () => {
    const w = await hostedWorld(ledger)
    const large = await start(w, { size: "large" })
    expect(large.status).toBe(403)
    expect(large.body.error).toMatchObject({ code: "HOSTED_NOT_INCLUDED", limit: "size", plan: "vector-200" })
    const long = await start(w, { jobMinutes: 241 })
    expect(long.status).toBe(403)
    expect(long.body.error).toMatchObject({ code: "HOSTED_NOT_INCLUDED", limit: "job-length", plan: "vector-200" })
    expect(w.provider.calls).toEqual([])
  })

  test("Max runs one computer at once; Ultra three, and the large size", async () => {
    const w = await hostedWorld(ledger)
    await started(w)
    const second = await start(w)
    expect(second.status).toBe(429)
    expect(second.body.error.code).toBe("HOSTED_BUSY")
    w.setSnapshot({ plan: "vector-200" })
    const ultra = await started(w, { size: "large" })
    expect(ultra.computer).toBe(2)
    expect((await started(w)).computer).toBe(3)
    expect((await start(w)).body.error.code).toBe("HOSTED_BUSY")
  })

  test("a paused plan, a frozen plan, the owner's switch, a hold and an unlisted perk each refuse", async () => {
    const w = await hostedWorld(ledger)
    w.setSnapshot({ state: "paused", reason: "payment_failed" })
    expect((await start(w)).body.error.code).toBe("HOSTED_PAUSED")
    w.setSnapshot({ state: "frozen", reason: "disputed" })
    expect((await start(w)).body.error.code).toBe("HOSTED_FROZEN")
    w.setSnapshot({ state: "active", reason: undefined })
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "no-new", changedAt: 1, generation: "g" }))
    w.advance(31_000) // past the switch's 30-second cache
    const drained = await start(w, {}, w.desktopToken())
    expect(drained.status).toBe(503)
    w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "on", changedAt: 2, generation: "h" }))
    w.advance(31_000)
    restore()
    restore = hostedSessionEnvironment({ VECTOR_HOSTED_ALLOW_ACCOUNTS: undefined })
    const unlisted = await start(w, {}, w.desktopToken())
    expect(unlisted.status).toBe(503)
    expect(unlisted.body.error.code).toBe("HOSTED_UNAVAILABLE")
    expect(w.provider.calls).toEqual([])
  })

  test("a run token is refused by every route the person uses (S3)", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const token = w.provider.token(computerName(ACCOUNT_ID, 1))!
    for (const answer of [
      await start(w, {}, token),
      await invoke((request, response) => handleHostedStatus(request, response, w.options), { method: "GET", authorization: token }),
      await invoke((request, response) => handleHostedSessionAction(request, response, "stop", w.options), {
        method: "POST",
        authorization: token,
        body: {},
        query: { id: session.id },
      }),
    ]) {
      expect(answer.status).toBe(401)
      expect(answer.body.error.code).toBe("SIGN_IN_REQUIRED")
    }
  })

  test("a session of another account is not found", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const other = await invoke((request, response) => handleHostedSessionAction(request, response, "stop", w.options), {
      method: "POST",
      authorization: (await import("../api/_lib/cli-token")).mintCliToken(
        { id: "0b7e5d2c-1a9f-4e3b-8c6d-5e4f3a2b1c0d", email: "other@example.invalid" },
        w.fakes.clock.now,
        "desktop",
      ).token,
      body: {},
      query: { id: session.id },
    })
    expect(other.status).toBe(404)
    expect((await readSessionRecord(session.id, w.fetcher))!.state).toBe("running")
  })
})

describe("the person's actions", () => {
  test("stop stops the computer, closes its block at that moment and frees the computer; again is harmless", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    w.advance(7 * MINUTE + 10_000)
    const stopped = await action(w, session.id, "stop")
    expect(stopped.status).toBe(200)
    expect(stopped.body.session).toMatchObject({ state: "ended", reason: "stopped" })
    const name = computerName(ACCOUNT_ID, 1)
    expect(w.provider.computers.get(name)!.status).toBe("stopped")
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(0)
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
    expect(await readLine(ACCOUNT_ID, `hb-${session.id}-0`, w.options)).toMatchObject({ kind: "block", units: 8 })
    expect(await assertHostedSessionLive(session.id, w.fetcher, w.fakes.clock.now)).toBe(false)
    const again = await action(w, session.id, "stop")
    expect(again.body.session).toMatchObject({ state: "ended", reason: "stopped" })
    expect(w.provider.calls.filter((call) => call.startsWith("stop"))).toHaveLength(1)
  })

  test("a stop the provider cannot finish leaves the session stopping, never charged twice", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    w.provider.fail.stop = true
    const answer = await action(w, session.id, "stop")
    expect(answer.body.session.state).toBe("stopping")
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(1)
  })

  test("take-over pauses the agent's model requests; control links need it; release gives control back", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const denied = await action(w, session.id, "viewer", { mode: "control" })
    expect(denied.status).toBe(409)
    expect(denied.body.error.code).toBe("HOSTED_TAKEOVER_REQUIRED")
    const taken = await action(w, session.id, "takeover")
    expect(taken.body.session).toMatchObject({ state: "takeover" })
    expect(taken.body.session.takeover.until - taken.body.session.takeover.since).toBe(Hosted.TAKEOVER_MS)
    expect(await assertHostedSessionLive(session.id, w.fetcher, w.fakes.clock.now)).toBe(false)
    const control = await action(w, session.id, "viewer", { mode: "control" })
    expect(control.status).toBe(200)
    const heartbeat = await beat(w, session.id, {})
    expect(heartbeat.body).toMatchObject({ state: "takeover", control: "person" })
    const released = await action(w, session.id, "release")
    expect(released.body.session.state).toBe("running")
    expect(await assertHostedSessionLive(session.id, w.fetcher, w.fakes.clock.now)).toBe(true)
  })

  test("a viewer link carries a single-use, five-minute Ed25519 token in its fragment, checked by the computer's key", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const answer = await action(w, session.id, "viewer", { mode: "view" })
    expect(answer.status).toBe(200)
    const url = new URL(answer.body.url)
    expect(url.origin).toBe(`https://${computerName(ACCOUNT_ID, 1)}-6080.sandbox.invalid`)
    expect(url.search).toBe("")
    const token = new URLSearchParams(url.hash.slice(1)).get(Hosted.VIEWER_FRAGMENT)!
    const claims = checkViewerToken(token, VIEWER_PUBLIC_X, {
      session: session.id,
      computer: computerName(ACCOUNT_ID, 1),
      now: w.fakes.clock.now,
    })
    expect(claims).toMatchObject({ aud: "vector-viewer", mode: "view", sid: session.id })
    expect(claims!.exp - claims!.iat).toBe(300)
    expect(answer.body.expiresAt).toBe(claims!.exp * 1000)
    expect(w.fakes.store.get(hostedViewerKey(claims!.jti))).toBe(session.id)
    expect(checkViewerToken(token, VIEWER_PUBLIC_X, { session: "hs_" + "a".repeat(26), computer: computerName(ACCOUNT_ID, 1), now: w.fakes.clock.now })).toBeUndefined()
    expect(checkViewerToken(token, VIEWER_PUBLIC_X, { session: session.id, computer: computerName(ACCOUNT_ID, 1), now: w.fakes.clock.now + 6 * MINUTE })).toBeUndefined()
    expect((await action(w, session.id, "viewer", { mode: "edit" })).status).toBe(400)
  })
})

describe("the computer's heartbeat (S3, S7)", () => {
  test("the first answer carries the job; once booted the job is forgotten", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const first = await beat(w, session.id, { cpu: 10 })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      state: "running",
      control: "agent",
      deadline: session.deadline,
      browser: true,
      viewerKey: VIEWER_PUBLIC_X,
      job: { prompt: PROMPT },
    })
    const booted = await beat(w, session.id, { booted: true })
    expect(booted.body.job).toBeUndefined()
    expect(w.fakes.store.get(hostedJobKey(session.id))).toBeUndefined()
    expect((await beat(w, session.id, {})).body.job).toBeUndefined()
  })

  test("the daemon's image generation and hand-over reason are kept; anything else is dropped (WP A54)", async () => {
    expect(parseHeartbeat({ generation: 3, handoff: "captcha" })).toEqual({ generation: 3, handoff: "captcha" })
    expect(parseHeartbeat({ generation: 0, handoff: "Please type the password hunter2" })).toEqual({})
    expect(parseHeartbeat({ generation: 1.5, handoff: "admin_prompt" })).toEqual({})
    const w = await hostedWorld(ledger)
    const session = await started(w)
    await beat(w, session.id, { booted: true, generation: 2, handoff: "credential" })
    const first = await readBeat(session.id, w.fetcher)
    expect(first).toMatchObject({ generation: 2, handoff: { reason: "credential", since: w.fakes.clock.now } })
    w.fakes.clock.advance(30_000)
    await beat(w, session.id, { generation: 2, handoff: "credential" })
    expect((await readBeat(session.id, w.fetcher))?.handoff?.since).toBe(first!.handoff!.since)
    await beat(w, session.id, { generation: 2 })
    expect((await readBeat(session.id, w.fetcher))?.handoff).toBeUndefined()
  })

  test("browser-shaped requests, another session's id and account tokens are refused", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const browserShaped: Record<string, string>[] = [
      { origin: "https://example.invalid" },
      { cookie: "a=b" },
      { "sec-fetch-site": "cross-site" },
    ]
    for (const headers of browserShaped) {
      const answer = await beat(w, session.id, {}, { headers })
      expect(answer.status).toBe(403)
      expect(answer.body.error.code).toBe("HOSTED_RUN_REFUSED")
    }
    const other = await beat(w, `hs_${"b".repeat(26)}`, {})
    expect(other.status).toBe(403)
    const account = await beat(w, session.id, {}, { token: w.desktopToken() })
    expect(account.status).toBe(401)
    const forged = await beat(w, session.id, {}, { token: `vht_${"x".repeat(40)}.${"y".repeat(43)}` })
    expect(forged.status).toBe(401)
  })

  test("the gateway takes the run token only for a live session and never with browser headers", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const token = w.provider.token(computerName(ACCOUNT_ID, 1))!
    const registry = createRunVerifierRegistry()
    registry.register("vht_", (value) => verifyHostedRunToken(value, w.fetcher, w.fakes.clock.now))
    const caller = await requireModelPlanCaller(
      { headers: { authorization: `Bearer ${token}` } },
      w.fetcher,
      w.fakes.clock.now,
      registry,
    )
    expect(caller).toMatchObject({
      account: { id: ACCOUNT_ID },
      kind: "run",
      purpose: "hosted",
      run: { id: session.id, service: "hosted", sessionId: session.id, source: "desktop" },
    })
    await expect(
      requireModelPlanCaller(
        { headers: { authorization: `Bearer ${token}`, origin: "https://example.invalid" } },
        w.fetcher,
        w.fakes.clock.now,
        registry,
      ),
    ).rejects.toMatchObject({ code: "HOSTED_RUN_REFUSED" })
    await action(w, session.id, "stop")
    await expect(
      requireModelPlanCaller({ headers: { authorization: `Bearer ${token}` } }, w.fetcher, w.fakes.clock.now, registry),
    ).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_EXPIRED" })
  })
})

describe("the session's files", () => {
  test("asked for, packed by the computer, uploaded to the bucket, then a 24-hour link leading to a signed GET", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const asked = await action(w, session.id, "download")
    expect(asked.status).toBe(202)
    expect(asked.body).toEqual({ ready: false })
    // WP A54: the computer learns of the request from the heartbeat, packs, then reports the size.
    const told = await beat(w, session.id, {})
    expect(told.body.pack).toBe(true)
    expect(told.body.upload).toBeUndefined()
    const packed = await beat(w, session.id, { archiveBytes: 4096 })
    expect(packed.body.pack).toBeUndefined()
    expect(packed.body.upload.url).toStartWith(`https://${R2_HOST}/`)
    expect(packed.body.upload.headers["content-length"]).toBe("4096")
    const key = decodeURIComponent(new URL(packed.body.upload.url).pathname.split("/").slice(2).join("/"))
    expect(key).toBe(`hosted/test/${hostedAccount(ACCOUNT_ID).slice(0, 32)}/${session.id}/files.tar.gz`)
    w.bucket.set(key, 4096)
    await beat(w, session.id, { uploaded: true })
    const ready = await action(w, session.id, "download")
    expect(ready.status).toBe(200)
    expect(ready.body.expiresAt - w.fakes.clock.now).toBe(Hosted.DOWNLOAD_LINK_MS)
    const link = new URL(ready.body.url)
    expect(link.origin).toBe("https://vectordev.ai")
    // The link names the session only: no account id, in clear or inside its token.
    const payload = Buffer.from(link.searchParams.get("t")!.split(".")[1]!, "base64url").toString("utf8")
    expect(`${ready.body.url} ${payload}`).not.toContain(ACCOUNT_ID)
    const followed = await invoke(
      (request, response) => handleHostedSessionAction(request, response, "download", w.options),
      { method: "GET", query: { id: session.id, t: link.searchParams.get("t")! } },
    )
    expect(followed.status).toBe(302)
    expect(followed.headers.location).toStartWith(`https://${R2_HOST}/`)
    const bad = await invoke((request, response) => handleHostedSessionAction(request, response, "download", w.options), {
      method: "GET",
      query: { id: session.id, t: "vhd1.nope.nope" },
    })
    expect(bad.status).toBe(404)
  })

  test("an ended session whose files were never packed has none to give", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    await action(w, session.id, "stop")
    const answer = await action(w, session.id, "download")
    expect(answer.status).toBe(409)
    expect(answer.body.error.code).toBe("HOSTED_DOWNLOAD_UNAVAILABLE")
  })
})

describe("status, computers and the owner's flags", () => {
  test("status shows the plan's public caps, the share of hours used and live sessions, with no amount", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const answer: Answer = await invoke((request, response) => handleHostedStatus(request, response, w.options), {
      method: "GET",
      authorization: w.desktopToken(),
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      access: "start",
      plan: { computers: 1, hours: 20, jobMinutes: 240, diskDays: 7, sizes: ["standard"], browser: true },
      hours: { used: 0 },
      sessions: [{ id: session.id, state: "running" }],
    })
    expectNoAmounts(answer.body)
  })

  test("computers lists what runs; a computer is deleted only when nothing runs on it", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const list = await invoke((request, response) => handleHostedComputers(request, response, w.options), {
      method: "GET",
      authorization: w.desktopToken(),
    })
    expect(list.body.computers).toEqual([{ computer: 1, running: true, session: session.id, included: true }])
    const erase = () =>
      invoke((request, response) => handleHostedComputers(request, response, w.options), {
        method: "POST",
        authorization: w.desktopToken(),
        body: { computer: 1, action: "erase" },
      })
    expect((await erase()).body.error.code).toBe("HOSTED_SESSION_RUNNING")
    await action(w, session.id, "stop")
    expect((await erase()).body).toEqual({ computer: 1, deleted: true })
    expect(w.provider.computers.size).toBe(0)
  })

  test("the owner drains, stops and resumes, and holds one account; others are refused (S5)", async () => {
    const w = await hostedWorld(ledger)
    const flags = (authorization: string, body?: Record<string, unknown>) =>
      invoke((request, response) => handleHostedFlags(request, response, w.options), {
        method: body ? "POST" : "GET",
        authorization,
        ...(body ? { body } : {}),
      })
    expect((await flags(w.sessionToken())).status).toBe(403)
    const stale = await flags(w.ownerToken(20 * MINUTE), { action: "drain" })
    expect(stale.body.error.code).toBe("RECENT_SIGN_IN_REQUIRED")
    expect((await flags(w.ownerToken(), { action: "drain" })).body).toMatchObject({ hosted: "no-new" })
    expect((await flags(w.ownerToken(), { action: "suspend", account: ACCOUNT_ID, reason: "check" })).body).toEqual({
      account: ACCOUNT_ID,
      onHold: true,
    })
    const read = await flags(w.ownerToken())
    expect(read.body).toMatchObject({ hosted: "no-new", onHold: [{ account: ACCOUNT_ID, reason: "owner" }] })
    expect((await flags(w.ownerToken(), { action: "resume" })).body.hosted).toBe("on")
    const held = await start(w)
    expect(held.status).toBe(403)
    expect(held.body.error).toMatchObject({ code: "HOSTED_FROZEN", reason: "owner" })
    await flags(w.ownerToken(), { action: "release", account: ACCOUNT_ID })
    expect((await start(w)).status).toBe(201)
  })
})

// ── The sessions' scripts on Valkey (CI only: VECTOR_TEST_REDIS_URL) ───────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("the sessions' scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const send = async (command: (string | number)[]) =>
    (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null
  const { SAVE, CLAIM, LEASE } = HOSTED_SESSION_SCRIPTS
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("SAVE, CLAIM and LEASE answer as their TypeScript copies do", async () => {
    const now = Date.now()
    const key = "fixture:session"
    expect(Number(await send(["EVAL", SAVE, 1, key, "", '{"a":1}', 60_000]))).toBe(1)
    expect(Number(await send(["EVAL", SAVE, 1, key, "", '{"a":2}', 60_000]))).toBe(0)
    expect(Number(await send(["EVAL", SAVE, 1, key, '{"a":1}', '{"a":3}', 60_000]))).toBe(1)
    expect(await send(["GET", key])).toBe('{"a":3}')
    expect(Number(await send(["PTTL", key]))).toBeGreaterThan(50_000)

    const lease = "fixture:lease"
    const claim = (session: string, cap: number, until: number) =>
      send(["EVAL", CLAIM, 1, lease, session, cap, until, now, 86_400_000]).then(Number)
    expect(await claim("hs_a", 3, now + 60_000)).toBe(1)
    expect(await claim("hs_b", 3, now + 60_000)).toBe(2)
    expect(await claim("hs_a", 3, now + 120_000)).toBe(1)
    expect(await claim("hs_c", 2, now + 60_000)).toBe(0)
    await send(["HSET", lease, "2", `hs_b:${now - 1}`])
    expect(await claim("hs_c", 2, now + 60_000)).toBe(2)
    const renew = (computer: number, session: string, until: number | "") =>
      send(["EVAL", LEASE, 1, lease, computer, session, until, 86_400_000]).then(Number)
    expect(await renew(1, "hs_b", now + 1)).toBe(0)
    expect(await renew(1, "hs_a", now + 300_000)).toBe(1)
    expect(await send(["HGET", lease, "1"])).toBe(`hs_a:${now + 300_000}`)
    expect(await renew(1, "hs_a", "")).toBe(1)
    expect(await send(["HGET", lease, "1"])).toBe(null)
    expect(Number(await send(["PTTL", lease]))).toBeGreaterThan(0)
  })
})
