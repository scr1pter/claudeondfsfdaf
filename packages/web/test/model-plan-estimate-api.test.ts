import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { codiumKey } from "../../../api/_lib/codium-keys"
import { drainOutbox } from "../../../api/_lib/codium-provision"
import { readModelPlanAccount, reconcileModelPlanAccount } from "../../../api/_lib/model-plan-account"
import { createRunVerifierRegistry } from "../../../api/_lib/model-plan-caller"
import type { ModelPlanCatalogOptions } from "../../../api/_lib/model-plan-catalog-policy"
import {
  ESTIMATE_BANDS,
  estimateAnswer,
  estimateBand,
  estimateStep,
  handleModelPlanEstimate,
} from "../../../api/_lib/model-plan-estimate"
import {
  codiumFakes,
  codiumTestEnvironment,
  loadStripeFixture,
  type CodiumFakes,
  type StripeFixture,
} from "./fixture/codium-fakes"

// The estimate API (§4.13, model form): a band of the month and of today's limit, never an amount (P1), and nothing a
// search over its inputs could use to find the pool finer than one 1.5× step (P2). Stripe, OpenRouter and the store
// are the in-memory fakes of fixture/codium-fakes.ts; nothing here reaches a real service.
const SECRET = "fixture-cli-token-secret-that-is-long-enough"
const DAY = 86_400_000
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"
const KIMI = "moonshotai/kimi-k3.1-pro"
const BANDS = [...ESTIMATE_BANDS.map(([, name]) => name), "over 40%", "more than your month"]
const served: ModelPlanCatalogOptions = { qualify: () => true }

const current: { fetcher: typeof fetch; options: ModelPlanCatalogOptions } = { fetcher: fetch, options: served }
const server = createServer(
  (request, response) => void handleModelPlanEstimate(request, response, current.fetcher, current.options),
)
const origin = { url: "" }
let restore = () => {}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  restore = codiumTestEnvironment({
    VECTOR_CLI_TOKEN_SECRET: SECRET,
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    // The rest of a complete billing configuration, which every Codium route checks first.
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_estimate_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_estimate_fixture",
  })
  current.options = served
})
afterEach(() => {
  restore()
  setSystemTime()
})
afterAll(() => server.close())

/**
 * A Plus account (4 USD of fixture allowance, a quarter a day) with its snapshot and key, at the fixture's moment; or
 * another fixture's account, its Stripe objects first changed by `prepare`.
 */
async function plus(fixtureName = "active-paid", prepare: (fixture: StripeFixture) => void = () => {}) {
  const fixture = loadStripeFixture(fixtureName)
  prepare(fixture)
  const now = fixture.now * 1000
  setSystemTime(new Date(now))
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  const id = fixture.accountId
  fakes.store.set(codiumKey("account", id), JSON.stringify(fixture.account))
  await reconcileModelPlanAccount(id, fakes.fetcher, now)
  fakes.stripe.calls.length = 0
  fakes.openRouter.calls.length = 0
  current.fetcher = fakes.fetcher
  return { fixture, fakes, id, token: mintCliToken({ id, email: "fixture@example.test" }, now, "desktop").token }
}

