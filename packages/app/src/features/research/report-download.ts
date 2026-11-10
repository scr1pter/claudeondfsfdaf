import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { reportPath } from "./research-model"

export type ReportFormat = "markdown" | "json" | "docx" | "pdf"

export async function downloadResearch(
  client: VectorClient,
  input: { runID: string; question: string; created: number; format: ReportFormat },
) {
  // Explicit blob parsing prevents a binary attachment being decoded as UTF-8 by the SDK.
  const result = await client.memory.research.export(
    { runID: input.runID, format: input.format },
    { parseAs: "blob", throwOnError: false },
  )
  if (result.error) {
    const error: unknown = result.error
    const data = typeof error === "object" && error !== null && "data" in error ? error.data : undefined
    throw new Error(
      typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
        ? data.message
        : "Vector could not export this research. Try Markdown or Word for text the PDF font cannot display.",
    )
  }
  const body: unknown = result.data
  if (!(body instanceof Blob)) throw new Error("Vector did not return an export file.")
  const name = reportPath(input.question, input.created)
    .split("/")
    .at(-1)!
    .replace(/\.md$/, `.${input.format === "markdown" ? "md" : input.format}`)
  const url = URL.createObjectURL(body)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  // Keep the URL alive through the click's default action, including slower browser download handlers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
