import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Brain } from "@vectordevai/core/brain/brain"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { PINNED_SESSION_PREFIX } from "@vectordevai/core/review/prompt"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
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
import type { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-34's tool half (SF-14) at the session runtime: SessionTools gives the read and grep tools `extra.holdback` only in
// a review session (internal `vectorscope.*`) whose stored rules hold back (core permission.ts holdsBack), and the
// tools then answer from those rules, read again without regard to case. Sessions are created through Session.create,
// which registers each one with the real SessionAudience; asks are recorded and allowed, so what refuses below is the
// tools' own reading of the session's rules.
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
  git: true,
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

afterEach(disposeAllInstances)

const TOKEN = "ghp_" + "s1E2".repeat(9)
const SECRETS = reviewPermissionRules({ holdback: "secrets", held: ["notes.txt"] })
const probeRule = { permission: "probe", pattern: "*", action: "allow" as const }

// The tools SessionTools gives a session: with `execute`, a stub probe alone; without it, the real registry's.
const resolved = Effect.fn("HoldbackToolsTest.resolve")(function* (
  session: Session.Info,
  execute?: Tool.Def["execute"],
) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const permission = yield* Permission.Service
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
  const probe = execute && { id: "probe", parameters: Schema.Struct({}), description: "Probe", execute }
  return yield* SessionTools.resolve({
    agent,
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: {
      message,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
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
    Effect.provideService(Permission.Service, { ...permission, ask: () => Effect.succeed(undefined) }),
  )
})

const call = (tools: Record<string, { execute?: (...args: never[]) => unknown }>, name: string, args: unknown = {}) =>
  Effect.tryPromise({
    try: async () =>
      (tools[name].execute as (args: unknown, options: unknown) => Promise<unknown>)(args, {
        toolCallId: `${name}-${crypto.randomUUID()}`,
        messages: [],
        abortSignal: new AbortController().signal,
      }),
    catch: (error) => error,
  }).pipe(Effect.exit)

// What a probe tool in a session with these rules and this internal name sees as `extra.holdback`.
const seen = Effect.fn("HoldbackToolsTest.seen")(function* (internal: string | undefined, rules: PermissionV1.Rule[]) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    title: "Holdback probe",
    ...(internal ? { internal } : {}),
    permission: [...rules, probeRule],
  })
  const extras: unknown[] = []
  const tools = yield* resolved(session, (_args, ctx) =>
    Effect.sync(() => {
      extras.push(ctx.extra?.holdback)
      return { title: "Probe", output: "", metadata: {} }
    }),
  )
  expect((yield* call(tools, "probe"))._tag).toBe("Success")
  return { session, holdback: extras[0] }
})

describe("the session runtime's holdback extra (VS-34, SF-14)", () => {
  it.instance(
    "only a review session whose rules hold back gets it, and the finalizer's rules keep it",
    () =>
      Effect.gen(function* () {
        expect((yield* seen("vectorscope.review", SECRETS)).holdback).toBe("secrets")
        expect((yield* seen(`${PINNED_SESSION_PREFIX}security`, SECRETS)).holdback).toBe("secrets")
        // The same rules outside a review session, or a review session with other rules, get nothing.
        for (const [internal, rules] of [
          [undefined, SECRETS],
          ["workflow.review", SECRETS],
          ["vectorscope.review", reviewPermissionRules({})],
          ["vectorscope.review", reviewPermissionRules({ holdback: "off", held: ["notes.txt"] })],
          ["vectorscope.review", reviewPermissionRules({ checks: true })],
        ] as const)
          expect([internal, yield* seen(internal, [...rules]).pipe(Effect.map((result) => result.holdback))]).toEqual([
            internal,
            undefined,
          ])
        // The finalizer appends a deny-all and the StructuredOutput allow to the session's rules (run.ts); the probe's
        // own allow follows them so it can run, and the stored rules still hold back.
        const sessions = yield* Session.Service
        const { session } = yield* seen("vectorscope.review", SECRETS)
        yield* sessions.setPermission({
          sessionID: session.id,
          permission: [
            ...SECRETS,
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "StructuredOutput", pattern: "*", action: "allow" },
            probeRule,
          ],
        })
        const extras: unknown[] = []
        const tools = yield* resolved(yield* sessions.get(session.id), (_args, ctx) =>
          Effect.sync(() => {
            extras.push(ctx.extra?.holdback)
            return { title: "Probe", output: "", metadata: {} }
          }),
        )
        expect((yield* call(tools, "probe"))._tag).toBe("Success")
        expect(extras).toEqual(["secrets"])
      }),
    options,
  )

  it.instance(
    "a review session's real read and grep tools redact and refuse under the key, and unset do neither",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        for (const [file, text] of Object.entries({
          "src/config.ts": `export const token = "${TOKEN}" // needle\nexport const url = process.env.API_URL // needle\n`,
          "config/prod/.envrc": "export DB_PASS=plain-words-only # needle\n",
          "notes.txt": "export DB_PASS=plain-words-only # needle\n",
        })) {
          yield* Effect.promise(() => fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, file), text))
        }
        const sessions = yield* Session.Service
        const tools = (rules: PermissionV1.Rule[]) =>
          sessions
            .create({ title: "Holdback tools", internal: "vectorscope.review", permission: rules })
            .pipe(Effect.flatMap((session) => resolved(session)))
        const held = yield* tools(SECRETS)
        const text = (exit: unknown) => JSON.stringify(exit)

        const config = yield* call(held, "read", { filePath: path.join(directory, "src/config.ts") })
        expect(config._tag).toBe("Success")
        expect(text(config)).not.toContain(TOKEN)
        expect(text(config)).toContain("[redacted]")
        // The ask allows every read here, so the session's own rules, read by the tool, refuse these.
        for (const file of ["config/prod/.envrc", "notes.txt"]) {
          const refused = yield* call(held, "read", { filePath: path.join(directory, file) })
          expect([file, refused._tag]).toEqual([file, "Failure"])
          expect(text(refused)).not.toContain("plain-words-only")
        }
        const found = yield* call(held, "grep", { pattern: "needle" })
        expect(found._tag).toBe("Success")
        expect(text(found)).toContain("process.env.API_URL")
        for (const value of [TOKEN, "plain-words-only", ".envrc", "notes.txt"]) expect(text(found)).not.toContain(value)

        const unset = yield* tools(reviewPermissionRules({}))
        expect(text(yield* call(unset, "read", { filePath: path.join(directory, "src/config.ts") }))).toContain(TOKEN)
        expect(text(yield* call(unset, "grep", { pattern: "needle" }))).toContain("plain-words-only")
      }),
    options,
  )
})
