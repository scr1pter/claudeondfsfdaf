import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { classifyFiles } from "@vectordevai/core/review/ignore"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { Git } from "../../src/git"
import { ReviewSource } from "../../src/review/source"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
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

const commit = (cwd: string, message: string, files: Record<string, string> = {}) =>
  Effect.gen(function* () {
    yield* write(cwd, files)
    yield* git(cwd, "add", "-A")
    yield* git(cwd, "commit", "-q", "-m", message)
    return yield* git(cwd, "rev-parse", "HEAD")
  })

const lines = (count: number, label: string) =>
  Array.from({ length: count }, (_, index) => `const ${label}${index + 1} = ${index + 1}`).join("\n") + "\n"

const edit = (text: string, line: number, replacement: string) =>
  text
    .split("\n")
    .map((value, index) => (index === line - 1 ? replacement : value))
    .join("\n")

const A = lines(30, "a")
const B = lines(30, "b")

// A repository with `main` and a `feature` branch that changed a.ts.
const branched = Effect.gen(function* () {
  const tmp = yield* scopedTmpdir({ git: true })
  const dir = tmp.path
  yield* git(dir, "branch", "-M", "main")
  yield* commit(dir, "base", { "a.ts": A, "b.ts": B })
  yield* git(dir, "checkout", "-q", "-b", "feature")
  const first = yield* commit(dir, "feature change", { "a.ts": edit(A, 10, "const a10 = 100") })
  const compare = yield* ReviewSource.localCompare(dir)
  return { dir, first, compare }
})

describe("ReviewSource.prDiff", () => {
  it.live("is the merge-base diff and keeps renames", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const dir = tmp.path
      yield* git(dir, "branch", "-M", "main")
      yield* commit(dir, "base", { "a.ts": A, "old.ts": B })
      yield* git(dir, "checkout", "-q", "-b", "feature")
      yield* git(dir, "mv", "old.ts", "new.ts")
      const head = yield* commit(dir, "feature", {
        "a.ts": edit(A, 3, "const a3 = 33"),
        "new.ts": edit(B, 2, "const b2 = 22"),
      })
      yield* git(dir, "checkout", "-q", "main")
      const main = yield* commit(dir, "main moves on", { "c.ts": "export const c = 1\n" })
      const mergeBase = yield* git(dir, "merge-base", main, head)

      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase, head })

      expect(files.map((file) => file.path).toSorted()).toEqual(["a.ts", "new.ts"])
      const renamed = files.find((file) => file.path === "new.ts")
      expect(renamed?.status).toBe("renamed")
      expect(renamed?.oldPath).toBe("old.ts")
      expect(
        files.find((file) => file.path === "a.ts")?.hunks[0]?.lines.some((line) => line.text === "const a3 = 33"),
      ).toBe(true)
    }),
  )

  it.live("classifies lockfiles and build output as skipped", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const dir = tmp.path
      const base = yield* commit(dir, "base", { "src/x.ts": A })
      const head = yield* commit(dir, "feature", {
        "src/x.ts": edit(A, 1, "const a1 = 11"),
        "bun.lock": "{}\n",
        "dist/app.js": "console.log(1)\n",
        "src/build/tool.ts": "export const tool = 1\n",
      })

      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const classified = classifyFiles(files, { config: DEFAULT_REVIEW_CONFIG })

      expect(classified.review.map((file) => file.path).toSorted()).toEqual(["src/build/tool.ts", "src/x.ts"])
      expect(classified.skipped).toContainEqual({ path: "bun.lock", reason: "lockfile" })
      expect(classified.skipped.find((file) => file.path === "dist/app.js")?.reason).toBe("build-output")
    }),
  )

  it.live("never runs a diff driver or textconv from .gitattributes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const dir = tmp.path
      const markers = {
        command: path.join(dir, "..", `${path.basename(dir)}-command`),
        textconv: path.join(dir, "..", `${path.basename(dir)}-textconv`),
      }
      yield* git(dir, "config", "diff.evil.command", `touch '${markers.command}'; true`)
      yield* git(dir, "config", "diff.evil.textconv", `touch '${markers.textconv}'; cat`)
      const base = yield* commit(dir, "base", { ".gitattributes": "*.txt diff=evil\n", "notes.txt": "one\n" })
      const head = yield* commit(dir, "feature", { "notes.txt": "two\n" })

      const files = yield* ReviewSource.prDiff({ directory: dir, mergeBase: base, head })
      const known = yield* ReviewSource.knownPath({ directory: dir, rev: head })
      expect(yield* Effect.promise(() => known("notes.txt"))).toBe(true)
      yield* ReviewSource.headFiles({ directory: dir, mergeBase: base, head, files })

      expect(files[0]?.hunks[0]?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual(["del:one", "add:two"])
      expect(yield* Effect.promise(() => Bun.file(markers.command).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(markers.textconv).exists())).toBe(false)
    }),
  )
})

