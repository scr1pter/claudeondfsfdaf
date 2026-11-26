import { $ } from "bun"
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { executeLocalReview, type LocalReviewOptions } from "../../src/cli/cmd/review"
import { renderLocalReview } from "../../src/cli/cmd/review.render"
import { selectFindings } from "@vectordevai/core/review/select"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { Git } from "../../src/git"
import type { RunInput } from "../../src/review/run"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

it.live("graph and automatic depth distinguish staged, uncommitted and committed reviews", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const cwd = repo.path
    yield* Effect.promise(async () => {
      await $`git branch -M main`.cwd(cwd).quiet()
      await Bun.write(path.join(cwd, "sum.ts"), "export const sum = 1\n")
      await $`git add sum.ts`.cwd(cwd).quiet()
      await $`git commit -qm base`.cwd(cwd).quiet()
      await $`git checkout -qb feature`.cwd(cwd).quiet()
      await Bun.write(path.join(cwd, "sum.ts"), "export const sum = 2\n")
      await $`git commit -qam feature`.cwd(cwd).quiet()
      await Bun.write(path.join(cwd, "sum.ts"), "export const sum = 3\n")
      await $`git add sum.ts`.cwd(cwd).quiet()
      await Bun.write(path.join(cwd, "sum.ts"), "export const sum = 4\n")
    })
    const invoke = (options: Partial<LocalReviewOptions>, env: LocalReviewOptions["env"] = {}) =>
      Effect.gen(function* () {
        const received: RunInput[] = []
        const captured = new Error("Captured the input before model dispatch")
        yield* executeLocalReview(
          { directory: cwd, env, ...options },
          {
            runReview: (input) => {
              received.push(input)
              return Effect.die(captured)
            },
            resolveModel: () =>
              Effect.succeed({
                providerID: ProviderV2.ID.make("lmstudio"),
                modelID: ModelV2.ID.make("fixture"),
                context: 100_000,
                costKind: "priced" as const,
              }),
            stdout: async () => {},
            stderr: () => {},
            confirm: async () => false,
            posting: async ({ parts }) => parts,
          },
        ).pipe(Effect.catchDefect((defect) => (defect === captured ? Effect.void : Effect.die(defect))))
        expect(received).toHaveLength(1)
        return received[0]!
      })
    for (const policy of [
      { env: { REVIEW_IMPACT: "graph" }, expected: { impact: "graph" } },
      { env: { REVIEW_DEPTH: "auto" }, expected: { depth: "auto" } },
    ]) {
      const branch = yield* invoke({ base: "main" }, policy.env)
      expect(branch.config).toMatchObject(policy.expected)
      expect(branch.uncommittedDiff).toBeUndefined()
      expect(branch.files[0]?.patch).toContain("+export const sum = 2")
      const staged = yield* invoke({ staged: true }, policy.env)
      expect(staged.uncommittedDiff).toBe(true)
      expect(staged.files[0]?.patch).toContain("+export const sum = 3")
      const uncommitted = yield* invoke({ uncommitted: true }, policy.env)
      expect(uncommitted.uncommittedDiff).toBe(true)
      expect(uncommitted.files[0]?.patch).toContain("+export const sum = 4")
    }
    const ordinary = yield* invoke({ staged: true })
    expect(ordinary.uncommittedDiff).toBeUndefined()
  }),
)

test("graph diff omissions are visible in the terminal when a reviewer returned no findings", () => {
  const selection = selectFindings({
    findings: [],
    anchors: [],
    head: "abcd",
    trust: "trusted",
    mode: "full",
    config: DEFAULT_REVIEW_CONFIG,
    prior: [],
    knownPath: () => true,
  })
  const render = (limited: boolean) =>
    renderLocalReview({
      target: { kind: "branch", label: "topic", baseRef: "main", mergeBase: "abcd", head: "1234" },
      limits: { maxCostUsd: 1, maxSteps: 10, timeoutMinutes: 1 },
      outcome: {
        report: { summary: "No issues found", risk: "low", findings: [], files: [] },
        selection: limited ? { ...selection, diffIncomplete: true } : selection,
        base: "abcd",
        head: "1234",
        mode: "full",
        skipped: [],
        unreviewed: limited ? ["large.ts"] : [],
        sessions: [],
        specialists: [{ name: "review", status: "ok", steps: 1 }],
        durationMs: 0,
        stats: { files: 2, additions: 3, deletions: 1 },
        notes: limited ? ["The diff for large.ts did not fit the context budget."] : [],
      },
    })
  expect(render(true)).toContain("Partial review")
  expect(render(true)).toContain("large.ts")
  expect(render(true)).not.toContain("No issues found")
  expect(render(false)).toContain("Risk: Low · No issues found")
})
