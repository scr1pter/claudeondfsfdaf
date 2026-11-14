import { afterEach, describe, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Connect } from "@vectordevai/schema/connect"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectHub } from "@/connect/hub"
import { ConnectReviewService } from "@/connect/review-service"
import { ConnectMembers } from "@/connect/members"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, disposeAllInstancesEffect, provideInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// The hub on its own, with fake adapters: what a hand-off checks before anything is asked, what it asks, how it runs,
// how it ends, and how a run is found again after a restart. No model runs and nothing reaches the network.

afterEach(disposeAllInstances)

type Ask = Parameters<Tool.Context["ask"]>[0]
type Handle = NonNullable<ConnectAdapter.Adapter["handle"]>

// What the fakes do in the current test.
const script: {
  describe?: (id: string) => Connect.Member
  handle?: Handle
} = {}
const seen: { id: string; context: ConnectAdapter.HandoffContext }[] = []

const reset = () => {
  delete script.describe
  delete script.handle
  seen.length = 0
}

const member = (id: string, effects: readonly string[] = ["read"], extra: Partial<Connect.Member> = {}) =>
  ({
    id,
    kind: "agent",
    title: id === "vectorscope" ? "VectorScope" : "Another reviewer",
    summary: "",
    owner: "main",
    place: "local",
    sendsTo: "this-computer",
    state: "ready",
    reach: "connect",
    actions: [
      { id: "review", title: "Review", effects: effects as Connect.Effect[], background: false, result: "review" },
      { id: "fix", title: "Fix", effects: ["read", "write"], background: false, result: "fix" },
    ],
    ...extra,
  }) as Connect.Member

const finding = (id: string): Connect.Finding => ({
  id,
  severity: "concern",
  category: "bug",
  path: "src/a.ts",
  line: 3,
  side: "RIGHT",
  title: `Finding ${id}`,
  body: "Read past the end.",
  source: "review",
  bucket: "inline",
  status: "open",
})

const clean = (): Connect.Result => ({
  state: "completed",
  verdict: "clean",
  summary: "Nothing to flag.",
  findings: [],
  sessions: [],
  notes: [],
  sendsTo: "this-computer",
})

const flagged = (): Connect.Result => ({
  ...clean(),
  verdict: "findings",
  summary: "Two findings.",
  findings: [finding("f1"), finding("f2")],
})

const fake = (id: string): ConnectAdapter.Adapter => ({
  id,
  owner: "main",
  describe: () => Effect.sync(() => script.describe?.(id) ?? member(id)),
  handle: (request, context) =>
    Effect.suspend(() => {
      seen.push({ id, context })
      return script.handle ? script.handle(request, context) : Effect.succeed(clean())
    }),
})

const listed: ConnectAdapter.Adapter = {
  id: "listed",
  owner: "hands",
  describe: () => Effect.succeed({ ...member("listed"), reach: "none", actions: undefined }),
}

const graph = (flags: Partial<RuntimeFlags.Info>, mcp?: Layer.Layer<MCP.Service>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ConnectHub.nodeWith([fake("vectorscope"), fake("other"), listed]),
      Permission.node,
      Session.node,
      SpendGuard.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)], ...(mcp ? [[MCP.node, mcp] as const] : [])],
  )

const it = testEffect(graph({ experimentalConnect: true }))
const off = testEffect(graph({ experimentalConnect: false }))

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

function reply(input: SessionPrompt.PromptInput): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      agent: "build",
      mode: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      modelID: model.modelID,
      providerID: model.providerID,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    },
    parts: [],
  }
}

// Prompt calls as a tool call lends them (ctx.extra.promptOps), recording what reaches them.
function recorder() {
  const prompts: SessionID[] = []
  const cancels: SessionID[] = []
  const ops: TaskPromptOps = {
    cancel: (sessionID) => Effect.sync(() => void cancels.push(sessionID)),
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push(input.sessionID)
        return reply(input)
      }),
  }
  return { ops, prompts, cancels }
}

// ctx.ask as tool calls get it: a rejection reaches the tool as a defect.
function asker(answer: (request: Ask) => "yes" | "no" = () => "yes") {
  const asks: Ask[] = []
  const ask: Tool.Context["ask"] = (request) =>
    Effect.suspend(() => {
      asks.push(request)
      return answer(request) === "yes" ? Effect.void : Effect.die(new PermissionV1.RejectedError())
    })
  return { asks, ask }
}

const paid: Connect.Consent = {
  permission: "connect_model",
  patterns: ["paid/model"],
  always: ["paid/model"],
  message: "Review on paid/model.",
  model: "paid/model",
  sendsTo: "provider:paid",
  maxCostUsd: 2,
}

const fixBatch: Connect.Consent = {
  permission: "connect_write",
  patterns: ["src/a.ts"],
  always: [],
  message: "Fix 1 finding.",
  findings: ["f1"],
}

const review = (sessionID: SessionID, directory: string, extra: Partial<Connect.ReviewRequest> = {}) =>
  ({
    to: "vectorscope",
    action: "review",
    target: { kind: "uncommitted" },
    requester: { kind: "agent", sessionID, agent: "build" },
    directory,
    background: false,
    ...extra,
  }) as ConnectHub.StartRequest

const fix = (sessionID: SessionID, directory: string, run: string, findings: string[]) =>
  ({
    to: "vectorscope",
    action: "fix",
    run,
    findings,
    mode: "here",
    requester: { kind: "agent", sessionID, agent: "build" },
    directory,
    background: false,
  }) as unknown as ConnectHub.StartRequest

const say = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID, type: "text", text })
    return message
  })

// What the connect tool does with a finished run: it returns `metadata(run)`, which the session keeps on the part.
// `cut` saves it as a part the processor marked as an error when the run was cut off, which keeps its metadata.
const save = (sessionID: SessionID, parentID: MessageID, run: Connect.Run, cut = false) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      parentID,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID,
      type: "tool",
      callID: `call_${run.id}`,
      tool: "connect",
      state: cut
        ? {
            status: "error",
            input: {},
            error: "Tool execution aborted",
            metadata: ConnectHub.metadata(run),
            time: { start: 1, end: 2 },
          }
        : {
            status: "completed",
            input: {},
            output: "",
            title: "Review",
            metadata: ConnectHub.metadata(run),
            time: { start: 1, end: 2 },
          },
    })
  })

// An automatic compaction after the context overflowed: its marker, its summary, then the user's message replayed.
const overflow = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const marker = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: marker.id,
      sessionID,
      type: "compaction",
      auto: true,
      overflow: true,
    })
    const summary = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      parentID: marker.id,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: summary.id,
      sessionID,
      type: "text",
      text: "Summary of the conversation so far.",
    })
    return yield* say(sessionID, text)
  })

