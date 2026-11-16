import { Connect } from "@vectordevai/schema/connect"
import { SessionID } from "@vectordevai/schema/session-id"

export const sessionID = SessionID.make("ses_connect_fixture")
export const finding: Connect.Finding = {
  id: "finding-1",
  severity: "concern",
  category: "bug",
  path: "src/example.ts",
  line: 4,
  side: "RIGHT",
  title: "A finding title",
  body: "Untrusted finding text must stay in the saved run.",
  source: "review",
  bucket: "inline",
  status: "open",
}

export function reviewRun(): Connect.Run {
  const id = Connect.RunID.make("cr_fixture")
  return {
    id,
    request: {
      id,
      to: "vectorscope",
      action: "review",
      requester: { kind: "user", sessionID },
      requestID: "message-fixture",
      directory: "/fixture/project",
      target: { kind: "uncommitted" },
      background: false,
    },
    status: "done",
    result: {
      state: "partial",
      verdict: "incomplete",
      summary: "Some files were reviewed.",
      findings: [finding],
      sendsTo: "this-computer",
      sessions: [],
      notes: [],
    },
    time: { created: 1, started: 2, ended: 3 },
  }
}
