import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { ReviewAuthor } from "@/review/author"
import { TestConfig } from "../fixture/config"
import { outsideCI, seedAuthorship } from "../fixture/review-author"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { selectFindings } from "@vectordevai/core/review/select"
import { decodeState, emptyState, encodeState } from "@vectordevai/core/review/state"
import type { ReviewOutcome, ReviewState } from "@vectordevai/core/review/types"
import { executeLocalReview, type LocalReviewDeps, type LocalReviewOptions } from "../../src/cli/cmd/review"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))
const budget = "Not reviewed. The estimated review exceeded the configured budget before any model request."
const unavailable = "Not reviewed. VectorScope could not estimate the complete first request before dispatch."

const resolveModel: LocalReviewDeps["resolveModel"] = () =>
  Effect.succeed({
    providerID: ProviderV2.ID.make("lmstudio"),
    modelID: ModelV2.ID.make("fixture"),
    context: 100_000,
    costKind: "priced" as const,
  })

function outcomeFor(
  input: Parameters<LocalReviewDeps["runReview"]>[0],
  partial?: ReviewOutcome["partial"],
): ReviewOutcome {
  return {
    report: { summary: "", risk: "low", files: [], findings: [] },
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
    ...(partial ? { partial } : {}),
    unreviewed: partial ? input.files.map((file) => file.path) : [],
    durationMs: 0,
    base: input.base,
    head: input.head,
    mode: input.mode,
    specialists: partial === "budget-estimate" ? [] : [{ name: "review", steps: 1, status: "ok" }],
    sessions: [],
    stats: {
      files: input.files.length,
      additions: input.files.reduce((n, file) => n + file.additions, 0),
      deletions: 0,
    },
    notes: [],
  }
}

it.live("budget stops report what was unreviewed, preserve the old head, and skip requested fixes and uploads", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const dir = repo.path
    const paths = ["a.ts", "b.ts"]
    const statePath = path.join(dir, ".git/vector/review/feature.json")
    const { previous, stored } = yield* Effect.promise(async () => {
      await $`git branch -M main`.cwd(dir).quiet()
      await fs.mkdir(path.join(dir, ".vector"))
      await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify({ maxInputTokens: 1 }))
      await $`git add .vector/review.json`.cwd(dir).quiet()
      await $`git commit -qm settings`.cwd(dir).quiet()
      const previous = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
      await $`git checkout -qb feature`.cwd(dir).quiet()
      for (const file of paths) await fs.writeFile(path.join(dir, file), "export default 1\n")
      await $`git add ${paths}`.cwd(dir).quiet()
      await $`git commit -qm changes`.cwd(dir).quiet()
      // The PR ref lives in this same disposable repository. Even a fetch can only read local files.
      await $`git update-ref refs/pull/7/head HEAD`.cwd(dir).quiet()
      await $`git remote add origin .`.cwd(dir).quiet()
      const stored = JSON.stringify({
        version: 1,
        state: encodeState({ ...emptyState(), base: previous, head: previous }),
      })
      await fs.mkdir(path.dirname(statePath), { recursive: true })
      await fs.writeFile(statePath, stored)
      return { previous, stored }
    })

    const calls: string[] = []
    const unexpected = (step: string): never => {
      calls.push(step)
      throw new Error("A budget stop reached " + step)
    }
    const run = (options: Partial<LocalReviewOptions>, notes: string[]) =>
      Effect.gen(function* () {
        const output: string[] = []
        const deps: LocalReviewDeps = {
          runReview: (input) =>
            Effect.sync(() => {
              expect(input.config.maxInputTokens).toBe(1)
              if (options.pr === undefined) expect(input.since).toBe(previous)
              expect(input.head).not.toBe(previous)
              return { ...outcomeFor(input, "budget-estimate"), notes }
            }),
          resolveModel,
          color: false,
          stdout: async (text) => {
            output.push(text)
          },
          stderr: () => {},
          fix: {
            refusal: () => undefined,
            branchRefusal: () => undefined,
            run: () => Effect.sync(() => unexpected("fix")),
          },
          confirm: async () => unexpected("confirmation"),
          posting: async () => unexpected("posting check"),
          github: {
            token: async () => unexpected("token lookup"),
            login: async () => unexpected("login"),
            create: async () => unexpected("upload"),
          },
        }
        const result = yield* executeLocalReview({ directory: dir, base: "main", env: {}, ...options }, deps)
        expect(result.exitCode).toBe(2)
        expect(result.outcome?.unreviewed).toEqual(paths)
        return { result, text: output.join("") }
      })

    const human = yield* run({ apply: true }, [])
    expect(human.result.error).toBe(budget)
    expect(human.text.trim()).toBe(budget + " 2 changed files remain unreviewed.")
    expect(human.text).not.toMatch(/no issues found|risk|clean|time limit/i)
    const unknown = yield* run({ apply: true }, [unavailable])
    expect(unknown.result.error).toBe(unavailable)
    expect(unknown.text.trim()).toBe(unavailable + " 2 changed files remain unreviewed.")
    const json = yield* run({ json: true, pr: 7, post: true, yes: true }, [unavailable])
    expect(json.result.error).toBe(unavailable)
    expect(JSON.parse(json.text)).toMatchObject({
      version: 1,
      target: { kind: "pr", pr: 7 },
      outcome: { partial: "budget-estimate", unreviewed: paths, sessions: [], specialists: [], notes: [unavailable] },
    })
    expect(yield* Effect.promise(() => fs.readFile(statePath, "utf8"))).toBe(stored)
    expect(calls).toEqual([])
  }),
)

