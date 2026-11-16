import { LIMITS, decodeInboundTrigger, type UntrustedItem } from "../../../../packages/schema/src/everywhere.js"
import type { InstallRecord } from "../identity.js"
import type { ParsedTrigger } from "../platform.js"
import { linearId, linearObject } from "./verify.js"

/** Published SDL fields, not narrative examples that still refer to agentActivity.body. */
export function parseLinear(body: unknown, delivery: string, record: InstallRecord): ParsedTrigger | { ignore: string } {
  const value = linearObject(body)
  const session = linearObject(value.agentSession)
  const issue = linearObject(session.issue)
  const creator = linearObject(session.creator)
  const activity = linearObject(value.agentActivity)
  const author = linearObject(activity.user)
  const content = linearObject(activity.content)
  if (value.type !== "AgentSessionEvent" || !["created", "prompted"].includes(String(value.action)) || !linearId(value.organizationId) || !linearId(record.botUserId) ||
    !linearId(session.id) || session.organizationId !== value.organizationId || session.appUserId !== record.botUserId || value.appUserId !== record.botUserId ||
    !linearId(session.creatorId) || creator.id !== session.creatorId || session.creatorId === record.botUserId || !linearId(issue.id) || !linearId(issue.teamId) ||
    linearObject(issue.team).id !== issue.teamId || typeof issue.identifier !== "string" || !/^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,15}$/.test(issue.identifier))
    return { ignore: "session" }
  const prompted = value.action === "prompted"
  const native = linearId(activity.id) && activity.agentSessionId === session.id && linearId(activity.userId) && author.id === activity.userId && content.type === "prompt"
  if (prompted && !native) return { ignore: "activity" }
  if (native && activity.userId !== session.creatorId) return { ignore: "non-sponsor-context" }
  const stop = native && activity.signal === "stop"
  const task = native && typeof content.body === "string" ? content.body.trim() : "Work on this issue."
  if ((!stop && !task) || task.length > LIMITS.taskChars) return { ignore: "task" }
  const context: UntrustedItem[] = []
  const add = (text: unknown, from: UntrustedItem["from"] = "platform") => {
    if (typeof text !== "string" || !text || context.length >= LIMITS.contextItems || context.reduce((size, item) => size + item.text.length, 0) >= 19_000) return
    context.push({ from, text: text.slice(0, LIMITS.itemChars) })
  }
  add(issue.title)
  add(issue.description)
  add(value.promptContext)
  add(linearObject(session.comment).body, "teammate")
  for (const comment of Array.isArray(value.previousComments) ? value.previousComments.slice(0, 15) : []) add(linearObject(comment).body, linearObject(comment).userId === session.creatorId ? "requester" : "teammate")
  for (const guidance of Array.isArray(value.guidance) ? value.guidance.slice(0, 5) : []) add(linearObject(guidance).body)
  const trigger = { platform: "linear" as const, installation: `linear:${value.organizationId}`, deliveryId: delivery,
    actor: { userId: String(session.creatorId), bot: false, guest: false, external: false },
    kind: stop ? "stop" as const : prompted ? "followup" as const : "assign" as const,
    thread: { ref: session.id }, task: stop ? "" : task, context, shared: true, issue: { key: issue.identifier } }
  if (!decodeInboundTrigger(trigger).ok) return { ignore: "shape" }
  return { trigger, place: issue.teamId, reply: { ref: session.id, session: session.id, team: issue.teamId, issue: issue.id,
    user: String(session.creatorId), appUser: record.botUserId!, delivery, initial: !prompted, stop: !!stop, needsPrompt: !native,
    ...(native ? { activity: String(activity.id) } : {}) } }
}
