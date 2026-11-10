import path from "node:path"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FileLock } from "./file-lock"
import { TaskClaims } from "@/task/claims"
import { TaskSize } from "@vectordevai/core/task-size"
import type { Tool } from "./tool"

type Context = Pick<Tool.Context, "sessionID" | "parentID" | "getOwnedPaths" | "ownedPaths" | "inFamily">

/** Explicit file tools enforce assignments. Shell execution is not a filesystem sandbox. */
export const assertOwnedPath = Effect.fn("Task.assertOwnedPath")(function* (context: Context, target: string) {
  const ownedPaths = context.getOwnedPaths ? yield* context.getOwnedPaths() : context.ownedPaths
  if (!ownedPaths?.length) return
  const instance = yield* InstanceState.context
  const root = FSUtil.realpath(instance.directory)
  const destination = FSUtil.realpath(target)
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child)
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  if (
    inside(root, destination) &&
    ownedPaths.some((owned) => {
      const boundary = FSUtil.realpath(path.resolve(root, owned))
      return inside(root, boundary) && inside(boundary, destination)
    })
  )
    return
  return yield* Effect.die(
    new Error(
      "This edit is outside the subagent's owned_paths. Report the required cross-boundary change to the parent; a message cannot expand file ownership.",
    ),
  )
})

function refKey(tree: string, ref: string) {
  const insensitive = FileLock.key(path.join(tree, "Vector")) === FileLock.key(path.join(tree, "vector"))
  return insensitive ? ref.normalize("NFC").toLowerCase() : ref
}

// Task branches, and the private refs that pin a kept task's partial-merge bases against Git's gc (TaskIsolation).
function reservedRef(tree: string, ref: string) {
  return /^(?:(?:refs\/heads\/)?vector\/subagent|refs\/vector\/isolation)(?:\/|$)/.test(refKey(tree, ref))
}

