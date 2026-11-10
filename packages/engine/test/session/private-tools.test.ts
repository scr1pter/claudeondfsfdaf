import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Brain } from "@vectordevai/core/brain/brain"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The tool boundary (handoff 7.3): a guest family's raw tool output, metadata and errors that name an owner-only
// folder are refused before history, plugins, the truncation file or the model see them. An owner family is
// unaffected. These are checks of detected text, not a filesystem sandbox.
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
      CrossSpawnSpawner.node,
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
const REFUSAL = "This operation could expose private task data."
// A small shell output budget, so a few kilobytes of output reach the truncation file.
const small = { ...options, config: { ...options.config, tool_output: { max_bytes: 4096 } } }
const saved = () => Effect.promise(() => fs.readdir(Truncate.DIR).catch(() => [] as string[]))

afterEach(disposeAllInstances)

// With `execute`, the session's only tool is a stub probe; without it, the real registry's tools run. Asks are
// recorded and allowed; MCP and truncation may be observed.
const resolved = Effect.fn("PrivateToolsTest.resolve")(function* (input: {
  guest: boolean
  execute?: Tool.Def["execute"]
  completed: unknown[]
  updated: unknown[]
  asks?: string[]
  truncated?: string[]
  mcp?: (base: MCP.Interface) => MCP.Interface
}) {
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const audience = yield* SessionAudience.Service
  const permission = yield* Permission.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const session = yield* sessions.create({ title: input.guest ? "Guest family" : "Owner family" })
  if (input.guest) yield* audience.markGuest(session.id)
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
  const execute = input.execute
  const probe = execute && { id: "probe", parameters: Schema.Struct({}), description: "Probe", execute }
  return yield* SessionTools.resolve({
    agent,
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: {
      message,
      updateToolCall: (_id, update) =>
        Effect.sync(() => {
          input.updated.push(update)
          return undefined
        }),
      completeToolCall: (_id, output) => Effect.sync(() => void input.completed.push(output)),
    },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("Unexpected model request"),
    },
  }).pipe(
    Effect.provideService(
      ToolRegistry.Service,
      probe ? { ...registry, tools: () => Effect.succeed([probe]) } : registry,
    ),
    Effect.provideService(Permission.Service, {
      ...permission,
      ask: (request) => Effect.sync(() => void input.asks?.push(request.permission)),
    }),
    Effect.provideService(MCP.Service, input.mcp ? input.mcp(mcp) : mcp),
    Effect.provideService(Truncate.Service, {
      ...truncate,
      output: (text, options, agent) =>
        Effect.sync(() => void input.truncated?.push(text)).pipe(Effect.andThen(truncate.output(text, options, agent))),
    }),
  )
})

const call = (tools: Record<string, { execute?: (...args: never[]) => unknown }>, name = "probe", args: unknown = {}) =>
  Effect.tryPromise({
    try: async () =>
      (tools[name].execute as (args: unknown, options: unknown) => Promise<unknown>)(args, {
        toolCallId: `${name}-${crypto.randomUUID()}`,
        messages: [],
        abortSignal: new AbortController().signal,
      }),
    catch: (error) => error,
  }).pipe(Effect.exit)

