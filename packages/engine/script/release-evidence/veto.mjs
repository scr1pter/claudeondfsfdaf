import { appendFile, writeFile } from "node:fs/promises"
import { MAX_OUTPUT, MODEL } from "./support.mjs"

export default async function evidenceVeto() {
  const directory = process.env.VECTOR_EVIDENCE_DIRECTORY
  if (!directory) throw new Error("OFFLINE_EVIDENCE_DIRECTORY_MISSING")
  await writeFile(`${directory}/veto-loaded.json`, JSON.stringify({ loaded: true }) + "\n", { mode: 0o600 })
  return {
    async "chat.params"(input, output) {
      if (input.model?.providerID !== "openai" || input.model.id !== MODEL)
        throw new Error("OFFLINE_EVIDENCE_MODEL_MISMATCH")
      // 1.99.112's built-in OpenAI hook clears the environment-derived cap. Config plugins run afterward;
      // set the study's explicit cap through this supported hook, then verify the actual wire value at capture.
      output.maxOutputTokens = MAX_OUTPUT
    },
    async "tool.execute.before"(input) {
      await appendFile(
        `${directory}/vetoed-tools.jsonl`,
        JSON.stringify({
          at: new Date().toISOString(),
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
        }) + "\n",
        { mode: 0o600 },
      )
      throw new Error("OFFLINE_TOOL_VETO")
    },
  }
}
