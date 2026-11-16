export * as ComputerMentionLookup from "./mention-lookup"

import type { Computer } from "@vectordevai/schema/computer"
import { ComputerMention } from "./mention"
import { ComputerSendGate } from "./send-gate"

export type State = {
  /** Unknown until this composer's first read; kept across openings so the row never flashes the wrong label. */
  readiness?: ComputerSendGate.Readiness
  apps: ComputerMention.AppOption[]
}

type Timers = {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const DELAY = 150

/**
 * The @ popover's computer rows. Opening it reads readiness at once (never a permission probe); a query looks up
 * apps after a 150 ms pause. Only the newest lookup may publish, and nothing publishes once the popover has closed or
 * the composer is gone, so a slow answer never shows rows for an older query or a closed popover.
 */
export function create(input: {
  computer: Computer.ComputerPlatform
  publish: (state: State) => void
  timers?: Timers
}) {
  const timers = input.timers ?? {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let state: State = { apps: [] }
  let open = false
  let disposed = false
  let timer: unknown
  // Each read or lookup takes the next number; an answer publishes only while its number is still the newest.
  let reads = 0
  let lookups = 0
  let current: Promise<ComputerSendGate.Readiness> | undefined
  // Each publish rebuilds the @ list, so an answer that changes nothing the rows show (an empty app list again, or the
  // same readiness on reopening) publishes nothing.
  const publish = (patch: Partial<State>) => {
    if (disposed) return
    const previous = state
    state = { ...state, ...patch }
    if (sameReadiness(previous.readiness, state.readiness) && sameApps(previous.apps, state.apps)) return
    input.publish(state)
  }
  const cancel = () => {
    if (timer !== undefined) timers.clear(timer)
    timer = undefined
    lookups++
  }
  const refresh = (): Promise<ComputerSendGate.Readiness> => {
    if (disposed) return Promise.resolve({ ready: false })
    const id = ++reads
    const promise = ComputerSendGate.readiness(input.computer)
    current = promise
    void promise.then((readiness) => {
      if (id === reads) publish({ readiness })
    })
    return promise
  }

  return {
    get state() {
      return state
    },
    /** A fresh readiness read for a selection; it also updates the row. */
    refresh,
    open() {
      if (disposed) return
      if (!open) {
        open = true
        // Apps from an earlier opening may be blocked or denied by now; none show until this opening's lookup.
        if (state.apps.length) publish({ apps: [] })
      }
      void refresh()
    },
    query(text: string) {
      if (disposed || !open) return
      cancel()
      if (!text.trim()) {
        // A bare "@" lists the feature row only, so references, resources and recent files stay in view.
        if (state.apps.length) publish({ apps: [] })
        return
      }
      const id = lookups
      timer = timers.set(() => {
        timer = undefined
        void Promise.all([input.computer.apps(text), current ?? refresh()]).then(
          ([apps, readiness]) => {
            if (disposed || !open || id !== lookups) return
            // Company rules come from the policy read with readiness; without one, no app can be offered.
            publish({ apps: readiness.policy ? ComputerMention.appOptions(apps, readiness.policy) : [] })
          },
          () => {
            if (disposed || !open || id !== lookups) return
            publish({ apps: [] })
          },
        )
      }, DELAY)
    },
    close() {
      if (!open) return
      open = false
      cancel()
      if (state.apps.length) publish({ apps: [] })
    },
    dispose() {
      cancel()
      disposed = true
    },
  }
}

// The rows show only whether Hands is ready and what blocks it; the policy shapes the app rows, which compare by field.
function sameReadiness(a: ComputerSendGate.Readiness | undefined, b: ComputerSendGate.Readiness | undefined) {
  return a?.ready === b?.ready && a?.blocked === b?.blocked
}

function sameApps(a: readonly ComputerMention.AppOption[], b: readonly ComputerMention.AppOption[]) {
  return (
    a.length === b.length &&
    a.every(
      (app, index) =>
        app.key === b[index].key &&
        app.name === b[index].name &&
        app.icon === b[index].icon &&
        app.running === b[index].running &&
        app.disabled === b[index].disabled,
    )
  )
}
