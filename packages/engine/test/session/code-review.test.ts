import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionCodeReview } from "../../src/session/code-review"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionTaskSize } from "../../src/session/task-size"
import { TaskLimits } from "../../src/task/limits"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Code review after each task: which finished work is reviewed, read from message fixtures with no model, and the
// prompt field that asks for it.

const sessionID = SessionID.make("ses_code_review_fixture")
const model = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
const root = { parentID: undefined, internal: undefined, revert: undefined }

// Message IDs ascend and creation times follow them, as the engine writes them.
function history() {
  const messages: SessionV1.WithParts[] = []
  let clock = 1_000
  const user = (
    text: string,
    extra: {
      codeReview?: boolean
      agent?: string
      synthetic?: boolean
      metadata?: Record<string, unknown>
      created?: number
    } = {},
  ) => {
    const id = MessageID.ascending()
    clock += 10
    const message: SessionV1.WithParts = {
      info: {
        id,
        sessionID,
        role: "user",
        agent: extra.agent ?? "build",
        model,
        time: { created: extra.created ?? clock },
        ...(extra.codeReview === undefined ? {} : { codeReview: extra.codeReview }),
      },
      parts: [
        {
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text,
          ...(extra.synthetic ? { synthetic: true } : {}),
          ...(extra.metadata ? { metadata: extra.metadata } : {}),
        },
      ],
    }
    messages.push(message)
    return message
  }
  const assistant = (
    parent: SessionV1.WithParts,
    parts: (
      | Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID">
      | Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID">
    )[],
    extra: { agent?: string; finish?: string; error?: SessionV1.Assistant["error"]; completed?: boolean } = {},
  ) => {
    const id = MessageID.ascending()
    clock += 10
    const message: SessionV1.WithParts = {
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID: parent.info.id,
        agent: extra.agent ?? "build",
        mode: extra.agent ?? "build",
        modelID: model.modelID,
        providerID: model.providerID,
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: extra.finish ?? "stop",
        ...(extra.error ? { error: extra.error } : {}),
        time: { created: clock, ...(extra.completed === false ? {} : { completed: clock + 5 }) },
      },
      parts: parts.map((part) => ({ ...part, id: PartID.ascending(), sessionID, messageID: id }) as SessionV1.Part),
    }
    messages.push(message)
    return message
  }
  return { messages, user, assistant, now: () => clock + 1_000 }
}

const text = (value: string) => ({ type: "text" as const, text: value })
const edit = (file: string) => ({
  type: "tool" as const,
  tool: "edit",
  callID: `call_${file}`,
  state: {
    status: "completed" as const,
    input: { filePath: `/repo/${file}` },
    output: "Edited.",
    title: file,
    metadata: {},
    time: { start: 1, end: 2 },
  },
})
// Vector's judge task part, as launchJudge leaves it.
const judged = (round: number, state: SessionV1.ToolPart["state"], verdict?: string) => ({
  type: "tool" as const,
  tool: "task",
  callID: `judge_${round}_${state.status}`,
  metadata: { judge: { round, size: "standard", ...(verdict ? { verdict } : {}) } },
  state,
})
const verdict = (round: number, value: "PASS" | "FAIL" | "INCONCLUSIVE") =>
  judged(
    round,
    {
      status: "completed",
      input: { subagent_type: "judge" },
      output: `VERDICT: ${value}`,
      title: "Check the finished work",
      metadata: {},
      time: { start: 1, end: 2 },
    },
    value,
  )

// A finished build request that edited a file, sent with the setting on.
function base(stamp: { codeReview?: boolean } = { codeReview: true }) {
  const h = history()
  const u1 = h.user("Implement the parser change in parser.ts", stamp)
  h.assistant(u1, [edit("parser.ts")], { finish: "tool-calls" })
  const last = h.assistant(u1, [text("The parser change is complete.")])
  return { ...h, u1, last }
}

const check = (
  h: { messages: SessionV1.WithParts[]; now: () => number },
  extra: Partial<Parameters<typeof SessionCodeReview.eligible>[0]> = {},
) =>
  SessionCodeReview.eligible({
    session: root,
    messages: h.messages,
    idleAt: h.now(),
    stopped: false,
    guest: false,
    ...extra,
  })

