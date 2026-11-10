import path from "node:path"
import { Effect } from "effect"
import type { SessionAudience } from "@vectordevai/core/session/audience"
import { FileLock } from "@/tool/file-lock"
import { registerDisposer } from "@/effect/instance-registry"

/** Process-local ownership, shared by every conversation using the same real working tree. */
export type Claim = {
  tree: string
  directory: string
  parentSessionID: string
  taskID?: string
  title: string
  paths: string[]
  files: Set<string>
  writes: boolean
  isolated: boolean
  active: boolean
  held?: boolean
}

export type Input = Omit<Claim, "files" | "active" | "writes" | "isolated"> & {
  writes?: boolean
  isolated?: boolean
}

export const claims = new Set<Claim>()
// A settled child keeps its trusted assignment for follow-ups; only active entries exclude other writers.
const assignments = new Map<string, { directory: string; paths: string[]; parentSessionID: string }>()
const MAX_ASSIGNMENTS = 10_000

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function lineage(sessionID: string) {
  const ids = new Set<string>()
  let current: string | undefined = sessionID
  while (current && !ids.has(current)) {
    ids.add(current)
    current =
      [...claims].find((entry) => entry.active && entry.held && entry.taskID === current)?.parentSessionID ??
      assignments.get(current)?.parentSessionID
  }
  return ids
}

export function reserve(input: Input): Claim {
  const entry: Claim = {
    ...input,
    tree: FileLock.key(input.tree),
    directory: FileLock.key(input.directory),
    paths: [...new Set(input.paths)],
    files: new Set(),
    writes: input.writes ?? true,
    isolated: input.isolated ?? false,
    active: true,
  }
  claims.add(entry)
  return entry
}

/** Transfers a provisional launch claim to the child; it then lives until the job settles. */
export function bind(entry: Claim, taskID: string) {
  const active = forTask(taskID).filter((other) => other.held && other !== entry)
  entry.taskID = taskID
  entry.held = true
  entry.paths = [...new Set([...active.flatMap((other) => other.paths), ...entry.paths])]
  active.forEach((other) => other.files.forEach((file) => entry.files.add(file)))
  assignments.delete(taskID)
  assignments.set(taskID, {
    directory: entry.directory,
    parentSessionID: entry.parentSessionID,
    paths: [...entry.paths],
  })
  while (assignments.size > MAX_ASSIGNMENTS) assignments.delete(assignments.keys().next().value!)
}

export function release(entry: Claim) {
  entry.active = false
  claims.delete(entry)
  if (!entry.taskID) return
  const active = forTask(entry.taskID).filter((other) => other.held)
  if (active.length)
    assignments.set(entry.taskID, {
      directory: active[0].directory,
      parentSessionID: active[0].parentSessionID,
      paths: [...new Set(active.flatMap((other) => other.paths))],
    })
}

export function forTask(taskID: string) {
  return [...claims].filter((entry) => entry.active && entry.taskID === taskID)
}

export function pathsFor(taskID: string) {
  const entries = forTask(taskID).filter((entry) => entry.held)
  return entries.length ? [...new Set(entries.flatMap((entry) => entry.paths))] : assignments.get(taskID)?.paths
}

/** Missing scope is different from an explicitly unrestricted assignment ([]). */
export function trustedPaths(taskID: string, required: boolean) {
  const paths = pathsFor(taskID)
  if (required && paths === undefined)
    throw new Error(
      "This subagent's trusted file assignment is unavailable. Resume it through the parent before editing or delegating.",
    )
  return paths
}

/** Canonical path comparison shared by launch and batch-resume admission. */
export function pathsOverlap(left: string, right: string) {
  const a = FileLock.key(left)
  const b = FileLock.key(right)
  return inside(a, b) || inside(b, a)
}

/**
 * Launch exceptions match task dependencies, resumes and the launching child's own ancestors. Each overlap pairs the
 * launcher's own path with the claim's path or changed file, relative to the claim's directory.
 */
