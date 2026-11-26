export * as ConnectGit from "./git"

import path from "node:path"
import { realpath } from "node:fs/promises"
import { Cause, Effect, Stream } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { Connect } from "@vectordevai/schema/connect"
import { ProjectID } from "@vectordevai/schema/project-id"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import type { InstanceContext } from "@/project/instance-context"

const MAX = 64 * 1024 * 1024
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

type Field = "directory" | "gitDirectory" | "commonDirectory" | "branch" | "prefix"
// Only the reads connect's own checks make, a branch review's base by name included. A collector read (status, a
// context diff, an added-file diff, a size or existence check, grep, roots, history, subjects or blame) has no variant
// here, so query() cannot return one. The default branch is read only by defaultBranch(), never from argv.
type Query =
  | Extract<
      ReadOnlyGit.Read,
      { readonly kind: "resolve" | "reference" | "merge-base" | "untracked" | "batch-files" | "tree" }
    >
  | {
      readonly kind: "diff"
      readonly from: string
      readonly to?: string
      readonly cached?: boolean
      readonly names: true
    }
  | { readonly kind: "object"; readonly revision: string; readonly file?: string; readonly action: "blob" }
  | { readonly kind: "metadata"; readonly field: Field }

function object(value: string): Query {
  const found = /^(HEAD|[0-9a-f]{40})?:([^\x00\r\n]+)$/.exec(value)
  if (found)
    return { kind: "object", revision: found[1] || "index", file: found[2]!.replace(/^(\.\/)+/, ""), action: "blob" }
  requireRead(value === "HEAD" || /^[0-9a-f]{40}$/.test(value))
  return { kind: "object", revision: value, action: "blob" }
}

/**
 * Translate only the fixed reads connect's own checks emit (changes, drifted, ledOutAt, stateFile, commitOf with a
 * branch review's base by name or commit, mergeBase and plan's settings read); VectorScope's collector reads through
 * its own ReviewGit view. Nothing runs from raw argv.
 */
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
    ["--show-prefix", "prefix"],
  ])
  if (args.length === 2 && args[0] === "rev-parse" && metadata.has(args[1]!))
    return { kind: "metadata", field: metadata.get(args[1]!)! }
  if (same(args, ["symbolic-ref", "--quiet", "--short", "HEAD"])) return { kind: "metadata", field: "branch" }
  const rest = prefix(args, ["rev-parse", "--verify", "--quiet", "--end-of-options"])
  if (rest?.length === 1 && rest[0]!.endsWith("^{commit}")) {
    const revision = rest[0]!.slice(0, -9)
    requireRead(revision !== "" && !revision.startsWith("-"))
    // HEAD and 7 to 40 hex digits of either case are object ids. Core's resolve checks the spelling as given against
    // refs before it lowercases, so a short id never answers through a ref. Any other spelling is a name for core to
    // validate.
    if (revision === "HEAD" || /^[0-9a-f]{7,40}$/i.test(revision)) return { kind: "resolve", revision }
    return { kind: "reference", name: revision }
  }
  if (args[0] === "merge-base" && args.length === 3) return { kind: "merge-base", left: args[1]!, right: args[2]! }
  if (args[0] === "cat-file" && args.length === 3 && args[1] === "blob") return object(args[2]!)
  if (same(args, ["ls-files", "--others", "--exclude-standard", "-z"])) return { kind: "untracked" }
  if (same(args, ["ls-files", "--others", "-z", "--", ":(icase).vector", ":(icase).gitattributes"]))
    return { kind: "untracked", ignoredSettings: true }
  for (const cached of [false, true]) {
    const tail = prefix(args, ["diff", ...(cached ? ["--cached"] : []), ...NAMES])
    if (tail?.length === 2 && tail[1] === "--") return { kind: "diff", from: tail[0]!, cached, names: true }
    if (!cached && tail?.length === 3 && tail[2] === "--")
      return { kind: "diff", from: tail[0]!, to: tail[1]!, names: true }
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
  // Refs are live, so one view answers a name, and the default branch, as it first did: every check 1 pass of one
  // review then compares the range the review got.
  const pinned = new Map<string, { readonly code: number; readonly bytes: Buffer }>()
  const read = (operation: ReadOnlyGit.Read) =>
    Effect.gen(function* () {
      const key =
        operation.kind === "reference"
          ? "reference " + operation.name
          : operation.kind === "default-branch"
            ? "default-branch"
            : undefined
      const kept = key === undefined ? undefined : pinned.get(key)
      // Connect's own reads use a few spellings. A caller that keeps naming new ones fails closed instead.
      if (key !== undefined && kept === undefined && pinned.size >= 64) return yield* fail()
      const result =
        kept ??
        (yield* Effect.tryPromise({ try: () => repository.read(operation), catch: () => block() }).pipe(Effect.orDie))
      if (!active()) return yield* fail()
      if (key !== undefined) pinned.set(key, result)
      return result
    })
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
            : repository[mapped.field]
        return output(
          value === undefined ? 1 : 0,
          Buffer.from(value === undefined ? "" : value + (mapped.field === "prefix" && value ? "/\n" : "\n")),
          options.maxOutputBytes,
        )
      }
      const result = yield* read(mapped)
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
    // Only origin/HEAD, read in the private view; no ordinary-Git fallback to other remotes, init.defaultBranch or
    // main/master. mergeBase() then tries origin/<name> before <name>, both in this view.
    defaultBranch: (directory) =>
      Effect.gen(function* () {
        if (blocked || !cwd(directory)) return yield* fail()
        const result = yield* read({ kind: "default-branch" })
        if (result.code === 1 && result.bytes.byteLength === 0) return undefined
        const ref =
          result.code === 0 ? /^refs\/remotes\/(origin\/[^\n]+)\n$/.exec(result.bytes.toString("utf8"))?.[1] : undefined
        if (!ref) return yield* fail()
        return { name: ref.slice("origin/".length), ref } satisfies Git.Base
      }),
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

