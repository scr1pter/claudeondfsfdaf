import path from "node:path"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Wildcard } from "@/util/wildcard"

export interface Placement {
  directory: string
  worktree: string
  readRoot?: string
}

export interface ReadAuthority {
  readonly absolute: readonly string[]
  readonly patterns: readonly string[]
  readonly patternsFor: (worktree: string) => readonly string[]
  readonly denied: (file: string) => boolean
}

// Read/Grep resource names are relative to the actual tool worktree. Review
// payload paths are relative to the reviewed repository. Keep both spellings,
// and their canonical destinations, so an absolute deny cannot disappear when
// the reviewer asks for a relative file or a symlink's other name.
export function readAuthority(denies: readonly string[], placement: Placement): ReadAuthority {
  if (!denies.length) {
    const patterns = Object.freeze([] as string[])
    return Object.freeze({ absolute: patterns, patterns, patternsFor: () => patterns, denied: () => false })
  }
  const source = path.resolve(FSUtil.windowsPath(placement.readRoot ?? placement.directory))
  const absolute = (pattern: string, literal = false) => {
    const clean = FSUtil.windowsPath(pattern).replaceAll("\\", "/")
    const wildcard = literal ? -1 : clean.search(/[*?]/)
    const boundary = wildcard === -1 ? clean.length : clean.lastIndexOf("/", wildcard)
    const prefix = wildcard === -1 ? clean : boundary < 0 ? "." : clean.slice(0, boundary) || "/"
    const suffix = wildcard === -1 ? "" : clean.slice(boundary + 1)
    // Resolving a `..` after a wildcard would change its meaning. Refuse all
    // reads for this unsupported authority rather than narrow the caller's deny.
    if (suffix.split("/").includes("..")) return ["*"]
    const requested = path.resolve(literal ? placement.directory : source, prefix)
    const destinations = [requested, FSUtil.realpath(requested)].map((root) =>
      suffix ? path.join(root, suffix) : root,
    )
    if (literal) return destinations
    return [
      ...destinations,
      ...destinations.flatMap((target) => {
        const inside = FSUtil.within([source], target)
        if (!inside) return []
        const projected = path.resolve(placement.directory, path.relative(source, inside))
        return [projected, FSUtil.realpath(projected)]
      }),
    ]
  }
  const roots = (worktree: string) => [
    ...new Set([path.resolve(FSUtil.windowsPath(worktree)), FSUtil.realpath(worktree)]),
  ]
  const resources = (destinations: readonly string[], worktree: string) =>
    destinations
      .flatMap((target) =>
        target === "*" ? ["*"] : [target, ...roots(worktree).map((root) => path.relative(root, target))],
      )
      .map((value) => value.replaceAll("\\", "/"))
  // Resolve once at admission, before model/context setup can yield. A later
  // symlink retarget must not remove the original canonical destination. Only
  // the relative names used by the actual helper worktree may be added later.
  const destinations = Object.freeze([...new Set(denies.flatMap((pattern) => absolute(pattern)))])
  const patternsFor = (worktree: string) => Object.freeze([...new Set(resources(destinations, worktree))])
  const patterns = patternsFor(placement.worktree)
  return Object.freeze({
    absolute: destinations,
    patterns,
    patternsFor,
    denied: (file: string) =>
      resources(absolute(file, true), placement.worktree).some((resource) =>
        patterns.some((pattern) => Wildcard.match(resource, pattern)),
      ),
  })
}

export * as ReviewReadAuthority from "./read-authority"