export function overlaps(input: {
  tree: string
  directory: string
  parentSessionID: string
  taskID?: string
  paths: readonly string[]
  except?: ReadonlySet<string>
}) {
  const tree = FileLock.key(input.tree)
  const ancestors = lineage(input.parentSessionID)
  return [...claims]
    .filter(
      (entry) =>
        entry.active &&
        entry.writes &&
        !entry.isolated &&
        entry.tree === tree &&
        !(
          entry.taskID &&
          (ancestors.has(entry.taskID) || entry.taskID === input.taskID || input.except?.has(entry.taskID))
        ),
    )
    .flatMap((entry) =>
      input.paths.flatMap((owned) => {
        const destination = FileLock.key(path.resolve(input.directory, owned))
        return [
          ...entry.paths
            .filter((existing) => {
              const boundary = FileLock.key(path.resolve(entry.directory, existing))
              return inside(boundary, destination) || inside(destination, boundary)
            })
            .map((existing) => ({ entry, owned, existing })),
          ...[...entry.files]
            .filter((file) => inside(destination, file) || inside(file, destination))
            .map((file) => ({ entry, owned, existing: path.relative(entry.directory, file) })),
        ]
      }),
    )
}

/**
 * The refusal's lines for `overlaps`. A claim's title, paths and changed files belong to its conversation, so they are
 * named only when its launcher is in the caller's family; otherwise the line gives only the caller's own path. Without
 * the relation nothing is named.
 */
export const describe = Effect.fnUntraced(function* (
  found: ReturnType<typeof overlaps>,
  inFamily: ((sessionID: string) => Effect.Effect<boolean>) | undefined,
) {
  const launchers = [...new Set(found.map((item) => item.entry.parentSessionID))]
  const named = new Set(
    inFamily
      ? (yield* Effect.forEach(launchers, (id) => inFamily(id).pipe(Effect.map((shown) => (shown ? [id] : []))))).flat()
      : [],
  )
  return [
    ...new Set(
      found.map((item) =>
        named.has(item.entry.parentSessionID)
          ? `${item.entry.title}: ${item.owned} overlaps ${item.existing}`
          : `${item.owned} overlaps another conversation's running subagent`,
      ),
    ),
  ]
})

/**
 * The family relation refusals name by, bound to the caller. SessionTools' `Tool.Context.inFamily` hook and the
 * `TaskManager.resume` refusal both use it. A family that cannot be read is logged and names no other conversation.
 */
export const familyOf = (audience: Pick<SessionAudience.Interface, "inFamily">, sessionID: string) => (other: string) =>
  audience
    .inFamily(sessionID, other)
    .pipe(
      Effect.catchDefect((cause) =>
        Effect.logWarning("the conversation family could not be read", { cause }).pipe(Effect.as(false)),
      ),
    )

/** Checks all other roots too, while allowing the writer to work within its ancestors' assignments. */
export function conflicts(input: { tree: string; sessionID: string; file: string }) {
  const tree = FileLock.key(input.tree)
  const file = FileLock.key(input.file)
  const ancestors = lineage(input.sessionID)
  return [...claims].flatMap<{ entry: Claim; owned: string | undefined }>((entry) => {
    if (
      !entry.active ||
      !entry.writes ||
      entry.isolated ||
      entry.tree !== tree ||
      (entry.taskID && ancestors.has(entry.taskID))
    )
      return []
    const owned = entry.paths.find((item) => {
      const boundary = FileLock.key(path.resolve(entry.directory, item))
      return inside(boundary, file) || inside(file, boundary)
    })
    if (owned !== undefined) return [{ entry, owned }]
    return [...entry.files].some((changed) => inside(file, changed) || inside(changed, file))
      ? [{ entry, owned: undefined }]
      : []
  })
}

/** Active shared-tree writers outside this writer's ancestors, counted once across extensions. */
export function writers(tree: string, sessionID?: string) {
  const root = FileLock.key(tree)
  const ancestors = sessionID ? lineage(sessionID) : new Set<string>()
  const unique = new Map<string | Claim, Claim>()
  for (const entry of claims) {
    const tree = entry.tree === path.parse(entry.tree).root ? entry.directory : entry.tree
    if (
      !entry.active ||
      !entry.writes ||
      entry.isolated ||
      tree !== root ||
      (entry.taskID && ancestors.has(entry.taskID))
    )
      continue
    unique.set(entry.taskID ?? entry, entry)
  }
  return [...unique.values()]
}

/** Working trees known to this process; registry folders themselves are not git trees. */
export function trees() {
  return [
    ...new Set([
      ...[...claims].map((entry) => (entry.tree === path.parse(entry.tree).root ? entry.directory : entry.tree)),
      ...protectedTrees().flatMap((entry) =>
        [entry.workDirectory, entry.parentDirectory].filter((value): value is string => value !== undefined),
      ),
    ]),
  ]
}

