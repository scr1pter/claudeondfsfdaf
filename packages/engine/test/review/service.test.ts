import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { selectFindings } from "@vectordevai/core/review/select"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import type { LocalReviewDeps } from "@/cli/cmd/review"
import { Git } from "@/git"
import type { RunInput } from "@/review/run"
import { execute, type Input } from "@/review/service"
import { ReviewGit } from "@/review/git"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, CrossSpawnSpawner.node])))
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((value) => value.trim()))

const fixture = Effect.gen(function* () {
  const directory = yield* tmpdirScoped({ git: true })
  yield* git(directory, "config", "core.autocrlf", "false")
  yield* git(directory, "branch", "-M", "main")
  yield* Effect.promise(() => fs.mkdir(path.join(directory, ".vector"), { recursive: true }))
  yield* Effect.promise(() =>
    fs.writeFile(path.join(directory, ".vector/review.json"), '{"maxComments":3,"maxCostUsd":0.5}'),
  )
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "AGENTS.md"), "Use the pinned base instructions.\n"))
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "visible.ts"), "export const count = 1\n"))
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "private.ts"), "export const count = 1\n"))
  yield* git(directory, "add", ".")
  yield* git(directory, "commit", "-qm", "base")
  const base = yield* git(directory, "rev-parse", "HEAD")
  yield* git(directory, "checkout", "-qb", "feature")
  yield* Effect.promise(() => fs.writeFile(path.join(directory, "visible.ts"), "export const count = 2\n"))
  yield* Effect.promise(() =>
    fs.writeFile(path.join(directory, "private.ts"), "export const secret = 'not for this reviewer'\n"),
  )
  yield* git(directory, "add", ".")
  yield* git(directory, "commit", "-qm", "change")
  const head = yield* git(directory, "rev-parse", "HEAD")
  return { directory, base, head }
})

function adapter() {
  const calls: RunInput[] = []
  const deps: LocalReviewDeps = {
    runReview: (input) =>
      Effect.sync(() => {
        calls.push(input)
        return {
          report: { summary: "", risk: "low", files: [], findings: [] },
          selection: selectFindings({
            findings: [],
            anchors: input.anchors,
            head: input.head,
            trust: input.trust,
            mode: input.mode,
            config: input.config,
            prior: [],
            knownPath: () => true,
          }),
          skipped: input.skipped,
          durationMs: 1,
          base: input.base,
          head: input.head,
          mode: input.mode,
          unreviewed: [],
          specialists: [{ name: "review", status: "ok", steps: 1 }],
          sessions: [],
          stats: { files: input.files.length, additions: 0, deletions: 0 },
          notes: [],
        } satisfies ReviewOutcome
      }),
    resolveModel: () =>
      Effect.succeed({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("review"),
        context: 100_000,
        costKind: "local",
      }),
    confirm: async () => false,
    stdout: async () => {},
    stderr: () => {},
    posting: async () => {
      throw new Error("A stateless local review must never post")
    },
  }
  return { calls, deps }
}

const request = (repo: { directory: string; base: string; head: string }): Input => ({
  version: 1,
  mode: "review",
  directory: repo.directory,
  target: { kind: "branch", head: repo.head, base: repo.base },
  settingsRef: repo.base,
})

