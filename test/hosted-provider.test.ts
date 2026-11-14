import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isIP } from "node:net"
import path from "node:path"
import { APIError } from "@vercel/sandbox"
import { Hosted } from "../packages/schema/src/hosted"
import { switchKey } from "../api/_lib/codium-switches"
import { hostedAccount, hostedRunningKey } from "../api/_lib/hosted-ledger"
import {
  COMPUTER_PREFIX,
  HOSTED_DENIED_SUBNETS,
  MAX_COMPUTERS,
  MAX_TIMEOUT_MS,
  RECONCILE_EVERY_MS,
  RECONCILE_SLACK_MS,
  TIMEOUT_GRACE_MS,
  accountComputerPrefix,
  computerConfig,
  computerName,
  eraseAccountComputers,
  hostedComputerKey,
  hostedProvider,
  hostedProviderConfigured,
  hostedProviderProblems,
  hostedRunHost,
  isComputerName,
  reconcileHostedComputers,
  setHostedRunToken,
  startHostedComputer,
  stopHostedComputer,
  type ComputerConfig,
  type HostedProvider,
} from "../api/_lib/hosted-provider"
import { cloudflareProvider } from "../api/_lib/hosted-provider-cloudflare"
import {
  MODE_TAG,
  SIZE_TAG,
  sandboxError,
  vercelProvider,
  vercelProviderProblems,
  type VercelSandboxSdk,
} from "../api/_lib/hosted-provider-vercel"
import { HOLD_MINUTES, HOSTED_SIZES } from "../api/_lib/hosted-rates"
import { blockedAddress } from "../api/_lib/safe-fetch"
import { codiumFakes, codiumTestEnvironment, type CodiumFakes } from "../packages/web/test/fixture/codium-fakes"
import { HOSTED_SALT } from "./hosted-fixture"

// WP A52: the cloud computer's provider adapter and reconciler. The provider is mocked: a fake of the `@vercel/sandbox`
// SDK records every call, and the store is the Codium fake. No provider, store or other service is reached; the
// fixture fetcher throws on any address but the fake store's.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 5, 12)
const ACCOUNT = "4f9c2b1e-8a3d-4c5e-9f6a-1b2c3d4e5f60"
const OTHER = "0b7e5d2c-1a9f-4e3b-8c6d-5e4f3a2b1c0d"
const TOKEN = "vht_fixture-run-token-0123456789abcdefghijklmnop"
const CREDENTIALS = {
  token: "fixture-hosted-vercel-token",
  teamId: "team_hostedfixture",
  projectId: "prj_hostedfixture",
}
const BASE = "snap_basefixture"
/** The deny list in the contract's own words (§WP A52): every one must be refused. */
const CONTRACT_DENIED = [
  "fc00::/7",
  "fe80::/10",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "::1/128",
  "224.0.0.0/4",
  "240.0.0.0/4",
]

const HOSTED_ENV = {
  VECTOR_HOSTED_ACCOUNT_SALT: HOSTED_SALT,
  // No provider is named by default: every test hands its fake provider in, so no path can load the real SDK.
  VECTOR_HOSTED_PROVIDER: undefined,
  VECTOR_HOSTED_VERCEL_TOKEN: CREDENTIALS.token,
  VECTOR_HOSTED_VERCEL_TEAM_ID: CREDENTIALS.teamId,
  VECTOR_HOSTED_VERCEL_PROJECT_ID: CREDENTIALS.projectId,
  VECTOR_HOSTED_BASE_SNAPSHOT: BASE,
  VERCEL_HOSTED_TEAM_ID: CREDENTIALS.teamId,
  VERCEL_SPEND_WEBHOOK_SECRET_HOSTED: "fixture-hosted-spend-secret",
  VERCEL_MAIN_TEAM_ID: "team_mainfixture",
  VECTOR_HOSTED_RUN_HOST: undefined,
  RESEND_API_KEY: undefined,
  VECTOR_PURCHASE_EMAIL_FROM: undefined,
  CODIUM_OWNER_EMAIL: undefined,
}

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment(HOSTED_ENV)
})
afterEach(() => restore())

// ── A fake of the SDK ──────────────────────────────────────────────────────────────────────────────────────────────

type Box = {
  name: string
  status: string
  tags?: Record<string, string>
  settings: Record<string, any>
  diskGone?: "always" | "resume"
  /** How many more resumes find it still saving its disk. */
  saving?: number
}

function apiError(status: number, code: string) {
  return new APIError(new Response(null, { status }), { json: { error: { code } } })
}

class FakeSandboxes {
  readonly boxes = new Map<string, Box>()
  readonly calls: { method: string; name?: string; params: any }[] = []
  pageSize = 100
  failList = false

  add(name: string, status: string, tags: Record<string, string> | null = { [MODE_TAG]: "test" }) {
    this.boxes.set(name, { name, status, ...(tags ? { tags } : {}), settings: {} })
  }

  sdk(): VercelSandboxSdk {
    const create = async (params: any) => {
      this.calls.push({ method: "create", name: params.name, params })
      if (this.boxes.has(params.name)) throw apiError(409, "conflict")
      const box: Box = { name: params.name, status: "running", tags: params.tags, settings: { ...params } }
      this.boxes.set(params.name, box)
      return this.instance(box)
    }
    const get = async (params: any) => {
      this.calls.push({ method: params.resume ? "resume" : "get", name: params.name, params })
      const box = this.boxes.get(params.name)
      if (!box) throw apiError(404, "not_found")
      if (box.diskGone === "always" || (box.diskGone === "resume" && params.resume))
        throw apiError(410, "snapshot_not_found")
      if (params.resume && box.saving) {
        box.saving--
        throw apiError(422, "sandbox_snapshotting")
      }
      if (params.resume) box.status = "running"
      return this.instance(box)
    }
    return {
      create,
      get,
      getOrCreate: async (params: any) => {
        try {
          return await get(params)
        } catch (error) {
          const kind = sandboxError(error)
          if (kind !== "not-found" && kind !== "disk-missing") throw error
          if (kind === "disk-missing") this.boxes.delete(params.name)
          const made = await create(params)
          await params.onCreate?.(made)
          return made
        }
      },
      list: async (params: any) => {
        this.calls.push({ method: "list", params })
        if (this.failList) throw apiError(500, "internal")
        const [key, value] = Object.entries(params.tags ?? {})[0] ?? []
        const all = [...this.boxes.values()]
          .filter((box) => box.name.startsWith(params.namePrefix ?? ""))
          .filter((box) => key === undefined || box.tags?.[key] === value)
          .sort((a, b) => a.name.localeCompare(b.name))
        const start = Number(params.cursor ?? 0)
        const page = all.slice(start, start + this.pageSize)
        const next = start + this.pageSize < all.length ? String(start + this.pageSize) : null
        return {
          sandboxes: page.map((box) => ({
            name: box.name,
            status: box.status,
            tags: box.tags,
            updatedAt: NOW,
            totalActiveCpuDurationMs: 1_000,
            totalDurationMs: 60_000,
            totalEgressBytes: 2_048,
          })),
          pagination: { count: page.length, next },
        }
      },
    } as unknown as VercelSandboxSdk
  }

