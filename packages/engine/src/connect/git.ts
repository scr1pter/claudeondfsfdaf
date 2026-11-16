export * as ConnectGit from "./git"

import path from "node:path"
import { realpath } from "node:fs/promises"
import { Cause, Effect, Stream } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { Connect } from "@vectordevai/schema/connect"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"

const MAX = 64 * 1024 * 1024
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"]
const NAMES = ["--name-only", "--no-renames", "--no-ext-diff", "--no-relative", "-z"]
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((part, index) => part === right[index])
const prefix = (args: readonly string[], before: readonly string[]) =>
  before.every((part, index) => part === args[index]) ? args.slice(before.length) : undefined
const refusal = () =>
  new Connect.Refusal({
    code: "unavailable",
    message: "This review's Git reads cannot be inspected safely, so Vector stopped it.",
  })
function requireRead(condition: unknown): asserts condition {
  if (!condition) throw refusal()
}

type Field = "directory" | "gitDirectory" | "commonDirectory" | "branch" | "shallow" | "prefix"
type Query = ReadOnlyGit.Read | { readonly kind: "metadata"; readonly field: Field }

function object(value: string, action: "blob" | "size" | "exists" | "commit-exists"): ReadOnlyGit.Read {
  const found = /^(HEAD|[0-9a-f]{40})?:([^\x00\r\n]+)$/.exec(value)
  if (found) return { kind: "object", revision: found[1] || "index", file: found[2]!.replace(/^(\.\/)+/, ""), action }
  requireRead(value === "HEAD" || /^[0-9a-f]{40}$/.test(value))
  return { kind: "object", revision: value, action }
}

