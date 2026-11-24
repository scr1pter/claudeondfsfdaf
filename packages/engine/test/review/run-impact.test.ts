import { $ } from "bun"
import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { parseUnifiedDiff, renderPatch } from "@vectordevai/core/review/diff"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ReviewGit } from "@/review/git"
import { Review } from "@/review/run"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TestInstance, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
import { firstUserText } from "../fixture/projection"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
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

const git = (directory: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(directory).quiet().text()).pipe(Effect.map((s) => s.trimEnd()))

const secret = "ghp_" + "r1E2".repeat(9)
const marker = (symbol: string, comment: string) =>
  `import { ${symbol} } from "./z"\nexport function run() {\n  return ${symbol}(7) // ${comment}\n}\n`

const checkout = Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const fs = yield* FSUtil.Service
  const llm = yield* TestLLMServer
  const write = (file: string, text: string) => fs.writeWithDirs(path.join(directory, file), text)
  const decl = (symbol: string, add: number) => `export function ${symbol}(n: number) {\n  return n + ${add}\n}\n`
  yield* write("vector.json", JSON.stringify(testProviderConfig(llm.url)))
  yield* Effect.promise(() => trustWorkspace(directory))
  yield* write("src/a.ts", decl("unused", 1))
  yield* write("src/z.ts", decl("adjust", 1))
  yield* write("src/consumer.ts", marker("adjust", `COMMITTED_CALL ${secret}`))
  yield* write("src/blocked.ts", marker("adjust", "READ_DENIED"))
  yield* write("src/generated.ts", marker("adjust", "IGNORED_DEP"))
  yield* git(directory, "add", "src")
  yield* git(directory, "commit", "-qm", "base")
  const base = yield* git(directory, "rev-parse", "HEAD")
  yield* write("src/a.ts", decl("unused", 2))
  yield* write("src/z.ts", decl("adjust", 2))
  yield* git(directory, "add", "src")
  yield* git(directory, "commit", "-qm", "change definitions")
  const head = yield* git(directory, "rev-parse", "HEAD")
  const files = parseUnifiedDiff(yield* git(directory, "diff", "--no-ext-diff", "--no-color", base, head))
  yield* git(directory, "checkout", "--detach", base)
  yield* write("src/consumer.ts", marker("adjust", "WORKTREE_BYTES"))
  const config = { ...DEFAULT_REVIEW_CONFIG, security: "off", verify: "off", ignore: ["src/generated.ts"] } as const
  const input: Review.RunInput = {
    directory,
    trigger: "command",
    trust: "untrusted",
    base,
    head,
    mode: "full",
    files,
    anchors: files,
    skipped: [],
    context: {},
    prior: [],
    rules: "",
    config: { ...config, ignore: [...config.ignore] },
    readDenies: ["src/blocked.ts"],
    model: {
      providerID: ProviderV2.ID.make("lmstudio"),
      modelID: ModelV2.ID.make("test-model"),
      context: 100_000,
      costKind: "local",
    },
    knownPath: async () => true,
  }
  const execute = (overrides: Partial<Review.RunInput> = {}) =>
    Effect.gen(function* () {
      yield* llm.reset
      yield* llm.pushMatch(
        (hit) => firstUserText(hit.body).includes("You are Vector's code reviewer"),
        reply().tool("StructuredOutput", {
          summary: "Reviewed the change.",
          risk: "low",
          files: [],
          findings: [],
        }),
      )
      const events: Review.Observation[] = []
      const outcome = yield* Review.run({ ...input, ...overrides, observe: (event) => events.push(event) })
      const requests = (yield* llm.inputs).filter(
        (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
      )
      expect(requests).toHaveLength(1)
      const { durationMs, sessions: ids, ...stable } = outcome
      const sessions = yield* Session.Service
      const rules = yield* Effect.forEach(ids, (id) =>
        sessions.get(SessionID.make(id)).pipe(Effect.map((session) => session.permission)),
      )
      expect(ids).toHaveLength(1)
      expect(durationMs).toBeGreaterThanOrEqual(0)
      return {
        text: firstUserText(requests[0]!),
        outcome,
        impact: events.filter((event) => event.type === "impact"),
        dispatch: events.filter((event) => event.type === "dispatch"),
        parity: { bodies: requests.map((body) => JSON.stringify(body)), rules, outcome: stable },
      }
    })
  return { input, execute }
})

const native = process.platform === "linux" ? it.instance : it.instance.skip

