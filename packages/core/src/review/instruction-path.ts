// Candidate VS-48a directories. Measurement must decide the retained list before any collector calls this helper.
export const INSTRUCTION_PATH_SEGMENTS = Object.freeze([
  "test",
  "tests",
  "__tests__",
  "testdata",
  "fixture",
  "fixtures",
  "__fixtures__",
  "golden",
  "goldens",
  "corpus",
  "corpora",
  "snapshot",
  "snapshots",
  "__snapshots__",
  "example",
  "examples",
  "sample",
  "samples",
  "demo",
  "demos",
  "generated",
  "__generated__",
  "vendor",
  "vendors",
  "node_modules",
  "third_party",
  "third-party",
  "thirdparty",
  "site-packages",
  "deps",
  "contrib",
] as const)
export type InstructionPathSegment = (typeof INSTRUCTION_PATH_SEGMENTS)[number]
export type InstructionPathOrigin = "project" | "vendored" | "unknown"
export const MAX_INSTRUCTION_COUNT_FILES = 100_000
export const MAX_INSTRUCTION_COUNT_BYTES = 8 * 1024 * 1024
export const MAX_INSTRUCTION_PATH_BYTES = 4_096

const segmentSet = new Set<string>(INSTRUCTION_PATH_SEGMENTS)
const exampleSet = new Set<string>(["example", "examples", "sample", "samples", "demo", "demos"])
const generatedSet = new Set<string>(["generated", "__generated__"])
const vendoredSet = new Set<string>([
  "vendor",
  "vendors",
  "node_modules",
  "third_party",
  "third-party",
  "thirdparty",
  "site-packages",
  "deps",
  "contrib",
])
const directories = (path: string) => path.replaceAll("\\", "/").split("/").slice(0, -1)

/** Directory segments only; a filename named `vendor` is not an excluded directory. This grants no read authority. */
export function instructionPathExcluded(path: string): boolean {
  return directories(path).some((segment) => segmentSet.has(segment.toLowerCase()))
}

export function instructionPathCategory(
  segment: InstructionPathSegment,
): "test" | "example" | "generated" | "vendored" {
  return exampleSet.has(segment)
    ? "example"
    : generatedSet.has(segment)
      ? "generated"
      : vendoredSet.has(segment)
        ? "vendored"
        : "test"
}

/** The count accepts repository-relative inventory paths, not URLs, traversal or a filesystem root. */
export function instructionInventoryPath(path: string): string | undefined {
  if (
    !path ||
    !path.isWellFormed() ||
    new TextEncoder().encode(path).length > MAX_INSTRUCTION_PATH_BYTES ||
    /[\u0000-\u001f\u007f:]/.test(path)
  )
    return
  const normalized = path.replaceAll("\\", "/")
  const segments = normalized.split("/")
  if (segments.length > 128 || segments.some((segment) => !segment || segment === "." || segment === "..")) return
  return normalized
}

export interface InstructionPathInventoryEntry {
  readonly path: string
  /** Explicit manifest attribution. A directory name alone never proves that a project's test files are vendored. */
  readonly origin?: InstructionPathOrigin
}
export interface InstructionSegmentCount {
  readonly segment: InstructionPathSegment
  readonly category: ReturnType<typeof instructionPathCategory>
  readonly files: number
  readonly project: number
  readonly vendored: number
  readonly unknown: number
}
export interface InstructionPathCount {
  readonly complete: true
  readonly scannedFiles: number
  readonly nestedFiles: number
  readonly excludedFiles: number
  readonly segments: readonly InstructionSegmentCount[]
}
export type InstructionPathCountResult =
  | InstructionPathCount
  | {
      readonly complete: false
      readonly reason:
        | "file-limit"
        | "byte-limit"
        | "invalid-path"
        | "duplicate-path"
        | "invalid-origin"
        | "invalid-limit"
    }

/** Path metadata only: never opens an instruction, follows an import, or decides which exclusions will be activated. */
export function countInstructionPaths(
  input: readonly InstructionPathInventoryEntry[],
  limits?: { readonly files?: number; readonly bytes?: number },
): InstructionPathCountResult {
  const maxFiles = limits?.files ?? MAX_INSTRUCTION_COUNT_FILES
  const maxBytes = limits?.bytes ?? MAX_INSTRUCTION_COUNT_BYTES
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > MAX_INSTRUCTION_COUNT_FILES ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_INSTRUCTION_COUNT_BYTES
  )
    return { complete: false, reason: "invalid-limit" }
  if (input.length > maxFiles) return { complete: false, reason: "file-limit" }
  const seen = new Set<string>()
  const counts = new Map<InstructionPathSegment, { files: number; project: number; vendored: number; unknown: number }>(
    INSTRUCTION_PATH_SEGMENTS.map((segment) => [segment, { files: 0, project: 0, vendored: 0, unknown: 0 }]),
  )
  let bytes = 0
  let nestedFiles = 0
  let excludedFiles = 0
  for (const entry of input) {
    const path = instructionInventoryPath(entry.path)
    if (!path) return { complete: false, reason: "invalid-path" }
    bytes += new TextEncoder().encode(path).length
    if (bytes > maxBytes) return { complete: false, reason: "byte-limit" }
    if (seen.has(path)) return { complete: false, reason: "duplicate-path" }
    seen.add(path)
    const origin = entry.origin ?? "unknown"
    if (origin !== "project" && origin !== "vendored" && origin !== "unknown")
      return { complete: false, reason: "invalid-origin" }
    const parts = path.split("/")
    const name = parts.at(-1)!
    if (parts.length === 1 || (name !== "AGENTS.md" && name !== "CLAUDE.md" && !name.endsWith(".instructions.md")))
      continue
    nestedFiles++
    const matched = new Set(parts.slice(0, -1).map((segment) => segment.toLowerCase()))
    if (instructionPathExcluded(path)) excludedFiles++
    for (const [segment, count] of counts) {
      if (!matched.has(segment)) continue
      count.files++
      count[origin]++
    }
  }
  return {
    complete: true,
    scannedFiles: input.length,
    nestedFiles,
    excludedFiles,
    segments: [...counts].map(([segment, count]) => ({
      segment,
      category: instructionPathCategory(segment),
      ...count,
    })),
  }
}
