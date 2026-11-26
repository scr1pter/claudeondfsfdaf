import { $ } from "bun"
import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { CreateReviewPayload } from "@vectordevai/core/review/github-payload"
import { selectFindings } from "@vectordevai/core/review/select"
import type { ModelFinding, ReviewOutcome } from "@vectordevai/core/review/types"
import { executeLocalReview, type LocalReviewDeps } from "../../src/cli/cmd/review"
import { Git } from "../../src/git"
import { Review } from "../../src/review/run"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))
const marker = "<!-- vectorscope-verdict: incomplete -->"
const settings = ".vector/review.json"
const origin = "https://github.example.invalid/fixtures/widgets.git"
const strict = { failOn: "blocking-or-incomplete" } as const

const fixture = Effect.fnUntraced(function* (options: { base?: object; head?: object; lockfile?: boolean } = {}) {
  const scopedDirectory = (git?: boolean) =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir({ git })),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
  const repo = yield* scopedDirectory(true)
  const bare = yield* scopedDirectory()
  const directory = repo.path
  yield* Effect.promise(async () => {
    const git = (...args: string[]) => $`git ${args}`.cwd(directory).quiet()
    await git("config", "core.autocrlf", "false")
    await git("branch", "-M", "main")
    for (const name of ["sample", "other"])
      await Bun.write(path.join(directory, `src/${name}.ts`), "export const value = 1\n")
    if (options.base) await Bun.write(path.join(directory, settings), JSON.stringify(options.base))
    await git("add", "-A")
    await git("commit", "-qm", "base config")
    await git("checkout", "-qb", "feature")
    if (options.lockfile) await Bun.write(path.join(directory, "bun.lock"), "{}\n")
    else
      for (const name of ["sample", "other"])
        await Bun.write(path.join(directory, `src/${name}.ts`), "export const value = 2\n")
    if (options.head) await Bun.write(path.join(directory, settings), JSON.stringify(options.head))
    await git("add", "-A")
    await git("commit", "-qm", "PR changes")
    await git("checkout", "-q", "main")
    await $`git init -q --bare`.cwd(bare.path).quiet()
    await git("config", `url.${bare.path}.insteadOf`, origin)
    await git("config", "protocol.allow", "never")
    await git("config", "protocol.file.allow", "always")
    await git("remote", "add", "origin", origin)
    await git("push", "-q", "origin", "main", "feature:refs/pull/7/head")
    await git("fetch", "-q", "origin")
  })
  return directory
})

const run = Effect.fnUntraced(function* (
  directory: string,
  options: {
    environment?: string
    partial?: ReviewOutcome["partial"]
    severity?: ModelFinding["severity"]
    unreviewed?: boolean
    trivial?: boolean
    rejectReview?: boolean
    flag?: "never"
  } = {},
) {
  const reviews: CreateReviewPayload[] = []
  const comments: string[] = []
  const stdout: string[] = []
  const calls: Review.RunInput[] = []
  const deps: LocalReviewDeps = {
    resolveModel: () =>
      Effect.succeed({
        providerID: ProviderV2.ID.make("lmstudio"),
        modelID: ModelV2.ID.make("fixture"),
        context: 100_000,
        costKind: "free",
      }),
    runReview: (input) =>
      Effect.sync(() => {
        calls.push(input)
        const found: ModelFinding[] = options.severity
          ? ["sample", "other"].map((name) => ({
              path: `src/${name}.ts`,
              line: 1,
              category: "bug",
              severity: options.severity!,
              confidence: 1,
              title: "Wrong constant in " + name,
              body: "Fixture issue affecting " + name,
            }))
          : []
        const selection = selectFindings({
          findings: Review.normalizeFindings(found, "review", input.anchors),
          anchors: input.anchors,
          head: input.head,
          trust: input.trust,
          mode: input.mode,
          config: input.config,
          prior: input.prior,
          ignored: () => false,
          knownPath: () => true,
        })
        return {
          report: { summary: "Fixture review", risk: "low", files: [], findings: found },
          selection,
          base: input.base,
          head: input.head,
          mode: input.mode,
          unreviewed: options.unreviewed ? ["src/other.ts"] : [],
          specialists:
            options.trivial || options.partial === "privacy" || options.partial === "budget-estimate"
              ? []
              : [{ name: "review", status: "ok", steps: 1 }],
          sessions: options.trivial ? [] : ["ses_fixture"],
          stats: { files: 1, additions: 2, deletions: 1 },
          durationMs: 1000,
          skipped: [],
          notes: [],
          ...(options.trivial ? { trivial: true } : {}),
          ...(options.partial ? { partial: options.partial } : {}),
        } satisfies ReviewOutcome
      }),
    confirm: async () => true,
    pullInfo: async () => ({ title: "Fixture PR", baseRefName: "main" }),
    stdout: async (line) => {
      stdout.push(line)
    },
    stderr: () => {},
    now: () => 0,
    posting: async ({ parts }) => parts,
    github: {
      token: async () => "fixture-token",
      login: async () => "owner",
      create: async () => ({
        createReview: async (_pr, payload) => {
          reviews.push(payload)
          if (options.rejectReview && payload.comments.length > 1)
            throw Object.assign(new Error("fixture"), { status: 422 })
          return { id: reviews.length }
        },
        createIssueComment: async (_pr, body) => {
          comments.push(body)
          return { id: 1, html_url: "https://fixture.invalid/comment/1" }
        },
      }),
    },
  }
  const result = yield* executeLocalReview(
    {
      directory,
      base: "main",
      pr: 7,
      post: true,
      yes: true,
      json: true,
      ...(options.flag ? { failOn: options.flag } : {}),
      env: options.environment ? { REVIEW_FAIL_ON: options.environment } : {},
    },
    deps,
  )
  return { result, calls, reviews, comments, stdout }
})

