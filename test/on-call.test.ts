import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { handleCodiumOwner } from "../api/_lib/codium-owner-api"
import { codiumKeyIn } from "../api/_lib/codium-keys"
import { opsCall, syncOpsKillFlag } from "../api/_lib/ops-worker"
import { checkDomain, opsHostname, normalizeDomain, txtValue, type DomainCheck } from "../api/_lib/ops-domains"
import {
  dropOpsRepositories,
  eraseAccountOpsSettings,
  monitorUrl,
  opsDomainsDueKey,
  opsInstallationIndexKey,
  opsRepoIndexKey,
  opsSettingsKey,
  readOpsSettings,
  registerRepoBindingReader,
  updateOpsSettings,
  newOpsSettings,
  configHash,
  workerConfig,
  OPS_SETTINGS_LIMITS,
  OPS_SETTINGS_SCRIPTS,
} from "../api/_lib/ops-settings"
import { SafeFetchError, type SafeTransport } from "../api/_lib/safe-fetch"
import { handleOpsDomains } from "../api/ops/domains"
import { handleOpsMonitors } from "../api/ops/monitors"
import { handleOpsRepos } from "../api/ops/repos"
import { probeTarget, validHostname } from "../packages/ops-worker/src/ssrf"
import {
  CRON_SECRET,
  DAY,
  invoke,
  MAX,
  NOW,
  OpsWorld,
  OTHER,
  OWNER_EMAIL,
  PHONE,
  PRO,
  FREE,
  ULTRA,
  type Answer,
} from "./ops-fixture"

// WP A47: On Call's and Release Guard's settings. Domains are verified by a DNS TXT record read over DNS-over-HTTPS or by
// a well-known file fetched under S8, and checked again weekly by the daily job; monitors stay within the plan's caps
// and on verified domains; repositories are set up only while bound to the account. After every change the ops
// Worker (A46's own code, in memory) gets the account's verified domains and monitors. S1: every count comes from the
// snapshot. S3: run tokens are refused. The store, the account service, DNS and the sites are fakes.

let world: OpsWorld
beforeEach(() => {
  world = new OpsWorld()
  files.clear()
  addresses = ["93.184.216.34"]
})
afterEach(() => world.close())

// The well-known files, by URL, as safeFetch's connection answers them (its resolver and transport replaced).
const files = new Map<string, { status: number; body?: string; location?: string } | "timeout">()
let addresses = ["93.184.216.34"]
const transport: SafeTransport = async (request) => {
  const file = files.get(request.url.href)
  if (file === "timeout") throw new SafeFetchError("timeout", "The address did not answer in time.")
  if (!file) return { status: 404, headers: {}, body: new Uint8Array() }
  return {
    status: file.status,
    headers: file.location ? { location: file.location } : {},
    body: new TextEncoder().encode(file.body ?? ""),
  }
}
const check = (domain: string, token: string): Promise<DomainCheck> =>
  checkDomain(domain, token, { fetcher: world.fetcher(), safe: { resolve: async () => addresses, transport } })

const domains = (authorization: string | undefined, method: string, body?: unknown, origin?: string) =>
  invoke((request, response) => handleOpsDomains(request, response, world.fetcher(), () => world.now, { check }), {
    method,
    ...(authorization ? { authorization } : {}),
    ...(origin ? { origin } : {}),
    ...(body !== undefined ? { body } : {}),
  })
const monitors = (authorization: string | undefined, method: string, body?: unknown) =>
  invoke((request, response) => handleOpsMonitors(request, response, world.fetcher(), () => world.now), {
    method,
    ...(authorization ? { authorization } : {}),
    ...(body !== undefined ? { body } : {}),
  })
const repos = (authorization: string | undefined, method: string, body?: unknown) =>
  invoke((request, response) => handleOpsRepos(request, response, world.fetcher(), () => world.now), {
    method,
    ...(authorization ? { authorization } : {}),
    ...(body !== undefined ? { body } : {}),
  })
const cron = (secret = CRON_SECRET) =>
  invoke((request, response) => handleOpsDomains(request, response, world.fetcher(), () => world.now, { check }), {
    method: "GET",
    authorization: secret,
  })

/** Adds and verifies a domain by its TXT record; answers the domain's view. */
async function verified(account: string, domain: string) {
  const token = world.token(account)
  const added = await domains(token, "POST", { domain })
  expect(added.status).toBe(200)
  world.publish(domain, added.body.domain.record.txt.value)
  const answer = await domains(token, "POST", { domain, verify: true })
  expect(answer).toMatchObject({ status: 200, body: { result: "verified", domain: { status: "verified" } } })
  return answer.body.domain
}

/** What the Worker holds for the account, asked through the API's own signed call. */
async function workerState(account: string) {
  return (await opsCall("state", { account }, world.fetcher(), world.now)) as {
    monitors: { id: string; probed: boolean; verified: boolean }[]
  }
}

function lastConfig(account: string) {
  return world.worker.bodies.filter((body) => body.account === account && "monitors" in body).at(-1) as
    | { domains: string[]; monitors: { id: string; url: string }[] }
    | undefined
}

function error(answer: Answer) {
  return answer.body?.error
}

