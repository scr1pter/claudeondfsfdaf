import type { Connect } from "@vectordevai/schema/connect"
import { actionableFindings, findingsPrompt, taskReviewFixGuidance } from "./connect-model"

export async function handoffFindings(
  input: Connect.RegisterInput & { selected: readonly string[]; mode: Connect.FixMode; owner: boolean },
  ports: {
    register: (input: Connect.RegisterInput) => Promise<Connect.Run>
    send: (input: { sessionID: Connect.RegisterInput["sessionID"]; text: string }) => Promise<void>
  },
) {
  if (!input.owner) throw new Error("Only the owner can hand off findings.")
  const available = new Set(input.findings.map((finding) => finding.id))
  if (!input.selected.length || input.selected.some((id) => !available.has(id)))
    throw new Error("Select findings from this review.")
  // Validate identifiers before saving anything; registration alone never starts a repair.
  findingsPrompt({ run: "cr_pending", findings: input.selected, action: "fix", mode: input.mode })
  const run = await ports.register({ sessionID: input.sessionID, target: input.target, findings: input.findings })
  const allowed = new Set(actionableFindings(run, input.sessionID, true).map((finding) => finding.id))
  if (input.selected.some((id) => !allowed.has(id))) throw new Error("The registered findings are no longer available.")
  const guidance = taskReviewFixGuidance(run)
  if (guidance) throw new Error(guidance)
  await ports.send({
    sessionID: input.sessionID,
    text: findingsPrompt({ run: run.id, findings: input.selected, action: "fix", mode: input.mode }),
  })
  return run
}
