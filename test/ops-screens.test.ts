import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { snapshotKey } from "../api/_lib/codium-snapshot"
import { ops as opsProvisioner } from "../api/_lib/codium-provisioners"
import { runDomainHealth } from "../api/_lib/ops-health"
import {
  handleOpsReport,
  incidentIndexKey,
  incidentKey,
  type AlertSender,
  type Incident,
} from "../api/_lib/ops-incidents"
import { newOpsSettings, updateOpsSettings } from "../api/_lib/ops-settings"
import { environmentKey, releaseIndexKey, releaseRecordKey, type ReleaseRecord } from "../api/_lib/release-guard"
import { cardIndexKey, cardKey, imageObjectKey, SHIP_DESK_LIMITS, type Card } from "../api/_lib/ship-desk"
import { handleOpsCards } from "../api/ops/cards"
import { handleOpsDomains } from "../api/ops/domains"
import { handleOpsImage } from "../api/ops/image"
import { handleOpsIncidents } from "../api/ops/incidents"
import { handleOpsMonitors } from "../api/ops/monitors"
import { handleOpsReleases } from "../api/ops/releases"
import { handleOpsRepos } from "../api/ops/repos"
import {
  decodeCardAnswer,
  decodeCards,
  decodeDomains,
  decodeIncidents,
  decodeMonitors,
  decodeReleases,
} from "../packages/app/src/features/cloud/ops/ops-model"
import { imageLinkAllowed, opsRoute, type OpsRequest } from "../packages/app/src/features/cloud/ops/ops-requests"
import { DAY, invoke, MAX, OpsWorld, type Answer } from "./ops-fixture"

// WP A50: the production-check screens (the phone's Production page and the desktop's Settings → Production) read the
// API's real answers. Each route runs here with A47–A49's code over the fakes, and its answer goes through the screens'
// own decoders (packages/app/src/features/cloud/ops/ops-model.ts): nothing the screens show is dropped, and nothing
// they decode is missing from the API. Every request the screens can make (ops-requests.ts opsRoute) reaches its route
// with a body the route accepts. Nothing reaches a network.

const R2_ACCOUNT = "0123456789abcdef0123456789abcdef"
const MEDIA = {
  VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
  VECTOR_R2_MEDIA_ACCESS_KEY_ID: "fixturemediakey00001",
  VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: "fixtureMediaSecretAccessKey0123456789abcdefXY",
  VECTOR_R2_MEDIA_BUCKET: undefined,
}
const REPO = 42
const HOST = "shop.example.com"
const HEAD = "a".repeat(40)
const GOOD = "b".repeat(40)
const BAD = "c".repeat(40)
const MONITOR = "mon_aaaaaaaaaaaaaaaa"

let world: OpsWorld
const quiet: AlertSender = async () => ({ sent: 0, failed: 0, removed: 0 })

beforeEach(() => {
  world = new OpsWorld(MEDIA)
})
afterEach(() => {
  setSystemTime()
  world.close()
})

/** Max, active, with a verified domain, an On Call URL and a repository with Release Guard and Ship Desk on. */
async function ready() {
  world.bind(REPO, MAX)
  await updateOpsSettings(
    MAX,
    () => ({
      ...newOpsSettings(),
      domains: [{ domain: HOST, token: "t".repeat(32), addedAt: world.now, verifiedAt: world.now, method: "dns" }],
      monitors: [{ id: MONITOR, url: `https://${HOST}/health`, addedAt: world.now }],
      repos: [
        {
          repositoryId: REPO,
          repository: `octo-fixture/repo-${REPO}`,
          environment: "Production",
          productionUrl: `https://${HOST}`,
          paths: ["/", "/checkout"],
          releaseGuard: true,
          shipDesk: true,
          updatedAt: world.now,
        },
      ],
    }),
    world.fetcher(),
    world.now,
  )
  const snapshot = world.snapshotFor(MAX, "vector-100", "active")
  world.fakes.store.set(snapshotKey(MAX), JSON.stringify(snapshot))
  setSystemTime(new Date(world.now))
  await opsProvisioner.apply({ account: MAX, to: snapshot, cause: "first_payment" }, world.fetcher())
}