it.live("a declined full rerun keeps the saved review and retries the full branch until a reviewer finishes", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git: true })),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const dir = repo.path
    const file = path.join(dir, ".git/vector/review/feature.json")
    const head = yield* Effect.promise(async () => {
      await $`git branch -M main`.cwd(dir).quiet()
      await $`git checkout -qb feature`.cwd(dir).quiet()
      await fs.writeFile(path.join(dir, "a.ts"), "export default 1\n")
      await $`git add a.ts`.cwd(dir).quiet()
      await $`git commit -qm feature`.cwd(dir).quiet()
      await fs.mkdir(path.dirname(file), { recursive: true })
      return (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
    })
    const previous: ReviewState = {
      ...emptyState(),
      head,
      reviews: 2,
      costUsd: 0.5,
      tokens: [150, 24],
      findings: [
        {
          id: "123456789abc",
          path: "a.ts",
          line: 1,
          side: "RIGHT",
          severity: "concern",
          category: "bug",
          title: "Earlier unresolved finding",
          sha: head.slice(0, 7),
          status: "open",
        },
      ],
    }
    const load = () =>
      Effect.promise(async () => {
        const record = JSON.parse(await fs.readFile(file, "utf8"))
        return { state: decodeState(record.state), outcome: record.outcome }
      })
    const runs: string[][] = []
    let replaceSaved: string | undefined
    const run = (partial?: ReviewOutcome["partial"], full = false) =>
      executeLocalReview(
        {
          directory: dir,
          base: "main",
          full,
          env: partial === "budget-estimate" ? { REVIEW_MAX_INPUT_TOKENS: "1" } : {},
        },
        {
          resolveModel,
          color: false,
          stdout: async () => {},
          stderr: () => {},
          confirm: async () => {
            throw new Error("unexpected confirmation")
          },
          posting: async () => {
            throw new Error("unexpected posting")
          },
          runReview: (input) =>
            Effect.promise(async () => {
              expect(input.mode).toBe("full")
              expect(input.focus).toBeUndefined()
              if (partial === "budget-estimate") expect(input.config.maxInputTokens).toBe(1)
              runs.push(input.files.map((entry) => entry.path))
              if (replaceSaved) await fs.writeFile(file, replaceSaved)
              return outcomeFor(input, partial)
            }),
        },
      )

    // Start from an ordinary saved review. A marker update must preserve its recorded usage as written.
    const lastOutcome: ReviewOutcome = {
      ...(yield* run()).outcome!,
      cost: {
        model: "lmstudio/fixture",
        kind: "priced",
        costUsd: 0.5,
        input: 150,
        output: 24,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokensOwnOnly: true,
      },
    }
    const snapshot = (state: ReviewState) =>
      JSON.stringify({ version: 1, state: encodeState(state), outcome: lastOutcome })
    yield* Effect.promise(() => fs.writeFile(file, snapshot(previous)))

    // Another invocation saved a result for the same commit while this one was deciding admission.
    const newer = { ...previous, reviews: 3, costUsd: 0.75 }
    replaceSaved = snapshot(newer)
    expect((yield* run("budget-estimate", true)).exitCode).toBe(2)
    expect((yield* load()).state).toEqual(newer)
    replaceSaved = undefined

    expect((yield* run("budget-estimate", true)).exitCode).toBe(2)
    expect(yield* load()).toEqual({ state: { ...newer, retryFullAfterBudget: true }, outcome: lastOutcome })
    // Removing the cap on the same head cannot reuse the earlier clean status. A partial retry keeps the marker.
    expect((yield* run("timeout")).outcome?.partial).toBe("timeout")
    expect((yield* load()).state).toMatchObject({ retryFullAfterBudget: true, findings: newer.findings, reviews: 3 })
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(dir, "b.ts"), "export default 2\n")
      await $`git add b.ts`.cwd(dir).quiet()
      await $`git commit -qm next`.cwd(dir).quiet()
    })
    const complete = yield* run()
    expect(complete.outcome?.partial).toBeUndefined()
    const saved = (yield* load()).state
    expect(saved).toMatchObject({ head: complete.target?.head, reviews: 3, costUsd: 0.75, tokens: [150, 24] })
    expect(saved?.retryFullAfterBudget).toBeUndefined()
    yield* run()
    expect(runs).toEqual([["a.ts"], ["a.ts"], ["a.ts"], ["a.ts"], ["a.ts", "b.ts"]])
  }),
)

