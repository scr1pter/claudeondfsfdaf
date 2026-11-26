import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { branchFor } from "../../core/src/everywhere/publish"
import { createHandoffBinding, createHandoffVerifier } from "../../../api/_lib/everywhere/adapters/cloud-agents"
import { ENV_NAMES, readConfig } from "../../../api/_lib/everywhere/config"
import { createJobEvents, postPending } from "../../../api/_lib/everywhere/events"
import {
  createGithubAdapter,
  createGithubHandoff,
  type GithubHandoffBinding,
} from "../../../api/_lib/everywhere/github/adapter"
import type { GithubStatusPort } from "../../../api/_lib/everywhere/github/status"
import { claimJob, openSummary, readJob, reportJob, settleJob } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { offerPublicKey, offerVerifyKey, verifyOffer } from "../../../api/_lib/everywhere/offer"
import type { Ports } from "../../../api/_lib/everywhere/ports"
import { productionHandoffDeps, productionPorts } from "../../../api/_lib/everywhere/runtime"
import type { Store } from "../../../api/_lib/everywhere/store"
import { createGithubOidcVerifier, githubOidcJwks, type GithubOidcPurpose } from "../../../api/_lib/github-oidc"
import type { ApiRequest, ApiResponse } from "../../../api/_lib/http"
import { fromUtf8 } from "../../../packages/relay/src/bytes"
import { DEVICE_BYTES, FRAME, decodeFrame } from "../../../packages/relay/src/protocol"
import { TIMING } from "../../../packages/schema/src/everywhere"
import { githubAppFixture } from "./github-app-fixture"
import { everywhereEnv } from "./lib/everywhere-account"
import { installJourney, journeyPorts } from "./lib/everywhere-journey"
import { routerFixture } from "./lib/everywhere-router"
import { realRedis, testEverywhereStore, type RealRedis } from "./lib/everywhere-store"

/*
 * VE-31 (EV-31, R-A5): the GitHub handoff with its real verifier. Tokens are live-shaped, signed by @vector's App fixture
 * (packages/web/test/github-app-fixture.ts) and verified by the real createGithubOidcVerifier against the fixture's
 * loopback JWKS; the binding is the real createHandoffBinding over @vector's real binding decoder behind a stub of
 * @vector's store. The binder's computer is EV-09's fake relay: the relay Worker on loopback under the real relay adapter
 * (lib/everywhere-journey.ts). Nothing leaves loopback: installJourney arms the fetch guard for the whole file.
 */

const journey = installJourney([])
const ROUTE = "/api/everywhere/github/handoff"
const SHA = "a".repeat(40)
const WORKFLOW_REF = "fixture-owner/project/.github/workflows/vector.yml@refs/heads/main"
const BODY = { kind: "issue", issue: 7, commentId: 99, thread: "fixture-owner/project#7", workflowVersion: "3" }
/** A review comment's claims: the pull request's merge ref, whose workflow its author controls. */
const REVIEW = {
  event_name: "pull_request_review_comment",
  ref: "refs/pull/12/merge",
  workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/pull/12/merge",
  sub: "repo:fixture-owner/project:pull_request",
  head_ref: "feature",
  base_ref: "main",
}

let app: Awaited<ReturnType<typeof githubAppFixture>>
beforeAll(async () => {
  app = await githubAppFixture()
})
afterAll(async () => {
  await app[Symbol.asyncDispose]()
})

/**
 * The claims a GitHub-hosted issue_comment run carries beyond the fixture's: the runner, visibility and protection
 * claims, the run number and workflow name, empty head and base refs, and job-workflow claims naming the workflow
 * itself, as a top-level workflow's do.
 */
function live(change: Record<string, unknown> = {}) {
  const claims = {
    runner_environment: "github-hosted",
    repository_visibility: "private",
    ref_protected: "true",
    run_number: "12",
    workflow: "Vector",
    head_ref: "",
    base_ref: "",
    workflow_ref: WORKFLOW_REF,
    workflow_sha: SHA,
    ...change,
  }
  return { ...claims, job_workflow_ref: claims.workflow_ref, job_workflow_sha: claims.workflow_sha }
}

