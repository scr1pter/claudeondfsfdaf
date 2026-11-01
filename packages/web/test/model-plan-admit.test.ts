import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { randomUUID } from "node:crypto"
import { codiumKey } from "../../../api/_lib/codium-keys"
import { holdMember, placeHold, releaseHold } from "../../../api/_lib/codium-pool"
import { renewalGraceMinutes } from "../../../api/_lib/codium-limits"
import { buildSnapshot } from "../../../api/_lib/codium-snapshot"
import { initializeFreshModelPool, modelSpendKeys, readModelSpendLedger } from "../../../api/_lib/codium-spend-ledger"
import { drainOutbox } from "../../../api/_lib/codium-provision"
import {
  ADMISSION_SCRIPTS,
  admitModelPlan,
  LOST_ADMISSION_CANCEL_MS,
  settleModelPlan,
  type ModelPlanAdmission,
} from "../../../api/_lib/model-plan-admit"
import { createRunVerifierRegistry } from "../../../api/_lib/model-plan-caller"

// Admission arithmetic is tested by running the actual Lua on local Valkey, never by a second TypeScript ledger.
// No provider boundary is used. The non-Valkey cases only test the HTTP adapter and invalid-input boundary.
const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "CODIUM_STRIPE_MODE", "STRIPE_SECRET_KEY", "VERCEL_ENV"]
const original = new Map(names.map((name) => [name, process.env[name]]))
beforeEach(() => {
  process.env.KV_REST_API_URL = "https://kv.admission-fixture.invalid"
  process.env.KV_REST_API_TOKEN = "admission-fixture-token"
  process.env.CODIUM_STRIPE_MODE = "test"
  process.env.STRIPE_SECRET_KEY = "sk_test_admission_fixture"
  process.env.VERCEL_ENV = "preview"
})
afterEach(() => {
  for (const name of names) {
    const value = original.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function data() {
  const now = Math.floor(Date.now() / 1000) * 1000
  const account = randomUUID()
  const pool = `admission-${randomUUID()}`
  const start = now / 1000 - 3600
  const end = start + 30 * 86_400
  const genesis = { account, pool, subscription: `sub_${randomUUID()}`, start, end, creation: randomUUID() }
  const snapshot = buildSnapshot(
    {
      account,
      state: "active",
      plan: "vector-10",
      subscription: genesis.subscription,
      periodStart: start * 1000,
      periodEnd: end * 1000,
      cancelAtPeriodEnd: false,
      source: "request",
    },
    undefined,
    now,
  )
  const key = {
    hash: pool,
    provisioning: true,
    subscription: genesis.subscription,
    start,
    end,
    // A freshly created A17 key always records its credits as integer micro-dollars; the fence recomputes the total.
    creditsMicro: 1_000_000,
    spendGenesis: { nonce: genesis.creation, state: "pending" },
  }
  const accountRecord = JSON.stringify({ customer: "cus_fixture", key })
  const input: ModelPlanAdmission = {
    snapshot,
    funding: {
      pool,
      baseMicro: 1_000_000,
      totalMicro: 1_000_000,
      subscription: genesis.subscription,
      start,
      end,
      accountRecord,
    },
    requiredMicro: 10_000,
    purpose: "chat",
  }
  return { now, genesis, input, key }
}

function responses(result: unknown) {
  const commands: (string | number)[][] = []
  const fetcher: typeof fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      commands.push(JSON.parse(String(init?.body)) as (string | number)[])
      return Response.json({ result })
    },
    { preconnect: () => {} },
  )
  return { commands, fetcher }
}

describe("A17 admission adapter", () => {
  test("one admission is one store roundtrip and contains no plaintext provider credential", async () => {
    const fixture = data()
    const store = responses("ok")
    const ticket = await admitModelPlan(fixture.input, store.fetcher, fixture.now)
    expect(store.commands).toHaveLength(1)
    expect(store.commands[0]![0]).toBe("EVAL")
    expect(store.commands[0]![2]).toBe(12)
    expect(ticket.deadline).toBe(fixture.now + 660_000)
    expect(ticket.member).toBe(holdMember(ticket.ticket, "chat", undefined, fixture.input.requiredMicro))
    expect(JSON.stringify(store.commands)).not.toContain("Bearer")
    expect(JSON.stringify(store.commands)).not.toContain("OPENROUTER_MANAGEMENT_KEY")
  })

  test.each([
    ["concurrency", "MODEL_PLAN_CONCURRENCY"],
    ["busy", "MODEL_PLAN_BUSY"],
    ["monthly", "MODEL_PLAN_EXHAUSTED"],
    ["daily", "MODEL_PLAN_DAILY_LIMIT"],
    ["brain", "MODEL_PLAN_BRAIN_SHARE"],
    ["run", "MODEL_PLAN_RUN_LIMIT"],
    ["runexpired", "MODEL_PLAN_RUN_EXPIRED"],
    ["stale", "MODEL_PLAN_RENEWING"],
    ["unavailable", "MODEL_PLAN_POOL_UNAVAILABLE"],
  ])("maps the %s refusal without private money figures", async (result, code) => {
    const fixture = data()
    await expect(admitModelPlan(fixture.input, responses(result).fetcher, fixture.now)).rejects.toMatchObject({ code })
  })

  test("busy/daily/run responses preserve retry and limit contracts", async () => {
    const fixture = data()
    await expect(admitModelPlan(fixture.input, responses("busy").fetcher, fixture.now)).rejects.toMatchObject({
      statusCode: 429,
    })
    await expect(admitModelPlan(fixture.input, responses("daily").fetcher, fixture.now)).rejects.toMatchObject({
      retryAfterSeconds: Math.ceil((86_400_000 - (fixture.now % 86_400_000)) / 1000),
    })
    await expect(admitModelPlan(fixture.input, responses("run").fetcher, fixture.now)).rejects.toMatchObject({
      detail: { limit: "ceiling" },
    })
  })

  test.each([NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid required amount %s before storage",
    async (requiredMicro) => {
      const fixture = data()
      const store = responses("ok")
      await expect(
        admitModelPlan({ ...fixture.input, requiredMicro }, store.fetcher, fixture.now),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
      expect(store.commands).toHaveLength(0)
    },
  )

  test("negative safe base is not a format error; the transaction makes the monthly refusal", async () => {
    const fixture = data()
    const store = responses("monthly")
    await expect(
      admitModelPlan(
        { ...fixture.input, funding: { ...fixture.input.funding, baseMicro: -100 } },
        store.fetcher,
        fixture.now,
      ),
    ).rejects.toMatchObject({ code: "MODEL_PLAN_EXHAUSTED" })
    expect(store.commands).toHaveLength(1)
  })

  test.each(["with:colon", "x".repeat(129), "-"])(
    "rejects incompatible run ID %s instead of dropping it",
    async (id) => {
      const fixture = data()
      const store = responses("ok")
      await expect(
        admitModelPlan({ ...fixture.input, run: { id, deadline: fixture.now + 1000 } }, store.fetcher, fixture.now),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_EXPIRED", statusCode: 401 })
      expect(store.commands).toHaveLength(0)
    },
  )

  test.each([0, -1, 3 * 86_400_000 + 1, NaN, Infinity])(
    "rejects invalid run deadline delta %s as expired authorization",
    async (delta) => {
      const fixture = data()
      const store = responses("ok")
      await expect(
        admitModelPlan(
          { ...fixture.input, run: { id: "valid-run", deadline: fixture.now + delta } },
          store.fetcher,
          fixture.now,
        ),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_EXPIRED", statusCode: 401 })
      expect(store.commands).toHaveLength(0)
    },
  )

  test("a run id the caller verifier accepts is admitted; one admission could not store is refused by the verifier", async () => {
    const fixture = data()
    const verified = (id: string) => {
      const registry = createRunVerifierRegistry()
      registry.register("vrt_", async () => ({
        account: { id: fixture.input.snapshot.account },
        kind: "run",
        purpose: "review",
        run: { id, source: "github-comment", deadline: fixture.now + 3_600_000, service: "cloud-agents" },
      }))
      return registry.verify("vrt_fixture.signature", fixture.now)
    }
    for (const id of ["github.12345.7", "x".repeat(128)]) {
      const caller = await verified(id)
      const store = responses("ok")
      expect((await admitModelPlan({ ...fixture.input, run: caller.run }, store.fetcher, fixture.now)).run).toBe(id)
      expect(store.commands).toHaveLength(1)
    }
    // A held member and `run:<id>` cannot carry ':' or more than 128 characters, so the verifier refuses those first.
    for (const id of ["github:12345:7", "x".repeat(129), "-"])
      await expect(verified(id)).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_EXPIRED", statusCode: 401 })
  })

  test("an admission whose answer is lost is cancelled at once, and queued past its deadline unless that lands", async () => {
    const lost = (settled: unknown) => {
      const commands: (string | number)[][] = []
      const fetcher: typeof fetch = Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          const command = JSON.parse(String(init?.body)) as (string | number)[]
          commands.push(command)
          if (command[1] === ADMISSION_SCRIPTS.ADMIT) return new Response(null, { status: 503 })
          if (command[1] === ADMISSION_SCRIPTS.SETTLE) return Response.json({ result: settled })
          return Response.json({ result: 1 })
        },
        { preconnect: () => {} },
      )
      return { commands, fetcher }
    }
    // The store ran the admission: the cancel at once frees it, and nothing is queued.
    const ran = data()
    const store = lost("ok")
    await expect(admitModelPlan(ran.input, store.fetcher, ran.now)).rejects.toMatchObject({
      code: "PERSISTENT_STORE_UNAVAILABLE",
    })
    expect(store.commands).toHaveLength(2)
    const cancel = store.commands[1]!
    const admittedTicket = JSON.parse(String(store.commands[0]![3 + 12]))
    expect(cancel[1]).toBe(ADMISSION_SCRIPTS.SETTLE)
    expect(JSON.parse(String(cancel[3 + 12]))).toMatchObject({
      ticket: admittedTicket.ticket,
      member: admittedTicket.member,
      deadline: admittedTicket.deadline,
    })
    expect(cancel.slice(4 + 12)).toEqual(["cancel", 0, ran.now])
    // Not run yet ('missing'), or the cancel's own answer lost: the cancellation is queued past the deadline.
    for (const settled of ["missing", 1]) {
      const fixture = data()
      const { commands, fetcher } = lost(settled)
      await expect(admitModelPlan(fixture.input, fetcher, fixture.now)).rejects.toMatchObject({
        code: "PERSISTENT_STORE_UNAVAILABLE",
      })
      expect(commands).toHaveLength(3)
      expect(commands[1]![1]).toBe(ADMISSION_SCRIPTS.SETTLE)
      const admitted = JSON.parse(String(commands[0]![3 + 12]))
      const queue = commands[2]!
      expect(queue[6]).toBe(`model-settle:${admitted.ticket}`)
      expect(queue[8]).toBe(fixture.now + 660_000 + LOST_ADMISSION_CANCEL_MS)
      expect(JSON.parse(String(queue[7]))).toMatchObject({
        kind: "model-settle",
        key: admitted.ticket,
        payload: {
          ticket: { ticket: admitted.ticket, member: admitted.member, deadline: admitted.deadline },
          outcome: { kind: "cancel" },
        },
      })
      expect(JSON.stringify(queue)).not.toContain("Bearer")
    }
  })

  test("unsafe period or timestamp arithmetic fails before storage", async () => {
    const fixture = data()
    const store = responses("ok")
    await expect(
      admitModelPlan(
        { ...fixture.input, funding: { ...fixture.input.funding, end: Number.MAX_SAFE_INTEGER } },
        store.fetcher,
        fixture.now,
      ),
    ).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
    await expect(admitModelPlan(fixture.input, store.fetcher, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
      code: "MODEL_PLAN_POOL_UNAVAILABLE",
    })
    expect(store.commands).toHaveLength(0)
  })
})

const valkeyURL = process.env.VECTOR_TEST_REDIS_URL
describe.skipIf(!valkeyURL)("A17 actual admission/settlement Lua on Valkey", () => {
  async function database(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    const redis = new RedisClient(valkeyURL!, { autoReconnect: false })
    const keys = new Set<string>()
    const globalMembers = new Set<string>()
    const command = async (values: readonly (string | number)[]) => {
      if (values[0] === "EVAL") {
        values.slice(3, 3 + Number(values[2])).forEach((key) => keys.add(String(key)))
        const raw = values[3 + Number(values[2])]
        if (typeof raw === "string" && raw.startsWith("{")) {
          const input = JSON.parse(raw)
          if (typeof input.account === "string" && typeof input.ticket === "string")
            globalMembers.add(`${input.account}:${input.ticket}`)
        }
      } else if (values[1]) keys.add(String(values[1]))
      return redis.send(String(values[0]), values.slice(1).map(String))
    }
    const fetcher: typeof fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const result = await command(JSON.parse(String(init?.body)) as (string | number)[])
        return Response.json({ result })
      },
      { preconnect: () => {} },
    )
    try {
      await run(await setup(command, fetcher))
    } finally {
      for (const key of keys) {
        if (key === codiumKey("inflight", "global")) {
          for (const member of globalMembers) await redis.send("ZREM", [key, member])
        } else await redis.send("DEL", [key])
      }
      redis.close()
    }
  }

  async function setup(command: (values: readonly (string | number)[]) => Promise<unknown>, fetcher: typeof fetch) {
    const fixture = data()
    await command(["SET", codiumKey("account", fixture.genesis.account), fixture.input.funding.accountRecord])
    await initializeFreshModelPool(fixture.genesis, fetcher)
    const ready = JSON.parse(String(await command(["GET", codiumKey("account", fixture.genesis.account)])))
    ready.key.provisioning = false
    fixture.input.funding.accountRecord = JSON.stringify(ready)
    await command(["SET", codiumKey("account", fixture.genesis.account), fixture.input.funding.accountRecord])
    await command(["SET", codiumKey("ent", fixture.genesis.account), JSON.stringify(fixture.input.snapshot)])
    const snapshot = async (caps: Partial<ModelPlanAdmission["snapshot"]["caps"]>) => {
      fixture.input.snapshot = { ...fixture.input.snapshot, caps: { ...fixture.input.snapshot.caps, ...caps } }
      await command(["SET", codiumKey("ent", fixture.genesis.account), JSON.stringify(fixture.input.snapshot)])
    }
    return {
      ...fixture,
      command,
      fetcher,
      snapshot,
      admit: (overrides: Partial<ModelPlanAdmission> = {}, now = fixture.now) =>
        admitModelPlan({ ...fixture.input, ...overrides }, fetcher, now),
    }
  }

  test("genesis preserves empty arrays, is idempotent, and cannot reset a ready/missing ledger", () =>
    database(async (f) => {
      const fresh = data()
      const raw = JSON.stringify({ key: fresh.key, risk: { blocked: false, openDisputes: {}, efw: [] }, warnings: [] })
      await f.command(["SET", codiumKey("account", fresh.genesis.account), raw])
      await initializeFreshModelPool(fresh.genesis, f.fetcher)
      const ready = String(await f.command(["GET", codiumKey("account", fresh.genesis.account)]))
      expect(ready).toBe(raw.replace('"state":"pending"', '"state":"ready"'))
      await f.command(["HSET", modelSpendKeys(fresh.genesis.pool).ledger, "committed", "123", "compacted", "123"])
      await initializeFreshModelPool(fresh.genesis, f.fetcher)
      expect(await f.command(["HGET", modelSpendKeys(fresh.genesis.pool).ledger, "committed"])).toBe("123")
      await f.command(["DEL", modelSpendKeys(fresh.genesis.pool).ledger])
      await expect(initializeFreshModelPool(fresh.genesis, f.fetcher)).rejects.toMatchObject({
        code: "MODEL_PLAN_POOL_UNAVAILABLE",
      })
    }))

  test("legacy provisioning without a fresh creation nonce cannot seed zero", () =>
    database(async (f) => {
      const fresh = data()
      await f.command([
        "SET",
        codiumKey("account", fresh.genesis.account),
        JSON.stringify({ key: { ...fresh.key, spendGenesis: undefined } }),
      ])
      await expect(initializeFreshModelPool(fresh.genesis, f.fetcher)).rejects.toThrow()
      expect(await f.command(["EXISTS", modelSpendKeys(fresh.genesis.pool).ledger])).toBe(0)
    }))

  test("parallel admissions cannot exceed account concurrency; refusal precedes monthly exhaustion", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 2, dailyShare: null })
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.admit()))
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2)
      expect(
        results
          .filter((result) => result.status === "rejected")
          .every((result) => result.status === "rejected" && result.reason.code === "MODEL_PLAN_CONCURRENCY"),
      ).toBe(true)
      await expect(f.admit({ funding: { ...f.input.funding, baseMicro: -1 } })).rejects.toMatchObject({
        code: "MODEL_PLAN_CONCURRENCY",
      })
    }))

  test("the global reserve keeps its last slots for priority plans, and settling frees the global slot", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 10, dailyShare: null })
      const ticket = await f.admit({ globalLimit: 2, priorityReserve: 0.5 })
      await expect(f.admit({ globalLimit: 2, priorityReserve: 0.5 })).rejects.toMatchObject({ code: "MODEL_PLAN_BUSY" })
      await f.snapshot({ rank: 3 })
      await f.admit({ globalLimit: 2, priorityReserve: 0.5 })
      await settleModelPlan(ticket, { kind: "cancel" }, f.fetcher, f.now + 1)
      expect(
        await f.command(["ZSCORE", codiumKey("inflight", "global"), `${ticket.account}:${ticket.ticket}`]),
      ).toBeNull()
    }))

  test("another account's live request counts against the global limit, never against this account's own cap", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 10, dailyShare: null })
      const global = codiumKey("inflight", "global")
      const account = codiumKey("inflight", f.genesis.account)
      const other = `${randomUUID()}:${randomUUID()}`
      await f.command(["ZADD", global, f.now + 60_000, other])
      try {
        // This account has nothing in flight; the shared set's one live member fills Plus's share of a limit of 2.
        await expect(f.admit({ globalLimit: 2, priorityReserve: 0.5 })).rejects.toMatchObject({
          code: "MODEL_PLAN_BUSY",
        })
        expect(await f.command(["ZCARD", account])).toBe(0)
        await f.snapshot({ rank: 3 })
        const ticket = await f.admit({ globalLimit: 2, priorityReserve: 0.5 })
        expect(await f.command(["ZCARD", account])).toBe(1)
        expect(Number(await f.command(["ZSCORE", global, `${ticket.account}:${ticket.ticket}`]))).toBe(ticket.deadline)
        await expect(f.admit({ globalLimit: 2, priorityReserve: 0.5 })).rejects.toMatchObject({
          code: "MODEL_PLAN_BUSY",
        })
        await settleModelPlan(ticket, { kind: "cancel" }, f.fetcher, f.now + 1)
        expect(await f.command(["ZCARD", account])).toBe(0)
        expect(Number(await f.command(["ZSCORE", global, other]))).toBe(f.now + 60_000)
      } finally {
        await f.command(["ZREM", global, other])
      }
    }))

  test("expired concurrency members are purged even by a refused admission, and never counted", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 1, dailyShare: null })
      const global = codiumKey("inflight", "global")
      const account = codiumKey("inflight", f.genesis.account)
      // Members past their deadline, here and from other accounts: none holds a slot.
      const expired = Array.from({ length: 200 }, (_, index) => `expired-${randomUUID()}:${index}`)
      try {
        for (const member of expired) await f.command(["ZADD", global, f.now - 1, member])
        await f.command(["ZADD", account, f.now, `${f.genesis.account}:expired`])
        await f.admit({ globalLimit: 1, priorityReserve: 0 })
        for (const member of expired.slice(0, 100)) await f.command(["ZADD", global, f.now - 1, member])
        await expect(f.admit({ globalLimit: 1, priorityReserve: 0 })).rejects.toMatchObject({
          code: "MODEL_PLAN_CONCURRENCY",
        })
        // The refusal left only live members behind: the expired ones are gone from both sets.
        for (const member of expired) expect(await f.command(["ZSCORE", global, member])).toBeNull()
        expect(await f.command(["ZCARD", account])).toBe(1)
      } finally {
        for (const member of expired) await f.command(["ZREM", global, member])
      }
    }))

  test("parallel monthly reservations are atomic and negative base refuses", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: null })
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.admit({ requiredMicro: 300_000 })))
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3)
      expect(
        results
          .filter((result) => result.status === "rejected")
          .every((result) => result.status === "rejected" && result.reason.code === "MODEL_PLAN_EXHAUSTED"),
      ).toBe(true)
      expect((await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now, f.fetcher)).reservedMicro).toBe(
        900_000,
      )
      await expect(f.admit({ funding: { ...f.input.funding, baseMicro: -1 } })).rejects.toMatchObject({
        code: "MODEL_PLAN_EXHAUSTED",
      })
    }))

  test("settled floor survives bridge expiry and a stale provider observation", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: null })
      const b = await f.admit({ requiredMicro: 700_000 })
      await settleModelPlan(b, { kind: "complete", chargeMicro: 700_000 }, f.fetcher, f.now + 1000)
      // A fetched a base that still omitted B. Once B's bridge expires, its durable committed floor remains.
      await expect(f.admit({ requiredMicro: 400_000 }, f.now + 32_000)).rejects.toMatchObject({
        code: "MODEL_PLAN_EXHAUSTED",
      })
      const ledger = await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now + 32_000, f.fetcher)
      expect(ledger).toMatchObject({ committedMicro: 700_000, reservedMicro: 0, nonmodelHeldMicro: 0 })
      await f.admit({ requiredMicro: 300_000 }, f.now + 32_000)
    }))

  test("crashed requests release concurrency at 660s but retain monthly/day/run reservations", () =>
    database(async (f) => {
      await f.snapshot({
        inFlight: 1,
        dailyShare: 0.25,
        cloudAgents: { ...f.input.snapshot.caps.cloudAgents, runCeilingShare: 0.1 },
      })
      const run = { id: `run-${randomUUID()}`, deadline: f.now + 3_600_000, ceilingShare: 1 }
      await f.admit({ requiredMicro: 100_000, run })
      await expect(f.admit({ run }, f.now + 660_001)).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_LIMIT" })
      await expect(f.admit({ requiredMicro: 160_000 }, f.now + 660_001)).rejects.toMatchObject({
        code: "MODEL_PLAN_DAILY_LIMIT",
      })
      await expect(f.admit({ requiredMicro: 910_000 }, f.now + 660_001)).rejects.toMatchObject({
        code: "MODEL_PLAN_EXHAUSTED",
      })
    }))

  test("Brain is a period share across UTC days, with live and abandoned reservations", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: null })
      const brain = await f.admit({ purpose: "brain", requiredMicro: 60_000 })
      await settleModelPlan(brain, { kind: "complete", chargeMicro: 60_000 }, f.fetcher, f.now + 1)
      await f.admit({ purpose: "brain", requiredMicro: 40_000 }, f.now + 86_400_000)
      await expect(f.admit({ purpose: "brain", requiredMicro: 1 }, f.now + 86_400_001)).rejects.toMatchObject({
        code: "MODEL_PLAN_BRAIN_SHARE",
      })
      expect(await f.command(["HGET", codiumKey("purpose", f.genesis.pool), "brain"])).toBe("60000")
    }))

  test("daily refusal precedes Brain and run and clamps verifier run share to server daily policy", () =>
    database(async (f) => {
      await f.snapshot({
        inFlight: 20,
        dailyShare: 0.05,
        purposeShare: { brain: 0.01 },
        cloudAgents: { ...f.input.snapshot.caps.cloudAgents, runCeilingShare: 0.1 },
      })
      await expect(
        f.admit({
          purpose: "brain",
          requiredMicro: 60_000,
          run: { id: "safe-run", deadline: f.now + 1000, ceilingShare: 1 },
        }),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_DAILY_LIMIT" })
      await f.snapshot({ dailyShare: null })
      await expect(
        f.admit({ requiredMicro: 110_000, run: { id: "safe-run", deadline: f.now + 1000, ceilingShare: 1 } }),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_LIMIT" })
    }))

  test("settlement is one-shot, meters actual above reserve, releases every concurrency index", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: null })
      const run = { id: `run-${randomUUID()}`, deadline: f.now + 1000 }
      const ticket = await f.admit({ run, requiredMicro: 20_000 })
      expect(await settleModelPlan(ticket, { kind: "complete", chargeMicro: 30_000 }, f.fetcher, f.now + 1)).toBe("ok")
      expect(await settleModelPlan(ticket, { kind: "complete", chargeMicro: 30_000 }, f.fetcher, f.now + 2)).toBe(
        "done",
      )
      expect(await settleModelPlan(ticket, { kind: "cancel" }, f.fetcher, f.now + 3)).toBe("done")
      const ledger = await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now + 3, f.fetcher)
      expect(ledger).toMatchObject({ committedMicro: 30_000, reservedMicro: 0, nonmodelHeldMicro: 0 })
      expect(await f.command(["HGET", codiumKey("day", f.genesis.pool, ticket.day), "total"])).toBe("30000")
      expect(await f.command(["GET", codiumKey("run", run.id)])).toBe("30000")
      for (const key of [codiumKey("inflight", f.genesis.account), codiumKey("inflight", "global")])
        expect(await f.command(["ZSCORE", key, `${ticket.account}:${ticket.ticket}`])).toBeNull()
    }))

  test("broken retry charges actual dispatched bound, keeps original hold, and duplicate settlement cannot alter it", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const ticket = await f.admit({ requiredMicro: 60_000 })
      await settleModelPlan(ticket, { kind: "broken", chargeMicro: 30_000 }, f.fetcher, f.now + 1)
      await settleModelPlan(ticket, { kind: "complete", chargeMicro: 1 }, f.fetcher, f.now + 2)
      expect(Number(await f.command(["ZSCORE", codiumKey("held", ticket.pool), ticket.member]))).toBe(ticket.deadline)
      expect((await readModelSpendLedger(ticket.account, ticket.pool, f.now + 2, f.fetcher)).committedMicro).toBe(
        30_000,
      )
    }))

  test("a lost settlement response retries without charging or releasing twice", () =>
    database(async (f) => {
      const ticket = await f.admit()
      const lost: typeof fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          await f.fetcher(url, init)
          throw new Error("simulated lost store response")
        },
        { preconnect: () => {} },
      )
      await expect(settleModelPlan(ticket, { kind: "complete", chargeMicro: 7000 }, lost, f.now + 1)).rejects.toThrow()
      expect(await settleModelPlan(ticket, { kind: "complete", chargeMicro: 7000 }, f.fetcher, f.now + 2)).toBe("done")
      expect((await readModelSpendLedger(ticket.account, ticket.pool, f.now + 2, f.fetcher)).committedMicro).toBe(7000)
      expect(await f.command(["HGET", codiumKey("day", ticket.pool, ticket.day), "total"])).toBe("7000")
    }))

  test("an admission that ran but lost its answer is cancelled at once, freeing its slot before its deadline", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null, inFlight: 1 })
      const lost: typeof fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          const response = await f.fetcher(url, init)
          if (JSON.parse(String(init?.body))[1] === ADMISSION_SCRIPTS.ADMIT)
            throw new Error("simulated lost store response")
          return response
        },
        { preconnect: () => {} },
      )
      await expect(admitModelPlan(f.input, lost, f.now)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      const [ticket] = (await f.command(["HKEYS", modelSpendKeys(f.genesis.pool).reservations])) as string[]
      // Nothing was dispatched for it, so nothing is charged: the month, the day and the slot are whole at once.
      expect(await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now, f.fetcher)).toMatchObject({
        committedMicro: 0,
        reservedMicro: 0,
      })
      expect(
        (await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now + 660_001, f.fetcher)).abandonedMicro,
      ).toBe(0)
      expect(
        await f.command(["ZSCORE", codiumKey("inflight", f.genesis.account), `${f.genesis.account}:${ticket}`]),
      ).toBeNull()
      expect(await f.command(["ZCARD", codiumKey("held", f.genesis.pool)])).toBe(0)
      expect(await f.command(["ZSCORE", codiumKey("outbox"), `model-settle:${ticket}`])).toBeNull()
      // The account's only in-flight slot is free for the next request now, not 11 minutes later.
      expect((await f.admit({ requiredMicro: 1_000_000 }, f.now + 1)).micro).toBe(1_000_000)
    }))

  test("an admission that lands after its cancel is cancelled past its deadline, never kept as abandoned", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      // The EVAL is still on its way when the gateway gives up on it: the cancel at once finds nothing.
      const delayed: (string | number)[][] = []
      const lost: typeof fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          const command = JSON.parse(String(init?.body)) as (string | number)[]
          if (command[1] !== ADMISSION_SCRIPTS.ADMIT) return f.fetcher(url, init)
          delayed.push(command)
          throw new Error("simulated store timeout")
        },
        { preconnect: () => {} },
      )
      await expect(admitModelPlan(f.input, lost, f.now)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      expect(await f.command(["HLEN", modelSpendKeys(f.genesis.pool).reservations])).toBe(0)
      // Then it lands.
      expect(await f.command(delayed[0]!)).toBe("ok")
      const [ticket] = (await f.command(["HKEYS", modelSpendKeys(f.genesis.pool).reservations])) as string[]
      const deadline = f.now + 660_000
      const cancelAt = deadline + LOST_ADMISSION_CANCEL_MS
      const slot = `${f.genesis.account}:${ticket}`
      // Until the queued cancellation lands it counts in full and takes its slot, then turns abandoned.
      expect(await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now, f.fetcher)).toMatchObject({
        reservedMicro: 10_000,
      })
      expect(Number(await f.command(["ZSCORE", codiumKey("inflight", f.genesis.account), slot]))).toBe(deadline)
      expect(
        (await readModelSpendLedger(f.genesis.account, f.genesis.pool, deadline + 1, f.fetcher)).abandonedMicro,
      ).toBe(10_000)
      expect(Number(await f.command(["ZSCORE", codiumKey("outbox"), `model-settle:${ticket}`]))).toBe(cancelAt)
      expect(await drainOutbox({ now: cancelAt - 1, fetcher: f.fetcher })).toMatchObject({ applied: 0 })
      expect(await drainOutbox({ now: cancelAt, fetcher: f.fetcher })).toMatchObject({ applied: 1 })
      expect(await readModelSpendLedger(f.genesis.account, f.genesis.pool, cancelAt, f.fetcher)).toMatchObject({
        committedMicro: 0,
        reservedMicro: 0,
        abandonedMicro: 0,
      })
      expect(await f.command(["ZSCORE", codiumKey("inflight", f.genesis.account), slot])).toBeNull()
      expect(await f.command(["ZCARD", codiumKey("held", f.genesis.pool)])).toBe(0)
      expect((await f.admit({ requiredMicro: 1_000_000 }, cancelAt + 1)).micro).toBe(1_000_000)
    }))

  test("an admission whose answer, cancel and queue write are all lost keeps counting in full, never free", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      // The ADMIT runs and its answer is lost; the store then stops answering anything for a while.
      const down = { value: false }
      const lost: typeof fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          if (down.value) throw new Error("simulated store outage")
          const response = await f.fetcher(url, init)
          if (JSON.parse(String(init?.body))[1] !== ADMISSION_SCRIPTS.ADMIT) return response
          down.value = true
          throw new Error("simulated lost store response")
        },
        { preconnect: () => {} },
      )
      await expect(admitModelPlan(f.input, lost, f.now)).rejects.toMatchObject({ code: "PERSISTENT_STORE_UNAVAILABLE" })
      const [ticket] = (await f.command(["HKEYS", modelSpendKeys(f.genesis.pool).reservations])) as string[]
      expect(await f.command(["ZSCORE", codiumKey("outbox"), `model-settle:${ticket}`])).toBeNull()
      // Nothing cancels it: open past its deadline, it is an abandoned reservation that counts in full.
      expect(await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now, f.fetcher)).toMatchObject({
        reservedMicro: 10_000,
      })
      expect(await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now + 660_001, f.fetcher)).toMatchObject({
        abandonedMicro: 10_000,
        committedMicro: 0,
      })
      await expect(f.admit({ requiredMicro: 1_000_000 - 10_000 + 1 }, f.now + 660_001)).rejects.toMatchObject({
        code: "MODEL_PLAN_EXHAUSTED",
      })
    }))

  test("all accepted safe-integer charges retain exact micro values", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const ticket = await f.admit()
      await settleModelPlan(ticket, { kind: "complete", chargeMicro: Number.MAX_SAFE_INTEGER }, f.fetcher, f.now + 1)
      expect((await readModelSpendLedger(ticket.account, ticket.pool, f.now + 2, f.fetcher)).committedMicro).toBe(
        Number.MAX_SAFE_INTEGER,
      )
      expect(await f.command(["HGET", codiumKey("day", ticket.pool, ticket.day), "total"])).toBe(
        String(Number.MAX_SAFE_INTEGER),
      )
      await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_EXHAUSTED" })
    }))

  test("cancel removes reservations; expired or deleted held members are never recreated by late settlement", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const cancelled = await f.admit()
      await settleModelPlan(cancelled, { kind: "cancel" }, f.fetcher, f.now + 1)
      expect((await readModelSpendLedger(cancelled.account, cancelled.pool, f.now + 2, f.fetcher)).reservedMicro).toBe(
        0,
      )
      const late = await f.admit()
      await f.command(["ZREM", codiumKey("held", late.pool), late.member])
      await settleModelPlan(late, { kind: "complete", chargeMicro: 5000 }, f.fetcher, late.deadline + 1)
      expect(await f.command(["ZCARD", codiumKey("held", late.pool)])).toBe(0)
      expect((await readModelSpendLedger(late.account, late.pool, late.deadline + 1, f.fetcher)).committedMicro).toBe(
        5000,
      )
    }))

  test("compacted completed tickets keep their floor and cannot settle again", () =>
    database(async (f) => {
      const ticket = await f.admit()
      await settleModelPlan(ticket, { kind: "complete", chargeMicro: 5000 }, f.fetcher, f.now + 1)
      await readModelSpendLedger(ticket.account, ticket.pool, ticket.deadline + 1, f.fetcher)
      expect(await f.command(["HLEN", modelSpendKeys(ticket.pool).reservations])).toBe(0)
      expect(await f.command(["HGET", modelSpendKeys(ticket.pool).ledger, "compacted"])).toBe("5000")
      expect(
        await settleModelPlan(ticket, { kind: "complete", chargeMicro: 9000 }, f.fetcher, ticket.deadline + 2),
      ).toBe("missing")
      expect(await f.command(["HGET", modelSpendKeys(ticket.pool).ledger, "committed"])).toBe("5000")
    }))

  test("a reservation recorded by the retired Astra group path fails the pool closed, never settles or counts", () =>
    database(async (f) => {
      const ticket = await f.admit()
      const reservations = modelSpendKeys(ticket.pool).reservations
      const stored = String(await f.command(["HGET", reservations, ticket.ticket]))
      // The ledger reads while the record is as ADMIT wrote it, so only the added field can refuse it below.
      expect((await readModelSpendLedger(ticket.account, ticket.pool, f.now, f.fetcher)).reservedMicro).toBe(
        ticket.micro,
      )
      // Same record, counters still consistent; it only names the group the pre-30 Oct ADMIT could write.
      await f.command(["HSET", reservations, ticket.ticket, JSON.stringify({ ...JSON.parse(stored), group: "astra" })])
      await expect(readModelSpendLedger(ticket.account, ticket.pool, f.now, f.fetcher)).rejects.toMatchObject({
        code: "MODEL_PLAN_POOL_UNAVAILABLE",
      })
      await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
      await expect(settleModelPlan(ticket, { kind: "cancel" }, f.fetcher, f.now + 1)).rejects.toMatchObject({
        code: "MODEL_PLAN_POOL_UNAVAILABLE",
      })
      expect(await f.command(["HGET", modelSpendKeys(ticket.pool).ledger, "reserved"])).toBe(String(ticket.micro))
      expect(await f.command(["HLEN", reservations])).toBe(1)
    }))

  test("missing open records fail closed rather than lose an abandoned reservation", () =>
    database(async (f) => {
      const ticket = await f.admit()
      await f.command(["HDEL", modelSpendKeys(ticket.pool).reservations, ticket.ticket])
      await expect(readModelSpendLedger(ticket.account, ticket.pool, f.now, f.fetcher)).rejects.toThrow()
      await expect(f.admit()).rejects.toThrow()
      await expect(settleModelPlan(ticket, { kind: "cancel" }, f.fetcher, f.now + 1)).rejects.toThrow()
      expect(await f.command(["HGET", modelSpendKeys(ticket.pool).ledger, "reserved"])).toBe(String(ticket.micro))
    }))

  test("one run cannot reset its reservation by moving to a new pool after upgrade", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const run = { id: `run-${randomUUID()}`, deadline: f.now + 3_600_000 }
      const old = await f.admit({ run, requiredMicro: 100_000 })
      const replacement = `replacement-${randomUUID()}`
      const creation = randomUUID()
      const nextGenesis = { ...f.genesis, pool: replacement, creation }
      const account = JSON.parse(f.input.funding.accountRecord)
      account.key = {
        ...account.key,
        hash: replacement,
        provisioning: true,
        spendGenesis: { nonce: creation, state: "pending" },
      }
      await f.command(["SET", codiumKey("account", f.genesis.account), JSON.stringify(account)])
      await initializeFreshModelPool(nextGenesis, f.fetcher)
      const ready = JSON.parse(String(await f.command(["GET", codiumKey("account", f.genesis.account)])))
      ready.key.provisioning = false
      const raw = JSON.stringify(ready)
      await f.command(["SET", codiumKey("account", f.genesis.account), raw])
      const funding = { ...f.input.funding, pool: replacement, accountRecord: raw }
      await expect(f.admit({ run, funding })).rejects.toMatchObject({ code: "MODEL_PLAN_RUN_EXPIRED", statusCode: 401 })
      // Refreshing a token for the same runID cannot reset the binding; a new runID has a new budget.
      await expect(f.admit({ run: { ...run, deadline: run.deadline + 1000 }, funding })).rejects.toMatchObject({
        code: "MODEL_PLAN_RUN_EXPIRED",
      })
      await f.admit({ run: { ...run, id: `new-${randomUUID()}` }, funding })
      await settleModelPlan(old, { kind: "broken" }, f.fetcher, f.now + 1)
      expect((await readModelSpendLedger(old.account, old.pool, f.now + 2, f.fetcher)).committedMicro).toBe(100_000)
    }))

  test("settlement retains immutable old pool/day/run after upgrade and UTC midnight", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const beforeMidnight = Math.floor(f.now / 86_400_000) * 86_400_000 + 86_399_000
      const ticket = await f.admit({ purpose: "brain" }, beforeMidnight)
      await f.command([
        "SET",
        codiumKey("account", ticket.account),
        JSON.stringify({ key: { hash: "replacement-key" } }),
      ])
      await f.command([
        "SET",
        codiumKey("ent", ticket.account),
        JSON.stringify({ ...f.input.snapshot, version: 2, meterEpoch: "next" }),
      ])
      await settleModelPlan(ticket, { kind: "complete", chargeMicro: 7000 }, f.fetcher, beforeMidnight + 2000)
      expect(await f.command(["HGET", codiumKey("day", ticket.pool, ticket.day), "total"])).toBe("7000")
      expect(await f.command(["HGET", codiumKey("purpose", ticket.pool), "brain"])).toBe("7000")
      expect(
        await f.command([
          "EXISTS",
          codiumKey("day", ticket.pool, new Date(beforeMidnight + 2000).toISOString().slice(0, 10)),
        ]),
      ).toBe(0)
    }))

  // A fence race (a newer billing write, risk, period or snapshot) is retryable RENEWING; only an untrusted ledger or
  // pool is the final POOL_UNAVAILABLE. Either way nothing is reserved.
  test("exact raw account fence rejects risk intent, provisioning and changed epoch", () =>
    database(async (f) => {
      const raw = f.input.funding.accountRecord
      const account = JSON.parse(raw)
      await f.command([
        "SET",
        codiumKey("account", f.genesis.account),
        JSON.stringify({
          ...account,
          risk: { blocked: false, openDisputes: { dispute: { at: f.now, status: "needs_response" } }, efw: [] },
        }),
      ])
      await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING", retryAfterSeconds: 1 })
      f.input.funding.accountRecord = String(await f.command(["GET", codiumKey("account", f.genesis.account)]))
      await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING" })
      f.input.funding.accountRecord = JSON.stringify({ ...account, key: { ...account.key, provisioning: true } })
      await f.command(["SET", codiumKey("account", f.genesis.account), f.input.funding.accountRecord])
      await expect(f.admit()).rejects.toThrow()
      f.input.funding.accountRecord = raw
      await f.command(["SET", codiumKey("account", f.genesis.account), raw])
      await f.command([
        "SET",
        codiumKey("ent", f.genesis.account),
        JSON.stringify({ ...f.input.snapshot, meterEpoch: "other", version: 2 }),
      ])
      await expect(f.admit()).rejects.toThrow()
      expect(await f.command(["HLEN", modelSpendKeys(f.genesis.pool).reservations])).toBe(0)
    }))

  test("a renewing snapshot admits through its grace and never past it; an active one stops at its period's end", () =>
    database(async (f) => {
      const end = f.input.funding.end * 1000
      const grace = renewalGraceMinutes() * 60_000
      await expect(f.admit({}, end)).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING" })
      // Reconcile says renewing while the renewal is collected (M11): the period's pool keeps admitting.
      const renewing = { ...f.input.snapshot, state: "renewing" as const, version: f.input.snapshot.version + 1 }
      await f.command(["SET", codiumKey("ent", f.genesis.account), JSON.stringify(renewing)])
      for (const at of [end, end + 30 * 60_000, end + grace - 1])
        expect((await f.admit({ snapshot: renewing }, at)).pool).toBe(f.genesis.pool)
      await expect(f.admit({ snapshot: renewing }, end + grace)).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING" })
      expect(await f.command(["HGET", modelSpendKeys(f.genesis.pool).ledger, "openCount"])).toBe("3")
    }))

  test("an open model reservation, live or abandoned, refuses a pool hold it would overspend until it settles", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      // Of the pool's 1.0, a model request reserves 0.8.
      const admitted = await f.admit({ requiredMicro: 800_000 })
      const hold = (requiredMicro: number, now: number) =>
        placeHold(
          {
            account: f.genesis.account,
            funding: f.input.funding,
            requiredMicro,
            purpose: "hosted",
            ttlMs: 60_000,
            now,
          },
          f.fetcher,
        )
      expect(await hold(200_001, f.now + 1)).toBeUndefined()
      // Past its deadline the request's outcome is unknown: abandoned, it keeps counting at its full amount.
      expect(await hold(200_001, admitted.deadline + 1)).toBeUndefined()
      await releaseHold((await hold(200_000, admitted.deadline + 1))!, f.fetcher)
      await settleModelPlan(admitted, { kind: "cancel" }, f.fetcher, admitted.deadline + 2)
      expect((await hold(1_000_000, admitted.deadline + 3))?.micro).toBe(1_000_000)
    }))

  test.each(["paused", "frozen", "ended", "none"])("unusable %s snapshot fails closed", (state) =>
    database(async (f) => {
      await f.command(["SET", codiumKey("ent", f.genesis.account), JSON.stringify({ ...f.input.snapshot, state })])
      await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING" })
      expect(await f.command(["HGET", modelSpendKeys(f.genesis.pool).ledger, "reserved"])).toBe("0")
    }),
  )

  test.each(["upgrade", "keyCreation", "transition", "closing", "ownerEnd"])(
    "observed private %s intent blocks old-pool admission",
    (intent) =>
      database(async (f) => {
        const account = JSON.parse(f.input.funding.accountRecord)
        account[intent] = intent === "closing" ? true : intent === "ownerEnd" ? { done: false } : { pending: true }
        f.input.funding.accountRecord = JSON.stringify(account)
        await f.command(["SET", codiumKey("account", f.genesis.account), f.input.funding.accountRecord])
        await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_RENEWING" })
        expect(await f.command(["HGET", modelSpendKeys(f.genesis.pool).ledger, "reserved"])).toBe("0")
      }),
  )

  test("a pool the fence cannot recompute or prove is final, not a retry", () =>
    database(async (f) => {
      const account = JSON.parse(f.input.funding.accountRecord)
      // Observed and stored records agree, so no race: the pool itself is untrusted.
      for (const key of [
        { ...account.key, creditsMicro: 1_000_000.5 },
        { ...account.key, creditsMicro: undefined },
        { ...account.key, carry: { micro: 0.5 } },
        { ...account.key, spendGenesis: { nonce: "another-key", state: "ready" } },
      ]) {
        f.input.funding.accountRecord = JSON.stringify({ ...account, key })
        await f.command(["SET", codiumKey("account", f.genesis.account), f.input.funding.accountRecord])
        await expect(f.admit()).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
      }
      // The caller's total must be the record's credits + carry exactly.
      f.input.funding.accountRecord = JSON.stringify(account)
      await f.command(["SET", codiumKey("account", f.genesis.account), f.input.funding.accountRecord])
      await expect(
        f.admit({ funding: { ...f.input.funding, totalMicro: f.input.funding.totalMicro + 1 } }),
      ).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_UNAVAILABLE" })
      expect(await f.command(["HGET", modelSpendKeys(f.genesis.pool).ledger, "reserved"])).toBe("0")
      expect((await f.admit()).pool).toBe(f.genesis.pool)
    }))

  test("shared monthly debits count once; unknown holds and debit dates also constrain budgets", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: 0.25 })
      const held = holdMember("external-hold", "hosted", "external-run", 40_000)
      const pending = holdMember("debit-pending", "hosted", "external-run", 60_000)
      await f.command([
        "ZADD",
        codiumKey("held", f.genesis.pool),
        f.now + 86_400_000,
        held,
        f.now + 86_400_000,
        pending,
      ])
      await f.command([
        "HSET",
        codiumKey("debits", f.genesis.account, f.genesis.pool),
        "pending",
        JSON.stringify({
          micro: 60_000,
          applied: false,
          hold: pending,
          purpose: "hosted",
          run: "external-run",
          at: f.now,
        }),
      ])
      const applied = holdMember("debit-applied", "hosted", undefined, 100_000)
      await f.command([
        "HSET",
        codiumKey("debits", f.genesis.account, f.genesis.pool),
        "applied",
        JSON.stringify({ micro: 100_000, applied: true, hold: applied, purpose: "hosted", at: f.now - 86_400_000 }),
      ])
      const ledger = await readModelSpendLedger(f.genesis.account, f.genesis.pool, f.now, f.fetcher)
      expect(ledger).toMatchObject({ nonmodelHeldMicro: 100_000, appliedMicro: 100_000, pendingMicro: 60_000 })
      // Today's external charges are 100k, not 160k: pending debit's held member is not a second budget charge.
      await f.admit({ requiredMicro: 150_000 })
      await expect(f.admit({ requiredMicro: 1 })).rejects.toMatchObject({ code: "MODEL_PLAN_DAILY_LIMIT" })
      await f.snapshot({ dailyShare: null })
      await expect(f.admit({ requiredMicro: 650_001 })).rejects.toMatchObject({ code: "MODEL_PLAN_EXHAUSTED" })
    }))

  test("a settled 30s model bridge is not counted again against the daily budget", () =>
    database(async (f) => {
      await f.snapshot({ inFlight: 20, dailyShare: 0.25 })
      const first = await f.admit({ requiredMicro: 150_000 })
      await settleModelPlan(first, { kind: "complete", chargeMicro: 150_000 }, f.fetcher, f.now + 1)
      await f.admit({ requiredMicro: 100_000 }, f.now + 2)
      await expect(f.admit({ requiredMicro: 1 }, f.now + 3)).rejects.toMatchObject({ code: "MODEL_PLAN_DAILY_LIMIT" })
    }))

  test("corrupt ledger/member/debit/counter and integer overflow fail before changing admission state", () =>
    database(async (f) => {
      await f.snapshot({ dailyShare: null })
      const heldKey = codiumKey("held", f.genesis.pool)
      await f.command(["ZADD", heldKey, f.now + 1000, "malformed"])
      await expect(f.admit()).rejects.toThrow()
      await f.command(["DEL", heldKey])
      await f.command(["HSET", codiumKey("debits", f.genesis.account, f.genesis.pool), "bad", "{}"])
      await expect(f.admit()).rejects.toThrow()
      await f.command(["DEL", codiumKey("debits", f.genesis.account, f.genesis.pool)])
      await f.command([
        "HSET",
        codiumKey("day", f.genesis.pool, new Date(f.now).toISOString().slice(0, 10)),
        "total",
        "9007199254740991",
      ])
      await expect(f.admit()).rejects.toThrow()
      expect(await f.command(["HLEN", modelSpendKeys(f.genesis.pool).reservations])).toBe(0)
      await f.command(["HSET", modelSpendKeys(f.genesis.pool).ledger, "committed", "not-a-number"])
      await expect(f.admit()).rejects.toThrow()
    }))

  test("reservation/counter lifetimes are bounded; shorter requests cannot shorten existing TTLs", () =>
    database(async (f) => {
      const held = codiumKey("held", f.genesis.pool)
      const external = holdMember("long-external", "hosted", undefined, 1)
      await f.command(["ZADD", held, f.now + 86_400_000, external])
      await f.command(["PEXPIRE", held, 86_400_000])
      const ticket = await f.admit({ run: { id: "ttl-run", deadline: f.now + 1000 } })
      expect(Number(await f.command(["PTTL", held]))).toBeGreaterThan(86_300_000)
      const reservationTTL = Number(await f.command(["PTTL", modelSpendKeys(ticket.pool).reservations]))
      expect(reservationTTL).toBeGreaterThan(0)
      expect(reservationTTL).toBeLessThanOrEqual(70 * 86_400_000)
      await settleModelPlan(ticket, { kind: "complete", chargeMicro: 100 }, f.fetcher, f.now + 1)
      const runTTL = Number(await f.command(["PTTL", codiumKey("run", "ttl-run")]))
      expect(runTTL).toBeGreaterThan(2.99 * 86_400_000)
      expect(runTTL).toBeLessThanOrEqual(3 * 86_400_000)
      expect(Number(await f.command(["PTTL", codiumKey("day", ticket.pool, ticket.day)]))).toBeGreaterThan(
        39 * 86_400_000,
      )
    }))
})