describe("shared review service", () => {
  it.live("a real repository filter executes in the control but never in cold or warmed bound collection", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const outside = yield* tmpdirScoped()
      const counter = path.join(outside, "filter-counter")
      yield* Effect.promise(() =>
        fs.writeFile(path.join(repo.directory, ".gitattributes"), "*.ts filter=scope-probe\n"),
      )
      yield* git(repo.directory, "add", ".gitattributes")
      yield* git(repo.directory, "commit", "-qm", "filter attributes without a configured command")
      const head = yield* git(repo.directory, "rev-parse", "HEAD")
      const quoted = "'" + counter.replaceAll("'", "'\"'\"'") + "'"
      yield* git(repo.directory, "config", "filter.scope-probe.clean", `printf x >> ${quoted}; cat`)
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(repo.directory, "visible.ts"),
          "export function increment(value: number) { return value + 1 }\n",
        ),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(repo.directory, "added.ts"), "export const added = 1\n"))
      yield* git(repo.directory, "status", "--porcelain")
      expect((yield* Effect.promise(() => fs.readFile(counter, "utf8"))).length).toBeGreaterThan(0)
      yield* Effect.promise(() => fs.writeFile(counter, ""))
      for (let attempt = 0; attempt < 2; attempt++) {
        const owned: { view?: ReviewGit.View } = {}
        const run = adapter()
        const result = yield* execute(
          { ...request(repo), target: { kind: "working-tree", head }, settingsRef: head },
          {
            ...run.deps,
            resolveModel: (input) =>
              Effect.gen(function* () {
                owned.view = yield* ReviewGit.Current
                expect(owned.view).toBeDefined()
                return yield* run.deps.resolveModel(input)
              }),
            runReview: (input) =>
              Effect.gen(function* () {
                expect(yield* ReviewGit.Current).toBe(owned.view)
                expect(input.files.map((file) => file.path)).toEqual(["visible.ts", "added.ts"])
                expect(input.context.history?.some((entry) => entry.path === "visible.ts")).toBe(true)
                expect(yield* Effect.promise(() => input.knownPath("visible.ts"))).toBe(true)
                return yield* run.deps.runReview(input)
              }),
          },
        )
        expect(result.error).toBeUndefined()
        expect(run.calls).toHaveLength(1)
        const view = owned.view
        if (!view) throw new Error("The bound review never acquired its private view")
        const closed = yield* Effect.promise(() =>
          view.repository.status().then(
            () => false,
            (error) => error instanceof ReadOnlyGit.Unavailable,
          ),
        )
        expect(closed).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("")
      }
    }),
  )

  it.live("unsupported repository metadata refuses before model resolution or review", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      yield* git(repo.directory, "config", "include.path", "untrusted-config")
      const run = adapter()
      let resolutions = 0
      const result = yield* execute(request(repo), {
        ...run.deps,
        resolveModel: (input) =>
          Effect.gen(function* () {
            resolutions++
            return yield* run.deps.resolveModel(input)
          }),
      })
      expect(result.exitCode).toBe(2)
      expect(result.error).toContain("includes are unsupported")
      expect(resolutions).toBe(0)
      expect(run.calls).toEqual([])
      expect(result.verdict.verdict).toBe("not-reviewed")
    }),
  )

  it.live("unsupported collector authority is refused without a live Git fallback", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const bound = yield* ReviewGit.metadata(repo.directory)
      const result = yield* ReviewGit.within(
        bound,
        repo.head,
        Effect.gen(function* () {
          const git = yield* ReviewGit.client
          const denied = yield* git.run(["config", "--get", "user.email"], { cwd: repo.directory })
          expect(denied.exitCode).toBe(128)
          return yield* ReviewGit.preflight.pipe(Effect.result)
        }),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  it.live("retains requester read authority when the review runs in a real Git worktree", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const directory = yield* tmpdirScoped()
      yield* git(repo.directory, "worktree", "add", "--detach", directory, repo.head)
      const run = adapter()
      const result = yield* execute(
        {
          ...request(repo),
          directory,
          readRoot: repo.directory,
          readDenies: [path.join(repo.directory, "private.ts")],
        },
        run.deps,
      )
      expect(run.calls[0]!.directory).toBe(directory)
      expect(run.calls[0]!.readRoot).toBe(repo.directory)
      expect(run.calls[0]!.files.map((file) => file.path)).toEqual(["visible.ts"])
      expect(yield* Effect.promise(() => run.calls[0]!.knownPath("private.ts"))).toBe(false)
      expect(result.verdict.verdict).toBe("incomplete")
    }),
  )

  it.live("keeps admitted read denials when the caller mutates its array during model setup", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const run = adapter()
      const readDenies = ["private.ts"]
      const result = yield* execute(
        { ...request(repo), readDenies },
        {
          ...run.deps,
          resolveModel: (input) =>
            Effect.gen(function* () {
              readDenies.length = 0
              return yield* run.deps.resolveModel(input)
            }),
        },
      )
      expect(result.verdict.verdict).toBe("incomplete")
      expect(run.calls[0]!.readDenies).toEqual(["private.ts"])
      expect(yield* Effect.promise(() => run.calls[0]!.knownPath("private.ts"))).toBe(false)
    }),
  )

  it.live("an already-cancelled invocation starts no model setup or reviewer", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const run = adapter()
      const controller = new AbortController()
      controller.abort()
      const result = yield* execute(
        { ...request(repo), stopSignal: controller.signal },
        {
          ...run.deps,
          resolveModel: () => Effect.die("cancelled invocation resolved a model"),
        },
      )
      expect(result.exitCode).toBe(2)
      expect(result.error).toContain("cancelled")
      expect(run.calls).toEqual([])
    }),
  )
  it.live("uses pinned settings and parent placement without GitHub or durable branch state", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      yield* Effect.promise(() => fs.writeFile(path.join(repo.directory, ".vector/review.json"), '{"maxComments":99}'))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(repo.directory, "AGENTS.md"), "Working tree instruction must not reach the reviewer.\n"),
      )
      const run = adapter()
      const input = { ...request(repo), parentID: "ses_parent", maxCost: 9 }
      const result = yield* execute(input, run.deps)
      expect(result.exitCode).toBe(0)
      expect(result.verdict.verdict).toBe("clean-complete")
      expect(run.calls).toHaveLength(1)
      expect(run.calls[0]).toMatchObject({
        parentID: "ses_parent",
        rulesSource: "base branch",
        instructionsFromContext: true,
        config: { maxComments: 3, maxCostUsd: 0.5 },
      })
      expect(run.calls[0]!.context.instructions).toContain("pinned base instructions")
      expect(run.calls[0]!.context.instructions).not.toContain("Working tree instruction")
      expect(run.calls[0]!.checks).toBeUndefined()
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(repo.directory, ".git/vector/review/feature.json")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.live("withholds denied files from the diff and context and reports incomplete coverage", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const run = adapter()
      const result = yield* execute({ ...request(repo), readDenies: ["private.ts"] }, run.deps)
      expect(run.calls[0]!.files.map((file) => file.path)).toEqual(["visible.ts"])
      expect(JSON.stringify(run.calls[0]!.context)).not.toContain("not for this reviewer")
      expect(yield* Effect.promise(() => run.calls[0]!.knownPath("private.ts"))).toBe(false)
      expect(run.calls[0]!.readDenies).toEqual(["private.ts"])
      expect(result.outcome?.unreviewed).toContain("private.ts")
      expect(result.verdict.verdict).toBe("incomplete")
    }),
  )

  it.live("rejects a stale head and unavailable settings before any reviewer starts", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      for (const input of [
        { ...request(repo), target: { ...request(repo).target, head: repo.base } },
        { ...request(repo), settingsRef: "f".repeat(40) },
      ]) {
        const run = adapter()
        const result = yield* execute(input, run.deps)
        expect(result.exitCode).toBe(2)
        expect(run.calls).toEqual([])
        expect(result.error).toBeDefined()
      }
    }),
  )

  it.live("checks the head again after asynchronous model setup", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const run = adapter()
      const result = yield* execute(request(repo), {
        ...run.deps,
        resolveModel: (input) =>
          Effect.gen(function* () {
            yield* git(repo.directory, "commit", "--allow-empty", "-qm", "head moved")
            return yield* run.deps.resolveModel(input)
          }),
      })
      expect(result.exitCode).toBe(2)
      expect(run.calls).toEqual([])
      expect(result.error).toContain("changed before")
    }),
  )
})