const token = (change: Record<string, unknown> = {}, purpose: GithubOidcPurpose = "handoff") =>
  app.makeToken(purpose, live(change))

/** @vector's store for bindingFor's one READ: the hash REDEEM writes, so @vector's real decoder runs. */
function vectorBindings(fields: () => Record<string, string> | undefined) {
  const reads: string[] = []
  const store = async (command: readonly (string | number)[]) => {
    expect(command[0]).toBe("EVAL")
    reads.push(String(command[3]))
    const value = fields()
    return [value ? Object.entries(value).flat() : []]
  }
  return { store, reads }
}

/** The stored binding of the fixture's repository: bound by person 789 under owner 456, Codium mode, with the App. */
function stored(account: string, change: Record<string, string> = {}) {
  return {
    repositoryId: app.repositoryId,
    ownerId: "456",
    repository: "fixture-owner/project",
    account,
    visibility: "private",
    defaultRef: "refs/heads/main",
    generation: "1",
    binderGithubId: "789",
    binderLogin: "fixture-person",
    workflowVersion: "3",
    boundAt: String(Date.now()),
    installationId: "600",
    workflowMode: "codium",
    ...change,
  }
}

type BindingPort = (repositoryId: number) => Promise<GithubHandoffBinding | undefined>
type Route = (request: ApiRequest, response: ApiResponse) => Promise<void>

/**
 * The route as Vercel's Node runtime calls it, with the body already read into `request.body` (the route file sets no
 * bodyParser option), which readJson takes as it is. Under Bun's node:http a body the route never reads (every refusal
 * answers before it) keeps the harness's connection open after an await, and the server could then never close.
 */
const vercelBody =
  (route: Route): Route =>
  async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString("utf8")
    if (body !== "") Object.assign(request, { body })
    await route(request, response)
  }

/** laptopFirst on, as R-A6's option would set it; production's binding (unwrapped) says false until Q13. */
const laptop =
  (port: BindingPort): BindingPort =>
  async (repositoryId) => {
    const binding = await port(repositoryId)
    return binding && { ...binding, laptopFirst: true }
  }

function world(
  options: {
    readonly fields?: (account: string) => Record<string, string>
    readonly production?: boolean
    readonly store?: Store
    readonly verify?: Parameters<typeof createHandoffVerifier>[0]
  } = {},
) {
  const f = routerFixture({ store: options.store })
  const bindings = vectorBindings(() => (options.fields ?? stored)(f.account))
  const port = createHandoffBinding({ store: bindings.store })
  const binding = options.production ? port : laptop(port)
  const route = (change: { readonly ports?: Ports; readonly sleep?: (ms: number) => Promise<void> } = {}) =>
    createGithubHandoff({
      verify: createHandoffVerifier(options.verify ?? { verify: app.verify }),
      binding,
      config: () => ({ ...f.config, platforms: new Set(["github"] as const) }),
      context: f.context,
      ports: change.ports ?? f.ports,
      now: () => f.fake.clock.now,
      sleep: change.sleep ?? f.routing.sleep,
    })
  const call = async (bearer: string | undefined, body: unknown = BODY, change: Parameters<typeof route>[0] = {}) => {
    journey.harness.mount({ [ROUTE]: vercelBody(route(change)) })
    return journey.harness.call("POST", ROUTE, { body, ...(bearer ? { token: bearer } : {}) })
  }
  const offers = () => f.calls.filter((call) => call.kind === "offer").length
  const jobs = () => f.fake.sorted(everywhereKeys.jobs(f.account))
  return { f, bindings, call, offers, jobs }
}

/** The binder's computer, as the fixture's offer port: it claims the offered job and reports `started`. */
function claimingComputer(w: ReturnType<typeof world>) {
  const claimed: { jid: string; lease: string }[] = []
  w.f.ports.offer = async () => {
    const jid = w.jobs()[0]!
    const claim = await claimJob(w.f.context(), { account: w.f.account, jid, device: w.f.computer })
    if (!claim.ok) throw new Error("Fixture claim failed")
    await reportJob(w.f.context(), {
      account: w.f.account,
      device: w.f.computer,
      report: { jid, lease: claim.job.lease.id, seq: 0, milestone: "started" },
    })
    claimed.push({ jid, lease: claim.job.lease.id })
    return "sent"
  }
  return claimed
}

