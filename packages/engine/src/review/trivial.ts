import { createHash } from "node:crypto"
import { Effect } from "effect"
import ignore from "ignore"
import { minimatch } from "minimatch"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { applyPatch, parseUnifiedDiff, type DiffFile } from "@vectordevai/core/review/diff"
import { heldReason } from "@vectordevai/core/review/holdback"
import { classifyPath, hasGeneratedHeader, isSensitivePath, parseGitAttributes } from "@vectordevai/core/review/ignore"
import { classifyTrivial, type TrivialKind } from "@vectordevai/core/review/trivial"
import type { ReviewConfig, Side } from "@vectordevai/core/review/types"
import { ReviewGit } from "./git"
import { ReviewParse, type ParsedFile } from "./parse"

export * as ReviewTrivial from "./trivial"

const brand = Symbol("review.trivial")
export interface Proof {
  readonly [brand]: true
}
interface Target {
  directory: string
  base: string
  head: string
  files: readonly DiffFile[]
  config: ReviewConfig
}
interface Input extends Target {
  instructions: readonly string[]
  denied?: (file: string) => boolean
}
const issued = new WeakMap<
  Proof,
  {
    digest: string
    metadata: ReadOnlyGit.Metadata
    view?: ReviewGit.View
    kinds: readonly TrivialKind[]
  }
>()

// A proof is deliberately cheaper to abandon than a review. Every Git command also has the private port's own
// wall-time, output and object limits. Reads are serial and never fall back to a checkout, Git service or network.
const MAX_FILES = 24
const MAX_READS = 160
const MAX_BYTES = 2 * 1024 * 1024
const TIME_MS = 8_000
const oid = /^[a-f0-9]{40}$/
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

function digest(target: Target) {
  return createHash("sha256")
    .update(JSON.stringify([target.directory, target.base, target.head, target.config, target.files]))
    .digest("hex")
}