describe("SessionCodeReview.eligible", () => {
  test("is off by default and admits only a request sent with the setting on", () => {
    expect(check(base({}))).toBeUndefined()
    expect(check(base({ codeReview: false }))).toBeUndefined()
    const on = base()
    const admitted = check(on)
    expect(admitted).toMatchObject({
      requestID: `after_${on.last.info.id}`,
      reviewedThrough: on.last.info.id,
      files: ["/repo/parser.ts"],
      agent: "build",
    })
    expect(admitted?.verdict).toBeUndefined()
  })

  test("with the judge off, a request is admitted once its last assistant has completed", () => {
    const h = base()
    expect(SessionTaskSize.judgeRuns({ messages: h.messages })).toHaveLength(0)
    expect(check(h)?.requestID).toBe(`after_${h.last.info.id}`)
    const running = base()
    const info = running.last.info
    if (info.role === "assistant") delete info.time.completed
    expect(check(running)).toBeUndefined()
  })

  test("waits for the judge's last round and never reviews after a judge the user stopped", () => {
    const withJudge = (part: ReturnType<typeof judged>) => {
      const h = base()
      const judge = h.assistant(h.u1, [part])
      return { h, judge }
    }
    const started = { input: { subagent_type: "judge" }, time: { start: 1 } }
    for (const state of [
      { status: "pending", input: {}, raw: "" },
      { status: "running", ...started },
      { status: "error", ...started, error: "Cancelled", metadata: { interrupted: true }, time: { start: 1, end: 2 } },
    ] as SessionV1.ToolPart["state"][])
      expect(check(withJudge(judged(1, state)).h), state.status).toBeUndefined()
    const failed = withJudge(
      judged(1, { status: "error", ...started, error: "The judge could not run", time: { start: 1, end: 2 } }),
    )
    expect(check(failed.h)?.requestID).toBe(`after_${failed.judge.info.id}`)
    for (const [round, value] of [
      [1, "PASS"],
      [1, "INCONCLUSIVE"],
      [3, "FAIL"],
    ] as const) {
      const done = withJudge(verdict(round, value))
      expect(check(done.h)).toMatchObject({ requestID: `after_${done.judge.info.id}`, verdict: value })
    }
  })

  test("a judge the user stopped holds back only the work it judged", () => {
    const h = base()
    h.assistant(h.u1, [
      judged(1, {
        status: "error",
        input: { subagent_type: "judge" },
        error: "Cancelled",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      }),
    ])
    expect(check(h)).toBeUndefined()
    // A Standard follow-up runs no judge; its own edits are reviewed, never the work the stopped judge was checking.
    const u2 = h.user("Rename the helper in utils.ts", { codeReview: true })
    const end = h.assistant(u2, [edit("utils.ts"), text("Renamed it.")])
    expect(check(h)).toMatchObject({ requestID: `after_${end.info.id}`, files: ["/repo/utils.ts"] })
    expect(check(h)?.verdict).toBeUndefined()
    const chat = h.user("Thanks, what does it export now?", { codeReview: true })
    h.assistant(chat, [text("It exports createRouter.")])
    expect(check(h, { previous: { reviewedThrough: end.info.id, running: false } })).toBeUndefined()
  })

  test("a steer typed during the final step still brings in the work before it", () => {
    const h = base()
    // Sent while the final step was still streaming.
    const u2 = h.user("Also keep the old export name", { codeReview: true, created: h.last.info.time.created + 2 })
    h.assistant(u2, [text("The old export name stays as it is.")])
    const judge = h.assistant(u2, [verdict(1, "PASS")])
    expect(SessionTaskSize.size({ messages: h.messages, caching: false, lifetime: 0 }).at(-1)?.users).toEqual([u2])
    expect(check(h)).toMatchObject({ requestID: `after_${judge.info.id}`, files: ["/repo/parser.ts"] })
  })

  test("a task that ends by offering more is reviewed after the user answers", () => {
    for (const judge of [false, true]) {
      const h = history()
      const u1 = h.user("Implement the parser change in parser.ts", { codeReview: true })
      h.assistant(u1, [edit("parser.ts"), text("Done. Want me to also update the tests?")])
      expect(check(h)).toBeUndefined()
      const u2 = h.user("no thanks", { codeReview: true })
      const answer = h.assistant(u2, [text("Okay, I left the tests as they are.")])
      const last = judge ? h.assistant(u2, [verdict(1, "PASS")]) : answer
      expect(check(h), `judge ${judge}`).toMatchObject({
        requestID: `after_${last.info.id}`,
        files: ["/repo/parser.ts"],
      })
    }
  })

  test("each review covers only what changed after the previous one", () => {
    const run = (edits: boolean) => {
      const h = history()
      const a = h.user("be thorough: migrate the router to the new API", { codeReview: true })
      h.assistant(a, [edit("router.ts")], { finish: "tool-calls" })
      h.assistant(a, [text("Migrated the router.")])
      const aEnd = h.assistant(a, [verdict(1, "PASS")])
      const b = h.user("Rename the helper in utils.ts", { codeReview: true })
      const bEnd = h.assistant(b, [edit("utils.ts"), text("Renamed it.")])
      const atB = check(h, { previous: { reviewedThrough: aEnd.info.id, running: false } })
      const c = h.user("What does the router export now?", { codeReview: true })
      const cEnd = h.assistant(c, [...(edits ? [edit("router.ts")] : []), text("It exports createRouter.")])
      return { atB, bEnd, cEnd, atC: check(h, { previous: { reviewedThrough: bEnd.info.id, running: false } }) }
    }
    const question = run(false)
    expect(question.atB).toMatchObject({ requestID: `after_${question.bEnd.info.id}`, files: ["/repo/utils.ts"] })
    expect(question.atC).toBeUndefined()
    const twin = run(true)
    expect(twin.atC).toMatchObject({ requestID: `after_${twin.cEnd.info.id}`, files: ["/repo/router.ts"] })
  })

  test("a prompt stored after the idle never changes the decision", () => {
    const h = history()
    const u1 = h.user("Implement the parser change in parser.ts", { codeReview: true })
    h.assistant(u1, [edit("parser.ts")], { finish: "tool-calls" })
    // A client minted the queued prompt's ID before the run's last step began.
    const early = MessageID.ascending()
    const last = h.assistant(u1, [text("The parser change is complete.")])
    const idleAt = h.now()
    const alone = check(h, { idleAt })
    const queued = h.user("now update the docs")
    queued.info.id = early
    queued.info.time.created = idleAt + 50
    expect(check(h, { idleAt })).toEqual(alone)
    expect(alone?.requestID).toBe(`after_${last.info.id}`)
  })

  test("never reviews the same finished work twice, and reviews a later wake turn's edits", () => {
    const h = base()
    expect(check(h, { previous: { reviewedThrough: h.last.info.id, running: false } })).toBeUndefined()
    expect(check(h, { previous: { reviewedThrough: "msg_0", running: true } })).toBeUndefined()
    // A background helper's result starts a turn of its own, and Vector edits in it.
    const note = h.user("<task-notification>The helper finished.</task-notification>", {
      synthetic: true,
      metadata: { taskNotification: { taskID: "ses_helper", state: "completed" } },
    })
    const wake = h.assistant(note, [edit("helper.ts"), text("Applied the helper's fix.")])
    expect(check(h, { previous: { reviewedThrough: h.last.info.id, running: false } })).toMatchObject({
      requestID: `after_${wake.info.id}`,
      files: ["/repo/helper.ts"],
    })
  })

  test("an upgraded chat request is keyed on its own last message, not the launching request", () => {
    const h = history()
    const u1 = h.user("Implement the parser change in parser.ts", { codeReview: true })
    const launch = h.assistant(u1, [
      {
        type: "tool",
        tool: "task",
        callID: "call_helper",
        state: {
          status: "completed",
          input: { subagent_type: "general" },
          output: "Started in the background.",
          title: "Helper",
          metadata: { sessionId: "ses_helper", background: true },
          time: { start: 1, end: 2 },
        },
      },
      edit("parser.ts"),
      text("Started a helper and changed the parser."),
    ])
    const thanks = h.user("thanks", { codeReview: true })
    h.assistant(thanks, [text("You're welcome!")])
    const note = h.user("<task-notification>The helper finished.</task-notification>", {
      synthetic: true,
      metadata: { taskNotification: { taskID: "ses_helper", state: "completed" } },
    })
    const last = h.assistant(note, [edit("helper.ts"), text("Applied the helper's report.")])
    const request = SessionTaskSize.size({ messages: h.messages, caching: false, lifetime: 0 }).at(-1)!
    expect(request.ledgerRequestID).toBe(u1.info.id)
    const admitted = check(h, { previous: { reviewedThrough: launch.info.id, running: false } })
    expect(admitted?.requestID).toBe(`after_${last.info.id}`)
    expect(admitted?.requestID).not.toBe(`after_${request.ledgerRequestID}`)
  })

  test("plan mode is reviewed only once the plan was approved and built", () => {
    const h = history()
    const u1 = h.user("Plan the parser rewrite", { codeReview: true, agent: "plan" })
    h.assistant(u1, [edit(".vector/plans/parser.md"), text("Here is the plan for the parser rewrite.")], {
      agent: "plan",
    })
    expect(check(h)).toBeUndefined()
    const approved = h.user("The user approved the plan. Carry it out.", { synthetic: true, agent: "build" })
    const built = h.assistant(approved, [edit("parser.ts"), text("Rewrote the parser as planned.")])
    expect(check(h)).toMatchObject({ requestID: `after_${built.info.id}`, files: ["/repo/parser.ts"], agent: "plan" })
  })

  test("refuses everything else", () => {
    const research = history()
    const r = research.user("Research the parser libraries and save notes", { codeReview: true, agent: "research" })
    research.assistant(r, [edit("notes.md"), text("Saved the notes.")], { agent: "research" })
    expect(check(research), "research").toBeUndefined()
    expect(check(base(), { session: { ...root, parentID: SessionID.make("ses_parent") } }), "subagent").toBeUndefined()
    expect(check(base(), { session: { ...root, internal: "vectorscope.run" } }), "internal").toBeUndefined()
    expect(
      check(base(), { session: { ...root, revert: { messageID: MessageID.ascending() } } }),
      "revert",
    ).toBeUndefined()
    expect(check(base(), { stopped: true }), "stopped").toBeUndefined()
    expect(check(base(), { guest: true }), "guest").toBeUndefined()
    const greeting = history()
    greeting.assistant(greeting.user("hi", { codeReview: true }), [text("Hello! What can I do?")])
    expect(check(greeting), "greeting").toBeUndefined()
    const asked = base()
    asked.assistant(asked.u1, [
      {
        type: "tool",
        tool: "question",
        callID: "call_question",
        state: { status: "error", input: {}, error: "Dismissed", time: { start: 1, end: 2 } },
      },
    ])
    expect(check(asked), "dismissed question").toBeUndefined()
    const stopped = history()
    const s = stopped.user("Implement the parser change in parser.ts", { codeReview: true })
    stopped.assistant(s, [edit("parser.ts")], {
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    })
    expect(check(stopped), "user stop").toBeUndefined()
    expect(check(base({})), "setting off").toBeUndefined()
    const before = base({})
    const later = before.user("What does parser.ts do now?", { codeReview: true })
    before.assistant(later, [text("It parses the config file.")])
    expect(check(before), "edits before the setting").toBeUndefined()
  })
})

