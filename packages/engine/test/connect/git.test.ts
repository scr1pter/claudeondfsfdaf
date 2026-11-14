import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ConnectHub } from "@/connect/hub"
import { VectorScopeAdapter } from "@/connect/adapters/vectorscope"
import { ConnectGit } from "@/connect/git"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionSummary } from "@/session/summary"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances, TestInstance, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
import { ownerReviewModel } from "../fixture/review-model"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

afterEach(disposeAllInstances)

let unsupported = false
let selectedDirectory = ""
const clients: Git.Interface[] = []
const requirements = () =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(Git.Service)
    if (Option.isNone(found)) return yield* Effect.die(new Error("The actual collector has no Git service"))
    clients.push(found.value)
    // Deliberately swallow one unsupported legacy read. The adapter's poisoned preflight must still prevent a model.
    if (unsupported)
      yield* found.value
        .run(["log", "--output=forbidden-review-output"], { cwd: selectedDirectory })
        .pipe(Effect.catchCause(() => Effect.void))
    return undefined
  })

const summaryLayer = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lspLayer = Layer.succeed(
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

const mcpLayer = Layer.succeed(
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
    startAuth: () => Effect.die("unexpected MCP auth in connect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in connect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in connect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const live = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      LayerNode.make({
        service: ConnectHub.Service,
        layer: ConnectHub.layerWith([VectorScopeAdapter.make({ requirements })]),
        deps: [...ConnectHub.DEPS, ...VectorScopeAdapter.DEPS],
      }),
      Config.node,
      SessionPrompt.node,
      Session.node,
      Git.node,
      CrossSpawnSpawner.node,
      SpendGuard.node,
      RuntimeFlags.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summaryLayer],
      [LSP.node, lspLayer],
      [MCP.node, mcpLayer],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true, experimentalEventSystem: true })],
    ],
  ),
)

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const git = Effect.fn("ConnectSafeGitTest.git")(function* (directory: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd: directory })
  if (result.exitCode !== 0 || result.truncated) throw new Error("Disposable fixture Git failed")
  return result.text().trim()
})
const write = (directory: string, file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })
const calls = (counter: string) =>
  Effect.promise(async () => (await fs.readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length)
const local = process.platform === "linux" ? live.instance : live.instance.skip

const setup = (kind: "clean" | "process") =>
  Effect.gen(function* () {
    unsupported = false
    clients.length = 0
    const instance = yield* TestInstance
    selectedDirectory = instance.directory
    const directory = instance.directory
    const control = yield* tmpdirScoped()
    const counter = path.join(control, "counter")
    const script = path.join(control, "filter.cjs")
    yield* write(
      control,
      "filter.cjs",
      kind === "clean"
        ? [
            'const fs = require("node:fs");',
            'fs.appendFileSync(process.argv[2], "clean\\n");',
            "fs.writeFileSync(1, fs.readFileSync(0));",
            "",
          ].join("\n")
        : [
            'const fs = require("node:fs");',
            'fs.appendFileSync(process.argv[2], "process\\n");',
            "function read(n) { const b = Buffer.alloc(n); let p = 0; while(p < n) { const size = fs.readSync(0, b, p, n - p, null); if (!size) { if (!p) return; throw Error('short packet'); } p += size; } return b; }",
            "function packet() { const h = read(4); if (!h) return undefined; const n = parseInt(h.toString(), 16); return n === 0 ? null : read(n - 4); }",
            "function list() { const out = []; for (;;) { const p = packet(); if (p === undefined) return; if (p === null) return out; out.push(p); } }",
            "function packetOut(b) { fs.writeSync(1, (b.length + 4).toString(16).padStart(4, '0')); fs.writeSync(1, b); }",
            "function flush() { fs.writeSync(1, '0000'); }",
            "if (!list()) process.exit(0); packetOut(Buffer.from('git-filter-server\\n')); packetOut(Buffer.from('version=2\\n')); flush();",
            "if (!list()) process.exit(0); packetOut(Buffer.from('capability=clean\\n')); packetOut(Buffer.from('capability=smudge\\n')); flush();",
            "while (list()) { const data = list(); if (!data) break; packetOut(Buffer.from('status=success\\n')); flush(); for (const b of data) packetOut(b); flush(); flush(); }",
            "",
          ].join("\n"),
    )
    const llm = yield* TestLLMServer
    yield* ownerReviewModel()
    yield* write(
      directory,
      "vector.json",
      JSON.stringify({ ...testProviderConfig(llm.url), model: "lmstudio/test-model" }),
    )
    yield* write(directory, ".gitattributes", "src/probe.ts filter=fixture\n")
    const saved = 'export function computeReviewFixtureValue() { return "A" }\n'
    yield* write(directory, "src/probe.ts", saved)
    yield* write(
      directory,
      "src/call.ts",
      'import { computeReviewFixtureValue } from "./probe"\nexport const result = computeReviewFixtureValue()\n',
    )
    yield* git(directory, ["add", "-A"])
    yield* git(directory, ["commit", "-qm", "safe Git review baseline"])
    const head = yield* git(directory, ["rev-parse", "HEAD"])
    yield* Effect.promise(() => trustWorkspace(directory))
    yield* git(directory, [
      "config",
      `filter.fixture.${kind}`,
      [process.execPath, script, counter].map(quote).join(" "),
    ])
    yield* git(directory, ["config", "filter.fixture.required", "true"])
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const service = yield* Git.Service
        yield* service.run(["config", "--unset-all", `filter.fixture.${kind}`], { cwd: directory })
        yield* service.run(["config", "--unset-all", "filter.fixture.required"], { cwd: directory })
        unsupported = false
      }),
    )
    const change = (letter: string, time: number) =>
      Effect.promise(async () => {
        const file = path.join(directory, "src/probe.ts")
        await fs.writeFile(file, saved.replace('"A"', `"${letter}"`))
        await fs.utimes(file, time, time)
      })
    yield* change("C", 1_900_000_001)
    expect(yield* git(directory, ["status", "--porcelain", "--untracked-files=all"])).toContain("src/probe.ts")
    expect(yield* calls(counter)).toBeGreaterThan(0)
    yield* Effect.promise(() => fs.writeFile(counter, ""))
    yield* change("B", 1_900_000_111)
    if (kind === "process") {
      yield* git(directory, ["add", "--", "src/probe.ts"])
      expect(yield* calls(counter)).toBeGreaterThan(0)
      yield* Effect.promise(() => fs.writeFile(counter, ""))
      yield* change("B", 1_900_000_222)
    }
    yield* write(directory, "src/extra.ts", "export const added = true\n")
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const hub = yield* ConnectHub.Service
    const requester = yield* sessions.create({ title: "Safe Git reviewer" })
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: requester.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: requester.id,
      type: "text",
      text: "Review these changes",
    })
    const ops: TaskPromptOps = {
      cancel: (sessionID) => prompts.cancel(sessionID),
      resolvePromptParts: (text) => prompts.resolvePromptParts(text),
      prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
    }
    const request: ConnectHub.StartRequest = {
      to: "vectorscope",
      action: "review",
      target: { kind: kind === "process" ? "staged" : "uncommitted" },
      requester: { kind: "agent", sessionID: requester.id, agent: "build" },
      directory,
      background: false,
    }
    return {
      directory,
      counter,
      head,
      llm,
      run: () => hub.run({ request, call: { ask: () => Effect.void, promptOps: ops } }),
    }
  })

