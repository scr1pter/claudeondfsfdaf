import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { ModelV2 } from "@vectordevai/core/model"
import { Npm } from "@vectordevai/core/npm"
import { ProviderV2 } from "@vectordevai/core/provider"
import { planEdits } from "@vectordevai/core/review/fix-plan"
import { FIX_LIMITS } from "@vectordevai/core/review/fix-proposal"
import { selectFindings } from "@vectordevai/core/review/select"
import type { Finding, ModelFinding, ReviewOutcome, StrictFinding } from "@vectordevai/core/review/types"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { executeLocalReview, type LocalReviewDeps, type LocalReviewOptions } from "@/cli/cmd/review"
import { cliFixStep, fixRefusal, fixStep, terminalAsk, type FixStep } from "@/cli/cmd/review.fix"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { ReviewFix } from "@/review/fix"
import type { ResolvedModel } from "@/review/model"
import { Review } from "@/review/run"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { Worktree } from "@/worktree"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { cliIt } from "../lib/cli-process"
import { testEffect } from "../lib/effect"

// VS-12c (SF-09): `vector review --apply` against real Git and real fix placements in the test data folder. Review.run
// is replaced by a fake that anchors and selects the findings it is given (as test/cli/review.test.ts does), so no
// model is called; the executor is SF-07/SF-08's. The layer is test/review/fix.test.ts's.
const bootstrap = Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })
const locations = LayerNode.make({ service: LocationServiceMap.Service, layer: locationServiceMapLayer, deps: [] })
const layer = AppNodeBuilder.build(
  LayerNode.group([
    ReviewFix.node,
    TaskIsolation.node,
    locations,
    Worktree.node,
    InstanceStore.node,
    Session.node,
    SessionRunState.node,
    BackgroundJob.node,
    Git.node,
    Agent.node,
    Config.node,
    CrossSpawnSpawner.node,
    SessionAudience.node,
    Database.node,
  ]),
  [
    [InstanceStore.bootstrapNode, bootstrap],
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
  ],
)
const it = testEffect(layer)
afterEach(() => disposeAllInstances())

const linux = process.platform === "linux"

const LIST = "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n"
const LIST_CHANGED = "export function last(items: number[]) {\n  const index = items.length\n  return items[index]\n}\n"
const LIST_FIXED =
  "export function last(items: number[]) {\n  const index = items.length\n  return items[index - 1]\n}\n"
const OTHER = "export const other = 1\n"
const OTHER_CHANGED = "export const other = 2\n"

const model: ResolvedModel = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
  context: 100_000,
  costKind: "priced",
}

const finding = (overrides: Partial<ModelFinding> = {}): ModelFinding => ({
  path: "src/list.ts",
  line: 3,
  severity: "concern",
  category: "bug",
  title: "Returns undefined for the last item",
  body: "items[items.length] is one past the end of the array.",
  confidence: 0.9,
  ...overrides,
})
// A: the one fix every case expects to be offered.
const FIX_A = finding({ severity: "blocking", suggestion: "  return items[index - 1]" })

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const service = yield* Git.Service
    const result = yield* service.run(args, { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.text().trim()
  })
const write = (directory: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await fs.writeFile(path.join(directory, file), text)
    }
  })
const commit = (directory: string, message: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    yield* write(directory, files)
    yield* git(directory, "add", "-A", "--", ...Object.keys(files))
    yield* git(directory, "commit", "-q", "-m", message)
    return yield* git(directory, "rev-parse", "HEAD")
  })
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/** The user's checkout: index bytes, HEAD, branch, refs and these files' bytes (fix.test.ts's snapshot). */
const snapshot = (directory: string, files: readonly string[] = ["src/list.ts", "src/other.ts", "README.md"]) =>
  Effect.gen(function* () {
    const index = path.resolve(directory, yield* git(directory, "rev-parse", "--git-path", "index"))
    return {
      index: digest(yield* Effect.promise(() => fs.readFile(index))),
      head: yield* git(directory, "rev-parse", "HEAD"),
      branch: yield* git(directory, "symbolic-ref", "-q", "HEAD"),
      refs: yield* git(directory, "for-each-ref", "--format=%(refname) %(objectname)"),
      files: Object.fromEntries(
        yield* Effect.forEach(files, (file) =>
          Effect.promise(() =>
            fs.readFile(path.join(directory, file)).then(
              (bytes) => [file, digest(bytes)] as const,
              () => [file, "absent"] as const,
            ),
          ),
        ),
      ),
    }
  })
