import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainCredit } from "@vectordevai/core/brain/credit"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Flag } from "@vectordevai/core/flag/flag"
import type { TaskSize } from "@vectordevai/core/task-size"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// GET and DELETE /memory/workflow, as Settings > Memory > Workflow insights reads and resets them. Runs are recorded
// through BrainWorkflow as the engine records them at the end of a run; the listener reads the same brain file.

const keys = ["VECTOR_SERVER_USERNAME", "VECTOR_SERVER_PASSWORD", "VECTOR_DISABLE_DEFAULT_PLUGINS"] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousDatabase = Flag.VECTOR_AGENT_DB
const owner = { authorization: ServerAuth.header({ username: "vector", password: "owner-secret" }) ?? "" }

const runtime = ManagedRuntime.make(AppNodeBuilderV1.build(LayerNode.group([BrainWorkflow.node])))
const record = (where: Brain.Place, observations: readonly BrainWorkflow.Observation[]) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const workflow = yield* BrainWorkflow.Service
      yield* Effect.forEach(observations, (observation) => workflow.record(where, observation), { discard: true })
    }),
  )

let listener: Awaited<ReturnType<typeof Server.listen>>

beforeAll(async () => {
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_AGENT_DB = "memory-workflow.db"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  await runtime.dispose()
  Flag.VECTOR_AGENT_DB = previousDatabase
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterEach(async () => {
  await disposeAllInstances()
})

const call = (directory: string, method: string, route: string) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", directory)
  return fetch(url, { method, keepalive: false, headers: owner })
}

const json = async (response: Response) => {
  expect(response.status).toBe(200)
  return (await response.json()) as any
}

const place = async (directory: string): Promise<Brain.Place> => {
  const project = (await json(await call(directory, "GET", "/project/current"))) as { id: string }
  return { repository: project.id, root: directory, sources: [], held: false }
}

// One checked, priced run of the build agent at a size and effort.
const run = (index: number, tier: TaskSize.Tier, effort: string, costUsd: number): BrainWorkflow.Observation => ({
  sessionID: `ses_${tier}_${effort}_${index}`,
  requestID: `msg_${tier}_${effort}_${index}`,
  at: Date.now() - index * 1000,
  tier,
  effortTier: tier,
  agent: "build",
  providerID: "anthropic",
  modelID: "claude-x",
  effort,
  effortSource: "size",
  subagents: 0,
  subagentModels: {},
  judgeRounds: 0,
  outcome: "pass",
  signal: "recovered",
  costUsd,
  costKinds: { priced: 3 },
  steps: 3,
  unpricedSteps: 0,
  tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 0 },
  partial: false,
})

// `count` runs, the first `failed` of which ended with their check failing.
const runs = (tier: TaskSize.Tier, effort: string, costUsd: number, count = 8, failed = 0) =>
  Array.from(
    { length: count },
    (_, index): BrainWorkflow.Observation => ({
      ...run(index, tier, effort, costUsd),
      ...(index < failed ? { outcome: "fail" as const, signal: "check-fail" as const } : {}),
    }),
  )