  private instance(box: Box) {
    const calls = this.calls
    const boxes = this.boxes
    return {
      get name() {
        return box.name
      },
      get status() {
        return box.status
      },
      get tags() {
        return box.tags
      },
      get expiresAt() {
        return box.settings.timeout ? new Date(NOW + box.settings.timeout) : undefined
      },
      domain(port: number) {
        const ports: number[] = box.settings.ports ?? []
        if (!ports.includes(port)) throw new Error(`No route for port ${port}`)
        return `https://${box.name}-${port}.sandbox.invalid`
      },
      async stop() {
        calls.push({ method: "stop", name: box.name, params: {} })
        if (box.status === "stopping") throw apiError(422, "sandbox_stopping")
        box.status = "stopped"
        return {}
      },
      async update(params: any) {
        calls.push({ method: "update", name: box.name, params })
        Object.assign(box.settings, params)
        if (params.tags) box.tags = params.tags
      },
      async delete(params: any) {
        calls.push({ method: "delete", name: box.name, params: params ?? {} })
        boxes.delete(box.name)
      },
    }
  }

  methods(name?: string) {
    return this.calls.filter((call) => name === undefined || call.name === name).map((call) => call.method)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

function setup(now = NOW) {
  const fakes = codiumFakes({ now })
  const sandboxes = new FakeSandboxes()
  const waits: number[] = []
  const provider = vercelProvider({
    mode: "test",
    sdk: sandboxes.sdk(),
    clock: () => fakes.clock.now,
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  const options = { provider, fetcher: fakes.fetcher, clock: () => fakes.clock.now }
  return { fakes, sandboxes, provider, options, waits }
}

/** A session's running block, as WP A51's OPEN stores it in `hosted:running:<account>`. */
function seedBlock(
  fakes: CodiumFakes,
  session: string,
  timing: { startedAt?: number; expiresAt?: number } = {},
  account = ACCOUNT,
) {
  const startedAt = timing.startedAt ?? fakes.clock.now - 5 * MINUTE
  fakes.store.hash(hostedRunningKey(account)).set(
    session,
    JSON.stringify({
      v: 1,
      session,
      block: 0,
      ref: `hb-${session}-0`,
      size: "standard",
      startedAt,
      minutes: 15,
      weight: 1,
      epoch: `sub_fixture:${NOW - DAY}`,
      periodEnd: NOW + 20 * DAY,
      pool: "hash_fixture",
      ticket: "ticket_fixture",
      micro: 125_000,
      expiresAt: timing.expiresAt ?? startedAt + 30 * MINUTE,
    }),
  )
}

function start(
  world: ReturnType<typeof setup>,
  input: Partial<Parameters<typeof startHostedComputer>[1]> = {},
  account = ACCOUNT,
) {
  return startHostedComputer(
    account,
    {
      computer: 1,
      session: "sess_one",
      size: "standard",
      deadline: world.fakes.clock.now + 2 * HOUR,
      runToken: TOKEN,
      diskDays: 7,
      ...input,
    },
    world.options,
  )
}

function config(overrides: Partial<Parameters<typeof computerConfig>[0]> = {}): ComputerConfig {
  return computerConfig({
    name: computerName(ACCOUNT, 1),
    size: "standard",
    deadline: NOW + HOUR,
    runToken: TOKEN,
    diskDays: 7,
    runHost: Hosted.RUN_API_HOST,
    mode: "test",
    now: NOW,
    ...overrides,
  })
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { statusCode?: number; code?: string }
  }
  throw new Error("Expected a refusal")
}

/** Whether `address` lies inside `cidr` (IPv4 or IPv6). */
function inSubnet(address: string, cidr: string) {
  const [base, bits] = cidr.split("/") as [string, string]
  const a = addressBits(address)
  const b = addressBits(base)
  if (!a || !b || a.length !== b.length) return false
  return a.slice(0, Number(bits)) === b.slice(0, Number(bits))
}

function addressBits(address: string): string | undefined {
  if (isIP(address) === 4)
    return address
      .split(".")
      .map((part) => Number(part).toString(2).padStart(8, "0"))
      .join("")
  if (isIP(address) !== 6) return undefined
  let text = address
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (dotted) {
    const [p, q, r, s] = dotted.split(".").map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted.length)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`
  }
  const [head, tail] = text.split("::") as [string, string | undefined]
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
  return words.map((word) => parseInt(word, 16).toString(2).padStart(16, "0")).join("")
}

// ── Names ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("computer names", () => {
  test("are vh-<HMAC(account)[0:16]>-<n>, numbered up to the most computers any plan runs", () => {
    expect(MAX_COMPUTERS).toBe(3)
    const name = computerName(ACCOUNT, 1)
    expect(name).toBe(`vh-${hostedAccount(ACCOUNT).slice(0, 16)}-1`)
    expect(name).toMatch(/^vh-[0-9a-f]{16}-1$/)
    expect(name).not.toContain(ACCOUNT)
    expect(name.startsWith(accountComputerPrefix(ACCOUNT))).toBe(true)
    expect(computerName(ACCOUNT, 3)).toBe(`${accountComputerPrefix(ACCOUNT)}3`)
    expect(computerName(OTHER, 1)).not.toBe(name)
    for (const bad of [0, 4, 1.5, -1, Number.NaN]) expect(() => computerName(ACCOUNT, bad)).toThrow()
    expect(isComputerName(name)).toBe(true)
    for (const bad of ["vh-0123456789abcdef-4", "vh-0123456789ABCDEF-1", "vh-0123-1", "bake-1", `${name}0`])
      expect(isComputerName(bad)).toBe(false)
  })

  test("need the account salt, so no computer is named without the hosted ledger's HMAC", () => {
    restore()
    restore = codiumTestEnvironment({ ...HOSTED_ENV, VECTOR_HOSTED_ACCOUNT_SALT: undefined })
    expect(() => computerName(ACCOUNT, 1)).toThrow()
    expect(hostedProviderProblems()).toContain("VECTOR_HOSTED_ACCOUNT_SALT is not set")
  })
})

// ── What a computer gets ───────────────────────────────────────────────────────────────────────────────────────────

describe("the computer's configuration", () => {
  test("the deny list holds every block the contract names, plus private, link-local and metadata", () => {
    for (const cidr of CONTRACT_DENIED) expect(HOSTED_DENIED_SUBNETS).toContain(cidr)
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"])
      expect(HOSTED_DENIED_SUBNETS).toContain(cidr)
    expect(new Set(HOSTED_DENIED_SUBNETS).size).toBe(HOSTED_DENIED_SUBNETS.length)
    // Metadata, private and loopback addresses, in every form that reaches them.
    for (const address of [
      "169.254.169.254",
      "fd00:ec2::254",
      "::ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe",
      "192.0.0.192",
      "10.1.2.3",
      "172.31.255.255",
      "192.168.0.1",
      "127.0.0.1",
      "::1",
      "fe80::1",
      "ff02::1",
      "224.0.0.251",
      "255.255.255.255",
      "2002:a9fe:a9fe::1",
    ])
      expect(HOSTED_DENIED_SUBNETS.some((cidr) => inSubnet(address, cidr))).toBe(true)
    // The public internet stays reachable.
    for (const address of ["1.1.1.1", "140.82.112.3", "2606:4700:4700::1111"])
      expect(HOSTED_DENIED_SUBNETS.some((cidr) => inSubnet(address, cidr))).toBe(false)
  })

  test("every denied block is a valid network that the server's own outbound rules (S8) also refuse", () => {
    for (const cidr of HOSTED_DENIED_SUBNETS) {
      const [base, bits] = cidr.split("/") as [string, string]
      const full = addressBits(base)!
      expect(full).toBeDefined()
      expect(Number(bits)).toBeLessThanOrEqual(full.length)
      expect(full.slice(Number(bits))).toMatch(/^0*$/)
      expect(blockedAddress(base)).toBe(true)
    }
  })

  test("sizes are 2 or 4 vCPUs with the memory the rates price, the timeout is the deadline plus 5 minutes", () => {
    expect(config().vcpus).toBe(2)
    expect(config({ size: "large" }).vcpus).toBe(4)
    for (const size of Hosted.SIZES) {
      const { vcpus, memoryGb } = config({ size })
      // Vercel gives 2048 MB per vCPU; the rates charge for exactly that memory.
      expect(memoryGb * 1024).toBe(vcpus * 2048)
      expect({ vcpus, memoryGb }).toEqual(HOSTED_SIZES[size])
    }
    expect(TIMEOUT_GRACE_MS).toBe(5 * MINUTE)
    expect(config({ deadline: NOW + 4 * HOUR }).timeoutMs).toBe(4 * HOUR + 5 * MINUTE)
    expect(config().ports).toEqual([Hosted.VIEWER_PORT])
    expect(config().region).toBe("iad1")
    expect(config({ diskDays: 30 }).retentionMs).toBe(30 * DAY)
    expect(config().injection).toEqual({ host: Hosted.RUN_API_HOST, header: "authorization", value: `Bearer ${TOKEN}` })
  })

  test("refuses a past deadline, one past the provider's longest session, a bad token and a bad retention", () => {
    for (const bad of [
      { deadline: NOW },
      { deadline: NOW - MINUTE },
      { deadline: NOW + MAX_TIMEOUT_MS - TIMEOUT_GRACE_MS + 1 },
      { runToken: "vrt_not-a-hosted-token-0123456789" },
      { runToken: "vht_short" },
      { runToken: `vht_${"a".repeat(20)} spaced` },
      { diskDays: 0 },
      { diskDays: 91 },
      { diskDays: 1.5 },
      { runHost: "not a host" },
      { name: "vh-0123456789abcdef-9" },
    ])
      expect(() => config(bad)).toThrow()
    expect(config({ deadline: NOW + MAX_TIMEOUT_MS - TIMEOUT_GRACE_MS }).timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  test("the run-API host is fixed in production and may move only outside it, never onto Vector's own sites", () => {
    expect(hostedRunHost({})).toBe(Hosted.RUN_API_HOST)
    expect(hostedRunHost({ VECTOR_HOSTED_RUN_HOST: "hosted-run.preview.example" })).toBe("hosted-run.preview.example")
    expect(
      hostedRunHost({ VECTOR_HOSTED_RUN_HOST: "hosted-run.preview.example", VERCEL_ENV: "production" }),
    ).toBeUndefined()
    expect(hostedRunHost({ VECTOR_HOSTED_RUN_HOST: Hosted.RUN_API_HOST, VERCEL_ENV: "production" })).toBe(
      Hosted.RUN_API_HOST,
    )
    for (const site of ["vectordev.ai", "www.vectordev.ai", "remote.vectordev.ai", "localhost", "10.0.0.1", "*.x.io"])
      expect(hostedRunHost({ VECTOR_HOSTED_RUN_HOST: site })).toBeUndefined()
  })
})

// ── The Vercel adapter ─────────────────────────────────────────────────────────────────────────────────────────────

describe("the Vercel adapter", () => {
  test("create receives the deny list and the single injection, from the base snapshot, with nothing else", async () => {
    const world = setup()
    seedBlock(world.fakes, "sess_one")
    const started = await start(world, { size: "large", diskDays: 30 })
    const name = computerName(ACCOUNT, 1)
    expect(started).toEqual({
      name,
      created: true,
      viewerUrl: `https://${name}-${Hosted.VIEWER_PORT}.sandbox.invalid`,
      expiresAt: NOW + 2 * HOUR + 5 * MINUTE,
      runHost: Hosted.RUN_API_HOST,
    })
    const create = world.sandboxes.calls.find((call) => call.method === "create")!.params
    // Always the hosted team's own credentials, never the deployment's.
    expect(create).toMatchObject(CREDENTIALS)
    expect(create).toMatchObject({
      name,
      source: { type: "snapshot", snapshotId: BASE },
      persistent: true,
      resources: { vcpus: 4 },
      timeout: 2 * HOUR + 5 * MINUTE,
      ports: [Hosted.VIEWER_PORT],
      region: "iad1",
      tags: { [MODE_TAG]: "test", [SIZE_TAG]: "large" },
      snapshotExpiration: 30 * DAY,
      keepLastSnapshots: { count: 1, expiration: 30 * DAY, deleteEvicted: true },
    })
    expect(create.networkPolicy).toEqual({
      allow: {
        [Hosted.RUN_API_HOST]: [{ transform: [{ headers: { authorization: `Bearer ${TOKEN}` } }] }],
        "*": [],
      },
      subnets: { deny: [...HOSTED_DENIED_SUBNETS] },
    })
    // The token is injected once, by the egress proxy: no environment, no image, no other field carries it.
    expect(create.env).toBeUndefined()
    expect(create.image).toBeUndefined()
    expect(create.runtime).toBeUndefined()
    expect(create.failoverRegions).toBeUndefined()
    expect(JSON.stringify(create).split(TOKEN).length - 1).toBe(1)
    expect(world.sandboxes.methods()).toEqual(["get", "create"])
  })

  test("a stopped computer is resumed from its disk with the session's settings applied first", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "stopped")
    seedBlock(world.fakes, "sess_one")
    const started = await start(world)
    expect(started.created).toBe(false)
    expect(world.sandboxes.methods(name)).toEqual(["get", "update", "resume"])
    const update = world.sandboxes.calls.find((call) => call.method === "update")!.params
    expect(update).toMatchObject({
      persistent: true,
      resources: { vcpus: 2 },
      timeout: 2 * HOUR + 5 * MINUTE,
      ports: [Hosted.VIEWER_PORT],
      region: "iad1",
      failoverRegions: [],
      snapshotExpiration: 7 * DAY,
      keepLastSnapshots: { count: 1, expiration: 7 * DAY, deleteEvicted: true },
      tags: { [MODE_TAG]: "test", [SIZE_TAG]: "standard" },
    })
    expect(update.networkPolicy.subnets.deny).toEqual([...HOSTED_DENIED_SUBNETS])
    expect(Object.keys(update.networkPolicy.allow)).toEqual([Hosted.RUN_API_HOST, "*"])
    for (const call of world.sandboxes.calls.filter((call) => call.method !== "create"))
      expect(call.params).not.toHaveProperty("env")
  })

  test("a running computer is stopped first, so every session boots clean", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "running")
    seedBlock(world.fakes, "sess_one")
    await start(world)
    expect(world.sandboxes.methods(name)).toEqual(["get", "stop", "update", "resume"])
  })

  test("a computer still saving its disk is resumed once it is done, within a few tries", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "running")
    world.sandboxes.boxes.get(name)!.saving = 2
    seedBlock(world.fakes, "sess_one")
    expect((await start(world)).created).toBe(false)
    expect(world.waits).toEqual([2_000, 2_000])
    expect(world.sandboxes.methods(name)).toEqual(["get", "stop", "update", "resume", "resume", "resume"])
    const stuck = setup()
    stuck.sandboxes.add(name, "stopped")
    stuck.sandboxes.boxes.get(name)!.saving = 10
    seedBlock(stuck.fakes, "sess_one")
    expect(await refusal(start(stuck))).toMatchObject({ statusCode: 503, code: "HOSTED_UNAVAILABLE" })
    expect(stuck.waits).toEqual([2_000, 2_000, 2_000])
  })

  test("a computer whose saved disk expired is made again from the base snapshot", async () => {
    for (const diskGone of ["resume", "always"] as const) {
      const world = setup()
      const name = computerName(ACCOUNT, 1)
      world.sandboxes.add(name, "stopped")
      world.sandboxes.boxes.get(name)!.diskGone = diskGone
      seedBlock(world.fakes, "sess_one")
      const started = await start(world)
      expect(started.created).toBe(true)
      const create = world.sandboxes.calls.find((call) => call.method === "create")!.params
      expect(create).toMatchObject({ ...CREDENTIALS, source: { type: "snapshot", snapshotId: BASE } })
      expect(world.sandboxes.boxes.get(name)!.status).toBe("running")
    }
  })

  test("a computer of the same name in the other mode, or untagged, is never resumed, changed or stopped", async () => {
    for (const tags of [{ [MODE_TAG]: "live" }, null]) {
      const world = setup()
      const name = computerName(ACCOUNT, 1)
      world.sandboxes.add(name, "running", tags)
      seedBlock(world.fakes, "sess_one")
      expect(await refusal(start(world))).toMatchObject({ statusCode: 503, code: "HOSTED_UNAVAILABLE" })
      expect(await world.provider.stop(name)).toBe("missing")
      expect(await world.provider.destroy(name)).toBe("missing")
      expect(world.sandboxes.methods(name).filter((method) => method !== "get")).toEqual([])
      expect(world.sandboxes.boxes.get(name)!.status).toBe("running")
    }
  })

  test("stop and destroy are idempotent and save the disk on stop", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "running")
    expect(await world.provider.stop(name)).toBe("stopped")
    expect(await world.provider.stop(name)).toBe("not-running")
    world.sandboxes.boxes.get(name)!.status = "snapshotting"
    expect(await world.provider.stop(name)).toBe("stopping")
    expect(await world.provider.stop(computerName(ACCOUNT, 2))).toBe("missing")
    world.sandboxes.boxes.get(name)!.status = "running"
    expect(await world.provider.destroy(name)).toBe("deleted")
    expect(world.sandboxes.calls.filter((call) => call.method === "delete")).toEqual([
      { method: "delete", name, params: expect.objectContaining({ deleteOrphanSnapshots: true }) },
    ])
    expect(world.sandboxes.boxes.has(name)).toBe(false)
    expect(await world.provider.destroy(name)).toBe("missing")
  })

  test("a new run token replaces the injected one and keeps the deny list", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "running")
    const next = "vht_fixture-next-run-token-abcdefghijklmnop"
    await setHostedRunToken(ACCOUNT, { computer: 1, runToken: next }, world.options)
    const update = world.sandboxes.calls.find((call) => call.method === "update")!.params
    expect(update).toEqual({
      networkPolicy: {
        allow: { [Hosted.RUN_API_HOST]: [{ transform: [{ headers: { authorization: `Bearer ${next}` } }] }], "*": [] },
        subnets: { deny: [...HOSTED_DENIED_SUBNETS] },
      },
    })
    expect(
      await refusal(setHostedRunToken(ACCOUNT, { computer: 1, runToken: "not-a-token" }, world.options)),
    ).toMatchObject({ code: "HOSTED_REQUEST" })
  })

  test("lists only this mode's computers, follows every page and reports usage", async () => {
    const world = setup()
    world.sandboxes.pageSize = 2
    const mine = [1, 2, 3].map((n) => computerName(ACCOUNT, n))
    for (const name of mine) world.sandboxes.add(name, "running", { [MODE_TAG]: "test", [SIZE_TAG]: "standard" })
    world.sandboxes.add(computerName(OTHER, 1), "running", { [MODE_TAG]: "live" })
    world.sandboxes.add("vh-bake-snapshot", "running", null)
    world.sandboxes.add("bake-image", "running", { [MODE_TAG]: "test" })
    const listed = await world.provider.list(COMPUTER_PREFIX)
    expect(listed.map((computer) => computer.name)).toEqual([...mine].sort())
    expect(listed[0]).toEqual({
      name: [...mine].sort()[0]!,
      status: "running",
      size: "standard",
      activeCpuMs: 1_000,
      durationMs: 60_000,
      egressBytes: 2_048,
      updatedAt: NOW,
    })
    const lists = world.sandboxes.calls.filter((call) => call.method === "list")
    expect(lists).toHaveLength(2)
    for (const call of lists)
      expect(call.params).toMatchObject({ ...CREDENTIALS, namePrefix: COMPUTER_PREFIX, tags: { [MODE_TAG]: "test" } })
    expect(await world.provider.list(accountComputerPrefix(OTHER))).toEqual([])
  })

  test("is configured only with every setting, on the team the spend guard watches and never the main team", () => {
    expect(vercelProviderProblems()).toEqual([])
    expect(hostedProviderConfigured({ ...process.env, VECTOR_HOSTED_PROVIDER: "vercel" })).toBe(true)
    const cases: [Record<string, string | undefined>, string][] = [
      [{ VECTOR_HOSTED_VERCEL_TOKEN: undefined }, "VECTOR_HOSTED_VERCEL_TOKEN"],
      [{ VECTOR_HOSTED_VERCEL_PROJECT_ID: "" }, "VECTOR_HOSTED_VERCEL_PROJECT_ID"],
      [{ VECTOR_HOSTED_BASE_SNAPSHOT: undefined }, "VECTOR_HOSTED_BASE_SNAPSHOT"],
      [{ VERCEL_HOSTED_TEAM_ID: "team_other" }, "VERCEL_HOSTED_TEAM_ID"],
      [{ VERCEL_HOSTED_TEAM_ID: undefined }, "VERCEL_HOSTED_TEAM_ID"],
      [{ VERCEL_SPEND_WEBHOOK_SECRET_HOSTED: undefined }, "VERCEL_SPEND_WEBHOOK_SECRET_HOSTED"],
      [{ VERCEL_MAIN_TEAM_ID: CREDENTIALS.teamId }, "VERCEL_MAIN_TEAM_ID"],
    ]
    for (const [change, name] of cases) {
      const env = { ...process.env, VECTOR_HOSTED_PROVIDER: "vercel", ...change }
      const problems = vercelProviderProblems(env)
      expect(problems.some((problem) => problem.includes(name))).toBe(true)
      expect(problems.join(" ")).not.toContain(CREDENTIALS.token)
      expect(vercelProvider({ env, mode: "test", sdk: new FakeSandboxes().sdk() }).configured()).toBe(false)
      expect(hostedProviderConfigured(env)).toBe(false)
    }
  })

  test("an unconfigured adapter refuses every call before reaching the SDK", async () => {
    const sandboxes = new FakeSandboxes()
    const provider = vercelProvider({
      env: { ...process.env, VECTOR_HOSTED_VERCEL_TOKEN: undefined },
      mode: "test",
      sdk: sandboxes.sdk(),
    })
    for (const call of [
      () => provider.start(config()),
      () => provider.stop(computerName(ACCOUNT, 1)),
      () => provider.destroy(computerName(ACCOUNT, 1)),
      () => provider.list(COMPUTER_PREFIX),
      () => provider.setRunToken(config()),
    ])
      expect(await refusal(call())).toMatchObject({ statusCode: 503, code: "HOSTED_UNAVAILABLE" })
    expect(sandboxes.calls).toEqual([])
  })

  test("reads the SDK's own errors: missing, expired disk, already stopping, already stopped", () => {
    expect(sandboxError(apiError(404, "not_found"))).toBe("not-found")
    expect(sandboxError(apiError(410, "snapshot_not_found"))).toBe("disk-missing")
    expect(sandboxError(apiError(410, "sandbox_stopped"))).toBe("stopped")
    expect(sandboxError(apiError(422, "sandbox_stopping"))).toBe("stopping")
    expect(sandboxError(apiError(422, "sandbox_snapshotting"))).toBe("stopping")
    expect(sandboxError(apiError(500, "internal"))).toBe("other")
    expect(sandboxError(new Error("network"))).toBe("other")
    expect(sandboxError(undefined)).toBe("other")
  })

  test("loads the SDK only when a call needs it, and pins it to an exact version", async () => {
    const root = path.join(import.meta.dir, "..")
    const source = await Bun.file(path.join(root, "api/_lib/hosted-provider-vercel.ts")).text()
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source)
    expect(imports.filter((item) => item.path === "@vercel/sandbox")).toEqual([
      expect.objectContaining({ kind: "dynamic-import" }),
    ])
    const manifest = await Bun.file(path.join(root, "package.json")).json()
    expect(manifest.dependencies["@vercel/sandbox"]).toMatch(/^\d+\.\d+\.\d+$/)
    const lock = await Bun.file(path.join(root, "bun.lock")).text()
    expect(lock).toContain(`"@vercel/sandbox@${manifest.dependencies["@vercel/sandbox"]}"`)
  })
})