// Vector Local on, as the owner turns it on in their own config, for the length of `body`.
const withLocal = <A, E, R>(body: Effect.Effect<A, E, R>) => {
  const file = path.join(Global.Path.config, "vector.json")
  const apply = () => {
    Config.refreshLocal()
    Config.confirmLocal()
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = existsSync(file) ? readFileSync(file, "utf8") : undefined
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ local: { enabled: true } }))
      apply()
      return before
    }),
    () => body,
    (before) =>
      Effect.sync(() => {
        if (before === undefined) rmSync(file, { force: true })
        else writeFileSync(file, before)
        apply()
        rmSync(Config.localConfirmedFile(), { force: true })
      }),
  )
}

const setup = (permission?: PermissionV1.Ruleset) =>
  Effect.gen(function* () {
    reset()
    const test = yield* TestInstance
    const sessions = yield* Session.Service
    const hub = yield* ConnectHub.Service
    const requester = yield* sessions.create({ title: "Requester", ...(permission ? { permission } : {}) })
    const message = yield* say(requester.id, "review my changes")
    return { directory: test.directory, sessions, hub, requester, message }
  })

const write = (directory: string, file: string, text = "x") =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })

describe("lifecycle", () => {
  it.instance("a run moves queued, running, done, publishes each step and saves a result that decodes again", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const events = yield* EventV2Bridge.Service
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== Connect.Event.RunUpdated.type) return
          const data = event.data as { run: Connect.Run }
          published.push(data.run.status)
        }),
      )
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          yield* context.progress({ pass: "review", message: "Reading the diff" })
          return flagged()
        })
      const updates: Connect.Run[] = []
      const { ask } = asker()
      const run = yield* hub.run({
        request: review(requester.id, directory),
        call: { ask, update: (next) => Effect.sync(() => void updates.push(next)) },
      })
      yield* unsubscribe

      const statuses = updates.map((item) => item.status).filter((status, index, all) => status !== all[index - 1])
      expect(statuses).toEqual(["queued", "running", "done"])
      expect(updates.some((item) => item.progress?.message === "Reading the diff")).toBe(true)
      expect(published.filter((status, index, all) => status !== all[index - 1])).toEqual(["queued", "running", "done"])
      expect(run.id.startsWith("cr_")).toBe(true)
      expect(run.result?.state).toBe("completed")
      expect(run.result?.target).toEqual({ kind: "uncommitted" })
      expect(run.time.started).toBeDefined()
      expect(run.time.ended).toBeDefined()
      expect(run.progress).toBeUndefined()
      // The request id is the message the user last wrote.
      const { requestID } = yield* hub.request(requester.id)
      expect(run.request.requestID).toBe(requestID!)

      const part = {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID: requester.id,
        type: "tool",
        callID: "call_1",
        tool: "connect",
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: ConnectHub.metadata(run),
          time: { start: 1, end: 2 },
        },
      } as SessionV1.Part
      expect(ConnectHub.fromPart(part)?.result?.findings.map((item) => item.id)).toEqual(["f1", "f2"])
      // Another tool's part, or a note the user could have written, carries no run.
      expect(ConnectHub.fromPart({ ...part, tool: "read" } as SessionV1.Part)).toBeUndefined()
      expect(
        ConnectHub.fromPart({
          id: PartID.ascending(),
          messageID: MessageID.ascending(),
          sessionID: requester.id,
          type: "text",
          text: "",
          metadata: ConnectHub.metadata(run),
        } as SessionV1.Part),
      ).toBeUndefined()
      // Nor does a synthetic one: a client can send a synthetic text part with any metadata.
      expect(
        ConnectHub.fromPart({
          id: PartID.ascending(),
          messageID: MessageID.ascending(),
          sessionID: requester.id,
          type: "text",
          text: "",
          synthetic: true,
          metadata: ConnectHub.metadata(run),
        } as SessionV1.Part),
      ).toBeUndefined()
      expect((yield* hub.runs({ sessionID: requester.id })).map((item) => item.id)).toEqual([run.id])
    }),
  )

  it.instance("cancel aborts the adapter and cancels the helper sessions it prompted", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts, cancels } = recorder()
      let signal: AbortSignal | undefined
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          signal = context.abort
          const helper = yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })
          yield* context.helper!.prompt({
            sessionID: helper.id,
            agent: "review",
            parts: [{ type: "text", text: "review" }],
          })
          return yield* Effect.never
        })
      const fiber = yield* hub
        .run({ request: review(requester.id, directory), call: { promptOps: ops } })
        .pipe(Effect.forkChild)
      const runID = yield* pollWithTimeout(
        Effect.gen(function* () {
          const [current] = yield* hub.runs({ sessionID: requester.id })
          return current?.status === "running" && prompts.length === 1 ? current.id : undefined
        }),
        "the run never started its helper",
      )
      expect(yield* hub.cancel(runID, { sessionID: SessionIDOf("ses_someone_else") })).toBe(false)
      expect(yield* hub.cancel(runID)).toBe(true)
      const run = yield* Fiber.join(fiber)
      expect(run.status).toBe("done")
      expect(run.result?.state).toBe("cancelled")
      expect(run.result?.verdict).toBe("not-reviewed")
      expect(signal?.aborted).toBe(true)
      expect(cancels).toEqual(prompts)
      expect(run.result?.sessions).toEqual(prompts)
      expect(yield* hub.cancel(runID)).toBe(false)
    }),
  )

  it.instance("a caller that stops waiting cancels the run", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const controller = new AbortController()
      script.handle = () => Effect.never
      const fiber = yield* hub
        .run({ request: review(requester.id, directory), call: { abort: controller.signal } })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.map(hub.runs({ sessionID: requester.id }), ([current]) =>
          current?.status === "running" ? true : undefined,
        ),
        "the run never started",
      )
      controller.abort()
      const run = yield* Fiber.join(fiber)
      expect(run.result?.state).toBe("cancelled")
      expect(run.result?.summary).toContain("stopped waiting")
    }),
  )

  it.instance("the caller AbortSignal withdraws a pending connect approval before the adapter starts", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup([{ permission: "connect", pattern: "*", action: "ask" }])
      const permissions = yield* Permission.Service
      const controller = new AbortController()
      const fiber = yield* hub
        .run({ request: review(requester.id, directory), call: { abort: controller.signal } })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        permissions
          .list()
          .pipe(Effect.map((pending) => (pending.some((entry) => entry.permission === "connect") ? true : undefined))),
        "The connect approval was never pending.",
      )
      controller.abort()
      const run = yield* Fiber.join(fiber)
      expect(run.status).toBe("done")
      expect(run.result?.state).toBe("cancelled")
      expect(run.result?.verdict).toBe("not-reviewed")
      expect(yield* permissions.list()).toEqual([])
      expect(seen).toEqual([])
    }),
  )

  it.instance("a result the schema refuses, or a defect, fails the run and is never clean", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      script.handle = () => Effect.succeed({ ...clean(), state: "partial" } as Connect.Result)
      const partial = yield* hub.run({ request: review(requester.id, directory) })
      expect(partial.result?.state).toBe("failed")
      expect(partial.result?.verdict).toBe("not-reviewed")
      script.handle = () => Effect.die(new Error("the reviewer fell over"))
      const died = yield* hub.run({ request: review(requester.id, directory) })
      expect(died.result?.state).toBe("failed")
      expect(died.result?.summary).toContain("the reviewer fell over")
    }),
  )
})

