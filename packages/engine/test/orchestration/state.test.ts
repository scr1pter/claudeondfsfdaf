import { describe, expect } from "bun:test"
import { Effect, Layer, Result } from "effect"
import { SessionID, MessageID } from "@/session/schema"
import type { WorkflowRunner } from "@/orchestration/runner"
import { WorkflowState } from "@/orchestration/state"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const producer = SessionID.make("ses_state_producer")
const verifier = SessionID.make("ses_state_verifier")
const producerMessage = MessageID.make("msg_state_producer")
const verifierMessage = MessageID.make("msg_state_verifier")
const counters = (): WorkflowRunner.Counters => ({ launched: 2, steps: 5, tokens: 123, spentUsd: 0.03, elapsedMs: 456 })
const usage = () => ({
  cost: 0.03,
  steps: 5,
  toolUses: 2,
  total: 123,
  tokens: { input: 100, output: 15, reasoning: 8, cache: { read: 4, write: 3 } },
  unpricedSteps: 3,
  codiumSteps: 2,
})
const node = (fields: Partial<WorkflowRunner.Node> = {}): WorkflowRunner.Node => ({
  key: "node-a",
  stage: "group.produce",
  phase: "review",
  item: "item-a",
  itemKey: "item-a",
  value: { file: "a.ts" },
  index: 3,
  source: "a.ts",
  status: "completed",
  round: 1,
  verified: false,
  sessionID: producer,
  outputMessageID: producerMessage,
  outputStructured: false,
  verifierID: verifier,
  feedbackMessageID: verifierMessage,
  output: "small result",
  feedback: { approved: false },
  final: false,
  execution: "repair",
  retriesDone: 1,
  settledOrder: 7,
  ...fields,
})
const state = (nodes: readonly WorkflowRunner.Node[] = [node()]): WorkflowRunner.State => ({
  nodes,
  usage: counters(),
  groups: { group: counters() },
  sessions: { [producer]: usage(), [verifier]: usage() },
  sessionGroups: { [producer]: "group", [verifier]: "group" },
  uncertain: true,
  files: { "group.produce": { digest: "a".repeat(64), path: "/output/workflow.json" } },
})
const refused = Effect.fnUntraced(function* <A>(effect: Effect.Effect<A, WorkflowState.StateError>) {
  const result = yield* Effect.result(effect)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error("Expected workflow state refusal")
  expect(result.failure).toBeInstanceOf(WorkflowState.StateError)
  return result.failure
})
const noRead: WorkflowState.Read = () => Effect.die(new Error("No referenced answer should be read"))

