import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  appendFile,
  open,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { Cause, Context, Effect, Layer, Option, RcMap, Schema, Scope, Stream } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { KeyedMutex } from "@vectordevai/core/effect/keyed-mutex"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { IsolationCopy } from "@vectordevai/core/isolation/copy"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Database } from "@vectordevai/core/database/database"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionSchema } from "@vectordevai/core/session/schema"
import { eq } from "drizzle-orm"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { Location } from "@vectordevai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Pty } from "@vectordevai/core/pty"
import { AbsolutePath } from "@vectordevai/core/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileLock } from "@/tool/file-lock"
import { TaskClaims } from "./claims"
import { TaskPlace } from "./place"
import { IsolationBase } from "./isolation-base"
import type { InstanceContext } from "@/project/instance-context"
import type { Task } from "@vectordevai/schema/task"
import { SessionCleanup } from "@/session/cleanup"
import type { Session } from "@/session/session"
import type { Worktree } from "@/worktree"
import type { InstanceStore } from "@/project/instance-store"

export class IsolationError extends Schema.TaggedErrorClass<IsolationError>()("TaskIsolation.Error", {
  code: Schema.String,
  message: Schema.String,
  conflicts: Schema.optional(Schema.Array(Schema.String)),
}) {}

const AgentResolution = Schema.Struct({
  name: Schema.String,
  model: Schema.optional(Schema.Unknown),
  permission: Schema.Unknown,
})
const Change = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  binary: Schema.Boolean,
})
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  projectID: Schema.String,
  taskID: Schema.String,
  parentSessionID: Schema.String,
  parentDirectory: Schema.String,
  homeDirectory: Schema.String,
  directory: Schema.String,
  mode: Schema.Literals(["worktree", "copy"]),
  state: Schema.String,
  title: Schema.String,
  agent: AgentResolution,
  attempt: Schema.Number,
  createdAt: Schema.Number,
  branch: Schema.optional(Schema.String),
  gitDirectory: Schema.optional(Schema.String),
  gitCommonDirectory: Schema.optional(Schema.String),
  seed: Schema.optional(Schema.String),
  unstackedSeed: Schema.optional(Schema.String),
  reviewBase: Schema.optional(Schema.String),
  patchBase: Schema.optional(Schema.String),
  copyBase: Schema.optional(Schema.String),
  copyStacked: Schema.optional(Schema.Boolean),
  stackedIncluded: Schema.optional(Schema.Boolean),
  savedPatch: Schema.optional(Schema.String),
  tip: Schema.optional(Schema.String),
  settledAttempt: Schema.optional(Schema.Number),
  links: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
  initialSkipped: Schema.optional(Schema.Array(Schema.String)),
  largeBaseline: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ blob: Schema.String, hash: Schema.String })),
  ),
  stacked: Schema.Array(Schema.String),
  merged: Schema.Array(Schema.String),
  files: Schema.Array(Change),
  error: Schema.optional(Schema.String),
  mergeStartedAt: Schema.optional(Schema.Number),
  checkpoint: Schema.optional(Schema.String),
  mergeCompleted: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.String),
  mergeKey: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  /** Why the owner or parent discarded the changes. Private: never part of info, report or any projection. */
  discardReason: Schema.optional(Schema.String),
})
export type Record = Schema.Schema.Type<typeof Record>
const decode = Schema.decodeUnknownSync(Record)

/** Injectable size thresholds keep boundary tests small; production defaults match the isolation contract. */
export const Limits = Context.Reference("TaskIsolation.Limits", {
  defaultValue: () => ({
    fileBytes: 50 * 1024 * 1024,
    minFreeBytes: 1024 ** 3,
    copyBytes: 1024 ** 3,
    copyFiles: 20_000,
    patchBytes: 256 * 1024,
  }),
})

type Expected = Pick<Agent.Info, "name" | "model" | "permission">
export type CheckInput = { parentSessionID: string; agent: Expected; resumeID?: string }
export type ReserveInput = CheckInput & {
  taskID: string
  title: string
  attempt?: number
  dependsOn?: readonly string[]
}
export type By =
  | { kind: "owner" }
  | {
      kind: "agent"
      sessionID: string
      ask: (input: {
        permission: "edit" | "connect_write"
        patterns: string[]
        always: string[]
        metadata: { diff: string; description?: string; runID?: string }
      }) => Effect.Effect<void, unknown>
      assertWritable: (input: { files: string[] }) => Effect.Effect<void, unknown>
      assertExternalDirectory: (file: string) => Effect.Effect<unknown, unknown>
    }
export type MergeInput = {
  taskID: string
  files?: readonly string[]
  force?: boolean
  includeStacked?: boolean
  by: By
}
type Blob = { mode: string; bytes: Buffer } | undefined
type Checkpoint = {
  files: {
    path: string
    existed: boolean
    symlink?: string
    mode?: number
    /** What the merge writes at the path (a sha256, a link target or nothing), so recovery undoes only its own write. */
    written?: { hash: string } | { symlink: string } | { absent: true }
  }[]
  selected: readonly string[]
  phase: "prepared" | "written"
}

const mutex = KeyedMutex.makeUnsafe<string>()
const swept = new Set<string>()
const active = new Map<string, InstanceContext>()
const queued = new Set<string>()
const err = (code: string, message: string, conflicts?: string[]) =>
  new IsolationError({ code, message, ...(conflicts ? { conflicts } : {}) })
const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
const io = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: error })
const missing = (cause: unknown) => ["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException)?.code ?? "")
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const nuls = (bytes: Buffer | string) => bytes.toString().split("\0").filter(Boolean)
const safeID = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id)
const relative = (file: string) =>
  !!file &&
  !file.includes("\0") &&
  !path.isAbsolute(file) &&
  !path.win32.isAbsolute(file) &&
  !/^[a-z]:/i.test(file) &&
  !file.split(/[\\/]/).some((part) => part === "." || part === ".." || part.toLowerCase() === ".git" || part === "")
const inside = (root: string, file: string) => {
  const value = path.relative(root, file)
  return value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`))
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  )
const resolution = (agent: Expected) => ({
  name: agent.name,
  ...(agent.model ? { model: agent.model } : {}),
  permission: agent.permission,
})

/** Display data only; filesystem authority always comes from the validated private registry. */
export function info(record: Record, details = false): Task.Isolation {
  return {
    mode: record.mode,
    state: record.state === "running" ? "active" : record.state,
    files: record.files.length,
    additions: record.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: record.files.reduce((sum, file) => sum + file.deletions, 0),
    ...(details
      ? {
          directory: record.directory,
          ...(record.branch ? { branch: record.branch } : {}),
          merged: [...record.merged],
          skipped: [...record.skipped],
          ...(record.error ? { error: record.error } : {}),
        }
      : {}),
  }
}

/** Vector's line for an isolated task whose record cannot be read: the result still arrives, without counts. */
export const UNREADABLE_REPORT =
  "Vector: this task worked in its own isolated checkout, but its record could not be read. Its changes are not in your files; saving needs attention."

/** Vector's own line is kept outside the subagent's untrusted report and contains no filenames. */
export function report(record: Record) {
  const place = record.mode === "worktree" ? "worktree" : "copy"
  // A start that failed before its checkout existed ends unchanged with its error (TaskIsolation.vacate).
  if (record.state === "unchanged" && record.error)
    return `Vector: this task's isolated ${place} could not be prepared, so it changed no files.`
  if (record.state === "unchanged")
    return `Vector: this task worked in its own ${place} and changed no files, so the ${place} was removed.`
  if (record.state === "settling")
    return `Vector: this task's partial changes are being saved${record.branch ? ` on branch ${record.branch}` : " in its isolated copy"}.`
  if (record.state === "failed")
    return `Vector: this task worked in its own ${place}. Saving needs attention; its checkout and recoverable changes have been retained.`
  if (record.state === "diverged")
    return `Vector: this task worked in its own ${place}. Its history diverged from the saved starting point; review its retained changes before merging.`
  if (record.state !== "changed") return undefined
  const counts = info(record)
  return `Vector: this task worked in its own ${place}. ${counts.files} files changed (+${counts.additions} −${counts.deletions})${record.branch ? ` on branch ${record.branch}` : ""}; they are not in your files yet. Review them with task_manage inspect (diff: true), then task_manage merge, or discard.`
}

// Main's terminal tool text tells every agent that its terminals appear in the user's terminal panel and may stay open
// for the user. A checkout's terminals are in the checkout's own location, which the app's panel (it follows the open
// project's folder) does not show, and `quiesce` closes them when the work is saved, so an isolated helper is told so.
const TERMINALS =
  "Unlike other conversations' terminals, the ones you open are not shown in the user's terminal panel, so revealing one shows nothing, and they are closed, their programs ended, when your work is saved at the end of your run: do not leave a program running for anyone to use, and do not report one as running or visible."

export function brief(record: Record) {
  return `You work in an isolated copy of the repository at ${record.directory} (${record.mode === "worktree" ? `git worktree on branch ${record.branch}` : "independent file copy"}), made from the parent's files when you started, including their uncommitted changes${record.stacked.length ? `, plus the changes of ${record.stacked.join(", ")}` : ""}. Paths under ${record.parentDirectory} in this conversation are under ${record.directory} for you. Edit and run checks here; nothing reaches the parent's files until the parent merges your work. ${record.mode === "worktree" ? "You may commit on your branch; do not switch branches, stash or push. " : ""}Ignored files such as node_modules are not here${record.links.length ? `; linked: ${record.links.join(", ")}` : ""}${record.skipped.length ? `; left out: ${record.skipped.join(", ")}` : ""}. ${TERMINALS} List the files you changed in your report.`
}
const paths = (projectID: string, taskID: string) => {
  if (!safeID(projectID) || !safeID(taskID)) throw err("registry", "Invalid isolation registry identifier.")
  const registry = path.join(Global.Path.data, "task-isolation", projectID, taskID)
  return {
    registry,
    file: path.join(registry, "record.json"),
    directory: path.join(Global.Path.data, "task-worktree", projectID, taskID),
    branch: `vector/subagent/${taskID}`,
  }
}

async function present(file: string) {
  return lstat(file)
    .then(() => true)
    .catch((cause) => {
      if (missing(cause)) return false
      throw cause
    })
}

/** Every registry ancestor is a directory, never a link. The final JSON is a private ordinary file. */
async function guarded(file: string, root = Global.Path.data) {
  if (!inside(path.resolve(root), path.resolve(file))) throw err("registry", "Isolation path leaves its data root.")
  for (const name of [
    root,
    ...path
      .relative(root, file)
      .split(path.sep)
      .map((_part, index, parts) => path.join(root, ...parts.slice(0, index + 1))),
  ]) {
    const info = await lstat(name).catch((cause) => {
      if (missing(cause)) return undefined
      throw cause
    })
    if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1))
      throw err("registry", "Isolation data cannot be a symbolic or hard link.")
    if (name !== file && info && !info.isDirectory())
      throw err("registry", "Isolation registry ancestor is not a directory.")
  }
}

async function privateJSON(file: string, value: unknown) {
  await guarded(file)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(file), 0o700)
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(temp, file).catch(async (cause) => {
    await rm(temp, { force: true })
    throw cause
  })
}

async function privateTree(directory: string) {
  await guarded(directory)
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await privateTree(file)
      continue
    }
    await chmod(file, 0o600)
  }
}

/**
 * Puts a file or a symbolic link at `target` through a new name in its folder and a rename, so a write that fails (a
 * link Windows lacks the privilege to make, a full disk) leaves what was there. Merges and their rollback write this
 * way, which lets recovery tell their writes from later changes.
 */
export async function place(target: string, entry: { symlink: string } | { bytes: Buffer; mode: number }) {
  const temp = path.join(path.dirname(target), `.vector-merge-${randomUUID()}`)
  if ("symlink" in entry) await symlink(entry.symlink, temp)
  else await writeFile(temp, entry.bytes, { mode: entry.mode, flag: "wx" })
  await (async () => {
    // Windows renames neither a link to a folder over an entry nor anything over such a link, so there the old entry
    // goes first. The new link exists by then, so only that rename is left to fail.
    if ("symlink" in entry && process.platform === "win32")
      await unlink(target).catch((cause) => {
        if (!missing(cause)) throw cause
      })
    await rename(temp, target)
  })().catch(async (cause) => {
    await unlink(temp).catch(() => undefined)
    throw cause
  })
}

async function readRecord(ctx: InstanceContext, taskID: string): Promise<Record> {
  const expected = paths(ctx.project.id, taskID)
  await guarded(expected.file)
  const record = decode(JSON.parse(await readFile(expected.file, "utf8")))
  if (
    record.taskID !== taskID ||
    record.projectID !== ctx.project.id ||
    record.directory !== expected.directory ||
    record.branch !== (record.mode === "worktree" ? expected.branch : undefined) ||
    FileLock.key(record.homeDirectory) !== FileLock.key(ctx.directory) ||
    FileLock.key(record.parentDirectory) !==
      FileLock.key(ctx.worktree === path.parse(ctx.worktree).root ? ctx.directory : ctx.worktree) ||
    !record.files.every((file) => relative(file.path)) ||
    !record.links.every(relative) ||
    (record.initialSkipped !== undefined && !record.initialSkipped.every(relative)) ||
    (record.largeBaseline !== undefined &&
      Object.entries(record.largeBaseline).some(
        ([file, value]) =>
          !relative(file) || !/^[a-f0-9]{40,64}$/.test(value.blob) || !/^[a-f0-9]{64}$/.test(value.hash),
      )) ||
    !record.merged.every(relative) ||
    !record.stacked.every(safeID) ||
    [record.seed, record.tip, record.reviewBase, record.patchBase, record.unstackedSeed].some(
      (ref) => ref !== undefined && !/^[a-f0-9]{40,64}$/.test(ref),
    ) ||
    (record.copyBase !== undefined && (!safeID(record.copyBase) || !record.copyBase.startsWith("base-"))) ||
    (record.savedPatch !== undefined && path.dirname(record.savedPatch) !== path.join(expected.registry, "patches"))
  )
    throw err("registry", "Isolation registry does not match the launching project.")
  const tombstone = path.join(expected.registry, "deleted.json")
  await guarded(tombstone)
  const deleted = await readFile(tombstone, "utf8")
    .then((value) => JSON.parse(value) as { sessionID: string; projectID: string })
    .catch((cause) => {
      if (missing(cause)) return undefined
      throw cause
    })
  if (deleted && (deleted.sessionID !== taskID || deleted.projectID !== ctx.project.id))
    throw err("registry", "Isolation deletion marker does not match the launching project.")
  return deleted ? { ...record, deleted: true } : record
}