describe("the handoff verifier (R-A5)", () => {
  test("V1: a live-shaped token maps to the handoff identity with one JWKS read", async () => {
    const reads: string[] = []
    const verify = createHandoffVerifier({
      verify: createGithubOidcVerifier((url, init) => {
        reads.push(url)
        return app.request(url, init)
      }),
    })
    expect(await verify(await token())).toEqual({
      repositoryId: Number(app.repositoryId),
      repository: "fixture-owner/project",
      ownerId: 456,
      actorId: 789,
      runId: 1000,
      runAttempt: 1,
      eventName: "issue_comment",
      ref: "refs/heads/main",
      repositoryVisibility: "private",
    })
    expect(await verify(await token(REVIEW))).toMatchObject({
      eventName: "pull_request_review_comment",
      ref: "refs/pull/12/merge",
    })
    expect(await verify(await token({ repository_visibility: undefined }))).not.toHaveProperty("repositoryVisibility")
    expect(reads).toEqual([githubOidcJwks])
  })

  test("V2: dispatch, schedule, other audiences, runners, bots, workflows and expiry are refused before any read", async () => {
    const now = Math.floor(Date.now() / 1000)
    const cases: Array<[string, Promise<string>, number, string]> = [
      ["workflow_dispatch", token({ event_name: "workflow_dispatch" }), 403, "EVENT_NOT_ALLOWED"],
      ["schedule", token({ event_name: "schedule" }), 403, "EVENT_NOT_ALLOWED"],
      ["signed for mint", token({}, "mint"), 401, "OIDC_INVALID"],
      ["signed for token", token({}, "token"), 401, "OIDC_INVALID"],
      ["signed for installation", token({}, "installation"), 401, "OIDC_INVALID"],
      ["signed for bind", token({}, "bind"), 401, "OIDC_INVALID"],
      ["a self-hosted runner", token({ runner_environment: "self-hosted" }), 403, "RUNNER_NOT_SUPPORTED"],
      ["no runner claim", token({ runner_environment: undefined }), 401, "OIDC_INVALID"],
      ["a bot", token({ actor: "vector-fixture[bot]" }), 401, "OIDC_INVALID"],
      [
        "another workflow file",
        token({ workflow_ref: WORKFLOW_REF.replace("vector.yml", "evil.yml") }),
        403,
        "WORKFLOW_NOT_TRUSTED",
      ],
      ["expired", token({ iat: now - 400, nbf: now - 400, exp: now - 1 }), 401, "OIDC_INVALID"],
    ]
    for (const [label, signed, status, code] of cases) {
      const w = world()
      const answer = await w.call(await signed)
      expect([label, answer.status, answer.body]).toEqual([label, status, { error: { code } }])
      expect([label, w.f.fake.commands, w.bindings.reads, w.offers(), journey.actions]).toEqual([label, [], [], 0, []])
    }
  })

  test("V3: a re-run verifies, then hands back with no binding read", async () => {
    const w = world()
    expect((await w.call(await token({ run_attempt: "2" }))).body).toEqual({ handled: false })
    expect([w.bindings.reads, w.f.fake.commands, w.offers()]).toEqual([[], [], 0])
  })

  test("V4: a verifier that answers another audience's identity is refused", async () => {
    const mint = await app.makeToken("mint", live())
    const w = world({ verify: { verify: async () => app.verify(mint, "mint") } })
    const answer = await w.call(await token())
    expect([answer.status, answer.body]).toEqual([401, { error: { code: "OIDC_INVALID" } }])
    expect([w.bindings.reads, w.f.fake.commands]).toEqual([[], []])
  })

  test("V5: any other verifier failure is GITHUB_UNAVAILABLE, never HANDOFF_UNCERTAIN", async () => {
    const w = world({
      verify: {
        verify: async () => {
          throw new Error("Fixture verifier failure")
        },
      },
    })
    const answer = await w.call(await token())
    expect([answer.status, answer.body]).toEqual([503, { error: { code: "GITHUB_UNAVAILABLE" } }])
    expect([w.bindings.reads, w.f.fake.commands]).toEqual([[], []])
  })
})

