import { createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor } from "solid-js"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { createStore } from "solid-js/store"
import { ComputerSendGate } from "./send-gate"

export type ComputerStateInput = {
  /** The desktop platform, passed only when the desktop owns this engine's Hands runs. */
  desktop?: Computer.ComputerPlatform
  /** The engine's `computer.state` events from every directory of the page's server; returns the unsubscribe. */
  listen: (cb: (event: { sessionID: string; state: unknown }) => void) => () => void
  /**
   * Whether a session's turn is still running, or undefined when the page has never seen its status: a session in a
   * directory the page has not loaded that was already busy when the page connected.
   */
  working: (sessionID: string) => boolean | undefined
  silenceMs?: number
  /** How long a failed first desktop read waits before its one retry. */
  retryMs?: number
}

export type ComputerStateValue = {
  state: Accessor<Computer.ComputerState | undefined>
  /** Present when the desktop owns the run: Stop, Take over and Resume go to it. */
  desktop?: Computer.ComputerPlatform
  /** Windows Resume remains disabled until its current native setup status is verified. */
  resumeReady?: Accessor<boolean>
}

/** Undefined outside a session page. The Tasks button, the Tasks pane and the composer share one subscription. */
export const ComputerStateContext = createContext<ComputerStateValue>()

export function useComputerState() {
  return useContext(ComputerStateContext)
}

const decode = Schema.decodeUnknownOption(Computer.ComputerState)
const READ_RETRY_MS = 1000

/**
 * The current Hands state for a session page. The desktop's own state is the source whenever the desktop owns the
 * run. Otherwise the engine's `computer.state` event is: it is decoded (it crosses the network from whichever engine
 * the page uses), accepted only from the holder's own session while that session works, and dropped 10 s after the
 * last event or as soon as the holder stops working, because the engine publishes no final state on an ordinary
 * release and its once-a-second throttle can drop the last one. A holder whose status the page has never seen counts
 * as working while a conversation queued behind it works, so the queued card can name a holder in another directory
 * that was already busy when the page loaded.
 */
export function createComputerState(input: ComputerStateInput): ComputerStateValue {
  const [state, setState] = createSignal<Computer.ComputerState>()
  const desktop = input.desktop
  if (desktop) {
    const [setup, setSetup] = createStore({ ready: false })
    const windowsPaused = createMemo(() => state()?.backend === "local-windows" && state()?.phase === "paused")
    createEffect(() => {
      if (!windowsPaused()) return
      let retired = false
      let pending = false
      setSetup("ready", false)
      const check = async () => {
        if (pending || retired) return
        pending = true
        try {
          if (!desktop.inputSetup) throw new Error("Input setup unavailable")
          const value = await ComputerSendGate.bounded(desktop.inputSetup("status"))
          const decoded = Schema.decodeUnknownOption(Computer.InputSetupStatus, { onExcessProperty: "error" })(value)
          if (!retired) setSetup("ready", Option.isSome(decoded) && Computer.inputSetupReady(decoded.value))
        } catch {
          if (!retired) setSetup("ready", false)
        } finally {
          pending = false
        }
      }
      void check()
      const timer = setInterval(() => void check(), 1000)
      onCleanup(() => {
        retired = true
        clearInterval(timer)
        setSetup("ready", false)
      })
    })
    // An event that arrives while a read is in flight is newer than that read's answer.
    let live = false
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const stop = desktop.onState((next) => {
      live = true
      clearTimeout(retry)
      setState(next)
    })
    onCleanup(() => {
      disposed = true
      clearTimeout(retry)
      stop()
    })
    // The desktop publishes nothing while a phase holds, such as a long pause, so a failed first read is reported and
    // tried once more; until an answer or an event arrives the page shows no Hands state.
    const read = (retries: number) =>
      void desktop.state().then(
        (initial) => {
          if (!live && !disposed) setState(initial)
        },
        (error) => {
          console.error("[computer] could not read the desktop's Hands state", error)
          if (retries === 0 || live || disposed) return
          retry = setTimeout(() => read(retries - 1), input.retryMs ?? READ_RETRY_MS)
        },
      )
    read(1)
    return { state, desktop, resumeReady: () => state()?.backend !== "local-windows" || setup.ready }
  }

  const silence = input.silenceMs ?? Computer.LIMITS.engineSilenceMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
    setState(undefined)
  }
  // A holder seen going idle never counts, so a throttled or forked publish that lands after its turn ended cannot
  // bring the card back.
  const holding = (value: Computer.ComputerState | undefined) => {
    if (!value?.holder) return false
    return input.working(value.holder.sessionID) ?? value.queue.some((item) => input.working(item.sessionID) === true)
  }
  const stop = input.listen((event) => {
    const next = Option.getOrUndefined(decode(event.state))
    if (!next || next.holder?.sessionID !== event.sessionID) return
    if (!holding(next)) return
    setState(next)
    clearTimeout(timer)
    timer = setTimeout(clear, silence)
  })
  onCleanup(() => {
    stop()
    clearTimeout(timer)
  })
  createEffect(() => {
    if (state() && !holding(state())) clear()
  })
  const visible = createMemo(() => (holding(state()) ? state() : undefined))
  return { state: visible }
}