const fixRefs = (directory: string) => git(directory, "for-each-ref", "--format=%(refname)", "refs/heads/vector/")

// Every fix placement a case leaves is removed with its project (fix.test.ts's cleanup).
const cleanup = (home: InstanceContext) =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const service = yield* Git.Service
      const worktrees = path.join(Global.Path.data, "task-worktree", home.project.id, ".fix")
      const registry = path.join(Global.Path.data, "task-isolation", home.project.id, ".fix")
      const names = [
        ...(yield* Effect.promise(() => fs.readdir(worktrees).catch(() => [] as string[]))),
        ...(yield* Effect.promise(() => fs.readdir(registry).catch(() => [] as string[]))),
      ]
      for (const name of names) {
        yield* service.run(["worktree", "remove", "--force", path.join(worktrees, name)], { cwd: home.directory })
        TaskClaims.unprotect(name)
      }
      yield* Effect.promise(() =>
        Promise.all([
          fs.rm(worktrees, { recursive: true, force: true }),
          fs.rm(registry, { recursive: true, force: true }),
        ]),
      )
      yield* service.run(["worktree", "prune"], { cwd: home.directory })
    }).pipe(Effect.orDie),
  )

/** `main` with src/list.ts and src/other.ts, and `feature` (checked out) changing both. */
const fixture = Effect.gen(function* () {
  const home = yield* InstanceState.context
  yield* cleanup(home)
  const directory = home.directory
  yield* git(directory, "config", "core.autocrlf", "false")
  yield* git(directory, "branch", "-M", "main")
  const base = yield* commit(directory, "base", { "README.md": "base\n", "src/list.ts": LIST, "src/other.ts": OTHER })
  yield* git(directory, "checkout", "-q", "-b", "feature")
  const head = yield* commit(directory, "Index last() by length", {
    "src/list.ts": LIST_CHANGED,
    "src/other.ts": OTHER_CHANGED,
  })
  return { home, directory, base, head, fix: yield* ReviewFix.Service }
})

type Answer = boolean | (() => Promise<boolean>)
interface Harness {
  findings?: ModelFinding[]
  verified?: (finding: Finding) => boolean
  outcome?: (outcome: ReviewOutcome) => Partial<ReviewOutcome>
  apply?: Answer
  commit?: Answer
  interactive?: boolean
  experimental?: boolean
  // The step's executor; the test layer's own ReviewFix by default.
  step?: (ask: (question: string) => Promise<boolean>) => FixStep
  withoutStep?: boolean
}