describe("the binding and the mint's route rules", () => {
  test("B1: a non-binder's handoff hands back after one binding read", async () => {
    const w = world()
    expect((await w.call(await token({ actor_id: "790" }))).body).toEqual({ handled: false })
    expect([w.bindings.reads.length, w.f.fake.commands, w.offers(), w.jobs()]).toEqual([1, [], 0, []])
  })

  test("B2: a production binding (laptopFirst false) hands back the binder's own handoff", async () => {
    const w = world({ production: true })
    expect((await w.call(await token())).body).toEqual({ handled: false })
    expect([w.bindings.reads.length, w.f.fake.commands, w.offers(), w.jobs()]).toEqual([1, [], 0, []])
    expect(w.f.fake.read(everywhereKeys.handoff(Number(app.repositoryId), 1000))).toBeUndefined()
  })

  test("B3: another owner and a ref that is not the default ref hand back", async () => {
    const changes: Record<string, string>[] = [{ ownerId: "455" }, { defaultRef: "refs/heads/release" }]
    for (const change of changes) {
      const w = world({ fields: (account) => stored(account, change) })
      expect([change, (await w.call(await token())).body]).toEqual([change, { handled: false }])
      expect([change, w.bindings.reads.length, w.f.fake.commands, w.offers()]).toEqual([change, 1, [], 0])
    }
  })

  test("B4: a review comment hands back before the binding is read, even the binder's on its own pull request", async () => {
    const w = world()
    const body = {
      kind: "pr",
      issue: 12,
      pr: 12,
      commentId: 99,
      thread: "fixture-owner/project#12",
      workflowVersion: "3",
    }
    expect((await w.call(await token(REVIEW), body)).body).toEqual({ handled: false })
    expect([w.bindings.reads, w.f.fake.commands, w.offers(), w.jobs()]).toEqual([[], [], 0, []])
  })

  test("B5: an issues handoff needs its body hash: without it 400 and nothing kept, with it offered", async () => {
    const w = world()
    const claimed = claimingComputer(w)
    const body = { kind: "issue", issue: 7, thread: "fixture-owner/project#7", workflowVersion: "3" }
    const refused = await w.call(await token({ event_name: "issues" }), body)
    expect([refused.status, refused.body]).toEqual([400, { error: { code: "HANDOFF_INVALID" } }])
    expect([w.jobs(), w.f.fake.read(everywhereKeys.handoff(Number(app.repositoryId), 1000)), claimed]).toEqual([
      [],
      undefined,
      [],
    ])
    const bodySha256 = "b".repeat(64)
    const accepted = await w.call(await token({ event_name: "issues" }), { ...body, bodySha256 })
    expect(accepted.body).toMatchObject({ handled: true })
    expect((await readJob(w.f.store, accepted.body.jid))?.github).toEqual({
      kind: "issue",
      number: 7,
      actorId: 789,
      event: "issues",
      bodySha256,
    })
    expect(claimed).toHaveLength(1)
  })
})

describe("shared follows the token's signed visibility", () => {
  test.each([
    ["private", false],
    ["public", true],
    ["internal", true],
    [undefined, true],
  ] as const)("S1: repository_visibility %p gives shared %p", async (visibility, shared) => {
    const w = world()
    claimingComputer(w)
    const answer = await w.call(await token({ repository_visibility: visibility }))
    expect(answer.body).toMatchObject({ handled: true })
    const job = await readJob(w.f.store, answer.body.jid)
    expect([job?.shared, job?.repository.shared, job?.state]).toEqual([shared, shared, "running"])
  })
})

