export * as ConnectContext from "./context"

import type { Connect } from "@vectordevai/schema/connect"

/** Save the dismissed claim as quoted data. A reviewer's body and suggested instructions are never copied. */
export function dismissalText(finding: Connect.Finding, reason?: string) {
  const title = finding.title.replace(/[\r\n\t]/g, " ").slice(0, 300)
  const why = reason?.trim().slice(0, 400)
  return `The owner dismissed this review claim for ${JSON.stringify(finding.path)}: ${JSON.stringify(title)}.${why ? ` Owner's reason: ${JSON.stringify(why)}.` : ""}`.slice(
    0,
    1_200,
  )
}

/** A click changes only known finding statuses; it never changes review provenance or claims a new clean review. */
export function dismissed(run: Connect.Run, ids: readonly string[]): Connect.Run | undefined {
  const result = run.result
  if (
    run.status !== "done" ||
    run.request.action !== "review" ||
    !result ||
    (result.state !== "completed" && result.state !== "partial") ||
    ids.length === 0
  )
    return undefined
  const selected = new Set(ids)
  if ([...selected].some((id) => !result.findings.some((finding) => finding.id === id))) return undefined
  return {
    ...run,
    result: {
      ...result,
      findings: result.findings.map((finding) =>
        selected.has(finding.id) ? { ...finding, status: "dismissed" } : finding,
      ),
    },
  }
}
