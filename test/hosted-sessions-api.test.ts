import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash } from "node:crypto"
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
import { markAccountDeleting } from "../api/_lib/codium-tombstone"
import { bootArguments, computerName, hostedComputerKey } from "../api/_lib/hosted-provider"
import { vercelProvider, type VercelSandboxSdk } from "../api/_lib/hosted-provider-vercel"
import { applyHostedTransition, reapHostedSessions, runHostedNightly } from "../api/_lib/hosted-crons"
import {
  HOSTED_SESSION_SCRIPTS,
  START_STALE_MS,
  assertHostedSessionLive,
  hostedDiskDueKey,
  hostedDownloadEgressKey,
  hostedGenerationKey,
  hostedHostdKey,
  hostedJobKey,
  hostedLeaseKey,
  hostedSessionsKey,
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
  DAY,
  MINUTE,
  P1,
  R2_HOST,
  SEEDED,
  VIEWER_PUBLIC_X,
  daemonBeat,
  endedWithDisk,
  hostdKey,
  hostedSessionEnvironment,
  hostedWorld,
  invoke,
  startDownload,
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
    body: daemonBeat(id, body),
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

  test("a store fault right after the first block was held charges nothing and starts no computer (P8 review)", async () => {
    const w = await hostedWorld(ledger)
    let failed = 0
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = typeof init?.body === "string" && init.body.startsWith("[") ? (JSON.parse(init.body) as unknown[]) : []
      // The first compare-and-set of an existing session record: the update that follows openBlock.
      if (command[0] === "EVAL" && command[1] === HOSTED_SESSION_SCRIPTS.SAVE && command[4] !== "" && failed++ === 0)
        return new Response("unavailable", { status: 500 })
      return w.fetcher(input, init)
    }) as typeof fetch
    const answer = await invoke((request, response) => handleHostedSessions(request, response, { ...w.options, fetcher }), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 60, prompt: PROMPT },
    })
    expect(answer.status).toBe(503)
    expect(failed).toBeGreaterThan(0)
    expect(w.provider.calls.some((call) => call.startsWith("start"))).toBe(false)
    const ids = [...w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys()]
    expect(await readSessionRecord(ids[0]!, w.fetcher)).toMatchObject({ state: "ended", reason: "failed" })
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(0)
    expect((await readLine(ACCOUNT_ID, `hb-${ids[0]}-0`, w.options))?.units ?? 0).toBe(0)
    // Ten minutes on, the reaper finds nothing left to charge.
    w.fakes.clock.advance(START_STALE_MS + MINUTE)
    await reapHostedSessions(w.options)
    expect((await readLine(ACCOUNT_ID, `hb-${ids[0]}-0`, w.options))?.units ?? 0).toBe(0)
  })

  test("a start whose outcome the provider could not tell charges up to the stop when a computer did start (M8)", async () => {
    const w = await hostedWorld(ledger)
    const start = w.provider.start.bind(w.provider)
    // The provider makes the computer, then its answer times out 90 seconds in.
    w.provider.start = async (config) => {
      await start(config)
      w.fakes.clock.advance(90_000)
      throw new Error("timed out")
    }
    const answer = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 60, prompt: PROMPT },
    })
    expect(answer.status).toBe(503)
    const name = computerName(ACCOUNT_ID, 1)
    expect(w.provider.computers.get(name)!.status).toBe("stopped")
    const ids = [...w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys()]
    expect(await readSessionRecord(ids[0]!, w.fetcher)).toMatchObject({ state: "ended", reason: "failed" })
    expect(await readLine(ACCOUNT_ID, `hb-${ids[0]}-0`, w.options)).toMatchObject({ kind: "block", units: 2 })
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
  })

  test("when the provider can answer neither the start nor the stop, the reaper stops the computer and charges what ran", async () => {
    const w = await hostedWorld(ledger)
    const start = w.provider.start.bind(w.provider)
    w.provider.start = async (config) => {
      await start(config)
      w.provider.fail.stop = true
      throw new Error("timed out")
    }
    const answer = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { size: "standard", jobMinutes: 60, prompt: PROMPT },
    })
    expect(answer.status).toBe(503)
    const ids = [...w.fakes.store.zset(codiumKey("hosted", "sessions", ACCOUNT_ID)).keys()]
    // Left stopping with its block open: nothing is closed at the start while a computer may be running.
    expect(await readSessionRecord(ids[0]!, w.fetcher)).toMatchObject({ state: "stopping", reason: "failed" })
    expect(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).size).toBe(1)
    w.fakes.clock.advance(3 * MINUTE)
    w.provider.fail.stop = false
    await reapHostedSessions(w.options)
    expect(await readSessionRecord(ids[0]!, w.fetcher)).toMatchObject({ state: "ended", reason: "failed" })
    expect(w.provider.computers.get(computerName(ACCOUNT_ID, 1))!.status).toBe("stopped")
    expect(await readLine(ACCOUNT_ID, `hb-${ids[0]}-0`, w.options)).toMatchObject({ kind: "block", units: 3 })
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

  test("only the daemon's signed reports count: the agent can neither register a key nor report for it (P8 review)", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    // The run token alone is what any process on the computer gets from the provider's proxy.
    const raw = (body: Record<string, unknown>) =>
      invoke((request, response) => handleHostedHeartbeat(request, response, w.options), {
        method: "POST",
        authorization: w.provider.token(computerName(ACCOUNT_ID, 1))!,
        body,
        query: { id: session.id },
      })
    const unsigned = await raw({ cpu: 0, activeAt: w.fakes.clock.now })
    expect([unsigned.status, unsigned.body.error.code]).toEqual([403, "HOSTED_RUN_REFUSED"])
    expect(unsigned.body.job).toBeUndefined()
    expect(await readBeat(session.id, w.fetcher)).toBeUndefined()
    // The daemon's first beat registers its key and gets the job; the agent starts only after that.
    const first = await beat(w, session.id, { cpu: 95 })
    expect(first.body.job).toMatchObject({ prompt: PROMPT })
    expect(w.fakes.store.get(hostedHostdKey(session.id))).toBe(hostdKey(session.id))
    const busySince = (await readBeat(session.id, w.fetcher))!.busySince
    expect(busySince).toBe(w.fakes.clock.now)
    // A key of the agent's own, offered or not, signs nothing the server takes.
    const agentKey = createHash("sha256").update("agent").digest("base64url")
    w.fakes.clock.advance(5_000)
    const offered = await raw(daemonBeat(session.id, { cpu: 0, done: true }, agentKey))
    expect([offered.status, offered.body.error.code]).toEqual([403, "HOSTED_RUN_REFUSED"])
    const { hostdKey: _key, ...quiet } = daemonBeat(session.id, { cpu: 0 }, agentKey)
    expect((await raw(quiet)).status).toBe(403)
    // A signed body changed after signing fails too.
    expect((await raw({ ...daemonBeat(session.id, { cpu: 95 }), cpu: 0 })).status).toBe(403)
    // So the busy processor the daemon reported stands, and nothing the agent sent was kept.
    expect(await readBeat(session.id, w.fetcher)).toMatchObject({ busySince, cpu: 95, done: false })
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

// Codium finish H2a: the server-side image floor. The daemon's signed beats record each computer's image generation;
// with VECTOR_HOSTED_MIN_GENERATION set, a job start passes over or refuses a computer below it before any lease, hold
// or provider call. Download-only starts are in hosted-lifecycle.test.ts. Fakes only.
describe("the image generation floor (H2a)", () => {
  const REBUILD = { code: "HOSTED_REBUILD_REQUIRED", message: "This cloud computer needs to be rebuilt." }
  const rows = async () => (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))
  const held = () => `vector:codium:test:held:${SEEDED}`
  const tokenFor = (w: HostedWorld, computer: number) => w.provider.token(computerName(ACCOUNT_ID, computer))!
  const setFloor = (value: string) => {
    process.env.VECTOR_HOSTED_MIN_GENERATION = value
  }
  /** What the account's computers reported, without the lapse times (never creating the hash). */
  const generations = (w: HostedWorld) => {
    const flat = w.fakes.store.command(["HGETALL", hostedGenerationKey(ACCOUNT_ID)]) as string[]
    return Object.fromEntries(
      flat.flatMap((field, index) => (index % 2 === 0 ? [[field, flat[index + 1]!.split(":")[0]]] : [])),
    )
  }
  const computers = async (w: HostedWorld) =>
    (
      await invoke((request, response) => handleHostedComputers(request, response, w.options), {
        method: "GET",
        authorization: w.desktopToken(),
      })
    ).body
  /** Everything a start could have touched, to compare before and after a refusal. */
  const touched = async (w: HostedWorld) => ({
    rows: await rows(),
    held: [...w.fakes.store.zset(held())],
    leases: [...w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID))],
    running: [...w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID))],
    sessions: [...w.fakes.store.zset(hostedSessionsKey(ACCOUNT_ID))],
  })

  /** A session on `computer` whose daemon reported `generation` once booted, stopped again. */
  async function ranWith(w: HostedWorld, generation: number, computer = 1) {
    const session = await started(w)
    expect(session.computer).toBe(computer)
    expect((await beat(w, session.id, { booted: true, generation }, { token: tokenFor(w, computer) })).status).toBe(200)
    await action(w, session.id, "stop")
    return session
  }

  test("the daemon's signed beats record the computer's generation, which outlives the session; unsigned ones do not", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    const unsigned = await invoke((request, response) => handleHostedHeartbeat(request, response, w.options), {
      method: "POST",
      authorization: tokenFor(w, 1),
      body: { booted: true, generation: 9 },
      query: { id: session.id },
    })
    expect([unsigned.status, unsigned.body.error.code]).toEqual([403, "HOSTED_RUN_REFUSED"])
    expect(generations(w)).toEqual({})
    await beat(w, session.id, { booted: true, generation: 2 })
    expect(generations(w)).toEqual({ "1": "2" })
    // Each signed beat writes the report again with when it lapses: the plan's disk days (Max: 7) from that beat.
    const entry = () => w.fakes.store.command(["HGET", hostedGenerationKey(ACCOUNT_ID), "1"])
    w.advance(MINUTE)
    await beat(w, session.id, { generation: 3 })
    expect(entry()).toBe(`3:${w.fakes.clock.now + 7 * DAY}`)
    // The same generation again still moves the lapse along.
    w.advance(MINUTE)
    await beat(w, session.id, { generation: 3 })
    expect(entry()).toBe(`3:${w.fakes.clock.now + 7 * DAY}`)
    await action(w, session.id, "stop")
    expect(await readBeat(session.id, w.fetcher)).toBeUndefined()
    expect(generations(w)).toEqual({ "1": "3" })
  })

  test("a report lapses with the disk: once the plan's disk days have passed, the old generation no longer refuses", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 2)
    setFloor("3")
    expect((await start(w)).status).toBe(409)
    // Just before the lapse it still refuses; from then on the provider may have deleted the disk, so it passes.
    w.advance(7 * DAY - 2 * MINUTE)
    expect((await start(w)).status).toBe(409)
    expect((await computers(w)).computers[0].rebuild).toBe(true)
    w.advance(2 * MINUTE)
    expect((await computers(w)).computers).toEqual([{ computer: 1, running: false, included: true }])
    const again = await started(w)
    expect(again.computer).toBe(1)
    // Its first signed beat records what the computer runs now.
    await beat(w, again.id, { booted: true, generation: 3 })
    expect(generations(w)).toEqual({ "1": "3" })
  })

  test("no floor: a computer that reported an old generation starts and resumes as before", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 1)
    setFloor("")
    w.provider.calls.length = 0
    const again = await started(w)
    expect(again.computer).toBe(1)
    expect(w.provider.calls).toEqual([`start ${computerName(ACCOUNT_ID, 1)}`, `boot ${computerName(ACCOUNT_ID, 1)}`])
    expect((await computers(w)).computers).toEqual([{ computer: 1, running: true, session: again.id, included: true }])
    // A floor of 0 is no floor either.
    await action(w, again.id, "stop")
    setFloor("0")
    expect((await start(w)).status).toBe(201)
  })

  test("a floor above the recorded generation refuses the start before any lease, hold or provider call", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 2)
    setFloor("3")
    const before = await touched(w)
    w.provider.calls.length = 0
    for (const authorization of [w.desktopToken(), w.sessionToken()]) {
      const refused = await start(w, {}, authorization)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toEqual({ ...REBUILD, computers: [1] })
      expectNoAmounts(refused.body)
    }
    expect(await touched(w)).toEqual(before)
    expect(before.leases).toEqual([])
    expect(before.running).toEqual([])
    expect(w.provider.calls).toEqual([])
    // The computer's view says so, with no generation and no amount.
    const view = await computers(w)
    expect(view.computers).toEqual([{ computer: 1, running: false, included: true, rebuild: true }])
    expectNoAmounts(view)
  })

  test("an equal or higher generation passes", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 3)
    setFloor("3")
    const equal = await started(w)
    expect((await beat(w, equal.id, { booted: true, generation: 4 })).status).toBe(200)
    await action(w, equal.id, "stop")
    expect(generations(w)).toEqual({ "1": "4" })
    const higher = await started(w)
    expect(higher.computer).toBe(1)
    expect((await computers(w)).computers[0].rebuild).toBeUndefined()
  })

  test("a computer with no recorded generation passes: it never booted, or never reported one", async () => {
    const w = await hostedWorld(ledger)
    setFloor("3")
    const first = await started(w)
    // A daemon that could not read its generation sends 0, which counts as none.
    await beat(w, first.id, { booted: true, generation: 0 })
    await action(w, first.id, "stop")
    expect(generations(w)).toEqual({})
    expect((await start(w)).status).toBe(201)
  })

  test("a generation left for a computer the account no longer has is not read, and a new computer drops it", async () => {
    const w = await hostedWorld(ledger)
    // As after an erase whose last write failed, or a beat that raced it: number 1 is not one of the account's.
    w.fakes.store.hash(hostedGenerationKey(ACCOUNT_ID)).set("1", `1:${w.fakes.clock.now + DAY}`)
    setFloor("3")
    expect((await computers(w)).computers).toEqual([{ computer: 1, running: false, included: true }])
    const made = await started(w)
    expect(made.computer).toBe(1)
    expect(generations(w)).toEqual({})
    await action(w, made.id, "stop")
    expect((await start(w)).status).toBe(201)
  })

  test("with several computers a start passes over one below the floor; refused only when every included one is", async () => {
    const w = await hostedWorld(ledger)
    w.setSnapshot({ plan: "vector-200" })
    await ranWith(w, 2)
    setFloor("3")
    const second = await started(w)
    expect(second.computer).toBe(2)
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).has("1")).toBe(false)
    const third = await started(w)
    expect(third.computer).toBe(3)
    // Computer 1 is free but below the floor and the others run: busy, and the message says why.
    const busy = await start(w)
    expect(busy.status).toBe(429)
    expect(busy.body.error).toEqual({
      code: "HOSTED_BUSY",
      message: "Every cloud computer your plan includes is running or needs to be rebuilt.",
    })
    expect([...w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).keys()].sort()).toEqual(["2", "3"])
    for (const session of [second, third]) {
      await beat(w, session.id, { booted: true, generation: 2 }, { token: tokenFor(w, session.computer) })
      await action(w, session.id, "stop")
    }
    w.provider.calls.length = 0
    const refused = await start(w)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toEqual({ ...REBUILD, computers: [1, 2, 3] })
    expect(w.provider.calls).toEqual([])
    expect((await computers(w)).computers.map((item: { rebuild?: true }) => item.rebuild)).toEqual([true, true, true])
    // Back on Max, which includes one computer: no job starts on 2 or 3, so only computer 1 asks for a rebuild.
    w.setSnapshot({ plan: "vector-100" })
    expect((await computers(w)).computers).toEqual([
      { computer: 1, running: false, included: true, rebuild: true },
      { computer: 2, running: false, included: false },
      { computer: 3, running: false, included: false },
    ])
  })

  test("deleting the computer's disk is the only rebuild: nothing is deleted for the floor on its own", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 2)
    setFloor("3")
    expect((await start(w)).status).toBe(409)
    await reapHostedSessions(w.options)
    await runHostedNightly(w.options)
    expect(w.provider.calls.some((call) => call.startsWith("destroy"))).toBe(false)
    expect(w.provider.computers.has(computerName(ACCOUNT_ID, 1))).toBe(true)
    const erase = await invoke((request, response) => handleHostedComputers(request, response, w.options), {
      method: "POST",
      authorization: w.desktopToken(),
      body: { computer: 1, action: "erase" },
    })
    expect(erase.body).toEqual({ computer: 1, deleted: true })
    expect(generations(w)).toEqual({})
    const rebuilt = await started(w)
    expect(rebuilt.computer).toBe(1)
    expect(w.provider.computers.has(computerName(ACCOUNT_ID, 1))).toBe(true)
    await beat(w, rebuilt.id, { booted: true, generation: 3 })
    expect(generations(w)).toEqual({ "1": "3" })
    expect((await computers(w)).computers[0].rebuild).toBeUndefined()
  })

  test("an unreadable floor refuses job starts as unavailable, never as a rebuild, and holds nothing", async () => {
    const w = await hostedWorld(ledger)
    await ranWith(w, 2)
    const before = await touched(w)
    w.provider.calls.length = 0
    for (const value of ["three", "1.5", "-1", "2000000"]) {
      setFloor(value)
      const refused = await start(w)
      expect([value, refused.status, refused.body.error.code]).toEqual([value, 503, "HOSTED_UNAVAILABLE"])
      const view = await computers(w)
      expect(view.computers[0].rebuild).toBeUndefined()
    }
    expect(await touched(w)).toEqual(before)
    expect(w.provider.calls).toEqual([])
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

  test("a session under the person's control is still asked for its files (A54, unchanged by H1a)", async () => {
    const w = await hostedWorld(ledger)
    const session = await started(w)
    await action(w, session.id, "takeover")
    const asked = await action(w, session.id, "download")
    expect(asked.status).toBe(202)
    expect(asked.body).toEqual({ ready: false })
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

/** The daemon packs and uploads the disk as the answers ask (WP A54): pack, size, upload, done. */
async function upload(w: HostedWorld, id: string, bytes = 8192) {
  const told = await beat(w, id, {})
  expect(told.body.pack).toBe(true)
  const packed = await beat(w, id, { archiveBytes: bytes })
  const key = decodeURIComponent(new URL(packed.body.upload.url).pathname.split("/").slice(2).join("/"))
  w.bucket.set(key, bytes)
  return beat(w, id, { uploaded: true })
}

describe("download-only starts for an ended plan's kept disk (H1a)", () => {
  const NAME = () => computerName(ACCOUNT_ID, 1)
  const RETENTION = () => `hr-${NAME()}-sub_renewing-${P1.start}`
  const rows = async () => (await ledger.rows()).filter((row) => row.account === hostedAccount(ACCOUNT_ID))

  test("an ended plan inside the window starts one; the computer is asked only to pack and upload, never a job", async () => {
    const w = await hostedWorld(ledger)
    const due = (await endedWithDisk(w))!
    expect(due).toBe(w.fakes.clock.now + Hosted.ENDED_DISK_DAYS * DAY)
    w.provider.calls.length = 0
    const answer = await startDownload(w)
    expect(answer.status).toBe(201)
    const session = answer.body.session as Hosted.SessionView
    expect(session).toMatchObject({ state: "running", computer: 1, size: "standard", mode: "download" })
    expect(session.download).toEqual({ requestedAt: w.fakes.clock.now })
    expect(session.deadline).toBe(w.fakes.clock.now + 15 * MINUTE)
    expectNoAmounts(answer.body)
    expect(w.provider.calls).toEqual([`start ${NAME()}`, `boot ${NAME()}`])
    expect(w.fakes.store.get(hostedJobKey(session.id))).toBeUndefined()
    // One block, held from the final period's key (switched off and past its period, as an ended plan's is).
    const running = JSON.parse(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).get(session.id)!)
    expect(running).toMatchObject({
      block: 0,
      pool: SEEDED,
      epoch: `sub_renewing:${P1.start * 1000}`,
      periodEnd: P1.end * 1000,
    })
    const first = await beat(w, session.id, {})
    expect(first.body).toMatchObject({
      state: "running",
      control: "agent",
      browser: false,
      mode: "download",
      pack: true,
    })
    expect(first.body.job).toBeUndefined()
    expect(first.body.recording).toBeUndefined()
    const booted = await beat(w, session.id, { booted: true })
    expect(booted.body.job).toBeUndefined()
    // The retention of the kept disk is charged to the final period, once (§4.4; WP A51's chargeRetention).
    expect(await readLine(ACCOUNT_ID, RETENTION(), w.options)).toMatchObject({
      kind: "retention",
      units: Hosted.ENDED_DISK_DAYS,
      periodStart: P1.start * 1000,
    })
    // No live view, no take-over.
    for (const kind of ["viewer", "takeover"] as const) {
      const refused = await action(w, session.id, kind, kind === "viewer" ? { mode: "view" } : {})
      expect(refused.status).toBe(400)
      expect(refused.body.error.message).toBe("This session only gets the computer's files ready to download.")
    }
    // Until the files are uploaded the person is told to ask again.
    expect((await action(w, session.id, "download")).body).toEqual({ ready: false })
  })

  test("after the upload the download link works, never outliving the disk's date; the upload's egress is Vector's", async () => {
    const w = await hostedWorld(ledger)
    const due = (await endedWithDisk(w))!
    const session = (await startDownload(w)).body.session as Hosted.SessionView
    await upload(w, session.id, 8192)
    expect(w.fakes.store.get(hostedDownloadEgressKey(ACCOUNT_ID, 1))).toBe("8192")
    w.advance(10 * DAY)
    w.setSnapshot({})
    const ready = await action(w, session.id, "download")
    expect(ready.status).toBe(200)
    expect(ready.body.expiresAt).toBe(Math.min(w.fakes.clock.now + Hosted.DOWNLOAD_LINK_MS, due))
    const followed = await invoke(
      (request, response) => handleHostedSessionAction(request, response, "download", w.options),
      { method: "GET", query: { id: session.id, t: new URL(ready.body.url).searchParams.get("t")! } },
    )
    expect(followed.status).toBe(302)
    w.advance(3 * DAY + 23 * 60 * MINUTE)
    const late = await action(w, session.id, "download")
    expect(late.body.expiresAt).toBe(due)
    w.advance(2 * 60 * MINUTE)
    const gone = await action(w, session.id, "download")
    expect(gone.status).toBe(410)
    expect(gone.body.error.code).toBe("HOSTED_DOWNLOAD_UNAVAILABLE")
  })

  test("its run token gets no chat and no /models, and its session is never live for the gateway (S3)", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const session = (await startDownload(w)).body.session as Hosted.SessionView
    const token = w.provider.token(NAME())!
    expect(readHostedRunToken(token, w.fakes.clock.now)).toMatchObject({ session: session.id })
    const registry = createRunVerifierRegistry()
    registry.register("vht_", (value) => verifyHostedRunToken(value, w.fetcher, w.fakes.clock.now))
    await expect(
      requireModelPlanCaller({ headers: { authorization: `Bearer ${token}` } }, w.fetcher, w.fakes.clock.now, registry),
    ).rejects.toMatchObject({ statusCode: 401, code: "MODEL_PLAN_RUN_EXPIRED" })
    expect(await assertHostedSessionLive(session.id, w.fetcher, w.fakes.clock.now)).toBe(false)
    // The person's routes refuse it too, as every run token.
    expect((await startDownload(w, 1, token)).status).toBe(401)
  })

  test("the retention is charged once across two starts, and a second start on a busy computer is refused", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const first = (await startDownload(w)).body.session as Hosted.SessionView
    const busy = await startDownload(w)
    expect(busy.status).toBe(429)
    expect(busy.body.error).toMatchObject({
      code: "HOSTED_BUSY",
      message: "This computer is already getting its files ready.",
    })
    await action(w, first.id, "stop")
    w.advance(DAY)
    // The ended plan as reconcile keeps writing it (the fixture's Stripe objects still describe the paid period).
    w.setSnapshot({})
    const second = await startDownload(w)
    expect(second.status).toBe(201)
    const retention = (await rows()).filter((row) => row.kind === "retention")
    expect(retention.map((row) => row.ref)).toEqual([RETENTION()])
    expect((await rows()).filter((row) => row.kind === "block").map((row) => row.ref)).toContain(`hb-${first.id}-0`)
  })

  test("refused after the window, when frozen, after a lost dispute, refunded, while closing and on a live plan", async () => {
    const expectRefused = async (w: HostedWorld, status: number, code: string, message?: string) => {
      const before = await rows()
      const running = [...w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).keys()]
      const held = [...w.fakes.store.zset(`vector:codium:test:held:${SEEDED}`).keys()]
      w.provider.calls.length = 0
      const answer = await startDownload(w)
      expect(answer.status).toBe(status)
      expect(answer.body.error.code).toBe(code)
      if (message) expect(answer.body.error.message).toBe(message)
      expect(await rows()).toEqual(before)
      expect(w.provider.calls).toEqual([])
      expect([...w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).keys()]).toEqual(running)
      expect([...w.fakes.store.zset(`vector:codium:test:held:${SEEDED}`).keys()]).toEqual(held)
    }
    const late = await hostedWorld(ledger)
    await endedWithDisk(late)
    late.advance(Hosted.ENDED_DISK_DAYS * DAY + MINUTE)
    late.setSnapshot({})
    await expectRefused(late, 409, "HOSTED_DOWNLOAD_UNAVAILABLE", "This computer's disk is no longer kept.")
    // Once the nightly pass deleted the computers the answer is the same, not "choose one of your computers".
    await runHostedNightly(late.options)
    expect(late.fakes.store.zset(hostedDiskDueKey()).has(ACCOUNT_ID)).toBe(false)
    await expectRefused(late, 409, "HOSTED_DOWNLOAD_UNAVAILABLE", "This computer's disk is no longer kept.")

    const frozen = await hostedWorld(ledger)
    await endedWithDisk(frozen, { state: "frozen", reason: "disputed" })
    await expectRefused(frozen, 403, "HOSTED_FROZEN")

    const lost = await hostedWorld(ledger)
    await endedWithDisk(lost, { state: "ended", reason: "disputed" })
    await expectRefused(
      lost,
      409,
      "HOSTED_DOWNLOAD_UNAVAILABLE",
      "This computer's files cannot be downloaded for this account.",
    )

    const refunded = await hostedWorld(ledger)
    await endedWithDisk(refunded, { state: "ended", reason: "refunded" })
    await expectRefused(refunded, 409, "HOSTED_DOWNLOAD_UNAVAILABLE")

    const closing = await hostedWorld(ledger)
    await endedWithDisk(closing)
    await markAccountDeleting(ACCOUNT_ID, closing.fakes.clock.now, closing.fakes.clock.now + DAY, closing.fetcher)
    await expectRefused(closing, 409, "MODEL_PLAN_ACCOUNT_CLOSING")

    const live = await hostedWorld(ledger)
    await started(live)
    await expectRefused(
      live,
      409,
      "HOSTED_DOWNLOAD_UNAVAILABLE",
      "Your plan includes the cloud computer. Start a session and ask for its files.",
    )
  })

  test("a final period that cannot hold the block refuses it, and nothing is charged or started", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const before = await rows()
    w.fakes.openRouter.keys.get(SEEDED)!.usage = 48
    w.provider.calls.length = 0
    const answer = await startDownload(w)
    expect(answer.status).toBe(402)
    expect(answer.body.error).toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
      message: "Your Vector Codium plan cannot cover getting this computer's files ready.",
    })
    expectNoAmounts(answer.body.error.message)
    expect(await rows()).toEqual(before)
    expect(w.provider.calls).toEqual([])
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
  })

  test("a provider that no longer answers for the final key refuses the start with 503 and holds nothing", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const before = await rows()
    w.provider.calls.length = 0
    w.fakes.openRouter.keys.delete(SEEDED)
    const gone = await startDownload(w)
    expect(gone.status).toBe(503)
    w.fakes.openRouter.seed(SEEDED, { usage: "unknown" as unknown as number })
    const unreadable = await startDownload(w)
    expect(unreadable.status).toBe(503)
    expect(await rows()).toEqual(before)
    expect(w.provider.calls).toEqual([])
    expect(w.fakes.store.zset(`vector:codium:test:held:${SEEDED}`).size).toBe(0)
  })

  test("a provider that cannot start the computer charges the retention once and no block time", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const before = new Set((await rows()).map((row) => row.ref))
    w.provider.fail.start = true
    const answer = await startDownload(w)
    expect(answer.status).toBe(503)
    const added = (await rows()).filter((row) => !before.has(row.ref))
    expect(added.filter((row) => row.kind === "retention").map((row) => row.ref)).toEqual([RETENTION()])
    const blocks = added.filter((row) => row.kind === "block")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.units).toBe(0)
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
    // Asked again once the provider is back: the retention is not charged a second time.
    w.provider.fail.start = false
    expect((await startDownload(w)).status).toBe(201)
    expect((await rows()).filter((row) => row.kind === "retention")).toHaveLength(1)
  })

  test("a start too close to the disk's date is refused; one with a block and an hour to spare goes ahead", async () => {
    // A block (15 minutes) plus an hour to fetch the files: no start pays for files that are deleted before the link.
    const spare = 15 * MINUTE + Hosted.DOWNLOAD_LINK_MS / 24
    const edge = await hostedWorld(ledger)
    const edgeDue = (await endedWithDisk(edge))!
    edge.advance(edgeDue - spare - edge.fakes.clock.now)
    edge.setSnapshot({})
    expect((await startDownload(edge)).status).toBe(201)

    const w = await hostedWorld(ledger)
    const due = (await endedWithDisk(w))!
    w.advance(due - spare + MINUTE - w.fakes.clock.now)
    w.setSnapshot({})
    const before = await rows()
    w.provider.calls.length = 0
    const late = await startDownload(w)
    expect(late.status).toBe(409)
    expect(late.body.error).toMatchObject({
      code: "HOSTED_DOWNLOAD_UNAVAILABLE",
      message: "Too little time is left before this computer's disk is deleted.",
    })
    expectNoAmounts(late.body.error.message)
    expect(await rows()).toEqual(before)
    expect(w.provider.calls).toEqual([])
    expect(w.fakes.store.hash(hostedLeaseKey(ACCOUNT_ID)).size).toBe(0)
  })

  test("a live plan without a cloud computer downloads from its current period, retention included", async () => {
    const w = await hostedWorld(ledger)
    const job = await started(w)
    await action(w, job.id, "stop")
    const from = w.snapshot()
    const to = w.setSnapshot({ plan: "vector-50" })
    expect(to.caps.hosted).toBeNull()
    await applyHostedTransition({ account: ACCOUNT_ID, from, to, cause: "downgrade" }, w.options)
    const due = w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)
    expect(due).toBe(w.fakes.clock.now + Hosted.ENDED_DISK_DAYS * DAY)
    const answer = await startDownload(w)
    expect(answer.status).toBe(201)
    const session = answer.body.session as Hosted.SessionView
    expect(session).toMatchObject({ state: "running", computer: 1, mode: "download" })
    // The block is held from the live period's key and filed under its meter epoch, not a final key's.
    const running = JSON.parse(w.fakes.store.hash(hostedRunningKey(ACCOUNT_ID)).get(session.id)!)
    expect(running).toMatchObject({ block: 0, pool: SEEDED, epoch: to.meterEpoch, periodEnd: to.periodEnd })
    expect(w.fakes.clock.now).toBeLessThan(P1.end * 1000)
    expect(await readLine(ACCOUNT_ID, RETENTION(), w.options)).toMatchObject({
      kind: "retention",
      units: Hosted.ENDED_DISK_DAYS,
      periodStart: P1.start * 1000,
      periodEnd: P1.end * 1000,
    })
    const told = await beat(w, session.id, {})
    expect(told.body).toMatchObject({ mode: "download", browser: false, pack: true })
    expect(told.body.job).toBeUndefined()
    expect(told.body.recording).toBeUndefined()
  })

  test("no link is given or followed while frozen, after a lost dispute or while closing (§4.4), whatever the session", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    const session = (await startDownload(w)).body.session as Hosted.SessionView
    await upload(w, session.id)
    const ready = await action(w, session.id, "download")
    expect(ready.status).toBe(200)
    const follow = () =>
      invoke((request, response) => handleHostedSessionAction(request, response, "download", w.options), {
        method: "GET",
        query: { id: session.id, t: new URL(ready.body.url).searchParams.get("t")! },
      })
    for (const [patch, status, code] of [
      [{ state: "frozen", reason: "disputed" }, 403, "HOSTED_FROZEN"],
      [{ state: "ended", reason: "disputed" }, 409, "HOSTED_DOWNLOAD_UNAVAILABLE"],
      [{ state: "ended", reason: "closing" }, 409, "MODEL_PLAN_ACCOUNT_CLOSING"],
    ] as const) {
      w.setSnapshot(patch)
      const asked = await action(w, session.id, "download")
      expect([asked.status, asked.body.error?.code]).toEqual([status, code])
      const followed = await follow()
      expect([followed.status, followed.body.error?.code]).toEqual([status, code])
    }
    // A plan that ended canceled downloads again (a dispute won and closed as canceled).
    w.setSnapshot({ state: "ended", reason: "canceled" })
    expect((await action(w, session.id, "download")).status).toBe(200)
    expect((await follow()).status).toBe(302)

    // A job session's packed files follow the same rule.
    const live = await hostedWorld(ledger)
    const job = await started(live)
    await action(live, job.id, "download")
    await beat(live, job.id, {})
    const packed = await beat(live, job.id, { archiveBytes: 4096 })
    live.bucket.set(decodeURIComponent(new URL(packed.body.upload.url).pathname.split("/").slice(2).join("/")), 4096)
    await beat(live, job.id, { uploaded: true })
    expect((await action(live, job.id, "download")).status).toBe(200)
    live.setSnapshot({ state: "frozen", reason: "disputed" })
    const frozen = await action(live, job.id, "download")
    expect([frozen.status, frozen.body.error.code]).toEqual([403, "HOSTED_FROZEN"])
  })

  test("a body naming anything but the computer, or another computer, is refused", async () => {
    const w = await hostedWorld(ledger)
    await endedWithDisk(w)
    for (const [body, message] of [
      [{ mode: "download", computer: 1, size: "large" }, "A download names only the computer."],
      [{ mode: "download", computer: 0 }, "Choose one of your computers."],
      [{ mode: "download", computer: 2 }, "Choose one of your computers."],
      [{ mode: "elsewhere", computer: 1 }, "Send only size, jobMinutes, prompt, title."],
      [{ size: "standard", jobMinutes: 60, prompt: PROMPT, computer: 1 }, "Send only size, jobMinutes, prompt, title."],
    ] as const) {
      const answer = await invoke((request, response) => handleHostedSessions(request, response, w.options), {
        method: "POST",
        authorization: w.desktopToken(),
        body,
      })
      expect(answer.status).toBe(400)
      expect(answer.body.error.message).toBe(message)
    }
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

  describe("the kept disks on the status (H1c)", () => {
    const status = async (w: HostedWorld) => {
      const answer = await invoke((request, response) => handleHostedStatus(request, response, w.options), {
        method: "GET",
        authorization: w.desktopToken(),
      })
      expect(answer.status).toBe(200)
      return answer.body
    }
    const flags = (w: HostedWorld, body: Record<string, unknown>) =>
      invoke((request, response) => handleHostedFlags(request, response, w.options), {
        method: "POST",
        authorization: w.ownerToken(),
        body,
      })
    /** A download-only session on computer 1 that packed and uploaded its files and was then ended by the reaper. */
    async function packed(w: HostedWorld) {
      const answer = await startDownload(w)
      expect([answer.status, answer.body.error]).toEqual([201, undefined])
      const session = answer.body.session as Hosted.SessionView
      await upload(w, session.id)
      await reapHostedSessions({ ...w.options, budgetMs: 45_000 })
      expect((await readSessionRecord(session.id, w.fetcher))?.state).toBe("ended")
      return session.id
    }

    test("sent while a download-only start could go ahead: open, the date, each computer and its session", async () => {
      const w = await hostedWorld(ledger)
      const due = (await endedWithDisk(w))!
      const before = await status(w)
      expect(before.kept).toEqual({ state: "open", until: due, disks: [{ computer: 1 }] })
      expectNoAmounts(before)
      const started = (await startDownload(w)).body.session as Hosted.SessionView
      const running = await status(w)
      expect(running.kept.state).toBe("open")
      expect(running.kept.disks).toEqual([
        { computer: 1, session: expect.objectContaining({ id: started.id, mode: "download" }) },
      ])
      expect(running.sessions.map((item: Hosted.SessionView) => item.id)).toEqual([started.id])
      await upload(w, started.id)
      await reapHostedSessions({ ...w.options, budgetMs: 45_000 })
      const after = await status(w)
      expect(after.sessions).toEqual([])
      expect(after.kept.disks[0].session).toMatchObject({ id: started.id, state: "ended", reason: "finished" })
      expect(after.kept.disks[0].session.download.readyAt).toBeGreaterThan(0)
      // The random session id is not copy: it could spell one of the words by chance.
      expectNoAmounts(JSON.parse(JSON.stringify(after).replaceAll(started.id, "hs_session")))
    })

    test("a plan without a cloud computer gets it too, from its current period", async () => {
      const w = await hostedWorld(ledger)
      const job = await started(w)
      await action(w, job.id, "stop")
      const from = w.snapshot()
      const to = w.setSnapshot({ plan: "vector-50" })
      await applyHostedTransition({ account: ACCOUNT_ID, from, to, cause: "downgrade" }, w.options)
      const due = w.fakes.store.zset(hostedDiskDueKey()).get(ACCOUNT_ID)
      expect((await status(w)).kept).toEqual({ state: "open", until: due, disks: [{ computer: 1 }] })
    })

    test("late once less than a block and an hour is left: the start's own boundary minute", async () => {
      const spare = 15 * MINUTE + Hosted.DOWNLOAD_LINK_MS / 24
      const w = await hostedWorld(ledger)
      const due = (await endedWithDisk(w))!
      w.advance(due - spare - w.fakes.clock.now)
      w.setSnapshot({})
      expect((await status(w)).kept.state).toBe("open")
      w.advance(MINUTE)
      w.setSnapshot({})
      expect((await status(w)).kept).toEqual({ state: "late", until: due, disks: [{ computer: 1 }] })
      expect((await startDownload(w)).status).toBe(409)
      w.advance(spare)
      w.setSnapshot({})
      expect((await status(w)).kept).toBeUndefined()
    })

    test("absent for a live plan, frozen, a lost dispute, refunded with nothing packed, or no bucket", async () => {
      const live = await hostedWorld(ledger)
      await started(live)
      expect((await status(live)).kept).toBeUndefined()
      for (const patch of [
        { state: "frozen", reason: "early_fraud_warning" },
        { state: "frozen", reason: "disputed" },
        { state: "ended", reason: "disputed" },
        { state: "ended", reason: "refunded" },
      ] as const) {
        const w = await hostedWorld(ledger)
        await endedWithDisk(w, patch)
        expect([patch, (await status(w)).kept]).toEqual([patch, undefined])
      }
      const bucket = await hostedWorld(ledger)
      await endedWithDisk(bucket)
      delete process.env.VECTOR_R2_MEDIA_SECRET_ACCESS_KEY
      expect((await status(bucket)).kept).toBeUndefined()
    })

    test("packed files are never offered where §4.4 gives no download: frozen, lost dispute, closing", async () => {
      const w = await hostedWorld(ledger)
      await endedWithDisk(w)
      const id = await packed(w)
      expect((await status(w)).kept.disks[0].session.id).toBe(id)
      for (const [patch, code] of [
        [{ state: "frozen", reason: "disputed" }, "HOSTED_FROZEN"],
        [{ state: "ended", reason: "disputed" }, "HOSTED_DOWNLOAD_UNAVAILABLE"],
        [{ state: "ended", reason: "closing" }, "MODEL_PLAN_ACCOUNT_CLOSING"],
      ] as const) {
        w.setSnapshot(patch)
        expect([patch, (await status(w)).kept]).toEqual([patch, undefined])
        // The status says what the link route answers.
        expect((await action(w, id, "download")).body.error?.code).toBe(code)
      }
    })

    test("switch at no-new, off the allowlist or on hold: no start, packed files still offered", async () => {
      const w = await hostedWorld(ledger)
      await endedWithDisk(w)
      const setSwitch = (value: string, changedAt: number) => {
        w.fakes.store.set(switchKey("hosted"), JSON.stringify({ value, changedAt, generation: `g${changedAt}` }))
        w.advance(31_000) // past the switch's 30-second cache
        w.setSnapshot({})
      }
      // Nothing packed yet: no-new leaves nothing to offer.
      setSwitch("no-new", 1)
      expect((await status(w)).kept).toBeUndefined()
      setSwitch("on", 2)
      const id = await packed(w)
      const ready = { computer: 1, session: expect.objectContaining({ id, download: expect.objectContaining({}) }) }
      setSwitch("no-new", 3)
      expect((await status(w)).kept).toMatchObject({ state: "closed", disks: [ready] })
      expect((await action(w, id, "download")).status).toBe(200)
      setSwitch("on", 4)
      expect((await status(w)).kept.state).toBe("open")
      // Off the owner's list before `computer` is listed: closed, the link still given.
      process.env.VECTOR_HOSTED_ALLOW_ACCOUNTS = ""
      expect((await status(w)).kept).toMatchObject({ state: "closed", disks: [ready] })
      expect((await action(w, id, "download")).status).toBe(200)
      process.env.VECTOR_HOSTED_ALLOW_ACCOUNTS = ACCOUNT_ID
      expect((await flags(w, { action: "suspend", account: ACCOUNT_ID, reason: "check" })).body.onHold).toBe(true)
      const held = await status(w)
      expect(held).toMatchObject({ onHold: true, kept: { state: "closed", disks: [ready] } })
      expect((await action(w, id, "download")).status).toBe(200)
      // A refunded plan's packed files are offered too (requestDownload gives their link), never a start.
      await flags(w, { action: "release", account: ACCOUNT_ID })
      w.setSnapshot({ state: "ended", reason: "refunded" })
      expect((await status(w)).kept).toMatchObject({ state: "closed", disks: [ready] })
    })

    test("each computer's session: the live download, else the newest packed, else the newest download", async () => {
      const w = await hostedWorld(ledger)
      await endedWithDisk(w)
      const ready = await packed(w)
      // A newer download that ended without files does not hide the packed ones.
      const failed = (await startDownload(w)).body.session as Hosted.SessionView
      await action(w, failed.id, "stop")
      expect((await status(w)).kept.disks[0].session.id).toBe(ready)
      // While another runs, that one is the computer's session.
      const running = (await startDownload(w)).body.session as Hosted.SessionView
      expect((await status(w)).kept.disks[0].session.id).toBe(running.id)

      // A job session's packed files count: a copy of the same disk (H1a R11).
      const packJob = async (world: HostedWorld) => {
        const job = await started(world)
        await action(world, job.id, "download")
        await beat(world, job.id, {})
        const archived = await beat(world, job.id, { archiveBytes: 4096 })
        const key = decodeURIComponent(new URL(archived.body.upload.url).pathname.split("/").slice(2).join("/"))
        world.bucket.set(key, 4096)
        await beat(world, job.id, { uploaded: true })
        await action(world, job.id, "stop")
        return job
      }
      const jobs = await hostedWorld(ledger)
      const job = await packJob(jobs)
      await endedWithDisk(jobs)
      const kept = (await status(jobs)).kept
      expect(kept.state).toBe("open")
      expect(kept.disks).toEqual([{ computer: 1, session: expect.objectContaining({ id: job.id }) }])

      // Until a later job session starts on that computer: it may have changed the disk, so the packed files are out
      // of date and only a new start is offered.
      const later = await hostedWorld(ledger)
      await packJob(later)
      later.advance(MINUTE)
      const next = await started(later)
      await action(later, next.id, "stop")
      const due = (await endedWithDisk(later))!
      expect((await status(later)).kept).toEqual({ state: "open", until: due, disks: [{ computer: 1 }] })
    })
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
    // H1a: a download-only start names its one computer (ARGV[6]).
    const named = (session: string, computer: number) =>
      send(["EVAL", CLAIM, 1, lease, session, computer, now + 60_000, now, 86_400_000, computer]).then(Number)
    expect(await named("hs_d", 2)).toBe(0)
    expect(await named("hs_d", 3)).toBe(3)
    expect(await named("hs_d", 3)).toBe(3)
  })
})