// ── Domains ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("domains", () => {
  test("an account adds a domain and gets the record to publish; adding it again answers the same one", async () => {
    world.seed(MAX, "vector-100")
    const first = await domains(world.token(MAX), "POST", { domain: " Shop.Example.COM. " })
    expect(first.status).toBe(200)
    expect(first.body.domain).toEqual({
      domain: "shop.example.com",
      status: "pending",
      overLimit: false,
      record: {
        txt: {
          name: "_vector-verify.shop.example.com",
          value: expect.stringMatching(/^vector-verify=[A-Za-z0-9_-]{32}$/),
        },
        file: {
          url: "https://shop.example.com/.well-known/vector-verify.txt",
          body: expect.stringMatching(/^vector-verify=[A-Za-z0-9_-]{32}$/),
        },
      },
    })
    expect(first.body.domain.record.file.body).toBe(first.body.domain.record.txt.value)
    const again = await domains(world.token(MAX), "POST", { domain: "shop.example.com" })
    expect(again.body.domain.record).toEqual(first.body.domain.record)
    const listed = await domains(world.token(MAX), "GET")
    expect(listed).toMatchObject({ status: 200, body: { limits: { domains: 3 }, synced: true } })
    expect(listed.body.domains).toEqual([first.body.domain])
    // Nothing is verified yet, so the Worker has nothing to hold.
    expect(world.worker.actions).toEqual([])
  })

  test("refuses anything that is not a host name the Worker may probe, and stores international names as ASCII", async () => {
    world.seed(MAX, "vector-100")
    for (const domain of [
      "https://shop.example.com",
      "shop.example.com/path",
      "203.0.113.10",
      "[2001:db8::1]",
      "localhost",
      "intranet",
      "db.internal",
      "printer.local",
      "site.test",
      "shop.example",
      "a b.com",
      "-bad.example.com",
      "",
      42,
    ])
      expect(error(await domains(world.token(MAX), "POST", { domain }))).toMatchObject({ code: "OPS_INVALID" })
    const answer = await domains(world.token(MAX), "POST", { domain: "Bücher.example.com" })
    expect(answer.body.domain.domain).toBe("xn--bcher-kva.example.com")
    expect(normalizeDomain("xn--bcher-kva.example.com")).toBe("xn--bcher-kva.example.com")
  })

  test("the plan's domain count holds: three on Max, ten on Ultra", async () => {
    world.seed(MAX, "vector-100")
    for (const name of ["a", "b", "c"])
      expect((await domains(world.token(MAX), "POST", { domain: `${name}.example.com` })).status).toBe(200)
    expect(await domains(world.token(MAX), "POST", { domain: "d.example.com" })).toMatchObject({
      status: 429,
      body: { error: { code: "OPS_LIMIT", limit: "domains", max: 3 } },
    })
    world.seed(ULTRA, "vector-200")
    for (let index = 0; index < 10; index++)
      expect((await domains(world.token(ULTRA), "POST", { domain: `u${index}.example.com` })).status).toBe(200)
    expect(error(await domains(world.token(ULTRA), "POST", { domain: "u10.example.com" }))).toMatchObject({
      code: "OPS_LIMIT",
      max: 10,
    })
  })

  test("S1: only Max and Ultra, active or renewing, can add; the snapshot decides, never the request", async () => {
    const add = (account: string) => domains(world.token(account), "POST", { domain: "shop.example.com", plan: "x" })
    // An unknown field is refused before anything else.
    expect(error(await add(MAX))).toMatchObject({ code: "OPS_INVALID" })
    const plain = (account: string) => domains(world.token(account), "POST", { domain: "shop.example.com" })
    expect(error(await plain(FREE))).toMatchObject({ code: "MODEL_PLAN_REQUIRED" })
    world.seed(PRO, "vector-50")
    expect(await plain(PRO)).toMatchObject({
      status: 403,
      body: { error: { code: "CODIUM_PERK_REQUIRED", perk: "ops", plan: "vector-100" } },
    })
    world.seed(MAX, "vector-100", "paused")
    expect(error(await plain(MAX))).toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    world.seed(MAX, "vector-100", "frozen")
    expect(error(await plain(MAX))).toMatchObject({ code: "MODEL_PLAN_BLOCKED" })
    world.seed(MAX, "vector-100", "ended")
    expect(error(await plain(MAX))).toMatchObject({ code: "MODEL_PLAN_REQUIRED" })
    world.seed(MAX, "vector-100", "renewing")
    expect((await plain(MAX)).status).toBe(200)
  })

  test("S3 and sign-in: run tokens and missing credentials get 401; account tokens and sessions work", async () => {
    world.seed(MAX, "vector-100")
    for (const authorization of [undefined, "vrt_fixture_run_token", "vht_fixture_hosted_token", "not-a-session"])
      expect((await domains(authorization, "GET")).status).toBe(401)
    expect((await domains("vrt_fixture_run_token", "POST", { domain: "shop.example.com" })).status).toBe(401)
    for (const client of ["desktop", "cli", "unmarked"] as const)
      expect((await domains(world.token(MAX, client), "GET")).status).toBe(200)
    expect((await domains(world.session(MAX), "POST", { domain: "shop.example.com" }, PHONE)).status).toBe(200)
    expect(
      error(await domains(world.session(MAX), "POST", { domain: "shop.example.com" }, "https://evil.invalid")),
    ).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    })
  })

  test("the service: unconfigured is OPS_UNAVAILABLE and the owner's switch off is OPS_PAUSED; reading and removing still work", async () => {
    world.seed(MAX, "vector-100")
    expect((await domains(world.token(MAX), "POST", { domain: "shop.example.com" })).status).toBe(200)
    world.switchOff("ops")
    expect(await domains(world.token(MAX), "POST", { domain: "two.example.com" })).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_PAUSED" } },
    })
    delete process.env.VECTOR_OPS_ENABLED
    expect(error(await domains(world.token(MAX), "POST", { domain: "two.example.com" }))).toMatchObject({
      code: "OPS_UNAVAILABLE",
    })
    expect((await domains(world.token(MAX), "GET")).body.domains).toHaveLength(1)
    expect(await domains(world.token(MAX), "DELETE", { domain: "shop.example.com" })).toMatchObject({
      status: 200,
      body: { removed: true },
    })
  })
})

