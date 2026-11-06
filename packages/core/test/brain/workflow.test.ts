import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainWorkflowRunTable } from "@vectordevai/core/brain/sql"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { Global } from "@vectordevai/core/global"
import { tmpdir } from "../fixture/tmpdir"

// Self-tuned workflows (section 6): statistics per arm, and advice that may only make work cheaper.

const NOW = Date.UTC(2026, 9, 25)
const DAY = 24 * 60 * 60 * 1000

let counter = 0
function obs(patch: Partial<BrainWorkflow.Observation> = {}): BrainWorkflow.Observation {
  counter++
  return {
    sessionID: "ses_a",
    requestID: `msg_${counter}`,
    at: NOW,
    tier: "thorough",
    effortTier: "thorough",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    effort: "high",
    effortSource: "size",
    subagents: 0,
    subagentModels: {},
    judgeRounds: 0,
    outcome: "pass",
    signal: "recovered",
    costUsd: 1,
    costKinds: { priced: 4 },
    steps: 4,
    unpricedSteps: 0,
    tokens: { input: 1000, output: 0, reasoning: 0, cacheRead: 0 },
    partial: false,
    ...patch,
  }
}

const many = (count: number, patch: Partial<BrainWorkflow.Observation> = {}) =>
  Array.from({ length: count }, () => obs(patch))

// n runs with `passed` passes.
const runs = (count: number, passed: number, patch: Partial<BrainWorkflow.Observation> = {}) => [
  ...many(passed, patch),
  ...many(count - passed, { ...patch, outcome: "fail", signal: "check-fail" }),
]

const advise = (
  rows: readonly BrainWorkflow.Observation[],
  patch: Partial<Parameters<typeof BrainWorkflow.advise>[0]> = {},
) =>
  BrainWorkflow.advise({
    stats: BrainWorkflow.stats(rows, NOW),
    effortTier: "thorough",
    providerID: "anthropic",
    modelID: "claude",
    defaultEffort: "high",
    subagentsOffered: false,
    namedSubagents: false,
    smallCheaper: false,
    explore: false,
    requestID: "msg_x",
    ...patch,
  })

describe("BrainWorkflow.stats", () => {
  test("weighs runs by age, bounds the pass rate from below and counts the share that was checked", () => {
    const [arm] = BrainWorkflow.stats(
      [
        obs({ at: NOW }),
        obs({ at: NOW - 90 * DAY, outcome: "fail" }),
        obs({ at: NOW, outcome: "none", signal: undefined, costUsd: undefined, costKinds: { priced: 1, unknown: 1 } }),
        obs({ at: NOW, partial: true, costUsd: 9 }),
      ],
      NOW,
    )
    expect(arm!.rows).toBe(4)
    expect(arm!.weight).toBeCloseTo(3.5)
    expect(arm!.signal).toBeCloseTo(2.5)
    expect(arm!.passRate).toBeCloseTo(2 / 2.5)
    expect(arm!.lower!).toBeLessThan(arm!.passRate!)
    expect(arm!.lower!).toBeGreaterThan(0)
    expect(arm!.checkedShare).toBeCloseTo(2.5 / 3.5)
    // A partial run never feeds cost; a run with an unpriced step has none.
    expect(arm!.costUsd).toBeCloseTo(1)
    expect(arm!.pricedWeight).toBeCloseTo(1.5)
  })

  test("runs someone chose the effort of, mixed runs and runs that read the web are left out", () => {
    const left = BrainWorkflow.stats(
      [
        ...(["user", "agent", "config", "explicit", "mixed"] as const).map((effortSource) => obs({ effortSource })),
        obs({ taint: "web" }),
        obs({ effort: "mixed" }),
        obs({ taint: "mcp" }),
        obs({ effortSource: "learned" }),
      ],
      NOW,
    )
    expect(left.map((arm) => arm.rows)).toEqual([2])
  })
})