for (const kind of ["clean", "process"] as const) {
  local(
    `the actual adapter/CLI/Review.run/context never executes the active ${kind} filter`,
    () =>
      Effect.gen(function* () {
        const f = yield* setup(kind)
        const original = yield* Git.Service
        yield* f.llm.push(
          reply()
            .tool("StructuredOutput", {
              summary: "The changes are sound.",
              risk: "low",
              files: [{ path: "src/probe.ts", note: "The return value changed" }],
              findings: [],
            })
            .usage({ input: 100, output: 20 }),
        )
        const run = yield* f.run()
        expect(run.result?.state, run.result?.summary).toBe("completed")
        expect(run.result?.verdict).toBe("clean")
        expect(run.result?.base).toBe(f.head)
        expect(run.result?.sessions.length).toBeGreaterThan(0)
        const requests = yield* f.llm.inputs
        expect(requests.length).toBeGreaterThan(0)
        const content = JSON.stringify(requests)
        expect(content).toContain("src/call.ts")
        expect(content).toContain("Recent commits")
        expect(content).toContain("Blame at the base")
        expect(clients.length).toBeGreaterThan(0)
        expect(clients.every((client) => client !== original)).toBe(true)
        expect(yield* calls(f.counter)).toBe(0)
      }),
    { git: true },
    60_000,
  )
}

