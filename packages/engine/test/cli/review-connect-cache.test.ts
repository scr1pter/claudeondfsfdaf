import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { selectFindings } from "@vectordevai/core/review/select"
import { executeLocalReview, type LocalReviewDeps } from "@/cli/cmd/review"
import { Git } from "@/git"
import { readAuthority } from "@/review/read-authority"
import type { Review } from "@/review/run"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, CrossSpawnSpawner.node])))

it.instance(
  "a connected branch cache reuses only the bytes written for its admitted review",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const leaf = path.join(directory, ".git", "vector", "review", "feature.json")
      const head = yield* Effect.promise(async () => {
        await $`git branch -M main`.cwd(directory).quiet()
        await $`git switch -qc feature`.cwd(directory).quiet()
        await fs.writeFile(path.join(directory, "changed.ts"), "export const changed = 1\n")
        await fs.writeFile(path.join(directory, "private.ts"), "export const fixture = 2\n")
        await $`git add changed.ts private.ts`.cwd(directory).quiet()
        await $`git commit -qm feature`.cwd(directory).quiet()
        return (await $`git rev-parse HEAD`.cwd(directory).quiet().text()).trim()
      })
      const calls: Review.RunInput[] = []
      const tool = path.join(TRUNCATION_DIR, "tool-output-fixture")
      const runReview: LocalReviewDeps["runReview"] = (input) =>
        Effect.sync(() => {
          calls.push(input)
          return {
            base: input.base,
            head: input.head,
            mode: input.mode,
            report: { summary: "Review over the admitted files.", risk: "low", files: [], findings: [] },
            selection: selectFindings({
              findings: [],
              anchors: input.anchors,
              head: input.head,
              trust: input.trust,
              mode: input.mode,
              config: input.config,
              prior: input.prior,
            }),
            skipped: input.skipped,
            unreviewed: [],
            specialists: [{ name: "review", steps: 1, status: "ok" }],
            sessions: [],
            stats: { files: input.files.length, additions: 1, deletions: 0 },
            notes: [],
            durationMs: 0,
          }
        })
      const invoke = (options: {
        fingerprint?: string
        full?: boolean
        strict?: boolean
        security?: boolean
        stateless?: boolean
        denies?: string[]
        witness?: boolean
      } = {}) =>
        Effect.gen(function* () {
          const admission = readAuthority(
            [path.join(TRUNCATION_DIR, "*"), ".kube/*", ".docker/config.json", ...(options.denies ?? [])],
            { directory, worktree: directory },
          )
          let written: string | undefined
          let text = ""
          const result = yield* executeLocalReview(
            {
              directory,
              base: "main",
              json: true,
              full: options.full,
              security: options.security,
              env: {
                REVIEW_SECURITY: "off",
                REVIEW_VERIFY: "off",
                ...(options.strict ? { REVIEW_GUARDRAIL: "strict" } : {}),
              },
              context: {
                expectedHead: head,
                settingsRef: head,
                stateless: options.stateless ?? false,
                readRoot: directory,
                readDenies: admission.absolute,
                admittedReads: admission,
              },
            },
            {
              ...(options.witness === false
                ? {}
                : {
                    branchCache: {
                      fingerprint: options.fingerprint,
                      written(value) {
                        written = value
                      },
                    },
                  }),
              runReview,
              resolveModel: () =>
                Effect.succeed({
                  providerID: ProviderV2.ID.make("local"),
                  modelID: ModelV2.ID.make("review"),
                  context: 100_000,
                  costKind: "local",
                }),
              stdout: async (output) => {
                text += output
              },
              stderr: () => {},
              confirm: async () => false,
              posting: async () => [],
            },
          )
          expect(result.error).toBeUndefined()
          return { written, printed: JSON.parse(text) }
        })
      const first = yield* invoke({ full: true })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.admittedReads?.denied(tool)).toBe(true)
      expect(calls[0]!.admittedReads?.denied(".kube/config")).toBe(true)
      const raw = yield* Effect.promise(() => fs.readFile(leaf))
      expect(first.written).toMatch(/^[a-f0-9]{64}$/)
      expect((yield* invoke({ fingerprint: first.written })).printed.cached).toBe(true)
      expect(calls).toHaveLength(1)

      const forged = JSON.parse(raw.toString("utf8"))
      forged.outcome.report.summary = "Unobserved content should never surface."
      yield* Effect.promise(() => fs.writeFile(leaf, JSON.stringify(forged) + "\n"))
      const repaired = yield* invoke({ fingerprint: first.written })
      expect(repaired.printed.cached).toBeUndefined()
      expect(repaired.printed.outcome.report.summary).toBe("Review over the admitted files.")
      expect(calls).toHaveLength(2)
      expect(calls[1]!.mode).toBe("full")
      expect(calls[1]!.prior).toEqual([])

      // An otherwise valid fingerprint never answers a different effective review policy.
      const stronger = yield* invoke({ fingerprint: repaired.written, security: true })
      expect(stronger.printed.cached).toBeUndefined()
      expect(calls).toHaveLength(3)
      expect(calls[2]!.config.security).toBe("always")

      // A different admitted authority has no writer fingerprint. It starts a full review.
      const restricted = yield* invoke({ full: true, denies: [path.join(directory, "private.ts")] })
      expect(restricted.written).toMatch(/^[a-f0-9]{64}$/)
      expect(restricted.printed.cached).toBeUndefined()
      expect(calls).toHaveLength(4)
      expect(calls[3]!.files.map((file) => file.path)).toEqual(["changed.ts"])
      expect(calls[3]!.admittedReads?.denied("private.ts")).toBe(true)
      expect(calls[3]!.admittedReads?.denied(tool)).toBe(true)

      const last = yield* Effect.promise(() => fs.readFile(leaf, "utf8"))
      for (const options of [{ strict: true }, { strict: true }, { stateless: true }, { witness: false }]) {
        const next = yield* invoke({ ...options, fingerprint: restricted.written })
        expect(next.written).toBeUndefined()
        expect(next.printed.cached).toBeUndefined()
      }
      expect(calls).toHaveLength(8)
      expect(yield* Effect.promise(() => fs.readFile(leaf, "utf8"))).toBe(last)
    }),
  { git: true },
)
