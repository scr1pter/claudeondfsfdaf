import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomBytes, randomInt, randomUUID } from "node:crypto"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { mintRunToken } from "../../../api/_lib/cloud-agents-run-token"
import { createRunBodyVisibility } from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { ENV_NAMES, platformOn, readConfig } from "../../../api/_lib/everywhere/config"
import {
  READ_BODY_ONCE_SCRIPT,
  cancelJob,
  createJob,
  decodeJobRecord,
  dispatchJob,
  encodeJobRecord,
  eraseAccountJobs,
  eraseInstallationJobs,
  readJob,
  readRunBody,
  startDispatched,
  sweepDue,
  type JobRecord,
  type JobsContext,
  type NewJob,
} from "../../../api/_lib/everywhere/jobs"
import { KEEP_MS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { storeUnavailable, type Store, type StoreCommand } from "../../../api/_lib/everywhere/store"
import type { SwitchState } from "../../../api/_lib/everywhere/switch"
import { ApiError } from "../../../api/_lib/http"
import route, { config, createJobBodyRoute, type BodyRouteDeps } from "../../../api/everywhere/jobs/[jid]/body"
import { TIMING, createJobId, decodeActionsJobBody, type PlatformId } from "../../../packages/schema/src/everywhere"
import { githubAppFixture } from "./github-app-fixture"
import { RouteHarness, everywhereEnv } from "./lib/everywhere-account"
import { bindingFields, bindingStore } from "./lib/everywhere-cloud-agents"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { seedJobAuthority } from "./lib/everywhere-job-authority"
import {
  FakeStore,
  realRedis,
  testAccountAuthority,
  testEverywhereStore,
  useKv,
  type RealRedis,
} from "./lib/everywhere-store"

installFetchGuard()

/*
 * EV-27 (R-A4, the server half; spec 3.6, VE-30, E4, E11): an Actions run reads its job's body by reference,
 * `GET /api/everywhere/jobs/<jid>/body` with its `vrt_` run token. Only the run that `run:<rid>` links to the job
 * reads it, only while the job is a running Actions job of that account and repository, from a platform, on a private
 * repository, and only once: a second read is 410. Every other caller gets the 404 a missing job gets. The feature off
 * answers 404 EVERYWHERE_OFF before the token or the store. The ticket, the run's link and its marker end with the
 * body and go when the job ends or its account or installation is erased.
 *
 * Tokens are real (`mintRunToken` under a secret generated here); the token's live-run check (the CHECK script) is
 * cloud-agents-run-token.test.ts's, so its store is a stand-in that answers `live`. Jobs are made through the jobs
 * module and the route runs on a loopback server over the FakeStore; the atomic read also runs against a real Redis in
 * CI (VECTOR_TEST_REDIS_URL).
 */

const MINUTE = 60_000
const SECRETS = ["VECTOR_RUN_TOKEN_SECRET", "VECTOR_CLI_TOKEN_SECRET"] as const
const previous = Object.fromEntries(SECRETS.map((name) => [name, process.env[name]]))
const harness = new RouteHarness()
let restoreKv: () => void
beforeAll(async () => {
  restoreKv = useKv()
  process.env.VECTOR_RUN_TOKEN_SECRET = randomBytes(32).toString("hex")
  process.env.VECTOR_CLI_TOKEN_SECRET = randomBytes(32).toString("hex")
  await harness.start()
})
afterAll(async () => {
  restoreKv()
  for (const name of SECRETS) {
    const value = previous[name]
    if (value === undefined) delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
  await harness.stop()
})

const ALICE = randomUUID()
const BOB = randomUUID()
const SLACK = "slack:T0123ABCD"
const SLACK_BOB = "slack:T0999ZZZZ"
const LINEAR = `linear:${randomUUID()}`
const LINEAR_USER = randomUUID()
const GITHUB = "github:4242"
const REPOSITORY = 101
const TASK = "Fix the login bug on Safari"
const CONTEXT_TEXT = "It fails after the redirect."
const LABEL = "Alice <@U0ALICE01>"
const OFF = { error: { code: "EVERYWHERE_OFF" } }
const GONE = {
  error: { code: "EVERYWHERE_BODY_GONE", message: "This job's request was already read or is no longer kept." },
}
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Not found." } }
const MUTATING = new Set([
  "SET",
  "DEL",
  "GETDEL",
  "INCR",
  "PEXPIRE",
  "SADD",
  "SREM",
  "ZADD",
  "ZREM",
  "ZREMRANGEBYSCORE",
  "EVAL",
])

let fake: FakeStore
let store: Store
let env: Record<string, string>
let everywhere: SwitchState | undefined
/** What the run token's live-run check answers. */
let live: string
/** The live-run checks the route made. */
let checks: StoreCommand[]
beforeEach(() => {
  fake = new FakeStore()
  store = testEverywhereStore(fake.fetch)
  env = everywhereEnv()
  everywhere = undefined
  live = "ok"
  checks = []
})

function ctx(extra: Partial<JobsContext> = {}): JobsContext {
  return {
    store,
    keys: readConfig(env).dataKeys,
    now: fake.clock.now,
    accountAuthority: testAccountAuthority,
    ...extra,
  }
}

function slackJob(extra: Partial<NewJob> = {}): NewJob {
  return {
    platform: "slack",
    installation: SLACK,
    kind: "mention",
    requester: { userId: "U0ALICE01", account: ALICE, label: LABEL },
    sponsor: ALICE,
    repository: { id: REPOSITORY, fullName: "acme/app", shared: false },
    shared: false,
    task: TASK,
    context: [{ from: "teammate", text: CONTEXT_TEXT }],
    reply: { channel: "C0123", thread: "1731335400.000100" },
    ...extra,
  }
}

function linearJob(): NewJob {
  return slackJob({
    platform: "linear",
    installation: LINEAR,
    requester: { userId: LINEAR_USER, account: ALICE, label: LABEL },
    issue: { key: "ENG-123" },
  })
}

function bobJob(): NewJob {
  return slackJob({
    installation: SLACK_BOB,
    requester: { userId: "U0BOB0001", account: BOB, label: "Bob" },
    sponsor: BOB,
  })
}

function githubJob(): NewJob {
  return {
    platform: "github",
    installation: GITHUB,
    kind: "mention",
    requester: { userId: "77", account: ALICE },
    sponsor: ALICE,
    repository: { id: REPOSITORY, fullName: "acme/app", shared: false },
    shared: false,
    task: "",
    context: [],
    github: { kind: "issue", number: 12, commentId: 99 },
  }
}

/** @vector's run id of a check run of `repository`, as the run token names it. */
function runId(repository = REPOSITORY) {
  return GithubAgents.runId(repository, randomInt(1, 2 ** 40), 1, randomInt(1, 2 ** 40))
}

/** A real run token for `rid`, which names its own repository; valid until `dl` (45 minutes from now by default). */
function runToken(sub: string, rid: string, options: { readonly dl?: number } = {}) {
  const dl = options.dl ?? fake.clock.now + 45 * MINUTE
  return mintRunToken({
    sub,
    rid,
    repo: /^gh-([0-9]+)-/.exec(rid)![1]!,
    thr: "dispatch-1",
    gen: 1,
    src: "github-dispatch",
    pur: "task",
    epoch: "p1",
    dl,
    iat: Math.min(fake.clock.now, dl) - 1_000,
    jti: randomBytes(16).toString("base64url"),
  }).token
}

type Running = { readonly jid: string; readonly hash: string; readonly rid: string; readonly job: JobRecord }

/** A job created, then dispatched to Actions with a fresh ticket hash, through the jobs module. */
async function dispatched(input: NewJob = slackJob()) {
  await seedJobAuthority(ctx(), input)
  const created = await createJob(ctx(), input)
  if (!created.ok) throw new Error(`createJob refused: ${created.code}`)
  const hash = randomBytes(32).toString("base64url")
  expect(await dispatchJob(ctx(), created.job.jid, { ticketHash: hash })).toMatchObject({ ok: true })
  return { jid: created.job.jid, hash, job: created.job }
}

/** A dispatched job whose run started as `rid`: the start hook links the run to the job. */
async function running(input: NewJob = slackJob(), rid = runId()): Promise<Running> {
  const sent = await dispatched(input)
  const started = await startDispatched(ctx(), sent.hash, rid)
  if (!started.ok) throw new Error(`start refused: ${started.code}`)
  return { jid: sent.jid, hash: sent.hash, rid, job: started.job }
}

function marker(job: Pick<Running, "rid">) {
  return everywhereKeys.runBodyRead(job.rid)
}

function links(job: Running) {
  return [everywhereKeys.ticket(job.hash), everywhereKeys.run(job.rid), marker(job)]
}

function deps(extra: Partial<BodyRouteDeps> = {}): BodyRouteDeps {
  const liveStore = async (command: readonly (string | number)[]) => {
    checks.push([...command])
    return live
  }
  return {
    env,
    store,
    accountAuthority: testAccountAuthority,
    fetcher: fake.fetch,
    now: () => fake.clock.now,
    switches: async (name) => (name === "everywhere" ? everywhere : undefined),
    visibility: async () => "private",
    runTokens: {
      store: liveStore,
      revokedBefore: async () => undefined,
    },
    ...extra,
  }
}

/** The route's JSON answer: a body's fields, or an error. */
type AnswerBody = {
  readonly task?: string
  readonly context?: ReadonlyArray<Record<string, unknown>>
  readonly outside?: string
  readonly error?: { readonly code?: string; readonly message?: string }
}

type Answer = {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly body: AnswerBody | undefined
}

/** Calls the route at its own path, as Vercel would, with the jid in the query as Vercel passes the path segment. */
async function read(
  jid: string,
  token: string | undefined,
  options: { readonly deps?: Partial<BodyRouteDeps>; readonly method?: string; readonly authorization?: string } = {},
): Promise<Answer> {
  const path = `/api/everywhere/jobs/${jid}/body`
  harness.mount({ [path]: createJobBodyRoute(deps(options.deps)) })
  const authorization = options.authorization ?? (token === undefined ? undefined : `Bearer ${token}`)
  const response = await fetch(`${harness.origin}${path}?jid=${encodeURIComponent(jid)}`, {
    method: options.method ?? "GET",
    headers: authorization === undefined ? {} : { authorization },
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined }
}

function since(mark: number) {
  return fake.commands.slice(mark)
}

function touching(commands: readonly string[][], key: string) {
  return commands.filter((command) => command.includes(key))
}

/** The read-once script's runs among `commands`. */
function scripted(commands: readonly string[][]) {
  return commands.filter((command) => command[0] === "EVAL" && command[1]!.endsWith(READ_BODY_ONCE_SCRIPT))
}

function withoutKey(source: Record<string, string>, name: string) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== name))
}

