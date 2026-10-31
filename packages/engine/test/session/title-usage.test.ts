import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionTable, SessionMessageTable } from "@vectordevai/core/session/sql"
import { LLMEvent, Usage } from "@vectordevai/llm"
import type { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { TitleUsage } from "@/session/title-usage"
import { Session } from "@/session/session"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SpendGuard.node])),
)
const sessionID = SessionID.make("ses_title_usage")
const model: Provider.Model = {
  id: ModelV2.ID.make("title-model"),
  providerID: ProviderV2.ID.make("title-provider"),
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 10,
    output: 20,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const setup = Effect.fn("test.titleUsage")(function* (selected = model) {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const guard = yield* SpendGuard.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "New session",
      version: "test",
    })
    .run()
  return {
    events,
    guard,
    usage: TitleUsage.create({ sessionID, model: selected, publish: events.publish }),
    records: database.db.select().from(EventTable).where(eq(EventTable.type, "session.next.ancillary.usage.2")).all(),
    session: database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
    messages: database.db.select().from(SessionMessageTable).all(),
  }
})

describe("usage uncertainty", () => {
  test("missing and partial paid usage keep uncertainty while retaining known subtotals", () => {
    expect(Session.getUsage({ model, usage: new Usage({}) })).toMatchObject({ cost: 0, unpriced: true })
    expect(Session.getUsage({ model, usage: new Usage({ inputTokens: 1_000 }) })).toMatchObject({
      cost: 0.01,
      unpriced: true,
    })
    expect(Session.getUsage({ model, usage: new Usage({ inputTokens: 0, outputTokens: 0 }) })).toMatchObject({
      cost: 0,
      unpriced: false,
    })
    expect(
      Session.getUsage({ model, usage: new Usage({ inputTokens: 1_000, outputTokens: 10 }), incomplete: true })
        .unpriced,
    ).toBe(true)
  })

  test("inclusive OpenAI usage prices cached input and reasoning once", () => {
    const priced = { ...model, cost: { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } } }
    const result = Session.getUsage({
      model: priced,
      usage: new Usage({
        inputTokens: 1_000,
        outputTokens: 120,
        reasoningTokens: 20,
        cacheReadInputTokens: 600,
        cacheWriteInputTokens: 100,
      }),
    })
    expect(result.tokens).toMatchObject({ input: 300, output: 100, reasoning: 20, cache: { read: 600, write: 100 } })
    expect(result.cost).toBeCloseTo(0.00211, 10)
    expect(result.unpriced).toBe(false)
  })

  test("invalid optional counters and impossible inclusive totals remain uncertain", () => {
    for (const invalid of [
      { reasoningTokens: Number.NaN },
      { cacheReadInputTokens: Number.POSITIVE_INFINITY },
      { cacheWriteInputTokens: -1 },
      { cacheReadInputTokens: 600, cacheWriteInputTokens: 500 },
      { reasoningTokens: 101 },
    ]) {
      expect(
        Session.getUsage({ model, usage: new Usage({ inputTokens: 1_000, outputTokens: 100, ...invalid }) }).unpriced,
      ).toBe(true)
    }
  })
})

for (const purpose of ["title", "memory"] as const) {
  it.effect(`${purpose} charges its captured active run exactly once`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      yield* test.guard.begin(sessionID, { usd: 0.1 })
      yield* test.guard.record(sessionID, {
        costKind: "priced",
        costUsd: 0.09,
        contextTokens: 0,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      })
      const spend = yield* test.guard.capture(sessionID)
      const usage = TitleUsage.create({ sessionID, model, purpose, publish: test.events.publish, spend })
      yield* usage.record(
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 3_000, outputTokens: 0 } }),
      )
      yield* usage.finish()
      yield* usage.finish()
      expect((yield* test.guard.snapshot(sessionID))?.spentUsd).toBeCloseTo(0.12)
      expect((yield* test.guard.stopped(sessionID))?.reason).toBe("cap")
      expect(yield* test.records).toHaveLength(1)
      expect((yield* test.session)?.cost).toBeCloseTo(0.03)
      yield* spend.release
    }),
  )
}

