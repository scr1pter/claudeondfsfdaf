import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { FileLock } from "@/tool/file-lock"

export type Place = { readonly work: InstanceContext; readonly home: InstanceContext }

const assigned = new Map<string, Place>()
// Launch ownership exists even for shared-workspace helpers and survives replacing an inherited place.
const parents = new Map<string, string>()
const inherited = new Set<string>()

export function set(sessionID: string, place: Place) {
  inherited.delete(sessionID)
  assigned.set(sessionID, { work: place.work, home: place.home })
  for (let parentID = parents.get(sessionID); parentID && !assigned.has(parentID); parentID = parents.get(parentID)) {
    assigned.set(parentID, { work: place.home, home: place.home })
  }
  refresh(sessionID)
}

/** Refresh inherited descendants on resume while preserving explicit isolation placements. */
function refresh(sessionID: string) {
  const pending = [sessionID]
  const seen = new Set<string>()
  for (const parentID of pending) {
    if (seen.has(parentID)) continue
    seen.add(parentID)
    const place = assigned.get(parentID)
    if (!place) continue
    for (const [id, parent] of parents) {
      if (parent !== parentID || !inherited.has(id) || seen.has(id)) continue
      assigned.set(id, { work: place.work, home: place.home })
      pending.push(id)
    }
  }
}

export function get(sessionID: string) {
  return assigned.get(sessionID)
}

export function homeOf(sessionID: string) {
  return assigned.get(sessionID)?.home
}

export function parentOf(sessionID: string) {
  return parents.get(sessionID)
}

export function inherit(sessionID: string, parentID: string) {
  parents.set(sessionID, parentID)
  if (assigned.has(sessionID) && !inherited.has(sessionID)) return assigned.get(sessionID)
  inherited.add(sessionID)
  const place = assigned.get(parentID)
  if (place) {
    assigned.set(sessionID, { work: place.work, home: place.home })
    refresh(sessionID)
  }
  return place
}

export function places() {
  return Array.from(assigned, ([sessionID, place]) => ({ sessionID, ...place, parentID: parents.get(sessionID) }))
}

/** After callers stop/join every shared descendant, retire their work context while retaining home and lineage. */
export function dropWork(sessionID: string) {
  const place = assigned.get(sessionID)
  if (!place) return
  for (const [id, entry] of assigned) {
    if (
      FileLock.key(entry.work.directory) !== FileLock.key(place.work.directory) ||
      FileLock.key(entry.home.directory) !== FileLock.key(place.home.directory) ||
      entry.home.project.id !== place.home.project.id
    )
      continue
    assigned.set(id, { work: entry.home, home: entry.home })
  }
}

export function drop(sessionID: string) {
  assigned.delete(sessionID)
  parents.delete(sessionID)
  inherited.delete(sessionID)
}

export const within =
  (sessionID: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const place = assigned.get(sessionID)
      return place ? effect.pipe(Effect.provideService(InstanceRef, place.work)) : effect
    })

export const atHome =
  (sessionID?: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const explicit = sessionID === undefined ? undefined : assigned.get(sessionID)?.home
      if (explicit) return yield* effect.pipe(Effect.provideService(InstanceRef, explicit))
      const current = yield* InstanceRef
      if (!current) return yield* effect
      const homes = Array.from(assigned.values())
        .filter((place) => FileLock.key(place.work.directory) === FileLock.key(current.directory))
        .map((place) => place.home)
      const home = homes[0]
      if (!home) return yield* effect
      if (
        homes.some(
          (candidate) =>
            FileLock.key(candidate.directory) !== FileLock.key(home.directory) ||
            FileLock.key(candidate.worktree) !== FileLock.key(home.worktree) ||
            candidate.project.id !== home.project.id,
        )
      ) {
        return yield* Effect.die(new Error(`Task work directory has more than one home: ${current.directory}`))
      }
      return yield* effect.pipe(Effect.provideService(InstanceRef, home))
    })

/** A reserved-looking name or live map entry alone is never isolation authority. */
export function isTaskDirectory(directory: string) {
  try {
    const root = realpathSync(path.join(Global.Path.data, "task-worktree"))
    const target = realpathSync(directory)
    const relative = path.relative(root, target)
    const parts = relative.split(path.sep)
    if (path.isAbsolute(relative) || parts.length !== 2 || parts.some((part) => !part || part === "." || part === ".."))
      return false
    const [projectID, sessionID] = parts
    const file = path.join(Global.Path.data, "task-isolation", projectID!, sessionID!, "record.json")
    const record = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!record || typeof record !== "object" || Array.isArray(record)) return false
    if (!("directory" in record) || typeof record.directory !== "string") return false
    if ("mode" in record && record.mode !== "worktree" && record.mode !== "copy") return false
    const copy = "mode" in record && record.mode === "copy"
    if (copy && "branch" in record && record.branch !== undefined) return false
    if (!copy && (!("branch" in record) || record.branch !== `vector/subagent/${sessionID}`)) return false
    return FileLock.key(realpathSync(record.directory)) === FileLock.key(target)
  } catch {
    return false
  }
}

export * as TaskPlace from "./place"
