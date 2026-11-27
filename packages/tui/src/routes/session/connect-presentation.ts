import { Connect } from "@vectordevai/schema/connect"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import type { PermissionRequest } from "@vectordevai/sdk/v2"
import { Schema } from "effect"
import { sanitizeTerminalText } from "../../util/presentation"

type PermissionDetails = Pick<PermissionRequest, "permission" | "metadata">

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

/** A merge approval must show the patch the owner is being asked to apply. */
export function connectedDiff(permission: string, metadata: Record<string, unknown> | undefined) {
  if (
    permission !== "connect_write" ||
    !Schema.is(Connect.RunID)(metadata?.runID) ||
    typeof metadata?.diff !== "string" ||
    !metadata.diff
  )
    return undefined
  return metadata.diff
    .split(/([\n\t])/)
    .map((part) => (part === "\n" || part === "\t" ? part : sanitizeTerminalText(part)))
    .join("")
}

export function connectedWriteDetails(request: PermissionDetails) {
  if (request.permission !== "connect_write") return
  const approval = Connect.writeApprovalDetails(request.metadata)
  if (!approval) return
  const description = sanitizeTerminalText(approval.description).trim()
  if (!description) return
  const diff = connectedDiff(request.permission, request.metadata)
  if (approval.diff !== undefined && !diff?.trim()) return
  return { description, diff }
}

export function canApproveOnce(request: PermissionDetails) {
  return (
    !PermissionPolicy.requiresConnectConfirmation(request.permission) || connectedWriteDetails(request) !== undefined
  )
}

/** Build a one-time reply for an interactive approval button. */
export function oneTimePermissionReply(request: PermissionDetails & Pick<PermissionRequest, "id">) {
  if (!canApproveOnce(request)) return
  const reply = { requestID: request.id, reply: "once" as const }
  return request.permission === "connect_write" ? { ...reply, confirm: true as const } : reply
}