it.effect("a late helper preserves its launching cap and never bills the following run", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.guard.begin(sessionID, { usd: 0.02 })
    const spend = yield* test.guard.capture(sessionID)
    yield* test.guard.end(sessionID)
    yield* test.guard.begin(sessionID, { usd: 1 })
    const usage = TitleUsage.create({ sessionID, model, publish: test.events.publish, spend })
    yield* usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 3_000, outputTokens: 0 } }),
    )
    expect((yield* spend.stopped)?.reason).toBe("cap")
    expect((yield* test.guard.snapshot(sessionID))?.spentUsd).toBe(0)
    expect(yield* test.guard.stopped(sessionID)).toBeUndefined()
    expect((yield* test.session)?.cost).toBeCloseTo(0.03)
    yield* spend.release
  }),
)

it.effect("a complete gateway zero charge stays priced while incomplete usage retains a known bill", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.guard.begin(sessionID, { usd: 1, unpricedSteps: 1 })
    const spend = yield* test.guard.capture(sessionID)
    const unlisted = { ...model, cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true } }
    const usage = TitleUsage.create({
      sessionID,
      model: unlisted,
      publish: test.events.publish,
      spend,
      costKind: "unknown",
    })
    yield* usage.record(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 10, outputTokens: 1 },
        providerMetadata: { openrouter: { usage: { cost: 0 } } },
      }),
    )
    expect((yield* test.guard.snapshot(sessionID))?.unpricedSteps).toBe(0)
    expect(yield* test.guard.stopped(sessionID)).toBeUndefined()
    yield* usage.record(
      LLMEvent.stepFinish({ index: 1, reason: "stop", providerMetadata: { openrouter: { usage: { cost: 0.03 } } } }),
    )
    expect((yield* test.guard.snapshot(sessionID))?.spentUsd).toBeCloseTo(0.03)
    expect((yield* test.guard.snapshot(sessionID))?.costKind).toBe("priced")
    expect((yield* test.guard.snapshot(sessionID))?.unpricedSteps).toBe(0)
    expect(yield* test.guard.stopped(sessionID)).toBeUndefined()
    for (let index = 2; index < 43; index++) {
      yield* usage.record(
        LLMEvent.stepFinish({ index, reason: "stop", providerMetadata: { openrouter: { usage: { cost: 0 } } } }),
      )
    }
    expect((yield* test.guard.snapshot(sessionID))?.steps).toBe(43)
    expect((yield* test.guard.snapshot(sessionID))?.unpricedSteps).toBe(0)
    expect(yield* test.guard.stopped(sessionID)).toBeUndefined()
    yield* spend.release
  }),
)

it.effect("an unknown catalog with explicit zero counters and no measured bill stays unknown to the guard", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.guard.begin(sessionID, { usd: 1, unpricedSteps: 1 })
    const spend = yield* test.guard.capture(sessionID)
    const usage = TitleUsage.create({
      sessionID,
      model: { ...model, cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true } },
      publish: test.events.publish,
      spend,
      costKind: "unknown",
    })
    yield* usage.record(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }))
    expect(yield* test.guard.snapshot(sessionID)).toMatchObject({ costKind: "unknown", spentUsd: 0, unpricedSteps: 1 })
    expect((yield* test.guard.stopped(sessionID))?.reason).toBe("unpriced")
    yield* spend.release
  }),
)

for (const cost of [0, 0.0005]) {
  it.effect(`a catalog-priced helper persists and guards its provider-reported OpenRouter cost of $${cost}`, () =>
    Effect.gen(function* () {
      const test = yield* setup()
      yield* test.guard.begin(sessionID, { usd: 1, unpricedSteps: 1 })
      const spend = yield* test.guard.capture(sessionID)
      const usage = TitleUsage.create({ sessionID, model, publish: test.events.publish, spend })
      yield* usage.record(
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: { inputTokens: 1_000, outputTokens: 100 },
          providerMetadata: { openrouter: { usage: { cost } } },
        }),
      )
      yield* usage.finish()
      expect((yield* test.records)[0]?.data).toMatchObject({ cost })
      expect((yield* test.session)?.cost).toBe(cost)
      expect(yield* test.guard.snapshot(sessionID)).toMatchObject({ spentUsd: cost, unpricedSteps: 0 })
      expect(yield* test.guard.stopped(sessionID)).toBeUndefined()
      yield* spend.release
    }),
  )
}

