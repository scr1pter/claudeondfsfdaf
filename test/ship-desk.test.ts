import { RedisClient } from "bun"
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { ops as opsProvisioner } from "../api/_lib/codium-provisioners"
import { meterKey } from "../api/_lib/codium-snapshot"
import { readGithubAudit } from "../api/_lib/github-app-server"
import { createGithubWebhookRoute, githubSignature, type GithubWebhookEvent } from "../api/_lib/github-webhook"
import {
  createOpsWebhookHandler,
  registerShipDeskIntake,
  routeOpsEvent,
  type OpsPullRequest,
} from "../api/_lib/github-webhook-handlers/ops"
import { ApiError } from "../api/_lib/http"
import { registerRunVerifier, type ModelPlanCaller } from "../api/_lib/model-plan-caller"
import { opsJson } from "../api/_lib/ops-api"
import { newOpsSettings, updateOpsSettings, type OpsRepo, type OpsSettings } from "../api/_lib/ops-settings"
import { presignSigV4 } from "../api/_lib/r2-presign"
import {
  cardId,
  cardIndexKey,
  cardKey,
  cardRunKey,
  cardsUsed,
  cardView,
  decodeCard,
  eraseAccountShipDesk,
  lookupRun,
  readCard,
  readyTitle,
  runFacts,
  SHIP_DESK_CARD_METER,
  SHIP_DESK_SCRIPTS,
  shipDeskIntake,
  ticketHash,
  ticketIndexKey,
  ticketKey,
  type ShipDeskAlert,
  type ShipDeskContext,
} from "../api/_lib/ship-desk"
import { handleOpsCards } from "../api/ops/cards"
import { handleOpsImage, imageTarget } from "../api/ops/image"
import { handleOpsUploads } from "../api/ops/uploads"
import type { CloudRunReader } from "../api/_lib/cloud-run-reader"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { ShipDesk } from "../packages/schema/src/ship-desk"
import { APP_SLUG, DAY, invoke, MAX, NOW, OpsWorld, OTHER, PRO, ULTRA, WEBHOOK_SECRET } from "./ops-fixture"

// WP A49: Ship Desk. Pull requests from Codium runs of Vector's GitHub agent become private cards: the App's bot, or
// github-actions[bot] with the run marker and the run's own record; the plan, the ops switch and the repository's
// .vector/ops.json checked first; counted once per (repository, pull request) before any count moves. The verdict
// comes from Codex's run record, never the body. A capture job holding only a ticket (no id-token, no run token)
// uploads at most 8 PNG or WebP images in a 15-minute window, each checked by its signature and size; images are read
// back only by the card's account through 60-second signed links. GitHub, R2 and the store are fakes
// (test/ops-fixture.ts and the bucket below); nothing reaches a network.

const R2_ACCOUNT = "0123456789abcdef0123456789abcdef"
const R2_ORIGIN = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`
const R2_KEY_ID = "fixturemediakey00001"
const R2_SECRET = "fixtureMediaSecretAccessKey0123456789abcdefXY"
const MEDIA = {
  VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
  VECTOR_R2_MEDIA_ACCESS_KEY_ID: R2_KEY_ID,
  VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: R2_SECRET,
  VECTOR_R2_MEDIA_BUCKET: undefined,
}

const REPO = 42
const FULL = `octo-fixture/repo-${REPO}`
const RID = `gh-${REPO}-7001-1-9001`
const sha = (seed: string) => createHash("sha1").update(seed).digest("hex")
const HEAD = sha("head")
const BASE = sha("base")

// ── Fakes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `vector-media` in memory, checking each signed request as R2 does: the signature over what is sent, and expiry. */
function mediaBucket(clock: () => number) {
  const objects = new Map<string, Uint8Array>()
  const calls: { method: string; key: string; status: number; range?: string }[] = []
  const state = { down: false }
  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase()
    const prefix = "/vector-media/"
    const key = decodeURIComponent(url.pathname.slice(prefix.length))
    const headers = new Headers(init?.headers)
    const answer = (status: number, body?: BodyInit | null, extra?: Record<string, string>) => {
      calls.push({ method, key, status, ...(headers.get("range") ? { range: headers.get("range")! } : {}) })
      return new Response(body ?? null, { status, ...(extra ? { headers: extra } : {}) })
    }
    if (state.down) return answer(503)
    if (!url.pathname.startsWith(prefix)) return answer(404)
    const signed = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";")
    const date = url.searchParams.get("X-Amz-Date") ?? ""
    const at = Date.UTC(
      +date.slice(0, 4),
      +date.slice(4, 6) - 1,
      +date.slice(6, 8),
      +date.slice(9, 11),
      +date.slice(11, 13),
      +date.slice(13, 15),
    )
    const expires = Number(url.searchParams.get("X-Amz-Expires"))
    const base = new URL(url.origin + url.pathname)
    for (const [name, value] of url.searchParams) if (name.startsWith("response-")) base.searchParams.set(name, value)
    const body =
      init?.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : init?.body
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : undefined
    const sent = (name: string) =>
      name === "content-length" && body ? String(body.byteLength) : (headers.get(name) ?? "")
    const expected = presignSigV4({
      method,
      url: base,
      region: "auto",
      service: "s3",
      accessKeyId: R2_KEY_ID,
      secretAccessKey: R2_SECRET,
      now: at,
      expiresIn: expires,
      headers: Object.fromEntries(signed.filter((name) => name !== "host").map((name) => [name, sent(name)])),
    })
    if (new URL(expected).searchParams.get("X-Amz-Signature") !== url.searchParams.get("X-Amz-Signature"))
      return answer(403)
    if (clock() > at + expires * 1000) return answer(403)
    if (method === "PUT") {
      if (!signed.includes("content-length") || !body) return answer(403)
      objects.set(key, body)
      return answer(200)
    }
    const stored = objects.get(key)
    if (method === "HEAD")
      return stored ? answer(200, null, { "content-length": String(stored.byteLength) }) : answer(404)
    if (method === "GET") {
      if (!stored) return answer(404)
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "")
      const extra: Record<string, string> = {}
      for (const [name, header] of [
        ["response-content-type", "content-type"],
        ["response-cache-control", "cache-control"],
        ["response-content-disposition", "content-disposition"],
      ] as const) {
        const value = url.searchParams.get(name)
        if (value) extra[header] = value
      }
      if (range) return answer(206, stored.slice(Number(range[1]), Number(range[2]) + 1), extra)
      return answer(200, stored.slice(), extra)
    }
    if (method === "DELETE") {
      objects.delete(key)
      return answer(204)
    }
    return answer(405)
  }
  return { objects, calls, state, handle }
}

/** Ship Desk's CARD script as TypeScript, on the Codium fake store (a real Valkey runs it in CI, below). */
function registerShipDeskScripts(world: OpsWorld) {
  const store = world.fakes.store
  store.scripts.set(SHIP_DESK_SCRIPTS.CARD, (keys, argv) => {
    if (store.live(keys[0]!)) return 0
    if (store.live(keys[1]!)) return 2
    const used = Number(store.get(keys[2]!) ?? "0")
    if (used >= Number(argv[2])) return -1
    store.set(keys[2]!, String(used + 1))
    store.expires.set(keys[2]!, Number(argv[4]))
    store.set(keys[0]!, argv[0]!)
    store.expires.set(keys[0]!, world.now + Number(argv[3]))
    store.set(keys[1]!, argv[1]!)
    store.expires.set(keys[1]!, world.now + Number(argv[3]))
    const index = store.zset(keys[3]!)
    index.set(argv[1]!, Number(argv[5]))
    for (const [member, score] of [...index]) if (score < Number(argv[6])) index.delete(member)
    const ordered = [...index].sort((a, b) => a[1] - b[1])
    for (const [member] of ordered.slice(0, Math.max(0, ordered.length - Number(argv[7])))) index.delete(member)
    store.expires.set(keys[3]!, world.now + Number(argv[8]))
    return 1
  })
}

/** A PNG's first bytes (signature and IHDR), padded to `size`. */
function png(width = 1280, height = 800, size = 2_000) {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}
function webp(kind: "VP8X" | "VP8L" | "VP8 ", width: number, height: number) {
  const bytes = new Uint8Array(64)
  bytes.set(new TextEncoder().encode("RIFF"), 0)
  bytes.set(new TextEncoder().encode("WEBP"), 8)
  bytes.set(new TextEncoder().encode(kind), 12)
  if (kind === "VP8X") {
    const w = width - 1
    const h = height - 1
    bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24)
  } else if (kind === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14)
    bytes.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 20)
  } else bytes.set([0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f], 23)
  return bytes
}
const SVG = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`.padEnd(200),
)

