import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { REVIEW_CONFIG_PATH } from "@vectordevai/core/review/config"
import { selectFindings } from "@vectordevai/core/review/select"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { executeLocalReview, type LocalReviewDeps } from "../../src/cli/cmd/review"
import { Git } from "../../src/git"
import { ReviewGit } from "../../src/review/git"
import type { ResolvedModel } from "../../src/review/model"
import { Review } from "../../src/review/run"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-34 item 4 (SF-13b): under holdback "secrets", `vector review` asks git which changed files the repository's ignore
// rules exclude although committed (ReviewGit.ignoredPaths, `git check-ignore --no-index`), and hands the list to
// Review.run, which notes them. Against temporary Git repositories, with Review.run replaced by a fake that records
// what it is given, as test/cli/review-privacy.test.ts does; no model is called. The bound view's grammar for the same
// read is test/review/service.test.ts's (CI only).

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))
const posix = process.platform !== "win32"

const scopedTmpdir = (git = true) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(git ? { git: true } : {})),
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

// Commits every change, the ignored files `forced` names included.
const commit = (cwd: string, message: string, files: Record<string, string>, forced: string[] = []) =>
  Effect.gen(function* () {
    yield* write(cwd, files)
    yield* git(cwd, "add", "-A")
    if (forced.length) yield* git(cwd, "add", "-f", "--", ...forced)
    yield* git(cwd, "commit", "-q", "-m", message)
  })

const LIST = "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n"
const LIST_CHANGED = "export function last(items: number[]) {\n  const index = items.length\n  return items[index]\n}\n"
const QUOTED = 'q"uote.local.json'

// `main` ignores *.local.json and commits one anyway; `feature` changes two committed ignored files (one with a
// non-ASCII name, and on POSIX one whose name git quotes), deletes a third and rewrites last().
const branched = Effect.gen(function* () {
  const dir = (yield* scopedTmpdir()).path
  yield* git(dir, "config", "core.autocrlf", "false")
  yield* git(dir, "branch", "-M", "main")
  yield* commit(
    dir,
    "base",
    { ".gitignore": "*.local.json\n", "src/list.ts": LIST, "config.local.json": "{}\n", "old.local.json": "{}\n" },
    ["config.local.json", "old.local.json"],
  )
  yield* git(dir, "checkout", "-q", "-b", "feature")
  yield* git(dir, "rm", "-q", "old.local.json")
  const changed = ["config.local.json", "é.local.json", ...(posix ? [QUOTED] : [])]
  yield* commit(
    dir,
    "Change the local settings",
    { "src/list.ts": LIST_CHANGED, ...Object.fromEntries(changed.map((file) => [file, '{ "a": 1 }\n'])) },
    changed,
  )
  return { dir }
})

const model: ResolvedModel = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
  context: 100_000,
  costKind: "priced",
}

// A Review.run stand-in that records what it was given and returns an outcome with no findings.
function fake(outcome: Partial<ReviewOutcome> = {}) {
  const calls: Review.RunInput[] = []
  const out: string[] = []
  const err: string[] = []
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
            prior: input.prior,
            ignored: () => false,
            knownPath: () => true,
          }),
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
          ...outcome,
        } satisfies ReviewOutcome
      }),
    resolveModel: () => Effect.succeed(model),
    confirm: async () => false,
    stdout: async (text) => {
      out.push(text)
    },
    stderr: (text) => {
      err.push(text)
    },
    now: () => Date.UTC(2026, 10, 20),
    posting: async (input) => input.parts,
  }
  return { deps, calls, out: () => out.join(""), err: () => err.join("") }
}

const readState = (dir: string) =>
  Effect.promise(() =>
    fs.readFile(path.join(dir, ".git", "vector", "review", "feature.json"), "utf8").catch(() => undefined),
  )