describe("checks before anything is asked", () => {
  it.instance("a diff outside the instance retains its actual source's absolute secret question", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "connect-diff-origin-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
      yield* Effect.promise(() => fs.mkdir(path.join(outside, ".git")))
      yield* write(outside, "private.key", "WITHHELD_OTHER_REPOSITORY")
      const { hub, requester } = yield* setup([
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "read", pattern: path.join(outside, "private.key"), action: "ask" },
      ])
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          expect(context.reviewService).toBeDefined()
          const checked = yield* ConnectReviewService.checkReads(context.reviewService!, ["private.key"]).pipe(
            Effect.exit,
          )
          expect(Exit.isFailure(checked)).toBe(true)
          return clean()
        })
      const { ops } = recorder()
      const run = yield* hub.run({ request: review(requester.id, outside), call: { ...asker(), promptOps: ops } })
      expect(run.result?.state).toBe("completed")
      expect(seen).toHaveLength(1)
    }),
  )

  it.instance("the qualified diff authority keeps secret asks and denies without widening requester reads", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup([
        { permission: "read", pattern: "*.env.development", action: "deny" },
      ])
      yield* write(directory, ".env", "TOKEN=WITHHELD_UNTRACKED")
      yield* write(directory, ".env.development", "TOKEN=WITHHELD_MODIFIED")
      yield* write(directory, "server.key", "WITHHELD_KEY")
      yield* write(directory, "src/app.ts", "export {}")
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          expect(context.reviewService).toBeDefined()
          for (const file of [".env", ".env.development", "server.key"])
            expect(
              Exit.isFailure(yield* ConnectReviewService.checkReads(context.reviewService!, [file]).pipe(Effect.exit)),
            ).toBe(true)
          for (const file of ["src/app.ts", ".env.example"])
            expect(
              Exit.isSuccess(yield* ConnectReviewService.checkReads(context.reviewService!, [file]).pipe(Effect.exit)),
            ).toBe(true)
          return clean()
        })
      const { ops } = recorder()
      const run = yield* hub.run({
        request: review(requester.id, directory),
        call: { ...asker(), promptOps: ops },
      })
      expect(run.result?.state).toBe("completed")
      expect(seen).toHaveLength(1)
    }),
  )

  it.instance("a run whose effects the requester lacks is refused with no ask", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup([{ permission: "read", pattern: "*", action: "deny" }])
      const { asks, ask } = asker()
      const run = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(run.result?.state).toBe("refused")
      expect(run.result?.refusal).toBe("permission")
      expect(asks).toEqual([])
      expect(seen).toEqual([])

      const sessions = yield* Session.Service
      const writer = yield* sessions.create({ permission: [{ permission: "edit", pattern: "*", action: "deny" }] })
      yield* say(writer.id, "fix them")
      const fixed = yield* hub.run({ request: fix(writer.id, directory, "cr_missing", ["f1"]), call: { ask } })
      expect(fixed.result?.refusal).toBe("permission")
      expect(asks).toEqual([])
    }),
  )

  it.instance("any effect other than read or write is refused with no ask", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      for (const effects of [["network"], ["read", "run"], ["cloud"], []]) {
        script.describe = (id) => member(id, effects)
        const run = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
        expect(run.result?.refusal).toBe("effect")
      }
      expect(asks).toEqual([])
      expect(seen).toEqual([])
    }),
  )

  it.instance("a file matching a requester read deny or ask pattern refuses a review", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { ask } = asker()
      const start = () => hub.run({ request: review(requester.id, directory), call: { ask } })

      // VectorScope denies .env files and .git itself, so they never stop a review.
      yield* write(directory, ".env", "TOKEN=1")
      yield* write(directory, ".git/.kube/config")
      yield* write(directory, "src/app.ts", "export {}")
      expect((yield* start()).result?.state).toBe("completed")

      yield* write(directory, "node_modules/pkg/.docker/config.json", "{}")
      const nested = yield* start()
      expect(nested.result?.refusal).toBe("read-rule")
      expect(nested.result?.summary).toContain("**/.docker/config.json")
      yield* Effect.promise(() => fs.rm(path.join(directory, "node_modules"), { recursive: true }))

      yield* write(directory, "conf/kube/config")
      yield* Effect.promise(() => fs.symlink(path.join(directory, "conf/kube"), path.join(directory, ".kube")))
      const linked = yield* start()
      expect(linked.result?.refusal).toBe("read-rule")
      expect(linked.result?.summary).toContain(".kube/config")
      expect(linked.result?.summary).toContain('".kube/*"')
      expect(seen.length).toBe(1)
    }),
  )

  it.instance("a session's own read rule stops a review of a file it covers", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup([{ permission: "read", pattern: "secrets/*", action: "deny" }])
      yield* write(directory, "secrets/key.txt")
      const run = yield* hub.run({ request: review(requester.id, directory), call: asker() })
      expect(run.result?.refusal).toBe("read-rule")
      expect(run.result?.summary).toContain('"secrets/*"')
      expect(seen).toEqual([])
    }),
  )

  it.instance(
    "a review started in a subfolder checks the whole repository, named from its top level",
    () =>
      Effect.gen(function* () {
        const { directory, hub, requester } = yield* setup()
        const app = path.join(directory, "app")
        yield* write(directory, "app/src/a.ts", "export {}")
        const start = () => hub.run({ request: review(requester.id, app), call: asker() })
        expect((yield* start()).result?.state).toBe("completed")
        // The kube config sits at the repository's top level, outside the folder, where a reviewer can still read it.
        yield* write(directory, ".kube/config")
        const rooted = yield* start()
        expect(rooted.result?.refusal).toBe("read-rule")
        expect(rooted.result?.summary).toContain(".kube/config")
        expect(seen.length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "a session's rule written against the repository's top level holds for a review of a subfolder",
    () =>
      Effect.gen(function* () {
        const { directory, hub, requester } = yield* setup([
          { permission: "read", pattern: "app/secrets/*", action: "deny" },
        ])
        yield* write(directory, "app/secrets/key.txt")
        const run = yield* hub.run({ request: review(requester.id, path.join(directory, "app")), call: asker() })
        expect(run.result?.refusal).toBe("read-rule")
        expect(run.result?.summary).toContain("app/secrets/key.txt")
        expect(run.result?.summary).toContain('"app/secrets/*"')
        expect(seen).toEqual([])
      }),
    { git: true },
  )

  it.instance("a folder outside the instance is checked from the top of its own repository", () =>
    Effect.gen(function* () {
      const { hub, requester } = yield* setup()
      const outside = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "connect-outside-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      yield* write(outside, ".git/HEAD", "ref: refs/heads/main\n")
      yield* write(outside, "pkg/src/a.ts", "export {}")
      yield* write(outside, ".kube/config")
      const run = yield* hub.run({ request: review(requester.id, path.join(outside, "pkg")), call: asker() })
      expect(run.result?.refusal).toBe("read-rule")
      expect(run.result?.summary).toContain(".kube/config")
      expect(seen).toEqual([])
    }),
  )

  it.instance("a folder the check cannot list refuses the review (fail closed)", () =>
    Effect.gen(function* () {
      // Permissions do not hold for root or on Windows, so there is nothing to check there.
      if (process.platform === "win32" || process.getuid?.() === 0) return
      const { directory, hub, requester } = yield* setup()
      yield* write(directory, "locked/inner/a.ts")
      const locked = path.join(directory, "locked")
      // Execute without read: a reviewer can still open a file whose name it knows, but nothing can list the folder.
      yield* Effect.promise(() => fs.chmod(locked, 0o111))
      const run = yield* hub
        .run({ request: review(requester.id, directory), call: asker() })
        .pipe(Effect.ensuring(Effect.promise(() => fs.chmod(locked, 0o755))))
      expect(run.result?.refusal).toBe("read-rule")
      expect(run.result?.summary).toContain("could not check")
      expect(seen).toEqual([])
    }),
  )

  it.instance("Vector Local refuses a member that says it is ready but sends code to a provider, with no ask", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      script.describe = (id) => member(id, ["read"], { sendsTo: "provider:x" })
      const local = yield* withLocal(hub.run({ request: review(requester.id, directory), call: { ask } }))
      expect(local.result?.refusal).toBe("unavailable")
      expect(local.result?.summary).toContain("Off in Vector Local")
      expect(asks).toEqual([])
      expect(seen).toEqual([])
      script.describe = (id) => member(id, ["read"], { place: "vector-cloud" })
      const cloud = yield* withLocal(hub.run({ request: review(requester.id, directory), call: { ask } }))
      expect(cloud.result?.refusal).toBe("unavailable")
      expect(asks).toEqual([])
      expect(seen).toEqual([])
      // With Vector Local off, the same member takes the run.
      const allowed = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(allowed.result?.state).toBe("completed")
    }),
  )

  it.instance("a request the schema refuses ends refused for its input, unrecorded and without asking", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      const bad = [
        review(requester.id, directory, { target: { kind: "branch", base: "--output=x" } }),
        review(requester.id, directory, { target: { kind: "branch", base: "main branch" } }),
        review(requester.id, directory, { budget: { maxCostUsd: 0 } }),
        { ...review(requester.id, directory), requester: { kind: "agent" } } as ConnectHub.StartRequest,
        fix(requester.id, directory, Connect.RunID.create(), []),
        fix(requester.id, directory, Connect.RunID.create(), ["f1", "f1"]),
      ]
      for (const request of bad) {
        const run = yield* hub.run({ request, call: { ask } })
        expect(run.status).toBe("done")
        expect(run.result?.state).toBe("refused")
        expect(run.result?.refusal).toBe("input")
        expect(run.result?.summary).toContain("not valid")
        if (request.action === "review") expect(run.result?.verdict).toBe("not-reviewed")
      }
      expect(asks).toEqual([])
      expect(seen).toEqual([])
      expect(yield* hub.runs()).toEqual([])
    }),
  )

  it.instance("a subagent cannot hand work off; a workflow stage in a child session can", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const child = yield* sessions.create({ parentID: requester.id, title: "Subagent" })
      const refused = yield* hub.run({ request: review(child.id, directory), call: asker() })
      expect(refused.result?.refusal).toBe("not-allowed")
      expect(refused.result?.summary).toContain("subagent")
      expect(seen).toEqual([])
      const stage = yield* hub.run({
        request: {
          ...review(child.id, directory),
          requester: { kind: "workflow", sessionID: child.id },
        } as ConnectHub.StartRequest,
        call: asker(),
      })
      expect(stage.result?.state).toBe("completed")
    }),
  )

  it.instance("unknown, listed-only and unready members take no hand-off", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      expect(
        (yield* hub.run({ request: review(requester.id, directory, { to: "nobody" }), call: { ask } })).result?.refusal,
      ).toBe("unknown")
      expect(
        (yield* hub.run({ request: review(requester.id, directory, { to: "listed" }), call: { ask } })).result?.refusal,
      ).toBe("unknown")
      script.describe = (id) => member(id, ["read"], { state: "off", reason: "Off in Vector Local." })
      const unready = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(unready.result?.refusal).toBe("unavailable")
      expect(unready.result?.summary).toContain("Off in Vector Local")
      expect(asks).toEqual([])
    }),
  )

  it.instance("a helper session cannot start a hand-off, and nothing runs without a usable directory", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const helper = yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })
      const chained = yield* hub.run({ request: review(helper.id, directory), call: asker() })
      expect(chained.result?.refusal).toBe("not-allowed")
      const nowhere = yield* hub.run({ request: review(requester.id, path.join(directory, "missing")), call: asker() })
      expect(nowhere.result?.refusal).toBe("input")
      expect(seen).toEqual([])
    }),
  )

  it.instance("the sixth review in one request is refused, also after a restart; the next request starts again", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, message } = yield* setup()
      for (let index = 0; index < 5; index++) {
        const run = yield* hub.run({ request: review(requester.id, directory), call: asker() })
        expect(run.result?.state).toBe("completed")
        yield* save(requester.id, message.id, run)
      }
      const sixth = yield* hub.run({ request: review(requester.id, directory), call: asker() })
      expect(sixth.result?.refusal).toBe("limit")
      expect((yield* hub.request(requester.id)).reviews).toBe(5)

      yield* disposeAllInstancesEffect
      yield* Effect.gen(function* () {
        const fresh = yield* ConnectHub.Service
        expect(yield* fresh.runs()).toEqual([])
        const again = yield* fresh.run({ request: review(requester.id, directory), call: asker() })
        expect(again.result?.refusal).toBe("limit")

        yield* say(requester.id, "and again")
        const next = yield* fresh.run({ request: review(requester.id, directory), call: asker() })
        expect(next.result?.state).toBe("completed")
      }).pipe(provideInstance(directory))
    }),
  )

  it.instance("an overflow compaction that replays the user's message is not a new request", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, message } = yield* setup()
      for (let index = 0; index < 5; index++) {
        const run = yield* hub.run({ request: review(requester.id, directory), call: asker() })
        expect(run.result?.state).toBe("completed")
        yield* save(requester.id, message.id, run)
      }
      // The context overflowed: the compaction copies "review my changes" into a new message after its summary.
      yield* overflow(requester.id, "review my changes")
      expect((yield* hub.request(requester.id)).requestID).toBe(message.id)
      const sixth = yield* hub.run({ request: review(requester.id, directory), call: asker() })
      expect(sixth.result?.refusal).toBe("limit")

      // Text a client marked ignored is not the user writing either.
      const sessions = yield* Session.Service
      const hidden = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: requester.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: hidden.id,
        sessionID: requester.id,
        type: "text",
        text: "context the client attached",
        ignored: true,
      })
      expect((yield* hub.request(requester.id)).requestID).toBe(message.id)

      // The user writing again starts the next request.
      const next = yield* say(requester.id, "thanks, review once more")
      expect((yield* hub.request(requester.id)).requestID).toBe(next.id)
      expect((yield* hub.run({ request: review(requester.id, directory), call: asker() })).result?.state).toBe(
        "completed",
      )
    }),
  )

  it.effect("VECTOR_EXPERIMENTAL_CONNECT is off unless it or VECTOR_EXPERIMENTAL turns it on", () =>
    Effect.gen(function* () {
      const read = (input: Record<string, unknown>) =>
        RuntimeFlags.Service.useSync((flags) => flags.experimentalConnect).pipe(
          Effect.provide(
            AppNodeBuilder.build(RuntimeFlags.node).pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
            ),
          ),
        )
      expect(yield* read({})).toBe(false)
      expect(yield* read({ VECTOR_EXPERIMENTAL_CONNECT: "true" })).toBe(true)
      expect(yield* read({ VECTOR_EXPERIMENTAL: "true" })).toBe(true)
      expect(yield* read({ VECTOR_EXPERIMENTAL: "true", VECTOR_EXPERIMENTAL_CONNECT: "false" })).toBe(false)
    }),
  )

  off.instance("connected tools stay off without VECTOR_EXPERIMENTAL_CONNECT, and nothing shows the refused run", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const events = yield* EventV2Bridge.Service
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => void (event.type === Connect.Event.RunUpdated.type && published.push(event.type))),
      )
      const { asks, ask } = asker()
      const updates: Connect.Run[] = []
      const run = yield* hub.run({
        request: review(requester.id, directory),
        call: { ask, update: (next) => Effect.sync(() => void updates.push(next)) },
      })
      yield* unsubscribe
      expect(run.status).toBe("done")
      expect(run.result?.refusal).toBe("not-allowed")
      expect(asks).toEqual([])
      expect(seen).toEqual([])
      // No event, no update, no ledger entry and no activity in the registry.
      expect(published).toEqual([])
      expect(updates).toEqual([])
      expect(yield* hub.runs()).toEqual([])
      expect((yield* hub.members()).find((item) => item.id === "vectorscope")?.activity).toBeUndefined()
    }),
  )
})