describe("listing", () => {
  test("adding needs the perk it serves listed, or the owner's allowlist; reading and removing work regardless", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.bind(42, MAX)
    const off = { status: 503, body: { error: { code: "OPS_UNAVAILABLE" } } }
    const repo = {
      repositoryId: 42,
      environment: "Production",
      productionUrl: "https://shop.example.com",
      paths: ["/"],
      releaseGuard: true,
      shipDesk: false,
    }
    // Nothing listed (VECTOR_OPS_ENABLED and the App come before listing): a Max subscriber calling directly gets 503.
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await domains(world.token(MAX), "POST", { domain: "two.example.com" })).toMatchObject(off)
    expect(await domains(world.token(MAX), "POST", { domain: "shop.example.com", verify: true })).toMatchObject(off)
    expect(await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })).toMatchObject(off)
    expect(await repos(world.token(MAX), "POST", repo)).toMatchObject(off)
    expect(await repos(world.token(MAX), "POST", { ...repo, releaseGuard: false })).toMatchObject(off)
    expect((await domains(world.token(MAX), "GET")).body.domains).toHaveLength(1)
    expect(lastConfig(MAX)?.monitors ?? []).toEqual([])
    // Release Guard listed: domains (its production URL) and its repositories, not monitors or Ship Desk.
    process.env.CODIUM_LISTED_PERKS = "release-guard"
    expect((await domains(world.token(MAX), "POST", { domain: "two.example.com" })).status).toBe(200)
    expect(await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })).toMatchObject(off)
    expect((await repos(world.token(MAX), "POST", repo)).status).toBe(200)
    expect(await repos(world.token(MAX), "POST", { ...repo, shipDesk: true })).toMatchObject(off)
    // The owner's allowlist lets an account try what is not listed yet; the plan still decides.
    process.env.VECTOR_OPS_ALLOW_ACCOUNTS = `${MAX},not-an-account`
    expect((await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })).status).toBe(200)
    expect((await repos(world.token(MAX), "POST", { ...repo, shipDesk: true })).status).toBe(200)
    process.env.VECTOR_OPS_ALLOW_ACCOUNTS = PRO
    world.seed(PRO, "vector-50")
    expect(error(await monitors(world.token(PRO), "POST", { url: "https://shop.example.com/health" }))).toMatchObject({
      code: "CODIUM_PERK_REQUIRED",
    })
    // Removing works whatever the listing.
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    delete process.env.CODIUM_LISTED_PERKS
    expect(await domains(world.token(MAX), "DELETE", { domain: "two.example.com" })).toMatchObject({
      status: 200,
      body: { removed: true },
    })
    expect((await repos(world.token(MAX), "DELETE", { repositoryId: 42 })).body).toEqual({ removed: true })
  })
})

