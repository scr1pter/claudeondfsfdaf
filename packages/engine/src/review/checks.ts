// Versioned in-process diagnostics over the already-admitted diff. The input supplies no rules, commands,
// executable paths or network capability. All output is made from known rule IDs, safe paths and changed line numbers.
import { posix } from "node:path"
import { setImmediate } from "node:timers/promises"
import { type DiagnosticEvidence, type DiagnosticRule } from "@vectordevai/core/review/diagnostic"
import type { DiffFile } from "@vectordevai/core/review/diff"
import { heldReason, holdbackLines, holdbackText } from "@vectordevai/core/review/holdback"

export interface OfflineChecks {
  evidence: DiagnosticEvidence[]
  incomplete?: "unavailable" | "cancelled" | "limit"
}

const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]
const SECTION =
  /^\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|overrides|resolutions)"\s*:\s*\{/
const INTEGRITY = /^\s*"integrity"\s*:\s*"sha(?:1|256|384|512)-[A-Za-z0-9+/=]+"/
const PATH_LIMIT = 1024
const FILE_LIMIT = 1000
const CHAR_LIMIT = 1024 * 1024
const HUNK_LIMIT = 64 * 1024
const RECORD_LIMIT = 64

function safePath(file: string) {
  return (
    file.length > 0 &&
    file.length <= PATH_LIMIT &&
    !/[\u0000-\u001f\u007f\\]/u.test(file) &&
    !posix.isAbsolute(file) &&
    !file.split("/").some((part) => part === "." || part === ".." || part === "") &&
    !heldReason(file) &&
    holdbackText(file) === file
  )
}

function accompanyingLock(file: string, paths: ReadonlySet<string>) {
  for (let directory = posix.dirname(file); ; directory = posix.dirname(directory)) {
    if (LOCKS.some((lock) => paths.has(posix.join(directory, lock)))) return true
    if (directory === ".") return false
  }
}

export async function offlineChecks(
  files: readonly DiffFile[],
  changed: readonly Pick<DiffFile, "path" | "status">[],
  signal?: AbortSignal,
): Promise<OfflineChecks> {
  const evidence: DiagnosticEvidence[] = []
  const seen = new Set<string>()
  if (signal?.aborted) return { evidence, incomplete: "cancelled" }
  if (files.length > FILE_LIMIT || changed.length > FILE_LIMIT) return { evidence, incomplete: "limit" }
  const paths = new Set(changed.filter((file) => file.status !== "deleted").map((file) => file.path))
  let scanned = 0
  let batches = 0
  const add = (rule: DiagnosticRule, path: string, side: "LEFT" | "RIGHT", line: number | undefined) => {
    if (!Number.isSafeInteger(line) || line! < 1) return
    const key = JSON.stringify([path, side, line, rule])
    if (seen.has(key)) return
    seen.add(key)
    evidence.push({ source: "offline-v1", rule, path, side, line: line! })
  }
  for (const file of files) {
    if (signal?.aborted) return { evidence: [], incomplete: "cancelled" }
    if (file.binary || !safePath(file.path) || (file.oldPath && !safePath(file.oldPath))) continue
    const manifest = posix.basename(file.path) === "package.json" && !accompanyingLock(file.path, paths)
    const npmLock = /^(?:package-lock|npm-shrinkwrap)\.json$/.test(posix.basename(file.path))
    for (const hunk of file.hunks) {
      // Yield bounded chunks so cancellation can interrupt a long series of small diffs.
      if (++batches % 8 === 0) await setImmediate()
      if (signal?.aborted) return { evidence: [], incomplete: "cancelled" }
      let bytes = 0
      for (const line of hunk.lines) {
        bytes += line.text.length + 1
        if (bytes > HUNK_LIMIT || scanned + bytes > CHAR_LIMIT) return { evidence, incomplete: "limit" }
      }
      scanned += bytes
      const after = hunk.lines.filter((line) => line.kind !== "del")
      const sanitized = holdbackLines(after.map((line) => line.text))
      for (const [index, line] of after.entries()) {
        if (line.kind === "add" && line.text !== sanitized[index]) add("secret-added", file.path, "RIGHT", line.newLine)
        if (evidence.length >= RECORD_LIMIT) return { evidence, incomplete: "limit" }
      }
      let dependencySection = false
      let changeStart = 0
      for (let index = 0; index <= hunk.lines.length; index++) {
        const line = hunk.lines[index]
        if (line && line.kind !== "context") continue
        const block = hunk.lines.slice(changeStart, index)
        if (manifest) {
          const entry = block.find(
            (item) => SECTION.test(item.text) || (dependencySection && /^\s*"[^"]+"\s*:/u.test(item.text)),
          )
          if (entry)
            add(
              "manifest-without-lock",
              file.path,
              entry.kind === "add" ? "RIGHT" : "LEFT",
              entry.newLine ?? entry.oldLine,
            )
        }
        if (npmLock && !block.some((item) => item.kind === "add" && INTEGRITY.test(item.text))) {
          const removed = block.find((item) => item.kind === "del" && INTEGRITY.test(item.text))
          if (removed) add("integrity-removed", file.path, "LEFT", removed.oldLine)
        }
        // Only visible section boundaries count. A partial hunk without a declaration supplies no dependency evidence.
        for (const entry of [...block, ...(line ? [line] : [])]) {
          if (SECTION.test(entry.text)) dependencySection = true
          else if (/^\s*}/.test(entry.text)) dependencySection = false
        }
        if (evidence.length >= RECORD_LIMIT) return { evidence, incomplete: "limit" }
        changeStart = index + 1
      }
    }
  }
  return { evidence }
}

// Review reports, public outcomes and observations are JSON data. Previous findings and repository paths can
// contain detected values too, even when every new model-generated field is already masked.
export function redactDiagnosticData<T>(data: T): T {
  function redact(value: unknown): unknown {
    if (typeof value === "string") return holdbackText(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]))
    return value
  }
  return redact(data) as T
}