describe("vector review: the ignored list under holdback (VS-34, SF-13b)", () => {
  it.live(
    "holdback unset asks git nothing and hands Review.run no list; secrets hands it the ignored changed files",
    () =>
      Effect.gen(function* () {
        const repo = yield* branched
        const unset = fake()
        expect((yield* executeLocalReview({ directory: repo.dir, full: true, env: {} }, unset.deps)).exitCode).toBe(0)
        expect(Object.hasOwn(unset.calls[0], "ignored")).toBe(false)
        for (const env of [{ REVIEW_HOLDBACK: "secrets" }, {}]) {
          if (!Object.keys(env).length) yield* write(repo.dir, { [REVIEW_CONFIG_PATH]: '{"holdback": "secrets"}' })
          const run = fake()
          expect((yield* executeLocalReview({ directory: repo.dir, full: true, env }, run.deps)).exitCode).toBe(0)
          const call = run.calls[0]
          expect(call.config.holdback).toBe("secrets")
          // Since SF-14 the key covers the reviewer's tools too, so it gives no warning: stderr is unset's.
          expect(run.err()).toBe(unset.err())
          // In the change's order; the deleted ignored file is not asked about, and src/list.ts is not ignored.
          expect(call.files.find((file) => file.path === "old.local.json")?.status).toBe("deleted")
          expect(call.ignored).toEqual(["config.local.json", ...(posix ? [QUOTED] : []), "é.local.json"])
        }
      }),
  )

  it.live("the user's global excludes never count, only the repository's own ignore rules", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      // An excludes file that would ignore every TypeScript file, set in the repository's config as a global one is.
      yield* write(repo.dir, { ".git/vector-excludes": "*.ts\n" })
      yield* git(repo.dir, "config", "core.excludesFile", path.join(repo.dir, ".git/vector-excludes"))
      expect(yield* git(repo.dir, "check-ignore", "--no-index", "src/list.ts")).toBe("src/list.ts")
      const ignored = yield* ReviewGit.ignoredPaths(repo.dir, ["src/list.ts", "config.local.json"])
      expect(ignored).toEqual(["config.local.json"])
    }),
  )

  it.live("asks in batches, keeps the order it was given, and says when it cannot tell", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      // check-ignore reads patterns, so the paths need not exist: 1,500 of them take several calls.
      const paths = Array.from({ length: 1_500 }, (_, index) => `gen/${index}.${index % 3 ? "local.json" : "ts"}`)
      expect(yield* ReviewGit.ignoredPaths(repo.dir, paths)).toEqual(paths.filter((file) => file.endsWith(".json")))
      expect(yield* ReviewGit.ignoredPaths(repo.dir, ["src/list.ts"])).toEqual([])
      expect(yield* ReviewGit.ignoredPaths(repo.dir, [])).toEqual([])
      // A leading ":" is a path, not pathspec magic, and an option-shaped name is a path too.
      expect(yield* ReviewGit.ignoredPaths(repo.dir, [":x.local.json", "--stdin"])).toEqual([":x.local.json"])
      // A path the read-only port would refuse is never asked about; a directory git cannot read fails.
      for (const bad of ["../x.local.json", "a\\b.local.json", ".git/x.local.json", "./x.local.json"])
        expect(yield* ReviewGit.ignoredPaths(repo.dir, ["config.local.json", bad])).toBeUndefined()
      const plain = (yield* scopedTmpdir(false)).path
      expect(yield* ReviewGit.ignoredPaths(plain, ["config.local.json"])).toBeUndefined()
    }),
  )

  // Git refuses the whole call (exit 128, "beyond a symbolic link") when one path lies below a work-tree symbolic
  // link, so the list is unknown for every path, and the review notes it could not check (decided in the SF-13b
  // entry: no retry path by path).
  ;(posix ? it.live : it.live.skip)("one path below a symbolic link leaves the whole list unknown", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      yield* write(repo.dir, { "real/x.local.json": "{}\n" })
      yield* Effect.promise(() => fs.symlink("real", path.join(repo.dir, "lnk")))
      expect(yield* ReviewGit.ignoredPaths(repo.dir, ["config.local.json", "real/x.local.json"])).toEqual([
        "config.local.json",
        "real/x.local.json",
      ])
      expect(yield* ReviewGit.ignoredPaths(repo.dir, ["config.local.json", "lnk/x.local.json"])).toBeUndefined()
    }),
  )

  // The bound view's port runs check-ignore under git's default core.quotepath, which writes a non-ASCII name in octal
  // bytes; the fallback above sets core.quotepath=false and gets it raw. Git's own output in that form, and a recorded
  // one, read back as the paths asked about, on any host.
  it.live("reads the port's quoted form: octal bytes, escapes and a CRLF line end", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const asked = [
        "./config.local.json",
        "./é.local.json",
        ...(posix ? ['./q"uote.local.json', "./t\tab.local.json"] : []),
      ]
      // Through Git.Service, whose own core.quotepath=false the later -c overrides (Bun's shell mangles this argv).
      const service = yield* Git.Service
      const quoted = (yield* service.run(["-c", "core.quotepath=true", "check-ignore", "--no-index", "--", ...asked], {
        cwd: repo.dir,
      })).text()
      expect(quoted).toContain('"./\\303\\251.local.json"')
      expect(ReviewGit.echoedPaths(quoted)).toEqual(asked)
      expect(
        ReviewGit.echoedPaths(
          [
            '"./\\303\\251.local.json"\r',
            "./config.local.json",
            '"./q\\"uote.local.json"',
            '"./a\\\\b\\tc.local.json"',
            '"./\\q.local.json"',
            "",
          ].join("\n"),
        ),
      ).toEqual([
        "./é.local.json",
        "./config.local.json",
        './q"uote.local.json',
        "./a\\b\tc.local.json",
        "./\\q.local.json",
      ])
    }),
  )
})