/** A monitor incident from the Worker's own report, and two release incidents as A48 stores them. */
async function incidents() {
  await handleOpsReport(
    {
      v: 1,
      account: MAX,
      events: [
        {
          v: 1,
          id: "evt_screens_down_1",
          kind: "monitor.down",
          at: world.now,
          monitor: MONITOR,
          since: world.now - 60_000,
          reason: "status",
          status: 502,
        },
      ],
    },
    { fetcher: world.fetcher(), now: world.now, alert: quiet },
  )
  const release = (
    id: string,
    sha: string,
    revert: NonNullable<Incident["release"]>["revert"],
    openedAt: number,
  ): Incident => ({
    v: 1,
    id,
    kind: "release",
    state: "open",
    openedAt,
    updatedAt: openedAt,
    subject: `release:${REPO}:${environmentKey("Production")}`,
    alerted: true,
    release: {
      repositoryId: REPO,
      repository: `octo-fixture/repo-${REPO}`,
      environment: "Production",
      sha,
      goodSha: GOOD,
      deployment: "9001",
      failing: [{ url: `https://${HOST}/checkout`, reason: "status", status: 500 }],
      ...(revert ? { revert } : {}),
      facts: {
        commits: [{ sha, title: "Change the checkout", author: "octo" }],
        totalCommits: 1,
        migrations: ["db/migrations/0042_orders.sql"],
        workflows: false,
        openUrl: `https://github.com/octo-fixture/repo-${REPO}/pull/6`,
      },
      rollback: { host: "vercel", url: "https://vercel.com/octo/shop/deployments/9001" },
    },
  })
  const opened = release(
    `inc_${"r".repeat(22)}`,
    BAD,
    { state: "opened", method: "revert-pr", number: 7, url: `https://github.com/octo-fixture/repo-${REPO}/pull/7` },
    world.now - 1_000,
  )
  const manual = release(
    `inc_${"m".repeat(22)}`,
    "d".repeat(40),
    { state: "manual", reason: "workflows" },
    world.now - 2_000,
  )
  for (const incident of [opened, manual]) {
    world.fakes.store.set(incidentKey(MAX, incident.id), JSON.stringify(incident))
    world.fakes.store.zset(incidentIndexKey(MAX)).set(incident.id, incident.openedAt)
  }
}

function release(sha: string, state: ReleaseRecord["state"], extra: Partial<ReleaseRecord> = {}) {
  const record: ReleaseRecord = {
    v: 1,
    repositoryId: REPO,
    repository: `octo-fixture/repo-${REPO}`,
    environment: "Production",
    sha,
    deployment: "9001",
    at: world.now - 600_000,
    receivedAt: world.now - 600_000,
    urls: [`https://${HOST}/`, `https://${HOST}/checkout`],
    state,
    ...extra,
  }
  world.fakes.store.set(releaseRecordKey(MAX, REPO, "Production", sha), JSON.stringify(record))
  world.fakes.store.zset(releaseIndexKey(MAX)).set(`${REPO}:${environmentKey("Production")}:${sha}`, record.at)
}

function card(number: number) {
  const id = `crd_${String(number).padStart(22, "0")}`
  const value: Card = {
    v: 1,
    id,
    repositoryId: REPO,
    repository: `octo-fixture/repo-${REPO}`,
    number,
    url: `https://github.com/octo-fixture/repo-${REPO}/pull/${number}`,
    title: "Add a cart badge",
    author: "app",
    state: "open",
    draft: false,
    baseRef: "main",
    headSha: HEAD,
    createdAt: world.now,
    updatedAt: world.now,
    expiresAt: world.now + 30 * DAY,
    keepDays: 30,
    images: [1, 2].map((n) => ({
      n,
      slot: n === 1 ? ("before" as const) : ("after" as const),
      route: "/",
      type: "image/png" as const,
      bytes: 100,
      width: 10,
      height: 10,
      key: imageObjectKey(
        { account: MAX, card: id, capture: "cap_0000000000000000000001", n, type: "image/png", keepDays: 30 },
        "test",
      ),
    })),
    imagesSha: HEAD,
  }
  world.fakes.store.set(cardKey(MAX, id), JSON.stringify(value))
  world.fakes.store.expires.set(cardKey(MAX, id), value.expiresAt + SHIP_DESK_LIMITS.retainMs)
  world.fakes.store.zset(cardIndexKey(MAX)).set(id, world.now)
  return value
}

/**
 * Sends one of the screens' requests the way the desktop's main process and the phone app do: opsRoute's path, method
 * and body, with the account's desktop token. `/api/ops/image/<card>/<n>` goes through vercel.json's rewrite.
 */