// ── Verification ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("verification", () => {
  test("a TXT record verifies a domain, read over DNS-over-HTTPS, and the Worker gets the verified domain", async () => {
    world.seed(MAX, "vector-100")
    const token = world.token(MAX)
    const added = await domains(token, "POST", { domain: "shop.example.com" })
    // Not published yet: both ways answer that the token is not there.
    expect((await domains(token, "POST", { domain: "shop.example.com", verify: true })).body).toMatchObject({
      result: "failed",
      domain: { status: "pending" },
    })
    world.publish("shop.example.com", added.body.domain.record.txt.value)
    const answer = await domains(token, "POST", { domain: "shop.example.com", verify: true })
    expect(answer.body).toMatchObject({
      result: "verified",
      synced: true,
      domain: { status: "verified", method: "dns", verifiedAt: NOW, nextCheckAt: NOW + 7 * DAY },
    })
    expect(lastConfig(MAX)).toEqual({ account: MAX, domains: ["shop.example.com"], monitors: [] })
    expect((await domains(token, "GET")).body.synced).toBe(true)
    // A domain that is not on the account cannot be checked.
    expect(error(await domains(token, "POST", { domain: "other.example.com", verify: true }))).toMatchObject({
      code: "OPS_NOT_FOUND",
    })
  })

  test("a TXT value split into quoted strings is read whole; another value is not the token", async () => {
    expect(txtValue('"vector-verify=" "abc"')).toBe("vector-verify=abc")
    expect(txtValue('"a \\"quoted\\" value"')).toBe('a "quoted" value')
    expect(txtValue("plain")).toBe("plain")
    world.seed(MAX, "vector-100")
    const added = await domains(world.token(MAX), "POST", { domain: "shop.example.com" })
    const value: string = added.body.domain.record.txt.value
    world.txt.set("_vector-verify.shop.example.com", ['"v=spf1 -all"', `"${value.slice(0, 20)}" "${value.slice(20)}"`])
    expect((await domains(world.token(MAX), "POST", { domain: "shop.example.com", verify: true })).body.result).toBe(
      "verified",
    )
  })

  test("the well-known file verifies a domain; a redirect, another token or a private address does not", async () => {
    world.seed(ULTRA, "vector-200")
    const token = world.token(ULTRA)
    const record = async (domain: string) => (await domains(token, "POST", { domain })).body.domain.record
    const verify = async (domain: string) => (await domains(token, "POST", { domain, verify: true })).body

    const good = await record("good.example.com")
    files.set(good.file.url, { status: 200, body: `# Vector\n${good.file.body}\n` })
    expect(await verify("good.example.com")).toMatchObject({ result: "verified", domain: { method: "http" } })

    const moved = await record("moved.example.com")
    files.set(moved.file.url, { status: 301, location: "https://elsewhere.example.net/token.txt" })
    expect((await verify("moved.example.com")).result).toBe("failed")

    const wrong = await record("wrong.example.com")
    files.set(wrong.file.url, { status: 200, body: "vector-verify=someone-elses-token-0000000000" })
    expect((await verify("wrong.example.com")).result).toBe("failed")

    const inside = await record("inside.example.com")
    files.set(inside.file.url, { status: 200, body: inside.file.body })
    addresses = ["10.0.0.7"]
    expect((await verify("inside.example.com")).result).toBe("failed")
    addresses = ["93.184.216.34"]

    // Neither way could be read: nothing changes.
    await record("flaky.example.com")
    world.txt.set("_vector-verify.flaky.example.com", "fail")
    files.set("https://flaky.example.com/.well-known/vector-verify.txt", { status: 503 })
    expect(await verify("flaky.example.com")).toMatchObject({ result: "inconclusive", domain: { status: "pending" } })
    files.set("https://flaky.example.com/.well-known/vector-verify.txt", "timeout")
    world.txt.set("_vector-verify.flaky.example.com", { status: 2 })
    expect((await verify("flaky.example.com")).result).toBe("inconclusive")
  })

  test("the Worker's verification order is first verified first; past the plan's count is marked, not dropped", async () => {
    world.seed(ULTRA, "vector-200")
    for (const name of ["d1", "d2", "d3", "d4"]) {
      await verified(ULTRA, `${name}.example.com`)
      world.advance(1000)
    }
    expect(lastConfig(ULTRA)?.domains).toEqual(["d1.example.com", "d2.example.com", "d3.example.com", "d4.example.com"])
    // Down to Max: three domains. The earliest keep their places.
    world.seed(ULTRA, "vector-100")
    const listed = await domains(world.token(ULTRA), "GET")
    expect(listed.body.limits).toEqual({ domains: 3 })
    expect(listed.body.domains.map((domain: { overLimit: boolean }) => domain.overLimit)).toEqual([
      false,
      false,
      false,
      true,
    ])
  })
})

// ── Monitors ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("monitors", () => {
  test("a monitor needs a verified domain and stays within the plan's URL count; the Worker gets each change", async () => {
    world.seed(MAX, "vector-100")
    await world.worker.plan(MAX, "vector-100")
    const token = world.token(MAX)
    expect(await monitors(token, "POST", { url: "https://shop.example.com/health" })).toMatchObject({
      status: 403,
      body: { error: { code: "OPS_DOMAIN_UNVERIFIED", domain: "shop.example.com" } },
    })
    await verified(MAX, "shop.example.com")
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      const answer = await monitors(token, "POST", { url: `https://shop.example.com/page-${index}` })
      expect(answer).toMatchObject({
        status: 200,
        body: { synced: true, monitor: { domainVerified: true, checked: true } },
      })
      ids.push(answer.body.monitor.id)
    }
    expect(await monitors(token, "POST", { url: "https://shop.example.com/page-5" })).toMatchObject({
      status: 429,
      body: { error: { code: "OPS_LIMIT", limit: "urls", max: 5 } },
    })
    expect(ids.every((id) => /^mon_[A-Za-z0-9_-]{16}$/.test(id))).toBe(true)
    const state = await workerState(MAX)
    expect(state.monitors.map((monitor) => [monitor.id, monitor.probed, monitor.verified])).toEqual(
      ids.map((id) => [id, true, true]),
    )
    const listed = await monitors(token, "GET")
    expect(listed.body).toMatchObject({ limits: { urls: 5, intervalSec: 300 }, synced: true })
    expect(listed.body.monitors).toHaveLength(5)
  })

  test("refuses URLs the Worker would refuse", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    for (const url of [
      "http://shop.example.com/",
      "https://shop.example.com:8443/",
      "https://user:secret@shop.example.com/",
      "https://203.0.113.9/",
      "javascript:alert(1)",
      `https://shop.example.com/${"a".repeat(2100)}`,
      "",
      7,
    ])
      expect(error(await monitors(world.token(MAX), "POST", { url }))).toMatchObject({ code: "OPS_INVALID" })
  })

  test("the same URL twice is one monitor; removing works whatever the plan, and the Worker follows", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    const first = await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health#top" })
    expect(first.body.monitor.url).toBe("https://shop.example.com/health")
    const again = await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })
    expect(again.body.monitor.id).toBe(first.body.monitor.id)
    world.seed(MAX, "vector-100", "ended")
    expect(await monitors(world.token(MAX), "DELETE", { id: first.body.monitor.id })).toMatchObject({
      status: 200,
      body: { removed: true, synced: true },
    })
    expect(lastConfig(MAX)?.monitors).toEqual([])
    expect((await monitors(world.token(MAX), "DELETE", { id: first.body.monitor.id })).body).toEqual({
      removed: false,
      synced: true,
    })
    expect((await monitors(world.token(MAX), "GET")).body).toMatchObject({ monitors: [], limits: null })
  })

  test("an unreachable Worker leaves the change saved and says so; the daily job sends it later", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.worker.down = true
    const added = await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })
    expect(added).toMatchObject({ status: 200, body: { synced: false } })
    expect((await monitors(world.token(MAX), "GET")).body.synced).toBe(false)
    world.worker.down = false
    expect((await cron()).body).toMatchObject({ enabled: true, accounts: 0 })
    world.advance(16 * 60_000)
    expect((await cron()).body).toMatchObject({ enabled: true, accounts: 1, checked: 0, workerUpdates: 1 })
    expect((await monitors(world.token(MAX), "GET")).body.synced).toBe(true)
    expect(lastConfig(MAX)?.monitors.map((monitor) => monitor.url)).toEqual(["https://shop.example.com/health"])
  })
})

