import { LIMITS, decodeInboundTrigger, isIssueKey, type UntrustedItem } from "../../../../packages/schema/src/everywhere.js"
import { ApiError } from "../../http.js"
import type { ParsedTrigger } from "../platform.js"
import { adfText } from "./adf.js"
import type { jiraClient } from "./client.js"
import { jiraObject, type ForgeInvocation } from "./fit.js"
import type { JiraTaskRecord } from "./task-store.js"

export const JIRA_INVOCATIONS = ["ISSUE_ASSIGNMENT", "ISSUE_COMMENT_MENTION", "ISSUE_WORKFLOW_ASSIGNMENT", "ISSUE_MANUAL_TRIGGER"] as const
export async function jiraRequester(call: ReturnType<typeof jiraClient>, principal: string) {
  const user = await call("myself")
  if (user.accountId !== principal || user.accountType !== "atlassian" || user.active !== true || user.guest !== false)
    throw new ApiError(403, "JIRA_REQUESTER_REFUSED", "A current human Jira member is required.")
}

/** Fetch only the invoking user's permitted issue data. Mutable titles, descriptions and comments remain context. */
export async function parseJira(input: {
  readonly data: Record<string, unknown>
  readonly text: string
  readonly messageId: string
  readonly invocation: ForgeInvocation
  readonly task: JiraTaskRecord
  readonly call: ReturnType<typeof jiraClient>
}): Promise<{ readonly parsed: ParsedTrigger; readonly needsOrigin: boolean }> {
  const data = input.data
  const principal = input.invocation.principal
  if (!principal || data.userAccountId !== principal || data.agentAccountId === principal || data.selfGenerated === true ||
    !JIRA_INVOCATIONS.includes(data.invocationType as typeof JIRA_INVOCATIONS[number])) throw new ApiError(403, "JIRA_TRIGGER_REFUSED", "This Jira invocation is not supported.")
  await jiraRequester(input.call, principal)
  const supplied = jiraObject(data.issue)
  const issue = await input.call("issue", String(supplied.id))
  const fields = jiraObject(issue.fields)
  const project = jiraObject(fields.project)
  if (issue.id !== supplied.id || typeof issue.key !== "string" || !isIssueKey(issue.key) || jiraObject(supplied.fields).key !== issue.key ||
    typeof project.key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,9}$/.test(project.key)) throw new ApiError(400, "JIRA_ISSUE_INVALID", "The Jira work item could not be verified.")
  const context: UntrustedItem[] = []
  const add = (value: unknown, from: UntrustedItem["from"] = "platform") => {
    if (context.length >= LIMITS.contextItems || context.reduce((size, item) => size + item.text.length, 0) >= 19_000) return
    const text = adfText(value, LIMITS.itemChars)
    if (text) context.push({ from, text })
  }
  add(fields.summary); add(fields.description); add(input.text)
  for (const comment of Array.isArray(jiraObject(fields.comment).comments) ? (jiraObject(fields.comment).comments as unknown[]).slice(0, 15) : []) add(jiraObject(comment).body, "teammate")
  let task = "Work on this work item."
  let needsOrigin = ["ISSUE_WORKFLOW_ASSIGNMENT", "ISSUE_MANUAL_TRIGGER"].includes(String(data.invocationType))
  if (data.invocationType === "ISSUE_COMMENT_MENTION") {
    const reference = jiraObject(data.comment)
    const comment = await input.call("comment", String(issue.id), String(reference.id))
    const text = adfText(comment.body, LIMITS.taskChars + 1)
    const suppliedText = adfText(reference.body, LIMITS.taskChars + 1)
    needsOrigin = comment.id !== reference.id || jiraObject(comment.author).accountId !== principal || typeof comment.created !== "string" ||
      comment.created !== comment.updated || !text || text.length > LIMITS.taskChars || text !== suppliedText
    if (!needsOrigin) task = text
    add(reference.body, "teammate")
  }
  const trigger = { platform: "jira" as const, installation: input.task.installation, deliveryId: `${input.invocation.cloudId}:${principal}:${input.messageId}`,
    actor: { userId: principal, bot: false, guest: false, external: false }, kind: data.invocationType === "ISSUE_COMMENT_MENTION" ? "mention" as const : "assign" as const,
    thread: { ref: input.task.contextId }, task, context, shared: true, issue: { key: issue.key } }
  if (!decodeInboundTrigger(trigger).ok) throw new ApiError(400, "JIRA_TRIGGER_INVALID", "The Jira request could not be admitted.")
  return { parsed: { trigger, place: project.key, reply: { ref: input.task.contextId, context: input.task.contextId, task: input.task.id, user: principal,
    place: project.key, installRevision: input.task.authority } }, needsOrigin }
}
