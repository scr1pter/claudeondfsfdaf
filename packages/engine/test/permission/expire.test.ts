import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Permission.expire (D.4): a helper's request no one answered within ask_timeout is declined on its own, with
// feedback the agent can act on. Unlike a rejection it fails no other request of the session, so the helper carries on.

const it = testEffect(LayerNode.compile(LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node])))

afterEach(async () => {
  await disposeAllInstances()
})

const ask = (sessionID: SessionID, file: string) =>
  Permission.Service.use((permission) =>
    permission.ask({ sessionID, permission: "edit", patterns: [file], always: [], metadata: {}, ruleset: [] }),
  ).pipe(Effect.exit, Effect.forkScoped)

const pending = (count: number) =>
  pollWithTimeout(
    Permission.Service.use((permission) => permission.list()).pipe(
      Effect.map((items) => (items.length === count ? items : undefined)),
    ),
    "the requests never became pending",
  )

it.instance("expire declines only that request, with the time-limit feedback, and withdraws its prompt", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const replies: unknown[] = []
    const off = yield* events.listen((event) => {
      if (event.type === Permission.Event.Replied.type) replies.push(event.data)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)
    const helper = SessionID.make("ses_helper")
    const first = yield* ask(helper, "src/a.ts")
    yield* pending(1)
    const second = yield* ask(helper, "src/b.ts")
    const [a, b] = yield* pending(2)

    expect(yield* permission.expire(a.id, Question.TIMED_OUT)).toBe(true)
    const exit = yield* Fiber.join(first)
    expect(Exit.isFailure(exit)).toBe(true)
    // A correction, not a rejection: the processor does not end the helper's turn for it.
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(PermissionV1.CorrectedError)
    expect(error).toMatchObject({ feedback: Question.TIMED_OUT })
    expect(String((error as Error).message)).toContain("No one answered within the time limit.")
    // Clients drop the prompt as for a rejection.
    expect(replies).toEqual([{ sessionID: helper, requestID: a.id, reply: "reject" }])
    // The helper's other request is still waiting, where a rejection would have failed it too.
    expect((yield* permission.list()).map((item) => item.id)).toEqual([b.id])

    // A request no longer pending is not declined again, and one that was answered is left alone.
    expect(yield* permission.expire(a.id, Question.TIMED_OUT)).toBe(false)
    yield* permission.reply({ requestID: b.id, reply: "once" })
    expect(Exit.isSuccess(yield* Fiber.join(second))).toBe(true)
    expect(yield* permission.expire(b.id, Question.TIMED_OUT)).toBe(false)
    expect(yield* permission.expire("per_unknown", Question.TIMED_OUT)).toBe(false)
  }),
)

it.instance("a rejection still fails every request of the session, unlike an expiry", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const helper = SessionID.make("ses_helper")
    const first = yield* ask(helper, "src/a.ts")
    yield* pending(1)
    const second = yield* ask(helper, "src/b.ts")
    const [a] = yield* pending(2)
    yield* permission.reply({ requestID: a.id, reply: "reject" })
    for (const fiber of [first, second]) {
      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }
    expect(yield* permission.list()).toEqual([])
  }),
)