function blocked(file: string, input: Input) {
  if (!ReadOnlyGit.repositoryPath(file) || heldReason(file) || isSensitivePath(file) || input.denied?.(file))
    return true
  if (file.split("/").some((part) => part.startsWith(".")) || classifyPath(file, { config: input.config })) return true
  // The instruction loader searches relative to each ancestor. Absolute, home-relative, parent-relative and
  // remote sources can point back at repository content. Neither immutable tree can establish what they load.
  return input.instructions.some((glob) => {
    if (!/^[\w./*? -]{1,256}$/.test(glob) || glob.startsWith("/") || glob.split("/").includes("..")) return true
    return (
      minimatch(file, glob, { dot: true, nocase: true, matchBase: true }) ||
      minimatch(file, "**/" + glob.replace(/^\.\//, ""), { dot: true, nocase: true })
    )
  })
}

interface Blob {
  text: string
  parsed?: ParsedFile
}

async function collect(view: ReviewGit.View, input: Input, signal: AbortSignal) {
  const repository = view.repository
  if (
    repository.directory !== input.directory ||
    repository.head !== input.head ||
    repository.hasInfoRules !== false ||
    !repository.isOpen()
  )
    return
  const deadline = performance.now() + TIME_MS
  let remaining = MAX_BYTES
  let reads = 0
  const read = async (operation: ReadOnlyGit.Read) => {
    if (signal.aborted || ++reads > MAX_READS || performance.now() >= deadline) throw new Error("proof exhausted")
    const result = await repository.read(operation)
    remaining -= result.bytes.length
    if (remaining < 0 || performance.now() >= deadline) throw new Error("proof exhausted")
    return result
  }
  const paths = [...new Set(input.files.flatMap((file) => (file.oldPath ? [file.oldPath, file.path] : [file.path])))]
  if (paths.some((file) => blocked(file, input))) return
  // --no-renames --name-only -z covers even an omitted mode-only or binary change. Check every name BEFORE
  // asking for any patch text; a filtered caller cannot make the classifier ignore (or read) a hidden file.
  const names = await read({ kind: "diff", names: true, from: input.base, to: input.head })
  if (names.code !== 0 || !names.bytes.length || names.bytes.at(-1) !== 0) return
  const changed = utf8.decode(names.bytes).slice(0, -1).split("\0").toSorted()
  if (JSON.stringify(changed) !== JSON.stringify(paths.toSorted())) return
  // AGENTS.md or a configured instruction glob may name a link to a changed source file. The private port proves
  // that links on both sides are unchanged, resolve to unchanged regular files, and alias none of these paths.
  // An unrelated asset link is fine. The port never follows a link into the working tree.
  const aliases = await read({ kind: "unaliased-changes", from: input.base, to: input.head, files: paths })
  if (aliases.code !== 0 || aliases.bytes.length) return
  const show = async (revision: string, file: string, maxBytes: number) => {
    const object = await read({ kind: "show", revision, file, maxBytes: Math.min(maxBytes, remaining) })
    if (object.code !== 0 || object.bytes.includes(0)) throw new Error("unproven file contents")
    return utf8.decode(object.bytes)
  }
  const modes = new Map<string, string>()
  const mode = async (revision: string, file: string) => {
    const key = revision + ":" + file
    const cached = modes.get(key)
    if (cached !== undefined) return cached
    const item = await read({ kind: "tree", revision, file })
    if (item.code !== 0) throw new Error("unproven tree entry")
    if (!item.bytes.length) {
      modes.set(key, "")
      return ""
    }
    const record = utf8.decode(item.bytes)
    const entry = /^([0-7]{6}) (?:blob|tree|commit) [a-f0-9]{40}\t/.exec(record)
    if (!entry || record.slice(entry[0].length) !== file + "\0") throw new Error("unproven tree entry")
    modes.set(key, entry[1])
    return entry[1]
  }
  // Apply checked-in policy from both immutable trees, including nested policy files; no working-tree ignore read.
  // A symlink or a rule in an unsupported attribute grammar is a reason to leave the change to the reviewer.
  const policies = new Map<string, (relative: string) => boolean>()
  for (const file of paths) {
    const parts = file.split("/")
    for (let index = 0; index < parts.length; index++) {
      const dir = parts.slice(0, index).join("/")
      for (const name of [".gitignore", ".gitattributes"]) {
        const policy = dir ? dir + "/" + name : name
        for (const revision of [input.base, input.head]) {
          const key = revision + ":" + policy
          if (!policies.has(key)) {
            if (input.denied?.(policy)) return
            const entry = await mode(revision, policy)
            if (entry && entry !== "100644") return
            const text = entry ? await show(revision, policy, 32 * 1024) : ""
            if (name === ".gitignore") {
              const rules = ignore().add(text)
              policies.set(key, (relative) => rules.ignores(relative))
            } else {
              // Quoted/escaped names, attribute macros and unusual pattern syntax exceed the review parser's grammar.
              if (
                text
                  .split("\n")
                  .filter((line) => line.trim() && !line.trim().startsWith("#"))
                  .some((line) => !/^\s*\/?[\w.*?/-]+(?:[ \t]+[\w.=-]+)+\s*$/.test(line))
              )
                return
              const rules = parseGitAttributes(text)
              policies.set(key, (relative) => rules.generated(relative) || rules.vendored(relative))
            }
          }
          if (policies.get(key)!(parts.slice(index).join("/"))) return
        }
      }
    }
  }
  const full = await read({ kind: "diff", from: input.base, to: input.head, context: 3 })
  if (full.code !== 0) return
  const files = parseUnifiedDiff(utf8.decode(full.bytes))
  if (JSON.stringify(files) !== JSON.stringify(input.files)) return
  const blobs: Record<Side, Map<string, Blob>> = { LEFT: new Map(), RIGHT: new Map() }
  for (const file of files) {
    if (file.binary) return
    for (const side of ["LEFT", "RIGHT"] as const) {
      const name = side === "LEFT" ? (file.oldPath ?? file.path) : file.path
      const revision = side === "LEFT" ? input.base : input.head
      const exists = file.status !== (side === "LEFT" ? "added" : "deleted")
      const entry = await mode(revision, name)
      if (!exists) {
        if (entry !== "") return
        continue
      }
      if (entry !== "100644") return
      const text = await show(revision, name, 256 * 1024)
      if (hasGeneratedHeader(text)) return
      const parsed =
        ReviewParse.languageOf(name) && file.status === "modified"
          ? await Effect.runPromise(ReviewParse.parse({ path: name, text, deadline }), { signal })
          : undefined
      if (parsed && (!parsed.parsed || parsed.hasError)) return
      blobs[side].set(name, { text, ...(parsed?.parsed ? { parsed } : {}) })
    }
    const before = blobs.LEFT.get(file.oldPath ?? file.path)?.text ?? ""
    const after = blobs.RIGHT.get(file.path)?.text ?? ""
    if (file.status === "renamed" && !file.hunks.length ? before !== after : applyPatch(before, file) !== after) return
  }
  // Collect all negative reference facts the classifier would need. A provisional positive decision is usable only
  // after the immutable head has independently proved every one. Doc mentions can conservatively veto another doc.
  const searches = new Set<string>()
  const needsAbsence = (file: string) => {
    searches.add(file)
    return false
  }
  const decision = classifyTrivial(files, {
    sensitive: (file) => blocked(file, input),
    strings: (file, side) => blobs[side].get(file)?.parsed?.strings,
    comments: (file, side) => blobs[side].get(file)?.parsed?.comments,
    docText: (file, side) => blobs[side].get(file)?.text,
    referencesOldPath: needsAbsence,
    referencedByCode: needsAbsence,
  })
  if (!decision.trivial) return
  for (const file of searches) {
    const result = await read({ kind: "path-references", revision: input.head, file })
    if (result.code !== 1 || result.bytes.length) return
  }
  return !signal.aborted && performance.now() < deadline ? Object.freeze(decision.kinds) : undefined
}

export const prove = Effect.fn("ReviewTrivial.prove")(function* (input: Input) {
  if (
    input.config.trivial !== "skip" ||
    !oid.test(input.base) ||
    !oid.test(input.head) ||
    input.base === input.head ||
    !input.files.length ||
    input.files.length > MAX_FILES ||
    input.instructions.length > 64 ||
    input.files.reduce((sum, file) => sum + file.patch.length, 0) > MAX_BYTES
  )
    return
  const before = digest(input)
  const current = yield* ReviewGit.Current
  const capture = Effect.gen(function* () {
    const view = yield* ReviewGit.Current
    if (!view || !view.metadata.commonIdentity) return
    const result = yield* Effect.tryPromise({
      try: (signal) => collect(view, input, signal),
      catch: () => new Error("unproven change"),
    })
    if (!result || before !== digest(input)) return
    yield* view.preflight()
    const proof: Proof = Object.freeze({ [brand]: true as const })
    issued.set(proof, { digest: before, metadata: view.metadata, view: current, kinds: result })
    return proof
  })
  if (current) return yield* capture.pipe(Effect.orElseSucceed(() => undefined))
  return yield* ReviewGit.metadata(input.directory).pipe(
    Effect.flatMap((metadata) => ReviewGit.within(metadata, input.head, capture)),
    Effect.orElseSucceed(() => undefined),
  )
})

// The proof itself is never serialized. A shared view must still be the same open view. For a dedicated CLI snapshot
// whose private files have been retired, re-check its physical binding and HEAD before the runner honors it.
export const kinds = Effect.fn("ReviewTrivial.kinds")(function* (proof: Proof, target: Target) {
  const binding = issued.get(proof)
  if (!binding || target.config.trivial !== "skip" || digest(target) !== binding.digest) return
  const current = yield* ReviewGit.Current
  if (current !== binding.view) return
  if (current) {
    if (!current.repository.isOpen()) return
    return yield* current.preflight().pipe(
      Effect.map(() => (current.repository.isOpen() && digest(target) === binding.digest ? binding.kinds : undefined)),
      Effect.orElseSucceed(() => undefined),
    )
  }
  return yield* ReviewGit.metadata(target.directory).pipe(
    Effect.map((metadata) =>
      metadata.head === target.head &&
      ReviewGit.sameBinding(metadata, binding.metadata) &&
      digest(target) === binding.digest
        ? binding.kinds
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  )
})