/** Deletion only marks durable sweep work; it needs neither an ambient instance nor Git. */
export const enqueueDeleted = Effect.fn("TaskIsolation.enqueueDeleted")(function* (session: Session.Info) {
  if (!safeID(session.id) || !safeID(session.projectID)) return
  const location = paths(session.projectID, session.id)
  yield* io(async () => {
    await guarded(location.file)
    const record = await readFile(location.file, "utf8")
      .then((value) => decode(JSON.parse(value)))
      .catch((cause) => {
        if (missing(cause)) return undefined
        throw cause
      })
    if (!record) return
    if (
      record.taskID !== session.id ||
      record.projectID !== session.projectID ||
      record.directory !== location.directory ||
      FileLock.key(record.homeDirectory) !== FileLock.key(session.directory)
    )
      throw err("registry", "Deleted session does not match its isolation registry.")
    await privateJSON(path.join(location.registry, "deleted.json"), {
      sessionID: session.id,
      projectID: session.projectID,
    })
    queued.add(session.id)
  })
})
SessionCleanup.register(enqueueDeleted)
const save = (record: Record) => io(() => privateJSON(paths(record.projectID, record.taskID).file, record))
function baselinePaths(record: Record) {
  const registry = paths(record.projectID, record.taskID).registry
  return record.copyBase
    ? {
        directory: path.join(registry, record.copyBase, "files"),
        hashes: path.join(registry, record.copyBase, "hashes.json"),
      }
    : { directory: path.join(registry, "baseline"), hashes: path.join(registry, "baseline.json") }
}
/**
 * A copy's baseline and each partial merge's version of it hold a full copy of the project. Nothing reads them once the
 * copy is gone (a merged or discarded task reads its saved patch, and a resume starts again from current files), and a
 * start must not copy into an earlier attempt's, so they go when the copy goes and before a start copies.
 */
async function dropBaselines(record: Record) {
  const registry = paths(record.projectID, record.taskID).registry
  await guarded(registry)
  const names = await readdir(registry).catch((cause) => {
    if (missing(cause)) return []
    throw cause
  })
  for (const name of names.filter((name) => ["baseline", "baseline.json"].includes(name) || name.startsWith("base-")))
    await rm(path.join(registry, name), { recursive: true, force: true })
}
const baselineHashes = (record: Record) =>
  io(async () => {
    const file = baselinePaths(record).hashes
    await guarded(file)
    const value = JSON.parse(await readFile(file, "utf8")) as { [key: string]: string }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.entries(value).every(([file, hash]) => relative(file) && /^[a-f0-9]{64}$/.test(hash))
    )
      throw err("registry", "Invalid copy baseline hashes.")
    const hashes: typeof value = Object.create(null)
    return Object.assign(hashes, value)
  })

/**
 * Call-time resolution avoids introducing Worktree/InstanceStore bootstrap cycles. Tests can provide real services.
 * The explicit return types keep TaskIsolation's inferred interface independent of AppRuntime's layer graph, which
 * itself contains TaskIsolation.
 */
const worktrees = Effect.fn("TaskIsolation.worktrees")(function* (): Effect.fn.Return<Worktree.Interface> {
  const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
  const provided = yield* Effect.serviceOption(Worktree.Service)
  if (Option.isSome(provided)) return provided.value
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  return yield* Effect.promise(() => AppRuntime.runPromise(Worktree.Service))
})
const instances = Effect.fn("TaskIsolation.instances")(function* (): Effect.fn.Return<InstanceStore.Interface> {
  const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
  const provided = yield* Effect.serviceOption(InstanceStore.Service)
  if (Option.isSome(provided)) return provided.value
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  return yield* Effect.promise(() => AppRuntime.runPromise(InstanceStore.Service))
})

/**
 * Cancel and join every runner/job sharing this work context, then close its terminals, BEFORE snapshot, disposal or
 * placement retirement.
 */
export const quiesce = Effect.fn("TaskIsolation.quiesce")(function* (
  taskID: string,
  work: InstanceContext,
  locations: LocationServiceMap.Service["Service"],
): Effect.fn.Return<void> {
  const [{ BackgroundJob }, { SessionRunState }, { SessionID }] = yield* Effect.promise(() =>
    Promise.all([import("@/background/job"), import("@/session/run-state"), import("@/session/schema")]),
  )
  const jobOption = yield* Effect.serviceOption(BackgroundJob.Service)
  const runOption = yield* Effect.serviceOption(SessionRunState.Service)
  const { AppRuntime } =
    Option.isNone(jobOption) || Option.isNone(runOption)
      ? yield* Effect.promise(() => import("@/effect/app-runtime"))
      : { AppRuntime: undefined }
  const jobs = Option.isSome(jobOption)
    ? jobOption.value
    : yield* Effect.promise(() => AppRuntime!.runPromise(BackgroundJob.Service))
  const runners = Option.isSome(runOption)
    ? runOption.value
    : yield* Effect.promise(() => AppRuntime!.runPromise(SessionRunState.Service))
  const descendants = TaskPlace.places().filter(
    (entry) => entry.sessionID !== taskID && FileLock.key(entry.work.directory) === FileLock.key(work.directory),
  )
  yield* Effect.forEach(descendants, (entry) => runners.cancel(SessionID.make(entry.sessionID)), {
    concurrency: "unbounded",
    discard: true,
  })
  const running = yield* jobs.list().pipe(Effect.provideService(InstanceRef, work))
  yield* Effect.forEach(
    running.filter((job) => job.id !== taskID),
    (job) => jobs.cancel(job.id).pipe(Effect.provideService(InstanceRef, work)),
    { concurrency: "unbounded", discard: true },
  )
  yield* closeTerminals(work, locations)
})

/**
 * A checkout's terminals belong to its location's services, the ones the terminal tool opens them in, and core keeps
 * those for an hour after their last use, so nothing else would end a program still writing in a checkout that is being
 * saved or retired. With the runs above stopped, no new one opens: each is closed, and its program waited for.
 */
const closeTerminals = Effect.fn("TaskIsolation.closeTerminals")(function* (
  work: InstanceContext,
  locations: LocationServiceMap.Service["Service"],
) {
  yield* closeTerminalsIn([work.directory], () => true, locations)
})

/**
 * Closes the terminals `chosen` picks in these folders' location services, and waits for their programs. A location
 * nothing has used has no terminals and is not started. Returns how many running programs it closed.
 */
export const closeTerminalsIn = Effect.fn("TaskIsolation.closeTerminalsIn")(function* (
  directories: readonly string[],
  chosen: (info: Pty.Info) => boolean,
  locations: LocationServiceMap.Service["Service"],
) {
  const unique = [...new Map(directories.map((directory) => [FileLock.key(directory), directory])).values()]
  const closed = yield* Effect.forEach(unique, (directory) =>
    Effect.gen(function* () {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      // Getting a location nothing has used would start its services in that folder.
      if (!(yield* RcMap.has(locations.rcMap, ref))) return []
      return yield* Effect.gen(function* () {
        const pty = yield* Pty.Service
        const terminals = (yield* pty.list()).filter(chosen)
        yield* Effect.forEach(
          terminals,
          (info) => pty.remove(info.id).pipe(Effect.catchTag("Pty.NotFoundError", () => Effect.void)),
          { discard: true },
        )
        return terminals.filter((info) => info.status === "running")
      }).pipe(
        Effect.provide(locations.get(ref)),
        // Location services that failed to start have no terminal service, so no terminals.
        Effect.catch((cause) =>
          Effect.logWarning("a folder's location services did not start; its terminals were not closed", {
            directory,
            cause,
          }).pipe(Effect.as([] as Pty.Info[])),
        ),
      )
    }),
  )
  const running = closed.flat()
  yield* Effect.forEach(running, (info) => ended(info.pid), { concurrency: "unbounded", discard: true })
  return running.length
})

// The close sent the terminal's program the terminal library's hangup or terminate. One that ignores it is killed, with
// its process group, after a second; on Windows the close already ends the console's processes. Waiting probes with
// signal 0, which sends nothing.
const ended = Effect.fn("TaskIsolation.ended")(function* (pid: number) {
  // The pid comes from the terminal library unchecked (bun-pty reports -1 until it has one), and `process.kill` reads
  // 0 or less as a process group or every process: 0 would probe and then kill the engine's own group, -1 every
  // process the user may signal. Such a pid is neither probed nor killed. `alive` and `kill` are reached only here.
  if (!Number.isInteger(pid) || pid <= 0)
    return yield* Effect.logWarning("a closed terminal reported no usable pid; its program was not waited for", { pid })
  if (yield* exited(pid, 50)) return
  if (process.platform !== "win32") kill(pid)
  if (yield* exited(pid, 100)) return
  yield* Effect.logWarning("a closed terminal's program is still running", { pid })
})