/** LocalReviewDeps around a fake Review.run, a scripted fix step and collectors. */
const harness = (service: ReviewFix.Interface, options: Harness = {}) => {
  const calls: Parameters<LocalReviewDeps["runReview"]>[0][] = []
  const models: unknown[] = []
  const normalized: Finding[] = []
  const questions: string[] = []
  const unexpected: string[] = []
  const out: string[] = []
  const err: string[] = []
  const answer = (value: Answer | undefined) =>
    typeof value === "function" ? value() : Promise.resolve(value ?? false)
  const ask = async (question: string) => {
    questions.push(question)
    if (question.startsWith("Apply this patch")) return answer(options.apply)
    if (question.startsWith("Commit it as")) return answer(options.commit)
    unexpected.push(question)
    return false
  }
  const step =
    options.step?.(ask) ??
    fixStep({
      experimental: options.experimental ?? true,
      interactive: options.interactive ?? true,
      ask,
      executor: Layer.succeed(ReviewFix.Service, service),
    })
  const deps: LocalReviewDeps = {
    runReview: (input) =>
      Effect.sync(() => {
        calls.push(input)
        const findings = Review.normalizeFindings(options.findings ?? [], "review", input.anchors).map((item) =>
          options.verified?.(item) ? { ...item, verified: true } : item,
        )
        normalized.push(...findings)
        const selection = selectFindings({
          findings,
          anchors: input.anchors,
          head: input.head,
          trust: input.trust,
          mode: input.mode,
          config: input.config,
          prior: input.prior,
          ignored: () => false,
          knownPath: () => true,
        })
        const outcome: ReviewOutcome = {
          report: { summary: "", risk: "low", files: [], findings: options.findings ?? [] },
          selection,
          skipped: input.skipped,
          durationMs: 1000,
          base: input.base,
          head: input.head,
          mode: input.mode,
          unreviewed: [],
          specialists: [{ name: "review", status: "ok", steps: 1 }],
          sessions: ["ses_test"],
          stats: { files: input.files.length, additions: 1, deletions: 1 },
          notes: [],
        }
        return { ...outcome, ...options.outcome?.(outcome) }
      }),
    resolveModel: (input) =>
      Effect.sync(() => {
        models.push(input)
        return model
      }),
    confirm: async (question) => {
      unexpected.push(question)
      return false
    },
    stdout: async (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    now: () => Date.UTC(2026, 10, 16),
    posting: async (input) => input.parts,
    ...(options.withoutStep ? {} : { fix: step }),
  }
  const id = (title: string) => normalized.find((item) => item.title === title)?.id
  return { deps, calls, models, questions, unexpected, out: () => out.join(""), err: () => err.join(""), id }
}

const review = (directory: string, deps: LocalReviewDeps, options: Partial<LocalReviewOptions> = {}) =>
  executeLocalReview({ directory, base: "main", apply: true, env: {}, ...options }, deps)

const destination = (text: string) => /on the new branch (vector\/fix-[0-9a-f]{8})/.exec(text)?.[1]

describe.skipIf(!linux)("vector review --apply (VS-12c)", () => {
  it.instance(
    "offers nothing without --apply, and applies nothing without an explicit yes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const before = yield* snapshot(f.directory)
        const plain = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true, commit: true })
        expect((yield* review(f.directory, plain.deps, { apply: undefined, json: true })).exitCode).toBe(0)
        expect(plain.questions).toEqual([])
        expect(plain.err()).not.toContain("Fix source")
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* fixRefs(f.directory)).toBe("")

        const declined = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: false })
        expect((yield* review(f.directory, declined.deps, { full: true, json: true })).exitCode).toBe(0)
        const said = declined.err()
        expect(said).toContain(`  ${declined.id(FIX_A.title)}  blocking  src/list.ts:3  ${FIX_A.title}`)
        expect(said).toContain("Destination: a new branch vector/fix-")
        expect(said).toContain("Commands: none")
        expect(said).toContain("diff --git a/src/list.ts b/src/list.ts\n--- a/src/list.ts\n+++ b/src/list.ts\n")
        expect(said).toContain("-  return items[index]\n+  return items[index - 1]\n")
        expect(said).toContain("Nothing was applied.")
        expect(declined.questions).toEqual([
          "Apply this patch in the separate fix checkout? Your checkout, index and files are not changed. (y/N)",
        ])
        expect(declined.unexpected).toEqual([])
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* fixRefs(f.directory)).toBe("")
        // Review mode gains nothing from --apply: the reviewer is handed the same input, all of it but its callbacks
        // (new closures on every run), with the trust of your own branch and no checks.
        const first = plain.calls[0]!
        const second = declined.calls[0]!
        const data = (input: object) =>
          Object.fromEntries(Object.entries(input).filter((entry) => typeof entry[1] !== "function"))
        expect(Object.keys(second).toSorted()).toEqual(Object.keys(first).toSorted())
        expect(data(second)).toEqual(data(first))
        expect(second.trust).toBe("trusted")
        expect(second.checks).toBeUndefined()
        // The JSON on stdout is the review's alone, the same with and without --apply.
        expect(declined.out()).toBe(plain.out())

        for (const refused of [
          { interactive: false, options: {}, message: "--apply needs a terminal" },
          { interactive: true, options: { yes: true }, message: "it cannot be combined with --yes" },
        ]) {
          const run = harness(f.fix, { findings: [FIX_A], verified: () => true, interactive: refused.interactive })
          const result = yield* review(f.directory, run.deps, { full: true, ...refused.options })
          expect(result.exitCode).toBe(2)
          expect(result.error).toContain(refused.message)
          expect(run.calls).toHaveLength(0)
          expect(run.models).toHaveLength(0)
        }
        expect(yield* snapshot(f.directory)).toEqual(before)
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses --pr, CI, GitHub runs and other callers before anything is reviewed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const cases: { name: string; harness?: Harness; options?: Partial<LocalReviewOptions>; message: string }[] = [
          { name: "pr", options: { pr: 1 }, message: "cannot be combined with --pr" },
          { name: "uncommitted", options: { uncommitted: true }, message: "--uncommitted or --staged" },
          { name: "staged", options: { staged: true }, message: "--uncommitted or --staged" },
          { name: "CI", options: { env: { CI: "true" } }, message: "never runs in a CI job or a GitHub run" },
          {
            name: "GitHub",
            options: { env: { GITHUB_ACTIONS: "true" } },
            message: "never runs in a CI job or a GitHub run",
          },
          { name: "Buildkite", options: { env: { BUILDKITE: "1" } }, message: "never runs in a CI job" },
          { name: "experimental", harness: { experimental: false }, message: "--apply is experimental" },
          { name: "no step", harness: { withoutStep: true }, message: "only available to the vector review command" },
          {
            name: "service",
            options: { context: { expectedHead: f.head, settingsRef: f.head, stateless: true } },
            message: "only available to the vector review command",
          },
        ]
        for (const item of cases) {
          const run = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true, ...item.harness })
          const result = yield* review(f.directory, run.deps, item.options)
          expect([item.name, result.exitCode]).toEqual([item.name, 2])
          expect([item.name, result.error]).toEqual([item.name, expect.stringContaining(item.message)])
          expect([item.name, run.calls.length, run.models.length, run.questions.length]).toEqual([item.name, 0, 0, 0])
        }
        // A detached HEAD and a branch name a fix proposal cannot name are refused once the branch is known.
        yield* git(f.directory, "checkout", "-q", "--detach")
        const detached = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true })
        expect((yield* review(f.directory, detached.deps)).error).toContain("HEAD is detached")
        yield* git(f.directory, "checkout", "-q", "-b", "odd+name")
        const odd = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true })
        expect((yield* review(f.directory, odd.deps)).error).toContain("that a fix proposal can name")
        expect([detached.calls.length, detached.models.length, odd.calls.length, odd.models.length]).toEqual([
          0, 0, 0, 0,
        ])
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* fixRefs(f.directory)).toBe("")
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "builds the proposal only from this run's verified findings with a committable fix",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const before = yield* snapshot(f.directory)
        // B is unverified at a confidence of 0.99; C's suggestion is the line as it is; D has no suggestion.
        const B = finding({
          path: "src/other.ts",
          line: 1,
          title: "Wrong constant",
          confidence: 0.99,
          suggestion: "export const other = 3",
        })
        const C = finding({ line: 2, title: "Length is not an index", suggestion: "  const index = items.length" })
        const D = finding({ line: 1, title: "Signature hides the empty case" })
        const run = harness(f.fix, {
          findings: [FIX_A, B, C, D],
          verified: (item) => item.title !== B.title,
          apply: true,
          commit: true,
        })
        expect((yield* review(f.directory, run.deps)).exitCode).toBe(0)
        const said = run.err()
        expect(said).toContain(
          "Fix source: this review's listed findings that its verify pass confirmed, with a suggestion that can be committed as is.",
        )
        expect(said).toContain("Vector can apply 1 verified fix from this review, all together:")
        expect(said).toContain(`  ${run.id(FIX_A.title)}  blocking  src/list.ts:3  `)
        expect(said).toContain("Left out: 1 with a suggestion the verify pass did not confirm.")
        expect(said).toContain("Left out: 2 verified without a suggestion that can be committed as is.")
        expect(run.questions.map((question) => question.split("?")[0])).toEqual([
          "Apply this patch in the separate fix checkout",
          `Commit it as Test <test@vector.test> to the new branch ${destination(said)} in this repository`,
        ])
        expect(run.unexpected).toEqual([])
        const branch = destination(said)!
        expect(yield* git(f.directory, "diff", "--name-only", f.head, branch)).toBe("src/list.ts")
        expect(yield* git(f.directory, "show", `${branch}:src/list.ts`)).toBe(LIST_FIXED.trimEnd())
        expect(yield* git(f.directory, "rev-parse", `${branch}^`)).toBe(f.head)
        expect(yield* git(f.directory, "log", "-1", "--format=%an <%ae>|%cn <%ce>", branch)).toBe(
          "Test <test@vector.test>|Test <test@vector.test>",
        )
        const message = yield* git(f.directory, "log", "-1", "--format=%B", branch)
        expect(message).toContain(`- ${run.id(FIX_A.title)} at src/list.ts:3`)
        expect(message).toContain(`Reviewed commit: ${f.head}`)
        for (const other of [B, C, D]) expect(message).not.toContain(run.id(other.title)!)
        expect(message).not.toContain(FIX_A.title)
        const after = yield* snapshot(f.directory)
        expect(after).toEqual({ ...before, refs: after.refs })
        expect(yield* fixRefs(f.directory)).toBe(`refs/heads/${branch}`)
        expect(yield* f.fix.placements()).toEqual([])

        // The next run reuses the stored review, so --apply uses none of it, even a stored outcome that would offer B.
        const file = path.join(f.directory, ".git", "vector", "review", "feature.json")
        const stored = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
        stored.outcome.selection.inline = stored.outcome.selection.inline.map((item: Finding) => ({
          ...item,
          verified: true,
          suggestionAllowed: true,
        }))
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify(stored)))
        const cached = harness(f.fix, { apply: true, commit: true })
        expect((yield* review(f.directory, cached.deps)).exitCode).toBe(0)
        expect(cached.err()).toContain("Nothing was applied: --apply uses only findings from a review this run makes.")
        expect([cached.calls.length, cached.questions.length]).toEqual([0, 0])
        expect(yield* fixRefs(f.directory)).toBe(`refs/heads/${branch}`)
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "takes a strict result's checked suggestion and patch fixes and never an unchecked one",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const strict = (overrides: Partial<StrictFinding>): StrictFinding => ({
          id: "strict-1",
          class: "crash",
          mechanism: "logic",
          path: "src/other.ts",
          line: 1,
          side: "RIGHT",
          title: "Wrong constant",
          trigger: "any call",
          impact: "wrong value",
          quotes: [],
          fix: {
            kind: "patch",
            text: "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,1 @@\n-export const other = 2\n+export const other = 3\n",
          },
          verifiedBy: "model",
          verifier: "lmstudio/test-model",
          ...overrides,
        })
        const run = harness(f.fix, {
          // A legacy verified fix with a committable suggestion is ignored while a strict result is there.
          findings: [FIX_A],
          verified: () => true,
          outcome: (outcome) => ({
            strict: {
              version: 1,
              head: outcome.head,
              complete: true,
              findings: [
                strict({}),
                strict({ id: "strict-2", path: "src/list.ts", line: 2, fix: { kind: "unchecked", text: "x" } }),
                // A file name can hold a terminal control (here SGR conceal); shown as it is, it could hide the patch.
                strict({ id: "strict-3", path: "src/\u001b[8mhidden.ts", fix: { kind: "suggestion", text: "x" } }),
              ],
              dropped: [],
              fixUnchecked: 1,
            },
          }),
          apply: true,
          commit: true,
        })
        expect((yield* review(f.directory, run.deps)).exitCode).toBe(0)
        const said = run.err()
        expect(said).toContain("Fix source: the strict guardrail's verified findings, with the fixes it checked.")
        // A strict finding has no severity: the preview shows its failure class.
        expect(said).toContain("  strict-1  crash  src/other.ts:1  Wrong constant")
        expect(said).toContain("Left out: 1 verified with a fix the guardrail could not check.")
        expect(said).toContain("Left out: strict-3 (src/\\u{1b}[8mhidden.ts): a path a fix proposal cannot name.")
        expect(said).not.toContain("\u001b")
        const branch = destination(said)!
        expect(yield* git(f.directory, "diff", "--name-only", f.head, branch)).toBe("src/other.ts")
        expect(yield* git(f.directory, "show", `${branch}:src/other.ts`)).toBe("export const other = 3")
        expect(yield* git(f.directory, "show", `${branch}:src/list.ts`)).toBe(LIST_CHANGED.trimEnd())
        const message = yield* git(f.directory, "log", "-1", "--format=%B", branch)
        expect([message.includes("strict-2"), message.includes("strict-3")]).toEqual([false, false])
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "an approved apply grants neither a commit nor a push",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const origin = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        yield* git(origin.path, "init", "-q", "--bare")
        yield* git(f.directory, "remote", "add", "origin", `file://${origin.path}`)
        const before = yield* snapshot(f.directory)
        const applied = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true, commit: false })
        expect((yield* review(f.directory, applied.deps)).exitCode).toBe(0)
        expect(applied.questions.map((question) => question.split(" ")[0])).toEqual(["Apply", "Commit"])
        expect(applied.err()).toContain("Applied in the fix checkout ")
        expect(applied.err()).toContain("Not committed; the fix checkout is removed.")
        expect(yield* fixRefs(f.directory)).toBe("")
        expect(yield* git(origin.path, "for-each-ref")).toBe("")
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* snapshot(f.directory)).toEqual(before)

        const committed = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true, commit: true })
        expect((yield* review(f.directory, committed.deps, { full: true })).exitCode).toBe(0)
        expect(committed.questions.map((question) => question.split(" ")[0])).toEqual(["Apply", "Commit"])
        expect(committed.unexpected).toEqual([])
        expect(committed.err()).toContain("Nothing was pushed.")
        expect(yield* fixRefs(f.directory)).toBe(`refs/heads/${destination(committed.err())}`)
        expect(yield* git(origin.path, "for-each-ref")).toBe("")
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses an apply after the branch moved between the preview and the answer",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const run = harness(f.fix, {
          findings: [FIX_A],
          verified: () => true,
          apply: async () => {
            await fs.writeFile(path.join(f.directory, "src/other.ts"), "export const other = 4\n")
            await $`git commit -q -am moved`.cwd(f.directory).quiet()
            return true
          },
          commit: true,
        })
        expect((yield* review(f.directory, run.deps)).exitCode).toBe(0)
        expect(run.err()).toContain("Nothing was applied: The reviewed branch moved since the review.")
        expect(run.questions.map((question) => question.split(" ")[0])).toEqual(["Apply"])
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* fixRefs(f.directory)).toBe("")
        const moved = yield* git(f.directory, "rev-parse", "HEAD")
        expect(moved).not.toBe(f.head)
        expect(yield* git(f.directory, "rev-parse", "refs/heads/feature")).toBe(moved)
        expect(yield* git(f.directory, "show", "HEAD:src/list.ts")).toBe(LIST_CHANGED.trimEnd())
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "leaves out a fix whose bytes a terminal would not show as they are, and escapes model text",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const hidden = finding({ title: "Hidden", suggestion: "  return items[index - 1] // \u202Eevil" })
        const shown = finding({
          path: "src/other.ts",
          line: 1,
          title: "Wrong \u202Econstant",
          suggestion: "export const other = 3",
        })
        const run = harness(f.fix, { findings: [hidden, shown], verified: () => true, apply: false })
        expect((yield* review(f.directory, run.deps)).exitCode).toBe(0)
        const said = run.err()
        expect(said).toContain(
          `Left out: ${run.id(hidden.title)} (src/list.ts): its fix adds control or invisible characters.`,
        )
        expect(said).toContain("  src/other.ts:1  Wrong \\u{202e}constant")
        expect(said).not.toContain("\u202E")
        expect(said).not.toContain("diff --git a/src/list.ts")
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "works from a linked worktree of the repository and leaves that checkout as it was",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const linked = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const directory = path.join(linked.path, "linked")
        yield* git(f.directory, "worktree", "add", "-q", "-b", "linked", directory, "feature")
        const before = yield* snapshot(directory)
        const run = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true, commit: true })
        expect((yield* review(directory, run.deps)).exitCode).toBe(0)
        const branch = destination(run.err())!
        expect(yield* git(f.directory, "show", `${branch}:src/list.ts`)).toBe(LIST_FIXED.trimEnd())
        const after = yield* snapshot(directory)
        expect(after).toEqual({ ...before, refs: after.refs })
        expect(yield* f.fix.placements()).toEqual([])
        yield* git(f.directory, "worktree", "remove", "--force", directory)
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "the command's own step builds its executor from the running services",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const states: (ReviewFix.State | undefined)[] = []
        const run = harness(f.fix, {
          findings: [FIX_A],
          verified: () => true,
          apply: async () => {
            // The step's executor is the runtime's own: it knows the placement this test layer's service holds.
            const worktree = /Fix checkout: (\S+)/.exec(run.err())![1]
            states.push(await Effect.runPromise(f.fix.state(path.basename(worktree))))
            return true
          },
          commit: true,
          step: (ask) => ({ ...cliFixStep({ experimental: true, ask }), refusal: () => undefined }),
        })
        expect((yield* review(f.directory, run.deps)).exitCode).toBe(0)
        expect(states).toEqual(["preview"])
        expect(yield* git(f.directory, "show", `${destination(run.err())}:src/list.ts`)).toBe(LIST_FIXED.trimEnd())
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )
})

