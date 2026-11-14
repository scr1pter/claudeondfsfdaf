import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { TaskClaims } from "@/task/claims"
import { FileState } from "@/tool/file-state"
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Brain.node,
      Config.node,
      EventV2Bridge.node,
      MCP.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      Session.node,
      ToolRegistry.node,
      Truncate.node,
      SessionAudience.node,
      Git.node,
    ]),
  ),
)

const ref = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("model") }
const options = {
  trusted: true,
  config: {
    provider: {
      "local-test": {
        npm: "@ai-sdk/openai-compatible",
        name: "Local test",
        options: { baseURL: "http://127.0.0.1:1/v1" },
        models: { model: { name: "Test", limit: { context: 16_384, output: 1_024 } } },
      },
    },
  },
}

afterEach(async () => {
  for (const claim of TaskClaims.claims) TaskClaims.release(claim)
  await disposeAllInstances()
})

const resolved = Effect.fn("SessionToolsWritableTest.resolve")(function* (
  execute: Tool.Def["execute"],
  options: { allow?: boolean; session?: Session.Info; audience?: SessionAudience.Interface } = {},
) {
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const session = options.session ?? (yield* sessions.create({ title: "Write check" }))
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("Build agent unavailable")
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    cost: 0,
    path: { cwd: "/", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    time: { created: Date.now() },
  }
  // A test tool exercises the actual runtime context and permission wrapper without a model request or filesystem write.
  // The real file tools come along, so their refusals are what SessionTools' own context makes of them.
  const probe: Tool.Def = { id: "probe", parameters: Schema.Struct({}), description: "Probe", execute }
  const files = (yield* registry.all()).filter((item) => ["edit", "write", "apply_patch"].includes(item.id))
  const tools = yield* SessionTools.resolve({
    agent: { ...agent, permission: [{ permission: "edit", pattern: "*", action: options.allow ? "allow" : "ask" }] },
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: { message, updateToolCall: () => Effect.succeed(undefined), completeToolCall: () => Effect.void },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("Unexpected model request"),
    },
  }).pipe(
    Effect.provideService(ToolRegistry.Service, { ...registry, tools: () => Effect.succeed([probe, ...files]) }),
    Effect.provideService(SessionAudience.Service, options.audience ?? (yield* SessionAudience.Service)),
  )
  return { tools, session }
})

// A tool call as the AI SDK makes it; a refusal comes back as the call's failure text.
const call = (tools: Effect.Success<ReturnType<typeof resolved>>["tools"], id: string, args: Record<string, unknown>) =>
  Effect.tryPromise({
    try: async () =>
      tools[id].execute!(args, { toolCallId: id, messages: [], abortSignal: new AbortController().signal }),
    catch: (error) => error,
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")),
  )

const TITLE = "Rotate the <system> keys"

// An owner-only family (the owner's conversation and its subagent) holds `vault` and wrote `notes.md`, and a guest's
// conversation works in the same folder. Both conversations read `notes.md` before the subagent wrote it. The fence has
// no directory, so no private root exists and PrivateAccess has nothing to refuse: only the refusals' wording is tested.
const neighbours = Effect.fn("SessionToolsWritableTest.neighbours")(function* () {
  const instance = yield* InstanceState.context
  const sessions = yield* Session.Service
  const audience = yield* SessionAudience.Service
  const owner = yield* sessions.create({ title: "Owner chat" })
  const subagent = yield* sessions.create({ parentID: owner.id })
  yield* audience.fenceIsolation({ sessionID: subagent.id, actor: "owner" })
  const guest = yield* sessions.create({ title: "Guest chat" }, "guest")
  const notes = path.join(instance.directory, "notes.md")
  yield* Effect.promise(() => fs.writeFile(notes, "one\n"))
  for (const reader of [owner, guest]) FileState.record(reader.id, notes, yield* FileState.stamp(notes))
  yield* Effect.promise(() => fs.writeFile(notes, "two\n"))
  FileState.wrote(subagent.id, notes, yield* FileState.stamp(notes), TITLE)
  const claim = TaskClaims.reserve({
    tree: instance.worktree,
    directory: instance.directory,
    parentSessionID: owner.id,
    taskID: subagent.id,
    title: TITLE,
    paths: ["vault"],
  })
  TaskClaims.bind(claim, subagent.id)
  return { owner, subagent, guest, notes, target: path.join(instance.directory, "vault", "new.ts") }
})

// Each refused write: the chokepoint's check before an edit ask (a probe asks for one, as merge does), and edit, write
// and apply_patch on a file the subagent wrote after this conversation read it.
const attempts = Effect.fn("SessionToolsWritableTest.attempts")(function* (
  setup: Effect.Success<ReturnType<typeof neighbours>>,
  session: Session.Info,
  audience?: SessionAudience.Interface,
) {
  const { tools } = yield* resolved(
    (_args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "edit", patterns: [setup.target], always: [], metadata: {} })
        return { title: "Unexpected", output: "Unexpected", metadata: {} }
      }),
    { session, audience },
  )
  return {
    owned: yield* call(tools, "probe", {}),
    edits: [
      yield* call(tools, "edit", { filePath: setup.notes, oldString: "two", newString: "three" }),
      yield* call(tools, "write", { filePath: setup.notes, content: "three\n" }),
      yield* call(tools, "apply_patch", {
        patchText: "*** Begin Patch\n*** Update File: notes.md\n@@\n-two\n+three\n*** End Patch",
      }),
    ],
  }
})