describe("consent", () => {
  it.instance("connect is asked per run and connect_model once per request", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          yield* context.ask(paid)
          yield* context.ask(paid)
          return clean()
        })
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(asks.map((item) => item.permission)).toEqual(["connect", "connect_model", "connect"])
      expect(asks[0].patterns).toEqual(["vectorscope.review"])
      expect(asks[1].metadata).toMatchObject({ model: "paid/model", sendsTo: "provider:paid", maxCostUsd: 2 })

      yield* say(requester.id, "review again")
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(asks.filter((item) => item.permission === "connect_model").length).toBe(2)
    }),
  )

  it.instance(
    "connect_write reaches the user every time, never saved, or is refused while a rule could answer it",
    () =>
      Effect.gen(function* () {
        // The requester allows everything and the caller's ask accepts whatever it is asked, as a client's auto-accept.
        const { directory, hub, requester } = yield* setup([{ permission: "*", pattern: "*", action: "allow" }])
        const { asks, ask } = asker()
        script.handle = (_request, context) =>
          Effect.gen(function* () {
            yield* context.ask(fixBatch)
            yield* context.ask(fixBatch)
            return clean()
          })
        const viaCall = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
        const writes = asks.filter((item) => item.permission === "connect_write")
        if (PermissionPolicy.requiresApproval("connect_write", [], fixBatch.patterns)) {
          // Once requiresApproval covers it (CW-07), no rule or auto-accept answers it: it is asked each time.
          expect(viaCall.result?.state).toBe("completed")
          expect(writes.length).toBe(2)
          expect(writes.every((item) => item.always.length === 0)).toBe(true)
          // Through Permission the requester's allow-everything rule does not answer it, and an "always" reply is
          // kept for that one question only: the second is asked again.
          const permissions = yield* Permission.Service
          const running = yield* hub.run({ request: review(requester.id, directory) }).pipe(Effect.forkChild)
          for (const reply of ["always", "once"] as const) {
            const pending = yield* pollWithTimeout(
              permissions.list().pipe(Effect.map((list) => list.find((item) => item.permission === "connect_write"))),
              "connect_write was not asked through Permission",
            )
            expect(pending.always).toEqual([])
            yield* permissions.reply({ requestID: pending.id, reply })
          }
          const viaPermission = yield* Fiber.join(running)
          expect(viaPermission.result?.state).toBe("completed")
        } else {
          const viaPermission = yield* hub.run({ request: review(requester.id, directory) })
          // Until then nothing keeps an allow rule, a saved approval or an auto-accept from answering it, so it is
          // refused before it is asked, by either way of asking.
          expect(writes).toEqual([])
          expect(viaCall.result?.refusal).toBe("permission")
          expect(viaPermission.result?.refusal).toBe("permission")
        }
      }),
  )

  it.instance("the user's no refuses the run; a deny rule on connect refuses through Permission", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          yield* context.ask({
            permission: "connect_model",
            patterns: ["paid/model"],
            always: ["paid/model"],
            message: "Review on paid/model.",
            model: "paid/model",
            sendsTo: "provider:paid",
          })
          return clean()
        })
      const declined = yield* hub.run({
        request: review(requester.id, directory),
        call: asker((request) => (request.permission === "connect_model" ? "no" : "yes")),
      })
      expect(declined.result?.state).toBe("refused")
      expect(declined.result?.refusal).toBe("denied")

      const sessions = yield* Session.Service
      const denied = yield* sessions.create({ permission: [{ permission: "connect", pattern: "*", action: "deny" }] })
      yield* say(denied.id, "review")
      const ruled = yield* hub.run({ request: review(denied.id, directory) })
      expect(ruled.result?.refusal).toBe("permission")
    }),
  )

  it.instance("a sessionless direct call needs private owner authority before any consent or helper work", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const permissions = yield* Permission.Service
      const before = yield* sessions.list({ internal: true })
      const messages = yield* sessions.messages({ sessionID: requester.id })
      const { asks, ask } = asker()
      const { ops, prompts, cancels } = recorder()

      // Lending an approval callback and prompt operations does not lend the owner's private directory token.
      for (const call of [undefined, { ask, promptOps: ops }]) {
        const nobody = yield* hub.run({
          request: { ...review(requester.id, directory), requester: { kind: "user" } },
          call,
        })
        expect(nobody.result?.state).toBe("refused")
        expect(nobody.result?.refusal).toBe("not-allowed")
        expect(nobody.result?.summary).toContain("current owner's execution authority")
      }

      expect(seen).toEqual([])
      expect(asks).toEqual([])
      expect(yield* permissions.list()).toEqual([])
      expect(prompts).toEqual([])
      expect(cancels).toEqual([])
      expect((yield* sessions.list({ internal: true })).map((session) => session.id)).toEqual(
        before.map((session) => session.id),
      )
      expect(yield* sessions.messages({ sessionID: requester.id })).toEqual(messages)
    }),
  )
})

