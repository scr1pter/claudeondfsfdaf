import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ProviderV2 } from "@vectordevai/core/provider"
import { parseReviewConfig, REVIEW_CONFIG_PATH } from "@vectordevai/core/review/config"
import { notePrivacyRefused } from "@vectordevai/core/review/format"
import { selectFindings } from "@vectordevai/core/review/select"
import type { ModelFinding, ReviewOutcome } from "@vectordevai/core/review/types"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import {
  APPLY_DIAGNOSTICS_REFUSAL,
  executeLocalReview,
  type LocalReviewDeps,
  type LocalReviewOptions,
} from "../../src/cli/cmd/review"
import type { FixStep, FixStepInput } from "../../src/cli/cmd/review.fix"
import { Git } from "../../src/git"
import { ReviewModel, type ResolvedModel } from "../../src/review/model"
import { Review } from "../../src/review/run"
import { Config } from "../../src/config/config"
import { TestConfig } from "../fixture/config"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-23b (SF-11): `vector review` reads review.json through mergeReviewConfig (core config.ts) and holds the models it
// resolves to the route rules under privacy "zdr". Against temporary Git repositories, with Review.run replaced by a fake
// that anchors and selects the findings it is given, as test/cli/review.test.ts does; no model is called.

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir({ git: true })),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((text) => text.trim()))

const write = (cwd: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
      await Bun.write(path.join(cwd, file), text)
    }
  })

const commit = (cwd: string, message: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    yield* write(cwd, files)
    yield* git(cwd, "add", "-A")
    yield* git(cwd, "commit", "-q", "-m", message)
    return yield* git(cwd, "rev-parse", "HEAD")
  })

const LIST = "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n"
const LIST_CHANGED = "export function last(items: number[]) {\n  const index = items.length\n  return items[index]\n}\n"

// `main` with src/list.ts, and `feature` rewriting last().
const branched = Effect.gen(function* () {
  const dir = (yield* scopedTmpdir()).path
  yield* git(dir, "config", "core.autocrlf", "false")
  yield* git(dir, "branch", "-M", "main")
  yield* commit(dir, "base", { "src/list.ts": LIST })
  yield* git(dir, "checkout", "-q", "-b", "feature")
  const head = yield* commit(dir, "Index last() by length", { "src/list.ts": LIST_CHANGED })
  return { dir, head }
})

const model: ResolvedModel = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
  context: 100_000,
  costKind: "priced",
}

const finding: ModelFinding = {
  path: "src/list.ts",
  line: 3,
  severity: "blocking",
  category: "bug",
  title: "Returns undefined for the last item",
  body: "items[items.length] is one past the end of the array.",
  confidence: 0.9,
}

// A Review.run stand-in that anchors and selects the findings it is given, and records what it and model resolution
// were asked.
function fake(options: { findings?: ModelFinding[]; outcome?: Partial<ReviewOutcome>; refuse?: boolean } = {}) {
  const calls: Review.RunInput[] = []
  const resolved: ReviewModel.ResolveInput[] = []
  const out: string[] = []
  const err: string[] = []
  const deps: LocalReviewDeps = {
    runReview: (input) =>
      Effect.sync(() => {
        calls.push(input)
        const found = options.findings ?? []
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
          report: { summary: "", risk: "low", files: [], findings: found },
          selection,
          skipped: input.skipped,
          durationMs: 1000,
          base: input.base,
          head: input.head,
          mode: input.mode,
          unreviewed: [],
          specialists: [{ name: "review", status: "ok", steps: 1 }],
          sessions: ["ses_test"],
          stats: { files: input.files.length, additions: 2, deletions: 1 },
          notes: [],
          ...options.outcome,
        } satisfies ReviewOutcome
      }),
    resolveModel: (input) =>
      Effect.gen(function* () {
        resolved.push(input)
        if (options.refuse)
          return yield* new ReviewModel.ReviewModelError({
            message: 'lmstudio/claude-fable-5 has no zero data retention route Vector may use while privacy is "zdr".',
            model: "lmstudio/claude-fable-5",
            refusal: "retention-required-model",
          })
        return model
      }),
    confirm: async () => false,
    stdout: async (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    now: () => Date.UTC(2026, 10, 16),
    posting: async (input) => input.parts,
  }
  return { deps, calls, resolved, out: () => out.join(""), err: () => err.join("") }
}

const review = (options: LocalReviewOptions, deps: LocalReviewDeps) => executeLocalReview(options, deps)
const warnings = (err: string) => err.split("\n").filter((line) => line.startsWith("Warning: "))
const statePath = (dir: string) => path.join(dir, ".git", "vector", "review", "feature.json")
const readState = (dir: string) => Effect.promise(() => fs.readFile(statePath(dir), "utf8").catch(() => undefined))