// ── Starting a computer ────────────────────────────────────────────────────────────────────────────────────────────

describe("startHostedComputer", () => {
  test("starts nothing for a session that holds no block of time (M8)", async () => {
    const world = setup()
    expect(await refusal(start(world))).toMatchObject({ statusCode: 409, code: "HOSTED_SESSION_MOVED" })
    // A block past its stopBy, or whose hold lapsed, holds nothing either.
    seedBlock(world.fakes, "sess_one", { startedAt: NOW - HOLD_MINUTES * MINUTE })
    expect(await refusal(start(world))).toMatchObject({ code: "HOSTED_SESSION_MOVED" })
    seedBlock(world.fakes, "sess_one", { startedAt: NOW - MINUTE, expiresAt: NOW })
    expect(await refusal(start(world))).toMatchObject({ code: "HOSTED_SESSION_MOVED" })
    // Another session's block does not count.
    seedBlock(world.fakes, "sess_two")
    expect(await refusal(start(world))).toMatchObject({ code: "HOSTED_SESSION_MOVED" })
    expect(world.sandboxes.calls).toEqual([])
    expect(world.fakes.store.get(hostedComputerKey(computerName(ACCOUNT, 1)))).toBeUndefined()
  })

  test("records which session the computer runs for before asking the provider", async () => {
    const world = setup()
    seedBlock(world.fakes, "sess_one")
    const name = computerName(ACCOUNT, 1)
    let recorded: string | undefined
    const provider: HostedProvider = {
      ...world.provider,
      start: async (input) => {
        recorded = world.fakes.store.get(hostedComputerKey(name))
        return world.provider.start(input)
      },
    }
    await startHostedComputer(
      ACCOUNT,
      { computer: 1, session: "sess_one", size: "standard", deadline: NOW + HOUR, runToken: TOKEN, diskDays: 7 },
      { ...world.options, provider },
    )
    expect(JSON.parse(recorded!)).toEqual({ v: 1, account: ACCOUNT, computer: 1, session: "sess_one", startedAt: NOW })
    // Kept past the provider's own timeout (deadline + 5 minutes).
    expect(world.fakes.store.pttl(hostedComputerKey(name))).toBeGreaterThan(HOUR + 5 * MINUTE)
  })

  test("starts nothing when the store cannot record the session", async () => {
    const world = setup()
    seedBlock(world.fakes, "sess_one")
    const provider: HostedProvider = {
      ...world.provider,
      start: async () => {
        throw new Error("must not be called")
      },
    }
    // The block is read, then the write of the session record fails.
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((JSON.parse(String(init?.body ?? "[]")) as string[])[0] === "SET")
        return new Response("unavailable", { status: 503 })
      return world.fakes.fetcher(input, init)
    }) as typeof fetch
    const input = { computer: 1, session: "sess_one", size: "standard" as const, deadline: NOW + HOUR, runToken: TOKEN }
    expect(
      await refusal(startHostedComputer(ACCOUNT, { ...input, diskDays: 7 }, { ...world.options, fetcher, provider })),
    ).toMatchObject({ statusCode: 503, code: "PERSISTENT_STORE_UNAVAILABLE" })
    expect(world.fakes.store.commands.map((command) => command[0])).toEqual(["HGETALL"])
  })

  test("stays behind VECTOR_HOSTED_PROVIDER: unset, or a provider whose settings are incomplete, starts nothing", async () => {
    for (const change of [{ VECTOR_HOSTED_PROVIDER: undefined }, { VECTOR_HOSTED_PROVIDER: "other" }]) {
      restore()
      restore = codiumTestEnvironment({ ...HOSTED_ENV, ...change })
      const world = setup()
      seedBlock(world.fakes, "sess_one")
      expect(hostedProvider()).toBeUndefined()
      expect(hostedProviderConfigured()).toBe(false)
      expect(hostedProviderProblems()).toContain("VECTOR_HOSTED_PROVIDER is not set to a provider")
      expect(
        await refusal(
          startHostedComputer(
            ACCOUNT,
            { computer: 1, session: "sess_one", size: "standard", deadline: NOW + HOUR, runToken: TOKEN, diskDays: 7 },
            { fetcher: world.fakes.fetcher, clock: () => NOW },
          ),
        ),
      ).toMatchObject({ statusCode: 503, code: "HOSTED_UNAVAILABLE" })
    }
    expect(hostedProvider({ VECTOR_HOSTED_PROVIDER: "vercel" })?.id).toBe("vercel")
  })

  test("stop goes to the named computer of that account only", async () => {
    const world = setup()
    world.sandboxes.add(computerName(ACCOUNT, 2), "running")
    world.sandboxes.add(computerName(OTHER, 2), "running")
    expect(await stopHostedComputer(ACCOUNT, 2, world.options)).toBe("stopped")
    expect(world.sandboxes.boxes.get(computerName(OTHER, 2))!.status).toBe("running")
    expect(await refusal(stopHostedComputer(ACCOUNT, 4, world.options))).toMatchObject({ code: "HOSTED_REQUEST" })
  })
})