/** Directly isolated helpers may mutate their own branch; shared descendants retain shared-helper git rules. */
export function isolatedTree(sessionID: string) {
  return forTask(sessionID).find((entry) => entry.held && entry.isolated)?.tree
}

/** Called after each explicit-file write, while the file lock is still held. */
export function touch(sessionID: string, file: string) {
  for (const entry of forTask(sessionID)) {
    if (entry.writes && !entry.isolated && entry.paths.length === 0) entry.files.add(FileLock.key(file))
  }
}

export function dropDirectory(directory: string) {
  const key = FileLock.key(directory)
  for (const entry of claims) if (entry.directory === key) release(entry)
  for (const [id, assignment] of assignments) if (assignment.directory === key) assignments.delete(id)
}

registerDisposer(async (directory) => dropDirectory(directory))

export * as TaskClaims from "./claims"

/** Registered by isolation after validating its registry, never from model-writable session metadata. */
export type Protection = {
  taskID: string
  directories: readonly string[]
  parentDirectory?: string
  workDirectory?: string
  branch?: string
  gitDirectory?: string
  /** Authority files are never model-writable, including by the task that owns the worktree. */
  privateDirectories?: readonly string[]
  immutableFiles?: readonly string[]
}
const protections = new Map<string, Protection>()

export function protect(input: Protection) {
  protections.set(input.taskID, {
    ...input,
    privateDirectories: input.privateDirectories?.map((directory) => FileLock.key(directory)),
    immutableFiles: input.immutableFiles?.map((file) => FileLock.key(file)),
    directories: [
      ...new Set(
        [...input.directories, ...(input.gitDirectory ? [input.gitDirectory] : [])].map((directory) =>
          FileLock.key(directory),
        ),
      ),
    ],
  })
}

export function unprotect(taskID: string) {
  protections.delete(taskID)
}

export function protectedTrees() {
  return [...protections.values()]
}

/** Linked-worktree git directories are supplied only by validated isolation registration (WP27). */
export function gitDirectories() {
  return Object.fromEntries(
    protectedTrees().flatMap((entry): [string, string][] =>
      entry.gitDirectory && entry.workDirectory
        ? [[FileLock.key(entry.gitDirectory), FileLock.key(entry.workDirectory)]]
        : [],
    ),
  )
}

export function protectedConflict(sessionID: string, file: string, recursive = false) {
  const ancestors = lineage(sessionID)
  const destination = FileLock.key(file)
  return protectedTrees().find(
    (entry) =>
      entry.privateDirectories?.some(
        (directory) => inside(directory, destination) || (recursive && inside(destination, directory)),
      ) ||
      entry.immutableFiles?.some((file) => file === destination || (recursive && inside(destination, file))) ||
      (!ancestors.has(entry.taskID) &&
        entry.directories.some(
          (directory) => inside(directory, destination) || (recursive && inside(destination, directory)),
        )),
  )
}

export function parentTarget(sessionID: string, file: string, recursive = false) {
  const ancestors = lineage(sessionID)
  const destination = FileLock.key(file)
  const entry = protectedTrees().find(
    (entry) =>
      ancestors.has(entry.taskID) &&
      entry.parentDirectory &&
      (inside(FileLock.key(entry.parentDirectory), destination) ||
        (recursive && inside(destination, FileLock.key(entry.parentDirectory)))),
  )
  if (!entry?.parentDirectory || !entry.workDirectory) return undefined
  if (!inside(FileLock.key(entry.parentDirectory), destination)) return entry.workDirectory
  return path.join(entry.workDirectory, path.relative(entry.parentDirectory, file))
}

/** Provisional ownership is released on every pre-start failure or interruption. */
export const scoped = (input: Input) =>
  Effect.acquireRelease(
    Effect.sync(() => ({ claim: reserve(input), started: false })),
    (entry) => (entry.started ? Effect.void : Effect.sync(() => release(entry.claim))),
  )

/** Launch-call scope owns a reservation until bind transfers it to a job. */
export const provisional = (input: Input) =>
  Effect.acquireRelease(
    Effect.sync(() => reserve(input)),
    (entry) => (entry.held ? Effect.void : Effect.sync(() => release(entry))),
  )