native(
  "graph quotes the fork's private object tree, excludes denied sources and counts quoted context separately from diff coverage",
  () =>
    Effect.gen(function* () {
      const { input, execute } = yield* checkout
      const z = input.files.find((file) => file.path === "src/z.ts")!
      const config = {
        ...input.config,
        impact: "graph" as const,
        holdback: "secrets" as const,
        maxDiffChars: renderPatch([z]).length + 1,
      }
      const graph = yield* execute({
        config,
        ignored: [],
        headFiles: [{ path: "src/a.ts", text: "WHOLE_OMITTED_FILE", exact: true }],
      })
      expect(graph.text).toContain("<untrusted_impact>")
      expect(graph.text).toContain("COMMITTED_CALL")
      expect(graph.text).toContain("[redacted]")
      for (const unsent of [secret, "READ_DENIED", "IGNORED_DEP", "WORKTREE_BYTES", "WHOLE_OMITTED_FILE"])
        expect(graph.text).not.toContain(unsent)
      expect(graph.text).toContain("diff --git a/src/z.ts b/src/z.ts")
      expect(graph.text).not.toContain("diff --git a/src/a.ts b/src/a.ts")
      expect(graph.outcome.unreviewed).toEqual(["src/a.ts"])
      expect(graph.outcome.selection.diffIncomplete).toBe(true)
      expect(graph.impact).toHaveLength(1)
      expect(graph.impact[0]!.locations).toContain("src/consumer.ts:3")
      expect(graph.impact[0]!.record.stages.packed).toBeGreaterThan(0)
      expect(JSON.stringify(graph.impact)).not.toContain("COMMITTED_CALL")
    }),
  { git: true },
  90_000,
)

native(
  "the first-request budget drops the lowest-ranked graph dependent before trimming changed context",
  () =>
    Effect.gen(function* () {
      const { input, execute } = yield* checkout
      const provider = yield* Provider.Service
      yield* provider.getModel(input.model.providerID, input.model.modelID)
      const config = {
        ...input.config,
        impact: "graph" as const,
        holdback: "secrets" as const,
        maxInputTokens: 100_000,
      }
      const initial = yield* execute({ config, ignored: [] })
      const initialTokens = initial.dispatch[0]!.estimate.firstTurnTokens
      expect(initialTokens).toBeGreaterThan(1)
      expect(initial.text).toContain("COMMITTED_CALL")
      expect(initial.impact[0]!.locations).toContain("src/consumer.ts:3")
      const reduced = yield* execute({ config: { ...config, maxInputTokens: initialTokens - 1 }, ignored: [] })
      expect(reduced.dispatch.map((event) => event.step)).toEqual([undefined, "dependents"])
      expect(reduced.dispatch[1]!.estimate.firstTurnTokens).toBeLessThan(initialTokens)
      expect(reduced.text).not.toContain("COMMITTED_CALL")
      expect(reduced.impact[0]!.locations).not.toContain("src/consumer.ts:3")
      expect(reduced.outcome.unreviewed).toEqual([])
      expect(reduced.text).toContain("diff --git a/src/a.ts b/src/a.ts")
      expect(reduced.text).toContain("diff --git a/src/z.ts b/src/z.ts")
      expect(reduced.text).not.toContain("READ_DENIED")
      expect(reduced.text).not.toContain(secret)
    }),
  { git: true },
  90_000,
)