describe("removing a domain", () => {
  test("removes the monitors on it and updates the Worker, whatever the plan or the switch", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "a.example.com")
    await verified(MAX, "b.example.com")
    await monitors(world.token(MAX), "POST", { url: "https://a.example.com/health" })
    await monitors(world.token(MAX), "POST", { url: "https://b.example.com/health" })
    world.seed(MAX, "vector-100", "ended")
    world.switchOff("ops")
    expect(await domains(world.token(MAX), "DELETE", { domain: "a.example.com" })).toMatchObject({
      status: 200,
      body: { removed: true, synced: true },
    })
    expect(lastConfig(MAX)).toMatchObject({
      domains: ["b.example.com"],
      monitors: [{ url: "https://b.example.com/health" }],
    })
    expect((await domains(world.token(MAX), "DELETE", { domain: "a.example.com" })).body.removed).toBe(false)
  })
})

// ── Weekly re-verification ──────────────────────────────────────────────────────────────────────────────────────────

describe("weekly re-verification", () => {
  test("a verified domain is checked again a week after its last success, by the daily job", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.advance(6 * DAY)
    expect((await cron()).body).toMatchObject({ accounts: 0, checked: 0 })
    world.advance(DAY)
    expect((await cron()).body).toMatchObject({ accounts: 1, checked: 1, verified: 1, lost: 0, workerUpdates: 0 })
    world.seed(MAX, "vector-100")
    const listed = await domains(world.token(MAX), "GET")
    expect(listed.body.domains[0]).toMatchObject({
      status: "verified",
      verifiedAt: world.now,
      nextCheckAt: world.now + 7 * DAY,
    })
  })

  test("a record that is gone ends verification at the next check; the Worker stops using the domain", async () => {
    world.seed(MAX, "vector-100")
    await world.worker.plan(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    await monitors(world.token(MAX), "POST", { url: "https://shop.example.com/health" })
    world.txt.delete("_vector-verify.shop.example.com")
    world.advance(7 * DAY)
    expect((await cron()).body).toMatchObject({ checked: 1, verified: 0, lost: 1, workerUpdates: 1 })
    expect(lastConfig(MAX)).toMatchObject({ domains: [], monitors: [{ url: "https://shop.example.com/health" }] })
    expect((await workerState(MAX)).monitors[0]).toMatchObject({ verified: false, probed: false })
    world.seed(MAX, "vector-100")
    const listed = await domains(world.token(MAX), "GET")
    expect(listed.body.domains[0]).toMatchObject({ status: "lost" })
    expect(listed.body.domains[0].nextCheckAt).toBeUndefined()
    expect((await monitors(world.token(MAX), "GET")).body.monitors[0]).toMatchObject({
      domainVerified: false,
      checked: false,
    })
    // Publishing the record again and asking restores it, at the end of the order.
    expect((await domains(world.token(MAX), "POST", { domain: "shop.example.com" })).status).toBe(200)
    world.publish("shop.example.com", listed.body.domains[0].record.txt.value)
    expect(
      (await domains(world.token(MAX), "POST", { domain: "shop.example.com", verify: true })).body.domain.status,
    ).toBe("verified")
  })

  test("a check that cannot be read keeps the domain, retried daily, for up to 14 days after the last success", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.txt.set("_vector-verify.shop.example.com", "fail")
    files.set("https://shop.example.com/.well-known/vector-verify.txt", { status: 503 })
    world.advance(7 * DAY)
    expect((await cron()).body).toMatchObject({ checked: 1, inconclusive: 1, lost: 0 })
    world.seed(MAX, "vector-100")
    expect((await domains(world.token(MAX), "GET")).body.domains[0]).toMatchObject({
      status: "verified",
      nextCheckAt: world.now + DAY,
    })
    for (let day = 8; day < 14; day++) {
      world.advance(DAY)
      expect((await cron()).body).toMatchObject({ checked: 1, inconclusive: 1, lost: 0 })
    }
    world.advance(DAY)
    expect((await cron()).body).toMatchObject({ checked: 1, inconclusive: 1, lost: 1, workerUpdates: 1 })
    expect(lastConfig(MAX)?.domains).toEqual([])
  })

  test("the job needs the cron secret; any other bearer is an account's request; unconfigured, it does nothing", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.advance(7 * DAY)
    expect((await cron("not-the-cron-secret")).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await cron()).status).toBe(401)
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.VECTOR_OPS_WORKER_URL
    expect((await cron()).body).toMatchObject({ enabled: false, accounts: 0 })
  })

  test("one account's unreadable settings never stop the others, and an account with no settings leaves the due set", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.seed(ULTRA, "vector-200")
    await verified(ULTRA, "ultra.example.com")
    world.fakes.store.set(opsSettingsKey(MAX), "{not settings")
    world.fakes.store.zset(opsDomainsDueKey()).set(PRO, world.now)
    world.advance(7 * DAY)
    expect((await cron()).body).toMatchObject({ accounts: 1, checked: 1, verified: 1, failures: 1 })
    expect(world.fakes.store.zset(opsDomainsDueKey()).has(PRO)).toBe(false)
    expect(world.fakes.store.zset(opsDomainsDueKey()).has(MAX)).toBe(true)
  })
})