/** VectorScope's member reason and a review's refusal when an instance's worktree is reached through a link. */
export const LINKED = "Open this project through its real folder path to use connected reviews."

export const NON_REPOSITORY = "Open a Git repository to use connected reviews."

/** Project discovery reports this exact context when it opens a directory without a Git checkout. */
export function nonRepository(instance: InstanceContext | undefined, directory: string) {
  return (
    instance?.directory === directory &&
    instance.worktree === "/" &&
    instance.project.id === ProjectID.global &&
    instance.project.vcs === undefined
  )
}

/**
 * Whether each folder is its own real path. Connect never resolves a link to read at the folder behind it: read rules
 * match paths as written, so admitting the resolved folder would widen them. Rejects when a folder is missing.
 */
export async function canonical(...folders: string[]) {
  return (await Promise.all(folders.map(async (folder) => (await realpath(folder)) === path.resolve(folder)))).every(
    Boolean,
  )
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
    if (task === undefined && nonRepository(instance, directory))
      return yield* new Connect.Refusal({ code: "unavailable", message: NON_REPOSITORY })
    if (!root || root === "/") return yield* refusal()
    const active = () => task === undefined || taskRoots.get(task) === placed
    const acquire = Effect.tryPromise({
      try: async () => {
        const admitted = await realpath(directory)
        requireRead(admitted === path.resolve(directory))
        // An instance loads at its real folder, so a folder that is a link now was swapped since and gets the generic
        // refusal. Its worktree may be kept as written (a task worktree under a linked data folder), which core refuses
        // below; say why first. The hub's verified task root keeps the generic refusal.
        if (!placed && !(await canonical(root))) throw new Connect.Refusal({ code: "unavailable", message: LINKED })
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
      catch: (error) => (error instanceof Connect.Refusal ? error : refusal()),
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
