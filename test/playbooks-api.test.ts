import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { handlePlaybooks } from "../api/account/playbooks"
import { mintCliToken } from "../api/_lib/cli-token"
import { codiumKey } from "../api/_lib/codium-keys"
import { listedPerks, perkServices } from "../api/_lib/codium-perks"
import { buildSnapshot, snapshotKey, type SnapshotFacts } from "../api/_lib/codium-snapshot"
import {
  decodePlaybookRecord,
  playbookObjectKey,
  playbooksKey,
  playbooksReady,
  publishPlan,
  readPlaybooks,
  type PlaybookRecord,
} from "../api/_lib/playbooks"
import { presignR2 } from "../api/_lib/r2-presign"
import type { PlanId } from "../packages/schema/src/codium-plan"
import { Playbooks } from "../packages/schema/src/playbooks"
import { parsePlaybooksArguments, runPlaybooksPublish } from "../script/playbooks-publish"
import { roadmapEnvironment, roadmapFakes, ROADMAP_KV_URL } from "./roadmap-fixture"
import { invoke, jsonHeaders } from "./support-reports-fixture"

// WP A36: the Playbooks server. Pro and up get `[{name, version, sha256, url}]` with 10-minute signed links to the media
// bucket (`playbooks/`); the owner's publish script checks every playbook against the skill command allowlist before
// anything is uploaded. The endpoint is dark (404 for everyone) until `playbooks` is listed, which Track B does. The
// store is the roadmap vote's fake (Upstash REST commands) and the bucket a fake R2 that keeps what is uploaded; no
// request leaves this process.

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 15, 12)
const R2_ACCOUNT = "0123456789abcdef0123456789abcdef"
const R2_ORIGIN = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`
const R2_SECRET = "fixtureR2SecretAccessKey0123456789abcdefXYZ"
const ENVIRONMENT = {
  MODEL_PLANS_ENABLED: "true",
  CODIUM_LISTED_PERKS: "playbooks",
  CODIUM_TRACK_B_LIVE: "true",
  VECTOR_R2_ACCOUNT_ID: R2_ACCOUNT,
  VECTOR_R2_MEDIA_ACCESS_KEY_ID: "fixtureaccesskey0001",
  VECTOR_R2_MEDIA_SECRET_ACCESS_KEY: R2_SECRET,
  VECTOR_R2_MEDIA_BUCKET: undefined,
}
const PRO = "2b3c4d5e-0000-4000-8000-000000000001"
const MAX = "2b3c4d5e-0000-4000-8000-000000000002"
const ULTRA = "2b3c4d5e-0000-4000-8000-000000000003"
const PLUS = "2b3c4d5e-0000-4000-8000-000000000004"

const spec = (title: string, prompt: string) =>
  JSON.stringify(
    { version: 1, title, stages: [{ id: "work", prompt, success_criteria: ["`bun test` passes."] }] },
    null,
    2,
  )
const FILES: Record<string, string> = {
  "playbooks/vector-flaky-tests.json": spec("Flaky test hunt", "Run `bun test` three times and read `package.json`."),
  "playbooks/vector-docs-drift.json": spec("Docs drift", "Compare `docs/` with `git diff src/index.ts`."),
  "playbooks/vector-deploy.json": spec("Deploy", "Then run `npm publish` and `git push`."),
}
const bytesOf = (file: string) => new TextEncoder().encode(FILES[file]!)
const sha = (file: string) => createHash("sha256").update(bytesOf(file)).digest("hex")

type Bucket = Map<string, { bytes: Uint8Array; type?: string }>

/** The store fake plus a fake R2 media bucket, behind one `fetch` (switch caches are kept per fetch). */
function world() {
  const kv = roadmapFakes()
  const bucket: Bucket = new Map()
  const r2: { method: string; key: string; signed: string; headers: Record<string, string> }[] = []
  const origins: string[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    origins.push(url.origin)
    if (url.origin !== R2_ORIGIN) return kv.fetcher(input, init)
    const method = init?.method ?? "GET"
    const key = decodeURIComponent(url.pathname.replace(/^\/vector-media\//, ""))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    r2.push({ method, key, signed: url.searchParams.get("X-Amz-SignedHeaders") ?? "", headers })
    if (!url.pathname.startsWith("/vector-media/") || !url.searchParams.get("X-Amz-Signature"))
      return new Response(null, { status: 403 })
    const stored = bucket.get(key)
    if (method === "HEAD")
      return stored
        ? new Response(null, {
            status: 200,
            headers: { etag: `"${createHash("md5").update(stored.bytes).digest("hex")}"` },
          })
        : new Response(null, { status: 404 })
    if (method === "PUT") {
      const body = init?.body as Uint8Array
      if (headers["content-length"] !== String(body.byteLength)) return new Response(null, { status: 403 })
      bucket.set(key, { bytes: new Uint8Array(body), type: headers["content-type"] })
      return new Response(null, { status: 200 })
    }
    if (method === "GET") return stored ? new Response(stored.bytes.slice()) : new Response(null, { status: 404 })
    return new Response(null, { status: 405 })
  }) as typeof fetch
  return { ...kv, bucket, r2, origins, fetcher }
}

let restore = () => {}
let w = world()
beforeEach(() => {
  restore = roadmapEnvironment(ENVIRONMENT)
  w = world()
})
afterEach(() => restore())

const token = (account: string) =>
  mintCliToken({ id: account, email: `${account}@example.invalid` }, Date.now(), "desktop").token

function seedPlan(account: string, plan: PlanId | null, state: SnapshotFacts["state"] = "active", now = NOW) {
  const reason =
    state === "paused"
      ? ("payment_failed" as const)
      : state === "frozen"
        ? ("disputed" as const)
        : state === "ended"
          ? ("canceled" as const)
          : undefined
  const snapshot = buildSnapshot(
    {
      account,
      state,
      ...(reason ? { reason } : {}),
      plan,
      ...(plan ? { subscription: `sub_${account.slice(-4)}` } : {}),
      periodStart: state === "renewing" ? now - 30 * DAY : now - DAY,
      periodEnd: state === "renewing" ? now - 60_000 : now + 29 * DAY,
      cancelAtPeriodEnd: false,
      source: "webhook",
    },
    undefined,
    now,
  )
  w.store.command(["SET", snapshotKey(account), JSON.stringify(snapshot)])
}

const run = (argv: string[], target = w) =>
  runPlaybooksPublish(parsePlaybooksArguments(argv), {
    fetcher: target.fetcher,
    now: NOW,
    env: {},
    read: async (file) => {
      if (!(file in FILES)) throw new Error(`no such file ${file}`)
      return bytesOf(file)
    },
  })

/** Publishes the two good playbooks to the test store, as the owner would. */
async function publishTwo(target = w) {
  await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"], target)
  await run(["publish", "playbooks/vector-docs-drift.json", "--version", "1.2.0", "--mode", "test"], target)
}

function playbooks(
  account: string | undefined,
  input: { method?: string; authorization?: string; fetcher?: typeof fetch; ip?: string } = {},
) {
  const authorization = input.authorization ?? (account ? `Bearer ${token(account)}` : undefined)
  return invoke((request, response) => handlePlaybooks(request, response, input.fetcher ?? w.fetcher, () => NOW), {
    method: input.method ?? "GET",
    headers: jsonHeaders(input.ip ?? "192.0.2.60", authorization ? { authorization } : {}),
  })
}

const link = (name: string, version: string, mode: "test" | "live" = "test") =>
  presignR2("media", { method: "GET", key: playbookObjectKey(name, version, mode), expiresIn: 600, now: NOW }).url

describe("dark until Track B lists Playbooks", () => {
  test("listed, Pro gets the library; every reason it is not listed answers 404 to everyone, before any sign-in", async () => {
    await publishTwo()
    seedPlan(PRO, "vector-50")
    expect((await playbooks(PRO)).status).toBe(200)
    const dark: [string, () => void | Promise<void>][] = [
      ["not in CODIUM_LISTED_PERKS", () => void (process.env.CODIUM_LISTED_PERKS = "vote")],
      ["Track B not live", () => void delete process.env.CODIUM_TRACK_B_LIVE],
      ["Codium not enabled", () => void (process.env.MODEL_PLANS_ENABLED = "false")],
      ["media bucket not configured", () => void delete process.env.VECTOR_R2_MEDIA_SECRET_ACCESS_KEY],
      ["perk switched off", () => void w.store.command(["SADD", codiumKey("perks-off"), "playbooks"])],
      ["codium switch off", () => void w.store.command(["SET", codiumKey("switch", "codium"), "off"])],
      ["one playbook left", async () => void (await run(["withdraw", "vector-docs-drift", "--mode", "test"]))],
      ["store down", () => void (w.store.fail = () => true)],
    ]
    for (const [reason, apply] of dark) {
      restore()
      restore = roadmapEnvironment(ENVIRONMENT)
      w = world()
      await publishTwo()
      seedPlan(PRO, "vector-50")
      await apply()
      const before = w.store.commands.length
      for (const answer of [
        await playbooks(PRO),
        await playbooks(undefined),
        await playbooks(PRO, { method: "POST" }),
        await playbooks(undefined, { authorization: "Bearer vrt_fixture.run" }),
      ]) {
        expect({ reason, status: answer.status, code: answer.body.error.code }).toEqual({
          reason,
          status: 404,
          code: "NOT_FOUND",
        })
      }
      // Nothing about the account was read: no snapshot, no revocation check, no rate-limit counter.
      const read = w.store.commands.slice(before).map((command) => command.join(" "))
      expect(
        read.filter((line) => line.includes(":ent:") || line.includes("cli-revoked") || line.includes("vector:abuse:")),
      ).toEqual([])
      expect(w.r2).toHaveLength(4) // the two uploads' HEAD and PUT, from publishing only
    }
  })

  test("readiness: Track B live, the media bucket, the store and at least two published playbooks", async () => {
    expect(await playbooksReady(w.fetcher)).toBe(false)
    await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"])
    expect(await playbooksReady(w.fetcher)).toBe(false)
    expect(await listedPerks(w.fetcher)).toEqual(new Set())
    await run(["publish", "playbooks/vector-docs-drift.json", "--version", "1.2.0", "--mode", "test"])
    expect(await perkServices.playbooks!(w.fetcher)).toBe(true)
    expect(await listedPerks(w.fetcher)).toEqual(new Set(["playbooks"]))
    delete process.env.CODIUM_TRACK_B_LIVE
    expect(await playbooksReady(w.fetcher)).toBe(false)
    process.env.CODIUM_TRACK_B_LIVE = "true"
    delete process.env.VECTOR_R2_ACCOUNT_ID
    expect(await playbooksReady(w.fetcher)).toBe(false)
    process.env.VECTOR_R2_ACCOUNT_ID = R2_ACCOUNT
    w.store.fail = () => true
    expect(await playbooksReady(w.fetcher)).toBe(false)
  })
})

describe("downloads (S1, S3, M4)", () => {
  test("Pro, Max, Ultra and a renewing plan get every playbook with a 10-minute link and its SHA-256", async () => {
    await publishTwo()
    const expected = [
      {
        name: "vector-docs-drift",
        version: "1.2.0",
        sha256: sha("playbooks/vector-docs-drift.json"),
        url: link("vector-docs-drift", "1.2.0"),
      },
      {
        name: "vector-flaky-tests",
        version: "1.0.0",
        sha256: sha("playbooks/vector-flaky-tests.json"),
        url: link("vector-flaky-tests", "1.0.0"),
      },
    ]
    const accounts: [string, PlanId, SnapshotFacts["state"]][] = [
      [PRO, "vector-50", "active"],
      [MAX, "vector-100", "active"],
      [ULTRA, "vector-200", "renewing"],
    ]
    for (const [account, plan, state] of accounts) {
      seedPlan(account, plan, state)
      const answer = await playbooks(account)
      expect(answer.status).toBe(200)
      expect(answer.headers["cache-control"]).toBe("no-store")
      expect(answer.body).toEqual(expected)
      expect(Playbooks.decodeLinks(answer.body)).toEqual(expected)
    }
    const url = new URL(expected[0]!.url)
    expect(url.origin).toBe(R2_ORIGIN)
    expect(url.pathname).toBe("/vector-media/playbooks/test/vector-docs-drift/1.2.0.json")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    // What a client downloads through the link is the file whose SHA-256 the listing gave.
    const file = await w.fetcher(expected[0]!.url)
    expect(
      createHash("sha256")
        .update(new Uint8Array(await file.arrayBuffer()))
        .digest("hex"),
    ).toBe(expected[0]!.sha256)
  })

  test("with a fresh snapshot the route reads only the store: no Stripe call and no bucket call (M4)", async () => {
    await publishTwo()
    seedPlan(MAX, "vector-100")
    const before = w.origins.length
    const answer = await playbooks(MAX)
    expect(answer.status).toBe(200)
    expect([...new Set(w.origins.slice(before))]).toEqual([ROADMAP_KV_URL])
  })

  test("the server refuses Plus, no plan, and a paused, frozen or ended plan (S1)", async () => {
    await publishTwo()
    const cases: [string, PlanId | null, SnapshotFacts["state"], number, string, Record<string, unknown>?][] = [
      [PLUS, "vector-10", "active", 403, "CODIUM_PERK_REQUIRED", { perk: "playbooks", plan: "vector-50" }],
      ["2b3c4d5e-0000-4000-8000-000000000011", null, "none", 402, "MODEL_PLAN_REQUIRED"],
      ["2b3c4d5e-0000-4000-8000-000000000012", "vector-50", "paused", 402, "MODEL_PLAN_PAYMENT_REQUIRED"],
      ["2b3c4d5e-0000-4000-8000-000000000013", "vector-200", "frozen", 403, "MODEL_PLAN_BLOCKED"],
      ["2b3c4d5e-0000-4000-8000-000000000014", "vector-100", "ended", 402, "MODEL_PLAN_REQUIRED"],
    ]
    for (const [account, plan, state, status, code, detail] of cases) {
      seedPlan(account, plan, state)
      const answer = await playbooks(account)
      expect({ account, status: answer.status, code: answer.body.error.code }).toEqual({ account, status, code })
      if (detail) expect(answer.body.error).toMatchObject(detail)
      expect(JSON.stringify(answer.body)).not.toContain("r2.cloudflarestorage.com")
    }
  })

  test("only a Vector account token is accepted: no token, a run token or a revoked account get 401 (S3)", async () => {
    await publishTwo()
    seedPlan(PRO, "vector-50")
    expect((await playbooks(undefined)).status).toBe(401)
    for (const authorization of ["Bearer vrt_fixture.run", "Bearer vht_fixture.hosted", "Basic abc", "Bearer vct_x"])
      expect((await playbooks(PRO, { authorization })).status).toBe(401)
    w.store.command(["SET", `vector:cli-revoked:${PRO}`, "1"])
    const revoked = await playbooks(PRO)
    expect(revoked.status).toBe(401)
    expect(revoked.body.error.code).toBe("CLI_TOKEN_INVALID")
  })

  test("only GET, 60 requests an hour per account", async () => {
    await publishTwo()
    seedPlan(PRO, "vector-50")
    expect((await playbooks(PRO, { method: "POST" })).status).toBe(405)
    const answers: number[] = []
    for (let index = 0; index < 61; index++) answers.push((await playbooks(PRO)).status)
    expect(answers.slice(0, 60).every((status) => status === 200)).toBe(true)
    expect(answers[60]).toBe(429)
  })

  test("a malformed library record is never listed or signed, and a live server never reads the test library", async () => {
    await publishTwo()
    const bad: Record<string, unknown>[] = [
      {
        v: 1,
        name: "vector-evil",
        version: "1.0.0",
        sha256: "0".repeat(64),
        bytes: 10,
        key: "../secrets.json",
        publishedAt: NOW,
      },
      {
        v: 1,
        name: "vector-other",
        version: "1.0.0",
        sha256: "0".repeat(64),
        bytes: 10,
        key: "recordings/a.webm",
        publishedAt: NOW,
      },
      {
        v: 1,
        name: "not-vector",
        version: "1.0.0",
        sha256: "0".repeat(64),
        bytes: 10,
        key: "playbooks/test/not-vector/1.0.0.json",
        publishedAt: NOW,
      },
      {
        v: 2,
        name: "vector-new",
        version: "1.0.0",
        sha256: "0".repeat(64),
        bytes: 10,
        key: "playbooks/test/vector-new/1.0.0.json",
        publishedAt: NOW,
      },
      {
        v: 1,
        name: "vector-short",
        version: "1.0",
        sha256: "0".repeat(64),
        bytes: 10,
        key: "playbooks/test/vector-short/1.0.json",
        publishedAt: NOW,
      },
    ]
    for (const record of bad)
      w.store.command(["HSET", playbooksKey("test"), String(record.name), JSON.stringify(record)])
    w.store.command(["HSET", playbooksKey("test"), "vector-garbage", "{not json"])
    seedPlan(PRO, "vector-50")
    const answer = await playbooks(PRO)
    expect(answer.status).toBe(200)
    expect(answer.body.map((item: { name: string }) => item.name)).toEqual(["vector-docs-drift", "vector-flaky-tests"])
    for (const record of bad) expect(decodePlaybookRecord(JSON.stringify(record), "test")).toBeUndefined()

    // The same records seen by a live server: a test key is not where a live record's file lives.
    const good = decodePlaybookRecord(w.store.hash(playbooksKey("test")).get("vector-docs-drift"), "test")!
    expect(good.key).toBe("playbooks/test/vector-docs-drift/1.2.0.json")
    expect(decodePlaybookRecord(JSON.stringify(good), "live")).toBeUndefined()
    process.env.CODIUM_STRIPE_MODE = "live"
    expect(await readPlaybooks({ fetcher: w.fetcher })).toEqual([])
    seedPlan(PRO, "vector-50")
    expect((await playbooks(PRO)).status).toBe(404)
  })
})

describe("publishing (script/playbooks-publish.ts)", () => {
  test("check needs no settings, reaches nothing, prints what each playbook names and refuses any other command", async () => {
    for (const name of Object.keys(ENVIRONMENT)) delete process.env[name]
    const lines = await run(["check", "playbooks/vector-flaky-tests.json", "playbooks/vector-docs-drift.json"])
    expect(lines).toEqual([
      "playbooks/vector-flaky-tests.json: vector-flaky-tests passes. Commands: bun test.",
      "playbooks/vector-docs-drift.json: vector-docs-drift passes. Commands: bun test, git diff src/index.ts.",
    ])
    const refused = await run(["check", "playbooks/vector-flaky-tests.json", "playbooks/vector-deploy.json"]).catch(
      (error: Error) => error.message,
    )
    expect(String(refused).split("\n")).toEqual([
      expect.stringMatching(/^playbooks\/vector-deploy\.json \/stages\/0\/prompt: `npm publish` is not a command/),
      expect.stringMatching(/^playbooks\/vector-deploy\.json \/stages\/0\/prompt: `git push` is not a command/),
    ])
    expect(w.origins).toEqual([])
  })

  test("publish uploads the exact file once through a signed upload, then records it in the library", async () => {
    const lines = await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"])
    const key = "playbooks/test/vector-flaky-tests/1.0.0.json"
    expect(lines[0]).toBe(
      `vector-flaky-tests 1.0.0 published (test store): ${bytesOf("playbooks/vector-flaky-tests.json").byteLength} bytes, sha256 ${sha("playbooks/vector-flaky-tests.json")}.`,
    )
    expect(lines[1]).toBe("Commands it names: bun test.")
    expect(w.r2.map((call) => [call.method, call.key])).toEqual([
      ["HEAD", key],
      ["PUT", key],
    ])
    expect(w.r2[1]!.signed).toBe("content-length;content-type;host")
    expect(w.r2[1]!.headers["content-type"]).toBe("application/json")
    expect(w.bucket.get(key)!.bytes).toEqual(bytesOf("playbooks/vector-flaky-tests.json"))
    const record: PlaybookRecord = {
      v: 1,
      name: "vector-flaky-tests",
      version: "1.0.0",
      sha256: sha("playbooks/vector-flaky-tests.json"),
      bytes: bytesOf("playbooks/vector-flaky-tests.json").byteLength,
      key,
      publishedAt: NOW,
    }
    expect(JSON.parse(w.store.hash(playbooksKey("test")).get("vector-flaky-tests")!)).toEqual(record)
    expect(w.store.keys().filter((name) => name.includes("playbooks"))).toEqual([playbooksKey("test")])
    expect(playbooksKey("test")).toBe("vector:codium:test:playbooks")

    // Running it again changes nothing.
    expect(await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"])).toEqual(
      ["vector-flaky-tests 1.0.0 is already published with this file (test store)."],
    )
    expect(w.r2).toHaveLength(2)
    // Nothing printed names a setting's value.
    expect(lines.join("\n")).not.toContain(R2_SECRET)
    expect(lines.join("\n")).not.toContain("fixture-kv-token")
  })

  test("a version never changes and the library never goes back; a bad playbook is never uploaded", async () => {
    await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.1.0", "--mode", "test"])
    FILES["playbooks/vector-flaky-tests.json"] = spec("Flaky test hunt", "Run `bun test` five times.")
    try {
      const same = await run([
        "publish",
        "playbooks/vector-flaky-tests.json",
        "--version",
        "1.1.0",
        "--mode",
        "test",
      ]).catch((error: Error) => error.message)
      expect(same).toContain("already published with other content")
      const older = await run([
        "publish",
        "playbooks/vector-flaky-tests.json",
        "--version",
        "1.0.9",
        "--mode",
        "test",
      ]).catch((error: Error) => error.message)
      expect(older).toContain("is at 1.1.0")
      expect(w.r2).toHaveLength(2)
      await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.10.0", "--mode", "test"])
      expect(decodePlaybookRecord(w.store.hash(playbooksKey("test")).get("vector-flaky-tests"), "test")!.version).toBe(
        "1.10.0",
      )

      // Withdrawn, a version still cannot come back with other content: the bucket keeps its file.
      expect(await run(["withdraw", "vector-flaky-tests", "--mode", "test"])).toEqual([
        "vector-flaky-tests is withdrawn (test store): no new download links; links already given expire within 10 minutes.",
      ])
      expect(await run(["withdraw", "vector-flaky-tests", "--mode", "test"])).toEqual([
        "vector-flaky-tests was not published (test store).",
      ])
      FILES["playbooks/vector-flaky-tests.json"] = spec("Flaky test hunt", "Run `bun test` once.")
      const reused = await run([
        "publish",
        "playbooks/vector-flaky-tests.json",
        "--version",
        "1.10.0",
        "--mode",
        "test",
      ]).catch((error: Error) => error.message)
      expect(reused).toContain("already holds another file")
      expect(w.store.hash(playbooksKey("test")).has("vector-flaky-tests")).toBe(false)

      const calls = w.r2.length
      const bad = await run(["publish", "playbooks/vector-deploy.json", "--version", "1.0.0", "--mode", "test"]).catch(
        (error: Error) => error.message,
      )
      expect(bad).toContain("`npm publish` is not a command")
      expect(w.r2).toHaveLength(calls)
      expect(w.store.hash(playbooksKey("test")).has("vector-deploy")).toBe(false)
    } finally {
      FILES["playbooks/vector-flaky-tests.json"] = spec(
        "Flaky test hunt",
        "Run `bun test` three times and read `package.json`.",
      )
    }
  })

  test("publishing needs both settings and names each one missing; list shows the library", async () => {
    delete process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID
    expect(
      await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"]).catch(
        (error: Error) => error.message,
      ),
    ).toBe("Publishing needs the media bucket: set VECTOR_R2_ACCOUNT_ID and VECTOR_R2_MEDIA_*.")
    process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID = "fixtureaccesskey0001"
    delete process.env.KV_REST_API_URL
    expect(
      await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"]).catch(
        (error: Error) => error.message,
      ),
    ).toBe("Publishing needs the Codium store: set KV_REST_API_URL and KV_REST_API_TOKEN.")
    expect(w.origins).toEqual([])
    process.env.KV_REST_API_URL = ROADMAP_KV_URL
    expect(await run(["list", "--mode", "test"])).toEqual(["No playbooks are published (test store)."])
    await run(["publish", "playbooks/vector-flaky-tests.json", "--version", "1.0.0", "--mode", "test"])
    expect(await run(["list", "--mode", "test"])).toEqual([
      "1 playbook published (test store); Playbooks can be listed from 2:",
      `  vector-flaky-tests 1.0.0  sha256 ${sha("playbooks/vector-flaky-tests.json").slice(0, 12)}…  ${bytesOf("playbooks/vector-flaky-tests.json").byteLength} bytes  2026-11-15`,
    ])
    expect(await run(["list", "--mode", "live"])).toEqual(["No playbooks are published (live store)."])
  })

  test("the command line", () => {
    expect(parsePlaybooksArguments(["check", "a.json", "b.json"])).toEqual({
      command: "check",
      files: ["a.json", "b.json"],
    })
    expect(parsePlaybooksArguments(["publish", "a.json", "--version", "2.0.1", "--mode", "live"])).toEqual({
      command: "publish",
      file: "a.json",
      version: "2.0.1",
      mode: "live",
    })
    expect(parsePlaybooksArguments(["withdraw", "vector-a", "--mode", "test"])).toEqual({
      command: "withdraw",
      name: "vector-a",
      mode: "test",
    })
    for (const argv of [
      [],
      ["check"],
      ["check", "a.json", "--mode", "test"],
      ["publish", "a.json", "--mode", "test"],
      ["publish", "a.json", "--version", "1.0", "--mode", "test"],
      ["publish", "a.json", "--version", "01.0.0", "--mode", "test"],
      ["publish", "a.json", "--version", "1.0.0"],
      ["publish", "a.json", "--version", "1.0.0", "--mode", "prod"],
      ["publish", "a.json", "b.json", "--version", "1.0.0", "--mode", "test"],
      ["list"],
      ["withdraw", "flaky", "--mode", "test"],
      ["withdraw", "vector-a", "--mode", "test", "--force", "x"],
      ["delete", "vector-a", "--mode", "test"],
    ])
      expect(() => parsePlaybooksArguments(argv)).toThrow()
  })
})

describe("shared shapes", () => {
  test("versions compare as numbers, and publishPlan keeps versions fixed and moving forward", () => {
    expect(Playbooks.compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
    expect(Playbooks.compareVersions("2.0.0", "2.0.0")).toBe(0)
    expect(Playbooks.compareVersions("0.9.0", "1.0.0")).toBeLessThan(0)
    const current: PlaybookRecord = {
      v: 1,
      name: "vector-a",
      version: "1.2.0",
      sha256: "a".repeat(64),
      bytes: 10,
      key: "playbooks/test/vector-a/1.2.0.json",
      publishedAt: NOW,
    }
    expect(publishPlan(undefined, { name: "vector-a", version: "0.0.1", sha256: "b".repeat(64) })).toEqual({
      kind: "new",
    })
    expect(publishPlan(current, { name: "vector-a", version: "1.2.1", sha256: "b".repeat(64) })).toEqual({
      kind: "new",
    })
    expect(publishPlan(current, { name: "vector-a", version: "1.2.0", sha256: "a".repeat(64) })).toEqual({
      kind: "same",
    })
    expect(publishPlan(current, { name: "vector-a", version: "1.2.0", sha256: "b".repeat(64) }).kind).toBe("refused")
    expect(publishPlan(current, { name: "vector-a", version: "1.1.9", sha256: "a".repeat(64) }).kind).toBe("refused")
  })

  test("a client decodes only a well-formed listing", () => {
    const entry = { name: "vector-a", version: "1.0.0", sha256: "c".repeat(64), url: "https://example.invalid/a" }
    expect(Playbooks.decodeLinks([entry])).toEqual([entry])
    expect(Playbooks.decodeLinks([])).toEqual([])
    for (const value of [
      undefined,
      {},
      [entry, entry],
      [{ ...entry, url: "http://example.invalid/a" }],
      [{ ...entry, url: "https://user:pass@example.invalid/a" }],
      [{ ...entry, name: "a" }],
      [{ ...entry, version: "1" }],
      [{ ...entry, sha256: "C".repeat(64) }],
      [{ ...entry, extra: true }],
      Array.from({ length: Playbooks.MAX_LISTED + 1 }, (_, index) => ({ ...entry, name: `vector-a${index}` })),
    ])
      expect(Playbooks.decodeLinks(value)).toBeUndefined()
  })
})
