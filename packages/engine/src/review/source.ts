// The git side of a review (sections 3.4, 3.5 and 3.11): fetching exactly the commits a review needs, the pull
// request's diff, the range to review, the pull request's own files, and whether a path exists. Every call is an
// argument array with external diff drivers and textconv off, so nothing a pull request puts in .gitattributes or
// git config runs a command.

import path from "path"
import { Effect, Option, Schema } from "effect"
import { Git } from "@/git"
import {
  focusHunks,
  focusOfFiles,
  mergeFocus,
  parseUnifiedDiff,
  patchIdOf,
  renderPatch,
  type DiffFile,
} from "@vectordevai/core/review/diff"
import type { HeadFile } from "@vectordevai/core/review/prompt"
import type { FocusHunk, ReviewState } from "@vectordevai/core/review/types"

// --no-relative and the prefixes keep paths repository-relative and parseable whatever the user's diff config says.
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"]
const MAX_DIFF_BYTES = 64 * 1024 * 1024
export const MAX_HEAD_FILE_BYTES = 40_000
const HEAD_FILE_CONTEXT = 20
const BASE_DEPTH = 50

export class ReviewGitError extends Schema.TaggedErrorClass<ReviewGitError>()("ReviewGitError", {
  message: Schema.String,
}) {}

// GitHub's compare API: `ahead` means `b` contains `a`.
export interface Compare {
  status: "ahead" | "behind" | "diverged" | "identical"
  mergeBase: string
}

export interface FetchInput {
  directory: string
  base: string // the base branch tip; fetched with 50 commits of history for `git log` and blame
  head: string
  since?: string // the last reviewed head
  old?: { mergeBase?: string; head: string } // the last review's range, for a force-push
  pr?: number // untrusted: the head comes from refs/pull/<pr>/head into FETCH_HEAD, never a named ref
  remote?: string
  token?: string // sent as an extra header through the environment, never on the command line
  server?: string // https://github.com unless GitHub Enterprise
  authEnvironment?: Record<string, string> // already repository-scoped by an authenticated Actions caller
}

export const ensureObjects = Effect.fn("ReviewSource.ensureObjects")(function* (input: FetchInput) {
  const git = yield* Git.Service
  const remote = input.remote ?? "origin"
  // With Vector Local on, Git.run decides each fetch by the URL git would use for the remote before git starts.
  const env = input.authEnvironment ?? (input.token ? authEnv(input.token, input.server) : undefined)
  const fetch = (depth: number, refs: string[]) =>
    git.run(["fetch", "--no-tags", "--no-recurse-submodules", `--depth=${depth}`, remote, ...refs], {
      cwd: input.directory,
      env,
    })
  const has = (sha: string) =>
    git.run(["cat-file", "-e", `${sha}^{commit}`], { cwd: input.directory }).pipe(Effect.map((r) => r.exitCode === 0))
  const revs = [input.base, input.head, input.since, input.old?.mergeBase, input.old?.head].filter(
    (value): value is string => !!value,
  )
  const unsafe = revs.find((value) => value.startsWith("-"))
  if (unsafe) return yield* new ReviewGitError({ message: `Refusing the revision ${unsafe}.` })

  const base = yield* fetch(BASE_DEPTH, [input.base])
  if (base.exitCode !== 0)
    return yield* new ReviewGitError({
      message: `Could not fetch the base commit ${short(input.base)}: ${stderr(base)}`,
    })

  const optional = [input.since, input.old?.mergeBase, input.old?.head].filter(
    (value): value is string => !!value && value !== input.head,
  )
  const head = yield* Effect.gen(function* () {
    if (input.pr !== undefined) {
      const pulled = yield* fetch(1, [`+refs/pull/${input.pr}/head`])
      const fetched = yield* git.run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: input.directory })
      if (pulled.exitCode !== 0 || fetched.exitCode !== 0)
        return yield* new ReviewGitError({ message: `Could not fetch pull request #${input.pr}: ${stderr(pulled)}` })
      return fetched.text().trim()
    }
    // One round trip when every commit is still there; after a force-push the old ones may not be.
    const all = yield* fetch(1, [input.head, ...optional])
    if (all.exitCode === 0) return input.head
    const alone = yield* fetch(1, [input.head])
    if (alone.exitCode !== 0)
      return yield* new ReviewGitError({
        message: `Could not fetch the head commit ${short(input.head)}: ${stderr(alone)}`,
      })
    return input.head
  })
  // Old commits of a fork, or ones a force-push orphaned, may be gone; the range falls back to a full review.
  yield* Effect.forEach(
    optional,
    (sha) => has(sha).pipe(Effect.flatMap((ok) => (ok ? Effect.void : fetch(1, [sha])))),
    {
      discard: true,
    },
  )
  return {
    head,
    since: input.since ? yield* has(input.since) : false,
    old: input.old
      ? (yield* has(input.old.head)) && (!input.old.mergeBase || (yield* has(input.old.mergeBase)))
      : false,
  }
})

