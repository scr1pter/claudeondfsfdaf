import path from "path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@vectordevai/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  // Containment is decided on the real destination, never on the requested path.
  // A symlink committed inside the project satisfies a purely textual check, so
  // checking the requested path would let any repository that ships such a link
  // hand a tool unprompted read and write access to the rest of the filesystem.
  // Both sides have to be resolved: the instance directory is itself commonly
  // reached through a link (/tmp -> /private/tmp on macOS), and comparing a real
  // path against a symlinked root would prompt for every file in the project.
  const full = FSUtil.realpath(target)
  if (
    containsPath(full, {
      ...ins,
      directory: FSUtil.realpath(ins.directory),
      worktree: FSUtil.realpath(ins.worktree),
    })
  )
    return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  // Lexical only: FSUtil.resolve runs realpathSync, which would follow the very
  // link whose name the rule is meant to keep.
  const requested = path.resolve(FSUtil.windowsPath(target))
  const requestedDir = kind === "directory" ? requested : path.dirname(requested)
  const asGlob = (value: string) =>
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(value, "*"))
      : path.join(value, "*").replaceAll("\\", "/")
  // The rule is written against the path the caller actually asked for, so an
  // allow the user already granted on a link keeps matching and approving once
  // does not silently depend on where the link happens to point today.
  // Containment above is still decided on the resolved destination, so this
  // only changes which name the rule carries, never whether we ask.
  const glob = asGlob(requestedDir)
  const resolvedGlob = asGlob(dir)

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      // The resolved path, so an approval reads as the directory that is really
      // being opened up rather than the in-project name of the link.
      filepath: full,
      parentDir: dir,
      // Surfaced separately so an approval prompt can show that the requested
      // path is a link and where it lands.
      ...(resolvedGlob === glob ? {} : { requestedPath: requested }),
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}

/**
 * The read permission patterns for a file: the name the caller used and, when it differs, the file really read.
 * Rules such as `*.env: ask` name real files, so a link (`notes.txt -> .env`) or another spelling on a disk that
 * ignores case (`.ENV` on macOS) would otherwise read the guarded file under a name no rule matches.
 */
export function readPatterns(worktree: string, target: string) {
  const requested = path.relative(worktree, target)
  const real = path.relative(FSUtil.realpath(worktree), FSUtil.realpath(target))
  return requested === real ? [requested] : [requested, real]
}

/** Restricted review listings expose only resources without an explicit read denial. */
export function filterReadListing<T>(
  ctx: Tool.Context,
  worktree: string,
  entries: readonly T[],
  // An entry's path, or every spelling of it (the name the caller used and the one a link resolved to).
  target: (entry: T) => string | readonly string[],
) {
  if (ctx.extra?.restrictedReadListing !== true) return Effect.succeed(entries)
  if (!ctx.deniedResources)
    return Effect.die(new Error("This restricted review cannot inspect file listing permissions."))
  const candidates = entries.map((entry) => ({
    entry,
    resources: [
      ...new Set(
        [...new Set([target(entry)].flat())]
          .flatMap((file) => readPatterns(worktree, file))
          .map((resource) => resource.replaceAll("\\", "/")),
      ),
    ],
  }))
  return ctx
    .deniedResources({ permission: "read", patterns: [...new Set(candidates.flatMap((entry) => entry.resources))] })
    .pipe(
      Effect.map((refused) => {
        const denied = new Set(refused)
        return candidates
          .filter((entry) => !entry.resources.some((resource) => denied.has(resource)))
          .map((entry) => entry.entry)
      }),
    )
}