// ── Repositories ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("repositories", () => {
  const setup = {
    repositoryId: 42,
    environment: "Production",
    productionUrl: "https://shop.example.com",
    paths: ["/", "/checkout"],
    releaseGuard: true,
    shipDesk: true,
  }

  test("a repository must be bound to the account; until bindings can be read, none can be set up", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    registerRepoBindingReader(undefined)
    expect(await repos(world.token(MAX), "POST", setup)).toMatchObject({
      status: 409,
      body: { error: { code: "OPS_REPO_NOT_BOUND" } },
    })
    expect((await repos(world.token(MAX), "GET")).body).toMatchObject({ available: false, repos: [] })
    registerRepoBindingReader(async (id) => world.bindings.get(id))
    world.bind(42, OTHER)
    expect(error(await repos(world.token(MAX), "POST", setup))).toMatchObject({ code: "OPS_REPO_NOT_BOUND" })
    world.bind(42, MAX, { suspended: "transferred" })
    expect(error(await repos(world.token(MAX), "POST", setup))).toMatchObject({ code: "OPS_REPO_NOT_BOUND" })
  })

  test("a bound repository is set up and answers the .vector/ops.json to commit", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.bind(42, MAX, { installationId: "77" })
    const answer = await repos(world.token(MAX), "POST", setup)
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      repo: {
        repositoryId: 42,
        repository: "octo-fixture/repo-42",
        environment: "Production",
        productionUrl: "https://shop.example.com/",
        paths: ["/", "/checkout"],
        releaseGuard: true,
        shipDesk: true,
        updatedAt: NOW,
        bound: true,
        overLimit: false,
      },
      opsJson: {
        opsId: expect.stringMatching(/^ops_[A-Za-z0-9_-]{22}$/),
        environment: "Production",
        productionUrl: "https://shop.example.com/",
        paths: ["/", "/checkout"],
        releaseGuard: true,
        shipDesk: true,
      },
      urls: ["https://shop.example.com/", "https://shop.example.com/checkout"],
    })
    const listed = await repos(world.token(MAX), "GET")
    expect(listed.body).toMatchObject({
      opsId: answer.body.opsJson.opsId,
      available: true,
      limits: { repos: 20, paths: 5 },
      repos: [{ repositoryId: 42, bound: true }],
    })
    expect(listed.body.repos[0].installationId).toBeUndefined()
    const store = world.fakes.store
    expect(store.live(opsRepoIndexKey(42))).toMatchObject({ kind: "set", value: new Set([MAX]) })
    expect(store.live(opsInstallationIndexKey(77))).toMatchObject({ kind: "set", value: new Set([MAX]) })
    // A later binding to another account shows the settings as no longer bound.
    world.bind(42, OTHER)
    expect((await repos(world.token(MAX), "GET")).body.repos[0].bound).toBe(false)
    // Repositories are not the Worker's: nothing was sent for them.
    expect(world.worker.actions).toEqual(["config"])
  })

  test("Release Guard needs the production URL on a verified domain; every field follows its rule", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.bind(42, MAX)
    const post = (change: Record<string, unknown>) => repos(world.token(MAX), "POST", { ...setup, ...change })
    expect(error(await post({ productionUrl: "https://other.example.com" }))).toMatchObject({
      code: "OPS_DOMAIN_UNVERIFIED",
      domain: "other.example.com",
    })
    for (const change of [
      { productionUrl: undefined },
      { productionUrl: "https://shop.example.com/?q=1" },
      { productionUrl: "http://shop.example.com" },
      { paths: ["/a", "/b", "/c", "/d", "/e", "/f"] },
      { paths: ["//evil.example.net"] },
      { paths: ["/a", "/a"] },
      { paths: ["relative"] },
      { environment: "" },
      { environment: " Production" },
      { releaseGuard: "yes" },
      { repositoryId: -1 },
      { owner: "someone" },
    ])
      expect(error(await post(change))).toMatchObject({ code: "OPS_INVALID" })
    // Ship Desk alone needs no production URL.
    expect(
      (await post({ productionUrl: undefined, paths: [], releaseGuard: false, shipDesk: true })).body.repo,
    ).toMatchObject({ releaseGuard: false, shipDesk: true, paths: [] })
  })

  test("at most 20 repositories; removing one works whatever the plan and clears its index", async () => {
    world.seed(ULTRA, "vector-200")
    for (let id = 1; id <= 21; id++) world.bind(id, ULTRA)
    const shipOnly = { environment: "Production", paths: [], releaseGuard: false, shipDesk: true }
    for (let id = 1; id <= 20; id++)
      expect((await repos(world.token(ULTRA), "POST", { ...shipOnly, repositoryId: id })).status).toBe(200)
    expect(await repos(world.token(ULTRA), "POST", { ...shipOnly, repositoryId: 21 })).toMatchObject({
      status: 429,
      body: { error: { code: "OPS_LIMIT", limit: "repos", max: 20 } },
    })
    // Changing a repository already there is not a new one.
    expect(
      (await repos(world.token(ULTRA), "POST", { ...shipOnly, repositoryId: 20, environment: "prod" })).status,
    ).toBe(200)
    world.seed(ULTRA, "vector-200", "frozen")
    expect(await repos(world.token(ULTRA), "DELETE", { repositoryId: 7 })).toMatchObject({
      status: 200,
      body: { removed: true },
    })
    expect(world.fakes.store.live(opsRepoIndexKey(7))).toBeUndefined()
    expect(world.fakes.store.live(opsRepoIndexKey(8))).toBeDefined()
  })
})