describe("guest tool output", () => {
  it.instance(
    "a guest family's output, metadata and errors naming a private folder are refused; an owner's are not",
    () =>
      Effect.gen(function* () {
        const audience = yield* SessionAudience.Service
        const secret = path.join(yield* tmpdirScoped(), "private-task-checkout")
        yield* audience.fenceIsolation({ sessionID: "ses_private_tools_fence", actor: "owner", directory: secret })
        const result = { title: "Probe", output: `worktree ${secret}`, metadata: {} }

        for (const guest of [true, false]) {
          const completed: unknown[] = []
          const updated: unknown[] = []
          const output = yield* resolved({ guest, completed, updated, execute: () => Effect.succeed(result) })
          const exit = yield* call(output)
          expect(exit._tag).toBe(guest ? "Failure" : "Success")
          if (guest && exit._tag === "Failure") {
            const error = String(exit.cause)
            expect(error).toContain(REFUSAL)
            expect(error).not.toContain(secret)
          }

          // Streamed metadata reaches history while the call runs, so it is checked too.
          const streaming = yield* resolved({
            guest,
            completed,
            updated,
            execute: (_args, ctx) =>
              ctx.metadata({ title: "Probe", metadata: { output: secret } }).pipe(Effect.as({ ...result, output: "" })),
          })
          expect((yield* call(streaming))._tag).toBe(guest ? "Failure" : "Success")
          expect(updated.length).toBe(guest ? 0 : 1)

          // An error is shown to the model like output, so its text is checked as well.
          const failing = yield* resolved({
            guest,
            completed,
            updated,
            execute: () => Effect.die(new Error(`cannot open ${secret}/src/index.ts`)),
          })
          const failed = yield* call(failing)
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") expect(String(failed.cause).includes(secret)).toBe(!guest)
        }
      }),
    options,
  )

  it.instance(
    "Tool.define refuses a guest's private output before truncation saves it to a file",
    () =>
      Effect.gen(function* () {
        const audience = yield* SessionAudience.Service
        const secret = path.join(yield* tmpdirScoped(), "private-truncated-checkout")
        yield* audience.fenceIsolation({ sessionID: "ses_private_truncation", actor: "owner", directory: secret })
        const large = `${secret}\n${"line of output\n".repeat(20_000)}`
        const info = yield* Tool.define(
          "large",
          Effect.succeed({
            description: "Large output",
            parameters: Schema.Struct({}),
            execute: () => Effect.succeed({ title: "Large", output: large, metadata: {} }),
          }),
        )
        const tool = yield* Tool.init(info)
        const before = new Set(yield* Effect.promise(() => fs.readdir(Truncate.DIR).catch(() => [] as string[])))
        const refused = yield* tool
          .execute(
            {},
            {
              sessionID: "ses_private_truncation_guest" as never,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
              assertOutput: (value) =>
                audience
                  .containsPrivateText(JSON.stringify(value))
                  .pipe(Effect.flatMap((found) => (found ? Effect.die(new Error(REFUSAL)) : Effect.void))),
            },
          )
          .pipe(Effect.exit)
        expect(refused._tag).toBe("Failure")
        const after = yield* Effect.promise(() => fs.readdir(Truncate.DIR).catch(() => [] as string[]))
        expect(after.filter((file) => !before.has(file))).toEqual([])
      }),
    options,
  )

  // Unix shells only: the command prints with printf, sleep, head and tr.
  if (process.platform !== "win32")
    it.instance(
      "a guest's shell output naming a private folder across two chunks is refused before the truncation file",
      () =>
        Effect.gen(function* () {
          const audience = yield* SessionAudience.Service
          const secret = path.join(yield* tmpdirScoped(), "private-shell-checkout")
          yield* audience.fenceIsolation({ sessionID: "ses_private_shell", actor: "owner", directory: secret })
          const middle = Math.floor(secret.length / 2)
          // The path's first half ends one write; the second half starts the next, which also pushes the output past
          // the budget. The truncation file is written while that chunk is handled, before its streamed preview is
          // checked, so only a check that carries the end of the last chunk sees the path in time.
          const command = [
            `printf '%s%s' "$(head -c 3000 /dev/zero | tr '\\0' a)" '${secret.slice(0, middle)}'`,
            "sleep 0.5",
            `printf '%s\\n%s\\n' '${secret.slice(middle)}' "$(head -c 3000 /dev/zero | tr '\\0' b)"`,
          ].join("; ")
          for (const guest of [true, false]) {
            const before = new Set(yield* saved())
            const asks: string[] = []
            const tools = yield* resolved({ guest, completed: [], updated: [], asks })
            const exit = yield* call(tools, "bash", { command, description: "Print output" })
            const added = (yield* saved()).filter((file) => !before.has(file))
            if (guest) {
              expect(exit._tag).toBe("Failure")
              if (exit._tag === "Failure") expect(String(exit.cause)).toContain(REFUSAL)
              expect(added).toEqual([])
              continue
            }
            // The owner's same command is truncated, and its full output is saved with the path in it.
            expect(exit._tag).toBe("Success")
            const files = yield* Effect.forEach(added, (file) =>
              Effect.promise(() => fs.readFile(path.join(Truncate.DIR, file), "utf8")),
            )
            expect(files.some((file) => file.includes(secret))).toBe(true)
          }
        }),
      small,
    )

  // Unix shells only: the command reads with cat through a wildcard.
  if (process.platform !== "win32")
    it.instance(
      "a guest's shell command reaching a private folder through a wildcard is refused before any ask; an owner's is asked",
      () =>
        Effect.gen(function* () {
          const audience = yield* SessionAudience.Service
          const parent = yield* tmpdirScoped()
          const secret = path.join(parent, "private-shell-glob-checkout")
          yield* Effect.promise(async () => {
            await fs.mkdir(secret, { recursive: true })
            await fs.writeFile(path.join(secret, "secret.ts"), "export const secret = 1\n")
          })
          yield* audience.fenceIsolation({ sessionID: "ses_private_shell_glob", actor: "owner", directory: secret })
          // The command never spells the private folder and its output names no path, so neither text check sees it.
          // Only the outside folder the scan resolves from the wildcard holds it.
          const command = `cat ${path.join(parent, "private-shell-gl")}*/secret.ts`
          expect(command).not.toContain(secret)
          for (const guest of [true, false]) {
            const asks: string[] = []
            const tools = yield* resolved({ guest, completed: [], updated: [], asks })
            const exit = yield* call(tools, "bash", { command, description: "Read a file" })
            if (guest) {
              expect(exit._tag).toBe("Failure")
              if (exit._tag === "Failure") expect(String(exit.cause)).toContain(REFUSAL)
              expect(asks).toEqual([])
              continue
            }
            expect(exit._tag).toBe("Success")
            expect(asks).toContain("external_directory")
          }
        }),
      options,
    )

  it.instance(
    "a guest's read, grep and glob reaching a private folder are refused before any ask; an owner's are asked",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const audience = yield* SessionAudience.Service
        const secret = path.join(yield* tmpdirScoped(), "private-read-checkout")
        yield* Effect.promise(async () => {
          await fs.mkdir(secret, { recursive: true })
          await fs.writeFile(path.join(secret, "secret.ts"), "export const secret = 1\n")
          await fs.symlink(secret, path.join(instance.directory, "alias"), "dir")
        })
        yield* audience.fenceIsolation({ sessionID: "ses_private_read", actor: "owner", directory: secret })
        // None of these arguments spells the private folder, so the call's own arguments pass the text check and only
        // the tools' read guards can stop them: a link into it, and a folder that holds it.
        const calls = [
          ["read", { filePath: "alias/secret.ts" }],
          ["read", { filePath: "alias/missing.ts" }],
          ["grep", { pattern: "secret", path: "alias" }],
          ["glob", { pattern: "**/*.ts", path: "alias" }],
          ["glob", { pattern: "**/*.ts", path: path.dirname(secret) }],
        ] as const
        for (const guest of [true, false]) {
          for (const [name, args] of calls) {
            const asks: string[] = []
            const tools = yield* resolved({ guest, completed: [], updated: [], asks })
            const exit = yield* call(tools, name, args)
            if (guest) {
              expect(exit._tag).toBe("Failure")
              if (exit._tag === "Failure") expect(String(exit.cause)).toContain(REFUSAL)
              expect(asks).toEqual([])
              continue
            }
            expect(asks).toContain(name)
          }
        }
      }),
    options,
  )

  it.instance(
    "a guest's MCP resource naming a private folder is refused before truncation sees it",
    () =>
      Effect.gen(function* () {
        const audience = yield* SessionAudience.Service
        const secret = path.join(yield* tmpdirScoped(), "private-mcp-checkout")
        yield* audience.fenceIsolation({ sessionID: "ses_private_mcp", actor: "owner", directory: secret })
        const text = `${secret}\n${"resource line\n".repeat(10_000)}`
        const mcp = (base: MCP.Interface): MCP.Interface => ({
          ...base,
          clients: () => Effect.succeed({ fake: { getServerCapabilities: () => ({ resources: {} }) } as never }),
          tools: () => Effect.succeed({}),
          readResource: () => Effect.succeed({ contents: [{ uri: "fake://resource", text }] } as never),
        })
        for (const guest of [true, false]) {
          const truncated: string[] = []
          const tools = yield* resolved({ guest, completed: [], updated: [], asks: [], truncated, mcp })
          const exit = yield* call(tools, "read_mcp_resource", { server: "fake", uri: "fake://resource" })
          expect(exit._tag).toBe(guest ? "Failure" : "Success")
          expect(truncated.some((value) => value.includes(secret))).toBe(!guest)
        }
      }),
    options,
  )
})
