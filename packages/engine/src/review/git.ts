// The bound local review's one private Git view. Ordinary CLI/network operations
// retain their existing Git service; a bound collector never falls back to it.

import path from "node:path"
import { Context, Effect, Schema } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"

export type Client = Pick<Git.Interface, "run" | "branch" | "defaultBranch">
export interface View {
  readonly repository: ReadOnlyGit.Repository
  readonly metadata: ReadOnlyGit.Metadata
  readonly client: Client
  readonly preflight: () => Effect.Effect<void, Refused>
}
export const Current = Context.Reference<View | undefined>("@vector/ReviewGit.Current", {
  defaultValue: () => undefined,
})

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewGit.Refused", {
  message: Schema.String,
}) {}

const refused = (error: unknown) =>
  new Refused({
    message:
      error instanceof ReadOnlyGit.Unavailable ? error.message : "The local review's private Git view is unavailable.",
  })

export const metadata = (worktree: string) =>
  Effect.tryPromise({ try: () => ReadOnlyGit.metadataHead(worktree), catch: refused })

// readRoot is a permission origin and can name another checkout. Only actual
// trusted placement, or an exact standalone root, chooses the collection view.
export const root = Effect.fn("ReviewGit.root")(function* (directory: string) {
  const instance = yield* InstanceRef
  const worktree = instance?.worktree
  const found =
    worktree && FSUtil.contains(FSUtil.realpath(worktree), FSUtil.realpath(directory)) ? worktree : directory
  return FSUtil.realpath(found)
})

export const client = Effect.gen(function* () {
  const current = yield* Current
  return current?.client ?? (yield* Git.Service)
})

export const preflight = Effect.gen(function* () {
  const current = yield* Current
  if (current) yield* current.preflight()
})

// VS-34 item 4: which of a review's changed paths the repository's ignore rules exclude although they are committed,
// from `git check-ignore --no-index` in the work tree: its .gitignore files and info/exclude, never the user's global
// excludes (the bound view's are /dev/null, and the fallback's are set to it). A collector asks only under
// `holdback: "secrets"`, before its last preflight, so the bound view's read is checked like the others. Undefined
// when it cannot tell, and the review then notes that it could not check: a path the read-only port would refuse
// (asking would poison the view), an exit other than 0 or 1, truncated output, or an echoed line that is not a path
// asked about. Git exits 128 for the whole call when one path lies below a work-tree symbolic link or inside a
// submodule, so one such path leaves every batch's answer unknown; a retry path by path is not made, as it could run
// a thousand reads against the bound view's execution bound. In the bound view a read the port refuses, or one past
// its execution bound, does not give undefined quietly: it poisons the view, and the collector's last preflight then
// refuses the review. Each call takes at most 1024 paths (the view's bound) and about 8,000 characters of them, well
// under Windows' 32,767-character command line.
export const ignoredPaths = Effect.fn("ReviewGit.ignoredPaths")(function* (
  directory: string,
  paths: readonly string[],
) {
  if (!paths.length) return []
  if (!paths.every(ReadOnlyGit.repositoryPath)) return undefined
  const current = yield* Current
  const git = current?.client ?? (yield* Git.Service)
  const results = yield* Effect.forEach(batches(paths), (batch) =>
    git.run(
      [
        ...(current ? [] : ["-c", "core.excludesFile=/dev/null"]),
        "check-ignore",
        "--no-index",
        "--",
        ...batch.map((file) => "./" + file),
      ],
      { cwd: directory, maxOutputBytes: 1024 * 1024 },
    ),
  )
  if (results.some((result) => (result.exitCode !== 0 && result.exitCode !== 1) || result.truncated)) return undefined
  const echoed = results.flatMap((result) => (result.exitCode === 0 ? echoedPaths(result.text()) : []))
  const given = new Set(paths.map((file) => "./" + file))
  // Git echoes each path as it was given; anything else means this read misparsed it, so nothing is claimed.
  if (echoed.some((line) => !given.has(line))) return undefined
  const ignored = new Set(echoed)
  return paths.filter((file) => ignored.has("./" + file))
})