/** Translate only the fixed read shapes used by the legacy review collector; nothing is executed from raw argv. */
function query(args: readonly string[], stdin?: Buffer): Query {
  requireRead(args.length > 0 && args.length <= 512)
  if (same(args, ["cat-file", "--batch", "--follow-symlinks"])) {
    requireRead(stdin && stdin.byteLength <= 64 * 1024 && stdin.toString("utf8").endsWith("\n"))
    const text = stdin.toString("utf8")
    requireRead(Buffer.from(text).equals(stdin) && !text.includes("\0"))
    const lines = text
      .slice(0, -1)
      .split("\n")
      .map((line) => /^(HEAD|[0-9a-f]{40}):([^\r\n]+)$/.exec(line))
    requireRead(lines.length > 0 && lines.every((line) => !!line && line[1] === lines[0]![1]))
    return { kind: "batch-files", revision: lines[0]![1]!, files: lines.map((line) => line![2]!) }
  }
  requireRead(stdin === undefined)
  const metadata = new Map<string, Field>([
    ["--show-toplevel", "directory"],
    ["--absolute-git-dir", "gitDirectory"],
    ["--git-dir", "gitDirectory"],
    ["--git-common-dir", "commonDirectory"],
    ["--is-shallow-repository", "shallow"],
    ["--show-prefix", "prefix"],
  ])
  if (args.length === 2 && args[0] === "rev-parse" && metadata.has(args[1]!))
    return { kind: "metadata", field: metadata.get(args[1]!)! }
  if (same(args, ["symbolic-ref", "--quiet", "--short", "HEAD"])) return { kind: "metadata", field: "branch" }
  for (const options of [
    ["--verify", "--quiet", "--end-of-options"],
    ["--verify", "--end-of-options"],
  ]) {
    const rest = prefix(args, ["rev-parse", ...options])
    if (rest?.length === 1 && rest[0]!.endsWith("^{commit}"))
      return { kind: "resolve", revision: rest[0]!.slice(0, -9) }
  }
  if (args[0] === "merge-base" && args.length === 3) return { kind: "merge-base", left: args[1]!, right: args[2]! }
  if (args[0] === "cat-file" && args.length === 3 && ["blob", "-s", "-e"].includes(args[1]!)) {
    const action = args[1] === "blob" ? "blob" : args[1] === "-s" ? "size" : "exists"
    if (action === "exists" && args[2]!.endsWith("^{commit}")) return object(args[2]!.slice(0, -9), "commit-exists")
    return object(args[2]!, action)
  }
  if (args.length === 4 && args[0] === "status" && args[1] === "--porcelain" && args[3] === "--no-renames") {
    requireRead(args[2] === "--untracked-files=normal" || args[2] === "--untracked-files=no")
    return { kind: "status", untracked: args[2] === "--untracked-files=no" ? "no" : "normal" }
  }
  if (same(args, ["ls-files", "--others", "--exclude-standard", "-z"])) return { kind: "untracked" }
  if (same(args, ["ls-files", "--others", "-z", "--", ":(icase).vector", ":(icase).gitattributes"]))
    return { kind: "untracked", ignoredSettings: true }
  for (const cached of [false, true]) {
    const tail = prefix(args, ["diff", ...(cached ? ["--cached"] : []), ...NAMES])
    if (tail?.length === 2 && tail[1] === "--") return { kind: "diff", from: tail[0]!, cached, names: true }
    if (!cached && tail?.length === 3 && tail[2] === "--")
      return { kind: "diff", from: tail[0]!, to: tail[1]!, names: true }
  }
  for (const context of [3, 20]) {
    const tail = prefix(args, ["diff", ...DIFF, "--find-renames", `--unified=${context}`])
    if (!tail) continue
    if (tail.length === 2 && tail[1] === "--") return { kind: "diff", from: tail[0]!, context }
    if (tail.length === 3 && tail[0] === "--cached" && tail[2] === "--")
      return { kind: "diff", from: tail[1]!, cached: true, context }
    if (tail.length === 2) return { kind: "diff", from: tail[0]!, to: tail[1]!, context }
    if (tail.length >= 3 && tail[2] === "--")
      return { kind: "diff", from: tail[0]!, to: tail[1]!, context, files: tail.slice(3) }
  }
  const added = prefix(args, ["diff", "--no-index", ...DIFF, "--unified=3", "--", "/dev/null"])
  if (added?.length === 1) return { kind: "added-diff", file: added[0]! }
  const grep = prefix(args, ["grep", "-n", "-w", "-F", "-I", "--no-color", "--full-name", "-z", "-e"])
  if (grep && grep.length >= 4 && grep[2] === "--" && grep[3] === ".") {
    const magic = ":(exclude,glob)"
    requireRead(grep.slice(4).every((item) => item.startsWith(magic)))
    return {
      kind: "grep",
      symbol: grep[0]!,
      revision: grep[1]!,
      excludes: grep.slice(4).map((item) => item.slice(magic.length)),
    }
  }
  if (args.length === 3 && same(args.slice(0, 2), ["rev-list", "--max-parents=0"]))
    return { kind: "roots", revision: args[2]! }
  const history = prefix(args, ["log", "-n", "5", "--no-color", "--date=short", "--format=%h %an %ad %s"])
  if (history?.length === 3 && history[1] === "--") return { kind: "history", revision: history[0]!, file: history[2]! }
  const subjects = prefix(args, ["log", "--no-color", "-n", "50", "--format=%s"])
  if (subjects?.length === 1) {
    const range = /^(HEAD|[0-9a-f]{40})\.\.(HEAD|[0-9a-f]{40})$/.exec(subjects[0]!)
    requireRead(range)
    return { kind: "subjects", from: range[1]!, to: range[2]! }
  }
  const blame = prefix(args, ["blame", "--porcelain", "--root", "--no-textconv", "-L"])
  if (blame?.length === 4 && blame[2] === "--") {
    const range = /^([1-9]\d*),([1-9]\d*)$/.exec(blame[0]!)
    requireRead(range)
    return { kind: "blame", first: Number(range[1]), last: Number(range[2]), revision: blame[1]!, file: blame[3]! }
  }
  if (args.length === 5 && args[0] === "ls-tree" && args[1] === "-z" && args[3] === "--")
    return { kind: "tree", revision: args[2]!, file: args[4]! }
  throw refusal()
}