// ── The world ──────────────────────────────────────────────────────────────────────────────────────────────────────

let world: OpsWorld
let bucket = mediaBucket(() => world.now)
let alerts: { account: string; title: string; tag?: string }[] = []
const recordAlert: ShipDeskAlert = async (account, alert) => {
  alerts.push({ account, title: alert.title, ...(alert.tag ? { tag: alert.tag } : {}) })
}
let runs: Record<string, unknown>[] = []
const reader: CloudRunReader = async (account) => runs.filter((run) => run.account === account)

// The run tokens of Vector's GitHub agent, as Codex's verifier answers them (one Bun process per test file in CI).
const runCallers = new Map<string, ModelPlanCaller>()
registerRunVerifier("vrt_", async (token) => {
  const caller = runCallers.get(token)
  if (!caller) throw new ApiError(401, "RUN_TOKEN_INVALID", "fixture")
  return caller
})
function runToken(account: string, rid = RID, deadline = NOW + 2 * 3_600_000) {
  const token = `vrt_fixture${runCallers.size}.${createHash("sha256")
    .update(rid + account)
    .digest("base64url")
    .slice(0, 20)}`
  runCallers.set(token, {
    account: { id: account },
    kind: "run",
    purpose: "cloud-agents",
    run: { id: rid, source: "github-comment", deadline, service: "cloud-agents" },
  })
  return token
}

beforeEach(() => {
  world = new OpsWorld(MEDIA)
  registerShipDeskScripts(world)
  bucket = mediaBucket(() => world.now)
  alerts = []
  runs = []
  registerShipDeskIntake(undefined)
})
afterEach(() => {
  registerShipDeskIntake(undefined)
  setSystemTime()
  world.close()
})

function fetcher(): typeof fetch {
  const base = world.fetcher()
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === R2_ORIGIN) return bucket.handle(url, init)
    return base(input, init)
  }) as typeof fetch
}
const context = (extra: ShipDeskContext = {}): ShipDeskContext => ({
  fetcher: fetcher(),
  now: world.now,
  reader: null,
  alert: recordAlert,
  ...extra,
})

/** An account with REPO bound and set up for Ship Desk, and .vector/ops.json opting in on main. */
async function ready(
  account = MAX,
  plan: PlanId | null = "vector-100",
  repo: Partial<OpsRepo> = {},
  optIn: Partial<ReturnType<typeof opsJson>> | null = {},
): Promise<OpsSettings> {
  world.seed(account, plan)
  world.bind(REPO, account)
  const settings = await updateOpsSettings(
    account,
    () => ({
      ...newOpsSettings(),
      repos: [
        {
          repositoryId: REPO,
          repository: FULL,
          environment: "Production",
          paths: [],
          releaseGuard: false,
          shipDesk: true,
          updatedAt: world.now,
          ...repo,
        },
      ],
    }),
    fetcher(),
    world.now,
  )
  if (optIn) world.github.commitOptIn(REPO, { ...opsJson(settings!, settings!.repos[0]!), ...optIn }, "main")
  return settings!
}

function pull(settings: OpsSettings, overrides: Partial<OpsPullRequest> = {}): OpsPullRequest {
  return {
    account: MAX,
    repositoryId: REPO,
    repository: FULL,
    number: 12,
    action: "opened",
    headSha: HEAD,
    merged: false,
    draft: false,
    url: `https://github.com/${FULL}/pull/12`,
    installationId: 77,
    deliveryId: "delivery-1",
    author: "app",
    rid: RID,
    title: "Fix the checkout total",
    baseRef: "main",
    baseSha: BASE,
    opsId: settings.opsId,
    ...overrides,
  }
}

const used = async (account = MAX) => {
  const snapshot = world.snapshotFor(account, "vector-100")
  return Number(world.fakes.store.get(meterKey(snapshot, SHIP_DESK_CARD_METER)) ?? "0")
}

function payload(overrides: { pull?: Record<string, unknown>; root?: Record<string, unknown> } = {}) {
  return {
    action: "opened",
    number: 12,
    pull_request: {
      number: 12,
      title: "Fix the checkout total",
      html_url: `https://github.com/${FULL}/pull/12`,
      user: { login: `${APP_SLUG}[bot]`, type: "Bot" },
      head: { sha: HEAD, ref: "vector/fix", repo: { id: REPO } },
      base: { sha: BASE, ref: "main", repo: { id: REPO } },
      merged: false,
      draft: false,
      body: `Vector fixed the total.\n\n<!-- vector:rid ${RID} -->`,
      ...overrides.pull,
    },
    repository: { id: REPO, full_name: FULL },
    installation: { id: 77 },
    ...overrides.root,
  }
}

let deliveries = 0
function deliver(route: ReturnType<typeof createGithubWebhookRoute>, body: unknown) {
  const raw = JSON.stringify(body)
  return invoke(route, {
    method: "POST",
    raw,
    url: "/api/github/webhook",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": `0000${String(++deliveries).padStart(4, "0")}-a49a-11f0-8000-000000000000`,
      "x-hub-signature-256": githubSignature(raw, WEBHOOK_SECRET),
    },
  })
}

function webhook() {
  registerShipDeskIntake((input, extra) => shipDeskIntake(input, { ...extra, reader: null, alert: recordAlert }))
  return createGithubWebhookRoute({
    handlers: [createOpsWebhookHandler({ fetcher: fetcher(), clock: () => world.now })],
    fetcher: fetcher(),
  })
}

const cards = (authorization: string, query = "") =>
  invoke((request, response) => handleOpsCards(request, response, fetcher(), () => world.now, { reader: null }), {
    method: "GET",
    authorization,
    url: `/api/ops/cards${query}`,
  })
/** The capture job's own proof, which `vector ship capture` sends with every ticket request. */
const PROOF = "p".repeat(43)
const uploads = (authorization: string, body: unknown, proof: string | null = PROOF) =>
  invoke((request, response) => handleOpsUploads(request, response, fetcher(), () => world.now), {
    method: "POST",
    authorization,
    body:
      authorization.startsWith("vcap_") && proof !== null && body && typeof body === "object" && !("proof" in body)
        ? { ...body, proof }
        : body,
    url: "/api/ops/uploads",
  })
