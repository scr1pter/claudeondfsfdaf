import type { Connect } from "@vectordevai/schema/connect"
import { actionableFindings, findingsPrompt, taskReviewFixGuidance } from "./connect-model"

export async function actOnFindings(
  input: { run: string; sessionID: string; action: "fix" | "worktree" | "dismiss"; findings?: readonly string[] },
  ports: {
    load: (run: string, sessionID: string) => Promise<Connect.Run>
    send: (text: string) => boolean
    dismiss: (run: string, input: Connect.DismissInput) => Promise<Connect.Run>
  },
) {
  const run = await ports.load(input.run, input.sessionID)
  if (run.id !== input.run) throw new Error("The engine returned a different review.")
  const sessionID = run.request.requester.sessionID
  const available = actionableFindings(run, input.sessionID, true)
  const selected = input.findings ?? available.map((finding) => finding.id)
  if (!sessionID || !selected.length || selected.some((id) => !available.some((finding) => finding.id === id)))
    throw new Error("These findings are no longer available in this conversation.")
  const guidance = input.action !== "dismiss" ? taskReviewFixGuidance(run) : undefined
  if (guidance) throw new Error(guidance)
  // Also validates duplicate/control identifiers before either owner action.
  const text = findingsPrompt({
    run: run.id,
    findings: selected,
    action: input.action === "dismiss" ? "dismiss" : "fix",
    mode: input.action === "worktree" ? "worktree" : "here",
  })
  if (input.action === "dismiss") return ports.dismiss(run.id, { sessionID, findings: [...selected] })
  if (!ports.send(text)) throw new Error("Keep or send your current draft, then try the review action again.")
  return run
}