const authorCli = testEffect(
  Layer.merge(LayerNode.compile(LayerNode.group([Git.node])), Database.layerFromPath(":memory:")),
)
const nativeAuthorship = process.platform === "linux" ? authorCli.live : authorCli.live.skip
nativeAuthorship(
  "local review dispatch uses matched V2 authorship, forwards ZDR and renews a cached review when owner settings change",
  () =>
    Effect.gen(function* () {
      yield* outsideCI
      const repo = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const directory = repo.path
      const git = (...args: string[]) =>
        Effect.promise(() => $`git ${args}`.cwd(directory).quiet().text()).pipe(Effect.map((v) => v.trim()))
      yield* git("branch", "-M", "main")
      const before = yield* git("rev-parse", "HEAD^{tree}")
      yield* git("checkout", "-qb", "codex/feature")
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.ts"), "export const x = 1\n"))
      yield* git("add", "a.ts")
      yield* git("commit", "-m", "Implement change", "-m", "Generated-by: Gemini")
      const after = yield* git("rev-parse", "HEAD^{tree}")
      const seed = yield* seedAuthorship(directory, yield* git("rev-list", "--max-parents=0", "HEAD"))
      yield* seed(0, before, after, "claude-sonnet", ["a.ts"])
      const dispatches: string[] = []
      let ambiguous = false
      const note = "Selected the owner's equal-tier different-lab reviewer."
      const run = (enabled: boolean) =>
        executeLocalReview(
          { directory, base: "main", env: {} },
          {
            resolveModel: (request) =>
              resolveModel(request).pipe(
                Effect.map((reviewer) => {
                  if (!enabled) {
                    expect(request.author).toBeUndefined()
                    return reviewer
                  }
                  if (ambiguous) {
                    expect(request.author).toBeUndefined()
                    return reviewer
                  }
                  expect(ReviewAuthor.trustedLab(request.author)).toBe("anthropic")
                  return { ...reviewer, inversion: { note, privacy: "zdr" as const } }
                }),
              ),
            confirm: async () => false,
            stdout: async () => {},
            stderr: () => {},
            posting: async () => [],
            runReview: (input) =>
              Effect.sync(() => {
                dispatches.push(input.config.privacy ?? "standard")
                return outcomeFor(input)
              }),
          },
        ).pipe(
          Effect.provide(
            TestConfig.layer({
              getGlobal: () =>
                Effect.succeed(enabled ? { review: { inversion: "local", alternateModel: "openai/gpt" } } : {}),
            }),
          ),
        )
      expect((yield* run(false)).exitCode).toBe(0)
      const switched = yield* run(true)
      expect(switched.outcome?.notes).toContain(note)
      expect(switched.outcome?.claimedAuthor).toEqual([
        { source: "branch", lab: "openai" },
        { source: "trailer", lab: "google" },
      ])
      expect((yield* run(true)).exitCode).toBe(0)
      // A second local step claims the same end tree. It invalidates the proof while HEAD and owner
      // settings stay byte-identical. An unchanged refusal then hits the ordinary result cache.
      yield* seed(1, before, after, "gpt-5", ["a.ts"])
      ambiguous = true
      const fallback = yield* run(true)
      expect(fallback.outcome?.notes.join(" ")).toContain("No eligible local assistant snapshots")
      expect(fallback.outcome?.notes).not.toContain(note)
      expect((yield* run(true)).exitCode).toBe(0)
      expect((yield* run(false)).outcome?.claimedAuthor).toBeUndefined()
      expect(dispatches).toEqual(["standard", "zdr", "standard", "standard"])
    }),
  60_000,
)
