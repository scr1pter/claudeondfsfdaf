import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { EverywhereSessionWire } from "@vectordevai/core/everywhere/session-binding"
import { UnattendedRecords } from "./unattended-records"
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
import { BRANCH_PATTERN, HEAD_SHA_PATTERN, JOB_ID_PATTERN } from "@vectordevai/schema/everywhere"
import { GIT_HARDENING, fetchRef, runnerGitEnvironment, safeRepositoryConfig } from "@vectordevai/core/everywhere/git"
import { UntrustedGit } from "@vectordevai/core/untrusted-git"
import { lstatSync } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { normalize } from "node:path"
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

/** A Vector everywhere job's checkout: the loaded project's own folder, the job's fetched base, its branch and id. */
export const UnattendedInput = Schema.Struct({
  directory: Schema.String,
  base: Schema.String.check(Schema.isPattern(HEAD_SHA_PATTERN)),
  branch: Schema.String.check(Schema.isPattern(BRANCH_PATTERN)),
  jid: Schema.String.check(Schema.isPattern(JOB_ID_PATTERN)),
}).annotate({ identifier: "WorktreeUnattendedInput" })
export type UnattendedInput = Schema.Schema.Type<typeof UnattendedInput>

export const Unattended = Schema.Struct({
  directory: Schema.String,
  branch: Schema.String,
  base: Schema.String,
}).annotate({ identifier: "WorktreeUnattended" })
export type Unattended = Schema.Schema.Type<typeof Unattended>

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