function code(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error instanceof ApiError ? error.code : "other"
  }
  return "built"
}

/** A store that fails, as an outage would, the first `times` commands `fails` picks, and passes the rest through. */
function failing(inner: Store, fails: (command: StoreCommand) => boolean, times = 1): Store {
  let left = times
  return async (command) => {
    if (left > 0 && fails(command)) {
      left--
      throw storeUnavailable()
    }
    return inner(command)
  }
}

/** The end-of-job delete of `job`'s links. */
function unlink(job: Running) {
  return (command: StoreCommand) => command[0] === "DEL" && command.includes(everywhereKeys.run(job.rid))
}

/** A store that moves `jid`'s record on (a newer version) just before each of the first `times` read-once scripts. */
function bumping(inner: Store, jid: string, times: number): Store {
  let left = times
  return async (command) => {
    if (left > 0 && command[0] === "EVAL" && String(command[1]).endsWith(READ_BODY_ONCE_SCRIPT)) {
      left--
      const key = everywhereKeys.job(jid)
      const record = decodeJobRecord(JSON.parse(String(fake.read(key)?.value)))!
      fake.send(["SET", key, encodeJobRecord({ ...record, version: record.version + 1 }), "PX", String(fake.pttl(key))])
    }
    return inner(command)
  }
}

