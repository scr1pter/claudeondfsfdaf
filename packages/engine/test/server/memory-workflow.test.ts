import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
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
})
