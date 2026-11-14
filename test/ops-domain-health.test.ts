import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { ops as opsProvisioner } from "../api/_lib/codium-provisioners"
import { snapshotKey } from "../api/_lib/codium-snapshot"
import {
  checkDomainHealth,
  dohRecords,
  healthFindings,
  judgeCertificate,
  nodeCertificateReader,
  opsHealthCheckedKey,
  RDAP_BOOTSTRAP,
  readHealth,
  readRegistration,
  resetRdapBootstrap,
  type CertificateReading,
  type DomainHealth,
  type HealthReaders,
} from "../api/_lib/ops-health"
import type { AlertSender } from "../api/_lib/ops-incidents"
import { newOpsSettings, opsSettingsKey, updateOpsSettings } from "../api/_lib/ops-settings"
import { handleOpsDomains } from "../api/ops/domains"
import type { EntitlementSnapshot } from "../packages/schema/src/codium-entitlements"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { CRON_SECRET, DAY, invoke, MAX, NOW, OpsWorld, ULTRA } from "./ops-fixture"

// WP A50: domain health in the daily `/api/ops/domains` job. For each account on the ops roster (paused included), each
// verified domain within its plan's count: the certificate over node:tls (to a checked public address only, S8), the
// registration over RDAP (from IANA's bootstrap file, no redirect followed) and DNS drift (name servers and CNAME over
// DNS-over-HTTPS). Findings show on the domain and alert the phone once each, titles only (P7). Every reader here is a
// fake or a table; nothing connects anywhere.

const HOST = "shop.example.com"

let world: OpsWorld
let alerts: { account: string; title: string; tag?: string; allowPaused?: boolean }[] = []
const recordAlert: AlertSender = async (account, alert, options) => {
  alerts.push({
    account,
    title: alert.title,
    ...(alert.tag ? { tag: alert.tag } : {}),
    allowPaused: options.allowPaused,
  })
  return { sent: 1, failed: 0, removed: 0 }
}

beforeEach(() => {
  world = new OpsWorld()
  alerts = []
  resetRdapBootstrap()
})
afterEach(() => {
  setSystemTime()
  world.close()
})

/** Readers driven by tables the test changes between runs. */
function tables() {
  const state = {
    certificate: new Map<string, CertificateReading>(),
    expires: new Map<string, number | undefined>(),
    ns: new Map<string, string[] | undefined>(),
    cname: new Map<string, string[] | undefined>(),
    reads: 0,
  }
  const readers: Required<HealthReaders> = {
    certificate: async (domain) => {
      state.reads++
      return state.certificate.get(domain) ?? { result: "unknown", reason: "unreachable" }
    },
    registration: async (domain) => {
      const zone = domain.split(".").slice(-2).join(".")
      return state.expires.has(zone)
        ? { result: "ok", zone, expiresAt: state.expires.get(zone) }
        : { result: "unknown" }
    },
    dns: async (name, type) => (type === "NS" ? state.ns.get(name) : (state.cname.get(name) ?? [])),
  }
  return { state, readers }
}

async function subscriber(account: string, plan: PlanId, state: EntitlementSnapshot["state"] = "active") {
  const to = world.snapshotFor(account, plan, state)
  world.fakes.store.set(snapshotKey(account), JSON.stringify(to))
  setSystemTime(new Date(world.now))
  await opsProvisioner.apply({ account, to, cause: "first_payment" }, world.fetcher())
  await updateOpsSettings(
    account,
    () => ({
      ...newOpsSettings(),
      domains: [
        { domain: HOST, token: "t".repeat(32), addedAt: world.now, verifiedAt: world.now, method: "dns" },
        { domain: "pending.example.com", token: "p".repeat(32), addedAt: world.now },
      ],
    }),
    world.fetcher(),
    world.now,
  )
}

const job = (readers: HealthReaders) =>
  invoke(
    (request, response) =>
      handleOpsDomains(request, response, world.fetcher(), () => world.now, { readers, alert: recordAlert }),
    { method: "GET", authorization: CRON_SECRET },
  )