/** A store whose first read of `key` waits until `parties` callers have all read it, so they all act on one version. */
function barrier(inner: Store, key: string, parties: number) {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  return (): Store => {
    let first = true
    return async (command) => {
      const result = await inner(command)
      if (first && command[0] === "GET" && command[1] === key) {
        first = false
        if (++arrived === parties) release()
        await all
      }
      return result
    }
  }
}

describe("the run's link and its keys", () => {
  test("K1: the link and its marker have their own keys, and the ticket, the link and the marker end with the body", async () => {
    expect(everywhereKeys.run("gh-101-5-1-7")).toBe("vector:everywhere:run:gh-101-5-1-7")
    expect(everywhereKeys.runBodyRead("gh-101-5-1-7")).toBe("vector:everywhere:run:gh-101-5-1-7:body-read")
    expect(everywhereKeys.run("run-123")).toBe("vector:everywhere:run:run-123")
    for (const bad of ["", "a:b", "a b", "gh-1.2", "é", "x".repeat(129), "run\n"]) {
      expect(code(() => everywhereKeys.run(bad))).toBe("EVERYWHERE_INVALID_ID")
      expect(code(() => everywhereKeys.runBodyRead(bad))).toBe("EVERYWHERE_INVALID_ID")
    }
    expect([KEEP_MS.ticket, KEEP_MS.run, KEEP_MS.bodyRead]).toEqual([KEEP_MS.jobBody, KEEP_MS.jobBody, KEEP_MS.jobBody])

    const input = slackJob()
    await seedJobAuthority(ctx(), input)
    const created = await createJob(ctx(), input)
    if (!created.ok) throw new Error("not created")
    const jid = created.job.jid
    const ends = created.job.bodyExpiresAt
    const hash = randomBytes(32).toString("base64url")
    const rid = runId()
    fake.clock.advance(10 * MINUTE)
    expect((await dispatchJob(ctx(), jid, { ticketHash: hash })).ok).toBe(true)
    expect(fake.pttl(everywhereKeys.ticket(hash))).toBe(ends - fake.clock.now)
    fake.clock.advance(10 * MINUTE)
    expect((await startDispatched(ctx(), hash, rid)).ok).toBe(true)
    expect(fake.read(everywhereKeys.run(rid))?.value).toBe(jid)
    expect(fake.pttl(everywhereKeys.run(rid))).toBe(ends - fake.clock.now)
    expect(fake.pttl(everywhereKeys.ticket(hash))).toBe(ends - fake.clock.now)
    fake.clock.advance(10 * MINUTE)
    expect((await read(jid, runToken(ALICE, rid))).status).toBe(200)
    // The marker lives exactly as long as the body has left: 90 minutes after a read 30 minutes in.
    expect(fake.pttl(marker({ rid }))).toBe(fake.pttl(everywhereKeys.jobBody(jid)))
    expect(fake.pttl(marker({ rid }))).toBe(KEEP_MS.jobBody - 30 * MINUTE)
    expect(ends - fake.clock.now).toBe(KEEP_MS.jobBody - 30 * MINUTE)

    fake.clock.now = ends
    for (const key of [
      everywhereKeys.ticket(hash),
      everywhereKeys.run(rid),
      marker({ rid }),
      everywhereKeys.jobBody(jid),
    ])
      expect(fake.read(key)).toBeUndefined()
    const after = await read(jid, runToken(ALICE, rid))
    expect([after.status, after.body]).toEqual([404, NOT_FOUND])
  })

  test("K1b: a job whose body has ended is never dispatched, and one a millisecond before gets a ticket for that millisecond", async () => {
    const inputs = [slackJob(), slackJob()]
    await seedJobAuthority(ctx(), inputs[0]!)
    const jobs = await Promise.all(inputs.map((input) => createJob(ctx(), input)))
    const [last, late] = jobs.map((verdict) => {
      if (!verdict.ok) throw new Error("not created")
      return verdict.job
    }) as [JobRecord, JobRecord]
    const hashes = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")] as const
    fake.clock.now = last.bodyExpiresAt - 1
    expect((await dispatchJob(ctx(), last.jid, { ticketHash: hashes[0] })).ok).toBe(true)
    expect(fake.pttl(everywhereKeys.ticket(hashes[0]))).toBe(1)
    fake.clock.now = late.bodyExpiresAt
    // A distinct answer, so a router can tell a body that ended from a lost race.
    expect(await dispatchJob(ctx(), late.jid, { ticketHash: hashes[1] })).toEqual({
      ok: false,
      code: "body-gone",
      state: "received",
    })
    expect(fake.read(everywhereKeys.ticket(hashes[1]))).toBeUndefined()
    expect((await readJob(store, late.jid))?.state).toBe("received")
  })

  test("K2: the start links only the dispatched job whose ticket it names", async () => {
    const sent = await dispatched()
    const rid = runId()
    // A second dispatch of the job writes its ticket and then loses: that ticket names the job, but not its hash.
    const stray = randomBytes(32).toString("base64url")
    expect(await dispatchJob(ctx(), sent.jid, { ticketHash: stray })).toMatchObject({ ok: false, code: "wrong-state" })
    expect(fake.read(everywhereKeys.ticket(stray))?.value).toBe(sent.jid)
    expect(await startDispatched(ctx(), stray, rid)).toMatchObject({ ok: false, code: "wrong-state" })
    expect(fake.read(everywhereKeys.run(rid))).toBeUndefined()

    // A cancelled job's leftover ticket links nothing.
    await seedJobAuthority(ctx(), slackJob())
    const gone = await createJob(ctx(), slackJob())
    if (!gone.ok) throw new Error("not created")
    expect((await cancelJob(ctx(), gone.job.jid)).ok).toBe(true)
    const leftover = randomBytes(32).toString("base64url")
    expect(await dispatchJob(ctx(), gone.job.jid, { ticketHash: leftover })).toMatchObject({ ok: false })
    expect(fake.read(everywhereKeys.ticket(leftover))?.value).toBe(gone.job.jid)
    const other = runId()
    expect(await startDispatched(ctx(), leftover, other)).toMatchObject({ ok: false, code: "wrong-state" })
    expect(fake.read(everywhereKeys.run(other))).toBeUndefined()

    // The job's own ticket links its run, and the record names the same run.
    expect(await startDispatched(ctx(), sent.hash, rid)).toMatchObject({ ok: true, job: { state: "running", rid } })
    expect(fake.read(everywhereKeys.run(rid))?.value).toBe(sent.jid)
  })

  test("K3: the start links before it moves the job, on one read of the record; a failed link moves nothing", async () => {
    const sent = await dispatched()
    const rid = runId()
    const link = (command: StoreCommand) => command[0] === "EVAL" && command.includes(everywhereKeys.run(rid))
    await expect(startDispatched(ctx({ store: failing(store, link) }), sent.hash, rid)).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
    expect((await readJob(store, sent.jid))?.state).toBe("dispatched")
    expect(fake.read(everywhereKeys.run(rid))).toBeUndefined()

    const mark = fake.commands.length
    expect(await startDispatched(ctx(), sent.hash, rid)).toMatchObject({ ok: true, job: { state: "running", rid } })
    expect(fake.read(everywhereKeys.run(rid))?.value).toBe(sent.jid)
    const reads = since(mark).filter((command) => command[0] === "GET")
    expect(touching(reads, everywhereKeys.job(sent.jid))).toHaveLength(1)
    // One authority read: the installation's record once.
    expect(touching(reads, everywhereKeys.install(SLACK))).toHaveLength(1)
  })
})