describe("vector review: review settings with their sources (VS-23b)", () => {
  it.live("with no sourced key named, the review gets parseReviewConfig's settings and warnings", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const texts = [undefined, '{"verify": "off", "maxSteps": 7, "bogus": 1}', "{", '{"auto": true}']
      const envs = [{}, { REVIEW_MAX_COMMENTS: "3", REVIEW_VERIFY: "sometimes", REVIEW_VERIFY_POLICY: "shared" }]
      for (const text of texts)
        for (const env of envs)
          for (const uncommitted of [false, true]) {
            if (text === undefined)
              yield* Effect.promise(() => fs.rm(path.join(repo.dir, REVIEW_CONFIG_PATH), { force: true }))
            else yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: text })
            // Something uncommitted for --uncommitted to review.
            yield* write(repo.dir, { "src/list.ts": `${LIST_CHANGED}// edited\n` })
            const run = fake()
            const result = yield* review({ directory: repo.dir, full: true, uncommitted, env }, run.deps)
            const expected = parseReviewConfig({ json: text, env, trigger: "local" })
            expect({ text, env, uncommitted, exitCode: result.exitCode }).toEqual({
              text,
              env,
              uncommitted,
              exitCode: 0,
            })
            expect(run.calls[0]!.config).toEqual(expected.config)
            expect(warnings(run.err())).toEqual(expected.warnings.map((warning) => `Warning: ${warning}`))
          }
    }),
  )

  it.live('privacy unset or "standard", model resolution is asked exactly as before, with no route', () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const settings = { triageModel: "lmstudio/triage", panel: true, judgeModel: "other/judge" }
      for (const privacy of [undefined, "standard"]) {
        yield* write(repo.dir, {
          [REVIEW_CONFIG_PATH]: JSON.stringify({ ...settings, ...(privacy ? { privacy } : {}) }),
        })
        const run = fake()
        yield* review({ directory: repo.dir, full: true, env: {} }, run.deps)
        expect(run.resolved).toHaveLength(3)
        expect(run.resolved.some((input) => Object.hasOwn(input, "route"))).toBe(false)
        expect(Object.hasOwn(run.calls[0]!.config, "privacy")).toBe(false)
      }
    }),
  )

  it.live(
    'REVIEW_PRIVACY or review.json raises privacy to "zdr", nothing lowers it, and each model is resolved under it',
    () =>
      Effect.gen(function* () {
        const repo = yield* branched
        const settings = { triageModel: "lmstudio/triage", panel: true, judgeModel: "other/judge" }
        const cases: [Record<string, unknown>, Record<string, string>][] = [
          [settings, { REVIEW_PRIVACY: "zdr" }],
          [{ ...settings, privacy: "zdr" }, {}],
          [{ ...settings, privacy: "zdr" }, { REVIEW_PRIVACY: "standard" }],
          [{ ...settings, privacy: "standard" }, { REVIEW_PRIVACY: "zdr" }],
        ]
        for (const [json, env] of cases) {
          yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: JSON.stringify(json) })
          const run = fake()
          yield* review({ directory: repo.dir, full: true, env }, run.deps)
          expect(run.calls[0]!.config.privacy).toBe("zdr")
          expect(run.resolved.map((input) => input.route)).toEqual([
            { privacy: "zdr", attested: [] },
            { privacy: "zdr", attested: [] },
            { privacy: "zdr", attested: [] },
          ])
        }
      }),
  )

  it.live("zdrAttested in the working tree is ignored with a warning: it is read only from the global config", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: JSON.stringify({ privacy: "zdr", zdrAttested: ["lmstudio"] }) })
      const run = fake()
      yield* review({ directory: repo.dir, full: true, env: {} }, run.deps)
      expect(run.calls[0]!.config.zdrAttested).toBeUndefined()
      expect(warnings(run.err())).toEqual([
        `Warning: ${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: "zdrAttested" is read only from the global config.`,
      ])
      expect(run.resolved[0]!.route).toEqual({ privacy: "zdr", attested: [] })
    }),
  )
})

