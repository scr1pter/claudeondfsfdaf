import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Global } from "@vectordevai/core/global"
import { Token } from "@vectordevai/core/util/token"
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
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// The token gate for the Vector brain, run against the fake LLM server with no paid model call. It sends the same three
// requests ("hi", a Light task, a large Thorough task) once with an empty brain and once with a repository full of
// memory, and measures what memory adds to each request. "hi" must add nothing; the others must stay inside the
// digest plus the recall budget their size allows, and far below what loading the same files whole used to cost.

// Personal memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-memory-tokens-"))
afterAll(() => rmSync(config, { recursive: true, force: true }))

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
  Brain.node,
  BrainKnowledge.node,
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

const RULES = `<!-- vector:managed-rules:start -->
# Repository rules

<!-- Managed by Vector: Vectorscope's Don't flag this again adds rules here. Each line starting with - is a rule: delete the line to remove the rule, or edit it to change the rule. Vector rewrites everything else in this section, so keep notes of your own outside the markers. -->

- Money is integer cents, never floats.
- Route handlers stay thin; logic lives in services (applies to src/routes/**)
- Code review: do not flag "unchecked index" in src/util/array.ts; it was reviewed and is not a problem.
- Code review: do not flag "missing await" in src/jobs/queue.ts; it was reviewed and is not a problem.
- Code review: do not flag "console.log" in scripts/seed.ts; it was reviewed and is not a problem.

<!-- vector:managed-rules:end -->
`

const MEMORY = `# How I work

- Keep answers short; no closing summary.
- I review diffs in the terminal, so keep lines under 120 characters.
- Use Bun for scripts and tests.
`

// A month-old repository's BRAIN.md: decisions and lessons on many topics, about 30 KB, of which one is about login.
const TOPICS = ["billing", "search", "uploads", "exports", "webhooks", "caching", "queues", "emails", "reports", "imports"]
const BRAIN = [
  "# Decisions",
  "",
  ...Array.from({ length: 160 }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length]
    return `- ${topic} change ${index}: the ${topic} module keeps its state in the ${topic}_state table, migrations for ${topic} run in order ${index}, and ${topic} jobs retry three times with backoff before they page anyone on call.`
  }),
  "",
  "# Lessons",
  "",
  "- The login button label comes from src/auth/copy.ts; the login form reads it there, not from the template.",
  "",
].join("\n")

const LEARNED = [
  "Session handling for login lives in src/auth/session.ts; refresh tokens rotate on every use.",
  "Run the auth tests with bun test test/auth from the repository root.",
  ...TOPICS.map((topic) => `The ${topic} service has its own feature flag, ${topic}_v2, read at startup only.`),
]

// Three documents: one about login, two about other things.
const DOCUMENTS = [
  {
    name: "Auth spec.md",
    text: "# Auth spec\n\n## 1 Login\n\nThe login button label MUST read Sign in.\nLogin sessions MUST expire after 14 days without use.\n\n## 2 Tokens\n\nRefresh tokens MUST rotate on every use of a login session, in `rotateRefreshToken`.\n",
  },
  {
    name: "Billing spec.md",
    text: "# Billing spec\n\n## 1 Money\n\nInvoices MUST be issued in integer cents.\nA refund MUST name the invoice it reverses.\n",
  },
  {
    name: "Runbook.md",
    text: "# Runbook\n\n## Deploy\n\n1. Build the release.\n2. Run the smoke checks.\n3. Promote the release to production.\n",
  },
]

type Sizes = { hi: number; ok: number; light: number; large: number }

// One request per fresh session, so nothing but memory differs between the two runs.
const measure = Effect.fn("test.measure")(function* () {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const send = Effect.fnUntraced(function* (text: string, size?: "light" | "thorough") {
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const before = (yield* llm.hits).length
    yield* llm.text("ok")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      ...(size ? { size } : {}),
      parts: [{ type: "text", text }],
    })
    return JSON.stringify((yield* llm.hits)[before]?.body ?? {})
  })
  return {
    hi: yield* send("hi"),
    ok: yield* send("ok"),
    light: yield* send("Rename the login button label to Sign in", "light"),
    large: yield* send("Redesign how login sessions are handled across the auth module", "thorough"),
  }
})

