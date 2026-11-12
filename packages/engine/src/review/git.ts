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

function sameBinding(left: ReadOnlyGit.Input, right: ReadOnlyGit.Input) {
  return (
    left.directory === right.directory &&
    left.gitDirectory === right.gitDirectory &&
    left.commonDirectory === right.commonDirectory
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