describe("ReviewSource.planRange", () => {
  it.live("reviews a first run in full", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head: repo.first,
        base: "main",
        compare: repo.compare,
      })
      expect(plan.mode).toBe("full")
      expect(plan.reason).toBe("first")
      expect(plan.files.map((file) => file.path)).toEqual(["a.ts"])
    }),
  )

  it.live("reviews new commits incrementally when the head moved ahead", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      const head = yield* commit(repo.dir, "more", {
        "a.ts": edit(edit(A, 10, "const a10 = 100"), 25, "const a25 = 250"),
      })

      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head,
        base: "main",
        state: { head: repo.first, base: mergeBase, unreviewed: [] },
        compare: repo.compare,
      })

      expect(plan.mode).toBe("incremental")
      expect(plan.since).toBe(repo.first)
      // The pull request's hunk around line 25 (22–28 with its context), padded by 3; the one at line 10 is old.
      expect(plan.focus).toEqual([{ path: "a.ts", start: 19, end: 31 }])
    }),
  )

  it.live("leaves out what a merge of main brought in", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      yield* git(repo.dir, "checkout", "-q", "main")
      yield* commit(repo.dir, "main edits b", { "b.ts": edit(B, 5, "const b5 = 55") })
      yield* git(repo.dir, "checkout", "-q", "feature")
      yield* git(repo.dir, "merge", "-q", "--no-edit", "main")
      const head = yield* commit(repo.dir, "after merge", {
        "a.ts": edit(edit(A, 10, "const a10 = 100"), 20, "const a20 = 200"),
      })

      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head,
        base: "main",
        state: { head: repo.first, base: mergeBase, unreviewed: [] },
        compare: repo.compare,
      })

      expect(plan.mode).toBe("incremental")
      expect(plan.files.map((file) => file.path)).toEqual(["a.ts"])
      expect(plan.focus?.map((hunk) => hunk.path)).toEqual(["a.ts"])
      expect(plan.focus?.some((hunk) => hunk.start <= 20 && hunk.end >= 20)).toBe(true)
    }),
  )

  it.live("carries the state forward when a force-push only rebased", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      yield* git(repo.dir, "checkout", "-q", "main")
      yield* commit(repo.dir, "main edits b", { "b.ts": edit(B, 5, "const b5 = 55") })
      yield* git(repo.dir, "checkout", "-q", "feature")
      yield* git(repo.dir, "rebase", "-q", "main")
      const head = yield* git(repo.dir, "rev-parse", "HEAD")

      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head,
        base: "main",
        state: { head: repo.first, base: mergeBase, unreviewed: [] },
        compare: repo.compare,
      })

      expect(head).not.toBe(repo.first)
      expect(plan.mode).toBe("carry")
      expect(plan.forcePushed).toBe(true)
    }),
  )

  it.live("focuses on the file whose change differs after a rewrite", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const dir = tmp.path
      yield* git(dir, "branch", "-M", "main")
      yield* commit(dir, "base", { "a.ts": A, "b.ts": B })
      yield* git(dir, "checkout", "-q", "-b", "feature")
      const first = yield* commit(dir, "feature", {
        "a.ts": edit(A, 10, "const a10 = 100"),
        "b.ts": edit(B, 10, "const b10 = 100"),
      })
      const mergeBase = yield* git(dir, "merge-base", "main", first)
      yield* write(dir, { "b.ts": edit(B, 10, "const b10 = 101") })
      yield* git(dir, "commit", "-q", "-a", "--amend", "--no-edit")
      const head = yield* git(dir, "rev-parse", "HEAD")
      const compare = yield* ReviewSource.localCompare(dir)

      const plan = yield* ReviewSource.planRange({
        directory: dir,
        head,
        base: "main",
        state: { head: first, base: mergeBase, unreviewed: [] },
        compare,
      })

      expect(plan.mode).toBe("incremental")
      expect(plan.forcePushed).toBe(true)
      expect(plan.focus?.map((hunk) => hunk.path)).toEqual(["b.ts"])
    }),
  )

  it.live("falls back to a full review when the old head is gone", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head: repo.first,
        base: "main",
        state: { head: "0123456789abcdef0123456789abcdef01234567", base: mergeBase, unreviewed: [] },
        compare: repo.compare,
      })
      expect(plan.mode).toBe("full")
      expect(plan.reason).toBe("unreachable")
    }),
  )

  it.live("falls back to a full review when GitHub cannot compare the old head", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      const head = yield* commit(repo.dir, "more", {
        "a.ts": edit(edit(A, 10, "const a10 = 100"), 25, "const a25 = 250"),
      })
      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head,
        base: "main",
        state: { head: repo.first, base: mergeBase, unreviewed: [] },
        // GitHub answers 404 for a compare from an old head it no longer has.
        compare: (a, b) =>
          a === repo.first
            ? Effect.fail(new ReviewSource.ReviewGitError({ message: "fault 404" }))
            : repo.compare(a, b),
      })
      expect(plan.mode).toBe("full")
      expect(plan.reason).toBe("unreachable")
      expect(plan.forcePushed).toBe(true)
    }),
  )

  it.live("adds the files a partial run left to a re-run of the same commit", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const mergeBase = yield* git(repo.dir, "merge-base", "main", repo.first)
      const plan = yield* ReviewSource.planRange({
        directory: repo.dir,
        head: repo.first,
        base: "main",
        state: { head: repo.first, base: mergeBase, unreviewed: ["a.ts"] },
        compare: repo.compare,
      })
      expect(plan.mode).toBe("incremental")
      expect(plan.reason).toBe("rerun")
      expect(plan.focus?.map((hunk) => hunk.path)).toEqual(["a.ts"])
    }),
  )
})