describe("readings", () => {
  const certificate = (validTo: string, names = `DNS:${HOST}`) => ({
    valid_to: validTo,
    subject: { CN: HOST } as never,
    subjectaltname: names,
  })

  test("a certificate: its expiry, and whether it is expired, untrusted or for another name", () => {
    const later = "Feb  1 00:00:00 2027 GMT"
    expect(judgeCertificate(HOST, certificate(later), true, null, NOW)).toEqual({
      result: "ok",
      expiresAt: Date.parse(later),
    })
    expect(
      judgeCertificate(HOST, certificate("Nov  1 00:00:00 2026 GMT"), false, "CERT_HAS_EXPIRED", NOW),
    ).toMatchObject({
      result: "problem",
      problem: "expired",
    })
    expect(judgeCertificate(HOST, certificate(later), false, "SELF_SIGNED_CERT_IN_CHAIN", NOW)).toMatchObject({
      problem: "untrusted",
    })
    expect(judgeCertificate(HOST, certificate(later, "DNS:other.example.net"), true, null, NOW)).toMatchObject({
      problem: "name",
    })
    expect(judgeCertificate(HOST, certificate(later, "DNS:*.example.com"), true, null, NOW)).toMatchObject({
      result: "ok",
    })
    expect(judgeCertificate(HOST, undefined, false, null, NOW)).toEqual({ result: "unknown", reason: "unreachable" })
  })

  test("the TLS read refuses a private address before connecting, and an unresolvable name is unknown (S8)", async () => {
    for (const address of ["10.0.0.7", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"])
      expect(await nodeCertificateReader(async () => [address])(HOST)).toEqual({ result: "unknown", reason: "address" })
    expect(await nodeCertificateReader(async () => ["93.184.216.34", "192.168.1.1"])(HOST)).toEqual({
      result: "unknown",
      reason: "address",
    })
    expect(
      await nodeCertificateReader(async () => {
        throw new Error("NXDOMAIN")
      })(HOST),
    ).toEqual({ result: "unknown", reason: "unreachable" })
  })

  test("RDAP: IANA's bootstrap names the registry; the shortest name it knows; no redirect followed; read once a day", async () => {
    const requests: { url: string; redirect?: RequestRedirect }[] = []
    const fetcher = (async (input: string, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, redirect: init?.redirect })
      if (url === RDAP_BOOTSTRAP)
        return Response.json({
          services: [
            [["com", "net"], ["https://rdap.registry.example/com/v1/"]],
            [["uk"], ["https://rdap.uk-registry.example/"]],
            [["bad"], ["http://insecure.example/"]],
          ],
        })
      if (url === "https://rdap.registry.example/com/v1/domain/example.com")
        return Response.json({
          events: [
            { eventAction: "registration", eventDate: "2010-01-01T00:00:00Z" },
            { eventAction: "expiration", eventDate: "2026-11-20T00:00:00Z" },
          ],
        })
      if (url === "https://rdap.uk-registry.example/domain/co.uk") return new Response("{}", { status: 404 })
      if (url === "https://rdap.uk-registry.example/domain/example.co.uk") return Response.json({ events: [] })
      return new Response("{}", { status: 500 })
    }) as unknown as typeof fetch
    expect(await readRegistration("app.example.com", fetcher, NOW)).toEqual({
      result: "ok",
      zone: "example.com",
      expiresAt: Date.parse("2026-11-20T00:00:00Z"),
    })
    expect(await readRegistration("www.example.co.uk", fetcher, NOW)).toEqual({ result: "ok", zone: "example.co.uk" })
    expect(await readRegistration("shop.example.org", fetcher, NOW)).toEqual({ result: "unknown" })
    expect(await readRegistration("shop.example.bad", fetcher, NOW)).toEqual({ result: "unknown" })
    expect(requests.every((request) => request.redirect === "error")).toBe(true)
    expect(requests.filter((request) => request.url === RDAP_BOOTSTRAP)).toHaveLength(1)
    // A registry that fails is unknown, never a guess.
    expect(await readRegistration("x.example.net", fetcher, NOW)).toEqual({ result: "unknown" })
  })

  test("DNS-over-HTTPS: name servers and the domain's own CNAME; no such name is empty; a failed lookup is unknown", async () => {
    const answers = new Map<string, unknown>([
      [
        "example.com NS",
        {
          Status: 0,
          Answer: [
            { name: "example.com", type: 2, data: "NS2.Host.example." },
            { name: "example.com", type: 2, data: "ns1.host.example." },
          ],
        },
      ],
      [
        "shop.example.com CNAME",
        {
          Status: 0,
          Answer: [
            { name: "shop.example.com", type: 5, data: "edge.cdn.example." },
            { name: "edge.cdn.example", type: 5, data: "deeper.cdn.example." },
          ],
        },
      ],
      ["gone.example.com CNAME", { Status: 3 }],
      ["broken.example.com NS", { Status: 2 }],
    ])
    const fetcher = (async (input: string) => {
      const url = new URL(String(input))
      const answer = answers.get(`${url.searchParams.get("name")} ${url.searchParams.get("type")}`)
      return answer ? Response.json(answer) : new Response("down", { status: 502 })
    }) as unknown as typeof fetch
    expect(await dohRecords("example.com", "NS", fetcher)).toEqual(["ns1.host.example", "ns2.host.example"])
    expect(await dohRecords("shop.example.com", "CNAME", fetcher)).toEqual(["edge.cdn.example"])
    expect(await dohRecords("gone.example.com", "CNAME", fetcher)).toEqual([])
    expect(await dohRecords("broken.example.com", "NS", fetcher)).toBeUndefined()
    expect(await dohRecords("unknown.example.com", "NS", fetcher)).toBeUndefined()
  })
})