const blocks = (body: string, tag: string) =>
  [...body.replaceAll("\\n", "\n").matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"))].map((match) => match[0])

it.instance(
  "memory adds nothing to a greeting and stays within budget for Light and Thorough work",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
      const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))

      const empty = yield* measure()

      yield* fs.writeWithDirs(path.join(dir, ".vector", "RULES.md"), RULES)
      yield* fs.writeWithDirs(path.join(dir, ".vector", "BRAIN.md"), BRAIN)
      yield* fs.writeWithDirs(path.join(config, "MEMORY.md"), MEMORY)
      const brain = yield* Brain.Service
      const place = yield* (yield* Instruction.Service).place()
      for (const text of LEARNED) yield* brain.propose(place, { kind: "lesson", text, scope: "repository", origin: "user" })
      const full = yield* measure()

      const added = (key: keyof Sizes) => Token.estimate(full[key]) - Token.estimate(empty[key])
      const digest = blocks(full.large, "vector_memory")[0] ?? ""
      const recall = (key: keyof Sizes) => blocks(full[key], "vector_memory_recall")[0] ?? ""
      // What 1.99.109 sent for the same files on every request: each file whole, behind its header, plus the two
      // memory policies (342 tokens) that went out even with no memory at all.
      const legacy =
        342 +
        [
          [path.join(dir, ".vector", "RULES.md"), RULES],
          [path.join(dir, ".vector", "BRAIN.md"), BRAIN],
          [path.join(config, "MEMORY.md"), MEMORY],
        ].reduce((sum, [file, text]) => sum + Token.estimate(`Instructions from: ${file}\n${text}`), 0)

      // The memory tool's definition goes with every Work request, memory or not, in place of the old policies.
      const tool = (body: string) =>
        (JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools?.find(
          (item) => item.function?.name === "memory",
        )
      const report = {
        toolTokens: Token.estimate(JSON.stringify(tool(full.light) ?? {})),
        digestTokens: Token.estimate(digest),
        added: { hi: added("hi"), ok: added("ok"), light: added("light"), large: added("large") },
        recall: { light: Token.estimate(recall("light")), large: Token.estimate(recall("large")) },
        legacyPerRequest: legacy,
      }
      console.log(`memory token gate: ${JSON.stringify(report)}`)

      // A greeting or a bare acknowledgement carries no memory at all, and no memory tool.
      expect(report.added.hi).toBe(0)
      expect(full.hi).not.toContain("vector_memory")
      expect(tool(full.hi)).toBeUndefined()
      expect(report.added.ok).toBe(0)
      expect(full.ok).not.toContain("vector_memory")
      expect(tool(full.ok)).toBeUndefined()
      expect(tool(full.light)).toBeDefined()
      // Light and Thorough work carry the digest plus a recall inside their size's budget.
      expect(digest).toContain("Money is integer cents, never floats.")
      expect(digest).toContain("Keep answers short")
      expect(digest).not.toContain("Code review: do not flag")
      // A scoped rule binds whichever tool touches its files, so it is in the digest rather than left to a read.
      expect(digest).toContain("Route handlers stay thin; logic lives in services (applies to src/routes/**)")
      // No BRAIN.md bulk in the cached prefix.
      expect(digest).not.toContain("billing change")
      expect(recall("light")).toContain("login button label")
      expect(report.recall.light).toBeLessThanOrEqual(Brain.recallBudget("light"))
      expect(report.recall.large).toBeLessThanOrEqual(Brain.recallBudget("thorough"))
      expect(report.added.light).toBeLessThanOrEqual(report.digestTokens + Brain.recallBudget("light"))
      expect(report.added.large).toBeLessThanOrEqual(report.digestTokens + Brain.recallBudget("thorough"))
      // The tool costs less than the two memory policies it replaces (342 tokens), so even an empty brain saves.
      expect(report.toolTokens).toBeLessThan(342)
      // And far less than the same files loaded whole.
      expect(report.added.large).toBeLessThan(legacy / 5)

      // With documents: a greeting still costs nothing, and the rest stays inside the one budget that memory and
      // documents share, beside a line in the digest and one in the tool. The spec is linked to code the working tree
      // is changing, so code-anchored recall competes for the same budget too.
      yield* fs.writeWithDirs(path.join(dir, "src", "auth", "session.ts"), "export function rotateRefreshToken() {}\n")
      const knowledge = yield* BrainKnowledge.Service
      for (const document of DOCUMENTS) {
        const added = yield* knowledge.add(place, { type: "text", name: document.name, text: document.text, origin: "upload" })
        if (added.type === "refused") throw new Error(added.message)
        yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
      }
      const docs = yield* measure()
      const withDocuments = (key: keyof Sizes) => Token.estimate(docs[key]) - Token.estimate(empty[key])
      const documentDigest = blocks(docs.large, "vector_memory")[0] ?? ""
      const documentRecall = (key: keyof Sizes) => blocks(docs[key], "vector_memory_recall")[0] ?? ""
      const documentReport = {
        toolTokens: Token.estimate(JSON.stringify(tool(docs.light) ?? {})),
        digestTokens: Token.estimate(documentDigest),
        added: { hi: withDocuments("hi"), ok: withDocuments("ok"), light: withDocuments("light"), large: withDocuments("large") },
        recall: { light: Token.estimate(documentRecall("light")), large: Token.estimate(documentRecall("large")) },
      }
      console.log(`memory token gate with 3 documents: ${JSON.stringify(documentReport)}`)
      expect(documentReport.added.hi).toBe(0)
      expect(docs.hi).not.toContain("vector_memory")
      expect(docs.hi).not.toContain("Sign in")
      expect(tool(docs.hi)).toBeUndefined()
      expect(documentReport.added.ok).toBe(0)
      expect(documentDigest).toContain("Vector also holds 3 documents for this repository (Auth spec, Billing spec, Runbook)")
      expect(documentReport.digestTokens).toBeLessThanOrEqual(report.digestTokens + 30)
      expect(JSON.stringify(tool(docs.light))).toContain("Documents: search finds their cards")
      expect(documentReport.toolTokens).toBeLessThanOrEqual(report.toolTokens + 45)
      expect(documentRecall("light")).toMatch(/\[r[0-9a-z]{12}\] requirement · Auth spec §1: The login button label MUST read Sign in\./)
      expect(documentRecall("light")).not.toContain("Invoices")
      expect(documentReport.recall.light).toBeLessThanOrEqual(BrainKnowledge.budget("light", { documents: true, tight: false }))
      expect(documentReport.recall.large).toBeLessThanOrEqual(BrainKnowledge.budget("thorough", { documents: true, tight: false }))
      const toolDelta = documentReport.toolTokens - report.toolTokens
      expect(documentReport.added.light).toBeLessThanOrEqual(documentReport.digestTokens + 300 + toolDelta)
      expect(documentReport.added.large).toBeLessThanOrEqual(documentReport.digestTokens + 900 + toolDelta)
      // The link was made, and a greeting or a bare acknowledgement still touches none of it.
      expect(documentRecall("large")).toContain("in rotateRefreshToken.")
      expect(docs.hi).not.toContain("rotateRefreshToken")
      expect(docs.ok).not.toContain("rotateRefreshToken")
    }),
  { git: true },
  60_000,
)

