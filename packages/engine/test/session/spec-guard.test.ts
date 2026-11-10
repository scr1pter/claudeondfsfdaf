import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { seen } from "../lib/file-state"
import { TestLLMServer } from "../lib/llm-server"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { MessageID, type SessionID } from "../../src/session/schema"
import { execFileSync } from "node:child_process"

// Moment-of-need pointers and the spec guard end to end, against the fake LLM server with no paid model call: a spec
// is linked to the code it names; the agent's read of a linked file carries one line naming it, and its edit one line
// asking it to check the change still meets it, each once per file per request. The transcript keeps placeholders,
// rendered for each request, so a session a guest is in, a model that may train on prompts and a Chat request carry
// neither.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-spec-guard-"))
// Symlinked paths to test repositories, outside them.
const links = mkdtempSync(path.join(os.tmpdir(), "vector-spec-guard-links-"))
afterAll(() => {
  rmSync(config, { recursive: true, force: true })
  rmSync(links, { recursive: true, force: true })
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  SpendGuard.node,
  Auth.node,
  BrainKnowledge.node,
  FreeModelGuests.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Global.node, Global.layerWith({ config })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
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
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const SPEC = `# Auth spec

## 1 Sessions

The \`refreshTokenTtl\` MUST be 14 days.
`
const CODE = "export const refreshTokenTtl = (days: number) => days * 86_400\n"
const POINTER =
  /Documents linked to src\/auth\/session\.ts: \[r[0-9a-z]{12}\] requirement \(The refreshTokenTtl MUST be 14 days\.\)\./g
const GUARD =
  /Linked requirements: \[r[0-9a-z]{12}\] \(The refreshTokenTtl MUST be 14 days\.\)\. Check the change still meets them\./g

const setup = Effect.fn("test.setup")(function* (input: { spec?: string; files?: Record<string, string> } = {}) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const file = path.join(dir, "src", "auth", "session.ts")
  for (const [name, content] of Object.entries(input.files ?? { "src/auth/session.ts": CODE }))
    yield* fs.writeWithDirs(path.join(dir, name), content)
  // Committed, so the file is not a working-tree change that recall would bring the spec in for.
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-q", "-m", "session"], { cwd: dir })
  const knowledge = yield* BrainKnowledge.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, {
    type: "bytes",
    name: "Auth spec.md",
    bytes: new TextEncoder().encode(input.spec ?? SPEC),
    origin: "upload",
  })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  return { llm, knowledge, place, file, dir }
})

const send = Effect.fn("test.send")(function* (sessionID: SessionID, text: string, size?: "standard" | "light") {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const before = (yield* llm.hits).length
  yield* prompt.prompt({
    sessionID,
    agent: "build",
    model: ref,
    ...(size ? { size } : {}),
    parts: [{ type: "text", text }],
  })
  return (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))
})

const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length

it.instance(
  "a read of a linked file carries the pointer once and an edit carries the guard once; the transcript keeps placeholders",
  () =>
    Effect.gen(function* () {
      const { llm, file } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("read", { filePath: file })
      yield* llm.tool("read", { filePath: file, offset: 1, limit: 1 })
      yield* llm.tool("edit", { filePath: file, oldString: "86_400", newString: "86400" })
      yield* llm.tool("edit", { filePath: file, oldString: "86400", newString: "86_400" })
      yield* llm.text("Done.")
      const hits = yield* send(chat.id, "clean up this helper", "standard")
      const last = hits.at(-1) ?? ""
      // Neither line came with the request itself; each came with its tool result, once.
      expect(hits[0]).not.toMatch(POINTER)
      expect(count(hits[1] ?? "", POINTER)).toBe(1)
      expect(count(last, POINTER)).toBe(1)
      expect(count(last, GUARD)).toBe(1)
      const saved = yield* sessions.messages({ sessionID: chat.id })
      const text = JSON.stringify(saved)
      expect(text).not.toContain("14 days")
      expect(text).toContain("[documents linked to src/auth/session.ts]")
      expect(text).toContain("[requirements linked to src/auth/session.ts]")
      const reads = saved
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "read")
      const first = reads[0]
      expect(first?.type === "tool" && first.state.status === "completed" ? first.state.metadata?.loaded : []).toEqual(
        expect.arrayContaining([expect.stringMatching(/^knowledge:r[0-9a-z]{12}$/)]),
      )

      // A guest joins: the owner's private spec is gone from the next request, old results included.
      yield* (yield* FreeModelGuests.Service).mark(chat.id)
      yield* llm.text("Done.")
      const [after] = yield* send(chat.id, "and the next one?", "standard")
      expect(after).not.toContain("14 days")
      expect(after).not.toContain("Documents linked to")
      expect(after).not.toContain("[documents linked to")
    }),
  { git: true },
  60_000,
)