function batches(paths: readonly string[]) {
  const out: { files: string[]; chars: number }[] = []
  for (const file of paths) {
    const last = out.at(-1)
    const chars = file.length + 3
    if (last && last.files.length < 1024 && last.chars + chars <= 8_000) {
      last.files.push(file)
      last.chars += chars
      continue
    }
    out.push({ files: [file], chars })
  }
  return out.map((batch) => batch.files)
}

// check-ignore's answer: one line per ignored path, as it was given, C-quoted when git quotes it. Exported so the
// bound view's form (the port's default core.quotepath writes a non-ASCII name as octal bytes) is tested on any host;
// the fallback's core.quotepath=false writes it raw.
export function echoedPaths(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => unquote(line.replace(/\r$/, "")))
}

// Git's C-style quoting of a path (quote.c): a name with a double quote, a backslash, a control character or, under
// core.quotepath, a non-ASCII byte is written in double quotes with backslash escapes and octal bytes.
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }
function unquote(line: string) {
  if (!(line.length >= 2 && line.startsWith('"') && line.endsWith('"'))) return line
  const bytes: number[] = []
  // By code point: under core.quotepath=false (the fallback's) a quoted name keeps its non-ASCII characters as text.
  const chars = Array.from(line.slice(1, -1))
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"))
      continue
    }
    const octal = /^[0-3][0-7]{2}$/.exec(chars.slice(index + 1, index + 4).join(""))?.[0]
    if (octal) {
      bytes.push(parseInt(octal, 8))
      index += 3
      continue
    }
    const next = chars[index + 1] ?? ""
    // An escape git never writes reads as itself, so the path cannot match one asked about.
    bytes.push(ESCAPES[next] ?? 92)
    if (Object.hasOwn(ESCAPES, next)) index++
  }
  return Buffer.from(bytes).toString("utf8")
}

export function within<A, E, R>(placement: ReadOnlyGit.Metadata, expectedHead: string, body: Effect.Effect<A, E, R>) {
  const admitted = { ...placement }
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const current = await ReadOnlyGit.metadataHead(admitted.directory)
        if (!sameBinding(current, admitted) || current.head !== expectedHead)
          throw new ReadOnlyGit.Unavailable("the review's Git binding or HEAD changed")
        const repository = await ReadOnlyGit.open(admitted)
        if (repository.head !== expectedHead) {
          await repository.close()
          throw new ReadOnlyGit.Unavailable("the review's HEAD changed before collection")
        }
        return { repository, metadata: admitted, ...adapter(repository, admitted) } satisfies View
      },
      catch: refused,
    }),
    (view) => body.pipe(Effect.provideService(Current, view)),
    (view) => Effect.promise(() => view.repository.close()),
  )
}

export function sameBinding(left: ReadOnlyGit.Input, right: ReadOnlyGit.Input) {
  return (
    left.directory === right.directory &&
    left.gitDirectory === right.gitDirectory &&
    left.commonDirectory === right.commonDirectory &&
    (right.commonIdentity === undefined ||
      (left.commonIdentity !== undefined &&
        left.commonIdentity.dev === right.commonIdentity.dev &&
        left.commonIdentity.ino === right.commonIdentity.ino &&
        left.commonIdentity.birth === right.commonIdentity.birth))
  )
}

