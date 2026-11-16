import { sanitizeReply, secretLike, WITHHELD } from "@vectordevai/schema/everywhere-policy"
import type { EverywhereJob } from "@vectordevai/schema/everywhere"

export type PostingCheck = (parts: readonly string[], sessions: readonly string[]) => Promise<{
  readonly status: "clean" | "changed" | "ask"
  readonly parts: readonly string[]
}>

/** Binary changes cannot be inspected by this textual secret/privacy boundary and remain local. */
export function addedLines(diff: string): string | undefined {
  if (/^(?:GIT binary patch|Binary files )/m.test(diff)) return undefined
  const added: string[] = []
  let old = 0
  let next = 0
  let patch = diff === ""
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line)
    if (hunk) {
      if (old || next) return undefined
      old = Number(hunk[1] ?? 1)
      next = Number(hunk[2] ?? 1)
      if (!Number.isSafeInteger(old) || !Number.isSafeInteger(next)) return undefined
      patch = true
      continue
    }
    if (line === "\\ No newline at end of file") continue
    if (old || next) {
      if (line.startsWith("+") && next > 0) { added.push(line.slice(1)); next--; continue }
      if (line.startsWith("-") && old > 0) { old--; continue }
      if (line.startsWith(" ") && old > 0 && next > 0) { old--; next--; continue }
      return undefined
    }
    if (line === "") continue
    if (/^(?:diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |--- |\+\+\+ )/.test(line)) { patch = true; continue }
    return undefined
  }
  return patch && old === 0 && next === 0 ? added.join("\n") : undefined
}

export async function checkedSummary(job: EverywhereJob, text: string, sessions: readonly string[], check: PostingCheck) {
  if (secretLike(text)) return WITHHELD.secret
  const cleaned = sanitizeReply(text, { platform: job.platform, repository: job.repository.fullName, maxChars: job.reply.maxChars }).text
  try {
    const result = await check([cleaned], sessions)
    if (result.status === "ask" || !Array.isArray(result.parts)) return WITHHELD.posting
    return sanitizeReply(result.parts.join("\n"), { platform: job.platform, repository: job.repository.fullName, maxChars: job.reply.maxChars }).text
  } catch { return WITHHELD.posting }
}

export async function mayPushDiff(diff: string, sessions: readonly string[], check: PostingCheck) {
  const lines = addedLines(diff)
  if (lines === undefined || secretLike(lines)) return false
  try {
    const result = await check([lines], sessions)
    return result.status === "clean" && result.parts.length === 1 && result.parts[0] === lines
  } catch { return false }
}