describe("SessionCodeReview.wants", () => {
  test("watches only a user message stamped with the setting, from property reads", () => {
    const info = { id: "msg_1", sessionID: "ses_1", role: "user", codeReview: true }
    expect(SessionCodeReview.wants({ sessionID: "ses_1", info })).toBe(SessionID.make("ses_1"))
    expect(SessionCodeReview.wants({ sessionID: "ses_1", info: { ...info, role: "assistant" } })).toBeUndefined()
    expect(SessionCodeReview.wants({ sessionID: "ses_1", info: { ...info, codeReview: undefined } })).toBeUndefined()
    expect(SessionCodeReview.wants({ sessionID: "ses_1", info: { ...info, sessionID: 1 } })).toBeUndefined()
    for (const data of [undefined, null, "text", 1, [], { info: "x" }])
      expect(SessionCodeReview.wants(data)).toBeUndefined()
  })
})

// The prompt field, on the real prompt and command paths.
const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)
const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    snapshot: () => Effect.succeed({}),
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      TaskLimits.node,
      BackgroundJob.node,
      SpendGuard.node,
      EventV2Bridge.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

const setup = Effect.fn("CodeReviewTest.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(
    file,
    JSON.stringify({
      formatter: false,
      lsp: false,
      snapshot: false,
      command: { check: { template: "Check the parser for $ARGUMENTS" } },
      provider: {
        lmstudio: {
          name: "Test",
          id: "lmstudio",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: llm.url, concurrency: 64 },
        },
      },
    }),
  )
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return { llm, prompt: yield* SessionPrompt.Service, sessions: yield* Session.Service }
})