describe("the body route", () => {
  test.each(["slack", "linear"] as const)(
    "B1: the linked run reads its %s job's body once: exactly the task, the context and the outside marker",
    async (platform) => {
      const job = await running(platform === "slack" ? slackJob() : linearJob())
      const mark = fake.commands.length
      const answer = await read(job.jid, runToken(ALICE, job.rid))
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({
        task: TASK,
        context: [{ from: "teammate", text: CONTEXT_TEXT }],
        outside: platform,
      })
      expect(Object.keys(answer.body ?? {}).sort()).toEqual(["context", "outside", "task"])
      expect(answer.body?.context?.map((item) => Object.keys(item).sort())).toEqual([["from", "text"]])
      // The agent phase's own decoder (EV-28) accepts exactly this answer, so the two ends hold one contract.
      const kept: unknown = decodeActionsJobBody(JSON.parse(answer.text))
      expect(kept).toEqual({ ok: true, value: answer.body })
      // No label, account, reply reference, sealed text, ticket, run, job id or lease.
      for (const kept of [
        "Alice",
        "U0ALICE01",
        ALICE,
        "C0123",
        "1731335400",
        "ves1.",
        job.hash,
        job.rid,
        job.jid,
        "lease",
        "label",
        "sponsor",
      ])
        expect(answer.text).not.toContain(kept)
      expect(answer.headers.get("cache-control")).toBe("no-store")
      expect(answer.headers.get("content-type")).toContain("application/json")
      expect(fake.read(marker(job))?.value).toBe("1")
      expect(scripted(since(mark))).toHaveLength(1)
      expect(checks).toHaveLength(1)
    },
  )

  test("B2: every later read gives 410 with no body, also with a token minted again for the same run", async () => {
    const job = await running()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
    const token = runToken(ALICE, job.rid)
    for (const again of [token, token, runToken(ALICE, job.rid)]) {
      const answer = await read(job.jid, again)
      expect([answer.status, answer.body]).toEqual([410, GONE])
      expect(answer.text).not.toContain("Safari")
    }
  })

  test("B3: another run's token gets the 404 a missing job gets, and reads, writes and spends nothing of the job", async () => {
    const a = await running()
    const b = await running()
    const bob = await running(bobJob())
    const missing = await read(createJobId(fake.clock.now), runToken(ALICE, b.rid))
    expect([missing.status, missing.body]).toEqual([404, NOT_FOUND])
    const jobKey = everywhereKeys.job(a.jid)

    // The same account's other run, and Bob's own run: refused on the link, before A's record is read.
    for (const token of [runToken(ALICE, b.rid), runToken(BOB, bob.rid)]) {
      const mark = fake.commands.length
      const answer = await read(a.jid, token)
      expect([answer.status, answer.text]).toEqual([404, missing.text])
      expect(touching(since(mark), jobKey)).toEqual([])
      expect(since(mark).filter((command) => MUTATING.has(command[0]!))).toEqual([])
    }

    // A link planted to tie Bob's run to A's job, and Bob's token naming A's own run: the link passes, so A's record is
    // read, and the record refuses them (its rid, its sponsor) with nothing written and no script run.
    fake.send(["SET", everywhereKeys.run(bob.rid), a.jid])
    for (const token of [runToken(BOB, bob.rid), runToken(BOB, a.rid)]) {
      const mark = fake.commands.length
      const answer = await read(a.jid, token)
      expect([answer.status, answer.text]).toEqual([404, missing.text])
      expect(touching(since(mark), jobKey).map((command) => command[0])).toEqual(["GET"])
      expect(since(mark).filter((command) => MUTATING.has(command[0]!))).toEqual([])
    }
    for (const job of [a, b, bob]) expect(fake.read(marker(job))).toBeUndefined()
    expect((await read(a.jid, runToken(ALICE, a.rid))).status).toBe(200)
  })

  test("B4: a run the job is not linked to gets 404, and the read-once script never runs", async () => {
    // Dispatched and never started: no run is linked.
    const sent = await dispatched()
    const stranger = runId()
    const before = fake.commands.length
    const unlinked = await read(sent.jid, runToken(ALICE, stranger))
    expect([unlinked.status, unlinked.body]).toEqual([404, NOT_FOUND])
    expect(touching(since(before), everywhereKeys.job(sent.jid))).toEqual([])

    // A stray link whose record names another run.
    const job = await running()
    const other = runId()
    fake.send(["SET", everywhereKeys.run(other), job.jid])
    const mark = fake.commands.length
    const stray = await read(job.jid, runToken(ALICE, other))
    expect([stray.status, stray.body]).toEqual([404, NOT_FOUND])
    expect(scripted(since(mark))).toEqual([])
    for (const rid of [stranger, other, job.rid]) expect(fake.read(marker({ rid }))).toBeUndefined()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
  })

  test("B5: off answers 404 EVERYWHERE_OFF before the token or the store; `stop` after the token; `no-new` reads", async () => {
    const job = await running()
    const good = runToken(ALICE, job.rid)
    const offs = [
      { ...env, [ENV_NAMES.enabled]: "false" },
      withoutKey(env, ENV_NAMES.enabled),
      withoutKey(env, ENV_NAMES.dataKey),
    ]
    for (const off of offs)
      for (const token of [good, "vrt_forged.signature", undefined]) {
        const mark = fake.commands.length
        const answer = await read(job.jid, token, { deps: { env: off } })
        expect([answer.status, answer.body]).toEqual([404, OFF])
        expect(since(mark)).toEqual([])
      }
    expect(checks).toEqual([])

    everywhere = "stop"
    const mark = fake.commands.length
    const stopped = await read(job.jid, good)
    expect([stopped.status, stopped.body]).toEqual([404, OFF])
    // A switch that cannot be read reads `stop`.
    const unreadable = await read(job.jid, good, {
      deps: {
        switches: async () => {
          throw new Error("Codium is down")
        },
      },
    })
    expect([unreadable.status, unreadable.body]).toEqual([404, OFF])
    expect(since(mark)).toEqual([])
    expect(checks).toHaveLength(2)
    expect(fake.read(marker(job))).toBeUndefined()

    everywhere = "no-new"
    expect((await read(job.jid, good)).status).toBe(200)
  })

  test("B6: a missing, foreign, forged, late or settled token gets 401 and touches no job; POST gets 405", async () => {
    const job = await running()
    const secret = process.env.VECTOR_RUN_TOKEN_SECRET
    process.env.VECTOR_RUN_TOKEN_SECRET = randomBytes(32).toString("hex")
    const foreign = runToken(ALICE, job.rid)
    process.env.VECTOR_RUN_TOKEN_SECRET = secret
    const good = runToken(ALICE, job.rid)
    const [payload, signature] = good.slice("vrt_".length).split(".") as [string, string]
    const desktop = mintCliToken({ id: ALICE, email: "alice@example.com" }, fake.clock.now, "desktop").token
    const cases: ReadonlyArray<readonly [string, string | undefined, string]> = [
      ["no header", undefined, "RUN_TOKEN_INVALID"],
      ["a Basic header", `Basic ${Buffer.from("alice:secret").toString("base64")}`, "RUN_TOKEN_INVALID"],
      ["the desktop app's token", `Bearer ${desktop}`, "RUN_TOKEN_INVALID"],
      ["a token under another key", `Bearer ${foreign}`, "RUN_TOKEN_INVALID"],
      ["a changed payload", `Bearer vrt_${payload}A.${signature}`, "RUN_TOKEN_INVALID"],
      ["past its deadline", `Bearer ${runToken(ALICE, job.rid, { dl: fake.clock.now - 1 })}`, "MODEL_PLAN_RUN_EXPIRED"],
    ]
    for (const [name, authorization, expected] of cases) {
      const mark = fake.commands.length
      const answer = await read(job.jid, undefined, authorization === undefined ? {} : { authorization })
      expect([name, answer.status, answer.body?.error?.code]).toEqual([name, 401, expected])
      expect(since(mark)).toEqual([])
    }
    expect(checks).toEqual([])
    live = "settled"
    const settled = await read(job.jid, good)
    expect([settled.status, settled.body?.error?.code]).toEqual([401, "MODEL_PLAN_RUN_EXPIRED"])
    live = "ok"
    const mark = fake.commands.length
    const posted = await read(job.jid, good, { method: "POST" })
    expect([posted.status, posted.body?.error?.code]).toEqual([405, "METHOD_NOT_ALLOWED"])
    expect(since(mark)).toEqual([])
    expect(checks).toHaveLength(1)
    expect(fake.read(marker(job))).toBeUndefined()
    expect((await read(job.jid, good)).status).toBe(200)
  })

  test("B8: a public repository's job, another repository's run, a GitHub job, a laptop record and an ended job get 404", async () => {
    const shared = await running(slackJob({ repository: { id: REPOSITORY, fullName: "acme/app", shared: true } }))
    const elsewhere = await running(slackJob(), runId(202))
    const github = await running(githubJob())
    const first: ReadonlyArray<readonly [string, Running]> = [
      ["a public repository's job (E11)", shared],
      ["a run of another repository", elsewhere],
      ["a GitHub job", github],
    ]
    for (const [name, job] of first) {
      const mark = fake.commands.length
      const answer = await read(job.jid, runToken(ALICE, job.rid))
      expect([name, answer.status, answer.body]).toEqual([name, 404, NOT_FOUND])
      expect(scripted(since(mark))).toEqual([])
      expect(fake.read(marker(job))).toBeUndefined()
    }
    for (const [, job] of first) expect((await cancelJob(ctx(), job.jid)).ok).toBe(true)

    // A record that says laptop, whatever else it names.
    const laptop = await running()
    const key = everywhereKeys.job(laptop.jid)
    fake.send([
      "SET",
      key,
      encodeJobRecord({ ...laptop.job, version: laptop.job.version + 1, route: "laptop" }),
      "PX",
      String(fake.pttl(key)),
    ])
    // A job that ended while its links survived (the end-of-job delete failed).
    const ended = await running()
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await cancelJob(ctx({ store: failing(store, unlink(ended)) }), ended.jid)).ok).toBe(true)
    } finally {
      errors.mockRestore()
    }
    expect(fake.read(everywhereKeys.run(ended.rid))?.value).toBe(ended.jid)
    for (const [name, job] of [
      ["a laptop record", laptop],
      ["an ended job", ended],
    ] as const) {
      const mark = fake.commands.length
      const answer = await read(job.jid, runToken(ALICE, job.rid))
      expect([name, answer.status, answer.body]).toEqual([name, 404, NOT_FOUND])
      expect(scripted(since(mark))).toEqual([])
      expect(fake.read(marker(job))).toBeUndefined()
    }
  })

  test("a formerly private job cannot be read until the repository is confirmed live private", async () => {
    const job = await running()
    const token = runToken(ALICE, job.rid)
    const refused: readonly NonNullable<BodyRouteDeps["visibility"]>[] = [
      async () => "public",
      async () => "internal",
      async () => undefined,
      async () => {
        throw new Error("Visibility unavailable")
      },
    ]
    for (const visibility of refused) {
      const mark = fake.commands.length
      const answer = await read(job.jid, token, { deps: { visibility } })
      expect([answer.status, answer.body]).toEqual([404, NOT_FOUND])
      expect(answer.text).not.toContain(TASK)
      expect(answer.text).not.toContain(CONTEXT_TEXT)
      expect(scripted(since(mark))).toEqual([])
      expect(fake.read(marker(job))).toBeUndefined()
    }
    expect((await read(job.jid, token)).status).toBe(200)
    expect((await read(job.jid, token)).status).toBe(410)
  })

  test("the body reads live GitHub App metadata for the signed account, repository and binding generation", async () => {
    await using fixture = await githubAppFixture()
    const { repositoryId, app, state } = fixture
    const repository = { id: Number(repositoryId), fullName: "fixture-owner/project", shared: false }
    const job = await running(slackJob({ repository }), runId(repository.id))
    const token = runToken(ALICE, job.rid)
    let fields = bindingFields({ repositoryId, account: ALICE })
    const binding = bindingStore(() => fields)
    const options = { deps: { visibility: createRunBodyVisibility({ store: binding.store, app }) } }
    const expectRefused = async () => {
      const mark = fake.commands.length
      const answer = await read(job.jid, token, options)
      expect([answer.status, answer.body]).toEqual([404, NOT_FOUND])
      expect(scripted(since(mark))).toEqual([])
      expect(fake.read(marker(job))).toBeUndefined()
    }

    state.repository.private = true
    state.repository.visibility = "private"
    for (const [field, value] of [
      ["account", BOB],
      ["generation", "2"],
      ["repository", "fixture-owner/other"],
    ] as const) {
      fields = bindingFields({ repositoryId, account: ALICE, with: { [field]: value } })
      await expectRefused()
    }
    expect(state.requests).toEqual([])
    fields = bindingFields({ repositoryId, account: ALICE })
    for (const [privateRepository, visibility] of [
      [false, "public"],
      [true, "internal"],
      [true, undefined],
      [true, "unknown"],
      [true, "public"],
      [false, "private"],
    ] as const) {
      state.repository.private = privateRepository
      state.repository.visibility = visibility
      await expectRefused()
    }

    state.repository.private = true
    state.repository.visibility = "private"
    state.enabled = false
    await expectRefused()
    state.enabled = true
    const answer = await read(job.jid, token, options)
    expect([answer.status, answer.body?.task]).toEqual([200, TASK])
    expect(fake.read(marker(job))).toBeDefined()
    expect(state.minted).toHaveLength(7)
    for (const mint of state.minted) {
      expect(mint.body.permissions).toEqual({ metadata: "read" })
      expect(mint.body.repository_ids).toEqual([repository.id])
    }
    expect(fixture.tokens.size).toBe(0)
  })

  test("a live visibility check cannot extend a run past its deadline", async () => {
    const job = await running()
    const deadline = fake.clock.now + MINUTE
    const answer = await read(job.jid, runToken(ALICE, job.rid, { dl: deadline }), {
      deps: {
        visibility: async () => {
          fake.clock.now = deadline
          return "private"
        },
      },
    })
    expect([answer.status, answer.body]).toEqual([404, NOT_FOUND])
    expect(fake.read(marker(job))).toBeUndefined()
  })

  test("B9: a body that is gone, or whose end the server's own clock has reached, gives 410 and sets no marker", async () => {
    const deleted = await running()
    fake.send(["DEL", everywhereKeys.jobBody(deleted.jid)])
    const gone = await read(deleted.jid, runToken(ALICE, deleted.rid))
    expect([gone.status, gone.body]).toEqual([410, GONE])
    expect(fake.read(marker(deleted))).toBeUndefined()

    const late = await running()
    const ends = late.job.bodyExpiresAt
    const mark = fake.commands.length
    const answer = await read(late.jid, runToken(ALICE, late.rid, { dl: ends + 45 * MINUTE }), {
      deps: { now: () => ends },
    })
    expect([answer.status, answer.body]).toEqual([410, GONE])
    expect(scripted(since(mark))).toEqual([])
    expect(fake.read(marker(late))).toBeUndefined()
    // The store still holds the body on its own clock: only the server's check refused it.
    expect(fake.read(everywhereKeys.jobBody(late.jid))).toBeDefined()
  })

  test("B10: a closed account or a removed platform link gives 404 and sets no marker", async () => {
    const job = await running()
    const token = runToken(ALICE, job.rid)
    const closings: ReadonlyArray<readonly [string, string]> = [
      ["the account closed here", everywhereKeys.accountClosed(ALICE)],
      ["the account's deletion tombstone", `vector:codium:test:tombstone:${ALICE}`],
    ]
    for (const [name, key] of closings) {
      fake.send(["SET", key, "1"])
      const answer = await read(job.jid, token)
      expect([name, answer.status, answer.body]).toEqual([name, 404, NOT_FOUND])
      expect(fake.read(marker(job))).toBeUndefined()
      fake.send(["DEL", key])
    }
    fake.send(["DEL", everywhereKeys.link(SLACK, "U0ALICE01")])
    const unlinked = await read(job.jid, token)
    expect([unlinked.status, unlinked.body]).toEqual([404, NOT_FOUND])
    expect(fake.read(marker(job))).toBeUndefined()
  })

  test("B15: a job whose platform is no longer listed gives 404 and spends no read", async () => {
    const job = await running()
    const token = runToken(ALICE, job.rid)
    const mark = fake.commands.length
    const removed = await read(job.jid, token, {
      deps: { env: { ...env, [ENV_NAMES.platforms]: "github,linear,jira" } },
    })
    expect([removed.status, removed.body]).toEqual([404, NOT_FOUND])
    expect(scripted(since(mark))).toEqual([])
    expect(fake.read(marker(job))).toBeUndefined()
    expect((await read(job.jid, token)).status).toBe(200)
  })

  test("B11: five reads at once give one 200 and four 410", async () => {
    const job = await running()
    const token = runToken(ALICE, job.rid)
    const answers = await Promise.all(Array.from({ length: 5 }, () => read(job.jid, token)))
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 410, 410, 410, 410])
    expect(answers.filter((answer) => answer.text.includes(TASK))).toHaveLength(1)
  })

  test("B12: no log line carries the body, its context or the label; a body that does not open answers 503 and stays spent", async () => {
    const spies = (["error", "warn", "log", "info"] as const).map((name) =>
      spyOn(console, name).mockImplementation(() => {}),
    )
    try {
      const job = await running()
      expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
      expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(410)
      expect((await read(createJobId(fake.clock.now), runToken(ALICE, job.rid))).status).toBe(404)
      expect((await read(job.jid, "vrt_invalid.signature")).status).toBe(401)
      live = "corrupt"
      expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(503)
      live = "ok"

      const damaged = await running()
      const body = everywhereKeys.jobBody(damaged.jid)
      fake.send(["SET", body, "ves1.damaged", "PX", String(fake.pttl(body))])
      const broken = await read(damaged.jid, runToken(ALICE, damaged.rid))
      expect([broken.status, broken.body?.error?.code]).toEqual([503, "PERSISTENT_STORE_UNAVAILABLE"])
      expect(fake.read(marker(damaged))?.value).toBe("1")
      expect((await read(damaged.jid, runToken(ALICE, damaged.rid))).status).toBe(410)

      expect((await cancelJob(ctx({ store: failing(store, unlink(job)) }), job.jid)).ok).toBe(true)
      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls))
      expect(logged).toContain("Vector everywhere: a jobs step failed")
      expect(logged).toContain("Vector cloud-agents run token check failed")
      for (const text of [TASK, CONTEXT_TEXT, "Safari", "redirect", "Alice", "U0ALICE01", "C0123"])
        expect(logged).not.toContain(text)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  test("B13: the route file exports its handler and reads no request body", () => {
    expect(typeof route).toBe("function")
    expect(config).toEqual({ api: { bodyParser: false } })
  })

  test("B14: a record that changed under the read is read again; one that keeps changing answers 503 busy, unspent", async () => {
    const job = await running()
    const once = await read(job.jid, runToken(ALICE, job.rid), { deps: { store: bumping(store, job.jid, 1) } })
    expect(once.status).toBe(200)
    const other = await running()
    const busy = await read(other.jid, runToken(ALICE, other.rid), { deps: { store: bumping(store, other.jid, 100) } })
    expect([busy.status, busy.body?.error?.code, busy.headers.get("retry-after")]).toEqual([
      503,
      "EVERYWHERE_BUSY",
      "2",
    ])
    expect(fake.read(marker(other))).toBeUndefined()
    expect((await read(other.jid, runToken(ALICE, other.rid))).status).toBe(200)
  })
})