// The commits of `revs` this repository does not have, without fetching anything. A replay (ReviewEval.replay)
// reviews only what is already there, so it never reaches a remote.
export const missingCommits = Effect.fn("ReviewSource.missingCommits")(function* (input: {
  directory: string
  revs: string[]
}) {
  const git = yield* Git.Service
  const missing = yield* Effect.forEach(input.revs, (rev) =>
    !rev || rev.startsWith("-")
      ? Effect.succeed([rev])
      : git
          .run(["cat-file", "-e", `${rev}^{commit}`], { cwd: input.directory })
          .pipe(Effect.map((result) => (result.exitCode === 0 ? [] : [rev]))),
  )
  return missing.flat()
})

// A file's text at a commit: undefined when it is not there, is binary, or the revision looks like an option.
export const show = Effect.fn("ReviewSource.show")(function* (input: { directory: string; rev: string; path: string }) {
  const git = yield* Git.Service
  if (input.rev.startsWith("-")) return undefined
  const result = yield* git.run(["cat-file", "blob", `${input.rev}:${input.path}`], { cwd: input.directory })
  return result.exitCode === 0 && !result.stdout.includes(0) ? result.text() : undefined
})

// The pull request's own diff: merge-base → head.
export const prDiff = Effect.fn("ReviewSource.prDiff")(function* (input: {
  directory: string
  mergeBase: string
  head: string
}) {
  return yield* diffFiles(yield* Git.Service, input.directory, input.mergeBase, input.head)
})

// Git's answer to the compare API, for local reviews and for tests.
export const localCompare = Effect.fn("ReviewSource.localCompare")(function* (directory: string) {
  const git = yield* Git.Service
  const resolve = (value: string) =>
    git
      .run(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], { cwd: directory })
      .pipe(Effect.map((r) => (r.exitCode === 0 ? r.text().trim() : undefined)))
  return (a: string, b: string) =>
    Effect.gen(function* () {
      const left = yield* resolve(a)
      const right = yield* resolve(b)
      if (!left || !right) return { status: "diverged", mergeBase: "" } satisfies Compare
      if (left === right) return { status: "identical", mergeBase: left } satisfies Compare
      const found = yield* git.run(["merge-base", left, right], { cwd: directory })
      const mergeBase = found.exitCode === 0 ? found.text().trim() : ""
      const status = mergeBase === left ? "ahead" : mergeBase === right ? "behind" : "diverged"
      return { status, mergeBase } satisfies Compare
    })
})

export interface RangeInput {
  directory: string
  head: string
  base: string // the base branch tip; the merge-base comes from compare(base, head)
  state?: Pick<ReviewState, "head" | "base" | "unreviewed"> // state.base is the merge-base that review diffed against
  full?: boolean // `/vector review full` or `--full`
  incremental?: boolean // config.incremental
  // GitHub's compare API in CI, which can refuse a commit a force-push orphaned; git itself locally.
  compare: (a: string, b: string) => Effect.Effect<Compare, ReviewGitError>
  ignored?: (path: string) => boolean // left out of the rebase comparison, as they are left out of review
}

