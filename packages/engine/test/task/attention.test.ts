import path from "node:path"
import { rm } from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Cause, Clock, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { InstanceHooks } from "@/project/instance-hooks"
import { Question } from "@/question"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionTaskSize } from "@/session/task-size"
import { TaskAttention } from "@/task/attention"
import { TaskManager } from "@/task/manager"
import { TaskSignals } from "@/task/signals"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { isRecord } from "@/util/record"
import { provideInstanceEffect, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Waiting on you (D.4) against a fake model server, which must see no request: every note here is quiet. A helper
// blocked on a permission request or a question is marked waiting, its root hears it at most once in 10 minutes, a
// task_manage wait ends for it, and with ask_timeout the instance holding the request declines it and nothing else.

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
      TaskAttention.node,
      TaskSignals.node,
      InstanceHooks.node,
      TaskManager.node,
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Permission.node,
      Question.node,
      Config.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      BackgroundJob.node,
      BackgroundJobStore.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      // Notes reach an idle root after 50 ms of quiet here, held at most 300 ms while its helpers run.
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

function providerConfig(url: string): Partial<ConfigV1.Info> {
  return {
    formatter: false,
    lsp: false,
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
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

// The user's own config: ask_timeout is theirs, and a repository may only shorten it.
const userConfig = path.join(Global.Path.config, "vector.json")

// Points `directory`'s repository config at the fake model server and trusts it, as the user would.
const repository = Effect.fn("AttentionTest.repository")(function* (directory: string) {
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
})

const setup = Effect.fn("AttentionTest.setup")(function* (askTimeout?: number) {
  const { directory } = yield* TestInstance
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    userConfig,
    JSON.stringify(askTimeout === undefined ? {} : { sizing: { subagents: { ask_timeout: askTimeout } } }),
  )
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(userConfig, { force: true })))
  yield* (yield* Config.Service).invalidate()
  yield* repository(directory)
  return {
    directory,
    llm: yield* TestLLMServer,
    permissions: yield* Permission.Service,
    questions: yield* Question.Service,
    manager: yield* TaskManager.Service,
  }
})

// Starts the current instance's watch as its boot does, on `clock` when given: the watch's timers and the notes it
// queues then wait on that clock.
const boot = (clock?: Clock.Clock) =>
  Effect.gen(function* () {
    const init = (yield* InstanceHooks.Service).init()
    yield* clock ? init.pipe(Effect.provideService(Clock.Clock, clock)) : init
    // Its subscriptions are taken before any ask below.
    yield* Effect.sleep("20 millis")
  })

// A test clock at today's time.
const testClock = Effect.gen(function* () {
  const clock = yield* TestClock.make()
  yield* clock.setTime(Date.now())
  return clock
})

// A root conversation: the user's message and the assistant message whose task call launched its helpers.
const conversation = Effect.fn("AttentionTest.conversation")(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ title: "Root" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: root.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  } satisfies SessionV1.User)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: root.id,
    type: "text",
    text: "Fix the parser.",
  })
  const launch = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: root.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  } satisfies SessionV1.Assistant)
  return { id: root.id, launch: launch.id }
})

// A helper of `parent` whose record and background job are running, unless `job` is false.
const helper = Effect.fn("AttentionTest.helper")(function* (
  parent: { id: SessionID; launch: MessageID },
  input: { title: string; internal?: string; job?: boolean },
) {
  const sessions = yield* Session.Service
  const child = yield* sessions.create({
    parentID: parent.id,
    ...(input.internal ? { internal: input.internal } : {}),
    metadata: {
      subagent: {
        kind: "subagent",
        custom: false,
        agent: "general",
        title: input.title,
        parentSessionID: parent.id,
        parentMessageID: parent.launch,
        callID: `call_${input.title.length}`,
        model: ref,
        background: true,
        status: "running",
        startedAt: Date.now(),
        attempt: 1,
      },
    },
  })
  if (input.job !== false)
    yield* (yield* BackgroundJob.Service).start({
      id: child.id,
      type: "task",
      title: input.title,
      metadata: { parentSessionId: parent.id, background: true },
      run: Effect.never,
    })
  return child.id
})