describe.skipIf(linux)("vector review --apply off Linux (VS-12c)", () => {
  it.instance(
    "refuses --apply before anything is reviewed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const run = harness(f.fix, { findings: [FIX_A], verified: () => true, apply: true })
        const result = yield* review(f.directory, run.deps)
        expect(result.exitCode).toBe(2)
        expect(result.error).toContain("--apply is available on Linux only")
        expect([run.calls.length, run.models.length, run.questions.length]).toEqual([0, 0, 0])
      }),
    { git: true },
    60_000,
  )
})

describe("vector review --apply questions (VS-12c)", () => {
  // `text` is typed once the question shows ("" ends the input there); `before` is typed before the call, and
  // `during` while the question waits to be shown.
  const asked = (text: string, options: { terminal?: boolean; before?: string; during?: string } = {}) => {
    const input = new PassThrough()
    const output = new PassThrough()
    if (options.before !== undefined) input.write(options.before)
    if (options.during !== undefined) setTimeout(() => input.write(options.during), 10)
    new Promise<void>((resolve) => output.on("data", (chunk) => String(chunk).includes("Apply?") && resolve())).then(
      () => (text === "" ? input.end() : input.write(text)),
    )
    return terminalAsk("Apply? (y/N)", {
      input,
      output,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    })
  }
  it.live("answers yes only to y or yes, and no to the end of input or Ctrl-C", () =>
    Effect.gen(function* () {
      expect(yield* Effect.promise(() => asked("y\n"))).toBe(true)
      expect(yield* Effect.promise(() => asked("Yes\n"))).toBe(true)
      expect(yield* Effect.promise(() => asked("n\n"))).toBe(false)
      expect(yield* Effect.promise(() => asked("\n"))).toBe(false)
      expect(yield* Effect.promise(() => asked(""))).toBe(false)
      expect(yield* Effect.promise(() => asked("\x03", { terminal: true }))).toBe(false)
    }),
  )
  it.live("counts only what is typed once the question shows", () =>
    Effect.gen(function* () {
      // A "y" typed before the question, buffered or arriving while it waits, never answers it.
      expect(yield* Effect.promise(() => asked("", { before: "y\n" }))).toBe(false)
      expect(yield* Effect.promise(() => asked("n\n", { during: "y\n" }))).toBe(false)
      expect(yield* Effect.promise(() => asked("\n", { before: "y", during: "y\ny\n" }))).toBe(false)
      // What is typed to the question still counts, and a Ctrl-C typed before it answers no.
      expect(yield* Effect.promise(() => asked("y\n", { before: "n\n", during: "n\n" }))).toBe(true)
      expect(yield* Effect.promise(() => asked("y\n", { during: "\x03" }))).toBe(false)
    }),
  )
  it.live("refuses without the experimental setting first, then off Linux, in CI, and without a terminal", () =>
    Effect.sync(() => {
      expect(fixRefusal({ env: { CI: "true" }, interactive: false, experimental: false })).toContain("is experimental")
      if (!linux) return
      expect(fixRefusal({ env: { CI: "true" }, interactive: false, experimental: true })).toContain("CI job")
      expect(fixRefusal({ env: { CI: "false" }, interactive: false, experimental: true })).toContain("terminal")
      expect(fixRefusal({ env: {}, interactive: true, experimental: true })).toBeUndefined()
      // The command's own step reads the terminal from stdin and stderr; under the test runner neither is one.
      expect(cliFixStep({ experimental: true }).refusal({})).toContain("needs a terminal, on stdin and stderr")
    }),
  )
})

