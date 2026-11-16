import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"

const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

const tokenFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

export function SessionWorkingStatus(props: {
  working: () => boolean
  startedAt: () => number | undefined
  tokens: () => number
  codium?: () => boolean
  runningTasks: () => number
  /** The Hands line: "Using <app>" or "Waiting for the computer". */
  computer?: () => string | undefined
  phrase?: () => string | undefined
}) {
  const [elapsed, setElapsed] = createSignal(0)
  let start = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  createEffect(() => {
    if (!props.working()) return
    // Prefer the server-recorded turn start so a reload resumes the real elapsed
    // time; fall back to the moment we observed the working transition.
    start = props.startedAt() ?? Date.now()
    setElapsed(Date.now() - start)
    stop()
    timer = setInterval(() => setElapsed(Date.now() - start), 1000)
  })

  createEffect(() => {
    if (props.working()) return
    stop()
  })

  onCleanup(stop)

  const parts = createMemo(() => {
    const out: string[] = [formatDuration(elapsed())]
    const tokens = props.tokens()
    if (props.codium?.()) out.push("Codium")
    if (!props.codium?.() && tokens > 0) out.push(`${tokenFormatter.format(tokens)} tokens`)
    const tasks = props.runningTasks()
    if (tasks > 0) out.push(`${tasks} running task${tasks === 1 ? "" : "s"}`)
    const computer = props.computer?.()
    if (computer) out.push(computer)
    const phrase = props.phrase?.()
    if (phrase) out.push(phrase)
    return out
  })

  return (
    <Show when={props.working()}>
      <div role="status" aria-live="polite" class="px-1 pb-1.5 text-13-regular text-text-weak truncate">
        {parts().join(" · ")}
      </div>
    </Show>
  )
}