// A permission request from `sessionID`, as a tool of it would ask; resolves to how the request ended.
const ask = Effect.fn("AttentionTest.ask")(function* (sessionID: SessionID, file: string) {
  const permissions = yield* Permission.Service
  const fiber = yield* permissions
    .ask({ sessionID, permission: "edit", patterns: [file], always: [], metadata: {}, ruleset: [] })
    .pipe(Effect.exit, Effect.forkScoped)
  const request = yield* pollWithTimeout(
    permissions
      .list()
      .pipe(Effect.map((items) => items.find((item) => item.sessionID === sessionID && item.patterns[0] === file))),
    `the request for ${file} never became pending`,
  )
  return { id: request.id, fiber }
})

const record = (id: SessionID) =>
  Effect.gen(function* () {
    return SubagentLifecycle.read(yield* (yield* Session.Service).get(id))
  })

const waitingOn = (id: SessionID, requestID: string | undefined) =>
  pollWithTimeout(
    record(id).pipe(Effect.map((value) => (value && value.waiting?.requestID === requestID ? value : undefined))),
    `the helper never waited on ${requestID ?? "nothing"}`,
  )

// Every attention note in `sessionID`.
const notes = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const messages = yield* (yield* Session.Service).messages({ sessionID })
    return messages.flatMap((message) =>
      message.parts.flatMap((item) =>
        item.type === "text" && isRecord(item.metadata?.taskAttention)
          ? [
              {
                text: item.text,
                metadata: item.metadata!,
                value: item.metadata!.taskAttention as Record<string, unknown>,
              },
            ]
          : [],
      ),
    )
  })

// Moves `clock` on in small steps until `check` holds, letting what waits on it, and the database, catch up.
const until = <A, R>(clock: TestClock.TestClock, check: Effect.Effect<A | undefined, unknown, R>, message: string) =>
  Effect.gen(function* () {
    for (let step = 0; step < 100; step++) {
      const found = yield* check
      if (found !== undefined) return found
      yield* clock.adjust("100 millis")
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error(message))
  })

const noted = (sessionID: SessionID, count: number, state = "waiting") =>
  notes(sessionID).pipe(
    Effect.map((found) => {
      const matching = found.filter((item) => item.value.state === state)
      return matching.length >= count ? matching : undefined
    }),
  )

