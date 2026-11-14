import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Effect, Layer } from "effect"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "../../src/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

// One provider turn as the engine's processor records it: the assistant message, then its step-finish part.
const step = Effect.fn("test.partUsageStep")(function* (sessionID: SessionID, input: number, billing?: "codium") {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage(
    SessionV1.Assistant.make({
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make(billing ? "vector-plan" : "own-provider"),
      agent: "build",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      time: { created: 1, completed: 2 },
      cost: billing ? 0 : 0.12,
      tokens: tokens(input),
      ...(billing ? { billing, unpriced: true } : {}),
    }),
  )
  return yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "step-finish",
    reason: "stop",
    cost: billing ? 0 : 0.12,
    tokens: tokens(input),
    ...(billing ? { billing, unpriced: true } : {}),
  } satisfies SessionV1.StepFinishPart)
})

const totals = Effect.fn("test.partUsageTotals")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const info = yield* sessions.get(sessionID)
  return {
    cost: info.cost,
    tokens: info.tokens,
    codiumSteps: info.codiumSteps,
    unpricedSteps: info.unpricedSteps,
    tokensOwnOnly: info.tokensOwnOnly,
  }
})

// The path names the ids the body carries, so only the stored part can disagree with the edit.
const patch = <T extends { id: string; sessionID: string; messageID: string }>(directory: string, part: T) =>
  requestInDirectory(
    SessionPaths.updatePart
      .replace(":sessionID", part.sessionID)
      .replace(":messageID", part.messageID)
      .replace(":partID", part.id),
    directory,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(part) },
  )

const options = { trusted: true, git: true, config: { formatter: false, lsp: false } }

type Step = SessionV1.StepFinishPart

// Each edit an authorized client could send against a session holding one own step and one Codium step.
const refused: [string, (own: Step, codium: Step) => { id: string; sessionID: string; messageID: string }][] = [
  ["an own step relabelled as Codium", (own) => ({ ...own, billing: "codium", unpriced: true })],
  // JSON drops the undefined flag, so the body carries no billing at all.
  ["a Codium step on its Codium message with its flag removed", (_, codium) => ({ ...codium, billing: undefined })],
  [
    "a Codium step sent under the own message's id without its flag",
    (own, codium) => ({ ...codium, billing: undefined, messageID: own.messageID }),
  ],
  ["a step-finish part the engine never recorded", (own) => ({ ...own, id: PartID.ascending() })],
  [
    "a stored step turned into a part that carries no usage",
    (_, codium) => ({
      id: codium.id,
      sessionID: codium.sessionID,
      messageID: codium.messageID,
      type: "text",
      text: "x",
    }),
  ],
]

describe("part.update keeps step usage the engine's record", () => {
  refused.forEach(([name, edit]) =>
    it.instance(
      `refuses ${name}, leaving the session's totals and parts as stored`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "relabel" })
          const own = yield* step(session.id, 200)
          const codium = yield* step(session.id, 987654, "codium")
          const before = yield* totals(session.id)
          expect(before).toMatchObject({ tokens: tokens(200), codiumSteps: 1, tokensOwnOnly: true })
          const part = edit(own, codium)

          expect((yield* patch(test.directory, part)).status).toBe(400)
          expect(yield* totals(session.id)).toEqual(before)
          expect(yield* sessions.getPart({ sessionID: session.id, messageID: own.messageID, partID: own.id })).toEqual(
            own,
          )
          expect(
            yield* sessions.getPart({ sessionID: session.id, messageID: codium.messageID, partID: codium.id }),
          ).toEqual(codium)
        }),
      options,
    ),
  )

  it.instance(
    "accepts an edit that leaves a step's usage as stored",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "edit" })
        const own = yield* step(session.id, 200)
        const codium = yield* step(session.id, 987654, "codium")
        const before = yield* totals(session.id)

        expect((yield* patch(test.directory, { ...own, reason: "length" })).status).toBe(200)
        expect((yield* patch(test.directory, { ...codium, reason: "length" })).status).toBe(200)
        expect(yield* sessions.getPart({ sessionID: session.id, messageID: own.messageID, partID: own.id })).toEqual({
          ...own,
          reason: "length",
        })
        expect(yield* totals(session.id)).toEqual(before)
      }),
    options,
  )

  it.instance(
    "refuses a step sent under another session's message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const first = yield* sessions.create({ title: "first" })
        const second = yield* sessions.create({ title: "second" })
        const own = yield* step(first.id, 200)
        const target = yield* step(second.id, 40)
        const before = { first: yield* totals(first.id), second: yield* totals(second.id) }

        expect(
          (yield* patch(test.directory, { ...own, sessionID: second.id, messageID: target.messageID })).status,
        ).toBe(400)
        expect({ first: yield* totals(first.id), second: yield* totals(second.id) }).toEqual(before)
      }),
    options,
  )
})