async function send(request: OpsRequest): Promise<Answer> {
  const route = opsRoute(request)
  if (!route) throw new Error(`the screens cannot send ${JSON.stringify(request)}`)
  const url = new URL(route.path, "https://vectordev.ai")
  const image = /^\/api\/ops\/image\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  const target = image ? `/api/ops/image?card=${image[1]}&n=${image[2]}` : `${url.pathname}${url.search}`
  const handlers = {
    "/api/ops/incidents": handleOpsIncidents,
    "/api/ops/releases": handleOpsReleases,
    "/api/ops/cards": handleOpsCards,
    "/api/ops/image": handleOpsImage,
    "/api/ops/monitors": handleOpsMonitors,
    "/api/ops/domains": handleOpsDomains,
    "/api/ops/repos": handleOpsRepos,
  } as const
  const handler = handlers[new URL(target, "https://vectordev.ai").pathname as keyof typeof handlers]
  return invoke((req, res) => handler(req, res, world.fetcher(), () => world.now), {
    method: route.method,
    authorization: world.token(MAX),
    url: target,
    ...(route.body ? { body: route.body } : {}),
  })
}

describe("the screens read the API's real answers", () => {
  test("incidents: the Worker's monitor report, a revert pull request, and a manual undo with the host's rollback", async () => {
    await ready()
    await incidents()
    const answer = await send({ kind: "incidents" })
    expect(answer.status).toBe(200)
    const decoded = decodeIncidents(answer.body)
    expect(decoded).toHaveLength((answer.body.incidents as unknown[]).length)
    expect(decoded).toHaveLength(3)
    const monitor = decoded.find((incident) => incident.kind === "monitor")!
    expect(monitor).toMatchObject({
      state: "open",
      monitor: { url: `https://${HOST}/health`, reason: "status", status: 502 },
    })
    const opened = decoded.find((incident) => incident.release?.sha === BAD)!
    expect(opened.release).toMatchObject({
      repository: `octo-fixture/repo-${REPO}`,
      environment: "Production",
      goodSha: GOOD,
      failing: [{ url: `https://${HOST}/checkout`, status: 500 }],
      commits: [{ sha: BAD, title: "Change the checkout", author: "octo" }],
      totalCommits: 1,
      migrations: ["db/migrations/0042_orders.sql"],
      workflows: false,
      undo: { kind: "pull-request", number: 7, url: `https://github.com/octo-fixture/repo-${REPO}/pull/7` },
    })
    const manual = decoded.find((incident) => incident.release?.sha === "d".repeat(40))!
    expect(manual.release!.undo).toEqual({
      kind: "manual",
      reason: "workflows",
      openUrl: `https://github.com/octo-fixture/repo-${REPO}/pull/6`,
      rollback: { host: "vercel", url: "https://vercel.com/octo/shop/deployments/9001" },
    })
  })

  test("releases: every state the API answers decodes", async () => {
    await ready()
    release("1".repeat(40), "passed")
    release("2".repeat(40), "skipped", { reason: "daily-limit" })
    release("3".repeat(40), "watching", { startAt: world.now - 540_000, endAt: world.now + 1_200_000 })
    release("4".repeat(40), "regressed", { incident: `inc_${"r".repeat(22)}` })
    const answer = await send({ kind: "releases" })
    expect(answer.status).toBe(200)
    const decoded = decodeReleases(answer.body)
    expect(decoded).toHaveLength(4)
    expect(decoded.map((item) => item.state).sort()).toEqual(["passed", "regressed", "skipped", "watching"])
    expect(decoded.find((item) => item.state === "skipped")).toMatchObject({ reason: "daily-limit" })
    // No URL is listed, only how many paths were watched.
    expect(JSON.stringify(answer.body)).not.toContain(HOST)
  })

  test("cards: the list, one card with what Approve merges, and a screenshot link the desktop accepts", async () => {
    await ready()
    const made = card(12)
    const list = await send({ kind: "cards" })
    expect(list.status).toBe(200)
    const { cards, hidden } = decodeCards(list.body)
    expect(hidden).toBe(false)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: made.id,
      repository: made.repository,
      number: 12,
      title: "Add a cart badge",
      state: "open",
      approve: { url: made.url, repository: made.repository, number: 12, headSha: HEAD },
    })
    expect(cards[0]!.images.map((image) => [image.n, image.slot, image.route])).toEqual([
      [1, "before", "/"],
      [2, "after", "/"],
    ])
    const one = await send({ kind: "card", id: made.id })
    expect(one.status).toBe(200)
    expect(decodeCardAnswer(one.body)?.approve.headSha).toBe(HEAD)
    const image = await send({ kind: "image", card: made.id, n: 2 })
    expect(image.status).toBe(200)
    expect(imageLinkAllowed(image.body.url)).toBe(true)
  })

  test("domains with the daily job's health, and URLs with the plan's count and interval", async () => {
    await ready()
    const result = await runDomainHealth({
      fetcher: world.fetcher(),
      clock: () => world.now,
      deadline: world.now + 60_000,
      alert: quiet,
      readers: {
        certificate: async () => ({ result: "ok", expiresAt: world.now + 10 * DAY }),
        registration: async () => ({ result: "ok", zone: "example.com", expiresAt: world.now + 200 * DAY }),
        dns: async (_name, type) => (type === "NS" ? ["ns1.example.net"] : []),
      },
    })
    expect(result).toMatchObject({ accounts: 1, domains: 1 })
    const domains = await send({ kind: "domains" })
    expect(domains.status).toBe(200)
    const decoded = decodeDomains(domains.body)
    expect(decoded.domains).toHaveLength(1)
    expect(decoded.domains[0]).toMatchObject({
      domain: HOST,
      status: "verified",
      overLimit: false,
      record: { txt: { name: `_vector-verify.${HOST}` } },
      health: {
        certificate: { expiresAt: world.now + 10 * DAY },
        registration: { expiresAt: world.now + 200 * DAY },
      },
    })
    expect(decoded.limit).toBe(3)
    const monitors = await send({ kind: "monitors" })
    expect(monitors.status).toBe(200)
    expect(decodeMonitors(monitors.body)).toEqual({
      monitors: [{ id: MONITOR, url: `https://${HOST}/health`, domainVerified: true, checked: true }],
      limits: { urls: 5, intervalSec: 300 },
    })
  })
})