/** The binder's computer on EV-09's fake relay: it decodes the offer frame and verifies it against the pinned key. */
async function relayWorld(store?: Store) {
  const w = world({ store })
  const computer = await journey.relay().computer({ sub: w.f.account })
  journey.seedPlan(w.f.account)
  const relayed = journeyPorts(journey, { config: w.f.config, ports: w.f.ports, account: w.f.account })
  const sent: Promise<unknown>[] = []
  const ports: Ports = {
    ...relayed,
    offer: (account, offer) => {
      const delivery = relayed.offer(account, offer)
      sent.push(delivery)
      return delivery
    },
  }
  const key = w.f.context().offer
  if (!key) throw new Error("The router fixture signs offers.")
  const pinned = offerPublicKey(key)
  const used = new Set<string>()
  const frames = () =>
    computer.socket.frames().map((frame) => {
      const decoded = decodeFrame(frame)
      return { kind: decoded?.kind, device: decoded?.device, text: decoded ? fromUtf8(decoded.ciphertext) : undefined }
    })
  const verified = async () => {
    const [frame, ...rest] = frames()
    expect([frame?.kind, frame?.device, rest]).toEqual([FRAME.JOB_OFFER, new Uint8Array(DEVICE_BYTES), []])
    const verdict = await verifyOffer(frame!.text, {
      keys: new Map([[pinned.kid, offerVerifyKey(pinned.publicKey)]]),
      account: w.f.account,
      now: w.f.fake.clock.now,
      useJti: async (jti) => {
        if (used.has(jti)) return false
        used.add(jti)
        return true
      },
    })
    if (!verdict.ok) throw new Error(`The offer was refused: ${verdict.reason}`)
    return verdict.claims.jid
  }
  return { ...w, ports, sent, frames, verified }
}

/** The route's poll: the computer claims and reports `started` on the first sleep, then the server's clock moves on. */
function claimOnFirstSleep(r: Awaited<ReturnType<typeof relayWorld>>) {
  const state: { jid?: string; lease?: string; slept: number[] } = { slept: [] }
  const sleep = async (ms: number) => {
    await Promise.allSettled(r.sent)
    if (!state.jid) {
      const jid = await r.verified()
      const claim = await claimJob(r.f.context(), { account: r.f.account, jid, device: r.f.computer })
      if (!claim.ok) throw new Error("Fixture claim failed")
      await reportJob(r.f.context(), {
        account: r.f.account,
        device: r.f.computer,
        report: { jid, lease: claim.job.lease.id, seq: 0, milestone: "started" },
      })
      state.jid = jid
      state.lease = claim.job.lease.id
    }
    state.slept.push(ms)
    r.f.fake.clock.advance(ms)
  }
  return { state, sleep }
}

async function expectClaimedWithinWindow(r: Awaited<ReturnType<typeof relayWorld>>) {
  const computer = claimOnFirstSleep(r)
  const start = r.f.fake.clock.now
  const answer = await r.call(await token(), BODY, { ports: r.ports, sleep: computer.sleep })
  expect(answer.body).toEqual({ handled: true, jid: computer.state.jid })
  expect(r.f.fake.clock.now - start).toBeLessThanOrEqual(TIMING.offerWindowMs)
  expect(journey.actions).toEqual(["presence", "job-offer"])
  const job = await readJob(r.f.store, computer.state.jid!)
  expect([job?.state, job?.platform, job?.github]).toEqual([
    "running",
    "github",
    { kind: "issue", number: 7, commentId: 99, actorId: 789, event: "issue_comment" },
  ])
  // The same run again: the dedupe key hands it back with no second offer.
  expect((await r.call(await token(), BODY, { ports: r.ports, sleep: computer.sleep })).body).toEqual({
    handled: false,
  })
  expect(journey.actions).toEqual(["presence", "job-offer"])
  return computer.state
}

