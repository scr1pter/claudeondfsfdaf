// Scope and excerpts come from regular blobs in the exact base commit, through the
// same private snapshot as review evidence. Working-tree files never resolve a card.
import path from "node:path"
import { isUtf8 } from "node:buffer"
import { Effect } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ruleGlobMatches } from "@vectordevai/core/review/config"
import { heldReason, holdbackText } from "@vectordevai/core/review/holdback"
import { echoedPaths } from "./git"
import { ReviewSnapshot } from "./private-snapshot"

export const MANIFEST = ".vector/files.json"
const limit = { list: 64, sources: 12, globs: 12, bytes: 32 * 1024 }
export interface CardDocument {
  path: string
  description: string
  text: string
}
export interface CardArtifact {
  base: string
  paths: readonly string[]
  documents: readonly CardDocument[]
}
// Only committed repository text is cached. Every request first authenticates its own private
// snapshot and reapplies its read policy and changed-file scope before consulting these entries.
interface BaseSources {
  manifest: unknown
  documents: Map<string, string>
}
const bases = new Map<string, BaseSources>()
const remember = (key: string, base: BaseSources) => {
  bases.delete(key)
  bases.set(key, base)
  if (bases.size > 8) bases.delete(bases.keys().next().value!)
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const safe = (file: string) => ReadOnlyGit.repositoryPath(file) && !heldReason(file) && holdbackText(file) === file

export function scopedSources(value: unknown, paths: string[], denied: (file: string) => boolean) {
  if (!record(value) || !Array.isArray(value.files) || value.files.length > limit.list) return []
  const sources = new Map<string, { path: string; description: string }>()
  for (const row of value.files) {
    if (
      !record(row) ||
      typeof row.path !== "string" ||
      typeof row.description !== "string" ||
      !safe(row.path) ||
      denied(row.path) ||
      row.description.length > 256 ||
      holdbackText(row.description) !== row.description ||
      !row.description.trim()
    )
      continue
    const scope = typeof row.scope === "string" ? [row.scope] : row.scope
    if (
      !Array.isArray(scope) ||
      scope.length === 0 ||
      scope.length > limit.globs ||
      !scope.every(
        (pattern) =>
          typeof pattern === "string" &&
          pattern.length > 0 &&
          pattern.length <= 160 &&
          !/[!{}()\\\x00-\x1f]/.test(pattern.replace(/\{[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+){1,7}\}/, "")),
      ) ||
      !scope.some((pattern) => paths.some((file) => ruleGlobMatches(file, pattern)))
    )
      continue
    if (!sources.has(row.path)) sources.set(row.path, { path: row.path, description: row.description.trim() })
    if (sources.size >= limit.sources) break
  }
  return [...sources.values()]
}

export function readCardArtifact(
  input: {
    directory: string
    head: string
    base: string
    files: string[]
    denied: (file: string) => boolean
    signal?: AbortSignal
  },
  deadline: number,
): Effect.Effect<CardArtifact | undefined> {
  const files = input.files.filter((file) => safe(file) && !input.denied(file)).slice(0, 40)
  if (!files.length || input.denied(MANIFEST)) return Effect.succeed(undefined)
  return ReviewSnapshot.within<CardArtifact | undefined>(
    input,
    deadline,
    (view, signal) =>
      Effect.promise(async () => {
        if (view.repository.hasInfoRules !== false) return
        const common = await view.repository.read({ kind: "merge-base", left: input.base, right: input.head }, signal)
        if (common.code !== 0 || common.bytes.toString("ascii").trimEnd() !== input.base) return
        const blob = async (file: string) => {
          if (signal.aborted || performance.now() >= deadline) return
          const result = await view.repository.read(
            { kind: "show", revision: input.base, file, maxBytes: limit.bytes },
            signal,
          )
          if (result.code !== 0 || !isUtf8(result.bytes) || result.bytes.includes(0)) return
          const text = result.bytes.toString("utf8")
          return holdbackText(text) === text ? text : undefined
        }
        const admitted = async (candidates: string[]) => {
          if (!candidates.length) return []
          const check = await view.repository.read({ kind: "check-ignore", files: candidates }, signal)
          if (check.code === 1 && !check.bytes.length) return candidates
          if (check.code !== 0 || !isUtf8(check.bytes)) return []
          const listed = echoedPaths(check.bytes.toString("utf8"))
          const paths = new Set(candidates.map((file) => "./" + file))
          if (!listed.length || listed.some((file) => !paths.has(file))) return []
          const ignored = new Set(listed)
          return candidates.filter((file) => !ignored.has("./" + file))
        }
        const admittedNames = await admitted([...new Set([...files, MANIFEST])])
        if (!admittedNames.includes(MANIFEST)) return
        const names = files.filter((file) => admittedNames.includes(file))
        if (!names.length) return
        const key = JSON.stringify([path.resolve(input.directory), input.base])
        let sources = bases.get(key)
        if (!sources) {
          const manifest = await blob(MANIFEST)
          if (!manifest) return { base: input.base, paths: names, documents: [] }
          try {
            const parsed: unknown = JSON.parse(manifest)
            if (!record(parsed) || !Array.isArray(parsed.files) || parsed.files.length > limit.list) return
            sources = { manifest: parsed, documents: new Map() }
          } catch {
            return
          }
        }
        remember(key, sources)
        const documents: CardDocument[] = []
        const matching = scopedSources(sources.manifest, names, input.denied)
        const eligible = new Set(await admitted(matching.map((doc) => doc.path)))
        for (const item of matching) {
          if (!eligible.has(item.path)) continue
          const cached = sources.documents.get(item.path)
          const text = cached ?? (await blob(item.path))
          if (!text?.trim()) continue
          if (cached === undefined && sources.documents.size < limit.list) sources.documents.set(item.path, text)
          documents.push({ ...item, text })
        }
        return { base: input.base, paths: names, documents }
      }),
    () => undefined,
  )
}