describe("the helper handle", () => {
  it.instance("only the private service capability qualifies the vectorscope identity", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts } = recorder()
      let retained: ConnectReviewService.Capability | undefined
      const exits: Record<string, boolean> = {}
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          const mine = (yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })).id
          const input = { sessionID: mine, agent: "vectorscope", parts: [{ type: "text" as const, text: "Review" }] }
          exits.ordinary = Exit.isSuccess(yield* Effect.exit(context.helper!.prompt(input)))
          const capability = context.reviewService
          if (!capability) throw new Error("The review had no private service capability")
          retained = capability
          exits.copied = Exit.isSuccess(yield* Effect.exit(ConnectReviewService.scope({ ...capability })))
          const provided = yield* ConnectReviewService.service(capability, () => Effect.void)
          const service = yield* SessionPrompt.Service.pipe(Effect.provideContext(provided))
          exits.service = Exit.isSuccess(yield* Effect.exit(service.prompt(input)))
          exits.tools = Exit.isSuccess(yield* Effect.exit(service.prompt({ ...input, tools: { bash: true } })))
          exits.budget = Exit.isSuccess(yield* Effect.exit(service.prompt({ ...input, budget: { usd: 100 } })))
          exits.otherAgent = Exit.isSuccess(yield* Effect.exit(service.prompt({ ...input, agent: "build" })))
          return clean()
        })
      const result = yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(result.result?.state).toBe("completed")
      expect(exits).toEqual({
        ordinary: false,
        copied: false,
        service: true,
        tools: false,
        budget: false,
        otherAgent: false,
      })
      expect(prompts).toHaveLength(1)
      expect(Exit.isFailure(yield* Effect.exit(ConnectReviewService.scope(retained!)))).toBe(true)
    }),
  )

  it.instance("reaches only the run's own hidden helper sessions, and only while the run is going", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts } = recorder()
      const stranger = yield* sessions.create({ title: "Someone else" })
      const theirs = yield* sessions.create({ parentID: stranger.id, internal: "vectorscope.review" })
      const plain = yield* sessions.create({ parentID: requester.id })
      const research = yield* sessions.create({ parentID: requester.id, internal: "research.lead" })
      // A helper the requester already had before this run, such as an earlier run's reviewer.
      const before = yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })
      const exits: Record<string, boolean> = {}
      let kept: ConnectAdapter.HelperHandle | undefined
      let mine: SessionID | undefined
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          const helper = context.helper!
          kept = helper
          // The run's own helper, made while it is going, as VectorScope makes its reviewer sessions.
          mine = (yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })).id
          const attempt = (name: string, sessionID: SessionID) =>
            helper.prompt({ sessionID, agent: "review", parts: [{ type: "text", text: "x" }] }).pipe(
              Effect.exit,
              Effect.map((exit) => void (exits[name] = Exit.isSuccess(exit))),
            )
          yield* attempt("requester", requester.id)
          yield* attempt("before", before.id)
          yield* attempt("stranger", stranger.id)
          yield* attempt("theirs", theirs.id)
          yield* attempt("plain", plain.id)
          yield* attempt("research", research.id)
          yield* attempt("mine", mine)
          exits.cancelRequester = Exit.isSuccess(yield* Effect.exit(helper.cancel(requester.id)))
          exits.cancelBefore = Exit.isSuccess(yield* Effect.exit(helper.cancel(before.id)))
          return clean()
        })
      const run = yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(exits).toEqual({
        requester: false,
        before: false,
        stranger: false,
        theirs: false,
        plain: false,
        research: false,
        mine: true,
        cancelRequester: false,
        cancelBefore: false,
      })
      expect(prompts).toEqual([mine!])
      expect(run.result?.sessions).toEqual([mine!])
      // A handle kept past the end of its run reaches nothing.
      const late = yield* Effect.exit(
        kept!.prompt({ sessionID: mine!, agent: "review", parts: [{ type: "text", text: "x" }] }),
      )
      expect(Exit.isFailure(late)).toBe(true)
      expect(prompts).toEqual([mine!])
    }),
  )

  it.instance("a prompt through the handle keeps the member's rules: no tools, budget or other agent", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts } = recorder()
      const exits: Record<string, boolean> = {}
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          const helper = context.helper!
          const mine = (yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })).id
          const attempt = (name: string, extra: Partial<SessionPrompt.PromptInput>) =>
            helper.prompt({ sessionID: mine, parts: [{ type: "text", text: "x" }], ...extra }).pipe(
              Effect.exit,
              Effect.map((exit) => void (exits[name] = Exit.isSuccess(exit))),
            )
          yield* attempt("tools", { agent: "review", tools: { bash: true, edit: true } })
          yield* attempt("budget", { agent: "review", budget: { usd: 100 } })
          yield* attempt("noReply", { agent: "review", noReply: true })
          yield* attempt("build", { agent: "build" })
          yield* attempt("none", {})
          yield* attempt("security", { agent: "security" })
          yield* attempt("review", { agent: "review" })
          return clean()
        })
      yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(exits).toEqual({
        tools: false,
        budget: false,
        noReply: false,
        build: false,
        none: false,
        security: true,
        review: true,
      })
      expect(prompts.length).toBe(2)
    }),
  )

  it.instance("an earlier run's helper is not the next run's", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts } = recorder()
      let first: SessionID | undefined
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          first = (yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })).id
          yield* context.helper!.prompt({ sessionID: first, agent: "review", parts: [{ type: "text", text: "x" }] })
          return clean()
        })
      yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      let reached: boolean | undefined
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            context.helper!.prompt({ sessionID: first!, agent: "review", parts: [{ type: "text", text: "x" }] }),
          )
          reached = Exit.isSuccess(exit)
          return clean()
        })
      const second = yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(reached).toBe(false)
      expect(prompts).toEqual([first!])
      expect(second.result?.sessions).toEqual([])
    }),
  )

  it.instance("only the vectorscope adapter gets the handle, and every adapter gets the requester's spend", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const guard = yield* SpendGuard.Service
      const { ops } = recorder()
      yield* hub.run({
        request: review(requester.id, directory, { to: "other" }),
        call: { ...asker(), promptOps: ops },
      })
      yield* hub.run({ request: review(requester.id, directory), call: asker() })
      yield* guard.arm(requester.id, { usd: 1 })
      yield* guard.begin(requester.id)
      yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(seen.map((item) => [item.id, item.context.helper !== undefined])).toEqual([
        ["other", false],
        ["vectorscope", false],
        ["vectorscope", true],
      ])
      expect(seen[0].context.spend).toEqual({ running: false })
      expect(seen[0].context.remainingUsd).toBeUndefined()
      expect(seen[2].context.spend).toMatchObject({ running: true, limitUsd: 1, spentUsd: 0 })
      expect(seen[2].context.remainingUsd).toBe(1)
      expect(seen[2].context.sessionID).toBe(requester.id)
      expect(seen[2].context.directory).toBe(directory)
      yield* guard.end(requester.id)
    }),
  )
})

