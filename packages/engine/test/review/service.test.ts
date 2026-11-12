import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { selectFindings } from "@vectordevai/core/review/select"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import type { LocalReviewDeps } from "@/cli/cmd/review"
import { Git } from "@/git"
import type { RunInput } from "@/review/run"
import { execute, type Input } from "@/review/service"
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