export interface RangePlan {
  mode: "full" | "incremental" | "carry"
  reason: "requested" | "first" | "not-incremental" | "unreachable" | "ahead" | "rerun" | "rebased" | "rewritten"
  mergeBase: string
  files: DiffFile[] // the pull request's diff, merge-base → head
  since?: string
  focus?: FocusHunk[] // incremental only; full reviews focus on the whole diff
  forcePushed?: boolean
}

// Section 3.4: full, incremental over what changed since the last review, or carry when a force-push only rebased.
export const planRange = Effect.fn("ReviewSource.planRange")(function* (input: RangeInput) {
  const git = yield* Git.Service
  const mergeBase = (yield* input.compare(input.base, input.head)).mergeBase
  if (!mergeBase) return yield* new ReviewGitError({ message: `No merge-base for ${short(input.head)}.` })
  const files = yield* diffFiles(git, input.directory, mergeBase, input.head)
  const state = input.state
  const unreviewed = state?.unreviewed ?? []
  const plan = (value: Omit<RangePlan, "mergeBase" | "files">): RangePlan => ({ mergeBase, files, ...value })

  if (input.full) return plan({ mode: "full", reason: "requested" })
  if (!state?.head) return plan({ mode: "full", reason: "first" })
  if (input.incremental === false) return plan({ mode: "full", reason: "not-incremental" })
  const since = state.head
  if (since === input.head)
    return plan({ mode: "incremental", reason: "rerun", since, focus: focusOfFiles(files, unreviewed) })

  // An old head GitHub cannot compare (gone after a force-push, or in unrelated history) means a full review, as when
  // git cannot find it.
  const found = yield* input.compare(since, input.head).pipe(Effect.option)
  if (Option.isNone(found)) return plan({ mode: "full", reason: "unreachable", forcePushed: true })
  const compared = found.value
  if (compared.status === "identical")
    return plan({ mode: "incremental", reason: "rerun", since, focus: focusOfFiles(files, unreviewed) })
  const present = (sha: string) =>
    git.run(["cat-file", "-e", `${sha}^{commit}`], { cwd: input.directory }).pipe(Effect.map((r) => r.exitCode === 0))
  if (compared.status === "ahead") {
    if (!(yield* present(since))) return plan({ mode: "full", reason: "unreachable" })
    const changed = yield* diffFiles(git, input.directory, since, input.head)
    return plan({
      mode: "incremental",
      reason: "ahead",
      since,
      focus: mergeFocus(focusHunks(files, changed), focusOfFiles(files, unreviewed)),
    })
  }

  // History was rewritten. Compare each file's own change before and after; identical everywhere means a rebase.
  if (!state.base || !(yield* present(since)) || !(yield* present(state.base)))
    return plan({ mode: "full", reason: "unreachable", forcePushed: true })
  const before = new Map(
    (yield* diffFiles(git, input.directory, state.base, since)).map((file) => [file.path, patchIdOf(file)]),
  )
  const changed = files
    .filter((file) => !input.ignored?.(file.path) && before.get(file.path) !== patchIdOf(file))
    .map((file) => file.path)
  if (!changed.length) return plan({ mode: "carry", reason: "rebased", since, forcePushed: true })
  return plan({
    mode: "incremental",
    reason: "rewritten",
    since,
    forcePushed: true,
    focus: focusOfFiles(files, [...changed, ...unreviewed]),
  })
})