describe("memory workflow routes", () => {
  test("give each size's runs by setting and the cheaper default they support, with the reason", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await record(await place(tmp.path), [
      ...runs("thorough", "default", 0.4),
      ...runs("thorough", "high", 0.9, 8, 2),
      ...runs("standard", "default", 0.2, 2),
      // A run whose effort the user picked says nothing about Vector's defaults.
      { ...run(99, "thorough", "max", 2), effortSource: "user" },
    ])
    const insights = await json(await call(tmp.path, "GET", "/memory/workflow"))
    expect(insights).toMatchObject({ mode: "apply", explore: false })
    expect(insights.tiers.map((item: { tier: string }) => item.tier)).toEqual(["light", "standard", "thorough"])
    const thorough = insights.tiers.find((item: { tier: string }) => item.tier === "thorough")
    expect(thorough.excluded).toBe(1)
    expect(thorough.arms.map((item: { arm: { effort: string } }) => item.arm.effort).sort()).toEqual([
      "default",
      "high",
    ])
    expect(thorough.advice).toMatchObject({ effortTier: "thorough", effort: "default", source: "learned" })
    expect(thorough.advice.reason).toBe(
      "Thorough work here passed 8 of 8 checked runs at default effort (avg $0.40) against 6 of 8 at high (avg $0.90).",
    )
    const standard = insights.tiers.find((item: { tier: string }) => item.tier === "standard")
    expect(standard.arms).toHaveLength(1)
    expect(standard.advice).toBeUndefined()
  }, 60_000)

  test("reset forgets one size's runs, or every size's", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await record(await place(tmp.path), [...runs("thorough", "high", 0.9, 3), ...runs("standard", "default", 0.2, 2)])
    expect(await json(await call(tmp.path, "DELETE", "/memory/workflow?tier=thorough"))).toEqual({ removed: 3 })
    const after = await json(await call(tmp.path, "GET", "/memory/workflow"))
    const arms = (tier: string) => after.tiers.find((item: { tier: string }) => item.tier === tier).arms.length
    expect([arms("thorough"), arms("standard")]).toEqual([0, 1])
    expect(await json(await call(tmp.path, "DELETE", "/memory/workflow"))).toEqual({ removed: 2 })
    expect((await call(tmp.path, "DELETE", "/memory/workflow?tier=chat")).status).toBe(400)
  }, 60_000)

  test("Codium workflow summaries omit inclusive figures from rows and advice without changing internal learning", async () => {
    // The internal and HTTP reads must use the same decay instant. One half-life also gives the ordinary row a
    // meaningful, exactly representable weight instead of a scheduler-dependent (weight * 1200) / weight roundoff.
    const now = Date.UTC(2026, 10, 14)
    setSystemTime(now)
    try {
      await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
      const where = await place(tmp.path)
      await record(where, [
        ...runs("thorough", "default", 0).map((row) => ({
          ...row,
          costUsd: undefined,
          costKinds: { priced: 1, codium: 2 },
          unpricedSteps: 2,
          tokens: { input: 500, output: 0, reasoning: 0, cacheRead: 0 },
        })),
        ...runs("thorough", "high", 0, 8, 2).map((row) => ({
          ...row,
          costUsd: undefined,
          costKinds: { codium: 3 },
          unpricedSteps: 3,
        })),
        { ...run(0, "light", "default", 0), providerID: "vector-plan", costKinds: { codium: 3 }, unpricedSteps: 3 },
        { ...run(0, "standard", "default", 0.2), at: now - BrainCredit.HALF_LIFE },
      ])
      const internal = await runtime.runPromise(
        Effect.gen(function* () {
          const workflow = yield* BrainWorkflow.Service
          return yield* workflow.insights(where)
        }),
      )
      const insights = (await json(await call(tmp.path, "GET", "/memory/workflow"))) as BrainWorkflow.Insights
      expect(
        await runtime.runPromise(
          Effect.gen(function* () {
            const workflow = yield* BrainWorkflow.Service
            return yield* workflow.insights(where)
          }),
        ),
      ).toEqual(internal)
      for (const tier of insights.tiers.filter((tier) => tier.tier !== "standard")) {
        for (const arm of tier.arms) {
          expect(arm.codium).toBeDefined()
          expect(arm).not.toHaveProperty("tokens")
          expect(arm).not.toHaveProperty("costUsd")
        }
      }
      const advice = insights.tiers.find((tier) => tier.tier === "thorough")!.advice!
      expect(advice.effort).toBe("default")
      expect(advice.reason).toContain("(unknown + Codium)")
      expect(advice.reason).not.toContain("tokens")
      expect(advice.basis.chosen).not.toHaveProperty("tokens")
      expect(advice.basis.instead).not.toHaveProperty("tokens")
      expect(internal.tiers.find((tier) => tier.tier === "thorough")!.advice!.basis.chosen.tokens).toBeCloseTo(500)
      expect(insights.tiers.find((tier) => tier.tier === "standard")!.arms[0]).toMatchObject({
        tokens: 1200,
        costUsd: 0.2,
        weight: 0.5,
        pricedWeight: 0.5,
      })
      expect(insights.tiers.find((tier) => tier.tier === "standard")!.arms).toEqual(
        internal.tiers.find((tier) => tier.tier === "standard")!.arms,
      )
    } finally {
      setSystemTime()
    }
  }, 30_000)
})