it.instance(
  "a session a guest is in reads and edits the linked file with neither line",
  () =>
    Effect.gen(function* () {
      const { llm, file } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* (yield* FreeModelGuests.Service).mark(chat.id)
      yield* llm.tool("read", { filePath: file })
      yield* llm.tool("edit", { filePath: file, oldString: "86_400", newString: "86400" })
      yield* llm.text("Done.")
      const hits = yield* send(chat.id, "clean up this helper", "standard")
      expect(hits.join("\n")).not.toContain("14 days")
      expect(hits.join("\n")).not.toContain("linked to")
    }),
  { git: true },
  60_000,
)

it.instance(
  "Chat, a model that may train on prompts, and a Light change carry neither line",
  () =>
    Effect.gen(function* () {
      const { file } = yield* setup()
      const instruction = yield* Instruction.Service
      const messageID = MessageID.ascending()
      const asking = (overrides: Partial<Instruction.Asking>): Instruction.Asking => ({
        sessionID: "ses_spec_guard",
        personal: true,
        tier: "standard",
        exclude: new Set(),
        ...overrides,
      })
      const pointer = (overrides: Partial<Instruction.Asking>) =>
        instruction
          .resolve([], file, MessageID.ascending(), asking(overrides))
          .pipe(Effect.map((loaded) => loaded.filter((item) => item.link)))
      const guard = (overrides: Partial<Instruction.Asking>) =>
        instruction
          .guard([], [file], MessageID.ascending(), asking(overrides))
          .pipe(Effect.map((result) => result.links))
      expect(yield* pointer({})).toHaveLength(1)
      expect(yield* guard({})).toHaveLength(1)
      expect(yield* pointer({ tier: "chat" })).toEqual([])
      expect(yield* guard({ tier: "chat" })).toEqual([])
      expect(yield* guard({ tier: "light" })).toEqual([])
      // A model that may train on prompts is not given the owner's private documents.
      expect(yield* pointer({ personal: false })).toEqual([])
      expect(yield* guard({ personal: false })).toEqual([])
      // Twice in one step is still once.
      const once = yield* instruction.resolve([], file, messageID, asking({}))
      const twice = yield* instruction.resolve([], file, messageID, asking({}))
      expect(once.filter((item) => item.link)).toHaveLength(1)
      expect(twice.filter((item) => item.link)).toEqual([])
    }),
  { git: true },
  60_000,
)

