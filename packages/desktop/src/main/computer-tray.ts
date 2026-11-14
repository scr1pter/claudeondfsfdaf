import type { Computer } from "@vectordevai/schema/computer"
import { ComputerMainCopy } from "@vectordevai/app/computer/main-copy"

/** What the tray reads from the session controller. Only Vector-built facts: the phase, mode and a verified app. */
export type ComputerTrayState = { phase: Computer.ComputerPhase; app?: string; mode?: Computer.Mode }
export type ComputerTrayCommand = "takeover" | "resume" | "stop"
export type ComputerTrayItem = { label: string; enabled: boolean; command?: ComputerTrayCommand }

const ACTIVE = new Set<Computer.ComputerPhase>(["working", "waiting", "asking", "handoff", "paused"])

/** The tray's view of a run in progress, or undefined when Hands holds nothing and the tray stays as it was. */
export function computerTrayItems(
  state: ComputerTrayState | undefined,
): { tooltip: string; items: ComputerTrayItem[] } | undefined {
  if (!state || !ACTIVE.has(state.phase)) return
  const labels = ComputerMainCopy.labels
  const items: ComputerTrayItem[] = [
    {
      label: state.app ? ComputerMainCopy.working({ app: state.app }) : labels.working,
      enabled: false,
    },
  ]
  if (state.phase === "paused") items.push({ label: labels.resume, enabled: true, command: "resume" })
  // Take over is offered where the banner offers it: while Hands drives the real mouse and keyboard.
  else if ((state.phase === "working" || state.phase === "waiting") && state.mode !== "background")
    items.push({ label: labels.takeOver, enabled: true, command: "takeover" })
  items.push({ label: ComputerMainCopy.trayStop(), enabled: true, command: "stop" })
  return { tooltip: ComputerMainCopy.trayTooltip(), items }
}

/** Projects the controller's state for the tray; the app is the latest verified app name, never model text. */
export function computerTrayState(state: Computer.ComputerState): ComputerTrayState {
  return { phase: state.phase, mode: state.mode, ...(state.apps.at(-1) ? { app: state.apps.at(-1)!.name } : {}) }
}