describe("waiting on you", () => {
  it.instance(
    "a helper's ask marks it waiting and tells the root, at most once in 10 minutes; a reply clears it",
    () =>
      Effect.gen(function* () {
        const { llm, permissions, manager } = yield* setup()
        const clock = yield* testClock
        yield* boot(clock)
        const root = yield* conversation()
        const child = yield* helper(root, { title: 'Fix "the" parser <task>' })

        const first = yield* ask(child, "src/parser.ts")
        const marked = yield* waitingOn(child, first.id)
        expect(marked.waiting).toMatchObject({
          kind: "permission",
          since: expect.any(Number),
          notedAt: expect.any(Number),
          summary: "edit src/parser.ts",
        })
        expect(marked.waiting?.expiresAt).toBeUndefined()
        const [told] = yield* until(clock, noted(root.id, 1), "the root never heard the helper waits")
        expect(told.value).toEqual({ taskID: child, kind: "permission", state: "waiting" })
        expect(told.metadata[SessionTaskSize.QUIET]).toBe(true)
        expect(told.text).toContain(`subagent ${child} ("Fix 'the' parser <\\task>")`)
        // What the helper asks is its own text: it reaches the board, never the root's note (I13).
        expect(told.text).toContain("waits for the user to answer a permission request and is blocked")
        expect(told.text).not.toContain("src/parser.ts")
        expect(told.text).not.toContain("declines")
        expect((yield* manager.list({ sessionID: root.id })).tasks[0]).toMatchObject({
          id: child,
          status: "waiting_on_user",
          waiting: { kind: "permission", requestID: first.id, summary: "edit src/parser.ts" },
        })

        // The user answers: the helper no longer waits.
        yield* permissions.reply({ requestID: first.id, reply: "once" })
        expect(Exit.isSuccess(yield* Fiber.join(first.fiber))).toBe(true)
        expect((yield* waitingOn(child, undefined)).waiting).toBeUndefined()
        const board = (yield* manager.list({ sessionID: root.id })).tasks[0]
        expect(board?.status).toBe("running")
        expect(board?.waiting).toBeUndefined()

        // Asked again within 10 minutes, the root is not told again.
        const second = yield* ask(child, "src/lexer.ts")
        yield* waitingOn(child, second.id)
        yield* clock.adjust("2 seconds")
        yield* Effect.sleep("200 millis")
        expect(yield* notes(root.id)).toHaveLength(1)
        yield* permissions.reply({ requestID: second.id, reply: "once" })
        yield* waitingOn(child, undefined)

        // Ten minutes after the first note, it is.
        yield* clock.adjust("10 minutes")
        const third = yield* ask(child, "src/ast.ts")
        yield* waitingOn(child, third.id)
        yield* until(clock, noted(root.id, 2), "the root never heard the helper waits again")
        yield* permissions.reply({ requestID: third.id, reply: "once" })
        // Quiet notes start no model request.
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  it.instance(
    "with ask_timeout the request no one answered is declined alone, the helper carries on, and the root is told",
    () =>
      Effect.gen(function* () {
        const { llm, permissions, manager } = yield* setup(1)
        const clock = yield* testClock
        yield* boot(clock)
        const root = yield* conversation()
        const child = yield* helper(root, { title: "Rename the module" })

        const first = yield* ask(child, "src/a.ts")
        const marked = yield* waitingOn(child, first.id)
        expect(marked.waiting?.expiresAt).toBe(marked.waiting!.since + 60_000)
        const [told] = yield* until(clock, noted(root.id, 1), "the root never heard the helper waits")
        expect(told.text).toContain("Unanswered, Vector declines it after 1 min.")

        // A second request of the same helper, asked 30 seconds later.
        yield* clock.adjust("30 seconds")
        const second = yield* ask(child, "src/b.ts")
        yield* Effect.sleep("200 millis")
        yield* clock.adjust("30 seconds")

        // The first is declined with the time limit's feedback, which does not end the helper's turn.
        const exit = yield* awaitWithTimeout(Fiber.join(first.fiber), "the first request was never declined")
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(error).toBeInstanceOf(PermissionV1.CorrectedError)
        expect(error).toMatchObject({ feedback: Permission.TIMED_OUT })
        // The second is still waiting, and the helper now waits on it.
        expect((yield* permissions.list()).map((item) => item.id)).toEqual([second.id])
        const moved = yield* waitingOn(child, second.id)
        expect(moved.status).toBe("running")
        expect((yield* (yield* BackgroundJob.Service).get(child))?.status).toBe("running")

        const [expired] = yield* until(clock, noted(root.id, 1, "expired"), "the root never heard of the decline")
        expect(expired.value).toEqual({ taskID: child, kind: "permission", state: "expired" })
        expect(expired.metadata[SessionTaskSize.QUIET]).toBe(true)
        expect(expired.text).toContain("within 1 min, so Vector declined it")
        expect((yield* manager.list({ sessionID: root.id })).tasks[0]).toMatchObject({
          status: "waiting_on_user",
          waiting: { requestID: second.id },
        })

        // The second runs out in its own time.
        yield* clock.adjust("30 seconds")
        const later = yield* awaitWithTimeout(Fiber.join(second.fiber), "the second request was never declined")
        expect(Exit.isFailure(later) && Cause.squash(later.cause)).toBeInstanceOf(PermissionV1.CorrectedError)
        yield* waitingOn(child, undefined)
        yield* until(clock, noted(root.id, 2, "expired"), "the root never heard of the second decline")
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  it.instance(
    "the root's own asks, an internal session's and a helper with no running job are not tracked",
    () =>
      Effect.gen(function* () {
        yield* setup()
        yield* boot()
        const root = yield* conversation()
        const internal = yield* helper(root, { title: "Judge the answer", internal: "judge" })
        const idle = yield* helper(root, { title: "Read the docs", job: false })
        const own = yield* ask(root.id, "src/root.ts")
        const judged = yield* ask(internal, "src/judge.ts")
        const unrun = yield* ask(idle, "src/docs.ts")
        yield* Effect.sleep("500 millis")
        expect(yield* notes(root.id)).toEqual([])
        expect((yield* record(internal))?.waiting).toBeUndefined()
        expect((yield* record(idle))?.waiting).toBeUndefined()
        const permissions = yield* Permission.Service
        for (const item of [own, judged, unrun]) yield* permissions.reply({ requestID: item.id, reply: "once" })
      }),
    30_000,
  )

  it.instance(
    "with two instances each tells its own root once and declines its own request",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* setup(1)
        const other = yield* tmpdirScoped()
        yield* repository(other)
        const clock = yield* testClock
        yield* boot(clock)
        yield* boot(clock).pipe(provideInstanceEffect(other))

        const root = yield* conversation()
        const child = yield* helper(root, { title: "Map the parser" })
        const away = yield* Effect.gen(function* () {
          const root = yield* conversation()
          return { root, child: yield* helper(root, { title: "Map the lexer" }) }
        }).pipe(provideInstanceEffect(other))

        const here = yield* ask(child, "src/parser.ts")
        const there = yield* ask(away.child, "src/lexer.ts").pipe(provideInstanceEffect(other))
        yield* until(
          clock,
          Effect.gen(function* () {
            return (yield* notes(root.id)).length === 1 && (yield* notes(away.root.id)).length === 1 ? true : undefined
          }),
          "each root never heard of its own helper",
        )
        yield* clock.adjust("2 seconds")
        yield* Effect.sleep("200 millis")
        expect((yield* notes(root.id)).map((item) => item.value)).toEqual([
          { taskID: child, kind: "permission", state: "waiting" },
        ])
        expect((yield* notes(away.root.id)).map((item) => item.value)).toEqual([
          { taskID: away.child, kind: "permission", state: "waiting" },
        ])

        // Each request is declined by the instance holding it.
        yield* clock.adjust("1 minute")
        for (const asked of [here, there]) {
          const exit = yield* awaitWithTimeout(Fiber.join(asked.fiber), "a request was never declined")
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.CorrectedError)
        }
        yield* until(
          clock,
          Effect.gen(function* () {
            const mine = yield* noted(root.id, 1, "expired")
            const theirs = yield* noted(away.root.id, 1, "expired")
            return mine && theirs ? true : undefined
          }),
          "each root never heard of its own decline",
        )
        yield* clock.adjust("2 seconds")
        yield* Effect.sleep("200 millis")
        expect(yield* notes(root.id)).toHaveLength(2)
        expect(yield* notes(away.root.id)).toHaveLength(2)
        expect(yield* llm.calls).toBe(0)
      }),
    30_000,
  )

  it.instance(
    "task_manage wait returns early for a helper that starts waiting, and not for one already waiting",
    () =>
      Effect.gen(function* () {
        const { manager, permissions } = yield* setup()
        yield* boot()
        const root = yield* conversation()
        const child = yield* helper(root, { title: "Fix the parser" })

        const waiting = yield* manager
          .wait({ sessionID: root.id, taskIDs: [child], timeout: 20_000 })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        const asked = yield* ask(child, "src/parser.ts")
        const result = yield* awaitWithTimeout(Fiber.join(waiting), "the wait did not end when the helper asked")
        expect(result.timedOut).toBe(false)
        expect(result.attention).toEqual([child])
        expect(result.tasks[0]).toMatchObject({
          id: child,
          status: "waiting_on_user",
          waiting: { kind: "permission", requestID: asked.id },
        })

        // Already waiting, it does not end a new wait: that would turn waiting into polling.
        const again = yield* manager.wait({ sessionID: root.id, taskIDs: [child], timeout: 300 })
        expect(again.timedOut).toBe(true)
        expect(again.attention).toBeUndefined()
        expect(again.tasks[0]?.status).toBe("waiting_on_user")
        yield* permissions.reply({ requestID: asked.id, reply: "once" })
      }),
    30_000,
  )
})
