import { randomUUID } from "node:crypto"
import { renderMilestone } from "../../../../packages/schema/src/everywhere-policy.js"
import type { JobRecord } from "../jobs.js"
import { open } from "../crypto.js"
import { everywhereKeys } from "../keys.js"
import { JiraFailure } from "./client.js"
import type { JiraTaskContext, JiraTaskRecord, JiraTaskState } from "./task-store.js"

export function jiraJobState(job: JobRecord): JiraTaskState {
  if (job.state === "cancelled") return "CANCELED"
  if (job.state === "refused") return "REJECTED"
  if (["failed", "lost", "expired"].includes(job.state)) return "FAILED"
  if (job.state === "settled") return job.outcome === "failed" ? "FAILED" : "COMPLETED"
  return job.state === "running" ? "WORKING" : "SUBMITTED"
}
export function jiraTask(ctx: JiraTaskContext, record: JiraTaskRecord, job?: JobRecord, override?: { readonly state: JiraTaskState; readonly text: string }) {
  const state = override?.state ?? (job ? jiraJobState(job) : record.state)
  const result = record.resultEnc ? open(ctx.keys, record.resultEnc, everywhereKeys.jiraTask(record.id)) : undefined
  if (result && !result.ok) throw new JiraFailure()
  const text = override?.text ?? (result?.ok ? result.value : record.code === "connect" ? "A Jira admin connects this site at https://vectordev.ai/everywhere." :
    record.code === "link" ? "Link your own Vector account at https://vectordev.ai/everywhere, then send your task again." :
    record.code === "origin" ? "Send your own coding task in this conversation before Vector starts." :
    record.code === "repository" ? "Choose an exact mapped repository option." : record.code === "unsupported" ? "This invocation is not supported. Assign Vector a work item or mention it in your own comment." :
    job && state === "WORKING" ? renderMilestone(job.milestone === "heartbeat" ? "reading" : job.milestone ?? "reading", { platform: "jira" }) :
    state === "SUBMITTED" ? "Received your request. Waiting for your computer." : state === "CANCELED" ? "Cancelled at your request." :
    state === "REJECTED" ? "This task could not be accepted." : "The result is being prepared.")
  const message = { role: "ROLE_AGENT", parts: [{ text }], messageId: randomUUID(), taskId: record.id, contextId: record.contextId }
  return { id: record.id, contextId: record.contextId, status: { state: `TASK_STATE_${state}`, message, timestamp: new Date(ctx.now).toISOString() },
    ...(["COMPLETED", "FAILED"].includes(state) && result?.ok ? { artifacts: [{ artifactId: record.id, name: "Vector result", parts: [{ text: result.value }] }] } : {}) }
}
