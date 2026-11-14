import { writeFile } from "node:fs/promises"
import { Schema } from "effect"
import { WorkflowSpec } from "../src/orchestration/spec"

export function workflowSchema() {
  const document = Schema.toJsonSchemaDocument(WorkflowSpec.Spec)
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://vectordev.ai/workflow.json",
    ...document.schema,
    $defs: document.definitions,
  }
}

if (import.meta.main) {
  const destination = process.argv[2] ?? new URL("../../web/public/workflow.json", import.meta.url)
  await writeFile(destination, JSON.stringify(workflowSchema(), null, 2) + "\n")
}