it.live("a base PR gate fails incomplete and blocking reviews, including every continuation review", () =>
  Effect.gen(function* () {
    const directory = yield* fixture({ base: strict, head: { failOn: "never" } })
    const partial = yield* run(directory, {
      environment: "never",
      flag: "never",
      partial: "timeout",
      severity: "concern",
      rejectReview: true,
    })
    expect(partial.result.error).toBeUndefined()
    expect(partial.calls[0]?.config.failOn).toBe("blocking-or-incomplete")
    expect(partial.result.exitCode).toBe(1)
    expect(partial.reviews.map((review) => review.comments.length)).toEqual([2, 1, 1])
    expect(partial.reviews.every((review) => review.body.startsWith(marker + "\n"))).toBe(true)
    expect(partial.comments[0]).toContain("## Vectorscope review · Incomplete")
    expect((yield* run(directory, { unreviewed: true })).result.exitCode).toBe(1)
    const blocking = yield* run(directory, { severity: "blocking" })
    expect(blocking.result.exitCode).toBe(1)
    expect(blocking.reviews[0]?.body).not.toContain(marker)
    expect((yield* run(directory)).result.exitCode).toBe(0)
  }),
)

it.live("privacy, first-request refusal, ignored files and proved trivial skips create no PR review", () =>
  Effect.gen(function* () {
    const directory = yield* fixture({ base: strict })
    for (const partial of ["privacy", "budget-estimate"] as const) {
      const stop = yield* run(directory, { partial })
      expect(stop.result.exitCode).toBe(1)
      expect(stop.reviews).toEqual([])
      expect(stop.comments).toEqual([])
    }
    const trivial = yield* run(directory, { trivial: true })
    expect(trivial.result.exitCode).toBe(0)
    expect(trivial.reviews).toEqual([])
    expect(trivial.comments).toEqual([])
    const ignored = yield* run(yield* fixture({ base: strict, lockfile: true }))
    expect(ignored.calls).toEqual([])
    expect(ignored.result.exitCode).toBe(0)
    expect(ignored.reviews).toEqual([])
    expect(ignored.comments).toEqual([])
  }),
)

it.live("a PR head or environment cannot enable the gate and legacy posts stay unmarked", () =>
  Effect.gen(function* () {
    const directory = yield* fixture({ head: strict })
    const sample = { partial: "timeout", severity: "concern" } as const
    const baseline = yield* run(directory, sample)
    const injected = yield* run(directory, { ...sample, environment: "blocking-or-incomplete" })
    for (const result of [baseline, injected]) {
      expect(result.result.error).toBeUndefined()
      expect(result.calls[0]?.config.failOn).toBe("never")
      expect(result.result.exitCode).toBe(0)
      expect(result.reviews).toHaveLength(1)
      expect(result.reviews[0]?.body).not.toContain(marker)
      expect(result.comments).toHaveLength(1)
    }
    const resultWithoutNonce = (output: typeof baseline) => ({
      result: output.result,
      stdout: output.stdout,
      comments: output.comments,
      reviews: output.reviews.map((payload) => ({
        ...payload,
        body: payload.body.replace(/run=[0-9a-f]{8} -->/g, "run=fixture -->"),
      })),
    })
    expect(resultWithoutNonce(injected)).toEqual(resultWithoutNonce(baseline))
  }),
)
