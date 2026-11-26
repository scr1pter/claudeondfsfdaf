import type { ReviewCost } from "@vectordevai/core/review/types"
import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Git } from "@/git"
import { ReviewImpact } from "@/review/impact"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { batchCoverage, batchCursorDigest, restoreBatchCursor, type BatchCursor } from "@vectordevai/core/review/state"
import { finishReviewBatch, type ReviewBatchStore } from "@/review/batch"
import type { ReviewBatchPlan } from "@vectordevai/core/review/plan"
import { Review } from "@/review/run"
import { ReviewMcpSnapshot } from "@/review/mcp-snapshot"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { firstUserText } from "../fixture/projection"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Git.node,
      SessionPrompt.node,
      Session.node,
      SpendGuard.node,
      Permission.node,
      Provider.node,
      EventV2Bridge.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.loopback, deps: [] }),
    ]),
  ),
)

const fixture = Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const fs = yield* FSUtil.Service
  const llm = yield* TestLLMServer
  yield* fs.writeWithDirs(path.join(directory, "vector.json"), JSON.stringify(testProviderConfig(llm.url)))
  yield* Effect.promise(() => trustWorkspace(directory))
  const files = parseUnifiedDiff(
    ["a", "b", "c"]
      .map(
        (name) =>
          `diff --git a/src/${name}.ts b/src/${name}.ts\n--- a/src/${name}.ts\n+++ b/src/${name}.ts\n@@ -1 +1 @@\n-old\n+VALUE_${name}`,
      )
      .join("\n"),
  )
  const input: Review.RunInput = {
    directory,
    trigger: "local",
    trust: "trusted",
    mode: "full",
    head: "2".repeat(40),
    base: "1".repeat(40),
    files,
    anchors: files,
    prior: [],
    context: {},
    rules: "",
    skipped: [],
    config: { ...DEFAULT_REVIEW_CONFIG, maxFiles: 1, security: "off", verify: "off" },
    model: {
      providerID: ProviderV2.ID.make("lmstudio"),
      modelID: ModelV2.ID.make("test-model"),
      context: 128000,
      costKind: "local",
    },
    knownPath: async () => false,
  }
  let saved: BatchCursor | undefined
  let currentPlan: ReviewBatchPlan | undefined
  const store: ReviewBatchStore = {
    resume(plan) {
      if (!saved || saved.head !== plan.head) return
      return restoreBatchCursor(plan, JSON.parse(JSON.stringify(saved)), batchCursorDigest(saved)) ?? "mismatch"
    },
    spent: () => 0,
    record: (plan, cursor) => {
      currentPlan = plan
      saved = cursor
    },
  }
  const execute = (overrides: Partial<Review.RunInput> = {}) =>
    Effect.gen(function* () {
      yield* llm.reset
      yield* llm.pushMatch(
        (hit) => firstUserText(hit.body).includes("You are Vector's code reviewer"),
        reply().tool("StructuredOutput", { summary: "Assessed this batch.", risk: "low", files: [], findings: [] }),
      )
      const result = yield* Review.run({ ...input, ...overrides })
      const requests = (yield* llm.inputs).filter(
        (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
      )
      const sessions = yield* Session.Service
      const permissions = yield* Effect.forEach(result.sessions, (id) =>
        sessions.get(SessionID.make(id)).pipe(Effect.map((session) => session.permission)),
      )
      return { result, requests, text: requests[0] ? firstUserText(requests[0]) : "", permissions }
    })
  return { input, execute, store, receipt: () => ({ plan: currentPlan!, cursor: saved! }) }
})