describe("results persist with the session", () => {
  it.instance("after a restart, an earlier run is found by its id for findings, since and fix", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, message, sessions } = yield* setup()
      script.handle = () => Effect.succeed(flagged())
      const first = yield* hub.run({ request: review(requester.id, directory), call: asker() })
      yield* save(requester.id, message.id, first)
      expect((yield* hub.get(first.id, requester.id))?.id).toBe(first.id)

      yield* disposeAllInstancesEffect
      yield* Effect.gen(function* () {
        const fresh = yield* ConnectHub.Service
        expect(yield* fresh.runs()).toEqual([])
        const found = yield* fresh.get(first.id, requester.id)
        expect(found?.result?.findings.map((item) => item.id)).toEqual(["f1", "f2"])
        expect(found?.result?.target).toEqual({ kind: "uncommitted" })
        // Only the session that asked finds it.
        const other = yield* sessions.create({ title: "Other" })
        expect(yield* fresh.get(first.id, other.id)).toBeUndefined()
        expect(yield* fresh.get(first.id)).toBeUndefined()

        script.handle = () => Effect.succeed(clean())
        yield* say(requester.id, "review again")
        const compared = yield* fresh.run({
          request: review(requester.id, directory, { since: first.id }),
          call: asker(),
        })
        expect(compared.result?.state).toBe("completed")
        expect(seen.at(-1)?.context.previous?.id).toBe(first.id)

        const staged = yield* fresh.run({
          request: review(requester.id, directory, { since: first.id, target: { kind: "staged" } }),
          call: asker(),
        })
        expect(staged.result?.refusal).toBe("input")

        const missing = yield* fresh.run({
          request: review(requester.id, directory, { since: Connect.RunID.create() }),
          call: asker(),
        })
        expect(missing.result?.refusal).toBe("input")

        const fixed = yield* fresh.run({ request: fix(requester.id, directory, first.id, ["f2"]), call: asker() })
        expect(fixed.result?.state).toBe("completed")
        expect(seen.at(-1)?.context.source?.id).toBe(first.id)
        const unknown = yield* fresh.run({ request: fix(requester.id, directory, first.id, ["f9"]), call: asker() })
        expect(unknown.result?.refusal).toBe("input")
        expect(unknown.result?.summary).toContain("f9")
      }).pipe(provideInstance(directory))
    }),
  )
})