// ── The owner's switch ──────────────────────────────────────────────────────────────────────────────────────────────

describe("the ops switch", () => {
  const OWNER = OWNER_EMAIL
  const OWNER_ID = "0e0e0e0e-0000-4000-8000-0000000000aa"
  function ownerToken() {
    const claims = {
      amr: [{ method: "oauth", timestamp: Math.floor(world.now / 1000) }],
      iat: Math.floor(world.now / 1000),
    }
    const token = `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`
    world.sessions.set(token, { id: OWNER_ID, email: OWNER, google: true })
    return token
  }
  const ownerSwitch = (value: "on" | "off") =>
    invoke((request, response) => handleCodiumOwner(request, response, "switch", world.fetcher(), world.now), {
      method: "POST",
      authorization: ownerToken(),
      origin: "https://vectordev.ai",
      body: { name: "ops", value },
    })

  test("off sets the Worker's kill flag and on clears it; an unreachable Worker is reported, not undone", async () => {
    expect(await ownerSwitch("off")).toMatchObject({ status: 200, body: { accepted: true, worker: "updated" } })
    expect(world.worker.kv.values.get("kill")).toBe("1")
    expect((await ownerSwitch("on")).body).toMatchObject({ worker: "updated" })
    expect(world.worker.kv.values.has("kill")).toBe(false)
    world.worker.down = true
    expect((await ownerSwitch("off")).body).toMatchObject({ accepted: true, worker: "failed" })
    delete process.env.VECTOR_OPS_WORKER_URL
    expect(await syncOpsKillFlag(true, world.fetcher(), world.now)).toBe("not-configured")
  })
})

// ── The API and the Worker agree ────────────────────────────────────────────────────────────────────────────────────

describe("the API's rules are the Worker's", () => {
  test("host names and URLs the API accepts are exactly the ones the Worker probes", () => {
    const hosts = [
      "example.com",
      "shop.example.com",
      "xn--bcher-kva.example.com",
      "a-b.c-d.example.org",
      "localhost",
      "metadata.google.internal",
      "x.localhost",
      "printer.local",
      "db.internal",
      "1.0.0.10.in-addr.arpa",
      "router.home",
      "nas.lan",
      "wiki.intranet",
      "box.localdomain",
      "nothing.invalid",
      "site.test",
      "shop.example",
      "single",
      "203.0.113.10",
      "1.2.3.4.5",
      "-bad.example.com",
      "bad-.example.com",
      "UPPER.example.com",
      `${"a".repeat(64)}.example.com`,
      "",
    ]
    for (const host of hosts) expect([host, opsHostname(host)]).toEqual([host, validHostname(host)])
    const urls = [
      "https://shop.example.com/health",
      "https://shop.example.com:443/",
      "https://shop.example.com:8443/",
      "http://shop.example.com/",
      "https://user@shop.example.com/",
      "https://[2001:db8::1]/",
      "https://0x7f.0.0.1/",
      "https://2130706433/",
      "https://shop.example.com/a#b",
      "ftp://shop.example.com/",
      "not a url",
    ]
    for (const url of urls) {
      const target = probeTarget(url)
      expect([url, monitorUrl(url)]).toEqual([url, target.ok ? target.url : undefined])
    }
  })
})

// ── Account deletion and removals ───────────────────────────────────────────────────────────────────────────────────