describe("the binder's computer over the fake relay (EV-09)", () => {
  test("R1: the binder's computer is offered the job and claims it within 20 s", async () => {
    await expectClaimedWithinWindow(await relayWorld())
  })

  test("R2: an online computer that never claims is handed back at exactly 20 s, and the job is refused", async () => {
    const r = await relayWorld()
    const sleep = async (ms: number) => {
      await Promise.allSettled(r.sent)
      r.f.fake.clock.advance(ms)
    }
    const start = r.f.fake.clock.now
    expect((await r.call(await token(), BODY, { ports: r.ports, sleep })).body).toEqual({ handled: false })
    expect(r.f.fake.clock.now - start).toBe(TIMING.offerWindowMs)
    const job = await readJob(r.f.store, await r.verified())
    expect([job?.state, job?.code, journey.actions]).toEqual(["refused", "no-place", ["presence", "job-offer"]])
  })

  describe("on a real Redis", () => {
    let redis: RealRedis | undefined
    beforeAll(async () => {
      redis = await realRedis()
    })
    afterAll(async () => {
      await redis?.close()
    })
    test.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("R3: R1 on Valkey", async () => {
      await expectClaimedWithinWindow(await relayWorld(testEverywhereStore(redis!.fetch)))
    })
  })
})

/** R-C5's App status port, capturing what would be posted. */
function capturingStatus() {
  const posted: string[] = []
  const port: GithubStatusPort = {
    findOwnComment: async () => undefined,
    comment: async (_repository, _issue, body) => {
      posted.push(body)
      return { id: 700 }
    },
    editComment: async (_repository, _id, body) => {
      posted.push(body)
    },
  }
  return { port, posted }
}

describe("the result a computer with no GitHub login or pull request settles", () => {
  test.each([
    ["private", "changes"],
    ["public", "held"],
  ] as const)("J1: a %s repository's job settled %s", async (visibility, outcome) => {
    const w = world()
    const claimed = claimingComputer(w)
    const answer = await w.call(await token({ repository_visibility: visibility }))
    expect(answer.body).toMatchObject({ handled: true })
    const jid = answer.body.jid as string
    const branch = branchFor(jid)
    const summary = "Fixed the retry count in the login handler."
    // As the runner settles a pushed branch whose pull request could not be opened, or a shared job it kept local.
    const settled = await settleJob(w.f.context(), {
      account: w.f.account,
      device: w.f.computer,
      settle: {
        jid,
        lease: claimed[0]!.lease,
        outcome,
        summary,
        branch,
        checks: "skipped",
        ...(outcome === "changes" ? { headSha: "c".repeat(40), files: 1 } : {}),
      },
    })
    expect(settled.ok).toBe(true)
    const job = await readJob(w.f.store, jid)
    const status = capturingStatus()
    // events.ts builds every hook, so `settled` is always there; JobEvents types the hooks as optional.
    await createJobEvents(w.f.context, {
      github: createGithubAdapter({ context: w.f.context, status: status.port }),
    }).settled?.(job!)
    expect(status.posted).toHaveLength(1)
    const text = status.posted[0]!
    expect(text).toContain(`<!-- vector:job ${jid} -->`)
    expect(text).not.toContain("/pull/")
    if (outcome === "changes") {
      expect(text).toContain(`The changes are on the branch \`${branch}\`.`)
      expect(text).toContain(summary)
      return
    }
    expect(text).not.toContain(branch)
    expect(text).not.toContain(summary)
  })

  test("an owned terminal job keeps its summary and outbox entry until the status port delivers", async () => {
    const w = world()
    const claimed = claimingComputer(w)
    const answer = await w.call(await token({ repository_visibility: "private" }))
    expect(answer.body).toMatchObject({ handled: true })
    const jid = answer.body.jid as string
    const summary = "Reviewed the retry count in the login handler."
    const settled = await settleJob(w.f.context(), {
      account: w.f.account,
      device: w.f.computer,
      settle: { jid, lease: claimed[0]!.lease, outcome: "no-changes", summary },
    })
    if (!settled.ok) throw new Error("The fixture did not settle")
    const score = () => w.f.store(["ZSCORE", everywhereKeys.jobsPosts(), jid])
    const retained = async () => {
      const job = await readJob(w.f.store, jid)
      expect(job).toBeDefined()
      return openSummary(w.f.context(), job!)
    }
    const missing = { github: createGithubAdapter({ context: w.f.context }) }
    expect(await score()).not.toBeNull()
    expect(await retained()).toBe(summary)
    const failure = await createJobEvents(w.f.context, missing).settled!(settled.job).catch((error: unknown) => error)
    expect([await score(), await retained()]).toEqual([String(w.f.fake.clock.now + 60_000), summary])
    expect(failure).toMatchObject({
      statusCode: 503,
      code: "GITHUB_STATUS_UNAVAILABLE",
      message: "GitHub status delivery is unavailable.",
    })
    w.f.fake.clock.advance(60_000)
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await postPending(w.f.context, missing)).toBe(0)
      expect(log.mock.calls).toEqual([
        ["Vector everywhere: a queued reply failed", { jid, code: "post-failed" }],
      ])
    } finally {
      log.mockRestore()
    }
    expect(await score()).toBe(String(w.f.fake.clock.now + 60_000))
    expect(await retained()).toBe(summary)

    w.f.fake.clock.advance(60_000)
    const status = capturingStatus()
    const available = { github: createGithubAdapter({ context: w.f.context, status: status.port }) }
    expect(await postPending(w.f.context, available)).toBe(1)
    expect(status.posted).toHaveLength(1)
    expect(status.posted[0]).toContain(summary)
    expect(status.posted[0]).toContain(`<!-- vector:job ${jid} -->`)
    expect(await score()).toBeNull()
    expect(await retained()).toBeUndefined()
    expect(await postPending(w.f.context, available)).toBe(0)
    expect(status.posted).toHaveLength(1)
  })
})