it.instance(
  "durable batches review each changed file once, retain a deferred prior, and expose only structured cross-batch progress",
  () =>
    Effect.gen(function* () {
      const { input, store, execute, receipt } = yield* fixture
      const config = { ...input.config, largeChanges: "batch" as const }
      const prior: Review.RunInput["prior"] = [
        {
          id: "fa1234567890",
          where: "inline",
          path: "src/c.ts",
          line: 1,
          side: "RIGHT",
          severity: "blocking",
          category: "bug",
          title: "PRIVATE_DEFERRED_PRIOR",
          sha: input.head,
          status: "open",
        },
      ]
      const first = yield* execute({ config, batchStore: store, prior })
      expect(first.requests).toHaveLength(1)
      expect(first.text).toContain("VALUE_a")
      expect(
        first.permissions[0]?.some(
          (rule) => rule.permission === "read" && rule.pattern === "src/b.ts" && rule.action === "deny",
        ),
      ).toBe(true)
      expect(first.text).not.toContain("VALUE_b")
      expect(first.text).not.toContain("PRIVATE_DEFERRED_PRIOR")
      expect(first.text).toContain("<untrusted_batch_context>")
      expect(first.result.selection.stillOpen).toEqual(prior)
      expect(first.result.unreviewed).toEqual(["src/b.ts", "src/c.ts"])
      expect(first.result.selection.diffIncomplete).toBe(true)
      expect(first.result.stats.files).toBe(3)
      // This projection receives a genuine acknowledged prefix. A later strict pre-dispatch
      // stop cannot turn already-reviewed files back into this invocation's unattempted diff.
      const { plan, cursor } = receipt()
      const coverage = batchCoverage(plan, cursor)!
      const stopped = finishReviewBatch(
        input,
        { plan, cursor, coverage, paths: new Set(coverage.next!.paths), mismatch: false },
        {
          ...first.result,
          partial: "budget-estimate",
          specialists: [],
          sessions: [],
          stats: { files: 1, additions: 1, deletions: 1 },
          unreviewed: ["src/b.ts"],
          cost: undefined,
          passes: undefined,
          strict: {
            version: 1,
            head: input.head,
            complete: false,
            findings: [],
            dropped: [],
            fixUnchecked: 0,
            incomplete: ["budget-estimate", "unreviewed", "no-reviewer"],
          },
        },
        [],
      )
      expect(stopped.stats.files).toBe(1)
      expect(stopped.unreviewed).toEqual(["src/b.ts", "src/c.ts"])
      expect(stopped.strict?.incomplete).toEqual(["budget-estimate", "unreviewed", "no-reviewer"])
      expect(stopped.strict).not.toHaveProperty("unreviewed")

      const second = yield* execute({ config, batchStore: store, prior })
      expect(second.text).toContain("VALUE_b")
      expect(second.text).not.toContain("VALUE_a")
      expect(second.text).toContain('"completedBatches":1')
      expect(second.result.unreviewed).toEqual(["src/c.ts"])
      const last = yield* execute({ config, batchStore: store, prior })
      expect(last.text).toContain("VALUE_c")
      expect(last.text).toContain("PRIVATE_DEFERRED_PRIOR")
      expect(last.result.unreviewed).toEqual([])
      expect(last.result.selection.diffIncomplete).toBeUndefined()
      expect(last.result.notes.join(" ")).toContain("Completed all 3 review batches")
      const changed = yield* execute({ config, batchStore: store, head: "3".repeat(40) })
      expect(changed.text).toContain("VALUE_a")
    }),
  { git: true },
  90_000,
)

