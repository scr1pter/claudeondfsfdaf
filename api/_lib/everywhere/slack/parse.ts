import { LIMITS, decodeInboundTrigger } from "../../../../packages/schema/src/everywhere.js"
import type { InstallRecord } from "../identity.js"
import type { ParsedTrigger } from "../platform.js"
import { slackId, slackObject, slackTimestamp } from "./verify.js"

/** Only signed, explicit team/enterprise ids can select an existing installation. Never choose by display name. */
export function slackHome(body: unknown) {
  const envelope = slackObject(body)
  const authorizations = (Array.isArray(envelope.authorizations) ? envelope.authorizations.slice(0, 20) : []).map(slackObject)
  const authorization = authorizations.find((item) => item.is_bot === true) ?? authorizations[0]
  const team = envelope.context_team_id ?? authorization?.team_id ?? envelope.team_id
  const enterprise = envelope.context_enterprise_id ?? authorization?.enterprise_id ?? (authorizations.length ? undefined : envelope.enterprise_id)
  if (team !== undefined && team !== null && (!slackId(team) || !team.startsWith("T"))) return undefined
  if (enterprise !== undefined && enterprise !== null && (!slackId(enterprise) || !enterprise.startsWith("E"))) return undefined
  return { team: typeof team === "string" ? team : undefined, enterprise: typeof enterprise === "string" ? enterprise : undefined,
    organization: authorization?.is_enterprise_install === true, authorizations }
}

export function slackInstallations(body: unknown): string[] {
  const home = slackHome(body)
  if (!home) return []
  if (home.organization) return home.enterprise ? [`slack:${home.enterprise}`] : []
  if (!home.team) return home.enterprise && !home.authorizations.length ? [`slack:${home.enterprise}`] : []
  return home.enterprise ? [`slack:${home.enterprise}:${home.team}`, `slack:${home.team}`,
    ...(!home.authorizations.length ? [`slack:${home.enterprise}`] : [])] : [`slack:${home.team}`]
}

/** A signed event visible to a different bot installation cannot borrow this installation's token or mapping. */
export function slackAuthorized(body: unknown, installation: string, record: InstallRecord): boolean {
  const home = slackHome(body)
  if (!home || !slackInstallations(body).includes(installation)) return false
  return home.authorizations.some((item) => item.is_bot === true && item.user_id === record.botUserId &&
    (home.organization ? item.is_enterprise_install === true && item.enterprise_id === home.enterprise :
      item.is_enterprise_install === false && item.team_id === home.team))
}

export function slackCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^(help|status|stop|unlink|link|repo)(?:[ \t]+([^\r\n]+))?$/i.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  const argument = match[2]?.trim() ?? ""
  return ["help", "status", "stop", "unlink"].includes(name) && argument ? undefined : { name, argument }
}

export function parseSlack(body: unknown, installation: string, record?: InstallRecord): ParsedTrigger | { ignore: string } {
  const envelope = slackObject(body)
  const home = slackHome(body)
  const event = slackObject(envelope.event)
  const stop = event.type === "agent_session_stopped"
  const dm = event.type === "message" && event.channel_type === "im"
  if ((!stop && event.type !== "app_mention" && !dm) || event.bot_id || event.subtype || event.hidden === true) return { ignore: "event" }
  if (!slackId(event.channel) || !slackId(event.user) || event.user === record?.botUserId || !home?.team) return { ignore: "identity" }
  const thread = event.thread_ts ?? event.ts
  if (!slackTimestamp(thread) || typeof envelope.event_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(envelope.event_id)) return { ignore: "reference" }
  const original = typeof event.text === "string" ? event.text : ""
  const task = record?.botUserId ? original.replace(new RegExp(`^\\s*<@${record.botUserId}>[\\s:,-]*`), "").trim() : original.trim()
  if ((!stop && !task) || task.length > LIMITS.taskChars) return { ignore: "task" }
  const command = slackCommand(task)
  const ref = `${event.channel}:${thread}`
  const trigger = { platform: "slack" as const, installation, deliveryId: envelope.event_id,
    actor: { userId: event.user, bot: false, external: false, guest: false },
    kind: stop || command?.name === "stop" ? "stop" as const : command ? "command" as const : dm ? "dm" as const : "mention" as const,
    thread: { ref }, task: stop ? "" : task, context: [],
    // Minimum scopes cannot prove whether a channel is public. All non-DMs use the shared-place policy.
    shared: !dm || envelope.is_ext_shared_channel === true || event.is_ext_shared_channel === true,
  }
  if (!decodeInboundTrigger(trigger).ok) return { ignore: "shape" }
  return { trigger, place: event.channel, reply: { ref, channel: event.channel, thread, user: event.user, team: home.team,
    ...(home.enterprise ? { enterprise: home.enterprise } : {}),
    ...(slackTimestamp(event.ts) ? { eventTs: event.ts } : {}),
    threadRead: typeof event.thread_ts === "string" && event.thread_ts !== event.ts, control: !!command || stop } }
}
