import { Show } from "solid-js"
import { Button } from "@vectordevai/ui/button"
import { DockTray } from "@vectordevai/ui/dock-surface"
import { Icon } from "@vectordevai/ui/icon"
import { useLanguage } from "@/context/language"

/*
 * The interrupted dock (5.I.4): on a root session, "2 subagents stopped when Vector restarted. Nothing resumes on its
 * own." with Resume all and Dismiss. Nothing resumes by itself after a restart (decision 6); this is the one-click
 * resume. Dismissing hides the dock for the helpers it named, stored per root session in this browser, so a later
 * restart that interrupts other helpers shows it again.
 */

const DISMISSED_KEY = "vector.interruptedDock.dismissed.v1:"
/** The most dismissed helper IDs kept per root; the oldest go first. */
const DISMISSED_LIMIT = 200

function storage() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** Helper task IDs whose interruption the user dismissed from this root's dock. */
export function loadInterruptedDismissed(rootID: string): string[] {
  try {
    const raw = storage()?.getItem(DISMISSED_KEY + rootID)
    if (!raw) return []
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

export function saveInterruptedDismissed(rootID: string, ids: readonly string[]) {
  const kept = [...new Set(ids)].slice(-DISMISSED_LIMIT)
  try {
    storage()?.setItem(DISMISSED_KEY + rootID, JSON.stringify(kept))
  } catch {
    // The dismissal still holds for as long as the page stays open.
  }
  return kept
}

export type InterruptedHelper = { id: string; resumable: boolean }

export type InterruptedDockState = {
  /** Every interrupted helper the dock names. */
  ids: readonly string[]
  /** The ones Resume all resumes: the engine offers resume for them. */
  resumable: readonly string[]
}

/**
 * What the dock shows: the root's interrupted helpers that are neither resumed nor dismissed here. Nothing on a
 * subagent's own page, and nothing once every one of them is dismissed.
 */
export function interruptedDockState(input: {
  root: boolean
  helpers: readonly InterruptedHelper[]
  dismissed: readonly string[]
}): InterruptedDockState | undefined {
  if (!input.root) return undefined
  const dismissed = new Set(input.dismissed)
  const seen = new Set<string>()
  const shown = input.helpers.filter((helper) => {
    if (!helper.id || dismissed.has(helper.id) || seen.has(helper.id)) return false
    seen.add(helper.id)
    return true
  })
  if (shown.length === 0) return undefined
  return { ids: shown.map((helper) => helper.id), resumable: shown.filter((h) => h.resumable).map((h) => h.id) }
}

/** Dismissing adds the dock's helpers to what is already dismissed for the root. */
export function dismissInterrupted(dismissed: readonly string[], state: InterruptedDockState) {
  return [...new Set([...dismissed, ...state.ids])]
}

export function SessionInterruptedDock(props: {
  count: number
  /** Helpers Resume all can resume; 0 hides it (an engine without resume, or none offered). */
  resumable: number
  resuming?: boolean
  onResumeAll: () => void
  onDismiss: () => void
}) {
  const language = useLanguage()
  return (
    <DockTray data-component="session-interrupted-dock">
      <div class="flex min-w-0 items-center gap-2 pl-3 pr-2 py-2" role="status">
        <span class="shrink-0 text-icon-weak" aria-hidden="true">
          <Icon name="warning" size="normal" />
        </span>
        <span class="min-w-0 flex-1 text-13-regular text-text-strong">
          {language.t(
            props.count === 1 ? "session.interruptedDock.summary.one" : "session.interruptedDock.summary.other",
            { count: props.count },
          )}
        </span>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <Show when={props.resumable > 0}>
            <Button
              size="small"
              variant="secondary"
              disabled={props.resuming}
              aria-busy={props.resuming}
              onClick={() => props.onResumeAll()}
            >
              {props.resuming
                ? language.t("backgroundTasks.interrupted.resuming")
                : language.t("session.interruptedDock.resumeAll")}
            </Button>
          </Show>
          <Button size="small" variant="ghost" disabled={props.resuming} onClick={() => props.onDismiss()}>
            {language.t("session.interruptedDock.dismiss")}
          </Button>
        </div>
      </div>
    </DockTray>
  )
}