const image = (authorization: string, card: string, n: number | string) =>
  invoke((request, response) => handleOpsImage(request, response, fetcher(), () => world.now), {
    method: "GET",
    authorization,
    url: `/api/ops/image?card=${card}&n=${n}`,
  })

// ── Shared formats ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("shared formats", () => {
  test("the run marker is a lookup key: one marker of a GitHub run, never two that disagree", () => {
    expect(ShipDesk.runMarker(`text\n<!-- vector:rid ${RID} -->`)).toBe(RID)
    expect(ShipDesk.runMarker(`<!-- vector:rid ${RID} --> and again <!--vector:rid ${RID}-->`)).toBe(RID)
    expect(ShipDesk.runMarker(`<!-- vector:rid ${RID} --> <!-- vector:rid gh-42-1-1-2 -->`)).toBeUndefined()
    expect(ShipDesk.runMarker("<!-- vector:rid not-a-github-run -->")).toBeUndefined()
    expect(ShipDesk.runMarker("<!-- vector:rid gh-0-1-1-1 -->")).toBeUndefined()
    expect(ShipDesk.runMarker("verdict: pass")).toBeUndefined()
    expect(ShipDesk.runMarker(undefined)).toBeUndefined()
    expect(ShipDesk.runRepository(RID)).toBe(REPO)
    expect(ShipDesk.runRepository(`gh-${"9".repeat(21)}-1`)).toBeUndefined()
  })

  test("images are known by their signature: PNG and WebP with sane sizes, nothing else (SVG included)", () => {
    expect(ShipDesk.sniffImage(png(1280, 800))).toEqual({ type: "image/png", width: 1280, height: 800 })
    expect(ShipDesk.sniffImage(webp("VP8X", 1440, 900))).toEqual({ type: "image/webp", width: 1440, height: 900 })
    expect(ShipDesk.sniffImage(webp("VP8L", 640, 480))).toEqual({ type: "image/webp", width: 640, height: 480 })
    expect(ShipDesk.sniffImage(webp("VP8 ", 320, 200))).toEqual({ type: "image/webp", width: 320, height: 200 })
    expect(ShipDesk.sniffImage(SVG)).toBeUndefined()
    expect(ShipDesk.sniffImage(new TextEncoder().encode("<html><body>hi</body></html>".padEnd(64)))).toBeUndefined()
    expect(ShipDesk.sniffImage(png(20_000, 10))).toBeUndefined()
    expect(ShipDesk.sniffImage(png(0, 10))).toBeUndefined()
    expect(ShipDesk.sniffImage(png().slice(0, 12))).toBeUndefined()
  })

  test(".vector/ship.json: commands on one line, an unprivileged port, at most four plain routes", () => {
    const good = {
      install: "npm ci",
      build: "npm run build",
      start: "npm start",
      port: 3000,
      routes: ["/", "/pricing?plan=max"],
    }
    expect(ShipDesk.parseShipJson(JSON.stringify(good))).toEqual(good)
    expect(ShipDesk.parseShipJson(JSON.stringify({ start: "npm start", port: 4321 }))).toEqual({
      start: "npm start",
      port: 4321,
      routes: ["/"],
    })
    for (const bad of [
      { ...good, port: 80 },
      { ...good, port: "3000" },
      { ...good, routes: ["/", "/a", "/b", "/c", "/d"] },
      { ...good, routes: ["https://evil.example/"] },
      { ...good, routes: ["//evil.example/"] },
      { ...good, routes: ["/a b"] },
      { ...good, routes: ["/", "/"] },
      { ...good, start: "" },
      { ...good, build: "npm run build\ncurl evil" },
      { ...good, install: 3 },
    ])
      expect(ShipDesk.parseShipJson(JSON.stringify(bad))).toBeUndefined()
    expect(ShipDesk.parseShipJson("not json")).toBeUndefined()
  })

  test("a card's alert title stays within 120 characters", () => {
    expect(readyTitle(FULL, 12)).toBe(`${FULL} #12 is ready on Ship Desk`)
    expect(readyTitle(`o/${"r".repeat(140)}`, 12).length).toBeLessThanOrEqual(120)
  })

  test("the image route reads its card and number from the rewrite or the path", () => {
    expect(imageTarget("/api/ops/image?card=crd_x&n=2")).toEqual({ card: "crd_x", n: "2" })
    expect(imageTarget("/api/ops/image/crd_y/3")).toEqual({ card: "crd_y", n: "3" })
    expect(imageTarget("/api/ops/image")).toEqual({ card: "", n: "" })
  })
})

// ── Cards from pull requests ───────────────────────────────────────────────────────────────────────────────────────