// ── The reconciler ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the reconciler", () => {
  async function running(world: ReturnType<typeof setup>, account: string, computer: number, session?: string) {
    const name = computerName(account, computer)
    world.sandboxes.add(name, "running")
    if (session)
      world.fakes.store.set(
        hostedComputerKey(name),
        JSON.stringify({ v: 1, account, computer, session, startedAt: world.fakes.clock.now - MINUTE }),
      )
    return name
  }

  test("stops every running computer without a live session and leaves live ones running (M9)", async () => {
    const world = setup()
    const live = await running(world, ACCOUNT, 1, "sess_live")
    seedBlock(world.fakes, "sess_live")
    const orphan = await running(world, ACCOUNT, 2)
    const ended = await running(world, ACCOUNT, 3, "sess_ended")
    const lapsed = await running(world, OTHER, 1, "sess_lapsed")
    seedBlock(world.fakes, "sess_lapsed", { startedAt: NOW - 10 * MINUTE, expiresAt: NOW - 1 }, OTHER)
    const overdue = await running(world, OTHER, 2, "sess_overdue")
    seedBlock(
      world.fakes,
      "sess_overdue",
      { startedAt: NOW - HOLD_MINUTES * MINUTE - RECONCILE_SLACK_MS, expiresAt: NOW + HOUR },
      OTHER,
    )
    const stopped = computerName(OTHER, 3)
    world.sandboxes.add(stopped, "stopped")
    const result = await reconcileHostedComputers(world.options)
    expect(result).toEqual({
      ran: true,
      checked: 5,
      live: 1,
      stopped: [orphan, ended, lapsed, overdue].sort(),
      unknown: 0,
      failed: [],
    })
    expect(world.sandboxes.boxes.get(live)!.status).toBe("running")
    for (const name of [orphan, ended, lapsed, overdue]) expect(world.sandboxes.boxes.get(name)!.status).toBe("stopped")
    expect(world.sandboxes.methods(stopped)).toEqual([])
  })

  test("a session record that names another computer does not keep this one running", async () => {
    const world = setup()
    const name = computerName(ACCOUNT, 1)
    world.sandboxes.add(name, "running")
    world.fakes.store.set(
      hostedComputerKey(name),
      JSON.stringify({ v: 1, account: OTHER, computer: 1, session: "sess_x", startedAt: NOW }),
    )
    seedBlock(world.fakes, "sess_x", {}, OTHER)
    world.fakes.store.set(hostedComputerKey(computerName(ACCOUNT, 2)), "not json")
    world.sandboxes.add(computerName(ACCOUNT, 2), "pending")
    const result = await reconcileHostedComputers(world.options)
    expect(result.stopped).toEqual([name, computerName(ACCOUNT, 2)].sort())
  })

  test("with the hosted switch at stop, every running computer stops", async () => {
    const world = setup()
    const name = await running(world, ACCOUNT, 1, "sess_live")
    seedBlock(world.fakes, "sess_live")
    world.fakes.store.set(switchKey("hosted"), JSON.stringify({ value: "stop", changedAt: NOW, generation: "g1" }))
    const result = await reconcileHostedComputers(world.options)
    expect(result).toMatchObject({ ran: true, live: 0, stopped: [name] })
  })

  test("never stops a computer it cannot judge: a store outage leaves everything running", async () => {
    const world = setup()
    await running(world, ACCOUNT, 1)
    world.fakes.store.down = true
    expect(await reconcileHostedComputers(world.options)).toMatchObject({ ran: false, reason: "store-unavailable" })
    world.fakes.store.down = false
    // The store fails after the pass began: each computer is left for the next pass.
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body ?? "[]")) as string[]
      if (command[0] === "GET" && String(command[1]).includes(":hosted:computer:"))
        return new Response("unavailable", { status: 503 })
      return world.fakes.fetcher(input, init)
    }) as typeof fetch
    const result = await reconcileHostedComputers({ ...world.options, fetcher, force: true })
    expect(result).toMatchObject({ ran: true, checked: 1, unknown: 1, stopped: [] })
    expect(world.sandboxes.boxes.get(computerName(ACCOUNT, 1))!.status).toBe("running")
  })

  test("acts at most every few minutes, however often the reaper calls it", async () => {
    const world = setup()
    await running(world, ACCOUNT, 1)
    expect((await reconcileHostedComputers(world.options)).stopped).toHaveLength(1)
    await running(world, ACCOUNT, 2)
    world.fakes.clock.advance(MINUTE)
    expect(await reconcileHostedComputers(world.options)).toMatchObject({ ran: false, reason: "recent" })
    world.fakes.clock.advance(RECONCILE_EVERY_MS)
    expect((await reconcileHostedComputers(world.options)).stopped).toEqual([computerName(ACCOUNT, 2)])
  })

  test("reports a provider it cannot list, and a computer it cannot stop", async () => {
    const world = setup()
    await running(world, ACCOUNT, 1)
    world.sandboxes.failList = true
    expect(await reconcileHostedComputers(world.options)).toMatchObject({ ran: false, reason: "provider-unavailable" })
    world.sandboxes.failList = false
    const provider: HostedProvider = {
      ...world.provider,
      stop: async () => {
        throw new Error("provider down")
      },
    }
    const result = await reconcileHostedComputers({ ...world.options, provider, force: true })
    expect(result).toMatchObject({ ran: true, stopped: [], failed: [computerName(ACCOUNT, 1)] })
  })

  test("emails the owner once, naming computers and never an account", async () => {
    restore()
    restore = codiumTestEnvironment({
      ...HOSTED_ENV,
      RESEND_API_KEY: "fixture-resend-key",
      VECTOR_PURCHASE_EMAIL_FROM: "codium@vectordev.test",
      CODIUM_OWNER_EMAIL: "owner@vectordev.test",
    })
    const world = setup()
    const name = await running(world, ACCOUNT, 1)
    await reconcileHostedComputers(world.options)
    await running(world, ACCOUNT, 2)
    await reconcileHostedComputers({ ...world.options, force: true })
    expect(world.fakes.mail.sent).toHaveLength(1)
    const email = world.fakes.mail.sent[0]!
    expect(email.text).toContain(name)
    expect(email.text).not.toContain(ACCOUNT)
    expect(email.subject).not.toContain(ACCOUNT)
  })

  test("does nothing, and asks nothing, while no provider is configured", async () => {
    restore()
    restore = codiumTestEnvironment({ ...HOSTED_ENV, VECTOR_HOSTED_PROVIDER: undefined })
    const fakes = codiumFakes({ now: NOW })
    expect(await reconcileHostedComputers({ fetcher: fakes.fetcher, clock: () => NOW })).toMatchObject({
      ran: false,
      reason: "not-configured",
    })
    expect(fakes.store.commands).toEqual([])
  })
})