export interface Selected {
  readonly git: Git.Interface
  /** Also poisons the review when a legacy helper swallowed an unsupported read. */
  readonly check: () => Effect.Effect<void, Connect.Refusal>
}

const taskRoot = Symbol("Connect verified task Git root")
export interface TaskRoot {
  readonly [taskRoot]: true
}
interface TaskBinding {
  readonly directory: string
  readonly gitDirectory: string
  readonly commonDirectory: string
  readonly head: string
}
const taskRoots = new WeakMap<TaskRoot, TaskBinding>()

/** Called by the hub only inside TaskIsolation.review's verified, locked callback. Nothing serializable grants it. */
export const withTask = <A, E, R>(
  record: {
    readonly directory: string
    readonly gitDirectory?: string
    readonly gitCommonDirectory?: string
    readonly tip?: string
  },
  body: (root: TaskRoot) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Connect.Refusal, R> =>
  Effect.gen(function* () {
    if (!record.gitDirectory || !record.gitCommonDirectory || !record.tip) return yield* refusal()
    const binding: TaskBinding = Object.freeze({
      directory: record.directory,
      gitDirectory: record.gitDirectory,
      commonDirectory: record.gitCommonDirectory,
      head: record.tip,
    })
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const root = Object.freeze<TaskRoot>({ [taskRoot]: true })
        taskRoots.set(root, binding)
        return root
      }),
      body,
      (root) =>
        Effect.sync(() => {
          taskRoots.delete(root)
        }),
    )
  })

function selected(repository: ReadOnlyGit.Repository, admitted: string, active: () => boolean) {
  let blocked: Connect.Refusal | undefined
  const block = () => {
    blocked ??= refusal()
    return blocked
  }
  const fail = () => Effect.die(block())
  const cwd = (directory: string) => active() && (directory === repository.directory || directory === admitted)
  const output = (code: number, bytes: Buffer, bound = MAX): Git.Result => ({
    exitCode: code,
    stdout: bytes.subarray(0, bound),
    stderr: Buffer.alloc(0),
    truncated: bytes.byteLength > bound,
    text: () => bytes.subarray(0, bound).toString("utf8"),
  })
  const run: Git.Interface["run"] = (args, options) =>
    Effect.gen(function* () {
      if (
        blocked ||
        !cwd(options.cwd) ||
        Object.keys(options.env ?? {}).length > 0 ||
        !Number.isSafeInteger(options.maxOutputBytes ?? MAX) ||
        (options.maxOutputBytes ?? MAX) < 0 ||
        (options.maxOutputBytes ?? MAX) > MAX
      )
        return yield* fail()
      if (
        options.stdin !== undefined &&
        options.stdin !== "ignore" &&
        !same(args, ["cat-file", "--batch", "--follow-symlinks"])
      )
        return yield* fail()
      const stdin =
        options.stdin === undefined || options.stdin === "ignore"
          ? undefined
          : typeof options.stdin !== "string"
            ? yield* Stream.runFold(
                options.stdin,
                () => ({ length: 0, count: 0, chunks: [] as Uint8Array[] }),
                (state, chunk) => {
                  if ((state.length += chunk.byteLength) > 64 * 1024 || ++state.count > 4096) throw block()
                  state.chunks.push(chunk)
                  return state
                },
              ).pipe(
                Effect.map((state) => Buffer.concat(state.chunks)),
                Effect.timeout("10 seconds"),
                Effect.catchCause(() => fail()),
              )
            : yield* fail()
      const mapped = yield* Effect.try({ try: () => query(args, stdin), catch: () => block() }).pipe(Effect.orDie)
      if (mapped.kind === "metadata") {
        const value =
          mapped.field === "prefix"
            ? path.relative(repository.directory, options.cwd).replaceAll("\\", "/")
            : mapped.field === "shallow"
              ? String(repository.shallow)
              : repository[mapped.field]
        return output(
          value === undefined ? 1 : 0,
          Buffer.from(value === undefined ? "" : value + (mapped.field === "prefix" && value ? "/\n" : "\n")),
          options.maxOutputBytes,
        )
      }
      const result = yield* Effect.tryPromise({ try: () => repository.read(mapped), catch: () => block() }).pipe(
        Effect.orDie,
      )
      if (!active()) return yield* fail()
      return output(result.code, result.bytes, options.maxOutputBytes)
    })
  const check = () =>
    blocked || !active()
      ? Effect.fail(block())
      : Effect.tryPromise({
          try: async () => {
            const current = await ReadOnlyGit.metadataHead(repository.directory)
            requireRead(
              current.head === repository.head &&
                current.gitDirectory === repository.gitDirectory &&
                current.commonDirectory === repository.commonDirectory,
            )
            await repository.status()
            requireRead(active())
          },
          catch: () => block(),
        })
  const branch: Git.Interface["branch"] = (directory) => (cwd(directory) ? Effect.succeed(repository.branch) : fail())
  const git = Git.Service.of({
    run,
    branch,
    prefix: (directory) =>
      cwd(directory)
        ? Effect.succeed(
            path.relative(repository.directory, directory).replaceAll("\\", "/") +
              (directory === repository.directory ? "" : "/"),
          )
        : fail(),
    defaultBranch: fail,
    hasHead: (directory) => (cwd(directory) ? Effect.succeed(true) : fail()),
    mergeBase: (directory, base, head = "HEAD") =>
      run(["merge-base", base, head], { cwd: directory }).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.text().trim() || undefined : undefined)),
      ),
    show: (directory, ref, file, before = "") =>
      run(["cat-file", "blob", `${ref}:${before}${file}`], { cwd: directory }).pipe(
        Effect.map((result) => (result.exitCode === 0 && !result.stdout.includes(0) ? result.text() : "")),
      ),
    status: fail,
    diff: fail,
    stats: fail,
    patch: fail,
    patchAll: fail,
    patchUntracked: fail,
    statUntracked: fail,
    applyPatch: fail,
  })
  return { git, check, failed: () => blocked }
}