describe("cards", () => {
  test("done: a signed pull request delivery makes a card the account sees, counted once however many events follow", async () => {
    const settings = await ready()
    world.github.checkRuns.set(`${REPO}:${HEAD}`, [
      { name: "test", status: "completed", conclusion: "success" },
      { name: "lint", status: "in_progress", conclusion: null },
    ])
    const route = webhook()
    expect((await deliver(route, payload())).status).toBe(200)
    const token = world.token(MAX)
    const listed = await cards(token)
    expect(listed.status).toBe(200)
    expect(listed.body.hidden).toBe(false)
    expect(listed.body.cards).toHaveLength(1)
    const card = listed.body.cards[0]
    expect(card).toMatchObject({
      id: cardId(REPO, 12),
      repository: FULL,
      number: 12,
      url: `https://github.com/${FULL}/pull/12`,
      title: "Fix the checkout total",
      state: "open",
      draft: false,
      expiresAt: world.now + 30 * DAY,
      images: [],
      approve: { url: `https://github.com/${FULL}/pull/12`, repository: FULL, number: 12, headSha: HEAD },
      checks: { total: 2, passed: 1, failed: 0, pending: 1 },
    })
    expect(card.verdict).toBeUndefined()
    expect(await used()).toBe(1)
    expect(alerts).toEqual([{ account: MAX, title: `${FULL} #12 is ready on Ship Desk`, tag: "ship-desk" }])
    // The opt-in was read with a read-only token for this one repository, revoked after use, and audited.
    expect(world.github.minted.at(-1)).toMatchObject({
      repositoryId: REPO,
      permissions: { checks: "read", contents: "read", metadata: "read" },
    })
    expect(world.github.live()).toEqual([])
    expect((await readGithubAudit(MAX, fetcher()))[0]).toMatchObject({
      purpose: "ship",
      reason: "ship-desk",
      revoked: true,
    })
    // Nothing on the server ever writes to the repository.
    expect(world.github.writes).toEqual([])

    // New head, ready for review, closed and merged: the same card, never counted again.
    const head2 = sha("head-2")
    for (const event of [
      payload({
        root: { action: "synchronize" },
        pull: { head: { sha: head2, ref: "vector/fix", repo: { id: REPO } } },
      }),
      payload({
        root: { action: "ready_for_review" },
        pull: { head: { sha: head2, ref: "vector/fix", repo: { id: REPO } } },
      }),
      payload({
        root: { action: "closed" },
        pull: { merged: true, head: { sha: head2, ref: "vector/fix", repo: { id: REPO } } },
      }),
    ])
      expect((await deliver(route, event)).status).toBe(200)
    expect(await used()).toBe(1)
    expect(alerts).toHaveLength(1)
    const stored = await readCard(MAX, cardId(REPO, 12), fetcher())
    expect(stored).toMatchObject({ headSha: head2, state: "merged" })
    expect(stored?.checks).toBeUndefined()
    expect(settings.opsId).toMatch(/^ops_/)
  })

  test("the intake refuses without a card or a count: closed, no run, plan, switch, App, opt-in", async () => {
    let settings = await ready()
    const intake = (overrides: Partial<OpsPullRequest> = {}, extra: ShipDeskContext = {}) =>
      shipDeskIntake(pull(settings, overrides), context(extra))
    expect(await intake({ action: "closed", merged: true })).toEqual({ kind: "ignored", reason: "closed" })
    expect(await intake({ rid: undefined })).toEqual({ kind: "ignored", reason: "no-run" })
    expect(await intake({ rid: "gh-43-1-1-1" })).toEqual({ kind: "ignored", reason: "no-run" })

    for (const [plan, state] of [
      ["vector-50", "active"],
      ["vector-10", "active"],
      ["vector-100", "paused"],
      ["vector-100", "ended"],
      ["vector-100", "frozen"],
      [null, "none"],
    ] as const) {
      world.seed(MAX, plan, state)
      expect(await intake()).toEqual({ kind: "ignored", reason: "plan" })
    }
    world.seed(MAX, "vector-100")
    world.switchOff("ops")
    expect(await intake()).toEqual({ kind: "ignored", reason: "off" })
    world.fakes.store.remove([...world.fakes.store.keys()].find((key) => key.endsWith(":switch:ops"))!)
    const enabled = process.env.VECTOR_GITHUB_APP_ENABLED
    process.env.VECTOR_GITHUB_APP_ENABLED = "false"
    expect(await intake()).toEqual({ kind: "ignored", reason: "off" })
    process.env.VECTOR_GITHUB_APP_ENABLED = enabled
    // Ship Desk not listed (and the account not on the owner's allowlist): no new card, nothing read from GitHub.
    const allowed = process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    const mints = world.github.minted.length
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await intake()).toEqual({ kind: "ignored", reason: "not-listed" })
    expect(world.github.minted.length).toBe(mints)
    process.env.VECTOR_OPS_ALLOW_ACCOUNTS = allowed

    // .vector/ops.json on the base branch must name this account's ops id with shipDesk: true.
    for (const optIn of [null, { opsId: "ops_" + "x".repeat(22) }, { shipDesk: false }, "{not json"] as const) {
      settings = await ready(MAX, "vector-100", {}, optIn === null || typeof optIn === "string" ? null : optIn)
      if (optIn === null) world.github.commitOptIn(REPO, null, "main")
      if (typeof optIn === "string") world.github.commitOptIn(REPO, optIn, "main")
      expect(await intake()).toEqual({ kind: "ignored", reason: "opt-in" })
    }
    expect(world.github.live()).toEqual([])
    // The App removed from the repository, or GitHub down (the delivery fails so it can be sent again).
    settings = await ready()
    world.github.repos.get(REPO)!.installationId = 99
    expect(await intake()).toEqual({ kind: "ignored", reason: "not-installed" })
    world.github.repos.get(REPO)!.installationId = 77
    world.github.down = true
    await expect(intake()).rejects.toMatchObject({ code: "GITHUB_UNAVAILABLE" })
    world.github.down = false
    world.fakes.store.down = true
    await expect(intake()).rejects.toBeDefined()
    world.fakes.store.down = false
    expect(await used()).toBe(0)
    expect(alerts).toEqual([])
    expect(await readCard(MAX, cardId(REPO, 12), fetcher())).toBeUndefined()
  })

  test("the month's cards: the plan's cap, dedupe before increment, and one card per run", async () => {
    const settings = await ready()
    const snapshot = world.snapshotFor(MAX, "vector-100")
    world.fakes.store.set(meterKey(snapshot, SHIP_DESK_CARD_METER), "99")
    expect(await shipDeskIntake(pull(settings), context())).toMatchObject({ kind: "created" })
    expect(await used()).toBe(100)
    // An event for the card already made is an update, never a refusal at the cap.
    expect(await shipDeskIntake(pull(settings, { action: "synchronize" }), context())).toMatchObject({
      kind: "updated",
    })
    expect(await shipDeskIntake(pull(settings, { number: 13, rid: `gh-${REPO}-7002-1-9002` }), context())).toEqual({
      kind: "ignored",
      reason: "limit",
    })
    expect(await used()).toBe(100)
    // A run's marker on a second pull request makes no second card.
    world.fakes.store.set(meterKey(snapshot, SHIP_DESK_CARD_METER), "0")
    expect(await shipDeskIntake(pull(settings, { number: 14 }), context())).toEqual({
      kind: "ignored",
      reason: "run-used",
    })
    expect(await used()).toBe(0)
    // Ultra's cap and keep days come from ENTITLEMENTS.
    const ultra = await ready(ULTRA, "vector-200")
    const made = await shipDeskIntake(pull(ultra, { account: ULTRA }), context())
    expect(made).toMatchObject({ kind: "created" })
    expect((await readCard(ULTRA, cardId(REPO, 12), fetcher()))?.expiresAt).toBe(world.now + 90 * DAY)
  })

  test("github-actions[bot]: only with the marker and the run's own record, of this account and this repository", async () => {
    const settings = await ready()
    // The handler passes it on only with a marker.
    const taken: OpsPullRequest[] = []
    registerShipDeskIntake(async (input) => {
      taken.push(input)
    })
    const route = (body: unknown) =>
      routeOpsEvent(
        { name: "pull_request", action: "opened", deliveryId: "d", payload: body as Record<string, unknown> },
        {
          fetcher: fetcher(),
          clock: () => world.now,
        },
      )
    const actions = { user: { login: "github-actions[bot]", type: "Bot" } }
    expect(await route(payload({ pull: { ...actions, body: "no marker" } }))).toEqual({
      kind: "ignored",
      reason: "author",
    })
    expect(
      await route(payload({ pull: { ...actions, user: { login: "github-actions[bot]", type: "User" } } })),
    ).toEqual({
      kind: "ignored",
      reason: "author",
    })
    expect(await route(payload({ pull: actions }))).toEqual({ kind: "ship-desk" })
    expect(taken[0]).toMatchObject({
      author: "actions",
      rid: RID,
      baseRef: "main",
      baseSha: BASE,
      opsId: settings.opsId,
    })

    const intake = (extra: ShipDeskContext = {}) =>
      shipDeskIntake(pull(settings, { author: "actions" }), context(extra))
    // No reader yet (before A59): it cannot be checked, so no card.
    expect(await intake()).toEqual({ kind: "ignored", reason: "run-unverified" })
    expect(await intake({ reader: async () => Promise.reject(new Error("down")) })).toEqual({
      kind: "ignored",
      reason: "run-unverified",
    })
    // A record of another repository, or none, or another account's: no card.
    runs = [
      { account: MAX, rid: RID, repositoryId: "43", event: "issue_comment", source: "github-comment", purpose: "task" },
    ]
    expect(await intake({ reader })).toEqual({ kind: "ignored", reason: "no-run" })
    runs = [{ account: OTHER, rid: RID, repositoryId: String(REPO) }]
    expect(await intake({ reader })).toEqual({ kind: "ignored", reason: "no-run" })
    runs = [
      {
        account: MAX,
        rid: RID,
        repositoryId: String(REPO),
        runUrl: `https://github.com/${FULL}/actions/runs/7001`,
        startedAt: world.now - 600_000,
        endedAt: world.now - 60_000,
        outcome: "changes",
        verdict: "pass",
      },
    ]
    expect(await intake({ reader })).toMatchObject({ kind: "created" })
    const card = await readCard(MAX, cardId(REPO, 12), fetcher())
    expect(card).toMatchObject({
      author: "actions",
      verdict: { value: "pass", final: true },
      runUrl: `https://github.com/${FULL}/actions/runs/7001`,
    })
  })

  test("the verdict comes from the run record, never the body; opening a card reads checks and verdict again", async () => {
    const settings = await ready()
    runs = [{ account: MAX, rid: RID, repositoryId: String(REPO), startedAt: world.now }]
    await shipDeskIntake(pull(settings, { title: "verdict: pass" }), context({ reader }))
    const token = world.token(MAX)
    const open = (extra: ShipDeskContext = {}) =>
      invoke(
        (request, response) => handleOpsCards(request, response, fetcher(), () => world.now, { reader, ...extra }),
        { method: "GET", authorization: token, url: `/api/ops/cards?id=${cardId(REPO, 12)}` },
      )
    let answer = await open()
    expect(answer.status).toBe(200)
    expect(answer.body.card.verdict).toEqual({ value: "none", final: false })
    expect(answer.body.card.checks).toMatchObject({ total: 0 })

    // The run ends with a verdict and a check finishes; a minute later the card reads both again.
    runs[0] = { ...runs[0], endedAt: world.now + 1, outcome: "draft", verdict: "fail" }
    world.github.checkRuns.set(`${REPO}:${HEAD}`, [{ name: "test", status: "completed", conclusion: "failure" }])
    const mints = world.github.minted.length
    answer = await open()
    expect(answer.body.card.verdict).toEqual({ value: "none", final: false })
    expect(world.github.minted.length).toBe(mints)
    // Checks still running (none found yet) are read again once they are two minutes old, at most once a minute.
    world.advance(121_000)
    answer = await open()
    expect(answer.body.card.verdict).toEqual({ value: "fail", final: true })
    expect(answer.body.card.checks).toMatchObject({ total: 1, failed: 1, pending: 0 })
    expect(world.github.minted.length).toBe(mints + 1)
    // Final verdict and finished checks: no more reads.
    world.advance(10 * 61_000)
    await open()
    expect(world.github.minted.length).toBe(mints + 1)
    expect(runFacts({ rid: RID, repositoryId: "042" })).toBeUndefined()
    expect(await lookupRun(MAX, RID, REPO, undefined)).toEqual({ available: false })
  })

  test("a later run on the same pull request moves the card to that run once it is checked", async () => {
    const settings = await ready()
    await shipDeskIntake(pull(settings), context())
    const next = `gh-${REPO}-7005-1-9005`
    await shipDeskIntake(pull(settings, { action: "synchronize", rid: next, headSha: sha("h2") }), context())
    expect((await readCard(MAX, cardId(REPO, 12), fetcher()))?.rid).toBe(next)
    expect(world.fakes.store.get(cardRunKey(MAX, next))).toBe(cardId(REPO, 12))
    // github-actions[bot] cannot move it without the run's record.
    const third = `gh-${REPO}-7006-1-9006`
    await shipDeskIntake(pull(settings, { action: "synchronize", rid: third, author: "actions" }), context())
    expect((await readCard(MAX, cardId(REPO, 12), fetcher()))?.rid).toBe(next)
    // Once Ship Desk is no longer listed, a card made before still follows its pull request.
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await shipDeskIntake(pull(settings, { action: "closed", merged: true }), context())).toMatchObject({
      kind: "updated",
    })
    expect((await readCard(MAX, cardId(REPO, 12), fetcher()))?.state).toBe("merged")
  })
})

