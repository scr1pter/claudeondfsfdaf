import { sanitizeReply, secretLike, WITHHELD } from "@vectordevai/schema/everywhere-policy"
import type { EverywhereJob } from "@vectordevai/schema/everywhere"

export type PostingCheck = (parts: readonly string[], sessions: readonly string[]) => Promise<{
  readonly status: "clean" | "changed" | "ask"
  readonly parts: readonly string[]
}>

/** Binary changes cannot be inspected by this textual secret/privacy boundary and remain local. */
export function addedLines(diff: string): string | undefined {
  if (/^(?:GIT binary patch|Binary files )/m.test(diff)) return undefined
  return diff.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n")
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
