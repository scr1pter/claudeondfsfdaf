export * as ConfigPaths from "./paths"

import path from "path"
import { realpath, stat } from "node:fs/promises"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { unique } from "remeda"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ConfigImport } from "./import-settings"

/** One physical scope for discovery and trust: Windows short names and directory links must not split its inputs. */
export async function canonicalScope<T extends { directory: string; worktree: string }>(ctx: T) {
  const [directory, worktree] = await Promise.all([
    realpath(path.resolve(FSUtil.windowsPath(ctx.directory))),
    ctx.worktree === "/" ? Promise.resolve("/") : realpath(path.resolve(FSUtil.windowsPath(ctx.worktree))),
  ])
  const [opened, root] = await Promise.all([stat(directory), worktree === "/" ? undefined : stat(worktree)])
  if (!opened.isDirectory() || (root && !root.isDirectory()))
    throw new Error("The configuration scope is no longer a directory.")
  if (worktree !== "/" && !FSUtil.contains(worktree, directory))
    throw new Error("The configuration directory is outside its resolved worktree.")
  return { ...ctx, directory, worktree }
}

const migrate = (directory: string, worktree?: string) =>
  ConfigImport.discover({
    directory,
    worktree,
    global: Global.Path.config,
    home: Global.Path.home,
    disableProject: Flag.VECTOR_DISABLE_PROJECT_CONFIG,
  })

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  yield* migrate(directory, worktree)
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  yield* migrate(directory, worktree)
  const agentDirectory = yield* environmentPath(Flag.VECTOR_AGENT_CONFIG_DIR, { directory, worktree })
  const result = unique([
    Global.Path.config,
    ...(!Flag.VECTOR_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".vector"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".vector"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(agentDirectory ? [agentDirectory.path] : []),
  ])
  return result
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/**
 * The project's own spelling of `file` when the project owns it under any spelling (see FSUtil.within), or nothing when
 * it is the user's. A path inside the project as written keeps that spelling, so trust binds a symlinked config file to
 * its logical identity. The user's own config folders stay theirs even when the workspace is their home or config
 * folder. A path that cannot be resolved (a link loop) is treated as the project's, which holds it back until trust.
 */
export function projectPath(file: string, ctx: { directory: string; worktree?: string }): string | undefined {
  const requested = path.resolve(FSUtil.windowsPath(file))
  if (userOwned(requested)) return
  try {
    return FSUtil.within(roots(ctx), requested)
  } catch {
    return requested
  }
}

export function projectContains(file: string, ctx: { directory: string; worktree?: string }) {
  return projectPath(file, ctx) !== undefined
}

/**
 * Where a config file or directory named by an environment variable is read from, and whether the project owns it
 * (see projectPath). Anything that is not the project's is read exactly where it was classified, because the raw
 * value can name another file: `..` is collapsed before classifying, while the kernel follows a link before applying
 * `..`. A path that cannot be resolved is not loaded at all rather than trusted as the user's own.
 */
export const environmentPath = Effect.fnUntraced(function* (
  input: string | undefined,
  ctx: { directory: string; worktree?: string },
) {
  if (!input) return
  const requested = path.resolve(FSUtil.windowsPath(input))
  if (userOwned(requested)) return { path: requested, project: false }
  return yield* Effect.try({ try: () => FSUtil.within(roots(ctx), requested), catch: (cause) => cause }).pipe(
    Effect.map((project) => (project ? { path: project, project: true } : { path: requested, project: false })),
    Effect.catch((cause) =>
      Effect.logWarning("ignoring a config path that cannot be resolved", { path: input, cause: String(cause) }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
})

// Non-git projects set worktree to "/", which would contain every path.
function roots(ctx: { directory: string; worktree?: string }) {
  return ctx.worktree && ctx.worktree !== "/" ? [ctx.directory, ctx.worktree] : [ctx.directory]
}

/** Whether a path lies in the user's own config folders, which stay theirs even inside a workspace. */
export function userOwned(file: string) {
  return [Global.Path.config, path.join(Global.Path.home, ".vector")].some((root) => FSUtil.contains(root, file))
}