describe("ending and erasing", () => {
  test("B7a: a cancel deletes the ticket, the run's link and its marker", async () => {
    const job = await running()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
    for (const key of links(job)) expect(fake.read(key)).toBeDefined()
    expect((await cancelJob(ctx(), job.jid)).ok).toBe(true)
    for (const key of links(job)) expect(fake.read(key)).toBeUndefined()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(404)
  })

  test("B7b: 900 s without a start, the sweep's failure deletes the ticket", async () => {
    const sent = await dispatched()
    fake.clock.advance(TIMING.dispatchStartMs)
    expect((await sweepDue(ctx())).map((entry) => [entry.job.jid, entry.job.state])).toEqual([[sent.jid, "failed"]])
    expect(fake.read(everywhereKeys.ticket(sent.hash))).toBeUndefined()
  })

  test("B7c: account erase deletes the links a failed end-of-job delete left", async () => {
    const job = await running()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await cancelJob(ctx({ store: failing(store, unlink(job)) }), job.jid)).ok).toBe(true)
      expect(errors.mock.calls).toEqual([
        [
          "Vector everywhere: a jobs step failed",
          { step: "unlink", jid: job.jid, code: "PERSISTENT_STORE_UNAVAILABLE" },
        ],
      ])
    } finally {
      errors.mockRestore()
    }
    for (const key of links(job)) expect(fake.read(key)).toBeDefined()
    await eraseAccountJobs({ store, keys: [], now: fake.clock.now, erasing: true }, ALICE)
    for (const key of [...links(job), everywhereKeys.job(job.jid)]) expect(fake.read(key)).toBeUndefined()
  })

  test("B7d: installation erase of a live linked job deletes its links, even when the cancel's own delete fails", async () => {
    const job = await running()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      await eraseInstallationJobs(
        { store: failing(store, unlink(job)), keys: [], now: fake.clock.now, erasing: true },
        SLACK,
      )
      expect(errors.mock.calls).toEqual([
        [
          "Vector everywhere: a jobs step failed",
          { step: "unlink", jid: job.jid, code: "PERSISTENT_STORE_UNAVAILABLE" },
        ],
      ])
    } finally {
      errors.mockRestore()
    }
    expect((await readJob(store, job.jid))?.state).toBe("cancelled")
    for (const key of [...links(job), everywhereKeys.jobBody(job.jid)]) expect(fake.read(key)).toBeUndefined()
  })

  test("B7e: an ended job's surviving links are left to account erase and to their TTL, which ends with the body", async () => {
    const job = await running()
    expect((await read(job.jid, runToken(ALICE, job.rid))).status).toBe(200)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect((await cancelJob(ctx({ store: failing(store, unlink(job)) }), job.jid)).ok).toBe(true)
    } finally {
      errors.mockRestore()
    }
    // The job left the installation's live index when it ended, so installation erase does not see it.
    await eraseInstallationJobs({ store, keys: [], now: fake.clock.now, erasing: true }, SLACK)
    for (const key of links(job)) expect(fake.read(key)).toBeDefined()
    fake.clock.now = job.job.bodyExpiresAt
    for (const key of links(job)) expect(fake.read(key)).toBeUndefined()
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })

  function on(platform: PlatformId) {
    return platformOn(readConfig(env), platform)
  }

  function realCtx(now = Date.now()): JobsContext {
    return {
      store: testEverywhereStore(redis.fetch),
      keys: readConfig(env).dataKeys,
      now,
      accountAuthority: testAccountAuthority,
    }
  }

  /** A running Actions job of a fresh sponsor and installation, created at `createdAt` and dispatched and started now. */
  async function realRunning(createdAt = Date.now()) {
    const sponsor = randomUUID()
    const input = slackJob({
      installation: `slack:T${randomBytes(10).toString("hex").toUpperCase()}`,
      sponsor,
      requester: { userId: "U0ALICE01", account: sponsor, label: LABEL },
    })
    await seedJobAuthority(realCtx(createdAt), input)
    const made = await createJob(realCtx(createdAt), input)
    if (!made.ok) throw new Error(`createJob refused: ${made.code}`)
    const hash = randomBytes(32).toString("base64url")
    expect((await dispatchJob(realCtx(), made.job.jid, { ticketHash: hash })).ok).toBe(true)
    const rid = runId()
    expect((await startDispatched(realCtx(), hash, rid)).ok).toBe(true)
    return { sponsor, jid: made.job.jid, hash, rid, job: made.job }
  }

  test("R1: twelve reads of one run that all read one version: exactly one gets the body", async () => {
    const job = await realRunning()
    const real = testEverywhereStore(redis.fetch)
    const gate = barrier(real, everywhereKeys.job(job.jid), 12)
    const input = {
      jid: job.jid,
      account: job.sponsor,
      rid: job.rid,
      repository: String(REPOSITORY),
      platformOn: on,
      isPrivate: async () => true,
    }
    const verdicts = await Promise.all(
      Array.from({ length: 12 }, () => readRunBody({ ...realCtx(), store: gate() }, input)),
    )
    expect(verdicts.filter((verdict) => verdict.ok)).toHaveLength(1)
    expect(verdicts.filter((verdict) => !verdict.ok && verdict.status === 410)).toHaveLength(11)
    const ttl = Number(await real(["PTTL", everywhereKeys.runBodyRead(job.rid)]))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(KEEP_MS.bodyRead)
  })

  test("R2: six route reads at once give one 200; the real TTLs end with the body; a cancel leaves no link", async () => {
    // Created 30 minutes ago, so a link kept for its own full life would outlive the body by 30 minutes.
    const job = await realRunning(Date.now() - 30 * MINUTE)
    const real = testEverywhereStore(redis.fetch)
    const remaining = job.job.bodyExpiresAt - Date.now()
    expect(remaining).toBeLessThan(KEEP_MS.ticket - 29 * MINUTE)
    for (const key of [everywhereKeys.ticket(job.hash), everywhereKeys.run(job.rid)]) {
      const ttl = Number(await real(["PTTL", key]))
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(remaining + 1_000)
    }
    const token = runToken(job.sponsor, job.rid, { dl: Date.now() + 45 * MINUTE })
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => read(job.jid, token, { deps: { store: real, now: () => Date.now() } })),
    )
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 410, 410, 410, 410, 410])
    // Read the body's life first: the marker was set to it, so it can only be shorter or equal by now.
    const body = Number(await real(["PTTL", everywhereKeys.jobBody(job.jid)]))
    const kept = Number(await real(["PTTL", marker(job)]))
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThanOrEqual(body)
    expect((await cancelJob(realCtx(), job.jid)).ok).toBe(true)
    expect(
      Number(await real(["EXISTS", everywhereKeys.ticket(job.hash), everywhereKeys.run(job.rid), marker(job)])),
    ).toBe(0)
  })

  test("R3: a body that is gone gives 410 and leaves no marker", async () => {
    const job = await realRunning()
    const real = testEverywhereStore(redis.fetch)
    expect(Number(await real(["DEL", everywhereKeys.jobBody(job.jid)]))).toBe(1)
    const input = {
      jid: job.jid,
      account: job.sponsor,
      rid: job.rid,
      repository: String(REPOSITORY),
      platformOn: on,
      isPrivate: async () => true,
    }
    expect(await readRunBody(realCtx(), input)).toEqual({ ok: false, status: 410, code: "EVERYWHERE_BODY_GONE" })
    expect(Number(await real(["EXISTS", marker(job)]))).toBe(0)
  })
})
