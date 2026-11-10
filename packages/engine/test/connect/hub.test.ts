import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Connect } from "@vectordevai/schema/connect"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectHub } from "@/connect/hub"
import { ConnectMembers } from "@/connect/members"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionPrompt } from "@/session/prompt"
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

const graph = (flags: Partial<RuntimeFlags.Info>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ConnectHub.nodeWith([fake("vectorscope"), fake("other"), listed]),
      Session.node,
      SpendGuard.node,
      EventV2Bridge.node,
      RuntimeFlags.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
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
const save = (sessionID: SessionID, parentID: MessageID, run: Connect.Run) =>
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
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "Review",
        metadata: ConnectHub.metadata(run),
        time: { start: 1, end: 2 },
      },
    })
  })

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
          yield* context.helper!.prompt({ sessionID: helper.id, parts: [{ type: "text", text: "review" }] })
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

  off.instance("connected tools stay off without VECTOR_EXPERIMENTAL_CONNECT", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      const run = yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(run.result?.refusal).toBe("not-allowed")
      expect(asks).toEqual([])
      expect(seen).toEqual([])
    }),
  )
})

describe("consent", () => {
  it.instance("connect is asked per run, connect_model once per request, connect_write every time", () =>
    Effect.gen(function* () {
      const { directory, hub, requester } = yield* setup()
      const { asks, ask } = asker()
      const model: Connect.Consent = {
        permission: "connect_model",
        patterns: ["paid/model"],
        always: ["paid/model"],
        message: "Review on paid/model.",
        model: "paid/model",
        sendsTo: "provider:paid",
        maxCostUsd: 2,
      }
      const write: Connect.Consent = {
        permission: "connect_write",
        patterns: ["src/a.ts"],
        always: [],
        message: "Fix 1 finding.",
        findings: ["f1"],
      }
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          yield* context.ask(model)
          yield* context.ask(model)
          yield* context.ask(write)
          yield* context.ask(write)
          return clean()
        })
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      const permissions = asks.map((item) => item.permission)
      expect(permissions).toEqual([
        "connect",
        "connect_model",
        "connect_write",
        "connect_write",
        "connect",
        "connect_write",
        "connect_write",
      ])
      expect(asks[0].patterns).toEqual(["vectorscope.review"])
      expect(asks.filter((item) => item.permission === "connect_write").every((item) => item.always.length === 0)).toBe(
        true,
      )
      expect(asks[1].metadata).toMatchObject({ model: "paid/model", sendsTo: "provider:paid", maxCostUsd: 2 })

      yield* say(requester.id, "review again")
      yield* hub.run({ request: review(requester.id, directory), call: { ask } })
      expect(asks.filter((item) => item.permission === "connect_model").length).toBe(2)
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

      // A person's run on a directory with no session has nowhere to ask unless its caller lends an ask.
      const nobody = yield* hub.run({
        request: { ...review(requester.id, directory), requester: { kind: "user" } } as ConnectHub.StartRequest,
      })
      expect(nobody.result?.refusal).toBe("denied")
      expect(nobody.result?.summary).toContain("no session to ask")
    }),
  )
})

describe("the helper handle", () => {
  it.instance("reaches only the run's own hidden helper sessions, and only while the run is going", () =>
    Effect.gen(function* () {
      const { directory, hub, requester, sessions } = yield* setup()
      const { ops, prompts } = recorder()
      const stranger = yield* sessions.create({ title: "Someone else" })
      const theirs = yield* sessions.create({ parentID: stranger.id, internal: "vectorscope.review" })
      const plain = yield* sessions.create({ parentID: requester.id })
      const research = yield* sessions.create({ parentID: requester.id, internal: "research.lead" })
      const mine = yield* sessions.create({ parentID: requester.id, internal: "vectorscope.review" })
      const exits: Record<string, boolean> = {}
      let kept: ConnectAdapter.HelperHandle | undefined
      script.handle = (_request, context) =>
        Effect.gen(function* () {
          const helper = context.helper!
          kept = helper
          const attempt = (name: string, sessionID: SessionID) =>
            helper.prompt({ sessionID, parts: [{ type: "text", text: "x" }] }).pipe(
              Effect.exit,
              Effect.map((exit) => void (exits[name] = Exit.isSuccess(exit))),
            )
          yield* attempt("requester", requester.id)
          yield* attempt("stranger", stranger.id)
          yield* attempt("theirs", theirs.id)
          yield* attempt("plain", plain.id)
          yield* attempt("research", research.id)
          yield* attempt("mine", mine.id)
          exits.cancelRequester = Exit.isSuccess(yield* Effect.exit(helper.cancel(requester.id)))
          return clean()
        })
      const run = yield* hub.run({ request: review(requester.id, directory), call: { ...asker(), promptOps: ops } })
      expect(exits).toEqual({
        requester: false,
        stranger: false,
        theirs: false,
        plain: false,
        research: false,
        mine: true,
        cancelRequester: false,
      })
      expect(prompts).toEqual([mine.id])
      expect(run.result?.sessions).toEqual([mine.id])
      // A handle kept past the end of its run reaches nothing.
      const late = yield* Effect.exit(kept!.prompt({ sessionID: mine.id, parts: [{ type: "text", text: "x" }] }))
      expect(Exit.isFailure(late)).toBe(true)
      expect(prompts).toEqual([mine.id])
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