// ── Erasing an account's computers ────────────────────────────────────────────────────────────────────────────────

describe("eraseAccountComputers", () => {
  test("deletes the account's computers, their disks and their session records, and nothing else", async () => {
    const world = setup()
    for (const n of [1, 3]) {
      world.sandboxes.add(computerName(ACCOUNT, n), n === 1 ? "running" : "stopped")
      world.fakes.store.set(hostedComputerKey(computerName(ACCOUNT, n)), "{}")
    }
    world.sandboxes.add(computerName(OTHER, 1), "running")
    world.fakes.store.set(hostedComputerKey(computerName(OTHER, 1)), "{}")
    const deleted = await eraseAccountComputers(ACCOUNT, world.options)
    expect(deleted.sort()).toEqual([computerName(ACCOUNT, 1), computerName(ACCOUNT, 3)].sort())
    expect([...world.sandboxes.boxes.keys()]).toEqual([computerName(OTHER, 1)])
    for (const n of [1, 3]) expect(world.fakes.store.get(hostedComputerKey(computerName(ACCOUNT, n)))).toBeUndefined()
    expect(world.fakes.store.get(hostedComputerKey(computerName(OTHER, 1)))).toBe("{}")
  })

  test("with no provider named, only the records go; with a provider that lost its settings, it throws to retry", async () => {
    const world = setup()
    world.fakes.store.set(hostedComputerKey(computerName(ACCOUNT, 1)), "{}")
    expect(await eraseAccountComputers(ACCOUNT, { ...world.options, provider: undefined })).toEqual([])
    expect(world.fakes.store.get(hostedComputerKey(computerName(ACCOUNT, 1)))).toBeUndefined()
    const broken = vercelProvider({
      env: { ...process.env, VECTOR_HOSTED_BASE_SNAPSHOT: undefined },
      mode: "test",
      sdk: world.sandboxes.sdk(),
    })
    expect(await refusal(eraseAccountComputers(ACCOUNT, { ...world.options, provider: broken }))).toMatchObject({
      code: "HOSTED_UNAVAILABLE",
    })
  })
})