describe("BrainWorkflow.advise", () => {
  test("drops Thorough's high effort to default only with enough runs, as often passing, for 20% less", () => {
    const high = runs(10, 8)
    const cheap = (count: number, cost: number, extra: Partial<BrainWorkflow.Observation> = {}) =>
      runs(count, count, { effort: "default", costUsd: cost, ...extra })
    expect(advise([...high, ...cheap(10, 0.5)])).toMatchObject({ effort: "default", source: "learned" })
    expect(advise([...high, ...cheap(5, 0.5)])).toBeUndefined()
    expect(advise([...runs(5, 4), ...cheap(10, 0.5)])).toBeUndefined()
    // Within MARGIN of the default's pass rate: 8 of 10 leaves room, 9 of 10 does not.
    expect(advise([...runs(10, 9), ...cheap(10, 0.5)])).toBeUndefined()
    // The cost ratio: 0.8 of the default's cost is enough, a little more is not.
    expect(advise([...high, ...cheap(10, 0.8)])).toMatchObject({ effort: "default" })
    expect(advise([...high, ...cheap(10, 0.81)])).toBeUndefined()
    // The checked share: one unchecked run in eleven is within MARGIN, three in thirteen is not.
    const unchecked = (count: number) =>
      many(count, { effort: "default", costUsd: 0.5, outcome: "none", signal: undefined })
    expect(advise([...high, ...cheap(10, 0.5), ...unchecked(1)])).toMatchObject({ effort: "default" })
    expect(advise([...high, ...cheap(10, 0.5), ...unchecked(3)])).toBeUndefined()
    // A revert counts as a failure.
    expect(
      advise([
        ...high,
        ...runs(10, 7, { effort: "default", costUsd: 0.5 }),
        ...many(3, { effort: "default", costUsd: 0.5, outcome: "revert" }),
      ]),
    ).toBeUndefined()
  })

  test("the reason says what was compared, with the counts and costs", () => {
    const advice = advise([...runs(10, 8), ...runs(10, 10, { effort: "default", costUsd: 0.41 })])!
    expect(advice.reason).toBe(
      "Thorough work here passed 10 of 10 checked runs at default effort (avg $0.41) against 8 of 10 at high (avg $1.00).",
    )
    expect(BrainWorkflow.explain(advice)).toBe(advice.reason)
  })

  test("only Thorough's effort moves, never upward, and nothing adds subagents", () => {
    const standard = (patch: Partial<BrainWorkflow.Observation>) => ({
      effortTier: "standard" as const,
      tier: "standard" as const,
      ...patch,
    })
    // Standard runs at the model's default: a cheaper "low" arm is never a candidate.
    expect(
      advise(
        [...runs(10, 8, standard({ effort: "default" })), ...runs(10, 10, standard({ effort: "low", costUsd: 0.2 }))],
        {
          effortTier: "standard",
          defaultEffort: "default",
        },
      ),
    ).toBeUndefined()
    // Cheaper subagent runs never add subagents to work that runs solo.
    expect(
      advise(
        [
          ...runs(10, 8, standard({ effort: "default" })),
          ...runs(10, 10, standard({ effort: "default", subagents: 2, subagentModel: "parent", costUsd: 0.2 })),
        ],
        { effortTier: "standard", defaultEffort: "default", subagentsOffered: true, smallCheaper: true },
      ),
    ).toBeUndefined()
    // Default effort that did worse than high is not advised the other way.
    expect(
      advise([...runs(10, 10, { costUsd: 0.5 }), ...runs(10, 5, { effort: "default", costUsd: 1 })]),
    ).toBeUndefined()
  })

  test("unknown cost falls back to tokens of the same model for effort, but never for splits or subagent models", () => {
    const unpriced = { costUsd: undefined, costKinds: { local: 4 } }
    expect(
      advise([
        ...runs(10, 8, unpriced),
        ...runs(10, 10, {
          ...unpriced,
          effort: "default",
          tokens: { input: 800, output: 0, reasoning: 0, cacheRead: 0 },
        }),
      ]),
    ).toMatchObject({ effort: "default" })
    expect(
      advise([
        ...runs(10, 8, unpriced),
        ...runs(10, 10, {
          ...unpriced,
          effort: "default",
          tokens: { input: 900, output: 0, reasoning: 0, cacheRead: 0 },
        }),
      ]),
    ).toBeUndefined()
    const split = (patch: Partial<BrainWorkflow.Observation>) =>
      advise(
        [
          ...runs(10, 8, { effort: "default", subagents: 2, subagentModel: "parent", ...patch }),
          ...runs(10, 10, {
            effort: "default",
            ...patch,
            tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0 },
          }),
        ],
        { subagentsOffered: true, defaultEffort: "default" },
      )
    expect(split(unpriced)).toBeUndefined()
    expect(split({ costUsd: 1 })).toBeUndefined()
    expect(
      advise(
        [
          ...runs(10, 8, { effort: "default", subagents: 2, subagentModel: "parent" }),
          ...runs(10, 10, { effort: "default", costUsd: 0.5 }),
        ],
        { subagentsOffered: true, defaultEffort: "default" },
      ),
    ).toMatchObject({ split: "solo", source: "learned" })
    expect(
      advise(
        [
          ...runs(10, 8, { effort: "default", subagents: 2, subagentModel: "parent" }),
          ...runs(10, 10, { effort: "default", costUsd: 0.5 }),
        ],
        { subagentsOffered: true, defaultEffort: "default", namedSubagents: true },
      ),
    ).toBeUndefined()
    const model = (patch: Partial<BrainWorkflow.Observation>) =>
      advise(
        [
          ...runs(10, 8, { effort: "default", subagents: 2, subagentModel: "parent", ...patch }),
          ...runs(10, 10, {
            effort: "default",
            subagents: 2,
            subagentModel: "small",
            ...patch,
            costUsd: patch.costUsd === undefined ? undefined : 0.5,
            tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0 },
          }),
        ],
        { defaultEffort: "default", smallCheaper: true },
      )
    expect(model(unpriced)).toBeUndefined()
    expect(model({ costUsd: 1 })).toMatchObject({ subagentModel: "small" })
  })

  test("exploration is off by default, draws per request the same way every time, and tries only cheaper-by-construction settings", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `msg_explore_${index}`)
    const thorough = ids.map((requestID) => advise([], { explore: true, requestID, smallCheaper: true }))
    const drawn = thorough.filter((advice) => advice !== undefined)
    expect(drawn.length).toBeGreaterThan(5)
    expect(drawn.length).toBeLessThan(45)
    expect(
      drawn.every((advice) => advice!.source === "explore" && advice!.effort === "default" && !advice!.split),
    ).toBe(true)
    expect(ids.map((requestID) => advise([], { explore: true, requestID, smallCheaper: true }))).toEqual(thorough)
    expect(ids.every((requestID) => advise([], { requestID }) === undefined)).toBe(true)
    // With default effort, only the small subagent model is tried; working solo never is.
    const standard = ids.map((requestID) =>
      advise([], { explore: true, requestID, defaultEffort: "default", smallCheaper: true, subagentsOffered: true }),
    )
    expect(
      standard
        .filter((advice) => advice !== undefined)
        .every((advice) => advice!.subagentModel === "small" && !advice!.split),
    ).toBe(true)
    expect(
      ids.every(
        (requestID) =>
          advise([], { explore: true, requestID, defaultEffort: "default", subagentsOffered: true }) === undefined,
      ),
    ).toBe(true)
  })
})

