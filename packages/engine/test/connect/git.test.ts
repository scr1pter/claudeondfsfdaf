import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Layer, Option, Stream } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import type { Connect } from "@vectordevai/schema/connect"
import { ProjectID } from "@vectordevai/schema/project-id"
import { ConnectHub } from "@/connect/hub"
import { VectorScopeAdapter } from "@/connect/adapters/vectorscope"
import { ConnectGit } from "@/connect/git"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionSummary } from "@/session/summary"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances, requireInstance, TestInstance, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
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
    const target: Connect.Target = { kind: kind === "process" ? "staged" : "uncommitted" }
    return {
      directory,
      counter,
      head,
      llm,
      run: (reviewed = target) =>
        hub.run({
          request: {
            to: "vectorscope",
            action: "review",
            target: reviewed,
            requester: { kind: "agent", sessionID: requester.id, agent: "build" },
            directory,
            background: false,
          },
          call: { ask: () => Effect.void, promptOps: ops },
        }),
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

// The brief's `/vectorscope branch main` and `vector connected review --base main` send this request unchanged
// (tool/connect.ts, connect/owner.ts); here it runs the actual adapter, CLI, Review.run and context collector.
local(
  "a branch review based on a branch name reaches the actual adapter/CLI/Review.run at that branch's commit",
  () =>
    Effect.gen(function* () {
      const f = yield* setup("clean")
      const original = yield* Git.Service
      // setup()'s edit and added file, committed on a feature branch off a local `main` at the baseline.
      yield* git(f.directory, ["checkout", "-q", "-b", "feature"])
      yield* git(f.directory, ["update-ref", "refs/heads/main", f.head])
      yield* git(f.directory, ["add", "-A"])
      yield* git(f.directory, ["commit", "-qm", "change the probe on a branch"])
      const head = yield* git(f.directory, ["rev-parse", "HEAD"])
      yield* Effect.promise(() => fs.writeFile(f.counter, ""))
      yield* f.llm.push(
        reply()
          .tool("StructuredOutput", {
            summary: "The branch is sound.",
            risk: "low",
            files: [{ path: "src/probe.ts", note: "The return value changed" }],
            findings: [],
          })
          .usage({ input: 100, output: 20 }),
      )
      const run = yield* f.run({ kind: "branch", base: "main" })
      expect(run.result?.state, run.result?.summary).toBe("completed")
      expect(run.result?.base).toBe(f.head)
      expect(run.result?.head).toBe(head)
      expect(run.result?.target).toEqual({ kind: "branch", base: "main" })
      const requests = yield* f.llm.inputs
      expect(requests.length).toBeGreaterThan(0)
      expect(JSON.stringify(requests)).toContain("src/probe.ts")
      expect(clients.length).toBeGreaterThan(0)
      expect(clients.every((client) => client !== original)).toBe(true)
      expect(yield* calls(f.counter)).toBe(0)
    }),
  { git: true },
  60_000,
)

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

const REFUSED = "This review's Git reads cannot be inspected safely, so Vector stopped it."
const bytes = (text: string) => Stream.make(new TextEncoder().encode(text))

// A committed src/probe.ts, then an uncommitted edit to it and an untracked src/extra.ts.
const shapesFixture = Effect.gen(function* () {
  const test = yield* TestInstance
  const directory = test.directory
  yield* write(directory, "src/probe.ts", "export const probe = 1\n")
  yield* git(directory, ["add", "-A"])
  yield* git(directory, ["commit", "-qm", "connect read shapes"])
  const head = yield* git(directory, ["rev-parse", "HEAD"])
  const oid = yield* git(directory, ["rev-parse", `${head}:src/probe.ts`])
  const branch = yield* git(directory, ["symbolic-ref", "--short", "HEAD"])
  const metadata = yield* Effect.promise(() => ReadOnlyGit.metadataHead(directory))
  yield* write(directory, "src/probe.ts", "export const probe = 2\n")
  yield* write(directory, "src/extra.ts", "export const extra = true\n")
  return { directory, head, oid, branch, metadata }
})

// One fresh connect Git view per read: the read must refuse, poison the view, and so stop the review before a model.
const refuses = (directory: string, args: string[], stdin?: string) =>
  Effect.gen(function* () {
    const seen = { args: args.join(" "), entered: false, ran: "", model: false }
    const exit = yield* ConnectGit.use(directory, (selected) =>
      Effect.gen(function* () {
        seen.entered = true
        const result = yield* selected.git
          .run(args, { cwd: directory, ...(stdin === undefined ? {} : { stdin: bytes(stdin) }) })
          .pipe(Effect.exit)
        seen.ran = result._tag
        yield* selected.check()
        seen.model = true
      }),
    ).pipe(Effect.exit)
    const error = exit._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    return { ...seen, message: error instanceof Error ? error.message : undefined }
  })
const refusedRow = (args: string[]) => ({
  args: args.join(" "),
  entered: true,
  ran: "Failure",
  model: false,
  message: REFUSED,
})

local(
  "connect's own read shapes are answered from the admitted repository",
  () =>
    Effect.gen(function* () {
      const f = yield* shapesFixture
      const NAMES = ["--name-only", "--no-renames", "--no-ext-diff", "--no-relative", "-z"]
      const committed = "export const probe = 1\n"
      yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          const read = (args: string[], stdin?: string) =>
            selected.git
              .run(args, { cwd: f.directory, ...(stdin === undefined ? {} : { stdin: bytes(stdin) }) })
              .pipe(Effect.map((result) => ({ args: args.join(" "), code: result.exitCode, text: result.text() })))
          const rows: [string[], string, string?][] = [
            // changes(): the top level, HEAD, the name-only diffs and both untracked listings.
            [["rev-parse", "--show-toplevel"], f.metadata.directory + "\n"],
            [["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], f.head + "\n"],
            [["rev-parse", "--verify", "--quiet", "--end-of-options", `${f.head}^{commit}`], f.head + "\n"],
            // mergeBase()'s commitOf with an abbreviated, uppercase base, since CN-04. The prefix runs to a letter, so
            // uppercasing changes it.
            [
              [
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                `${f.head.slice(0, Math.max(7, f.head.search(/[a-f]/) + 1)).toUpperCase()}^{commit}`,
              ],
              f.head + "\n",
            ],
            [["diff", ...NAMES, f.head, "--"], "src/probe.ts\0"],
            [["diff", "--cached", ...NAMES, f.head, "--"], ""],
            [["diff", ...NAMES, f.head, f.head, "--"], ""],
            [["ls-files", "--others", "--exclude-standard", "-z"], "src/extra.ts\0"],
            [["ls-files", "--others", "-z", "--", ":(icase).vector", ":(icase).gitattributes"], ""],
            // mergeBase() and ConnectGit.mergeBase.
            [["merge-base", f.head, f.head], f.head + "\n"],
            // stateFile().
            [["rev-parse", "--absolute-git-dir"], f.metadata.gitDirectory + "\n"],
            // plan()'s settings read through ConnectGit.show, and ledOutAt()'s link target.
            [["cat-file", "blob", `${f.head}:src/probe.ts`], committed],
            [["cat-file", "blob", "HEAD:src/probe.ts"], committed],
            [["cat-file", "blob", f.oid], committed],
            // ledOutAt().
            [["ls-tree", "-z", f.head, "--", "src/probe.ts"], `100644 blob ${f.oid}\tsrc/probe.ts\0`],
            // drifted().
            [
              ["cat-file", "--batch", "--follow-symlinks"],
              `${f.oid} blob ${committed.length}\n${committed}\n`,
              `${f.head}:src/probe.ts\n`,
            ],
            // Binding echoes kept as the brief lists them: answered from the admitted binding with no repository read.
            // Nothing emits them through run() at 0ee486e3; ConnectGit's branch() and prefix() answer without it.
            [["rev-parse", "--git-dir"], f.metadata.gitDirectory + "\n"],
            [["rev-parse", "--git-common-dir"], f.metadata.commonDirectory + "\n"],
            [["rev-parse", "--show-prefix"], "\n"],
            [["symbolic-ref", "--quiet", "--short", "HEAD"], f.branch + "\n"],
          ]
          for (const [args, text, stdin] of rows)
            expect(yield* read(args, stdin)).toEqual({ args: args.join(" "), code: 0, text })
          expect(yield* selected.git.show(f.directory, f.head, "src/probe.ts")).toBe(committed)
          expect(yield* selected.git.mergeBase(f.directory, f.head)).toBe(f.head)
          expect(yield* selected.git.branch(f.directory)).toBe(f.branch)
          expect(yield* selected.git.prefix(f.directory)).toBe("")
          // No row poisoned the view.
          yield* selected.check()
        }),
      )
    }),
  { git: true },
  60_000,
)