function adapter(
  repository: ReadOnlyGit.Repository,
  admitted: ReadOnlyGit.Metadata,
): Pick<View, "client" | "preflight"> {
  let unavailable: Refused | undefined
  const result = (code: number, stdout: Buffer, truncated = false): Git.Result => ({
    exitCode: code,
    stdout,
    stderr: Buffer.alloc(0),
    truncated,
    text: () => stdout.toString("utf8"),
  })
  const failure = (error: unknown): Git.Result => {
    unavailable ??= refused(error)
    return { ...result(128, Buffer.alloc(0)), stderr: Buffer.from(unavailable.message) }
  }
  const placed = (cwd: string) =>
    FSUtil.contains(repository.directory, FSUtil.realpath(cwd)) && path.isAbsolute(cwd) && !cwd.includes("\0")
  const run: Client["run"] = (args, options) =>
    Effect.tryPromise({
      try: async () => {
        if (!placed(options.cwd) || options.env || options.stdin)
          throw new ReadOnlyGit.Unavailable("the review attempted unsupported Git authority")
        if (args.join("\0") === "rev-parse\0--show-toplevel") return result(0, Buffer.from(repository.directory + "\n"))
        if (["rev-parse\0--git-dir", "rev-parse\0--absolute-git-dir"].includes(args.join("\0")))
          return result(0, Buffer.from(admitted.gitDirectory + "\n"))
        if (args.join("\0") === "rev-parse\0--is-shallow-repository")
          return result(0, Buffer.from(String(repository.shallow) + "\n"))
        const operation = readOperation(args)
        if (!operation) throw new ReadOnlyGit.Unavailable("the review attempted an unsupported Git read")
        if (operation.kind === "resolve" && operation.revision === "HEAD") {
          const current = await ReadOnlyGit.metadataHead(repository.directory)
          if (!sameBinding(current, admitted) || current.head !== repository.head)
            throw new ReadOnlyGit.Unavailable("the review's HEAD or Git binding changed before admission")
          await repository.status()
        }
        const read = await repository.read(operation)
        const limit = options.maxOutputBytes ?? 64 * 1024 * 1024
        if (!Number.isSafeInteger(limit) || limit <= 0)
          throw new ReadOnlyGit.Unavailable("the review's Git output bound is unsupported")
        return result(read.code, read.bytes.subarray(0, limit), read.bytes.byteLength > limit)
      },
      catch: failure,
    }).pipe(Effect.catch(Effect.succeed))
  return {
    client: {
      run,
      branch: (cwd) => Effect.succeed(placed(cwd) ? repository.branch : undefined),
      defaultBranch: () =>
        Effect.sync(() => {
          failure(new ReadOnlyGit.Unavailable("a bound review must name its exact base"))
          return undefined
        }),
    },
    preflight: () =>
      Effect.gen(function* () {
        if (unavailable) return yield* unavailable
        yield* Effect.tryPromise({
          try: async () => {
            const current = await ReadOnlyGit.metadataHead(repository.directory)
            if (!sameBinding(current, admitted) || current.head !== repository.head)
              throw new ReadOnlyGit.Unavailable("the review's HEAD or Git binding changed before admission")
            await repository.status()
          },
          catch: refused,
        })
      }),
  }
}