type Setup = {
  readonly brain: Brain.Interface
  readonly workflow: BrainWorkflow.Interface
  readonly db: BrainDatabase.Database
}

async function run<A>(body: (setup: Setup, place: Brain.Place) => Effect.Effect<A>) {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const data = path.join(tmp.path, "data")
  await Promise.all([config, data].map((dir) => fs.mkdir(dir, { recursive: true })))
  const base = Brain.layer.pipe(
    Layer.provideMerge(BrainDatabase.layerFor(":memory:")),
    Layer.provide(Layer.succeed(Global.Service, Global.make({ config, data }))),
  )
  return await Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(
        { brain: yield* Brain.Service, workflow: yield* BrainWorkflow.Service, db: (yield* BrainDatabase.Service).db },
        { repository: "repo-1", root: tmp.path, sources: [], held: false },
      )
    }).pipe(Effect.provide(BrainWorkflow.layer.pipe(Layer.provideMerge(base)))),
  )
}

const rows = (setup: Setup) => setup.db.select().from(BrainWorkflowRunTable).all().pipe(Effect.orDie)

describe("BrainWorkflow store", () => {
  test("a request run twice adds up, marks a changed effort mixed, and never counts an unpriced step's cost as zero", async () => {
    const result = await run((setup, place) =>
      Effect.gen(function* () {
        yield* setup.workflow.record(place, obs({ requestID: "msg_twice", costUsd: 1 }))
        yield* setup.workflow.record(
          place,
          obs({
            requestID: "msg_twice",
            effort: "default",
            effortSource: "learned",
            costUsd: 2,
            outcome: "fail",
            subagents: 1,
            subagentModel: "small",
            subagentModels: { "p/small": 1 },
          }),
        )
        yield* setup.workflow.record(
          place,
          obs({ requestID: "msg_local", costUsd: 3, costKinds: { priced: 2, local: 1 } }),
        )
        return yield* rows(setup)
      }),
    )
    expect(result.find((row) => row.request_id === "msg_twice")).toMatchObject({
      runs: 2,
      effort: "mixed",
      effort_source: "mixed",
      cost_usd: 3,
      cost_kinds: { priced: 8 },
      steps: 8,
      tokens_input: 2000,
      outcome: "fail",
      subagents: 1,
      subagent_model: "small",
      subagent_models: { "p/small": 1 },
    })
    expect(result.find((row) => row.request_id === "msg_local")?.cost_usd).toBeNull()
  })

  test("keeps a year and 2,000 runs per repository, records nothing when off, and advises only in apply mode", async () => {
    const result = await run((setup, place) =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* setup.workflow.record(place, obs({ requestID: "msg_first", at: now }))
        yield* setup.db
          .insert(BrainWorkflowRunTable)
          .values([
            {
              ...row(obs({ requestID: "msg_old", at: now - 366 * DAY })),
              repository_id: "repo-1",
            },
            ...Array.from({ length: 2000 }, (_, index) => ({
              ...row(obs({ requestID: `msg_bulk_${index}`, at: now - DAY + index })),
              repository_id: "repo-1",
            })),
          ])
          .run()
          .pipe(Effect.orDie)
        yield* setup.workflow.record(place, obs({ requestID: "msg_last", at: now }))
        const kept = yield* rows(setup)
        const thorough = {
          effortTier: "thorough" as const,
          providerID: "anthropic",
          modelID: "claude",
          defaultEffort: "high" as const,
          subagentsOffered: false,
          namedSubagents: false,
          smallCheaper: false,
          requestID: "msg_x",
        }
        yield* setup.db.delete(BrainWorkflowRunTable).run().pipe(Effect.orDie)
        yield* Effect.forEach(
          [...runs(10, 8, { at: now }), ...runs(10, 10, { effort: "default", costUsd: 0.5, at: now })],
          (item) => setup.workflow.record(place, item),
        )
        const applied = yield* setup.workflow.advice(place, thorough)
        yield* setup.brain.setLearnSettings({ workflow: "observe" })
        const observed = yield* setup.workflow.advice(place, thorough)
        const insights = yield* setup.workflow.insights(place)
        yield* setup.brain.setLearnSettings({ workflow: "off" })
        yield* setup.workflow.record(place, obs({ requestID: "msg_off" }))
        const off = yield* setup.db
          .select()
          .from(BrainWorkflowRunTable)
          .where(eq(BrainWorkflowRunTable.request_id, "msg_off"))
          .all()
          .pipe(Effect.orDie)
        return { kept, applied, observed, insights, off }
      }),
    )
    expect(result.kept).toHaveLength(2000)
    expect(result.kept.some((item) => item.request_id === "msg_old")).toBe(false)
    // Past 2,000, the oldest go first.
    expect(result.kept.filter((item) => ["msg_bulk_0", "msg_bulk_1"].includes(item.request_id))).toEqual([])
    expect(result.kept.some((item) => item.request_id === "msg_bulk_2")).toBe(true)
    expect(result.kept.some((item) => item.request_id === "msg_first")).toBe(true)
    expect(result.kept.some((item) => item.request_id === "msg_last")).toBe(true)
    expect(result.applied).toMatchObject({ effort: "default", source: "learned" })
    expect(result.observed).toBeUndefined()
    const thorough = result.insights.tiers.find((tier) => tier.tier === "thorough")!
    expect(result.insights).toMatchObject({ mode: "observe", explore: false })
    expect(thorough.advice).toBeUndefined()
    expect(thorough.wouldAdvise).toMatchObject({ effort: "default" })
    expect(thorough.arms).toHaveLength(2)
    expect(result.off).toEqual([])
  })

  test("a revert marks its requests, and a reset forgets one size or all of them", async () => {
    const result = await run((setup, place) =>
      Effect.gen(function* () {
        yield* setup.workflow.record(place, obs({ requestID: "msg_a" }))
        yield* setup.workflow.record(place, obs({ requestID: "msg_b", sessionID: "ses_b" }))
        yield* setup.workflow.record(
          place,
          obs({ requestID: "msg_c", tier: "standard", effortTier: "standard", effort: "default" }),
        )
        const reverted = yield* setup.workflow.reverted(place, { sessionID: "ses_a", requests: ["msg_a", "msg_b"] })
        const outcomes = (yield* rows(setup)).map((item) => [item.request_id, item.outcome])
        const insights = yield* setup.workflow.insights(place)
        const thorough = yield* setup.workflow.reset(place, { tier: "thorough" })
        const left = (yield* rows(setup)).map((item) => item.request_id)
        const all = yield* setup.workflow.reset(place)
        return { reverted, outcomes, insights, thorough, left, all }
      }),
    )
    expect(result.reverted).toBe(1)
    expect(result.outcomes).toEqual([
      ["msg_a", "revert"],
      ["msg_b", "pass"],
      ["msg_c", "pass"],
    ])
    expect(result.insights.tiers.map((tier) => [tier.tier, tier.arms.length])).toEqual([
      ["light", 0],
      ["standard", 1],
      ["thorough", 1],
    ])
    expect(result.thorough).toBe(2)
    expect(result.left).toEqual(["msg_c"])
    expect(result.all).toBe(1)
  })
})

function row(item: BrainWorkflow.Observation) {
  return {
    session_id: item.sessionID,
    request_id: item.requestID,
    at: item.at,
    tier: item.tier,
    effort_tier: item.effortTier,
    agent: item.agent,
    provider_id: item.providerID,
    model_id: item.modelID,
    effort: item.effort,
    effort_source: item.effortSource,
    subagents: item.subagents,
    subagent_models: item.subagentModels,
    judge_rounds: item.judgeRounds,
    outcome: item.outcome,
    cost_usd: item.costUsd ?? null,
    cost_kinds: item.costKinds,
    steps: item.steps,
    unpriced_steps: item.unpricedSteps,
    tokens_input: item.tokens.input,
    tokens_output: item.tokens.output,
    tokens_reasoning: item.tokens.reasoning,
    tokens_cache_read: item.tokens.cacheRead,
  }
}