for (const kind of ["unsupported-query", "unsupported-metadata"] as const) {
  local(
    `${kind} refuses the actual adapter before a provider request`,
    () =>
      Effect.gen(function* () {
        const f = yield* setup("clean")
        if (kind === "unsupported-query") unsupported = true
        if (kind === "unsupported-metadata") {
          const alternates = path.join(f.directory, ".git", "objects", "info", "alternates")
          yield* Effect.promise(() => fs.writeFile(alternates, f.directory + "\n", { flag: "wx" }))
          yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(alternates, { force: true })))
        }
        const run = yield* f.run()
        expect(run.result?.state, run.result?.summary).toBe("refused")
        expect(yield* f.llm.inputs).toHaveLength(0)
        expect(yield* calls(f.counter)).toBe(0)
      }),
    { git: true },
    60_000,
  )
}

local(
  "the private adapter refuses raw execution, config redirection and unsafe paths without a live fallback",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      for (const args of [
        ["log", "--output=leak"],
        ["grep", "--open-files-in-pager=bad"],
        ["cat-file", "--filters", "HEAD:probe"],
        ["config", "--file", "../outside", "filter.fixture.clean"],
      ]) {
        let model = false
        let entered = false
        const exit = yield* ConnectGit.use(test.directory, (selected) =>
          Effect.gen(function* () {
            entered = true
            yield* selected.git.run(args, { cwd: test.directory }).pipe(Effect.catchCause(() => Effect.void))
            yield* selected.check()
            model = true
          }),
        ).pipe(Effect.exit)
        expect(entered).toBe(true)
        expect(exit._tag).toBe("Failure")
        expect(model).toBe(false)
      }
    }),
  { git: true },
)

local(
  "task Git authority refuses a copied token, another directory and every use after its locked callback ends",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const other = yield* tmpdirScoped()
      const metadata = yield* Effect.promise(() => ReadOnlyGit.metadataHead(test.directory))
      const record = {
        directory: metadata.directory,
        gitDirectory: metadata.gitDirectory,
        gitCommonDirectory: metadata.commonDirectory,
        tip: metadata.head,
      }
      let released: ConnectGit.TaskRoot | undefined
      let retained: ConnectGit.Selected | undefined
      let models = 0
      yield* ConnectGit.withTask(record, (root) =>
        Effect.gen(function* () {
          released = root
          for (const [directory, token] of [
            [test.directory, { ...root }],
            [other, root],
          ] as const) {
            const refused = yield* ConnectGit.use(
              directory,
              () =>
                Effect.sync(() => {
                  models++
                }),
              token,
            ).pipe(Effect.exit)
            expect(refused._tag).toBe("Failure")
            expect(models).toBe(0)
          }
          yield* ConnectGit.use(
            test.directory,
            (selected) =>
              Effect.gen(function* () {
                retained = selected
                yield* selected.check()
                const result = yield* selected.git.run(
                  ["status", "--porcelain", "--untracked-files=no", "--no-renames"],
                  { cwd: test.directory },
                )
                expect(result.exitCode).toBe(0)
                models++
              }),
            root,
          )
        }),
      )
      if (!released || !retained) return yield* Effect.die(new Error("The genuine task authority was not exercised"))
      expect(models).toBe(1)
      const late = yield* ConnectGit.use(
        test.directory,
        () =>
          Effect.sync(() => {
            models++
          }),
        released,
      ).pipe(Effect.exit)
      expect(late._tag).toBe("Failure")
      expect((yield* retained.check().pipe(Effect.exit))._tag).toBe("Failure")
      expect(models).toBe(1)
      const stale = yield* ConnectGit.withTask({ ...record, tip: "0".repeat(40) }, (root) =>
        ConnectGit.use(
          test.directory,
          () =>
            Effect.sync(() => {
              models++
            }),
          root,
        ),
      ).pipe(Effect.exit)
      expect(stale._tag).toBe("Failure")
      expect(models).toBe(1)
    }),
  { git: true },
)
