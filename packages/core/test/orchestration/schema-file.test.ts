import { readFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import { workflowSchema } from "../../script/workflow-schema"

test("the published workflow schema is the generated contract", async () => {
  const source = await readFile(new URL("../../../web/public/workflow.json", import.meta.url), "utf8")
  expect(JSON.parse(source)).toEqual(workflowSchema())
})