// The pull request's version of each changed file, for untrusted reviews where the working tree is the base.
// Files up to 40 KB are sent whole; larger ones as their hunks with 20 lines of context.
export const headFiles = Effect.fn("ReviewSource.headFiles")(function* (input: {
  directory: string
  mergeBase: string
  head: string
  files: DiffFile[]
  maxBytes?: number
}) {
  const git = yield* Git.Service
  const max = input.maxBytes ?? MAX_HEAD_FILE_BYTES
  const read = Effect.fnUntraced(function* (file: DiffFile) {
    const object = `${input.head}:${file.path}`
    const size = yield* git.run(["cat-file", "-s", object], { cwd: input.directory })
    if (size.exitCode !== 0) return []
    if (Number(size.text().trim()) <= max) {
      const blob = yield* git.run(["cat-file", "blob", object], { cwd: input.directory })
      if (blob.exitCode !== 0 || blob.stdout.includes(0)) return []
      return [{ path: file.path, text: blob.text(), exact: true } satisfies HeadFile]
    }
    const hunks = yield* diffFiles(
      git,
      input.directory,
      input.mergeBase,
      input.head,
      [file.oldPath, file.path].filter((value): value is string => !!value),
      HEAD_FILE_CONTEXT,
    ).pipe(Effect.catch(() => Effect.succeed([] as DiffFile[])))
    return hunks.length ? [{ path: file.path, text: renderPatch(hunks), exact: false } satisfies HeadFile] : []
  })
  if (input.head.startsWith("-")) return yield* new ReviewGitError({ message: `Refusing the revision ${input.head}.` })
  return (yield* Effect.forEach(
    input.files.filter((file) => file.status !== "deleted" && !file.binary),
    read,
    { concurrency: 4 },
  )).flat()
})

// Whether a path a finding names exists at `rev`. Findings on paths that are neither in the diff nor in the
// repository are dropped.
export const knownPath = Effect.fn("ReviewSource.knownPath")(function* (input: { directory: string; rev: string }) {
  const git = yield* Git.Service
  const cache = new Map<string, Promise<boolean>>()
  return (file: string) => {
    const relative = path.isAbsolute(file) ? path.relative(input.directory, file) : file.replace(/^(\.\/)+/, "")
    if (!relative || relative.startsWith("..") || input.rev.startsWith("-")) return Promise.resolve(false)
    const cached = cache.get(relative)
    if (cached) return cached
    // `rev:./path` is relative to the working directory, which is where the reviewer's paths start.
    const found = Effect.runPromise(
      git
        .run(["cat-file", "-e", `${input.rev}:./${relative}`], { cwd: input.directory })
        .pipe(Effect.map((r) => r.exitCode === 0)),
    )
    cache.set(relative, found)
    return found
  }
})

const diffFiles = Effect.fnUntraced(function* (
  git: Git.Interface,
  directory: string,
  from: string,
  to: string,
  paths: string[] = [],
  context = 3,
) {
  if (from.startsWith("-") || to.startsWith("-"))
    return yield* new ReviewGitError({ message: `Refusing the range ${from}..${to}.` })
  const result = yield* git.run(
    ["diff", ...DIFF, "--find-renames", `--unified=${context}`, from, to, ...(paths.length ? ["--", ...paths] : [])],
    { cwd: directory, maxOutputBytes: MAX_DIFF_BYTES },
  )
  if (result.exitCode !== 0)
    return yield* new ReviewGitError({ message: `git diff ${short(from)} ${short(to)} failed: ${stderr(result)}` })
  if (result.truncated)
    return yield* new ReviewGitError({ message: `The diff of ${short(from)}..${short(to)} is over 64 MB.` })
  return parseUnifiedDiff(result.text())
})

function authEnv(token: string, server = "https://github.com") {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${server.replace(/\/+$/, "")}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  }
}

function short(sha: string) {
  return sha.slice(0, 7)
}

function stderr(result: Git.Result) {
  return result.stderr.toString("utf8").trim().split("\n").slice(-3).join(" ") || `exit ${result.exitCode}`
}

export * as ReviewSource from "./source"
