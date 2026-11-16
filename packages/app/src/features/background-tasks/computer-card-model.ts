import type { Computer } from "@vectordevai/schema/computer"
import type { Message, Part, ToolPart } from "@vectordevai/sdk/v2"
import { computerShot } from "@vectordevai/session-ui/computer-labels"
import { groupParts, isComputerTool, runOpen } from "@vectordevai/session-ui/message-part-group"
import type { dict } from "../../i18n/en"

type Key = Extract<keyof typeof dict, `computer.${string}`>
type Phase = Computer.ComputerPhase
type State = Computer.ComputerState

/** The holder phases of a run in progress: the dot, Stop and the composer's "Using <app>" follow them. */
const ACTIVE = new Set<Phase>(["working", "asking", "handoff", "paused", "waiting"])

// The desktop's `waiting` phase (it waits while the user types in the target app) still reads as Working; its step
// line says why.
const STATUS: Partial<Record<Phase, Key>> = {
  working: "computer.status.working",
  waiting: "computer.status.working",
  asking: "computer.status.needsYou",
  handoff: "computer.status.needsYou",
  paused: "computer.status.paused",
  done: "computer.status.done",
  stopped: "computer.status.stopped",
}

const PAUSE: Record<Computer.PauseReason, Key> = {
  input: "computer.pause.control",
  button: "computer.pause.control",
  locked: "computer.pause.locked",
  suspend: "computer.pause.locked",
  away: "computer.checkIn.away",
  helper: "computer.pause.helper",
  detection: "computer.pause.inputDetection",
  secure_input: "computer.pause.secureTyping",
  secure_desktop: "computer.pause.secureDesktop",
  overlay: "computer.pause.overlay",
  pointer: "computer.pointer.title",
}

export type HolderCard = {
  kind: "holder"
  phase: Phase
  status: Key
  step?: string
  apps: State["apps"]
  startedAt: number
  actions: number
  /** Other conversations waiting for the computer. */
  waiting: number
  /** The pause sentence; `app` fills `{{app}}`, and `detail` is the secure-typing explanation. */
  pause?: { key: Key; app?: string; detail?: Key }
  ask?: NonNullable<State["ask"]>
  holder: { sessionID: string; directory: string }
  dot: boolean
  stop: boolean
  takeOver: boolean
  resume: boolean
}

export type QueuedCard = {
  kind: "queued"
  status: Key
  /** The holder's title, for "Waiting for the computer: <title> is using it". */
  title?: string
  holder?: { sessionID: string; directory: string }
  dot: false
  /** Stop fails only this conversation's pending call (`stop-session`). */
  stop: true
}

export type CardModel = HolderCard | QueuedCard

/**
 * The pinned Tasks card for the open conversation, or nothing. Holders and queued conversations are always root
 * sessions (INV-S10), so the open family is matched by its root session ID.
 */
export function cardModel(state: State | undefined, rootID: string | undefined): CardModel | undefined {
  if (!state || !rootID) return
  const holder = state.holder
  if (holder?.sessionID === rootID) {
    const status = STATUS[state.phase]
    if (!status) return
    const active = ACTIVE.has(state.phase)
    return {
      kind: "holder",
      phase: state.phase,
      status,
      step: state.step,
      apps: state.apps,
      startedAt: holder.startedAt,
      actions: holder.actions,
      waiting: state.queue.length,
      pause: state.phase === "paused" && state.pause ? pause(state.pause, state.secureInputHolder) : undefined,
      ask: active ? state.ask : undefined,
      holder: { sessionID: holder.sessionID, directory: holder.directory },
      dot: active,
      stop: active,
      takeOver: state.phase === "working" && state.mode === "foreground",
      // A pointer wait is answered only by the banner's request-bound Hand over or Not now (E6b step 5, INV-C6); the
      // desktop's `resume` carries no request ID, so the card never offers it there.
      resume: state.phase === "paused" && state.pause !== "pointer",
    }
  }
  if (!state.queue.some((item) => item.sessionID === rootID)) return
  return {
    kind: "queued",
    status: holder ? "computer.tasks.waiting" : "computer.working.waiting",
    title: holder?.title,
    holder: holder && { sessionID: holder.sessionID, directory: holder.directory },
    dot: false,
    stop: true,
  }
}

function pause(reason: Computer.PauseReason, app: string | undefined): HolderCard["pause"] {
  if (reason === "secure_input") return { key: PAUSE[reason], app, detail: "computer.pause.secureTyping.description" }
  return { key: PAUSE[reason] }
}

/** The composer's working line for a session: "Using <app>" for the holder, "Waiting for the computer" when queued. */
export function workingLine(
  state: State | undefined,
  sessionID: string | undefined,
): { key: Key; params?: { app: string } } | undefined {
  if (!state || !sessionID) return
  // The desktop keeps the app it is using now last in `apps` (D18).
  const app = state.apps.at(-1)
  if (state.holder?.sessionID === sessionID && ACTIVE.has(state.phase) && app)
    return { key: "computer.working.app", params: { app: app.name } }
  if (state.queue.some((item) => item.sessionID === sessionID)) return { key: "computer.working.waiting" }
}

/**
 * The parts of the holder's current Hands run: the last run card of its latest turn, built exactly as the timeline
 * builds it, across every assistant message of the turn (each provider step is its own message). `keep` is the
 * timeline's `renderable`.
 */
export function holderRun(input: {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  keep: (part: Part) => boolean
  working: boolean
}): Part[] | undefined {
  const user = input.messages.findLast((message) => message.role === "user")
  if (!user) return
  const turn = input.messages.filter((message) => message.role === "assistant" && message.parentID === user.id)
  const items = turn.flatMap((message) =>
    input
      .parts(message.id)
      .filter(input.keep)
      .map((part) => ({ messageID: message.id, part })),
  )
  const run = groupParts(
    items,
    runOpen(
      input.working,
      turn.map((message) => input.parts(message.id)),
    ),
  ).findLast((group) => group.type === "computer")
  if (run?.type !== "computer") return
  const byID = new Map(items.map((item) => [item.part.id, item.part]))
  return run.refs.flatMap((ref) => byID.get(ref.partID) ?? [])
}

/** The run's latest screenshot, or its removal marker. */
export function latestShot(parts: readonly Part[] | undefined) {
  const tools = (parts ?? []).filter((part): part is ToolPart => isComputerTool(part))
  return tools.map((part) => computerShot(part)).findLast((shot) => !!shot)
}
