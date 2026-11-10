import { afterAll, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Question } from "../../src/question"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { BrowserTool } from "../../src/tool/browser"
import { QuestionTool } from "../../src/tool/question"
import { Truncate } from "../../src/tool/truncate"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Question.expire (D.4): a question no one answered within ask_timeout fails as timed out, never as a dismissal. The
// question tool, a browser handoff and a research plan card then tell their agent to carry on with its own judgement,
// as ordinary output rather than a failed call, so the agent's turn goes on.

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
afterAll(async () => {
  await web.close()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node])),
)
// Research's plan card asks only in a client where someone can answer it.
const research = runtime(web, { client: "app" })

const ctx = {
  sessionID: SessionID.make("ses_helper"),
  messageID: MessageID.make("msg_helper"),
  callID: "call_helper",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const pending = (count: number) =>
  pollWithTimeout(
    Question.Service.use((question) => question.list()).pipe(
      Effect.map((items) => (items.length === count ? items : undefined)),
    ),
    "the questions never became pending",
  )

const prompt = (text: string) => ({
  question: text,
  header: "Choice",
  options: [{ label: "Yes", description: "Go ahead" }],
})

it.instance("expire withdraws only that question and fails its asker as timed out", () =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const events = yield* EventV2Bridge.Service
    const rejected: unknown[] = []
    const off = yield* events.listen((event) => {
      if (event.type === Question.Event.Rejected.type) rejected.push(event.data)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => off)
    const ask = (text: string) =>
      question.ask({ sessionID: ctx.sessionID, questions: [prompt(text)] }).pipe(Effect.exit, Effect.forkScoped)
    const first = yield* ask("Rename the module?")
    yield* pending(1)
    const second = yield* ask("Keep the old name as an alias?")
    const [a, b] = yield* pending(2)

    expect(yield* question.expire(a.id)).toBe(true)
    const exit = yield* Fiber.join(first)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(Question.RejectedError)
    expect(error).toMatchObject({ timedOut: true, message: Question.TIMED_OUT })
    expect(rejected).toEqual([{ sessionID: ctx.sessionID, requestID: a.id }])
    // The other question is still waiting for its answer.
    expect((yield* question.list()).map((item) => item.id)).toEqual([b.id])
    expect(yield* question.expire(a.id)).toBe(false)

    // A dismissal is still a dismissal.
    yield* question.reject(b.id)
    const dismissed = yield* Fiber.join(second)
    const reason = Exit.isFailure(dismissed) ? Cause.squash(dismissed.cause) : undefined
    expect(reason).toBeInstanceOf(Question.RejectedError)
    expect((reason as Question.RejectedError).timedOut).toBeUndefined()
    expect((reason as Question.RejectedError).message).toBe("The user dismissed this question")
  }),
)

it.instance("the question tool and a browser handoff answer a timed-out question with output, not a failure", () =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const asking = yield* (yield* (yield* QuestionTool).init())
      .execute({ questions: [prompt("Which branch should I use?")] }, ctx)
      .pipe(Effect.exit, Effect.forkScoped)
    const [asked] = yield* pending(1)
    yield* question.expire(asked.id)
    const answered = yield* Fiber.join(asking)
    expect(Exit.isSuccess(answered)).toBe(true)
    if (Exit.isSuccess(answered))
      expect(answered.value).toMatchObject({ title: "No answer", output: Question.TIMED_OUT })

    const handing = yield* (yield* (yield* BrowserTool).init())
      .execute({ action: "handoff", reason: "Sign in to the staging dashboard." }, ctx)
      .pipe(Effect.exit, Effect.forkScoped)
    const [handoff] = yield* pending(1)
    expect(handoff.questions[0]?.header).toBe("Browser handoff")
    yield* question.expire(handoff.id)
    const handed = yield* Fiber.join(handing)
    expect(Exit.isSuccess(handed)).toBe(true)
    if (Exit.isSuccess(handed))
      expect(handed.value).toMatchObject({ output: Question.TIMED_OUT, metadata: { handoff: "cancelled" } })
  }),
)

research.instance(
  "a research plan card no one answers in time tells the agent to carry on, and starts nothing",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const question = yield* Question.Service
      // Every plan card runs out unanswered.
      yield* Effect.gen(function* () {
        while (true) {
          for (const request of yield* question.list()) yield* question.expire(request.id)
          yield* Effect.sleep(10)
        }
      }).pipe(Effect.forkScoped)
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      yield* test.llm.tool("research_plan", plan())
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })

      const [card] = yield* calls(session.id, "research_plan")
      expect(card?.state.status).toBe("completed")
      expect(output(card)).toBe(Question.TIMED_OUT)
      expect(card?.state.status === "completed" ? card.state.metadata : undefined).toMatchObject({ approved: false })
      expect(guard.outside()).toEqual([])
    }),
  90_000,
)