describe("durable workflow checkpoints", () => {
  it.effect("preserves known token provenance without certifying legacy checkpoint usage", () =>
    Effect.gen(function* () {
      for (const proof of [undefined, false, true]) {
        const input = state()
        const stored = yield* WorkflowState.encode({
          ...input,
          sessions: Object.fromEntries(
            Object.entries(input.sessions).map(([id, value]) => [id, { ...value, tokensOwnOnly: proof }]),
          ),
        })
        const restored = yield* WorkflowState.hydrate(stored, { read: noRead })
        expect(restored.sessions[producer].tokensOwnOnly).toBe(proof)
        expect(restored.sessions[producer].total).toBe(123)
      }
    }),
  )

  it.effect("round-trips optional active clocks without changing cumulative elapsed counters", () =>
    Effect.gen(function* () {
      for (const active of [false, true]) {
        const input = { ...state(), clock: { at: 1234.5, active, groups: ["group"] } }
        const stored = yield* WorkflowState.encode(input)
        expect(stored.clock).toEqual(input.clock)
        const hydrated = yield* WorkflowState.hydrate(stored, { read: noRead })
        expect(hydrated.clock).toEqual(input.clock)
        expect(hydrated.usage.elapsedMs).toBe(input.usage.elapsedMs)
        expect(hydrated.groups.group.elapsedMs).toBe(input.groups.group.elapsedMs)
      }
      const legacy = yield* WorkflowState.hydrate(yield* WorkflowState.encode(state()), { read: noRead })
      expect(legacy.clock).toBeUndefined()
    }),
  )

  it.effect("refuses invalid clock shapes, timestamp bounds and duplicate or unknown groups", () =>
    Effect.gen(function* () {
      const stored = yield* WorkflowState.encode(state())
      for (const clock of [
        { at: -1, active: true, groups: [] },
        { at: NaN, active: true, groups: [] },
        { at: Infinity, active: true, groups: [] },
        { at: 0, active: "yes", groups: [] },
        { at: 0, active: true, groups: Array.from({ length: 33 }, (_, index) => `group${index}`) },
        { at: 0, active: true, groups: ["group", "group"] },
        { at: 0, active: true, groups: ["missing"] },
        { at: 0, active: true, groups: ["Uppercase"] },
        { at: 0, active: true, groups: [], extra: true },
      ]) {
        const error = yield* refused(WorkflowState.decode({ ...stored, clock }))
        expect(error.path).toContain("/clock")
      }
      const groups = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`group${index}`, counters()]))
      const input = {
        ...state(),
        groups: { ...groups },
        sessionGroups: {},
        clock: { at: 0, active: true, groups: Object.keys(groups) },
      }
      expect((yield* WorkflowState.encode(input)).clock?.groups).toHaveLength(32)
    }),
  )

  it.effect("round-trips accounting and execution state while discarding regenerable item values", () =>
    Effect.gen(function* () {
      const input = state([
        node({
          pendingLaunch: { key: "next-execution", verifier: false, round: 2 },
          pendingResult: {
            verifier: true,
            round: 1,
            result: {
              sessionID: verifier,
              messageID: verifierMessage,
              status: "completed",
              output: { approved: false },
              retryable: false,
              usage: usage(),
            },
          },
        }),
      ])
      const encoded = yield* WorkflowState.encode(input)
      expect(encoded.version).toBe(1)
      expect(encoded.nodes[0].value).toBeNull()
      expect(encoded.nodes[0].output).toEqual({ inline: "small result" })
      const hydrated = yield* WorkflowState.hydrate(JSON.parse(JSON.stringify(encoded)), { read: noRead })
      expect(hydrated).toEqual({ ...input, nodes: input.nodes.map((entry) => ({ ...entry, value: null })) })
      expect(input.nodes[0].value).toEqual({ file: "a.ts" })
      expect(hydrated.sessions[producer].unpricedSteps).toBe(3)
      expect(hydrated.sessions[producer].codiumSteps).toBe(2)
      expect(hydrated.nodes[0].settledOrder).toBe(7)
    }),
  )

  it.effect("uses JSON UTF-8 bytes at the exact inline boundary, including escaped and surrogate characters", () =>
    Effect.gen(function* () {
      for (const value of [
        "a".repeat(2046),
        "é".repeat(1023),
        "😀".repeat(511) + "aa",
        '"'.repeat(1023),
        "\u0000".repeat(341),
        "\ud800".repeat(341),
      ]) {
        expect(Buffer.byteLength(JSON.stringify(value))).toBe(WorkflowState.LIMIT.inlineBytes)
        const inline = yield* WorkflowState.encode(state([node({ output: value })]))
        expect(inline.nodes[0].output).toEqual({ inline: value })
        const referenced = yield* WorkflowState.encode(state([node({ output: value + "a" })]))
        expect(referenced.nodes[0].output).toMatchObject({
          ref: { bytes: 2049, sessionID: producer, messageID: producerMessage, structured: false },
        })
      }
    }),
  )

  it.effect("pins large producer, feedback and pending verifier values to their own exact assistant messages", () =>
    Effect.gen(function* () {
      const output = "original answer ".repeat(300)
      const feedback = { approved: false, reasons: "explanation ".repeat(300) }
      const pending = { approved: true, reasons: "verified ".repeat(300) }
      const pendingID = MessageID.make("msg_next_verifier")
      const input = state([
        node({
          output,
          feedback,
          pendingResult: {
            verifier: true,
            round: 2,
            result: { status: "completed", sessionID: verifier, messageID: pendingID, output: pending },
          },
        }),
      ])
      const encoded = yield* WorkflowState.encode(input)
      expect(encoded.nodes[0].output).toMatchObject({
        ref: { sessionID: producer, messageID: producerMessage, structured: false },
      })
      expect(encoded.nodes[0].feedback).toMatchObject({
        ref: { sessionID: verifier, messageID: verifierMessage, structured: true },
      })
      expect(encoded.nodes[0].pendingResult?.result.output).toMatchObject({
        ref: { sessionID: verifier, messageID: pendingID, structured: true },
      })
      expect(JSON.stringify(encoded)).not.toContain(output)
      const seen: Parameters<WorkflowState.Read>[0][] = []
      const hydrated = yield* WorkflowState.hydrate(encoded, {
        read: (ref) => {
          seen.push(ref)
          return Effect.succeed(
            ref.messageID === producerMessage ? output : ref.messageID === verifierMessage ? feedback : pending,
          )
        },
      })
      expect(seen).toEqual([
        { sessionID: producer, messageID: producerMessage, structured: false },
        { sessionID: verifier, messageID: verifierMessage, structured: true },
        { sessionID: verifier, messageID: pendingID, structured: true },
      ])
      expect(hydrated.nodes[0].output).toEqual(output)
      expect(hydrated.nodes[0].feedback).toEqual(feedback)
      expect(hydrated.nodes[0].pendingResult?.result.output).toEqual(pending)
    }),
  )

  it.effect("refuses large values without complete immutable provenance instead of truncating or dropping them", () =>
    Effect.gen(function* () {
      const output = "x".repeat(3000)
      for (const fields of [
        { sessionID: undefined },
        { outputMessageID: undefined },
        { outputStructured: undefined },
      ]) {
        const error = yield* refused(WorkflowState.encode(state([node({ output, ...fields })])))
        expect(error.code).toBe("reference")
        expect(error.path).toBe("/nodes/0/output")
      }
      const feedback = yield* refused(
        WorkflowState.encode(state([node({ feedback: { reason: output }, feedbackMessageID: undefined })])),
      )
      expect(feedback.path).toBe("/nodes/0/feedback")
      const pending = yield* refused(
        WorkflowState.encode(
          state([
            node({
              pendingResult: {
                verifier: false,
                round: 1,
                result: { status: "completed", output },
              },
            }),
          ]),
        ),
      )
      expect(pending.path).toBe("/nodes/0/pendingResult/result/output")
    }),
  )

  it.effect("never treats missing, malformed or future-version saved state as a fresh run", () =>
    Effect.gen(function* () {
      const encoded = yield* WorkflowState.encode(state())
      for (const invalid of [
        undefined,
        null,
        {},
        { ...encoded, version: 2 },
        { ...encoded, nodes: null },
        { ...encoded, extra: true },
        { ...encoded, usage: { ...encoded.usage, steps: -1 } },
        { ...encoded, usage: { ...encoded.usage, spentUsd: NaN } },
        { ...encoded, sessions: { [producer]: { ...usage(), codiumSteps: -1 } } },
        {
          ...encoded,
          nodes: [{ ...encoded.nodes[0], pendingLaunch: { key: "next", verifier: false, round: 1, extra: true } }],
        },
        { ...encoded, nodes: [encoded.nodes[0], encoded.nodes[0]] },
        { ...encoded, sessionGroups: { [producer]: "missing" } },
      ]) {
        yield* refused(WorkflowState.hydrate(invalid, { read: noRead }))
      }
    }),
  )

  it.effect("rejects oversized inline values and altered reference provenance before reading any message", () =>
    Effect.gen(function* () {
      const encoded = yield* WorkflowState.encode(state([node({ output: "x".repeat(3000) })]))
      const output = encoded.nodes[0].output!
      if (!("ref" in output)) throw new Error("Expected reference")
      for (const invalid of [
        { inline: "x".repeat(2047) },
        { ref: { ...output.ref, messageID: verifierMessage } },
        { ref: { ...output.ref, sessionID: verifier } },
        { ref: { ...output.ref, structured: true } },
        { ref: { ...output.ref, bytes: WorkflowState.LIMIT.valueBytes + 1 } },
        { ref: { ...output.ref, digest: "not-a-digest" } },
      ])
        yield* refused(
          WorkflowState.hydrate({ ...encoded, nodes: [{ ...encoded.nodes[0], output: invalid }] }, { read: noRead }),
        )
    }),
  )

  it.effect("rejects missing messages and changed answer bytes or digests without a fallback answer", () =>
    Effect.gen(function* () {
      const original = "x".repeat(3000)
      const encoded = yield* WorkflowState.encode(state([node({ output: original })]))
      const missing = yield* refused(
        WorkflowState.hydrate(encoded, { read: () => Effect.fail(new Error("deleted message")) }),
      )
      expect(missing.code).toBe("reference")
      for (const answer of ["y".repeat(3000), original + "x"]) {
        const changed = yield* refused(WorkflowState.hydrate(encoded, { read: () => Effect.succeed(answer) }))
        expect(changed.code).toBe("integrity")
      }
    }),
  )

  it.effect("reads a shared immutable producer answer once, including pending-result recovery", () =>
    Effect.gen(function* () {
      const output = "same immutable answer ".repeat(300)
      const encoded = yield* WorkflowState.encode(
        state([
          node({
            output,
            pendingResult: {
              verifier: false,
              round: 1,
              result: { status: "completed", sessionID: producer, messageID: producerMessage, output },
            },
          }),
        ]),
      )
      let reads = 0
      const hydrated = yield* WorkflowState.hydrate(encoded, {
        read: () => {
          reads++
          return Effect.succeed(output)
        },
      })
      expect(reads).toBe(1)
      expect(hydrated.nodes[0].output).toBe(output)
      expect(hydrated.nodes[0].pendingResult?.result.output).toBe(output)
      const pending = encoded.nodes[0].pendingResult!
      const value = pending.result.output!
      if (!("ref" in value)) throw new Error("Expected reference")
      const error = yield* refused(
        WorkflowState.hydrate(
          {
            ...encoded,
            nodes: [
              {
                ...encoded.nodes[0],
                pendingResult: {
                  ...pending,
                  result: { ...pending.result, output: { ref: { ...value.ref, digest: "b".repeat(64) } } },
                },
              },
            ],
          },
          { read: noRead },
        ),
      )
      expect(error.code).toBe("integrity")
    }),
  )

  it.effect("preflights the total declared hydration size before loading any large answer", () =>
    Effect.gen(function* () {
      const encoded = yield* WorkflowState.encode(state([node({ output: "x".repeat(3000) })]))
      const output = encoded.nodes[0].output!
      if (!("ref" in output)) throw new Error("Expected reference")
      const nodes = Array.from({ length: 9 }, (_, index) => {
        const messageID = MessageID.make(`msg_hydration_${index}`)
        return {
          ...encoded.nodes[0],
          key: `node-${index}`,
          outputMessageID: messageID,
          output: { ref: { ...output.ref, messageID, bytes: WorkflowState.LIMIT.valueBytes } },
        }
      })
      const error = yield* refused(WorkflowState.hydrate({ ...encoded, nodes }, { read: noRead }))
      expect(error.code).toBe("bound")
      expect(error.message).toContain("Hydrated workflow payloads")
    }),
  )

  it.effect("refuses excessive nodes, accounting entries and checkpoint bytes visibly", () =>
    Effect.gen(function* () {
      const tooMany = Array.from({ length: WorkflowState.LIMIT.nodes + 1 }, (_, index) =>
        node({ key: `node-${index}` }),
      )
      expect((yield* refused(WorkflowState.encode(state(tooMany)))).code).toBe("bound")
      const encoded = yield* WorkflowState.encode(state())
      const sessions = Object.fromEntries(
        Array.from({ length: 1001 }, (_, index) => [`ses_accounted_${index}`, usage()]),
      )
      yield* refused(WorkflowState.decode({ ...encoded, sessions }))
      const bytes = yield* refused(
        WorkflowState.decode({ ...encoded, excess: "x".repeat(WorkflowState.LIMIT.storedBytes) }),
      )
      expect(bytes.code).toBe("bound")
      expect(
        (yield* refused(WorkflowState.encode(state([node({ output: "x".repeat(WorkflowState.LIMIT.valueBytes) })]))))
          .code,
      ).toBe("bound")
    }),
  )

  it.effect(
    "validates untrusted JSON without invoking getters and rejects cycles, sparse arrays and nonfinite data",
    () =>
      Effect.gen(function* () {
        const encoded = yield* WorkflowState.encode(state())
        let getterCalls = 0
        const getter = Object.defineProperty({}, "secret", {
          enumerable: true,
          get: () => {
            getterCalls++
            return "leaked"
          },
        })
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        const sparse = new Array(2)
        const named = Object.assign([1], { extra: true })
        for (const inline of [getter, cycle, sparse, named, { bad: Infinity }, new Date(0), { bad: undefined }])
          yield* refused(WorkflowState.decode({ ...encoded, nodes: [{ ...encoded.nodes[0], output: { inline } }] }))
        expect(getterCalls).toBe(0)
        let deep: unknown = null
        for (let index = 0; index <= WorkflowState.LIMIT.valueDepth; index++) deep = [deep]
        const error = yield* refused(
          WorkflowState.decode({ ...encoded, nodes: [{ ...encoded.nodes[0], output: { inline: deep } }] }),
        )
        expect(error.code).toBe("bound")
      }),
  )

  it.effect("detaches inline checkpoints from mutable input and ignores even large regenerable item data", () =>
    Effect.gen(function* () {
      const output = { result: { ok: true } }
      const input = state([node({ value: "x".repeat(WorkflowState.LIMIT.valueBytes), output, outputStructured: true })])
      const encoded = yield* WorkflowState.encode(input)
      output.result.ok = false
      expect(encoded.nodes[0].output).toEqual({ inline: { result: { ok: true } } })
      expect(encoded.nodes[0].value).toBeNull()
      expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(4096)
    }),
  )
})