it.instance(
  "batch opt-out preserves all wire fields and permissions; a non-durable or exhausted opt-in runs no model",
  () =>
    Effect.gen(function* () {
      const { input, store, execute } = yield* fixture
      const off = yield* execute()
      const explicit = yield* execute({ config: { ...input.config, largeChanges: "skip" } })
      expect(explicit.requests).toEqual(off.requests)
      expect(explicit.permissions).toEqual(off.permissions)
      const stable = (outcome: typeof off.result) => ({ ...outcome, durationMs: 0, sessions: [] })
      expect(stable(explicit.result)).toEqual(stable(off.result))
      expect(off.text).toContain("VALUE_c")
      const config = { ...input.config, largeChanges: "batch" as const }
      const uncapped = { ...config, maxCostUsd: 0, maxCostUsdPerPr: 0, maxCostUsdPerMonth: 0 }
      const priced = { ...input.model, costKind: "priced" as const, price: { input: 1, output: 1 } }
      let journalAttempts = 0
      for (const result of [
        yield* execute({ config: uncapped, batchStore: store, model: priced }),
        yield* execute({
          config: uncapped,
          model: priced,
          batchStore: {
            ...store,
            begin: () => {
              journalAttempts++
              return Effect.fail(new Error("fixture journal unavailable"))
            },
          },
        }),
        yield* execute({ config }),
        yield* execute({ config, batchStore: store, base: "index", uncommittedDiff: true }),
        yield* execute({
          config,
          batchStore: {
            ...store,
            resume: (plan) => ({ version: 1, head: plan.head, plan: plan.id, completed: 0, covered: 0 }) as BatchCursor,
          },
        }),
        yield* execute({ config, batchStore: store, model: { ...input.model, costKind: "unknown" } }),
        yield* execute({
          config,
          batchStore: { ...store, begin: () => Effect.fail(new Error("fixture write refused")) },
          model: { ...input.model, costKind: "priced", price: { input: 1, output: 1 } },
        }),
        yield* execute({
          config,
          batchStore: { ...store, spent: () => 200 },
          model: { ...input.model, costKind: "priced", price: { input: 1, output: 1 } },
        }),
      ]) {
        expect(result.requests).toEqual([])
        expect(result.result.sessions).toEqual([])
        expect(result.result.unreviewed).toEqual(input.files.map((file) => file.path))
        expect(result.result.notes.join(" ")).toContain("Not reviewed.")
      }
      expect(journalAttempts).toBe(1)
    }),
  { git: true },
  90_000,
)

it.instance(
  "a missing settlement stays uncertain beside a priced batch response even when the original run was uncapped",
  () =>
    Effect.gen(function* () {
      const { input, store } = yield* fixture
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      const provider = testProviderConfig(llm.url)
      provider.provider.lmstudio.models["test-model"].cost = { input: 1, output: 2 }
      yield* fs.writeWithDirs(path.join(input.directory, "vector.json"), JSON.stringify(provider))
      yield* Effect.promise(() => trustWorkspace(input.directory))
      const report = { summary: "Checked this batch.", risk: "low", files: [], findings: [] }
      yield* llm.pushMatch(
        (hit) => firstUserText(hit.body).includes("You are Vector's code reviewer"),
        reply().tool("StructuredOutput", report).usage({ input: 10000, output: 100 }),
      )
      yield* llm.pushMatch(
        (hit) => firstUserText(hit.body).includes("You are Vector's security reviewer"),
        reply().tool("StructuredOutput", report),
      )
      let recorded: ReviewCost | undefined
      const outcome = yield* Review.run({
        ...input,
        model: { ...input.model, costKind: "priced", price: { input: 1, output: 2 } },
        config: { ...input.config, largeChanges: "batch", maxCostUsd: 0, maxCostUsdPerMonth: 0, security: "always" },
        batchStore: {
          ...store,
          begin: () => Effect.void,
          record: (_plan, _cursor, cost) => {
            recorded = cost
          },
        },
      })
      expect(outcome.cost?.costUsd).toBeGreaterThan(0)
      expect(outcome.cost?.partial).toBe(true)
      expect(recorded?.costUsd).toBe(outcome.cost?.costUsd)
      expect(recorded?.partial).toBe(true)
      expect(outcome.notes.join(" ")).toContain("Reported cost may be incomplete")
    }),
  { git: true },
  90000,
)

