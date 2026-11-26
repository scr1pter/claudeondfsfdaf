// Verification reads only the regular committed files selected by strictBlobRequests. A missing path is evidence
// only when the exact commit and its parent directories were inspected. Every other unreadable value stays unknown.
import { isUtf8 } from "node:buffer"
import { Effect } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import type { StrictBlob, StrictBlobs } from "@vectordevai/core/review/guardrail"
import { heldReason, holdbackText } from "@vectordevai/core/review/holdback"
import { ReviewSnapshot } from "./private-snapshot"

export * as ReviewStrictBlobs from "./strict-blobs"

interface Input {
  directory: string
  base: string
  head: string
  requests: { head: readonly string[]; base: readonly string[] }
  denied?: (path: string) => boolean
  holdback?: "secrets"
  signal?: AbortSignal
  budgetMs?: number
}

const MAX_PATHS = 128
const MAX_READS = 512
const MAX_FILE = 1024 * 1024
const MAX_TOTAL = 4 * MAX_FILE
const MAX_TIME = 5_000
const sides = ["head", "base"] as const

const unknown = (): StrictBlobs => ({ head: new Map(), base: new Map() })

async function collect(input: Input, repo: ReadOnlyGit.Repository, signal: AbortSignal): Promise<StrictBlobs> {
  if (repo.hasInfoRules !== false) return unknown()
  const output = { head: new Map<string, StrictBlob>(), base: new Map<string, StrictBlob>() }
  let reads = 0
  let remaining = MAX_TOTAL
  const read = (operation: ReadOnlyGit.Read) => {
    if (signal.aborted || ++reads > MAX_READS) return
    return repo.read(operation, signal)
  }
  for (const commit of new Set([input.base, input.head])) {
    const result = await read({ kind: "resolve", revision: commit })
    // A tag that peels to a commit or a tree object is not the requested commit.
    if (result?.code !== 0 || !result.bytes.equals(Buffer.from(commit + "\n"))) return unknown()
  }
  const blocked = (file: string) =>
    input.denied?.(file) === true ||
    (input.holdback === "secrets" && (heldReason(file) !== undefined || holdbackText(file) !== file))
  const entries = new Map<string, "absent" | "directory" | "other">()
  const entry = async (revision: string, file: string) => {
    const key = revision + "\0" + file
    const known = entries.get(key)
    if (known) return known
    const result = await read({ kind: "tree", revision, file })
    if (result?.code !== 0) return "other"
    const directory = /^040000 tree [a-f0-9]{40}\t([^\0]+)\0$/.exec(result.bytes.toString("utf8"))
    const value = !result.bytes.length ? "absent" : directory?.[1] === file ? "directory" : "other"
    entries.set(key, value)
    return value
  }
  const absent = async (revision: string, file: string) => {
    // ls-tree of link/child also returns an empty listing. No tree contents are known beyond a link or gitlink.
    if ((await entry(revision, file)) !== "absent") return false
    let prefix = ""
    for (const component of file.split("/").slice(0, -1)) {
      prefix = prefix ? prefix + "/" + component : component
      if (blocked(prefix)) return false
      const mode = await entry(revision, prefix)
      if (mode === "absent") return true
      if (mode !== "directory") return false
    }
    return true
  }
  const load = async (revision: string, file: string): Promise<StrictBlob> => {
    if (!file.isWellFormed() || !ReadOnlyGit.repositoryPath(file) || remaining <= 0) return null
    const components = file.split("/")
    if (components.length > 64 || components.some((_, i) => blocked(components.slice(0, i + 1).join("/")))) return null
    const blob = await read({
      kind: "show",
      revision,
      file,
      maxBytes: Math.min(MAX_FILE, remaining),
      distinguishLarge: true,
    })
    if (blob?.code === 1 && !blob.bytes.length && (await absent(revision, file))) return { absent: true }
    if (blob?.code !== 0 || blob.bytes.byteLength > Math.min(MAX_FILE, remaining)) return null
    remaining -= blob.bytes.byteLength
    if (!isUtf8(blob.bytes) || blob.bytes.includes(0)) return null
    const text = blob.bytes.toString("utf8")
    // A replacement such as [redacted] is not evidence at that line. Keep the entire file unreadable if it
    // would disclose a shape, including a key whose header/body lie on different lines.
    return input.holdback === "secrets" && holdbackText(text) !== text ? null : text
  }
  const seen = new Map<string, StrictBlob>()
  for (const side of sides) {
    for (const file of new Set(input.requests[side])) {
      if (signal.aborted) return unknown()
      const key = input[side] + "\0" + file
      const value = seen.has(key) ? seen.get(key)! : await load(input[side], file)
      seen.set(key, value)
      output[side].set(file, value)
    }
  }
  return output
}

export const read = Effect.fn("ReviewStrictBlobs.read")(function* (input: Input) {
  const count = input.requests.head.length + input.requests.base.length
  if (count === 0 || count > MAX_PATHS) return unknown()
  const deadline = performance.now() + Math.min(MAX_TIME, input.budgetMs ?? MAX_TIME)
  return yield* ReviewSnapshot.within(
    input,
    deadline,
    // The snapshot manager aborts this signal on timeout or interruption before joining the reader.
    (view, signal) => Effect.promise(() => collect(input, view.repository, signal)).pipe(Effect.uninterruptible),
    unknown,
  )
})
