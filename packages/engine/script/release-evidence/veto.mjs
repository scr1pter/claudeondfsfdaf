import { appendFile, writeFile } from "node:fs/promises"

export default async function evidenceVeto() {
  const directory = process.env.VECTOR_EVIDENCE_DIRECTORY
  if (!directory) throw new Error("OFFLINE_EVIDENCE_DIRECTORY_MISSING")
  await writeFile(`${directory}/veto-loaded.json`, JSON.stringify({ loaded: true }) + "\n", { mode: 0o600 })
  return {
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