const estimate = async (body: unknown, token: string) => {
  const response = await fetch(`${origin.url}/api/model-plans/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
const estimateKeys = (fakes: CodiumFakes) => fakes.store.keys().filter((key) => key.includes(":estimate:"))

describe("bands and steps", () => {
  test("each share falls in one band, its lower edge inclusive", () => {
    const table: [number, string][] = [
      [0, "under 1%"],
      [0.0099, "under 1%"],
      [0.01, "1–2%"],
      [0.0199, "1–2%"],
      [0.02, "2–5%"],
      [0.05, "5–10%"],
      [0.1, "10–20%"],
      [0.2, "20–40%"],
      [0.3999, "20–40%"],
      [0.4, "over 40%"],
      [1, "over 40%"],
      [1.0001, "more than your month"],
      [Infinity, "more than your month"],
    ]
    for (const [share, band] of table) expect(estimateBand(share)).toBe(band)
  })

  test("every count inside one 1.5× step gives the same cost step, and the cost itself is put on the grid", () => {
    const price = { inputPrice: 0.3, outputPrice: 1.2 }
    // Within a step: from just above the step below up to the step's own value.
    for (let step = 1; step <= 30; step++) {
      const low = Math.floor(1.5 ** (step - 1)) + 1
      const high = Math.floor(1.5 ** step)
      if (low > high) continue
      const at = (inputTokens: number) => estimateStep({ inputTokens, outputTokens: 0, requests: 1, ...price })
      expect(at(low)).toBe(at(high))
      expect(at(Math.floor((low + high) / 2))).toBe(at(high))
    }
    // Combinations of units never land between steps: the cost a request makes is rounded up to the grid as well.
    const random = (limit: number) => Math.floor(Math.random() * limit)
    for (let index = 0; index < 500; index++) {
      const step = estimateStep({
        inputTokens: random(300_000),
        outputTokens: random(40_000),
        requests: 1 + random(100),
        inputPrice: 0.1 + Math.random() * 5,
        outputPrice: 0.1 + Math.random() * 20,
      })
      expect(Number.isInteger(step)).toBe(true)
    }
  })

  test("P2: any two pools within one 1.5× step get the same answer to every question", () => {
    // An attacker who may ask at every cost step, with every daily share, learns which step the pool is in and nothing
    // finer: pools a fraction of a step apart answer identically, so a binary search stops at one step.
    for (let trial = 0; trial < 200; trial++) {
      const base = 1.5 ** (20 + Math.floor(Math.random() * 30))
      const first = Math.ceil(base * (1 + Math.random() * 0.49))
      const second = Math.ceil(base * (1 + Math.random() * 0.49))
      for (let step = 0; step <= 90; step++)
        for (const daily of [0.25, 0.4, null])
          expect(estimateAnswer(step, first, daily)).toEqual(estimateAnswer(step, second, daily))
    }
    // One step apart, some question tells them apart: the resolution is one step, not coarser.
    const pool = 1.5 ** 37
    const differs = Array.from({ length: 91 }, (_, step) => step).some(
      (step) => estimateAnswer(step, pool, null).share !== estimateAnswer(step, pool * 1.5, null).share,
    )
    expect(differs).toBe(true)
  })
})

describe("the route", () => {
  test("answers bands of the month and of today, with no amount, from the snapshot alone", async () => {
    const { fakes, token } = await plus()
    // 100 requests of 50,000 tokens in and 2,000 out on DeepSeek, against a Plus month (a quarter of it a day).
    const answer = await estimate({ model: DEEPSEEK, inputTokens: 50_000, outputTokens: 2_000, requests: 100 }, token)
    expect(answer).toEqual({ status: 200, body: { share: "over 40%", todayShare: "more than your month" } })
    expect(await estimate({ model: DEEPSEEK, inputTokens: 0, outputTokens: 0 }, token)).toEqual({
      status: 200,
      body: { share: "under 1%", todayShare: "under 1%" },
    })
    // At the catalog's prices this request costs 98,304 micro-dollars: 2.5% of the month and 9.8% of today's limit.
    // Every rounding errs upward (P2), so today reads one band above its exact share, never below it.
    const single = await estimate({ model: DEEPSEEK, inputTokens: 262_144, outputTokens: 16_384 }, token)
    expect(single.body).toEqual({ share: "2–5%", todayShare: "10–20%" })
    // M4: no Stripe and no OpenRouter call with a fresh snapshot.
    expect(fakes.stripe.calls).toEqual([])
    expect(fakes.openRouter.calls).toEqual([])
  })

  test("inputs are clamped to the model's window, its reply and 100 requests: one answer, one stored step", async () => {
    const { fakes, token } = await plus()
    const clamped = await estimate({ model: DEEPSEEK, inputTokens: 1e9, outputTokens: 1e9, requests: 1000 }, token)
    const largest = await estimate(
      { model: DEEPSEEK, inputTokens: 262_144, outputTokens: 16_384, requests: 100 },
      token,
    )
    expect(clamped).toEqual(largest)
    expect(clamped.body.share).toBe("more than your month")
    expect(estimateKeys(fakes)).toHaveLength(1)
  })

  test("a step keeps its first answer for the period, even after the pool moves, and lapses a day after", async () => {
    const { fakes, fixture, token, id } = await plus()
    const question = { model: DEEPSEEK, inputTokens: 50_000, outputTokens: 2_000, requests: 100 }
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    const [key] = estimateKeys(fakes)
    // Keyed by account, period (meter epoch), pool ramp phase, daily share and cost step.
    expect(key).toBe(
      codiumKey(
        "estimate",
        id,
        `${fixture.expect.subscription}:${fixture.expect.periodStart * 1000}`,
        "full",
        0.25,
        37,
      ),
    )
    // A carry raises the pool elevenfold in the same phase: the step answers as before, so the change says nothing.
    const account = (await readModelPlanAccount(id, fakes.fetcher))!
    const key0 = account.key!
    fakes.store.set(
      codiumKey("account", id),
      JSON.stringify({
        ...account,
        key: {
          ...key0,
          carry: {
            micro: 40_000_000,
            fromSubscription: "sub_before",
            fromStart: key0.start - 600,
            fromCharge: "ch_before",
          },
        },
      }),
    )
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    // Without the stored answer the same question would now read the larger pool.
    fakes.store.remove(key!)
    expect((await estimate(question, token)).body).toEqual({ share: "5–10%", todayShare: "20–40%" })
    const larger = fakes.store.get(key!)!
    // The carry's source charge is refunded (M6): the next same-period reconcile drops the carry, and the pool falls
    // back to Plus's month in the same period, phase and daily share. The kept answer would now understate the share
    // (and a pre-start ceiling built on it would be too low), so the step answers fresh on the smaller pool.
    fakes.stripe.load({
      charges: [{ ...fakes.stripe.charge("ch_active")!, id: "ch_before", refunded: true, amount_refunded: 1000 }],
    })
    await reconcileModelPlanAccount(id, fakes.fetcher, fakes.clock.now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry).toMatchObject({
      micro: 0,
      revokedOrigins: ["ch_before"],
    })
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    expect(estimateKeys(fakes)).toEqual([key!])
    // A parallel first answer worked out before the refund lands between this request's read and its write: it is
    // not served to a caller that read the smaller pool, and the next request replaces it.
    fakes.store.remove(key!)
    current.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await fakes.fetcher(input, init)
      const command = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (Array.isArray(command) && command[0] === "GET" && command[1] === key && !fakes.store.get(key!))
        fakes.store.set(key!, larger)
      return answer
    }) as typeof fetch
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    current.fetcher = fakes.fetcher
    expect(fakes.store.get(key!)).toBe(larger)
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    expect(fakes.store.get(key!)).not.toBe(larger)
    // A carry that rises again afterwards still tells the step nothing: the kept answer only overstates now.
    const revoked = (await readModelPlanAccount(id, fakes.fetcher))!
    fakes.store.set(
      codiumKey("account", id),
      JSON.stringify({ ...revoked, key: { ...revoked.key!, carry: { ...revoked.key!.carry!, micro: 40_000_000 } } }),
    )
    expect((await estimate(question, token)).body).toEqual({ share: "over 40%", todayShare: "more than your month" })
    // Stored answers lapse a day after the period ends.
    const periodEnd = fixture.expect.periodEnd * 1000
    fakes.clock.now = periodEnd + DAY - 1
    expect(fakes.store.get(key!)).toBeDefined()
    fakes.clock.now = periodEnd + DAY
    expect(fakes.store.get(key!)).toBeUndefined()
  })

  test("the pool ramp's end starts fresh answers: a step asked during a Max ramp moves to the full month", async () => {
    // Max (48 USD of fixture allowance, 40% a day) whose first payment was not 3-D Secure authenticated: for 72 hours
    // its pool holds 30% of the month (A10), and then the same period's key is raised to the full month.
    const { fakes, token, id } = await plus("governing-highest-rank", (fixture) => {
      const charge = fixture.objects.charges!.find((value) => value.id === "ch_twoMax")!
      Object.assign(charge, {
        payment_method_details: { card: { three_d_secure: { result: "attempt_acknowledged" } } },
      })
    })
    const ramped = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(ramped.key).toMatchObject({ creditsMicro: 14_400_000, fullCreditsMicro: 48_000_000 })
    const question = { model: DEEPSEEK, inputTokens: 262_144, outputTokens: 16_384 }
    expect((await estimate(question, token)).body).toEqual({ share: "1–2%", todayShare: "2–5%" })
    fakes.clock.now = ramped.poolRamp!.until
    setSystemTime(new Date(fakes.clock.now))
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key).toMatchObject({
      hash: ramped.key!.hash,
      subscription: ramped.key!.subscription,
      start: ramped.key!.start,
      creditsMicro: 48_000_000,
    })
    // The same question in the same period now reads the full month, not the ramp's answer for the rest of it.
    expect((await estimate(question, token)).body).toEqual({ share: "under 1%", todayShare: "under 1%" })
    expect(
      estimateKeys(fakes)
        .map((key) => key.split(":").at(-3))
        .sort(),
    ).toEqual(["full", "ramp"])
  })

  test("a period key from before the ledger is final, as at chat; one not yet the period's is read again", async () => {
    const { fakes, token, id } = await plus()
    const ask = async () => {
      const response = await fetch(`${origin.url}/api/model-plans/estimate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: DEEPSEEK, inputTokens: 1000, outputTokens: 100 }),
      })
      const body = (await response.json()) as { error: { code: string } }
      return { status: response.status, retryAfter: response.headers.get("retry-after"), code: body.error.code }
    }
    const account = (await readModelPlanAccount(id, fakes.fetcher))!
    // The snapshot's own period key without trusted credits: no retry will ever answer it.
    fakes.store.set(
      codiumKey("account", id),
      JSON.stringify({ ...account, key: { ...account.key!, creditsMicro: undefined } }),
    )
    expect(await ask()).toEqual({ status: 503, retryAfter: null, code: "MODEL_PLAN_POOL_UNAVAILABLE" })
    // Another period's key: reconcile has not replaced it yet, so the caller reads again shortly.
    fakes.store.set(codiumKey("account", id), JSON.stringify({ ...account, key: { ...account.key!, start: 1 } }))
    expect(await ask()).toEqual({ status: 503, retryAfter: "1", code: "MODEL_PLAN_RENEWING" })
    expect(estimateKeys(fakes)).toEqual([])
  })

  test("the 21st request in a minute is refused", async () => {
    const { token } = await plus()
    const statuses: number[] = []
    for (let index = 0; index < 21; index++)
      statuses.push((await estimate({ model: DEEPSEEK, inputTokens: index, outputTokens: 0 }, token)).status)
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200))
    expect(statuses[20]).toBe(429)
  })

  test("locked, unknown, staged and unserved models and other kinds get chat's answers, with no amount", async () => {
    const { fakes, token } = await plus()
    const answers = [
      await estimate({ model: KIMI, inputTokens: 1000, outputTokens: 100 }, token),
      await estimate({ model: "fixture/unknown", inputTokens: 1000, outputTokens: 100 }, token),
      await estimate({ model: "openai/gpt-6.1-sol", inputTokens: 1000, outputTokens: 100 }, token),
      ...["hosted", "race", "playbook"].map((kind) => estimate({ kind, minutes: 10, size: "standard" }, token)),
      await estimate({ model: DEEPSEEK, inputTokens: -1, outputTokens: 100 }, token),
      await estimate({ model: DEEPSEEK, inputTokens: 1.5, outputTokens: 100 }, token),
      await estimate({ model: DEEPSEEK, inputTokens: 10, outputTokens: 100, requests: 0 }, token),
    ]
    const settled = await Promise.all(answers)
    expect(settled.map((answer) => [answer.status, (answer.body.error as { code: string }).code])).toEqual([
      [403, "MODEL_PLAN_UPGRADE_REQUIRED"],
      [400, "MODEL_PLAN_MODEL"],
      [503, "MODEL_PLAN_MODEL_UNAVAILABLE"],
      [400, "CODIUM_ESTIMATE_KIND"],
      [400, "CODIUM_ESTIMATE_KIND"],
      [400, "CODIUM_ESTIMATE_KIND"],
      [400, "MODEL_PLAN_REQUEST"],
      [400, "MODEL_PLAN_REQUEST"],
      [400, "MODEL_PLAN_REQUEST"],
    ])
    expect(settled[0]!.body.error).toMatchObject({ plan: "vector-50", planName: "Pro" })
    // Production qualification: no route is accepted yet, so even DeepSeek is unavailable, as at chat.
    current.options = {}
    const unserved = await estimate({ model: DEEPSEEK, inputTokens: 1000, outputTokens: 100 }, token)
    expect(unserved).toMatchObject({ status: 503, body: { error: { code: "MODEL_PLAN_MODEL_UNAVAILABLE" } } })
    for (const answer of [...settled, unserved]) {
      expect(JSON.stringify(answer.body)).not.toMatch(/\$|usd|credit|cents/i)
      const numbers = JSON.stringify(answer.body).match(/:\s*-?\d/g) ?? []
      expect(numbers).toEqual([])
    }
    expect(estimateKeys(fakes)).toEqual([])
  })

  test("a paused plan is refused as chat refuses it, before any estimate is stored", async () => {
    const fixture = loadStripeFixture("paused-past-due")
    setSystemTime(new Date(fixture.now * 1000))
    const fakes = codiumFakes({ now: fixture.now * 1000 })
    fakes.stripe.load(fixture.objects)
    fakes.store.set(codiumKey("account", fixture.accountId), JSON.stringify(fixture.account))
    await reconcileModelPlanAccount(fixture.accountId, fakes.fetcher, fixture.now * 1000)
    current.fetcher = fakes.fetcher
    const token = mintCliToken({ id: fixture.accountId, email: "fixture@example.test" }, Date.now(), "desktop").token
    expect(await estimate({ model: DEEPSEEK, inputTokens: 1000, outputTokens: 100 }, token)).toMatchObject({
      status: 402,
      body: { error: { code: "MODEL_PLAN_PAYMENT_REQUIRED", reason: "payment_failed", action: "update-card" } },
    })
    expect(estimateKeys(fakes)).toEqual([])
  })

  test("account tokens marked or not, and run tokens through their verifier; nothing else", async () => {
    const { id, fakes } = await plus()
    const question = { model: DEEPSEEK, inputTokens: 1000, outputTokens: 100 }
    const user = { id, email: "fixture@example.test" }
    // An unmarked token from the copy-paste page may read status, which says more than an estimate.
    for (const token of [mintCliToken(user).token, mintCliToken(user, Date.now(), "cli").token])
      expect((await estimate(question, token)).status).toBe(200)
    const registry = createRunVerifierRegistry()
    registry.register("vrt_", async (token) => {
      if (token !== "vrt_fixture.signature") throw new Error("unknown run")
      return {
        account: { id },
        kind: "run",
        purpose: "review",
        run: {
          id: "run_estimate",
          source: "github-comment",
          deadline: Date.now() + 3_600_000,
          service: "cloud-agents",
        },
      }
    })
    current.options = { ...served, runVerifiers: registry }
    expect(await estimate(question, "vrt_fixture.signature")).toMatchObject({ status: 200 })
    const code = async (token: string) => {
      const answer = await estimate(question, token)
      return [answer.status, (answer.body.error as { code: string }).code]
    }
    // No hosted verifier is registered here: a hosted run token is not authorized.
    expect(await code("vht_fixture.signature")).toEqual([401, "MODEL_PLAN_RUN_EXPIRED"])
    // Every other refused account token gets chat's sign-in answer (§4.10), which sends the client to sign in again.
    const expired = mintCliToken(user, Date.now() - 91 * DAY, "desktop").token
    for (const token of [`${mintCliToken(user).token}x`, expired, "browser-session", `vct_${"a".repeat(9000)}.b`])
      expect(await code(token)).toEqual([401, "CODIUM_SIGN_IN_REQUIRED"])
    fakes.store.set(`vector:cli-revoked:${id}`, "1")
    expect(await code(mintCliToken(user, Date.now(), "desktop").token)).toEqual([401, "CODIUM_SIGN_IN_REQUIRED"])
    for (const band of new Set(estimateKeys(fakes).map((key) => JSON.parse(fakes.store.get(key)!).answer.share)))
      expect(BANDS).toContain(band)
  })
})