it.instance(
  "unset, grep and working-tree reviews avoid graph reads and preserve the ordinary review",
  () =>
    Effect.gen(function* () {
      const { input, execute } = yield* checkout
      const offChecks = Effect.gen(function* () {
        const off = yield* execute()
        const grep = yield* execute({ config: { ...input.config, impact: "grep" } })
        const staged = yield* execute({ config: { ...input.config, impact: "graph" }, uncommittedDiff: true })
        expect(off.parity.rules[0]?.length).toBeGreaterThan(0)
        expect(grep.parity).toEqual(off.parity)
        expect(staged.text).toBe(off.text)
        expect(off.text).not.toContain("<untrusted_impact>")
        expect(off.impact).toEqual([])
        expect(grep.impact).toEqual([])
        expect(staged.impact).toEqual([])
        expect(staged.outcome.notes).toContain("Impact context is unavailable for staged or uncommitted changes.")
        const capped = yield* execute({
          config: { ...input.config, impact: "graph", maxDiffChars: 1 },
          uncommittedDiff: true,
        })
        expect(capped.impact).toEqual([])
        expect(capped.outcome.unreviewed).toEqual(input.files.map((file) => file.path))
        expect(capped.outcome.selection.diffIncomplete).toBe(true)
        for (const file of input.files) expect(capped.outcome.notes.join(" ")).toContain(file.path)
      })
      if (process.platform !== "linux") {
        yield* offChecks
        // These hosts have no pinned-directory adapter. A genuine graph request cannot use the checkout instead.
        const unavailable = yield* execute({ config: { ...input.config, impact: "graph" } })
        expect(unavailable.impact[0]?.record.incomplete).toContain("error")
        expect(unavailable.impact[0]?.locations).toEqual([])
        expect(unavailable.text).not.toContain("COMMITTED_CALL")
        expect(unavailable.text).not.toContain("WORKTREE_BYTES")
        expect(unavailable.outcome.notes.join(" ")).toContain("impact search is incomplete")
        expect(unavailable.outcome.specialists).toMatchObject([{ name: "review", status: "ok" }])
        expect(unavailable.outcome.unreviewed).toEqual([])
        expect(unavailable.outcome.partial).toBeUndefined()
        expect(unavailable.outcome.selection.diffIncomplete).toBeUndefined()
        const capped = yield* execute({ config: { ...input.config, impact: "graph", maxDiffChars: 1 } })
        expect(capped.impact[0]?.record.incomplete).toContain("error")
        expect(capped.outcome.unreviewed).toEqual(input.files.map((file) => file.path))
        expect(capped.outcome.selection.diffIncomplete).toBe(true)
        return
      }
      const metadata = yield* ReviewGit.metadata(input.directory)
      yield* ReviewGit.within(
        metadata,
        input.base,
        Effect.gen(function* () {
          const view = (yield* ReviewGit.Current)!
          let reads = 0
          yield* offChecks.pipe(
            Effect.provideService(ReviewGit.Current, {
              ...view,
              repository: {
                ...view.repository,
                read: (operation, signal) => {
                  reads++
                  return view.repository.read(operation, signal)
                },
              },
            }),
          )
          expect(reads).toBe(0)
        }),
      )
      const other = yield* tmpdirScoped({ git: true })
      const otherMetadata = yield* ReviewGit.metadata(other)
      yield* ReviewGit.within(
        otherMetadata,
        otherMetadata.head,
        Effect.gen(function* () {
          const foreign = (yield* ReviewGit.Current)!
          const attempted: string[] = []
          const result = yield* execute({ config: { ...input.config, impact: "graph" } }).pipe(
            Effect.provideService(ReviewGit.Current, {
              ...foreign,
              repository: {
                ...foreign.repository,
                read: (operation, signal) => {
                  attempted.push(operation.kind)
                  return foreign.repository.read(operation, signal)
                },
              },
            }),
          )
          expect(attempted).toEqual([])
          expect(result.text).not.toContain("COMMITTED_CALL")
          expect(result.impact[0]?.record.incomplete).toContain("error")
          expect(result.outcome.unreviewed).toEqual([])
        }),
      )
    }),
  { git: true },
  90_000,
)

native(
  "a timed-out private graph read is cancelled and reports incomplete context while the review finishes",
  () =>
    Effect.gen(function* () {
      const { input, execute } = yield* checkout
      const metadata = yield* ReviewGit.metadata(input.directory)
      const result = yield* ReviewGit.within(
        metadata,
        input.base,
        Effect.gen(function* () {
          const view = (yield* ReviewGit.Current)!
          let aborted = false
          const read: typeof view.repository.read = (operation, signal) => {
            if (operation.kind !== "impact-tree") return view.repository.read(operation, signal)
            return new Promise((_resolve, reject) => {
              const stop = () => {
                aborted = true
                reject(new Error("fixture private read cancelled"))
              }
              if (!signal || signal.aborted) return stop()
              signal.addEventListener("abort", stop, { once: true })
            })
          }
          const result = yield* execute({ config: { ...input.config, impact: "graph" } }).pipe(
            Effect.provideService(ReviewGit.Current, { ...view, repository: { ...view.repository, read } }),
          )
          expect(aborted).toBe(true)
          return result
        }),
      )
      expect(result.impact[0]?.record.incomplete).toContain("time")
      expect(result.outcome.notes.join(" ")).toContain("its time limit")
      expect(result.outcome.specialists).toMatchObject([{ name: "review", status: "ok" }])
      expect(result.outcome.unreviewed).toEqual([])
      expect(result.outcome.partial).toBeUndefined()
      expect(result.outcome.selection.diffIncomplete).toBeUndefined()
    }),
  { git: true },
  90_000,
)