describe("vector review --apply from the command line (VS-12c)", () => {
  cliIt.concurrent(
    "is refused before anything is reviewed while VectorScope is not turned on",
    ({ llm, vector, home }) =>
      Effect.gen(function* () {
        const run = (...args: string[]) => $`git ${args}`.cwd(home).quiet()
        yield* Effect.promise(async () => {
          await run("init", "-q", "-b", "main")
          await run("config", "user.email", "test@vector.test")
          await run("config", "user.name", "Test")
          await run("config", "commit.gpgsign", "false")
          await Bun.write(path.join(home, ".gitignore"), ".config/\n.local/\n.cache/\n")
          await Bun.write(path.join(home, "src/list.ts"), LIST)
          await run("add", "-A")
          await run("commit", "-q", "-m", "base")
          await run("checkout", "-q", "-b", "feature")
          await Bun.write(path.join(home, "src/list.ts"), LIST_CHANGED)
          await run("commit", "-q", "-am", "Index last() by length")
        })
        const result = yield* vector.spawn(["review", "--apply", "--model", "lmstudio/test-model"], {
          timeoutMs: 90_000,
        })
        vector.expectExit(result, 2, "--apply without experimental.vectorscope")
        expect(result.stderr).toContain("--apply is experimental")
        expect(result.stderr).not.toContain("Reviewing")
        expect(yield* llm.calls).toBe(0)
      }),
    120_000,
  )
})