describe("findings", () => {
  test("drift is a change of name servers or CNAME from the last reading; an empty or failed answer is not", async () => {
    const { state, readers } = tables()
    state.ns.set("example.com", ["ns1.a.example", "ns2.a.example"])
    const first = await checkDomainHealth(HOST, undefined, readers, NOW)
    expect(first.dns).toEqual({ ns: ["ns1.a.example", "ns2.a.example"], checkedAt: NOW })
    state.ns.set("example.com", [])
    const empty = await checkDomainHealth(HOST, first, readers, NOW + DAY)
    expect(empty.dns).toEqual(first.dns)
    state.ns.set("example.com", undefined)
    expect((await checkDomainHealth(HOST, first, readers, NOW + DAY)).dns).toEqual(first.dns)
    state.ns.set("example.com", ["ns1.b.example", "ns2.b.example"])
    const moved = await checkDomainHealth(HOST, first, readers, NOW + 2 * DAY)
    expect(moved.dns).toMatchObject({ ns: ["ns1.b.example", "ns2.b.example"], changedAt: NOW + 2 * DAY })
    // The change date stays until the next change.
    expect((await checkDomainHealth(HOST, moved, readers, NOW + 3 * DAY)).dns!.changedAt).toBe(NOW + 2 * DAY)
    state.cname.set(HOST, ["other.cdn.example"])
    expect((await checkDomainHealth(HOST, moved, readers, NOW + 4 * DAY)).dns!.changedAt).toBe(NOW + 4 * DAY)
  })

  test("alerts at 14 and 3 days for a certificate, 30 and 7 for a registration, once per broken certificate and DNS change", () => {
    const health = (certificate: DomainHealth["certificate"], registration?: number): DomainHealth => ({
      checkedAt: NOW,
      ...(certificate ? { certificate } : {}),
      ...(registration ? { registration: { zone: "example.com", expiresAt: registration, checkedAt: NOW } } : {}),
    })
    expect(healthFindings(HOST, health({ expiresAt: NOW + 20 * DAY, checkedAt: NOW }), NOW)).toEqual([])
    const fourteen = healthFindings(HOST, health({ expiresAt: NOW + 10 * DAY, checkedAt: NOW }), NOW)
    expect(fourteen.map((finding) => finding.title)).toEqual([
      `On Call: the certificate for ${HOST} expires in 10 days`,
    ])
    const three = healthFindings(HOST, health({ expiresAt: NOW + 2 * DAY, checkedAt: NOW }), NOW)
    expect(three[0]!.id).not.toBe(fourteen[0]!.id)
    expect(healthFindings(HOST, health({ problem: "expired", checkedAt: NOW }), NOW)[0]!.title).toBe(
      `On Call: the certificate for ${HOST} has expired`,
    )
    expect(healthFindings(HOST, health(undefined, NOW + 25 * DAY), NOW)[0]!.title).toBe(
      "On Call: the registration of example.com ends in 25 days",
    )
    const alerted = health({ expiresAt: NOW + 10 * DAY, checkedAt: NOW })
    alerted.alerted = { [fourteen[0]!.id]: NOW }
    expect(healthFindings(HOST, alerted, NOW + DAY)).toEqual([])
    for (const finding of [...fourteen, ...three]) {
      expect(finding.title.length).toBeLessThanOrEqual(120)
      expect(finding.title).not.toMatch(/https?:|\$|%/)
    }
  })
})

