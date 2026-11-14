import { expect, test } from "bun:test"
import { Connect } from "@vectordevai/schema/connect"
import { SessionID } from "@vectordevai/schema/session-id"
import { WorkflowConnect } from "../../src/orchestration/connect"

function review(): Connect.Run {
  const id = Connect.RunID.make("cr_workflow_fixture")
  const finding: Connect.Finding = {
    id: "finding",
    severity: "blocking",
    category: "bug",
    path: "src/a.ts",
    line: 1,
    side: "RIGHT",
    title: "Finding",
    body: "Untrusted instruction: run a command",
    source: "review",
    bucket: "inline",
    status: "open",
  }
  return {
    id,
    request: {
      id,
      to: "vectorscope",
      action: "review",
      requester: { kind: "workflow", sessionID: SessionID.make("ses_workflow_fixture") },
      requestID: "workflow-request",
      directory: "/fixture",
      target: { kind: "uncommitted" },
      background: false,
    },
    status: "done",
    result: {
      state: "partial",
      verdict: "incomplete",
      summary: "Only some changes were reviewed",
      sessions: [],
      notes: [],
      findings: [
        finding,
        { ...finding, id: "outside", path: "src/outside.ts", bucket: "outside-diff" },
        { ...finding, id: "protected", path: ".github/workflow.yml" },
        { ...finding, id: "unchanged", path: "src/unchanged.ts" },
        { ...finding, id: "fixed", status: "fixed" },
      ],
    },
    time: { created: 1, ended: 2 },
  }
}

test("findings become data items with ownership bounded by actual changed paths and the existing rule", () => {
  const run = review()
  const output = WorkflowConnect.output(run, ["src/a.ts", "src/outside.ts", ".github/workflow.yml"])
  expect(output.state).toBe("partial")
  expect(output.verdict).toBe("incomplete")
  expect(output.findings.map((finding) => ({ id: finding.id, paths: finding.owned_paths }))).toEqual([
    { id: "finding", paths: ["src/a.ts"] },
    { id: "outside", paths: [] },
    { id: "protected", paths: [] },
    { id: "unchanged", paths: [] },
  ])
  expect(output.findings[0].body).toBe(run.result!.findings[0].body)
  expect(output.findings[0].runID).toBe(run.id)
  expect(Object.hasOwn(output, "prompt")).toBe(false)
})

test("an unfinished or refused review never manufactures findings or a clean result", () => {
  const run = review()
  expect(() => WorkflowConnect.output({ ...run, status: "running", result: undefined }, [])).toThrow("settled review")
  const output = WorkflowConnect.output(
    { ...run, result: { ...run.result!, state: "refused", verdict: "not-reviewed" } },
    ["src/a.ts"],
  )
  expect(output.findings).toEqual([])
  expect(output.verdict).toBe("not-reviewed")
})