describe("vector review: a review the route rules stop (VS-23b)", () => {
  const note = notePrivacyRefused({
    model: "lmstudio/claude-fable-5",
    refusal: "retention-required-model",
    attempts: 0,
  })
  const error =
    'Vector did not review this change: privacy is "zdr", and a model this review would use has no zero data retention route Vector may use.'

  it.live(
    "a model resolution refuses: nothing runs, the review fails as not reviewed, and the next run reviews again",
    () =>
      Effect.gen(function* () {
        const repo = yield* branched
        yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: JSON.stringify({ privacy: "zdr" }) })
        // A review of the first commit leaves its state; the next commit is then refused.
        expect((yield* review({ directory: repo.dir, env: {} }, fake().deps)).exitCode).toBe(0)
        const before = yield* readState(repo.dir)
        expect(before).toBeString()
        // This commit also adds the review.json written above, so it is part of the change.
        const head = yield* commit(repo.dir, "Another change", { "src/list.ts": `${LIST_CHANGED}// more\n` })

        const json = fake({ refuse: true })
        const refused = yield* review({ directory: repo.dir, env: {}, json: true }, json.deps)
        expect(json.calls).toEqual([])
        expect(refused).toMatchObject({ exitCode: 2, error })
        const printed = JSON.parse(json.out())
        expect(printed.outcome).toMatchObject({
          head,
          partial: "privacy",
          unreviewed: [REVIEW_CONFIG_PATH, "src/list.ts"],
          specialists: [],
          sessions: [],
          notes: [note],
          report: { findings: [] },
          selection: { inline: [], outsideDiff: [], elsewhere: [], nits: [], overflow: [] },
        })
        expect(reviewVerdict({ kind: "outcome", outcome: printed.outcome })).toEqual({
          verdict: "not-reviewed",
          causes: ["privacy"],
          notes: [],
        })
        // The "since last review" state is as the first review left it, as after any review that could not run.
        expect(yield* readState(repo.dir)).toBe(before!)

        const text = fake({ refuse: true })
        const shown = yield* review({ directory: repo.dir, env: {} }, text.deps)
        expect(shown.exitCode).toBe(2)
        // Nothing was assessed, so the header names no risk.
        expect(text.out().split("\n")).toContain("Not reviewed")
        expect(text.out()).not.toContain("Risk:")
        expect(text.out()).toContain(
          'Not reviewed: privacy is "zdr", and a model this review would use has no zero data retention route Vector may use. Files not reviewed: .vector/review.json, src/list.ts.',
        )
        expect(text.out()).not.toContain("No issues found")
        expect(text.out()).not.toContain("Partial review")

        // With the model allowed again, the next run reviews the refused commit.
        const next = fake()
        expect((yield* review({ directory: repo.dir, env: {} }, next.deps)).exitCode).toBe(0)
        expect(next.calls).toHaveLength(1)
        expect(next.calls[0]!.head).toBe(head)
      }),
  )

  it.live("a review Review.run stopped for privacy fails the same way, applies no fix and lists no finding", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: JSON.stringify({ privacy: "zdr" }) })
      let applied = 0
      const fix: FixStep = {
        refusal: () => undefined,
        branchRefusal: () => undefined,
        run: () => Effect.sync(() => void applied++),
      }
      const stopped = notePrivacyRefused({ model: "lmstudio/test-model", refusal: "unknown-destination", attempts: 1 })
      const run = fake({
        outcome: { partial: "privacy", unreviewed: ["src/list.ts"], notes: [stopped] },
      })
      const result = yield* review({ directory: repo.dir, env: {}, apply: true }, { ...run.deps, fix })
      expect(run.calls).toHaveLength(1)
      expect(result).toMatchObject({ exitCode: 2, error })
      expect(applied).toBe(0)
      expect(run.out().split("\n")).toContain("Not reviewed")
      expect(run.out()).not.toContain("Risk:")
      expect(run.out()).not.toContain("No issues found")
      expect(yield* readState(repo.dir)).toBeUndefined()
    }),
  )
})