const exited = (pid: number, polls: number) =>
  Effect.gen(function* () {
    for (let poll = 0; poll < polls; poll++) {
      if (!alive(pid)) return true
      yield* Effect.sleep("20 millis")
    }
    return !alive(pid)
  })

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The program may end between the probe and the kill; then there is nothing left to kill.
function kill(pid: number) {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

export const make = Effect.gen(function* () {
  const git = yield* Git.Service
  const config = yield* Config.Service
  const locations = yield* LocationServiceMap.Service
  const audience = yield* SessionAudience.Service
  const database = yield* Database.Service
  const agents = yield* Agent.Service
  const run = (cwd: string, args: string[], options: Omit<Git.Options, "cwd"> = {}) =>
    git.run(["-c", `core.hooksPath=${os.devNull}`, ...args], {
      ...options,
      cwd,
      env: { ...options.env, GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C" },
    })
  const command = Effect.fn("TaskIsolation.git")(function* (
    cwd: string,
    args: string[],
    options: Omit<Git.Options, "cwd"> = {},
  ) {
    const out = yield* run(cwd, args, options)
    if (out.exitCode !== 0 || out.truncated)
      return yield* err(
        "git",
        out.stderr.toString("utf8") || "Isolation Git command failed or exceeded its output bound.",
      )
    return out.stdout
  })
  const text = (cwd: string, args: string[], options: Omit<Git.Options, "cwd"> = {}) =>
    command(cwd, args, options).pipe(Effect.map((out) => out.toString("utf8").trim()))
  // A partial merge's logical base is a commit no branch reaches, so Git's gc would prune it while the task is kept.
  // Each one gets its own private ref under its task before a record names it. A ref is never moved, so a merge that
  // fails after pinning leaves the record's current base pinned as well; `remove` drops the task's refs.
  const pins = (taskID: string) => `refs/vector/isolation/${taskID}`
  const pin = (record: Record, commit: string) =>
    command(record.parentDirectory, ["update-ref", `${pins(record.taskID)}/${commit}`, commit]).pipe(Effect.as(commit))
  const home = Effect.gen(function* () {
    const ctx = yield* TaskPlace.atHome()(InstanceRef)
    if (!ctx) return yield* err("context", "Task isolation requires a launching instance.")
    return ctx
  })
  // A record is always looked up against the active home, never against fields in session metadata.
  const get = Effect.fn("TaskIsolation.get")(function* (taskID: string) {
    const ctx = yield* home
    return yield* io(() => readRecord(ctx, taskID))
  })
  // Whether a task is isolated is asked on every ordinary helper's result, resume and revert. A task with no registry
  // entry is not isolated, and that answer does not depend on the data folder's link guard, so a linked data folder
  // breaks only isolation itself. An entry that exists is read under the full guard.
  const optional = (taskID: string) =>
    Effect.gen(function* () {
      const ctx = yield* home
      if (!(yield* io(() => present(paths(ctx.project.id, taskID).registry)))) return undefined
      return yield* get(taskID)
    }).pipe(Effect.catch((cause) => (missing(cause) ? Effect.succeed(undefined) : Effect.fail(cause))))
  const records = Effect.fn("TaskIsolation.records")(function* () {
    const ctx = yield* home
    const root = path.join(Global.Path.data, "task-isolation", ctx.project.id)
    if (!(yield* io(() => present(root)))) return []
    yield* io(() => guarded(root))
    const entries = yield* io(() =>
      readdir(root).catch((cause) => {
        if (missing(cause)) return []
        throw cause
      }),
    )
    return yield* Effect.forEach(entries.filter(safeID), (id) => get(id).pipe(Effect.option)).pipe(
      Effect.map((items) => items.filter(Option.isSome).map((item) => item.value)),
    )
  })
  const lock = <A, E, R>(taskID: string, effect: Effect.Effect<A, E, R>) =>
    home.pipe(Effect.flatMap((ctx) => mutex.withLock(`${ctx.project.id}/${taskID}`)(effect)))
  const verify = Effect.fn("TaskIsolation.verify")(function* (record: Record, recoverBinding = false) {
    const current = yield* get(record.taskID)
    if (current.mode === "copy") {
      yield* io(() => guarded(current.directory))
      // The data folder's own path may pass through a link (a linked home, /tmp or /var on macOS, a short or mapped
      // path on Windows); nothing at or below it may. So the copy must resolve to its reserved names under the data
      // folder's real path.
      const [real, root] = yield* io(() => Promise.all([realpath(current.directory), realpath(Global.Path.data)]))
      if (real !== path.join(root, path.relative(Global.Path.data, current.directory)))
        return yield* err("registry", "Copy isolation directory changed identity.")
      return current
    }
    const listing = nuls(yield* command(current.parentDirectory, ["worktree", "list", "--porcelain", "-z"]))
    const entries: { directory?: string; branch?: string }[] = []
    for (const line of listing) {
      if (line.startsWith("worktree ")) entries.push({ directory: line.slice(9) })
      if (line.startsWith("branch ") && entries.length) entries[entries.length - 1]!.branch = line.slice(7)
    }
    const entry = entries.find(
      (item) => item.directory && FileLock.key(item.directory) === FileLock.key(current.directory),
    )
    if (!entry || entry.branch !== `refs/heads/${current.branch}`)
      return yield* err("registry", "Registered task worktree or reserved branch no longer matches Git.")
    yield* io(() => guarded(current.directory))
    const gitDirectory = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-dir"]))
    const common = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-common-dir"]))
    const branch = yield* text(current.directory, ["symbolic-ref", "--short", "HEAD"])
    const parentCommon = path.resolve(
      current.parentDirectory,
      yield* text(current.parentDirectory, ["rev-parse", "--git-common-dir"]),
    )
    const top = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--show-toplevel"]))
    const index = path.resolve(current.directory, yield* text(current.directory, ["rev-parse", "--git-path", "index"]))
    yield* io(() => guarded(path.join(current.directory, ".git")))
    yield* io(() => guarded(gitDirectory, parentCommon))
    yield* io(() => guarded(index, gitDirectory))
    if (
      FileLock.key(top) !== FileLock.key(current.directory) ||
      FileLock.key(index) !== FileLock.key(path.join(gitDirectory, "index"))
    )
      return yield* err("registry", "The task checkout or index was redirected outside its registered Git metadata.")
    if (FileLock.key(common) !== FileLock.key(parentCommon) || branch !== current.branch)
      return yield* err(
        "registry",
        "The task checkout is no longer attached to its parent's Git repository and reserved branch.",
      )
    if (
      (!current.gitDirectory || !current.gitCommonDirectory) &&
      recoverBinding &&
      current.seed &&
      ["preparing", "running", "failed"].includes(current.state)
    ) {
      // Creation may have completed before its metadata binding reached disk. Recover only a real linked worktree
      // owned by this common-dir, with Git's own backpointer to this exact reserved checkout; a redirected .git fails.
      yield* io(() => guarded(path.join(current.directory, ".git")))
      yield* io(() => guarded(gitDirectory, parentCommon))
      const canonical = yield* io(() => realpath(gitDirectory))
      const root = yield* io(() => realpath(path.join(parentCommon, "worktrees")))
      const backpointer = yield* io(() => readFile(path.join(gitDirectory, "gitdir"), "utf8"))
      if (
        FileLock.key(path.dirname(canonical)) !== FileLock.key(root) ||
        FileLock.key(backpointer.trim()) !== FileLock.key(path.join(current.directory, ".git"))
      )
        return yield* err("registry", "Cannot recover a task Git binding from another checkout's metadata.")
      const recovered = { ...current, gitDirectory, gitCommonDirectory: common }
      yield* save(recovered)
      return recovered
    }
    if (
      !current.gitDirectory ||
      !current.gitCommonDirectory ||
      FileLock.key(gitDirectory) !== FileLock.key(current.gitDirectory) ||
      FileLock.key(common) !== FileLock.key(current.gitCommonDirectory) ||
      branch !== current.branch
    )
      return yield* err("registry", "The task checkout's Git metadata changed identity.")
    return current
  })
  const inspectReview = (record: Record) =>
    Effect.tryPromise({
      try: () => {
        if (!record.gitDirectory || !record.gitCommonDirectory)
          return Promise.reject(new ReadOnlyGit.Unavailable("the task has no verified Git binding"))
        return ReadOnlyGit.inspect({
          directory: record.directory,
          gitDirectory: record.gitDirectory,
          commonDirectory: record.gitCommonDirectory,
        })
      },
      catch: () =>
        new IsolationError({
          code: "review_target",
          message: "This task's Git metadata cannot be inspected safely. The review did not start.",
        }),
    })
  /** A settled checkout remains the same registered task until the read-only review releases this lock. */
  const review = <A, E, R>(
    input: { readonly taskID: string; readonly parentSessionID: string },
    use: (record: Record) => Effect.Effect<A, E, R>,
  ) =>
    lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (record.parentSessionID !== input.parentSessionID || record.deleted)
          return yield* err("review_target", "That isolated task does not belong to this conversation.")
        if (record.mode !== "worktree" || !["changed", "diverged"].includes(record.state))
          return yield* err("review_target", "Only a settled task with saved worktree changes can be reviewed.")
        if (!record.tip || !(record.reviewBase ?? record.seed))
          return yield* err("review_target", "The task has no saved review range.")
        const checked = yield* verify(record)
        const before = yield* inspectReview(checked)
        if (before.head !== checked.tip)
          return yield* err(
            "review_target",
            "The task checkout changed since it settled. Settle it again before reviewing.",
          )
        // The branch review covers saved commits only; unsaved edits must never be silently reported as reviewed.
        if (before.dirty)
          return yield* err("review_target", "The task has unsaved changes. Settle it again before reviewing.")
        const result = yield* use(checked)
        const current = yield* verify(checked)
        const after = yield* inspectReview(current)
        if (
          current.deleted ||
          current.parentSessionID !== checked.parentSessionID ||
          current.state !== checked.state ||
          current.attempt !== checked.attempt ||
          current.settledAttempt !== checked.settledAttempt ||
          current.tip !== checked.tip ||
          (current.reviewBase ?? current.seed) !== (checked.reviewBase ?? checked.seed) ||
          after.head !== checked.tip ||
          after.dirty
        )
          return yield* err(
            "review_target",
            "The task changed while it was being reviewed; the review was not accepted.",
          )
        return result
      }),
    )

  const identity = Effect.fn("TaskIsolation.identity")(function* (cwd: string) {
    const name = yield* run(cwd, ["config", "user.name"])
    const email = yield* run(cwd, ["config", "user.email"])
    return {
      ...(name.exitCode !== 0 || !name.text().trim()
        ? { GIT_AUTHOR_NAME: "Vector", GIT_COMMITTER_NAME: "Vector" }
        : {}),
      ...(email.exitCode !== 0 || !email.text().trim()
        ? { GIT_AUTHOR_EMAIL: "bot@vectordev.ai", GIT_COMMITTER_EMAIL: "bot@vectordev.ai" }
        : {}),
    }
  })
  const clearIndexFlags = Effect.fn("TaskIsolation.clearIndexFlags")(function* (cwd: string, index: string) {
    const files = yield* command(cwd, ["ls-files", "-z", "--cached"], { env: { GIT_INDEX_FILE: index } })
    if (!files.length) return
    for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"])
      yield* command(cwd, ["update-index", flag, "-z", "--stdin"], {
        env: { GIT_INDEX_FILE: index },
        stdin: Stream.make(files),
      })
  })
  const blobAt = Effect.fn("TaskIsolation.blobAt")(function* (record: Record, file: string) {
    const base = record.reviewBase ?? record.seed
    if (!base) return undefined
    const entry = yield* text(record.directory, ["--literal-pathspecs", "ls-tree", "-z", base, "--", file])
    const blob = entry.slice(0, entry.indexOf("\t")).split(" ")[2]
    return blob && /^[a-f0-9]{40,64}$/.test(blob) ? blob : undefined
  })
  const captureLargeBaseline = Effect.fn("TaskIsolation.captureLargeBaseline")(function* (record: Record) {
    const limits = yield* Limits
    const baseline: { [file: string]: { blob: string; hash: string } } = Object.create(null)
    const files = nuls(yield* command(record.directory, ["ls-files", "-z", "--cached"]))
    for (const file of files) {
      if (!relative(file)) return yield* err("path", "Git returned an unsafe baseline path.")
      const full = path.join(record.directory, file)
      const info = yield* io(() => lstat(full))
      if (!info.isFile() || info.size <= limits.fileBytes) continue
      if (!FSUtil.writableInside(record.directory, full))
        return yield* err("path", "An oversized baseline has an unsafe ancestor.")
      const blob = yield* blobAt(record, file)
      if (!blob) return yield* err("git", "An oversized baseline has no saved Git identity.")
      baseline[file] = { blob, hash: yield* io(() => IsolationCopy.hashFile(full)) }
    }
    return baseline
  })
  const unsupported = Effect.fn("TaskIsolation.unsupported")(function* (record: Record) {
    const limits = yield* Limits
    const files =
      record.mode === "copy"
        ? yield* io(() =>
            IsolationCopy.listProjectFiles(record.directory, record.directory, [], Number.MAX_SAFE_INTEGER),
          )
        : nuls(yield* command(record.directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    const output = new Set<string>()
    for (const file of new Set(files)) {
      if (!relative(file)) return yield* err("path", "An unsupported output has an unsafe path.")
      if (record.links.some((link) => file === link || file.startsWith(`${link}/`))) continue
      const current = yield* io(() =>
        lstat(path.join(record.directory, file)).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (!current?.isFile() || current.size <= limits.fileBytes) continue
      if (record.mode === "worktree") {
        const blob = yield* blobAt(record, file)
        if (!blob || !FSUtil.writableInside(record.directory, path.join(record.directory, file))) {
          output.add(file)
          continue
        }
        const baseline = record.largeBaseline?.[file]
        if (baseline?.blob === blob) {
          if ((yield* io(() => IsolationCopy.hashFile(path.join(record.directory, file)))) !== baseline.hash)
            output.add(file)
        } else if ((yield* text(record.directory, ["hash-object", "--no-filters", "--", file])) !== blob)
          output.add(file)
        continue
      }
      const baseline = path.join(baselinePaths(record).directory, file)
      const before = yield* io(() =>
        lstat(baseline).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (
        !before?.isFile() ||
        before.size !== current.size ||
        !FSUtil.writableInside(record.directory, path.join(record.directory, file)) ||
        !FSUtil.writableInside(baselinePaths(record).directory, baseline)
      ) {
        output.add(file)
        continue
      }
      if (
        (yield* io(() => IsolationCopy.hashFile(path.join(record.directory, file)))) !==
        (yield* io(() => IsolationCopy.hashFile(baseline)))
      )
        output.add(file)
    }
    if (record.mode === "copy") {
      const original = path.join(paths(record.projectID, record.taskID).registry, "baseline")
      const beforeLinks = yield* io(() => IsolationCopy.projectLinks(original))
      const currentLinks = yield* io(() => IsolationCopy.projectLinks(record.directory))
      for (const file of new Set([...Object.keys(beforeLinks), ...Object.keys(currentLinks)]))
        if (beforeLinks[file] !== currentLinks[file]) output.add(file)
      const root = baselinePaths(record).directory
      const files = yield* io(() => IsolationCopy.listProjectFiles(root, root, [], Number.MAX_SAFE_INTEGER))
      for (const file of files) {
        const before = yield* io(() => lstat(path.join(root, file)))
        if (before.size <= limits.fileBytes) continue
        const current = yield* io(() =>
          lstat(path.join(record.directory, file)).catch((cause) => {
            if (missing(cause)) return undefined
            throw cause
          }),
        )
        // Oversized baseline deletions and size reductions are also uncaptured changes.
        if (!current?.isFile() || current.size <= limits.fileBytes) output.add(file)
      }
      const baseline = yield* baselineHashes(record)
      const captured = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      for (const file of Object.keys(baseline).filter((file) => captured[file] === undefined)) {
        const present = yield* io(() =>
          lstat(path.join(record.directory, file)).catch((cause) => {
            if (missing(cause)) return undefined
            throw cause
          }),
        )
        if (present && !present.isDirectory()) output.add(file)
      }
    }
    return [...output].sort()
  })
  const retained = (record: Record, files: readonly string[], attempt = record.attempt) => ({
    ...record,
    state: "failed",
    settledAttempt: attempt,
    skipped: [...new Set([...(record.initialSkipped ?? []), ...files])],
    error: `${files.length} nonignored output${files.length === 1 ? " exceeds" : "s exceed"} the capture limit or cannot be captured. The checkout and its bytes have been retained; resume and reduce or move these outputs before merging or discarding.`,
  })
  const assertCaptured = Effect.fn("TaskIsolation.assertCaptured")(function* (record: Record) {
    yield* verify(record)
    const omitted = yield* unsupported(record)
    if (omitted.length) {
      const failed = retained(record, omitted)
      yield* save(failed)
      return yield* err("unsupported", failed.error)
    }
    if (!record.tip) return yield* err("unsaved", "The checkout has no saved snapshot and has been retained.")
    if (record.mode === "copy") {
      const limits = yield* Limits
      if (hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))) !== record.tip)
        return yield* err("unsaved", "The copy changed after it was saved; it has been retained.")
      return
    }
    const index = path.join(paths(record.projectID, record.taskID).registry, `inspect-index-${randomUUID()}`)
    const status = yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const source = path.resolve(
          record.directory,
          yield* text(record.directory, ["rev-parse", "--git-path", "index"]),
        )
        yield* io(() => copyFile(source, index))
        return index
      }),
      (index) =>
        Effect.gen(function* () {
          yield* clearIndexFlags(record.directory, index)
          return nuls(
            yield* command(
              record.directory,
              ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"],
              { env: { GIT_INDEX_FILE: index } },
            ),
          )
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
    if (
      (yield* text(record.directory, ["rev-parse", "HEAD"])) !== record.tip ||
      status.some(
        (line) => !record.links.some((file) => line.slice(3) === file || line.slice(3).startsWith(`${file}/`)),
      )
    )
      return yield* err("unsaved", "The checkout changed after it was saved; it has been retained.")
  })
  const protect = Effect.fn("TaskIsolation.protect")(function* (record: Record) {
    yield* verify(record)
    const gitDirectory =
      record.mode === "worktree"
        ? path.resolve(record.directory, yield* text(record.directory, ["rev-parse", "--git-dir"]))
        : undefined
    TaskClaims.protect({
      taskID: record.taskID,
      directories: [paths(record.projectID, record.taskID).registry, record.directory],
      parentDirectory: record.parentDirectory,
      workDirectory: record.directory,
      branch: record.branch,
      gitDirectory,
      privateDirectories: [paths(record.projectID, record.taskID).registry],
      immutableFiles: record.mode === "worktree" ? [path.join(record.directory, ".git")] : [],
    })
  })

  // Whether the disk holds one more isolated checkout of the project, and never less than the minimum free space: a
  // worktree needs about HEAD's tracked files; a copy writes the project twice, as the copy and its baseline.
  const room = Effect.fnUntraced(function* (mode: "worktree" | "copy", cwd: string, measured?: { bytes: number }) {
    const limits = yield* Limits
    const needed =
      mode === "copy"
        ? (measured ?? (yield* io(() => IsolationCopy.measureProject(cwd)))).bytes * 2
        : (yield* text(cwd, ["ls-tree", "-r", "-l", "HEAD"]))
            .split("\n")
            .reduce((sum, line) => sum + (Number(line.split(/\s+/)[3]) || 0), 0) * 1.5
    const disk = yield* io(() => statfs(Global.Path.data))
    if (disk.bavail * disk.bsize < Math.max(limits.minFreeBytes, needed))
      return yield* err("disk", "There is not enough free disk space for task isolation.")
  })

  const check = Effect.fn("TaskIsolation.check")(function* (input: CheckInput) {
    const limits = yield* Limits
    const ctx = yield* home
    if (!(yield* audience.canIsolate(input.parentSessionID, "owner")))
      return yield* err("guest", "Isolation requires an owner conversation without guest input.")
    if (Agent.readOnly(input.agent.name))
      return yield* err("readonly", "Read-only agents cannot run in task isolation.")
    for (
      let id: string | undefined = input.parentSessionID, seen = new Set<string>();
      id && !seen.has(id);
      id = TaskPlace.parentOf(id)
    ) {
      seen.add(id)
      const place = TaskPlace.get(id)
      if (place && FileLock.key(place.work.directory) !== FileLock.key(place.home.directory))
        return yield* err("nested", "Nested task isolation is not supported.")
      if (yield* optional(id)) return yield* err("nested", "An isolated task cannot launch nested isolation.")
    }
    const existing = yield* records()
    const max = (yield* config.get()).sizing?.subagents?.isolation?.max_kept ?? 20
    // A deleted conversation's changes wait only for the sweep, which discards them; they no longer await review. The
    // task being resumed is not counted: resuming moves its record from changed to running, which adds no kept record.
    if (
      existing.filter((record) => record.state === "changed" && !record.deleted && record.taskID !== input.resumeID)
        .length >= max
    )
      return yield* err("kept", "Review, merge or discard existing isolated tasks before starting another.")
    // A child stopped before its run took a slot has its assignment but no reservation yet; it is reserved on resume.
    const resumed = input.resumeID ? yield* optional(input.resumeID) : undefined
    if (resumed && (resumed.agent.name !== input.agent.name || resumed.parentSessionID !== input.parentSessionID))
      return yield* err("resume", "The resumed task's isolation does not match this launch.")
    const cwd = ctx.worktree === path.parse(ctx.worktree).root ? ctx.directory : ctx.worktree
    const repository = yield* run(cwd, ["rev-parse", "--is-inside-work-tree"])
    const head = repository.exitCode === 0 ? yield* run(cwd, ["rev-parse", "--verify", "HEAD"]) : undefined
    const mode = head?.exitCode === 0 ? ("worktree" as const) : ("copy" as const)
    const sparse = repository.exitCode === 0 ? yield* run(cwd, ["config", "--bool", "core.sparseCheckout"]) : undefined
    if (sparse?.text().trim() === "true")
      return yield* err("sparse", "Task isolation does not support sparse checkouts.")
    const total = mode === "copy" ? yield* io(() => IsolationCopy.measureProject(cwd)) : undefined
    yield* room(mode, cwd, total)
    if (total) {
      if (total.files > limits.copyFiles)
        return yield* err("copy_limit", "The project exceeds the isolation copy file limit.")
      if (total.bytes > limits.copyBytes)
        return yield* err("copy_limit", "The project exceeds the isolation copy byte limit.")
    }
    return { mode, directory: cwd }
  })

  const reserve = Effect.fn("TaskIsolation.reserve")(function* (input: ReserveInput) {
    const ctx = yield* home
    const admitted = yield* check(input)
    const location = paths(ctx.project.id, input.taskID)
    // Only an isolated dependency with saved, unmerged changes is stacked (F.4 start step 2). A shared, unchanged,
    // discarded or merged one has nothing to stack: its work is already in the parent's files, or not there at all.
    const stacked = yield* Effect.filter(input.dependsOn ?? [], (id) =>
      safeID(id) ? optional(id).pipe(Effect.map((record) => record?.state === "changed")) : Effect.succeed(false),
    )
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        yield* audience.fenceIsolation({ sessionID: input.taskID, actor: "owner", directory: location.directory })
        yield* audience.fenceIsolation({ sessionID: input.taskID, actor: "owner", directory: location.registry })
        if (
          yield* io(() =>
            lstat(location.file)
              .then(() => true)
              .catch((cause) => {
                if (missing(cause)) return false
                throw cause
              }),
          )
        )
          return yield* err("exists", "Task isolation is already reserved; resume it explicitly.")
        const record: Record = {
          version: 1,
          projectID: ctx.project.id,
          taskID: input.taskID,
          parentSessionID: input.parentSessionID,
          parentDirectory: admitted.directory,
          homeDirectory: ctx.directory,
          directory: location.directory,
          mode: admitted.mode,
          state: "preparing",
          title: input.title,
          agent: resolution(input.agent),
          attempt: input.attempt ?? 1,
          createdAt: Date.now(),
          ...(admitted.mode === "worktree" ? { branch: location.branch } : {}),
          links: [],
          skipped: [],
          initialSkipped: [],
          stacked,
          merged: [],
          files: [],
        }
        yield* save(record)
        TaskClaims.protect({
          taskID: record.taskID,
          directories: [location.registry, record.directory],
          parentDirectory: record.parentDirectory,
          workDirectory: record.directory,
          branch: record.branch,
          privateDirectories: [location.registry],
          immutableFiles: record.mode === "worktree" ? [path.join(record.directory, ".git")] : [],
        })
        return record
      }),
    )
  })

  /** Parent staging uses a private index; settlement owns the task's index. Paths remain NUL literal pathspecs. */
  const stage = Effect.fn("TaskIsolation.stage")(function* (
    record: Record,
    cwd: string,
    index: string,
    initial: boolean,
  ) {
    const limits = yield* Limits
    const sparse = new Set(
      nuls(yield* command(cwd, ["ls-files", "-v", "-z"], { env: { GIT_INDEX_FILE: index } }))
        .filter((entry) => entry[0]?.toLowerCase() === "s")
        .map((entry) => entry.slice(2)),
    )
    yield* clearIndexFlags(cwd, index)
    const listed = nuls(yield* command(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    const tracked = initial ? new Set(nuls(yield* command(cwd, ["ls-files", "-z", "--cached"]))) : undefined
    const eligible: string[] = [],
      skipped: string[] = []
    for (const file of [...new Set(listed)]) {
      if (!relative(file)) return yield* err("path", "Git returned an unsafe isolation path.")
      if (record.links.some((link) => file === link || file.startsWith(`${link}/`))) continue
      const info = yield* io(() =>
        lstat(path.join(cwd, file)).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      // Missing sparse entries are not authority to manufacture a deletion in the captured tree.
      if (!info && sparse.has(file)) continue
      if (info && info.size > limits.fileBytes && (!initial || !tracked?.has(file))) {
        skipped.push(file)
        continue
      }
      eligible.push(file)
    }
    if (eligible.length)
      yield* command(cwd, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env: { GIT_INDEX_FILE: index },
        stdin: Stream.make(Buffer.from(eligible.join("\0") + "\0")),
      })
    return skipped
  })

  const seed = Effect.fn("TaskIsolation.seed")(function* (record: Record) {
    const registry = paths(record.projectID, record.taskID).registry
    const index = path.join(registry, `index-${randomUUID()}`)
    return yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        const source = yield* text(record.parentDirectory, ["rev-parse", "--git-path", "index"])
        yield* io(() =>
          copyFile(path.resolve(record.parentDirectory, source), index).catch((cause) => {
            if (!missing(cause)) throw cause
          }),
        )
        return index
      }),
      (index) =>
        Effect.gen(function* () {
          const skipped = yield* stage(record, record.parentDirectory, index, true)
          const parentTree = yield* text(record.parentDirectory, ["rev-parse", "HEAD^{tree}"])
          const head = yield* text(record.parentDirectory, ["rev-parse", "HEAD"])
          const beforeStack = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          const unstackedSeed =
            beforeStack === parentTree
              ? head
              : yield* text(
                  record.parentDirectory,
                  [
                    "-c",
                    "commit.gpgsign=false",
                    "commit-tree",
                    beforeStack,
                    "-p",
                    head,
                    "-m",
                    `Vector: your uncommitted changes when ${record.title} started`,
                  ],
                  { env: yield* identity(record.parentDirectory) },
                )
          for (const id of record.stacked) {
            const dependency = yield* get(id)
            if (dependency.state === "merged") continue
            if (dependency.state !== "changed" || !dependency.seed || !dependency.tip)
              return yield* err("dependency", "An isolated dependency has no saved changes to stack.")
            const patch = yield* command(record.parentDirectory, [
              "diff",
              "--binary",
              dependency.reviewBase ?? dependency.seed,
              dependency.tip,
            ])
            const original = yield* io(() => readFile(index))
            const applied = yield* run(record.parentDirectory, ["apply", "--cached", "--3way", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(patch),
            })
            if (applied.exitCode !== 0 || /with conflicts\.$/m.test(applied.stderr.toString())) {
              yield* io(() => writeFile(index, original))
              yield* command(record.parentDirectory, ["apply", "--cached", "--binary", "-"], {
                env: { GIT_INDEX_FILE: index },
                stdin: Stream.make(patch),
              })
            }
          }
          const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          // The stacked seed builds on the unstacked one, so the task's branch reaches it: an owner's includeStacked
          // merge and discard read it later, and Git's gc prunes a commit that no branch or ref reaches.
          const commit =
            tree === beforeStack
              ? unstackedSeed
              : yield* text(
                  record.parentDirectory,
                  [
                    "-c",
                    "commit.gpgsign=false",
                    "commit-tree",
                    tree,
                    "-p",
                    unstackedSeed,
                    "-m",
                    `Vector: the changes of ${record.stacked.join(", ")}, stacked when ${record.title} started`,
                  ],
                  { env: yield* identity(record.parentDirectory) },
                )
          return { seed: commit, skipped, initialSkipped: skipped, ...(record.stacked.length ? { unstackedSeed } : {}) }
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
  })

  const start = Effect.fn("TaskIsolation.start")(function* (taskID: string) {
    const limits = yield* Limits
    return yield* lock(
      taskID,
      Effect.gen(function* () {
        const ctx = yield* home
        const reserved = yield* get(taskID)
        if (reserved.state !== "preparing") return yield* err("state", "Isolation is not waiting to start.")
        // A dependency merged or discarded since the reservation has nothing left to stack: merged work is already in
        // the parent's files. Without this, a reservation would keep failing to start on every resume.
        const record = {
          ...reserved,
          stacked: yield* Effect.filter(reserved.stacked, (id) =>
            optional(id).pipe(Effect.map((dependency) => dependency?.state === "changed")),
          ),
        }
        yield* audience.fenceIsolation({ sessionID: taskID, actor: "owner", directory: record.directory })
        return yield* Effect.gen(function* () {
          const service = yield* worktrees()
          const settings = (yield* config.get()).sizing?.subagents?.isolation
          const created = yield* FileLock.forTree(record.parentDirectory)(
            Effect.gen(function* () {
              // Checked again under the folder's lock: launches that passed `check` together all read the free space
              // before any of them wrote a checkout, and each one created before this one has used some of it.
              yield* room(record.mode, record.parentDirectory)
              if (record.mode === "copy") {
                if (
                  yield* io(() =>
                    lstat(record.directory)
                      .then(() => true)
                      .catch((cause) => {
                        if (missing(cause)) return false
                        throw cause
                      }),
                  )
                )
                  return yield* err("exists", "The reserved copy directory already exists; it has not been changed.")
                // A resume whose copy was removed starts here again; its earlier baselines describe older files.
                yield* io(() => dropBaselines(record))
                const copied = yield* io(() =>
                  IsolationCopy.copyProject(record.parentDirectory, record.directory, {
                    maxFiles: limits.copyFiles,
                    maxBytes: limits.copyBytes,
                  }),
                )
                const hashes = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
                yield* io(() =>
                  privateJSON(path.join(paths(record.projectID, taskID).registry, "baseline.json"), hashes),
                )
                yield* io(() =>
                  IsolationCopy.copyProject(
                    record.directory,
                    path.join(paths(record.projectID, taskID).registry, "baseline"),
                    { maxFiles: limits.copyFiles, maxBytes: limits.copyBytes },
                  ),
                )
                yield* io(() => privateTree(path.join(paths(record.projectID, taskID).registry, "baseline")))
                return yield* stackCopy({
                  ...record,
                  state: "preparing",
                  skipped: copied.skipped,
                  initialSkipped: copied.skipped,
                })
              }
              const seeded = yield* seed(record)
              const next = { ...record, ...seeded, state: "preparing" }
              yield* save(next)
              yield* service
                .createForTask(
                  { name: taskID, directory: record.directory, branch: record.branch },
                  { from: seeded.seed, env: { GIT_LFS_SKIP_SMUDGE: "1" } },
                )
                .pipe(Effect.provideService(InstanceRef, ctx))
              const bound = {
                ...next,
                gitDirectory: path.resolve(record.directory, yield* text(record.directory, ["rev-parse", "--git-dir"])),
                gitCommonDirectory: path.resolve(
                  record.directory,
                  yield* text(record.directory, ["rev-parse", "--git-common-dir"]),
                ),
              }
              yield* audience.fenceIsolation({ sessionID: taskID, actor: "owner", directory: bound.gitDirectory })
              yield* save(bound)
              return bound
            }),
          )
          yield* protect(created)
          yield* config.inheritTrust(created.directory)
          const links: string[] = []
          for (const link of settings?.link ?? []) {
            if (!relative(link) || created.mode !== "worktree")
              return yield* err("link", "Only relative ignored directory links can be used in a Git isolation.")
            const target = yield* io(() => realpath(path.join(created.parentDirectory, link)))
            const info = yield* io(() => lstat(target))
            if (
              !inside(yield* io(() => realpath(created.parentDirectory)), target) ||
              !info.isDirectory() ||
              (yield* run(created.parentDirectory, ["check-ignore", "--quiet", "--", link])).exitCode !== 0
            )
              return yield* err("link", "Isolation links must be ignored directories inside the launching checkout.")
            const to = path.join(created.directory, link)
            if (!FSUtil.writableInside(created.directory, to))
              return yield* err("link", "Isolation link destination is unsafe.")
            yield* io(async () => {
              await mkdir(path.dirname(to), { recursive: true })
              await symlink(target, to, process.platform === "win32" ? "junction" : "dir")
            })
            links.push(link)
          }
          const linked = {
            ...created,
            links,
            ...(created.mode === "worktree" ? { largeBaseline: yield* captureLargeBaseline(created) } : {}),
          }
          yield* save(linked)
          const loaded = yield* loadWork(linked, ctx)
          const work = loaded.work
          const resolved = yield* agents.get(linked.agent.name).pipe(Effect.provideService(InstanceRef, work))
          if (!resolved || stable(resolution(resolved)) !== stable(linked.agent)) {
            return yield* err("agent", "Agent configuration differs in the isolated instance; no model was started.")
          }
          const ready = { ...linked, state: "running" }
          yield* save(ready)
          TaskPlace.set(taskID, { work, home: ctx })
          loaded.transferred = true
          return {
            record: ready,
            work,
            brief: `You work in an isolated copy of the repository at ${linked.directory}${linked.branch ? ` (git worktree on branch ${linked.branch})` : ""}, made from the parent's files when you started, including their uncommitted changes${linked.stacked.length ? `, plus the changes of ${linked.stacked.join(", ")}` : ""}. Paths under ${linked.parentDirectory} in this conversation are under ${linked.directory} for you. Edit and run checks here; nothing reaches the parent's files until the parent merges your work. You may commit on your branch; do not switch branches, stash or push. Ignored files such as node_modules are not here${links.length ? `; linked: ${links.join(", ")}` : ""}${linked.skipped.length ? `; left out: ${linked.skipped.join(", ")}` : ""}. ${TERMINALS} List the files you changed in your report.`,
          }
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            get(taskID).pipe(
              Effect.flatMap((record) => {
                const failed = { ...record, state: "failed", error: Cause.pretty(cause) }
                return save(failed).pipe(Effect.ensuring(retire(failed).pipe(Effect.orDie)))
              }),
              Effect.uninterruptible,
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        )
      }),
    )
  })

  const retire = Effect.fn("TaskIsolation.retire")(function* (record: Record) {
    const work = active.get(record.taskID) ?? TaskPlace.get(record.taskID)?.work
    if (work && FileLock.key(work.directory) === FileLock.key(record.directory)) {
      yield* quiesce(record.taskID, work, locations)
      const store = yield* instances()
      yield* store.dispose(work)
    }
    active.delete(record.taskID)
    TaskPlace.dropWork(record.taskID)
  })
  const loadWork = Effect.fn("TaskIsolation.loadWork")(function* (record: Record, ctx: InstanceContext) {
    const store = yield* instances()
    return yield* Effect.acquireRelease(
      store.load({ directory: record.directory, worktree: record.directory, project: ctx.project }).pipe(
        Effect.map((work) => {
          active.set(record.taskID, work)
          return { work, transferred: false }
        }),
      ),
      (entry) => (entry.transferred ? Effect.void : retire(record).pipe(Effect.orDie)),
    )
  })
  const unlinkLinks = (record: Record) =>
    io(async () => {
      for (const link of record.links) {
        const file = path.join(record.directory, link)
        await guarded(path.dirname(file), record.directory)
        const info = await lstat(file).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        })
        if (info && !info.isSymbolicLink())
          throw err("link", "An isolation link was replaced; refusing recursive removal.")
        if (info) await unlink(file)
      }
    })
  const remove = Effect.fn("TaskIsolation.remove")(function* (record: Record) {
    const valid = yield* verify(record)
    yield* assertCaptured(valid)
    yield* unlinkLinks(valid)
    if (valid.mode === "worktree") {
      // Whatever is removed has its patch saved or nothing left to merge, so its pinned bases go first: a removal that
      // fails after them leaves nothing that needs them.
      const pinned = (yield* text(valid.parentDirectory, ["for-each-ref", "--format=%(refname)", pins(valid.taskID)]))
        .split("\n")
        .filter(Boolean)
      if (pinned.length)
        yield* command(valid.parentDirectory, ["update-ref", "--stdin"], {
          stdin: Stream.make(Buffer.from(pinned.map((ref) => `delete ${ref}\n`).join(""))),
        })
      const service = yield* worktrees()
      const ctx = yield* home
      yield* service
        .removeForTask({ name: valid.taskID, directory: valid.directory, branch: valid.branch! })
        .pipe(Effect.provideService(InstanceRef, ctx))
    } else {
      yield* io(() => rm(valid.directory, { recursive: true, force: true }))
      yield* io(() => dropBaselines(valid))
    }
    yield* io(() => WorkspaceTrust.forget(Global.Path.state, valid.directory))
    TaskClaims.unprotect(valid.taskID)
  })
  const stats = Effect.fn("TaskIsolation.stats")(function* (record: Record) {
    const limits = yield* Limits
    if (record.mode === "copy") {
      const baseline = yield* baselineHashes(record)
      const current = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      const differences = yield* Effect.forEach(
        [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
          .filter((file) => baseline[file] !== current[file])
          .sort(),
        (file) =>
          Effect.gen(function* () {
            if (baseline[file] && current[file] === undefined) {
              const present = yield* io(() =>
                lstat(path.join(record.directory, file)).catch((cause) => {
                  if (missing(cause)) return undefined
                  throw cause
                }),
              )
              // An omitted existing file is unsupported, not a deletion. Settlement retains it before capture.
              if (present && !present.isDirectory()) return undefined
            }
            const before = baseline[file]
              ? yield* io(() => readFile(path.join(baselinePaths(record).directory, file)))
              : Buffer.alloc(0)
            const after = current[file] ? yield* io(() => readFile(path.join(record.directory, file))) : Buffer.alloc(0)
            const binary = before.includes(0) || after.includes(0)
            const delta = binary ? [] : diffLines(before.toString(), after.toString())
            return {
              path: file,
              status: !current[file] ? "deleted" : !baseline[file] ? "added" : "modified",
              additions: delta.reduce((sum, item) => sum + (item.added ? (item.count ?? 0) : 0), 0),
              deletions: delta.reduce((sum, item) => sum + (item.removed ? (item.count ?? 0) : 0), 0),
              binary,
            }
          }),
      )
      return differences.filter((file) => file !== undefined)
    }
    if (!record.seed || !record.tip) return []
    const names = nuls(
      yield* command(record.parentDirectory, [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        record.reviewBase ?? record.seed,
        record.tip,
      ]),
    )
    const numbers = nuls(
      yield* command(record.parentDirectory, [
        "diff",
        "--numstat",
        "--no-renames",
        "-z",
        record.reviewBase ?? record.seed,
        record.tip,
      ]),
    )
    return numbers.map((line, index) => {
      const [add, del, ...file] = line.split("\t")
      return {
        path: file.join("\t"),
        status: names[index * 2] === "A" ? "added" : names[index * 2] === "D" ? "deleted" : "modified",
        additions: Number(add) || 0,
        deletions: Number(del) || 0,
        binary: add === "-" || del === "-",
      }
    })
  })
  // A start that failed or was stopped before its checkout existed (a stacked dependency that conflicts, a Stop while
  // seeding) has no saved tip, no checkout and no reserved branch: nothing to save, keep or recover.
  const vacant = Effect.fnUntraced(function* (record: Record) {
    if (record.tip || !["preparing", "failed"].includes(record.state) || (yield* io(() => present(record.directory))))
      return false
    if (record.mode === "copy") return true
    return (
      (yield* run(record.parentDirectory, ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`]))
        .exitCode !== 0
    )
  })
  // Such a task ends unchanged and keeps start's error for the owner, so discard, sweep and recovery are done with it.
  const vacate = Effect.fnUntraced(function* (record: Record, attempt: number) {
    const empty = {
      ...record,
      state: "unchanged",
      settledAttempt: attempt,
      error: record.error ?? "The isolated checkout was never made.",
    }
    yield* save(empty)
    yield* retire(empty)
    TaskClaims.unprotect(record.taskID)
    return empty
  })
  const settle = Effect.fn("TaskIsolation.settle")(function* (input: {
    taskID: string
    attempt: number
    recover?: boolean
  }) {
    const limits = yield* Limits
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (record.settledAttempt === input.attempt && !(input.recover && record.state === "failed")) return record
        if (record.attempt !== input.attempt) return record
        // Recovery never saves work this process is still running; its own finalizer does that.
        if (input.recover && active.has(record.taskID)) return record
        if (yield* vacant(record)) return yield* vacate(record, input.attempt)
        yield* verify(record)
        yield* save({ ...record, state: "settling" })
        const placed = active.get(record.taskID) ?? TaskPlace.get(record.taskID)?.work
        const work = placed && FileLock.key(placed.directory) === FileLock.key(record.directory) ? placed : undefined
        // The running parent's own finalizer calls settle; only descendants are stopped here.
        if (work) yield* quiesce(record.taskID, work, locations)
        const omitted = yield* unsupported(record)
        if (omitted.length) {
          const failed = retained(record, omitted, input.attempt)
          yield* save(failed)
          yield* retire(failed)
          return failed
        }
        const saved =
          record.mode === "copy"
            ? {
                ...record,
                files: yield* stats(record),
                skipped: record.initialSkipped ?? [],
                tip: hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))),
              }
            : yield* Effect.gen(function* () {
                const index = path.resolve(
                  record.directory,
                  yield* text(record.directory, ["rev-parse", "--git-path", "index"]),
                )
                const skipped = yield* stage(record, record.directory, index, false)
                const excluded = [...skipped, ...record.links]
                if (excluded.length)
                  yield* command(
                    record.directory,
                    [
                      "--literal-pathspecs",
                      "reset",
                      "--quiet",
                      record.reviewBase ?? record.seed!,
                      "--pathspec-from-file=-",
                      "--pathspec-file-nul",
                    ],
                    { stdin: Stream.make(Buffer.from(excluded.join("\0") + "\0")) },
                  )
                const dirty = yield* text(record.directory, ["diff", "--cached", "--name-only"])
                if (dirty)
                  yield* command(
                    record.directory,
                    [
                      "-c",
                      `core.hooksPath=${os.devNull}`,
                      "-c",
                      "commit.gpgsign=false",
                      "commit",
                      "-m",
                      `Vector subagent: ${record.title}`,
                    ],
                    { env: yield* identity(record.directory) },
                  )
                const tip = yield* text(record.directory, ["rev-parse", "HEAD"])
                const next = { ...record, tip, skipped: [...new Set([...(record.initialSkipped ?? []), ...skipped])] }
                return { ...next, files: yield* stats(next) }
              })
        const diverged =
          saved.mode === "worktree" &&
          saved.seed &&
          saved.tip &&
          (yield* run(saved.parentDirectory, ["merge-base", "--is-ancestor", saved.seed, saved.tip])).exitCode !== 0
        const final = {
          ...saved,
          state: diverged ? "diverged" : saved.files.length ? "changed" : "unchanged",
          settledAttempt: input.attempt,
          error: undefined,
        }
        yield* save(final)
        yield* retire(final)
        if (final.state === "unchanged") yield* FileLock.forTree(final.parentDirectory)(remove(final))
        return final
      }).pipe(
        Effect.catchCause((cause) =>
          get(input.taskID).pipe(
            Effect.flatMap((record) => {
              const failed = { ...record, state: "failed", error: String(cause), settledAttempt: input.attempt }
              return save(failed).pipe(Effect.andThen(retire(failed)), Effect.as(failed))
            }),
          ),
        ),
      ),
    )
  })

  const markSettling = Effect.fn("TaskIsolation.markSettling")(function* (taskID: string, attempt: number) {
    return yield* lock(
      taskID,
      Effect.gen(function* () {
        const record = yield* optional(taskID)
        if (
          !record ||
          record.attempt !== attempt ||
          record.settledAttempt === attempt ||
          !["running", "settling"].includes(record.state)
        )
          return record
        const next = { ...record, state: "settling" }
        yield* save(next)
        return next
      }),
    )
  })

  const patch = Effect.fn("TaskIsolation.patch")(function* (record: Record, selected?: readonly string[]) {
    const limits = yield* Limits
    if (["merged", "discarded"].includes(record.state) && record.savedPatch)
      return yield* io(async () => {
        await guarded(record.savedPatch!)
        const handle = await open(record.savedPatch!, "r")
        return (async () => {
          const bytes = Buffer.alloc(limits.patchBytes)
          const read = await handle.read(bytes)
          const size = (await handle.stat()).size
          const encoded = Buffer.from(bytes.subarray(0, read.bytesRead).toString("utf8"))
          return {
            patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
            truncated: size > read.bytesRead || encoded.length > limits.patchBytes,
          }
        })().finally(() => handle.close())
      })
    if (record.mode === "copy") {
      const parts: string[] = []
      for (const file of record.files.filter((file) => !selected || selected.includes(file.path))) {
        const before =
          file.status === "added"
            ? Buffer.alloc(0)
            : yield* io(() => readFile(path.join(baselinePaths(record).directory, file.path)))
        const after =
          file.status === "deleted"
            ? Buffer.alloc(0)
            : yield* io(() => readFile(path.join(record.directory, file.path)))
        parts.push(
          file.binary
            ? `Binary file ${file.path} changed\n`
            : createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, before.toString(), after.toString()),
        )
        if (Buffer.byteLength(parts.join("")) > limits.patchBytes) break
      }
      const encoded = Buffer.from(parts.join(""))
      return {
        patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
        truncated: encoded.length > limits.patchBytes,
      }
    }
    if (!record.seed || !record.tip) return { patch: "", truncated: false }
    const result = yield* run(
      record.parentDirectory,
      [
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        record.reviewBase ?? record.seed,
        record.tip,
        "--",
        ...(selected ?? []),
      ],
      { maxOutputBytes: limits.patchBytes },
    )
    if (result.exitCode !== 0) return yield* err("git", result.stderr.toString())
    const encoded = Buffer.from(result.stdout.toString("utf8"))
    return {
      patch: new TextDecoder().decode(encoded.subarray(0, limits.patchBytes), { stream: true }),
      truncated: result.truncated || encoded.length > limits.patchBytes,
    }
  })
  const changes = Effect.fn("TaskIsolation.changes")(function* (input: {
    taskID: string
    diff?: boolean
    control?: boolean
    review?: boolean
  }) {
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        const remaining = record.files.filter((file) => !record.merged.includes(file.path))
        if (!input.diff && !input.review)
          return {
            record,
            files: remaining,
            patch: undefined,
            truncated: false,
            mergeable: record.mergeable ?? "unknown",
          }
        if (input.diff && !input.control)
          return yield* err("forbidden", "Only the owner or a task controller may inspect an isolation patch.")
        // A task still preparing, running or saving has no snapshot of this attempt to show or assess, and cannot merge.
        // It gets its stored counts without Git or hashing, because a Stop's completion barrier takes this lock to
        // record `settling`, and a Changes view must not keep that Stop waiting.
        if (["preparing", "running", "settling"].includes(record.state))
          return { record, files: remaining, patch: undefined, truncated: false, mergeable: "blocked" }
        const data = input.diff ? yield* patch(record) : undefined
        const limits = yield* Limits
        const status =
          record.mode === "copy"
            ? hash(stable(yield* io(() => IsolationCopy.hashProject(record.parentDirectory, limits.fileBytes))))
            : yield* parentTree(record)
        const head = record.mode === "copy" ? "copy" : yield* text(record.parentDirectory, ["rev-parse", "HEAD"])
        const key = stable([record.tip, record.reviewBase, record.copyBase, head, status, record.merged])
        const assessed =
          record.state === "changed" && record.mergeKey !== key
            ? yield* prepare(
                record,
                remaining.map((file) => file.path),
                [],
                record.mode === "worktree" ? status : undefined,
              )
            : undefined
        const next = {
          ...record,
          mergeKey: key,
          mergeable:
            record.state !== "changed"
              ? "blocked"
              : record.mergeKey === key
                ? (record.mergeable ?? "unknown")
                : assessed?.conflicts.length
                  ? "conflict"
                  : "clean",
        }
        yield* save(next)
        return {
          record: next,
          files: remaining,
          ...(data ? { patch: data.patch } : {}),
          truncated: data?.truncated ?? false,
          mergeable: next.mergeable,
        }
      }),
    )
  })

  const blob = Effect.fn("TaskIsolation.blob")(function* (record: Record, tree: string, file: string, filters = false) {
    const listing = nuls(
      yield* command(record.parentDirectory, ["--literal-pathspecs", "ls-tree", "-z", tree, "--", file]),
    )
    const line = listing.find((line) => line.slice(line.indexOf("\t") + 1) === file)
    if (!line) return undefined
    const [mode, type, object] = line.slice(0, line.indexOf("\t")).split(" ")
    if (type !== "blob" || !object || !["100644", "100755", "120000"].includes(mode!))
      return yield* err("path", "Isolation merge does not support submodules or special files.")
    return {
      mode: mode!,
      bytes: yield* command(
        record.parentDirectory,
        filters && mode !== "120000"
          ? ["cat-file", "--filters", `--path=${file}`, `${tree}:${file}`]
          : ["cat-file", "blob", object],
      ),
    }
  })

  /** Write the parent's working files into a temporary index/tree, preserving the real index byte for byte. */
  const parentTree = Effect.fn("TaskIsolation.parentTree")(function* (record: Record, omit: readonly string[] = []) {
    const temp = path.join(paths(record.projectID, record.taskID).registry, `merge-index-${randomUUID()}`)
    return yield* Effect.acquireUseRelease(
      Effect.succeed(temp),
      (index) =>
        Effect.gen(function* () {
          yield* command(record.parentDirectory, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index } })
          yield* stage({ ...record, links: [] }, record.parentDirectory, index, true)
          if (omit.length)
            yield* command(record.parentDirectory, ["update-index", "--force-remove", "-z", "--stdin"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(Buffer.from(omit.join("\0") + "\0")),
            })
          return yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
  })
  const prepare = Effect.fn("TaskIsolation.prepare")(function* (
    record: Record,
    selected: readonly string[],
    omit: readonly string[] = [],
    currentTree?: string,
  ) {
    const limits = yield* Limits
    if (record.mode === "copy") {
      const omitted = yield* unsupported(record)
      if (omitted.length) return yield* err("unsupported", retained(record, omitted).error)
      const baseline = yield* baselineHashes(record)
      const parent = yield* io(() => IsolationCopy.hashProject(record.parentDirectory, limits.fileBytes))
      const child = yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes))
      if (record.tip && hash(stable(child)) !== record.tip)
        return yield* err(
          "unsaved",
          "The saved copy changed after settlement; resume it before merging or stacking it.",
        )
      const conflicts = selected.filter(
        (file) => !omit.includes(file) && parent[file] !== baseline[file] && parent[file] !== child[file],
      )
      const blobs = new Map<string, Blob>()
      for (const file of selected) {
        if (!child[file]) {
          blobs.set(file, undefined)
          continue
        }
        if (!FSUtil.writableInside(record.directory, path.join(record.directory, file)))
          return yield* err("path", "Copy merge source is no longer an ordinary project file.")
        const bytes = yield* io(() => readFile(path.join(record.directory, file)))
        if (hash(bytes) !== child[file]) return yield* err("changed", "Copy merge source changed during review.")
        const mode = yield* io(() => lstat(path.join(record.directory, file)))
        blobs.set(file, { mode: mode.mode & 0o111 ? "100755" : "100644", bytes })
      }
      return { conflicts, blobs }
    }
    if (!record.seed || !record.tip) return yield* err("state", "The isolation has no saved Git result.")
    const base = record.reviewBase ?? record.seed
    const current = currentTree ?? (yield* parentTree(record, omit))
    const identityEnv = yield* identity(record.parentDirectory)
    const parentCommit = yield* text(
      record.parentDirectory,
      ["-c", "commit.gpgsign=false", "commit-tree", current, "-p", base, "-m", "Vector isolation merge preview"],
      { env: identityEnv },
    )
    const selectedIndex = path.join(paths(record.projectID, record.taskID).registry, `selection-index-${randomUUID()}`)
    const selectedTip = yield* Effect.acquireUseRelease(
      Effect.succeed(selectedIndex),
      (index) =>
        Effect.gen(function* () {
          yield* command(record.parentDirectory, ["read-tree", base], { env: { GIT_INDEX_FILE: index } })
          const delta = yield* command(record.parentDirectory, [
            "--literal-pathspecs",
            "diff",
            "--binary",
            base,
            record.tip!,
            "--",
            ...selected,
          ])
          if (delta.length)
            yield* command(record.parentDirectory, ["apply", "--cached", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(delta),
            })
          const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
          return yield* text(
            record.parentDirectory,
            ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", base, "-m", "Vector selected isolation changes"],
            { env: identityEnv },
          )
        }),
      (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
    )
    const merged = yield* run(record.parentDirectory, [
      "merge-tree",
      "--write-tree",
      "--messages",
      "-z",
      parentCommit,
      selectedTip,
    ])
    if (merged.exitCode !== 0 && /unknown option|usage: git merge-tree/i.test(merged.stderr.toString())) {
      const index = path.join(paths(record.projectID, record.taskID).registry, `fallback-index-${randomUUID()}`)
      return yield* Effect.acquireUseRelease(
        Effect.succeed(index),
        (index) =>
          Effect.gen(function* () {
            yield* command(record.parentDirectory, ["read-tree", current], { env: { GIT_INDEX_FILE: index } })
            const delta = yield* command(record.parentDirectory, ["diff", "--binary", base, selectedTip])
            const checked = yield* run(
              record.parentDirectory,
              ["apply", "--cached", "--3way", "--check", "--binary", "-"],
              { env: { GIT_INDEX_FILE: index }, stdin: Stream.make(delta) },
            )
            if (checked.exitCode !== 0 || /^Applied patch to '.*' with conflicts\.$/m.test(checked.stderr.toString()))
              return { conflicts: [...selected], blobs: new Map<string, Blob>() }
            // --check is allowed to update this disposable index; reset it before computing the actual resolved tree.
            yield* command(record.parentDirectory, ["read-tree", current], { env: { GIT_INDEX_FILE: index } })
            const applied = yield* run(record.parentDirectory, ["apply", "--cached", "--3way", "--binary", "-"], {
              env: { GIT_INDEX_FILE: index },
              stdin: Stream.make(delta),
            })
            if (applied.exitCode !== 0 || /^Applied patch to '.*' with conflicts\.$/m.test(applied.stderr.toString()))
              return { conflicts: [...selected], blobs: new Map<string, Blob>() }
            const tree = yield* text(record.parentDirectory, ["write-tree"], { env: { GIT_INDEX_FILE: index } })
            const blobs = new Map<string, Blob>()
            for (const file of selected) blobs.set(file, yield* blob(record, tree, file, true))
            return { conflicts: [] as string[], blobs }
          }),
        (index) => io(() => rm(index, { force: true })).pipe(Effect.orDie),
      )
    }
    if (merged.exitCode !== 0) {
      const output = nuls(merged.stdout)
      const conflicts = output
        .filter((line) => /^\d{6} [0-9a-f]+ [123]\t/.test(line))
        .map((line) => line.slice(line.indexOf("\t") + 1))
      return { conflicts: [...new Set(conflicts.length ? conflicts : selected)], blobs: new Map<string, Blob>() }
    }
    const tree = nuls(merged.stdout)[0]?.trim()
    if (!tree || !/^[a-f0-9]{40,64}$/.test(tree))
      return yield* err("git_version", "Isolation merge requires Git 2.38 or newer.")
    const blobs = new Map<string, Blob>()
    for (const file of selected) blobs.set(file, yield* blob(record, tree, file, true))
    return { conflicts: [] as string[], blobs }
  })

  const stackCopy = Effect.fn("TaskIsolation.stackCopy")(function* (record: Record) {
    if (!record.stacked.length) return record
    const selected = new Set<string>()
    for (const id of record.stacked) {
      const dependency = yield* get(id)
      if (dependency.state === "merged") continue
      if (dependency.mode !== "copy" || dependency.state !== "changed")
        return yield* err("dependency", "A copy dependency has no saved changes to stack.")
      const files = dependency.files.filter((file) => !dependency.merged.includes(file.path)).map((file) => file.path)
      const result = yield* prepare({ ...dependency, parentDirectory: record.directory }, files)
      if (result.conflicts.length)
        return yield* err(
          "dependency",
          "The copied dependency conflicts with this task's starting files.",
          result.conflicts,
        )
      for (const file of files)
        if (!FSUtil.writableInside(record.directory, path.join(record.directory, file)))
          return yield* err("path", "A stacked copy target is unsafe.")
      for (const [file, blob] of result.blobs) {
        const target = path.join(record.directory, file)
        yield* io(async () => {
          if (!FSUtil.writableInside(record.directory, target))
            throw err("path", "A stacked copy target changed identity.")
          if (!blob) {
            await rm(target, { force: true })
            return
          }
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, blob.bytes, { mode: blob.mode === "100755" ? 0o755 : 0o644 })
        })
        selected.add(file)
      }
    }
    const registry = paths(record.projectID, record.taskID).registry
    const limits = yield* Limits
    const advanced = selected.size
      ? yield* io(() =>
          IsolationBase.advanceCopy(
            { registry, directory: record.directory, baselineDirectory: path.join(registry, "baseline") },
            [...selected],
            limits.fileBytes,
          ),
        )
      : undefined
    return { ...record, copyStacked: true, ...(advanced ? { copyBase: advanced.name } : {}) }
  })

  const checkpoint = Effect.fn("TaskIsolation.checkpoint")(function* (
    record: Record,
    selected: readonly string[],
    blobs: Map<string, Blob>,
  ) {
    const directory = path.join(
      paths(record.projectID, record.taskID).registry,
      "checkpoints",
      `${Date.now()}-${randomUUID()}`,
    )
    const files: Checkpoint["files"] = []
    for (const file of selected) {
      const source = path.join(record.parentDirectory, file)
      const info = yield* io(() =>
        lstat(source).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      const written = blobs.get(file)
      files.push({
        path: file,
        existed: !!info,
        ...(info
          ? { mode: info.mode, ...(info.isSymbolicLink() ? { symlink: yield* io(() => readlink(source)) } : {}) }
          : {}),
        written: !written
          ? { absent: true }
          : written.mode === "120000"
            ? { symlink: written.bytes.toString() }
            : { hash: hash(written.bytes) },
      })
      if (info)
        yield* io(() =>
          IsolationCopy.backupBeforeOverwrite(path.join(directory, "checkpoint.json"), record.parentDirectory, file),
        )
    }
    yield* io(() =>
      privateJSON(path.join(directory, "manifest.json"), { files, selected, phase: "prepared" } satisfies Checkpoint),
    )
    yield* io(() => privateTree(directory))
    const next = { ...record, checkpoint: directory, mergeStartedAt: Date.now(), mergeCompleted: false }
    yield* save(next)
    return next
  })
  const manifest = Effect.fn("TaskIsolation.manifest")(function* (record: Record) {
    if (
      !record.checkpoint ||
      !inside(path.join(paths(record.projectID, record.taskID).registry, "checkpoints"), record.checkpoint)
    )
      return yield* err("checkpoint", "Isolation checkpoint is not in its registry.")
    yield* io(() => guarded(path.join(record.checkpoint!, "manifest.json")))
    const value = yield* io(() =>
      readFile(path.join(record.checkpoint!, "manifest.json"), "utf8").then((value) => JSON.parse(value) as Checkpoint),
    )
    if (!value.files.every((file) => relative(file.path)))
      return yield* err("checkpoint", "Isolation checkpoint contains an unsafe path.")
    return value
  })
  /** Whether a merge target still holds exactly what the merge wrote there, or what was there before it. */
  const untouched = Effect.fnUntraced(function* (record: Record, file: Checkpoint["files"][number]) {
    const target = path.join(record.parentDirectory, file.path)
    const info = yield* io(() =>
      lstat(target).catch((cause) => {
        if (missing(cause)) return undefined
        throw cause
      }),
    )
    const now = !info
      ? { absent: true }
      : info.isSymbolicLink()
        ? { symlink: yield* io(() => readlink(target)) }
        : info.isFile()
          ? { hash: yield* io(() => IsolationCopy.hashFile(target)) }
          : undefined
    if (!now) return false
    const backup = path.join(record.checkpoint!, "overwritten", file.path)
    const saved = file.existed && file.symlink === undefined ? yield* io(() => lstat(backup)) : undefined
    const before = !file.existed
      ? { absent: true }
      : file.symlink !== undefined
        ? { symlink: file.symlink }
        : saved?.isFile()
          ? { hash: yield* io(() => IsolationCopy.hashFile(backup)) }
          : undefined
    // On Windows Node writes a relative link target with backslashes, so readlink there never returns the forward
    // slashes of the Git blob the merge wrote.
    const spelled = (state: typeof now) =>
      state?.symlink !== undefined && process.platform === "win32"
        ? { symlink: state.symlink.replaceAll("\\", "/") }
        : state
    return [file.written, before].some(
      (state) => state !== undefined && stable(spelled(state)) === stable(spelled(now)),
    )
  })
  const rollback = Effect.fn("TaskIsolation.rollback")(function* (record: Record) {
    const restore = yield* manifest(record)
    // Only what the merge left is undone. A path changed again since the merge wrote it (by the user, a tool or a
    // build, possibly long before a restart finds the interrupted merge) keeps that change and is named for review.
    const kept: string[] = []
    for (const file of restore.files) {
      const target = path.join(record.parentDirectory, file.path)
      const info = yield* io(() =>
        lstat(target).catch((cause) => {
          if (missing(cause)) return undefined
          throw cause
        }),
      )
      if (
        !FSUtil.writableInside(record.parentDirectory, target) &&
        !(
          info?.isSymbolicLink() &&
          FSUtil.writableInside(
            record.parentDirectory,
            path.join(path.dirname(target), `.vector-restore-${randomUUID()}`),
          )
        )
      )
        return yield* err("path", "Cannot restore a checkpoint through an unsafe target.")
      // A manifest written before merges recorded their writes is restored as it always was.
      if (file.written && !(yield* untouched(record, file))) {
        kept.push(file.path)
        continue
      }
      if (!file.existed) {
        yield* io(() => (info?.isSymbolicLink() ? unlink(target) : rm(target, { force: true })))
        continue
      }
      yield* io(async () => {
        await mkdir(path.dirname(target), { recursive: true })
        // A link goes back in one rename over whatever the merge left, so a failed restore still holds the merge's
        // write, which a later recovery recognises.
        if (file.symlink !== undefined) return place(target, { symlink: file.symlink })
        // copyFile follows a link, so a link the merge wrote goes first.
        if (info?.isSymbolicLink()) await unlink(target)
        await copyFile(path.join(record.checkpoint!, "overwritten", file.path), target)
        if (file.mode !== undefined) await chmod(target, file.mode)
      })
    }
    yield* save({
      ...record,
      state: "changed",
      mergeStartedAt: undefined,
      mergeCompleted: undefined,
      ...(kept.length
        ? {
            error: `An interrupted merge was undone, except where a file changed again after the merge wrote it. ${kept.length === 1 ? "This file was" : "These files were"} left as ${kept.length === 1 ? "it is" : "they are"}: ${kept.join(", ")}. Review before merging this task again.`,
          }
        : {}),
    })
  })
  const savePatch = Effect.fn("TaskIsolation.savePatch")(function* (record: Record, kind: string) {
    const file = path.join(
      paths(record.projectID, record.taskID).registry,
      "patches",
      `${kind}-${Date.now()}-${randomUUID()}.patch`,
    )
    if (record.mode === "copy") {
      const limits = yield* Limits
      if (
        record.tip &&
        hash(stable(yield* io(() => IsolationCopy.hashProject(record.directory, limits.fileBytes)))) !== record.tip
      )
        return yield* err("unsaved", "The saved copy changed after settlement; its checkout has been retained.")
      yield* io(async () => {
        await guarded(file)
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(file, JSON.stringify({ format: "vector-isolation-copy-v1", files: record.files }) + "\n", {
          flag: "wx",
          mode: 0o600,
        })
      })
      for (const entry of record.files) {
        const target = path.join(record.directory, entry.path)
        if (entry.status !== "deleted" && !FSUtil.writableInside(record.directory, target))
          return yield* err("path", "Cannot save a copy patch through an unsafe source.")
        const bytes = entry.status === "deleted" ? undefined : yield* io(() => readFile(target))
        yield* io(() =>
          appendFile(
            file,
            JSON.stringify({
              path: entry.path,
              status: entry.status,
              ...(bytes ? { content: bytes.toString("base64") } : {}),
            }) + "\n",
          ),
        )
      }
      return file
    }
    const data =
      record.mode === "worktree" && record.seed && record.tip
        ? yield* command(record.parentDirectory, ["diff", "--binary", record.patchBase ?? record.seed, record.tip])
        : Buffer.from(JSON.stringify(record.files))
    yield* io(async () => {
      await guarded(file)
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, data, { flag: "wx", mode: 0o600 })
    })
    return file
  })

  /** Everything a merge checks before it writes: the task's state, the selection and each target. */
  const planMerge = Effect.fn("TaskIsolation.planMerge")(function* (input: MergeInput) {
    const original = yield* get(input.taskID)
    if (["preparing", "running", "settling"].includes(original.state) || active.has(input.taskID))
      return yield* err("running", "The isolated task is still running or saving its changes.")
    if (original.state !== "changed") return yield* err("state", "Only a changed isolated task can be merged.")
    yield* assertCaptured(original)
    if (input.by.kind !== "owner" && (input.force || input.includeStacked))
      return yield* err("forbidden", "Only the owner can force a collision or include stacked changes.")
    if (input.by.kind === "agent" && input.by.sessionID !== original.parentSessionID)
      return yield* err("forbidden", "An agent may merge only its direct children.")
    const unmerged = yield* Effect.forEach(original.stacked, (id) =>
      get(id).pipe(Effect.map((record) => record.state !== "merged")),
    )
    if (unmerged.some(Boolean) && !input.includeStacked)
      return yield* err("stacked", "Merge the task's stacked dependencies first.")
    const included = yield* Effect.gen(function* () {
      if (!unmerged.some(Boolean) || !input.includeStacked) return original
      if (original.stackedIncluded) return original
      const registry = paths(original.projectID, original.taskID).registry
      if (original.mode === "copy") {
        if (!original.copyStacked) return yield* err("stacked", "This copy has no saved pre-stack baseline.")
        const limits = yield* Limits
        const copyBase = original.merged.length
          ? (yield* io(() =>
              IsolationBase.advanceCopy(
                { registry, directory: original.directory, baselineDirectory: path.join(registry, "baseline") },
                original.merged,
                limits.fileBytes,
              ),
            )).name
          : undefined
        return { ...original, copyBase, stackedIncluded: true }
      }
      if (!original.unstackedSeed || !original.tip)
        return yield* err("stacked", "This result has no saved pre-stack Git baseline.")
      return {
        ...original,
        stackedIncluded: true,
        patchBase: original.unstackedSeed,
        reviewBase: yield* pin(
          original,
          yield* IsolationBase.advanceGit(
            { parentDirectory: original.parentDirectory, registry, seed: original.unstackedSeed, tip: original.tip },
            original.merged,
            command,
          ),
        ),
      }
    })
    const record = included === original ? original : { ...included, files: yield* stats(included) }
    if (
      TaskClaims.protectedTrees().some(
        (entry) =>
          entry.taskID !== (input.by.kind === "agent" ? input.by.sessionID : undefined) &&
          entry.workDirectory &&
          FileLock.key(entry.workDirectory) === FileLock.key(record.parentDirectory),
      )
    )
      return yield* err("running", "The merge target belongs to another running isolated task.")
    const remaining = record.files.filter((file) => !record.merged.includes(file.path)).map((file) => file.path)
    const selected = [...new Set(input.files ?? remaining)]
    if (!selected.length || selected.some((file) => !remaining.includes(file) || !relative(file)))
      return yield* err("files", "The merge selection contains an unknown or previously merged path.")
    const targets = selected.map((file) => path.join(record.parentDirectory, file))
    for (const target of targets)
      if (!FSUtil.writableInside(record.parentDirectory, target))
        return yield* err("path", "The merge target is a symlink, hard link or leaves the project.")
    return { record, remaining, selected, targets }
  })

  const merge = Effect.fn("TaskIsolation.merge")(function* (input: MergeInput) {
    const by = input.by
    // An agent's merge asks the user, who may take as long as they like. The task's lock is not held across that
    // prompt (F.1), so the owner can still view, discard or resume the task meanwhile. The approval covers only the
    // result the prompt showed: under the lock again, the task must be exactly as it was.
    const shown =
      by.kind === "agent"
        ? yield* Effect.gen(function* () {
            const plan = yield* lock(
              input.taskID,
              planMerge(input).pipe(
                Effect.flatMap((plan) =>
                  patch(plan.record, plan.selected).pipe(Effect.map((diff) => ({ ...plan, diff: diff.patch }))),
                ),
              ),
            )
            for (const target of plan.targets) yield* by.assertExternalDirectory(target)
            yield* by.assertWritable({ files: plan.targets })
            // Edit asks name files relative to the instance's worktree, as edit and write do: the chokepoint resolves
            // them there for the prompt_source and memory_source asks. A project that is not a Git repository has the
            // file system root as its worktree, while its merge targets sit in the project folder.
            const ctx = yield* home
            const patterns = plan.targets.map((target) => path.relative(ctx.worktree, target))
            // A connected-tools fix child's changes reach the checkout only after the user says yes, every time (CW-07).
            if (plan.record.agent.name === ConnectPolicy.FIX_AGENT)
              yield* by.ask(ConnectPolicy.mergeAsk({ title: plan.record.title, patterns, diff: plan.diff }))
            yield* by.ask({
              permission: "edit",
              patterns: plan.targets.map((target) => path.relative(ctx.worktree, target)),
              always: ["*"],
              metadata: { diff: plan.diff },
            })
            return plan.record
          })
        : undefined
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const plan = yield* planMerge(input)
        // Viewing the changes meanwhile only caches their merge assessment, which the approval does not depend on.
        if (
          shown &&
          stable({ ...plan.record, mergeKey: undefined, mergeable: undefined }) !==
            stable({ ...shown, mergeKey: undefined, mergeable: undefined })
        )
          return yield* err("state", "The isolated task changed while this merge waited for approval; review it again.")
        const record = plan.record
        return yield* FileLock.forTree(record.parentDirectory)(
          FileLock.withFiles(plan.targets)(
            Effect.gen(function* () {
              for (const target of plan.targets)
                if (!FSUtil.writableInside(record.parentDirectory, target))
                  return yield* err("path", "The merge target changed after approval.")
              if (by.kind === "agent") yield* by.assertWritable({ files: plan.targets })
              // A new child path colliding with an untracked parent path needs explicit owner force, even when a 3-way merge is possible.
              const collisions: string[] = []
              for (const file of plan.selected.filter(
                (name) => record.files.find((item) => item.path === name)?.status === "added",
              )) {
                const existing = yield* io(() =>
                  readFile(path.join(record.parentDirectory, file)).catch((cause) => {
                    if (missing(cause)) return undefined
                    throw cause
                  }),
                )
                const tracked =
                  record.mode === "worktree" &&
                  (yield* run(record.parentDirectory, [
                    "--literal-pathspecs",
                    "ls-files",
                    "--error-unmatch",
                    "--",
                    file,
                  ])).exitCode === 0
                const child =
                  record.mode === "worktree" && record.tip
                    ? yield* blob(record, record.tip, file)
                    : { mode: "100644", bytes: yield* io(() => readFile(path.join(record.directory, file))) }
                if (existing && !tracked && !existing.equals(child?.bytes ?? Buffer.alloc(0))) {
                  collisions.push(file)
                }
              }
              if (collisions.length && !input.force)
                return yield* err("conflict", "An untracked parent file would be overwritten.", collisions)
              const resolved = yield* prepare(record, plan.selected, input.force ? collisions : [])
              if (resolved.conflicts.length)
                return yield* err("conflict", "Isolation changes conflict with the parent's current files.", [
                  ...new Set(resolved.conflicts),
                ])
              for (const [file, value] of resolved.blobs) {
                if (value?.mode === "120000") {
                  const to = path.resolve(path.dirname(path.join(record.parentDirectory, file)), value.bytes.toString())
                  if (!inside(record.parentDirectory, FSUtil.realpath(to)))
                    return yield* err("path", "An added symbolic link would leave the repository.")
                }
              }
              const merged = [...new Set([...record.merged, ...plan.selected])]
              const complete = record.files.every((file) => merged.includes(file.path))
              const limits = yield* Limits
              const registry = paths(record.projectID, record.taskID).registry
              // A partial merge's next logical base is built before the first parent write. Once a parent file has
              // changed, only the record's save remains: a failure up to it is rolled back, and a Stop or a dropped
              // request waits for it, so no merge is left written but recorded as unfinished.
              const reviewBase =
                !complete && record.mode === "worktree"
                  ? yield* pin(
                      record,
                      yield* IsolationBase.advanceGit(
                        {
                          parentDirectory: record.parentDirectory,
                          registry,
                          seed: record.seed!,
                          tip: record.tip!,
                          reviewBase: record.reviewBase,
                        },
                        plan.selected,
                        command,
                      ),
                    )
                  : undefined
              const copyBase =
                !complete && record.mode === "copy"
                  ? (yield* io(() =>
                      IsolationBase.advanceCopy(
                        { registry, directory: record.directory, baselineDirectory: baselinePaths(record).directory },
                        plan.selected,
                        limits.fileBytes,
                      ),
                    )).name
                  : undefined
              const next = yield* Effect.gen(function* () {
                const pending = yield* checkpoint(record, plan.selected, resolved.blobs)
                return yield* Effect.gen(function* () {
                  for (const [file, value] of resolved.blobs) {
                    const target = path.join(record.parentDirectory, file)
                    if (!FSUtil.writableInside(record.parentDirectory, target))
                      return yield* err("path", "A merge target became unsafe before writing.")
                    yield* io(async () => {
                      if (!value) {
                        await rm(target, { force: true })
                        return
                      }
                      await mkdir(path.dirname(target), { recursive: true })
                      await place(
                        target,
                        value.mode === "120000"
                          ? { symlink: value.bytes.toString() }
                          : { bytes: value.bytes, mode: value.mode === "100755" ? 0o755 : 0o644 },
                      )
                    })
                  }
                  const next = {
                    ...pending,
                    ...(reviewBase ? { reviewBase } : {}),
                    ...(copyBase ? { copyBase } : {}),
                    merged,
                    mergeCompleted: true,
                    state: complete ? "merged" : "changed",
                  }
                  yield* save(next)
                  return next
                }).pipe(Effect.onError(() => rollback(pending).pipe(Effect.orDie)))
              }).pipe(
                Effect.uninterruptible,
                // A copy base version the record never published is removed with the failed merge.
                Effect.onError(() =>
                  copyBase
                    ? io(() => rm(path.join(registry, copyBase), { recursive: true, force: true })).pipe(Effect.ignore)
                    : Effect.void,
                ),
              )
              // The copy base version this merge replaced is a full copy of the project that no record names now.
              if (record.copyBase && next.copyBase !== record.copyBase)
                yield* io(() => rm(path.join(registry, record.copyBase!), { recursive: true, force: true })).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("a replaced copy base could not be removed", { taskID: record.taskID, cause }),
                  ),
                )
              const events = yield* Effect.serviceOption(EventV2Bridge.Service)
              const ctx = yield* home
              if (Option.isSome(events))
                for (const target of plan.targets) {
                  yield* events.value
                    .publish(FileSystem.Event.Edited, {
                      file: target,
                      sessionID: record.parentSessionID,
                      agent: record.agent.name,
                    })
                    .pipe(Effect.provideService(InstanceRef, ctx))
                  yield* events.value
                    .publish(Watcher.Event.Updated, { file: target, event: "change" })
                    .pipe(Effect.provideService(InstanceRef, ctx))
                }
              if (next.state === "merged") {
                const archived = { ...next, savedPatch: yield* savePatch(next, "merged") }
                yield* save(archived)
                yield* remove(archived)
                return {
                  record: archived,
                  merged: plan.selected,
                  remaining: plan.remaining.filter((file) => !plan.selected.includes(file)),
                  conflicts: [],
                  checkpoint: next.checkpoint,
                }
              }
              return {
                record: next,
                merged: plan.selected,
                remaining: plan.remaining.filter((file) => !plan.selected.includes(file)),
                conflicts: [],
                checkpoint: next.checkpoint,
              }
            }),
          ),
        )
      }),
    )
  })

  const discard = Effect.fn("TaskIsolation.discard")(function* (input: { taskID: string; by: By; reason?: string }) {
    return yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (input.by.kind === "agent" && input.by.sessionID !== record.parentSessionID)
          return yield* err("forbidden", "An agent may discard only its direct children.")
        if (["running", "settling"].includes(record.state) || active.has(record.taskID))
          return yield* err("running", "Stop and save the isolated task before discarding it.")
        if (["merged", "discarded", "unchanged"].includes(record.state)) return { record, saved: undefined }
        if (!["changed", "diverged"].includes(record.state) || !record.tip)
          return yield* err(
            "unsaved",
            "Partial changes have not been saved successfully. The checkout is retained; resume or recover it before discarding.",
          )
        return yield* FileLock.forTree(record.parentDirectory)(
          Effect.gen(function* () {
            yield* verify(record)
            yield* assertCaptured(record)
            const saved = yield* savePatch(record, "discarded")
            const pending = {
              ...record,
              state: "discarding",
              savedPatch: saved,
              ...(input.reason ? { discardReason: input.reason.slice(0, 1000) } : {}),
            }
            yield* save(pending)
            yield* remove(pending)
            const next = { ...pending, state: "discarded" }
            yield* save(next)
            return { record: next, saved }
          }),
        )
      }),
    )
  })
  const resume = Effect.fn("TaskIsolation.resume")(function* (input: {
    taskID: string
    attempt: number
    agent: Expected
  }) {
    const next = yield* lock(
      input.taskID,
      Effect.gen(function* () {
        const record = yield* get(input.taskID)
        if (active.has(input.taskID)) return yield* err("running", "This isolated task is already running.")
        yield* check({ parentSessionID: record.parentSessionID, agent: input.agent, resumeID: input.taskID })
        if (stable(record.agent) !== stable(resolution(input.agent)))
          return yield* err("agent", "Agent configuration changed since this isolation was created.")
        const exists = yield* io(() =>
          lstat(record.directory)
            .then(() => true)
            .catch((cause) => {
              if (missing(cause)) return false
              throw cause
            }),
        )
        const ctx = yield* home
        if (exists) {
          const recovered = yield* verify(record, true)
          yield* protect(recovered)
          const loaded = yield* loadWork(recovered, ctx)
          const work = loaded.work
          return yield* Effect.gen(function* () {
            const resolved = yield* agents.get(record.agent.name).pipe(Effect.provideService(InstanceRef, work))
            if (!resolved || stable(resolution(resolved)) !== stable(record.agent))
              return yield* err("agent", "Agent configuration differs in the isolated instance.")
            TaskPlace.set(record.taskID, { work, home: ctx })
            const running = {
              ...recovered,
              attempt: input.attempt,
              settledAttempt: undefined,
              state: "running",
              files: yield* stats(recovered),
              merged: [],
              mergeStartedAt: undefined,
              mergeCompleted: undefined,
              mergeKey: undefined,
              mergeable: undefined,
              error: undefined,
            }
            yield* save(running)
            loaded.transferred = true
            return { existing: true as const, record: running, work }
          }).pipe(Effect.onError(() => retire(record).pipe(Effect.orDie)))
        }
        if (record.mode === "worktree") {
          // A missing worktree is not authority to prune arbitrary registrations; only this exact registry branch may be deleted.
          const listed = yield* text(record.parentDirectory, ["worktree", "list", "--porcelain"])
          if (listed.includes(`branch refs/heads/${record.branch}`))
            yield* FileLock.forTree(record.parentDirectory)(remove(record))
          const present = yield* run(record.parentDirectory, ["show-ref", "--verify", `refs/heads/${record.branch}`])
          if (present.exitCode === 0)
            return yield* err(
              "registry",
              "The reserved branch exists without its registered checkout; refusing to delete it.",
            )
        }
        const preparing = {
          ...record,
          attempt: input.attempt,
          settledAttempt: undefined,
          state: "preparing",
          merged: [],
          files: [],
          links: [],
          skipped: [],
          initialSkipped: [],
          largeBaseline: undefined,
          tip: undefined,
          seed: undefined,
          reviewBase: undefined,
          patchBase: undefined,
          unstackedSeed: undefined,
          copyBase: undefined,
          copyStacked: undefined,
          stackedIncluded: undefined,
          error: undefined,
        }
        yield* save(preparing)
        return { existing: false as const }
      }).pipe(Effect.scoped),
    )
    return next.existing ? next : yield* start(input.taskID)
  })
  const reconcile = Effect.fn("TaskIsolation.reconcile")(function* (taskID: string) {
    const initial = yield* get(taskID)
    const present = yield* io(() =>
      lstat(initial.directory)
        .then(() => true)
        .catch((cause) => {
          if (missing(cause)) return false
          throw cause
        }),
    )
    // A start that failed, was stopped or crashed before its checkout existed (a checkout that was made has its Git
    // binding) is done: see `vacant`.
    if (
      !present &&
      !initial.tip &&
      !initial.gitDirectory &&
      ["preparing", "failed"].includes(initial.state) &&
      !active.has(taskID)
    ) {
      if (
        initial.mode === "worktree" &&
        (yield* run(initial.parentDirectory, ["show-ref", "--verify", `refs/heads/${initial.branch}`])).exitCode === 0
      )
        return yield* err("registry", "A reserved branch exists without a completed preparation; it has been retained.")
      return yield* lock(
        taskID,
        Effect.gen(function* () {
          const record = yield* get(taskID)
          return (yield* vacant(record)) ? yield* vacate(record, record.attempt) : record
        }),
      )
    }
    const original =
      initial.mode === "worktree" && (!initial.gitDirectory || !initial.gitCommonDirectory)
        ? yield* verify(initial, true)
        : initial
    if (["preparing", "running", "settling", "failed"].includes(original.state) && !active.has(taskID))
      return yield* settle({ taskID, attempt: original.attempt, recover: true })
    return yield* lock(
      taskID,
      Effect.gen(function* () {
        const record = yield* get(taskID)
        const exists = yield* io(() =>
          lstat(record.directory)
            .then(() => true)
            .catch((cause) => {
              if (missing(cause)) return false
              throw cause
            }),
        )
        if (record.state === "discarding") {
          if (!record.savedPatch)
            return yield* err("unsaved", "Discard recovery requires its saved patch; the checkout is retained.")
          yield* io(() => guarded(record.savedPatch!))
          yield* io(() => lstat(record.savedPatch!))
          if (exists) yield* remove(record)
          const discarded = { ...record, state: "discarded" }
          yield* save(discarded)
          return discarded
        }
        if (exists) yield* protect(record)
        // The conversation may already be editing again while recovery runs: the targets' file locks keep each
        // check of a target and its restore together.
        if (record.mergeStartedAt && !record.mergeCompleted)
          yield* FileLock.forTree(record.parentDirectory)(
            FileLock.withFiles(
              (yield* manifest(record)).files.map((file) => path.join(record.parentDirectory, file.path)),
            )(rollback(record)),
          )
        if (record.mergeCompleted && record.state === "merged") {
          const exists = yield* io(() =>
            lstat(record.directory)
              .then(() => true)
              .catch((cause) => {
                if (missing(cause)) return false
                throw cause
              }),
          )
          if (exists) {
            const archived = record.savedPatch ? record : { ...record, savedPatch: yield* savePatch(record, "merged") }
            yield* save(archived)
            yield* remove(archived)
          }
        }
        return yield* get(taskID)
      }),
    )
  })
  const sweep = Effect.fn("TaskIsolation.sweep")(function* (input: { force?: boolean } = {}) {
    const ctx = yield* home
    // The registry is scanned at most once per project per process. Conversations deleted after that are handed over
    // through `queued`, and each later pass sweeps those, so their checkouts do not wait for a restart.
    const scan = !swept.has(ctx.project.id) || input.force === true
    if (!scan && queued.size === 0) return []
    swept.add(ctx.project.id)
    const candidates = scan
      ? yield* records()
      : (yield* Effect.forEach([...queued], (id) => optional(id).pipe(Effect.option))).flatMap((item) =>
          Option.isSome(item) && item.value ? [item.value] : [],
        )
    const output: string[] = []
    for (const record of candidates) {
      if (!record.deleted && !queued.has(record.taskID)) continue
      if (active.has(record.taskID)) continue
      // A save that already failed for this attempt is not run again here. TaskRecovery's boot pass, which runs before
      // this sweep, retries it; every pass (each 5 minutes) would rewrite the record and run Git again.
      const settledFailure = record.state === "failed" && record.settledAttempt === record.attempt
      if (["preparing", "failed", "discarding"].includes(record.state) && !settledFailure)
        yield* reconcile(record.taskID).pipe(Effect.option)
      const refused = yield* discard({ taskID: record.taskID, by: { kind: "owner" } }).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error)),
      )
      if (!refused) {
        output.push(record.taskID)
        queued.delete(record.taskID)
        continue
      }
      // A save still in progress is swept by a later pass. Anything else waits for the next start, whose registry scan
      // finds the conversation's deletion marker again.
      if (refused instanceof IsolationError && refused.code === "running") continue
      queued.delete(record.taskID)
      yield* Effect.logWarning("a deleted conversation's isolated task was kept until the next start", {
        taskID: record.taskID,
        error: refused,
      })
    }
    return output
  })
  /** Deletion hooks only enqueue; a later sweep does the Git work outside Session.remove. */
  const enqueue = Effect.fn("TaskIsolation.enqueue")(function* (taskID: string) {
    const record = yield* get(taskID)
    queued.add(taskID)
    yield* save({ ...record, deleted: true })
  })
  /**
   * Execution admission: a retired isolation family must never silently run at home. Isolation fences its whole
   * family owner-only before the first child exists, so an unfenced family cannot hold isolation records and is
   * admitted without walking its ancestors.
   */
  const admit = Effect.fn("TaskIsolation.admit")(function* (sessionID: string) {
    if (!(yield* audience.isPrivate(sessionID))) return
    const seen = new Set<string>()
    for (let id: string | undefined = sessionID; id && !seen.has(id); ) {
      seen.add(id)
      const row: { parentID: string | null } | undefined = yield* database.db
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
        .get()
        .pipe(Effect.orDie)
      // A missing target is left to the caller's ordinary not-found handling.
      if (!row && id === sessionID) return
      if (!row)
        return yield* err(
          "retired",
          "This task's parent no longer exists. Fork it into a new conversation before running it.",
        )
      const record = yield* optional(id)
      if (record) {
        const place = TaskPlace.get(id)
        if (
          record.state !== "running" ||
          !place ||
          FileLock.key(place.work.directory) !== FileLock.key(record.directory)
        )
          return yield* err(
            "retired",
            "Resume this isolated task through its parent before running it or a descendant.",
          )
      }
      id = row.parentID ?? undefined
    }
  })
  return {
    check,
    /** Closes the terminals `chosen` picks in these folders, and waits for their programs (closeTerminalsIn). */
    closeTerminals: (directories: readonly string[], chosen: (info: Pty.Info) => boolean) =>
      closeTerminalsIn(directories, chosen, locations),
    fence: (sessionID: string) => audience.fenceIsolation({ sessionID, actor: "owner" }),
    reserve,
    start,
    settle,
    changes,
    merge,
    discard,
    resume,
    reconcile,
    sweep,
    get,
    find: optional,
    markSettling,
    records,
    review,
    enqueue,
    admit,
  }
})

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@vector/TaskIsolation") {}

/**
 * The save barrier a task's background job runs once its last run ends (F.4 settle), shared by the task tool and
 * `TaskManager.resume`. A normal end is saved before the job's waiters are released. A stop or interrupt records
 * `settling` and forks the save into `scope`, so neither the Stop nor the control lock waits on Git.
 */
export const complete = Effect.fn("TaskIsolation.complete")(function* (input: {
  isolation: Interface
  taskID: string
  attempt: number
  status: string
  scope: Scope.Scope
  mirror: (record: Record) => Effect.Effect<void, unknown>
}) {
  const current = yield* input.isolation.find(input.taskID)
  // A run stopped before its slot reserved nothing to save; a later attempt saves its own run.
  if (!current || current.attempt !== input.attempt) return
  const saving = yield* input.isolation.markSettling(input.taskID, input.attempt)
  if (saving) yield* input.mirror(saving)
  const save = input.isolation
    .settle({ taskID: input.taskID, attempt: input.attempt })
    .pipe(Effect.flatMap(input.mirror))
  if (input.status === "cancelled" || input.status === "interrupted") {
    yield* save.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("isolated task save needs recovery", { taskID: input.taskID, cause }),
      ),
      Effect.forkIn(input.scope, { startImmediately: true }),
    )
    return
  }
  yield* save
})
export const layer = Layer.effect(Service, make)
// The location services the terminal tool opens terminals in (tool/registry.ts), the same instance by the shared layer,
// so a retiring checkout's terminals are closed where they were opened.
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, Config.node, Agent.node, SessionAudience.node, Database.node, locationServiceMapNode],
})
export * as TaskIsolation from "./isolation"