it.instance(
  "the agent learns in one session through the memory tool, and a later session recalls it",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
      const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const send = Effect.fnUntraced(function* (text: string) {
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text }] })
        return chat.id
      })

      yield* llm.tool("memory", {
        action: "add",
        kind: "decision",
        text: "Staging deploys only from the release branch.",
        quote: "we deploy staging from the release branch only",
      })
      yield* llm.text("Noted.")
      const first = yield* send("Remember this: we deploy staging from the release branch only.")
      const tool = (yield* sessions.messages({ sessionID: first }))
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "memory")
      expect(tool?.type === "tool" && tool.state.status === "completed" ? tool.state.output : "").toContain("Saved as m")

      const before = (yield* llm.hits).length
      yield* llm.text("Deploying.")
      yield* send("Deploy the staging environment now")
      const body = JSON.stringify((yield* llm.hits)[before]?.body ?? {})
      expect(body).toContain("vector_memory_recall")
      expect(body).toContain("Staging deploys only from the release branch.")
    }),
  60_000,
)

it.instance(
  "recalled personal memory reaches the model but never the saved transcript",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
      const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
      const brain = yield* Brain.Service
      const place = yield* (yield* Instruction.Service).place()
      yield* brain.propose(place, {
        kind: "preference",
        text: "I ship staging deploys from the release branch on Fridays only.",
        scope: "personal",
        origin: "user",
      })
      yield* brain.propose(place, {
        kind: "decision",
        text: "Staging deploys run through the release workflow in CI.",
        scope: "repository",
        origin: "user",
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const before = (yield* llm.hits).length
      yield* llm.text("Deploying.")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        size: "light",
        parts: [{ type: "text", text: "Ship the staging deploy from the release branch" }],
      })
      const body = JSON.stringify((yield* llm.hits)[before]?.body ?? {})
      expect(body).toContain("Fridays only")
      expect(body).toContain("release workflow in CI")
      const saved = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === "text" && part.synthetic && part.metadata?.["vector.memory.recall"] ? [part] : []))
      expect(saved).toHaveLength(1)
      expect(saved[0]?.text).toContain("release workflow in CI")
      expect(saved[0]?.text).not.toContain("Fridays")
    }),
  60_000,
)