// ── The provider contract ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * What every provider must do, run against each one. A provider that is not built yet (the Cloudflare stub) must refuse
 * everything without a request; once it is built, its harness joins `harnesses` and the whole suite runs against it.
 */
type Harness = {
  provider: () => { provider: HostedProvider; created: (name: string) => ComputerConfig | undefined }
}
const harnesses: Record<string, Harness | undefined> = {
  vercel: {
    provider: () => {
      const sandboxes = new FakeSandboxes()
      const provider = vercelProvider({ mode: "test", sdk: sandboxes.sdk(), clock: () => NOW })
      const created = (name: string) => {
        const params = sandboxes.calls.find((call) => call.method === "create" && call.name === name)?.params
        if (!params) return undefined
        const [host, rules] = Object.entries(params.networkPolicy.allow).find(([key]) => key !== "*") as [string, any]
        const [header, value] = Object.entries(rules[0].transform[0].headers)[0] as [string, string]
        return {
          name: params.name,
          mode: params.tags[MODE_TAG],
          size: params.tags[SIZE_TAG],
          vcpus: params.resources.vcpus,
          memoryGb: (params.resources.vcpus * 2048) / 1024,
          region: params.region,
          timeoutMs: params.timeout,
          ports: params.ports,
          deniedSubnets: params.networkPolicy.subnets.deny,
          injection: { host, header: header as "authorization", value },
          retentionMs: params.snapshotExpiration,
        }
      }
      return { provider, created }
    },
  },
  cloudflare: undefined,
}