describe("production wiring", () => {
  test("P1: with the flag off there are no handoff deps, and the route answers 501 before any read", async () => {
    const deps = productionHandoffDeps(readConfig({}))
    expect(deps).toEqual({})
    const before = app.state.requests.length
    journey.harness.mount({ [ROUTE]: vercelBody(createGithubHandoff(deps)) })
    const answer = await journey.harness.call("POST", ROUTE, { body: BODY, token: await token() })
    expect([answer.status, answer.body]).toEqual([501, { error: { code: "HANDOFF_UNAVAILABLE" } }])
    expect(app.state.requests.length).toBe(before)
  })

  test("P2: the route file is wired, so with GitHub unlisted at request time it answers 404, not 501", async () => {
    // The flag on only while the route file loads (productionHandoffDeps reads it then); off again at request time.
    // process.env is the only way in: handoff.ts builds its deps from readConfig() at load and takes no argument, and
    // only this case catches a route file that passes none (M17). `saved` holds every key everywhereEnv sets.
    const env = { ...everywhereEnv(""), [ENV_NAMES.enabled]: "true" }
    const saved = Object.keys(env).map((name) => [name, process.env[name]] as const)
    expect(readConfig().enabled).toBe(false)
    const loaded = await (async () => {
      try {
        Object.assign(process.env, env)
        return await import("../../../api/everywhere/github/handoff")
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) {
            delete process.env[name]
            continue
          }
          process.env[name] = value
        }
      }
    })()
    expect(readConfig().enabled).toBe(false)
    const before = app.state.requests.length
    journey.harness.mount({ [ROUTE]: vercelBody(loaded.default) })
    const answer = await journey.harness.call("POST", ROUTE, { body: BODY, token: await token() })
    expect([answer.status, answer.body]).toEqual([404, { error: { code: "EVERYWHERE_OFF" } }])
    expect(app.state.requests.length).toBe(before)
  })

  test("P3: with the flag on, the deps are the verifier, the binding and productionPorts' ports", () => {
    const config = readConfig(everywhereEnv())
    const deps = productionHandoffDeps(config)
    expect(Object.keys(deps).sort()).toEqual(["binding", "ports", "verify"])
    expect([typeof deps.verify, typeof deps.binding]).toEqual(["function", "function"])
    expect(Object.keys(deps.ports ?? {}).sort()).toEqual(Object.keys(productionPorts(config)).sort())
  })
})
