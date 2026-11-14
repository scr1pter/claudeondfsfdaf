import type { Part as PartType, ToolPart } from "@vectordevai/sdk/v2"
import { Hands } from "@vectordevai/core/computer/hands"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "computer"
      refs: PartRef[]
    }

type Item = { messageID: string; part: PartType }

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export function isComputerTool(part: PartType): part is ToolPart {
  return part.type === "tool" && part.tool === Hands.ID
}

/** A question the turn is waiting on. It renders nothing until it is answered (see `renderable`). */
export function isPendingQuestion(part: PartType) {
  return (
    part.type === "tool" &&
    part.tool === "question" &&
    (part.state.status === "pending" || part.state.status === "running")
  )
}

/**
 * `open` for groupParts: whether a working turn's latest run keeps its trailing notes. A question the turn waits on
 * never reaches groupParts, so it cannot close the run by following it. While one waits the run is closed instead,
 * and the agent's words leading up to the question show as their own rows.
 */
export function runOpen(working: boolean | undefined, turn: readonly (readonly PartType[])[]) {
  return !!working && !turn.some((parts) => parts.some(isPendingQuestion))
}

/** The IDs of the parts run cards hold. They render inside their card, never as a row of their own. */
export function runPartIDs(groups: readonly PartGroup[]) {
  return new Set(groups.flatMap((group) => (group.type === "computer" ? group.refs.map((ref) => ref.partID) : [])))
}

/**
 * The turn's copy target, which also carries its details and reply footer: the last non-empty text part that has a
 * row of its own. When every text of the turn is a note inside run cards, it is the last of those, and the run card
 * holding it draws the footer (see `ReplyActions`), so the turn never loses it.
 */
export function copyPartID(turn: readonly (readonly PartType[])[], held: ReadonlySet<string>) {
  const text = (part: PartType) => part.type === "text" && !!part.text?.trim()
  const own = (part: PartType) => text(part) && !held.has(part.id)
  return (
    turn.findLast((parts) => parts.some(own))?.findLast(own)?.id ??
    turn.findLast((parts) => parts.some(text))?.findLast(text)?.id
  )
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

/**
 * Groups the renderable parts of a turn into timeline rows. Consecutive context tools form one group, keyed by its
 * first member. Consecutive computer tool parts, with the text and reasoning between them, form one run card keyed
 * by its first computer part, so the key never changes as the run grows. Text before a run and after it stays its
 * own row. While the turn is still working (`open`), notes after the run's latest computer part stay in the run:
 * a provider turn writes its narration before its tool call, so splitting them out until the next call would mount
 * and then remove a row at every step. They leave the run once, when another part follows, the turn ends or it waits
 * on a question (see `runOpen`).
 */
export function groupParts(parts: Item[], open = false) {
  const result: PartGroup[] = []
  const context: PartRef[] = []
  const run: PartRef[] = []
  const notes: Item[] = []

  const flushContext = () => {
    if (context.length === 0) return
    result.push({ key: `context:${context[0]!.partID}`, type: "context", refs: context.splice(0) })
  }
  const closeRun = () => {
    if (run.length > 0) result.push({ key: `computer:${run[0]!.partID}`, type: "computer", refs: run.splice(0) })
    notes.splice(0).forEach((item) => result.push(single(item)))
  }

  parts.forEach((item) => {
    if (isContextGroupTool(item.part)) {
      closeRun()
      context.push(ref(item))
      return
    }
    flushContext()
    if (isComputerTool(item.part)) {
      run.push(...notes.splice(0).map(ref), ref(item))
      return
    }
    if (run.length > 0 && (item.part.type === "text" || item.part.type === "reasoning")) {
      notes.push(item)
      return
    }
    closeRun()
    result.push(single(item))
  })

  flushContext()
  if (open) run.push(...notes.splice(0).map(ref))
  closeRun()
  return result
}

function ref(item: Item): PartRef {
  return { messageID: item.messageID, partID: item.part.id }
}

function single(item: Item): PartGroup {
  return { key: `part:${item.messageID}:${item.part.id}`, type: "part", ref: ref(item) }
}

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") return b.type === "part" && sameRef(a.ref, b.ref)
  if (b.type === "part") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}