describe("runs saved in a session after a restart", () => {
  it.instance("a run cut off mid-way reads as cancelled, and the session's saved runs are listed", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, message } = yield* setup()
      const done = yield* hub.run({ request: review(requester.id, directory), call: asker() })
      yield* save(requester.id, message.id, done)
      // The tool part of a run that was going when Vector stopped: the processor marks it an error and keeps it.
      const id = Connect.RunID.create()
      const cut: Connect.Run = {
        id,
        request: { ...done.request, id },
        status: "running",
        progress: { message: "Reading the diff", at: done.time.created + 2 },
        time: { created: done.time.created + 1, started: done.time.created + 1 },
      }
      yield* save(requester.id, message.id, cut, true)

      yield* disposeAllInstancesEffect
      yield* Effect.gen(function* () {
        const fresh = yield* ConnectHub.Service
        const found = yield* fresh.get(id, requester.id)
        expect(found?.status).toBe("done")
        expect(found?.progress).toBeUndefined()
        expect(found?.result).toMatchObject({
          state: "cancelled",
          verdict: "not-reviewed",
          summary: ConnectHub.STOPPED_SUMMARY,
        })
        expect(yield* fresh.cancel(id)).toBe(false)
        // The ledger is only a cache: the session's own runs are listed, newest first; without a session, the
        // ledger alone.
        expect((yield* fresh.runs({ sessionID: requester.id })).map((run) => [run.id, run.status])).toEqual([
          [id, "done"],
          [done.id, "done"],
        ])
        expect(yield* fresh.runs()).toEqual([])
        // A cut-off review is nothing to compare with.
        const compared = yield* fresh.run({ request: review(requester.id, directory, { since: id }), call: asker() })
        expect(compared.result?.refusal).toBe("input")
      }).pipe(provideInstance(directory))
    }),
  )
})

describe("members", () => {
  it.instance("the list has the adapters, the agents, the helpers, and Hands as not in this build", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      yield* hub.run({ request: review(requester.id, directory), call: asker() })
      const list = yield* hub.members({ tools: ["read", "task", "research"] })
      const byID = new Map(list.map((item) => [item.id, item]))
      expect(byID.get("vectorscope")?.reach).toBe("connect")
      expect(byID.get("vectorscope")?.activity).toMatchObject({ running: 0 })
      expect(byID.get("listed")?.reach).toBe("none")
      expect(byID.get("agent:build")?.reach).toBe("ui")
      expect(byID.get("research")?.reach).toBe("research")
      expect(byID.get("tasks")?.state).toBe("ready")
      expect(byID.get("computer")).toMatchObject({ state: "not-installed", reason: "Not in this build." })
      expect(byID.get("browser")?.state).toBe("unavailable")
      expect(byID.get("github-agent")?.state).toBe("not-installed")
      expect(byID.get("tool:read")?.reach).toBe("read")
      // Without the tool ids (outside the HTTP view), members reached through a tool are left out.
      expect((yield* hub.members()).some((item) => item.id === "computer")).toBe(false)
      for (const item of list) expect(item.state === "ready" || item.reason !== undefined).toBe(true)
    }),
  )

  it.instance("Vector Local marks cloud members and code sent past the listed model servers as off", () =>
    Effect.sync(() => {
      const list = ConnectMembers.compose({
        adapters: [member("vectorscope", ["read"], { sendsTo: "provider:openai" }), member("other")],
        agents: [],
        skills: [],
        workflows: [{ name: "ship", title: "Ship", issues: [{ message: "bad stage" }] }],
        mcp: { remote: { status: "failed", error: "Off in Vector Local: not listed" }, docs: { status: "connected" } },
        tools: ["vector_cloud", "computer"],
        githubAgent: true,
        local: true,
      })
      const byID = new Map(list.map((item) => [item.id, item]))
      expect(byID.get("vectorscope")).toMatchObject({ state: "off" })
      expect(byID.get("vectorscope")?.reason).toContain("provider openai")
      expect(byID.get("other")?.state).toBe("ready")
      expect(byID.get("vector-cloud")?.state).toBe("off")
      expect(byID.get("github-agent")?.state).toBe("off")
      expect(byID.get("computer")).toMatchObject({ state: "ready", owner: "hands", reach: "computer" })
      expect(byID.get("mcp:remote")?.state).toBe("off")
      expect(byID.get("mcp:docs")?.state).toBe("ready")
      expect(byID.get("workflow:ship")?.state).toBe("unavailable")
      // Each helper Vector names is listed, or covered by another member.
      expect(Object.keys(ConnectMembers.HELPERS).every((name) => /^[a-z]+(-[a-z]+)*$/.test(name))).toBe(true)
    }),
  )
})