// ── The cards route ────────────────────────────────────────────────────────────────────────────────────────────────

describe("the cards route", () => {
  test("callers: account tokens and sessions; run tokens, capture tickets and nothing get 401; each sees only its own", async () => {
    const settings = await ready()
    await shipDeskIntake(pull(settings), context())
    expect((await cards(world.session(MAX))).body.cards).toHaveLength(1)
    expect((await cards(world.token(OTHER))).body.cards).toEqual([])
    expect((await cards(world.token(OTHER), `?id=${cardId(REPO, 12)}`)).status).toBe(404)
    for (const authorization of [runToken(MAX), "vht_fixture.sig", `vcap_${"a".repeat(43)}`, ""])
      expect((await cards(authorization)).status).toBe(401)
    expect(
      (
        await invoke((request, response) => handleOpsCards(request, response, fetcher(), () => world.now), {
          method: "POST",
          authorization: world.token(MAX),
          body: {},
        })
      ).status,
    ).toBe(405)
  })

  test("paused and ended plans keep reading their cards until they expire; frozen hides them without deleting", async () => {
    const settings = await ready()
    await shipDeskIntake(pull(settings), context())
    const token = world.token(MAX)
    for (const state of ["paused", "ended"] as const) {
      world.seed(MAX, "vector-100", state)
      expect((await cards(token)).body.cards).toHaveLength(1)
      expect((await cards(token, `?id=${cardId(REPO, 12)}`)).status).toBe(200)
    }
    world.seed(MAX, "vector-100", "frozen")
    expect((await cards(token)).body).toEqual({ cards: [], hidden: true })
    expect((await cards(token, `?id=${cardId(REPO, 12)}`)).body.error.code).toBe("SHIP_DESK_HIDDEN")
    expect(await readCard(MAX, cardId(REPO, 12), fetcher())).toBeDefined()
    world.seed(MAX, "vector-100")
    world.advance(31 * DAY)
    expect((await cards(token)).body.cards).toEqual([])
  })

  test("P1: a card carries no amount, plan name or usage", async () => {
    const settings = await ready()
    runs = [{ account: MAX, rid: RID, repositoryId: String(REPO), endedAt: world.now, verdict: "pass" }]
    await shipDeskIntake(pull(settings), context({ reader }))
    const text = JSON.stringify((await cards(world.token(MAX))).body)
    for (const word of ["$", "usd", "credit", "cents", "vector-100", "Max", "percent", "usage"])
      expect(text.toLowerCase()).not.toContain(word.toLowerCase())
    const card = decodeCard(JSON.parse(world.fakes.store.get(cardKey(MAX, cardId(REPO, 12)))!))
    expect(Object.keys(cardView(card!))).not.toContain("rid")
  })
})

// ── Capture ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function withCard(account = MAX, plan: PlanId = "vector-100") {
  const settings = await ready(account, plan)
  await shipDeskIntake(pull(settings, { account }), context())
  return settings
}

async function ticketFor(account = MAX, rid = RID, deadline?: number) {
  const answer = await uploads(runToken(account, rid, deadline), { action: "ticket" })
  expect(answer.status).toBe(200)
  return answer.body as ShipDesk.TicketAnswer
}

async function put(upload: ShipDesk.StartAnswer["uploads"][number], bytes: Uint8Array) {
  const signed = Object.fromEntries(Object.entries(upload.headers).filter(([name]) => name !== "content-length"))
  return fetcher()(upload.url, { method: "PUT", headers: signed, body: new Blob([new Uint8Array(bytes)]) })
}