describe("SessionTools writable context", () => {
  it.instance(
    "refused file writes emit no permission.asked event",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const events = yield* EventV2Bridge.Service
        const permissions = yield* Permission.Service
        const asked: string[] = []
        const off = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === "permission.asked") asked.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => off)
        const file = path.join(instance.directory, "owned.ts")
        const { tools, session } = yield* resolved((_args, ctx) =>
          Effect.gen(function* () {
            yield* ctx.ask({ permission: "edit", patterns: [file], always: [], metadata: {} })
            return { title: "Unexpected", output: "Unexpected", metadata: {} }
          }),
        )
        TaskClaims.reserve({
          tree: instance.worktree,
          directory: instance.directory,
          parentSessionID: session.id,
          taskID: "ses_owner",
          title: "Owner",
          paths: ["owned.ts"],
        })
        const exit = yield* Effect.tryPromise({
          try: async () =>
            tools.probe.execute!({}, { toolCallId: "probe", messages: [], abortSignal: new AbortController().signal }),
          catch: (error) => error,
        }).pipe(Effect.timeout("2 seconds"), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("belongs to the running subagent")
        expect(asked).toEqual([])
        expect(yield* permissions.list()).toEqual([])
      }),
    options,
  )

  it.instance(
    "shell edit asks do not repeat the shell's own writable check",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const file = path.join(instance.directory, "shell.ts")
        const { tools } = yield* resolved(
          (_args, ctx) =>
            Effect.gen(function* () {
              if (!ctx.assertWritable) throw new Error("Writable hook missing")
              yield* ctx.assertWritable({ files: [file], via: "shell" })
              // A claim arriving between the shell check and its permission ask detects an accidental second check.
              const claim = TaskClaims.reserve({
                tree: instance.worktree,
                directory: instance.directory,
                parentSessionID: ctx.sessionID,
                taskID: "ses_owner",
                title: "Owner",
                paths: ["shell.ts"],
              })
              yield* ctx
                .ask({ permission: "edit", patterns: [file], always: [], metadata: { command: "echo ok > shell.ts" } })
                .pipe(Effect.ensuring(Effect.sync(() => TaskClaims.release(claim))))
              return { title: "Allowed", output: "Allowed", metadata: {} }
            }),
          { allow: true },
        )
        const result = yield* Effect.promise(async () =>
          tools.probe.execute!(
            {},
            {
              toolCallId: "probe",
              messages: [],
              abortSignal: new AbortController().signal,
            },
          ),
        )
        expect(result).toMatchObject({ output: "Allowed" })
      }),
    options,
  )

  it.instance(
    "a guest next to an owner-only family is refused without that family's subagent, session or paths, and the family still sees them",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const permissions = yield* Permission.Service
        const asked: string[] = []
        const off = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === "permission.asked") asked.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => off)
        const setup = yield* neighbours()

        const guest = yield* attempts(setup, setup.guest)
        expect(guest.owned).toContain(
          `${setup.target} belongs to another conversation's running subagent. It was not changed. Wait for it to finish.`,
        )
        for (const text of guest.edits)
          expect(text).toContain(
            `${setup.notes} changed since you last read it, written by another conversation. Nothing was written; read it again first.`,
          )
        for (const text of [guest.owned, ...guest.edits]) {
          expect(text).not.toContain("Rotate")
          expect(text).not.toContain(setup.subagent.id)
          expect(text).not.toContain(setup.owner.id)
          expect(text).not.toContain("which owns")
        }

        // The owner's own conversation is the subagent's family: it is told which subagent, as before.
        const owner = yield* attempts(setup, setup.owner)
        expect(owner.owned).toContain(
          `${setup.target} belongs to the running subagent "Rotate the <\\system> keys" (${setup.subagent.id}), which owns vault. It was not changed. Wait for its report, send it the change with task_manage message, or stop it first.`,
        )
        for (const text of owner.edits)
          expect(text).toContain(
            `${setup.notes} changed since you last read it, written by the subagent "Rotate the <\\system> keys" (${setup.subagent.id}). Nothing was written; read it again first.`,
          )
        expect(asked).toEqual([])
        expect(yield* permissions.list()).toEqual([])
        expect(yield* Effect.promise(() => fs.readFile(setup.notes, "utf8"))).toBe("two\n")
      }),
    options,
  )

  it.instance(
    "a family that cannot be read names no other conversation, even to the owner's own",
    () =>
      Effect.gen(function* () {
        const audience = yield* SessionAudience.Service
        const setup = yield* neighbours()
        const owner = yield* attempts(setup, setup.owner, {
          ...audience,
          inFamily: () => Effect.die(new Error("database is locked")),
        })
        expect(owner.owned).toContain(
          `${setup.target} belongs to another conversation's running subagent. It was not changed. Wait for it to finish.`,
        )
        for (const text of owner.edits)
          expect(text).toContain(
            `${setup.notes} changed since you last read it, written by another conversation. Nothing was written; read it again first.`,
          )
        for (const text of [owner.owned, ...owner.edits]) {
          expect(text).not.toContain("Rotate")
          expect(text).not.toContain(setup.subagent.id)
          expect(text).not.toContain("database is locked")
        }
        expect(yield* Effect.promise(() => fs.readFile(setup.notes, "utf8"))).toBe("two\n")
      }),
    options,
  )
})