describe("ReviewSource untrusted fetch", () => {
  it.live("reads the pull request's files from FETCH_HEAD and leaves the checkout and refs alone", () =>
    Effect.gen(function* () {
      const origin = (yield* scopedTmpdir({ git: true })).path
      yield* git(origin, "branch", "-M", "main")
      yield* git(origin, "config", "uploadpack.allowAnySHA1InWant", "true")
      const base = yield* commit(origin, "base", { "src/list.ts": A, "src/big.ts": lines(400, "big") })
      yield* git(origin, "checkout", "-q", "-b", "fork")
      const head = yield* commit(origin, "fork change", {
        "src/list.ts": edit(A, 2, "const a2 = 22"),
        "src/big.ts": edit(lines(400, "big"), 200, "const big200 = 2000"),
      })
      yield* git(origin, "update-ref", "refs/pull/7/head", head)
      yield* git(origin, "checkout", "-q", "main")
      yield* git(origin, "branch", "-q", "-D", "fork")

      const work = (yield* scopedTmpdir()).path
      // Preserve the fixture's exact worktree bytes even when the host enables CRLF checkout.
      yield* git(work, "clone", "-q", "-c", "core.autocrlf=false", `file://${origin}`, ".")
      const refsBefore = yield* git(work, "for-each-ref", "--format=%(refname)")

      const fetched = yield* ReviewSource.ensureObjects({ directory: work, base, head, pr: 7 })
      const files = yield* ReviewSource.prDiff({ directory: work, mergeBase: base, head: fetched.head })
      const read = yield* ReviewSource.headFiles({
        directory: work,
        mergeBase: base,
        head: fetched.head,
        files,
        maxBytes: 4_000,
      })

      expect(fetched.head).toBe(head)
      expect(read.find((file) => file.path === "src/list.ts")).toEqual({
        path: "src/list.ts",
        text: edit(A, 2, "const a2 = 22"),
        exact: true,
      })
      const big = read.find((file) => file.path === "src/big.ts")
      expect(big?.exact).toBe(false)
      expect(big?.text).toContain("+const big200 = 2000")
      expect(big?.text).toContain(" const big180 = 180")
      expect(big?.text).not.toContain("const big1 = 1\n")
      expect(yield* git(work, "rev-parse", "HEAD")).toBe(base)
      expect(yield* git(work, "status", "--porcelain")).toBe("")
      expect(yield* Effect.promise(() => Bun.file(path.join(work, "src/list.ts")).text())).toBe(A)
      expect(yield* git(work, "for-each-ref", "refs/vector")).toBe("")
      expect(yield* git(work, "for-each-ref", "--format=%(refname)")).toBe(refsBefore)
    }),
  )

  it.live("reports an old head it could not fetch", () =>
    Effect.gen(function* () {
      const origin = (yield* scopedTmpdir({ git: true })).path
      yield* git(origin, "branch", "-M", "main")
      const base = yield* commit(origin, "base", { "a.ts": A })
      const head = yield* commit(origin, "change", { "a.ts": edit(A, 1, "const a1 = 11") })
      const work = (yield* scopedTmpdir()).path
      yield* git(work, "clone", "-q", `file://${origin}`, ".")

      const fetched = yield* ReviewSource.ensureObjects({
        directory: work,
        base,
        head,
        since: "0123456789abcdef0123456789abcdef01234567",
      })

      expect(fetched.head).toBe(head)
      expect(fetched.since).toBe(false)
    }),
  )

  it.live("refuses a revision that looks like an option", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const exit = yield* ReviewSource.ensureObjects({
        directory: repo.dir,
        base: "--upload-pack=touch x",
        head: repo.first,
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("ReviewSource.knownPath", () => {
  it.live("finds paths at the revision, relative or absolute, and nothing outside the repository", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const known = yield* ReviewSource.knownPath({ directory: repo.dir, rev: repo.first })
      expect(yield* Effect.promise(() => known("a.ts"))).toBe(true)
      expect(yield* Effect.promise(() => known("./b.ts"))).toBe(true)
      expect(yield* Effect.promise(() => known(path.join(repo.dir, "a.ts")))).toBe(true)
      expect(yield* Effect.promise(() => known("missing.ts"))).toBe(false)
      expect(yield* Effect.promise(() => known("../outside.ts"))).toBe(false)
    }),
  )
})

describe("ReviewSource replay reads", () => {
  it.live("names the commits a checkout lacks without fetching, and reads text files at a commit", () =>
    Effect.gen(function* () {
      const repo = yield* branched
      const absent = "f".repeat(40)
      expect(yield* ReviewSource.missingCommits({ directory: repo.dir, revs: [repo.first, absent, "--all"] })).toEqual([
        absent,
        "--all",
      ])
      expect(yield* ReviewSource.show({ directory: repo.dir, rev: repo.first, path: "a.ts" })).toBe(
        edit(A, 10, "const a10 = 100"),
      )
      expect(yield* ReviewSource.show({ directory: repo.dir, rev: repo.first, path: "missing.ts" })).toBeUndefined()
      expect(yield* ReviewSource.show({ directory: repo.dir, rev: "--output=x", path: "a.ts" })).toBeUndefined()
      yield* write(repo.dir, { "blob.bin": "a\u0000b" })
      const binary = yield* commit(repo.dir, "binary")
      expect(yield* ReviewSource.show({ directory: repo.dir, rev: binary, path: "blob.bin" })).toBeUndefined()
    }),
  )
})
