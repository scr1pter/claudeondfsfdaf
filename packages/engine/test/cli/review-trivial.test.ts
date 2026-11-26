import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { noteTrivialSkip } from "@vectordevai/core/review/format"
import { selectFindings } from "@vectordevai/core/review/select"
import { decodeState } from "@vectordevai/core/review/state"
import type { ModelFinding } from "@vectordevai/core/review/types"
import { executeLocalReview, type LocalReviewDeps, type LocalReviewOptions } from "../../src/cli/cmd/review"
import { Config } from "../../src/config/config"
import { Git } from "../../src/git"
import { normalizeFindings, type RunInput } from "../../src/review/run"
import { ReviewTrivial } from "../../src/review/trivial"
import { TestConfig } from "../fixture/config"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const fixture = (skip: boolean) =>
  Effect.gen(function* () {
    const repo = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const dir = repo.path
    yield* Effect.promise(async () => {
      await $`git branch -M main`.cwd(dir).quiet()
      await fs.mkdir(path.join(dir, ".vector"), { recursive: true })
      await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify(skip ? { trivial: "skip" } : {}))
      await fs.writeFile(path.join(dir, "README.md"), "A small library.\n")
      await fs.mkdir(path.join(dir, "docs"))
      await fs.writeFile(path.join(dir, "docs/intro.md"), "Setup guide.\n")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -qm base`.cwd(dir).quiet()
      await $`git checkout -qb feature`.cwd(dir).quiet()
      await fs.writeFile(path.join(dir, "README.md"), "A tiny library.\n")
      await $`git add README.md`.cwd(dir).quiet()
      await $`git commit -qm docs`.cwd(dir).quiet()
    })
    return dir
  })

const invoke = (
  directory: string,
  options: Partial<LocalReviewOptions> = {},
  fixture: { findings?: ModelFinding[]; settings?: Partial<Config.Interface> } = {},
) =>
  Effect.gen(function* () {
    const inputs: RunInput[] = []
    const printed: string[] = []
    const deps: LocalReviewDeps = {
      runReview: (input) =>
        Effect.gen(function* () {
          inputs.push(input)
          const kinds = input.trivialProof
            ? yield* ReviewTrivial.kinds(input.trivialProof, {
                directory: input.directory,
                head: input.head,
                base: input.base,
                files: input.anchors,
                config: input.config,
              })
            : undefined
          const findings = kinds?.length ? [] : (fixture.findings ?? [])
          return {
            ...(kinds?.length ? { trivial: true as const } : {}),
            report: { summary: "", risk: "low" as const, files: [], findings },
            selection: selectFindings({
              findings: normalizeFindings(findings, "review", input.anchors),
              anchors: input.anchors,
              head: input.head,
              trust: input.trust,
              mode: input.mode,
              config: input.config,
              prior: input.prior,
              ...(input.focus ? { focus: input.focus } : {}),
              knownPath: () => true,
            }),
            skipped: input.skipped,
            durationMs: 0,
            base: input.base,
            head: input.head,
            mode: input.mode,
            unreviewed: [],
            specialists: kinds?.length ? [] : [{ name: "review" as const, status: "ok" as const, steps: 1 }],
            sessions: [],
            stats: { files: input.files.length, additions: 1, deletions: 1 },
            notes: kinds?.length ? [noteTrivialSkip()] : [],
          }
        }),
      resolveModel: () =>
        Effect.succeed({
          providerID: ProviderV2.ID.make("lmstudio"),
          modelID: ModelV2.ID.make("fixture"),
          context: 100_000,
          costKind: "priced" as const,
        }),
      stdout: async (text) => {
        printed.push(text)
      },
      stderr: () => {},
      confirm: async () => false,
      posting: async ({ parts }) => parts,
    }
    const result = yield* executeLocalReview({ directory, env: {}, ...options }, deps).pipe(
      Effect.provideService(Config.Service, TestConfig.make(fixture.settings)),
    )
    expect(inputs).toHaveLength(1)
    return { input: inputs[0]!, output: printed.join(""), outcome: result.outcome, exitCode: result.exitCode }
  })

it.live("a committed policy skip prints its reason and leaves the branch eligible for review", () =>
  Effect.gen(function* () {
    const dir = yield* fixture(true)
    const human = yield* invoke(dir)
    expect(human.exitCode).toBe(0)
    if (process.platform !== "linux") {
      expect(human.input.trivialProof).toBeUndefined()
      expect(human.outcome?.trivial).toBeUndefined()
      return
    }
    expect(human.input.trivialProof).toBeDefined()
    expect(human.outcome?.trivial).toBe(true)
    expect(human.output.trim()).toBe(noteTrivialSkip())
    expect(human.output).not.toContain("No issues found")
    const state = path.join(dir, ".git/vector/review/feature.json")
    expect(human.input.mode).toBe("full")
    expect(yield* Effect.promise(() => Bun.file(state).exists())).toBe(false)
    const json = yield* invoke(dir, { json: true })
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.output)).toMatchObject({
      version: 1,
      outcome: { trivial: true, sessions: [], specialists: [] },
    })
    expect(json.input.mode).toBe("full")
    expect(yield* Effect.promise(() => Bun.file(state).exists())).toBe(false)
  }),
)

it.live("the default branch review, explicit full review and staged changes never supply a trivial proof", () =>
  Effect.gen(function* () {
    const off = yield* invoke(yield* fixture(false))
    expect(off.input.trivialProof).toBeUndefined()
    expect(off.input.forceFull).toBeUndefined()
    const dir = yield* fixture(true)
    const full = yield* invoke(dir, { full: true })
    expect(full.input.forceFull).toBe(true)
    expect(full.input.trivialProof).toBeUndefined()
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(dir, "README.md"), "Another small library.\n")
      await $`git add README.md`.cwd(dir).quiet()
    })
    const staged = yield* invoke(dir, { staged: true })
    expect(staged.input.config.trivial).toBe("skip")
    expect(staged.input.trivialProof).toBeUndefined()
    expect(staged.input.forceFull).toBeUndefined()
  }),
)

it.live("an incremental policy skip preserves the last reviewed head and fails on its open blocker", () =>
  Effect.gen(function* () {
    const dir = yield* fixture(true)
    const finding: ModelFinding = {
      path: "README.md",
      line: 1,
      severity: "blocking",
      category: "bug",
      title: "The setup command is missing",
      body: "A new contributor cannot reproduce the setup from these instructions.",
      confidence: 0.95,
    }
    const first = yield* invoke(dir, { full: true }, { findings: [finding] })
    expect(first.exitCode).toBe(0)
    const file = path.join(dir, ".git/vector/review/feature.json")
    const saved = yield* Effect.promise(() => fs.readFile(file, "utf8"))
    const state = decodeState(JSON.parse(saved).state)
    if (!state) throw new Error("The initial review did not persist its state")
    expect(state.head).toBe(first.input.head)
    expect(state.findings).toHaveLength(1)
    expect(state.findings[0]).toMatchObject({ title: finding.title, severity: "blocking", status: "open" })
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(dir, "docs/intro.md"), "Short setup guide.\n")
      await $`git add docs/intro.md`.cwd(dir).quiet()
      await $`git commit -qm guide`.cwd(dir).quiet()
    })
    const next = yield* invoke(dir, { failOn: "blocking" })
    expect(next.input.mode).toBe("incremental")
    expect(next.input.since).toBe(first.input.head)
    expect(next.input.head).not.toBe(first.input.head)
    expect(next.input.prior).toHaveLength(1)
    expect(next.input.prior[0]?.id).toBe(state.findings[0]!.id)
    if (process.platform !== "linux") {
      expect(next.input.trivialProof).toBeUndefined()
      return
    }
    expect(next.outcome?.trivial).toBe(true)
    expect(next.outcome?.selection.stillOpen).toMatchObject([{ id: state?.findings[0]?.id, severity: "blocking" }])
    expect(next.output).toContain(noteTrivialSkip())
    expect(next.output).toContain("1 finding from the last review is still open (1 blocking).")
    expect(next.exitCode).toBe(1)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(saved)
  }),
)

it.live("unavailable effective instructions fall back to a normal review", () =>
  Effect.gen(function* () {
    const dir = yield* fixture(true)
    const review = yield* invoke(dir, {}, { settings: { get: () => Effect.die("fixture instructions unavailable") } })
    expect(review.exitCode).toBe(0)
    expect(review.input.config.trivial).toBe("skip")
    expect(review.input.trivialProof).toBeUndefined()
    expect(review.outcome?.trivial).toBeUndefined()
    expect(review.outcome?.specialists).toMatchObject([{ name: "review", status: "ok" }])
  }),
)
