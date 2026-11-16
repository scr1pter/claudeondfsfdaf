export * as ReviewMemoryScope from "./memory-scope"

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { DirectoryIdentityReader } from "@vectordevai/core/directory-identity"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ReviewSourceBinding } from "@vectordevai/core/review/source-binding"

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewMemoryScope.Refused", {
  message: Schema.String,
}) {}

const refused = () => new Refused({ message: "The repository's physical review-memory scope could not be verified." })
const inside = (root: string, directory: string) => {
  const relative = path.relative(root, directory)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const validLocation = (location: string) =>
  path.isAbsolute(location) && location.length <= 4096 && !/[\0\r\n]/.test(location)
const scope = (kind: "git" | "folder", directory: string, identity: ReadOnlyGit.DirectoryIdentity) =>
  `vrs1_${createHash("sha256")
    .update(JSON.stringify(["review-memory-scope-v1", kind, directory, identity.dev, identity.ino, identity.birth]))
    .digest("hex")}`

/** The identity comes from the actual private snapshot's pinned common FD, never a later path stat. */
export const repositoryScope = (repository: Pick<ReadOnlyGit.Repository, "commonDirectory" | "commonIdentity">) =>
  repository.commonIdentity ? scope("git", repository.commonDirectory, repository.commonIdentity) : undefined

export const git = Effect.fn("ReviewMemoryScope.git")(function* (worktree: string, directory = worktree) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      signal.throwIfAborted()
      if (!validLocation(worktree) || !validLocation(directory)) throw refused()
      const root = await fs.realpath(worktree)
      const selected = await fs.realpath(directory)
      if (!inside(root, selected)) throw refused()
      const metadata = await ReadOnlyGit.metadataHead(root, { signal })
      if (!metadata.commonIdentity) throw refused()
      // Registration and common-store identity were observed together from the
      // validated FD. An independent stat of commonDirectory cannot replace it.
      if (
        metadata.directory !== root ||
        (await fs.realpath(worktree)) !== root ||
        (await fs.realpath(directory)) !== selected
      )
        throw refused()
      const binding: ReviewSourceBinding.Info = Object.freeze({
        version: 1,
        scope: scope("git", metadata.commonDirectory, metadata.commonIdentity),
        directory: selected,
        worktree: root,
        gitDirectory: metadata.gitDirectory,
        commonDirectory: metadata.commonDirectory,
        commonIdentity: metadata.commonIdentity,
      })
      if (Option.isNone(Schema.decodeUnknownOption(ReviewSourceBinding.Info, { onExcessProperty: "error" })(binding)))
        throw refused()
      return { binding, metadata }
    },
    catch: refused,
  })
})

const noGitAncestor = async (directory: string) => {
  let current = directory
  for (let count = 0; count < 128; count++) {
    const marker = await fs.lstat(path.join(current, ".git")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return false
      },
    )
    if (marker) throw refused()
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
  throw refused()
}

/** Exact non-Git folder identity. A failed or malformed Git proof never falls back here. */
export const folder = Effect.fn("ReviewMemoryScope.folder")(function* (directory: string) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      signal.throwIfAborted()
      if (!validLocation(directory)) throw refused()
      const canonical = await fs.realpath(directory)
      await noGitAncestor(canonical)
      const handle = await fs.open(
        canonical,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const actual = await handle.stat({ bigint: true })
        if (!actual.isDirectory() || actual.ino <= 0n) throw refused()
        const identity = await DirectoryIdentityReader.read(handle, signal)
        if (!identity) throw refused()
        const current = await fs.stat(canonical, { bigint: true })
        if (current.dev !== actual.dev || current.ino !== actual.ino || (await fs.realpath(directory)) !== canonical)
          throw refused()
        await noGitAncestor(canonical)
        return Object.freeze({ scope: scope("folder", canonical, identity), directory: canonical, identity })
      } finally {
        await handle.close()
      }
    },
    catch: refused,
  })
})

/** Legacy/unbound records refuse; today's path cannot manufacture an old run's admission binding. */
export const verify = Effect.fn("ReviewMemoryScope.verify")(function* (input: unknown) {
  const parsed = Schema.decodeUnknownOption(ReviewSourceBinding.Info, { onExcessProperty: "error" })(input)
  if (Option.isNone(parsed)) return yield* refused()
  const original = parsed.value
  const current = yield* git(original.worktree, original.directory)
  const observed = current.binding
  if (
    observed.scope !== original.scope ||
    observed.directory !== original.directory ||
    observed.worktree !== original.worktree ||
    observed.gitDirectory !== original.gitDirectory ||
    observed.commonDirectory !== original.commonDirectory ||
    observed.commonIdentity.dev !== original.commonIdentity.dev ||
    observed.commonIdentity.ino !== original.commonIdentity.ino ||
    observed.commonIdentity.birth !== original.commonIdentity.birth
  )
    return yield* refused()
  return current
})