const verify = (name: string) => ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`]
// What a branch review's base can name, all at the fixture's HEAD: a local `main`, origin/main with origin/HEAD naming
// it, a lightweight tag and an annotated one.
const baseRefs = (directory: string) =>
  Effect.gen(function* () {
    yield* git(directory, ["update-ref", "refs/heads/main", "HEAD"])
    yield* git(directory, ["update-ref", "refs/remotes/origin/main", "HEAD"])
    yield* git(directory, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    yield* git(directory, ["tag", "v1.0"])
    yield* git(directory, ["tag", "-a", "-m", "notes", "v1.0-notes"])
  })

local(
  "branch review bases by name, remote-tracking branch, tag and origin/HEAD resolve inside connect's view",
  () =>
    Effect.gen(function* () {
      const f = yield* shapesFixture
      const ordinary = yield* Git.Service
      const root = yield* git(f.directory, ["rev-list", "--max-parents=0", "HEAD"])
      expect(root).not.toBe(f.head)
      // With no origin/HEAD, ordinary Git still names a local default branch, and connect's view names none.
      yield* git(f.directory, ["update-ref", "refs/heads/main", "HEAD"])
      expect(yield* ordinary.defaultBranch(f.directory)).toBeDefined()
      yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          expect(yield* selected.git.defaultBranch(f.directory)).toBeUndefined()
          yield* selected.check()
        }),
      )
      yield* baseRefs(f.directory)
      const read = (selected: ConnectGit.Selected, name: string) =>
        selected.git
          .run(verify(name), { cwd: f.directory })
          .pipe(Effect.map((result) => ({ name, code: result.exitCode, text: result.text() })))
      yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          // The lowercase short id goes to `resolve`, as the uppercase one in the read-shapes case does.
          const found = [
            f.branch,
            `refs/heads/${f.branch}`,
            "main",
            "origin/main",
            "refs/remotes/origin/main",
            "v1.0",
            "v1.0-notes",
            f.head.slice(0, 7),
          ]
          for (const name of found) expect(yield* read(selected, name)).toEqual({ name, code: 0, text: f.head + "\n" })
          // No ref of the name, and the name cannot be an object id: Git's quiet "not found".
          for (const name of ["no-such-branch", "a".repeat(41), "a".repeat(64)])
            expect(yield* read(selected, name)).toEqual({ name, code: 1, text: "" })
          expect(yield* selected.git.defaultBranch(f.directory)).toEqual({ name: "main", ref: "origin/main" })
          // Refs are live, but one view answers a name and the default branch as it first did, so every pass of one
          // review compares the same range.
          yield* git(f.directory, ["update-ref", "refs/remotes/origin/main", root])
          yield* git(f.directory, ["update-ref", "refs/remotes/origin/moved", root])
          yield* git(f.directory, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/moved"])
          expect(yield* read(selected, "origin/main")).toEqual({ name: "origin/main", code: 0, text: f.head + "\n" })
          expect(yield* selected.git.defaultBranch(f.directory)).toEqual({ name: "main", ref: "origin/main" })
          yield* selected.check()
        }),
      )
      // A new view reads the refs again.
      yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          expect(yield* read(selected, "origin/main")).toEqual({ name: "origin/main", code: 0, text: root + "\n" })
          expect(yield* selected.git.defaultBranch(f.directory)).toEqual({ name: "moved", ref: "origin/moved" })
          yield* selected.check()
        }),
      )
      // A view keeps at most 64 answers. A kept one is still answered there, and a new spelling poisons the view.
      const missing = Array.from({ length: 63 }, (_, index) => `no-such-${index}`)
      const capped = { kept: false, ran: "", model: false }
      const bounded = yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          expect(yield* Effect.forEach(missing, (name) => read(selected, name))).toEqual(
            missing.map((name) => ({ name, code: 1, text: "" })),
          )
          expect(yield* selected.git.defaultBranch(f.directory)).toEqual({ name: "moved", ref: "origin/moved" })
          capped.kept = (yield* read(selected, "no-such-0")).code === 1
          capped.ran = (yield* read(selected, "origin/main").pipe(Effect.exit))._tag
          yield* selected.check()
          capped.model = true
        }),
      ).pipe(Effect.exit)
      expect(capped).toEqual({ kept: true, ran: "Failure", model: false })
      const error = bounded._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(bounded.cause)) : undefined
      expect(error instanceof Error ? error.message : undefined).toBe(REFUSED)
    }),
  { git: true },
  60_000,
)

local(
  "branch review bases that core refuses poison connect's view",
  () =>
    Effect.gen(function* () {
      const f = yield* shapesFixture
      const root = yield* git(f.directory, ["rev-list", "--max-parents=0", "HEAD"])
      expect(root).not.toBe(f.head)
      yield* baseRefs(f.directory)
      // A branch spelled as an uppercase short id of HEAD, at the root commit. Live Git reads the ref first.
      const upper = f.head.slice(0, Math.max(7, f.head.search(/[a-f]/) + 1)).toUpperCase()
      yield* git(f.directory, ["branch", upper, root])
      expect(yield* git(f.directory, verify(upper))).toBe(root)
      const shapes = [
        verify("-main"),
        verify(""),
        verify("main~1"),
        verify("HEAD~1"),
        verify("@"),
        verify("FETCH_HEAD"),
        verify("refs/stash"),
        // A bare remote names origin/HEAD, which is outside branches and tags.
        verify("origin"),
        // Fewer than 7 hex digits, and `git describe` output: either may be an object id.
        verify("abcd"),
        verify("v1.0-1-gabcdef0"),
        // A short id that a ref also spells never answers through the ref, and the engine does not lowercase it.
        verify(upper),
        // VectorScope's collector verify, which is not quiet.
        ["rev-parse", "--verify", "--end-of-options", "main^{commit}"],
      ]
      const seen = yield* Effect.forEach(shapes, (args) => refuses(f.directory, args))
      expect(seen).toEqual(shapes.map(refusedRow))
      // The full name of that branch answers it.
      yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          const result = yield* selected.git.run(verify(`refs/heads/${upper}`), { cwd: f.directory })
          expect({ code: result.exitCode, text: result.text() }).toEqual({ code: 0, text: root + "\n" })
          yield* selected.check()
        }),
      )
      // Another directory, then an origin/HEAD that names no origin branch.
      const other = yield* tmpdirScoped()
      const outside = yield* ConnectGit.use(f.directory, (selected) =>
        selected.git.defaultBranch(other).pipe(Effect.exit),
      )
      expect(outside._tag).toBe("Failure")
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(f.metadata.commonDirectory, "refs", "remotes", "origin", "HEAD"),
          "ref: refs/heads/main\n",
        ),
      )
      const seenDefault = { ran: "", model: false }
      const malformed = yield* ConnectGit.use(f.directory, (selected) =>
        Effect.gen(function* () {
          seenDefault.ran = (yield* selected.git.defaultBranch(f.directory).pipe(Effect.exit))._tag
          yield* selected.check()
          seenDefault.model = true
        }),
      ).pipe(Effect.exit)
      expect(seenDefault).toEqual({ ran: "Failure", model: false })
      const error =
        malformed._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(malformed.cause)) : undefined
      expect(error instanceof Error ? error.message : undefined).toBe(REFUSED)
    }),
  { git: true },
  120_000,
)

local(
  "VectorScope's collector shapes refuse in connect's Git view and poison it",
  () =>
    Effect.gen(function* () {
      const f = yield* shapesFixture
      const DIFF = [
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ]
      const shapes = [
        ["status", "--porcelain", "--untracked-files=normal", "--no-renames"],
        ["rev-parse", "--is-shallow-repository"],
        ["rev-parse", "--verify", "--end-of-options", `${f.head}^{commit}`],
        ["cat-file", "-s", `${f.head}:src/probe.ts`],
        ["cat-file", "-e", `${f.head}:src/probe.ts`],
        ["cat-file", "-e", `${f.head}^{commit}`],
        ["diff", ...DIFF, "--find-renames", "--unified=3", f.head, "--"],
        ["diff", ...DIFF, "--find-renames", "--unified=20", "--cached", f.head, "--"],
        ["diff", ...DIFF, "--find-renames", "--unified=3", f.head, f.head],
        ["diff", ...DIFF, "--find-renames", "--unified=3", f.head, f.head, "--", "src/probe.ts"],
        ["diff", "--no-index", ...DIFF, "--unified=3", "--", "/dev/null", "src/extra.ts"],
        ["grep", "-n", "-w", "-F", "-I", "--no-color", "--full-name", "-z", "-e", "probe", f.head, "--", "."],
        ["rev-list", "--max-parents=0", f.head],
        ["log", "-n", "5", "--no-color", "--date=short", "--format=%h %an %ad %s", f.head, "--", "src/probe.ts"],
        ["log", "--no-color", "-n", "50", "--format=%s", `${f.head}..${f.head}`],
        ["blame", "--porcelain", "--root", "--no-textconv", "-L", "1,1", f.head, "--", "src/probe.ts"],
      ]
      const seen = yield* Effect.forEach(shapes, (args) => refuses(f.directory, args))
      expect(seen).toEqual(shapes.map(refusedRow))
    }),
  { git: true },
  120_000,
)

local(
  "the private adapter refuses raw execution, config redirection, unsafe paths and unknown argv without a live fallback",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const shapes = [
        ["log", "--output=leak"],
        ["grep", "--open-files-in-pager=bad"],
        ["cat-file", "--filters", "HEAD:probe"],
        ["config", "--file", "../outside", "filter.fixture.clean"],
        [],
        ["rev-parse", "HEAD"],
        ["merge-base", "--all", "HEAD", "HEAD"],
        ["cat-file", "blob", "main:src/probe.ts"],
        ["show", "HEAD"],
        ["fetch", "origin"],
        // The batch read without its request, and the batch request is not a path of HEAD or of an exact commit.
        ["cat-file", "--batch", "--follow-symlinks"],
      ]
      const seen = yield* Effect.forEach(shapes, (args) => refuses(test.directory, args))
      expect(seen).toEqual(shapes.map(refusedRow))
      // A request on stdin goes with the batch read only.
      expect(yield* refuses(test.directory, ["rev-parse", "--show-toplevel"], "HEAD:vector.json\n")).toEqual(
        refusedRow(["rev-parse", "--show-toplevel"]),
      )
      expect(
        yield* refuses(test.directory, ["cat-file", "--batch", "--follow-symlinks"], "main:vector.json\n"),
      ).toEqual(refusedRow(["cat-file", "--batch", "--follow-symlinks"]))
    }),
  { git: true },
  120_000,
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
                  ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
                  { cwd: test.directory },
                )
                expect(result.exitCode).toBe(0)
                expect(result.text().trim()).toBe(metadata.head)
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

local(
  "an instance worktree reached through a link is refused with what to do before any Git read, and a swapped folder or a task's worktree keeps the generic refusal",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const instance = yield* requireInstance
      const LINKED = "Open this project through its real folder path to use connected reviews."
      const link = path.join(yield* tmpdirScoped(), "project")
      yield* Effect.promise(() => fs.symlink(test.directory, link, "dir"))
      let entered = 0
      const enter = () =>
        Effect.sync(() => {
          entered++
        })
      const message = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.exit,
          Effect.map((exit) => {
            const error = exit._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
            return error instanceof Error ? error.message : undefined
          }),
        )
      const metadata = yield* Effect.promise(() => ReadOnlyGit.metadataHead(test.directory))
      const task = {
        directory: link,
        gitDirectory: metadata.gitDirectory,
        gitCommonDirectory: metadata.commonDirectory,
        tip: metadata.head,
      }
      expect([
        // The instance store opened the real folder, so a folder that is a link now was swapped after it loaded.
        yield* message(ConnectGit.use(link, enter)),
        // A worktree kept as written, as a task worktree under a linked data folder is.
        yield* message(
          ConnectGit.use(test.directory, enter).pipe(
            Effect.provideService(InstanceRef, { ...instance, worktree: link }),
          ),
        ),
        // The hub's verified task root: reopening the project would not change it.
        yield* message(ConnectGit.withTask(task, (root) => ConnectGit.use(test.directory, enter, root))),
      ]).toEqual([REFUSED, LINKED, REFUSED])
      expect(entered).toBe(0)
      yield* ConnectGit.use(test.directory, (selected) => selected.check().pipe(Effect.andThen(enter())))
      expect(entered).toBe(1)
    }),
  { git: true },
  60_000,
)

local(
  "the non-Git reason requires the selected instance's directory, global project and no Git VCS",
  () =>
    Effect.gen(function* () {
      const instance = yield* requireInstance
      const project = { ...instance.project, id: ProjectID.global, vcs: undefined }
      const nonRepository = { ...instance, worktree: "/", project }
      const linked = path.join(yield* tmpdirScoped(), "linked")
      yield* Effect.promise(() => fs.symlink(instance.directory, linked, "dir"))
      for (const input of [
        {
          context: nonRepository,
          directory: instance.directory,
          reason: "Open a Git repository to use connected reviews.",
        },
        { context: nonRepository, directory: linked, reason: REFUSED },
        {
          context: { ...nonRepository, project: { ...project, vcs: "git" as const } },
          directory: instance.directory,
          reason: REFUSED,
        },
        {
          context: { ...nonRepository, project: { ...project, id: instance.project.id } },
          directory: instance.directory,
          reason: REFUSED,
        },
      ]) {
        const result = yield* ConnectGit.use(input.directory, () => Effect.die("Unexpected Git admission")).pipe(
          Effect.provideService(InstanceRef, input.context),
          Effect.flip,
        )
        expect(result).toMatchObject({ _tag: "Connect.Refusal", code: "unavailable", message: input.reason })
      }
    }),
  { git: true },
)