const stamped = (messages: readonly SessionV1.WithParts[]) =>
  messages.flatMap((message) => (message.info.role === "user" ? [message.info.codeReview] : []))

describe("the codeReview prompt field", () => {
  it.instance("is stored on the durable user message only when the sender sets it", () =>
    Effect.gen(function* () {
      const { prompt, sessions } = yield* setup()
      const on = yield* sessions.create({ title: "On" })
      const parts = [{ type: "text" as const, text: "Implement the parser change" }]
      yield* prompt.prompt({ sessionID: on.id, agent: "build", model, parts, noReply: true, codeReview: true })
      expect(stamped(yield* sessions.messages({ sessionID: on.id }))).toEqual([true])
      const off = yield* sessions.create({ title: "Off" })
      yield* prompt.prompt({ sessionID: off.id, agent: "build", model, parts, noReply: true })
      const message = (yield* sessions.messages({ sessionID: off.id }))[0]!
      expect(message.info.role === "user" && "codeReview" in message.info).toBe(false)
    }),
  )

  it.instance("is stored by the command path the same way", () =>
    Effect.gen(function* () {
      const { prompt, sessions, llm } = yield* setup()
      yield* llm.text("Checked.")
      yield* llm.text("Checked.")
      const on = yield* sessions.create({ title: "On" })
      const command = { command: "check", arguments: "imports", agent: "build", model: "lmstudio/test-model" }
      yield* prompt.command({ sessionID: on.id, ...command, codeReview: true })
      expect(stamped(yield* sessions.messages({ sessionID: on.id }))).toEqual([true])
      const off = yield* sessions.create({ title: "Off" })
      yield* prompt.command({ sessionID: off.id, ...command })
      expect(stamped(yield* sessions.messages({ sessionID: off.id }))).toEqual([undefined])
    }),
  )
})