describe("erasing and dropping", () => {
  test("account deletion erases the settings and their index entries in both modes (P5)", async () => {
    world.seed(MAX, "vector-100")
    await verified(MAX, "shop.example.com")
    world.bind(42, MAX, { installationId: "77" })
    await repos(world.token(MAX), "POST", {
      repositoryId: 42,
      environment: "Production",
      productionUrl: "https://shop.example.com",
      paths: [],
      releaseGuard: true,
      shipDesk: false,
    })
    // The same account's record under the live prefix too, as a live server would have written it.
    world.fakes.store.set(opsSettingsKey(MAX, "live"), world.fakes.store.get(opsSettingsKey(MAX))!)
    world.fakes.store.members(codiumKeyIn("live", "ops", "repo", 42)).add(MAX)
    await eraseAccountOpsSettings(MAX, world.fetcher())
    const left = world.fakes.store.keys().filter((key) => key.includes(":ops:"))
    expect(left).toEqual([])
    expect(world.fakes.store.live(opsDomainsDueKey())).toBeUndefined()
  })

  test("dropping repositories reaches every account that has them, and removes stale index entries", async () => {
    world.seed(MAX, "vector-100")
    world.seed(ULTRA, "vector-200")
    world.bind(42, MAX)
    await repos(world.token(MAX), "POST", {
      repositoryId: 42,
      environment: "Production",
      releaseGuard: false,
      shipDesk: true,
    })
    world.bind(42, ULTRA)
    await repos(world.token(ULTRA), "POST", {
      repositoryId: 42,
      environment: "Production",
      releaseGuard: false,
      shipDesk: true,
    })
    // A stale entry: an account whose settings no longer have the repository.
    world.fakes.store.members(opsRepoIndexKey(42)).add(OTHER)
    await updateOpsSettings(OTHER, () => newOpsSettings(), world.fetcher(), world.now)
    expect(await dropOpsRepositories({ repositoryIds: [42] }, world.fetcher(), world.now)).toBe(2)
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.repos).toEqual([])
    expect((await readOpsSettings(ULTRA, world.fetcher())).settings?.repos).toEqual([])
    expect(world.fakes.store.live(opsRepoIndexKey(42))).toBeUndefined()
  })

  test("a concurrent change is retried, and a stored document that is not settings is refused", async () => {
    world.seed(MAX, "vector-100")
    let calls = 0
    await updateOpsSettings(
      MAX,
      (current) => {
        calls++
        // The first attempt loses the race to another write.
        if (calls === 1)
          world.fakes.store.set(opsSettingsKey(MAX), JSON.stringify({ ...newOpsSettings(), revision: 5 }))
        return { ...(current ?? newOpsSettings()), domains: [] }
      },
      world.fetcher(),
      world.now,
    )
    expect(calls).toBe(2)
    expect((await readOpsSettings(MAX, world.fetcher())).settings?.revision).toBe(6)
    world.fakes.store.set(opsSettingsKey(MAX), JSON.stringify({ v: 1, opsId: "nope" }))
    expect(error(await domains(world.token(MAX), "GET"))).toMatchObject({ code: "OPS_SETTINGS_UNREADABLE" })
  })
})

// ── On Valkey (CI) ──────────────────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("A47's store scripts on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    return Response.json({ result: (await client!.send(String(command[0]), command.slice(1).map(String))) ?? null })
  }) as typeof fetch
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("compare-and-set, the indexes, the due set, dropping and erasing", async () => {
    const base = newOpsSettings()
    const repo = (repositoryId: number, installationId?: number) => ({
      repositoryId,
      repository: `octo/r${repositoryId}`,
      environment: "Production",
      paths: [],
      releaseGuard: false,
      shipDesk: true,
      ...(installationId ? { installationId } : {}),
      updatedAt: NOW,
    })
    const domain = {
      domain: "shop.example.com",
      token: "t".repeat(32),
      addedAt: NOW,
      since: NOW,
      verifiedAt: NOW,
      method: "dns" as const,
    }
    await updateOpsSettings(MAX, () => ({ ...base, domains: [domain], repos: [repo(1, 9), repo(2)] }), fetcher, NOW)
    await updateOpsSettings(ULTRA, () => ({ ...newOpsSettings(), repos: [repo(2, 9)] }), fetcher, NOW)
    expect((await client!.send("SMEMBERS", [opsRepoIndexKey(2)])).sort()).toEqual([MAX, ULTRA].sort())
    expect((await client!.send("SMEMBERS", [opsInstallationIndexKey(9)])).sort()).toEqual([MAX, ULTRA].sort())
    // The Worker has not been sent the domain yet, so its retry comes before the weekly re-check.
    expect(Number(await client!.send("ZSCORE", [opsDomainsDueKey(), MAX]))).toBe(NOW + OPS_SETTINGS_LIMITS.resyncMs)
    await updateOpsSettings(
      MAX,
      (current) => ({ ...current!, synced: configHash(workerConfig(MAX, current!, NOW)) }),
      fetcher,
      NOW,
    )
    expect(Number(await client!.send("ZSCORE", [opsDomainsDueKey(), MAX]))).toBe(NOW + 7 * DAY)
    // A stale expected value writes nothing.
    const result = await fetcher("https://kv.invalid", {
      method: "POST",
      body: JSON.stringify([
        "EVAL",
        OPS_SETTINGS_SCRIPTS.SAVE,
        "2",
        opsSettingsKey(MAX),
        opsDomainsDueKey(),
        "stale",
        "",
        MAX,
        "",
      ]),
    }).then((response) => response.json())
    expect(result).toEqual({ result: 0 })
    expect(await dropOpsRepositories({ repositoryIds: [], installationId: 9 }, fetcher, NOW)).toBe(2)
    expect((await readOpsSettings(MAX, fetcher)).settings?.repos.map((item) => item.repositoryId)).toEqual([2])
    expect(await client!.send("EXISTS", [opsInstallationIndexKey(9)])).toBe(0)
    expect(await client!.send("SMEMBERS", [opsRepoIndexKey(2)])).toEqual([MAX])
    await eraseAccountOpsSettings(MAX, fetcher)
    expect(await client!.send("EXISTS", [opsSettingsKey(MAX)])).toBe(0)
    expect(await client!.send("EXISTS", [opsRepoIndexKey(2)])).toBe(0)
    expect(await client!.send("ZSCORE", [opsDomainsDueKey(), MAX])).toBeNull()
  })
})