it.instance(
  "owner-selected MCP context refuses an oversized resumable batch before consulting its store",
  () =>
    Effect.gen(function* () {
      const { input, execute, store } = yield* fixture
      const calls: string[] = []
      const tracked: ReviewBatchStore = {
        resume: (plan) => {
          calls.push("resume")
          return store.resume(plan)
        },
        spent: () => {
          calls.push("spent")
          return 0
        },
        begin: () =>
          Effect.sync(() => {
            calls.push("begin")
          }),
        record: () => {
          calls.push("record")
        },
      }
      const authority: ReviewMcpSnapshot.Authority = {
        directory: input.directory,
        selections: [{ context: { owner: "owner", repository: "repo", server: "docs" }, uri: "docs://manual/fixed" }],
        grants: () => {
          calls.push("grant")
          return []
        },
        reader: () => {
          calls.push("reader")
          return undefined
        },
      }
      const opt = { config: { ...input.config, largeChanges: "batch" as const }, batchStore: tracked }
      const refused = yield* execute(opt).pipe(Effect.provideService(ReviewMcpSnapshot.Trusted, authority))
      expect(refused.result.notes.join(" ")).toContain(
        "Resumable batches cannot reuse a review that uses owner-selected MCP context.",
      )
      expect(refused.result.unreviewed).toEqual(input.files.map((file) => file.path))
      expect(refused.result.sessions).toEqual([])
      expect(refused.requests).toEqual([])
      expect(calls).toEqual([])
      const ordinary = yield* execute(opt).pipe(
        Effect.provideService(ReviewMcpSnapshot.Trusted, { ...authority, selections: [] }),
      )
      expect(ordinary.requests.length).toBeGreaterThan(0)
      expect(calls).toContain("resume")
      expect(calls).toContain("record")
    }),
  { git: true },
  90_000,
)

const linkedCheckout = (directory: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(directory, "src"), { recursive: true })
    const write = (file: string, text: string) => fs.writeFile(path.join(directory, "src", file), text)
    await write("encode.ts", "export function encodeCount(n: number) { return n }\n")
    await write("decode.ts", "export function decodeCount(n: number) { return n }\n")
    await write(
      "use.ts",
      'import { encodeCount } from "./encode"\nimport { decodeCount } from "./decode"\nexport const check = (n: number) => decodeCount(encodeCount(n))\n',
    )
    await $`git add src`.cwd(directory).quiet()
    await $`git commit -qm interface`.cwd(directory).quiet()
    const base = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
    await write("encode.ts", "export function encodeCount(n: number) { return n * 10 }\n")
    await write("decode.ts", "export function decodeCount(n: number) { return n / 100 }\n")
    await $`git add src`.cwd(directory).quiet()
    await $`git commit -qm conversion`.cwd(directory).quiet()
    const head = (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
    const files = parseUnifiedDiff(await $`git diff ${base} ${head}`.cwd(directory).quiet().text())
    return { base, head, files, anchors: files }
  })

it.instance(
  "the graph import gate identifies a cross-file dependency cluster and its reach from the two immutable fixture trees",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const pair = yield* linkedCheckout(directory)
      const reader = yield* Git.Service
      const result = yield* ReviewImpact.algorithm.build(reader, {
        ...pair,
        directory,
        context: 128000,
        batchClusters: true,
      })
      expect(result.batchClusters?.get("src/encode.ts")).toBe("src/decode.ts")
      expect(result.batchClusters?.get("src/decode.ts")).toBe("src/decode.ts")
      expect(result.dependentsByFile?.get("src/decode.ts")).toBe(1)
      expect(result.dependentsByFile?.get("src/encode.ts")).toBe(1)
      expect(result.slice.dependents.map((x) => x.path)).toContain("src/use.ts")
    }),
  { git: true },
  90_000,
)

const native = process.platform === "linux" ? it.instance : it.instance.skip

native(
  "an importer linking two changed components supplies the cross-batch path to the next reviewer",
  () =>
    Effect.gen(function* () {
      const { input, execute, store } = yield* fixture
      const pair = yield* linkedCheckout(input.directory)
      const request = {
        ...pair,
        config: { ...input.config, largeChanges: "batch" as const, impact: "graph" as const },
        batchStore: store,
      }
      const first = yield* execute(request)
      const second = yield* execute(request)
      expect(first.result.unreviewed).toEqual(["src/encode.ts"])
      expect(second.result.unreviewed).toEqual([])
      const context = second.text.match(/<untrusted_batch_context>([\s\S]*?)<\/untrusted_batch_context>/)?.[1]
      expect(context).toBeDefined()
      expect(JSON.parse(context!)).toMatchObject({
        completedBatches: 1,
        related: [{ path: "src/decode.ts", covered: true, batch: 1 }],
      })
      expect(second.text).toContain("decodeCount(encodeCount(n))")
      expect(second.text).not.toContain("return n / 100")
    }),
  { git: true },
  90_000,
)