// The runner's hardening (core everywhere/git.ts) plus what creating a checkout needs: no transport at all (so no lazy
// fetch of a partial clone's missing objects), no automatic gc or maintenance, no submodule recursion, and long paths
// on Windows. A protocol.<name>.allow beats protocol.allow, so each protocol is pinned too (as core untrusted-git.ts
// does; GIT_HARDENING pins ext and file): no transport even if the repository-config allowlist ever accepts protocol.*.
const UNATTENDED_FLAGS = [
  ...GIT_HARDENING,
  ...[
    "core.useBuiltinFSMonitor=false",
    "protocol.allow=never",
    ...["git", "http", "https", "ssh"].map((name) => `protocol.${name}.allow=never`),
    "gc.auto=0",
    "maintenance.auto=false",
    "submodule.recurse=false",
    ...(process.platform === "win32" ? ["core.longpaths=true"] : []),
  ].flatMap((setting) => ["-c", setting]),
]
// As the runner's git (desktop everywhere-git.ts): a stuck git must not hold the repository's worktree lock.
const UNATTENDED_TIMEOUT = "60 seconds"
const UNATTENDED_OUTPUT_BYTES = 8 * 1024 * 1024
// Enough of git's own stderr to name why it failed. git keeps writing past it, and it is not counted as cut off.
const UNATTENDED_ERROR_BYTES = 2 * 1024

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
  /**
   * Vector everywhere's unattended checkout (docs/vector/build/vector-everywhere-main-requests.md): the job's own
   * branch and folder at the exact base the runner fetched, made with git hardened as the runner's is, then registered
   * as a project sandbox. It never loads an instance, runs a start script, a caller's command or an install, or
   * inherits workspace trust. Owner-only exposure, the `everywhere.projects` allowlist and the trust check are the
   * caller's (EV-13), which must not load an instance for a folder outside the allowlist.
   */
  readonly createUnattended: (input: UnattendedInput) => Effect.Effect<Unattended, NotGitError | CreateFailedError>
  readonly withUnattendedPlacement: <A, E, R>(
    input: EverywhereSessionWire.Placement,
    use: (placed: typeof UnattendedRecords.Placed.Type) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | undefined, E, R>
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

    // canonicalPath, or the resolved path folded the same way when it has no real path.
    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      return (yield* canonicalPath(abs)) ?? folded(abs)
    })

    const unattendedRoot = pathSvc.join(Global.Path.data, "everywhere-worktree")
    const reservationDirectory = UnattendedRecords.folder
    const reservationRoot = pathSvc.join(Global.Path.state, reservationDirectory)
    const overlapsUnattended = Effect.fnUntraced(function* (requested: string, directory: string) {
      // The ordinary remove path can also erase an unregistered parent. Check both the requested spelling and
      // the real path so neither a parent nor an alias can discard a job's reservation and unfinished work.
      const supplied = folded(pathSvc.resolve(requested))
      for (const root of [unattendedRoot, reservationRoot]) {
        if (FSUtil.overlaps(folded(root), supplied) || FSUtil.overlaps(yield* canonical(root), directory)) return true
      }
      return false
    })

    const reserveUnattended = (
      checkout: string,
      ownership: Pick<UnattendedInput, "jid" | "branch" | "base"> & { project: ProjectV2.ID },
      refused: CreateFailedError,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const state = FSUtil.realpath(Global.Path.state)
          const root = pathSvc.join(state, reservationDirectory)
          if (
            FSUtil.overlaps(checkout, folded(reservationRoot)) ||
            FSUtil.overlaps(checkout, folded(root)) ||
            FSUtil.overlaps(folded(FSUtil.realpath(unattendedRoot)), folded(root))
          )
            throw refused

          const owner = process.getuid?.()
          const parent = await lstat(state)
          if (!parent.isDirectory() || (owner !== undefined && (parent.uid !== owner || parent.mode & 0o022)))
            throw refused
          try {
            await mkdir(root, { mode: 0o700 })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          }
          const folder = await lstat(root)
          if (!folder.isDirectory() || (owner !== undefined && (folder.uid !== owner || folder.mode & 0o077)))
            throw refused

          // Only the validated job id chooses the leaf. Any existing entry, including an interrupted write, is consumed.
          const file = await open(pathSvc.join(root, `${ownership.jid}.json`), "wx", 0o600)
          try {
            await file.writeFile(`${JSON.stringify({ version: 1, ...ownership })}\n`)
            await file.sync()
          } finally {
            await file.close()
          }
          // Directory handles are available on POSIX. Persist both the receipt and the private directory it lives in.
          if (process.platform !== "win32") {
            for (const directory of [root, state]) {
              const handle = await open(directory, "r")
              try {
                await handle.sync()
              } finally {
                await handle.close()
              }
            }
          }
        },
        catch: () => refused,
      })

    // Vector everywhere's git: the runner's hardening, an environment that inherits nothing from this process (no
    // GIT_DIR, GIT_CONFIG_* or GIT_SSH*, no system or global config), and on Windows never a git.exe in a repository.
    // Nothing here connects and every protocol is off, so neither the Local refusal nor gitEnvironment applies. Failing
    // to start, a timeout and cut-off output answer -1, which is never one of git's own exit codes. `error` is git's own
    // reason (its stderr, at most UNATTENDED_ERROR_BYTES), so a refusal can name it.
    const unattendedGit = Effect.fnUntraced(
      function* (args: string[], cwd: string) {
        const program = UntrustedGit.program()
        if (!program) return { code: -1, text: "", error: "No git.exe or git.com on PATH." }
        const result = yield* appProcess.run(
          ChildProcess.make(program, [...UNATTENDED_FLAGS, ...args], {
            cwd,
            extendEnv: false,
            stdin: "ignore",
            env: { ...runnerGitEnvironment(), GIT_NO_LAZY_FETCH: "1" },
          }),
          {
            timeout: UNATTENDED_TIMEOUT,
            maxOutputBytes: UNATTENDED_OUTPUT_BYTES,
            maxErrorBytes: UNATTENDED_ERROR_BYTES,
          },
        )
        const error = result.stderr.toString("utf8").trim()
        if (result.exitCode !== 0 && error)
          yield* Effect.logWarning("unattended git failed", { command: args[0], code: result.exitCode, stderr: error })
        if (result.stdoutTruncated) return { code: -1, text: "", error }
        return { code: result.exitCode, text: result.stdout.toString("utf8"), error }
      },
      // The message of a failure to start or a timeout leads with the whole command line, so the cause's own goes first.
      (effect, args) =>
        effect.pipe(
          Effect.catch((cause) => {
            const error = (cause.cause instanceof Error ? cause.cause.message : cause.message).slice(
              0,
              UNATTENDED_ERROR_BYTES,
            )
            return Effect.logWarning("unattended git failed", { command: args[0], code: -1, error }).pipe(
              Effect.as({ code: -1, text: "", error }),
            )
          }),
        ),
    )
    const unattendedPrints = (args: string[], cwd: string, value: string) =>
      unattendedGit(args, cwd).pipe(Effect.map((result) => result.code === 0 && result.text.trim() === value))
    const absent = (target: string) =>
      Effect.try({
        try: () => lstatSync(target, { throwIfNoEntry: false }) === undefined,
        catch: (error) => error,
      }).pipe(Effect.orElseSucceed(() => false))

    // Both scopes the repository gives git, includes unresolved, read as the runner reads them (desktop
    // everywhere-git.ts `configuration`). System and global config are off and the environment adds none, so with the
    // command line this is all the configuration git sees: no filter, hook, helper or include can come from elsewhere.
    const unattendedConfig = Effect.fnUntraced(function* (cwd: string) {
      const local = yield* unattendedGit(["config", "--null", "--list", "--local", "--no-includes"], cwd)
      const located = yield* unattendedGit(["rev-parse", "--git-path", "config.worktree"], cwd)
      if (local.code !== 0 || located.code !== 0 || !safeRepositoryConfig(local.text)) return false
      const file = pathSvc.resolve(cwd, located.text.trim())
      if (yield* absent(file)) return true
      const worktree = yield* unattendedGit(["config", "--null", "--list", "--file", file, "--no-includes"], cwd)
      return worktree.code === 0 && safeRepositoryConfig(worktree.text)
    })

    const createUnattended: Interface["createUnattended"] = Effect.fn("Worktree.createUnattended")(function* (input) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git")
        return yield* new NotGitError({ message: "Worktrees are only supported for Git repositories" })
      // The branch is the job's own: one of core everywhere/publish.ts branchFor's two forms for this jid.
      if (
        !Schema.is(UnattendedInput)(input) ||
        !pathSvc.isAbsolute(input.directory) ||
        (input.branch !== `vector/ve-${input.jid.slice(-12)}` && !input.branch.endsWith(`-${input.jid.slice(-8)}`))
      )
        return yield* new CreateFailedError({ message: "Invalid unattended worktree request." })
      const own = new CreateFailedError({
        message: "An unattended worktree starts only from the loaded project's own checkout.",
      })
      const checkout = yield* canonical(input.directory)
      // A checkout Vector made (a task, a worktree or another job's) never seeds one.
      if (
        checkout !== (yield* canonical(ctx.directory)) ||
        checkout !== (yield* canonical(ctx.worktree)) ||
        FSUtil.contains(yield* canonical(Global.Path.data), checkout)
      )
        return yield* own
      const common = yield* unattendedGit(["rev-parse", "--git-common-dir"], ctx.worktree)
      if (common.code !== 0)
        return yield* new CreateFailedError({
          message: `The unattended worktree could not be created.${common.error ? ` git: ${common.error}` : ""}`,
        })
      const commonKey = FileLock.key(pathSvc.resolve(ctx.worktree, common.text.trim()))
      const checkCheckout = Effect.fnUntraced(function* () {
        if (!(yield* unattendedConfig(ctx.worktree)))
          return yield* new CreateFailedError({
            message: "The repository's git configuration can run programs. No unattended worktree was created.",
          })
        // core.worktree, which the allowlist keeps, could point git at another folder.
        const toplevel = yield* unattendedGit(["rev-parse", "--show-toplevel"], ctx.worktree)
        if (toplevel.code !== 0 || (yield* canonical(toplevel.text.trim())) !== checkout) return yield* own
      })
      const root = pathSvc.join(unattendedRoot, ctx.project.id)
      const directory = pathSvc.join(root, input.jid)
      const reserved = new CreateFailedError({ message: "This job's branch or folder is already reserved." })
      const failed = new CreateFailedError({
        message: "The unattended worktree could not be created. Its reservation is kept, so this job id is not reused.",
      })
      // The lock orders this with every other worktree change in this process. Across processes the exclusive
      // receipt and mkdir reserve the job and folder, and git's ref lock reserves the branch.
      return yield* FileLock.forTree(commonKey)(
        Effect.gen(function* () {
          // Refuse an unsafe or redirected checkout before consuming the job id.
          yield* checkCheckout()
          // The ref the runner fetched this job's base into must name the base, and the base must be a commit here.
          const fetched = yield* unattendedPrints(
            ["rev-parse", "--verify", "--quiet", "--end-of-options", fetchRef(input.jid)],
            ctx.worktree,
            input.base,
          )
          const commit = yield* unattendedPrints(
            ["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.base}^{commit}`],
            ctx.worktree,
            input.base,
          )
          if (!fetched || !commit)
            return yield* new CreateFailedError({ message: "The base is not this job's fetched commit." })
          // Nothing at the folder's path (not even a link), and the path stays inside the data folder.
          if (!(yield* absent(directory)) || !FSUtil.writableInside(Global.Path.data, directory)) return yield* reserved
          const branch = yield* unattendedGit(
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            ctx.worktree,
          )
          if (branch.code !== 1) return yield* reserved
          const { jid, branch: jobBranch, base } = input
          yield* reserveUnattended(checkout, { jid, project: ctx.project.id, branch: jobBranch, base }, reserved)
          // Another process may have taken the folder since the check: only an exclusive mkdir decides.
          const made = yield* fs.makeDirectory(root, { recursive: true }).pipe(
            Effect.andThen(fs.makeDirectory(directory)),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          if (!made) return yield* reserved
          // Reservation can wait on disk. Recheck the locked repository and its effective config before Git mutates
          // it. Both reservations survive a refusal here. The subprocesses cannot pin external config writers.
          const current = yield* unattendedGit(["rev-parse", "--git-common-dir"], ctx.worktree)
          if (current.code !== 0 || FileLock.key(pathSvc.resolve(ctx.worktree, current.text.trim())) !== commonKey)
            return yield* own
          yield* checkCheckout()
          // --no-track keeps .git/config, which the runner hashes, unwritten.
          const created = yield* unattendedGit(
            ["worktree", "add", "--no-checkout", "--no-track", "-b", input.branch, "--", directory, input.base],
            ctx.worktree,
          )
          if (created.code !== 0) return yield* failed
          const populated = yield* unattendedGit(["reset", "--hard", "--quiet", "--no-recurse-submodules"], directory)
          if (
            populated.code !== 0 ||
            !(yield* unattendedPrints(["rev-parse", "--verify", "HEAD"], directory, input.base)) ||
            !(yield* unattendedPrints(["symbolic-ref", "HEAD"], directory, `refs/heads/${input.branch}`))
          )
            return yield* failed
          // The real path in its native case: canonical() lowercases on Windows, which the runner's own toplevel
          // comparison would not match.
          const placed = yield* Effect.try({ try: () => FSUtil.realpath(directory), catch: () => failed })
          yield* project.addSandbox(ctx.project.id, placed).pipe(Effect.catchDefect(() => Effect.fail(failed)))
          // A standalone caller can still use the established worktree route. The private Desktop creator insists
          // on this positive placement record before it can start a model session.
          yield* Effect.gen(function* () {
            const gitDirectory = yield* unattendedGit(["rev-parse", "--absolute-git-dir"], placed)
            if (gitDirectory.code !== 0 || !pathSvc.isAbsolute(gitDirectory.text.trim())) return yield* failed
            const gitPath = yield* Effect.try({
              try: () => FSUtil.realpath(gitDirectory.text.trim()),
              catch: () => failed,
            })
            if (pathSvc.dirname(FileLock.key(gitPath)) !== pathSvc.join(commonKey, "worktrees")) return yield* failed
            const directoryIdentity = yield* UnattendedRecords.identity(placed)
            const gitIdentity = yield* UnattendedRecords.identity(gitPath)
            yield* UnattendedRecords.write(input.jid, "placed", {
              version: 1,
              project: ctx.project.id,
              jid: input.jid,
              directory: placed,
              branch: input.branch,
              base: input.base,
              common: commonKey,
              gitDirectory: gitPath,
              directoryIdentity,
              gitIdentity,
            })
          }).pipe(Effect.catch(() => Effect.logWarning("Could not record the unattended worktree placement.")))
          return { directory: placed, branch: input.branch, base: input.base }
        }),
      )
    })

    const withUnattendedPlacement: Interface["withUnattendedPlacement"] = (input, use) =>
      Effect.gen(function* () {
        const placed = yield* UnattendedRecords.read(input.jid, "placed", UnattendedRecords.Placed).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const reserved = yield* UnattendedRecords.read(input.jid, "reservation", UnattendedRecords.Reservation).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        if (
          !placed ||
          !reserved ||
          placed.jid !== input.jid ||
          reserved.jid !== input.jid ||
          placed.branch !== input.branch ||
          reserved.branch !== input.branch ||
          placed.base !== input.base ||
          reserved.base !== input.base ||
          placed.project !== reserved.project ||
          placed.directory !== input.directory ||
          !pathSvc.isAbsolute(input.directory)
        )
          return undefined
        const absolute = yield* canonicalPath(input.directory)
        const root = yield* canonicalPath(unattendedRoot)
        if (
          !absolute ||
          !root ||
          absolute !== folded(placed.directory) ||
          absolute !== pathSvc.join(root, placed.project, input.jid)
        )
          return undefined
        return yield* FileLock.forTree(placed.common)(
          Effect.gen(function* () {
            if (!(yield* UnattendedRecords.intact(placed))) return undefined
            const common = yield* unattendedGit(["rev-parse", "--git-common-dir"], input.directory)
            const gitDirectory = yield* unattendedGit(["rev-parse", "--absolute-git-dir"], input.directory)
            if (
              common.code !== 0 ||
              gitDirectory.code !== 0 ||
              FileLock.key(pathSvc.resolve(input.directory, common.text.trim())) !== placed.common ||
              FileLock.key(gitDirectory.text.trim()) !== FileLock.key(placed.gitDirectory)
            )
              return undefined
            const top = yield* unattendedGit(["rev-parse", "--show-toplevel"], input.directory)
            if (
              top.code !== 0 ||
              (yield* canonicalPath(top.text.trim())) !== absolute ||
              !(yield* unattendedPrints(["symbolic-ref", "HEAD"], input.directory, `refs/heads/${input.branch}`)) ||
              !(yield* unattendedPrints(["rev-parse", "--verify", "HEAD"], input.directory, input.base))
            )
              return undefined
            return yield* use(placed)
          }),
        )
      }).pipe(Effect.withSpan("Worktree.withUnattendedPlacement"))

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

      if (yield* overlapsUnattended(input.directory, directory)) {
        return yield* new RemoveFailedError({
          message: "Cannot remove a Vector Everywhere worktree through this command.",
        })
      }

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
      if (yield* overlapsUnattended(input.directory, directory)) {
        return yield* new ResetFailedError({
          message: "Cannot reset a Vector Everywhere worktree through this command.",
        })
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

    return Service.of({
      makeWorktreeInfo,
      createFromInfo,
      create,
      createForTask,
      createUnattended,
      withUnattendedPlacement,
      list,
      remove,
      removeForTask,
      reset,
    })
  }),
)

/**
 * How worktrees, and the unattended worktree route, compare folders: the real path, normalized, and case-folded only
 * on Windows. Git lists a worktree under the real path it stored, also once the folder is gone: on Windows that is the
 * long name, where Node's non-native realpath keeps 8.3 short names such as RUNNER~1. FSUtil.realpath resolves
 * natively on Windows and resolves the deepest existing ancestor of a missing folder, so both spellings meet. A path
 * with no real path (a link loop) gives undefined.
 */
export function canonicalPath(input: string) {
  return Effect.try({ try: () => FSUtil.realpath(input), catch: () => undefined }).pipe(
    Effect.map(folded),
    Effect.orElseSucceed(() => undefined),
  )
}

function folded(input: string) {
  const normalized = normalize(input)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, Project.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