function sameRef(tree: string, left: string | undefined, right: string) {
  return (
    left !== undefined &&
    refKey(tree, left).replace(/^refs\/heads\//, "") === refKey(tree, right).replace(/^refs\/heads\//, "")
  )
}

/** Refuses conflicting ownership before prompting and again inside the file lock. */
export const assertWritable = Effect.fn("OwnedPath.assertWritable")(function* (
  context: Context,
  input: Tool.WritableInput,
) {
  const instance = yield* InstanceState.context
  // A subagent's title, session ID and owned paths belong to its conversation: a refusal names them only when that
  // conversation is in the caller's family, and without the relation never.
  const named = (sessionID: string) => (context.inFamily ? context.inFamily(sessionID) : Effect.succeed(false))
  const files = [
    ...new Set([
      ...input.files,
      ...(input.git ?? []).flatMap((mutation) => [
        ...mutation.paths,
        ...(mutation.effects.length
          ? [mutation.gitDirectory, mutation.indexFile].filter((file): file is string => file !== undefined)
          : []),
      ]),
    ]),
  ]
  for (const file of files) {
    const protectedTree = TaskClaims.protectedConflict(
      context.sessionID,
      file,
      input.recursive?.some((target) => FileLock.key(target) === FileLock.key(file)),
    )
    if (protectedTree)
      return yield* Effect.die(
        new Error(
          (yield* named(protectedTree.taskID))
            ? `${file} is protected for subagent ${protectedTree.taskID}. It was not changed.`
            : `${file} is protected for another conversation's subagent. It was not changed.`,
        ),
      )
    const destination = TaskClaims.parentTarget(
      context.sessionID,
      file,
      input.recursive?.some((target) => FileLock.key(target) === FileLock.key(file)),
    )
    if (destination)
      return yield* Effect.die(
        new Error(
          `An isolated subagent cannot edit its parent's working tree. Change ${destination} in your worktree instead.`,
        ),
      )
    yield* assertOwnedPath(context, file)
    const conflict = [...new Set([instance.worktree, ...TaskClaims.trees()])].flatMap((tree) =>
      TaskClaims.conflicts({ tree, sessionID: context.sessionID, file }),
    )[0]
    if (!conflict) continue
    // The launcher is in the holder's family by construction, and is known while the child is still starting.
    if (!(yield* named(conflict.entry.parentSessionID))) {
      const reason =
        conflict.owned !== undefined
          ? `${file} belongs to another conversation's running subagent. It was not changed.`
          : `${file} was changed by another conversation's running subagent and stays its file until it finishes. It was not changed.`
      // task_manage reaches only this conversation's subagents, so a root can only wait for that one.
      const next = context.parentID ? "Report the change you need to the parent." : "Wait for it to finish."
      return yield* Effect.die(new Error(`${reason} ${next}`))
    }
    const title = TaskSize.neutralizeTags(conflict.entry.title)
    const who = `the running subagent "${title}" (${conflict.entry.taskID ?? "starting"})`
    const reason =
      conflict.owned !== undefined
        ? `${file} belongs to ${who}, which owns ${conflict.owned}. It was not changed.`
        : `${file} was changed by ${who} and stays its file until it finishes. It was not changed.`
    const next = context.parentID
      ? "Report the change you need to the parent."
      : "Wait for its report, send it the change with task_manage message, or stop it first."
    return yield* Effect.die(new Error(`${reason} ${next}`))
  }
  for (const mutation of input.git ?? []) {
    const roots = [...new Set([mutation.tree, ...(mutation.workingTree ? [mutation.workingTree] : [])])]
    const protectedMetadata = [mutation.gitDirectory, mutation.indexFile].some(
      (file) => file && TaskClaims.protectedConflict(context.sessionID, file),
    )
    const forbiddenRef = mutation.refs.some(
      (ref) =>
        ref === "*" ||
        reservedRef(mutation.tree, ref) ||
        TaskClaims.protectedTrees().some(
          (entry) =>
            sameRef(mutation.tree, entry.branch, ref) ||
            entry.directories.some((directory) =>
              TaskClaims.pathsOverlap(directory, path.resolve(mutation.directory, ref)),
            ),
        ),
    )
    if (
      mutation.effects.length > 0 &&
      (forbiddenRef || protectedMetadata || roots.some((tree) => TaskClaims.protectedConflict(context.sessionID, tree)))
    )
      return yield* Effect.die(
        new Error("Vector's isolated subagent branches and worktrees are protected. This git command was not run."),
      )
    // A git operation in the parent tree has no individual file targets; it still crosses the isolation boundary.
    const parent = roots
      .map((tree) => TaskClaims.parentTarget(context.sessionID, tree))
      .find((directory) => directory !== undefined)
    if (parent && mutation.effects.length)
      return yield* Effect.die(
        new Error(
          `An isolated subagent cannot change its parent's working tree. Use ${parent} in your worktree instead.`,
        ),
      )
    const isolated = TaskClaims.isolatedTree(context.sessionID)
    const helper = context.parentID !== undefined || TaskClaims.forTask(context.sessionID).length > 0
    if (helper && mutation.effects.length) {
      // A missing runtime assignment fails closed even for commands with no file targets (for example git reset).
      if (context.getOwnedPaths) yield* context.getOwnedPaths()
      if (isolated && roots.some((tree) => FileLock.key(tree) !== FileLock.key(isolated)))
        return yield* Effect.die(new Error("An isolated subagent may change git state only in its own working tree."))
      if (
        (isolated && mutation.stash) ||
        mutation.effects.some((effect) => ["refs", "stash"].includes(effect)) ||
        (isolated && (mutation.effects.includes("branch") || mutation.refs.length > 0))
      )
        return yield* Effect.die(
          new Error(
            "Branches, tags, stashes and worktrees are shared by the whole repository, so a subagent may not change them.",
          ),
        )
      if (!isolated && mutation.effects.some((effect) => ["tree", "branch", "head", "index"].includes(effect)))
        return yield* Effect.die(
          new Error(
            "You share the user's working tree, so whole-tree git commands are not allowed. Report what you need to the parent.",
          ),
        )
    }
    if ((helper && !isolated) || !mutation.effects.some((effect) => ["tree", "branch", "stash"].includes(effect)))
      continue
    const writers = [
      ...new Map(
        roots
          .flatMap((tree) => TaskClaims.writers(tree, context.sessionID))
          .map((entry) => [entry.taskID ?? entry, entry]),
      ).values(),
    ]
    if (!writers.length) continue
    const shown = yield* Effect.forEach(writers, (entry) => named(entry.parentSessionID))
    const names = writers.filter((_, index) => shown[index]).map((entry) => `"${TaskSize.neutralizeTags(entry.title)}"`)
    const others = writers.length - names.length
    return yield* Effect.die(
      new Error(
        others === 0
          ? `This git command changes the whole working tree while ${writers.length} subagents are editing it (${names.join(", ")}). It was not run. Wait for them or stop them first.`
          : `This git command changes the whole working tree while ${writers.length} subagents are editing it (${[...names, `${others} outside this conversation`].join(", ")}). It was not run. Wait for them to finish.`,
      ),
    )
  }
})