/** Only the admitted instance or the hub's live verified-task capability supplies the root. */
export const use = <A, E, R>(
  directory: string,
  body: (selected: Selected) => Effect.Effect<A, E, R>,
  task?: TaskRoot,
): Effect.Effect<A, E | Connect.Refusal, R> =>
  Effect.gen(function* () {
    const instance = yield* InstanceRef
    const placed = task === undefined ? undefined : taskRoots.get(task)
    if (task !== undefined && !placed) return yield* refusal()
    const root = placed?.directory ?? instance?.worktree
    if (!root || root === "/") return yield* refusal()
    const active = () => task === undefined || taskRoots.get(task) === placed
    const acquire = Effect.tryPromise({
      try: async () => {
        const admitted = await realpath(directory)
        requireRead(admitted === path.resolve(directory))
        requireRead(active())
        const metadata = await ReadOnlyGit.metadataHead(root)
        if (placed)
          requireRead(
            admitted === placed.directory &&
              metadata.directory === placed.directory &&
              metadata.gitDirectory === placed.gitDirectory &&
              metadata.commonDirectory === placed.commonDirectory &&
              metadata.head === placed.head,
          )
        const relative = path.relative(metadata.directory, admitted)
        requireRead(
          relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)),
        )
        const repository = await ReadOnlyGit.open(metadata)
        if (!active() || repository.head !== metadata.head) {
          await repository.close()
          throw refusal()
        }
        return { repository, selected: selected(repository, admitted, active) }
      },
      catch: () => refusal(),
    })
    return yield* Effect.acquireUseRelease(
      acquire,
      ({ selected }) =>
        body(selected).pipe(
          Effect.catchCause((cause): Effect.Effect<never, E | Connect.Refusal> => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
            const refused = selected.failed()
            return refused ? Effect.fail(refused) : Effect.failCause(cause)
          }),
        ),
      ({ repository }) => Effect.promise(() => repository.close()),
    )
  })
