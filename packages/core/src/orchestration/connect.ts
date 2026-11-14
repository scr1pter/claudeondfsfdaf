export * as WorkflowConnect from "./connect"

import type { Connect } from "@vectordevai/schema/connect"
import { ConnectPolicy } from "../connect/policy"

/** Review findings stay data. Actual changed paths, never a finding's text, bound downstream ownership. */
export function output(run: Connect.Run, changed: readonly string[]) {
  if (run.request.action !== "review" || run.status !== "done" || !run.result)
    throw new Error("A connected workflow output requires a settled review.")
  const result = run.result
  return {
    runID: run.id,
    state: result.state,
    verdict: result.verdict,
    summary: result.summary,
    findings:
      result.state === "completed" || result.state === "partial"
        ? result.findings
            .filter((finding) => finding.status !== "fixed" && finding.status !== "dismissed")
            .map((finding) => ({
              ...finding,
              runID: run.id,
              owned_paths: ConnectPolicy.ownedPaths({ findings: [finding], changed }),
            }))
        : [],
  }
}