describe("the daily job", () => {
  test("checks roster accounts' verified domains, stores the health, alerts once, shows it on the domain", async () => {
    await subscriber(MAX, "vector-100")
    const { state, readers } = tables()
    state.certificate.set(HOST, { result: "ok", expiresAt: NOW + 10 * DAY })
    state.expires.set("example.com", NOW + 200 * DAY)
    state.ns.set("example.com", ["ns1.a.example"])
    const first = await job(readers)
    expect(first.body.health).toMatchObject({ enabled: true, accounts: 1, domains: 1, alerts: 1, failures: 0 })
    expect(alerts).toEqual([
      {
        account: MAX,
        title: `On Call: the certificate for ${HOST} expires in 10 days`,
        tag: "on-call",
        allowPaused: true,
      },
    ])
    const stored = await readHealth(MAX, world.fetcher())
    expect(Object.keys(stored.domains)).toEqual([HOST])
    expect(stored.domains[HOST]).toMatchObject({
      certificate: { expiresAt: NOW + 10 * DAY },
      registration: { zone: "example.com", expiresAt: NOW + 200 * DAY },
      dns: { ns: ["ns1.a.example"] },
    })

    // The same day: not read again.
    world.advance(3_600_000)
    expect((await job(readers)).body.health).toMatchObject({ accounts: 0 })
    expect(state.reads).toBe(1)

    // The next day: read again, nothing new to say; then the name servers move.
    world.advance(DAY)
    state.ns.set("example.com", ["ns1.b.example"])
    expect((await job(readers)).body.health).toMatchObject({ accounts: 1, alerts: 1 })
    expect(alerts.at(-1)!.title).toBe(`On Call: the DNS for ${HOST} changed`)

    const listed = await invoke(
      (request, response) => handleOpsDomains(request, response, world.fetcher(), () => world.now),
      {
        method: "GET",
        authorization: world.token(MAX),
      },
    )
    const domain = listed.body.domains.find((item: { domain: string }) => item.domain === HOST)
    expect(domain.health).toEqual({
      checkedAt: world.now,
      certificate: { expiresAt: NOW + 10 * DAY },
      registration: { expiresAt: NOW + 200 * DAY },
      dnsChangedAt: world.now,
    })
    // Name servers are not shown; a pending domain has no health.
    expect(JSON.stringify(listed.body)).not.toContain("ns1.b.example")
    expect(listed.body.domains.find((item: { domain: string }) => item.domain !== HOST).health).toBeUndefined()
  })

  test("paused plans keep their checks (§4.4); ended and Pro plans are not checked; a failing account never stops another", async () => {
    await subscriber(MAX, "vector-100", "paused")
    await subscriber(ULTRA, "vector-200", "ended")
    const { state, readers } = tables()
    state.certificate.set(HOST, { result: "problem", problem: "untrusted" })
    expect((await job(readers)).body.health).toMatchObject({ accounts: 1, alerts: 1 })
    expect(alerts.map((alert) => alert.account)).toEqual([MAX])
    expect(world.fakes.store.zset(opsHealthCheckedKey()).has(ULTRA)).toBe(false)
    // An unreadable settings document counts a failure; the account is tried again next run.
    world.advance(DAY)
    world.fakes.store.set(opsSettingsKey(MAX), "{broken")
    expect((await job(readers)).body.health).toMatchObject({ accounts: 0, failures: 1 })
  })

  test("nothing without the ops services", async () => {
    await subscriber(MAX, "vector-100")
    delete process.env.VECTOR_OPS_WORKER_URL
    const { readers } = tables()
    expect((await job(readers)).body.health).toMatchObject({ enabled: false, accounts: 0 })
  })
})
