import { sanitizeTerminalText } from "../../util/presentation"

export function connectedMemberLine(member: {
  state: string
  reason?: string
  place: string
  sendsTo?: string
  reach: string
}) {
  return sanitizeTerminalText(
    [
      member.state + (member.reason ? `: ${member.reason}` : ""),
      `runs ${member.place}`,
      ...(member.sendsTo ? [`sends to ${member.sendsTo}`] : []),
      `reach: ${member.reach}`,
    ].join("; "),
  )
}

export function connectedRunLine(run: {
  status: string
  result?: { summary: string; sendsTo?: string; cost?: { kind: string; usd?: number } }
}) {
  return sanitizeTerminalText(
    [
      run.result?.summary ?? run.status,
      ...(run.result?.sendsTo ? [`sent to ${run.result.sendsTo}`] : []),
      ...(run.result?.cost?.kind === "plan" ? ["plan usage"] : []),
    ].join("; "),
  )
}

export function connectedConsent(permission: string, metadata: Record<string, unknown> | undefined) {
  if (
    !["connect", "connect_model", "connect_write"].includes(permission) ||
    typeof metadata?.runID !== "string" ||
    typeof metadata.description !== "string"
  )
    return undefined
  return sanitizeTerminalText(metadata.description)
}