it.effect("prices a title using its own model and settles once without transcript messages", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    test.usage.started({ inputTokens: 1_000, outputTokens: 0 })
    yield* Stream.make(
      LLMEvent.textDelta({ id: "title", text: "A title" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1_000, outputTokens: 50 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 1_000, outputTokens: 50 } }),
    ).pipe(Stream.tap(test.usage.record), Stream.runDrain, Effect.ensuring(test.usage.finish()))
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({
      purpose: "title",
      model: { providerID: "title-provider", id: "title-model" },
      cost: 0.011,
    })
    expect(records[0]?.data.unpriced).toBeUndefined()
    expect(records[0]?.data.incomplete).toBeUndefined()
    expect((yield* test.session)?.tokens_input).toBe(1_000)
    expect(yield* test.messages).toHaveLength(0)
  }),
)

it.effect("empty or later-failed title text does not discard reported usage", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
    )
    const failed = yield* Effect.fail("title stream failed").pipe(Effect.ensuring(test.usage.finish()), Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    expect(yield* test.records).toHaveLength(1)
    expect((yield* test.session)?.tokens_output).toBe(2)
  }),
)

it.effect("cancellation retains reported started usage as incomplete spend", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    test.usage.started({ inputTokens: 20, outputTokens: 0, cacheReadInputTokens: 5 })
    yield* Effect.interrupt.pipe(Effect.ensuring(test.usage.finish()), Effect.exit)
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({
      incomplete: true,
      unpriced: true,
      tokens: { input: 15, cache: { read: 5 } },
    })
    expect((yield* test.session)?.unpriced_steps).toBe(1)
  }),
)

it.effect("separate billed attempts retain distinct identities even when step indexes repeat", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    test.usage.started({ inputTokens: 10, outputTokens: 0 })
    test.usage.started({ inputTokens: 20, outputTokens: 0 })
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 20, outputTokens: 3 } }),
    )
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 30, outputTokens: 4 } }),
    )
    yield* test.usage.finish()
    const records = yield* test.records
    expect(records).toHaveLength(3)
    expect(new Set(records.map((event) => event.data.usageID)).size).toBe(3)
    expect((yield* test.session)?.tokens_input).toBe(60)
    expect((yield* test.session)?.unpriced_steps).toBe(1)
  }),
)

it.effect("confirmed title steps without usage stay unknown without invented counts", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.finish()
    expect(yield* test.records).toHaveLength(0)
    yield* test.usage.record(LLMEvent.stepFinish({ index: 0, reason: "stop" }))
    yield* test.usage.record(LLMEvent.stepFinish({ index: 1, reason: "stop", usage: {} }))
    yield* test.usage.finish()
    const records = yield* test.records
    expect(records).toHaveLength(2)
    expect(
      records.every(
        (event) => event.data.tokens === undefined && event.data.cost === undefined && event.data.incomplete === true,
      ),
    ).toBe(true)
    expect((yield* test.session)?.unpriced_steps).toBe(2)
  }),
)

it.effect("partial reports and unknown model pricing remain unpriced", () =>
  Effect.gen(function* () {
    const test = yield* setup({ ...model, cost: { ...model.cost, unpriced: true } })
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
    )
    yield* test.usage.record(LLMEvent.stepFinish({ index: 1, reason: "stop", usage: { inputTokens: 15 } }))
    const records = yield* test.records
    expect(records).toHaveLength(2)
    expect(records[0]?.data.unpriced).toBe(true)
    expect(records[1]?.data.incomplete).toBe(true)
    expect((yield* test.session)?.unpriced_steps).toBe(2)
  }),
)