describe("MCP servers in the registry", () => {
  const legacy = testEffect(
    graph(
      { experimentalConnect: true },
      Layer.effect(
        MCP.Service,
        Effect.gen(function* () {
          const { snapshot, ...mcp } = yield* MCP.Service
          expect(snapshot).toBeDefined()
          const probe = () => Effect.die(new Error("An inventory read must not probe the legacy MCP service"))
          return MCP.Service.of({
            ...mcp,
            status: probe,
            clients: probe,
            tools: probe,
            cloudTools: probe,
            startAuth: probe,
            authenticate: probe,
            finishAuth: probe,
            getAuthStatus: probe,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(MCP.node))),
    ),
  )

  legacy.instance(
    "missing snapshot capability lists configuration without probing MCP",
    () =>
      Effect.gen(function* () {
        const hub = yield* ConnectHub.Service
        const list = (yield* hub.members()).filter((member) => member.kind === "mcp")
        expect(list.map((member) => member.id).sort()).toEqual(["mcp:disabled", "mcp:local", "mcp:remote"])
        for (const member of list)
          expect(member).toMatchObject({
            state: "unavailable",
            reason: "Configured; connection status is unavailable in this engine.",
          })
        expect(list.find((member) => member.id === "mcp:local")?.place).toBe("local")
        expect(list.find((member) => member.id === "mcp:remote")?.place).toBe("your-cloud")
      }),
    {
      trusted: true,
      init: (directory) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "mcp-fixture.cjs"), "process.exit(0)\n")),
      config: {
        mcp: {
          local: { type: "local", command: ["node", "mcp-fixture.cjs"] },
          disabled: { type: "local", command: ["node", "mcp-fixture.cjs"], enabled: false },
          remote: { type: "remote", url: "https://example.invalid/mcp" },
        },
      },
    },
  )

  it.effect("a remote MCP server is listed where its code runs, and keeps MCP's own status", () =>
    Effect.sync(() => {
      const list = (local: boolean) =>
        new Map(
          ConnectMembers.compose({
            adapters: [],
            agents: [],
            skills: [],
            workflows: [],
            mcp: {
              cold: { status: "uninitialized" },
              docs: { status: "connected" },
              tracker: { status: "connected" },
              blocked: { status: "failed", error: "Off in Vector Local: not allowed" },
            },
            remoteMcp: new Set(["tracker", "blocked"]),
            local,
          }).map((item) => [item.id, item]),
        )
      expect(list(false).get("mcp:docs")).toMatchObject({ place: "local", state: "ready" })
      expect(list(false).get("mcp:cold")).toMatchObject({
        state: "unavailable",
        reason: "Configured, but it has not connected in this workspace.",
      })
      expect(list(false).get("mcp:tracker")).toMatchObject({ place: "your-cloud", state: "ready" })
      expect(list(false).get("mcp:tracker")?.summary).toContain("another host")
      // Under Vector Local, MCP decides: a remote server it connected stays ready, one it refused is off.
      expect(list(true).get("mcp:tracker")).toMatchObject({ place: "your-cloud", state: "ready" })
      expect(list(true).get("mcp:blocked")).toMatchObject({ place: "your-cloud", state: "off" })
      expect(list(true).get("mcp:docs")).toMatchObject({ place: "local", state: "ready" })
    }),
  )
})

describe("the read scan", () => {
  // The build agent's read rules that matter here: everything allowed but the kube and docker configs.
  const rules: PermissionV1.Ruleset = [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: ".docker/config.json", action: "ask" },
    { permission: "read", pattern: "**/.docker/config.json", action: "ask" },
    { permission: "read", pattern: ".kube/*", action: "ask" },
    { permission: "read", pattern: "**/.kube/*", action: "ask" },
  ]

  it.effect("a package store is walked once, not again through every link to it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "connect-scan-"))),
      (root) =>
        Effect.promise(async () => {
          const patterns = ConnectPolicy.readPatterns(rules)
          // 2 top-level entries, 50 packages with a file each in the store, and a workspace linking to each: 153
          // entries walked once; walking each link again would make 203.
          for (let index = 0; index < 50; index++) {
            await fs.mkdir(path.join(root, "store", `pkg${index}`), { recursive: true })
            await fs.writeFile(path.join(root, "store", `pkg${index}`, "index.js"), "")
          }
          await fs.mkdir(path.join(root, "ws/node_modules"), { recursive: true })
          for (let index = 0; index < 50; index++)
            await fs.symlink(path.join(root, "store", `pkg${index}`), path.join(root, "ws/node_modules", `pkg${index}`))
          expect(await ConnectHub.scan(root, patterns, rules, { limit: 180 })).toEqual({})
          // Past the limit, the scan says so and the hub refuses.
          expect(await ConnectHub.scan(root, patterns, rules, { limit: 10 })).toEqual({ tooMany: true })
          // A link a rule names by its own name is still walked under that name.
          await fs.mkdir(path.join(root, "conf/kube"), { recursive: true })
          await fs.writeFile(path.join(root, "conf/kube/config"), "")
          await fs.symlink(path.join(root, "conf/kube"), path.join(root, ".kube"))
          const linked = await ConnectHub.scan(root, patterns, rules)
          expect("block" in linked && linked.block?.path).toBe(".kube/config")
        }),
      (root) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
    ),
  )
})

describe("the layer graph", () => {
  it.effect("the hub's dependencies never reach the prompt loop or the tool registry, which will depend on it", () =>
    Effect.sync(() => {
      const names = new Set<string>()
      const walk = (node: LayerNode.Node<unknown, unknown, LayerNode.Tag | undefined>) => {
        if (names.has(node.name)) return
        names.add(node.name)
        node.dependencies.forEach(walk)
      }
      walk(ConnectHub.node)
      for (const name of ["@vector/Permission", "@vector/Session", "@vector/SpendGuard", "@vector/RuntimeFlags"])
        expect(names.has(name)).toBe(true)
      for (const name of ["@vector/ToolRegistry", "@vector/SessionPrompt", "@vector/SessionProcessor"])
        expect(names.has(name)).toBe(false)
    }),
  )
})

describe("no network or model call outside adapters", () => {
  it.effect("the hub, the registry and the adapter contract import nothing that reaches a model or the network", () =>
    Effect.promise(async () => {
      const root = path.join(import.meta.dir, "../../src/connect")
      for (const file of ["hub.ts", "members.ts", "adapter.ts", "adapters/index.ts"]) {
        const text = await fs.readFile(path.join(root, file), "utf8")
        expect(text).not.toMatch(/\bfetch\(/)
        expect(text).not.toMatch(/HttpClient|node:https?|node:net|node:dgram|undici|WebSocket/)
        expect(text).not.toMatch(/from "@\/provider|from "@\/session\/llm|from "ai"|from "@ai-sdk/)
        // The prompt loop is reached only through the helper handle, so no value import of it exists.
        expect(text).not.toMatch(/^import (?!type )[^\n]*from "@\/session\/prompt"/m)
        expect(text).not.toMatch(/^import (?!type )[^\n]*from "@\/tool\/(registry|task)"/m)
      }
    }),
  )
})

function SessionIDOf(value: string) {
  return value as SessionID
}
