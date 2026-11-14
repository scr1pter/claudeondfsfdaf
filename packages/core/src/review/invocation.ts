// The shared, read-only invocation passed by trusted local adapters. Policy comes
// from the pinned settings commit, never from PR text or a model's response.

export interface ReviewInvocation {
  version: 1
  mode: "review"
  directory: string
  target: { kind: "working-tree" | "staged" | "branch"; head: string; base?: string }
  settingsRef: string
  parentID?: string
  readDenies?: readonly string[]
  readRoot?: string // trusted placement the requester read-denial paths came from
  model?: string
  maxCost?: number
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KEYS = new Set([
  "version",
  "mode",
  "directory",
  "target",
  "settingsRef",
  "parentID",
  "readDenies",
  "readRoot",
  "model",
  "maxCost",
])

/** Validate again at the engine boundary, including callers decoded from JSON. */
export function invocationProblems(input: ReviewInvocation): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["invocation"]
  const problems = Object.keys(input)
    .filter((key) => !KEYS.has(key))
    .map((key) => `field:${key}`)
  if (input.version !== 1) problems.push("version")
  if (input.mode !== "review") problems.push("mode")
  if (typeof input.directory !== "string" || !input.directory || input.directory.includes("\0"))
    problems.push("directory")
  const target = input.target
  if (!target || typeof target !== "object" || Array.isArray(target)) problems.push("target")
  else {
    if (!["working-tree", "staged", "branch"].includes(target.kind)) problems.push("target.kind")
    if (typeof target.head !== "string" || !COMMIT.test(target.head)) problems.push("target.head")
    if (target.base !== undefined && (typeof target.base !== "string" || !COMMIT.test(target.base)))
      problems.push("target.base")
    if (target.kind === "branch" && target.base === undefined) problems.push("target.base")
    Object.keys(target)
      .filter((key) => !["kind", "head", "base"].includes(key))
      .forEach((key) => problems.push(`target.field:${key}`))
  }
  if (typeof input.settingsRef !== "string" || !COMMIT.test(input.settingsRef)) problems.push("settingsRef")
  if (
    input.parentID !== undefined &&
    (typeof input.parentID !== "string" || !input.parentID || input.parentID.includes("\0"))
  )
    problems.push("parentID")
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !input.model.trim() || input.model.includes("\0"))
  )
    problems.push("model")
  if (input.maxCost !== undefined && (!Number.isFinite(input.maxCost) || input.maxCost <= 0)) problems.push("maxCost")
  if (
    input.readRoot !== undefined &&
    (typeof input.readRoot !== "string" ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(input.readRoot) ||
      input.readRoot.includes("\0"))
  )
    problems.push("readRoot")
  if (
    input.readDenies !== undefined &&
    (!Array.isArray(input.readDenies) ||
      input.readDenies.length > 1_000 ||
      input.readDenies.some(
        (pattern) => typeof pattern !== "string" || !pattern || pattern.length > 4_096 || pattern.includes("\0"),
      ))
  )
    problems.push("readDenies")
  return problems
}
