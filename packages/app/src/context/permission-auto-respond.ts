import { base64Encode } from "@vectordevai/core/util/encode"
import { canAutoAcceptPermission } from "./permission-policy"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

/** The session and every session above it, nearest first: the ones whose auto-accept setting applies. */
export function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string; permission?: string; always?: string[]; patterns?: string[] },
  directory?: string,
) {
  if (!canAutoAcceptPermission(permission.permission, permission.always, permission.patterns)) return false
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? false
}

/**
 * Whether a turn a paired phone started leaves auto-accept free to answer (Vector Remote, WP A41, S6): a turn started
 * from the phone is never auto-approved, so a request in it, or in a subagent under it, waits for a person on the phone
 * or here. `isPhoneTurn` is the desktop's check (absent outside the desktop app, where no phone can start a turn); a
 * check that fails counts as a phone's turn.
 */
export async function phoneTurnAllows(
  isPhoneTurn: ((sessionIDs: string[]) => Promise<boolean>) | undefined,
  lineage: string[],
) {
  if (!isPhoneTurn) return true
  return isPhoneTurn(lineage).then(
    (started) => started === false,
    () => false,
  )
}
