// CI only (WP A46): runs the ops Worker's deploy bundle (dist/index.js from `bun run dry-run`) on Cloudflare's local
// runtime through miniflare, the library under `wrangler dev`, with every outbound request answered here: the sites
// being probed, the DNS-over-HTTPS lookups and the API taking reports. It checks what the unit tests' fakes cannot:
// real alarms on SQLite-backed Durable Objects, real fetches with `redirect: "manual"` and abort timeouts, the KV kill
// flag, and the signed calls both ways. Alarms run in real time, so this takes about three minutes. It generates
// throwaway keys; nothing here is a real secret and nothing is deployed or fetched from the internet.
//
//   bun run dry-run && bun run smoke      (from packages/ops-worker; Node runs it, as it runs wrangler)

import { createHash, createHmac, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const bundle = path.join(root, "dist/index.js")
if (!existsSync(bundle)) {
  console.log("FAIL dist/index.js is missing: run `bun run dry-run` first")
  process.exit(1)
}
// miniflare is wrangler's own dependency, at the version wrangler pins; it is loaded from beside wrangler.
const fromPackage = createRequire(path.join(root, "package.json"))
const fromWrangler = createRequire(fromPackage.resolve("wrangler/package.json"))
const { Miniflare, Response: MiniflareResponse } = fromWrangler("miniflare")

const config = JSON.parse(
  readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1"),
)
const INTERNAL_SECRET = randomBytes(32).toString("base64url")
const ACCOUNT_KEY = randomBytes(32).toString("base64url")
const API = "https://vectordev.ai"
const ACCOUNT = "acct_ops_smoke_0001"
const LAPSED = "acct_ops_smoke_0002"
const UP = Array.from({ length: 9 }, (_, index) => `up${index}.ops-smoke-site.com`)
const DOWN = "down.ops-smoke-site.com"
const LAPSED_HOST = "lapsed.ops-smoke-site.com"

const failures = []
async function check(name, run) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A37's signature with node:crypto, as the API computes it (api/_lib/hosted-internal.ts). */
function signature(secret, { method, path: target, body, timestamp, nonce }) {
  const key = createHmac("sha256", secret).update("vector-internal-v1/ops").digest()
  const canonical = [
    "vector-internal-v1",
    "ops",
    method,
    target,
    String(timestamp),
    nonce,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n")
  return createHmac("sha256", key).update(canonical).digest("base64url")
}

// The outside world.
const world = { inFlight: 0, maxInFlight: 0, probes: new Map(), dns: 0, reports: [], badReports: 0 }

async function outbound(request) {
  const url = new URL(request.url)
  if (url.origin === "https://cloudflare-dns.com") {
    world.dns++
    const type = url.searchParams.get("type")
    const answer =
      type === "A" ? [{ name: url.searchParams.get("name"), type: 1, TTL: 300, data: "104.16.132.229" }] : []
    return new MiniflareResponse(JSON.stringify({ Status: 0, Answer: answer }), {
      headers: { "content-type": "application/dns-json" },
    })
  }
  if (url.href === `${API}/api/ops/worker`) {
    const body = await request.text()
    const timestamp = request.headers.get("x-vector-internal-timestamp")
    const nonce = request.headers.get("x-vector-internal-nonce")
    const expected = signature(INTERNAL_SECRET, { method: "POST", path: url.pathname, body, timestamp, nonce })
    if (request.headers.get("x-vector-internal-signature") !== expected) {
      world.badReports++
      return new MiniflareResponse("{}", { status: 401 })
    }
    world.reports.push(JSON.parse(body))
    return new MiniflareResponse("{}", { status: 200 })
  }
  world.probes.set(url.href, (world.probes.get(url.href) ?? 0) + 1)
  world.inFlight++
  world.maxInFlight = Math.max(world.maxInFlight, world.inFlight)
  try {
    await sleep(300)
    if (url.hostname === DOWN) return new MiniflareResponse("down", { status: 500 })
    if (url.pathname === "/moved") return new MiniflareResponse(null, { status: 302, headers: { location: "/home" } })
    return new MiniflareResponse("ok", { status: 200 })
  } finally {
    world.inFlight--
  }
}

const mf = new Miniflare({
  modules: true,
  scriptPath: bundle,
  compatibilityDate: config.compatibility_date,
  durableObjects: { OPS_ACCOUNT: { className: "OpsAccount", useSQLite: true } },
  kvNamespaces: ["OPS_FLAGS"],
  bindings: { INTERNAL_SECRET, ACCOUNT_KEY, API_ORIGIN: API },
  outboundService: outbound,
})

async function internal(action, body, options = {}) {
  const text = JSON.stringify(body)
  const target = `/internal/v1/${action}`
  const timestamp = Math.floor(Date.now() / 1000)
  const nonce = options.nonce ?? randomBytes(16).toString("base64url")
  const response = await mf.dispatchFetch(`https://vector-ops.smoke${target}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vector-internal-timestamp": String(timestamp),
      "x-vector-internal-nonce": nonce,
      "x-vector-internal-signature": signature(options.secret ?? INTERNAL_SECRET, {
        method: "POST",
        path: target,
        body: text,
        timestamp,
        nonce,
      }),
    },
    body: text,
  })
  return { status: response.status, body: await response.json(), nonce }
}

const ultra = (validUntil) => ({
  version: 1,
  domains: 10,
  onCall: { urls: 10, intervalSec: 60 },
  releaseGuard: { perDay: 30, watchMin: 60, paths: 5 },
  validUntil,
})
const probes = (host) =>
  [...world.probes].filter(([url]) => new URL(url).hostname === host).reduce((sum, [, n]) => sum + n, 0)

try {
  await mf.ready

  await check("health answers and unsigned calls are refused", async () => {
    const health = await mf.dispatchFetch("https://vector-ops.smoke/health")
    assert(health.status === 200, `health ${health.status}`)
    const forged = await internal("state", { account: ACCOUNT }, { secret: randomBytes(32).toString("base64url") })
    assert(forged.status === 401, `forged call answered ${forged.status}`)
  })

  const started = Date.now()
  await check("an Ultra plan and ten monitors are taken; a plan that lapsed is taken too", async () => {
    const plan = await internal("plan", { account: ACCOUNT, plan: ultra(Date.now() + 30 * 86_400_000) })
    assert(plan.status === 200 && plan.body.applied === true, JSON.stringify(plan))
    const monitors = [
      ...UP.map((host, index) => ({ id: `up${index}`, url: `https://${host}/${index === 0 ? "moved" : ""}` })),
      { id: "down", url: `https://${DOWN}/` },
    ]
    const config = await internal("config", { account: ACCOUNT, domains: [...UP, DOWN], monitors })
    assert(config.status === 200 && config.body.probed === 10, JSON.stringify(config))
    const lapsed = await internal("plan", { account: LAPSED, plan: ultra(Date.now() + 15_000) })
    assert(lapsed.status === 200, JSON.stringify(lapsed))
    const lapsedConfig = await internal("config", {
      account: LAPSED,
      domains: [LAPSED_HOST],
      monitors: [{ id: "only", url: `https://${LAPSED_HOST}/` }],
    })
    assert(lapsedConfig.status === 200, JSON.stringify(lapsedConfig))
  })

  await check("nothing is probed before the alarm, which is at least 25 s ahead", async () => {
    await sleep(15_000)
    assert(world.probes.size === 0, `probed early: ${[...world.probes.keys()].join(", ")}`)
  })

  // A probe that followed the same-origin redirect would probe up0 twice.
  await check("the first wake probes every monitor once, at most 6 at a time, after looking each host up", async () => {
    const deadline = started + 45_000
    while (Date.now() < deadline && probes(DOWN) < 1) await sleep(500)
    await sleep(3_000)
    for (const host of [...UP, DOWN]) assert(probes(host) === 1, `${host} probed ${probes(host)} times`)
    assert(world.maxInFlight <= 6, `${world.maxInFlight} probes ran at once`)
    assert(world.dns >= 20, `only ${world.dns} DNS questions`)
    console.log(`     (at most ${world.maxInFlight} probes in flight)`)
  })

  await check("the second failure in a row reports the URL down, signed for the ops service", async () => {
    const deadline = started + 120_000
    while (Date.now() < deadline && !world.reports.length) await sleep(500)
    assert(world.badReports === 0, `${world.badReports} reports had a bad signature`)
    assert(world.reports.length === 1, `${world.reports.length} reports`)
    const [report] = world.reports
    assert(report.v === 1 && report.account === ACCOUNT, JSON.stringify(report))
    assert(report.events.length === 1, JSON.stringify(report.events))
    const [event] = report.events
    assert(event.kind === "monitor.down" && event.monitor === "down", JSON.stringify(event))
    assert(event.reason === "status" && event.status === 500, JSON.stringify(event))
    assert(probes(DOWN) === 2, `the down URL was probed ${probes(DOWN)} times`)
  })

  await check("state: nine monitors up (the same-origin redirect counts as up), one down", async () => {
    const state = await internal("state", { account: ACCOUNT })
    assert(state.status === 200, JSON.stringify(state))
    const states = Object.fromEntries(state.body.monitors.map((monitor) => [monitor.id, monitor.state]))
    for (let index = 0; index < 9; index++) assert(states[`up${index}`] === "up", JSON.stringify(states))
    assert(states.down === "down", JSON.stringify(states))
    assert(!JSON.stringify(state.body).includes("ops-smoke-site.com"), "state carried a URL")
  })

  await check("a plan past its validUntil probes nothing by itself", async () => {
    assert(probes(LAPSED_HOST) === 0, `the lapsed account probed ${probes(LAPSED_HOST)} times`)
    const state = await internal("state", { account: LAPSED })
    assert(state.body.active === false, JSON.stringify(state.body))
  })

  await check("a release is accepted once; the same sha again is a duplicate", async () => {
    const release = {
      account: ACCOUNT,
      repositoryId: 42,
      environment: "production",
      sha: "a".repeat(40),
      deployment: "1001",
      at: Date.now(),
      urls: [`https://${UP[1]}/`],
    }
    const first = await internal("release", release)
    assert(first.status === 200 && first.body.accepted === true, JSON.stringify(first))
    const again = await internal("release", release)
    assert(again.body.accepted === false && again.body.reason === "duplicate", JSON.stringify(again))
  })

  await check("the kill flag stops every probe until it is cleared", async () => {
    const set = await internal("flags", { kill: true })
    assert(set.status === 200, JSON.stringify(set))
    const kv = await mf.getKVNamespace("OPS_FLAGS")
    assert((await kv.get("kill")) === "1", "the flag was not written")
    // A wake that read the flag just before it was set may still be finishing its probes.
    await sleep(3_000)
    const before = [...world.probes.values()].reduce((sum, n) => sum + n, 0)
    await sleep(70_000)
    const after = [...world.probes.values()].reduce((sum, n) => sum + n, 0)
    assert(after === before, `${after - before} probes ran while the Worker was off`)
    const cleared = await internal("flags", { kill: false })
    assert(cleared.status === 200 && (await kv.get("kill")) === null, "the flag was not cleared")
  })

  await check("erase leaves nothing, and a replayed call is refused", async () => {
    const erased = await internal("erase", { account: ACCOUNT })
    assert(erased.status === 200 && erased.body.erased === true, JSON.stringify(erased))
    const state = await internal("state", { account: ACCOUNT })
    assert(
      state.body.monitors.length === 0 && state.body.plan === null && state.body.releases.length === 0,
      JSON.stringify(state.body),
    )
    const replay = await internal("state", { account: ACCOUNT }, { nonce: erased.nonce })
    assert(replay.status === 401, `a replayed nonce answered ${replay.status}`)
  })
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.log(`FAIL ${failures.at(-1)}`)
} finally {
  await mf.dispose()
}

console.log(failures.length ? `\n${failures.length} ops smoke check(s) failed` : "\nops smoke passed")
process.exit(failures.length ? 1 : 0)
