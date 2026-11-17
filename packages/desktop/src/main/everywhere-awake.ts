import { holdDesktopWork } from "./keep-awake"

/**
 * Vector everywhere's "Stay awake to take jobs while plugged in" (spec §3.5 step 10, F6): the computer stays awake while
 * it takes jobs, the user opted in and it is on AC power, and may sleep again on battery, once jobs are off or once the
 * option is. It takes no blocker of its own. It holds keep-awake.ts's shared desktop-work blocker (holdDesktopWork), so
 * the machine's sleep state has one owner, the blocker index.ts sets with setDesktopWorkBlocker, which is released only
 * once no desktop work needs it.
 *
 * Power is injected (Electron's powerMonitor, from remote-runtime.ts). `changed` is subscribed only while the computer
 * takes jobs with the option on, so nothing watches power otherwise. Importing this module holds nothing.
 */
export function createEverywhereAwake(input: {
  readonly onBattery: () => boolean
  /** Calls the listener whenever the power source may have changed; the returned function unsubscribes. */
  readonly changed: (listener: () => void) => () => void
}) {
  const state: { armed: boolean; release?: () => void; unsubscribe?: () => void } = { armed: false }
  const apply = () => {
    const wanted = state.armed && !input.onBattery()
    if (wanted && !state.release) state.release = holdDesktopWork()
    if (wanted || !state.release) return
    state.release()
    state.release = undefined
  }
  const update = (jobsOn: boolean, stayAwake: boolean) => {
    state.armed = jobsOn && stayAwake
    if (state.armed && !state.unsubscribe) state.unsubscribe = input.changed(apply)
    if (!state.armed && state.unsubscribe) {
      state.unsubscribe()
      state.unsubscribe = undefined
    }
    apply()
  }
  return { update, dispose: () => update(false, false) }
}