describe("vector review --apply edits (VS-12c)", () => {
  type Fix = Parameters<typeof planEdits>[0][number]
  const fix = (id: string, file: string, start: number, text: string, overrides: Partial<Fix> = {}): Fix => ({
    id,
    path: file,
    start,
    end: start,
    label: "concern",
    title: id,
    kind: "lines",
    text,
    ...overrides,
  })
  const heads = (files: Record<string, string>) =>
    new Map(Object.entries(files).map(([file, text]) => [file, new TextEncoder().encode(text)]))
  const decoded = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  it.live("applies line fixes bottom-up, keeps a missing final newline and leaves out an overlapping fix", () =>
    Effect.sync(() => {
      const planned = planEdits(
        [
          fix("first", "f.txt", 1, "A1\nA2\n"),
          fix("range", "f.txt", 3, "CD", { end: 4 }),
          fix("inside", "f.txt", 4, "X"),
        ],
        heads({ "f.txt": "a\nb\nc\nd" }),
      )
      expect(planned.files.map((file) => [file.path, decoded(file.before), decoded(file.after)])).toEqual([
        ["f.txt", "a\nb\nc\nd", "A1\nA2\nb\nCD"],
      ])
      expect(planned.files[0]!.patch).toBe(
        [
          "diff --git a/f.txt b/f.txt",
          "--- a/f.txt",
          "+++ b/f.txt",
          "@@ -1,4 +1,4 @@",
          "-a",
          "+A1",
          "+A2",
          " b",
          "-c",
          "-d",
          "\\ No newline at end of file",
          "+CD",
          "\\ No newline at end of file",
          "",
        ].join("\n"),
      )
      expect([planned.files[0]!.additions, planned.files[0]!.deletions]).toEqual([3, 3])
      expect(planned.used.map((item) => item.id)).toEqual(["first", "range"])
      expect(planned.skipped).toEqual([{ id: "inside", path: "f.txt", reason: "it overlaps another fix" }])
    }),
  )

  it.live("a patch fix is the only fix for its file", () =>
    Effect.sync(() => {
      const planned = planEdits(
        [
          fix("line", "g.txt", 1, "ONE"),
          fix("patch", "g.txt", 2, "--- a/g.txt\n+++ b/g.txt\n@@ -2,1 +2,1 @@\n-two\n+TWO\n", { kind: "patch" }),
        ],
        heads({ "g.txt": "one\ntwo\n" }),
      )
      expect(planned.files.map((file) => decoded(file.after))).toEqual(["one\nTWO\n"])
      expect(planned.files[0]!.patch).toBe(
        "diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n",
      )
      expect(planned.used.map((item) => item.id)).toEqual(["patch"])
      expect(planned.skipped).toEqual([{ id: "line", path: "g.txt", reason: "another fix changes this file" }])
    }),
  )

  it.live("caps the findings and files in path order", () =>
    Effect.sync(() => {
      const names = Array.from({ length: FIX_LIMITS.findings + 2 }, (_, index) => `f${String(index).padStart(3, "0")}`)
      const planned = planEdits(
        names.map((name) => fix(name, `${name}.txt`, 1, "y")),
        heads(Object.fromEntries(names.map((name) => [`${name}.txt`, "x\n"]))),
      )
      expect(planned.files.map((file) => file.path)).toEqual(
        names.slice(0, FIX_LIMITS.files).map((name) => `${name}.txt`),
      )
      expect(planned.used.map((item) => item.id)).toEqual(names.slice(0, FIX_LIMITS.files))
      expect(planned.skipped).toEqual([
        ...names
          .slice(FIX_LIMITS.findings)
          .map((name) => ({ id: name, path: `${name}.txt`, reason: "over the proposal's finding limit" })),
        ...names
          .slice(FIX_LIMITS.files, FIX_LIMITS.findings)
          .map((name) => ({ id: name, path: `${name}.txt`, reason: "over the proposal's file limit" })),
      ])
    }),
  )

  it.live("leaves out a file that would take the patch over its line or byte limit and keeps those that fit", () =>
    Effect.sync(() => {
      const long = "x\n".repeat(3_000)
      const planned = planEdits(
        [
          fix("a", "a.txt", 1, "A", { end: 3_000 }),
          fix("b", "b.txt", 1, "B", { end: 3_000 }),
          fix("big", "big.txt", 1, "z".repeat(FIX_LIMITS.patchBytes)),
          fix("c", "c.txt", 1, "C"),
        ],
        heads({ "a.txt": long, "b.txt": long, "big.txt": "x\n", "c.txt": "x\n" }),
      )
      expect(planned.files.map((file) => [file.path, decoded(file.after)])).toEqual([
        ["a.txt", "A\n"],
        ["c.txt", "C\n"],
      ])
      expect(planned.used.map((item) => item.id)).toEqual(["a", "c"])
      expect(planned.skipped).toEqual([
        { id: "b", path: "b.txt", reason: "over the proposal's size limit" },
        { id: "big", path: "big.txt", reason: "over the proposal's size limit" },
      ])
    }),
  )
})
