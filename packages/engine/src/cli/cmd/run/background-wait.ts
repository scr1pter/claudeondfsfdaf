// A timer must race the next event: a disconnected stream may never emit another heartbeat.
export function nextBackgroundEvent<T>(iterator: AsyncIterator<T>, timeout?: number, unfinished = false) {
  const next = iterator
    .next()
    .then((event) =>
      event.done && unfinished
        ? { timedOut: false as const, disconnected: true as const }
        : { timedOut: false as const, disconnected: false as const, event },
    )
  if (timeout === undefined) return next
  const expired = Promise.withResolvers<{ timedOut: true }>()
  const timer = setTimeout(() => expired.resolve({ timedOut: true }), Math.max(0, timeout))
  return Promise.race([next, expired.promise]).finally(() => clearTimeout(timer))
}

/** Notes and lifecycle updates can arrive in either order, including repeated terminal updates. */
export function backgroundTracker() {
  const running = new Set<string>()
  const unanswered = new Set<string>()
  const noted = new Map<string, { messageID: string; quiet: boolean }>()
  const generations = new Map<string, number>()
  const advanced = new Set<string>()
  const terminal = new Set<string>()
  let answered = ""
  const accept = (taskID: string, attempt?: number) => {
    const previous = generations.get(taskID)
    if (attempt === undefined) return !advanced.has(taskID)
    if (!Number.isSafeInteger(attempt) || attempt < 1 || (previous !== undefined && attempt < previous)) return false
    if (attempt > 1) advanced.add(taskID)
    if (previous !== undefined && attempt > previous) {
      advanced.add(taskID)
      noted.delete(taskID)
      unanswered.delete(taskID)
      terminal.delete(taskID)
    }
    generations.set(taskID, attempt)
    return true
  }
  const settle = () => {
    for (const [taskID, note] of noted) if (note.quiet || note.messageID < answered) unanswered.delete(taskID)
  }
  return {
    running,
    unanswered,
    noted,
    settled: () => running.size === 0 && unanswered.size === 0,
    status(taskID: string, status: string, attempt?: number) {
      if (!accept(taskID, attempt) || terminal.has(taskID)) return
      if (["running", "queued", "waiting_on_user"].includes(status)) {
        running.add(taskID)
        unanswered.delete(taskID)
      }
      if (["completed", "error", "failed", "interrupted"].includes(status)) {
        terminal.add(taskID)
        running.delete(taskID)
        unanswered.add(taskID)
      }
      if (status === "cancelled" || status === "stopped") {
        terminal.add(taskID)
        running.delete(taskID)
        unanswered.delete(taskID)
      }
      settle()
    },
    note(taskID: string, messageID: string, quiet = false, attempt?: number) {
      // A legacy note cannot settle a newer attempt after an observed resume.
      if (!accept(taskID, attempt)) return
      const previous = noted.get(taskID)
      if (previous && previous.messageID > messageID) return
      noted.set(taskID, { messageID, quiet })
      settle()
    },
    answer(messageID: string) {
      if (messageID > answered) answered = messageID
      settle()
    },
  }
}
