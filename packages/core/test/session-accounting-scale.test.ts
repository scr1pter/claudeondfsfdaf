import { expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { eq } from "drizzle-orm"
import { LLM, Model } from "@vectordevai/llm"
import { OpenAIChat } from "@vectordevai/llm/protocols/openai-chat"
import { Database } from "@vectordevai/core/database/database"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionEvent } from "@vectordevai/core/session/event"
import { SessionMessage } from "@vectordevai/core/session/message"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SpendGuard.node])),
)
const contexts = [40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 148_000, 272_000, 300_000]
const models = [
  SessionRunnerModel.withPricing(Model.make({ id: "scale-a", provider: "fixture", route: OpenAIChat.route }), [
    { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } },
    { tier: { type: "context", size: 272_000 }, input: 4, output: 15, cache: { read: 0.2, write: 5 } },
  ]),
  SessionRunnerModel.withPricing(Model.make({ id: "scale-b", provider: "fixture", route: OpenAIChat.route }), [
    { input: 3, output: 12, cache: { read: 0.3, write: 3.75 } },
    { tier: { type: "context", size: 272_000 }, input: 6, output: 18, cache: { read: 0.6, write: 7.5 } },
  ]),
]

it.effect(
  "conserves one billion logical input tokens across 10K priced attempts, ancestors, replay and late helpers",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const guard = yield* SpendGuard.Service
      const ids = ["root", "child", "sibling", "judge", "helper"].map((name) => SessionV2.ID.make(`ses_scale_${name}`))
      const [root, child, sibling, judge, helper] = ids
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/scale"), sandboxes: [] })
        .run()
      yield* database.db
        .insert(SessionTable)
        .values(
          ids.map((id, index) => ({
            id,
            parent_id: index === 0 ? undefined : index < 3 ? root : child,
            ...(index === 4 ? { internal: "vectorscope.review" } : {}),
            project_id: Project.ID.global,
            slug: id,
            title: id,
            directory: "/scale",
            version: "test",
          })),
        )
        .run()
      yield* guard.begin(root, { usd: 10_000 })
      yield* guard.link(child, root, { budget: { usd: 5_000 }, batch: { id: "scale-batch", budget: { usd: 8_000 } } })
      yield* guard.link(sibling, root, { budget: { usd: 5_000 }, batch: { id: "scale-batch", budget: { usd: 8_000 } } })
      yield* guard.link(judge, child, { budget: { usd: 5_000 } })
      yield* guard.link(helper, child, { budget: { usd: 5_000 } })
      const captured = yield* Effect.forEach(ids, (id) => guard.capture(id))
      // Genuine request objects establish that accounting cannot change model/effort, prompt or tools. None are sent.
      const requests = models.map((model) =>
        LLM.request({
          model,
          prompt: "Bounded accounting fixture; no inference is performed.",
          generation: { maxTokens: 2_500 },
          providerOptions: { openai: { reasoningEffort: "high" } },
          tools: [
            {
              name: "read",
              description: "Read the fixture",
              inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
        }),
      )
      const before = requests.map((request) => JSON.stringify(request))
      const oracle = ids.map(() => ({ nanoUsd: 0n, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }))
      let inputTotal = 0

      // Each ten records total exactly 1M input tokens. These are realistic per-request usage counters, never a
      // billion-token prompt. BigInt nano-dollar arithmetic is independent of the production floating-point sums.
      for (let index = 0; index < 10_000; index++) {
        if (index === 9_000) {
          yield* guard.end(root)
          yield* guard.begin(root, { usd: 1 })
        }
        const owner = Math.floor(index / 2_000)
        const modelIndex = Math.floor(index / contexts.length) % 2
        const model = models[modelIndex]
        const context = contexts[index % contexts.length]
        const tokens = {
          input: context - (index % 3 === 0 ? 0 : context / 2) - (index % 3 === 0 ? context / 4 : 0),
          output: 2_000 + (index % 17),
          reasoning: (index % 5) * 100,
          cache: { read: index % 3 === 0 ? 0 : context / 2, write: index % 3 === 0 ? context / 4 : 0 },
        }
        // Independently specified nano-USD per token, using this request's own input context and model identity.
        const rate =
          modelIndex === 0
            ? context > 272_000
              ? [4_000n, 15_000n, 200n, 5_000n]
              : [2_000n, 10_000n, 100n, 2_500n]
            : context > 272_000
              ? [6_000n, 18_000n, 600n, 7_500n]
              : [3_000n, 12_000n, 300n, 3_750n]
        const expected =
          BigInt(tokens.input) * rate[0] +
          BigInt(tokens.output + tokens.reasoning) * rate[1] +
          BigInt(tokens.cache.read) * rate[2] +
          BigInt(tokens.cache.write) * rate[3]
        const cost = SessionRunnerModel.calculateCost(model, tokens)
        expect(cost).toBeCloseTo(Number(expected) / 1_000_000_000, 10)
        if (cost === undefined) return yield* Effect.die("Fixture unexpectedly lacks a price")
        const step = SessionRunnerModel.spendStep(model, { tokens }, { continues: false, patched: false })
        const ref = { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) }
        const timestamp = DateTime.makeUnsafe(index)
        const assistantMessageID = SessionMessage.ID.make(`msg_scale_${index}`)
        const usageID = EventV2.ID.create()
        const settlement =
          owner === 4
            ? yield* events.publish(
                SessionEvent.AncillaryUsage,
                { sessionID: ids[owner], timestamp, usageID, purpose: "memory", model: ref, cost, tokens },
                { id: usageID },
              )
            : yield* Effect.gen(function* () {
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: ids[owner],
                  timestamp,
                  assistantMessageID,
                  agent: owner === 3 ? "judge" : "build",
                  model: ref,
                })
                return yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ids[owner],
                  timestamp,
                  assistantMessageID,
                  finish: "stop",
                  cost,
                  tokens,
                })
              })
        yield* captured[owner].record(`attempt:${index}`, step)
        if (index % 997 === 0) yield* captured[owner].record(`attempt:${index}`, step)
        if (index % 1_000 === 0) {
          const stored = yield* database.db.select().from(EventTable).where(eq(EventTable.id, settlement.id)).get()
          if (!stored) return yield* Effect.die("Missing fixture settlement")
          yield* events.replay({
            id: stored.id,
            aggregateID: stored.aggregate_id,
            seq: stored.seq,
            type: stored.type,
            data: stored.data,
          })
          if (owner !== 4)
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: ids[owner],
              timestamp,
              assistantMessageID,
              finish: "stop",
              cost,
              tokens,
            })
        }
        oracle[owner].nanoUsd += expected
        oracle[owner].input += tokens.input
        oracle[owner].output += tokens.output
        oracle[owner].reasoning += tokens.reasoning
        oracle[owner].read += tokens.cache.read
        oracle[owner].write += tokens.cache.write
        inputTotal += context
      }

      expect(inputTotal).toBe(1_000_000_000)
      expect(requests.map((request) => JSON.stringify(request))).toEqual(before)
      const rows = yield* database.db.select().from(SessionTable).all()
      for (let index = 0; index < ids.length; index++) {
        const row = rows.find((row) => row.id === ids[index])
        expect(row).toBeDefined()
        if (!row) return yield* Effect.die("Missing fixture session")
        const descendants = index === 0 ? oracle.slice(1) : index === 1 ? oracle.slice(3) : []
        const direct = oracle[index]
        expect(row.cost).toBeCloseTo(Number(direct.nanoUsd) / 1_000_000_000, 7)
        expect([
          row.tokens_input,
          row.tokens_output,
          row.tokens_reasoning,
          row.tokens_cache_read,
          row.tokens_cache_write,
        ]).toEqual([direct.input, direct.output, direct.reasoning, direct.read, direct.write])
        expect(row.subagent_cost).toBeCloseTo(
          Number(descendants.reduce((sum, item) => sum + item.nanoUsd, 0n)) / 1_000_000_000,
          7,
        )
        expect([
          row.subagent_tokens_input,
          row.subagent_tokens_output,
          row.subagent_tokens_reasoning,
          row.subagent_tokens_cache_read,
          row.subagent_tokens_cache_write,
        ]).toEqual(
          ["input", "output", "reasoning", "read", "write"].map((key) =>
            descendants.reduce(
              (sum, item) => sum + item[key as "input" | "output" | "reasoning" | "read" | "write"],
              0,
            ),
          ),
        )
        expect(row.unpriced_steps).toBe(0)
        expect(row.subagent_unpriced_steps).toBe(0)
      }
      const totalUsd = Number(oracle.reduce((sum, item) => sum + item.nanoUsd, 0n)) / 1_000_000_000
      expect((yield* guard.snapshot(child))?.spentUsd).toBeCloseTo(totalUsd, 7)
      expect((yield* guard.snapshot(child))?.steps).toBe(10_000)
      expect((yield* guard.snapshot(root))?.spentUsd).toBe(0)
      const scopes = yield* guard.scopes(judge)
      expect(scopes).toHaveLength(4)
      expect(scopes.find((scope) => scope.kind === "batch")?.spentUsd).toBeCloseTo(
        Number(oracle.slice(1).reduce((sum, item) => sum + item.nanoUsd, 0n)) / 1_000_000_000,
        7,
      )
      yield* Effect.forEach(captured, (capture) => capture.release)
    }),
  120_000,
)