for (const [id, harness] of Object.entries(harnesses)) {
  describe(`provider contract: ${id}`, () => {
    if (!harness) {
      test("is not built: never configured, and refuses every call without a request", async () => {
        const provider = id === "cloudflare" ? cloudflareProvider() : undefined
        expect(provider).toBeDefined()
        expect(provider!.configured()).toBe(false)
        expect(provider!.problems().length).toBeGreaterThan(0)
        for (const call of [
          () => provider!.start(config()),
          () => provider!.setRunToken(config()),
          () => provider!.stop(computerName(ACCOUNT, 1)),
          () => provider!.destroy(computerName(ACCOUNT, 1)),
          () => provider!.list(COMPUTER_PREFIX),
        ])
          expect(await refusal(call())).toMatchObject({ statusCode: 503, code: "HOSTED_UNAVAILABLE" })
        restore()
        restore = codiumTestEnvironment({ ...HOSTED_ENV, VECTOR_HOSTED_PROVIDER: id })
        expect(hostedProvider()?.id).toBe(id as "cloudflare")
        expect(hostedProviderConfigured()).toBe(false)
        const fakes = codiumFakes({ now: NOW })
        expect(await reconcileHostedComputers({ fetcher: fakes.fetcher, clock: () => NOW })).toMatchObject({
          reason: "not-configured",
        })
        expect(fakes.store.commands).toEqual([])
      })
      test.todo("the full contract suite, once the provider is built", () => {})
      return
    }

    test("start hands the provider exactly the computer's configuration", async () => {
      const { provider, created } = harness.provider()
      const wanted = config({ size: "large", diskDays: 30 })
      const started = await provider.start(wanted)
      expect(started).toMatchObject({ name: wanted.name, created: true })
      expect(created(wanted.name)).toEqual({
        ...wanted,
        ports: [...wanted.ports],
        deniedSubnets: [...wanted.deniedSubnets],
      })
    })

    test("start resumes the same computer on the next session, and stop is idempotent", async () => {
      const { provider } = harness.provider()
      await provider.start(config())
      expect(await provider.stop(config().name)).toBe("stopped")
      expect(await provider.stop(config().name)).toBe("not-running")
      expect((await provider.start(config())).created).toBe(false)
      expect((await provider.list(COMPUTER_PREFIX)).map((computer) => computer.name)).toEqual([config().name])
    })

    test("refuses a configuration for another mode", async () => {
      const { provider } = harness.provider()
      expect(await refusal(provider.start(config({ mode: "live" })))).toMatchObject({ code: "HOSTED_UNAVAILABLE" })
    })
  })
}
