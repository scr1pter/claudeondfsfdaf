export * as WorkflowReport from "./report"

import { WorkflowTemplate } from "./template"
import type { WorkflowProgress } from "./progress"

export type Input = {
  readonly title: string
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted"
  readonly resultsPath: string
  readonly progress: WorkflowProgress.Progress
  readonly durationMs: number
  readonly costUsd?: number
  readonly unpricedSteps: number
  readonly codiumSteps?: number
  readonly failures?: readonly { readonly stage: string; readonly message: string }[]
  readonly results?: unknown
}
const line = (text: string, max = 500) =>
  text
    .replace(/\p{Cc}/gu, " ")
    .replace(/[<>@\[\]]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .slice(0, max)

export function render(input: Input): string {
  const codium = Math.max(0, input.codiumSteps ?? 0)
  const unknown = input.unpricedSteps > codium || (input.costUsd === undefined && codium === 0)
  const cost = unknown
    ? "unknown"
    : codium > 0 && !input.costUsd
      ? "Codium"
      : `$${(input.costUsd ?? 0).toFixed(2)}${codium ? " + Codium" : ""}`
  const lines = [
    `Workflow ${line(input.title, 80)}: ${input.outcome} · ${input.progress.agents.launched} agents · ${Math.ceil(Math.max(0, input.durationMs) / 1000)}s · ${cost}`,
    `Full results: ${input.resultsPath}`,

    ...(input.progress.stop ? [`Stopped: ${line(input.progress.stop.message)}`] : []),
    ...(input.failures ?? [])
      .slice(0, 5)
      .map((failure) => `Failure in ${line(failure.stage, 80)}: ${line(failure.message)}`),
  ]
  if (input.results !== undefined) {
    const text = WorkflowTemplate.envelope(input.results, "results")
    if (new TextEncoder().encode(text).byteLength <= 4096) lines.push(text)
    else {
      // Envelope a short JSON-text preview anew so truncation never cuts a data marker or JSON escape in half.
      const preview = JSON.stringify(input.results).slice(0, 500)
      lines.push(
        WorkflowTemplate.envelope(preview, "results-preview"),
        "Results preview truncated; use the full results file.",
      )
    }
  }
  // Keep the real artifact location intact; it is engine-owned, not model-generated prose.
  // Reserve space for outcomes/failures and the complete results envelope before adding stage summaries.
  const summaries: string[] = []
  let bytes = new TextEncoder().encode(lines.join("\n")).byteLength
  if (bytes > 64 * 1024 - 128) throw new Error("Workflow report metadata exceeds 64 KiB.")
  for (const stage of input.progress.stages) {
    const summary = `${line(stage.title, 60)}: ${stage.done} done, ${stage.failed} failed, ${stage.skipped} skipped${stage.waiting ? `, ${stage.waiting} waiting` : ""}`
    if (bytes + new TextEncoder().encode(summary).byteLength + 1 > 64 * 1024 - 128) break
    summaries.push(summary)
    bytes += new TextEncoder().encode(summary).byteLength + 1
  }
  if (summaries.length < input.progress.stages.length)
    summaries.push(
      `${input.progress.stages.length - summaries.length} stage summaries omitted; use the full results file.`,
    )
  lines.splice(2, 0, ...summaries)
  return lines.join("\n")
}