const files = (count: number, bytes = 2_000) =>
  Array.from({ length: count }, (_, index) => ({
    slot: index % 2 ? "after" : "before",
    route: `/page-${Math.floor(index / 2)}`,
    bytes,
    type: "image/png",
  }))

describe("capture", () => {
  test("a run's token asks for a ticket; the ticket captures its own pull request into the card in one window", async () => {
    await withCard()
    const { ticket, expiresAt } = await ticketFor()
    expect(ticket).toMatch(ShipDesk.TICKET)
    expect(expiresAt).toBe(NOW + 2 * 3_600_000 + ShipDesk.LIMITS.ticketGraceMs)
    // Only its hash is stored, listed for the account so deletion finds it.
    expect(world.fakes.store.get(ticketKey(ticketHash(ticket)))).toContain(RID)
    expect(world.fakes.store.get(ticketKey(ticketHash(ticket)))).not.toContain(ticket)
    expect(world.fakes.store.zset(ticketIndexKey(MAX)).has(ticketHash(ticket))).toBe(true)

    const card = await uploads(ticket, { action: "card", pr: 12 })
    expect(card.body).toEqual({ repository: FULL, number: 12, baseRef: "main", baseSha: BASE, headSha: HEAD, files: 8 })
    // Asking for the card starts nothing; the first start opens the window.
    world.advance(30 * 60_000)
    const started = await uploads(ticket, { action: "start", pr: 12, files: files(2) })
    expect(started.status).toBe(200)
    expect(started.body.until).toBe(world.now + ShipDesk.LIMITS.windowMs)
    expect(started.body.uploads).toHaveLength(2)
    for (const upload of started.body.uploads) {
      expect(upload.headers).toEqual({ "content-length": "2000", "content-type": "image/png" })
      expect((await put(upload, png())).status).toBe(200)
    }
    // A link signs its exact size: a larger body is refused by storage.
    expect((await put(started.body.uploads[0], png(1280, 800, 3_000))).status).toBe(403)
    const finished = await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture })
    expect(finished.body).toEqual({ images: 2, refused: [] })
    // Each file was read back by its size and its first 64 bytes only.
    expect(bucket.calls.filter((call) => call.method === "GET").every((call) => call.range === "bytes=0-63")).toBe(true)

    const view = (await cards(world.token(MAX), `?id=${cardId(REPO, 12)}`)).body.card
    expect(view.images).toEqual([
      { n: 1, slot: "before", route: "/page-0", type: "image/png", width: 1280, height: 800 },
      { n: 2, slot: "after", route: "/page-0", type: "image/png", width: 1280, height: 800 },
    ])
    expect(view.imagesOutdated).toBeUndefined()
    // The ticket is spent.
    expect((await uploads(ticket, { action: "start", pr: 12, files: files(1) })).body.error.code).toBe(
      "SHIP_DESK_CAPTURE_DONE",
    )
  })

  test("images are read back by the card's account only, through 60-second signed links that pin type and disposition", async () => {
    await withCard()
    const { ticket } = await ticketFor()
    const started = await uploads(ticket, { action: "start", pr: 12, files: files(1) })
    await put(started.body.uploads[0], png())
    await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture })
    const answer = await image(world.token(MAX), cardId(REPO, 12), 1)
    expect(answer.status).toBe(200)
    expect(answer.headers["x-content-type-options"]).toBe("nosniff")
    expect(answer.headers["content-security-policy"]).toBe("default-src 'none'; sandbox")
    expect(answer.headers["cache-control"]).toBe("no-store")
    expect(answer.body).toMatchObject({ type: "image/png", width: 1280, height: 800, expiresAt: world.now + 60_000 })
    const link = new URL(answer.body.url)
    expect(link.origin).toBe(R2_ORIGIN)
    expect(link.searchParams.get("X-Amz-Expires")).toBe("60")
    const got = await fetcher()(answer.body.url, { method: "GET" })
    expect(got.status).toBe(200)
    expect(got.headers.get("content-type")).toBe("image/png")
    expect(got.headers.get("cache-control")).toBe("no-store, private")
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="${cardId(REPO, 12)}-1.png"`)
    // A changed override breaks the signature.
    link.searchParams.set("response-content-type", "text/html")
    expect((await fetcher()(link.href, { method: "GET" })).status).toBe(403)
    world.advance(61_000)
    expect((await fetcher()(answer.body.url, { method: "GET" })).status).toBe(403)

    expect((await image(world.token(OTHER), cardId(REPO, 12), 1)).status).toBe(404)
    expect((await image(world.token(MAX), cardId(REPO, 12), 2)).status).toBe(404)
    expect((await image(world.token(MAX), "crd_nope", 1)).status).toBe(404)
    for (const authorization of [runToken(MAX), ticket, ""])
      expect((await image(authorization, cardId(REPO, 12), 1)).status).toBe(401)
    world.seed(MAX, "vector-100", "frozen")
    expect((await image(world.token(MAX), cardId(REPO, 12), 1)).body.error.code).toBe("SHIP_DESK_HIDDEN")
  })

  test("each upload is checked by its signature and size; SVG, wrong types, wrong sizes and missing files are refused and deleted", async () => {
    await withCard()
    const { ticket } = await ticketFor()
    const declared = [
      { slot: "before", route: "/", bytes: 2_000, type: "image/png" },
      { slot: "after", route: "/", bytes: SVG.byteLength, type: "image/png" },
      { slot: "before", route: "/a", bytes: 64, type: "image/png" },
      { slot: "after", route: "/a", bytes: 64, type: "image/webp" },
      { slot: "before", route: "/b", bytes: 2_000, type: "image/png" },
    ]
    const started = await uploads(ticket, { action: "start", pr: 12, files: declared })
    const [one, two, three, four] = started.body.uploads
    await put(one, png())
    await put(two, SVG)
    await put(three, webp("VP8X", 100, 100))
    await put(four, webp("VP8L", 100, 100))
    // The fifth never arrives. The third claims PNG but is WebP.
    const finished = await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture })
    expect(finished.body).toEqual({
      images: 2,
      refused: [
        { n: 2, reason: "type" },
        { n: 3, reason: "type" },
        { n: 5, reason: "missing" },
      ],
    })
    const kept = (await readCard(MAX, cardId(REPO, 12), fetcher()))!.images
    expect(kept.map((item) => [item.n, item.type])).toEqual([
      [1, "image/png"],
      [4, "image/webp"],
    ])
    expect([...bucket.objects.keys()].sort()).toEqual(kept.map((item) => item.key).sort())

    // Declared files are checked before anything is signed, and before the window opens.
    const other = await ticketFor(MAX, RID)
    for (const bad of [
      [],
      files(9),
      [{ slot: "before", route: "/", bytes: 2_000, type: "image/svg+xml" }],
      [{ slot: "before", route: "/", bytes: ShipDesk.LIMITS.imageBytes + 1, type: "image/png" }],
      [{ slot: "before", route: "https://evil.example/", bytes: 2_000, type: "image/png" }],
      [
        { slot: "before", route: "/", bytes: 2_000, type: "image/png" },
        { slot: "before", route: "/", bytes: 2_000, type: "image/png" },
      ],
      [{ slot: "before", route: "/", bytes: 2_000, type: "image/png", url: "https://x" }],
    ])
      expect((await uploads(other.ticket, { action: "start", pr: 12, files: bad })).body.error.code).toBe(
        "SHIP_DESK_CAPTURE_INVALID",
      )
    expect(JSON.parse(world.fakes.store.get(ticketKey(ticketHash(other.ticket)))!).firstUse).toBeUndefined()
    expect(bucket.calls.filter((call) => call.method === "PUT")).toHaveLength(4)
  })

  test("a new capture replaces the card's images and deletes the old ones; the images say when they are of an older head", async () => {
    const settings = await withCard()
    const capture = async (rid: string, count: number) => {
      const { ticket } = await ticketFor(MAX, rid)
      const started = await uploads(ticket, { action: "start", pr: 12, files: files(count) })
      for (const upload of started.body.uploads) await put(upload, png())
      return uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture })
    }
    expect((await capture(RID, 2)).body.images).toBe(2)
    const first = new Set(bucket.objects.keys())
    // The agent pushes again: a new head and a new run on the same pull request.
    const next = `gh-${REPO}-7009-1-9009`
    await shipDeskIntake(pull(settings, { action: "synchronize", headSha: sha("h3"), rid: next }), context())
    let view = (await cards(world.token(MAX), `?id=${cardId(REPO, 12)}`)).body.card
    expect(view.imagesOutdated).toBe(true)
    // The old run's ticket is for another pull request now.
    const stale = await ticketFor(MAX, RID)
    expect((await uploads(stale.ticket, { action: "card", pr: 12 })).body.error.code).toBe("SHIP_DESK_TICKET_MISMATCH")
    expect((await capture(next, 3)).body.images).toBe(3)
    expect([...bucket.objects.keys()].some((key) => first.has(key))).toBe(false)
    expect(bucket.objects.size).toBe(3)
    view = (await cards(world.token(MAX), `?id=${cardId(REPO, 12)}`)).body.card
    expect(view.images).toHaveLength(3)
    expect(view.imagesOutdated).toBeUndefined()
  })

  test("the window: 15 minutes from the first start; a ticket unused past the run's deadline plus an hour is spent", async () => {
    await withCard()
    const { ticket } = await ticketFor()
    const started = await uploads(ticket, { action: "start", pr: 12, files: files(1) })
    await put(started.body.uploads[0], png())
    world.advance(ShipDesk.LIMITS.windowMs + 1)
    expect((await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture })).body.error.code).toBe(
      "SHIP_DESK_TICKET_EXPIRED",
    )
    // A ticket must be first used within the run's deadline plus an hour.
    const late = await ticketFor(MAX, RID, world.now + 10 * 60_000)
    world.advance(10 * 60_000 + ShipDesk.LIMITS.ticketGraceMs + 1)
    expect((await uploads(late.ticket, { action: "card", pr: 12 })).body.error.code).toBe("SHIP_DESK_TICKET_EXPIRED")
    // A start again before finishing replaces the pending capture.
    const again = await ticketFor(MAX, RID, world.now + 60 * 60_000)
    const a = await uploads(again.ticket, { action: "start", pr: 12, files: files(1) })
    await put(a.body.uploads[0], png())
    const b = await uploads(again.ticket, { action: "start", pr: 12, files: files(1) })
    expect(b.body.until).toBe(a.body.until)
    expect((await uploads(again.ticket, { action: "finish", pr: 12, capture: a.body.capture })).body.error.code).toBe(
      "SHIP_DESK_CAPTURE_UNKNOWN",
    )
    expect(bucket.objects.size).toBe(0)
  })

  test("tickets: only a run token, for a run of a repository bound to the account with Ship Desk on and a plan that has it", async () => {
    // No card yet: the ticket is minted; the capture waits for the card.
    await ready()
    const { ticket } = await ticketFor()
    const pending = await uploads(ticket, { action: "card", pr: 12 })
    expect(pending.status).toBe(409)
    expect(pending.body.error).toMatchObject({ code: "SHIP_DESK_CARD_PENDING", retryAfterMs: 10_000 })

    expect((await uploads(world.token(MAX), { action: "ticket" })).status).toBe(401)
    expect((await uploads(runToken(MAX), { action: "start", pr: 12, files: files(1) })).status).toBe(401)
    expect((await uploads("vrt_unknown.sig", { action: "ticket" })).status).toBe(401)
    expect((await uploads(`vcap_${"b".repeat(43)}`, { action: "card", pr: 12 })).body.error.code).toBe(
      "SHIP_DESK_TICKET_INVALID",
    )
    expect((await uploads(runToken(MAX, "not-a-github-run"), { action: "ticket" })).body.error.code).toBe(
      "SHIP_DESK_RUN_INVALID",
    )
    expect((await uploads(runToken(MAX, `gh-999-1-1-1`), { action: "ticket" })).body.error.code).toBe(
      "OPS_REPO_NOT_BOUND",
    )
    await ready(MAX, "vector-100", { shipDesk: false })
    expect((await uploads(runToken(MAX), { action: "ticket" })).body.error.code).toBe("SHIP_DESK_OFF")
    await ready(MAX, "vector-50")
    expect((await uploads(runToken(MAX), { action: "ticket" })).body.error.code).toBe("CODIUM_PERK_REQUIRED")
    world.seed(MAX, "vector-100", "paused")
    expect((await uploads(runToken(MAX), { action: "ticket" })).status).toBe(402)
    world.seed(MAX, "vector-100")
    world.switchOff("ops")
    expect((await uploads(runToken(MAX), { action: "ticket" })).body.error.code).toBe("OPS_PAUSED")
    expect(
      (await uploads(ticket, { action: "card", pr: 12, extra: true } as Record<string, unknown>)).body.error.code,
    ).toBe("SHIP_DESK_CAPTURE_INVALID")
  })

  test("the first request binds the ticket to its capture job: a copy from the log, with another proof or none, does nothing", async () => {
    await withCard()
    const { ticket } = await ticketFor()
    const mine = "m".repeat(43)
    const theirs = "x".repeat(43)
    expect((await uploads(ticket, { action: "card", pr: 12 }, null)).body.error.code).toBe("SHIP_DESK_CAPTURE_INVALID")
    expect((await uploads(ticket, { action: "card", pr: 12, proof: "short" })).body.error.code).toBe(
      "SHIP_DESK_CAPTURE_INVALID",
    )
    expect((await uploads(ticket, { action: "card", pr: 12, proof: mine })).status).toBe(200)
    const stored = JSON.parse(world.fakes.store.get(ticketKey(ticketHash(ticket)))!)
    // Only the proof's hash is kept, and asking for the card opened no window.
    expect(stored).toMatchObject({ proof: createHash("sha256").update(mine).digest("hex"), boundAt: world.now })
    expect(stored.firstUse).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain(mine)
    // Someone who read the ticket while the capture job installs and builds can neither start nor finish.
    world.advance(20 * 60_000)
    for (const body of [
      { action: "card", pr: 12, proof: theirs },
      { action: "start", pr: 12, files: files(1), proof: theirs },
    ])
      expect(await uploads(ticket, body)).toMatchObject({ status: 403, body: { error: { code: "SHIP_DESK_TICKET_BOUND" } } })
    const started = await uploads(ticket, { action: "start", pr: 12, files: files(1), proof: mine })
    expect(started.status).toBe(200)
    await put(started.body.uploads[0], png())
    expect(
      (await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture, proof: theirs })).body.error.code,
    ).toBe("SHIP_DESK_TICKET_BOUND")
    expect((await uploads(ticket, { action: "finish", pr: 12, capture: started.body.capture, proof: mine })).body).toEqual({
      images: 1,
      refused: [],
    })
  })

  test("no ticket for a public repository, whose Actions logs anyone can read, or while Ship Desk is not listed", async () => {
    await withCard()
    world.github.repos.get(REPO)!.private = false
    expect(await uploads(runToken(MAX), { action: "ticket" })).toMatchObject({
      status: 403,
      body: { error: { code: "SHIP_DESK_PUBLIC_REPOSITORY" } },
    })
    // Read with a read-only token for that repository, revoked after use.
    expect(world.github.minted.at(-1)).toMatchObject({ repositoryId: REPO })
    expect(Object.values(world.github.minted.at(-1)!.permissions)).not.toContain("write")
    expect(world.github.live()).toEqual([])
    world.github.repos.get(REPO)!.private = true
    expect((await uploads(runToken(MAX), { action: "ticket" })).status).toBe(200)
    world.github.down = true
    expect((await uploads(runToken(MAX), { action: "ticket" })).body.error.code).toBe("GITHUB_UNAVAILABLE")
    world.github.down = false
    delete process.env.VECTOR_OPS_ALLOW_ACCOUNTS
    expect(await uploads(runToken(MAX), { action: "ticket" })).toMatchObject({
      status: 503,
      body: { error: { code: "OPS_UNAVAILABLE" } },
    })
  })

  test("a closed pull request takes no images; a frozen plan takes none either", async () => {
    const settings = await withCard()
    const { ticket } = await ticketFor()
    await shipDeskIntake(pull(settings, { action: "closed", merged: false }), context())
    expect((await uploads(ticket, { action: "card", pr: 12 })).body.error.code).toBe("SHIP_DESK_CLOSED")
    await shipDeskIntake(pull(settings, { action: "reopened" }), context())
    expect((await uploads(ticket, { action: "card", pr: 12 })).status).toBe(200)
    world.seed(MAX, "vector-100", "frozen")
    expect((await uploads(ticket, { action: "card", pr: 12 })).body.error.code).toBe("SHIP_DESK_HIDDEN")
  })
})

// ── Erasure and the meter ──────────────────────────────────────────────────────────────────────────────────────────

describe("erasure (P5) and the meter", () => {
  test("account deletion erases cards, images, pending uploads, run claims and tickets in both modes", async () => {
    await withCard()
    const { ticket } = await ticketFor()
    const done = await uploads(ticket, { action: "start", pr: 12, files: files(2) })
    for (const upload of done.body.uploads) await put(upload, png())
    await uploads(ticket, { action: "finish", pr: 12, capture: done.body.capture })
    const pending = await ticketFor(MAX, RID)
    const open = await uploads(pending.ticket, { action: "start", pr: 12, files: files(1) })
    await put(open.body.uploads[0], png())
    expect(bucket.objects.size).toBe(3)
    expect(await cardsUsed(world.snapshotFor(MAX, "vector-100"), fetcher())).toBe(1)

    // The ops provisioner erases Ship Desk with everything else on `closing` (its Worker call signs with the clock).
    setSystemTime(new Date(world.now))
    const closing = world.snapshotFor(MAX, "vector-100", "ended", { reason: "closing" })
    await opsProvisioner.apply(
      { account: MAX, from: world.snapshotFor(MAX, "vector-100"), to: closing, cause: "closing" },
      fetcher(),
    )
    expect(bucket.objects.size).toBe(0)
    const left = world.fakes.store
      .keys()
      .filter(
        (key) =>
          key.includes(`:ops:card:${MAX}`) || key.includes(`:ops:cards:${MAX}`) || key.includes(":ops:card:ticket:"),
      )
    expect(left).toEqual([])
    expect(world.fakes.store.get(cardRunKey(MAX, RID))).toBeUndefined()
    expect(world.fakes.store.zset(cardIndexKey(MAX)).size).toBe(0)
    // Storage down: erasure throws so the provisioner tries again.
    await withCard()
    const again = await ticketFor()
    const one = await uploads(again.ticket, { action: "start", pr: 12, files: files(1) })
    await put(one.body.uploads[0], png())
    await uploads(again.ticket, { action: "finish", pr: 12, capture: one.body.capture })
    bucket.state.down = true
    await expect(eraseAccountShipDesk(MAX, fetcher(), world.now)).rejects.toMatchObject({ code: "R2_UNAVAILABLE" })
    expect(await readCard(MAX, cardId(REPO, 12), fetcher())).toBeDefined()
    bucket.state.down = false
    await eraseAccountShipDesk(MAX, fetcher(), world.now)
    expect(await readCard(MAX, cardId(REPO, 12), fetcher())).toBeUndefined()
  })

  test("the status meter's figure is the period's counted cards", async () => {
    await import("../api/_lib/ship-desk-meter")
    const snapshot = world.snapshotFor(MAX, "vector-100")
    expect(await cardsUsed(snapshot, fetcher())).toBe(0)
    await withCard()
    expect(await cardsUsed(snapshot, fetcher())).toBe(1)
    world.fakes.store.set(meterKey(snapshot, SHIP_DESK_CARD_METER), "garbage")
    expect(await cardsUsed(snapshot, fetcher())).toBeUndefined()
    expect(PRO).toBeDefined()
  })
})

// ── Valkey (CI) ────────────────────────────────────────────────────────────────────────────────────────────────────

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL

describe.skipIf(!valkeyURL)("Ship Desk's CARD script on Valkey", () => {
  const client = valkeyURL ? new RedisClient(valkeyURL) : undefined
  beforeEach(async () => {
    await client!.send("FLUSHDB", [])
  })

  test("dedupe before increment, one card per run, the month's cap, and the index", async () => {
    expect(Object.keys(SHIP_DESK_SCRIPTS)).toEqual(["CARD"])
    const run = (card: string, rid: string, cap: number, at = NOW) =>
      client!.send("EVAL", [
        SHIP_DESK_SCRIPTS.CARD,
        "4",
        card,
        `run:${rid}`,
        "meter",
        "index",
        JSON.stringify({ card }),
        card,
        String(cap),
        "60000",
        // The meter's expiry is an absolute wall-clock time Valkey checks against its own clock.
        String(Date.now() + 3_600_000),
        String(at),
        String(at - 10_000),
        "2",
        "60000",
      ])
    expect(await run("c1", "r1", 2)).toBe(1)
    expect(await run("c1", "r9", 2)).toBe(0)
    expect(await run("c2", "r1", 2)).toBe(2)
    expect(await client!.send("GET", ["meter"])).toBe("1")
    expect(await run("c2", "r2", 2, NOW + 1)).toBe(1)
    expect(await run("c3", "r3", 2, NOW + 2)).toBe(-1)
    expect(await client!.send("GET", ["meter"])).toBe("2")
    expect(Number(await client!.send("PTTL", ["c1"]))).toBeGreaterThan(50_000)
    expect(Number(await client!.send("PTTL", ["meter"]))).toBeGreaterThan(0)
    expect(await run("c4", "r4", 5, NOW + 20_000)).toBe(1)
    expect(await client!.send("ZRANGE", ["index", "0", "-1"])).toEqual(["c4"])
  })
})