it.effect("interrupted generation without terminal usage records unknown spend, not free output", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.record(LLMEvent.textDelta({ id: "title", text: "Partial title" }))
    yield* Effect.interrupt.pipe(Effect.ensuring(test.usage.finish()), Effect.exit)
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({ incomplete: true, unpriced: true })
    expect(records[0]?.data.tokens).toBeUndefined()
    expect(records[0]?.data.cost).toBeUndefined()
  }),
)

it.effect("an interrupted started helper without output still records an unknown attempt", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.record(LLMEvent.stepStart({ index: 0 }))
    yield* test.usage.finish()
    expect(yield* test.records).toHaveLength(1)
    expect((yield* test.records)[0]?.data).toMatchObject({ incomplete: true, unpriced: true })
  }),
)

it.effect("an explicitly reported zero-token title is distinguishable from missing usage", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }),
    )
    const records = yield* test.records
    expect(records[0]?.data.cost).toBe(0)
    expect(records[0]?.data.incomplete).toBeUndefined()
    expect((yield* test.session)?.unpriced_steps).toBe(0)
  }),
)

it.effect("retains a Copilot metadata-only title charge without inventing token counters", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    yield* test.usage.record(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        providerMetadata: { copilot: { totalNanoAiu: 3_000_000_000 } },
      }),
    )
    yield* test.usage.finish()
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({ cost: 0.03, incomplete: true, unpriced: true })
    expect(records[0]?.data.tokens).toBeUndefined()
    expect(yield* test.session).toMatchObject({ cost: 0.03, unpriced_steps: 1, tokens_input: 0, tokens_output: 0 })
  }),
)

it.effect("retains an explicit metadata-only zero bill with unknown token counters", () =>
  Effect.gen(function* () {
    const test = yield* setup({ ...model, cost: { ...model.cost, unpriced: true } })
    yield* test.usage.record(
      LLMEvent.stepFinish({ index: 0, reason: "stop", providerMetadata: { openrouter: { usage: { cost: 0 } } } }),
    )
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({ cost: 0, incomplete: true, unpriced: true })
    expect(records[0]?.data.tokens).toBeUndefined()
  }),
)

it.effect("retains an unpriced OpenRouter metadata-only charge when title generation later fails", () =>
  Effect.gen(function* () {
    const test = yield* setup({ ...model, cost: { ...model.cost, unpriced: true } })
    yield* test.usage.record(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        providerMetadata: { openrouter: { usage: { cost: 0.05 } } },
      }),
    )
    const failed = yield* Effect.fail("title stream failed").pipe(Effect.ensuring(test.usage.finish()), Effect.exit)
    expect(Exit.isFailure(failed)).toBe(true)
    const records = yield* test.records
    expect(records).toHaveLength(1)
    expect(records[0]?.data).toMatchObject({ cost: 0.05, incomplete: true, unpriced: true })
    expect(records[0]?.data.tokens).toBeUndefined()
    expect(yield* test.session).toMatchObject({ cost: 0.05, unpriced_steps: 1, tokens_input: 0, tokens_output: 0 })
  }),
)

it.effect("a Codium title's spend persists once as tokens and stays out of the dollar cost", () =>
  Effect.gen(function* () {
    // As Provider.fromModelPlans lists Codium models: credits, not a dollar price.
    const test = yield* setup({
      ...model,
      providerID: ProviderV2.ID.make("vector-plan"),
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true },
    })
    yield* test.usage.record(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 200, outputTokens: 6 },
        // A dollar charge an older gateway forwarded is not a Codium cost either.
        providerMetadata: { codium: { cost: 0.000031 } },
      }),
    )
    yield* test.usage.finish()
    expect(yield* test.records).toHaveLength(1)
    expect((yield* test.records)[0]?.data).toMatchObject({ purpose: "title", cost: 0, unpriced: true })
    expect(yield* test.session).toMatchObject({ cost: 0, unpriced_steps: 1, tokens_input: 200, tokens_output: 6 })
    expect(yield* test.messages).toHaveLength(0)
  }),
)