// This parser admits only the fixed collector grammar. It never forwards argv,
// refs, config, environment or stdin to the underlying Git executable.
function readOperation(args: readonly string[]): ReadOnlyGit.Read | undefined {
  const joined = args.join("\0")
  if (args[0] === "rev-parse" && args.length === 4 && args[1] === "--verify" && args[2] === "--end-of-options") {
    const revision = args[3]?.match(/^([0-9a-f]{40})\^\{commit\}$/)?.[1]
    return revision ? { kind: "resolve", revision } : undefined
  }
  if (
    args[0] === "rev-parse" &&
    args.length === 5 &&
    args.slice(1, 4).join("\0") === "--verify\0--quiet\0--end-of-options"
  ) {
    const revision = args[4]?.match(/^(HEAD|[0-9a-f]{40})\^\{commit\}$/)?.[1]
    return revision ? { kind: "resolve", revision } : undefined
  }
  if (args[0] === "cat-file" && args.length === 3) {
    const object = args[2]!
    const commit = object.match(/^([0-9a-f]{40}|HEAD)\^\{commit\}$/)?.[1]
    if (args[1] === "-e" && commit) return { kind: "object", revision: commit, action: "commit-exists" }
    const blob = /^([0-9a-f]{40}|HEAD|):(.*)$/.exec(object)
    const action = args[1] === "blob" ? "blob" : args[1] === "-s" ? "size" : args[1] === "-e" ? "exists" : undefined
    if (blob && action)
      return { kind: "object", revision: blob[1] || "index", file: blob[2]!.replace(/^\.\//, ""), action }
  }
  if (args[0] === "merge-base" && args.length === 3) return { kind: "merge-base", left: args[1]!, right: args[2]! }
  if (joined === "ls-files\0--others\0--exclude-standard\0-z") return { kind: "untracked" }
  if (args[0] === "status" && args.length === 4 && args[1] === "--porcelain" && args[3] === "--no-renames") {
    const untracked =
      args[2] === "--untracked-files=normal" ? "normal" : args[2] === "--untracked-files=no" ? "no" : undefined
    return untracked ? { kind: "status", untracked } : undefined
  }
  const diff = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"]
  if (args[0] === "diff" && args[1] === "--no-index" && args.slice(2, 8).join("\0") === diff.join("\0"))
    return args.length === 12 && args[8] === "--unified=3" && args[9] === "--" && args[10] === "/dev/null"
      ? { kind: "added-diff", file: args[11]! }
      : undefined
  if (args[0] === "diff" && args.slice(1, 7).join("\0") === diff.join("\0") && args[7] === "--find-renames") {
    const context = args[8]?.match(/^--unified=(\d+)$/)?.[1]
    if (context === undefined) return undefined
    const cached = args[9] === "--cached"
    const tail = args.slice(cached ? 10 : 9)
    const separator = tail.indexOf("--")
    const revisions = separator === -1 ? tail : tail.slice(0, separator)
    if (revisions.length < 1 || revisions.length > (cached ? 1 : 2)) return undefined
    return {
      kind: "diff",
      from: revisions[0]!,
      ...(revisions[1] ? { to: revisions[1] } : {}),
      ...(cached ? { cached: true } : {}),
      context: Number(context),
      ...(separator === -1 ? {} : { files: tail.slice(separator + 1) }),
    }
  }
  if (
    args[0] === "grep" &&
    args.slice(1, 9).join("\0") === "-n\0-w\0-F\0-I\0--no-color\0--full-name\0-z\0-e" &&
    args[11] === "--" &&
    args[12] === "."
  ) {
    const excludes = args.slice(13)
    if (excludes.some((value) => !value.startsWith(":(exclude,glob)"))) return undefined
    return { kind: "grep", symbol: args[9]!, revision: args[10]!, excludes: excludes.map((value) => value.slice(15)) }
  }
  if (args[0] === "rev-list" && args[1] === "--max-parents=0" && args.length === 3)
    return { kind: "roots", revision: args[2]! }
  // VS-34 item 4 (ignoredPaths): one to 1024 work-tree paths, each written "./<path>". Every other check-ignore form
  // (--stdin, -z, -v, without --no-index) is refused.
  if (args[0] === "check-ignore" && args[1] === "--no-index" && args[2] === "--") {
    const paths = args.slice(3)
    return paths.length > 0 && paths.length <= 1024 && paths.every((value) => value.startsWith("./"))
      ? { kind: "check-ignore", files: paths.map((value) => value.slice(2)) }
      : undefined
  }
  if (
    args[0] === "log" &&
    args.slice(1, 6).join("\0") === ["-n", "5", "--no-color", "--date=short", "--format=%h %an %ad %s"].join("\0") &&
    args[7] === "--" &&
    args.length === 9
  )
    return { kind: "history", revision: args[6]!, file: args[8]! }
  if (
    args[0] === "log" &&
    args.slice(1, 5).join("\0") === ["--no-color", "-n", "50", "--format=%s"].join("\0") &&
    args.length === 6
  ) {
    const range = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(args[5]!)
    return range ? { kind: "subjects", from: range[1]!, to: range[2]! } : undefined
  }
  if (
    args[0] === "blame" &&
    args.slice(1, 5).join("\0") === "--porcelain\0--root\0--no-textconv\0-L" &&
    args[7] === "--" &&
    args.length === 9
  ) {
    const range = /^(\d+),(\d+)$/.exec(args[5]!)
    return range
      ? { kind: "blame", first: Number(range[1]), last: Number(range[2]), revision: args[6]!, file: args[8]! }
      : undefined
  }
  return undefined
}

export * as ReviewGit from "./git"