// git reports a repository's real path, while Vector can be opened at a symlinked one (macOS /tmp and /var, a linked
// folder of projects), and the agent then reads and edits through it, or through the real path.
it.instance(
  "a repository opened through a symlinked path still gets the pointer and the guard",
  () =>
    Effect.gen(function* () {
      const { file, dir } = yield* setup()
      const linked = path.join(links, path.basename(dir))
      symlinkSync(dir, linked)
      const through = path.join(linked, "src", "auth", "session.ts")
      const asking: Instruction.Asking = { sessionID: "ses_spec_guard", personal: true, tier: "standard", exclude: new Set() }
      const found = yield* Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        const pointed = (target: string) =>
          instruction
            .resolve([], target, MessageID.ascending(), asking)
            .pipe(Effect.map((loaded) => loaded.flatMap((item) => (item.link ? [item.link.file] : []))))
        const guarded = (target: string) =>
          instruction
            .guard([], [target], MessageID.ascending(), asking)
            .pipe(Effect.map((result) => result.links.map((item) => item.file)))
        return {
          root: (yield* instruction.place()).root,
          pointer: { through: yield* pointed(through), real: yield* pointed(file) },
          guard: { through: yield* guarded(through), real: yield* guarded(file) },
        }
      }).pipe(provideInstance(linked))
      // The root is the real path, so a read through the link is under another spelling of it.
      expect(found.root).toBe(dir)
      expect(found.pointer).toEqual({ through: ["src/auth/session.ts"], real: ["src/auth/session.ts"] })
      expect(found.guard).toEqual({ through: ["src/auth/session.ts"], real: ["src/auth/session.ts"] })
    }),
  { git: true },
  60_000,
)

it.instance(
  "the spec guard adds at most about 200 tokens to a request and says how many more changed files are linked",
  () =>
    Effect.gen(function* () {
      const names = Array.from({ length: 10 }, (_, index) => `limitValue${index}`)
      const { llm, dir } = yield* setup({
        spec: `# Limits\n\n${names.map((name, index) => `## ${index + 1} Limit\n\nThe \`${name}\` MUST stay at ${index + 1}.\n`).join("\n")}`,
        files: Object.fromEntries(names.map((name, index) => [`src/limits/${name}.ts`, `export const ${name} = ${index + 1}\n`])),
      })
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* seen(chat.id, ...names.map((name) => path.join(dir, "src", "limits", `${name}.ts`)))
      for (const [index, name] of names.entries())
        yield* llm.tool("edit", {
          filePath: path.join(dir, "src", "limits", `${name}.ts`),
          oldString: `= ${index + 1}`,
          newString: `= ${index + 2}`,
        })
      yield* llm.text("Done.")
      const last = (yield* send(chat.id, "raise every limit by one", "standard")).at(-1) ?? ""
      const lines = [...last.matchAll(/Linked requirements: .*?Check the change still meets them\./g)].map((match) => match[0])
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThan(names.length)
      expect(lines.reduce((sum, line) => sum + Math.round(line.length / 4), 0)).toBeLessThanOrEqual(200)
      expect(last).toContain(`${names.length - lines.length} more changed file`)
      expect(last).toContain("linked to requirements: read")
    }),
  { git: true },
  90_000,
)

it.instance(
  "a file that quotes a placeholder keeps its text, and a line's $ signs stay as written",
  () =>
    Effect.gen(function* () {
      const { llm, file } = yield* setup({
        spec: "# Auth spec\n\n## 1 Sessions\n\nThe `refreshTokenTtl` MUST be 14 days ($& and $' stay).\n",
        files: {
          "src/auth/session.ts": `// [documents linked to src/auth/session.ts] and [requirements linked to src/auth/session.ts]\n${CODE}`,
        },
      })
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("read", { filePath: file })
      yield* llm.tool("edit", { filePath: file, oldString: "86_400", newString: "86400" })
      yield* llm.text("Done.")
      const last = (yield* send(chat.id, "clean up this helper", "standard")).at(-1) ?? ""
      expect(last).toContain("// [documents linked to src/auth/session.ts] and [requirements linked to src/auth/session.ts]")
      expect(count(last, /Documents linked to src\/auth\/session\.ts: \[r[0-9a-z]{12}\] requirement/g)).toBe(1)
      expect(count(last, /Linked requirements: \[r[0-9a-z]{12}\]/g)).toBe(1)
      expect(last).toContain("14 days ($& and $'")
    }),
  { git: true },
  60_000,
)