// VS-23d (SF-15): the user config's hidden `review` block, read through the config service, raises privacy and holdback
// over review.json and REVIEW_*, and is the one source of zdrAttested here. Without the service, or without the block,
// the review is what it was before SF-15.
describe("vector review: the user config's review block (VS-23d)", () => {
  const withGlobal = (global: ConfigV1.Info) =>
    Effect.provideService(Config.Service, TestConfig.make({ getGlobal: () => Effect.succeed(global) }))

  it.live("--apply receives the effective secret holdback policy", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: '{"holdback":"off"}' })
      const applied: FixStepInput["holdback"][] = []
      const fix: FixStep = {
        refusal: () => undefined,
        branchRefusal: () => undefined,
        run: (input) => Effect.sync(() => void applied.push(input.holdback)),
      }
      const run = fake()
      const result = yield* review({ directory: repo.dir, env: {}, apply: true }, { ...run.deps, fix }).pipe(
        withGlobal({ review: { holdback: "secrets" } }),
      )
      expect(result.error).toBeUndefined()
      expect(applied).toEqual(["secrets"])
    }),
  )

  // scope-finish takeover (2026-11-23): the outcome --apply reads is redacted under offline diagnostics, so a fix could
  // write "[redacted]" into the source. --apply is refused first, before any model is resolved or anything is reviewed.
  it.live("--apply is refused before any review while the user config's review diagnostics are offline", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      let applied = 0
      const fix: FixStep = {
        refusal: () => undefined,
        branchRefusal: () => undefined,
        run: () => Effect.sync(() => void applied++),
      }
      const run = fake()
      const result = yield* review({ directory: repo.dir, env: {}, apply: true }, { ...run.deps, fix }).pipe(
        withGlobal({ review: { diagnostics: "offline" } }),
      )
      expect(result).toMatchObject({ exitCode: 2, error: APPLY_DIAGNOSTICS_REFUSAL })
      expect(run.calls).toEqual([])
      expect(run.resolved).toEqual([])
      expect(applied).toBe(0)
      // Without --apply the same review runs.
      const plain = fake()
      expect((yield* review({ directory: repo.dir, env: {} }, plain.deps).pipe(
        withGlobal({ review: { diagnostics: "offline" } }),
      )).error).toBeUndefined()
      expect(plain.calls).toHaveLength(1)
    }),
  )

  it.live("no config service, an empty user config and an empty block give the settings and warnings of before", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const text = '{"verify":"off","privacy":"zdr","holdback":"secrets","zdrAttested":["acme"]}'
      yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: text })
      const runs = []
      for (const provide of [
        <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        withGlobal({}),
        withGlobal({ review: {} }),
        withGlobal({ review: { privacy: "standard", holdback: "off" } }),
      ]) {
        const run = fake()
        yield* review({ directory: repo.dir, full: true, env: {} }, run.deps).pipe(provide)
        runs.push({ config: run.calls[0]!.config, warnings: warnings(run.err()), route: run.resolved[0]!.route })
      }
      expect(runs[0]!.config.privacy).toBe("zdr")
      expect(runs[0]!.config.zdrAttested).toBeUndefined()
      for (const run of runs.slice(1)) expect(run).toEqual(runs[0]!)
    }),
  )

  it.live("the block raises privacy and holdback that review.json and REVIEW_* set lower, and alone attests", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      yield* write(repo.dir, {
        [REVIEW_CONFIG_PATH]: '{"privacy":"standard","holdback":"off","zdrAttested":["acme"]}',
      })
      const run = fake()
      yield* review(
        { directory: repo.dir, full: true, env: { REVIEW_PRIVACY: "standard", REVIEW_HOLDBACK: "off" } },
        run.deps,
      ).pipe(withGlobal({ review: { privacy: "zdr", holdback: "secrets", zdrAttested: ["models.invalid"] } }))
      expect(run.calls[0]!.config).toMatchObject({
        privacy: "zdr",
        holdback: "secrets",
        zdrAttested: ["models.invalid"],
      })
      expect(warnings(run.err())).toEqual([
        `Warning: ${REVIEW_CONFIG_PATH}: "zdrAttested" is ignored: "zdrAttested" is read only from the global config.`,
      ])
      expect(run.resolved.map((input) => input.route)).toEqual([{ privacy: "zdr", attested: ["models.invalid"] }])
    }),
  )

  it.live("a pull request's base and the local service's pinned settings are raised the same way", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      // The settings commit: main, holding a review.json that lowers nothing and attests nothing.
      yield* git(repo.dir, "checkout", "-q", "main")
      const settingsRef = yield* commit(repo.dir, "settings", { [REVIEW_CONFIG_PATH]: '{"privacy":"standard"}' })
      yield* git(repo.dir, "checkout", "-q", "feature")
      const head = yield* git(repo.dir, "rev-parse", "HEAD")
      const run = fake()
      yield* review(
        {
          directory: repo.dir,
          base: "main",
          full: true,
          env: {},
          json: true,
          context: { expectedHead: head, settingsRef, stateless: true },
        },
        run.deps,
      ).pipe(withGlobal({ review: { privacy: "zdr", zdrAttested: ["lmstudio"] } }))
      expect(run.calls[0]!.config).toMatchObject({ privacy: "zdr", zdrAttested: ["lmstudio"] })
      expect(run.resolved[0]!.route).toEqual({ privacy: "zdr", attested: ["lmstudio"] })
    }),
  )

  it.live("under the block's zdr a model with no route is refused: exit 2, nothing run, nothing saved", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const run = fake({ refuse: true })
      const result = yield* review({ directory: repo.dir, env: {}, json: true }, run.deps).pipe(
        withGlobal({ review: { privacy: "zdr" } }),
      )
      expect(result.exitCode).toBe(2)
      expect(run.calls).toEqual([])
      expect(run.resolved[0]!.route).toEqual({ privacy: "zdr", attested: [] })
      expect(JSON.parse(run.out()).outcome).toMatchObject({
        partial: "privacy",
        sessions: [],
        notes: [
          notePrivacyRefused({ model: "lmstudio/claude-fable-5", refusal: "retention-required-model", attempts: 0 }),
        ],
      })
      expect(yield* readState(repo.dir)).toBeUndefined()
    }),
  )
})