describe("every request the screens send reaches its route with a body it accepts", () => {
  test("snooze, end snooze, Fix it, domains and URLs", async () => {
    await ready()
    await incidents()
    const id = `inc_${"r".repeat(22)}`
    expect((await send({ kind: "snooze", id, hours: 4 })).status).toBe(200)
    expect(decodeIncidents((await send({ kind: "incidents" })).body).find((item) => item.id === id)?.snoozedUntil).toBe(
      world.now + 4 * 3_600_000,
    )
    expect((await send({ kind: "unsnooze", id })).status).toBe(200)
    // Fix it reaches the route; with no run starter registered yet (A59) the answer is the documented refusal.
    const fix = await send({ kind: "fix", id })
    expect([fix.status, fix.body.error?.code]).toEqual([503, "OPS_FIX_UNAVAILABLE"])
    expect((await send({ kind: "add-domain", domain: "other.example.com" })).status).toBe(200)
    const verify = await send({ kind: "verify-domain", domain: "other.example.com" })
    expect(verify.status).toBe(200)
    expect((await send({ kind: "remove-domain", domain: "other.example.com" })).status).toBe(200)
    const added = await send({ kind: "add-monitor", url: `https://${HOST}/status` })
    expect(added.status).toBe(200)
    const listed = decodeMonitors((await send({ kind: "monitors" })).body).monitors
    const fresh = listed.find((monitor) => monitor.url === `https://${HOST}/status`)!
    expect((await send({ kind: "remove-monitor", id: fresh.id })).status).toBe(200)
    expect(decodeMonitors((await send({ kind: "monitors" })).body).monitors.map((monitor) => monitor.id)).toEqual([
      MONITOR,
    ])
    expect((await send({ kind: "repos" })).status).toBe(200)
  })

  test("vercel.json rewrites the image path the screens use, and the phone origin may show R2's signed images", async () => {
    const config = JSON.parse(await readFile(path.join(import.meta.dir, "..", "vercel.json"), "utf8"))
    expect(config.rewrites).toContainEqual({
      source: "/api/ops/image/:card/:n",
      destination: "/api/ops/image?card=:card&n=:n",
    })
    const policies = (config.headers as { headers: { key: string; value: string }[] }[])
      .flatMap((rule) => rule.headers)
      .filter((header) => header.key === "Content-Security-Policy")
      .map((header) => header.value)
    expect(policies).toHaveLength(1)
    const imgSrc = policies[0]!
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([name]) => name === "img-src")!
    // Ship Desk's screenshots come straight from vector-media through 60-second signed links (A49); scripts, styles and
    // connections stay on the phone origin's own list.
    expect(imgSrc).toEqual(["img-src", "'self'", "data:", "blob:", "https://*.r2.cloudflarestorage.com"])
  })
})
