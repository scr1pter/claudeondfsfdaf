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

type Tracker = ReturnType<typeof backgroundTracker>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a tracked ID names a background command (5.H) rather than a subagent. */
export function isShellID(id: string) {
  return id.startsWith("shl_")
}

/**
 * Background commands (5.H) the run waits for, beside its background subagents. The shell tool's finished part names
 * a command it started in the background; the command is then running until its exit note (a `shellNotification` text
 * part) arrives. That note is answered like a subagent's: a stopped command's note starts no turn, and any other is
 * answered by the turn after it. Either may arrive first. Returns whether the part was about a background command.
 */
export function trackShell(tracker: Tracker, part: unknown) {
  if (!isRecord(part)) return false
  if (part.type === "tool" && isRecord(part.state) && part.state.status === "completed") {
    const metadata = part.state.metadata
    if (!isRecord(metadata) || metadata.background !== true) return false
    const shellID = metadata.shellID
    if (typeof shellID !== "string" || !isShellID(shellID)) return false
    tracker.status(shellID, "running")
    return true
  }
  if (part.type !== "text" || typeof part.messageID !== "string" || !isRecord(part.metadata)) return false
  const note = part.metadata.shellNotification
  if (!isRecord(note) || typeof note.shellID !== "string" || !isShellID(note.shellID)) return false
  if (typeof note.state !== "string") return false
  tracker.status(note.shellID, note.state)
  tracker.note(note.shellID, part.messageID, part.metadata.taskQuiet === true)
  return true
}

/** What the run says it stopped waiting for: its subagents and its commands, counted apart. */
export function waitingFor(tracker: Tracker) {
  const ids = [...new Set([...tracker.running, ...tracker.unanswered])]
  const commands = ids.filter(isShellID).length
  const subagents = ids.length - commands
  return [
    ...(subagents > 0 || commands === 0 ? [`${subagents} background subagent(s)`] : []),
    ...(commands > 0 ? [`${commands} background command(s)`] : []),
  ].join(" and ")
}
