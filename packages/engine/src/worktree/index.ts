import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { path } from "@vectordevai/core/effect/app-node-platform"
import { Global } from "@vectordevai/core/global"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@vectordevai/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@vectordevai/core/project/sql"
import type { ProjectV2 } from "@vectordevai/core/project"
import { Slug } from "@vectordevai/core/util/slug"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { gitEnvironment, refusal } from "@vectordevai/core/git"
import { Effect, Layer, Path, Schema, Scope, Context, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@vectordevai/core/fs-util"
import { AppProcess } from "@vectordevai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FileLock } from "@/tool/file-lock"
import { WorktreeEvent } from "@vectordevai/schema/worktree-event"
import os from "node:os"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  /** Raw task checkout primitive: no sandbox registration, instance boot or start scripts. */
  readonly createForTask: (
    info: Info,
    options: { from: string; env?: Record<string, string | undefined> },
  ) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  /** Isolation removal may delete only the reserved branch its registry validated. */
  readonly removeForTask: (info: Info & { branch: string }) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service

    // With Vector Local on, a git command that connects (a fetch, a submodule update) is decided on each remote it would
    // reach before git starts, and with Web access None git may use only file remotes.
    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) {
        const query = (more: string[]) =>
          appProcess.run(ChildProcess.make("git", more, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" })).pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8") : "")),
            Effect.catch(() => Effect.succeed("")),
          )
        const refused = yield* refusal(args, query)
        if (refused) return { code: 128, text: "", stderr: refused } satisfies GitResult
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, {
            cwd: opts?.cwd,
            extendEnv: true,
            stdin: "ignore",
            env: { ...opts?.env, ...gitEnvironment() },
          }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `vector/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for Git repositories" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(Effect.catch(() => Effect.void))
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      yield* boot(info, startCommand).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const createForTask: Interface["createForTask"] = Effect.fn("Worktree.createForTask")(function* (info, options) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for Git repositories" })
      const root = pathSvc.join(Global.Path.data, "task-worktree", ctx.project.id)
      const directory = pathSvc.join(root, info.name)
      if (
        !/^[A-Za-z0-9_-]+$/.test(info.name) ||
        info.branch !== `vector/subagent/${info.name}` ||
        FileLock.key(directory) !== FileLock.key(info.directory) ||
        !FSUtil.writableInside(Global.Path.data, info.directory) ||
        !options.from.trim() ||
        options.from.startsWith("-")
      )
        return yield* new CreateFailedError({ message: "Invalid isolated task worktree placement or seed." })
      const args = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${os.devNull}`,
        ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      ]
      const env = { ...options.env, GIT_LFS_SKIP_SMUDGE: "1" }
      const common = yield* git([...args, "rev-parse", "--git-common-dir"], { cwd: ctx.worktree, env })
      if (common.code !== 0)
        return yield* new CreateFailedError({ message: common.stderr || "Failed to locate git metadata" })
      return yield* FileLock.forTree(pathSvc.resolve(ctx.worktree, common.text.trim()))(
        Effect.gen(function* () {
          if (yield* fs.exists(info.directory).pipe(Effect.orDie))
            return yield* new CreateFailedError({ message: "The isolated task worktree directory already exists." })
          yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
          const created = yield* git(
            [...args, "worktree", "add", "--no-checkout", "-b", info.branch!, "--", info.directory, options.from],
            { cwd: ctx.worktree, env },
          )
          if (created.code !== 0)
            return yield* new CreateFailedError({
              message: created.stderr || created.text || "Failed to create task worktree",
            })
          const populated = yield* git([...args, "reset", "--hard", options.from], { cwd: info.directory, env })
          if (populated.code !== 0)
            return yield* new CreateFailedError({
              message:
                populated.stderr ||
                populated.text ||
                "Failed to populate task worktree; its registry entry remains available for recovery.",
            })
          return info
        }),
      )
    })

    // Git lists a worktree under the real path it stored, also once the folder is gone: on Windows that is the long
    // name, where Node's non-native realpath keeps 8.3 short names such as RUNNER~1. FSUtil.realpath resolves
    // natively on Windows and resolves the deepest existing ancestor of a missing folder, so both spellings meet.
    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* Effect.try({ try: () => FSUtil.realpath(abs), catch: (error) => error }).pipe(
        Effect.orElseSucceed(() => abs),
      )
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const registeredTask = Effect.fnUntraced(function* (directory: string, branch: string | undefined) {
      const ctx = yield* InstanceState.context
      const root = yield* canonical(pathSvc.join(Global.Path.data, "task-worktree", ctx.project.id))
      if (pathSvc.dirname(directory) !== root) return false
      const id = pathSvc.basename(directory)
      const file = pathSvc.join(Global.Path.data, "task-isolation", ctx.project.id, id, "record.json")
      const value = yield* fs.readJson(file).pipe(Effect.option)
      if (Option.isNone(value)) return false
      const decoded = Schema.decodeUnknownOption(Schema.Struct({ directory: Schema.String, branch: Schema.String }))(
        value.value,
      )
      if (Option.isNone(decoded)) return false
      return (
        (yield* canonical(decoded.value.directory)) === directory &&
        decoded.value.branch === `vector/subagent/${id}` &&
        branch === `refs/heads/${decoded.value.branch}`
      )
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary || (yield* registeredTask(directory, entry.branch))) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string, task = false) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) =>
          exists
            ? git(
                [
                  ...(task
                    ? ["-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "-c", `core.hooksPath=${os.devNull}`]
                    : []),
                  "fsmonitor--daemon",
                  "stop",
                ],
                { cwd: target, ...(task ? { env: { GIT_LFS_SKIP_SMUDGE: "1" } } : {}) },
              )
            : Effect.void,
        ),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput, expectedBranch?: string) {
      const ctx = yield* InstanceState.context
      const removeGit = (args: string[], options: { cwd: string }) =>
        git(
          expectedBranch
            ? ["-c", "core.fsmonitor=false", "-c", "core.longpaths=true", "-c", `core.hooksPath=${os.devNull}`, ...args]
            : args,
          { ...options, ...(expectedBranch ? { env: { GIT_LFS_SKIP_SMUDGE: "1" } } : {}) },
        )
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for Git repositories" })
      }

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* removeGit(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (expectedBranch && (!entry?.path || entry.branch !== `refs/heads/${expectedBranch}`))
        return yield* new RemoveFailedError({
          message: "The registered task worktree no longer checks out its reserved branch.",
        })

      if (!entry?.path) {
        const directoryExists = yield* fs.exists(directory).pipe(Effect.orDie)
        if (directoryExists) {
          yield* stopFsmonitor(directory, expectedBranch !== undefined)
          yield* cleanDirectory(directory)
        }
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path, expectedBranch !== undefined)
      const removed = yield* removeGit(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* removeGit(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = expectedBranch ?? entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* removeGit(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })
    const removeForTask = Effect.fn("Worktree.removeForTask")(function* (info: Info & { branch: string }) {
      const ctx = yield* InstanceState.context
      const expected = pathSvc.join(Global.Path.data, "task-worktree", ctx.project.id, info.name)
      if (
        !/^[a-zA-Z0-9_-]+$/.test(info.name) ||
        info.branch !== `vector/subagent/${info.name}` ||
        info.directory !== expected
      )
        return yield* new RemoveFailedError({ message: "Task worktree removal requires its reserved path and branch." })
      return yield* remove({ directory: info.directory }, info.branch)
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string) {
      const first = yield* git(["clean", "-ffdx"], { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(["clean", "-ffdx"], { cwd: root })
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for Git repositories" })
      }

      const directory = yield* canonical(input.directory)
      const primary = yield* canonical(ctx.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const cleanResult = yield* sweep(worktreePath)
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      yield* runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )

      return true
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, createForTask, list, remove, removeForTask, reset })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, Project.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