describe("vector review: a change whose every file is held back (VS-34, SF-13b)", () => {
  // I-7: Review.run made no attempt, so the review is shown as not reviewed, never with a risk or "No issues found",
  // exits 2 as a zero-attempt stop does, and records nothing, so the next run reviews the change again.
  it.live("is not reviewed: no risk or clean headline, exit 2, nothing recorded; with nothing held it fails", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const outcome = {
        specialists: [],
        sessions: [],
        skipped: [{ path: "config.local.json", reason: "held-back" as const }],
        held: [{ path: "config.local.json", status: "modified" as const, reason: "env-file" as const }],
      }
      for (const mode of ["full", "incremental"] as const) {
        const held = fake({ ...outcome, mode })
        const result = yield* executeLocalReview(
          { directory: repo.dir, full: true, env: { REVIEW_HOLDBACK: "secrets" } },
          held.deps,
        )
        const what = mode === "full" ? "every changed file was" : "everything new since the last review is in files"
        expect({ mode, exitCode: result.exitCode, error: result.error }).toEqual({
          mode,
          exitCode: 2,
          error: `Vector did not review this change: ${what} held back from the model (holdback "secrets").`,
        })
        expect(result.outcome?.skipped).toContainEqual({ path: "config.local.json", reason: "held-back" })
        expect(held.out().split("\n")).toContain(`Not reviewed: ${what} held back from the model.`)
        expect(held.out()).not.toContain("Risk:")
        expect(held.out()).not.toContain("No issues found")
        expect(held.out()).toContain("Not reviewed: config.local.json (held back)")
        expect(yield* readState(repo.dir)).toBeUndefined()
      }
      // --json prints the outcome and fails the same way.
      const json = fake(outcome)
      const printed = yield* executeLocalReview(
        { directory: repo.dir, full: true, json: true, env: { REVIEW_HOLDBACK: "secrets" } },
        json.deps,
      )
      expect(printed.exitCode).toBe(2)
      expect(JSON.parse(json.out()).outcome.held).toEqual(outcome.held)
      // A review that ran records its state, so the check above looked in the right place.
      expect((yield* executeLocalReview({ directory: repo.dir, full: true, env: {} }, fake().deps)).exitCode).toBe(0)
      expect(yield* readState(repo.dir)).toBeString()
      // With nothing held, no reviewer is a failure, as before.
      const none = fake({ specialists: [], sessions: [] })
      const failed = yield* executeLocalReview({ directory: repo.dir, full: true, env: {} }, none.deps)
      expect(failed.exitCode).toBe(2)
      expect(failed.error).toContain("Vector could not finish this review")
    }),
  )
})
